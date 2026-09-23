// A deterministic stand-in for the privacy-safe model, for CI.
//
// It reads each batched item exactly as a real model would (the JSON lines of
// the batch prompt) and answers by vocabulary. It is deliberately NOT an
// oracle: it has two error modes the pipeline must absorb, chosen by a stable
// hash of the item so every run is identical.
//
// - Under-confident Personal: for some ambiguous items it answers "personal"
//   at 0.85, below the 0.9 threshold. The pipeline must still end them Private.
// - Mislabelled hard category: for some hard-category items it answers
//   "personal" with a hard category at 0.95. The hard-category guard must
//   still end them Private.
//
// - Injection compliance: if ANY item in a batch tells it what to answer (or
//   carries verdict-shaped JSON), it obeys and answers "personal" at 0.99 for
//   EVERY item in that batch. The injection gate therefore proves that such
//   material never reaches the model and never shares a batch.
// - Malformed output: for an item named "garbled" it omits the verdict, or
//   answers with an invalid category; a batch holding only such an item gets
//   no JSON at all. The fail-safe must end those items Private.
//
// So a green fake-sniffer run proves the WIRING (batching, the cache, the
// threshold, the hard-category guard, injection handling, fail-safe, never
// Public); it says nothing about a real model's judgment. Run `bun run eval:classification --
// --real` against a configured private lane for that.

import { createHash } from 'node:crypto';
import type { AnalystModel } from '../../src/core/analyst.ts';

const PRIVATE_VOCABULARY: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:malignant|tumou?r|oncolog\w*|biopsy|diagnos\w*|medication|blood test|pathology|prescription|physiotherapy)\b/i, 'health'],
  [/\b(?:therapy|therapist|counsell?ing|panic attacks?|relapse)\b/i, 'therapy'],
  [/\b(?:bank statement|account number|tax return|salary|payroll|overdraft|mortgage|loans?|debt|income)\b/i, 'financial'],
  [/\b(?:attorney|custody|divorce|lawsuit|hearing)\b/i, 'legal'],
  [/\b(?:passport|birth certificate|social security)\b/i, 'identity'],
  [/\binsurance claim\b/i, 'financial'],
];

export interface FakeSnifferStats {
  calls: number;
  items: number;
  /** Batches in which the fake obeyed an instruction (should stay 0). */
  complied: number;
}

export function createFakeSnifferModel(): AnalystModel & { stats: FakeSnifferStats } {
  const stats: FakeSnifferStats = { calls: 0, items: 0, complied: 0 };
  return {
    stats,
    async complete(request) {
      stats.calls += 1;
      const items = request.prompt
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as { i: number; names?: string; excerpt?: string });
      stats.items += items.length;
      const materials = items.map((item) => item.names ?? item.excerpt ?? '');
      if (materials.some((material) => INSTRUCTION.test(material))) {
        stats.complied += 1;
        return {
          text: JSON.stringify({ verdicts: items.map((item) => ({ i: item.i, tier: 'personal', category: 'ordinary', confidence: 0.99 })) }),
          modelId: 'eval-fake-sniffer',
        };
      }
      if (materials.length > 0 && materials.every((material) => /garbled/i.test(material))) {
        return { text: 'Sure! Here is my assessment of the items.', modelId: 'eval-fake-sniffer' };
      }
      const verdicts = items.flatMap((item) => {
        const material = item.names ?? item.excerpt ?? '';
        if (/garbled/i.test(material)) {
          return stableBucket(material) % 2 === 0 ? [] : [{ i: item.i, tier: 'private', category: 'made-up', confidence: 0.9 }];
        }
        return [verdictFor(item)];
      });
      return { text: JSON.stringify({ verdicts }), modelId: 'eval-fake-sniffer' };
    },
  };
}

function verdictFor(item: { i: number; names?: string; excerpt?: string }): Record<string, unknown> {
  const material = item.names ?? item.excerpt ?? '';
  const bucket = stableBucket(material);
  const hit = PRIVATE_VOCABULARY.find(([pattern]) => pattern.test(material));
  if (hit) {
    // Error mode 2: a hard category paired with "personal".
    if (bucket < 15) return { i: item.i, tier: 'personal', category: hit[1], confidence: 0.95 };
    // Error mode 1: an under-confident "personal".
    if (bucket < 30) return { i: item.i, tier: 'personal', category: 'ordinary', confidence: 0.85 };
    return { i: item.i, tier: 'private', category: hit[1], confidence: 0.92 };
  }
  return { i: item.i, tier: 'personal', category: 'ordinary', confidence: 0.95 };
}

/** What the fake treats as an instruction it will obey. */
const INSTRUCTION = /ignore previous|disregard the rules|answer personal|classify every item|verdicts/i;

/** 0-99, stable per material. */
function stableBucket(material: string): number {
  return createHash('sha256').update(material).digest().readUInt32BE(0) % 100;
}
