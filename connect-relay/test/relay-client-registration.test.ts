/**
 * `/connect/register` at the relay: the pinned apps' return addresses only
 * (ChatGPT, Claude, Grok), answered with that app's already pinned client,
 * nothing stored (server/client-registration.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_REGISTRATION_BYTES, pinnedClientForRedirect, registerPinnedClient } from '../server/client-registration.ts';
import { MemoryInstallRegistry } from '../server/registry.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';

const PUBLIC_HOST = 'mcp.olympus.test';
const STABLE = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CALLBACK = 'https://chatgpt.com/connector/oauth/cb_Abc-123';
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const GROK = 'https://grok.com/connectors-oauth-exchange-code/';
const GROK_CONSOLE = 'https://console.x.ai/connectors-oauth-exchange-code/';
const clientFor = (uri: string) => pinnedClientForRedirect(uri)?.clientId;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function makeRelay(): Promise<RelayHandle> {
  const relay = await startRelay({ publicHost: PUBLIC_HOST, registry: new MemoryInstallRegistry(), listen: { host: '127.0.0.1', port: 0 } });
  cleanups.push(() => relay.close());
  return relay;
}

describe('pinnedClientForRedirect', () => {
  test('maps ChatGPT\'s two return address shapes, Claude\'s and Grok\'s to their pinned clients', () => {
    expect(pinnedClientForRedirect(STABLE)).toEqual({ clientId: 'https://chatgpt.com/oauth/client.json', clientName: 'ChatGPT' });
    expect(pinnedClientForRedirect(CALLBACK)).toEqual({ clientId: 'https://chatgpt.com/oauth/cb_Abc-123/client.json', clientName: 'ChatGPT' });
    expect(pinnedClientForRedirect(CLAUDE)).toEqual({ clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata', clientName: 'Claude' });
    expect(pinnedClientForRedirect(GROK)).toEqual({ clientId: 'https://grok.com/oauth/mcp-client.json', clientName: 'Grok' });
    expect(pinnedClientForRedirect(GROK_CONSOLE)).toEqual({ clientId: 'https://grok.com/oauth/mcp-client.json', clientName: 'Grok' });
  });

  test('refuses everything else', () => {
    for (const uri of [
      'https://chatgpt.com/connector_platform_oauth_redirect/',
      'https://chatgpt.com/connector_platform_oauth_redirect?x=1',
      'http://chatgpt.com/connector_platform_oauth_redirect',
      'https://chatgpt.com.evil.example/connector_platform_oauth_redirect',
      'https://evil.example/connector/oauth/abc',
      'https://chatgpt.com/connector/oauth/',
      'https://chatgpt.com/connector/oauth/a/b',
      'https://chatgpt.com/connector/oauth/a%2Fb',
      `https://chatgpt.com/connector/oauth/${'a'.repeat(129)}`,
      'http://127.0.0.1/callback',
      'https://chatgpt.com/connector/oauth/codex',
      'https://claude.com/api/mcp/auth_callback',
      'https://claude.ai/api/mcp/auth_callback/',
      'https://claude.ai/api/mcp/auth_callback?x=1',
      'https://grok.com/connectors-oauth-exchange-code',
      'https://grok.com/connectors/oauth/callback',
      'https://grok.com.evil.example/connectors-oauth-exchange-code/',
      'https://x.ai/connectors-oauth-exchange-code/',
      'https://www.cursor.com/agents/mcp/oauth/callback',
      'constructor',
    ]) expect(clientFor(uri)).toBeUndefined();
  });
});

describe('registerPinnedClient', () => {
  const register = (body: unknown) => registerPinnedClient(typeof body === 'string' ? body : JSON.stringify(body), 1_700_000_000);

  test('a ChatGPT registration gets the pinned public client', () => {
    const outcome = register({ client_name: 'ChatGPT', redirect_uris: [STABLE], token_endpoint_auth_method: 'client_secret_basic', grant_types: ['authorization_code', 'refresh_token'] });
    expect(outcome).toEqual({
      ok: true,
      body: {
        client_id: 'https://chatgpt.com/oauth/client.json',
        client_id_issued_at: 1_700_000_000,
        client_name: 'ChatGPT',
        redirect_uris: [STABLE],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(register({ redirect_uris: [CALLBACK, CALLBACK] })).toMatchObject({ ok: true, body: { client_id: 'https://chatgpt.com/oauth/cb_Abc-123/client.json', redirect_uris: [CALLBACK] } });
  });

  test('Claude and Grok registrations get their pinned public clients, named by the pin, not the request', () => {
    // As Grok sends it (server logs, Aug-Sep 2026).
    expect(register({ client_name: 'Grok', redirect_uris: [GROK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' })).toEqual({
      ok: true,
      body: {
        client_id: 'https://grok.com/oauth/mcp-client.json',
        client_id_issued_at: 1_700_000_000,
        client_name: 'Grok',
        redirect_uris: [GROK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(register({ redirect_uris: [GROK, GROK_CONSOLE] })).toMatchObject({ ok: true, body: { client_id: 'https://grok.com/oauth/mcp-client.json', redirect_uris: [GROK, GROK_CONSOLE] } });
    expect(register({ client_name: 'ChatGPT', redirect_uris: [CLAUDE], grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'] }))
      .toMatchObject({ ok: true, body: { client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', client_name: 'Claude', grant_types: ['authorization_code', 'refresh_token'] } });
  });

  test('one registration names one app: mixing apps\' return addresses is refused', () => {
    for (const mixed of [[CLAUDE, GROK], [GROK, STABLE], [STABLE, CLAUDE], [CLAUDE, 'https://evil.example/cb']]) {
      expect(register({ redirect_uris: mixed })).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    }
  });

  test('refuses other, mixed or missing return addresses and malformed bodies', () => {
    expect(register({ redirect_uris: ['https://evil.example/cb'] })).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    expect(register({ redirect_uris: [STABLE, 'https://evil.example/cb'] })).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    expect(register({ redirect_uris: [STABLE, CALLBACK] })).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    expect(register({ redirect_uris: [] })).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    expect(register({ redirect_uris: [7] })).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    expect(register({})).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    expect(register({ redirect_uris: [STABLE], grant_types: ['client_credentials'] })).toMatchObject({ ok: false, error: 'invalid_client_metadata' });
    expect(register('not json')).toMatchObject({ ok: false, error: 'invalid_client_metadata' });
    expect(register('[]')).toMatchObject({ ok: false, error: 'invalid_client_metadata' });
  });
});

describe('the relay route', () => {
  test('answers a pinned app\'s registration and refuses the rest', async () => {
    const relay = await makeRelay();
    const post = (body: string, contentType = 'application/json') => fetch(`${relay.url}/connect/register`, { method: 'POST', headers: { 'Content-Type': contentType }, body });

    const ok = await post(JSON.stringify({ redirect_uris: [STABLE] }));
    expect(ok.status).toBe(201);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(((await ok.json()) as Record<string, unknown>).client_id).toBe('https://chatgpt.com/oauth/client.json');
    const grok = await post(JSON.stringify({ client_name: 'Grok', redirect_uris: [GROK] }));
    expect(grok.status).toBe(201);
    expect(((await grok.json()) as Record<string, unknown>).client_id).toBe('https://grok.com/oauth/mcp-client.json');

    const other = await post(JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'] }));
    expect(other.status).toBe(400);
    expect(((await other.json()) as Record<string, unknown>).error).toBe('invalid_redirect_uri');
    expect((await post(JSON.stringify({ redirect_uris: [STABLE] }), 'text/plain')).status).toBe(400);
    expect((await post('x'.repeat(MAX_REGISTRATION_BYTES + 1))).status).toBe(413);
    expect((await fetch(`${relay.url}/connect/register`)).status).toBe(405);

    const metadata = (await (await fetch(`${relay.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(metadata.registration_endpoint).toBe(`https://${PUBLIC_HOST}/connect/register`);
  });
});

describe('the CIMD advertisement switch', () => {
  test('metadata leaves out CIMD support only while the switch says so, read per request', async () => {
    let advertise = true;
    const relay = await startRelay({ publicHost: PUBLIC_HOST, registry: new MemoryInstallRegistry(), listen: { host: '127.0.0.1', port: 0 }, advertiseCimd: () => advertise });
    cleanups.push(() => relay.close());
    const metadata = async () => (await (await fetch(`${relay.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect((await metadata()).client_id_metadata_document_supported).toBe(true);
    advertise = false;
    const off = await metadata();
    expect('client_id_metadata_document_supported' in off).toBe(false);
    expect(off.registration_endpoint).toBe(`https://${PUBLIC_HOST}/connect/register`);
    advertise = true;
    expect((await metadata()).client_id_metadata_document_supported).toBe(true);
  });
});
