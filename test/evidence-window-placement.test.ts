import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { buildEvidencePackDetailed, clipChunksToUtf8Bytes, utf8ByteLength } from '../src/core/evidence-pack.ts';
import type { EvidenceReranker, RerankTimers } from '../src/core/evidence-reranker.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { LocalConnectorStore, createConnectorStoreContentProvider, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { createEvidenceWindowPlacer, type WindowScorer } from '../src/core/evidence-window-placement.ts';
import { boundedSourceIndexChunks, sourceIndexChunkWindow } from '../src/core/source-index/chunk-selection.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';
import { releasePassageHashes } from '../src/core/release-manifest.ts';

const QUESTION = 'Where is the rendezvous?';
const ANSWER = 'Assemble beside the amber fountain.';
const corpusId = 'fixture.windows';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function fixture({ secure = false, single = false, backend = 'local', providerName = 'fixture', shortTail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-windows-'));
  const trustDomain = secure ? 'secure_local' as const : 'internal' as const;
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'store.sqlite'), corpusId, family: 'file', trustDomain,
    // Ingestion pacing is unrelated to window placement; keep setup independent of host load.
    controlPath: { ingestionTurn: async () => {} },
  });
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const items: RawItem[] = Array.from({ length: 4 }, (_, index) => ({
    identity: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: `${index}`, localItemId: `${index}` },
    mimeType: 'text/plain', metadata: { name: `entry-${index}` }, fetchedAt: '2026-11-12T00:00:00Z',
    content: { kind: 'text', text: Array.from({ length: single && index === 0 ? 1 : shortTail ? 2 : 3 }, (_, n) =>
      (`rendezvous ${n} ` + 'x'.repeat(1485) + ANSWER + 'y'.repeat(2500)).slice(0, shortTail && n === 1 ? 1000 : 4000)).join('') },
  }));
  const connector: SourceConnector = {
    id: 'fixture', family: 'file', authenticate: async () => {}, classificationSignals: () => ({}),
    async *listItems() { yield { items, done: true }; },
    async fetchItem(id) { return items.find(item => item.identity.localItemId === id)!; },
  };
  await store.syncFromConnector(connector, { fetchContent: true, maxChunkChars: 4000 });
  const calls: string[][] = [];
  const embedding: SourceEmbeddingProvider = {
    provider: providerName, backend: backend as 'local' | 'cloud', dimension: 2, modelId: 'fixture-vector', configHash: 'fixture', epochId: 'fixture',
    async embed(inputs, options) {
      calls.push(inputs.map(input => input.text));
      return inputs.map(input => options.taskType === 'RETRIEVAL_QUERY' || input.text.includes(ANSWER) ? [1, 0] : [0, 1]);
    },
  };
  const contentProvider = createConnectorStoreContentProvider({ store, embeddingProvider: embedding });
  const input = {
    question: QUESTION, maxResults: 4, maxCharsPerCandidate: 3000,
    registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId, family: 'file', trustDomain })]),
    searchContext: { allowedTrustDomains: [trustDomain] },
    adapters: { [corpusId]: () => ({ hits: items.map(item => ({ sourceItem: item.identity, provenance: { sourceItem: item.identity }, rawExposed: false as const })), rawExposed: false as const, latencyMs: 0 }) },
    contentProviders: { [corpusId]: contentProvider },
  };
  return { input, calls, embedding, store, contentProvider, items };
}

const text = (detail: Awaited<ReturnType<typeof buildEvidencePackDetailed>>, seat = 0) => detail.pack.candidates[seat]!.chunks.join('\n');

test('p173: embedding windows recover the paraphrased answer inside the already selected chunks', async () => {
  const f = await fixture();
  const before = await f.contentProvider.fetchLocalContent({ provenance: { sourceItem: f.items[0]!.identity }, trustDomain: 'internal', query: QUESTION, maxChars: 3000 });
  expect(before!.chunks.join('\n')).not.toContain(ANSWER);
  const detail = await buildEvidencePackDetailed(f.input);
  expect(text(detail)).toContain(ANSWER);
  expect(detail.windowPlacement).toMatchObject({ scorer: 'embedding', windowsScored: 24, timedOut: false });
  // All three seats share this store scorer.
  expect(f.calls.filter(call => call.length > 1).map(call => call.length)).toEqual([24]);
});

test('reranker windows recover the same answer and leave seat order intact', async () => {
  const f = await fixture();
  const calls: string[][] = [];
  const reranker: EvidenceReranker = { id: 'fixture', localOnly: true, poolSize: 4, async score({ passages }) {
    calls.push([...passages]); return passages.map(passage => passage.includes(ANSWER) ? 1 : 0);
  } };
  const detail = await buildEvidencePackDetailed({ ...f.input, reranker });
  for (let seat = 0; seat < 3; seat++) expect(text(detail, seat)).toContain(ANSWER);
  expect(f.calls).toEqual([]);
  expect(detail.pack.candidates.map(c => c.provenance.sourceItem.localItemId)).toEqual(['0', '1', '2', '3']);
  expect(detail.windowPlacement).toMatchObject({ scorer: 'reranker', windowsScored: 24, timedOut: false });
  // The pack rerank, then one call holding every eligible seat.
  expect(calls.map(call => call.length)).toEqual([4, 24]);
});

for (const providerName of ['fixture', 'venice']) test(`secure_local windows refuse cloud provider ${providerName}`, async () => {
  const f = await fixture({ secure: true, backend: 'cloud', providerName });
  const detail = await buildEvidencePackDetailed(f.input);
  expect(text(detail)).not.toContain(ANSWER);
  expect(f.calls).toEqual([]);
  expect(detail.windowPlacement).toMatchObject({ scorer: 'none', windowsScored: 0, timedOut: false });
});

test('hung window scoring is bounded by the shared deadline and audited using the injected clock', async () => {
  const f = await fixture();
  const clock = createTestClock();
  const timers: RerankTimers = { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: handle => clock.clearTimeout(handle as Parameters<typeof clock.clearTimeout>[0]) };
  let calls = 0;
  const reranker: EvidenceReranker = { id: 'fixture', localOnly: true, poolSize: 4, score({ passages }) {
    calls++; return calls === 1 ? Promise.resolve(passages.map(() => 0)) : new Promise(() => {});
  } };
  const pending = buildEvidencePackDetailed({ ...f.input, reranker, windowPlacementTimers: timers });
  await flushMicrotasks(200);
  expect(calls).toBe(2);
  await clock.advance(1500);
  const detail = await pending;
  expect(text(detail)).not.toContain(ANSWER);
  expect(detail.windowPlacement).toMatchObject({ scorer: 'reranker', windowsScored: 0, timedOut: true, elapsedMs: 1500 });
  expect(clock.pendingTimers()).toBe(0);
});

test('only the top three multi-passage seats change, with the original character and byte limits', async () => {
  const f = await fixture({ single: true });
  const before = await Promise.all(f.items.map(item => f.contentProvider.fetchLocalContent({ provenance: { sourceItem: item.identity }, trustDomain: 'internal', query: QUESTION, maxChars: 3000 })));
  const detail = await buildEvidencePackDetailed(f.input);
  expect(detail.pack.candidates[0]!.chunks).toEqual(before[0]!.chunks);
  expect(detail.pack.candidates[3]!.chunks).toEqual(before[3]!.chunks);
  expect(text(detail, 1)).toContain(ANSWER);
  for (const candidate of detail.pack.candidates) expect(candidate.chunks.join('').length).toBeLessThanOrEqual(3000);
  const bounded = await buildEvidencePackDetailed({ ...f.input, evidenceByteBudget: 4800 });
  for (const candidate of bounded.pack.candidates) expect(utf8ByteLength(candidate.chunks.join(''))).toBeLessThanOrEqual(1200);
});


test('all three eligible leading seats receive windows; the fourth keeps its exact word clip', async () => {
  const f = await fixture({ shortTail: true });
  const detail = await buildEvidencePackDetailed(f.input);
  for (let seat = 0; seat < 3; seat++) expect(text(detail, seat)).toContain(ANSWER);
  expect(text(detail, 3)).not.toContain(ANSWER);
  expect(detail.windowPlacement).toMatchObject({ seats: 3, windowsScored: 24 });
  expect(f.calls.filter(call => call.length > 1).map(call => call.length)).toEqual([24]);
});

test('ordinary cloud embeddings also fall back without sending window text', async () => {
  const f = await fixture({ backend: 'cloud' });
  const detail = await buildEvidencePackDetailed(f.input);
  expect(f.calls).toEqual([]);
  expect(text(detail)).not.toContain(ANSWER);
  expect(detail.windowPlacement).toMatchObject({ scorer: 'none', windowsScored: 0 });
});

test('placement shares never split code points and stay inside the character and UTF-8 clips', () => {
  const full = '😀'.repeat(2000);
  expect(sourceIndexChunkWindow('\ude00hello\ud83d', 0, 100)).toBe('hello');
  for (const start of [0, 1, 299, 300, 1501, 3900]) {
    const window = sourceIndexChunkWindow(full, start, 601);
    expect(window.length).toBeLessThanOrEqual(601);
    expect(new TextDecoder().decode(new TextEncoder().encode(window))).toBe(window);
    const byteClip = clipChunksToUtf8Bytes([window], 997).join('');
    expect(utf8ByteLength(byteClip)).toBeLessThanOrEqual(997);
    expect(new TextDecoder().decode(new TextEncoder().encode(byteClip))).toBe(byteClip);
    const bounded = boundedSourceIndexChunks([full, 'other'], 606, [], [start]);
    expect(bounded.chunks.join('').length).toBeLessThanOrEqual(606);
    expect(bounded.chunks.every(chunk => new TextDecoder().decode(new TextEncoder().encode(chunk)) === chunk)).toBe(true);
  }
});

test('malformed and failed scores leave every original word clip intact', async () => {
  const chunks = ['o'.repeat(600), 'whole'];
  for (const scoreWindows of [async () => [1], async () => [NaN, 1], async () => { throw new Error('unavailable'); }]) {
    const placer = createEvidenceWindowPlacer(QUESTION);
    expect(await placer.place(chunks, { texts: ['x'.repeat(900), 'whole'], scoreWindows })).toEqual(chunks);
    expect(placer.audit.timedOut).toBe(false);
  }
});

test('scores delivered at the deadline are discarded even before the timer fires', async () => {
  const clock = createTestClock();
  const placer = createEvidenceWindowPlacer(QUESTION, { now: clock.now, setTimeout: clock.setTimeout,
    clearTimeout: handle => clock.clearTimeout(handle as Parameters<typeof clock.clearTimeout>[0]) });
  const chunks = ['o'.repeat(600), 'whole'];
  const result = await placer.place(chunks, { texts: ['x'.repeat(4000), 'whole'], scoreWindows: async () => {
    clock.set(clock.now() + 1500); return Array(8).fill(1);
  } });
  expect(result).toEqual(chunks);
  expect(placer.audit).toMatchObject({ timedOut: true, elapsedMs: 1500 });
  expect(clock.pendingTimers()).toBe(0);
});


test('placement follows the final reranked seats rather than the hydration order', async () => {
  const f = await fixture({ shortTail: true });
  let calls = 0;
  const reranker: EvidenceReranker = { id: 'reverse', localOnly: true, poolSize: 4, async score({ passages }) {
    calls++;
    return calls === 1 ? passages.map((_, index) => index) : passages.map(passage => passage.includes(ANSWER) ? 1 : 0);
  } };
  const detail = await buildEvidencePackDetailed({ ...f.input, reranker });
  expect(detail.pack.candidates.map(candidate => candidate.provenance.sourceItem.localItemId)).toEqual(['3', '2', '1', '0']);
  for (let seat = 0; seat < 3; seat++) expect(text(detail, seat)).toContain(ANSWER);
  expect(text(detail, 3)).not.toContain(ANSWER);
  expect(detail.windowPlacement).toMatchObject({ seats: 3, scorer: 'reranker', windowsScored: 24 });
});


test('a scorer rejection after consuming the deadline still records a timeout', async () => {
  const clock = createTestClock();
  const placer = createEvidenceWindowPlacer(QUESTION, { now: clock.now, setTimeout: clock.setTimeout,
    clearTimeout: handle => clock.clearTimeout(handle as Parameters<typeof clock.clearTimeout>[0]) });
  const chunks = ['o'.repeat(600), 'whole'];
  expect(await placer.place(chunks, { texts: ['x'.repeat(4000), 'whole'], scoreWindows: async () => {
    clock.set(clock.now() + 1500); throw new Error('failed at the deadline');
  } })).toEqual(chunks);
  expect(placer.audit).toMatchObject({ timedOut: true, elapsedMs: 1500 });
  expect(clock.pendingTimers()).toBe(0);
});

test('secure_local placement uses the allowed local embedding provider', async () => {
  const f = await fixture({ secure: true });
  const detail = await buildEvidencePackDetailed(f.input);
  expect(text(detail)).toContain(ANSWER);
  expect(detail.windowPlacement).toMatchObject({ scorer: 'embedding', windowsScored: 24 });
});

test('selected-item and recency builds never invoke the otherwise configured reranker for windows', async () => {
  const f = await fixture({ shortTail: true });
  let calls = 0;
  const reranker: EvidenceReranker = { id: 'forbidden', localOnly: true, poolSize: 4, async score() {
    calls++; throw new Error('reranker must not run here');
  } };
  for (const override of [
    { selectedItems: f.items.map(item => ({ corpusId, sourceItem: item.identity })) },
    { question: 'What is the latest rendezvous?' },
  ]) {
    const detail = await buildEvidencePackDetailed({ ...f.input, reranker, ...override });
    expect(calls).toBe(0);
    expect(detail.rerank).toBeUndefined();
    expect(detail.windowPlacement?.scorer).toBe('embedding');
  }
});

test('each seat scores at most eight windows (its word clip plus seven spread over the whole chunk), 24 per question', async () => {
  const full = 'x'.repeat(4000);
  const placer = createEvidenceWindowPlacer(QUESTION);
  const batches: string[][] = [];
  const scoreWindows = async (_query: string, windows: readonly string[]) => { batches.push([...windows]); return windows.map(() => 0); };
  const source = { texts: [full, full, full], scoreWindows };
  for (let seat = 0; seat < 5; seat++) await placer.place(['k'.repeat(600), 'k'.repeat(600), 'k'.repeat(600)], source);
  // The leading chunk takes the seat's eight windows; the question's 24 run out at the fourth seat.
  expect(batches.map(batch => batch.length)).toEqual([8, 8, 8]);
  expect(batches.flat().every(window => window.length === 600)).toBe(true);
  expect(placer.audit.windowsScored).toBe(24);
  // One long chunk: the word clip, then seven windows from its start to its end, evenly spaced.
  const labelled = Array.from({ length: 4000 }, (_, index) => String.fromCharCode(0x1000 + index)).join('');
  const original = labelled.slice(1000, 1600);
  const seen: string[][] = [];
  await createEvidenceWindowPlacer(QUESTION).place([original, 'whole'], { texts: [labelled, 'whole'], scoreWindows: async (_query, windows) => {
    seen.push([...windows]); return windows.map(() => 0);
  } });
  expect(seen).toEqual([[original, ...[0, 567, 1133, 1700, 2267, 2833, 3400].map(start => labelled.slice(start, start + 600))]]);
  const twelveHundred = labelled.slice(0, 1200);
  const short: string[][] = [];
  await createEvidenceWindowPlacer(QUESTION).place([twelveHundred.slice(300, 900)], { texts: [twelveHundred], scoreWindows: async (_query, windows) => {
    short.push([...windows]); return windows.map(() => 0);
  } });
  expect(short).toEqual([[twelveHundred.slice(300, 900), ...[0, 300, 600].map(start => twelveHundred.slice(start, start + 600))]]);
});

test('an answer near the end of a long chunk is reachable', async () => {
  const tail = 'Assemble beside the amber fountain.';
  const full = ('x'.repeat(3400) + tail).padEnd(4000, 'y');
  const placer = createEvidenceWindowPlacer(QUESTION);
  const placed = await placer.place(['x'.repeat(600)], { texts: [full], scoreWindows: async (_query, windows) =>
    windows.map(window => (window.includes(tail) ? 1 : 0)) });
  expect(placed[0]).toContain(tail);
});

test('the deadline is shared across seats and a completed placement survives a later timeout', async () => {
  const clock = createTestClock();
  const placer = createEvidenceWindowPlacer(QUESTION, { now: clock.now, setTimeout: clock.setTimeout,
    clearTimeout: handle => clock.clearTimeout(handle as Parameters<typeof clock.clearTimeout>[0]) });
  const chunks = ['o'.repeat(600), 'whole'];
  const placed = await placer.place(chunks, { texts: ['x'.repeat(2100) + 'PLACED' + 'x'.repeat(1900), 'whole'], scoreWindows: async (_query, windows) => {
    clock.set(clock.now() + 1000); return windows.map(window => (window.includes('PLACED') ? 1 : 0));
  } });
  expect(placed[0]).toContain('PLACED');
  const pending = placer.place(chunks, { texts: ['y'.repeat(4000), 'whole'] }, () => new Promise(() => {}));
  await clock.advance(500);
  expect(await pending).toEqual(chunks);
  expect(placed[0]).toContain('PLACED');
  expect(placer.audit).toMatchObject({ seats: 2, windowsScored: 8, timedOut: true, elapsedMs: 1500 });
  expect(clock.pendingTimers()).toBe(0);
});

test('windows are scored at the share that is kept, so the winning text survives the clip', async () => {
  const answer = 'FOUNTAIN';
  // Windows start at 0, 574, …: the one at 574 holds the answer in its first 555 characters.
  const full = ('x'.repeat(580) + answer).padEnd(4000, 'y');
  const placer = createEvidenceWindowPlacer(QUESTION);
  const seen: number[] = [];
  const placed = await placer.place(['k'.repeat(555)], { texts: [full], scoreWindows: async (_query, windows) => {
    seen.push(...windows.map(window => window.length));
    return windows.map(window => (window.includes(answer) ? 1 : 0));
  } });
  expect(seen.every(length => length === 555)).toBe(true);
  expect(placed[0]).toHaveLength(555);
  expect(placed[0]).toContain(answer);
});

test('a chunk less than one stride longer than its share still scores its tail', async () => {
  const answer = 'FOUNTAIN';
  const full = ('x'.repeat(750) + answer).padEnd(850, 'y');
  const placer = createEvidenceWindowPlacer(QUESTION);
  const placed = await placer.place(['k'.repeat(600)], { texts: [full], scoreWindows: async (_query, windows) =>
    windows.map(window => (window.includes(answer) ? 1 : 0)) });
  expect(placed[0]).toContain(answer);
});

test('windows go to the most relevant passage first even when it comes later in the document', async () => {
  const answer = 'FOUNTAIN';
  const early = 'e'.repeat(4000);
  const late = ('l'.repeat(2000) + answer).padEnd(4000, 'l');
  const placer = createEvidenceWindowPlacer(QUESTION);
  const scoredFrom: string[] = [];
  const placed = await placer.place(['e'.repeat(600), 'l'.repeat(600)], { texts: [early, late], priority: [1, 0],
    scoreWindows: async (_query, windows) => {
      scoredFrom.push(...windows.map(window => window[0]!));
      return windows.map(window => (window.includes(answer) ? 1 : 0));
    } });
  expect(scoredFrom.every(letter => letter === 'l')).toBe(true);
  expect(placed[0]).toBe('e'.repeat(600));
  expect(placed[1]).toContain(answer);
});

test('windows are scored and kept inside each passage\'s UTF-8 byte share', async () => {
  const answer = 'FOUNTAIN';
  // A window starts at 1,133. Its 600 characters hold both cues; its 600 bytes
  // hold only the near one, so the far one must not be what wins.
  const far = 'FARCUE';
  const full = ('x'.repeat(1133) + '漢'.repeat(60) + answer + '漢'.repeat(200) + far).padEnd(4000, 'y');
  const placer = createEvidenceWindowPlacer(QUESTION);
  const scored: string[] = [];
  const placed = await placer.place(['k'.repeat(600)], { texts: [full], scoreWindows: async (_query, windows) => {
    scored.push(...windows);
    return windows.map(window => (window.includes(far) ? 2 : window.includes(answer) ? 1 : 0));
  } }, undefined, [600]);
  expect(scored.some(window => window.includes(far))).toBe(false);
  expect(scored.every(window => utf8ByteLength(window) <= 600)).toBe(true);
  expect(utf8ByteLength(placed[0]!)).toBeLessThanOrEqual(600);
  expect(placed[0]).toContain(answer);
});

test('the word clip is always a candidate and keeps its place on a tie, so a small share never loses it', async () => {
  const answer = 'FOUNTAIN';
  const full = ('x'.repeat(250) + answer).padEnd(4000, 'y');
  const original = full.slice(200, 333);
  const placer = createEvidenceWindowPlacer(QUESTION);
  const scored: string[] = [];
  const placed = await placer.place([original, 'whole'], { texts: [full, 'whole'], scoreWindows: async (_query, windows) => {
    scored.push(...windows);
    return windows.map(window => (window.includes(answer) ? 1 : 0));
  } });
  expect(scored).toContain(original);
  expect(scored.length).toBeLessThanOrEqual(8);
  expect(placed[0]).toBe(original);
  const flat = await createEvidenceWindowPlacer(QUESTION).place([original, 'whole'], { texts: [full, 'whole'],
    scoreWindows: async (_query, windows) => windows.map(() => 0) });
  expect(flat[0]).toBe(original);
});

test('a winning window near the end survives being widened to the share and byte-clipped', async () => {
  const answer = 'FOUNTAIN';
  const full = ('漢'.repeat(3900) + answer).padEnd(4000, '漢');
  const placer = createEvidenceWindowPlacer(QUESTION);
  const placed = await placer.place(['k'.repeat(1500)], { texts: [full], scoreWindows: async (_query, windows) =>
    windows.map(window => (window.includes(answer) ? 1 : 0)) }, undefined, [3000]);
  expect(utf8ByteLength(placed[0]!)).toBeLessThanOrEqual(3000);
  expect(placed[0]).toContain(answer);
});

function fakeTimers(clock: ReturnType<typeof createTestClock>): RerankTimers {
  return { now: clock.now, setTimeout: clock.setTimeout,
    clearTimeout: handle => clock.clearTimeout(handle as Parameters<typeof clock.clearTimeout>[0]) };
}

for (const kind of ['embedding', 'reranker'] as const) test(`${kind}: late completion suppresses calls until a fast in-flight call finishes`, async () => {
  const chunks = ['o'.repeat(600)];
  const source = { texts: ['x'.repeat(4000)] };
  const run = (placer: ReturnType<typeof createEvidenceWindowPlacer>, scorer: WindowScorer) =>
    kind === 'reranker' ? placer.place(chunks, source, scorer) : placer.place(chunks, { ...source, scoreWindows: scorer });
  const clock = createTestClock();
  let finishSlow!: (scores: number[]) => void;
  let calls = 0;
  const scorer = async () => { calls++; return new Promise<readonly number[]>(resolve => { finishSlow = resolve; }); };
  const placer = createEvidenceWindowPlacer(QUESTION, fakeTimers(clock));
  const pending = run(placer, scorer);
  await clock.advance(1400);
  // This second question starts before the slow completion is known.
  let finishFast!: (scores: number[]) => void;
  const fast = run(createEvidenceWindowPlacer(QUESTION, fakeTimers(clock)), () => new Promise(resolve => { finishFast = resolve; }));
  await clock.advance(100);
  expect(await pending).toEqual(chunks);
  expect(placer.audit).toMatchObject({ windowsSubmitted: 8, calls: [{ windows: 8, ms: 1500, outcome: 'timed_out' }] });
  await clock.advance(100);
  finishSlow(Array(8).fill(0));
  await flushMicrotasks();
  const skipped = createEvidenceWindowPlacer(QUESTION, fakeTimers(clock));
  expect(await run(skipped, scorer)).toEqual(chunks);
  expect(calls).toBe(1);
  expect(skipped.audit).toMatchObject({ skipped: 'slow_scorer', seats: 0, windowsSubmitted: 0, elapsedMs: 0, calls: [] });
  await clock.advance(10);
  finishFast(Array(8).fill(0));
  await fast;
  const recovered = createEvidenceWindowPlacer(QUESTION, fakeTimers(clock));
  await run(recovered, async (_query, windows) => { calls++; return windows.map(() => 0); });
  expect(calls).toBe(2);
  expect(recovered.audit.windowsScored).toBe(8);
});

for (const outcome of ['scored', 'failed', 'malformed'] as const) test(`calls audit measures ${outcome} without text`, async () => {
  const clock = createTestClock();
  const placer = createEvidenceWindowPlacer(QUESTION, fakeTimers(clock));
  const chunks = ['o'.repeat(600)];
  const result = await placer.place(chunks, { texts: ['x'.repeat(4000)], scoreWindows: async (_query, windows) => {
    clock.set(clock.now() + 25);
    if (outcome === 'failed') throw new Error('unavailable');
    return outcome === 'malformed' ? [NaN] : windows.map(() => 0);
  } });
  expect(result).toEqual(chunks);
  expect(placer.audit).toMatchObject({ windowsSubmitted: 8, elapsedMs: 25,
    calls: [{ windows: 8, ms: 25, outcome: outcome === 'scored' ? 'scored' : 'failed' }] });
});


test('embedding seats batch by scorer identity in first-seat order and keep each seat result', async () => {
  const clock = createTestClock();
  const calls: { store: string; windows: number }[] = [];
  const scorer = (store: string): WindowScorer => async (_query, windows) => {
    calls.push({ store, windows: windows.length });
    return windows.map(window => window.includes('TAIL') ? 1 : 0);
  };
  const first = scorer('first');
  const second = scorer('second');
  const seats = [first, second, first].map((scoreWindows, index) => ({
    chunks: ['original'.repeat(75)],
    source: { texts: ['x'.repeat(3990) + `TAIL${index}`], scoreWindows },
  }));
  const placer = createEvidenceWindowPlacer(QUESTION, fakeTimers(clock));
  const results = await placer.placeAll(seats);
  expect(calls).toEqual([{ store: 'first', windows: 16 }, { store: 'second', windows: 8 }]);
  for (let seat = 0; seat < 3; seat++) expect(results[seat]![0]).toContain(`TAIL${seat}`);
  expect(placer.audit).toMatchObject({ seats: 3, windowsSubmitted: 24, windowsScored: 24,
    calls: [{ windows: 16, ms: 0, outcome: 'scored' }, { windows: 8, ms: 0, outcome: 'scored' }] });
});

test('a failed reranker never falls back to the available embedding scorer', async () => {
  const clock = createTestClock();
  let embeddings = 0;
  const seat = { chunks: ['o'.repeat(600)], source: { texts: ['x'.repeat(4000)],
    scoreWindows: async (_query: string, windows: readonly string[]) => { embeddings++; return windows.map(() => 1); } } };
  const placer = createEvidenceWindowPlacer(QUESTION, fakeTimers(clock));
  expect(await placer.placeAll([seat, seat, seat], async () => { throw new Error('reranker unavailable'); }))
    .toEqual([seat.chunks, seat.chunks, seat.chunks]);
  expect(embeddings).toBe(0);
  expect(placer.audit).toMatchObject({ scorer: 'reranker', calls: [{ windows: 24, ms: 0, outcome: 'failed' }] });
});

test('a scorer skipped as slow is tried again after a minute, so placement is never off for good', async () => {
  const chunks = ['o'.repeat(600)];
  const clock = createTestClock();
  let calls = 0;
  const slow: WindowScorer = (_query, windows) => { calls++; return new Promise(settle => { clock.setTimeout(() => settle(windows.map(() => 0)), 2_000); }); };
  const first = createEvidenceWindowPlacer(QUESTION, fakeTimers(clock));
  const pending = first.place(chunks, { texts: ['x'.repeat(4000)], scoreWindows: slow });
  await clock.advance(2_000);
  await pending;
  await flushMicrotasks();
  const skipped = createEvidenceWindowPlacer(QUESTION, fakeTimers(clock));
  await skipped.place(chunks, { texts: ['x'.repeat(4000)], scoreWindows: slow });
  expect(skipped.audit.skipped).toBe('slow_scorer');
  expect(calls).toBe(1);
  await clock.advance(60_000);
  const retried = createEvidenceWindowPlacer(QUESTION, fakeTimers(clock));
  await retried.place(chunks, { texts: ['x'.repeat(4000)], scoreWindows: async (_query, windows) => { calls++; return windows.map(() => 0); } });
  expect(calls).toBe(2);
  expect(retried.audit.windowsScored).toBe(8);
});

test('a placed window stays provable: its stored chunk hashes still bind to it for release', async () => {
  const f = await fixture();
  const detail = await buildEvidencePackDetailed(f.input);
  const seat = detail.pack.candidates[0]!;
  const placed = seat.chunks.find(chunk => chunk.includes(ANSWER));
  expect(placed).toBeDefined();
  expect(releasePassageHashes(seat.provenance, placed!).length).toBeGreaterThan(0);
});
