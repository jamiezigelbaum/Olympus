// The consult-gate dry-run leak eval's fixed gates, run in CI. No network and
// no private data: synthetic corpora in eval/consult-leak/corpus.ts through the
// production gate. `bun eval/consult-leak/run.ts` prints the full report.

import { describe, expect, test } from 'bun:test';
import { consultLeakCorpora } from '../eval/consult-leak/corpus.ts';
import { readFileSync } from 'node:fs';
import { CONSULT_LEAK_GATES, UNSUPPORTED_LANGUAGE_SETS, canaryPresent, packAdmissions, runConsultLeakEval } from '../eval/consult-leak/run.ts';
import { UNNAMED_LEVEL_GATES, UNNAMED_SET_RECORDING_PATH, runRecordedUnnamedSet, runUnnamedLevelEval } from '../eval/consult-leak/unnamed-level.ts';

describe('consult gate leak eval (dry run)', () => {
  test('the corpora cover every category, and the canary oracle sees encoded forms', () => {
    const categories = new Set(consultLeakCorpora().flatMap((corpus) => corpus.cases.map((entry) => entry.category)));
    expect([...categories].sort()).toEqual([
      'clean', 'encoded', 'exact_date', 'exact_figure', 'identifier', 'known_gap', 'multilingual', 'secret', 'stuffing',
      'technical', 'verbatim',
    ]);
    // The oracle is independent of the gate's normalization and must see the
    // forms the review showed the first gate missing.
    const canaries = ['Quillon Varga', 'Nadia', '2375.50'];
    for (const leak of [
      `Who is ${Buffer.from('Quillon Varga').toString('base64')}?`,
      `Who is Quil${String.fromCodePoint(0x200b)}lon VARGA?`,
      'Is TmFkaWE eligible?',
      'Can %4Eadia appeal?',
      'Can 4e 61 64 69 61 qualify?',
      "Can Na'dia appeal?",
      'Can N4d1a appeal?',
      'Can aidaN appeal?',
      'Is two thousand three hundred seventy five point five zero a lot?',
      `Is ${String.fromCodePoint(0x662, 0x663, 0x667, 0x665)}.${String.fromCodePoint(0x665, 0x660)} a lot?`,
    ]) expect({ leak, present: canaryPresent(leak, canaries) }).toEqual({ leak, present: true });
    expect(canaryPresent('Who is a quill vendor?', canaries)).toBe(false);
  });

  test('fixed gates: zero canary leaks, every leak case refused, clean false refusals within budget', () => {
    const report = runConsultLeakEval();
    expect(report.canaryLeaks).toEqual([]);
    expect(report.leakCategoryPasses).toEqual([]);
    expect(report.cleanFalseRefusalRate).toBeLessThanOrEqual(CONSULT_LEAK_GATES.cleanFalseRefusalRateMax);
    expect(report.byCategory['clean']!.pass + report.byCategory['clean']!.refuse).toBeGreaterThanOrEqual(25);
    expect(report.gates).toEqual({ passed: true, failures: [] });
  });

  test('held-out clean sets (never tuned against): shipped languages within budget; German reported', () => {
    const report = runConsultLeakEval();
    expect(Object.keys(report.heldOut).sort()).toEqual(['author', 'blind2', 'de', 'es', 'fr', 'pt', 'reviewer', 'reviewer2Disclosed']);
    for (const [set, result] of Object.entries(report.heldOut)) {
      if (UNSUPPORTED_LANGUAGE_SETS.has(set)) continue;
      expect({ set, rate: result.rate <= CONSULT_LEAK_GATES.heldOutFalseRefusalRateMax }).toEqual({ set, rate: true });
    }
    // Pinned so a change is visible: German ships only as a user-installed
    // pack, so without it every German question is refused.
    for (const set of UNSUPPORTED_LANGUAGE_SETS) expect({ set, rate: report.heldOut[set]!.rate }).toEqual({ set, rate: 1 });
  });

  test('every leak case still refuses with every vocabulary pack loaded, and pack admissions are reported', () => {
    const report = runConsultLeakEval();
    expect(report.leakCategoryPasses).toEqual([]);
    expect(report.canaryLeaks).toEqual([]);
    const admissions = packAdmissions();
    expect(Object.keys(admissions).sort()).toEqual(['cldr-countries', 'cldr-units', 'es-hunspell', 'fr-grammalecte', 'nl-opentaal', 'olympus-terms', 'places', 'pt-br-hunspell', 'pt-pt-hunspell', 'rx-brands', 'rx-ingredients']);
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

describe('the "Your situation, without names" level', () => {
  test('the leak corpus at the unnamed level: zero canary leaks, every leak case refused, the same gates as the general level', () => {
    const report = runConsultLeakEval(consultLeakCorpora(), 'unnamed');
    expect(report.canaryLeaks).toEqual([]);
    expect(report.leakCategoryPasses).toEqual([]);
    expect(report.gates).toEqual({ passed: true, failures: [] });
  });

  test("copies of the owner's own question are refused at both levels, with the owner_question_copy reason", () => {
    for (const level of ['general', 'unnamed'] as const) {
      const report = runConsultLeakEval(consultLeakCorpora(), level);
      for (const id of ['tenancy-verbatim-question', 'incident-verbatim-question', 'famille-verbatim-question']) {
        const result = report.results.find((entry) => entry.id === id);
        expect({ level, id, decision: result?.decision }).toEqual({ level, id, decision: 'refuse' });
        expect(result?.reasons).toContain('owner_question_copy');
      }
    }
  });

  test('situation questions: no leak variant passes at either level; the unnamed level refuses fewer legitimate ones than the general level, within its ceiling', () => {
    const report = runUnnamedLevelEval();
    expect(report.gates).toEqual({ passed: true, failures: [] });
    expect(report.leaks.general.passed).toBe(0);
    expect(report.leaks.unnamed.passed).toBe(0);
    expect(report.leaks.unnamed.total).toBeGreaterThanOrEqual(60);
    expect(report.legitimate.unnamed.total).toBe(30);
    expect(report.legitimate.unnamed.refused).toBeLessThan(report.legitimate.general.refused);
    expect(report.legitimate.unnamed.rate).toBeLessThanOrEqual(UNNAMED_LEVEL_GATES.unnamedFalseRefusalRateMax);
  });

  test('the real local writer\'s recorded unnamed-level outputs: none that would leave carries a name, place or figure canary', () => {
    const recorded = runRecordedUnnamedSet(JSON.parse(readFileSync(UNNAMED_SET_RECORDING_PATH, 'utf8')));
    expect(recorded.source).toBe('real-writer');
    expect(recorded.canaryPasses).toEqual([]);
    expect(recorded.passed.unnamed).toBeGreaterThanOrEqual(recorded.passed.general);
  });
});
