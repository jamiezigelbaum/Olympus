import { spawn } from 'node:child_process';
import {
  googleServiceAccountTokenUrl,
  parseGoogleServiceAccountKey,
  signGoogleServiceAccountJwt,
  GOOGLE_JWT_BEARER_GRANT_TYPE,
  type GoogleServiceAccountKey,
} from './google-service-account.ts';
import { createDefaultSecretStore, isSafeSecretKey, type SecretStore } from './secret-store.ts';
import type { ConnectResult } from './connect.ts';
import {
  defaultHandleRegistryPath,
  upsertConnectedHandle,
} from '../workers/credential-broker/connected-handles.ts';

export interface GcloudExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GcloudExec = (command: string, args: string[]) => GcloudExecResult | Promise<GcloudExecResult>;

export interface ConnectGcpOptions {
  project?: string;
  serviceAccount?: string;
  location?: string;
  accountRole?: string;
  yes?: boolean;
  dryRun?: boolean;
  registryPath?: string;
  secretStore?: SecretStore;
  now?: () => Date;
  exec?: GcloudExec;
  fetch?: typeof fetch;
  onLog?: (message: string) => void;
  confirm?: (prompt: string) => boolean | Promise<boolean>;
  input?: (prompt: string) => string | Promise<string>;
}

interface GcloudCommand {
  command: string;
  args: string[];
}

const REQUIRED_APIS = ['aiplatform.googleapis.com', 'storage.googleapis.com'] as const;
const REQUIRED_ROLES = ['roles/aiplatform.user', 'roles/storage.admin'] as const;
const DEFAULT_LOCATION = 'us-central1';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export async function connectGcpSource(options: ConnectGcpOptions = {}): Promise<ConnectResult> {
  const location = safeLocation(options.location ?? DEFAULT_LOCATION);
  const accountRole = safeAccountRole(options.accountRole ?? 'domain_expert');
  const registryPath = options.registryPath ?? defaultHandleRegistryPath();
  const secretStore = options.secretStore ?? createDefaultSecretStore();
  const now = options.now ?? (() => new Date());
  const exec = options.exec ?? defaultGcloudExec;
  const fetchImpl = options.fetch ?? fetch;
  const messages: string[] = [];
  const log = (message: string) => {
    messages.push(message);
    options.onLog?.(message);
  };

  if (options.dryRun) {
    if (!options.project?.trim()) throw new Error('--project is required for olympus connect gcp --dry-run.');
    if (!options.serviceAccount?.trim()) throw new Error('--service-account is required for olympus connect gcp --dry-run.');
    const mutatingPlan = buildPotentialMutatingPlan({
      project: safeProjectId(options.project),
      serviceAccount: options.serviceAccount,
    });
    log('Dry run: no gcloud commands, network calls, secret writes, or registry writes will run.');
    for (const command of mutatingPlan) log(formatCommand(command));
    return {
      ok: true,
      source: 'gcp',
      handles: [],
      registryPath,
      secretRefs: [],
      next: 'Run olympus connect gcp without --dry-run when the plan is approved.',
      messages,
    };
  }
  if (options.yes && !options.project?.trim()) {
    throw new Error('--project is required with olympus connect gcp --yes.');
  }
  if (options.yes && !options.serviceAccount?.trim()) {
    throw new Error('--service-account is required with olympus connect gcp --yes.');
  }

  const version = await exec('gcloud', ['--version']);
  if (version.status !== 0) {
    log('gcloud CLI was not found or did not run. Install Google Cloud CLI, then rerun olympus connect gcp.');
    return cleanExit(registryPath, messages, 'Install Google Cloud CLI, then rerun olympus connect gcp.');
  }
  const auth = await exec('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  if (auth.status !== 0 || !auth.stdout.trim()) {
    log('No active owner gcloud login found. Run: gcloud auth login');
    return cleanExit(registryPath, messages, 'Run gcloud auth login, then rerun olympus connect gcp.');
  }

  const project = await resolveProject({ project: options.project, exec, input: options.input, log });
  const projectDescribe = await exec('gcloud', ['projects', 'describe', project, '--format=json']);
  if (projectDescribe.status === 0) {
    log(`Project ${project} already exists; skipping project creation.`);
  } else {
    const createProject = command('gcloud', ['projects', 'create', project]);
    const approved = await approveAndRun({
      command: createProject,
      exec,
      yes: options.yes,
      confirm: options.confirm,
      log,
      prompt: `Create GCP project ${project}?`,
    });
    if (!approved) return cleanExit(registryPath, messages, `Rerun olympus connect gcp --project ${project} to resume.`);
  }

  const missingApis = await missingServices(project, exec);
  if (missingApis.length === 0) {
    log('Required APIs already enabled; skipping API enablement.');
  } else {
    const enableApis = command('gcloud', ['services', 'enable', ...missingApis, '--project', project]);
    const approved = await approveAndRun({
      command: enableApis,
      exec,
      yes: options.yes,
      confirm: options.confirm,
      log,
      prompt: `Enable required GCP APIs for ${project}?`,
    });
    if (!approved) return cleanExit(registryPath, messages, `Rerun olympus connect gcp --project ${project} to resume.`);
  }

  const serviceAccount = normalizeServiceAccount(options.serviceAccount ?? 'olympus-secure', project);
  const serviceAccountDescribe = await exec('gcloud', [
    'iam',
    'service-accounts',
    'describe',
    serviceAccount.email,
    '--project',
    project,
    '--format=json',
  ]);
  if (serviceAccountDescribe.status === 0) {
    log(`Service account ${serviceAccount.email} already exists; skipping service-account creation.`);
  } else {
    const createSa = command('gcloud', [
      'iam',
      'service-accounts',
      'create',
      serviceAccount.id,
      '--project',
      project,
      '--display-name',
      'Olympus domain expert',
    ]);
    const approved = await approveAndRun({
      command: createSa,
      exec,
      yes: options.yes,
      confirm: options.confirm,
      log,
      prompt: `Create service account ${serviceAccount.email}?`,
    });
    if (!approved) {
      return cleanExit(registryPath, messages, `Rerun olympus connect gcp --project ${project} --service-account ${serviceAccount.id} to resume.`);
    }
  }

  const presentRoles = await projectRolesForMember(project, serviceAccount.email, exec);
  for (const role of REQUIRED_ROLES) {
    if (presentRoles.has(role)) {
      log(`${role} already granted to ${serviceAccount.email}; skipping grant.`);
      continue;
    }
    const grant = command('gcloud', [
      'projects',
      'add-iam-policy-binding',
      project,
      `--member=serviceAccount:${serviceAccount.email}`,
      `--role=${role}`,
    ]);
    const approved = await approveAndRun({
      command: grant,
      exec,
      yes: options.yes,
      confirm: options.confirm,
      log,
      prompt: `OWNER APPROVAL BOUNDARY: grant ${role} to ${serviceAccount.email} on ${project}?`,
    });
    if (!approved) {
      return cleanExit(registryPath, messages, `Grant declined. Rerun olympus connect gcp --project ${project} --service-account ${serviceAccount.id} to resume.`);
    }
    presentRoles.add(role);
  }

  const secretKey = `gcp.${accountRole}.service_account_json`;
  let rawCredential = await secretStore.get(secretKey);
  if (rawCredential?.trim()) {
    log(`Secret store already has store:${secretKey}; skipping service-account key creation.`);
  } else {
    const keyCreate = command('gcloud', [
      'iam',
      'service-accounts',
      'keys',
      'create',
      '/dev/stdout',
      `--iam-account=${serviceAccount.email}`,
      '--project',
      project,
    ]);
    const keyResult = await approveAndRun({
      command: keyCreate,
      exec,
      yes: options.yes,
      confirm: options.confirm,
      log,
      prompt: `Create a new JSON key for ${serviceAccount.email} and store it in the Olympus SecretStore?`,
      capture: true,
    });
    if (!keyResult) {
      return cleanExit(registryPath, messages, `Key creation declined. Rerun olympus connect gcp --project ${project} --service-account ${serviceAccount.id} to resume.`);
    }
    rawCredential = extractJsonObject(keyResult.stdout);
    validateServiceAccountKey(rawCredential, serviceAccount.email);
    await secretStore.set(secretKey, rawCredential);
    log(`Stored service-account JSON in store:${secretKey}.`);
  }

  const credential = validateServiceAccountKey(rawCredential, serviceAccount.email);
  await verifyStoredGcpCredential({
    credential,
    project,
    location,
    fetchImpl,
  });
  log(`Verification succeeded: listed Vertex ragCorpora in ${project}/${location}. Empty lists count as success.`);

  const handle = `gcp.${accountRole}`;
  upsertConnectedHandle({
    handle,
    provider: 'gcp',
    accountRole,
    trustDomain: 'internal',
    allowedCapabilities: ['domain_expert.google_rag'],
    scopes: [GOOGLE_SCOPE],
    tokenSecretRefs: [`store:${secretKey}`],
    connectedAt: now().toISOString(),
    providerAccountId: serviceAccount.email,
  }, registryPath);
  log(`Registered connected handle ${handle}.`);
  log('Domain-expert worker wiring: set OLYMPUS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_FIELD=service_account_json and point the runtime secret field at this stored service-account JSON.');

  return {
    ok: true,
    source: 'gcp',
    handles: [handle],
    registryPath,
    secretRefs: [`store:${secretKey}`],
    next: `Bootstrap a domain, create a Vertex RAG corpus in ${project}, then run the domain-expert worker with OLYMPUS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_FIELD=service_account_json.`,
    messages,
  };
}

function cleanExit(registryPath: string, messages: string[], next: string): ConnectResult {
  return {
    ok: true,
    source: 'gcp',
    handles: [],
    registryPath,
    secretRefs: [],
    next,
    messages,
  };
}

async function resolveProject(options: {
  project: string | undefined;
  exec: GcloudExec;
  input: ((prompt: string) => string | Promise<string>) | undefined;
  log: (message: string) => void;
}): Promise<string> {
  if (options.project?.trim()) return safeProjectId(options.project);
  const listed = await options.exec('gcloud', ['projects', 'list', '--format=json']);
  if (listed.status === 0) {
    const projects = parseJsonArray(listed.stdout)
      .map((project) => typeof project.projectId === 'string' ? project.projectId : '')
      .filter(Boolean);
    if (projects.length > 0) {
      options.log(`Existing projects: ${projects.join(', ')}`);
    }
  }
  if (!options.input) throw new Error('--project is required when no interactive input function is available.');
  return safeProjectId(await options.input('Enter the GCP project id to use or create: '));
}

async function missingServices(project: string, exec: GcloudExec): Promise<string[]> {
  const result = await exec('gcloud', [
    'services',
    'list',
    '--enabled',
    '--project',
    project,
    '--format=value(config.name)',
  ]);
  if (result.status !== 0) return [...REQUIRED_APIS];
  const enabled = new Set(result.stdout.split(/\s+/).map((value) => value.trim()).filter(Boolean));
  return REQUIRED_APIS.filter((api) => !enabled.has(api));
}

async function projectRolesForMember(project: string, serviceAccountEmail: string, exec: GcloudExec): Promise<Set<string>> {
  const result = await exec('gcloud', ['projects', 'get-iam-policy', project, '--format=json']);
  if (result.status !== 0) return new Set();
  const policy = parseJsonObject(result.stdout);
  const bindings = Array.isArray(policy.bindings) ? policy.bindings : [];
  const member = `serviceAccount:${serviceAccountEmail}`;
  return new Set(bindings.flatMap((binding) => {
    if (!binding || typeof binding !== 'object') return [];
    const record = binding as Record<string, unknown>;
    if (typeof record.role !== 'string' || !Array.isArray(record.members)) return [];
    return record.members.includes(member) ? [record.role] : [];
  }));
}

async function approveAndRun(options: {
  command: GcloudCommand;
  exec: GcloudExec;
  yes: boolean | undefined;
  confirm: ((prompt: string) => boolean | Promise<boolean>) | undefined;
  log: (message: string) => void;
  prompt: string;
  capture?: boolean;
}): Promise<false | GcloudExecResult> {
  options.log(formatCommand(options.command));
  if (!options.yes) {
    const approved = options.confirm ? await options.confirm(`${options.prompt} [y/N] `) : false;
    if (!approved) {
      options.log('Owner declined. No further GCP mutations were run.');
      return false;
    }
  } else {
    options.log('Approved by --yes.');
  }
  const result = await options.exec(options.command.command, options.command.args);
  if (result.status !== 0) {
    throw new Error(`Command failed: ${formatCommand(options.command)}\n${result.stderr || result.stdout}`);
  }
  return result;
}

async function verifyStoredGcpCredential(options: {
  credential: GoogleServiceAccountKey;
  project: string;
  location: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  // No `sub`: this lane acts as the service account itself, not on behalf of a
  // delegated user.
  const assertion = signGoogleServiceAccountJwt({
    credential: options.credential,
    scopes: [GOOGLE_SCOPE],
  });
  const tokenResponse = await options.fetchImpl(googleServiceAccountTokenUrl(options.credential), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: GOOGLE_JWT_BEARER_GRANT_TYPE,
      assertion,
    }),
  });
  const tokenPayload = await readJsonResponse(tokenResponse, 'Google OAuth token mint');
  const accessToken = typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token : '';
  if (!accessToken) throw new Error('Google OAuth token mint did not return an access token.');
  const listUrl = `https://${options.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(options.project)}/locations/${encodeURIComponent(options.location)}/ragCorpora`;
  const listResponse = await options.fetchImpl(listUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
  await readJsonResponse(listResponse, 'Vertex ragCorpora list');
}

async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed with status ${response.status}.`);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function validateServiceAccountKey(rawCredential: string | undefined, expectedEmail: string): GoogleServiceAccountKey {
  return parseGoogleServiceAccountKey(rawCredential, { expectedClientEmail: expectedEmail });
}

function normalizeServiceAccount(value: string, project: string): { id: string; email: string } {
  const trimmed = value.trim();
  const email = trimmed.includes('@') ? trimmed : `${trimmed}@${project}.iam.gserviceaccount.com`;
  const match = /^([a-z][a-z0-9-]{4,28}[a-z0-9])@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/.exec(email);
  if (!match) throw new Error('--service-account must be a service-account id or email.');
  return { id: match[1]!, email };
}

function safeProjectId(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(trimmed)) throw new Error('--project must be a valid GCP project id.');
  return trimmed;
}

function safeLocation(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-z0-9-]{3,64}$/.test(trimmed)) throw new Error('--location must be a valid Google Cloud location.');
  return trimmed;
}

function safeAccountRole(value: string): string {
  const trimmed = value.trim();
  if (!isSafeSecretKey(trimmed)) throw new Error('--account-role must be a safe label.');
  return trimmed;
}

function buildPotentialMutatingPlan(options: { project: string; serviceAccount: string }): GcloudCommand[] {
  const serviceAccount = normalizeServiceAccount(options.serviceAccount, options.project);
  return [
    command('gcloud', ['projects', 'create', options.project]),
    command('gcloud', ['services', 'enable', ...REQUIRED_APIS, '--project', options.project]),
    command('gcloud', ['iam', 'service-accounts', 'create', serviceAccount.id, '--project', options.project, '--display-name', 'Olympus domain expert']),
    ...REQUIRED_ROLES.map((role) => command('gcloud', [
      'projects',
      'add-iam-policy-binding',
      options.project,
      `--member=serviceAccount:${serviceAccount.email}`,
      `--role=${role}`,
    ])),
    command('gcloud', ['iam', 'service-accounts', 'keys', 'create', '/dev/stdout', `--iam-account=${serviceAccount.email}`, '--project', options.project]),
  ];
}

function command(commandName: string, args: string[]): GcloudCommand {
  return { command: commandName, args };
}

function formatCommand(commandToFormat: GcloudCommand): string {
  return [commandToFormat.command, ...commandToFormat.args].map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('gcloud key creation did not return JSON on stdout.');
  return text.slice(start, end + 1);
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('Expected JSON object.');
  }
}

function parseJsonArray(text: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  } catch {
    return [];
  }
}

function defaultGcloudExec(commandName: string, args: string[]): Promise<GcloudExecResult> {
  return new Promise((resolve) => {
    const child = spawn(commandName, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on('error', (error) => {
      resolve({ status: 1, stdout: '', stderr: error.message });
    });
    child.on('close', (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
