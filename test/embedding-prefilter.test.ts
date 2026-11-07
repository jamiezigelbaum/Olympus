// All labels, vectors, text and weights in this file are synthetic fixtures.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EmbeddingPrefilter, embeddingPrefilterDirectory, prefilterVector } from '../src/workers/classification/embedding-prefilter.ts';
import { EMBEDDING_PREFILTER_MODEL_ID as MODEL, EMBEDDING_PREFILTER_DIMENSIONS as D } from '../src/workers/classification/embedding-logistic.ts';
import { TierLedger, type TierPlacementPlan } from '../src/workers/classification/tier-ledger.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { CachedTierSniffer, SNIFFER_PROMPT_VERSION, snifferId, snifferCacheModelId } from '../src/workers/classification/sniffer.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { classifyItemTiers, normalizedContentHash, type TierDecision } from '../src/workers/classification/tier-classifier.ts';
import { tierSnifferServiceEnv } from '../src/workers/classification/sniffer-service.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import type { ConnectorStoreItemCopy } from '../src/workers/connector-store/local-index.ts';
const lane: SnifferLane = { kind: 'local', modelId: 'fixture', profileId: 'fixture', profile: {
  provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture',
} };
const judge = snifferId(lane);
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const subject = (n: number) => ({ provider: 'fixture', accountScope: 'fixture', providerItemId: String(n) });
const ownText = 'Please bring the picnic basket and the sandwiches on Sunday.';
function copy(n: number, sign = 1): ConnectorStoreItemCopy {
  const vector = new Float32Array(D); vector[0] = sign;
  return { identity: { ...subject(n), family: 'file', localItemId: String(n) }, columns: {} as ConnectorStoreItemCopy['columns'],
    trustTier: 'S4', owners: [], chunks: [{ chunkIndex: 0, boundedText: ownText, contentHash: 'fixture', embeddingInputHash: 'fixture' }],
    vectors: [{ chunkIndex: 0, modelId: MODEL, contentHash: 'fixture', embedding: new Uint8Array(vector.buffer) }], vectorAuthorities: [] };
}
function fixture(options: { trained?: boolean; bias?: number; random?: () => number; enabled?: () => boolean; routed?: boolean; stateLedger?: TierLedger } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prefilter-synthetic-'));
  const ledger = new TierLedger({ dbPath: join(dir, 'tiers.sqlite') });
  const sniffer = new TierSnifferStore({ dbPath: join(dir, 'sniffer.sqlite') });
  const modelDir = embeddingPrefilterDirectory(options.stateLedger?.dbPath ?? ledger.dbPath);
  if (options.trained !== false) {
    mkdirSync(modelDir, { mode: 0o755 });
    writeFileSync(join(modelDir, 'weights.json'), JSON.stringify({ version: '00000000-0000-0000-0000-000000000939',
      trainedAt: Date.now(), judge, revisions: JSON.stringify([[ledger.ledgerId(), '0']]) + ':0', model: { weights: new Array(D).fill(0), bias: options.bias ?? -5 } }), { mode: 0o644 });
  }
  const placementFor = (decision: TierDecision): TierPlacementPlan => ({
    copies: [{ corpusId: decision.contentPending ? 'private' : 'personal', trustDomain: decision.contentPending ? 'secure_local' : 'internal',
      layers: 'both' }], embedHold: decision.contentPending,
  });
  let currentCopy = (n: number) => copy(n);
  const make = () => new EmbeddingPrefilter({ ledger, sniffer, ...(options.stateLedger ? { stateLedger: options.stateLedger } : {}), copyFor: identity => currentCopy(Number(identity.providerItemId)),
    ...(options.routed ? { placementFor } : {}), random: options.random ?? (() => 1), ...(options.enabled ? { enabled: options.enabled } : {}) });
  const filter = make();
  const add = (n: number, config: Parameters<typeof classifyItemTiers>[1] = {}, text = ownText) => {
    const decision = classifyItemTiers({ signals: {}, text, holdUntilJudged: true, subject: subject(n) }, {
      sniffer: new CachedTierSniffer(sniffer, lane), ...config,
    });
    if (options.routed) ledger.recordRoutedPlacement(subject(n), decision, placementFor(decision));
    else ledger.recordDecision(subject(n), decision);
    return sniffer.questionFor(subject(n), 'content')!;
  };
  cleanups.push(() => { sniffer.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ledger, sniffer, filter, add, make, modelDir, placementFor, setCopy: (fn: typeof currentCopy) => { currentCopy = fn; } };
}
function pass(f: ReturnType<typeof fixture>, tier: 'personal' | 'private' = 'personal') {
  let calls = 0;
  const model = { async complete() { calls++; return { text: '', modelId: lane.modelId,
    decisionVerdict: { tier, category: 'fixture', confidence: 1, failSafe: false } }; } };
  return { run: () => runSnifferPass({ targets: [{ ledger: f.ledger, sniffer: f.sniffer, embeddingPrefilter: f.filter,
    ...(f.placementFor ? { placementFor: f.placementFor } : {}) }], lane, model }), calls: () => calls };
}
test('clears below 0.05 with a content-free reason, retains rollback question and never settles Private', async () => {
  const f = fixture(); f.add(1); const p = pass(f);
  await p.run();
  expect(p.calls()).toBe(0);
  expect(f.ledger.getCurrent(subject(1))).toMatchObject({ contentTier: 'private', contentPending: false, state: 'current' });
  expect(f.ledger.getCurrent(subject(1))!.reasons.some(reason => /^content:embedding_prefilter:[0-9a-f-]{36}:0\.\d+$/.test(reason))).toBe(true);
  expect(f.sniffer.questionFor(subject(1), 'content')).toBeDefined();
  const high = fixture({ bias: 5 }); const q = high.add(2);
  await high.filter.prepare(judge);
  expect(high.filter.tryClear(q, judge)).toBe(false);
  expect(high.ledger.getCurrent(subject(2))!.contentPending).toBe(true);
});
test('off without a trained model and easy to disable in engine settings', async () => {
  const f = fixture({ trained: false }); const q = f.add(1);
  await f.filter.prepare(judge);
  expect(f.filter.tryClear(q, judge)).toBe(false);
  expect(f.filter.status()).toContain('2000');
  const off = fixture({ enabled: () => false }); const qo = off.add(2);
  await off.filter.prepare(judge);
  expect(off.filter.tryClear(qo, judge)).toBe(false);
  expect(tierSnifferServiceEnv({ OLYMPUS_EMBEDDING_PREFILTER_ENABLED: 'off' }).embeddingPrefilterEnabled).toBe(false);
});
test('weights and their directory are owner-only on load', () => {
  const f = fixture();
  expect(statSync(f.modelDir).mode & 0o777).toBe(0o700);
  expect(statSync(join(f.modelDir, 'weights.json')).mode & 0o777).toBe(0o600);
});
test('overrides, owner rules, Secrets and open names questions prevent clearance', async () => {
  const f = fixture();
  const override = f.add(1); f.ledger.setOverride(subject(1), { kind: 'tier', tier: 'secure' });
  expect(f.filter.tryClear(override, judge)).toBe(false);
  const rule = f.add(2); const row = f.ledger.getCurrent(subject(2))!;
  f.ledger.recordDecision(subject(2), { ...row, state: 'pending', decidedBy: 'owner_rule', snifferId: judge,
    reasons: [...row.reasons, 'metadata:owner_rule:sender:fixture:prior'] });
  expect(f.filter.tryClear(rule, judge)).toBe(false);
  const names = f.add(3); f.sniffer.enqueue({ subject: subject(3), pass: 'metadata', material: 'fixture', flags: [], mapRevision: 'none' });
  expect(f.filter.tryClear(names, judge)).toBe(false);
  const secret = f.add(4);
  f.setCopy(n => ({ ...copy(n), chunks: [{ ...copy(n).chunks[0]!, boundedText: `Router ${['pass', 'word'].join('')} = syntheticbattery42` }] }));
  expect(f.filter.tryClear(secret, judge)).toBe(false);
  const secretDecision = classifyItemTiers({ signals: {}, text: `Router ${['pass', 'word'].join('')} = syntheticbattery42` }, { sniffer: new CachedTierSniffer(f.sniffer, lane) });
  expect(secretDecision.contentTier).toBe('secrets');
});
test('requires all current own vectors and abstains on media and malformed embeddings', () => {
  const c = copy(1);
  expect(prefilterVector(c)?.length).toBe(D);
  expect(prefilterVector({ ...c, chunks: [...c.chunks, { ...c.chunks[0]!, chunkIndex: 1 }] })).toBeUndefined();
  expect(prefilterVector({ ...c, vectors: [{ ...c.vectors[0]!, contentHash: 'stale' }] })).toBeUndefined();
  expect(prefilterVector({ ...c, chunks: [{ ...c.chunks[0]!, mediaPath: 'fixture.png' }] })).toBeUndefined();
  expect(prefilterVector({ ...c, vectors: [{ ...c.vectors[0]!, embedding: new Uint8Array(4) }] })).toBeUndefined();
});
test('5 percent selection asks the judge directly and survives restart', async () => {
  const f = fixture({ random: () => 0.049 }); const q = f.add(1);
  expect(f.filter.tryClear(q, judge)).toBe(false);
  expect(f.make().isSpotCheck(q)).toBe(true);
  f.sniffer.putVerdict({ materialHash: q.materialHash, modelId: snifferCacheModelId(lane), promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' }, { tier: 'personal', category: 'fixture', confidence: 1, failSafe: false }, q);
  const p = pass(f, 'private'); await p.run();
  expect(p.calls()).toBe(1);
  expect(f.ledger.getCurrent(subject(1))!.contentTier).toBe('secure');
});
test('five Private checks in 200 stop clearing durably and return cleared items to the queue', async () => {
  let sampling = false;
  const f = fixture({ random: () => sampling ? 0 : 1 });
  f.add(1); const p = pass(f); await p.run();
  expect(f.ledger.getCurrent(subject(1))!.contentPending).toBe(false);
  sampling = true;
  for (let i = 0; i < 200; i++) {
    const q = f.add(i + 2); expect(f.filter.tryClear(q, judge)).toBe(false);
    f.filter.observe(q, i < 5);
  }
  expect(f.filter.status()).toContain('stopped');
  expect(f.make().status()).toContain('stopped');
  expect(f.ledger.getCurrent(subject(1))).toMatchObject({ state: 'pending', contentPending: true });
  expect(f.sniffer.questionFor(subject(1), 'content')).toBeDefined();
  expect(f.filter.tryClear(f.add(300), judge)).toBe(false);
});
test('exactly 2 percent is healthy and releases retained audit questions', async () => {
  let sampling = false;
  const f = fixture({ random: () => sampling ? 0 : 1 }); f.add(1); await pass(f).run(); sampling = true;
  for (let i = 0; i < 200; i++) { const q = f.add(i + 2); f.filter.tryClear(q, judge); f.filter.observe(q, i < 4); }
  expect(f.filter.status()).not.toContain('stopped');
  expect(f.sniffer.questionFor(subject(1), 'content')).toBeUndefined();
});
for (const change of ['judge', 'prompt', 'model'] as const) {
  for (const auditFirst of [false, true]) test(`retained clearance preserves a ${change} rejudge${auditFirst ? ' through healthy audit acceptance' : ''}`, async () => {
    let sampling = false;
    const f = fixture({ random: () => sampling ? 0 : 1 });
    const original = f.add(1); await pass(f).run();
    expect(f.filter.retained(original)).toBe(true);
    const nextLane: SnifferLane = { ...lane,
      ...(change === 'judge' ? { modelId: 'replacement-judge' } : {}),
      ...(change === 'model' ? { cacheModelId: 'fixture-weights-v2' } : {}),
    };
    const promptVersion = change === 'prompt' ? 'synthetic-prompt-v2' : SNIFFER_PROMPT_VERSION;
    const nextJudge = snifferId(nextLane, promptVersion);
    expect(nextJudge).not.toBe(judge);
    const decision = classifyItemTiers({ signals: {}, text: ownText, holdUntilJudged: true, subject: subject(1) }, {
      sniffer: new CachedTierSniffer(f.sniffer, nextLane, promptVersion),
    });
    const question = f.sniffer.questionFor(subject(1), 'content')!;
    expect(question.materialHash).toBe(original.materialHash);
    expect(decision.contentPending).toBe(true);
    expect(f.ledger.openRejudgeQuestion(subject(1), {
      expectedGeneration: f.ledger.getCurrent(subject(1))!.generation, decision, keepVisible: false,
    })).toBe(true);
    if (auditFirst) {
      sampling = true;
      for (let i = 0; i < 200; i++) {
        const q = f.add(i + 2); f.filter.tryClear(q, judge); f.filter.observe(q, false);
      }
      expect(f.filter.status()).not.toContain('stopped');
      expect(f.sniffer.questionFor(subject(1), 'content')).toBeDefined();
      expect(f.ledger.rejudgeQuestion(subject(1))).toBeDefined();
      // The synthetic audit questions have already been observed; isolate the rejudge dispatch.
      for (let i = 0; i < 200; i++) f.sniffer.deleteQuestion(subject(i + 2), 'content');
    }
    // Preparing for a replacement judge invalidates weights but keeps existing clearances.
    await f.filter.prepare(nextJudge);
    let calls = 0;
    await runSnifferPass({ targets: [{ ledger: f.ledger, sniffer: f.sniffer, embeddingPrefilter: f.filter,
      placementFor: f.placementFor }], lane: nextLane, promptVersion,
      model: { async complete() { calls++; return { text: '', modelId: nextLane.modelId,
        decisionVerdict: { tier: 'private', category: 'fixture', confidence: 1, failSafe: false } }; } },
    });
    expect(calls).toBe(1);
    expect(f.ledger.getCurrent(subject(1))!.contentTier).toBe('secure');
    expect(f.ledger.rejudgeQuestion(subject(1))).toBeUndefined();
  });
}
test('rollback fences a queued lowering and supersedes its Personal destination', async () => {
  let sampling = false;
  const f = fixture({ routed: true, random: () => sampling ? 0 : 1 }); f.add(1); await pass(f).run();
  const generation = f.ledger.getCurrent(subject(1))!.generation;
  expect(f.ledger.getCurrent(subject(1))!.state).toBe('moving');
  sampling = true;
  for (let i = 0; i < 200; i++) { const q = f.add(i + 2); f.filter.tryClear(q, judge); f.filter.observe(q, i < 5); }
  expect(f.ledger.getCurrent(subject(1))!.generation).toBeGreaterThan(generation);
  expect(f.ledger.getCurrent(subject(1))!.contentPending).toBe(true);
  expect(f.ledger.copies(subject(1)).every(c => c.state !== 'current')).toBe(true);
});
test('daily training uses only own judged synthetic vectors and writes private weights', async () => {
  const f = fixture({ trained: false });
  f.setCopy(n => { const c = copy(n, n % 2 ? 1 : -1); return { ...c, chunks: [{ ...c.chunks[0]!, boundedText: `${ownText} ${n}` }] }; });
  for (let n = 0; n < 4000; n++) {
    const q = f.add(n, {}, `${ownText} ${n}`);
    f.ledger.recordRoutedPlacement(subject(n), { ...f.ledger.getCurrent(subject(n))!, state: 'pending', decidedBy: 'default', snifferId: judge }, f.placementFor({ contentPending: true } as TierDecision));
    const key = { materialHash: q.materialHash, modelId: 'fixture', promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' };
    f.sniffer.putVerdict(key, { tier: n % 2 ? 'private' : 'personal', confidence: 1, category: 'fixture', failSafe: false }, q);
    f.sniffer.markFinalModelContent(key, normalizedContentHash(`${ownText} ${n}`));
    f.ledger.applySnifferVerdict(q, { pass: 'content', tier: n % 2 ? 'secure' : 'private', reason: `content:sniffer:${judge}:fixture`, modelId: 'fixture' }, {
      placementFor: () => ({ copies: [{ corpusId: 'private', trustDomain: 'secure_local', trustTier: 'S4', layers: 'both' }], embedHold: false }),
    });
  }
  await f.filter.prepare(judge);
  expect(f.filter.status()).toContain('is on');
  expect(statSync(f.modelDir).mode & 0o777).toBe(0o700);
  expect(statSync(join(f.modelDir, 'weights.json')).mode & 0o777).toBe(0o600);
  const persisted = readFileSync(join(f.modelDir, 'weights.json'), 'utf8');
  expect(persisted).not.toContain(ownText);
  expect(JSON.parse(persisted).model.weights).toHaveLength(D);
  // An archive withdrawal during the asynchronous training scan cannot republish its old vectors.
  f.ledger.writeMeta('embedding-prefilter:training-revision', 'before-training');
  let withdrawn = false;
  f.setCopy(n => {
    if (!withdrawn) { f.ledger.writeMeta('embedding-prefilter:withdrawal', 'source-withdrawn-during-training'); withdrawn = true; }
    const c = copy(n, n % 2 ? 1 : -1);
    return { ...c, chunks: [{ ...c.chunks[0]!, boundedText: `${ownText} ${n}` }] };
  });
  await f.filter.prepare(judge);
  expect(existsSync(join(f.modelDir, 'weights.json'))).toBe(false);
}, 30_000);
test('the rolling audit is shared across ledgers and stops both clearers', async () => {
  const a = fixture(); const b = fixture({ trained: false });
  const path = join(a.modelDir, 'weights.json');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.revisions = JSON.stringify([[a.ledger.ledgerId(), '0'], [b.ledger.ledgerId(), '0']].sort()) + ':0';
  writeFileSync(path, JSON.stringify(saved));
  let sampling = false;
  const first = new EmbeddingPrefilter({ ledger: a.ledger, sniffer: a.sniffer, copyFor: s => copy(Number(s.providerItemId)), random: () => sampling ? 0 : 1 });
  const second = new EmbeddingPrefilter({ ledger: b.ledger, sniffer: b.sniffer, copyFor: s => copy(Number(s.providerItemId)), sharedWith: first, random: () => sampling ? 0 : 1 });
  await first.prepare(judge);
  expect(first.tryClear(a.add(1), judge)).toBe(true);
  expect(second.tryClear(b.add(1), judge)).toBe(true);
  sampling = true;
  for (let i = 0; i < 200; i++) {
    const filter = i % 2 ? first : second; const q = (i % 2 ? a : b).add(i + 2);
    filter.tryClear(q, judge); filter.observe(q, i < 5);
  }
  expect(first.status()).toContain('stopped'); expect(second.status()).toContain('stopped');
  expect(a.ledger.getCurrent(subject(1))!.contentPending).toBe(true);
  expect(b.ledger.getCurrent(subject(1))!.contentPending).toBe(true);
});

test('a persisted stop recovers clearances before any model preparation', async () => {
  const f = fixture(); f.add(1); await pass(f).run();
  f.ledger.writeMeta('embedding-prefilter:audit', JSON.stringify({ misses: new Array(200).fill(true), stopped: true }));
  const restarted = f.make();
  restarted.recover();
  expect(f.ledger.getCurrent(subject(1))).toMatchObject({ contentPending: true, state: 'pending' });
  expect(f.sniffer.questionFor(subject(1), 'content')).toBeDefined();
});

test('five misses stop immediately without waiting for a complete first window', () => {
  const f = fixture({ random: () => 0 });
  for (let i = 0; i < 4; i++) { const q = f.add(i); f.filter.tryClear(q, judge); f.filter.observe(q, true); }
  expect(f.filter.status()).not.toContain('stopped');
  const fifth = f.add(5); f.filter.tryClear(fifth, judge); f.filter.observe(fifth, true);
  expect(f.filter.status()).toContain('stopped');
});
test('known own and duplicate Private judgments beat a low-vector prediction', async () => {
  for (const duplicate of [false, true]) {
    const f = fixture(); const q = f.add(1);
    const key = { materialHash: duplicate ? 'synthetic-donor' : q.materialHash, modelId: snifferCacheModelId(lane), promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' };
    f.sniffer.putVerdict(key, { tier: 'private', category: 'fixture', confidence: 1, failSafe: false }, duplicate ? subject(999) : q);
    if (duplicate) f.sniffer.markFinalModelContent(key, normalizedContentHash(ownText));
    const p = pass(f); await p.run();
    expect(p.calls()).toBe(0);
    expect(f.ledger.getCurrent(subject(1))!.contentTier).toBe('secure');
    expect(f.ledger.getCurrent(subject(1))!.reasons.some(reason => reason.startsWith('content:embedding_prefilter:'))).toBe(false);
  }
});
test('a cached Private answer awaiting placement is retried and cannot be cleared', async () => {
  const f = fixture({ routed: true }); const q = f.add(1);
  f.sniffer.putVerdict({ materialHash: q.materialHash, modelId: snifferCacheModelId(lane), promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' },
    { tier: 'private', category: 'fixture', confidence: 1, failSafe: false }, q);
  const model = { complete: async () => { throw new Error('must use the known judgment'); } };
  for (let i = 0; i < 2; i++) await runSnifferPass({ lane, model, targets: [{ ledger: f.ledger, sniffer: f.sniffer, embeddingPrefilter: f.filter }] });
  expect(f.ledger.getCurrent(subject(1))!.contentPending).toBe(true);
  expect(f.ledger.getCurrent(subject(1))!.reasons.some(reason => reason.startsWith('content:embedding_prefilter:'))).toBe(false);
});
test('recovery accepts a planner registered after the filter was constructed', async () => {
  const f = fixture({ routed: true }); f.add(1); await pass(f).run();
  f.filter.setPlacementFor(undefined);
  f.ledger.writeMeta('embedding-prefilter:audit', JSON.stringify({ misses: new Array(5).fill(true), stopped: true }));
  const restarted = f.make(); restarted.setPlacementFor(undefined); restarted.recover();
  expect(f.ledger.getCurrent(subject(1))!.contentPending).toBe(false);
  restarted.setPlacementFor(f.placementFor); restarted.recover();
  expect(f.ledger.getCurrent(subject(1))!.contentPending).toBe(true);
});
test('a withdrawn training scope removes stale weights even below the training minimum', async () => {
  const f = fixture();
  f.ledger.writeMeta('embedding-prefilter:training-revision', 'synthetic-withdrawal');
  await f.filter.prepare(judge);
  expect(existsSync(join(f.modelDir, 'weights.json'))).toBe(false);
  expect(f.filter.status()).toContain('2000');
});
test('install audit and selections survive replacing the first source ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefilter-control-'));
  const control = new TierLedger({ dbPath: join(dir, 'install.tier-ledger.sqlite') });
  // This cleanup runs after both source fixtures have finished using the state.
  const a = fixture({ stateLedger: control, random: () => 0 }); const q = a.add(1);
  expect(a.filter.tryClear(q, judge)).toBe(false);
  const b = fixture({ stateLedger: control, trained: false });
  const restoredA = new EmbeddingPrefilter({ ledger: a.ledger, sniffer: a.sniffer, stateLedger: control,
    sharedWith: b.filter, copyFor: s => copy(Number(s.providerItemId)) });
  expect(restoredA.isSpotCheck(q)).toBe(true);
  control.writeMeta('embedding-prefilter:audit', JSON.stringify({ misses: new Array(5).fill(true), stopped: true }));
  const afterSourceChange = b.make(); await afterSourceChange.prepare(judge);
  expect(afterSourceChange.status()).toContain('stopped');
  cleanups.push(() => { control.close(); rmSync(dir, { recursive: true, force: true }); });
});

// A full-question cache key can precede the donor's final-content receipt.
test('unfinalized donor and fail-safe Private cache cannot fall through into vector clearing', async () => {
  for (const failSafe of [false, true]) {
    const f = fixture({ routed: true }); const q = f.add(1);
    f.sniffer.putVerdict({ materialHash: q.materialHash, modelId: snifferCacheModelId(lane), promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' },
      { tier: 'private', category: 'fixture', confidence: failSafe ? 0 : 1, failSafe }, failSafe ? q : subject(999));
    const model = { complete: async () => { throw new Error('must not ask or clear'); } };
    for (let i = 0; i < 2; i++) await runSnifferPass({ lane, model, targets: [{ ledger: f.ledger, sniffer: f.sniffer, embeddingPrefilter: f.filter }] });
    expect(f.ledger.getCurrent(subject(1))!.contentPending).toBe(true);
    expect(f.ledger.getCurrent(subject(1))!.reasons.some(r => r.startsWith('content:embedding_prefilter:'))).toBe(false);
  }
});
test('selected cached and duplicate Private judgments count misses and physically retire selection', async () => {
  for (const duplicate of [false, true]) {
    const f = fixture({ random: () => 0 });
    f.setCopy(n => ({ ...copy(n), chunks: [{ ...copy(n).chunks[0]!, boundedText: `${ownText} ${n}` }] }));
    for (let n = 0; n < 5; n++) {
      const q = f.add(n, {}, `${ownText} ${n}`); f.filter.tryClear(q, judge);
      const key = { materialHash: duplicate ? 'synthetic-donor' : q.materialHash, modelId: snifferCacheModelId(lane), promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' };
      f.sniffer.putVerdict(key, { tier: 'private', category: 'fixture', confidence: 1, failSafe: false }, subject(999));
      if (duplicate) f.sniffer.markFinalModelContent(key, normalizedContentHash(`${ownText} ${n}`));
      await pass(f).run();
      expect(f.filter.isSpotCheck(q)).toBe(false);
      expect(f.ledger.metaEntries('embedding-prefilter:check:')).toHaveLength(0);
    }
    expect(f.filter.status()).toContain('stopped');
  }
});
test('scope withdrawal removes source-owned sample identities and leaves only aggregate install audit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefilter-audit-'));
  const control = new TierLedger({ dbPath: join(dir, 'audit.sqlite') });
  const f = fixture({ stateLedger: control, random: () => 0 }); const q = f.add(1);
  f.filter.tryClear(q, judge);
  expect(f.ledger.metaEntries('embedding-prefilter:check:')).toHaveLength(1);
  expect(control.metaEntries('embedding-prefilter:check:')).toHaveLength(0);
  control.writeMeta('embedding-prefilter:audit', JSON.stringify({ misses: [true], stopped: false }));
  f.ledger.withdrawAccountScope('fixture', 'fixture');
  expect(f.ledger.metaEntries('embedding-prefilter:check:')).toHaveLength(0);
  expect(control.readMeta('embedding-prefilter:audit')).toContain('true');
  cleanups.push(() => { control.close(); rmSync(dir, { recursive: true, force: true }); });
});

test('a crash between audit commit and selection deletion counts the same check only once', () => {
  const f = fixture({ random: () => 0 }); const q = f.add(1); f.filter.tryClear(q, judge);
  const remove = f.ledger.deleteMeta.bind(f.ledger);
  f.ledger.deleteMeta = () => { throw new Error('synthetic crash'); };
  expect(() => f.filter.observe(q, true)).toThrow('synthetic crash');
  f.ledger.deleteMeta = remove;
  f.make().observe(q, true);
  expect(JSON.parse(f.ledger.readMeta('embedding-prefilter:audit')!).misses).toEqual([true]);
  expect(f.ledger.metaEntries('embedding-prefilter:check:')).toHaveLength(0);
  expect(f.ledger.metaEntries('embedding-prefilter:observed:')).toHaveLength(0);
});
test('audit rollback returns a Personal-first candidate to held judgment', () => {
  const f = fixture(); const q = f.add(1); const row = f.ledger.getCurrent(q)!;
  f.ledger.recordDecision(q, { ...row, state: 'pending', decidedBy: 'default', snifferId: judge,
    reasons: [...row.reasons.filter(r => r !== 'content:held_until_judged'), 'content:personal_first'] });
  expect(f.filter.tryClear(q, judge)).toBe(true);
  f.ledger.writeMeta('embedding-prefilter:audit', JSON.stringify({ misses: [true,true,true,true,true], stopped: true }));
  f.make().recover();
  expect(f.ledger.getCurrent(q)!.contentPending).toBe(true);
  expect(f.ledger.getCurrent(q)!.reasons).toContain('content:held_until_judged');
  expect(f.ledger.getCurrent(q)!.reasons).not.toContain('content:personal_first');
});
