// Words of the question ChatGPT sent (owner ruling 2026-10-08; called "the
// owner's" question below): at the "unnamed" (Standard) level a word, name,
// place or amount of it is exempt from the snapshot name and figure rules;
// its wording is never sent (`owner_question_copy`, both levels); hard
// identifiers stay refused at both levels; the "general" (Strict) level has
// no exemption. The rule: consult-gate.ts,
// CONSULT_GATE_ASKED_WORDS_MAX_FIGURE_RUN_DIGITS.

import { describe, expect, test } from 'bun:test';
import type { EvidencePack } from '../src/core/contracts.ts';
import { consultWriterContextFromPack, evaluateConsultRequest, type ConsultGateOptions, type ConsultGateVerdict, type ConsultLevel } from '../src/core/consult-gate.ts';
import { consultGateOptionsFromSettings, DEFAULT_CONSULT_SETTINGS } from '../src/core/consult-settings.ts';

// The live case (2026-10-08), with invented details.
const OWNER = 'What does my Letter of Intent say about the notary, and how are notary and registration fees usually split between buyer and seller in Catalonia?';
const DOCUMENT = 'Letter of Intent. The buyer, Grace Mason, will sign the deed before the notary in Catalonia. '
  + 'The buyer must sign before the notary within thirty days of acceptance. '
  + 'A deposit of EUR 30,000 is paid to account ES91 2100 0418 4502 0005 1332 on 14 March 2025. '
  + 'The flat is at 12 Heron Quay. Call the notary on 612 345 678. The agency fee is 450 euros.';
const ANSWER = 'Your letter of intent says the deed is signed before a notary; it does not say who pays the fees.';
const GAPS = ['How notary and registration fees are usually split.'];

function context(owner: string = OWNER, documents: string[] = [DOCUMENT]) {
  const pack: EvidencePack = {
    question: owner,
    candidates: documents.map((text, index) => ({
      provenance: { sourceItem: { family: 'file' as const, provider: 'synthetic', accountScope: 'acct', providerItemId: `item-${index}`, localItemId: `local-item-${index}` }, citation: { title: 'Signed offer.pdf' } },
      trustTier: 'S4' as const,
      trustDomain: 'secure_local' as const,
      chunks: [text],
    })),
    coverage: { searchedCorpora: ['secure_local.synthetic'], skippedCorpora: [], extractionGaps: [] },
    builtAt: '2026-10-08T09:00:00.000Z',
  };
  // As the orchestrator builds it: the owner's question is also writer-visible text.
  return consultWriterContextFromPack(pack, { writerVisibleTexts: [owner], writerAnswerTexts: [ANSWER, ...GAPS] });
}

const DEFAULTS = consultGateOptionsFromSettings(DEFAULT_CONSULT_SETTINGS);

// `owner`: the owner's question (in the snapshot as always); `exempt`: whether it is also passed as askedQuestionTexts.
function verdict(questions: string[], level: ConsultLevel, owner: string = OWNER, exempt = true, documents?: string[]) {
  const options: ConsultGateOptions = { ...DEFAULTS, level, ...(exempt ? { askedQuestionTexts: [owner] } : {}) };
  return evaluateConsultRequest(questions, context(owner, documents), {}, {}, options);
}

const PASS: ConsultGateVerdict = { decision: 'pass', reasons: [] };

describe('a word the owner typed may go out at the unnamed level', () => {
  test('the Catalonia case passes at unnamed and is still refused at general', () => {
    const asked = ['Who usually pays the notary fees in Catalonia?'];
    expect(verdict(asked, 'unnamed')).toEqual(PASS);
    // Without the owner's words, the same request is refused as before.
    expect(verdict(asked, 'unnamed', OWNER, false).reasons).toContain('snapshot_name');
    const strict = verdict(asked, 'general');
    expect(strict.reasons).toContain('snapshot_name');
    // The general level has no owner-word exemption.
    expect(strict).toEqual(verdict(asked, 'general', OWNER, false));
  });

  test('an amount the owner typed with its currency may go out; written bare it is still refused', () => {
    const owner = 'Is the agency fee of 450 euros normal in Catalonia?';
    expect(verdict(['Would 450 euros be a usual agency fee?'], 'unnamed', owner)).toEqual(PASS);
    expect(verdict(['Would 450 euros be a usual agency fee?'], 'unnamed', owner, false).reasons).toContain('snapshot_figure');
    expect(verdict(['Would 450 euros be a usual agency fee?'], 'general', owner).reasons).toContain('snapshot_figure');
    const large = 'Is a deposit of 30,000 euros normal for a flat?';
    expect(verdict(['Would 30,000 euros be a usual deposit for a flat?'], 'unnamed', large)).toEqual(PASS);
    expect(verdict(['Would 30,000 be a usual deposit for a flat?'], 'unnamed', large).reasons).toContain('snapshot_figure');
  });
});

describe("the owner's wording never goes out: a copied run is refused at both levels", () => {
  test('the live question copied whole, or a four-word run of it, is refused as owner_question_copy', () => {
    for (const level of ['unnamed', 'general'] as const) {
      const whole = verdict(['How are notary and registration fees usually split between buyer and seller in Catalonia?'], level);
      expect(whole.reasons).toContain('owner_question_copy');
      // Four consecutive tokens, two of them content words.
      expect(verdict(['Who decides how fees usually split between parties?'], level).reasons).toContain('owner_question_copy');
      // Four consecutive content words, function words changed around them.
      expect(verdict(['Do the notary or the registration, the fees, usually differ?'], level).reasons).toContain('owner_question_copy');
    }
    // Three words of the owner's wording are not a run.
    expect(verdict(['Who usually pays registration fees in Catalonia?'], 'unnamed')).toEqual(PASS);
  });

  test('an owner phrase gives no copy exemption against the documents either', () => {
    const owner = 'Why must the buyer sign before the notary within thirty days?';
    for (const level of ['unnamed', 'general'] as const) {
      expect(verdict(['Why must a buyer sign before the notary within thirty days?'], level, owner).reasons).toContain('owner_question_copy');
    }
  });

  test('a malformed owner field removes the check, but the copy rules still compare against the owner question in the snapshot', () => {
    const asked = ['How are notary and registration fees usually split between buyer and seller in Catalonia?'];
    expect(verdict(asked, 'unnamed', OWNER, false).reasons).toContain('shared_token_run');
    expect(verdict(asked, 'general', OWNER, false).reasons).toContain('shared_token_run');
  });
});

describe('hard identifiers stay refused at both levels even when the owner typed them', () => {
  const levels: ConsultLevel[] = ['unnamed', 'general'];

  test('an account number (IBAN)', () => {
    const owner = 'Is my deposit to ES91 2100 0418 4502 0005 1332 safe?';
    for (const level of levels) {
      expect(verdict(['Is a deposit paid to ES91 2100 0418 4502 0005 1332 safe?'], level, owner).decision).toBe('refuse');
      // Its digits alone, regrouped, are still the snapshot's account digits.
      expect(verdict(['Is a deposit paid to account 2100 0418 safe?'], level, owner).reasons).toContain('snapshot_figure');
    }
  });

  test('a street address', () => {
    const owner = 'Can I sell the flat at 12 Heron Quay before the deed is signed?';
    for (const level of levels) {
      expect(verdict(['Can an owner sell a flat at 12 Heron Quay before the deed is signed?'], level, owner).reasons).toContain('snapshot_identifier');
    }
  });

  test('an exact date and a bare year', () => {
    const owner = 'What happens to my deposit after 14 March 2025?';
    for (const level of levels) {
      const refused = verdict(['What happens to a deposit after 14 March 2025?'], level, owner);
      expect(refused.reasons).toContain('snapshot_date');
      expect(verdict(['What happens to a deposit paid in 2025?'], level, owner).reasons).toContain('snapshot_figure');
    }
  });

  test('a phone number, even split into parts and reordered', () => {
    const owner = 'The notary is on 612 345 678, what do they usually charge?';
    for (const level of levels) {
      expect(verdict(['Does a notary on 678 or 612 usually charge more?'], level, owner).reasons).toContain('snapshot_figure');
    }
  });
});

describe('the exemption covers exactly what the owner typed', () => {
  test('a snapshot name the owner did not type is still refused', () => {
    expect(verdict(['Can grace sign before a notary?'], 'unnamed').reasons).toContain('snapshot_name');
    expect(verdict(['Can the buyer sign the deed in Catalonia, as Mason did?'], 'unnamed').reasons).toContain('snapshot_name');
  });

  test("an owner word does not unlock the snapshot words next to it", () => {
    // The owner typed "Mason" alone: "Grace Mason" and "Grace" stay names.
    const owner = 'Did Mason sign the letter before the notary?';
    expect(verdict(['Did Mason sign before the notary?'], 'unnamed', owner)).toEqual(PASS);
    expect(verdict(['Did Grace Mason sign before the notary?'], 'unnamed', owner).reasons).toContain('snapshot_name');
    expect(verdict(['Did Grace sign before the notary?'], 'unnamed', owner).reasons).toContain('snapshot_name');
    // A pair the owner wrote side by side may go out as that pair.
    const pair = 'Did Grace Mason sign the letter before the notary?';
    expect(verdict(['Was it Grace Mason who signed before a notary?'], 'unnamed', pair)).toEqual(PASS);
  });

  test('exact tokens only: an inflection or a glued form of an owner word is not exempt', () => {
    expect(verdict(['Who pays the notary fees in Catalonias?'], 'unnamed').decision).toBe('refuse');
  });

  test('an empty asked field gives no exemption; a malformed one refuses the request, since the copy check cannot run', () => {
    const asked = ['Who usually pays the notary fees in Catalonia?'];
    const built = context();
    const run = (extra: Record<string, unknown>) => evaluateConsultRequest(asked, built, {}, {}, { ...DEFAULTS, level: 'unnamed', ...extra } as unknown as ConsultGateOptions);
    expect(run({ askedQuestionTexts: [] }).reasons).toContain('snapshot_name');
    for (const value of [['a', 'b', 'c', 'd', 'e'], ['x'.repeat(20_000)], [42], 'Catalonia']) {
      expect(run({ askedQuestionTexts: value })).toEqual({ decision: 'refuse', reasons: ['writer_context_malformed'] });
      expect(run({ askedQuestionTexts: [OWNER], askedQuestionFullTexts: value })).toEqual({ decision: 'refuse', reasons: ['writer_context_malformed'] });
    }
  });
});

describe('review round 1 (2026-10-08)', () => {
  test('an account number the owner typed cannot go out dressed as an amount', () => {
    const owner = 'Is account 123456 valid?';
    const documents = ['Account 123456 is in arrears.'];
    for (const level of ['unnamed', 'general'] as const) {
      expect(verdict(['Would 123456 euros cover the cost?'], level, owner, true, documents).reasons).toContain('snapshot_figure');
    }
    // Glued to letters, or a year, it is never an amount either.
    expect(verdict(['Would 1234 euros cover the cost?'], 'unnamed', 'Is policy AB1234 still valid?', true, ['Policy AB1234 lapsed.']).reasons).toContain('snapshot_figure');
    expect(verdict(['Would 2024 euros cover the cost?'], 'unnamed', 'Is a fee of 2024 euros fair?', true, ['The fee is 2024 euros.']).reasons).toContain('snapshot_figure');
    // Written with its unit on both sides, a short amount still may.
    expect(verdict(['Would 950 euros cover the cost?'], 'unnamed', 'Is a fee of 950 euros fair?', true, ['The fee is 950 euros.'])).toEqual(PASS);
  });

  test('number words do not hide a copy of the owner\'s wording', () => {
    for (const level of ['unnamed', 'general'] as const) {
      expect(verdict(['Can someone leave with 2 days notice?'], level, 'Can I leave with two days notice?').reasons).toContain('owner_question_copy');
      expect(verdict(['Can someone leave with two days notice?'], level, 'Can I leave with 2 days notice?').reasons).toContain('owner_question_copy');
    }
  });

  test('reordering does not hide a copy of the owner\'s wording', () => {
    for (const level of ['unnamed', 'general'] as const) {
      expect(verdict(['Does the seller pay the buyer a notary fee?'], level, 'Should the buyer pay the seller the notary fee?').reasons).toContain('owner_question_copy');
    }
  });

  test('the copy check reads the whole question; the exemptions only the part the writer saw', () => {
    const tail = 'How are notary fees split in Catalonia?';
    const full = `${'Please answer carefully. '.repeat(45)}${tail}`;
    const bounded = full.slice(0, 1_000);
    expect(bounded).not.toContain('Catalonia');
    const run = (questions: string[]) => evaluateConsultRequest(questions, context(full), {}, {}, { ...DEFAULTS, level: 'unnamed', askedQuestionTexts: [bounded], askedQuestionFullTexts: [full] });
    expect(run(['How are notary fees divided in a region?']).reasons).toContain('owner_question_copy');
    expect(run(['Who usually pays the notary fees in Catalonia?']).reasons).toContain('snapshot_name');
  });
});
