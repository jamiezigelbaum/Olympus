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

import { searchPrivateEvidence, probePrivateMatch } from '../src/workers/source-index/analyst-answer.ts';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerPrivately, type BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import { createRemotePrivateParts } from '../src/core/remote-private-part.ts';
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
import { createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
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
async function builtInEmbedding(state: BuiltInEmbeddingState, meaning = false, real = false) {
  const { dir, cleanup } = tempDir('olympus-local-embedding-');
  cleanups.push(cleanup);
  const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir };
  const model = state === 'stale_ready_onnx' || state === 'damaged_runtime' ? ARCTIC_EMBED_M_V1_5 : EMBEDDINGGEMMA_2;
  const installs: string[] = [];
  const starts: string[] = [];
  const embedded: string[] = [];
  const vectorFor = (text: string) => {
    if (!meaning) return bagOfWords(text, model.dimension);
    const vector = new Float32Array(model.dimension);
    // A semantic runtime fixture: equivalent meanings share a vector even
    // when the strings share no word. Unrelated material has an orthogonal one.
    vector[text.includes('Doctor advised acetaminophen') || text.includes('Physician recommended paracetamol') ? 0 : 1] = 1;
    return vector;
  };
  const provider = new BuiltInSourceEmbeddingProvider(real ? { env, model } : {
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
            return vectorFor(text);
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
      embed: async (inputs) => inputs.map((input) => Array.from(vectorFor(input.text))),
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
  meaningEmbeddings?: boolean;
  realEmbeddings?: boolean;
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
  const builtIn = await builtInEmbedding(options.embedding ?? 'loaded', options.meaningEmbeddings, options.realEmbeddings);
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
    releaseCheck: createReleaseTierCheck(() => [{ ledger: fixture.ledger, corpusIds: new Set(fixture.set.openStores().map(store => store.corpusId)) }], () => 'approval'),
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

  test('one extra word finds Private content on Ask, the sealed panel and the metadata-only probe', async () => {
    const local = await localFixture({ specs: [oweSpec], privateIds: ['owe'], keywordOnly: true, answer: oweAnswer });
    const question = 'owe zephyr';
    const strict = local.lanes({ question, retrieval_mode: 'keyword' });
    expect((await routeSourceIndexSearch({ registry: strict.registry, adapters: strict.adapters,
      request: { query: question, maxResults: 12, context: { allowedTrustDomains: ['secure_local'], allowCloudQueries: false } } })).hits).toEqual([]);
    const network = denyNetwork();
    try {
      expect((await local.answer({ question })).status).toBe('answered');
      const panel = await searchPrivateEvidence({ lanes: local.lanes, question });
      expect(panel.candidates.map(c => c.provenance.sourceItem?.localItemId)).toEqual(['personal:owe']);
      const db = (local.fixture.stores.secure_local as unknown as { db: { query: (sql: string) => unknown } }).db;
      const query = db.query.bind(db);
      const statements: string[] = [];
      db.query = sql => { statements.push(sql); return query(sql); };
      expect(await probePrivateMatch({ lanes: local.lanes, request: { question, retrieval_mode: 'keyword' }, timeoutMs: 5000 })).toBe('match');
      expect(statements.some(sql => sql.includes('bounded_text'))).toBe(false);
      expect(network.attempts).toEqual([]);
    } finally { network.restore(); }
    const withheld = (...args: Parameters<typeof local.lanes>) => ({ ...local.lanes(...args), visibilityGate: () => [] });
    expect(await searchPrivateEvidence({ lanes: withheld, question })).toEqual({ matched: 0, candidates: [] });
    expect(await probePrivateMatch({ lanes: withheld, request: { question, corpus_ids: [local.fixture.stores.secure_local!.corpusId] }, timeoutMs: 5000 })).toBe('no_match');
    await moveTieredItem({ set: local.fixture.set, identity: identityOf('owe'), target: { metadataTier: 'secrets', contentTier: 'secrets' } });
    expect(await searchPrivateEvidence({ lanes: local.lanes, question })).toEqual({ matched: 0, candidates: [] });
    expect(await probePrivateMatch({ lanes: local.lanes, request: { question, corpus_ids: [local.fixture.stores.secure_local!.corpusId] }, timeoutMs: 5000 })).toBe('no_match');
    expect((await local.answer({ question })).status).toBe('not_found');
  });

  for (const keywordOnly of [true, false]) {
    test(`one common word cannot create a Private match or waiting row (keywordOnly=${keywordOnly})`, async () => {
      const local = await localFixture({ specs: [oweSpec], privateIds: ['owe'], keywordOnly });
      const question = 'what is the weather forecast for twenty days';
      const request = { question, corpus_ids: [local.fixture.stores.secure_local!.corpusId] };
      expect(await probePrivateMatch({ lanes: local.lanes, request, timeoutMs: 5000 })).toBe('no_match');
      expect(await searchPrivateEvidence({ lanes: local.lanes, question })).toEqual({ matched: 0, candidates: [] });
      const store = waitingStore();
      const remote = createRemotePrivateParts({
        probe: (request, timeoutMs) => probePrivateMatch({ lanes: local.lanes, request: request as unknown as Parameters<typeof probePrivateMatch>[0]['request'], timeoutMs }),
        store: () => store,
        probeTimeoutMs: 5000,
      });
      try {
        const raw = { answer: 'No weather evidence.', audit: { skipped_corpora: [{ reason: 'no_private_analyst_route' }] } };
        expect(await remote.forConnection('conn-a').start('source_answer', request)!.settle(raw, { status: 'answered' })).toBe(false);
        expect(store.list().questions).toEqual([]);
      } finally { remote.close(); }
    });
  }

  test('rare single term and two distinct shared terms still find Private evidence', async () => {
    const specs: FixtureSpec[] = [
      ...Array.from({ length: 19 }, (_, i) => ({ ...oweSpec, id: `filler${i}`, name: `note${i}.txt`, text: 'twenty ordinary notes about cooking' })),
      { ...oweSpec, text: 'SENTINEL_OWE: I owe Alex twenty euros for the quetzalcoatlus exhibit.' },
    ];
    const local = await localFixture({ specs, privateIds: specs.map(s => s.id), keywordOnly: true });
    for (const [question, match] of [
      ['weather forecast twenty days', false],
      ['weather forecast quetzalcoatlus days', true],
      ['twenty euros zephyr', true],
      ['twenty twenty forecast weather', false],
    ] as const) {
      expect(await probePrivateMatch({ lanes: local.lanes, request: { question, corpus_ids: [local.fixture.stores.secure_local!.corpusId] }, timeoutMs: 5000 })).toBe(match ? 'match' : 'no_match');
      const panel = await searchPrivateEvidence({ lanes: local.lanes, question });
      expect(panel.matched).toBe(match ? 1 : 0);
      if (match) expect(panel.candidates[0]?.provenance.sourceItem?.localItemId).toBe('personal:owe');
    }
  });

  test('REVIEW P1 embeddings on (hybrid branch): panel and probe with one extra word', async () => {
    const local = await localFixture({ specs: [oweSpec], privateIds: ['owe'], answer: oweAnswer });
    const question = 'owe zephyr';
    const strictLanes = (r: Parameters<typeof local.lanes>[0]) => local.lanes(r);
    const panel = await searchPrivateEvidence({ lanes: local.lanes, question });
    const strictPanel = await searchPrivateEvidence({ lanes: strictLanes, question });
    const probe = await probePrivateMatch({ lanes: local.lanes, request: { question }, timeoutMs: 5000 });
    const strictProbe = await probePrivateMatch({ lanes: strictLanes, request: { question }, timeoutMs: 5000 });
    expect(panel.matched).toBe(1);
    expect(probe).toBe('match');
    expect(strictPanel.matched).toBe(0);
    expect(strictProbe).not.toBe('match');
    expect((await local.answer({ question })).status).toBe('answered');
  });

  test('REVIEW P3 private_search does not relax a non-Private store', async () => {
    const inv: FixtureSpec = { id: 'inv', name: 'inventory.txt', text: 'SENTINEL_INV: the orchard inventory lists two chairs.', legacyDomain: 'internal' };
    const local = await localFixture({ specs: [oweSpec, inv], privateIds: ['owe'], keywordOnly: true, answer: oweAnswer });
    const search = async (mode: 'private_search' | 'built_in_only' | undefined) => {
      const lanes = local.lanes({ question: 'inventory zephyr', retrieval_mode: 'keyword', include_internal: true }, mode);
      return (await routeSourceIndexSearch({ registry: lanes.registry, adapters: lanes.adapters,
        request: { query: 'inventory zephyr', maxResults: 12, context: { allowedTrustDomains: ['internal', 'secure_local'], allowCloudQueries: false } } }));
    };
    const out: Record<string, unknown> = {};
    for (const mode of [undefined, 'private_search', 'built_in_only'] as const) {
      const routed = await search(mode);
      out[String(mode)] = routed.hits.map(h => `${h.trustDomain}:${h.sourceItem.localItemId}`);
    }
    expect(out['undefined']).toEqual([]);
    expect(out['private_search']).toEqual([]);
    expect(out['built_in_only']).toEqual(['internal:personal:inv']);
  });

  test('the retry never matches on request scaffolding the strict search ignores', async () => {
    const filesSpec: FixtureSpec = { ...oweSpec, id: 'files', name: 'Saved files.txt', text: 'SENTINEL_FILES: show and find the saved files and documents here.' };
    const local = await localFixture({ specs: [filesSpec], privateIds: ['files'], keywordOnly: true, answer: oweAnswer });
    const question = 'show me files about zephyr';
    expect(await searchPrivateEvidence({ lanes: local.lanes, question })).toEqual({ matched: 0, candidates: [] });
    expect(await probePrivateMatch({ lanes: local.lanes, request: { question, corpus_ids: [local.fixture.stores.secure_local!.corpusId] }, timeoutMs: 5000 })).toBe('no_match');
    expect(local.fixture.stores.secure_local!.searchItemsDetailed('show me saved documents', 50, undefined, undefined, { relaxed: true }).rows).toEqual([]);
  });

  test('relaxed search keeps readable content ahead of more than fifty title-only matches', async () => {
    const titles: FixtureSpec[] = Array.from({ length: 60 }, (_, i) => ({ id: `title-${i}`, name: `owe owe owe ${i}.txt`, legacyDomain: 'secure_local' }));
    const specs = [...titles, oweSpec];
    const local = await localFixture({ specs, privateIds: ['owe'], keywordOnly: true, answer: oweAnswer });
    const question = 'owe zephyr';
    const raw = local.fixture.stores.secure_local!.searchItemsDetailed(question, 50, undefined, undefined, { relaxed: true });
    expect(raw.rows).toHaveLength(50);
    expect(raw.rows.map(row => row.sourceItem.localItemId)).not.toContain('personal:owe');
    expect((await local.answer({ question })).status).toBe('answered');
    expect(JSON.stringify(local.stub.requests)).toContain('SENTINEL_OWE');
    const panel = await searchPrivateEvidence({ lanes: local.lanes, question, maxResults: 1 });
    expect(panel.candidates[0]?.provenance.sourceItem?.localItemId).toBe('personal:owe');
    const scoped = local.lanes({ question, retrieval_mode: 'keyword' }, 'private_search');
    const routed = await routeSourceIndexSearch({ registry: scoped.registry, adapters: scoped.adapters,
      request: { query: question, maxResults: 1, context: { allowedTrustDomains: ['secure_local'], allowCloudQueries: false, metadataOnly: true } } });
    expect(routed.hits[0]?.sourceItem.localItemId).toBe('personal:owe');
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
    const panel = await searchPrivateEvidence({ lanes: local.lanes, question: 'owe money galaxy quasar nebula' });
    // The panel requires both shared terms; Ask above still accepts lone owe.
    expect(panel.candidates.filter(c => !c.neighbour).map(c => c.provenance.sourceItem?.localItemId)).toEqual(['personal:rich']);
    const bounded = await search('alpha beta gamma delta epsilon zeta theta kappa zephyr');
    expect(bounded.hits).toEqual([]);
    const short = await search('do I xx ox owe anyone anything?');
    expect(short.hits.map(hit => hit.sourceItem.localItemId).sort()).toEqual(['personal:owe', 'personal:rich']);
  });

  for (const real of [false, true]) {
    const run = real && process.env.OLYMPUS_PRIVATE_MEANING_REAL_MODEL !== '1' ? test.skip : test;
    run(`Ask privately finds a paraphrase with no shared keyword (${real ? 'real built-in model' : 'semantic runtime fixture'}), with zero egress`, async () => {
      const text = 'Physician recommended paracetamol for headaches.';
      const question = 'Doctor advised acetaminophen?';
      const words = new Set(text.toLowerCase().match(/[a-z]+/g));
      expect(question.toLowerCase().match(/[a-z]+/g)!.filter(word => words.has(word))).toEqual([]);
      const local = await localFixture({
        specs: [{ id: 'document', name: 'document.txt', text, legacyDomain: 'secure_local' }],
        privateIds: ['document'], meaningEmbeddings: true, realEmbeddings: real,
        answer: JSON.stringify({ answer: 'Paracetamol [1].', citations: [{ evidence: 1, claim: 'Paracetamol.' }], unanswered: [], sufficient: true }),
      });
      expect(local.fixture.stores.secure_local!.searchItems(question, 5)).toEqual([]);
      if (real) {
        const lane = await local.fixture.stores.secure_local!.vectorSearchLane(question, local.builtIn.provider, 5);
        expect(lane.rows[0]?.bestCosine).toBeGreaterThanOrEqual(0.73);
      }
      const cloudBefore = local.fixture.cloud.inputs.length;
      const network = denyNetwork();
      try {
        const controller = createLocalPrivateAnswers({ answer: local.answer, eligible: local.eligible, store: () => undefined });
        const outcome = await controller.handle({ action: 'ask', question }, 'session:owner');
        expect(outcome.body).toMatchObject({ ok: true, status: 'answered', answer: 'Paracetamol.' });
        expect(JSON.stringify(local.stub.requests)).toContain(text);
        expect(local.fixture.cloud.inputs.slice(cloudBefore)).toEqual([]);
        expect(network.attempts).toEqual([]);
      } finally { network.restore(); }
    }, real ? 300_000 : 5_000);
  }

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

test.each(['purged Personal copy', 'moving to Secrets'] as const)('stored inbox answer is withheld for %s', async change => {
  const local = await localFixture({ specs: [{ id: 'offer', name: 'offer.txt', text: 'The synthetic offer price is 620000.' }], privateIds: change === 'moving to Secrets' ? ['offer'] : [], answer: OFFER_ANSWER, keywordOnly: true });
  const store = waitingStore();
  const ref = store.record(store.ticket('conn-agent'), { question: 'What is the synthetic offer price?', surface: 'remote', state: 'waiting' })!;
  const controller = createLocalPrivateAnswers({ answer: local.answer, eligible: local.eligible, store: () => store });
  cleanups.push(() => controller.close());
  await controller.tick();
  expect(store.get(ref.id)?.result?.status).toBe('answered');
  expect((await controller.handle({ action: 'read', id: ref.id }, 'owner')).body.status).toBe('answered');
  if (change === 'purged Personal copy') {
    await moveTieredItem({ set: local.fixture.set, identity: identityOf('offer'), target: { metadataTier: 'private', contentTier: 'secure' } });
    expect(local.fixture.stores.internal!.localContent('personal:offer')?.chunks ?? []).toEqual([]);
  } else {
    const record = local.fixture.ledger.getCurrent(identityOf('offer'))!;
    local.fixture.ledger.beginMove(identityOf('offer'), { metadataTier: 'secrets', contentTier: 'secrets' }, record.generation);
    const read = store.get(ref.id)!.result!.read;
    const first = read[0]!;
    const provenance = first.provenance as { sourceItem: Record<string, unknown> };
    const missing = { ...first, provenance: { ...provenance, sourceItem: { ...provenance.sourceItem, localItemId: 'missing' } } };
    // A second unservable input cannot bypass the ledger check for the first.
    expect(await local.eligible([...read, missing])).toEqual([...read, missing].map(() => false));
  }
  const read = await controller.handle({ action: 'read', id: ref.id }, 'owner');
  expect(read.body).toEqual({ ok: true, status: 'answering' });
  expect(read.body).not.toHaveProperty('answer');
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
  for (const path of ['private', 'anonymous', 'venice'] as const) test(`the ${path} route: the Gateway bearer and every session it can mint are refused and nothing runs; a local session answers`, async () => {
    const { store, controller } = scripted();
    const ref = store.record(store.ticket('conn-a'), { path, question: 'Where is the lease?', surface: 'remote', state: 'waiting' })!;
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
    for (const action of [{ action: 'read', id: ref.id }, { action: 'list' }, { action: 'ask_venice', question: 'Sentinel?' }, { action: 'ask_anonymous', question: 'Sentinel?' }, { action: 'ask', question: 'Sentinel?' }]) {
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
        destinations: { computer: 'ready', venice: 'not_allowed' },
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
      'Local model', 'zkAPI model', 'Venice model', 'Inbox',
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

  test('a withdrawn Venice answer shows its sent list and reason as text, and marks the receipt seen', async () => {
    const page = renderAndRun(body => ({ status: 200, body: body.action === 'read'
      ? { ok: true, status: 'withdrawn', reason: 'Sent to Venice, but no answer was kept. <img src=x>', sent_items: [{ title: '<script>bad()</script>', source: 'test', date: '2026-10-15' }], generation: 9 }
      : { ok: true, status: 'read' } }));
    (page.document.querySelector('[data-pa-read]') as unknown as { click(): void }).click();
    await page.settle();
    const out = page.document.querySelector('[data-pa-question] [data-pa-out]')!;
    expect(out.textContent).toContain('What was sent to Venice');
    expect(out.textContent).toContain('<script>bad()</script>');
    expect(out.textContent).toContain('Sent to Venice, but no answer was kept. <img src=x>');
    expect(out.querySelector('img, script, .paanswer, .paopen')).toBeNull();
    expect(page.posts.map(post => post.body)).toEqual([{ action: 'read', id: 'wq_1' }, { action: 'seen', id: 'wq_1', generation: 9 }]);
    expect(page.document.querySelector('[data-pa-question]')!.classList.contains('unread')).toBe(false);
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

  test('the old fragment lands on the always-visible anonymous panel with a Models link', () => {
    const page = renderAndRun(() => ({ status: 500, body: {} }));
    const section = page.document.getElementById(DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT)!;
    expect(section.tagName).toBe('SECTION');
    expect(section.textContent).toContain('zkAPI');
    expect(section.querySelector('a')!.getAttribute('href')).toContain('?keys#anonymous');
    expect(page.document.querySelectorAll('.paask textarea').length).toBe(1);
    expect(page.document.querySelectorAll('.padestination').length).toBe(3);
  });
  test('the inbox renders temporary eligibility and queued states plainly without acknowledging an answer', async () => {
    for (const [status, words] of [['check_unavailable', "Couldn't check this answer right now"], ['queued', 'Queued on this computer.']] as const) {
      const page = renderAndRun(() => ({ status: 200, body: { ok: true, status } }));
      (page.document.querySelector('[data-pa-read]') as unknown as { click(): void }).click();
      await page.settle();
      expect(page.document.body.textContent).toContain(words);
      expect(page.posts.map(post => post.body.action)).toEqual(['read']);
    }
  });

});

// Independent review regressions, using the real tier-ledger fixture.

const OFFER_A = JSON.stringify({ answer: 'The price is 620000 [1].', citations: [{ evidence: 1, claim: 'Price 620000' }], unanswered: [], sufficient: true });

async function offerCase(conversation: string | undefined) {
  const spec: FixtureSpec = { id: 'offer', name: 'offer.txt', text: 'The synthetic offer price is 620000.', ...(conversation ? { conversation } : {}) };
  const local = await localFixture({ specs: [spec], privateIds: [], answer: OFFER_A, keywordOnly: true });
  await moveTieredItem({ set: local.fixture.set, identity: identityOf('offer', conversation), target: { metadataTier: 'secure', contentTier: 'secure' } });
  const store = waitingStore();
  const ref = store.record(store.ticket('conn-agent'), { question: 'What is the synthetic offer price?', surface: 'remote', state: 'waiting' })!;
  let opened = 0; let paused = false;
  const controller = createLocalPrivateAnswers({ interactiveBusy: () => paused, answer: async input => {
    const result = await local.answer(input);
    return result.status === 'answered' ? { ...result, citations: [{ url: 'https://example.invalid/source' }] } : result;
  }, eligible: local.eligible, store: () => store, openUrl: async () => { opened++; } });
  cleanups.push(() => controller.close());
  await controller.tick();
  return { local, store, ref, controller, opened: () => opened, pause: () => { paused = true; }, identity: identityOf('offer', conversation) };
}

test('REVIEW R1 pending-Secret stored answer: plain vs conversation-keyed item', async () => {
  const out: Record<string, unknown> = {};
  for (const conversation of [undefined, 'chat-1']) {
    const c = await offerCase(conversation);
    const key = conversation ?? 'plain';
    out[`${key}:stored`] = c.store.get(c.ref.id)?.result?.status;
    out[`${key}:readIdentity`] = JSON.stringify(c.store.get(c.ref.id)?.result?.read);
    const before = await c.controller.handle({ action: 'read', id: c.ref.id }, 'owner');
    const token = (before.body.citations as Array<{ open: string }>)[0]!.open;
    const record = c.local.fixture.ledger.getCurrent(c.identity)!;
    c.local.fixture.ledger.beginMove(c.identity, { metadataTier: 'secrets', contentTier: 'secrets' }, record.generation);
    c.pause();
    expect((await c.controller.handle({ action: 'open', token }, 'owner')).status).toBe(410);
    expect(c.opened()).toBe(0);
    const read = await c.controller.handle({ action: 'read', id: c.ref.id }, 'owner');
    out[`${key}:readAfterPendingSecret`] = JSON.stringify(read.body);
  }
  expect(out['plain:readAfterPendingSecret']).toBe(JSON.stringify({ ok: true, status: 'answering' }));
  expect(out['chat-1:readAfterPendingSecret']).toBe(JSON.stringify({ ok: true, status: 'answering' }));
});

test('REVIEW R2 re-ask by the agent erases an answered, read row', () => {
  const store = waitingStore();
  const t = store.ticket('conn-a');
  const ref = store.record(t, { question: 'When is my dentist appointment?', surface: 'remote', state: 'waiting' })!;
  store.saveAnswer(ref, { status: 'answered', answer: 'Tuesday', citations: [], unanswered: [], leftOut: [], read: [] });
  store.markRead(ref);
  const before = store.get(ref.id)!;
  const again = store.record(store.ticket('conn-a'), { question: 'when is my dentist appointment?', surface: 'remote', state: 'waiting' })!;
  const after = store.get(ref.id)!;
  expect(after.result?.answer).toBe('Tuesday');
});

test('REVIEW R3 one connection evicts another connection\'s answered rows', () => {
  const store = waitingStore();
  const victim = store.record(store.ticket('conn-victim'), { question: 'victim question', surface: 'remote', state: 'waiting' })!;
  store.saveAnswer(victim, { status: 'answered', answer: 'victim answer', citations: [], unanswered: [], leftOut: [], read: [] });
  for (let i = 0; i < 500; i += 1) {
    const r = store.record(store.ticket('conn-flood'), { question: `flood ${i}`, surface: 'remote', state: 'waiting' })!;
    store.saveAnswer(r, { status: 'answered', answer: `a${i}`, citations: [], unanswered: [], leftOut: [], read: [] });
  }
  expect(store.list().questions.length).toBeLessThanOrEqual(51);
  expect(store.get(victim.id)).toBeDefined();
});

test('REVIEW R4 transient ledger read failure destroys a stored answer on read', async () => {
  const c = await offerCase(undefined);
  const gen0 = c.store.get(c.ref.id)!.generation;
  const original = c.local.fixture.ledger.itemStatesForMany.bind(c.local.fixture.ledger);
  c.local.fixture.ledger.itemStatesForMany = () => { throw new Error('SQLITE_BUSY (simulated)'); };
  const read = await c.controller.handle({ action: 'read', id: c.ref.id }, 'owner');
  c.local.fixture.ledger.itemStatesForMany = original;
  const row = c.store.get(c.ref.id)!;
  expect(read.body).toEqual({ ok: true, status: 'check_unavailable' });
  expect(row.result).toBeDefined();
  expect(row.generation).toBe(gen0);
  expect((await c.controller.handle({ action: 'read', id: c.ref.id }, 'owner')).body.status).toBe('answered');
});

test('REVIEW R5 transient failure during auto-answer stores a permanent not_found', async () => {
  const spec: FixtureSpec = { id: 'offer', name: 'offer.txt', text: 'The synthetic offer price is 620000.' };
  const local = await localFixture({ specs: [spec], privateIds: ['offer'], answer: OFFER_A, keywordOnly: true });
  const store = waitingStore();
  const ref = store.record(store.ticket('conn-agent'), { question: 'What is the synthetic offer price?', surface: 'remote', state: 'waiting' })!;
  const controller = createLocalPrivateAnswers({ answer: local.answer, eligible: local.eligible, store: () => store });
  cleanups.push(() => controller.close());
  const original = local.fixture.ledger.itemStatesForMany.bind(local.fixture.ledger);
  local.fixture.ledger.itemStatesForMany = () => { throw new Error('SQLITE_BUSY (simulated)'); };
  await controller.tick();
  local.fixture.ledger.itemStatesForMany = original;
  const first = store.get(ref.id)!;
  await controller.tick();
  expect(first.result).toBeUndefined();
  expect(first.attempts).toBe(1);
});

// Anonymous replies share the local-only store, never its remote status surface.
describe('anonymous answers in the local inbox', () => {
  async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'anonymous-inbox-'));
    const store = openWaitingPrivateQuestionStore(join(dir, 'state', 'waiting-private-questions.sqlite'));
    cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const local = createLocalPrivateAnswers({ store: () => store, connectionName: () => 'Grok Bot', eligible: async items => items.map(() => true), answer: async () => ({ status: 'failed' }) });
    const { askWithAnonymousInbox } = await import('../src/workers/email-source/local-private-answers.ts');
    const result = { ok: true as const, sent: 'What are general tenant deposit rules?', reply: 'LOCAL_ONLY_ANONYMOUS_REPLY', route: 'anonymous', networkIdentity: 'not_verified' as const, level: 'standard' as const, cleanup: 'light_cleanup' as const, rewritten: true, remembered: false, model: 'outside/model' };
    return { store, local, result, askWithAnonymousInbox, ask: (run = async () => result) => askWithAnonymousInbox({ question: 'My identifying original question' }, { store: () => store, connectionId: 'grok', ask: run }) };
  }
  test('keeps the exact sent question, path and agent; reads, marks seen and deletes locally', async () => {
    const f = await fixture();
    expect((await f.ask()).ok).toBe(true);
    const q = f.local.waiting()!.questions[0]!;
    expect(q).toMatchObject({ path: 'anonymous', from: 'Grok Bot', question: f.result.sent, unread: true, state: 'answered' });
    expect(JSON.stringify(q)).not.toContain(f.result.reply);
    expect(JSON.stringify(q)).not.toContain('identifying original');
    expect((await f.local.handle({ action: 'read', id: q.id }, 'local')).body).toMatchObject({ answer: f.result.reply, sent: f.result.sent, citations: [] });
    await f.local.handle({ action: 'seen', id: q.id, generation: f.store.get(q.id)!.generation }, 'local');
    expect(f.local.waiting()!.questions[0]!.unread).toBe(false);
    await f.local.handle({ action: 'delete_all' }, 'local');
    expect(f.store.list().questions).toEqual([]);
  });
  test('delete-all and revocation fence a late outside reply; failures leave no pending work', async () => {
    const f = await fixture();
    await f.ask(async () => { f.store.dismissAll(); return f.result; });
    expect(f.store.list().questions).toEqual([]);
    await f.ask(async () => { f.store.revokeConnection('grok'); return f.result; });
    expect(f.store.list().questions).toEqual([]);
    await f.ask(async () => { throw new Error('sensitive transport detail'); });
    expect(f.store.list().questions).toEqual([]);
  });
  test('ChatGPT panel delivery returns its reply without touching the inbox', async () => {
    const f = await fixture();
    const result = await f.askWithAnonymousInbox({ question: 'Sealed question' }, { deliveredToPanel: true, store: () => { throw new Error('panel must not open the inbox'); }, connectionId: 'chatgpt', ask: async () => f.result });
    expect(result).toEqual(f.result);
    expect(f.store.list().questions).toEqual([]);
  });
  test('stored replies and sent text cannot be read by bearer, launch, dash reader or remote POST', async () => {
    const f = await fixture(); await f.ask();
    const fetcher = worker(f.local);
    const bearer = await bearerSession(fetcher);
    const launch = await launchSession(fetcher);
    const q = f.store.list().questions[0]!;
    for (const headers of [{ Authorization: `Bearer ${TOKEN}` }, { Cookie: bearer.cookie }, { Cookie: launch.cookie }]) {
      const output = await (await page(fetcher, headers)).text();
      expect(output).not.toContain(f.result.reply); expect(output).not.toContain(f.result.sent);
      const response = await fetcher(post({ action: 'read', id: q.id }, { ...headers, Origin: ORIGIN, 'X-Olympus-CSRF': bearer.csrf }));
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain(f.result.reply);
    }
    const dash = await (await page(fetcher, { Authorization: `Bearer ${TOKEN}` }, 'private-answers&token=dash_fake')).text();
    expect(dash).not.toContain(f.result.reply); expect(dash).not.toContain(f.result.sent);
    const local = await localSession(fetcher);
    expect(await (await page(fetcher, { Cookie: local.cookie })).text()).toContain(f.result.sent);
    expect((await fetcher(post({ action: 'read', id: q.id }, { Cookie: local.cookie, Origin: ORIGIN, 'X-Olympus-CSRF': local.csrf }))).status).toBe(200);
  });
  test('Ask privately keeps its immediate answer and a locally protected inbox row', async () => {
    const f = await fixture();
    const local = createLocalPrivateAnswers({ localConnectionId: '@local:You', store: () => f.store, connectionName: () => 'You', eligible: async () => [], answer: async () => ({ status: 'answered', answer: 'Private local reply', citations: [], unanswered: [], leftOut: [], read: [] }) });
    expect((await local.handle({ action: 'ask', question: 'Local question?' }, 'local')).body.answer).toBe('Private local reply');
    expect(local.waiting()!.questions[0]).toMatchObject({ path: 'private', from: 'You', question: 'Local question?' });
    await local.handle({ action: 'ask', question: 'Local question?' }, 'local');
    expect(local.waiting()!.questions).toHaveLength(2);
  });
  test('reply text, sent text and transport errors never reach logs', async () => {
    const f = await fixture();
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map(method => spyOn(console, method as 'log').mockImplementation(() => {}));
    try {
      await f.ask();
      const failed = await f.ask(async () => { throw new Error(f.result.reply + f.result.sent); });
      expect(failed.ok).toBe(false);
      expect(JSON.stringify(failed)).not.toContain(f.result.reply);
      for (const log of logs) expect(log.mock.calls).toEqual([]);
    } finally { logs.forEach(log => log.mockRestore()); }
  });
  test('long anonymous questions reach the core; their original wording never enters the reservation', async () => {
    const f = await fixture();
    const question = 'ORIGINAL_ANONYMOUS_NOT_ON_DISK' + 'x'.repeat(3860);
    const result = await f.askWithAnonymousInbox({ question }, { store: () => f.store, connectionId: 'grok', ask: async input => {
      expect(input.question).toBe(question);
      expect(f.store.list().questions[0]!.question).toBe('Anonymous question pending');
      expect(readFileSync(f.store.dbPath).includes(Buffer.from('ORIGINAL_ANONYMOUS_NOT_ON_DISK'))).toBe(false);
      return f.result;
    } });
    expect(result.ok).toBe(true);
    expect(f.local.waiting()!.questions[0]!.question).toBe(f.result.sent);
  });
  test('human private and anonymous asks, including refusals, do not consume automatic-answer budgets', async () => {
    const f = await fixture();
    const local = createLocalPrivateAnswers({ localConnectionId: '@local:You', store: () => f.store, eligible: async () => [],
      answer: async () => ({ status: 'answered', answer: 'Local reply', citations: [], unanswered: [], leftOut: [], read: [] }),
      anonymousAsk: input => f.askWithAnonymousInbox(input, { local: true, store: () => f.store, connectionId: '@local:You', ask: async request => request.question === 'off' ? { ok: false, code: 'anonymous_answers_off', message: 'Off' } : f.result }),
    });
    expect((await local.handle({ action: 'ask_anonymous', question: 'off' }, 'local')).status).toBe(400);
    const cjk = '界'.repeat(1000);
    for (let i = 0; i < 6; i++) {
      expect((await local.handle({ action: 'ask', question: cjk }, 'local')).body.answer).toBe('Local reply');
      expect((await local.handle({ action: 'ask_anonymous', question: 'Outside?' }, 'local')).body.answer).toBe(f.result.reply);
    }
    expect(local.waiting()!.questions.filter(q => q.path === 'private')).toHaveLength(6);
    expect(local.waiting()!.questions.some(q => q.question === cjk)).toBe(true);
    const ref = f.store.record(f.store.ticket('@local:You'), { question: 'Auto?', state: 'waiting', surface: 'remote' })!;
    expect(f.store.reserveAutoAnswer(ref)).toBe(true);
  });
  test('anonymous agent rate limits and Private automatic budgets are independent in both directions', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) {
      const ref = f.store.record(f.store.ticket('grok'), { question: `Private ${i}`, surface: 'remote', state: 'waiting' })!;
      expect(f.store.reserveAutoAnswer(ref)).toBe(true);
    }
    for (let i = 0; i < 5; i++) expect((await f.ask()).ok).toBe(true);
    expect((await f.ask()).ok).toBe(false);
    const g = await fixture();
    for (let i = 0; i < 5; i++) expect((await g.ask()).ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      const ref = g.store.record(g.store.ticket('grok'), { question: `Private ${i}`, surface: 'remote', state: 'waiting' })!;
      expect(g.store.reserveAutoAnswer(ref)).toBe(true);
    }
  });
  test('the inbox rate limit refuses a sixth send without calling outside help', async () => {
    const f = await fixture();
    let sends = 0;
    for (let i = 0; i < 6; i++) await f.ask(async () => { sends++; return f.result; });
    expect(sends).toBe(5);
    expect(f.store.list().questions.length).toBe(5);
  });
});

const A = (answer: string) => ({ status: 'answered' as const, answer, citations: [], unanswered: [], leftOut: [], read: [] });

test('re-ask retains answered rows and restarts not-found rows', () => {
  const store = waitingStore();
  const ref = store.record(store.ticket('c'), { question: 'dentist?', surface: 'remote', state: 'waiting' })!;
  store.saveAnswer(ref, { status: 'answered', answer: 'Tuesday', citations: [], unanswered: [], leftOut: [], read: [] });
  const again = store.record(store.ticket('c'), { question: 'dentist?', surface: 'remote', state: 'waiting' })!;
  const nf = store.record(store.ticket('c'), { question: 'second question', surface: 'remote', state: 'waiting' })!;
  store.saveAnswer(nf, { status: 'not_found', citations: [], unanswered: [], leftOut: [], read: [] });
  const nf2 = store.record(store.ticket('c'), { question: 'second question', surface: 'remote', state: 'waiting' })!;
  expect(again.generation).toBe(ref.generation);
  expect(nf2.generation).toBe(nf.generation + 1);
  expect(store.get(nf.id)?.result).toBeUndefined();
  expect(store.get(ref.id)?.result?.answer).toBe('Tuesday');
});

test('a newcomer retains its first answer in a globally full inbox', () => {
  const store = waitingStore();
  for (let c = 0; c < 10; c += 1) for (let i = 0; i < 50; i += 1) {
    const r = store.record(store.ticket(`c${c}`), { question: `q ${c} ${i}`, surface: 'remote', state: 'waiting' })!;
    store.saveAnswer(r, A('x'));
  }
  const fresh = store.record(store.ticket('newcomer'), { question: 'newcomer q', surface: 'remote', state: 'waiting' })!;
  const saved = store.saveAnswer(fresh, A('newcomer answer'));
  expect(saved).toBe(true);
  expect(store.list().questions.length).toBe(500);
  expect(store.list().olderRemoved).toBe(true);
  expect(store.get(fresh.id)).toBeDefined();
});

test('a brief copiesForMany failure hides a stored answer, then shows it again', async () => {
  const c = await offerCase(undefined);
  const original = c.local.fixture.ledger.copiesForMany.bind(c.local.fixture.ledger);
  c.local.fixture.ledger.copiesForMany = () => { throw new Error('SQLITE_BUSY (simulated)'); };
  const read = await c.controller.handle({ action: 'read', id: c.ref.id }, 'owner');
  c.local.fixture.ledger.copiesForMany = original;
  expect(read.body.status).toBe('check_unavailable');
  expect(c.store.get(c.ref.id)?.generation).toBe(c.ref.generation);
  expect((await c.controller.handle({ action: 'read', id: c.ref.id }, 'owner')).body.status).toBe('answered');
  expect(c.store.get(c.ref.id)?.result).toBeDefined();
});

for (const unavailable of ['no_model', 'model_downloading', 'failed', 'throw'] as const) test(`pre-model ${unavailable} does not spend the hourly auto-answer budget`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-14T12:00:00Z');
  const store = openWaitingPrivateQuestionStore(join(dir, 'state', 'waiting-private-questions.sqlite'), { now: () => clock, isActive: () => true });
  cleanups.push(() => store.close());
  const ref = store.record(store.ticket('c'), { question: 'dentist?', surface: 'remote', state: 'waiting' })!;
  const start = clock;
  let ready = false;
  const controller = createLocalPrivateAnswers({ store: () => store, now: () => clock, answer: async () => { if (ready) return A('Tuesday'); if (unavailable === 'throw') throw new Error('retrieval temporarily unavailable'); return { status: unavailable }; }, eligible: async items => items.map(() => true) });
  cleanups.push(() => controller.close());

  for (let i = 0; i < 8; i += 1) {
    await controller.tick();
    const row = store.get(ref.id)!;
    clock = Math.max(clock + 1000, row.nextAttemptAt);
    if (i === 4) ready = true; // model finished downloading after ~2.5 minutes
  }
  const done = store.get(ref.id)!;
  expect(done.result?.status).toBe('answered');
  expect(Date.parse(done.answeredAt!) - start).toBeLessThan(5 * 60_000);
  // Only the successful answer spent the five-attempt allowance.
  for (let i = 0; i < 4; i++) expect(store.reserveAutoAnswer(store.record(store.ticket('c'), { question: `next ${i}`, surface: 'remote', state: 'waiting' })!)).toBe(true);
  expect(store.reserveAutoAnswer(store.record(store.ticket('c'), { question: 'over budget', surface: 'remote', state: 'waiting' })!)).toBe(false);
});

test('a failure after a model call still spends the hourly budget', async () => {
  const store = waitingStore();
  const ref = store.record(store.ticket('c'), { question: 'dentist?', surface: 'remote', state: 'waiting' })!;
  const controller = createLocalPrivateAnswers({ store: () => store, answer: async input => {
    input.onModelCall?.();
    throw new Error('synthesis failed');
  } });
  cleanups.push(() => controller.close());
  await controller.tick();
  expect(store.get(ref.id)?.attempts).toBe(1);
  for (let i = 0; i < 4; i++) expect(store.reserveAutoAnswer(ref)).toBe(true);
  expect(store.reserveAutoAnswer(ref)).toBe(false);
});

for (const path of ['private', 'venice', 'anonymous'] as const) {
  test(`${path} rows share per-connection eviction limits without evicting another connection`, () => {
    const store = waitingStore();
    const victim = store.record(store.ticket('victim'), { question: 'Keep me', path: 'venice', surface: 'remote', state: 'waiting' })!;
    expect(store.saveAnswer(victim, A('Victim answer'))).toBe(true);
    const first = store.record(store.ticket('sender'), { question: 'First', path: 'private', surface: 'remote', state: 'waiting' })!;
    expect(store.saveAnswer(first, A('Oldest sender answer'))).toBe(true);
    for (let i = 0; i < 50; i++) {
      const ref = store.record(store.ticket('sender'), { question: `Question ${i}`, path, surface: 'remote', state: 'waiting' })!;
      expect(store.saveAnswer(ref, A(`Reply ${i}`), path === 'anonymous' ? `Sent ${i}` : undefined)).toBe(true);
    }
    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(victim.id)?.result?.answer).toBe('Victim answer');
    const own = store.list().questions.filter(q => q.connectionId === 'sender');
    expect(own).toHaveLength(50);
    expect(own.every(q => q.path === path)).toBe(true);
    expect(store.list().olderRemoved).toBe(true);
  });

  test(`${path} retained answers survive an unavailable eligibility check`, async () => {
    const store = waitingStore();
    const ref = store.record(store.ticket('sender'), { question: 'Question', path, surface: 'remote', state: 'waiting' })!;
    store.saveAnswer(ref, A('Keep this answer'), path === 'anonymous' ? 'Exact sent question' : undefined);
    let unavailable = true;
    const controller = createLocalPrivateAnswers({ store: () => store, answer: async () => ({ status: 'failed' }), eligible: async items => {
      if (unavailable) throw new Error('Transient ledger failure');
      return items.map(() => true);
    } });
    cleanups.push(() => controller.close());
    expect((await controller.handle({ action: 'read', id: ref.id }, 'owner')).body.status).toBe('check_unavailable');
    expect(store.get(ref.id)?.generation).toBe(ref.generation);
    expect(store.get(ref.id)?.result?.answer).toBe('Keep this answer');
    unavailable = false;
    expect((await controller.handle({ action: 'read', id: ref.id }, 'owner')).body.answer).toBe('Keep this answer');
  });
}

test('re-asking an anonymous question creates a new row and preserves its prior exact sent text', () => {
  const store = waitingStore();
  const input = { question: 'Anonymous question pending', path: 'anonymous' as const, surface: 'remote' as const, state: 'waiting' as const };
  const first = store.record(store.ticket('sender'), input)!;
  store.saveAnswer(first, A('First reply'), 'First exact sent question');
  store.markRead(first);
  const second = store.record(store.ticket('sender'), input)!;
  expect(second.id).not.toBe(first.id);
  expect(store.get(first.id)).toMatchObject({ question: 'First exact sent question', seen: true, generation: first.generation, result: { answer: 'First reply' } });
  expect(store.get(second.id)?.result).toBeUndefined();
  expect(store.saveAnswer(second, A('Second reply'), 'Second exact sent question')).toBe(true);
  expect(store.get(first.id)?.question).toBe('First exact sent question');
});

test('re-asking Venice retains answers and restarts not-found without allowing computer retries', async () => {
  const store = waitingStore();
  const input = { question: 'Venice question', path: 'venice' as const, surface: 'remote' as const, state: 'waiting' as const };
  const first = store.record(store.ticket('sender'), input)!;
  store.saveAnswer(first, A('Venice reply'));
  expect(store.record(store.ticket('sender'), input)).toEqual(first);
  const missing = store.record(store.ticket('sender'), { ...input, question: 'Missing Venice question' })!;
  store.saveAnswer(missing, { status: 'not_found', citations: [], unanswered: [], leftOut: [], read: [] });
  const again = store.record(store.ticket('sender'), { ...input, question: 'Missing Venice question' })!;
  expect(again).toMatchObject({ id: missing.id, generation: missing.generation + 1 });
  expect(store.get(again.id)).toMatchObject({ path: 'venice', state: 'waiting' });
  expect(store.get(again.id)?.result).toBeUndefined();
  let calls = 0;
  const controller = createLocalPrivateAnswers({ store: () => store, answer: async () => { calls++; return A('Wrong destination'); } });
  cleanups.push(() => controller.close());
  await controller.tick();
  expect(calls).toBe(0);
  expect(store.get(first.id)?.result?.answer).toBe('Venice reply');
});
