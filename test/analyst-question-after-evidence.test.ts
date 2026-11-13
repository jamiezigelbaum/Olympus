// #1590: in the local (compact) answer call the value was in the prompt but
// the draft left it out. A small model reading a long evidence list loses
// the question at its head, so the compact prompt asks it again after the
// evidence, and the system rule asks for every requested part the cited
// items hold. Generic: nothing here reads the question's content.
import { expect, test } from 'bun:test';
import { analystPromptBytes, createAnalyst, type AnalystModelRequest } from '../src/core/analyst.ts';
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

async function compactRequest(): Promise<AnalystModelRequest> {
  let seen: AnalystModelRequest | undefined;
  const analyst = createAnalyst({
    complete: async (request) => {
      seen = request;
      return { text: JSON.stringify({ answer: 'Deposit 2,000 EUR [1]; rent 1,000 EUR [2].', citations: [{ evidence: 1, claim: 'deposit' }, { evidence: 2, claim: 'rent' }], unanswered: [], sufficient: true }), modelId: 'fixture' };
    },
  }, { evidenceFormat: 'compact' });
  await analyst.analyze(pack, { localOnly: true });
  return seen!;
}

test('the compact prompt asks the question again after the evidence', async () => {
  const { prompt } = await compactRequest();
  expect(prompt.startsWith(`Question: ${pack.question}`)).toBe(true);
  const restated = prompt.lastIndexOf(pack.question);
  expect(restated).toBeGreaterThan(prompt.lastIndexOf('Monthly rent: 1,000 EUR.'));
  expect(restated).toBeGreaterThan(prompt.lastIndexOf('Coverage'));
});

test('the restated question is counted in the prompt budget', () => {
  const once = analystPromptBytes({ ...pack, question: 'q' }, { localOnly: true }, 'compact');
  const longer = analystPromptBytes({ ...pack, question: 'q'.repeat(101) }, { localOnly: true }, 'compact');
  expect(longer - once).toBe(200);
});
