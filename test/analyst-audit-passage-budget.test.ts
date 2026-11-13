// #1590: the compact audit read each candidate through a 1,200-character
// window while the draft it checks had the whole fitted passage, so the audit
// could rewrite the answer from less evidence than the draft had. With a
// recorded prompt budget the audit now starts from the passages the main call
// sent and shrinks them only as far as the budget needs.
import { expect, test } from 'bun:test';
import { createAnalyst, withPromptBudget, type AnalystModelRequest } from '../src/core/analyst.ts';
import type { EvidencePack } from '../src/core/contracts.ts';

const filler = Array.from({ length: 60 }, (_, index) => `Clause ${index} covers general terms of the agreement.`).join(' ');
const pack: EvidencePack = {
  question: 'What is the deposit on the lease?',
  builtAt: '2026-11-13T00:00:00Z',
  coverage: { searchedCorpora: ['fixture'], skippedCorpora: [], extractionGaps: [] },
  candidates: [{
    provenance: {
      sourceItem: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: 'lease', localItemId: 'lease' },
      citation: { title: 'Lease' },
    },
    trustTier: 'S2',
    trustDomain: 'internal',
    chunks: [`Lease deposit terms. ${filler} Amount held: 2,000 EUR, paid on signing.`],
  }],
};

async function auditPrompt(sent: EvidencePack): Promise<AnalystModelRequest> {
  const calls: AnalystModelRequest[] = [];
  const analyst = createAnalyst({
    complete: async (request) => {
      calls.push(request);
      return { text: JSON.stringify({ answer: 'The lease names a deposit [1].', citations: [{ evidence: 1, claim: 'deposit' }], unanswered: [], sufficient: true }), modelId: 'fixture' };
    },
  }, { evidenceFormat: 'compact', auditSuspiciousDrafts: true });
  await analyst.analyze(sent, { localOnly: true });
  expect(calls).toHaveLength(2);
  return calls[1]!;
}

test('with room in the budget, the audit reads the whole passage the draft read', async () => {
  expect(pack.candidates[0]!.chunks[0]!.length).toBeGreaterThan(2_400);
  const audit = await auditPrompt(withPromptBudget(pack, 27_000));
  expect(audit.prompt).toContain('Amount held: 2,000 EUR, paid on signing.');
});

test('a tight budget still holds the whole audit call', async () => {
  const budget = 4_000;
  const audit = await auditPrompt(withPromptBudget(pack, budget));
  expect(Buffer.byteLength(`${audit.system}\n\n${audit.prompt}`)).toBeLessThanOrEqual(budget);
});
