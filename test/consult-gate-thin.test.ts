// The gate's thin net (owner decision 2026-10-10, "Writer: your own local
// model" in docs/design/private-answers.md): under the owner's own writer it
// refuses only hard identifiers, after Vitalik Buterin's approach (the local
// model rewriting under a skill file is the content filter). The built-in
// writer keeps the full gate. Measurements: eval/consult-reid/run-endpoint.ts.

import { describe, expect, test } from 'bun:test';
import { consultWriterContextFromPack, evaluateConsultRequest, type ConsultGateNet, type ConsultLevel } from '../src/core/consult-gate.ts';
import { CONSULT_WRITER_CHECK_CASES, consultWriterCheckPack } from '../src/core/consult-writer-check.ts';
import { UNNAMED_CASES } from '../eval/consult-leak/unnamed-questions.ts';

type Case = { userQuestion: string; answer: string; gaps: readonly string[]; titles: readonly string[]; documents: readonly string[]; id: string; canaries: readonly string[] };

function judge(entry: Case, questions: string[], level: ConsultLevel, net?: ConsultGateNet) {
  const context = consultWriterContextFromPack(consultWriterCheckPack(entry), { writerVisibleTexts: [entry.userQuestion], writerAnswerTexts: [entry.answer, ...entry.gaps] });
  return evaluateConsultRequest(questions, context, {}, {}, {
    languages: ['en'],
    level,
    askedQuestionTexts: [entry.userQuestion],
    askedQuestionFullTexts: [entry.userQuestion],
    ...(net ? { net } : {}),
  });
}

const byId = (id: string): Case => (UNNAMED_CASES.find((entry) => entry.id === id) ?? CONSULT_WRITER_CHECK_CASES.find((entry) => entry.id === id))!;

describe('the thin net', () => {
  test('drops the vocabulary, structure and copy rules, at both levels; "full" and absent are the same gate', () => {
    const notary = byId('loi-notary-present');
    // Recorded from Delphi on 2026-10-10 (Strict, with evidence): refused as a copy by the full gate.
    const copied = ['Does a non-binding letter of intent for a commercial lease require notarization to be valid?'];
    for (const level of ['general', 'unnamed'] as const) {
      expect(judge(notary, copied, level, 'thin')).toEqual({ decision: 'pass', reasons: [] });
    }
    expect(judge(notary, copied, 'general').decision).toBe('refuse');
    expect(judge(notary, copied, 'general', 'full')).toEqual(judge(notary, copied, 'general'));
    // An unknown word and a long question pass the thin net only.
    const unusual = ['Does clarithromycin significantly increase warfarin levels and bleeding risk when started alongside an existing anticoagulant regimen for atrial fibrillation?'];
    const medication = byId('medication-interaction');
    expect(judge(medication, unusual, 'general').decision).toBe('refuse');
    expect(judge(medication, unusual, 'general', 'thin').decision).toBe('pass');
  });

  test('every labelled leak of the unnamed set stays refused: names, amounts, places, identifiers, dates, titles', () => {
    let leaks = 0;
    for (const entry of UNNAMED_CASES) {
      for (const leak of entry.leaks) {
        for (const question of leak.questions) {
          leaks += 1;
          for (const level of ['general', 'unnamed'] as const) {
            expect({ id: entry.id, kind: leak.kind, level, decision: judge(entry, [question], level, 'thin').decision }).toEqual({ id: entry.id, kind: leak.kind, level, decision: 'refuse' });
          }
        }
      }
    }
    expect(leaks).toBeGreaterThan(60);
  });

  test('a snapshot name that is also a dictionary word stays refused however the request writes it: any position, any case', () => {
    const entry: Case = {
      id: 'builder',
      userQuestion: 'Is my builder allowed to charge extra?',
      titles: ['Quote'],
      documents: ['The builder said the work would take two weeks. Grace called on Monday to say the price had gone up.'],
      answer: 'The builder raised the price after starting.',
      gaps: ['Whether a builder may raise a quoted price.'],
      canaries: ['Grace'],
    };
    // Independent review of PR #209: lowercasing the name must not lift the protection.
    for (const question of [
      'Grace raised a quoted price after starting the work. Is that allowed?',
      'Can a builder called Grace raise a quoted price after starting the work?',
      'Can a builder called grace raise a quoted price after starting the work?',
      'grace raised a quoted price after starting the work. Is that allowed?',
    ]) {
      for (const level of ['general', 'unnamed'] as const) expect(judge(entry, [question], level, 'thin').reasons).toContain('snapshot_name');
    }
    expect(judge(entry, ['Can a builder raise a quoted price after starting the work?'], 'unnamed', 'thin').decision).toBe('pass');
  });

  test('labelled names and name pairs stay refused in lower case too', () => {
    const entry: Case = {
      id: 'reporter',
      userQuestion: 'Can my neighbour report me for noise?',
      titles: ['Complaint'],
      documents: ['Reporter: Hope. The complaint was filed by Rose Marsh about music after midnight.'],
      answer: 'A neighbour filed a noise complaint about late music.',
      gaps: ['Whether one complaint can lead to a noise abatement notice.'],
      canaries: ['Hope', 'Rose Marsh'],
    };
    for (const question of ['Can hope report late music to the council?', 'Can rose marsh report late music to the council?']) {
      expect(judge(entry, [question], 'unnamed', 'thin').decision).toBe('refuse');
    }
  });

  test('hard identifiers on sight stay refused: mail addresses, links, digit runs longer than eight', () => {
    const entry = byId('lease-notice');
    for (const question of ['Can the landlord at lettings@example.com keep the deposit?', 'Does www.example.com explain deposit rules?', 'Can account 123456789012 be charged for the deposit?']) {
      expect(judge(entry, [question], 'unnamed', 'thin').decision).toBe('refuse');
    }
  });
});
