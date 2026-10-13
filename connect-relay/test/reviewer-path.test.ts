/**
 * The ChatGPT directory reviewer's path through the relay, held to what was
 * submitted (server/directory/approved.ts):
 *
 * - the pinned listing is byte for byte the submitted relay's generated files;
 * - everything the relay answers itself along the path (directory endpoint
 *   without a token, OAuth documents, ChatGPT's registration, the connect
 *   page with its demo button, the demo sign-in while the demo is offline)
 *   equals the submitted relay's answers (fixtures/reviewer-path/golden.json);
 * - the submitted engine's own relay connection (fixtures/reviewer-path/
 *   submitted, frozen) still connects to this relay as the demo install, and
 *   the demo sign-in, token exchange, directory MCP and private panel reach
 *   it unchanged.
 *
 * A failure here means a relay release would change what OpenAI's reviewers
 * see or break the frozen demo engine. Fix the relay; change the pinned
 * listing only as a new submission (see approved.ts).
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReviewerPath } from '../deploy/reviewer-check.ts';
import { APPROVED, APPROVED_TOOLS } from '../server/directory/approved.ts';
import { MemoryInstallRegistry } from '../server/registry.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';
import { recordReviewerPath, type RecordedAnswer } from './fixtures/reviewer-path/record.ts';
import goldenJson from './fixtures/reviewer-path/golden.json';
import { RelayClient, type RelayClientStatus } from './fixtures/reviewer-path/submitted/client/relay-client.ts';
import { DEMO_AUTHORIZE_PATH, FORWARDED_PATHS } from './fixtures/reviewer-path/submitted/client/forward.ts';
import { loadOrCreateIdentity } from './fixtures/reviewer-path/submitted/client/identity.ts';
import { base64url } from './fixtures/reviewer-path/submitted/shared/protocol.ts';
import { AUTHENTICATED_RESPONSE_HEADER, mintCredential } from './fixtures/reviewer-path/submitted/shared/tokens.ts';

setDefaultTimeout(20_000);

const golden = goldenJson as unknown as RecordedAnswer[];

const ROOT = join(import.meta.dir, '..', '..');
const PUBLIC_HOST = 'mcp.olympus.test';
const PANEL_ORIGIN = 'https://web-sandbox.oaiusercontent.com';

/** sha256 of server/directory/approved/*.json, the submitted commit's generated files. */
const APPROVED_DIGESTS: Record<string, string> = {
  'dashboard.json': '8425d4db73bd3c274a667dc413b7060067536d64af1cb72207f1bd85036308db',
  'private-answer.json': 'a0237d4a973735ebf93bcbc31a98227065c9ce263789af8a07b6cf2fb7473484',
  'private-question.json': 'd6194d5694b2e9b9efaefff3b0cbfcbfc07885338a5f276c183155dec7758c2b',
  'tools.json': 'ccc21709d33fcac8dbd99ef612159b12eff2099aa9cdb7a539902805721e6ed9',
};

const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('the pinned directory listing', () => {
  test('is the submitted relay\'s generated files, byte for byte', () => {
    expect(APPROVED.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const [file, digest] of Object.entries(APPROVED_DIGESTS)) {
      const bytes = readFileSync(join(ROOT, 'connect-relay/server/directory/approved', file));
      expect(`${file} ${createHash('sha256').update(bytes).digest('hex')}`).toBe(`${file} ${digest}`);
    }
  });
});

describe('what the relay answers itself on the reviewer\'s path', () => {
  test('equals the submitted relay\'s answers, step by step', async () => {
    const current = await recordReviewerPath(ROOT);
    expect(current.map((answer) => answer.name)).toEqual(golden.map((answer) => answer.name));
    for (const [index, answer] of current.entries()) {
      const submitted = golden[index]!;
      // Linux W5 deliberately changes only this page's platform wording.
      // Keep the submitted fixture immutable. Do not deploy this branch while
      // OpenAI review is open without the anchor's go.
      // The branch also neutralizes the two fixed disconnected-owner messages;
      // submitted tool descriptions, resources and all other bytes remain pinned.
      const platformCopy = JSON.parse(JSON.stringify(submitted)
        .replaceAll('Olympus is not connected to ChatGPT yet. If Olympus is on your Mac, connect it; otherwise install it first.', 'Olympus is not connected to ChatGPT yet. If Olympus is on your computer, connect it; otherwise install it first.')
        .replaceAll('Connect Olympus on your Mac to use this tool.', 'Connect Olympus on your computer to use this tool.')) as RecordedAnswer;
      const expected = submitted.name === 'connect page'
        ? { ...submitted, body: String(submitted.body).replaceAll('your Mac', 'your computer').replaceAll('the Mac', 'the computer').replaceAll('this Mac', 'this computer') }
        : platformCopy;
      expect(answer).toEqual(expected);
    }
  });
});

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
}

/** The demo engine's worker as the relay sees it: the answers the submitted engine gives on each reviewer path. */
function fakeDemoEngine(): { url: string; requests: SeenRequest[] } {
  const requests: SeenRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization: request.headers.get('authorization') });
      if (url.pathname === DEMO_AUTHORIZE_PATH) {
        return new Response('<!doctype html><h1>Sign in to the Olympus demo</h1><input type="password" name="password">', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname === '/connect/token') return Response.json({ access_token: 'from-engine', token_type: 'Bearer' });
      if (url.pathname === '/openai/mcp') {
        const message = await request.json() as { id: number };
        return Response.json(
          { jsonrpc: '2.0', id: message.id, result: { tools: APPROVED_TOOLS.slice(0, 1), from: 'demo-engine' } },
          { headers: { [AUTHENTICATED_RESPONSE_HEADER]: '1' } },
        );
      }
      if (url.pathname.startsWith('/private/')) return Response.json({ v: 1, status: 'pending' });
      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

async function connectSubmittedDemo(relay: RelayHandle, target: string, identity: ReturnType<typeof loadOrCreateIdentity>): Promise<RelayClient> {
  const statuses: RelayClientStatus[] = [];
  const client = new RelayClient({
    relayHost: PUBLIC_HOST,
    relayUrl: `ws://127.0.0.1:${relay.port}/v2/connect`,
    identity,
    target,
    relaySecret: base64url(crypto.getRandomValues(new Uint8Array(32))),
    heartbeatMs: 500,
    backoff: { minMs: 50, maxMs: 200 },
    onStatus: (status) => statuses.push(status),
    // A demo-marked install forwards its sign-in path too (src/core/remote-relay-runtime.ts).
    forwardedPaths: [...FORWARDED_PATHS, DEMO_AUTHORIZE_PATH],
  });
  client.start();
  cleanups.push(() => client.stop());
  const deadline = Date.now() + 5_000;
  while (statuses.at(-1)?.state !== 'online') {
    if (Date.now() > deadline) throw new Error(`the submitted demo engine did not come online: ${JSON.stringify(statuses.at(-1))}`);
    await Bun.sleep(10);
  }
  return client;
}

describe('the submitted demo engine behind the current relay', () => {
  test('connects, and the reviewer\'s sign-in, token, directory MCP and private panel reach it unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-reviewer-path-'));
    dirs.push(dir);
    const identity = loadOrCreateIdentity(dir);
    const relay = await startRelay({
      publicHost: PUBLIC_HOST,
      registry: new MemoryInstallRegistry(),
      listen: { host: '127.0.0.1', port: 0 },
      demoInstallId: identity.installId,
      appsChallenge: () => 'challenge-token',
    });
    cleanups.push(() => relay.close());
    const engine = fakeDemoEngine();
    const client = await connectSubmittedDemo(relay, engine.url, identity);

    // The deploy's live check (deploy/reviewer-check.ts) passes on this relay.
    const checked = await checkReviewerPath(PUBLIC_HOST, { demo: true, baseUrl: relay.url });
    expect(checked.filter((result) => !result.ok)).toEqual([]);
    expect(checked).toHaveLength(11);
    engine.requests.length = 0;

    const signIn = await fetch(`${relay.url}${DEMO_AUTHORIZE_PATH}?state=s`);
    expect(signIn.status).toBe(200);
    expect(await signIn.text()).toContain('Sign in to the Olympus demo');

    const token = await fetch(`${relay.url}/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=${mintCredential('code', identity.installId)}`,
    });
    expect(token.status).toBe(200);
    expect(await token.json()).toEqual({ access_token: 'from-engine', token_type: 'Bearer' });

    const credential = mintCredential('access', identity.installId);
    const listed = await fetch(`${relay.url}/openai/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
    });
    expect(listed.status).toBe(200);
    expect(listed.headers.get(AUTHENTICATED_RESPONSE_HEADER)).toBeNull();
    expect(await listed.json()).toEqual({ jsonrpc: '2.0', id: 7, result: { tools: APPROVED_TOOLS.slice(0, 1), from: 'demo-engine' } });

    const job = mintCredential('private', identity.installId);
    const panel = await fetch(`${relay.url}/private/${job}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PANEL_ORIGIN },
      body: JSON.stringify({ v: 1, publicKey: base64url(new Uint8Array(65)) }),
    });
    expect(panel.status).toBe(200);
    expect(panel.headers.get('access-control-allow-origin')).toBe(PANEL_ORIGIN);
    expect(await panel.json()).toEqual({ v: 1, status: 'pending' });

    expect(engine.requests.map((request) => `${request.method} ${request.path.split('?')[0]}`)).toEqual([
      `GET ${DEMO_AUTHORIZE_PATH}`,
      'POST /connect/token',
      'POST /openai/mcp',
      `POST /private/${job}`,
    ]);
    expect(engine.requests[2]!.authorization).toBe(`Bearer ${credential}`);

    // The demo Mac offline: the reviewer's ChatGPT still gets the submitted listing from the relay.
    await client.stop();
    const deadline = Date.now() + 5_000;
    let offline: { result?: { tools: unknown[] }; error?: unknown } = {};
    while (Date.now() < deadline) {
      const response = await fetch(`${relay.url}/openai/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }),
      });
      offline = await response.json() as typeof offline;
      if (offline.result && !('from' in offline.result)) break;
      await Bun.sleep(20);
    }
    const submitted = (name: string) => golden.find((answer) => answer.name === name)!.body as { result: Record<string, unknown> };
    const submittedTools = submitted('tools/list').result.tools as Array<{ name: string; _meta: unknown }>;
    expect(offline.result?.tools).toEqual(submittedTools);

    const offlineCall = async (id: number, method: string, params: Record<string, unknown>) => (await (await fetch(`${relay.url}/openai/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })).json()) as { result: Record<string, unknown> };
    // The offline dashboard carries the submitted dashboard tool's UI metadata, and every submitted bundle reads as submitted.
    const dashboard = await offlineCall(9, 'tools/call', { name: 'olympus_dashboard', arguments: {} });
    expect(dashboard.result.structuredContent).toMatchObject({ connection: { state: 'mac_offline' } });
    expect(dashboard.result._meta).toEqual(submittedTools.find((tool) => tool.name === 'olympus_dashboard')!._meta);
    for (const answer of golden.filter((recorded) => recorded.name.startsWith('resources/read '))) {
      const uri = answer.name.slice('resources/read '.length);
      const read = await offlineCall(10, 'resources/read', { uri });
      expect(read.result.contents).toEqual((answer.body as { result: { contents: unknown } }).result.contents);
    }
  });
});
