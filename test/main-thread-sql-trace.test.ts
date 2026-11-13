// The Ask trace names synchronous SQLite that holds the request thread (#1305).
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { installMainThreadSqlTrace, withMainThreadSqlTiming } from '../src/workers/connector-store/main-thread-sql-trace.ts';
import {
  createSourceAnswerTrace,
  runWithSourceAnswerTrace,
  snapshotSourceAnswerTrace,
  SLOW_MAIN_THREAD_SQL_MS,
} from '../src/workers/source-index/answer-latency-trace.ts';
import { buildSourceAnswerLatencyTraceRecord } from '../src/workers/source-index/answer-latency-log.ts';

installMainThreadSqlTrace();

// A recursive count that runs for at least `ms` on this machine. Callers ask for twice the bar they test:
// a busy runner can run the same count 20% faster the second time (#1595: 247 and 233 ms against 250).
function slowCount(db: Database, ms: number): number {
  let rows = 200_000;
  for (;;) {
    const started = performance.now();
    holdThread(db, rows);
    if (performance.now() - started >= ms) return rows;
    rows *= 2;
  }
}

function holdThread(db: Database, rows: number): void {
  db.query('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) SELECT count(*) AS c FROM n').get(rows);
}

test('an Ask records its request-thread statements and names the slow one by call site', async () => {
  const db = new Database(':memory:');
  try {
    const rows = slowCount(db, SLOW_MAIN_THREAD_SQL_MS * 2);
    const trace = createSourceAnswerTrace();
    await runWithSourceAnswerTrace(trace, async () => {
      db.query('SELECT 1').get();
      await Promise.resolve();
      holdThread(db, rows);
    });
    const snapshot = snapshotSourceAnswerTrace(trace);
    expect(snapshot.mainThreadSql.statements).toBe(2);
    expect(snapshot.mainThreadSql.max_ms).toBeGreaterThanOrEqual(SLOW_MAIN_THREAD_SQL_MS);
    expect(snapshot.mainThreadSql.slow).toHaveLength(1);
    expect(snapshot.mainThreadSql.slow[0]!.site).toContain('holdThread');
    expect(snapshot.mainThreadSql.slow[0]!.site).not.toContain('RECURSIVE');
    expect(snapshot.mainThreadSql.by_site[0]).toMatchObject({ statements: 1 });
    expect(snapshot.mainThreadSql.by_site[0]!.site).toContain('holdThread');

    const record = buildSourceAnswerLatencyTraceRecord({ trace: snapshot, outcome: 'success' });
    expect(record.main_thread_sql?.statements).toBe(2);
    expect(record.main_thread_sql?.slow[0]?.site).toContain('holdThread');
  } finally {
    db.close();
  }
});

test('statements outside an Ask are not counted against one', async () => {
  const db = new Database(':memory:');
  try {
    const trace = createSourceAnswerTrace();
    db.query('SELECT 1').get();
    await runWithSourceAnswerTrace(trace, async () => undefined);
    expect(snapshotSourceAnswerTrace(trace).mainThreadSql.statements).toBe(0);
  } finally {
    db.close();
  }
});


test('a synchronous sweep scope measures statements and exec, then restores the previous scope after failure', () => {
  const db = new Database(':memory:');
  const timing = { maxStatementMs: 0 };
  try {
    expect(() => withMainThreadSqlTiming(timing, () => {
      db.exec('CREATE TABLE sweep_test (id INTEGER PRIMARY KEY)');
      db.transaction(() => { db.query('INSERT INTO sweep_test VALUES (1)').run(); })();
      db.query('SELECT * FROM sweep_test').all();
      throw new Error('interrupted sweep');
    })).toThrow('interrupted sweep');
    expect(timing.maxStatementMs).toBeGreaterThan(0);
    const before = timing.maxStatementMs;
    holdThread(db, 200_000);
    expect(timing.maxStatementMs).toBe(before);
  } finally { db.close(); }
});
