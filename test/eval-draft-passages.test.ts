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
import { draftPassageQuestions, localDraftModel, sampleDraftItems, writeDraftQuestionSet } from '../eval/draft-passage-questions.ts';
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
      negativePassages: async question => { passagesFor.push(question); return ['A synthetic retrieved passage about the garden fence.']; } });
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
    // Number 2's retrieval left a store out, so its passages cannot certify it.
    const result = await draftPassageQuestions({ opened, count: 4, seed: 'fixture', model: localDraftModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'synthetic' }),
      negativePassages: async question => question.includes('number 2?') ? undefined : ['A synthetic retrieved passage about the garden fence.'] });
    expect(checked).toHaveLength(4);
    const negatives = result.dataset.questions.filter(q => q.shape === 'coverage_negative');
    expect(negatives.find(q => q.question.includes('number 2?'))?.notes).toBe('negative-unchecked');
    expect(negatives.filter(q => q.notes === 'negative-checked')).toHaveLength(4);
    expect(result.counts).toMatchObject({ negativesKept: 5, negativesDropped: 0, negativesUnchecked: 1 });
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
    if (!prompt.includes('UNANSWERABLE')) drafts++;
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
    if (!prompt.includes('UNANSWERABLE')) {
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
