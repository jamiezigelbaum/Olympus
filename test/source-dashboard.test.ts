import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { renderDashboardDetailBody } from '../src/workers/dashboard/pages/detail.ts';
import {
  DASHBOARD_NEEDS_REVIEW_REASONS,
  DASHBOARD_SUPPORTED_SOURCES,
  SqliteSourceDashboardHistory,
  type SourceDashboardHistorySample,
  buildSourceDashboardViewModel,
  type SourceDashboardHistory,
} from '../src/workers/source-dashboard.ts';
import {
  createSourceCorpusRegistry,
  defaultSourceCorpusRegistryConfig,
} from '../src/core/source-corpus-registry.ts';
import { createSourceExclusionMatcherFromPrefixes } from '../src/core/source-ingestion-exclusions.ts';
import {
  buildSourceIngestionLedgerSnapshot,
  type SourceIngestionLedgerRow,
} from '../src/workers/source-ingestion-ledger.ts';
import {
  readConnectedHandleRegistry,
  writeConnectedHandleRegistry,
  type ConnectedHandleRegistry,
} from '../src/workers/credential-broker/connected-handles.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import type { OAuthFetch } from '../src/core/connect.ts';
import {
  createEmailSourceWorker,
  dashboardSourceSyncNotSupportedError,
} from '../src/workers/email-source/index.ts';
import { DASHBOARD_READINESS_LEDGER_MAX_AGE_MS } from '../src/workers/source-index/status.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import {
  SourceScheduler,
  createGmailConnectorStoreSchedulerSource,
  createReadwiseSchedulerSource,
  type SourceSchedulerStatus,
} from '../src/workers/source-scheduler.ts';
import {
  GMAIL_CONNECTOR_CORPUS_ID,
  gmailReceiptDigest,
  type GmailConnectorStoreReceipt,
  type GmailConnectorStoreSyncHandler,
  type GmailConnectorStoreTaskOutcome,
} from '../src/workers/google-connectors/index.ts';
import {
  READWISE_LIBRARY_CORPUS_ID,
  type ReadwiseConnectorStoreSyncHandler,
} from '../src/workers/readwise/index.ts';
import type {
  XApiUsageStatus,
  XBookmarksConnectorStoreSyncHandler,
  XBookmarksLiveSyncResult,
} from '../src/workers/x-bookmarks/index.ts';

describe('multi-source source dashboard', () => {
  test('content-ready counts items with text once, never items plus their own chunks', () => {
    const status = fixtureStatus();
    const drive = status.corpora.find((corpus) => corpus.corpus_id === 'internal.drive.docs');
    if (!drive || !('counts' in drive) || !drive.counts) throw new Error('fixture missing drive corpus');
    drive.counts = {
      ...drive.counts,
      indexed_items: 250,
      files_with_text: 250,
      internal_chunks: 250,
    };
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      apiKeyAvailability: { venice: true, readwise: true },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const card = view.sources.find((source) => source.label === 'Google Drive');
    expect(card?.coverage.indexed_items).toBe(250);
    expect(card?.coverage.content_ready_items).toBe(250);
  });

  // This test used to assert the opposite — that chunks stand in for a missing
  // with-text count — and that fallback is what let a corpus of 100k files with
  // 20k of them extracted report itself fully answer-ready: the chunks of the
  // read fifth outnumber the files, so min(items, chunks) reaches the item
  // count. A chunk count is evidence about text, never about how many ITEMS are
  // readable, and the one headline percentage means fully-working over the
  // files Olympus is supposed to handle.
  test('content-ready is not inferred from chunk counts when no with-text count exists', () => {
    const status = fixtureStatus();
    const drive = status.corpora.find((corpus) => corpus.corpus_id === 'internal.drive.docs');
    if (!drive || !('counts' in drive) || !drive.counts) throw new Error('fixture missing drive corpus');
    const counts: Record<string, number> = { ...drive.counts, indexed_items: 30, internal_chunks: 90, chunks: 90 };
    delete counts.items_with_text;
    delete counts.files_with_text;
    drive.counts = counts as unknown as NonNullable<typeof drive.counts>;
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      apiKeyAvailability: { venice: true, readwise: true },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const card = view.sources.find((source) => source.label === 'Google Drive');
    expect(card?.coverage.content_ready_items).toBe(0);
    expect(card?.ingestion_health.coverage_percent).toBe(0);
  });

  test('content-ready reads the connector store\'s own per-item with-text count', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: googleConnectorStoreFixtureStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: googleHandleRegistry(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(view.sources.find((source) => source.source_id === 'gmail.email')).toMatchObject({
      coverage: { indexed_items: 18, content_ready_items: 18 },
      tier_composition: [
        { trust_domain: 'internal', indexed_items: 17, content_ready_items: 17 },
        { trust_domain: 'secure_local', indexed_items: 1, content_ready_items: 1 },
      ],
    });
    expect(view.sources.find((source) => source.source_id === 'google_drive.docs')).toMatchObject({
      coverage: { indexed_items: 1, content_ready_items: 1 },
      tier_composition: [
        { trust_domain: 'internal', indexed_items: 1, content_ready_items: 1 },
        { trust_domain: 'secure_local', indexed_items: 0, content_ready_items: 0 },
      ],
    });
  });

  test('builds friend-facing cards from source status and scheduler feeds', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      apiKeyAvailability: { venice: true, readwise: true },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(view.summary).toMatchObject({
      configured_sources: 7,
      connected_sources: 3,
      answer_ready_sources: 1,
      needs_attention_sources: 1,
      total_indexed_items: 50,
      total_content_ready_items: 40,
    });
    expect(view.sources.map((source) => source.label)).toEqual([
      'Gmail',
      'Google Drive',
      'Dropbox',
      'X bookmarks',
      'Telegram',
      'WhatsApp',
      'Readwise',
    ]);
    expect(view.sources.find((source) => source.source_id === 'gmail.email')).toMatchObject({
      connection: { state: 'synced', label: 'synced 1 hour ago' },
      queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
      answer_readiness: { state: 'ready', label: 'Ready for questions' },
    });
    expect(view.sources.find((source) => source.source_id === 'google_drive.docs')).toMatchObject({
      connection: { state: 'reauth_required', label: 'reauth required' },
      // The ACTION verb became Reauthenticate; this readiness sentence is a
      // different string and the view model still writes it as it was.
      answer_readiness: { state: 'needs_attention', label: 'Reauthenticate this source' },
    });
    expect(view.sources.find((source) => source.source_id === 'dropbox.files')).toMatchObject({
      // The app-key requirement is the setup row's blurb, not a status word.
      connection: { state: 'needs_setup', label: 'not connected' },
    });
    expect(view.answer_lanes.find((lane) => lane.source_id === 'venice.api')).toMatchObject({
      label: 'Venice',
      role: 'Approved encrypted-cloud lane for secure answers.',
      connection: { state: 'validated', label: 'key present + validated' },
    });
    expect(view.onboarding.ask_first_question).toMatchObject({
      enabled: true,
      label: 'Ask your first question',
    });
    expect(view.where_your_data_lives.find((card) => card.trust_domain === 'internal')?.model_lanes)
      .toContain('Cloud · OpenClaw subscription');
  });

  test('flags embedding-lane credential degradation as a top-level alert and needs-attention source card', () => {
    const status = fixtureStatus();
    const disabledLane = {
      state: 'embedding_lane_disabled' as const,
      reason: 'embedding_provider_unavailable' as const,
      affected_credentials: ['Sovereignty embedding profile "gemini-internal"'],
      affected_profiles: ['gemini-internal'],
      affected_capabilities: ['embedding'],
      hint: 'Fix the affected credential, POST /v1/source/credentials/recheck, then restart the worker if needed.',
    };
    status.embedding_lane = disabledLane;
    status.degraded_credentials = [{
      kind: 'worker_credential_degraded',
      display_name: 'Sovereignty embedding profile "gemini-internal"',
      state: 'stopped',
      status_label: 'Credential unavailable - needs your attention',
      hint: 'Unlock or reconnect this credential, then restart the Olympus worker or run the credential re-check route.',
      attempts: 3,
      max_attempts: 3,
      affected_profiles: ['gemini-internal'],
      affected_capabilities: ['embedding'],
    }];
    const gmail = status.corpora.find((corpus) => corpus.corpus_id === 'internal.email');
    if (!gmail) throw new Error('Missing Gmail fixture corpus');
    gmail.embedding_lane = disabledLane;

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(view.degraded_credentials).toHaveLength(1);
    expect(view.sources.find((source) => source.source_id === 'gmail.email')).toMatchObject({
      answer_readiness: { state: 'needs_attention', label: 'Embedding lane needs attention' },
    });
    expect(view.summary.needs_attention_sources).toBeGreaterThanOrEqual(1);
  });

  test('marks Dropbox as needs-attention when actionable extraction throughput is stalled', () => {
    const now = new Date('2026-07-16T12:00:00.000Z');
    const status = fixtureStatus();
    status.corpora.push({
      corpus_id: 'secure_local.dropbox.files',
      family: 'file',
      trust_domain: 'secure_local',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'local_only',
      configured: true,
      provider: 'dropbox',
      read_authority: 'connector_store',
      counts: {
        indexed_items: 200,
        tombstoned_items: 0,
        chunks: 100,
        embedded_chunks: 100,
        sync_runs: 1,
        extraction_jobs_queued: 171,
        extraction_jobs_queued_actionable: 171,
        extraction_jobs_failed: 0,
        extraction_jobs_failed_actionable: 0,
      },
      content_extraction_throughput: {
        actionable_queued: 171,
        actionable_retryable_due: 0,
        oldest_actionable_at: '2026-07-14T14:00:00.000Z',
        newest_terminal_progress_at: '2026-07-14T14:00:00.000Z',
      },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
    } as SourceIndexStatusResult['corpora'][number]);
    const registry = fixtureHandleRegistry();
    registry.handles.push({
      handle: 'dropbox.personal',
      provider: 'dropbox',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read'],
      connectedAt: '2026-07-02T10:00:00.000Z',
    });
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      ingestionLedger: buildSourceIngestionLedgerSnapshot(status, { now, safeForCastor: true }),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: registry,
      now,
    });

    expect(view.sources.find((source) => source.source_id === 'dropbox.files')).toMatchObject({
      queue_health: { label: 'Needs attention', waiting: 171, needs_attention: 1 },
      answer_readiness: { state: 'needs_attention', label: 'Content extraction is stalled' },
      ingestion_health: {
        stuck_count: 171,
        label: expect.stringContaining('content extraction stalled for 1.9d'),
      },
    });
    expect(view.summary.needs_attention_sources).toBeGreaterThanOrEqual(1);
  });

  test('renders disconnected supported sources instead of hiding them', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const serialized = JSON.stringify(view);

    expect(view.sources.find((source) => source.provider === 'dropbox')).toMatchObject({
      connection: {
        state: 'needs_setup',
        label: 'not connected',
        action: {
          kind: 'needs_setup',
          source: 'dropbox',
        },
      },
    });
    expect(serialized).toContain('dropbox');
    expect(serialized).not.toContain('personal.oauth');
  });

  test('uses source-owned OAuth clients except for Google-family sharing', () => {
    const noBorrow = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      oauthClientIds: { google: 'google-client-id-fixture' },
      oauthClientSecretAvailability: { google: true },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(noBorrow.sources.find((source) => source.source_id === 'dropbox.files')?.connection).toMatchObject({
      state: 'needs_setup',
      action: { kind: 'needs_setup', source: 'dropbox' },
    });
    expect(noBorrow.sources.find((source) => source.source_id === 'x.bookmarks')?.connection).toMatchObject({
      state: 'needs_setup',
      action: { kind: 'needs_setup', source: 'x' },
    });

    const googleShare = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      oauthClientIds: { gmail: 'gmail-client-id-fixture' },
      oauthClientSecretAvailability: { gmail: true },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(googleShare.sources.find((source) => source.source_id === 'google_drive.docs')?.connection.action).toMatchObject({
      kind: 'oauth',
      source: 'google-drive',
      known_client_id: 'gmail-client-id-fixture',
    });
  });

  test('shows the exact redirect URI for every OAuth source, on the path the start route uses', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      oauthRedirectBaseUrl: 'http://127.0.0.1:17777',
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(view.sources.find((source) => source.source_id === 'dropbox.files')?.connection.action).toMatchObject({
      kind: 'needs_setup',
      source: 'dropbox',
      redirect_uri_to_register: 'http://127.0.0.1:17777/oauth/callback/dropbox',
    });
    expect(view.sources.find((source) => source.source_id === 'x.bookmarks')?.connection.action).toMatchObject({
      kind: 'needs_setup',
      source: 'x',
      redirect_uri_to_register: 'http://127.0.0.1:17777/oauth/callback/x',
    });
    // The two Google cards were excluded here while the instructions assumed a
    // Desktop-app client. Their callback paths are the source values their own
    // connect actions emit — never the shared `google` key.
    expect(view.sources.find((source) => source.source_id === 'gmail.email')?.connection.action).toMatchObject({
      redirect_uri_to_register: 'http://127.0.0.1:17777/oauth/callback/gmail',
    });
    expect(view.sources.find((source) => source.source_id === 'google_drive.docs')?.connection.action).toMatchObject({
      redirect_uri_to_register: 'http://127.0.0.1:17777/oauth/callback/google-drive',
    });
  });

  test('renders the first-question CTA only after a source is answer-ready', () => {
    const notReady = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const ready = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(notReady.summary.answer_ready_sources).toBe(0);
    // The copy affordance waits, but the card that explains the wait does not.
    expect(ready.summary.answer_ready_sources).toBe(1);
  });

  test('hides the first-question CTA when the only ready source has no content-ready items', () => {
    const status = fixtureStatus();
    status.corpora = [{
      corpus_id: READWISE_LIBRARY_CORPUS_ID,
      family: 'readwise',
      trust_domain: 'internal',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'cloud_allowed',
      configured: true,
      provider: 'readwise',
      sensitivity: 'S1',
      counts: {
        embedded_chunks: 1,
      },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'readwise_item_metadata_not_requested',
    } as never];

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      apiKeyAvailability: { readwise: true },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(view.summary.answer_ready_sources).toBe(1);
    expect(view.summary.total_content_ready_items).toBe(0);
    expect(view.onboarding.ask_first_question.enabled).toBe(false);
  });

  test('dashboard launch query token never embeds the configured worker bearer token in HTML', async () => {
    const workerBearerToken = 'dashboard-secret-query-token-must-not-leak';
    const worker = createEmailSourceWorker({
      sourceIndexStatus: {
        async status() {
          return fixtureStatus();
        },
      },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        history: inMemoryHistory(),
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: workerBearerToken });
    const dashboardToken = dashboardQueryTokenFromWorkerAuthToken(workerBearerToken);

    const response = await fetch(new Request(`http://worker.test/dashboard?token=${dashboardToken}`));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain(workerBearerToken);
    expect(html).not.toContain('bootstrapWorkerToken');
    // The served page keeps the bearer token out of the document: controls
    // exchange it for a short-lived HttpOnly session, keep only the CSRF token
    // in memory, and refuse the read-only dash_ token by name.
    expect(html).toContain("fetch('/dashboard/control/session'");
    expect(html).toContain("'X-Olympus-CSRF': csrfToken");
    expect(html).not.toContain('localStorage');
    expect(html).not.toContain('sessionStorage');
    expect(html).toContain('That is the read-only view token; use the worker bearer token from setup.');
    // The token gate is on the setup page only (owner ruling, 2026-09-01).
    expect(html).not.toContain('data-dashboard-control-gate');
    expect(html).not.toContain('name="worker_token"');
    const setupResponse = await fetch(new Request(`http://worker.test/dashboard?token=${dashboardToken}&setup`));
    const setupHtml = await setupResponse.text();
    expect(setupResponse.status).toBe(200);
    expect(setupHtml).not.toContain(workerBearerToken);
    expect(setupHtml).toContain('id="dashboard-controls"');
    expect(setupHtml).toContain('Input token');
    // The field has no name, so a scriptless submit carries no token; the form
    // POSTs to the session route rather than putting a bearer in a URL.
    expect(setupHtml).toContain('data-dashboard-control-token');
    expect(setupHtml).not.toContain('name="worker_token"');
    expect(setupHtml).toContain('method="post" action="/dashboard/control/session"');
    expect(setupHtml).not.toContain('localStorage');
    expect(setupHtml).not.toContain('sessionStorage');
  });

  test('the query-addressed pages stay reachable with only the read-only dash_ token', async () => {
    // isDashboardQueryTokenRequest allowlists by pathname, which is why
    // detail/setup/background are ?source=/?setup/?background rather than
    // paths of their own. A future move to /dashboard/<id> would 401 exactly
    // the reader these pages exist for — this pins the whole reason.
    const workerBearerToken = 'dashboard-secret-query-token-must-not-leak';
    const worker = createEmailSourceWorker({
      sourceIndexStatus: {
        async status() {
          return fixtureStatus();
        },
      },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        history: inMemoryHistory(),
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: workerBearerToken });
    const dashboardToken = dashboardQueryTokenFromWorkerAuthToken(workerBearerToken);

    const detail = await fetch(new Request(`http://worker.test/dashboard?token=${dashboardToken}&source=gmail.email`));
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain('<span class="crumb">/</span> Gmail');
    // Internal links keep carrying the token the reader arrived with.
    expect(detailHtml).toContain(`href="/dashboard?token=${dashboardToken}"`);

    const setup = await fetch(new Request(`http://worker.test/dashboard?token=${dashboardToken}&setup`));
    expect(setup.status).toBe(200);
    expect(await setup.text()).toContain('Build a connector');

    const background = await fetch(new Request(`http://worker.test/dashboard?token=${dashboardToken}&background`));
    expect(background.status).toBe(200);
    expect(await background.text()).toContain('<span class="crumb">/</span> Background');
  });

  test('matches connected handles by source provider rather than owner-specific handle ids', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: {
        version: 1,
        handles: [gmailHandle('gmail.operator_chosen')],
      },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const gmail = view.sources.find((source) => source.source_id === 'gmail.email');
    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files');

    expect(gmail).toMatchObject({
      connection: {
        state: 'synced',
        handles: ['gmail.operator_chosen'],
      },
    });
    expect(dropbox).toMatchObject({
      connection: { state: 'needs_setup', handles: [] },
    });
  });

  test('renders reauth with missing OAuth client as reconnect, not first-time setup', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: {
        version: 1,
        handles: [{
          handle: 'dropbox.personal',
          provider: 'dropbox',
          accountRole: 'personal',
          trustDomain: 'internal',
          allowedCapabilities: ['dropbox.files.sync'],
          scopes: ['files.metadata.read'],
          backendState: { kind: 'oauth2_refresh', status: 'reauth_required' },
          connectedAt: '2026-07-02T10:00:00.000Z',
        }],
      },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files');
    expect(dropbox?.connection.state).toBe('reauth_required');
    expect(dropbox?.connection.label).toBe('reauth required');
    expect(dropbox?.connection.action.kind).toBe('needs_setup');
    if (dropbox?.connection.action.kind !== 'needs_setup') throw new Error('expected Dropbox setup action');
    expect(dropbox.connection.action.source).toBe('dropbox');
  });

  test('uses proactive probe failures for connection state and degraded credential alerts', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      credentialHealth: {
        kind: 'credential_health_report',
        version: 1,
        generated_at: '2026-08-18T12:00:00.000Z',
        results: [
          {
            handle: 'dropbox.personal', provider: 'dropbox', source_ids: ['dropbox.files'],
            credential_type: 'oauth2_refresh', status: 'reauth_required',
            checked_at: '2026-08-18T12:00:00.000Z', reason: 'credential_reauth_required',
          },
          {
            handle: 'readwise.personal', provider: 'readwise', source_ids: ['readwise.library'],
            credential_type: 'static_api_key', status: 'degraded',
            checked_at: '2026-08-18T12:00:00.000Z', reason: 'probe_unavailable',
          },
        ],
        policy: {
          counts_only: true, raw_source_exposed: false, secrets_exposed: false,
          x_refresh_forced: false, op_cached_read_only: true,
        },
      },
      now: new Date('2026-08-18T12:01:00.000Z'),
    });

    expect(view.sources.find((source) => source.source_id === 'dropbox.files')?.connection.state)
      .toBe('reauth_required');
    expect(view.degraded_credentials?.some((item) =>
      item.affected_profiles?.includes('readwise.library'))).toBe(true);
  });

  test('stops driving connection state from a stale probe report and reports the staleness instead', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      credentialHealth: {
        kind: 'credential_health_report',
        version: 1,
        generated_at: '2026-08-17T05:00:00.000Z',
        results: [
          {
            handle: 'dropbox.personal', provider: 'dropbox', source_ids: ['dropbox.files'],
            credential_type: 'oauth2_refresh', status: 'reauth_required',
            checked_at: '2026-08-17T05:00:00.000Z', reason: 'credential_reauth_required',
          },
        ],
        policy: {
          counts_only: true, raw_source_exposed: false, secrets_exposed: false,
          x_refresh_forced: false, op_cached_read_only: true,
        },
      },
      now: new Date('2026-08-18T12:01:00.000Z'),
    });

    expect(view.sources.find((source) => source.source_id === 'dropbox.files')?.connection.state)
      .not.toBe('reauth_required');
    expect(view.degraded_credentials?.map((item) => item.display_name))
      .toContain('Credential health: stale probe report');
  });

  test('stops driving connection state from a future-dated probe report', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      credentialHealth: {
        kind: 'credential_health_report',
        version: 1,
        generated_at: '2099-01-01T00:00:00.000Z',
        results: [
          {
            handle: 'dropbox.personal', provider: 'dropbox', source_ids: ['dropbox.files'],
            credential_type: 'oauth2_refresh', status: 'reauth_required',
            checked_at: '2099-01-01T00:00:00.000Z', reason: 'credential_reauth_required',
          },
        ],
        policy: {
          counts_only: true, raw_source_exposed: false, secrets_exposed: false,
          x_refresh_forced: false, op_cached_read_only: true,
        },
      },
      now: new Date('2026-08-18T12:01:00.000Z'),
    });

    expect(view.sources.find((source) => source.source_id === 'dropbox.files')?.connection.state)
      .not.toBe('reauth_required');
    expect(view.degraded_credentials?.map((item) => item.display_name))
      .toContain('Credential health: stale probe report');
  });

  test('reports an unreadable credential cache as degradation rather than a reconnect demand', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      credentialHealth: {
        kind: 'credential_health_report',
        version: 1,
        generated_at: '2026-08-18T12:00:00.000Z',
        results: [
          {
            handle: 'dropbox.personal', provider: 'dropbox', source_ids: ['dropbox.files'],
            credential_type: 'oauth2_refresh', status: 'degraded', probe_mode: 'passive',
            checked_at: '2026-08-18T12:00:00.000Z', reason: 'credential_cache_unavailable',
          },
        ],
        policy: {
          counts_only: true, raw_source_exposed: false, secrets_exposed: false,
          x_refresh_forced: false, op_cached_read_only: true,
        },
      },
      now: new Date('2026-08-18T12:01:00.000Z'),
    });

    expect(view.sources.find((source) => source.source_id === 'dropbox.files')?.connection.state)
      .not.toBe('reauth_required');
    expect(view.degraded_credentials?.some((item) => item.state === 'retrying'
      && item.display_name === 'Credential health: dropbox.personal')).toBe(true);
  });
  test('renders partial Google reauth even when another handle is still connected', () => {
    const staleGmailHandle = gmailHandle('gmail.previous');
    staleGmailHandle.backendState = { kind: 'oauth2_refresh', status: 'reauth_required' };
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: {
        version: 1,
        handles: [
          gmailHandle('gmail.personal'),
          staleGmailHandle,
          {
            handle: 'google_drive.personal',
            provider: 'google_drive',
            accountRole: 'personal',
            trustDomain: 'internal',
            allowedCapabilities: ['google_drive.docs.sync'],
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
            connectedAt: '2026-07-02T10:00:00.000Z',
          },
        ],
      },
      oauthClientIds: { gmail: 'gmail-client-id' },
      oauthClientSecretAvailability: { gmail: true },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    const gmail = view.sources.find((source) => source.source_id === 'gmail.email');
    expect(gmail?.connection.state).toBe('reauth_required');
    expect(gmail?.connection.label).toBe('reauth required');
    expect(gmail?.connection.action.kind).toBe('oauth');
    if (gmail?.connection.action.kind !== 'oauth') throw new Error('expected Gmail OAuth action');
    expect(gmail.connection.action.source).toBe('gmail');
    expect(gmail.connection.action.label).toBe('Reauthenticate');
  });

  test('pending OAuth attempts render awaiting-consent and expire back to disconnected', () => {
    const active = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      oauthClientIds: { dropbox: 'dropbox-client-id' },
      pendingConnects: [{
        source: 'dropbox',
        started_at: '2026-07-02T11:59:00.000Z',
        expires_at: '2026-07-02T12:09:00.000Z',
      }],
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const expired = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      oauthClientIds: { dropbox: 'dropbox-client-id' },
      pendingConnects: [{
        source: 'dropbox',
        started_at: '2026-07-02T11:30:00.000Z',
        expires_at: '2026-07-02T11:40:00.000Z',
      }],
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(active.sources.find((source) => source.source_id === 'dropbox.files')).toMatchObject({
      connection: {
        state: 'awaiting_consent',
        label: 'awaiting browser consent',
        pending: {
          started_at: '2026-07-02T11:59:00.000Z',
          expires_at: '2026-07-02T12:09:00.000Z',
        },
      },
    });
    expect(expired.sources.find((source) => source.source_id === 'dropbox.files')).toMatchObject({
      connection: { state: 'not_connected', label: 'not connected' },
    });
  });

  test('does not pass raw content, file names, paths, or scheduler jargon into payloads', () => {
    const status = fixtureStatus();
    (status.corpora[1] as any).items = [{
      title: 'Budget.xlsx',
      path_display: '/Private/Budget.xlsx',
      source_url: 'https://docs.example/private',
      sanitized_text: 'raw private content',
    }];
    (status.corpora[1] as any).counts = {
      indexed_items: 7,
      internal_chunks: 4,
      extraction_jobs_queued: 2,
      extraction_jobs_leased: 1,
      qa_metadata_only_gap: 3,
    };
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const serialized = JSON.stringify(view);

    expect(serialized).not.toContain('Budget.xlsx');
    expect(serialized).not.toContain('/Private');
    expect(serialized).not.toContain('raw private content');
    expect(serialized).not.toContain('path_display');
    expect(serialized).not.toContain('leased');
    expect(serialized).not.toContain('qa_');
    expect(view.policy).toMatchObject({
      counts_only: true,
      raw_source_exposed: false,
      file_names_returned: false,
      file_paths_returned: false,
    });
  });

  test('dashboard ingestion-health card is castor-safe counts and ages only', () => {
    const status = fixtureStatus();
    (status.corpora[1] as any).items = [{
      title: 'Sensitive queued file.pdf',
      path_display: '/Private/Sensitive queued file.pdf',
      sanitized_text: 'private queued content',
    }];
    const now = new Date('2026-07-09T12:00:00.000Z');
    const ingestionLedger = buildSourceIngestionLedgerSnapshot(status, {
      now,
      safeForCastor: true,
      dropboxFailureBreakdown: [{
        status: 'queued',
        extractor_kind: 'local_text_pdf',
        count: 4,
        oldest_created_at: '2026-07-08T06:00:00.000Z',
        newest_updated_at: '2026-07-09T10:00:00.000Z',
      }],
    });
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      ingestionLedger,
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      now,
    });
    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files');
    const serialized = JSON.stringify(view);

    expect(dropbox?.ingestion_health).toMatchObject({
      coverage_percent: expect.any(Number),
      stuck_count: 4,
      oldest_stuck_age_hours: 30,
      last_drain_activity_hours: 2,
    });
    expect(serialized).not.toContain('Sensitive queued file.pdf');
    expect(serialized).not.toContain('/Private');
    expect(serialized).not.toContain('private queued content');
    expect(serialized).not.toContain('path_display');
  });

  test('uses durable local history for throughput and ETA across snapshots', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      buildSourceDashboardViewModel({
        sourceIndexStatus: statusWithInternalEmailCount(10, 10),
        schedulerStatus: schedulerWithQueue(20),
        sovereigntyEngine: fixtureSovereigntyEngine(),
        history,
        now: new Date('2026-07-02T10:00:00.000Z'),
      });
      const view = buildSourceDashboardViewModel({
        sourceIndexStatus: statusWithInternalEmailCount(40, 40),
        schedulerStatus: schedulerWithQueue(30),
        sovereigntyEngine: fixtureSovereigntyEngine(),
        history,
        now: new Date('2026-07-02T11:00:00.000Z'),
      });

      expect(view.history).toMatchObject({ sample_count: 14, eta_available: true });
      expect(view.sources[0]?.progress).toEqual({
        indexed_items_per_hour: 30,
        eta_minutes: 60,
      });
    } finally {
      history.close();
    }
  });

  test('worker dashboard route is bearer-token gated and returns the fixture view', async () => {
    const worker = createEmailSourceWorker({
      sourceIndexStatus: {
        async status(request) {
          expect(request).toEqual({
            include_items: false,
            include_readiness_ledger: true,
            readiness_ledger_max_age_ms: DASHBOARD_READINESS_LEDGER_MAX_AGE_MS,
          });
          return fixtureStatus();
        },
      },
      sourceScheduler: {
        status: () => fixtureScheduler(),
      } as never,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        history: inMemoryHistory(),
        registryPath: '/tmp/olympus-source-dashboard-test-missing-handles.json',
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const missing = await fetch(new Request('http://worker.test/dashboard'));
    expect(missing.status).toBe(401);

    const wrongAuthCheck = await fetch(new Request('http://worker.test/dashboard/auth-check', {
      headers: { Authorization: 'Bearer wrong-secret' },
    }));
    expect(wrongAuthCheck.status).toBe(401);

    const dashboardQueryToken = dashboardQueryTokenFromWorkerAuthToken('dashboard-secret');
    const queryAuthCheck = await fetch(new Request(`http://worker.test/dashboard/auth-check?token=${dashboardQueryToken}`));
    expect(queryAuthCheck.status).toBe(401);

    const authCheck = await fetch(new Request('http://worker.test/dashboard/auth-check', {
      headers: { Authorization: 'Bearer dashboard-secret' },
    }));
    await expect(authCheck.json()).resolves.toEqual({ ok: true });
    expect(authCheck.status).toBe(200);

    const response = await fetch(new Request('http://worker.test/dashboard.json', {
      headers: { Authorization: 'Bearer dashboard-secret' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.kind).toBe('source_dashboard');
    expect(body.sources).toHaveLength(7);
    expect(body.sources.some((source: { source_id: string }) => source.source_id === 'venice.api')).toBe(false);
    expect(body.answer_lanes).toEqual([
      expect.objectContaining({
        source_id: 'venice.api',
        role: 'Approved encrypted-cloud lane for secure answers.',
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain('raw private content');
  });

  test('worker dashboard reads connected handle registry fresh on every render', async () => {
    const registryPath = join(mkdtempSync(join(tmpdir(), 'olympus-dashboard-handles-')), 'handles.json');
    const worker = createEmailSourceWorker({
      sourceIndexStatus: {
        async status(request) {
          expect(request).toEqual({
            include_items: false,
            include_readiness_ledger: true,
            readiness_ledger_max_age_ms: DASHBOARD_READINESS_LEDGER_MAX_AGE_MS,
          });
          return fixtureStatus();
        },
      },
      sourceScheduler: {
        status: () => fixtureScheduler(),
      } as never,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        history: inMemoryHistory(),
        registryPath,
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const before = await fetch(new Request('http://worker.test/dashboard.json', {
      headers: { Authorization: 'Bearer dashboard-secret' },
    }));
    const beforeBody = await before.json();
    expect(sourceState(beforeBody, 'gmail.email')).toBe('needs_setup');

    writeConnectedHandleRegistry({
      version: 1,
      handles: [gmailHandle('gmail.personal')],
    }, registryPath);

    const after = await fetch(new Request('http://worker.test/dashboard.json', {
      headers: { Authorization: 'Bearer dashboard-secret' },
    }));
    const afterBody = await after.json();
    const gmail = afterBody.sources.find((source: { source_id: string }) => source.source_id === 'gmail.email');

    expect(after.status).toBe(200);
    expect(gmail).toMatchObject({
      connection: {
        state: 'synced',
        handles: ['gmail.personal'],
      },
    });
  });

  test('status derivation covers waiting, syncing, synced, reauth, and disconnected', () => {
    const status = fixtureStatus();
    status.corpora.push({
      corpus_id: 'internal.x.bookmarks',
      family: 'x',
      trust_domain: 'internal',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'cloud_allowed_by_policy',
      configured: true,
      provider: 'x',
      counts: {
        indexed_items: 2,
        jobs_queued: 3,
      },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'item_metadata_not_requested',
    } as never);
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      oauthClientIds: { dropbox: 'dropbox-client-id' },
      apiKeyAvailability: { venice: true },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(sourceState(view, 'gmail.email')).toBe('synced');
    expect(sourceState(view, 'google_drive.docs')).toBe('reauth_required');
    expect(sourceState(view, 'dropbox.files')).toBe('not_connected');
    expect(sourceState(view, 'x.bookmarks')).toBe('syncing');
    expect(answerLaneState(view, 'venice-secure-answers')).toBe('validated');
  });

  test('connected zero-item corpus source waits for first sync instead of reporting synced', () => {
    const status = fixtureStatus();
    const readwise = status.corpora.find((corpus) => corpus.corpus_id === READWISE_LIBRARY_CORPUS_ID);
    if (!readwise) throw new Error('fixture missing Readwise corpus');
    readwise.configured = true;
    (readwise as any).counts = {
      sync_runs: 1,
      indexed_items: 0,
      items_with_text: 0,
      internal_chunks: 0,
    };
    const registry = fixtureHandleRegistry();
    registry.handles.push({
      handle: 'readwise.personal',
      provider: 'readwise',
      accountRole: 'personal',
      trustDomain: 'internal',
      allowedCapabilities: ['readwise.sync'],
      scopes: ['readwise.export:read', 'readwise.reader:read'],
      connectedAt: '2026-07-02T10:00:00.000Z',
    });

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: registry,
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(view.sources.find((source) => source.source_id === 'readwise.library')).toMatchObject({
      connection: { state: 'waiting_for_first_sync', label: 'connected, waiting for first sync' },
      answer_readiness: { state: 'empty', label: 'Waiting for the first sync' },
    });
  });

  test('bearer-authenticated dashboard control functions remain reachable and avoid echoing submitted secrets', async () => {
    let storedApiKey = '';
    const secretStore = memorySecretStore();
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        secretStore,
        connectApiKey: async (options) => {
          storedApiKey = options.apiKey;
          return {
            ok: true,
            source: options.source,
            handles: ['readwise.personal'],
            registryPath: '/tmp/handles.json',
            secretRefs: ['store:readwise.personal.token'],
          };
        },
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const missing = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ source: 'dropbox', client_id: 'client-id' }),
    }));
    expect(missing.status).toBe(401);

    const dashboardQueryToken = dashboardQueryTokenFromWorkerAuthToken('dashboard-secret');
    const queryToken = await fetch(new Request(`http://worker.test/dashboard/connect/api-key?token=${dashboardQueryToken}`, {
      method: 'POST',
      body: JSON.stringify({ source: 'readwise', api_key: 'readwise-api-key-fixture' }),
    }));
    expect(queryToken.status).toBe(401);

    const oauth = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'dropbox',
        client_id: 'oauth-client-id-fixture',
        client_secret: 'oauth-client-secret-fixture',
      }),
    }));
    const oauthText = await oauth.text();
    expect(oauth.status).toBe(200);
    expect(oauthText).toContain('authorization_url');
    expect(oauthText).not.toContain('oauth-client-secret-fixture');

    const apiKey = await fetch(new Request('http://worker.test/dashboard/connect/api-key', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'readwise',
        api_key: 'readwise-api-key-fixture',
      }),
    }));
    const apiKeyText = await apiKey.text();
    expect(apiKey.status).toBe(200);
    expect(storedApiKey).toBe('readwise-api-key-fixture');
    expect(apiKeyText).not.toContain('readwise-api-key-fixture');
  });

  test('Readwise API-key connect kicks first sync without restarting the worker', async () => {
    const syncRequests: unknown[] = [];
    const worker = createEmailSourceWorker({
      readwiseConnectorStoreSync: readwiseStoreSyncFixture(syncRequests),
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        connectApiKey: async (options) => ({
          ok: true,
          source: options.source,
          handles: ['readwise.personal'],
          registryPath: '/tmp/handles.json',
          secretRefs: ['store:readwise.personal.token'],
        }),
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const response = await fetch(new Request('http://worker.test/dashboard/connect/api-key', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'readwise',
        api_key: 'readwise-api-key-fixture',
      }),
    }));

    expect(response.status).toBe(200);
    expect(syncRequests).toEqual([{ mode: 'sync' }]);
  });

  test('Readwise API-key connect refreshes scheduler sources and enqueues first sync without restarting the worker', async () => {
    const syncRequests: unknown[] = [];
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-07-07T12:00:00.000Z'),
      sources: [],
    });
    const worker = createEmailSourceWorker({
      sourceScheduler: scheduler,
      readwiseConnectorStoreSync: readwiseStoreSyncFixture(syncRequests),
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        connectApiKey: async (options) => ({
          ok: true,
          source: options.source,
          handles: ['readwise.personal'],
          registryPath: '/tmp/handles.json',
          secretRefs: ['store:readwise.personal.token'],
        }),
        // No adoption tick in this suite: it does not exercise registry
        // adoption, and an unclosed worker would leave one ticking.
        registryAdoptionIntervalMs: 0,
        refreshSchedulerSources: () => [
          createReadwiseSchedulerSource({
            config: schedulerConfig(),
            liveSync: readwiseStoreSyncFixture(syncRequests),
          })!,
        ],
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const response = await fetch(new Request('http://worker.test/dashboard/connect/api-key', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'readwise',
        api_key: 'readwise-api-key-fixture',
      }),
    }));

    expect(response.status).toBe(200);
    expect(syncRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'pull' }),
      expect.objectContaining({ mode: 'reconcile' }),
    ]));
    expect(scheduler.status().sources).toEqual([
      expect.objectContaining({
        source_id: 'readwise.library',
        corpus_id: READWISE_LIBRARY_CORPUS_ID,
      }),
    ]);
  });

  test('Gmail OAuth connect refreshes scheduler sources and syncs without restarting an empty worker', async () => {
    const registryPath = join(mkdtempSync(join(tmpdir(), 'olympus-dashboard-gmail-connect-running-')), 'handles.json');
    const syncRequests: unknown[] = [];
    const fallbackSyncRequests: unknown[] = [];
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-07-09T12:00:00.000Z'),
      sources: [],
    });
    const secretStore = memorySecretStore({
      'gmail.personal.oauth.client_id': 'gmail-client-id-fixture',
    });
    const oauthFetch: OAuthFetch = async (_url, init) => {
      expect(String(init?.body ?? '')).toContain('code=gmail-code-fixture');
      return new Response(JSON.stringify({
        access_token: 'gmail-access-token-fixture',
        refresh_token: 'gmail-refresh-token-fixture',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const worker = createEmailSourceWorker({
      sourceIndexStatus: {
        async status(request) {
          expect(request).toEqual({
            include_items: false,
            include_readiness_ledger: true,
            readiness_ledger_max_age_ms: DASHBOARD_READINESS_LEDGER_MAX_AGE_MS,
          });
          return fixtureStatus();
        },
      },
      sourceScheduler: scheduler,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore,
        oauthFetch,
        // No adoption tick in this suite: it does not exercise registry
        // adoption, and an unclosed worker would leave one ticking.
        registryAdoptionIntervalMs: 0,
        refreshSchedulerSources: () => {
          const handle = readConnectedHandleRegistry(registryPath).handles.find((candidate) =>
            candidate.provider === 'gmail'
            && candidate.allowedCapabilities.includes('gmail.email.sync')
          );
          if (!handle) return [];
          return [
            createGmailConnectorStoreSchedulerSource({
              config: schedulerConfig(),
              sync: gmailSyncFixture(syncRequests, handle.handle),
            })!,
          ];
        },
        async triggerSourceSync(request) {
          fallbackSyncRequests.push(request);
          throw new Error('fallback trigger should not run once Gmail scheduler materializes');
        },
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });
    const dashboardToken = dashboardQueryTokenFromWorkerAuthToken('dashboard-secret');

    expect(scheduler.status().sources).toHaveLength(0);

    const start = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'gmail',
        client_secret: 'gmail-client-secret-fixture',
        return_to: `http://worker.test/dashboard?token=${dashboardToken}`,
      }),
    }));
    const payload = await start.json();
    const state = new URL(payload.authorization_url).searchParams.get('state');
    expect(start.status).toBe(200);
    expect(state).toBeTruthy();

    const redirect = await fetch(new Request(`http://worker.test/oauth/callback/gmail?code=gmail-code-fixture&state=${state}`));
    // A successful callback now redirects (303) to a query-free `/done` page
    // rather than rendering "Connected" directly at the code/state-bearing
    // URL (MINOR 2, Codex round 2 on 7863a735) — the redirect target carries
    // no query either, so it cannot carry the dash_ token any more than the
    // page it lands on can.
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get('Location')).toBe('/oauth/callback/gmail/done');
    const callback = await fetch(new Request(`http://worker.test${redirect.headers.get('Location')}`));
    // The authorization runs in its own tab, so the callback lands there and
    // says so instead of redirecting a second dashboard into that tab.
    expect(callback.status).toBe(200);
    expect(await callback.clone().text()).toContain('You can close this tab');
    // The link back carries NO query. `return_to` was this page's own
    // window.location.href, which on a read-only view holds the dash_ token —
    // and this page is unauthenticated HTML a provider redirect lands on.
    const completedHtml = await callback.clone().text();
    expect(completedHtml).toContain('href="/dashboard"');
    expect(completedHtml).not.toContain(dashboardToken);
    expect(completedHtml).not.toContain('token=');
    // Both store tasks are due on the first tick: the bounded pull carries the
    // host bound, the reconcile deliberately carries none.
    expect(syncRequests).toEqual([
      {
        handle: 'gmail.personal',
        task: 'pull',
        request: { attempted_at: expect.any(String), max_items: 200 },
      },
      {
        handle: 'gmail.personal',
        task: 'reconcile',
        request: { attempted_at: expect.any(String) },
      },
    ]);
    expect(fallbackSyncRequests).toEqual([]);
    expect(scheduler.status().sources).toEqual([
      expect.objectContaining({
        source_id: 'gmail.email',
        corpus_id: GMAIL_CONNECTOR_CORPUS_ID,
      }),
    ]);

    const landing = await fetch(new Request(`http://worker.test/dashboard?token=${dashboardToken}`));
    const landingHtml = await landing.text();
    expect(landing.status).toBe(200);
    // The landing page is the live dashboard: connected Gmail on a card, and
    // the control script that carries a later connect to the OAuth redirect.
    expect(landingHtml).toContain('Gmail');
    // The provider now opens in its own tab, so the dashboard survives the
    // round trip instead of being navigated away from it.
    // A tab pre-opened inside the submit gesture, then pointed at the
    // provider. window.open(..., 'noopener') returns null by spec even on
    // success, so it could never tell a blocked tab from an opened one.
    expect(landingHtml).toContain("window.open('', '_blank')");
    expect(landingHtml).toContain('authorizationTab.location = payload.authorization_url');
    expect(landingHtml).not.toContain('window.location.assign(payload.authorization_url)');
    expect(landingHtml).toContain('dashboard-poll-signature');

    const manual = await fetch(new Request('http://worker.test/dashboard/sync-now', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'gmail' }),
    }));
    const manualBody = await manual.json();

    expect(manual.status).toBe(200);
    expect(manualBody).toMatchObject({ ok: true, source: 'gmail' });
    // A manual sync-now runs the same two store tasks the scheduler runs, so
    // the connect tick and the manual tick each contribute a pull + reconcile.
    expect(syncRequests.map((entry) => (entry as { task: string }).task))
      .toEqual(['pull', 'reconcile', 'pull', 'reconcile']);
    expect(fallbackSyncRequests).toEqual([]);
  });

  test('Readwise API-key connect validates token and returns a plain card error', async () => {
    const registryPath = join(mkdtempSync(join(tmpdir(), 'olympus-dashboard-readwise-invalid-')), 'handles.json');
    const secretStore = memorySecretStore();
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore,
        apiKeyFetch: async () => new Response('', { status: 401 }),
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const response = await fetch(new Request('http://worker.test/dashboard/connect/api-key', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'readwise',
        api_key: 'bad-readwise-token-fixture',
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    // Fixed prose only: validator text is never relayed, because no redaction
    // of transformed key encodings is a complete guarantee (R61C).
    expect(body.error.message).toContain('Validating the readwise API key failed');
    expect(body.error.message).not.toContain('bad-readwise-token-fixture');
    expect(await secretStore.get('readwise.personal.token')).toBeUndefined();
  });

  test('Readwise API-key connect stores valid validated token and registers handle', async () => {
    const registryPath = join(mkdtempSync(join(tmpdir(), 'olympus-dashboard-readwise-valid-')), 'handles.json');
    const secretStore = memorySecretStore();
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore,
        apiKeyFetch: async () => new Response('', { status: 204 }),
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const response = await fetch(new Request('http://worker.test/dashboard/connect/api-key', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'readwise',
        api_key: 'good-readwise-token-fixture',
      }),
    }));
    const registry = readConnectedHandleRegistry(registryPath);

    expect(response.status).toBe(200);
    expect(await secretStore.get('readwise.personal.token')).toBe('good-readwise-token-fixture');
    expect(registry.handles[0]).toMatchObject({
      handle: 'readwise.personal',
      provider: 'readwise',
    });
  });

  test('Sync now route runs a source sync through the dashboard auth lane', async () => {
    const dashboardSyncRequests: unknown[] = [];
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        async triggerSourceSync(request) {
          dashboardSyncRequests.push(request);
          return { status: 'started', source: request.source };
        },
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const missing = await fetch(new Request('http://worker.test/dashboard/sync-now', {
      method: 'POST',
      body: JSON.stringify({ source: 'readwise' }),
    }));
    expect(missing.status).toBe(401);

    const unknown = await fetch(new Request('http://worker.test/dashboard/sync-now', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'unknown-source' }),
    }));
    const unknownText = await unknown.text();

    expect(unknown.status).toBe(400);
    expect(unknownText).toContain('source must be gmail, google-drive, dropbox, x, or readwise');

    const response = await fetch(new Request('http://worker.test/dashboard/sync-now', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'readwise' }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, source: 'readwise' });

    for (const source of ['gmail', 'google-drive']) {
      const googleResponse = await fetch(new Request('http://worker.test/dashboard/sync-now', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer dashboard-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source }),
      }));
      const googleBody = await googleResponse.json();

      expect(googleResponse.status).toBe(200);
      expect(googleBody).toMatchObject({ ok: true, source });
    }
    expect(dashboardSyncRequests).toEqual([
      { source: 'readwise', reason: 'manual' },
      { source: 'gmail', reason: 'manual' },
      { source: 'google-drive', reason: 'manual' },
    ]);
  });

  // The host's triggerSourceSync is ONE callback for every source, and the
  // product server wires it for Dropbox alone. When it was promoted ahead of
  // the connector-store fallbacks, Readwise and X sync-now stopped reaching
  // their own lanes and every remaining source answered 500 source_worker_error
  // — the hook's bare Error — instead of an honest "no lane here".
  test('Sync now dispatches to this worker\'s own lanes before a host hook, and says 501 when no lane serves the source', async () => {
    const readwiseRequests: unknown[] = [];
    const xRequests: Array<{ task: string; provenance?: string }> = [];
    const hookRequests: Array<{ source: string; reason: string }> = [];
    const worker = createEmailSourceWorker({
      readwiseConnectorStoreSync: readwiseStoreSyncFixture(readwiseRequests),
      xBookmarksConnectorStoreSync: xStoreSyncFixture(xRequests),
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        // The product server's hook, in miniature: it serves Dropbox and
        // declines everything else with the shared typed error.
        async triggerSourceSync(request) {
          hookRequests.push({ source: request.source, reason: request.reason });
          if (request.source !== 'dropbox') {
            throw dashboardSourceSyncNotSupportedError(request.source);
          }
          return { status: 'started', source: request.source };
        },
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });
    const syncNow = (source: string) => fetch(new Request('http://worker.test/dashboard/sync-now', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source }),
    }));

    const readwise = await syncNow('readwise');
    expect(readwise.status).toBe(200);
    expect(await readwise.json()).toMatchObject({ ok: true, source: 'readwise' });
    expect(readwiseRequests).toEqual([{ mode: 'sync' }]);
    expect(hookRequests).toEqual([]);

    const x = await syncNow('x');
    expect(x.status).toBe(200);
    expect(await x.json()).toMatchObject({ ok: true, source: 'x' });
    expect(xRequests).toEqual([{ task: 'reconcile', provenance: 'operator' }]);
    expect(hookRequests).toEqual([]);

    // Dropbox is why the hook exists at all: it is still reached, as the last
    // resort rather than the first.
    const dropbox = await syncNow('dropbox');
    expect(dropbox.status).toBe(200);
    expect(await dropbox.json()).toMatchObject({
      ok: true,
      source: 'dropbox',
      result: { status: 'started', source: 'dropbox' },
    });
    expect(hookRequests).toEqual([{ source: 'dropbox', reason: 'manual' }]);

    // Gmail here has no scheduler lane and no hook that serves it. That is a
    // missing capability, not a crash.
    const gmail = await syncNow('gmail');
    const gmailBody = await gmail.json();
    expect(gmail.status).toBe(501);
    expect(gmailBody.error.code).toBe('source_sync_not_supported');
    expect(gmailBody.error.message).toContain('gmail');
  });

  test('Sync now answers 501 rather than 500 when the worker has no dispatch path at all', async () => {
    const worker = createEmailSourceWorker({
      sourceDashboard: { sovereigntyEngine: fixtureSovereigntyEngine() },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const response = await fetch(new Request('http://worker.test/dashboard/sync-now', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'x' }),
    }));
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body.error.code).toBe('source_sync_not_supported');
  });

  // The product wiring is the surface the live 500 came from, and it cannot be
  // reached without booting main(), so the hook's refusal is pinned here.
  test('the product server dashboard sync hook declines unserved sources with the typed 501, not a bare Error', () => {
    const server = readFileSync(
      join(import.meta.dir, '..', 'src/workers/email-source/server.ts'),
      'utf8',
    );
    const hookStart = server.indexOf('triggerSourceSync: async (request) => {');
    expect(hookStart).toBeGreaterThanOrEqual(0);
    const hook = server.slice(hookStart, server.indexOf('createCanonicalDropboxSchedulerSource({', hookStart));
    expect(hook).toContain('throw dashboardSourceSyncNotSupportedError(request.source);');
    expect(hook).not.toMatch(/throw new Error\(`Source \$\{request\.source\}/);
  });

  test('dashboard Google OAuth start uses PKCE without requiring or retaining a client secret', async () => {
    const secretStore = memorySecretStore({
      'gmail.personal.oauth.client_id': 'gmail-client-id-fixture',
    });
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        secretStore,
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const secretless = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'gmail' }),
    }));
    const secretlessText = await secretless.text();
    expect(secretless.status).toBe(200);
    expect(secretlessText).toContain('authorization_url');
    expect(JSON.parse(secretlessText)).toMatchObject({
      policy: { raw_runtime_secrets_exposed: false, client_secret_returned: false },
    });

    const withSecret = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'gmail',
        client_secret: 'gmail-client-secret-fixture',
      }),
    }));
    const withSecretText = await withSecret.text();
    expect(withSecret.status).toBe(200);
    expect(withSecretText).toContain('authorization_url');
    expect(withSecretText).not.toContain('gmail-client-secret-fixture');
    expect(await secretStore.get('gmail.personal.oauth.client_secret')).toBeUndefined();
  });

  test('dashboard OAuth start prefers submitted client id over stored client id', async () => {
    const secretStore = memorySecretStore({
      'dropbox.personal.oauth.client_id': 'stored-dropbox-client-id-fixture',
    });
    let usedClientId = '';
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        secretStore,
        startExternalOAuthConnection: async (options) => {
          usedClientId = options.clientId;
          return {
            ok: true,
            source: options.source,
            authorizationUrl: 'https://www.dropbox.com/oauth2/authorize?state=state-fixture',
            redirectUri: options.redirectUri,
            state: 'state-fixture',
            startedAt: '2026-07-02T12:00:00.000Z',
            expiresAt: '2026-07-02T12:10:00.000Z',
            completeCallback: async () => {
              throw new Error('not used');
            },
            cancel() {},
          };
        },
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const response = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'dropbox',
        client_id: 'submitted-dropbox-client-id-fixture',
      }),
    }));

    expect(response.status).toBe(200);
    expect(usedClientId).toBe('submitted-dropbox-client-id-fixture');
  });

  test('dashboard OAuth callback exchanges code, stores refresh token, and registers handle', async () => {
    const registryPath = join(mkdtempSync(join(tmpdir(), 'olympus-dashboard-oauth-')), 'handles.json');
    const secretStore = memorySecretStore({
      'dropbox.personal.oauth.client_id': 'dropbox-client-id-fixture',
    });
    let tokenExchangeBody = '';
    const oauthFetch: OAuthFetch = async (_url, init) => {
      tokenExchangeBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        access_token: 'dropbox-access-token-fixture',
        refresh_token: 'dropbox-refresh-token-fixture',
        expires_in: 3600,
        scope: 'files.metadata.read files.content.read sharing.read',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const worker = createEmailSourceWorker({
      sourceIndexStatus: {
        async status() {
          return fixtureStatus();
        },
      },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore,
        oauthFetch,
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const start = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
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
    const payload = await start.json();
    const authorizationUrl = new URL(payload.authorization_url);
    const state = authorizationUrl.searchParams.get('state');

    expect(start.status).toBe(200);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://worker.test/oauth/callback/dropbox');
    expect(state).toBeTruthy();

    const redirect = await fetch(new Request(`http://worker.test/oauth/callback/dropbox?code=dropbox-code-fixture&state=${state}`));
    const registry = readConnectedHandleRegistry(registryPath);

    // A successful callback now redirects (303) to a query-free `/done` page
    // (MINOR 2, Codex round 2 on 7863a735) rather than rendering "Connected"
    // directly at the code/state-bearing URL.
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get('Location')).toBe('/oauth/callback/dropbox/done');
    const callback = await fetch(new Request(`http://worker.test${redirect.headers.get('Location')}`));

    // The authorization runs in its own tab, so the callback lands there and
    // says so instead of redirecting a second dashboard into that tab.
    expect(callback.status).toBe(200);
    expect(await callback.clone().text()).toContain('You can close this tab');
    const dropboxLandingHtml = await callback.clone().text();
    expect(dropboxLandingHtml).toContain('href="/dashboard"');
    expect(dropboxLandingHtml).not.toContain('dashboard-return-token');
    expect(dropboxLandingHtml).not.toContain('token=');
    expect(tokenExchangeBody).toContain('code=dropbox-code-fixture');
    expect(tokenExchangeBody).toContain('redirect_uri=http%3A%2F%2Fworker.test%2Foauth%2Fcallback%2Fdropbox');
    expect(await secretStore.get('dropbox.personal.oauth.refresh_token')).toBe('dropbox-refresh-token-fixture');
    expect(registry.handles).toHaveLength(1);
    expect(registry.handles[0]).toMatchObject({
      handle: 'dropbox.personal',
      provider: 'dropbox',
      allowedCapabilities: ['dropbox.files.sync'],
    });

    const dashboard = await fetch(new Request('http://worker.test/dashboard', {
      headers: { Authorization: 'Bearer dashboard-secret' },
    }));
    const html = await dashboard.text();
    expect(html).not.toContain('dropbox-refresh-token-fixture');
    expect(html).not.toContain('dropbox-access-token-fixture');
    expect(html).not.toContain('dropbox-code-fixture');
  });

  test('dashboard OAuth callback failures render sanitized HTML instead of JSON', async () => {
    const registryPath = join(mkdtempSync(join(tmpdir(), 'olympus-dashboard-oauth-fail-')), 'handles.json');
    const secretStore = memorySecretStore({
      'dropbox.personal.oauth.client_id': 'dropbox-client-id-fixture',
    });
    const oauthFetch: OAuthFetch = async () => new Response(JSON.stringify({
      error: 'invalid_client',
      error_description: 'client authentication failed',
      access_token: 'dropbox-token-shaped-value-1234567890',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore,
        oauthFetch,
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const start = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
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
    const payload = await start.json();
    const authorizationUrl = new URL(payload.authorization_url);
    const state = authorizationUrl.searchParams.get('state');

    expect(start.status).toBe(200);
    expect(state).toBeTruthy();

    const callback = await fetch(new Request(`http://worker.test/oauth/callback/dropbox?code=dropbox-code-fixture&state=${state}`));
    const text = await callback.text();

    expect(callback.status).toBe(400);
    expect(callback.headers.get('Content-Type')).toContain('text/html');
    expect(text).toContain('Could not connect dropbox');
    // The allowlisted code is the whole provider vocabulary this page speaks:
    // the description is provider prose, and provider prose can echo secrets
    // (R61/R61B), so it never renders.
    expect(text).toContain('invalid_client');
    expect(text).not.toContain('client authentication failed');
    expect(text).toContain('Return to dashboard');
    // The failure page is unauthenticated HTML too, and the same rule holds:
    // the link back carries the origin and nothing else.
    expect(text).toContain('href="/dashboard"');
    expect(text).not.toContain('dashboard-return-token');
    expect(text).not.toContain('token=');
    expect(text).not.toContain('dropbox-token-shaped-value-1234567890');
    expect(text).not.toContain('"error"');
  });

  // The live 2026-08-19 incident: behind `tailscale serve` the TLS terminates
  // at the proxy, the worker sees plain HTTP, and the callback came out as
  // http://<private-host>.<tailnet>.ts.net/... — which X refuses, killing the flow on
  // the provider's error page.
  test('dashboard OAuth start builds an https callback behind a TLS-terminating proxy', async () => {
    const { fetch, redirectUris } = oauthStartFixture({
      'x.personal.oauth.client_id': 'x-client-id-fixture',
      'x.personal.oauth.client_secret': 'x-client-secret-fixture',
    });

    const forwardedProto = await fetch(new Request('http://private-host.example-tailnet.ts.net/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ source: 'x' }),
    }));

    expect(forwardedProto.status).toBe(200);
    expect(redirectUris.at(-1)).toBe('https://private-host.example-tailnet.ts.net/oauth/callback/x');

    const rfc7239 = await fetch(new Request('http://private-host.example-tailnet.ts.net/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
        Forwarded: 'for=100.64.0.2;proto=https;by=tailscale',
      },
      body: JSON.stringify({ source: 'x' }),
    }));

    expect(rfc7239.status).toBe(200);
    expect(redirectUris.at(-1)).toBe('https://private-host.example-tailnet.ts.net/oauth/callback/x');

    // A header that is not a scheme changes nothing: the request's own origin
    // stands rather than a value this worker cannot make sense of.
    const nonsense = await fetch(new Request('http://private-host.example-tailnet.ts.net/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'javascript',
      },
      body: JSON.stringify({ source: 'x' }),
    }));

    expect(nonsense.status).toBe(200);
    expect(redirectUris.at(-1)).toBe('http://private-host.example-tailnet.ts.net/oauth/callback/x');
  });

  test('a loopback request keeps its 127.0.0.1 callback whatever a proxy header says', async () => {
    const { fetch, redirectUris } = oauthStartFixture({
      'x.personal.oauth.client_id': 'x-client-id-fixture',
      'x.personal.oauth.client_secret': 'x-client-secret-fixture',
    });

    const start = await fetch(new Request('http://localhost:17777/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ source: 'x' }),
    }));

    expect(start.status).toBe(200);
    expect(redirectUris.at(-1)).toBe('http://127.0.0.1:17777/oauth/callback/x');
  });

  test('a client id submitted once is registered, so the next start needs no id', async () => {
    const secretStore = memorySecretStore({ 'x.personal.oauth.client_secret': 'x-client-secret-fixture' });
    const { fetch, redirectUris } = oauthStartFixture(secretStore);

    const first = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'x', client_id: 'submitted-x-client-id-fixture' }),
    }));

    expect(first.status).toBe(200);
    expect(await secretStore.get('x.personal.oauth.client_id')).toBe('submitted-x-client-id-fixture');

    // The live failure mode: the first flow died at the provider, so the
    // callback that used to be the only writer never ran.
    const second = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'x' }),
    }));

    expect(second.status).toBe(200);
    expect(redirectUris).toHaveLength(2);
  });

  test('dashboard OAuth start normalizes localhost redirects to 127.0.0.1', async () => {
    const secretStore = memorySecretStore({
      'dropbox.personal.oauth.client_id': 'dropbox-client-id-fixture',
    });
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        secretStore,
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const start = await fetch(new Request('http://localhost:17777/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'dropbox' }),
    }));
    const payload = await start.json();
    const authorizationUrl = new URL(payload.authorization_url);

    expect(start.status).toBe(200);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:17777/oauth/callback/dropbox');
  });
});

// Each test below pins one finding from the 2026-07-28 five-dimension review,
// using the trigger the reviewer executed against the real view-model builder.
describe('dashboard misreporting where private data lives', () => {
  test('the path-scoped internal Dropbox band reaches the card, the tier totals and the summary tiles', () => {
    const status = statusWithCorpora([
      dropboxFilesCorpus(10, 10),
      retiredLibraryCorpus(4321, 4321),
    ]);

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      sourceCorpusRegistry: registryWithDropboxBand(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files');
    expect(dropbox?.coverage.indexed_items).toBe(4331);
    expect(view.summary.total_indexed_items).toBe(4331);
    expect(view.where_your_data_lives.find((card) => card.trust_domain === 'internal')?.indexed_items).toBe(4321);
    expect(view.unassigned_corpora.corpus_count).toBe(0);
  });

  test('the internal, cloud-answerable Dropbox band is a visible tier on the Dropbox card, not 100% Secure', () => {
    const status = statusWithCorpora([
      dropboxFilesCorpus(4000, 4000),
      retiredLibraryCorpus(900, 900),
    ]);

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      sourceCorpusRegistry: registryWithDropboxBand(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files');
    expect(dropbox?.tier_composition).toEqual(expect.arrayContaining([
      { trust_domain: 'secure_local', label: 'Secure', indexed_items: 4000, content_ready_items: 4000 },
      { trust_domain: 'internal', label: 'Private', indexed_items: 900, content_ready_items: 900 },
    ]));
    expect(view.summary.total_indexed_items).toBe(4900);
    expect(view.where_your_data_lives.find((card) => card.trust_domain === 'secure_local')?.indexed_items).toBe(4000);
    expect(view.where_your_data_lives.find((card) => card.trust_domain === 'internal')?.indexed_items).toBe(900);
    // The split is on the Dropbox card too, where the owner reads it.
  });

  test('a corpus no source card owns is listed and counted rather than silently dropped', () => {
    const status = statusWithCorpora([dropboxFilesCorpus(10, 10), agentLibraryCorpus(42)]);

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    expect(view.unassigned_corpora).toMatchObject({
      corpus_count: 1,
      indexed_items: 42,
      content_ready_items: 42,
      entries: [{ corpus_id: AGENT_LIBRARY_CORPUS_ID, trust_domain: 'internal', indexed_items: 42 }],
    });
    expect(view.summary.total_indexed_items).toBe(52);
    expect(view.where_your_data_lives.find((card) => card.trust_domain === 'internal')?.indexed_items).toBe(42);
  });

  test('folders excluded by configuration render as their own section, opposite the unassigned one', () => {
    const status = statusWithCorpora([dropboxFilesCorpus(10, 10), agentLibraryCorpus(42)]);
    const ingestionLedger = buildSourceIngestionLedgerSnapshot(status, {
      now: new Date('2026-07-28T12:00:00.000Z'),
      exclusions: [{
        matcher: createSourceExclusionMatcherFromPrefixes([
          { ruleId: 'agent-corpus', mode: 'exclude' as const, kind: 'path_prefix' as const, prefix: '/3 Resources/Books', reason: 'another system curates this' },
          { ruleId: 'agent-corpus', mode: 'exclude' as const, kind: 'path_prefix' as const, prefix: '/3 Resources/Papers', reason: 'another system curates this' },
        ]),
        present: { items: 120, unevaluable: 0 },
      }],
    });

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      ingestionLedger,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    expect(view.excluded_by_configuration).toEqual({
      rules: 1,
      prefixes: 2,
      items_present: 120,
      items_unevaluable: 0,
      entries: [{ rule_id: 'agent-corpus', prefixes: 2, modes: ['exclude'], kinds: ['path_prefix'] }],
      metadata_only_rules: 0,
      metadata_only_prefixes: 0,
      items_metadata_only_content_present: 0,
    });
    // The unassigned block is still its own section saying the opposite.
    // Excluded items are not silently subtracted from anything: the section is
    // a statement about ingestion, and the summary tiles are unchanged.
    expect(view.summary.total_indexed_items).toBe(52);
  });

  test('the excluded section reports rule ids and counts without emitting a configured folder path', () => {
    const status = statusWithCorpora([dropboxFilesCorpus(10, 10)]);
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      ingestionLedger: buildSourceIngestionLedgerSnapshot(status, {
        now: new Date('2026-07-28T12:00:00.000Z'),
        exclusions: [{
          matcher: createSourceExclusionMatcherFromPrefixes([
            { ruleId: 'agent-corpus', mode: 'exclude' as const, kind: 'path_prefix' as const, prefix: '/3 Resources/Books', reason: 'another system curates this' },
          ]),
          present: { items: 0, unevaluable: 0 },
        }],
      }),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    // The whole view model is serialized into the page, so the prefix must be
    // absent from the model, not merely from the markup.
    expect(JSON.stringify(view)).not.toContain('3 resources/books');
    expect(view.policy.file_paths_returned).toBe(false);
    // A purged store says so in words rather than showing a bare zero.
  });

  test('canonical Gmail connector stores report disjoint trust-domain bands', () => {
    const status = statusWithCorpora([
      googleConnectorStoreCorpus('secure_local.email.private', 'email', 'secure_local', 'gmail', 10000, 10000),
      googleConnectorStoreCorpus('internal.email', 'email', 'internal', 'gmail', 3000, 3000),
    ]);

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    const gmail = view.sources.find((source) => source.source_id === 'gmail.email');
    expect(gmail?.coverage.indexed_items).toBe(13000);
    expect(gmail?.tier_composition).toEqual(expect.arrayContaining([
      { trust_domain: 'secure_local', label: 'Secure', indexed_items: 10000, content_ready_items: 10000 },
      { trust_domain: 'internal', label: 'Private', indexed_items: 3000, content_ready_items: 3000 },
    ]));
    expect(view.summary.total_indexed_items).toBe(13000);
    expect(view.where_your_data_lives.find((card) => card.trust_domain === 'secure_local')?.indexed_items).toBe(10000);
    expect(view.where_your_data_lives.find((card) => card.trust_domain === 'internal')?.indexed_items).toBe(3000);
  });

  test('a connector-store Gmail pair still reports two disjoint bands', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: googleConnectorStoreFixtureStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: googleHandleRegistry(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    expect(view.sources.find((source) => source.source_id === 'gmail.email')?.coverage.indexed_items).toBe(18);
  });

  test('the WhatsApp card reads its real ledger row instead of synthesizing a healthy one', () => {
    const status = statusWithCorpora([whatsappMessagesCorpus(20000, 3000)]);

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      ingestionLedger: {
        kind: 'source_ingestion_ledger',
        generated_at: '2026-07-28T12:00:00.000Z',
        rows: [whatsappLedgerRow()],
        unassigned_corpora: { corpus_count: 0, items: 0, content_indexed: 0, entries: [] },
        attention: [],
        policy: { read_only: true, raw_source_exposed: false, source_text_returned: false, castor_safe: true },
      },
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    const whatsapp = view.sources.find((source) => source.source_id === 'whatsapp.personal.messages');
    expect(whatsapp?.ingestion_health).toMatchObject({
      coverage_percent: 15,
      stuck_count: 4900,
      drain_state: 'held',
      drain_unit: 'olympus-whatsapp-drain.timer',
    });
    expect(whatsapp?.ingestion_health.label).toContain('4900 stuck');
    expect(whatsapp?.ingestion_health.label).not.toContain('no stuck work');
  });

  // The live 2026-08-19 defect: Telegram (185k items, synced an hour ago) and
  // WhatsApp (18.9k items, synced seconds ago) both read "not connected —
  // Pairing required" and landed in Needs you, because connection was derived
  // from the connected-handle registry, which no chat source has an entry in.
  test('a registry-less chat source that synced inside its cadence window reads connected', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: statusWithCorpora([telegramMessagesCorpus(185_000, 185_000)]),
      schedulerStatus: chatScheduler([chatSchedulerSource('telegram.messages', 'internal.telegram.messages', 1)]),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      // No registry at all: exactly what a paired mtproto session looks like.
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    const telegram = view.sources.find((source) => source.source_id === 'telegram.messages');
    expect(telegram?.connection.state).toBe('synced');
    expect(telegram?.connection.label).toContain('synced');
    expect(telegram?.connection.label).not.toContain('not connected');
    expect(telegram?.connection.action).toMatchObject({ kind: 'guided_session', label: 'Session ready' });
    expect(telegram?.configured).toBe(true);
    // The false alarm's other half: a card reading never-connected over indexed
    // items is forced into Needs you by the vocabulary's revoked-handle rule.
    expect(telegram?.answer_readiness.state).not.toBe('disconnected');
  });

  test('a chat source with no sync evidence at all still asks for pairing', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: statusWithCorpora([telegramMessagesCorpus(185_000, 185_000)]),
      schedulerStatus: chatScheduler([chatSchedulerSource('telegram.messages', 'internal.telegram.messages', 1)]),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    // WhatsApp is in the same build with no corpus, no scheduler row and no
    // handle: nothing has ever synced, so pairing is the true ask.
    const whatsapp = view.sources.find((source) => source.source_id === 'whatsapp.personal.messages');
    expect(whatsapp?.connection.state).toBe('not_connected');
    expect(whatsapp?.connection.label).toBe('not connected');
    expect(whatsapp?.connection.action).toMatchObject({ kind: 'guided_session', label: 'Pairing required' });
    expect(whatsapp?.configured).toBe(false);
  });

  test('a chat source whose last sync fell outside its window says the session is not surfaced', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: statusWithCorpora([telegramMessagesCorpus(185_000, 185_000)]),
      schedulerStatus: chatScheduler([
        chatSchedulerSource('telegram.messages', 'internal.telegram.messages', 40, true),
      ]),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    const telegram = view.sources.find((source) => source.source_id === 'telegram.messages');
    // Connected on the evidence of a past sync, and honest that nothing here
    // can read the session behind it — never a pairing demand over 185k items.
    expect(telegram?.connection.state).toBe('connected');
    expect(telegram?.connection.label).toBe('connected · live session not checked');
    expect(telegram?.connection.action).toMatchObject({
      kind: 'guided_session',
      label: 'Session state not surfaced',
    });
  });

  // R61 finding 2: a missing cadence window proves nothing, so it must not
  // promote an arbitrarily old sync to a live session.
  test('a chat source with an old sync and no threshold does not claim a ready session', () => {
    const source = chatSchedulerSource('telegram.messages', 'internal.telegram.messages', 1000);
    delete (source as unknown as Record<string, unknown>).freshness_threshold_hours;
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: statusWithCorpora([telegramMessagesCorpus(185_000, 185_000)]),
      schedulerStatus: chatScheduler([source]),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    const telegram = view.sources.find((card) => card.source_id === 'telegram.messages');
    expect(telegram?.connection.action).toMatchObject({
      kind: 'guided_session',
      label: 'Session state not surfaced',
    });
  });

  // R61 finding 2, the other half: a run is marked running before its
  // authentication has succeeded, so an in-flight run alone must not
  // establish the session.
  test('a run merely in flight does not establish a chat session', () => {
    const corpus = {
      ...telegramMessagesCorpus(0, 0),
      last_sync: { status: 'running' },
    } as unknown as SourceIndexStatusResult['corpora'][number];
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: statusWithCorpora([corpus]),
      schedulerStatus: chatScheduler([]),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    const telegram = view.sources.find((card) => card.source_id === 'telegram.messages');
    expect(telegram?.connection.state).toBe('not_connected');
    expect(telegram?.connection.action).toMatchObject({
      kind: 'guided_session',
      label: 'Pairing required',
    });
  });

  test('a stale chat source stays honest about its session even while a run is in flight', () => {
    const corpus = {
      ...telegramMessagesCorpus(185_000, 185_000),
      last_sync: { status: 'running' },
    } as unknown as SourceIndexStatusResult['corpora'][number];
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: statusWithCorpora([corpus]),
      schedulerStatus: chatScheduler([
        chatSchedulerSource('telegram.messages', 'internal.telegram.messages', 40, true),
      ]),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    const telegram = view.sources.find((card) => card.source_id === 'telegram.messages');
    // The run is real activity; it is still not proof the session behind the
    // stale evidence is alive.
    expect(telegram?.connection.state).toBe('syncing');
    expect(telegram?.connection.action).toMatchObject({
      kind: 'guided_session',
      label: 'Session state not surfaced',
    });
  });

  test('a broker-backed source is still connected by its handle, never by its items', () => {
    // The evidence rule is scoped to families with no broker credential: an
    // OAuth source with a revoked handle must keep reading not-connected even
    // with a full corpus behind it.
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: { version: 1, handles: [] },
      oauthClientIds: { dropbox: 'dropbox-client-id' },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(sourceState(view, 'dropbox.files')).toBe('not_connected');
  });

  test('every source card resolves to a real ingestion-ledger row key', () => {
    // Class-level guard for the WhatsApp defect: the ledger keys its rows by
    // its own short source id, which is not always the dashboard's provider.
    const ledger = buildSourceIngestionLedgerSnapshot(fixtureStatus(), { now: new Date('2026-07-28T12:00:00.000Z') });
    const ledgerKeys = new Set(ledger.rows.map((row) => row.source_id));

    const unmatched = DASHBOARD_SUPPORTED_SOURCES
      .filter((definition) => !ledgerKeys.has(definition.ingestion_ledger_source_id))
      .map((definition) => `${definition.source_id} -> ${definition.ingestion_ledger_source_id}`);

    expect(unmatched).toEqual([]);
  });

  test('every registry corpus is claimed by a card or reported as unassigned, never dropped', () => {
    const registryCorpora = createSourceCorpusRegistry().list('status');
    const status = statusWithCorpora(registryCorpora.map((corpus, index) => ({
      corpus_id: corpus.corpusId,
      family: corpus.family,
      trust_domain: corpus.trustDomain,
      activation_mode: 'lexical_only',
      embedding_policy: 'local_only',
      configured: true,
      provider: corpus.provider,
      counts: { indexed_items: index + 1, chunks: index + 1, embedded_chunks: 0, tombstoned_items: 0, sync_runs: 1 },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
    } as unknown as SourceIndexStatusResult['corpora'][number])));
    const expectedTotal = registryCorpora.reduce((sum, _corpus, index) => sum + index + 1, 0);

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    const accountedFor = view.sources.reduce((sum, source) => sum + source.coverage.indexed_items, 0)
      + view.unassigned_corpora.indexed_items;
    expect(accountedFor).toBe(expectedTotal);
    expect(view.summary.total_indexed_items).toBe(expectedTotal);
    // Every shipped registry corpus is claimed by a card today. The assertion
    // that matters is the one above: whatever the roster becomes, items land on
    // a card or in `unassigned`, and never nowhere.
    expect(view.unassigned_corpora.entries.map((entry) => entry.corpus_id)).toEqual([]);
  });

  test('summary totals always equal the sum of the tier cards', () => {
    const fixtures: SourceIndexStatusResult[] = [
      fixtureStatus(),
      googleConnectorStoreFixtureStatus(),
      statusWithCorpora([dropboxFilesCorpus(4000, 4000), retiredLibraryCorpus(900, 900)]),
      statusWithCorpora([
        googleConnectorStoreCorpus('secure_local.email.private', 'email', 'secure_local', 'gmail', 10000, 10000),
        googleConnectorStoreCorpus('internal.email', 'email', 'internal', 'gmail', 3000, 3000),
      ]),
      // Includes a corpus no card owns, so the invariant covers the path where
      // an undercount would otherwise hide in the gap between the two sums.
      statusWithCorpora([dropboxFilesCorpus(10, 10), agentLibraryCorpus(42)]),
    ];

    for (const sourceIndexStatus of fixtures) {
      const view = buildSourceDashboardViewModel({
        sourceIndexStatus,
        sovereigntyEngine: fixtureSovereigntyEngine(),
        now: new Date('2026-07-28T12:00:00.000Z'),
      });
      const tierIndexed = view.where_your_data_lives.reduce((sum, card) => sum + card.indexed_items, 0);
      const tierReady = view.where_your_data_lives.reduce((sum, card) => sum + card.content_ready_items, 0);
      expect(tierIndexed).toBe(view.summary.total_indexed_items);
      expect(tierReady).toBe(view.summary.total_content_ready_items);
    }
  });

  test('an unordered analyst pool is not printed as a try-this-first chain', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      sovereigntyEngine: veniceSovereigntyEngine(),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });
    const secure = view.where_your_data_lives.find((card) => card.trust_domain === 'secure_local');

    expect(secure?.model_lanes).toEqual(['Local · This computer', 'Private cloud · Venice']);
    expect(secure?.model_lane_selection).toBe('health_latency');
  });

  test('an operator-ordered analyst pool keeps its order and still reads as a chain', () => {
    const config = buildEnvBridgeSovereigntyConfig({
      OLYMPUS_SOURCE_INDEX_VENICE_API_KEY: 'venice-fixture-key',
    });
    config.routes.secure_local = {
      pool: { members: ['local-source-answer', 'venice-private'], order: ['venice-private', 'local-source-answer'] },
    };

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      sovereigntyEngine: createSovereigntyEngine(config),
      now: new Date('2026-07-28T12:00:00.000Z'),
    });
    const secure = view.where_your_data_lives.find((card) => card.trust_domain === 'secure_local');

    expect(secure?.model_lanes).toEqual(['Private cloud · Venice', 'Local · This computer']);
    expect(secure?.model_lane_selection).toBe('explicit_order');
  });

});

function statusWithCorpora(corpora: SourceIndexStatusResult['corpora']): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-07-28T12:00:00.000Z',
    corpora,
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

function dropboxFilesCorpus(files: number, chunks: number): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: 'secure_local.dropbox.files',
    family: 'file',
    trust_domain: 'secure_local',
    activation_mode: 'hybrid_shadow',
    embedding_policy: 'local_only',
    configured: true,
    provider: 'dropbox',
    read_authority: 'connector_store',
    counts: {
      indexed_items: files,
      tombstoned_items: 0,
      files_with_text: chunks,
      chunks,
      embedded_chunks: 0,
      sync_runs: 1,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  };
}

// An internal band carried on the Dropbox source. The corpus that originally
// exercised this has been retired, so the case is reconstructed through the
// injectable registry: the property under test is that a card claims every
// corpus the registry files under its source id, whatever the roster holds.
function registryWithDropboxBand() {
  return createSourceCorpusRegistry({
    schemaVersion: 1,
    corpora: [
      ...defaultSourceCorpusRegistryConfig().corpora,
      {
        corpusId: 'internal.retired.library',
        sourceId: 'dropbox.files',
        provider: 'dropbox',
        family: 'file',
        trustDomain: 'internal',
        capabilities: ['answer', 'status', 'search'],
      },
    ],
  });
}

function retiredLibraryCorpus(indexedItems: number, chunks: number): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: 'internal.retired.library',
    family: 'file',
    trust_domain: 'internal',
    activation_mode: 'hybrid_shadow',
    embedding_policy: 'cloud_allowed_by_policy',
    configured: true,
    provider: 'dropbox',
    read_authority: 'connector_store',
    counts: {
      indexed_items: indexedItems,
      tombstoned_items: 0,
      chunks,
      items_with_text: Math.min(indexedItems, chunks),
      embedded_chunks: 0,
      sync_runs: 1,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  };
}

// An indexed corpus no dashboard card owns. A literal rather than a registry
// lookup: the case being pinned is precisely a corpus the registry does not
// carry, so deriving it from the registry cannot express it.
const AGENT_LIBRARY_CORPUS_ID = 'internal.retired.agent-library';

function agentLibraryCorpus(indexedItems: number): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: AGENT_LIBRARY_CORPUS_ID,
    family: 'file',
    trust_domain: 'internal',
    activation_mode: 'lexical_only',
    embedding_policy: 'cloud_allowed_by_policy',
    configured: true,
    provider: 'domain_library',
    counts: {
      indexed_items: indexedItems,
      chunks: indexedItems,
      items_with_text: indexedItems,
      embedded_chunks: 0,
      tombstoned_items: 0,
      sync_runs: 1,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  } as unknown as SourceIndexStatusResult['corpora'][number];
}

function whatsappMessagesCorpus(indexedItems: number, chunks: number): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: 'secure_local.whatsapp.messages',
    family: 'chat',
    trust_domain: 'secure_local',
    activation_mode: 'hybrid_shadow',
    embedding_policy: 'local_only',
    configured: true,
    provider: 'whatsapp',
    counts: { indexed_items: indexedItems, tombstoned_items: 0, chunks, embedded_chunks: 0, sync_runs: 1 },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  } as unknown as SourceIndexStatusResult['corpora'][number];
}

function telegramMessagesCorpus(indexedItems: number, chunks: number): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: 'internal.telegram.messages',
    family: 'chat',
    trust_domain: 'internal',
    activation_mode: 'hybrid_primary',
    embedding_policy: 'cloud_allowed_by_policy',
    configured: true,
    provider: 'telegram',
    counts: { indexed_items: indexedItems, tombstoned_items: 0, chunks, embedded_chunks: 0, sync_runs: 1 },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  } as unknown as SourceIndexStatusResult['corpora'][number];
}

function chatScheduler(sources: SourceSchedulerStatus['sources']): SourceSchedulerStatus {
  return {
    kind: 'source_scheduler_status',
    enabled: true,
    running: true,
    generated_at: '2026-07-28T12:00:00.000Z',
    sources,
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      counts_only: true,
    },
  };
}

function chatSchedulerSource(
  sourceId: string,
  corpusId: string,
  freshnessHours: number,
  stale = false,
): SourceSchedulerStatus['sources'][number] {
  return {
    source_id: sourceId,
    corpus_id: corpusId,
    sync_cadence: 'continuous',
    sync_interval_seconds: 1800,
    freshness_threshold_hours: 26,
    freshness_hours: freshnessHours,
    stale_sync_anomaly: stale,
    tasks: [],
  };
}

function whatsappLedgerRow(): SourceIngestionLedgerRow {
  return {
    source_id: 'whatsapp',
    label: 'WhatsApp',
    primary_corpus_id: 'secure_local.whatsapp.messages',
    corpus_ids: ['secure_local.whatsapp.messages'],
    family: 'chat',
    trust_domains: ['secure_local'],
    configured: true,
    items: 20000,
    content_indexed: 3000,
    metadata_only: 17000,
    failed: 900,
    coverage_percent: 15,
    stuck: { queued: 4000, active: 0, held_paused: 1, broken: 900 },
    ingestion_health: {
      coverage_percent: 15,
      stuck_work: { queued: 4000, failed_retryable: 900, failed_terminal: 0, by_class: [] },
      drain: { state: 'held', unit: 'olympus-whatsapp-drain.timer' },
    },
    attention: ['whatsapp drain held'],
  };
}

function dropboxHandleRegistry(): ConnectedHandleRegistry {
  return {
    version: 1,
    handles: [{
      handle: 'dropbox.personal',
      provider: 'dropbox',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read'],
      connectedAt: '2026-07-28T10:00:00.000Z',
    }] as ConnectedHandleRegistry['handles'],
  };
}

function veniceSovereigntyEngine() {
  return createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
    OLYMPUS_SOURCE_INDEX_VENICE_API_KEY: 'venice-fixture-key',
  }));
}

describe('onboarding walkthrough invariant', () => {
  test('the builder emits seven setup stages and every source state names a next action', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: emptyFixtureStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    expect(view.onboarding.steps.map((step) => step.id)).toEqual([
      'security_preset',
      'dependencies',
      'credential_or_pairing',
      'scope',
      'initial_sync',
      'source_health',
      'cited_answer_readiness',
    ]);
    expect(view.onboarding.steps.filter((step) => step.state === 'active')).toHaveLength(1);
    expect(view.onboarding.steps.find((step) => step.state === 'active')?.next_action).toBeTruthy();
    for (const source of view.sources) {
      expect(source.setup?.condition).toBe('blocked');
      expect(source.setup?.next_action).toBeTruthy();
      expect(source.setup?.dependencies.length).toBeGreaterThan(0);
      expect(source.setup?.dependencies.every((dependency) => dependency.next_action.length > 0)).toBe(true);
    }
  });

  test('the Google pilot state is truthful about unverified shared and BYO modes', () => {
    const common = {
      sourceIndexStatus: emptyFixtureStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    };
    const byo = buildSourceDashboardViewModel(common);
    const shared = buildSourceDashboardViewModel({ ...common, googlePilotClientConfigured: true });
    expect(byo.google_pilot).toMatchObject({
      mode: 'advanced_byo_required',
      verification: 'unverified',
      advanced_byo_supported: true,
    });
    expect(shared.google_pilot).toMatchObject({
      mode: 'shared_pilot',
      verification: 'unverified',
      advanced_byo_supported: true,
    });
    expect(shared.google_pilot?.warning).toContain('3–5-user pilot');
  });

  test('the ordinary first-sync window keeps an active step and a rendered explanation', () => {
    // Items are indexed but their text has not been extracted yet: the window
    // every new source passes through. connected && firstSync && !answerReady
    // used to leave every step complete-or-pending with nothing highlighted.
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: indexedWithoutTextStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files');

    expect(dropbox?.configured).toBe(true);
    expect(dropbox?.coverage).toMatchObject({ indexed_items: 120, content_ready_items: 0 });
    expect(dropbox?.answer_readiness.state).toBe('syncing');
    expect(view.onboarding.ask_first_question.enabled).toBe(false);
    expect(view.onboarding.steps.filter((step) => step.state === 'active')).toHaveLength(1);
  });

  test('the initial-sync stage is not complete on a brand-new empty install', () => {
    const empty = buildSourceDashboardViewModel({
      sourceIndexStatus: emptyFixtureStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const withData = buildSourceDashboardViewModel({
      sourceIndexStatus: indexedWithoutTextStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(empty.where_your_data_lives).toHaveLength(3);
    expect(empty.onboarding.steps.find((step) => step.id === 'initial_sync')?.state).toBe('pending');
    expect(withData.onboarding.steps.find((step) => step.id === 'initial_sync')?.state).toBe('complete');
  });

  test('"Watch the first sync" ignores items belonging to sources that were never connected', () => {
    // fixtureStatus carries 40 indexed Gmail items; with no handle registry no
    // source is connected, so the index-wide total must not tick step 2 green.
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    expect(view.summary.total_indexed_items).toBeGreaterThan(0);
    expect(view.summary.connected_sources).toBe(0);
    expect(view.onboarding.steps.find((step) => step.id === 'initial_sync')?.state).toBe('pending');
    expect(view.onboarding.steps.find((step) => step.id === 'dependencies')?.state).toBe('active');
  });

  test('the walkthrough never renders a pending stage above a completed one', () => {
    // A freshly connected source has not proven its declared dependencies yet
    // (the dependency status only turns `ready` once a read completes), so the
    // per-stage booleans used to render "Dependency check" as pending behind an
    // already-complete "Credential or pairing".
    const cases: Array<[string, ReturnType<typeof buildSourceDashboardViewModel>]> = [
      ['empty install', buildSourceDashboardViewModel({
        sourceIndexStatus: emptyFixtureStatus(),
        sovereigntyEngine: fixtureSovereigntyEngine(),
        now: new Date('2026-07-02T12:00:00.000Z'),
      })],
      ['connected, first sync not started', buildSourceDashboardViewModel({
        sourceIndexStatus: emptyFixtureStatus(),
        sovereigntyEngine: fixtureSovereigntyEngine(),
        apiKeyAvailability: { readwise: true },
        now: new Date('2026-07-02T12:00:00.000Z'),
      })],
      ['connected file source, first sync not started', buildSourceDashboardViewModel({
        sourceIndexStatus: emptyFixtureStatus(),
        sovereigntyEngine: fixtureSovereigntyEngine(),
        connectedHandleRegistry: dropboxHandleRegistry(),
        now: new Date('2026-07-02T12:00:00.000Z'),
      })],
      ['indexed without extracted text', buildSourceDashboardViewModel({
        sourceIndexStatus: indexedWithoutTextStatus(),
        sovereigntyEngine: fixtureSovereigntyEngine(),
        connectedHandleRegistry: dropboxHandleRegistry(),
        now: new Date('2026-07-02T12:00:00.000Z'),
      })],
      ['answer ready', buildSourceDashboardViewModel({
        sourceIndexStatus: fixtureStatus(),
        sovereigntyEngine: fixtureSovereigntyEngine(),
        apiKeyAvailability: { readwise: true },
        connectedHandleRegistry: dropboxHandleRegistry(),
        now: new Date('2026-07-02T12:00:00.000Z'),
      })],
    ];

    for (const [name, view] of cases) {
      const states = view.onboarding.steps.map((step) => step.state);
      const lastComplete = states.lastIndexOf('complete');
      // Monotonic ladder: complete stages first, then one active, then pending.
      expect([name, states.slice(0, lastComplete + 1)])
        .toEqual([name, states.slice(0, lastComplete + 1).map(() => 'complete')]);
      expect([name, states.filter((state) => state === 'active').length]).toEqual([name, 1]);
      expect([name, states.indexOf('active')]).toEqual([name, lastComplete + 1]);
    }

    // The reported case, named: connecting an account clears the stages before
    // it, so the frontier is the first sync rather than a greyed dependency row.
    const connected = cases[1]?.[1];
    expect(connected?.summary.connected_sources).toBe(1);
    expect(connected?.onboarding.steps.find((step) => step.id === 'dependencies')?.state).toBe('complete');
    expect(connected?.onboarding.steps.find((step) => step.id === 'initial_sync')?.state).toBe('active');
  });

});

describe('freshness and sync labels', () => {
  function readwiseStatus(): SourceIndexStatusResult {
    const status = fixtureStatus();
    status.corpora = [{
      corpus_id: READWISE_LIBRARY_CORPUS_ID,
      family: 'readwise',
      trust_domain: 'internal',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'cloud_allowed',
      configured: true,
      provider: 'readwise',
      counts: { reader_documents: 250, items_with_text: 250 },
      item_metadata_returned: false,
    } as never];
    return status;
  }

  test('a card with no sync timestamp does not claim it synced just now', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: readwiseStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      apiKeyAvailability: { readwise: true },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const card = view.sources.find((source) => source.source_id === 'readwise.library');

    expect(card?.connection.state).toBe('synced');
    expect(card?.connection.label).toBe('synced');
    expect(card?.freshness.label).not.toBe('Waiting for first check');
  });

  test('the freshness line renders hours the same way the connection label does', () => {
    const cases: Array<[number, string, string]> = [
      [0, 'Last checked less than 1 hour ago', 'synced less than 1 hour ago'],
      [0.4, 'Last checked less than 1 hour ago', 'synced less than 1 hour ago'],
      [1, 'Last checked 1 hour ago', 'synced 1 hour ago'],
      [30, 'Last checked 1 day ago', 'synced 1 day ago'],
    ];

    for (const [hours, freshnessLabel, connectionLabel] of cases) {
      const scheduler = fixtureScheduler();
      scheduler.sources = [{
        source_id: 'readwise.library',
        corpus_id: READWISE_LIBRARY_CORPUS_ID,
        sync_cadence: 'continuous',
        sync_interval_seconds: 300,
        freshness_threshold_hours: 26,
        freshness_hours: hours,
        stale_sync_anomaly: false,
        tasks: [],
      }];
      const view = buildSourceDashboardViewModel({
        sourceIndexStatus: readwiseStatus(),
        schedulerStatus: scheduler,
        sovereigntyEngine: fixtureSovereigntyEngine(),
        apiKeyAvailability: { readwise: true },
        now: new Date('2026-07-02T12:00:00.000Z'),
      });
      const card = view.sources.find((source) => source.source_id === 'readwise.library');

      expect(`${hours}: ${card?.freshness.label}`).toBe(`${hours}: ${freshnessLabel}`);
      expect(`${hours}: ${card?.connection.label}`).toBe(`${hours}: ${connectionLabel}`);
    }
  });

  test('a stale refresh keeps its warning and still reads back as a duration', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: googleHandleRegistry(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const drive = view.sources.find((source) => source.source_id === 'google_drive.docs');

    expect(drive?.freshness.label).toBe('Last checked 1 day ago; refresh is late');
    expect(drive?.freshness.label).not.toContain('30 hours');
  });
});

describe('needs-review counts each item once', () => {
  // `qa_visible_gaps` is not a verdict — the store DERIVES it by summing five
  // verdicts (local-index.ts: metadata_only_gap + raster_ocr_vlm_escalation +
  // low_confidence_retry_local + low_confidence_candidate_for_venice +
  // failed_needs_operator). Listing it as a reason ALONGSIDE two of its own
  // components made the total count those documents twice and printed them
  // under two labels at once.
  function dropboxNeedsReviewCard(counts: Record<string, number>) {
    const status = fixtureStatus();
    status.corpora = [{
      corpus_id: 'secure_local.dropbox.files',
      family: 'file',
      trust_domain: 'secure_local',
      activation_mode: 'local_primary',
      embedding_policy: 'local_only',
      configured: true,
      provider: 'dropbox',
      read_authority: 'connector_store',
      counts: {
        indexed_items: 20,
        tombstoned_items: 0,
        chunks: counts.qa_pass ?? 0,
        embedded_chunks: 0,
        sync_runs: 1,
        qa_total_items: 20,
        ...counts,
      },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
    }];
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    return view.sources.find((source) => source.corpus_id === 'secure_local.dropbox.files');
  }

  test('a corpus whose only issue is metadata-only gaps reports that many items, not double', () => {
    // Five documents are metadata-only gaps. qa_visible_gaps is their derived
    // total, so five is the whole population needing review.
    const card = dropboxNeedsReviewCard({
      qa_pass: 15,
      qa_metadata_only_gap: 5,
      qa_visible_gaps: 5,
    });

    expect(card?.coverage.needs_review_items).toBe(5);
    expect(card?.needs_review?.total).toBe(5);
    expect(card?.needs_review?.reasons).toEqual([
      {
        key: 'metadata_only',
        label: 'Metadata only',
        count: 5,
        who_acts: 'automatic',
        actor_note: 'queued for the text sweep',
      },
    ]);
  });

  test('every component of the derived total keeps its own label, and the total is their sum', () => {
    const card = dropboxNeedsReviewCard({
      qa_pass: 10,
      qa_metadata_only_gap: 1,
      qa_raster_ocr_vlm_escalation: 2,
      qa_low_confidence_retry_local: 3,
      qa_low_confidence_candidate_for_venice: 4,
      qa_failed_needs_operator: 5,
      qa_visible_gaps: 15,
    });

    // 1+2+3+4+5 = 15 real documents, each counted exactly once.
    expect(card?.coverage.needs_review_items).toBe(15);
    expect(
      card?.needs_review?.reasons.reduce((sum, reason) => sum + reason.count, 0),
    ).toBe(15);
    expect(card?.needs_review?.reasons.map((reason) => reason.key).sort()).toEqual([
      'extraction_failed',
      'image_only_no_text',
      'metadata_only',
      'scanned_needs_better_reader',
      'text_looks_unreliable',
    ]);
  });

  test('no reason is a derived total of other reasons', () => {
    // The guard that keeps this from regressing: a key summed here must be a
    // verdict a document lands on, never a roll-up of other keys in the list.
    expect(DASHBOARD_NEEDS_REVIEW_REASONS.map((reason) => reason.count_key))
      .not.toContain('qa_visible_gaps');
  });
});

describe('retry counters are not item counts', () => {
  function bookmarksRetryingView(consecutiveFailures: number) {
    const status = fixtureStatus();
    status.corpora = [{
      corpus_id: 'internal.x.bookmarks',
      family: 'x',
      trust_domain: 'internal',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'cloud_allowed',
      configured: true,
      provider: 'x',
      counts: { indexed_items: 0, items_with_text: 0 },
      item_metadata_returned: false,
    } as never];
    const scheduler = fixtureScheduler();
    scheduler.sources = [{
      source_id: 'x.bookmarks',
      corpus_id: 'internal.x.bookmarks',
      sync_cadence: 'continuous',
      sync_interval_seconds: 300,
      freshness_threshold_hours: 26,
      stale_sync_anomaly: false,
      tasks: [{ id: 'x.sync', kind: 'sync', running: false, consecutive_failures: consecutiveFailures }],
    }];
    return buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      schedulerStatus: scheduler,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
  }

  test('the displayed severity does not grow with elapsed time', () => {
    const early = bookmarksRetryingView(1);
    const late = bookmarksRetryingView(4096);

    expect(early.sources.find((source) => source.source_id === 'x.bookmarks')?.queue_health)
      .toEqual(late.sources.find((source) => source.source_id === 'x.bookmarks')?.queue_health);
  });

  test('a retrying task still holds the source out of answer-ready', () => {
    const view = bookmarksRetryingView(3);
    const card = view.sources.find((source) => source.source_id === 'x.bookmarks');

    expect(card?.queue_health.label).toBe('Needs attention');
    expect(card?.answer_readiness.state).toBe('needs_attention');
    expect(view.summary.needs_attention_sources).toBeGreaterThan(0);
  });

  // R61 finding 3: a provider refusing requests is a credential problem the
  // broker has not latched yet. The card must re-arm the real reconnect
  // control even though the handle still reads connected.
  test('a refusing provider re-arms the reconnect control on a connected source', () => {
    const refusingView = (lastErrorKind?: string) => {
      const status = fixtureStatus();
      status.corpora = [{
        corpus_id: 'internal.x.bookmarks',
        family: 'x',
        trust_domain: 'internal',
        activation_mode: 'hybrid_primary',
        embedding_policy: 'cloud_allowed',
        configured: true,
        provider: 'x',
        counts: { indexed_items: 100, items_with_text: 100 },
        item_metadata_returned: false,
      } as never];
      const scheduler = fixtureScheduler();
      scheduler.sources = [{
        source_id: 'x.bookmarks',
        corpus_id: 'internal.x.bookmarks',
        sync_cadence: 'continuous',
        sync_interval_seconds: 300,
        freshness_threshold_hours: 26,
        freshness_hours: 1,
        stale_sync_anomaly: false,
        tasks: [{
          id: 'x.sync',
          kind: 'sync',
          running: false,
          consecutive_failures: lastErrorKind ? 3 : 0,
          ...(lastErrorKind ? { last_error_kind: lastErrorKind } : {}),
        }],
      }];
      return buildSourceDashboardViewModel({
        sourceIndexStatus: status,
        schedulerStatus: scheduler,
        sovereigntyEngine: fixtureSovereigntyEngine(),
        connectedHandleRegistry: fixtureHandleRegistry(),
        oauthClientIds: { x: 'x-client-id-fixture' },
        oauthClientSecretAvailability: { x: true },
        now: new Date('2026-07-02T12:00:00.000Z'),
      });
    };

    const refused = refusingView('api_request_guard').sources.find((source) => source.source_id === 'x.bookmarks');
    expect(refused?.connection.action).toMatchObject({ kind: 'oauth', source: 'x', label: 'Reauthenticate' });

    // A budget pause is Olympus's own doing, and a healthy card carries no
    // control at all: only a genuine provider refusal re-arms it.
    const budgeted = refusingView('daily_api_request_guard').sources.find((source) => source.source_id === 'x.bookmarks');
    expect(budgeted?.connection.action).toEqual({ kind: 'none' });
    const healthy = refusingView(undefined).sources.find((source) => source.source_id === 'x.bookmarks');
    expect(healthy?.connection.action).toEqual({ kind: 'none' });
  });

  // Live 2026-08-19 (~15:29Z, x.bookmarks): the budget guard parked the lane
  // (degraded_reason 'daily_cost_guard') while the last failure it recorded on
  // the way in still read 'api_request_guard'. The error kind alone re-armed
  // Reauthenticate on a lane whose credential had just been replaced, and the detail
  // page led with "provider is refusing requests" over an operator pause.
  test('a budget-parked lane stays uncontrolled even when its last error kind is the refusal marker', () => {
    const status = fixtureStatus();
    status.corpora = [{
      corpus_id: 'internal.x.bookmarks',
      family: 'x',
      trust_domain: 'internal',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'cloud_allowed',
      configured: true,
      provider: 'x',
      // The store now publishes per-item embedding parity, so the embedding
      // bar has a numerator and the settled line can appear at all.
      counts: { indexed_items: 100, items_with_text: 100, items_embedded: 100 },
      item_metadata_returned: false,
    } as never];
    const scheduler = fixtureScheduler();
    scheduler.sources = [{
      source_id: 'x.bookmarks',
      corpus_id: 'internal.x.bookmarks',
      sync_cadence: 'continuous',
      sync_interval_seconds: 300,
      freshness_threshold_hours: 26,
      freshness_hours: 1,
      stale_sync_anomaly: false,
      tasks: [{
        id: 'x.sync',
        kind: 'sync',
        running: false,
        consecutive_failures: 3,
        last_error_kind: 'api_request_guard',
        degraded_reason: 'daily_cost_guard',
      }],
    }];
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      schedulerStatus: scheduler,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      oauthClientIds: { x: 'x-client-id-fixture' },
      oauthClientSecretAvailability: { x: true },
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    const card = view.sources.find((source) => source.source_id === 'x.bookmarks');
    expect(card?.connection.action).toEqual({ kind: 'none' });

    const html = renderDashboardDetailBody(card!, { now: new Date('2026-07-02T12:00:00.000Z') });
    // Was: "Nothing is waiting on you here — paused by the daily budget until
    // 00:00 UTC." Owner ruling, 2026-08-24 — self-healing conditions show
    // NOTHING, and a budget that rolls over at midnight is the type case. The
    // page states the pause without asking for anything: no banner at all, and
    // the settled line drops its watching-for-changes claim.
    expect(html).not.toContain('class="attncard banner"');
    expect(html).toContain('Fully synced · sync paused');
    expect(html).not.toContain('watching for changes');
    expect(html).not.toContain('provider is refusing requests');
    expect(html).not.toContain('Reauthenticate');
    // The pause outranks the stale kind for what the page ASKS, but the kind
    // itself is still on the page: suppressing a real refusal would trade one
    // dishonesty for another.
    expect(html).toContain('api_request_guard');
  });

  // Live 2026-08-21 (x.bookmarks): the header read "Needs attention before
  // answers" while the detail page for the same card said nothing was waiting
  // and the lane was parked by the daily budget. The 2026-08-19 honesty fix
  // reached the connect control and the detail sentence; this ladder was the
  // one surface it missed.
  test('a budget-parked lane with ready content is answerable, not needing attention', () => {
    const card = parkedBookmarksCard({});

    expect(card?.answer_readiness).toEqual({
      state: 'ready',
      label: 'Ready for questions; sync paused',
    });
    expect(card?.answer_readiness.label).not.toBe('Needs attention before answers');
    // The header and the page it opens now say the same thing: caught up, and
    // paused. Nothing is asked of the reader, which after the 2026-08-24 ruling
    // means nothing is said to them at all.
    const html = renderDashboardDetailBody(card!, { now: PARKED_NOW });
    expect(html).not.toContain('class="attncard banner"');
    expect(html).toContain('sync paused');
  });

  test('a park does not absorb a genuine failure — real broken work still needs attention', () => {
    const card = parkedBookmarksCard({ counts: { extraction_jobs_failed: 4 } });

    expect(card?.queue_health.needs_attention).toBe(4);
    expect(card?.answer_readiness).toEqual({
      state: 'needs_attention',
      label: 'Needs attention before answers',
    });
  });

  test('a park absorbs the staleness it can account for', () => {
    // 20h late against a 26h deadline: one parked day explains all of it.
    const card = parkedBookmarksCard({ freshnessHours: 20, stale: true });

    expect(card?.freshness.stale).toBe(true);
    expect(card?.answer_readiness.state).toBe('ready');
  });

  test('staleness far beyond what a park can explain re-arms needs attention', () => {
    // 200h late against a 26h deadline is many rollovers, not one parked day:
    // whatever is holding this lane, the budget guard is not it.
    const card = parkedBookmarksCard({ freshnessHours: 200, stale: true });

    expect(card?.answer_readiness).toEqual({
      state: 'needs_attention',
      label: 'Needs attention before answers',
    });
  });

  test('without a park, retrying tasks still read as needing attention', () => {
    const card = parkedBookmarksCard({ degradedReason: undefined });

    expect(card?.queue_health.retrying_tasks).toBe(1);
    expect(card?.answer_readiness).toEqual({
      state: 'needs_attention',
      label: 'Needs attention before answers',
    });
  });

  // The pause suppresses an INFERRED refusal, never a latched one. A budget
  // guard must not hide a credential the probe has actually declared dead, or
  // the fix above would trade R61 finding 3 for a worse silence: a source that
  // will still be broken after the budget rolls over, with nothing to press.
  test('an operator pause does not mask a credential the probe latched as dead', () => {
    const scheduler = fixtureScheduler();
    scheduler.sources = [{
      source_id: 'dropbox.files',
      corpus_id: 'secure_local.dropbox.files',
      sync_cadence: 'continuous',
      sync_interval_seconds: 300,
      freshness_threshold_hours: 26,
      freshness_hours: 1,
      stale_sync_anomaly: false,
      tasks: [{
        id: 'dropbox.sync',
        kind: 'sync',
        running: false,
        consecutive_failures: 3,
        last_error_kind: 'api_request_guard',
        degraded_reason: 'daily_cost_guard',
      }],
    }];
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: scheduler,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      // Dropbox is PKCE, so a client id alone is enough to offer the real
      // control — without it the card would route to Set up and prove nothing
      // about the pause.
      oauthClientIds: { dropbox: 'dropbox-client-id-fixture' },
      credentialHealth: {
        kind: 'credential_health_report',
        version: 1,
        generated_at: '2026-08-18T12:00:00.000Z',
        results: [{
          handle: 'dropbox.personal', provider: 'dropbox', source_ids: ['dropbox.files'],
          credential_type: 'oauth2_refresh', status: 'reauth_required',
          checked_at: '2026-08-18T12:00:00.000Z', reason: 'credential_reauth_required',
        }],
        policy: {
          counts_only: true, raw_source_exposed: false, secrets_exposed: false,
          x_refresh_forced: false, op_cached_read_only: true,
        },
      },
      now: new Date('2026-08-18T12:01:00.000Z'),
    });

    const card = view.sources.find((source) => source.source_id === 'dropbox.files');
    expect(card?.connection.state).toBe('reauth_required');
    expect(card?.connection.action).toMatchObject({ label: 'Reauthenticate' });
  });

  // R61B: the same refusal with the app key missing routes to Set up, and the
  // detail page built from that exact card must lead with the remediation —
  // never "no control changes this" over a check saying to reconnect.
  test('a refusing provider with no app key routes to setup, end to end', () => {
    const status = fixtureStatus();
    status.corpora = [{
      corpus_id: 'internal.x.bookmarks',
      family: 'x',
      trust_domain: 'internal',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'cloud_allowed',
      configured: true,
      provider: 'x',
      // The store now publishes per-item embedding parity, so the embedding
      // bar has a numerator and the settled line can appear at all.
      counts: { indexed_items: 100, items_with_text: 100, items_embedded: 100 },
      item_metadata_returned: false,
    } as never];
    const scheduler = fixtureScheduler();
    scheduler.sources = [{
      source_id: 'x.bookmarks',
      corpus_id: 'internal.x.bookmarks',
      sync_cadence: 'continuous',
      sync_interval_seconds: 300,
      freshness_threshold_hours: 26,
      freshness_hours: 1,
      stale_sync_anomaly: false,
      tasks: [{ id: 'x.sync', kind: 'sync', running: false, consecutive_failures: 3, last_error_kind: 'api_request_guard' }],
    }];
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      schedulerStatus: scheduler,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      // No client id or secret anywhere: reconnect cannot start.
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    const card = view.sources.find((source) => source.source_id === 'x.bookmarks');
    expect(card?.connection.action).toMatchObject({ kind: 'needs_setup', source: 'x' });

    const html = renderDashboardDetailBody(card!, { now: new Date('2026-07-02T12:00:00.000Z') });
    expect(html).toContain('provider is refusing requests, and reconnecting needs the app key first');
    expect(html).not.toContain('No control on this page changes this one');
  });
});

describe('coverage honesty', () => {
  test('a source that ingested nothing is not reported as fully covered', () => {
    // reauth_required with a dead credential and an empty corpus: the card used
    // to read "100% covered; no stuck work" one line under "0 found · 0 ready".
    const status = fixtureStatus();
    status.corpora = [{
      corpus_id: 'internal.x.bookmarks',
      family: 'x',
      trust_domain: 'internal',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'cloud_allowed',
      configured: true,
      provider: 'x',
      counts: { indexed_items: 0, items_with_text: 0 },
      item_metadata_returned: false,
    } as never];
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const bookmarks = view.sources.find((source) => source.source_id === 'x.bookmarks');

    expect(bookmarks?.coverage.indexed_items).toBe(0);
    expect(bookmarks?.ingestion_health.coverage_percent).toBe(0);
    expect(bookmarks?.ingestion_health.label).toContain('Nothing ingested yet');
    expect(bookmarks?.ingestion_health.label).not.toContain('100% covered');
  });

  test('a part-extracted file corpus reports its true percentage, not a chunk-count 100', () => {
    // The live shape on 2026-08-21: a large Dropbox corpus a fifth of the way
    // through extraction. Each extracted file yields several chunks, so there
    // are more chunks than files and min(items, chunks) reads "fully ready".
    const status = statusWithCorpora([{
      ...dropboxFilesCorpus(100_000, 400_000),
      counts: {
        indexed_items: 100_000,
        tombstoned_items: 0,
        items_with_text: 20_000,
        chunks: 400_000,
        embedded_chunks: 0,
        sync_runs: 1,
      },
    } as SourceIndexStatusResult['corpora'][number]]);

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      ingestionLedger: buildSourceIngestionLedgerSnapshot(status, {
        now: new Date('2026-08-21T12:00:00.000Z'),
      }),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: new Date('2026-08-21T12:00:00.000Z'),
    });
    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files');

    expect(dropbox?.coverage.content_ready_items).toBe(20_000);
    expect(dropbox?.ingestion_health.coverage_percent).toBe(20);
  });

  test('policy-deferred files leave the denominator once the readiness ledger reports them', () => {
    // Same corpus, now with the gated ledger's policy counts present: 50k of
    // the 100k files are media and shelf items nothing is asked to read, so the
    // ratio is 20k over the 50k Olympus is supposed to handle.
    const status = statusWithCorpora([{
      ...dropboxFilesCorpus(100_000, 400_000),
      counts: {
        indexed_items: 100_000,
        tombstoned_items: 0,
        items_with_text: 20_000,
        chunks: 400_000,
        embedded_chunks: 0,
        sync_runs: 1,
        qa_metadata_only_expected: 49_000,
        qa_blocked_policy: 1_000,
      },
    } as SourceIndexStatusResult['corpora'][number]]);

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      ingestionLedger: buildSourceIngestionLedgerSnapshot(status, {
        now: new Date('2026-08-21T12:00:00.000Z'),
      }),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: new Date('2026-08-21T12:00:00.000Z'),
    });
    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files');

    expect(dropbox?.coverage.not_read_by_policy_items).toBe(50_000);
    expect(dropbox?.ingestion_health.coverage_percent).toBe(40);
  });

  test('a corpus that publishes no per-item ready count is not called fully covered', () => {
    // Chunks alone say nothing about how many ITEMS are readable, and the one
    // headline percentage may not answer 100 from a number that cannot support
    // it. Absent is not complete.
    const status = statusWithCorpora([{
      ...dropboxFilesCorpus(1_000, 5_000),
      counts: {
        indexed_items: 1_000,
        tombstoned_items: 0,
        chunks: 5_000,
        embedded_chunks: 0,
        sync_runs: 1,
      },
    } as SourceIndexStatusResult['corpora'][number]]);

    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: new Date('2026-08-21T12:00:00.000Z'),
    });
    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files');

    expect(dropbox?.ingestion_health.coverage_percent).toBe(0);
  });

  test('a source with items still reports its real coverage percentage', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: fixtureStatus(),
      schedulerStatus: fixtureScheduler(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: fixtureHandleRegistry(),
      now: new Date('2026-07-02T12:00:00.000Z'),
    });
    const gmail = view.sources.find((source) => source.source_id === 'gmail.email');

    expect(gmail?.coverage.indexed_items).toBe(40);
    expect(gmail?.ingestion_health.coverage_percent).toBe(100);
    expect(gmail?.ingestion_health.label).toContain('100% covered');
  });
});

describe('dashboard sample retention', () => {
  const base = {
    source_id: 'dropbox.files',
    corpus_id: 'secure_local.dropbox.files',
    content_ready_items: 0,
    queue_waiting: 0,
    queue_active: 0,
    queue_attention: 0,
  };

  test('the sample table stays bounded however long the page is left open', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      // 3000 polls at the 5s page rate is a little over four hours open.
      const start = Date.parse('2026-07-02T08:00:00.000Z');
      for (let poll = 0; poll < 3000; poll += 1) {
        history.record([{
          ...base,
          sampled_at: new Date(start + poll * 5_000).toISOString(),
          indexed_items: poll,
        }]);
      }

      expect(history.sampleCount()).toBeLessThanOrEqual(720);
      expect(history.sampleCount()).toBeGreaterThan(0);
    } finally {
      history.close();
    }
  });

  test('samples older than the retention window are dropped', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      history.record([{ ...base, sampled_at: '2026-07-01T00:00:00.000Z', indexed_items: 1 }]);
      expect(history.sampleCount()).toBe(1);

      history.record([{ ...base, sampled_at: '2026-07-03T00:00:00.000Z', indexed_items: 2 }]);
      expect(history.sampleCount()).toBe(1);
    } finally {
      history.close();
    }
  });

  test('retention leaves enough history for the throughput window', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      const start = Date.parse('2026-07-02T08:00:00.000Z');
      for (let poll = 0; poll < 1000; poll += 1) {
        history.record([{
          ...base,
          sampled_at: new Date(start + poll * 5_000).toISOString(),
          indexed_items: poll,
          queue_waiting: 10,
        }]);
      }
      const last = new Date(start + 999 * 5_000);
      const progress = history.progressFor(
        { ...base, sampled_at: last.toISOString(), indexed_items: 999, queue_waiting: 10 },
        last,
      );

      expect(progress?.indexed_items_per_hour).toBeGreaterThan(0);
    } finally {
      history.close();
    }
  });
});

// Each phase row asks a different question of the history: not "how fast is
// this source going" but "did THIS counter rise, and when". A row whose count
// has not risen inside the retention window is what the page calls stalled.
describe('per-phase movement history', () => {
  const base = {
    source_id: 'dropbox.files',
    corpus_id: 'secure_local.dropbox.files',
    queue_waiting: 0,
    queue_active: 0,
    queue_attention: 0,
  };
  const at = (time: string, counts: { indexed_items: number; content_ready_items: number; embedded_files?: number }) =>
    ({ ...base, sampled_at: time, ...counts });
  /** A sample from a corpus that has finished a pass, carrying its own in-scope total. */
  const settledAt = (
    time: string,
    counts: { indexed_items: number; content_ready_items: number; embedded_files?: number; in_scope_items: number },
  ) => ({ ...base, sampled_at: time, settled_pass: true, ...counts });

  test('records what each phase was worth at the last moment it was complete', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      history.record([settledAt('2026-07-02T11:00:00.000Z', {
        indexed_items: 30_000, content_ready_items: 30_000, embedded_files: 30_000, in_scope_items: 30_000,
      })]);
      // A batch of 12 arrives: 7 read, 2 embedded. Neither phase is complete
      // now, so both keep the baseline the settled sample wrote.
      const current = settledAt('2026-07-02T12:00:00.000Z', {
        indexed_items: 30_012, content_ready_items: 30_007, embedded_files: 30_002, in_scope_items: 30_012,
      });
      history.record([current]);

      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));

      expect(movement?.extraction_settled_value).toBe(30_000);
      expect(movement?.embedding_settled_value).toBe(30_000);
    } finally {
      history.close();
    }
  });

  // NEGATIVE CHECK. A first crawl that reaches parity has not settled a pass,
  // and a baseline taken there would call the rest of the crawl a delta.
  test('records no baseline before the source has finished a pass', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      history.record([{
        ...base,
        sampled_at: '2026-07-02T11:00:00.000Z',
        indexed_items: 30_000,
        content_ready_items: 30_000,
        embedded_files: 30_000,
        in_scope_items: 30_000,
      }]);
      const current = settledAt('2026-07-02T12:00:00.000Z', {
        indexed_items: 30_012, content_ready_items: 30_007, embedded_files: 30_002, in_scope_items: 30_012,
      });
      history.record([current]);

      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));

      expect(movement?.extraction_settled_value).toBeUndefined();
      expect(movement?.embedding_settled_value).toBeUndefined();
    } finally {
      history.close();
    }
  });

  test('forgets a baseline the counter has fallen below', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      history.record([settledAt('2026-07-02T11:00:00.000Z', {
        indexed_items: 30_000, content_ready_items: 30_000, embedded_files: 30_000, in_scope_items: 30_000,
      })]);
      // A re-index empties the read counter. Climbing back to 30,005 is not a
      // five-file batch, so the baseline must not survive the drop.
      history.record([settledAt('2026-07-02T11:30:00.000Z', {
        indexed_items: 30_012, content_ready_items: 0, embedded_files: 0, in_scope_items: 30_012,
      })]);
      const current = settledAt('2026-07-02T12:00:00.000Z', {
        indexed_items: 30_012, content_ready_items: 30_005, embedded_files: 25_000, in_scope_items: 30_012,
      });
      history.record([current]);

      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));

      expect(movement?.extraction_settled_value).toBeUndefined();
      expect(movement?.embedding_settled_value).toBeUndefined();
    } finally {
      history.close();
    }
  });

  test('moves the baseline forward every time a phase completes again', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      history.record([settledAt('2026-07-02T11:00:00.000Z', {
        indexed_items: 30_000, content_ready_items: 30_000, embedded_files: 30_000, in_scope_items: 30_000,
      })]);
      history.record([settledAt('2026-07-02T11:30:00.000Z', {
        indexed_items: 30_012, content_ready_items: 30_007, embedded_files: 30_002, in_scope_items: 30_012,
      })]);
      // The batch drains: the next batch is measured from here, not from 30,000.
      const current = settledAt('2026-07-02T12:00:00.000Z', {
        indexed_items: 30_012, content_ready_items: 30_012, embedded_files: 30_012, in_scope_items: 30_012,
      });
      history.record([current]);

      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));

      expect(movement?.extraction_settled_value).toBe(30_012);
      expect(movement?.embedding_settled_value).toBe(30_012);
    } finally {
      history.close();
    }
  });

  // NEGATIVE CHECK. Embedding is complete only when everything in scope has
  // been read AND embedded; a store running ahead of extraction is not parity.
  test('refuses an embedding baseline while extraction is still behind', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      const current = settledAt('2026-07-02T11:00:00.000Z', {
        indexed_items: 30_012, content_ready_items: 20_000, embedded_files: 30_012, in_scope_items: 30_012,
      });
      history.record([current]);
      history.record([settledAt('2026-07-02T12:00:00.000Z', {
        indexed_items: 30_012, content_ready_items: 20_000, embedded_files: 30_012, in_scope_items: 30_012,
      })]);

      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));

      expect(movement?.embedding_settled_value).toBeUndefined();
    } finally {
      history.close();
    }
  });

  test('adds the settled-baseline columns to a movement ledger written before them', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'olympus-dashboard-settled-migrate-')), 'history.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE source_dashboard_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        corpus_id TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        indexed_items INTEGER NOT NULL,
        content_ready_items INTEGER NOT NULL,
        queue_waiting INTEGER NOT NULL,
        queue_active INTEGER NOT NULL,
        queue_attention INTEGER NOT NULL,
        embedded_files INTEGER
      );
      CREATE TABLE source_dashboard_movement (
        corpus_id TEXT NOT NULL,
        counter TEXT NOT NULL,
        last_value INTEGER NOT NULL,
        rose_at TEXT,
        seen_at TEXT,
        PRIMARY KEY (corpus_id, counter)
      );
    `);
    legacy.run(`
      INSERT INTO source_dashboard_movement (corpus_id, counter, last_value, rose_at, seen_at)
      VALUES ('secure_local.dropbox.files', 'content_ready_items', 30000, '2026-07-02T10:00:00.000Z', '2026-07-02T10:00:00.000Z')
    `);
    legacy.close();

    // The ledger's first two cuts had no baseline. The columns are added in
    // place, and the rows they left carry no baseline rather than a zero — a
    // zero would claim the whole corpus was one batch.
    const history = new SqliteSourceDashboardHistory(dbPath);
    try {
      const carried = settledAt('2026-07-02T11:00:00.000Z', {
        indexed_items: 30_012, content_ready_items: 30_005, embedded_files: 30_000, in_scope_items: 30_012,
      });
      history.record([carried]);
      expect(history.movementFor(carried, new Date('2026-07-02T11:00:00.000Z'))?.extraction_settled_value)
        .toBeUndefined();

      const settled = settledAt('2026-07-02T12:00:00.000Z', {
        indexed_items: 30_012, content_ready_items: 30_012, embedded_files: 30_012, in_scope_items: 30_012,
      });
      history.record([settled]);
      expect(history.movementFor(settled, new Date('2026-07-02T12:00:00.000Z'))?.extraction_settled_value)
        .toBe(30_012);
    } finally {
      history.close();
    }
  });

  test('reports the sample at which each counter was first seen higher', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      history.record([at('2026-07-02T11:00:00.000Z', { indexed_items: 90, content_ready_items: 40, embedded_files: 10 })]);
      history.record([at('2026-07-02T11:30:00.000Z', { indexed_items: 100, content_ready_items: 40, embedded_files: 20 })]);
      const current = at('2026-07-02T12:00:00.000Z', { indexed_items: 100, content_ready_items: 60, embedded_files: 30 });
      history.record([current]);

      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));

      // The rise is dated to the sample that first carried the higher value —
      // 11:30 for indexed items (90 -> 100), now for the two that rose now.
      expect(movement?.metadata_sync_at).toBe('2026-07-02T11:30:00.000Z');
      expect(movement?.extraction_at).toBe('2026-07-02T12:00:00.000Z');
      expect(movement?.embedding_at).toBe('2026-07-02T12:00:00.000Z');
    } finally {
      history.close();
    }
  });

  test('a first observation is a value, not a rise', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      const sample = at('2026-07-02T12:00:00.000Z', { indexed_items: 100, content_ready_items: 60, embedded_files: 30 });
      history.record([sample]);

      // Nothing has been seen lower, so no counter has a movement time: an
      // absent time is "no movement seen", a different sentence from "moved
      // at the start of the window".
      expect(history.movementFor(sample, new Date('2026-07-02T12:00:00.000Z'))).toBeUndefined();
    } finally {
      history.close();
    }
  });

  test('a counter that did not rise says nothing while the others do', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      history.record([at('2026-07-02T11:00:00.000Z', { indexed_items: 100, content_ready_items: 60, embedded_files: 30 })]);
      const current = at('2026-07-02T12:00:00.000Z', { indexed_items: 120, content_ready_items: 60, embedded_files: 30 });
      history.record([current]);

      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));

      expect(movement?.metadata_sync_at).toBe('2026-07-02T12:00:00.000Z');
      expect(movement?.extraction_at).toBeUndefined();
      expect(movement?.embedding_at).toBeUndefined();
    } finally {
      history.close();
    }
  });

  test('an unmeasured embedded count never touches the ledger or backdates a rise', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      history.record([at('2026-07-02T11:00:00.000Z', { indexed_items: 90, content_ready_items: 40, embedded_files: 10 })]);
      // A sample with no per-item count in between: not evidence of anything.
      history.record([at('2026-07-02T11:30:00.000Z', { indexed_items: 90, content_ready_items: 40 })]);
      const current = at('2026-07-02T12:00:00.000Z', { indexed_items: 90, content_ready_items: 40, embedded_files: 20 });
      history.record([current]);

      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));

      // 10 -> (unmeasured) -> 20: the rise was observed at 12:00, not at the
      // unmeasured 11:30 sample the old series query used to report.
      expect(movement?.embedding_at).toBe('2026-07-02T12:00:00.000Z');
      expect(movement?.metadata_sync_at).toBeUndefined();
    } finally {
      history.close();
    }
  });

  test('a rise survives the sample series being trimmed by request volume', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      history.record([at('2026-07-02T10:00:00.000Z', { indexed_items: 90, content_ready_items: 40, embedded_files: 10 })]);
      history.record([at('2026-07-02T11:10:00.000Z', { indexed_items: 100, content_ready_items: 40, embedded_files: 10 })]);
      // Four open pages polling: far more samples than the per-corpus cap keeps.
      const flood: SourceDashboardHistorySample[] = [];
      for (let index = 0; index < 900; index += 1) {
        flood.push(at(new Date(Date.parse('2026-07-02T11:10:01.000Z') + index * 3_000).toISOString(),
          { indexed_items: 100, content_ready_items: 40, embedded_files: 10 }));
      }
      history.record(flood);
      const current = at('2026-07-02T12:00:00.000Z', { indexed_items: 100, content_ready_items: 40, embedded_files: 10 });
      history.record([current]);

      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));

      // The 11:10 rise is no longer in the retained series, and is still known.
      expect(history.sampleCount()).toBeLessThan(900);
      expect(movement?.metadata_sync_at).toBe('2026-07-02T11:10:00.000Z');
    } finally {
      history.close();
    }
  });

  test('a counter that drops keeps its last rise rather than inventing one', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      history.record([at('2026-07-02T11:00:00.000Z', { indexed_items: 90, content_ready_items: 40, embedded_files: 10 })]);
      history.record([at('2026-07-02T11:10:00.000Z', { indexed_items: 100, content_ready_items: 40, embedded_files: 10 })]);
      history.record([at('2026-07-02T11:20:00.000Z', { indexed_items: 50, content_ready_items: 40, embedded_files: 10 })]);
      const current = at('2026-07-02T12:00:00.000Z', { indexed_items: 50, content_ready_items: 40, embedded_files: 10 });
      history.record([current]);

      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));

      expect(movement?.metadata_sync_at).toBe('2026-07-02T11:10:00.000Z');
    } finally {
      history.close();
    }
  });

  test('adds seen_at to a movement ledger written before it existed, and backfills it', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'olympus-dashboard-movement-migrate-')), 'history.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE source_dashboard_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        corpus_id TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        indexed_items INTEGER NOT NULL,
        content_ready_items INTEGER NOT NULL,
        queue_waiting INTEGER NOT NULL,
        queue_active INTEGER NOT NULL,
        queue_attention INTEGER NOT NULL,
        embedded_files INTEGER
      );
      CREATE TABLE source_dashboard_movement (
        corpus_id TEXT NOT NULL,
        counter TEXT NOT NULL,
        last_value INTEGER NOT NULL,
        rose_at TEXT,
        PRIMARY KEY (corpus_id, counter)
      );
    `);
    legacy.run(`
      INSERT INTO source_dashboard_movement (corpus_id, counter, last_value, rose_at)
      VALUES ('secure_local.dropbox.files', 'indexed_items', 100, '2026-07-02T11:10:00.000Z')
    `);
    legacy.close();

    // The first cut of the ledger had no seen_at; every write now needs it,
    // so the column is added in place and old rows are dated to their rise —
    // at construction, before any write could paper over a missing backfill.
    const seenAt = () => {
      const raw = new Database(dbPath, { readonly: true });
      try {
        return (raw.query(
          "SELECT seen_at FROM source_dashboard_movement WHERE corpus_id = 'secure_local.dropbox.files' AND counter = 'indexed_items'",
        ).get() as { seen_at: string | null }).seen_at;
      } finally {
        raw.close();
      }
    };
    const migrated = new SqliteSourceDashboardHistory(dbPath);
    try {
      expect(seenAt()).toBe('2026-07-02T11:10:00.000Z');
    } finally {
      migrated.close();
    }
    // Reopening is idempotent: the backfilled row is not rewritten.
    const history = new SqliteSourceDashboardHistory(dbPath);
    try {
      expect(seenAt()).toBe('2026-07-02T11:10:00.000Z');
      const current = at('2026-07-02T12:00:00.000Z', { indexed_items: 100, content_ready_items: 60, embedded_files: 30 });
      history.record([current]);
      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));
      expect(movement?.metadata_sync_at).toBe('2026-07-02T11:10:00.000Z');
      expect(seenAt()).toBe('2026-07-02T12:00:00.000Z');
    } finally {
      history.close();
    }
  });

  test('adds the embedded_files column and the movement ledger to a store written before they existed', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'olympus-dashboard-history-migrate-')), 'history.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE source_dashboard_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        corpus_id TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        indexed_items INTEGER NOT NULL,
        content_ready_items INTEGER NOT NULL,
        queue_waiting INTEGER NOT NULL,
        queue_active INTEGER NOT NULL,
        queue_attention INTEGER NOT NULL
      );
    `);
    legacy.run(`
      INSERT INTO source_dashboard_samples
        (source_id, corpus_id, sampled_at, indexed_items, content_ready_items, queue_waiting, queue_active, queue_attention)
      VALUES ('dropbox.files', 'secure_local.dropbox.files', '2026-07-02T11:00:00.000Z', 90, 40, 0, 0, 0)
    `);
    legacy.close();

    // CREATE TABLE IF NOT EXISTS leaves the old table alone, so the column has
    // to be added in place or every write against it fails.
    const history = new SqliteSourceDashboardHistory(dbPath);
    try {
      history.record([at('2026-07-02T11:30:00.000Z', { indexed_items: 100, content_ready_items: 60, embedded_files: 20 })]);
      const current = at('2026-07-02T12:00:00.000Z', { indexed_items: 100, content_ready_items: 60, embedded_files: 30 });
      history.record([current]);

      const movement = history.movementFor(current, new Date('2026-07-02T12:00:00.000Z'));

      expect(history.sampleCount()).toBe(3);
      // The legacy row predates the ledger, so the first post-migration
      // sample is a first observation; only the embedded count rose after it.
      expect(movement?.embedding_at).toBe('2026-07-02T12:00:00.000Z');
      expect(movement?.metadata_sync_at).toBeUndefined();
    } finally {
      history.close();
    }
  });
});

describe('throughput and ETA honesty', () => {
  const base = {
    source_id: 'dropbox.files',
    corpus_id: 'secure_local.dropbox.files',
    content_ready_items: 0,
    queue_active: 0,
    queue_attention: 0,
  };

  test('a rate that rounds to zero reports no progress instead of an infinite ETA', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      // One item in 40 hours: round1(0.025) is 0, and the ETA divided by it.
      history.record([{ ...base, sampled_at: '2026-07-01T00:00:00.000Z', indexed_items: 100, queue_waiting: 10 }]);
      const progress = history.progressFor(
        { ...base, sampled_at: '2026-07-02T16:00:00.000Z', indexed_items: 101, queue_waiting: 10 },
        new Date('2026-07-02T16:00:00.000Z'),
      );

      expect(progress).toBeUndefined();
      expect(JSON.stringify({ progress })).not.toContain('null');
    } finally {
      history.close();
    }
  });

  test('a single inter-poll delta is too short a window to extrapolate a rate from', () => {
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      // The browser polls every 5s and each poll records a sample, so the
      // preceding row is normally 5 seconds old. One item over 5 seconds used
      // to be reported as 720 items per hour.
      history.record([{ ...base, sampled_at: '2026-07-02T15:59:55.000Z', indexed_items: 100, queue_waiting: 10 }]);
      const tooSoon = history.progressFor(
        { ...base, sampled_at: '2026-07-02T16:00:00.000Z', indexed_items: 101, queue_waiting: 10 },
        new Date('2026-07-02T16:00:00.000Z'),
      );

      history.record([{ ...base, sampled_at: '2026-07-02T15:50:00.000Z', indexed_items: 90, queue_waiting: 10 }]);
      const wideEnough = history.progressFor(
        { ...base, sampled_at: '2026-07-02T16:00:00.000Z', indexed_items: 100, queue_waiting: 10 },
        new Date('2026-07-02T16:00:00.000Z'),
      );

      expect(tooSoon).toBeUndefined();
      expect(wideEnough).toEqual({ indexed_items_per_hour: 60, eta_minutes: 10 });
    } finally {
      history.close();
    }
  });

});

function dashboardSignatureFromHtml(html: string): (view: unknown) => string {
  const declaration = html.match(/ {6}function dashboardSignature\(view\) \{[\s\S]*?\n {6}\}/)?.[0];
  if (!declaration) throw new Error('dashboardSignature is not defined in the rendered page');
  return new Function(`${declaration}; return dashboardSignature(arguments[0]);`) as (view: unknown) => string;
}

function signatureFixtureView(
  options: { readiness: string; askEnabled: boolean; askStep: 'active' | 'pending' },
): unknown {
  return {
    onboarding: {
      ask_first_question: { enabled: options.askEnabled },
      steps: [
        { id: 'connect_sources', state: 'complete' },
        { id: 'first_sync', state: 'complete' },
        { id: 'where_data_lives', state: 'complete' },
        { id: 'ask_first_question', state: options.askStep },
      ],
    },
    answer_lanes: [{ source_id: 'venice.api', connection: { state: 'validated', label: 'key present + validated' } }],
    sources: [{
      source_id: 'dropbox.files',
      connection: { state: 'synced', label: 'synced' },
      answer_readiness: { state: options.readiness },
      coverage: { indexed_items: 120, content_ready_items: 4, embedded_items: 0 },
      queue_health: { waiting: 0, needs_attention: 0 },
    }],
  };
}

function emptyFixtureStatus(): SourceIndexStatusResult {
  const status = fixtureStatus();
  status.corpora = [];
  return status;
}

function indexedWithoutTextStatus(): SourceIndexStatusResult {
  const status = fixtureStatus();
  status.corpora = [{
    corpus_id: 'secure_local.dropbox.files',
    family: 'file',
    trust_domain: 'secure_local',
    activation_mode: 'lexical_only',
    embedding_policy: 'local_only',
    configured: true,
    provider: 'dropbox',
    read_authority: 'connector_store',
    counts: {
      indexed_items: 120,
      tombstoned_items: 0,
      files_with_text: 0,
      chunks: 0,
      embedded_chunks: 0,
      sync_runs: 1,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  }];
  return status;
}

function fixtureStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-07-02T12:00:00.000Z',
    corpora: [
      {
        corpus_id: 'internal.email',
        family: 'email',
        trust_domain: 'internal',
        activation_mode: 'hybrid_primary',
        embedding_policy: 'cloud_allowed_by_policy',
        configured: true,
        provider: 'gmail',
        read_authority: 'connector_store',
        counts: {
          accounts: 1,
          indexed_items: 40,
          tombstoned_items: 0,
          threads: 32,
          internal_chunks: 40,
          chunks: 40,
          items_with_text: 40,
          embedded_chunks: 20,
          sync_runs: 1,
        },
        item_metadata_returned: false,
        skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
      },
      {
        corpus_id: 'internal.drive.docs',
        family: 'file',
        trust_domain: 'internal',
        activation_mode: 'hybrid_primary',
        embedding_policy: 'cloud_allowed_by_policy',
        configured: true,
        provider: 'google_drive',
        read_authority: 'connector_store',
        counts: {
          accounts: 1,
          indexed_items: 10,
          tombstoned_items: 0,
          google_docs: 3,
          files_with_text: 0,
          internal_chunks: 0,
          chunks: 0,
          sync_runs: 1,
          retrieval_audits: 0,
          semantic_runs: 0,
          embedding_models: 0,
          embedded_chunks: 0,
        },
        item_metadata_returned: false,
        skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
      },
      {
        corpus_id: 'internal.readwise.library',
        family: 'readwise',
        trust_domain: 'internal',
        activation_mode: 'hybrid_primary',
        embedding_policy: 'cloud_allowed',
        configured: false,
        provider: 'readwise',
        read_authority: 'connector_store',
        item_metadata_returned: false,
        skipped_item_metadata_reason: 'source_index_not_configured',
      },
    ],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

function googleConnectorStoreFixtureStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-07-02T12:00:00.000Z',
    corpora: [
      googleConnectorStoreCorpus('internal.email', 'email', 'internal', 'gmail', 17, 18),
      googleConnectorStoreCorpus('secure_local.email.private', 'email', 'secure_local', 'gmail', 1, 1),
      googleConnectorStoreCorpus('internal.drive.docs', 'file', 'internal', 'google_drive', 1, 1),
      googleConnectorStoreCorpus('secure_local.drive.docs', 'file', 'secure_local', 'google_drive', 0, 0),
    ],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

function googleConnectorStoreCorpus(
  corpusId: string,
  family: 'email' | 'file',
  trustDomain: 'internal' | 'secure_local',
  provider: 'gmail' | 'google_drive',
  indexedItems: number,
  chunks: number,
): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: corpusId,
    family,
    trust_domain: trustDomain,
    activation_mode: 'hybrid_primary',
    embedding_policy: trustDomain === 'secure_local' ? 'local_only' : 'cloud_allowed_by_policy',
    configured: true,
    provider,
    read_authority: 'connector_store',
    counts: {
      indexed_items: indexedItems,
      tombstoned_items: 0,
      chunks,
      // A fully-read fixture corpus: every item the store holds has text. The
      // store publishes this per-item count itself, so a fixture that omits it
      // is modelling a payload the connector store does not emit.
      items_with_text: Math.min(indexedItems, chunks),
      embedded_chunks: 0,
      sync_runs: 1,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  } as SourceIndexStatusResult['corpora'][number];
}

function fixtureScheduler(): SourceSchedulerStatus {
  return {
    kind: 'source_scheduler_status',
    enabled: true,
    running: true,
    generated_at: '2026-07-02T12:00:00.000Z',
    sources: [
      {
        source_id: 'gmail.email',
        corpus_id: 'internal.email',
        sync_cadence: 'continuous',
        sync_interval_seconds: 300,
        freshness_threshold_hours: 26,
        freshness_hours: 1,
        stale_sync_anomaly: false,
        tasks: [],
      },
      {
        source_id: 'google_drive.docs',
        corpus_id: 'internal.drive.docs',
        sync_cadence: 'continuous',
        sync_interval_seconds: 300,
        freshness_threshold_hours: 26,
        freshness_hours: 30,
        stale_sync_anomaly: true,
        tasks: [{ id: 'drive.sync', kind: 'sync', running: false, consecutive_failures: 1 }],
      },
    ],
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      counts_only: true,
    },
  };
}

function statusWithInternalEmailCount(indexedItems: number, internalChunks: number): SourceIndexStatusResult {
  const status = fixtureStatus();
  status.corpora = [status.corpora[0]!];
  (status.corpora[0] as any).counts.indexed_items = indexedItems;
  (status.corpora[0] as any).counts.internal_chunks = internalChunks;
  return status;
}

function schedulerWithQueue(waiting: number): SourceSchedulerStatus {
  const scheduler = fixtureScheduler();
  scheduler.sources = [{
    source_id: 'gmail.email',
    corpus_id: 'internal.email',
    sync_cadence: 'continuous',
    sync_interval_seconds: 300,
    freshness_threshold_hours: 26,
    freshness_hours: 1,
    stale_sync_anomaly: false,
    tasks: [{ id: 'email.sync', kind: 'sync', running: false, consecutive_failures: 0 }],
  }];
  (scheduler.sources[0]!.tasks[0] as any).last_result = {
    status: 'progress',
    counts: { jobs_queued: waiting },
  };
  return scheduler;
}

function googleHandleRegistry(): ConnectedHandleRegistry {
  return {
    version: 1,
    handles: [
      gmailHandle('gmail.personal'),
      {
        handle: 'google_drive.personal',
        provider: 'google_drive',
        accountRole: 'personal',
        trustDomain: 'internal',
        allowedCapabilities: ['google_drive.docs.sync'],
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        connectedAt: '2026-07-02T10:00:00.000Z',
      },
    ],
  };
}

function fixtureSovereigntyEngine() {
  return createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
  }));
}

const PARKED_NOW = new Date('2026-07-02T12:00:00.000Z');

/**
 * The live 2026-08-21 x.bookmarks shape: a lane the daily budget parked, with
 * an index full of answerable bookmarks and a failure count left over from
 * before the guard stopped it.
 *
 * `degradedReason: undefined` removes only the park, which is what makes the
 * park itself the variable under test rather than the fixture.
 */
function parkedBookmarksCard(input: {
  degradedReason?: string | undefined;
  freshnessHours?: number;
  stale?: boolean;
  counts?: Record<string, number>;
}) {
  const degradedReason = 'degradedReason' in input ? input.degradedReason : 'daily_cost_guard';
  const status = fixtureStatus();
  status.corpora = [{
    corpus_id: 'internal.x.bookmarks',
    family: 'x',
    trust_domain: 'internal',
    activation_mode: 'hybrid_primary',
    embedding_policy: 'cloud_allowed',
    configured: true,
    provider: 'x',
    counts: { indexed_items: 100, items_with_text: 100, items_embedded: 100, ...input.counts },
    item_metadata_returned: false,
  } as never];
  const scheduler = fixtureScheduler();
  scheduler.sources = [{
    source_id: 'x.bookmarks',
    corpus_id: 'internal.x.bookmarks',
    sync_cadence: 'continuous',
    sync_interval_seconds: 300,
    freshness_threshold_hours: 26,
    freshness_hours: input.freshnessHours ?? 1,
    stale_sync_anomaly: input.stale ?? false,
    tasks: [{
      id: 'x.sync',
      kind: 'sync',
      running: false,
      // History, not news: the guard stopped the lane carrying whatever it had
      // last recorded on the way in.
      consecutive_failures: 3,
      last_error_kind: 'api_request_guard',
      ...(degradedReason !== undefined ? { degraded_reason: degradedReason } : {}),
    }],
  }];
  const view = buildSourceDashboardViewModel({
    sourceIndexStatus: status,
    schedulerStatus: scheduler,
    sovereigntyEngine: fixtureSovereigntyEngine(),
    connectedHandleRegistry: fixtureHandleRegistry(),
    oauthClientIds: { x: 'x-client-id-fixture' },
    oauthClientSecretAvailability: { x: true },
    now: PARKED_NOW,
  });
  return view.sources.find((source) => source.source_id === 'x.bookmarks');
}

function schedulerConfig() {
  return {
    worker: {
      scheduler: {
        enabled: true,
        tickSeconds: 1,
        syncIntervalSeconds: 300,
        freshnessThresholdHours: 24,
        errorBackoffSeconds: 30,
        maxTransientRetries: 1,
      },
    },
  } as any;
}

function inMemoryHistory(): SourceDashboardHistory {
  return {
    record() {},
    progressFor() {
      return undefined;
    },
    sampleCount() {
      return 0;
    },
  };
}

function fixtureHandleRegistry(): ConnectedHandleRegistry {
  return {
    version: 1,
    handles: [
      gmailHandle('gmail.personal'),
      {
        handle: 'google_drive.personal',
        provider: 'google_drive',
        accountRole: 'personal',
        trustDomain: 'internal',
        allowedCapabilities: ['google_drive.docs.sync'],
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        backendState: { kind: 'mtproto_session', status: 'reauth_required' },
        connectedAt: '2026-07-02T10:00:00.000Z',
      },
      {
        handle: 'x.bookmarks.personal',
        provider: 'x',
        accountRole: 'personal',
        trustDomain: 'internal',
        allowedCapabilities: ['x.bookmarks.sync'],
        scopes: ['tweet.read'],
        connectedAt: '2026-07-02T10:00:00.000Z',
      },
    ],
  };
}

function gmailHandle(handle: string): ConnectedHandleRegistry['handles'][number] {
  return {
    handle,
    provider: 'gmail',
    accountRole: 'personal',
    trustDomain: 'secure_local',
    allowedCapabilities: ['gmail.email.sync'],
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    connectedAt: '2026-07-02T10:00:00.000Z',
  };
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

/**
 * A worker whose OAuth start is stubbed, so a test can read the redirect_uri
 * the route composed without a provider on the other end of it.
 */
function oauthStartFixture(store: SecretStore | Record<string, string> = {}): {
  fetch: (request: Request) => Promise<Response>;
  redirectUris: string[];
  secretStore: SecretStore;
} {
  const secretStore = typeof (store as SecretStore).get === 'function'
    ? store as SecretStore
    : memorySecretStore(store as Record<string, string>);
  const redirectUris: string[] = [];
  const worker = createEmailSourceWorker({
    sourceDashboard: {
      sovereigntyEngine: fixtureSovereigntyEngine(),
      secretStore,
      startExternalOAuthConnection: async (options) => {
        redirectUris.push(options.redirectUri);
        return {
          ok: true,
          source: options.source,
          // On the provider's real origin: the start route refuses anything
          // else before relaying (R61E).
          authorizationUrl: 'https://x.com/i/oauth2/authorize?state=state-fixture',
          redirectUri: options.redirectUri,
          state: 'state-fixture',
          startedAt: '2026-07-02T12:00:00.000Z',
          expiresAt: '2026-07-02T12:10:00.000Z',
          completeCallback: async () => {
            throw new Error('not used');
          },
          cancel() {},
        };
      },
    },
  });
  return {
    fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' }),
    redirectUris,
    secretStore,
  };
}

function sourceState(view: ReturnType<typeof buildSourceDashboardViewModel>, sourceId: string): string | undefined {
  return view.sources.find((source) => source.source_id === sourceId)?.connection.state;
}

function answerLaneState(view: ReturnType<typeof buildSourceDashboardViewModel>, laneId: string): string | undefined {
  return view.answer_lanes.find((lane) => lane.lane_id === laneId)?.connection.state;
}

function xStoreSyncFixture(
  requests: Array<{ task: string; provenance?: string }>,
): XBookmarksConnectorStoreSyncHandler {
  const usage = (): XApiUsageStatus => ({
    utc_day: '2026-07-07',
    api_requests: 1,
    resource_reads: 1,
    estimated_billable_resources: 1,
    reserved_resource_reads: 0,
    estimated_spend_microusd: 1_000,
    estimated_spend_usd: 0.001,
    estimated_unit_cost_usd: 0.001,
    estimate: true,
    hard_budgets: {
      api_requests: 4_000,
      resource_reads: 10_000,
      estimated_spend_microusd: 2_000_000,
    },
    guard: { state: 'ok' },
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      resource_ids_exposed: false,
      provider_cursor_exposed: false,
    },
  });
  const result = (): XBookmarksLiveSyncResult => ({
    status: 'idle',
    counts: {},
    api_usage: usage(),
  });
  const record = (task: string) => async (request: { provenance?: string } = {}) => {
    requests.push({ task, ...(request.provenance ? { provenance: request.provenance } : {}) });
    return result();
  };
  return {
    syncHead: record('head'),
    reconcile: record('reconcile'),
    diagnoseWindow: record('window_diagnostic'),
    lastCompleteReconcileAt: () => undefined,
    completeReconcileWatermark: () => undefined,
    apiUsageStatus: usage,
  };
}

function readwiseStoreSyncFixture(requests: unknown[]): ReadwiseConnectorStoreSyncHandler {
  const counts = {
    api_requests: 1,
    daily_api_request_budget: 100,
    items_seen: 1,
    items_indexed: 1,
    items_changed: 1,
    items_tombstoned: 0,
    items_rejected: 0,
    chunks_indexed: 1,
    chunks_embedded: 1,
    resumed_from_checkpoint: 0,
    resume_cursor_rejected: 0,
    traversal_complete: 1,
    absence_authoritative: 0,
  };
  const policy = {
    counts_only: true as const,
    raw_source_exposed: false as const,
    source_text_returned: false as const,
    provider_cursor_exposed: false as const,
  };
  const taskOutcome = (kind: 'readwise_connector_store_pull_receipt' | 'readwise_connector_store_reconcile_receipt') => ({
    receipt: {
      kind,
      status: 'progress' as const,
      counts,
      api_usage: { utc_day: '2026-07-07' },
      policy: {
        ...policy,
        absence_authority: 'partial_window' as const,
        tombstones_applied: false as const,
      },
      receipt_sha256: 'a'.repeat(64),
    },
    checkpoint: null,
  });
  return {
    async sync() {
      requests.push({ mode: 'sync' });
      return {
        status: 'progress',
        counts,
        api_usage: { utc_day: '2026-07-07' },
        policy,
      };
    },
    async pull(request) {
      requests.push({ mode: 'pull', ...request });
      return taskOutcome('readwise_connector_store_pull_receipt');
    },
    async reconcile(request) {
      requests.push({ mode: 'reconcile', ...request });
      return taskOutcome('readwise_connector_store_reconcile_receipt');
    },
    lastStoreRunCompletedAt: () => undefined,
    requestBudgetStatus: () => ({}) as never,
  };
}

function gmailSyncFixture(requests: unknown[], handle: string): GmailConnectorStoreSyncHandler {
  const summary = (corpusId: string, trustDomain: 'internal' | 'secure_local') => ({
    syncRunId: 'gmail-sync-fixture',
    status: 'completed' as const,
    connectorId: 'gmail',
    corpusId,
    itemsSeen: 1,
    itemsIndexed: 1,
    itemsChanged: 1,
    itemsTombstoned: 0,
    itemsRejected: 0,
    // This fixture configures no exclusions, so the gate kept nothing out.
    itemsExcluded: 0,
    exclusions: { items_excluded: 0, items_excluded_unevaluable: 0, by_prefix: [] },
    // Nor did it admit anything without its content.
    itemsMetadataOnly: 0,
    metadataOnly: { items_excluded: 0, items_excluded_unevaluable: 0, by_prefix: [] },
    chunksIndexed: 1,
    traversalComplete: true,
    gaps: [],
    policy: {
      rawSourceExposed: false as const,
      sourceTextReturned: false as const,
      storage: 'local_sqlite' as const,
      trustDomain,
    },
  });
  const outcome = (kind: GmailConnectorStoreReceipt['kind']): GmailConnectorStoreTaskOutcome => {
    const receipt: Omit<GmailConnectorStoreReceipt, 'receipt_sha256'> = {
      kind,
      status: 'progress',
      counts: {
        api_requests: 1,
        daily_api_request_budget: 5_000,
        provider_traversals: 1,
        items_seen: 1,
        fetch_item_cache_hits: 0,
        attachments_declared: 0,
        attachment_bytes_declared: 0,
      attachments_not_ingested: 0,
      items_skipped_otp: 0,
      items_skipped_category: 0,
        internal_items_indexed: 1,
        internal_items_tombstoned: 0,
        internal_items_rejected: 0,
        internal_chunks_indexed: 1,
        internal_chunks_embedded: 0,
        secure_items_indexed: 0,
        secure_items_tombstoned: 0,
        secure_items_rejected: 0,
        secure_chunks_indexed: 0,
        secure_chunks_embedded: 0,
        resumed_from_checkpoint: 0,
        resume_cursor_rejected: 0,
        traversal_complete: 1,
        absence_authoritative: 0,
      },
      api_usage: { utc_day: '2026-07-27' },
      policy: {
        counts_only: true,
        raw_source_exposed: false,
        source_text_returned: false,
        provider_cursor_exposed: false,
        absence_authority: 'partial_window',
        tombstones_applied: false,
      },
    };
    return {
      receipt: { ...receipt, receipt_sha256: gmailReceiptDigest(receipt) },
      checkpoint: null,
    };
  };
  return {
    async sync(request) {
      requests.push({ handle, task: 'sync', request });
      return {
        provider: 'gmail',
        account: 'personal',
        internal: summary(GMAIL_CONNECTOR_CORPUS_ID, 'internal'),
        secure: summary('secure_local.email.private', 'secure_local'),
      };
    },
    async pull(request) {
      requests.push({ handle, task: 'pull', request });
      return outcome('gmail_connector_store_pull_receipt');
    },
    async reconcile(request) {
      requests.push({ handle, task: 'reconcile', request });
      return outcome('gmail_connector_store_reconcile_receipt');
    },
    lastStoreRunCompletedAt: () => undefined,
    requestBudgetStatus: () => undefined,
  };
}
