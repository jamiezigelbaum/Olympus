// Distinct local names: see core/remote-access.ts (keeps the dist/ diff small).
import { randomUUID as relayRandomUUID } from 'node:crypto';
import { statSync as relayStatSync } from 'node:fs';
import { isAbsolute as relayIsAbsolute } from 'node:path';
import { fileURLToPath as relayFileURLToPath } from 'node:url';
import { configFromPluginConfig, type OlympusConfig } from './config.ts';
import {
  createNativeProcessService,
  NativeProcessConfigurationError,
  type NativeProcessServiceDefinition,
  type NativeProcessStartSettings,
} from './native-process-service.ts';
import { resolveBunRuntimePath } from './native-worker-service.ts';
import {
  emptyRemoteAccessStatus,
  loopbackWorkerOrigin,
  readRemoteAccessStatus,
  remoteAccessDir,
  resolveRemoteAccessMode,
  writeRemoteAccessStatus,
  type RemoteAccessStatusFile,
} from './remote-access.ts';
import { REMOTE_PUBLIC_BASE_URL_ENV } from './remote-public-url.ts';
import { applyWorkerSetupEnv } from './worker-auth.ts';

const SERVICE_ID = 'olympus-remote-relay';
const SERVICE_LABEL = 'remote relay';
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
/** Only what the child needs: it handles internet traffic and gets no credentials. */
const CHILD_ENV_PASSTHROUGH = ['HOME', 'XDG_DATA_HOME', 'PATH', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'] as const;

export interface NativeRelayServiceOptions {
  initialPluginConfig: unknown;
  moduleUrl: string;
  /** Test seam; production runs the packaged cli.js beside this bundle. */
  executablePath?: string;
  /** Test seam; production reads worker.env from its default path. */
  workerEnvPath?: string;
  /** Test seam: extra child environment (the fake relay's address and CA). */
  childEnv?: Record<string, string>;
  startupTimeoutMs?: number;
  readinessPollMs?: number;
  stopGraceMs?: number;
  restartDelaysMs?: readonly number[];
}

interface RelayLaunchSettings extends NativeProcessStartSettings {
  statusDir: string;
  instanceId: string;
}

/**
 * Supervise the connect-relay client as a native service, next to the worker.
 *
 * The relay runs in its own Bun child (`olympus __relay-service-run`), not in
 * the Gateway: it terminates internet TLS and parses HTTP from hosted agents,
 * so a fault there must not take the Gateway down, and the child gets no
 * Gateway or worker credentials. The shared process kernel owns the lifecycle
 * (generation fencing, bounded restart backoff, process-group cleanup, health).
 *
 * This adapter owns the remote-access decision. Every start (initial, config
 * reload of `remote.*`, or `email.baseUrl`) writes status.json first, so the
 * CLI and worker always see the current mode (`off` writes only over an
 * earlier state): `off` and `manual` start no
 * child; a conflict is reported to host health by name and starts nothing;
 * `relay` starts the child, which is ready once it has written its own status
 * for this exact instance and pid. Stop clears the public base URL if the
 * child could not.
 */
export function createNativeRelayService(options: NativeRelayServiceOptions): NativeProcessServiceDefinition {
  let lastStatusDir: string | undefined;
  let lastInstanceId: string | undefined;
  const service = createNativeProcessService<RelayLaunchSettings>({
    id: SERVICE_ID,
    label: SERVICE_LABEL,
    reload: {
      configPrefixes: [
        'plugins.entries.olympus.config.remote',
        'plugins.entries.olympus.config.email.baseUrl',
        'plugins.entries.olympus.config.worker.service',
      ],
    },
    initialConfig: options.initialPluginConfig,
    ...(options.startupTimeoutMs !== undefined ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    ...(options.readinessPollMs !== undefined ? { readinessPollMs: options.readinessPollMs } : {}),
    ...(options.stopGraceMs !== undefined ? { stopGraceMs: options.stopGraceMs } : {}),
    ...(options.restartDelaysMs ? { restartDelaysMs: options.restartDelaysMs } : {}),
    defaultStartupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    prepareStart: async (input) => {
      const settings = prepareRelayStart(relayFreshConfig(input.context.config, input.initialConfig), options);
      lastStatusDir = settings.statusDir;
      lastInstanceId = settings.launch?.instanceId;
      return settings.launch;
    },
  });
  return {
    ...service,
    async stop() {
      await service.stop();
      clearStalePublicUrl(lastStatusDir, lastInstanceId);
    },
  };
}

function prepareRelayStart(
  config: OlympusConfig,
  options: NativeRelayServiceOptions,
): { statusDir: string; launch: RelayLaunchSettings | undefined } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  applyWorkerSetupEnv({ env, ...(options.workerEnvPath ? { workerEnvPath: options.workerEnvPath } : {}) });
  const statusDir = remoteAccessDir(env);
  const mode = resolveRemoteAccessMode(config.remote);
  const localUrl = workerOrigin(config, env);
  const status = (next: Partial<RemoteAccessStatusFile> & Pick<RemoteAccessStatusFile, 'mode'>): RemoteAccessStatusFile => ({
    ...emptyRemoteAccessStatus(next.mode),
    local_url: localUrl ?? null,
    ...next,
  });
  const fail = (error: string, statusMode: RemoteAccessStatusFile['mode']): never => {
    writeRemoteAccessStatus(statusDir, status({ mode: statusMode, error }));
    throw new NativeProcessConfigurationError(`Olympus remote access is off: ${error}`);
  };

  if (mode.mode === 'off') {
    // Clear what an earlier mode reported; an install that never turned remote
    // access on gets no state directory at all.
    if (readRemoteAccessStatus(statusDir)) writeRemoteAccessStatus(statusDir, status({ mode: 'off' }));
    return { statusDir, launch: undefined };
  }
  if (mode.mode === 'error') return fail(mode.error, 'off');
  const statusMode = mode.mode;
  if (env[REMOTE_PUBLIC_BASE_URL_ENV]?.trim()) {
    return fail(
      `${REMOTE_PUBLIC_BASE_URL_ENV} in worker.env already sets the public address, which conflicts with plugin config remote.*. Remove it from worker.env, or turn remote.enabled off.`,
      statusMode,
    );
  }
  if (mode.mode === 'manual') {
    writeRemoteAccessStatus(statusDir, status({ mode: 'manual', public_base_url: mode.publicBaseUrl }));
    return { statusDir, launch: undefined };
  }
  if (!localUrl) {
    return fail('the relay forwards only to a loopback http worker; email.baseUrl is not one.', 'relay');
  }
  const instanceId = relayRandomUUID();
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_PASSTHROUGH) if (env[name]) childEnv[name] = env[name];
  Object.assign(childEnv, options.childEnv ?? {}, {
    OLYMPUS_RELAY_HOST: mode.relayHost,
    OLYMPUS_RELAY_TARGET: localUrl,
    OLYMPUS_NATIVE_SERVICE_INSTANCE_ID: instanceId,
  });
  let command: string;
  let executablePath: string;
  try {
    command = resolveBunRuntimePath(config.worker.service.runtimePath, env);
    executablePath = resolveExecutablePath(options.executablePath ?? relayFileURLToPath(new URL('./cli.js', options.moduleUrl)));
  } catch {
    return fail('the Bun runtime or the packaged Olympus CLI could not be found.', 'relay');
  }
  // Written before spawn so the CLI shows `starting` at once; the child's own
  // write (same instance, its pid) is the readiness receipt.
  writeRemoteAccessStatus(statusDir, status({
    mode: 'relay',
    relay_host: mode.relayHost,
    instance_id: instanceId,
    relay: { state: 'starting', reason: null, retry_in_ms: null },
  }));
  return {
    statusDir,
    launch: {
      command,
      args: ['--no-env-file', executablePath, '__relay-service-run', instanceId],
      env: childEnv,
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      endpointOccupied: false,
      statusDir,
      instanceId,
      readinessProbe: async (child) => {
        const reported = readRemoteAccessStatus(statusDir);
        return reported?.instance_id === instanceId && reported.pid === child.pid;
      },
    },
  };
}

/**
 * The worker the relay forwards to, as the worker itself binds it: a
 * Gateway-managed worker listens on `email.baseUrl`; a worker run from
 * worker.env listens on its OLYMPUS_EMAIL_SOURCE_HOST/PORT.
 */
function workerOrigin(config: OlympusConfig, env: NodeJS.ProcessEnv): string | undefined {
  if (!config.worker.service.enabled) {
    const port = env.OLYMPUS_EMAIL_SOURCE_PORT?.trim();
    if (port && /^\d{1,5}$/.test(port)) {
      const host = env.OLYMPUS_EMAIL_SOURCE_HOST?.trim() || '127.0.0.1';
      return loopbackWorkerOrigin(`http://${host === '::1' ? '[::1]' : host}:${port}`);
    }
  }
  return loopbackWorkerOrigin(config.email.baseUrl);
}

function clearStalePublicUrl(statusDir: string | undefined, instanceId: string | undefined): void {
  if (!statusDir || !instanceId) return;
  try {
    const status = readRemoteAccessStatus(statusDir);
    if (!status || status.instance_id !== instanceId) return;
    if (status.public_base_url === null && status.relay?.state === 'stopped') return;
    writeRemoteAccessStatus(statusDir, {
      ...status,
      updated_at: new Date().toISOString(),
      public_base_url: null,
      relay: { state: 'stopped', reason: null, retry_in_ms: null },
    });
  } catch {
    // Advisory: a stale URL only advertises an address the relay refuses.
  }
}

function resolveExecutablePath(path: string): string {
  if (!relayIsAbsolute(path) || !relayStatSync(path).isFile()) throw new Error('Olympus CLI is unavailable.');
  return path;
}

function relayFreshConfig(contextConfig: unknown, initialPluginConfig: unknown): OlympusConfig {
  const root = relayConfigRecord(contextConfig);
  const entries = relayConfigRecord(relayConfigRecord(root?.plugins)?.entries);
  const olympus = relayConfigRecord(entries?.olympus);
  let pluginConfig: unknown;
  if (entries) {
    // A removed plugin entry disables remote access instead of resurrecting
    // the registration snapshot.
    pluginConfig = olympus && Object.prototype.hasOwnProperty.call(olympus, 'config') ? olympus.config : undefined;
  } else if (root && ['remote', 'worker', 'email', 'sourceIndex', 'argus', 'identity', 'sovereignty']
    .some((key) => Object.prototype.hasOwnProperty.call(root, key))) {
    pluginConfig = root;
  } else {
    pluginConfig = initialPluginConfig;
  }
  try {
    return configFromPluginConfig(pluginConfig, { requireResolvedWorkerSecrets: false });
  } catch {
    throw new NativeProcessConfigurationError('Olympus remote access could not read the plugin configuration.');
  }
}

function relayConfigRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
