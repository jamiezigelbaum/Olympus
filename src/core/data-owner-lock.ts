/**
 * The data owner lock: one process at a time owns Olympus's data root
 * (docs/design/source-storage.md, "Owner lock").
 *
 * The worker holds it for its whole life. Anything else that opens a store
 * (an operator script, a CLI command while the worker is stopped) holds it
 * for its run, so it refuses with a clear message while Olympus runs and the
 * worker cannot start under it. A CLI command that finds it held asks the
 * running worker to do the work instead (core/cli-via-worker.ts).
 *
 * It is a `flock(2)` exclusive lock on `<data>/data-owner.lock`, through
 * `bun:ffi` to libc. The lock sits in the data root itself, so two processes
 * that resolve the same data root contend on it whatever their state or
 * config folders are. `flock` belongs to the one descriptor that took it, not
 * to the process: another open and close of the file anywhere in the holding
 * process (a walker of the data root, a file probe) leaves it held, which a
 * POSIX `fcntl` lock such as file-lease's would not. A second take in the same
 * process is refused like any other. The descriptor is close-on-exec, so a
 * child never keeps the lock after its parent dies; the kernel drops it when
 * the holder exits, SIGKILL included. Nothing may remove or replace the file
 * while a process holds it: a new file would be a different lock.
 *
 * Deliberately light (layout and node:fs only, `bun:ffi` loaded on first
 * take): the CLI, the scripts and the file-scope decider import it.
 */
import { closeSync, constants, existsSync, mkdirSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { dirname } from 'node:path';
import { olympusDataRoot, SHARED_DATA_FILES, sharedDataPath, type LayoutEnv } from './olympus-layout.ts';

const runtimeRequire = createRequire(import.meta.url);

/** The lock file, in the data root. */
const OWNER_LOCK_NAME = SHARED_DATA_FILES['data-owner-lock'];

// <sys/file.h>: the same values on Linux and macOS.
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
// open(2)'s O_CLOEXEC, which node:fs does not export.
const O_CLOEXEC = process.platform === 'darwin' ? 0x0100_0000 : 0o200_0000;

/** How the owner stops Olympus, named in every refusal. */
export const STOP_OLYMPUS_HINT = 'olympus engine stop, or olympus worker stop if it runs as a worker service, or stop the OpenClaw Gateway that hosts it';

/** How long a starting worker waits for a stopping one to let go (restarts overlap). */
export const WORKER_OWNER_LOCK_WAIT_MS = 10_000;

export class DataOwnerBusyError extends Error {
  readonly code = 'data_owner_busy';
  readonly root: string;
  readonly retryable = true;

  constructor(root: string) {
    super(`Olympus is running and owns its data at ${root}. Stop it first (${STOP_OLYMPUS_HINT}), then try again.`);
    this.name = 'DataOwnerBusyError';
    this.root = root;
  }
}

export interface HeldDataOwnerLock {
  /** The data root this lock owns. */
  readonly root: string;
  /** The lock file: never remove or replace it while it is held. */
  readonly lockPath: string;
  release(): void;
}

export interface DataOwnerLockOptions {
  /** How long to wait for the current owner to let go. Default: do not wait. */
  waitMs?: number;
}

/** The lock file itself, `<data>/data-owner.lock`. */
export function dataOwnerLockPath(env: LayoutEnv = process.env): string {
  return sharedDataPath('data-owner-lock', env);
}

/** Whether `name` (a file name, not a path) is the owner lock. */
export function isDataOwnerLockName(name: string): boolean {
  return name === OWNER_LOCK_NAME;
}

/** Take the lock and hold it until `release()` or the process dies. Throws `DataOwnerBusyError`. */
export function holdDataOwnerLock(env: LayoutEnv = process.env, options: DataOwnerLockOptions = {}): HeldDataOwnerLock {
  const lockPath = dataOwnerLockPath(env);
  const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
  if (!existsSync(dirname(lockPath))) mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  while (true) {
    const fd = tryFlock(lockPath);
    if (fd !== undefined) {
      let held = true;
      return {
        root: olympusDataRoot(env),
        lockPath,
        release() {
          if (!held) return;
          held = false;
          flockLibrary().flock(fd, LOCK_UN);
          closeSync(fd);
        },
      };
    }
    if (Date.now() >= deadline) throw new DataOwnerBusyError(olympusDataRoot(env));
    sleepSync(25);
  }
}

/**
 * One attempt: the descriptor holding the lock, or undefined when another
 * holder has it. Only EWOULDBLOCK means busy; any other failure (ENOLCK, a
 * filesystem without locks) throws, so it is never mistaken for a running
 * Olympus and never passed over as a free one.
 */
function tryFlock(lockPath: string): number | undefined {
  const fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | O_CLOEXEC, 0o600);
  let failure: number;
  try {
    const kernel = flockLibrary();
    do {
      if (kernel.flock(fd, LOCK_EX | LOCK_NB) === 0) return fd;
      failure = kernel.errno();
    } while (failure === osConstants.errno.EINTR);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  // Closing this descriptor leaves the holder's lock alone: flock is per descriptor.
  closeSync(fd);
  if (failure === osConstants.errno.EWOULDBLOCK || failure === osConstants.errno.EAGAIN) return undefined;
  throw new Error(`The lock ${lockPath} could not be taken (flock errno ${failure}).`);
}

interface FlockLibrary {
  flock(fd: number, operation: number): number;
  /** errno of the last failed call on this thread. */
  errno(): number;
}

let library: FlockLibrary | undefined;

function flockLibrary(): FlockLibrary {
  if (library) return library;
  const { dlopen, FFIType, read } = runtimeRequire('bun:ffi') as typeof import('bun:ffi');
  const darwin = process.platform === 'darwin';
  // By soname on Linux, so the loader picks this architecture's libc.
  const errnoName = darwin ? '__error' : '__errno_location';
  const symbols = dlopen(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoName]: { args: [], returns: FFIType.ptr },
  }).symbols as unknown as Record<string, (...args: number[]) => number>;
  const errnoLocation = symbols[errnoName]!;
  library = {
    flock: (fd, operation) => symbols.flock!(fd, operation),
    errno: () => read.i32(errnoLocation() as never, 0),
  };
  return library;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A `flock(2)` exclusive lock on a file other than the owner lock, taken the
 * same way: a capture helper's lock (Telegram's `gateway.lock`, WhatsApp's
 * `bridge.lock`), which the boot migration holds while it moves the folder the
 * lock sits in, and which a spawner hands to the helper it starts.
 */
export interface HeldFileFlock {
  /** The descriptor that holds the lock (close-on-exec: a child gets it only when it is passed on). */
  readonly fd: number;
  /** Let go of the lock and close the descriptor. */
  release(): void;
  /**
   * Close this descriptor and keep the lock: for a spawner that passed it to a
   * child, which now holds the lock alone, until it exits. (`LOCK_UN` would
   * release it for the child too: they share one open file.)
   */
  handOff(): void;
}

/** The lock on `path` (made if it is not there, mode 0600), or `undefined` when another holder has it. Other failures throw. */
export function tryHoldFileFlock(path: string): HeldFileFlock | undefined {
  const fd = tryFlock(path);
  if (fd === undefined) return undefined;
  let open = true;
  return {
    fd,
    release() {
      if (!open) return;
      open = false;
      flockLibrary().flock(fd, LOCK_UN);
      closeSync(fd);
    },
    handOff() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

/** The lock, or `undefined` when its owner is running. Other failures throw. */
export function tryDataOwnerLock(env: LayoutEnv = process.env): HeldDataOwnerLock | undefined {
  try {
    return holdDataOwnerLock(env);
  } catch (error) {
    if (error instanceof DataOwnerBusyError) return undefined;
    throw error;
  }
}

/**
 * Hold the lock around `run` and release it after, however `run` ends. `run`
 * may return a promise: the lock is held until it settles. Throws
 * `DataOwnerBusyError` without running anything when the owner is running.
 */
export function withDataOwnerLock<T>(env: LayoutEnv, run: () => T, options: DataOwnerLockOptions = {}): T {
  const lock = holdDataOwnerLock(env, options);
  let result: T;
  try {
    result = run();
  } catch (error) {
    lock.release();
    throw error;
  }
  if (isPromiseLike(result)) return Promise.resolve(result).finally(() => lock.release()) as T;
  lock.release();
  return result;
}

/**
 * An operator script's entry: run `main` under the lock; when the owner is
 * running print the refusal and exit non-zero without running it.
 */
export async function runUnderDataOwnerLock(main: () => unknown, env: LayoutEnv = process.env): Promise<void> {
  try {
    await withDataOwnerLock(env, main);
  } catch (error) {
    if (!(error instanceof DataOwnerBusyError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

/**
 * The worker's boot step: take the lock before anything mounts or opens a
 * store. A worker that finds another Olympus holding it waits a bounded time
 * (restarts overlap), then reports one line and exits non-zero. The caller
 * keeps the returned lock referenced and never releases it: the kernel does
 * when the process exits.
 */
export function takeWorkerDataOwnerLock(
  env: LayoutEnv = process.env,
  options: { waitMs?: number; exit?: (code: number) => never; report?: (line: string) => void } = {},
): HeldDataOwnerLock {
  try {
    return holdDataOwnerLock(env, { waitMs: options.waitMs ?? WORKER_OWNER_LOCK_WAIT_MS });
  } catch (error) {
    if (!(error instanceof DataOwnerBusyError)) throw error;
    (options.report ?? console.error)(
      `Another Olympus already owns its data at ${error.root}, so this worker is exiting. Stop the running one first (${STOP_OLYMPUS_HINT}).`,
    );
    return (options.exit ?? ((code: number) => process.exit(code)))(1);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}
