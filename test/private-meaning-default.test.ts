import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { optionsFromEnv } from '../scripts/source-embedding-drain.ts';
import { createSourceCorpusRegistry } from '../src/core/source-corpus-registry.ts';
import { withFileLeaseSync } from '../src/core/file-lease.ts';
import { seedEngineSovereignty } from '../src/core/engine-service.ts';
import { createSovereigntyEngine, loadSovereigntyEngine, migratePrivateMeaningSearch, defaultSovereigntyConfigPath, type SovereigntyTrustDomainPolicy } from '../src/core/sovereignty.ts';
import { localPrivateEmbeddingTargets, loadSourceWorkerSovereignty, createSourceIndexEmbeddingProviderFromSovereignty } from '../src/workers/email-source/server.ts';
import { LocalConnectorStore, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { withLocalPrivateEmbeddingBackfill, EMBEDDING_SWEEP_INTERVAL_MS, EMBEDDING_SWEEP_MAX_ITEMS, type SourceSchedulerSource } from '../src/workers/source-scheduler.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';

const oldBytes = readFileSync(new URL('./fixtures/sovereignty-1.0.0/no-sensitive.json', import.meta.url), 'utf8');
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function policyFile(bytes = oldBytes) {
  const home = mkdtempSync(join(tmpdir(), 'private-meaning-upgrade-')); homes.push(home);
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), OLYMPUS_ENGINE_HOST: '1' };
  const path = defaultSovereigntyConfigPath(env); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes); return { path, home: dirname(path), env };
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
    const { env } = policyFile();
    const engine = loadSourceWorkerSovereignty({}, env);
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
      const first = await task.run();
      expect(first).toMatchObject({ status: 'progress', counts: { chunks_embedded: 32 } });
      expect(first.continueSoon).toBeUndefined();
      expect(task.intervalMs).toBe(EMBEDDING_SWEEP_INTERVAL_MS);
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
    const { path, home, env } = policyFile();
    // Inspection is read-only; the engine/drain startup opt-in owns migration.
    expect(loadSovereigntyEngine({ configPath: path }).resolveEmbeddingProfile('secure_local')).toBeUndefined();
    expect(readdirSync(home)).toEqual(['sovereignty.json']);
    const engine = loadSourceWorkerSovereignty({}, env);
    expect(engine.config.retrieval.trustDomains.secure_local).toEqual(expectedSecure);
    const backups = readdirSync(home).filter(name => name.startsWith('sovereignty.json.backup-private-meaning-'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/backup-private-meaning-\d{4}-\d{2}-\d{2}T/);
    expect(readFileSync(join(home, backups[0]!), 'utf8')).toBe(oldBytes);
    expect(statSync(join(home, backups[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const expected = JSON.parse(oldBytes); expected.retrieval.trustDomains.secure_local = expectedSecure;
    expected.routes.secure_local.disabledReason = 'no-sensitive keeps Private search on this computer; no Private agent answer lane is configured.';
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
    const custom = JSON.parse(oldBytes); custom.retrieval.trustDomains.secure_local.activationMode = 'lexical_only';
    const { path: customPath } = policyFile(JSON.stringify(custom));
    withFileLeaseSync(customPath, () => {
      expect(loadSovereigntyEngine({ configPath: customPath, migratePrivateMeaning: true }).config.retrieval.trustDomains.secure_local?.activationMode).toBe('lexical_only');
    });
    const { path, home, env } = policyFile();
    withFileLeaseSync(path, () => {
      const engine = loadSourceWorkerSovereignty({}, env);
      expect(engine.resolveEmbeddingProfile('secure_local')).toBeUndefined();
      expect(readFileSync(path, 'utf8')).toBe(oldBytes);
    });
    // The test's own lease left its (empty, persistent) lock database; the upgrade took none.
    expect(readdirSync(home).sort()).toEqual(['sovereignty.json', 'sovereignty.json.lock.db']);
    expect(migratePrivateMeaningSearch(path)).toBeDefined();
  }, 10_000);

  test('JSON key order and whitespace do not turn the shipped policy into a custom one', () => {
    const old = JSON.parse(oldBytes);
    old.retrieval.trustDomains.secure_local = Object.fromEntries(Object.entries(old.retrieval.trustDomains.secure_local).reverse());
    const { path } = policyFile(JSON.stringify(old));
    expect(migratePrivateMeaningSearch(path)).toBeDefined();
  });

  test('customized Private retrieval and local embedding profiles remain byte-for-byte unchanged', () => {
    const edits = [
      (c: any) => { c.retrieval.trustDomains.secure_local.activationMode = 'lexical_only'; },
      (c: any) => { c.modelProfiles['built-in-embedding'].model = 'owner-model'; },
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


test('pinned elsewhere, hosted, or not the standalone engine: the 1.0.0 policy is never rewritten', () => {
  const { path, home, env } = policyFile();
  const elsewhereDir = mkdtempSync(join(tmpdir(), 'private-meaning-pinned-')); homes.push(elsewhereDir);
  const elsewhere = join(elsewhereDir, 'sovereignty.json'); writeFileSync(elsewhere, oldBytes);
  // An OpenClaw gateway's worker: supervised (instance id) by the gateway, with or without
  // engine markers inherited from its environment or worker.env.
  const { OLYMPUS_ENGINE_HOST: _engineHost, ...gateway } = env;
  const gatewayWorker = { OLYMPUS_NATIVE_SERVICE_INSTANCE_ID: 'gateway-fixture', OLYMPUS_WORKER_SUPERVISOR: 'gateway' };
  const log = spyOn(console, 'info').mockImplementation(() => {});
  try {
    for (const overrides of [
      { config: { sovereignty: { configPath: elsewhere } }, env },
      { config: {}, env: { ...env, OLYMPUS_SOVEREIGNTY_CONFIG_PATH: elsewhere } },
      { config: {}, env: { ...env, OLYMPUS_SOVEREIGNTY_CONFIG: elsewhere } },
      { config: {}, env: { ...env, OLYMPUS_ENGINE_HOST: '0' } },
      { config: {}, env: { ...gateway, ...gatewayWorker } },
      { config: {}, env: { ...gateway, OLYMPUS_SOVEREIGNTY_CONFIG_PATH: path, ...gatewayWorker } },
      { config: {}, env: { ...env, ...gatewayWorker } },
      { config: {}, env: { ...gateway, OLYMPUS_STANDALONE: '1', OLYMPUS_SOVEREIGNTY_CONFIG: path, ...gatewayWorker } },
      { config: {}, env: { ...env, OLYMPUS_NATIVE_SERVICE_INSTANCE_ID: 'unknown-supervisor' } },
    ]) {
      expect(loadSourceWorkerSovereignty(overrides.config, overrides.env).resolveEmbeddingProfile('secure_local')).toBeUndefined();
      expect(readFileSync(path, 'utf8')).toBe(oldBytes);
      expect(readFileSync(elsewhere, 'utf8')).toBe(oldBytes);
      expect(readdirSync(home)).toEqual(['sovereignty.json']);
      expect(readdirSync(elsewhereDir)).toEqual(['sovereignty.json']);
    }
    expect(log.mock.calls).toHaveLength(9);
    expect(log.mock.calls[0]![0]).toContain('1.0.0 keyword-only');
  } finally { log.mockRestore(); }
});

test('the worker the engine supervises migrates: it carries a service instance id like every supervised worker', () => {
  const engineWorker = { OLYMPUS_NATIVE_SERVICE_INSTANCE_ID: 'engine-worker', OLYMPUS_WORKER_SUPERVISOR: 'engine' };
  for (const shape of [
    (env: Record<string, string>) => ({ ...env, ...engineWorker }),
    (env: Record<string, string>, path: string) => ({ ...env, OLYMPUS_STANDALONE: '1', OLYMPUS_SOVEREIGNTY_CONFIG: path, ...engineWorker }),
  ]) {
    const { path, home, env } = policyFile();
    const log = spyOn(console, 'info').mockImplementation(() => {});
    try {
      const engine = loadSourceWorkerSovereignty({}, shape(env, path));
      expect(engine.config.retrieval.trustDomains.secure_local).toEqual(expectedSecure);
      expect(readdirSync(home).filter(name => name.startsWith('sovereignty.json.backup-private-meaning-'))).toHaveLength(1);
    } finally { log.mockRestore(); }
  }
});

test('the standalone engine naming its own default file (the Linux engine shape) still migrates', () => {
  const { path, home, env } = policyFile();
  const log = spyOn(console, 'info').mockImplementation(() => {});
  try {
    const engine = loadSourceWorkerSovereignty({}, { ...env, OLYMPUS_SOVEREIGNTY_CONFIG: path });
    expect(engine.config.retrieval.trustDomains.secure_local).toEqual(expectedSecure);
    expect(readdirSync(home).filter(name => name.startsWith('sovereignty.json.backup-private-meaning-'))).toHaveLength(1);
  } finally { log.mockRestore(); }
});

test('unrelated settings survive block migration and the success log names the backup once', () => {
  const old = JSON.parse(oldBytes);
  old.retrieval.trustDomains.internal.allowCloudQuery = false;
  old.modelProfiles['cloud-openclaw-infer'].model = 'owner-analyst';
  old.routes.secure_local.disabledReason = 'Owner choice';
  old.ownerNote = 'Keep this';
  const bytes = JSON.stringify(old);
  const { path, home, env } = policyFile(bytes);
  const log = spyOn(console, 'info').mockImplementation(() => {});
  try {
    loadSourceWorkerSovereignty({}, env);
    const next = JSON.parse(readFileSync(path, 'utf8'));
    old.retrieval.trustDomains.secure_local = expectedSecure;
    expect(next).toEqual(old);
    const backup = readdirSync(home).find(name => name.includes('backup'))!;
    expect(readFileSync(join(home, backup), 'utf8')).toBe(bytes);
    expect(log.mock.calls).toEqual([[`Private meaning search enabled locally; policy backup: ${join(home, backup)}`]]);
    loadSourceWorkerSovereignty({}, env);
    expect(log.mock.calls).toHaveLength(1);
  } finally { log.mockRestore(); }
});


test('direct drain startup uses the standalone migration rule and respects pinned policies', () => {
  for (const pinned of [false, true]) {
    const { path: defaultPath, home: defaultHome, env } = policyFile();
    const pinnedDir = mkdtempSync(join(tmpdir(), 'private-meaning-drain-pinned-')); homes.push(pinnedDir);
    const path = pinned ? join(pinnedDir, 'sovereignty.json') : defaultPath;
    const home = pinned ? pinnedDir : defaultHome;
    if (pinned) writeFileSync(path, oldBytes);
    const drainEnv = {
      ...env, OLYMPUS_SOURCE_EMBEDDING_DRAIN_ENABLED: 'true',
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_MODE: 'direct',
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_DROPBOX_STORE_ENABLED: 'false',
      ...(pinned ? { OLYMPUS_SOVEREIGNTY_CONFIG_PATH: path } : {}),
    };
    if (pinned) expect(() => optionsFromEnv(drainEnv)).toThrow('OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER is required');
    else expect(optionsFromEnv(drainEnv).client).toBeDefined();
    expect(JSON.parse(readFileSync(path, 'utf8')).retrieval.trustDomains.secure_local.activationMode)
      .toBe(pinned ? 'metadata_only' : 'hybrid_shadow');
    expect(readdirSync(home).filter(name => name.includes('backup'))).toHaveLength(pinned ? 0 : 1);
  }
});

test('seeded default through worker target wiring gives a Private item a local vector and keyword-only stays idle', async () => {
  const { path, env } = policyFile(); rmSync(path); seedEngineSovereignty(path);
  const engine = loadSourceWorkerSovereignty({}, env);
  const registry = createSourceCorpusRegistry();
  const corpusId = 'secure_local.whatsapp.messages';
  const definition = registry.definitions().find(d => d.corpusId === corpusId)!;
  const s = new LocalConnectorStore({ dbPath: ':memory:', corpusId, family: 'chat', trustDomain: 'secure_local', tierLedger: null });
  const item: RawItem = {
    identity: { family: 'chat', provider: 'whatsapp', accountScope: 'personal', providerItemId: 'one', localItemId: 'one', sourceVersion: 'v1' },
    mimeType: 'text/plain', content: { kind: 'text', text: 'A Private discussion about the morning appointment' },
    metadata: { name: 'fixture' }, fetchedAt: '2026-10-14T00:00:00Z',
  };
  const connector: SourceConnector = { id: 'whatsapp-fixture', family: 'chat', async authenticate() {}, async *listItems() { yield { items: [item], done: true }; }, async fetchItem() { return item; }, classificationSignals() { return {}; } };
  const provider = createSourceIndexEmbeddingProviderFromSovereignty(engine, 'secure_local', env)!;
  const embed = provider.embed;
  const inputs: string[] = [];
  provider.embed = async batch => { inputs.push(...batch.map(input => input.text)); return batch.map(() => Array.from({ length: provider.dimension }, (_, i) => i === 0 ? 1 : 0)); };
  const source: SourceSchedulerSource = { sourceId: 'whatsapp.personal.messages', corpusId, cadence: 'continuous', intervalMs: 1_000, freshnessThresholdHours: 1, tasks: [] };
  const targets = () => localPrivateEmbeddingTargets({
    source, sovereigntyEngine: engine, secureLocalPolicyEmbeddingProvider: provider,
    sourceCorpusRegistry: registry, connectorStores: [s], fullCorpusDefinitions: [definition],
    scopeRefs: new Map(), readScope: () => ({ allowed: true, contentAllowed: true }),
    connectorStoreAccountScopes: new Map([[corpusId, 'personal']]),
  });
  try {
    await s.syncFromConnector(connector, { fetchContent: true });
    expect(s.hasEmbeddings(provider.modelId)).toBe(false);
    const task = withLocalPrivateEmbeddingBackfill([source], targets)[0]!.tasks[0]!;
    expect(await task.run()).toMatchObject({ counts: { chunks_embedded: 1 } });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('Private discussion');
    expect(s.hasEmbeddings(provider.modelId)).toBe(true);
    engine.config.retrieval.trustDomains.secure_local!.activationMode = 'lexical_only';
    expect(withLocalPrivateEmbeddingBackfill([source], targets)[0]!.tasks).toEqual([]);
    expect(withLocalPrivateEmbeddingBackfill([source], () => [])[0]).toBe(source);
  } finally { provider.embed = embed; s.close(); }
});

test('every Private corpus can take local meaning vectors; none is pinned keyword-only by the registry', () => {
  const secure = createSourceCorpusRegistry().definitions().filter(definition => definition.trustDomain === 'secure_local');
  expect(secure.map(definition => definition.corpusId)).toContain('secure_local.drive.docs');
  for (const definition of secure) {
    expect({ corpusId: definition.corpusId, lexicalOnly: definition.activationMode === 'lexical_only', disabled: definition.embeddingPolicy === 'disabled' })
      .toEqual({ corpusId: definition.corpusId, lexicalOnly: false, disabled: false });
  }
});
