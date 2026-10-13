// The engine's side of the relay's offline tool lists and offline result
// (docs/design/background-agents.md, section E): the loopback route the relay
// child reads with its per-boot secret, what it lists for each live access
// token, and the offline body's fit to the remote error schema. Fingerprints
// are computed here from the published construction.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { offlineErrorBody } from '../connect-relay/shared/offline-result.ts';
import { parseSurfacesMessage } from '../connect-relay/shared/protocol.ts';
import { RELAY_SURFACES_PATH } from '../src/core/remote-access.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { parseRemotePublicBaseUrl, remoteMcpResource, type RemotePublicUrls } from '../src/core/remote-public-url.ts';
import { readSurfaceEntries } from '../src/core/remote-relay-runtime.ts';
import { REMOTE_ERROR_SCHEMA } from '../src/core/remote-result.ts';
import { CHATGPT_CLIENT_ID, CLAUDE_CLIENT_ID, GROK_CLIENT_ID } from '../src/workers/remote-oauth/pinned-clients.ts';
import { createRelaySurfacesHandler, withRelaySurfacesRoute } from '../src/workers/relay-surfaces.ts';

const SECRET = 'relay-child-secret-for-surface-tests';

let dir: string;
let store: RemoteConnectionStore;
let clock: number;
let urls: RemotePublicUrls;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-relay-surfaces-'));
  clock = Date.parse('2026-10-12T12:00:00.000Z');
  store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'), { now: () => new Date(clock) });
  const resolved = parseRemotePublicBaseUrl('https://olympus.example.test');
  if (!resolved.enabled) throw new Error('test URL refused');
  urls = resolved.urls;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function fingerprintOf(token: string): string {
  const digest = createHash('sha256').update(token, 'utf8').digest();
  return createHash('sha256').update('olympus-relay/surface-fingerprint/v1\n', 'utf8').update(digest).digest('base64url');
}

function handler() {
  return withRelaySurfacesRoute(
    createRelaySurfacesHandler({
      connections: () => store,
      publicUrls: () => urls,
      isRelayed: (request) => request.headers.get('x-olympus-relay') === SECRET,
    }),
    async () => new Response('rest', { status: 299 }),
  );
}

async function read(headers: Record<string, string> = { 'x-olympus-relay': SECRET }, method = 'GET') {
  const response = await handler()(new Request(`http://127.0.0.1${RELAY_SURFACES_PATH}`, { method, headers }));
  return { status: response.status, body: await response.json() as { v?: number; entries?: Array<Record<string, unknown>>; error?: string } };
}

function grant(clientId: string, name: string, resource = urls.resource) {
  return store.oauth.createGrant({ clientId, displayName: name, resource });
}

describe('the mapping route', () => {
  test('answers only the relay child, by its secret, and only GET; other paths pass through', async () => {
    expect((await read({})).status).toBe(404);
    expect((await read({ 'x-olympus-relay': 'guess' })).status).toBe(404);
    expect((await read({ 'x-olympus-relay': SECRET }, 'POST')).status).toBe(404);
    expect((await read()).status).toBe(200);
    const other = await handler()(new Request('http://127.0.0.1/mcp', { method: 'POST' }));
    expect(other.status).toBe(299);
  });

  test('lists each live /mcp access token: ChatGPT\'s as chatgpt, every other agent\'s as remote, with its expiry', async () => {
    const chatgpt = grant(CHATGPT_CLIENT_ID, 'ChatGPT');
    const claude = grant(CLAUDE_CLIENT_ID, 'Claude');
    const grok = grant(GROK_CLIENT_ID, 'Grok');
    // A directory-endpoint token is not listed: the relay serves that endpoint ChatGPT's directory list whatever the token.
    grant(CHATGPT_CLIENT_ID, 'ChatGPT directory', remoteMcpResource(urls, 'directory').resource);
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.v).toBe(1);
    const expiresAt = Math.floor(clock / 1000) + chatgpt.tokens.expiresIn;
    const byFingerprint = Object.fromEntries(body.entries!.map((item) => [item.fingerprint, item]));
    expect(byFingerprint).toEqual({
      [fingerprintOf(chatgpt.tokens.accessToken)]: { endpoint: 'default', fingerprint: fingerprintOf(chatgpt.tokens.accessToken), surface: 'chatgpt', expiresAt },
      [fingerprintOf(claude.tokens.accessToken)]: { endpoint: 'default', fingerprint: fingerprintOf(claude.tokens.accessToken), surface: 'remote', expiresAt },
      [fingerprintOf(grok.tokens.accessToken)]: { endpoint: 'default', fingerprint: fingerprintOf(grok.tokens.accessToken), surface: 'remote', expiresAt },
    });
    // Exactly the relay's wire shape.
    expect(parseSurfacesMessage({ type: 'surfaces', v: body.v, entries: body.entries })).toHaveLength(3);
  });

  test('content-free: no token, digest, refresh token, connection id, name or client', async () => {
    const chatgpt = grant(CHATGPT_CLIENT_ID, 'Dana\'s ChatGPT');
    const { body } = await read();
    const text = JSON.stringify(body);
    for (const leak of [
      chatgpt.tokens.accessToken,
      chatgpt.tokens.accessToken.split('.').at(-1)!,
      chatgpt.tokens.refreshToken,
      createHash('sha256').update(chatgpt.tokens.accessToken).digest('base64url'),
      createHash('sha256').update(chatgpt.tokens.accessToken).digest('hex'),
      chatgpt.connection.id,
      'Dana',
      'chatgpt.com',
    ]) expect(text).not.toContain(leak);
    for (const item of body.entries!) expect(Object.keys(item).sort()).toEqual(['endpoint', 'expiresAt', 'fingerprint', 'surface']);
  });

  test('rotation adds the new token; revocation and expiry remove a token', async () => {
    const chatgpt = grant(CHATGPT_CLIENT_ID, 'ChatGPT');
    const claude = grant(CLAUDE_CLIENT_ID, 'Claude');
    const fingerprints = async () => (await read()).body.entries!.map((item) => item.fingerprint).sort();

    const rotated = store.oauth.refresh({ refreshToken: chatgpt.tokens.refreshToken, clientId: CHATGPT_CLIENT_ID, resource: urls.resource });
    if (!rotated.ok) throw new Error(`refresh refused: ${rotated.reason}`);
    expect(await fingerprints()).toEqual([fingerprintOf(rotated.tokens.accessToken), fingerprintOf(claude.tokens.accessToken)].sort());

    store.oauth.revokeToken(claude.tokens.accessToken);
    expect(await fingerprints()).toEqual([fingerprintOf(rotated.tokens.accessToken)]);

    const later = grant(CLAUDE_CLIENT_ID, 'Claude again');
    store.oauth.revokeGrant(later.connection.id);
    expect(await fingerprints()).toEqual([fingerprintOf(rotated.tokens.accessToken)]);

    clock += rotated.tokens.expiresIn * 1000;
    expect(await fingerprints()).toEqual([]);
  });

  test('empty, not failing, without a public address or a store', async () => {
    const noUrls = createRelaySurfacesHandler({ connections: () => store, publicUrls: undefined, isRelayed: () => true });
    expect(await (await noUrls(new Request(`http://127.0.0.1${RELAY_SURFACES_PATH}`))).json()).toEqual({ v: 1, entries: [] });
    const noStore = createRelaySurfacesHandler({ connections: () => undefined, publicUrls: () => urls, isRelayed: () => true });
    expect(await (await noStore(new Request(`http://127.0.0.1${RELAY_SURFACES_PATH}`))).json()).toEqual({ v: 1, entries: [] });
    const broken = createRelaySurfacesHandler({ connections: () => { throw new Error('locked'); }, publicUrls: () => urls, isRelayed: () => true });
    const refused = await broken(new Request(`http://127.0.0.1${RELAY_SURFACES_PATH}`));
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toContain('locked');
  });
});

describe('the relay child reads it', () => {
  test('with the secret it gets the checked entries; without it, or from a broken worker, nothing', async () => {
    const chatgpt = grant(CHATGPT_CLIENT_ID, 'ChatGPT');
    const route = handler();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => route(request) });
    try {
      const target = `http://127.0.0.1:${server.port}`;
      const entries = await readSurfaceEntries(target, SECRET, fetch);
      expect(entries?.map((item) => [item.fingerprint, item.surface])).toEqual([[fingerprintOf(chatgpt.tokens.accessToken), 'chatgpt']]);
      expect(await readSurfaceEntries(target, 'wrong-secret', fetch)).toBeUndefined();
    } finally {
      server.stop(true);
    }
    const junk = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ v: 1, entries: [{ fingerprint: 'x', surface: 'admin' }] }) });
    try {
      expect(await readSurfaceEntries(`http://127.0.0.1:${junk.port}`, SECRET, fetch)).toBeUndefined();
    } finally {
      junk.stop(true);
    }
  });
});

describe('the relay\'s offline result', () => {
  test('is a remote error body: the closed schema accepts it, and it carries retry_after_seconds', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(REMOTE_ERROR_SCHEMA);
    const now = Date.parse('2026-10-12T12:00:00.000Z');
    for (const lastSeen of [undefined, now - 10 * 60_000, now - 5 * 3_600_000, now - 9 * 86_400_000]) {
      const body = offlineErrorBody(lastSeen, now);
      expect({ ok: validate(body), errors: validate.errors ?? null }).toEqual({ ok: true, errors: null });
      expect(body.retry_after_seconds).toBe(300);
    }
    expect(validate({ ...offlineErrorBody(now, now), last_seen_at: now })).toBe(false);
  });
});
