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
 * So the engine host records each child group here as it starts it: the
 * group leader's pid (= the group id), its start time as the process table
 * reports it, and its exact argv. It removes the entry once the kernel has
 * stopped that group. At the next host start, and after `olympus engine
 * stop|uninstall`, any group still recorded is stopped, but only while the
 * process table proves its leader is the very process recorded: same pid,
 * same start time, same command line. That is checked again immediately
 * before every signal (SIGTERM, then SIGKILL after the grace period). A
 * recycled pid or group id, a leader that is gone, an entry recorded without
 * a start time, or a process table that cannot be read means no signal: the
 * cleanup never escalates on a guess.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { removeFileDurablySync, writePrivateFileAtomicSync } from './atomic-file.ts';
import type { NativeProcessChildObserver } from './native-process-service.ts';
import { olympusDataDir } from './remote-access.ts';

export const ENGINE_CHILDREN_SCHEMA = 'olympus.engine.children.v2';
/** Records from before process identities: read, never signalled, then removed. */
const ENGINE_CHILDREN_SCHEMA_V1 = 'olympus.engine.children.v1';
const DEFAULT_REAP_GRACE_MS = 2_000;

export interface EngineChildRecord {
  service: string;
  pgid: number;
  started_at: string;
  /**
   * The group leader's start time as `ps -o lstart=` prints it (UTC), or
   * null when it could not be read at spawn: such an entry is
   * never signalled.
   */
  process_started: string | null;
  /** The leader's exact argv as spawned; the process table must show exactly this. */
  argv: string[];
}

export interface EngineChildrenFile {
  schema: typeof ENGINE_CHILDREN_SCHEMA;
  host_pid: number;
  children: EngineChildRecord[];
}

export interface ProcessTableEntry {
  pid: number;
  pgid: number;
  /** `ps -o lstart=` (UTC), whitespace collapsed. */
  started: string;
  command: string;
}

export interface EngineChildReapDeps {
  /** The current process table; defaults to `ps -axww -o pid=,pgid=,lstart=,command=`. */
  listProcesses?: () => ProcessTableEntry[] | undefined;
  /** Defaults to process.kill (negative pid = the whole group). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => void;
  graceMs?: number;
  /** This process's own pid; its group is never signalled. */
  selfPid?: number;
}

export type EngineChildSkipReason =
  /** No process is left in the group. */
  | 'gone'
  /** The group's leader is not the recorded process (recycled pid, other start time or command). */
  | 'not_ours'
  /** The host's own group. */
  | 'self'
  /** Identity could not be established: no recorded start time, a leaderless group, or an unreadable process table. */
  | 'unverified';

export interface EngineChildReapResult {
  /** Recorded groups that were ours and were stopped. */
  stopped: Array<{ service: string; pgid: number }>;
  /** Recorded groups left alone. */
  skipped: Array<{ service: string; pgid: number; reason: EngineChildSkipReason }>;
}

export function engineChildrenPath(env: Record<string, string | undefined> = process.env): string {
  return join(olympusDataDir(env), 'engine', 'children.json');
}

export function readEngineChildren(path: string): EngineChildrenFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { schema?: unknown; host_pid?: unknown; children?: unknown };
    if (!Array.isArray(parsed?.children)) return undefined;
    if (parsed.schema !== ENGINE_CHILDREN_SCHEMA && parsed.schema !== ENGINE_CHILDREN_SCHEMA_V1) return undefined;
    const legacy = parsed.schema === ENGINE_CHILDREN_SCHEMA_V1;
    const children: EngineChildRecord[] = [];
    for (const child of parsed.children as Array<Partial<EngineChildRecord> | null>) {
      if (!child || !Number.isSafeInteger(child.pgid) || child.pgid! <= 1) continue;
      const argv = !legacy && Array.isArray(child.argv) && child.argv.length > 0 && child.argv.every((arg) => typeof arg === 'string')
        ? child.argv
        : [];
      children.push({
        service: typeof child.service === 'string' ? child.service : 'unknown',
        pgid: child.pgid!,
        started_at: typeof child.started_at === 'string' ? child.started_at : '',
        // A v1 entry has no identity to prove: it is never signalled.
        process_started: !legacy && typeof child.process_started === 'string' && child.process_started ? child.process_started : null,
        argv,
      });
    }
    return {
      schema: ENGINE_CHILDREN_SCHEMA,
      host_pid: typeof parsed.host_pid === 'number' ? parsed.host_pid : 0,
      children,
    };
  } catch {
    return undefined;
  }
}

/** Whether the process table entry is the recorded group leader, exactly. */
export function isRecordedLeader(entry: ProcessTableEntry | undefined, child: EngineChildRecord): boolean {
  return entry !== undefined
    && entry.pid === child.pgid
    && entry.pgid === child.pgid
    && child.process_started !== null
    && child.argv.length > 0
    && entry.started === child.process_started
    && entry.command === child.argv.join(' ');
}

type Verdict = { ok: true } | { ok: false; reason: EngineChildSkipReason | 'unreadable' };

/** The group's identity, from a fresh look at the process table. */
function verifyGroup(table: ProcessTableEntry[] | undefined, child: EngineChildRecord): Verdict {
  if (!table) return { ok: false, reason: 'unreadable' };
  const members = table.filter((entry) => entry.pgid === child.pgid);
  if (members.length === 0) return { ok: false, reason: 'gone' };
  const leader = members.find((entry) => entry.pid === child.pgid);
  if (!leader) return { ok: false, reason: 'unverified' };
  if (child.process_started === null || child.argv.length === 0) return { ok: false, reason: 'unverified' };
  return isRecordedLeader(leader, child) ? { ok: true } : { ok: false, reason: 'not_ours' };
}

/**
 * Stop every recorded child group that is still running and provably ours,
 * then remove the record. Synchronous on purpose: it runs before the host
 * spawns anything, and from the sync `olympus engine stop|uninstall` paths.
 * Never throws. The process table is read again right before each signal;
 * an entry it could not be read for is kept in the record for next time.
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
  const first = list();
  if (!first) return result;
  const selfGroup = first.find((entry) => entry.pid === selfPid)?.pgid;
  /** Entries whose outcome could not be settled: kept for the next cleanup. */
  const unsettled: EngineChildRecord[] = [];
  const skip = (child: EngineChildRecord, reason: EngineChildSkipReason) => result.skipped.push({ service: child.service, pgid: child.pgid, reason });
  const candidates: EngineChildRecord[] = [];
  for (const child of record.children) {
    if (child.pgid === selfPid || child.pgid === selfGroup) {
      skip(child, 'self');
      continue;
    }
    const verdict = verifyGroup(first, child);
    if (verdict.ok) candidates.push(child);
    else skip(child, verdict.reason === 'unreadable' ? 'unverified' : verdict.reason);
  }
  const terminated: EngineChildRecord[] = [];
  for (const child of candidates) {
    // Again, immediately before the signal: the leader may have exited and its pid been reused.
    const verdict = verifyGroup(list(), child);
    if (!verdict.ok) {
      if (verdict.reason === 'gone') result.stopped.push({ service: child.service, pgid: child.pgid });
      else if (verdict.reason === 'unreadable') {
        skip(child, 'unverified');
        unsettled.push(child);
      } else skip(child, verdict.reason);
      continue;
    }
    signalGroup(kill, child.pgid, 'SIGTERM');
    terminated.push(child);
  }
  if (terminated.length > 0) sleep(deps.graceMs ?? DEFAULT_REAP_GRACE_MS);
  for (const child of terminated) {
    const verdict = verifyGroup(list(), child);
    if (verdict.ok) {
      // Still the recorded leader, checked just now: escalate.
      signalGroup(kill, child.pgid, 'SIGKILL');
      result.stopped.push({ service: child.service, pgid: child.pgid });
    } else if (verdict.reason === 'gone') {
      result.stopped.push({ service: child.service, pgid: child.pgid });
    } else {
      // The leader left but members stayed, or the table could not be read:
      // nothing proves the group is still ours, so it is not killed.
      skip(child, 'unverified');
      if (verdict.reason === 'unreadable') unsettled.push(child);
    }
  }
  if (unsettled.length > 0) writeRecord(path, { ...record, children: unsettled });
  else removeRecord(path);
  return result;
}

/**
 * The observer the engine host hands the supervision kernel: it keeps the
 * record in step with the groups the kernel owns, with each leader's
 * identity (start time and argv) taken when it is spawned. Record writes are
 * best effort; a failed write never fails a start.
 */
export function engineChildrenRecorder(input: {
  path: string;
  hostPid?: number;
  now?: () => Date;
  /** The start time of `pid` as `ps -o lstart=` prints it; defaults to asking ps. */
  startTimeOf?: (pid: number) => string | undefined;
}): NativeProcessChildObserver {
  const children = new Map<number, EngineChildRecord>();
  const startTimeOf = input.startTimeOf ?? processStartTime;
  const write = (): void => {
    if (children.size === 0) {
      removeRecord(input.path);
      return;
    }
    writeRecord(input.path, { schema: ENGINE_CHILDREN_SCHEMA, host_pid: input.hostPid ?? process.pid, children: [...children.values()] });
  };
  return {
    spawned(serviceId, pid, argv) {
      let started: string | undefined;
      try {
        started = startTimeOf(pid);
      } catch {
        started = undefined;
      }
      children.set(pid, {
        service: serviceId,
        pgid: pid,
        started_at: (input.now?.() ?? new Date()).toISOString(),
        process_started: started ?? null,
        argv: argv ? [...argv] : [],
      });
      write();
    },
    stopped(_serviceId, pid) {
      if (children.delete(pid)) write();
    },
  };
}

const LSTART = String.raw`[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}`;
const TABLE_LINE = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(${LSTART})\s+(.*)$`);

export function parseProcessTable(text: string): ProcessTableEntry[] {
  const entries: ProcessTableEntry[] = [];
  for (const line of text.split('\n')) {
    const match = TABLE_LINE.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), pgid: Number(match[2]), started: normalizeStart(match[3]!), command: decodePsCommand(match[4]!.trim()) });
  }
  return entries;
}

/**
 * In a UTF-8 locale ps prints text as is and control characters (a newline
 * in an argument) as `\ooo` octal escapes. Decoded back, the command reads
 * as the argv that was spawned. An argument that itself contains such an
 * escape decodes to something else and so never matches: the safe side.
 */
export function decodePsCommand(command: string): string {
  if (!/\\[0-7]{3}/.test(command)) return command;
  const bytes: number[] = [];
  for (let index = 0; index < command.length;) {
    const escape = /^\\([0-7]{3})/.exec(command.slice(index, index + 4));
    if (escape) {
      bytes.push(parseInt(escape[1]!, 8) & 0xff);
      index += 4;
      continue;
    }
    const codePoint = command.codePointAt(index)!;
    const char = String.fromCodePoint(codePoint);
    bytes.push(...Buffer.from(char, 'utf8'));
    index += char.length;
  }
  return Buffer.from(bytes).toString('utf8');
}

function normalizeStart(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * ps in a fixed UTF-8 locale and time zone, so a start time and a command
 * line read the same from the host (launchd gives it no locale) and from the
 * CLI. In the C locale macOS ps would print non-ASCII argv as `M-x` meta
 * notation instead.
 */
const PS_ENV = { ...process.env, LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8', TZ: 'UTC' };

function listProcessTable(): ProcessTableEntry[] | undefined {
  const result = spawnSync('ps', ['-axww', '-o', 'pid=,pgid=,lstart=,command='], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024, env: PS_ENV,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  return parseProcessTable(result.stdout);
}

/** One process's start time, or undefined when ps cannot say. */
export function processStartTime(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000, env: PS_ENV });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  const value = normalizeStart(result.stdout);
  return new RegExp(`^${LSTART}$`).test(value) ? value : undefined;
}

function signalGroup(kill: (pid: number, signal: NodeJS.Signals) => void, pgid: number, signal: NodeJS.Signals): void {
  try {
    kill(-pgid, signal);
  } catch {
    // Gone between the check and the signal, or not ours to signal.
  }
}

function writeRecord(path: string, file: EngineChildrenFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(path, `${JSON.stringify(file, null, 2)}\n`);
  } catch {
    // Advisory: the next host start simply has less to clean up.
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
