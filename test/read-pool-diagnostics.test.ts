import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readOnPool, readPoolDiagnostics, readPoolThreadsForTests, releaseOffThreadReads, shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import { waitFor } from './helpers/test-clock.ts';
const roots: string[] = [];
afterEach(async () => {
  shutdownReadPool();
  await waitFor(() => readPoolThreadsForTests().live + readPoolThreadsForTests().stopping === 0, { description: 'readers closed' });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('diagnostics count actual opens and keep a connection warm across reads', async () => {
  const root = mkdtempSync('/tmp/olympus-gate5-counters-'); roots.push(root);
  const path = join(root, 'store.sqlite'); const db = new Database(path);
  db.exec('CREATE TABLE items(n INTEGER); INSERT INTO items VALUES(1)'); db.close();
  const before = readPoolDiagnostics();
  const read = { sql: 'SELECT COUNT(*) AS n FROM items', params: [], mode: 'get' as const };
  expect(await readOnPool(path, read)).toEqual({ n: 1 });
  expect(await readOnPool(path, read)).toEqual({ n: 1 });
  const after = readPoolDiagnostics();
  expect(after.opens - before.opens).toBe(1);
  expect(after.starts - before.starts).toBe(1);
  expect(after.openMs - before.openMs).toBeGreaterThanOrEqual(0);
  expect(after.terminations - before.terminations).toBe(0);
  expect(after.stores[path]).toMatchObject({ inFlight: 0, abandoned: 0, queued: 0, opens: 1 });
  releaseOffThreadReads(path);
});
