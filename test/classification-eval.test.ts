// The classification eval's hard gates, run in CI with the deterministic
// fake sniffer (eval/classification). A real sniffer runs only on demand:
// `bun run eval:classification -- --real`.

import { describe, expect, test } from 'bun:test';
import { classificationCorpus } from '../eval/classification/corpus.ts';
import { createFakeSnifferModel } from '../eval/classification/fake-sniffer.ts';
import { runClassificationEval } from '../eval/classification/run.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';

const FAKE_LANE: SnifferLane = {
  kind: 'local',
  modelId: 'eval-fake-sniffer',
  profileId: 'eval-fake-sniffer',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'eval-fake-sniffer' },
};

describe('classification eval (fake sniffer)', () => {
  test('the corpus covers every family across the four tiers', () => {
    const corpus = classificationCorpus();
    for (const family of ['email', 'file', 'chat', 'note', 'bookmark']) {
      const labels = new Set(corpus.filter((entry) => entry.family === family).map((entry) => entry.label));
      expect([...labels].sort()).toEqual(['private', 'public', 'secrets', 'secure']);
    }
    expect(corpus.filter((entry) => entry.set === 'ambiguous' && entry.label === 'secure').length).toBeGreaterThanOrEqual(100);
  });

  test('hard gates: secret recall, hard categories, ambiguous leakage', async () => {
    const model = createFakeSnifferModel();
    const report = await runClassificationEval({ lane: FAKE_LANE, model, label: 'fake' });
    expect(report.secretRecall).toBe(1);
    expect(report.hardCategoryMisses).toEqual([]);
    expect(report.ambiguousLeakage).toBeLessThanOrEqual(0.01);
    expect(report.gates.passed).toBe(true);
    // Reported, and pinned so a regression is visible in review.
    expect(report.pending).toBe(0);
    expect(report.publicPrecision).toBe(1);
    expect(report.confusion['label:secrets']).toEqual({ secrets: report.bySet['secret']! });
    // Batching: about 100 names per call, never more.
    expect(report.sniffer_usage.calls).toBeLessThan(report.sniffer_usage.itemsAsked / 20);
    expect(model.stats.items).toBe(report.sniffer_usage.itemsAsked);
  }, 30_000);
});
