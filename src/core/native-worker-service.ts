import { homedir } from 'node:os';
import { createStartupWatch, startupCapMs } from './engine-heartbeat.ts';
import { olympusStoreBytes } from './upgrade-store-copies.ts';
import { quoteCliArgument, readWorkerCliLauncher, renderWorkerCliLauncher, workerCliLauncherPath, writeWorkerCliLauncher } from './worker-cli-launcher.ts';
import { WORKER_DATA_OWNER_BUSY_EXIT_CODE } from './data-owner-lock.ts';
import { OWNER_BRIDGE_HOST_ENV } from './linux-owner-bridge-host.ts';
import { createUnixSocketFetch, removeReleasedWorkerSocket, validateWorkerSocket, WORKER_LISTEN_SOCKET_ENV, workerSocketListenerStopped, workerFetch } from './worker-transport.ts';
import { clearLeftFrontSocket } from './worker-front-proxy.ts';
import { ENGINE_BACKGROUND_SOCKET_ENV, ENGINE_ROLE_ENV, engineBackgroundSocketPath, prepareEngineBackgroundSocketDirectory, probeEngineBackground } from './engine-split.ts';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { descendantGroupsPath } from './descendant-groups.ts';
import { statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromPluginConfig, NATIVE_REMOTE_CONFIG_ENV, type OlympusConfig } from './config.ts';
import {
  createNativeProcessService,
  NativeProcessConfigurationError,
  NativeProcessRetryableStartError,
  type NativeProcessServiceContext,
  type NativeProcessServiceDefinition,
  type NativeProcessServiceHealth,
  type NativeProcessStartInput,
  type NativeProcessStartSettings,
} from './native-process-service.ts';
import { NATIVE_CAPTURE_OWNER_ENV_NAMES } from './olympus-layout.ts';
import { applyWorkerSetupEnv, workerAuthTokenFromConfig } from './worker-auth.ts';

export const WORKER_DATA_OWNER_CONFLICT_MESSAGE = 'Olympus worker cannot start because another process owns its data. Run olympus worker uninstall to remove an older worker service; otherwise stop the competing Olympus process. Retrying automatically.';

export const WORKER_ENDPOINT_CONFLICT_MESSAGE = 'Olympus worker cannot start because another process owns its endpoint. Run olympus worker uninstall to remove an older worker service; otherwise stop the competing process. Retrying automatically.';

export const WORKER_SOCKET_RETAINED_MESSAGE = 'Olympus worker cannot start because a stopped worker left its socket behind. Run olympus worker uninstall, then olympus engine restart to safely clear the retained socket. The socket is kept until process and listener custody are verified.';

const SERVICE_ID = 'olympus-worker';
const SERVICE_LABEL = 'worker';
const READINESS_PROBE_TIMEOUT_MS = 1_000;
const ENDPOINT_OCCUPANCY_TIMEOUT_MS = 250;
const DEFAULT_WORKER_STARTUP_TIMEOUT_MS = 10_000;
/**
 * The worker's readiness proves it is listening, not that it stays up. A
 * worker that crashes or reloads again within this long keeps climbing the
 * restart backoff instead of restarting at the first delay every time.
 */
const DEFAULT_WORKER_STABLE_UPTIME_MS = 30_000;

// Defined with the layout, whose placement predicate pins a natively owned account.
export { NATIVE_CAPTURE_OWNER_ENV_NAMES };

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
  /** How long a ready worker must stay up before restart backoff resets. */
  stableUptimeMs?: number;
  fetch?: typeof fetch;
  /** Test seam; production always uses applyWorkerSetupEnv's default path. */
  workerEnvPath?: string;
  /** Test seam; production inherits the Gateway working directory. */
  workingDirectory?: string;
  ownerBridgeHostSocket?: string;
  /** Set only by the engine host: this worker is the standalone engine's own, not a gateway's. */
  engineHosted?: boolean;
  /** The home that holds ~/.local/bin/olympus; tests pass a temporary one. */
  homeDir?: string;
  /**
   * The engine split (core/engine-split.ts), set by a host that registered a
   * background service: with `worker.engineSplit` on this worker is the
   * front and starts only once that background is ready. With the switch
   * off it runs as the one worker, exactly as without this option.
   */
  engineBackground?: { isReady(): boolean };
  /**
   * Linux under the engine host with the split on: the host holds the worker
   * socket and pipes it here (worker-front-proxy.ts), so the worker binds
   * front.sock, and its occupancy and readiness are checked there.
   */
  frontSocket?: string;
  /** Test seams for the front's wait for its background. */
  engineBackgroundWaitMs?: number;
  engineBackgroundPollMs?: number;
}

/** The front's start while the background engine is not ready yet; the host retries. */
export const WORKER_BACKGROUND_STARTING_MESSAGE = 'Olympus worker is waiting for its background engine, which is starting.';
const DEFAULT_ENGINE_BACKGROUND_WAIT_MS = 30_000;

/**
 * Who supervises the worker, set after worker.env is loaded so neither it nor an
 * inherited environment can claim the engine. Engine-only startup work (the 1.0.0
 * privacy policy migration) reads this instead of the ambient engine markers.
 */
export const WORKER_SUPERVISOR_ENV = 'OLYMPUS_WORKER_SUPERVISOR';

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
  const fetchWorker = options.fetch ?? (options.frontSocket ? createUnixSocketFetch(options.frontSocket) : workerFetch);
  const service = createNativeProcessService<WorkerLaunchSettings>({
    id: SERVICE_ID,
    label: SERVICE_LABEL,
    retryInitialStartFailure: true,
    // Under the standalone engine, the extraction commands a worker that died
    // or restarted itself left running are stopped before its replacement
    // starts (native-process-service.ts, descendantGroupsPath).
    ...(options.engineHosted ? { descendantGroupsPath: descendantGroupsPath(SERVICE_ID) } : {}),
    reload: {
      configPrefixes: [
        'plugins.entries.olympus.config.worker',
        'plugins.entries.olympus.config.email.baseUrl',
        'plugins.entries.olympus.config.sourceIndex',
        'plugins.entries.olympus.config.sovereignty',
        // Only the demo sign-in is read by the worker; remote.enabled and the
        // relay address belong to the relay service, and restarting the worker
        // on the dashboard's own remote-access toggle would drop the dashboard.
        'plugins.entries.olympus.config.remote.demoConsent',
      ],
    },
    initialConfig: options.initialPluginConfig,
    ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
    ...(options.startupTimeoutMs !== undefined ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    ...(options.readinessPollMs !== undefined ? { readinessPollMs: options.readinessPollMs } : {}),
    ...(options.stopGraceMs !== undefined ? { stopGraceMs: options.stopGraceMs } : {}),
    ...(options.restartDelaysMs ? { restartDelaysMs: options.restartDelaysMs } : {}),
    defaultStartupTimeoutMs: DEFAULT_WORKER_STARTUP_TIMEOUT_MS,
    stableUptimeMs: options.stableUptimeMs ?? DEFAULT_WORKER_STABLE_UPTIME_MS,
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
      delete settings.env[ENGINE_ROLE_ENV];
      delete settings.env[ENGINE_BACKGROUND_SOCKET_ENV];
      if (options.engineBackground && freshConfig(input.context.config, input.initialConfig).config.worker.engineSplit) {
        // The front serves only after the background has done the boot work
        // that needs the data root to itself (design, part 3).
        if (!await waitUntil(options.engineBackground.isReady, options.engineBackgroundWaitMs ?? DEFAULT_ENGINE_BACKGROUND_WAIT_MS, options.engineBackgroundPollMs ?? 100)) {
          throw new NativeProcessRetryableStartError(WORKER_BACKGROUND_STARTING_MESSAGE);
        }
        settings.env[ENGINE_ROLE_ENV] = 'front';
        settings.env[ENGINE_BACKGROUND_SOCKET_ENV] = engineBackgroundSocketPath({ env: settings.env });
      }
      if (options.frontSocket) {
        // The kernel starts no worker over a live one: a socket left here is the last one's.
        clearLeftFrontSocket(options.frontSocket);
        settings.env[WORKER_LISTEN_SOCKET_ENV] = options.frontSocket;
      } else delete settings.env[WORKER_LISTEN_SOCKET_ENV];
      if (options.ownerBridgeHostSocket) settings.env[OWNER_BRIDGE_HOST_ENV] = options.ownerBridgeHostSocket;
      else delete settings.env[OWNER_BRIDGE_HOST_ENV];
      settings.env[WORKER_SUPERVISOR_ENV] = options.engineHosted ? 'engine' : 'gateway';
      const probe = settings.readinessProbe;
      return {
        ...settings,
        async readinessProbe(child) {
          const ready = await probe(child);
          if (ready && generation === proofGeneration) {
            // A managed OpenClaw update may move the plugin package without
            // rerunning setup. Publish only after this CLI has proved healthy;
            // a failed start leaves the last healthy launcher's target intact.
            if (!options.engineHosted && readyChild !== child && (process.platform === 'linux' || process.platform === 'darwin')) {
              const home = options.homeDir ?? homedir();
              let command = [settings.runtimePath, settings.executablePath].map(quoteCliArgument).join(' ');
              try {
                writeWorkerCliLauncher(home, renderWorkerCliLauncher(settings.runtimePath, settings.executablePath));
                if (readWorkerCliLauncher(home) !== null) command = quoteCliArgument(workerCliLauncherPath(home));
              } catch (error) {
                input.context.logger?.warn?.(`Olympus CLI launcher could not be installed: ${error instanceof Error ? error.message : String(error)}`);
              }
              input.context.logger?.info?.(`On the machine running Olympus, run ${command} dashboard.`);
            }
            readyChild = child;
          }
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
  const endpointOccupied=await workerEndpointIsOccupied(worker.fetchWorker,settings.readinessUrl);
  if (endpointOccupied) throw new NativeProcessRetryableStartError(WORKER_ENDPOINT_CONFLICT_MESSAGE);
  if(process.platform==='linux'&&worker.fetchWorker===workerFetch&&!endpointOccupied&&input.previousChildReleased){
    removeReleasedWorkerSocket({platform:'linux',env:settings.env},{previousWorkerReleased:true});
  }
  if (process.platform === 'linux' && worker.fetchWorker === workerFetch) {
    let socket: string | undefined;
    try { socket = validateWorkerSocket({platform: 'linux', env: settings.env}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (socket && workerSocketListenerStopped(socket) === true) {
      throw new NativeProcessRetryableStartError(WORKER_SOCKET_RETAINED_MESSAGE);
    }
  }
  return {
    ...settings,
    startupTimeoutMs,
    command: settings.runtimePath,
    args: ['--no-env-file', settings.executablePath, '__worker-service-run', settings.instanceId],
    endpointOccupied,
    startupFailure: child => child.exitCode === WORKER_DATA_OWNER_BUSY_EXIT_CODE
      ? new NativeProcessRetryableStartError(WORKER_DATA_OWNER_CONFLICT_MESSAGE) : undefined,
    startupInProgress: startupWatch(settings.env),
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

/**
 * The environment the Gateway launches the worker with: the Gateway's own, then
 * worker.env beneath it (an ambient value wins), then the plugin config's
 * settings. The one place it is built; the native capture services resolve
 * their account's layout from this same environment (a worker that finds its
 * account in one data folder and a capture child that looks in another would
 * pair a session the child cannot see).
 */
export function nativeWorkerEnvironment(config: OlympusConfig, workerEnvPath?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  applyWorkerSetupEnv({ env, ...(workerEnvPath ? { workerEnvPath } : {}) });
  stripGatewayBootstrapSecrets(env);
  for (const [name, value] of Object.entries(config.worker.service.credentials)) env[name] = value;
  if (config.worker.authToken) env.OLYMPUS_WORKER_AUTH_TOKEN = config.worker.authToken;
  applyNativeWorkerConfigEnv(config, env);
  return env;
}

function workerLaunchSettings(
  config: OlympusConfig,
  moduleUrl: string,
  workerEnvPath?: string,
): Omit<WorkerLaunchSettings, 'command' | 'args' | 'endpointOccupied' | 'readinessProbe' | 'startupTimeoutMs'> {
  const service = config.worker.service;
  const env = nativeWorkerEnvironment(config, workerEnvPath);
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
  // The plugin config is the only source of remote settings here: a value
  // inherited from the Gateway or worker.env never survives into the child.
  if (config.remote) env[NATIVE_REMOTE_CONFIG_ENV] = JSON.stringify(config.remote);
  else delete env[NATIVE_REMOTE_CONFIG_ENV];
}

export function resolveBunRuntimePath(configured: string | undefined, env: NodeJS.ProcessEnv): string {
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

async function waitUntil(condition: () => boolean, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(pollMs, deadline - Date.now()))));
  }
}

export const ENGINE_BACKGROUND_SERVICE_ID = 'olympus-worker-background';

export interface NativeEngineBackgroundServiceOptions {
  initialPluginConfig: unknown;
  moduleUrl: string;
  startupTimeoutMs?: number;
  readinessPollMs?: number;
  stopGraceMs?: number;
  restartDelaysMs?: readonly number[];
  stableUptimeMs?: number;
  workerEnvPath?: string;
  workingDirectory?: string;
  engineHosted?: boolean;
  /** Test seam: the fetch the readiness probe uses, given the socket path. */
  fetchForSocket?: (socketPath: string) => typeof fetch;
}

/**
 * How the background is launched and when it is ready, whoever supervises it
 * (the engine host, the Gateway, or the worker service's own unit,
 * worker-service-split.ts): the role and socket in its environment, a busy
 * data owner as a retryable start, and ready once its command socket answers
 * for this exact instance with its boot work done.
 */
export function engineBackgroundLaunch(input: {
  env: NodeJS.ProcessEnv;
  socketPath: string;
  authToken: string;
  instanceId: string;
  command: string;
  args: readonly string[];
  startupTimeoutMs: number;
  probeTimeoutMs: number;
  fetchForSocket?: (socketPath: string) => typeof fetch;
  onReady?: (child: ChildProcess) => void;
}): NativeProcessStartSettings {
  input.env[ENGINE_ROLE_ENV] = 'background';
  input.env[ENGINE_BACKGROUND_SOCKET_ENV] = input.socketPath;
  const fetchBackground = input.fetchForSocket ? input.fetchForSocket(input.socketPath) : createUnixSocketFetch(input.socketPath);
  return {
    command: input.command,
    args: input.args,
    env: input.env,
    startupTimeoutMs: input.startupTimeoutMs,
    endpointOccupied: false,
    startupFailure: child => child.exitCode === WORKER_DATA_OWNER_BUSY_EXIT_CODE
      ? new NativeProcessRetryableStartError(WORKER_DATA_OWNER_CONFLICT_MESSAGE) : undefined,
    startupInProgress: startupWatch(input.env),
    async readinessProbe(child) {
      const ready = await probeEngineBackground(fetchBackground, input.authToken, input.instanceId, input.probeTimeoutMs);
      if (ready) input.onReady?.(child);
      return ready;
    },
  };
}

/** One start watch per environment's data root: a live child is waited for until the cap. */
function startupWatch(env: NodeJS.ProcessEnv): (child: ChildProcess) => boolean {
  let capMs: number | undefined;
  const watch = createStartupWatch({
    env,
    capMs: () => (capMs ??= startupCapMs(storeBytesOrZero(env))),
  });
  return (child) => watch(child.pid);
}

function storeBytesOrZero(env: NodeJS.ProcessEnv): number {
  try { return olympusStoreBytes(env); } catch { return 0; }
}

/**
 * The engine split's background process (core/engine-split.ts): the same
 * packaged worker with ENGINE_ROLE_ENV=background, supervised like the
 * worker (restart on exit with backoff, process-group cleanup). It serves no
 * HTTP port, so there is no endpoint check; it is ready when its private
 * command socket answers for this exact instance with its boot work done.
 * With `worker.engineSplit` off it starts nothing.
 */
export function createNativeEngineBackgroundService(options: NativeEngineBackgroundServiceOptions): NativeWorkerServiceDefinition & { isReady(): boolean } {
  let readyChild: ChildProcess | undefined;
  let proofGeneration = 0;
  const invalidate = () => { proofGeneration += 1; readyChild = undefined; };
  const service = createNativeProcessService<WorkerLaunchSettings>({
    id: ENGINE_BACKGROUND_SERVICE_ID,
    label: 'background engine',
    retryInitialStartFailure: true,
    ...(options.engineHosted ? { descendantGroupsPath: descendantGroupsPath(ENGINE_BACKGROUND_SERVICE_ID) } : {}),
    reload: {
      configPrefixes: [
        'plugins.entries.olympus.config.worker',
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
    stableUptimeMs: options.stableUptimeMs ?? DEFAULT_WORKER_STABLE_UPTIME_MS,
    prepareStart: async (input) => {
      invalidate();
      const generation = proofGeneration;
      const fresh = freshConfig(input.context.config, input.initialConfig);
      const config = fresh.config;
      if (!config.worker.service.enabled || !config.worker.engineSplit) return undefined;
      assertNativeWorkerScopeConfigSupported(fresh.pluginConfig);
      const settings = workerLaunchSettings(config, options.moduleUrl, options.workerEnvPath);
      const socketPath = engineBackgroundSocketPath({ env: settings.env });
      prepareEngineBackgroundSocketDirectory(socketPath);
      settings.env[WORKER_SUPERVISOR_ENV] = options.engineHosted ? 'engine' : 'gateway';
      const startupTimeoutMs = config.worker.service.startupTimeoutSeconds * 1_000;
      const effective = options.startupTimeoutMs ?? startupTimeoutMs;
      return {
        ...settings,
        ...engineBackgroundLaunch({
          env: settings.env,
          socketPath,
          authToken: settings.authToken,
          instanceId: settings.instanceId,
          command: settings.runtimePath,
          args: ['--no-env-file', settings.executablePath, '__worker-service-run', settings.instanceId],
          startupTimeoutMs,
          probeTimeoutMs: Math.min(READINESS_PROBE_TIMEOUT_MS, Math.max(effective, 1)),
          ...(options.fetchForSocket ? { fetchForSocket: options.fetchForSocket } : {}),
          onReady: (child) => { if (generation === proofGeneration) readyChild = child; },
        }),
      };
    },
  });
  return {
    ...service,
    isReady() {
      return Boolean(readyChild?.pid && readyChild.exitCode === null
        && readyChild.signalCode === null && !readyChild.killed);
    },
    async start(context) { invalidate(); await service.start(context); },
    async stop() { invalidate(); await service.stop(); },
  };
}
