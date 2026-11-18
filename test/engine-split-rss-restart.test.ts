// The background's supervised restart on memory (docs/design/engine-split.md,
// part 3, "Restart"; #957). With the switch on the background checks its RSS
// floor; past the threshold it lets judge and scheduler work finish,
// then restarts through the same clean reload a model change uses, which the
// host's supervision restarts and which records a pass it cut short as
// interrupted, not failed (#803).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configFromPluginConfig } from '../src/core/config.ts';
import { MEMORY_SAMPLE_INTERVAL_MS } from '../src/workers/engine-split/memory.ts';
import {
  ENGINE_RSS_CHECK_INTERVAL_MS,
  ENGINE_RSS_RESTART_DEFAULT_MB,
  ENGINE_RSS_RESTART_MAX_WAIT_MS,
  engineRssRestartsFrom,
  startEngineRssRestart,
  type EngineRssRestarts,
} from '../src/workers/engine-split/rss-restart.ts';
import { ENGINE_STATUS_SNAPSHOT_SCHEMA, type EngineStatusRead } from '../src/workers/engine-split/snapshot.ts';
import { createTestClock } from './helpers/test-clock.ts';

const MB = 1024 * 1024;
const FLOOR_WINDOW_MS = 5 * ENGINE_RSS_CHECK_INTERVAL_MS;

function harness(options: { thresholdMb?: number; supervised?: boolean; previous?: EngineRssRestarts } = {}) {
  const clock = createTestClock();
  const state = { rssMb: 500, batch: false };
  const restarts: number[] = [];
  const recorded: EngineRssRestarts[] = [];
  const logs: string[] = [];
  const monitor = startEngineRssRestart({
    thresholdMb: options.thresholdMb ?? 3072,
    sample: () => ({ rss: state.rssMb * MB, anon: state.rssMb * MB }),
    batchRunning: () => state.batch,
    restart: () => { restarts.push(clock.now()); return options.supervised ?? true; },
    record: (value) => recorded.push(value),
    previous: options.previous ?? { count: 0 },
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: (timer) => clock.clearInterval(timer as Parameters<typeof clock.clearInterval>[0]),
    log: (line) => logs.push(line),
  });
  return { clock, state, restarts, recorded, logs, monitor };
}

describe('the background restarts itself when its memory floor passes the threshold', () => {
  test('a peak between minute checks is logged without triggering a restart', async () => {
    const { clock, state, restarts, logs, monitor } = harness();
    state.rssMb = 4000;
    await clock.advance(MEMORY_SAMPLE_INTERVAL_MS);
    state.rssMb = 500;
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS * 5 - MEMORY_SAMPLE_INTERVAL_MS);
    expect(restarts).toEqual([]);
    expect(monitor.restarts()).toEqual({ count: 0 });
    expect(logs[0]).toContain('rss_anon_mb=500');
    expect(logs[0]).toContain('peak_anon_mb=4000');
    expect(logs[0]).toContain('floor_anon_mb=500');
    expect(logs[0]).toContain('bursts_over_threshold=0');
    monitor.stop();
  });

  test('bursts at each minute check for an hour are counted without a restart', async () => {
    const { clock, state, restarts, logs, monitor } = harness();
    for (let minute = 0; minute < 60; minute++) {
      state.rssMb = 2000;
      await clock.advance(20_000);
      state.rssMb = 3300;
      await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS - 20_000);
    }
    expect(restarts).toEqual([]);
    expect(monitor.restarts()).toEqual({ count: 0 });
    expect(logs).toHaveLength(24);
    for (let index = 0; index < logs.length; index += 2) {
      expect(logs[index]).toBe('[olympus] memory restart not taken: burst rss_mb=3300 floor_mb=2000 threshold_mb=3072');
      expect(logs[index + 1]).toMatch(/\[olympus\] memory .*rss_anon_mb=3300 .*peak_anon_mb=3300 .*floor_anon_mb=2000 bursts_over_threshold=5 /);
    }
    monitor.stop();
  });

  test('a young idle process with high RSS waits for a full window', async () => {
    const { clock, state, restarts, logs, monitor } = harness();
    const startedAt = clock.now();
    state.rssMb = 5207;
    await clock.advance(FLOOR_WINDOW_MS - 1);
    expect(restarts).toEqual([]);
    expect(logs).toEqual([]);
    await clock.advance(1);
    expect(restarts).toEqual([startedAt + FLOOR_WINDOW_MS]);
    expect(logs[1]).toContain('floor_anon_mb=5207');
    expect(logs[1]).toContain('waited_ms=0');
    monitor.stop();
  });

  test('a monotonic climb restarts once the window minimum exceeds the threshold', async () => {
    const { clock, state, restarts, logs, monitor } = harness();
    const startedAt = clock.now();
    const restartAt = 10 * ENGINE_RSS_CHECK_INTERVAL_MS;
    for (let sample = 1; sample <= restartAt / MEMORY_SAMPLE_INTERVAL_MS; sample++) {
      // At minute nine, the oldest sample is exactly at 3072 MB.
      state.rssMb = 2484 + sample * 12;
      await clock.advance(MEMORY_SAMPLE_INTERVAL_MS);
      if (clock.now() < startedAt + restartAt) expect(restarts).toEqual([]);
    }
    expect(restarts).toEqual([startedAt + restartAt]);
    expect(logs.at(-1)).toStartWith('[engine-split] rss_restart rss_mb=3924 threshold_mb=3072 ');
    expect(logs.at(-1)).toContain('floor_anon_mb=3216');
    monitor.stop();
  });

  test('past it, the judge\'s pass finishes first; then one restart, counted and logged with its RSS', async () => {
    const { clock, state, restarts, recorded, logs, monitor } = harness();
    state.rssMb = 3100;
    state.batch = true;
    await clock.advance(FLOOR_WINDOW_MS + ENGINE_RSS_CHECK_INTERVAL_MS * 2);
    expect(restarts).toEqual([]);
    state.batch = false;
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS);
    expect(restarts).toHaveLength(1);
    expect(monitor.restarts()).toEqual({ count: 1, last: { at: new Date(restarts[0]!).toISOString(), rss_mb: 3100 } });
    // Recorded before the process goes, so the next background carries it on.
    expect(recorded).toEqual([monitor.restarts()]);
    // One line per restart that a sampler can count by its fixed prefix.
    expect(logs).toHaveLength(3);
    expect(logs[1]).toContain('[olympus] memory');
    expect(logs[2]).toStartWith(`[engine-split] rss_restart rss_mb=3100 threshold_mb=3072 restarts=1 waited_ms=${ENGINE_RSS_CHECK_INTERVAL_MS * 3} over_threshold_s=180 `);
    expect(logs[2]).toContain('rss_anon_mb=3100');
    expect(logs[2]).toContain('floor_anon_mb=3100');
    // A restart already on its way is not asked for again.
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS * 3);
    expect(restarts).toHaveLength(1);
    monitor.stop();
  });

  test('a pass that never ends does not hold the restart back for good', async () => {
    const { clock, state, restarts, logs, monitor } = harness();
    state.rssMb = 4000;
    state.batch = true;
    await clock.advance(FLOOR_WINDOW_MS + ENGINE_RSS_RESTART_MAX_WAIT_MS - ENGINE_RSS_CHECK_INTERVAL_MS);
    expect(restarts).toEqual([]);
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS);
    expect(restarts).toHaveLength(1);
    expect(logs.find(line => line.startsWith('[engine-split] rss_restart'))).toMatch(/^\[engine-split\] rss_restart rss_mb=4000 threshold_mb=3072 restarts=1 waited_ms=600000 over_threshold_s=600 at=/);
    monitor.stop();
  });

  test('a sample below the threshold between minute checks starts the wait over', async () => {
    const { clock, state, restarts, logs, monitor } = harness();
    state.rssMb = 3500;
    state.batch = true;
    await clock.advance(FLOOR_WINDOW_MS + ENGINE_RSS_RESTART_MAX_WAIT_MS - ENGINE_RSS_CHECK_INTERVAL_MS);
    state.rssMb = 2000;
    await clock.advance(MEMORY_SAMPLE_INTERVAL_MS);
    state.rssMb = 3500;
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS - MEMORY_SAMPLE_INTERVAL_MS + FLOOR_WINDOW_MS);
    expect(restarts).toEqual([]);
    state.batch = false;
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS);
    expect(restarts).toHaveLength(1);
    expect(logs.at(-1)).toContain('waited_ms=60000');
    monitor.stop();
  });

  test('the count carries on from the last background\'s snapshot', async () => {
    const { clock, state, monitor } = harness({ previous: { count: 4, last: { at: '2026-11-10T00:00:00.000Z', rss_mb: 3300 } } });
    state.rssMb = 3200;
    await clock.advance(FLOOR_WINDOW_MS);
    expect(monitor.restarts().count).toBe(5);
    monitor.stop();
    const read = (rss_restarts: unknown): EngineStatusRead => ({ age_ms: 0, stale: true, snapshot: { schema: ENGINE_STATUS_SNAPSHOT_SCHEMA, instance_id: 'b', written_at: '2026-11-10T00:00:00.000Z', scheduler: null, judge: { backlog: null, pending: null, spending: null }, captures: null, ...(rss_restarts === undefined ? {} : { rss_restarts }) } as EngineStatusRead['snapshot'] });
    expect(engineRssRestartsFrom(read({ count: 4, last: { at: '2026-11-10T00:00:00.000Z', rss_mb: 3300 } }))).toEqual({ count: 4, last: { at: '2026-11-10T00:00:00.000Z', rss_mb: 3300 } });
    expect(engineRssRestartsFrom(read(undefined))).toEqual({ count: 0 });
    expect(engineRssRestartsFrom(read({ count: -1 }))).toEqual({ count: 0 });
    expect(engineRssRestartsFrom(undefined)).toEqual({ count: 0 });
  });

  test('a background nothing would restart says so once, and keeps running', async () => {
    const { clock, state, restarts, logs, monitor } = harness({ supervised: false });
    state.rssMb = 3200;
    await clock.advance(FLOOR_WINDOW_MS + ENGINE_RSS_CHECK_INTERVAL_MS * 2);
    expect(restarts).toHaveLength(1);
    expect(monitor.restarts()).toEqual({ count: 0 });
    expect(logs.filter(line => line.startsWith('[engine-split]'))).toEqual(['[engine-split] rss_over_threshold rss_mb=3200 threshold_mb=3072: nothing supervises this process, so it keeps running.']);
    monitor.stop();
  });

  test('a threshold of 0 turns it off', async () => {
    const { clock, state, restarts, monitor } = harness({ thresholdMb: 0 });
    state.rssMb = 100_000;
    await clock.advance(FLOOR_WINDOW_MS + ENGINE_RSS_CHECK_INTERVAL_MS * 2);
    expect(restarts).toEqual([]);
    monitor.stop();
  });
});

describe('the threshold setting', () => {
  test('defaults to the documented value; 0 or a whole number of MB; nothing else', () => {
    expect(configFromPluginConfig({}, { requireResolvedWorkerSecrets: false }).worker.engineSplitRssRestartMb).toBe(ENGINE_RSS_RESTART_DEFAULT_MB);
    expect(configFromPluginConfig({ worker: { engineSplitRssRestartMb: 0 } }, { requireResolvedWorkerSecrets: false }).worker.engineSplitRssRestartMb).toBe(0);
    expect(configFromPluginConfig({ worker: { engineSplitRssRestartMb: 2048 } }, { requireResolvedWorkerSecrets: false }).worker.engineSplitRssRestartMb).toBe(2048);
    for (const bad of [-1, 1.5, '3000']) {
      expect(() => configFromPluginConfig({ worker: { engineSplitRssRestartMb: bad } }, { requireResolvedWorkerSecrets: false }), String(bad)).toThrow('worker.engineSplitRssRestartMb');
    }
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../openclaw.plugin.json'), 'utf8'));
    expect(manifest.configSchema.properties.worker.properties.engineSplitRssRestartMb).toMatchObject({ type: 'integer', minimum: 0 });
  });
});

describe('the background\'s wiring', () => {
  const server = readFileSync(join(import.meta.dir, '../src/workers/engine/server.ts'), 'utf8');

  test('only the background checks, between judge passes, and restarts through the model reload', () => {
    const at = server.indexOf('const rssRestart = startEngineRssRestart({');
    expect(at).toBeGreaterThan(0);
    // Inside the background's own branch: with the switch off nothing starts.
    const branch = server.lastIndexOf("if (engineRole === 'background'", at);
    expect(branch).toBeGreaterThan(0);
    expect(server.slice(branch, at)).not.toMatch(/\n {2}\}\n/);
    const wiring = server.slice(at, server.indexOf('});', at));
    expect(wiring).toContain('thresholdMb: olympusConfig.worker.engineSplitRssRestartMb,');
    // Between batches: no judge pass and no scheduler task running.
    expect(wiring).toContain('batchRunning: () => (tierSniffer?.passRunning ?? false) || (sourceScheduler?.anyTaskRunning ?? false),');
    // The reload a model change uses: a clean shutdown that records a pass it
    // cuts short as interrupted, not failed (#803), then exit for the host to restart.
    expect(wiring).toContain('restart: () => requestModelReload(),');
    // The count goes out in the snapshot before the process does.
    expect(wiring).toContain('record: () => status.publish(),');
    expect(wiring).toContain('previous: engineRssRestartsFrom(readEngineStatusSnapshot(engineStatusSnapshotPath(process.env))),');
    expect(server).toMatch(/rss_restarts: rssRestart\.restarts\(\),/);
    // A task still running at the exit (the wait has a ceiling) is recorded
    // as interrupted before the process goes, not left pending (#803).
    // It is the reload's own last step, which runs even when the drain fails.
    expect(server).toContain('beforeExit: () => { sourceScheduler?.settleInterruptedAttempts(); },');
    expect(server).toMatch(/engineBackground = \{ stop: \(\) => \{ (walSampler\??\.stop\(\); (checkpointer\?\.stop\(\); )?)?statusRecount\?\.stop\(\); rssRestart\.stop\(\); status\.stop\(\); commands\.stop\(\); \} \};/);
  });
});
