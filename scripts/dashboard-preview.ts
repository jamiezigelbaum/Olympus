// Local design-iteration harness for the source dashboard.
// Serves renderDashboardHtmlRoute with fixture data in three states so the
// pages can be audited in a real browser without a live worker or real
// credentials. Never used in production; carries no secrets.
//
//   bun scripts/dashboard-preview.ts            # http://127.0.0.1:8930
//   /            mid-onboarding state (default)
//   /fresh       brand-new install, nothing connected
//   /full        everything connected incl. tier splits + attention states
//   /connect-google, /connect-google-loopback, /connect-dropbox, /connect-x
//                one provider's connect walkthrough on its own route, and
//   /connect-dropbox-refused the same card after the provider refused the
//                callback. Add ?setup to read them on the setup page.
//   /connect-dropbox-publisher, /connect-google-publisher
//                publisher-app mode: one Connect button, with the
//                bring-your-own walkthrough behind "Use my own app instead".
//   ?source=<id> / ?setup / ?background select the same subpages the worker
//   serves on any of the three states.
//   Append ?token=dash_<anything> to carry the read-only dashboard URL, and
//   &controls=connected to preview the short-lived browser control session.
//
// TRACKED FOR V2, registered and not built (owner ruling, 2026-08-18): naming
// these three fixtures in the reader's terms rather than the harness's —
// "mid-onboarding" is what /partial actually is, and the route names should
// say so.
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { renderDashboardHtmlRoute } from '../src/workers/dashboard/index.ts';
import { renderEmbeddingLedgerPage } from '../src/workers/dashboard/pages/embedding-ledger.ts';
import type { ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import type { SourceSchedulerStatus } from '../src/workers/source-scheduler.ts';

const NOW = new Date('2026-07-07T21:00:00.000Z');
// A corpus no dashboard card owns. Every registry corpus has a card today, so
// the fixture names a store-only corpus id directly.
const UNCLAIMED_CORPUS_ID = 'internal.domain-library.derivatives';
const PREVIEW_GOOGLE_CLIENT_ID = 'olympus-pilot-preview.apps.googleusercontent.com';
// The https origin a dashboard reached through a tailnet proxy derives its
// callback from. It is what makes the redirect-URI block, the Web-application
// Google guidance, and the provider-refusal card visible in the preview — the
// exact shape that broke live on 2026-09-03 and could not be reviewed before.
const PREVIEW_REDIRECT_BASE_URL = 'https://olympus.preview-tailnet.ts.net';

function corpus(
  corpusId: string,
  family: string,
  trustDomain: 'public_safe' | 'internal' | 'secure_local',
  provider: string,
  indexedItems: number,
  chunks: number,
  // Per-item readiness the live store publishes: items with text (extracted)
  // and items whose every chunk is embedded on the current model. Defaults
  // keep the older fixtures' shape — nothing read, nothing embedded.
  readiness: { withText?: number; embedded?: number } = {},
): SourceIndexStatusResult['corpora'][number] {
  const withText = readiness.withText ?? 0;
  const embedded = Math.min(withText, readiness.embedded ?? 0);
  return {
    corpus_id: corpusId,
    family,
    trust_domain: trustDomain,
    activation_mode: trustDomain === 'secure_local' ? 'lexical_only' : 'hybrid_primary',
    embedding_policy: trustDomain === 'secure_local' ? 'local_only' : 'cloud_allowed_by_policy',
    configured: true,
    provider,
    counts: {
      indexed_items: indexedItems,
      tombstoned_items: 0,
      chunks,
      embedded_chunks: chunks > 0 && withText > 0 ? Math.round(chunks * (embedded / withText)) : 0,
      sync_runs: 1,
      items_with_text: withText,
      items_embedded: embedded,
    },
    ...(chunks > 0
      ? {
        embedding_parity: {
          required: true,
          chunks,
          embedded_chunks: withText > 0 ? Math.round(chunks * (embedded / withText)) : 0,
          missing_chunks: chunks - (withText > 0 ? Math.round(chunks * (embedded / withText)) : 0),
          refresh_needed: embedded < withText,
        },
      }
      : {}),
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  } as unknown as SourceIndexStatusResult['corpora'][number];
}

function emptyStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: NOW.toISOString(),
    corpora: [],
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

function fullStatus(): SourceIndexStatusResult {
  const status = emptyStatus();
  status.corpora = [
    // Gmail: fully read, embedding part-way — the owner's live 37% case.
    corpus('internal.email', 'email', 'internal', 'gmail', 17, 18, { withText: 17, embedded: 6 }),
    corpus('secure_local.email.private', 'email', 'secure_local', 'gmail', 1, 1, { withText: 1, embedded: 1 }),
    // Drive: synced, nothing extracted, lane silent — the stalled case.
    corpus('internal.drive.docs', 'file', 'internal', 'google_drive', 1, 1),
    corpus('secure_local.drive.docs', 'file', 'secure_local', 'google_drive', 0, 0),
    corpus('internal.readwise.library', 'readwise', 'internal', 'readwise', 250, 250, { withText: 250, embedded: 250 }),
    corpus('secure_local.dropbox.files', 'file', 'secure_local', 'dropbox', 4000, 4000, { withText: 2000, embedded: 0 }),
    // The two chat sources, which own no credential-broker handle: the live
    // shape that used to read "not connected — Pairing required" over a full
    // corpus. Neither appears in the handle registry below, deliberately.
    corpus('internal.telegram.messages', 'chat', 'internal', 'telegram', 185_000, 185_000, { withText: 185_000, embedded: 185_000 }),
    corpus('secure_local.whatsapp.messages', 'chat', 'secure_local', 'whatsapp', 18_900, 18_900, { withText: 18_900, embedded: 18_900 }),
    // Owned by no card: exercises the "Indexed, but not on a card above" block.
    corpus(UNCLAIMED_CORPUS_ID, 'file', 'internal', 'domain_library', 42, 42),
  ];
  return status;
}

function scheduler(sources: SourceSchedulerStatus['sources']): SourceSchedulerStatus {
  return {
    kind: 'source_scheduler_status',
    enabled: true,
    running: true,
    generated_at: NOW.toISOString(),
    sources,
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      counts_only: true,
    },
  };
}

function schedulerSource(sourceId: string, corpusId: string, freshnessHours: number, failures = 0) {
  return {
    source_id: sourceId,
    corpus_id: corpusId,
    sync_cadence: 'continuous' as const,
    sync_interval_seconds: 1800,
    freshness_threshold_hours: 26,
    freshness_hours: freshnessHours,
    stale_sync_anomaly: failures > 0,
    tasks: failures > 0
      ? [{ id: `${sourceId}.sync`, kind: 'sync' as const, running: false, consecutive_failures: failures }]
      : [],
  };
}

function handle(
  id: string,
  provider: string,
  capabilities: string[],
  scopes: string[],
  reauth = false,
): ConnectedHandleRegistry['handles'][number] {
  return {
    handle: id,
    provider,
    accountRole: 'personal',
    trustDomain: 'internal',
    allowedCapabilities: capabilities,
    scopes,
    ...(reauth ? { backendState: { kind: 'oauth2_refresh', status: 'reauth_required' } } : {}),
    connectedAt: '2026-07-07T15:35:00.000Z',
  } as ConnectedHandleRegistry['handles'][number];
}

function registry(handles: ConnectedHandleRegistry['handles']): ConnectedHandleRegistry {
  return { version: 1, handles };
}

const engine = createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
  OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
  OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
}));

/**
 * One provider's connect walkthrough, on its own route, so a reviewer can read
 * the numbered steps for exactly one card without hunting through a full page.
 *
 * `refused` renders the same card after the provider rejected the callback —
 * the mismatch state, which must carry the identical steps.
 */
function connectPreview(
  provider: 'google' | 'dropbox' | 'x',
  options: { refused?: boolean; loopback?: boolean; publisher?: boolean } = {},
) {
  const source = provider === 'google' ? 'gmail' : provider;
  return buildSourceDashboardViewModel({
    sourceIndexStatus: emptyStatus(),
    schedulerStatus: scheduler([]),
    sovereigntyEngine: engine,
    connectedHandleRegistry: registry([]),
    apiKeyAvailability: {},
    // Each provider's key is on file, so the card is an `oauth` action: the
    // state the owner's live reauthorization failed in. A publisher-mode
    // preview registers NO key of its own — that is exactly the state in which
    // Olympus's own app takes over and the card collapses to one button.
    oauthClientIds: options.publisher ? {} : {
      google: PREVIEW_GOOGLE_CLIENT_ID,
      dropbox: 'preview-dropbox-app-key',
      x: 'preview-x-client-id',
    },
    oauthClientSecretAvailability: options.publisher ? {} : { google: true, x: true },
    googlePilotClientConfigured: true,
    // Publisher mode for the two relay providers: what the owner sees once the
    // publisher's Dropbox app key (and later Google web client id) ship.
    ...(options.publisher ? { publisherOAuthSources: ['gmail', 'google-drive', 'dropbox'] as const } : {}),
    oauthRedirectBaseUrl: options.loopback ? 'http://127.0.0.1:8010' : PREVIEW_REDIRECT_BASE_URL,
    ...(options.refused
      ? {
        pendingConnects: [{
          source: source as 'gmail' | 'dropbox' | 'x',
          started_at: at(300),
          expires_at: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
          error: { code: 'redirect_uri_mismatch', at: at(280) },
        }],
      }
      : {}),
    now: NOW,
  });
}

function view(state: string) {
  if (state === 'dropbox-initial') return dropboxPreview('initial');
  if (state === 'dropbox-update') return dropboxPreview('update');
  if (state === 'connect-google') return connectPreview('google');
  if (state === 'connect-google-loopback') return connectPreview('google', { loopback: true });
  if (state === 'connect-dropbox') return connectPreview('dropbox');
  if (state === 'connect-x') return connectPreview('x');
  if (state === 'connect-dropbox-refused') return connectPreview('dropbox', { refused: true });
  if (state === 'connect-dropbox-publisher') return connectPreview('dropbox', { publisher: true });
  if (state === 'connect-google-publisher') return connectPreview('google', { publisher: true });
  if (state === 'fresh') {
    return buildSourceDashboardViewModel({
      sourceIndexStatus: emptyStatus(),
      schedulerStatus: scheduler([]),
      sovereigntyEngine: engine,
      connectedHandleRegistry: registry([]),
      apiKeyAvailability: {},
      oauthClientIds: { google: PREVIEW_GOOGLE_CLIENT_ID },
      oauthClientSecretAvailability: { google: true },
      googlePilotClientConfigured: true,
      oauthRedirectBaseUrl: PREVIEW_REDIRECT_BASE_URL,
      now: NOW,
    });
  }
  if (state === 'full') {
    return withPreviewMovement(buildSourceDashboardViewModel({
      sourceIndexStatus: fullStatus(),
      schedulerStatus: scheduler([
        schedulerSource('gmail.email', 'internal.email', 1),
        schedulerSource('google_drive.docs', 'internal.drive.docs', 30, 2),
        schedulerSource('readwise.library', 'internal.readwise.library', 0.4),
        // Inside its cadence window: connected on its own evidence.
        schedulerSource('telegram.messages', 'internal.telegram.messages', 1),
        schedulerSource('whatsapp.messages', 'secure_local.whatsapp.messages', 0.002),
      ]),
      sovereigntyEngine: engine,
      connectedHandleRegistry: registry([
        handle('gmail.personal', 'gmail', ['gmail.email.sync'], ['https://www.googleapis.com/auth/gmail.readonly']),
        handle('google_drive.personal', 'google_drive', ['google_drive.docs.sync'], ['https://www.googleapis.com/auth/drive.readonly']),
        handle('readwise.personal', 'readwise', ['readwise.library.sync'], []),
        handle('x.bookmarks.personal', 'x', ['x.bookmarks.sync'], ['tweet.read'], true),
      ]),
      apiKeyAvailability: { readwise: true, venice: true },
      // X carries a registered client id here, which is the live shape: its
      // expired handle gets the real Reconnect control rather than a setup link.
      oauthClientIds: { google: PREVIEW_GOOGLE_CLIENT_ID, gmail: PREVIEW_GOOGLE_CLIENT_ID, 'google-drive': PREVIEW_GOOGLE_CLIENT_ID, x: 'preview-x-client-id' },
      oauthClientSecretAvailability: { google: true, x: true },
      googlePilotClientConfigured: true,
      oauthRedirectBaseUrl: PREVIEW_REDIRECT_BASE_URL,
      now: NOW,
    }));
  }
  // default: mid-onboarding — readwise synced, google needs setup, others untouched
  return buildSourceDashboardViewModel({
    sourceIndexStatus: (() => {
      const status = emptyStatus();
      status.corpora = [
        corpus('internal.readwise.library', 'readwise', 'internal', 'readwise', 250, 250, { withText: 250, embedded: 250 }),
        // A chat source whose last sync fell outside its window: connected on
        // the evidence of that sync, honest that the session is unreadable.
        corpus('internal.telegram.messages', 'chat', 'internal', 'telegram', 4200, 4200, { withText: 4200, embedded: 4200 }),
      ];
      return status;
    })(),
    schedulerStatus: scheduler([
      schedulerSource('readwise.library', 'internal.readwise.library', 0.4),
      schedulerSource('telegram.messages', 'internal.telegram.messages', 40, 1),
    ]),
    sovereigntyEngine: engine,
    connectedHandleRegistry: registry([
      handle('readwise.personal', 'readwise', ['readwise.library.sync'], []),
    ]),
    apiKeyAvailability: { readwise: true },
    // Dropbox carries an app key here so its card is an `oauth` action rather
    // than a setup one: that is the state the two connect attempts below sit
    // in, and the state the owner's live failure happened in.
    oauthClientIds: { google: PREVIEW_GOOGLE_CLIENT_ID, dropbox: 'preview-dropbox-app-key' },
    oauthClientSecretAvailability: { google: true },
    googlePilotClientConfigured: true,
    oauthRedirectBaseUrl: PREVIEW_REDIRECT_BASE_URL,
    // Two connect attempts a reviewer can look at: Gmail still waiting on the
    // provider tab (Connecting, with Cancel), and Dropbox refused for a
    // redirect URI that was never registered (Needs you, with the URI to
    // register on the sheet).
    pendingConnects: [
      {
        source: 'gmail',
        started_at: at(120),
        expires_at: new Date(NOW.getTime() + 8 * 60_000).toISOString(),
      },
      {
        source: 'dropbox',
        started_at: at(300),
        expires_at: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
        error: { code: 'redirect_uri_mismatch', at: at(280) },
      },
    ],
    now: NOW,
  });
}

/**
 * What the sample history would have recorded for the /full fixture: Gmail's
 * embedding counter rose 40 seconds ago (working), Drive's extraction counter
 * last rose 30 hours ago (stalled). Everything else is complete and needs no
 * movement to say so.
 */
/** An ISO stamp N seconds before the fixture's frozen clock. */
function at(secondsAgo: number): string {
  return new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
}

function withPreviewMovement(view: ReturnType<typeof buildSourceDashboardViewModel>) {
  for (const card of view.sources) {
    if (card.source_id === 'gmail.email') card.movement = { embedding_at: at(40) };
    if (card.source_id === 'google_drive.docs') card.movement = { extraction_at: at(30 * 3600) };
  }
  return view;
}

function dropboxPreview(mode: 'initial' | 'update') {
  const status = emptyStatus();
  const dropbox = corpus('secure_local.dropbox.files', 'file', 'secure_local', 'dropbox', 30_012, 600_000);
  dropbox.activation_mode = 'hybrid_primary';
  dropbox.embedding_policy = 'local_only';
  dropbox.embedding_parity = {
    required: true,
    chunks: 600_000,
    embedded_chunks: mode === 'initial' ? 0 : 599_500,
    missing_chunks: mode === 'initial' ? 600_000 : 500,
    refresh_needed: true,
  };
  status.corpora = [dropbox];
  const result = buildSourceDashboardViewModel({
    sourceIndexStatus: status,
    schedulerStatus: scheduler([
      schedulerSource('dropbox.files', 'secure_local.dropbox.files', mode === 'initial' ? 0 : 0.1),
    ]),
    sovereigntyEngine: engine,
    connectedHandleRegistry: registry([
      handle('dropbox.personal', 'dropbox', ['dropbox.files.sync'], ['files.content.read']),
    ]),
    apiKeyAvailability: {},
    oauthClientIds: { google: PREVIEW_GOOGLE_CLIENT_ID, dropbox: 'preview-dropbox-client-id' },
    oauthClientSecretAvailability: { google: true },
    googlePilotClientConfigured: true,
    oauthRedirectBaseUrl: PREVIEW_REDIRECT_BASE_URL,
    now: NOW,
  });
  const card = result.sources.find((source) => source.source_id === 'dropbox.files');
  if (!card) throw new Error('Dropbox preview card is missing.');
  card.connection.state = 'syncing';
  card.connection.label = mode === 'initial' ? 'Initial ingestion running' : 'Checking for new material';
  card.metadata_sync = mode === 'initial'
    ? { folders_total: 120, folders_visited: 120, folders_pending: 0, folders_failed: 0, folders_blocked: 0 }
    : { folders_total: 240, folders_visited: 240, folders_pending: 0, folders_failed: 0, folders_blocked: 0 };
  card.active_ingestion_phase = 'extraction';
  if (mode === 'initial') {
    card.coverage = {
      indexed_items: 12_000,
      content_ready_items: 8_000,
      embedded_items: 0,
      embedded_files: 0,
      needs_review_items: 0,
      answer_ready_eligible_items: 12_000,
    };
    card.ingestion_selection = { metadata_only_files: 2_000, full_ingestion_files: 10_000 };
    card.embedding_backlog = { chunks: 600_000, embedded_chunks: 0, missing_chunks: 600_000, refresh_needed: true };
    card.freshness = { label: 'Waiting for first check', stale: false };
    card.answer_readiness = { state: 'syncing', label: 'Initial ingestion is still running' };
    card.queue_health = { label: 'Working now', waiting: 4_000, active: 1, needs_attention: 0 };
    card.progress = { indexed_items_per_hour: 13_000, eta_minutes: 18 };
    card.setup = { stage: 'initial_sync', condition: 'usable', next_action: 'Keep Olympus running while the initial ingestion finishes.', dependencies: [] };
    result.summary.answer_ready_sources = 0;
    result.summary.total_indexed_items = 12_000;
    result.summary.total_content_ready_items = 8_000;
  } else {
    // A corpus that settled at 30,000 with a batch of 12 in flight: 7 read, 2
    // embedded. The counts and the baselines below are what make the bars say
    // "7 of 12 new files" instead of "5 files remaining · share not measured",
    // while the totals line above them keeps stating the whole 30,012.
    card.coverage = {
      indexed_items: 30_012,
      content_ready_items: 30_007,
      embedded_items: 599_500,
      embedded_files: 30_002,
      needs_review_items: 0,
      answer_ready_eligible_items: 30_012,
    };
    card.movement = {
      extraction_at: at(90),
      embedding_at: at(20),
      extraction_settled_value: 30_000,
      embedding_settled_value: 30_000,
    };
    card.embedding_backlog = { chunks: 600_000, embedded_chunks: 599_500, missing_chunks: 500, refresh_needed: true };
    card.ingestion_selection = { metadata_only_files: 5_000, full_ingestion_files: 25_012 };
    card.freshness = { label: 'Checked recently', hours: 0.1, threshold_hours: 26, stale: false };
    card.last_sync_at = '2026-07-07T20:54:00.000Z';
    card.answer_readiness = { state: 'ready', label: 'Existing Dropbox material remains answer-ready' };
    card.queue_health = { label: 'Working now', waiting: 7, active: 1, needs_attention: 0 };
    card.progress = { indexed_items_per_hour: 120 };
    card.setup = { stage: 'cited_answer_readiness', condition: 'usable', next_action: 'No action needed; Olympus is processing new material.', dependencies: [] };
    result.summary.answer_ready_sources = 1;
    result.summary.total_indexed_items = 30_012;
    result.summary.total_content_ready_items = 30_007;
  }
  result.summary.connected_sources = 1;
  return result;
}

const port = Number(process.env.DASHBOARD_PREVIEW_PORT ?? 8930);
Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    // The page's own unlock form posts here. There is no worker behind this
    // harness, so ANY non-empty paste mints a pretend control session (a
    // cookie), and the pages then render unlocked exactly as they would on a
    // real worker. Nothing is verified and nothing is stored: the point is to
    // walk the unlocked flow in a browser, not to authenticate.
    if (request.method === 'POST' && url.pathname === '/dashboard/control/session') {
      return new Response(JSON.stringify({ csrf_token: 'preview-csrf-token' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'olympus_preview_controls=1; Path=/; SameSite=Strict',
        },
      });
    }
    // Every other control POST (connect, sync now, disconnect, embedding
    // priority) needs a worker. Say so in the words the page prints, instead
    // of a bare "Request failed." that reads as a broken credential.
    if (request.method === 'POST' && url.pathname.startsWith('/dashboard/')) {
      return new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'preview_only',
          message: 'Preview only: there is no worker behind this page, so this action cannot run here. It works on your real Olympus dashboard.',
        },
      }), { status: 501, headers: { 'content-type': 'application/json' } });
    }
    const previewUnlocked = url.searchParams.has('controls')
      || /(?:^|;\s*)olympus_preview_controls=1/.test(request.headers.get('cookie') ?? '');
    const state = url.pathname.replace(/^\//, '') || 'partial';
    const states = [
      'partial', 'fresh', 'full', 'dropbox-initial', 'dropbox-update',
      'connect-google', 'connect-google-loopback', 'connect-dropbox', 'connect-x',
      'connect-dropbox-refused', 'connect-dropbox-publisher', 'connect-google-publisher',
    ];
    if (!states.includes(state)) {
      return new Response(`states: ${states.map((name) => `/${name}`).join(' ')}`, { status: 404 });
    }
    if (url.searchParams.has('embedding-ledger')) {
      const page = renderEmbeddingLedgerPage({
        skipped: 0,
        path: '/preview/embedding-ledger.jsonl',
        entries: [{
          recorded_at: '2026-07-07T18:00:00.000Z',
          kind: 'model_decision',
          what: 'Keep the approved local embedding model for secure Dropbox material.',
          model_id: 'preview/local-embedding-model',
          epoch: 'preview-v1',
          endpoint: 'http://127.0.0.1:8000/v1',
          scope: { corpora: ['secure_local.dropbox.files'], chunks: { 'secure_local.dropbox.files': 600_000 } },
          why: 'Preserve semantic search without sending secure Dropbox material to a public endpoint.',
          approved_by: 'jamie',
          status: 'complete',
        }],
      }, { now: NOW, basePath: `/${state}` });
      return new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    const page = renderDashboardHtmlRoute({
      url,
      view: view(state),
      options: {
        basePath: `/${state}`,
        now: NOW,
        embeddingRuntime: {
          state: 'running',
          stateLine: 'Embeddings: running now (metadata caught up)',
          scheduleLine: 'Runs whenever the source-processing guard admits the lane.',
          model: { name: 'preview/local-embedding-model', live: true, local: true, text: 'preview/local-embedding-model · local' },
          overrideOn: false,
          override: 'none',
          overridePath: '/preview/operator-override',
        },
        ...(previewUnlocked ? { controlSessionCsrfToken: 'preview-csrf-token' } : {}),
      },
    });
    return new Response(page.html, { status: page.status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});
console.log(`dashboard preview listening on http://127.0.0.1:${port}`);
console.log('  states: /fresh /partial /full /dropbox-initial /dropbox-update');
console.log('  connect walkthroughs (add ?setup): /connect-google /connect-google-loopback /connect-dropbox /connect-x /connect-dropbox-refused');
console.log('  publisher-app one-click cards (add ?setup): /connect-dropbox-publisher /connect-google-publisher');
