/**
 * The engine split under the worker service's own unit (olympus-worker.service
 * on Linux, `cli.js __worker-service-run`, rendered by worker-service.ts).
 * That path has no engine host, so with `worker.engineSplit` on the unit's
 * process supervises the two processes itself, as the engine host does
 * (engine-host.ts, engineHostServices): the background first, launched and
 * proved ready by the same engineBackgroundLaunch; then the front, told the
 * background's socket; each under the shared supervision kernel
 * (native-process-service.ts: its own process group, restart on exit with the
 * shared backoff, a bounded SIGTERM then SIGKILL on stop). On SIGTERM or
 * SIGINT it stops both and exits.
 *
 * The unit keeps systemd's default KillMode=control-group: a stop sends
 * SIGTERM to every process in the unit at once, so the front and the
 * background stop together, not in order. That is safe: the background ends
 * or abandons its pass under its data-owner lock, as a single worker does on
 * SIGTERM (a cut-short pass is recorded as interrupted, #803), and a front
 * whose background has gone answers that it is unavailable. So this process
 * stops both at once too: neither is restarted while the other is still
 * stopping. An ordered stop (front, then background) needs KillMode=mixed, a
 * later, opt-in change.
 *
 * Both children run `__worker-service-run` with their role already set, so
 * neither supervises again. With the switch off, or with any role set, or
 * when the Gateway or engine host launched the worker, none of this runs.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ENGINE_BACKGROUND_INSTANCE_ENV, ENGINE_BACKGROUND_SOCKET_ENV, ENGINE_ROLE_ENV, engineBackgroundSocketPath, engineRoleFromEnv, prepareEngineBackgroundSocketDirectory } from './engine-split.ts';
import { descendantGroupsPath } from './descendant-groups.ts';
import { createNativeProcessService, setNativeProcessChildStdio, type NativeProcessChildStdio, type NativeProcessServiceContext } from './native-process-service.ts';
import { ENGINE_BACKGROUND_SERVICE_ID, engineBackgroundLaunch } from './native-worker-service.ts';
import { readWorkerSetupEnv } from './worker-auth.ts';
import { WORKER_SHUTDOWN_DEADLINE_MS } from './worker-shutdown.ts';
import { clearLeftFrontSocket, startWorkerFrontProxy } from './worker-front-proxy.ts';
import { WORKER_LISTEN_SOCKET_ENV, workerFrontSocketPath } from './worker-transport.ts';

/** Each child gets its own shutdown deadline and a margin before the forced kill. */
const STOP_GRACE_MS = WORKER_SHUTDOWN_DEADLINE_MS + 5_000;
const STARTUP_TIMEOUT_MS = 180_000;
const STABLE_UPTIME_MS = 30_000;

export function workerServiceSplitApplies(input: {
  platform: NodeJS.Platform;
  /** The Gateway's or engine host's validated launch, which supervises the split itself. */
  managed: boolean;
  engineSplit: boolean | (() => boolean);
  env: Record<string, string | undefined>;
}): boolean {
  if (input.platform !== 'linux' || input.managed) return false;
  if (engineRoleFromEnv(input.env) !== 'single') return false;
  return typeof input.engineSplit === 'function' ? input.engineSplit() : input.engineSplit;
}

export async function superviseWorkerServiceSplit(input: {
  env: NodeJS.ProcessEnv;
  runtimePath: string;
  executablePath: string;
  authToken: string;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  restartDelaysMs?: readonly number[];
  readinessPollMs?: number;
  startupTimeoutMs?: number;
  stopGraceMs?: number;
  signals?: { once(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void };
  exit?: (code: number) => void;
  log?: (line: string) => void;
  /**
   * The children's stdout and stderr. `inherit` (the default) puts them in the
   * unit's own log, as the engine host does; tests that run in-process pass
   * `ignore`. Process-wide in the kernel, so it is set here, before any start.
   */
  childStdio?: NativeProcessChildStdio;
  /** The worker socket's pipe to the front; tests that run no real socket pass a stand-in. */
  startProxy?: (options: { env: NodeJS.ProcessEnv; frontSocket: string; log: (line: string) => void }) => { stop(): void };
}): Promise<{ stop(): Promise<void> }> {
  const log = input.log ?? ((line: string) => console.warn(line));
  setNativeProcessChildStdio(input.childStdio ?? 'inherit');
  // The kernel's restart timers do not hold the process open, and between a
  // child's exit and its replacement nothing else may: the unit's process
  // would exit 0 with no children, and Restart=on-failure would leave the
  // unit stopped. This holds it open until a stop has finished.
  const keepAlive = setInterval(() => {}, 1 << 30);
  const socketPath = engineBackgroundSocketPath({ env: input.env, platform: 'linux' });
  prepareEngineBackgroundSocketDirectory(socketPath);
  const startupTimeoutMs = input.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const args = ['--no-env-file', input.executablePath, '__worker-service-run'];
  // Each launch reads worker.env again, as the unit's EnvironmentFile= did
  // when an exit 75 restarted the whole unit: a credential saved there since
  // (a rotated model key, then its reload) reaches the restarted child. A
  // value the environment holds only because the file held it at the start
  // gives way to the file as it is now, or goes with it.
  const startFile = readWorkerSetupEnv({ env: input.env }) ?? {};
  const launchEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...input.env };
    for (const [key, value] of Object.entries(startFile)) if (env[key] === value) delete env[key];
    return { ...env, ...(readWorkerSetupEnv({ env: input.env }) ?? {}) };
  };
  const shared = {
    reload: { configPrefixes: [] },
    initialConfig: undefined,
    retryInitialStartFailure: true,
    stableUptimeMs: STABLE_UPTIME_MS,
    stopGraceMs: input.stopGraceMs ?? STOP_GRACE_MS,
    ...(input.restartDelaysMs ? { restartDelaysMs: input.restartDelaysMs } : {}),
    ...(input.readinessPollMs !== undefined ? { readinessPollMs: input.readinessPollMs } : {}),
    ...(input.spawn ? { spawn: input.spawn as unknown as typeof spawnProcess } : {}),
  };
  // The worker socket is this process's for as long as the unit runs; the
  // front serves on front.sock behind it, so a front restart never takes the
  // socket away (worker-front-proxy.ts).
  const frontSocket = workerFrontSocketPath({ env: input.env, platform: 'linux' })!;
  const proxy = (input.startProxy ?? startWorkerFrontProxy)({ env: input.env, frontSocket, log });
  const background = createNativeProcessService({
    ...shared,
    id: ENGINE_BACKGROUND_SERVICE_ID,
    label: 'background engine',
    // Extraction commands run in process groups of their own; the kernel
    // stops the ones a background left behind before its replacement starts.
    descendantGroupsPath: descendantGroupsPath(ENGINE_BACKGROUND_SERVICE_ID, input.env),
    prepareStart: async () => {
      const instanceId = randomUUID();
      const env = launchEnv();
      return engineBackgroundLaunch({
        env: { ...env, [ENGINE_BACKGROUND_INSTANCE_ENV]: instanceId },
        socketPath,
        // The token this background will answer to: a rotated one in worker.env too.
        authToken: env.OLYMPUS_WORKER_AUTH_TOKEN?.trim() || input.authToken,
        instanceId,
        command: input.runtimePath,
        args,
        startupTimeoutMs,
        probeTimeoutMs: Math.min(5_000, startupTimeoutMs),
      });
    },
  });
  const front = createNativeProcessService({
    ...shared,
    id: 'olympus-worker',
    label: 'worker front',
    descendantGroupsPath: descendantGroupsPath('olympus-worker', input.env),
    prepareStart: async () => {
      // The kernel starts no front over a live one: a socket left here is the last front's.
      clearLeftFrontSocket(frontSocket);
      return {
      command: input.runtimePath,
      args,
      env: { ...launchEnv(), [ENGINE_ROLE_ENV]: 'front', [ENGINE_BACKGROUND_SOCKET_ENV]: socketPath, [WORKER_LISTEN_SOCKET_ENV]: frontSocket },
      startupTimeoutMs,
      endpointOccupied: false,
      // The front waits for the background itself before it serves; running is enough here.
      readinessProbe: async (child) => child.exitCode === null && child.signalCode === null,
      };
    },
  });
  const context: NativeProcessServiceContext = {
    logger: { info: log, warn: log },
    // What the kernel reports (a child that exited, failed to start, or left
    // descendants behind) goes to the unit's log too.
    serviceHealth: {
      reportFailure: (error) => log(`Olympus worker service: ${error.message}`),
      clearFailure: () => {},
    },
  };
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      // Both at once, so a child that the unit's own SIGTERM already ended is
      // never started again while the other is still stopping.
      await Promise.all([front.stop().catch(() => undefined), background.stop().catch(() => undefined)]);
      proxy.stop();
      clearInterval(keepAlive);
    })();
    return stopping;
  };
  const signals = input.signals ?? { once: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => { process.once(signal, handler); } };
  const exit = input.exit ?? ((code: number) => process.exit(code));
  signals.once('SIGTERM', () => { void stop().finally(() => exit(143)); });
  signals.once('SIGINT', () => { void stop().finally(() => exit(130)); });
  log('Olympus worker service: engine split on; starting the background, then the front.');
  // A start that fails is retried on the backoff by the kernel; the front
  // still starts, and waits for the background itself.
  await background.start(context).catch(() => log('Olympus worker service: the background engine did not start yet; retrying.'));
  // A stop that came while the background was starting has already stopped
  // the front; starting it now would outlive the stop.
  if (stopping) return { stop };
  await front.start(context).catch(() => log('Olympus worker service: the worker front did not start yet; retrying.'));
  return { stop };
}

