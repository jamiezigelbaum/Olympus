/**
 * Orphaned engine children (review finding 2026-10-02): the kernel starts
 * every child in its own process group, so a host that dies without running
 * its stop path leaves them running. The engine host records the groups and
 * stops the ones that are provably its own at its next start.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENGINE_CHILDREN_SCHEMA,
  engineChildrenPath,
  engineChildrenRecorder,
  parseProcessTable,
  reapRecordedEngineChildren,
  readEngineChildren,
  type ProcessTableEntry,
} from '../src/core/engine-children.ts';
import { engineChildMarkers, startEngineHost } from '../src/core/engine-host.ts';
import { defaultEngineConfig, enginePaths } from '../src/core/engine-service.ts';
import { createNativeProcessService, setNativeProcessChildObserver } from '../src/core/native-process-service.ts';

const roots: string[] = [];
afterEach(() => {
  setNativeProcessChildObserver(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-engine-children-'));
  roots.push(root);
  return root;
}

const MARKER = '/Users/friend/Library/Application Support/Olympus/app/dist/cli.js';

function writeRecord(path: string, children: Array<{ service: string; pgid: number }>, markers = [MARKER]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schema: ENGINE_CHILDREN_SCHEMA,
    host_pid: 1,
    markers,
    children: children.map((child) => ({ ...child, started_at: '2026-10-02T00:00:00.000Z' })),
  }));
}

describe('stale child-group cleanup', () => {
  test('stops recorded groups that are ours, leaves groups that are gone, recycled, or the host itself', () => {
    const path = join(tempRoot(), 'children.json');
    writeRecord(path, [
      { service: 'olympus-worker', pgid: 501 },
      { service: 'olympus-remote-relay', pgid: 502 },
      { service: 'olympus-source-embedding-drain', pgid: 503 },
      { service: 'olympus-worker', pgid: 900 },
    ]);
    let table: ProcessTableEntry[] = [
      { pid: 501, pgid: 501, command: `/runtime/bun ${MARKER} __worker-service-run` },
      { pid: 510, pgid: 501, command: '/models/llama-server --model /m.gguf' },
      // pgid 502 was recycled by someone else's process.
      { pid: 502, pgid: 502, command: '/usr/bin/vim notes.txt' },
      // pgid 503 is gone; 900 is this host's own group.
      { pid: 900, pgid: 900, command: `/runtime/bun ${MARKER} __engine-run` },
    ];
    const signals: Array<[number, string]> = [];
    const result = reapRecordedEngineChildren(path, {
      listProcesses: () => table,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        // The worker ignores SIGTERM; only SIGKILL ends its group.
        if (signal === 'SIGKILL') table = table.filter((entry) => entry.pgid !== -pid);
      },
      sleep: () => undefined,
      selfPid: 900,
    });
    expect(result.stopped).toEqual([{ service: 'olympus-worker', pgid: 501 }]);
    expect(result.skipped).toEqual([
      { service: 'olympus-remote-relay', pgid: 502, reason: 'not_ours' },
      { service: 'olympus-source-embedding-drain', pgid: 503, reason: 'gone' },
      { service: 'olympus-worker', pgid: 900, reason: 'self' },
    ]);
    expect(signals).toEqual([[-501, 'SIGTERM'], [-501, 'SIGKILL']]);
    expect(existsSync(path)).toBe(false);
  });

  test('a group that exits on SIGTERM is not sent SIGKILL', () => {
    const path = join(tempRoot(), 'children.json');
    writeRecord(path, [{ service: 'olympus-worker', pgid: 601 }]);
    let table: ProcessTableEntry[] = [{ pid: 601, pgid: 601, command: `bun ${MARKER} __worker-service-run` }];
    const signals: string[] = [];
    reapRecordedEngineChildren(path, {
      listProcesses: () => table,
      kill: (_pid, signal) => { signals.push(signal); table = []; },
      sleep: () => undefined,
      selfPid: 1,
    });
    expect(signals).toEqual(['SIGTERM']);
  });

  test('an unreadable process table signals nothing and keeps the record for next time', () => {
    const path = join(tempRoot(), 'children.json');
    writeRecord(path, [{ service: 'olympus-worker', pgid: 701 }]);
    const signals: number[] = [];
    const result = reapRecordedEngineChildren(path, { listProcesses: () => undefined, kill: (pid) => { signals.push(pid); } });
    expect(result.stopped).toEqual([]);
    expect(signals).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  test('a record without markers, or a damaged record, never signals anything', () => {
    const root = tempRoot();
    const path = join(root, 'children.json');
    writeRecord(path, [{ service: 'olympus-worker', pgid: 801 }], []);
    const signals: number[] = [];
    const deps = {
      listProcesses: () => [{ pid: 801, pgid: 801, command: 'anything at all' }],
      kill: (pid: number) => { signals.push(pid); },
      sleep: () => undefined,
      selfPid: 1,
    };
    expect(reapRecordedEngineChildren(path, deps).skipped).toEqual([{ service: 'olympus-worker', pgid: 801, reason: 'not_ours' }]);
    writeFileSync(path, '{not json');
    expect(readEngineChildren(path)).toBeUndefined();
    expect(reapRecordedEngineChildren(path, deps).stopped).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(signals).toEqual([]);
  });

  test('parses the ps listing', () => {
    expect(parseProcessTable('  101   101 /bin/bun /a b/cli.js __engine-run\n  202   101 llama-server --model x\n\n')).toEqual([
      { pid: 101, pgid: 101, command: '/bin/bun /a b/cli.js __engine-run' },
      { pid: 202, pgid: 101, command: 'llama-server --model x' },
    ]);
  });

  test('a real orphaned group whose command names our cli.js is stopped', async () => {
    const root = tempRoot();
    const path = join(root, 'children.json');
    const marker = join(root, 'app', 'dist', 'cli.js');
    const orphan = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)', marker], {
      detached: true,
      stdio: 'ignore',
    });
    const exited = new Promise<void>((resolve) => orphan.once('exit', () => resolve()));
    try {
      await Bun.sleep(200);
      writeRecord(path, [{ service: 'olympus-worker', pgid: orphan.pid! }], [marker]);
      const result = reapRecordedEngineChildren(path, { graceMs: 200 });
      expect(result.stopped).toEqual([{ service: 'olympus-worker', pgid: orphan.pid! }]);
      await Promise.race([exited, Bun.sleep(5_000).then(() => { throw new Error('orphan still running'); })]);
    } finally {
      try { process.kill(-orphan.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 15_000);
});

describe('the engine records the groups it starts', () => {
  test('the kernel reports each spawned group and its removal once the group is stopped', async () => {
    const path = join(tempRoot(), 'children.json');
    setNativeProcessChildObserver(engineChildrenRecorder({ path, markers: [MARKER], hostPid: 4242 }));
    const service = createNativeProcessService({
      id: 'olympus-fixture', label: 'fixture', initialConfig: {}, reload: { configPrefixes: [] },
      readinessPollMs: 10, stopGraceMs: 100,
      async prepareStart() {
        return {
          command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {},
          startupTimeoutMs: 5_000, endpointOccupied: false, async readinessProbe() { return true; },
        };
      },
    });
    await service.start({});
    const record = readEngineChildren(path);
    expect(record).toMatchObject({ host_pid: 4242, markers: [MARKER] });
    expect(record!.children).toHaveLength(1);
    expect(record!.children[0]).toMatchObject({ service: 'olympus-fixture' });
    expect(record!.children[0]!.pgid).toBeGreaterThan(1);
    await service.stop();
    expect(existsSync(path)).toBe(false);
  }, 15_000);

  test('engine host start cleans up what a dead host left before starting services', async () => {
    const root = tempRoot();
    const home = join(root, 'home');
    mkdirSync(join(home, '.olympus'), { recursive: true });
    writeFileSync(enginePaths(home).configPath, JSON.stringify(defaultEngineConfig()));
    const childrenPath = engineChildrenPath({ HOME: home });
    expect(childrenPath).toBe(enginePaths(home).childrenPath);
    const moduleUrl = 'file:///Users/friend/Library/Application%20Support/Olympus/app/dist/cli.js';
    const markers = engineChildMarkers(moduleUrl, { HOME: home });
    expect(markers[0]).toBe(MARKER);
    writeRecord(childrenPath, [{ service: 'olympus-worker', pgid: 5151 }], markers);
    const order: string[] = [];
    const lines: string[] = [];
    const handle = await startEngineHost({
      moduleUrl,
      env: { HOME: home, OLYMPUS_ENGINE_BUILD: '9.9.9+abc' },
      homeDir: home,
      services: () => [{
        id: 'olympus-worker', reload: { configPrefixes: [] },
        async start() { order.push('start'); },
        async stop() {},
      }],
      reap: {
        listProcesses: () => [{ pid: 5151, pgid: 5151, command: `bun ${MARKER} __worker-service-run` }],
        kill: (pid, signal) => { order.push(`${signal} ${pid}`); },
        sleep: () => undefined,
        selfPid: 1,
      },
      log: (line) => lines.push(line),
      exit: () => { throw new Error('must not exit'); },
      installSignalHandlers: false,
    });
    expect(order).toEqual(['SIGTERM -5151', 'SIGKILL -5151', 'start']);
    expect(lines.some((line) => line.includes('a previous engine left running'))).toBe(true);
    expect(handle!.status().build).toBe('9.9.9+abc');
    expect(JSON.parse(readFileSync(enginePaths(home).statusPath, 'utf8')).build).toBe('9.9.9+abc');
    await handle!.stop();
  });
});
