// The privacy-safe sniffer (design docs/design/per-item-four-tier-classification.md,
// section 2.2): lane selection and the standard-cloud refusal, secrets never
// sent, batching, the verdict cache, fail-safe behaviour, the Personal
// confidence threshold, never Public, and the owner-approval gate.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { AnalystModel, AnalystModelRequest } from '../src/core/analyst.ts';
import {
  createSovereigntyEngine,
  loadSovereigntyPreset,
  type SovereigntyConfig,
} from '../src/core/sovereignty.ts';
import {
  appendClassificationLedgerEntry,
  isClassifierApproved,
  readClassificationLedger,
} from '../src/workers/classification-ledger.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import {
  CachedTierSniffer,
  SNIFFER_PROMPT_VERSION,
  parseSnifferBatchResponse,
  snifferTierKey,
} from '../src/workers/classification/sniffer.ts';
import {
  SnifferLaneRefusedError,
  resolveSnifferLane,
  type SnifferLane,
} from '../src/workers/classification/sniffer-lane.ts';
import { SnifferCallBudget, runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { TierSnifferStore, snifferMaterialHash } from '../src/workers/classification/sniffer-store.ts';
import { classifyItemTiers, type TierSnifferRequest } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { SecureAnalystPoolState } from '../src/workers/source-index/analyst-pool.ts';

// Built at runtime so the repository's credential-pattern check never sees a
// literal key in the diff.
const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

const LOCAL_LANE: SnifferLane = {
  kind: 'local',
  modelId: 'fixture-local-sniffer',
  profileId: 'local-sniffer',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-local-sniffer' },
};

/** A spy model: records every prompt, answers with `respond`. */
function spyModel(respond: (request: AnalystModelRequest, items: Array<Record<string, unknown>>) => string | Error): AnalystModel & { requests: AnalystModelRequest[] } {
  const requests: AnalystModelRequest[] = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const items = request.prompt.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);
      const answer = respond(request, items);
      if (answer instanceof Error) throw answer;
      return { text: answer, modelId: LOCAL_LANE.modelId };
    },
  };
}

/** Answers every item with the same verdict. */
function verdictsFor(items: Array<Record<string, unknown>>, verdict: { tier: string; category: string; confidence: number }): string {
  return JSON.stringify({ verdicts: items.map((item) => ({ i: item.i, ...verdict })) });
}

function subject(n: number) {
  return { provider: 'fixture', accountScope: 'personal', providerItemId: `item-${n}` };
}

/** Record a flagged, metadata-only item through the real classifier + cached sniffer. */
function recordFlagged(ledger: TierLedger, store: TierSnifferStore, n: number, title: string): void {
  const sniffer = new CachedTierSniffer(store, LOCAL_LANE);
  const decision = classifyItemTiers({ signals: { title }, subject: subject(n) }, { sniffer });
  ledger.recordDecision(subject(n), decision);
}

describe('lane selection and refusal', () => {
  test('local-first uses the local model; private-cloud-only uses Venice Private', () => {
    expect(resolveSnifferLane(createSovereigntyEngine(loadSovereigntyPreset('local-first')))).toMatchObject({ kind: 'local', profileId: 'local-source-answer' });
    expect(resolveSnifferLane(createSovereigntyEngine(loadSovereigntyPreset('local-only')))).toMatchObject({ kind: 'local' });
    expect(resolveSnifferLane(createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only')))).toMatchObject({ kind: 'venice', profileId: 'venice-private' });
  });

  test('a preset with no private lane refuses with a typed error', () => {
    expect(() => resolveSnifferLane(createSovereigntyEngine(loadSovereigntyPreset('no-sensitive'))))
      .toThrow(SnifferLaneRefusedError);
    try {
      resolveSnifferLane(createSovereigntyEngine(loadSovereigntyPreset('no-sensitive')));
    } catch (error) {
      expect((error as SnifferLaneRefusedError).reason).toBe('no_private_lane');
    }
  });

  test('a classification profile is preferred, and a standard-cloud one is refused outright', () => {
    const config = loadSovereigntyPreset('local-first') as SovereigntyConfig;
    const withLocal = structuredClone(config);
    withLocal.modelProfiles['small-sniffer'] = { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:2/v1', model: 'tiny', purpose: 'classification' };
    expect(resolveSnifferLane(createSovereigntyEngine(withLocal))).toMatchObject({ kind: 'local', profileId: 'small-sniffer', modelId: 'tiny' });

    const withCloud = structuredClone(config);
    withCloud.modelProfiles['cloud-sniffer'] = { provider: 'openclaw-infer', trust: 'standard_cloud', purpose: 'classification' };
    let refusal: unknown;
    try {
      resolveSnifferLane(createSovereigntyEngine(withCloud));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SnifferLaneRefusedError);
    expect((refusal as SnifferLaneRefusedError).reason).toBe('standard_cloud');
  });

  test('a standard-cloud lane is refused before any dispatch', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      recordFlagged(ledger, store, 1, 'therapy notes');
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'personal', category: 'ordinary', confidence: 0.99 }));
      const cloudLane: SnifferLane = { ...LOCAL_LANE, profileId: 'cloud', profile: { provider: 'openclaw-infer', trust: 'standard_cloud' } };
      await expect(runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: cloudLane, model })).rejects.toThrow(SnifferLaneRefusedError);
      expect(model.requests).toHaveLength(0);
      expect(ledger.getCurrent(subject(1))?.state).toBe('pending');
    } finally {
      store.close();
      ledger.close();
    }
  });
});

describe('secrets are never sent', () => {
  test('the classifier never asks the sniffer about an item with a secret in its names or text', () => {
    const asked: TierSnifferRequest[] = [];
    const sniffer = { id: 'spy', judge: (request: TierSnifferRequest) => { asked.push(request); return { verdict: 'undecided' as const }; } };
    classifyItemTiers({ signals: { title: `tax ${FAKE_AWS_KEY}` }, text: 'invoice' }, { sniffer });
    classifyItemTiers({ signals: { title: 'tax return' }, text: `bank ${FAKE_AWS_KEY}` }, { sniffer });
    expect(asked.filter((request) => request.pass === 'content')).toHaveLength(0);
    expect(asked.some((request) => request.material?.includes(FAKE_AWS_KEY))).toBe(false);
  });

  test('a secret in labels is never queued, and queued secret material is dropped unsent', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      const sniffer = new CachedTierSniffer(store, LOCAL_LANE);
      const decision = classifyItemTiers({ signals: { title: 'bank letters', labels: [FAKE_AWS_KEY] }, subject: subject(1) }, { sniffer });
      ledger.recordDecision(subject(1), decision);
      expect(store.counts().questions).toBe(0);

      // A question that somehow carries a secret (written directly) never leaves.
      recordFlagged(ledger, store, 2, 'lab results');
      store.enqueue({ subject: subject(2), pass: 'metadata', material: `lab results ${FAKE_AWS_KEY}`, mapRevision: 'none', flags: ['names:health'] });
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'health', confidence: 0.9 }));
      const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model });
      expect(report.secretRefused).toBe(1);
      expect(model.requests.every((request) => !request.prompt.includes(FAKE_AWS_KEY))).toBe(true);
      expect(store.counts().questions).toBe(0);
    } finally {
      store.close();
      ledger.close();
    }
  });
});

describe('batching, cache and threshold', () => {
  test('250 flagged names take three calls of at most 100 names, with localOnly set', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      for (let n = 0; n < 250; n += 1) recordFlagged(ledger, store, n, `bank statement ${n}`);
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'financial', confidence: 0.97 }));
      const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, maxCallsPerPass: 10 });
      expect(model.requests.map((request) => request.prompt.split('\n').filter((line) => line.startsWith('{')).length)).toEqual([100, 100, 50]);
      expect(model.requests.every((request) => request.localOnly === true)).toBe(true);
      expect(report).toMatchObject({ calls: 3, verdictsApplied: 250, resolvedPrivate: 250 });
      expect(ledger.counts().byState.pending).toBe(250); // content still unread: that is not a sniffer question
      const record = ledger.getCurrent(subject(7))!;
      expect(record.metadataPending).toBe(false);
      expect(record.metadataTier).toBe('secure');
      expect(record.modelId).toBe(LOCAL_LANE.modelId);
      expect(record.reasons).toContain('metadata:sniffer:local:v1:financial:0.97');
      expect(record.reasons.some((reason) => reason.includes('undecided') || reason.includes('possibly_private'))).toBe(false);
      expect(store.counts().questions).toBe(0);
    } finally {
      store.close();
      ledger.close();
    }
  });

  test('identical names are asked once, and a re-sync answers from the cache without asking', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      for (let n = 0; n < 5; n += 1) recordFlagged(ledger, store, n, 'therapy');
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'personal', category: 'ordinary', confidence: 0.95 }));
      const first = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model });
      expect(first).toMatchObject({ calls: 1, itemsAsked: 1, verdictsApplied: 5, resolvedPersonal: 5 });

      // A re-sync of an unchanged item is decided synchronously from the cache.
      const sniffer = new CachedTierSniffer(store, LOCAL_LANE);
      const again = classifyItemTiers({ signals: { title: 'therapy' }, subject: subject(0) }, { sniffer });
      expect(again.metadataPending).toBe(false);
      expect(again.reasons).toContain('metadata:sniffer:local:v1:ordinary:0.95');
      expect(store.counts().questions).toBe(0);

      const second = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model });
      expect(second.calls).toBe(0);
      expect(model.requests).toHaveLength(1);
    } finally {
      store.close();
      ledger.close();
    }
  });

  test('the cache is keyed by model, prompt version and map revision', () => {
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      const key = { materialHash: snifferMaterialHash('metadata', 'x'), modelId: 'm1', promptVersion: 'v1', mapRevision: 'r1' };
      store.putVerdict(key, { tier: 'personal', category: 'ordinary', confidence: 0.95, failSafe: false });
      expect(store.getVerdict(key)).toBeDefined();
      expect(store.getVerdict({ ...key, modelId: 'm2' })).toBeUndefined();
      expect(store.getVerdict({ ...key, promptVersion: 'v2' })).toBeUndefined();
      expect(store.getVerdict({ ...key, mapRevision: 'r2' })).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('Personal needs confidence >= 0.9 and never covers a hard category', () => {
    expect(snifferTierKey({ tier: 'personal', category: 'ordinary', confidence: 0.89 })).toBe('secure');
    expect(snifferTierKey({ tier: 'personal', category: 'ordinary', confidence: 0.9 })).toBe('private');
    for (const category of ['health', 'therapy', 'financial', 'legal', 'identity']) {
      expect(snifferTierKey({ tier: 'personal', category, confidence: 0.99 })).toBe('secure');
    }
    expect(snifferTierKey({ tier: 'private', category: 'ordinary', confidence: 0.1 })).toBe('secure');
  });

  test('never Public: a public verdict, a missing verdict or a repeated one is no verdict', () => {
    const expected = new Set([1, 2, 3]);
    const parsed = parseSnifferBatchResponse(JSON.stringify({ verdicts: [
      { i: 1, tier: 'public', category: 'ordinary', confidence: 0.99 },
      { i: 2, tier: 'personal', category: 'ordinary', confidence: 0.95 },
      { i: 2, tier: 'private', category: 'health', confidence: 0.95 },
      { i: 4, tier: 'personal', category: 'ordinary', confidence: 0.95 },
      { i: 3, tier: 'personal', category: 'made-up', confidence: 0.95 },
    ] }), expected);
    expect(parsed.size).toBe(0);
    expect(parseSnifferBatchResponse('not json', expected).size).toBe(0);
    expect(parseSnifferBatchResponse('```json\n{"verdicts":[{"i":1,"tier":"private","category":"legal","confidence":0.8}]}\n```', expected).get(1)).toEqual({ tier: 'private', category: 'legal', confidence: 0.8 });
  });

  test('an 0.89 Personal answer resolves the item to Private', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      recordFlagged(ledger, store, 1, 'mortgage offer');
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'personal', category: 'ordinary', confidence: 0.89 }));
      await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model });
      expect(ledger.getCurrent(subject(1))).toMatchObject({ metadataTier: 'secure', metadataPending: false });
    } finally {
      store.close();
      ledger.close();
    }
  });
});

describe('fail-safe behaviour', () => {
  test('a transport failure leaves items pending and counts no attempt; two stop the pass', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      for (let n = 0; n < 300; n += 1) recordFlagged(ledger, store, n, `lab results ${n}`);
      const model = spyModel(() => new Error('connection refused'));
      const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model });
      expect(report).toMatchObject({ calls: 2, failedCalls: 2, verdictsApplied: 0, stoppedBy: 'transport_failures' });
      expect(ledger.getCurrent(subject(0))).toMatchObject({ state: 'pending', metadataPending: true });
      expect(store.questionFor(subject(0), 'metadata')?.attempts).toBe(0);
    } finally {
      store.close();
      ledger.close();
    }
  });

  test('an item the model keeps failing to answer resolves to Private after three attempts, and is cached', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      recordFlagged(ledger, store, 1, 'divorce papers');
      const model = spyModel(() => 'I think this is fine.');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model });
        expect(ledger.getCurrent(subject(1))?.metadataPending).toBe(true);
      }
      const third = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model });
      expect(third.failSafePrivate).toBe(1);
      expect(ledger.getCurrent(subject(1))).toMatchObject({ metadataTier: 'secure', metadataPending: false });
      expect(ledger.getCurrent(subject(1))?.reasons).toContain('metadata:sniffer:local:v1:unresolved:0.00');
      const again = classifyItemTiers({ signals: { title: 'divorce papers' }, subject: subject(1) }, { sniffer: new CachedTierSniffer(store, LOCAL_LANE) });
      expect(again.metadataTier).toBe('secure');
    } finally {
      store.close();
      ledger.close();
    }
  });

  test('an unusable sniffer store answers undecided (pending), never a tier', () => {
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    store.close();
    const sniffer = new CachedTierSniffer(store, LOCAL_LANE);
    const decision = classifyItemTiers({ signals: { title: 'bank' }, subject: subject(1) }, { sniffer });
    expect(decision.metadataPending).toBe(true);
    expect(decision.metadataTier).toBe('private');
  });

  test('stale queued material (the item was re-decided or overridden) is dropped', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      recordFlagged(ledger, store, 1, 'passport scan');
      ledger.recordDecision(subject(1), classifyItemTiers({ signals: {} }, { override: { kind: 'tier', tier: 'secure' } }));
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'identity', confidence: 1 }));
      const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model });
      expect(report.staleDropped).toBe(1);
      expect(model.requests).toHaveLength(0);
    } finally {
      store.close();
      ledger.close();
    }
  });

  test('the content excerpt question resolves the content tier only, and only raises', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      const sniffer = new CachedTierSniffer(store, LOCAL_LANE);
      // Pass 1 flags the names; the text is read, so pass 2 asks about an excerpt too.
      const decision = classifyItemTiers({ signals: { title: 'bank' }, text: 'Lunch plans for Saturday at noon.', subject: subject(1) }, { sniffer });
      ledger.recordDecision(subject(1), decision);
      expect(store.counts().byPass).toEqual({ metadata: 1, content: 1 });
      const model = spyModel((request, items) => request.prompt.includes('EXCERPT')
        ? verdictsFor(items, { tier: 'private', category: 'financial', confidence: 0.8 })
        : verdictsFor(items, { tier: 'personal', category: 'ordinary', confidence: 0.96 }));
      await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model });
      const record = ledger.getCurrent(subject(1))!;
      expect(record).toMatchObject({ metadataTier: 'private', contentTier: 'secure', state: 'current', decidedBy: 'sniffer' });
      const excerptPrompt = model.requests.find((request) => request.prompt.includes('EXCERPT'))!;
      expect(excerptPrompt.prompt).toContain('Lunch plans');
    } finally {
      store.close();
      ledger.close();
    }
  });
});

describe('work selection', () => {
  test('many unread pending rows never starve the open questions behind them', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      // 600 unread, unflagged items sort before the flagged one and are pending
      // only because their text has not arrived.
      for (let n = 0; n < 600; n += 1) {
        ledger.recordDecision({ provider: 'a-first', accountScope: 'personal', providerItemId: `unread-${n}` }, classifyItemTiers({ signals: { title: `garden ${n}` } }));
      }
      recordFlagged(ledger, store, 1, 'therapy');
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'therapy', confidence: 0.95 }));
      await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, pendingPageSize: 500 });
      expect(ledger.getCurrent(subject(1))?.metadataPending).toBe(false);
    } finally {
      store.close();
      ledger.close();
    }
  });

  test('names judged Private settle the excerpt question, which is never sent', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      const sniffer = new CachedTierSniffer(store, LOCAL_LANE);
      ledger.recordDecision(subject(1), classifyItemTiers({ signals: { title: 'divorce' }, text: 'Notes for Thursday.', subject: subject(1) }, { sniffer }));
      expect(store.counts().byPass).toEqual({ metadata: 1, content: 1 });
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'legal', confidence: 0.95 }));
      const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model });
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]!.prompt).not.toContain('EXCERPT');
      expect(report.staleDropped).toBe(1);
      expect(ledger.getCurrent(subject(1))).toMatchObject({ contentTier: 'secure', state: 'current' });
    } finally {
      store.close();
      ledger.close();
    }
  });
});

describe('bounds and the owner-approval gate', () => {
  test('the pass stops for the per-pass cap, the daily cap and yield', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      for (let n = 0; n < 300; n += 1) recordFlagged(ledger, store, n, `tax ${n}`);
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'financial', confidence: 0.9 }));
      expect((await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, maxCallsPerPass: 1 })).stoppedBy).toBe('pass_budget');
      const budget = new SnifferCallBudget({ maxCallsPerDay: 1 });
      expect((await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, budget })).stoppedBy).toBe('daily_budget');
      expect((await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, shouldYield: () => true })).stoppedBy).toBe('yield');
      expect(model.requests).toHaveLength(2);
    } finally {
      store.close();
      ledger.close();
    }
  });

  test('a read-only breaker check never half-opens the pool', () => {
    let now = 0;
    const state = new SecureAnalystPoolState({ failureThreshold: 2, cooldownMs: 100, now: () => now });
    state.recordFailure('secure_local', 'local-source-answer');
    expect(state.isBreakerOpen('secure_local', 'local-source-answer')).toBe(false);
    state.recordFailure('secure_local', 'local-source-answer');
    expect(state.isBreakerOpen('secure_local', 'local-source-answer')).toBe(true);
    now = 200;
    expect(state.isBreakerOpen('secure_local', 'local-source-answer')).toBe(false);
  });

  test('the service waits for the owner to approve the exact model and prompt, then runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-sniffer-service-'));
    const installed = new InstalledTierClassification({ env: {}, lane: LOCAL_LANE });
    const ledger = new TierLedger({ dbPath: join(dir, 'store.tier-ledger.sqlite') });
    try {
      const dbPath = join(dir, 'store.sqlite');
      recordFlagged(ledger, installed.snifferStoreForLedger(ledger.dbPath), 1, 'therapy');
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'therapy', confidence: 0.9 }));
      const ledgerPath = join(dir, 'classification-ledger.jsonl');
      const service = new TierSnifferService({
        installed,
        lane: LOCAL_LANE,
        model,
        stores: () => [{ dbPath }],
        classificationLedgerPath: ledgerPath,
      });
      const waiting = await service.runOnce();
      expect(waiting.state).toBe('awaiting_owner_approval');
      expect(model.requests).toHaveLength(0);
      const recorded = await readClassificationLedger(ledgerPath);
      expect(recorded.entries).toHaveLength(1);
      expect(recorded.entries[0]).toMatchObject({ approved_by: 'system-automatic', status: 'pending' });
      expect(isClassifierApproved(recorded.entries, { modelId: LOCAL_LANE.modelId, promptVersion: SNIFFER_PROMPT_VERSION })).toBe(false);
      await service.runOnce();
      expect((await readClassificationLedger(ledgerPath)).entries).toHaveLength(1);

      await appendClassificationLedgerEntry(ledgerPath, {
        recorded_at: new Date(Date.now() + 1_000).toISOString(),
        kind: 'classifier_model_decision',
        what: 'Owner approved the fixture sniffer.',
        model_id: LOCAL_LANE.modelId,
        prompt_version: SNIFFER_PROMPT_VERSION,
        approved_by: 'owner',
        status: 'complete',
      });
      const ran = await service.runOnce();
      expect(ran.state).toBe('ran');
      expect(model.requests).toHaveLength(1);
      expect(ledger.getCurrent(subject(1))?.metadataTier).toBe('secure');
      expect(readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
      service.stop();
    } finally {
      installed.close();
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a revocation or a different prompt version is not an approval', () => {
    const base = { recorded_at: '2026-09-23T10:00:00.000Z', what: 'x', model_id: 'm', prompt_version: 'v1', status: 'complete' as const };
    const approved = { ...base, kind: 'classifier_model_decision' as const, approved_by: 'owner' as const };
    const revoked = { ...base, recorded_at: '2026-09-23T11:00:00.000Z', kind: 'classifier_model_revoked' as const, approved_by: 'owner' as const };
    expect(isClassifierApproved([approved], { modelId: 'm', promptVersion: 'v1' })).toBe(true);
    expect(isClassifierApproved([approved], { modelId: 'm', promptVersion: 'v2' })).toBe(false);
    expect(isClassifierApproved([revoked, approved], { modelId: 'm', promptVersion: 'v1' })).toBe(false);
    expect(isClassifierApproved([{ ...approved, approved_by: 'system-automatic' }], { modelId: 'm', promptVersion: 'v1' })).toBe(false);
  });
});
