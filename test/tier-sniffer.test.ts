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
  snifferId,
  snifferTierKey,
} from '../src/workers/classification/sniffer.ts';
import {
  SnifferLaneRefusedError,
  resolveSnifferLane,
  type SnifferLane,
} from '../src/workers/classification/sniffer-lane.ts';
import { SnifferCallBudget, runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { BUILT_IN_SNIFFER_LANE, resolveTierSnifferRuntime } from '../src/workers/classification/built-in-sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { TierSnifferStore, snifferMaterialHash } from '../src/workers/classification/sniffer-store.ts';
import { classifyItemTiers, type TierSnifferRequest } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { SecureAnalystPoolState } from '../src/workers/source-index/analyst-pool.ts';

// Built at runtime so the repository's credential-pattern check never sees a
// literal key in the diff.
const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const STRUCTURED_METADATA_LABEL = 'SSN 123-45-6789';

function approvalKey(lane: SnifferLane) {
  return { lane: lane.kind, profileId: lane.profileId, modelId: lane.modelId, promptVersion: SNIFFER_PROMPT_VERSION };
}

const VENICE_LANE: SnifferLane = {
  kind: 'venice',
  modelId: 'fixture-venice-sniffer',
  profileId: 'venice-sniffer',
  profile: { provider: 'venice', trust: 'encrypted_cloud', model: 'fixture-venice-sniffer' },
};

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
  return JSON.stringify({ verdicts: items.map((item) => ({ i: item.i, ownRecord: ['health', 'therapy', 'financial', 'legal', 'identity'].includes(verdict.category), privateKind: ['health', 'therapy', 'financial', 'legal', 'identity'].includes(verdict.category) ? verdict.category : 'none', ...verdict })) });
}

function subject(n: number) {
  return { provider: 'fixture', accountScope: 'personal', providerItemId: `item-${n}` };
}

/** Record a flagged, metadata-only item through the real classifier + cached sniffer. */
function recordFlagged(ledger: TierLedger, store: TierSnifferStore, n: number, title: string): void {
  const sniffer = new CachedTierSniffer(store, LOCAL_LANE);
  const decision = classifyItemTiers({ signals: { title, labels: [STRUCTURED_METADATA_LABEL] }, subject: subject(n) }, { sniffer });
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
      expect(decision).toMatchObject({ metadataTier: 'secrets', contentTier: 'secrets', state: 'current', metadataPending: false, contentPending: false });
      expect(store.counts().questions).toBe(0);

      // A question that somehow carries a secret (written directly) never leaves.
      recordFlagged(ledger, store, 2, 'lab results');
      store.enqueue({ subject: subject(2), pass: 'metadata', material: `lab results ${FAKE_AWS_KEY}`, mapRevision: 'none', flags: ['names:health'] });
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'health', confidence: 0.9 }));
      const report = await runSnifferPass({ targets: [{ ledger, sniffer: store, settleSecrets(question, decision) {
        ledger.recordDecision(question, decision); return true;
      } }], lane: LOCAL_LANE, model });
      expect(report.secretRefused).toBe(1);
      for (const n of [1, 2]) expect(ledger.getCurrent(subject(n))).toMatchObject({ state: 'current', contentTier: 'secrets', metadataPending: false, contentPending: false });
      expect(model.requests.every((request) => !request.prompt.includes(FAKE_AWS_KEY))).toBe(true);
      expect(store.counts().questions).toBe(0);
    } finally {
      store.close();
      ledger.close();
    }
  });
});

describe('batching, cache and threshold', () => {
  test('every flagged name is asked on its own call, with localOnly set', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      for (let n = 0; n < 25; n += 1) recordFlagged(ledger, store, n, `bank statement ${n}`);
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'financial', confidence: 0.97 }));
      const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: VENICE_LANE, model, maxCallsPerPass: 100 });
      expect(model.requests.map((request) => request.prompt.split('\n').filter((line) => line.startsWith('{')).length)).toEqual(Array(25).fill(1));
      expect(model.requests.every((request) => request.localOnly === true)).toBe(true);
      expect(report).toMatchObject({ calls: 25, verdictsApplied: 25, resolvedPrivate: 25 });
      expect(ledger.counts().byState.pending).toBe(25); // content still unread: that is not a sniffer question
      const record = ledger.getCurrent(subject(7))!;
      expect(record.metadataPending).toBe(false);
      expect(record.metadataTier).toBe('secure');
      expect(record.modelId).toBe(VENICE_LANE.modelId);
      expect(record.reasons).toContain(`metadata:sniffer:${snifferId(VENICE_LANE)}:financial:0.97`);
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
      const again = classifyItemTiers({ signals: { title: 'therapy', labels: [STRUCTURED_METADATA_LABEL] }, subject: subject(0) }, { sniffer });
      expect(again.metadataPending).toBe(false);
      expect(again.reasons).toContain(`metadata:sniffer:${snifferId(LOCAL_LANE)}:ordinary:0.95`);
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

  test('Personal needs confidence >= 0.9; topic alone does not override it', () => {
    expect(snifferTierKey({ tier: 'personal', category: 'ordinary', confidence: 0.89 })).toBe('secure');
    expect(snifferTierKey({ tier: 'personal', category: 'ordinary', confidence: 0.9 })).toBe('private');
    for (const category of ['health', 'therapy', 'financial', 'legal', 'identity']) {
      expect(snifferTierKey({ tier: 'personal', category, confidence: 0.99 })).toBe('private');
    }
    expect(snifferTierKey({ tier: 'private', category: 'ordinary', confidence: 0.1 })).toBe('secure');
  });

  test('a Private verdict stays Private regardless of topic', () => {
    // A work topic cannot release a private record or owner-protected work matter.
    for (const category of ['work', 'reference', 'ordinary']) {
      expect(snifferTierKey({ tier: 'private', category, confidence: 0.95 })).toBe('secure');
    }
    for (const category of ['other', 'intimate', 'family', 'health', 'financial']) {
      expect(snifferTierKey({ tier: 'private', category, confidence: 0.95 })).toBe('secure');
    }
    expect(snifferTierKey({ tier: 'private', category: 'work', confidence: 0.95, failSafe: true })).toBe('secure');
    expect(snifferTierKey({ tier: 'personal', category: 'ordinary', confidence: 0.95, failSafe: true })).toBe('secure');
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
    expect(parseSnifferBatchResponse('```json\n{"verdicts":[{"i":1,"tier":"private","category":"legal","confidence":0.8}]}\n```', expected).get(1)).toMatchObject({ tier: 'private', category: 'legal', confidence: 0.8 });
  });

  test('a Private answer in the model\'s own words is kept; a Personal one is not', () => {
    const expected = new Set([1, 2, 3]);
    const parsed = parseSnifferBatchResponse(JSON.stringify({ verdicts: [
      { i: 1, tier: 'private', category: 'insurance', confidence: 0.95 },
      { i: 2, tier: 'private', category: 'spiritual', confidence: 0.95 },
      { i: 3, tier: 'personal', category: 'spiritual', confidence: 0.95 },
    ] }), expected);
    expect(parsed.get(1)).toMatchObject({ tier: 'private', category: 'financial', confidence: 0.95 });
    expect(parsed.get(2)).toMatchObject({ tier: 'private', category: 'other', confidence: 0.95 });
    expect(parsed.has(3)).toBe(false);
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
      expect(ledger.getCurrent(subject(1))?.reasons).toContain(`metadata:sniffer:${snifferId(LOCAL_LANE)}:unresolved:0.00`);
      const again = classifyItemTiers({ signals: { title: 'divorce papers', labels: [STRUCTURED_METADATA_LABEL] }, subject: subject(1) }, { sniffer: new CachedTierSniffer(store, LOCAL_LANE) });
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
    const decision = classifyItemTiers({ signals: { title: 'bank', labels: [STRUCTURED_METADATA_LABEL] }, subject: subject(1) }, { sniffer });
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
      const decision = classifyItemTiers({ signals: { title: 'bank', labels: [STRUCTURED_METADATA_LABEL] }, text: 'Lunch plans for Saturday at noon.', subject: subject(1) }, { sniffer });
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
      ledger.recordDecision(subject(1), classifyItemTiers({ signals: { title: 'divorce', labels: [STRUCTURED_METADATA_LABEL] }, text: 'Notes for Thursday.', subject: subject(1) }, { sniffer }));
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
      expect(isClassifierApproved(recorded.entries, approvalKey(LOCAL_LANE))).toBe(false);
      await service.runOnce();
      expect((await readClassificationLedger(ledgerPath)).entries).toHaveLength(1);

      await appendClassificationLedgerEntry(ledgerPath, {
        recorded_at: new Date(Date.now() + 1_000).toISOString(),
        kind: 'classifier_model_decision',
        what: 'Owner approved the fixture sniffer.',
        model_id: LOCAL_LANE.modelId,
        prompt_version: SNIFFER_PROMPT_VERSION,
        lane: LOCAL_LANE.kind,
        profile_id: LOCAL_LANE.profileId,
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

  test('a queue that waits says why, once per change, and a pass that never ends is stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-sniffer-waiting-'));
    const installed = new InstalledTierClassification({ env: {}, lane: LOCAL_LANE });
    const ledger = new TierLedger({ dbPath: join(dir, 'store.tier-ledger.sqlite') });
    try {
      recordFlagged(ledger, installed.snifferStoreForLedger(ledger.dbPath), 1, 'therapy');
      const ledgerPath = join(dir, 'classification-ledger.jsonl');
      await appendClassificationLedgerEntry(ledgerPath, {
        recorded_at: new Date().toISOString(), kind: 'classifier_model_decision', what: 'Owner approved the fixture sniffer.',
        model_id: LOCAL_LANE.modelId, prompt_version: SNIFFER_PROMPT_VERSION, lane: LOCAL_LANE.kind, profile_id: LOCAL_LANE.profileId,
        approved_by: 'owner', status: 'complete',
      });
      const lines: string[] = [];
      let busy = true;
      let clock = 0;
      let release: (() => void) | undefined;
      let callStarted: () => void = () => {};
      const inCall = new Promise<void>((resolve) => { callStarted = resolve; });
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'therapy', confidence: 0.9 }));
      const service = new TierSnifferService({
        installed,
        lane: LOCAL_LANE,
        model,
        stores: () => [{ dbPath: join(dir, 'store.sqlite') }],
        classificationLedgerPath: ledgerPath,
        shouldYield: () => busy,
        log: (line) => lines.push(line),
        now: () => new Date(clock),
        maxPassMs: 60_000,
      });
      // Yielding: said once, not on every tick.
      await service.runOnce();
      await service.runOnce();
      expect(lines.filter((line) => line.includes('nothing asked: yielding'))).toHaveLength(1);
      // Asking again is said once too.
      busy = false;
      await service.runOnce();
      expect(lines).toContain('Olympus tier sniffer: asking again.');

      // A pass whose model call never returns: the next tick past the bound aborts it.
      recordFlagged(ledger, installed.snifferStoreForLedger(ledger.dbPath), 2, 'divorce papers');
      const hanging = new TierSnifferService({
        installed,
        lane: LOCAL_LANE,
        model: {
          async complete(request) {
            callStarted();
            await new Promise<void>((resolve) => {
              release = resolve;
              if (request.signal?.aborted) resolve();
              request.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            throw new Error('aborted');
          },
        },
        stores: () => [{ dbPath: join(dir, 'store.sqlite') }],
        classificationLedgerPath: ledgerPath,
        log: (line) => lines.push(line),
        now: () => new Date(clock),
        maxPassMs: 60_000,
      });
      const first = hanging.runOnce();
      // The stop must land while the model call is in flight: an abort that
      // reaches the pass before its first dispatch stops it as 'aborted'.
      await inCall;
      expect((await hanging.runOnce()).state).toBe('skipped_running');
      clock += 61_000;
      expect((await hanging.runOnce()).state).toBe('skipped_running');
      expect(lines.some((line) => line.includes('without finishing; it was stopped'))).toBe(true);
      // The stopped pass settles as preempted (nothing counted against the
      // items), so the next tick can run a fresh one.
      expect(await first).toMatchObject({ state: 'ran', report: { stoppedBy: 'preempted' } });
      release?.();
      service.stop();
      hanging.stop();
    } finally {
      installed.close();
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a pass that ignores its abort is abandoned, and each waiting reason is named in the status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-sniffer-heal-'));
    const installed = new InstalledTierClassification({ env: {}, lane: LOCAL_LANE });
    const ledger = new TierLedger({ dbPath: join(dir, 'store.tier-ledger.sqlite') });
    try {
      recordFlagged(ledger, installed.snifferStoreForLedger(ledger.dbPath), 1, 'therapy');
      const ledgerPath = join(dir, 'classification-ledger.jsonl');
      await appendClassificationLedgerEntry(ledgerPath, {
        recorded_at: new Date().toISOString(), kind: 'classifier_model_decision', what: 'Owner approved the fixture sniffer.',
        model_id: LOCAL_LANE.modelId, prompt_version: SNIFFER_PROMPT_VERSION, lane: LOCAL_LANE.kind, profile_id: LOCAL_LANE.profileId,
        approved_by: 'owner', status: 'complete',
      });
      const lines: string[] = [];
      let clock = 0;
      let calls = 0;
      let callStarted: () => void = () => {};
      const inCall = new Promise<void>((resolve) => { callStarted = resolve; });
      const answering = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'therapy', confidence: 0.9 }));
      const service = new TierSnifferService({
        installed,
        lane: LOCAL_LANE,
        model: {
          // The first call never settles and ignores its signal; later calls answer.
          complete(request) {
            calls += 1;
            if (calls === 1) callStarted();
            return calls === 1 ? new Promise(() => {}) : answering.complete(request);
          },
        },
        stores: () => [{ dbPath: join(dir, 'store.sqlite') }],
        classificationLedgerPath: ledgerPath,
        log: (line) => lines.push(line),
        now: () => new Date(clock),
        maxPassMs: 60_000,
        abandonAfterMs: 30_000,
      });
      void service.runOnce();
      await inCall;
      expect((await service.runOnce()).state).toBe('skipped_running');
      expect(service.status().waiting?.reason).toBe('pass_running');
      clock += 61_000;
      expect((await service.runOnce()).state).toBe('skipped_running');
      expect(service.status().waiting?.reason).toBe('pass_stuck');
      expect(service.backlog().summary).toContain('Nothing asked now: a pass ran too long and was stopped.');
      // The aborted call never settles: still held off inside the grace...
      clock += 10_000;
      expect((await service.runOnce()).state).toBe('skipped_running');
      // ...and abandoned past it: this tick runs a fresh pass that asks.
      clock += 30_000;
      const fresh = await service.runOnce();
      expect(fresh).toMatchObject({ state: 'ran', report: { calls: 1 } });
      expect(lines.some((line) => line.includes('was abandoned and a new pass starts'))).toBe(true);
      expect(service.status().waiting).toBeUndefined();
      service.stop();

      // Breaker, answers and no model are told apart, content-free.
      recordFlagged(ledger, installed.snifferStoreForLedger(ledger.dbPath), 2, 'divorce papers');
      let breaker = true;
      let answers = false;
      let available = true;
      const reasons = new TierSnifferService({
        installed,
        lane: LOCAL_LANE,
        model: answering,
        stores: () => [{ dbPath: join(dir, 'store.sqlite') }],
        classificationLedgerPath: ledgerPath,
        breakerOpen: () => breaker,
        answersInFlight: () => answers,
        modelAvailable: () => available,
        modelState: () => 'failed',
        log: (line) => lines.push(line),
      });
      await reasons.runOnce();
      expect(reasons.status().waiting?.reason).toBe('breaker_open');
      expect(lines).toContain('Olympus tier sniffer: questions are waiting, nothing asked: the private model is resting after failures.');
      breaker = false;
      answers = true;
      await reasons.runOnce();
      expect(reasons.backlog().waiting?.reason).toBe('yielding_to_answers');
      answers = false;
      available = false;
      await reasons.runOnce();
      expect(reasons.status().waiting).toMatchObject({ reason: 'no_model', label: 'the private model is not available (failed)' });
      available = true;
      expect(await reasons.runOnce()).toMatchObject({ state: 'ran', report: { calls: 1 } });
      expect(reasons.status().waiting).toBeUndefined();
      reasons.stop();
    } finally {
      installed.close();
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an approval names lane, profile, model and prompt version: changing any one needs a new approval', () => {
    const base = { recorded_at: '2026-09-23T10:00:00.000Z', what: 'x', model_id: 'm', prompt_version: 'p1', lane: 'local', profile_id: 'local-a', status: 'complete' as const };
    const approved = { ...base, kind: 'classifier_model_decision' as const, approved_by: 'owner' as const };
    const revoked = { ...base, recorded_at: '2026-09-23T11:00:00.000Z', kind: 'classifier_model_revoked' as const, approved_by: 'owner' as const };
    const key = { lane: 'local', profileId: 'local-a', modelId: 'm', promptVersion: 'p1' };
    expect(isClassifierApproved([approved], key)).toBe(true);
    expect(isClassifierApproved([approved], { ...key, promptVersion: 'p2' })).toBe(false);
    // The same model id reached through Venice, or another profile, is another decision.
    expect(isClassifierApproved([approved], { ...key, lane: 'venice' })).toBe(false);
    expect(isClassifierApproved([approved], { ...key, profileId: 'local-b' })).toBe(false);
    expect(isClassifierApproved([revoked, approved], key)).toBe(false);
    expect(isClassifierApproved([{ ...approved, approved_by: 'system-automatic' }], key)).toBe(false);
  });

  test('the prompt version is derived from the prompt text, so an edit is a new version', () => {
    expect(SNIFFER_PROMPT_VERSION).toMatch(/^p-[0-9a-f]{12}$/);
    expect(snifferId(LOCAL_LANE)).toStartWith(`local:${SNIFFER_PROMPT_VERSION}.m`);
  });
});

describe('vocabulary-only detector hits (owner ruling 2026-10-01)', () => {
  const FILLER = 'The integral approach maps quadrants and levels of development across many fields of human inquiry, from art and ethics to ecology. '
    .repeat(12);
  const BOOK = `${FILLER}In medicine, a purely physical treatment of symptoms ignores the interior quadrants of meaning and culture. ${FILLER}`;

  async function judgedAs(verdict: { tier: string; category: string; confidence: number }) {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      const sniffer = new CachedTierSniffer(store, LOCAL_LANE);
      const decision = classifyItemTiers({
        signals: { title: 'Introduction to the Integral Approach.pdf' },
        text: BOOK,
        subject: subject(1),
      }, { sniffer });
      ledger.recordDecision(subject(1), decision);
      // Personal-first: usable while the content question waits; topic words do not hold it.
      expect(ledger.getCurrent(subject(1))).toMatchObject({ state: 'pending', contentPending: true, contentTier: 'private', metadataFlagged: false });
      expect(ledger.getCurrent(subject(1))?.reasons).toContain('content:personal_first');
      expect(store.counts().byPass).toEqual({ metadata: 0, content: 1 });
      const model = spyModel((_, items) => verdictsFor(items, verdict));
      const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model });
      expect(report.verdictsApplied).toBe(1);
      expect(model.requests[0]!.prompt).toContain('physical treatment of symptoms');
      return ledger.getCurrent(subject(1))!;
    } finally {
      store.close();
      ledger.close();
    }
  }

  test('the local model calling it ordinary work makes it Personal', async () => {
    const record = await judgedAs({ tier: 'personal', category: 'work', confidence: 0.95 });
    expect(record).toMatchObject({ state: 'current', contentTier: 'private', contentPending: false });
  });

  test('an own health record stays Private even when the model pairs it with personal', async () => {
    const record = await judgedAs({ tier: 'personal', category: 'health', confidence: 0.95 });
    expect(record).toMatchObject({ state: 'current', contentTier: 'secure', decidedBy: 'sniffer' });
  });
});


describe('recent questions and bounded passes', () => {
  test('a new item overtakes an old backlog, with priority first', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      for (let n = 1; n <= 12; n++) recordFlagged(ledger, store, n, `bank letter ${n}`);
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'other', confidence: 1 }));
      await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, maxCallsPerPass: 1 });
      expect(model.requests[0]!.prompt).toContain('bank letter 12');
      store.enqueue({ subject: subject(1), pass: 'metadata', material: 'bank urgent', flags: [], mapRevision: 'none', priority: 20 });
      await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, maxCallsPerPass: 1 });
      expect(model.requests[1]!.prompt).toContain('bank urgent');
    } finally { store.close(); ledger.close(); }
  });

  test('old questions progress despite a stream of newer high priority arrivals', async () => {
    let clock = new Date('2026-01-01T00:00:00Z');
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:', now: () => clock });
    try {
      recordFlagged(ledger, store, 1, 'bank oldest');
      clock = new Date('2026-01-01T02:00:00Z');
      const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'other', confidence: 1 }));
      for (let n = 2; n <= 7; n++) {
        recordFlagged(ledger, store, n, `bank newer ${n}`);
        store.enqueue({ subject: subject(n), pass: 'metadata', material: `bank newer ${n}`, flags: [], mapRevision: 'none', priority: 10 });
        await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, maxCallsPerPass: 1 });
      }
      expect(model.requests[0]!.prompt).toContain('bank newer 2');
      expect(model.requests.some(r => r.prompt.includes('bank oldest'))).toBe(true);
    } finally { store.close(); ledger.close(); }
  });

  test('time bounds a pass instead of the old ten-call default, and reports call and wait time', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      for (let n = 1; n <= 15; n++) recordFlagged(ledger, store, n, `bank timing ${n}`);
      let elapsed = 0;
      const model = spyModel((_, items) => { elapsed += 100; return verdictsFor(items, { tier: 'private', category: 'other', confidence: 1 }); });
      const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, passTimeMs: 1200, monotonicNow: () => elapsed });
      expect(report.calls).toBe(12);
      expect(report.stoppedBy).toBe('pass_budget');
      expect(report.callMs).toBe(1200);
      expect(report.maxQueueWaitMs).toBeGreaterThanOrEqual(0);
    } finally { store.close(); ledger.close(); }
  });
});

test('aging also serves a quiet store while another store receives priority work', async () => {
  let clock = new Date('2026-01-01T00:00:00Z');
  const ledgers = [new TierLedger({ dbPath: ':memory:' }), new TierLedger({ dbPath: ':memory:' })];
  const stores = [new TierSnifferStore({ dbPath: ':memory:', now: () => clock }), new TierSnifferStore({ dbPath: ':memory:', now: () => clock })];
  try {
    recordFlagged(ledgers[0]!, stores[0]!, 1, 'bank quiet oldest');
    clock = new Date('2026-01-01T02:00:00Z');
    const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'other', confidence: 1 }));
    for (let n = 2; n <= 7; n++) {
      recordFlagged(ledgers[1]!, stores[1]!, n, `bank busy ${n}`);
      stores[1]!.enqueue({ subject: subject(n), pass: 'metadata', material: `bank busy ${n}`, flags: [], mapRevision: 'none', priority: 10 });
      await runSnifferPass({ targets: ledgers.map((ledger, i) => ({ ledger, sniffer: stores[i]! })), lane: LOCAL_LANE, model, maxCallsPerPass: 1 });
    }
    expect(model.requests.some(r => r.prompt.includes('bank quiet oldest'))).toBe(true);
  } finally { stores.forEach(s => s.close()); ledgers.forEach(l => l.close()); }
});

test('independent move drain failures are contained and retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sniffer-move-retry-'));
  const installed = new InstalledTierClassification({ env: {} });
  const lines: string[] = [];
  let attempts = 0;
  const service = new TierSnifferService({
    installed, lane: LOCAL_LANE, model: spyModel(() => ''), stores: () => [],
    classificationLedgerPath: join(dir, 'classification.jsonl'),
    modelAvailable: () => false, intervalMs: 5,
    log: line => lines.push(line),
    autoMoves: { embeddingLedgerPath: join(dir, 'embedding.jsonl'), localEmbeddingsOnly: () => {
      attempts++;
      if (attempts <= 2) throw new Error('synthetic failure');
      return true;
    } },
  });
  try {
    service.start();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(attempts).toBeGreaterThan(2);
    expect(lines.some(line => line.includes('move drain failed (Error)'))).toBe(true);
  } finally { service.stop(); installed.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('completed passes continue without waiting for the idle timer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sniffer-continuation-'));
  const storePath = join(dir, 'items.sqlite');
  const ledgerPath = `${storePath}.tier-ledger.sqlite`;
  const ledger = new TierLedger({ dbPath: ledgerPath });
  const installed = new InstalledTierClassification({ env: {}, lane: LOCAL_LANE });
  const queue = installed.snifferStoreForLedger(ledgerPath);
  let calls = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const model = spyModel((_, items) => {
    if (++calls === 12) resolveDone();
    return verdictsFor(items, { tier: 'private', category: 'other', confidence: 1 });
  });
  const classificationLedgerPath = join(dir, 'classification.jsonl');
  await appendClassificationLedgerEntry(classificationLedgerPath, {
    recorded_at: new Date().toISOString(), kind: 'classifier_model_decision', what: 'Synthetic fixture approval',
    approved_by: 'owner', status: 'complete', model_id: LOCAL_LANE.modelId, lane: LOCAL_LANE.kind,
    profile_id: LOCAL_LANE.profileId, prompt_version: SNIFFER_PROMPT_VERSION,
  });
  const service = new TierSnifferService({ installed, lane: LOCAL_LANE, model,
    stores: () => [{ dbPath: storePath, tierSetBinding: () => ({ ledgerPath }) }], classificationLedgerPath,
    intervalMs: 60_000, maxCallsPerPass: 1,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let n = 1; n <= 12; n++) recordFlagged(ledger, queue, n, `bank continuation ${n}`);
    service.start();
    await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('idle timer stalled work')), 2_000); })]);
    expect(calls).toBe(12);
    // Allow the final model result to settle before closing the fixture.
    await new Promise(resolve => setTimeout(resolve, 5));
  } finally { if (timeout) clearTimeout(timeout); service.stop(); installed.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const pass of ['metadata', 'content'] as const) {
  test(`a superseded ${pass} answer cannot settle or delete the newer question`, async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      const sniffer = new CachedTierSniffer(store, LOCAL_LANE);
      const classify = (version: string) => {
        const decision = classifyItemTiers({
          signals: { title: pass === 'metadata' ? `SSN 123-45-6789 ${version}` : 'Record' },
          ...(pass === 'content' ? { text: `Patient name: Morgan Example. ${version}` } : {}),
          subject: subject(1),
        }, { sniffer });
        ledger.recordDecision(subject(1), decision);
      };
      classify('old');
      const model = spyModel((_, items) => {
        classify('new private record');
        return verdictsFor(items, { tier: 'personal', category: 'ordinary', confidence: 1 });
      });
      const result = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, maxCallsPerPass: 1 });
      expect(result.verdictsApplied).toBe(0);
      expect(ledger.getCurrent(subject(1))?.[pass === 'metadata' ? 'metadataPending' : 'contentPending']).toBe(true);
      expect(store.questionFor(subject(1), pass)?.material).toContain('new private record');
      const currentModel = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'health', confidence: 1 }));
      await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model: currentModel });
      expect(currentModel.requests[0]!.prompt).toContain('new private record');
      expect(ledger.getCurrent(subject(1))?.[pass === 'metadata' ? 'metadataTier' : 'contentTier']).toBe('secure');
    } finally { store.close(); ledger.close(); }
  });
}

test('a model revision changes cache and rejudge identity but preserves approval identity', async () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  try {
    const first = { ...LOCAL_LANE, modelId: 'built_in', cacheModelId: 'weights-sha256-a' };
    const second = { ...first, cacheModelId: 'weights-sha256-b' };
    const material = 'Ordinary reminder';
    store.putVerdict({ materialHash: snifferMaterialHash('content', material), modelId: first.cacheModelId, promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' },
      { tier: 'personal', category: 'ordinary', confidence: 1, failSafe: false });
    expect(new CachedTierSniffer(store, first).judge({ pass: 'content', material, flags: [] })).toMatchObject({ verdict: 'decided', tier: 'private' });
    expect(new CachedTierSniffer(store, second).judge({ pass: 'content', material, flags: [] })).toEqual({ verdict: 'undecided' });
    expect(new CachedTierSniffer(store, second).id).not.toBe(new CachedTierSniffer(store, first).id);
    // The stable approval key remains unchanged across a weights update.
    expect(approvalKey(second)).toEqual(approvalKey(first));
    ledger.recordDecision(subject(1), { ...classifyItemTiers({ signals: {}, text: material }), contentPending: true, state: 'pending' });
    store.enqueue({ subject: subject(1), pass: 'content', material, flags: [], mapRevision: 'none' });
    const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'other', confidence: 1 }));
    const result = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: second, model });
    expect(result).toMatchObject({ calls: 1, cacheHits: 0, resolvedPrivate: 1 });
    expect(new CachedTierSniffer(store, second).judge({ pass: 'content', material, flags: [] })).toMatchObject({ verdict: 'decided', tier: 'secure' });
  } finally { store.close(); ledger.close(); }
});


test('a built-in weights change cannot bypass an owner revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sniffer-revision-'));
  const installed = new InstalledTierClassification({ env: { OLYMPUS_TIER_RULES_PATH: join(dir, 'rules.json') } });
  const model = spyModel(() => { throw new Error('revoked model must never run'); });
  const ledgerPath = join(dir, 'approval.jsonl');
  try {
    await appendClassificationLedgerEntry(ledgerPath, {
      recorded_at: new Date().toISOString(), kind: 'classifier_model_revoked', what: 'Owner declines local classification.',
      model_id: 'built_in', lane: 'local', profile_id: 'built_in', prompt_version: 'older-prompt', approved_by: 'owner', status: 'complete',
    });
    for (const cacheModelId of ['model-a:revision-a:hash-a', 'model-b:revision-b:hash-b']) {
      const runtime = resolveTierSnifferRuntime({ engine: createSovereigntyEngine(loadSovereigntyPreset('no-sensitive')),
        builtIn: { model, available: () => true, cacheModelId } });
      expect(runtime.source).toBe('built_in');
      if (runtime.source !== 'built_in') throw new Error('missing built-in');
      expect(runtime.lane).toMatchObject({ modelId: 'built_in', cacheModelId });
      const service = new TierSnifferService({ installed, lane: runtime.lane, model, stores: () => [], classificationLedgerPath: ledgerPath, autoApproveBuiltIn: true });
      try { expect(await service.runOnce()).toMatchObject({ state: 'awaiting_owner_approval', modelId: 'built_in' }); }
      finally { service.stop(); }
    }
    expect(model.requests).toHaveLength(0);
  } finally { installed.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a changed document tail invalidates an in-flight answer even when its excerpt is unchanged', async () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  try {
    const sniffer = new CachedTierSniffer(store, LOCAL_LANE);
    const classify = (suffix: string) => {
      const decision = classifyItemTiers({ signals: { title: 'Record' },
        text: `Patient name: Morgan Example. ${'Ordinary detail. '.repeat(300)}${suffix}`, subject: subject(1) }, { sniffer });
      ledger.recordDecision(subject(1), decision);
    };
    classify('Revision A.');
    const first = store.questionFor(subject(1), 'content')!;
    const model = spyModel((_, items) => {
      classify('Revision B.');
      return verdictsFor(items, { tier: 'personal', category: 'ordinary', confidence: 1 });
    });
    const result = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, maxCallsPerPass: 1 });
    const next = store.questionFor(subject(1), 'content')!;
    expect(next.material).toBe(first.material);
    expect(next.materialHash).not.toBe(first.materialHash);
    expect(result.verdictsApplied).toBe(0);
    classify('Revision B.'); // The cached old answer cannot settle the new input either.
    expect(ledger.getCurrent(subject(1))).toMatchObject({ state: 'pending', contentPending: true });
  } finally { store.close(); ledger.close(); }
});


test('encoded credential URLs are refused both before queueing and before model dispatch', async () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  const material = 'Open https://example.test/?%61ccess%5F%74oken=synthetic-credential';
  try {
    const sniffer = new CachedTierSniffer(store, LOCAL_LANE);
    expect(sniffer.judge({ pass: 'content', subject: subject(1), material, flags: [], mapRevision: 'none' }))
      .toMatchObject({ verdict: 'decided', tier: 'secrets' });
    expect(store.counts().questions).toBe(0);
    recordFlagged(ledger, store, 2, 'bank letter');
    store.enqueue({ subject: subject(2), pass: 'metadata', material, flags: [], mapRevision: 'none' });
    const model = spyModel(() => { throw new Error('must not dispatch'); });
    let settled = 0;
    const report = await runSnifferPass({ targets: [{ ledger, sniffer: store, settleSecrets(question, decision) {
      settled++; ledger.recordDecision(question, decision); return true;
    } }], lane: LOCAL_LANE, model });
    expect(report.secretRefused).toBe(1);
    expect(settled).toBe(1);
    expect(model.requests).toEqual([]);
    expect(store.counts().questions).toBe(0);
  } finally { store.close(); ledger.close(); }
});

test('aging skips blocked moves on both sides of the oldest eligible question', async () => {
  let clock = new Date('2026-01-01T00:00:00Z');
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new TierSnifferStore({ dbPath: ':memory:', now: () => clock });
  try {
    for (let n = 1; n <= 8; n++) {
      recordFlagged(ledger, store, n, `bank age candidate ${n}`);
      if (n !== 2 && n !== 7) ledger.beginMove(subject(n), { metadataTier: 'secure', contentTier: 'secure' }, ledger.getCurrent(subject(n))!.generation);
      clock = new Date(clock.getTime() + 1000);
    }
    clock = new Date('2026-01-01T02:00:00Z');
    for (let i = 0; i < 4; i++) store.recordDispatch();
    const model = spyModel((_, items) => verdictsFor(items, { tier: 'private', category: 'other', confidence: 1 }));
    await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LOCAL_LANE, model, pendingPageSize: 1, maxCallsPerPass: 1 });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.prompt).toContain('bank age candidate 2');
    expect(store.questionFor(subject(1), 'metadata')).toBeDefined();
    expect(store.questionFor(subject(8), 'metadata')).toBeDefined();
  } finally { store.close(); ledger.close(); }
});
