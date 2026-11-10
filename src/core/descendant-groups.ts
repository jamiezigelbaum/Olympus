/**
 * The process groups a supervised child starts outside its own group.
 *
 * The supervision kernel (native-process-service.ts) stops a child together
 * with its own process group. An extraction command runs detached, as the
 * leader of a group of its own, so its timeout can kill all of it
 * (command-runner.ts); that group is out of the kernel's reach, and the
 * timeout dies with the child. So the child records each such group in a file
 * the kernel names (DESCENDANT_GROUPS_ENV), and the kernel stops what is
 * recorded there once the child is gone.
 *
 * Identity is the leader's pid (= the group id) and its start time as the
 * kernel counts it: field 22 of /proc/<pid>/stat, in clock ticks since boot,
 * read right after the spawn. Immediately before each signal the record is
 * checked against /proc/<pgid>/stat again: the same start time and still the
 * leader of its own group, or no signal. A command line is never compared:
 * an interpreter-launched tool (ocrmypdf is python3 running a script) shows
 * another one than it was spawned with. A leader that is gone, or a stat that
 * cannot be read, means no signal: the cleanup never escalates on a guess.
 *
 * Linux only: elsewhere there is no /proc, nothing is recorded, and the
 * kernel says once that it does not stop these groups (today's behaviour).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { olympusDataDir } from './remote-access.ts';

export const DESCENDANT_GROUPS_SCHEMA = 'olympus.descendant-groups.v1';
const DEFAULT_GRACE_MS = 2_000;
const POLL_MS = 50;

export interface DescendantGroup {
  pgid: number;
  /** Field 22 of /proc/<pgid>/stat when it was spawned. */
  starttime: string;
}

export type ReadProcStat = (pid: number) => string | undefined;

export function descendantGroupsSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux';
}

export function descendantGroupsPath(serviceId: string, env: Record<string, string | undefined> = process.env): string {
  return join(olympusDataDir(env), 'engine', `descendants-${serviceId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function readProcStatFile(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return undefined; }
}

/** The process group and start time /proc reports for `pid`, or undefined. */
export function procIdentity(pid: number, read: ReadProcStat = readProcStatFile): { pgid: number; starttime: string } | undefined {
  const text = read(pid);
  if (!text) return undefined;
  // The command name is in parentheses and may itself hold spaces or ')'.
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  // fields[0] is field 3 (state): field N is fields[N - 3].
  const pgid = Number(fields[2]);
  const starttime = fields[19];
  if (!Number.isSafeInteger(pgid) || !starttime || !/^\d+$/.test(starttime)) return undefined;
  return { pgid, starttime };
}

function readRecord(path: string): DescendantGroup[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { schema?: unknown; groups?: unknown };
    if (parsed.schema !== DESCENDANT_GROUPS_SCHEMA || !Array.isArray(parsed.groups)) return [];
    return (parsed.groups as Array<Partial<DescendantGroup> | null>).filter((group): group is DescendantGroup =>
      !!group && Number.isSafeInteger(group.pgid) && group.pgid! > 1 && typeof group.starttime === 'string' && /^\d+$/.test(group.starttime));
  } catch {
    return [];
  }
}

function writeRecord(path: string, groups: DescendantGroup[]): void {
  try {
    if (groups.length === 0) {
      if (existsSync(path)) rmSync(path, { force: true });
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schema: DESCENDANT_GROUPS_SCHEMA, groups })}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Advisory: the supervisor simply has less to clean up.
  }
}

/**
 * The child's side: record a group as it is spawned, drop it once it is done.
 * A group whose start time cannot be read is not recorded (it could never be
 * proved ours).
 */
export function descendantGroupsRecorder(path: string, read: ReadProcStat = readProcStatFile): {
  spawned(pgid: number): void;
  stopped(pgid: number): void;
} {
  const groups = new Map<number, DescendantGroup>();
  const write = () => writeRecord(path, [...groups.values()]);
  return {
    spawned(pgid) {
      const identity = procIdentity(pgid, read);
      if (!identity || identity.pgid !== pgid) return;
      groups.set(pgid, { pgid, starttime: identity.starttime });
      write();
    },
    stopped(pgid) {
      if (groups.delete(pgid)) write();
    },
  };
}

export interface StopDescendantGroupsDeps {
  read?: ReadProcStat;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  delay?: (ms: number) => Promise<void>;
  graceMs?: number;
}

/**
 * The supervisor's side, once the child that recorded them is gone: SIGTERM
 * each recorded group still provably the one recorded, wait out a grace
 * period, then SIGKILL any still provably it. Each signal is preceded by a
 * fresh identity check. Removes the record. Returns how many groups it signalled.
 */
export async function stopRecordedDescendantGroups(path: string, deps: StopDescendantGroupsDeps = {}): Promise<number> {
  const groups = readRecord(path);
  writeRecord(path, []);
  if (groups.length === 0) return 0;
  const read = deps.read ?? readProcStatFile;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
  const ours = (group: DescendantGroup) => {
    const identity = procIdentity(group.pgid, read);
    return identity !== undefined && identity.pgid === group.pgid && identity.starttime === group.starttime;
  };
  const signal = (group: DescendantGroup, name: NodeJS.Signals): boolean => {
    if (!ours(group)) return false;
    try { kill(-group.pgid, name); return true; } catch { return false; }
  };
  const terminated = groups.filter((group) => signal(group, 'SIGTERM'));
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  for (let waited = 0; waited < graceMs && terminated.some(ours); waited += POLL_MS) await delay(POLL_MS);
  for (const group of terminated) signal(group, 'SIGKILL');
  return terminated.length;
}
