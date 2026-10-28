// The shared MCP source layer (src/core/mcp-source/), against the fake
// Evernote server only: allowlist and read-only refusal, pacing, rate-limit
// backoff, the call budget, cancellation, sign-in with an explicit scope,
// token refresh and the revoked-sign-in state. Nothing here names a provider
// in the layer itself; the fake is just a server with read tools.
import { afterEach, describe, expect, test } from 'bun:test';
import { McpSourceError } from '../src/core/mcp-source/errors.ts';
import {
  McpTokenSource,
  mcpAuthorizedFetch,
  secretStoreMcpCredentials,
  startMcpSignIn,
} from '../src/core/mcp-source/oauth.ts';
import { McpCallPacer } from '../src/core/mcp-source/pacer.ts';
import { McpSourceSession, type McpSourceSessionOptions } from '../src/core/mcp-source/session.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { FakeEvernoteServer } from './support/evernote-mcp-fake.ts';

const READ = ['search_notes', 'search_notebooks', 'get_note', 'get_attachment'] as const;

function memorySecretStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    label: 'memory',
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
    list: async () => [...values.keys()],
  };
}

/** A pacer that never really sleeps, recording the waits it would have made. */
function recordingPacer(minIntervalMs = 1000): { pacer: McpCallPacer; waits: number[]; clock: { t: number } } {
  const clock = { t: 0 };
  const waits: number[] = [];
  const pacer = new McpCallPacer({
    minIntervalMs,
    now: () => clock.t,
    sleep: async (ms) => { waits.push(ms); clock.t += ms; },
  });
  return { pacer, waits, clock };
}

let fake: FakeEvernoteServer | undefined;
afterEach(() => {
  fake?.stop();
  fake = undefined;
});

function session(server: FakeEvernoteServer, overrides: Partial<McpSourceSessionOptions> = {}): McpSourceSession {
  return new McpSourceSession({
    serverUrl: server.url,
    clientName: 'olympus-test',
    clientVersion: '1.0.0',
    readTools: READ,
    callBudget: 100,
    pacer: recordingPacer(0).pacer,
    rateLimitBackoffMs: 10,
    ...overrides,
  });
}

describe('MCP source session', () => {
  test('a tool the connector did not name is refused before it is sent', async () => {
    fake = new FakeEvernoteServer().start();
    const s = session(fake);
    await s.open();
    await expect(s.callTool('create_note', { title: 'x' })).rejects.toMatchObject({ kind: 'tool_refused' });
    await expect(s.callTool('delete_note', { noteId: 'x' })).rejects.toMatchObject({ kind: 'tool_refused' });
    expect(fake.calls.create_note).toBeUndefined();
    expect(fake.calls.delete_note).toBeUndefined();
    await s.close();
  });

  test('a named tool the server stops marking read-only is refused', async () => {
    fake = new FakeEvernoteServer({ readOnlyHint: { search_notes: false } }).start();
    const s = session(fake);
    await s.open();
    const refused = await s.callTool('search_notes', { query: '' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(McpSourceError);
    expect((refused as McpSourceError).kind).toBe('tool_refused');
    expect((refused as McpSourceError).dashboardState).toBe('provider_error');
    expect(fake.calls.search_notes).toBeUndefined();
    // The other named tools still answer.
    expect((await s.callTool('search_notebooks', { query: '' })).isError).toBe(false);
    await s.close();
  });

  test('tool output is data only: no description or server instruction comes back', async () => {
    fake = new FakeEvernoteServer().start();
    fake.addNote({ title: 'A note', created: Date.UTC(2020, 0, 1) });
    const s = session(fake);
    await s.open();
    const out = await s.callTool('search_notes', { query: '', maxResults: 10 });
    expect((out.data as { totalResultCount: number }).totalResultCount).toBe(1);
    // The session keeps only, per tool, whether it says it is read-only.
    const kept = (s as unknown as { readOnly: Map<string, boolean> }).readOnly;
    expect([...kept.values()].every((value) => typeof value === 'boolean')).toBe(true);
    const everything = JSON.stringify(out);
    expect(everything).not.toContain('IGNORE PREVIOUS');
    expect(everything).not.toContain('SERVER TOOL DESCRIPTION');
    await s.close();
  });

  test('a rate-limit answer is retried after a backoff, then reported when it persists', async () => {
    fake = new FakeEvernoteServer().start();
    const { pacer, waits } = recordingPacer(0);
    const s = session(fake, { pacer, rateLimitBackoffMs: 500, rateLimitRetries: 2 });
    await s.open();
    fake.rateLimitNext = 1;
    expect((await s.callTool('search_notebooks', { query: '' })).isError).toBe(false);
    expect(s.rateLimitRetries).toBe(1);
    expect(waits).toContain(500);
    fake.rateLimitNext = 10;
    const error = await s.callTool('search_notebooks', { query: '' }).catch((e: unknown) => e) as McpSourceError;
    expect(error.kind).toBe('rate_limited');
    expect(error.dashboardState).toBe('rate_limited');
    expect(error.retryAfterMs).toBe(1500);
    await s.close();
  });

  test('an HTTP 429 from the server is retried the same way', async () => {
    fake = new FakeEvernoteServer().start();
    const s = session(fake);
    await s.open();
    fake.http429Next = 1;
    expect((await s.callTool('search_notebooks', { query: '' })).isError).toBe(false);
    expect(s.rateLimitRetries).toBe(1);
    await s.close();
  });

  test('the call budget stops a pass, and so does cancellation, between calls', async () => {
    fake = new FakeEvernoteServer().start();
    const budgeted = session(fake, { callBudget: 2 });
    await budgeted.open(); // the tool listing is one call
    await budgeted.callTool('search_notebooks', { query: '' });
    await expect(budgeted.callTool('search_notebooks', { query: '' })).rejects.toMatchObject({ kind: 'budget_exhausted', dashboardState: 'paused' });
    expect(fake.calls.search_notebooks).toBe(1);
    await budgeted.close();

    let go = true;
    const cancellable = session(fake, { shouldContinue: () => go });
    await cancellable.open();
    await cancellable.callTool('search_notebooks', { query: '' });
    go = false;
    await expect(cancellable.callTool('search_notebooks', { query: '' })).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fake.calls.search_notebooks).toBe(2);
    await cancellable.close();
  });

  test('a tool error that is not about rate or permission comes back as data', async () => {
    fake = new FakeEvernoteServer().start();
    const s = session(fake);
    await s.open();
    const missing = await s.callTool('get_note', { noteId: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('not found');
    await s.close();
  });
});

describe('MCP pacer', () => {
  test('calls to one server are spaced, and a backoff pushes the next one out', async () => {
    const { pacer, waits, clock } = recordingPacer(1000);
    await pacer.turn();
    await pacer.turn();
    await pacer.turn();
    expect(waits).toEqual([1000, 1000]);
    pacer.backoff(15_000);
    await pacer.turn();
    expect(waits[2]).toBe(15_000);
    expect(clock.t).toBe(17_000);
  });
});

describe('MCP sign-in and tokens', () => {
  const signIn = async (server: FakeEvernoteServer, hosts: readonly string[] = ['127.0.0.1']) => startMcpSignIn({
    serverUrl: server.url,
    scope: 'read',
    clientName: 'Olympus (test)',
    redirectUrl: 'http://127.0.0.1:9/oauth/callback/evernote',
    state: 'state-123',
    authorizationHosts: hosts,
  });

  test('sign-in registers a client and asks for the connector\'s scope alone, with PKCE', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const pending = await signIn(fake);
    const url = new URL(pending.authorizationUrl);
    expect(url.origin).toBe(fake.origin);
    expect(url.searchParams.get('scope')).toBe('read');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The server advertises more scopes; registration still asks for `read` only.
    expect(fake.registeredScopes).toEqual(['read']);
    const credential = await pending.complete('good-code');
    expect(credential.scope).toBe('read');
    expect(credential.tokens.refresh_token).toBeDefined();
    await expect(pending.complete('bad-code')).rejects.toMatchObject({ kind: 'auth_revoked' });
  });

  test('a sign-in that would go to a host the connector did not name is refused', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    await expect(signIn(fake, ['evernote.com'])).rejects.toMatchObject({ kind: 'server_error' });
    expect(fake.registeredScopes).toEqual([]);
  });

  test('an expired token is renewed and the read goes on; a refused renewal says reconnect', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const secrets = memorySecretStore();
    const store = secretStoreMcpCredentials(secrets, 'mcp.test.1');
    await store.write(await (await signIn(fake)).complete('good-code'));
    const tokens = new McpTokenSource({ store, serverUrl: fake.url });
    const authed = () => session(fake!, { fetch: mcpAuthorizedFetch(tokens, fake!.url) });

    const first = authed();
    await first.open();
    expect((await first.callTool('search_notebooks', { query: '' })).isError).toBe(false);
    await first.close();

    fake.expireAccessToken();
    const issued = fake.tokenIssues;
    const second = authed();
    await second.open();
    expect((await second.callTool('search_notebooks', { query: '' })).isError).toBe(false);
    expect(fake.tokenIssues).toBe(issued + 1);
    // The renewed credential was written back.
    expect((await store.read())?.tokens.access_token).toBe(fake.accessToken);
    await second.close();

    fake.expireAccessToken();
    fake.refreshRevoked = true;
    const third = authed();
    const error = await third.open().catch((e: unknown) => e) as McpSourceError;
    expect(error).toBeInstanceOf(McpSourceError);
    expect(error.kind).toBe('auth_revoked');
    expect(error.dashboardState).toBe('reconnect_required');
    await third.close();
  });

  test('a token about to expire is renewed before it is sent', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const store = secretStoreMcpCredentials(memorySecretStore(), 'mcp.test.1');
    await store.write(await (await signIn(fake)).complete('good-code'));
    let now = Date.now();
    const tokens = new McpTokenSource({ store, serverUrl: fake.url, now: () => new Date(now) });
    const before = fake.tokenIssues;
    now += 3_590_000;
    expect(await tokens.accessToken()).toBe(fake.accessToken);
    expect(fake.tokenIssues).toBe(before + 1);
  });

  test('no stored sign-in, or a 403, has its own state', async () => {
    fake = new FakeEvernoteServer({ auth: true }).start();
    const store = secretStoreMcpCredentials(memorySecretStore(), 'mcp.test.1');
    const tokens = new McpTokenSource({ store, serverUrl: fake.url });
    await expect(session(fake, { fetch: mcpAuthorizedFetch(tokens, fake.url) }).open()).rejects.toMatchObject({ kind: 'auth_missing' });
    await store.write(await (await signIn(fake)).complete('good-code'));
    fake.forbidden = true;
    await expect(session(fake, { fetch: mcpAuthorizedFetch(tokens, fake.url) }).open()).rejects.toMatchObject({ kind: 'permission_missing', dashboardState: 'permission_missing' });
  });
});
