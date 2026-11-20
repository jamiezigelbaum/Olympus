// Off-device processors retain the previous approval and archive rules.
// Only an on-device processor can index all eligible retained mail.

import { createStoreScopes } from '../src/workers/engine/runtime/store-scope-policies.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { seedEngineSovereignty } from '../src/core/engine-service.ts';
import { defaultSovereigntyConfigPath } from '../src/core/sovereignty.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { OpenAICompatibleSourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { gmailHoldsImportedHistory } from '../src/workers/google-connectors/gmail-archive-target.ts';
import { gmailCursorConnectorId } from '../src/workers/google-connectors/index.ts';
import { planStoreEmbedding } from '../src/workers/connector-store/embedding-plan.ts';
import { storeEmbeddingScope } from '../src/workers/connector-store/embedding-scope.ts';
import type { FileSourceScopeAuthority, SourceScopePolicyRef } from '../src/workers/source-scope-runtime.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { gmailStoreEmbeddingScope } from '../src/workers/email-source/gmail-status-scope.ts';
import {
  createSourceIndexEmbeddingProviderFromSovereignty,
  loadSourceWorkerSovereignty,
} from '../src/workers/engine/runtime/embedding-providers.ts';
import {
  createGmailRetainedHistorySchedulerSource,
  withEmbeddingSweep,
} from '../src/workers/source-scheduler.ts';

/** Gmail's stores as the worker plans them: one rule per store, under the mail approval (or none). */
function gmailTargets(input: {
  stores: LocalConnectorStore[];
  provider: SourceEmbeddingProvider;
  ref?: SourceScopePolicyRef;
  importAccountScope?: string;
}) {
  const authority = { assertCurrentMail() {}, assertRefCurrent() {} } as unknown as FileSourceScopeAuthority;
  return () => input.stores.flatMap((store) => {
    const target = planStoreEmbedding({
      store,
      provider: input.provider,
      servedByMeaning: true,
      scope: storeEmbeddingScope({
        store,
        policy: gmailStoreEmbeddingScope({
          gmailLiveProcessorVerified: () => true, gmailRetainedAccountScope: () => input.importAccountScope,
        }),
        scopeRef: input.ref,
        authority: input.ref ? authority : undefined,
        readScope: () => ({ allowed: true, contentAllowed: true }),
        provider: input.provider,
      }),
    });
    return target ? [target] : [];
  });
}

const homes: string[] = [];
const stores: LocalConnectorStore[] = [];
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const CORPUS = 'secure_local.email.private';

function mailItem(id: string, text: string): RawItem {
  return {
    identity: { family: 'email', provider: 'gmail', accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}`, sourceVersion: 'v1' },
    mimeType: 'message/rfc822',
    content: { kind: 'text', text },
    metadata: { title: id, subject: id },
    fetchedAt: '2026-10-26T00:00:00.000Z',
  };
}

function connector(id: string, item: RawItem): SourceConnector {
  return {
    id, family: 'email',
    async authenticate() {},
    async *listItems() { yield { items: [item], done: true }; },
    async fetchItem() { return item; },
    classificationSignals() { return {}; },
  };
}

async function privateStore(): Promise<LocalConnectorStore> {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-no-live-'));
  homes.push(dir);
  const store = new LocalConnectorStore({ dbPath: join(dir, 'secure.sqlite'), corpusId: CORPUS, family: 'email', trustDomain: 'secure_local', tierLedger: null });
  stores.push(store);
  // One message an import brought in (its input's connector id), one live Gmail stored under an earlier approval.
  await store.syncFromConnector(connector('archive.6f9c2a10-0000-4000-8000-000000000001', mailItem('imported', 'The imported lease renewal terms for the flat')), { fetchContent: true });
  await store.syncFromConnector(connector('gmail.scope.0123456789abcdef01234567', mailItem('live', 'A live message from an approval that no longer stands')), { fetchContent: true });
  return store;
}

describe('imported Gmail history with no live connection', () => {
  test('the Private store counts only imports for an off-device processor without an approval', async () => {
    const store = await privateStore();
    const statusScope = (account?: string) => createStoreScopes({
      authority: undefined, sourceIdForStore: () => 'gmail.email', readScope: () => ({ allowed: true }),
      gmailRetainedAccountScope: () => account,
    }).statusScopeFor(store, undefined);
    expect(statusScope()).toMatchObject({ itemsAllowed: false, contentAllowed: false, embedding: { contentAllowed: false } });
    const scope = statusScope('personal');
    expect(store.status(scope).counts.items).toBe(1);
    expect(store.itemMatchesSearchFilters('personal:imported', 'personal', scope.itemFilters!)).toBe(true);
    expect(store.itemMatchesSearchFilters('personal:live', 'personal', scope.itemFilters!)).toBe(false);
  });

  test('a Gmail source with no sync of its own embeds imported and retained mail on-device', async () => {
    const store = await privateStore();
    const home = mkdtempSync(join(tmpdir(), 'gmail-no-live-engine-'));
    homes.push(home);
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), OLYMPUS_ENGINE_HOST: '1' };
    const policyPath = defaultSovereigntyConfigPath(env);
    mkdirSync(dirname(policyPath), { recursive: true });
    seedEngineSovereignty(policyPath);
    const engine = loadSourceWorkerSovereignty({}, env);
    const provider = createSourceIndexEmbeddingProviderFromSovereignty(engine, 'secure_local', env)!;
    const inputs: string[] = [];
    provider.embed = async (batch) => {
      inputs.push(...batch.map((entry) => entry.text));
      return batch.map(() => Array.from({ length: provider.dimension }, (_, at) => (at === 0 ? 1 : 0)));
    };
    const source = createGmailRetainedHistorySchedulerSource({
      config: { worker: { scheduler: { syncIntervalSeconds: 60, freshnessThresholdHours: 24 } } } as never,
    });
    expect(source).toMatchObject({ sourceId: 'gmail.email', tasks: [] });
    const targets = (gmailImportAccountScope?: string) => gmailTargets({
      stores: [store], provider, ...(gmailImportAccountScope ? { importAccountScope: gmailImportAccountScope } : {}),
    });
    expect(targets()()).toEqual([]);
    const task = withEmbeddingSweep([source], () => targets('personal'))[0]!.tasks.find((entry) => entry.id === 'gmail.email_embeddings')!;
    expect(provider.runsOnThisComputer?.()).toBe(true);
    expect(await task.run()).toMatchObject({ counts: { chunks_embedded: 2 } });
    expect(inputs.join(' ')).toContain('imported lease renewal');
    expect(inputs.join(' ')).toContain('approval that no longer stands');
  });
});

test.each(['queued', 'whole store', 'explicit'] as const)('a configured HTTP local processor gets only independent imports after revocation via %s', async (route) => {
  const store = await privateStore();
  const seen: string[] = [];
  const http = new OpenAICompatibleSourceEmbeddingProvider({
    baseUrl: 'http://127.0.0.1:8080/v1', model: 'fixture-remote', dimension: 4,
    fetchImpl: (async (_url, init) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      seen.push(...input);
      return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) });
    }) as typeof fetch,
  });
  if (route === 'explicit') {
    const worker = createEmailSourceWorker({
      connectorStores: [store], connectorStoreEmbeddingProviders: new Map([[store.corpusId, http]]),
      embeddingScopeFor: (leg, provider) => storeEmbeddingScope({
        store: leg, provider, scopeRef: undefined, authority: undefined,
        policy: gmailStoreEmbeddingScope({ gmailLiveProcessorVerified: () => true, gmailRetainedAccountScope: () => 'personal' }),
        readScope: () => ({ allowed: false }),
      }),
    });
    try {
      const response = await worker.fetch(new Request('http://worker.test/v1/source/index/embed', {
        method: 'POST', body: JSON.stringify({ corpus_id: store.corpusId }),
      }));
      expect(response.status).toBe(200);
    } finally { worker.close(); }
  } else {
    if (route === 'queued') store.queueEmbedding(['personal:live', 'personal:imported'], http);
    const source = createGmailRetainedHistorySchedulerSource({
      config: { worker: { scheduler: { syncIntervalSeconds: 60, freshnessThresholdHours: 24 } } } as never,
    });
    const [swept] = withEmbeddingSweep([source], () => gmailTargets({ stores: [store], provider: http, importAccountScope: 'personal' }));
    expect(await swept!.tasks[0]!.run()).toMatchObject({ counts: { chunks_embedded: 1 } });
  }
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain('imported lease renewal');
  expect(seen.join(' ')).not.toContain('approval that no longer stands');
});

test('an approved live row cannot leave for Venice until the connected credential is verified', async () => {
  const store = await privateStore();
  const ref = { sourceId: 'gmail.email', accountGeneration: 'connected', revision: 'current' } as const;
  await store.syncFromConnector(connector(gmailCursorConnectorId('personal', { generation: ref.accountGeneration, revision: ref.revision }),
    mailItem('current', 'Current live body')), { fetchContent: true });
  const seen: string[] = [];
  const venice: SourceEmbeddingProvider = {
    provider: 'venice', backend: 'cloud', modelId: 'fixture', configHash: 'fixture', dimension: 2, epochId: 'fixture',
    async embed(batch) { seen.push(...batch.map(entry => entry.text)); return batch.map(() => [1, 0]); },
  };
  let verified = false;
  const worker = createEmailSourceWorker({
    connectorStores: [store], connectorStoreEmbeddingProviders: new Map([[store.corpusId, venice]]),
    embeddingScopeFor: (leg, provider) => storeEmbeddingScope({
      store: leg, provider, scopeRef: ref,
      authority: { assertCurrentMail() {} } as unknown as FileSourceScopeAuthority, readScope: () => ({ allowed: false }),
      policy: gmailStoreEmbeddingScope({ gmailRetainedAccountScope: () => 'personal', gmailLiveProcessorVerified: () => verified }),
    }),
  });
  const embed = () => worker.fetch(new Request('http://worker.test/v1/source/index/embed', {
    method: 'POST', body: JSON.stringify({ corpus_id: store.corpusId }),
  }));
  try {
    expect((await embed()).status).toBe(403);
    expect(seen).toEqual([]);
    verified = true;
    expect((await embed()).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen.join(' ')).toContain('Current live body');
    expect(seen.join(' ')).not.toContain('no longer stands');
  } finally { worker.close(); }
});

describe('imported mail is recovered beside a connected live lane', () => {
  test('Venice policy, provider down, restart, then live connected: the imports and the current approval\'s mail embed once; an old approval\'s mail does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-live-recovery-'));
    homes.push(dir);
    const path = join(dir, 'secure.sqlite');
    const ref = { sourceId: 'gmail.email', accountGeneration: 'generation-now', revision: 'revision-now' } as const;
    // 1. Imported mail, a row under the current approval and one under an old one, written while the embedder was down: no vectors.
    const first = new LocalConnectorStore({ dbPath: path, corpusId: CORPUS, family: 'email', trustDomain: 'secure_local', tierLedger: null });
    await first.syncFromConnector(connector('archive.6f9c2a10-0000-4000-8000-000000000003', mailItem('imported-only', 'The imported insurance policy renewal')), { fetchContent: true });
    await first.syncFromConnector(connector(gmailCursorConnectorId('personal', { generation: ref.accountGeneration, revision: ref.revision }), mailItem('live-one', 'A live message under the current approval')), { fetchContent: true });
    await first.syncFromConnector(connector('gmail.scope.0123456789abcdef01234567', mailItem('live-old', 'A live message under an approval that was replaced')), { fetchContent: true });
    first.close();
    // 2. A restart: the in-memory queue is gone.
    const store = new LocalConnectorStore({ dbPath: path, corpusId: CORPUS, family: 'email', trustDomain: 'secure_local', tierLedger: null });
    stores.push(store);
    const calls: string[] = [];
    const venice = {
      provider: 'venice', modelId: 'fixture-venice', dimension: 4, configHash: 'fixture-venice', epochId: 'epoch:fixture-venice', backend: 'cloud',
      async embed(inputs: SourceEmbeddingInput[]) {
        calls.push(...inputs.map((input) => input.text));
        return inputs.map(() => [1, 0, 0, 0]);
      },
    } as SourceEmbeddingProvider;
    // 3. Live Gmail connected and approved: the store catches up on what the approval and the imports hold.
    const source = createGmailRetainedHistorySchedulerSource({
      config: { worker: { scheduler: { syncIntervalSeconds: 60, freshnessThresholdHours: 24 } } } as never,
    });
    const lane = withEmbeddingSweep([source], () => gmailTargets({ stores: [store], provider: venice, ref, importAccountScope: 'personal' }))[0]!.tasks[0]!;
    expect(await lane.run()).toMatchObject({ counts: { chunks_embedded: 2 } });
    expect(calls.join('\n')).toContain('insurance policy renewal');
    expect(calls.join('\n')).toContain('current approval');
    expect(calls.join('\n')).not.toContain('was replaced');
    // Nothing is embedded twice: a second pass finds nothing missing.
    calls.length = 0;
    expect(await lane.run()).toMatchObject({ counts: { chunks_embedded: 0 } });
    expect(calls).toEqual([]);
  });
});

describe('kept live mail with no approval is left alone', () => {
  function cloudProvider(calls: string[]): SourceEmbeddingProvider {
    return {
      provider: 'fixture-cloud',
      modelId: 'fixture-cloud-model',
      dimension: 4,
      configHash: 'fixture-cloud',
      epochId: 'epoch:fixture-cloud',
      backend: 'cloud',
      async embed(inputs: SourceEmbeddingInput[]) {
        calls.push(...inputs.map((input) => input.text));
        return inputs.map(() => [1, 0, 0, 0]);
      },
    } as SourceEmbeddingProvider;
  }

  test('live-only kept mail under a revoked approval: no off-device embedding or provider call; an import then drains alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-no-live-internal-'));
    homes.push(dir);
    const store = new LocalConnectorStore({ dbPath: join(dir, 'internal.sqlite'), corpusId: 'internal.email', family: 'email', trustDomain: 'internal', tierLedger: null });
    stores.push(store);
    // Personal mail live Gmail kept under an earlier scope, its vector missing; the approval is gone (no live lane).
    await store.syncFromConnector(connector('gmail.scope.0123456789abcdef01234567', mailItem('kept-live', 'A kept live message the owner no longer approves reading')), { fetchContent: true });
    const calls: string[] = [];
    const provider = cloudProvider(calls);
    expect(gmailHoldsImportedHistory([store])).toBe(false);
    const source = createGmailRetainedHistorySchedulerSource({
      config: { worker: { scheduler: { syncIntervalSeconds: 60, freshnessThresholdHours: 24 } } } as never,
    });
    const sweep = withEmbeddingSweep([source], () => gmailTargets({ stores: [store], provider, importAccountScope: 'personal' }))[0]!.tasks[0]!;
    expect(await sweep.run()).toMatchObject({ counts: { chunks_embedded: 0 } });
    expect(calls).toEqual([]);
    // An import brings one message: it, and only it, is embedded.
    await store.syncFromConnector(connector('archive.6f9c2a10-0000-4000-8000-000000000002', mailItem('imported-personal', 'An imported note about the garden plan')), { fetchContent: true });
    expect(gmailHoldsImportedHistory([store])).toBe(true);
    expect(await sweep.run()).toMatchObject({ counts: { chunks_embedded: 1 } });
    expect(calls.join('\n')).toContain('garden plan');
    expect(calls.join('\n')).not.toContain('no longer approves');
  });
});
