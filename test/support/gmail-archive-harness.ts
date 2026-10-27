// The Gmail source with its two inputs, run through the real archive import,
// the real dashboard approval, a real tiered store set over the Gmail stores
// and the real intake rule (docs/design/archive-live-one-dataset.md, step 6).
// The live input is the real Gmail connector over a fake Gmail API; the
// archive input is a synthetic mbox written to disk. No real mail.

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { placeOwnedAccount, recordProviderAccount } from '../../src/core/source-storage.ts';
import { lifecycleAccountFiles } from '../../src/data-lifecycle.ts';
import { SecretLocationsIndex } from '../../src/workers/classification/secret-locations.ts';
import { TierLedger } from '../../src/workers/classification/tier-ledger.ts';
import { secretLocationsPathForStore } from '../../src/workers/classification/tier-ledger-path.ts';
import type { OwnerTierRule, TierSniffer } from '../../src/workers/classification/tier-classifier.ts';
import { LocalConnectorStore } from '../../src/workers/connector-store/index.ts';
import { createLaneTieredStoreSet, tieredStoreSetLedgerPath, type TieredStoreSet } from '../../src/workers/connector-store/tiered-store-set.ts';
import { createArchiveImportDashboard, type ArchiveImportDashboard } from '../../src/workers/archive-import/dashboard.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../../src/workers/archive-import/runtime.ts';
import { ArchiveSourceTargets } from '../../src/workers/archive-import/source-targets.ts';
import { pullArchiveImport, type ArchiveImportPullOptions } from '../../src/workers/archive-import/sync.ts';
import { createArchivePathResolver } from '../../src/workers/local-files/scope-browser.ts';
import { approveStaged } from './stage-upload.ts';
import { MacPermissions } from '../../src/workers/local-files/mac-permissions.ts';
import { VolumeResolver } from '../../src/workers/local-files/volume-identity.ts';
import { createExclusiveRunner } from '../../src/workers/source-account-guard.ts';
import type { CredentialBroker } from '../../src/workers/credential-broker/index.ts';
import { GoogleGmailSourceConnector, type GmailApiClient, type GmailConnectorScope, type GmailMessage } from '../../src/workers/google-connectors/gmail.ts';
import { gmailArchiveTarget, GMAIL_ARCHIVE_SOURCE_ID } from '../../src/workers/google-connectors/gmail-archive-target.ts';
import type { GmailMailBuild } from '../../src/workers/google-connectors/gmail-mail-record.ts';
import {
  createGmailConnectorStoreSyncHandler,
  gmailContentArrivesLater,
  gmailLaneSyncOptions,
  type GmailConnectorStoreSyncHandler,
} from '../../src/workers/google-connectors/gmail-live-sync.ts';
import type { MboxGmailMatch } from '../../src/workers/archive-import/mbox/gmail-input.ts';

export const ACCOUNT = 'personal';
const OFFLINE_BROKER = { async issueSession() { throw new Error('no credentials in the fixture'); } } as unknown as CredentialBroker;
const WAITING: TierSniffer = { id: 'fixture-waiting', judge: () => ({ verdict: 'undecided', queued: true }) };

export interface GmailArchiveHarness {
  home: string;
  env: Record<string, string>;
  runtime: ArchiveImportRuntime;
  targets: ArchiveSourceTargets;
  dashboard: ArchiveImportDashboard;
  set: TieredStoreSet;
  /**
   * The live mailbox the fake Gmail API serves: assign to change what a live
   * pull sees. `attachments` holds attachment bodies by attachment id
   * (base64url); `calls` records each request the fake answers.
   */
  mailbox: { messages: GmailMessage[]; attachments: Record<string, string>; calls: string[] };
  /** The content window of the live lane (mail older is kept by name only). */
  window: { contentAfterMs?: number };
  build: GmailMailBuild;
  /** The Gmail stores the set writes (internal, Private). */
  stores: { internal: LocalConnectorStore; secure: LocalConnectorStore };
  match: { current?: MboxGmailMatch };
  /** The account's labels as the lane reads them (lower-cased name to id), or why they cannot be read. */
  labels: { current?: () => Promise<ReadonlyMap<string, string> | { unavailable: string }> };
  /** Gmail connected as the account named by `providerAccountId` (null: an entry that names none). */
  connectLive(providerAccountId: string | null): void;
  pullLive(): Promise<void>;
  /** The live Gmail connector over the fake API, as the attachment lane reads parts with it. */
  liveReader(options?: { scope?: GmailConnectorScope; beforeEachRequest?: () => void }): GoogleGmailSourceConnector;
  /** The Gmail lane's live sync handler over the fake API and this set. */
  syncHandler(options?: { scope?: GmailConnectorScope; assertScopeCurrent?: () => void }): GmailConnectorStoreSyncHandler;
  writeExport(name: string, text: string): string;
  approve(name: string, text: string, answer?: { confirmAccount?: true; keepApart?: true }): ReturnType<ArchiveImportDashboard['approve']>;
  importAll(archiveId: string, options?: Partial<ArchiveImportPullOptions>): ReturnType<typeof pullArchiveImport>;
  /** Active rows of the Gmail stores: provider item id, whether it holds text, its leg. */
  rows(): Array<{ id: string; chunks: number; domain: string; parent: string | null; tombstoned: number }>;
  textOf(providerItemId: string): string;
  /** The locator a child's row keeps for reading its bytes later, from whichever store holds it. */
  locatorOf(providerItemId: string): string | undefined;
  close(): void;
}

function fakeGmail(mailbox: GmailArchiveHarness['mailbox']): GmailApiClient {
  return {
    async listMessages(request) {
      mailbox.calls.push('list');
      const after = /after:(\d+)/.exec(request.query ?? '')?.[1];
      const before = /before:(\d+)/.exec(request.query ?? '')?.[1];
      const eligible = mailbox.messages.filter((entry) => {
        const at = Number(entry.internalDate);
        return (!after || at > Number(after) * 1_000) && (!before || at < Number(before) * 1_000);
      });
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = eligible.slice(offset, offset + request.maxResults);
      return {
        messages: slice.map((entry) => ({ id: entry.id })),
        ...(offset + slice.length < eligible.length ? { nextPageToken: String(offset + slice.length) } : {}),
      };
    },
    async getMessage(id, options) {
      mailbox.calls.push(options?.format === 'metadata' ? `metadata:${id}` : `message:${id}`);
      const found = mailbox.messages.find((entry) => entry.id === id);
      if (!found) throw new Error(`Gmail API request failed (404): unknown ${id}`);
      if (options?.format !== 'metadata') return found;
      return { ...found, payload: { headers: found.payload?.headers ?? [] } };
    },
    async getAttachment(messageId, attachmentId) {
      mailbox.calls.push(`attachment:${messageId}:${attachmentId}`);
      const data = mailbox.attachments[attachmentId];
      if (data === undefined) throw new Error(`Gmail API request failed (404): unknown ${attachmentId}`);
      return { data };
    },
  };
}

export function gmailArchiveHarness(
  cleanups: Array<() => void>,
  options: { build?: GmailMailBuild; sniffer?: TierSniffer; rules?: OwnerTierRule[] } = {},
): GmailArchiveHarness {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gmail-archive-')));
  const home = join(base, 'home');
  const exports = join(home, 'Exports');
  mkdirSync(exports, { recursive: true });
  const env = { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state') };
  const stores = lifecycleAccountFiles(GMAIL_ARCHIVE_SOURCE_ID, { homeDir: home }).stores;
  const securePath = stores.find((path) => /secure|private/i.test(path)) ?? join(base, 'gmail-secure.sqlite');
  const internalPath = stores.find((path) => path !== securePath) ?? join(base, 'gmail-internal.sqlite');
  mkdirSync(dirname(securePath), { recursive: true });
  mkdirSync(dirname(internalPath), { recursive: true });
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(securePath) });
  const secrets = new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(securePath) });
  const internalStore = new LocalConnectorStore({ dbPath: internalPath, corpusId: 'internal.email', family: 'email', trustDomain: 'internal', tierLedger: ledger });
  const secureStore = new LocalConnectorStore({ dbPath: securePath, corpusId: 'secure_local.email.private', family: 'email', trustDomain: 'secure_local', tierLedger: ledger });
  const set = createLaneTieredStoreSet({
    setId: 'gmail',
    internalStore,
    secureStore,
    ledger,
    secretLocations: secrets,
    tierClassification: { sniffer: options.sniffer ?? WAITING, ...(options.rules ? { rules: options.rules } : {}) },
    contentArrivesLaterFor: gmailContentArrivesLater,
  });
  const mailbox: GmailArchiveHarness['mailbox'] = { messages: [], attachments: {}, calls: [] };
  const window: { contentAfterMs?: number } = {};
  const build = options.build ?? {};
  const match: { current?: MboxGmailMatch } = {};
  const labels: GmailArchiveHarness['labels'] = {};
  const exclusive = createExclusiveRunner();
  const targets = new ArchiveSourceTargets();
  targets.register(gmailArchiveTarget({
    lane: () => ({
      set,
      sync: gmailLaneSyncOptions(),
      account: ACCOUNT,
      build,
      ...(match.current ? { match: match.current } : {}),
      ...(labels.current ? { labelIds: labels.current } : {}),
    }),
    exclusive,
    concurrencyKey: 'internal.email',
  }));
  const runtime = createArchiveImportRuntime({
    env,
    waitingQuestionsDbPath: join(base, 'waiting-private-questions.sqlite'),
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
    targets,
  });
  const volumes = new VolumeResolver({ platform: 'darwin', home, readMounts: () => '/dev/disk3s1s1 on / (apfs, local)', diskutilPlist: () => undefined });
  const permissions = new MacPermissions({ home, memoryPath: join(base, 'folder-access.json'), platform: 'linux' });
  const resolver = createArchivePathResolver({ volumes, home, permissions });
  const dashboard = createArchiveImportDashboard({ runtime, resolver, refreshScheduler: () => undefined, privateModel: () => 'ready', home });

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
    for (const store of set.openStores()) store.close();
    internalStore.close();
    secureStore.close();
    secrets.close();
    ledger.close();
    rmSync(base, { recursive: true, force: true });
  };
  cleanups.push(close);

  const harness: GmailArchiveHarness = {
    home, env, runtime, targets, dashboard, set, mailbox, window, build, match, labels,
    stores: { internal: internalStore, secure: secureStore },
    connectLive(providerAccountId) {
      const account = { sourceId: GMAIL_ARCHIVE_SOURCE_ID };
      placeOwnedAccount(account, env);
      if (providerAccountId !== null) recordProviderAccount(account, providerAccountId, env);
    },
    async pullLive() {
      const connector = new GoogleGmailSourceConnector({
        account: ACCOUNT,
        credentialBroker: OFFLINE_BROKER,
        apiClient: fakeGmail(mailbox),
        maxMessages: 100,
        build,
        scope: {
          ...(window.contentAfterMs !== undefined ? { contentAfterMs: window.contentAfterMs } : {}),
          storedItem: (providerItemId) => {
            const identity = { family: 'email' as const, provider: 'gmail', accountScope: ACCOUNT, providerItemId, localItemId: `${ACCOUNT}:${providerItemId}` };
            const copies = [internalStore.itemStoredContent(identity), secureStore.itemStoredContent(identity)].filter((copy) => copy !== undefined);
            return copies.length === 0 ? undefined : { hasContent: copies.some((copy) => copy!.chunkCount > 0) };
          },
        },
      });
      set.store('secure_local', { create: true });
      const cursor = set.committedCursor(connector.id)?.cursor ?? undefined;
      await set.sync(connector, { ...gmailLaneSyncOptions(), maxItems: 100, ...(cursor ? { cursor } : {}) });
    },
    liveReader(options = {}) {
      return new GoogleGmailSourceConnector({
        account: ACCOUNT,
        credentialBroker: OFFLINE_BROKER,
        apiClient: fakeGmail(mailbox),
        maxMessages: 100,
        build,
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.beforeEachRequest ? { beforeEachRequest: options.beforeEachRequest } : {}),
      });
    },
    syncHandler(options = {}) {
      return createGmailConnectorStoreSyncHandler({
        internalStore,
        secureStore,
        tierSet: set,
        account: ACCOUNT,
        credentialBroker: OFFLINE_BROKER,
        apiClient: fakeGmail(mailbox),
        env: {},
        build,
        scope: options.scope ?? {},
        scopeApproval: { generation: 'g'.repeat(64), revision: 'rev-1' },
        ...(options.assertScopeCurrent ? { assertScopeCurrent: options.assertScopeCurrent } : {}),
      });
    },
    writeExport(name, text) {
      const path = join(exports, name);
      writeFileSync(path, text);
      return path;
    },
    approve(name, text, answer = {}) {
      return approveStaged(dashboard, harness.writeExport(name, text), answer);
    },
    async importAll(archiveId, pull = {}) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const outcome = await pullArchiveImport({ state: runtime.state, archiveId, targets, media: runtime.media, ...pull });
        if (!outcome.continueSoon) return outcome;
      }
      throw new Error('the import did not finish');
    },
    rows() {
      const found: ReturnType<GmailArchiveHarness['rows']> = [];
      for (const [domain, path] of [['internal', internalPath], ['secure_local', securePath]] as const) {
        if (!existsSync(path)) continue;
        const db = new Database(path, { readonly: true });
        try {
          const rows = db.query(`
            SELECT i.provider_item_id AS id, i.tombstoned AS tombstoned, i.parent_local_item_id AS parent,
              (SELECT COUNT(*) FROM chunks c WHERE c.item_pk = i.item_pk) AS chunks
            FROM items i WHERE i.account_scope = ? ORDER BY i.item_pk
          `).all(ACCOUNT) as Array<{ id: string; tombstoned: number; parent: string | null; chunks: number }>;
          for (const row of rows) found.push({ ...row, domain });
        } finally {
          db.close();
        }
      }
      return found;
    },
    locatorOf(providerItemId) {
      for (const store of [internalStore, secureStore]) {
        const state = store.deferredBytesStateOfLocalItem(`${ACCOUNT}:${providerItemId}`);
        if (state.state === 'ready') return state.locator;
      }
      return undefined;
    },
    textOf(providerItemId) {
      return [internalStore, secureStore].flatMap((store) => store.localContent(`${ACCOUNT}:${providerItemId}`)?.chunks ?? []).join(' ');
    },
    close,
  };
  return harness;
}
