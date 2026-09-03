import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type GoogleBootstrapCheckpointStatus = 'ok' | 'action_required' | 'error';

export interface GoogleBootstrapCheckpoint {
  step: 'gcloud_present' | 'gcloud_authenticated' | 'project_ready' | 'apis_enabled' | 'console_steps_remaining';
  status: GoogleBootstrapCheckpointStatus;
  detail: string;
  remedy?: string | Record<string, unknown>;
}

export interface GoogleBootstrapResult {
  ok: true;
  source: 'google-bootstrap';
  projectId?: string;
  checkpoints: GoogleBootstrapCheckpoint[];
}

export interface GoogleBootstrapExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GoogleBootstrapExec = (command: string, args: string[]) => GoogleBootstrapExecResult | Promise<GoogleBootstrapExecResult>;

export interface GoogleBootstrapOptions {
  project?: string;
  statePath?: string;
  exec?: GoogleBootstrapExec;
  which?: (command: string) => string | undefined | Promise<string | undefined>;
  suffix?: string;
}

const REQUIRED_GOOGLE_SOURCE_APIS = ['gmail.googleapis.com', 'drive.googleapis.com', 'docs.googleapis.com'] as const;

export async function runGoogleBootstrap(options: GoogleBootstrapOptions = {}): Promise<GoogleBootstrapResult> {
  const checkpoints: GoogleBootstrapCheckpoint[] = [];
  const which = options.which ?? defaultWhich;
  const exec = options.exec ?? defaultExec;
  const gcloudPath = await which('gcloud');
  if (!gcloudPath) {
    checkpoints.push({
      step: 'gcloud_present',
      status: 'action_required',
      detail: 'Google Cloud CLI is not installed or is not on PATH.',
      remedy: platformGcloudInstallRemedy(),
    });
    return { ok: true, source: 'google-bootstrap', checkpoints };
  }
  checkpoints.push({
    step: 'gcloud_present',
    status: 'ok',
    detail: `gcloud found at ${gcloudPath}.`,
  });

  const auth = await exec('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  if (auth.status !== 0 || !auth.stdout.trim()) {
    checkpoints.push({
      step: 'gcloud_authenticated',
      status: 'action_required',
      detail: 'No active gcloud account is authenticated.',
      remedy: 'gcloud auth login',
    });
    return { ok: true, source: 'google-bootstrap', checkpoints };
  }
  checkpoints.push({
    step: 'gcloud_authenticated',
    status: 'ok',
    detail: `gcloud is authenticated as ${auth.stdout.trim().split(/\s+/)[0]}.`,
  });

  const statePath = options.statePath ?? defaultGoogleBootstrapStatePath();
  const projectId = await resolveBootstrapProjectId({ ...options, statePath, exec });
  const described = await exec('gcloud', ['projects', 'describe', projectId, '--format=json']);
  if (described.status === 0) {
    checkpoints.push({
      step: 'project_ready',
      status: 'ok',
      detail: `Reusing Google Cloud project ${projectId}.`,
    });
  } else {
    const created = await exec('gcloud', ['projects', 'create', projectId]);
    if (created.status !== 0) {
      checkpoints.push({
        step: 'project_ready',
        status: 'error',
        detail: `Could not create Google Cloud project ${projectId}.`,
        remedy: created.stderr || created.stdout || 'Check gcloud permissions and rerun olympus connect google-bootstrap.',
      });
      return { ok: true, source: 'google-bootstrap', projectId, checkpoints };
    }
    checkpoints.push({
      step: 'project_ready',
      status: 'ok',
      detail: `Created Google Cloud project ${projectId}.`,
    });
  }
  writeBootstrapState(statePath, { projectId });

  const enabled = await enabledServices(projectId, exec);
  const missingApis = REQUIRED_GOOGLE_SOURCE_APIS.filter((api) => !enabled.has(api));
  if (missingApis.length > 0) {
    const enabledResult = await exec('gcloud', ['services', 'enable', ...missingApis, '--project', projectId]);
    if (enabledResult.status !== 0) {
      checkpoints.push({
        step: 'apis_enabled',
        status: 'error',
        detail: `Could not enable required Google APIs for ${projectId}: ${missingApis.join(', ')}.`,
        remedy: enabledResult.stderr || enabledResult.stdout || 'Check gcloud permissions and rerun olympus connect google-bootstrap.',
      });
      return { ok: true, source: 'google-bootstrap', projectId, checkpoints };
    }
  }
  checkpoints.push({
    step: 'apis_enabled',
    status: 'ok',
    detail: `Required Google source APIs are enabled for ${projectId}: ${REQUIRED_GOOGLE_SOURCE_APIS.join(', ')}.`,
  });
  checkpoints.push({
    step: 'console_steps_remaining',
    status: 'action_required',
    detail: 'Google still requires the OAuth consent screen and desktop OAuth client to be created in Cloud Console.',
    remedy: googleConsoleStepLinks(projectId),
  });
  return { ok: true, source: 'google-bootstrap', projectId, checkpoints };
}

function defaultGoogleBootstrapStatePath(): string {
  return join(homedir(), '.olympus', 'google-bootstrap.json');
}

async function resolveBootstrapProjectId(options: GoogleBootstrapOptions & {
  statePath: string;
  exec: GoogleBootstrapExec;
}): Promise<string> {
  if (options.project?.trim()) return safeProjectId(options.project);
  const state = readBootstrapState(options.statePath);
  if (state.projectId) return state.projectId;
  const suffix = options.suffix ?? Math.random().toString(36).slice(2, 10);
  return safeProjectId(`olympus-${suffix.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16)}`);
}

async function enabledServices(projectId: string, exec: GoogleBootstrapExec): Promise<Set<string>> {
  const result = await exec('gcloud', [
    'services',
    'list',
    '--enabled',
    '--project',
    projectId,
    '--format=value(config.name)',
  ]);
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.split(/\s+/).map((value) => value.trim()).filter(Boolean));
}

function googleConsoleStepLinks(projectId: string): Record<string, unknown> {
  return {
    consent_screen: `https://console.cloud.google.com/auth/overview?project=${projectId}`,
    oauth_client: `https://console.cloud.google.com/auth/clients/create?project=${projectId}`,
    audience: `https://console.cloud.google.com/auth/audience?project=${projectId}`,
    legacy_fallbacks: {
      consent_screen: `https://console.cloud.google.com/apis/credentials/consent?project=${projectId}`,
      oauth_client: `https://console.cloud.google.com/apis/credentials/oauthclient?project=${projectId}`,
    },
  };
}

function platformGcloudInstallRemedy(): Record<string, string> {
  return {
    macos: 'Install Google Cloud CLI from https://cloud.google.com/sdk/docs/install-sdk#mac or with Homebrew: brew install --cask google-cloud-sdk',
    linux: 'Install Google Cloud CLI from https://cloud.google.com/sdk/docs/install-sdk#linux',
    windows: 'Install Google Cloud CLI from https://cloud.google.com/sdk/docs/install-sdk#windows',
  };
}

function readBootstrapState(path: string): { projectId?: string } {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const projectId = typeof parsed.projectId === 'string' ? parsed.projectId : undefined;
    return projectId ? { projectId: safeProjectId(projectId) } : {};
  } catch {
    return {};
  }
}

function writeBootstrapState(path: string, state: { projectId: string }): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function safeProjectId(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(trimmed)) throw new Error('--project must be a valid Google Cloud project id.');
  return trimmed;
}

async function defaultWhich(command: string): Promise<string | undefined> {
  return Bun.which(command) ?? undefined;
}

async function defaultExec(command: string, args: string[]): Promise<GoogleBootstrapExecResult> {
  const proc = Bun.spawn({
    cmd: [command, ...args],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status: exitCode, stdout, stderr };
}
