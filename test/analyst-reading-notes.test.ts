// Reading notes (#1590, retrieval research idea 2): the local answer model
// first lists every fact and value in the evidence that bears on the
// question, each with its evidence number, then writes the answer from that
// list. gbrain measured this pattern at +7.8 points paired. Generic: one
// prompt for every question; nothing here reads the question's content.
import { expect, test } from 'bun:test';
import { analystResponseSchema, createAnalyst, type AnalystModelRequest } from '../src/core/analyst.ts';
import type { EvidencePack } from '../src/core/contracts.ts';

const pack: EvidencePack = {
  question: 'What are the deposit and the monthly rent?',
  builtAt: '2026-11-13T00:00:00Z',
  coverage: { searchedCorpora: ['fixture'], skippedCorpora: [], extractionGaps: [] },
  candidates: [1, 2].map((n) => ({
    provenance: {
      sourceItem: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: `i${n}`, localItemId: `i${n}` },
      citation: { title: `Lease ${n}` },
    },
    trustTier: 'S2',
    trustDomain: 'internal',
    chunks: [n === 1 ? 'Deposit: 2,000 EUR.' : 'Monthly rent: 1,000 EUR.'],
  })),
};

const reply = (extra: Record<string, unknown> = {}) => JSON.stringify({
  ...extra,
  answer: 'Deposit 2,000 EUR [1]; rent 1,000 EUR [2].',
  citations: [{ evidence: 1, claim: 'deposit' }, { evidence: 2, claim: 'rent' }],
  unanswered: [],
  sufficient: true,
});

async function compactRequest(): Promise<AnalystModelRequest> {
  let seen: AnalystModelRequest | undefined;
  await createAnalyst({
    complete: async (request) => { seen = request; return { text: reply(), modelId: 'fixture' }; },
  }, { evidenceFormat: 'compact' }).analyze(pack, { localOnly: true });
  return seen!;
}

test('the compact reply lists the relevant facts with their evidence numbers before the answer, and answers from them', async () => {
  const { system } = await compactRequest();
  expect(system).toContain('{"notes": [{"evidence": number, "fact": string}], "answer": string,');
  expect(system).toContain('"notes" lists every fact, value, name and date in the evidence that bears on the question, each with its evidence number, before you write "answer"; then write "answer" from the notes, giving every noted value the question asks for.');
});

test('the bounded schema asks for the notes first, bounded inside the output budget, and a reply with notes parses as before', async () => {
  const schema = analystResponseSchema(1_200) as { properties: Record<string, any>; required: string[] };
  expect(Object.keys(schema.properties)[0]).toBe('notes');
  expect(schema.required[0]).toBe('notes');
  const notes = schema.properties.notes;
  expect(notes.items.required).toEqual(['evidence', 'fact']);
  // Notes are generated tokens: their worst case stays a minor share of the budget.
  expect(notes.maxItems * notes.items.properties.fact.maxLength).toBeLessThanOrEqual(1_200 * 0.4);
  const result = await createAnalyst({
    complete: async () => ({ text: reply({ notes: [{ evidence: 1, fact: 'Deposit 2,000 EUR' }, { evidence: 2, fact: 'Rent 1,000 EUR' }] }), modelId: 'fixture' }),
  }, { evidenceFormat: 'compact' }).analyze(pack, { localOnly: true });
  expect(result.answer).toContain('rent 1,000 EUR');
  expect(JSON.stringify(result)).not.toContain('"notes"');
});
