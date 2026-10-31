import { expect, test } from 'bun:test';
import { checkGoogleOwnApp, parseGoogleDesktopClient } from '../src/core/google-own-app.ts';

const id = '123-example.apps.googleusercontent.com';
const secret = 'fixture-secret-never-echo';
const json = JSON.stringify({ installed: { client_id: id, client_secret: secret, redirect_uris: ['http://localhost'], token_uri: 'https://evil.example/token' } });

test('only a downloaded Desktop client is accepted; provider URLs from the file are never used', () => {
  expect(parseGoogleDesktopClient(json)).toEqual({ clientId: id, clientSecret: secret });
  for (const bad of ['broken ' + secret, JSON.stringify({ web: { client_id: id, client_secret: secret } }), '{}']) {
    expect(() => parseGoogleDesktopClient(bad)).toThrow('Desktop');
    try { parseGoogleDesktopClient(bad); } catch (error) { expect(String(error)).not.toContain(secret); }
  }
});

test('pre-sign-in check sends credentials only to Google and accepts only the expected invalid test grant', async () => {
  const calls: string[] = [];
  await checkGoogleOwnApp({ clientId: id, clientSecret: secret }, async (url, init) => {
    calls.push(String(url));
    expect(init?.redirect).toBe('error');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('client_secret')).toBe(secret);
    expect(body.get('grant_type')).toBe('refresh_token');
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  });
  expect(calls).toEqual(['https://oauth2.googleapis.com/token']);
});

test('rejected, offline, unexpected and oversized preflight responses fail without echoing credentials', async () => {
  for (const response of [
    () => Response.json({ error: 'invalid_client', error_description: secret }, { status: 401 }),
    () => Response.json({ error: 'invalid_grant', error_description: secret }, { status: 500 }),
    () => Response.json({ access_token: secret }),
    () => new Response(secret.repeat(10000), { status: 400 }),
  ]) {
    await expect(checkGoogleOwnApp({ clientId: id, clientSecret: secret }, async () => response())).rejects.toThrow();
    try { await checkGoogleOwnApp({ clientId: id, clientSecret: secret }, async () => response()); } catch (error) { expect(String(error)).not.toContain(secret); }
  }
  await expect(checkGoogleOwnApp({ clientId: id, clientSecret: secret }, async () => { throw new Error(secret); })).rejects.toThrow('could not be reached');
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { createSovereigntyEngine, buildEnvBridgeSovereigntyConfig } from '../src/core/sovereignty.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';

for (const accepted of [false, true]) test(`Google file route checks before sign-in and stores only accepted keys: ${accepted}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'google-own-app-'));
  const values = new Map<string, string>();
  let starts = 0;
  const worker = createEmailSourceWorker({
    sourceIndexStatus: { async status() { return { kind: 'source_index_status', generated_at: new Date().toISOString(), corpora: [], policy: { read_only: true, raw_source_exposed: false, source_packets_exposed: false, source_text_returned: false, secure_local_item_metadata_exposed: false, castor_visible: true } } as SourceIndexStatusResult; } },
    sourceDashboard: {
      registryPath: join(dir, 'handles.json'),
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      secretStore: { label: 'test', async get(k) { return values.get(k); }, async set(k, v) { values.set(k, v); }, async delete(k) { values.delete(k); }, async list() { return [...values.keys()]; } },
      oauthFetch: async () => Response.json({ error: accepted ? 'invalid_grant' : 'invalid_client', error_description: secret }, { status: accepted ? 400 : 401 }),
      startExternalOAuthConnection: async options => {
        starts++;
        expect(options.clientSecret).toBe(secret);
        expect(options.redirectUri).toBe(`http://127.0.0.1:8010/oauth/callback/${options.source}`);
        return { source: 'gmail', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), async finish() { throw new Error('unused'); } } as never;
      },
    },
  });
  try {
    const response = await withWorkerBearerAuth(worker.fetch, { authToken: 'fixture' })(new Request('https://dashboard.example/dashboard/connect/oauth/start', {
      method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'gmail', google_desktop: true, google_client_json: json }),
    }));
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(response.status).toBe(accepted ? 200 : 400);
    expect(starts).toBe(accepted ? 1 : 0);
    expect(values.get('google.own_app.registration')).toBe(accepted ? JSON.stringify({ clientId: id, clientSecret: secret }) : undefined);
    expect(values.get('gmail.personal.oauth.client_id')).toBeUndefined();
    if (accepted) {
      const drive = await withWorkerBearerAuth(worker.fetch, { authToken: 'fixture' })(new Request('https://dashboard.example/dashboard/connect/oauth/start', { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'google-drive', google_desktop: true }) }));
      expect(drive.status).toBe(200);
      expect(await drive.text()).not.toContain(secret);
      expect(starts).toBe(2);
    }
    if (!accepted) expect(values.size).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { checkGoogleOwnAppAccess } from '../src/core/google-own-app.ts';

test('authorized Google check names API step and rejects unavailable or malformed access', async () => {
  for (const source of ['gmail', 'google-drive'] as const) {
    await expect(checkGoogleOwnAppAccess(source, 'fixture-access', async () => Response.json({ error: secret }, { status: 403 }))).rejects.toThrow('turn on Gmail and Drive');
    await expect(checkGoogleOwnAppAccess(source, 'fixture-access', async () => Response.json({}))).rejects.toThrow('could not confirm');
    await checkGoogleOwnAppAccess(source, 'fixture-access', async (url) => {
      expect(String(url)).toBe(source === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile' : 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)');
      return Response.json(source === 'gmail' ? { emailAddress: 'fixture@example.test' } : { user: { permissionId: '123' } });
    });
  }
});
