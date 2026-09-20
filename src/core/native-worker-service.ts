import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { configFromPluginConfig, type OlympusConfig } from './config.ts';
import { applyWorkerSetupEnv, workerAuthTokenFromConfig } from './worker-auth.ts';

const SERVICE_ID = 'olympus-worker';
const DEFAULT_READINESS_POLL_MS = 100;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_RESTART_DELAYS_MS = [250, 1_000, 5_000, 15_000, 30_000] as const;

export interface NativeWorkerServiceHealth {
  reportFailure(error: Error): void;
  clearFailure(): void;
}

export interface NativeWorkerServiceContext {
  config?: unknown;
  logger?: {
    info?(message: string): void;
    warn?(message: string): void;
  };
  serviceHealth?: NativeWorkerServiceHealth;
}

export interface NativeWorkerServiceDefinition {
  id: string;
  reload: { configPrefixes: string[] };
  start(context: NativeWorkerServiceContext): Promise<void>;
  stop(): Promise<void>;
}

interface NativeWorkerServiceOptions {
  initialPluginConfig: unknown;
  moduleUrl: string;
  startupTimeoutMs?: number;
  readinessPollMs?: number;
  stopGraceMs?: number;
  restartDelaysMs?: readonly number[];
  fetch?: typeof fetch;
  /** Test seam; production always uses applyWorkerSetupEnv's default path. */
  workerEnvPath?: string;
  /** Test seam; production inherits the Gateway working directory. */
  workingDirectory?: string;
}

interface ServiceLifetime {
  generation: number;
  context: NativeWorkerServiceContext;
  child: ChildProcess | undefined;
  childReady: boolean;
  stopping: boolean;
  restartAttempt: number;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  cleanupPromise: Promise<void> | undefined;
}

interface WorkerLaunchSettings {
  runtimePath: string;
  executablePath: string;
  env: NodeJS.ProcessEnv;
  readinessUrl: string;
  authToken: string;
  instanceId: string;
}

class NativeWorkerServiceStoppedError extends Error {}
class NativeWorkerConfigurationError extends Error {}

/**
 * Supervise the packaged Bun worker without loading its Bun-only module graph
 * into the OpenClaw Gateway process.
 */
export function createNativeWorkerService(options: NativeWorkerServiceOptions): NativeWorkerServiceDefinition {
  const readinessPollMs = options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
  const fetchWorker = options.fetch ?? globalThis.fetch;
  let generation = 0;
  let current: ServiceLifetime | undefined;

  const isCurrent = (lifetime: ServiceLifetime): boolean => current === lifetime && !lifetime.stopping;

  const reportFailure = (lifetime: ServiceLifetime, message: string): void => {
    if (!isCurrent(lifetime)) return;
    try {
      lifetime.context.serviceHealth?.reportFailure(new Error(message));
    } catch {
      // OpenClaw binds health callbacks to a service generation. A callback
      // may throw after that generation is retired; shutdown must still win.
    }
  };

  const clearFailure = (lifetime: ServiceLifetime): void => {
    if (!isCurrent(lifetime)) return;
    try {
      lifetime.context.serviceHealth?.clearFailure();
    } catch {
      // See reportFailure: stale health handles are advisory only.
    }
  };

  const scheduleRestart = (lifetime: ServiceLifetime): void => {
    if (!isCurrent(lifetime) || lifetime.restartTimer) return;
    const index = Math.min(lifetime.restartAttempt, Math.max(restartDelaysMs.length - 1, 0));
    const delay = restartDelaysMs[index] ?? 30_000;
    lifetime.restartAttempt += 1;
    lifetime.restartTimer = setTimeout(() => {
      lifetime.restartTimer = undefined;
      if (!isCurrent(lifetime)) return;
      void launch(lifetime).catch(async (error) => {
        if (error instanceof NativeWorkerServiceStoppedError || !isCurrent(lifetime)) return;
        await terminateChild(lifetime, stopGraceMs);
        reportFailure(lifetime, 'Olympus worker failed to become ready.');
        scheduleRestart(lifetime);
      });
    }, delay);
    lifetime.restartTimer.unref?.();
  };

  const launch = async (lifetime: ServiceLifetime): Promise<void> => {
    if (!isCurrent(lifetime)) throw new NativeWorkerServiceStoppedError();
    const fresh = freshConfig(lifetime.context.config, options.initialPluginConfig);
    const config = fresh.config;
    if (!config.worker.service.enabled) return;
    assertNativeWorkerScopeConfigSupported(fresh.pluginConfig);
    const settings = workerLaunchSettings(config, options.moduleUrl, options.workerEnvPath);
    const endpointOccupied = await workerEndpointIsOccupied(fetchWorker, settings.readinessUrl);
    if (!isCurrent(lifetime)) throw new NativeWorkerServiceStoppedError();
    if (endpointOccupied) {
      throw new Error('Olympus worker endpoint is already occupied.');
    }
    const child = spawn(
      settings.runtimePath,
      ['--no-env-file', settings.executablePath, '__worker-service-run', settings.instanceId],
      {
        env: settings.env,
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
      },
    );
    lifetime.child = child;
    lifetime.childReady = false;
    let spawnFailed = false;

    child.once('exit', () => {
      // Startup and intentional-stop paths retain or clear this ownership
      // themselves. A ready crash must keep the exact child/PGID long enough
      // to terminate descendants before any replacement can be scheduled.
      if (lifetime.child !== child || !isCurrent(lifetime) || !lifetime.childReady) return;
      lifetime.childReady = false;
      const cleanup = terminateChild(lifetime, stopGraceMs, child);
      reportFailure(lifetime, 'Olympus worker exited unexpectedly.');
      void cleanup.then(() => {
        scheduleRestart(lifetime);
      }).catch(() => {
        reportFailure(lifetime, 'Olympus worker descendants could not be stopped after an unexpected exit.');
      });
    });

    child.once('error', () => {
      spawnFailed = true;
      // The exit/readiness path owns reporting. Never forward the spawn error:
      // platform errors can include command arguments and environment detail.
    });

    await waitForAuthenticatedReadiness({
      lifetime,
      child,
      settings,
      fetchWorker,
      isCurrent,
      startupTimeoutMs: options.startupTimeoutMs ?? config.worker.service.startupTimeoutSeconds * 1_000,
      readinessPollMs,
      spawnFailed: () => spawnFailed,
    });
    if (!isCurrent(lifetime) || lifetime.child !== child) throw new NativeWorkerServiceStoppedError();
    if (spawnFailed || childExited(child)) throw new Error('Olympus worker exited during startup.');
    lifetime.childReady = true;
    lifetime.restartAttempt = 0;
    clearFailure(lifetime);
    lifetime.context.logger?.info?.('Olympus worker service is ready.');
  };

  return {
    id: SERVICE_ID,
    reload: {
      configPrefixes: [
        'plugins.entries.olympus.config.worker',
        'plugins.entries.olympus.config.email.baseUrl',
        'plugins.entries.olympus.config.sourceIndex',
        'plugins.entries.olympus.config.sovereignty',
      ],
    },
    async start(context) {
      await stopCurrent();
      const lifetime: ServiceLifetime = {
        generation: ++generation,
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
        if (error instanceof NativeWorkerServiceStoppedError) return;
        await terminateChild(lifetime, stopGraceMs);
        const message = error instanceof NativeWorkerConfigurationError
          ? error.message
          : 'Olympus worker failed to become ready.';
        reportFailure(lifetime, message);
        if (current === lifetime) current = undefined;
        throw new Error(message);
      }
    },
    async stop() {
      await stopCurrent();
    },
  };

  async function stopCurrent(): Promise<void> {
    const lifetime = current;
    if (!lifetime) return;
    current = undefined;
    lifetime.stopping = true;
    if (lifetime.restartTimer) {
      clearTimeout(lifetime.restartTimer);
      lifetime.restartTimer = undefined;
    }
    await terminateChild(lifetime, stopGraceMs);
  }
}

function freshConfig(
  contextConfig: unknown,
  initialPluginConfig: unknown,
): { config: OlympusConfig; pluginConfig: unknown } {
  const root = asRecord(contextConfig);
  const plugins = asRecord(root?.plugins);
  const entries = asRecord(plugins?.entries);
  const olympus = asRecord(entries?.olympus);
  const livePluginConfig = olympus && Object.prototype.hasOwnProperty.call(olympus, 'config')
    ? olympus.config
    : undefined;
  const directPluginConfig = root && ['worker', 'email', 'sourceIndex', 'argus', 'identity', 'sovereignty']
    .some((key) => Object.prototype.hasOwnProperty.call(root, key))
    ? root
    : undefined;
  // A full service context is the Gateway's fresh, SecretRef-resolved runtime
  // snapshot. If its plugin entry was removed, default disabled config must
  // win; falling back to the registration snapshot could resurrect stale or
  // unresolved source SecretRefs after a reload.
  const pluginConfig = entries
    ? livePluginConfig
    : directPluginConfig ?? initialPluginConfig;
  return { config: configFromPluginConfig(pluginConfig), pluginConfig };
}

function assertNativeWorkerScopeConfigSupported(pluginConfig: unknown): void {
  const sourceIndex = asRecord(asRecord(pluginConfig)?.sourceIndex);
  const unsupported = [
    'corpusRegistry',
    'corpora',
    'ingestionPolicies',
    'ingestionExclusions',
    'ingestionExclusionsPath',
  ].filter((key) => sourceIndex && Object.prototype.hasOwnProperty.call(sourceIndex, key));
  if (unsupported.length > 0) {
    throw new NativeWorkerConfigurationError(
      `Gateway-managed Olympus workers do not support explicit sourceIndex.${unsupported[0]} plugin config; configure source scope through the worker environment.`,
    );
  }
}

function workerLaunchSettings(
  config: OlympusConfig,
  moduleUrl: string,
  workerEnvPath?: string,
): WorkerLaunchSettings {
  const service = config.worker.service;
  const env: NodeJS.ProcessEnv = { ...process.env };
  applyWorkerSetupEnv({ env, ...(workerEnvPath ? { workerEnvPath } : {}) });
  stripGatewayBootstrapSecrets(env);
  for (const [name, value] of Object.entries(service.credentials)) env[name] = value;
  if (config.worker.authToken) env.OLYMPUS_WORKER_AUTH_TOKEN = config.worker.authToken;
  applyNativeWorkerConfigEnv(config, env);
  const authToken = workerAuthTokenFromConfig(config, {
    env,
    ...(workerEnvPath ? { workerEnvPath } : {}),
  });
  if (!authToken) {
    throw new Error('Olympus worker service requires a configured worker auth token.');
  }
  const instanceId = randomUUID();
  env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID = instanceId;
  return {
    runtimePath: resolveBunRuntimePath(service.runtimePath, env),
    executablePath: resolveWorkerExecutablePath(service.executablePath, moduleUrl),
    env,
    readinessUrl: `${config.email.baseUrl.replace(/\/$/, '')}/service/readiness`,
    authToken,
    instanceId,
  };
}

function applyNativeWorkerConfigEnv(config: OlympusConfig, env: NodeJS.ProcessEnv): void {
  if (config.sovereignty?.policy) {
    throw new NativeWorkerConfigurationError(
      'Gateway-managed Olympus workers do not support an inline sovereignty policy; configure sovereignty.configPath.',
    );
  }
  if (config.sovereignty?.configPath) {
    env.OLYMPUS_SOVEREIGNTY_CONFIG_PATH = config.sovereignty.configPath;
  }
  const workerUrl = new URL(config.email.baseUrl);
  if (
    workerUrl.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(workerUrl.hostname)
    || workerUrl.pathname.replace(/\/$/, '') !== '/v1'
    || workerUrl.username
    || workerUrl.password
    || workerUrl.search
    || workerUrl.hash
  ) {
    throw new Error('Gateway-managed Olympus workers require a loopback HTTP email.baseUrl ending in /v1.');
  }
  env.OLYMPUS_EMAIL_SOURCE_HOST = workerUrl.hostname === '[::1]' ? '::1' : workerUrl.hostname;
  env.OLYMPUS_EMAIL_SOURCE_PORT = workerUrl.port || '80';
  env.OLYMPUS_SOURCE_INDEX_ENABLED = String(config.sourceIndex.enabled);
  env.OLYMPUS_WORKER_SCHEDULER_ENABLED = String(config.worker.scheduler.enabled);
  env.OLYMPUS_WORKER_SCHEDULER_SOURCE_IDS = config.worker.scheduler.sourceIds.join(',');
  env.OLYMPUS_WORKER_SCHEDULER_TICK_SECONDS = String(config.worker.scheduler.tickSeconds);
  env.OLYMPUS_WORKER_SCHEDULER_SYNC_INTERVAL_SECONDS = String(config.worker.scheduler.syncIntervalSeconds);
  env.OLYMPUS_WORKER_SCHEDULER_FRESHNESS_THRESHOLD_HOURS = String(config.worker.scheduler.freshnessThresholdHours);
  env.OLYMPUS_WORKER_SCHEDULER_ERROR_BACKOFF_SECONDS = String(config.worker.scheduler.errorBackoffSeconds);
  env.OLYMPUS_WORKER_SCHEDULER_MAX_TRANSIENT_RETRIES = String(config.worker.scheduler.maxTransientRetries);
}

function resolveBunRuntimePath(configured: string | undefined, env: NodeJS.ProcessEnv): string {
  if (configured) return assertExecutableFile(configured, 'Bun runtime');
  const candidates = [
    process.execPath,
    ...(env.BUN_INSTALL ? [join(env.BUN_INSTALL, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun')] : []),
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, process.platform === 'win32' ? 'bun.exe' : 'bun')),
  ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !isBunExecutableName(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next absolute candidate.
    }
  }
  throw new Error('Olympus worker service could not resolve an absolute Bun runtime path.');
}

function resolveWorkerExecutablePath(configured: string | undefined, moduleUrl: string): string {
  const candidate = configured ?? fileURLToPath(new URL('./cli.js', moduleUrl));
  return assertExecutableFile(candidate, 'worker executable');
}

function assertExecutableFile(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`Olympus ${label} path must be absolute.`);
  try {
    if (statSync(path).isFile()) return path;
  } catch {
    // Use the same categorical error for absent and unreadable paths.
  }
  throw new Error(`Olympus ${label} is unavailable.`);
}

function isBunExecutableName(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === 'bun' || name === 'bun.exe';
}

async function waitForAuthenticatedReadiness(input: {
  lifetime: ServiceLifetime;
  child: ChildProcess;
  settings: WorkerLaunchSettings;
  fetchWorker: typeof fetch;
  isCurrent(lifetime: ServiceLifetime): boolean;
  startupTimeoutMs: number;
  readinessPollMs: number;
  spawnFailed(): boolean;
}): Promise<void> {
  const deadline = Date.now() + input.startupTimeoutMs;
  while (Date.now() < deadline) {
    if (!input.isCurrent(input.lifetime)) throw new NativeWorkerServiceStoppedError();
    if (input.spawnFailed() || childExited(input.child)) throw new Error('Olympus worker exited during startup.');
    const authenticated = await authenticatedReadinessProbe(
      input.fetchWorker,
      input.settings.readinessUrl,
      input.settings.authToken,
      input.settings.instanceId,
      Math.min(1_000, Math.max(deadline - Date.now(), 1)),
    );
    if (authenticated) {
      if (!input.isCurrent(input.lifetime)) throw new NativeWorkerServiceStoppedError();
      if (input.spawnFailed() || childExited(input.child)) throw new Error('Olympus worker exited during startup.');
      return;
    }
    await delay(input.readinessPollMs);
  }
  throw new Error('Olympus worker readiness timed out.');
}

async function authenticatedReadinessProbe(
  fetchWorker: typeof fetch,
  url: string,
  authToken: string,
  instanceId: string,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchWorker(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const body = await response.json().catch(() => undefined) as { instance_id?: unknown } | undefined;
    return body?.instance_id === instanceId;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function workerEndpointIsOccupied(fetchWorker: typeof fetch, url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 250);
  timeout.unref?.();
  try {
    const response = await fetchWorker(url, { method: 'GET', signal: controller.signal });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function stripGatewayBootstrapSecrets(env: NodeJS.ProcessEnv): void {
  const exact = new Set([
    'OP_CONNECT_HOST',
    'OP_CONNECT_TOKEN',
    'OP_SERVICE_ACCOUNT_TOKEN',
    'OPENCLAW_GATEWAY_TOKEN',
    'OPENCLAW_GATEWAY_PASSWORD',
    'OPENCLAW_HOOKS_TOKEN',
    'OPENCLAW_NODE_TOKEN',
    'OPENCLAW_DEVICE_TOKEN',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'DYLD_FRAMEWORK_PATH',
    'NODE_OPTIONS',
    'BUN_OPTIONS',
  ]);
  for (const key of Object.keys(env)) {
    if (exact.has(key) || key.startsWith('OP_SESSION_')) delete env[key];
  }
}

async function terminateChild(
  lifetime: ServiceLifetime,
  graceMs: number,
  expectedChild?: ChildProcess,
): Promise<void> {
  if (lifetime.cleanupPromise) return await lifetime.cleanupPromise;
  const child = lifetime.child;
  if (expectedChild && child !== expectedChild) return;
  lifetime.child = undefined;
  lifetime.childReady = false;
  if (!child?.pid) return;
  const cleanup = terminateChildProcessGroup(child, graceMs);
  lifetime.cleanupPromise = cleanup;
  try {
    await cleanup;
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
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
