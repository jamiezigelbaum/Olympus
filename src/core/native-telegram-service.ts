import { nativeWorkerEnvironment, waitForNativeWorkerOwnership } from './native-worker-service.ts';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromPluginConfig, type OlympusConfig } from './config.ts';
import {
  TELEGRAM_SOURCE_ID,
  folderCaptureDirs,
  folderCaptureEnv,
  legacyTelegramGatewayStateDir,
} from './olympus-layout.ts';
import { placedAccount } from './source-placement.ts';
import {
  createNativeProcessService,
  NativeProcessConfigurationError,
  type NativeProcessServiceDefinition,
  type NativeProcessStartInput,
  type NativeProcessStartSettings,
} from './native-process-service.ts';
import { applyWorkerSetupEnv } from './worker-auth.ts';

const SERVICE_ID = 'olympus-telegram-capture';
const SERVICE_LABEL = 'Telegram capture service';
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const READINESS_FILE = 'native-service-readiness.json';

const TELEGRAM_CREDENTIAL_NAMES = [
  'OLYMPUS_TELEGRAM_API_ID',
  'OLYMPUS_TELEGRAM_API_HASH',
] as const;

const MANAGED_TELEGRAM_ENV_NAMES = new Set([
  'OLYMPUS_SOURCE_INDEX_TELEGRAM_ACCOUNT',
  'OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES',
  'OLYMPUS_SOURCE_INDEX_TELEGRAM_PROTECTED_CHAT_SCOPES',
  'OLYMPUS_SOURCE_INDEX_TELEGRAM_CHAT_CLASSIFICATIONS_JSON',
  'OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES',
  'OLYMPUS_TELEGRAM_PROTECTED_CHAT_SCOPES',
  'OLYMPUS_TELEGRAM_CHAT_CLASSIFICATIONS_JSON',
  'OLYMPUS_TELEGRAM_SESSION_PATH',
  'OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR',
  'OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR',
  'OLYMPUS_TELEGRAM_GATEWAY_REPORT_PATH',
  'OLYMPUS_TELEGRAM_GATEWAY_BACKFILL_REQUESTS_PATH',
  'OLYMPUS_TELEGRAM_GATEWAY_MAX_MESSAGES',
  'OLYMPUS_TELEGRAM_GATEWAY_INTERVAL_SECONDS',
  'OLYMPUS_TELEGRAM_GATEWAY_SPOOL_STALE_THRESHOLD_SECONDS',
]);

export interface NativeTelegramServiceOptions {
  initialPluginConfig: unknown;
  workerIsReady?: () => boolean;
  workerReadinessTimeoutMs?: number;
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

interface TelegramLaunchSettings extends NativeProcessStartSettings {
  stateDir: string;
  instanceId: string;
}

/**
 * Supervise the read-only Telethon capture gateway as a native OpenClaw
 * service. The shared process kernel owns lifecycle and restart behavior; this
 * adapter owns strict config, a minimal child environment, and an
 * instance-bound readiness receipt.
 */
export function createNativeTelegramService(
  options: NativeTelegramServiceOptions,
): NativeProcessServiceDefinition {
  return createNativeProcessService<TelegramLaunchSettings>({
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
    prepareStart: (input) => prepareTelegramStart(input, options),
  });
}

async function prepareTelegramStart(
  input: NativeProcessStartInput<TelegramLaunchSettings>,
  options: NativeTelegramServiceOptions,
): Promise<TelegramLaunchSettings | undefined> {
  let config: OlympusConfig;
  try {
    config = configFromPluginConfig(freshPluginConfig(input.context.config, input.initialConfig));
  } catch {
    throw new NativeProcessConfigurationError(
      'Olympus Telegram capture service configuration is invalid or contains unresolved credentials.',
    );
  }
  const capture = config.worker.telegramCapture;
  if (!capture.enabled) return undefined;
  if (!config.worker.service.enabled) {
    throw new NativeProcessConfigurationError(
      'Native telegram capture requires worker.service.enabled so the worker can enforce exclusive capture ownership.',
    );
  }

  await waitForNativeWorkerOwnership(
    options.workerIsReady,
    options.workerReadinessTimeoutMs ?? config.worker.service.startupTimeoutSeconds * 1_000 + 5_000,
  );

  if (!capture.pythonPath) {
    throw new NativeProcessConfigurationError(
      'Olympus Telegram capture service requires an absolute worker.telegramCapture.pythonPath.',
    );
  }
  assertUsableFile(capture.pythonPath, 'Python interpreter');

  const scriptPath = fileURLToPath(new URL('../scripts/telegram-telethon-reader.py', options.moduleUrl));
  assertUsableFile(scriptPath, 'packaged Telegram reader');

  const loadedEnv = baseEnvironment();
  applyWorkerSetupEnv({
    env: loadedEnv,
    ...(options.workerEnvPath ? { workerEnvPath: options.workerEnvPath } : {}),
  });
  const env = selectedTelegramEnvironment(loadedEnv);

  for (const name of TELEGRAM_CREDENTIAL_NAMES) {
    const value = capture.credentials[name]?.trim();
    if (!value) {
      throw new NativeProcessConfigurationError(
        `Olympus Telegram capture service requires resolved ${name} credentials.`,
      );
    }
    env[name] = value;
  }
  if (!/^\d+$/.test(env.OLYMPUS_TELEGRAM_API_ID ?? '') || Number(env.OLYMPUS_TELEGRAM_API_ID) < 1) {
    throw new NativeProcessConfigurationError(
      'Olympus Telegram capture service requires a positive numeric OLYMPUS_TELEGRAM_API_ID.',
    );
  }

  applyConfiguredPaths(config, env);
  applyFolderPaths(config, nativeWorkerEnvironment(config, options.workerEnvPath), env);
  const sessionPath = env.OLYMPUS_TELEGRAM_SESSION_PATH?.trim();
  if (!sessionPath || !sessionPath.endsWith('.session')) {
    throw new NativeProcessConfigurationError(
      'Olympus Telegram capture service requires an existing .session file.',
    );
  }
  assertUsableFile(sessionPath, 'Telegram .session');

  const approvedScopes = firstPresent(
    env.OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES,
    env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES,
  );
  const approvedChatCount = new Set((approvedScopes ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)).size;
  if (approvedChatCount === 0) {
    throw new NativeProcessConfigurationError(
      'Olympus Telegram capture service requires at least one approved chat scope.',
    );
  }

  // Where the reader writes its readiness file, XDG_STATE_HOME included.
  const stateDir = legacyTelegramGatewayStateDir(env);
  const instanceId = randomUUID();
  env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID = instanceId;
  return {
    command: capture.pythonPath,
    args: [scriptPath, '--gateway'],
    env,
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    endpointOccupied: false,
    stateDir,
    instanceId,
    readinessProbe: (child) => telegramReadinessProbe(
      stateDir,
      instanceId,
      approvedChatCount,
      child,
    ),
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

function selectedTelegramEnvironment(loadedEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = baseEnvironment();
  for (const [name, value] of Object.entries(loadedEnv)) {
    if (!value || !isSelectedTelegramSetting(name)) continue;
    env[name] = value;
  }
  return env;
}

function isSelectedTelegramSetting(name: string): boolean {
  return MANAGED_TELEGRAM_ENV_NAMES.has(name);
}

function applyConfiguredPaths(config: OlympusConfig, env: NodeJS.ProcessEnv): void {
  const capture = config.worker.telegramCapture;
  if (capture.sessionPath) env.OLYMPUS_TELEGRAM_SESSION_PATH = capture.sessionPath;
  if (capture.stateDir) env.OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR = capture.stateDir;
  if (capture.spoolDir) env.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR = capture.spoolDir;
  if (capture.reportPath) env.OLYMPUS_TELEGRAM_GATEWAY_REPORT_PATH = capture.reportPath;
}

/**
 * An account the registry keeps in a folder has its files there, whatever
 * worker.env says about paths: a folder account honors no path override. The
 * registry is only read, after the worker owns the data, and from the
 * environment the worker was launched with (`nativeWorkerEnvironment`), so both
 * look in the same data folder. A source this service owns that has no entry is
 * `legacy` (its placement pins on the owner flag that environment carries), so
 * it keeps the configured paths. Plugin config that
 * names a path the folder does not hold contradicts the registry, and is
 * refused rather than left to point the reader at another session.
 */
function applyFolderPaths(config: OlympusConfig, layoutEnv: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): void {
  const account = placedAccount(TELEGRAM_SOURCE_ID, layoutEnv);
  if (account.layout !== 'folder') return;
  const folder = folderCaptureEnv(account, layoutEnv);
  const session = `${folder.OLYMPUS_TELEGRAM_SESSION_PATH}.session`;
  const capture = config.worker.telegramCapture;
  const contradicts = (configured: string | undefined, folderPath: string | undefined): boolean =>
    configured !== undefined && resolve(configured) !== resolve(folderPath ?? '');
  if (
    contradicts(capture.sessionPath, session)
    || contradicts(capture.stateDir, folder.OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR)
    || contradicts(capture.spoolDir, folder.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR)
  ) {
    throw new NativeProcessConfigurationError(
      'Olympus Telegram capture service: this account keeps its files in its account folder, so worker.telegramCapture.sessionPath, stateDir and spoolDir must be removed (or name that folder).',
    );
  }
  env.OLYMPUS_TELEGRAM_SESSION_PATH = session;
  env.OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR = folder.OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR!;
  env.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR = folder.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR!;
  delete env.OLYMPUS_TELEGRAM_GATEWAY_BACKFILL_REQUESTS_PATH;
  for (const dir of folderCaptureDirs(account, layoutEnv)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function assertUsableFile(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new NativeProcessConfigurationError(
      `Olympus Telegram capture service ${label} path must be absolute.`,
    );
  }
  try {
    if (!statSync(path).isFile()) throw new Error('not_file');
  } catch {
    throw new NativeProcessConfigurationError(
      `Olympus Telegram capture service ${label} file is missing.`,
    );
  }
}

async function telegramReadinessProbe(
  stateDir: string,
  instanceId: string,
  approvedChatCount: number,
  child: ChildProcess,
): Promise<boolean> {
  try {
    const path = join(stateDir, READINESS_FILE);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 16 * 1024) return false;
    const receipt = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return receipt.kind === 'telegram_capture_service_readiness'
      && receipt.instance_id === instanceId
      && receipt.pid === child.pid
      && receipt.authenticated === true
      && typeof receipt.approved_chats === 'number'
      && Number.isInteger(receipt.approved_chats)
      && receipt.approved_chats === approvedChatCount;
  } catch {
    return false;
  }
}

function firstPresent(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
