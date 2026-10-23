import { ModelSetupService } from '../src/core/model-setup.ts';
import { loadSovereigntyPreset } from '../src/core/sovereignty.ts';
// Local design-iteration harness for the dashboard (unified dashboard phase
// 4, 2026-10-09: the ChatGPT panel is the only dashboard). Serves the
// computer's /dashboard host page around the exact panel ChatGPT loads, and
// answers the panel's dashboard read from fixture data, so the page can be
// audited in a real browser without a live worker or real credentials. Never
// used in production; carries no secrets.
//
//   bun scripts/dashboard-preview.ts            # http://127.0.0.1:8930
//   /<state>     picks a fixture (a cookie remembers it), then redirects to
//                /dashboard. States: see the 404 at an unknown path.
//   /dashboard            the host page, locked (the Open dashboard controls banner)
//   /dashboard?controls   the same page with a pretend control session
//   /dashboard?state=<name>  that preview state, in one load
//   /dashboard?keys | ?agents | ?private-answers | ?connector
//                the computer's own pages, as the worker renders them.
//   &waiting=0..9  how many private inbox questions appear (default 3; remembered):
//                the Private answers list and the panel's Needs you line.
//   &agents=off|not-connected|relay-unavailable|awaiting-terms|worker-env
//                picks the Agents fixture.
//   &picker=open[,everything|folder:<Name>...]  with a local-files-* state: opens
//                the folder picker (and clicks on) as soon as the panel loads.
//   &picker=import[,folder:<Name>...]  with an archives-* state: opens the
//                archive picker (Import an archive) the same way.
//
// Only the dashboard read answers; every other panel tool says it needs a
// worker.
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import {
  buildSourceDashboardViewModel,
  type DashboardImportAttention,
  type DashboardImportedArchives,
  type SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';
import {
  COMPUTER_HOST_PAGE_CSP,
  dashboardHtmlRoutePage,
  renderComputerHostPage,
  dashboardOutsideHelpRedirect,
  renderDashboardLocalPage,
} from '../src/workers/dashboard/index.ts';
import {
  ARCHIVE_APPROVE_TOOL_NAME,
  ARCHIVE_BROWSE_TOOL_NAME,
  COMPUTER_META_KEY,
  DASHBOARD_TOOL_NAME,
  DELETE_SOURCE_DATA_TOOL_NAME,
  SCOPE_LIST_TOOL_NAME,
  SCOPE_UI_META_KEY,
  type ComputerArchiveEntry,
  type ComputerArchivesMeta,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import { getFileScopeSource } from '../src/core/file-scope-sources.ts';
import { ARCHIVE_FORMATS } from '../src/core/archive-formats.ts';
import { ARCHIVE_APPROVE_COPY } from '../src/workers/archive-import/dashboard.ts';
import { FILES_AND_FOLDERS_URL, FULL_DISK_ACCESS_URL, MAC_ACCESS_COPY } from '../src/workers/local-files/mac-permissions.ts';
import { dashboardResourceHtml } from '../src/workers/chatgpt/dashboard-resource.ts';
import { buildChatGptDashboardViewModel, type ChatGptDashboardOptions } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { dashboardToolResult } from '../src/workers/chatgpt/response-builder.ts';
import type { ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import type { SourceSchedulerStatus } from '../src/workers/source-scheduler.ts';
import type { DashboardAgentsView } from '../src/workers/agent-connections.ts';

export const DASHBOARD_PREVIEW_NOW = new Date('2026-07-07T21:00:00.000Z');
const NOW = DASHBOARD_PREVIEW_NOW;
// A corpus no dashboard card owns. Every registry corpus has a card today, so
// the fixture names a store-only corpus id directly.
const UNCLAIMED_CORPUS_ID = 'internal.fixture-library.derivatives';
const PREVIEW_GOOGLE_CLIENT_ID = 'olympus-pilot-preview.apps.googleusercontent.com';
// Secret availability is per card and already paired with that card's client
// (the worker expands a shared Google registration into each card). Every
// preview Google card uses the one preview client, so each has the secret.
const PREVIEW_GOOGLE_SECRET_ON_FILE = { google: true, gmail: true, 'google-drive': true } as const;
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
    corpus(UNCLAIMED_CORPUS_ID, 'file', 'internal', 'fixture_library', 42, 42),
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
    oauthClientSecretAvailability: options.publisher ? {} : { ...PREVIEW_GOOGLE_SECRET_ON_FILE, x: true },
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

/**
 * The ChatGPT-rules port (owner, 2026-10-02) in one view: Gmail mid-sign-in
 * through Olympus's own app, Google Drive reading at 40%, Dropbox connected
 * and waiting for its folders, Readwise fresh. Pair it with
 * buildDashboardPreviewOptions('review') for a model downloading and privacy
 * set up ('review-unconfigured' leaves privacy unset; 'review-indexing' adds a
 * second working source so the page-wide progress line shows).
 */
function reviewPreview(variant: 'review' | 'review-unconfigured' | 'review-indexing'): SourceDashboardViewModel {
  const status = emptyStatus();
  status.corpora = [
    corpus('internal.drive.docs', 'file', 'internal', 'google_drive', 3_100, 3_100, { withText: 1_240, embedded: 1_240 }),
    corpus('internal.readwise.library', 'readwise', 'internal', 'readwise', 250, 250, {
      withText: 250,
      embedded: variant === 'review-indexing' ? 100 : 250,
    }),
  ];
  const view = buildSourceDashboardViewModel({
    sourceIndexStatus: status,
    schedulerStatus: scheduler([
      schedulerSource('google_drive.docs', 'internal.drive.docs', 0.2),
      schedulerSource('readwise.library', 'internal.readwise.library', 0.4),
    ]),
    sovereigntyEngine: engine,
    connectedHandleRegistry: registry([
      handle('google_drive.personal', 'google_drive', ['google_drive.docs.sync'], ['https://www.googleapis.com/auth/drive.readonly']),
      handle('dropbox.personal', 'dropbox', ['dropbox.files.sync'], ['files.content.read']),
      handle('readwise.personal', 'readwise', ['readwise.library.sync'], []),
    ]),
    apiKeyAvailability: { readwise: true },
    publisherOAuthSources: ['gmail', 'google-drive', 'dropbox'] as const,
    oauthClientIds: {},
    oauthClientSecretAvailability: {},
    googlePilotClientConfigured: true,
    oauthRedirectBaseUrl: PREVIEW_REDIRECT_BASE_URL,
    ingestionDispositionsAvailable: true,
    fileSourceScopeStatus: { 'google_drive.docs': 'approved', 'dropbox.files': 'scope_pending' },
    fileSourceScopeIngestionEnabled: { 'google_drive.docs': true, 'dropbox.files': false },
    pendingConnects: [{
      source: 'gmail',
      started_at: at(120),
      expires_at: new Date(NOW.getTime() + 9 * 60_000).toISOString(),
    }],
    now: NOW,
  });
  // Built-in models only, as a fresh install has them: no keys to enter, the
  // private model still downloading (see buildDashboardPreviewOptions).
  // Drive read a file 40 seconds ago; Readwise's index moved a minute ago.
  for (const card of view.sources) {
    if (card.source_id === 'google_drive.docs') card.movement = { extraction_at: at(40), embedding_at: at(40) };
    if (card.source_id === 'readwise.library') card.movement = { embedding_at: at(60) };
  }
  return view;
}

/**
 * The panel options the worker reads for a preview state: the built-in
 * private model's download and the owner's privacy counts. Empty for the
 * older states.
 */
export function buildDashboardPreviewOptions(state: string): Pick<ChatGptDashboardOptions, 'privacy' | 'privateModel'> {
  if (!state.startsWith('review')) return {};
  const configured = state !== 'review-unconfigured';
  return {
    // The private model downloading: 40%, 1.2 of 3.0 GB.
    privateModel: { state: 'downloading', percent: 40, bytesDone: 1_200_000_000, bytesTotal: 3_000_000_000 },
    privacy: { configured, pendingCount: 12, ruleCount: configured ? 3 : 0 },
  };
}

export function buildDashboardPreviewView(state: string): SourceDashboardViewModel {
  if (state === 'review' || state === 'review-unconfigured' || state === 'review-indexing') return reviewPreview(state);
  if (state === 'models') {
    const view = buildDashboardPreviewView('fresh');
    view.model_setup = new ModelSetupService({ config: loadSovereigntyPreset('private-cloud-only'), credentialState: () => 'missing' }).getStatus();
    return view;
  }
  if (state === 'models-applying') {
    // The owner's beta.5 fresh install (2026-09-24): the Gemini key saved and
    // applying, Venice still waiting for its key.
    const view = buildDashboardPreviewView('fresh');
    view.model_setup = new ModelSetupService({
      config: loadSovereigntyPreset('private-cloud-only'),
      credentialState: (_id, profile) => (profile.provider === 'google-gemini' ? 'applying' : 'missing'),
    }).getStatus();
    return view;
  }
  if (state === 'first-install') {
    // The owner's first-install test (2026-09-23): model keys in, Dropbox and
    // Google Drive connected with their folders not yet chosen, Readwise
    // before its first sync. All three should read Waiting; the models should
    // read as compact rows.
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: emptyStatus(),
      schedulerStatus: scheduler([]),
      sovereigntyEngine: engine,
      connectedHandleRegistry: registry([
        handle('dropbox.personal', 'dropbox', ['dropbox.files.sync'], ['files.content.read']),
        handle('google_drive.personal', 'google_drive', ['google_drive.docs.sync'], ['https://www.googleapis.com/auth/drive.readonly']),
        handle('readwise.personal', 'readwise', ['readwise.library.sync'], []),
      ]),
      apiKeyAvailability: { readwise: true },
      oauthClientIds: { google: PREVIEW_GOOGLE_CLIENT_ID, dropbox: 'preview-dropbox-app-key' },
      oauthClientSecretAvailability: PREVIEW_GOOGLE_SECRET_ON_FILE,
      googlePilotClientConfigured: true,
      oauthRedirectBaseUrl: PREVIEW_REDIRECT_BASE_URL,
      // Both keys, always, as the worker's scope summaries publish them.
      fileSourceScopeStatus: { 'google_drive.docs': 'scope_pending', 'dropbox.files': 'scope_pending' },
      now: NOW,
    });
    view.model_setup = new ModelSetupService({ config: loadSovereigntyPreset('private-cloud-only'), credentialState: () => 'ready' }).getStatus();
    return view;
  }
  if (state === 'gmail-scope-pending') {
    // Gmail connected, no mail scope approved yet (design §2.5): the card, the
    // Setup row and home all read Waiting · choose which mail to include, and the
    // banner leads to the mail picker (/mail-picker in this harness).
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: emptyStatus(),
      schedulerStatus: scheduler([]),
      sovereigntyEngine: engine,
      connectedHandleRegistry: registry([
        handle('gmail.personal', 'gmail', ['gmail.email.sync'], ['https://www.googleapis.com/auth/gmail.readonly']),
        handle('readwise.personal', 'readwise', ['readwise.library.sync'], []),
      ]),
      apiKeyAvailability: { readwise: true },
      oauthClientIds: { google: PREVIEW_GOOGLE_CLIENT_ID, gmail: PREVIEW_GOOGLE_CLIENT_ID },
      oauthClientSecretAvailability: PREVIEW_GOOGLE_SECRET_ON_FILE,
      googlePilotClientConfigured: true,
      oauthRedirectBaseUrl: PREVIEW_REDIRECT_BASE_URL,
      ingestionDispositionsAvailable: true,
      fileSourceScopeStatus: { 'gmail.email': 'scope_pending' },
      fileSourceScopeIngestionEnabled: { 'gmail.email': false },
      now: NOW,
    });
    view.model_setup = new ModelSetupService({ config: loadSovereigntyPreset('private-cloud-only'), credentialState: () => 'ready' }).getStatus();
    return view;
  }
  if (state === 'tier-migration') {
    // An existing install mid-way through the owner-approved tier migration
    // (design section 4.6): Dropbox's old all-Private store has handed most
    // files' names and Personal text to its new Personal store, keeps the
    // previous copies hidden, holds three Secrets as locations only, and the
    // Personal store's model is still embedding what moved.
    const status = emptyStatus();
    const secure = corpus('secure_local.dropbox.files', 'file', 'secure_local', 'dropbox', 1_240, 1_900, { withText: 1_200, embedded: 1_200 });
    const personal = corpus('internal.dropbox.files', 'file', 'internal', 'dropbox', 2_760, 3_100, { withText: 2_700, embedded: 1_900 });
    Object.assign((secure as { counts: Record<string, number> }).counts, {
      secret_locations: 3,
      pending_classification_items: 40,
      superseded_chunks: 3_100,
    });
    status.corpora = [
      corpus('internal.readwise.library', 'readwise', 'internal', 'readwise', 250, 250, { withText: 250, embedded: 250 }),
      secure,
      personal,
    ];
    status.tier_migration = {
      plan_id: 'tm-3f2a9c1d7e5b4a60',
      state: 'running',
      in_progress: true,
      approval_entry_id: 'tier-migration-approval:tm-3f2a9c1d7e5b4a60:8b1e',
      proposed: 2_763,
      batches: [{ batch_id: 'tm-3f2a9c1d7e5b4a60-b1', state: 'running', moved: 2_120, secrets: 3, skipped: 4 }],
      corpora: ['secure_local.dropbox.files', 'internal.dropbox.files'],
      chunks_to_embed: 3_100,
      destinations: [{ corpus_id: 'internal.dropbox.files', chunks_to_embed: 3_100 }],
      names_only_kept_chunks: 0,
      purged: false,
    };
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      schedulerStatus: scheduler([
        schedulerSource('readwise.library', 'internal.readwise.library', 0.4),
        schedulerSource('dropbox.files', 'secure_local.dropbox.files', 0.3),
      ]),
      sovereigntyEngine: engine,
      connectedHandleRegistry: registry([
        handle('dropbox.personal', 'dropbox', ['dropbox.files.sync'], ['files.content.read']),
        handle('readwise.personal', 'readwise', ['readwise.library.sync'], []),
      ]),
      apiKeyAvailability: { readwise: true },
      oauthClientIds: { google: PREVIEW_GOOGLE_CLIENT_ID, dropbox: 'preview-dropbox-app-key' },
      oauthClientSecretAvailability: PREVIEW_GOOGLE_SECRET_ON_FILE,
      googlePilotClientConfigured: true,
      oauthRedirectBaseUrl: PREVIEW_REDIRECT_BASE_URL,
      fileSourceScopeStatus: { 'dropbox.files': 'approved' },
      fileSourceScopeIngestionEnabled: { 'dropbox.files': true },
      now: NOW,
    });
    view.model_setup = new ModelSetupService({ config: loadSovereigntyPreset('private-cloud-only'), credentialState: () => 'ready' }).getStatus();
    return view;
  }
  if (state.startsWith('local-files')) return localFilesPreview(state.startsWith('local-files-picker') ? 'local-files-connected' : state);
  if (state === 'delete-data' || state === 'delete-data-done') return deleteDataPreview(state === 'delete-data-done');
  if (state.startsWith('archives-')) return archivesPreview(state);
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
      oauthClientSecretAvailability: PREVIEW_GOOGLE_SECRET_ON_FILE,
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
      oauthClientSecretAvailability: { ...PREVIEW_GOOGLE_SECRET_ON_FILE, x: true },
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
    oauthClientSecretAvailability: PREVIEW_GOOGLE_SECRET_ON_FILE,
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

const view = buildDashboardPreviewView;

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

/**
 * "Files on this computer" (local.files): fixture-only states for the owner's
 * review. The source needs no account, so the registry carries no handle; the
 * states differ in the scheduler's evidence and the scope status.
 *   local-files-off          not connected (no scheduler source)
 *   local-files-connected    connected, no folders chosen yet (Choose folders)
 *   local-files-indexing      folders chosen, first indexing running
 *   local-files-reading       indexed and current
 *   local-files-needs-permission   a chosen folder the Mac will not open (stalled)
 *   local-files-finding      the first walk: files found so far, no total yet
 *   local-files-finding-page  the same walk while Dropbox is also working: the
 *                            page-wide line says files found so far, not a percent
 *   local-files-sync-checking / local-files-sync-checked   Sync now pressed on a
 *                            current source: "Checking …", then the kept result line
 * The local-files-picker-* states are the connected row plus the folder
 * picker's answers (see previewScopeList).
 */
function localFilesPreview(state: string) {
  const mode = state === 'local-files-off' ? 'off'
    : state === 'local-files-indexing' ? 'syncing'
      : state === 'local-files-finding' || state === 'local-files-finding-page' ? 'walking'
      : state === 'local-files-reading' || state === 'local-files-sync-checking' || state === 'local-files-sync-checked' ? 'synced'
        : state === 'local-files-needs-permission' ? 'permission'
          : 'connected';
  const status = emptyStatus();
  if (mode === 'walking') {
    // The first walk: items are being listed, none read yet, no total known.
    status.corpora = [corpus('secure_local.local.files', 'file', 'secure_local', 'local_files', 12_400, 0)];
  }
  const alsoDropbox = state === 'local-files-finding-page';
  if (alsoDropbox) {
    status.corpora.push(corpus('secure_local.dropbox.files', 'file', 'secure_local', 'dropbox', 4000, 4000, { withText: 2000, embedded: 0 }));
  }
  if (mode === 'syncing' || mode === 'synced' || mode === 'permission') {
    const files = corpus('secure_local.local.files', 'file', 'secure_local', 'local_files',
      mode === 'synced' ? 18_420 : mode === 'permission' ? 2_310 : 6_200,
      mode === 'synced' ? 92_000 : mode === 'permission' ? 11_500 : 31_000,
      mode === 'synced' ? (state.startsWith('local-files-sync') ? { withText: 18_420, embedded: 18_420 } : { withText: 18_000, embedded: 18_000 }) : { withText: mode === 'permission' ? 2_300 : 3_900, embedded: mode === 'permission' ? 2_300 : 1_200 });
    status.corpora = [files];
  }
  const source = schedulerSource('local.files', 'secure_local.local.files', mode === 'synced' ? 0.2 : 0.5);
  if (mode === 'permission') {
    source.tasks = [{
      id: 'local.files_store_pull.preview',
      kind: 'sync' as const,
      running: false,
      consecutive_failures: 1,
      last_error_kind: 'scope_root_permission_needed',
      degraded_reason: 'scope_root_permission_needed',
    }] as unknown as typeof source.tasks;
  } else if (mode === 'syncing' || mode === 'walking') {
    source.tasks = [{ id: 'local.files_store_pull.preview', kind: 'sync' as const, running: true, consecutive_failures: 0 }] as unknown as typeof source.tasks;
  }
  const sources = [source];
  if (alsoDropbox) {
    const dropbox = schedulerSource('dropbox.files', 'secure_local.dropbox.files', 0.3);
    dropbox.tasks = [{ id: 'dropbox.files_store_pull.preview', kind: 'sync' as const, running: true, consecutive_failures: 0 }] as unknown as typeof dropbox.tasks;
    sources.push(dropbox);
  }
  const chosen = mode === 'syncing' || mode === 'walking' || mode === 'synced' || mode === 'permission';
  const manualSync = state === 'local-files-sync-checking'
    ? { at: NOW.toISOString(), outcome: 'checking' as const }
    : state === 'local-files-sync-checked' ? { at: NOW.toISOString(), outcome: 'checked' as const, new_items: 0 } : undefined;
  return buildSourceDashboardViewModel({
    sourceIndexStatus: status,
    schedulerStatus: scheduler(mode === 'off' ? [] : sources),
    sovereigntyEngine: engine,
    connectedHandleRegistry: registry(mode === 'off' ? [] : [{
      ...handle('local.files.this_computer', 'local_files', ['local.files.sync'], []),
      accountRole: 'this_computer',
      thisComputer: true,
    } as unknown as ConnectedHandleRegistry['handles'][number], ...(alsoDropbox ? [handle('dropbox.personal', 'dropbox', ['dropbox.files.sync'], ['files.content.read'])] : [])]),
    apiKeyAvailability: {},
    oauthClientIds: { google: PREVIEW_GOOGLE_CLIENT_ID, dropbox: 'preview-dropbox-app-key' },
    oauthClientSecretAvailability: PREVIEW_GOOGLE_SECRET_ON_FILE,
    googlePilotClientConfigured: true,
    oauthRedirectBaseUrl: PREVIEW_REDIRECT_BASE_URL,
    ...(mode === 'off' ? {} : {
      fileSourceScopeStatus: { 'local.files': chosen ? 'approved' : 'scope_pending', ...(alsoDropbox ? { 'dropbox.files': 'approved' } : {}) },
      fileSourceScopeIngestionEnabled: { 'local.files': chosen, ...(alsoDropbox ? { 'dropbox.files': true } : {}) },
    }),
    // This worker can run Sync now for it (the scheduler holds the source).
    syncNowAvailable: () => true,
    ...(manualSync ? { manualSyncs: { 'local.files': manualSync } } : {}),
    now: NOW,
  });
}

/**
 * Archives (archive import, 2026-10-23): fixture-only states for the owner's
 * review. The card reads how many archives are imported; the list under it is
 * the computer's own (previewArchivesMeta), so these states show it on the
 * computer only.
 *   archives-none        nothing imported yet: Import an archive
 *   archives-picker      the same row; opening Import an archive lists files
 *                        and folders (previewArchiveBrowse), Downloads needing
 *                        the Mac's permission, and Import starts an import
 *   archives-checking    an approval reading its files once to tell a copy apart
 *   archives-already     that check found the archive already imported
 *   archives-failed      a choice that was not imported, and why
 *   archives-request     an agent asked to import a file: Import or Decline
 *   archives-remove-request  an agent asked to remove an imported archive: Remove or Decline
 *   archives-importing   one archive 42% read, its messages held for the private model
 *   archives-imported    one archive imported, with what was not read, per kind
 *   archives-waiting     imported, but no private model is set up: the route to set one up
 *   archives-stopped     the file changed during the import: what happened and what to do
 *   archives-removing    Remove pressed: everything Olympus made from it is being deleted
 *   archives-unreadable  the list of imported archives cannot be read: See why, no Import
 *   archives-uncounted   an imported archive whose index cannot be opened now: never "0 messages"
 *   archives-not-running an import waiting while background reading is turned off: See why names the setting
 * A stopped import, an agent's request, a check that ended without importing,
 * an archive that cannot be counted, imports that cannot run, and held
 * messages no private model can judge are each a Needs you line too.
 */
const ARCHIVE_STATES = [
  'archives-none', 'archives-picker', 'archives-checking', 'archives-already', 'archives-failed', 'archives-request',
  'archives-remove-request',
  'archives-importing', 'archives-imported', 'archives-waiting', 'archives-stopped', 'archives-removing',
  'archives-unreadable', 'archives-uncounted', 'archives-not-running',
] as const;

function archivesPreview(state: string): SourceDashboardViewModel {
  const meta = previewArchivesMeta(state)!;
  const status = emptyStatus();
  const items = meta.archives.reduce((sum, entry) => sum + entry.items, 0);
  if (items > 0) {
    // Each bounded pass of an import is a completed sync run of its store.
    const embedded = state === 'archives-importing' ? Math.round(items * 0.6) : items;
    status.corpora = [{
      ...corpus('secure_local.archive.email', 'email', 'secure_local', 'mbox', items, items * 3, { withText: items, embedded }),
      last_refresh: { sync_run_id: 'preview-archive-pass', status: 'completed', started_at: at(2 * 3600 + 60), completed_at: at(2 * 3600), items_seen: 2_000, items_indexed: 2_000 },
    }];
  }
  const source = schedulerSource('archive.imports', 'secure_local.archive.email', 0.1);
  if (state === 'archives-importing') {
    // The archive's own pass is running, as it is while an import reads.
    source.tasks = [{ id: 'archive.imports_pull.preview', kind: 'sync' as const, running: true, consecutive_failures: 0 }] as unknown as typeof source.tasks;
  }
  return buildSourceDashboardViewModel({
    sourceIndexStatus: status,
    schedulerStatus: scheduler(items > 0 ? [source] : []),
    sovereigntyEngine: engine,
    connectedHandleRegistry: registry([]),
    apiKeyAvailability: {},
    importedArchives: previewImportedArchives(meta),
    now: NOW,
  });
}

/** The card's side of a preview list, as archive-import/dashboard.ts present() derives it. */
function previewImportedArchives(meta: ComputerArchivesMeta): DashboardImportedArchives {
  const attention: DashboardImportAttention[] = [];
  if (meta.unreadable) attention.push({ kind: 'unreadable', reason: meta.unreadable.reason });
  for (const entry of meta.archives) if (entry.status === 'stopped') attention.push({ kind: 'stopped', id: entry.id, name: entry.name });
  if (meta.notRunning) attention.push({ kind: 'scheduler', setting: meta.notRunning });
  const counted = meta.archives.filter((entry) => entry.status !== 'removing');
  for (const entry of counted) if (entry.countsUnavailable) attention.push({ kind: 'counts', id: entry.id, name: entry.name });
  for (const request of meta.requests) {
    if (request.origin === 'agent' && request.status === 'pending') {
      attention.push({ kind: request.kind === 'remove' ? 'removal' : 'request', id: request.id, name: request.name });
    }
  }
  for (const request of meta.requests) if (request.status === 'failed') attention.push({ kind: 'failed', id: request.id, name: request.name });
  const held = counted.filter((entry) => !entry.countsUnavailable).reduce((sum, entry) => sum + entry.held, 0);
  if (meta.privateModel !== 'ready' && held > 0) attention.push({ kind: 'held', count: held, model: meta.privateModel });
  return {
    archives: meta.unreadable && meta.archives.length === 0 ? 0 : meta.archives.length,
    importing: meta.archives.some((entry) => entry.status === 'importing' || entry.status === 'removing'),
    ...(attention.length > 0 ? { attention } : {}),
  };
}

/** The Archives row's list for an archives-* state: invented names, never anyone's files. */
export function previewArchivesMeta(state: string): ComputerArchivesMeta | undefined {
  if (!(ARCHIVE_STATES as readonly string[]).includes(state)) return undefined;
  const takeout: ComputerArchiveEntry = {
    id: '0b9e4c52-7a1d-4d3e-9f0a-3c1b2a4d5e6f',
    name: 'All mail Including Spam and Trash.mbox',
    format: 'Mail (mbox)',
    where: '~/Downloads/Takeout/Mail',
    status: 'imported',
    items: 48_210,
    judged: 48_210,
    held: 0,
    earliest: '2009-03-14',
    latest: '2026-10-19',
    startedAt: at(6 * 3600),
    importedAt: at(2 * 3600),
    gaps: [],
    skipped: [],
  };
  const archives: ComputerArchiveEntry[] = [];
  const requests: ComputerArchivesMeta['requests'] = [];
  let privateModel: ComputerArchivesMeta['privateModel'] = 'ready';
  if (state === 'archives-importing') {
    const { importedAt: _importedAt, ...started } = takeout;
    archives.push({ ...started, status: 'importing', items: 20_340, judged: 12_900, held: 7_440, percent: 42, latest: '2016-08-02' });
  } else if (state === 'archives-imported' || state === 'archives-waiting') {
    if (state === 'archives-waiting') privateModel = 'off';
    archives.push({
      ...takeout,
      judged: state === 'archives-waiting' ? 0 : 48_190,
      held: state === 'archives-waiting' ? 48_210 : 20,
      gaps: [{ kind: 'message_too_large', count: 3 }, { kind: 'attachments_not_read', count: 112 }, { kind: 'charset_not_decoded', count: 1 }],
      skipped: [{ kind: 'spam_or_trash', count: 1_204 }],
    });
  } else if (state === 'archives-stopped') {
    const { importedAt: _importedAt, ...started } = takeout;
    archives.push({ ...started, status: 'stopped', items: 9_812, judged: 9_812, held: 0, latest: '2012-11-30', stop: { code: 'file_changed', file: 'All mail Including Spam and Trash.mbox' } });
  } else if (state === 'archives-removing') {
    archives.push({ ...takeout, status: 'removing' });
  } else if (state === 'archives-checking') {
    requests.push({ id: '5f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f', name: 'Inbox.mbox', where: '~/Library/Mail/V10/Exported', origin: 'dashboard', status: 'checking' });
    archives.push(takeout);
  } else if (state === 'archives-already') {
    requests.push({ id: '5f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f', name: 'All mail copy.mbox', where: '~/Desktop', origin: 'dashboard', status: 'already_imported', archiveId: takeout.id, archiveName: takeout.name });
    archives.push(takeout);
  } else if (state === 'archives-failed') {
    requests.push({ id: '5f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f', name: 'Inbox.mbox', where: '~/Desktop', origin: 'dashboard', status: 'failed', code: 'changed' });
  } else if (state === 'archives-request') {
    requests.push({ id: '5f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f', name: 'Takeout-2.mbox', where: '~/Downloads', origin: 'agent', status: 'pending' });
  } else if (state === 'archives-remove-request') {
    archives.push(takeout);
    requests.push({ id: '7d1e2f30-4c5b-4a6d-9e7f-8b9c0d1e2f3a', kind: 'remove', name: takeout.name, where: takeout.where, origin: 'agent', status: 'pending', archiveId: takeout.id, archiveName: takeout.name });
  } else if (state === 'archives-uncounted') {
    archives.push({ ...takeout, items: 0, judged: 0, held: 0, countsUnavailable: true });
  } else if (state === 'archives-not-running') {
    const { importedAt: _importedAt, ...started } = takeout;
    archives.push({ ...started, status: 'importing', items: 0, judged: 0, held: 0, percent: 0, latest: '2009-03-14' });
    return { sourceId: 'archive.imports', archives, requests, privateModel, notRunning: 'disabled' };
  } else if (state === 'archives-unreadable') {
    return {
      sourceId: 'archive.imports', archives, requests, privateModel,
      unreadable: { reason: 'damaged', file: '~/.local/share/openclaw/olympus/archive-imports.json', list: 'archives' },
    };
  }
  return { sourceId: 'archive.imports', archives, requests, privateModel };
}

/**
 * The archive picker's answers (local-files/scope-browser.ts archive mode),
 * with a fake home: files beside folders, Downloads needing the Mac's
 * permission, and an Apple Mail export folder chosen as one archive.
 */
export function previewArchiveBrowse(args: { parent_key?: unknown }) {
  const parent = typeof args.parent_key === 'string' ? args.parent_key : '';
  const folder = (name: string, extra: Record<string, unknown> = {}, under = LOCAL_FILES_HOME) => ({
    key: `${under}/${name}`, ...(under !== LOCAL_FILES_HOME || parent ? { parent_key: under } : {}), name, kind: 'folder', has_children: true, selectable: true, ...extra,
  });
  const file = (name: string, size: number, under: string) => ({ key: `${under}/${name}`, parent_key: under, name, kind: 'file', has_children: false, selectable: true, size_bytes: size });
  let nodes: unknown[];
  if (!parent) {
    nodes = [
      folder('Desktop', { access: { state: 'needs_permission', message: MAC_ACCESS_COPY.needsPermission } }),
      folder('Documents', { access: { state: 'needs_permission', message: MAC_ACCESS_COPY.needsPermission } }),
      folder('Downloads', { access: { state: 'needs_permission', message: MAC_ACCESS_COPY.needsPermission } }),
      folder('Mail exports'),
      { key: '/@disk-1', name: 'Backup Drive', kind: 'folder', has_children: true, selectable: true, is_disk: true },
    ];
  } else if (parent === `${LOCAL_FILES_HOME}/Mail exports`) {
    nodes = [
      folder('Inbox.mbox', {}, parent),
      file('Takeout-2026-10.mbox', 6_420_000_000, parent),
      file('notes.txt', 2_400, parent),
    ];
  } else if (parent === `${LOCAL_FILES_HOME}/Mail exports/Inbox.mbox`) {
    nodes = [file('mbox', 812_000_000, parent), file('Info.plist', 1_200, parent)];
  } else {
    nodes = [];
  }
  return {
    content: [{ type: 'text', text: 'Listed.' }],
    structuredContent: { status: 'listed', count: nodes.length },
    _meta: { [SCOPE_UI_META_KEY]: { nodes } },
  };
}

/** The approval's answer in the preview: an .mbox starts; anything else is refused in the engine's words. */
export function previewArchiveApprove(args: { key?: unknown }) {
  const key = typeof args.key === 'string' ? args.key : '';
  const name = key.split('/').pop() ?? '';
  if (!name.endsWith('.mbox')) {
    return {
      content: [{ type: 'text', text: ARCHIVE_APPROVE_COPY.unsupported.split('{formats}').join(ARCHIVE_FORMATS.map((format) => format.label).join(', ')) }],
      structuredContent: { error: 'unsupported' },
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: 'Importing.' }], structuredContent: { status: 'started', name } };
}

/**
 * Delete indexed data (owner, 2026-10-23). Readwise connected and fresh;
 * Dropbox disconnected with its index still on the computer
 * ('delete-data': the ⋯ menu offers Delete indexed data), or after the delete
 * ('delete-data-done': nothing indexed, the plain not-connected row). In the
 * 'delete-data' state the harness answers the delete tool and then reads as
 * the done state, so the confirmation and the result line can be walked.
 */
function deleteDataPreview(done: boolean): SourceDashboardViewModel {
  const status = emptyStatus();
  status.corpora = [
    corpus('internal.readwise.library', 'readwise', 'internal', 'readwise', 250, 250, { withText: 250, embedded: 250 }),
    ...(done ? [] : [corpus('secure_local.dropbox.files', 'file', 'secure_local', 'dropbox', 30_012, 600_000, { withText: 30_012, embedded: 30_012 })]),
    // A chat source after a clean Unpair: no pairing left, its data kept.
    corpus('internal.telegram.messages', 'chat', 'internal', 'telegram', 4200, 4200, { withText: 4200, embedded: 4200 }),
  ];
  const view = buildSourceDashboardViewModel({
    unpairedSources: [{ source_id: 'telegram.messages', state: 'unpaired' }],
    sourceIndexStatus: status,
    schedulerStatus: scheduler([schedulerSource('readwise.library', 'internal.readwise.library', 0.4)]),
    sovereigntyEngine: engine,
    connectedHandleRegistry: registry([handle('readwise.personal', 'readwise', ['readwise.library.sync'], [])]),
    apiKeyAvailability: { readwise: true },
    oauthClientIds: { google: PREVIEW_GOOGLE_CLIENT_ID, dropbox: 'preview-dropbox-app-key' },
    oauthClientSecretAvailability: PREVIEW_GOOGLE_SECRET_ON_FILE,
    googlePilotClientConfigured: true,
    oauthRedirectBaseUrl: PREVIEW_REDIRECT_BASE_URL,
    now: NOW,
  });
  view.model_setup = new ModelSetupService({ config: loadSovereigntyPreset('private-cloud-only'), credentialState: () => 'ready' }).getStatus();
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
    oauthClientSecretAvailability: PREVIEW_GOOGLE_SECRET_ON_FILE,
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

/**
 * Setup's Agents section: ?agents=off (remote access off, nothing connected),
 * ?agents=not-connected, ?agents=relay-unavailable (on, relay down),
 * ?agents=awaiting-terms (on, agreement to accept), ?agents=worker-env (a
 * tunnel named in worker.env), or the default: remote
 * access on with two agents.
 */
export function previewAgentsView(mode: string | null): DashboardAgentsView {
  if (mode === 'off') return { remoteAccess: { state: 'off' }, connections: [] };
  if (mode === 'not-connected') return { remoteAccess: { state: 'not_connected' }, connections: [] };
  if (mode === 'relay-unavailable') {
    return {
      remoteAccess: {
        state: 'not_connected',
        detail: 'Olympus relay unavailable, so agents in the cloud cannot reach Olympus right now. Olympus keeps trying on its own.',
      },
      connections: [],
    };
  }
  if (mode === 'worker-env') {
    return {
      remoteAccess: {
        state: 'on',
        mcpUrl: 'https://quiet-river-1234.trycloudflare.com/mcp',
        openapiUrl: 'https://quiet-river-1234.trycloudflare.com/openapi.json',
        setBy: 'worker_env',
      },
      connections: [],
    };
  }
  if (mode === 'awaiting-terms') {
    return {
      remoteAccess: {
        state: 'not_connected',
        needsTerms: true,
        detail: 'Olympus needs you to accept Let\'s Encrypt\'s subscriber agreement before it can get its certificate.',
      },
      connections: [],
    };
  }
  return {
    remoteAccess: {
      state: 'on',
      mcpUrl: 'https://k7q2m9x4.connect.olympusplugin.ai/mcp',
      openapiUrl: 'https://k7q2m9x4.connect.olympusplugin.ai/openapi.json',
    },
    connections: [
      { id: '0a1b2c3d4e5f60718a', name: 'Claude', kind: 'oauth', createdAt: '2026-07-01T16:20:00.000Z', lastUsedAt: '2026-07-07T18:05:00.000Z' },
      { id: '9f8e7d6c5b4a392817', name: 'Muse', kind: 'bearer', createdAt: '2026-07-06T09:00:00.000Z', lastUsedAt: null },
    ],
  };
}

export const DASHBOARD_PREVIEW_STATES = [
  'review', 'review-unconfigured', 'review-indexing',
  'models', 'models-applying', 'first-install', 'gmail-scope-pending', 'tier-migration', 'partial', 'fresh', 'full', 'dropbox-initial', 'dropbox-update',
  'connect-google', 'connect-google-loopback', 'connect-dropbox', 'connect-x',
  'connect-dropbox-refused', 'connect-dropbox-publisher', 'connect-google-publisher',
  'local-files-off', 'local-files-connected', 'local-files-indexing', 'local-files-reading', 'local-files-needs-permission',
  'local-files-finding', 'local-files-finding-page', 'local-files-sync-checking', 'local-files-sync-checked',
  'local-files-picker', 'local-files-picker-waiting', 'local-files-picker-denied', 'local-files-picker-helper',
  'delete-data', 'delete-data-done',
  ...ARCHIVE_STATES,
] as const;

/** 'delete-data': set once the preview's delete tool has run, so the next read is the done state. */
let previewDataDeleted = false;

const LOCAL_FILES_HOME = '/Users/you';

type PreviewFolderAccess = { state: 'needs_permission' | 'waiting' | 'denied' | 'needs_helper' | 'needs_full_disk_access'; message: string; settings_url?: string };

/**
 * The folder picker's answers for "Files on this computer", as the Mac's
 * scope browser gives them (local-files/scope-browser.ts), with a fake home.
 *   local-files-picker          helper installed: Desktop, Documents, Downloads
 *                               and iCloud Drive say Needs permission; opening
 *                               Desktop lists its folders (the Mac allowed it)
 *   local-files-picker-waiting  opening Desktop: the Mac is asking
 *   local-files-picker-denied   opening Desktop: the Mac said no
 *   local-files-picker-helper   no helper app: guarded folders need it
 * Choosing Everything shows the Full Disk Access note (the top level's access).
 */
export function previewScopeList(state: string, args: { parent_key?: unknown }) {
  const helper = state !== 'local-files-picker-helper';
  const guardedAccess: PreviewFolderAccess = helper
    ? { state: 'needs_permission', message: MAC_ACCESS_COPY.needsPermission }
    : { state: 'needs_helper', message: MAC_ACCESS_COPY.needsHelper };
  const folder = (name: string, extra: Record<string, unknown> = {}, parent?: string) => ({
    key: `${parent ?? LOCAL_FILES_HOME}/${name}`,
    ...(parent ? { parent_key: parent } : {}),
    name,
    kind: 'folder' as const,
    has_children: true,
    selectable: true,
    ...extra,
  });
  const base = { kind: 'folders' as const, source_id: 'local.files', whole_words: getFileScopeSource('local.files')!.wholeScopeWords, account_generation: 'preview-generation', scope_revision: 'preview-revision', status: 'scope_pending' as const, selections: [], whole_account_selected: false };
  const parent = typeof args.parent_key === 'string' ? args.parent_key : '';
  let list: Record<string, unknown>;
  if (!parent) {
    list = {
      ...base,
      nodes: [
        folder('Code', { size_bytes: 14_800_000_000, file_count: 412_000 }),
        folder('Desktop', { access: guardedAccess }),
        folder('Documents', { access: guardedAccess }),
        folder('Downloads', { access: guardedAccess }),
        folder('iCloud Drive', { access: guardedAccess }),
        folder('Movies'),
        folder('Music'),
        folder('Pictures'),
        { key: '/@disk-1', name: 'Backup Drive', kind: 'folder', has_children: true, selectable: true, is_disk: true, access: guardedAccess },
      ],
      access: helper
        ? { state: 'needs_full_disk_access', message: MAC_ACCESS_COPY.fullDiskAccess, settings_url: FULL_DISK_ACCESS_URL }
        : { state: 'needs_helper', message: MAC_ACCESS_COPY.needsHelperWholeComputer },
    };
  } else if (parent === `${LOCAL_FILES_HOME}/Desktop`) {
    const access: PreviewFolderAccess | undefined = !helper ? { state: 'needs_helper', message: MAC_ACCESS_COPY.needsHelper }
      : state === 'local-files-picker-waiting' ? { state: 'waiting', message: MAC_ACCESS_COPY.waiting }
        : state === 'local-files-picker-denied' ? { state: 'denied', message: MAC_ACCESS_COPY.denied('desktop'), settings_url: FILES_AND_FOLDERS_URL }
          : undefined;
    list = access
      ? { ...base, nodes: [], access }
      : { ...base, nodes: [folder('Client work', {}, parent), folder('Sketches', {}, parent), folder('Receipts 2026', {}, parent)] };
  } else if (parent === `${LOCAL_FILES_HOME}/Code`) {
    list = { ...base, nodes: [folder('olympus', { size_bytes: 2_100_000_000, file_count: 61_000 }, parent), folder('notes', {}, parent), folder('website', {}, parent)] };
  } else {
    list = { ...base, nodes: [] };
  }
  return {
    content: [{ type: 'text', text: 'Folders on this computer (preview).' }],
    structuredContent: { kind: 'folders', source_id: 'local.files', status: 'scope_pending' },
    _meta: { [SCOPE_UI_META_KEY]: list },
  };
}

/**
 * Deep link into the picker: `&picker=open,everything` or `&picker=open,folder:Desktop`
 * appends a few clicks to the panel (harness only), in order, each once its
 * control exists.
 */
function pickerAutoScript(spec: string): string {
  const steps = spec.split(',').map((step) => step.trim()).filter((step) => /^[A-Za-z0-9:_ .-]+$/.test(step)).slice(0, 6);
  return `<script>(function(){var steps=${JSON.stringify(steps)};var i=0;var tries=0;`
    + `function find(step){if(step==='open'||step==='import'){var label=step==='open'?'Choose folders':'Import an archive';return Array.prototype.filter.call(document.querySelectorAll('button'),function(b){return b.textContent===label})[0];}`
    + `if(step==='everything')return document.querySelector('[data-key="picker:seg:@account:ingest"]');`
    + `if(step.indexOf('folder:')===0)return document.querySelector('[data-key="picker:open:${LOCAL_FILES_HOME}/'+step.slice(7)+'"]');return null;}`
    + `function tick(){if(i>=steps.length||tries++>200)return;var n=find(steps[i]);if(n&&!n.disabled){n.click();i++;setTimeout(tick,400);return;}setTimeout(tick,150);}`
    + `setTimeout(tick,300);})();</script>`;
}

/** The dashboard tool's result for a preview state, with the computer's Index faster state (and waiting questions, unlocked). */
export function previewDashboardToolResult(state: string, indexFasterOn: boolean, waitingPrivateQuestions = 0) {
  if (state === 'delete-data' && previewDataDeleted) state = 'delete-data-done';
  const result = dashboardToolResult(buildChatGptDashboardViewModel(view(state), { now: NOW, ...buildDashboardPreviewOptions(state) }));
  return {
    ...result,
    _meta: {
      ...(result._meta ?? {}),
      [COMPUTER_META_KEY]: {
        indexFaster: { on: indexFasterOn },
        ...(state === 'local-files-needs-permission' ? { permissionSettings: [{ sourceId: 'local.files', url: FILES_AND_FOLDERS_URL }] } : {}),
        ...(waitingPrivateQuestions > 0 ? { waitingPrivateQuestions } : {}),
        ...(previewArchivesMeta(state) ? { archives: previewArchivesMeta(state) } : {}),
      },
    },
  };
}

/** Invented consult readiness, with no daemon or network calls. */
export function previewOutsideHelp(on: boolean): import('../src/workers/dashboard/outside-help.ts').DashboardOutsideHelpStatus {
  return {
    settings: { state: on ? 'on' : 'off', revision: 1, languages: ['en'], domains: { units: true, countries: true, places: true, technical: true, medicines: true, medicineBrands: true }, strict: false, level: 'unnamed' },
    route: on ? { state: 'configured', profileId: 'preview', model: 'outside/model', policyWritable: true, secretRef: 'env:PREVIEW_ONLY', acknowledgements: { version: 1, accepted: [], complete: true }, readiness: { ready: true, blockers: [], daemonFound: true, torMode: 'per_consult', torFound: true, apiKeyConfigured: true, expiry: { state: 'unknown' }, requestsToday: { count: 0 }, spendToday: { reservedUsd: 0 }, fences: [], routeLabel: 'preview' } } : { state: 'not_configured', policyWritable: true },
    languages: [{ language: 'en', pack: 'preview', state: 'verified', installed: true }], restartPending: false,
  };
}

/** Synthetic inbox questions: never anyone's source text. */
const PREVIEW_WAITING = [
  { path: 'venice', id: 'wq_preview_1', question: 'What did the landlord say about the deposit?', from: 'ChatGPT', askedAt: new Date(NOW.getTime() - 50 * 60_000).toISOString(), unchecked: false, state: 'answered', unread: true, answeredAt: new Date(NOW.getTime() - 49 * 60_000).toISOString() },
  { path: 'anonymous', id: 'wq_preview_2', question: 'What are general tenant deposit rules?', from: 'Grok Bot', askedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), unchecked: false, state: 'answered', unread: false, answeredAt: new Date(NOW.getTime() - 119 * 60_000).toISOString() },
  { id: 'wq_preview_3', question: 'Which flight did I book for March?', from: 'ChatGPT', askedAt: new Date(NOW.getTime() - 26 * 3_600_000).toISOString(), unchecked: false, state: 'answering', unread: false },
] as const;
const previewDeleted = new Set<string>();
const previewSeen = new Set<string>();

export function previewWaitingQuestions(count: number) {
  const questions = Array.from({ length: Math.max(0, count) }, (_, index) => {
    const base = PREVIEW_WAITING[index % PREVIEW_WAITING.length]!;
    const id = index < PREVIEW_WAITING.length ? base.id : `${base.id}_${index}`;
    return { ...base, id, unread: base.unread && !previewSeen.has(id) };
  }).filter((question) => !previewDeleted.has(question.id));
  return { questions, olderRemoved: count > PREVIEW_WAITING.length };
}

/** The inbox's real client actions against synthetic, in-memory fixture state. */
function previewPrivateAnswersAction(body: Record<string, unknown>, count: number): Response {
  const answered = {
    ok: true,
    status: 'answered',
    generation: 1,
    answer: '**Preview only.** This answer is synthetic. Nothing was searched.\n\n- The appointment is **Tuesday at 10:30**.\n- Bring the appointment confirmation.\n\nThe answer stays on this computer, with its sources beneath it.',
    citations: [{ title: 'Appointment confirmation.pdf', source: 'Dropbox', date: '2026-06-30', open: 'preview-source-open-token-00000000' }],
    unanswered: ['The practice’s parking arrangements'],
    left_out: ['Gmail'],
  };
  const listed = previewWaitingQuestions(count);
  if (body.action === 'list') return Response.json({ ok: true, ...listed });
  if (body.action === 'ask') return Response.json(answered);
  if (body.action === 'ask_venice') return Response.json({ ...answered, sent_items: [{ title: 'Appointment confirmation.pdf', source: 'Dropbox' }] });
  if (body.action === 'ask_anonymous') return Response.json({ ...answered, sent: 'Prepared synthetic question', citations: [] });
  if (body.action === 'open') return Response.json({ ok: true, status: 'opened' });
  if (body.action === 'delete_all') {
    listed.questions.forEach((question) => previewDeleted.add(question.id));
    return Response.json({ ok: true, status: 'deleted', removed: listed.questions.length });
  }
  const question = listed.questions.find((item) => item.id === body.id);
  if (!question) return Response.json({ ok: false, error: { code: 'gone', message: 'That answer was deleted' } }, { status: 410 });
  if (body.action === 'read') return Response.json(question.state === 'answered' ? { ...answered, ...(question.path === 'venice' ? { sent_items: [{ title: 'Appointment confirmation.pdf', source: 'Dropbox' }] } : {}), ...('path' in question && question.path === 'anonymous' ? { sent: question.question, answer: '**Outside help · preview only.** Deposit rules depend on the tenancy and location. Check the applicable public guidance.', citations: [], unanswered: [], left_out: [] } : {}) } : { ok: true, status: question.state });
  if (body.action === 'seen') {
    previewSeen.add(question.id);
    return Response.json({ ok: true, status: 'seen' });
  }
  if (body.action === 'delete') {
    previewDeleted.add(question.id);
    return Response.json({ ok: true, status: 'deleted' });
  }
  return Response.json({ ok: false, error: { code: 'preview_only', message: 'Preview only: this action is not available.' } }, { status: 501 });
}

function previewWaitingCount(request: Request, url: URL): number {
  const asked = url.searchParams.get('waiting') ?? /(?:^|;\s*)olympus_preview_waiting=([0-9])/.exec(request.headers.get('cookie') ?? '')?.[1];
  const count = asked === undefined || asked === null ? 3 : Number(asked);
  return Number.isInteger(count) && count >= 0 && count <= 9 ? count : 3;
}

function previewState(request: Request): string {
  const match = /(?:^|;\s*)olympus_preview_state=([a-z-]+)/.exec(request.headers.get('cookie') ?? '');
  const state = match?.[1] ?? 'partial';
  return (DASHBOARD_PREVIEW_STATES as readonly string[]).includes(state) ? state : 'partial';
}

function withCookies(response: Response, cookies: readonly string[]): Response {
  for (const cookie of cookies) response.headers.append('set-cookie', cookie);
  return response;
}

function html(body: string, csp?: string, theme?: string | null): Response {
  if (theme === 'light' || theme === 'dark') body = body.replaceAll('@media (prefers-color-scheme: light)', theme === 'light' ? '@media all' : '@media not all');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(csp ? { 'content-security-policy': csp } : {}) },
  });
}

if (import.meta.main) {
  const port = Number(process.env.DASHBOARD_PREVIEW_PORT ?? 8930);
  Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const state = previewState(request);
    const previewUnlocked = /(?:^|;\s*)olympus_preview_controls=1/.test(request.headers.get('cookie') ?? '');
    // The page's own unlock form posts here. There is no worker behind this
    // harness, so ANY non-empty paste mints a pretend control session (a
    // cookie). Nothing is verified and nothing is stored.
    if (request.method === 'POST' && url.pathname === '/dashboard/control/session') {
      return new Response(JSON.stringify({ csrf_token: 'preview-csrf-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'olympus_preview_controls=1; Path=/; SameSite=Strict' },
      });
    }
    const waitingCount = previewWaitingCount(request, url);
    if (request.method === 'POST' && url.pathname === '/dashboard/private-answers') {
      if (!previewUnlocked) return Response.json({ ok: false, error: { code: 'mac_dashboard_only', message: 'Unlock first.' } }, { status: 403 });
      return previewPrivateAnswersAction(await request.json().catch(() => ({})) as Record<string, unknown>, waitingCount);
    }
    if (request.method === 'POST' && url.pathname === '/dashboard/tools/call') {
      const body = await request.json().catch(() => ({})) as { name?: unknown; arguments?: { source_id?: unknown; parent_key?: unknown } };
      if (body.name === SCOPE_LIST_TOOL_NAME && body.arguments?.source_id === 'local.files' && state.startsWith('local-files')) {
        return Response.json(previewScopeList(state, body.arguments));
      }
      if (body.name === ARCHIVE_BROWSE_TOOL_NAME && state.startsWith('archives-')) return Response.json(previewArchiveBrowse(body.arguments ?? {}));
      if (body.name === ARCHIVE_APPROVE_TOOL_NAME && state.startsWith('archives-')) return Response.json(previewArchiveApprove((body.arguments ?? {}) as { key?: unknown }));
      if (body.name === DELETE_SOURCE_DATA_TOOL_NAME && state === 'delete-data') {
        previewDataDeleted = true;
        return Response.json({
          content: [{ type: 'text', text: 'Indexed data deleted for Dropbox. Your files and accounts were not touched.' }],
          structuredContent: { status: 'deleted', source_id: 'dropbox.files', restarting: true },
        });
      }
      // The waiting count rides only an unlocked session, as on the computer.
      if (body.name === DASHBOARD_TOOL_NAME) return Response.json(previewDashboardToolResult(state, false, previewUnlocked ? waitingCount : 0));
      return Response.json({
        content: [{ type: 'text', text: 'Preview only: there is no worker behind this page, so this action cannot run here.' }],
        structuredContent: { error: 'preview_only' },
        isError: true,
      });
    }
    // The Agents section's controls answer with obviously fake values, so the
    // show-once field can be walked in a browser. Nothing is minted.
    if (request.method === 'POST' && url.pathname === '/dashboard/agents/pairing-code') {
      return Response.json({ ok: true, code: 'PREV-IEW2-CODE', expires_at: new Date(Date.now() + 600_000).toISOString() });
    }
    if (request.method === 'POST' && url.pathname === '/dashboard/agents/keys') {
      return Response.json({ ok: true, token: 'olympus_conn_000000000000000000_preview-key-not-real' });
    }
    if (request.method === 'POST' && url.pathname === '/dashboard/agents/revoke') {
      return Response.json({ ok: true, status_message: 'Preview only: nothing was revoked.' });
    }
    // Every other control POST needs a worker. Say so in the words the page
    // prints, instead of a bare "Request failed.".
    if (request.method === 'POST' && url.pathname.startsWith('/dashboard/')) {
      return Response.json({
        ok: false,
        error: { code: 'preview_only', message: 'Preview only: there is no worker behind this page, so this action cannot run here.' },
      }, { status: 501 });
    }
    if (url.pathname === '/dashboard') {
      // ?state=<name> and ?controls apply to this response and are remembered
      // in cookies for the panel's own calls, so one load renders a state
      // (headless screenshots need no redirect).
      const namedState = url.searchParams.get('state') ?? '';
      const stateOverride = (DASHBOARD_PREVIEW_STATES as readonly string[]).includes(namedState) ? namedState : undefined;
      if (stateOverride === 'delete-data') previewDataDeleted = false;
      const unlocked = previewUnlocked || url.searchParams.has('controls');
      const cookies = [
        ...(stateOverride ? [`olympus_preview_state=${stateOverride}; Path=/; SameSite=Strict`] : []),
        ...(url.searchParams.has('controls') ? ['olympus_preview_controls=1; Path=/; SameSite=Strict'] : []),
        ...(url.searchParams.has('waiting') ? [`olympus_preview_waiting=${waitingCount}; Path=/; SameSite=Strict`] : []),
      ];
      const pageState = stateOverride ?? state;
      const page = dashboardHtmlRoutePage(url);
      if (page === 'legacy') return new Response(null, { status: 302, headers: { location: '/dashboard' } });
      if (page === 'outside_help_moved') return new Response(null, { status: 302, headers: { location: dashboardOutsideHelpRedirect(url) } });
      if (page === 'panel_read') return Response.json(previewDashboardToolResult(pageState, false));
      if (page === 'host') {
        return withCookies(html(renderComputerHostPage({
          panelHtml: (() => {
            const panel = dashboardResourceHtml();
            const auto = url.searchParams.get('picker');
            const at = panel.lastIndexOf('</body>');
            return auto && at >= 0 ? `${panel.slice(0, at)}${pickerAutoScript(auto)}${panel.slice(at)}` : panel;
          })(),
          origin: url.origin,
          ...(unlocked ? { csrfToken: 'preview-csrf-token' } : {}),
        }), COMPUTER_HOST_PAGE_CSP), cookies);
      }
      return withCookies(html(renderDashboardLocalPage(page, {
        url,
        view: view(pageState),
        options: {
          now: NOW,
          ...(unlocked ? { controlSessionCsrfToken: 'preview-csrf-token' } : {}),
          agents: previewAgentsView(url.searchParams.get('agents')),
          // The pretend session is a local one, so Private answers shows its list.
          outsideHelpLocalSession: unlocked,
          outsideHelp: previewOutsideHelp(url.searchParams.get('anonymous') === 'on'),
          privateAnswers: { available: true, destinations: { computer: 'ready', venice: url.searchParams.get('venice') === 'ready' ? 'ready' : url.searchParams.get('venice') === 'unset' ? 'not_set_up' : 'not_allowed' }, ...(unlocked ? { waiting: previewWaitingQuestions(waitingCount) } : {}) },
        },
      }), undefined, url.searchParams.get('theme')), cookies);
    }
    const named = url.pathname.replace(/^\//, '');
    if ((DASHBOARD_PREVIEW_STATES as readonly string[]).includes(named)) {
      return new Response(null, {
        status: 302,
        headers: { location: '/dashboard', 'set-cookie': `olympus_preview_state=${named}; Path=/; SameSite=Strict` },
      });
    }
    return new Response(`states: ${DASHBOARD_PREVIEW_STATES.map((name) => `/${name}`).join(' ')}`, { status: 404 });
  },
  });
  console.log(`dashboard preview listening on http://127.0.0.1:${port}/dashboard`);
  console.log(`  states (open one, then /dashboard): ${DASHBOARD_PREVIEW_STATES.map((name) => `/${name}`).join(' ')}`);
  console.log('  /dashboard?controls unlocks; ?keys ?agents ?private-answers ?connector are the computer\'s own pages; &waiting=N sets the waiting questions');
}
