/**
 * The data owner lock: one process at a time owns Olympus's data root
 * (docs/design/source-storage.md, "Owner lock").
 *
 * The worker holds it for its whole life. Anything else that opens a store
 * (an operator script, a CLI command while the worker is stopped) holds it
 * for its run, so it refuses with a clear message while Olympus runs and the
 * worker cannot start under it.
 *
 * It is the file-lease kernel lock (`file-lease.ts`) on `<data>/data-owner`,
 * whose lock database is `<data>/data-owner.lock.db`. The lock sits in the data
 * root itself, so two processes that resolve the same data root contend on it
 * whatever their state or config folders are. Nothing may remove it while a
 * process holds it, and no code in a process that holds it may open that file
 * apart from the lease: closing any descriptor a process has on a file drops
 * all of that process's POSIX locks on it. Walkers of the data root skip it
 * with `isDataOwnerLockName`.
 *
 * Deliberately light (layout and file-lease only): the CLI, the scripts and
 * the file-scope decider import it.
 */
import { FileLeaseBusyError, holdFileLeaseSync, isFileLeaseSidecarName, type HeldFileLease } from './file-lease.ts';
import { olympusDataRoot, olympusDataPath, type LayoutEnv } from './olympus-layout.ts';

/** The lease target, relative to the data root; the lease appends `.lock.db`. */
const OWNER_LOCK_TARGET = 'data-owner';

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
  /** The lock database: never open it, copy it or remove it while it is held. */
  readonly lockPath: string;
  release(): void;
}

export interface DataOwnerLockOptions {
  /** How long to wait for the current owner to let go. Default: do not wait. */
  waitMs?: number;
}

/** The lease target for the data root `env` resolves. */
export function dataOwnerLockTarget(env: LayoutEnv = process.env): string {
  return olympusDataPath(env, OWNER_LOCK_TARGET);
}

/** The lock file itself, `<data>/data-owner.lock.db`. */
export function dataOwnerLockPath(env: LayoutEnv = process.env): string {
  return `${dataOwnerLockTarget(env)}.lock.db`;
}

/**
 * Whether `name` (a file name, not a path) is the owner lock or one of the
 * journal files SQLite keeps beside it. Walkers of the data root skip these.
 */
export function isDataOwnerLockName(name: string): boolean {
  return isFileLeaseSidecarName(OWNER_LOCK_TARGET, name);
}

/** Take the lock and hold it until `release()` or the process dies. Throws `DataOwnerBusyError`. */
export function holdDataOwnerLock(env: LayoutEnv = process.env, options: DataOwnerLockOptions = {}): HeldDataOwnerLock {
  const waitMs = Math.max(0, options.waitMs ?? 0);
  let lease: HeldFileLease;
  try {
    lease = holdFileLeaseSync(dataOwnerLockTarget(env), {
      acquireTimeoutMs: Math.max(1, waitMs),
      pollIntervalMs: Math.min(25, Math.max(1, waitMs)),
    });
  } catch (error) {
    if (error instanceof FileLeaseBusyError) throw new DataOwnerBusyError(olympusDataRoot(env));
    throw error;
  }
  return { root: olympusDataRoot(env), lockPath: lease.lockPath, release: () => lease.release() };
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
 * INTERIM, until the CLI goes through the worker's API (step 2b-ii of
 * docs/design/source-storage.md): a CLI command that opens stores holds the
 * lock for its run when it is free, so the worker cannot start under it. When
 * the worker owns the lock (it runs), the command runs exactly as it did
 * before this lock existed. This is the one place the CLI decides that.
 */
export async function withDataOwnerLockIfFree<T>(run: () => T | Promise<T>, env: LayoutEnv = process.env): Promise<T> {
  const lock = tryDataOwnerLock(env);
  try {
    return await run();
  } finally {
    lock?.release();
  }
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
