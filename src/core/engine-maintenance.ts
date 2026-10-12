import {
  FileLeaseBusyError,
  withFileLease,
  withFileLeaseSync,
  type FileLeaseOptions,
} from './file-lease.ts';

/** Fixed, content-free refusal exposed to lifecycle and consult surfaces. */
export const ENGINE_MAINTENANCE_IN_PROGRESS_MESSAGE =
  'Olympus engine maintenance is in progress; try again after it finishes.';

export class EngineMaintenanceInProgressError extends Error {
  readonly code = 'engine_maintenance_in_progress';

  constructor() {
    super(ENGINE_MAINTENANCE_IN_PROGRESS_MESSAGE);
  }
}

export interface EngineMaintenanceFence {
  /**
   * True while consult preparation or its session owns admission, including
   * the opening interval before a durable running record exists. Call only
   * while this maintenance fence is held: that ordering prevents new work
   * from appearing after a clear result.
   */
  consultInFlight(): boolean;
}

const PROBE_OPTIONS: FileLeaseOptions = {
  acquireTimeoutMs: 1,
  pollIntervalMs: 1,
  staleAfterMs: Number.MAX_SAFE_INTEGER,
};

// A synchronous lifecycle callback cannot heartbeat. Live process identity is
// the stale-owner test; the effectively unbounded age prevents a long drain or
// upgrade from losing its fence merely because 30 seconds elapsed.
const MAINTENANCE_OPTIONS: FileLeaseOptions = {
  staleAfterMs: Number.MAX_SAFE_INTEGER,
};

function maintenanceTarget(statePath: string): string {
  return `${statePath}.maintenance`;
}

function admissionTarget(statePath: string): string {
  // Keep the existing zkAPI cross-process lease target. This is both the
  // one-consult-at-a-time lock and the maintenance admission record.
  return `${statePath}.session`;
}

function workerAdmissionTarget(statePath: string): string {
  return `${statePath}.worker`;
}

function leaseIsHeldSync(targetPath: string): boolean {
  try {
    withFileLeaseSync(targetPath, () => undefined, PROBE_OPTIONS);
    return false;
  } catch (error) {
    if (error instanceof FileLeaseBusyError) return true;
    throw error;
  }
}

function fenceFor(statePath: string): EngineMaintenanceFence {
  return {
    consultInFlight: () => (
      leaseIsHeldSync(workerAdmissionTarget(statePath))
      || leaseIsHeldSync(admissionTarget(statePath))
    ),
  };
}

async function assertMaintenanceClear(statePath: string): Promise<void> {
  try {
    await withFileLease(maintenanceTarget(statePath), async () => undefined, {
      ...MAINTENANCE_OPTIONS,
      ...PROBE_OPTIONS,
    });
  } catch (error) {
    if (error instanceof FileLeaseBusyError) throw new EngineMaintenanceInProgressError();
    throw error;
  }
}

function admissionOptions(options: FileLeaseOptions): FileLeaseOptions {
  return {
    ...options,
    // Admission ownership is process-instance based. A live but paused
    // process must not lose its work merely because its event loop could not
    // heartbeat for 30 seconds.
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Hold maintenance admission for one synchronous lifecycle transaction.
 * Acquisition happens before the callback's first in-flight check. While the
 * callback runs, new consult admissions are refused. Throwing (including a
 * drain timeout) releases the fence and leaves service mutation to the caller.
 */
export function withEngineMaintenanceFenceSync<T>(
  statePath: string,
  callback: (fence: EngineMaintenanceFence) => T,
): T {
  return withFileLeaseSync(maintenanceTarget(statePath), () => callback(fenceFor(statePath)), MAINTENANCE_OPTIONS);
}

/** Async lifecycle counterpart, for rollback/health transactions that await. */
export async function withEngineMaintenanceFence<T>(
  statePath: string,
  callback: (fence: EngineMaintenanceFence) => Promise<T>,
): Promise<T> {
  return withFileLease(maintenanceTarget(statePath), () => callback(fenceFor(statePath)), MAINTENANCE_OPTIONS);
}

/**
 * Admit the worker-side preparation that precedes opening a consult session.
 * The worker admission remains held through its nested consult session so a
 * lifecycle drain covers both the writer/preflight phase and settlement.
 */
export async function withEngineWorkerAdmission<T>(
  statePath: string,
  callback: () => Promise<T>,
  options: FileLeaseOptions = {},
): Promise<T> {
  return withFileLease(workerAdmissionTarget(statePath), async () => {
    await assertMaintenanceClear(statePath);
    return callback();
  }, admissionOptions(options));
}

/**
 * Admit one consult atomically against lifecycle maintenance. The consult
 * lease is acquired first and held through settlement/teardown; only then is
 * the maintenance fence probed. Therefore either maintenance sees this
 * admission in flight, or this admission sees maintenance and refuses.
 */
export async function withEngineConsultAdmission<T>(
  statePath: string,
  callback: () => Promise<T>,
  options: FileLeaseOptions = {},
): Promise<T> {
  return withFileLease(admissionTarget(statePath), async () => {
    await assertMaintenanceClear(statePath);
    return callback();
  }, admissionOptions(options));
}
