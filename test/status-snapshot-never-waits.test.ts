// The dashboard and status never wait on a store read: a snapshot caller gets
// the last complete status at once, with its age, and the recount runs behind
// it. A restarted engine answers its first read from the snapshot it kept on
// disk. Sparta rc.17, 15 Nov 2026: with an import, the judge and a backup
// running, every dashboard poll recounted the expired stores inline (30-69 s).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { defineDropboxFilesCorpus } from '../src/workers/dropbox-files/index.ts';
import { flushMicrotasks } from './helpers/test-clock.ts';
import { DASHBOARD_STATUS_REQUEST, STORE_STATUS_REUSE_MS, createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import { STATUS_RECOUNT_MIN_GAP_MS, STATUS_RECOUNT_PACE_FACTOR, startPacedStatusRecount } from '../src/workers/engine/status-recount.ts';
import { createTestClock } from './helpers/test-clock.ts';

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
      let writes = 0;
      store.changeMarker = () => `written:${writes++}`;
      now += STORE_STATUS_REUSE_MS + 1;
      for (let poll = 0; poll < 5; poll += 1) {
        now += 2_000;
        const shown = await within(handler.status({ include_items: false }, SNAPSHOT));
        expect(shown).not.toBe('waited');
        expect((shown as typeof first).corpora).toEqual(first.corpora);
        expect((shown as typeof first).snapshot_age_ms).toBe(STORE_STATUS_REUSE_MS + 1 + 2_000 * (poll + 1));
      }
      // One recount runs behind the polls, not one per poll.
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
