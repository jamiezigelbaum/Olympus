import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLeaseSync } from '../src/core/file-lease.ts';
import { seedEngineSovereignty } from '../src/core/engine-service.ts';
import { createSovereigntyEngine, loadSovereigntyEngine, migratePrivateMeaningSearch, type SovereigntyTrustDomainPolicy } from '../src/core/sovereignty.ts';
import { createSourceIndexEmbeddingProviderFromSovereignty } from '../src/workers/email-source/server.ts';
import { LocalConnectorStore, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { withLocalPrivateEmbeddingBackfill, EMBEDDING_SWEEP_MAX_ITEMS, type SourceSchedulerSource } from '../src/workers/source-scheduler.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';

const oldBytes = readFileSync(new URL('./fixtures/sovereignty-1.0.0/no-sensitive.json', import.meta.url), 'utf8');
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function policyFile(bytes = oldBytes) {
  const home = mkdtempSync(join(tmpdir(), 'private-meaning-upgrade-')); homes.push(home);
  const path = join(home, 'sovereignty.json'); writeFileSync(path, bytes); return { path, home };
}
const expectedSecure: SovereigntyTrustDomainPolicy = {
  minimumExecutionTrust: 'local', allowedEmbeddingTrust: ['local'],
  embeddingProfile: 'built-in-embedding', allowCloudQuery: false,
  activationMode: 'hybrid_shadow', secureHandling: 'metadata_only_gap',
};

describe('the default install finds Private items by meaning locally', () => {
  test('backfill honors account and content filters, rechecks authorization, and refuses a cloud provider', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'secure_local.fixture.files', family: 'file', trustDomain: 'secure_local', tierLedger: null });
    const items: RawItem[] = ['eligible', 'other-account', 'other-provider'].map(id => ({
      identity: { family: 'file', provider: id === 'other-provider' ? 'elsewhere' : 'fixture', accountScope: id === 'other-account' ? 'someone-else' : 'personal', providerItemId: id, localItemId: id, sourceVersion: 'v1' },
      mimeType: 'text/plain', content: { kind: 'text', text: `${id} body` }, metadata: { name: id }, fetchedAt: '2026-10-14T00:00:00Z',
    }));
    const connector: SourceConnector = { id: 'fixture', family: 'file', async authenticate() {}, async *listItems() { yield { items, done: true }; }, async fetchItem(id) { return items.find(item => item.identity.localItemId === id)!; }, classificationSignals() { return {}; } };
    const inputs: string[] = [];
    let authorized = true;
    const provider: SourceEmbeddingProvider = { provider: 'built-in', backend: 'local', modelId: 'fixture-local', configHash: 'fixture', epochId: 'fixture-epoch', dimension: 2, async embed(batch) { inputs.push(...batch.map(input => input.text)); return batch.map(() => [1, 0]); } };
    const cloud: SourceEmbeddingProvider = { ...provider, provider: 'gemini', backend: 'cloud', async embed() { throw new Error('Cloud must never be called'); } };
    const source: SourceSchedulerSource = { sourceId: 'fixture', corpusId: store.corpusId, cadence: 'continuous', intervalMs: 1_000, freshnessThresholdHours: 1, tasks: [] };
    const task = withLocalPrivateEmbeddingBackfill([source], () => [
      { store, provider: cloud },
      { store, provider, accountScope: 'personal', filters: { provider: 'fixture' }, assertAuthorized: () => { if (!authorized) throw new Error('scope changed'); } },
    ])[0]!.tasks[0]!;
    try {
      await store.syncFromConnector(connector, { fetchContent: true });
      expect(await task.run()).toMatchObject({ counts: { chunks_embedded: 1 } });
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toContain('eligible body');
      expect(inputs.join('')).not.toContain('other-account');
      expect(inputs.join('')).not.toContain('other-provider');
      const before = [...inputs];
      items.push({ ...items[0]!, identity: { ...items[0]!.identity, providerItemId: 'new', localItemId: 'new' }, content: { kind: 'text', text: 'new eligible body' } });
      await store.syncFromConnector(connector, { fetchContent: true });
      authorized = false;
      expect(await task.run()).toMatchObject({ status: 'idle', counts: { items_out_of_scope: 1 } });
      expect(inputs).toEqual(before);
      authorized = true;
      expect(await task.run()).toMatchObject({ counts: { chunks_embedded: 1 } });
      expect(inputs.join('')).toContain('new eligible body');
    } finally { store.close(); }
  });

  test('existing Private items are owed by the bounded normal sweep and counted as indexing work', async () => {
    const { path } = policyFile();
    const engine = loadSovereigntyEngine({ configPath: path, migratePrivateMeaning: true });
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'secure_local.fixture.files', family: 'file', trustDomain: 'secure_local', tierLedger: null });
    const items: RawItem[] = Array.from({ length: EMBEDDING_SWEEP_MAX_ITEMS + 3 }, (_, index) => `item-${index}`).map(id => ({
      identity: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}`, sourceVersion: 'v1' },
      mimeType: 'text/plain', content: { kind: 'text', text: `Private document ${id}` }, metadata: { name: id }, fetchedAt: '2026-10-14T00:00:00Z',
    }));
    const connector: SourceConnector = { id: 'fixture', family: 'file', async authenticate() {}, async *listItems() { yield { items, done: true }; }, async fetchItem(id) { return items.find(item => item.identity.localItemId === id)!; }, classificationSignals() { return {}; } };
    const provider: SourceEmbeddingProvider = { provider: 'built-in', backend: 'local', modelId: 'fixture-local', configHash: 'fixture', epochId: 'fixture-epoch', dimension: 2, async embed(inputs) { return inputs.map(() => [1, 0]); } };
    try {
      await store.syncFromConnector(connector, { fetchContent: true });
      const availability = { [store.corpusId]: { servable: false, reason: 'no_current_embedding_artifacts' as const, modelId: provider.modelId, embeddingEpoch: provider.epochId, backend: 'local' as const, provider: 'built-in' } };
      const status = createSourceIndexStatusHandler({
        corpusDefinitions: [defineConnectorCorpus({ corpusId: store.corpusId, family: 'file', trustDomain: 'secure_local', activationMode: 'hybrid_shadow' })],
        connectorStores: [store], retrievalPolicy: domain => engine.config.retrieval.trustDomains[domain as 'secure_local'],
        retrievalAvailability: availability,
      });
      const before = (await status.status()).corpora[0]!;
      expect(before.embedding_parity).toMatchObject({ chunks: 35, embedded_chunks: 0, missing_chunks: 35 });
      expect(before.embedding_parity?.backlog_estimate?.missing_chunks).toBe(35);
      const source: SourceSchedulerSource = { sourceId: 'fixture', corpusId: store.corpusId, cadence: 'continuous', intervalMs: 1_000, freshnessThresholdHours: 1, tasks: [] };
      const task = withLocalPrivateEmbeddingBackfill([source], () => [{ store, provider }])[0]!.tasks[0]!;
      expect(await task.run()).toMatchObject({ status: 'progress', counts: { chunks_embedded: 32 }, continueSoon: true });
      expect(store.missingEmbeddingItemIds(provider, 100)).toHaveLength(3);
      expect(await task.run()).toMatchObject({ status: 'progress', counts: { chunks_embedded: 3 } });
      expect(store.missingEmbeddingItemIds(provider, 100)).toEqual([]);
      availability[store.corpusId]!.servable = true;
      expect((await status.status()).corpora[0]!.embedding_parity).toMatchObject({ embedded_chunks: 35, missing_chunks: 0 });
    } finally { store.close(); }
  });

  test('fresh standalone seed enables built-in local retrieval without Delphi or Venice', () => {
    const { path, home } = policyFile(); rmSync(path);
    expect(seedEngineSovereignty(path)).toBe('no-sensitive');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    expect(config.retrieval.trustDomains.secure_local).toEqual(expectedSecure);
    expect(config.modelProfiles['built-in-embedding']).toMatchObject({ provider: 'built-in', trust: 'local', purpose: 'embedding' });
    expect(Object.keys(config.modelProfiles).sort()).toEqual(['built-in-embedding', 'cloud-openclaw-infer']);
    expect(config.routes.secure_local).toMatchObject({ mode: 'disabled', pool: { members: [] } });
    const provider = createSourceIndexEmbeddingProviderFromSovereignty(createSovereigntyEngine(config), 'secure_local', { HOME: home });
    expect(provider).toMatchObject({ provider: 'built-in', backend: 'local' });
  });

  test('engine startup migrates the independent 1.0.0 fixture and backs up its exact bytes', () => {
    const { path, home } = policyFile();
    // Inspection is read-only; the engine/drain startup opt-in owns migration.
    expect(loadSovereigntyEngine({ configPath: path }).resolveEmbeddingProfile('secure_local')).toBeUndefined();
    expect(readdirSync(home)).toEqual(['sovereignty.json']);
    const engine = loadSovereigntyEngine({ configPath: path, migratePrivateMeaning: true });
    expect(engine.config.retrieval.trustDomains.secure_local).toEqual(expectedSecure);
    const backups = readdirSync(home).filter(name => name.startsWith('sovereignty.json.backup-private-meaning-'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/backup-private-meaning-\d{4}-\d{2}-\d{2}T/);
    expect(readFileSync(join(home, backups[0]!), 'utf8')).toBe(oldBytes);
    expect(statSync(join(home, backups[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const expected = JSON.parse(oldBytes); expected.retrieval.trustDomains.secure_local = expectedSecure;
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(expected);
    expect(migratePrivateMeaningSearch(path)).toBeUndefined();
    expect(readdirSync(home).filter(name => name.includes('backup'))).toHaveLength(1);
  });

  test('the actual engine/setup serialization of the 1.0.0 preset also migrates', () => {
    const bytes = JSON.stringify(createSovereigntyEngine(JSON.parse(oldBytes)).config, null, 2);
    const { path } = policyFile(bytes);
    expect(migratePrivateMeaningSearch(path)).toBeDefined();
    expect(JSON.parse(readFileSync(path, 'utf8')).retrieval.trustDomains.secure_local).toEqual(expectedSecure);
  });

  test('custom policies do not acquire a writer lease, and a busy eligible upgrade cannot stop startup', () => {
    const custom = JSON.parse(oldBytes); custom.retrieval.trustDomains.internal.allowCloudQuery = false;
    const { path: customPath } = policyFile(JSON.stringify(custom));
    withFileLeaseSync(customPath, () => {
      expect(loadSovereigntyEngine({ configPath: customPath, migratePrivateMeaning: true }).config.retrieval.trustDomains.internal?.allowCloudQuery).toBe(false);
    });
    const { path, home } = policyFile();
    withFileLeaseSync(path, () => {
      const engine = loadSovereigntyEngine({ configPath: path, migratePrivateMeaning: true });
      expect(engine.resolveEmbeddingProfile('secure_local')).toBeUndefined();
      expect(readFileSync(path, 'utf8')).toBe(oldBytes);
    });
    expect(readdirSync(home)).toEqual(['sovereignty.json']);
    expect(migratePrivateMeaningSearch(path)).toBeDefined();
  }, 10_000);

  test('JSON key order and whitespace do not turn the shipped policy into a custom one', () => {
    const old = JSON.parse(oldBytes);
    old.retrieval.trustDomains.secure_local = Object.fromEntries(Object.entries(old.retrieval.trustDomains.secure_local).reverse());
    const { path } = policyFile(JSON.stringify(old));
    expect(migratePrivateMeaningSearch(path)).toBeDefined();
  });

  test('customized retrieval, profiles, routes, other domains and unknown owner fields remain byte-for-byte unchanged', () => {
    const edits = [
      (c: any) => { c.retrieval.trustDomains.secure_local.activationMode = 'lexical_only'; },
      (c: any) => { c.modelProfiles['built-in-embedding'].model = 'owner-model'; },
      (c: any) => { c.retrieval.trustDomains.internal.allowCloudQuery = false; },
      (c: any) => { c.routes.secure_local.disabledReason = 'Owner choice'; },
      (c: any) => { c.ownerNote = 'Keep this'; },
      (c: any) => { c.retrieval.trustDomains.secure_local.ownerNote = 'Keep this'; },
    ];
    for (const edit of edits) {
      const old = JSON.parse(oldBytes); edit(old);
      const bytes = JSON.stringify(old, null, 4); const { path, home } = policyFile(bytes);
      expect(migratePrivateMeaningSearch(path)).toBeUndefined();
      expect(readFileSync(path, 'utf8')).toBe(bytes);
      expect(readdirSync(home)).toEqual(['sovereignty.json']);
    }
  });
});
