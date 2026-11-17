import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
    at: '2026-11-17T12:00:30.000Z', count: 3, totalMs: 3_700, maxMs: 1_400,
    runningMs: 47, runQueueMs: 94, blockedMajfltMs: 45, blockedBlkioMs: 20, blockedOtherMs: 20,
    topWchan: 'folio_wait_bit_common', topWchanMs: 45, coveredMs: 1_000, lateTicks: 2, lateMs: 380,
  });
});

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
