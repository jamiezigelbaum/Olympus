// Review of PR #76 (critical, 2026-09-23): data loss on approval or narrowing,
// endless re-reads of a dormant mailbox, "always Private" not enforced, label
// skips by id, picker budget isolation, no-op saves and the month-end cutoff.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  approveMailSourceScope,
  compileGmailMailScope,
  defaultMailScopeSelection,
  mailScopeContentAfter,
  readMailSourceScopeApproval,
  type MailScopeSelection,
} from '../src/core/mail-source-scope.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';
import type { SourceConnectorListPage, RawItem } from '../src/core/contracts.ts';
import { SourceScopeApprovalRequiredError } from '../src/core/operation-error.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { planStoreEmbedding, scopedEmbeddingOptions } from '../src/workers/connector-store/embedding-plan.ts';
import { automaticTierMoveOptions, automaticTierMovesAllowed } from '../src/workers/connector-store/tier-auto-move.ts';
import { moveTieredItem, TIER_MOVE_CONNECTOR_ID } from '../src/workers/connector-store/tier-move.ts';
import { createLaneTieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { storeEmbeddingScope } from '../src/workers/engine/runtime/embedding-providers.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  GoogleGmailSourceConnector,
  createGmailConnectorStoreSyncHandler,
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
import { gmailChildProviderId } from '../src/workers/google-connectors/gmail-mail-record.ts';
import { GoogleDailyRequestBudget } from '../src/workers/google-connectors/request-budget.ts';
import { FileSourceScopeAuthority, gmailConnectorScopeFromApproval, type MailSourceScopePolicyRef } from '../src/workers/source-scope-runtime.ts';
import { promotedWatermark } from '../src/workers/google-connectors/gmail.ts';
import { MAX_FROM_HEADER_CHARS, ownerSenderRuleMatches, senderAddress, senderMatchesRule } from '../src/core/sender-rules.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { mailScopeOwnerTierRules } from '../src/core/mail-source-scope.ts';
import { closeSqliteStore } from '../src/core/sqlite-store.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { withEmbeddingSweep } from '../src/workers/source-scheduler.ts';

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

test.each(['TRASH', 'CATEGORY_PROMOTIONS', 'Label_1', 'older', 'undated'])('a first full GET with %s cannot admit a body or child', async excluded => {
  const dir = tempDir();
  const stores = fileStores(dir);
  const cutoff = NOW.getTime() - 2 * DAY;
  const mail = attachmentMessage('listed-in-inbox', NOW.getTime() - DAY);
  const client = fakeClient([mail]);
  const get = client.getMessage;
  client.getMessage = (id, request) => {
    if (excluded === 'older') mail.internalDate = String(cutoff - DAY);
    else if (excluded === 'undated') delete mail.internalDate;
    else mail.labelIds = [excluded];
    return get(id, request);
  };
  const inputs: string[] = [];
  const lane = createGmailConnectorStoreSyncHandler({
    ...stores, apiClient: client, credentialBroker: OFFLINE_BROKER, account: 'personal', env: {}, build: { children: true },
    scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff({
      contentAfter: new Date(cutoff).toISOString(),
      skippedLabels: [{ id: 'Label_1', name: 'Excluded' }],
      alwaysPrivateSenders: ['alex@example.com'],
    }) }),
    // An operator category filter also applies. It cannot override the approved Promotions exclusion.
    ingestFilterOptions: { skipCategories: ['CATEGORY_SOCIAL'] },
    scopeApproval: { generation: 'current', revision: 'current' },
    internalEmbeddingProvider: recordingProvider('cloud', inputs),
    secureEmbeddingProvider: recordingProvider('local', inputs),
  });
  const first = await lane.pull({ max_items: 1 });
  expect(client.formats).toEqual(['full']);
  expect(inputs).toEqual([]);
  for (const store of [stores.internalStore, stores.secureStore]) {
    expect(store.holdsAnyItem()).toBe(false);
  }
  if (excluded === 'older') {
    expect(first.checkpoint).toBeTruthy();
    await lane.pull({ checkpoint: first.checkpoint! });
    expect(client.formats).toEqual(['full', 'metadata']);
    expect(stores.secureStore.itemStoredContent(identity(mail.id))?.chunkCount).toBe(0);
    expect(stores.secureStore.itemStoredContent(identity(gmailChildProviderId(mail.id, '1')))).toBeUndefined();
    expect(inputs).toEqual([]);
  }
});

test.each(['admitted', 'operator query', 'version changed', 'body-only OTP', 'names only', 'revoked'])('attachment backfill applies parent admission (%s)', async outcome => {
  const stores = fileStores(tempDir());
  const mail = attachmentMessage('legacy-parent', NOW.getTime() - DAY,
    outcome === 'body-only OTP' ? 'Use 123456. This code expires in 5 minutes.' : undefined);
  const client = fakeClient([mail]);
  const common = { ...stores, apiClient: client, credentialBroker: OFFLINE_BROKER, account: 'personal', env: {} };
  const oldApproval = { generation: 'legacy', revision: 'legacy' };
  await createGmailConnectorStoreSyncHandler({
    ...common, scope: {}, scopeApproval: oldApproval, ingestFilterOptions: { skipOtp: false },
  }).pull();
  expect(stores.internalStore.itemStoredContent(identity(mail.id))?.chunkCount).toBe(1);

  let revoked = false;
  const get = client.getMessage;
  client.getMessage = async (id, request) => {
    if (outcome === 'revoked') revoked = true;
    return get(id, request);
  };
  const list = client.listMessages;
  client.listMessages = async request => {
    expect(request.query).toContain('(is:starred)');
    if (outcome === 'admitted' && !request.pageToken) return { messages: [{ id: 'other-from-same-second' }], nextPageToken: 'later' };
    const { pageToken: _page, ...firstPage } = request;
    const page = await list(firstPage);
    if (outcome === 'operator query') return { messages: [{ id: 'unrelated' }] };
    if (outcome === 'version changed') mail.historyId = '1001';
    return page;
  };
  if (outcome !== 'operator query') mail.labelIds!.push('STARRED');
  const scopeApproval = { generation: 'current', revision: 'current' };
  const lane = createGmailConnectorStoreSyncHandler({
    ...common, build: { children: true }, query: 'is:starred', scopeApproval,
    scope: outcome === 'names only' ? { contentAfterMs: NOW.getTime() } : {},
    assertScopeCurrent: () => { if (revoked) throw new Error('mail scope no longer current'); },
  });
  client.formats.length = 0;
  if (outcome === 'revoked') await expect(lane.backfillChildren!()).rejects.toThrow('mail scope no longer current');
  else expect(await lane.backfillChildren!()).toMatchObject({ examined: 1, listed: outcome === 'admitted' ? 1 : 0 });
  expect(client.formats).toEqual(['admitted', 'version changed', 'body-only OTP'].includes(outcome)
    ? ['metadata', 'full'] : ['metadata']);
  const id = gmailCursorConnectorId('personal', scopeApproval);
  const child = identity(gmailChildProviderId(mail.id, '1'));
  expect(stores.internalStore.itemOwnerPresent(child, id, 'observed')).toBe(outcome === 'admitted');
  expect(stores.secureStore.itemOwnerPresent(child, id, 'observed')).toBe(false);
});

test('attachment backfill retries a parent whose historyId changes between metadata and full GET', async () => {
  const stores = fileStores(tempDir());
  const mail = attachmentMessage('changing-parent', NOW.getTime() - DAY);
  const client = fakeClient([mail]);
  const common = { ...stores, apiClient: client, credentialBroker: OFFLINE_BROKER, account: 'personal', env: {} };
  await createGmailConnectorStoreSyncHandler({
    ...common, scope: {}, scopeApproval: { generation: 'legacy', revision: 'legacy' },
  }).pull();
  expect(stores.internalStore.itemStoredContent(identity(mail.id))?.chunkCount).toBe(1);

  let changedOnce = false;
  const get = client.getMessage;
  client.getMessage = async (id, request) => {
    if (request?.format !== 'metadata' && !changedOnce) {
      changedOnce = true;
      mail.historyId = '1001';
    }
    return get(id, request);
  };
  const scopeApproval = { generation: 'current', revision: 'current' };
  const lane = createGmailConnectorStoreSyncHandler({
    ...common, build: { children: true }, scope: {}, scopeApproval,
  });
  const id = gmailCursorConnectorId('personal', scopeApproval);
  const child = identity(gmailChildProviderId(mail.id, '1'));

  client.formats.length = 0;
  expect(await lane.backfillChildren!()).toEqual({ examined: 1, listed: 0, done: false });
  expect(client.formats).toEqual(['metadata', 'full']);
  expect(stores.internalStore.itemOwnerPresent(child, id, 'observed')).toBe(false);
  expect(stores.secureStore.itemOwnerPresent(child, id, 'observed')).toBe(false);

  client.formats.length = 0;
  expect(await lane.backfillChildren!()).toEqual({ examined: 1, listed: 1, done: true });
  expect(client.formats).toEqual(['metadata', 'full']);
  expect(stores.internalStore.itemOwnerPresent(child, id, 'observed')).toBe(true);
  expect(await lane.backfillChildren!()).toEqual({ examined: 0, listed: 0, done: true });
});

test('deferred attachment reads never request a body or part when the operator query excludes its parent', async () => {
  const mail = attachmentMessage('unstarred', NOW.getTime() - DAY);
  mail.payload!.parts![1]!.body = { size: 4, attachmentId: 'fixture-child' };
  const client = fakeClient([mail]);
  client.listMessages = async (request) => {
    expect(request.query).toContain('(is:starred)');
    return { messages: [{ id: 'unrelated' }] };
  };
  const attachmentIds: string[] = [];
  client.getAttachment = async (id, part) => {
    attachmentIds.push(`${id}:${part}`);
    return { data: 'dGVzdA' };
  };
  const connector = new GoogleGmailSourceConnector({
    account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {},
    scope: {}, query: 'is:starred', build: { children: true },
  });
  await expect(connector.fetchItem(identity(gmailChildProviderId(mail.id, '1')).localItemId, {
    deferredBytes: { locator: `gmail-part1:${mail.id}:1` },
  })).rejects.toMatchObject({ errorKind: 'source_permission_denied' });
  expect(client.formats).toEqual(['metadata']);
  expect(attachmentIds).toEqual([]);
});

function seedRetiredBodyBlindOwner(dbPath: string, item: ReturnType<typeof identity>, connectorId: string): void {
  const db = new Database(dbPath);
  try {
    const row = db.query(`
      SELECT item_pk, sync_run_id FROM items
      WHERE provider = ? AND account_scope = ? AND provider_item_id = ? AND tombstoned = 0
    `).get(item.provider, item.accountScope, item.providerItemId) as { item_pk: number; sync_run_id: string } | null;
    if (!row) throw new Error(`Missing stored item ${item.providerItemId} in ${dbPath}`);
    const now = NOW.toISOString();
    db.query(`
      INSERT INTO item_owners (
        item_pk, connector_id, ownership_kind, first_seen_sync_run_id,
        last_seen_sync_run_id, first_seen_at, last_seen_at
      ) VALUES (?, ?, 'observed', ?, ?, ?, ?)
    `).run(row.item_pk, connectorId, row.sync_run_id, row.sync_run_id, now, now);
    db.query("INSERT INTO store_totals (name, n) VALUES ('writes', 1) ON CONFLICT(name) DO UPDATE SET n = n + 1").run();
  } finally {
    closeSqliteStore(db, { checkpoint: false });
  }
}

async function retainedPersonalMail(options: { legacyUnscoped?: boolean; bodyOnlyCode?: boolean } = {}) {
  const dir = tempDir();
  const stores = fileStores(dir);
  const connectedAt = NOW.toISOString();
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
  if (options.bodyOnlyCode) {
    mail.payload!.body!.data = Buffer.from('Use 123456. This code expires in 5 minutes.').toString('base64url');
  }
  const client = fakeClient([mail]);
  const inputs: string[] = [];
  const personal = { ...recordingProvider('local'), provider: 'built-in', modelId: 'fixture-personal', runsOnThisComputer: () => true,
    async embed(batch) { return batch.map(() => [1, 0]); },
  } satisfies SourceEmbeddingProvider;
  const privateProvider = { ...personal, modelId: 'fixture-private',
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
  const scope = (store: LocalConnectorStore, ref: MailSourceScopePolicyRef | undefined, provider: SourceEmbeddingProvider = privateProvider) => storeEmbeddingScope({
    store, sourceId: 'gmail.email', scopeRef: ref, authority,
    readScope: () => ({ allowed: true, contentAllowed: true }),
    provider, gmailLiveProcessorVerified: () => true, gmailRetainedAccountScope: () => 'personal',
  });
  const privateSweep = (ref: MailSourceScopePolicyRef | undefined, provider: SourceEmbeddingProvider = privateProvider) => {
    const store = stores.secureStore;
    const target = planStoreEmbedding({ store, provider, servedByMeaning: true, scope: scope(store, ref, provider) })!;
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
  return { ...stores, dir, mail, approve, inputs, move, privateProvider, privateSweep };
}

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

test.each([1, 2])('a retired v%i body-blind observation cannot authorize Private embedding for an off-device provider', async version => {
  const f = await retainedPersonalMail({ legacyUnscoped: true, bodyOnlyCode: true });
  const current = f.approve([{ id: 'Label_1', name: 'Family' }]);
  const approval = { generation: current.accountGeneration, revision: current.revision };
  const oldKey = legacyOwnerId(approval);
  const currentId = gmailCursorConnectorId('personal', approval);
  const item = identity(f.mail.id);
  // v1 only confirmed Private copies. v2 could confirm a Personal copy before its move.
  if (version === 1) await f.move();
  seedRetiredBodyBlindOwner(join(f.dir, version === 1 ? 'secure.sqlite' : 'internal.sqlite'), item, oldKey);
  if (version === 2) {
    expect(f.internalStore.itemMatchesSearchFilters(item.localItemId, 'personal', {
      observedConnectorId: currentId,
      previousObservedConnectorId: oldKey,
    })).toBe(false);
    await f.move();
  }
  expect(f.secureStore.itemOwnerPresent(item, oldKey, 'observed')).toBe(true);
  expect(f.secureStore.itemOwnerPresent(item, currentId, 'observed')).toBe(false);
  expect(f.secureStore.copyContentState(item)).toMatchObject({ chunks: 1 });
  const offDeviceInputs: string[] = [];
  const offDeviceProvider: SourceEmbeddingProvider = {
    provider: 'venice',
    backend: 'cloud',
    modelId: 'fixture-private-venice',
    dimension: 2,
    configHash: 'fixture-private-venice',
    epochId: 'fixture-private-venice',
    async embed(batch) {
      offDeviceInputs.push(...batch.map(entry => entry.text));
      return batch.map(() => [1, 0]);
    },
  };
  f.secureStore.queueEmbedding([item.localItemId], offDeviceProvider);
  expect(await f.privateSweep(current, offDeviceProvider).run()).toMatchObject({ counts: { chunks_embedded: 0 } });
  expect(await f.privateSweep(current, offDeviceProvider).run()).toMatchObject({ counts: { chunks_embedded: 0 } });
  expect(offDeviceInputs).toEqual([]);
});

test('an off-device Gmail embedding pass rechecks the live credential witness on every batch and commit', async () => {
  const dir = tempDir();
  const stores = fileStores(dir);
  const connectedAt = NOW.toISOString();
  const authority = new FileSourceScopeAuthority({
    registryPath: join(dir, 'handles.json'),
    readRegistry: () => ({ version: 1, handles: [{
      handle: 'gmail.personal', provider: 'gmail', accountRole: 'personal', scopes: [],
      allowedCapabilities: ['gmail.email.sync'], connectedAt,
    }] }),
  });
  const state = authority.mailSnapshot();
  authority.approveMail({
    accountGeneration: state.accountGeneration!, expectedRevision: state.revision,
    scope: { ...defaultMailScopeSelection(), window: 'all' },
  });
  const ref = authority.mailPolicyRef()!;
  const messages = Array.from({ length: 33 }, (_, index) => message(`batch-${String(index).padStart(2, '0')}`, NOW.getTime() - DAY - index * 1_000));
  await createGmailConnectorStoreSyncHandler({
    ...stores, account: 'personal', apiClient: fakeClient(messages), credentialBroker: OFFLINE_BROKER, env: {},
    scope: gmailConnectorScopeFromApproval(authority.assertCurrentMail(ref)),
    scopeApproval: { generation: ref.accountGeneration, revision: ref.revision },
  }).pull({ max_items: 50 });

  let verified = true;
  const dispatchedBatches: number[] = [];
  const provider: SourceEmbeddingProvider = {
    provider: 'venice',
    backend: 'cloud',
    modelId: 'fixture-venice',
    dimension: 2,
    configHash: 'fixture-venice',
    epochId: 'fixture-venice',
    async embed(batch) {
      dispatchedBatches.push(batch.length);
      return batch.map(() => [1, 0]);
    },
  };
  const scope = storeEmbeddingScope({
    store: stores.internalStore,
    sourceId: 'gmail.email',
    scopeRef: ref,
    authority,
    readScope: () => ({ allowed: true, contentAllowed: true }),
    provider,
    gmailRetainedAccountScope: () => 'personal',
    gmailLiveProcessorVerified: () => verified,
  });
  expect(scope.allowed).toBe(true);
  if (!scope.allowed) throw new Error('expected allowed scope');

  await expect(stores.internalStore.embedChunks({
    ...scopedEmbeddingOptions(scope, provider),
    onBatchWritten: () => { verified = false; },
  })).rejects.toThrow(SourceScopeApprovalRequiredError);
  expect(dispatchedBatches).toEqual([32]);
  expect(vectors(join(dir, 'internal.sqlite'))).toHaveLength(32);

  // Also verify the commit fence: flipping during an in-flight dispatch rolls back that batch's commit.
  verified = true;
  const commitFlipProvider: SourceEmbeddingProvider = {
    ...provider,
    async embed(batch) {
      dispatchedBatches.push(batch.length);
      verified = false;
      return batch.map(() => [1, 0]);
    },
  };
  const commitScope = storeEmbeddingScope({
    store: stores.internalStore,
    sourceId: 'gmail.email',
    scopeRef: ref,
    authority,
    readScope: () => ({ allowed: true, contentAllowed: true }),
    provider: commitFlipProvider,
    gmailRetainedAccountScope: () => 'personal',
    gmailLiveProcessorVerified: () => verified,
  });
  expect(commitScope.allowed).toBe(true);
  if (!commitScope.allowed) throw new Error('expected allowed scope');
  await expect(stores.internalStore.embedChunks(scopedEmbeddingOptions(commitScope, commitFlipProvider)))
    .rejects.toThrow(SourceScopeApprovalRequiredError);
  expect(dispatchedBatches).toEqual([32, 1]);
  expect(vectors(join(dir, 'internal.sqlite'))).toHaveLength(32);
});

test('the Private sweep embeds already queued live mail before retained backlog', async () => {
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
  expect(f.secureStore.queuedEmbeddingItemIds()).toEqual([identity(live.id).localItemId]);
  expect(await f.privateSweep(current).run()).toMatchObject({ counts: { chunks_embedded: 2, queued_first_items: 1 } });
  expect(f.inputs[0]).toContain('Body of new-live');
  expect(f.inputs.join('')).toContain('Body of retained');
});

test('ordinary ownership and retained mail survive later Gmail absence', async () => {
  const stores = fileStores(tempDir());
  const changes = ['excluded', 'trashed', 'deleted'];
  const retained = changes.map(change => message(`retained-${change}`, NOW.getTime() - DAY));
  const live = changes.map(change => message(`live-${change}`, NOW.getTime() - DAY));
  const mailbox = [...retained];
  const client = fakeClient(mailbox);
  const common = { ...stores, account: 'personal', apiClient: client, credentialBroker: OFFLINE_BROKER, env: {},
    scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff({ skippedLabels: [{ id: 'Label_1', name: 'Excluded' }] }) }) };
  const oldApproval = { generation: 'old', revision: 'old' };
  await createGmailConnectorStoreSyncHandler({ ...common, scopeApproval: oldApproval }).pull();
  mailbox.push(...live);
  const scopeApproval = { generation: 'new', revision: 'new' };
  const current = createGmailConnectorStoreSyncHandler({ ...common, scopeApproval });
  expect((await current.pull()).receipt.counts.internal_items_indexed).toBe(3);
  for (const mails of [retained, live]) {
    mails[0]!.labelIds = ['Label_1'];
    mails[1]!.labelIds = ['TRASH'];
  }
  mailbox.splice(0, mailbox.length);
  // Gmail's scoped list now omits all six, including the two that were deleted.
  expect((await current.pull()).receipt.counts.internal_items_tombstoned).toBe(0);
  expect((await current.reconcile()).receipt.counts.internal_items_tombstoned).toBe(0);
  const connectorId = gmailCursorConnectorId('personal', scopeApproval);
  for (const mail of live) {
    expect(stores.internalStore.itemOwnerPresent(identity(mail.id), connectorId, 'observed')).toBe(true);
  }
  for (const mail of retained) {
    expect(stores.internalStore.itemOwnerPresent(identity(mail.id), gmailCursorConnectorId('personal', oldApproval), 'observed')).toBe(true);
    expect(stores.internalStore.itemOwnerPresent(identity(mail.id), connectorId, 'observed')).toBe(false);
  }
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
  test('effective operator exclusions reach the picker without raw query terms or custom labels', async () => {
    const client = fakeClient([]);
    const summary = await createGmailMailScopeBrowser({
      credentialHandle: 'gmail.personal', credentialBroker: OFFLINE_BROKER, apiClient: client,
      env: { OLYMPUS_SOURCE_INDEX_GMAIL_QUERY: '-from:protected@example.test', OLYMPUS_EMAIL_INGEST_SKIP_CATEGORIES: 'category_updates,Label_812' },
    }).summarize({ scope: defaultMailScopeSelection(), now: NOW });
    expect(client.queries[0]).toContain('(-from:protected@example.test)');
    expect(summary.operator_exclusions).toEqual({
      gmail_query: true, categories: ['updates'], other_labels: true, verification_codes: true,
    });
    expect(JSON.stringify(summary)).not.toContain('protected@example.test');
    expect(JSON.stringify(summary)).not.toContain('Label_812');
  });

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

function attachmentMessage(id: string, at: number, body = 'The document is attached.'): GmailMessage {
  const mail = message(id, at);
  mail.payload = {
    mimeType: 'multipart/mixed',
    headers: mail.payload!.headers!,
    parts: [
      { partId: '0', mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } },
      { partId: '1', mimeType: 'text/plain', filename: 'child.txt', body: { size: 4, data: 'dGVzdA' } },
    ],
  };
  return mail;
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
