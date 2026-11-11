import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
