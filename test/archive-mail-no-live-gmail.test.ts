// Gmail's imported history before Gmail is connected (a normal first run:
// import the Takeout export, connect later). Live approval governs live reads,
// not the account's own stores: the Private store counts what the imports
// brought, and the private embedding drains it, with no live connection.
// Mail live Gmail stored under an approval that no longer stands is neither
// counted nor embedded by this path.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { seedEngineSovereignty } from '../src/core/engine-service.ts';
import { defaultSovereigntyConfigPath } from '../src/core/sovereignty.ts';
import { createSourceCorpusRegistry } from '../src/core/source-corpus-registry.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { gmailHoldsImportedHistory, gmailImportedHistoryEmbeddingTargets } from '../src/workers/google-connectors/gmail-archive-target.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { gmailPrivateStoreStatusScope } from '../src/workers/email-source/gmail-status-scope.ts';
import {
  createSourceIndexEmbeddingProviderFromSovereignty,
  loadSourceWorkerSovereignty,
  localPrivateEmbeddingTargets,
} from '../src/workers/email-source/server.ts';
import {
  createGmailImportedHistorySchedulerSource,
  withEmbeddingSweep,
  withLocalPrivateEmbeddingBackfill,
} from '../src/workers/source-scheduler.ts';

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
  test('the Private store counts what the imports brought, and only that', async () => {
    const store = await privateStore();
    expect(gmailPrivateStoreStatusScope({ authority: undefined, handle: undefined })).toEqual({ itemsAllowed: false, contentAllowed: false });
    const scope = gmailPrivateStoreStatusScope({ authority: undefined, handle: undefined, importAccountScope: 'personal' });
    expect(store.status(scope).counts.items).toBe(1);
    expect(store.itemMatchesSearchFilters('personal:imported', 'personal', scope.itemFilters!)).toBe(true);
    expect(store.itemMatchesSearchFilters('personal:live', 'personal', scope.itemFilters!)).toBe(false);
  });

  test('a Gmail source with no sync of its own carries the sweeps, and the private embedding drains the imported mail', async () => {
    const store = await privateStore();
    const home = mkdtempSync(join(tmpdir(), 'gmail-no-live-engine-'));
    homes.push(home);
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), OLYMPUS_ENGINE_HOST: '1' };
    const policyPath = defaultSovereigntyConfigPath(env);
    mkdirSync(dirname(policyPath), { recursive: true });
    seedEngineSovereignty(policyPath);
    const engine = loadSourceWorkerSovereignty({}, env);
    const registry = createSourceCorpusRegistry();
    const definition = registry.definitions().find((entry) => entry.corpusId === CORPUS)!;
    const provider = createSourceIndexEmbeddingProviderFromSovereignty(engine, 'secure_local', env)!;
    const inputs: string[] = [];
    provider.embed = async (batch) => {
      inputs.push(...batch.map((entry) => entry.text));
      return batch.map(() => Array.from({ length: provider.dimension }, (_, at) => (at === 0 ? 1 : 0)));
    };
    const source = createGmailImportedHistorySchedulerSource({
      config: { worker: { scheduler: { syncIntervalSeconds: 60, freshnessThresholdHours: 24 } } } as never,
    });
    expect(source).toMatchObject({ sourceId: 'gmail.email', tasks: [] });
    const targets = (gmailImportAccountScope?: string) => () => localPrivateEmbeddingTargets({
      source, sovereigntyEngine: engine, secureLocalPolicyEmbeddingProvider: provider,
      sourceCorpusRegistry: registry, connectorStores: [store], fullCorpusDefinitions: [definition],
      scopeRefs: new Map(), readScope: () => ({ allowed: true, contentAllowed: true }),
      connectorStoreAccountScopes: new Map(),
      ...(gmailImportAccountScope ? { gmailImportAccountScope } : {}),
    });
    // Without the import scope (the old behaviour), nothing would ever embed Gmail's Private store here.
    expect(targets()()).toEqual([]);
    const swept = withEmbeddingSweep([source], () => undefined);
    const backfilled = withLocalPrivateEmbeddingBackfill(swept, targets('personal'));
    const task = backfilled[0]!.tasks.find((entry) => entry.id === 'gmail.email_private_meaning')!;
    expect(await task.run()).toMatchObject({ counts: { chunks_embedded: 1 } });
    expect(inputs.join('\n')).toContain('imported lease renewal');
    expect(inputs.join('\n')).not.toContain('approval that no longer stands');
    writeFileSync(join(home, 'done'), '');
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

  test('live-only kept mail under a revoked approval: no fallback source, no embedding, no provider call; an import then drains alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-no-live-internal-'));
    homes.push(dir);
    const store = new LocalConnectorStore({ dbPath: join(dir, 'internal.sqlite'), corpusId: 'internal.email', family: 'email', trustDomain: 'internal', tierLedger: null });
    stores.push(store);
    // Personal mail live Gmail kept under an earlier scope, its vector missing; the approval is gone (no live lane).
    await store.syncFromConnector(connector('gmail.scope.0123456789abcdef01234567', mailItem('kept-live', 'A kept live message the owner no longer approves reading')), { fetchContent: true });
    const calls: string[] = [];
    const provider = cloudProvider(calls);
    expect(gmailHoldsImportedHistory([store])).toBe(false);
    const source = createGmailImportedHistorySchedulerSource({
      config: { worker: { scheduler: { syncIntervalSeconds: 60, freshnessThresholdHours: 24 } } } as never,
    });
    const targets = () => gmailImportedHistoryEmbeddingTargets({ stores: [store], providerFor: () => provider, accountScope: 'personal' });
    const sweep = withEmbeddingSweep([source], () => targets)[0]!.tasks[0]!;
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
