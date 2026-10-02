/**
 * The standalone engine host: what `olympus __engine-run` runs under the
 * per-user LaunchAgent (core/engine-service.ts).
 *
 * It stands in for the OpenClaw Gateway's service host and nothing more. The
 * same native service adapters the plugin registers (worker, remote relay,
 * embedding drain) are created here with engine.json as their plugin config,
 * started, and stopped on SIGTERM. Supervision (readiness, restart backoff,
 * process-group cleanup) stays in the shared kernel, so a standalone install
 * and an OpenClaw install run the exact same children.
 *
 * Telegram and WhatsApp capture, the Venice credit monitor and transcription
 * cleanup are not hosted here yet: they are OpenClaw-era optional services,
 * none of them on the ChatGPT journey.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { configFromPluginConfig } from './config.ts';
import {
  engineChildrenPath,
  engineChildrenRecorder,
  reapRecordedEngineChildren,
  type EngineChildReapDeps,
} from './engine-children.ts';
import { ENGINE_BUILD_ENV, enginePaths, engineStatusPath, readEngineConfig } from './engine-service.ts';
import { createNativeEmbeddingDrainService } from './native-embedding-drain-service.ts';
import {
  backgroundNativeProcessService,
  setNativeProcessChildObserver,
  setNativeProcessChildStdio,
  type NativeProcessServiceContext,
  type NativeProcessServiceDefinition,
} from './native-process-service.ts';
import { createNativeRelayService } from './native-relay-service.ts';
import { createNativeWorkerService } from './native-worker-service.ts';
import { resolveRemoteAccessMode } from './remote-access.ts';

export const ENGINE_STATUS_SCHEMA = 'olympus.engine.status.v1';
/** EX_CONFIG: launchd's throttle keeps a misconfigured engine from spinning. */
const EXIT_CONFIG = 78;
const STOP_DEADLINE_MS = 15_000;

export interface EngineServiceHealth {
  state: 'off' | 'starting' | 'ok' | 'failing' | 'stopped';
  message: string | null;
  updated_at: string;
}

export interface EngineStatusFile {
  schema: typeof ENGINE_STATUS_SCHEMA;
  pid: number;
  started_at: string;
  updated_at: string;
  state: 'running' | 'stopping' | 'stopped';
  /** The build launchd started (OLYMPUS_ENGINE_BUILD); install compares it to restart a stale host. */
  build: string | null;
  remote_mode: string;
  services: Record<string, EngineServiceHealth>;
}

export { engineStatusPath } from './engine-service.ts';

export interface EngineHostOptions {
  moduleUrl: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** Test seams. */
  services?: (pluginConfig: Record<string, unknown>) => NativeProcessServiceDefinition[];
  log?: (line: string) => void;
  exit?: (code: number) => void;
  installSignalHandlers?: boolean;
  /** Test seam for the stale child-group cleanup that runs before any service starts. */
  reap?: EngineChildReapDeps;
}

export interface EngineHostHandle {
  stop(): Promise<void>;
  status(): EngineStatusFile;
}

export function engineHostServices(pluginConfig: Record<string, unknown>, moduleUrl: string): NativeProcessServiceDefinition[] {
  const { isReady: _workerIsReady, ...worker } = createNativeWorkerService({ initialPluginConfig: pluginConfig, moduleUrl });
  return [
    backgroundNativeProcessService(worker),
    backgroundNativeProcessService(createNativeRelayService({ initialPluginConfig: pluginConfig, moduleUrl })),
    backgroundNativeProcessService(createNativeEmbeddingDrainService({ initialPluginConfig: pluginConfig, moduleUrl })),
  ];
}

export async function startEngineHost(options: EngineHostOptions): Promise<EngineHostHandle | undefined> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const homeDir = options.homeDir ?? env.HOME ?? '';
  const paths = enginePaths(homeDir);

  let pluginConfig: Record<string, unknown> | undefined;
  let remoteMode = 'off';
  let enabled: Record<string, boolean> = {};
  try {
    pluginConfig = readEngineConfig(paths.configPath);
    if (pluginConfig) {
      const parsed = configFromPluginConfig(pluginConfig, { requireResolvedWorkerSecrets: false });
      remoteMode = resolveRemoteAccessMode(parsed.remote).mode;
      // Services whose config turns them off start nothing and report nothing;
      // say so instead of leaving them "starting".
      enabled = {
        'olympus-worker': parsed.worker.service.enabled,
        'olympus-remote-relay': remoteMode !== 'off',
        'olympus-source-embedding-drain': parsed.worker.embeddingDrain.enabled,
      };
    }
  } catch (error) {
    log(`engine: ${paths.configPath} could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
    exit(EXIT_CONFIG);
    return undefined;
  }
  if (!pluginConfig) {
    log(`engine: no ${paths.configPath}; run olympus engine install.`);
    exit(EXIT_CONFIG);
    return undefined;
  }

  // launchd already points this process's stdout/stderr at the engine logs;
  // the children write there too instead of nowhere.
  setNativeProcessChildStdio('inherit');

  // A previous host that died without stopping its children (they run in
  // their own process groups) left them holding the worker port and the data
  // root: stop the ones that are provably ours before starting new ones, then
  // record each group this host starts.
  const dataEnv = { ...env, HOME: homeDir };
  const childrenPath = engineChildrenPath(dataEnv);
  const reaped = reapRecordedEngineChildren(childrenPath, options.reap);
  if (reaped.stopped.length > 0) {
    log(`engine: stopped ${reaped.stopped.length} process group(s) a previous engine left running (${reaped.stopped.map((child) => child.service).join(', ')}).`);
  }
  setNativeProcessChildObserver(engineChildrenRecorder({ path: childrenPath }));

  const now = () => new Date().toISOString();
  const status: EngineStatusFile = {
    schema: ENGINE_STATUS_SCHEMA,
    pid: process.pid,
    started_at: now(),
    updated_at: now(),
    state: 'running',
    build: env[ENGINE_BUILD_ENV]?.trim() || null,
    remote_mode: remoteMode,
    services: {},
  };
  const statusPath = engineStatusPath(dataEnv);
  const writeStatus = () => {
    status.updated_at = now();
    try {
      mkdirSync(join(statusPath, '..'), { recursive: true, mode: 0o700 });
      writePrivateFileAtomicSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
    } catch {
      // Advisory: olympus engine status falls back to launchctl alone.
    }
  };

  const services = (options.services ?? ((config) => engineHostServices(config, options.moduleUrl)))(pluginConfig);
  const contextFor = (id: string): NativeProcessServiceContext => ({
    // The shape the Gateway hands its services: the services read
    // plugins.entries.olympus.config, exactly as from openclaw.json.
    config: { plugins: { entries: { olympus: { config: pluginConfig } } } },
    logger: {
      info: (message) => log(`${id}: ${message}`),
      warn: (message) => log(`${id}: ${message}`),
    },
    serviceHealth: {
      reportFailure(error) {
        const message = error.message;
        status.services[id] = {
          state: /is starting\.$/.test(message) ? 'starting' : 'failing',
          message,
          updated_at: now(),
        };
        log(`${id}: ${message}`);
        writeStatus();
      },
      clearFailure() {
        status.services[id] = { state: 'ok', message: null, updated_at: now() };
        writeStatus();
      },
    },
  });

  log(`engine: starting (pid ${process.pid}, remote access ${remoteMode}).`);
  writeStatus();
  for (const service of services) {
    status.services[service.id] = { state: enabled[service.id] === false ? 'off' : 'starting', message: null, updated_at: now() };
    await service.start(contextFor(service.id));
  }
  writeStatus();

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      status.state = 'stopping';
      writeStatus();
      log('engine: stopping.');
      const deadline = new Promise<void>((resolve) => setTimeout(resolve, STOP_DEADLINE_MS).unref?.());
      await Promise.race([
        Promise.allSettled([...services].reverse().map((service) => service.stop())),
        deadline,
      ]);
      for (const [id, health] of Object.entries(status.services)) {
        if (health.state !== 'off') status.services[id] = { state: 'stopped', message: null, updated_at: now() };
      }
      status.state = 'stopped';
      writeStatus();
      setNativeProcessChildObserver(undefined);
      log('engine: stopped.');
    })();
    return stopping;
  };

  if (options.installSignalHandlers !== false) {
    const onSignal = () => { void stop().then(() => exit(0)); };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  }
  return { stop, status: () => structuredClone(status) };
}

/** `olympus __engine-run`: start the host and stay up until launchd stops it. */
export async function runEngineHostProcess(moduleUrl: string): Promise<void> {
  const handle = await startEngineHost({ moduleUrl });
  if (!handle) return;
  // The kernel's timers are unref'd; this keeps the host alive between restarts.
  setInterval(() => undefined, 60_000);
  await new Promise<never>(() => undefined);
}
