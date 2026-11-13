import { readWorkerCliLauncher, restoreWorkerCliLauncher } from './worker-cli-launcher.ts';
import { validateWorkerSocket } from './worker-transport.ts';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  assertManagedPathParentsSync,
  ensurePrivateDirectoryTreeSync,
  ensurePrivateRootDirectorySync,
  removeFileDurablySync,
  writePrivateFileAtomicSync,
} from './atomic-file.ts';
import { bootProgressLine, readBootProgress, readFrontProgress, removeSchemaBackupsSince, restoreSchemaBackupsSince, type BootProgress } from './boot-progress.ts';
import { engineHeartbeatBeating, engineHeartbeatLine, readEngineHeartbeat, startupCapMs, type EngineHeartbeat } from './engine-heartbeat.ts';
import { copyStoresBeforeUpgrade, olympusStoreBytes } from './upgrade-store-copies.ts';
import { prepareWorkerUpgradeArtifact, type PreparedWorkerUpgradeArtifact } from './lifecycle-artifact.ts';
import { acquireLifecycleMutationLock } from './lifecycle-lock.ts';
import { OperationError } from './operation-error.ts';
import { V0_4_PUBLIC_SOURCE_CAPABILITIES } from './public-source-capabilities.ts';
import { unquoteEnvValue } from './worker-auth.ts';
import {
  inspectWorkerService,
  installWorkerService,
  pathIsWithin,
  reloadLinuxWorkerServiceManager,
  resetFailedLinuxWorkerService,
  runWorkerServiceAction,
  workerServiceFailureLogLine,
  workerServicePaths,
  type WorkerServiceExec,
  type WorkerServiceInstallOptions,
  type WorkerServiceInstallResult,
  type WorkerServiceInspection,
  type WorkerServicePlatform,
  type WorkerServiceState,
} from './worker-service.ts';

export const OLYMPUS_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export type WorkerLifecycleAction =
  | 'install'
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'foreground'
  | 'upgrade'
  | 'uninstall';

export type LifecycleRecoveryKind =
  | 'setup_interrupted'
  | 'oauth_pending'
  | 'pairing_pending'
  | 'capture_interrupted'
  | 'partial_sync'
  | 'missing_dependency'
  | 'upgrade_interrupted'
  | 'rollback_required';

export interface LifecycleRecoverySignal {
  kind: LifecycleRecoveryKind;
  source_id?: string;
  dependency_id?: string;
}

export interface LifecycleRecoveryAction {
  kind: LifecycleRecoveryKind;
  source_id?: string;
  next_action: string;
  restart_required: false;
}

export interface WorkerLifecycleOptions extends WorkerServiceInstallOptions {
  exec?: WorkerServiceExec;
  now?: () => Date;
  recoverySignals?: readonly LifecycleRecoverySignal[];
  artifactPath?: string;
  activationSettleMs?: number;
  readinessProbe?: (url: string) => boolean;
  /**
   * How long `start`/`restart`/`stop` may wait for the service manager to
   * report the state it was asked for, in milliseconds. Defaults to 15000.
   */
  actionSettleTimeoutMs?: number;
  /** Gap between state polls inside that window, in milliseconds. Defaults to 500. */
  actionSettlePollMs?: number;
  /**
   * How long an upgraded worker may take to answer `/v1/health` while its unit
   * stays active, in milliseconds. Defaults to `actionSettleTimeoutMs` when that
   * is set, otherwise 180000.
   */
  readinessTimeoutMs?: number;
  /** The worker's boot progress (core/boot-progress.ts), for the progress line's counts. Defaults to its file. */
  bootProgress?: () => BootProgress | undefined;
  /** The split front's start (core/boot-progress.ts, #1563): how often it stopped on an error. Defaults to its file. */
  frontProgress?: () => BootProgress | undefined;
  /**
   * The health probe for the previous worker a failed upgrade puts back.
   * Defaults to `readinessProbe`, then the loopback probe.
   */
  rollbackReadinessProbe?: (url: string) => boolean;
  /**
   * How long the previous worker may take to answer after a rollback, in
   * milliseconds. Taken only when it was running before the upgrade (one
   * that was stopped is put back stopped). Defaults to
   * `actionSettleTimeoutMs`, then 600000, whatever `readinessTimeoutMs` is:
   * a previous version writes no boot progress, so its whole start has to
   * fit in this one window.
   */
  rollbackReadinessTimeoutMs?: number;
  /** The readiness waits' monotonic clock, in ms (tests). */
  readinessClock?: () => number;
  /** Where progress lines go while the upgrade waits. Defaults to stderr. */
  progressLine?: (line: string) => void;
  /**
   * The engine's heartbeat (core/engine-heartbeat.ts), written by a thread
   * its busy loop cannot hold. While it beats the wait goes on, up to the
   * cap. Defaults to the heartbeat file.
   */
  heartbeat?: () => EngineHeartbeat | undefined;
  /**
   * The longest an upgrade waits on a new version whose heartbeat beats, in
   * milliseconds. Defaults to 30 minutes plus a minute per GB of stores.
   */
  readinessCapMs?: number;
  /** Whether the upgrade copies the stores before the new version starts. Defaults to true. */
  copyStores?: boolean;
}

interface LifecycleTransactionV1 {
  schema_version: 1;
  action: 'install' | 'upgrade';
  phase: 'snapshotting' | 'prepared' | 'activating' | 'qualifying' | 'rollback_required' | 'commit_ready';
  started_at: string;
  platform: WorkerServicePlatform;
  unit_path: string;
  env_path: string;
  previous_unit_present: boolean;
  previous_env_present: boolean;
  previous_service_state: WorkerServiceState;
  previous_unit_sha256?: string;
  previous_env_sha256?: string;
  /** Optional for recovery of transactions written before CLI launchers existed. */
  previous_launcher_present?: boolean;
  previous_launcher_sha256?: string;
  desired_unit_sha256: string;
  artifact_sha256?: string;
  package_version?: string;
  desired_working_directory?: string;
}

export interface WorkerLifecycleStatus {
  schema_version: 1;
  action: 'status';
  ok: boolean;
  service: WorkerServiceInspection;
  lifecycle_transaction: {
    state: 'none' | 'interrupted';
    action?: 'install' | 'upgrade';
    phase?: LifecycleTransactionV1['phase'];
    next_action?: string;
  };
  recovery: LifecycleRecoveryAction[];
  source_conditioned_dependencies: Array<{
    source_id: string;
    dependencies: Array<{ id: string; label: string }>;
  }>;
}

export type WorkerLifecycleResult =
  | WorkerLifecycleStatus
  | {
      schema_version: 1;
      action: Exclude<WorkerLifecycleAction, 'status'>;
      ok: true;
      platform: WorkerServicePlatform;
      changed: boolean;
      recovered_interrupted_transaction: boolean;
      service?: WorkerServiceInspection;
      install?: ReturnType<typeof installWorkerService>;
      service_action?: ReturnType<typeof runWorkerServiceAction>;
      post_install_restart?: ReturnType<typeof runWorkerServiceAction>;
      foreground?: { mode: 'current_process'; next: 'start_worker_server' };
      retained?: string[];
      upgrade?: { artifact_sha256: string; package_version: string };
      readiness?: { status: 'ready'; url: string };
    };

export function runWorkerLifecycle(
  action: WorkerLifecycleAction,
  options: WorkerLifecycleOptions = {},
): WorkerLifecycleResult {
  const platform = normalizeLifecyclePlatform(options.platform ?? osPlatform());
  const homeDir = validateHomeDir(options.homeDir ?? homedir());
  const normalized = { ...options, platform, homeDir };

  if (action === 'status') return lifecycleStatus(normalized);
  if (action === 'foreground') {
    return {
      schema_version: OLYMPUS_LIFECYCLE_SCHEMA_VERSION,
      action,
      ok: true,
      platform,
      changed: false,
      recovered_interrupted_transaction: false,
      foreground: { mode: 'current_process', next: 'start_worker_server' },
    };
  }
  const mutate = (): WorkerLifecycleResult => {
    if (action === 'install' || action === 'upgrade') return installOrUpgradeLifecycle(action, normalized);
    if (action === 'uninstall') return uninstallLifecycle(normalized);

    refuseInterruptedTransaction(normalized);
    const serviceAction = runWorkerServiceAction(action, serviceActionOptions(normalized));
    const expected = action === 'stop' ? ['inactive', 'missing'] : ['active'];
    const service = settleWorkerServiceState(normalized, expected);
    if (!expected.includes(service.state)) {
      throw lifecycleActionFailure(action, service.state, normalized);
    }
    return {
      schema_version: OLYMPUS_LIFECYCLE_SCHEMA_VERSION,
      action,
      ok: true,
      platform,
      changed: true,
      recovered_interrupted_transaction: false,
      service_action: serviceAction,
      service,
    };
  };
  if (options.dryRun === true) return mutate();
  if (action === 'install') ensurePrivateRootDirectorySync(homeDir);
  const lock = acquireLifecycleMutationLock(homeDir, action, options.now);
  try {
    return mutate();
  } finally {
    lock.release();
  }
}

export function lifecycleRecoveryPlan(
  signals: readonly LifecycleRecoverySignal[],
): LifecycleRecoveryAction[] {
  return signals.map((signal) => {
    const source = signal.source_id ? ` for ${signal.source_id}` : '';
    const dependency = signal.dependency_id ? ` (${signal.dependency_id})` : '';
    const nextAction: Record<LifecycleRecoveryKind, string> = {
      setup_interrupted: 'Rerun olympus worker install; the lifecycle transaction will recover before retrying.',
      oauth_pending: `Resume the OAuth flow${source} from the dashboard; a worker restart is not required.`,
      pairing_pending: `Resume pairing${source} from the dashboard; a worker restart is not required.`,
      capture_interrupted: `Repair or resume capture${source}; use the source card action rather than restarting the worker.`,
      partial_sync: `Use Sync now${source} or let the scheduler resume from its checkpoint.`,
      missing_dependency: `Install the declared dependency${dependency}${source}, then retry that source action.`,
      upgrade_interrupted: 'Rerun olympus worker upgrade; it restores the prior managed files before retrying.',
      rollback_required: 'Rerun olympus worker upgrade to finish rollback recovery before another lifecycle action.',
    };
    return {
      kind: signal.kind,
      ...(signal.source_id ? { source_id: signal.source_id } : {}),
      next_action: nextAction[signal.kind],
      restart_required: false,
    };
  });
}

function lifecycleStatus(options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string }): WorkerLifecycleStatus {
  const service = inspectWorkerService(serviceActionOptions(options));
  const transaction = readTransaction(options);
  const transactionSignal: LifecycleRecoverySignal[] = transaction
    ? [{ kind: transaction.phase === 'rollback_required' ? 'rollback_required' : transaction.action === 'upgrade' ? 'upgrade_interrupted' : 'setup_interrupted' }]
    : [];
  return {
    schema_version: OLYMPUS_LIFECYCLE_SCHEMA_VERSION,
    action: 'status',
    ok: ['active', 'inactive', 'missing'].includes(service.state),
    service,
    lifecycle_transaction: transaction
      ? {
          state: 'interrupted',
          action: transaction.action,
          phase: transaction.phase,
          next_action: transaction.action === 'upgrade'
            ? 'Rerun olympus worker upgrade.'
            : 'Rerun olympus worker install.',
        }
      : { state: 'none' },
    recovery: lifecycleRecoveryPlan([...transactionSignal, ...(options.recoverySignals ?? [])]),
    source_conditioned_dependencies: V0_4_PUBLIC_SOURCE_CAPABILITIES.map((source) => ({
      source_id: source.source_id,
      dependencies: source.dependencies.map((dependency) => ({ id: dependency.id, label: dependency.label })),
    })),
  };
}

function installOrUpgradeLifecycle(
  action: 'install' | 'upgrade',
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
): WorkerLifecycleResult {
  if (options.dryRun === true) {
    const prepared = action === 'upgrade' ? prepareUpgradeArtifact(options, true) : undefined;
    const effective = withPreparedUpgrade(options, prepared);
    const preview = installWorkerService(serviceInstallOptions(effective, true));
    return {
      schema_version: OLYMPUS_LIFECYCLE_SCHEMA_VERSION,
      action,
      ok: true,
      platform: options.platform,
      changed: false,
      recovered_interrupted_transaction: false,
      install: preview,
      ...(prepared ? { upgrade: upgradeReceipt(prepared) } : {}),
    };
  }

  const recovered = recoverInterruptedTransaction(options);
  const before = inspectWorkerService(serviceActionOptions(options));
  if (before.state === 'unknown') {
    throw new OperationError(
      'config_error',
      `Could not determine the existing Olympus worker state before lifecycle mutation: ${before.detail}.`,
    );
  }
  if (action === 'upgrade' && (!before.unit_present || !before.env_present || before.state === 'missing')) {
    throw new OperationError(
      'config_error',
      'Olympus worker upgrade requires an existing managed installation.',
      'Run olympus worker install first.',
    );
  }
  const prepared = action === 'upgrade' ? prepareUpgradeArtifact(options, false) : undefined;
  const effective = withPreparedUpgrade(options, prepared);
  const preview = installWorkerService(serviceInstallOptions(effective, true));
  // Resolve the readiness port before any managed mutation: an unreadable port
  // is a configuration refusal, not a reason to install the new worker and then
  // roll back one that was never given a chance to answer.
  const readinessPort = action === 'upgrade' ? workerReadinessPort(effective) : undefined;
  const previousUnitBytes = readManagedFileSnapshot(preview.unit_path);
  const previousEnvBytes = readManagedFileSnapshot(preview.env_path);
  beginTransaction(action, effective, preview, before.state, prepared);
  try {
    const install = installWorkerService(serviceInstallOptions(effective, false));
    if (action === 'install' && !install.wrote_unit && !install.wrote_env && before.state === 'active') {
      markTransactionCommitReady(effective);
      clearTransaction(effective);
      return {
        schema_version: OLYMPUS_LIFECYCLE_SCHEMA_VERSION,
        action,
        ok: true,
        platform: options.platform,
        changed: install.wrote_launcher,
        recovered_interrupted_transaction: recovered,
        install,
        service: before,
        ...(prepared ? { upgrade: upgradeReceipt(prepared) } : {}),
      };
    }
    updateTransactionPhase(effective, 'activating');
    // The upgrade copies every store itself, after the previous version has
    // stopped and before the new one starts: a file copy or clone, not a
    // VACUUM INTO in the new engine's boot (upgrade-store-copies.ts).
    const stoppedForCopies = action === 'upgrade' && (before.state === 'active' || before.state === 'transitioning');
    if (action === 'upgrade') copyStoresForUpgrade(effective, stoppedForCopies);
    const serviceAction = runWorkerServiceAction('install', serviceActionOptions(effective));
    const managedBytesChanged = previousUnitBytes !== readManagedFileSnapshot(preview.unit_path)
      || previousEnvBytes !== readManagedFileSnapshot(preview.env_path);
    // Stopped for the copies, the install started the new version already.
    const postInstallRestart = effective.platform === 'linux' && !stoppedForCopies
      && (before.state === 'active' || before.state === 'transitioning')
      && (action === 'upgrade' || managedBytesChanged)
      ? runWorkerServiceAction('restart', serviceActionOptions(effective))
      : undefined;
    updateTransactionPhase(effective, 'qualifying');
    // launchctl bootstrap and systemctl enable --now acknowledge submission,
    // not readiness. In particular, launchd can report a freshly bootstrapped
    // job as `waiting` for several reads before the process reaches `running`.
    // The action facade already uses this bounded settle for start/restart;
    // install and upgrade need the same boundary before deciding to roll back.
    const firstService = settleWorkerServiceState(effective, ['active']);
    if (firstService.state !== 'active') {
      throw activationFailure(
        `Lifecycle activation reported success but worker status is ${firstService.state}.`,
        effective,
      );
    }
    waitForActivationSettle(effective.activationSettleMs);
    const service = inspectWorkerService(serviceActionOptions(effective));
    if (service.state !== 'active') {
      throw activationFailure(
        `Lifecycle activation did not remain active through qualification (status ${service.state}).`,
        effective,
      );
    }
    const readiness = readinessPort === undefined ? undefined : qualifyWorkerReadiness(effective, readinessPort);
    markTransactionCommitReady(effective);
    // Committed first: a crash from here on never rolls back onto stores whose
    // copies are gone. The stores the new worker updated are kept.
    removeUpgradeBackups(effective);
    clearTransaction(effective);
    return {
      schema_version: OLYMPUS_LIFECYCLE_SCHEMA_VERSION,
      action,
      ok: true,
      platform: options.platform,
      changed: true,
      recovered_interrupted_transaction: recovered,
      install,
      service_action: serviceAction,
      ...(postInstallRestart ? { post_install_restart: postInstallRestart } : {}),
      service,
      ...(prepared ? { upgrade: upgradeReceipt(prepared) } : {}),
      ...(readiness ? { readiness } : {}),
    };
  } catch (error) {
    throw rolledBackUpgradeError(effective, error);
  }
}

/**
 * A failed upgrade ends in a healthy previous version, or says plainly that
 * it does not (#1563). The rollback's own failure never replaces the
 * upgrade's: both are named, since the person needs both to act. When the
 * previous worker is reactivated, it has to answer its health check before
 * the failure is reported as rolled back.
 */
function rolledBackUpgradeError(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
  error: unknown,
): unknown {
  const failure = error instanceof Error ? error.message : String(error);
  let rollback: RollbackResult;
  try {
    rollback = rollbackTransaction(options, { activatePrevious: true, touchServiceManager: true });
  } catch (rollbackError) {
    return new OperationError(
      'config_error',
      `The upgrade failed (${failure}) and putting the previous version back also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)} Olympus may not be running.`,
      'Run `olympus worker status`, and restore from the copy taken before the upgrade if the previous version does not start.',
    );
  }
  const notes: string[] = [];
  if (rollback.restored.length > 0) notes.push(`Stores put back as they were before the update: ${rollback.restored.join(', ')}.`);
  if (rollback.reactivated) {
    const health = previousWorkerHealth(options);
    if (!health.healthy) {
      return new OperationError(
        'config_error',
        `The upgrade failed (${failure}). The previous version was put back, but it ${health.reason}, so Olympus is not running healthily.`,
        [...notes, 'Run `olympus worker status` and read the worker log before retrying the upgrade.'].join(' '),
      );
    }
    notes.push('The previous version is running and answered its health check.');
  }
  if (rollback.leftStopped && error instanceof Error) {
    // Put back as it was, stopped (rc.4's install stopped the worker first):
    // the person reads that it is not running, and what to run (#1563).
    error.message = `${error.message} Olympus is not running: it was stopped before the upgrade, and the previous version was put back stopped. Run \`olympus worker start\` to start it.`;
  }
  if (notes.length > 0 && error instanceof OperationError) {
    const note = notes.join(' ');
    error.suggestion = error.suggestion ? `${error.suggestion} ${note}` : note;
  }
  return error;
}

function previousWorkerHealth(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
): { healthy: true } | { healthy: false; reason: string } {
  let port: number;
  try {
    port = workerReadinessPort(options);
  } catch {
    return { healthy: false, reason: 'has an unreadable port in its environment file' };
  }
  // Not the upgrade's window: the previous version writes no progress, so its
  // whole start has to fit in this one.
  const timeoutMs = options.rollbackReadinessTimeoutMs ?? options.actionSettleTimeoutMs ?? MAX_READINESS_TIMEOUT_MS;
  // launchctl and systemctl acknowledge submission, not a running job: the
  // restored worker gets the same settle the upgrade's own start does.
  const settled = settleWorkerServiceState(options, ['active']);
  if (settled.state !== 'active') return { healthy: false, reason: `stopped (its service is ${settled.state})` };
  const probe = options.rollbackReadinessProbe ?? options.readinessProbe;
  const outcome = waitForWorkerReadiness(options, port, {
    timeoutMs,
    ...(probe ? { probe } : {}),
    // The previous version's start is its own: the files the failed version
    // left say nothing about it, and it writes no heartbeat, so this one
    // window is its whole start.
    heartbeat: () => undefined,
    frontProgress: () => undefined,
    capMs: timeoutMs,
  });
  if (outcome.ready) return { healthy: true };
  const minutes = Math.round(timeoutMs / 60_000);
  return {
    healthy: false,
    reason: outcome.serviceState !== 'active'
      ? `stopped (its service is ${outcome.serviceState})`
      : `did not answer its health check within ${minutes >= 1 ? `${minutes} min` : `${timeoutMs} ms`}${outcome.lastCheck ? ` (last check: ${outcome.lastCheck})` : ''}`,
  };
}

export interface ManagedWorkerFilesResult {
  install: WorkerServiceInstallResult;
  /**
   * What the service manager reported after this lane finished. `undefined`
   * only on a dry run, which touches no service manager at all.
   */
  service?: WorkerServiceInspection;
  activation: 'skipped' | 'started' | 'failed';
  /** Why activation did not take. Present only when `activation` is 'failed'. */
  activation_detail?: string;
}

/**
 * Write the managed worker unit and environment under the same exclusive lock
 * and crash-durable transaction the lifecycle facade uses, and — unless the
 * caller opts out — start the service the way `olympus worker install` does.
 *
 * `olympus setup` mutates exactly the files the facade owns. Doing that outside
 * the lock lets a concurrent install or upgrade interleave with it — and its
 * rollback then discards setup's write — so setup takes this lane instead of
 * calling the installer directly.
 *
 * Writing the unit and stopping used to be the whole lane, which left a fresh
 * `olympus setup` with an inactive worker and sent the operator straight into a
 * status check that could only fail (clean-install rehearsal, 2026-09-05). The
 * activation is the same `install` service action the facade runs, so a later
 * `olympus worker install` writes nothing, sees an already-active service, and
 * stays the idempotent no-op it was.
 */
export function installManagedWorkerFiles(
  options: WorkerLifecycleOptions & { activate?: boolean } = {},
): ManagedWorkerFilesResult {
  const platform = normalizeLifecyclePlatform(options.platform ?? osPlatform());
  const homeDir = validateHomeDir(options.homeDir ?? homedir());
  const effective = { ...options, platform, homeDir };
  const activate = options.activate !== false;
  if (options.dryRun === true) {
    return { install: installWorkerService(serviceInstallOptions(effective, true)), activation: 'skipped' };
  }
  ensurePrivateRootDirectorySync(homeDir);
  const lock = acquireLifecycleMutationLock(homeDir, 'install', options.now);
  try {
    recoverInterruptedTransaction(effective);
    const preview = installWorkerService(serviceInstallOptions(effective, true));
    // The transaction covers the FILE write only, so the previous run state is
    // genuinely undetermined here; recording it as such keeps a later recovery
    // from reactivating a worker on this transaction's authority.
    beginTransaction('install', effective, preview, 'unknown');
    let install: WorkerServiceInstallResult;
    try {
      install = installWorkerService(serviceInstallOptions(effective, false));
      markTransactionCommitReady(effective);
      clearTransaction(effective);
    } catch (error) {
      rollbackTransaction(effective, { activatePrevious: false, touchServiceManager: false });
      throw error;
    }
    if (!activate) return { install, activation: 'skipped' };
    // Activation runs AFTER the file transaction commits, deliberately. The
    // unit and the environment are the durable artifact and must survive a
    // service manager that is absent, refusing, or slow — rolling them back
    // over a failed start would leave setup with nothing at all. A start that
    // does not take is reported, and `olympus worker install` is the retry.
    return activateManagedWorkerFiles(install, effective);
  } finally {
    lock.release();
  }
}

function activateManagedWorkerFiles(
  install: WorkerServiceInstallResult,
  effective: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
): ManagedWorkerFilesResult {
  try {
    // Setup also writes sovereignty.json, which is read only at worker boot.
    // Linux enable --now leaves an active process running with its old policy.
    // Refuse an unknown state rather than assuming no restart is needed.
    const before = effective.platform === 'linux'
      ? inspectWorkerService(serviceActionOptions(effective))
      : undefined;
    if (before?.state === 'unknown') {
      throw new OperationError('config_error', `Could not determine the existing Olympus worker state before setup activation: ${before.detail}.`);
    }
    runWorkerServiceAction('install', serviceActionOptions(effective));
    if (before?.state === 'active' || before?.state === 'transitioning') {
      runWorkerServiceAction('restart', serviceActionOptions(effective));
    }
    const service = settleWorkerServiceState(effective, ['active']);
    if (service.state === 'active') return { install, service, activation: 'started' };
    return {
      install,
      service,
      activation: 'failed',
      activation_detail: lifecycleActionFailure('install', service.state, effective).message,
    };
  } catch (error) {
    const service = inspectWorkerServiceSafely(effective);
    return {
      install,
      ...(service ? { service } : {}),
      activation: 'failed',
      activation_detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function inspectWorkerServiceSafely(
  effective: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
): WorkerServiceInspection | undefined {
  try {
    return inspectWorkerService(serviceActionOptions(effective));
  } catch {
    return undefined;
  }
}

function uninstallLifecycle(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
): WorkerLifecycleResult {
  refuseInterruptedTransaction(options);
  const before = inspectWorkerService(serviceActionOptions(options));
  const serviceAction = runWorkerServiceAction('uninstall', serviceActionOptions(options));
  const service = inspectWorkerService(serviceActionOptions(options));
  if (service.unit_present || service.state === 'active') {
    throw new OperationError('config_error', 'Olympus worker uninstall did not remove and stop the managed service.');
  }
  return {
    schema_version: OLYMPUS_LIFECYCLE_SCHEMA_VERSION,
    action: 'uninstall',
    ok: true,
    platform: options.platform,
    changed: before.unit_present || before.state === 'active',
    recovered_interrupted_transaction: false,
    service_action: serviceAction,
    service,
    retained: ['worker environment and credentials', 'source configuration', 'indexed data'],
  };
}

function beginTransaction(
  action: 'install' | 'upgrade',
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
  preview: ReturnType<typeof installWorkerService>,
  previousServiceState: WorkerServiceState,
  prepared?: PreparedWorkerUpgradeArtifact,
): void {
  const paths = transactionPaths(options.homeDir);
  ensurePrivateDirectoryTreeSync(options.homeDir, paths.dir);
  assertTransactionParentSafety(options.homeDir, paths);
  const previousUnit = readManagedFileSnapshot(preview.unit_path);
  const previousEnv = readManagedFileSnapshot(preview.env_path);
  const previousLauncher = readWorkerCliLauncher(options.homeDir);
  const transaction: LifecycleTransactionV1 = {
    schema_version: OLYMPUS_LIFECYCLE_SCHEMA_VERSION,
    action,
    phase: 'snapshotting',
    started_at: (options.now?.() ?? new Date()).toISOString(),
    platform: options.platform,
    unit_path: preview.unit_path,
    env_path: preview.env_path,
    previous_unit_present: previousUnit !== undefined,
    previous_env_present: previousEnv !== undefined,
    ...(previousLauncher !== null ? { previous_launcher_present: previousLauncher !== undefined } : {}),
    ...(previousLauncher != null ? { previous_launcher_sha256: sha256(previousLauncher) } : {}),
    previous_service_state: previousServiceState,
    ...(previousUnit !== undefined ? { previous_unit_sha256: sha256(previousUnit) } : {}),
    ...(previousEnv !== undefined ? { previous_env_sha256: sha256(previousEnv) } : {}),
    desired_unit_sha256: sha256(preview.unit),
    ...(prepared ? {
      artifact_sha256: prepared.artifactSha256,
      package_version: prepared.packageVersion,
      desired_working_directory: prepared.workingDirectory,
    } : {}),
  };
  writePrivateFileAtomicSync(paths.transaction, `${JSON.stringify(transaction, null, 2)}\n`);
  writeSnapshotBackup(paths.unitBackup, previousUnit);
  writeSnapshotBackup(paths.envBackup, previousEnv);
  writeSnapshotBackup(paths.launcherBackup, previousLauncher ?? undefined);
  updateTransactionPhase(options, 'prepared');
}

function recoverInterruptedTransaction(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
): boolean {
  const transaction = readTransaction(options);
  if (!transaction) return false;
  if (transaction.phase === 'snapshotting' || transaction.phase === 'commit_ready') {
    clearTransaction(options);
    return true;
  }
  rollbackTransaction(options, { activatePrevious: true, touchServiceManager: true });
  return true;
}

interface RollbackResult {
  /** The stores put back from the copies taken before their schema update. */
  restored: string[];
  /** Whether the previous worker was started again. */
  reactivated: boolean;
  /** The previous worker was installed but not running before, so it was put back stopped. */
  leftStopped: boolean;
}

function rollbackTransaction(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
  intent: { activatePrevious: boolean; touchServiceManager: boolean },
): RollbackResult {
  const transaction = readTransaction(options);
  if (!transaction) return { restored: [], reactivated: false, leftStopped: false };
  if (transaction.phase === 'snapshotting' || transaction.phase === 'commit_ready') {
    clearTransaction(options);
    return { restored: [], reactivated: false, leftStopped: false };
  }
  updateTransactionPhase(options, 'rollback_required');
  const paths = transactionPaths(options.homeDir);
  // A file-only transaction never handed the new bytes to the service manager,
  // so restoring them is the whole rollback; nothing needs stopping or
  // reloading, and touching the running worker would be a surprise.
  if (intent.touchServiceManager) quiesceAttemptedWorker(options);
  // The attempted worker is stopped: the stores it updated go back to the
  // copies taken before, so the previous version can open them (#1494).
  const restored = intent.touchServiceManager
    ? restoreSchemaBackupsSince(lifecycleEnv(options), Date.parse(transaction.started_at))
    : [];
  restoreManagedFile(options.homeDir, transaction.unit_path, paths.unitBackup, transaction.previous_unit_present, transaction.previous_unit_sha256);
  restoreManagedFile(options.homeDir, transaction.env_path, paths.envBackup, transaction.previous_env_present, transaction.previous_env_sha256);
  if (transaction.previous_launcher_present !== undefined) {
    let previousLauncher: string | undefined;
    if (transaction.previous_launcher_present) {
      previousLauncher = readManagedFileSnapshot(paths.launcherBackup);
      if (previousLauncher === undefined || sha256(previousLauncher) !== transaction.previous_launcher_sha256) {
        throw new OperationError('config_error', 'Lifecycle CLI launcher rollback backup integrity check failed.');
      }
    }
    restoreWorkerCliLauncher(options.homeDir, previousLauncher);
  }
  const reactivatePrevious = intent.activatePrevious
    && transaction.previous_unit_present
    && transaction.previous_service_state === 'active';
  if (intent.touchServiceManager && options.platform === 'linux' && !reactivatePrevious) {
    try {
      reloadLinuxWorkerServiceManager(options.exec ? { exec: options.exec } : {});
    } catch (error) {
      throw new OperationError(
        'config_error',
        'Olympus lifecycle rollback restored the previous managed files but could not reload the systemd manager.',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (reactivatePrevious) {
    try {
      runWorkerServiceAction('install', serviceActionOptions(options));
      if (options.platform === 'linux') {
        runWorkerServiceAction('restart', serviceActionOptions(options));
      }
    } catch (error) {
      throw new OperationError(
        'config_error',
        'Olympus lifecycle rollback restored the previous managed files but could not reactivate the previous worker.',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  markTransactionCommitReady(options);
  clearTransaction(options);
  return {
    restored,
    reactivated: reactivatePrevious,
    leftStopped: intent.touchServiceManager && !reactivatePrevious && transaction.previous_unit_present,
  };
}

function copyStoresForUpgrade(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
  stopFirst: boolean,
): void {
  if (options.copyStores === false) return;
  if (stopFirst) runWorkerServiceAction('stop', serviceActionOptions(options));
  const progressLine = options.progressLine ?? ((line: string) => process.stderr.write(`${line}\n`));
  const copied = copyStoresBeforeUpgrade(lifecycleEnv(options), {
    ...(options.bunBin ? { bunBin: options.bunBin } : {}),
    log: progressLine,
  });
  if (copied.stores > 0) progressLine(`Copied ${copied.stores} stores in ${Math.round(copied.ms / 1000)} s.`);
}

function removeUpgradeBackups(options: WorkerLifecycleOptions & { homeDir: string }): void {
  const transaction = readTransaction(options);
  if (!transaction) return;
  try {
    removeSchemaBackupsSince(lifecycleEnv(options), Date.parse(transaction.started_at));
  } catch {
    // A copy left behind costs disk, not correctness.
  }
}

/**
 * The environment the worker resolves its data root in: the home's defaults
 * (data-lifecycle.ts `envForContext`), then what the worker's own environment
 * file sets, since the service manager loads it into the worker.
 */
function lifecycleEnv(options: WorkerLifecycleOptions & { homeDir: string }): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = options.homeDir === process.env.HOME ? { ...process.env } : {
    HOME: options.homeDir,
    XDG_DATA_HOME: join(options.homeDir, '.local', 'share'),
    XDG_STATE_HOME: join(options.homeDir, '.local', 'state'),
  };
  const envPath = options.envPath ?? workerServicePaths(options.platform ?? 'linux', options.homeDir).envPath;
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const name of ['HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      const value = new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1];
      if (value !== undefined && unquoteEnvValue(value).trim()) env[name] = unquoteEnvValue(value).trim();
    }
  } catch {
    // No environment file: the home's defaults.
  }
  return env;
}

function quiesceAttemptedWorker(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
): void {
  const attempted = inspectWorkerService(serviceActionOptions(options));
  if (attempted.state === 'unknown') {
    throw new OperationError(
      'config_error',
      'Olympus lifecycle rollback could not determine whether the attempted worker was still running.',
      attempted.detail,
    );
  }
  const darwinAlreadyUnloaded = options.platform === 'darwin'
    && (attempted.exit_code === 3 || attempted.exit_code === 113);
  if (attempted.state === 'missing' || darwinAlreadyUnloaded) return;
  try {
    runWorkerServiceAction('stop', serviceActionOptions(options));
  } catch (error) {
    throw new OperationError(
      'config_error',
      'Olympus lifecycle rollback could not stop the attempted worker before restoring the previous installation.',
      error instanceof Error ? error.message : String(error),
    );
  }
  let stopped = inspectWorkerService(serviceActionOptions(options));
  let resetFailedDetail: string | undefined;
  if (options.platform === 'linux' && (stopped.state === 'failed' || attempted.state === 'transitioning')) {
    // systemd latches a failed result: the stop above succeeded without
    // clearing it, and a rollback that refused here would leave the previous
    // managed files unrestored with every later lifecycle command re-entering
    // the same refusal. reset-failed retires the record so the real state shows.
    try {
      resetFailedLinuxWorkerService(options.exec ? { exec: options.exec } : {});
      stopped = inspectWorkerService(serviceActionOptions(options));
    } catch (error) {
      resetFailedDetail = error instanceof Error ? error.message : String(error);
    }
  }
  if (stopped.state !== 'inactive' && stopped.state !== 'missing') {
    throw new OperationError(
      'config_error',
      `Olympus lifecycle rollback could not prove the attempted worker was stopped (status ${stopped.state}).`,
      resetFailedDetail,
    );
  }
}

function refuseInterruptedTransaction(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
): void {
  const transaction = readTransaction(options);
  if (!transaction) return;
  throw new OperationError(
    'config_error',
    `An interrupted Olympus worker ${transaction.action} must be recovered before this lifecycle action.`,
    transaction.action === 'upgrade' ? 'Rerun olympus worker upgrade.' : 'Rerun olympus worker install.',
  );
}

function updateTransactionPhase(
  options: WorkerLifecycleOptions & { homeDir: string },
  phase: LifecycleTransactionV1['phase'],
): void {
  const transaction = readTransaction(options);
  if (!transaction) throw new OperationError('config_error', 'Lifecycle transaction disappeared during mutation.');
  writePrivateFileAtomicSync(
    transactionPaths(options.homeDir).transaction,
    `${JSON.stringify({ ...transaction, phase }, null, 2)}\n`,
  );
}

function markTransactionCommitReady(options: WorkerLifecycleOptions & { homeDir: string }): void {
  updateTransactionPhase(options, 'commit_ready');
}

function readTransaction(options: { homeDir?: string }): LifecycleTransactionV1 | undefined {
  const homeDir = validateHomeDir(options.homeDir ?? homedir());
  const paths = transactionPaths(homeDir);
  assertTransactionParentSafety(homeDir, paths);
  if (!existsSync(paths.transaction)) return undefined;
  assertRegularFile(paths.transaction, 'lifecycle transaction');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(paths.transaction, 'utf8'));
  } catch {
    throw new OperationError('config_error', 'The Olympus lifecycle transaction is unreadable; refusing to guess recovery state.');
  }
  if (!value || typeof value !== 'object') {
    throw new OperationError('config_error', 'The Olympus lifecycle transaction has an invalid shape.');
  }
  const transaction = value as LifecycleTransactionV1;
  const expectedPlatform = normalizeLifecyclePlatform(transaction.platform);
  const expectedPaths = workerServicePaths(expectedPlatform, homeDir);
  // The unit path is the installation's identity: it is fixed by platform and
  // home, so a mismatch means this record belongs elsewhere. The environment
  // path is not — an install may point the unit at a custom env file — so the
  // record is authoritative about the file it snapshotted and is checked for
  // well-formedness instead of equality with today's default.
  if (
    transaction.schema_version !== OLYMPUS_LIFECYCLE_SCHEMA_VERSION
    || !['install', 'upgrade'].includes(transaction.action)
    || !['snapshotting', 'prepared', 'activating', 'qualifying', 'rollback_required', 'commit_ready'].includes(transaction.phase)
    || transaction.unit_path !== expectedPaths.unitPath
    || !isRecordedManagedPath(transaction.env_path)
    || (transaction.previous_launcher_present !== undefined && typeof transaction.previous_launcher_present !== 'boolean')
    || (transaction.previous_launcher_present === true && !/^[0-9a-f]{64}$/.test(transaction.previous_launcher_sha256 ?? ''))
  ) {
    throw new OperationError('config_error', 'The Olympus lifecycle transaction does not match this installation; refusing recovery.');
  }
  if (transaction.action === 'upgrade') {
    const expectedVersionsDir = join(homeDir, '.local', 'share', 'olympus', 'versions');
    if (
      typeof transaction.artifact_sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(transaction.artifact_sha256)
      || typeof transaction.package_version !== 'string'
      || typeof transaction.desired_working_directory !== 'string'
      || transaction.desired_working_directory !== join(expectedVersionsDir, transaction.artifact_sha256)
    ) {
      throw new OperationError('config_error', 'The Olympus upgrade transaction is not bound to valid managed artifact bytes.');
    }
  }
  return transaction;
}

function clearTransaction(options: { homeDir?: string }): void {
  const paths = transactionPaths(validateHomeDir(options.homeDir ?? homedir()));
  assertTransactionParentSafety(validateHomeDir(options.homeDir ?? homedir()), paths);
  for (const path of [paths.unitBackup, paths.envBackup, paths.launcherBackup, paths.transaction]) {
    if (!existsSync(path)) continue;
    assertRegularFile(path, 'lifecycle transaction artifact');
    removeFileDurablySync(path);
  }
}

function readManagedFileSnapshot(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  assertRegularFile(path, 'managed lifecycle file');
  return readFileSync(path, 'utf8');
}

function writeSnapshotBackup(path: string, text: string | undefined): void {
  if (text === undefined) {
    if (existsSync(path)) {
      assertRegularFile(path, 'lifecycle backup');
      removeFileDurablySync(path);
    }
    return;
  }
  writePrivateFileAtomicSync(path, text);
}

function restoreManagedFile(
  homeDir: string,
  path: string,
  backupPath: string,
  previousPresent: boolean,
  expectedDigest?: string,
): void {
  if (!previousPresent) {
    if (existsSync(path)) {
      assertRegularFile(path, 'managed lifecycle file');
      removeFileDurablySync(path);
    }
    return;
  }
  assertRegularFile(backupPath, 'lifecycle backup');
  const text = readFileSync(backupPath, 'utf8');
  if (!expectedDigest || sha256(text) !== expectedDigest) {
    throw new OperationError('config_error', 'Lifecycle rollback backup integrity check failed.');
  }
  // Mirror installWorkerService: custody-managed parents inside the home root,
  // ordinary directory creation for a file the operator placed outside it.
  if (pathIsWithin(homeDir, path)) ensurePrivateDirectoryTreeSync(homeDir, dirname(path));
  else mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, text);
}

function isRecordedManagedPath(value: unknown): boolean {
  return typeof value === 'string'
    && value.trim() !== ''
    && isAbsolute(value)
    && !/[\0\r\n]/.test(value);
}

function transactionPaths(homeDir: string): {
  dir: string;
  transaction: string;
  unitBackup: string;
  envBackup: string;
  launcherBackup: string;
} {
  const dir = join(homeDir, '.local', 'state', 'olympus', 'lifecycle');
  return {
    dir,
    transaction: join(dir, 'transaction-v1.json'),
    unitBackup: join(dir, 'worker-unit.backup'),
    envBackup: join(dir, 'worker-env.backup'),
    launcherBackup: join(dir, 'cli-launcher.backup'),
  };
}

function assertTransactionParentSafety(
  homeDir: string,
  paths: ReturnType<typeof transactionPaths>,
): void {
  try {
    for (const path of [paths.transaction, paths.unitBackup, paths.envBackup, paths.launcherBackup]) {
      assertManagedPathParentsSync(homeDir, path, 'lifecycle transaction');
    }
  } catch (error) {
    throw new OperationError(
      'config_error',
      'Refusing an unsafe Olympus lifecycle transaction parent path.',
      error instanceof Error ? error.message : undefined,
    );
  }
}

function prepareUpgradeArtifact(
  options: WorkerLifecycleOptions & { homeDir: string },
  dryRun: boolean,
): PreparedWorkerUpgradeArtifact {
  if (!options.artifactPath?.trim()) {
    throw new OperationError('invalid_params', 'olympus worker upgrade requires --artifact <path>.');
  }
  const bunBin = options.bunBin ?? (typeof Bun !== 'undefined' ? Bun.which('bun') : null) ?? process.execPath;
  return prepareWorkerUpgradeArtifact({
    artifactPath: options.artifactPath,
    homeDir: options.homeDir,
    bunBin,
    dryRun,
  });
}

function withPreparedUpgrade<T extends WorkerLifecycleOptions & { homeDir: string }>(
  options: T,
  prepared: PreparedWorkerUpgradeArtifact | undefined,
): T {
  return prepared ? { ...options, workingDirectory: prepared.workingDirectory } : options;
}

function upgradeReceipt(prepared: PreparedWorkerUpgradeArtifact): {
  artifact_sha256: string;
  package_version: string;
} {
  return {
    artifact_sha256: prepared.artifactSha256,
    package_version: prepared.packageVersion,
  };
}

function waitForActivationSettle(value: number | undefined): void {
  const delayMs = value ?? 500;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000) {
    throw new OperationError('invalid_params', 'Lifecycle activation settle time must be between 0 and 10000 milliseconds.');
  }
  if (delayMs === 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function qualifyWorkerReadiness(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
  port: number,
): { status: 'ready'; url: string } {
  const timeoutMs = options.readinessTimeoutMs ?? options.actionSettleTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const outcome = waitForWorkerReadiness(options, port, {
    timeoutMs,
    ...(options.readinessProbe ? { probe: options.readinessProbe } : {}),
  });
  if (!outcome.ready) {
    throw new OperationError(
      'config_error',
      `The upgraded Olympus worker did not answer its loopback readiness probe.${readinessFailureDetail(options, outcome)}`,
      'The previous managed worker has been restored; inspect the worker logs before retrying the upgrade.',
    );
  }
  return { status: 'ready', url: outcome.url };
}

/**
 * What happened, when the wait can tell (#1563): the split front stopped on
 * an error N times, or the unit stopped, with its last log line. rc.4's
 * install reported a probe timeout for a front that had crashed seven times.
 */
function readinessFailureDetail(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
  outcome: { serviceState: string; front: BootProgress | undefined; lastCheck?: string; ended?: 'cap' | 'crash_loop'; heartbeat?: EngineHeartbeat },
): string {
  const parts: string[] = [];
  if (outcome.lastCheck) parts.push(` Its last health check: ${outcome.lastCheck}.`);
  const failures = outcome.front?.failures ?? 0;
  if (failures > 0) {
    parts.push(` Its front stopped ${failures} ${failures === 1 ? 'time' : 'times'} while starting${outcome.front?.lastFailure ? ` (${outcome.front.lastFailure})` : ''}.`);
  }
  if (outcome.serviceState !== 'active') {
    parts.push(` Its service stopped (status ${outcome.serviceState}).`);
    const logLine = workerServiceFailureLogLine({ platform: options.platform, homeDir: options.homeDir });
    if (logLine) parts.push(` The worker's last log line was: ${logLine}`);
  } else if (outcome.ended === 'crash_loop' && failures === 0) {
    parts.push(' Its engine kept exiting and being started again.');
  } else if (outcome.ended === 'cap' || failures === 0) {
    parts.push(` It was still running when the wait reached its limit: ${heartbeatState(outcome.heartbeat)}.`);
  }
  return parts.join('');
}

/**
 * More new engine processes than this in one wait is a crash loop: each exit
 * was replaced, and the next one exited too.
 */
const MAX_PROCESS_STARTS = 3;

/**
 * Wait for `/v1/health` while the unit stays active. A slow answer is never
 * read as a dead engine, and neither is a heartbeat that has stopped (a
 * slept laptop, a stalled disk): it is reported, never a reason to roll back.
 * The wait ends on an answer, the unit stopping, a crash loop (more than
 * three engine processes, or a front that stopped three times), or the cap,
 * measured on this process's monotonic clock; at the cap it says what the
 * engine last said it was doing.
 */
function waitForWorkerReadiness(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
  port: number,
  wait: {
    timeoutMs: number;
    probe?: (url: string) => boolean;
    heartbeat?: () => EngineHeartbeat | undefined;
    frontProgress?: () => BootProgress | undefined;
    capMs?: number;
  },
): { ready: boolean; url: string; serviceState: string; front: BootProgress | undefined; lastCheck?: string; ended?: 'cap' | 'crash_loop'; heartbeat?: EngineHeartbeat } {
  const url = `http://127.0.0.1:${port}/v1/health`;
  let lastCheck: string | undefined;
  const probe = () => {
    if (wait.probe) return wait.probe(url);
    lastCheck = workerHealthCheck(url, options.bunBin);
    return lastCheck === undefined;
  };
  const timeoutMs = validateSettleWindow(wait.timeoutMs, 'Lifecycle readiness timeout', MAX_READINESS_TIMEOUT_MS);
  const pollMs = validateSettleWindow(
    options.actionSettlePollMs ?? DEFAULT_ACTION_SETTLE_POLL_MS,
    'Lifecycle readiness poll interval',
    10_000,
  );
  const env = lifecycleEnv(options);
  const waitStartedAt = Date.now();
  const clock = options.readinessClock ?? (() => performance.now());
  const startedTick = clock();
  const capMs = Math.max(timeoutMs, wait.capMs ?? options.readinessCapMs ?? defaultReadinessCapMs(env));
  const readHeartbeat = wait.heartbeat ?? options.heartbeat ?? (() => readEngineHeartbeat(env));
  const readFront = wait.frontProgress ?? options.frontProgress ?? (() => readFrontProgress(env));
  const readBoot = options.bootProgress ?? (() => readBootProgress(env));
  const progressLine = options.progressLine ?? ((line: string) => process.stderr.write(`${line}\n`));
  const processes = new Set<number>();
  let lastLineTick = -Infinity;
  let serviceState = 'active';
  let ended: 'cap' | 'crash_loop' | undefined;
  let heartbeat: EngineHeartbeat | undefined;
  let ready = probe();
  while (!ready) {
    serviceState = inspectWorkerService(serviceActionOptions(options)).state;
    if (serviceState !== 'active') break;
    const tick = clock();
    const read = readHeartbeat();
    if (read) heartbeat = read;
    // Each engine process that lived during this wait; a stale file from one that is gone counts too.
    if (read && Date.parse(read.startedAt) >= waitStartedAt - 60_000) processes.add(read.pid);
    const front = readFront();
    const frontFailures = front && Date.parse(front.updatedAt) >= waitStartedAt ? front.failures ?? 0 : 0;
    if (processes.size > MAX_PROCESS_STARTS || frontFailures >= MAX_PROCESS_STARTS) { ended = 'crash_loop'; break; }
    if (tick - startedTick >= capMs) { ended = 'cap'; break; }
    if (tick - startedTick >= timeoutMs && tick - lastLineTick >= READINESS_PROGRESS_LINE_MS) {
      const boot = readBoot();
      const counts = boot && heartbeat && boot.pid === heartbeat.pid ? `${bootProgressLine(boot)}; ` : '';
      progressLine(`Starting Olympus: ${counts}${heartbeatState(heartbeat)}`);
      lastLineTick = tick;
    }
    waitForActivationSettle(Math.max(1, Math.ceil(Math.min(pollMs, capMs - (tick - startedTick)))));
    ready = probe();
  }
  // Only a front file written during this wait speaks for this start.
  const lastFront = ready ? undefined : readFront();
  const front = lastFront && Date.parse(lastFront.updatedAt) >= waitStartedAt ? lastFront : undefined;
  return {
    ready, url, serviceState: ready ? 'active' : serviceState, front,
    ...(!ready && lastCheck ? { lastCheck } : {}),
    ...(!ready && ended ? { ended } : {}),
    ...(!ready && heartbeat ? { heartbeat } : {}),
  };
}

function defaultReadinessCapMs(env: Record<string, string | undefined>): number {
  let bytes = 0;
  try { bytes = olympusStoreBytes(env); } catch { /* unreadable: the base cap */ }
  return startupCapMs(bytes);
}

/** What the engine last said, or that its heartbeat has stopped, or that there is none. */
function heartbeatState(heartbeat: EngineHeartbeat | undefined): string {
  if (!heartbeat) return 'no heartbeat from the engine yet';
  if (engineHeartbeatBeating(heartbeat)) return engineHeartbeatLine(heartbeat);
  return `its heartbeat was last written at ${heartbeat.writtenAt} (${engineHeartbeatLine(heartbeat)})`;
}

function workerReadinessPort(options: WorkerLifecycleOptions & { homeDir: string }): number {
  if (options.port !== undefined) return validateWorkerReadinessPort(options.port);
  const envPath = options.envPath ?? workerServicePaths(options.platform ?? 'linux', options.homeDir).envPath;
  if (!existsSync(envPath)) return 8010;
  assertRegularFile(envPath, 'worker environment');
  const line = /^OLYMPUS_EMAIL_SOURCE_PORT=(.*)$/m.exec(readFileSync(envPath, 'utf8'))?.[1];
  // Both managed sourcing paths strip surrounding quotes before the worker sees
  // the value, so a quoted port is a healthy configuration and must not read as
  // NaN here.
  const configured = line === undefined ? undefined : unquoteEnvValue(line);
  return configured ? validateWorkerReadinessPort(Number(configured)) : 8010;
}

function validateWorkerReadinessPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new OperationError('config_error', 'The managed worker environment has an invalid readiness port.');
  }
  return value;
}

function defaultWorkerReadinessProbe(url: string, bunBin: string | undefined): boolean {
  return workerHealthCheck(url, bunBin) === undefined;
}

/**
 * One health check of the managed worker, as the upgrade and the rollback
 * run it: undefined when it answered healthy, otherwise why not, in a few
 * words with no response content. rc.4's VM run failed this check against a
 * front that was serving, and "did not answer" said nothing about why.
 */
export function workerHealthCheck(url: string, bunBin: string | undefined): string | undefined {
  const executable = bunBin ?? (typeof Bun !== 'undefined' ? Bun.which('bun') : null) ?? process.execPath;
  if (!executable || !isAbsolute(executable)) return 'no bun executable to run the check';
  let socket: string | undefined;
  try { socket = validateWorkerSocket(); } catch (error) {
    return `the worker socket did not check out (${error instanceof Error ? error.message : 'unreadable'})`;
  }
  const script = [
    "const url = process.argv.at(-1);",
    "const fail = (why) => { process.stdout.write(why); process.exit(1); };",
    "let response;",
    "try {",
    socket
      ? `  response = await fetch(url, { unix: ${JSON.stringify(socket)}, redirect: 'error', signal: AbortSignal.timeout(3000) });`
      : "  response = await fetch(url, { signal: AbortSignal.timeout(3000) });",
    "} catch (error) { fail(error?.name === 'TimeoutError' ? 'no answer within 3 s' : `no connection (${error?.code ?? error?.name ?? 'error'})`); }",
    "if (!response.ok) fail(`status ${response.status}`);",
    "let value;",
    "try { value = await response.json(); } catch { fail('an answer that is not JSON'); }",
    "if (value?.reachable !== true) fail('an answer without reachable: true');",
    // A split engine's front answers on its own: its background must be up too.
    "if (value.engine_background === 'unreachable') fail('the front answered, but its background did not');",
  ].join('\n');
  const result = spawnSync(executable, ['-e', script, url], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  });
  if (result.status === 0) return undefined;
  if (result.error || result.signal) return 'the check itself did not finish within 5 s';
  return result.stdout.trim().slice(0, 160) || `the check exited ${result.status}`;
}

function serviceInstallOptions(options: WorkerLifecycleOptions, dryRun: boolean): WorkerServiceInstallOptions {
  return {
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.olympusBin ? { olympusBin: options.olympusBin } : {}),
    ...(options.bunBin ? { bunBin: options.bunBin } : {}),
    ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
    ...(options.envPath ? { envPath: options.envPath } : {}),
    ...(options.authToken ? { authToken: options.authToken } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.schedulerEnabled !== undefined ? { schedulerEnabled: options.schedulerEnabled } : {}),
    dryRun,
  };
}

const DEFAULT_ACTION_SETTLE_TIMEOUT_MS = 15_000;
const DEFAULT_ACTION_SETTLE_POLL_MS = 500;
/**
 * A worker opening a large archive can take well over the 15 s state window
 * before `/v1/health` answers, and an upgrade that gave up at 15 s rolled a
 * healthy 1.4.0 back onto a build that could not open its newer stores (#1040).
 * The wait only continues while the unit stays active, so a worker that exits
 * on boot still fails at once.
 */
const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
/** While an upgrade waits on boot work, one progress line at most this often. */
const READINESS_PROGRESS_LINE_MS = 30_000;
const MAX_READINESS_TIMEOUT_MS = 600_000;

/**
 * Wait, bounded, for the service manager to report one of `expected`.
 *
 * `launchctl kickstart` returns when the job has been SUBMITTED, not when the
 * worker is serving, so the inspection that used to run on the next line read
 * `inactive` on a service that was seconds from up and refused a start that had
 * in fact succeeded (clean-install rehearsal, 2026-09-05). The same lag runs the
 * other way on stop. Polling costs nothing on the common path — the first read
 * already answers — and the window is bounded so a genuinely dead worker still
 * fails, with its own log line, inside a quarter of a minute.
 */
function settleWorkerServiceState(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
  expected: readonly string[],
): WorkerServiceInspection {
  const timeoutMs = validateSettleWindow(
    options.actionSettleTimeoutMs ?? DEFAULT_ACTION_SETTLE_TIMEOUT_MS,
    'Lifecycle action settle timeout',
    120_000,
  );
  const pollMs = validateSettleWindow(
    options.actionSettlePollMs ?? DEFAULT_ACTION_SETTLE_POLL_MS,
    'Lifecycle action settle poll interval',
    10_000,
  );
  const deadline = Date.now() + timeoutMs;
  let service = inspectWorkerService(serviceActionOptions(options));
  while (!expected.includes(service.state) && Date.now() < deadline) {
    waitForActivationSettle(pollMs);
    service = inspectWorkerService(serviceActionOptions(options));
  }
  // A health responder does not prove this managed unit is running.
  // Require the manager's active state; HTTP readiness is corroboration only.
  return service;
}

function validateSettleWindow(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new OperationError('invalid_params', `${label} must be between 0 and ${max} milliseconds.`);
  }
  return value;
}

/** Non-throwing readiness probe: an unreadable port is "no answer", not a refusal. */
function workerAnswersReadiness(
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
): boolean {
  try {
    const url = `http://127.0.0.1:${workerReadinessPort(options)}/v1/health`;
    return options.readinessProbe
      ? options.readinessProbe(url)
      : defaultWorkerReadinessProbe(url, options.bunBin);
  } catch {
    return false;
  }
}

/**
 * The refusal for a start/stop/restart that never reached its state, carrying
 * the same last-log-line the activation path surfaces: the reason a worker
 * exited on boot is one line away in its own log, and every report of this so
 * far has been an operator going to find it by hand.
 */
function lifecycleActionFailure(
  action: WorkerLifecycleAction,
  state: WorkerServiceState,
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
): OperationError {
  const logLine = workerServiceFailureLogLine({ platform: options.platform, homeDir: options.homeDir });
  const paths = workerServicePaths(options.platform, options.homeDir);
  const message = `olympus worker ${action} completed but status is ${state}.`;
  return new OperationError(
    'config_error',
    logLine ? `${message} The worker's last log line was: ${logLine}` : message,
    `Read the worker log at ${paths.errorLogPath} and ${paths.logPath}, then run olympus worker status and follow its recovery action.`,
  );
}

/**
 * A worker that exits on boot leaves the service manager saying only
 * "inactive". The reason is one line away, in the worker's own log, and every
 * report of this failure so far has been an operator going to find it by hand.
 */
function activationFailure(
  message: string,
  options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string },
): OperationError {
  const logLine = workerServiceFailureLogLine({ platform: options.platform, homeDir: options.homeDir });
  const paths = workerServicePaths(options.platform, options.homeDir);
  return new OperationError(
    'config_error',
    logLine ? `${message} The worker's last log line was: ${logLine}` : message,
    `Read the worker log at ${paths.errorLogPath} and ${paths.logPath}, fix the reported cause, then run olympus worker install again.`,
  );
}

function serviceActionOptions(options: WorkerLifecycleOptions & { platform: WorkerServicePlatform; homeDir: string }): {
  platform: WorkerServicePlatform;
  homeDir: string;
  envPath?: string;
  exec?: WorkerServiceExec;
} {
  return {
    platform: options.platform,
    homeDir: options.homeDir,
    ...(options.envPath ? { envPath: options.envPath } : {}),
    ...(options.exec ? { exec: options.exec } : {}),
  };
}

function normalizeLifecyclePlatform(value: string): WorkerServicePlatform {
  if (value === 'darwin' || value === 'linux') return value;
  throw new OperationError('invalid_params', 'Olympus lifecycle supports macOS launchd and Linux user-systemd.');
}

function validateHomeDir(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !isAbsolute(trimmed) || /[\0\r\n]/.test(trimmed)) {
    throw new OperationError('invalid_params', 'Olympus lifecycle requires an absolute home directory.');
  }
  return trimmed;
}

function assertRegularFile(path: string, label: string): void {
  try {
    if (lstatSync(path).isFile()) return;
  } catch {
    // Fall through to the typed refusal.
  }
  throw new OperationError('config_error', `Refusing a non-regular ${label}: ${path}`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
