// Copied document wording at the "Your situation, without names" (Standard)
// level (owner ruling 2026-10-08, after the PII bake-off): a copy of the
// documents may go out unless it carries a hard identifier; a copy of the
// question ChatGPT sent is still refused at both levels; the "general"
// (Strict) level is unchanged. The rule: consult-gate.ts,
// CONSULT_GATE_UNNAMED_COPIED_WORDING_MAY_PASS.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { EvidencePack } from '../src/core/contracts.ts';
import { consultWriterContextFromPack, evaluateConsultRequest, type ConsultGateVerdict, type ConsultLevel } from '../src/core/consult-gate.ts';
import { consultLeakCorpora } from '../eval/consult-leak/corpus.ts';
import { runFalseRefusals } from '../eval/consult-leak/false-refusals.ts';
import { runConsultLeakEval } from '../eval/consult-leak/run.ts';
import { UNNAMED_SET_RECORDING_PATH, runRecordedUnnamedSet, runUnnamedLevelEval, sentenceInitialNameResidual, unnamedCaseContext } from '../eval/consult-leak/unnamed-level.ts';
import { UNNAMED_CASES } from '../eval/consult-leak/unnamed-questions.ts';

const QUESTION = 'Can my landlord keep my deposit?';
const PASS: ConsultGateVerdict = { decision: 'pass', reasons: [] };

function context(documents: string[], answer = 'The landlord says they will keep the deposit.') {
  const pack: EvidencePack = {
    question: QUESTION,
    candidates: documents.map((text, index) => ({
      provenance: { sourceItem: { family: 'file' as const, provider: 'synthetic', accountScope: 'acct', providerItemId: `item-${index}`, localItemId: `local-item-${index}` }, citation: { title: 'Notes' } },
      trustTier: 'S4' as const,
      trustDomain: 'secure_local' as const,
      chunks: [text],
    })),
    coverage: { searchedCorpora: ['secure_local.synthetic'], skippedCorpora: [], extractionGaps: [] },
    builtAt: '2026-10-08T09:00:00.000Z',
  };
  return consultWriterContextFromPack(pack, { writerVisibleTexts: [QUESTION], writerAnswerTexts: [answer] });
}

const verdict = (questions: string[], level: ConsultLevel, documents: string[], asked: string = QUESTION) =>
  evaluateConsultRequest(questions, context(documents), {}, {}, { languages: ['en'], level, askedQuestionTexts: [asked] });

describe('copied document wording at the unnamed level', () => {
  test('a copy of the documents without an identifier goes out at unnamed and is refused at general', () => {
    const documents = ['The tenant must give notice in writing to the agent. The deposit is held by the landlord.'];
    const copy = ['The tenant must give notice in writing to the agent. Is email enough?'];
    expect(verdict(copy, 'unnamed', documents)).toEqual(PASS);
    expect(verdict(copy, 'general', documents).reasons).toContain('shared_token_run');
  });

  test('a copied run holding a snapshot name written in lower case is refused, though the same word outside a copy passes', () => {
    // "Mason" is a dictionary word the documents also write in lower case: on
    // its own the unnamed level takes it for an ordinary word (accepted
    // residual); inside copied wording it is a name.
    const documents = ['The boiler repair was signed off by Mason after the inspection. The mason also repointed the garden wall.'];
    const copied = verdict(['The boiler repair was signed off by mason after the inspection. Is that valid?'], 'unnamed', documents);
    expect(copied.decision).toBe('refuse');
    expect(copied.reasons).toContain('snapshot_name');
    expect(copied.reasons).not.toContain('shared_token_run');
    expect(verdict(['Is work signed off by a mason valid?'], 'unnamed', documents)).toEqual(PASS);
    // The same copy without the name goes out.
    expect(verdict(['The boiler repair was signed off after the inspection. Is that valid?'], 'unnamed', documents)).toEqual(PASS);
  });

  test('a copied run holding a place the documents name is refused', () => {
    const documents = ['The tenant moved to Bath after the lease ended and the landlord kept the deposit. A bath was replaced.'];
    const copied = verdict(['The tenant moved to bath after the lease ended. Can the deposit be kept?'], 'unnamed', documents);
    expect(copied.decision).toBe('refuse');
    expect(copied.reasons).toContain('snapshot_name');
  });

  test('a copied run holding an address, a date or an account number is refused', () => {
    const address = verdict(['The keys were left with the agent at 14 Harbour Road. Was that enough?'], 'unnamed',
      ['The keys were left with the agent at 14 Harbour Road before the inspection.']);
    expect(address.decision).toBe('refuse');
    expect(address.reasons).toContain('snapshot_identifier');
    const date = verdict(['The tenant gave notice on 3 March 2025 by email. Was that valid?'], 'unnamed',
      ['The tenant gave notice on 3 March 2025 by email to the landlord.']);
    expect(date.decision).toBe('refuse');
    expect(date.reasons).toContain('snapshot_date');
    const year = verdict(['The tenant gave notice in 2025 by email to the landlord. Was that valid?'], 'unnamed',
      ['The tenant gave notice in 2025 by email to the landlord.']);
    expect(year.decision).toBe('refuse');
    expect(year.reasons).toContain('snapshot_figure');
    const amount = verdict(['The landlord kept 1,850 euros of the deposit for cleaning. Is that fair?'], 'unnamed',
      ['The landlord kept 1,850 euros of the deposit for cleaning.']);
    expect(amount.decision).toBe('refuse');
    expect(amount.reasons).toContain('snapshot_figure');
    const account = verdict(['Pay the balance into account 4471 9020 5532 before the move?'], 'unnamed',
      ['Pay the balance into account 4471 9020 5532 before the move.']);
    expect(account.decision).toBe('refuse');
    expect(account.reasons.length).toBeGreaterThan(0);
    expect(account.reasons).not.toContain('shared_token_run');
  });

  test('copying the question ChatGPT sent is still refused at both levels', () => {
    const asked = 'What did the letting agent say about returning my deposit after I moved out?';
    const documents = ['The letting agent said the deposit would be returned after the inspection.'];
    for (const level of ['unnamed', 'general'] as const) {
      expect(verdict(['What did the letting agent say about returning a deposit?'], level, documents, asked).reasons).toContain('owner_question_copy');
    }
  });

  test('a copy of the owner question as the evidence pack holds it is still refused at unnamed without the asked field', () => {
    const built = context(['The deposit is held by the landlord.']);
    const copy = ['Generally, can my landlord keep my deposit at all?'];
    for (const level of ['unnamed', 'general'] as const) {
      expect(evaluateConsultRequest(copy, built, {}, {}, { languages: ['en'], level }).reasons).toContain('shared_token_run');
    }
  });

  test('the situation questions the copy rule refused no longer carry it at unnamed, and every leak variant of those cases stays refused', () => {
    // Refused only as `shared_token_run` on main before this change.
    const ids = ['tax-home-office', 'flight-delay', 'gym-contract', 'warranty-laptop', 'child-maintenance', 'credit-card-fraud'];
    for (const id of ids) {
      const entry = UNNAMED_CASES.find((candidate) => candidate.id === id)!;
      const built = unnamedCaseContext(entry);
      const run = (questions: readonly string[]) => evaluateConsultRequest(questions, built, {}, {}, { languages: ['en'], level: 'unnamed', askedQuestionTexts: [entry.userQuestion] });
      for (const question of entry.questions) {
        const result = run([question]);
        expect({ id, reasons: result.reasons.filter((reason) => reason === 'shared_token_run') }).toEqual({ id, reasons: [] });
        // One question is held back by a separate, older rule: "Three" written
        // only at sentence starts in its documents reads as a possible name.
        if (id === 'credit-card-fraud') expect(result.reasons).toEqual(['snapshot_name']);
        else expect({ id, result }).toEqual({ id, result: PASS });
      }
      for (const leak of entry.leaks) expect({ id, kind: leak.kind, decision: run(leak.questions).decision }).toEqual({ id, kind: leak.kind, decision: 'refuse' });
    }
  });
});

describe('the general level is unchanged', () => {
  // Every general-level verdict over the existing fixtures, digested. Pinned
  // from main before the unnamed copy change (aa6eb887 + #195/#196); a change
  // here means the general level moved, which this rule must not do.
  const GENERAL_FIXTURE_DIGEST = '2b7b744661cbf7c7f6ec4b67cd39477f35692798fc577a6f8329412718f94cd5';

  test('every general-level verdict over the leak corpus, held-out sets, probes, situation set, recordings and false-refusal set is byte-identical', () => {
    const leak = runConsultLeakEval(consultLeakCorpora(), 'general');
    const recorded = runRecordedUnnamedSet(JSON.parse(readFileSync(UNNAMED_SET_RECORDING_PATH, 'utf8')));
    const payload = JSON.stringify({
      leak: leak.results.map((row) => [row.corpus, row.id, row.decision, row.reasons]),
      heldOut: leak.cleanRefusals,
      probes: leak.probes,
      situation: runUnnamedLevelEval().rows.filter((row) => row.level === 'general').map((row) => [row.case, row.kind, row.questions, row.decision, row.reasons]),
      recorded: recorded.rows.map((row) => [row.case, row.general]),
      residual: sentenceInitialNameResidual().general,
      falseRefusals: runFalseRefusals().map((row) => [row.config, row.category, row.question, row.decision, row.reasons]),
    });
    expect(createHash('sha256').update(payload).digest('hex')).toBe(GENERAL_FIXTURE_DIGEST);
  }, 120_000);
});
