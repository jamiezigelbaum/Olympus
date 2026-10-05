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
  decodePsCommand,
  engineChildrenPath,
  engineChildrenRecorder,
  parseProcessTable,
  processStartTime,
  reapRecordedEngineChildren,
  readEngineChildren,
  type ProcessTableEntry,
} from '../src/core/engine-children.ts';
import { startEngineHost } from '../src/core/engine-host.ts';
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

const CLI = '/Users/friend/Library/Application Support/Olympus/app/dist/cli.js';
const WORKER_ARGV = ['/runtime/bun', CLI, '__worker-service-run'];
const RELAY_ARGV = ['/runtime/bun', CLI, '__relay-service-run', 'abc'];
const T1 = 'Fri Oct 2 10:00:00 2026';
const T2 = 'Fri Oct 2 11:30:07 2026';

interface Child { service: string; pgid: number; argv?: string[]; process_started?: string | null }

function writeRecord(path: string, children: Child[], schema = ENGINE_CHILDREN_SCHEMA): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schema,
    host_pid: 1,
    children: children.map((child) => ({
      argv: WORKER_ARGV,
      process_started: T1,
      ...child,
      started_at: '2026-10-02T00:00:00.000Z',
    })),
  }));
}

const entry = (pid: number, pgid: number, argv: string[] | string, started = T1): ProcessTableEntry =>
  ({ pid, pgid, started, command: Array.isArray(argv) ? argv.join(' ') : argv });

describe('stale child-group cleanup', () => {
  test('stops recorded groups whose leader is exactly the recorded process; leaves gone, recycled, and the host itself', () => {
    const path = join(tempRoot(), 'children.json');
    writeRecord(path, [
      { service: 'olympus-worker', pgid: 501 },
      { service: 'olympus-remote-relay', pgid: 502, argv: RELAY_ARGV },
      { service: 'olympus-source-embedding-drain', pgid: 503 },
      { service: 'olympus-worker', pgid: 900 },
    ]);
    let table: ProcessTableEntry[] = [
      entry(501, 501, WORKER_ARGV),
      entry(510, 501, '/models/llama-server --model /m.gguf'),
      // pgid 502 was recycled by someone else's process.
      entry(502, 502, '/usr/bin/vim notes.txt'),
      // pgid 503 is gone; 900 is this host's own group.
      entry(900, 900, ['/runtime/bun', CLI, '__engine-run']),
    ];
    const signals: Array<[number, string]> = [];
    const result = reapRecordedEngineChildren(path, {
      listProcesses: () => table,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        // The worker ignores SIGTERM; only SIGKILL ends its group.
        if (signal === 'SIGKILL') table = table.filter((row) => row.pgid !== -pid);
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
    let table: ProcessTableEntry[] = [entry(601, 601, WORKER_ARGV)];
    const signals: string[] = [];
    reapRecordedEngineChildren(path, {
      listProcesses: () => table,
      kill: (_pid, signal) => { signals.push(signal); table = []; },
      sleep: () => undefined,
      selfPid: 1,
    });
    expect(signals).toEqual(['SIGTERM']);
  });

  test('PoC: a pid and group reused by another run of the same command (another start time) is never signalled', () => {
    const path = join(tempRoot(), 'children.json');
    writeRecord(path, [{ service: 'olympus-worker', pgid: 611 }]);
    const signals: number[] = [];
    // Same pid, same pgid, same argv (another install's worker, or this
    // install's next host): only the start time tells it apart.
    const result = reapRecordedEngineChildren(path, {
      listProcesses: () => [entry(611, 611, WORKER_ARGV, T2)],
      kill: (pid) => { signals.push(pid); },
      sleep: () => undefined,
      selfPid: 1,
    });
    expect(result.skipped).toEqual([{ service: 'olympus-worker', pgid: 611, reason: 'not_ours' }]);
    expect(signals).toEqual([]);
  });

  test('PoC: a substring match is not identity: a process whose command merely contains our cli.js is left alone', () => {
    const path = join(tempRoot(), 'children.json');
    writeRecord(path, [{ service: 'olympus-worker', pgid: 621 }]);
    const signals: number[] = [];
    const result = reapRecordedEngineChildren(path, {
      listProcesses: () => [entry(621, 621, `/usr/bin/less ${CLI} __worker-service-run`)],
      kill: (pid) => { signals.push(pid); },
      sleep: () => undefined,
      selfPid: 1,
    });
    expect(result.skipped[0]!.reason).toBe('not_ours');
    expect(signals).toEqual([]);
  });

  test('PoC: the leader exits during the grace period and its pid group is reused: no SIGKILL', () => {
    const path = join(tempRoot(), 'children.json');
    writeRecord(path, [{ service: 'olympus-worker', pgid: 631 }]);
    let table: ProcessTableEntry[] = [entry(631, 631, WORKER_ARGV)];
    const signals: Array<[number, string]> = [];
    const result = reapRecordedEngineChildren(path, {
      listProcesses: () => table,
      kill: (pid, signal) => { signals.push([pid, signal]); },
      // While the reaper waits, the worker exits and an unrelated process
      // takes its pid as a new group leader.
      sleep: () => { table = [entry(631, 631, '/Applications/Editor.app/Contents/MacOS/Editor', T2)]; },
      selfPid: 1,
    });
    expect(signals).toEqual([[-631, 'SIGTERM']]);
    expect(result.stopped).toEqual([]);
    expect(result.skipped).toEqual([{ service: 'olympus-worker', pgid: 631, reason: 'unverified' }]);
  });

  test('PoC: the leader is replaced between the first look and SIGTERM: nothing is signalled', () => {
    const path = join(tempRoot(), 'children.json');
    writeRecord(path, [{ service: 'olympus-worker', pgid: 641 }]);
    const looks = [[entry(641, 641, WORKER_ARGV)], [entry(641, 641, '/bin/zsh -l', T2)]];
    let look = 0;
    const signals: number[] = [];
    const result = reapRecordedEngineChildren(path, {
      listProcesses: () => looks[Math.min(look++, looks.length - 1)],
      kill: (pid) => { signals.push(pid); },
      sleep: () => undefined,
      selfPid: 1,
    });
    expect(signals).toEqual([]);
    expect(result.skipped).toEqual([{ service: 'olympus-worker', pgid: 641, reason: 'not_ours' }]);
  });

  test('PoC: a process table that cannot be read after SIGTERM does not escalate, and the entry is kept for next time', () => {
    const path = join(tempRoot(), 'children.json');
    writeRecord(path, [{ service: 'olympus-worker', pgid: 651 }]);
    let readable = true;
    const signals: Array<[number, string]> = [];
    const result = reapRecordedEngineChildren(path, {
      listProcesses: () => (readable ? [entry(651, 651, WORKER_ARGV)] : undefined),
      kill: (pid, signal) => { signals.push([pid, signal]); },
      sleep: () => { readable = false; },
      selfPid: 1,
    });
    expect(signals).toEqual([[-651, 'SIGTERM']]);
    expect(result.skipped).toEqual([{ service: 'olympus-worker', pgid: 651, reason: 'unverified' }]);
    expect(readEngineChildren(path)!.children.map((child) => child.pgid)).toEqual([651]);
  });

  test('a leaderless group (members left, leader gone) is never signalled', () => {
    const path = join(tempRoot(), 'children.json');
    writeRecord(path, [{ service: 'olympus-worker', pgid: 661 }]);
    const signals: number[] = [];
    const result = reapRecordedEngineChildren(path, {
      listProcesses: () => [entry(662, 661, '/models/llama-server --model /m.gguf')],
      kill: (pid) => { signals.push(pid); },
      sleep: () => undefined,
      selfPid: 1,
    });
    expect(signals).toEqual([]);
    expect(result.skipped).toEqual([{ service: 'olympus-worker', pgid: 661, reason: 'unverified' }]);
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

  test('an entry without a recorded start time, a v1 record, or a damaged record never signals anything', () => {
    const root = tempRoot();
    const path = join(root, 'children.json');
    const deps = {
      listProcesses: () => [entry(801, 801, WORKER_ARGV)],
      kill: (pid: number) => { signals.push(pid); },
      sleep: () => undefined,
      selfPid: 1,
    };
    const signals: number[] = [];
    writeRecord(path, [{ service: 'olympus-worker', pgid: 801, process_started: null }]);
    expect(reapRecordedEngineChildren(path, deps).skipped).toEqual([{ service: 'olympus-worker', pgid: 801, reason: 'unverified' }]);
    // The record format from before process identities (markers, no argv or start time).
    mkdirSync(root, { recursive: true });
    writeFileSync(path, JSON.stringify({
      schema: 'olympus.engine.children.v1', host_pid: 1, markers: [CLI],
      children: [{ service: 'olympus-worker', pgid: 801, started_at: '2026-10-02T00:00:00.000Z' }],
    }));
    expect(reapRecordedEngineChildren(path, deps).skipped).toEqual([{ service: 'olympus-worker', pgid: 801, reason: 'unverified' }]);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, '{not json');
    expect(readEngineChildren(path)).toBeUndefined();
    expect(reapRecordedEngineChildren(path, deps).stopped).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(signals).toEqual([]);
  });

  test('parses the ps listing with start times, and decodes escaped control characters', () => {
    expect(parseProcessTable([
      '  101   101 Fri Oct  2 19:33:36 2026     /bin/bun /a b/cli.js __engine-run',
      '  202   101 Thu Oct 12 09:03:06 2026     llama-server --model x\\012y',
      'garbage',
      '',
    ].join('\n'))).toEqual([
      { pid: 101, pgid: 101, started: 'Fri Oct 2 19:33:36 2026', command: '/bin/bun /a b/cli.js __engine-run' },
      { pid: 202, pgid: 101, started: 'Thu Oct 12 09:03:06 2026', command: 'llama-server --model x\ny' },
    ]);
    expect(decodePsCommand('/Users/jos\\303\\251/cli.js')).toBe('/Users/josé/cli.js');
    expect(decodePsCommand('/Users/josé/cli.js')).toBe('/Users/josé/cli.js');
  });

  test('a real orphaned group, recorded with its identity, is stopped; a real unrelated group with a recycled record is not', async () => {
    const root = tempRoot();
    const path = join(root, 'children.json');
    const marker = join(root, 'app', 'dist', 'cli.js');
    const argv = [process.execPath, '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)', marker];
    const orphan = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' });
    const bystander = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => orphan.once('exit', () => resolve()));
    try {
      await Bun.sleep(200);
      const started = processStartTime(orphan.pid!);
      expect(started).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
      writeRecord(path, [
        { service: 'olympus-worker', pgid: orphan.pid!, argv, process_started: started! },
        // The bystander runs the same argv but was not this record's process: wrong start time.
        { service: 'olympus-remote-relay', pgid: bystander.pid!, argv, process_started: 'Mon Jan 1 00:00:00 2001' },
      ]);
      const result = reapRecordedEngineChildren(path, { graceMs: 200 });
      expect(result.stopped).toEqual([{ service: 'olympus-worker', pgid: orphan.pid! }]);
      expect(result.skipped).toEqual([{ service: 'olympus-remote-relay', pgid: bystander.pid!, reason: 'not_ours' }]);
      await Promise.race([exited, Bun.sleep(5_000).then(() => { throw new Error('orphan still running'); })]);
      expect(bystander.exitCode).toBeNull();
    } finally {
      try { process.kill(-orphan.pid!, 'SIGKILL'); } catch { /* already gone */ }
      try { process.kill(-bystander.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 15_000);
});

describe('the engine records the groups it starts', () => {
  test('the kernel reports each spawned group and its removal once the group is stopped', async () => {
    const path = join(tempRoot(), 'children.json');
    setNativeProcessChildObserver(engineChildrenRecorder({ path, hostPid: 4242 }));
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
    expect(record).toMatchObject({ host_pid: 4242, schema: ENGINE_CHILDREN_SCHEMA });
    expect(record!.children).toHaveLength(1);
    const child = record!.children[0]!;
    expect(child).toMatchObject({ service: 'olympus-fixture', argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] });
    expect(child.pgid).toBeGreaterThan(1);
    // The identity recorded at spawn is the one the live process table shows.
    expect(child.process_started).toBe(processStartTime(child.pgid)!);
    const live = parseProcessTable(Bun.spawnSync(['ps', '-o', 'pid=,pgid=,lstart=,command=', '-p', String(child.pgid)], {
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', TZ: 'UTC' },
    }).stdout.toString());
    expect(live[0]!.command).toBe(child.argv.join(' '));
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
    writeRecord(childrenPath, [{ service: 'olympus-worker', pgid: 5151 }]);
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
        listProcesses: () => [entry(5151, 5151, WORKER_ARGV)],
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
