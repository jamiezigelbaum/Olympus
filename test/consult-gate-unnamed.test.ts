// The outbound gate at the "Your situation, without names" level (owner
// decision 2026-10-07): the four rules that widen, and the rules that must not.
// Measurements: eval/consult-leak/unnamed-level.ts.

import { describe, expect, test } from 'bun:test';
import type { EvidencePack } from '../src/core/contracts.ts';
import { consultWriterContextFromPack, evaluateConsultRequest, type ConsultLevel } from '../src/core/consult-gate.ts';

const DOCUMENT = 'This tenancy between Pembroke Lettings and Marta Kowalczyk begins on 1 May 2024. The tenant must give 60 days notice in writing. '
  + 'The deposit of 2,400.00 is held by the landlord. Ela tem 37 anos. The rule allows a 180 day window and a 120 euro fee, and overpayments of 10 percent.';
const ANSWER = 'Your lease asks for 60 days notice; your email to the landlord gave 45. The landlord says they will keep the two-month deposit.';
const QUESTION = 'Can my landlord keep my deposit?';

function context() {
  const pack: EvidencePack = {
    question: QUESTION,
    candidates: [{
      provenance: { sourceItem: { family: 'file', provider: 'synthetic', accountScope: 'acct', providerItemId: 'item-1', localItemId: 'local-item-1' }, citation: { title: 'Lease Kowalczyk 2024.pdf' } },
      trustTier: 'S4',
      trustDomain: 'secure_local',
      chunks: [DOCUMENT],
    }],
    coverage: { searchedCorpora: ['secure_local.synthetic'], skippedCorpora: [], extractionGaps: [] },
    builtAt: '2026-10-07T09:00:00.000Z',
  };
  return consultWriterContextFromPack(pack, { writerVisibleTexts: [QUESTION], writerAnswerTexts: [ANSWER, 'Whether a landlord may keep a full deposit for short notice.'] });
}

const verdict = (questions: string[], level?: ConsultLevel) => evaluateConsultRequest(questions, context(), {}, {}, { languages: ['en', 'pt-PT'], ...(level ? { level } : {}) });

describe('the unnamed level widens four rules', () => {
  test("the owner's example passes at the unnamed level and is refused at the general level", () => {
    const example = ['A tenant gave 45 days notice where the lease requires 60. Can the landlord keep a deposit of about two months rent?'];
    expect(verdict(example, 'unnamed')).toEqual({ decision: 'pass', reasons: [] });
    expect(verdict(example, 'general').reasons).toEqual(['too_many_content_words']);
    // Within the general size cap, the general level still refuses the 60 that sits next to "days" in the snapshot.
    expect(verdict(['The lease requires 60. Is that usual?'], 'general').reasons).toContain('snapshot_figure');
    expect(verdict(['The lease requires 60. Is that usual?'], 'unnamed').decision).toBe('pass');
    expect(verdict(example)).toEqual(verdict(example, 'general'));
  });

  test('rule figures: plain figures of up to three digits followed only by a duration or percent word pass; years, money and decimals do not', () => {
    expect(verdict(['A deadline runs for 180 days. Is that usual?'], 'unnamed')).toEqual({ decision: 'pass', reasons: [] });
    expect(verdict(['Overpaying 10 percent a year is allowed. Is that usual?'], 'unnamed')).toEqual({ decision: 'pass', reasons: [] });
    expect(verdict(['Is a 120 fee usual for this?'], 'unnamed').reasons).toContain('snapshot_figure');
    expect(verdict(['Is someone of 37 old for this?'], 'unnamed').reasons).toContain('snapshot_figure');
    expect(verdict(['A tenancy began in 2024. Is that relevant?'], 'unnamed').reasons).toContain('snapshot_figure');
  });

  test('the question sentence keeps the general size cap: a run-on list of asks is still refused', () => {
    expect(verdict(['Please explain refunds, compare arbitration, outline mediation, describe escrow, assess depreciation, and summarize limitation periods?'], 'unnamed').reasons).toContain('too_many_content_words');
  });

  test("restating the answer's situation is not copying; copying five document words still is", () => {
    expect(verdict(['The landlord says they will keep the deposit. Is that allowed?'], 'unnamed').decision).toBe('pass');
    expect(verdict(['The tenant must give 60 days notice in writing. Is email enough?'], 'unnamed').reasons).toContain('shared_token_run');
    expect(verdict(['The landlord says they will keep the deposit. Is that allowed?'], 'general').reasons).toContain('shared_token_run');
  });
});

describe('what stays blocked at the unnamed level', () => {
  for (const [label, question] of [
    ['a name', 'Marta gave 45 days notice where the lease requires 60. Can the landlord keep the deposit?'],
    ['an organisation', 'Pembroke Lettings wants to keep the deposit after short notice. Is that allowed?'],
    ['an exact amount, written without its zero fraction', 'A tenant gave short notice. Can the landlord keep a deposit of 2,400?'],
    ['a date', 'A tenancy began on 1 May. Can the landlord keep the deposit?'],
    ['a document title', 'Under the lease kowalczyk can the landlord keep the deposit?'],
  ] as const) {
    test(label, () => {
      expect(verdict([question], 'unnamed').decision).toBe('refuse');
      expect(verdict([question], 'general').decision).toBe('refuse');
    });
  }
});
