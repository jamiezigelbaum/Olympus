// A read-only open checks that every FTS row has an ownership row. Under WAL
// each statement outside a transaction reads its own snapshot, so counting the
// two tables in two statements let a writer's commit land between them: the
// #707 eval saw "FTS row ownership map is incomplete" on a healthy live store.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

const CORPUS = 'secure_local.fake.files';

describe('read-only connector store open', () => {
  test('a writer committing during the FTS ownership check does not fail the open', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'olympus-fts-snapshot-')), 'store.db');
    new LocalConnectorStore({ dbPath, corpusId: CORPUS, family: 'file', trustDomain: 'secure_local' }).close();

    const writer = new Database(dbPath);
    writer.exec('PRAGMA busy_timeout = 10000;');
    let committed = false;
    // The writer indexes one chunk (both tables in one transaction) right
    // after the reader has counted the FTS table.
    const commitBetweenReads = (): void => {
      if (committed) return;
      committed = true;
      writer.transaction(() => {
        writer.run("INSERT INTO connector_store_fts(title, bounded_text, item_pk, chunk_pk) VALUES ('t', 'b', 1, NULL)");
        writer.run('INSERT INTO connector_store_fts_rows(fts_rowid, item_pk, chunk_pk) VALUES (last_insert_rowid(), 1, NULL)');
      })();
    };
    const original = Database.prototype.query;
    Database.prototype.query = function patched(this: Database, sql: string) {
      const statement = original.call(this, sql);
      if (this === writer || !/FROM connector_store_fts\b(?!_rows)/.test(sql) || /connector_store_fts_rows/.test(sql)) return statement;
      const get = statement.get.bind(statement);
      return Object.assign(Object.create(statement), {
        get: (...args: unknown[]) => { const row = get(...(args as [])); commitBetweenReads(); return row; },
      });
    } as typeof Database.prototype.query;
    try {
      const reader = new LocalConnectorStore({ dbPath, corpusId: CORPUS, family: 'file', trustDomain: 'secure_local', readOnly: true });
      reader.close();
    } finally {
      Database.prototype.query = original;
      writer.close();
    }
  });
});
