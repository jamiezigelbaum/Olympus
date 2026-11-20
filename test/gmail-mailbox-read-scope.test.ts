import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { recordedProviderAccount } from '../src/core/provider-account-history.ts';
import { composeProviderAccountId, googleAccountIdFromAddress, googleSubjectLabel } from '../src/core/provider-account-identity.ts';
import { sourceAccountBindingsPath, updateSourceAccountBinding } from '../src/core/source-account-binding.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { updateSourceRegistry } from '../src/core/source-registry.ts';
import { SecretLocationsIndex, secretLocationFingerprint } from '../src/workers/classification/secret-locations.ts';
import { defineConnectorCorpus, LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { removeConnectedHandles, upsertConnectedHandle } from '../src/workers/credential-broker/connected-handles.ts';
import { gmailStoreReadScope } from '../src/workers/email-source/gmail-status-scope.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { createLocalAnswerPath } from '../src/workers/engine/runtime/local-private-answers.ts';
import { createSourceAnswerLanes } from '../src/workers/engine/runtime/source-answer-lanes.ts';
import { GMAIL_SOURCE_ID, GMAIL_SECURE_CONNECTOR_CORPUS_ID } from '../src/workers/google-connectors/index.ts';
import { GMAIL_IMPORT_CONNECTOR_PREFIX } from '../src/workers/google-connectors/gmail-archive-target.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { tempDir } from './helpers/tier-fixtures.ts';

const CORPUS = GMAIL_SECURE_CONNECTOR_CORPUS_ID;
const HANDLE = 'gmail.personal';
const ORIGINAL_GRANT = '2026-11-19T00:00:00.000Z';
const RECONNECTED = '2026-11-20T00:00:00.000Z';
const LIVE_QUERY = 'Physician recommended paracetamol';
const IMPORT_QUERY = 'Archived receipt';
const LIVE_TITLE = 'Clinic message';
const IMPORT_TITLE = 'Archived receipt';
const sharedAddress = googleAccountIdFromAddress('person@example.test');
const originalMailbox = composeProviderAccountId([googleSubjectLabel('original'), sharedAddress])!;
const differentMailbox = composeProviderAccountId([googleSubjectLabel('replacement'), sharedAddress])!;
const renamedMailbox = composeProviderAccountId([googleSubjectLabel('original'), googleAccountIdFromAddress('renamed@example.test')])!;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function message(connectorId: string, id: string, title: string, body: string): SourceConnector {
  const item: RawItem = {
    identity: { family: 'email', provider: 'gmail', accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}`, sourceVersion: 'v1' },
    metadata: { title, subject: title },
    mimeType: 'message/rfc822',
    content: { kind: 'text', text: body },
    fetchedAt: ORIGINAL_GRANT,
  };
  return {
    id: connectorId, family: 'email',
    async authenticate() {},
    async *listItems() { yield { items: [item], done: true }; },
    async fetchItem() { return item; },
    classificationSignals() { return {}; },
  };
}

async function fixture(beforeLiveQueryEmbedding?: () => Promise<void>) {
  const { dir, cleanup } = tempDir('olympus-gmail-read-scope-');
  cleanups.push(cleanup);
  const env = { HOME: dir, XDG_DATA_HOME: join(dir, 'data') };
  const registryPath = join(dir, 'handles.json');
  const bindingPath = sourceAccountBindingsPath(registryPath);
  const history = { sourceId: GMAIL_SOURCE_ID };
  updateSourceRegistry(env, (registry) => {
    registry.accounts.push({
      source_id: GMAIL_SOURCE_ID, slot: '1', layout: 'legacy', state: 'active', corpus_ids: [CORPUS],
      created_at: ORIGINAL_GRANT, provider_account_hash: originalMailbox,
    });
  });
  updateSourceAccountBinding(bindingPath, GMAIL_SOURCE_ID, () => ({
    provider_account_id: originalMailbox, bound_grant: ORIGINAL_GRANT,
  }));
  const connect = (account: string, connectedAt = RECONNECTED) => upsertConnectedHandle({
    handle: HANDLE, provider: 'gmail', accountRole: 'personal', connectedAt, providerAccountId: account,
    allowedCapabilities: ['gmail.email.sync'], scopes: [],
  }, registryPath);
  connect(originalMailbox, ORIGINAL_GRANT);
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'private.sqlite'), corpusId: CORPUS, family: 'email', trustDomain: 'secure_local', tierLedger: null,
  });
  cleanups.push(() => store.close());
  await store.syncFromConnector(message('gmail.scope.0123456789abcdef01234567', 'live', LIVE_TITLE, 'Doctor advised acetaminophen.'), { fetchContent: true });
  await store.syncFromConnector(message(`${GMAIL_IMPORT_CONNECTOR_PREFIX}fixture-mbox`, 'imported', IMPORT_TITLE, 'Archived receipt for the chair.'), { fetchContent: true });
  const provider: SourceEmbeddingProvider = {
    provider: 'built-in', backend: 'local', modelId: 'fixture', configHash: 'fixture', dimension: 2, epochId: 'fixture',
    async embed(batch) {
      if (batch.some(({ text }) => text === LIVE_QUERY)) await beforeLiveQueryEmbedding?.();
      return batch.map(({ text }) => /acetaminophen|paracetamol/i.test(text) ? [1, 0] : [-1, 0]);
    },
  };
  expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(2);
  const readScope = () => gmailStoreReadScope({ registryPath, historyAccountId: () => recordedProviderAccount(history, env) });
  const worker = createEmailSourceWorker({
    connectorStores: [store], connectorStoreEmbeddingProviders: new Map([[CORPUS, provider]]), connectorStoreReadScope: readScope,
  });
  cleanups.push(() => worker.close());
  const registry = buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId: CORPUS, family: 'email', trustDomain: 'secure_local' })]);
  const lanes = createSourceAnswerLanes({
    stores: () => [store], registry: () => registry, embeddingProvider: () => provider, localEmbedding: () => provider,
    readScope, answerScope: () => ({ kind: 'search' }), accountScope: () => undefined,
  });
  const { answer } = createLocalAnswerPath({
    lanes, available: () => true, relevanceEmbedding: () => provider,
    releaseCheck: { inputs: (inputs) => inputs.map(() => ({ tier: 'private', gone: false })), secureDerivativeDefault: () => 'allow' },
    model: {
      name: 'built_in', spec: QWEN35_4B,
      async prepare() {},
      async stop() {},
      status: () => ({ state: 'ready', modelId: QWEN35_4B.modelId, label: '', percent: 100, bytesDone: 0, bytesTotal: 0, updatedAt: ORIGINAL_GRANT }),
      async complete() {
        return { text: '{"answer":"Found in the message [1].","citations":[{"evidence":1,"claim":"Found in the message."}],"unanswered":[],"sufficient":true}', modelId: QWEN35_4B.modelId };
      },
    },
  });
  const searchResponse = (query: string) => worker.fetch(new Request('http://worker.test/v1/source/index/search', {
    method: 'POST', body: JSON.stringify({ query, corpus_id: CORPUS, retrieval_mode: 'hybrid' }),
  }));
  return {
    reconnect(account: string) {
      connect(account);
      updateSourceAccountBinding(bindingPath, GMAIL_SOURCE_ID, (binding) => ({ ...binding, reconnected_at: RECONNECTED }));
    },
    disconnect() { expect(removeConnectedHandles([HANDLE], registryPath).removed).toHaveLength(1); },
    readScope,
    searchResponse,
    async search(query: string) {
      const response = await searchResponse(query);
      expect(response.status).toBe(200);
      const { hits } = await response.json() as { hits: Array<{ provenance: { citation?: { title?: string } } }> };
      return hits.map((hit) => hit.provenance.citation?.title);
    },
    ask: (question: string) => answer({ question }),
  };
}

test('a same-mailbox reconnect keeps live Gmail searchable and citable', async () => {
  const mail = await fixture();
  mail.reconnect(renamedMailbox);
  expect(await mail.search(LIVE_QUERY)).toEqual([LIVE_TITLE]);
  expect(await mail.ask(LIVE_QUERY)).toMatchObject({ status: 'answered', citations: [{ title: LIVE_TITLE }] });
});

test('a different Google subject cannot search or cite a held live Gmail vector', async () => {
  const mail = await fixture();
  expect(await mail.search(LIVE_QUERY)).toEqual([LIVE_TITLE]);
  mail.reconnect(differentMailbox);
  expect(await mail.search(LIVE_QUERY)).toEqual([]);
  const answer = await mail.ask(LIVE_QUERY);
  expect(answer.status).toBe('not_found');
  expect(answer).not.toHaveProperty('citations');
});

test('imported Gmail remains searchable and citable across reconnects and disconnect', async () => {
  const mail = await fixture();
  expect(await mail.search(IMPORT_QUERY)).toEqual([IMPORT_TITLE]);
  for (const change of [() => mail.reconnect(renamedMailbox), () => mail.reconnect(differentMailbox), () => mail.disconnect()]) {
    change();
    expect(await mail.search(IMPORT_QUERY)).toEqual([IMPORT_TITLE]);
    expect(await mail.ask(IMPORT_QUERY)).toMatchObject({ status: 'answered', citations: [{ title: IMPORT_TITLE }] });
  }
});

test('a real disconnect leaves held live Gmail searchable and citable', async () => {
  const mail = await fixture();
  mail.reconnect(differentMailbox);
  expect(await mail.search(LIVE_QUERY)).toEqual([]);
  mail.disconnect();
  expect(await mail.search(LIVE_QUERY)).toEqual([LIVE_TITLE]);
  expect(await mail.ask(LIVE_QUERY)).toMatchObject({ status: 'answered', citations: [{ title: LIVE_TITLE }] });
});

test('Gmail search rechecks the mailbox after awaiting a query embedding', async () => {
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const mail = await fixture(() => {
    started.resolve();
    return resume.promise;
  });
  const pending = mail.searchResponse(LIVE_QUERY);
  try {
    await Promise.race([started.promise, pending.then(() => {
      throw new Error('Search completed before the query embedding fixture ran.');
    })]);
    mail.reconnect(differentMailbox);
  } finally {
    resume.resolve();
  }
  const result = await pending;
  expect(result.status).toBe(403);
  expect(await result.json()).toMatchObject({ error: { code: 'source_index_policy_violation' } });
  expect(await mail.search(IMPORT_QUERY)).toEqual([IMPORT_TITLE]);
});

test('mailbox read scope hides Secret locations that carry no connector observation', async () => {
  const mail = await fixture();
  const sidecar = new SecretLocationsIndex({ dbPath: ':memory:' });
  cleanups.push(() => sidecar.close());
  const title = 'Garage access';
  const locator = 'mailbox-message-link';
  sidecar.record({
    identity: { provider: 'gmail', accountScope: 'personal', providerItemId: 'secret-live' },
    title, locator, namesReleasable: true, findingKinds: ['password'],
  });
  const matches = sidecar.search(title, mail.readScope());
  expect(matches).toMatchObject([{ title, locator }]);
  const saved = { source: matches[0]!.source, ref: matches[0]!.ref, fingerprint: secretLocationFingerprint({ title, locator }) };
  expect(sidecar.recheck(saved, mail.readScope())).toBe(true);
  mail.reconnect(differentMailbox);
  expect(sidecar.search(title, mail.readScope())).toEqual([]);
  expect(sidecar.recheck(saved, mail.readScope())).toBe(false);
  expect(await mail.search(IMPORT_QUERY)).toEqual([IMPORT_TITLE]);
});
