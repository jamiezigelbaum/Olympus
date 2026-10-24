import { nativeWorkerEnvironment, waitForNativeWorkerOwnership } from './native-worker-service.ts';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { configFromPluginConfig, type OlympusConfig } from './config.ts';
import {
  WHATSAPP_SOURCE_ID,
  accountRawPath,
  legacyWhatsAppServiceStateDir,
} from './olympus-layout.ts';
import { placedAccount } from './source-placement.ts';
import {
  createNativeProcessService,
  NativeProcessConfigurationError,
  type NativeProcessServiceDefinition,
  type NativeProcessStartInput,
  type NativeProcessStartSettings,
} from './native-process-service.ts';

const SERVICE_ID = 'olympus-whatsapp-capture';
const SERVICE_LABEL = 'WhatsApp capture service';
// The bridge owns bounded connection attempts and reconnect backoff. Keep its
// authenticated startup pending through an outage instead of killing that loop.
// Unpaired/corrupt sessions still exit promptly; stop always cancels this wait.
const DEFAULT_STARTUP_TIMEOUT_MS = Number.POSITIVE_INFINITY;
const READINESS_FILE = 'native-service-readiness.json';
const SESSION_FILE = 'session.db';

export interface NativeWhatsAppServiceOptions {
  initialPluginConfig: unknown;
  workerIsReady?: () => boolean;
  workerReadinessTimeoutMs?: number;
  startupTimeoutMs?: number;
  readinessPollMs?: number;
  stopGraceMs?: number;
  restartDelaysMs?: readonly number[];
  /** Test seam; production always uses applyWorkerSetupEnv's default path. */
  workerEnvPath?: string;
  /** Test seam; production inherits the Gateway working directory. */
  workingDirectory?: string;
}

interface WhatsAppLaunchSettings extends NativeProcessStartSettings {
  stateDir: string;
  instanceId: string;
}

/**
 * Supervise an operator-provisioned WhatsApp bridge without importing its
 * Bun-only store graph into the Gateway. Pairing remains a separate manual
 * operation; this service accepts only an existing session and waits for an
 * instance-bound authenticated readiness receipt.
 */
export function createNativeWhatsAppService(
  options: NativeWhatsAppServiceOptions,
): NativeProcessServiceDefinition {
  return createNativeProcessService<WhatsAppLaunchSettings>({
    id: SERVICE_ID,
    label: SERVICE_LABEL,
    reload: { configPrefixes: ['plugins.entries.olympus.config.worker', 'plugins.entries.olympus.config.email.baseUrl', 'plugins.entries.olympus.config.sourceIndex', 'plugins.entries.olympus.config.sovereignty'] },
    initialConfig: options.initialPluginConfig,
    defaultStartupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    ...(options.startupTimeoutMs !== undefined ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    ...(options.readinessPollMs !== undefined ? { readinessPollMs: options.readinessPollMs } : {}),
    ...(options.stopGraceMs !== undefined ? { stopGraceMs: options.stopGraceMs } : {}),
    ...(options.restartDelaysMs ? { restartDelaysMs: options.restartDelaysMs } : {}),
    ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
    prepareStart: (input) => prepareWhatsAppStart(input, options),
  });
}

async function prepareWhatsAppStart(
  input: NativeProcessStartInput<WhatsAppLaunchSettings>,
  options: NativeWhatsAppServiceOptions,
): Promise<WhatsAppLaunchSettings | undefined> {
  let config: OlympusConfig;
  try {
    config = configFromPluginConfig(freshPluginConfig(input.context.config, input.initialConfig));
  } catch {
    throw new NativeProcessConfigurationError(
      'Olympus WhatsApp capture service configuration is invalid.',
    );
  }
  const capture = config.worker.whatsappCapture;
  if (!capture.enabled) return undefined;
  if (!config.worker.service.enabled) {
    throw new NativeProcessConfigurationError(
      'Native whatsapp capture requires worker.service.enabled so the worker can enforce exclusive capture ownership.',
    );
  }
  await waitForNativeWorkerOwnership(
    options.workerIsReady,
    options.workerReadinessTimeoutMs ?? config.worker.service.startupTimeoutSeconds * 1_000 + 5_000,
  );

  if (!capture.binaryPath) {
    throw new NativeProcessConfigurationError(
      'Olympus WhatsApp capture service requires an absolute worker.whatsappCapture.binaryPath.',
    );
  }
  assertExecutableFile(capture.binaryPath);

  const env = baseEnvironment();
  const stateDir = captureStateDir(capture.stateDir, env, nativeWorkerEnvironment(config, options.workerEnvPath));
  assertUsableSession(join(stateDir, SESSION_FILE));

  const instanceId = randomUUID();
  env.OLYMPUS_WHATSAPP_STATE_DIR = stateDir;
  env.OLYMPUS_WHATSAPP_QR_STDOUT = 'false';
  env.OLYMPUS_WHATSAPP_NATIVE_CAPTURE = 'true';
  env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID = instanceId;

  return {
    command: capture.binaryPath,
    args: [],
    env,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    endpointOccupied: false,
    stateDir,
    instanceId,
    readinessProbe: (child) => whatsappReadinessProbe(stateDir, instanceId, child),
  };
}

function freshPluginConfig(contextConfig: unknown, initialPluginConfig: unknown): unknown {
  const root = asRecord(contextConfig);
  const entries = asRecord(asRecord(root?.plugins)?.entries);
  const olympus = asRecord(entries?.olympus);
  if (entries) {
    return olympus && Object.prototype.hasOwnProperty.call(olympus, 'config')
      ? olympus.config
      : undefined;
  }
  if (root && ['worker', 'email', 'sourceIndex', 'argus', 'identity', 'sovereignty']
    .some((key) => Object.prototype.hasOwnProperty.call(root, key))) {
    return root;
  }
  return initialPluginConfig;
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ['HOME', 'PATH', 'TMPDIR', 'LANG']
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0),
  );
}

/**
 * Where the bridge keeps its state. An account the registry keeps in a folder
 * has it there; read-only, after the worker owns the data, and from the
 * environment the worker was launched with (`nativeWorkerEnvironment`), so both
 * look in the same data folder. One this service owns that has no entry is
 * `legacy` (its placement pins on the owner flag that environment carries), so
 * it keeps the configured directory, else the default. A configured directory the folder does not hold contradicts the
 * registry and is refused rather than left to point the bridge at another session.
 */
function captureStateDir(configured: string | undefined, env: NodeJS.ProcessEnv, layoutEnv: NodeJS.ProcessEnv): string {
  const account = placedAccount(WHATSAPP_SOURCE_ID, layoutEnv);
  if (account.layout !== 'folder') return configured ?? legacyWhatsAppServiceStateDir(env);
  const folder = accountRawPath(account, 'whatsapp', layoutEnv);
  if (configured !== undefined && resolve(configured) !== resolve(folder)) {
    throw new NativeProcessConfigurationError(
      'Olympus WhatsApp capture service: this account keeps its files in its account folder, so worker.whatsappCapture.stateDir must be removed (or name that folder).',
    );
  }
  return folder;
}

function assertExecutableFile(path: string): void {
  if (!isAbsolute(path)) {
    throw new NativeProcessConfigurationError(
      'Olympus WhatsApp capture service binary path must be absolute.',
    );
  }
  try {
    if (!statSync(path).isFile()) throw new Error('not_file');
    accessSync(path, constants.X_OK);
  } catch {
    throw new NativeProcessConfigurationError(
      'Olympus WhatsApp capture service binary is missing or not executable.',
    );
  }
}

function assertUsableSession(path: string): void {
  try {
    if (!statSync(path).isFile()) throw new Error('not_file');
  } catch {
    throw new NativeProcessConfigurationError(
      'Olympus WhatsApp capture service requires an existing session.db; pair it manually first.',
    );
  }
}

async function whatsappReadinessProbe(
  stateDir: string,
  instanceId: string,
  child: ChildProcess,
): Promise<boolean> {
  try {
    const path = join(stateDir, READINESS_FILE);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 16 * 1024) return false;
    const receipt = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return receipt.kind === 'whatsapp_capture_service_readiness'
      && receipt.instance_id === instanceId
      && receipt.pid === child.pid
      && receipt.paired === true
      && receipt.connected === true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
