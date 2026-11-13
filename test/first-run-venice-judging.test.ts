import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { withKeywordExpansionDisabled } from '../src/core/source-index/keyword-context.ts';
import { createSovereigntyEngine, isPublicTierRetired, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import {
  registerBuiltInPrivateModel,
  registeredBuiltInPrivateModel,
  resolveJudgeChoiceRuntime,
  type BuiltInPrivateModel,
} from '../src/workers/classification/built-in-sniffer.ts';
import { clearInstalledTierClassification, configureInstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { createJudgeSetup } from '../src/workers/classification/judge-setup.ts';
import { JudgeSpending, readJudgeSpending } from '../src/workers/classification/judge-spending.ts';
import { snifferPromptVersions } from '../src/workers/classification/sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import {
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { WorkerBootSecretResolver } from '../src/workers/credential-degradation.ts';
import { createTierSnifferModel } from '../src/workers/engine/runtime/judging-models.ts';
import { searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { laneReleaseCheck } from './helpers/lane-release-check.ts';
import { createTestClock, waitFor } from './helpers/test-clock.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test('fresh local-first install: the saved Venice choice judges held items and releases only Personal content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-first-venice-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const time = createTestClock(Date.now());
  const env = {
    HOME: root,
    OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: join(root, 'no-exclusions.json'),
    OLYMPUS_TIER_RULES_PATH: join(root, 'tier-rules.json'),
    OLYMPUS_PRIVACY_PROFILE_PATH: join(root, 'privacy.json'),
    VENICE_API_KEY: 'placeholder-venice-key-for-test',
  };
  let localCalls = 0;
  const builtIn: BuiltInPrivateModel = {
    available: () => true,
    model: { async complete() {
      localCalls++;
      throw new Error('The saved Venice choice must not dispatch to the local judge');
    } },
  };
  const previousBuiltIn = registeredBuiltInPrivateModel();
  registerBuiltInPrivateModel(builtIn);
  cleanup.push(() => registerBuiltInPrivateModel(previousBuiltIn));
  const policy = loadSovereigntyPreset('local-first');
  const engine = createSovereigntyEngine(policy);
  const runtimeInput = { engine, builtIn: registeredBuiltInPrivateModel()!, standaloneEngine: true };
  const spendingPath = join(root, 'judge-spending.json');
  const spending = new JudgeSpending(spendingPath);
  expect(spending.hasRecord()).toBe(false);
  expect(resolveJudgeChoiceRuntime(runtimeInput, spending.status()).source).toBe('built_in');
  const cap = 1;
  const classificationLedgerPath = join(root, 'classification-ledger.jsonl');
  const setup = createJudgeSetup({
    spending,
    cloud: resolveJudgeChoiceRuntime(runtimeInput, { choice: 'venice', stop: null, remainingDollars: cap }),
    local: () => resolveJudgeChoiceRuntime(runtimeInput, { choice: 'local', stop: null, remainingDollars: 0 }),
    ledgerPath: classificationLedgerPath,
    promptVersion: () => snifferPromptVersions().approval,
    credentialReady: () => Boolean(env.VENICE_API_KEY),
    requestReload: () => false,
  });
  expect(await setup.save('venice', cap)).toMatchObject({ ok: true });
  expect(readJudgeSpending(spendingPath)).toMatchObject({ choice: 'venice', capDollars: cap, spentDollars: 0, stop: null });
  const runtime = resolveJudgeChoiceRuntime(runtimeInput, spending.status());
  expect(runtime.source).toBe('configured');
  if (runtime.source === 'off') throw new Error('Expected the saved Venice lane');
  expect(runtime.lane.kind).toBe('venice');
  expect(builtIn.available()).toBe(true);

  const personalText = 'Orchard CEDAR_CLEAR pruning plan for the apple trees this winter.';
  const privateText = 'Orchard CEDAR_HELD loan balance for account holder Morgan Example.';
  type CompletionBody = { model: string; messages: Array<{ role: string; content: string }> };
  const requests: Array<{ method: string; path: string; authorization: string | null; body?: CompletionBody }> = [];
  let releaseReplies!: () => void;
  const repliesAllowed = new Promise<void>(resolve => { releaseReplies = resolve; });
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const recorded = { method: request.method, path, authorization: request.headers.get('authorization') };
      if (request.method === 'GET' && path === '/api/v1/models') {
        requests.push(recorded);
        return Response.json({ data: [{ id: runtime.lane.modelId, model_spec: { privacy: 'private' } }] });
      }
      const body = await request.json() as CompletionBody;
      requests.push({ ...recorded, body });
      if (request.method !== 'POST' || path !== '/api/v1/chat/completions') return new Response('Unexpected request', { status: 400 });
      const material = body.messages.map(message => message.content).join('\n');
      const personal = material.includes('CEDAR_CLEAR');
      const held = material.includes('CEDAR_HELD');
      if (personal === held) return new Response('Expected exactly one item marker', { status: 400 });
      await repliesAllowed;
      return Response.json({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ verdicts: [{
          i: 1, tier: personal ? 'personal' : 'private', category: personal ? 'ordinary' : 'financial',
          ownRecord: !personal, privateKind: personal ? 'none' : 'financial', confidence: 0.99,
        }] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 800, completion_tokens: 80 },
      });
    },
  });
  cleanup.push(() => { releaseReplies(); server.stop(true); });
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const unexpectedUrls: string[] = [];
  const judgingUrls: string[] = [];
  const toStub = (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.venice.ai' || !['/api/v1/models', '/api/v1/chat/completions'].includes(parsed.pathname)) {
      unexpectedUrls.push(url);
      throw new Error(`Unexpected network request: ${url}`);
    }
    return nativeFetch(new URL(parsed.pathname + parsed.search, server.url), init);
  };
  // The catalog uses global fetch; completions use judgeFetch. Both go only to loopback.
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
    (url: Parameters<typeof fetch>[0], init?: RequestInit) => toStub(String(url), init ?? {}),
    { preconnect: globalThis.fetch.preconnect },
  ));
  cleanup.push(() => fetchSpy.mockRestore());
  const model = createTierSnifferModel({
    lane: runtime.lane,
    olympusConfig: loadConfig(env), env,
    bootSecretResolver: new WorkerBootSecretResolver({
      now: time.date,
      resolveSecretRefValueSync: ref => ref === 'store:venice.api_key' ? env.VENICE_API_KEY : undefined,
    }),
    judgeFetch: spending.fetch((url, init) => { judgingUrls.push(url); return toStub(url, init); }),
    judgeStatus: () => spending.status(),
  });
  if (!model) throw new Error('Expected a ready Venice judge with the placeholder key');
  const installed = configureInstalledTierClassification({ env, lane: runtime.lane, retirePublic: isPublicTierRetired(policy), now: time.date });
  cleanup.push(clearInstalledTierClassification);
  // No vectors: the fresh install has not embedded anything yet. Moves still run through the real service.
  const fixture = openTierFixture(root, { embed: false, now: time.date });
  cleanup.push(() => fixture.close());
  await fixture.set.sync(fixtureConnector(() => [
    { id: 'personal', name: 'CEDAR_CLEAR.txt', text: personalText },
    { id: 'private', name: 'CEDAR_HELD.txt', text: privateText },
  ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  // Keep the local-model counter about judging: optional query translation is unrelated to this proof.
  const remoteSearch = () => withKeywordExpansionDisabled(() => searchReleasedEvidence({
    question: 'orchard',
    releaseCheck: laneReleaseCheck(fixture.ledger, () => fixture.set.openStores()),
    lanes: () => {
      const stores = fixture.set.openStores();
      return {
        registry: buildSourceIndexCorpusRegistry(stores.map(store => defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }))),
        adapters: Object.fromEntries(stores.map(store => [store.corpusId, createConnectorStoreCorpusAdapter({ store })])),
        contentProviders: Object.fromEntries(stores.map(store => [store.corpusId, createConnectorStoreContentProvider({ store })])),
        visibilityGate: createTierVisibilityGate(() => [{ ledger: fixture.ledger, corpusIds: new Set(stores.map(store => store.corpusId)) }]),
      };
    },
  }));
  for (const id of ['personal', 'private']) {
    expect(fixture.ledger.getCurrent(identityOf(id))).toMatchObject({ contentRead: true, contentPending: true });
  }
  expect((await remoteSearch()).evidence).toEqual([]);
  expect(judgingUrls).toHaveLength(0);

  const service = new TierSnifferService({
    installed, lane: runtime.lane, model,
    stores: () => fixture.set.openStores(), classificationLedgerPath,
    now: time.date, timers: time, monotonicNow: time.now,
    autoMoves: { localEmbeddingsOnly: () => true, embeddingLedgerPath: join(root, 'embedding-ledger.jsonl'), maxPerPass: 5 },
  });
  let activePass: ReturnType<typeof service.runOnce> | undefined;
  cleanup.push(async () => { releaseReplies(); service.stop(); await activePass; });
  const started = time.now();
  await time.advance(1_000);
  activePass = service.runOnce();
  await waitFor(() => requests.some(request => request.body), { description: 'Venice judge reaches the loopback stub' });
  expect((await remoteSearch()).evidence).toEqual([]);
  expect(readJudgeSpending(spendingPath).spentDollars).toBeGreaterThan(0);
  releaseReplies();
  expect(await activePass).toMatchObject({ state: 'ran' });

  let released = '';
  for (let pass = 0; pass < 3; pass++) {
    released = JSON.stringify(await remoteSearch());
    expect(released).not.toContain('CEDAR_HELD');
    if (released.includes(personalText)) break;
    await time.advance(1_000);
    activePass = service.runOnce();
    expect(await activePass).toMatchObject({ state: 'ran' });
  }
  expect(released).toContain(personalText);
  expect(time.now() - started).toBeLessThan(60_000);
  expect(fixture.ledger.getCurrent(identityOf('personal'))).toMatchObject({ state: 'current', contentTier: 'private', contentPending: false });
  expect(fixture.ledger.getCurrent(identityOf('private'))).toMatchObject({ state: 'current', contentTier: 'secure', contentPending: false });
  const judgingRequests = requests.filter(request => request.body);
  expect(judgingRequests.length).toBeGreaterThanOrEqual(2);
  expect(judgingRequests).toHaveLength(judgingUrls.length);
  expect(judgingRequests.every(request => request.method === 'POST' && request.path === '/api/v1/chat/completions' && request.body!.model === runtime.lane.modelId)).toBe(true);
  expect(judgingRequests.some(request => JSON.stringify(request.body).includes(personalText))).toBe(true);
  expect(judgingRequests.some(request => JSON.stringify(request.body).includes(privateText))).toBe(true);
  expect(requests.every(request => request.authorization === `Bearer ${env.VENICE_API_KEY}`)).toBe(true);
  expect(unexpectedUrls).toEqual([]);
  expect(localCalls).toBe(0);
  const spent = readJudgeSpending(spendingPath);
  expect(spent).toMatchObject({ choice: 'venice', capDollars: cap, stop: null });
  expect(spent.spentDollars).toBeGreaterThan(0);
  expect(spent.spentDollars).toBeLessThanOrEqual(cap);
});
