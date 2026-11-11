import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createArchiveImportDashboard } from '../src/workers/archive-import/dashboard.ts';
import { createArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import * as readPool from '../src/workers/connector-store/off-thread-reads.ts';
import { OffThreadReadBusyError } from '../src/workers/connector-store/off-thread-reads.ts';
import { createTestClock } from './helpers/test-clock.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function fixture(options: { memory?: boolean; readOnly?: boolean } = {}) {
  const root = mkdtempSync('/tmp/archive-counts-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = createTestClock();
  const env = { HOME: root, XDG_DATA_HOME: join(root, 'data') };
  const runtime = createArchiveImportRuntime({ env, statePath: join(root, 'archives.json') });
  const record = runtime.state.create({
    provider: 'fixture', family: 'email', format: 'mbox', label: 'Export.mbox',
    root_path: root, root_identity: { dev: '1', ino: '1' }, chosen_rel_path: 'Export.mbox',
    files: [{ rel_path: 'Export.mbox', dev: '1', ino: '1', size: 1, mtime_ms: 1, fingerprint: { head_sha256: 'a'.repeat(64), tail_sha256: 'a'.repeat(64) } }], manifest_sha256: 'a'.repeat(64),
  });
  runtime.state.update(record.archive_id, (entry) => { entry.status = 'imported'; });
  const writer = new TierLedger({ dbPath: options.memory ? ':memory:' : join(root, 'ledger.sqlite') });
  cleanups.push(() => writer.close());
  const ledger = options.readOnly ? new TierLedger({ dbPath: writer.dbPath, readOnly: true }) : writer;
  if (ledger !== writer) cleanups.push(() => ledger.close());
  const write = (id: string, pending = true) => writer.recordDecision({
    provider: record.provider, accountScope: record.archive_id, providerItemId: id,
  }, {
    metadataTier: 'secure', contentTier: 'secure', decidedBy: 'sniffer', reasons: [],
    state: 'current', contentRead: true, metadataPending: false, contentPending: pending,
    metadataForced: false, metadataFlagged: false, engineVersion: 'fixture', mapRevision: 'fixture', snifferId: 'fixture',
  });
  const dashboard = createArchiveImportDashboard({
    runtime: { ...runtime, lane: () => ({ ledger }) as ReturnType<typeof runtime.lane> },
    resolver: { resolvePath: async () => { throw new Error('unused'); } },
    refreshScheduler: () => {}, privateModel: () => 'ready', now: clock.date,
  });
  cleanups.push(async () => { dashboard.close(); await dashboard.idle(); });
  return { root, clock, ledger, writer, write, record, dashboard };
}

test('a large tally is read on the pool, never by the dashboard thread', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pool = spyOn(readPool, 'readOnPool').mockImplementation(async () => {
    await gate;
    return { items: 100001, awaiting: 100001 };
  });
  const sync = spyOn(f.ledger, 'accountScopeCounts').mockImplementation(() => { throw new Error('request thread count'); });
  cleanups.push(() => { pool.mockRestore(); sync.mockRestore(); });
  f.dashboard.view();
  // Even if the first read takes longer than the refresh interval, every
  // dashboard surface shares the in-flight refresh.
  await f.clock.advance(2000);
  for (let i = 0; i < 20; i += 1) {
    expect(f.dashboard.view().archives[0]).toMatchObject({ countsPending: true });
    expect(f.dashboard.present().attention).toBeUndefined();
    f.dashboard.cardViews();
    f.dashboard.presentCards();
  }
  expect(pool).toHaveBeenCalledTimes(1);
  expect(pool.mock.calls[0]![0]).toBe(f.ledger.dbPath);
  expect(pool.mock.calls[0]![1].params).toEqual([f.record.provider, f.record.archive_id]);
  release();
  await f.dashboard.idle();
  expect(f.dashboard.view().archives[0]).toMatchObject({ items: 100001, held: 100001, judged: 0 });
  expect(sync).not.toHaveBeenCalled();
});

test('a split front refreshes a written tally at two seconds', async () => {
  const f = fixture({ readOnly: true });
  f.write('one');
  f.dashboard.view();
  await f.dashboard.idle();
  expect(f.dashboard.view().archives[0]).toMatchObject({ items: 1, held: 1, judged: 0 });
  f.write('one', false);
  await f.clock.advance(1999);
  expect(f.dashboard.view().archives[0]).toMatchObject({ held: 1 });
  await f.dashboard.idle();
  await f.clock.advance(1);
  // Stale-while-refreshing: no count or wait on this read.
  expect(f.dashboard.view().archives[0]).toMatchObject({ held: 1 });
  await f.dashboard.idle();
  expect(f.dashboard.view().archives[0]).toMatchObject({ items: 1, held: 0, judged: 1 });
});

test('the first tally is unknown, with no empty or unreadable claim in dashboard or agent output', async () => {
  const f = fixture();
  f.write('one');
  const row = f.dashboard.view().archives[0]!;
  expect(row.countsPending).toBe(true);
  expect(row).not.toHaveProperty('countsUnavailable');
  expect(f.dashboard.present().attention).toBeUndefined();
  const status = f.dashboard.agent.status();
  expect(status.ok).toBe(true);
  if (!status.ok) throw new Error('expected status');
  for (const key of ['items', 'messages', 'judged', 'waiting_for_private_model', 'counts_unavailable']) expect(status.archives[0]).not.toHaveProperty(key);
  expect(status.archives[0]!.summary).not.toMatch(/0|empty|can't|no .*found/i);
  await f.dashboard.idle();
  expect(f.dashboard.view().archives[0]).toMatchObject({ items: 1 });
});

test('without a read pool, synchronous fallback runs once per archive per interval', async () => {
  const f = fixture({ memory: true });
  const sync = spyOn(f.ledger, 'accountScopeCounts');
  cleanups.push(() => sync.mockRestore());
  f.write('one');
  for (let i = 0; i < 10; i += 1) expect(f.dashboard.view().archives[0]).toMatchObject({ items: 1 });
  expect(sync).toHaveBeenCalledTimes(1);
  f.write('two');
  await f.clock.advance(1999);
  expect(f.dashboard.view().archives[0]).toMatchObject({ items: 1 });
  await f.clock.advance(1);
  expect(f.dashboard.view().archives[0]).toMatchObject({ items: 2 });
  expect(sync).toHaveBeenCalledTimes(2);
});

test('a busy pool falls back once and throttles its next attempt', async () => {
  const f = fixture();
  f.write('one');
  const pool = spyOn(readPool, 'readOnPool').mockRejectedValue(new OffThreadReadBusyError());
  const sync = spyOn(f.ledger, 'accountScopeCounts');
  cleanups.push(() => { pool.mockRestore(); sync.mockRestore(); });
  f.dashboard.view();
  await f.dashboard.idle();
  expect(f.dashboard.view().archives[0]).toMatchObject({ items: 1 });
  for (let i = 0; i < 10; i += 1) f.dashboard.view();
  expect(sync).toHaveBeenCalledTimes(1);
  f.write('two');
  await f.clock.advance(2000);
  f.dashboard.view();
  await f.dashboard.idle();
  expect(sync).toHaveBeenCalledTimes(2);
  expect(f.dashboard.view().archives[0]).toMatchObject({ items: 2 });
});

test('a failed pool read is unreadable, throttled, and retried after the interval', async () => {
  const f = fixture();
  f.write('one');
  const pool = spyOn(readPool, 'readOnPool').mockRejectedValue(new Error('unreadable ledger'));
  const sync = spyOn(f.ledger, 'accountScopeCounts');
  cleanups.push(() => { pool.mockRestore(); sync.mockRestore(); });
  expect(f.dashboard.view().archives[0]).toMatchObject({ countsPending: true });
  await f.dashboard.idle();
  expect(f.dashboard.view().archives[0]).toMatchObject({ countsUnavailable: true });
  expect(f.dashboard.present().attention).toEqual([{ kind: 'counts', id: f.record.archive_id, name: 'Export.mbox' }]);
  await f.clock.advance(1999);
  f.dashboard.view();
  expect(pool).toHaveBeenCalledTimes(1);
  expect(sync).not.toHaveBeenCalled();
  pool.mockRestore();
  await f.clock.advance(1);
  f.dashboard.view();
  await f.dashboard.idle();
  expect(f.dashboard.view().archives[0]).toMatchObject({ items: 1, held: 1 });
  expect(f.dashboard.view().archives[0]).not.toHaveProperty('countsUnavailable');
});

test('closing a dashboard suppresses a late completion notification', async () => {
  const f = fixture();
  f.write('one');
  f.dashboard.view();
  const pending = f.dashboard.idle();
  f.dashboard.close();
  await pending;
});
