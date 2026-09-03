import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { connectGcpSource, type GcloudExec, type GcloudExecResult } from '../src/core/connect-gcp.ts';
import { EncryptedFileSecretStore } from '../src/core/secret-store.ts';

describe('olympus connect gcp', () => {
  test('runs the full fresh-project path, stores the key, registers the handle, and verifies Vertex', async () => {
    const fixture = createFixture();
    const execCalls: string[] = [];
    const fetchCalls: Array<{ url: string; method: string; authorization?: string }> = [];
    const result = await connectGcpSource({
      project: 'olympus-fixture-project',
      serviceAccount: 'olympus-secure',
      yes: true,
      registryPath: fixture.registryPath,
      secretStore: fixture.store,
      exec: fakeGcloud(execCalls, {
        projectsExist: false,
        services: [],
        serviceAccountExists: false,
        policyRoles: [],
        keyJson: fixture.keyJson,
      }),
      fetch: fakeGoogleFetch(fetchCalls),
      now: () => new Date('2026-07-05T12:00:00.000Z'),
    });

    expect(execCalls).toContain('gcloud projects create olympus-fixture-project');
    expect(execCalls).toContain('gcloud services enable aiplatform.googleapis.com storage.googleapis.com --project olympus-fixture-project');
    expect(execCalls).toContain("gcloud iam service-accounts create olympus-secure --project olympus-fixture-project --display-name 'Olympus domain expert'");
    expect(execCalls).toContain('gcloud projects add-iam-policy-binding olympus-fixture-project --member=serviceAccount:olympus-secure@olympus-fixture-project.iam.gserviceaccount.com --role=roles/aiplatform.user');
    expect(execCalls).toContain('gcloud projects add-iam-policy-binding olympus-fixture-project --member=serviceAccount:olympus-secure@olympus-fixture-project.iam.gserviceaccount.com --role=roles/storage.admin');
    expect(execCalls).toContain('gcloud iam service-accounts keys create /dev/stdout --iam-account=olympus-secure@olympus-fixture-project.iam.gserviceaccount.com --project olympus-fixture-project');
    expect(fetchCalls.map((call) => call.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://us-central1-aiplatform.googleapis.com/v1/projects/olympus-fixture-project/locations/us-central1/ragCorpora',
    ]);
    expect(fetchCalls[1]!.authorization).toBe('Bearer vertex-access-token');
    expect(result).toMatchObject({
      ok: true,
      source: 'gcp',
      handles: ['gcp.domain_expert'],
      registryPath: fixture.registryPath,
      secretRefs: ['store:gcp.domain_expert.service_account_json'],
    });
    expect(await fixture.store.get('gcp.domain_expert.service_account_json')).toBe(fixture.keyJson);
    const registry = JSON.parse(readFileSync(fixture.registryPath, 'utf8')) as any;
    expect(registry.handles).toEqual([expect.objectContaining({
      handle: 'gcp.domain_expert',
      provider: 'gcp',
      providerAccountId: 'olympus-secure@olympus-fixture-project.iam.gserviceaccount.com',
      tokenSecretRefs: ['store:gcp.domain_expert.service_account_json'],
      allowedCapabilities: ['domain_expert.google_rag'],
    })]);
    expect(readFileSync(fixture.registryPath, 'utf8')).not.toContain(fixture.privateKey);
    fixture.cleanup();
  });

  test('resumes when service account and grants already exist, then creates and stores a missing key', async () => {
    const fixture = createFixture();
    const execCalls: string[] = [];
    const result = await connectGcpSource({
      project: 'olympus-fixture-project',
      serviceAccount: 'olympus-secure',
      yes: true,
      registryPath: fixture.registryPath,
      secretStore: fixture.store,
      exec: fakeGcloud(execCalls, {
        projectsExist: true,
        services: ['aiplatform.googleapis.com', 'storage.googleapis.com'],
        serviceAccountExists: true,
        policyRoles: ['roles/aiplatform.user', 'roles/storage.admin'],
        keyJson: fixture.keyJson,
      }),
      fetch: fakeGoogleFetch([]),
    });

    expect(execCalls.some((call) => call.includes('service-accounts create'))).toBe(false);
    expect(execCalls.some((call) => call.includes('add-iam-policy-binding'))).toBe(false);
    expect(execCalls).toContain('gcloud iam service-accounts keys create /dev/stdout --iam-account=olympus-secure@olympus-fixture-project.iam.gserviceaccount.com --project olympus-fixture-project');
    expect(result.messages?.join('\n')).toContain('Service account olympus-secure@olympus-fixture-project.iam.gserviceaccount.com already exists');
    expect(result.messages?.join('\n')).toContain('roles/aiplatform.user already granted');
    expect(await fixture.store.get('gcp.domain_expert.service_account_json')).toBe(fixture.keyJson);
    fixture.cleanup();
  });

  test('stops cleanly when the owner declines an IAM grant', async () => {
    const fixture = createFixture();
    const execCalls: string[] = [];
    const result = await connectGcpSource({
      project: 'olympus-fixture-project',
      serviceAccount: 'olympus-secure',
      registryPath: fixture.registryPath,
      secretStore: fixture.store,
      exec: fakeGcloud(execCalls, {
        projectsExist: true,
        services: ['aiplatform.googleapis.com', 'storage.googleapis.com'],
        serviceAccountExists: true,
        policyRoles: [],
        keyJson: fixture.keyJson,
      }),
      fetch: fakeGoogleFetch([]),
      confirm: async (prompt) => {
        expect(prompt).toContain('OWNER APPROVAL BOUNDARY');
        return false;
      },
    });

    expect(result).toMatchObject({ ok: true, source: 'gcp', handles: [], secretRefs: [] });
    expect(result.next).toContain('Grant declined');
    expect(result.messages).toContain('gcloud projects add-iam-policy-binding olympus-fixture-project --member=serviceAccount:olympus-secure@olympus-fixture-project.iam.gserviceaccount.com --role=roles/aiplatform.user');
    expect(execCalls.some((call) => call.includes('add-iam-policy-binding'))).toBe(false);
    expect(execCalls.some((call) => call.includes('roles/storage.admin'))).toBe(false);
    expect(execCalls.some((call) => call.includes('keys create'))).toBe(false);
    expect(await fixture.store.list()).toEqual([]);
    fixture.cleanup();
  });

  test('exits cleanly when gcloud is not authenticated', async () => {
    const fixture = createFixture();
    const execCalls: string[] = [];
    const result = await connectGcpSource({
      project: 'olympus-fixture-project',
      serviceAccount: 'olympus-secure',
      registryPath: fixture.registryPath,
      secretStore: fixture.store,
      exec: async (command, args) => {
        execCalls.push([command, ...args].join(' '));
        if (args[0] === '--version') return ok('Google Cloud SDK fixture');
        if (args[0] === 'auth') return ok('');
        throw new Error('unexpected command after unauthenticated preflight');
      },
      fetch: fakeGoogleFetch([]),
    });

    expect(execCalls).toEqual([
      'gcloud --version',
      'gcloud auth list --filter=status:ACTIVE --format=value(account)',
    ]);
    expect(result).toMatchObject({ ok: true, source: 'gcp', handles: [], secretRefs: [] });
    expect(result.next).toContain('gcloud auth login');
    fixture.cleanup();
  });

  test('dry-run prints the full mutation plan and executes nothing', async () => {
    const fixture = createFixture();
    const execCalls: string[] = [];
    const fetchCalls: Array<{ url: string; method: string }> = [];
    const result = await connectGcpSource({
      project: 'olympus-fixture-project',
      serviceAccount: 'olympus-secure',
      dryRun: true,
      registryPath: fixture.registryPath,
      secretStore: fixture.store,
      exec: fakeGcloud(execCalls, {
        projectsExist: false,
        services: [],
        serviceAccountExists: false,
        policyRoles: [],
        keyJson: fixture.keyJson,
      }),
      fetch: fakeGoogleFetch(fetchCalls),
    });

    expect(execCalls).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(await fixture.store.list()).toEqual([]);
    expect(result.messages).toEqual([
      'Dry run: no gcloud commands, network calls, secret writes, or registry writes will run.',
      'gcloud projects create olympus-fixture-project',
      'gcloud services enable aiplatform.googleapis.com storage.googleapis.com --project olympus-fixture-project',
      "gcloud iam service-accounts create olympus-secure --project olympus-fixture-project --display-name 'Olympus domain expert'",
      'gcloud projects add-iam-policy-binding olympus-fixture-project --member=serviceAccount:olympus-secure@olympus-fixture-project.iam.gserviceaccount.com --role=roles/aiplatform.user',
      'gcloud projects add-iam-policy-binding olympus-fixture-project --member=serviceAccount:olympus-secure@olympus-fixture-project.iam.gserviceaccount.com --role=roles/storage.admin',
      'gcloud iam service-accounts keys create /dev/stdout --iam-account=olympus-secure@olympus-fixture-project.iam.gserviceaccount.com --project olympus-fixture-project',
    ]);
    fixture.cleanup();
  });
});

function createFixture(): {
  dir: string;
  registryPath: string;
  store: EncryptedFileSecretStore;
  privateKey: string;
  keyJson: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-gcp-test-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyJson = JSON.stringify({
    type: 'service_account',
    project_id: 'olympus-fixture-project',
    private_key_id: 'fixture-key-id',
    private_key: privateKeyPem,
    client_email: 'olympus-secure@olympus-fixture-project.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  return {
    dir,
    registryPath: join(dir, 'handles.json'),
    store: new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    }),
    privateKey: privateKeyPem,
    keyJson,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function fakeGcloud(calls: string[], options: {
  projectsExist: boolean;
  services: string[];
  serviceAccountExists: boolean;
  policyRoles: string[];
  keyJson: string;
}): GcloudExec {
  return async (command, args) => {
    calls.push([command, ...args].map(shellQuote).join(' '));
    if (args[0] === '--version') return ok('Google Cloud SDK fixture');
    if (args[0] === 'auth') return ok('owner@example.com\n');
    if (args.join(' ') === 'projects describe olympus-fixture-project --format=json') {
      return options.projectsExist ? ok(JSON.stringify({ projectId: 'olympus-fixture-project' })) : fail('not found');
    }
    if (args[0] === 'projects' && args[1] === 'create') return ok('{}');
    if (args[0] === 'services' && args[1] === 'list') return ok(`${options.services.join('\n')}\n`);
    if (args[0] === 'services' && args[1] === 'enable') return ok('{}');
    if (args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'describe') {
      return options.serviceAccountExists ? ok('{}') : fail('not found');
    }
    if (args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'create') return ok('{}');
    if (args[0] === 'projects' && args[1] === 'get-iam-policy') {
      return ok(JSON.stringify({
        bindings: options.policyRoles.map((role) => ({
          role,
          members: ['serviceAccount:olympus-secure@olympus-fixture-project.iam.gserviceaccount.com'],
        })),
      }));
    }
    if (args[0] === 'projects' && args[1] === 'add-iam-policy-binding') return ok('{}');
    if (args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'keys' && args[3] === 'create') {
      return ok(options.keyJson);
    }
    return fail(`unexpected command: ${command} ${args.join(' ')}`);
  };
}

function fakeGoogleFetch(calls: Array<{ url: string; method: string; authorization?: string }>): typeof fetch {
  return (async (input: URL | string | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(headers.get('authorization') ? { authorization: headers.get('authorization')! } : {}),
    });
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'vertex-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/ragCorpora')) {
      return new Response(JSON.stringify({ ragCorpora: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404 });
  }) as typeof fetch;
}

function ok(stdout: string): GcloudExecResult {
  return { status: 0, stdout, stderr: '' };
}

function fail(stderr: string): GcloudExecResult {
  return { status: 1, stdout: '', stderr };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
