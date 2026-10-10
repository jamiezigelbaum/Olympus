// Connect records which provider account a Dropbox grant belongs to, and a
// reconnect to a different account over a bound source requires a purge
// before that source syncs again (2026-10-10 reviewer-demo incident).

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOAuthSource } from '../src/core/connect.ts';
import { EncryptedFileSecretStore } from '../src/core/secret-store.ts';
import {
  readSourceAccountBindings,
  sourceAccountBindingsPath,
  updateSourceAccountBinding,
} from '../src/core/source-account-binding.ts';
import { readConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import { JsonCredentialOAuth2StateStore } from '../src/workers/credential-broker/index.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function dropboxServer(account: { tokenAccountId?: string; lookupAccountId?: string }) {
  const authorizeScopes: string[] = [];
  const lookups: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      authorizeScopes.push(url.searchParams.get('scope') ?? '');
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      response.writeHead(302, { Location: `${redirectUri}?code=code-fixture&state=${state}` }).end();
      return;
    }
    if (url.pathname === '/oauth2/token') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        access_token: 'dropbox-access-token-fixture',
        refresh_token: 'dropbox-refresh-token-fixture',
        expires_in: 14_400,
        ...(account.tokenAccountId ? { account_id: account.tokenAccountId } : {}),
      }));
      return;
    }
    if (url.pathname === '/2/users/get_current_account' && request.method === 'POST') {
      lookups.push(String(request.headers.authorization));
      if (!account.lookupAccountId) {
        response.writeHead(401).end('{}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ account_id: account.lookupAccountId }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, authorizeScopes, lookups, close: () => server.close() };
}

function installDir() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-account-binding-'));
  dirs.push(dir);
  return {
    registryPath: join(dir, 'handles.json'),
    statePath: join(dir, 'oauth-state.json'),
    secretStore: new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    }),
  };
}

async function connectDropbox(install: ReturnType<typeof installDir>, baseUrl: string) {
  return connectOAuthSource({
    source: 'dropbox',
    clientId: 'dropbox-client-id-fixture',
    authUrl: `${baseUrl}/authorize`,
    tokenUrl: `${baseUrl}/oauth2/token`,
    registryPath: install.registryPath,
    oauth2StateStore: new JsonCredentialOAuth2StateStore(install.statePath),
    secretStore: install.secretStore,
    openBrowser: false,
    onAuthorizationUrl: async (url) => {
      const authResponse = await fetch(url, { redirect: 'manual' });
      const location = authResponse.headers.get('location');
      if (!location) throw new Error('mock authorization did not redirect');
      await fetch(location);
    },
  });
}

describe('Dropbox connect records the account its grant belongs to', () => {
  test('from the token response, with account_info.read requested', async () => {
    const install = installDir();
    const server = await dropboxServer({ tokenAccountId: 'dbid:main-account' });
    try {
      const result = await connectDropbox(install, server.baseUrl);
      expect(result.sourceAccountPurgeRequired).toBeUndefined();
      expect(server.authorizeScopes[0]?.split(' ')).toContain('account_info.read');
      expect(server.lookups).toEqual([]);
      expect(readConnectedHandleRegistry(install.registryPath).handles[0]?.providerAccountId).toBe('dbid:main-account');
      expect((await new JsonCredentialOAuth2StateStore(install.statePath).load('dropbox.personal'))?.providerAccountId)
        .toBe('dbid:main-account');
    } finally {
      server.close();
    }
  });

  test('from the account lookup when the token response does not name it', async () => {
    const install = installDir();
    const server = await dropboxServer({ lookupAccountId: 'dbid:main-account' });
    try {
      await connectDropbox(install, server.baseUrl);
      expect(server.lookups).toEqual(['Bearer dropbox-access-token-fixture']);
      expect(readConnectedHandleRegistry(install.registryPath).handles[0]?.providerAccountId).toBe('dbid:main-account');
    } finally {
      server.close();
    }
  });

  test('an unanswered lookup still connects, leaving the worker to settle the account', async () => {
    const install = installDir();
    const server = await dropboxServer({});
    try {
      const result = await connectDropbox(install, server.baseUrl);
      expect(result.handles).toEqual(['dropbox.personal']);
      expect(readConnectedHandleRegistry(install.registryPath).handles[0]?.providerAccountId).toBeUndefined();
      const read = readSourceAccountBindings(sourceAccountBindingsPath(install.registryPath));
      expect(read.kind === 'ok' && read.bindings.sources['dropbox.files']?.reconnected_at).toBeTruthy();
    } finally {
      server.close();
    }
  });

  test('reconnecting a bound source with a different account requires a purge', async () => {
    const install = installDir();
    const first = await dropboxServer({ tokenAccountId: 'dbid:main-account' });
    try {
      await connectDropbox(install, first.baseUrl);
    } finally {
      first.close();
    }
    // The worker bound the source to the account its items came from.
    updateSourceAccountBinding(sourceAccountBindingsPath(install.registryPath), 'dropbox.files', () => ({
      provider_account_id: 'dbid:main-account',
      bound_at: '2026-10-10T22:41:30.000Z',
    }));

    const second = await dropboxServer({ tokenAccountId: 'dbid:demo-account' });
    try {
      const result = await connectDropbox(install, second.baseUrl);
      expect(result.sourceAccountPurgeRequired).toEqual(['dropbox.files']);
      expect(readConnectedHandleRegistry(install.registryPath).handles[0]?.providerAccountId).toBe('dbid:demo-account');
      const read = readSourceAccountBindings(sourceAccountBindingsPath(install.registryPath));
      expect(read.kind === 'ok' && read.bindings.sources['dropbox.files']).toMatchObject({
        provider_account_id: 'dbid:main-account',
        purge_required: { reason: 'account_changed' },
      });
    } finally {
      second.close();
    }
  });

  test('reconnecting a bound source with the same account needs nothing', async () => {
    const install = installDir();
    updateSourceAccountBinding(sourceAccountBindingsPath(install.registryPath), 'dropbox.files', () => ({
      provider_account_id: 'dbid:main-account',
    }));
    const server = await dropboxServer({ tokenAccountId: 'dbid:main-account' });
    try {
      const result = await connectDropbox(install, server.baseUrl);
      expect(result.sourceAccountPurgeRequired).toBeUndefined();
      const read = readSourceAccountBindings(sourceAccountBindingsPath(install.registryPath));
      expect(read.kind === 'ok' && read.bindings.sources['dropbox.files']).toEqual({ provider_account_id: 'dbid:main-account' });
    } finally {
      server.close();
    }
  });
});
