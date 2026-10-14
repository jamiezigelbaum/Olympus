// Private answers on this computer (design docs/design/background-agents.md,
// sections A and B, "Dashboard changes" 1 and 2):
//
// - Ask privately and Answer on a waiting question run with every outbound
//   request denied (fetch, node:http/https, node:net/tls): retrieval over
//   real local stores, the built-in embedding model (a local stand-in),
//   passage ranking and synthesis by the built-in model (a canned stand-in
//   behind the real answerPrivately). No planner is called.
// - A store whose vectors came from another model is searched by keyword;
//   a corpus that needs a cloud query, or has no adapter here, is named.
// - Answer and Dismiss: an answer's acknowledgment clears the record only at
//   the generation it read; it is bound to the session it was given to.
// - The worker serves the page's list and its route only to a local control
//   session, and the old Anonymous answers address redirects.
// - The Needs you count reaches only the computer's control session, never
//   the Gateway bearer or ChatGPT, and ChatGPT's dashboard text is unchanged.

import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerPrivately, type BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { routeSourceIndexSearch } from '../src/core/source-index/router.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { openWaitingPrivateQuestionStore, type WaitingQuestionStore } from '../src/core/waiting-private-questions.ts';
import { buildDashboardPreviewView, DASHBOARD_PREVIEW_NOW } from '../scripts/dashboard-preview.ts';
import { COMPUTER_META_KEY, DASHBOARD_TOOL_NAME } from '../src/workers/chatgpt/dashboard-contract.ts';
import { callChatGptTool } from '../src/workers/chatgpt/mcp-surface.ts';
import { createBuiltInPrivateAnswerModel, type PanelAnswerLimits } from '../src/workers/chatgpt/private-answer-model.ts';
import { generatePanelKeyPair, openPrivateAnswer, type SealedPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PrivateAnswerJobs } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { VERSIONED_FIXTURE_ITEMS, versionedFixtureHits } from '../eval/fixtures/versioned-documents.ts';
import { defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT, renderDashboardPrivateAnswersPage } from '../src/workers/dashboard/pages/private-answers.ts';
import { DASHBOARD_COMPUTER_PANEL_COPY } from '../src/workers/dashboard/vocabulary.ts';
import { createDashboardPanelTools, type DashboardPanelTools } from '../src/workers/email-source/dashboard-panel-tools.ts';
import { DASHBOARD_TOOLS_CALL_PATH } from '../src/workers/dashboard/host-page.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createLocalAnswerPath, createLocalPrivateAnswers, type LocalPrivateAnswers } from '../src/workers/email-source/local-private-answers.ts';
import { createSourceAnswerLanes } from '../src/workers/email-source/source-answer-lanes.ts';
import { DASHBOARD_LAUNCH_MINT_PATH, DASHBOARD_LAUNCH_REDEEM_PATH, DashboardLaunchTickets } from '../src/core/dashboard-launch.ts';
import { DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER, DASHBOARD_LOCAL_CONTROL_SESSION_PATH, DASHBOARD_PRIVATE_ANSWERS_PATH, withWorkerBearerAuth } from '../src/workers/http.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import { installBuiltInEmbedding, reportBuiltInEmbeddingState } from '../src/workers/source-index/built-in-embedding/assets.ts';
import { ARCTIC_EMBED_M_V1_5, EMBEDDINGGEMMA_2 } from '../src/workers/source-index/built-in-embedding/manifest.ts';
import { BuiltInEmbeddingNotReadyError, BuiltInSourceEmbeddingProvider, loadedBuiltInEmbedding } from '../src/workers/source-index/built-in-embedding/provider.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import {
  builtInEmbeddingOnly,
  type LocalAnswerRequest,
  type LocalAnswerResult,
} from '../src/workers/source-index/local-answer.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import {
  FIXTURE_PLACEMENT,
  RecordingProvider,
  fixtureConnector,
  identityOf,
  openTierFixture,
  tempDir,
  type FixtureSpec,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
const windows: Window[] = [];
afterEach(async () => {
  while (windows.length) await windows.pop()!.happyDOM.close();
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // Cleanup must not mask a test's own failure.
    }
  }
});

// ---- network denial ----------------------------------------------------------

/** Every outbound path a request could take from this process, refused and recorded. */
function denyNetwork() {
  const attempts: string[] = [];
  const restores: Array<() => void> = [];
  const deny = (target: Record<string, unknown>, key: string, label: string) => {
    const original = target[key];
    target[key] = (..._args: unknown[]) => {
      attempts.push(label);
      throw new Error(`network denied in this test (${label})`);
    };
    restores.push(() => {
      target[key] = original;
    });
  };
  deny(globalThis as unknown as Record<string, unknown>, 'fetch', 'fetch');
  deny(http as unknown as Record<string, unknown>, 'request', 'http.request');
  deny(http as unknown as Record<string, unknown>, 'get', 'http.get');
  deny(https as unknown as Record<string, unknown>, 'request', 'https.request');
  deny(https as unknown as Record<string, unknown>, 'get', 'https.get');
  deny(net as unknown as Record<string, unknown>, 'connect', 'net.connect');
  deny(net as unknown as Record<string, unknown>, 'createConnection', 'net.createConnection');
  deny(tls as unknown as Record<string, unknown>, 'connect', 'tls.connect');
  const restore = () => {
    for (const undo of restores.splice(0).reverse()) undo();
  };
  cleanups.push(restore);
  return { attempts, restore };
}

// ---- the built-in models' stand-ins -------------------------------------------

/** The built-in private model: a canned completion behind the real answerPrivately and Analyst. */
function stubBuiltInModel(text: string, duringSynthesis?: () => Promise<void>) {
  const requests: AnalystModelRequest[] = [];
  const model: BuiltInAnalystModel = {
    name: 'built_in',
    spec: QWEN35_4B,
    async prepare() {},
    status: () => ({ state: 'ready', modelId: QWEN35_4B.modelId, percent: 100, label: '', bytesDone: 0, bytesTotal: 0, updatedAt: new Date(0).toISOString() }),
    async stop() {},
    async complete(request) {
      requests.push(request);
      await duringSynthesis?.();
      return { text, modelId: `built_in/${QWEN35_4B.modelId}` };
    },
  };
  return { model, requests };
}

const LEASE_TEXT = 'SENTINEL_LEASE_9c1e: the orchard flat lease ends on 31 May 2027 and the deposit is held by the agency.';
const DEPOSIT_TEXT = 'SENTINEL_DEPOSIT_9c1e: the deposit for the orchard flat lease was paid in May 2025.';
const INVENTORY_TEXT = 'SENTINEL_INVENTORY_9c1e: the orchard flat inventory lists two chairs and a table.';
/** Private content a local answer may read. */
const PRIVATE_SENTINEL = /SENTINEL_(LEASE|DEPOSIT)_9c1e/;
const SPECS: FixtureSpec[] = [
  { id: 'lease', name: 'orchard-lease.txt', text: LEASE_TEXT, legacyDomain: 'secure_local' },
  { id: 'deposit', name: 'orchard-deposit.txt', text: DEPOSIT_TEXT, legacyDomain: 'secure_local' },
  { id: 'inventory', name: 'orchard-inventory.txt', text: INVENTORY_TEXT, legacyDomain: 'internal' },
];
const ANSWER_JSON = JSON.stringify({
  answer: 'The orchard flat lease ends on 31 May 2027 [1].',
  citations: [{ evidence: 1, claim: 'The lease ends on 31 May 2027.' }],
  unanswered: [],
  sufficient: true,
});
/** A Personal corpus searchable only from the cloud, and one registered with no adapter here. */
const CLOUD_ONLY_CORPUS = 'internal.fixture.cloud_mail';
const NO_ADAPTER_CORPUS = 'secure_local.fixture.elsewhere';
const SOURCE_NAMES: Record<string, string> = { [CLOUD_ONLY_CORPUS]: 'Cloud mail', [NO_ADAPTER_CORPUS]: 'Other files' };

/** A word-count vector: related text scores close, as a real model's would. */
function bagOfWords(text: string, dimension: number): Float32Array {
  const vector = new Float32Array(dimension);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % dimension]! += 1;
  }
  vector[0]! += 0.01;
  return vector;
}

/**
 * The built-in embedding model's state on this computer:
 * - `loaded`: installed and loaded by this process (as warm() leaves it at boot);
 * - `stale_ready_litert` / `stale_ready_onnx`: the status file still says
 *   ready, but the files are gone and nothing is loaded here;
 * - `damaged_runtime`: says ready, files present, but the runtime cannot start.
 */
type BuiltInEmbeddingState = 'loaded' | 'stale_ready_litert' | 'stale_ready_onnx' | 'damaged_runtime';

/**
 * The real built-in embedding provider, its control flow untouched: only the
 * model runtime (a LiteRT helper stand-in) and, where noted, the installer
 * are replaced. Every install and runtime start is recorded; the stale
 * states fall through to the real installer, which downloads what is missing.
 */
async function builtInEmbedding(state: BuiltInEmbeddingState) {
  const { dir, cleanup } = tempDir('olympus-local-embedding-');
  cleanups.push(cleanup);
  const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir };
  const model = state === 'stale_ready_onnx' || state === 'damaged_runtime' ? ARCTIC_EMBED_M_V1_5 : EMBEDDINGGEMMA_2;
  const installs: string[] = [];
  const starts: string[] = [];
  const embedded: string[] = [];
  const provider = new BuiltInSourceEmbeddingProvider({
    env,
    model,
    install: async (options) => {
      installs.push(model.modelId);
      if (state === 'loaded' || state === 'damaged_runtime') {
        return { modelPath: join(dir, 'model.bin'), runtimeDir: dir, libraryPath: join(dir, 'liblitert.so'), vocabularyPath: join(dir, 'vocab.txt') };
      }
      return installBuiltInEmbedding(options);
    },
    liteRt: async () => {
      starts.push('litert');
      return {
        device: 'cpu' as const,
        vision: false,
        async embed(items) {
          return items.map((item) => {
            const text = typeof item === 'string' ? item : item.text;
            embedded.push(text);
            return bagOfWords(text, model.dimension);
          });
        },
        async release() {},
      };
    },
    runtime: () => {
      starts.push('onnx');
      throw new Error('the runtime is damaged');
    },
  });
  if (state === 'loaded') await provider.prepare();
  else reportBuiltInEmbeddingState({ env, model }, 'ready');
  // Vectors under this model's identity, so a search would embed the query with it.
  const vectors: SourceEmbeddingProvider = state === 'loaded'
    ? provider
    : {
      provider: provider.provider,
      modelId: provider.modelId,
      dimension: provider.dimension,
      configHash: provider.configHash,
      epochId: provider.epochId,
      backend: provider.backend,
      embed: async (inputs) => inputs.map((input) => Array.from(bagOfWords(input.text, model.dimension))),
    };
  return { provider, vectors, installs, starts, embedded, env, model };
}

/** Tier-fixture specs with a saved date each, as a file source reports it. */
function datedConnector(specs: readonly FixtureSpec[], dates: Readonly<Record<string, string>>) {
  const base = fixtureConnector(() => specs);
  const dated = <T extends { identity: { providerItemId: string }; metadata: Readonly<Record<string, unknown>> }>(item: T): T => {
    const date = dates[item.identity.providerItemId];
    return date ? { ...item, metadata: Object.freeze({ ...item.metadata, authoredAt: date }) } : item;
  };
  return {
    ...base,
    listItems() {
      const pages = base.listItems();
      return (async function* () {
        for await (const page of pages) yield { ...page, items: page.items.map(dated) };
      })();
    },
    async fetchItem(localItemId: string) {
      return dated(await base.fetchItem(localItemId));
    },
  } as typeof base;
}

/**
 * The worker's own local answer path over a real tier fixture: the shared
 * lane factory server.ts uses (createSourceAnswerLanes, narrowed by
 * `built_in_only`, with the production `loadedBuiltInEmbedding`), and the
 * shared wiring (createLocalAnswerPath). The Private store's vectors are the
 * built-in model's; the Personal store's a cloud model's, which a local
 * answer must never call.
 */
async function localFixture(options: {
  embedding?: BuiltInEmbeddingState;
  specs?: readonly FixtureSpec[];
  privateIds?: readonly string[];
  dates?: Readonly<Record<string, string>>;
  answer?: string;
  limits?: Partial<PanelAnswerLimits>;
  duringSynthesis?: (fixture: TierFixture) => Promise<void>;
  keywordOnly?: boolean;
} = {}) {
  const { dir, cleanup } = tempDir('olympus-local-answer-');
  const fixture = openTierFixture(dir);
  cleanups.push(() => {
    fixture.close();
    cleanup();
  });
  const specs = options.specs ?? SPECS;
  await fixture.set.sync(datedConnector(specs, options.dates ?? {}), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  // The lease papers are Private: their names and contents live in the Private store.
  for (const id of options.privateIds ?? ['lease', 'deposit']) {
    await moveTieredItem({ set: fixture.set, identity: identityOf(id), target: { metadataTier: 'secure', contentTier: 'secure' } });
  }
  const builtIn = await builtInEmbedding(options.embedding ?? 'loaded');
  if (!options.keywordOnly) {
    await fixture.stores.secure_local!.embedChunks({ provider: builtIn.vectors });
    await fixture.stores.internal!.embedChunks({ provider: fixture.cloud });
  }
  const lanes = createSourceAnswerLanes({
    stores: () => fixture.set.openStores(),
    registry: () => buildSourceIndexCorpusRegistry([
      ...fixture.set.openStores().map((store) => defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain })),
      // Searchable only by a cloud query, and registered with no store here.
      defineSourceIndexCorpus({ corpusId: CLOUD_ONLY_CORPUS, family: 'email', trustDomain: 'internal', storageProfileInput: { cloudQueryApproved: true } }),
      defineConnectorCorpus({ corpusId: NO_ADAPTER_CORPUS, family: 'file', trustDomain: 'secure_local' }),
    ]),
    embeddingProvider: (store) => options.keywordOnly ? undefined : (store.trustDomain === 'secure_local' ? builtIn.provider : fixture.cloud),
    localEmbedding: loadedBuiltInEmbedding,
    readScope: () => ({ allowed: true, contentAllowed: true }),
    answerScope: () => ({ kind: 'search' }),
    accountScope: () => undefined,
    visibilityGate: createTierVisibilityGate(() => [{ ledger: fixture.ledger, corpusIds: new Set(fixture.set.openStores().map((store) => store.corpusId)) }]),
  });
  const stub = stubBuiltInModel(options.answer ?? ANSWER_JSON, options.duringSynthesis ? () => options.duringSynthesis!(fixture) : undefined);
  const path = createLocalAnswerPath({
    lanes,
    model: stub.model,
    available: () => true,
    relevanceEmbedding: () => builtInEmbeddingOnly(builtIn.provider, loadedBuiltInEmbedding),
    sourceName: (corpusId) => SOURCE_NAMES[corpusId],
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return { fixture, builtIn, stub, lanes, answer: path.answer, eligible: path.eligible };
}

function waitingStore(): WaitingQuestionStore {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-local-waiting-'));
  const store = openWaitingPrivateQuestionStore(join(dir, 'state', 'waiting-private-questions.sqlite'), { isActive: () => true });
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

// ---- zero egress -----------------------------------------------------------------

/** Lets anything a call left running in the background (a load it started) reach the network first. */
async function backgroundSettled(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('answers on this computer, with every outbound request denied', () => {
  const oweSpec: FixtureSpec = { id: 'owe', name: 'balance.txt', text: 'SENTINEL_OWE: I owe Alex twenty euros.', legacyDomain: 'secure_local' };
  const oweAnswer = JSON.stringify({ answer: 'You owe Alex twenty euros [1].', citations: [{ evidence: 1, claim: 'You owe Alex twenty euros.' }], unanswered: [], sufficient: true });

  test('keyword-only Private: Ask and waiting Answer find owe in a natural question; cloud search stays strict', async () => {
    const local = await localFixture({ specs: [oweSpec], privateIds: ['owe'], keywordOnly: true, answer: oweAnswer });
    const question = 'do i owe anyone anything?';
    const cloudRequest = { question, retrieval_mode: 'keyword' as const, include_secure_local: true, include_secure_local_content: true,
      localKeywordFallback: true, embedding: 'built_in_only' };
    const cloud = local.lanes(cloudRequest);
    const strict = await routeSourceIndexSearch({ registry: cloud.registry, adapters: cloud.adapters,
      request: { query: question, maxResults: 16, context: { allowedTrustDomains: ['secure_local'], allowCloudQueries: false } } });
    expect(strict.hits).toEqual([]);
    const store = waitingStore();
    const ref = store.record(store.ticket('conn-chatgpt'), { question, surface: 'remote', state: 'waiting' })!;
    const controller = createLocalPrivateAnswers({ answer: local.answer, eligible: local.eligible, store: () => store });
    const network = denyNetwork();
    try {
      await controller.tick();
      for (const action of [{ action: 'ask', question }, { action: 'read', id: ref.id }]) {
        const result = await controller.handle(action, 'session:owner');
        expect(result.body).toMatchObject({ ok: true, status: 'answered', answer: 'You owe Alex twenty euros.' });
      }
      expect(JSON.stringify(local.stub.requests)).toContain('SENTINEL_OWE');
      expect(network.attempts).toEqual([]);
    } finally { network.restore(); }
  });

  test('keyword-only local retry prefers strict hits and never adds partial matches when strict hits exist', async () => {
    const strictSpec = { ...oweSpec, id: 'strict', text: 'SENTINEL_STRICT: I owe anyone who lent money.' };
    const local = await localFixture({ specs: [oweSpec, strictSpec], privateIds: ['owe', 'strict'], keywordOnly: true, answer: oweAnswer });
    expect((await local.answer({ question: 'owe anyone' })).status).toBe('answered');
    expect(JSON.stringify(local.stub.requests)).toContain('SENTINEL_STRICT');
    expect(JSON.stringify(local.stub.requests)).not.toContain('SENTINEL_OWE');
  });

  test('keyword-only local retry ignores stopwords and quotes FTS special characters safely', async () => {
    const local = await localFixture({ specs: [oweSpec], privateIds: ['owe'], keywordOnly: true, answer: oweAnswer });
    expect((await local.answer({ question: 'do i me my any anyone anything what who is are the a an to of in on for about does did' })).status).toBe('not_found');
    expect(local.stub.requests).toEqual([]);
    expect((await local.answer({ question: 'do I "owe" anyone anything? : * ( ) + - ^ NEAR("missing")' })).status).toBe('answered');
    expect(JSON.stringify(local.stub.requests)).toContain('SENTINEL_OWE');
  });

  test('relaxed local matches still withdraw an answer when its Private item becomes a Secret', async () => {
    const local = await localFixture({ specs: [oweSpec], privateIds: ['owe'], keywordOnly: true, answer: oweAnswer,
      duringSynthesis: async fixture => { await moveTieredItem({ set: fixture.set, identity: identityOf('owe'), target: { metadataTier: 'secrets', contentTier: 'secrets' } }); } });
    expect(await local.answer({ question: 'do i owe anyone anything?' })).toEqual({ status: 'changed' });
  });

  test('local OR retry ranks by bm25, caps eight meaningful terms, and drops short terms', async () => {
    const specs: FixtureSpec[] = [oweSpec,
      { ...oweSpec, id: 'rich', name: 'record.txt', text: 'I owe money and owe money.' },
      { ...oweSpec, id: 'short', name: 'short.txt', text: 'xx ox' },
      { ...oweSpec, id: 'ninth', name: 'last.txt', text: 'zephyr' },
    ];
    const local = await localFixture({ specs, privateIds: specs.map(spec => spec.id), keywordOnly: true, answer: oweAnswer });
    const search = async (query: string) => {
      const lanes = local.lanes({ question: query, retrieval_mode: 'keyword' }, 'built_in_only');
      return routeSourceIndexSearch({ registry: lanes.registry, adapters: lanes.adapters,
        request: { query, maxResults: 16, context: { allowedTrustDomains: ['secure_local'], allowCloudQueries: false } } });
    };
    const ranked = await search('do I owe anyone money?');
    expect(ranked.hits.map(hit => hit.sourceItem.localItemId)).toEqual(['personal:rich', 'personal:owe']);
    expect(ranked.hits[0]!.score!).toBeGreaterThan(ranked.hits[1]!.score!);
    const bounded = await search('alpha beta gamma delta epsilon zeta theta kappa zephyr');
    expect(bounded.hits).toEqual([]);
    const short = await search('do I xx ox owe anyone anything?');
    expect(short.hits.map(hit => hit.sourceItem.localItemId).sort()).toEqual(['personal:owe', 'personal:rich']);
  });

  test('Ask privately: retrieval, the built-in embedding, passage ranking and synthesis all run here', async () => {
    const local = await localFixture();
    const installsBefore = local.builtIn.installs.length;
    const embeddedBefore = local.builtIn.embedded.length;
    const cloudBefore = local.fixture.cloud.inputs.length;
    const network = denyNetwork();
    const controller = createLocalPrivateAnswers({ answer: local.answer, eligible: local.eligible, store: () => undefined });
    const outcome = await controller.handle({ action: 'ask', question: 'When does the orchard flat lease end?' }, 'session:owner');
    await backgroundSettled();
    network.restore();

    expect(network.attempts).toEqual([]);
    expect(local.builtIn.installs.length).toBe(installsBefore);
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ ok: true, status: 'answered', answer: 'The orchard flat lease ends on 31 May 2027.' });
    // The Private passage reached synthesis, on the built-in model.
    expect(local.stub.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(local.stub.requests)).toMatch(PRIVATE_SENTINEL);
    // The question and the passages were embedded by the built-in model already loaded here.
    const embedded = local.builtIn.embedded.slice(embeddedBefore);
    expect(embedded.some((text) => text.includes('When does the orchard flat lease end?'))).toBe(true);
    expect(embedded.some((text) => PRIVATE_SENTINEL.test(text))).toBe(true);
    // The store whose vectors came from another (cloud) model was searched by keyword: its model saw nothing.
    expect(local.fixture.cloud.inputs.slice(cloudBefore)).toEqual([]);
    // What could not be searched here is named.
    expect(outcome.body.left_out).toEqual(['Cloud mail', 'Other files']);
    // A citation names its source and never carries a path.
    expect(JSON.stringify(outcome.body.citations)).not.toContain('/Files/');
  });

  test('Answer on a waiting question: the same local path, with the question\'s own selectors', async () => {
    const local = await localFixture();
    const installsBefore = local.builtIn.installs.length;
    const store = waitingStore();
    const ref = store.record(store.ticket('conn-chatgpt'), { question: 'When does the orchard flat lease end?', surface: 'remote', state: 'waiting' })!;
    const network = denyNetwork();
    const controller = createLocalPrivateAnswers({ answer: local.answer, eligible: local.eligible, store: () => store, connectionName: () => 'ChatGPT' });
    await controller.tick();
    const outcome = await controller.handle({ action: 'read', id: ref.id }, 'session:owner');
    const seen = await controller.handle({ action: 'seen', id: ref.id, generation: outcome.body.generation }, 'session:owner');
    await backgroundSettled();
    network.restore();

    expect(network.attempts).toEqual([]);
    expect(local.builtIn.installs.length).toBe(installsBefore);
    expect(outcome.body).toMatchObject({ ok: true, status: 'answered' });
    expect(JSON.stringify(local.stub.requests)).toMatch(PRIVATE_SENTINEL);
    expect(seen.body).toEqual({ ok: true, status: 'read' });
    expect(store.get(ref.id)?.seen).toBe(true);
  });

  for (const state of ['stale_ready_litert', 'stale_ready_onnx', 'damaged_runtime'] as const) {
    test(`the built-in model not loaded here (${state}): Ask and Answer search by keyword; nothing installs, downloads or starts`, async () => {
      const local = await localFixture({ embedding: state });
      const store = waitingStore();
      const ref = store.record(store.ticket('conn-chatgpt'), { question: 'When does the orchard flat lease end?', surface: 'remote', state: 'waiting' })!;
      const statusBefore = local.builtIn.provider.status();
      const network = denyNetwork();
      const controller = createLocalPrivateAnswers({ answer: local.answer, eligible: local.eligible, store: () => store, connectionName: () => 'ChatGPT' });
      const asked = await controller.handle({ action: 'ask', question: 'When does the orchard flat lease end?' }, 'session:owner');
      await controller.tick();
      const answered = await controller.handle({ action: 'read', id: ref.id }, 'session:owner');
      await backgroundSettled();
      network.restore();

      expect(network.attempts).toEqual([]);
      expect(local.builtIn.installs).toEqual([]);
      expect(local.builtIn.starts).toEqual([]);
      expect(local.builtIn.embedded).toEqual([]);
      // The status file is as it was: nothing reported loading, failing or downloading.
      expect(local.builtIn.provider.status()).toEqual(statusBefore);
      for (const outcome of [asked, answered]) {
        expect(outcome.body).toMatchObject({ ok: true, status: 'answered', answer: 'The orchard flat lease ends on 31 May 2027.' });
      }
      expect(JSON.stringify(local.stub.requests)).toMatch(PRIVATE_SENTINEL);
    });
  }

  test('the denial itself works: a fetch from inside it is refused and recorded', async () => {
    const network = denyNetwork();
    await expect(Promise.resolve().then(() => fetch('https://example.com/'))).rejects.toThrow('network denied');
    expect(() => http.request('http://example.com/')).toThrow('network denied');
    network.restore();
    expect(network.attempts).toEqual(['fetch', 'http.request']);
  });

  test('a model reached over HTTP is never the local embedding; the built-in one only as already loaded', async () => {
    const cloud = new RecordingProvider('google-gemini', 'gemini-embedding-2', 'cloud');
    const server = new RecordingProvider('openai-compatible', 'secure-local-qwen3-embed', 'local');
    expect(builtInEmbeddingOnly(cloud, () => cloud)).toBeUndefined();
    expect(builtInEmbeddingOnly(server, loadedBuiltInEmbedding)).toBeUndefined();
    expect(builtInEmbeddingOnly(undefined, loadedBuiltInEmbedding)).toBeUndefined();
    expect(builtInEmbeddingOnly(server, () => { throw new Error('unreadable'); })).toBeUndefined();
    // Not loaded: the query fails at once (the lane then searches by keyword), and no load starts.
    const stale = await builtInEmbedding('stale_ready_litert');
    const narrowed = builtInEmbeddingOnly(stale.provider, loadedBuiltInEmbedding)!;
    expect(narrowed.modelId).toBe(stale.provider.modelId);
    await expect(narrowed.embed([{ text: 'q' }], { taskType: 'RETRIEVAL_QUERY' })).rejects.toBeInstanceOf(BuiltInEmbeddingNotReadyError);
    await expect(narrowed.embed([{ text: 'd' }], { taskType: 'RETRIEVAL_DOCUMENT' })).rejects.toBeInstanceOf(BuiltInEmbeddingNotReadyError);
    await backgroundSettled();
    expect(stale.installs).toEqual([]);
  });

  test('nothing here answers it: not found, with what was left out', async () => {
    const local = await localFixture();
    // Keyword only: the stand-in embedding finds everything "similar".
    const result = await local.answer({ question: 'zebra quartz xylophone', selectors: { retrieval_mode: 'keyword' } });
    expect(result).toEqual({ status: 'not_found', leftOut: ['Cloud mail', 'Other files'] });
    expect(local.stub.requests).toEqual([]);
  });
});

// ---- the version note's other versions -----------------------------------------

/** The offer as a signed final and an earlier draft: the panel reads one, and its note names the other. */
const OFFER_IDS = ['offer-v3', 'offer-v1'] as const;
const OFFER_SPECS: FixtureSpec[] = OFFER_IDS.map((id) => {
  const item = VERSIONED_FIXTURE_ITEMS.find((candidate) => candidate.id === id)!;
  return { id, name: item.title, text: item.text, legacyDomain: 'secure_local' as const };
});
const OFFER_DATES = Object.fromEntries(OFFER_IDS.map((id) => [id, VERSIONED_FIXTURE_ITEMS.find((candidate) => candidate.id === id)!.saved]));
const OFFER_ANSWER = JSON.stringify({ answer: 'The price is €620,000 [1].', citations: [{ evidence: 1, claim: 'Price €620,000' }], unanswered: [], sufficient: true });
/** One item read: the newest version, with the draft as an unread other version. */
const ONE_ITEM = { maxItems: 1, maxLeadingItems: 0 };
const VERSION_NOTE = /Several versions of .* were found/;

test('a stored inbox answer citing a real item moved to Secrets is never displayed', async () => {
  const local = await localFixture({ specs: OFFER_SPECS, privateIds: OFFER_IDS, dates: OFFER_DATES, answer: OFFER_ANSWER, limits: ONE_ITEM, embedding: 'stale_ready_litert' });
  const store = waitingStore();
  const ref = store.record(store.ticket('conn-agent'), { question: 'What purchase price is in the offer for 14 Larch Court?', surface: 'remote', state: 'waiting' })!;
  const controller = createLocalPrivateAnswers({ answer: local.answer, eligible: local.eligible, store: () => store });
  await controller.tick();
  expect(store.get(ref.id)?.result?.answer).toMatch(VERSION_NOTE);
  await moveTieredItem({ set: local.fixture.set, identity: identityOf('offer-v1'), target: { metadataTier: 'secrets', contentTier: 'secrets' } });
  const read = await controller.handle({ action: 'read', id: ref.id }, 'session:owner');
  expect(read.body).toEqual({ ok: true, status: 'answering' });
  expect(read.body).not.toHaveProperty('answer');
  expect(JSON.stringify(read.body)).not.toMatch(VERSION_NOTE);
  controller.close();
});

describe('another version the answer\'s note names is checked again before anything is shown', () => {
  test('on this computer: a version re-tiered to Secrets while the answer is written withdraws it', async () => {
    const control = await localFixture({ specs: OFFER_SPECS, privateIds: OFFER_IDS, dates: OFFER_DATES, answer: OFFER_ANSWER, limits: ONE_ITEM, embedding: 'stale_ready_litert' });
    const shown = await control.answer({ question: 'What purchase price is in the offer for 14 Larch Court?' });
    // Without a change, the note names the other version.
    expect(shown).toMatchObject({ status: 'answered' });
    expect(shown.status === 'answered' ? shown.answer : '').toMatch(VERSION_NOTE);
    // Only the newest version was read; the draft's price never reached the model.
    expect(JSON.stringify(control.stub.requests)).not.toContain('€640,000');

    const local = await localFixture({
      specs: OFFER_SPECS,
      privateIds: OFFER_IDS,
      dates: OFFER_DATES,
      answer: OFFER_ANSWER,
      limits: ONE_ITEM,
      embedding: 'stale_ready_litert',
      duringSynthesis: async (fixture) => {
        await moveTieredItem({ set: fixture.set, identity: identityOf('offer-v1'), target: { metadataTier: 'secrets', contentTier: 'secrets' } });
      },
    });
    expect(await local.answer({ question: 'What purchase price is in the offer for 14 Larch Court?' })).toEqual({ status: 'changed' });
  });

  test('in ChatGPT\'s private answer panel: the same version re-tiered while the answer is written: that answer is discarded and the one sealed no longer names it', async () => {
    const run = async (retierDuringSynthesis: boolean) => {
      const secret = new Set<string>();
      const checked: string[][] = [];
      const eligible = async (items: readonly Readonly<Record<string, unknown>>[]) => {
        const ids = items.map((item) => String((item.sourceItem as { localItemId?: unknown } | undefined)?.localItemId));
        checked.push(ids);
        return ids.map((id) => !secret.has(id));
      };
      const stub = stubBuiltInModel(OFFER_ANSWER, async () => {
        if (retierDuringSynthesis) secret.add('offer-v1');
      });
      const model = createBuiltInPrivateAnswerModel({ model: stub.model, available: () => true, answer: answerPrivately, eligible, limits: ONE_ITEM });
      const jobs = new PrivateAnswerJobs({ eligible, model: () => model, installId: () => 'c'.repeat(32), claimHoldMs: 0, log: () => {} });
      const evidence = versionedFixtureHits([...OFFER_IDS]);
      const { jobId } = jobs.begin({ question: 'What purchase price is in the offer for 14 Larch Court?', count: 2, evidence, refresh: async () => evidence });
      const panel = await generatePanelKeyPair();
      let response = await jobs.claim(jobId!, panel.publicKey);
      for (let attempt = 0; attempt < 40 && response.status === 202; attempt += 1) {
        await Bun.sleep(25);
        response = await jobs.claim(jobId!, panel.publicKey);
      }
      expect(response.body.status).toBe('ready');
      const opened = JSON.parse(await openPrivateAnswer(jobId!, panel.privateKey, response.body as unknown as SealedPrivateAnswer)) as { answer: string };
      return { answer: opened.answer, stub, checked };
    };
    const control = await run(false);
    expect(control.answer).toMatch(VERSION_NOTE);
    expect(control.stub.requests).toHaveLength(1);

    // The draft is re-tiered while the answer is written: the check before
    // sealing covers it, so that answer (and its note) is discarded, and the
    // one sealed is computed again from what is eligible now, the draft gone.
    const retiered = await run(true);
    expect(retiered.checked).toContainEqual(['offer-v3', 'offer-v1']);
    expect(retiered.stub.requests).toHaveLength(2);
    expect(retiered.answer).toBe('The price is €620,000.');
    expect(retiered.answer).not.toMatch(VERSION_NOTE);
  });
});

// ---- Answer and Dismiss -----------------------------------------------------------

/** A controller over a real waiting store, with a scripted answer. */
function scripted(result: LocalAnswerResult = {
  status: 'answered',
  answer: 'An answer.',
  citations: [{ title: 'Lease', source: 'Dropbox' }],
  unanswered: [],
  leftOut: [],
  read: [],
}) {
  const store = waitingStore();
  const asked: LocalAnswerRequest[] = [];
  const controller = createLocalPrivateAnswers({
    answer: async (input) => {
      asked.push(input);
      return result;
    },
    store: () => store,
  });
  return { store, controller, asked };
}

describe('the private inbox local session', () => {
  test('a question asked here is never recorded as waiting', async () => {
    const { store, controller } = scripted();
    await controller.handle({ action: 'ask', question: 'Where is the lease?' }, 'session:owner');
    expect(store.list().questions).toEqual([]);
    expect((await controller.handle({ action: 'ask', question: '   ' }, 'session:owner')).status).toBe(400);
    expect((await controller.handle({ action: 'ask', question: 'x'.repeat(2_001) }, 'session:owner')).status).toBe(400);
  });

  test('the list says who asked and when, without a connection id', () => {
    const store = waitingStore();
    store.record(store.ticket('conn-a'), { question: 'Where is the lease?', surface: 'remote', state: 'unchecked' });
    store.record(store.ticket('conn-b'), { question: 'When is the dentist?', surface: 'remote', state: 'waiting' });
    const controller = createLocalPrivateAnswers({
      answer: async () => ({ status: 'failed' }),
      store: () => store,
      connectionName: (id) => (id === 'conn-a' ? 'Grok Bot' : undefined),
      now: () => Date.now() + 31_000,
    });
    const listed = controller.waiting()!;
    expect(listed.questions.map(({ question, from, unchecked }) => ({ question, from, unchecked })).sort((a, b) => a.question.localeCompare(b.question))).toEqual([
      { question: 'When is the dentist?', from: 'An agent', unchecked: false },
      { question: 'Where is the lease?', from: 'Grok Bot', unchecked: true },
    ]);
    expect(JSON.stringify(listed)).not.toContain('conn-');
  });

  test('a cited file opens only for the session it was shown to, and only while what the answer read is still readable', async () => {
    const opened: string[] = [];
    let readable = true;
    const read = [{ corpusId: 'secure_local.x', trustDomain: 'secure_local' }] as never;
    const controller = createLocalPrivateAnswers({
      answer: async () => ({ status: 'answered', answer: 'A.', citations: [{ title: 'Lease', localPath: import.meta.path }], unanswered: [], leftOut: [], read }),
      store: () => undefined,
      eligible: async (items) => items.map(() => readable),
      openFile: async (path) => {
        opened.push(path);
      },
    });
    const answered = await controller.handle({ action: 'ask', question: 'Where is the lease?' }, 'session:owner');
    const citations = answered.body.citations as Array<{ open?: string }>;
    expect(JSON.stringify(answered.body)).not.toContain(import.meta.path);
    const token = citations[0]!.open!;
    expect((await controller.handle({ action: 'open', token }, 'session:other')).status).toBe(410);
    expect((await controller.handle({ action: 'open', token }, 'session:owner')).body).toEqual({ ok: true, status: 'opened' });
    expect(opened).toEqual([import.meta.path]);
    readable = false;
    expect((await controller.handle({ action: 'open', token }, 'session:owner')).status).toBe(410);
    expect(opened).toHaveLength(1);
  });

  test('local private open rechecks eligibility after desktop preparation', async () => {
    let readable = true;
    const read = [{ corpusId: 'secure_local.x', trustDomain: 'secure_local' }] as never;
    const controller = createLocalPrivateAnswers({
      answer: async () => ({ status: 'answered', answer: 'A.', citations: [{ localPath: import.meta.path }], unanswered: [], leftOut: [], read }),
      store: () => undefined,
      eligible: async items => items.map(() => readable),
      openFile: async (_path, eligible) => {
        readable = false;
        expect(await eligible()).toBe(false);
        throw new Error('revoked');
      },
    });
    const answered = await controller.handle({ action: 'ask', question: 'Source?' }, 'session:owner');
    const token = (answered.body.citations as Array<{ open: string }>)[0]!.open;
    expect((await controller.handle({ action: 'open', token }, 'session:owner')).status).toBe(500);
  });

  test('one answer at a time: a second waits its turn', async () => {
    let release: () => void = () => undefined;
    const controller = createLocalPrivateAnswers({
      answer: () => new Promise<LocalAnswerResult>((resolve) => {
        release = () => resolve({ status: 'failed' });
      }),
      store: () => undefined,
    });
    const first = controller.handle({ action: 'ask', question: 'One?' }, 'session:owner');
    expect((await controller.handle({ action: 'ask', question: 'Two?' }, 'session:owner')).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });
});

// ---- the worker: page, route, redirect --------------------------------------------

const ORIGIN = 'http://127.0.0.1:28191';
const TOKEN = 'worker-secret';

function worker(privateAnswers: LocalPrivateAnswers | undefined, panelTools?: DashboardPanelTools) {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-private-answers-worker-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const created = createEmailSourceWorker({
    sourceIndexStatus: {
      async status() {
        return {
          kind: 'source_index_status',
          generated_at: DASHBOARD_PREVIEW_NOW.toISOString(),
          corpora: [],
          policy: {
            read_only: true, raw_source_exposed: false, source_packets_exposed: false,
            source_text_returned: false, secure_local_item_metadata_exposed: false, castor_visible: true,
          },
        } as unknown as SourceIndexStatusResult;
      },
    },
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only')),
      registryPath: join(dir, 'handles.json'),
      registryAdoptionIntervalMs: 0,
      ...(privateAnswers ? { privateAnswers } : {}),
      ...(panelTools ? { panelTools } : {}),
    },
  });
  cleanups.push(() => created.close?.());
  return withWorkerBearerAuth((request: Request) => created.fetch(request), { authToken: TOKEN, launchTickets: new DashboardLaunchTickets() });
}

type Fetcher = (request: Request) => Promise<Response>;

async function localSession(fetcher: Fetcher): Promise<{ cookie: string; csrf: string }> {
  const request = new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: ORIGIN } });
  recordRequestPeer(request, '127.0.0.1');
  const mint = await fetcher(request);
  expect(mint.status).toBe(200);
  return { cookie: mint.headers.get('Set-Cookie')!.split(';')[0]!, csrf: ((await mint.json()) as { csrf_token: string }).csrf_token };
}

async function bearerSession(fetcher: Fetcher): Promise<{ cookie: string; csrf: string }> {
  const mint = await fetcher(new Request(`${ORIGIN}/dashboard/control/session`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } }));
  expect(mint.status).toBe(200);
  return { cookie: mint.headers.get('Set-Cookie')!.split(';')[0]!, csrf: ((await mint.json()) as { csrf_token: string }).csrf_token };
}

async function launchSession(fetcher: Fetcher): Promise<{ cookie: string; csrf: string }> {
  const mint = await fetcher(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_MINT_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } }));
  expect(mint.status).toBe(200);
  const { ticket } = (await mint.json()) as { ticket: string };
  const redeemed = await fetcher(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_REDEEM_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ ticket }),
  }));
  expect(redeemed.status).toBe(200);
  return { cookie: redeemed.headers.get('Set-Cookie')!.split(';')[0]!, csrf: ((await redeemed.json()) as { csrf_token: string }).csrf_token };
}

function post(body: unknown, headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}${DASHBOARD_PRIVATE_ANSWERS_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function page(fetcher: Fetcher, headers: Record<string, string>, query = 'private-answers'): Promise<Response> {
  return fetcher(new Request(`${ORIGIN}/dashboard?${query}`, { headers: { Referer: `${ORIGIN}/dashboard`, ...headers } }));
}

describe('the worker serves Private answers only inside a local control session', () => {
  test('the route: the Gateway bearer and every session it can mint are refused and nothing runs; a local session answers', async () => {
    const { store, controller } = scripted();
    const ref = store.record(store.ticket('conn-a'), { question: 'Where is the lease?', surface: 'remote', state: 'waiting' })!;
    const calls: string[] = [];
    const counted: LocalPrivateAnswers = {
      ...controller,
      handle: (body, session) => {
        calls.push(String(body.action));
        return controller.handle(body, session);
      },
    };
    const fetcher = worker(counted);
    const bearerMinted = await bearerSession(fetcher);
    const launched = await launchSession(fetcher);
    const body = { action: 'delete', id: ref.id };
    expect((await fetcher(post(body, { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN }))).status).toBe(403);
    for (const session of [bearerMinted, launched]) {
      const refused = await fetcher(post(body, { Cookie: session.cookie, Origin: ORIGIN, 'X-Olympus-CSRF': session.csrf }));
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('mac_dashboard_only');
    }
    // Deep-link locators carry no authority: every answer read/list uses the
    // same local-only boundary, including widgets and dash_ read-only viewers.
    for (const action of [{ action: 'read', id: ref.id }, { action: 'list' }]) {
      expect((await fetcher(post(action, { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN }))).status).toBe(403);
      expect((await fetcher(post(action, { Authorization: 'Bearer dash_reader', Origin: ORIGIN }))).status).toBe(401);
      expect((await fetcher(post(action, { Origin: 'https://chatgpt.com' }))).status).toBe(401);
      for (const session of [bearerMinted, launched]) expect((await fetcher(post(action, { Cookie: session.cookie, Origin: ORIGIN, 'X-Olympus-CSRF': session.csrf }))).status).toBe(403);
    }
    // No session at all, or the wrong CSRF token.
    expect((await fetcher(post(body, { Origin: ORIGIN }))).status).toBe(401);
    const local = await localSession(fetcher);
    expect((await fetcher(post(body, { Cookie: local.cookie, Origin: ORIGIN, 'X-Olympus-CSRF': 'wrong' }))).status).toBe(403);
    expect(calls).toEqual([]);
    expect(store.list().questions).toHaveLength(1);

    const ok = await fetcher(post(body, { Cookie: local.cookie, Origin: ORIGIN, 'X-Olympus-CSRF': local.csrf }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(await ok.json()).toEqual({ ok: true, status: 'deleted', removed: 1 });
    expect(calls).toEqual(['delete']);
    expect(store.list().questions).toEqual([]);
  });

  test('the page lists waiting questions only for a local session', async () => {
    const { store, controller } = scripted();
    store.record(store.ticket('conn-a'), { question: 'SENTINEL_WAITING_QUESTION where is the lease?', surface: 'remote', state: 'waiting' });
    const fetcher = worker(controller);
    const local = await localSession(fetcher);
    const unlocked = await (await page(fetcher, { Cookie: local.cookie })).text();
    expect(unlocked).toContain('SENTINEL_WAITING_QUESTION');
    expect(unlocked).toContain('data-pa-ask');
    expect(unlocked).toContain('An agent');

    const bearerMinted = await bearerSession(fetcher);
    const offered = await (await page(fetcher, { Cookie: bearerMinted.cookie })).text();
    expect(offered).not.toContain('SENTINEL_WAITING_QUESTION');
    expect(offered).toContain('data-pa-unlock');
    const bearer = await (await page(fetcher, { Authorization: `Bearer ${TOKEN}` })).text();
    expect(bearer).not.toContain('SENTINEL_WAITING_QUESTION');
    expect(bearer).toContain('data-pa-locked');
  });

  test('the old Anonymous answers address opens Private answers at its Anonymous answers section, keeping only a dash_ token', async () => {
    const fetcher = worker(undefined);
    const moved = await page(fetcher, { Authorization: `Bearer ${TOKEN}` }, 'outside-help');
    expect(moved.status).toBe(302);
    expect(moved.headers.get('Location')).toBe(`/dashboard?private-answers#${DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT}`);
    const withToken = await page(fetcher, { Authorization: `Bearer ${TOKEN}` }, 'outside-help&token=dash_abc');
    expect(withToken.headers.get('Location')).toBe(`/dashboard?private-answers&token=dash_abc#${DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT}`);
    const other = await page(fetcher, { Authorization: `Bearer ${TOKEN}` }, 'outside-help&token=worker-secret');
    expect(other.headers.get('Location')).toBe(`/dashboard?private-answers#${DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT}`);
    // The new page holds the Anonymous answers section the fragment opens.
    const html = await (await page(fetcher, { Authorization: `Bearer ${TOKEN}` })).text();
    expect(html).toContain(`id="${DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT}"`);
  });

  test('without the local answer path the route says so inside a local session', async () => {
    const fetcher = worker(undefined);
    const local = await localSession(fetcher);
    expect((await fetcher(post({ action: 'ask', question: 'x' }, { Cookie: local.cookie, Origin: ORIGIN, 'X-Olympus-CSRF': local.csrf }))).status).toBe(501);
  });
});

// ---- Needs you: computer only -------------------------------------------------------

describe('the waiting count reaches only the computer\'s control session', () => {
  const view = buildDashboardPreviewView('partial');
  function tools(waiting: number) {
    return createDashboardPanelTools({
      surface: () => ({ dashboardView: async () => view }) as never,
      setup: {} as never,
      workerFetch: async () => { throw new Error('the dashboard read calls no worker route'); },
      makeContext: () => ({}) as never,
      indexFasterState: async () => undefined,
      waitingPrivateQuestions: () => waiting,
    });
  }
  const metaOf = (result: unknown) => ((result as { _meta?: unknown })._meta as Record<string, Record<string, unknown>> | undefined)?.[COMPUTER_META_KEY];

  test('a local session gets the count; any other session, the Gateway bearer and a locked reader do not', async () => {
    const panel = tools(2);
    expect(metaOf(await panel.call(DASHBOARD_TOOL_NAME, {}, { origin: ORIGIN, opener: 'session:owner', localSession: true }))?.waitingPrivateQuestions).toBe(2);
    // A session that is not local grade (a bearer mint or a launch ticket).
    expect(metaOf(await panel.call(DASHBOARD_TOOL_NAME, {}, { origin: ORIGIN, opener: 'session:owner' }))?.waitingPrivateQuestions).toBeUndefined();
    expect(metaOf(await panel.call(DASHBOARD_TOOL_NAME, {}, { origin: ORIGIN, opener: 'bearer' }))?.waitingPrivateQuestions).toBeUndefined();
    expect(metaOf(await panel.call(DASHBOARD_TOOL_NAME, {}, { origin: ORIGIN }))?.waitingPrivateQuestions).toBeUndefined();
    // Nothing waiting: no count at all.
    expect(metaOf(await tools(0).call(DASHBOARD_TOOL_NAME, {}, { origin: ORIGIN, opener: 'session:owner', localSession: true }))?.waitingPrivateQuestions).toBeUndefined();
  });

  test('through the HTTP boundary: only a local session\'s tool call carries the count; a bearer-minted or launch-ticket session, the bearer, and a forged grade header get nothing', async () => {
    const fetcher = worker(undefined, tools(2));
    const call = (headers: Record<string, string>) => fetcher(new Request(`${ORIGIN}${DASHBOARD_TOOLS_CALL_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
      body: JSON.stringify({ name: DASHBOARD_TOOL_NAME, arguments: {} }),
    }));
    const countVia = async (headers: Record<string, string>) => {
      const response = await call(headers);
      expect(response.status).toBe(200);
      return metaOf(await response.json())?.waitingPrivateQuestions;
    };
    const local = await localSession(fetcher);
    expect(await countVia({ Cookie: local.cookie, 'X-Olympus-CSRF': local.csrf })).toBe(2);
    // A bearer holder mints a session, then calls with its cookie and CSRF and no Authorization.
    const bearerMinted = await bearerSession(fetcher);
    expect(await countVia({ Cookie: bearerMinted.cookie, 'X-Olympus-CSRF': bearerMinted.csrf })).toBeUndefined();
    const launched = await launchSession(fetcher);
    expect(await countVia({ Cookie: launched.cookie, 'X-Olympus-CSRF': launched.csrf })).toBeUndefined();
    expect(await countVia({ Authorization: `Bearer ${TOKEN}` })).toBeUndefined();
    // The grade header is the boundary's alone: a caller's own copy is stripped.
    expect(await countVia({ Cookie: bearerMinted.cookie, 'X-Olympus-CSRF': bearerMinted.csrf, [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local' })).toBeUndefined();
    expect(await countVia({ Authorization: `Bearer ${TOKEN}`, [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local' })).toBeUndefined();
  });

  test('ChatGPT\'s dashboard result, and every word its model reads, is the same whether or not questions wait', async () => {
    const chatgpt = await callChatGptTool(DASHBOARD_TOOL_NAME, {}, {} as never, { dashboardView: async () => view } as never, new AbortController().signal);
    const computer = await tools(3).call(DASHBOARD_TOOL_NAME, {}, { origin: ORIGIN, opener: 'session:owner', localSession: true });
    const { [COMPUTER_META_KEY]: computerOnly, ...sharedMeta } = (computer._meta ?? {}) as Record<string, unknown>;
    expect((computerOnly as Record<string, unknown>).waitingPrivateQuestions).toBe(3);
    // Everything but the computer's own key is ChatGPT's result, unchanged.
    expect(computer.content).toEqual(chatgpt.content);
    expect(computer.structuredContent).toEqual(chatgpt.structuredContent);
    expect(sharedMeta).toEqual((chatgpt._meta ?? {}) as Record<string, unknown>);
    const modelText = JSON.stringify([chatgpt.content, chatgpt.structuredContent]);
    expect(modelText).not.toMatch(/private questions? (is|are) waiting/i);
    expect(modelText).not.toContain(DASHBOARD_COMPUTER_PANEL_COPY.waiting.one);
  });
});

// ---- the page's own script ----------------------------------------------------------

describe('the Private answers page', () => {
  function renderAndRun(answer: (body: Record<string, unknown>) => { status: number; body: unknown }, url = 'http://127.0.0.1:8010/dashboard?private-answers', markdown = true) {
    const html = renderDashboardPrivateAnswersPage({
      now: DASHBOARD_PREVIEW_NOW,
      controlSessionCsrfToken: 'csrf-token',
      outsideHelpLocalSession: true,
      privateAnswers: {
        available: true,
        waiting: {
          questions: [{ id: 'wq_1', question: 'Where is the lease?', from: 'ChatGPT', askedAt: new Date(DASHBOARD_PREVIEW_NOW.getTime() - 2 * 3_600_000).toISOString(), unchecked: false, state: 'answered', unread: true }],
          olderRemoved: true,
        },
      },
    });
    const window = new Window({ url });
    windows.push(window);
    const document = window.document;
    const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
    document.body.innerHTML = body.replace(/^<body[^>]*>/, '').replace(/<script>[\s\S]*?<\/script>/g, '');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).find((code) => code.includes('[data-private-answers]'))!;
    const posts: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetchStub = async (target: string, init: { headers: Record<string, string>; body: string }) => {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      posts.push({ url: target, headers: init.headers, body: parsed });
      const reply = answer(parsed);
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
    };
    const timers: Array<() => Promise<void>> = [];
    let confirmations = 0;
    const pageWindow = { location: window.location, confirm: () => { confirmations++; return true; }, addEventListener: () => undefined, setTimeout: (callback: () => Promise<void>) => { timers.push(callback); } };
    new Function('window', 'document', 'fetch', script)(pageWindow, document, fetchStub);
    if (!markdown) (pageWindow as { olympusMarkdown?: unknown }).olympusMarkdown = undefined;
    return { html, document, posts, confirmations: () => confirmations, poll: async () => { await timers.shift()?.(); }, settle: () => new Promise((resolve) => setTimeout(resolve, 20)) };
  }

  test('Ask renders Markdown safely in a panel under its question, with ordered section headings', async () => {
    const page = renderAndRun(() => ({ status: 200, body: {
      ok: true, status: 'answered', answer: '**Renewal**\n\n- May\n- June\n\n<img src=x onerror=alert(1)>',
      citations: [{ title: 'Lease', source: 'Dropbox' }], left_out: ['Gmail'],
    } }));
    expect([...page.document.querySelectorAll('.pa h3')].map((node) => node.textContent)).toEqual([
      'Ask privately', 'Private inbox', 'Anonymous answers',
    ]);
    const field = page.document.querySelector('textarea')!;
    (field as unknown as { value: string }).value = 'When do I renew?';
    page.document.querySelector('form[data-pa-ask]')!.dispatchEvent(new page.document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
    await page.settle();
    const card = page.document.querySelector('form[data-pa-ask] .pacard')!;
    expect(card.querySelector('.paquestion strong')!.textContent).toBe('When do I renew?');
    expect(card.querySelector('.paanswer strong')!.textContent).toBe('Renewal');
    expect(card.querySelectorAll('.paanswer ul li').length).toBe(2);
    expect(card.querySelector('.paanswer')!.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.pameta')!.textContent).toContain('Lease');
    expect(card.querySelector('.pameta')!.textContent).toContain('Left out: Gmail.');
  });

  test('pending, not-found and error states stay in the question panel; Markdown has a text fallback', async () => {
    for (const reply of [
      { status: 200, body: { ok: true, status: 'not_found', left_out: ['Gmail'] } },
      { status: 500, body: { ok: false, error: { message: 'Could not answer.' } } },
      { status: 200, body: { ok: true, status: 'answered', answer: '**Raw** <img src=x>' } },
    ]) {
      const page = renderAndRun(() => reply, undefined, false);
      (page.document.querySelector('textarea') as unknown as { value: string }).value = 'My question';
      page.document.querySelector('form[data-pa-ask]')!.dispatchEvent(new page.document.defaultView!.Event('submit', { cancelable: true }));
      expect(page.document.querySelector('.pacard .paquestion strong')!.textContent).toBe('My question');
      expect(page.document.querySelector('.pacard')!.textContent).toContain('Answering');
      await page.settle();
      const card = page.document.querySelector('.pacard')!;
      expect(card.querySelector('.paquestion strong')!.textContent).toBe('My question');
      if (reply.body.status === 'not_found') {
        expect(card.textContent).toContain('Nothing on this computer answers this.');
        expect(card.textContent).toContain('Left out: Gmail.');
      } else if (reply.status === 500) {
        expect(card.querySelector('[data-state="error"]')!.textContent).toBe('Could not answer.');
      } else {
        expect(card.querySelector('.paanswer')!.textContent).toBe('**Raw** <img src=x>');
        expect(card.querySelector('.paanswer strong, img')).toBeNull();
      }
    }
  });

  test('clicking an unread row reads the full answer, marks its generation seen and opens sources only with tokens', async () => {
    const page = renderAndRun((body) => (body.action === 'read'
      ? { status: 200, body: { ok: true, status: 'answered', generation: 2, answer: '**May**. <img src=x onerror=alert(1)>', citations: [{ title: 'Lease', source: 'Dropbox', url: 'https://www.dropbox.com/preview/lease.pdf', open: 'A'.repeat(32) }, { title: 'Scan', open: 'B'.repeat(32) }], unanswered: ['End date'], left_out: ['Gmail'] } }
      : { status: 200, body: { ok: true, status: 'seen' } }));
    const row = page.document.querySelector('[data-pa-question="wq_1"]')!;
    expect(row.classList.contains('unread')).toBe(true);
    expect(row.textContent).toContain('Where is the lease?');
    expect(row.textContent).toContain('ChatGPT · 2h ago');
    expect(row.querySelector('[data-pa-answer], [data-pa-dismiss]')).toBeNull();
    (row.querySelector('[data-pa-read]') as unknown as { click(): void }).click();
    await page.settle();
    expect(page.posts.map((post) => post.body)).toEqual([{ action: 'read', id: 'wq_1' }, { action: 'seen', id: 'wq_1', generation: 2 }]);
    expect(page.posts.every((post) => post.url === DASHBOARD_PRIVATE_ANSWERS_PATH && post.headers['X-Olympus-CSRF'] === 'csrf-token')).toBe(true);
    const out = row.querySelector('[data-pa-out]')!;
    expect(out.querySelector('.paanswer strong')!.textContent).toBe('May');
    expect(out.querySelector('img, a')).toBeNull();
    expect(out.querySelector('.pacard .paquestion strong')!.textContent).toBe('Where is the lease?');
    expect(out.textContent).toContain('Left out: Gmail.');
    expect(out.textContent).toContain('Not found here: End date.');
    expect(row.classList.contains('unread')).toBe(false);
    expect(row.querySelector('[data-pa-delete]')).not.toBeNull();
    (out.querySelector('.paopen') as unknown as { click(): void }).click();
    await page.settle();
    expect(page.posts.at(-1)!.body).toEqual({ action: 'open', token: 'A'.repeat(32) });
  });

  test('opening a retained not-found answer marks it read without deleting it', async () => {
    const page = renderAndRun(body => ({ status: 200, body: body.action === 'read'
      ? { ok: true, status: 'not_found', left_out: ['Cloud-only source'], generation: 8 }
      : { ok: true, status: 'read' } }));
    (page.document.querySelector('[data-pa-read]') as unknown as { click(): void }).click();
    await page.settle();
    expect(page.document.body.textContent).toContain('Nothing on this computer answers this.');
    expect(page.posts.map(post => post.body)).toEqual([{ action: 'read', id: 'wq_1' }, { action: 'seen', id: 'wq_1', generation: 8 }]);
    expect(page.document.querySelector('[data-pa-question]')!.classList.contains('unread')).toBe(false);
    expect(page.document.querySelector('[data-pa-question]')).not.toBeNull();
  });

  test('deleted answers show plain deletion copy and Delete removes a row without answering it', async () => {
    const gone = renderAndRun(() => ({ status: 410, body: { ok: false, error: { code: 'gone', message: 'Old backend words' } } }));
    const row = gone.document.querySelector('[data-pa-question="wq_1"]')!;
    (row.querySelector('[data-pa-read]') as unknown as { click(): void }).click();
    await gone.settle();
    expect(row.textContent).toContain('That answer was deleted');
    expect(gone.posts.map((post) => post.body.action)).toEqual(['read']);

    const deleted = renderAndRun(() => ({ status: 200, body: { ok: true } }));
    (deleted.document.querySelector('[data-pa-delete]') as unknown as { click(): void }).click();
    await deleted.settle();
    expect(deleted.posts.map((post) => post.body)).toEqual([{ action: 'delete', id: 'wq_1' }]);
    expect(deleted.document.querySelector('[data-pa-question="wq_1"]')).toBeNull();
    expect((deleted.document.querySelector('[data-pa-none]') as unknown as { hidden: boolean }).hidden).toBe(false);
  });

  test('Delete all asks once and posts one deletion', async () => {
    const page = renderAndRun(() => ({ status: 200, body: { ok: true } }));
    (page.document.querySelector('[data-pa-delete-all]') as unknown as { click(): void }).click();
    await page.settle();
    expect(page.posts.map((post) => post.body)).toEqual([{ action: 'delete_all' }]);
    expect(page.confirmations()).toBe(1);
    expect(page.document.querySelector('[data-pa-question]')).toBeNull();
  });

  test('polling orders new rows newest first and removes displayed text when eligibility changes', async () => {
    let changed = false;
    const page = renderAndRun((body) => {
      if (body.action === 'list') return { status: 200, body: { ok: true, olderRemoved: false, questions: [
        { id: 'wq_1', question: 'Where is the lease?', from: 'ChatGPT', askedAt: '2026-10-01T01:00:00Z', state: 'retrying', unread: false },
        { id: 'wq_new', question: 'New question', from: 'Agent', askedAt: '2026-10-02T01:00:00Z', state: 'answered', unread: true },
      ] } };
      if (body.action === 'read') return { status: 200, body: changed
        ? { ok: true, status: 'retrying' }
        : { ok: true, status: 'answered', answer: 'Previously readable private text', generation: 3 } };
      return { status: 200, body: { ok: true } };
    });
    (page.document.querySelector('[data-pa-read]') as unknown as { click(): void }).click();
    await page.settle();
    expect(page.document.querySelector('[data-pa-question]')!.textContent).toContain('Previously readable private text');
    changed = true;
    await page.poll();
    expect([...page.document.querySelectorAll('[data-pa-question]')].map((row) => row.getAttribute('data-pa-question'))).toEqual(['wq_new', 'wq_1']);
    expect(page.document.querySelector('[data-pa-question="wq_new"]')!.classList.contains('unread')).toBe(true);
    expect(page.document.body.textContent).not.toContain('Previously readable private text');
    expect(page.document.querySelector('[data-pa-question="wq_1"] [data-pa-out]')!.textContent).toContain('Retrying on this computer');
    expect(page.posts.filter((post) => post.body.action === 'seen').length).toBe(1);
  });

  test('answer fragments read an existing row and missing fragments say the answer was deleted', async () => {
    const page = renderAndRun(() => ({ status: 200, body: { ok: true, status: 'retrying' } }), 'http://127.0.0.1:8010/dashboard?private-answers#wq_1');
    await page.settle();
    expect(page.posts.map((post) => post.body)).toEqual([{ action: 'read', id: 'wq_1' }]);
    expect(page.document.querySelector('[data-pa-question] [data-pa-out]')!.textContent).toContain('Retrying on this computer');
    const missing = renderAndRun(() => ({ status: 200, body: { ok: true } }), 'http://127.0.0.1:8010/dashboard?private-answers#wq_deleted');
    expect(missing.document.querySelector('[data-pa-missing]')!.textContent).toBe('That answer was deleted');
    expect(missing.posts.length).toBe(0);
  });

  test('the old address\'s fragment opens Anonymous answers, labeled as outside help, collapsed otherwise', () => {
    const plain = renderAndRun(() => ({ status: 500, body: {} }));
    const section = plain.document.getElementById(DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT) as unknown as { open: boolean; textContent: string };
    expect(section.open).toBe(false);
    expect(section.textContent).toContain('Outside help');
    const moved = renderAndRun(() => ({ status: 500, body: {} }), `http://127.0.0.1:8010/dashboard?private-answers#${DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT}`);
    expect((moved.document.getElementById(DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT) as unknown as { open: boolean }).open).toBe(true);
  });
});
