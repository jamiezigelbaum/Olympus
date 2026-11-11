// The audit is told which amounts in the draft appear nowhere in the evidence
// the draft was written from (eval reruns 39 and 40: two amounts in no seat
// survived the audit, in every repeat). Exact detection stays in code; the
// audit decides, because an amount the answer computes from cited values is
// legitimate.
import { expect, test } from 'bun:test';
import { createAnalyst, type AnalystModelRequest } from '../src/core/analyst.ts';
import { analystPromptFixture } from './helpers/analyst-prompt-fixture.ts';

const NOTE = 'Amounts in the draft that appear nowhere in the evidence:';

async function auditPrompt(draftAnswer: string, evidenceFormat: 'full' | 'compact', seatText?: string): Promise<string> {
  const { pack } = analystPromptFixture();
  pack.candidates = pack.candidates.slice(0, 2).map((candidate, index) =>
    index === 0 && seatText ? { ...candidate, chunks: [seatText] } : candidate);
  const calls: AnalystModelRequest[] = [];
  const draft = JSON.stringify({ answer: draftAnswer, citations: [{ evidence: 1, claim: 'Recorded.' }], unanswered: [], sufficient: true });
  await createAnalyst({ complete: async (request) => { calls.push(request); return { text: draft, modelId: 'fixture' }; } },
    { evidenceFormat, auditSuspiciousDrafts: true }).analyze(pack, { localOnly: true });
  expect(calls.length).toBe(2);
  return calls[1]!.prompt;
}

for (const format of ['full', 'compact'] as const) {
  test(`${format}: an amount in no seat is named to the audit`, async () => {
    const prompt = await auditPrompt('The invoice total was €1,240.50 and the deposit $312 [1].', format, 'Invoice total 980.00 EUR, paid in May.');
    const note = prompt.split('\n').find((line) => line.startsWith(NOTE));
    expect(note).toBeDefined();
    expect(note).toContain('€1,240.50');
    expect(note).toContain('$312');
  });

  test(`${format}: an amount the evidence holds, in another separator style, is not named`, async () => {
    const prompt = await auditPrompt('The invoice total was 1,240.50 EUR [1].', format, 'Invoice total 1.240,50 EUR, paid in May.');
    expect(prompt).not.toContain(NOTE);
  });

  test(`${format}: a draft without amounts, or with only seat markers and plain counts, adds no note`, async () => {
    expect(await auditPrompt('Two reports record the survey [1, 2].', format)).not.toContain(NOTE);
    expect(await auditPrompt('There are 3 reports [2].', format)).not.toContain(NOTE);
  });
}

test('amounts are compared by their digits, whatever the separators', async () => {
  const { amountsMissingFrom } = await import('../src/core/analyst.ts');
  expect(amountsMissingFrom('Total €1,240.50 and 12.5 kg', 'Total 1 240,50 EUR; weight 12.50 kg')).toEqual([]);
  expect(amountsMissingFrom('Paid €80 for 3 items [2]', 'Paid 80 EUR')).toEqual([]);
  expect(amountsMissingFrom('Paid €81.20', 'Paid 80 EUR, 1.20 fee')).toEqual(['€81.20']);
});

test('amounts that differ by orders of magnitude stay apart', async () => {
  const { amountsMissingFrom } = await import('../src/core/analyst.ts');
  expect(amountsMissingFrom('Paid €800', 'Paid 8 EUR')).toEqual(['€800']);
  expect(amountsMissingFrom('Total €12.50', 'Total 125 EUR')).toEqual(['€12.50']);
  expect(amountsMissingFrom('Total €1,240', 'Total 1240 EUR')).toEqual([]);
  expect(amountsMissingFrom('Total 1.240', 'Total 1240 EUR')).toEqual([]);
  expect(amountsMissingFrom('Total €1,24', 'Total 1.24 EUR')).toEqual([]);
  expect(amountsMissingFrom('Total €1,24', 'Total 124 EUR')).toEqual(['€1,24']);
});

test('a space-grouped number in the evidence is one value, not its fragments', async () => {
  const { amountsMissingFrom } = await import('../src/core/analyst.ts');
  expect(amountsMissingFrom('Paid €240.50', 'Paid 1 240,50 EUR')).toEqual(['€240.50']);
  expect(amountsMissingFrom('Paid €1,240.50', 'Paid 1 240,50 EUR')).toEqual([]);
  expect(amountsMissingFrom('Pages 12.5', 'pages 12 5')).toEqual(['12.5']);
});
