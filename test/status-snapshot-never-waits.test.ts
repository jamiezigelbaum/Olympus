// The dashboard and status never wait on a store read: a snapshot caller gets
// the last complete status at once, with its age, and the recount runs behind
// it. A restarted engine answers its first read from the snapshot it kept on
// disk. Sparta rc.17, 15 Nov 2026: with an import, the judge and a backup
// running, every dashboard poll recounted the expired stores inline (30-69 s).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { defineDropboxFilesCorpus } from '../src/workers/dropbox-files/index.ts';
import { flushMicrotasks } from './helpers/test-clock.ts';
import { DASHBOARD_STATUS_REQUEST, STORE_STATUS_REUSE_MS, bringCountsForward, createSourceIndexStatusHandler, type SourceIndexConnectorStoreStatus } from '../src/workers/source-index/status.ts';
import { STATUS_RECOUNT_MIN_GAP_MS, STATUS_RECOUNT_PACE_FACTOR, startPacedStatusRecount } from '../src/workers/engine/status-recount.ts';
import { createTestClock, waitFor } from './helpers/test-clock.ts';

const CORPUS_ID = 'secure_local.dropbox.files';
const SNAPSHOT = { countsMaxAgeMs: 300_000 };

/** Resolves with the value, or 'waited' if it needs more than a few microtask turns (no I/O, no worker). */
async function within<T>(promise: Promise<T>): Promise<T | 'waited'> {
  return await Promise.race([promise, flushMicrotasks().then(() => 'waited' as const)]);
}

describe('status snapshot for the dashboard', () => {
  test('a store whose recount never finishes still answers every dashboard read at once, with its age', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    let now = 1_000_000;
    let reads = 0;
    try {
      const handler = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()], connectorStores: [store], nowMs: () => now });
      const first = await handler.status({ include_items: false }, SNAPSHOT);
      expect(first.snapshot_age_ms).toBeUndefined();
      // From here the store's recount is stuck (a busy disk, a held lock, a blocked engine).
      store.prepareStatusCounts = () => { reads += 1; return new Promise<void>(() => {}); };
      // And busy: written to since its last count, so it is counted again.
      let writes = 1_000_000_000;
      store.writeSequence = () => writes++;
      now += STORE_STATUS_REUSE_MS + 1;
      for (let poll = 0; poll < 5; poll += 1) {
        now += 2_000;
        const shown = await within(handler.status({ include_items: false }, SNAPSHOT));
        expect(shown).not.toBe('waited');
        expect((shown as typeof first).corpora).toEqual(first.corpora);
        expect((shown as typeof first).snapshot_age_ms).toBe(STORE_STATUS_REUSE_MS + 1 + 2_000 * (poll + 1));
      }
      // One recount runs behind the polls, not one per poll (it starts after a turn).
      await waitFor(() => reads >= 1);
      await flushMicrotasks();
      expect(reads).toBe(1);
      // A live read (no allowance) still reads now.
      expect((await handler.status({ include_items: false })).snapshot_age_ms).toBeUndefined();
    } finally { store.close(); }
  });

  test('a restarted engine answers its first dashboard read from the snapshot it kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-snapshot-'));
    const snapshotPath = join(dir, 'source-status-snapshot.json');
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    let now = 1_000_000;
    try {
      const before = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()], connectorStores: [store], nowMs: () => now, snapshotPath });
      const first = await before.status({ include_items: false }, SNAPSHOT);
      // The restart: a new handler, and a store too busy to count.
      store.prepareStatusCounts = () => new Promise<void>(() => {});
      now += 30_000;
      const after = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()], connectorStores: [store], nowMs: () => now, snapshotPath });
      const shown = await within(after.status({ include_items: false }, SNAPSHOT));
      expect(shown).not.toBe('waited');
      expect((shown as typeof first).corpora).toEqual(first.corpora);
      expect((shown as typeof first).snapshot_age_ms).toBe(30_000);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the split's front serves the background's recount and never counts a store itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-snapshot-'));
    const snapshotPath = join(dir, 'source-status-snapshot.json');
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    let now = 1_000_000;
    try {
      const background = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()], connectorStores: [store], nowMs: () => now, snapshotPath, snapshotRole: 'writer' });
      const counted = await background.refreshSnapshot!({ ...DASHBOARD_STATUS_REQUEST }, SNAPSHOT);
      // A background snapshot read serves what it kept and starts no recount: only its paced recount counts.
      let counts = 0;
      const realPrepare = store.prepareStatusCounts.bind(store);
      store.prepareStatusCounts = (scope) => { counts += 1; return realPrepare(scope); };
      now += STORE_STATUS_REUSE_MS + 1;
      expect((await within(background.status({ ...DASHBOARD_STATUS_REQUEST }, SNAPSHOT)) as typeof counted).corpora).toEqual(counted.corpora);
      await background.settled!();
      expect(counts).toBe(0);
      // The front: its store is stuck, and it is never asked.
      store.prepareStatusCounts = () => { counts += 1; return new Promise<void>(() => {}); };
      const front = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()], connectorStores: [store], nowMs: () => now, snapshotPath, snapshotRole: 'reader' });
      for (let poll = 0; poll < 3; poll += 1) {
        now += 2_000;
        const shown = await within(front.status({ ...DASHBOARD_STATUS_REQUEST }, SNAPSHOT));
        expect(shown).not.toBe('waited');
        expect((shown as typeof counted).corpora).toEqual(counted.corpora);
        expect((shown as typeof counted).snapshot_age_ms).toBe(STORE_STATUS_REUSE_MS + 1 + 2_000 * (poll + 1));
      }
      await front.settled!();
      expect(counts).toBe(0);
      // The background's next recount reaches the front with a fresh age.
      store.prepareStatusCounts = realPrepare;
      await background.refreshSnapshot!({ ...DASHBOARD_STATUS_REQUEST }, SNAPSHOT);
      now += 1_000;
      expect((await front.status({ ...DASHBOARD_STATUS_REQUEST }, SNAPSHOT)).snapshot_age_ms).toBe(1_000);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a busy read pool', () => {
  test('keeps the last counts and estimates, and never counts on the loop instead', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    let now = 1_000_000;
    try {
      await store.syncFromConnector(connector([file('a.txt', 'alpha')]), { fetchContent: true });
      const handler = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()], connectorStores: [store], nowMs: () => now });
      const first = await handler.status({ include_items: false }, SNAPSHOT);
      await handler.settled!();
      // From here the pool refuses every read, and the store has been written to.
      let onLoop = 0;
      const status = store.status.bind(store);
      store.status = ((...args: Parameters<typeof store.status>) => { onLoop += 1; return status(...args); }) as typeof store.status;
      store.statusOffThread = async () => { throw new Error('pool busy'); };
      store.pdfExtractionBacklogOffThread = async () => { throw new Error('pool busy'); };
      const pdf = store.pdfExtractionBacklog.bind(store);
      store.pdfExtractionBacklog = () => { onLoop += 1; return pdf(); };
      let writes = 1_000_000_000;
      store.writeSequence = () => writes++;
      now += STORE_STATUS_REUSE_MS + 1;
      await handler.status({ include_items: false }, SNAPSHOT);
      await handler.settled!();
      const shown = await handler.status({ include_items: false }, SNAPSHOT);
      await handler.settled!();
      expect(onLoop).toBe(0);
      expect(shown.corpora).toEqual(first.corpora);
    } finally { store.close(); }
  });
});

describe('live totals beside kept counts', () => {
  test("the front's dashboard shows a write in the totals at once, while the counts keep their age", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-totals-'));
    const snapshotPath = join(dir, 'source-status-snapshot.json');
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    let now = 1_000_000;
    try {
      await store.reconcileTotals();
      await store.syncFromConnector(connector([file('a.txt', 'alpha')]), { fetchContent: true });
      const background = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()], connectorStores: [store], nowMs: () => now, snapshotPath, snapshotRole: 'writer' });
      await background.refreshSnapshot!({ ...DASHBOARD_STATUS_REQUEST }, SNAPSHOT);
      const front = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()], connectorStores: [store], nowMs: () => now, snapshotPath, snapshotRole: 'reader' });
      const before = (await front.status({ ...DASHBOARD_STATUS_REQUEST }, SNAPSHOT)).corpora[0] as { counts: Record<string, number>; totals?: { items: number; sync_runs: number } };
      expect(before.totals).toMatchObject({ items: 1, sync_runs: 1 });
      await store.syncFromConnector(connector([file('a.txt', 'alpha'), file('b.txt', 'beta')]), { fetchContent: true });
      now += 2_000;
      const after = await within(front.status({ ...DASHBOARD_STATUS_REQUEST }, SNAPSHOT));
      expect(after).not.toBe('waited');
      const shown = after as Awaited<ReturnType<typeof front.status>>;
      expect((shown.corpora[0] as typeof before).totals).toMatchObject({ items: 2, sync_runs: 2 });
      // The counts an import moves are brought forward by the totals at once;
      // the snapshot keeps its age for what only a recount can say.
      expect((shown.corpora[0] as typeof before).counts.indexed_items).toBe(before.counts.indexed_items + 1);
      expect((shown.corpora[0] as typeof before).counts.chunks).toBe(before.counts.chunks + 1);
      expect((shown.corpora[0] as { counts_brought_forward?: unknown }).counts_brought_forward).toEqual({ items: 1, chunks: 1, embedded_chunks: 0 });
      expect(shown.snapshot_age_ms).toBe(2_000);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('finished embedding shows at once: the parity follows the live vectors on the serving model', () => {
  const counted = {
    configured: true, corpus_id: CORPUS_ID, retrieval: { declared_mode: 'hybrid', servable_mode: 'hybrid', state: 'ready', model_id: 'm1' },
    counts: { indexed_items: 3, tombstoned_items: 0, chunks: 3, embedded_chunks: 1, sync_runs: 1 },
    embedding_parity: { required: true, chunks: 3, embedded_chunks: 1, missing_chunks: 2, refresh_needed: true,
      backlog_estimate: { model_id: 'm1', missing_chunks: 2, estimated_tokens: 40, estimated_cost_usd: 0, price_source: 'config' } },
    totals_at_count: { items: 3, tombstoned_items: 0, chunks: 3, sync_runs: 1, vectors_by_model: { m1: 1, old: 3 } },
  } as unknown as SourceIndexConnectorStoreStatus;
  // Lane 6 run 43777041779: both remaining chunks embedded right after the count.
  const live = { items: 3, tombstoned_items: 0, chunks: 3, sync_runs: 1, vectors_by_model: { m1: 3, old: 3 }, reconciled_at: 'x' };
  const shown = bringCountsForward(counted, live);
  expect(shown.embedding_parity).toMatchObject({ chunks: 3, embedded_chunks: 3, missing_chunks: 0, refresh_needed: false });
  expect(shown.embedding_parity!.backlog_estimate!.missing_chunks).toBe(0);
  expect(shown.counts.embedded_chunks).toBe(3);
  // Another model's vectors never count for the serving one; nothing moved, nothing changes.
  expect(bringCountsForward(counted, { ...live, vectors_by_model: { m1: 1, old: 9 } })).toBe(counted);
  // A new item with two chunks, not yet embedded: two more waiting.
  const grown = bringCountsForward(counted, { ...live, items: 4, chunks: 5, vectors_by_model: { m1: 1 } });
  expect(grown.counts).toMatchObject({ indexed_items: 4, chunks: 5 });
  expect(grown.embedding_parity).toMatchObject({ chunks: 5, embedded_chunks: 1, missing_chunks: 4 });
});

describe("the background's paced status recount", () => {
  test('rests several times as long as each recount took, stands back for the owner, and reports it', async () => {
    const clock = createTestClock();
    let held = false;
    const starts: number[] = [];
    const lines: string[] = [];
    const recount = startPacedStatusRecount({
      holds: () => held,
      // Each recount takes 20 s of the clock: the rest is then 5 x 20 s, not the 30 s floor.
      recount: async () => { starts.push(clock.now()); await clock.sleep(20_000); },
      sleep: (ms) => clock.sleep(ms),
      now: () => clock.now(),
      log: (line) => lines.push(line),
    });
    try {
      const t0 = clock.now();
      await flushMicrotasks();
      expect(recount.health().counting).toBe(true);
      await clock.advance(20_000);
      expect(recount.health()).toMatchObject({ runs: 1, failures: 0, last_ms: 20_000, age_ms: 0, counting: false });
      expect(lines.at(-1)).toContain('status recount took 20000 ms; next in 100 s');
      await clock.advance(STATUS_RECOUNT_PACE_FACTOR * 20_000 - 1);
      expect(starts.length).toBe(1);
      expect(recount.health().age_ms).toBe(STATUS_RECOUNT_PACE_FACTOR * 20_000 - 1);
      // The owner asks: the next recount waits for the hold to end.
      held = true;
      await clock.advance(60_000);
      expect(starts.length).toBe(1);
      held = false;
      await clock.advance(5_000);
      expect(starts.length).toBe(2);
      expect(starts[1]! - t0).toBeGreaterThan(20_000 + STATUS_RECOUNT_PACE_FACTOR * 20_000);
      expect(STATUS_RECOUNT_MIN_GAP_MS).toBeLessThan(STATUS_RECOUNT_PACE_FACTOR * 20_000);
    } finally { recount.stop(); }
  });

  test('a change counts again without the idle floor, but never sooner than the pace allows', async () => {
    const clock = createTestClock();
    let took = 1_000;
    const starts: number[] = [];
    const recount = startPacedStatusRecount({
      holds: () => false,
      recount: async () => { starts.push(clock.now()); await clock.sleep(took); },
      sleep: (ms) => clock.sleep(ms),
      now: () => clock.now(),
    });
    try {
      await clock.advance(1_000);
      expect(starts.length).toBe(1);
      // A quick recount: a sync pass finishing 6 s later counts at once, not after the 30 s floor.
      await clock.advance(6_000);
      took = 20_000;
      recount.soon();
      await flushMicrotasks();
      expect(starts.length).toBe(2);
      // That one took 20 s: a change right after it waits out five times its length.
      await clock.advance(20_000);
      recount.soon();
      await clock.advance(STATUS_RECOUNT_PACE_FACTOR * 20_000 - 1);
      expect(starts.length).toBe(2);
      await clock.advance(1);
      expect(starts.length).toBe(3);
    } finally { recount.stop(); }
  });
});

function file(name: string, text: string): RawItem {
  return {
    identity: { family: 'file', provider: 'dropbox', accountScope: 'dropbox.personal', providerItemId: name, localItemId: `dropbox.personal:${name}`, sourceVersion: 'rev-1' },
    mimeType: 'text/plain', content: { kind: 'text', text }, metadata: { title: name }, fetchedAt: '2026-08-31T12:00:00.000Z',
  };
}

function connector(items: RawItem[]): SourceConnector {
  return {
    id: 'dropbox-test', family: 'file', async authenticate() {},
    listItems() { return (async function* () { yield { items, done: true }; })(); },
    async fetchItem(localItemId: string) {
      const found = items.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!found) throw new Error(`missing item ${localItemId}`);
      return found;
    },
    classificationSignals() { return {}; },
  };
}
