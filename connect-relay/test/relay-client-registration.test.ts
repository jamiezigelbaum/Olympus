/**
 * `/connect/register` at the relay: ChatGPT return addresses only, answered
 * with an already pinned ChatGPT client, nothing stored
 * (server/client-registration.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_REGISTRATION_BYTES, chatGptClientForRedirect, registerChatGptClient } from '../server/client-registration.ts';
import { MemoryInstallRegistry } from '../server/registry.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';

const PUBLIC_HOST = 'mcp.olympus.test';
const STABLE = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CALLBACK = 'https://chatgpt.com/connector/oauth/cb_Abc-123';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function makeRelay(): Promise<RelayHandle> {
  const relay = await startRelay({ publicHost: PUBLIC_HOST, registry: new MemoryInstallRegistry(), listen: { host: '127.0.0.1', port: 0 } });
  cleanups.push(() => relay.close());
  return relay;
}

describe('chatGptClientForRedirect', () => {
  test('maps ChatGPT\'s two return address shapes to their pinned clients', () => {
    expect(chatGptClientForRedirect(STABLE)).toBe('https://chatgpt.com/oauth/client.json');
    expect(chatGptClientForRedirect(CALLBACK)).toBe('https://chatgpt.com/oauth/cb_Abc-123/client.json');
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
    ]) expect(chatGptClientForRedirect(uri)).toBeUndefined();
  });
});

describe('registerChatGptClient', () => {
  const register = (body: unknown) => registerChatGptClient(typeof body === 'string' ? body : JSON.stringify(body), 1_700_000_000);

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
  test('answers a ChatGPT registration and refuses the rest', async () => {
    const relay = await makeRelay();
    const post = (body: string, contentType = 'application/json') => fetch(`${relay.url}/connect/register`, { method: 'POST', headers: { 'Content-Type': contentType }, body });

    const ok = await post(JSON.stringify({ redirect_uris: [STABLE] }));
    expect(ok.status).toBe(201);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(((await ok.json()) as Record<string, unknown>).client_id).toBe('https://chatgpt.com/oauth/client.json');

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
