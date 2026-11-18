import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFreeze, parseSchedstat, parseStat, summarizeFreeze, TimelineOutput } from '../scripts/front-thread-timeline.ts';

test('parses Linux main-thread stat and schedstat fixtures', () => {
  // Fields 4 through 52. Distinct child counters catch off-by-one errors.
  const fields = [
    '1 2 3 0 -1 4194560 123 456 7 8 9 10 11 12',
    '20 0 4 0 1234567 4194304 128 18446744073709551615',
    '4198400 4202400 140737488348184 0 0 0 0 0 0 0 0',
    '17 2 0 0 0 13 0 0 0 0 0 0 0 0 0 0',
  ].join(' ');
  for (const comm of ['front worker', 'front (worker) ) helper', 'front\n) (helper)']) {
    expect(parseStat(`541 (${comm}) D ${fields}\n`)).toEqual({
      state: 'D', minflt: 123, majflt: 7, utime: 9, stime: 10, blkioTicks: 13,
    });
  }
  expect(parseSchedstat(' 1900000500 71100023 1245\n')).toEqual({
    runNs: 1_900_000_500, waitNs: 71_100_023, timeslices: 1245,
  });
  expect(() => parseSchedstat('16 0')).toThrow('schedstat_format');
});

type Observation = Parameters<typeof summarizeFreeze>[0][number];
type Sample = Extract<Observation, { kind: 'sample' }>;

const wallStart = Date.parse('2026-11-17T12:00:00.000Z');
const clockAt = (ms: number) => ({ at: new Date(wallStart + ms).toISOString(), monoMs: ms + 10_000 });

function sample(ms: number, overrides: Partial<Sample> = {}): Sample {
  return {
    kind: 'sample', ...clockAt(ms), state: 'R', wchan: null, spanMs: 20,
    minflt: 0, majflt: 0, utime: 0, stime: 0, blkioTicks: 0,
    runNs: 0, waitNs: 0, timeslices: 0, dRunNs: 0, dWaitNs: 0, dMajflt: 0, dBlkioTicks: 0,
    ...overrides,
  };
}

test('reports the observed split over the 30 s before a front freeze', () => {
  const freeze = parseFreeze('journal-prefix 2026-11-17T12:00:30.000Z [olympus:control-path] freeze frames role=front count=3 total_ms=3700 max_ms=1400 site="ignored"');
  if (!freeze) throw new Error('missing fixture freeze');
  expect(parseFreeze('2026-11-17T12:00:30.000Z [olympus:control-path] freeze frames role=background count=3 total_ms=3700 max_ms=1400')).toBeNull();
  const rows: Observation[] = [
    sample(-10, { dRunNs: 20_000_000 }), // Outside the window.
    sample(10, { dRunNs: 20_000_000 }), // Half inside the window.
    sample(30, { dRunNs: 8_000_000, dWaitNs: 12_000_000 }),
    sample(50, { state: 'D', wchan: 'folio_wait_bit_common' }),
    sample(70, { state: 'D', wchan: 'folio_wait_bit_common' }),
    sample(90, { dRunNs: 15_000_000, dMajflt: 1, dBlkioTicks: 1 }),
    sample(110, { state: 'D', wchan: 'io_schedule', dBlkioTicks: 1 }),
    sample(130, { state: 'S', wchan: 'futex_wait_queue' }),
    sample(150, { state: 'S', wchan: 'ep_poll', dWaitNs: 2_000_000 }),
    { kind: 'late', ...clockAt(350), spanMs: 200, lateMs: 180 },
    sample(370, { dWaitNs: 80_000_000 }), // Wait posted when scheduled.
    sample(590, { state: 'D', wchan: 'io_schedule', spanMs: 220, lateMs: 200 }),
    {
      kind: 'summary', ...clockAt(1_005), throughAt: clockAt(1_000).at, spanMs: 1_000,
      runNs: 37_000_000, waitNs: 94_000_000, majflt: 1, blkioTicks: 1, idleRunNs: 4_000_000,
      pswpin: 0, pressureUs: { cpu: { some: 0, full: 0 }, memory: { some: 0, full: 0 }, io: { some: 0, full: 0 } },
      host: [],
    },
    sample(30_010, { dRunNs: 20_000_000 }), // Half inside the window.
    sample(30_030, { dRunNs: 20_000_000 }), // Outside the window.
  ];
  expect(summarizeFreeze(rows, freeze)).toEqual({
    at: '2026-11-17T12:00:30.000Z', role: 'front', count: 3, totalMs: 3_700, maxMs: 1_400, window_ms: 30_000,
    runningMs: 47, runQueueMs: 94, blockedMajfltMs: 45, blockedBlkioMs: 20, blockedOtherMs: 20,
    topWchan: 'folio_wait_bit_common', topWchanMs: 45, coveredMs: 1_000, covered_ms: 1_000, lateTicks: 2, lateMs: 380,
  });
});

test('filters freeze frames and heartbeat holds by role', () => {
  const prefix = `${clockAt(250_000).at} [olympus:control-path]`;
  const front = `${prefix} freeze frames role=front count=1 total_ms=1000 max_ms=1000`;
  const background = `${prefix} freeze frames role=background count=2 total_ms=400000 max_ms=250000`;
  expect(parseFreeze(front, 'background')).toBeNull();
  expect(parseFreeze(front, 'any')?.role).toBe('front');
  expect(parseFreeze(background, 'background')).toEqual({
    at: clockAt(250_000).at, role: 'background', count: 2, totalMs: 400_000, maxMs: 250_000, window_ms: 250_000,
  });
  expect(parseFreeze(background, 'any')?.role).toBe('background');

  const held = `${prefix} background loop held for 10 s and still held; step: none said`;
  expect(parseFreeze(held)).toBeNull();
  expect(parseFreeze(held, 'background')).toEqual({
    at: clockAt(250_000).at, role: 'background', count: null, totalMs: null, maxMs: null, window_ms: 10_000,
  });
  expect(parseFreeze(held.replace('10 s', '120 s'), 'any')?.window_ms).toBe(120_000);
  expect(parseFreeze(`${prefix} background loop turned again after 60 s or more`, 'any')).toBeNull();
});

function summary(ms: number, spanMs: number): Observation {
  return {
    kind: 'summary', ...clockAt(ms), throughAt: clockAt(ms).at, spanMs,
    runNs: 0, waitNs: 0, majflt: 0, blkioTicks: 0, idleRunNs: 0, pswpin: 0,
    pressureUs: { cpu: { some: 0, full: 0 }, memory: { some: 0, full: 0 }, io: { some: 0, full: 0 } },
    host: [],
  };
}

async function writeTimeline(dir: string, rows: Observation[]): Promise<string> {
  const path = join(dir, 'timeline.jsonl');
  await writeFile(path, rows.map((row) => JSON.stringify(row) + '\n').join(''));
  return path;
}

function summarizeTimeline(path: string, ...args: string[]): ReturnType<typeof summarizeFreeze>[] {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/front-thread-timeline.ts'), '--summarize', path, ...args]);
  expect(run.stderr.toString()).toBe('');
  expect(run.exitCode).toBe(0);
  return run.stdout.toString().trim().split('\n').map((line) => JSON.parse(line));
}

test('keeps observations for a 250 s freeze across an earlier short report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'front-thread-timeline-'));
  try {
    const timeline = await writeTimeline(dir, [
      sample(50_020, { dRunNs: 20_000_000 }), summary(51_000, 1_000),
      summary(220_000, 1_000), summary(281_000, 1_000), summary(301_000, 2_000),
    ]);
    const log = join(dir, 'engine.log');
    await writeFile(log, [
      `${clockAt(300_000).at} [olympus:control-path] freeze frames role=background count=2 total_ms=400000 max_ms=250000`,
      `${clockAt(280_500).at} [olympus:control-path] freeze frames role=front count=1 total_ms=1000 max_ms=1000`,
    ].join('\n'));
    const rows = summarizeTimeline(timeline, '--freezes', log, '--role', 'any');
    expect(rows).toMatchObject([
      { role: 'front', window_ms: 30_000, covered_ms: 500, runningMs: 0 },
      { role: 'background', window_ms: 250_000, covered_ms: 4_000, runningMs: 20 },
    ]);
    expect(summarizeTimeline(timeline, '--freezes', log)).toEqual(rows.slice(0, 1));
    expect(summarizeTimeline(timeline, '--freezes', log, '--role', 'background', '--window-ms', '500')).toMatchObject([
      { role: 'background', maxMs: 250_000, window_ms: 500, covered_ms: 500, runningMs: 0 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test('summarizes repeated marker spans without a log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'front-thread-timeline-'));
  try {
    const timeline = await writeTimeline(dir, [
      sample(500, { dRunNs: 20_000_000 }), summary(1_000, 1_000),
      sample(1_260, { dRunNs: 20_000_000 }), summary(2_000, 1_000),
    ]);
    const marker = `${clockAt(1_500).at},250`;
    expect(summarizeTimeline(timeline, '--marker', marker, '--marker', `${clockAt(1_000).at},750`)).toMatchObject([
      { at: clockAt(1_000).at, role: null, window_ms: 750, covered_ms: 750, runningMs: 20 },
      { at: clockAt(1_500).at, role: null, window_ms: 250, covered_ms: 250, runningMs: 10 },
    ]);
    expect(summarizeTimeline(timeline, '--marker', marker, '--window-ms', '100')).toMatchObject([
      { window_ms: 100, covered_ms: 100, runningMs: 0 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test('stops within the byte cap and writes size_cap as the final JSON line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'front-thread-timeline-'));
  const path = join(dir, 'timeline.jsonl');
  const first = sample(20);
  const second = sample(40);
  const cap = Buffer.byteLength(JSON.stringify(first) + '\n') + 128;
  try {
    const output = await TimelineOutput.open(path, cap);
    try {
      expect(await output.append(first)).toBe(true);
      expect(await output.append(second)).toBe(false);
    } finally {
      await output.close(clockAt(40), 'duration');
    }
    const file = await readFile(path, 'utf8');
    expect(file.endsWith('\n')).toBe(true);
    expect(file.trimEnd().split('\n').map((line) => JSON.parse(line))).toEqual([
      first,
      { kind: 'end', ...clockAt(40), reason: 'size_cap' },
    ]);
    expect(Buffer.byteLength(file)).toBeLessThanOrEqual(cap);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
