import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  credentialHealthDegradations,
  readCredentialHealthReport,
  runCredentialHealthAlarm,
  runCredentialHealthProbe,
  type CredentialHealthProbeBroker,
  type CredentialHealthResult,
} from '../src/workers/credential-health.ts';
import {
  CredentialBrokerError,
  EnvCredentialBroker,
  type CredentialSession,
} from '../src/workers/credential-broker/index.ts';
import { readConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import type { SecretStore } from '../src/core/secret-store.ts';

const NOW = '2026-08-18T12:00:00.000Z';
const SOON = '2026-08-18T12:01:00.000Z';

/** Every credential whose cache read the 1Password runtime wrapper owns. */
const WRAPPER_READ_HANDLES = new Set([
  'gmail.personal.delegated',
  'google_drive.personal.delegated',
  'readwise.personal',
  'venice.api-key',
]);

describe('credential health alarm', () => {
  test('turns the formerly silent reauth latch into a non-zero named alarm without mutating state', () => {
    const fixture = healthFixture();
    const state = JSON.stringify({
      version: 1,
      handles: {
        'dropbox.personal': { status: 'reauth_required', updatedAt: '2026-07-29T10:14:45.111Z' },
        'x.bookmarks.personal': { status: 'available', updatedAt: NOW },
      },
    }, null, 2);
    writeFileSync(fixture.statePath, state, { mode: 0o600 });

    const before = readFileSync(fixture.statePath, 'utf8');
    const result = runCredentialHealthAlarm(alarmOptions(fixture));

    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('handle=dropbox.personal status=reauth_required');
    expect(result.lines.join('\n')).not.toContain('x.bookmarks.personal');
    expect(readFileSync(fixture.statePath, 'utf8')).toBe(before);
  });

  test('names every malformed registration by safe handle id or stable entry index', () => {
    const fixture = healthFixture();
    writeFileSync(fixture.registryPath, JSON.stringify({
      version: 1,
      handles: [
        { handle: 'dropbox.personal', provider: 'dropbox', connectedAt: '2026-08-18T00:00:00Z', scopes: [] },
        { provider: 'readwise', connectedAt: '2026-08-18T00:00:00Z', allowedCapabilities: ['readwise.sync'], scopes: [] },
      ],
    }), { mode: 0o600 });

    const result = runCredentialHealthAlarm(alarmOptions(fixture));

    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('handle=dropbox.personal status=credential_missing');
    expect(result.lines.join('\n')).toContain('handle=handles[1] status=credential_missing');
  });

  test('names a registration whose provider label is not a known credential provider', () => {
    const fixture = healthFixture();
    writeFileSync(fixture.registryPath, JSON.stringify({
      version: 1,
      handles: [oauthHandle('x.bookmarks.renamed', 'twitter', 'x.bookmarks.sync')],
    }), { mode: 0o600 });

    const result = runCredentialHealthAlarm(alarmOptions(fixture));

    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('handle=x.bookmarks.renamed status=credential_missing');
  });

  test('fails closed when every health surface is absent instead of reporting healthy', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-credential-health-absent-'));
    const result = runCredentialHealthAlarm({
      registryPath: join(root, 'handles.json'),
      brokerStatePath: join(root, 'credential-broker-state.json'),
      reportPath: join(root, 'credential-health.json'),
      now: () => new Date(SOON),
      bootedAt: new Date('2026-08-17T00:00:00.000Z'),
    });

    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('surface=probe_report state=missing');
    expect(result.lines.join('\n')).toContain('state=error');
    expect(result.lines.join('\n')).not.toContain('state=healthy');
  });

  test('holds a missing probe report green only inside the bootstrap window', () => {
    const fixture = healthFixture({ report: false });
    const booting = runCredentialHealthAlarm({
      ...alarmOptions(fixture),
      bootedAt: new Date('2026-08-18T11:30:00.000Z'),
    });
    expect(booting.exitCode).toBe(0);
    expect(booting.lines.join('\n')).toContain('surface=probe_report state=bootstrap_pending');

    const settled = runCredentialHealthAlarm({
      ...alarmOptions(fixture),
      bootedAt: new Date('2026-08-18T06:00:00.000Z'),
    });
    expect(settled.exitCode).toBe(2);
    expect(settled.lines.join('\n')).toContain('surface=probe_report state=missing');
  });

  test('fails closed on a corrupt probe report, registry, or broker state', () => {
    const corruptReport = healthFixture();
    writeFileSync(corruptReport.reportPath, '{"kind":"credential_health_report"', { mode: 0o600 });
    const reportResult = runCredentialHealthAlarm(alarmOptions(corruptReport));
    expect(reportResult.exitCode).toBe(2);
    expect(reportResult.lines.join('\n')).toContain('surface=probe_report state=unreadable');

    const corruptRegistry = healthFixture();
    writeFileSync(corruptRegistry.registryPath, 'not json at all', { mode: 0o600 });
    const registryResult = runCredentialHealthAlarm(alarmOptions(corruptRegistry));
    expect(registryResult.exitCode).toBe(2);
    expect(registryResult.lines.join('\n')).toContain('surface=registry state=unreadable');

    const corruptState = healthFixture();
    writeFileSync(corruptState.statePath, '[]', { mode: 0o600 });
    const stateResult = runCredentialHealthAlarm(alarmOptions(corruptState));
    expect(stateResult.exitCode).toBe(2);
    expect(stateResult.lines.join('\n')).toContain('surface=broker_state state=unreadable');
  });

  test('rejects partial broker-state entries instead of silently filtering them', () => {
    const fixture = healthFixture();
    writeFileSync(fixture.statePath, JSON.stringify({
      version: 1,
      handles: {
        'dropbox.personal': { status: 'available', updatedAt: NOW },
        'x.bookmarks.personal': 'reauth_required',
      },
    }), { mode: 0o600 });

    const result = runCredentialHealthAlarm(alarmOptions(fixture));

    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('surface=broker_state state=partial');
  });

  test('treats a stale healthy probe report as non-green', () => {
    const fixture = healthFixture({ generatedAt: '2026-08-17T05:00:00.000Z' });
    const result = runCredentialHealthAlarm(alarmOptions(fixture));

    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('surface=probe_report state=stale');
    expect(result.lines.join('\n')).not.toContain('state=healthy');
  });

  test('says a stale unhealthy report is stale instead of paging it as current', () => {
    const fixture = healthFixture({
      generatedAt: '2026-08-17T05:00:00.000Z',
      results: [healthResultFixture({
        handle: 'dropbox.personal',
        provider: 'dropbox',
        status: 'reauth_required',
        reason: 'credential_reauth_required',
        checkedAt: '2026-08-17T05:00:00.000Z',
      })],
    });

    const result = runCredentialHealthAlarm(alarmOptions(fixture));

    expect(result.lines.join('\n')).toContain('handle=dropbox.personal status=reauth_required source=stale_probe');
    expect(result.lines.join('\n')).not.toContain('source=probe\n');
    expect(result.lines.join('\n')).toContain('surface=probe_report state=stale');
  });

  test('treats a future-dated healthy report as non-green instead of fresh forever', () => {
    const fixture = healthFixture({ generatedAt: '2099-01-01T00:00:00.000Z' });
    const result = runCredentialHealthAlarm(alarmOptions(fixture));

    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('surface=probe_report state=stale');
    expect(result.lines.join('\n')).not.toContain('state=healthy');
  });

  test('keeps a future-dated unhealthy report out of current findings', () => {
    const fixture = healthFixture({
      generatedAt: '2099-01-01T00:00:00.000Z',
      results: [healthResultFixture({
        handle: 'dropbox.personal',
        provider: 'dropbox',
        status: 'reauth_required',
        reason: 'credential_reauth_required',
        checkedAt: '2099-01-01T00:00:00.000Z',
      })],
    });

    const result = runCredentialHealthAlarm(alarmOptions(fixture));

    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('handle=dropbox.personal status=reauth_required source=stale_probe');
    expect(result.lines.join('\n')).toContain('surface=probe_report state=stale');
  });

  test('refuses a report whose result was checked far outside its own generation window', () => {
    const fixture = healthFixture({
      results: [healthResultFixture({
        handle: 'dropbox.personal',
        provider: 'dropbox',
        status: 'healthy',
        checkedAt: '2026-06-01T00:00:00.000Z',
      })],
    });

    const result = runCredentialHealthAlarm(alarmOptions(fixture));

    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('surface=probe_report state=unreadable');
  });

  test('refuses a report with no policy or a policy the probe would never write', () => {
    const policyless = healthFixture();
    const withoutPolicy = JSON.parse(readFileSync(policyless.reportPath, 'utf8')) as Record<string, unknown>;
    delete withoutPolicy.policy;
    writeFileSync(policyless.reportPath, JSON.stringify(withoutPolicy), { mode: 0o600 });
    const policylessResult = runCredentialHealthAlarm(alarmOptions(policyless));
    expect(policylessResult.exitCode).toBe(2);
    expect(policylessResult.lines.join('\n')).toContain('surface=probe_report state=unreadable');
    expect(readCredentialHealthReport(policyless.reportPath)).toBeUndefined();

    const wrongPolicy = healthFixture();
    const drifted = JSON.parse(readFileSync(wrongPolicy.reportPath, 'utf8')) as { policy: Record<string, unknown> };
    drifted.policy.x_refresh_forced = true;
    writeFileSync(wrongPolicy.reportPath, JSON.stringify(drifted), { mode: 0o600 });
    const wrongPolicyResult = runCredentialHealthAlarm(alarmOptions(wrongPolicy));
    expect(wrongPolicyResult.exitCode).toBe(2);
    expect(wrongPolicyResult.lines.join('\n')).toContain('surface=probe_report state=unreadable');
    expect(readCredentialHealthReport(wrongPolicy.reportPath)).toBeUndefined();
  });

  test('reports surfaces the probe proved unused as unconfigured rather than alarming', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-credential-health-empty-'));
    const reportPath = join(root, 'credential-health.json');
    writeFileSync(reportPath, JSON.stringify(reportFixture({ generatedAt: NOW, results: [] })), { mode: 0o600 });

    const result = runCredentialHealthAlarm({
      registryPath: join(root, 'handles.json'),
      brokerStatePath: join(root, 'credential-broker-state.json'),
      reportPath,
      now: () => new Date(SOON),
      bootedAt: new Date('2026-08-17T00:00:00.000Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('surface=registry state=not_configured');
    expect(result.lines.join('\n')).toContain('state=healthy');
  });
});

describe('daily credential health probe', () => {
  test('exercises only credentials proven free to spend and never the rotating or unclassified ones', async () => {
    const fixture = healthFixture();
    const issued: string[] = [];
    const broker: CredentialHealthProbeBroker = {
      async issueSession(request) {
        issued.push(request.handle);
        return bearerSession(request.handle, request.capability);
      },
    };
    const fetched: string[] = [];
    const authHeaders: Record<string, string> = {};
    const result = await runCredentialHealthProbe({
      env: wrapperEnv({ status: 'cached', value: 'cache-hit-fixture' }),
      registryPath: fixture.registryPath,
      brokerStatePath: fixture.statePath,
      reportPath: fixture.reportPath,
      broker,
      fetchImpl: (async (input: unknown, init?: { headers?: Record<string, string> }) => {
        fetched.push(String(input));
        authHeaders[String(input)] = init?.headers?.Authorization ?? '';
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      now: () => new Date(NOW),
    });

    expect(result.exitCode).toBe(0);
    // Provider header contracts, pinned from live probes 2026-08-19: Readwise
    // accepts only the "Token" scheme (Bearer returned 401 against the same
    // valid credential); Venice takes standard "Bearer". A fixture endpoint
    // accepts anything, so the exact scheme must be asserted here.
    expect(authHeaders['https://readwise.io/api/v2/auth/']).toMatch(/^Token /);
    expect(authHeaders['https://api.venice.ai/api/v1/models']).toMatch(/^Bearer /);
    expect(issued).toEqual([
      'gmail.personal.delegated',
      'google_drive.personal.delegated',
      'readwise.personal',
    ]);
    expect(issued).not.toContain('dropbox.personal');
    expect(issued).not.toContain('x.bookmarks.personal');
    expect(fetched).toEqual([
      'https://readwise.io/api/v2/auth/',
      'https://api.venice.ai/api/v1/models',
    ]);
    expect(result.report.results.find((item) => item.handle === 'x.bookmarks.personal')).toMatchObject({
      credential_type: 'rotating_oauth2_refresh',
      probe_mode: 'passive',
    });
    expect(result.report.results.find((item) => item.handle === 'dropbox.personal')).toMatchObject({
      probe_mode: 'passive',
    });
    expect(readCredentialHealthReport(fixture.reportPath)?.policy).toMatchObject({
      secrets_exposed: false,
      raw_source_exposed: false,
      x_refresh_forced: false,
      op_cached_read_only: true,
    });
  });

  test('returns before the broker for every accepted X-shaped registration however its labels drift', async () => {
    const shapes = [
      { handle: 'x.bookmarks.personal', provider: 'x', capability: 'x.bookmarks.sync', tokenUrl: 'https://api.x.com/2/oauth2/token' },
      { handle: 'bookmarks.renamed', provider: 'x', capability: 'social.sync', tokenUrl: 'https://provider.example/token' },
      { handle: 'bookmarks.renamed', provider: 'dropbox', capability: 'x.bookmarks.sync', tokenUrl: 'https://provider.example/token' },
      { handle: 'bookmarks.renamed', provider: 'dropbox', capability: 'social.sync', tokenUrl: 'https://api.x.com/2/oauth2/token' },
      { handle: 'x.bookmarks.renamed', provider: 'twitter', capability: 'x.bookmarks.sync', tokenUrl: 'https://api.x.com/2/oauth2/token' },
    ];

    for (const shape of shapes) {
      const fixture = healthFixture();
      writeFileSync(fixture.registryPath, JSON.stringify({
        version: 1,
        handles: [{
          handle: shape.handle,
          provider: shape.provider,
          allowedCapabilities: [shape.capability],
          scopes: [],
          connectedAt: '2026-08-18T00:00:00.000Z',
          oauth2Refresh: {
            tokenUrl: shape.tokenUrl,
            clientIdSecretRef: 'store:x.client_id',
            refreshTokenSecretRef: 'store:x.refresh_token',
            scopes: [],
          },
        }],
      }), { mode: 0o600 });

      const issued: string[] = [];
      const tripwire: CredentialHealthProbeBroker = {
        async issueSession(request) {
          issued.push(request.handle);
          throw new Error('the probe minted a rotating credential');
        },
      };
      const result = await runCredentialHealthProbe({
        env: {},
        registryPath: fixture.registryPath,
        brokerStatePath: fixture.statePath,
        reportPath: fixture.reportPath,
        broker: tripwire,
        fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
        now: () => new Date(NOW),
      });

      expect({ shape, issued }).toEqual({ shape, issued: [] });
      const probed = result.report.results.find((item) => item.handle === shape.handle);
      // The drifted provider label is refused at parse, so shape five never
      // reaches the probe at all; the rest must be classified as rotating.
      if (shape.provider === 'twitter') {
        expect(probed).toBeUndefined();
      } else {
        expect({ shape, type: probed?.credential_type }).toEqual({
          shape,
          type: 'rotating_oauth2_refresh',
        });
      }
    }
  });

  test('rejects a drifted provider label at registry parse instead of casting it through', () => {
    const fixture = healthFixture();
    writeFileSync(fixture.registryPath, JSON.stringify({
      version: 1,
      handles: [oauthHandle('x.bookmarks.renamed', 'twitter', 'x.bookmarks.sync')],
    }), { mode: 0o600 });

    const registry = readConnectedHandleRegistry(fixture.registryPath);

    expect(registry.handles).toEqual([]);
    expect(registry.dropped).toEqual([{ index: 0, reason: 'unknown_provider' }]);
  });

  test('does not consume or latch Dropbox or an unclassified OAuth handle when the provider rotates', async () => {
    const fixture = healthFixture();
    writeFileSync(fixture.registryPath, JSON.stringify({
      version: 1,
      handles: [
        {
          ...oauthHandle('dropbox.personal', 'dropbox', 'dropbox.files.sync'),
          oauth2Refresh: {
            tokenUrl: 'https://dropbox.rotating.invalid/oauth2/token',
            clientIdSecretRef: 'store:dropbox.client_id',
            refreshTokenSecretRef: 'store:dropbox.refresh_token',
            scopes: [],
          },
        },
        {
          ...oauthHandle('notion.personal', 'notion', 'notion.pages.sync'),
          oauth2Refresh: {
            tokenUrl: 'https://notion.rotating.invalid/oauth2/token',
            clientIdSecretRef: 'store:notion.client_id',
            refreshTokenSecretRef: 'store:notion.refresh_token',
            scopes: [],
          },
        },
      ],
    }), { mode: 0o600 });
    writeFileSync(fixture.statePath, JSON.stringify({
      version: 1,
      handles: {
        'dropbox.personal': { status: 'available', updatedAt: '2026-08-18T09:00:00.000Z', refreshToken: 'stored-dropbox' },
        'notion.personal': { status: 'available', updatedAt: '2026-08-18T09:00:00.000Z', refreshToken: 'stored-notion' },
      },
    }), { mode: 0o600 });

    const tokenEndpointCalls: string[] = [];
    const env: Record<string, string | undefined> = {
      OLYMPUS_CREDENTIAL_BROKER_STATE_PATH: fixture.statePath,
      OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: fixture.registryPath,
      // The live probe wrapper pins Dropbox's refresh token in the environment,
      // which is what makes a provider-side rotation unrecordable and latches
      // the handle the moment a fresh exchange happens.
      OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_KEY: 'dropbox-client',
      OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_SECRET: 'dropbox-secret',
      OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_REFRESH_TOKEN: 'env-pinned-dropbox-refresh',
    };
    const broker = new EnvCredentialBroker({
      env,
      handleRegistryPath: fixture.registryPath,
      secretStore: memorySecretStore({
        'notion.client_id': 'notion-client',
        'notion.refresh_token': 'stored-notion',
      }),
      oauth2CacheNamespace: `t13b-${Date.now()}`,
      fetch: (async (input: unknown) => {
        tokenEndpointCalls.push(String(input));
        return new Response(JSON.stringify({
          access_token: 'minted-access-token',
          refresh_token: 'provider-rotated-refresh-token',
          expires_in: 3600,
          token_type: 'bearer',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });

    const result = await runCredentialHealthProbe({
      env,
      registryPath: fixture.registryPath,
      brokerStatePath: fixture.statePath,
      reportPath: fixture.reportPath,
      broker,
      fetchImpl: (async (input: unknown) => {
        tokenEndpointCalls.push(String(input));
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      now: () => new Date(NOW),
    });

    expect(tokenEndpointCalls).toEqual([]);
    const state = JSON.parse(readFileSync(fixture.statePath, 'utf8')) as {
      handles: Record<string, { status?: string; refreshToken?: string }>;
    };
    expect(state.handles['dropbox.personal']?.status).toBe('available');
    expect(state.handles['notion.personal']?.status).toBe('available');
    expect(state.handles['dropbox.personal']?.refreshToken).toBe('stored-dropbox');
    expect(result.report.results.map((item) => item.probe_mode)).not.toContain('active');
  });

  test('reports passive freshness for handles it must not exercise', async () => {
    const fixture = healthFixture();
    writeFileSync(fixture.registryPath, JSON.stringify({
      version: 1,
      handles: [
        { ...oauthHandle('dropbox.personal', 'dropbox', 'dropbox.files.sync'), connectedAt: '2026-07-01T00:00:00.000Z' },
        { ...oauthHandle('x.bookmarks.personal', 'x', 'x.bookmarks.sync'), connectedAt: '2026-07-01T00:00:00.000Z' },
      ],
    }), { mode: 0o600 });
    writeFileSync(fixture.statePath, JSON.stringify({
      version: 1,
      handles: {
        'dropbox.personal': { status: 'available', updatedAt: '2026-08-18T09:00:00.000Z' },
        'x.bookmarks.personal': { status: 'available', updatedAt: '2026-08-10T09:00:00.000Z' },
      },
    }), { mode: 0o600 });

    const result = await runCredentialHealthProbe({
      env: {},
      registryPath: fixture.registryPath,
      brokerStatePath: fixture.statePath,
      reportPath: fixture.reportPath,
      broker: { async issueSession(request) { return bearerSession(request.handle, request.capability); } },
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      now: () => new Date(NOW),
    });

    expect(result.report.results.find((item) => item.handle === 'dropbox.personal')).toMatchObject({
      status: 'healthy',
      reason: 'passive_evidence_fresh',
    });
    expect(result.report.results.find((item) => item.handle === 'x.bookmarks.personal')).toMatchObject({
      status: 'degraded',
      reason: 'passive_evidence_stale',
    });
    expect(result.exitCode).toBe(1);
  });

  test('separates a broker state that is merely absent from one it cannot read', async () => {
    const absent = healthFixture();
    writeFileSync(absent.registryPath, JSON.stringify({
      version: 1,
      handles: [oauthHandle('dropbox.personal', 'dropbox', 'dropbox.files.sync')],
    }), { mode: 0o600 });
    const absentResult = await runCredentialHealthProbe({
      env: {},
      registryPath: absent.registryPath,
      brokerStatePath: join(absent.root, 'missing-state.json'),
      reportPath: absent.reportPath,
      broker: { async issueSession(request) { return bearerSession(request.handle, request.capability); } },
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      now: () => new Date(NOW),
    });
    expect(absentResult.report.results.find((item) => item.handle === 'dropbox.personal')).toMatchObject({
      status: 'healthy',
      reason: 'passive_evidence_fresh',
    });

    const broken = healthFixture();
    writeFileSync(broken.statePath, '{"version":1,"handles":{"dropbox.personal":7}}', { mode: 0o600 });
    const brokenResult = await runCredentialHealthProbe({
      env: {},
      registryPath: broken.registryPath,
      brokerStatePath: broken.statePath,
      reportPath: broken.reportPath,
      broker: { async issueSession(request) { return bearerSession(request.handle, request.capability); } },
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      now: () => new Date(NOW),
    });
    expect(brokenResult.report.results.find((item) => item.handle === 'dropbox.personal')).toMatchObject({
      status: 'degraded',
      reason: 'broker_state_unreadable',
    });
  });

  test('reports an unrecorded refresh outcome without starting another exchange', async () => {
    const fixture = healthFixture();
    writeFileSync(fixture.statePath, JSON.stringify({
      version: 1,
      handles: {
        'dropbox.personal': {
          status: 'available',
          updatedAt: '2026-08-18T09:00:00.000Z',
          pendingRefreshStartedAt: '2026-08-18T09:30:00.000Z',
        },
      },
    }), { mode: 0o600 });

    const result = await runCredentialHealthProbe({
      env: {},
      registryPath: fixture.registryPath,
      brokerStatePath: fixture.statePath,
      reportPath: fixture.reportPath,
      broker: { async issueSession(request) { return bearerSession(request.handle, request.capability); } },
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      now: () => new Date(NOW),
    });

    expect(result.report.results.find((item) => item.handle === 'dropbox.personal')).toMatchObject({
      status: 'degraded',
      reason: 'refresh_outcome_unrecorded',
    });
  });

  test('records terminal broker errors for the alarm and dashboard using safe status only', async () => {
    const fixture = healthFixture();
    const broker: CredentialHealthProbeBroker = {
      async issueSession(request) {
        if (request.handle === 'gmail.personal.delegated') {
          throw new CredentialBrokerError(
            'credential_reauth_required',
            'provider secret detail',
            { handle: request.handle, capability: request.capability },
          );
        }
        return bearerSession(request.handle, request.capability);
      },
    };
    const result = await runCredentialHealthProbe({
      env: wrapperEnv({ status: 'cached', value: 'cache-hit-fixture' }),
      registryPath: fixture.registryPath,
      brokerStatePath: fixture.statePath,
      reportPath: fixture.reportPath,
      broker,
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      now: () => new Date(NOW),
    });

    expect(result.exitCode).toBe(1);
    expect(result.report.results.find((item) => item.handle === 'gmail.personal.delegated')).toMatchObject({
      status: 'reauth_required',
      reason: 'credential_reauth_required',
    });
    expect(JSON.stringify(result.report)).not.toContain('provider secret detail');

    const alarm = runCredentialHealthAlarm(alarmOptions(fixture));
    expect(alarm.exitCode).toBe(1);
    expect(alarm.lines.join('\n')).toContain('handle=gmail.personal.delegated status=reauth_required source=probe');
  });

  test('never lets an unproven secret read authorize an active probe or a false absence', async () => {
    // Only a declared success carrying a credential proves anything. Every
    // other pair is a channel this process cannot speak for, in either Venice
    // posture: it may not mint, may not GET, and may not call a credential gone.
    const cases = [
      { name: 'status unset', env: wrapperEnv({ value: 'cache-hit-fixture' }), reason: 'credential_read_protocol_error' },
      { name: 'unknown status', env: wrapperEnv({ status: 'refreshed', value: 'cache-hit-fixture' }), reason: 'credential_read_protocol_error' },
      { name: 'cached and empty', env: wrapperEnv({ status: 'cached' }), reason: 'credential_read_protocol_error' },
      { name: 'unavailable with a value', env: wrapperEnv({ status: 'unavailable', value: 'cache-hit-fixture' }), reason: 'credential_read_protocol_error' },
      { name: 'unavailable and empty', env: wrapperEnv({ status: 'unavailable' }), reason: 'credential_cache_unavailable' },
      // Whitespace around a recognized token is a different token. Normalizing
      // it before the closed-set comparison is what widens the vocabulary the
      // wrapper is allowed to speak, and ' cached ' then authorizes a mint.
      { name: 'space padded cached', env: wrapperEnv({ status: ' cached ', value: 'cache-hit-fixture' }), reason: 'credential_read_protocol_error' },
      { name: 'tab and newline padded cached', env: wrapperEnv({ status: '\tcached\n', value: 'cache-hit-fixture' }), reason: 'credential_read_protocol_error' },
      { name: 'space padded unavailable', env: wrapperEnv({ status: ' unavailable ' }), reason: 'credential_read_protocol_error' },
      { name: 'space padded absent', env: wrapperEnv({ status: ' absent ' }), reason: 'credential_read_protocol_error' },
      { name: 'absent with a value', env: wrapperEnv({ status: 'absent', value: 'cache-hit-fixture' }), reason: 'credential_read_protocol_error' },
    ];

    for (const posture of ['1', undefined]) {
      for (const scenario of cases) {
        const fixture = healthFixture();
        const issued: string[] = [];
        const fetched: string[] = [];
        const result = await runCredentialHealthProbe({
          env: {
            ...scenario.env,
            ...(posture ? { OLYMPUS_CREDENTIAL_HEALTH_VENICE_REQUIRED: posture } : {}),
          },
          registryPath: fixture.registryPath,
          brokerStatePath: fixture.statePath,
          reportPath: fixture.reportPath,
          broker: {
            async issueSession(request) {
              issued.push(request.handle);
              return bearerSession(request.handle, request.capability);
            },
          },
          fetchImpl: (async (input: unknown) => {
            fetched.push(String(input));
            return new Response('{}', { status: 200 });
          }) as unknown as typeof fetch,
          now: () => new Date(NOW),
        });

        const observed = {
          case: `${scenario.name}/venice_required=${posture ?? 'unset'}`,
          issued,
          fetched,
          probed: result.report.results
            .filter((item) => WRAPPER_READ_HANDLES.has(item.handle))
            .map((item) => `${item.handle}=${item.status}/${item.reason}/${item.probe_mode}`)
            .sort(),
        };
        expect(observed).toEqual({
          case: `${scenario.name}/venice_required=${posture ?? 'unset'}`,
          issued: [],
          fetched: [],
          probed: [...WRAPPER_READ_HANDLES].map((handle) => `${handle}=degraded/${scenario.reason}/passive`).sort(),
        });
        expect(result.exitCode).toBe(1);
      }
    }
  });

  test('keeps a delegated-named handle with no repo service-account definition passive', async () => {
    const fixture = healthFixture();
    writeFileSync(fixture.registryPath, JSON.stringify({
      version: 1,
      handles: [staticHandle('gmail.unregistered.delegated', 'gmail', 'gmail.email.sync')],
    }), { mode: 0o600 });

    const issued: string[] = [];
    const result = await runCredentialHealthProbe({
      env: {},
      registryPath: fixture.registryPath,
      brokerStatePath: fixture.statePath,
      reportPath: fixture.reportPath,
      broker: {
        async issueSession(request) {
          issued.push(request.handle);
          return bearerSession(request.handle, request.capability);
        },
      },
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      now: () => new Date(NOW),
    });

    expect(issued).toEqual([]);
    expect(result.report.results.find((item) => item.handle === 'gmail.unregistered.delegated')).toMatchObject({
      probe_mode: 'passive',
    });
  });
});


/**
 * What the 1Password runtime wrapper exports for the three cache reads it owns:
 * the declared outcome of each read alongside the value it produced.
 */
function wrapperEnv(options: { status?: string; value?: string } = {}): Record<string, string | undefined> {
  const value = options.value ?? '';
  return {
    ...(options.status === undefined ? {} : {
      OLYMPUS_CREDENTIAL_HEALTH_SECRET_READ_GOOGLE: options.status,
      OLYMPUS_CREDENTIAL_HEALTH_SECRET_READ_READWISE: options.status,
      OLYMPUS_CREDENTIAL_HEALTH_SECRET_READ_VENICE: options.status,
    }),
    OLYMPUS_CREDENTIAL_GOOGLE_OLYMPUS_SERVICE_ACCOUNT_JSON: value,
    OLYMPUS_CREDENTIAL_READWISE_PERSONAL_TOKEN: value,
    OLYMPUS_CREDENTIAL_HEALTH_VENICE_API_KEY: value,
  };
}


function alarmOptions(fixture: ReturnType<typeof healthFixture>) {
  return {
    registryPath: fixture.registryPath,
    brokerStatePath: fixture.statePath,
    reportPath: fixture.reportPath,
    now: () => new Date(SOON),
    bootedAt: new Date('2026-08-17T00:00:00.000Z'),
  };
}

function healthFixture(options: {
  report?: boolean;
  generatedAt?: string;
  results?: CredentialHealthResult[];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'olympus-credential-health-'));
  const registryPath = join(root, 'handles.json');
  const statePath = join(root, 'credential-broker-state.json');
  const reportPath = join(root, 'credential-health.json');
  writeFileSync(registryPath, JSON.stringify({
    version: 1,
    handles: [
      oauthHandle('dropbox.personal', 'dropbox', 'dropbox.files.sync'),
      oauthHandle('x.bookmarks.personal', 'x', 'x.bookmarks.sync'),
      staticHandle('gmail.personal.delegated', 'gmail', 'gmail.email.sync'),
      staticHandle('google_drive.personal.delegated', 'google_drive', 'google_drive.docs.sync'),
      staticHandle('readwise.personal', 'readwise', 'readwise.sync'),
    ],
  }), { mode: 0o600 });
  writeFileSync(statePath, JSON.stringify({ version: 1, handles: {} }), { mode: 0o600 });
  if (options.report !== false) {
    writeFileSync(reportPath, JSON.stringify(reportFixture({
      generatedAt: options.generatedAt ?? NOW,
      results: options.results ?? [],
    })), { mode: 0o600 });
  }
  chmodSync(root, 0o700);
  return { root, registryPath, statePath, reportPath };
}

function reportFixture(options: { generatedAt: string; results: CredentialHealthResult[] }) {
  return {
    kind: 'credential_health_report',
    version: 1,
    generated_at: options.generatedAt,
    results: options.results,
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      secrets_exposed: false,
      x_refresh_forced: false,
      op_cached_read_only: true,
    },
  };
}

function healthResultFixture(options: {
  handle: string;
  provider: string;
  status: CredentialHealthResult['status'];
  reason?: string;
  checkedAt: string;
}): CredentialHealthResult {
  return {
    handle: options.handle,
    provider: options.provider,
    source_ids: [],
    credential_type: 'oauth2_refresh',
    status: options.status,
    checked_at: options.checkedAt,
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

function oauthHandle(handle: string, provider: string, capability: string) {
  return {
    ...staticHandle(handle, provider, capability),
    oauth2Refresh: {
      tokenUrl: `https://${provider}.example/token`,
      clientIdSecretRef: `store:${provider}.client_id`,
      refreshTokenSecretRef: `store:${provider}.refresh_token`,
      scopes: [],
    },
  };
}

function staticHandle(handle: string, provider: string, capability: string) {
  return {
    handle,
    provider,
    allowedCapabilities: [capability],
    scopes: [],
    connectedAt: '2026-08-18T00:00:00.000Z',
  };
}

function memorySecretStore(values: Record<string, string>): SecretStore {
  const entries = new Map(Object.entries(values));
  return {
    label: 'fixture',
    async get(key) { return entries.get(key); },
    getSync(key) { return entries.get(key); },
    async set(key, value) { entries.set(key, value); },
    async delete(key) { entries.delete(key); },
    async list() { return [...entries.keys()]; },
  };
}

function bearerSession(handle: string, capability: string): CredentialSession {
  const provider = handle.startsWith('google_drive') ? 'google_drive'
    : handle.startsWith('gmail') ? 'gmail'
      : handle.startsWith('readwise') ? 'readwise'
        : 'dropbox';
  return {
    kind: 'bearer_token',
    handle,
    provider,
    capability,
    token: `token-for-${handle}`,
    expiresAt: '2026-08-18T13:00:00.000Z',
    audit: {
      handle,
      provider,
      capability,
      scopes: [],
      outcome: 'issued',
      issuedAt: NOW,
      expiresAt: '2026-08-18T13:00:00.000Z',
      rawCredentialExposed: false,
    },
  };
}
