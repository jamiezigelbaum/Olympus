import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

export interface FileLeaseOptions {
  acquireTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Accepted for compatibility and ignored: the kernel releases a dead holder's lock, so nothing is ever judged stale. */
  staleAfterMs?: number;
  /** Accepted for compatibility and ignored: a kernel lock needs no heartbeat. */
  heartbeatIntervalMs?: number;
}

interface NormalizedFileLeaseOptions {
  acquireTimeoutMs: number;
  pollIntervalMs: number;
}

export interface ProcessInstanceIdentity {
  platform: 'linux' | 'darwin';
  bootId?: string;
  mechanism:
    | 'linux_procfs_start_ticks'
    | 'darwin_libproc'
    | 'darwin_ps_lstart';
  /**
   * Linux: kernel clock ticks since boot. Darwin: integer epoch microseconds.
   * The Darwin mechanism determines precision: libproc is microsecond-precise,
   * while ps lstart is second-precise.
   */
  startTime: string;
}

type ProcessInstanceIdentityComparison = 'same' | 'different' | 'unknown';

const DEFAULT_OPTIONS: NormalizedFileLeaseOptions = {
  acquireTimeoutMs: 10_000,
  pollIntervalMs: 25,
};
const runtimeRequire = createRequire(import.meta.url);

export class FileLeaseBusyError extends Error {
  readonly code = 'file_lease_busy';
  readonly targetPath: string;
  readonly retryable = true;
  readonly retryAfterMs = 30_000;

  constructor(targetPath: string) {
    super(`A writer already holds the lease for ${targetPath}.`);
    this.targetPath = targetPath;
  }
}

export class FileLeaseLostError extends Error {
  readonly code = 'file_lease_lost';
  readonly targetPath: string;

  constructor(targetPath: string) {
    super(`The writer lease for ${targetPath} is no longer owned by this process.`);
    this.targetPath = targetPath;
  }
}

export interface FileLease {
  readonly targetPath: string;
  readonly lockPath: string;
  assertOwned(): Promise<void>;
  commit<T>(write: () => Promise<T>): Promise<T>;
}

export interface SyncFileLease {
  readonly targetPath: string;
  readonly lockPath: string;
  assertOwned(): void;
  commit<T>(write: () => T): T;
}

/**
 * Serialize a cross-process mutation with a lock the operating system holds.
 *
 * The lease is an exclusive SQLite lock (`BEGIN EXCLUSIVE`) on `<target>.lock.db`,
 * taken on an open connection and kept until release. SQLite takes it with the
 * kernel's advisory file locks, which the kernel drops the instant the holder
 * dies (SIGKILL included). So there is no owner record, no process-liveness
 * judgement, no staleness bound and no reclaim: a lease is held exactly while
 * its holder is alive and has not released it, and a contender is either given
 * it or told it is busy. Because ownership cannot be taken away, lease.commit()
 * only has to confirm the lease has not been released before it writes.
 *
 * The lock file is empty and persists between uses; never delete it while a
 * lease may be held (a new file would be a different lock). SQLite is used
 * because it is the one kernel-lock primitive both runtimes that load this
 * module ship: bun:sqlite under Bun, node:sqlite under Node (OpenClaw's plugin
 * host, Node 24).
 */
export async function withFileLease<T>(
  targetPath: string,
  callback: (lease: FileLease) => Promise<T>,
  options: FileLeaseOptions = {},
): Promise<T> {
  const owner = await acquireFileLease(targetPath, normalizeOptions(options));
  try {
    return await callback(owner);
  } finally {
    owner.release();
  }
}

/** Synchronous counterpart for the encrypted store and handle registry. */
export function withFileLeaseSync<T>(
  targetPath: string,
  callback: (lease: SyncFileLease) => T,
  options: FileLeaseOptions = {},
): T {
  const owner = acquireFileLeaseSync(targetPath, normalizeOptions(options));
  try {
    return callback(owner);
  } finally {
    owner.release();
  }
}

/**
 * True when `name` is one of the files a lease on `target` keeps beside it: the
 * lock database and SQLite's journal for it, or the `.lock` / `.lock.commit`
 * files engines from before the kernel lock left behind. Inventories that must
 * refuse unknown files use this, so a lease file is never mistaken for foreign
 * data.
 */
export function isFileLeaseSidecarName(target: string, name: string): boolean {
  if (!name.startsWith(`${target}.lock`)) return false;
  return /^[.]lock(?:[.]db(?:-journal|-wal|-shm)?|[.]commit(?:[.][1-9][0-9]*)?(?:[.]tmp-[0-9a-f-]{36})?|[.]tmp-[0-9a-f-]{36})?$/
    .test(name.slice(target.length));
}

class SyncFileLeaseOwner implements SyncFileLease {
  readonly targetPath: string;
  readonly lockPath: string;
  private lock: KernelLock | undefined;

  constructor(targetPath: string, lockPath: string, lock: KernelLock) {
    this.targetPath = targetPath;
    this.lockPath = lockPath;
    this.lock = lock;
  }

  assertOwned(): void {
    if (!this.lock) throw new FileLeaseLostError(this.targetPath);
  }

  commit<T>(write: () => T): T {
    this.assertOwned();
    return write();
  }

  release(): void {
    const lock = this.lock;
    this.lock = undefined;
    lock?.release();
  }
}

class AsyncFileLeaseOwner implements FileLease {
  readonly targetPath: string;
  readonly lockPath: string;
  private readonly inner: SyncFileLeaseOwner;

  constructor(targetPath: string, lockPath: string, lock: KernelLock) {
    this.targetPath = targetPath;
    this.lockPath = lockPath;
    this.inner = new SyncFileLeaseOwner(targetPath, lockPath, lock);
  }

  async assertOwned(): Promise<void> {
    this.inner.assertOwned();
  }

  async commit<T>(write: () => Promise<T>): Promise<T> {
    this.inner.assertOwned();
    return write();
  }

  release(): void {
    this.inner.release();
  }
}

interface KernelLock {
  release(): void;
}

async function acquireFileLease(
  targetPath: string,
  options: NormalizedFileLeaseOptions,
): Promise<AsyncFileLeaseOwner> {
  const lockPath = lockPathFor(targetPath);
  const deadline = Date.now() + options.acquireTimeoutMs;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  while (true) {
    const lock = tryKernelLock(lockPath);
    if (lock) return new AsyncFileLeaseOwner(targetPath, lockPath, lock);
    if (Date.now() >= deadline) throw new FileLeaseBusyError(targetPath);
    await sleep(options.pollIntervalMs);
  }
}

function acquireFileLeaseSync(
  targetPath: string,
  options: NormalizedFileLeaseOptions,
): SyncFileLeaseOwner {
  const lockPath = lockPathFor(targetPath);
  const deadline = Date.now() + options.acquireTimeoutMs;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  while (true) {
    const lock = tryKernelLock(lockPath);
    if (lock) return new SyncFileLeaseOwner(targetPath, lockPath, lock);
    if (Date.now() >= deadline) throw new FileLeaseBusyError(targetPath);
    sleepSync(options.pollIntervalMs);
  }
}

interface SqliteConnection {
  exec(sql: string): unknown;
  close(): void;
}

function openSqlite(path: string): SqliteConnection {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    const { Database } = runtimeRequire('bun:sqlite') as typeof import('bun:sqlite');
    const connection = new Database(path);
    // Never wait inside SQLite: the lease loop polls to its own deadline.
    connection.exec('PRAGMA busy_timeout = 0');
    return connection;
  }
  const { DatabaseSync } = runtimeRequire('node:sqlite') as typeof import('node:sqlite');
  const connection = new DatabaseSync(path);
  connection.exec('PRAGMA busy_timeout = 0');
  return connection;
}

/**
 * One attempt at the exclusive lock: the lock, or undefined when another
 * holder has it. Never waits (the caller polls) and never touches the file
 * with any other descriptor once it exists: closing any descriptor a process
 * has open on a file drops that process's POSIX locks on it, so a lock file
 * is created only if absent and is otherwise opened solely by SQLite.
 */
function tryKernelLock(lockPath: string): KernelLock | undefined {
  if (!existsSync(lockPath)) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600));
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'EEXIST')) throw error;
    }
  }
  const connection = openSqlite(lockPath);
  try {
    connection.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    closeQuietly(connection);
    if (isSqliteBusy(error)) return undefined;
    throw error;
  }
  return {
    release() {
      try {
        connection.exec('ROLLBACK');
      } catch {
        // Closing the connection releases the lock regardless.
      }
      closeQuietly(connection);
    },
  };
}

function closeQuietly(connection: SqliteConnection): void {
  try {
    connection.close();
  } catch {
    // The lock is released with the connection either way.
  }
}

/** SQLITE_BUSY (5) and SQLITE_LOCKED (6): bun:sqlite sets `code`, node:sqlite sets `errcode`. */
function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, errcode, errno } = error as { code?: unknown; errcode?: unknown; errno?: unknown };
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    || errcode === 5 || errcode === 6 || errno === 5 || errno === 6;
}

/**
 * Compare a durable process-instance receipt with the process currently using
 * that PID. Missing inspection capability deliberately preserves the fence.
 */
export function recordedProcessOwnerIsAlive(
  pid: number,
  recorded?: ProcessInstanceIdentity,
): boolean {
  if (!isProcessAlive(pid)) return false;
  if (!recorded) return true;
  const current = processInstanceIdentity(pid);
  if (!current) return true;
  return compareProcessInstanceIdentities(recorded, current) !== 'different';
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeErrorWithCode(error, 'ESRCH');
  }
}

const CURRENT_BOOT_ID = process.platform === 'darwin' ? darwinBootId() : undefined;

export function processInstanceIdentity(pid: number): ProcessInstanceIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') return linuxProcessInstanceIdentity(pid);
  if (process.platform === 'darwin') return darwinProcessInstanceIdentity(pid);
  return undefined;
}

function linuxProcessInstanceIdentity(pid: number): ProcessInstanceIdentity | undefined {
  try {
    const bootId = validatedBootId(
      'linux',
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    );
    const statText = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = statText.lastIndexOf(')');
    if (commandEnd < 0 || !statText.startsWith(`${pid} (`)) return undefined;
    // The suffix begins at proc(5) field 3 (state); field 22 (starttime) is
    // therefore zero-based token 19. Parsing after the final ')' keeps spaces
    // and parentheses inside the process name from shifting the field.
    const fieldsFromState = statText.slice(commandEnd + 1).trim().split(/\s+/);
    const startTime = fieldsFromState[19];
    if (!startTime || !/^\d+$/.test(startTime)) return undefined;
    return {
      platform: 'linux',
      ...(bootId ? { bootId } : {}),
      mechanism: 'linux_procfs_start_ticks',
      startTime,
    };
  } catch {
    return undefined;
  }
}

function darwinProcessInstanceIdentity(pid: number): ProcessInstanceIdentity | undefined {
  const startIdentity = darwinProcessStartTime(pid);
  if (!startIdentity) return undefined;
  return {
    platform: 'darwin',
    ...(CURRENT_BOOT_ID ? { bootId: CURRENT_BOOT_ID } : {}),
    ...startIdentity,
  };
}

function darwinProcessStartTime(
  pid: number,
): Pick<ProcessInstanceIdentity, 'mechanism' | 'startTime'> | undefined {
  return darwinProcessStartTimeViaLibproc(pid) ?? darwinProcessStartTimeViaPs(pid);
}

function darwinProcessStartTimeViaLibproc(
  pid: number,
): Pick<ProcessInstanceIdentity, 'mechanism' | 'startTime'> | undefined {
  const PROC_PIDTBSDINFO = 3;
  const PROC_BSDINFO_SIZE = 136;
  const PROC_BSDINFO_PID_OFFSET = 12;
  const PROC_BSDINFO_START_SECONDS_OFFSET = 120;
  const PROC_BSDINFO_START_MICROSECONDS_OFFSET = 128;
  try {
    // libproc ships with macOS. proc_pidinfo avoids a dependency on ps (and
    // remains available when Bun runs in a restricted service sandbox that
    // denies spawning). Node runtimes fall through to the base-OS ps path.
    const { dlopen, FFIType, ptr } = runtimeRequire('bun:ffi') as typeof import('bun:ffi');
    const library = dlopen('/usr/lib/libproc.dylib', {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    } as const);
    try {
      const buffer = new Uint8Array(PROC_BSDINFO_SIZE);
      const bytes = library.symbols.proc_pidinfo(
        pid,
        PROC_PIDTBSDINFO,
        0,
        ptr(buffer),
        buffer.length,
      );
      if (bytes < PROC_BSDINFO_SIZE) return undefined;
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      if (view.getUint32(PROC_BSDINFO_PID_OFFSET, true) !== pid) return undefined;
      const seconds = view.getBigUint64(PROC_BSDINFO_START_SECONDS_OFFSET, true);
      const microseconds = view.getBigUint64(PROC_BSDINFO_START_MICROSECONDS_OFFSET, true);
      if (seconds <= 0n || microseconds >= 1_000_000n) return undefined;
      return {
        mechanism: 'darwin_libproc',
        startTime: (seconds * 1_000_000n + microseconds).toString(),
      };
    } finally {
      library.close();
    }
  } catch {
    return undefined;
  }
}

function darwinProcessStartTimeViaPs(
  pid: number,
): Pick<ProcessInstanceIdentity, 'mechanism' | 'startTime'> | undefined {
  try {
    // /bin/ps ships with macOS; this is not an Xcode/developer-tool dependency.
    // C locale fixes the field names and TZ=UTC removes DST/local-zone
    // ambiguity before the fixed-format parser converts to epoch microseconds.
    const startTimeText = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().replace(/\s+/g, ' ');
    const startTime = parseDarwinPsLstart(startTimeText);
    return startTime
      ? { mechanism: 'darwin_ps_lstart', startTime }
      : undefined;
  } catch {
    return undefined;
  }
}

function parseDarwinPsLstart(value: string): string | undefined {
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/
    .exec(value);
  if (!match) return undefined;
  const month = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ].indexOf(match[1]!);
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);
  const year = Number(match[6]);
  const epochMs = Date.UTC(year, month, day, hour, minute, second);
  const roundTrip = new Date(epochMs);
  if (
    month < 0
    || roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month
    || roundTrip.getUTCDate() !== day
    || roundTrip.getUTCHours() !== hour
    || roundTrip.getUTCMinutes() !== minute
    || roundTrip.getUTCSeconds() !== second
  ) return undefined;
  return (BigInt(epochMs) * 1_000n).toString();
}

function darwinBootId(): string | undefined {
  try {
    // sysctl is a base macOS facility, not a developer-tool dependency. Some
    // service sandboxes deny it; process start identity remains usable there.
    const bootSessionUuid = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return validatedBootId('darwin', bootSessionUuid);
  } catch {
    return undefined;
  }
}

function validatedBootId(
  platform: 'linux' | 'darwin',
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (platform === 'linux') {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value.toLowerCase()
      : undefined;
  }
  // kern.bootsessionuuid uses Apple's canonical uppercase UUID text form.
  // Timestamp-shaped kern.boottime values from older records are deliberately
  // omitted so a calendar-clock adjustment cannot manufacture a boot mismatch.
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(value)
    ? value
    : undefined;
}

export function parseProcessInstanceIdentity(value: unknown): ProcessInstanceIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    (record.platform !== 'linux' && record.platform !== 'darwin')
    || typeof record.startTime !== 'string'
    || !record.startTime
  ) return undefined;
  const mechanism = parseProcessInstanceMechanism(
    record.platform,
    record.startTime,
    record.mechanism,
  );
  if (!mechanism) return undefined;
  const bootId = validatedBootId(record.platform, record.bootId);
  return {
    platform: record.platform,
    ...(bootId ? { bootId } : {}),
    mechanism: mechanism.mechanism,
    startTime: mechanism.startTime,
  };
}

function parseProcessInstanceMechanism(
  platform: 'linux' | 'darwin',
  startTime: string,
  mechanismValue: unknown,
): Pick<ProcessInstanceIdentity, 'mechanism' | 'startTime'> | undefined {
  if (platform === 'linux') {
    if (
      (mechanismValue === undefined || mechanismValue === 'linux_procfs_start_ticks')
      && /^\d+$/.test(startTime)
    ) {
      return {
        mechanism: 'linux_procfs_start_ticks',
        startTime,
      };
    }
    return undefined;
  }

  if (
    (mechanismValue === 'darwin_libproc' || mechanismValue === 'darwin_ps_lstart')
    && /^\d+$/.test(startTime)
    && BigInt(startTime) > 0n
  ) {
    return {
      mechanism: mechanismValue,
      startTime,
    };
  }

  // Compatibility for version-1 records written before mechanism tagging.
  // Native records were epoch seconds plus an unpadded integer microsecond
  // field. Tagged records use canonical integer microseconds, so a numeric
  // dotted untagged value is unambiguously the old native encoding. Untagged
  // ps records inherited the writer's locale and timezone, so they cannot be
  // normalized safely after the fact; treating them as missing identity keeps
  // a live PID fenced instead of manufacturing a false mismatch.
  if (mechanismValue === undefined) {
    const native = /^(\d+)\.(\d{1,6})$/.exec(startTime);
    if (native) {
      return {
        mechanism: 'darwin_libproc',
        startTime: (
          BigInt(native[1]!) * 1_000_000n
          + BigInt(native[2]!)
        ).toString(),
      };
    }
  }
  return undefined;
}

function compareProcessInstanceIdentities(
  expected: ProcessInstanceIdentity,
  actual: ProcessInstanceIdentity,
): ProcessInstanceIdentityComparison {
  if (expected.platform !== actual.platform) return 'unknown';
  // If either side cannot obtain boot identity, process-start identity is the
  // strongest available comparison. When both boot identities disagree, the
  // process is definitively from another boot regardless of start mechanism.
  if (
    expected.bootId !== undefined
    && actual.bootId !== undefined
    && expected.bootId !== actual.bootId
  ) return 'different';
  if (expected.platform === 'linux' && actual.platform === 'linux') {
    return expected.mechanism === 'linux_procfs_start_ticks'
      && actual.mechanism === 'linux_procfs_start_ticks'
      && expected.startTime === actual.startTime
      ? 'same'
      : 'different';
  }
  if (expected.platform !== 'darwin' || actual.platform !== 'darwin') return 'unknown';
  if (expected.mechanism === actual.mechanism) {
    return expected.startTime === actual.startTime ? 'same' : 'different';
  }
  return BigInt(expected.startTime) / 1_000_000n
    === BigInt(actual.startTime) / 1_000_000n
    ? 'same'
    : 'unknown';
}

/** @internal Deterministic coverage for identity parsing when OS probes are sandboxed. */
export const __fileLeaseIdentityTestHooks = {
  parse: parseProcessInstanceIdentity,
  compare: compareProcessInstanceIdentities,
};

function lockPathFor(targetPath: string): string {
  return `${targetPath}.lock.db`;
}

function normalizeOptions(options: FileLeaseOptions): NormalizedFileLeaseOptions {
  return {
    acquireTimeoutMs: positiveInteger(options.acquireTimeoutMs, DEFAULT_OPTIONS.acquireTimeoutMs),
    pollIntervalMs: positiveInteger(options.pollIntervalMs, DEFAULT_OPTIONS.pollIntervalMs),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0
    ? fallback
    : Math.floor(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}
