// Every judge leans Private (#1184): a decision judge's P(Private) bar is per
// lane, and it is applied when a stored verdict is read, so a new bar re-tiers
// already-judged items with no new judge call.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { SNIFFER_DECISION_PRIVATE_BAR } from '../src/workers/classification/sniffer-decision-mass.ts';
import {
  snifferCacheModelId,
  snifferDecisionBar,
  snifferDecisionPrivateChance,
  snifferId,
  snifferTierKey,
  snifferVerdictTier,
  QWEN36_35B_A3B_SNIFFER_MODEL,
  type SnifferLaneIdentity,
} from '../src/workers/classification/sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { resolveSnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { createSovereigntyEngine, loadSovereigntyPreset, validateSovereigntyConfig } from '../src/core/sovereignty.ts';
import { BUILT_IN_REASONING_MODELS, QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const weights = `${QWEN35_4B.modelId}:${QWEN35_4B.revision}:${QWEN35_4B.file.sha256}`;
const builtIn4B = { ...BUILT_IN_SNIFFER_LANE, snifferMode: 'decision' as const, cacheModelId: weights };
const configured4B: SnifferLaneIdentity = { kind: 'local', modelId: QWEN35_4B.modelId, snifferMode: 'decision' };
const otherJudge: SnifferLaneIdentity = { kind: 'local', modelId: 'delphi-35b', snifferMode: 'decision' };
/** A decision verdict as the transport stores it at a 0.5 bar. */
const stored = (chance: number) => chance >= 0.5
  ? { tier: 'private' as const, category: 'decision', confidence: chance, failSafe: false }
  : { tier: 'personal' as const, category: 'decision', confidence: 1 - chance, failSafe: false };

test('the decision bar is per lane: the built-in 4B at 0.15, every other judge at 0.5', () => {
  expect(snifferDecisionBar(builtIn4B)).toBe(0.15);
  expect(snifferDecisionBar(configured4B)).toBe(0.15);
  expect(snifferDecisionBar(otherJudge)).toBe(SNIFFER_DECISION_PRIVATE_BAR);
  expect(snifferDecisionBar({ kind: 'venice', modelId: 'venice-model' })).toBe(0.5);
  for (const model of BUILT_IN_REASONING_MODELS.filter(m => m.modelId !== QWEN35_4B.modelId)) {
    expect(snifferDecisionBar({ ...builtIn4B, cacheModelId: `${model.modelId}:${model.revision}` })).toBe(0.5);
  }
  // A name that merely starts like the 4B is another model.
  expect(snifferDecisionBar({ ...configured4B, modelId: `${QWEN35_4B.modelId}-finetune` })).toBe(0.5);
  // A lane's own bar wins, but never leans Personal (above an even chance) or is unusable.
  expect(snifferDecisionBar({ ...otherJudge, decisionBar: 0.3 })).toBe(0.3);
  expect(snifferDecisionBar({ ...builtIn4B, decisionBar: 0.5 })).toBe(0.5);
  for (const decisionBar of [0.7, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(snifferDecisionBar({ ...builtIn4B, decisionBar })).toBe(0.15);
    expect(snifferDecisionBar({ ...otherJudge, decisionBar })).toBe(0.5);
  }
});

test('the 35B-A3B has its measured bar, by its model name or by its profile behind a router alias', () => {
  expect(snifferDecisionBar({ kind: 'local', modelId: QWEN36_35B_A3B_SNIFFER_MODEL, snifferMode: 'decision' })).toBe(0.374);
  // A router alias names no weights: the profile carries the measured bar.
  expect(snifferDecisionBar({ kind: 'local', modelId: 'delphi/source-answer', snifferMode: 'decision' })).toBe(0.5);
  expect(snifferDecisionBar({ kind: 'local', modelId: 'delphi/source-answer', snifferMode: 'decision', decisionBar: 0.374 })).toBe(0.374);

  const config = structuredClone(loadSovereigntyPreset('local-first'));
  config.modelProfiles['local-source-answer']!.snifferDecisionBar = 0.374;
  const lane = resolveSnifferLane(createSovereigntyEngine(validateSovereigntyConfig(config)));
  expect(snifferDecisionBar(lane)).toBe(0.374);
});

test('a served weights file finds its measured bar behind any alias, but a fine-tune does not (#1253)', () => {
  const alias: SnifferLaneIdentity = { kind: 'local', modelId: 'delphi/source-answer', snifferMode: 'decision' };
  for (const file of ['Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf', 'qwen3.6-35b-a3b-q8_0.gguf', 'Qwen3.6-35B-A3B.gguf', 'Qwen3.6-35B-A3B-Q4_K_M-00001-of-00002.gguf']) {
    expect(snifferDecisionBar({ ...alias, servedWeights: file })).toBe(0.374);
  }
  expect(snifferDecisionBar({ ...alias, servedWeights: 'Qwen3.5-4B-Q4_K_M.gguf' })).toBe(0.15);
  for (const file of ['Qwen3.6-35B-A3B-Abliterated-Q4_K_M.gguf', 'Qwen3.5-40B-Q4_K_M.gguf', 'Qwen3.5-2B-Q4_K_M.gguf', 'my-qwen3.6-35b-a3b-q4.gguf', 'Qwen3.6-35B-A3B-Q4_K_M.bin']) {
    expect(snifferDecisionBar({ ...alias, servedWeights: file })).toBe(0.5);
  }
  // The lane's own bar still wins over a measured one.
  expect(snifferDecisionBar({ ...alias, servedWeights: 'Qwen3.5-4B-Q4_K_M.gguf', decisionBar: 0.3 })).toBe(0.3);
});

test('a profile\'s decision bar can only lean Private, and only on a local profile', () => {
  for (const bar of [0, -0.1, 0.51, 1, Number.NaN]) {
    const config = structuredClone(loadSovereigntyPreset('local-first'));
    config.modelProfiles['local-source-answer']!.snifferDecisionBar = bar;
    expect(() => validateSovereigntyConfig(config)).toThrow(/snifferDecisionBar/);
  }
  const config = structuredClone(loadSovereigntyPreset('local-first'));
  const cloud = Object.entries(config.modelProfiles).find(([, profile]) => profile.trust !== 'local');
  if (cloud) {
    cloud[1].snifferDecisionBar = 0.3;
    expect(() => validateSovereigntyConfig(config)).toThrow(/snifferDecisionBar/);
  }
});

test('P(Private) is recovered from a stored decision verdict', () => {
  for (const chance of [0, 0.05, 0.15, 0.2, 0.49, 0.5, 0.7, 1]) {
    expect(snifferDecisionPrivateChance(stored(chance))).toBeCloseTo(chance, 12);
  }
  expect(snifferDecisionPrivateChance({ tier: 'private', category: 'decision', confidence: 0.2 })).toBe(0.2);
  expect(snifferDecisionPrivateChance({ ...stored(0.2), failSafe: true })).toBeUndefined();
  expect(snifferDecisionPrivateChance({ tier: 'personal', category: 'ordinary', confidence: 0.8 })).toBeUndefined();
  expect(snifferDecisionPrivateChance({ tier: 'personal', category: 'decision', confidence: 1.5 })).toBeUndefined();
  expect(snifferDecisionPrivateChance({ tier: 'personal', category: 'decision', confidence: Number.NaN })).toBeUndefined();
  // An unreadable decision verdict holds the item Private.
  expect(snifferTierKey({ tier: 'personal', category: 'decision', confidence: Number.NaN })).toBe('secure');
});

test('the 4B at 0.15 holds a 0.2 item Private while a 0.5-bar judge leaves it Personal', () => {
  const uncertain = stored(0.2);
  expect(snifferVerdictTier(uncertain, builtIn4B, [])).toEqual({ tier: 'secure', code: 'decision:0.80' });
  expect(snifferVerdictTier(uncertain, configured4B, []).tier).toBe('secure');
  expect(snifferVerdictTier(uncertain, otherJudge, [])).toEqual({ tier: 'private', code: 'decision:0.80' });
  expect(snifferTierKey(uncertain)).toBe('private');
  // Below the 4B's bar it stays Personal; at or above an even chance every judge holds it.
  expect(snifferVerdictTier(stored(0.1), builtIn4B, []).tier).toBe('private');
  expect(snifferVerdictTier(stored(0.15), builtIn4B, []).tier).toBe('secure');
  for (const lane of [builtIn4B, otherJudge]) expect(snifferVerdictTier(stored(0.5), lane, []).tier).toBe('secure');
  // A verdict stored at the 0.15 bar (Private, mass 0.2) reads Personal again under a 0.5 bar.
  const atLowBar = { tier: 'private' as const, category: 'decision', confidence: 0.2, failSafe: false };
  expect(snifferVerdictTier(atLowBar, builtIn4B, []).tier).toBe('secure');
  expect(snifferVerdictTier(atLowBar, otherJudge, []).tier).toBe('private');
  // Full mode is untouched on every lane: Personal counts only at 0.9.
  for (const lane of [builtIn4B, otherJudge]) {
    expect(snifferVerdictTier({ tier: 'personal', category: 'ordinary', confidence: 0.89, failSafe: false }, lane, []).tier).toBe('secure');
    expect(snifferVerdictTier({ tier: 'personal', category: 'ordinary', confidence: 0.9, failSafe: false }, lane, []).tier).toBe('private');
  }
});

test('a bar is part of the judge id, never of the verdict cache key; the default bar keeps existing ids', () => {
  const atDefault = { ...builtIn4B, decisionBar: 0.5 };
  expect(snifferCacheModelId(builtIn4B)).toBe(snifferCacheModelId(atDefault));
  expect(snifferId(builtIn4B)).not.toBe(snifferId(atDefault));
  // The id format the re-judge parses (tier-ledger.ts snifferInputs) still holds.
  expect(snifferId(builtIn4B)).toMatch(/^local:p-[a-f0-9]{12}\.m[a-f0-9]{16}$/);
  for (const lane of [atDefault, otherJudge, { ...builtIn4B, snifferMode: 'full' as const }]) {
    const model = createHash('sha256').update(snifferCacheModelId(lane)).digest('hex').slice(0, 16);
    expect(snifferId(lane).endsWith(`.m${model}`)).toBe(true);
  }
});

test('a bar change re-tiers already-judged items through the re-judge pass with no new judge call', async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  // Judged under the 4B at the old 0.5 bar; then the 4B's measured 0.15 applies.
  const before = { ...builtIn4B, decisionBar: 0.5 };
  const after = builtIn4B;
  const chances: Record<string, number> = { uncertain: 0.2, clear: 0.05 };
  let calls = 0;
  const model = { async complete(request: { prompt: string }) {
    calls++;
    const chance = request.prompt.includes('uncertain') ? chances.uncertain! : chances.clear!;
    return { text: '', modelId: before.modelId, decisionVerdict: stored(chance) };
  } };
  let installed = new InstalledTierClassification({ env: {}, lane: before });
  let service: TierSnifferService | undefined;
  const makeService = (lane: SnifferLaneIdentity) => new TierSnifferService({ installed, lane: lane as typeof builtIn4B, model,
    stores: () => f.set.openStores(), classificationLedgerPath: join(tmp.dir, 'classification.jsonl'), autoApproveBuiltIn: true });
  try {
    registerInstalledTierClassification(installed);
    await f.set.sync(fixtureConnector(() => [
      { id: 'uncertain', name: 'Notes uncertain', text: 'Orchard notes, uncertain.' },
      { id: 'clear', name: 'Notes clear', text: 'Orchard notes, clear.' },
    ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    service = makeService(before);
    for (let n = 0; n < 4; n++) await service.runOnce();
    for (const id of ['uncertain', 'clear']) {
      expect(f.ledger.getCurrent(identityOf(id))).toMatchObject({ state: 'current', contentTier: 'private', contentPending: false });
    }
    const judged = calls;
    expect(judged).toBeGreaterThan(0);
    service.stop(); installed.close();

    installed = new InstalledTierClassification({ env: {}, lane: after });
    registerInstalledTierClassification(installed);
    service = makeService(after);
    for (let n = 0; n < 4; n++) await service.runOnce();
    expect(calls).toBe(judged);
    const raised = f.ledger.getCurrent(identityOf('uncertain'))!;
    expect(raised.state === 'moving' ? raised.targetContentTier : raised.contentTier).toBe('secure');
    expect(f.ledger.getCurrent(identityOf('clear'))).toMatchObject({ state: 'current', contentTier: 'private' });
    // Re-reading with the same judge at the same bar changes nothing and asks nothing.
    const settled = f.ledger.getCurrent(identityOf('uncertain'));
    await service.runOnce();
    expect(calls).toBe(judged);
    expect(f.ledger.getCurrent(identityOf('uncertain'))).toEqual(settled);
  } finally {
    service?.stop(); installed.close(); registerInstalledTierClassification(undefined); f.close(); tmp.cleanup();
  }
});
