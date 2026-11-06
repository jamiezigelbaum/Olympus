import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startExternalOAuthSourceConnection, type OAuthFetch } from '../src/core/connect.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { readConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(bookmarks: OAuthFetch, timeoutMs = 1000) {
  const root = mkdtempSync(join(tmpdir(), 'olympus-x-connect-check-'));
  roots.push(root);
  const registryPath = join(root, 'handles.json');
  const values = new Map<string, string>([['unrelated.fixture', 'unchanged']]);
  const writes: string[] = [];
  const store: SecretStore = {
    label: 'fixture',
    async get(key) { return values.get(key); },
    async set(key, value) { writes.push(key); values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list() { return [...values.keys()]; },
  };
  const calls: string[] = [];
  let stateSaves = 0;
  const pending = await startExternalOAuthSourceConnection({
    source: 'x', clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret',
    redirectUri: 'https://dashboard.example/oauth/callback/x',
    tokenUrl: 'https://provider.example/2/oauth2/token',
    registryPath, secretStore: store, tokenExchangeTimeoutMs: timeoutMs,
    historyEnv: { HOME: root, XDG_DATA_HOME: join(root, 'data') },
    oauth2StateStore: { async load() { return undefined; }, async save() { stateSaves++; } },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === '/2/oauth2/token') return Response.json({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token' });
      if (url.pathname === '/2/users/me') return Response.json({ data: { id: '123456' } });
      if (url.pathname === '/2/users/123456/bookmarks') {
        expect(url.searchParams.get('max_results')).toBe('1');
        expect(init?.method).toBe('GET');
        expect(init?.redirect).toBe('error');
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-access-token');
        expect(writes).toEqual([]);
        expect(stateSaves).toBe(0);
        return bookmarks(input, init);
      }
      throw new Error('Unexpected request');
    },
  });
  return { pending, registryPath, values, writes, calls, stateSaves: () => stateSaves };
}

for (const [name, body] of [
  ['empty account', { meta: { result_count: 0 } }],
  ['one bookmark', { data: [{ id: '456789', text: 'Fixture bookmark' }], meta: { result_count: 1 } }],
  ['one bookmark with a partial resource error', {
    data: [{ id: '456789', text: 'Fixture bookmark' }], meta: { result_count: 1 },
    errors: [{ title: 'Not Found Error', resource_type: 'tweet', resource_id: '987654', detail: 'A different bookmarked post is unavailable.' }],
  }],
] as const) {
  test(`X connect checks bookmarks before saving: ${name}`, async () => {
    const item = await fixture(async () => Response.json(body));
    await item.pending.completeCallback({ state: item.pending.state, code: 'fixture-code' });
    expect(item.calls).toEqual(['/2/oauth2/token', '/2/users/me', '/2/users/123456/bookmarks']);
    expect(readConnectedHandleRegistry(item.registryPath).handles[0]?.providerAccountId).toBe('123456');
    expect(item.stateSaves()).toBe(1);
  });
}

for (const status of [401, 402, 403, 429, 500]) {
  test(`X connect refuses bookmarks HTTP ${status} without saving or echoing secrets`, async () => {
    const item = await fixture(async () => new Response('fixture-access-token fixture-client-secret provider-body', { status }));
    let message = '';
    try { await item.pending.completeCallback({ state: item.pending.state, code: 'fixture-code' }); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain('No credentials were stored');
    expect(message).not.toContain('fixture-');
    expect(message).not.toContain('provider-body');
    if (status === 402 || status === 403) expect(message).toContain('Check the cost');
    expect(item.writes).toEqual([]);
    expect(item.stateSaves()).toBe(0);
    expect([...item.values]).toEqual([['unrelated.fixture', 'unchanged']]);
    expect(readConnectedHandleRegistry(item.registryPath).handles).toEqual([]);
  });
}

for (const body of ['not json', 'null', '{}', '{"data":[]}', '{"data":{},"meta":{"result_count":0}}', '{"data":[{}],"meta":{"result_count":1}}', '{"errors":[{"detail":"fixture-access-token"}],"meta":{"result_count":0}}']) {
  test(`X connect refuses malformed bookmarks response: ${body}`, async () => {
    const item = await fixture(async () => new Response(body));
    await expect(item.pending.completeCallback({ state: item.pending.state, code: 'fixture-code' })).rejects.toThrow('No credentials were stored');
    expect(item.writes).toEqual([]);
    expect(item.stateSaves()).toBe(0);
    expect(readConnectedHandleRegistry(item.registryPath).handles).toEqual([]);
  });
}

test('X bookmarks check bounds the body and does not echo oversized data', async () => {
  const item = await fixture(async () => new Response('fixture-access-token'.repeat(4096)));
  await expect(item.pending.completeCallback({ state: item.pending.state, code: 'fixture-code' })).rejects.toThrow('No credentials were stored');
  expect(item.writes).toEqual([]);
});

test('X bookmarks check times out while reading the body, before any grant is stored', async () => {
  let cancelled = false;
  const item = await fixture(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelled = true; },
  })), 20);
  await expect(item.pending.completeCallback({ state: item.pending.state, code: 'fixture-code' })).rejects.toThrow('No credentials were stored');
  expect(cancelled).toBe(true);
  expect(item.writes).toEqual([]);
  expect(item.stateSaves()).toBe(0);
});
