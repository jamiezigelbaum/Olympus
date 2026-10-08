// Words the owner typed (owner ruling 2026-10-08): at the "unnamed"
// (Standard) level a word or phrase of the owner's own question is exempt
// from the snapshot name, copy and figure rules; hard identifiers stay
// refused at both levels, and the "general" (Strict) level is unchanged.
// The rule: consult-gate.ts, CONSULT_GATE_OWNER_WORDS_MAX_FIGURE_RUN_DIGITS.

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

// `owner`: the owner's question (in the snapshot as always); `exempt`: whether it is also passed as ownerQuestionTexts.
function verdict(questions: string[], level: ConsultLevel, owner: string = OWNER, exempt = true) {
  const options: ConsultGateOptions = { ...DEFAULTS, level, ...(exempt ? { ownerQuestionTexts: [owner] } : {}) };
  return evaluateConsultRequest(questions, context(owner), {}, {}, options);
}

const PASS: ConsultGateVerdict = { decision: 'pass', reasons: [] };

describe('a word the owner typed may go out at the unnamed level', () => {
  test('the Catalonia case passes at unnamed and is still refused at general', () => {
    const asked = ['How are notary and registration fees usually split between buyer and seller in Catalonia?'];
    expect(verdict(asked, 'unnamed')).toEqual(PASS);
    // Without the owner's words, the same request is refused as before.
    // (the gate stops at its first reason: here the copy of the owner's question).
    expect(verdict(asked, 'unnamed', OWNER, false).reasons).toContain('shared_token_run');
    expect(verdict(['Who usually pays the notary fees in Catalonia?'], 'unnamed', OWNER, false).reasons).toContain('snapshot_name');
    const strict = verdict(asked, 'general');
    expect(strict.decision).toBe('refuse');
    expect(verdict(['Who usually pays the notary fees in Catalonia?'], 'general').reasons).toContain('snapshot_name');
    // The general level ignores the owner's words entirely.
    expect(strict).toEqual(verdict(asked, 'general', OWNER, false));
    // A shorter request with the owner's place name passes too.
    expect(verdict(['Who usually pays the notary fees in Catalonia?'], 'unnamed')).toEqual(PASS);
  });

  test('an owner phrase copied whole is not a copy; one document word beyond it is', () => {
    const owner = 'Why must the buyer sign before the notary within thirty days?';
    expect(verdict(['Why must a buyer sign before the notary within thirty days?'], 'unnamed', owner)).toEqual(PASS);
    expect(verdict(['Why must a buyer sign before the notary within thirty days?'], 'unnamed', owner, false).reasons).toContain('shared_token_run');
    expect(verdict(['Why must a buyer sign before the notary within thirty days of acceptance?'], 'unnamed', owner).reasons).toContain('shared_token_run');
  });

  test('an amount the owner typed with its currency may go out; written bare it is still refused', () => {
    const owner = 'Is the agency fee of 450 euros normal in Catalonia?';
    expect(verdict(['Is an agency fee of 450 euros normal in Catalonia?'], 'unnamed', owner)).toEqual(PASS);
    expect(verdict(['Is a fee of 450 euros usual for an agency?'], 'unnamed', owner)).toEqual(PASS);
    expect(verdict(['Is a fee of 450 euros usual for an agency?'], 'unnamed', owner, false).reasons).toContain('snapshot_figure');
    expect(verdict(['Is an agency fee of 450 euros normal in Catalonia?'], 'general', owner).reasons).toContain('snapshot_figure');
    const large = 'Is a deposit of 30,000 euros normal for a flat?';
    expect(verdict(['Is a deposit of 30,000 euros normal for a flat?'], 'unnamed', large)).toEqual(PASS);
    expect(verdict(['Is a deposit of 30,000 normal for a flat?'], 'unnamed', large).reasons).toContain('snapshot_figure');
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
    expect(verdict(['Did Grace Mason sign before the notary?'], 'unnamed', pair)).toEqual(PASS);
  });

  test('exact tokens only: an inflection or a glued form of an owner word is not exempt', () => {
    expect(verdict(['Who pays the notary fees in Catalonias?'], 'unnamed').decision).toBe('refuse');
  });

  test('a malformed owner field only removes the exemption', () => {
    const asked = ['Who usually pays the notary fees in Catalonia?'];
    const built = context();
    for (const ownerQuestionTexts of [[], ['a', 'b', 'c', 'd', 'e'], ['x'.repeat(20_000)], [42], 'Catalonia']) {
      const options = { ...DEFAULTS, level: 'unnamed', ownerQuestionTexts } as unknown as ConsultGateOptions;
      expect(evaluateConsultRequest(asked, built, {}, {}, options).reasons).toContain('snapshot_name');
    }
  });
});
