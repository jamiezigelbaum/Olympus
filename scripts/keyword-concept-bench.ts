// Synthetic-only reproduction for #1293. All databases and receipts stay in
// a newly created /tmp/olympus-1293-* directory. No path to an existing store
// is accepted except a prior benchmark's own receipt directory (--reuse).
// Run with HOME=$(mktemp -d) bun scripts/keyword-concept-bench.ts.
// --gate compares the working tree with main, reusing the synthetic receipts.
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { queryInitialisms, sourceIndexFtsGroupQuery, sourceIndexFtsTermGroups } from '../src/core/source-index/fts.ts';
import { useConceptSqlVersion, type ConceptSqlVersion } from '../test/helpers/keyword-concept-sql.ts';

const reuse = process.argv.indexOf('--reuse');
const root = reuse < 0 ? mkdtempSync('/tmp/olympus-1293-') : realpathSync(process.argv[reuse + 1]!);
if (!/^\/tmp\/olympus-1293-[\w-]+$/.test(root)) throw new Error('Only a synthetic benchmark directory is allowed');
if (reuse >= 0 && !Array.isArray(JSON.parse(readFileSync(join(root, 'measurements.json'), 'utf8')))) {
  throw new Error('Missing synthetic benchmark receipt');
}
const now = '2026-11-01T00:00:00.000Z';
const questions = ['inv rep', 'Letter of Intent (LOI)', 'Letter of Intent (LOI) Non Disclosure Agreement (NDA)'];
const gate = process.argv.includes('--gate');
const samples = 3;
const timeouts: Array<Record<string, unknown>> = [];
const dbOf = (object: object) => (object as { db: Database }).db;

function open(fixture: string) {
  const trustDomain = fixture === 'personal' ? 'internal' : 'secure_local';
  const ledger = new TierLedger({ dbPath: join(root, `${fixture}-ledger.sqlite`) });
  const store = new LocalConnectorStore({ dbPath: join(root, `${fixture}.sqlite`),
    corpusId: `${trustDomain}.fixture.files`, family: 'file', trustDomain, tierLedger: ledger });
  return { store, ledger, close() { store.close(); ledger.close(); } };
}

function seed(fixture: string) {
  const f = open(fixture);
  const db = dbOf(f.store), ldb = dbOf(f.ledger);
  db.exec('PRAGMA busy_timeout = 10000');
  ldb.exec('PRAGMA busy_timeout = 10000');
  db.query(`INSERT INTO sync_runs (sync_run_id, corpus_id, connector_id, status, started_at)
    VALUES ('synthetic', ?, 'synthetic', 'completed', ?)`).run(f.store.corpusId, now);
  const item = db.query(`INSERT INTO items (item_pk, provider, family, account_scope, provider_item_id,
    local_item_id, source_version, title, mime_type, fetched_at, indexed_at, trust_tier, sync_run_id)
    VALUES (?, 'fixture', 'file', 'synthetic', ?, ?, 'v1', ?, 'text/plain', ?, ?, ?, 'synthetic')`);
  const chunk = db.query(`INSERT INTO chunks (chunk_pk, item_pk, chunk_index, bounded_text, content_hash, indexed_at)
    VALUES (?, ?, 0, ?, ?, ?)`);
  const fts = db.query('INSERT INTO connector_store_fts (rowid, title, bounded_text, item_pk, chunk_pk) VALUES (?, ?, ?, ?, ?)');
  const row = db.query('INSERT INTO connector_store_fts_rows (fts_rowid, item_pk, chunk_pk) VALUES (?, ?, ?)');
  const copy = ldb.query(`INSERT INTO tier_copies (provider, account_scope, provider_item_id,
    corpus_id, trust_domain, layers, copy_state, generation, updated_at)
    VALUES ('fixture', 'synthetic', ?, ?, ?, 'both', ?, 1, ?)`);
  // 445k names plus 155k chunk rows, not a toy all-content index. Each
  // prefix has 16,384 distinct tokens with overlapping doclists. The mixed
  // questions also exercise exact initialisms and ORs of prefix + exact.
  let ftsRow = 0;
  for (let start = 0; start < 445_000; start += 1_000) {
    ldb.transaction(() => db.transaction(() => {
      for (let n = start; n < Math.min(start + 1_000, 445_000); n++) {
        const pk = n + 1, id = `synthetic-${n}`;
        const suffix = (n % 16_384).toString(36);
        const title = `Invoice${suffix} report${suffix} ${n % 2 ? 'loi' : 'nda'} document ${n}`;
        const text = `${title} ${n % 37 === 0 ? 'letter intent disclosure agreement loi nda invoice report' : ''} `
          + 'Notes about the project and the garden. '.repeat(1 + n % 13);
        item.run(pk, id, id, title, now, now, fixture === 'personal' ? 'S3' : 'S4');
        fts.run(++ftsRow, title, '', pk, null);
        row.run(ftsRow, pk, null);
        if (n < 155_000) {
          chunk.run(pk, pk, text, `hash-${n}`, now);
          fts.run(++ftsRow, title, text, pk, pk);
          row.run(ftsRow, pk, pk);
        }
        // The Private fixture retains 90% superseded copies in FTS. Current
        // copies are spread through the ranking, forcing visibility paging.
        if (fixture === 'private') copy.run(id, f.store.corpusId, f.store.trustDomain,
          n % 10 === 0 ? 'current' : 'superseded', now);
      }
    })())();
    if (start % 100_000 === 0) console.log(JSON.stringify({ fixture, seeded: start + 1_000 }));
  }
  db.exec("INSERT INTO connector_store_fts(connector_store_fts) VALUES ('optimize')");
  console.log(JSON.stringify({ fixture, ftsRows: ftsRow, titleOnlyRows: 445_000, items: 445_000,
    superseded: fixture === 'private' ? 400_500 : 0, sqlite: db.query('SELECT sqlite_version() AS version').get() }));
  f.close();
}

type Measurement = { fixture: string; question: string; contentOnly: boolean; version: ConceptSqlVersion;
  phase: 'reproduction' | 'gate'; cold: number; warm: number; ids: string[] };
function measure(fixture: string, question: string, contentOnly: boolean, version: ConceptSqlVersion): Measurement {
  const f = open(fixture);
  const restore = useConceptSqlVersion(f.store, version);
  const run = () => {
    const started = performance.now();
    const result = f.store.searchItemsDetailed(question, 50, undefined, undefined, { ...(contentOnly ? { contentOnly } : {}) });
    return { ms: performance.now() - started, ids: result.rows.map(row => row.sourceItem.localItemId) };
  };
  try {
    console.log(JSON.stringify({ fixture, question, contentOnly, version, coldStartedAt: Date.now() }));
    const cold = run();
    console.log(JSON.stringify({ fixture, question, contentOnly, version, firstSearchMs: cold.ms, warmStartedAt: Date.now() }));
    const warm = run();
    if (JSON.stringify(cold.ids) !== JSON.stringify(warm.ids)) throw new Error('Cold/warm rows differ');
    const result: Measurement = { fixture, question, contentOnly, version, phase: gate ? 'gate' : 'reproduction', cold: cold.ms, warm: warm.ms, ids: cold.ids };
    console.log(JSON.stringify({ ...result, ids: result.ids.length }));
    return result;
  } finally { restore(); f.close(); }
}

// The bad Private prefix lookup can take minutes per call. Isolate that
// reproduction in a child and bound it, without changing any search SQL.
async function reproduce(fixture: string, question: string, contentOnly: boolean): Promise<Measurement | undefined> {
  if (fixture !== 'private' || question !== questions[0]) return measure(fixture, question, contentOnly, '8171c7e2');
  const child = Bun.spawn([process.execPath, import.meta.path, '--reuse', root, '--child', fixture, question, String(contentOnly)], {
    stdout: 'pipe', stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
  const outputPromise = new Response(child.stdout).text();
  const errorPromise = new Response(child.stderr).text();
  try {
    const code = await child.exited;
    const output = await outputPromise, errors = await errorPromise;
    if (!timedOut && code !== 0) throw new Error(errors || output);
    const messages = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    if (!timedOut) return messages.find(row => Array.isArray(row.ids)) as Measurement;
    const cold = messages.find(row => row.coldStartedAt);
    const warm = messages.find(row => row.warmStartedAt);
    const receipt = { fixture, question, contentOnly, version: '8171c7e2', status: 'timeout',
      cold: warm?.firstSearchMs ?? null, coldLowerBoundMs: warm ? null : cold ? Date.now() - cold.coldStartedAt : null,
      warmLowerBoundMs: warm ? Date.now() - warm.warmStartedAt : null };
    timeouts.push(receipt);
    writeFileSync(join(root, 'timeouts.json'), JSON.stringify(timeouts, null, 2));
    console.log(JSON.stringify(receipt));
    if (!cold) throw new Error('Child timed out before beginning the search');
    return undefined;
  } finally { clearTimeout(timer); }
}

const childIndex = process.argv.indexOf('--child');
if (childIndex >= 0) {
  console.log(JSON.stringify(measure(process.argv[childIndex + 1]!, process.argv[childIndex + 2]!, process.argv[childIndex + 3] === 'true', '8171c7e2')));
  process.exit(0);
}

console.log(JSON.stringify({ root,
  questions: questions.map(question => ({ question, groups: sourceIndexFtsTermGroups(question).map(g => sourceIndexFtsGroupQuery(g, queryInitialisms(question))) })) }));
const all: Measurement[] = reuse < 0 ? [] : JSON.parse(readFileSync(join(root, 'measurements.json'), 'utf8'))
  .map((row: Measurement) => ({ ...row, phase: row.phase ?? 'reproduction' }));
if (reuse < 0) {
  for (const fixture of ['personal', 'private']) seed(fixture);
  writeFileSync(join(root, 'measurements.json'), '[]');
}
// Reproduction comes before any gate. Stop if the reverted SQL is not slower.
if (!gate) for (const fixture of ['personal', 'private']) {
  for (const contentOnly of [false, true]) {
    for (const question of questions.slice(0, 2)) {
      if (all.some(r => r.fixture === fixture && r.question === question && r.contentOnly === contentOnly && r.version === '8171c7e2')) continue;
      const main = measure(fixture, question, contentOnly, 'main');
      const reverted = await reproduce(fixture, question, contentOnly);
      all.push(main, ...(reverted ? [reverted] : []));
      writeFileSync(join(root, 'measurements.json'), JSON.stringify(all, null, 2));
      if (!reverted) continue;
      if (JSON.stringify(main.ids) !== JSON.stringify(reverted.ids)) throw new Error('Reproduction rows differ');
      if (question === questions[0] && (reverted.cold <= main.cold || reverted.warm <= main.warm)) throw new Error('Prefix regression NOT reproduced; stop');
    }
  }
}
if (gate) {
  if (!all.some(r => r.version === '8171c7e2' && r.cold > all.find(m => m.fixture === r.fixture
    && m.question === r.question && m.contentOnly === r.contentOnly && m.version === 'main')!.cold)) {
    throw new Error('Reproduce #1284 before running the gate');
  }
  for (const fixture of ['personal', 'private']) for (const question of questions) for (const contentOnly of [false, true]) {
    for (let sample = 0; sample < samples; sample++) {
      // Alternate order to avoid always granting the second path hot pages.
      for (const version of (sample % 2 ? ['working', 'main'] : ['main', 'working']) as ConceptSqlVersion[]) {
        all.push(measure(fixture, question, contentOnly, version));
      }
    }
  }
}
// Raw samples and result.md are artifacts outside the checkout, never JSONL.
writeFileSync(join(root, 'measurements.json'), JSON.stringify(all, null, 2));
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
let passed = true;
const lines = ['# Olympus #1293', '',
  'Synthetic data only: two stores with 600,000 FTS rows, 445,000 title rows and 155,000 content rows. The Private store retains 400,500 superseded copies (90% of items). Prefix vocabulary: 16,384 invoice/report filename tokens each.', '',
  `Cold = fresh store connection and concept-count cache; warm = immediate repeat. OS cache is not evicted. Times exclude opening/migrating the store. Gate: median of ${samples} pairs, alternating version order. Both calls use searchItemsDetailed(question, 50), then its contentOnly variant, with default FTS options.`, '',
  'Versions replay only the concept-hit SQL in the current main search: main uses the original store-wide statements, 8171c7e2 uses its candidate-row statements, working uses the implementation unchanged.', '',
  '| Phase | Store | Question | Call | Version | Cold ms | Warm ms | Rows |', '|---|---|---|---|---|---:|---:|---:|'];
for (const fixture of ['personal', 'private']) for (const question of questions) for (const contentOnly of [false, true]) {
  let reference: string[] | undefined;
  for (const phase of ['reproduction', 'gate']) {
    const times = new Map<string, { cold: number; warm: number }>();
    for (const version of ['main', '8171c7e2', 'working']) {
      const rows = all.filter(r => r.fixture === fixture && r.question === question && r.contentOnly === contentOnly && r.version === version && r.phase === phase);
      if (!rows.length) continue;
      reference ??= rows[0]!.ids;
      if (rows.some(r => JSON.stringify(r.ids) !== JSON.stringify(reference))) throw new Error('Ids/order differ from main');
      const cold = median(rows.map(r => r.cold)), warm = median(rows.map(r => r.warm));
      times.set(version, { cold, warm });
      lines.push(`| ${phase} | ${fixture} | ${question} | ${contentOnly ? 'contentOnly' : 'plain'} | ${version} | ${cold.toFixed(1)} | ${warm.toFixed(1)} | ${reference.length} |`);
    }
    const main = times.get('main'), working = times.get('working');
    if (main && working && (working.cold > main.cold || working.warm > main.warm)) passed = false;
  }
}
lines.push('', `Strict timing gate: ${gate ? (passed ? 'PASS' : 'FAIL') : 'not run'}. All compared ids and order are identical.`);
try { lines.push('', 'Bounded reverted-prefix runs (warm is unavailable if cold times out):', '', '```json', readFileSync(join(root, 'timeouts.json'), 'utf8'), '```'); } catch { /* no timeouts */ }
writeFileSync(join(root, 'result.md'), lines.join('\n') + '\n');
console.log(`Results: ${root}/result.md`);
if (!passed) process.exitCode = 1;
