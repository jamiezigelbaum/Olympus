// P3: the tier migration for EXISTING installs (design section 4.6, M0-M6),
// rehearsed on the old single-tier shapes:
//
// - a Dropbox-like lane whose every file sits in ONE Private store, with local
//   vectors (the all-S4 shape), whose text arrives after listing; and
// - a Readwise-like lane whose every item sits in ONE Personal store, with
//   cloud vectors.
//
// Proven here: the dry run is read-only for stores and vectors and idempotent;
// a stale plan is refused; unmoved items keep byte-identical vectors; moved
// items have exactly one visible copy per layer; Public <-> Personal copies
// vectors with zero provider calls; a raise hides first and keeps the cloud
// vectors; Secrets follow the one Secrets policy and a rollback never
// re-exposes them; a crash resumes to exactly one
// visible copy; the approved chunk budget stops a run; rollback embeds
// nothing; purge needs its own approval; nothing on these paths invalidates
// or rebinds embedding currency; and every ledger entry is written as
// specified.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity, type SourceTrustDomain } from '../src/core/source-index/types.ts';
import { closeSqliteStore } from '../src/core/sqlite-store.ts';
import { TierLedger, type TierLedgerIdentity } from '../src/workers/classification/tier-ledger.ts';
import type { TierDecision } from '../src/workers/classification/tier-classifier.ts';
import {
  approveTierMigration,
  planTierMigration,
  purgeTierMigration,
  readTierMigrationState,
  rollbackTierMigrationBatch,
  runTierMigration,
  tierMigrationStatusSummary,
  type TierMigrationDomainIdentity,
  type TierMigrationInputs,
  type TierMigrationPaths,
} from '../src/workers/classification/tier-migration.ts';
import { openTierMigrationLanes, type TierMigrationLaneSpec } from '../src/workers/classification/tier-migration-lanes.ts';
import { runTierMigrateCommand } from '../src/workers/classification/tier-migration-cli.ts';
import { LocalConnectorStore, defineConnectorCorpus, syncAndEmbedFromConnector } from '../src/workers/connector-store/index.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import { TierMoveRefusedError, moveTieredItem, type TierMoveEmbeddingIdentity } from '../src/workers/connector-store/tier-move.ts';
import {
  EMBEDDING_LEDGER_OWNER_APPROVAL,
  readEmbeddingLedger,
} from '../src/workers/embedding-ledger.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  cloudProvider,
  fixtureConnector,
  identityOf as identityOfFixture,
  localProvider,
  openTierFixture,
  snapshotStore,
  storePaths,
  tempDir,
  type FixtureSpec,
  type RecordingProvider,
} from './helpers/tier-fixtures.ts';

const ACCOUNT = 'personal';
// Runtime-built so no credential-shaped literal sits in the source.
const FAKE_AWS_KEY = ['AKIA', 'MIGRATIONFIXTUR1'].join('');

interface Spec {
  id: string;
  name: string;
  text: string;
}

const FILES = {
  garden: { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden, the compost bins and the tomato beds.' },
  therapy: { id: 'therapy', name: 'session-notes.txt', text: 'The oncologist reviewed the biopsy results; the diagnosis and the prescription follow.' },
  medical: { id: 'medical', name: 'therapy-session.txt', text: 'The oncologist reviewed the biopsy results; the diagnosis and the prescription follow.' },
  keys: { id: 'keys', name: 'deploy-notes.txt', text: `Deploy notes. The old key ${FAKE_AWS_KEY} was rotated last week.` },
} satisfies Record<string, Spec>;

const LIBRARY = {
  launch: { id: 'launch', name: 'Launch essay', text: 'An essay about the orchard launch and the cider press, saved for later reading.' },
  journal: { id: 'journal', name: 'Reading note', text: 'Highlight: my psychiatrist adjusted the prescription after the diagnosis last spring.' },
  essay: { id: 'essay', name: 'Long read', text: 'A long read about bridges, rivers and the engineers who built the old canal locks.' },
} satisfies Record<string, Spec>;

const FILE_CORPORA: Record<SourceTrustDomain, string> = {
  public_safe: 'public_safe.rehearsal.files',
  internal: 'internal.rehearsal.files',
  secure_local: 'secure_local.rehearsal.files',
};
const LIBRARY_CORPORA: Record<SourceTrustDomain, string> = {
  public_safe: 'public_safe.rehearsal.library',
  internal: 'internal.rehearsal.library',
  secure_local: 'secure_local.rehearsal.library',
};

function rawItem(provider: string, spec: Spec, family: 'file' | 'readwise'): RawItem {
  return {
    identity: {
      family,
      provider,
      accountScope: ACCOUNT,
      providerItemId: spec.id,
      localItemId: `${ACCOUNT}:${spec.id}`,
      sourceVersion: 'v1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: spec.text },
    metadata: Object.freeze({
      name: spec.name,
      title: spec.name,
      ...(family === 'file' ? { pathDisplay: `/Files/${spec.name}` } : {}),
    }),
    fetchedAt: '2026-09-23T00:00:00.000Z',
  };
}

function connector(provider: string, specs: () => readonly Spec[], family: 'file' | 'readwise'): SourceConnector {
  return {
    id: `${provider}_legacy_lane`,
    family,
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      const items = specs().map((spec) => rawItem(provider, spec, family));
      return (async function* () {
        await Promise.resolve();
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId) {
      const spec = specs().find((entry) => `${ACCOUNT}:${entry.id}` === localItemId);
      if (!spec) throw new Error('unknown item');
      return rawItem(provider, spec, family);
    },
    classificationSignals(item) {
      return { title: String(item.metadata['name'] ?? '') };
    },
  };
}

interface Rehearsal {
  dir: string;
  files: Record<SourceTrustDomain, string>;
  library: Record<SourceTrustDomain, string>;
  specs: TierMigrationLaneSpec[];
  paths: TierMigrationPaths;
  cloud: RecordingProvider;
  local: RecordingProvider;
  inputs: TierMigrationInputs;
  domainIdentity: TierMigrationDomainIdentity;
  fileSpecs: Spec[];
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function identityOf(provider: string, id: string): TierLedgerIdentity {
  return { provider, accountScope: ACCOUNT, providerItemId: id };
}

function asMoveIdentity(provider: RecordingProvider): TierMoveEmbeddingIdentity {
  return {
    modelId: provider.modelId,
    provider: provider.provider,
    backend: provider.backend,
    dimension: provider.dimension,
    epochId: provider.epochId,
    configHash: provider.configHash,
  };
}

/** The pre-routing install: every file in one Private store, every library item in one Personal store, embedded. */
async function rehearsal(): Promise<Rehearsal> {
  const { dir, cleanup } = tempDir('olympus-tier-p3-');
  cleanups.push(cleanup);
  const files = {
    public_safe: join(dir, 'files-public.sqlite'),
    internal: join(dir, 'files-internal.sqlite'),
    secure_local: join(dir, 'files-secure.sqlite'),
  };
  const library = {
    public_safe: join(dir, 'library-public.sqlite'),
    internal: join(dir, 'library-internal.sqlite'),
    secure_local: join(dir, 'library-secure.sqlite'),
  };
  const cloud = cloudProvider();
  const local = localProvider();
  const fileSpecs: Spec[] = Object.values(FILES).map((spec) => ({ ...spec }));
  // The old shape: no tier ledger at all (tierLedger: null), fixed placement.
  const fileStore = new LocalConnectorStore({
    dbPath: files.secure_local,
    corpusId: FILE_CORPORA.secure_local,
    family: 'file',
    trustDomain: 'secure_local',
    tierLedger: null,
  });
  await syncAndEmbedFromConnector({
    store: fileStore,
    connector: connector('rehearsal-files', () => fileSpecs, 'file'),
    embeddingProvider: local,
    sync: {
      fetchContent: true,
      placement: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
    },
  });
  fileStore.close();
  const libraryStore = new LocalConnectorStore({
    dbPath: library.internal,
    corpusId: LIBRARY_CORPORA.internal,
    family: 'readwise',
    trustDomain: 'internal',
    tierLedger: null,
  });
  await syncAndEmbedFromConnector({
    store: libraryStore,
    connector: connector('rehearsal-library', () => Object.values(LIBRARY), 'readwise'),
    embeddingProvider: cloud,
    sync: {
      fetchContent: true,
      placement: () => buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'internal' }),
    },
  });
  libraryStore.close();
  // The legacy file lane placed a secret-bearing file whole, as the lane of
  // record here did before per-item routing (the rehearsal wants it present).
  const specs: TierMigrationLaneSpec[] = [
    {
      sourceId: 'rehearsal.files',
      setId: 'rehearsal.files',
      contentArrivesLater: true,
      legs: {
        public_safe: { corpusId: FILE_CORPORA.public_safe, dbPath: files.public_safe, family: 'file' },
        internal: { corpusId: FILE_CORPORA.internal, dbPath: files.internal, family: 'file' },
        secure_local: { corpusId: FILE_CORPORA.secure_local, dbPath: files.secure_local, family: 'file', legacy: true },
      },
    },
    {
      sourceId: 'rehearsal.library',
      setId: 'rehearsal.library',
      legs: {
        public_safe: { corpusId: LIBRARY_CORPORA.public_safe, dbPath: library.public_safe, family: 'readwise' },
        internal: { corpusId: LIBRARY_CORPORA.internal, dbPath: library.internal, family: 'readwise', legacy: true, restingTier: 'S1' },
        secure_local: { corpusId: LIBRARY_CORPORA.secure_local, dbPath: library.secure_local, family: 'readwise' },
      },
    },
  ];
  const identities: Record<string, TierMoveEmbeddingIdentity> = {
    public_safe: asMoveIdentity(cloud),
    internal: asMoveIdentity(cloud),
    secure_local: asMoveIdentity(local),
  };
  return {
    dir,
    files,
    library,
    specs,
    paths: {
      statePath: join(dir, 'tier-migration', 'state.json'),
      reportDir: join(dir, 'tier-migration', 'reports'),
      embeddingLedgerPath: join(dir, 'embedding-ledger.jsonl'),
    },
    cloud,
    local,
    inputs: { revision: 'map:none;rules:none' },
    domainIdentity: (domain) => identities[domain],
    fileSpecs,
  };
}

function lanes(context: Rehearsal, mode: 'read' | 'write') {
  const opened = openTierMigrationLanes(context.specs, { mode });
  cleanups.unshift(() => opened.close());
  return opened;
}

function allStoreSnapshots(context: Rehearsal) {
  return Object.fromEntries([...Object.values(context.files), ...Object.values(context.library)]
    .filter((path) => existsSync(path))
    .map((path) => [path, snapshotStore(path)]));
}

/** Where an item is served now, per layer: each existing store's own visibility filter. */
function servedFrom(context: Rehearsal, corpora: Record<SourceTrustDomain, string>, paths: Record<SourceTrustDomain, string>, id: string) {
  const served: { names: string[]; content: string[] } = { names: [], content: [] };
  for (const domain of ['public_safe', 'internal', 'secure_local'] as const) {
    if (!existsSync(paths[domain])) continue;
    const store = new LocalConnectorStore({ dbPath: paths[domain], corpusId: corpora[domain], family: 'file', trustDomain: domain, readOnly: true });
    try {
      const content = store.localContent(`${ACCOUNT}:${id}`);
      if (content && content.chunks.length > 0) served.content.push(corpora[domain]);
      const status = store.status();
      void status;
      const names = store.searchItems(id === 'garden' ? 'garden' : id, 10)
        .filter((row) => row.sourceItem.providerItemId === id && !row.chunk);
      if (names.length > 0) served.names.push(corpora[domain]);
    } finally {
      store.close();
    }
  }
  return served;
}

function invalidationSpy() {
  return spyOn(
    LocalConnectorStore.prototype as unknown as { invalidateEmbeddingModelCurrency(modelId: string): void },
    'invalidateEmbeddingModelCurrency',
  );
}

async function planAndApprove(context: Rehearsal) {
  const read = lanes(context, 'read');
  const plan = await planTierMigration({
    lanes: read.lanes,
    inputs: context.inputs,
    domainIdentity: context.domainIdentity,
    paths: context.paths,
  });
  await approveTierMigration({ planId: plan.planId, lanes: read.lanes, inputs: context.inputs, paths: context.paths, why: 'rehearsal' });
  return plan;
}

describe('tier migration M0 (dry run)', () => {
  test('classifies from stored text, records proposals only, and touches no store or vector', async () => {
    const context = await rehearsal();
    const before = allStoreSnapshots(context);
    const calls = context.cloud.inputs.length + context.local.inputs.length;
    const invalidate = invalidationSpy();
    try {
      const read = lanes(context, 'read');
      const plan = await planTierMigration({
        lanes: read.lanes,
        inputs: context.inputs,
        domainIdentity: context.domainIdentity,
        paths: context.paths,
      });
      expect(allStoreSnapshots(context)).toEqual(before);
      expect(existsSync(context.files.internal)).toBe(false);
      expect(context.cloud.inputs.length + context.local.inputs.length).toBe(calls);
      expect(invalidate).not.toHaveBeenCalled();

      // garden: Personal (lower, embed in Personal's model); therapy: names
      // Personal, text Private (names copied, text stays: no embed); keys:
      // Secrets (hidden); medical: names look private, still pending: stays.
      // Library: journal raised to Private; essay stays Personal.
      expect(plan.totals).toMatchObject({
        itemsScanned: 7,
        proposed: 4,
        unchanged: 3,
        secrets: 1,
        raises: 1,
      });
      expect(plan.totals.moves).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'rehearsal.files', from: 'Private', toNames: 'Personal', toContent: 'Personal', items: 1 }),
        expect.objectContaining({ source: 'rehearsal.files', from: 'Private', toNames: 'Personal', toContent: 'Private', items: 1 }),
        expect.objectContaining({ source: 'rehearsal.files', from: 'Private', toNames: 'Secrets', toContent: 'Secrets', items: 1 }),
        expect.objectContaining({ source: 'rehearsal.library', from: 'Personal', toNames: 'Personal', toContent: 'Private', items: 1 }),
      ]));
      const personalFiles = plan.totals.destinations.find((destination) => destination.corpusId === FILE_CORPORA.internal)!;
      expect(personalFiles).toMatchObject({ modelId: 'gemini-embedding-2', vectorsCopied: 0, priceSource: 'default_unverified' });
      expect(personalFiles.chunksToEmbed).toBeGreaterThan(0);
      expect(personalFiles.estimatedCostUsd).toBeGreaterThanOrEqual(0);
      expect(plan.topPatterns.some((pattern) => pattern.kind === 'folder' && pattern.value === '/Files')).toBe(true);

      // Proposals only: no item has a current tier row or a copy.
      const ledger = read.lanes[0]!.set.ledger;
      expect(ledger.getCurrent(identityOf('rehearsal-files', 'garden'))).toBeUndefined();
      expect(ledger.copies(identityOf('rehearsal-files', 'garden'))).toEqual([]);
      expect(ledger.migrationProposals(plan.planId).map((proposal) => proposal.identity.providerItemId).sort())
        .toEqual(['garden', 'keys', 'therapy']);
      // Content-free: no title, path or text in the proposal rows.
      const rows = JSON.stringify(ledger.migrationProposals(plan.planId));
      expect(rows).not.toContain('garden-plan.txt');
      expect(rows).not.toContain('/Files');
      expect(rows).not.toContain('compost');
      expect(rows).not.toContain(FAKE_AWS_KEY);

      // The report is owner-only and says it is an estimate.
      expect(statSync(plan.reportPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(plan.reportPath, 'utf8')).toContain('ESTIMATES');

      // A note entry: not an approval.
      const entries = (await readEmbeddingLedger(context.paths.embeddingLedgerPath)).entries
        .filter((entry) => entry.entry_id?.startsWith('tier-migration'));
      expect(entries).toEqual([expect.objectContaining({
        entry_id: `tier-migration-plan:${plan.planId}`,
        kind: 'note',
        approved_by: 'system-automatic',
        status: 'n/a',
      })]);

      // A re-plan over the same data and inputs is the same plan: no second note.
      const again = await planTierMigration({
        lanes: read.lanes,
        inputs: context.inputs,
        domainIdentity: context.domainIdentity,
        paths: context.paths,
      });
      expect(again).toMatchObject({ planId: plan.planId, reused: true, countsSha256: plan.countsSha256 });
      expect((await readEmbeddingLedger(context.paths.embeddingLedgerPath)).entries
        .filter((entry) => entry.entry_id?.startsWith('tier-migration'))).toHaveLength(1);
    } finally {
      invalidate.mockRestore();
    }
  });

  test('an owner override changes the plan (M1) and makes the earlier plan stale', async () => {
    const context = await rehearsal();
    const read = lanes(context, 'read');
    const first = await planTierMigration({ lanes: read.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths });
    read.lanes[1]!.set.ledger.setOverride(identityOf('rehearsal-library', 'launch'), { kind: 'tier', tier: 'public' });
    await expect(approveTierMigration({ planId: first.planId, lanes: read.lanes, inputs: context.inputs, paths: context.paths }))
      .rejects.toThrow(/stale/u);
    const second = await planTierMigration({ lanes: read.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths });
    expect(second.planId).not.toBe(first.planId);
    expect(second.supersededPlans).toEqual([first.planId]);
    // Public <-> Personal: the Gemini vectors can be copied, so nothing to embed there.
    expect(second.totals.destinations.find((destination) => destination.corpusId === LIBRARY_CORPORA.public_safe))
      .toMatchObject({ vectorsCopied: expect.any(Number), chunksToEmbed: 0 });
    expect(readTierMigrationState(context.paths.statePath).plans.find((plan) => plan.planId === first.planId)?.state).toBe('superseded');
  });

  test('a plan whose stored text changed since planning is refused at approval', async () => {
    const context = await rehearsal();
    const read = lanes(context, 'read');
    const plan = await planTierMigration({ lanes: read.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths });
    read.close();
    cleanups.shift();
    // The provider edited the garden file and the lane re-synced it.
    context.fileSpecs[0]!.text = 'Weekly notes about the vegetable garden. New: the greenhouse and the water butts.';
    const store = new LocalConnectorStore({ dbPath: context.files.secure_local, corpusId: FILE_CORPORA.secure_local, family: 'file', trustDomain: 'secure_local', tierLedger: null });
    await store.syncFromConnector(connector('rehearsal-files', () => context.fileSpecs, 'file'), {
      fetchContent: true,
      placement: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
    });
    store.close();
    const reopened = lanes(context, 'read');
    await expect(approveTierMigration({ planId: plan.planId, lanes: reopened.lanes, inputs: context.inputs, paths: context.paths }))
      .rejects.toThrow(/1 planned item\(s\) changed since planning/u);
    const entries = (await readEmbeddingLedger(context.paths.embeddingLedgerPath)).entries;
    expect(entries.some((entry) => entry.kind === 'model_decision' && entry.entry_id?.startsWith('tier-migration-approval'))).toBe(false);
  });
});

describe('tier migration M2-M6', () => {
  test('approve binds the owner approval to the plan id and counts; run refuses without it', async () => {
    const context = await rehearsal();
    const read = lanes(context, 'read');
    const plan = await planTierMigration({ lanes: read.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths });
    const write = lanes(context, 'write');
    await expect(runTierMigration({
      planId: plan.planId, lanes: write.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths,
    })).rejects.toThrow(/not approved/u);
    const approved = await approveTierMigration({ planId: plan.planId, lanes: read.lanes, inputs: context.inputs, paths: context.paths, why: 'rehearsal' });
    expect(approved.state).toBe('approved');
    const entry = (await readEmbeddingLedger(context.paths.embeddingLedgerPath)).entries
      .find((candidate) => candidate.kind === 'model_decision' && candidate.entry_id?.startsWith('tier-migration-approval'));
    expect(entry).toMatchObject({
      entry_id: `tier-migration-approval:${plan.planId}:${plan.countsSha256}`,
      approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
      status: 'complete',
      why: 'rehearsal',
    });
    expect(entry?.what).toContain(plan.planId);
    expect(entry?.what).toContain(plan.countsSha256);
  });

  test('the rehearsal: moves run, unmoved items stay byte-identical, one visible copy each, no invalidation or rebind', async () => {
    const context = await rehearsal();
    const plan = await planAndApprove(context);
    const beforeFiles = snapshotStore(context.files.secure_local);
    const beforeLibrary = snapshotStore(context.library.internal);
    const cloudCalls = context.cloud.inputs.length;
    const localCalls = context.local.inputs.length;
    const invalidate = invalidationSpy();
    try {
      const write = lanes(context, 'write');
      const result = await runTierMigration({
        planId: plan.planId,
        lanes: write.lanes,
        inputs: context.inputs,
        domainIdentity: context.domainIdentity,
        paths: context.paths,
      });
      expect(result).toMatchObject({ state: 'done', planState: 'done', moved: 3, secrets: 1, skipped: 0, remaining: 0 });
      // No provider was called: text is copied between stores; the
      // destination's own model embeds later (the drain).
      expect(context.cloud.inputs.length).toBe(cloudCalls);
      expect(context.local.inputs.length).toBe(localCalls);
      expect(invalidate).not.toHaveBeenCalled();

      // Unmoved items: byte-identical rows, chunks and vectors.
      const afterFiles = snapshotStore(context.files.secure_local);
      const afterLibrary = snapshotStore(context.library.internal);
      for (const id of ['medical']) {
        const only = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row['local_item_id'] === `${ACCOUNT}:${id}`);
        expect(only(afterFiles.items)).toEqual(only(beforeFiles.items));
        expect(only(afterFiles.chunks)).toEqual(only(beforeFiles.chunks));
        expect(only(afterFiles.vectors)).toEqual(only(beforeFiles.vectors));
      }
      const essay = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row['local_item_id'] === `${ACCOUNT}:essay`);
      expect(essay(afterLibrary.vectors)).toEqual(essay(beforeLibrary.vectors));
      expect(essay(afterLibrary.chunks)).toEqual(essay(beforeLibrary.chunks));
      // Every existing vector in the legacy stores is still there, byte for byte
      // (moved items' previous copies are kept, hidden) — except the Secret's:
      // the one Secrets policy (tombstone_now, today's sync behavior) deleted
      // its copy, as a sync would, and recorded the deletion.
      const notKeys = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row['local_item_id'] !== `${ACCOUNT}:keys`);
      const keys = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row['local_item_id'] === `${ACCOUNT}:keys`);
      expect(notKeys(afterFiles.vectors)).toEqual(notKeys(beforeFiles.vectors));
      expect(keys(beforeFiles.vectors).length).toBeGreaterThan(0);
      expect(keys(afterFiles.vectors)).toEqual([]);
      expect(keys(afterFiles.chunks)).toEqual([]);
      expect(afterLibrary.vectors).toEqual(beforeLibrary.vectors);
      // No existing embedding authority was rebound.
      expect(afterFiles.authority).toEqual(beforeFiles.authority);
      expect(afterLibrary.authority).toEqual(beforeLibrary.authority);

      // Exactly one visible copy per layer.
      expect(servedFrom(context, FILE_CORPORA, context.files, 'garden'))
        .toEqual({ names: [], content: [FILE_CORPORA.internal] });
      expect(servedFrom(context, FILE_CORPORA, context.files, 'therapy').content).toEqual([FILE_CORPORA.secure_local]);
      expect(servedFrom(context, FILE_CORPORA, context.files, 'keys')).toEqual({ names: [], content: [] });
      expect(servedFrom(context, LIBRARY_CORPORA, context.library, 'journal').content).toEqual([LIBRARY_CORPORA.secure_local]);
      expect(servedFrom(context, FILE_CORPORA, context.files, 'medical').content).toEqual([FILE_CORPORA.secure_local]);

      // The raise kept the Personal copy's cloud vectors (hidden, unserved).
      const journalVectors = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row['local_item_id'] === `${ACCOUNT}:journal`);
      expect(journalVectors(afterLibrary.vectors).length).toBeGreaterThan(0);
      expect(journalVectors(afterLibrary.vectors)).toEqual(journalVectors(beforeLibrary.vectors));

      // The destination's first embed is a first mint on its existing model: epoch 1, no invalidation.
      const personal = write.lanes[0]!.set.store('internal')!;
      const embedded = await personal.embedChunks({ provider: context.cloud });
      expect(embedded.chunksEmbedded).toBe(result.chunksToEmbed[FILE_CORPORA.internal]!);
      expect(String(snapshotStore(context.files.internal).authority[0]!.cursor)).toContain('"providerEpoch":1');
      expect(invalidate).not.toHaveBeenCalled();

      // The Secret's location is recorded; the item is served nowhere.
      expect(write.lanes[0]!.set.secrets()!.get(identityOf('rehearsal-files', 'keys'))?.findingKinds).toContain('aws_access_key_id');

      // Ledger: started (in progress) and completed with observed counts, by the owner's approval.
      const entries = (await readEmbeddingLedger(context.paths.embeddingLedgerPath)).entries;
      expect(entries.find((entry) => entry.kind === 're_embed_started')).toMatchObject({
        entry_id: `tier-migration-batch-started:${result.batchId}`,
        approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
        status: 'in_progress',
      });
      expect(entries.find((entry) => entry.kind === 'invalidation' && entry.what.includes('found Secrets'))).toMatchObject({
        approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
        status: 'complete',
        scope: { chunks: { [FILE_CORPORA.secure_local]: keys(beforeFiles.chunks).length } },
      });
      expect(entries.find((entry) => entry.kind === 're_embed_completed')).toMatchObject({
        entry_id: `tier-migration-batch-completed:${result.batchId}`,
        approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
        status: 'complete',
        scope: { chunks: result.chunksToEmbed },
      });
      expect(tierMigrationStatusSummary(context.paths.statePath)).toMatchObject({ plan_id: plan.planId, state: 'done', in_progress: false });
    } finally {
      invalidate.mockRestore();
    }
  });

  test('Public <-> Personal moves copy the cloud vectors with zero provider calls', async () => {
    const context = await rehearsal();
    const read = lanes(context, 'read');
    read.lanes[1]!.set.ledger.setOverride(identityOf('rehearsal-library', 'launch'), { kind: 'tier', tier: 'public' });
    const plan = await planTierMigration({ lanes: read.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths });
    await approveTierMigration({ planId: plan.planId, lanes: read.lanes, inputs: context.inputs, paths: context.paths });
    const before = snapshotStore(context.library.internal).vectors.filter((row) => row['local_item_id'] === `${ACCOUNT}:launch`);
    const calls = context.cloud.inputs.length + context.local.inputs.length;
    const write = lanes(context, 'write');
    const result = await runTierMigration({
      planId: plan.planId,
      lanes: write.lanes,
      inputs: context.inputs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
      selector: 'source:rehearsal.library',
    });
    expect(result.chunksToEmbed[LIBRARY_CORPORA.public_safe]).toBeUndefined();
    expect(result.vectorsCopied).toBe(before.length);
    const copied = snapshotStore(context.library.public_safe).vectors.filter((row) => row['local_item_id'] === `${ACCOUNT}:launch`);
    expect(copied.map((row) => row['bytes'])).toEqual(before.map((row) => row['bytes']));
    expect(context.cloud.inputs.length + context.local.inputs.length).toBe(calls);
    expect(servedFrom(context, LIBRARY_CORPORA, context.library, 'launch').content).toEqual([LIBRARY_CORPORA.public_safe]);
    // Only the library batch ran; the file lane's proposals wait.
    expect(result.remaining).toBeGreaterThan(0);
  });

  test('a crash mid-move resumes with exactly one visible copy, and a raise hides first', async () => {
    const context = await rehearsal();
    const plan = await planAndApprove(context);
    const write = lanes(context, 'write');
    const importCopy = LocalConnectorStore.prototype.importItemCopy;
    let failures = 0;
    const crash = spyOn(LocalConnectorStore.prototype, 'importItemCopy').mockImplementation(function (this: LocalConnectorStore, ...args) {
      // Die while writing the raised journal's Private copy.
      if (this.corpusId === LIBRARY_CORPORA.secure_local && failures === 0) {
        failures += 1;
        throw new Error('simulated crash while writing the destination copy');
      }
      return importCopy.apply(this, args);
    });
    try {
      await expect(runTierMigration({
        planId: plan.planId,
        lanes: write.lanes,
        inputs: context.inputs,
        domainIdentity: context.domainIdentity,
        paths: context.paths,
        selector: 'source:rehearsal.library',
      })).rejects.toThrow(/simulated crash/u);
    } finally {
      crash.mockRestore();
    }
    // Hide first: the raised text is served nowhere while the move is unfinished.
    expect(servedFrom(context, LIBRARY_CORPORA, context.library, 'journal').content).toEqual([]);
    const stopped = readTierMigrationState(context.paths.statePath).plans.find((candidate) => candidate.planId === plan.planId)!;
    expect(stopped.lock).toBeUndefined();
    expect(stopped.batches[0]).toMatchObject({ state: 'stopped', stopReason: 'failed' });

    const resumed = await runTierMigration({
      planId: plan.planId,
      lanes: write.lanes,
      inputs: context.inputs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
      selector: 'source:rehearsal.library',
    });
    expect(resumed.batchId).toBe(stopped.batches[0]!.batchId);
    expect(resumed.state).toBe('done');
    expect(servedFrom(context, LIBRARY_CORPORA, context.library, 'journal').content).toEqual([LIBRARY_CORPORA.secure_local]);
  });

  test('the run stops before exceeding the approved chunks', async () => {
    const context = await rehearsal();
    const read = lanes(context, 'read');
    read.lanes[1]!.set.ledger.setOverride(identityOf('rehearsal-library', 'launch'), { kind: 'tier', tier: 'public' });
    const plan = await planTierMigration({ lanes: read.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths });
    await approveTierMigration({ planId: plan.planId, lanes: read.lanes, inputs: context.inputs, paths: context.paths });
    read.close();
    cleanups.shift();
    // Approved: the launch essay's vectors are copied (0 chunks to embed for it).
    // Its vectors disappear after approval (vectors are not part of the
    // stored-text fingerprint), so moving it would now need embedding.
    const db = new Database(context.library.internal);
    try {
      db.query(`DELETE FROM chunk_embeddings WHERE item_pk IN (SELECT item_pk FROM items WHERE provider_item_id = 'launch')`).run();
    } finally {
      closeSqliteStore(db);
    }
    const write = lanes(context, 'write');
    const planned = plan.totals.chunksToEmbed;
    const result = await runTierMigration({
      planId: plan.planId,
      lanes: write.lanes,
      inputs: context.inputs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
    });
    // Every other move fits the approval exactly; the launch move, which would
    // now embed a chunk nobody approved, is refused BEFORE it moves.
    expect(result).toMatchObject({ state: 'stopped', stopReason: 'copy_only_destination_needs_embed', planState: 'stopped', remaining: 1 });
    const consumed = Object.values(result.chunksToEmbed).reduce((sum, count) => sum + count, 0);
    expect(consumed).toBe(planned);
    expect(servedFrom(context, LIBRARY_CORPORA, context.library, 'launch').content).toEqual([LIBRARY_CORPORA.internal]);
    expect(existsSync(context.library.public_safe)).toBe(false);
    const entries = (await readEmbeddingLedger(context.paths.embeddingLedgerPath)).entries;
    expect(entries.find((entry) => entry.kind === 'note' && entry.what.includes('stopped (copy_only_destination_needs_embed)'))).toMatchObject({
      approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
      status: 'in_progress',
    });
    expect(entries.some((entry) => entry.kind === 're_embed_completed')).toBe(false);
    expect(tierMigrationStatusSummary(context.paths.statePath)).toMatchObject({ state: 'stopped', in_progress: true });
  });

  test('rollback flips back with no embed; purge needs its own approval and deletes only superseded copies', async () => {
    const context = await rehearsal();
    const plan = await planAndApprove(context);
    const write = lanes(context, 'write');
    const run = await runTierMigration({
      planId: plan.planId,
      lanes: write.lanes,
      inputs: context.inputs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
      selector: 'source:rehearsal.files',
    });
    const calls = context.cloud.inputs.length + context.local.inputs.length;
    const legacyBefore = snapshotStore(context.files.secure_local);

    const rolled = await rollbackTierMigrationBatch({ batchId: run.batchId, lanes: write.lanes, paths: context.paths });
    expect(rolled).toMatchObject({ rolledBack: 2, secretsKept: 1 });
    expect(context.cloud.inputs.length + context.local.inputs.length).toBe(calls);
    expect(snapshotStore(context.files.secure_local)).toEqual(legacyBefore);
    expect(servedFrom(context, FILE_CORPORA, context.files, 'garden').content).toEqual([FILE_CORPORA.secure_local]);
    // A rollback never makes a Secret visible again.
    expect(servedFrom(context, FILE_CORPORA, context.files, 'keys')).toEqual({ names: [], content: [] });
    expect((await readEmbeddingLedger(context.paths.embeddingLedgerPath)).entries.find((entry) => entry.entry_id === rolled.entryId))
      .toMatchObject({ kind: 'note', status: 'complete' });

    // Run the library lane, then purge. A dry purge deletes nothing.
    const library = await runTierMigration({
      planId: plan.planId,
      lanes: write.lanes,
      inputs: context.inputs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
      selector: 'source:rehearsal.library',
    });
    expect(library.moved).toBe(1);
    const beforePurge = snapshotStore(context.library.internal);
    const journal = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row['local_item_id'] === `${ACCOUNT}:journal`);
    // The split raise left the journal's Private text and cloud vectors in its
    // Personal names-only copy: unserved, and reported until a purge strips it.
    expect(journal(beforePurge.chunks).length).toBeGreaterThan(0);
    expect(journal(beforePurge.vectors).length).toBeGreaterThan(0);
    const dry = await purgeTierMigration({ planId: plan.planId, approve: false, lanes: write.lanes, paths: context.paths });
    expect(dry.approved).toBe(false);
    expect(dry.copies).toBeGreaterThan(0);
    expect(dry.namesOnlyCopies).toBe(1);
    expect(dry.namesOnlyChunks).toEqual({ [LIBRARY_CORPORA.internal]: journal(beforePurge.chunks).length });
    expect(snapshotStore(context.library.internal)).toEqual(beforePurge);
    // The approval is bound to the dry run's counts.
    await expect(purgeTierMigration({ planId: plan.planId, approve: true, why: 'x', lanes: write.lanes, paths: context.paths }))
      .rejects.toThrow(/counts changed since the dry run/u);
    await expect(purgeTierMigration({ planId: plan.planId, approve: true, expect: 'not-the-digest', why: 'x', lanes: write.lanes, paths: context.paths }))
      .rejects.toThrow(/counts changed since the dry run/u);
    expect(snapshotStore(context.library.internal)).toEqual(beforePurge);

    const invalidate = invalidationSpy();
    try {
      const purged = await purgeTierMigration({
        planId: plan.planId,
        approve: true,
        expect: dry.digest,
        why: 'rehearsal soak done',
        lanes: write.lanes,
        paths: context.paths,
      });
      expect(purged.approved).toBe(true);
      expect(purged.namesOnlyCopies).toBe(1);
      // The names-only copy keeps its names row; its kept text and vectors are gone.
      const after = snapshotStore(context.library.internal);
      expect(journal(after.items)).toEqual([expect.objectContaining({ tombstoned: 0 })]);
      expect(journal(after.chunks)).toEqual([]);
      expect(journal(after.vectors)).toEqual([]);
      expect(invalidate).not.toHaveBeenCalled();
      const entries = (await readEmbeddingLedger(context.paths.embeddingLedgerPath)).entries;
      expect(entries.find((entry) => entry.entry_id === purged.approvalEntryId)).toMatchObject({
        kind: 'invalidation',
        approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
        status: 'pending',
      });
      expect(entries.find((entry) => entry.entry_id === purged.invalidationEntryId)).toMatchObject({
        kind: 'invalidation',
        status: 'complete',
        scope: { chunks: purged.chunks },
      });
    } finally {
      invalidate.mockRestore();
    }
    // Journal's names stay served from Personal (a current, re-layered copy);
    // its text is served only from Private. Nothing current was deleted.
    expect(servedFrom(context, LIBRARY_CORPORA, context.library, 'journal').content).toEqual([LIBRARY_CORPORA.secure_local]);
    const essay = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row['local_item_id'] === `${ACCOUNT}:essay`);
    expect(essay(snapshotStore(context.library.internal).vectors)).toEqual(essay(beforePurge.vectors));
    // A purged batch cannot be rolled back.
    await expect(rollbackTierMigrationBatch({ batchId: library.batchId, lanes: write.lanes, paths: context.paths }))
      .rejects.toThrow(/purged/u);
  });

  test('the CLI drives the same path over lane specs and prints content-free status', async () => {
    const context = await rehearsal();
    const cli = {
      laneSpecs: context.specs,
      inputs: context.inputs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
      itemDelayMs: 0,
    };
    const planned = await runTierMigrateCommand(['plan'], cli);
    expect(planned).toMatchObject({ kind: 'olympus_tier_migration_plan', state: 'planned' });
    const planId = String(planned['plan_id']);
    await expect(runTierMigrateCommand(['purge', '--approve'], cli)).rejects.toThrow(/--why/u);
    await expect(runTierMigrateCommand(['run', '--plan', planId, '--bogus'], cli)).rejects.toThrow(/Unknown option/u);
    expect(await runTierMigrateCommand(['approve', '--plan', planId, '--why', 'rehearsal'], cli)).toMatchObject({ state: 'approved' });
    const status = await runTierMigrateCommand(['status'], cli);
    expect(status).toMatchObject({ migration: { plan_id: planId, state: 'approved', in_progress: false }, freshness: { fresh: true } });
    expect(JSON.stringify(status)).not.toContain('/Files');
    const ran = await runTierMigrateCommand(['run', '--plan', planId, '--batch', 'folder:/Files'], cli);
    expect(ran).toMatchObject({ kind: 'olympus_tier_migration_run', state: 'done', moved: 2, secrets: 1 });
    expect(await runTierMigrateCommand(['rollback', '--batch', String(ran['batch_id'])], cli)).toMatchObject({ rolled_back: 2, secrets_kept: 1 });
  });
});

describe('tier migration finishes moves a sync queued', () => {
  test('a routed item a sync re-judged (hidden, queued) is moved by the approved run', async () => {
    const { dir, cleanup } = tempDir('olympus-tier-p3-queued-');
    cleanups.push(cleanup);
    const fixture = openTierFixture(dir);
    const specs: FixtureSpec[] = [{ id: 'new-garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden and the compost bins.' }];
    try {
      await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      specs[0] = { ...specs[0]!, version: 'v2', text: 'Compost notes. IBAN GB82WEST12345698765432 for the seeds.' };
      const queued = await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      expect(queued.routing.movesQueued).toBe(1);
    } finally {
      fixture.close();
    }
    const paths = storePaths(dir);
    const laneSpecs: TierMigrationLaneSpec[] = [{
      sourceId: 'fixture.files',
      setId: 'fixture.personal',
      legs: {
        public_safe: { corpusId: CORPORA.public_safe!, dbPath: paths.public_safe, family: 'file' },
        internal: { corpusId: CORPORA.internal!, dbPath: paths.internal, family: 'file', legacy: true },
        secure_local: { corpusId: CORPORA.secure_local!, dbPath: paths.secure_local, family: 'file', legacy: true },
      },
    }];
    const cloud = cloudProvider();
    const local = localProvider();
    const identities: Record<string, TierMoveEmbeddingIdentity> = {
      public_safe: asMoveIdentity(cloud),
      internal: asMoveIdentity(cloud),
      secure_local: asMoveIdentity(local),
    };
    const cli = {
      laneSpecs,
      inputs: { revision: 'map:none;rules:none' },
      domainIdentity: (domain: SourceTrustDomain) => identities[domain],
      paths: {
        statePath: join(dir, 'tier-migration', 'state.json'),
        reportDir: join(dir, 'tier-migration', 'reports'),
        embeddingLedgerPath: join(dir, 'embedding-ledger.jsonl'),
      },
      itemDelayMs: 0,
    };
    const planned = await runTierMigrateCommand(['plan'], cli);
    expect(planned).toMatchObject({ totals: { proposed: 1, raises: 1 } });
    const planId = String(planned['plan_id']);
    await runTierMigrateCommand(['approve', '--plan', planId], cli);
    const ran = await runTierMigrateCommand(['run', '--plan', planId], cli);
    expect(ran).toMatchObject({ state: 'done', moved: 1 });
    const reopened = openTierFixture(dir);
    try {
      expect(reopened.ledger.getCurrent(identityOfFixture('new-garden'))).toMatchObject({ state: 'current', contentTier: 'secure' });
      expect(reopened.stores.internal!.searchItems('compost', 5)).toEqual([]);
      expect(reopened.stores.secure_local!.searchItems('compost', 5)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});

describe('tier migration status', () => {
  test('status publishes per-tier counts, Secret locations, superseded chunks and the migration state', async () => {
    const context = await rehearsal();
    const plan = await planAndApprove(context);
    const write = lanes(context, 'write');
    await runTierMigration({
      planId: plan.planId,
      lanes: write.lanes,
      inputs: context.inputs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
      selector: 'source:rehearsal.files',
    });
    await runTierMigration({
      planId: plan.planId,
      lanes: write.lanes,
      inputs: context.inputs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
      selector: 'source:rehearsal.library',
    });
    const stores = [...write.lanes[0]!.set.openStores(), ...write.lanes[1]!.set.openStores()];
    const handler = createSourceIndexStatusHandler({
      corpusDefinitions: stores.map((store) => defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain })),
      connectorStores: stores,
      tierMigration: () => tierMigrationStatusSummary(context.paths.statePath),
    });
    const status = await handler.status({});
    expect(status.tier_migration).toMatchObject({
      plan_id: plan.planId,
      state: 'done',
      // Finished: the doctor excuses nothing any more.
      in_progress: false,
      approval_entry_id: `tier-migration-approval:${plan.planId}:${plan.countsSha256}`,
      destinations: plan.totals.destinations.filter((destination) => destination.chunksToEmbed > 0)
        .map((destination) => ({ corpus_id: destination.corpusId, chunks_to_embed: destination.chunksToEmbed })),
    });
    expect(plan.totals.namesOnlyKeptChunks).toBeGreaterThan(0);
    expect(status.tier_migration?.names_only_kept_chunks).toBe(plan.totals.namesOnlyKeptChunks);
    const counts = (corpusId: string) => (status.corpora.find((corpus) => corpus.corpus_id === corpusId) as { counts: Record<string, number> }).counts;
    // Private files: therapy (text), medical (whole); the garden and keys copies are superseded (kept, uncounted).
    expect(counts(FILE_CORPORA.secure_local)).toMatchObject({ indexed_items: 2, secret_locations: 1 });
    expect(counts(FILE_CORPORA.secure_local)['superseded_chunks']).toBeGreaterThan(0);
    // Personal files: garden (whole) and therapy's names.
    expect(counts(FILE_CORPORA.internal)).toMatchObject({ indexed_items: 2 });
    // The journal's split raise left its text in the Personal names-only copy: reported, never served.
    expect(counts(LIBRARY_CORPORA.internal)['names_only_kept_chunks']).toBe(plan.totals.namesOnlyKeptChunks);
    expect(JSON.stringify(status.tier_migration)).not.toContain('/Files');
  });
});

describe('tier migration review fixes', () => {
  test('the Secrets policy is one switch: hide_until_purge keeps the copy hidden through rollback until an approved purge', async () => {
    const context = await rehearsal();
    const plan = await planAndApprove(context);
    const write = lanes(context, 'write');
    const keysVectors = () => snapshotStore(context.files.secure_local).vectors.filter((row) => row['local_item_id'] === `${ACCOUNT}:keys`);
    const before = keysVectors();
    const run = await runTierMigration({
      planId: plan.planId,
      lanes: write.lanes,
      inputs: context.inputs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
      selector: 'source:rehearsal.files',
      secretsDisposition: 'hide_until_purge',
    });
    expect(run.secrets).toBe(1);
    expect(keysVectors()).toEqual(before);
    expect(servedFrom(context, FILE_CORPORA, context.files, 'keys')).toEqual({ names: [], content: [] });
    const rolled = await rollbackTierMigrationBatch({ batchId: run.batchId, lanes: write.lanes, paths: context.paths });
    expect(rolled.secretsKept).toBe(1);
    expect(servedFrom(context, FILE_CORPORA, context.files, 'keys')).toEqual({ names: [], content: [] });
    const dry = await purgeTierMigration({ planId: plan.planId, approve: false, lanes: write.lanes, paths: context.paths });
    await purgeTierMigration({ planId: plan.planId, approve: true, expect: dry.digest, why: 'rehearsal', lanes: write.lanes, paths: context.paths });
    expect(keysVectors()).toEqual([]);
  });

  test('a run refuses when a destination embedding identity changed, and never counts an unpriced destination as free', async () => {
    const context = await rehearsal();
    const plan = await planAndApprove(context);
    const write = lanes(context, 'write');
    const cloudless: TierMigrationDomainIdentity = (domain) => (domain === 'secure_local' ? context.domainIdentity(domain) : {
      ...context.domainIdentity(domain)!,
      epochId: 'cloud:google-gemini:gemini-embedding-2:other-epoch',
    });
    await expect(runTierMigration({
      planId: plan.planId, lanes: write.lanes, inputs: context.inputs, domainIdentity: cloudless, paths: context.paths,
    })).rejects.toThrow(/embedding identity changed/u);
    expect(servedFrom(context, FILE_CORPORA, context.files, 'garden').content).toEqual([FILE_CORPORA.secure_local]);

    // An approved plan whose recorded destinations were tampered with: the run
    // stops before handing chunks to a store it never priced.
    const state = readTierMigrationState(context.paths.statePath);
    const record = state.plans.find((candidate) => candidate.planId === plan.planId)!;
    record.totals.destinations = [];
    writeFileSync(context.paths.statePath, JSON.stringify(state));
    // The approval is bound to the counts hash, so tampering is refused first.
    await expect(runTierMigration({
      planId: plan.planId, lanes: write.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths,
    })).rejects.toThrow(/no owner approval bound to its counts/u);
  });

  test('a re-plan supersedes a crashed running plan, and a legacy item routed since planning is left to its newer state', async () => {
    const context = await rehearsal();
    const plan = await planAndApprove(context);
    // A run that died holding the lock (a pid that is not alive).
    const state = readTierMigrationState(context.paths.statePath);
    const record = state.plans.find((candidate) => candidate.planId === plan.planId)!;
    record.state = 'running';
    record.lock = { pid: 2_147_483_000, startedAt: new Date().toISOString() };
    writeFileSync(context.paths.statePath, JSON.stringify(state));
    // Meanwhile a sync routed the garden file (its generation moved on).
    const write = lanes(context, 'write');
    const ledger = write.lanes[0]!.set.ledger;
    const garden = identityOf('rehearsal-files', 'garden');
    write.lanes[0]!.set.store('secure_local')!.bindTierSet(ledger);
    ledger.adoptLegacyPlacement(garden, [{ corpusId: FILE_CORPORA.secure_local, trustDomain: 'secure_local', layers: 'both' }], {
      whenMissing: { family: 'file', metadataTier: 'secure', contentTier: 'secure' },
    });
    ledger.flip(garden, { expectedGeneration: 1, metadataTier: 'secure', contentTier: 'secure' });
    const run = await runTierMigration({
      planId: plan.planId,
      lanes: write.lanes,
      inputs: context.inputs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
      selector: 'source:rehearsal.files',
    });
    expect(run.skipped).toBe(1);
    expect(servedFrom(context, FILE_CORPORA, context.files, 'garden').content).toEqual([FILE_CORPORA.secure_local]);

    const crashed = readTierMigrationState(context.paths.statePath);
    crashed.plans.find((candidate) => candidate.planId === plan.planId)!.state = 'running';
    crashed.plans.find((candidate) => candidate.planId === plan.planId)!.lock = { pid: 2_147_483_000, startedAt: new Date().toISOString() };
    writeFileSync(context.paths.statePath, JSON.stringify(crashed));
    const read = lanes(context, 'read');
    read.lanes[1]!.set.ledger.setOverride(identityOf('rehearsal-library', 'essay'), { kind: 'tier', tier: 'secure' });
    const replanned = await planTierMigration({ lanes: read.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths });
    expect(replanned.supersededPlans).toContain(plan.planId);
  });

  test('the move primitive refuses to overwrite a superseded copy kept in its destination', async () => {
    const context = await rehearsal();
    const read = lanes(context, 'read');
    read.lanes[1]!.set.ledger.setOverride(identityOf('rehearsal-library', 'launch'), { kind: 'tier', tier: 'public' });
    const plan = await planTierMigration({ lanes: read.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths });
    await approveTierMigration({ planId: plan.planId, lanes: read.lanes, inputs: context.inputs, paths: context.paths });
    const write = lanes(context, 'write');
    await runTierMigration({
      planId: plan.planId, lanes: write.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths,
      selector: 'source:rehearsal.library',
    });
    // Launch is now Public; its Personal copy is kept, superseded. Moving it
    // back to Personal would overwrite that kept copy: refused.
    const set = write.lanes[1]!.set;
    const launch = identityOf('rehearsal-library', 'launch');
    await expect(moveTieredItem({
      set,
      identity: { ...launch, family: 'readwise', localItemId: `${ACCOUNT}:launch` },
      target: { metadataTier: 'private', contentTier: 'private' },
    })).rejects.toThrow(TierMoveRefusedError);
    expect(servedFrom(context, LIBRARY_CORPORA, context.library, 'launch').content).toEqual([LIBRARY_CORPORA.public_safe]);
  });
});

function p1aDecision(tier: 'public' | 'private'): TierDecision {
  return {
    metadataTier: tier,
    contentTier: tier,
    decidedBy: 'default',
    reasons: [],
    state: 'current',
    contentRead: true,
    metadataPending: false,
    contentPending: false,
    metadataForced: false,
    metadataFlagged: false,
    engineVersion: 'p1a',
    mapRevision: 'none',
    snifferId: 'undecided',
  };
}

describe('tier migration P3 follow-ups', () => {
  test('a store approved for copied vectors only receives no embed, even with slack approved for other stores', async () => {
    const context = await rehearsal();
    const read = lanes(context, 'read');
    read.lanes[1]!.set.ledger.setOverride(identityOf('rehearsal-library', 'launch'), { kind: 'tier', tier: 'public' });
    const plan = await planTierMigration({ lanes: read.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths });
    await approveTierMigration({ planId: plan.planId, lanes: read.lanes, inputs: context.inputs, paths: context.paths });
    read.close();
    cleanups.shift();
    // Approved: the Public library store only receives copied vectors.
    const publicLibrary = plan.totals.destinations.find((destination) => destination.corpusId === LIBRARY_CORPORA.public_safe)!;
    expect(publicLibrary).toMatchObject({ chunksToEmbed: 0, estimatedCostUsd: 0 });
    // The plan approved embeds for the file lane's stores, which this batch
    // does not run: the plan-wide budget alone would have room for this move.
    const fileLaneSlack = plan.totals.destinations
      .filter((destination) => Object.values(FILE_CORPORA).includes(destination.corpusId))
      .reduce((sum, destination) => sum + destination.chunksToEmbed, 0);
    expect(fileLaneSlack).toBeGreaterThan(0);
    // At run time the launch essay's vectors are gone: moving it would embed.
    const db = new Database(context.library.internal);
    try {
      db.query(`DELETE FROM chunk_embeddings WHERE item_pk IN (SELECT item_pk FROM items WHERE provider_item_id = 'launch')`).run();
    } finally {
      closeSqliteStore(db);
    }
    const write = lanes(context, 'write');
    const run = () => runTierMigration({
      planId: plan.planId,
      lanes: write.lanes,
      inputs: context.inputs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
      selector: 'source:rehearsal.library',
    });
    const result = await run();
    expect(result).toMatchObject({ state: 'stopped', stopReason: 'copy_only_destination_needs_embed', planState: 'stopped' });
    expect(result.chunksToEmbed[LIBRARY_CORPORA.public_safe]).toBeUndefined();
    expect(servedFrom(context, LIBRARY_CORPORA, context.library, 'launch').content).toEqual([LIBRARY_CORPORA.internal]);
    expect(existsSync(context.library.public_safe)).toBe(false);
    // Resuming cannot get past it: the owner must re-plan and approve.
    const again = await run();
    expect(again).toMatchObject({ state: 'stopped', stopReason: 'copy_only_destination_needs_embed' });
    expect(existsSync(context.library.public_safe)).toBe(false);
    const entries = (await readEmbeddingLedger(context.paths.embeddingLedgerPath)).entries;
    expect(entries.find((entry) => entry.kind === 'note' && entry.what.includes('stopped (copy_only_destination_needs_embed)'))?.what)
      .toContain('plans again and approves the new costs');
    expect(entries.some((entry) => entry.kind === 're_embed_completed')).toBe(false);
    // Status says when it stopped (the doctor ages a stopped plan's lag exception).
    const summary = tierMigrationStatusSummary(context.paths.statePath)!;
    expect(summary).toMatchObject({ state: 'stopped', in_progress: true });
    expect(Number.isFinite(Date.parse(summary.stopped_at!))).toBe(true);
  });

  test('a legacy item that already had a P1a ledger row resumes after a crash right after adoption', async () => {
    const context = await rehearsal();
    const journal = identityOf('rehearsal-library', 'journal');
    // P1a recorded a decision for the legacy journal (it moved once: generation 2).
    {
      const setup = lanes(context, 'write');
      setup.lanes[1]!.set.ledger.recordDecision({ ...journal, family: 'readwise' }, p1aDecision('public'));
      setup.lanes[1]!.set.ledger.recordDecision({ ...journal, family: 'readwise' }, p1aDecision('private'));
      expect(setup.lanes[1]!.set.ledger.getCurrent(journal)).toMatchObject({ generation: 2, routed: false });
      setup.close();
      cleanups.shift();
    }
    const plan = await planAndApprove(context);
    const write = lanes(context, 'write');
    const stageMove = TierLedger.prototype.stageMove;
    let crashes = 0;
    const crash = spyOn(TierLedger.prototype, 'stageMove').mockImplementation(function (this: TierLedger, ...args) {
      // Die right after the migration adopted the journal's legacy placement.
      if (args[0].providerItemId === 'journal' && crashes === 0) {
        crashes += 1;
        throw new Error('simulated crash right after adoption');
      }
      return stageMove.apply(this, args);
    });
    try {
      await expect(runTierMigration({
        planId: plan.planId, lanes: write.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths,
        selector: 'source:rehearsal.library',
      })).rejects.toThrow(/simulated crash/u);
    } finally {
      crash.mockRestore();
    }
    const ledger = write.lanes[1]!.set.ledger;
    expect(ledger.getCurrent(journal)).toMatchObject({ generation: 2, routed: true, state: 'current' });
    const resumed = await runTierMigration({
      planId: plan.planId, lanes: write.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths,
      selector: 'source:rehearsal.library',
    });
    expect(resumed).toMatchObject({ state: 'done', skipped: 0 });
    expect(servedFrom(context, LIBRARY_CORPORA, context.library, 'journal').content).toEqual([LIBRARY_CORPORA.secure_local]);
  });

  test('a P1a row recorded after planning is left unadopted for the next plan, never stranded routed but unmoved', async () => {
    const context = await rehearsal();
    const plan = await planAndApprove(context);
    const journal = identityOf('rehearsal-library', 'journal');
    const write = lanes(context, 'write');
    const ledger = write.lanes[1]!.set.ledger;
    // A sync's P1a pass recorded the journal after the plan saw no row.
    ledger.recordDecision({ ...journal, family: 'readwise' }, p1aDecision('private'));
    const stageMove = TierLedger.prototype.stageMove;
    let crashes = 0;
    const crash = spyOn(TierLedger.prototype, 'stageMove').mockImplementation(function (this: TierLedger, ...args) {
      // Were it adopted, the run would die right after adoption.
      if (args[0].providerItemId === 'journal' && crashes === 0) {
        crashes += 1;
        throw new Error('simulated crash right after adoption');
      }
      return stageMove.apply(this, args);
    });
    let first;
    try {
      first = await runTierMigration({
        planId: plan.planId, lanes: write.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths,
        selector: 'source:rehearsal.library',
      });
    } finally {
      crash.mockRestore();
    }
    // Its newer decision wins: skipped before adoption, still legacy.
    expect(crashes).toBe(0);
    expect(first).toMatchObject({ state: 'done', skipped: 1 });
    expect(ledger.getCurrent(journal)).toMatchObject({ routed: false, generation: 1 });
    expect(ledger.copies(journal)).toEqual([]);
    expect(servedFrom(context, LIBRARY_CORPORA, context.library, 'journal').content).toEqual([LIBRARY_CORPORA.internal]);
    // The next plan judges it again.
    const read = lanes(context, 'read');
    const replanned = await planTierMigration({ lanes: read.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths });
    expect(read.lanes[1]!.set.ledger.migrationProposals(replanned.planId).map((proposal) => proposal.identity.providerItemId)).toContain('journal');
  });

  test('rollbackMove itself refuses to re-expose a Secrets row', async () => {
    const context = await rehearsal();
    const plan = await planAndApprove(context);
    const write = lanes(context, 'write');
    const run = await runTierMigration({
      planId: plan.planId, lanes: write.lanes, inputs: context.inputs, domainIdentity: context.domainIdentity, paths: context.paths,
      selector: 'source:rehearsal.files', secretsDisposition: 'hide_until_purge',
    });
    expect(run.secrets).toBe(1);
    const ledger = write.lanes[0]!.set.ledger;
    const keys = identityOf('rehearsal-files', 'keys');
    const record = ledger.getCurrent(keys)!;
    expect(record.contentTier).toBe('secrets');
    expect(() => ledger.rollbackMove(keys, { expectedGeneration: record.generation })).toThrow(/Secrets/u);
    expect(ledger.getCurrent(keys)).toMatchObject({ contentTier: 'secrets', generation: record.generation });
    expect(servedFrom(context, FILE_CORPORA, context.files, 'keys')).toEqual({ names: [], content: [] });
  });
});

describe('tier migration reads the owner inputs through the P2 loaders, fail closed', () => {
  test('an invalid map or rules file refuses to plan; valid rules reach the plan; an unapproved sniffer refuses', async () => {
    const context = await rehearsal();
    const mapPath = join(context.dir, 'sensitivity-map.json');
    const rulesPath = join(context.dir, 'tier-rules.json');
    const cli = (env: Record<string, string | undefined>) => ({
      env: { HOME: context.dir, XDG_DATA_HOME: context.dir, OLYMPUS_SENSITIVITY_MAP_PATH: mapPath, OLYMPUS_TIER_RULES_PATH: rulesPath, ...env },
      laneSpecs: context.specs,
      domainIdentity: context.domainIdentity,
      paths: context.paths,
      itemDelayMs: 0,
    });
    writeFileSync(mapPath, '{ "schemaVersion": 2, ');
    chmodSync(mapPath, 0o600);
    await expect(runTierMigrateCommand(['plan'], cli({}))).rejects.toThrow(/sensitivity map is unusable/u);
    rmSync(mapPath);
    writeFileSync(rulesPath, '{ not json');
    chmodSync(rulesPath, 0o600);
    await expect(runTierMigrateCommand(['plan'], cli({}))).rejects.toThrow(/Tier rules/u);
    // A folder rule the owner wrote makes the garden file Private: it stays put.
    writeFileSync(rulesPath, JSON.stringify({
      schemaVersion: 1,
      rules: [{ id: 'files-private', match: { pathPrefix: '/Files' }, tier: 'secure', strength: 'force' }],
    }));
    chmodSync(rulesPath, 0o600);
    const planned = await runTierMigrateCommand(['plan'], cli({}));
    expect(planned['state']).toBe('planned');
    const moves = (planned['totals'] as { moves: Array<{ source: string; toContent: string }> }).moves;
    expect(moves.some((move) => move.source === 'rehearsal.files' && move.toContent === 'Personal')).toBe(false);
    expect(existsSync(context.paths.statePath)).toBe(true);
    await expect(runTierMigrateCommand(['plan', '--with-sniffer'], cli({}))).rejects.toThrow(/sniffer/u);
  });
});

describe('tier migration is source-neutral', () => {
  test('the migration engine names no source in code: lanes are data', () => {
    const code = readFileSync(join(import.meta.dir, '..', 'src/workers/classification/tier-migration.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .toLowerCase();
    for (const name of ['gmail', 'gdrive', 'dropbox', 'readwise', 'telegram', 'whatsapp', 'imessage', 'twitter', 'x_bookmarks', 'slack', 'notion']) {
      expect(code.includes(name), name).toBe(false);
    }
  });
});
