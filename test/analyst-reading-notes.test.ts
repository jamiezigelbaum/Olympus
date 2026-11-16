// #1590: the value is whole in the local prompt and the answer leaves it out.
// Reading notes copy the facts out of the evidence before the answer is
// written: in the same reply ('first') or in a call of their own ('pass').
// Generic: nothing here reads the question's content. Off by default.
import { expect, test } from 'bun:test';
import { analystResponseSchema, createAnalyst, type AnalystModelRequest, type AnalystReadingNotes } from '../src/core/analyst.ts';
import type { EvidencePack } from '../src/core/contracts.ts';

const pack: EvidencePack = {
  question: 'What are the deposit and the monthly rent?',
  builtAt: '2026-11-16T00:00:00Z',
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

const reply = { parts: ['deposit', 'monthly rent'], answer: 'Deposit 2,000 EUR [1]; rent 1,000 EUR [2].', citations: [{ evidence: 1, claim: 'deposit' }, { evidence: 2, claim: 'rent' }], unanswered: [], sufficient: true };
const notes = [{ evidence: 1, fact: 'Deposit: 2,000 EUR.' }, { evidence: 2, fact: 'Monthly rent: 1,000 EUR.' }, { evidence: 9, fact: 'names no item' }, { evidence: 2, fact: 'Monthly rent: 1,000 EUR.' }];

async function calls(readingNotes: AnalystReadingNotes | undefined, options: { audit?: boolean; bounded?: boolean } = {}): Promise<AnalystModelRequest[]> {
  const seen: AnalystModelRequest[] = [];
  const analyst = createAnalyst({
    complete: async (request) => {
      seen.push(request);
      const text = request.system.startsWith('You are reading evidence') ? { notes } : readingNotes === 'first' && seen.length === 1 ? { ...reply, notes } : reply;
      return { text: JSON.stringify(text), modelId: 'fixture' };
    },
  }, { evidenceFormat: 'compact', ...(readingNotes ? { readingNotes } : {}), auditSuspiciousDrafts: options.audit === true, boundedResponseSchema: options.bounded === true });
  await analyst.analyze(pack, { localOnly: true });
  return seen;
}

test('off by default: one call, and nothing in it asks for notes', async () => {
  const [only, ...rest] = await calls(undefined);
  expect(rest).toHaveLength(0);
  expect(`${only!.system}${only!.prompt}`).not.toContain('notes');
});

test("'first' asks for the facts before the answer, in the same reply, with room for them", async () => {
  const [plain] = await calls(undefined);
  const [first, ...rest] = await calls('first');
  expect(rest).toHaveLength(0);
  expect(first!.system).toContain('{"parts": string[], "notes": [{"evidence": number, "fact": string}], "answer": string,');
  expect(first!.system).toContain('- Before "answer", write "notes": every fact in the items that answers any part of the question');
  expect(first!.prompt).toBe(plain!.prompt);
  expect(first!.maxOutputChars!).toBeGreaterThan(plain!.maxOutputChars!);
});

test("'first' with the bounded schema puts notes between parts and answer, and leaves the answer's bound alone", async () => {
  const [first] = await calls('first', { bounded: true });
  const schema = first!.responseSchema as { properties: Record<string, { maxLength?: number }>; required: string[] };
  expect(Object.keys(schema.properties).slice(0, 3)).toEqual(['parts', 'notes', 'answer']);
  expect(schema.required).toContain('notes');
  expect(schema.properties.answer!.maxLength).toBe((analystResponseSchema(1_600) as typeof schema).properties.answer!.maxLength);
});

test("'pass' reads the notes out in a call of its own and hands the draft the ones that name an item", async () => {
  const [read, draft, ...rest] = await calls('pass');
  expect(rest).toHaveLength(0);
  expect(read!.system).toContain('Do not answer the question.');
  expect(read!.prompt.endsWith(`List the facts in the evidence above that answer this question: ${pack.question}`)).toBe(true);
  expect(read!.localOnly).toBe(true);
  expect(draft!.prompt).toContain('Reading notes (facts copied from the evidence; check each against its item):\n- [1] Deposit: 2,000 EUR.\n- [2] Monthly rent: 1,000 EUR.\n\nAnswer this question');
  expect(draft!.prompt).not.toContain('names no item');
  expect(draft!.system).toContain('- "Reading notes" after the evidence are facts already copied from the items.');
  expect(draft!.system).not.toContain('"notes": [');
});

for (const arm of ['first', 'pass'] as const) {
  test(`'${arm}': the audit gets the notes as a list the corrected answer must cover`, async () => {
    const audit = (await calls(arm, { audit: true })).at(-1)!;
    expect(audit.system).toContain('auditing');
    expect(audit.prompt).toContain('- [1] Deposit: 2,000 EUR.\n- [2] Monthly rent: 1,000 EUR.\nThe corrected answer states every reading note that the evidence supports and that answers the question.');
    // The draft the audit quotes is the answer contract's shape, without the notes.
    expect(audit.prompt).not.toContain('"notes"');
  });
}

test('without notes the audit prompt is unchanged', async () => {
  const audit = (await calls(undefined, { audit: true })).at(-1)!;
  expect(audit.prompt).not.toContain('Reading notes');
});
