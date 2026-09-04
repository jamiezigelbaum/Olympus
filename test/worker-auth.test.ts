import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { configFromPluginConfig, defaultConfig } from '../src/core/config.ts';
import { DirectHttpCastorWorkspaceTransport } from '../src/core/castor-workspace.ts';
import {
  createDomainExpertTransport,
  DirectHttpDomainExpertTransport,
  domainExpertAuthTokenFromConfig,
} from '../src/core/domain-expert-client.ts';
import { DirectHttpEmailTransport } from '../src/core/email.ts';
import { DirectHttpFileDeliveryTransport } from '../src/core/file-delivery.ts';
import {
  applyWorkerSetupEnv,
  dashboardQueryTokenFromWorkerAuthToken,
  unquoteEnvValue,
  workerAuthTokenFromConfig,
} from '../src/core/worker-auth.ts';
import { createCastorWorkspaceWorker } from '../src/workers/castor-workspace/index.ts';
import { resolveCastorWorkspaceBindHostFromEnv } from '../src/workers/castor-workspace/server.ts';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';
import { resolveDomainExpertBindHostFromEnv } from '../src/workers/domain-expert/server.ts';
import {
  createEmailSourceWorker,
  type EmailSourceConnector,
  type EmailSourceHealth,
} from '../src/workers/email-source/index.ts';
import { resolveEmailSourceBindHostFromEnv } from '../src/workers/email-source/server.ts';
import { createFileDeliveryWorker, type FileDeliveryRootPolicy } from '../src/workers/file-delivery/index.ts';
import { resolveFileDeliveryBindHostFromEnv } from '../src/workers/file-delivery/server.ts';
import {
  DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER,
  warnIfWorkerAuthDisabled,
  withWorkerBearerAuth,
  workerAuthTokenFromEnv,
} from '../src/workers/http.ts';

describe('worker HTTP bind and auth', () => {
  test('every worker server binds loopback by default and honors the shared override', () => {
    const resolvers = [
      resolveEmailSourceBindHostFromEnv,
      resolveFileDeliveryBindHostFromEnv,
      resolveCastorWorkspaceBindHostFromEnv,
      resolveDomainExpertBindHostFromEnv,
    ];

    for (const resolve of resolvers) {
      expect(resolve({})).toBe('127.0.0.1');
      expect(resolve({ OLYMPUS_WORKER_BIND_HOST: '100.64.0.12' })).toBe('100.64.0.12');
    }
  });

  test('bearer auth protects every worker route except GET /v1/health', async () => {
    const cases = workerCases();
    try {
      for (const worker of cases) {
        const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'shared-secret' });

        const health = await fetch(new Request('http://worker.test/v1/health'));
        expect(health.status, `${worker.name} health`).toBe(200);

        const deepHealth = await fetch(new Request('http://worker.test/v1/health?deep=1'));
        expect(deepHealth.status, `${worker.name} unauthenticated deep health`).toBe(401);

        const authorizedDeepHealth = await fetch(new Request('http://worker.test/v1/health?deep=1', {
          headers: { Authorization: 'Bearer shared-secret' },
        }));
        expect(authorizedDeepHealth.status, `${worker.name} authenticated deep health`).toBe(200);

        const missing = await fetch(worker.request());
        expect(missing.status, `${worker.name} missing token`).toBe(401);
        await expect(missing.json()).resolves.toMatchObject({
          error: {
            code: 'unauthorized',
            status: 401,
            message: 'Worker bearer token does not match this worker. Do not paste the dash_ URL token here.',
          },
          policy: { counts_only: true, raw_source_exposed: false },
        });

        const wrong = await fetch(worker.request('wrong-secret'));
        expect(wrong.status, `${worker.name} wrong token`).toBe(401);

        const allowed = await fetch(worker.request('shared-secret'));
        expect(allowed.status, `${worker.name} correct token`).toBe(200);
      }
    } finally {
      for (const worker of cases) worker.cleanup?.();
    }
  });

  test('missing worker auth token fails closed except GET /v1/health', async () => {
    const cases = workerCases();
    try {
      for (const worker of cases) {
        const fetch = withWorkerBearerAuth(worker.fetch, { authToken: undefined });

        const health = await fetch(new Request('http://worker.test/v1/health'));
        expect(health.status, `${worker.name} health`).toBe(200);

        const deepHealth = await fetch(new Request('http://worker.test/v1/health?deep=1'));
        expect(deepHealth.status, `${worker.name} unauthenticated deep health`).toBe(503);

        const route = await fetch(worker.request('any-token'));
        expect(route.status, `${worker.name} route with unconfigured auth`).toBe(503);
        await expect(route.json()).resolves.toMatchObject({
          error: { code: 'worker_auth_required', status: 503 },
          policy: { counts_only: true, raw_source_exposed: false },
        });
      }
    } finally {
      for (const worker of cases) worker.cleanup?.();
    }
  });

  test('dashboard controls use an origin-bound short-lived session with CSRF', async () => {
    let now = Date.parse('2026-08-30T12:00:00.000Z');
    const seen: Request[] = [];
    const fetch = withWorkerBearerAuth(async (request) => {
      seen.push(request);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }, { authToken: 'worker-secret', now: () => now });

    const mint = await fetch(new Request('http://127.0.0.1:17777/dashboard/control/session', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer worker-secret',
        Origin: 'http://127.0.0.1:17777',
      },
    }));
    expect(mint.status).toBe(200);
    expect(seen).toHaveLength(0);
    // Thirty days: once the dashboard is set up, the token is not asked for
    // again on this browser (owner ruling, 2026-09-02).
    expect(mint.headers.get('Set-Cookie')).toContain('HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=2592000');
    const cookie = mint.headers.get('Set-Cookie')!.split(';')[0]!;
    const payload = await mint.json() as { csrf_token: string; policy: Record<string, boolean> };
    expect(payload.csrf_token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(payload.policy).toMatchObject({
      bearer_token_persisted_in_browser_storage: false,
      http_only_cookie: true,
      csrf_required: true,
      origin_bound: true,
    });

    const dashboardToken = dashboardQueryTokenFromWorkerAuthToken('worker-secret')!;
    const controlledDashboard = await fetch(new Request(
      `http://127.0.0.1:17777/dashboard?token=${dashboardToken}`,
      { headers: { Cookie: cookie, Referer: 'http://127.0.0.1:17777/dashboard' } },
    ));
    expect(controlledDashboard.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER)).toBe(payload.csrf_token);
    seen.length = 0;

    const directRead = await fetch(new Request('http://127.0.0.1:17777/dashboard/dispositions'));
    expect(directRead.status).toBe(401);

    const wrongReadOrigin = await fetch(new Request('http://127.0.0.1:17777/dashboard/dispositions', {
      headers: { Cookie: cookie, Referer: 'http://attacker.test/dashboard' },
    }));
    expect(wrongReadOrigin.status).toBe(403);

    const allowedRead = await fetch(new Request('http://127.0.0.1:17777/dashboard/dispositions', {
      headers: { Cookie: cookie, Referer: 'http://127.0.0.1:17777/dashboard?source=dropbox.files' },
    }));
    expect(allowedRead.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER)).toBe(payload.csrf_token);

    const missingCsrf = await fetch(new Request('http://127.0.0.1:17777/dashboard/sync-now', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://127.0.0.1:17777' },
    }));
    expect(missingCsrf.status).toBe(403);
    expect(seen).toHaveLength(1);

    const wrongOrigin = await fetch(new Request('http://127.0.0.1:17777/dashboard/sync-now', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://attacker.test',
        'X-Olympus-CSRF': payload.csrf_token,
      },
    }));
    expect(wrongOrigin.status).toBe(403);
    expect(seen).toHaveLength(1);

    const allowed = await fetch(new Request('http://127.0.0.1:17777/dashboard/sync-now', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://127.0.0.1:17777',
        'X-Olympus-CSRF': payload.csrf_token,
      },
    }));
    expect(allowed.status).toBe(200);
    expect(seen).toHaveLength(2);

    now += 30 * 24 * 60 * 60_000 + 1_000;
    const expired = await fetch(new Request('http://127.0.0.1:17777/dashboard/sync-now', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://127.0.0.1:17777',
        'X-Olympus-CSRF': payload.csrf_token,
      },
    }));
    expect(expired.status).toBe(401);
    expect(seen).toHaveLength(2);
  });

  test('a control session has a fixed thirty-day life, survives a worker restart, and can be locked', async () => {
    const DAY = 24 * 60 * 60_000;
    const mintedAt = Date.parse('2026-08-30T12:00:00.000Z');
    let now = mintedAt;
    const seen: Request[] = [];
    const origin = 'http://127.0.0.1:17777';
    const handler = async (request: Request) => {
      seen.push(request);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const fetch = withWorkerBearerAuth(handler, { authToken: 'worker-secret', now: () => now });

    const mint = await fetch(new Request(`${origin}/dashboard/control/session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret', Origin: origin },
    }));
    const cookie = mint.headers.get('Set-Cookie')!.split(';')[0]!;
    const csrfToken = (await mint.json() as { csrf_token: string }).csrf_token;
    const control = (withCookie = cookie) => new Request(`${origin}/dashboard/sync-now`, {
      method: 'POST',
      headers: { Cookie: withCookie, Origin: origin, 'X-Olympus-CSRF': csrfToken },
    });

    // Never re-issued: use hands back the SAME cookie with its remaining life,
    // so no copy of it can be kept alive past the day it was minted for.
    now = mintedAt + 10 * DAY;
    const used = await fetch(control());
    expect(used.status).toBe(200);
    expect(used.headers.get('Set-Cookie')).toBe(
      `${cookie}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=${20 * 24 * 60 * 60}`,
    );

    // Nothing is stored on the worker: a fresh handler with the same token
    // accepts the cookie, so a restart does not log the browser out.
    const restarted = withWorkerBearerAuth(handler, { authToken: 'worker-secret', now: () => now });
    expect((await restarted(control())).status).toBe(200);

    // The picker keepalive proves custody without the bearer and changes nothing.
    const keepalive = await fetch(new Request(`${origin}/dashboard/control/session`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'X-Olympus-CSRF': csrfToken },
    }));
    expect(keepalive.status).toBe(200);
    await expect(keepalive.json()).resolves.toMatchObject({ ok: true, csrf_token: csrfToken });
    expect(keepalive.headers.get('Set-Cookie')!.split(';')[0]).toBe(cookie);
    const keepaliveWithoutCsrf = await fetch(new Request(`${origin}/dashboard/control/session`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
    }));
    expect(keepaliveWithoutCsrf.status).toBe(403);

    // Thirty days from the paste ends it, however recently it was used.
    now = mintedAt + 30 * DAY + 1_000;
    expect((await fetch(control())).status).toBe(401);

    // A tampered signature fails closed.
    now = mintedAt + 1 * DAY;
    const flipped = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
    expect((await fetch(control(flipped))).status).toBe(401);

    // A validly signed cookie dated in the future is refused past five
    // minutes of skew: minted on a fast clock, verified on the real one.
    const mintOn = async (clockMs: number) => {
      const ahead = withWorkerBearerAuth(handler, { authToken: 'worker-secret', now: () => clockMs });
      const minted = await ahead(new Request(`${origin}/dashboard/control/session`, {
        method: 'POST',
        headers: { Authorization: 'Bearer worker-secret', Origin: origin },
      }));
      return {
        cookie: minted.headers.get('Set-Cookie')!.split(';')[0]!,
        csrf: (await minted.json() as { csrf_token: string }).csrf_token,
      };
    };
    const skewControl = (minted: { cookie: string; csrf: string }) => new Request(`${origin}/dashboard/sync-now`, {
      method: 'POST',
      headers: { Cookie: minted.cookie, Origin: origin, 'X-Olympus-CSRF': minted.csrf },
    });
    expect((await fetch(skewControl(await mintOn(now + 4 * 60_000)))).status).toBe(200);
    expect((await fetch(skewControl(await mintOn(now + 6 * 60_000)))).status).toBe(401);

    // Rotating the worker token revokes every session at once.
    const rotatedToken = withWorkerBearerAuth(handler, { authToken: 'worker-secret-2', now: () => now });
    expect((await rotatedToken(control())).status).toBe(401);

    // Lock clears this browser's cookie; it takes the same custody proof as
    // any control, so a cross-origin or CSRF-less lock is refused.
    const lockWithoutCsrf = await fetch(new Request(`${origin}/dashboard/control/session/lock`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
    }));
    expect(lockWithoutCsrf.status).toBe(403);
    const lockCrossOrigin = await fetch(new Request(`${origin}/dashboard/control/session/lock`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://attacker.test', 'X-Olympus-CSRF': csrfToken },
    }));
    expect(lockCrossOrigin.status).toBe(403);
    // No cookie at all is no session: the route must not be an anonymous
    // logout endpoint, whatever origin it is called from.
    expect((await fetch(new Request(`${origin}/dashboard/control/session/lock`, { method: 'POST' }))).status).toBe(401);
    expect((await fetch(new Request(`${origin}/dashboard/control/session/lock`, {
      method: 'POST',
      headers: { Origin: 'http://attacker.test' },
    }))).status).toBe(401);
    expect((await fetch(new Request(`${origin}/dashboard/control/session/lock`, {
      method: 'POST',
      headers: { Cookie: flipped, Origin: origin, 'X-Olympus-CSRF': csrfToken },
    }))).status).toBe(401);
    const locked = await fetch(new Request(`${origin}/dashboard/control/session/lock`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'X-Olympus-CSRF': csrfToken },
    }));
    expect(locked.status).toBe(200);
    expect(locked.headers.get('Set-Cookie')).toBe('olympus_dashboard_control=; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=0');
    // Two uses of the real cookie plus the one accepted four-minute-skew mint.
    expect(seen.filter((request) => new URL(request.url).pathname === '/dashboard/sync-now')).toHaveLength(3);
  });

  // The OAuth "done" tab's link back is a token-less top-level navigation from
  // a page served with Referrer-Policy: no-referrer, so it arrives naming no
  // origin at all. It used to land on a raw 401 JSON body (owner, 2026-09-04).
  test('an unlocked browser may navigate to the dashboard page with no token and no stated origin', async () => {
    const origin = 'http://127.0.0.1:17777';
    const seen: Request[] = [];
    const fetch = withWorkerBearerAuth(async (request) => {
      seen.push(request);
      return new Response('<!doctype html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }, { authToken: 'worker-secret' });

    const mint = await fetch(new Request(`${origin}/dashboard/control/session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret', Origin: origin },
    }));
    const cookie = mint.headers.get('Set-Cookie')!.split(';')[0]!;
    const csrfToken = (await mint.json() as { csrf_token: string }).csrf_token;

    const navigated = await fetch(new Request(`${origin}/dashboard`, { headers: { Cookie: cookie } }));
    expect(navigated.status).toBe(200);
    expect(navigated.headers.get('Content-Type')).toContain('text/html');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER)).toBe(csrfToken);

    // No cookie is still no dashboard.
    expect((await fetch(new Request(`${origin}/dashboard`))).status).toBe(401);

    // The data endpoint keeps both of its proofs: the cookie alone does not
    // open it, with or without a stated origin.
    expect((await fetch(new Request(`${origin}/dashboard.json`, { headers: { Cookie: cookie } }))).status).toBe(401);
    expect((await fetch(new Request(`${origin}/dashboard.json`, {
      headers: { Cookie: cookie, Referer: `${origin}/dashboard` },
    }))).status).toBe(401);
    expect((await fetch(new Request(`${origin}/dashboard.json`))).status).toBe(401);

    // Unstated is not the same as foreign: a session minted against another
    // worker origin, and a navigation that states an attacker origin, are both
    // still refused.
    expect((await fetch(new Request('http://127.0.0.1:19999/dashboard', {
      headers: { Cookie: cookie },
    }))).status).toBe(403);
    expect((await fetch(new Request(`${origin}/dashboard`, {
      headers: { Cookie: cookie, Referer: 'http://attacker.test/' },
    }))).status).toBe(403);

    // The relaxation is confined to the read: a control POST still needs the
    // origin stated and the CSRF token presented.
    expect((await fetch(new Request(`${origin}/dashboard/sync-now`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-Olympus-CSRF': csrfToken },
    }))).status).toBe(403);

    expect(seen).toHaveLength(1);
  });

  test('control-session mint refuses missing bearer and cross-origin requests', async () => {
    const fetch = withWorkerBearerAuth(async () => new Response('unreachable'), {
      authToken: 'worker-secret',
    });
    const missingBearer = await fetch(new Request('http://worker.test/dashboard/control/session', {
      method: 'POST',
      headers: { Origin: 'http://worker.test' },
    }));
    expect(missingBearer.status).toBe(401);

    const crossOrigin = await fetch(new Request('http://worker.test/dashboard/control/session', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer worker-secret',
        Origin: 'http://attacker.test',
      },
    }));
    expect(crossOrigin.status).toBe(403);
  });

  test('placeholder worker auth tokens fail closed in live worker wrappers', async () => {
    expect(workerAuthTokenFromEnv({ OLYMPUS_WORKER_AUTH_TOKEN: 'replace-with-generated-token' })).toBeUndefined();
    expect(workerAuthTokenFromEnv({ OLYMPUS_WORKER_AUTH_TOKEN: ' change-me ' })).toBeUndefined();
    expect(workerAuthTokenFromEnv({ OLYMPUS_WORKER_AUTH_TOKEN: 'real-worker-token' })).toBe('real-worker-token');

    expect(() => warnIfWorkerAuthDisabled(
      'test worker',
      workerAuthTokenFromEnv({ OLYMPUS_WORKER_AUTH_TOKEN: 'replace-with-generated-token' }),
      '0.0.0.0',
    )).toThrow('cannot bind to 0.0.0.0 without OLYMPUS_WORKER_AUTH_TOKEN');

    const handler = withWorkerBearerAuth(async () => new Response('ok'), {
      authToken: 'replace-with-generated-token',
    });
    const placeholderBearer = await handler(new Request('http://worker.test/v1/source/answer', {
      method: 'POST',
      headers: { Authorization: 'Bearer replace-with-generated-token' },
    }));
    expect(placeholderBearer.status).toBe(503);
    await expect(placeholderBearer.json()).resolves.toMatchObject({
      error: { code: 'worker_auth_required', status: 503 },
    });

    const health = await handler(new Request('http://worker.test/v1/health'));
    expect(health.status).toBe(200);
  });

  test('worker clients attach the shared bearer token without logging or serializing it into bodies', async () => {
    const config = defaultConfig();
    config.worker.authToken = 'client-secret';
    const captured: Request[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      captured.push(new Request(url, init));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const token = workerAuthTokenFromConfig(config);

    await new DirectHttpEmailTransport(fetchImpl, token).requestJson('http://email.test/v1/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'hello' }),
    });
    await new DirectHttpFileDeliveryTransport(fetchImpl, token).requestJson('http://file.test/v1/file/deliver', {
      method: 'POST',
      body: '{}',
    });
    await new DirectHttpCastorWorkspaceTransport(fetchImpl, token).requestJson('http://workspace.test/v1/workspace', {
      method: 'POST',
      body: '{}',
    });
    await new DirectHttpDomainExpertTransport(fetchImpl, token).requestJson('http://domain.test/v1/domain', {
      method: 'POST',
      body: '{}',
    });

    expect(captured).toHaveLength(4);
    for (const request of captured) {
      expect(request.headers.get('Authorization')).toBe('Bearer client-secret');
      expect(await request.text()).not.toContain('client-secret');
    }
  });

  test('worker auth resolves the setup-created owner-only token file', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-worker-auth-env-'));
    const envPath = join(home, '.config', 'olympus', 'worker.env');
    try {
      mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
      writeFileSync(envPath, 'OLYMPUS_WORKER_AUTH_TOKEN=first-run-token\n', { mode: 0o600 });
      chmodSync(envPath, 0o600);

      const config = defaultConfig();
      expect(workerAuthTokenFromConfig(config, { env: { HOME: home } })).toBe('first-run-token');

      config.worker.authToken = 'config-token';
      expect(workerAuthTokenFromConfig(config, {
        env: {
          HOME: home,
          OLYMPUS_WORKER_AUTH_TOKEN: 'env-token',
        },
      })).toBe('config-token');
      delete config.worker.authToken;
      expect(workerAuthTokenFromConfig(config, {
        env: {
          HOME: home,
          OLYMPUS_WORKER_AUTH_TOKEN: 'env-token',
        },
      })).toBe('env-token');

      chmodSync(envPath, 0o644);
      expect(workerAuthTokenFromConfig(config, { env: { HOME: home } })).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('foreground worker startup can load owner-only worker.env without overriding explicit env', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-worker-run-env-'));
    const envPath = join(home, '.config', 'olympus', 'worker.env');
    try {
      mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
      writeFileSync(envPath, [
        '# Olympus source worker environment.',
        'OLYMPUS_EMAIL_SOURCE_PORT=9876',
        'OLYMPUS_WORKER_SCHEDULER_ENABLED=true',
        'OLYMPUS_WORKER_AUTH_TOKEN=first-run-token',
        'VENICE_API_KEY="venice-worker-key"',
        '',
      ].join('\n'), { mode: 0o600 });
      chmodSync(envPath, 0o600);

      const env: Record<string, string | undefined> = {
        HOME: home,
        OLYMPUS_EMAIL_SOURCE_PORT: 'already-set',
      };
      const result = applyWorkerSetupEnv({ env });

      expect(result).toMatchObject({
        loaded: true,
        path: envPath,
      });
      expect(result.keys.sort()).toEqual([
        'OLYMPUS_WORKER_AUTH_TOKEN',
        'OLYMPUS_WORKER_SCHEDULER_ENABLED',
        'VENICE_API_KEY',
      ].sort());
      expect(env.OLYMPUS_EMAIL_SOURCE_PORT).toBe('already-set');
      expect(env.OLYMPUS_WORKER_SCHEDULER_ENABLED).toBe('true');
      expect(env.OLYMPUS_WORKER_AUTH_TOKEN).toBe('first-run-token');
      expect(env.VENICE_API_KEY).toBe('venice-worker-key');

      chmodSync(envPath, 0o644);
      const insecureEnv: Record<string, string | undefined> = { HOME: home };
      expect(applyWorkerSetupEnv({ env: insecureEnv })).toMatchObject({
        loaded: false,
        path: envPath,
        keys: [],
      });
      expect(insecureEnv.OLYMPUS_WORKER_AUTH_TOKEN).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('worker auth ignores placeholder tokens from config, env, and setup files', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-worker-auth-placeholder-'));
    const envPath = join(home, '.config', 'olympus', 'worker.env');
    try {
      mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
      writeFileSync(envPath, 'OLYMPUS_WORKER_AUTH_TOKEN=replace-with-generated-token\n', { mode: 0o600 });
      chmodSync(envPath, 0o600);

      const config = defaultConfig();
      config.worker.authToken = 'replace-with-generated-token';
      expect(workerAuthTokenFromConfig(config, {
        env: {
          HOME: home,
          OLYMPUS_WORKER_AUTH_TOKEN: 'change-me',
        },
      })).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('worker startup refuses unauthenticated non-loopback binds', () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      expect(() => warnIfWorkerAuthDisabled('test worker', undefined, '127.0.0.1')).not.toThrow();
      expect(() => warnIfWorkerAuthDisabled('test worker', undefined, 'localhost')).not.toThrow();
      expect(() => warnIfWorkerAuthDisabled('test worker', undefined, '::1')).not.toThrow();
      expect(() => warnIfWorkerAuthDisabled('test worker', undefined, '0.0.0.0')).toThrow(
        'cannot bind to 0.0.0.0 without OLYMPUS_WORKER_AUTH_TOKEN',
      );
      expect(() => warnIfWorkerAuthDisabled('test worker', undefined, '100.64.0.12')).toThrow(
        'cannot bind to 100.64.0.12 without OLYMPUS_WORKER_AUTH_TOKEN',
      );
      expect(() => warnIfWorkerAuthDisabled('test worker', 'token', '0.0.0.0')).not.toThrow();
      expect(warnings).toHaveLength(3);
      expect(warnings[0]).toContain('only the bare health endpoint is available on 127.0.0.1');
    } finally {
      console.warn = originalWarn;
    }
  });
});

function workerCases(): Array<{
  name: string;
  fetch: (request: Request) => Promise<Response>;
  request: (token?: string) => Request;
  cleanup?: () => void;
}> {
  const fileRoot = mkdtempSync(join(tmpdir(), 'olympus-worker-auth-file-'));
  const filePolicy: FileDeliveryRootPolicy = {
    rootId: 'safe',
    path: fileRoot,
    allowedTrustDomains: ['internal'],
    maxBytes: 1024,
    allowParentCreate: true,
    allowDotfiles: false,
    allowOverwrite: false,
  };
  const emailConnector = fakeEmailConnector();
  return [
    {
      name: 'email-source',
      fetch: createEmailSourceWorker({ connector: emailConnector }).fetch,
      request: (token) => new Request('http://worker.test/v1/health/dependencies', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
    },
    {
      name: 'file-delivery',
      fetch: createFileDeliveryWorker({ roots: [filePolicy] }).fetch,
      request: (token) => jsonRequest('http://worker.test/v1/file/deliver', {
        root_id: 'safe',
        relative_path: 'note.md',
        content: 'hello',
        write_mode: 'dry_run',
        trust_domain: 'internal',
        idempotency_key: 'auth-test',
      }, token),
      cleanup: () => rmSync(fileRoot, { recursive: true, force: true }),
    },
    {
      name: 'castor-workspace',
      fetch: createCastorWorkspaceWorker().fetch,
      request: (token) => jsonRequest('http://worker.test/v1/workspace', {
        action: 'health',
      }, token),
    },
    {
      name: 'domain-expert',
      fetch: createDomainExpertWorker({
        enabled: true,
        liveToolsEnabled: true,
      }).fetch,
      request: (token) => jsonRequest('http://worker.test/v1/domain', {
        tool: 'domain_agent',
        params: {
          action: 'bootstrap',
          domain_id: 'governance',
          dry_run: true,
        },
      }, token),
    },
  ];
}

function jsonRequest(url: string, body: unknown, token?: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function fakeEmailConnector(): EmailSourceConnector {
  const health = async (): Promise<EmailSourceHealth> => ({
    reachable: true,
    configured: true,
    connector: 'test',
    raw_email_exposed: false,
  });
  return {
    name: 'test',
    health,
  };
}


describe('dashboard query-token exception', () => {
  const handler = withWorkerBearerAuth(async () => new Response('ok'), { authToken: 'dash-secret' });

  test('GET /dashboard accepts a dashboard-only query token', async () => {
    const token = dashboardQueryTokenFromWorkerAuthToken('dash-secret');
    const response = await handler(new Request(`http://127.0.0.1:8010/dashboard?token=${token}`));
    expect(response.status).toBe(200);
    const json = await handler(new Request(`http://127.0.0.1:8010/dashboard.json?token=${token}`));
    expect(json.status).toBe(200);
  });

  test('GET /dashboard rejects wrong or full worker query tokens', async () => {
    const response = await handler(new Request('http://127.0.0.1:8010/dashboard?token=wrong'));
    expect(response.status).toBe(401);
    const bearer = await handler(new Request('http://127.0.0.1:8010/dashboard?token=dash-secret'));
    expect(bearer.status).toBe(401);
  });

  test('query token does not authorize any non-dashboard route', async () => {
    const token = dashboardQueryTokenFromWorkerAuthToken('dash-secret');
    const answer = await handler(new Request(`http://127.0.0.1:8010/v1/source/answer?token=${token}`, { method: 'POST' }));
    expect(answer.status).toBe(401);
    const status = await handler(new Request(`http://127.0.0.1:8010/v1/source/index/status?token=${token}`));
    expect(status.status).toBe(401);
    const connect = await handler(new Request(`http://127.0.0.1:8010/dashboard/connect/api-key?token=${token}`, { method: 'POST' }));
    expect(connect.status).toBe(401);
    const authCheck = await handler(new Request(`http://127.0.0.1:8010/dashboard/auth-check?token=${token}`));
    expect(authCheck.status).toBe(401);
  });

  test('OAuth callback route is allowed for provider redirects', async () => {
    const callback = await handler(new Request('http://127.0.0.1:8010/oauth/callback/dropbox?code=code&state=state'));
    expect(callback.status).toBe(200);
  });
});

describe('domain expert bearer scope', () => {
  const FLEET_TOKEN = 'fleet-wide-worker-bearer-token';
  const EXPERT_TOKEN = 'domain-expert-only-bearer-token';

  function pluginConfig(domainExpert: Record<string, unknown>): unknown {
    return {
      worker: { authToken: FLEET_TOKEN },
      domainExpert: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:8040/v1',
        ...domainExpert,
      },
    };
  }

  /** Drives the real transport against a stub fetch and returns the Authorization header it sent. */
  async function capturedAuthorization(pluginConfigValue: unknown): Promise<string | null> {
    const config = configFromPluginConfig(pluginConfigValue);
    const originalFetch = globalThis.fetch;
    let seen: string | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = new Headers(init.headers).get('Authorization');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    try {
      await createDomainExpertTransport(config).requestJson('http://127.0.0.1:8040/v1/domain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    return seen;
  }

  test('a configured domainExpert.authToken survives plugin config parsing', () => {
    // The parser copies domainExpert fields one by one, so an unhandled field is
    // dropped silently rather than rejected. This asserts the field is handled.
    expect(configFromPluginConfig(pluginConfig({ authToken: EXPERT_TOKEN })).domainExpert.authToken)
      .toBe(EXPERT_TOKEN);
  });

  test('the domain expert bearer is sent instead of the fleet-wide worker token', async () => {
    expect(await capturedAuthorization(pluginConfig({ authToken: EXPERT_TOKEN })))
      .toBe(`Bearer ${EXPERT_TOKEN}`);
  });

  test('the fleet-wide worker token is used when no domain expert bearer is configured', async () => {
    expect(await capturedAuthorization(pluginConfig({}))).toBe(`Bearer ${FLEET_TOKEN}`);
  });

  test('a placeholder domain expert bearer falls back rather than authenticating as the placeholder', async () => {
    expect(await capturedAuthorization(pluginConfig({ authToken: 'change-me' })))
      .toBe(`Bearer ${FLEET_TOKEN}`);
  });

  async function capturedBody(pluginConfigValue: unknown, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const config = configFromPluginConfig(pluginConfigValue);
    const originalFetch = globalThis.fetch;
    let seen: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = JSON.parse(String(init.body));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    try {
      const { DomainExpertClient } = await import('../src/core/domain-expert-client.ts');
      await new DomainExpertClient(config, createDomainExpertTransport(config))
        .run('domain_ask', params).catch(() => undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
    return (seen.params ?? {}) as Record<string, unknown>;
  }

  test('an omitted domain_id gains the configured default, an explicit one is never overridden', async () => {
    // The legacy worker forgave omission by defaulting to governance on the
    // serving path; the Expert-Agents worker refuses its own default domain.
    // The tenant default is this deployment's fact, injected client-side.
    const withDefault = pluginConfig({ defaultDomainId: 'governance' });
    expect(await capturedBody(withDefault, { question: 'q' }))
      .toMatchObject({ domain_id: 'governance' });
    expect(await capturedBody(withDefault, { question: 'q', domain_id: 'guru' }))
      .toMatchObject({ domain_id: 'guru' });
    expect((await capturedBody(pluginConfig({}), { question: 'q' })).domain_id)
      .toBeUndefined();
  });

  async function runAgainstPolicy(policy: Record<string, unknown>): Promise<void> {
    const config = configFromPluginConfig(pluginConfig({}));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ policy }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof globalThis.fetch;
    try {
      const { DomainExpertClient } = await import('../src/core/domain-expert-client.ts');
      await new DomainExpertClient(config, createDomainExpertTransport(config))
        .run('domain_ask', { question: 'q', domain_id: 'governance' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test('accepts both spellings of the control-plane contract, refuses neither', async () => {
    // The first real gateway request after the 3A flip failed here: the
    // tenant-neutral worker emits expert_agents_control_plane_only, the client
    // demanded the olympus branding, and every direct-to-worker proof missed
    // it because this assertion lives only in the client.
    await expect(runAgainstPolicy({
      expert_agents_control_plane_only: true,
      raw_runtime_secrets_exposed: false,
    })).resolves.toBeUndefined();
    await expect(runAgainstPolicy({
      olympus_control_plane_only: true,
      raw_runtime_secrets_exposed: false,
    })).resolves.toBeUndefined();
    await expect(runAgainstPolicy({ raw_runtime_secrets_exposed: false }))
      .rejects.toThrow('bounded policy contract');
    await expect(runAgainstPolicy({
      expert_agents_control_plane_only: true,
      raw_runtime_secrets_exposed: true,
    })).rejects.toThrow('bounded policy contract');
  });

  test('a blank default domain id is dropped at validation', () => {
    expect(configFromPluginConfig(pluginConfig({ defaultDomainId: '  ' })).domainExpert.defaultDomainId)
      .toBeUndefined();
    expect(configFromPluginConfig(pluginConfig({ defaultDomainId: 'governance' })).domainExpert.defaultDomainId)
      .toBe('governance');
  });

  test('a blank domain expert bearer is dropped at validation', () => {
    expect(configFromPluginConfig(pluginConfig({ authToken: '   ' })).domainExpert.authToken)
      .toBeUndefined();
  });

  test('the domain expert bearer can be delivered by environment or worker.env, never only by live config', () => {
    // Delivery matters as much as selection: the gateway resolves plugin config
    // without reading env, so a config-only field could be supplied only by
    // writing the secret into openclaw.json. These are the routes that avoid it.
    const config = configFromPluginConfig(pluginConfig({}));
    const home = mkdtempSync(join(tmpdir(), 'olympus-domain-expert-bearer-'));
    const envPath = join(home, '.config', 'olympus', 'worker.env');
    try {
      expect(domainExpertAuthTokenFromConfig(config, { env: {}, homeDir: home }))
        .toBe(FLEET_TOKEN);

      expect(domainExpertAuthTokenFromConfig(config, {
        env: { OLYMPUS_DOMAIN_EXPERT_AUTH_TOKEN: EXPERT_TOKEN },
        homeDir: home,
      })).toBe(EXPERT_TOKEN);

      mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
      writeFileSync(envPath, `OLYMPUS_DOMAIN_EXPERT_AUTH_TOKEN=${EXPERT_TOKEN}\n`, { mode: 0o600 });
      chmodSync(envPath, 0o600);
      expect(domainExpertAuthTokenFromConfig(config, { env: {}, homeDir: home }))
        .toBe(EXPERT_TOKEN);

      const configured = configFromPluginConfig(pluginConfig({ authToken: 'config-wins-token' }));
      expect(domainExpertAuthTokenFromConfig(configured, {
        env: { OLYMPUS_DOMAIN_EXPERT_AUTH_TOKEN: EXPERT_TOKEN },
        homeDir: home,
      })).toBe('config-wins-token');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('worker.env value quoting', () => {
  test('round-trips every shape Olympus writes, and leaves older shapes alone', () => {
    // The writer emits PLAINLY single-quoted values -- the one form both the
    // launchd shell and systemd's EnvironmentFile parser read the same way --
    // so this reader is a strip, and a value that would need any other form is
    // refused before it is written (see worker-env-secret.test.ts).
    const shellSingleQuote = (value: string) => `'${value}'`;
    for (const value of [
      'plain-key',
      'x$(touch /tmp/pwned)',
      'has spaces',
      '$HOME`id`',
      'gemini-Ab12_-key.value~x',
    ]) {
      expect(unquoteEnvValue(shellSingleQuote(value))).toBe(value);
    }

    // Shapes that predate the quoting must keep meaning exactly what they meant.
    expect(unquoteEnvValue('bare-value')).toBe('bare-value');
    expect(unquoteEnvValue('  padded  ')).toBe('padded');
    expect(unquoteEnvValue('"double"')).toBe('double');
    expect(unquoteEnvValue("'single'")).toBe('single');
    expect(unquoteEnvValue("'abc'def'")).toBe("abc'def");
    expect(unquoteEnvValue("'unterminated")).toBe("'unterminated");
  });
});
