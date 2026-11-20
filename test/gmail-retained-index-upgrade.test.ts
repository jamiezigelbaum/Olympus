import { Database } from 'bun:sqlite';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { defaultConfig } from '../src/core/config.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { defaultMailScopeSelection } from '../src/core/mail-source-scope.ts';
import { googleAccountIdFromAddress, googleSubjectLabel } from '../src/core/provider-account-identity.ts';
import { recordFileSourceConnect, recordFileSourceConnectIntent, sourceAccountBindingsPath, updateSourceAccountBinding } from '../src/core/source-account-binding.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { LocalConnectorStore, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { planStoreEmbedding } from '../src/workers/connector-store/embedding-plan.ts';
import { automaticTierMoveOptions } from '../src/workers/connector-store/tier-auto-move.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createLaneTieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { readConnectedHandleRegistry, writeConnectedHandleRegistry, type ConnectedCredentialHandle } from '../src/workers/credential-broker/connected-handles.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';
import { gmailPrivateStoreStatusScope, readGmailRetainedAccountScope } from '../src/workers/email-source/gmail-status-scope.ts';
import { storeEmbeddingScope } from '../src/workers/engine/runtime/embedding-providers.ts';
import { createLocalAnswerPath } from '../src/workers/engine/runtime/local-private-answers.ts';
import { createSourceAnswerLanes } from '../src/workers/engine/runtime/source-answer-lanes.ts';
import { createGmailConnectorStoreSyncHandler, GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, GMAIL_SECURE_CONNECTOR_CORPUS_ID } from '../src/workers/google-connectors/index.ts';
import type { GmailApiClient, GmailMessage } from '../src/workers/google-connectors/gmail.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { FileSourceScopeAuthority, gmailConnectorScopeFromApproval, scopeBoundSchedulerSource } from '../src/workers/source-scope-runtime.ts';
import { createGmailConnectorStoreSchedulerSource, createGmailRetainedHistorySchedulerSource, SourceScheduler, withEmbeddingSweep } from '../src/workers/source-scheduler.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import { tempDir } from './helpers/tier-fixtures.ts';

const NOW = '2026-11-18T12:00:00.000Z';
const RECONNECT = '2026-11-19T12:00:00.000Z';
const ADDRESS = googleAccountIdFromAddress('owner@example.test');
const MAILBOX = `${googleSubjectLabel('109876543210987654321')}.${ADDRESS}`;
const TITLE = 'Orchard tenancy';
const BODY = 'The orchard tenancy expires 31 May 2027.';
const QUESTION = 'When is my lease up?';
const HELD = 'Held meadow picnic notes.';
const DECOY = 'The alpine funicular departs at noon.';
const ARCHIVE = 'archive.6f9c2a10-0000-4000-8000-000000000004';
const OLD_CONFIRMATION_TASK = 'gmail.email_private_scope_confirmation_v1';
const offlineBroker = {
  async issueSession() { throw new Error('Unexpected credential request in fixture'); },
} satisfies CredentialBroker;
const readScope = () => ({ allowed: true, contentAllowed: true } as const);
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const identity = (id: string) => ({
  family: 'email' as const, provider: 'gmail', accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}`,
});

function embedding(modelId: string, documentInputs: string[]): SourceEmbeddingProvider {
  return {
    provider: 'built-in', backend: 'local', dimension: 2, modelId, configHash: modelId, epochId: modelId,
    runsOnThisComputer: () => true,
    async embed(inputs, { taskType }) {
      if (taskType === 'RETRIEVAL_DOCUMENT') documentInputs.push(...inputs.map(input => input.text));
      return inputs.map(({ text }) => text.includes(BODY) || text.includes(QUESTION) ? [1, 0] : [0, 1]);
    },
  };
}

function seedCompletedConfirmation(
  path: string,
  state: LocalSourceSchedulerStateStore,
  observedOwner: string,
  scopeRevision: string,
  archiveOverlap: boolean,
) {
  const db = new Database(path);
  try {
    // c75d8eea persisted this connector id and checkpoint encoding. Seed
    // them directly so the fixture needs no retired confirmation code.
    db.query("UPDATE item_owners SET connector_id = ? WHERE ownership_kind = 'observed'").run(observedOwner);
    if (archiveOverlap) db.query(`
      INSERT INTO item_owners (item_pk, connector_id, ownership_kind, first_seen_sync_run_id, last_seen_sync_run_id, first_seen_at, last_seen_at)
      SELECT item_pk, ?, ownership_kind, first_seen_sync_run_id, last_seen_sync_run_id, first_seen_at, last_seen_at
      FROM item_owners WHERE connector_id = ?
    `).run(ARCHIVE, observedOwner);
  } finally {
    db.close();
  }
  const scope = `private-confirmation-v3:${observedOwner}`;
  const checkpoint = `gmp1:${Buffer.from(JSON.stringify({ scope, head: `${scope}:done`, confirmed: 1 })).toString('base64url')}`;
  const task = { sourceId: 'gmail.email', corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
    taskId: `${OLD_CONFIRMATION_TASK}:scope:${scopeRevision.replaceAll('-', '').slice(0, 16)}` };
  state.recordSuccess({ ...task, completedAt: NOW, resultStatus: 'progress', checkpoint });
  return { checkpoint, task };
}

async function upgradeFixture(options: { matching?: boolean; archiveOverlap?: boolean; held?: boolean; decoy?: boolean; reconnectAccount?: string } = {}) {
  const tmp = tempDir('olympus-gmail-index-upgrade-');
  cleanups.push(tmp.cleanup);
  const internalPath = join(tmp.dir, 'personal.sqlite');
  const securePath = join(tmp.dir, 'private.sqlite');
  const schedulerPath = join(tmp.dir, 'scheduler.sqlite');
  const registryPath = join(tmp.dir, 'handles.json');
  const bindingsPath = sourceAccountBindingsPath(registryPath);
  updateSourceAccountBinding(bindingsPath, 'gmail.email', () => ({ provider_account_id: MAILBOX, bound_grant: NOW }));
  const privateDocuments: string[] = [];
  const privateProvider = embedding('fixture-private', privateDocuments);
  const personalProvider = embedding(options.matching ? privateProvider.modelId : 'fixture-personal', []);
  const config = defaultConfig();
  const originalHandle: ConnectedCredentialHandle = {
    handle: 'gmail.personal', provider: 'gmail', accountRole: 'personal', trustDomain: 'secure_local',
    allowedCapabilities: ['gmail.email.sync'], scopes: ['openid'], connectedAt: NOW, providerAccountId: MAILBOX,
  };
  const readHandle = () => readConnectedHandleRegistry(registryPath).handles[0];
  writeConnectedHandleRegistry({ version: 1, handles: [originalHandle] }, registryPath);
  const open = () => {
    const internalStore = new LocalConnectorStore({ dbPath: internalPath, corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, family: 'email', trustDomain: 'internal' });
    const secureStore = new LocalConnectorStore({ dbPath: securePath, corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID, family: 'email', trustDomain: 'secure_local' });
    const set = createLaneTieredStoreSet({
      internalStore, secureStore, setId: 'gmail', internalEmbeddingProvider: personalProvider, secureEmbeddingProvider: privateProvider,
      ...(options.held ? { tierClassification: { holdContentUntilJudged: true as const, sniffer: { id: 'fixture-held', judge: () => ({ verdict: 'undecided' as const, queued: true as const }) } } } : {}),
    });
    const state = new LocalSourceSchedulerStateStore(schedulerPath);
    return { internalStore, secureStore, set, state, authority: new FileSourceScopeAuthority({ registryPath }),
      close: () => { state.close(); internalStore.close(); secureStore.close(); } };
  };
  let runtime = open();
  cleanups.push(() => runtime.close());
  const approve = () => {
    const state = runtime.authority.mailSnapshot();
    runtime.authority.approveMail({ accountGeneration: state.accountGeneration!, expectedRevision: state.revision,
      scope: { ...defaultMailScopeSelection(), window: 'all', alwaysPrivateSenders: ['@clinic.example'] } });
    return runtime.authority.mailPolicyRef()!;
  };
  const mail: GmailMessage = {
    id: 'moved', threadId: 'thread-moved', historyId: '1000', internalDate: String(Date.parse(NOW)), labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: TITLE }, { name: 'From', value: 'sender@example.test' }, { name: 'Date', value: NOW }],
      body: { data: Buffer.from(BODY).toString('base64url') },
    },
  };
  const decoyId = identity('decoy');
  const decoy: GmailMessage = {
    ...mail, id: decoyId.providerItemId, threadId: 'thread-decoy',
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: 'Cable car notice' }, { name: 'From', value: 'travels@clinic.example' }, { name: 'Date', value: NOW }],
      body: { data: Buffer.from(DECOY).toString('base64url') },
    },
  };
  const mailbox = options.decoy ? [mail, decoy] : [mail];
  const gmailRequests: string[] = [];
  const client: GmailApiClient = {
    async listMessages() {
      gmailRequests.push('list');
      return { messages: mailbox.map(({ id }) => ({ id })) };
    },
    async getMessage(id, request) {
      gmailRequests.push(`get:${request?.format ?? 'full'}`);
      return mailbox.find(item => item.id === id)!;
    },
    async getAttachment() { gmailRequests.push('attachment'); throw new Error('No attachment in fixture'); },
    async getProfile() { gmailRequests.push('profile'); return { emailAddress: 'owner@example.test' }; },
  };
  const sync = (ref: NonNullable<ReturnType<FileSourceScopeAuthority['mailPolicyRef']>>) => createGmailConnectorStoreSyncHandler({
    internalStore: runtime.internalStore, secureStore: runtime.secureStore,
    // The original live message predates the pending-judgment fixture.
    ...(options.held ? { internalEmbeddingProvider: personalProvider, secureEmbeddingProvider: privateProvider } : { tierSet: runtime.set }),
    credentialBroker: offlineBroker, apiClient: client, account: 'personal', env: {},
    scope: gmailConnectorScopeFromApproval(runtime.authority.assertCurrentMail(ref)),
    scopeApproval: { generation: ref.accountGeneration, revision: ref.revision },
    assertScopeCurrent: () => { runtime.authority.assertCurrentMail(ref); },
  });
  const oldRef = approve();
  await sync(oldRef).pull({ max_items: 50 });
  expect(gmailRequests).toEqual(expect.arrayContaining(['list', 'get:full']));
  const item = identity(mail.id);
  expect(runtime.internalStore.copyContentState(item)).toMatchObject({ chunks: 1, vectors: 1 });
  if (options.decoy) expect(runtime.secureStore.copyContentState(decoyId)).toMatchObject({ chunks: 1, vectors: 1 });
  privateDocuments.length = 0;
  const originalVectors = runtime.internalStore.exportItemCopy(item)!.vectors;
  const scopeKey = createHash('sha256').update(['personal', oldRef.accountGeneration, oldRef.revision].join('\0')).digest('hex').slice(0, 24);
  const observedOwner = `verified-observation.v1:gmail.scope.${scopeKey}`;
  const oldConfirmation = seedCompletedConfirmation(internalPath, runtime.state, observedOwner, oldRef.revision, options.archiveOverlap ?? false);
  expect(runtime.internalStore.itemOwnerPresent(item, observedOwner, 'observed')).toBe(true);

  const providerAccountId = options.reconnectAccount ?? MAILBOX;
  const reconnectTime = new Date(RECONNECT);
  recordFileSourceConnectIntent({ registryPath, provider: 'gmail', previousAccountId: MAILBOX, now: reconnectTime });
  writeConnectedHandleRegistry({ version: 1, handles: [{ ...originalHandle, connectedAt: RECONNECT, providerAccountId }] }, registryPath);
  const outcome = recordFileSourceConnect({ registryPath, provider: 'gmail', providerAccountId, now: reconnectTime });
  if (!options.reconnectAccount) expect(outcome).toBe('same_account');
  expect(runtime.authority.mailPolicyRef()).toBeUndefined();
  const ref = approve();
  expect(ref.accountGeneration).not.toBe(oldRef.accountGeneration);
  const target = { metadataTier: 'secure', contentTier: 'secure' } as const;
  const row = runtime.set.ledger.beginMove(item, target, runtime.set.ledger.getCurrent(item)!.generation);
  const move = await moveTieredItem({
    set: runtime.set, target, identity: item, expectedGeneration: row.generation,
    ...automaticTierMoveOptions(runtime.set, { localEmbeddingsOnly: () => true, embeddingLedgerPath: join(tmp.dir, 'embedding.jsonl') }),
  });
  expect(move).toMatchObject({ outcome: 'moved', raise: true });
  expect(move.destinations.find(copy => copy.corpusId === GMAIL_SECURE_CONNECTOR_CORPUS_ID)).toMatchObject({
    vectorsCopied: options.matching ? 1 : 0, chunksToEmbed: options.matching ? 0 : 1,
  });

  const heldId = identity('held');
  if (options.held) {
    const heldItem: RawItem = {
      identity: heldId, mimeType: 'message/rfc822', content: { kind: 'text', text: HELD }, metadata: { title: 'Held mail' },
      fetchedAt: NOW, holdContentUntilJudged: true,
    };
    const heldConnector: SourceConnector = {
      id: 'gmail.held-fixture', family: 'email', async authenticate() {},
      async *listItems() { yield { items: [heldItem], done: true }; },
      async fetchItem() { return heldItem; },
      classificationSignals() { return {}; },
    };
    await runtime.set.sync(heldConnector, { fetchContent: true }, { embed: false });
    expect(runtime.set.ledger.copies(heldId).some(copy => copy.embedHold)).toBe(true);
    expect(runtime.secureStore.copyContentState(heldId)).toMatchObject({ chunks: 1, vectors: 0 });
  }

  runtime.close();
  runtime = open();
  expect(runtime.state.get(oldConfirmation.task)?.checkpoint).toBe(oldConfirmation.checkpoint);
  const store = runtime.secureStore;
  expect(store.queuedEmbeddingItemIds()).toEqual([]);
  expect(store.itemOwnerPresent(item, observedOwner, 'observed')).toBe(true);
  if (options.archiveOverlap) expect(store.itemOwnerPresent(item, ARCHIVE, 'observed')).toBe(true);
  const retainedAccountScope = () => readGmailRetainedAccountScope({ registryPath, historyAccountId: () => MAILBOX, itemScope: () => 'personal' });
  let attemptedAt = RECONNECT;
  const runSweep = async (disconnected = false) => {
    if (disconnected) writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    const liveRef = runtime.authority.mailPolicyRef();
    const source = liveRef
      ? scopeBoundSchedulerSource({ source: createGmailConnectorStoreSchedulerSource({ config, sync: sync(liveRef) })!,
          authority: runtime.authority, ref: liveRef })
      : createGmailRetainedHistorySchedulerSource({ config });
    const sources = withEmbeddingSweep([source], () => () => {
      const plan = planStoreEmbedding({
        store, provider: privateProvider, servedByMeaning: true,
        scope: storeEmbeddingScope({
          store, provider: privateProvider, sourceId: source.sourceId, scopeRef: liveRef, authority: runtime.authority, readScope,
          gmailRetainedAccountScope: retainedAccountScope,
        }),
      });
      return plan ? [plan] : [];
    });
    expect(sources[0]!.tasks.some(task => task.id.startsWith(OLD_CONFIRMATION_TASK))).toBe(false);
    if (disconnected) expect(sources[0]!.tasks.map(task => task.id)).toEqual(['gmail.email_embeddings']);
    const sweep = sources[0]!.tasks.find(task => task.id === 'gmail.email_embeddings')!;
    const scheduler = new SourceScheduler({
      enabled: true, tickMs: 60_000, errorBackoffMs: 1_000, maxTransientRetries: 1, stateStore: runtime.state,
      sources: [{ ...sources[0]!, tasks: [sweep] }], now: () => new Date(attemptedAt),
    });
    try {
      const status = await scheduler.runDueTasks();
      const result = status.sources[0]!.tasks[0]!;
      attemptedAt = result.next_run_at!;
      return result;
    } finally {
      scheduler.stop();
    }
  };
  const dashboardStatus = () => store.statusOffThread(gmailPrivateStoreStatusScope({
    authority: runtime.authority, handle: readHandle(), provider: privateProvider, gmailRetainedAccountScope: retainedAccountScope,
  }));
  const corpora = new Set(runtime.set.openStores().map(leg => leg.corpusId));
  const visibilityScopes = () => [{ ledger: runtime.set.ledger, corpusIds: corpora }];
  const lanes = createSourceAnswerLanes({
    stores: () => runtime.set.openStores(),
    registry: () => buildSourceIndexCorpusRegistry(runtime.set.openStores().map(leg => defineConnectorCorpus({
      corpusId: leg.corpusId, family: leg.family, trustDomain: leg.trustDomain,
    }))),
    embeddingProvider: leg => leg === store ? privateProvider : personalProvider,
    localEmbedding: provider => provider,
    readScope, answerScope: () => ({ kind: 'search' }), accountScope: retainedAccountScope,
    visibilityGate: createTierVisibilityGate(visibilityScopes),
  });
  let answerCalls = 0;
  const model: BuiltInAnalystModel = {
    name: 'built_in', spec: QWEN35_4B,
    async prepare() {},
    async stop() {},
    status: () => ({ state: 'ready', modelId: QWEN35_4B.modelId, percent: 100, label: '', bytesDone: 0, bytesTotal: 0, updatedAt: NOW }),
    async complete(request) {
      answerCalls += 1;
      expect(JSON.stringify(request)).toContain(BODY);
      expect(JSON.stringify(request)).not.toContain(HELD);
      return {
        modelId: `built_in/${QWEN35_4B.modelId}`,
        text: JSON.stringify({
          answer: 'You can stay until 31 May 2027 [1].',
          citations: [{ evidence: 1, claim: BODY }], sufficient: true, unanswered: [],
        }),
      };
    },
  };
  const { answer } = createLocalAnswerPath({
    lanes, model, available: () => true, relevanceEmbedding: () => privateProvider,
    releaseCheck: createReleaseTierCheck(visibilityScopes, () => 'approval'),
  });
  const rankByMeaning = () => store.vectorSearchLane(QUESTION, privateProvider, 5);
  return { answer, answerCalls: () => answerCalls, dashboardStatus, decoyId, gmailRequests, heldId, item, originalVectors, privateDocuments, rankByMeaning,
    runSweep, store, ledger: runtime.set.ledger, registryPath };
}

test.each([
  { label: 'missing vector', embeds: 1, matching: false, archiveOverlap: false, held: true, decoy: true },
  { label: 'matching vector', embeds: 0, matching: true, archiveOverlap: true, held: true, decoy: true },
])('a same-mailbox reconnect and tier move keeps the retained message searchable after restart ($label)', async options => {
  const fixture = await upgradeFixture(options);
  const { store, item, heldId } = fixture;
  const gmailBeforeSweep = fixture.gmailRequests.length;
  const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
  cleanups.push(() => network.mockRestore());
  const noKeywordMatch = await fixture.answer({ question: QUESTION, selectors: { retrieval_mode: 'keyword' } });
  expect(noKeywordMatch.status).toBe('not_found');
  if (!options.matching) expect((await fixture.answer({ question: QUESTION })).status).toBe('not_found');
  expect(fixture.answerCalls()).toBe(0);
  expect(await fixture.dashboardStatus()).toMatchObject({ counts: { chunks: 2, embeddedChunks: options.matching ? 2 : 1 } });
  const run = await fixture.runSweep();
  expect(run.last_result?.counts).toMatchObject({ chunks_embedded: options.embeds });
  expect(fixture.gmailRequests).toHaveLength(gmailBeforeSweep);
  expect(fixture.privateDocuments).toHaveLength(options.embeds);
  expect(store.exportItemCopy(item)!.vectors).toHaveLength(1);
  if (options.matching) {
    expect(store.exportItemCopy(item)!.vectors).toEqual(fixture.originalVectors);
    expect(store.itemOwnerPresent(item, ARCHIVE, 'observed')).toBe(true);
  }
  const dashboard = await fixture.dashboardStatus();
  const decoy = store.exportItemCopy(fixture.decoyId)!;
  expect(decoy.vectors).toHaveLength(1);
  expect(dashboard.counts.embeddedChunks).toBe(store.exportItemCopy(item)!.vectors.length + decoy.vectors.length);
  expect(dashboard.counts.chunks).toBe(2);
  expect(fixture.ledger.copies(heldId).some(copy => copy.embedHold)).toBe(true);
  expect(store.exportItemCopy(heldId)).toMatchObject({ chunks: [expect.anything()], vectors: [] });
  expect(dashboard.tier?.pendingClassificationItems).toBe(1);
  expect(run.embedding_sweep?.[0]?.counts).toMatchObject({ skipped_held_chunks: 1, held_for_judgment_chunks: 1 });
  const ranked = await fixture.rankByMeaning();
  expect(ranked.rows.map(row => [row.sourceItem.providerItemId, row.bestCosine])).toEqual([[item.providerItemId, 1]]);
  expect(await fixture.answer({ question: QUESTION })).toMatchObject({
    status: 'answered', citations: [{ title: TITLE }],
    read: [{ provenance: { sourceItem: { provider: 'gmail', providerItemId: item.providerItemId } }, trustDomain: 'secure_local' }],
  });
  expect(fixture.answerCalls()).toBe(1);
  expect(fixture.gmailRequests).toHaveLength(gmailBeforeSweep);
  expect(network).toHaveBeenCalledTimes(0);
});

test('a disconnected live-only retained store can finish a Private vector without Gmail sync', async () => {
  const fixture = await upgradeFixture();
  const gmailBeforeSweep = fixture.gmailRequests.length;
  const run = await fixture.runSweep(true);
  expect(run.last_result?.counts).toMatchObject({ chunks_embedded: 1 });
  expect(fixture.store.exportItemCopy(fixture.item)!.vectors).toHaveLength(1);
  expect(fixture.gmailRequests).toHaveLength(gmailBeforeSweep);
});

test.each([
  { label: 'another immutable Google identity', account: `${googleSubjectLabel('209876543210987654321')}.${ADDRESS}` },
  { label: 'an address without the recorded Google identity', account: ADDRESS },
])('a reconnect with $label cannot adopt the retained Private library', async ({ account }) => {
  const fixture = await upgradeFixture({ reconnectAccount: account });
  const gmailBeforeSweep = fixture.gmailRequests.length;
  const run = await fixture.runSweep();
  expect(run.last_result?.counts).toMatchObject({ chunks_embedded: 0 });
  expect(fixture.privateDocuments).toEqual([]);
  expect(await fixture.dashboardStatus()).toMatchObject({ counts: { items: 0, chunks: 0, embeddedChunks: 0 } });
  expect(fixture.store.exportItemCopy(fixture.item)).toMatchObject({ chunks: [expect.anything()], vectors: [] });
  expect(fixture.gmailRequests).toHaveLength(gmailBeforeSweep);
});

test('an invalid retained Gmail grant is held until the registry is repaired', async () => {
  const fixture = await upgradeFixture();
  const { registryPath, gmailRequests, privateDocuments, runSweep } = fixture;
  const goodRegistry = readConnectedHandleRegistry(registryPath);
  writeFileSync(registryPath, JSON.stringify({
    version: 1,
    handles: [{ ...goodRegistry.handles[0], connectedAt: undefined }],
  }));
  const gmailBeforeSweep = gmailRequests.length;
  expect((await runSweep()).last_result?.counts).toMatchObject({ chunks_embedded: 0 });
  expect(privateDocuments).toEqual([]);
  expect(await fixture.dashboardStatus()).toMatchObject({ counts: { items: 0, chunks: 0, embeddedChunks: 0 } });
  writeConnectedHandleRegistry(goodRegistry, registryPath);
  expect((await runSweep()).last_result?.counts).toMatchObject({ chunks_embedded: 1 });
  expect(privateDocuments).toHaveLength(1);
  expect(gmailRequests).toHaveLength(gmailBeforeSweep);
});
