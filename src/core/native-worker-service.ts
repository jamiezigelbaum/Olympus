import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromPluginConfig, type OlympusConfig } from './config.ts';
import {
  createNativeProcessService,
  NativeProcessConfigurationError,
  type NativeProcessServiceContext,
  type NativeProcessServiceDefinition,
  type NativeProcessServiceHealth,
  type NativeProcessStartInput,
  type NativeProcessStartSettings,
} from './native-process-service.ts';
import { applyWorkerSetupEnv, workerAuthTokenFromConfig } from './worker-auth.ts';

const SERVICE_ID = 'olympus-worker';
const SERVICE_LABEL = 'worker';
const READINESS_PROBE_TIMEOUT_MS = 1_000;
const ENDPOINT_OCCUPANCY_TIMEOUT_MS = 250;
const DEFAULT_WORKER_STARTUP_TIMEOUT_MS = 10_000;

export const NATIVE_CAPTURE_OWNER_ENV_NAMES = {
  telegram: 'OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER',
  whatsapp: 'OLYMPUS_NATIVE_WHATSAPP_CAPTURE_OWNER',
} as const;

/**
 * The lifecycle types now live in the shared process kernel; these aliases keep
 * the worker service's historical public names usable.
 */
export type NativeWorkerServiceHealth = NativeProcessServiceHealth;
export type NativeWorkerServiceContext = NativeProcessServiceContext;
export type NativeWorkerServiceDefinition = NativeProcessServiceDefinition;

export interface NativeWorkerServiceOptions {
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

interface WorkerLaunchSettings extends NativeProcessStartSettings {
  runtimePath: string;
  executablePath: string;
  env: NodeJS.ProcessEnv;
  readinessUrl: string;
  authToken: string;
  instanceId: string;
}

/**
 * Supervise the packaged Bun worker without loading its Bun-only module graph
 * into the OpenClaw Gateway process.
 *
 * The generic process kernel owns the lifecycle: generation checks after every
 * awaited preflight, the occupied-endpoint gate, bounded restart backoff, and
 * POSIX process-group cleanup. This adapter owns what is worker-specific: fresh
 * config parsing, the native scope and sovereignty gates, credential and
 * environment sanitization, the Bun `--no-env-file` CLI arguments, loopback
 * endpoint validation, and the authenticated HTTP readiness probe.
 */
export function createNativeWorkerService(options: NativeWorkerServiceOptions): NativeWorkerServiceDefinition & { isReady(): boolean } {
  let readyChild: ChildProcess | undefined;
  let proofGeneration = 0;
  let lifecycleGeneration = 0;
  const invalidate = () => { proofGeneration += 1; readyChild = undefined; };
  const fetchWorker = options.fetch ?? globalThis.fetch;
  const service = createNativeProcessService<WorkerLaunchSettings>({
    id: SERVICE_ID,
    label: SERVICE_LABEL,
    reload: {
      configPrefixes: [
        'plugins.entries.olympus.config.worker',
        'plugins.entries.olympus.config.email.baseUrl',
        'plugins.entries.olympus.config.sourceIndex',
        'plugins.entries.olympus.config.sovereignty',
      ],
    },
    initialConfig: options.initialPluginConfig,
    ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
    ...(options.startupTimeoutMs !== undefined ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    ...(options.readinessPollMs !== undefined ? { readinessPollMs: options.readinessPollMs } : {}),
    ...(options.stopGraceMs !== undefined ? { stopGraceMs: options.stopGraceMs } : {}),
    ...(options.restartDelaysMs ? { restartDelaysMs: options.restartDelaysMs } : {}),
    defaultStartupTimeoutMs: DEFAULT_WORKER_STARTUP_TIMEOUT_MS,
    prepareStart: async (input) => {
      invalidate();
      const generation = proofGeneration;
      const settings = await prepareWorkerStart(input, {
        moduleUrl: options.moduleUrl,
        fetchWorker,
        ...(options.workerEnvPath ? { workerEnvPath: options.workerEnvPath } : {}),
        ...(options.startupTimeoutMs !== undefined ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
      });
      if (!settings) return undefined;
      const probe = settings.readinessProbe;
      return {
        ...settings,
        async readinessProbe(child) {
          const ready = await probe(child);
          if (ready && generation === proofGeneration) readyChild = child;
          return ready;
        },
      };
    },
  });
  return {
    ...service,
    isReady() {
      return Boolean(readyChild?.pid && readyChild.exitCode === null
        && readyChild.signalCode === null && !readyChild.killed);
    },
    async start(context) {
      const generation = ++lifecycleGeneration;
      invalidate();
      try { await service.start(context); }
      catch (error) { if (generation === lifecycleGeneration) invalidate(); throw error; }
    },
    async stop() {
      lifecycleGeneration += 1;
      invalidate();
      await service.stop();
    },
  };
}

async function prepareWorkerStart(
  input: NativeProcessStartInput<WorkerLaunchSettings>,
  worker: { moduleUrl: string; fetchWorker: typeof fetch; workerEnvPath?: string; startupTimeoutMs?: number },
): Promise<WorkerLaunchSettings | undefined> {
  const fresh = freshConfig(input.context.config, input.initialConfig);
  const config = fresh.config;
  if (!config.worker.service.enabled) return undefined;
  assertNativeWorkerScopeConfigSupported(fresh.pluginConfig);
  const settings = workerLaunchSettings(config, worker.moduleUrl, worker.workerEnvPath);
  const startupTimeoutMs = config.worker.service.startupTimeoutSeconds * 1_000;
  // Mirror the kernel's precedence (explicit option, then per-start settings)
  // when bounding the individual readiness probe against the start deadline.
  const effectiveStartupTimeoutMs = worker.startupTimeoutMs ?? startupTimeoutMs;
  return {
    ...settings,
    startupTimeoutMs,
    command: settings.runtimePath,
    args: ['--no-env-file', settings.executablePath, '__worker-service-run', settings.instanceId],
    endpointOccupied: await workerEndpointIsOccupied(worker.fetchWorker, settings.readinessUrl),
    readinessProbe: () => authenticatedReadinessProbe(
      worker.fetchWorker,
      settings.readinessUrl,
      settings.authToken,
      settings.instanceId,
      Math.min(READINESS_PROBE_TIMEOUT_MS, Math.max(effectiveStartupTimeoutMs, 1)),
    ),
  };
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
    throw new NativeProcessConfigurationError(
      `Gateway-managed Olympus workers do not support explicit sourceIndex.${unsupported[0]} plugin config; configure source scope through the worker environment.`,
    );
  }
}

function workerLaunchSettings(
  config: OlympusConfig,
  moduleUrl: string,
  workerEnvPath?: string,
): Omit<WorkerLaunchSettings, 'command' | 'args' | 'endpointOccupied' | 'readinessProbe' | 'startupTimeoutMs'> {
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
    throw new NativeProcessConfigurationError(
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
  env[NATIVE_CAPTURE_OWNER_ENV_NAMES.telegram] = String(config.worker.telegramCapture.enabled);
  env[NATIVE_CAPTURE_OWNER_ENV_NAMES.whatsapp] = String(config.worker.whatsappCapture.enabled);
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
  const timeout = setTimeout(() => controller.abort(), ENDPOINT_OCCUPANCY_TIMEOUT_MS);
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Capture may start only after this Gateway owns the exact worker endpoint. */
export async function waitForNativeWorkerOwnership(
  isReady: (() => boolean) | undefined,
  timeoutMs = 15_000,
): Promise<void> {
  if (!isReady) throw new NativeProcessConfigurationError('Native capture requires native-worker ownership proof.');
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    if (isReady()) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  } while (Date.now() <= deadline);
  throw new NativeProcessConfigurationError('Native worker is not ready or does not own its endpoint; native capture was not started.');
}
