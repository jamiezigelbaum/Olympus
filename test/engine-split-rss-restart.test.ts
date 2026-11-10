// The background's supervised restart on memory (docs/design/engine-split.md,
// part 3, "Restart"; #957). With the switch on the background checks its own
// RSS between batches; past the threshold it lets the judge's pass finish,
// then restarts through the same clean reload a model change uses, which the
// host's supervision restarts and which records a pass it cut short as
// interrupted, not failed (#803).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configFromPluginConfig } from '../src/core/config.ts';
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

function harness(options: { thresholdMb?: number; supervised?: boolean; previous?: EngineRssRestarts } = {}) {
  const clock = createTestClock();
  const state = { rssMb: 500, batch: false };
  const restarts: number[] = [];
  const recorded: EngineRssRestarts[] = [];
  const logs: string[] = [];
  const monitor = startEngineRssRestart({
    thresholdMb: options.thresholdMb ?? 3072,
    rss: () => state.rssMb * MB,
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

describe('the background restarts itself when its memory passes the threshold', () => {
  test('below the threshold nothing happens', async () => {
    const { clock, restarts, monitor } = harness();
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS * 5);
    expect(restarts).toEqual([]);
    expect(monitor.restarts()).toEqual({ count: 0 });
    monitor.stop();
  });

  test('past it, the judge\'s pass finishes first; then one restart, counted and logged with its RSS', async () => {
    const { clock, state, restarts, recorded, logs, monitor } = harness();
    state.rssMb = 3100;
    state.batch = true;
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS * 3);
    expect(restarts).toEqual([]);
    state.batch = false;
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS);
    expect(restarts).toHaveLength(1);
    expect(monitor.restarts()).toEqual({ count: 1, last: { at: new Date(restarts[0]!).toISOString(), rss_mb: 3100 } });
    // Recorded before the process goes, so the next background carries it on.
    expect(recorded).toEqual([monitor.restarts()]);
    // One line per restart that a sampler can count by its fixed prefix.
    expect(logs).toEqual([`[engine-split] rss_restart rss_mb=3100 threshold_mb=3072 restarts=1 waited_ms=${ENGINE_RSS_CHECK_INTERVAL_MS * 3}`]);
    // A restart already on its way is not asked for again.
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS * 3);
    expect(restarts).toHaveLength(1);
    monitor.stop();
  });

  test('a pass that never ends does not hold the restart back for good', async () => {
    const { clock, state, restarts, logs, monitor } = harness();
    state.rssMb = 4000;
    state.batch = true;
    await clock.advance(ENGINE_RSS_RESTART_MAX_WAIT_MS - ENGINE_RSS_CHECK_INTERVAL_MS);
    expect(restarts).toEqual([]);
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS * 2);
    expect(restarts).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[engine-split\] rss_restart rss_mb=4000 threshold_mb=3072 restarts=1 waited_ms=\d+$/);
    monitor.stop();
  });

  test('memory that falls back below the threshold starts the wait over', async () => {
    const { clock, state, restarts, monitor } = harness();
    state.rssMb = 3500;
    state.batch = true;
    await clock.advance(ENGINE_RSS_RESTART_MAX_WAIT_MS - ENGINE_RSS_CHECK_INTERVAL_MS);
    state.rssMb = 2000;
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS);
    state.rssMb = 3500;
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS * 2);
    expect(restarts).toEqual([]);
    monitor.stop();
  });

  test('the count carries on from the last background\'s snapshot', async () => {
    const { clock, state, monitor } = harness({ previous: { count: 4, last: { at: '2026-11-10T00:00:00.000Z', rss_mb: 3300 } } });
    state.rssMb = 3200;
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS);
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
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS * 3);
    expect(restarts).toHaveLength(1);
    expect(monitor.restarts()).toEqual({ count: 0 });
    expect(logs).toEqual(['[engine-split] rss_over_threshold rss_mb=3200 threshold_mb=3072: nothing supervises this process, so it keeps running.']);
    monitor.stop();
  });

  test('a threshold of 0 turns it off', async () => {
    const { clock, state, restarts, monitor } = harness({ thresholdMb: 0 });
    state.rssMb = 100_000;
    await clock.advance(ENGINE_RSS_CHECK_INTERVAL_MS * 3);
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
  const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');

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
    expect(server).toMatch(/drain: async \(\) => \{[^\n]*sourceScheduler\?\.settleInterruptedAttempts\(\);[^\n]*\},\n\s*exit: \(code\) => process\.exit\(code\),/);
    expect(server).toMatch(/engineBackground = \{ stop: \(\) => \{ rssRestart\.stop\(\); status\.stop\(\); commands\.stop\(\); \} \};/);
  });
});
