// OAuth 2.1 for hosted agents: pairing-code approval behind a tunnel the owner
// runs, and loopback-only one-click approval in relay mode.
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
import { credentialInstallId, mintCredential } from '../connect-relay/shared/tokens.ts';
import { authorizationServerMetadata as relayAuthorizationServerMetadata, relayOrigin } from '../connect-relay/server/oauth-metadata.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import {
  createInProcessOperationContext,
  createRemoteMcpHandler,
  withRemoteMcpRoute,
} from '../src/workers/remote-mcp.ts';
import { CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI } from '../src/workers/remote-oauth/pinned-clients.ts';
import { DEMO_SIGN_IN_BURST, resolveDemoConsent, type DemoConsentSettings } from '../src/workers/remote-oauth/demo-consent.ts';
import { demoInstallMarked, DEMO_INSTALL_MARKER_FILE, DEMO_INSTALL_MARKER_TEXT } from '../src/core/remote-access.ts';
import { authorizationServerMetadata, createRemoteOAuthHandler, withRemoteOAuthRoutes } from '../src/workers/remote-oauth/handler.ts';
import type {
  SourceAnswerLatencyLedgerRecord,
  SourceAnswerLatencyTraceRecord,
} from '../src/workers/source-index/answer-latency-log.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';

const WORKER_TOKEN = 'worker-bearer-token-for-remote-oauth-tests-0123456789';
// ChatGPT, as pinned (src/workers/remote-oauth/pinned-clients.ts): never fetched.
const CHATGPT = { client_id: CHATGPT_CLIENT_ID, redirect_uris: [CHATGPT_REDIRECT_URI] };
const INSTALL_ID = 'abcdefghijklmnopqrstuvwxyz234567';
/** Another pinned client id, for "issued to another client" checks. */
const OTHER_CLIENT_ID = 'https://chatgpt.com/oauth/cb_other/client.json';

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
let sleeps: number[];

interface AssembleOptions {
  publicBaseUrl?: string | undefined;
  /** Relay mode: the install id the relay child reported. */
  installId?: string;
  registrationBurst?: number;
  demoConsent?: () => DemoConsentSettings | undefined;
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
  const resolved = parseRemotePublicBaseUrl(configured, options.installId);
  const publicUrls = resolved.enabled ? resolved.urls : undefined;
  if (publicUrls) urls = publicUrls;
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
  handle = withRemoteOAuthRoutes(
    createRemoteOAuthHandler({
      publicUrls,
      connections: () => store,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); },
      ...(options.demoConsent ? { demoConsent: options.demoConsent } : {}),
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

async function chatgptGrant() {
  const redirectUri = CHATGPT_REDIRECT_URI;
  const { code, verifier } = await authorizeManually({ clientId: CHATGPT_CLIENT_ID, redirectUri });
  const tokens = await exchange(CHATGPT_CLIENT_ID, redirectUri, code, verifier);
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
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['source_answer', 'source_answer_result', 'source_index_status']);
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

  test('ChatGPT is a pinned metadata-document client: named, verified, and needs no registration', async () => {
    const provider = new TestOAuthProvider(CHATGPT_REDIRECT_URI, 'ignored', CHATGPT_CLIENT_ID);
    const first = new Client({ name: 'remote-oauth-test', version: '1.0.0' });
    const transport = sdkTransport(provider);
    await expect(first.connect(transport as unknown as Parameters<Client['connect']>[0])).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.authorizationUrl!.searchParams.get('client_id')).toBe(CHATGPT_CLIENT_ID);
    expect(provider.authorizationUrl!.searchParams.get('resource')).toBe(urls.resource);
    const page = await openConsent(provider.authorizationUrl!);
    expect(page.html).toContain('Connect ChatGPT to Olympus?');
    expect(page.html).toContain('<div class="name">ChatGPT</div>\n<div class="host">chatgpt.com</div>');
    expect(page.html).toContain('you return to <strong>chatgpt.com</strong>');
    const approved = await submitConsent(page, { action: 'approve', pairing_code: store.oauth.mintPairingCode().code });
    const callback = new URL(approved.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(CHATGPT_REDIRECT_URI);
    await transport.finishAuth(callback.searchParams.get('code')!);
    const client = await connectWith(provider);
    await client.callTool({ name: 'source_answer', arguments: { question: 'hi' } });
    await client.close();
    expect(store.list()).toMatchObject([{ kind: 'oauth', displayName: 'ChatGPT', clientId: CHATGPT_CLIENT_ID }]);
    const trace = ledger.find((r): r is SourceAnswerLatencyTraceRecord => r.kind === 'source_answer_latency_trace');
    expect(trace?.caller?.display_name).toBe('ChatGPT');
  });

  test("ChatGPT's callback-specific client id is pinned to its own redirect", async () => {
    const clientId = 'https://chatgpt.com/oauth/cb_123/client.json';
    const redirectUri = 'https://chatgpt.com/connector/oauth/cb_123';
    const { code, verifier } = await authorizeManually({ clientId, redirectUri });
    expect((await exchange(clientId, redirectUri, code, verifier)).status).toBe(200);
  });

  test('an arbitrary metadata-document client is refused without any fetch', async () => {
    const url = new URL(`${base}/connect/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
    }).toString();
    const response = await fetch(url, { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('does not recognize this app');
  });
});

describe('relay mode: loopback-only approval and routable credentials', () => {
  const RELAY_ORIGIN = 'https://mcp.olympus.test';
  const relayAuthorizeUrl = (params: Record<string, string> = {}) => {
    const url = new URL(`${base}/connect/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI,
      code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', ...params,
    }).toString();
    return url;
  };
  beforeEach(() => assemble({ publicBaseUrl: RELAY_ORIGIN, installId: INSTALL_ID }));

  test('a direct visit on this Mac approves with one click and returns a code naming this install', async () => {
    const verifier = 'v'.repeat(50);
    const challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
    const page = await openConsent(relayAuthorizeUrl({ code_challenge: challenge, resource: `${RELAY_ORIGIN}/mcp` }));
    expect(page.response.status).toBe(200);
    expect(page.html).toContain('Connect ChatGPT to Olympus?');
    expect(page.html).toContain('never sees the text of your Private items or any Secret');
    expect(page.html).not.toContain('pairing_code');
    // The page is plain http on loopback: a Secure cookie would never come back.
    expect(page.response.headers.get('set-cookie')).not.toContain('Secure');
    const approved = await submitConsent(page, { action: 'approve' });
    expect(approved.status).toBe(303);
    const callback = new URL(approved.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(CHATGPT_REDIRECT_URI);
    expect(callback.searchParams.get('iss')).toBe(RELAY_ORIGIN);
    const code = callback.searchParams.get('code')!;
    expect(credentialInstallId('code', code)).toBe(INSTALL_ID);

    const tokens = await exchange(CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI, code, verifier);
    expect(tokens.status).toBe(200);
    expect(Number(tokens.body.expires_in)).toBe(3600);
    expect(credentialInstallId('access', tokens.body.access_token)).toBe(INSTALL_ID);
    expect(credentialInstallId('refresh', tokens.body.refresh_token)).toBe(INSTALL_ID);
    expect((await mcpInitialize(`Bearer ${tokens.body.access_token}`)).status).toBe(200);

    // Rotation keeps the install in the new pair.
    const rotated = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token!, client_id: CHATGPT_CLIENT_ID });
    const pair = await rotated.json() as Record<string, string>;
    expect(credentialInstallId('access', pair.access_token)).toBe(INSTALL_ID);
    expect(credentialInstallId('refresh', pair.refresh_token)).toBe(INSTALL_ID);
    expect(store.list()).toMatchObject([{ kind: 'oauth', displayName: 'ChatGPT', clientId: CHATGPT_CLIENT_ID }]);
  });

  test('approval through the relay, or under a non-loopback Host, is refused', async () => {
    const relayed = await fetch(relayAuthorizeUrl(), { redirect: 'manual', headers: { 'x-olympus-relay': 'per-boot-secret' } });
    expect(relayed.status).toBe(403);
    expect(await relayed.text()).toContain('Approve on the Mac where Olympus runs');
    // Any value of the marker counts: a relayed request can never approve.
    expect((await fetch(relayAuthorizeUrl(), { redirect: 'manual', headers: { 'x-olympus-relay': '' } })).status).toBe(403);
    const publicHost = await handle(new Request(relayAuthorizeUrl().toString().replace(base, 'http://127.0.0.1:8010'), { headers: { host: 'mcp.olympus.test' } }));
    expect(publicHost.status).toBe(403);
    // A page opened directly cannot be approved through the relay either.
    const page = await openConsent(relayAuthorizeUrl());
    const viaRelay = await submitConsent(page, { action: 'approve' }, { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'x-olympus-relay': 'x' });
    expect(viaRelay.status).toBe(403);
    expect((await submitConsent(page, { action: 'approve' })).status).toBe(303);
  });

  test('a token naming another install, or minted elsewhere, opens nothing here', async () => {
    expect((await mcpInitialize(`Bearer ${mintCredential('access', INSTALL_ID)}`)).status).toBe(401);
    expect((await mcpInitialize(`Bearer ${mintCredential('access', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')}`)).status).toBe(401);
  });

  test('metadata advertises no registration, and equals what the relay serves', async () => {
    const engine = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(engine.registration_endpoint).toBeUndefined();
    expect(engine).toEqual(relayAuthorizationServerMetadata(relayOrigin('mcp.olympus.test')));
    expect(authorizationServerMetadata(urls)).toEqual(relayAuthorizationServerMetadata(relayOrigin('mcp.olympus.test')));
  });

  test('registration is for local development clients only, from this Mac', async () => {
    const register = (redirect: string, headers: Record<string, string> = {}) => fetch(`${base}/connect/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ client_name: 'Inspector', redirect_uris: [redirect] }),
    });
    expect((await register('http://127.0.0.1/callback', { 'x-olympus-relay': 'x' })).status).toBe(403);
    expect((await register('https://grok.com/connectors/oauth/callback')).status).toBe(400);
    const local = await register('http://127.0.0.1/callback');
    expect(local.status).toBe(201);
  });
});

describe('demo installs: reviewer sign-in through the relay', () => {
  const RELAY_ORIGIN = 'https://mcp.olympus.test';
  const DEMO_PASSWORD = 'sample-only-demo-password';
  let settings: DemoConsentSettings;
  const demoUrl = (params: Record<string, string> = {}) => {
    const url = new URL(`${base}/connect/demo/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI,
      code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', ...params,
    }).toString();
    return url;
  };
  /** As the relay forwards it: marked, no cookie, the relay origin. */
  const relayedHeaders = { 'x-olympus-relay': 'per-boot', Origin: RELAY_ORIGIN };
  const openDemo = async (url: URL = demoUrl()) => {
    const response = await fetch(url, { redirect: 'manual', headers: { 'x-olympus-relay': 'per-boot' } });
    const html = await response.text();
    return {
      response,
      html,
      requestId: /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? '',
      csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '',
    };
  };
  const signIn = (page: { requestId: string; csrf: string }, fields: Record<string, string>, headers: Record<string, string> = relayedHeaders) =>
    fetch(`${base}/connect/demo/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ request_id: page.requestId, csrf: page.csrf, ...fields }).toString(),
    });

  beforeEach(async () => {
    settings = { username: 'reviewer', passwordHash: await Bun.password.hash(DEMO_PASSWORD) };
    assemble({ publicBaseUrl: RELAY_ORIGIN, installId: INSTALL_ID, demoConsent: () => settings });
  });

  test('the right username and password approve, through the relay, with a code naming the install', async () => {
    const page = await openDemo();
    expect(page.response.status).toBe(200);
    expect(page.html).toContain('Sign in to the Olympus demo');
    expect(page.html).toContain('made-up sample data');
    expect(page.html).toContain('type="password"');
    const approved = await signIn(page, { action: 'approve', username: 'reviewer', password: DEMO_PASSWORD });
    expect(approved.status).toBe(303);
    const callback = new URL(approved.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(CHATGPT_REDIRECT_URI);
    expect(callback.searchParams.get('iss')).toBe(RELAY_ORIGIN);
    expect(credentialInstallId('code', callback.searchParams.get('code'))).toBe(INSTALL_ID);
  });

  test('wrong credentials, a foreign origin, a wrong token or an owner page are refused; five wrong end the page', async () => {
    const page = await openDemo();
    expect((await signIn(page, { action: 'approve', username: 'reviewer', password: DEMO_PASSWORD }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await signIn({ ...page, csrf: 'x'.repeat(43) }, { action: 'approve', username: 'reviewer', password: DEMO_PASSWORD })).status).toBe(403);
    for (let i = 0; i < 4; i += 1) {
      const wrong = await signIn(page, { action: 'approve', username: i % 2 ? 'reviewer' : 'Reviewer', password: 'guess' });
      expect(wrong.status).toBe(400);
      expect(await wrong.text()).toContain('do not match');
    }
    const fifth = await signIn(page, { action: 'approve', username: 'reviewer', password: 'guess' });
    expect(fifth.status).toBe(303);
    expect(new URL(fifth.headers.get('location')!).searchParams.get('error')).toBe('access_denied');

    // An owner approval page cannot be finished through the demo path, nor the reverse.
    const ownerPage = await openConsent(demoUrl().toString().replace('/connect/demo/authorize', '/connect/authorize'));
    expect((await signIn(ownerPage, { action: 'approve', username: 'reviewer', password: DEMO_PASSWORD })).status).toBe(400);
    const demoPage = await openDemo();
    expect((await submitConsent({ ...demoPage, cookie: '' }, { action: 'approve' })).status).toBe(400);
  });

  test('sign-in attempts are rate limited across all callers', async () => {
    let limited = false;
    for (let i = 0; i < DEMO_SIGN_IN_BURST + 1 && !limited; i += 1) {
      const page = await openDemo();
      const response = await signIn(page, { action: 'approve', username: 'reviewer', password: 'guess' });
      limited = (await response.text()).includes('Too many sign-in attempts');
    }
    expect(limited).toBe(true);
    const page = await openDemo();
    expect(await (await signIn(page, { action: 'approve', username: 'reviewer', password: DEMO_PASSWORD })).text()).toContain('Too many sign-in attempts');
    clock += 15 * 60_000;
    expect((await signIn(await openDemo(), { action: 'approve', username: 'reviewer', password: DEMO_PASSWORD })).status).toBe(303);
  });

  test('every non-demo install answers the demo path 404', async () => {
    assemble({ publicBaseUrl: RELAY_ORIGIN, installId: INSTALL_ID });
    expect((await openDemo()).response.status).toBe(404);
    assemble({ publicBaseUrl: RELAY_ORIGIN, installId: INSTALL_ID, demoConsent: () => undefined });
    expect((await openDemo()).response.status).toBe(404);
    // Not relay mode (a tunnel of the owner's own): never.
    assemble({ demoConsent: () => settings });
    expect((await openDemo()).response.status).toBe(404);
  });

  test('settings resolve only with the flag, a username, an Argon2 hash and the demo marker', async () => {
    const remote = (demoConsent: Record<string, unknown>) => ({ enabled: true, demoConsent: demoConsent as never });
    const hash = settings.passwordHash;
    expect(resolveDemoConsent(remote({ enabled: true, username: 'reviewer', passwordHash: hash }), () => true)).toEqual({ username: 'reviewer', passwordHash: hash });
    expect(resolveDemoConsent(remote({ enabled: true, username: 'reviewer', passwordHash: hash }), () => false)).toBeUndefined();
    expect(resolveDemoConsent(remote({ enabled: false, username: 'reviewer', passwordHash: hash }), () => true)).toBeUndefined();
    expect(resolveDemoConsent(remote({ enabled: true, username: 'reviewer', passwordHash: DEMO_PASSWORD }), () => true)).toBeUndefined();
    expect(resolveDemoConsent(remote({ enabled: true, passwordHash: hash }), () => true)).toBeUndefined();
    expect(resolveDemoConsent({ enabled: true }, () => true)).toBeUndefined();
    expect(resolveDemoConsent(undefined, () => true)).toBeUndefined();

    const markerDir = join(dir, 'connect-relay');
    mkdirSync(markerDir, { recursive: true });
    expect(demoInstallMarked(markerDir)).toBe(false);
    writeFileSync(join(markerDir, DEMO_INSTALL_MARKER_FILE), 'demo\n');
    expect(demoInstallMarked(markerDir)).toBe(false);
    writeFileSync(join(markerDir, DEMO_INSTALL_MARKER_FILE), `${DEMO_INSTALL_MARKER_TEXT}\n`);
    expect(demoInstallMarked(markerDir)).toBe(true);
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
    const tokens = await chatgptGrant();
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
  const authorizeUrl = (params: Record<string, string>) => {
    const url = new URL(`${base}/connect/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: CHATGPT_CLIENT_ID,
      redirect_uri: CHATGPT_REDIRECT_URI,
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
    expect(page.html).not.toMatch(/https?:\/\/(?!chatgpt|grok)[^"\s<]*\.(js|css|png|woff)/);
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

  const authorizeUrlFor = (client: { client_id: string; redirect_uris: string[] } = CHATGPT) => {
    const url = new URL(`${base}/connect/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0]!,
      code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's',
    }).toString();
    return url;
  };
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

  test('wrong codes slow the next check down, doubling, without ever closing pairing', async () => {
    const guess = async (code = 'AAAA-AAAA-AAAA') => {
      const page = await openFrom({});
      return submitConsent(page, { action: 'approve', pairing_code: code });
    };
    for (let i = 0; i < 5; i += 1) await guess();
    // 0s, then doubling: 1s, 2s, 4s, 8s.
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
    const refused = await guess();
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Wait 16 seconds');
    // Failures age out of the window; a right code then goes straight through.
    clock += 16 * 60_000;
    sleeps = [];
    expect((await guess(store.oauth.mintPairingCode().code)).status).toBe(303);
    expect(sleeps).toEqual([]);
  });

  test('a full table evicts its oldest unpinned page, so a flood never locks the owner out', async () => {
    const owner = await openFrom({});
    // A well-formed (wrong) code pins the page the owner is typing into; a typo pins nothing.
    expect((await submitConsent(owner, { action: 'approve', pairing_code: 'ABC' })).status).toBe(400);
    expect((await submitConsent(owner, { action: 'approve', pairing_code: 'AAAA-AAAA-AAAA' })).status).toBe(400);
    const first = await openFrom({});
    for (let i = 0; i < 200; i += 1) expect((await openFrom({})).response.status).toBe(200);
    expect((await submitConsent(first, { action: 'deny' })).status).toBe(400);
    clock += 60_000;
    sleeps = [];
    const approved = await submitConsent(owner, { action: 'approve', pairing_code: store.oauth.mintPairingCode().code });
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
    const first = await chatgptGrant();
    expect(Number(first.expires_in)).toBe(3600);
    const refresh = (token: string, clientId = CHATGPT_CLIENT_ID) =>
      tokenRequest({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId, resource: urls.resource });
    const second = await refresh(first.refresh_token);
    expect(second.status).toBe(200);
    const rotated = await second.json() as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    // The old access token retired with its refresh token.
    expect((await mcpInitialize(`Bearer ${first.access_token}`)).status).toBe(401);
    expect((await mcpInitialize(`Bearer ${rotated.access_token}`)).status).toBe(200);
    // Another client cannot use it.
    expect((await refresh(rotated.refresh_token, OTHER_CLIENT_ID)).status).toBe(400);

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
    const first = await chatgptGrant();
    const refresh = () => tokenRequest({
      grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: CHATGPT_CLIENT_ID, resource: urls.resource,
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
      grant_type: 'refresh_token', refresh_token: a.body.refresh_token!, client_id: CHATGPT_CLIENT_ID,
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
      const first = await chatgptGrant();
      const refresh = (token: string) => tokenRequest({
        grant_type: 'refresh_token', refresh_token: token, client_id: CHATGPT_CLIENT_ID, resource: urls.resource,
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
    const first = await chatgptGrant();
    const refresh = (clientId: string) => tokenRequest({
      grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId,
    });
    expect((await refresh(CHATGPT_CLIENT_ID)).status).toBe(200);
    expect((await refresh(OTHER_CLIENT_ID)).status).toBe(400);
    expect(store.list()[0]!.revokedAt).not.toBeNull();
  });

  test('OAuth access tokens open the OpenAPI tool path too, with the same audience binding', async () => {
    const tokens = await chatgptGrant();
    const call = (token: string) => fetch(`${base}/api/v1/tools/source_answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question: 'what changed?' }),
    });
    expect((await call(tokens.access_token)).status).toBe(200);
    const trace = ledger.find((r): r is SourceAnswerLatencyTraceRecord => r.kind === 'source_answer_latency_trace');
    expect(trace?.caller).toMatchObject({ surface: 'remote', display_name: 'ChatGPT' });
    const unauth = await fetch(`${base}/api/v1/tools/source_answer`, { method: 'POST' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    assemble({ publicBaseUrl: 'https://moved.example' });
    expect((await call(tokens.access_token)).status).toBe(401);
    assemble({ publicBaseUrl: undefined });
    expect((await call(tokens.access_token)).status).toBe(401);
  });

  test('access tokens expire after an hour', async () => {
    const tokens = await chatgptGrant();
    clock += 3600_000;
    expect((await mcpInitialize(`Bearer ${tokens.access_token}`)).status).toBe(401);
  });

  test('olympus connections revoke kills access and refresh tokens', async () => {
    const tokens = await chatgptGrant();
    const [connection] = store.list();
    const env = { HOME: join(dir, 'home'), OLYMPUS_REMOTE_CONNECTIONS_DB_PATH: dbPath, OLYMPUS_CONFIG: join(dir, 'missing.json') };
    const listed = runConnectionsCommand(['list'], env) as { connections: Array<Record<string, unknown>> };
    expect(listed.connections).toEqual([expect.objectContaining({
      id: connection!.id, name: 'ChatGPT', kind: 'oauth', client_id: CHATGPT_CLIENT_ID, status: 'active',
    })]);
    expect(JSON.stringify(listed)).not.toContain(tokens.access_token.slice(-20));
    runConnectionsCommand(['revoke', connection!.id], env);
    expect((await mcpInitialize(`Bearer ${tokens.access_token}`)).status).toBe(401);
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CHATGPT_CLIENT_ID });
    expect(refreshed.status).toBe(400);
  });

  test('the revocation endpoint: a refresh token takes its grant, an access token dies alone', async () => {
    const one = await chatgptGrant();
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
    const redirectUri = CHATGPT_REDIRECT_URI;
    const { code, verifier } = await authorizeManually({ clientId: CHATGPT_CLIENT_ID, redirectUri });
    const first = await exchange(CHATGPT_CLIENT_ID, redirectUri, code, verifier);
    expect(first.status).toBe(200);
    const second = await exchange(CHATGPT_CLIENT_ID, redirectUri, code, verifier);
    expect(second).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect((await mcpInitialize(`Bearer ${first.body.access_token}`)).status).toBe(401);
  });

  test('a code is bound to its verifier, client, redirect and resource', async () => {
    const redirectUri = CHATGPT_REDIRECT_URI;
    const attempts: Array<[Record<string, string>, string]> = [
      [{ code_verifier: 'w'.repeat(50) }, 'invalid_grant'],
      [{ client_id: OTHER_CLIENT_ID }, 'invalid_grant'],
      [{ redirect_uri: 'https://chatgpt.com/connector/oauth/other' }, 'invalid_grant'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
    ];
    for (const [override, error] of attempts) {
      const { code, verifier } = await authorizeManually({ clientId: CHATGPT_CLIENT_ID, redirectUri });
      const response = await tokenRequest({
        grant_type: 'authorization_code', client_id: CHATGPT_CLIENT_ID, redirect_uri: redirectUri,
        code, code_verifier: verifier, resource: urls.resource, ...override,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error });
    }
    expect(store.list()).toEqual([]);
  });

  test('codes expire after a minute and tokens are stored only as digests', async () => {
    const redirectUri = CHATGPT_REDIRECT_URI;
    const { code, verifier } = await authorizeManually({ clientId: CHATGPT_CLIENT_ID, redirectUri });
    clock += 60_001;
    expect((await exchange(CHATGPT_CLIENT_ID, redirectUri, code, verifier)).status).toBe(400);
    const tokens = await chatgptGrant();
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
    await chatgptGrant();
    const [connection] = store.list();
    expect(store.verifyToken(`olympus_conn_${connection!.id}_${'A'.repeat(43)}`)).toEqual({ ok: false, reason: 'unknown' });
  });
});
