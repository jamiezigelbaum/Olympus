import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { routeSourceIndexSearch, seatRoutedLanes, type SeatingLane, type SourceIndexRoutedSearchHit } from '../src/core/source-index/router.ts';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { captureEvalPack, writePoolCapture, prepareCaptureReranker } from '../eval/capture-pool.ts';
import { replayPool, signFlipPValue, summarizeVariants, parseReplayArgs, laneAtDepth } from '../eval/replay-pool.ts';
import { parseEvalRealArgs } from '../eval/run-real.ts';
import { createTestClock } from './helpers/test-clock.ts';

const query = 'private fixture question never serialize';
const text = 'Private fixture text alpha beta gamma delta epsilon zeta.';
const question = { id: 'q1', shape: 'value_lookup' as const, question: query, expectedEvidence: [
  { corpusId: 'b', providerItemId: 'b2', quote: text, hint: 'never serialize this hint', alternates: [{ corpusId: 'a', providerItemId: 'a3' }] },
] };
function hit(corpusId: string, rank: number): SourceIndexRoutedSearchHit {
  const id = `${corpusId}${rank}`;
  return { corpusId, trustDomain: 'internal', candidateId: `candidate-${id}`,
    sourceItem: { family: 'file', provider: 'fixture', accountScope: 'test', providerItemId: id, localItemId: id },
    score: 100 - rank, rawExposed: false,
    ...(rank === 2 ? { keywordLeader: { kinds: ['name'], conceptShare: 1 } } : {}),
    ...(rank === 3 ? { newestInStore: 1, provenance: { sourceItem: { family: 'file', provider: 'fixture', accountScope: 'test', providerItemId: id, localItemId: id }, citation: { authoredAt: '2026-01-01T00:00:00Z' } } } : {}),
  };
}
const lanes: SeatingLane[] = ['a', 'b'].map(name => ({ name, relevance: { conceptShare: name === 'b' ? 1 : 0.5 }, items: [1, 2, 3].map(rank => hit(name, rank)) }));
function fixture() {
  const clock = createTestClock();
  const registry = buildSourceIndexCorpusRegistry(lanes.map(lane => defineSourceIndexCorpus({ corpusId: lane.name, family: 'file', trustDomain: 'internal' })));
  const adapters = Object.fromEntries(lanes.map(lane => [lane.name, (request: { maxResults: number }) => ({ hits: lane.items.slice(0, request.maxResults), storeRelevance: lane.relevance!, latencyMs: 0, rawExposed: false as const })]));
  const contentProviders = Object.fromEntries(lanes.map(lane => [lane.name, { async fetchLocalContent(request: { provenance: { sourceItem: { providerItemId: string } } }) {
    return { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: [request.provenance.sourceItem.providerItemId === 'b2' ? text : 'unrelated material'] };
  } }]));
  const reranker = { id: 'fixture', localOnly: true as const, poolSize: 6, score: async ({ passages }: { passages: readonly string[] }) => passages.map(p => p === text ? 9 : 1) };
  return { registry, adapters, contentProviders, reranker, question: query, maxResults: 2,
    searchContext: { allowedTrustDomains: ['internal' as const] },
    rerankTimers: { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: (timer: unknown) => clock.clearTimeout(timer as ReturnType<typeof clock.setTimeout>) } };
}

test('pure seating equals routed post-gate seats under both budgets, leaders and recency', async () => {
  for (const poolAllocation of [undefined, { storeDepth: 2 }]) for (const temporalIntent of [false, true]) {
    const input = fixture();
    const gated = lanes.map(lane => ({ ...lane, items: lane.items.filter(h => h.sourceItem.providerItemId !== 'a1') }));
    const options = { maxResults: 5, temporalIntent, ...(poolAllocation ? { poolAllocation } : {}) };
    let observed: readonly SeatingLane[] = [];
    let calls = 0;
    const result = await routeSourceIndexSearch({ registry: input.registry, adapters: input.adapters,
      request: { ...options, query, context: input.searchContext },
      visibilityGate: hits => hits.filter(h => h.sourceItem.providerItemId !== 'a1'),
      onSeatingLanes: value => { calls++; observed = value; },
    });
    expect(calls).toBe(1);
    expect(observed).toEqual(gated);
    const seated = seatRoutedLanes(gated, options);
    expect(result.hits).toEqual(seated.hits);
    expect(result.recencySeats ?? 0).toBe(seated.recencySeats);
  }
});

test('pack observers see each run ordinal and scores without affecting seats', async () => {
  const input = fixture();
  const baseline = await buildEvidencePackDetailed(input);
  const runs: number[] = [];
  const scores: unknown[] = [];
  const observed = await buildEvidencePackDetailed({ ...input,
    onSeatingLanes: (_lanes, ordinal) => { runs.push(ordinal); },
    onRerankScores: (entries, outcome) => { scores.push({ entries, outcome }); },
  });
  expect(observed.pack.candidates).toEqual(baseline.pack.candidates);
  expect(runs).toEqual([1]);
  expect(scores).toEqual([{ outcome: 'applied', entries: expect.arrayContaining([{ candidateId: 'candidate-b2', score: 9 }]) }]);
  runs.length = 0;
  await buildEvidencePackDetailed({ ...input, maxResults: 10, queryPlanner: async () => ['expansion one', 'expansion two'], onSeatingLanes: (_lanes, ordinal) => { runs.push(ordinal); } });
  expect(runs).toEqual([1, 2, 3]);
});

test('capture contains metadata only and replay reproduces live seats byte for byte', async () => {
  const f = fixture();
  const { detail, capture } = await captureEvalPack({ question, lanes: () => f, reranker: f.reranker, maxResults: 2, maxCharsPerCandidate: 2000, captureDepth: 3 });
  const dir = mkdtempSync(join(tmpdir(), 'olympus-pool-'));
  try {
    const path = writePoolCapture(dir, capture);
    const json = readFileSync(path, 'utf8');
    for (const secret of [query, text, 'never serialize this hint', 'unrelated material']) expect(json).not.toContain(secret);
    expect(capture.runs[0]!.lanes[0]!.items.map(i => i.rank)).toEqual([1, 2, 3]);
    const itemKeys = new Set(['candidateId', 'providerItemId', 'localItemId', 'rank', 'adapterScore', 'rerankerScore', 'keywordFirst', 'nameLeader', 'conceptShare', 'newestInStore', 'pinAppended', 'authoredAtMs', 'packEligible', 'expected', 'holdsQuote', 'matches']);
    for (const run of capture.runs) for (const lane of run.lanes) for (const item of lane.items) {
      expect(Object.keys(item).every(key => itemKeys.has(key))).toBe(true);
      expect(Object.entries(item).filter(([key]) => key !== 'matches').every(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))).toBe(true);
    }
    const replay = replayPool(JSON.parse(json), { storeDepth: 3, poolSize: 400, keep: 2 });
    const live = detail.pack.candidates.map((candidate, i) => ({ corpusId: detail.candidateCorpusIds[i]!, providerItemId: candidate.provenance.sourceItem.providerItemId }));
    expect(JSON.stringify(replay.pack.map(i => ({ corpusId: i.corpusId, providerItemId: i.providerItemId })))).toBe(JSON.stringify(live));
    expect(replay.expected[0]).toMatchObject({ documentPoolRank: 3, documentPackSeat: 1, paragraphPackSeat: 1 });
    const small = replayPool(capture, { storeDepth: 1, poolSize: 400, keep: 2 });
    expect(small.expected[0]!.documentPoolRank).toBeNull();
    expect(small.expected[0]!.paragraphPackSeat).toBeNull();
    expect(summarizeVariants([capture], [{ storeDepth: 3, poolSize: 400, keep: 2 }, { storeDepth: 1, poolSize: 400, keep: 2 }])[1]!.paired.documents).toEqual({ wins: 0, losses: 1, pValue: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('capture also replays expansion fusion, temporal and reranker-off packs', async () => {
  for (const temporal of [false, true]) for (const rerank of [false, true]) {
    const f = fixture();
    const q = { ...question, question: temporal ? 'What is the latest material?' : query };
    const { capture, detail } = await captureEvalPack({ question: q, lanes: () => f, ...(rerank ? { reranker: f.reranker } : {}), queryPlanner: async () => ['expanded'], maxResults: 10, maxCharsPerCandidate: 2000, captureDepth: 3 });
    expect(capture.runs).toHaveLength(2);
    const replay = replayPool(capture, { storeDepth: 3, poolSize: capture.poolSize, keep: 10 });
    expect(replay.pack.map(i => i.providerItemId)).toEqual(detail.pack.candidates.map(c => c.provenance.sourceItem.providerItemId));
  }
});

test('capture flags and missing reranker are explicit', async () => {
  expect(parseEvalRealArgs(['--capture-pool', '/tmp/capture', '--capture-depth', '12'], {})).toMatchObject({ capturePoolDir: '/tmp/capture', captureDepth: 12 });
  expect(parseEvalRealArgs([], { OLYMPUS_EVAL_CAPTURE_POOL_DIR: '/tmp/env-capture' })).toMatchObject({ capturePoolDir: '/tmp/env-capture', captureDepth: 30 });
  expect(() => parseEvalRealArgs(['--capture-depth', '0'], {})).toThrow();
  await expect(prepareCaptureReranker({ OLYMPUS_SOURCE_RERANKER: 'built-in', OLYMPUS_SOURCE_RERANKER_MODEL_DIR: '/tmp/nonexistent-olympus-reranker' })).rejects.toThrow('capture');
  expect(parseReplayArgs(['/tmp/capture', '--store-depth', '1,3', '--pool-size', '5,30', '--temporal', 'as-captured', '--json']).storeDepths).toEqual([1, 3]);
  expect(() => parseReplayArgs(['/tmp/capture', '--pool-size', '0'])).toThrow();
});

test('two-sided paired sign-flip probability counts discordant outcomes only', () => {
  expect(signFlipPValue(0, 0)).toBe(1);
  expect(signFlipPValue(1, 0)).toBe(1);
  expect(signFlipPValue(5, 0)).toBeCloseTo(0.0625);
  expect(signFlipPValue(4, 1)).toBeCloseTo(0.375);
  expect(signFlipPValue(4, 4)).toBe(1);
  expect(signFlipPValue(0, 5)).toBe(signFlipPValue(5, 0));
});

test('capture caps scoring at 400 in seating order and keeps metadata for the rest', async () => {
  const stores = Array.from({ length: 15 }, (_, i) => `store-${i}`);
  const registry = buildSourceIndexCorpusRegistry(stores.map(corpusId => defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'internal' })));
  const requests: number[] = [];
  const adapters = Object.fromEntries(stores.map(corpusId => [corpusId, (request: { maxResults: number }) => {
    requests.push(request.maxResults);
    return { hits: Array.from({ length: 30 }, (_, i) => {
      const { keywordLeader, newestInStore, ...plain } = hit(corpusId, i + 1);
      return { ...plain, candidateId: `${corpusId}:${i + 1}` };
    }), latencyMs: 0, rawExposed: false as const };
  }]));
  const contentProviders = Object.fromEntries(stores.map(corpusId => [corpusId, { async fetchLocalContent() { return { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: [text] }; } }]));
  let scored = 0;
  const q = { ...question, expectedEvidence: [{ corpusId: stores[14]!, providerItemId: `${stores[14]}30`, quote: text, hint: '' }] };
  const { capture, detail } = await captureEvalPack({ question: q, lanes: () => ({ registry, adapters, contentProviders }), captureDepth: 30, maxResults: 5, maxCharsPerCandidate: 2000,
    reranker: { id: 'wide', poolSize: 5, localOnly: true, async score({ passages }) { scored += passages.length; return passages.map((_, i) => i); } },
  });
  expect(requests).toEqual(stores.map(() => 30));
  expect(scored).toBe(400);
  expect([capture.capturedCandidates, capture.scoringTruncated, capture.scoreLimit]).toEqual([450, true, 400]);
  const tail = capture.runs[0]!.lanes[14]!.items[29]!;
  expect(tail).toMatchObject({ expected: true, holdsQuote: true });
  expect(tail.rerankerScore).toBeUndefined();
  const replay = replayPool(capture, { storeDepth: 30, poolSize: 400, keep: 5 });
  expect(replay.pool.map(i => i.rerankerScore)).toEqual(Array.from({ length: 400 }, (_, i) => i));
  expect(JSON.stringify(replay.pack.map(i => ({ corpusId: i.corpusId, providerItemId: i.providerItemId })))).toBe(JSON.stringify(capture.pack));
  expect(capture.pack.map(i => i.providerItemId)).toEqual(detail.pack.candidates.map(c => c.provenance.sourceItem.providerItemId));
});

test('replay preserves final visibility and model-policy exclusions', async () => {
  const f = fixture();
  let gates = 0;
  const { SourceModelPolicyDeniedError } = await import('../src/core/source-model-policy.ts');
  const { capture, detail } = await captureEvalPack({ question, captureDepth: 3, maxResults: 2, maxCharsPerCandidate: 2000, reranker: f.reranker,
    lanes: () => ({ ...f,
      visibilityGate: hits => { gates++; return gates > 1 ? hits.filter(h => h.sourceItem.providerItemId !== 'a1') : hits; },
      contentProviders: { ...f.contentProviders, b: { async fetchLocalContent(request) {
        if (request.provenance.sourceItem.providerItemId === 'b2') throw new SourceModelPolicyDeniedError();
        return f.contentProviders.b!.fetchLocalContent(request);
      } } },
    }),
  });
  expect(capture.runs[0]!.lanes[0]!.items[0]!.packEligible).toBe(false);
  expect(capture.runs[0]!.lanes[1]!.items[1]!.packEligible).toBe(false);
  expect(replayPool(capture, { storeDepth: 3, poolSize: 400, keep: 2 }).pack.map(i => i.providerItemId)).toEqual(detail.pack.candidates.map(c => c.provenance.sourceItem.providerItemId));
});

test('reranker observer reports failures and timeouts exactly once with no scores', async () => {
  const { rerankCandidates } = await import('../src/core/evidence-reranker.ts');
  const clock = createTestClock();
  const timers = { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: (timer: unknown) => clock.clearTimeout(timer as ReturnType<typeof clock.setTimeout>) };
  for (const fail of [true, false]) {
    const seen: unknown[] = [];
    const pending = rerankCandidates({ reranker: { id: 'failure', localOnly: true, poolSize: 2,
      score: async () => { if (fail) throw new Error('fixture'); return new Promise<never>(() => {}); },
    }, query, items: ['a', 'b'], passageOf: () => text, keep: 1, timers, timeoutMs: 20,
      onScores: (entries, outcome) => seen.push({ entries, outcome }),
    });
    if (!fail) await clock.advance(20);
    const result = await pending;
    expect(result.kept).toEqual(['a']);
    expect(seen).toEqual([{ entries: [], outcome: fail ? 'failed' : 'timed_out' }]);
    expect(clock.pendingTimers()).toBe(0);
  }
});

test('capture startup actually prepares a configured reranker and rejects a broken runtime', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'olympus-capture-model-'));
  try {
    writeFileSync(join(dir, 'model.onnx'), 'fixture');
    writeFileSync(join(dir, 'vocab.txt'), '[PAD]\n[UNK]\n[CLS]\n[SEP]\n[MASK]\n');
    const env = { OLYMPUS_SOURCE_RERANKER: 'built-in', OLYMPUS_SOURCE_RERANKER_MODEL_DIR: dir };
    let loads = 0;
    const reranker = await prepareCaptureReranker(env, { runtime: { async createSession() { loads++; return { async run() { return { data: new Float32Array([1]), dims: [1, 1] }; } }; } } });
    expect(loads).toBe(1);
    expect(reranker?.localOnly).toBe(true);
    await expect(prepareCaptureReranker(env, { runtime: { async createSession() { throw new Error('fixture runtime missing'); } } })).rejects.toThrow('capture could not load');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a smaller depth keeps the chat store\'s newest-message pins, as the adapter would at that depth', () => {
  type Item = { providerItemId: string; newestInStore?: number; pinAppended?: boolean };
  const item = (id: string, newestInStore?: number, pinAppended = false): Item => ({ providerItemId: id, ...(newestInStore ? { newestInStore } : {}), ...(pinAppended ? { pinAppended } : {}) });
  const ids = (items: Item[]) => items.map(i => i.providerItemId);
  // Captured at depth 5 from an adapter that pins its two newest messages: three hits, then the pins it appended.
  const captured = [item('h1'), item('h2'), item('h3'), item('p1', 1, true), item('p2', 2, true)];
  // At depth 3 the adapter keeps one hit and appends both pins; a plain prefix would drop both pins.
  expect(ids(laneAtDepth(captured, 3))).toEqual(['h1', 'p1', 'p2']);
  // Depth 2 leaves room for one pin beside a hit, depth 1 for the hit alone.
  expect(ids(laneAtDepth(captured, 2))).toEqual(['h1', 'p1']);
  expect(ids(laneAtDepth(captured, 1))).toEqual(['h1']);
  // A pin the adapter found among its ranked hits keeps its place.
  const kept = [item('h1'), item('p1', 1), item('h2'), item('h3'), item('p2', 2, true)];
  expect(ids(laneAtDepth(kept, 3))).toEqual(['h1', 'p1', 'p2']);
  // Ranked pins at the tail are hits, not appended pins (Codex on #1620): at depth 1 the top hit stays.
  const ranked = [item('p2', 2), item('p1', 1)];
  expect(laneAtDepth(ranked, 1)).toEqual([{ providerItemId: 'p2' }]);
  // A ranked pin cut at a smaller depth is appended there.
  const cut = [item('h1'), item('h2'), item('p1', 1)];
  expect(laneAtDepth(cut, 2)).toEqual([item('h1'), item('p1', 1, true)]);
  // A ranked pin is protected only when its turn comes, newest first (Codex on #1620): the newest
  // is appended first and evicts the unmarked second newest, which is then appended after it.
  const turn = [item('h1'), item('h2'), item('p2', 2), item('h3'), item('p1', 1, true)];
  expect(ids(laneAtDepth(turn, 3))).toEqual(['h1', 'p1', 'p2']);
  // A pin the visibility gate removed keeps its turn and its slot (Codex on #1620): only the second newest
  // was captured, so at depth 2 the adapter placed the newest there and the gate removed it.
  const gated = [item('h1'), item('h2'), item('h3'), item('p2', 2, true)];
  expect(ids(laneAtDepth(gated, 2))).toEqual(['h1']);
  expect(ids(laneAtDepth(gated, 3))).toEqual(['h1', 'p2']);
  // Without pins a smaller depth is the prefix.
  expect(ids(laneAtDepth([item('h1'), item('h2'), item('h3')], 2))).toEqual(['h1', 'h2']);
  expect(laneAtDepth(captured, 5)).toEqual(captured);
});
