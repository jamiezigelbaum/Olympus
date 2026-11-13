// The engine's heartbeat comes from a Worker thread, so it keeps beating
// while the engine's only loop sits in one long synchronous call (a store
// backup, a migration). The supervisor waits on it instead of judging a
// process by how fast it answers: every split install failure on large data
// (gate7, 13 Nov) was a busy process read as a dead one.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStartupWatch, engineHeartbeatBeating, engineHeartbeatLine, HEARTBEAT_STALE_MS, readEngineHeartbeat } from '../src/core/engine-heartbeat.ts';
import { createNativeProcessService } from '../src/core/native-process-service.ts';
import { sharedDataPath } from '../src/core/olympus-layout.ts';
import { waitFor } from './helpers/test-clock.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'olympus-heartbeat-'));
  roots.push(root);
  return { HOME: root, XDG_DATA_HOME: join(root, '.local', 'share'), PATH: process.env.PATH ?? '' };
}

const MODULE = join(import.meta.dir, '..', 'src', 'core', 'engine-heartbeat.ts');

/** A child that starts its heartbeat, names its step, then holds its loop for `blockMs`. */
function blockingChild(env: Record<string, string>, blockMs: number, readyFile: string, withHeartbeat = true): string {
  return `
    const { startEngineHeartbeat, setEngineStep } = await import(${JSON.stringify(MODULE)});
    const { writeFileSync } = await import('node:fs');
    const env = ${JSON.stringify(env)};
    if (${withHeartbeat}) { startEngineHeartbeat(env, 'background'); setEngineStep('backing up fixture'); }
    // A turn of the loop first, so the heartbeat thread is running; then the hold.
    setTimeout(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${blockMs});
      writeFileSync(${JSON.stringify(readyFile)}, '');
    }, 300);
    setInterval(() => {}, 1000);
  `;
}

describe('the heartbeat beats while the loop is held', () => {
  test('a child holding its loop for 4 s keeps writing, says what it is doing and how long it has been held', async () => {
    const env = home();
    const readyFile = join(env.HOME!, 'ready');
    const child = spawnProcess(process.execPath, ['-e', blockingChild(env, 4_000, readyFile)], { stdio: 'ignore' });
    try {
      const heartbeat = await waitFor(() => {
        const read = readEngineHeartbeat(env);
        return read && read.blockedMs > 1_500 ? read : undefined;
      }, { timeoutMs: 10_000, intervalMs: 100 });
      expect(existsSync(readyFile)).toBe(false);
      expect(engineHeartbeatBeating(heartbeat, { pid: child.pid! })).toBe(true);
      expect(heartbeat!.step).toBe('backing up fixture');
      expect(heartbeat!.blockedMs).toBeGreaterThan(1_500);
      expect(engineHeartbeatLine(heartbeat!)).toMatch(/^backing up fixture \(\d+ s\)$/);
    } finally {
      child.kill('SIGKILL');
    }
  }, 20_000);

  test('a heartbeat from a gone process, an old one, or another pid is not beating', () => {
    const at = new Date().toISOString();
    const heartbeat = { schema: 'olympus.engine-heartbeat.v1' as const, pid: process.pid, role: 'background', startedAt: at, writtenAt: at, blockedMs: 0 };
    expect(engineHeartbeatBeating(heartbeat)).toBe(true);
    expect(engineHeartbeatBeating(heartbeat, { pid: process.pid + 1_000_000 })).toBe(false);
    expect(engineHeartbeatBeating(heartbeat, { now: Date.now() + HEARTBEAT_STALE_MS + 1 })).toBe(false);
    expect(engineHeartbeatBeating(heartbeat, { alive: () => false })).toBe(false);
    expect(engineHeartbeatBeating(undefined)).toBe(false);
  });
});

describe('a supervisor waits for a live child until the cap, whatever its heartbeat says', () => {
  test('alive with no heartbeat, a stopped one or a beating one: waited for until the cap on its own clock; gone: not', () => {
    const env = home();
    let tick = 0;
    const lines: string[] = [];
    const watch = createStartupWatch({ env, capMs: () => 10 * 60_000, now: () => tick, log: (line) => lines.push(line) });
    expect(watch(process.pid)).toBe(true);
    expect(lines.at(-1)).toContain('no heartbeat from it yet');
    // A heartbeat file an hour old (a laptop that slept) is reported, not a reason to give up.
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const path = sharedDataPath('engine-heartbeat', env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ schema: 'olympus.engine-heartbeat.v1', pid: process.pid, role: 'background', startedAt: old, writtenAt: old, blockedMs: 0, step: 'backing up fixture' }));
    tick = 9 * 60_000;
    expect(watch(process.pid)).toBe(true);
    expect(lines.at(-1)).toContain(`its heartbeat was last written at ${old}`);
    tick = 10 * 60_000;
    expect(watch(process.pid)).toBe(false);
    expect(lines.at(-1)).toContain('giving up on this start');
    expect(watch(process.pid + 1_000_000)).toBe(false);
    expect(watch(undefined)).toBe(false);
  });

  test('a real child holding its loop past its start window with no heartbeat at all is still waited for', async () => {
    const env = home();
    const readyFile = join(env.HOME!, 'ready');
    const service = createNativeProcessService({
      id: 'fixture', label: 'fixture', initialConfig: {}, reload: { configPrefixes: [] },
      readinessPollMs: 20, stopGraceMs: 100, restartDelaysMs: [60_000],
      async prepareStart() {
        const watch = createStartupWatch({ env, capMs: () => 60_000, log: () => {} });
        return {
          command: process.execPath, args: ['-e', blockingChild(env, 4_000, readyFile, false)], env,
          startupTimeoutMs: 1_500, endpointOccupied: false,
          startupInProgress: (child) => watch(child.pid),
          readinessProbe: async () => existsSync(readyFile),
        };
      },
    });
    let outcome = 'ready';
    try {
      await service.start({ logger: { warn() {} }, serviceHealth: { reportFailure() {}, clearFailure() {} } });
    } catch {
      outcome = 'timed out';
    } finally {
      await service.stop();
    }
    expect(outcome).toBe('ready');
  }, 30_000);
});
