import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { installManagedWorkerFiles, type ManagedWorkerFilesResult } from './lifecycle.ts';
import { OperationError } from './operation-error.ts';
import {
  type WorkerServiceExec,
  type WorkerServiceInstallOptions,
  type WorkerServiceInstallResult,
  type WorkerServicePlatform,
  type WorkerServiceState,
} from './worker-service.ts';
import {
  SOVEREIGNTY_PRESETS,
  defaultSovereigntyConfigPath,
  loadSovereigntyPreset,
  writeSovereigntyConfigFile,
  type SovereigntyConfig,
  type SovereigntyPresetName,
} from './sovereignty.ts';
import { setupPreflight, type SetupPrerequisite } from './setup-preflight.ts';
import type { SecretStore } from './secret-store.ts';
import type { ConnectSource } from './connect.ts';

export type SetupCloudLane = 'subscription' | 'api-key';
export type SetupSecureTierDecision =
  | 'local_lane'
  | 'local_lane_with_venice_escalation'
  | 'private_cloud_only'
  | 'secure_off_user_choice';

export interface SetupDependencyCheck {
  ok: boolean;
  platform: 'darwin' | 'linux' | 'other';
  checks: SetupDependencyFinding[];
}

export interface SetupDependencyFinding {
  id: string;
  label: string;
  required: boolean;
  ok: boolean;
  detail: string;
  repairHint: string;
}

export interface SetupWizardOptions {
  preset: SovereigntyPresetName;
  yes: boolean;
  cloudLane?: SetupCloudLane;
  sovereigntyPath?: string;
  force?: boolean;
  dryRun?: boolean;
  platform?: WorkerServicePlatform;
  homeDir?: string;
  olympusBin?: string;
  workingDirectory?: string;
  envPath?: string;
  exec?: WorkerServiceExec;
  connectSources?: ConnectSource[];
  connectSource?: (source: ConnectSource) => Promise<unknown>;
  dependencyCheck?: () => SetupDependencyCheck;
  env?: Record<string, string | undefined>;
  secretStore?: Pick<SecretStore, 'get' | 'getSync'>;
  tokenGenerator?: () => string;
}

export interface SetupWizardResult {
  ok: true;
  mode: 'non_interactive';
  dependencyCheck: SetupDependencyCheck;
  venicePitch: {
    shown: true;
    text: string[];
  };
  preset: SovereigntyPresetName;
  secureTierDecision: SetupSecureTierDecision;
  unmet_prerequisites: SetupPrerequisite[];
  cloudLane: SetupCloudLane;
  sovereignty: {
    path: string;
    wrote: boolean;
    schemaVersion: 1;
  };
  worker: {
    authTokenRef: 'worker.env:OLYMPUS_WORKER_AUTH_TOKEN';
    install: WorkerServiceInstallResult;
    /**
     * What the service manager reports about the managed worker when setup
     * returns. Setup starts it, so the guide's next step — check the status —
     * has something true to check; `not_started` is the dry-run answer only.
     */
    state: WorkerServiceState | 'not_started';
    /** The next step this state calls for, in the operator's words. */
    next: string;
    /** Why the start did not take, when it did not. Absent on the healthy path. */
    activation_detail?: string;
  };
  connections: Array<{
    source: ConnectSource;
    status: 'connected' | 'skipped';
    result?: unknown;
    next?: string;
  }>;
  dashboard: {
    url: string;
    next: string;
  };
}

export const VENICE_PITCH_TEXT = [
  'Secure source answers follow the selected preset: local-first tries your local lane before Venice; private-cloud-only uses Venice without a local-model requirement.',
  'In v0.4, Venice uses its ordinary API with a live-catalog Private or plain TEE model. Olympus does not provide or qualify E2EE out of the box; custom integrations are user-owned.',
  'Secure corpora remain lexical-only in v0.4; Olympus never falls back to an ordinary cloud embedding provider.',
  'Turning the secure tier off is a deliberate choice after this screen.',
] as const;

export function runSetupDependencyCheck(input: {
  platform?: NodeJS.Platform;
  commandExists?: (command: string) => boolean;
  commandVersion?: (command: string) => string | undefined;
  pythonModuleExists?: (pythonCommand: string, moduleName: string) => boolean;
} = {}): SetupDependencyCheck {
  const platform = normalizeSetupPlatform(input.platform ?? process.platform);
  const commandExists = input.commandExists ?? defaultCommandExists;
  const commandVersion = input.commandVersion ?? defaultCommandVersion;
  const pythonModuleExists = input.pythonModuleExists ?? defaultPythonModuleExists;
  const pythonCommand = commandExists('python3') ? 'python3' : commandExists('python') ? 'python' : undefined;
  const bunExists = commandExists('bun');
  const bunVersion = bunExists ? commandVersion('bun') : undefined;
  const bunOk = bunExists && isMinimumVersion(bunVersion, [1, 2, 0]);
  const checks: SetupDependencyFinding[] = [
    dependencyFinding({
      id: 'bun',
      label: 'Bun',
      required: true,
      ok: bunOk,
      detail: bunExists
        ? `Runs the Olympus TypeScript CLI and local verification. Detected ${bunVersion ? `Bun ${bunVersion}` : 'an unknown Bun version'}; Olympus requires Bun 1.2+.`
        : 'Runs the Olympus TypeScript CLI and local verification.',
      repairHint: repairHint(platform, 'bun'),
    }),
    dependencyFinding({
      id: 'node',
      label: 'Node.js',
      required: true,
      ok: commandExists('node'),
      detail: 'Runs installed JavaScript entrypoints in OpenClaw plugin hosts.',
      repairHint: repairHint(platform, 'node'),
    }),
    dependencyFinding({
      id: 'gog',
      label: 'gog',
      required: false,
      ok: commandExists('gog'),
      detail: 'Optional Google Gmail and Drive command adapter.',
      repairHint: 'Install and authenticate gog before connecting Google sources.',
    }),
    dependencyFinding({
      id: 'op',
      label: '1Password CLI',
      required: false,
      ok: commandExists('op'),
      detail: 'Optional 1Password-backed secret-store integration.',
      repairHint: 'Install the 1Password CLI from https://developer.1password.com/docs/cli/get-started/ when using that backend.',
    }),
    dependencyFinding({
      id: 'python-telethon',
      label: 'Python Telethon',
      required: false,
      ok: Boolean(pythonCommand && pythonModuleExists(pythonCommand, 'telethon')),
      detail: 'Optional Telegram guided-session reader.',
      repairHint: 'Install Python 3 and run python3 -m pip install telethon before connecting Telegram.',
    }),
    dependencyFinding({
      id: 'go',
      label: 'Go',
      required: false,
      ok: commandExists('go'),
      detail: 'Optional WhatsApp bridge build/runtime support.',
      repairHint: repairHint(platform, 'go'),
    }),
  ];
  return {
    ok: checks.every((check) => check.ok || !check.required),
    platform,
    checks,
  };
}

export async function runSetupWizard(options: SetupWizardOptions): Promise<SetupWizardResult> {
  if (options.yes !== true) {
    throw new OperationError(
      'invalid_params',
      'olympus setup non-interactive mode requires --yes.',
      `Run olympus setup --preset ${SOVEREIGNTY_PRESETS.join('|')} --yes.`,
    );
  }

  const dependencyCheck = options.dependencyCheck?.() ?? runSetupDependencyCheck();
  assertSetupDependenciesOk(dependencyCheck);
  const cloudLane = options.cloudLane ?? 'subscription';
  const presetConfig = applyCloudLane(loadSovereigntyPreset(options.preset), cloudLane);
  const unmetPrerequisites = await setupPreflight({
    config: presetConfig,
    ...(options.env ? { env: options.env } : {}),
    ...(options.secretStore ? { secretStore: options.secretStore } : {}),
    // This install's own worker.env, not $HOME's: a wizard run against a
    // different home must preflight against that home's stored keys.
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.envPath ? { workerEnvPath: options.envPath } : {}),
  });
  const sovereigntyPath = options.sovereigntyPath ?? defaultSovereigntyConfigPath();
  const workerToken = options.tokenGenerator?.() ?? generateWorkerToken();
  let wroteSovereignty = false;
  let managedWorker: ManagedWorkerFilesResult;

  if (options.dryRun) {
    managedWorker = installManagedWorkerFiles(workerOptions(options, workerToken));
  } else {
    writeSovereigntyConfigFile({
      config: presetConfig,
      path: sovereigntyPath,
      ...(options.force !== undefined ? { force: options.force } : {}),
    });
    wroteSovereignty = true;
    // Writing the unit and walking away left the operator with an inactive
    // worker and a guide whose next step was to verify it was running
    // (clean-install rehearsal, 2026-09-05). Setup takes the same activation
    // lane `olympus worker install` uses, so that step can pass.
    managedWorker = installManagedWorkerFiles(workerOptions(options, workerToken));
  }
  const workerState: WorkerServiceState | 'not_started' = managedWorker.activation === 'skipped'
    ? 'not_started'
    : managedWorker.service?.state ?? 'unknown';

  const connections = [];
  for (const source of options.connectSources ?? []) {
    if (!options.connectSource) {
      connections.push({
        source,
        status: 'skipped' as const,
        next: `Run olympus connect ${source} when you are ready to connect this source.`,
      });
      continue;
    }
    connections.push({
      source,
      status: 'connected' as const,
      result: await options.connectSource(source),
    });
  }

  return {
    ok: true,
    mode: 'non_interactive',
    dependencyCheck,
    venicePitch: {
      shown: true,
      text: [...VENICE_PITCH_TEXT],
    },
    preset: options.preset,
    secureTierDecision: secureTierDecisionForPreset(options.preset),
    unmet_prerequisites: unmetPrerequisites,
    cloudLane,
    sovereignty: {
      path: sovereigntyPath,
      wrote: wroteSovereignty,
      schemaVersion: 1,
    },
    worker: {
      authTokenRef: 'worker.env:OLYMPUS_WORKER_AUTH_TOKEN',
      install: managedWorker.install,
      state: workerState,
      next: workerState === 'active'
        ? 'The managed worker is running; open the dashboard with olympus dashboard.'
        : workerState === 'not_started'
          ? 'Dry run: rerun without --dry-run to write and start the managed worker.'
          : 'Run olympus worker install, then olympus worker status.',
      ...(managedWorker.activation_detail ? { activation_detail: managedWorker.activation_detail } : {}),
    },
    connections,
    dashboard: {
      url: 'http://127.0.0.1:8010/dashboard',
      next: 'Open the local dashboard after the worker is running.',
    },
  };
}

function assertSetupDependenciesOk(dependencyCheck: SetupDependencyCheck): void {
  if (dependencyCheck.ok) return;
  const missingRequired = dependencyCheck.checks.filter((check) => check.required && !check.ok);
  if (missingRequired.length === 0) return;
  throw new OperationError(
    'config_error',
    `olympus setup cannot continue until required dependencies are available: ${missingRequired.map((check) => check.label).join(', ')}.`,
    missingRequired.map((check) => `${check.label}: ${check.repairHint}`).join('\n'),
  );
}

function workerOptions(
  options: SetupWizardOptions,
  authToken: string,
): WorkerServiceInstallOptions & { exec?: WorkerServiceExec } {
  return {
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.olympusBin ? { olympusBin: options.olympusBin } : {}),
    ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
    ...(options.envPath ? { envPath: options.envPath } : {}),
    ...(options.exec ? { exec: options.exec } : {}),
    authToken,
    schedulerEnabled: true,
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
  };
}

function applyCloudLane(config: SovereigntyConfig, cloudLane: SetupCloudLane): SovereigntyConfig {
  if (cloudLane === 'subscription') return config;
  const next = structuredClone(config);
  for (const profile of Object.values(next.modelProfiles)) {
    if (profile.provider !== 'openclaw-infer') continue;
    profile.provider = 'openai-compatible';
    profile.baseUrl = 'https://api.openai.com/v1';
    profile.secretRef = 'env:OPENAI_API_KEY';
  }
  return next;
}

function secureTierDecisionForPreset(preset: SovereigntyPresetName): SetupSecureTierDecision {
  if (preset === 'local-first') return 'local_lane_with_venice_escalation';
  if (preset === 'local-only') return 'local_lane';
  if (preset === 'private-cloud-only') return 'private_cloud_only';
  return 'secure_off_user_choice';
}

function dependencyFinding(input: SetupDependencyFinding): SetupDependencyFinding {
  return input;
}

function normalizeSetupPlatform(platform: NodeJS.Platform): SetupDependencyCheck['platform'] {
  if (platform === 'darwin' || platform === 'linux') return platform;
  return 'other';
}

function defaultCommandExists(command: string): boolean {
  const result = spawnSync('sh', ['-lc', `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function defaultPythonModuleExists(pythonCommand: string, moduleName: string): boolean {
  const result = spawnSync(pythonCommand, ['-c', `import ${moduleName}`], { stdio: 'ignore' });
  return result.status === 0;
}

function defaultCommandVersion(command: string): string | undefined {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim().split(/\s+/)[0];
}

function isMinimumVersion(version: string | undefined, minimum: [number, number, number]): boolean {
  if (!version) return false;
  const [major = 0, minor = 0, patch = 0] = version.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  if (![major, minor, patch].every(Number.isFinite)) return false;
  if (major !== minimum[0]) return major > minimum[0];
  if (minor !== minimum[1]) return minor > minimum[1];
  return patch >= minimum[2];
}

function repairHint(platform: SetupDependencyCheck['platform'], dependency: 'bun' | 'node' | 'go'): string {
  if (dependency === 'bun') return 'Install Bun 1.2+ from https://bun.sh/docs/installation.';
  if (dependency === 'node') return platform === 'darwin'
    ? 'Install Node.js from https://nodejs.org/ or with brew install node.'
    : 'Install Node.js from https://nodejs.org/ or your OS package manager.';
  return platform === 'darwin'
    ? 'Install Go from https://go.dev/doc/install or with brew install go.'
    : 'Install Go from https://go.dev/doc/install or your OS package manager.';
}

function generateWorkerToken(): string {
  return randomBytes(32).toString('base64url');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
