import { expect, test } from 'bun:test';
import { heapStats } from 'bun:jsc';
import { createMemoryDiagnostic, MEMORY_LOG_INTERVAL_MS, MEMORY_SAMPLE_INTERVAL_MS, processMemory } from '../src/workers/engine-split/memory.ts';
import { startEngineRssRestart, ENGINE_RSS_CHECK_INTERVAL_MS } from '../src/workers/engine-split/rss-restart.ts';
import { changeMemoryActivity, changeMemoryCounter, memoryHolderCounts, memoryActivity, statusMemoryActivity, type MemoryActivityLabel, type MemoryCounter } from '../src/core/memory-counters.ts';
import { createTestClock } from './helpers/test-clock.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { cloudProvider } from './helpers/tier-fixtures.ts';
import { LocalPeopleIndex } from '../src/core/people-index.ts';

const MB = 1024 * 1024;
const heap = { ...heapStats(), heapSize: 32 * MB, heapCapacity: 64 * MB, extraMemorySize: 8 * MB, objectCount: 500_000 };
function parse(line: string) {
  const [at, prefix, kind, ...tokens] = line.split(' ');
  expect(prefix).toBe('[olympus]'); expect(kind).toBe('memory');
  expect(new Date(at!).toISOString()).toBe(at!);
  const fields = Object.fromEntries(tokens.map(token => {
    expect(token).toMatch(/^[a-z_]+=(?:[a-z_]+(?:,[a-z_]+)*|\d+(?:\.\d+)?|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/);
    return token.split('=');
  }));
  expect(Object.keys(fields)).toHaveLength(tokens.length);
  return { at, fields };
}

test('the line round trips every field and reads heap stats at a new peak and at emission', () => {
  const clock = createTestClock(); const lines: string[] = []; let heaps = 0;
  const memory = createMemoryDiagnostic({ role: 'front', now: clock.now, uptime: () => 3600,
    heap: () => { heaps++; return heap; }, readers: () => ({ read_workers: 132, read_connections: 264 }),
    activity: () => ['embedding'], log: line => lines.push(line) });
  const sampled = { rss: 130 * MB, anon: 100 * MB, file: 30 * MB, swap: 2 * MB };
  memory.sample(sampled); expect(heaps).toBe(1);
  memory.sample(sampled); expect(heaps).toBe(1);
  memory.write(sampled); expect(heaps).toBe(2);
  const { at, fields } = parse(lines[0]!);
  expect(fields).toEqual({ role: 'front', activity: 'embedding', pid: String(process.pid), uptime_s: '3600',
    read_workers: '132', read_connections: '264', rss_total_mb: '130', rss_anon_mb: '100', rss_file_mb: '30', swap_mb: '2', peak_anon_mb: '100',
    peak_at: at, peak_activity: 'embedding', peak_heap_size_mb: '32',
    floor_anon_mb: '100', bursts_over_threshold: '0',
    heap_size_mb: '32', heap_capacity_mb: '64', extra_memory_mb: '8', object_count: '500000',
    ...Object.fromEntries(Object.entries(memoryHolderCounts()).map(([key, value]) => [key, String(value)])) });
  expect(`${at} [olympus] memory ${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ')}`).toBe(lines[0]!);
});

test('Linux anonymous/file/swap are distinct; other platforms omit unavailable measurements', () => {
  expect(processMemory('RssAnon:  1024 kB\nRssFile: 2048 kB\nVmSwap: 3072 kB\n', 'linux')).toMatchObject({ anon: MB, file: 2 * MB, swap: 3 * MB });
  expect(processMemory('VmRSS: 4096 kB\n', 'linux')).not.toHaveProperty('anon');
  const sampled = processMemory('', 'darwin');
  expect(sampled).not.toHaveProperty('anon'); expect(sampled).not.toHaveProperty('file'); expect(sampled).not.toHaveProperty('swap');
  const lines: string[] = [];
  const memory = createMemoryDiagnostic({ role: 'single', heap: () => heap, log: line => lines.push(line) });
  memory.sample(sampled); memory.write(sampled);
  const { fields } = parse(lines[0]!);
  for (const key of ['peak_anon_mb', 'peak_at', 'peak_activity', 'peak_heap_size_mb', 'floor_anon_mb']) expect(fields).not.toHaveProperty(key);
  expect(fields.floor_rss_mb).toBe(String(Math.round(sampled.rss / MB * 100) / 100));
});

test('five-second samples preserve burst context and five-minute lines reset peaks with restart disabled', async () => {
  const clock = createTestClock(); const lines: string[] = []; let anon = 100; let samples = 0;
  let heapSize = 32 * MB;
  let activity: MemoryActivityLabel[] = ['idle'];
  const memory = createMemoryDiagnostic({ role: 'background', now: clock.now, heap: () => ({ ...heap, heapSize }),
    activity: () => activity, log: line => lines.push(line) });
  const monitor = startEngineRssRestart({ thresholdMb: 0, previous: { count: 0 },
    batchRunning: () => false, restart: () => { throw new Error('disabled'); }, record: () => {}, memory,
    sample: () => { samples++; return { rss: anon * MB, anon: anon * MB }; }, now: clock.now,
    setInterval: clock.setInterval, clearInterval: timer => clock.clearInterval(timer as Parameters<typeof clock.clearInterval>[0]) });
  await clock.advance(MEMORY_SAMPLE_INTERVAL_MS);
  anon = 4406; heapSize = 96 * MB; activity = ['visibility_rebuild_bootstrap', 'people_refresh'];
  await clock.advance(MEMORY_SAMPLE_INTERVAL_MS);
  const peakAt = clock.date().toISOString();
  anon = 100; heapSize = 32 * MB; activity = ['idle'];
  await clock.advance(MEMORY_LOG_INTERVAL_MS - 2 * MEMORY_SAMPLE_INTERVAL_MS - 1);
  expect(lines).toHaveLength(0);
  await clock.advance(1);
  expect(samples).toBe(60); expect(lines).toHaveLength(1);
  expect(parse(lines[0]!).fields).toMatchObject({ rss_anon_mb: '100', activity: 'idle', heap_size_mb: '32',
    floor_anon_mb: '100', bursts_over_threshold: '0',
    peak_anon_mb: '4406', peak_at: peakAt, peak_activity: 'visibility_rebuild_bootstrap,people_refresh', peak_heap_size_mb: '96' });
  anon = 150; await clock.advance(MEMORY_LOG_INTERVAL_MS);
  expect(parse(lines[1]!).fields).toMatchObject({ rss_anon_mb: '150', floor_anon_mb: '150', bursts_over_threshold: '0',
    peak_anon_mb: '150', peak_activity: 'idle', peak_heap_size_mb: '32' });
  monitor.stop(); await clock.advance(MEMORY_LOG_INTERVAL_MS); expect(lines).toHaveLength(2); expect(samples).toBe(120);
});

test('minute-check jitter never stretches the logging cadence to six checks', () => {
  let now = 0;
  const memory = createMemoryDiagnostic({ role: 'front', now: () => now, heap: () => heap, log: () => {} });
  const sample = { rss: MB, anon: MB };
  for (let tick = 1; tick <= 5; tick++) {
    now = tick * 60_000 + 10;
    expect(memory.dueOnMinuteCheck()).toBe(tick === 5);
  }
  memory.write(sample);
  for (let tick = 6; tick <= 10; tick++) {
    now = tick * 60_000;
    expect(memory.dueOnMinuteCheck()).toBe(tick === 10);
  }
});

test('restart carries exactly the emitted memory fields and continuous time over threshold', async () => {
  const clock = createTestClock(); const lines: string[] = []; let batch = true; let restarts = 0;
  const memory = createMemoryDiagnostic({ role: 'background', now: clock.now, heap: () => heap,
    activity: () => batch ? ['judging'] : ['idle'], log: line => lines.push(line) });
  const peakAt = new Date(clock.now() + MEMORY_LOG_INTERVAL_MS + MEMORY_SAMPLE_INTERVAL_MS).toISOString();
  const monitor = startEngineRssRestart({ thresholdMb: 3000, previous: { count: 0 }, memory,
    batchRunning: () => batch, restart: () => { expect(lines.at(-1)).toContain('[olympus] memory'); restarts++; return true; },
    record: () => {}, sample: () => ({ rss: 4500 * MB, anon: 4406 * MB, file: 94 * MB, swap: 0 }),
    now: clock.now, setInterval: clock.setInterval, clearInterval: timer => clock.clearInterval(timer as Parameters<typeof clock.clearInterval>[0]), log: line => lines.push(line) });
  await clock.advance(MEMORY_LOG_INTERVAL_MS + ENGINE_RSS_CHECK_INTERVAL_MS); batch = false; await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS);
  const parsed = parse(lines[1]!);
  expect(parsed.fields).toMatchObject({ activity: 'idle', floor_anon_mb: '4406', bursts_over_threshold: '0',
    peak_at: peakAt, peak_activity: 'judging', peak_heap_size_mb: '32' });
  expect(lines[2]).toBe(`[engine-split] rss_restart rss_mb=4406 threshold_mb=3000 restarts=1 waited_ms=120000 over_threshold_s=120 at=${parsed.at} ${lines[1]!.split(' memory ')[1]}`);
  expect(restarts).toBe(1); monitor.stop();
});

test('people snapshot replacements and close keep the process counts current', () => {
  const before = memoryHolderCounts();
  const index = new LocalPeopleIndex({ dbPath: ':memory:' });
  try {
    index.rebuild([{ provider: 'test', senderId: '1', isOwner: false, itemCount: 1 }, { provider: 'test', senderId: '2', isOwner: false, itemCount: 1 }]);
    expect(memoryHolderCounts()).toMatchObject({ people: before.people + 2, identities: before.identities + 2 });
    index.rebuild([]); expect(memoryHolderCounts()).toEqual(before);
  } finally { index.close(); }
  expect(memoryHolderCounts()).toEqual(before);
});

test('store open, queue replacement/deletion and close keep totals without counting duplicate items', () => {
  const before = memoryHolderCounts();
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'fixture', family: 'file', trustDomain: 'internal' });
  try {
    expect(memoryHolderCounts().connector_stores).toBe(before.connector_stores + 1);
    store.queueEmbedding(['a', 'b', 'a'], cloudProvider());
    store.queueEmbedding(['a'], cloudProvider());
    expect(memoryHolderCounts().embedding_queue).toBe(before.embedding_queue + 2);
    store.completeQueuedEmbedding(['a', 'a', 'missing']);
    expect(memoryHolderCounts().embedding_queue).toBe(before.embedding_queue + 1);
    store.markEmbeddingFailed('b', 'fixture');
    expect(memoryHolderCounts().embedding_queue).toBe(before.embedding_queue);
    store.queueEmbedding(['c'], cloudProvider());
  } finally { store.close(); store.close(); }
  expect(memoryHolderCounts()).toEqual(before);
});

test('visibility counts follow in-place updates, replacement, invalidation and close across stores', () => {
  const before = memoryHolderCounts();
  const stores = ['first', 'second'].map(corpusId => new LocalConnectorStore({ dbPath: ':memory:', corpusId, family: 'file', trustDomain: 'internal' }));
  const memo = () => ({ itemCount: 0, members: new Map(), lists: { hidden: new Set<number>() }, value: { moving: 0 } });
  try {
    // Exercise the actual cache mutation and replacement seams without a source sync or any SQL.
    const [first, second] = stores as any[];
    const identity = { provider: 'fixture', accountScope: 'fixture', providerItemId: 'fixture' };
    const a = memo(), b = memo();
    first.tierLedgerHiddenMemo = a; second.tierLedgerHiddenMemo = b;
    first.applyVisibilityUpdates(a, [{ identity, pks: [1, 2], flags: { hidden: true } }]);
    second.applyVisibilityUpdates(b, [{ identity, pks: [3], flags: { hidden: true } }]);
    expect(memoryHolderCounts().tier_visibility_items).toBe(before.tier_visibility_items + 3);
    first.applyVisibilityUpdates(a, [{ identity, pks: [2], flags: { hidden: true } }]);
    expect(memoryHolderCounts().tier_visibility_items).toBe(before.tier_visibility_items + 2);
    first.applyVisibilityUpdates(a, [{ identity, pks: [], flags: undefined }]);
    expect(memoryHolderCounts().tier_visibility_items).toBe(before.tier_visibility_items + 1);
    first.hiddenChildMemo = { childParents: new Map([['one', 'parent'], ['two', 'parent']]) };
    second.hiddenChildMemo = { childParents: new Map([['one', 'parent']]) };
    expect(memoryHolderCounts().hidden_child_items).toBe(before.hidden_child_items + 3);
    first.hiddenChildMemo.childParents.delete('one');
    first.hiddenChildMemo = { ...first.hiddenChildMemo };
    expect(memoryHolderCounts().hidden_child_items).toBe(before.hidden_child_items + 2);
    first.hiddenChildMemo = undefined; second.tierLedgerHiddenMemo = undefined;
    expect(memoryHolderCounts()).toMatchObject({ hidden_child_items: before.hidden_child_items + 1, tier_visibility_items: before.tier_visibility_items });
  } finally { for (const store of stores) store.close(); }
  expect(memoryHolderCounts()).toEqual(before);
});

test('activity shows overlapping task and scoped labels while status retains its primary task', () => {
  for (const [key, activity] of [['tasks_embed', 'embedding'], ['tasks_sync', 'import'], ['tasks_extract', 'extract']] as const) {
    changeMemoryCounter(key, 1);
    try {
      expect(memoryActivity(false, false)).toEqual([activity]);
      expect(memoryActivity(true, false)).toEqual(['judging', activity]);
      expect(statusMemoryActivity(true, false)).toBe('judging');
    }
    finally { changeMemoryCounter(key, -1); }
  }
  changeMemoryActivity('visibility_rebuild_incremental', 1);
  changeMemoryActivity('people_refresh', 1);
  try {
    changeMemoryActivity('people_refresh', 1);
    try { expect(memoryActivity(false, true)).toEqual(['recount', 'visibility_rebuild_incremental', 'people_refresh']); }
    finally { changeMemoryActivity('people_refresh', -1); }
    expect(memoryActivity(false, false, 'import')).toEqual(['import', 'visibility_rebuild_incremental', 'people_refresh']);
    expect(statusMemoryActivity(false, true)).toBe('recount');
  } finally {
    changeMemoryActivity('people_refresh', -1);
    changeMemoryActivity('visibility_rebuild_incremental', -1);
  }
  expect(memoryActivity(false, false)).toEqual(['idle']);
});

test('real diagnostic production with large holder counts stays under 50 ms (target 5 ms)', () => {
  // Drop the preceding fixtures' garbage before measuring the live diagnostic.
  Bun.gc(true);
  const populated: Partial<Record<MemoryCounter, number>> = { connector_stores: 22, tier_visibility_items: 2_000_000,
    hidden_child_items: 1_000_000, embedding_queue: 100_000, people: 100_000, identities: 500_000 };
  for (const [key, value] of Object.entries(populated)) changeMemoryCounter(key as MemoryCounter, value);
  // Discard the preceding fixtures' unreachable build copies before timing steady-state emission.
  Bun.gc(true);
  let lastLine = '';
  const memory = createMemoryDiagnostic({ role: 'background', activity: () => ['judging'],
    readers: () => ({ read_workers: 132, read_connections: 264 }), log: line => { lastLine = line; } });
  try {
    const timings: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now(); const sampled = processMemory(); memory.sample(sampled); memory.write(sampled);
      timings.push(performance.now() - start);
    }
    expect(parse(lastLine).fields.tier_visibility_items).toBe('2000000');
    const max = Math.max(...timings);
    console.info(`memory diagnostic: n=${timings.length} max_ms=${max.toFixed(3)} mean_ms=${(timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(3)}`);
    expect(max).toBeLessThan(50);
  } finally {
    for (const [key, value] of Object.entries(populated)) changeMemoryCounter(key as MemoryCounter, -value);
  }
});
