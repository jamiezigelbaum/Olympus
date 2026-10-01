/**
 * The engine's producer for the ChatGPT dashboard view-model (v1).
 *
 * Input is the engine's own dashboard view (`SourceDashboardViewModel`, the
 * same object `/dashboard.json` serves). Output is `DashboardViewModelV1`.
 *
 * Privacy boundary: nothing here copies a string off the input. Source labels
 * come from the static source definitions, sentences come from vocabulary.ts
 * applied to a SCRUBBED card (every free-text field replaced by a value from a
 * closed set), and every other value is an enum, a number or an ISO time. The
 * owner's sensitivity categories, their examples, folder names, corpus labels,
 * tier compositions and scope selections are never read. The result then
 * passes the allowlisted response builder (response-builder.ts) before it
 * leaves the engine.
 */
import type { ModelSetupView } from '../../core/model-setup.ts';
import type { WorkerCredentialDegradation } from '../credential-degradation.ts';
import {
  DASHBOARD_FIRST_SYNC_FRESHNESS_LABEL,
  DASHBOARD_SUPPORTED_SOURCES,
  type DashboardSourceAction,
  type DashboardSourceCard,
  type DashboardSupportedSourceDefinition,
  type SourceDashboardViewModel,
} from '../source-dashboard.ts';
import {
  dashboardAttentionLine,
  dashboardIsConnectedSource,
  dashboardStatus,
  dashboardSubLine,
  dashboardSyncKeepsFailing,
  dashboardWorkingSummary,
  type DashboardStatus,
  DASHBOARD_CHATGPT_VOCABULARY,
  DASHBOARD_CHATGPT_SETUP_LABELS as CHATGPT_SETUP_LABELS,
} from '../dashboard/vocabulary.ts';
import {
  CONNECT_SOURCE_TOOL_NAME,
  DASHBOARD_TOOL_NAME,
  DISCONNECT_SOURCE_TOOL_NAME,
  SCOPE_LIST_TOOL_NAME,
  type ChatGptDisconnectSourceId,
  type ChatGptOAuthSource,
  type ChatGptScopeSourceId,
  type ConnectionState,
  type DashboardFix,
  type DashboardItem,
  type DashboardSource,
  type DashboardViewModelV1,
} from './dashboard-contract.ts';

/** Static, product-owned labels for answer models. Never the card's own text. */
const ANSWER_MODEL_LABELS = { venice: 'Venice', local: 'Local models', built_in: 'Built-in' } as const;


/** Sources ChatGPT can connect: Olympus's own (publisher) OAuth apps, which return through the relay. */
const CHATGPT_OAUTH_SOURCES = new Set<string>(['gmail', 'google-drive', 'dropbox']);
const SCOPE_SOURCE_IDS = new Set<string>(['gmail.email', 'google_drive.docs', 'dropbox.files']);
const DISCONNECT_SOURCE_IDS = new Set<string>(['gmail.email', 'google_drive.docs', 'dropbox.files', 'x.bookmarks', 'readwise.library']);

/** The only connection labels the engine writes; anything else becomes ''. */
const KNOWN_CONNECTION_LABELS = new Set([
  'not connected',
  'connection state unreadable',
  'awaiting browser consent',
  'reauth required',
  'syncing',
  'connected',
  'connected · live session not checked',
  'connected, waiting for first sync',
  'connected · waiting for new messages',
  'connected · choose folders to start',
  'connected · choose mail to start',
  'unpaired',
  'unpair state unreadable',
  'Unpair incomplete — manual cleanup required',
  'synced',
]);
const SYNCED_RELATIVE = /^synced (just now|less than 1 hour ago|\d+ (minute|hour|day|week|month|year)s? ago)$/;

const KNOWN_READINESS_LABELS = new Set([
  'Connect this source',
  'Ready for questions; sync paused',
  'Ready for questions',
  'Syncing now',
  'Preparing answer-ready text',
  'Waiting for the first sync',
]);

const KNOWN_QUEUE_LABELS = new Set(['Needs attention', 'Working now', 'Waiting to catch up', 'Caught up']);

export interface ChatGptDashboardOptions {
  now?: Date;
  /**
   * The built-in embedding model's state, from the embeddings lane. Absent
   * means it is derived from model setup.
   */
  embedding?: DashboardViewModelV1['models']['embedding'];
}

export function buildChatGptDashboardViewModel(
  view: SourceDashboardViewModel,
  options: ChatGptDashboardOptions = {},
): DashboardViewModelV1 {
  const now = options.now ?? new Date();
  const degraded = scrubDegradations(view.degraded_credentials);
  const rows = publicCards(view.sources).map(({ definition, card }) => {
    const scrubbed = scrubCard(definition, card);
    const status = dashboardStatus({ source: scrubbed, ...(degraded ? { degradedCredentials: degraded } : {}) });
    return { definition, card: scrubbed, status, actionKind: card.connection.action.kind };
  });

  const sources: DashboardSource[] = rows
    .map(({ definition, card, status, actionKind }, index) => ({
      entry: sourceEntry(definition, card, status, actionKind, degraded),
      index,
    }))
    .sort((a, b) => groupRank(a.entry.group) - groupRank(b.entry.group) || a.index - b.index)
    .map(({ entry }) => entry);

  const needsYou: DashboardItem[] = rows
    .filter(({ status }) => status === 'Needs you' || status === 'Failing')
    .map(({ definition, card }) => attentionItem(definition, card, degraded));

  const embedding = options.embedding ?? embeddingFromModelSetup(view.model_setup);
  // Models are status only in ChatGPT (owner decision 2026-10-01): the fix is
  // to check again; a built-in download retries on its own.
  if (embedding.state === 'failed') {
    needsYou.push({ id: 'model:embedding', sentence: DASHBOARD_CHATGPT_VOCABULARY.embeddingNeedsAttention, fix: checkAgainFix() });
  }
  const answers = answersFromModelSetup(view.model_setup);
  if (answers && !answers.ready) {
    needsYou.push({ id: 'model:answers', sentence: DASHBOARD_CHATGPT_VOCABULARY.answerModelNeedsAttention, fix: checkAgainFix() });
  }

  const progress = overallProgress(rows.map((row) => row.card), rows.map((row) => row.status));
  const connected = rows.some(({ card }) => dashboardIsConnectedSource(card));
  const anyAnswerReady = rows.some(({ card }) => card.answer_readiness.state === 'ready');
  const connection = connectionFor({ connected, anyAnswerReady, embedding, progress });

  return {
    v: 1,
    connection,
    needsYou,
    sources,
    ...(progress ? { progress } : {}),
    models: {
      embedding,
      ...(answers ? { answers } : {}),
      change: {
        label: CHATGPT_SETUP_LABELS.changeModels,
        tool: DASHBOARD_TOOL_NAME,
        args: {},
        disabledReason: DASHBOARD_CHATGPT_VOCABULARY.changeModelsOnMac,
      },
    },
    generatedAt: isoOrNow(view.generated_at, now),
  };
}

interface PublicCard {
  definition: DashboardSupportedSourceDefinition;
  card: DashboardSourceCard;
}

/**
 * Cards for the product's own source roster only, one per source, in roster
 * order. A card whose source id is not a known definition (an unassigned or
 * owner-named corpus) never reaches ChatGPT; neither does a model lane.
 */
function publicCards(cards: readonly DashboardSourceCard[]): PublicCard[] {
  const out: PublicCard[] = [];
  for (const definition of DASHBOARD_SUPPORTED_SOURCES) {
    if (definition.family === 'model') continue;
    const card = cards.find((candidate) => candidate.source_id === definition.source_id);
    if (card) out.push({ definition, card });
  }
  return out;
}

function groupRank(group: DashboardSource['group']): number {
  return group === 'local' ? 0 : 1;
}

function sourceGroup(definition: DashboardSupportedSourceDefinition): DashboardSource['group'] {
  return definition.connect_kind === 'local' ? 'local' : 'cloud';
}

function sourceEntry(
  definition: DashboardSupportedSourceDefinition,
  card: DashboardSourceCard,
  status: DashboardStatus,
  actionKind: DashboardSourceAction['kind'],
  degraded: WorkerCredentialDegradation[] | undefined,
): DashboardSource {
  const detail = dashboardSubLine(card, degraded ? { degradedCredentials: degraded } : undefined);
  const lastSyncAt = isoOrUndefined(card.last_sync_at);
  const primary = status === 'Off'
    ? (actionKind === 'none' ? undefined : connectFix(definition))
    : scopePending(card) ? scopeFix(definition, card) : undefined;
  const menu: DashboardFix[] = [];
  if (status !== 'Off' && card.scope_selection && !scopePending(card)) {
    const fix = scopeFix(definition, card);
    if (fix) menu.push(fix);
  }
  if (status !== 'Off' && DISCONNECT_SOURCE_IDS.has(definition.source_id)) {
    menu.push({
      label: CHATGPT_SETUP_LABELS.disconnect,
      tool: DISCONNECT_SOURCE_TOOL_NAME,
      args: { source_id: definition.source_id as ChatGptDisconnectSourceId },
      destructive: true,
    });
  }
  return {
    id: definition.source_id,
    label: definition.label,
    group: sourceGroup(definition),
    status,
    ...(detail ? { detail } : {}),
    ...(lastSyncAt ? { lastSyncAt } : {}),
    ...(primary ? { primary } : {}),
    ...(menu.length > 0 ? { menu } : {}),
  };
}

function attentionItem(
  definition: DashboardSupportedSourceDefinition,
  card: DashboardSourceCard,
  degraded: WorkerCredentialDegradation[] | undefined,
): DashboardItem {
  const reason = dashboardAttentionLine(card, degraded ? { degradedCredentials: degraded } : undefined);
  const sentence = reason ? `${definition.label} — ${reason}` : definition.label;
  const reauth = card.connection.state === 'reauth_required'
    || (card.connection.state !== 'connected' && card.coverage.indexed_items > 0 && !dashboardIsConnectedSource(card));
  const reconnect = reauth ? oauthSource(definition) : undefined;
  const fix = reconnect
    ? { label: DASHBOARD_CHATGPT_VOCABULARY.reconnect, tool: CONNECT_SOURCE_TOOL_NAME, args: { source: reconnect } }
    : scopePending(card) ? scopeFix(definition, card) ?? checkAgainFix() : checkAgainFix();
  return { id: `source:${definition.source_id}`, sentence, fix };
}

function checkAgainFix(): DashboardFix {
  return { label: DASHBOARD_CHATGPT_VOCABULARY.checkAgain, tool: DASHBOARD_TOOL_NAME, args: {} };
}

/** The publisher-app OAuth source for a definition, when ChatGPT can connect it. */
function oauthSource(definition: DashboardSupportedSourceDefinition): ChatGptOAuthSource | undefined {
  const action = definition.connect_action;
  return action.kind === 'oauth' && CHATGPT_OAUTH_SOURCES.has(action.source) ? action.source as ChatGptOAuthSource : undefined;
}

/**
 * Connect from ChatGPT: Gmail, Drive and Dropbox through Olympus's own apps.
 * X (bring-your-own app), Readwise (API key) and paired chats are set up on
 * the Mac; their control says so and checks again.
 */
function connectFix(definition: DashboardSupportedSourceDefinition): DashboardFix {
  const source = oauthSource(definition);
  return source
    ? { label: CHATGPT_SETUP_LABELS.connect, tool: CONNECT_SOURCE_TOOL_NAME, args: { source } }
    : { label: CHATGPT_SETUP_LABELS.connect, tool: DASHBOARD_TOOL_NAME, args: {}, disabledReason: DASHBOARD_CHATGPT_VOCABULARY.connectOnMac };
}

function scopePending(card: DashboardSourceCard): boolean {
  return card.scope_selection?.connected === true && card.scope_selection.status === 'scope_pending';
}

function scopeFix(definition: DashboardSupportedSourceDefinition, card: DashboardSourceCard): DashboardFix | undefined {
  if (!card.scope_selection?.connected || !SCOPE_SOURCE_IDS.has(definition.source_id)) return undefined;
  return {
    label: card.scope_selection.kind === 'mail' ? CHATGPT_SETUP_LABELS.chooseMail : CHATGPT_SETUP_LABELS.chooseFolders,
    tool: SCOPE_LIST_TOOL_NAME,
    args: { source_id: definition.source_id as ChatGptScopeSourceId },
  };
}

function connectionFor(input: {
  connected: boolean;
  anyAnswerReady: boolean;
  embedding: DashboardViewModelV1['models']['embedding'];
  progress: DashboardViewModelV1['progress'] | undefined;
}): DashboardViewModelV1['connection'] {
  // `installing` disables every control on the page, so it covers only the
  // built-in model download. With no source yet, or a first index running,
  // Olympus is set up and the owner's next step is a control on the page:
  // Connect, or choosing folders.
  if (input.embedding.state === 'downloading') {
    const state: ConnectionState = 'installing';
    return {
      state,
      progress: { percent: clampPercent(input.embedding.percent ?? 0), label: DASHBOARD_CHATGPT_VOCABULARY.installingModel },
    };
  }
  return { state: 'ready' };
}

function embeddingFromModelSetup(setup: ModelSetupView | undefined): DashboardViewModelV1['models']['embedding'] {
  // No model setup on the page means nothing is required of the owner.
  if (!setup) return { kind: 'custom', state: 'ready' };
  const required = setup.cards.filter((card) => card.required);
  const failed = required.some((card) => card.state === 'needs_attention' || card.state === 'not_configured');
  return { kind: 'custom', state: failed ? 'failed' : 'ready' };
}

function answersFromModelSetup(setup: ModelSetupView | undefined): DashboardViewModelV1['models']['answers'] {
  if (!setup) return undefined;
  const venice = setup.cards.find((card) => card.id === 'venice' && card.required);
  if (venice) return { kind: 'venice', label: ANSWER_MODEL_LABELS.venice, ready: venice.state === 'ready' };
  const local = setup.cards.find((card) => card.id === 'local' && card.required);
  if (local) return { kind: 'local', label: ANSWER_MODEL_LABELS.local, ready: local.state === 'ready' };
  return undefined;
}

type Unit = NonNullable<DashboardViewModelV1['progress']>['unit'];

function unitFor(card: DashboardSourceCard): Unit {
  if (card.family === 'file') return 'files';
  if (card.family === 'email' || card.family === 'chat') return 'messages';
  return 'items';
}

/**
 * One progress block across connected sources, from the same per-source
 * working summary the dashboard's own cards use. Absent when every connected
 * source is fully working, or nothing gives a defensible denominator.
 */
function overallProgress(
  cards: readonly DashboardSourceCard[],
  statuses: readonly DashboardStatus[],
): DashboardViewModelV1['progress'] | undefined {
  let inScope = 0;
  let read = 0;
  let embedded = 0;
  let embeddedKnown = true;
  let eta: number | undefined;
  let stalled = false;
  let initial = false;
  let unit: Unit | undefined;
  let mixed = false;
  let anyUnfinished = false;
  cards.forEach((card, index) => {
    if (!dashboardIsConnectedSource(card)) return;
    const summary = dashboardWorkingSummary(card);
    if (!summary) return;
    inScope += summary.in_scope_items;
    read += summary.read_items;
    if (typeof card.coverage.embedded_files === 'number') {
      embedded += Math.min(summary.in_scope_items, Math.max(0, card.coverage.embedded_files));
    } else {
      embeddedKnown = false;
    }
    if (!summary.fully_working) anyUnfinished = true;
    const cardUnit = unitFor(card);
    if (unit === undefined) unit = cardUnit;
    else if (unit !== cardUnit) mixed = true;
    if (card.freshness.label === DASHBOARD_FIRST_SYNC_FRESHNESS_LABEL) initial = true;
    const minutes = card.progress?.eta_minutes;
    if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
      eta = Math.max(eta ?? 0, Math.round(minutes * 60));
    }
    if (dashboardSyncKeepsFailing(card) || (statuses[index] === 'Needs you' && card.queue_health.needs_attention > 0)) {
      stalled = true;
    }
  });
  if (inScope <= 0 || !anyUnfinished) return undefined;
  const progressUnit: Unit = mixed || unit === undefined ? 'items' : unit;
  const details: NonNullable<DashboardViewModelV1['progress']>['details'] = [
    { stage: DASHBOARD_CHATGPT_VOCABULARY.stageReading, unit: progressUnit, done: read, total: inScope },
  ];
  if (embeddedKnown) {
    details.push({ stage: DASHBOARD_CHATGPT_VOCABULARY.stageSearchable, unit: progressUnit, done: embedded, total: inScope });
  }
  return {
    unit: progressUnit,
    phase: initial ? 'initial' : 'refresh',
    percent: clampPercent((read / inScope) * 100),
    itemsLeft: Math.max(0, inScope - read),
    ...(eta !== undefined ? { etaSeconds: eta } : {}),
    stalled,
    details,
  };
}

/**
 * The card with every free-text field pinned to the definition or to a closed
 * set, so vocabulary.ts can only ever compose sentences from known words.
 * Explicit field-by-field copy: nothing is spread from the input card.
 */
export function scrubCard(definition: DashboardSupportedSourceDefinition, card: DashboardSourceCard): DashboardSourceCard {
  const connectionLabel = KNOWN_CONNECTION_LABELS.has(card.connection.label) || SYNCED_RELATIVE.test(card.connection.label)
    ? card.connection.label
    : '';
  const freshnessLabel = card.freshness.label === DASHBOARD_FIRST_SYNC_FRESHNESS_LABEL
    || card.freshness.label.startsWith('Answer lane:')
    ? card.freshness.label
    : '';
  const pending = card.connection.pending;
  return {
    corpus_id: definition.primary_corpus_id,
    source_id: definition.source_id,
    label: definition.label,
    provider: definition.provider,
    family: definition.family,
    trust_domain: definition.trust_domain,
    configured: card.configured === true,
    ...(card.scope_selection
      ? {
          scope_selection: {
            required: true as const,
            ...(card.scope_selection.kind === 'mail' ? { kind: 'mail' as const } : { kind: 'folders' as const }),
            status: card.scope_selection.status === 'approved' ? 'approved' as const : 'scope_pending' as const,
            connected: card.scope_selection.connected === true,
            ...(typeof card.scope_selection.ingestion_enabled === 'boolean'
              ? { ingestion_enabled: card.scope_selection.ingestion_enabled }
              : {}),
          },
        }
      : {}),
    freshness: {
      label: freshnessLabel,
      ...(finite(card.freshness.hours) ? { hours: card.freshness.hours } : {}),
      stale: card.freshness.stale === true,
    },
    coverage: {
      indexed_items: count(card.coverage.indexed_items),
      content_ready_items: count(card.coverage.content_ready_items),
      embedded_items: count(card.coverage.embedded_items),
      ...(finite(card.coverage.embedded_files) ? { embedded_files: count(card.coverage.embedded_files) } : {}),
      needs_review_items: count(card.coverage.needs_review_items),
      ...(finite(card.coverage.not_read_by_policy_items)
        ? { not_read_by_policy_items: count(card.coverage.not_read_by_policy_items) }
        : {}),
      ...(finite(card.coverage.answer_ready_eligible_items)
        ? { answer_ready_eligible_items: count(card.coverage.answer_ready_eligible_items) }
        : {}),
    },
    ingestion_health: {
      coverage_percent: finite(card.ingestion_health.coverage_percent) ? card.ingestion_health.coverage_percent : 0,
      stuck_count: count(card.ingestion_health.stuck_count),
      drain_state: (['enabled', 'disabled', 'held', 'unknown'] as const).includes(card.ingestion_health.drain_state)
        ? card.ingestion_health.drain_state
        : 'unknown',
      label: '',
    },
    tier_composition: [],
    queue_health: {
      label: KNOWN_QUEUE_LABELS.has(card.queue_health.label) ? card.queue_health.label : '',
      waiting: count(card.queue_health.waiting),
      active: count(card.queue_health.active),
      needs_attention: count(card.queue_health.needs_attention),
      ...(finite(card.queue_health.retrying_tasks) ? { retrying_tasks: count(card.queue_health.retrying_tasks) } : {}),
      ...(finite(card.queue_health.failing_tasks) ? { failing_tasks: count(card.queue_health.failing_tasks) } : {}),
    },
    answer_readiness: {
      state: card.answer_readiness.state,
      label: KNOWN_READINESS_LABELS.has(card.answer_readiness.label) ? card.answer_readiness.label : '',
    },
    connection: {
      state: card.connection.state,
      label: connectionLabel,
      // Instructions, redirect URIs and client ids stay on the Mac.
      action: { kind: 'none' },
      handles: [],
      ...(pending && finite(pending.expires_in_minutes)
        ? { pending: { started_at: '', expires_at: '', expires_in_minutes: count(pending.expires_in_minutes) } }
        : {}),
    },
    ...(card.progress && finite(card.progress.indexed_items_per_hour)
      ? {
          progress: {
            indexed_items_per_hour: card.progress.indexed_items_per_hour,
            ...(finite(card.progress.eta_minutes) ? { eta_minutes: card.progress.eta_minutes } : {}),
          },
        }
      : {}),
    ...(card.schedule
      ? {
          schedule: {
            running: card.schedule.running === true,
            consecutive_failures: count(card.schedule.consecutive_failures),
            // Only a marker vocabulary.ts recognizes changes a sentence; the
            // marker itself is never printed.
            ...(typeof card.schedule.degraded_reason === 'string' ? { degraded_reason: card.schedule.degraded_reason } : {}),
          },
        }
      : {}),
    ...(card.embedding_backlog
      ? {
          embedding_backlog: {
            chunks: count(card.embedding_backlog.chunks),
            embedded_chunks: count(card.embedding_backlog.embedded_chunks),
            missing_chunks: count(card.embedding_backlog.missing_chunks),
            refresh_needed: card.embedding_backlog.refresh_needed === true,
          },
        }
      : {}),
    ...(isoOrUndefined(card.last_sync_at) ? { last_sync_at: isoOrUndefined(card.last_sync_at)! } : {}),
  };
}

/** Degradations reduced to what status matching reads; the name is matched, never printed. */
function scrubDegradations(input: readonly WorkerCredentialDegradation[] | undefined): WorkerCredentialDegradation[] | undefined {
  if (!input || input.length === 0) return undefined;
  return input.map((entry) => ({
    kind: 'worker_credential_degraded',
    display_name: typeof entry.display_name === 'string' ? entry.display_name : '',
    state: entry.state,
    status_label: 'Credential unavailable - needs your attention',
    hint: '',
    attempts: count(entry.attempts),
    max_attempts: count(entry.max_attempts),
  }));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function count(value: unknown): number {
  return finite(value) ? Math.max(0, Math.round(value)) : 0;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

function isoOrNow(value: unknown, now: Date): string {
  return isoOrUndefined(value) ?? now.toISOString();
}
