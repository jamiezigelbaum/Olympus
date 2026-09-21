import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';

const DEFAULT_READINESS_POLL_MS = 100;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_RESTART_DELAYS_MS = [250, 1_000, 5_000, 15_000, 30_000] as const;

export interface NativeProcessServiceHealth {
  reportFailure(error: Error): void;
  clearFailure(): void;
}

export interface NativeProcessServiceContext {
  config?: unknown;
  logger?: {
    info?(message: string): void;
    warn?(message: string): void;
  };
  serviceHealth?: NativeProcessServiceHealth;
}

export interface NativeProcessServiceDefinition {
  id: string;
  reload: { configPrefixes: string[] };
  start(context: NativeProcessServiceContext): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Everything a service needs to launch one child process. The kernel owns the
 * lifecycle; the service definition owns what to run, what environment it gets,
 * and how to tell whether that instance became ready.
 */
export interface NativeProcessStartSettings {
  /** Absolute command to execute. */
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Startup deadline for this child, in milliseconds. */
  startupTimeoutMs: number;
  /**
   * Categorical ownership of the service endpoint. `unknown` means the probe
   * could not prove the endpoint is free; the kernel treats that as occupied so
   * two supervisors never fight over one listener.
   */
  endpointOccupied: boolean;
  /** Per-child readiness probe. `true` means this exact instance is serving. */
  readinessProbe(child: ChildProcess): Promise<boolean>;
}

export interface NativeProcessStartInput<TSettings extends NativeProcessStartSettings> {
  serviceId: string;
  serviceLabel: string;
  /** Fresh context config for this start; never a stale registration snapshot. */
  context: NativeProcessServiceContext;
  /** Registration-time config snapshot, used only when the context omits config. */
  initialConfig: unknown;
}

export interface NativeProcessServiceOptions<TSettings extends NativeProcessStartSettings> {
  id: string;
  label: string;
  reload: { configPrefixes: string[] };
  initialConfig: unknown;
  /**
   * Resolve fresh config and prepare this start: command, arguments, environment,
   * endpoint ownership, and the readiness probe.
   */
  prepareStart(input: NativeProcessStartInput<TSettings>): Promise<TSettings | undefined>;
  /** Fallback startup deadline when neither the options nor the start settings provide one. */
  defaultStartupTimeoutMs?: number;
  /** Spawn seam; defaults to node:child_process spawn. */
  spawn?: typeof spawnProcess;
  /** Test seam; production inherits the host working directory. */
  workingDirectory?: string;
  startupTimeoutMs?: number;
  readinessPollMs?: number;
  stopGraceMs?: number;
  restartDelaysMs?: readonly number[];
  /**
   * Whether a healthy child that exits cleanly (code 0, no signal) is
   * supervised as a crash. Defaults to `true`, which restarts it. `false` opts
   * into completion semantics: no replacement is scheduled, the child's
   * process group is still terminated before the supervisor settles, and a zero
   * exit without an exact-instance readiness receipt stays a startup failure.
   */
  restartOnCleanExit?: boolean;
}

/** OpenClaw replacement starts have a five-second deadline. Keep the host
 * callback prompt while this supervisor retains readiness, failure, and stop
 * ownership. Initializing children remain degraded until their receipt passes.
 */
export function backgroundNativeProcessService(
  service: NativeProcessServiceDefinition,
): NativeProcessServiceDefinition {
  return {
    ...service,
    async start(context) {
      void service.start(context).catch((error) => {
        if (error instanceof NativeProcessReportedStartError) return;
        // The supervisor normally reports a categorical failure itself. This
        // also covers cleanup failure; never forward raw child/spawn errors.
        try {
          context.serviceHealth?.reportFailure(new Error(`Olympus service ${service.id} failed to start.`));
        } catch {
          // A stopped/replaced host lease must not resurrect stale health.
        }
      });
    },
  };
}

interface ServiceLifetime<TSettings extends NativeProcessStartSettings> {
  generation: number;
  context: NativeProcessServiceContext;
  child: ChildProcess | undefined;
  childReady: boolean;
  stopping: boolean;
  restartAttempt: number;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  cleanupPromise: Promise<void> | undefined;
}

/** The lifetime was retired (stop, or a newer start) before or during launch. */
export class NativeProcessServiceStoppedError extends Error {}

/**
 * A preparation error whose message is already safe to report to the host
 * verbatim, unlike raw spawn/HTTP failures.
 */
export class NativeProcessConfigurationError extends Error {}

/** The supervisor already sent this sanitized failure to its current health lease. */
class NativeProcessReportedStartError extends Error {}

/**
 * Reusable process supervision for native child services: fresh-config start,
 * occupied-endpoint preflight, per-child readiness, bounded restart backoff, and
 * POSIX process-group cleanup. Worker/connector-specific parsing, credentials,
 * arguments, and probes belong to the service definition that calls this.
 *
 * Invariants the kernel must keep:
 * - the generation is re-checked after every awaited preflight, so a stale start
 *   never spawns once stop() or a newer start has retired it;
 * - a crashed child's process group is terminated before its replacement starts;
 * - restart backoff is bounded and cancels with the lifetime;
 * - child cleanup is a single shared promise, so stop() waits for an in-flight
 *   crash cleanup instead of racing it;
 * - with `restartOnCleanExit: false`, a clean exit is completion rather than a
 *   crash: it schedules no replacement, keeps health clear for the current
 *   lifetime only, and still terminates the child's process group;
 * - SIGTERM then a bounded SIGKILL go to the whole detached group. There is no
 *   `kill(-pgid, 0)` liveness gate: a live zombie would defeat it and leak real
 *   descendants;
 * - failure reporting is categorical and never forwards raw stderr or spawn
 *   errors, which can carry arguments and environment detail.
 */
export function createNativeProcessService<TSettings extends NativeProcessStartSettings>(
  options: NativeProcessServiceOptions<TSettings>,
): NativeProcessServiceDefinition {
  const readinessPollMs = options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
  const restartOnCleanExit = options.restartOnCleanExit ?? true;
  const spawnChild = options.spawn ?? spawnProcess;
  let generation = 0;
  let current: ServiceLifetime<TSettings> | undefined;
  let retiring: ServiceLifetime<TSettings> | undefined;
  let retirement: Promise<void> | undefined;

  const isCurrent = (lifetime: ServiceLifetime<TSettings>): boolean => current === lifetime && !lifetime.stopping;

  const reportFailure = (lifetime: ServiceLifetime<TSettings>, message: string): void => {
    if (!isCurrent(lifetime)) return;
    try {
      lifetime.context.serviceHealth?.reportFailure(new Error(message));
    } catch {
      // OpenClaw binds health callbacks to a service generation. A callback
      // may throw after that generation is retired; shutdown must still win.
    }
  };

  const clearFailure = (lifetime: ServiceLifetime<TSettings>): void => {
    if (!isCurrent(lifetime)) return;
    try {
      lifetime.context.serviceHealth?.clearFailure();
    } catch {
      // See reportFailure: stale health handles are advisory only.
    }
  };

  const scheduleRestart = (lifetime: ServiceLifetime<TSettings>): void => {
    if (!isCurrent(lifetime) || lifetime.restartTimer) return;
    const index = Math.min(lifetime.restartAttempt, Math.max(restartDelaysMs.length - 1, 0));
    const delay = restartDelaysMs[index] ?? 30_000;
    lifetime.restartAttempt += 1;
    lifetime.restartTimer = setTimeout(() => {
      lifetime.restartTimer = undefined;
      if (!isCurrent(lifetime)) return;
      void launch(lifetime).catch(async (error) => {
        if (error instanceof NativeProcessServiceStoppedError || !isCurrent(lifetime)) return;
        await terminateChild(lifetime, stopGraceMs);
        reportFailure(lifetime, `Olympus ${options.label} failed to become ready.`);
        scheduleRestart(lifetime);
      });
    }, delay);
    lifetime.restartTimer.unref?.();
  };

  /**
   * Settle an opted-in clean exit: the group is stopped first (a descendant can
   * outlive its leader, so completion never skips cleanup), then health is
   * cleared for the current lifetime only. Rejects with the cleanup error, which
   * callers report categorically.
   */
  const completeCleanExit = (lifetime: ServiceLifetime<TSettings>, child: ChildProcess): Promise<void> => {
    return terminateChild(lifetime, stopGraceMs, child).then(() => {
      if (!isCurrent(lifetime)) return;
      clearFailure(lifetime);
      try {
        lifetime.context.logger?.info?.(`Olympus ${options.label} completed a clean exit.`);
      } catch {
        // A retired logger must not turn completion into a failure.
      }
    });
  };

  const launch = async (lifetime: ServiceLifetime<TSettings>): Promise<void> => {
    if (!isCurrent(lifetime)) throw new NativeProcessServiceStoppedError();
    const settings = await options.prepareStart({
      serviceId: options.id,
      serviceLabel: options.label,
      context: lifetime.context,
      initialConfig: options.initialConfig,
    });
    if (!settings) return;
    // A service may await during prepareStart (secret resolution, config read).
    // Re-check before spawning so stop() or a newer generation always wins.
    if (!isCurrent(lifetime)) throw new NativeProcessServiceStoppedError();
    if (settings.endpointOccupied) {
      throw new Error(`Olympus ${options.label} endpoint is already occupied.`);
    }
    reportFailure(lifetime, `Olympus ${options.label} is starting.`);
    if (!isCurrent(lifetime)) throw new NativeProcessServiceStoppedError();
    const child = spawnChild(settings.command, [...settings.args], {
      env: settings.env,
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
    });
    lifetime.child = child;
    lifetime.childReady = false;
    let spawnFailed = false;

    child.once('exit', (code, signal) => {
      // Startup and intentional-stop paths retain or clear this ownership
      // themselves. A ready crash must keep the exact child/PGID long enough
      // to terminate descendants before any replacement can be scheduled.
      if (lifetime.child !== child || !isCurrent(lifetime) || !lifetime.childReady) return;
      lifetime.childReady = false;
      if (!restartOnCleanExit && code === 0 && signal === null) {
        // Opt-in completion: finished work is not a crash, so no replacement is
        // scheduled and health stays clear. Descendant cleanup is still
        // mandatory. terminateChild is entered synchronously to keep the PGID.
        void completeCleanExit(lifetime, child).catch(() => {
          reportFailure(lifetime, `Olympus ${options.label} descendants could not be stopped after a clean exit.`);
        });
        return;
      }
      const cleanup = terminateChild(lifetime, stopGraceMs, child);
      reportFailure(lifetime, `Olympus ${options.label} exited unexpectedly.`);
      void cleanup.then(() => {
        scheduleRestart(lifetime);
      }).catch(() => {
        reportFailure(lifetime, `Olympus ${options.label} descendants could not be stopped after an unexpected exit.`);
      });
    });

    child.once('error', () => {
      spawnFailed = true;
      // The exit/readiness path owns reporting. Never forward the spawn error:
      // platform errors can include command arguments and environment detail.
    });

    const outcome = await waitForChildReadiness({
      lifetime,
      child,
      settings,
      isCurrent,
      startupTimeoutMs: options.startupTimeoutMs ?? settings.startupTimeoutMs,
      readinessPollMs,
      restartOnCleanExit,
      spawnFailed: () => spawnFailed,
    });
    if (!isCurrent(lifetime) || lifetime.child !== child) throw new NativeProcessServiceStoppedError();
    if (outcome === 'cleanCompletion' || (!restartOnCleanExit && !spawnFailed && isCleanExit(child))) {
      await completeCleanExit(lifetime, child);
      return;
    }
    if (spawnFailed || childExited(child)) throw new Error(`Olympus ${options.label} exited during startup.`);
    lifetime.childReady = true;
    lifetime.restartAttempt = 0;
    clearFailure(lifetime);
    lifetime.context.logger?.info?.(`Olympus ${options.label} is ready.`);
  };

  return {
    id: options.id,
    reload: { configPrefixes: [...options.reload.configPrefixes] },
    async start(context) {
      const requestedGeneration = ++generation;
      await stopCurrent();
      if (requestedGeneration !== generation) return;
      const lifetime: ServiceLifetime<TSettings> = {
        generation: requestedGeneration,
        context,
        child: undefined,
        childReady: false,
        stopping: false,
        restartAttempt: 0,
        restartTimer: undefined,
        cleanupPromise: undefined,
      };
      current = lifetime;
      try {
        await launch(lifetime);
      } catch (error) {
        if (error instanceof NativeProcessServiceStoppedError) return;
        await terminateChild(lifetime, stopGraceMs);
        const message = error instanceof NativeProcessConfigurationError
          ? error.message
          : `Olympus ${options.label} failed to become ready.`;
        reportFailure(lifetime, message);
        if (current === lifetime) current = undefined;
        throw new NativeProcessReportedStartError(message);
      }
    },
    async stop() {
      generation += 1;
      await stopCurrent();
    },
  };

  async function stopCurrent(): Promise<void> {
    if (retirement) return await retirement;
    const lifetime = current ?? retiring;
    if (!lifetime) return;
    current = undefined;
    retiring = lifetime;
    lifetime.stopping = true;
    if (lifetime.restartTimer) {
      clearTimeout(lifetime.restartTimer);
      lifetime.restartTimer = undefined;
    }
    // A failed signal retains both the lifetime and exact child/PGID. No new
    // start may pass this boundary until a later stop establishes cleanup.
    const cleanup = terminateChild(lifetime, stopGraceMs).then(() => {
      if (retiring === lifetime) retiring = undefined;
    });
    retirement = cleanup;
    try {
      await cleanup;
    } finally {
      if (retirement === cleanup) retirement = undefined;
    }
  }

}

async function waitForChildReadiness<TSettings extends NativeProcessStartSettings>(input: {
  lifetime: ServiceLifetime<TSettings>;
  child: ChildProcess;
  settings: TSettings;
  isCurrent(lifetime: ServiceLifetime<TSettings>): boolean;
  startupTimeoutMs: number;
  readinessPollMs: number;
  restartOnCleanExit: boolean;
  spawnFailed(): boolean;
}): Promise<'ready' | 'cleanCompletion'> {
  const deadline = Date.now() + input.startupTimeoutMs;
  const acceptsCleanExit = !input.restartOnCleanExit;
  while (Date.now() < deadline) {
    if (!input.isCurrent(input.lifetime)) throw new NativeProcessServiceStoppedError();
    if (input.spawnFailed()) throw new Error('Child exited during startup.');
    if (childExited(input.child)) {
      // A one-shot child can finish before the first poll observes its receipt.
      // Only an exact-instance readiness receipt turns that zero exit into
      // completion; zero without a receipt is the startup failure it looks like.
      if (acceptsCleanExit && isCleanExit(input.child) && await readinessReceiptAfterExit(input)) return 'cleanCompletion';
      throw new Error('Child exited during startup.');
    }
    const ready = await input.settings.readinessProbe(input.child);
    if (ready) {
      if (!input.isCurrent(input.lifetime)) throw new NativeProcessServiceStoppedError();
      if (input.spawnFailed()) throw new Error('Child exited during startup.');
      if (childExited(input.child)) {
        if (acceptsCleanExit && isCleanExit(input.child)) return 'cleanCompletion';
        throw new Error('Child exited during startup.');
      }
      return 'ready';
    }
    await delay(input.readinessPollMs);
  }
  throw new Error('Child readiness timed out.');
}

/**
 * Last readiness chance for an opted-in one-shot child that exited before any
 * poll observed it. Only `true` for this exact instance is completion; a probe
 * error or a retired lifetime is not.
 */
async function readinessReceiptAfterExit<TSettings extends NativeProcessStartSettings>(input: {
  lifetime: ServiceLifetime<TSettings>;
  child: ChildProcess;
  settings: TSettings;
  isCurrent(lifetime: ServiceLifetime<TSettings>): boolean;
}): Promise<boolean> {
  if (!input.isCurrent(input.lifetime)) throw new NativeProcessServiceStoppedError();
  const ready = await input.settings.readinessProbe(input.child);
  if (!input.isCurrent(input.lifetime)) throw new NativeProcessServiceStoppedError();
  return ready;
}

async function terminateChild<TSettings extends NativeProcessStartSettings>(
  lifetime: ServiceLifetime<TSettings>,
  graceMs: number,
  expectedChild?: ChildProcess,
): Promise<void> {
  if (lifetime.cleanupPromise) return await lifetime.cleanupPromise;
  const child = lifetime.child;
  if (expectedChild && child !== expectedChild) return;
  lifetime.childReady = false;
  if (!child?.pid) {
    if (lifetime.child === child) lifetime.child = undefined;
    return;
  }
  const cleanup = terminateChildProcessGroup(child, graceMs);
  lifetime.cleanupPromise = cleanup;
  try {
    await cleanup;
    if (lifetime.child === child) lifetime.child = undefined;
  } finally {
    if (lifetime.cleanupPromise === cleanup) lifetime.cleanupPromise = undefined;
  }
}

async function terminateChildProcessGroup(child: ChildProcess, graceMs: number): Promise<void> {
  const processGroupId = child.pid;
  if (!processGroupId) return;
  signalChildTree(child, 'SIGTERM');
  await waitForChildExit(child, graceMs);
  // The direct child may exit before one of its descendants. On POSIX the
  // detached child's process group survives its leader, so always send the
  // bounded hard-stop signal to the whole group after the grace period.
  signalChildTree(child, 'SIGKILL');
  await waitForChildExit(child, 1_000);
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    // A missing group is already stopped; denied signals are cleanup failures.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isCleanExit(child: ChildProcess): boolean {
  return child.exitCode === 0 && child.signalCode === null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (childExited(child)) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    timeout.unref?.();
    child.once('exit', done);
    function done(): void {
      clearTimeout(timeout);
      child.removeListener('exit', done);
      resolve();
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}
