// A fixture source with two inputs, run through the real archive import, the
// real dashboard approval, a real tiered store set and the real intake rule
// (contract 2.2.0, docs/design/archive-live-one-dataset.md). The source's one
// connector reads its live input and each imported archive as another input,
// builds every item with the same builder, and writes the account's own
// stores. Nothing here is a format or a real source: a tiny mbox file stands in
// for the approved export (the import binds its manifest as it would any
// archive) and the records an input yields are the test's.

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorInput,
  SourceRecordPage,
} from '../../src/core/contracts.ts';
import type { ArchiveConnectorInput } from '../../src/core/archive-formats.ts';
import { inputConnector, type IntakeObservingInput, type SourceRecordBuilder } from '../../src/core/source-inputs.ts';
import { placeOwnedAccount, recordProviderAccount } from '../../src/core/source-storage.ts';
import { createExclusiveRunner } from '../../src/workers/source-account-guard.ts';
import { lifecycleAccountFiles } from '../../src/data-lifecycle.ts';
import { SecretLocationsIndex } from '../../src/workers/classification/secret-locations.ts';
import { TierLedger } from '../../src/workers/classification/tier-ledger.ts';
import { secretLocationsPathForStore } from '../../src/workers/classification/tier-ledger-path.ts';
import type { TierSniffer } from '../../src/workers/classification/tier-classifier.ts';
import { LocalConnectorStore } from '../../src/workers/connector-store/index.ts';
import { TieredStoreSet, tieredStoreSetLedgerPath } from '../../src/workers/connector-store/tiered-store-set.ts';
import { createArchiveImportDashboard, type ArchiveImportDashboard } from '../../src/workers/archive-import/dashboard.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../../src/workers/archive-import/runtime.ts';
import { withInputs } from '../../src/workers/archive-import/source-input.ts';
import {
  ArchiveSourceTargets,
  type ArchiveAccountEvidence,
  type ArchiveSourceTarget,
} from '../../src/workers/archive-import/source-targets.ts';
import { pullArchiveImport, type ArchiveImportPullOptions } from '../../src/workers/archive-import/sync.ts';
import { createLocalFilesArchiveBrowser } from '../../src/workers/local-files/scope-browser.ts';
import { MacPermissions } from '../../src/workers/local-files/mac-permissions.ts';
import { VolumeResolver } from '../../src/workers/local-files/volume-identity.ts';
import { FIXTURE_PLACEMENT } from '../helpers/tier-fixtures.ts';
import { archiveConnectorId } from '../../src/workers/archive-import/state.ts';

/** A source id the data lifecycle knows, so a whole-source delete runs through the real lifecycle. */
export const FIXTURE_SOURCE_ID = 'dropbox.files';
export const FIXTURE_LABEL = 'Fixture drive';
export const FIXTURE_ACCOUNT_SCOPE = 'fixture-account';
export const FIXTURE_PROVIDER = 'fixture-source';
export const FIXTURE_LIVE_INPUT_ID = 'fixture.live';
const FORMAT_ID = 'mbox';

/** One child of a record (an attachment): listed by name, its bytes read later. */
export interface FxChild {
  key: string;
  name: string;
  text: string;
}

/** The record both inputs yield: the live reader's own shape. */
export interface FxRecord {
  id: string;
  /** The source's own version of the record: a larger number is newer. */
  version: number;
  subject: string;
  /** Absent: the record carries only the item's names (no content). */
  body?: string;
  sentAt?: string;
  children?: readonly FxChild[];
}

const localId = (providerItemId: string): string => `${FIXTURE_ACCOUNT_SCOPE}:${providerItemId}`;
export const fixtureChildId = (parentId: string, key: string): string => `${parentId}#child:${key}`;
export const fixtureLocator = (record: FxRecord, child: FxChild): string => `fixture-locator:${record.id}:${child.key}@${record.version}`;

function identityOf(record: FxRecord, providerItemId = record.id, child?: FxChild) {
  return {
    family: 'email' as const,
    provider: FIXTURE_PROVIDER,
    accountScope: FIXTURE_ACCOUNT_SCOPE,
    providerItemId,
    localItemId: localId(providerItemId),
    sourceVersion: String(record.version),
    ...(child ? { parent: { providerItemId: record.id, localItemId: localId(record.id) } } : {}),
  };
}

/** The source's one way from a record to its items, whichever input the record came from. */
export const fixtureBuilder: SourceRecordBuilder<FxRecord> = {
  family: 'email',
  entriesOf: (record) => [
    { identity: identityOf(record), bringsContent: record.body !== undefined, ...(record.sentAt ? { authoredAt: record.sentAt } : {}) },
    ...(record.children ?? []).map((child) => ({
      identity: identityOf(record, fixtureChildId(record.id, child.key), child),
      bringsContent: false,
    })),
  ],
  compareVersions: (a, b) => Number(a) - Number(b),
  build: (record): RawItem[] => [
    {
      identity: identityOf(record),
      mimeType: 'text/plain',
      content: record.body === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: record.body },
      metadata: Object.freeze({ name: record.subject, title: record.subject, ...(record.sentAt ? { sentAt: record.sentAt } : {}), legacyDomain: 'internal' }),
      fetchedAt: '2026-10-25T00:00:00.000Z',
    },
    ...(record.children ?? []).map((child): RawItem => ({
      identity: identityOf(record, fixtureChildId(record.id, child.key), child),
      mimeType: 'text/plain',
      content: { kind: 'metadata_only' },
      metadata: Object.freeze({ name: child.name, title: child.name, legacyDomain: 'internal' }),
      fetchedAt: '2026-10-25T00:00:00.000Z',
      deferredBytes: { locator: fixtureLocator(record, child), available: true, sizeBytes: child.text.length },
    })),
  ],
  fetchItem: () => Promise.reject(new Error('the fixture reads no item by id')),
  classificationSignals: (item): SourceClassificationSignals => ({ title: String(item.metadata['name'] ?? '') }),
};

/** What a test can see of an input while a pass reads it. */
export interface InputLog {
  /** The cursors the input was asked to resume from, in order. */
  cursors: Array<string | undefined>;
  /** How many pages it yielded. */
  pages: number;
}

/** Pages of `records` from a numeric cursor (the index of the next record). */
function pagesOf(
  records: () => readonly FxRecord[],
  pageSize: number,
  log: InputLog,
  hooks: {
    beforePage?(firstIndex: number): void | Promise<void>;
    positions?(indices: readonly number[]): void;
    shouldContinue?(): boolean;
  } = {},
) {
  return async function* (options?: { cursor?: string; limit?: number }): AsyncGenerator<SourceRecordPage<FxRecord>> {
    log.cursors.push(options?.cursor);
    const all = records();
    // A cursor bound to files carries its own prefix (bindInputToFiles strips it): this is the inner one.
    let index = options?.cursor !== undefined ? Number(options.cursor) : 0;
    const size = Math.max(1, Math.min(options?.limit ?? Number.POSITIVE_INFINITY, pageSize));
    if (all.length === 0) {
      yield { records: [], done: true };
      return;
    }
    while (index < all.length) {
      if (hooks.shouldContinue && !hooks.shouldContinue()) return;
      await hooks.beforePage?.(index);
      const slice = all.slice(index, index + size);
      hooks.positions?.(slice.map((_, offset) => index + offset));
      log.pages += 1;
      index += slice.length;
      yield index >= all.length
        ? { records: slice, done: true }
        : { records: slice, nextCursor: String(index), done: false };
    }
  };
}

export interface FixtureSourceOptions {
  /** Records per page of an input. */
  pageSize?: number;
  /** The sniffer that judges items (default: one that never answers, so every judged item is held). */
  sniffer?: TierSniffer;
}

const WAITING: TierSniffer = { id: 'fixture-waiting', judge: () => ({ verdict: 'undecided', queued: true }) };

export interface OnePipelineHarness {
  base: string;
  home: string;
  env: Record<string, string>;
  runtime: ArchiveImportRuntime;
  targets: ArchiveSourceTargets;
  dashboard: ArchiveImportDashboard;
  /** The source's one tiered store set, over the account's own stores. */
  set: TieredStoreSet;
  stores: { internal: LocalConnectorStore; secure_local: LocalConnectorStore };
  storePaths: { internal: string; secure_local: string };
  /** The task lock the source's own pulls and imports run under. */
  exclusive: ReturnType<typeof createExclusiveRunner>;
  /** The records the live reader yields right now: assign to change what a live pull sees. */
  live: { records: FxRecord[] };
  liveLog: InputLog;
  archiveLog: InputLog;
  /** What the export says of its account (default: the account named `export-account`). */
  evidence: { current: ArchiveAccountEvidence };
  /** Held while a pass reads: an archive input waits here before each page. */
  gate: { before?: ((firstIndex: number) => void | Promise<void>) | undefined };
  /** The source's one connector (its live input, and `forInput` for an archive). */
  connector: SourceConnector;
  /** When on, an archive input's listing ignores the item limit it is given (a connector that hands back more than its budget). */
  ignoreLimit: { on: boolean };
  /** Whether the live source is already connected (an account of it exists). */
  connectLive(providerAccountId?: string | null): void;
  /** One live pull, by the source's own lane. */
  pullLive(options?: { maxItems?: number }): ReturnType<TieredStoreSet['sync']>;
  /** Writes a stand-in export file and sets the records it yields. Returns its path. */
  writeExport(name: string, records: readonly FxRecord[]): string;
  /** Approves it through the real dashboard approval and returns the archive id of the started import. */
  startImport(name: string, records: readonly FxRecord[], answer?: { confirmAccount?: true; keepApart?: true }): Promise<string>;
  pull(archiveId: string, options?: Partial<ArchiveImportPullOptions>): ReturnType<typeof pullArchiveImport>;
  importAll(archiveId: string, options?: Partial<ArchiveImportPullOptions>): ReturnType<typeof pullArchiveImport>;
  /** Item rows across the legs, active and tombstoned, by provider item id. */
  rows(): Array<{
    domain: 'internal' | 'secure_local';
    providerItemId: string;
    version: string | null;
    tombstoned: number;
    trustTier: string;
    chunks: number;
    parent: string | null;
    locator: string | null;
  }>;
  /** The active provider item ids across the legs. */
  ids(): string[];
  /** Items an active row is stored twice for in one leg (an item has at most one row in a leg). Empty when sound. */
  duplicates(): string[];
  /** The store whose copy of the item holds its text (chunks), when any does. */
  contentDomain(providerItemId: string): 'internal' | 'secure_local' | undefined;
  /** The tier ledger's current record for an item: its reasons say whether it is held until judged. */
  ledgerRecord(providerItemId: string): ReturnType<TierLedger['getCurrent']>;
  /** The text stored for an item, from whichever leg holds it. */
  textOf(providerItemId: string): string;
  close(): void;
}

function miniMbox(name: string): string {
  return [
    'From sender@example.invalid Mon Jan  5 10:00:00 2015',
    'From: Sam Example <sam@example.invalid>',
    'Subject: stand-in',
    'Date: Mon, 05 Jan 2015 10:00:00 +0000',
    'Message-ID: <stand-in@example.invalid>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'stand-in',
    `X-Stand-In: ${name}`,
    '',
  ].join('\n');
}

export function onePipelineHarness(cleanups: Array<() => void>, options: FixtureSourceOptions = {}): OnePipelineHarness {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'one-pipeline-')));
  const home = join(base, 'home');
  const exports = join(home, 'Exports');
  mkdirSync(exports, { recursive: true });
  // The environment the data lifecycle derives for a home folder: a whole-source delete finds the same files.
  const env = { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state') };
  const pageSize = options.pageSize ?? 2;
  const live = { records: [] as FxRecord[] };
  const liveLog: InputLog = { cursors: [], pages: 0 };
  const archiveLog: InputLog = { cursors: [], pages: 0 };
  const evidence: { current: ArchiveAccountEvidence } = { current: { kind: 'account', importAccountId: 'export-account' } };
  const gate: OnePipelineHarness['gate'] = {};
  const ignoreLimit = { on: false };
  const exportRecords = new Map<string, readonly FxRecord[]>();
  const exclusive = createExclusiveRunner();

  // The account's own stores, where the data lifecycle keeps them.
  const [secureStorePath, internalStorePath] = lifecycleAccountFiles(FIXTURE_SOURCE_ID, { homeDir: home }).stores;
  const storePaths = { internal: internalStorePath!, secure_local: secureStorePath! };
  mkdirSync(dirname(storePaths.internal), { recursive: true });
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(storePaths.secure_local) });
  const secrets = new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(storePaths.secure_local) });
  const corpusIds = { internal: 'internal.fixture.mail', secure_local: 'secure_local.fixture.mail' };
  const open = (domain: 'internal' | 'secure_local'): LocalConnectorStore => new LocalConnectorStore({
    dbPath: storePaths[domain],
    corpusId: corpusIds[domain],
    family: 'email',
    trustDomain: domain,
    tierLedger: ledger,
  });
  const stores = { internal: open('internal'), secure_local: open('secure_local') };
  const set = new TieredStoreSet({
    setId: 'fixture-source',
    ledger,
    secretLocations: secrets,
    tierClassification: { sniffer: options.sniffer ?? WAITING },
    // A child is listed by name with the means to read its bytes later (2.1.0): the connector says so on the item.
    contentArrivesLaterFor: (item) => item.deferredBytes !== undefined,
    legs: [
      { trustDomain: 'internal', corpusId: corpusIds.internal, store: stores.internal },
      { trustDomain: 'secure_local', corpusId: corpusIds.secure_local, store: stores.secure_local, legacy: true },
    ],
  });

  // The source's one connector: the live reader is one input, and `forInput` reads another.
  const liveInput: IntakeObservingInput<FxRecord> = {
    inputId: FIXTURE_LIVE_INPUT_ID,
    kind: 'live',
    records: pagesOf(() => live.records, pageSize, liveLog),
  };
  const plain: SourceConnector = withInputs(inputConnector(fixtureBuilder, liveInput), fixtureBuilder);
  const connector: SourceConnector = Object.create(plain) as SourceConnector;
  connector.forInput = (archiveInput: SourceConnectorInput): SourceConnector => {
    const inner = plain.forInput!(archiveInput);
    if (!ignoreLimit.on) return inner;
    const unbounded = Object.create(inner) as SourceConnector;
    unbounded.listItems = (listOptions = {}) => {
      const { limit: _limit, ...rest } = listOptions;
      return inner.listItems(rest);
    };
    return unbounded;
  };
  const syncOptions = { fetchContent: true, placement: FIXTURE_PLACEMENT, deferMetadataOnlyContent: true };

  const target: ArchiveSourceTarget = {
    sourceId: FIXTURE_SOURCE_ID,
    label: FIXTURE_LABEL,
    formats: [FORMAT_ID],
    concurrencyKey: 'fixture.mail',
    identify: () => evidence.current,
    input(archive: ArchiveConnectorInput): SourceConnectorInput {
      const name = archive.files[0]!.relPath.split('/').pop()!;
      const records = (): readonly FxRecord[] => exportRecords.get(name) ?? [];
      return {
        inputId: archiveConnectorId(archive.archiveId),
        kind: 'archive',
        records: pagesOf(records, archive.pageSize ?? pageSize, archiveLog, {
          beforePage: (index) => gate.before?.(index),
          positions: (indices) => archive.reportItemPositions?.(indices.map((index) => ({ fileIndex: 0, offset: index * 1000 }))),
          shouldContinue: () => archive.shouldContinue(),
        }),
      };
    },
    lane: () => ({ set, sync: syncOptions, connector }),
    liveSince: () => '2026-05-01',
    exclusive,
  };
  const targets = new ArchiveSourceTargets();
  targets.register(target);

  const runtime = createArchiveImportRuntime({
    env,
    waitingQuestionsDbPath: join(base, 'waiting-private-questions.sqlite'),
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
    targets,
  });
  const volumes = new VolumeResolver({ platform: 'darwin', home, readMounts: () => '/dev/disk3s1s1 on / (apfs, local)', diskutilPlist: () => undefined });
  const permissions = new MacPermissions({ home, memoryPath: join(base, 'folder-access.json'), platform: 'linux' });
  const browser = createLocalFilesArchiveBrowser({ volumes, home, permissions });
  const dashboard = createArchiveImportDashboard({
    runtime,
    browser,
    refreshScheduler: () => undefined,
    privateModel: () => 'ready',
    home,
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    dashboard.close();
    runtime.media.close();
    for (const lane of runtime.existingLanes()) {
      for (const store of lane.set.openStores()) store.close();
      lane.secretLocations?.close();
      lane.ledger.close();
    }
    stores.internal.close();
    stores.secure_local.close();
    secrets.close();
    ledger.close();
    rmSync(base, { recursive: true, force: true });
  };
  cleanups.push(close);

  const harness: OnePipelineHarness = {
    base, home, env, runtime, targets, dashboard, set, stores, storePaths, exclusive, live, liveLog, archiveLog, evidence, gate, ignoreLimit, connector,
    connectLive(providerAccountId: string | null = 'export-account') {
      // What the live connector does when it connects: the account exists, and names the provider's account.
      const account = { sourceId: FIXTURE_SOURCE_ID };
      placeOwnedAccount(account, env);
      if (providerAccountId !== null) recordProviderAccount(account, providerAccountId, env);
    },
    async pullLive(pull = {}) {
      set.store('secure_local', { create: true });
      // The live lane resumes from the live input's own committed cursor.
      const cursor = set.committedCursor(connector.id)?.cursor ?? undefined;
      return set.sync(connector, {
        ...syncOptions,
        ...(pull.maxItems !== undefined ? { maxItems: pull.maxItems } : {}),
        ...(cursor ? { cursor } : {}),
      });
    },
    writeExport(name, records) {
      const path = join(exports, name);
      // Distinct bytes per export: the same export is refused as already imported.
      writeFileSync(path, miniMbox(name));
      exportRecords.set(name, records);
      return path;
    },
    async startImport(name, records, answer = {}) {
      const path = harness.writeExport(name, records);
      const result = await dashboard.approve({ key: path, ...answer });
      if (!result.ok || result.status !== 'started') throw new Error(`expected a start, got ${JSON.stringify(result)}`);
      return result.archive_id;
    },
    pull(archiveId, pull = {}) {
      return pullArchiveImport({ state: runtime.state, archiveId, targets, media: runtime.media, ...pull });
    },
    async importAll(archiveId, pull = {}) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const outcome = await harness.pull(archiveId, pull);
        if (!outcome.continueSoon) return outcome;
      }
      throw new Error('the import did not finish');
    },
    rows() {
      const found: ReturnType<OnePipelineHarness['rows']> = [];
      for (const domain of ['internal', 'secure_local'] as const) {
        if (!existsSync(storePaths[domain])) continue;
        const db = new Database(storePaths[domain], { readonly: true });
        try {
          const rows = db.query(`
            SELECT i.provider_item_id AS id, i.source_version AS version, i.tombstoned AS tombstoned, i.trust_tier AS tier,
              i.parent_local_item_id AS parent, i.deferred_locator AS locator,
              (SELECT COUNT(*) FROM chunks c WHERE c.item_pk = i.item_pk) AS chunks
            FROM items i WHERE i.account_scope = ? ORDER BY i.item_pk
          `).all(FIXTURE_ACCOUNT_SCOPE) as Array<{ id: string; version: string | null; tombstoned: number; tier: string; parent: string | null; locator: string | null; chunks: number }>;
          for (const row of rows) {
            found.push({ domain, providerItemId: row.id, version: row.version, tombstoned: row.tombstoned, trustTier: row.tier, chunks: row.chunks, parent: row.parent, locator: row.locator });
          }
        } finally {
          db.close();
        }
      }
      return found;
    },
    duplicates() {
      const seen = new Map<string, number>();
      for (const row of harness.rows().filter((entry) => entry.tombstoned === 0)) {
        const key = `${row.domain}:${row.providerItemId}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      return [...seen].filter(([, count]) => count > 1).map(([key]) => key);
    },
    contentDomain(providerItemId) {
      return harness.rows().find((row) => row.providerItemId === providerItemId && row.tombstoned === 0 && row.chunks > 0)?.domain;
    },
    ledgerRecord(providerItemId) {
      return set.ledger.getCurrent({ provider: FIXTURE_PROVIDER, accountScope: FIXTURE_ACCOUNT_SCOPE, providerItemId });
    },
    ids() {
      return [...new Set(harness.rows().filter((row) => row.tombstoned === 0).map((row) => row.providerItemId))].sort();
    },
    textOf(providerItemId) {
      return [stores.internal, stores.secure_local]
        .flatMap((store) => store.localContent(localId(providerItemId))?.chunks ?? []).join(' ');
    },
    close,
  };
  return harness;
}
