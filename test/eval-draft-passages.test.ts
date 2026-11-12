import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { fixtureConnector } from './helpers/tier-fixtures.ts';
import { openEvalDataRoot } from '../eval/data-root.ts';
import { storedChunkCounter } from '../eval/run-passages.ts';
import { degradedLabel, draftPassageQuestions, localDraftModel, parseMinimums, sampleDraftItems, writeDraftQuestionSet } from '../eval/draft-passage-questions.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function world() {
  const root = mkdtempSync(join(tmpdir(), 'eval-draft-')); dirs.push(root);
  for (const [family, tier, size] of [['file', 'internal', 8], ['email', 'internal', 2], ['file', 'secure_local', 2], ['email', 'secure_local', 2]] as const) {
    const path = join(root, `${family}-${tier}.sqlite`);
    const store = new LocalConnectorStore({ dbPath: path, corpusId: `${tier}.fixture.${family}`, family: 'file', trustDomain: tier, tierLedger: null });
    await store.syncFromConnector(fixtureConnector(() => Array.from({ length: size }, (_, i) => ({ id: String(i), name: 'Synthetic', text: `The Kestrel invoice total is forty seven dollars payable Tuesday. Entry ${i}.` }))), { fetchContent: true });
    store.close();
    const db = new Database(path); db.query('UPDATE items SET family = ?').run(family); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();
    const ledger = new TierLedger({ dbPath: tierLedgerPathForStore(path) });
    for (let i = 0; i < size - 1; i++) ledger.recordDecision({ provider: 'fixture', accountScope: 'personal', providerItemId: String(i), family }, {
      metadataTier: tier === 'internal' ? 'private' : 'secure', contentTier: tier === 'internal' ? 'private' : 'secure', metadataPending: false, contentPending: false, metadataForced: false, metadataFlagged: false, contentRead: true,
      state: 'current', snifferId: 'synthetic', decidedBy: 'sniffer', reasons: [], engineVersion: 'fixture', mapRevision: 'fixture',
    });
    ledger.close();
  }
  Bun.gc(true);
  return openEvalDataRoot({ dataRoot: root });
}
test('balanced eligible sampling, local sequential requests, quote verification, alternates and deterministic splits', async () => {
  const opened = await world();
  let active = 0; let peak = 0; let requests = 0; let paraphrases = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    active++; peak = Math.max(peak, active);
    try {
      const body = await request.json() as { messages: { content: string }[] };
      const prompt = body.messages.at(-1)!.content; requests++;
      if (prompt.includes('PARAPHRASE')) paraphrases++;
      const result = prompt.includes('UNANSWERABLE')
        ? { questions: Array.from({ length: 5 }, (_, i) => `Where are the nonexistent orchid records number ${i}?`) }
        : { question: 'What amount should be paid for that boatyard bill?', quote: requests === 1 ? 'This fabricated quotation is not in the synthetic item' : 'The Kestrel invoice total is forty seven dollars payable Tuesday' };
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
    } finally { active--; }
  } });
  try {
    const samples = sampleDraftItems(opened, 4, 'fixture');
    const buckets = new Set(samples.map(item => `${item.family}:${item.tier}`));
    expect(buckets.size).toBe(4);
    expect(samples.filter(item => item.family !== 'file' || item.tier !== 'internal').every(item => item.providerItemId === '0')).toBe(true);
    expect(samples.some(item => item.family === 'file' && item.tier === 'internal' && item.providerItemId === '7')).toBe(false);
    expect(sampleDraftItems(opened, 4, 'fixture')).toEqual(samples);
    const input = { opened, count: 4, seed: 'fixture', model: localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' }) };
    const first = await draftPassageQuestions(input);
    expect(first.dataset.questions.filter(q => q.shape !== 'coverage_negative')).toHaveLength(3);
    expect(first.dataset.questions.filter(q => q.shape === 'coverage_negative')).toHaveLength(5);
    expect(first.dataset.questions.find(q => q.expectedEvidence)?.expectedEvidence![0]!.alternates!.length).toBeGreaterThan(0);
    expect(peak).toBe(1); expect(paraphrases).toBe(2);
    requests = 0;
    const second = await draftPassageQuestions(input);
    expect(first.dataset).toEqual(second.dataset);
    expect(first.dataset.questions.filter(q => q.split === 'sealed')).toHaveLength(Math.floor(first.dataset.questions.length / 3));
    const outputRoot = mkdtempSync(join(tmpdir(), 'eval-draft-output-')); dirs.push(outputRoot);
    const printedRows: string[] = [];
    writeDraftQuestionSet(join(outputRoot, 'questions.json'), first, row => printedRows.push(row));
    expect(JSON.parse(readFileSync(join(outputRoot, 'questions.json'), 'utf8'))).toEqual(first.dataset);
    expect(printedRows).toEqual([JSON.stringify(first.counts)]);
    const printed = printedRows.join('\n');
    for (const secret of ['Kestrel', 'invoice', 'boatyard', 'Tuesday', 'orchid']) expect(printed).not.toContain(secret);
  } finally { server.stop(true); opened.close(); }
});
test('cloud endpoints are rejected before a model request', () => {
  expect(() => localDraftModel({ baseUrl: 'https://api.openai.com/v1', model: 'anything' })).toThrow('local');
});
test('a draft set written over an existing readable file is private afterwards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-draft-mode-')); dirs.push(dir);
  const output = join(dir, 'questions.json');
  writeFileSync(output, '{}', { mode: 0o644 }); chmodSync(output, 0o644);
  const result = { dataset: { version: '2', description: '', questions: [] }, counts: {} } as unknown as Parameters<typeof writeDraftQuestionSet>[1];
  writeDraftQuestionSet(output, result, () => {});
  expect(statSync(output).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir)).toEqual(['questions.json']);
});
test('each proposed negative is checked against its own top passages, and one the model can answer is dropped', async () => {
  const opened = await world();
  const checked: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body = await request.json() as { messages: { content: string }[] };
    const prompt = body.messages.at(-1)!.content;
    let result: unknown;
    if (prompt.includes('NEGATIVE CHECK')) {
      checked.push(prompt);
      // Number 0 is "answerable"; number 1 gets an unreadable reply, which also drops it.
      if (prompt.includes('number 1?')) return Response.json({ choices: [{ message: { content: 'not json' } }] });
      result = { answerable: prompt.includes('number 0?') };
    } else if (prompt.includes('UNANSWERABLE')) result = { questions: Array.from({ length: 6 }, (_, i) => `Where are the nonexistent orchid records number ${i}?`) };
    else result = { question: 'What amount should be paid for that boatyard bill?', quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  try {
    const passagesFor: string[] = [];
    const result = await draftPassageQuestions({ opened, count: 4, seed: 'fixture', model: localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' }),
      negativePassages: async question => { passagesFor.push(question); return { passages: ['A synthetic retrieved passage about the garden fence.'] }; } });
    expect(passagesFor).toHaveLength(6);
    expect(checked).toHaveLength(6);
    expect(checked.every(prompt => prompt.includes('A synthetic retrieved passage'))).toBe(true);
    const negatives = result.dataset.questions.filter(q => q.shape === 'coverage_negative');
    expect(negatives).toHaveLength(4);
    expect(negatives.every(q => !q.question.includes('number 0?') && !q.question.includes('number 1?'))).toBe(true);
    expect(result.counts).toMatchObject({ unanswerable: 6, negativesKept: 4, negativesDropped: 2, negativesUnchecked: 0 });
  } finally { server.stop(true); opened.close(); }
});
test('a negative whose retrieval came back incomplete is kept only as unchecked, never certified', async () => {
  const opened = await world();
  const checked: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body = await request.json() as { messages: { content: string }[] };
    const prompt = body.messages.at(-1)!.content;
    let result: unknown;
    if (prompt.includes('NEGATIVE CHECK')) { checked.push(prompt); result = { answerable: false }; }
    else if (prompt.includes('UNANSWERABLE')) result = { questions: Array.from({ length: 5 }, (_, i) => `Where are the nonexistent orchid records number ${i}?`) };
    else result = { question: 'What amount should be paid for that boatyard bill?', quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  try {
    // Number 2's retrieval left a store out every time, so its passages cannot certify it.
    const calls = new Map<string, number>();
    const result = await draftPassageQuestions({ opened, count: 4, seed: 'fixture', model: localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' }),
      negativeRetryMs: 0,
      negativePassages: async question => {
        calls.set(question, (calls.get(question) ?? 0) + 1);
        return { passages: ['A synthetic retrieved passage about the garden fence.'], degraded: question.includes('number 2?') ? ['internal.telegram:connector_store_vector:deadline'] : [] };
      } });
    // The degraded check is retried once, then still read on what came back: not answerable there keeps it, unchecked.
    expect([...calls].filter(([question]) => question.includes('number 2?')).map(([, n]) => n)).toEqual([2]);
    expect(checked).toHaveLength(5);
    const negatives = result.dataset.questions.filter(q => q.shape === 'coverage_negative');
    expect(negatives.find(q => q.question.includes('number 2?'))?.notes).toBe('negative-unchecked');
    expect(negatives.filter(q => q.notes === 'negative-checked')).toHaveLength(4);
    expect(result.counts).toMatchObject({ negativesKept: 5, negativesDropped: 0, negativesUnchecked: 1, negativeChecksDegraded: { 'internal.telegram:connector_store_vector:deadline': 2 } });
  } finally { server.stop(true); opened.close(); }
});
// A real copy has chat and mail stores of mostly non-ASCII chunks. The
// alternates search once read every such chunk again for each drafted
// question, so 60 questions took hours on a 25 GB copy (2026-11-12).
test('alternates read each store once per run, however many questions are drafted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-draft-scan-')); dirs.push(root);
  const size = 1_500;
  const path = join(root, 'chat-internal.sqlite');
  const store = new LocalConnectorStore({ dbPath: path, corpusId: 'internal.fixture.chat', family: 'file', trustDomain: 'internal', tierLedger: null });
  await store.syncFromConnector(fixtureConnector(() => Array.from({ length: size }, (_, i) => ({ id: String(i), name: 'Synthetic', text: `Olá, café às três. The Kestrel invoice total is forty seven dollars payable Tuesday. Entrée ${i}.` }))), { fetchContent: true });
  store.close();
  const ledger = new TierLedger({ dbPath: tierLedgerPathForStore(path) });
  for (let i = 0; i < size; i++) ledger.recordDecision({ provider: 'fixture', accountScope: 'personal', providerItemId: String(i), family: 'file' }, {
    metadataTier: 'private', contentTier: 'private', metadataPending: false, contentPending: false, metadataForced: false, metadataFlagged: false, contentRead: true,
    state: 'current', snifferId: 'synthetic', decidedBy: 'sniffer', reasons: [], engineVersion: 'fixture', mapRevision: 'fixture',
  });
  ledger.close();
  Bun.gc(true);
  const opened = openEvalDataRoot({ dataRoot: root });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const prompt = ((await request.json()) as { messages: { content: string }[] }).messages.at(-1)!.content;
    const result = prompt.includes('UNANSWERABLE')
      ? { questions: Array.from({ length: 5 }, (_, i) => `Where are the nonexistent orchid records number ${i}?`) }
      : { question: 'Which day is the bill due?', quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  const query = Database.prototype.query;
  let chunkReads = 0;
  Database.prototype.query = function (this: Database, sql: string) {
    if (/\bFROM chunks\b/.test(sql)) chunkReads++;
    return query.call(this, sql);
  } as typeof query;
  try {
    const model = localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' });
    const reads = async (count: number) => {
      chunkReads = 0;
      const result = await draftPassageQuestions({ opened, count, seed: 'scan', model });
      return { reads: chunkReads, alternates: result.dataset.questions.filter(q => q.expectedEvidence).map(q => q.expectedEvidence![0]!.alternates?.length ?? 0) };
    };
    const two = await reads(2);
    const six = await reads(6);
    expect(two.alternates.length).toBeGreaterThan(0);
    // Every other copy of the quoted sentence is still found.
    expect(six.alternates.every(n => n === size - 1)).toBe(true);
    expect(six.reads).toBe(two.reads);
  } finally { Database.prototype.query = query; server.stop(true); opened.close(); }
});
test('a resumed run reuses the drafts already made and asks the model only for the rest', async () => {
  const opened = await world();
  let drafts = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const prompt = ((await request.json()) as { messages: { content: string }[] }).messages.at(-1)!.content;
    if (!prompt.includes('UNANSWERABLE') && !prompt.includes('QUESTION CHECK')) drafts++;
    const result = prompt.includes('UNANSWERABLE')
      ? { questions: Array.from({ length: 5 }, (_, i) => `Where are the nonexistent orchid records number ${i}?`) }
      : { question: 'Which day is the bill due?', quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  try {
    const model = localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' });
    let saved: import('../eval/draft-passage-questions.ts').DraftCheckpoint | undefined;
    const lines: string[] = [];
    const first = await draftPassageQuestions({ opened, count: 4, seed: 'resume', model, progress: line => lines.push(line),
      checkpoint: { load: () => undefined, save: state => { saved = structuredClone(state); } } });
    expect(drafts).toBe(4);
    expect(saved?.drafted).toHaveLength(4);
    // Progress names stages and counts only.
    expect(lines.some(line => line.startsWith('alternates: store'))).toBe(true);
    expect(lines.every(line => !line.includes('Kestrel') && !line.includes('bill'))).toBe(true);
    drafts = 0;
    const partial = { ...saved!, drafted: saved!.drafted.slice(0, 3) };
    const resumed = await draftPassageQuestions({ opened, count: 4, seed: 'resume', model, checkpoint: { load: () => partial, save: () => {} } });
    expect(drafts).toBe(1);
    expect(resumed.dataset).toEqual(first.dataset);
  } finally { server.stop(true); opened.close(); }
});
test('a resumed draft is reused only for the same sampled item, and a failed request is counted so its drafts are kept', async () => {
  const opened = await world();
  let drafts = 0; let failNext = false;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const prompt = ((await request.json()) as { messages: { content: string }[] }).messages.at(-1)!.content;
    if (!prompt.includes('UNANSWERABLE') && !prompt.includes('QUESTION CHECK')) {
      drafts++;
      if (failNext) { failNext = false; return new Response('busy', { status: 503 }); }
    }
    const result = prompt.includes('UNANSWERABLE')
      ? { questions: Array.from({ length: 5 }, (_, i) => `Where are the nonexistent orchid records number ${i}?`) }
      : { question: 'Which day is the bill due?', quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  try {
    const model = localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' });
    let saved: import('../eval/draft-passage-questions.ts').DraftCheckpoint | undefined;
    failNext = true;
    const first = await draftPassageQuestions({ opened, count: 4, seed: 'bind', model, checkpoint: { load: () => undefined, save: state => { saved = structuredClone(state); } } });
    expect(first.counts.requestsFailed).toBe(1);
    expect(saved!.drafted).toHaveLength(3);
    // A checkpoint from another copy: its first entry names an item this sample does not hold.
    const moved = { ...saved!, drafted: saved!.drafted.map((entry, at) => at === 0 ? { ...entry, providerItemId: 'not-sampled' } : entry) };
    drafts = 0;
    const resumed = await draftPassageQuestions({ opened, count: 4, seed: 'bind', model, checkpoint: { load: () => moved, save: () => {} } });
    // The moved entry and the failed one are drafted again; the other two are reused.
    expect(drafts).toBe(2);
    expect(resumed.counts.requestsFailed).toBe(0);
  } finally { server.stop(true); opened.close(); }
});

test('a degraded check that recovers on retry certifies the negative, and partial passages that answer it still drop it', async () => {
  const opened = await world();
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const prompt = ((await request.json()) as { messages: { content: string }[] }).messages.at(-1)!.content;
    let result: unknown;
    if (prompt.includes('NEGATIVE CHECK')) result = { answerable: prompt.includes('number 1?') };
    else if (prompt.includes('UNANSWERABLE')) result = { questions: Array.from({ length: 5 }, (_, i) => `Where are the nonexistent orchid records number ${i}?`) };
    else result = { question: 'Which day is the bill due?', quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  try {
    const seen = new Map<string, number>();
    const result = await draftPassageQuestions({ opened, count: 2, seed: 'retry', model: localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' }),
      negativeRetryMs: 0,
      negativePassages: async question => {
        const n = (seen.get(question) ?? 0) + 1; seen.set(question, n);
        // Number 0 degrades only on its first try; number 1 degrades both times but its partial passages answer it.
        const degraded = (question.includes('number 0?') && n === 1) || question.includes('number 1?') ? ['s:vector:deadline'] : [];
        return { passages: ['A synthetic retrieved passage.'], degraded };
      } });
    const negatives = result.dataset.questions.filter(q => q.shape === 'coverage_negative');
    expect(negatives.find(q => q.question.includes('number 0?'))?.notes).toBe('negative-checked');
    expect(negatives.some(q => q.question.includes('number 1?'))).toBe(false);
    expect(result.counts).toMatchObject({ negativesKept: 4, negativesDropped: 1, negativesUnchecked: 0, negativeChecksDegraded: { 's:vector:deadline': 3 } });
  } finally { server.stop(true); opened.close(); }
});
test('rejected drafts are counted by reason, and an unreadable reply is a rejection, not a failed request', async () => {
  const opened = await world();
  const replies = [
    JSON.stringify({ question: 'What amount?', quote: 'This fabricated quotation is not in the synthetic item at all' }),
    'I cannot help with that request.',
    JSON.stringify({ question: 'What is the Kestrel invoice total?', quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' }),
    JSON.stringify({ question: 'Which day?', quote: 'payable Tuesday' }),
    JSON.stringify({ quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' }),
  ];
  let draft = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const prompt = ((await request.json()) as { messages: { content: string }[] }).messages.at(-1)!.content;
    if (prompt.includes('UNANSWERABLE')) return Response.json({ choices: [{ message: { content: JSON.stringify({ questions: Array.from({ length: 5 }, (_, i) => `Where are the orchid records number ${i}?`) }) } }] });
    return Response.json({ choices: [{ message: { content: replies[draft++ % replies.length]! } }] });
  } });
  try {
    // Sample 0 is a paraphrase request, so reply 2 (which repeats the quote's words) lands on a paraphrase at index 2.
    const result = await draftPassageQuestions({ opened, count: 5, seed: 'reasons', model: localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' }) });
    expect(result.counts.requestsFailed).toBe(0);
    expect(result.counts.rejected).toBe(5);
    expect(result.counts.rejectedBy).toEqual({ quote_not_in_item: 1, not_json: 1, question_repeats_quote: 1, quote_length: 1, missing_fields: 1 });
  } finally { server.stop(true); opened.close(); }
});
test('a growth run appends to an existing set: new items only, fresh ids, earlier splits kept', async () => {
  const opened = await world();
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const prompt = ((await request.json()) as { messages: { content: string }[] }).messages.at(-1)!.content;
    const result = prompt.includes('UNANSWERABLE')
      ? { questions: Array.from({ length: 5 }, (_, i) => `Where are the nonexistent orchid records number ${i}?`) }
      : { question: 'Which day is the bill due?', quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  try {
    const model = localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' });
    const drafted = await draftPassageQuestions({ opened, count: 4, seed: 'one', model });
    // Every fixture item holds the same sentence, so each is an alternate of every quote: nothing is left to draft.
    expect((await draftPassageQuestions({ opened, count: 4, seed: 'two', model, existing: drafted.dataset })).counts.sampled).toBe(0);
    // Without alternates, only the items the set quotes are skipped.
    const first = { ...drafted, dataset: { ...drafted.dataset, questions: drafted.dataset.questions.map(q => q.expectedEvidence ? { ...q, expectedEvidence: q.expectedEvidence.map(({ alternates: _, ...e }) => e) } : q) } };
    const used = (questions: typeof first.dataset.questions) => questions.flatMap(q => q.expectedEvidence ?? []).map(e => `${e.corpusId}/${e.providerItemId}`);
    const grown = await draftPassageQuestions({ opened, count: 4, seed: 'two', model, existing: first.dataset });
    const before = new Map(first.dataset.questions.map(q => [q.id, q]));
    // Every earlier question is still there, unchanged, split included.
    for (const q of first.dataset.questions) expect(grown.dataset.questions.find(g => g.id === q.id)).toEqual(q);
    const added = grown.dataset.questions.filter(q => !before.has(q.id));
    expect(new Set(grown.dataset.questions.map(q => q.id)).size).toBe(grown.dataset.questions.length);
    // Only file:internal has more than one eligible item, so the new run can draft from it alone.
    const addedItems = used(added);
    expect(addedItems.length).toBeGreaterThan(0);
    for (const item of addedItems) expect(used(first.dataset.questions)).not.toContain(item);
    // The same negative text is not added twice.
    expect(added.filter(q => q.shape === 'coverage_negative')).toHaveLength(0);
    expect(grown.counts).toMatchObject({ existing: first.dataset.questions.length, total: grown.dataset.questions.length });
  } finally { server.stop(true); opened.close(); }
});
test('a minimum per store steers which items are drafted, counting what the set already holds', async () => {
  const opened = await world();
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const prompt = ((await request.json()) as { messages: { content: string }[] }).messages.at(-1)!.content;
    const result = prompt.includes('UNANSWERABLE')
      ? { questions: Array.from({ length: 5 }, (_, i) => `Where are the nonexistent orchid records number ${i}?`) }
      : { question: 'Which day is the bill due?', quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  try {
    const model = localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' });
    const stores = (r: Awaited<ReturnType<typeof draftPassageQuestions>>) => r.dataset.questions.flatMap(q => q.expectedEvidence ?? []).map(e => e.corpusId);
    const plain = await draftPassageQuestions({ opened, count: 3, seed: 'quota', model });
    expect(stores(plain).filter(id => id === 'internal.fixture.file').length).toBeLessThan(3);
    const steered = await draftPassageQuestions({ opened, count: 3, seed: 'quota', model, minimums: { store: { 'internal.fixture.file': 3 } } });
    expect(stores(steered).filter(id => id === 'internal.fixture.file')).toHaveLength(3);
    // Already met by the set it grows: the minimum asks for nothing more.
    const grown = await draftPassageQuestions({ opened, count: 1, seed: 'quota2', model, existing: steered.dataset, minimums: { store: { 'internal.fixture.file': 3 } } });
    expect(grown.counts.unmetMinimums).toEqual({});
    const short = await draftPassageQuestions({ opened, count: 2, seed: 'quota3', model, minimums: { store: { 'secure_local.fixture.email': 4 } } });
    // One eligible item there: the shortfall is reported, by store id and count.
    expect(short.counts.unmetMinimums).toEqual({ 'store:secure_local.fixture.email': 3 });
  } finally { server.stop(true); opened.close(); }
});

test('degraded lanes are labelled by store, lane and reason code only', () => {
  expect(degradedLabel({ corpusId: 'internal.telegram.messages', lane: 'connector_store_vector', reason: 'lane_budget_cut' })).toBe('internal.telegram.messages:connector_store_vector:lane_budget_cut');
  // An error message could quote the question, so free text never becomes a label.
  expect(degradedLabel({ corpusId: 'internal.email', reason: 'fts5: syntax error near "orchid records"' })).toBe('internal.email:-:other');
});
test('minimums parse as name=N, across repeated options', () => {
  expect(parseMinimums(['internal.whatsapp.messages=8,internal.email=5', 'secure_local.whatsapp.messages=4'])).toEqual({ 'internal.whatsapp.messages': 8, 'internal.email': 5, 'secure_local.whatsapp.messages': 4 });
  expect(() => parseMinimums(['chat=0'])).toThrow('name=N');
  expect(() => parseMinimums(['chat'])).toThrow('name=N');
});

test('resuming a growth run that wrote over its own input grows from the original set, not the partial one', async () => {
  const opened = await world();
  let failNext = false; let drafts = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const prompt = ((await request.json()) as { messages: { content: string }[] }).messages.at(-1)!.content;
    if (!prompt.includes('UNANSWERABLE') && !prompt.includes('QUESTION CHECK')) { drafts++; if (failNext) { failNext = false; return new Response('busy', { status: 503 }); } }
    const result = prompt.includes('UNANSWERABLE')
      ? { questions: Array.from({ length: 5 }, (_, i) => `Where are the nonexistent orchid records number ${i}?`) }
      : { question: 'Which day is the bill due?', quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  try {
    const model = localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' });
    const strip = (set: Awaited<ReturnType<typeof draftPassageQuestions>>['dataset']) => ({ ...set, questions: set.questions.map(q => q.expectedEvidence ? { ...q, expectedEvidence: q.expectedEvidence.map(({ alternates: _, ...e }) => e) } : q) });
    const base = strip((await draftPassageQuestions({ opened, count: 2, seed: 'base', model })).dataset);
    let saved: import('../eval/draft-passage-questions.ts').DraftCheckpoint | undefined;
    failNext = true;
    const partial = await draftPassageQuestions({ opened, count: 3, seed: 'grow', model, existing: base, checkpoint: { load: () => undefined, save: state => { saved = structuredClone(state); } } });
    expect(partial.counts.requestsFailed).toBe(1);
    // --output was the --append file: the resumed run reads the partly grown set.
    drafts = 0;
    const resumed = await draftPassageQuestions({ opened, count: 3, seed: 'grow', model, existing: strip(partial.dataset), checkpoint: { load: () => saved, save: () => {} } });
    expect(drafts).toBe(1);
    expect(resumed.counts.existing).toBe(base.questions.length);
    expect(resumed.counts.kept).toBe(3);
    // A file that lost questions the run grew from is refused.
    await expect(draftPassageQuestions({ opened, count: 3, seed: 'grow', model, existing: { ...base, questions: base.questions.slice(1) }, checkpoint: { load: () => saved, save: () => {} } })).rejects.toThrow('grew from');
  } finally { server.stop(true); opened.close(); }
});
test('the funnel counts an item’s stored chunks read-only from the copied store', async () => {
  const opened = await world();
  const counter = storedChunkCounter(opened.stores);
  try {
    expect(counter.count('internal.fixture.file', '0')).toBe(1);
    expect(counter.count('internal.fixture.file', 'no-such-item')).toBeUndefined();
    expect(counter.count('internal.no.store', '0')).toBeUndefined();
  } finally { counter.close(); opened.close(); }
});

test('a question the judge calls generic is redrafted once to be specific, then rejected as generic', async () => {
  const opened = await world();
  const judgements: boolean[] = [];
  let redraftPrompts = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const prompt = ((await request.json()) as { messages: { content: string }[] }).messages.at(-1)!.content;
    const reply = (value: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
    if (prompt.includes('UNANSWERABLE')) return reply({ questions: Array.from({ length: 5 }, (_, i) => `Where are the orchid records number ${i}?`) });
    if (prompt.includes('QUESTION CHECK')) return reply({ answers: true, specific: judgements.shift() ?? true });
    if (prompt.includes('SPECIFIC:')) redraftPrompts++;
    return reply({ question: 'Which boatyard bill amount is due?', quote: 'The Kestrel invoice total is forty seven dollars payable Tuesday' });
  } });
  try {
    // Item 0: generic, then specific on the redraft (kept). Item 1: generic twice (rejected).
    judgements.push(false, true, false, false);
    const result = await draftPassageQuestions({ opened, count: 2, seed: 'generic', model: localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' }) });
    expect(redraftPrompts).toBe(2);
    expect(result.counts.kept).toBe(1);
    expect(result.counts.redrafted).toBe(1);
    expect(result.counts.rejectedBy).toEqual({ generic: 1 });
  } finally { server.stop(true); opened.close(); }
});
