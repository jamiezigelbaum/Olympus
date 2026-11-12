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
