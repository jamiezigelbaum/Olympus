import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromPluginConfig, type OlympusConfig } from './config.ts';
import {
  createNativeProcessService,
  NativeProcessConfigurationError,
  type NativeProcessServiceDefinition,
  type NativeProcessStartInput,
  type NativeProcessStartSettings,
} from './native-process-service.ts';
import { applyWorkerSetupEnv } from './worker-auth.ts';
import { resolveEmbeddingDrainReportPath } from '../workers/dashboard/embedding-runtime.ts';

const SERVICE_ID = 'olympus-source-embedding-drain';
const SERVICE_LABEL = 'source embedding drain';
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const READINESS_FILE = 'source-embedding-drain-native-readiness.json';

const EMBEDDING_CREDENTIAL_NAMES = [
  'GEMINI_API_KEY',
  'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY',
] as const;

const SYSTEM_ENV_NAMES = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'XDG_DATA_HOME'] as const;

const EMBEDDING_SETTING_ENV_NAMES = new Set([
  'OLYMPUS_CONFIG',
  'OLYMPUS_EMAIL_BASE_URL',
  'OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON',
  'OLYMPUS_SOURCE_INDEX_TELEGRAM_MESSAGES_DB_PATH',
  'OLYMPUS_EMBEDDING_LEDGER_PATH',
  'OLYMPUS_SOVEREIGNTY_CONFIG',
  'OLYMPUS_SOVEREIGNTY_CONFIG_PATH',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_BASE_URL',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_DRIVE_INTERNAL_ENABLED',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_DROPBOX_STORE_DB_PATH',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_DROPBOX_STORE_ENABLED',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_EMAIL_DB_PATH',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_EMAIL_ENABLED',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_ENABLED',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_ERROR_BACKOFF_SECONDS',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_EXIT_ON_ATTENTION',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_FORCE',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_IDLE_SLEEP_SECONDS',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_INTERNAL_TELEGRAM_ENABLED',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_LEDGER_OBSERVATION_INTERVAL_SECONDS',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_LEDGER_OBSERVER_ENABLED',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_CONSECUTIVE_FAILURES',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_PENDING_CHUNKS',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_RUNS',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_RUNTIME_SECONDS',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_MODE',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_PROGRESS_HEARTBEAT_SECONDS',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_PROTECTED_TELEGRAM_ENABLED',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_READWISE_ENABLED',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_REPORT_DIR',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_REPORT_PATH',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_REQUEST_TIMEOUT_SECONDS',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_STOP_WHEN_IDLE',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_WHATSAPP_ENABLED',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_WORKER_ID',
  'OLYMPUS_SOURCE_EMBEDDING_DRAIN_X_BOOKMARKS_ENABLED',
  'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH',
  'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY',
  'OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH',
  'OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL',
  'OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH',
  'OLYMPUS_SOURCE_INDEX_EMBEDDING_MEDIA_TIMEOUT_SECONDS',
  'OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL',
  'OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY',
  'OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER',
  'OLYMPUS_SOURCE_INDEX_EMBEDDING_TIMEOUT_SECONDS',
  'OLYMPUS_SOURCE_INDEX_GMAIL_SECURE_CONNECTOR_STORE_DB_PATH',
  'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CONNECTOR_STORE_DB_PATH',
  'OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_DB_PATH',
  'OLYMPUS_SOURCE_INDEX_WHATSAPP_CONNECTOR_STORE_DB_PATH',
  'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_DB_PATH',
  'OLYMPUS_WHATSAPP_CONNECTOR_STORE_DB_PATH',
  'OLYMPUS_WHATSAPP_LIVE_DRAIN_DB_PATH',
  'OLYMPUS_WHATSAPP_STATE_DIR',
]);

const EMBEDDING_LANE_NAMES = [
  'DROPBOX',
  'EMAIL',
  'WHATSAPP',
  'INTERNAL_TELEGRAM',
  'PROTECTED_TELEGRAM',
  'READWISE',
  'X_BOOKMARKS',
  'DRIVE_INTERNAL',
] as const;

for (const lane of EMBEDDING_LANE_NAMES) {
  EMBEDDING_SETTING_ENV_NAMES.add(`OLYMPUS_SOURCE_EMBEDDING_DRAIN_${lane}_DB_PATH`);
  EMBEDDING_SETTING_ENV_NAMES.add(`OLYMPUS_SOURCE_EMBEDDING_DRAIN_${lane}_ENABLED`);
  EMBEDDING_SETTING_ENV_NAMES.add(`OLYMPUS_SOURCE_EMBEDDING_DRAIN_${lane}_CADENCE_PASSES`);
  EMBEDDING_SETTING_ENV_NAMES.add(`OLYMPUS_SOURCE_EMBEDDING_DRAIN_${lane}_MAX_PENDING_CHUNKS`);
}

export interface NativeEmbeddingDrainServiceOptions {
  initialPluginConfig: unknown;
  moduleUrl: string;
  startupTimeoutMs?: number;
  readinessPollMs?: number;
  stopGraceMs?: number;
  restartDelaysMs?: readonly number[];
  /** Test seam; production always uses applyWorkerSetupEnv's default path. */
  workerEnvPath?: string;
  /** Test seam; production inherits the Gateway working directory. */
  workingDirectory?: string;
}

interface EmbeddingDrainLaunchSettings extends NativeProcessStartSettings {
  readinessPath: string;
  instanceId: string;
}

export function createNativeEmbeddingDrainService(
  options: NativeEmbeddingDrainServiceOptions,
): NativeProcessServiceDefinition {
  return createNativeProcessService<EmbeddingDrainLaunchSettings>({
    id: SERVICE_ID,
    label: SERVICE_LABEL,
    reload: { configPrefixes: ['plugins.entries.olympus.config.worker.embeddingDrain'] },
    initialConfig: options.initialPluginConfig,
    defaultStartupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    ...(options.startupTimeoutMs !== undefined ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    ...(options.readinessPollMs !== undefined ? { readinessPollMs: options.readinessPollMs } : {}),
    ...(options.stopGraceMs !== undefined ? { stopGraceMs: options.stopGraceMs } : {}),
    ...(options.restartDelaysMs ? { restartDelaysMs: options.restartDelaysMs } : {}),
    ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
    prepareStart: (input) => prepareEmbeddingDrainStart(input, options),
  });
}

async function prepareEmbeddingDrainStart(
  input: NativeProcessStartInput<EmbeddingDrainLaunchSettings>,
  options: NativeEmbeddingDrainServiceOptions,
): Promise<EmbeddingDrainLaunchSettings | undefined> {
  let config: OlympusConfig;
  try {
    config = configFromPluginConfig(freshPluginConfig(input.context.config, input.initialConfig));
  } catch {
    throw new NativeProcessConfigurationError(
      'Olympus source embedding drain configuration is invalid or contains unresolved credentials.',
    );
  }
  const drain = config.worker.embeddingDrain;
  if (!drain.enabled) return undefined;

  const loadedEnv = baseEnvironment();
  const workerEnvPath = drain.environmentPath ?? options.workerEnvPath;
  applyWorkerSetupEnv({
    env: loadedEnv,
    ...(workerEnvPath ? { workerEnvPath } : {}),
  });
  const env = selectedEmbeddingEnvironment(loadedEnv);
  for (const name of EMBEDDING_CREDENTIAL_NAMES) {
    const value = drain.credentials[name]?.trim();
    if (value) env[name] = value;
  }

  // Preserve the two supported Gemini secret-reference conventions without
  // inheriting an ambient key or overwriting an explicitly supplied value.
  env.GEMINI_API_KEY ??= env.OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY;
  env.OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY ??= env.GEMINI_API_KEY;

  const runtimePath = resolveBunRuntimePath(drain.runtimePath, env);
  const executablePath = assertUsableFile(
    fileURLToPath(new URL('./embedding-drain.js', options.moduleUrl)),
    'packaged embedding drain',
  );
  const reportPath = drain.reportPath ?? resolveEmbeddingDrainReportPath(env);
  if (!isAbsolute(reportPath)) {
    throw new NativeProcessConfigurationError(
      'Olympus source embedding drain report path must be absolute.',
    );
  }
  const readinessPath = join(dirname(reportPath), READINESS_FILE);
  const instanceId = randomUUID();
  env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID = instanceId;
  env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_READINESS_PATH = readinessPath;

  return {
    command: runtimePath,
    args: ['--no-env-file', executablePath, '--report', reportPath],
    env,
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    endpointOccupied: false,
    readinessPath,
    instanceId,
    readinessProbe: (child) => embeddingDrainReadinessProbe(readinessPath, instanceId, child),
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
    SYSTEM_ENV_NAMES
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0),
  );
}

function selectedEmbeddingEnvironment(loadedEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = baseEnvironment();
  for (const [name, value] of Object.entries(loadedEnv)) {
    if (!value || !EMBEDDING_SETTING_ENV_NAMES.has(name)) continue;
    env[name] = value;
  }
  return env;
}

function resolveBunRuntimePath(configured: string | undefined, env: NodeJS.ProcessEnv): string {
  if (configured) return assertUsableFile(configured, 'Bun runtime');
  const candidates = [
    process.execPath,
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, process.platform === 'win32' ? 'bun.exe' : 'bun')),
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    if (!['bun', 'bun.exe'].includes(candidate.split(/[\\/]/).at(-1)?.toLowerCase() ?? '')) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next absolute candidate.
    }
  }
  throw new NativeProcessConfigurationError(
    'Olympus source embedding drain could not resolve an absolute Bun runtime path.',
  );
}

function assertUsableFile(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new NativeProcessConfigurationError(`Olympus source embedding drain ${label} path must be absolute.`);
  }
  try {
    if (statSync(path).isFile()) return path;
  } catch {
    // Use one categorical error for absent and unreadable paths.
  }
  throw new NativeProcessConfigurationError(`Olympus source embedding drain ${label} file is missing.`);
}

async function embeddingDrainReadinessProbe(
  readinessPath: string,
  instanceId: string,
  child: ChildProcess,
): Promise<boolean> {
  try {
    const stat = statSync(readinessPath);
    if (!stat.isFile() || stat.size > 16 * 1024) return false;
    const receipt = JSON.parse(readFileSync(readinessPath, 'utf8')) as Record<string, unknown>;
    return receipt.kind === 'source_embedding_drain_service_readiness'
      && receipt.schema_version === 1
      && receipt.instance_id === instanceId
      && receipt.pid === child.pid
      && receipt.options_validated === true
      && receipt.content_free === true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
