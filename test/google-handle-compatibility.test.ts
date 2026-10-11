import { expect, test } from 'bun:test';
import { isRetiredGoogleHandle } from '../src/core/google-handle-compatibility.ts';
import type { ConnectedCredentialHandle } from '../src/workers/credential-broker/connected-handles.ts';

test('only unservable private Google grants are eligible for reconnect replacement', () => {
  for (const [provider, handle] of [['gmail', 'gmail.personal.delegated'], ['google_drive', 'google_drive.personal.delegated']] as const) {
    const legacy: ConnectedCredentialHandle = { provider, handle, accountRole: 'personal', trustDomain: 'secure_local', allowedCapabilities: [provider === 'gmail' ? 'gmail.email.sync' : 'google_drive.docs.sync'], scopes: [], connectedAt: '2026-09-01T00:00:00Z' };
    expect(isRetiredGoogleHandle(legacy, true)).toBe(true);
    expect(isRetiredGoogleHandle(legacy, false)).toBe(false);
    expect(isRetiredGoogleHandle({ ...legacy, tokenSecretRefs: ['store:google.token'] }, true)).toBe(false);
    expect(isRetiredGoogleHandle({ ...legacy, handle: `${provider}.personal` }, true)).toBe(false);
    expect(isRetiredGoogleHandle({ ...legacy, oauth2Refresh: { tokenUrl: 'https://oauth2.googleapis.com/token', clientIdSecretRef: 'store:google.client', refreshTokenSecretRef: 'store:google.refresh' } }, true)).toBe(false);
  }
});

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConnectedHandleRegistry, upsertConnectedHandle } from '../src/workers/credential-broker/connected-handles.ts';
import type { SecretStore } from '../src/core/secret-store.ts';

test('public Google consent replaces bare delegated handles only after successful exchange', async () => {
  const mirror = mkdtempSync(join(import.meta.dir, '..', '.google-public-migration-'));
  try {
    cpSync(join(import.meta.dir, '..', 'src'), join(mirror, 'src'), { recursive: true });
    writeFileSync(join(mirror, 'src/core/build-flavor.ts'), 'export const PUBLIC_RUNTIME_BUILD = true;\n');
    const { connectOAuthSource } = await import(join(mirror, 'src/core/connect.ts')) as typeof import('../src/core/connect.ts');
    const registryPath = join(mirror, 'handles.json');
    for (const [provider, handle] of [['gmail', 'gmail.personal.delegated'], ['google_drive', 'google_drive.personal.delegated']] as const) {
      upsertConnectedHandle({ provider, handle, accountRole: 'personal', trustDomain: 'secure_local', allowedCapabilities: [provider === 'gmail' ? 'gmail.email.sync' : 'google_drive.docs.sync'], scopes: [], connectedAt: '2026-09-01T00:00:00Z' }, registryPath);
    }
    const values = new Map<string, string>();
    const secretStore: SecretStore = { label: 'fixture', get: async key => values.get(key), set: async (key, value) => { values.set(key, value); }, delete: async key => { values.delete(key); }, list: async () => [...values.keys()] };
    let success = false;
    const connect = () => connectOAuthSource({ source: 'google', clientId: 'google-test-client', registryPath, secretStore, openBrowser: false,
      fetch: async () => new Response(JSON.stringify(success ? { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 } : { error: 'invalid_grant' }), { status: success ? 200 : 400, headers: { 'Content-Type': 'application/json' } }),
      onAuthorizationUrl: async url => { const consent = new URL(url); const callback = new URL(consent.searchParams.get('redirect_uri')!); callback.searchParams.set('state', consent.searchParams.get('state')!); callback.searchParams.set('code', 'fixture-code'); await fetch(callback); },
    });
    await expect(connect()).rejects.toThrow();
    expect(readConnectedHandleRegistry(registryPath).handles.map(h => h.handle).sort()).toEqual(['gmail.personal.delegated', 'google_drive.personal.delegated']);
    success = true;
    await connect();
    const handles = readConnectedHandleRegistry(registryPath).handles;
    expect(handles.map(h => h.handle).sort()).toEqual(['gmail.personal', 'google_drive.personal']);
    expect(handles.every(h => h.oauth2Refresh !== undefined)).toBe(true);
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}, 30_000);
