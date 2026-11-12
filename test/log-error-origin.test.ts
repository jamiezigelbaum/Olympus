// #1502: an error that crossed the split's boundary or a read-pool thread
// reached the log as a plain Error with only its message. The log line now
// carries the class and the first frame from where it was raised.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { errorFirstFrame, errorFromBoundary, logErrorOrigin } from '../src/core/log-redaction.ts';
import { readOnPool, shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('the origin names the class and the first frame, without folders', () => {
  const error = new TypeError('boom');
  error.stack = 'TypeError: boom\n    at applyWindow (/home/someone/olympus/src/workers/x.ts:12:7)\n    at next (/home/someone/olympus/src/y.ts:3:1)';
  expect(errorFirstFrame(error)).toBe('applyWindow (x.ts:12:7)');
  expect(logErrorOrigin(error)).toBe(JSON.stringify('TypeError at applyWindow (x.ts:12:7)'));
  expect(logErrorOrigin('text')).toBe(JSON.stringify('string'));
});

test('an error rebuilt from a boundary keeps its class and frame', () => {
  const error = errorFromBoundary('cannot start a transaction within a transaction', 'SQLiteError', 'run (vector-digest.ts:98:5)', 'read pool query');
  expect(error.name).toBe('SQLiteError');
  expect(error.message).toBe('cannot start a transaction within a transaction');
  expect(logErrorOrigin(error)).toBe(JSON.stringify('SQLiteError at run (vector-digest.ts:98:5) (read pool query)'));
});

test('a read that fails on the pool comes back with SQLite\'s class and the statement it ran', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'olympus-origin-')), 'store.sqlite');
  const db = new Database(path);
  db.exec('CREATE TABLE t (x INTEGER)');
  db.close();
  try {
    const failure = await readOnPool(path, { mode: 'all', sql: 'SELECT missing_column FROM t', params: [] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).not.toBe('Error');
    expect((failure as Error).stack).toContain('read pool query: SELECT missing_column FROM t');
  } finally {
    shutdownReadPool();
  }
});
