import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

export interface FileLeaseOptions {
  acquireTimeoutMs?: number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  heartbeatIntervalMs?: number;
}

interface NormalizedFileLeaseOptions {
  acquireTimeoutMs: number;
  pollIntervalMs: number;
  staleAfterMs: number;
  heartbeatIntervalMs: number;
}

interface FileLeaseRecord {
  version: 1;
  token: string;
  pid: number;
  acquiredAt: string;
  processInstance?: ProcessInstanceIdentity;
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
  staleAfterMs: 30_000,
  heartbeatIntervalMs: 5_000,
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
 * Serialize a cross-process mutation with an O_EXCL owner-token lockfile.
 *
 * Every irreversible write must run through lease.commit(). That method and a
 * stale takeover acquire the same short-lived commit guard, so ownership
 * verification and the write callback are one compare-and-commit operation.
 * A former owner that resumes after takeover is typed-refused before its write.
 */
export async function withFileLease<T>(
  targetPath: string,
  callback: (lease: FileLease) => Promise<T>,
  options: FileLeaseOptions = {},
): Promise<T> {
  const normalized = normalizeOptions(options);
  const owner = await acquireFileLease(targetPath, normalized);
  const heartbeat = setInterval(() => {
    void owner.heartbeat();
  }, normalized.heartbeatIntervalMs);
  heartbeat.unref?.();
  try {
    return await callback(owner);
  } finally {
    clearInterval(heartbeat);
    await owner.release();
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

class AsyncFileLeaseOwner implements FileLease {
  readonly targetPath: string;
  readonly lockPath: string;
  private readonly token: string;
  private readonly descriptor: Awaited<ReturnType<typeof open>>;
  private readonly options: NormalizedFileLeaseOptions;

  constructor(
    targetPath: string,
    lockPath: string,
    token: string,
    descriptor: Awaited<ReturnType<typeof open>>,
    options: NormalizedFileLeaseOptions,
  ) {
    this.targetPath = targetPath;
    this.lockPath = lockPath;
    this.token = token;
    this.descriptor = descriptor;
    this.options = options;
  }

  async assertOwned(): Promise<void> {
    if ((await readLeaseRecord(this.lockPath))?.token !== this.token) {
      throw new FileLeaseLostError(this.targetPath);
    }
  }

  async commit<T>(write: () => Promise<T>): Promise<T> {
    return withAsyncCommitGuard(this.targetPath, this.lockPath, this.options, async () => {
      await this.assertOwned();
      return write();
    });
  }

  async heartbeat(): Promise<void> {
    try {
      await this.commit(async () => {
        const now = new Date();
        await utimes(this.lockPath, now, now);
      });
    } catch {
      // The next explicit ownership assertion reports the lost fence. A
      // heartbeat must never become an unhandled rejection.
    }
  }

  async release(): Promise<void> {
    try {
      await withAsyncCommitGuard(this.targetPath, this.lockPath, this.options, async () => {
        if ((await readLeaseRecord(this.lockPath))?.token === this.token) {
          await unlink(this.lockPath).catch((error) => {
            if (!isNodeErrorWithCode(error, 'ENOENT')) throw error;
          });
        }
      });
    } catch (error) {
      if (!(error instanceof FileLeaseBusyError)) throw error;
      // A newer owner may be committing while a taken-over callback unwinds.
      // It owns cleanup now; do not mask the typed refusal from the callback.
      if ((await readLeaseRecord(this.lockPath))?.token === this.token) {
        throw error;
      }
    } finally {
      await this.descriptor.close();
    }
  }
}

class SyncFileLeaseOwner implements SyncFileLease {
  readonly targetPath: string;
  readonly lockPath: string;
  private readonly token: string;
  private readonly descriptor: number;
  private readonly options: NormalizedFileLeaseOptions;

  constructor(
    targetPath: string,
    lockPath: string,
    token: string,
    descriptor: number,
    options: NormalizedFileLeaseOptions,
  ) {
    this.targetPath = targetPath;
    this.lockPath = lockPath;
    this.token = token;
    this.descriptor = descriptor;
    this.options = options;
  }

  assertOwned(): void {
    if (readLeaseRecordSync(this.lockPath)?.token !== this.token) {
      throw new FileLeaseLostError(this.targetPath);
    }
  }

  commit<T>(write: () => T): T {
    return withSyncCommitGuard(this.targetPath, this.lockPath, this.options, () => {
      this.assertOwned();
      return write();
    });
  }

  release(): void {
    try {
      try {
        withSyncCommitGuard(this.targetPath, this.lockPath, this.options, () => {
          if (readLeaseRecordSync(this.lockPath)?.token === this.token) {
            try {
              unlinkSync(this.lockPath);
            } catch (error) {
              if (!isNodeErrorWithCode(error, 'ENOENT')) throw error;
            }
          }
        });
      } catch (error) {
        if (!(error instanceof FileLeaseBusyError)) throw error;
        if (readLeaseRecordSync(this.lockPath)?.token === this.token) {
          throw error;
        }
      }
    } finally {
      closeSync(this.descriptor);
    }
  }
}

async function acquireFileLease(
  targetPath: string,
  options: NormalizedFileLeaseOptions,
): Promise<AsyncFileLeaseOwner> {
  const lockPath = lockPathFor(targetPath);
  const deadline = Date.now() + options.acquireTimeoutMs;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  while (true) {
    const token = randomUUID();
    let descriptor: Awaited<ReturnType<typeof open>> | undefined;
    try {
      descriptor = await open(lockPath, 'wx', 0o600);
      const record = leaseRecord(token);
      // Do not yield between exclusive creation and a parseable owner record:
      // an aggressive stale observer must never mistake an active creator for
      // an abandoned empty lockfile.
      writeFileSync(descriptor.fd, JSON.stringify(record), 'utf8');
      fsyncSync(descriptor.fd);
      return new AsyncFileLeaseOwner(targetPath, lockPath, token, descriptor, options);
    } catch (error) {
      await descriptor?.close().catch(() => undefined);
      if (!isNodeErrorWithCode(error, 'EEXIST')) throw error;
    }
    await removeStaleLease(targetPath, lockPath, options);
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
    const token = randomUUID();
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(leaseRecord(token)), 'utf8');
        fsyncSync(descriptor);
      } catch (error) {
        closeSync(descriptor);
        throw error;
      }
      return new SyncFileLeaseOwner(targetPath, lockPath, token, descriptor, options);
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'EEXIST')) throw error;
    }
    removeStaleLeaseSync(targetPath, lockPath, options);
    if (Date.now() >= deadline) throw new FileLeaseBusyError(targetPath);
    sleepSync(options.pollIntervalMs);
  }
}

async function removeStaleLease(
  targetPath: string,
  lockPath: string,
  options: NormalizedFileLeaseOptions,
): Promise<void> {
  await withAsyncCommitGuard(targetPath, lockPath, options, async () => {
    const observed = await readLeaseRecord(lockPath);
    if (!await leaseIsStale(lockPath, observed, options.staleAfterMs)) return;
    const confirmed = await readLeaseRecord(lockPath);
    if (observed && confirmed?.token !== observed.token) return;
    await unlink(lockPath).catch((error) => {
      if (!isNodeErrorWithCode(error, 'ENOENT')) throw error;
    });
  });
}

function removeStaleLeaseSync(
  targetPath: string,
  lockPath: string,
  options: NormalizedFileLeaseOptions,
): void {
  withSyncCommitGuard(targetPath, lockPath, options, () => {
    const observed = readLeaseRecordSync(lockPath);
    if (!leaseIsStaleSync(lockPath, observed, options.staleAfterMs)) return;
    const confirmed = readLeaseRecordSync(lockPath);
    if (observed && confirmed?.token !== observed.token) return;
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'ENOENT')) throw error;
    }
  });
}

async function withAsyncCommitGuard<T>(
  targetPath: string,
  lockPath: string,
  options: NormalizedFileLeaseOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const guardPath = commitGuardPathFor(lockPath);
  const deadline = Date.now() + options.acquireTimeoutMs;
  const token = randomUUID();
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  while (!descriptor) {
    try {
      descriptor = await open(guardPath, 'wx', 0o600);
      // The guard becomes parseable in the same event-loop slice as O_EXCL.
      // A crash may leave an empty orphan, but a live owner is never exposed as
      // an old malformed guard merely because its first write was awaiting I/O.
      writeFileSync(descriptor.fd, JSON.stringify(leaseRecord(token)), 'utf8');
      fsyncSync(descriptor.fd);
    } catch (error) {
      // Only a guard this process created may be removed. An open that failed
      // before the O_EXCL existence check (descriptor exhaustion) leaves a live
      // holder's guard on disk, and deleting it would admit a second committer.
      const created = descriptor !== undefined;
      await descriptor?.close().catch(() => undefined);
      descriptor = undefined;
      if (!isNodeErrorWithCode(error, 'EEXIST')) {
        if (created) await unlink(guardPath).catch(() => undefined);
        throw error;
      }
      await removeAbandonedCommitGuard(guardPath, options.staleAfterMs);
      if (Date.now() >= deadline) throw new FileLeaseBusyError(targetPath);
      await sleep(options.pollIntervalMs);
    }
  }
  try {
    return await callback();
  } finally {
    try {
      if ((await readLeaseRecord(guardPath))?.token === token) {
        await unlink(guardPath).catch((error) => {
          if (!isNodeErrorWithCode(error, 'ENOENT')) throw error;
        });
      }
    } finally {
      await descriptor.close();
    }
  }
}

function withSyncCommitGuard<T>(
  targetPath: string,
  lockPath: string,
  options: NormalizedFileLeaseOptions,
  callback: () => T,
): T {
  const guardPath = commitGuardPathFor(lockPath);
  const deadline = Date.now() + options.acquireTimeoutMs;
  const token = randomUUID();
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(guardPath, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(leaseRecord(token)), 'utf8');
      fsyncSync(descriptor);
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
        try {
          unlinkSync(guardPath);
        } catch {
          // The create/write error is authoritative.
        }
      }
      if (!isNodeErrorWithCode(error, 'EEXIST')) throw error;
      removeAbandonedCommitGuardSync(guardPath, options.staleAfterMs);
      if (Date.now() >= deadline) throw new FileLeaseBusyError(targetPath);
      sleepSync(options.pollIntervalMs);
    }
  }
  try {
    return callback();
  } finally {
    try {
      if (readLeaseRecordSync(guardPath)?.token === token) {
        try {
          unlinkSync(guardPath);
        } catch (error) {
          if (!isNodeErrorWithCode(error, 'ENOENT')) throw error;
        }
      }
    } finally {
      closeSync(descriptor);
    }
  }
}

async function removeAbandonedCommitGuard(path: string, staleAfterMs: number): Promise<void> {
  const observed = await readLeaseRecord(path);
  if (observed) {
    if (recordedProcessInstanceIsAlive(observed)) return;
    const confirmed = await readLeaseRecord(path);
    if (confirmed?.token !== observed.token) return;
  } else {
    const age = await leaseAgeMs(path);
    if (age === undefined || age < staleAfterMs) return;
  }
  await unlink(path).catch((error) => {
    if (!isNodeErrorWithCode(error, 'ENOENT')) throw error;
  });
}

function removeAbandonedCommitGuardSync(path: string, staleAfterMs: number): void {
  const observed = readLeaseRecordSync(path);
  if (observed) {
    if (recordedProcessInstanceIsAlive(observed)) return;
    const confirmed = readLeaseRecordSync(path);
    if (confirmed?.token !== observed.token) return;
  } else {
    const age = leaseAgeMsSync(path);
    if (age === undefined || age < staleAfterMs) return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isNodeErrorWithCode(error, 'ENOENT')) throw error;
  }
}

async function leaseIsStale(
  lockPath: string,
  observed: FileLeaseRecord | undefined,
  staleAfterMs: number,
): Promise<boolean> {
  if (!observed) {
    const age = await leaseAgeMs(lockPath);
    return age !== undefined && age >= staleAfterMs;
  }
  return !recordedProcessInstanceIsAlive(observed) || (await leaseAgeMs(lockPath) ?? 0) >= staleAfterMs;
}

function leaseIsStaleSync(
  lockPath: string,
  observed: FileLeaseRecord | undefined,
  staleAfterMs: number,
): boolean {
  if (!observed) {
    const age = leaseAgeMsSync(lockPath);
    return age !== undefined && age >= staleAfterMs;
  }
  return !recordedProcessInstanceIsAlive(observed) || (leaseAgeMsSync(lockPath) ?? 0) >= staleAfterMs;
}

async function readLeaseRecord(path: string): Promise<FileLeaseRecord | undefined> {
  try {
    return parseLeaseRecord(await readFile(path, 'utf8'));
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function readLeaseRecordSync(path: string): FileLeaseRecord | undefined {
  try {
    return parseLeaseRecord(readFileSync(path, 'utf8'));
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function parseLeaseRecord(text: string): FileLeaseRecord | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      value.version !== 1
      || typeof value.token !== 'string'
      || typeof value.pid !== 'number'
      || typeof value.acquiredAt !== 'string'
    ) return undefined;
    const processInstance = parseProcessInstanceIdentity(value.processInstance);
    return {
      version: 1,
      token: value.token,
      pid: value.pid,
      acquiredAt: value.acquiredAt,
      ...(processInstance ? { processInstance } : {}),
    };
  } catch {
    return undefined;
  }
}

async function leaseAgeMs(path: string): Promise<number | undefined> {
  try {
    return Math.max(0, Date.now() - (await stat(path)).mtimeMs);
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function leaseAgeMsSync(path: string): number | undefined {
  try {
    return Math.max(0, Date.now() - statSync(path).mtimeMs);
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function leaseRecord(token: string): FileLeaseRecord {
  return {
    version: 1,
    token,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    ...(CURRENT_PROCESS_INSTANCE ? { processInstance: CURRENT_PROCESS_INSTANCE } : {}),
  };
}

/**
 * A live PID is not sufficient owner identity: kernels reuse it after a crash
 * or reboot. Compare the recorded boot plus process start identity when both
 * sides can obtain one. Missing capability or denied inspection deliberately
 * returns "alive" for an existing PID, preserving the conservative fence.
 */
function recordedProcessInstanceIsAlive(record: FileLeaseRecord): boolean {
  return recordedProcessOwnerIsAlive(record.pid, record.processInstance);
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
const CURRENT_PROCESS_INSTANCE = processInstanceIdentity(process.pid);

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
  return `${targetPath}.lock`;
}

function commitGuardPathFor(lockPath: string): string {
  return `${lockPath}.commit`;
}

function normalizeOptions(options: FileLeaseOptions): NormalizedFileLeaseOptions {
  const acquireTimeoutMs = positiveInteger(options.acquireTimeoutMs, DEFAULT_OPTIONS.acquireTimeoutMs);
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_OPTIONS.pollIntervalMs);
  const staleAfterMs = positiveInteger(options.staleAfterMs, DEFAULT_OPTIONS.staleAfterMs);
  const heartbeatIntervalMs = positiveInteger(
    options.heartbeatIntervalMs,
    Math.min(DEFAULT_OPTIONS.heartbeatIntervalMs, Math.max(1, Math.floor(staleAfterMs / 3))),
  );
  return { acquireTimeoutMs, pollIntervalMs, staleAfterMs, heartbeatIntervalMs };
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
