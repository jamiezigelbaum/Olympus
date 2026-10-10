// The ChatGPT plugin directory's endpoint on the engine (`/openai/mcp`;
// connect-relay/shared/directory-tools.ts):
//
// - The allowlist is pinned, and every name on it is a tool the surface has.
// - /openai/mcp lists exactly what /mcp lists, narrowed to the allowlist, in
//   every conditional state (answer model or not, demo read-only grant); a
//   tool off the allowlist is neither listed nor callable there, and a call
//   to it gets the surface's unknown-tool result.
// - It is its own protected resource: ChatGPT authorizes it (one-click on the
//   Mac, and the reviewer demo sign-in), its tokens open only it, /mcp tokens
//   do not open it, and refresh keeps each grant's audience.
// - A Private match found through /openai/mcp is collected by the private
//   answer panel exactly as through /mcp: the job id names the install, not
//   the endpoint.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerPrivately, type BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { defaultConfig } from '../src/core/config.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { parseRemotePublicBaseUrl, type RemotePublicUrls } from '../src/core/remote-public-url.ts';
import { withRequestPeer } from '../src/core/request-peer.ts';
import {
  DIRECTORY_MCP_PATH,
  DIRECTORY_TOOL_NAMES,
  isDirectoryTool,
  toolCallableOn,
  toolsForSurface,
} from '../connect-relay/shared/directory-tools.ts';
import { credentialInstallId } from '../connect-relay/shared/tokens.ts';
import { protectedResourceMetadata as relayProtectedResourceMetadata, relayOrigin } from '../connect-relay/server/oauth-metadata.ts';
import generatedSurface from '../connect-relay/server/generated/chatgpt-tools.json';
import { createChatGptDirectoryMcpServer } from '../src/workers/chatgpt/directory-surface.ts';
import { CHATGPT_TOOLS, type ChatGptSurfaceOptions } from '../src/workers/chatgpt/mcp-surface.ts';
import { PRIVATE_ANSWER_META_KEY, type PrivateEvidenceItem } from '../src/workers/chatgpt/private-answer-contract.ts';
import { generatePanelKeyPair, openPrivateAnswer, type SealedPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PrivateAnswerJobs, createPrivateAnswerHandler } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { createBuiltInPrivateAnswerModel } from '../src/workers/chatgpt/private-answer-model.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createInProcessOperationContext, createRemoteMcpHandler, withRemoteMcpRoute } from '../src/workers/remote-mcp.ts';
import { isDemoGrant, type DemoConsentSettings } from '../src/workers/remote-oauth/demo-consent.ts';
import { createRemoteOAuthHandler, protectedResourceMetadata, withRemoteOAuthRoutes } from '../src/workers/remote-oauth/handler.ts';
import { CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI, isChatGptGrant } from '../src/workers/remote-oauth/pinned-clients.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';

const RELAY_HOST = 'mcp.olympus.test';
const RELAY_ORIGIN = `https://${RELAY_HOST}`;
const MCP_RESOURCE = `${RELAY_ORIGIN}/mcp`;
const DIRECTORY_RESOURCE = `${RELAY_ORIGIN}/openai/mcp`;
const INSTALL_ID = 'abcdefghijklmnopqrstuvwxyz234567';
const PANEL_ORIGIN = 'https://olympus.web-sandbox.oaiusercontent.com';
const DEMO_PASSWORD = 'sample-only-demo-password';
const PRIVATE_PASSAGE = 'SENTINEL_DIRECTORY_7f3a: the lease on the flat ends on 31 May 2027.';
const PRIVATE_HITS: PrivateEvidenceItem[] = [{
  sourceItem: { family: 'email', provider: 'gmail', accountScope: 'personal', providerItemId: 'm-1', localItemId: 'personal:m-1' },
  provenance: { citation: { title: 'Lease renewal', sourceLabel: 'Gmail', authoredAt: '2026-04-01' } },
  internalContent: { kind: 'bounded_item_passage', passage: PRIVATE_PASSAGE, passageChars: PRIVATE_PASSAGE.length, truncated: false, sourceTextReturned: true },
  selected_item: { corpus_id: 'secure_local.email' },
  rawExposed: false,
}];

let dir: string;
let store: RemoteConnectionStore;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let urls: RemotePublicUrls;
let answerModel: boolean;
let jobs: PrivateAnswerJobs;
let demoSettings: DemoConsentSettings | undefined;
/** The directory allowlist the engine uses; a test narrows it to prove default-deny. */
let directoryAllows: ((name: string) => boolean) | undefined;

function stubPanelModel() {
  const model: BuiltInAnalystModel = {
    name: 'built_in',
    spec: QWEN35_4B,
    async prepare() {},
    status: () => ({ state: 'ready', modelId: QWEN35_4B.modelId, percent: 100, label: '', bytesDone: 0, bytesTotal: 0, updatedAt: new Date(0).toISOString() }),
    async stop() {},
    async complete() {
      return {
        text: JSON.stringify({ answer: 'The lease ends on 31 May 2027 [1].', citations: [{ evidence: 1, claim: 'The lease ends on 31 May 2027.' }], unanswered: [], sufficient: true }),
        modelId: `built_in/${QWEN35_4B.modelId}`,
      };
    },
  };
  return createBuiltInPrivateAnswerModel({ eligible: async (items) => items.map(() => true), model, available: () => true, answer: answerPrivately });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-directory-endpoint-'));
  store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
  answerModel = true;
  directoryAllows = undefined;
  demoSettings = { username: 'reviewer', passwordHash: await Bun.password.hash(DEMO_PASSWORD) };
  const panelModel = stubPanelModel();
  jobs = new PrivateAnswerJobs({ eligible: async (items) => items.map(() => true), model: () => panelModel, installId: () => INSTALL_ID, claimHoldMs: 0 });
  const resolved = parseRemotePublicBaseUrl(RELAY_ORIGIN, INSTALL_ID);
  if (!resolved.enabled) throw new Error('relay origin did not parse');
  urls = resolved.urls;
  const worker = createEmailSourceWorker({});
  const config = { ...defaultConfig(), sourceIndex: { ...defaultConfig().sourceIndex, enabled: true } };
  const surface: ChatGptSurfaceOptions = {
    async dashboardView() { throw new Error('unused'); },
    answerModelAvailable: () => answerModel,
    privateAnswers: jobs,
    async privateMatchProbe() { return { count: 1, evidence: PRIVATE_HITS }; },
    async evidenceSearch() {
      return {
        evidence: [{ trust_domain: 'internal', family: 'file', provider: 'google_drive', title: 'Flat inventory', excerpt: 'Two chairs and a table.' }],
        coverage: { searched_corpora: 1, unreadable_items: 0, partially_read_items: 0, unclassified_items: 0 },
      };
    },
  };
  const mcp = createRemoteMcpHandler({
    connections: () => store,
    publicUrls: urls,
    makeOperationContext: (caller, signal) => createInProcessOperationContext({ config, sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller, signal }),
    chatgpt: {
      servesRequest: (_request, connection) => isChatGptGrant(connection),
      readOnlyFor: isDemoGrant,
      ...surface,
    },
  });
  // The one seam the default-deny test uses: the same handler, its directory
  // server built with a narrower allowlist.
  const narrowed = createRemoteMcpHandler({
    connections: () => store,
    publicUrls: urls,
    makeOperationContext: (caller, signal) => createInProcessOperationContext({ config, sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller, signal }),
    chatgpt: { servesRequest: (_request, connection) => isChatGptGrant(connection), ...surface },
    directoryServer: (makeContext, options, detached) => createChatGptDirectoryMcpServer(makeContext, options, detached, (name) => directoryAllows!(name)),
  });
  const handler = withRemoteOAuthRoutes(
    createRemoteOAuthHandler({ publicUrls: urls, connections: () => store, demoConsent: () => demoSettings }),
    withRemoteMcpRoute((request) => (directoryAllows ? narrowed(request) : mcp(request)), async () => new Response('not found', { status: 404 })),
  );
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: withRequestPeer(handler) });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function pkce() {
  const verifier = 'v'.repeat(43) + Math.random().toString(36).slice(2);
  return { verifier, challenge: new Bun.CryptoHasher('sha256').update(verifier).digest('base64url') };
}

function authorizeUrl(path: string, challenge: string, resource?: string): URL {
  const url = new URL(`${base}${path}`);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI,
    code_challenge: challenge, code_challenge_method: 'S256', state: 's',
    ...(resource ? { resource } : {}),
  }).toString();
  return url;
}

/** The owner on this Mac: open the approval page and approve with one click. */
async function ownerCode(challenge: string, resource?: string): Promise<URL> {
  const page = await fetch(authorizeUrl('/connect/authorize', challenge, resource), { redirect: 'manual' });
  const html = await page.text();
  expect(page.status).toBe(200);
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0]!;
  const approved = await fetch(`${base}/connect/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' },
    body: new URLSearchParams({ request_id: requestId, csrf, action: 'approve' }).toString(),
  });
  expect(approved.status).toBe(303);
  return new URL(approved.headers.get('location')!);
}

/** A directory reviewer: the demo sign-in, as the relay forwards it. */
async function demoCode(challenge: string, resource?: string): Promise<URL> {
  const page = await fetch(authorizeUrl('/connect/demo/authorize', challenge, resource), { redirect: 'manual', headers: { 'x-olympus-relay': 'per-boot' } });
  const html = await page.text();
  expect(page.status).toBe(200);
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const approved = await fetch(`${base}/connect/demo/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-olympus-relay': 'per-boot', Origin: RELAY_ORIGIN },
    body: new URLSearchParams({ request_id: requestId, csrf, action: 'approve', username: 'reviewer', password: DEMO_PASSWORD }).toString(),
  });
  expect(approved.status).toBe(303);
  return new URL(approved.headers.get('location')!);
}

function tokenRequest(fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

async function exchange(callback: URL, verifier: string, resource?: string): Promise<Response> {
  return tokenRequest({
    grant_type: 'authorization_code', client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI,
    code: callback.searchParams.get('code')!, code_verifier: verifier, ...(resource ? { resource } : {}),
  });
}

/** A ChatGPT grant for one resource (none named: the default, /mcp). */
async function grant(resource?: string, how: 'owner' | 'demo' = 'owner'): Promise<{ access_token: string; refresh_token: string }> {
  const { verifier, challenge } = pkce();
  const callback = how === 'owner' ? await ownerCode(challenge, resource) : await demoCode(challenge, resource);
  const response = await exchange(callback, verifier, resource);
  expect(response.status).toBe(200);
  return await response.json() as { access_token: string; refresh_token: string };
}

function rpc(path: string, token: string | undefined, method: string, params: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function result(response: Response): Promise<Record<string, any>> {
  expect(response.status).toBe(200);
  const body = await response.json() as { result?: Record<string, any>; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result!;
}

const names = (tools: Array<{ name: string }>) => tools.map((tool) => tool.name);

describe('the directory allowlist', () => {
  test('is pinned, and names only tools the ChatGPT surface has', () => {
    expect(DIRECTORY_MCP_PATH).toBe('/openai/mcp');
    expect([...DIRECTORY_TOOL_NAMES]).toEqual([
      'olympus_dashboard',
      'olympus_search',
      'source_index_status',
      'source_answer',
      'source_answer_result',
      'ask_anonymously',
      'open_private_question',
      'olympus_connect_source',
      'olympus_scope_list',
      'olympus_scope_set',
      'olympus_disconnect_source',
      'olympus_model_set',
      'olympus_model_retry',
      'olympus_privacy_get',
      'olympus_privacy_set',
      'olympus_sync_source',
    ]);
    expect(Object.isFrozen(DIRECTORY_TOOL_NAMES)).toBe(true);
    const surfaceNames = new Set(CHATGPT_TOOLS.map((tool) => tool.name));
    const generatedNames = new Set(generatedSurface.tools.map((tool) => tool.name));
    for (const name of DIRECTORY_TOOL_NAMES) {
      expect(surfaceNames.has(name)).toBe(true);
      expect(generatedNames.has(name)).toBe(true);
    }
  });

  test('a newly generated tool is on /mcp only until the allowlist names it', () => {
    const future = [...generatedSurface.tools, { name: 'olympus_future_tool' }];
    expect(names(toolsForSurface(future, 'default'))).toContain('olympus_future_tool');
    expect(names(toolsForSurface(future, 'directory'))).not.toContain('olympus_future_tool');
    expect(names(toolsForSurface(future, 'directory'))).toEqual([...DIRECTORY_TOOL_NAMES]);
    expect(isDirectoryTool('olympus_future_tool')).toBe(false);
    expect(toolCallableOn('olympus_future_tool', 'default')).toBe(true);
    expect(toolCallableOn('olympus_future_tool', 'directory')).toBe(false);
    expect(isDirectoryTool(undefined)).toBe(false);
  });
});

describe('/openai/mcp serves the same surface, narrowed', () => {
  test('tools/list equals /mcp\'s narrowed to the allowlist, with and without an answer model', async () => {
    const def = await grant();
    const directory = await grant(DIRECTORY_RESOURCE);
    for (const withModel of [true, false]) {
      answerModel = withModel;
      const onMcp = (await result(await rpc('/mcp', def.access_token, 'tools/list'))).tools as Array<{ name: string }>;
      const onDirectory = (await result(await rpc(DIRECTORY_MCP_PATH, directory.access_token, 'tools/list'))).tools as Array<{ name: string }>;
      expect(onDirectory).toEqual(toolsForSurface(onMcp, 'directory'));
      // Today the allowlist is every tool the surface lists.
      expect(onDirectory).toEqual(onMcp);
      expect(names(onMcp).includes('source_answer')).toBe(withModel);
    }
  });

  test('a demo sign-in grant gets the same read-only tools on both endpoints', async () => {
    const def = await grant(undefined, 'demo');
    const directory = await grant(DIRECTORY_RESOURCE, 'demo');
    const onMcp = (await result(await rpc('/mcp', def.access_token, 'tools/list'))).tools as Array<{ name: string; annotations: { readOnlyHint?: boolean } }>;
    const onDirectory = (await result(await rpc(DIRECTORY_MCP_PATH, directory.access_token, 'tools/list'))).tools;
    expect(onDirectory).toEqual(onMcp);
    expect(onMcp.length).toBeGreaterThan(0);
    expect(onMcp.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
  });

  test('a tool off the allowlist is not listed there, and calling it is an unknown tool', async () => {
    const def = await grant();
    const directory = await grant(DIRECTORY_RESOURCE);
    directoryAllows = (name) => name !== 'olympus_privacy_get';
    const onMcp = (await result(await rpc('/mcp', def.access_token, 'tools/list'))).tools as Array<{ name: string }>;
    const onDirectory = (await result(await rpc(DIRECTORY_MCP_PATH, directory.access_token, 'tools/list'))).tools as Array<{ name: string }>;
    expect(names(onMcp)).toContain('olympus_privacy_get');
    expect(names(onDirectory)).not.toContain('olympus_privacy_get');
    expect(onDirectory).toEqual(onMcp.filter((tool) => tool.name !== 'olympus_privacy_get'));
    const refused = await result(await rpc(DIRECTORY_MCP_PATH, directory.access_token, 'tools/call', { name: 'olympus_privacy_get', arguments: {} }));
    const unknown = await result(await rpc('/mcp', def.access_token, 'tools/call', { name: 'no_such_tool', arguments: {} }));
    expect(refused).toEqual(unknown);
    expect(refused).toMatchObject({ isError: true, structuredContent: { error: 'unknown_tool' } });
    // /mcp still serves it.
    const served = await result(await rpc('/mcp', def.access_token, 'tools/call', { name: 'olympus_privacy_get', arguments: {} }));
    expect(served.structuredContent?.error).not.toBe('unknown_tool');
  });

  test('widget resources list and read on both endpoints', async () => {
    const def = await grant();
    const directory = await grant(DIRECTORY_RESOURCE);
    const listed = (await result(await rpc(DIRECTORY_MCP_PATH, directory.access_token, 'resources/list'))).resources as Array<{ uri: string }>;
    expect(listed).toEqual((await result(await rpc('/mcp', def.access_token, 'resources/list'))).resources);
    expect(listed.length).toBe(3);
    for (const { uri } of listed) {
      const read = await result(await rpc(DIRECTORY_MCP_PATH, directory.access_token, 'resources/read', { uri }));
      expect(read).toEqual(await result(await rpc('/mcp', def.access_token, 'resources/read', { uri })));
    }
  });
});

describe('/openai/mcp is its own protected resource', () => {
  test('metadata names the directory resource and equals what the relay serves', async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/openai/mcp`)).json();
    expect(prm).toEqual({ resource: DIRECTORY_RESOURCE, authorization_servers: [RELAY_ORIGIN], bearer_methods_supported: ['header'], resource_name: 'Olympus' });
    expect(prm).toEqual(relayProtectedResourceMetadata(relayOrigin(RELAY_HOST), 'directory'));
    expect(protectedResourceMetadata(urls)).toEqual(relayProtectedResourceMetadata(relayOrigin(RELAY_HOST)));
    expect((await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string }).resource).toBe(MCP_RESOURCE);
  });

  test('a 401 there points at the directory metadata; a /mcp 401 is unchanged', async () => {
    const missing = await rpc(DIRECTORY_MCP_PATH, undefined, 'initialize');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('WWW-Authenticate')).toBe(`Bearer realm="olympus", resource_metadata="${RELAY_ORIGIN}/.well-known/oauth-protected-resource/openai/mcp"`);
    const onMcp = await rpc('/mcp', undefined, 'initialize');
    expect(onMcp.headers.get('WWW-Authenticate')).toBe(`Bearer realm="olympus", resource_metadata="${RELAY_ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  test('a token opens only the endpoint it was issued for', async () => {
    const def = await grant();
    const directory = await grant(DIRECTORY_RESOURCE);
    expect(credentialInstallId('access', directory.access_token)).toBe(INSTALL_ID);
    expect((await rpc('/mcp', def.access_token, 'tools/list')).status).toBe(200);
    expect((await rpc(DIRECTORY_MCP_PATH, directory.access_token, 'tools/list')).status).toBe(200);
    const crossed = await rpc(DIRECTORY_MCP_PATH, def.access_token, 'tools/list');
    expect(crossed.status).toBe(401);
    expect(crossed.headers.get('WWW-Authenticate')).toContain('resource_metadata="https://mcp.olympus.test/.well-known/oauth-protected-resource/openai/mcp"');
    expect(crossed.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    const back = await rpc('/mcp', directory.access_token, 'tools/list');
    expect(back.status).toBe(401);
    expect(back.headers.get('WWW-Authenticate')).toContain('oauth-protected-resource/mcp"');
  });

  test('a bearer connection token names no resource and does not open the directory endpoint', async () => {
    const { token } = store.create('ChatGPT');
    expect((await rpc(DIRECTORY_MCP_PATH, token, 'tools/list')).status).toBe(401);
    // /mcp keeps accepting it (the operation surface: not a ChatGPT grant).
    expect((await rpc('/mcp', token, 'tools/list')).status).toBe(200);
  });

  test('refresh keeps each grant\'s audience; naming the other resource fails', async () => {
    const directory = await grant(DIRECTORY_RESOURCE);
    const rotated = await tokenRequest({ grant_type: 'refresh_token', refresh_token: directory.refresh_token, client_id: CHATGPT_CLIENT_ID });
    expect(rotated.status).toBe(200);
    const pair = await rotated.json() as { access_token: string; refresh_token: string };
    expect((await rpc(DIRECTORY_MCP_PATH, pair.access_token, 'tools/list')).status).toBe(200);
    expect((await rpc('/mcp', pair.access_token, 'tools/list')).status).toBe(401);
    const named = await tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: CHATGPT_CLIENT_ID, resource: DIRECTORY_RESOURCE });
    expect(named.status).toBe(200);
    const next = await named.json() as { refresh_token: string };
    const wrong = await tokenRequest({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: CHATGPT_CLIENT_ID, resource: MCP_RESOURCE });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('a code is exchanged only for the resource it was authorized for; an unknown resource is refused', async () => {
    const { verifier, challenge } = pkce();
    const callback = await ownerCode(challenge, DIRECTORY_RESOURCE);
    const wrong = await exchange(callback, verifier, MCP_RESOURCE);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_target' });
    expect((await exchange(callback, verifier, DIRECTORY_RESOURCE)).status).toBe(200);

    const other = await fetch(authorizeUrl('/connect/authorize', pkce().challenge, `${RELAY_ORIGIN}/openai/other`), { redirect: 'manual' });
    expect(other.status).toBe(303);
    expect(new URL(other.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
    // A trailing slash and host case name the same resource.
    const { verifier: v2, challenge: c2 } = pkce();
    const variant = await ownerCode(c2, 'https://MCP.olympus.test/openai/mcp/');
    const tokens = await (await exchange(variant, v2)).json() as { access_token: string };
    expect((await rpc(DIRECTORY_MCP_PATH, tokens.access_token, 'tools/list')).status).toBe(200);
  });

  test('the reviewer demo sign-in authorizes the directory resource', async () => {
    const directory = await grant(DIRECTORY_RESOURCE, 'demo');
    expect((await rpc(DIRECTORY_MCP_PATH, directory.access_token, 'tools/list')).status).toBe(200);
    expect((await rpc('/mcp', directory.access_token, 'tools/list')).status).toBe(401);
    expect(store.list().some((connection) => connection.displayName === 'ChatGPT (demo sign-in)')).toBe(true);
  });

  test('authorization with no resource stays bound to /mcp, as before', async () => {
    const def = await grant();
    expect((await rpc('/mcp', def.access_token, 'tools/list')).status).toBe(200);
    expect((await rpc(DIRECTORY_MCP_PATH, def.access_token, 'tools/list')).status).toBe(401);
  });
});

describe('the private answer panel through /openai/mcp', () => {
  test('a Private match found there is collected and decrypted by the panel, routed by its job id', async () => {
    const directory = await grant(DIRECTORY_RESOURCE);
    const search = await result(await rpc(DIRECTORY_MCP_PATH, directory.access_token, 'tools/call', { name: 'olympus_search', arguments: { question: 'When does the lease end?' } }));
    const meta = search._meta[PRIVATE_ANSWER_META_KEY] as { jobId: string; count: number };
    expect(meta.count).toBe(1);
    // The job id names the install (the relay routes /private/<id> by it), not the endpoint.
    expect(credentialInstallId('private', meta.jobId)).toBe(INSTALL_ID);
    expect(JSON.stringify(search.content)).not.toContain('SENTINEL_DIRECTORY_7f3a');

    const panel = await generatePanelKeyPair();
    const collectHandler = createPrivateAnswerHandler({ jobs, isRelayed: () => true });
    const collect = () => collectHandler(new Request(`http://127.0.0.1/private/${meta.jobId}`, {
      method: 'POST',
      headers: { origin: PANEL_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, publicKey: panel.publicKey }),
    }));
    let response = await collect();
    for (let i = 0; i < 100 && response.status === 202; i += 1) {
      await Bun.sleep(20);
      response = await collect();
    }
    expect(response.status).toBe(200);
    const sealed = await response.json() as SealedPrivateAnswer & { status: string };
    expect(sealed.status).toBe('ready');
    const opened = JSON.parse(await openPrivateAnswer(meta.jobId, panel.privateKey, sealed)) as { answer: string };
    expect(opened.answer).toStartWith('The lease ends on 31 May 2027.');
  });
});
