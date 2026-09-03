import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  CredentialBrokerError,
  createEnvCredentialBroker,
  safeCredentialSessionAudit,
  type CredentialOAuth2HandleState,
  type CredentialOAuth2StateStore,
} from '../src/workers/credential-broker/index.ts';
import {
  parseGoogleServiceAccountKey,
  signGoogleServiceAccountJwt,
} from '../src/core/google-service-account.ts';

// Every key in this file is generated here and thrown away when the process
// exits. No real service-account material may appear in a fixture.
const THROWAWAY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'olympus-fixture-project',
  private_key_id: 'fixture-key-id',
  private_key: THROWAWAY.privateKey,
  client_email: 'olympus-secure@olympus-fixture-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
const DOCUMENTS_READONLY = 'https://www.googleapis.com/auth/documents.readonly';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('credential broker service-account JWT lane', () => {
  test('signs a delegated assertion whose subject is the handle\'s own mailbox', async () => {
    const personal = await mintDelegatedSession({
      handle: 'gmail.personal.delegated',
      provider: 'gmail',
      capability: 'gmail.email.sync',
      trustDomain: 'secure_local',
      namespace: 'test-sa-subject-personal',
    });
    const business = await mintDelegatedSession({
      handle: 'gmail.business_ocu.delegated',
      provider: 'gmail',
      capability: 'gmail.email.sync',
      trustDomain: 'secure_local',
      namespace: 'test-sa-subject-business',
    });

    // The whole point of domain-wide delegation: one key, two mailboxes,
    // selected by `sub`. A hardcoded subject would make these identical.
    expect(personal.claims.sub).toBe('owner-personal@example.test');
    expect(business.claims.sub).toBe('owner-business@example.test');
    expect(personal.claims.sub).not.toBe(business.claims.sub);

    for (const minted of [personal, business]) {
      expect(minted.header).toEqual({ alg: 'RS256', typ: 'JWT' });
      expect(minted.claims.iss).toBe('olympus-secure@olympus-fixture-project.iam.gserviceaccount.com');
      expect(minted.claims.aud).toBe('https://oauth2.googleapis.com/token');
      expect(minted.claims.scope).toBe(GMAIL_READONLY);
      expect(minted.claims.iat).toBe(Math.floor(Date.parse('2026-07-28T12:00:00.000Z') / 1000));
      expect(minted.claims.exp).toBe(minted.claims.iat + 3600);
      expect(minted.signatureValid).toBe(true);
      expect(minted.request.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    }
  });

  test('asks Drive only for drive.readonly, never the undelegated Docs scope', async () => {
    const minted = await mintDelegatedSession({
      handle: 'google_drive.personal.delegated',
      provider: 'google_drive',
      capability: 'google_drive.docs.sync',
      trustDomain: 'internal',
      namespace: 'test-sa-drive-scope',
    });

    expect(minted.claims.scope).toBe(DRIVE_READONLY);
    expect(minted.claims.scope).not.toContain(DOCUMENTS_READONLY);
    expect(minted.claims.sub).toBe('owner-personal@example.test');
    expect(minted.session.audit.scopes).toEqual([DRIVE_READONLY]);
  });

  test('issues a bearer session that never carries the key, the assertion, or the token', async () => {
    const minted = await mintDelegatedSession({
      handle: 'gmail.personal.delegated',
      provider: 'gmail',
      capability: 'gmail.email.sync',
      trustDomain: 'secure_local',
      namespace: 'test-sa-bearer-session',
    });

    expect(minted.session).toMatchObject({
      kind: 'bearer_token',
      handle: 'gmail.personal.delegated',
      provider: 'gmail',
      capability: 'gmail.email.sync',
      token: 'delegated-access-token-fixture',
      expiresAt: '2026-07-28T13:00:00.000Z',
    });
    const audit = safeCredentialSessionAudit(minted.session);
    expect(audit).toEqual({
      handle: 'gmail.personal.delegated',
      provider: 'gmail',
      capability: 'gmail.email.sync',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      scopes: [GMAIL_READONLY],
      outcome: 'issued',
      issuedAt: '2026-07-28T12:00:00.000Z',
      expiresAt: '2026-07-28T13:00:00.000Z',
      rawCredentialExposed: false,
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(THROWAWAY.privateKey);
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('fixture-key-id');
    expect(serialized).not.toContain('delegated-access-token-fixture');
  });

  test('reports the delegated handles through status without reading a token', async () => {
    const available = await createEnvCredentialBroker({
      env: { OLYMPUS_CREDENTIAL_GOOGLE_OLYMPUS_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON, OLYMPUS_CREDENTIAL_GOOGLE_PERSONAL_SUBJECT: 'owner-personal@example.test', OLYMPUS_CREDENTIAL_GOOGLE_BUSINESS_SUBJECT: 'owner-business@example.test' },
      oauth2StateStore: new MemoryOAuth2StateStore(),
      loadDefaultHandleRegistry: false,
    }).status?.('google_drive.personal.delegated');

    expect(available).toEqual({
      handle: 'google_drive.personal.delegated',
      provider: 'google_drive',
      sessionKind: 'bearer_token',
      accountRole: 'personal',
      trustDomain: 'internal',
      capabilities: ['google_drive.docs.sync'],
      scopes: [DRIVE_READONLY],
      status: 'available',
      rawCredentialExposed: false,
    });
    expect(JSON.stringify(available)).not.toContain('PRIVATE KEY');

    const missing = await createEnvCredentialBroker({
      env: {},
      oauth2StateStore: new MemoryOAuth2StateStore(),
      loadDefaultHandleRegistry: false,
    }).status?.('gmail.business_ocu.delegated');
    expect(missing).toMatchObject({ handle: 'gmail.business_ocu.delegated', status: 'missing' });
  });

  test('fails loudly with credential_missing when the wrapper exported no key', async () => {
    const broker = createEnvCredentialBroker({
      env: {},
      oauth2StateStore: new MemoryOAuth2StateStore(),
      oauth2CacheNamespace: 'test-sa-missing-key',
      loadDefaultHandleRegistry: false,
      fetch: async () => {
        throw new Error('the broker must not reach the token endpoint without a key');
      },
    });

    await expect(broker.issueSession({
      handle: 'gmail.personal.delegated',
      provider: 'gmail',
      capability: 'gmail.email.sync',
      trustDomain: 'secure_local',
    })).rejects.toMatchObject({ code: 'credential_missing' });
  });

  test('stamps reauth_required when Google refuses the delegation, and leaks nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-sa-delegation-refused-'));
    temporaryRoots.push(dir);
    const registryPath = join(dir, 'handles.json');
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      handles: [bareRegistryEntry('google_drive.personal.delegated', 'google_drive', 'internal', [DRIVE_READONLY])],
    }));
    const stateStore = new MemoryOAuth2StateStore();
    const broker = createEnvCredentialBroker({
      env: { OLYMPUS_CREDENTIAL_GOOGLE_OLYMPUS_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON, OLYMPUS_CREDENTIAL_GOOGLE_PERSONAL_SUBJECT: 'owner-personal@example.test', OLYMPUS_CREDENTIAL_GOOGLE_BUSINESS_SUBJECT: 'owner-business@example.test' },
      handleRegistryPath: registryPath,
      oauth2StateStore: stateStore,
      oauth2CacheNamespace: 'test-sa-delegation-refused',
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      // What the live host returns for a scope that is not delegated.
      fetch: async () => new Response(JSON.stringify({
        error: 'unauthorized_client',
        error_description: 'Client is unauthorized to retrieve access tokens using this method.',
      }), { status: 401 }),
    });

    let thrown: unknown;
    try {
      await broker.issueSession({
        handle: 'google_drive.personal.delegated',
        provider: 'google_drive',
        capability: 'google_drive.docs.sync',
        trustDomain: 'internal',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CredentialBrokerError);
    expect((thrown as CredentialBrokerError).code).toBe('credential_reauth_required');
    expect(String(thrown)).not.toContain('PRIVATE KEY');
    expect(String(thrown)).not.toContain(THROWAWAY.privateKey);

    // Both loud signals survive: the state store and the on-disk registry.
    await expect(stateStore.load('google_drive.personal.delegated'))
      .resolves.toMatchObject({ status: 'reauth_required' });
    const disk = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      handles: Array<{ handle: string; backendState?: { status?: string } }>;
    };
    expect(disk.handles.find((entry) => entry.handle === 'google_drive.personal.delegated')?.backendState)
      .toMatchObject({ status: 'reauth_required' });
    expect(readFileSync(registryPath, 'utf8')).not.toContain('PRIVATE KEY');
  });

  test('treats a token-endpoint outage as retryable rather than terminal', async () => {
    const stateStore = new MemoryOAuth2StateStore();
    const broker = createEnvCredentialBroker({
      env: { OLYMPUS_CREDENTIAL_GOOGLE_OLYMPUS_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON, OLYMPUS_CREDENTIAL_GOOGLE_PERSONAL_SUBJECT: 'owner-personal@example.test', OLYMPUS_CREDENTIAL_GOOGLE_BUSINESS_SUBJECT: 'owner-business@example.test' },
      oauth2StateStore: stateStore,
      oauth2CacheNamespace: 'test-sa-transient-outage',
      oauth2RefreshFailureBackoffMs: 0,
      loadDefaultHandleRegistry: false,
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      fetch: async () => new Response('upstream unavailable', { status: 503 }),
    });

    await expect(broker.issueSession({
      handle: 'gmail.personal.delegated',
      provider: 'gmail',
      capability: 'gmail.email.sync',
      trustDomain: 'secure_local',
    })).rejects.toMatchObject({ code: 'credential_refresh_failed' });
    // A blip must not disable the handle the way a delegation refusal does.
    await expect(stateStore.load('gmail.personal.delegated')).resolves.toBeUndefined();
  });

  test('merges a bare registry entry into the delegated default and still mints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-sa-registry-merge-'));
    temporaryRoots.push(dir);
    const registryPath = join(dir, 'handles.json');
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      handles: [bareRegistryEntry('gmail.business_ocu.delegated', 'gmail', 'secure_local', [GMAIL_READONLY])],
    }));
    const requests: string[] = [];
    const broker = createEnvCredentialBroker({
      env: { OLYMPUS_CREDENTIAL_GOOGLE_OLYMPUS_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON, OLYMPUS_CREDENTIAL_GOOGLE_PERSONAL_SUBJECT: 'owner-personal@example.test', OLYMPUS_CREDENTIAL_GOOGLE_BUSINESS_SUBJECT: 'owner-business@example.test' },
      handleRegistryPath: registryPath,
      oauth2StateStore: new MemoryOAuth2StateStore(),
      oauth2CacheNamespace: 'test-sa-registry-merge',
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      fetch: async (_input, init) => {
        requests.push(String(init?.body));
        return new Response(JSON.stringify({
          access_token: 'delegated-access-token-fixture',
          expires_in: 3600,
          token_type: 'Bearer',
        }), { status: 200 });
      },
    });

    const session = await broker.issueSession({
      handle: 'gmail.business_ocu.delegated',
      provider: 'gmail',
      capability: 'gmail.email.sync',
      trustDomain: 'secure_local',
    });

    // A bare entry inherits the repo-owned subject: the registry has no way to
    // declare one, so handles.json cannot redirect impersonation.
    expect(session.kind).toBe('bearer_token');
    expect(session.audit.accountRole).toBe('business_ocu');
    expect(claimsFromRequestBody(requests[0]!).sub).toBe('owner-business@example.test');
  });

  test('refuses to sign an assertion with no scope', () => {
    const credential = parseGoogleServiceAccountKey(SERVICE_ACCOUNT_JSON);
    expect(() => signGoogleServiceAccountJwt({ credential, scopes: [] })).toThrow(/at least one scope/);
    expect(() => signGoogleServiceAccountJwt({ credential, scopes: [GMAIL_READONLY], subject: '  ' }))
      .toThrow(/non-empty/);
  });

  test('joins multiple scopes with a single space and drops duplicates', () => {
    const credential = parseGoogleServiceAccountKey(SERVICE_ACCOUNT_JSON);
    const assertion = signGoogleServiceAccountJwt({
      credential,
      scopes: [DRIVE_READONLY, GMAIL_READONLY, DRIVE_READONLY],
      subject: 'owner-personal@example.test',
    });
    expect(decodeSegment(assertion.split('.')[1]!).scope).toBe(`${DRIVE_READONLY} ${GMAIL_READONLY}`);
  });

  test('rejects malformed key JSON without echoing it', () => {
    expect(() => parseGoogleServiceAccountKey('{"type":"authorized_user"}'))
      .toThrow(/must be a service_account key/);
    expect(() => parseGoogleServiceAccountKey('not json at all')).toThrow(/not valid JSON/);
    try {
      parseGoogleServiceAccountKey(JSON.stringify({
        type: 'service_account',
        project_id: 'p',
        client_email: 'a@b.iam.gserviceaccount.com',
        private_key: THROWAWAY.privateKey,
        token_uri: 'http://insecure.test/token',
      }));
      throw new Error('expected an https token_uri check');
    } catch (error) {
      expect(String(error)).toContain('token_uri must be an https URL');
      expect(String(error)).not.toContain(THROWAWAY.privateKey);
    }
  });
});

async function mintDelegatedSession(options: {
  handle: string;
  provider: 'gmail' | 'google_drive';
  capability: string;
  trustDomain: 'secure_local' | 'internal';
  namespace: string;
}): Promise<{
  session: Awaited<ReturnType<ReturnType<typeof createEnvCredentialBroker>['issueSession']>>;
  request: { url: string; body: string };
  header: Record<string, unknown>;
  claims: Record<string, any>;
  signatureValid: boolean;
}> {
  const requests: Array<{ url: string; body: string }> = [];
  const broker = createEnvCredentialBroker({
    env: { OLYMPUS_CREDENTIAL_GOOGLE_OLYMPUS_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON, OLYMPUS_CREDENTIAL_GOOGLE_PERSONAL_SUBJECT: 'owner-personal@example.test', OLYMPUS_CREDENTIAL_GOOGLE_BUSINESS_SUBJECT: 'owner-business@example.test' },
    oauth2StateStore: new MemoryOAuth2StateStore(),
    oauth2CacheNamespace: options.namespace,
    loadDefaultHandleRegistry: false,
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body) });
      return new Response(JSON.stringify({
        access_token: 'delegated-access-token-fixture',
        expires_in: 3600,
        token_type: 'Bearer',
      }), { status: 200 });
    },
  });

  const session = await broker.issueSession({
    handle: options.handle,
    provider: options.provider,
    capability: options.capability,
    trustDomain: options.trustDomain,
  });
  const request = requests[0]!;
  expect(request.url).toBe('https://oauth2.googleapis.com/token');
  const assertion = assertionFromRequestBody(request.body);
  const [header, claims, signature] = assertion.split('.') as [string, string, string];

  return {
    session,
    request,
    header: decodeSegment(header),
    claims: decodeSegment(claims),
    signatureValid: createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(THROWAWAY.publicKey, Buffer.from(signature, 'base64url')),
  };
}

function assertionFromRequestBody(body: string): string {
  const assertion = new URLSearchParams(body).get('assertion');
  if (!assertion) throw new Error('Token request carried no assertion.');
  return assertion;
}

function claimsFromRequestBody(body: string): Record<string, any> {
  return decodeSegment(assertionFromRequestBody(body).split('.')[1]!);
}

function decodeSegment(segment: string): Record<string, any> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, any>;
}

function bareRegistryEntry(
  handle: string,
  provider: string,
  trustDomain: string,
  scopes: string[],
): Record<string, unknown> {
  return {
    handle,
    provider,
    accountRole: handle.split('.')[1],
    trustDomain,
    allowedCapabilities: [provider === 'gmail' ? 'gmail.email.sync' : 'google_drive.docs.sync'],
    scopes,
    connectedAt: '2026-07-28T10:00:00.000Z',
  };
}

class MemoryOAuth2StateStore implements CredentialOAuth2StateStore {
  private readonly states = new Map<string, CredentialOAuth2HandleState>();

  async load(handle: string): Promise<CredentialOAuth2HandleState | undefined> {
    return this.states.get(handle);
  }

  async save(handle: string, state: CredentialOAuth2HandleState): Promise<void> {
    this.states.set(handle, { ...this.states.get(handle), ...state });
  }
}
