// Family 4 of the loop-thread rule (loop-stall step-back, 15 Nov 2026): the
// readiness snapshot's lane pages and the Secrets location count run on the
// read worker, and find what the same reads find on the writer's connection.

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { readOnPool, setReadPoolObserverForTests, shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import type { ExtractionItemRef } from '../src/workers/file-extraction/types.ts';

const LANE = { corpusId: 'secure_local.files.primary', provider: 'example_provider', accountScope: 'owner@example.com', approvedScopeKey: 'example_provider.personal:/Work' };
const dirs: string[] = [];
afterEach(() => {
  setReadPoolObserverForTests();
  shutdownReadPool();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loop-finders-readiness-'));
  dirs.push(dir);
  return dir;
}

function ref(id: string, overrides: Partial<ExtractionItemRef> = {}): ExtractionItemRef {
  return {
    ...LANE, providerItemId: id, localItemId: `${LANE.accountScope}:${id}`, sourceVersion: `${id}-v1`,
    contentHash: `hash-${id}`, name: `${id}.pdf`, mimeType: 'application/pdf', ...overrides,
  } as ExtractionItemRef;
}

test('the scoped readiness snapshot reads its lanes on the worker and tallies what the writer would', async () => {
  const dbPath = join(tempDir(), 'file-extraction-jobs.sqlite');
  const store = new LocalFileExtractionJobStore(dbPath);
  try {
    store.enqueue({ refs: ['a', 'b', 'c', 'current'].map((id) => ref(id)), extractorKind: 'local_text', extractorVersion: 'v', policyDecision: 'index_allowed' });
    store.recordUnroutable([ref('picture', { mimeType: 'image/jpeg' }), ref('doc', { mimeType: 'application/msword' })]);
    const pooled: string[] = [];
    setReadPoolObserverForTests((path, read) => { if (path === dbPath) pooled.push(read.sql); }, { snapshots: true });
    let turns = 0;
    const currentItems = (refs: readonly ExtractionItemRef[]) => refs.map((item) => item.providerItemId !== 'b');
    const offThread = await store.scopedReadinessInTurns([LANE, LANE], { currentItems, turn: () => { turns += 1; return undefined; } });
    expect(pooled.some((sql) => sql.includes('FROM extraction_jobs'))).toBe(true);
    expect(pooled.some((sql) => sql.includes('FROM extraction_unroutable_items'))).toBe(true);
    expect(turns).toBeGreaterThan(0);
    expect(offThread).toEqual(store.scopedReadiness([LANE, LANE], { currentItems }));
    expect(offThread).toMatchObject({ queuedJobs: 3, picturesNotReadHereItems: 1, unsupportedKindItems: 1 });
  } finally {
    store.close();
  }
});

test('the Secrets location count on the worker equals the index count', async () => {
  const path = join(tempDir(), 'secret-locations.sqlite');
  const index = new SecretLocationsIndex({ dbPath: path });
  try {
    for (const id of ['one', 'two', 'three']) {
      index.record({ identity: { provider: 'gmail', accountScope: 'acct', providerItemId: id }, findingKinds: ['api_key'] } as never);
    }
    const row = await readOnPool(path, { sql: 'SELECT COUNT(*) AS n FROM secret_locations', params: [], mode: 'get' }) as { n: number };
    expect(row.n).toBe(index.count());
    expect(row.n).toBe(3);
  } finally {
    index.close();
  }
});
