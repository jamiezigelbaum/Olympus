// OAuth 2.1 with pairing-code approval for hosted agents (hosted agents slice 4).
//
// Assembled the way the worker server assembles it: the OAuth routes, then
// `/mcp`, then the worker-bearer wrapper. A real MCP SDK client runs the whole
// authorization-code + PKCE flow against it over loopback, with a configured
// public base URL; the test plays the owner's browser on the approval page.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { defaultConfig } from '../src/core/config.ts';
import { runConnectionsCommand } from '../src/cli.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import {
  REMOTE_OAUTH_REFRESH_GRACE_MS,
  REMOTE_PAIRING_CODE_MAX_FAILURES,
  normalizePairingCode,
} from '../src/core/remote-oauth-store.ts';
import { assertSqliteSchemaCanOpen, readSqliteSchemaVersion } from '../src/core/sqlite-migrations.ts';
import { remoteConnectionsPreV2BackupPath } from '../src/core/remote-connections.ts';
import { deleteOlympusData, exportOlympusData } from '../src/data-lifecycle.ts';
import { createRemoteOpenApiHandler, withRemoteOpenApiRoutes } from '../src/workers/remote-openapi.ts';
import { readBoundedRequestText } from '../src/workers/remote-request-body.ts';
import { parseRemotePublicBaseUrl, type RemotePublicUrls } from '../src/core/remote-public-url.ts';
import { createRelayRequestVerifier, loadOrCreateRelayAuthSecret, RELAY_AUTH_HEADER, remoteAccessDir } from '../src/core/remote-access.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import {
  createInProcessOperationContext,
  createRemoteMcpHandler,
  withRemoteMcpRoute,
} from '../src/workers/remote-mcp.ts';
import {
  ClientMetadataError,
  createClientMetadataResolver,
  isPublicAddress,
  validateClientMetadataDocument,
  type ClientMetadata,
} from '../src/workers/remote-oauth/cimd.ts';
import { createRemoteOAuthHandler, withRemoteOAuthRoutes } from '../src/workers/remote-oauth/handler.ts';
import type {
  SourceAnswerLatencyLedgerRecord,
  SourceAnswerLatencyTraceRecord,
} from '../src/workers/source-index/answer-latency-log.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';

const WORKER_TOKEN = 'worker-bearer-token-for-remote-oauth-tests-0123456789';
const CLAUDE_CIMD_URL = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
// The document Claude serves at that URL (fetched 2026-09-24).
const CLAUDE_CIMD = {
  client_id: CLAUDE_CIMD_URL,
  client_name: 'Claude',
  client_uri: 'https://claude.ai',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};
// The document ChatGPT serves at https://chatgpt.com/oauth/client.json (fetched 2026-09-24).
const CHATGPT_CIMD = {
  client_id: 'https://chatgpt.com/oauth/client.json',
  client_uri: 'https://chatgpt.com/',
  redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  token_endpoint_auth_method: 'private_key_jwt',
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'ChatGPT',
  token_endpoint_auth_signing_alg: 'RS256',
  jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
};

function answerFixture(): SourceIndexAnswerResult {
  return {
    answer: 'released answer',
    evidence: [],
    audit: {
      searched_corpora: ['internal.email'],
      skipped_corpora: [],
      lane_audits: [],
      answer_synthesis: {
        analyst_backend: 'local',
        private_context_used: false,
        secure_local_items_consulted: 0,
        internal_items_consulted: 0,
        raw_source_exposed: false,
      },
      latency_ms: 5,
      raw_source_exposed: false,
    },
    policy: {
      raw_source_exposed: false,
      source_packets_exposed: false,
      internal_content_exposed: false,
      secure_local_content_exposed: false,
      castor_safe_bridge: true,
    },
    opsec: {
      structured_evidence: [],
      release_decision: { decision: 'allow', reasons: ['release_gate_passed'] },
      raw_source_exposed: false,
    },
  } as unknown as SourceIndexAnswerResult;
}

let dir: string;
let dbPath: string;
let store: RemoteConnectionStore;
let server: ReturnType<typeof Bun.serve>;
let ledger: SourceAnswerLatencyLedgerRecord[];
let base: string;
let urls: RemotePublicUrls;
let clock: number;
let handle: (request: Request) => Promise<Response>;
let cimdDocs: Record<string, unknown>;
let sleeps: number[];
/** The per-install secret the relay's local endpoint sends; see core/remote-access.ts. */
let relaySecret: string;

interface AssembleOptions {
  publicBaseUrl?: string | undefined;
  registrationBurst?: number;
}

function assemble(options: AssembleOptions = {}): void {
  const worker = createEmailSourceWorker({
    sourceAnswer: { async answer() { return answerFixture(); } },
    sourceAnswerLatencyLog: { record(entry) { ledger.push(entry); } },
    sourceIndexStatus: {
      async status() {
        return { kind: 'source_index_status', generated_at: '2026-09-24T00:00:00.000Z', corpora: [], policy: {} } as never;
      },
    },
  });
  const configured = 'publicBaseUrl' in options ? options.publicBaseUrl : base;
  const resolved = parseRemotePublicBaseUrl(configured);
  const publicUrls = resolved.enabled ? resolved.urls : undefined;
  if (publicUrls) urls = publicUrls;
  // Metadata documents come from a table here; the pinned fetcher has its own tests below.
  const resolveClientMetadata = async (clientId: string): Promise<ClientMetadata> => {
    const document = cimdDocs[clientId];
    if (!document) throw new ClientMetadataError('Client metadata fetch returned HTTP 404.');
    return validateClientMetadataDocument(document, clientId);
  };
  const agentOptions = {
    connections: () => store,
    publicUrls,
    makeOperationContext: (caller: Parameters<typeof createInProcessOperationContext>[0]['caller'], signal: AbortSignal) =>
      createInProcessOperationContext({
        config: defaultConfig(),
        sourceIndexReadEnabled: true,
        workerFetch: worker.fetch,
        caller,
        signal,
      }),
  };
  const relayEnv = { XDG_DATA_HOME: join(dir, 'data') };
  relaySecret = loadOrCreateRelayAuthSecret(remoteAccessDir(relayEnv));
  handle = withRemoteOAuthRoutes(
    createRemoteOAuthHandler({
      publicUrls,
      trustRelayHeaders: createRelayRequestVerifier(relayEnv),
      connections: () => store,
      resolveClientMetadata,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); },
      ...(options.registrationBurst !== undefined ? { registrationBurst: options.registrationBurst } : {}),
    }),
    withRemoteOpenApiRoutes(
      createRemoteOpenApiHandler(agentOptions),
      withRemoteMcpRoute(
        createRemoteMcpHandler(agentOptions),
        withWorkerBearerAuth(worker.fetch, { authToken: WORKER_TOKEN }),
      ),
    ),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-remote-oauth-'));
  dbPath = join(dir, 'state', 'remote-connections.sqlite');
  clock = Date.parse('2026-09-24T12:00:00.000Z');
  store = openRemoteConnectionStore(dbPath, { now: () => new Date(clock) });
  ledger = [];
  sleeps = [];
  cimdDocs = { [CLAUDE_CIMD_URL]: CLAUDE_CIMD, [CHATGPT_CIMD.client_id]: CHATGPT_CIMD };
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handle(request) });
  base = `http://127.0.0.1:${server.port}`;
  assemble();
});

afterEach(() => {
  server.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

class TestOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  private client: OAuthClientInformationMixed | undefined;
  private saved: OAuthTokens | undefined;
  private verifier = '';
  readonly clientMetadataUrl?: string;
  constructor(private readonly redirect: string, private readonly name: string, clientMetadataUrl?: string) {
    if (clientMetadataUrl !== undefined) this.clientMetadataUrl = clientMetadataUrl;
  }
  get redirectUrl(): string { return this.redirect; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state(): string { return 'state-123'; }
  clientInformation(): OAuthClientInformationMixed | undefined { return this.client; }
  saveClientInformation(info: OAuthClientInformationMixed): void { this.client = info; }
  tokens(): OAuthTokens | undefined { return this.saved; }
  saveTokens(tokens: OAuthTokens): void { this.saved = tokens; }
  redirectToAuthorization(url: URL): void { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string { return this.verifier; }
}

function sdkTransport(provider: OAuthClientProvider): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
}

async function connectWith(provider: OAuthClientProvider): Promise<Client> {
  const client = new Client({ name: 'remote-oauth-test', version: '1.0.0' });
  await client.connect(sdkTransport(provider) as unknown as Parameters<Client['connect']>[0]);
  return client;
}

interface ConsentForm {
  requestId: string;
  csrf: string;
  cookie: string;
  html: string;
  response: Response;
}

async function openConsent(authorizationUrl: string | URL): Promise<ConsentForm> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  const html = await response.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { requestId, csrf, cookie, html, response };
}

function submitConsent(
  form: Pick<ConsentForm, 'requestId' | 'csrf' | 'cookie'>,
  fields: Record<string, string>,
  headers: Record<string, string> = { Origin: base, 'Sec-Fetch-Site': 'same-origin' },
): Promise<Response> {
  return fetch(`${base}/connect/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: form.cookie, ...headers },
    body: new URLSearchParams({ request_id: form.requestId, csrf: form.csrf, ...fields }).toString(),
  });
}

/** The owner's browser: open the approval page, type a fresh pairing code, follow nothing. */
async function approve(authorizationUrl: string | URL, pairingCode = store.oauth.mintPairingCode().code): Promise<URL> {
  const form = await openConsent(authorizationUrl);
  expect(form.response.status).toBe(200);
  const response = await submitConsent(form, { action: 'approve', pairing_code: pairingCode });
  expect(response.status).toBe(303);
  return new URL(response.headers.get('location')!);
}

/** Runs the SDK client through 401 → discovery → registration → approval → token exchange. */
async function authorizeWithSdk(provider: TestOAuthProvider): Promise<{ client: Client; callback: URL }> {
  const first = new Client({ name: 'remote-oauth-test', version: '1.0.0' });
  const transport = sdkTransport(provider);
  await expect(first.connect(transport as unknown as Parameters<Client['connect']>[0])).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.authorizationUrl).toBeDefined();
  const callback = await approve(provider.authorizationUrl!);
  await transport.finishAuth(callback.searchParams.get('code')!);
  return { client: await connectWith(provider), callback };
}

async function authorizeManually(input: {
  clientId: string;
  redirectUri: string;
  verifier?: string;
  resource?: string;
}): Promise<{ code: string; verifier: string }> {
  const verifier = input.verifier ?? 'v'.repeat(43) + Math.random().toString(36).slice(2);
  const challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
  const url = new URL(`${base}/connect/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 's',
    resource: input.resource ?? urls.resource,
  }).toString();
  const callback = await approve(url);
  return { code: callback.searchParams.get('code')!, verifier };
}

function tokenRequest(fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

async function exchange(clientId: string, redirectUri: string, code: string, verifier: string) {
  const response = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    resource: urls.resource,
  });
  return { status: response.status, body: await response.json() as Record<string, string> };
}

async function claudeGrant() {
  const redirectUri = CLAUDE_CIMD.redirect_uris[0]!;
  const { code, verifier } = await authorizeManually({ clientId: CLAUDE_CIMD_URL, redirectUri });
  const tokens = await exchange(CLAUDE_CIMD_URL, redirectUri, code, verifier);
  expect(tokens.status).toBe(200);
  return tokens.body as { access_token: string; refresh_token: string; expires_in: string };
}

function mcpInitialize(authorization?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
    }),
  });
}

describe('end to end with the MCP SDK OAuth client', () => {
  test('dynamic registration, pairing-code approval, PKCE exchange, then attributed answers', async () => {
    const provider = new TestOAuthProvider('http://127.0.0.1:43123/callback', 'Grok');
    const { client, callback } = await authorizeWithSdk(provider);
    try {
      // RFC 9207: the redirect names the issuer, and it is the configured one.
      expect(callback.searchParams.get('iss')).toBe(base);
      expect(callback.searchParams.get('state')).toBe('state-123');
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['source_answer', 'source_index_status']);
      await client.callTool({ name: 'source_answer', arguments: { question: 'what changed?' } });
    } finally {
      await client.close();
    }
    const [connection] = store.list();
    expect(connection).toMatchObject({ kind: 'oauth', displayName: 'Grok', revokedAt: null });
    expect(connection!.clientId).toStartWith('olympus_client_');
    const trace = ledger.find((r): r is SourceAnswerLatencyTraceRecord => r.kind === 'source_answer_latency_trace');
    expect(trace?.caller).toEqual({ surface: 'remote', connection_id: connection!.id, display_name: 'Grok' });
  });

  test('a metadata-document client (Claude) is named from its document and needs no registration', async () => {
    const provider = new TestOAuthProvider(CLAUDE_CIMD.redirect_uris[0]!, 'ignored', CLAUDE_CIMD_URL);
    const first = new Client({ name: 'remote-oauth-test', version: '1.0.0' });
    const transport = sdkTransport(provider);
    await expect(first.connect(transport as unknown as Parameters<Client['connect']>[0])).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.authorizationUrl!.searchParams.get('client_id')).toBe(CLAUDE_CIMD_URL);
    expect(provider.authorizationUrl!.searchParams.get('resource')).toBe(urls.resource);
    const page = await openConsent(provider.authorizationUrl!);
    expect(page.html).toContain('Connect Claude to Olympus?');
    expect(page.html).toContain('<div class="name">Claude</div>\n<div class="host">claude.ai</div>');
    expect(page.html).not.toContain('sends you back to');
    expect(page.html).toContain('you return to <strong>claude.ai</strong>');
    const approved = await submitConsent(page, { action: 'approve', pairing_code: store.oauth.mintPairingCode().code });
    const callback = new URL(approved.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
    await transport.finishAuth(callback.searchParams.get('code')!);
    const client = await connectWith(provider);
    await client.callTool({ name: 'source_answer', arguments: { question: 'hi' } });
    await client.close();
    expect(store.list()).toMatchObject([{ kind: 'oauth', displayName: 'Claude', clientId: CLAUDE_CIMD_URL }]);
    const trace = ledger.find((r): r is SourceAnswerLatencyTraceRecord => r.kind === 'source_answer_latency_trace');
    expect(trace?.caller?.display_name).toBe('Claude');
  });

  test("ChatGPT's metadata document is accepted as a public client", async () => {
    const redirectUri = CHATGPT_CIMD.redirect_uris[0]!;
    const { code, verifier } = await authorizeManually({ clientId: CHATGPT_CIMD.client_id, redirectUri });
    const tokens = await exchange(CHATGPT_CIMD.client_id, redirectUri, code, verifier);
    expect(tokens.status).toBe(200);
    expect(store.list()[0]).toMatchObject({ displayName: 'ChatGPT' });
  });
});

describe('metadata and discovery', () => {
  test('protected-resource and authorization-server metadata carry the configured URLs', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const prm = await (await fetch(`${base}${path}`)).json();
      expect(prm).toEqual({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        resource_name: 'Olympus',
      });
    }
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/connect/authorize`,
      token_endpoint: `${base}/connect/token`,
      registration_endpoint: `${base}/connect/register`,
      revocation_endpoint: `${base}/connect/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  test('a 401 from /mcp names the protected-resource metadata', async () => {
    const missing = await mcpInitialize();
    expect(missing.status).toBe(401);
    expect(missing.headers.get('WWW-Authenticate'))
      .toBe(`Bearer realm="olympus", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await mcpInitialize('Bearer olympus_at_' + 'A'.repeat(43));
    expect(bad.status).toBe(401);
    expect(bad.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    expect(bad.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
  });

  test('the Host header never shapes the issuer or resource, and a foreign Host is refused', async () => {
    assemble({ publicBaseUrl: 'https://abc123.connect.olympusplugin.ai' });
    const get = (path: string, headers: Record<string, string>) =>
      handle(new Request(`http://127.0.0.1:8123${path}`, { headers }));
    const forged = { host: '127.0.0.1:8123', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' };
    const as = await (await get('/.well-known/oauth-authorization-server', forged)).json() as { issuer: string };
    expect(as.issuer).toBe('https://abc123.connect.olympusplugin.ai');
    const viaRelay = await (await get('/.well-known/oauth-protected-resource/mcp', { host: 'abc123.connect.olympusplugin.ai' })).json();
    expect(viaRelay).toMatchObject({ resource: 'https://abc123.connect.olympusplugin.ai/mcp' });
    // DNS rebinding: an attacker's page reaching loopback still carries its own Host.
    expect((await get('/.well-known/oauth-authorization-server', { host: 'evil.example' })).status).toBe(421);
    expect((await get('/connect/authorize', { host: 'rebind.attacker.example:8123' })).status).toBe(421);
  });

  test('loopback Host names are accepted in every form; lookalikes are not', async () => {
    assemble({ publicBaseUrl: 'https://abc123.connect.olympusplugin.ai' });
    const get = (host: string) => handle(new Request('http://127.0.0.1:8123/.well-known/oauth-authorization-server', { headers: { host } }));
    for (const host of ['127.0.0.1:8123', 'localhost:8123', '[::1]:8123', 'LOCALHOST:8123', '127.0.0.1', 'ABC123.connect.olympusplugin.ai']) {
      expect((await get(host)).status, host).toBe(200);
    }
    for (const host of ['localhost.evil.example', '127.0.0.1.nip.io:8123', 'abc123.connect.olympusplugin.ai.evil.example', '127.0.0.2:8123', 'other.connect.olympusplugin.ai']) {
      expect((await get(host)).status, host).toBe(421);
    }
  });

  test('with no public base URL, OAuth is off and bearer connections still work', async () => {
    assemble({ publicBaseUrl: undefined });
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/connect/authorize']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect((await fetch(`${base}/connect/token`, { method: 'POST' })).status).toBe(404);
    const missing = await mcpInitialize();
    expect(missing.headers.get('WWW-Authenticate')).toBe('Bearer realm="olympus"');
    const { token } = store.create('Muse');
    expect((await mcpInitialize(`Bearer ${token}`)).status).toBe(200);
  });

  test('an OAuth token is refused when OAuth is off or the configured resource changed', async () => {
    const tokens = await claudeGrant();
    expect((await mcpInitialize(`Bearer ${tokens.access_token}`)).status).toBe(200);
    assemble({ publicBaseUrl: 'https://moved.example' });
    expect((await mcpInitialize(`Bearer ${tokens.access_token}`)).status).toBe(401);
    assemble({ publicBaseUrl: undefined });
    expect((await mcpInitialize(`Bearer ${tokens.access_token}`)).status).toBe(401);
  });

  test('public base URL parsing accepts origins only', () => {
    expect(parseRemotePublicBaseUrl('https://x.example/')).toMatchObject({ enabled: true, urls: { issuer: 'https://x.example' } });
    expect(parseRemotePublicBaseUrl('HTTPS://X.Example')).toMatchObject({ enabled: true, urls: { resource: 'https://x.example/mcp' } });
    for (const bad of ['http://x.example', 'https://x.example/sub', 'https://x.example/?a=1', 'https://u:p@x.example', 'ftp://x', 'nope']) {
      expect(parseRemotePublicBaseUrl(bad)).toMatchObject({ enabled: false, reason: 'invalid' });
    }
    expect(parseRemotePublicBaseUrl('  ')).toEqual({ enabled: false, reason: 'not_configured' });
  });
});

describe('authorization request validation', () => {
  const claudeRedirect = CLAUDE_CIMD.redirect_uris[0]!;
  const authorizeUrl = (params: Record<string, string>) => {
    const url = new URL(`${base}/connect/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLAUDE_CIMD_URL,
      redirect_uri: claudeRedirect,
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      state: 's',
      ...params,
    }).toString();
    return url;
  };

  test('an unlisted redirect URI or unknown client stays on an error page instead of redirecting', async () => {
    for (const params of [
      { redirect_uri: 'https://attacker.example/cb' },
      { client_id: 'olympus_client_000000000000000000000000' },
      { client_id: 'https://unknown.example/client.json' },
    ]) {
      const response = await fetch(authorizeUrl(params), { redirect: 'manual' });
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
    }
  });

  test('a wrong resource, missing PKCE, or plain PKCE is sent back as an error with iss', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
      [{ resource: `${base}/mcp/other` }, 'invalid_target'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ];
    for (const [params, error] of cases) {
      const response = await fetch(authorizeUrl(params), { redirect: 'manual' });
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get('location')!);
      expect(location.searchParams.get('error')).toBe(error);
      expect(location.searchParams.get('iss')).toBe(base);
      expect(location.searchParams.get('state')).toBe('s');
    }
  });

  test('the approval page is framed by nothing, loads nothing, and escapes the client name', async () => {
    const registered = await fetch(`${base}/connect/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: '<script>alert(1)</script>"x', redirect_uris: ['https://grok.com/connectors/oauth/callback'] }),
    });
    const { client_id } = await registered.json() as { client_id: string };
    const page = await openConsent(authorizeUrl({ client_id, redirect_uri: 'https://grok.com/connectors/oauth/callback' }));
    expect(page.html).not.toContain('<script>');
    expect(page.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;x');
    expect(page.html).toContain('Not verified');
    const csp = page.response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self' https://grok.com");
    expect(page.response.headers.get('x-frame-options')).toBe('DENY');
    expect(page.cookie).toStartWith(`olympus_consent_${page.requestId}=`);
    expect(page.response.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect(page.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(page.html).not.toMatch(/https?:\/\/(?!claude|grok)[^"\s<]*\.(js|css|png|woff)/);
  });

  test('the approval POST needs the page cookie, a matching token and a same-origin browser', async () => {
    const page = await openConsent(authorizeUrl({}));
    const code = store.oauth.mintPairingCode().code;
    const fields = { action: 'approve', pairing_code: code };
    expect((await submitConsent({ ...page, cookie: '' }, fields)).status).toBe(403);
    expect((await submitConsent({ ...page, csrf: 'x'.repeat(43) }, fields)).status).toBe(403);
    expect((await submitConsent(page, fields, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await submitConsent(page, fields, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    // None of those spent the code.
    const ok = await submitConsent(page, fields);
    expect(ok.status).toBe(303);
    expect(new URL(ok.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });

  test('a redirect off the publishing host is called out', async () => {
    cimdDocs['https://apps.example/client.json'] = {
      client_id: 'https://apps.example/client.json',
      client_name: 'Example',
      redirect_uris: ['https://callback.other.example/cb'],
    };
    const page = await openConsent(authorizeUrl({
      client_id: 'https://apps.example/client.json',
      redirect_uri: 'https://callback.other.example/cb',
    }));
    expect(page.html).toContain('<div class="host">apps.example</div>');
    expect(page.html).toContain('published by <strong>apps.example</strong> but sends you back to <strong>callback.other.example</strong>');
  });

  test('deny sends access_denied back to the client', async () => {
    const page = await openConsent(authorizeUrl({}));
    const response = await submitConsent(page, { action: 'deny' });
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('iss')).toBe(base);
  });

  test('loopback redirects match on any port and get a warning; others must match exactly', async () => {
    const registered = await fetch(`${base}/connect/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'] }),
    });
    const { client_id } = await registered.json() as { client_id: string };
    const page = await openConsent(authorizeUrl({ client_id, redirect_uri: 'http://127.0.0.1:53111/callback' }));
    expect(page.response.status).toBe(200);
    expect(page.html).toContain('a program on a computer');
    const wrongPath = await fetch(authorizeUrl({ client_id, redirect_uri: 'http://127.0.0.1:53111/other' }), { redirect: 'manual' });
    expect(wrongPath.status).toBe(400);
  });
});

describe('pairing codes', () => {
  test('codes are a selector plus a secret, typable, and single-use', async () => {
    const minted = store.oauth.mintPairingCode();
    expect(minted.code).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    const compact = minted.code.replaceAll('-', '');
    expect(normalizePairingCode(minted.code.toLowerCase().replaceAll('-', ' '))).toBe(compact);
    expect(store.oauth.checkPairingCode(minted.code.toLowerCase())).toEqual({ ok: true });
    expect(store.oauth.checkPairingCode(minted.code)).toEqual({ ok: false, reason: 'unknown' });
    // Only the secret's digest is stored.
    expect(readFileSync(dbPath).includes(Buffer.from(compact.slice(4)))).toBe(false);
  });

  test('codes expire after ten minutes', () => {
    const minted = store.oauth.mintPairingCode();
    clock += 10 * 60_000;
    expect(store.oauth.checkPairingCode(minted.code)).toEqual({ ok: false, reason: 'unknown' });
  });

  test('wrong secrets count only against the code their selector names', () => {
    const target = store.oauth.mintPairingCode();
    const other = store.oauth.mintPairingCode();
    const selector = target.code.slice(0, 4);
    const wrongSecret = target.code.endsWith('A') ? `${selector}-BBBB-BBBB` : `${selector}-AAAA-AAAA`;
    for (let i = 0; i < REMOTE_PAIRING_CODE_MAX_FAILURES; i += 1) {
      expect(store.oauth.checkPairingCode(wrongSecret)).toEqual({ ok: false, reason: 'wrong_secret' });
    }
    // That code is dead, even with its right secret; the other is untouched.
    expect(store.oauth.checkPairingCode(target.code)).toEqual({ ok: false, reason: 'unknown' });
    expect(store.oauth.checkPairingCode(other.code)).toEqual({ ok: true });
  });

  test('unknown selectors and malformed input burn nothing', () => {
    const live = store.oauth.mintPairingCode();
    const foreign = live.code.startsWith('A') ? 'BBBB-BBBB-BBBB' : 'AAAA-AAAA-AAAA';
    for (let i = 0; i < 50; i += 1) {
      expect(store.oauth.checkPairingCode(foreign)).toEqual({ ok: false, reason: 'unknown' });
      expect(store.oauth.checkPairingCode('0000-OOOO-1111')).toEqual({ ok: false, reason: 'malformed' });
      expect(store.oauth.checkPairingCode(live.code.slice(0, -1))).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(store.oauth.checkPairingCode(live.code)).toEqual({ ok: true });
  });

  const authorizeUrlFor = (client: { client_id: string; redirect_uris: string[] } = CLAUDE_CIMD) => {
    const url = new URL(`${base}/connect/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0]!,
      code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's',
    }).toString();
    return url;
  };
  const relayed = (address: string) => ({ 'x-olympus-relay': '1', 'x-forwarded-for': address, [RELAY_AUTH_HEADER]: relaySecret });
  const forged = (address: string, auth?: string) => ({
    'x-olympus-relay': '1',
    'x-forwarded-for': address,
    ...(auth === undefined ? {} : { [RELAY_AUTH_HEADER]: auth }),
  });
  const openFrom = async (headers: Record<string, string>, url: URL = authorizeUrlFor()) => {
    const response = await fetch(url, { redirect: 'manual', headers });
    const html = await response.text();
    return {
      response,
      requestId: /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? '',
      csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '',
      cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    };
  };

  test('one approval page allows five wrong codes, then sends access_denied; typos do not count', async () => {
    const page = await openConsent(authorizeUrlFor());
    const typo = await submitConsent(page, { action: 'approve', pairing_code: 'ABC' });
    expect(typo.status).toBe(400);
    expect(await typo.text()).toContain('looks like');
    for (let i = 0; i < 4; i += 1) {
      const retry = await submitConsent(page, { action: 'approve', pairing_code: 'AAAA-AAAA-AAAA' });
      expect(retry.status).toBe(400);
      expect(await retry.text()).toContain('not valid');
    }
    const last = await submitConsent(page, { action: 'approve', pairing_code: 'AAAA-AAAA-AAAA' });
    expect(last.status).toBe(303);
    expect(new URL(last.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    const after = await submitConsent(page, { action: 'approve', pairing_code: store.oauth.mintPairingCode().code });
    expect(after.status).toBe(400);
  });

  test('wrong codes slow their sender down, never close pairing for someone else', async () => {
    const attacker = relayed('203.0.113.9');
    const owner = relayed('198.51.100.20');
    const guess = async (headers: Record<string, string>, code = 'AAAA-AAAA-AAAA') => {
      const page = await openFrom(headers);
      return submitConsent(page, { action: 'approve', pairing_code: code }, { Origin: base, ...headers });
    };
    for (let i = 0; i < 5; i += 1) await guess(attacker);
    // 0s, then doubling: 1s, 2s, 4s, 8s.
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
    const refused = await guess(attacker);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Wait 16 seconds');
    // The owner, from another address, is not held at all.
    sleeps = [];
    const ownerTry = await guess(owner, store.oauth.mintPairingCode().code);
    expect(ownerTry.status).toBe(303);
    expect(sleeps).toEqual([]);
  });

  test('past a global threshold every check pays a small delay, but still runs', async () => {
    for (let i = 0; i < 21; i += 1) {
      const headers = relayed(`203.0.113.${i + 1}`);
      const page = await openFrom(headers);
      await submitConsent(page, { action: 'approve', pairing_code: 'AAAA-AAAA-AAAA' }, { Origin: base, ...headers });
    }
    sleeps = [];
    const headers = relayed('198.51.100.20');
    const page = await openFrom(headers);
    const ok = await submitConsent(page, { action: 'approve', pairing_code: store.oauth.mintPairingCode().code }, { Origin: base, ...headers });
    expect(ok.status).toBe(303);
    expect(sleeps).toEqual([2000]);
  });

  test('a direct loopback caller that forges the relay headers is still one direct caller', async () => {
    // Without the relay's secret (or with a wrong one), rotating the forged
    // agent address does not buy fresh per-caller slots or a fresh pacing
    // budget: every such request is the shared `direct` caller.
    const pages: Awaited<ReturnType<typeof openFrom>>[] = [];
    for (let i = 0; i < 8; i += 1) pages.push(await openFrom(forged(`203.0.113.${i + 1}`)));
    // Three more "addresses" are the same direct caller: each evicts that
    // caller's own oldest waiting approval instead of getting fresh slots.
    for (const headers of [forged('203.0.113.99'), forged('203.0.113.98', 'A'.repeat(43)), {}]) {
      expect((await openFrom(headers)).response.status).toBe(200);
    }
    const code = () => ({ action: 'approve', pairing_code: store.oauth.mintPairingCode().code });
    for (const evicted of pages.slice(0, 3)) {
      const gone = await submitConsent(evicted, code());
      expect(gone.status).toBe(400);
      expect(await gone.text()).toContain('replaced by a newer one');
    }
    expect((await submitConsent(pages[3]!, code())).status).toBe(303);
    // The real relay (with the secret) still gets per-address slots.
    expect((await openFrom(relayed('198.51.100.20'))).response.status).toBe(200);
  });

  test('forged relay headers do not dodge pairing pacing', async () => {
    const guess = async (headers: Record<string, string>) => {
      const page = await openFrom(headers);
      return submitConsent(page, { action: 'approve', pairing_code: 'AAAA-AAAA-AAAA' }, { Origin: base, ...headers });
    };
    for (let i = 0; i < 4; i += 1) await guess(forged(`203.0.113.${i + 1}`));
    // One doubling sequence for the single direct caller, not four fresh ones.
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  test('one caller holds at most eight waiting approvals; a ninth replaces its own oldest', async () => {
    const flooder = relayed('203.0.113.50');
    const owner = await openFrom(relayed('198.51.100.20'));
    const first = await openFrom(flooder);
    for (let i = 0; i < 8; i += 1) expect((await openFrom(flooder)).response.status).toBe(200);
    const code = () => ({ action: 'approve', pairing_code: store.oauth.mintPairingCode().code });
    expect((await submitConsent(first, code(), { Origin: base, ...flooder })).status).toBe(400);
    // Nobody else's approval moved.
    expect((await submitConsent(owner, code())).status).toBe(303);
    expect((await openFrom({})).response.status).toBe(200);
  });

  test('a full table evicts the heaviest holder, so a distributed flood never locks the owner out', async () => {
    // The review finding: 32 relay addresses x 8 used to fill all 256 slots
    // and answer everyone else 429 for ten minutes.
    // Half the flood names Claude, half ChatGPT, so neither app's cap binds first.
    const floodClient = (a: number) => authorizeUrlFor(a < 16 ? CLAUDE_CIMD : CHATGPT_CIMD);
    const floods = new Map<string, Awaited<ReturnType<typeof openFrom>>[]>();
    for (let a = 0; a < 32; a += 1) {
      const headers = relayed(`203.0.113.${a + 1}`);
      const pages: Awaited<ReturnType<typeof openFrom>>[] = [];
      for (let i = 0; i < 8; i += 1) {
        const page = await openFrom(headers, floodClient(a));
        expect(page.response.status).toBe(200);
        pages.push(page);
      }
      floods.set(`203.0.113.${a + 1}`, pages);
    }
    // The table is full. The owner still gets a page, from a fresh address,
    // and can finish it while the flood keeps coming.
    const ownerHeaders = relayed('198.51.100.20');
    const owner = await openFrom(ownerHeaders);
    expect(owner.response.status).toBe(200);
    for (let a = 0; a < 32; a += 1) expect((await openFrom(relayed(`203.0.113.${a + 1}`), floodClient(a))).response.status).toBe(200);
    for (let i = 0; i < 40; i += 1) expect((await openFrom(relayed(`192.0.2.${i + 1}`))).response.status).toBe(200);
    const approved = await submitConsent(owner, { action: 'approve', pairing_code: store.oauth.mintPairingCode().code },
      { Origin: base, ...ownerHeaders });
    expect(approved.status).toBe(303);
    expect(new URL(approved.headers.get('location')!).searchParams.get('code')).toBeTruthy();
    // What made room was the flood's own oldest requests.
    const firstFlood = floods.get('203.0.113.1')![0]!;
    expect((await submitConsent(firstFlood, { action: 'deny' }, { Origin: base, ...relayed('203.0.113.1') })).status).toBe(400);
  });

  test('one client id cannot take every slot', async () => {
    // Anyone can start a request naming Claude's client id; past half the
    // table those requests evict each other instead of crowding out other apps.
    const chatgpt = await openConsent(authorizeUrlFor(CHATGPT_CIMD));
    const firsts: Awaited<ReturnType<typeof openFrom>>[] = [];
    for (let a = 0; a < 16; a += 1) {
      for (let i = 0; i < 8; i += 1) {
        const page = await openFrom(relayed(`203.0.113.${a + 1}`));
        if (i === 0) firsts.push(page);
      }
    }
    const deny = (page: typeof firsts[number], address: string) =>
      submitConsent(page, { action: 'deny' }, { Origin: base, ...relayed(address) });
    // 128 Claude requests wait. The next, from a new address, evicts the
    // oldest of them (every holder has eight), though the table is not full.
    expect((await openFrom(relayed('192.0.2.1'))).response.status).toBe(200);
    expect((await deny(firsts[0]!, '203.0.113.1')).status).toBe(400);
    expect((await deny(firsts[1]!, '203.0.113.2')).status).toBe(303);
    expect((await submitConsent(chatgpt, { action: 'approve', pairing_code: store.oauth.mintPairingCode().code })).status).toBe(303);
  });

  test('IPv6 callers are grouped by /64, so one host cannot mint callers', async () => {
    const owner = await openFrom(relayed('198.51.100.20'));
    const first = await openFrom(relayed('2001:db8:1:2::1'));
    // 300 more requests from 300 addresses inside one /64: all one caller.
    for (let i = 2; i < 302; i += 1) expect((await openFrom(relayed(`2001:db8:1:2::${i.toString(16)}`))).response.status).toBe(200);
    const code = () => ({ action: 'approve', pairing_code: store.oauth.mintPairingCode().code });
    expect((await submitConsent(first, code(), { Origin: base, ...relayed('2001:db8:1:2::1') })).status).toBe(400);
    expect((await submitConsent(owner, code(), { Origin: base, ...relayed('198.51.100.20') })).status).toBe(303);
  });

  test('a page the owner is typing a code into is pinned against eviction', async () => {
    const ownerHeaders = relayed('198.51.100.20');
    const owner = await openFrom(ownerHeaders);
    // A typo pins nothing; a well-formed (wrong) code does.
    expect((await submitConsent(owner, { action: 'approve', pairing_code: 'ABC' }, { Origin: base, ...ownerHeaders })).status).toBe(400);
    expect((await submitConsent(owner, { action: 'approve', pairing_code: 'AAAA-AAAA-AAAA' }, { Origin: base, ...ownerHeaders })).status).toBe(400);
    // 200 distinct /64s, one request each, all naming the owner's app: past
    // the 128-per-client cap, every eviction in that scope picks an unpinned page.
    for (let i = 0; i < 200; i += 1) {
      expect((await openFrom(relayed(`2001:db8:${(i + 16).toString(16)}::1`))).response.status).toBe(200);
    }
    sleeps = [];
    const approved = await submitConsent(owner, { action: 'approve', pairing_code: store.oauth.mintPairingCode().code }, { Origin: base, ...ownerHeaders });
    expect(approved.status).toBe(303);
    expect(new URL(approved.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });

  test('olympus connections pair mints a code and says whether OAuth is on', () => {
    const env = {
      HOME: join(dir, 'home'),
      OLYMPUS_REMOTE_CONNECTIONS_DB_PATH: dbPath,
      OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
    };
    const off = runConnectionsCommand(['pair'], env) as { code: string; oauth_enabled: boolean; url: string | null };
    expect(off).toMatchObject({ kind: 'remote_pairing_code', oauth_enabled: false, url: null });
    expect(off.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const on = runConnectionsCommand(['pair'], { ...env, OLYMPUS_PUBLIC_BASE_URL: 'https://abc.connect.olympusplugin.ai' });
    expect(on).toMatchObject({ oauth_enabled: true, url: 'https://abc.connect.olympusplugin.ai/mcp' });
    expect(() => runConnectionsCommand(['pair', 'extra'], env)).toThrow('Usage: olympus connections pair');
  });
});

describe('tokens', () => {
  test('refresh tokens rotate, and replaying a used one revokes the grant', async () => {
    const first = await claudeGrant();
    expect(Number(first.expires_in)).toBe(3600);
    const refresh = (token: string, clientId = CLAUDE_CIMD_URL) =>
      tokenRequest({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId, resource: urls.resource });
    const second = await refresh(first.refresh_token);
    expect(second.status).toBe(200);
    const rotated = await second.json() as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    // The old access token retired with its refresh token.
    expect((await mcpInitialize(`Bearer ${first.access_token}`)).status).toBe(401);
    expect((await mcpInitialize(`Bearer ${rotated.access_token}`)).status).toBe(200);
    // Another client cannot use it.
    expect((await refresh(rotated.refresh_token, CHATGPT_CIMD.client_id)).status).toBe(400);

    // Past the grace window, replaying the used token is theft.
    clock += REMOTE_OAUTH_REFRESH_GRACE_MS + 1;
    const replay = await refresh(first.refresh_token);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect(store.list()[0]!.revokedAt).not.toBeNull();
    expect((await mcpInitialize(`Bearer ${rotated.access_token}`)).status).toBe(401);
    expect((await refresh(rotated.refresh_token)).status).toBe(400);
  });

  test('concurrent refreshes and a retry after a lost response get the same successor pair', async () => {
    const first = await claudeGrant();
    const refresh = () => tokenRequest({
      grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: CLAUDE_CIMD_URL, resource: urls.resource,
    }).then(async (response) => ({ status: response.status, body: await response.json() as Record<string, string> }));
    const [a, b] = await Promise.all([refresh(), refresh()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.refresh_token).toBe(a.body.refresh_token);
    expect(b.body.access_token).toBe(a.body.access_token);
    // The response was lost; the client retries with the old token 30s later.
    clock += 30_000;
    const retry = await refresh();
    expect(retry.body.refresh_token).toBe(a.body.refresh_token);
    expect((await mcpInitialize(`Bearer ${a.body.access_token}`)).status).toBe(200);
    expect(store.list()[0]!.revokedAt).toBeNull();
    // Once the successor has itself been rotated, the old token is theft again.
    const next = await tokenRequest({
      grant_type: 'refresh_token', refresh_token: a.body.refresh_token!, client_id: CLAUDE_CIMD_URL,
    });
    expect(next.status).toBe(200);
    expect((await refresh()).status).toBe(400);
    expect(store.list()[0]!.revokedAt).not.toBeNull();
  });

  describe('revoking a grant inside the refresh grace window kills everything', () => {
    // The grace window hands the successor pair to whoever presents the old
    // refresh token with the (public) client id. Revocation must end that at
    // once: the old token, the successor pair, and the grace entry itself.
    const rotateThenRevoke = async (revoke: (ctx: { connectionId: string; successorRefresh: string }) => Promise<void> | void) => {
      const first = await claudeGrant();
      const refresh = (token: string) => tokenRequest({
        grant_type: 'refresh_token', refresh_token: token, client_id: CLAUDE_CIMD_URL, resource: urls.resource,
      });
      const rotated = await refresh(first.refresh_token);
      expect(rotated.status).toBe(200);
      const successor = await rotated.json() as { access_token: string; refresh_token: string };
      // Inside the grace window the old token still answers with the successor pair.
      clock += 10_000;
      expect((await refresh(first.refresh_token)).status).toBe(200);
      await revoke({ connectionId: store.list()[0]!.id, successorRefresh: successor.refresh_token });
      clock += 1_000;
      expect(clock - Date.parse('2026-09-24T12:00:00.000Z')).toBeLessThan(REMOTE_OAUTH_REFRESH_GRACE_MS);
      const replay = await refresh(first.refresh_token);
      expect(replay.status).toBe(400);
      expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
      expect((await refresh(successor.refresh_token)).status).toBe(400);
      expect((await mcpInitialize(`Bearer ${successor.access_token}`)).status).toBe(401);
      expect((await mcpInitialize(`Bearer ${first.access_token}`)).status).toBe(401);
      expect(store.list()[0]!.revokedAt).not.toBeNull();
      // Nothing under the grant survives on disk either.
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query('SELECT COUNT(*) AS n FROM remote_oauth_tokens').get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    };

    test('by the worker process (dashboard or in-process revoke)', async () => {
      await rotateThenRevoke(({ connectionId }) => { store.revoke(connectionId); });
    });

    test('by olympus connections revoke, from another process', async () => {
      await rotateThenRevoke(({ connectionId }) => {
        const env = { HOME: join(dir, 'home'), OLYMPUS_REMOTE_CONNECTIONS_DB_PATH: dbPath, OLYMPUS_CONFIG: join(dir, 'missing.json') };
        runConnectionsCommand(['revoke', connectionId], env);
      });
    });

    test('by the client revoking its successor refresh token (RFC 7009)', async () => {
      await rotateThenRevoke(async ({ successorRefresh }) => {
        const response = await fetch(`${base}/connect/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: successorRefresh }).toString(),
        });
        expect(response.status).toBe(200);
      });
    });
  });

  test('the grace window answers only the same client', async () => {
    const first = await claudeGrant();
    const refresh = (clientId: string) => tokenRequest({
      grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId,
    });
    expect((await refresh(CLAUDE_CIMD_URL)).status).toBe(200);
    expect((await refresh(CHATGPT_CIMD.client_id)).status).toBe(400);
    expect(store.list()[0]!.revokedAt).not.toBeNull();
  });

  test('OAuth access tokens open the OpenAPI tool path too, with the same audience binding', async () => {
    const tokens = await claudeGrant();
    const call = (token: string) => fetch(`${base}/api/v1/tools/source_answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question: 'what changed?' }),
    });
    expect((await call(tokens.access_token)).status).toBe(200);
    const trace = ledger.find((r): r is SourceAnswerLatencyTraceRecord => r.kind === 'source_answer_latency_trace');
    expect(trace?.caller).toMatchObject({ surface: 'remote', display_name: 'Claude' });
    const unauth = await fetch(`${base}/api/v1/tools/source_answer`, { method: 'POST' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    assemble({ publicBaseUrl: 'https://moved.example' });
    expect((await call(tokens.access_token)).status).toBe(401);
    assemble({ publicBaseUrl: undefined });
    expect((await call(tokens.access_token)).status).toBe(401);
  });

  test('access tokens expire after an hour', async () => {
    const tokens = await claudeGrant();
    clock += 3600_000;
    expect((await mcpInitialize(`Bearer ${tokens.access_token}`)).status).toBe(401);
  });

  test('olympus connections revoke kills access and refresh tokens', async () => {
    const tokens = await claudeGrant();
    const [connection] = store.list();
    const env = { HOME: join(dir, 'home'), OLYMPUS_REMOTE_CONNECTIONS_DB_PATH: dbPath, OLYMPUS_CONFIG: join(dir, 'missing.json') };
    const listed = runConnectionsCommand(['list'], env) as { connections: Array<Record<string, unknown>> };
    expect(listed.connections).toEqual([expect.objectContaining({
      id: connection!.id, name: 'Claude', kind: 'oauth', client_id: CLAUDE_CIMD_URL, status: 'active',
    })]);
    expect(JSON.stringify(listed)).not.toContain(tokens.access_token.slice(-20));
    runConnectionsCommand(['revoke', connection!.id], env);
    expect((await mcpInitialize(`Bearer ${tokens.access_token}`)).status).toBe(401);
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLAUDE_CIMD_URL });
    expect(refreshed.status).toBe(400);
  });

  test('the revocation endpoint: a refresh token takes its grant, an access token dies alone', async () => {
    const one = await claudeGrant();
    const revokeAt = (token: string) => fetch(`${base}/connect/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    expect((await revokeAt(one.access_token)).status).toBe(200);
    expect((await mcpInitialize(`Bearer ${one.access_token}`)).status).toBe(401);
    expect(store.list()[0]!.revokedAt).toBeNull();
    expect((await revokeAt(one.refresh_token)).status).toBe(200);
    expect(store.list()[0]!.revokedAt).not.toBeNull();
    expect((await revokeAt('unknown')).status).toBe(200);
  });

  test('an authorization code works once; a second exchange revokes the grant', async () => {
    const redirectUri = CLAUDE_CIMD.redirect_uris[0]!;
    const { code, verifier } = await authorizeManually({ clientId: CLAUDE_CIMD_URL, redirectUri });
    const first = await exchange(CLAUDE_CIMD_URL, redirectUri, code, verifier);
    expect(first.status).toBe(200);
    const second = await exchange(CLAUDE_CIMD_URL, redirectUri, code, verifier);
    expect(second).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect((await mcpInitialize(`Bearer ${first.body.access_token}`)).status).toBe(401);
  });

  test('a code is bound to its verifier, client, redirect and resource', async () => {
    const redirectUri = CLAUDE_CIMD.redirect_uris[0]!;
    const attempts: Array<[Record<string, string>, string]> = [
      [{ code_verifier: 'w'.repeat(50) }, 'invalid_grant'],
      [{ client_id: CHATGPT_CIMD.client_id }, 'invalid_grant'],
      [{ redirect_uri: 'https://claude.ai/api/mcp/other' }, 'invalid_grant'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
    ];
    for (const [override, error] of attempts) {
      const { code, verifier } = await authorizeManually({ clientId: CLAUDE_CIMD_URL, redirectUri });
      const response = await tokenRequest({
        grant_type: 'authorization_code', client_id: CLAUDE_CIMD_URL, redirect_uri: redirectUri,
        code, code_verifier: verifier, resource: urls.resource, ...override,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error });
    }
    expect(store.list()).toEqual([]);
  });

  test('codes expire after a minute and tokens are stored only as digests', async () => {
    const redirectUri = CLAUDE_CIMD.redirect_uris[0]!;
    const { code, verifier } = await authorizeManually({ clientId: CLAUDE_CIMD_URL, redirectUri });
    clock += 60_001;
    expect((await exchange(CLAUDE_CIMD_URL, redirectUri, code, verifier)).status).toBe(400);
    const tokens = await claudeGrant();
    const raw = readFileSync(dbPath);
    const wal = (() => { try { return readFileSync(`${dbPath}-wal`); } catch { return Buffer.alloc(0); } })();
    for (const secret of [tokens.access_token, tokens.refresh_token]) {
      expect(raw.includes(Buffer.from(secret))).toBe(false);
      expect(wal.includes(Buffer.from(secret))).toBe(false);
    }
  });
});

describe('request bodies on the unauthenticated routes', () => {
  test('an oversized chunked body is refused without buffering it all', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 10_000) { controller.close(); return; }
        controller.enqueue(new Uint8Array(4096).fill(97));
      },
    });
    const response = await fetch(`${base}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: endless,
      // @ts-expect-error Bun streams request bodies with duplex half
      duplex: 'half',
    });
    expect(response.status).toBe(400);
    expect(pulled).toBeLessThan(1000);
  });

  test('a body that stalls gives up at the deadline', async () => {
    const stalled = new Request('http://127.0.0.1/connect/token', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([97])); } }),
      // @ts-expect-error Bun streams request bodies with duplex half
      duplex: 'half',
    });
    const started = Date.now();
    expect(await readBoundedRequestText(stalled, 1024, { deadlineMs: 50 })).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('dynamic client registration', () => {
  test('registers public clients with https or loopback redirects, and is rate-limited', async () => {
    assemble({ registrationBurst: 2 });
    const register = (body: unknown) => fetch(`${base}/connect/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await register({ redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    const ok = await register({
      client_name: 'Grok',
      redirect_uris: ['https://grok.com/connectors/oauth/callback'],
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(ok.status).toBe(201);
    const body = await ok.json() as Record<string, unknown>;
    expect(body).toMatchObject({ client_name: 'Grok', token_endpoint_auth_method: 'none' });
    expect(body.client_secret).toBeUndefined();
    expect((await register({ redirect_uris: ['https://grok.com/connectors-oauth-exchange-code/'] })).status).toBe(201);
    const limited = await register({ redirect_uris: ['https://grok.com/connectors/oauth/callback'] });
    expect(limited.status).toBe(429);
  });
});

describe('client metadata documents (CIMD) fetch', () => {
  test('the SSRF address policy', () => {
    for (const address of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '160.79.104.10']) {
      expect(isPublicAddress(address)).toBe(true);
    }
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:0001::1',
      'ff02::1', '2001:db8::1', 'not-an-ip',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  test('refuses non-https, odd ports, private resolutions and mixed answers before connecting', async () => {
    let resolved = 0;
    const resolverFor = (answers: string[]) => async () => { resolved += 1; return answers; };
    const attempt = (clientId: string, answers: string[] = ['93.184.216.34']) =>
      createClientMetadataResolver({ resolve: resolverFor(answers), timeoutMs: 500 })(clientId);
    await expect(attempt('http://client.example/meta.json')).rejects.toBeInstanceOf(ClientMetadataError);
    await expect(attempt('https://client.example:8443/meta.json')).rejects.toThrow('default https port');
    await expect(attempt('https://client.example/')).rejects.toThrow('must have a path');
    await expect(attempt('https://user@client.example/meta.json')).rejects.toThrow('credentials');
    expect(resolved).toBe(0);
    await expect(attempt('https://client.example/meta.json', ['127.0.0.1'])).rejects.toThrow('private or reserved');
    await expect(attempt('https://client.example/meta.json', ['93.184.216.34', '10.0.0.5'])).rejects.toThrow('private or reserved');
    await expect(attempt('https://client.example/meta.json', ['::ffff:169.254.169.254'])).rejects.toThrow('private or reserved');
    await expect(attempt('https://169.254.169.254/latest/meta-data')).rejects.toThrow('private or reserved');
    await expect(attempt('https://[::1]/meta.json')).rejects.toThrow('private or reserved');
  });

  test('a cached document costs no fetch budget', async () => {
    let budgetAsked = 0;
    let fetched = 0;
    const clientId = 'https://client.example/meta.json';
    const resolve = createClientMetadataResolver({
      resolve: async () => { fetched += 1; return ['127.0.0.1']; },
      allowFetch: () => { budgetAsked += 1; return budgetAsked === 1; },
      timeoutMs: 200,
    });
    // First miss spends the budget (then fails on the private address); the
    // second miss is refused by the budget before resolving anything.
    await expect(resolve(clientId)).rejects.toThrow('private or reserved');
    await expect(resolve(clientId)).rejects.toThrow('too many new apps');
    expect(fetched).toBe(1);
  });

  test('document validation', () => {
    expect(() => validateClientMetadataDocument({ ...CLAUDE_CIMD, client_id: 'https://evil.example/x' }, CLAUDE_CIMD_URL))
      .toThrow('does not match');
    expect(() => validateClientMetadataDocument({ ...CLAUDE_CIMD, redirect_uris: ['http://evil.example/cb'] }, CLAUDE_CIMD_URL))
      .toThrow('not https or loopback');
    expect(() => validateClientMetadataDocument({ ...CLAUDE_CIMD, client_secret: 'x' }, CLAUDE_CIMD_URL)).toThrow('secret');
    expect(() => validateClientMetadataDocument({ ...CLAUDE_CIMD, token_endpoint_auth_method: 'private_key_jwt' }, CLAUDE_CIMD_URL))
      .toThrow('public clients only');
    expect(validateClientMetadataDocument(CHATGPT_CIMD, CHATGPT_CIMD.client_id).clientName).toBe('ChatGPT');
  });

  describe('over TLS to a pinned local address', () => {
    const openssl = spawnSync('openssl', ['version']).status === 0;
    let tlsServer: ReturnType<typeof Bun.serve> | undefined;
    let cert = '';
    let requests: Array<{ host: string | null; path: string }> = [];
    let body: () => Response = () => new Response('{}');

    beforeEach(() => {
      if (!openssl) return;
      const pki = join(dir, 'pki');
      mkdirSync(pki);
      const made = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', join(pki, 'key.pem'), '-out', join(pki, 'cert.pem'), '-days', '1',
        '-subj', '/CN=client.example', '-addext', 'subjectAltName=DNS:client.example',
      ]);
      expect(made.status).toBe(0);
      cert = readFileSync(join(pki, 'cert.pem'), 'utf8');
      requests = [];
      tlsServer = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        tls: { cert, key: readFileSync(join(pki, 'key.pem'), 'utf8') },
        fetch(request) {
          requests.push({ host: request.headers.get('host'), path: new URL(request.url).pathname });
          return body();
        },
      });
    });

    afterEach(() => { tlsServer?.stop(true); tlsServer = undefined; });

    let budget = 0;
    const resolverTo = (answer: string, overrides: { ca?: string } = {}) => createClientMetadataResolver({
      resolve: async () => [answer],
      allowFetch: () => { budget += 1; return true; },
      isAllowedAddress: (address) => address === '127.0.0.1', // the test server; production refuses loopback
      ca: overrides.ca ?? cert,
      portOverride: tlsServer!.port!,
      timeoutMs: 2_000,
    });

    test.if(openssl)('fetches, validates and caches a document from the pinned address with SNI', async () => {
      const clientId = 'https://client.example/meta.json';
      body = () => Response.json({ client_id: clientId, client_name: 'Example', redirect_uris: ['https://client.example/cb'] });
      const resolve = resolverTo('127.0.0.1');
      expect(await resolve(clientId)).toMatchObject({ clientName: 'Example', clientIdHost: 'client.example' });
      expect(await resolve(clientId)).toMatchObject({ clientName: 'Example' });
      expect(requests).toEqual([{ host: 'client.example', path: '/meta.json' }]);
      // The cache hit spent nothing from the fetch budget.
      expect(budget).toBe(1);
    });

    test.if(openssl)('a certificate for another name, a redirect, or an oversized body is refused', async () => {
      const resolve = resolverTo('127.0.0.1');
      await expect(resolve('https://other.example/meta.json')).rejects.toThrow('securely');
      body = () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } });
      await expect(resolve('https://client.example/redirect.json')).rejects.toThrow('HTTP 302');
      body = () => new Response('x'.repeat(200_000), { headers: { 'Content-Type': 'application/json' } });
      await expect(resolve('https://client.example/big.json')).rejects.toThrow('too large');
    });
  });
});

describe('connection database migration', () => {
  test('a schema v1 database keeps its bearer connections after upgrading', async () => {
    const legacyPath = join(dir, 'legacy', 'remote-connections.sqlite');
    mkdirSync(join(dir, 'legacy'), { mode: 0o700 });
    // Build v1 exactly as the previous release did, with one bearer connection.
    const v1 = openRemoteConnectionStore(join(dir, 'scratch', 'x.sqlite'));
    const { token } = v1.create('Muse');
    v1.close();
    const source = new Database(join(dir, 'scratch', 'x.sqlite'));
    const row = source.query('SELECT * FROM remote_connections').get() as Record<string, unknown>;
    source.close();
    const legacy = new Database(legacyPath, { create: true });
    legacy.exec(`
      CREATE TABLE schema_version (store_id TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_version VALUES ('remote-connections', 1, '2026-09-24T00:00:00.000Z');
      CREATE TABLE remote_connections (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('bearer')),
        token_hash BLOB NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
    `);
    legacy.query('INSERT INTO remote_connections (id, display_name, kind, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id as string, 'Muse', 'bearer', row.token_hash as Uint8Array, row.created_at as string);
    legacy.close();
    const upgraded = openRemoteConnectionStore(legacyPath);
    try {
      expect(upgraded.verifyToken(token)).toMatchObject({ ok: true, connection: { displayName: 'Muse', kind: 'bearer' } });
      const check = new Database(legacyPath);
      expect((check.query("SELECT version FROM schema_version WHERE store_id = 'remote-connections'").get() as { version: number }).version).toBe(2);
      check.close();
      // Something approved after the upgrade, which the rollback will not keep.
      upgraded.create('Later');
    } finally {
      upgraded.close();
    }

    // Rollback: an older build refuses the v2 database outright...
    const refused = new Database(legacyPath);
    expect(() => assertSqliteSchemaCanOpen(refused, 'remote-connections', 1)).toThrow('only knows schema_version 1');
    refused.close();
    // ...so the documented restore puts the pre-migration copy back.
    const backup = remoteConnectionsPreV2BackupPath(legacyPath);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    copyFileSync(backup, legacyPath);
    rmSync(`${legacyPath}-wal`, { force: true });
    rmSync(`${legacyPath}-shm`, { force: true });

    // What a v1 build does on open: the version gate, then its v1 queries.
    const v1Build = new Database(legacyPath);
    try {
      expect(readSqliteSchemaVersion(v1Build, 'remote-connections')).toBe(1);
      expect(() => assertSqliteSchemaCanOpen(v1Build, 'remote-connections', 1)).not.toThrow();
      const rows = v1Build.query('SELECT id, display_name, kind, token_hash FROM remote_connections').all() as Array<{
        display_name: string; kind: string; token_hash: Uint8Array;
      }>;
      expect(rows.map((r) => [r.display_name, r.kind])).toEqual([['Muse', 'bearer']]);
      expect(Buffer.from(rows[0]!.token_hash).equals(Buffer.from(row.token_hash as Uint8Array))).toBe(true);
      v1Build.exec("INSERT INTO remote_connections (id, display_name, kind, token_hash, created_at) VALUES ('aa', 'x', 'bearer', x'00', 'now')");
    } finally {
      v1Build.close();
    }

    // A second upgrade migrates again and keeps the first backup untouched.
    const before = readFileSync(backup);
    const again = openRemoteConnectionStore(legacyPath);
    expect(again.verifyToken(token)).toMatchObject({ ok: true });
    again.close();
    expect(readFileSync(backup).equals(before)).toBe(true);
  });

  test('the pre-migration backup is left out of exports and removed by data delete --all', () => {
    const home = join(dir, 'lifecycle-home');
    mkdirSync(home, { recursive: true });
    const path = join(dir, 'outside-roots', 'remote-connections.sqlite');
    mkdirSync(join(dir, 'outside-roots'), { mode: 0o700 });
    writeFileSync(remoteConnectionsPreV2BackupPath(path), 'backup', { mode: 0o600 });
    openRemoteConnectionStore(path).close();
    const env = { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), OLYMPUS_REMOTE_CONNECTIONS_DB_PATH: path };
    const exported = exportOlympusData({ destination: join(dir, 'export'), homeDir: home, env });
    expect(exported.skipped).toContain(remoteConnectionsPreV2BackupPath(path));
    deleteOlympusData({ all: true, homeDir: home, env });
    expect(existsSync(remoteConnectionsPreV2BackupPath(path))).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test('a bearer token naming an OAuth grant id is refused without error', async () => {
    await claudeGrant();
    const [connection] = store.list();
    expect(store.verifyToken(`olympus_conn_${connection!.id}_${'A'.repeat(43)}`)).toEqual({ ok: false, reason: 'unknown' });
  });
});
