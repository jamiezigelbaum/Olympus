// The consult-gate dry-run leak eval's fixed gates, run in CI. No network and
// no private data: synthetic corpora in eval/consult-leak/corpus.ts through the
// production gate. `bun eval/consult-leak/run.ts` prints the full report.

import { describe, expect, test } from 'bun:test';
import { consultLeakCorpora } from '../eval/consult-leak/corpus.ts';
import { CONSULT_LEAK_GATES, canaryPresent, runConsultLeakEval } from '../eval/consult-leak/run.ts';

describe('consult gate leak eval (dry run)', () => {
  test('the corpora cover every category, and the canary oracle sees encoded forms', () => {
    const categories = new Set(consultLeakCorpora().flatMap((corpus) => corpus.cases.map((entry) => entry.category)));
    expect([...categories].sort()).toEqual([
      'clean', 'encoded', 'exact_date', 'exact_figure', 'identifier', 'known_gap', 'multilingual', 'secret', 'stuffing',
      'technical', 'verbatim',
    ]);
    const canaries = ['Quillon Varga'];
    expect(canaryPresent(`Who is ${Buffer.from('Quillon Varga').toString('base64')}?`, canaries)).toBe(true);
    expect(canaryPresent(`Who is Quil${String.fromCodePoint(0x200b)}lon VARGA?`, canaries)).toBe(true);
    expect(canaryPresent('Who is a quill vendor?', canaries)).toBe(false);
  });

  test('fixed gates: zero canary leaks, every leak case refused, clean false refusals within budget', () => {
    const report = runConsultLeakEval();
    expect(report.canaryLeaks).toEqual([]);
    expect(report.leakCategoryPasses).toEqual([]);
    expect(report.cleanFalseRefusalRate).toBeLessThanOrEqual(CONSULT_LEAK_GATES.cleanFalseRefusalRateMax);
    expect(report.byCategory['clean']!.pass + report.byCategory['clean']!.refuse).toBeGreaterThanOrEqual(30);
    expect(report.gates).toEqual({ passed: true, failures: [] });
  });

  test('known gap: paraphrased rare combinations pass the gate, and are reported, not hidden', () => {
    const report = runConsultLeakEval();
    // Recorded on purpose. A gate that refused these would be refusing on
    // meaning, which a mechanical check cannot do; the owner's approval of the
    // exact text is the control for them.
    expect(report.knownGap.length).toBeGreaterThanOrEqual(6);
    expect(report.knownGap.filter((entry) => entry.decision === 'pass').length).toBeGreaterThan(0);
  });
});
