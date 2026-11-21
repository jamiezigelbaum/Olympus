import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FIXTURE_ITEMS, PRIVATE_MARKER, SECRET_MARKER, tierRules } from '../scripts/release-check/fixture.ts';
import { FIXTURE_JUDGE_MODEL, startFixtureJudge } from '../scripts/release-check/fixture-judge.ts';
import { saveFixtureJudge } from '../scripts/release-check/fixture-judge-settings.ts';
import { FAKE_READWISE_TOKEN, startFakeReadwise } from '../scripts/release-check/readwise-fake.ts';
import { loadConfig } from '../src/core/config.ts';
import { createSovereigntyEngine, isPublicTierRetired, loadSovereigntyEngine, loadSovereigntyPreset, writeSovereigntyConfigFile } from '../src/core/sovereignty.ts';
import { approveClassifier } from '../src/workers/classification-ledger.ts';
import { resolveTierSnifferRuntime } from '../src/workers/classification/built-in-sniffer.ts';
import { clearInstalledTierClassification, configureInstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { snifferPromptVersions } from '../src/workers/classification/sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { runTierRules } from '../src/workers/classification/tier-cli.ts';
import { embedPendingChunks } from '../src/workers/connector-store/index.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import { WorkerBootSecretResolver } from '../src/workers/credential-degradation.ts';
import { createTierSnifferModel } from '../src/workers/engine/runtime/judging-models.ts';
import { createReadwiseConnectorStore, ReadwiseDailyRequestBudget } from '../src/workers/readwise/connector.ts';
import { createReadwiseConnectorStoreSyncHandler } from '../src/workers/readwise/live-sync.ts';
import { createReadwiseTierLane } from '../src/workers/readwise/tier-set.ts';
import { EMBEDDING_SWEEP_MAX_ITEMS } from '../src/workers/source-scheduler.ts';
import { BUILT_IN_EMBEDDING_PROVIDER } from '../src/workers/source-index/built-in-embedding/provider.ts';
import { RecordingProvider, tempDir } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test('fresh Readwise lane settles and embeds the release fixture with both label rules pinned', async () => {
  const { dir: root, cleanup: removeRoot } = tempDir('olympus-fresh-label-rules-');
  cleanup.push(removeRoot);
  const env = {
    HOME: root,
    OLYMPUS_TIER_RULES_PATH: join(root, 'tier-rules.json'),
    OLYMPUS_PRIVACY_PROFILE_PATH: join(root, 'privacy.json'),
  };
  const rules = tierRules();
  expect(rules).toHaveLength(2);
  for (const rule of rules) {
    runTierRules(['add', '--id', rule.id, '--match', `label=${rule.label}`, '--tier', rule.tier,
      '--strength', 'force', '--source', 'readwise'], { env });
  }

  const reader = startFakeReadwise({ port: 0 });
  cleanup.push(() => reader.stop());
  const judge = startFixtureJudge(0);
  cleanup.push(() => judge.stop(true));
  const policyPath = join(root, 'sovereignty.json');
  const preset = loadSovereigntyPreset('local-first');
  writeSovereigntyConfigFile({ path: policyPath, config: preset });
  saveFixtureJudge(policyPath, preset);
  const policy = loadSovereigntyEngine({ configPath: policyPath, env }).config;
  policy.modelProfiles['release-check-judge']!.baseUrl = new URL('v1', judge.url).toString();
  const runtime = resolveTierSnifferRuntime({ engine: createSovereigntyEngine(policy), standaloneEngine: true });
  if (runtime.source !== 'configured') throw new Error('Expected the fixture judge');
  const { lane } = runtime;
  expect(lane.modelId).toBe(FIXTURE_JUDGE_MODEL);
  const classificationLedgerPath = join(root, 'classification-ledger.jsonl');
  await approveClassifier(classificationLedgerPath, lane, snifferPromptVersions().approval, 'Judge the release fixture.');
  const installed = configureInstalledTierClassification({ env, lane, retirePublic: isPublicTierRetired(policy) });
  cleanup.push(clearInstalledTierClassification);
  const model = createTierSnifferModel({
    lane, olympusConfig: loadConfig(env), env, bootSecretResolver: new WorkerBootSecretResolver(),
  });
  if (!model) throw new Error('Expected a ready fixture judge');

  const provider = new RecordingProvider(BUILT_IN_EMBEDDING_PROVIDER, 'fixture-local-embedding', 'local');
  const store = createReadwiseConnectorStore(join(root, 'readwise.sqlite'), env);
  const secrets = new SecretLocationsIndex({ dbPath: join(root, 'secret-locations.sqlite') });
  const { set, ledger } = createReadwiseTierLane({ store, env, secretLocations: secrets, embeddingProvider: provider });
  cleanup.push(() => {
    for (const leg of set.openStores()) leg.close();
    ledger.close();
    secrets.close();
  });
  const base = `http://127.0.0.1:${reader.port}/api`;
  const handler = createReadwiseConnectorStoreSyncHandler({
    store, tierSet: set, embeddingProvider: provider, env,
    apiV2BaseUrl: `${base}/v2/`, readerApiV3BaseUrl: `${base}/v3/`,
    requestBudget: new ReadwiseDailyRequestBudget({ dailyRequestBudget: 50 }),
    credentialBroker: new StaticCredentialBroker([{
      handle: 'readwise.personal', provider: 'readwise', allowedCapabilities: ['readwise.sync'], token: FAKE_READWISE_TOKEN,
    }]),
  });
  const identity = (id: string) => ({
    provider: 'readwise', accountScope: 'personal', providerItemId: id, providerConversationId: `document:${id}`,
  });
  const pulled = await handler.pull();
  expect(pulled.receipt.counts).toMatchObject({ items_seen: FIXTURE_ITEMS.length, traversal_complete: 1 });
  const personal = FIXTURE_ITEMS.filter(item => item.tier === 'personal');
  for (const item of personal) expect(ledger.getCurrent(identity(item.document.id))).toMatchObject({ contentPending: true });
  const pinned = FIXTURE_ITEMS.flatMap(item => item.label ? [{
    label: item.label, reasons: ledger.getCurrent(identity(item.document.id))?.reasons,
  }] : []);

  const service = new TierSnifferService({
    installed, lane, model, stores: () => set.openStores(), classificationLedgerPath,
    autoMoves: { localEmbeddingsOnly: () => true, embeddingLedgerPath: join(root, 'embedding-ledger.jsonl') },
  });
  cleanup.push(() => service.stop());
  // Drive the normal names, content and move passes without a scheduler clock or a VM.
  const passes = [await service.runOnce(), await service.runOnce(), await service.runOnce()];
  expect(passes.map(pass => pass.state)).toEqual(['ran', 'ran', 'ran']);
  const stats = await (await fetch(new URL('stats', judge.url))).json() as { calls: number };
  expect(stats.calls).toBeGreaterThan(0);
  const moveFailures = passes.flatMap(pass => pass.state === 'ran' ? Object.keys(pass.autoMoves?.failedBy ?? {}) : []);
  expect(moveFailures).toEqual([]);
  for (const { label, reasons } of pinned) expect(reasons).toContain(`metadata:owner_rule:label:${label}:force`);
  const [embeddingPass] = await embedPendingChunks(
    [{ store, provider, wholeStore: true }], { maxItems: EMBEDDING_SWEEP_MAX_ITEMS },
  );
  expect(embeddingPass?.chunksEmbedded).toBeGreaterThanOrEqual(personal.length);
  expect(provider.inputs.join('\n')).not.toContain(PRIVATE_MARKER);
  expect(provider.inputs.join('\n')).not.toContain(SECRET_MARKER);

  for (const item of FIXTURE_ITEMS) {
    const id = identity(item.document.id);
    if (item.tier === 'secrets') {
      expect(ledger.getCurrent(id)).toMatchObject({ contentTier: 'secrets' });
      expect(secrets.get(id)).toBeDefined();
      for (const leg of set.openStores()) expect(leg.exportItemCopy(id)).toBeUndefined();
    } else if (item.tier === 'private') {
      expect(ledger.getCurrent(id)).toMatchObject({ state: 'current', contentTier: 'secure', contentPending: false });
      expect(set.store('secure_local')?.exportItemCopy(id)?.chunks.length).toBeGreaterThan(0);
      expect(store.exportItemCopy(id)).toBeUndefined();
    } else {
      expect(ledger.getCurrent(id)).toMatchObject({ state: 'current', contentTier: 'private', contentPending: false });
      const copy = store.exportItemCopy(id);
      expect(copy?.chunks.length).toBeGreaterThan(0);
      expect(copy?.vectors).toHaveLength(copy!.chunks.length);
    }
  }
});
