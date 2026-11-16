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

// Batches (lane 2's "read every match"): a pack too large for one call is
// read batch by batch for notes; one draft and one audit answer from the
// item lines and the merged notes.
const wide: EvidencePack = { ...pack, candidates: [1, 2, 3, 4, 5].map((n) => ({ ...pack.candidates[0]!,
  provenance: { ...pack.candidates[0]!.provenance, sourceItem: { ...pack.candidates[0]!.provenance.sourceItem, providerItemId: `w${n}`, localItemId: `w${n}` }, citation: { title: `File ${n}` } },
  chunks: [`Text of file ${n}: fee ${n}00 EUR.`] })) };

async function batchedCalls(batches: number[][], noteCount = 1): Promise<{ seen: AnalystModelRequest[]; result: Awaited<ReturnType<ReturnType<typeof createAnalyst>['analyze']>> }> {
  const { withEvidenceBatches, withPromptBudget } = await import('../src/core/analyst.ts');
  const seen: AnalystModelRequest[] = [];
  const analyst = createAnalyst({
    complete: async (request) => {
      seen.push(request);
      if (!request.system.startsWith('You are reading evidence')) return { text: JSON.stringify({ ...reply, citations: [{ evidence: 4, claim: 'fee' }] }), modelId: 'fixture' };
      const shown = [...request.prompt.matchAll(/^\[(\d+)\] File/gm)].map((match) => Number(match[1]));
      return { text: JSON.stringify({ notes: [...shown.flatMap((n) => Array.from({ length: noteCount }, (_, k) => ({ evidence: n, fact: `fee ${n}00 EUR (${k})` }))), { evidence: 1, fact: 'from another batch' }] }), modelId: 'fixture' };
    },
  }, { evidenceFormat: 'compact', auditSuspiciousDrafts: true });
  // The budget recorded after the batches must not drop them.
  const result = await analyst.analyze(withPromptBudget(withEvidenceBatches(wide, batches), 27_000), { localOnly: true });
  return { seen, result };
}

test('batches: one notes call per batch, each showing only its items under their whole-pack numbers', async () => {
  const { seen } = await batchedCalls([[0, 1], [2, 3], [4]]);
  expect(seen.map((request) => request.system.slice(0, 24))).toEqual(['You are reading evidence', 'You are reading evidence', 'You are reading evidence', 'You are an evidence anal', 'You are auditing an evid']);
  expect(seen[1]!.prompt).toContain('[3] File 3');
  expect(seen[1]!.prompt).toContain('Text of file 4');
  expect(seen[1]!.prompt).not.toContain('File 1');
  expect(seen[1]!.prompt).not.toContain('File 5');
});

test('batches: the draft and the audit get every item line and the merged notes, not the text', async () => {
  const { seen, result } = await batchedCalls([[0, 1], [2, 3], [4]]);
  for (const request of seen.slice(3)) {
    for (const n of [1, 2, 3, 4, 5]) expect(request.prompt).toContain(`[${n}] File ${n}`);
    expect(request.prompt).not.toContain('Text of file');
    expect(request.prompt).toContain("Reading notes (facts copied from each item's text, which is not shown here):\n- [1] fee 100 EUR (0)\n- [2] fee 200 EUR (0)\n- [1] from another batch\n- [3] fee 300 EUR (0)\n- [4] fee 400 EUR (0)\n- [5] fee 500 EUR (0)\n");
  }
  expect(seen[3]!.system).toContain('- The items are too many to show their text at once.');
  // A note about an item its batch did not show is dropped: only the first batch, which showed [1], keeps its note.
  expect(seen[3]!.prompt.match(/from another batch/g)?.length).toBe(1);
  expect(seen[4]!.prompt).toContain("The candidates' text is not shown");
  expect(result.citations.map((citation) => citation.provenance.sourceItem.providerItemId)).toEqual(['w4']);
  expect(result.unanswered.join(' ')).not.toContain('batches held more');
});

test('batches: the note limit is per batch, and a batch that held more says so in the answer\'s gaps', async () => {
  const { seen, result } = await batchedCalls([[0, 1, 2, 3], [4]], 4);
  expect(seen[2]!.prompt.match(/^- \[/gm)?.length).toBe(12 + 4);
  expect(result.unanswered).toContain('Olympus carried 12 facts from each batch of items into this answer; 1 of 2 batches held more, so some facts may be missing.');
});

test('batches must place every candidate exactly once; one batch answers the pack whole', async () => {
  const { withEvidenceBatches } = await import('../src/core/analyst.ts');
  for (const bad of [[[0, 1], [1, 2, 3, 4]], [[0, 1, 2, 3]], [[0, 1, 2, 3, 4], []], [[0, 1, 2, 3, 5], [4]]]) expect(() => withEvidenceBatches(wide, bad)).toThrow('Evidence batches must place every candidate in exactly one batch.');
  const { seen } = await batchedCalls([[0, 1, 2, 3, 4]]);
  expect(seen).toHaveLength(2);
  expect(seen[0]!.prompt).toContain('Text of file 5');
});

test("the Delphi model reports the server's counts and times, cached prompt tokens included", async () => {
  const { delphiUsage } = await import('../src/core/analyst-delphi.ts');
  expect(delphiUsage({ prompt_n: 12, prompt_ms: 30.4, predicted_n: 5, predicted_ms: 99.6, cache_n: 4000 }, undefined)).toEqual({ promptTokens: 12, promptMs: 30, outputTokens: 5, outputMs: 100, cachedTokens: 4000 });
  expect(delphiUsage(undefined, { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } })).toEqual({ promptTokens: 7, outputTokens: 3, cachedTokens: 2 });
  expect(delphiUsage(undefined, undefined)).toBeUndefined();
});
