// Review of PR #76 (critical, 2026-09-23): data loss on approval or narrowing,
// endless re-reads of a dormant mailbox, "always Private" not enforced, label
// skips by id, picker budget isolation, no-op saves and the month-end cutoff.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  approveMailSourceScope,
  compileGmailMailScope,
  defaultMailScopeSelection,
  forgetMailSourceScopeApproval,
  mailScopeContentAfter,
  readMailSourceScopeApproval,
  type MailScopeSelection,
} from '../src/core/mail-source-scope.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';
import type { SourceConnectorListPage, RawItem } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { planStoreEmbedding } from '../src/workers/connector-store/embedding-plan.ts';
import { automaticTierMoveOptions, automaticTierMovesAllowed } from '../src/workers/connector-store/tier-auto-move.ts';
import { moveTieredItem, TIER_MOVE_CONNECTOR_ID } from '../src/workers/connector-store/tier-move.ts';
import { createLaneTieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { storeEmbeddingScope } from '../src/workers/engine/runtime/embedding-providers.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  GoogleGmailSourceConnector,
  createGmailConnectorStoreSyncHandler,
  encodeGmailStoreCheckpoint,
  gmailCursorConnectorId,
} from '../src/workers/google-connectors/index.ts';
import type {
  GmailApiClient,
  GmailConnectorScope,
  GmailGetMessageOptions,
  GmailListMessagesRequest,
  GmailMessage,
} from '../src/workers/google-connectors/gmail.ts';
import {
  createGmailMailScopeBrowser,
  createGmailPickerRequestBudget,
  GMAIL_PICKER_DAILY_REQUEST_BUDGET,
} from '../src/workers/google-connectors/gmail-scope-browser.ts';
import { GoogleDailyRequestBudget } from '../src/workers/google-connectors/request-budget.ts';
import { FileSourceScopeAuthority, gmailConnectorScopeFromApproval, scopeBoundSchedulerSource, type MailSourceScopePolicyRef } from '../src/workers/source-scope-runtime.ts';
import { promotedWatermark } from '../src/workers/google-connectors/gmail.ts';
import { MAX_FROM_HEADER_CHARS, ownerSenderRuleMatches, senderAddress, senderMatchesRule } from '../src/core/sender-rules.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { mailScopeOwnerTierRules } from '../src/core/mail-source-scope.ts';
import { closeSqliteStore } from '../src/core/sqlite-store.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { createGmailConnectorStoreSchedulerSource, SourceScheduler, withEmbeddingSweep } from '../src/workers/source-scheduler.ts';
import { defaultGmailLiveSyncConfig } from '../src/workers/google-connectors/gmail-live-control.ts';
import { googleAccountIdFromAddress } from '../src/core/provider-account-identity.ts';
import { createTestClock, type TestClock } from './helpers/test-clock.ts';
import { accountBoundSchedulerSource, createSourceAccountGuard } from '../src/workers/source-account-guard.ts';
import { createStandBack } from '../src/workers/engine/stand-back.ts';
import { defaultConfig } from '../src/core/config.ts';

const OFFLINE_BROKER = { async issueSession() { throw new Error('Unexpected credential request in offline Gmail fixture'); } } as unknown as CredentialBroker;

const NOW = new Date('2026-09-23T12:00:00.000Z');
const DAY = 86_400_000;
const tempDirs: string[] = [];
const openStores: LocalConnectorStore[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-mail-scope-fix-'));
  tempDirs.push(dir);
  return dir;
}

function fileStores(dir: string) {
  const internalStore = new LocalConnectorStore({
    dbPath: join(dir, 'internal.sqlite'), corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, family: 'email', trustDomain: 'internal',
  });
  const secureStore = new LocalConnectorStore({
    dbPath: join(dir, 'secure.sqlite'), corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID, family: 'email', trustDomain: 'secure_local',
  });
  openStores.push(internalStore, secureStore);
  return { internalStore, secureStore };
}

/** Fresh random vectors on every call, so any re-embed changes the stored bytes. */
function recordingProvider(backend: 'cloud' | 'local', inputs: string[] = []): SourceEmbeddingProvider {
  return {
    provider: backend === 'cloud' ? 'cloud-test' : 'local-test',
    backend,
    modelId: `${backend}-test-model`,
    dimension: 2,
    configHash: `${backend}-config`,
    epochId: `${backend}-epoch`,
    async embed(batch: readonly unknown[]) {
      inputs.push(...batch.map((entry) => JSON.stringify(entry)));
      return batch.map(() => [Math.random(), Math.random()]);
    },
  } as SourceEmbeddingProvider;
}

function readDb<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    closeSqliteStore(db, { checkpoint: false });
  }
}

const vectors = (path: string) => readDb(path, (db) =>
  (db.query('SELECT chunk_pk, embedding FROM chunk_embeddings ORDER BY chunk_pk').all() as Array<{ chunk_pk: number; embedding: Uint8Array }>)
    .map((row) => ({ chunk_pk: row.chunk_pk, embedding: Buffer.from(row.embedding).toString('hex') })));
const chunkCount = (path: string) => readDb(path, (db) => (db.query('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n);

const identity = (id: string) => ({
  family: 'email' as const, provider: 'gmail', accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}`,
});

// Persisted key used by ordinary scoped ingestion and both pre-v3 walks.
function legacyOwnerId(scope: { generation: string; revision: string }): string {
  const digest = createHash('sha256').update(['personal', scope.generation, scope.revision].join('\0')).digest('hex');
  return `gmail.scope.${digest.slice(0, 24)}`;
}

function laneFor(
  stores: ReturnType<typeof fileStores>,
  client: FakeClient,
  input: { scope?: GmailConnectorScope; revision?: string; internal: SourceEmbeddingProvider; secure: SourceEmbeddingProvider },
) {
  return createGmailConnectorStoreSyncHandler({
    ...stores,
    account: 'personal',
    credentialBroker: OFFLINE_BROKER, apiClient: client,
    env: {},
    internalEmbeddingProvider: input.internal,
    secureEmbeddingProvider: input.secure,
    ...(input.scope ? { scope: input.scope, scopeApproval: { generation: 'g'.repeat(64), revision: input.revision ?? 'rev-1' } } : {}),
  });
}

describe('no existing embeddings are thrown away by a scope', () => {
  test('a finished approval gets a separate resumable confirmation walk after upgrade, beyond the ordinary list-page cap', async () => {
    const stores = fileStores(tempDir());
    const mails = Array.from({ length: 80 }, (_, index) => {
      const mail = message(`retained-${index}`, NOW.getTime() - 10 * DAY);
      mail.payload!.headers = mail.payload!.headers!.map(header => header.name === 'From' ? { ...header, value: 'doctor@clinic.example' } : header);
      return mail;
    });
    const client = fakeClient(mails);
    // One item per provider page makes this exceed the 50-page per-run cap
    // without an enormous fixture. A durable continuation must reach page 80.
    client.listMessages = async request => {
      client.queries.push(request.query);
      const after = /after:(\d+)/.exec(request.query ?? '')?.[1];
      const before = /before:(\d+)/.exec(request.query ?? '')?.[1];
      const eligible = mails.filter(mail => (!after || Number(mail.internalDate) > Number(after) * 1_000) && (!before || Number(mail.internalDate) < Number(before) * 1_000));
      const offset = Number(request.pageToken ?? 0);
      return { messages: eligible.slice(offset, offset + 1).map(mail => ({ id: mail.id })), ...(offset + 1 < eligible.length ? { nextPageToken: String(offset + 1) } : {}) };
    };
    const scope = gmailConnectorScopeFromApproval({ mailScope: withCutoff({ alwaysPrivateSenders: ['@clinic.example'] }) });
    const common = { ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {}, scope, now: () => NOW.getTime() };
    const finish = async (lane: ReturnType<typeof createGmailConnectorStoreSyncHandler>) => {
      let checkpoint: string | null = null;
      for (let pass = 0; pass < 200; pass++) {
        const result = await lane.pull({ max_items: 100, ...(checkpoint ? { checkpoint } : {}) });
        checkpoint = result.checkpoint;
        if (result.receipt.counts.traversal_complete === 1) return;
      }
      throw new Error('ordinary traversal did not finish');
    };
    await finish(createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: { generation: 'account', revision: 'R1' } }));
    const scopeApproval = { generation: 'account', revision: 'R2' };
    await finish(createGmailConnectorStoreSyncHandler({ ...common, scopeApproval }));
    const currentId = gmailCursorConnectorId('personal', scopeApproval);
    expect(stores.secureStore.itemOwnerPresent(identity('retained-79'), currentId, 'observed')).toBe(false);
    const formatsBefore = client.formats.length;
    let checkpoint: string | undefined;
    let confirmations = 0;
    for (let pass = 0; pass < 100; pass++) {
      // Re-create the handler/task on every pass: only stored ownership and
      // the scheduler checkpoint survive a worker restart.
      const lane = createGmailConnectorStoreSyncHandler({ ...common, scopeApproval });
      const task = createGmailConnectorStoreSchedulerSource({ config: defaultConfig(), sync: lane })!.tasks.find(task => task.id === 'gmail.email_private_scope_confirmation_v1')!;
      const before = client.formats.length;
      const result = await task.run({ sourceId: 'gmail.email', corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, taskId: task.id, attemptedAt: NOW.toISOString(), consecutiveFailures: 0, effectiveIntervalMs: 60_000, ...(checkpoint ? { checkpoint } : {}) });
      expect(client.formats.length - before).toBeLessThanOrEqual(32);
      confirmations += result.counts?.private_scope_confirmed ?? 0;
      checkpoint = result.checkpoint ?? undefined;
      if (!result.continueSoon) break;
    }
    expect(confirmations).toBe(80);
    expect(stores.secureStore.itemOwnerPresent(identity('retained-79'), currentId, 'observed')).toBe(true);
    expect(client.formats.slice(formatsBefore)).toHaveLength(80);
    expect(client.formats.slice(formatsBefore).every(format => format === 'metadata')).toBe(true);
    const lane = createGmailConnectorStoreSyncHandler({ ...common, scopeApproval });
    expect(await lane.confirmPrivateScope!({ ...(checkpoint ? { checkpoint } : {}) })).toMatchObject({ confirmed: 0, done: true });
    expect(client.formats.slice(formatsBefore)).toHaveLength(80);
    const renewed = createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: { generation: 'reconnected-account', revision: 'R3' } });
    const renewedId = gmailCursorConnectorId('personal', { generation: 'reconnected-account', revision: 'R3' });
    // Neither R2's completion marker nor its page cursor may skip R3's walk.
    const restarted = await renewed.confirmPrivateScope!({ ...(checkpoint ? { checkpoint } : {}) });
    expect(restarted).toMatchObject({ confirmed: 32, done: false });
    expect(restarted.checkpoint).toBeTruthy();
    expect(client.formats.slice(formatsBefore)).toHaveLength(112);
    expect(stores.secureStore.itemOwnerPresent(identity('retained-31'), renewedId, 'observed')).toBe(true);
    expect(stores.secureStore.itemOwnerPresent(identity('retained-32'), renewedId, 'observed')).toBe(false);
    const list = client.listMessages;
    client.listMessages = async request => {
      if (request.pageToken) throw new Error('Gmail API request failed (400): page token expired');
      return list(request);
    };
    const rejected = await renewed.confirmPrivateScope!({ checkpoint: restarted.checkpoint! });
    expect(rejected).toMatchObject({ confirmed: 0, confirmedTotal: 32, done: false, cursorRejected: true });
    expect(client.formats.slice(formatsBefore)).toHaveLength(112);
    client.listMessages = list;
    // Replay skips the 32 durable confirmations. The 50-page cap leaves room
    // for 18 new metadata reads, then a checkpoint resumes the remaining 30.
    const replayed = await renewed.confirmPrivateScope!({ checkpoint: rejected.checkpoint! });
    expect(replayed).toMatchObject({ confirmed: 18, done: false });
    expect(replayed.checkpoint).toBeTruthy();
    expect(client.formats.slice(formatsBefore)).toHaveLength(130);
    expect(stores.secureStore.itemOwnerPresent(identity('retained-49'), renewedId, 'observed')).toBe(true);
    expect(stores.secureStore.itemOwnerPresent(identity('retained-50'), renewedId, 'observed')).toBe(false);
    const resumed = createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: { generation: 'reconnected-account', revision: 'R3' } });
    const completed = await resumed.confirmPrivateScope!({ checkpoint: replayed.checkpoint! });
    expect(completed).toMatchObject({ confirmed: 30, confirmedTotal: 80, done: true });
    expect(stores.secureStore.itemOwnerPresent(identity('retained-79'), renewedId, 'observed')).toBe(true);
    expect(client.formats.slice(formatsBefore)).toHaveLength(160);
    expect(client.formats.slice(formatsBefore).every(format => format === 'metadata')).toBe(true);
    expect(await resumed.confirmPrivateScope!({ checkpoint: completed.checkpoint! })).toMatchObject({ confirmed: 0, done: true });
    expect(client.formats.slice(formatsBefore)).toHaveLength(160);
  }, 30_000);

  test('current-scope confirmation makes retained Private mail eligible without rewriting bodies or vectors; fresh skip rules still win', async () => {
    const stores = fileStores(tempDir());
    const mails = ['allowed', 'skip-sender', 'skip-label', 'older'].map((id, index) => {
      const mail = message(id, NOW.getTime() - (index === 3 ? 3 * 365 : 10) * DAY);
      mail.payload!.headers = mail.payload!.headers!.map(header => header.name === 'From'
        ? { ...header, value: `${id}@clinic.example` }
        // Date headers do not decide the approved receipt-time window.
        : id === 'allowed' && header.name === 'Date' ? { ...header, value: 'Sat, 01 Jan 2000 00:00:00 GMT' } : header);
      return mail;
    });
    const client = fakeClient(mails);
    const baseScope = gmailConnectorScopeFromApproval({ mailScope: withCutoff({ alwaysPrivateSenders: ['@clinic.example'] }) });
    const oldScope = { ...baseScope, contentAfterMs: NOW.getTime() - 5 * 365 * DAY };
    const old = createGmailConnectorStoreSyncHandler({ ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {}, scope: oldScope, scopeApproval: { generation: 'old-generation', revision: 'old-revision' } });
    let pulled = await old.pull({ max_items: 50 });
    if (pulled.checkpoint) await old.pull({ max_items: 50, checkpoint: pulled.checkpoint });
    const before = stores.secureStore.exportItemCopy(identity('allowed'))!;
    mails[2]!.labelIds = ['Label_renamed'];
    const scopeApproval = { generation: 'new-generation', revision: 'new-revision' };
    const current = createGmailConnectorStoreSyncHandler({ ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {}, scope: { ...baseScope, skipSenders: ['skip-sender@clinic.example'], skippedLabelIds: ['Label_renamed'] }, scopeApproval });
    const getsBefore = client.formats.length;
    pulled = await current.pull({ max_items: 50 });
    if (pulled.checkpoint) await current.pull({ max_items: 50, checkpoint: pulled.checkpoint });
    expect(client.formats).toHaveLength(getsBefore);
    expect(await current.confirmPrivateScope!()).toMatchObject({ confirmed: 1, done: true });
    expect(client.formats.slice(getsBefore).every(format => format === 'metadata')).toBe(true);
    const after = stores.secureStore.exportItemCopy(identity('allowed'))!;
    expect(after.columns).toEqual(before.columns);
    expect(after.chunks).toEqual(before.chunks);
    expect(after.vectors).toEqual(before.vectors);
    const currentId = gmailCursorConnectorId('personal', scopeApproval);
    expect(stores.secureStore.itemOwnerPresent(identity('allowed'), currentId, 'observed')).toBe(true);
    for (const id of ['skip-sender', 'skip-label', 'older']) expect(stores.secureStore.itemOwnerPresent(identity(id), currentId, 'observed')).toBe(false);
    const inputs: string[] = [];
    const provider = { ...recordingProvider('local', inputs), provider: 'built-in' };
    const task = withEmbeddingSweep([{ sourceId: 'gmail.email', corpusId: stores.secureStore.corpusId, cadence: 'continuous', intervalMs: 1_000, freshnessThresholdHours: 1, tasks: [] }], () => () => [{ store: stores.secureStore, provider, wholeStore: true, accountScope: 'personal', filters: { provider: 'gmail', observedConnectorId: currentId } }])[0]!.tasks[0]!;
    expect(await task.run()).toMatchObject({ counts: { chunks_embedded: 1 } });
    expect(inputs.join('')).toContain('Body of allowed');
    expect(inputs.join('')).not.toContain('Body of skip-');
    expect(inputs.join('')).not.toContain('Body of older');
  });

  test.each([
    ['the first approval of an already-ingested mailbox', undefined, 2],
    ['a 5-year to 2-year narrowing', 5, 2],
  ] as const)('%s keeps chunks and byte-identical vectors of mail now outside the window', async (_name, fromYears, toYears) => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const client = fakeClient([
      message('recent', NOW.getTime() - 10 * DAY),
      message('old', NOW.getTime() - 3 * 365 * DAY),
    ]);
    const internal = recordingProvider('cloud');
    const secure = recordingProvider('local');
    const cutoff = (years: number) => NOW.getTime() - years * 365 * DAY;

    // Before: both messages stored with their bodies and embedded.
    const wide = laneFor(stores, client, {
      ...(fromYears ? { scope: { contentAfterMs: cutoff(fromYears) }, revision: 'rev-wide' } : {}),
      internal, secure,
    });
    const first = await wide.pull({ max_items: 50 });
    if (first.checkpoint) await wide.pull({ max_items: 50, checkpoint: first.checkpoint });
    const internalPath = join(dir, 'internal.sqlite');
    expect(stores.internalStore.itemStoredContent(identity('old'))).toMatchObject({ chunkCount: 1 });
    const chunksBefore = chunkCount(internalPath);
    const before = vectors(internalPath);
    expect(before.length).toBe(chunksBefore);
    expect(chunksBefore).toBeGreaterThan(0);

    // After: the narrower revision's fresh traversal, both legs.
    const getsBefore = client.formats.length;
    const narrow = laneFor(stores, client, { scope: { contentAfterMs: cutoff(toYears) }, revision: 'rev-narrow', internal, secure });
    const contentLeg = await narrow.pull({ max_items: 50 });
    expect(contentLeg.checkpoint).toBeTruthy();
    await narrow.pull({ max_items: 50, checkpoint: contentLeg.checkpoint! });

    expect(stores.internalStore.itemStoredContent(identity('old'))).toMatchObject({ chunkCount: 1 });
    expect(chunkCount(internalPath)).toBe(chunksBefore);
    expect(vectors(internalPath)).toEqual(before);
    // Held mail is not even fetched again: no provider get, no body-less re-observation.
    expect(client.formats.length).toBe(getsBefore);
  });

  test('widening the window still upgrades mail held only as metadata', async () => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const client = fakeClient([message('old', NOW.getTime() - 3 * 365 * DAY)]);
    const internal = recordingProvider('cloud');
    const secure = recordingProvider('local');
    const narrow = laneFor(stores, client, { scope: { contentAfterMs: NOW.getTime() - 2 * 365 * DAY }, revision: 'rev-2y', internal, secure });
    const leg = await narrow.pull({ max_items: 50 });
    await narrow.pull({ max_items: 50, checkpoint: leg.checkpoint! });
    expect(stores.internalStore.itemStoredContent(identity('old'))).toMatchObject({ chunkCount: 0 });

    await laneFor(stores, client, { scope: { contentAfterMs: NOW.getTime() - 5 * 365 * DAY }, revision: 'rev-5y', internal, secure })
      .pull({ max_items: 50 });
    expect(stores.internalStore.itemStoredContent(identity('old'))).toMatchObject({ chunkCount: 1 });
  });
});

async function retainedPersonalMail(options: { sameIdentity?: boolean; legacyUnscoped?: boolean; bodyOnlyCode?: boolean } = {}) {
  const dir = tempDir();
  const stores = fileStores(dir);
  let connectedAt = NOW.toISOString();
  const authority = new FileSourceScopeAuthority({
    registryPath: join(dir, 'handles.json'),
    readRegistry: () => ({ version: 1, handles: [{
      handle: 'gmail.personal', provider: 'gmail', accountRole: 'personal', scopes: [],
      allowedCapabilities: ['gmail.email.sync'], connectedAt,
    }] }),
  });
  const approve = (skippedLabels: MailScopeSelection['skippedLabels'] = []) => {
    const state = authority.mailSnapshot();
    authority.approveMail({ accountGeneration: state.accountGeneration!, expectedRevision: state.revision,
      scope: { ...defaultMailScopeSelection(), window: 'all', skippedLabels } });
    return authority.mailPolicyRef()!;
  };
  const mail = message('retained', NOW.getTime() - DAY);
  if (options.bodyOnlyCode) mail.payload!.body!.data = Buffer.from('Use 123456. This code expires in 5 minutes.').toString('base64url');
  const client = fakeClient([mail]);
  const inputs: string[] = [];
  const personal = { ...recordingProvider('local'), provider: 'built-in', modelId: 'fixture-personal',
    async embed(batch) { return batch.map(() => [1, 0]); },
  } satisfies SourceEmbeddingProvider;
  const privateProvider = { ...personal, modelId: options.sameIdentity ? personal.modelId : 'fixture-private',
    async embed(batch) { inputs.push(...batch.map(input => input.text)); return batch.map(() => [1, 0]); },
  } satisfies SourceEmbeddingProvider;
  const tierSet = createLaneTieredStoreSet({ ...stores, setId: 'gmail', internalEmbeddingProvider: personal, secureEmbeddingProvider: privateProvider });
  const lane = (ref?: MailSourceScopePolicyRef, env = {}) => createGmailConnectorStoreSyncHandler({
    ...stores, tierSet, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env,
    ...(ref ? {
      scope: gmailConnectorScopeFromApproval(authority.assertCurrentMail(ref)),
      scopeApproval: { generation: ref.accountGeneration, revision: ref.revision },
      assertScopeCurrent: () => { authority.assertCurrentMail(ref); },
    } : {}),
  });
  await lane(options.legacyUnscoped ? undefined : approve(), options.bodyOnlyCode ? { OLYMPUS_EMAIL_INGEST_SKIP_OTP: 'false' } : {}).pull({ max_items: 50 });
  expect(stores.internalStore.copyContentState(identity(mail.id))).toMatchObject({ chunks: 1, vectors: 1 });
  const scope = (store: LocalConnectorStore, ref: MailSourceScopePolicyRef | undefined) => storeEmbeddingScope({
    store, sourceId: 'gmail.email', scopeRef: ref, authority,
    readScope: () => ({ allowed: true, contentAllowed: true }),
    gmailAccountScope: 'personal', gmailImportAccountScope: 'personal',
  });
  const privateSweep = (ref: MailSourceScopePolicyRef | undefined) => {
    const store = stores.secureStore;
    const target = planStoreEmbedding({ store, provider: privateProvider, servedByMeaning: true, scope: scope(store, ref) })!;
    return withEmbeddingSweep([{
      sourceId: 'gmail.email', corpusId: store.corpusId, cadence: 'continuous', intervalMs: 1_000, freshnessThresholdHours: 1, tasks: [],
    }], () => () => [target])[0]!.tasks[0]!;
  };
  const move = async () => {
    const context = { localEmbeddingsOnly: () => true, embeddingLedgerPath: join(dir, 'embedding.jsonl') };
    expect(automaticTierMovesAllowed(tierSet, context)).toBe(true);
    const target = { metadataTier: 'secure', contentTier: 'secure' } as const;
    const item = identity(mail.id);
    const row = tierSet.ledger.beginMove(item, target, tierSet.ledger.getCurrent(item)!.generation);
    const result = await moveTieredItem({ set: tierSet, identity: item, target,
      ...automaticTierMoveOptions(tierSet, context), expectedGeneration: row.generation });
    expect(result).toMatchObject({ outcome: 'moved', raise: true });
    expect(stores.internalStore.copyContentState(item)).toMatchObject({ chunks: 0, vectors: 0 });
    expect(stores.secureStore.searchItems('retained', 5).map(row => row.sourceItem.providerItemId)).toEqual([mail.id]);
    return result.destinations.find(copy => copy.corpusId === stores.secureStore.corpusId);
  };
  const meaning = () => stores.secureStore.vectorSearchLane('semantically related query', privateProvider, 5);
  const reconnect = () => { connectedAt = new Date(NOW.getTime() + DAY).toISOString(); };
  return { ...stores, authority, approve, reconnect, lane, client, mail, inputs, move, meaning, privateProvider, privateSweep };
}

test('current Gmail approval follows confirmed Personal mail into Private and the Private provider restores meaning', async () => {
  const f = await retainedPersonalMail();
  const current = f.approve([{ id: 'Label_1', name: 'Family' }]);
  const connectorId = gmailCursorConnectorId('personal', { generation: current.accountGeneration, revision: current.revision });
  const formatsBefore = f.client.formats.length;
  // A deployment may already have completed the Private-only walk for this approval.
  const confirmed = await f.lane(current).confirmPrivateScope!({ checkpoint: `private-confirmation-v1:${connectorId}:done` });
  expect(await f.move()).toMatchObject({ vectorsCopied: 0, chunksToEmbed: 1 });
  expect((await f.meaning()).rows).toEqual([]);
  expect(await f.privateSweep(current).run()).toMatchObject({ counts: { chunks_embedded: 1 } });
  expect(confirmed).toMatchObject({ confirmed: 1, done: true });
  expect(f.client.formats.slice(formatsBefore)).toEqual(['metadata']);
  expect(f.inputs.join('')).toContain('Body of retained');
  expect((await f.meaning()).rows.map(row => row.sourceItem.providerItemId)).toEqual(['retained']);
});

test('a matching automatic-move vector remains searchable even before current Gmail confirmation', async () => {
  const f = await retainedPersonalMail({ sameIdentity: true });
  const current = f.approve([{ id: 'Label_1', name: 'Family' }]);
  expect(await f.move()).toMatchObject({ vectorsCopied: 1, chunksToEmbed: 0 });
  expect(await f.privateSweep(current).run()).toMatchObject({ counts: { chunks_embedded: 0 } });
  expect(f.inputs).toEqual([]);
  expect((await f.meaning()).rows.map(row => row.sourceItem.providerItemId)).toEqual(['retained']);
});

test('legacy Personal mail never covered by a Gmail approval gains no embedding permission from a move', async () => {
  const f = await retainedPersonalMail({ legacyUnscoped: true });
  f.mail.labelIds = ['Label_1'];
  const current = f.approve([{ id: 'Label_1', name: 'Family' }]);
  expect(await f.lane(current).confirmPrivateScope!()).toMatchObject({ confirmed: 0, done: true });
  expect(await f.move()).toMatchObject({ vectorsCopied: 0, chunksToEmbed: 1 });
  expect(await f.privateSweep(current).run()).toMatchObject({ counts: { chunks_embedded: 0 },
    embeddingSweep: [{ counts: { skipped_out_of_scope_chunks: 1 } }] });
  expect(f.inputs).toEqual([]);
});

test('superseding or revoking the confirming Gmail approval stops the Private sweep', async () => {
  const f = await retainedPersonalMail();
  const confirming = f.approve([{ id: 'Label_1', name: 'Family' }]);
  expect(await f.lane(confirming).confirmPrivateScope!()).toMatchObject({ confirmed: 1, done: true });
  await f.move();
  // Even a target planned before the save must recheck the binding at dispatch.
  const planned = f.privateSweep(confirming);
  const current = f.approve([{ id: 'Label_2', name: 'Work' }]);
  await planned.run();
  expect(await f.privateSweep(current).run()).toMatchObject({ counts: { chunks_embedded: 0 } });
  expect(forgetMailSourceScopeApproval(f.authority.mailStatePath, ['gmail.email'])).toBe(1);
  expect(await f.privateSweep(undefined).run()).toMatchObject({ counts: { chunks_embedded: 0 } });
  expect(f.inputs).toEqual([]);
});

test('superseding the Gmail approval after listing stops retained Personal metadata confirmation', async () => {
  const f = await retainedPersonalMail();
  const current = f.approve([{ id: 'Label_1', name: 'Family' }]);
  const formatsBefore = f.client.formats.length;
  const list = f.client.listMessages;
  f.client.listMessages = async request => {
    const page = await list(request);
    f.approve([{ id: 'Label_2', name: 'Work' }]);
    return page;
  };
  await expect(f.lane(current).confirmPrivateScope!()).rejects.toThrow('Mail scope approval is required');
  expect(f.client.formats).toHaveLength(formatsBefore);
});

test('superseding a Gmail approval after the metadata GET prevents the ownership write', async () => {
  const f = await retainedPersonalMail();
  const current = f.approve([{ id: 'Label_1', name: 'Family' }]);
  const connectorId = gmailCursorConnectorId('personal', { generation: current.accountGeneration, revision: current.revision });
  const get = f.client.getMessage;
  f.client.getMessage = async (id, request) => {
    const fetched = await get(id, request);
    expect(request?.format).toBe('metadata');
    f.approve([{ id: 'Label_2', name: 'Work' }]);
    return fetched;
  };
  await expect(f.lane(current).confirmPrivateScope!()).rejects.toThrow('Mail scope approval is required');
  expect(f.internalStore.itemOwnerPresent(identity(f.mail.id), connectorId, 'observed')).toBe(false);
  expect(f.secureStore.itemOwnerPresent(identity(f.mail.id), connectorId, 'observed')).toBe(false);
});

test('confirmation filters body-only OTPs and fails closed when a retained body cannot be read', async () => {
  const stores = fileStores(tempDir());
  const mails = ['otp', 'unavailable', 'allowed'].map(id => message(id, NOW.getTime() - DAY));
  mails[0]!.payload!.body!.data = Buffer.from('Use 123456. This code expires in 5 minutes.').toString('base64url');
  const client = fakeClient(mails);
  const common = { ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER,
    scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff() }) };
  await createGmailConnectorStoreSyncHandler({ ...common, env: { OLYMPUS_EMAIL_INGEST_SKIP_OTP: 'false' },
    scopeApproval: { generation: 'old', revision: 'old' } }).pull();
  expect(stores.internalStore.itemStoredContent(identity('otp'))?.chunkCount).toBe(1);
  expect(stores.internalStore.itemStoredContent(identity('unavailable'))?.chunkCount).toBe(1);
  const read = stores.internalStore.releaseItemChunks.bind(stores.internalStore);
  const retained = spyOn(stores.internalStore, 'releaseItemChunks').mockImplementation(
    item => item.providerItemId === 'unavailable' ? undefined : read(item),
  );
  try {
    const scopeApproval = { generation: 'new', revision: 'new' };
    const lane = createGmailConnectorStoreSyncHandler({ ...common, scopeApproval, env: {} });
    expect(await lane.confirmPrivateScope!()).toMatchObject({ confirmed: 1, done: true });
    const connectorId = gmailCursorConnectorId('personal', scopeApproval);
    expect(stores.internalStore.itemOwnerPresent(identity('allowed'), connectorId, 'observed')).toBe(true);
    for (const id of ['otp', 'unavailable']) {
      expect(stores.internalStore.itemOwnerPresent(identity(id), connectorId, 'observed')).toBe(false);
    }
    expect(client.formats).toEqual(['full', 'full', 'full', 'metadata', 'metadata', 'metadata']);
  } finally {
    retained.mockRestore();
  }
});

test('a partial version 1 walk restarts at the head and preserves ordinary ingestion observations', async () => {
  const stores = fileStores(tempDir());
  const personal = message('personal', NOW.getTime() - DAY);
  const ordinary = message('private', NOW.getTime() - DAY);
  ordinary.payload!.headers!.find(header => header.name === 'From')!.value = 'private@clinic.example';
  const client = fakeClient([personal]);
  const common = { ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {},
    scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff({ alwaysPrivateSenders: ['@clinic.example'] }) }) };
  await createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: { generation: 'old', revision: 'old' } }).pull();
  const scopeApproval = { generation: 'current', revision: 'current' };
  const oldKey = legacyOwnerId(scopeApproval);
  // Ordinary ingestion creates the original run and owner together.
  const oldClient = fakeClient([ordinary]);
  const original = Object.assign(new GoogleGmailSourceConnector({ ...common, apiClient: oldClient }), { id: oldKey });
  await stores.secureStore.syncFromConnector(original, { fetchContent: true });
  expect(oldClient.formats).toEqual(['full']);
  expect(stores.secureStore.itemStoredContent(identity('private'))?.chunkCount).toBe(1);
  const currentId = gmailCursorConnectorId('personal', scopeApproval);
  const eligible = () => stores.secureStore.itemMatchesSearchFilters('personal:private', 'personal', { observedConnectorId: currentId });
  expect(eligible()).toBe(true);
  const moved = fileStores(tempDir()).secureStore;
  moved.importItemCopy(stores.secureStore.exportItemCopy(identity('private'))!, {
    syncConnectorId: TIER_MOVE_CONNECTOR_ID, trustTier: 'S4',
  });
  expect(moved.itemMatchesSearchFilters('personal:private', 'personal', { observedConnectorId: currentId })).toBe(true);
  const partial = encodeGmailStoreCheckpoint({
    scope: `private-confirmation-v1:${oldKey}`,
    head: `gm1:${Buffer.from(JSON.stringify({ pageToken: '2' })).toString('base64url')}`,
  })!;
  const mailbox = fakeClient([ordinary, personal]);
  const lane = createGmailConnectorStoreSyncHandler({ ...common, scopeApproval, apiClient: mailbox });
  expect(await lane.confirmPrivateScope!({ checkpoint: partial })).toMatchObject({ confirmed: 1, done: true });
  expect(stores.internalStore.itemOwnerPresent(identity('personal'), currentId, 'observed')).toBe(true);
  expect(stores.secureStore.itemOwnerPresent(identity('private'), oldKey, 'observed')).toBe(true);
  expect(eligible()).toBe(true);
  expect(stores.secureStore.itemOwnerPresent(identity('private'), currentId, 'observed')).toBe(true);
  expect(mailbox.formats).toEqual(['metadata']);
});

test('the upgraded live pull honors the committed legacy watermark ahead of a single newer store run', async () => {
  const stores = fileStores(tempDir());
  const scopeApproval = { generation: 'current', revision: 'current' };
  const oldKey = legacyOwnerId(scopeApproval);
  const newKey = gmailCursorConnectorId('personal', scopeApproval);
  const tierSet = createLaneTieredStoreSet({ ...stores, setId: oldKey });
  const watermarkMs = NOW.getTime() - DAY;
  const cursor = (ms: number) => `gm1:${Buffer.from(JSON.stringify({ watermarkMs: ms })).toString('base64url')}`;
  tierSet.ledger.commitSetCursor(oldKey, oldKey, cursor(watermarkMs));
  tierSet.ledger.markListingCaughtUp(oldKey);
  // A completed single-leg run has no authority to advance the whole lane.
  await stores.secureStore.syncFromConnector({ id: newKey, family: 'email', async authenticate() {},
    async *listItems() { yield { items: [], done: true, nextCursor: cursor(NOW.getTime()) }; },
    async fetchItem() { throw new Error('no items'); }, classificationSignals() { return {}; },
  });
  expect(stores.secureStore.lastCompletedSyncRun(newKey)?.cursor).toBe(cursor(NOW.getTime()));
  const client = fakeClient([message('since-commit', watermarkMs + 3_000)]);
  const lane = createGmailConnectorStoreSyncHandler({ ...stores, tierSet, account: 'personal', apiClient: client,
    credentialBroker: OFFLINE_BROKER, env: {}, scope: {}, scopeApproval });
  await lane.pull();
  expect(client.queries[0]).toBe(`after:${watermarkMs / 1_000}`);
  expect(stores.internalStore.itemStoredContent(identity('since-commit'))?.chunkCount).toBe(1);
});

test.each([1, 2])('a v%i body-blind observation cannot authorize Private embedding before or after replay', async version => {
  const f = await retainedPersonalMail({ legacyUnscoped: true, bodyOnlyCode: true });
  const current = f.approve([{ id: 'Label_1', name: 'Family' }]);
  const approval = { generation: current.accountGeneration, revision: current.revision };
  const oldKey = legacyOwnerId(approval);
  const item = identity(f.mail.id);
  // v1 only confirmed Private copies. v2 could confirm a Personal copy before its move.
  if (version === 1) await f.move();
  (version === 1 ? f.secureStore : f.internalStore).observeStoredItemOwner(item, oldKey);
  if (version === 2) {
    expect(f.internalStore.itemMatchesSearchFilters(item.localItemId, 'personal', {
      observedConnectorId: gmailCursorConnectorId('personal', approval),
    })).toBe(false);
    await f.move();
  }
  expect(f.secureStore.itemOwnerPresent(item, oldKey, 'observed')).toBe(true);
  const scope = `private-confirmation-v${version}:${oldKey}`;
  const checkpoint = encodeGmailStoreCheckpoint({ scope, head: `${scope}:done`, confirmed: 1 })!;
  f.secureStore.queueEmbedding([item.localItemId], f.privateProvider);
  expect(await f.privateSweep(current).run()).toMatchObject({ counts: { chunks_embedded: 0 } });
  const before = f.client.formats.length;
  const lane = f.lane(current);
  const replay = await lane.confirmPrivateScope!({ checkpoint });
  expect(replay).toMatchObject({ confirmedTotal: 0, confirmed: 0, done: true });
  expect(await lane.confirmPrivateScope!({ checkpoint: replay.checkpoint! })).toMatchObject({ confirmedTotal: 0, done: true });
  expect(f.client.formats.slice(before)).toEqual(['metadata']);
  expect(f.secureStore.itemOwnerPresent(item, gmailCursorConnectorId('personal', approval), 'observed')).toBe(false);
  expect(await f.privateSweep(current).run()).toMatchObject({ counts: { chunks_embedded: 0 } });
  expect(f.inputs).toEqual([]);
});

test('confirmation alone wakes a resting Private sweep', async () => {
  const f = await retainedPersonalMail();
  const current = f.approve([{ id: 'Label_1', name: 'Family' }]);
  await f.move();
  const sweep = f.privateSweep(current);
  expect(await sweep.run()).toMatchObject({ counts: { chunks_embedded: 0 },
    embeddingSweep: [{ counts: { skipped_out_of_scope_recent_chunks: 1 } }] });
  // A second call uses the idle receipt, proving this is the same resting sweep.
  expect(await sweep.run()).toMatchObject({ embeddingSweep: [{ counts: { rested: 1 } }] });
  expect(await f.lane(current).confirmPrivateScope!()).toMatchObject({ confirmed: 1, done: true });
  expect(f.secureStore.queuedEmbeddingItemIds()).toEqual([]);
  expect(await sweep.run()).toMatchObject({ counts: { chunks_embedded: 1 }, embeddingSweep: [{ counts: { rested: 0 } }] });
  expect(f.inputs.join('')).toContain('Body of retained');
});

test('the Private sweep embeds already queued live mail before confirmed backlog', async () => {
  const f = await retainedPersonalMail();
  const current = f.approve([{ id: 'Label_1', name: 'Family' }]);
  await f.move();
  const live = message('new-live', Date.now());
  live.payload!.headers!.find(header => header.name === 'From')!.value = 'private@clinic.example';
  await createGmailConnectorStoreSyncHandler({
    internalStore: f.internalStore, secureStore: f.secureStore,
    account: 'personal', apiClient: fakeClient([live]), credentialBroker: OFFLINE_BROKER, env: {},
    scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff({ alwaysPrivateSenders: ['@clinic.example'] }) }),
    scopeApproval: { generation: current.accountGeneration, revision: current.revision },
  }).pull();
  f.secureStore.queueEmbedding([identity(live.id).localItemId], f.privateProvider);
  expect(await f.lane(current).confirmPrivateScope!()).toMatchObject({ confirmed: 1, done: true });
  expect(f.secureStore.queuedEmbeddingItemIds()).toEqual([identity(live.id).localItemId]);
  expect(await f.privateSweep(current).run()).toMatchObject({ counts: { chunks_embedded: 2 } });
  expect(f.inputs[0]).toContain('Body of new-live');
  expect(f.inputs.join('')).toContain('Body of retained');
});

function confirmationScheduler(sources: ConstructorParameters<typeof SourceScheduler>[0]['sources'], clock: TestClock, holdForAsk?: () => boolean) {
  return new SourceScheduler({
    sources, enabled: true, tickMs: 60_000, errorBackoffMs: 1_000, maxTransientRetries: 1, now: clock.date,
    setTimeoutImpl: clock.setTimeout as unknown as typeof setTimeout,
    clearTimeoutImpl: clock.clearTimeout as unknown as typeof clearTimeout,
    ...(holdForAsk ? { holdForAsk } : {}),
  });
}

test('the scheduler starts confirmation automatically when a reconnect gets its current approval', async () => {
  const f = await retainedPersonalMail();
  const first = f.approve();
  const source = (ref: MailSourceScopePolicyRef) => scopeBoundSchedulerSource({
    source: createGmailConnectorStoreSchedulerSource({ config: defaultConfig(), sync: f.lane(ref) })!,
    authority: f.authority, ref,
  });
  const clock = createTestClock(NOW.getTime());
  const scheduler = confirmationScheduler([source(first)], clock);
  await scheduler.runDueTasks();
  const confirmedId = (ref: MailSourceScopePolicyRef) => gmailCursorConnectorId('personal',
    { generation: ref.accountGeneration, revision: ref.revision });
  expect(f.internalStore.itemOwnerPresent(identity(f.mail.id), confirmedId(first), 'observed')).toBe(true);
  f.reconnect();
  expect(f.authority.mailPolicyRef()).toBeUndefined();
  scheduler.updateSources([]);
  const next = f.approve();
  expect(next.accountGeneration).not.toBe(first.accountGeneration);
  expect(f.internalStore.itemOwnerPresent(identity(f.mail.id), confirmedId(next), 'observed')).toBe(false);
  scheduler.updateSources([source(next)]);
  await scheduler.runDueTasks();
  expect(f.internalStore.itemOwnerPresent(identity(f.mail.id), confirmedId(next), 'observed')).toBe(true);
});

test.each(['matches', 'mismatches', 'reserve'] as const)('the session used by confirmation is independently mailbox-verified (%s)', async (outcome) => {
  const dir = tempDir();
  const stores = fileStores(dir);
  const registryPath = join(dir, 'handles.json');
  const expectedAddress = 'owner@example.com';
  const expected = googleAccountIdFromAddress(expectedAddress);
  const handles = gmailRegistry();
  handles.handles[0]!.providerAccountId = expected;
  writeFileSync(registryPath, JSON.stringify({ version: 1, ...handles }));
  const mail = message('retained', NOW.getTime() - DAY);
  const client = fakeClient([mail]);
  await createGmailConnectorStoreSyncHandler({ ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {} }).pull();
  let acquisitions = 0;
  const broker: CredentialBroker = {
    async issueSession(request) {
      return {
        kind: 'bearer_token', handle: request.handle, provider: 'gmail', capability: request.capability,
        token: `fixture-${++acquisitions}`,
        audit: { handle: request.handle, provider: 'gmail', capability: request.capability, scopes: [],
          outcome: 'issued', issuedAt: NOW.toISOString(), rawCredentialExposed: false },
      };
    },
  };
  const trace: string[] = [];
  const fetchFixture: typeof fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.split('/').at(-1);
    const token = new Headers(init?.headers).get('Authorization');
    trace.push(`${path} ${token}`);
    if (path === 'profile') return Response.json({ emailAddress: token === 'Bearer fixture-1' || outcome !== 'mismatches' ? expectedAddress : 'other@example.com' });
    if (path === 'tokeninfo') return Response.json({});
    if (path === 'messages') return Response.json({ messages: [{ id: mail.id }] });
    if (path === mail.id) return Response.json({ ...mail, payload: { headers: mail.payload?.headers } });
    throw new Error('Unexpected Gmail fixture request');
  }, { preconnect: fetch.preconnect });
  const guard = createSourceAccountGuard({ registryPath, sourceId: 'gmail.email', provider: 'gmail',
    handle: 'gmail.personal', capability: 'gmail.email.sync', laneHoldsItems: () => true, broker, fetch: fetchFixture });
  const budget = new GoogleDailyRequestBudget({ provider: 'Gmail', dailyRequestBudget: 10, now: () => NOW });
  if (outcome === 'reserve') for (let request = 0; request < 8; request++) budget.reserve();
  const scopeApproval = { generation: 'new', revision: 'new' };
  const lane = createGmailConnectorStoreSyncHandler({ ...stores, account: 'personal', credentialBroker: broker, env: {},
    fetch: fetchFixture, confirmationRegistryPath: registryPath, requestBudget: budget,
    scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff() }), scopeApproval });
  const guarded = accountBoundSchedulerSource({
    source: createGmailConnectorStoreSchedulerSource({ config: defaultConfig(), sync: lane })!, guard,
  });
  const attempt = guarded.tasks.find(task => task.id.includes('scope_confirmation'))!.run();
  if (outcome === 'matches') {
    await expect(attempt).resolves.toMatchObject({ counts: { private_scope_confirmed: 1 } });
    expect(budget.status().requests).toBe(4);
  } else if (outcome === 'mismatches') {
    await expect(attempt).rejects.toThrow('could not match the mailbox');
    expect(budget.status().requests).toBe(2);
  } else {
    await expect(attempt).resolves.toMatchObject({
      counts: { private_scope_confirmed_total: 0, private_scope_remaining: 1 },
      retryAt: { degradedReason: 'gmail_confirmation_live_request_reserve' },
    });
    expect(budget.status().requests).toBe(9);
  }
  expect(trace).toEqual(['profile Bearer fixture-1', 'tokeninfo Bearer fixture-1', 'profile Bearer fixture-2',
    ...(outcome === 'reserve' ? [] : ['tokeninfo Bearer fixture-2']),
    ...(outcome === 'matches' ? ['messages Bearer fixture-2', 'retained Bearer fixture-2'] : [])]);
  expect(stores.internalStore.itemOwnerPresent(identity(mail.id), gmailCursorConnectorId('personal', scopeApproval), 'observed')).toBe(outcome === 'matches');
});

test('a listed message 404 skips the message and resumes from the next page', async () => {
  const stores = fileStores(tempDir());
  const mails = ['first', 'missing', 'last'].map(id => message(id, NOW.getTime() - DAY));
  const client = fakeClient(mails);
  const common = { ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {},
    scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff() }) };
  await createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: { generation: 'old', revision: 'old' } }).pull();
  const get = client.getMessage;
  client.getMessage = async (id, request) => {
    if (id === 'missing') throw new Error('Gmail API request failed (404): message gone');
    return get(id, request);
  };
  const scopeApproval = { generation: 'new', revision: 'new' };
  const lane = createGmailConnectorStoreSyncHandler({ ...common, scopeApproval });
  const first = await lane.confirmPrivateScope!({ max_items: 1 });
  expect(first).toMatchObject({ confirmed: 1, done: false });
  const missing = await lane.confirmPrivateScope!({ max_items: 1, checkpoint: first.checkpoint! });
  expect(missing).toMatchObject({ confirmed: 0, confirmedTotal: 1, done: false });
  expect(missing.cursorRejected).toBeUndefined();
  expect(missing.checkpoint).toBeTruthy();
  expect(missing.checkpoint).not.toBe(first.checkpoint);
  expect(await lane.confirmPrivateScope!({ max_items: 1, checkpoint: missing.checkpoint! })).toMatchObject({
    confirmed: 1, confirmedTotal: 2, done: true,
  });
  const connectorId = gmailCursorConnectorId('personal', scopeApproval);
  expect(stores.internalStore.itemOwnerPresent(identity('missing'), connectorId, 'observed')).toBe(false);
  expect(stores.internalStore.itemOwnerPresent(identity('last'), connectorId, 'observed')).toBe(true);
});

test('ordinary and confirmed observations both survive later Gmail absence', async () => {
  const stores = fileStores(tempDir());
  const changes = ['excluded', 'trashed', 'deleted'];
  const retained = changes.map(change => message(`retained-${change}`, NOW.getTime() - DAY));
  const live = changes.map(change => message(`live-${change}`, NOW.getTime() - DAY));
  const mailbox = [...retained];
  const client = fakeClient(mailbox);
  const common = { ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {},
    scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff({ skippedLabels: [{ id: 'Label_1', name: 'Excluded' }] }) }) };
  await createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: { generation: 'old', revision: 'old' } }).pull();
  mailbox.push(...live);
  const scopeApproval = { generation: 'new', revision: 'new' };
  const current = createGmailConnectorStoreSyncHandler({ ...common, scopeApproval });
  expect((await current.pull()).receipt.counts.internal_items_indexed).toBe(3);
  expect(await current.confirmPrivateScope!()).toMatchObject({ confirmed: 3, done: true });
  for (const mails of [retained, live]) {
    mails[0]!.labelIds = ['Label_1'];
    mails[1]!.labelIds = ['TRASH'];
  }
  mailbox.splice(0, mailbox.length);
  // Gmail's scoped list now omits all six, including the two that were deleted.
  expect((await current.pull()).receipt.counts.internal_items_tombstoned).toBe(0);
  expect((await current.reconcile()).receipt.counts.internal_items_tombstoned).toBe(0);
  const connectorId = gmailCursorConnectorId('personal', scopeApproval);
  for (const mail of [...retained, ...live]) {
    expect(stores.internalStore.itemOwnerPresent(identity(mail.id), connectorId, 'observed')).toBe(true);
  }
});

test('an archive-owned Private copy is excluded from private_scope_remaining', async () => {
  const f = await retainedPersonalMail();
  const current = f.approve([{ id: 'Label_1', name: 'Family' }]);
  await f.move();
  const budget = new GoogleDailyRequestBudget({ provider: 'Gmail', dailyRequestBudget: 10, now: () => NOW });
  for (let request = 0; request < 10; request++) budget.reserve();
  const lane = createGmailConnectorStoreSyncHandler({
    internalStore: f.internalStore, secureStore: f.secureStore, account: 'personal',
    apiClient: f.client, credentialBroker: OFFLINE_BROKER, env: {}, requestBudget: budget,
    scope: gmailConnectorScopeFromApproval(f.authority.assertCurrentMail(current)),
    scopeApproval: { generation: current.accountGeneration, revision: current.revision },
  });
  const source = createGmailConnectorStoreSchedulerSource({ config: defaultConfig(), sync: lane })!;
  const task = source.tasks.find(task => task.id.includes('scope_confirmation'))!;
  expect((await task.run()).counts?.private_scope_remaining).toBe(1);
  f.secureStore.observeStoredItemOwner(identity(f.mail.id), 'archive.imported-mail');
  expect((await task.run()).counts?.private_scope_remaining).toBe(0);
  expect(await f.privateSweep(current).run()).toMatchObject({ counts: { chunks_embedded: 1 } });
});

test.each([
  [7, 'gmail_confirmation_live_request_reserve', 1, 2],
  [10, 'gmail_daily_api_request_guard', 0, 3],
] as const)('confirmation reports a persisted quota hold after %i previous requests (%s)', async (spend, reason, confirmed, remaining) => {
  const dir = tempDir();
  const stores = fileStores(dir);
  const clock = createTestClock(NOW.getTime());
  const options = { provider: 'Gmail', dailyRequestBudget: 10, statePath: join(dir, 'budget.sqlite'), now: clock.date };
  const budget = new GoogleDailyRequestBudget(options);
  const liveBudget = new GoogleDailyRequestBudget(options);
  for (let request = 0; request < spend; request++) liveBudget.reserve();
  const client = fakeClient(['first', 'second', 'third'].map(id => message(id, NOW.getTime() - DAY)));
  const common = { ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {},
    scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff() }) };
  await createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: { generation: 'old', revision: 'old' } }).pull();
  const formats = client.formats.length;
  const lane = createGmailConnectorStoreSyncHandler({ ...common, requestBudget: budget, scopeApproval: { generation: 'new', revision: 'new' } });
  const source = createGmailConnectorStoreSchedulerSource({ config: defaultConfig(), sync: lane })!;
  const task = source.tasks.find(task => task.id.includes('scope_confirmation'))!;
  let ask = false;
  const scheduler = confirmationScheduler([{ ...source, tasks: [task] }], clock, () => ask);
  const parked = (await scheduler.runDueTasks()).sources[0]!.tasks[0]!;
  expect(parked).toMatchObject({ degraded_reason: reason, next_run_at: '2026-09-24T00:00:00.000Z',
    last_result: { counts: { private_scope_confirmed_total: confirmed, private_scope_remaining: remaining } } });
  expect(client.formats.slice(formats)).toHaveLength(confirmed);
  if (confirmed) {
    expect(liveBudget.status().requests).toBe(9);
    liveBudget.reserve();
    expect(liveBudget.status().requests).toBe(10);
  }
  clock.set(Date.parse('2026-09-24T00:00:00.000Z'));
  ask = true;
  const heldForAsk = (await scheduler.runDueTasks()).sources[0]!.tasks[0]!;
  expect(heldForAsk.wait_reason).toBe('owner_ask');
  expect(heldForAsk.last_result).toEqual(parked.last_result);
  ask = false;
  const resumed = (await scheduler.runDueTasks()).sources[0]!.tasks[0]!;
  expect(resumed).toMatchObject({ last_result: { counts: { private_scope_confirmed_total: 3, traversal_complete: 1 } } });
  expect(client.formats.slice(formats)).toHaveLength(3);
  expect(resumed.degraded_reason).toBeUndefined();
  expect(resumed.wait_reason).toBeUndefined();
});

test.each(['live', 'ask'] as const)('a multi-page confirmation yields at a page boundary for %s', async (competingWork) => {
  const clock = createTestClock(NOW.getTime());
  const stores = fileStores(tempDir());
  const mails = ['one', 'two', 'three'].map(id => message(id, NOW.getTime() - DAY));
  const client = fakeClient(mails);
  const common = { ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {},
    scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff() }), now: clock.now };
  await createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: { generation: 'old', revision: 'old' } }).pull();
  const list = client.listMessages;
  client.listMessages = request => list({ ...request, maxResults: 1 });
  const get = client.getMessage;
  const reads: string[] = [];
  let ask = false;
  const liveConfig = { ...defaultGmailLiveSyncConfig({}), storePullIntervalMs: 10_000 };
  client.getMessage = async (id, request) => {
    reads.push(`${request?.format ?? 'full'}:${id}`);
    if (id === 'one' && request?.format === 'metadata') {
      if (competingWork === 'ask') ask = true;
      else {
        clock.set(clock.now() + liveConfig.storePullIntervalMs);
        mails.push(message('live', clock.now()));
      }
    }
    return get(id, request);
  };
  const standBack = createStandBack({ reason: () => ask ? "owner's Ask" : undefined, now: clock.now });
  const lane = createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: { generation: 'new', revision: 'new' } });
  const source = createGmailConnectorStoreSchedulerSource({ config: defaultConfig(), sync: lane, liveConfig })!;
  const scheduler = confirmationScheduler([{ ...source, tasks: source.tasks.filter(task => !task.id.includes('reconcile')) }],
    clock, () => standBack.holds('import'));
  const tick = async () => (await scheduler.runDueTasks()).sources[0]!.tasks.find(task => task.id.includes('scope_confirmation'))!;
  expect(await tick()).toMatchObject({
    wait_reason: competingWork === 'live' ? 'live_pull_due' : 'owner_ask',
    last_result: { counts: { private_scope_confirmed: 1, traversal_complete: 0 } },
  });
  expect(reads).toEqual(competingWork === 'live' ? ['metadata:one', 'full:live'] : ['metadata:one']);
  if (competingWork === 'ask') {
    clock.set(clock.now() + 5_000);
    await scheduler.runDueTasks();
    expect(reads).toEqual(['metadata:one']);
    expect(standBack.counts().import?.holding).toBe(true);
    ask = false;
  } else {
    expect(stores.internalStore.searchItems('live', 5).map(row => row.sourceItem.providerItemId)).toContain('live');
    clock.set(clock.now() + 5_000);
  }
  expect((await tick()).wait_reason).toBeUndefined();
  expect(reads.slice(-2)).toEqual(['metadata:two', 'metadata:three']);
});

test('a continuous Ask lets live mail through and confirmation runs during its 15-second share', async () => {
  const start = NOW.getTime();
  const clock = createTestClock(start);
  const stores = fileStores(tempDir());
  const mails = ['one', 'two', 'three', 'four'].map(id => message(id, start - DAY));
  const client = fakeClient(mails);
  const common = { ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {},
    scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff() }), now: clock.now };
  await createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: { generation: 'old', revision: 'old' } }).pull();
  const list = client.listMessages;
  client.listMessages = request => list({ ...request, maxResults: 1 });
  const reads: number[] = [];
  const get = client.getMessage;
  client.getMessage = (id, request) => {
    if (request?.format === 'metadata') {
      reads.push(clock.now() - start);
      clock.set(clock.now() + 5_000);
    }
    return get(id, request);
  };
  const standBack = createStandBack({ reason: () => "owner's Ask", now: clock.now });
  const lane = createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: { generation: 'new', revision: 'new' } });
  const source = createGmailConnectorStoreSchedulerSource({ config: defaultConfig(), sync: lane,
    liveConfig: { ...defaultGmailLiveSyncConfig({}), storePullIntervalMs: 30_000 } })!;
  const scheduler = confirmationScheduler([{ ...source, tasks: source.tasks.filter(task =>
    task.metadataWalkRole === 'primary' || task.id.includes('scope_confirmation')) }], clock, () => standBack.holds('import'));
  const tick = async (ms: number) => {
    clock.set(start + ms);
    return (await scheduler.runDueTasks()).sources[0]!.tasks.find(task => task.id.includes('scope_confirmation'))!;
  };
  expect((await tick(0)).wait_reason).toBe('owner_ask');
  mails.push(message('live', start + 1_000));
  expect((await tick(30_000)).wait_reason).toBe('owner_ask');
  expect(stores.internalStore.itemStoredContent(identity('live'))?.chunkCount).toBe(1);
  expect((await tick(59_999)).wait_reason).toBe('owner_ask');
  expect(reads).toEqual([]);
  const share = await tick(60_000);
  expect(clock.now() - start).toBe(75_000);
  expect(share.wait_reason).toBe('owner_ask');
  expect(share.last_result?.counts).toMatchObject({ private_scope_confirmed_total: 3, traversal_complete: 0 });
  expect(reads).toEqual([60_000, 65_000, 70_000]);
  const heldAgain = await tick(80_000);
  expect(heldAgain.wait_reason).toBe('owner_ask');
  expect(heldAgain.last_result).toEqual(share.last_result);
  expect(reads).toHaveLength(3);
});

describe('a dormant mailbox is not re-read forever', () => {
  test('a traversal with nothing newer than the cutoff completes with a watermark; the next pass fetches nothing', async () => {
    const cutoffMs = Date.parse('2024-09-23T00:00:00.000Z');
    const client = fakeClient([message('old-1', cutoffMs - 10 * DAY), message('old-2', cutoffMs - 20 * DAY)]);
    const connector = () => new GoogleGmailSourceConnector({
      credentialBroker: OFFLINE_BROKER, apiClient: client, account: 'personal', env: {}, scope: { contentAfterMs: cutoffMs }, now: () => NOW.getTime(),
    });
    const contentLeg = await collect(connector().listItems({ limit: 50 }));
    expect(contentLeg.items.map((item) => item.identity.providerItemId)).toEqual(['old-1', 'old-2']);
    expect(contentLeg.items.every((item) => item.content.kind === 'metadata_only')).toBe(true);
    expect(contentLeg.done).toBe(true);
    const metadataLeg = await collect(connector().listItems({ limit: 50, cursor: contentLeg.cursor! }));
    expect(metadataLeg.done).toBe(true);
    expect(metadataLeg.cursor).toBeDefined();
    const gets = client.formats.length;
    const second = await collect(connector().listItems({ limit: 50, cursor: metadataLeg.cursor! }));
    expect(second.items).toHaveLength(0);
    // Completed on the traversal's own start less a day (never the whole older mailbox).
    expect(client.queries.at(-1)).toBe(`after:${Math.floor((NOW.getTime() - DAY) / 1_000)}`);
    const third = await collect(connector().listItems({ limit: 50, cursor: second.cursor! }));
    expect(third.items).toHaveLength(0);
    expect(client.formats.length).toBe(gets);
  });
});

describe('"always Private" is enforced', () => {
  test('the sender\'s mail is S4, stored and embedded only in the secure store, never by the cloud embedder', async () => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const clinic: GmailMessage = {
      ...message('clinic', NOW.getTime() - DAY),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Your appointment' }, { name: 'From', value: 'Portal <portal@clinic.example>' }],
        body: { data: Buffer.from('Body of clinic.').toString('base64url') },
      },
    };
    const client = fakeClient([clinic, message('ordinary', NOW.getTime() - 2 * DAY)]);
    const cloudInputs: string[] = [];
    const privateInputs: string[] = [];
    const scope = gmailConnectorScopeFromApproval({ mailScope: withCutoff({ alwaysPrivateSenders: ['@clinic.example'] }) });
    expect(scope.ownerTierRules).toMatchObject([{ match: { kind: 'sender', value: '@clinic.example' }, tier: 'secure', strength: 'force' }]);
    const ruleId = scope.ownerTierRules![0]!.id;
    const outcome = await laneFor(stores, client, {
      scope, internal: recordingProvider('cloud', cloudInputs), secure: recordingProvider('local', privateInputs),
    }).pull({ max_items: 50 });

    expect(stores.secureStore.itemPresence(identity('clinic'))).toMatchObject({ active: true });
    expect(stores.internalStore.itemPresence(identity('clinic')).active).toBe(false);
    expect(stores.internalStore.itemPresence(identity('ordinary')).active).toBe(true);
    expect(outcome.receipt.counts.secure_chunks_embedded).toBeGreaterThan(0);
    expect(cloudInputs.join('\n')).not.toContain('Body of clinic');
    expect(privateInputs.join('\n')).toContain('Body of clinic');

    // The four-tier ledger records the owner rule as the reason, Private both layers.
    const recorded = stores.secureStore.tierLedger()?.getCurrent(identity('clinic'));
    expect(recorded).toMatchObject({ metadataTier: 'secure', contentTier: 'secure', decidedBy: 'owner_rule' });
    expect(recorded!.reasons).toContain(`metadata:owner_rule:sender:${ruleId}:force`);
    expect(recorded!.reasons.join(' ')).not.toContain('clinic');
  });
});

describe('skipped labels', () => {
  test('are enforced by label id after the fetch; system labels compile to in:', async () => {
    const tagged = { ...message('tagged', NOW.getTime() - DAY), labelIds: ['INBOX', 'Label_7'] };
    const chat = { ...message('chat', NOW.getTime() - DAY), labelIds: ['CHAT'] };
    const client = fakeClient([tagged, chat, message('plain', NOW.getTime() - 2 * DAY)]);
    const page = await collect(new GoogleGmailSourceConnector({
      credentialBroker: OFFLINE_BROKER, apiClient: client, account: 'personal', env: {}, scope: { skippedLabelIds: ['Label_7', 'CHAT'] },
    }).listItems({ limit: 50 }));
    expect(page.items.map((item) => item.identity.providerItemId)).toEqual(['plain']);
    const compiled = compileGmailMailScope(withCutoff({
      skippedCategories: [],
      skippedLabels: [{ id: 'SENT', name: 'SENT' }, { id: 'CHAT', name: 'CHAT' }, { id: 'Label_7', name: 'Renamed Label' }],
    }));
    expect(compiled.baseQuery).toBe('-in:sent -in:chats -label:"Renamed Label"');
    expect(compiled.skippedLabelIds).toEqual(['SENT', 'CHAT', 'Label_7']);
  });
});

describe('saves and cutoffs', () => {
  test('an unchanged save is a no-op; other changes keep the cutoff unless the window changes', () => {
    const statePath = join(tempDir(), 'mail-source-scopes.json');
    const registry = gmailRegistry();
    const pending = readMailSourceScopeApproval({ registry, statePath });
    const first = approveMailSourceScope({
      registry, statePath, accountGeneration: pending.accountGeneration!, expectedRevision: pending.revision,
      scope: defaultMailScopeSelection(), now: NOW,
    });
    const later = new Date(NOW.getTime() + 40 * DAY);
    const same = approveMailSourceScope({
      registry, statePath, accountGeneration: first.accountGeneration!, expectedRevision: first.revision,
      scope: defaultMailScopeSelection(), now: later,
    });
    expect(same.revision).toBe(first.revision);
    expect(same.mailScope?.contentAfter).toBe(first.mailScope?.contentAfter);
    const senders = approveMailSourceScope({
      registry, statePath, accountGeneration: first.accountGeneration!, expectedRevision: first.revision,
      scope: { ...defaultMailScopeSelection(), skipSenders: ['@spam.example'] }, now: later,
    });
    expect(senders.revision).not.toBe(first.revision);
    expect(senders.mailScope?.contentAfter).toBe(first.mailScope?.contentAfter);
    const window = approveMailSourceScope({
      registry, statePath, accountGeneration: first.accountGeneration!, expectedRevision: senders.revision,
      scope: { ...defaultMailScopeSelection(), window: '1y', skipSenders: ['@spam.example'] }, now: later,
    });
    expect(window.mailScope?.contentAfter).toBe(mailScopeContentAfter('1y', later));
  });

  test('the window cutoff clamps to the end of a shorter month', () => {
    expect(mailScopeContentAfter('6m', new Date('2026-08-31T15:00:00.000Z'))).toBe('2026-02-28T00:00:00.000Z');
    expect(mailScopeContentAfter('2y', new Date('2026-02-28T15:00:00.000Z'))).toBe('2024-02-28T00:00:00.000Z');
    expect(mailScopeContentAfter('1y', new Date('2028-02-29T15:00:00.000Z'))).toBe('2027-02-28T00:00:00.000Z');
  });
});

describe('re-review at 537f909b', () => {
  test('a held message with a future Date header cannot stop new mail from being read', async () => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const spam: GmailMessage = {
      ...message('spam', NOW.getTime() - 5 * DAY),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: 'From the future' },
          { name: 'From', value: 'Spam <spam@example.com>' },
          { name: 'Date', value: new Date('2036-01-01T00:00:00.000Z').toUTCString() },
        ],
        body: { data: Buffer.from('Body of spam.').toString('base64url') },
      },
    };
    const mailbox = [spam];
    const client = fakeClient(mailbox);
    const internal = recordingProvider('cloud');
    const secure = recordingProvider('local');
    // Held before the scope was approved, stored with its 2036 Date header.
    await laneFor(stores, client, { internal, secure }).pull({ max_items: 50 });
    expect(stores.internalStore.itemStoredContent(identity('spam'))).toMatchObject({ chunkCount: 1 });

    let clock = NOW.getTime();
    const scoped = createGmailConnectorStoreSyncHandler({
      ...stores, account: 'personal', credentialBroker: OFFLINE_BROKER, apiClient: client, env: {}, now: () => clock,
      internalEmbeddingProvider: internal, secureEmbeddingProvider: secure,
      scope: { contentAfterMs: NOW.getTime() - 2 * 365 * DAY },
      scopeApproval: { generation: 'g'.repeat(64), revision: 'rev-1' },
    });
    const contentLeg = await scoped.pull({ max_items: 50 });
    const metadataLeg = await scoped.pull({ max_items: 50, checkpoint: contentLeg.checkpoint! });
    // The completed traversal's bound sits at its own start less a day, never at 2036.
    const bound = Number(/after:(\d+)/.exec(client.queries.at(-1) ?? '')?.[1] ?? '0');
    expect(bound * 1_000).toBeLessThanOrEqual(clock);

    clock += 3_600_000;
    mailbox.push(message('fresh', clock - 60_000));
    await scoped.pull({ max_items: 50, checkpoint: metadataLeg.checkpoint! });
    const next = Number(/after:(\d+)/.exec(client.queries.at(-1) ?? '')?.[1] ?? '0');
    expect(next * 1_000).toBeLessThan(clock);
    expect(stores.internalStore.itemStoredContent(identity('fresh'))).toMatchObject({ chunkCount: 1 });
  });

  test('watermarks are capped at the clock', () => {
    expect(promotedWatermark({ highWaterMs: Date.parse('2036-01-01T00:00:00Z'), nowMs: NOW.getTime() })).toBe(NOW.getTime());
    expect(promotedWatermark({ floorMs: NOW.getTime() - DAY, cutoffMs: NOW.getTime() - 400 * DAY, nowMs: NOW.getTime() }))
      .toBe(NOW.getTime() - DAY);
    expect(promotedWatermark({ nowMs: NOW.getTime() })).toBeUndefined();
  });

  test('an @domain rule covers subdomains on a label boundary', () => {
    expect(senderMatchesRule('Appointments <appointments@mail.therapist.example>', '@therapist.example')).toBe(true);
    expect(senderMatchesRule('dr@therapist.example', '@therapist.example')).toBe(true);
    expect(senderMatchesRule('x@evil-therapist.example', '@therapist.example')).toBe(false);
    expect(senderMatchesRule('x@therapist.example.evil.com', '@therapist.example')).toBe(false);
    expect(senderMatchesRule('Dr <DR@Therapist.Example>', 'dr@therapist.example')).toBe(true);
    expect(senderMatchesRule('evildr@therapist.example', 'dr@therapist.example')).toBe(false);
  });

  test('"always Private" @domain raises subdomain senders and not look-alikes or display-name addresses', () => {
    const rules = mailScopeOwnerTierRules({ alwaysPrivateSenders: ['@therapist.example'] });
    const decide = (sender: string) => classifyItemTiers({ signals: { sender, title: 'Hello' }, provider: 'gmail' }, { rules });
    expect(decide('Appointments <appointments@mail.therapist.example>')).toMatchObject({ metadataTier: 'secure', decidedBy: 'owner_rule' });
    expect(decide('x@evil-therapist.example').decidedBy).not.toBe('owner_rule');
    // An address inside the display name is not the sender.
    expect(decide('"dr@therapist.example" <spam@evil.example>').decidedBy).not.toBe('owner_rule');
    // A bare fragment is honoured by substring only for a raising rule.
    const fragment = (tier: 'secure' | 'public') => classifyItemTiers({ signals: { sender: 'x@clinic.example' }, provider: 'gmail' }, {
      rules: [{ id: 'fragment', match: { kind: 'sender', value: 'clinic' }, tier, strength: 'force' }],
    });
    expect(fragment('secure').decidedBy).toBe('owner_rule');
    expect(fragment('public').decidedBy).not.toBe('owner_rule');
  });

  test('skip and private rules match the actual sender address only', () => {
    expect(senderMatchesRule('"news@shop.example" <spam@evil.example>', '@shop.example')).toBe(false);
    expect(senderMatchesRule('Shop <news@shop.example>', '@shop.example')).toBe(true);
    expect(senderMatchesRule('news@shop.example', '@shop.example')).toBe(true);
  });

  test('"always Private" subdomain mail goes to the secure store, never the cloud embedder', async () => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const sub: GmailMessage = {
      ...message('sub', NOW.getTime() - DAY),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Appointment' }, { name: 'From', value: 'Appointments <appointments@mail.therapist.example>' }],
        body: { data: Buffer.from('Body of sub.').toString('base64url') },
      },
    };
    const cloudInputs: string[] = [];
    await laneFor(stores, fakeClient([sub]), {
      scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff({ alwaysPrivateSenders: ['@therapist.example'] }) }),
      internal: recordingProvider('cloud', cloudInputs), secure: recordingProvider('local'),
    }).pull({ max_items: 50 });
    expect(stores.secureStore.itemStoredContent(identity('sub'))).toBeDefined();
    expect(stores.internalStore.itemStoredContent(identity('sub'))).toBeUndefined();
    expect(cloudInputs.join('\n')).not.toContain('Body of sub');
  });

  test('the skip list is re-checked after the fetch with the same domain semantics', async () => {
    const withFrom = (id: string, from: string): GmailMessage => ({
      ...message(id, NOW.getTime() - DAY),
      payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: id }, { name: 'From', value: from }], body: { data: Buffer.from(`Body of ${id}.`).toString('base64url') } },
    });
    const client = fakeClient([
      withFrom('sub', 'news@mail.shop.example'),
      withFrom('lookalike', 'news@notshop.example'),
    ]);
    const page = await collect(new GoogleGmailSourceConnector({
      credentialBroker: OFFLINE_BROKER, apiClient: client, account: 'personal', env: {}, scope: { skipSenders: ['@shop.example'] },
    }).listItems({ limit: 50 }));
    expect(page.items.map((item) => item.identity.providerItemId)).toEqual(['lookalike']);
  });
});

describe('delta review at 15d261cb: sender parsing', () => {
  const COMMENT_FORM = 'dr@therapist.example (Dr T)';
  const UNPARSEABLE = 'appointments@mail.therapist.example via Portal';

  test('common legal From forms parse to the real sender address', () => {
    expect(senderAddress(COMMENT_FORM)).toEqual({ address: 'dr@therapist.example', domain: 'therapist.example' });
    expect(senderAddress('Dr T (clinic) <DR@Therapist.Example>')?.address).toBe('dr@therapist.example');
    expect(senderAddress('"Doe, Jane (Dr)" <jane@therapist.example>')?.address).toBe('jane@therapist.example');
    expect(senderAddress('"jane doe"@therapist.example')?.address).toBe('"jane doe"@therapist.example');
    expect(senderAddress('jane@therapist.example (nested (comment))')?.address).toBe('jane@therapist.example');
    expect(senderAddress(UNPARSEABLE)).toBeUndefined();
  });

  test('a raise rule matches the comment form and falls back to every address when the sender is unparseable', () => {
    expect(ownerSenderRuleMatches(COMMENT_FORM, '@therapist.example', true)).toBe(true);
    expect(ownerSenderRuleMatches(UNPARSEABLE, '@therapist.example', true)).toBe(true);
    // No fallback for a rule that does not raise.
    expect(ownerSenderRuleMatches(UNPARSEABLE, '@therapist.example', false)).toBe(false);
    // A parsed sender is never widened: a display-name address still does not count.
    expect(ownerSenderRuleMatches('"dr@therapist.example" <spam@evil.example>', '@therapist.example', true)).toBe(false);
  });

  test('a skip rule matches the comment form but never skips an unparseable sender', () => {
    expect(senderMatchesRule(COMMENT_FORM, '@therapist.example')).toBe(true);
    expect(senderMatchesRule(UNPARSEABLE, '@therapist.example')).toBe(false);
  });

  test.each([
    ['comment form', COMMENT_FORM, 'comment'],
    ['unparseable header', UNPARSEABLE, 'unparseable'],
  ] as const)('"always Private" %s mail goes to the secure store and the ledger records the owner rule', async (_name, from, id) => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const mail: GmailMessage = {
      ...message(id, NOW.getTime() - DAY),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Appointment' }, { name: 'From', value: from }],
        body: { data: Buffer.from(`Body of ${id}.`).toString('base64url') },
      },
    };
    const cloudInputs: string[] = [];
    const scope = gmailConnectorScopeFromApproval({ mailScope: withCutoff({ alwaysPrivateSenders: ['@therapist.example'] }) });
    await laneFor(stores, fakeClient([mail]), {
      scope, internal: recordingProvider('cloud', cloudInputs), secure: recordingProvider('local'),
    }).pull({ max_items: 50 });
    expect(stores.secureStore.itemStoredContent(identity(id))).toBeDefined();
    expect(stores.internalStore.itemStoredContent(identity(id))).toBeUndefined();
    expect(cloudInputs.join('\n')).not.toContain(`Body of ${id}`);
    const recorded = stores.secureStore.tierLedger()?.getCurrent(identity(id));
    expect(recorded).toMatchObject({ metadataTier: 'secure', decidedBy: 'owner_rule' });
  });

  test.each([
    ['comment form', COMMENT_FORM, true],
    ['unparseable header', UNPARSEABLE, false],
  ] as const)('the skip list on the %s: skipped only when the sender is read', async (_name, from, skipped) => {
    const mail: GmailMessage = {
      ...message('m', NOW.getTime() - DAY),
      payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'x' }, { name: 'From', value: from }], body: { data: Buffer.from('Body.').toString('base64url') } },
    };
    const page = await collect(new GoogleGmailSourceConnector({
      credentialBroker: OFFLINE_BROKER, apiClient: fakeClient([mail]), account: 'personal', env: {}, scope: { skipSenders: ['@therapist.example'] },
    }).listItems({ limit: 50 }));
    expect(page.items).toHaveLength(skipped ? 0 : 1);
  });
});

describe('delta review at a201e996: bounded parsing and multi-author From', () => {
  const MULTI = 'Dr <dr@therapist.example>, A <a@x.example>';

  test('a 100 KB hostile From header is checked against 10 rules in under 50 ms', () => {
    const hostile = [
      'a'.repeat(100_000),
      'a@'.repeat(50_000),
      `${'x.'.repeat(50_000)}@`,
      `${'"'.repeat(20_000)}${'('.repeat(20_000)}${'<'.repeat(20_000)}@${'a.'.repeat(20_000)}`,
      // Delta review at bf39471c: long `.-` runs that do not end the string.
      `a@b${'.-'.repeat(2_040)}x`,
      `a@b${'-'.repeat(4_000)}.x`,
    ];
    const rules = Array.from({ length: 10 }, (_, index) => `@domain${index}.example`);
    for (const header of hostile) {
      const started = performance.now();
      for (const rule of rules) {
        ownerSenderRuleMatches(header, rule, true);
        senderMatchesRule(header, rule);
      }
      expect(performance.now() - started).toBeLessThan(50);
    }
    expect(senderAddress(`dr@therapist.example${' '.repeat(MAX_FROM_HEADER_CHARS)}`)).toBeUndefined();
  });

  test('more than one mailbox is unparseable: raise rules scan every address, skip rules never match', () => {
    expect(senderAddress(MULTI)).toBeUndefined();
    expect(senderAddress('dr@therapist.example, a@x.example')).toBeUndefined();
    // A comma inside a quoted display name or a comment is not a second mailbox.
    expect(senderAddress('"Doe, Jane" <jane@therapist.example>')?.address).toBe('jane@therapist.example');
    expect(senderAddress('jane@therapist.example (Doe, Jane)')?.address).toBe('jane@therapist.example');
    expect(ownerSenderRuleMatches(MULTI, '@therapist.example', true)).toBe(true);
    expect(senderMatchesRule(MULTI, '@therapist.example')).toBe(false);
    expect(senderMatchesRule(MULTI, '@x.example')).toBe(false);
  });

  test('multi-author mail from an always-Private sender goes to the secure store only and the ledger agrees', async () => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const mail: GmailMessage = {
      ...message('multi', NOW.getTime() - DAY),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Joint note' }, { name: 'From', value: MULTI }],
        body: { data: Buffer.from('Body of multi.').toString('base64url') },
      },
    };
    const cloudInputs: string[] = [];
    await laneFor(stores, fakeClient([mail]), {
      scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff({ alwaysPrivateSenders: ['@therapist.example'] }) }),
      internal: recordingProvider('cloud', cloudInputs), secure: recordingProvider('local'),
    }).pull({ max_items: 50 });
    expect(stores.secureStore.itemStoredContent(identity('multi'))).toBeDefined();
    expect(stores.internalStore.itemStoredContent(identity('multi'))).toBeUndefined();
    expect(cloudInputs.join('\n')).not.toContain('Body of multi');
    expect(stores.secureStore.tierLedger()?.getCurrent(identity('multi'))).toMatchObject({ metadataTier: 'secure', decidedBy: 'owner_rule' });
  });

  test('the stored From is capped at 4 KB', async () => {
    const huge = `x@y.example ${'z'.repeat(20_000)}`;
    const mail: GmailMessage = {
      ...message('huge', NOW.getTime() - DAY),
      payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 's' }, { name: 'From', value: huge }], body: { data: Buffer.from('b').toString('base64url') } },
    };
    const page = await collect(new GoogleGmailSourceConnector({ credentialBroker: OFFLINE_BROKER, apiClient: fakeClient([mail]), account: 'personal', env: {} }).listItems({ limit: 5 }));
    const stored = String(page.items[0]!.metadata.from);
    expect(stored.length).toBe(MAX_FROM_HEADER_CHARS + 1);
    expect(stored.endsWith('…')).toBe(true);
    // Truncated means unparseable: a skip rule never matches it.
    expect(senderAddress(stored)).toBeUndefined();
    expect(senderMatchesRule(stored, '@y.example')).toBe(false);
  });
});

describe('picker budget', () => {
  test('picker requests are charged to their own capped allowance, never to the lane budget', async () => {
    const dir = tempDir();
    const lanePath = join(dir, 'gmail-daily-request-budget.json');
    const laneBudget = new GoogleDailyRequestBudget({ provider: 'Gmail', dailyRequestBudget: 5_000, statePath: lanePath });
    const pickerBudget = createGmailPickerRequestBudget({ laneStatePath: lanePath });
    const client = fakeClient(Array.from({ length: 5 }, (_, index) => message(`m-${index}`, NOW.getTime() - index * DAY)));
    await createGmailMailScopeBrowser({
      credentialHandle: 'gmail.personal', account: 'personal', credentialBroker: OFFLINE_BROKER, apiClient: client, env: {}, requestBudget: pickerBudget,
    }).summarize({ scope: defaultMailScopeSelection(), now: NOW });
    expect(pickerBudget.status().requests).toBe(1 + 5 + 2 + 5);
    expect(pickerBudget.status().dailyRequestBudget).toBe(GMAIL_PICKER_DAILY_REQUEST_BUDGET);
    expect(GMAIL_PICKER_DAILY_REQUEST_BUDGET).toBeLessThan(5_000);
    expect(laneBudget.status().requests).toBe(0);
  });
});

function withCutoff(overrides: Partial<MailScopeSelection> = {}): MailScopeSelection {
  return { ...defaultMailScopeSelection(), contentAfter: mailScopeContentAfter('2y', NOW)!, ...overrides };
}

function gmailRegistry() {
  return {
    handles: [{
      handle: 'gmail.personal',
      provider: 'gmail',
      allowedCapabilities: ['gmail.email.sync'],
      connectedAt: '2026-09-23T10:00:00.000Z',
      accountRole: 'personal',
      providerAccountId: 'account-gmail',
    }],
  };
}

interface FakeClient extends GmailApiClient {
  queries: Array<string | undefined>;
  formats: string[];
}

function fakeClient(messages: GmailMessage[]): FakeClient {
  const client: FakeClient = {
    queries: [],
    formats: [],
    async listMessages(request: GmailListMessagesRequest) {
      client.queries.push(request.query);
      const after = /after:(\d+)/.exec(request.query ?? '')?.[1];
      const before = /before:(\d+)/.exec(request.query ?? '')?.[1];
      const eligible = messages.filter((entry) => {
        const at = Number(entry.internalDate);
        return (!after || at > Number(after) * 1_000) && (!before || at < Number(before) * 1_000);
      });
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = eligible.slice(offset, offset + request.maxResults);
      return {
        messages: slice.map((entry) => ({ id: entry.id })),
        ...(offset + slice.length < eligible.length ? { nextPageToken: String(offset + slice.length) } : {}),
        resultSizeEstimate: eligible.length,
      };
    },
    async getMessage(id: string, request?: GmailGetMessageOptions) {
      client.formats.push(request?.format ?? 'full');
      const found = messages.find((entry) => entry.id === id);
      if (!found) throw new Error(`Gmail API request failed (404): unknown ${id}`);
      return request?.format === 'metadata' ? { ...found, payload: { headers: found.payload?.headers ?? [] } } : found;
    },
    async listLabels() {
      return [{ id: 'Label_1', name: 'Family', type: 'user' as const }];
    },
    async getLabel(id: string) {
      return { id, name: id, type: 'system' as const, messagesTotal: 100 };
    },
  };
  return client;
}

function message(id: string, internalDateMs: number): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    historyId: '1000',
    internalDate: String(internalDateMs),
    labelIds: ['INBOX'],
    snippet: `Snippet of ${id}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: `Subject ${id}` },
        { name: 'From', value: 'Alex <alex@example.com>' },
        { name: 'Date', value: new Date(internalDateMs).toUTCString() },
      ],
      body: { data: Buffer.from(`Body of ${id}.`).toString('base64url') },
    },
  };
}

async function collect(pages: AsyncIterable<SourceConnectorListPage>) {
  const items: RawItem[] = [];
  let cursor: string | undefined;
  let done = false;
  for await (const page of pages) {
    items.push(...page.items);
    cursor = page.nextCursor;
    done = page.done;
  }
  return { items, cursor, done };
}

describe('a reconnect that lands mid-task stops the Gmail traversal before any store write', () => {
  // Independent review round 4 on the account-binding change: the task-entry
  // scope check alone let a reconnect between that check and the connector's
  // own token request list the new account's mailbox into the old stores.
  function scopedLane(stores: ReturnType<typeof fileStores>, client: FakeClient, assertScopeCurrent: () => void) {
    return createGmailConnectorStoreSyncHandler({
      ...stores,
      account: 'personal',
      credentialBroker: OFFLINE_BROKER, apiClient: client,
      env: {},
      internalEmbeddingProvider: recordingProvider('cloud'),
      secureEmbeddingProvider: recordingProvider('local'),
      scope: { contentAfterMs: NOW.getTime() - 365 * DAY },
      scopeApproval: { generation: 'g'.repeat(64), revision: 'rev-1' },
      assertScopeCurrent,
    });
  }

  test('a superseded approval refuses the provider answer; nothing is stored', async () => {
    const stores = fileStores(tempDir());
    const client = fakeClient([message('from-new-account', NOW.getTime() - 10 * DAY)]);
    let reconnected = false;
    const lane = scopedLane(stores, client, () => {
      if (reconnected) throw new Error('source scope approval is no longer current');
    });
    reconnected = true;
    await expect(lane.sync()).rejects.toThrow('no longer current');
    expect(stores.internalStore.holdsAnyItem()).toBe(false);
    expect(stores.secureStore.holdsAnyItem()).toBe(false);
  });

  test('a current approval stores as before', async () => {
    const stores = fileStores(tempDir());
    const client = fakeClient([message('same-account', NOW.getTime() - 10 * DAY)]);
    const lane = scopedLane(stores, client, () => {});
    await lane.sync();
    expect(stores.internalStore.holdsAnyItem() || stores.secureStore.holdsAnyItem()).toBe(true);
  });
});
