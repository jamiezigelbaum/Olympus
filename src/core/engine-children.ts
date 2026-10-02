/**
 * The standalone engine's record of the process groups it started.
 *
 * The shared supervision kernel starts every child in its own process group
 * (detached) so it can stop a child together with its descendants. That is
 * right while the host is alive, and wrong when the host dies without running
 * its stop path (SIGKILL, a crash, launchd's exit timeout): launchd stops the
 * host's own group only, and the detached children keep running, holding the
 * worker port and the data root.
 *
 * So the engine host records each child group here as it starts it, and
 * removes it once the kernel has stopped that group. At the next host start,
 * and after `olympus engine stop|uninstall`, any group still recorded is
 * stopped, but only after the process table proves it is ours: a member's
 * command line must contain this install's cli.js path or the Olympus data
 * root. A recycled process-group id with someone else's processes is never
 * signalled.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { removeFileDurablySync, writePrivateFileAtomicSync } from './atomic-file.ts';
import type { NativeProcessChildObserver } from './native-process-service.ts';
import { olympusDataDir } from './remote-access.ts';

export const ENGINE_CHILDREN_SCHEMA = 'olympus.engine.children.v1';
const DEFAULT_REAP_GRACE_MS = 2_000;

export interface EngineChildRecord {
  service: string;
  pgid: number;
  started_at: string;
}

export interface EngineChildrenFile {
  schema: typeof ENGINE_CHILDREN_SCHEMA;
  host_pid: number;
  /** Command-line fragments that identify this install's processes. */
  markers: string[];
  children: EngineChildRecord[];
}

export interface ProcessTableEntry {
  pid: number;
  pgid: number;
  command: string;
}

export interface EngineChildReapDeps {
  /** The current process table; defaults to `ps -axo pid=,pgid=,command=`. */
  listProcesses?: () => ProcessTableEntry[] | undefined;
  /** Defaults to process.kill (negative pid = the whole group). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => void;
  graceMs?: number;
  /** This process's own pid; its group is never signalled. */
  selfPid?: number;
}

export interface EngineChildReapResult {
  /** Recorded groups that were ours and were stopped. */
  stopped: Array<{ service: string; pgid: number }>;
  /** Recorded groups left alone: gone already, or not provably ours. */
  skipped: Array<{ service: string; pgid: number; reason: 'gone' | 'not_ours' | 'self' }>;
}

export function engineChildrenPath(env: Record<string, string | undefined> = process.env): string {
  return join(olympusDataDir(env), 'engine', 'children.json');
}

export function readEngineChildren(path: string): EngineChildrenFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as EngineChildrenFile;
    if (parsed?.schema !== ENGINE_CHILDREN_SCHEMA || !Array.isArray(parsed.children) || !Array.isArray(parsed.markers)) return undefined;
    return {
      ...parsed,
      markers: parsed.markers.filter((marker) => typeof marker === 'string' && marker.length >= 8),
      children: parsed.children.filter((child) => Number.isSafeInteger(child?.pgid) && child.pgid > 1),
    };
  } catch {
    return undefined;
  }
}

/**
 * Stop every recorded child group that is still running and provably ours,
 * then remove the record. Synchronous on purpose: it runs before the host
 * spawns anything, and from the sync `olympus engine stop|uninstall` paths.
 * Never throws; an unreadable process table leaves the record in place.
 */
export function reapRecordedEngineChildren(path: string, deps: EngineChildReapDeps = {}): EngineChildReapResult {
  const result: EngineChildReapResult = { stopped: [], skipped: [] };
  const record = readEngineChildren(path);
  if (!record) {
    if (existsSync(path)) removeRecord(path);
    return result;
  }
  if (record.children.length === 0) {
    removeRecord(path);
    return result;
  }
  const list = deps.listProcesses ?? listProcessTable;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const sleep = deps.sleep ?? sleepSync;
  const selfPid = deps.selfPid ?? process.pid;
  const table = list();
  if (!table) return result;
  const selfGroup = table.find((entry) => entry.pid === selfPid)?.pgid;
  const targets: EngineChildRecord[] = [];
  for (const child of record.children) {
    if (child.pgid === selfPid || child.pgid === selfGroup) {
      result.skipped.push({ service: child.service, pgid: child.pgid, reason: 'self' });
      continue;
    }
    const members = table.filter((entry) => entry.pgid === child.pgid);
    if (members.length === 0) {
      result.skipped.push({ service: child.service, pgid: child.pgid, reason: 'gone' });
      continue;
    }
    const ours = record.markers.length > 0
      && members.some((member) => record.markers.some((marker) => member.command.includes(marker)));
    if (!ours) {
      result.skipped.push({ service: child.service, pgid: child.pgid, reason: 'not_ours' });
      continue;
    }
    targets.push(child);
  }
  for (const child of targets) signalGroup(kill, child.pgid, 'SIGTERM');
  if (targets.length > 0) {
    sleep(deps.graceMs ?? DEFAULT_REAP_GRACE_MS);
    const after = list();
    for (const child of targets) {
      if (!after || after.some((entry) => entry.pgid === child.pgid)) signalGroup(kill, child.pgid, 'SIGKILL');
      result.stopped.push({ service: child.service, pgid: child.pgid });
    }
  }
  removeRecord(path);
  return result;
}

/**
 * The observer the engine host hands the supervision kernel: it keeps the
 * record in step with the groups the kernel owns. Record writes are best
 * effort; a failed write never fails a start.
 */
export function engineChildrenRecorder(input: { path: string; markers: string[]; hostPid?: number; now?: () => Date }): NativeProcessChildObserver {
  const children = new Map<number, EngineChildRecord>();
  const write = (): void => {
    try {
      if (children.size === 0) {
        removeRecord(input.path);
        return;
      }
      mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
      const file: EngineChildrenFile = {
        schema: ENGINE_CHILDREN_SCHEMA,
        host_pid: input.hostPid ?? process.pid,
        markers: input.markers,
        children: [...children.values()],
      };
      writePrivateFileAtomicSync(input.path, `${JSON.stringify(file, null, 2)}\n`);
    } catch {
      // Advisory: the next host start simply has less to clean up.
    }
  };
  return {
    spawned(serviceId, pid) {
      children.set(pid, { service: serviceId, pgid: pid, started_at: (input.now?.() ?? new Date()).toISOString() });
      write();
    },
    stopped(_serviceId, pid) {
      if (children.delete(pid)) write();
    },
  };
}

export function parseProcessTable(text: string): ProcessTableEntry[] {
  const entries: ProcessTableEntry[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), pgid: Number(match[2]), command: match[3]!.trim() });
  }
  return entries;
}

function listProcessTable(): ProcessTableEntry[] | undefined {
  const result = spawnSync('ps', ['-axww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  return parseProcessTable(result.stdout);
}

function signalGroup(kill: (pid: number, signal: NodeJS.Signals) => void, pgid: number, signal: NodeJS.Signals): void {
  try {
    kill(-pgid, signal);
  } catch {
    // Gone between the listing and the signal, or not ours to signal.
  }
}

function removeRecord(path: string): void {
  try {
    if (existsSync(path)) removeFileDurablySync(path);
  } catch {
    // Advisory.
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
