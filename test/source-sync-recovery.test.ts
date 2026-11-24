import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { connectedOAuthStatuses, startExternalOAuthSourceConnection } from '../src/core/connect.ts';
import { defaultMailScopeSelection } from '../src/core/mail-source-scope.ts';
import { composeProviderAccountId, googleAccountIdFromAddress, googleSubjectLabel } from '../src/core/provider-account-identity.ts';
import { sourceAccountBindingsPath, updateSourceAccountBinding } from '../src/core/source-account-binding.ts';
import { EncryptedFileSecretStore } from '../src/core/secret-store.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { EnvCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  connectedGrantGeneration,
  markConnectedHandleReauthRequired,
  readConnectedHandleRegistry,
  upsertConnectedHandle,
} from '../src/workers/credential-broker/connected-handles.ts';
import { GMAIL_CONNECTOR_CORPUS_ID, GoogleGmailSourceConnector } from '../src/workers/google-connectors/gmail.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { buildSourceIngestionLedgerSnapshot } from '../src/workers/source-ingestion-ledger.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import { SourceScheduler, type SourceSchedulerSource } from '../src/workers/source-scheduler.ts';
import { FileSourceScopeAuthority, scopeBoundSchedulerSource } from '../src/workers/source-scope-runtime.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { createTestClock } from './helpers/test-clock.ts';

const START = Date.parse('2026-11-15T02:47:00.000Z');
const HOUR_MS = 3_600_000;
const sourceId = 'gmail.email';
const corpusId = GMAIL_CONNECTOR_CORPUS_ID;
const handleId = 'gmail.personal';
const capability = 'gmail.email.sync';

function indexStatus(now: Date): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: now.toISOString(),
    corpora: [],
    policy: {
      read_only: true, raw_source_exposed: false, source_packets_exposed: false,
      source_text_returned: false, secure_local_item_metadata_exposed: false, castor_visible: true,
    },
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-source-sync-recovery-'));
  const registryPath = join(dir, 'handles.json');
  const secretStore = new EncryptedFileSecretStore({
    encryptedFilePath: join(dir, 'secrets.enc'),
    keyFilePath: join(dir, 'secrets.key'),
  });
  const clock = createTestClock(START);
  const authority = new FileSourceScopeAuthority({ registryPath });
  const registry = () => readConnectedHandleRegistry(registryPath);
  const connect = async (account: string, address = account) => {
    const pending = await startExternalOAuthSourceConnection({
      source: 'gmail', registryPath, secretStore, clientId: 'fixture-oauth-client',
      tokenUrl: 'https://oauth.fixture.test/token', redirectUri: 'http://localhost/callback',
      now: clock.date,
      fetch: async (url) => {
        switch (new URL(String(url)).pathname) {
          case '/token': return Response.json({
            access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600,
          });
          case '/gmail/v1/users/me/profile': return Response.json({ emailAddress: `${address}@example.test` });
          case '/tokeninfo': return Response.json(account ? { sub: account, scope: 'openid' } : {});
          default: throw new Error('Unexpected OAuth fixture request');
        }
      },
    });
    return pending.completeCallback({ code: 'fixture-code', state: pending.state });
  };
  const dashboard = (status = indexStatus(clock.date())) => {
    const scope = authority.mailSnapshot();
    const ledger = buildSourceIngestionLedgerSnapshot(status, {
      connectedHandleRegistry: registry(), syncFreshnessThresholdHours: 26,
    });
    const raw = buildSourceDashboardViewModel({
      sourceIndexStatus: status, ingestionLedger: ledger,
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      connectedHandleRegistry: registry(), now: clock.date(),
      syncFreshnessThresholdHours: 26,
      fileSourceScopeStatus: { [sourceId]: scope.status },
      fileSourceScopeConnected: { [sourceId]: scope.accountGeneration !== undefined },
      fileSourceScopeIngestionEnabled: { [sourceId]: scope.status === 'approved' },
    });
    return { raw, ledger, model: buildChatGptDashboardViewModel(raw, { now: clock.date() }) };
  };
  return { dir, registryPath, secretStore, clock, authority, registry, connect, dashboard };
}

test('refresh recovery leaves an unrelated OAuth grant alone when a direct bearer overrides it', async () => {
  const f = fixture();
  try {
    const connectedAt = f.clock.date().toISOString();
    upsertConnectedHandle({
      handle: 'dropbox.personal', provider: 'dropbox', connectedAt, accountRole: 'personal',
      trustDomain: 'secure_local', allowedCapabilities: ['dropbox.files.sync'], scopes: [],
      oauth2Refresh: {
        tokenUrl: 'https://oauth.fixture.test/token', clientIdSecretRef: 'store:dropbox.fixture.client',
        refreshTokenSecretRef: 'store:dropbox.fixture.refresh',
      },
    }, f.registryPath);
    const broker = new EnvCredentialBroker({
      env: { DROPBOX_ACCESS_TOKEN: 'fixture-direct-bearer' },
      handleRegistryPath: f.registryPath, secretStore: f.secretStore, now: f.clock.date,
      fetch: async () => { throw new Error('An unused OAuth route must never be called'); },
    });
    const request = {
      handle: 'dropbox.personal', provider: 'dropbox' as const, trustDomain: 'secure_local' as const,
      capability: 'dropbox.files.sync',
    };
    const oauth = broker.sourceOAuthRecovery(request, connectedAt, connectedGrantGeneration(connectedAt, undefined))!;
    expect(await oauth.refresh()).toBe(false);
    await oauth.requireReconnect();
    expect(connectedOAuthStatuses('dropbox', f.registryPath)[0]?.status).toBe('connected');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

for (const verified of [false, true]) {
  test(`a legacy Google address only carries its approval with exact-grant account proof (${verified})`, async () => {
    const f = fixture();
    try {
      await f.connect('', 'address');
      const previous = f.registry().handles[0]!;
      const pending = f.authority.mailSnapshot();
      f.authority.approveMail({
        accountGeneration: pending.accountGeneration!, expectedRevision: pending.revision, scope: defaultMailScopeSelection(),
      });
      if (verified) {
        // The previous grant's account was verified by a sync after the legacy
        // registry entry was created. Only the account binding got upgraded.
        updateSourceAccountBinding(sourceAccountBindingsPath(f.registryPath), sourceId, () => ({
          provider_account_id: composeProviderAccountId([
            googleAccountIdFromAddress('address@example.test'), googleSubjectLabel('verified-account'),
          ])!,
          bound_at: previous.connectedAt,
          bound_grant: previous.connectedAt,
        }));
      }
      markConnectedHandleReauthRequired(handleId, f.registryPath, f.clock.date());
      await f.clock.advance(1_000);
      await f.connect(verified ? 'verified-account' : 'reassigned-account', 'address');
      expect(f.authority.mailSnapshot().status).toBe(verified ? 'approved' : 'scope_pending');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

function lane(run: SourceSchedulerSource['tasks'][number]['run']): SourceSchedulerSource {
  return {
    sourceId, corpusId, cadence: 'continuous', intervalMs: 30 * 60_000, freshnessThresholdHours: 26,
    tasks: [{ id: 'pull', kind: 'sync', writer: true, run }],
  };
}

function scheduler(clock: ReturnType<typeof createTestClock>, sources: SourceSchedulerSource[], stateStore?: LocalSourceSchedulerStateStore) {
  return new SourceScheduler({
    enabled: true, tickMs: 1_000, errorBackoffMs: 2_000, maxTransientRetries: 1,
    sources, now: clock.date, sleep: clock.sleep, ...(stateStore ? { stateStore } : {}),
  });
}

for (const outcome of ['recovered', 'refresh-failed', 'still-rejected'] as const) {
  test(`an OAuth API 401 gets exactly one refresh per rejected sync (${outcome})`, async () => {
    const f = fixture();
    try {
      await f.connect('first');
      let mints = 0;
      let requests = 0;
      const fetchFixture = async (url: URL | RequestInfo, init?: RequestInit) => {
        if (new URL(String(url)).pathname === '/token') {
          mints += 1;
          if (outcome === 'refresh-failed' && mints === 2) {
            return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
          }
          return Response.json({ access_token: `fixture-access-${mints}`, expires_in: 3600 });
        }
        requests += 1;
        if (outcome === 'recovered' && new Headers(init?.headers).get('Authorization') === 'Bearer fixture-access-2') {
          return Response.json({ messages: [] });
        }
        return Response.json({ error: { message: 'Request had invalid authentication credentials' } }, { status: 401 });
      };
      const broker = new EnvCredentialBroker({
        env: {}, handleRegistryPath: f.registryPath, secretStore: f.secretStore,
        now: f.clock.date, fetch: fetchFixture, oauth2CacheNamespace: f.dir,
      });
      const grant = f.registry().handles[0]!;
      const request = { provider: 'gmail' as const, handle: handleId, trustDomain: 'secure_local' as const, capability, purpose: 'Test source sync' };
      const oauthRecovery = broker.sourceOAuthRecovery(request, grant.connectedAt,
        connectedGrantGeneration(grant.connectedAt, grant.providerAccountId))!;
      const runner = scheduler(f.clock, [{ ...lane(async () => {
        const connector = new GoogleGmailSourceConnector({ credentialBroker: broker, fetch: fetchFixture, env: {} });
        for await (const _ of connector.listItems()) { /* an empty successful page is sufficient */ }
        return { status: 'idle' };
      }), oauthRecovery }]);
      const task = (await runner.runDueTasks()).sources[0]!.tasks[0]!;
      expect(mints).toBe(2);
      expect(requests).toBe(outcome === 'refresh-failed' ? 1 : 2);
      if (outcome === 'recovered') {
        expect(task.consecutive_failures).toBe(0);
        expect(connectedOAuthStatuses('gmail', f.registryPath)[0]?.status).toBe('connected');
        // This request captured the available grant before its secret read
        // yielded. A peer process can mark the grant while it is waiting.
        const cached = broker.issueSession(request);
        markConnectedHandleReauthRequired(handleId, f.registryPath, f.clock.date());
        await expect(cached).rejects.toMatchObject({ code: 'credential_reauth_required' });
      } else {
        expect(task).toMatchObject({ consecutive_failures: 1, last_error_kind: 'credential_reauth_required' });
        expect(Date.parse(task.next_run_at!)).toBeGreaterThan(f.clock.now());
        expect(connectedOAuthStatuses('gmail', f.registryPath)[0]?.status).toBe('needs_reconnect');
        expect((await broker.status(handleId)).status).toBe('reauth_required');
        const { raw, ledger, model } = f.dashboard();
        expect(raw.sources.find((source) => source.source_id === sourceId)?.connection.label).toBe('needs reconnect');
        expect(ledger.rows.find((row) => row.source_id === 'email')?.stuck.broken).toBe(1);
        expect(model.needsYou.find((entry) => entry.id === `source:${sourceId}`))
          .toMatchObject({ sentence: 'Gmail — needs reconnect', fix: { label: 'Reconnect' } });
        await f.clock.advance(60_000);
        await f.connect('first');
        await expect(oauthRecovery.requireReconnect()).rejects.toMatchObject({ code: 'credential_refresh_busy' });
        expect(connectedOAuthStatuses('gmail', f.registryPath)[0]?.status).toBe('connected');
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

test('a failing sync retains a finite capped retry across restarts and eventually recovers', async () => {
  const clock = createTestClock(START);
  const state = new LocalSourceSchedulerStateStore(':memory:');
  let attempts = 0;
  const source = lane(async () => {
    if (++attempts <= 16) throw new Error('temporary network failure');
    return { status: 'progress' };
  });
  try {
    let delay = 0;
    for (let run = 1; run <= 16; run += 1) {
      const task = (await scheduler(clock, [source], state).runDueTasks()).sources[0]!.tasks[0]!;
      expect(task.consecutive_failures).toBe(run);
      const nextDelay = Date.parse(task.next_run_at!) - clock.now();
      expect(nextDelay).toBeGreaterThan(0);
      expect(nextDelay).toBeGreaterThanOrEqual(delay);
      expect(nextDelay).toBeLessThanOrEqual(HOUR_MS);
      delay = nextDelay;
      await clock.advance(delay);
    }
    const recovered = (await scheduler(clock, [source], state).runDueTasks()).sources[0]!.tasks[0]!;
    expect(recovered).toMatchObject({ consecutive_failures: 0, last_result: { status: 'progress' } });
    expect(attempts).toBe(17);
  } finally {
    state.close();
  }
});

test('the replacement grant resumes an approved scope and preserves the cursor and grant fence', async () => {
  const f = fixture();
  const state = new LocalSourceSchedulerStateStore(':memory:');
  try {
    await f.connect('first');
    const initial = f.authority.mailSnapshot();
    f.authority.approveMail({
      accountGeneration: initial.accountGeneration!, expectedRevision: initial.revision, scope: defaultMailScopeSelection(),
    });
    const before = f.authority.mailPolicyRef()!;
    const oauth = () => {
      const grant = f.registry().handles[0]!;
      return {
        connectedAt: grant.connectedAt, generation: connectedGrantGeneration(grant.connectedAt, grant.providerAccountId),
        refresh: async () => true, requireReconnect: async () => {},
      };
    };
    const denied = scopeBoundSchedulerSource({
      authority: f.authority, ref: before,
      source: { ...lane(async () => { throw new Error('temporary network failure'); }), oauthRecovery: oauth() },
    });
    const key = { sourceId, corpusId, taskId: denied.tasks[0]!.id };
    state.recordSuccess({ ...key, completedAt: f.clock.date().toISOString(), resultStatus: 'progress', checkpoint: 'fixture-cursor' });
    const runner = scheduler(f.clock, [denied], state);
    await runner.runSource(sourceId);
    markConnectedHandleReauthRequired(handleId, f.registryPath, f.clock.date());
    runner.updateSources([]);
    expect(f.authority.mailPolicyRef()).toBeUndefined();
    await f.clock.advance(1_000);
    await f.connect('first');
    const after = f.authority.mailPolicyRef()!;
    expect(after).toMatchObject({ revision: before.revision, approvalGeneration: before.accountGeneration });
    expect(after.accountGeneration).not.toBe(before.accountGeneration);
    expect(() => f.authority.assertRefCurrent(before)).toThrow();
    let resumed = false;
    runner.updateSources([scopeBoundSchedulerSource({
      authority: f.authority, ref: after,
      source: { ...lane(async (context) => {
        expect(context?.checkpoint).toBe('fixture-cursor');
        expect(context?.consecutiveFailures).toBe(0);
        resumed = true;
        return { status: 'progress' };
      }), oauthRecovery: oauth() },
    })]);
    await runner.runDueTasks();
    expect(resumed).toBe(true);
    expect(f.dashboard().model.needsYou.some((item) => item.id === `source:${sourceId}`)).toBe(false);

    await f.clock.advance(1_000);
    await f.connect('second');
    const newAccount = f.authority.mailSnapshot();
    expect(newAccount).toMatchObject({ status: 'scope_pending', reason: 'account_changed' });
    const prompt = { sentence: 'Gmail — choose which mail to include', fix: { label: 'Choose mail', args: { source_id: sourceId } } };
    let { model } = f.dashboard();
    const prompts = model.needsYou.filter((item) => item.id === `source:${sourceId}`);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject(prompt);
    expect(model.sources.find((source) => source.id === sourceId)).toMatchObject({ status: 'Needs you', primary: prompt.fix });
    const approved = f.authority.approveMail({
      accountGeneration: newAccount.accountGeneration!, expectedRevision: newAccount.revision, scope: defaultMailScopeSelection(),
    });
    expect(approved.status).toBe('approved');
    ({ model } = f.dashboard());
    expect(model.needsYou.some((item) => item.id === `source:${sourceId}`)).toBe(false);
  } finally {
    state.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a completed sync becomes stale when its cadence stops advancing', async () => {
  const clock = createTestClock(START);
  const runner = scheduler(clock, [lane(async () => ({ status: 'progress' }))]);
  await runner.runDueTasks();
  await clock.advance(48 * HOUR_MS);
  const source = runner.status().sources[0]!;
  expect(source).toMatchObject({ stale_sync_anomaly: true, freshness_hours: 48 });
  expect(source.tasks[0]).toMatchObject({ last_result: { status: 'progress' }, consecutive_failures: 0 });
});

test('older completed store evidence still shows a late refresh when there is no scheduler snapshot', async () => {
  const f = fixture();
  try {
    await f.connect('first');
    const pending = f.authority.mailSnapshot();
    f.authority.approveMail({
      accountGeneration: pending.accountGeneration!, expectedRevision: pending.revision, scope: defaultMailScopeSelection(),
    });
    await f.clock.advance(48 * HOUR_MS);
    const { raw, ledger, model } = f.dashboard({
      ...indexStatus(f.clock.date()),
      corpora: [{
        corpus_id: corpusId, family: 'email', provider: 'gmail', trust_domain: 'internal',
        activation_mode: 'live', embedding_policy: 'disabled', configured: true, item_metadata_returned: false,
        read_authority: 'connector_store', skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
        counts: { indexed_items: 100, tombstoned_items: 0, chunks: 100, embedded_chunks: 0, sync_runs: 1 },
        last_refresh: { sync_run_id: 'fixture', status: 'completed', completed_at: new Date(START).toISOString(),
          items_seen: 100, items_indexed: 100 },
      }],
    });
    expect(raw.sources.find((source) => source.source_id === sourceId)?.freshness).toMatchObject({ stale: true, hours: 48 });
    expect(ledger.rows.find((row) => row.source_id === 'email')?.attention).toContain('stale sync: 48h since last refresh');
    expect(model.needsYou.find((entry) => entry.id === `source:${sourceId}`)?.sentence).toContain('later than expected');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
