// All labels, vectors, text and weights in this file are synthetic fixtures.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EmbeddingPrefilter, embeddingPrefilterDirectory, prefilterVector, prefilterTrainingExample, PREFILTER_TRAINING_REJECTIONS } from '../src/workers/classification/embedding-prefilter.ts';
import { EMBEDDING_PREFILTER_MODEL_ID as MODEL, EMBEDDING_PREFILTER_DIMENSIONS as D } from '../src/workers/classification/embedding-logistic.ts';
import { TierLedger, type TierPlacementPlan } from '../src/workers/classification/tier-ledger.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { CachedTierSniffer, SNIFFER_PROMPT_VERSION, snifferId, snifferCacheModelId } from '../src/workers/classification/sniffer.ts';
import { withRecordedContent } from '../src/workers/connector-store/tiered-store-set.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import * as resolver from '../src/workers/classification/sniffer-resolver.ts';
import { classifyItemTiers, contentDigestReason, contentJudgeVerdictReason, normalizedContentHash, type TierDecision } from '../src/workers/classification/tier-classifier.ts';
import { TierSnifferService, tierSnifferServiceEnv } from '../src/workers/classification/sniffer-service.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { appendClassificationLedgerEntry } from '../src/workers/classification-ledger.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import type { ConnectorStoreItemCopy } from '../src/workers/connector-store/local-index.ts';
const lane: SnifferLane = { kind: 'local', modelId: 'fixture', profileId: 'fixture', profile: {
  provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture',
} };
const judge = snifferId(lane);
const cleanups: Array<() => void> = [];
// A test that outlives its time limit keeps running after Bun moves on. Its
// stores are closed only once that body has settled, never under a running
// preparation (#992).
let running: Promise<unknown> | undefined;
function settled<A extends unknown[]>(body: (...args: A) => Promise<void>) {
  return (...args: A) => { const result = body(...args); running = result; return result; };
}
afterEach(async () => {
  const body = running;
  running = undefined;
  await body?.catch(() => {});
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const subject = (n: number) => ({ provider: 'fixture', accountScope: 'fixture', providerItemId: String(n) });
const ownText = 'Please bring the picnic basket and the sandwiches on Sunday.';
function copy(n: number, sign = 1): ConnectorStoreItemCopy {
  const vector = new Float32Array(D); vector[0] = sign;
  return { identity: { ...subject(n), family: 'file', localItemId: String(n) }, columns: {} as ConnectorStoreItemCopy['columns'],
    trustTier: 'S4', owners: [], chunks: [{ chunkIndex: 0, boundedText: ownText, contentHash: 'fixture', embeddingInputHash: 'fixture' }],
    vectors: [{ chunkIndex: 0, modelId: MODEL, contentHash: 'fixture', embedding: new Uint8Array(vector.buffer) }], vectorAuthorities: [] };
}
function fixture(options: { trained?: boolean; memory?: boolean; bias?: number; random?: () => number; enabled?: () => boolean; routed?: boolean; stateLedger?: TierLedger; now?: () => number; snifferNow?: () => Date; monotonicNow?: () => number; log?: (line: string) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prefilter-synthetic-'));
  const ledger = new TierLedger({ dbPath: options.memory ? ':memory:' : join(dir, 'tiers.sqlite') });
  const sniffer = new TierSnifferStore({ dbPath: options.memory ? ':memory:' : join(dir, 'sniffer.sqlite'), ...(options.snifferNow ? { now: options.snifferNow } : {}) });
  const modelDir = embeddingPrefilterDirectory(options.stateLedger?.dbPath ?? ledger.dbPath);
  if (options.trained !== false) {
    mkdirSync(modelDir, { mode: 0o755 });
    writeFileSync(join(modelDir, 'weights.json'), JSON.stringify({ version: '00000000-0000-0000-0000-000000000939',
      trainedAt: Date.now(), judge, revisions: JSON.stringify([[ledger.ledgerId(), '0']]) + ':0', model: { weights: new Array(D).fill(0), bias: options.bias ?? -7 } }), { mode: 0o644 });
  }
  const placementFor = (decision: TierDecision): TierPlacementPlan => ({
    copies: [{ corpusId: decision.contentPending ? 'private' : 'personal', trustDomain: decision.contentPending ? 'secure_local' : 'internal',
      layers: 'both' }], embedHold: decision.contentPending,
  });
  let currentCopy: (n: number) => ConnectorStoreItemCopy | undefined = n => copy(n);
  let copyRevision = 0;
  const make = () => new EmbeddingPrefilter({ ledger, sniffer, ...(options.stateLedger ? { stateLedger: options.stateLedger } : {}), copyFor: identity => currentCopy(Number(identity.providerItemId)), copyChangeMarker: () => String(copyRevision),
    ...(options.routed ? { placementFor } : {}), random: options.random ?? (() => 1), ...(options.now ? { now: options.now } : {}), ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : {}), ...(options.log ? { log: options.log } : {}), ...(options.enabled ? { enabled: options.enabled } : {}) });
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
  return { ledger, stateLedger: options.stateLedger ?? ledger, sniffer, filter, add, make, modelDir, placementFor, setCopy: (fn: typeof currentCopy) => { currentCopy = fn; copyRevision++; } };
}
function pass(f: ReturnType<typeof fixture>, tier: 'personal' | 'private' = 'personal') {
  let calls = 0;
  const model = { async complete() { calls++; return { text: '', modelId: lane.modelId,
    decisionVerdict: { tier, category: 'fixture', confidence: 1, failSafe: false } }; } };
  return { run: () => runSnifferPass({ targets: [{ ledger: f.ledger, sniffer: f.sniffer, embeddingPrefilter: f.filter,
    ...(f.placementFor ? { placementFor: f.placementFor } : {}) }], lane, model }), calls: () => calls };
}
// Counts are opt-in: the boolean and held/cleared decisions stay compatible.
const clearingCounts = () => ({ tried: 0, cleared: 0, spotChecks: 0, skipped: {} as Record<string, number> });
test('clearing counts one first skip per attempt without changing held decisions', () => {
  const rowCases = [
    ['row_missing', undefined], ['row_not_pending', { state: 'current' }],
    ['metadata_pending', { metadataPending: true }], ['content_not_pending', { contentPending: false }],
    ['content_unread', { contentRead: false }], ['metadata_tier', { metadataTier: 'secure' }],
    ['content_tier', { contentTier: 'secure' }], ['metadata_forced', { metadataForced: true }],
    ['override_decision', { decidedBy: 'override' }], ['owner_decision', { decidedBy: 'owner_rule' }],
    ['metadata_owner_rule', { reasons: ['metadata:owner_rule:synthetic'] }],
  ] as const;
  for (const [reason, change] of rowCases) {
    const f = fixture(); const q = f.add(1); const before = f.ledger.getCurrent(q)!;
    const read = spyOn(f.ledger, 'getCurrent').mockReturnValue(change ? { ...before, ...change } as typeof before : undefined);
    const counts = clearingCounts();
    try {
      expect(f.filter.tryClear(q, judge, counts)).toBe(false);
      expect(f.filter.tryClear(q, judge)).toBe(false);
      expect(counts).toEqual({ tried: 1, cleared: 0, spotChecks: 0, skipped: { [reason]: 1 } });
    } finally { read.mockRestore(); }
    expect(f.ledger.getCurrent(q)).toEqual(before);
  }
  for (const reason of ['disabled', 'audit_stopped', 'model_missing', 'model_invalid', 'weights_missing',
    'revisions_changed', 'judge_changed', 'not_content', 'item_override', 'rejudge_open', 'metadata_question_open',
    'copy_missing', 'digest_missing', 'no_vector', 'score_unavailable', 'probability_high', 'clear_rejected'] as const) {
    const f = fixture({ enabled: () => reason !== 'disabled', bias: reason === 'probability_high' ? 5 : -7 });
    const q = f.add(1); const before = f.ledger.getCurrent(q)!;
    let filter = f.filter;
    const path = join(f.modelDir, 'weights.json');
    if (reason === 'model_missing') { rmSync(path); filter = f.make(); }
    if (['model_invalid', 'revisions_changed', 'judge_changed', 'score_unavailable'].includes(reason)) {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (reason === 'model_invalid') saved.version = 'invalid';
      if (reason === 'score_unavailable') saved.model.weights = [];
      if (reason === 'revisions_changed') saved.revisions = 'changed';
      if (reason === 'judge_changed') saved.judge = 'changed';
      writeFileSync(path, JSON.stringify(saved)); filter = f.make();
    }
    if (reason === 'weights_missing') rmSync(path);
    if (reason === 'audit_stopped') { f.ledger.writeMeta('embedding-prefilter:audit', JSON.stringify({ misses: [], stopped: true })); filter = f.make(); }
    if (reason === 'not_content') q.pass = 'metadata';
    const spies: Array<{ mockRestore(): void }> = [];
    if (reason === 'item_override') spies.push(spyOn(f.ledger, 'getOverride').mockReturnValue({ kind: 'tier', tier: 'secure' } as ReturnType<TierLedger['getOverride']>));
    if (reason === 'rejudge_open') spies.push(spyOn(f.ledger, 'rejudgeQuestion').mockReturnValue({} as NonNullable<ReturnType<TierLedger['rejudgeQuestion']>>));
    if (reason === 'metadata_question_open') f.sniffer.enqueue({ subject: q, pass: 'metadata', material: 'synthetic', flags: [], mapRevision: 'none' });
    if (reason === 'copy_missing') f.setCopy(() => undefined);
    if (reason === 'digest_missing') f.setCopy(n => ({ ...copy(n), chunks: [{ ...copy(n).chunks[0]!, boundedText: 'changed' }] }));
    if (reason === 'no_vector') f.setCopy(n => ({ ...copy(n), vectors: [] }));
    if (reason === 'clear_rejected') spies.push(spyOn(f.ledger, 'clearEmbeddingQuestion').mockReturnValue(false));
    const counts = clearingCounts();
    try {
      expect(filter.tryClear(q, judge, counts)).toBe(false);
      expect(filter.tryClear(q, judge)).toBe(false);
      expect(counts).toEqual({ tried: 1, cleared: 0, spotChecks: 0, skipped: { [reason]: 1 } });
      expect(f.ledger.getCurrent(q)).toEqual(before);
    } finally { for (const spy of spies) spy.mockRestore(); }
  }
});
test('clearing counts only the first guard when multiple guards fail', () => {
  const f = fixture({ enabled: () => false, trained: false }); const q = f.add(1);
  q.pass = 'metadata'; const counts = clearingCounts();
  expect(f.filter.tryClear(q, 'different-judge', counts)).toBe(false);
  expect(counts).toEqual({ tried: 1, cleared: 0, spotChecks: 0, skipped: { disabled: 1 } });
});
test('clearing counts cleared and sampled or existing spot checks exactly once', async () => {
  const f = fixture(); const q = f.add(1); const counts = clearingCounts();
  expect(f.filter.tryClear(q, judge, counts)).toBe(true);
  expect(counts).toEqual({ tried: 1, cleared: 1, spotChecks: 0, skipped: {} });
  expect(f.ledger.getCurrent(q)).toMatchObject({ state: 'current', contentPending: false });
  const uncounted = fixture(); const same = uncounted.add(1);
  expect(uncounted.filter.tryClear(same, judge)).toBe(true);
  expect(uncounted.ledger.getCurrent(same)!.contentPending).toBe(f.ledger.getCurrent(q)!.contentPending);
  const sampled = fixture({ random: () => 0 }); const check = sampled.add(2); const checks = clearingCounts();
  expect(sampled.filter.tryClear(check, judge, checks)).toBe(false);
  expect(sampled.filter.tryClear(check, judge, checks)).toBe(false);
  expect(checks).toEqual({ tried: 2, cleared: 0, spotChecks: 2, skipped: {} });
  expect(sampled.ledger.getCurrent(check)).toMatchObject({ state: 'pending', contentPending: true });
  const held = fixture({ bias: 5 }); held.add(3);
  expect((await pass(held).run()).clearing).toEqual({ tried: 1, cleared: 0, spotChecks: 0, skipped: { probability_high: 1 } });
  const clear = fixture(); clear.add(4);
  expect((await pass(clear).run()).clearing).toEqual({ tried: 1, cleared: 1, spotChecks: 0, skipped: {} });
  expect((await pass(clear).run()).clearing).toEqual(clearingCounts());
});
test('clears below the 0.002 cutoff with a content-free reason, retains rollback question and never settles Private', async () => {
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
test('clearing and spot-check selection share the probability cutoff, with independent 1-in-20 sampling', () => {
  for (const p of [0.0019, 0.0021]) for (const random of [0, 0.049, 0.05]) {
    const f = fixture({ bias: Math.log(p / (1 - p)), random: () => random });
    const q = f.add(1);
    const eligible = p < 0.002, sampled = random < 1 / 20;
    expect(f.filter.tryClear(q, judge)).toBe(eligible && !sampled);
    expect(f.filter.isSpotCheck(q)).toBe(eligible && sampled);
    expect(f.ledger.getCurrent(q)!.contentPending).toBe(!eligible || sampled);
  }
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
    expect(f.filter.retained(question)).toBe(false);
    expect(f.ledger.metaEntries('embedding-prefilter:clear:')).toHaveLength(0);
  });
}
for (const recovery of ['disable', 'failed audit'] as const) {
  for (const healthyAudit of [false, true]) test(`failed rejudge keeps rollback available for ${recovery}${healthyAudit ? ' after a healthy audit' : ''}`, async () => {
    let enabled = true;
    let sampling = false;
    const f = fixture({ enabled: () => enabled, random: () => sampling ? 0 : 1 });
    const original = f.add(1); await pass(f).run();
    // Select checks before replacement-judge preparation invalidates the old weights.
    sampling = true;
    const checks = Array.from({ length: (healthyAudit ? 200 : 0) + (recovery === 'failed audit' ? 5 : 0) }, (_, i) => {
      const q = f.add(i + 2);
      expect(f.filter.tryClear(q, judge)).toBe(false);
      expect(f.filter.isSpotCheck(q)).toBe(true);
      f.sniffer.deleteQuestion(q, 'content');
      return q;
    });
    const nextLane: SnifferLane = { ...lane, modelId: 'replacement-judge' };
    const decision = classifyItemTiers({ signals: {}, text: ownText, holdUntilJudged: true, subject: subject(1) }, {
      sniffer: new CachedTierSniffer(f.sniffer, nextLane),
    });
    expect(f.sniffer.questionFor(subject(1), 'content')!.materialHash).toBe(original.materialHash);
    expect(f.ledger.openRejudgeQuestion(subject(1), {
      expectedGeneration: f.ledger.getCurrent(subject(1))!.generation, decision, keepVisible: false,
    })).toBe(true);
    const report = await runSnifferPass({ targets: [{ ledger: f.ledger, sniffer: f.sniffer, embeddingPrefilter: f.filter }],
      lane: nextLane, model: { async complete() { throw new Error('synthetic judge unavailable'); } },
    });
    expect(report.failedCalls).toBe(1);
    expect(f.ledger.getCurrent(subject(1))).toMatchObject({ state: 'current', contentPending: false });
    expect(f.ledger.rejudgeQuestion(subject(1))).toBeDefined();
    if (healthyAudit) {
      for (const q of checks.slice(0, 200)) f.filter.observe(q, false);
      expect(f.filter.status()).not.toContain('stopped');
      expect(f.sniffer.questionFor(subject(1), 'content')).toBeDefined();
    }
    if (recovery === 'disable') enabled = false;
    else {
      for (const q of checks.slice(-5)) f.filter.observe(q, true);
      expect(f.filter.status()).toContain('stopped');
    }
    f.make().recover();
    expect(f.ledger.getCurrent(subject(1))).toMatchObject({ state: 'pending', contentPending: true });
    expect(f.ledger.getCurrent(subject(1))!.reasons.some(reason => reason.startsWith('content:embedding_prefilter:'))).toBe(false);
    expect(f.sniffer.questionFor(subject(1), 'content')).toBeDefined();
    // Once available, the replacement judge still decides the queued item.
    const resolved = await runSnifferPass({ targets: [{ ledger: f.ledger, sniffer: f.sniffer, embeddingPrefilter: f.filter }],
      lane: nextLane, maxCallsPerPass: 1, model: { async complete() { return { text: '', modelId: nextLane.modelId,
        decisionVerdict: { tier: 'private', category: 'fixture', confidence: 1, failSafe: false } }; } },
    });
    expect(resolved.resolvedPrivate).toBe(1);
    expect(f.ledger.getCurrent(subject(1))).toMatchObject({ state: 'current', contentPending: false, contentTier: 'secure' });
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
test('sliced training uses judge ledger labels without content hashes and writes private weights', async () => {
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'prefilter-fitting-'));
  const control = new TierLedger({ dbPath: join(dir, 'control.sqlite') });
  const f = fixture({ trained: false, memory: true, stateLedger: control, log: line => logs.push(line) });
  cleanups.push(() => { control.close(); rmSync(dir, { recursive: true, force: true }); });
  f.setCopy(n => { const c = copy(n, n % 2 ? 1 : -1); return { ...c, chunks: [{ ...c.chunks[0]!, boundedText: `${ownText} ${n}` }] }; });
  for (let n = 0; n < 4000; n++) {
    const q = f.add(n, {}, `${ownText} ${n}`);
    f.ledger.recordRoutedPlacement(subject(n), { ...f.ledger.getCurrent(subject(n))!, state: 'pending', decidedBy: 'default', snifferId: judge }, f.placementFor({ contentPending: true } as TierDecision));
    const key = { materialHash: q.materialHash, modelId: 'fixture', promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' };
    f.sniffer.putVerdict(key, { tier: n % 2 ? 'private' : 'personal', confidence: 1, category: 'fixture', failSafe: false }, q);
    f.ledger.applySnifferVerdict(q, { pass: 'content', tier: n % 2 ? 'secure' : 'private', reason: `content:sniffer:${judge}:fixture`, modelId: 'fixture' }, {
      placementFor: () => ({ copies: [{ corpusId: 'private', trustDomain: 'secure_local', trustTier: 'S4', layers: 'both' }], embedHold: false }),
    });
  }
  let checkpointWrites = 0;
  const writeMeta = f.ledger.writeMeta.bind(f.ledger);
  f.ledger.writeMeta = (key, value) => { if (key === 'embedding-prefilter:training-scan-v1') checkpointWrites++; writeMeta(key, value); };
  let fittingWrites: number | undefined;
  const trainingStarted = performance.now();
  for (let tick = 0; tick < 200 && !existsSync(join(f.modelDir, 'weights.json')); tick++) {
    await f.filter.prepare(judge);
    if (fittingWrites !== undefined) expect(checkpointWrites).toBe(fittingWrites);
    if (trainingState(f).outcome === 'fitting') fittingWrites = checkpointWrites;
  }
  expect(fittingWrites).toBeDefined();
  console.info(`[embedding-prefilter synthetic] rows=4000 personal=2000 private=2000 wall_ms=${Math.round(performance.now() - trainingStarted)} active_ms=${Math.round(trainingState(f).elapsedMs)}`);
  expect(f.filter.status()).toContain('is on');
  expect(statSync(f.modelDir).mode & 0o777).toBe(0o700);
  expect(statSync(join(f.modelDir, 'weights.json')).mode & 0o777).toBe(0o600);
  const persisted = readFileSync(join(f.modelDir, 'weights.json'), 'utf8');
  expect(persisted).not.toContain(ownText);
  expect(JSON.parse(persisted).model.weights).toHaveLength(D);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('rows_read=4000 personal=2000 private=2000 outcome=trained');
  expect(logs[0]).toContain(`model_version=${JSON.parse(persisted).version}`);
  expect(logs[0]).toMatch(/elapsed_ms=\d+ next_attempt=/);
  expect(logs.join('')).not.toContain(ownText);
  // An archive withdrawal during the asynchronous training scan cannot republish its old vectors.
  f.ledger.writeMeta('embedding-prefilter:training-revision', 'before-training');
  let withdrawn = false;
  f.setCopy(n => {
    if (!withdrawn) { f.stateLedger.writeMeta('embedding-prefilter:withdrawal', 'source-withdrawn-during-training'); withdrawn = true; }
    const c = copy(n, n % 2 ? 1 : -1);
    return { ...c, chunks: [{ ...c.chunks[0]!, boundedText: `${ownText} ${n}` }] };
  });
  await f.filter.prepare(judge);
  expect(existsSync(join(f.modelDir, 'weights.json'))).toBe(false);
  f.setCopy(n => { const c = copy(n, n % 2 ? 1 : -1); return { ...c, chunks: [{ ...c.chunks[0]!, boundedText: `${ownText} ${n}` }] }; });
  let interruptedFinalStep = false;
  for (let tick = 0; tick < 200 && !interruptedFinalStep; tick++) {
    await f.filter.prepare(judge);
    // Fault-inject withdrawal exactly when the iterator returns its completed fit.
    const runtime = (f.filter as unknown as { training?: { fit?: Generator<void, unknown> } }).training;
    if (runtime?.fit) {
      const fit = runtime.fit;
      const next = fit.next.bind(fit);
      fit.next = () => {
        const step = next();
        if (step.done) { f.stateLedger.writeMeta('embedding-prefilter:withdrawal', 'synthetic-final-fit-withdrawal'); interruptedFinalStep = true; }
        return step;
      };
      for (let fitTick = 0; fitTick < 200 && !interruptedFinalStep; fitTick++) await f.filter.prepare(judge);
    }
  }
  expect(interruptedFinalStep).toBe(true);
  expect(existsSync(join(f.modelDir, 'weights.json'))).toBe(false);
  expect(trainingState(f)).toMatchObject({ outcome: 'failed', reason: 'ledger_or_judge_changed' });
  expect(trainingState(f).nextAt).toBeLessThanOrEqual(Date.now());
  expect(logs.at(-1)).toContain('reason=ledger_or_judge_changed');
}, 30_000);
test('the rolling audit is shared across ledgers and stops both clearers', async () => {
  const a = fixture(); const b = fixture({ trained: false });
  const path = join(a.modelDir, 'weights.json');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.revisions = JSON.stringify([[a.ledger.ledgerId(), '0'], [b.ledger.ledgerId(), '0']].sort()) + ':0';
  writeFileSync(path, JSON.stringify(saved));
  let sampling = false;
  const first = new EmbeddingPrefilter({ ledger: a.ledger, sniffer: a.sniffer, copyFor: s => copy(Number(s.providerItemId)), copyChangeMarker: () => '0', random: () => sampling ? 0 : 1 });
  const second = new EmbeddingPrefilter({ ledger: b.ledger, sniffer: b.sniffer, copyFor: s => copy(Number(s.providerItemId)), copyChangeMarker: () => '0', sharedWith: first, random: () => sampling ? 0 : 1 });
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
    sharedWith: b.filter, copyFor: s => copy(Number(s.providerItemId)), copyChangeMarker: () => '0' });
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

// These fixtures deliberately retain a real judge reason alongside competing reasons.
// A competing reason must exclude the row even when it also has a cached content hash.
function trainingRow(f: ReturnType<typeof fixture>, n: number, extra: string[] = [], code = 'other:1.00', hashed = false) {
  f.add(n, { sniffer: { id: judge, judge: () => ({ verdict: 'undecided' }) } });
  const q = { ...subject(n), materialHash: `synthetic-material-${n}` };
  const row = f.ledger.getCurrent(subject(n))!;
  f.ledger.recordRoutedPlacement(subject(n), { ...row, state: 'pending', decidedBy: 'default', snifferId: judge,
    reasons: [...row.reasons, ...extra] }, f.placementFor({ contentPending: true } as TierDecision));
  const key = { materialHash: `${q.materialHash}-${n}`, modelId: 'fixture', promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' };
  f.sniffer.putVerdict(key, { tier: n % 2 ? 'private' : 'personal', confidence: 1, category: 'fixture', failSafe: false }, q);
  if (hashed) f.sniffer.markFinalModelContent(key, normalizedContentHash(ownText));
  f.ledger.applySnifferVerdict(q, { pass: 'content', tier: n % 2 ? 'secure' : 'private', reason: `content:sniffer:${judge}:${code}`, modelId: 'fixture' }, {
    placementFor: () => ({ copies: [{ corpusId: 'private', trustDomain: 'secure_local', trustTier: 'S4', layers: 'both' }], embedHold: false }),
  });
}
// Seed many rows in one transaction per store. Per-row commits to a
// disk-backed ledger and sniffer store cost seconds of fsync under parallel CI
// and ate the test's own time budget (#992). TierSnifferStore has no batch
// API, so the fixture opens the transaction on its connection directly.
function trainingRows(f: ReturnType<typeof fixture>, count: number, row: (n: number) => void = n => trainingRow(f, n)) {
  const sniffer = (f.sniffer as unknown as { db: { transaction<T>(work: () => T): () => T } }).db;
  sniffer.transaction(() => f.ledger.withMoveBatch(() => { for (let n = 0; n < count; n++) row(n); }))();
}
function trainingState(f: ReturnType<typeof fixture>) {
  return JSON.parse(f.stateLedger.readMeta('embedding-prefilter:training-v1')!);
}
test('only judge-only ledger labels qualify; competing tiers, record holds and stale digests never label', async () => {
  const logs: string[] = [];
  const f = fixture({ trained: false, log: line => logs.push(line) });
  trainingRow(f, 0); trainingRow(f, 1);
  const competing = ['content:detector:financial:iban', 'content:rule:fixture', 'content:secret:fixture',
    'metadata:owner_rule:sender:fixture:prior', 'metadata:floor:fixture', 'override:tier:secure',
    'content:own_record:health', 'content:embedding_prefilter:fixture:0.01', 'content:unknown:raise'];
  competing.forEach((reason, index) => trainingRow(f, index + 2, [reason], 'other:1.00', true));
  trainingRow(f, 20, [], 'record_held:other:1.00', true);
  trainingRow(f, 21, [], 'rule:duplicate_model:other:1.00', true);
  trainingRow(f, 22, [], 'unresolved:0.00', true);
  trainingRow(f, 23, [], 'injection:fixture:0.00', true);
  trainingRow(f, 24); f.ledger.setOverride(subject(24), { kind: 'tier', tier: 'secure' });
  trainingRow(f, 25);
  f.setCopy(n => n === 25 ? { ...copy(n), chunks: [{ ...copy(n).chunks[0]!, boundedText: 'Changed synthetic text' }] } : copy(n));
  for (let tick = 0; tick < 100 && !logs.length; tick++) await f.filter.prepare(judge);
  expect(trainingState(f)).toMatchObject({ outcome: 'too_few', rows: 17, counts: [1, 1] });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('personal=1 private=1 outcome=too_few');
  expect(existsSync(join(f.modelDir, 'weights.json'))).toBe(false);
});
test('worker samples a queued lowering by the final Personal target instead of its old Private placement', async () => {
  const f = fixture({ trained: false, memory: true, log: () => {} });
  trainingRow(f, 0);
  const settled = f.ledger.getCurrent(subject(0))!;
  // Reproduce placement waiting at Private with the already-final Personal reasons.
  f.ledger.recordRoutedPlacement(subject(0), { ...settled, state: 'current', contentTier: 'secure',
    decidedBy: 'sniffer', snifferId: judge }, f.placementFor({ contentPending: true } as TierDecision));
  f.ledger.beginMove(subject(0), { metadataTier: 'private', contentTier: 'private' }, f.ledger.getCurrent(subject(0))!.generation);
  expect(f.ledger.getCurrent(subject(0))).toMatchObject({ state: 'moving', contentTier: 'secure', contentPending: false });
  await f.filter.prepare(judge);
  expect(trainingState(f)).toMatchObject({ outcome: 'too_few', counts: [1, 0] });
});
test('scan stops at its 200 ms deadline and resumes its durable cursor after restart', async () => {
  let monotonic = 0;
  const logs: string[] = [];
  const f = fixture({ trained: false, monotonicNow: () => monotonic, log: line => logs.push(line) });
  for (let n = 0; n < 9; n++) trainingRow(f, n);
  const seen: number[] = [];
  f.setCopy(n => { seen.push(n); monotonic += 50; return copy(n); });
  await f.filter.prepare(judge);
  expect(monotonic).toBe(200);
  expect(seen).toEqual([0, 1, 2, 3]);
  expect(trainingState(f)).toMatchObject({ outcome: 'scanning', rows: 4, counts: [2, 2] });
  expect(logs).toHaveLength(0);
  expect(f.filter.status()).toContain('continue next tick');
  const restarted = f.make();
  await restarted.prepare(judge);
  expect(monotonic).toBe(400);
  expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  await restarted.prepare(judge);
  expect(trainingState(f)).toMatchObject({ outcome: 'too_few', rows: 9, counts: [5, 4] });
  expect(logs).toHaveLength(1);
  expect(restarted.status()).toContain('read 9 rows, 5 Personal and 4 Private');
});
test('too few waits for 1000 new verdicts or 24 hours across restarts', async () => {
  let now = Date.UTC(2026, 10, 7);
  const logs: string[] = [];
  const f = fixture({ trained: false, now: () => now, log: line => logs.push(line) });
  trainingRow(f, 0); trainingRow(f, 1);
  await f.filter.prepare(judge);
  expect(trainingState(f).nextAt).toBe(now + 24 * 60 * 60 * 1000);
  const restarted = f.make();
  const addVerdicts = (from: number, to: number) => {
    for (let n = from; n < to; n++) f.sniffer.putVerdict({ materialHash: `synthetic-${n}`, modelId: 'fixture', promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' },
      { tier: 'personal', confidence: 1, category: 'fixture', failSafe: false });
  };
  addVerdicts(0, 999);
  await restarted.prepare(judge);
  expect(logs).toHaveLength(1);
  addVerdicts(999, 1000);
  await restarted.prepare(judge);
  expect(logs).toHaveLength(2);
  now += 24 * 60 * 60 * 1000 - 1;
  await restarted.prepare(judge);
  expect(logs).toHaveLength(2);
  now++;
  await restarted.prepare(judge);
  expect(logs).toHaveLength(3);
});
test('failed scans log no error material and retry after three hours, not a day', async () => {
  let now = Date.UTC(2026, 10, 7);
  const logs: string[] = [];
  const f = fixture({ trained: false, now: () => now, log: line => logs.push(line) });
  trainingRow(f, 0); trainingRow(f, 1);
  f.setCopy(() => { throw new Error(ownText); });
  await f.filter.prepare(judge);
  expect(trainingState(f)).toMatchObject({ outcome: 'failed', reason: 'scan_failed', nextAt: now + 3 * 60 * 60 * 1000 });
  expect(logs[0]).toContain('outcome=failed reason=scan_failed');
  expect(logs.join('')).not.toContain(ownText);
  const restarted = f.make();
  await restarted.prepare(judge);
  expect(logs).toHaveLength(1);
  f.setCopy(n => copy(n));
  now += 3 * 60 * 60 * 1000;
  await restarted.prepare(judge);
  expect(trainingState(f).outcome).toBe('too_few');
  expect(logs).toHaveLength(2);
});
test('withdrawal deletes partial references and restarts without withdrawn labels', async () => {
  let monotonic = 0;
  const logs: string[] = [];
  const now = Date.UTC(2026, 10, 7);
  const f = fixture({ trained: false, now: () => now, monotonicNow: () => monotonic, log: line => logs.push(line) });
  for (let n = 0; n < 9; n++) trainingRow(f, n);
  f.setCopy(n => { monotonic += 50; return copy(n); });
  await f.filter.prepare(judge);
  expect(trainingState(f).rows).toBe(4);
  f.ledger.withdrawAccountScope('fixture', 'fixture');
  expect(f.ledger.readMeta('embedding-prefilter:training-scan-v1')).toBeUndefined();
  const restarted = f.make();
  await restarted.prepare(judge);
  expect(trainingState(f)).toMatchObject({ outcome: 'too_few', rows: 0, counts: [0, 0] });
  expect(logs).toHaveLength(2);
  expect(logs[0]).toContain('reason=ledger_or_judge_changed');
  expect(logs[0]).toContain(`next_attempt=${new Date(now).toISOString()}`);
  expect(existsSync(join(f.modelDir, 'weights.json'))).toBe(false);
});
test('pooled sources share one 200 ms training slice per resolver tick', async () => {
  let monotonic = 0;
  const a = fixture({ trained: false, monotonicNow: () => monotonic, log: () => {} });
  const b = fixture({ trained: false });
  for (let n = 0; n < 9; n++) { trainingRow(a, n); trainingRow(b, n); }
  a.setCopy(n => { monotonic += 50; return copy(n); });
  const second = new EmbeddingPrefilter({ ledger: b.ledger, sniffer: b.sniffer, sharedWith: a.filter,
    copyChangeMarker: () => '0',
    copyFor: identity => { monotonic += 50; return copy(Number(identity.providerItemId)); } });
  await runSnifferPass({ targets: [{ ledger: a.ledger, sniffer: a.sniffer, embeddingPrefilter: a.filter },
    { ledger: b.ledger, sniffer: b.sniffer, embeddingPrefilter: second }], lane,
    model: { async complete() { throw new Error('No model call expected'); } } });
  expect(monotonic).toBe(200);
  expect(trainingState(a)).toMatchObject({ outcome: 'scanning', rows: 4, counts: [2, 2] });
});
test('training windows bound examined rows, including unrouted rows', () => {
  const f = fixture({ trained: false });
  for (let n = 0; n < 8; n++) f.add(n);
  trainingRow(f, 8);
  const first = f.ledger.listItemWindow({ limit: 4 });
  expect(first.map(row => row.providerItemId)).toEqual(['0', '1', '2', '3']);
  expect(first.every(row => !row.routed)).toBe(true);
  const second = f.ledger.listItemWindow({ limit: 4, after: subject(3) });
  expect(second.map(row => row.providerItemId)).toEqual(['4', '5', '6', '7']);
  const last = f.ledger.listItemWindow({ limit: 4, after: subject(7) });
  expect(last).toHaveLength(1);
  expect(last[0]!.routed).toBe(true);
});

test('completed attempts survive checkpoint and growth-count errors without duplicate outcomes', async () => {
  const logs: string[] = [];
  const f = fixture({ trained: false, log: line => logs.push(line) });
  trainingRow(f, 0); trainingRow(f, 1);
  const writeMeta = f.ledger.writeMeta.bind(f.ledger);
  f.ledger.writeMeta = (key, value) => {
    if (key === 'embedding-prefilter:training-scan-v1') throw new Error('Synthetic checkpoint error');
    writeMeta(key, value);
  };
  await f.filter.prepare(judge);
  expect(trainingState(f).outcome).toBe('too_few');
  expect(logs).toHaveLength(1);
  const verdictCount = f.sniffer.verdictCount.bind(f.sniffer);
  f.sniffer.verdictCount = () => { throw new Error('Synthetic watermark error'); };
  for (let tick = 0; tick < 2; tick++) await f.filter.prepare(judge);
  expect(trainingState(f).outcome).toBe('too_few');
  expect(logs).toHaveLength(1);
  f.sniffer.verdictCount = verdictCount;
});
test('failure before reading ledger revisions still waits three hours across restart', async () => {
  let now = Date.UTC(2026, 10, 7);
  const logs: string[] = [];
  const f = fixture({ trained: false, now: () => now, log: line => logs.push(line) });
  const ledgerId = f.ledger.ledgerId.bind(f.ledger);
  f.ledger.ledgerId = () => { throw new Error('Synthetic ledger error'); };
  await f.filter.prepare(judge);
  expect(trainingState(f)).toMatchObject({ outcome: 'failed', nextAt: now + 3 * 60 * 60 * 1000 });
  f.ledger.ledgerId = ledgerId;
  const restarted = f.make();
  await restarted.prepare(judge);
  expect(logs).toHaveLength(1);
  now += 3 * 60 * 60 * 1000;
  await restarted.prepare(judge);
  expect(trainingState(f).outcome).toBe('too_few');
  expect(logs).toHaveLength(2);
});
test('a withdrawal on another connection cannot race stale references back into meta', async () => {
  const logs: string[] = [];
  const f = fixture({ trained: false, log: line => logs.push(line) });
  trainingRow(f, 0); trainingRow(f, 1);
  const other = new TierLedger({ dbPath: f.ledger.dbPath });
  const checkpoint = f.ledger.writeEmbeddingTrainingScan.bind(f.ledger);
  f.ledger.writeEmbeddingTrainingScan = (value, revision) => {
    // Interleave withdrawal after prepare's final revision read, before publication.
    other.withdrawAccountScope('fixture', 'fixture');
    return checkpoint(value, revision);
  };
  try {
    await f.filter.prepare(judge);
    expect(f.ledger.readMeta('embedding-prefilter:training-scan-v1')).toBeUndefined();
    expect(f.ledger.getCurrent(subject(0))).toBeUndefined();
    expect(trainingState(f)).toMatchObject({ outcome: 'failed', reason: 'ledger_or_judge_changed' });
    expect(logs).toHaveLength(1);
  } finally { other.close(); }
});

test('a failed completion watermark stays a failed attempt with a three-hour retry', async () => {
  const now = Date.UTC(2026, 10, 7);
  const logs: string[] = [];
  const f = fixture({ trained: false, now: () => now, log: line => logs.push(line) });
  for (let n = 0; n < 1000; n++) f.sniffer.putVerdict({ materialHash: `synthetic-watermark-${n}`, modelId: 'fixture', promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' },
    { tier: 'personal', confidence: 1, category: 'fixture', failSafe: false });
  const count = f.sniffer.verdictCount.bind(f.sniffer);
  let fail = true;
  f.sniffer.verdictCount = () => { if (fail) { fail = false; throw new Error('Synthetic completion watermark error'); } return count(); };
  await f.filter.prepare(judge);
  expect(trainingState(f)).toMatchObject({ outcome: 'failed', nextAt: now + 3 * 60 * 60 * 1000 });
  await f.filter.prepare(judge);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('outcome=failed');
});

test.each(['secrets', 'tier', 'decision', 'removed copy', 'changed vector', 'publication secrets', 'fit error'] as const)(
  'fitting discards retained examples after a selected item changes: %s', settled(async change => {
    let clock = 0;
    const dir = mkdtempSync(join(tmpdir(), 'prefilter-publication-'));
    const control = new TierLedger({ dbPath: join(dir, 'control.sqlite') });
    // Bound each slice below one normalization pass, so even a fast optimizer
    // is still suspended inside the fit when the mutation is injected.
    const f = fixture({ trained: false, memory: true, stateLedger: control, monotonicNow: () => (clock += 0.1), log: () => {} });
    cleanups.push(() => { control.close(); rmSync(dir, { recursive: true, force: true }); });
    trainingRows(f, 4000);
    const runtime = () => (f.filter as unknown as { training?: { examples: unknown[]; fit?: Generator<void, unknown>; model?: unknown } }).training;
    for (let tick = 0; tick < 100 && !runtime()?.fit; tick++) await f.filter.prepare(judge);
    expect(runtime()?.fit).toBeDefined();
    expect(runtime()?.examples).toHaveLength(4000);
    expect(runtime()?.model).toBeUndefined();
    const revision = f.ledger.readMeta('embedding-prefilter:training-revision');
    const row = f.ledger.getCurrent(subject(0))!;
    if (change === 'fit error') runtime()!.fit!.next = () => { throw new Error('Synthetic fit did not converge'); };
    else if (change === 'publication secrets') runtime()!.fit!.next = () => {
      f.ledger.recordDecision(subject(0), { ...row, state: 'current', snifferId: judge,
        decidedBy: 'secret_detector', contentTier: 'secrets' });
      return { done: true, value: { weights: new Array(D).fill(0), bias: -7 } };
    };
    else if (change === 'removed copy') f.setCopy(n => n === 0 ? undefined : copy(n));
    else if (change === 'changed vector') f.setCopy(n => copy(n, n === 0 ? -1 : 1));
    else f.ledger.recordDecision(subject(0), { ...row, state: 'current', snifferId: judge,
      decidedBy: change === 'secrets' ? 'secret_detector' : 'sniffer',
      contentTier: change === 'secrets' ? 'secrets' : change === 'tier' ? 'secure' : row.contentTier,
      reasons: change === 'decision' ? [...row.reasons, 'content:borderline:financial'] : row.reasons });
    expect(f.ledger.readMeta('embedding-prefilter:training-revision')).toBe(revision);
    for (let tick = 0; tick < 20 && trainingState(f).outcome === 'fitting'; tick++) await f.filter.prepare(judge);
    expect(trainingState(f)).toMatchObject({ outcome: 'failed', reason: change === 'fit error' ? 'training_failed' : 'ledger_or_judge_changed' });
    expect(runtime()).toBeUndefined();
    expect(existsSync(join(f.modelDir, 'weights.json'))).toBe(false);
  }), 30_000);


test.each(['legacy', 'receipt'] as const)('a historical metadata raise never replaces a %s content judge training label', async provenance => {
  const f = fixture({ trained: false, memory: true, log: () => {} });
  trainingRow(f, 0, [], 'other:1.00', true); // The body was judged Personal.
  trainingRow(f, 1, [], 'other:1.00', true); // A genuine Private label remains usable.
  for (const n of provenance === 'legacy' ? [0, 1] : []) {
    const row = f.ledger.getCurrent(subject(n))!;
    f.ledger.recordDecision(subject(n), { ...row, state: 'current', snifferId: judge, decidedBy: 'sniffer',
      reasons: row.reasons.filter(reason => !reason.startsWith('content:judge_verdict:')) });
  }
  const original = f.ledger.getCurrent(subject(0))!;
  const recordNames = (title: string) => {
    const decision = withRecordedContent(classifyItemTiers({ signals: { title }, subject: subject(0) }, {
      sniffer: { id: judge, judge: () => ({ verdict: 'decided', tier: 'secure', code: 'fixture' }) },
    }), f.ledger.getCurrent(subject(0)));
    f.ledger.recordRoutedPlacement(subject(0), decision, {
      copies: [{ corpusId: 'private', trustDomain: 'secure_local', layers: 'both' }], embedHold: false,
    });
  };
  recordNames('Bank GB82 WEST 1234 5698 7654 32');
  expect(f.ledger.getCurrent(subject(0))).toMatchObject({ metadataTier: 'secure', contentTier: 'secure' });
  recordNames('Picnic plan');
  const current = f.ledger.getCurrent(subject(0))!;
  expect(current).toMatchObject({ metadataTier: 'private', contentTier: 'secure', contentPending: false });
  expect(current.reasons.filter(reason => reason.startsWith('content:'))).toEqual(original.reasons.filter(reason => reason.startsWith('content:')));
  await f.filter.prepare(judge);
  expect(trainingState(f)).toMatchObject({ outcome: 'too_few', counts: [0, 1] });
});

test.each(['metadata-cache', 'missing-cache', 'no-store'] as const)('legacy names-only verdict cannot label a retained Personal body after renaming: %s', cache => {
  let now = new Date('2026-11-01T00:00:00.000Z');
  const f = fixture({ trained: false, memory: true, snifferNow: () => now });
  trainingRow(f, 0, [], 'other:1.00', true);
  const original = f.ledger.getCurrent(subject(0))!;
  f.ledger.recordDecision(subject(0), { ...original, state: 'current', snifferId: judge, decidedBy: 'sniffer',
    reasons: original.reasons.filter(reason => !reason.startsWith('content:judge_verdict:')) });
  const names = (title: string) => classifyItemTiers({ signals: { title }, subject: subject(0) }, {
    sniffer: new CachedTierSniffer(f.sniffer, lane),
  });
  const recordNames = (title: string) => f.ledger.recordRoutedPlacement(subject(0),
    withRecordedContent(names(title), f.ledger.getCurrent(subject(0))), {
      copies: [{ corpusId: 'private', trustDomain: 'secure_local', layers: 'both' }], embedHold: false,
    });
  now = new Date('2026-11-02T00:00:00.000Z');
  const title = 'Bank GB82 WEST 1234 5698 7654 32';
  names(title);
  const question = f.sniffer.questionFor(subject(0), 'metadata')!;
  expect(question).toBeDefined();
  f.sniffer.putVerdict({ materialHash: question.materialHash, modelId: snifferCacheModelId(lane),
    promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' },
    { tier: 'private', category: 'financial', confidence: 1, failSafe: false }, question);
  recordNames(title);
  f.sniffer.deleteQuestion(subject(0), 'metadata');
  recordNames('Picnic plan');
  const current = f.ledger.getCurrent(subject(0))!;
  expect(current).toMatchObject({ metadataTier: 'private', previousMetadataTier: 'secure', contentTier: 'secure', contentPending: false });
  const drops: string[] = [];
  expect(prefilterTrainingExample(current, judge, { ledger: f.ledger,
    ...(cache === 'no-store' ? {} : { sniffer: cache === 'missing-cache' ? { trainingVerdict: () => undefined } : f.sniffer }),
    copyFor: () => copy(0) }, reason => { drops.push(reason); return undefined; })).toBeUndefined();
  expect(drops).toEqual([cache === 'no-store' ? 'legacy_store_missing' : cache === 'missing-cache' ? 'legacy_verdict_missing' : 'legacy_verdict_content']);
});

test('legacy rename then public share/unshare rejects a retained metadata raise without cache evidence', () => {
  let now = new Date('2026-11-01T00:00:00.000Z');
  const f = fixture({ trained: false, memory: true, snifferNow: () => now });
  trainingRow(f, 0, [], 'other:1.00', true);
  const original = f.ledger.getCurrent(subject(0))!;
  f.ledger.recordDecision(subject(0), { ...original, state: 'current', snifferId: judge, decidedBy: 'sniffer',
    reasons: original.reasons.filter(reason => !reason.startsWith('content:judge_verdict:')) });
  const names = (title: string) => classifyItemTiers({ signals: { title }, subject: subject(0) }, {
    sniffer: new CachedTierSniffer(f.sniffer, lane),
  });
  const recordNames = (title: string) => f.ledger.recordRoutedPlacement(subject(0),
    withRecordedContent(names(title), f.ledger.getCurrent(subject(0))), {
      copies: [{ corpusId: 'private', trustDomain: 'secure_local', layers: 'both' }], embedHold: false,
    });
  now = new Date('2026-11-02T00:00:00.000Z');
  const title = 'Bank GB82 WEST 1234 5698 7654 32';
  names(title);
  const question = f.sniffer.questionFor(subject(0), 'metadata')!;
  expect(question).toBeDefined();
  f.sniffer.putVerdict({ materialHash: question.materialHash, modelId: snifferCacheModelId(lane),
    promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' },
    { tier: 'private', category: 'financial', confidence: 1, failSafe: false }, question);
  recordNames(title);
  f.sniffer.deleteQuestion(subject(0), 'metadata');
  recordNames('Picnic plan');
  const current = f.ledger.getCurrent(subject(0))!;
  expect(current).toMatchObject({ metadataTier: 'private', previousMetadataTier: 'secure', contentTier: 'secure', contentPending: false });
  for (const sharing of ['public_link', 'private'] as const) {
    f.ledger.recordRoutedPlacement(subject(0), withRecordedContent(classifyItemTiers({
      signals: { title: 'Picnic plan', sharing }, subject: subject(0),
    }, { sniffer: new CachedTierSniffer(f.sniffer, lane) }), f.ledger.getCurrent(subject(0))), {
      copies: [{ corpusId: 'private', trustDomain: 'secure_local', layers: 'both' }], embedHold: false,
    });
  }
  const afterSharing = f.ledger.getCurrent(subject(0))!;
  expect(afterSharing).toMatchObject({ metadataTier: 'private', previousMetadataTier: 'public', contentTier: 'secure' });
  expect(afterSharing.reasons.some(reason => reason.startsWith('metadata:sniffer:'))).toBe(false);
  const drops: string[] = [];
  expect(prefilterTrainingExample(afterSharing, judge, { ledger: f.ledger,
    sniffer: { trainingVerdict: () => undefined },
    copyFor: () => copy(0) }, reason => { drops.push(reason); return undefined; })).toBeUndefined();
  expect(drops).toEqual(['legacy_verdict_missing']);
});

test.each(['bound', 'missing', 'stale'] as const)('legacy content-pass labels require matching cached content binding: %s', async binding => {
  const f = fixture({ trained: false, memory: true, log: () => {} });
  for (const n of [0, 1]) {
    trainingRow(f, n, [], 'other:1.00', binding === 'bound');
    if (binding === 'stale') f.sniffer.markFinalModelContent({ materialHash: `synthetic-material-${n}-${n}`,
      modelId: 'fixture', promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' }, normalizedContentHash('Different body'));
    const row = f.ledger.getCurrent(subject(n))!;
    f.ledger.recordDecision(subject(n), { ...row, state: 'current', snifferId: judge, decidedBy: 'sniffer',
      reasons: row.reasons.filter(reason => !reason.startsWith('content:judge_verdict:')) });
    const drops: string[] = [];
    const example = prefilterTrainingExample(f.ledger.getCurrent(subject(n))!, judge,
      { ledger: f.ledger, sniffer: f.sniffer, copyFor: () => copy(n) }, reason => { drops.push(reason); return undefined; });
    if (binding === 'bound') expect(example).toMatchObject({ private: n === 1, provenance: 'legacy_sniffer' });
    else expect(example).toBeUndefined();
    expect(drops).toEqual(binding === 'bound' ? [] : ['legacy_verdict_content']);
  }
  await f.filter.prepare(judge);
  expect(trainingState(f)).toMatchObject({ outcome: 'too_few', counts: binding === 'bound' ? [1, 1] : [0, 0] });
});

test('legacy metadata raises and differing subject verdict tiers never label', () => {
  const f = fixture({ trained: false, memory: true });
  trainingRow(f, 0);
  const row = f.ledger.getCurrent(subject(0))!;
  const reasons = row.reasons.filter(reason => !reason.startsWith('content:judge_verdict:'));
  const options = { ledger: f.ledger, sniffer: f.sniffer, copyFor: () => copy(0) };
  const drops: string[] = [];
  expect(prefilterTrainingExample({ ...row, reasons, contentTier: 'secure' }, judge, options,
    reason => { drops.push(reason); return undefined; })).toBeUndefined();
  expect(drops).toEqual(['legacy_verdict_tier']);
});

test.each([undefined, 2, 3, 4])('an old zero-example attempt restarts immediately: label version %s', async version => {
  const f = fixture({ trained: false, memory: true, log: () => {} });
  await f.filter.prepare(judge);
  const old = trainingState(f);
  old.labelVersion = version;
  f.ledger.writeMeta('embedding-prefilter:training-v1', JSON.stringify(old));
  trainingRow(f, 0, [], 'other:1.00', true); trainingRow(f, 1, [], 'other:1.00', true);
  for (const n of [0, 1]) {
    const row = f.ledger.getCurrent(subject(n))!;
    f.ledger.recordDecision(subject(n), { ...row, state: 'current', snifferId: judge, decidedBy: 'sniffer',
      reasons: row.reasons.filter(reason => !reason.startsWith('content:judge_verdict:')) });
  }
  await f.make().prepare(judge);
  expect(trainingState(f)).toMatchObject({ labelVersion: 5, outcome: 'too_few', counts: [1, 1] });
  expect(trainingState(f).id).not.toBe(old.id);
});


test('content judge tier receipts bind both the verdict reason and complete-text digest', async () => {
  const f = fixture({ trained: false, memory: true, log: () => {} });
  for (let n = 0; n < 4; n++) trainingRow(f, n);
  for (const n of [0, 1]) {
    const row = f.ledger.getCurrent(subject(n))!;
    f.ledger.recordDecision(subject(n), { ...row, state: 'current', snifferId: judge, decidedBy: 'sniffer',
      reasons: row.reasons.map(reason => n === 0 && reason.startsWith('content:sniffer:') ? `${reason}:changed`
        : n === 1 && reason.startsWith('content:sha256:') ? contentDigestReason('Updated picnic plan') : reason) });
  }
  f.setCopy(n => n === 1 ? { ...copy(n), chunks: [{ ...copy(n).chunks[0]!, boundedText: 'Updated picnic plan' }] } : copy(n));
  await f.filter.prepare(judge);
  expect(trainingState(f)).toMatchObject({ outcome: 'too_few', counts: [1, 1] });
});


test('a newer content verdict replaces the historical tier receipt even when its reason is unchanged', async () => {
  const f = fixture({ trained: false, memory: true, log: () => {} });
  trainingRow(f, 1); // An earlier Private judgment.
  const row = f.ledger.getCurrent(subject(1))!;
  const reason = row.reasons.find(value => value.startsWith('content:sniffer:'))!;
  f.ledger.recordDecision(subject(1), { ...row, state: 'pending', snifferId: judge, decidedBy: 'sniffer', contentPending: true,
    reasons: row.reasons.map(value => value === reason ? `content:sniffer:${judge}:undecided` : value) });
  f.ledger.applySnifferVerdict(subject(1), { pass: 'content', tier: 'private', reason, modelId: 'fixture' }, {
    placementFor: () => ({ copies: [{ corpusId: 'private', trustDomain: 'secure_local', trustTier: 'S4', layers: 'both' }], embedHold: false }),
  });
  // The raise-only ledger still holds Private, but today's content verdict is Personal.
  expect(f.ledger.getCurrent(subject(1))).toMatchObject({ contentTier: 'secure', contentPending: false });
  await f.filter.prepare(judge);
  expect(trainingState(f)).toMatchObject({ outcome: 'too_few', counts: [0, 0] });
});

test('costly retained-copy validation yields and still lets fitting finish', settled(async () => {
  let clock = 0;
  const dir = mkdtempSync(join(tmpdir(), 'prefilter-budget-'));
  const control = new TierLedger({ dbPath: join(dir, 'control.sqlite') });
  const f = fixture({ trained: false, memory: true, stateLedger: control, monotonicNow: () => clock, log: () => {} });
  cleanups.push(() => { control.close(); rmSync(dir, { recursive: true, force: true }); });
  trainingRows(f, 4000);
  f.setCopy(n => { clock += 0.1; return copy(n); }); // 400 ms for a complete retained-copy sweep.
  for (let tick = 0; tick < 50 && !existsSync(join(f.modelDir, 'weights.json')); tick++) {
    const started = clock;
    f.ledger.writeMeta('fixture:unrelated-ingestion', String(tick));
    await f.filter.prepare(judge);
    expect(clock - started).toBeLessThanOrEqual(200.11);
  }
  expect(trainingState(f)).toMatchObject({ outcome: 'trained', counts: [2000, 2000] });
  expect(existsSync(join(f.modelDir, 'weights.json'))).toBe(true);
}), 30_000);

test('a scanned attempt finishes between continuous judge passes and backlog-sized lowering slices', settled(async () => {
  let clock = 0;
  const logs: string[] = [];
  const f = fixture({ trained: false, monotonicNow: () => clock, log: line => logs.push(line) });
  trainingRows(f, 4000);
  const readCopy = (n: number) => { clock += 0.1; return copy(n); };
  f.setCopy(readCopy); // The complete freshness sweep needs 400 ms, spanning slices.
  const runtime = () => (f.filter as unknown as { training?: { finalValidation?: { index: number } } }).training;
  for (let slice = 0; slice < 100 && !runtime()?.finalValidation?.index; slice++) await f.filter.prepare(judge);
  expect(JSON.parse(f.ledger.readMeta('embedding-prefilter:training-scan-v1')!).done).toBe(true);
  expect(runtime()?.finalValidation?.index).toBeGreaterThan(0);
  expect(runtime()?.finalValidation?.index).toBeLessThan(4000);

  const pausedAt = clock;
  await f.filter.finishValidation(judge, () => true);
  expect(clock).toBe(pausedAt); // An answer preempts the dedicated window too.
  let writes = 0;
  f.setCopy(n => {
    if (n === 0) f.sniffer.putVerdict({ materialHash: `concurrent-${writes++}`, modelId: 'fixture', promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' },
      { tier: 'personal', category: 'fixture', confidence: 1, failSafe: false }, subject(9999));
    return readCopy(n);
  });
  await f.filter.finishValidation(judge, () => false);
  expect(trainingState(f).outcome).toBe('fitting');
  expect(writes).toBe(2); // Another writer invalidates the window; the judge gets its next turn.
  expect(clock - pausedAt).toBeLessThanOrEqual(400.3);
  f.setCopy(readCopy);

  const installed = new InstalledTierClassification({ env: {}, lane });
  installed.snifferStoreForLedger = () => f.sniffer;
  const classificationLedgerPath = join(f.modelDir, '..', 'classification.jsonl');
  await appendClassificationLedgerEntry(classificationLedgerPath, {
    recorded_at: new Date().toISOString(), kind: 'classifier_model_decision', what: 'Synthetic fixture approval',
    approved_by: 'owner', status: 'complete', model_id: lane.modelId, lane: lane.kind,
    profile_id: lane.profileId, prompt_version: SNIFFER_PROMPT_VERSION,
  });
  const service = new TierSnifferService({ installed, lane, model: { complete: async () => { throw new Error('unused'); } },
    stores: () => [{ dbPath: join(f.modelDir, '..', 'store.sqlite'), tierSetBinding: () => ({ ledgerPath: f.ledger.dbPath }),
      tierLedgerPathInUse: () => f.ledger.dbPath, exportItemCopy: identity => copy(Number(identity.providerItemId)) }],
    classificationLedgerPath, intervalMs: 60_000, passTimeMs: 30_000, rejudgePerPass: 0,
  });
  const scheduler = service as unknown as {
    embeddingPrefilters: Map<string, EmbeddingPrefilter>; trainingTimer: ReturnType<typeof setTimeout> | undefined;
    drainMoves(direction?: 'raise' | 'lower'): Promise<undefined>;
  };
  scheduler.embeddingPrefilters.set(f.ledger.dbPath, f.filter);
  // Drive ticks and inference-wait slices explicitly, without timer races.
  const wake = spyOn(service, 'wake').mockImplementation(() => {});
  let judgeMs = 0;
  let loweringMs = 0;
  let serial = 0;
  const busySlice = async (ms: number) => {
    clock += ms;
    // Unrelated writes in all three stores covered by the publication fence.
    const row = f.ledger.getCurrent(subject(3999))!;
    f.ledger.recordDecision(subject(9999), { ...row, state: 'current', snifferId: judge, decidedBy: 'sniffer' });
    f.setCopy(readCopy);
    f.sniffer.putVerdict({ materialHash: `unrelated-${serial++}`, modelId: 'fixture', promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' },
      { tier: 'personal', category: 'fixture', confidence: 1, failSafe: false }, subject(9999));
    await f.filter.prepare(judge);
  };
  const pass = spyOn(resolver, 'runSnifferPass').mockImplementation(async options => {
    expect(options.passTimeMs).toBe(30_000);
    options.trainingReady!(judge);
    clearTimeout(scheduler.trainingTimer); scheduler.trainingTimer = undefined;
    for (let n = 0; n < 3; n++) { await busySlice(10_000); judgeMs += 10_000; }
    return { clearing: clearingCounts(), calls: 1, failedCalls: 0, verdictsApplied: 1, stoppedBy: 'pass_budget' } as resolver.SnifferPassReport;
  });
  const moves = spyOn(scheduler, 'drainMoves').mockImplementation(async direction => {
    if (direction === 'lower') {
      for (let n = 0; n < 10; n++) { await busySlice(1000); loweringMs += 1000; }
    }
    return undefined;
  });
  try {
    service.start();
    let ticks = 0;
    while (trainingState(f).outcome === 'fitting' && ticks < 3) {
      expect((await service.runOnce()).state).toBe('ran');
      ticks++;
    }
    expect(judgeMs).toBe(ticks * 30_000);
    expect(loweringMs).toBe(ticks * 10_000);
    expect(trainingState(f)).toMatchObject({ outcome: 'trained', rows: 4000, counts: [2000, 2000] });
    expect(logs.filter(line => line.includes('outcome=trained'))).toHaveLength(1);
  } finally {
    service.stop(); wake.mockRestore(); pass.mockRestore(); moves.mockRestore(); installed.close();
  }
}), 30_000);

test.each(['secrets', 'external secrets', 'copy', 'legacy verdict'] as const)(
  'final validation fences an already-checked example changed between ticks: %s', settled(async change => {
    let clock = 0;
    const f = fixture({ trained: false, memory: change !== 'external secrets', monotonicNow: () => clock, log: () => {} });
    // In-memory examples still publish to a separate durable control ledger.
    const dir = mkdtempSync(join(tmpdir(), 'prefilter-final-validation-'));
    const control = new TierLedger({ dbPath: join(dir, 'control.sqlite') });
    cleanups.push(() => { control.close(); rmSync(dir, { recursive: true, force: true }); });
    const filter = new EmbeddingPrefilter({ ledger: f.ledger, sniffer: f.sniffer, stateLedger: control,
      copyFor: s => { clock += 0.1; return currentCopy(Number(s.providerItemId)); },
      copyChangeMarker: () => String(copyRevision), monotonicNow: () => clock, log: () => {} });
    let currentCopy = (n: number) => copy(n);
    let copyRevision = 0;
    trainingRows(f, 4000, n => trainingRow(f, n, [], 'other:1.00', change === 'legacy verdict' && n === 0));
    if (change === 'legacy verdict') {
      const row = f.ledger.getCurrent(subject(0))!;
      f.ledger.recordDecision(subject(0), { ...row, state: 'current', snifferId: judge, decidedBy: 'sniffer',
        reasons: row.reasons.filter(reason => !reason.startsWith('content:judge_verdict:')) });
    }
    const runtime = () => (filter as unknown as { training?: {
      fit?: Generator<void, unknown>; finalValidation?: { index: number };
    } }).training;
    for (let tick = 0; tick < 50 && !runtime()?.finalValidation?.index; tick++) await filter.prepare(judge);
    expect(runtime()?.finalValidation?.index).toBeGreaterThan(0);
    expect(runtime()?.finalValidation?.index).toBeLessThan(4000);
    const weights = join(embeddingPrefilterDirectory(control.dbPath), 'weights.json');
    expect(existsSync(weights)).toBe(false);
    // Subject 0 was validated in the first slice. A later change must force
    // another pass rather than trusting that slice when publication resumes.
    if (change === 'copy') {
      currentCopy = n => n === 0 ? { ...copy(n), chunks: [{ ...copy(n).chunks[0]!, boundedText: 'Updated picnic plan.' }] } : copy(n);
      copyRevision++;
    } else if (change === 'legacy verdict') {
      // Only the cache changes; neither the ledger nor serving-copy marker moves.
      f.sniffer.putVerdict({ materialHash: 'new-answer', modelId: 'fixture', promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' },
        { tier: 'private', category: 'fixture', confidence: 1, failSafe: false }, subject(0));
    } else {
      const writer = change === 'external secrets' ? new TierLedger({ dbPath: f.ledger.dbPath }) : f.ledger;
      try {
        writer.recordDecision(subject(0), { ...writer.getCurrent(subject(0))!, state: 'current',
          snifferId: judge, decidedBy: 'secret_detector', contentTier: 'secrets' });
      } finally { if (writer !== f.ledger) writer.close(); }
    }
    await filter.finishValidation(judge, () => false);
    expect(JSON.parse(control.readMeta('embedding-prefilter:training-v1')!)).toMatchObject({ outcome: 'failed', reason: 'ledger_or_judge_changed' });
    expect(existsSync(weights)).toBe(false);
  }), 30_000);

test('production-shaped held and judged rows retain usable judge provenance and digest', async () => {
  const f = fixture({ trained: false, memory: true, log: () => {} });
  for (let n = 0; n < 4; n++) {
    // Real classify -> routed held copy -> applySnifferVerdict writers, synthetic text/vectors.
    const q = f.add(n, {}, ownText);
    const row = f.ledger.getCurrent(subject(n))!;
    f.ledger.recordRoutedPlacement(subject(n), { ...row, state: 'pending', decidedBy: 'default', snifferId: judge },
      f.placementFor({ contentPending: true } as TierDecision));
    expect(row.reasons).toContain('content:held_until_judged');
    f.ledger.applySnifferVerdict(q, { pass: 'content', tier: n % 2 ? 'secure' : 'private',
      reason: `content:sniffer:${judge}:${n % 2 ? 'personal_record' : 'other'}:1.00`, modelId: 'fixture' },
    { placementFor: () => ({ copies: [{ corpusId: 'private', trustDomain: 'secure_local', trustTier: 'S4', layers: 'both' }], embedHold: false }) });
    f.ledger.markJudged(subject(n), { engineVersion: 'fixture', snifferId: judge });
    expect(f.ledger.getCurrent(subject(n))!.state).toBe('current');
  }
  await f.filter.prepare(judge);
  expect(trainingState(f).counts).toEqual([2, 2]);
  expect(trainingState(f).rows).toBe(4);
  expect(trainingState(f).outcome).toBe('too_few');
});

test('scan visits another ledger within a window instead of draining a sparse first ledger', async () => {
  let clock = 0;
  const a = fixture({ trained: false, memory: true, monotonicNow: () => clock, log: () => {} });
  const b = fixture({ trained: false, memory: true });
  for (let n = 0; n < 100; n++) a.add(n);
  trainingRow(b, 0); trainingRow(b, 1);
  new EmbeddingPrefilter({ ledger: b.ledger, sniffer: b.sniffer, sharedWith: a.filter,
    copyChangeMarker: () => '0', copyFor: identity => copy(Number(identity.providerItemId)) });
  for (const ledger of [a.ledger, b.ledger]) {
    const list = ledger.listItemWindow.bind(ledger);
    ledger.listItemWindow = options => { clock += 50; return list(options); };
  }
  await a.filter.prepare(judge);
  expect(clock).toBeLessThanOrEqual(200);
  expect(trainingState(a).counts).toEqual([1, 1]);
  expect(trainingState(a).rows).toBeLessThan(102);
});

test('scan stops on the exact row filling both 5000-example caps', async () => {
  let clock = 0;
  const f = fixture({ trained: false, memory: true, monotonicNow: () => clock, log: () => {} });
  for (let n = 0; n < 10010; n++) trainingRow(f, n);
  let copied = 0;
  f.setCopy(n => { if (++copied === 10000) clock = 200; return copy(n); });
  await f.filter.prepare(judge);
  expect(trainingState(f).rows).toBe(10000);
  expect(trainingState(f).counts).toEqual([5000, 5000]);
  expect(trainingState(f).outcome).toBe('fitting');
  expect(copied).toBe(10000);
}, 30_000);

test('training yields to judge/control work before another row and serializes overlapping slices', async () => {
  const f = fixture({ trained: false, memory: true, log: () => {} });
  for (let n = 0; n < 8; n++) trainingRow(f, n);
  let pause = false;
  f.setCopy(n => { pause = true; return copy(n); });
  await Promise.all([f.filter.prepare(judge, () => pause), f.filter.prepare(judge, () => pause)]);
  expect(trainingState(f).rows).toBe(1);
  expect(trainingState(f).outcome).toBe('scanning');
  await f.filter.prepare(judge, () => pause);
  expect(trainingState(f).rows).toBe(1);
  pause = false;
  await f.filter.prepare(judge, () => pause);
  expect(trainingState(f).rows).toBe(2);
});

test('service trains during inference waits and idle time without delaying a judge dispatch', async () => {
  let clock = 0;
  const f = fixture({ trained: false, monotonicNow: () => clock, log: () => {} });
  for (let n = 0; n < 40; n++) trainingRow(f, n);
  let copies = 0;
  f.setCopy(n => { copies++; clock += 100; return copy(n); });
  f.add(100);
  const installed = new InstalledTierClassification({ env: {}, lane });
  installed.snifferStoreForLedger = () => f.sniffer;
  const classificationLedgerPath = join(f.modelDir, '..', 'classification.jsonl');
  await appendClassificationLedgerEntry(classificationLedgerPath, {
    recorded_at: new Date().toISOString(), kind: 'classifier_model_decision', what: 'Synthetic fixture approval',
    approved_by: 'owner', status: 'complete', model_id: lane.modelId, lane: lane.kind,
    profile_id: lane.profileId, prompt_version: SNIFFER_PROMPT_VERSION,
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let called = false;
  const service = new TierSnifferService({ installed, lane,
    stores: () => [{ dbPath: join(f.modelDir, '..', 'store.sqlite'), tierSetBinding: () => ({ ledgerPath: f.ledger.dbPath }),
      tierLedgerPathInUse: () => f.ledger.dbPath, exportItemCopy: identity => copy(Number(identity.providerItemId)) }],
    classificationLedgerPath, intervalMs: 60_000, maxCallsPerPass: 1, rejudgePerPass: 0,
    model: { async complete() {
      expect(copies).toBe(0); // Dispatch happens before any training row is read.
      called = true;
      await held;
      return { text: '', modelId: lane.modelId, decisionVerdict: { tier: 'private', category: 'fixture', confidence: 1, failSafe: false } };
    } },
  });
  // Use the same synthetic prefilter in the real service's scheduler and resolver.
  (service as unknown as { embeddingPrefilters: Map<string, EmbeddingPrefilter> }).embeddingPrefilters.set(f.ledger.dbPath, f.filter);
  const waitFor = async (ready: () => boolean) => {
    const until = performance.now() + 3000;
    while (!ready() && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    expect(ready()).toBe(true);
  };
  try {
    service.start();
    await waitFor(() => called && !!f.ledger.readMeta('embedding-prefilter:training-v1') && trainingState(f).rows >= 6);
    // Several slices completed inside the one still-pending model call.
    expect(trainingState(f).outcome).toBe('scanning');
    release();
    await waitFor(() => trainingState(f).outcome === 'too_few');
    expect(trainingState(f).rows).toBe(41);
    expect(trainingState(f).counts).toEqual([20, 20]);
    service.stop();
    const stoppedAt = copies;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(copies).toBe(stoppedAt);
  } finally {
    release(); service.stop();
    await new Promise(resolve => setTimeout(resolve, 10));
    installed.close();
  }
});

test.each(['version', 'trainedAt'] as const)('invalid saved %s cannot clear before background preparation', async field => {
  const f = fixture();
  const path = join(f.modelDir, 'weights.json');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  saved[field] = field === 'version' ? 'invalid' : null;
  writeFileSync(path, JSON.stringify(saved));
  const filter = f.make();
  f.add(1);
  let calls = 0;
  await runSnifferPass({ targets: [{ ledger: f.ledger, sniffer: f.sniffer, embeddingPrefilter: filter }], lane,
    trainingReady: () => {}, // The idle callback has not run yet.
    model: { async complete() { calls++; return { text: '', modelId: lane.modelId,
      decisionVerdict: { tier: 'private', category: 'fixture', confidence: 1, failSafe: false } }; } },
  });
  expect(calls).toBe(1);
  expect(f.ledger.getCurrent(subject(1))!.contentTier).toBe('secure');
});

test('each training drop check has a stable first-failure counter', () => {
  const f = fixture({ trained: false, memory: true });
  trainingRow(f, 0);
  const row = f.ledger.getCurrent(subject(0))!;
  const valid = copy(0);
  const cases: Array<[typeof PREFILTER_TRAINING_REJECTIONS[number], Record<string, unknown>?, typeof valid?, string?]> = [
    ['not_routed', { routed: false }], ['not_current', { state: 'pending' }],
    ['metadata_pending', { metadataPending: true }], ['content_pending', { contentPending: true }],
    ['content_unread', { contentRead: false }], ['metadata_tier', { metadataTier: 'secure' }],
    ['content_tier', { contentTier: 'secrets' }], ['metadata_forced', { metadataForced: true }],
    ['model_missing', { modelId: null }], ['owner_decision', { decidedBy: 'owner_rule' }],
    ['override_decision', { decidedBy: 'override' }], ['item_override'], ['rejudge_open'],
    ['metadata_owner_rule', {}, valid, 'metadata:owner_rule:test'], ['metadata_floor', {}, valid, 'metadata:floor:test'],
    ['metadata_secret', {}, valid, 'metadata:secret:test'], ['override_reason', {}, valid, 'override:test'],
    ['judge_code_empty', {}, valid, ''], ['judge_code_held', {}, valid, 'record_held:test'],
    ['judge_code_unsafe', {}, valid, 'fail_safe:test'], ['judge_duplicate'],
    ['content_reason_unknown', {}, valid, 'content:unknown:test'], ['judge_missing'], ['copy_missing'],
    ['digest_missing'], ['verdict_missing'], ['legacy_store_missing'], ['legacy_verdict_missing'],
    ['legacy_verdict_ambiguous'], ['legacy_verdict_time'], ['legacy_verdict_tier'], ['legacy_verdict_content'], ['legacy_verdict_unreadable'],
    ['chunks_empty'], ['media_present'], ['secret_material'],
    ['vector_count'], ['vector_match'], ['vector_bytes'], ['vector_nonfinite'], ['vector_zero'],
    ['judge_id_invalid'], ['judge_model_mismatch'],
  ];
  const verdict = row.reasons.find(reason => reason.startsWith('content:judge_verdict:'))!;
  const judged = row.reasons.find(reason => reason.startsWith(`content:sniffer:${judge}:`))!;
  expect(verdict).toBeDefined();
  for (const [expected, patch = {}, , extra] of cases) {
    let reasons = [...row.reasons];
    let currentCopy: typeof valid | undefined = structuredClone(valid);
    if (extra !== undefined) {
      if (expected.startsWith('judge_code_')) reasons = reasons.map(reason => reason === judged ? `content:sniffer:${judge}:${extra}` : reason);
      else reasons.push(extra);
    }
    if (expected === 'judge_duplicate') reasons.push(judged);
    if (expected === 'judge_missing') reasons = reasons.filter(reason => reason !== judged);
    if (expected === 'digest_missing') reasons = reasons.filter(reason => !reason.startsWith('content:sha256:'));
    if (expected === 'verdict_missing') reasons = reasons.map(reason => reason === verdict ? `${verdict}wrong` : reason);
    if (expected.startsWith('legacy_')) reasons = [...reasons.filter(reason => reason !== verdict), `metadata:sniffer:${judge}:other:1.00`];
    if (expected === 'judge_id_invalid') reasons = reasons.map(reason => reason === judged ? 'content:sniffer:invalid:other:1.00' : reason);
    if (expected === 'judge_model_mismatch') reasons = reasons.map(reason => reason === judged ? `content:sniffer:${snifferId({ ...lane, modelId: 'other' })}:other:1.00` : reason);
    if (expected === 'copy_missing') currentCopy = undefined;
    if (expected === 'chunks_empty') {
      currentCopy!.chunks = [];
      const digest = contentDigestReason('');
      reasons = reasons.filter(reason => !reason.startsWith('content:sha256:') && reason !== verdict);
      reasons.push(digest, contentJudgeVerdictReason(judged, row.contentTier, digest));
    }
    if (expected === 'media_present') currentCopy!.chunks[0]!.mediaPath = '/synthetic/image';
    if (expected === 'secret_material') {
      const text = ['-----BEGIN', 'PRIVATE KEY-----\nsynthetic-private-key-fixture\n-----END PRIVATE KEY-----'].join(' ');
      currentCopy!.chunks[0]!.boundedText = text;
      const digest = contentDigestReason(text);
      reasons = reasons.filter(reason => !reason.startsWith('content:sha256:') && reason !== verdict);
      reasons.push(digest, contentJudgeVerdictReason(judged, row.contentTier, digest));
    }
    if (expected === 'vector_count') currentCopy!.vectors = [];
    if (expected === 'vector_match') currentCopy!.vectors[0]!.contentHash = 'stale';
    if (expected === 'vector_bytes') currentCopy!.vectors[0]!.embedding = new Uint8Array(1);
    if (expected === 'vector_nonfinite') new DataView(currentCopy!.vectors[0]!.embedding.buffer).setFloat32(0, NaN, true);
    if (expected === 'vector_zero') currentCopy!.vectors[0]!.embedding.fill(0);
    const drops: string[] = [];
    const result = prefilterTrainingExample({ ...row, ...patch, reasons }, judge, {
      ledger: {
        getOverride: () => expected === 'item_override' ? { kind: 'tier', tier: 'secure' } : undefined,
        rejudgeQuestion: () => expected === 'rejudge_open' ? {} as ReturnType<TierLedger['rejudgeQuestion']> : undefined,
      }, copyFor: () => currentCopy,
      ...(expected.startsWith('legacy_') && expected !== 'legacy_store_missing' ? { sniffer: { trainingVerdict: () => {
        if (expected === 'legacy_verdict_unreadable') throw new Error('synthetic old schema');
        if (expected === 'legacy_verdict_missing') return undefined;
        return { tier: expected === 'legacy_verdict_tier' ? 'private' as const : 'personal' as const,
          decidedAt: expected === 'legacy_verdict_time' ? '2099-01-01T00:00:00.000Z' : row.decidedAt,
          ambiguous: expected === 'legacy_verdict_ambiguous' };
      } } } : {}),
    }, reason => { drops.push(reason); return undefined; });
    expect(result, expected).toBeUndefined();
    expect(drops, expected).toEqual([expected]);
  }
  expect(cases.map(([reason]) => reason)).toEqual([...PREFILTER_TRAINING_REJECTIONS]);
});

test.each(['unchanged', 'raiser', 'secrets', 'override', 'vector'] as const)(
  'a sampled queued lowering may complete only with unchanged label and vectors: %s', async change => {
    const f = fixture({ trained: false, memory: true, log: () => {} });
    trainingRow(f, 0);
    const settled = f.ledger.getCurrent(subject(0))!;
    f.ledger.recordRoutedPlacement(subject(0), { ...settled, state: 'current', contentTier: 'secure',
      decidedBy: 'sniffer', snifferId: judge }, f.placementFor({ contentPending: true } as TierDecision));
    const moving = f.ledger.beginMove(subject(0), { metadataTier: 'private', contentTier: 'private' }, f.ledger.getCurrent(subject(0))!.generation);
    const example = (f.filter as unknown as { trainingExample(row: typeof moving, judge: string): { current(check: boolean): boolean } }).trainingExample(moving, judge);
    expect(example.current(true)).toBe(true);
    const destination = [{ corpusId: 'personal', trustDomain: 'internal' as const, layers: 'both' as const }];
    f.ledger.stageMove(subject(0), { expectedGeneration: moving.generation,
      target: { metadataTier: 'private', contentTier: 'private' }, destination, hideSource: false });
    expect(f.ledger.copies(subject(0)).some(copy => copy.state === 'staged')).toBe(true);
    expect(example.current(true)).toBe(true);
    f.ledger.completeMove(subject(0), { expectedGeneration: moving.generation, destination });
    if (change === 'vector') f.setCopy(n => copy(n, -1));
    if (change === 'override') f.ledger.setOverride(subject(0), { kind: 'tier', tier: 'secure' });
    if (change === 'raiser' || change === 'secrets') {
      const row = f.ledger.getCurrent(subject(0))!;
      f.ledger.recordDecision(subject(0), { ...row, state: 'current', snifferId: judge,
        decidedBy: change === 'secrets' ? 'secret_detector' : 'sniffer',
        contentTier: change === 'secrets' ? 'secrets' : row.contentTier,
        reasons: change === 'raiser' ? [...row.reasons, 'content:own_record:health'] : row.reasons });
    }
    expect(example.current(true)).toBe(change === 'unchanged');
    if (change === 'unchanged') {
      // Accepting placement completion must not waive later decision changes.
      const row = f.ledger.getCurrent(subject(0))!;
      f.ledger.recordDecision(subject(0), { ...row, state: 'current', snifferId: judge,
        decidedBy: 'sniffer', reasons: [...row.reasons, 'content:borderline:financial'] });
      expect(example.current(true)).toBe(false);
    }
  });
