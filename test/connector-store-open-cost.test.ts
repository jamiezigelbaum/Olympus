// What opening a connector store reads (#1242, ops#151).
//
// On Sparta (2026-11-10) opening the two tier stores read-only took 13 and
// 15 s cold. Almost all of it was PRAGMA foreign_key_check, which walks every
// foreign key in the file: 2.8 of 2.9 s on a synthetic 500k-item store. On
// 2026-11-12 a plain restart still read about 22 GB across both engine
// processes: every open also counted the whole text index (its ownership
// check), and the writer walked every foreign key. Those checks belong to an
// open that migrates; a store already at this build's schema is checked by
// shape only, read-only or not. Synthetic data only.
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { DROPBOX_TIER_CORPUS_IDS } from '../src/workers/dropbox-files/connector-store.ts';
import { fixtureConnector, tempDir } from './helpers/tier-fixtures.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function statementsDuring(run: () => void): string[] {
  const seen: string[] = [];
  const query = Database.prototype.query;
  const exec = Database.prototype.exec;
  Database.prototype.query = function (this: Database, sql: string) { seen.push(sql); return query.call(this, sql); } as typeof query;
  Database.prototype.exec = function (this: Database, sql: string, ...rest: unknown[]) { seen.push(sql); return (exec as (...a: unknown[]) => unknown).call(this, sql, ...rest); } as typeof exec;
  try {
    run();
  } finally {
    Database.prototype.query = query;
    Database.prototype.exec = exec;
  }
  return seen;
}

const scansRows = (sql: string): boolean => /foreign_key_check|COUNT\(\*\) FROM connector_store_fts\b/i.test(sql);

test('only an open that migrates reads every row: a reopen at this schema, read-only or writable, checks shape only', async () => {
  const { dir, cleanup } = tempDir('olympus-store-open-');
  cleanups.push(cleanup);
  const dbPath = join(dir, 'internal.sqlite');
  const options = { dbPath, corpusId: DROPBOX_TIER_CORPUS_IDS.internal!, family: 'file' as const, trustDomain: 'internal' as const, tierLedger: null };
  let writer!: LocalConnectorStore;
  // Creating the store migrates it from nothing: the full checks run.
  const createOpen = statementsDuring(() => { writer = new LocalConnectorStore(options); });
  expect(createOpen.some((sql) => /foreign_key_check/i.test(sql))).toBe(true);
  expect(createOpen.some((sql) => /COUNT\(\*\) FROM connector_store_fts\b/i.test(sql))).toBe(true);
  await writer.syncFromConnector(fixtureConnector(() => [{ id: 'k1', name: 'note.txt', text: 'A synthetic note.' }]), { fetchContent: true });
  writer.close();

  let reader: LocalConnectorStore | undefined;
  const readOpen = statementsDuring(() => { reader = new LocalConnectorStore({ ...options, readOnly: true }); });
  cleanups.push(() => reader?.close());
  expect(readOpen.some(scansRows)).toBe(false);
  expect(reader!.searchItemsDetailed('synthetic', 5).rows.length).toBe(1);

  let again: LocalConnectorStore | undefined;
  const writeOpen = statementsDuring(() => { again = new LocalConnectorStore(options); });
  cleanups.push(() => again?.close());
  expect(writeOpen.some(scansRows)).toBe(false);
  expect(again!.searchItemsDetailed('synthetic', 5).rows.length).toBe(1);
});

// Store opens stalled the loop for minutes (lane 6 gate, 2026-11-16): every
// writable open re-ran migrate() and the schema DDL, and one backfill
// (`UPDATE chunks SET embedding_input_hash = content_hash ...`) took 46 s on a
// 600k-chunk store at every open. A store whose PRAGMA user_version already
// holds this build's schema fingerprint opens with the PRAGMAs and read-only
// shape checks: no DDL, no UPDATE, nothing that takes the write lock.
const writesSchema = (sql: string): boolean => /^\s*(CREATE|ALTER|DROP|UPDATE|INSERT|DELETE)\b/i.test(sql)
  && !/^\s*CREATE TEMP TABLE/i.test(sql)
  && !/tier_visibility_lease/i.test(sql);
const OPEN_STATEMENT_CEILING = 100;

test('a writable reopen at this schema runs a fixed few statements and no DDL or backfill', () => {
  const { dir, cleanup } = tempDir('olympus-store-open-fast-');
  cleanups.push(cleanup);
  const dbPath = join(dir, 'internal.sqlite');
  const options = { dbPath, corpusId: DROPBOX_TIER_CORPUS_IDS.internal!, family: 'file' as const, trustDomain: 'internal' as const, tierLedger: null };
  const first = statementsDuring(() => { new LocalConnectorStore(options).close(); });

  const reopen = statementsDuring(() => { new LocalConnectorStore(options).close(); });
  expect(reopen.filter(writesSchema)).toEqual([]);
  expect(reopen.length).toBeLessThanOrEqual(OPEN_STATEMENT_CEILING);
  expect(first.length).toBeGreaterThan(reopen.length * 2);
});

test('a store whose schema fingerprint differs runs the schema step once, then opens fast', () => {
  const { dir, cleanup } = tempDir('olympus-store-open-shape-');
  cleanups.push(cleanup);
  const dbPath = join(dir, 'internal.sqlite');
  const options = { dbPath, corpusId: DROPBOX_TIER_CORPUS_IDS.internal!, family: 'file' as const, trustDomain: 'internal' as const, tierLedger: null };
  new LocalConnectorStore(options).close();
  const raw = new Database(dbPath);
  raw.exec('PRAGMA user_version = 7');
  raw.close();

  const stepped = statementsDuring(() => { new LocalConnectorStore(options).close(); });
  expect(stepped.some(writesSchema)).toBe(true);
  const after = statementsDuring(() => { new LocalConnectorStore(options).close(); });
  expect(after.filter(writesSchema)).toEqual([]);
});

test('the embedding-input backfill runs only when its column is added', () => {
  const { dir, cleanup } = tempDir('olympus-store-open-backfill-');
  cleanups.push(cleanup);
  const dbPath = join(dir, 'internal.sqlite');
  const options = { dbPath, corpusId: DROPBOX_TIER_CORPUS_IDS.internal!, family: 'file' as const, trustDomain: 'internal' as const, tierLedger: null };
  new LocalConnectorStore(options).close();
  const backfills = (sql: string) => /embedding_input_hash = content_hash/.test(sql);
  let raw: Database;
  // A schema step that finds the column already there does not walk the rows.
  raw = new Database(dbPath);
  raw.exec('PRAGMA user_version = 7');
  raw.close();
  expect(statementsDuring(() => { new LocalConnectorStore(options).close(); }).some(backfills)).toBe(false);
});

test('a store whose schema moved under a matching stamp (an older build dropped a trigger) gets the step again', async () => {
  const { dir, cleanup } = tempDir('olympus-store-open-moved-');
  cleanups.push(cleanup);
  const dbPath = join(dir, 'internal.sqlite');
  const options = { dbPath, corpusId: DROPBOX_TIER_CORPUS_IDS.internal!, family: 'file' as const, trustDomain: 'internal' as const, tierLedger: null };
  const writer = new LocalConnectorStore(options);
  await writer.syncFromConnector(fixtureConnector(() => [{ id: 'k1', name: 'note.txt', text: 'A synthetic note.' }]), { fetchContent: true });
  writer.close();
  // Synced and reopened: still the fast path.
  expect(statementsDuring(() => { new LocalConnectorStore(options).close(); }).filter(writesSchema)).toEqual([]);
  const raw = new Database(dbPath);
  const stamp = (raw.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  raw.exec('DROP TRIGGER connector_store_totals_chunk_insert');
  expect((raw.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(stamp);
  raw.close();
  new LocalConnectorStore(options).close();
  const check = new Database(dbPath, { readonly: true });
  cleanups.push(() => check.close());
  expect(check.query("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'connector_store_totals_chunk_insert'").get()).not.toBeNull();
  expect((check.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(stamp);
});

test('a tier ledger open walks no copies: stale embedding holds are settled off the open', () => {
  const { dir, cleanup } = tempDir('olympus-ledger-open-');
  cleanups.push(cleanup);
  const dbPath = join(dir, 'ledger.sqlite');
  const walks = (sql: string) => /\b(UPDATE|FROM) tier_copies\b/.test(sql);
  new TierLedger({ dbPath }).close();
  expect(statementsDuring(() => { new TierLedger({ dbPath }).close(); }).some(walks)).toBe(false);
});

test('chunks with no embedding input hash are set by key, a page of keys at a time, and the walk stops once past the last', async () => {
  const { dir, cleanup } = tempDir('olympus-store-input-hash-');
  cleanups.push(cleanup);
  const dbPath = join(dir, 'internal.sqlite');
  const store = new LocalConnectorStore({ dbPath, corpusId: DROPBOX_TIER_CORPUS_IDS.internal!, family: 'file', trustDomain: 'internal', tierLedger: null });
  cleanups.push(() => store.close());
  await store.syncFromConnector(fixtureConnector(() => [
    { id: 'k1', name: 'one.txt', text: 'A synthetic note.' },
    { id: 'k2', name: 'two.txt', text: 'Another synthetic note.' },
    { id: 'k3', name: 'three.txt', text: 'A third synthetic note.' },
  ]), { fetchContent: true });
  const raw = new Database(dbPath);
  cleanups.push(() => raw.close());
  raw.exec('UPDATE chunks SET embedding_input_hash = NULL');
  const missing = () => (raw.query('SELECT COUNT(*) AS n FROM chunks WHERE embedding_input_hash IS NULL').get() as { n: number }).n;
  const total = missing();
  expect(total).toBeGreaterThanOrEqual(3);
  expect(await store.repairEmbeddingInputHashes(2, 1)).toBe(2);
  let set = 2;
  while (missing() > 0) set += await store.repairEmbeddingInputHashes(2, 1);
  expect(set).toBe(total);
  expect((raw.query('SELECT COUNT(*) AS n FROM chunks WHERE embedding_input_hash <> content_hash').get() as { n: number }).n).toBe(0);
  expect(await store.repairEmbeddingInputHashes(2, 1)).toBe(0);
  // A later NULL is not looked for again in this process.
  raw.exec('UPDATE chunks SET embedding_input_hash = NULL');
  expect(await store.repairEmbeddingInputHashes(2, 1)).toBe(0);
});
