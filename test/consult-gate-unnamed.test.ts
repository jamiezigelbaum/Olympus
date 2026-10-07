// The outbound gate at the "Your situation, without names" level (owner
// decision 2026-10-07; owner ruling in review: err on the side of allowing
// more through): the rules that widen, the counterexamples of review round 1,
// and what stays blocked. Measurements: eval/consult-leak/unnamed-level.ts.

import { describe, expect, test } from 'bun:test';
import type { EvidencePack } from '../src/core/contracts.ts';
import { consultWriterContextFromPack, evaluateConsultRequest, type ConsultLevel } from '../src/core/consult-gate.ts';

const DOCUMENT = 'This tenancy between Pembroke Lettings and Marta Kowalczyk begins on 1 May 2024. The tenant must give 60 days notice in writing. '
  + 'The deposit of 2,400.00 is held by the landlord. Ela tem 37 anos. The rule allows a 180 day window and a 120 euro fee, and overpayments of 10 percent.';
const ANSWER = 'Your lease asks for 60 days notice; your email to the landlord gave 45. The landlord says they will keep the two-month deposit.';
const QUESTION = 'Can my landlord keep my deposit?';

function context(documents: string[] = [DOCUMENT], answer: string = ANSWER, title = 'Lease Kowalczyk 2024.pdf') {
  const pack: EvidencePack = {
    question: QUESTION,
    candidates: documents.map((text, index) => ({
      provenance: { sourceItem: { family: 'file' as const, provider: 'synthetic', accountScope: 'acct', providerItemId: `item-${index}`, localItemId: `local-item-${index}` }, citation: { title } },
      trustTier: 'S4' as const,
      trustDomain: 'secure_local' as const,
      chunks: [text],
    })),
    coverage: { searchedCorpora: ['secure_local.synthetic'], skippedCorpora: [], extractionGaps: [] },
    builtAt: '2026-10-07T09:00:00.000Z',
  };
  return consultWriterContextFromPack(pack, { writerVisibleTexts: [QUESTION], writerAnswerTexts: [answer, 'Whether a landlord may keep a full deposit for short notice.'] });
}

const verdict = (questions: string[], level?: ConsultLevel, built = context()) => evaluateConsultRequest(questions, built, {}, {}, { languages: ['en', 'pt-PT'], ...(level ? { level } : {}) });

describe('the unnamed level widens its rules', () => {
  test("the owner's example, with its duration named, passes at the unnamed level and is refused at the general level", () => {
    const example = ['A tenant gave 45 days notice where the lease requires 60 days. Can the landlord keep a deposit of about two months rent?'];
    expect(verdict(example, 'unnamed')).toEqual({ decision: 'pass', reasons: [] });
    expect(verdict(example, 'general').reasons).toContain('too_many_content_words');
    expect(verdict(example)).toEqual(verdict(example, 'general'));
  });

  test('rule figures pass only when the question also writes the duration or percent after them', () => {
    expect(verdict(['A deadline runs for 180 days. Is that usual?'], 'unnamed')).toEqual({ decision: 'pass', reasons: [] });
    expect(verdict(['Overpaying 10 percent a year is allowed. Is that usual?'], 'unnamed')).toEqual({ decision: 'pass', reasons: [] });
    // The same value bare in the question could be anything: refused.
    expect(verdict(['The lease requires 60. Is that usual?'], 'unnamed').reasons).toContain('snapshot_figure');
    expect(verdict(['Is a fee of 180 usual?'], 'unnamed').reasons).toContain('snapshot_figure');
    expect(verdict(['Is a 120 fee usual for this?'], 'unnamed').reasons).toContain('snapshot_figure');
    expect(verdict(['Is someone of 37 old for this?'], 'unnamed').reasons).toContain('snapshot_figure');
    expect(verdict(['A tenancy began in 2024. Is that relevant?'], 'unnamed').reasons).toContain('snapshot_figure');
  });

  test('two situation sentences fit; the question sentence keeps the general size cap, so a run-on list of asks is still refused', () => {
    expect(verdict(['A tenant gave short notice. The landlord kept everything. Is that allowed?'], 'unnamed')).toEqual({ decision: 'pass', reasons: [] });
    expect(verdict(['A tenant gave short notice. The landlord kept everything. Is that allowed?'], 'general').reasons).toContain('too_many_sentences');
    expect(verdict(['Please explain refunds, compare arbitration, outline mediation, describe escrow, assess depreciation, and summarize limitation periods?'], 'unnamed').reasons).toContain('too_many_content_words');
  });

  test("restating the answer's situation is not copying; copying five document words still is", () => {
    expect(verdict(['The landlord says they will keep the deposit. Is that allowed?'], 'unnamed').decision).toBe('pass');
    expect(verdict(['The tenant must give 60 days notice in writing. Is email enough?'], 'unnamed').reasons).toContain('shared_token_run');
    expect(verdict(['The landlord says they will keep the deposit. Is that allowed?'], 'general').reasons).toContain('shared_token_run');
  });

  test('a dictionary word the snapshot also writes in lower case is not a name; words only ever capitalized, capitalized labels, title words and non-dictionary names still are', () => {
    const built = context(['Customer reported a grinding noise. Offer letter: probation lasts six months. Parked at the Retail Park on the hedge side. Reporter: \'Grace\'.'], 'The garage replaced the clutch for the customer.', 'Invoice Dunmore Motors');
    expect(verdict(['A customer heard a noise. Must they pay?'], 'unnamed', built)).toEqual({ decision: 'pass', reasons: [] });
    // A dictionary word only ever capitalized stays a possible name, even at a sentence start.
    const initialOnly = context(['Customer reported a grinding noise.'], 'The garage replaced the clutch.');
    expect(verdict(['A customer heard a noise. Must they pay?'], 'unnamed', initialOnly).reasons).toContain('snapshot_name');
    const grace = context(['Grace called about the deposit.'], 'The landlord replied.');
    expect(verdict(['Can grace keep the deposit?'], 'unnamed', grace).reasons).toContain('snapshot_name');
    expect(verdict(['Does probation change this?'], 'unnamed', built)).toEqual({ decision: 'pass', reasons: [] });
    expect(verdict(['Does probation change this?'], 'general', built).reasons).toContain('snapshot_name');
    expect(verdict(['Can grace appeal?'], 'unnamed', built).reasons).toContain('snapshot_name');
    // "Park" only capitalized mid-sentence: still a name part; once the snapshot also writes "park" in lower case, an ordinary word.
    expect(verdict(['Was the park sign visible?'], 'unnamed', built).reasons).toContain('snapshot_name');
    const lower = context(['Parked at the Retail Park on the hedge side.'], 'The sign at the retail park was hidden.');
    expect(verdict(['Was the park sign visible?'], 'unnamed', lower)).toEqual({ decision: 'pass', reasons: [] });
    // An address made of dictionary words stays protected (leak corpus famille-identifier-address).
    const street = context(['The house at 7 rue des Tanneurs was sold.'], 'The house was sold.');
    expect(verdict(['What are houses worth on the tanneurs street?'], 'unnamed', street).decision).toBe('refuse');
    const imaging = context(['The scan was done at Westbrook Imaging last week.'], 'The insurer paid nothing for the imaging.');
    expect(verdict(['Was the imaging centre out of network?'], 'unnamed', imaging)).toEqual({ decision: 'pass', reasons: [] });
    expect(verdict(['Was westbrook imaging out of network?'], 'unnamed', imaging).decision).toBe('refuse');
    expect(verdict(['Did the motors invoice look right?'], 'unnamed', built).decision).toBe('refuse');
    expect(verdict(['Can Marta keep the deposit?'], 'unnamed').decision).toBe('refuse');
  });
});

describe('review round 1 counterexamples', () => {
  test('a bare "per" is a rate, never a percent: "120 per hour" in the documents keeps 120 refused', () => {
    const built = context(['The fee is 120 per hour.'], 'You were charged by the hour.');
    expect(verdict(['Is a fee of 120 fair?'], 'unnamed', built).reasons).toContain('snapshot_figure');
    expect(verdict(['Is 120 per hour fair?'], 'unnamed', built).reasons).toContain('snapshot_figure');
    // A percent written out is a rule figure.
    const share = context(['Overpayments of 15 percent are allowed.'], 'You may overpay a little.');
    expect(verdict(['Overpaying 15 percent is allowed. Is that usual?'], 'unnamed', share)).toEqual({ decision: 'pass', reasons: [] });
  });

  test('a duration in digits does not mask the same value written in words as money', () => {
    const alone = context(['The notice runs 120 days.'], 'You owe a fee.');
    expect(verdict(['A deadline lasts 120 days. Is that usual?'], 'unnamed', alone)).toEqual({ decision: 'pass', reasons: [] });
    const built = context(['The notice runs 120 days. The fee was one hundred twenty euros.'], 'You owe a fee.');
    expect(verdict(['A deadline lasts 120 days. Is that usual?'], 'unnamed', built).reasons).toContain('snapshot_figure');
  });

  test('accepted residual (owner ruling): a lower-case name copied from the answer passes at the unnamed level, never at the general level', () => {
    const built = context(['The lease covers the ground floor.'], 'The landlord pays for repairs in the red lion.');
    expect(verdict(['Are repairs in the red lion covered?'], 'unnamed', built)).toEqual({ decision: 'pass', reasons: [] });
    expect(verdict(['Are repairs in the red lion covered?'], 'general', built).reasons).toContain('shared_token_run');
  });
});

describe('what stays blocked at the unnamed level', () => {
  for (const [label, question] of [
    ['a name', 'Marta gave 45 days notice where the lease requires 60 days. Can the landlord keep the deposit?'],
    ['an organisation', 'Pembroke Lettings wants to keep the deposit after short notice. Is that allowed?'],
    ['an exact amount, written without its zero fraction', 'A tenant gave short notice. Can the landlord keep a deposit of 2,400?'],
    ['a date', 'A tenancy began on 1 May. Can the landlord keep the deposit?'],
    ['a year', 'A tenancy began in 2024. Can the landlord keep the deposit?'],
    ['a document title', 'Under the lease kowalczyk can the landlord keep the deposit?'],
  ] as const) {
    test(label, () => {
      expect(verdict([question], 'unnamed').decision).toBe('refuse');
      expect(verdict([question], 'general').decision).toBe('refuse');
    });
  }
});
