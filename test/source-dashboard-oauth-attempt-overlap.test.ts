// The OAuth callback handler captures its attempt before awaiting the provider
// token exchange, which can take seconds. A second Connect press during that
// window replaces the map entry for the same source; deleting by key afterwards
// erased the newer attempt and bounced a valid callback with the 410 "attempt
// expired" page. The delete must be a compare-and-delete against the attempt the
// handler actually captured.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import type { OAuthFetch } from '../src/core/connect.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dashboard OAuth attempt overlap', () => {
  test('a connect started during an in-flight callback survives that callback finishing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-oauth-overlap-'));
    dirs.push(dir);
    const registryPath = join(dir, 'handles.json');
    const secretStore = memorySecretStore({
      'dropbox.personal.oauth.client_id': 'dropbox-client-id-fixture',
    });
    const firstExchangeEntered = deferred();
    const releaseFirstExchange = deferred();
    let exchanges = 0;
    const oauthFetch: OAuthFetch = async (_url, init) => {
      exchanges += 1;
      if (exchanges === 1) {
        firstExchangeEntered.resolve();
        await releaseFirstExchange.promise;
      }
      const code = new URLSearchParams(String(init?.body ?? '')).get('code') ?? 'unknown';
      return new Response(JSON.stringify({
        access_token: `dropbox-access-token-${code}`,
        refresh_token: `dropbox-refresh-token-${code}`,
        expires_in: 3600,
        token_type: 'bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath,
        secretStore,
        oauthFetch,
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });
    const startConnect = async (): Promise<string> => {
      const response = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer dashboard-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'dropbox',
          return_to: 'http://worker.test/dashboard?token=dashboard-return-token',
        }),
      }));
      expect(response.status).toBe(200);
      const payload = await response.json();
      return new URL(payload.authorization_url).searchParams.get('state')!;
    };

    const firstState = await startConnect();
    const firstCallback = fetch(new Request(
      `http://worker.test/oauth/callback/dropbox?code=dropbox-code-1&state=${firstState}`,
    ));
    await firstExchangeEntered.promise;
    const secondStart = startConnect();
    releaseFirstExchange.resolve();
    // A successful callback now redirects (303) to a query-free done page
    // rather than rendering "Connected" directly at the code/state-bearing URL
    // (MINOR 2, Codex round 2 on 7863a735); the exchange itself is what this
    // test cares about, so the redirect status is the completion signal.
    expect((await firstCallback).status).toBe(303);
    const secondState = await secondStart;

    const secondCallback = await fetch(new Request(
      `http://worker.test/oauth/callback/dropbox?code=dropbox-code-2&state=${secondState}`,
    ));

    expect(secondCallback.status).toBe(303);
    expect(await secretStore.get('dropbox.personal.oauth.refresh_token'))
      .toBe('dropbox-refresh-token-dropbox-code-2');
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

function memorySecretStore(initial: Record<string, string> = {}): SecretStore {
  const secrets = new Map(Object.entries(initial));
  return {
    label: 'memory',
    async get(key) {
      return secrets.get(key);
    },
    getSync(key) {
      return secrets.get(key);
    },
    async set(key, value) {
      secrets.set(key, value);
    },
    async delete(key) {
      secrets.delete(key);
    },
    async list() {
      return [...secrets.keys()].sort();
    },
  };
}
