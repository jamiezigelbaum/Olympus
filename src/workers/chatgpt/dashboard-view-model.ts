/**
 * The engine's producer for the ChatGPT dashboard view-model (v1).
 *
 * Input is the engine's own dashboard view (`SourceDashboardViewModel`, the
 * same object `/dashboard.json` serves). Output is `DashboardViewModelV1`.
 *
 * Privacy boundary: nothing here copies a string off the input, with one
 * owner-ruled exception (2026-10-10): the names of a source's newest
 * unreadable files, which may reach ChatGPT (only content is Private;
 * Secrets items are never counted or named). Source labels
 * come from the static source definitions, sentences come from vocabulary.ts
 * applied to a SCRUBBED card (every free-text field replaced by a value from a
 * closed set), and every other value is an enum, a number or an ISO time. The
 * owner's sensitivity categories, their examples, folder names, corpus labels,
 * tier compositions and scope selections are never read. The result then
 * passes the allowlisted response builder (response-builder.ts) before it
 * leaves the engine.
 */
import type { ModelSetupView } from '../../core/model-setup.ts';
import { formatSpaceToFree, modelInstallSpaceToFree } from '../../core/model-install-failure.ts';
import {
  OPEN_CONNECT_SOURCES,
  openPageUrl,
  openUnreadableSourceFor,
  type OpenConnectSource,
  type OpenFixSection,
} from '../../core/open-targets.ts';
import {
  dashboardCredentialProblem as credentialProblem,
  dashboardHonestStatus,
  dashboardRefusedFirstConnect as refusedFirstConnect,
} from '../dashboard/shared-status.ts';
import { dashboardSourceProgress, type DashboardPhase } from '../dashboard/phases.ts';
import { isSourceFailureKind, sourceFailureKind, sourceFailureRef } from '../dashboard/source-failure.ts';
import type { WorkerCredentialDegradation } from '../credential-degradation.ts';
import type { BuiltInTranscriptionDashboardState } from '../source-index/built-in-reasoning/transcription-model.ts';
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
  dashboardManualSyncLine,
  dashboardOperatorPaused,
  dashboardStatus,
  dashboardSubLine,
  dashboardSyncKeepsFailing,
  dashboardWorkingSummary,
  type DashboardStatus,
  DASHBOARD_CHATGPT_VOCABULARY,
  DASHBOARD_CHATGPT_PAGE_COPY,
  DASHBOARD_CHATGPT_PICKER_COPY,
  DASHBOARD_CHATGPT_SETUP_LABELS as CHATGPT_SETUP_LABELS,
  DASHBOARD_CHATGPT_PRIVACY_SETUP_COPY,
  DASHBOARD_MANY_UNREADABLE_LABEL,
  dashboardUnreadableMoreLabel,
} from '../dashboard/vocabulary.ts';
import {
  CONNECT_SOURCE_TOOL_NAME,
  DASHBOARD_TOOL_NAME,
  MODEL_RETRY_TOOL_NAME,
  PRIVACY_GET_TOOL_NAME,
  DISCONNECT_SOURCE_TOOL_NAME,
  SCOPE_LIST_TOOL_NAME,
  SYNC_SOURCE_TOOL_NAME,
  type ChatGptDisconnectSourceId,
  type ChatGptOAuthSource,
  type ChatGptScopeSourceId,
  type ChatGptSyncSourceId,
  type ConnectionState,
  type DashboardFix,
  type DashboardItem,
  type DashboardSource,
  type DashboardUnreadable,
  type DashboardViewModelV1,
  type ModelInstall,
  type ModelInstallFailedReason,
  type SourceProgress,
  type SourceStallDetail,
  type SourceStalledReason,
  type TranscriptionModelView,
  UNREADABLE_NAMES_IN_RESULT,
  unreadableNames,
} from './dashboard-contract.ts';

/** Static, product-owned labels for answer models. Never the card's own text. */
const ANSWER_MODEL_LABELS = { venice: 'Venice', local: 'Local models', built_in: 'Built-in' } as const;

/**
 * A source mid-sign-in, in ChatGPT's words. The engine's own line for this
 * state ("waiting for you to approve in the Gmail tab · expires in 9m") speaks
 * to the Mac's dashboard, where the provider's tab sits beside it; from
 * ChatGPT the sign-in may be on another device, and the expiry travels as
 * `connecting.expiresAt` for the page to word itself.
 */
const CONNECTING_DETAIL = DASHBOARD_CHATGPT_PICKER_COPY.connectWaiting;
const CONNECTING_REASON = DASHBOARD_CHATGPT_PICKER_COPY.connectWaiting.replace(/…$/, '').replace(/^W/, 'w');

/**
 * A source's line while its first stage that is not done is still running.
 * Replaces the freshness line ("synced just now"), which would claim a
 * finished source over a bar that is not full.
 */
const STAGE_DETAIL: Readonly<Record<Exclude<SourceProgress['stage'], 'done'>, string>> = {
  listing: 'Finding items',
  reading: DASHBOARD_CHATGPT_VOCABULARY.stageReading,
  indexing: DASHBOARD_CHATGPT_VOCABULARY.stageSearchable,
};



/** Sources ChatGPT can connect: Olympus's own (publisher) OAuth apps, which return through the relay. */
const CHATGPT_OAUTH_SOURCES = new Set<string>(['gmail', 'google-drive', 'dropbox']);
const SCOPE_SOURCE_IDS = new Set<string>(['gmail.email', 'google_drive.docs', 'dropbox.files']);
const DISCONNECT_SOURCE_IDS = new Set<string>(['gmail.email', 'google_drive.docs', 'dropbox.files', 'x.bookmarks', 'readwise.library']);
/** Sources Sync now runs for from ChatGPT (olympus_sync_source). */
const SYNC_SOURCE_IDS = new Set<string>(['gmail.email', 'google_drive.docs', 'dropbox.files', 'x.bookmarks', 'readwise.library']);

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
  DASHBOARD_MANY_UNREADABLE_LABEL,
]);

/** Provider refusal codes the vocabulary words on their own; any other reads as a generic refusal. */
const KNOWN_REFUSAL_CODES = new Set(['access_denied', 'redirect_uri_mismatch', 'invalid_redirect_uri', 'redirect_uri_not_registered']);

const KNOWN_QUEUE_LABELS = new Set(['Needs attention', 'Working now', 'Waiting to catch up', 'Caught up']);

export interface ChatGptDashboardOptions {
  now?: Date;
  /**
   * The built-in embedding model's state, from the embeddings lane. Absent
   * means it is derived from model setup.
   */
  embedding?: DashboardViewModelV1['models']['embedding'];
  /** The owner's privacy settings, counts only (olympus_privacy_get). Absent: not reported. */
  privacy?: { configured: boolean; pendingCount: number; ruleCount: number };
  /**
   * The built-in private model (analyst-built-in.ts builtInPrivateModelStatus),
   * when it is on for this machine. It is the answer model shown when no
   * Venice or local answer model is set up. Its download never puts the page
   * into `installing`; it only joins the embedding download's percent.
   */
  privateModel?: BuiltInPrivateModelView;
  /** The built-in transcription model, when it is this machine's transcriber (models.transcription). */
  transcription?: BuiltInTranscriptionDashboardState;
  /** Remote mode, when the engine declares it runs on a server (DashboardViewModelV1.remote). */
  remote?: DashboardViewModelV1['remote'];
}

export interface BuiltInPrivateModelView {
  state: 'not_started' | 'downloading' | 'verifying' | 'loading' | 'ready' | 'failed';
  /** 0-100. */
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  /** `failed` only: a fixed code (core/model-install-failure.ts), never the installer's message. */
  failedReason?: ModelInstallFailedReason;
  /** `disk_full` only: bytes to free before Try again can work (modelInstallSpaceToFree). */
  spaceToFreeBytes?: number;
}

export function buildChatGptDashboardViewModel(
  view: SourceDashboardViewModel,
  options: ChatGptDashboardOptions = {},
): DashboardViewModelV1 {
  const now = options.now ?? new Date();
  const degraded = scrubDegradations(view.degraded_credentials);
  const embedding = options.embedding ?? embeddingFromModelSetup(view.model_setup);
  const rows = publicCards(view.sources).map(({ definition, card }) => {
    const scrubbed = scrubCard(definition, card);
    const connecting = connectingFor(definition, card, now);
    const vocabularyStatus = dashboardStatus({ source: scrubbed, ...(degraded ? { degradedCredentials: degraded } : {}) });
    const credentials = credentialProblem(scrubbed, degraded);
    // A first connect the provider refused has nothing behind it: no progress,
    // exactly as an Off source has none, but it stays in Needs you.
    const measured = connecting || vocabularyStatus === 'Off' || refusedFirstConnect(scrubbed)
      ? undefined
      : measuredSourceProgress(card, scrubbed, embedding,
        // A sign-in already under way is not a signed-out source: its row keeps
        // the finish-signing-in sentence.
        card.connection.state !== 'awaiting_consent'
          && wantsReconnect(scrubbed, vocabularyStatus, card.connection.action.kind, degraded, undefined), now);
    const progress = measured?.progress;
    // Mid-sign-in reads Needs you whatever else the card says: the owner's
    // next step is finishing the sign-in.
    // A credential problem (a provider refusal, a degraded or expired sign-in)
    // is Needs you whatever the progress or indexing state: its fix is the
    // owner's, never the engine's.
    let status: DashboardStatus = connecting || credentials ? 'Needs you' : dashboardHonestStatus(vocabularyStatus, progress);
    // A source working normally (a stage unfinished, nothing stalled) offers
    // no action: the only fix this page had for it was "Check again", a
    // button over work that needs nothing (owner fresh-install test,
    // 2026-10-01). A real fix (reconnect, choose folders) still stands.
    if (!connecting && !credentials && (status === 'Needs you' || status === 'Failing') && progress && progress.stage !== 'done'
      && !progress.stalled && checksAgainOnly(attentionItem(definition, scrubbed, card.connection.action.kind, degraded, undefined, progress).fix)) {
      status = 'Working';
    }
    // Whether this worker can sync the source at all: the raw card's own
    // flag, which the scrubbed card does not carry.
    const sync = connecting || status === 'Off' || card.sync_now_available !== true
      ? undefined
      : syncFix(definition, scrubbed, status, card.connection.action.kind, degraded, progress);
    return { definition, card: scrubbed, status, actionKind: card.connection.action.kind, connecting, progress, counts: measured?.counts, sync };
  });

  // One list (owner, 2026-10-09): sources that need the owner first, then
  // connected sources, then the ones not connected yet; roster order within.
  const sources: DashboardSource[] = rows
    .map(({ definition, card, status, actionKind, connecting, progress, sync }, index) => ({
      entry: sourceEntry(definition, card, status, actionKind, degraded, connecting, progress, now, sync),
      index,
    }))
    .sort((a, b) => sourceRank(a.entry) - sourceRank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);

  const needsYou: DashboardItem[] = rows
    .filter(({ status }) => status === 'Needs you' || status === 'Failing')
    .map(({ definition, card, actionKind, connecting, progress, sync }) => attentionItem(definition, card, actionKind, degraded, connecting, progress, sync));

  // Models are status only in ChatGPT (owner decision 2026-10-01): a
  // configured model's fix is to check again; a built-in install that failed
  // is started again from here (olympus_model_retry).
  if (embedding.state === 'failed') {
    needsYou.push({
      id: 'model:embedding',
      sentence: embedding.kind === 'built_in'
        ? withDiskFreeUp(DASHBOARD_CHATGPT_VOCABULARY.modelInstallFailed.embedding[embedding.failedReason ?? 'unknown'],
          embedding.failedReason, modelInstallSpaceToFree(embedding))
        : DASHBOARD_CHATGPT_VOCABULARY.embeddingNeedsAttention,
      fix: embedding.kind === 'built_in' ? retryFix('embedding') : checkAgainFix(openOnComputer(undefined, 'search')),
    });
  }
  const answers = answersFromModelSetup(view.model_setup) ?? builtInAnswers(options.privateModel);
  // A built-in model still downloading is not something for the owner to fix.
  const answersNeedAttention = answers !== undefined && !answers.ready
    && (answers.kind !== 'built_in' || options.privateModel?.state === 'failed');
  if (answersNeedAttention) {
    needsYou.push({
      id: 'model:answers',
      sentence: answers.kind === 'built_in'
        ? withDiskFreeUp(DASHBOARD_CHATGPT_VOCABULARY.modelInstallFailed.answers[options.privateModel?.failedReason ?? 'unknown'],
          options.privateModel?.failedReason, options.privateModel?.spaceToFreeBytes)
        : DASHBOARD_CHATGPT_VOCABULARY.answerModelNeedsAttention,
      fix: answers.kind === 'built_in' ? retryFix('answers') : checkAgainFix(openOnComputer(undefined, 'answers')),
    });
  }

  // Privacy is set once, in ChatGPT: until then it is one thing the owner
  // can do, never a blocker (unflagged items are Personal meanwhile).
  if (options.privacy && !options.privacy.configured) {
    needsYou.push({
      id: 'privacy:setup',
      sentence: DASHBOARD_CHATGPT_PRIVACY_SETUP_COPY.sentence,
      fix: { label: DASHBOARD_CHATGPT_PRIVACY_SETUP_COPY.label, tool: PRIVACY_GET_TOOL_NAME, args: {} },
    });
  }

  const transcription = transcriptionModel(options.transcription);

  const progress = overallProgress(rows);
  const connected = rows.some(({ card }) => dashboardIsConnectedSource(card));
  const anyAnswerReady = rows.some(({ card }) => card.answer_readiness.state === 'ready');
  const connection = connectionFor({ connected, anyAnswerReady, embedding, progress, privateModel: options.privateModel });

  return {
    v: 1,
    connection,
    needsYou,
    sources,
    ...(progress ? { progress } : {}),
    models: {
      embedding,
      ...(answers ? { answers } : {}),
      ...(transcription ? { transcription } : {}),
      change: {
        label: CHATGPT_SETUP_LABELS.changeModels,
        tool: DASHBOARD_TOOL_NAME,
        args: {},
        disabledReason: DASHBOARD_CHATGPT_VOCABULARY.changeModelsOnMac,
        href: openOnComputer(undefined, 'models'),
      },
    },
    ...(options.privacy
      ? {
          privacy: {
            configured: options.privacy.configured,
            pendingCount: Math.max(0, Math.floor(options.privacy.pendingCount)),
            ruleCount: Math.max(0, Math.floor(options.privacy.ruleCount)),
          },
        }
      : {}),
    ...(options.remote ? { remote: options.remote } : {}),
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

/** Problems first, then connected sources, then sources not connected yet. */
function sourceRank(source: DashboardSource): number {
  if (source.status === 'Needs you' || source.status === 'Failing') return 0;
  return source.status === 'Off' ? 2 : 1;
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
  connecting: Connecting | undefined,
  progress: SourceProgress | undefined,
  now: Date,
  sync?: DashboardFix,
): DashboardSource {
  const inFlight = progress && progress.stage !== 'done' && status !== 'Needs you' && status !== 'Failing';
  const ownDetail = connecting
    ? CONNECTING_DETAIL
    : inFlight
      ? STAGE_DETAIL[progress.stage as Exclude<SourceProgress['stage'], 'done'>]
      : dashboardSubLine(card, { surface: 'chatgpt', now, ...(degraded ? { degradedCredentials: degraded } : {}) });
  // The owner's Sync now press, while it is the latest word, leads the row:
  // "Checking Dropbox…", then what it found. The engine's own words, so the
  // computer's row reads the same (a fresh row's line already says it).
  const manualLine = connecting ? undefined : dashboardManualSyncLine(card, now);
  const detail = manualLine && !(ownDetail ?? '').startsWith(manualLine) ? manualLine : ownDetail;
  const unreadable = card.coverage.unreadable_items ?? 0;
  const manual = card.last_manual_sync;
  const lastSyncAt = isoOrUndefined(card.last_sync_at);
  const reconnect = wantsReconnect(card, status, actionKind, degraded, progress) ? reconnectFix(definition) : undefined;
  const late = status === 'Needs you' || status === 'Failing';
  const primary = connecting
    ? connecting.fix
    : status === 'Off'
      ? (actionKind === 'none' ? undefined : connectFix(definition))
      : scopePending(card) ? scopeFix(definition, card) : reconnect ?? (late ? sync : undefined);
  const menu: DashboardFix[] = [];
  // Sync now sits first in the ⋯ menu of every connected source that can
  // sync; on a late or unresponsive source it is the row's button instead
  // (owner, 2026-10-09), and the panel keeps the menu free of the row's fix.
  if (sync) menu.push(sync);
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
    ...(connecting ? { connecting: { expiresAt: connecting.expiresAt } } : {}),
    ...(progress ? { progress } : {}),
    ...(menu.length > 0 ? { menu } : {}),
    // The same count the row's words come from, with the newest files' names.
    ...(unreadable > 0 ? { unreadable: unreadableView(definition, card, unreadable) } : {}),
    ...(manual
      ? {
          lastManualSync: {
            at: manual.at,
            outcome: manual.outcome,
            ...(manual.new_items !== undefined ? { newItems: manual.new_items } : {}),
            ...(manual.outcome === 'failed' && isSourceFailureKind(manual.failure_kind) ? { failure: manual.failure_kind } : {}),
            ...(manual.outcome === 'failed' && manual.failure_kind === 'unknown' && sourceFailureRef(manual.failure_ref)
              ? { ref: manual.failure_ref! }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Why files can't be read, as data: a count per closed reason code. The engine
 * records one permanent failure, so one reason carries the whole count. Then
 * the newest files' names (never a path), and, when the count is more than
 * they show, "and N more": the computer's full list, through the same open
 * page every computer-only control uses (openHref).
 */
function unreadableView(definition: DashboardSupportedSourceDefinition, card: DashboardSourceCard, count: number): DashboardUnreadable {
  const names = unreadableNames(card.unreadable_files?.names).slice(0, Math.min(count, UNREADABLE_NAMES_IN_RESULT));
  const rest = count - names.length;
  const target = openUnreadableSourceFor(definition.source_id);
  return {
    count,
    reasons: [{ code: 'damaged_or_unsupported', count }],
    ...(card.answer_readiness.label === DASHBOARD_MANY_UNREADABLE_LABEL ? { many: true as const } : {}),
    ...(names.length > 0 ? { names } : {}),
    ...(rest > 0
      ? {
          more: helpLinkFix(
            dashboardUnreadableMoreLabel(rest),
            openPageUrl(target ? { kind: 'unreadable', source: target } : { kind: 'dashboard' }),
          ),
        }
      : {}),
  };
}


function attentionItem(
  definition: DashboardSupportedSourceDefinition,
  card: DashboardSourceCard,
  actionKind: DashboardSourceAction['kind'],
  degraded: WorkerCredentialDegradation[] | undefined,
  connecting: Connecting | undefined,
  progress: SourceProgress | undefined,
  sync?: DashboardFix,
): DashboardItem {
  if (connecting) {
    return { id: `source:${definition.source_id}`, sentence: `${definition.label} — ${CONNECTING_REASON}`, fix: connecting.fix };
  }
  const reason = dashboardAttentionLine(card, { surface: 'chatgpt', ...(degraded ? { degradedCredentials: degraded } : {}) });
  const sentence = reason ? `${definition.label} — ${reason}` : definition.label;
  // A late or unresponsive source's fix is Sync now where this worker can
  // sync it: Check again only re-read the page (owner, 2026-10-09).
  const fix = scopePending(card)
    ? scopeFix(definition, card) ?? checkAgainFix()
    : wantsReconnect(card, 'Needs you', actionKind, degraded, progress)
      ? reconnectFix(definition)
      : sync ?? checkAgainFix();
  return { id: `source:${definition.source_id}`, sentence, fix };
}

/**
 * Sync now for a connected source this worker can sync (the caller checks
 * `sync_now_available`), unless the row's own fix comes first: folders or
 * mail still to choose, or a sign-in to redo, which a sync cannot get past.
 */
function syncFix(
  definition: DashboardSupportedSourceDefinition,
  card: DashboardSourceCard,
  status: DashboardStatus,
  actionKind: DashboardSourceAction['kind'],
  degraded: WorkerCredentialDegradation[] | undefined,
  progress: SourceProgress | undefined,
): DashboardFix | undefined {
  if (!SYNC_SOURCE_IDS.has(definition.source_id) || !dashboardIsConnectedSource(card)) return undefined;
  if (scopePending(card) || wantsReconnect(card, status, actionKind, degraded, progress)) return undefined;
  return { label: CHATGPT_SETUP_LABELS.syncNow, tool: SYNC_SOURCE_TOOL_NAME, args: { source_id: definition.source_id as ChatGptSyncSourceId } };
}

/**
 * The owner has to sign this source in again. (The computer's own row once
 * read the same signal; since 2026-10-09 the panel is that row.) A credential problem or a stall on sign-in, or a
 * source that needs the owner while the engine's own card still carries a
 * connect action (sign-in, setup or key): that action is the repair. Read off
 * the unscrubbed card's action kind, which the scrubbed card drops
 * (review 2026-10-09, bug 2: ChatGPT offered Check again where the computer
 * offered Reconnect).
 */
function wantsReconnect(
  card: DashboardSourceCard,
  status: DashboardStatus,
  actionKind: DashboardSourceAction['kind'],
  degraded: WorkerCredentialDegradation[] | undefined,
  progress: SourceProgress | undefined,
): boolean {
  if (credentialProblem(card, degraded) || progress?.stalledReason === 'waiting_for_credentials') return true;
  const needsOwner = status === 'Needs you' || status === 'Failing';
  return needsOwner && (actionKind === 'oauth' || actionKind === 'api_key' || actionKind === 'needs_setup');
}

interface Connecting {
  expiresAt: string;
  fix: DashboardFix;
}

/**
 * The engine's pending sign-in for this source (`connection.state ===
 * 'awaiting_consent'` with an unexpired `connection.pending`), when ChatGPT
 * can start it again. Only the expiry time is read off the card.
 */
function connectingFor(
  definition: DashboardSupportedSourceDefinition,
  card: DashboardSourceCard,
  now: Date,
): Connecting | undefined {
  if (card.connection.state !== 'awaiting_consent') return undefined;
  const source = oauthSource(definition);
  const expiresAt = isoOrUndefined(card.connection.pending?.expires_at);
  if (!source || !expiresAt || Date.parse(expiresAt) <= now.getTime()) return undefined;
  return {
    expiresAt,
    fix: { label: DASHBOARD_CHATGPT_PICKER_COPY.connectReopen, tool: CONNECT_SOURCE_TOOL_NAME, args: { source } },
  };
}

/**
 * Reconnect: ChatGPT signs Gmail, Drive and Dropbox in again itself; any other
 * source (X, Readwise) is signed in again on the computer, so its Reconnect
 * opens the help page's steps for that.
 */
function reconnectFix(definition: DashboardSupportedSourceDefinition): DashboardFix {
  const source = oauthSource(definition);
  return source
    ? { label: DASHBOARD_CHATGPT_VOCABULARY.reconnect, tool: CONNECT_SOURCE_TOOL_NAME, args: { source } }
    : helpLinkFix(DASHBOARD_CHATGPT_VOCABULARY.reconnect, openOnComputer(definition, 'reconnect'));
}

/** A control that opens a help page section (`openHref`); the tool is only the contract's fallback. */
function helpLinkFix(label: string, href: string): DashboardFix {
  return { label, tool: DASHBOARD_TOOL_NAME, args: {}, href, openHref: true };
}

/**
 * The status word (dashboardHonestStatus), the credential predicate
 * (dashboardCredentialProblem) and the refused-first-connect test are shared
 * with the local pages (dashboard/shared-status.ts, holistic review 2026-10-02
 * item 9), so both surfaces read the same word for the same engine state.
 */
export { dashboardHonestStatus };

const STAGE_FOR_PHASE: Readonly<Record<DashboardPhase['id'], Exclude<SourceProgress['stage'], 'done'>>> = {
  metadata_sync: 'listing',
  extraction: 'reading',
  embedding: 'indexing',
};

/** Per-phase counts behind one source's progress, summed into the overall block. */
interface StageCounts {
  found: number;
  reading?: { done: number; total: number };
  indexing?: { done: number; total: number };
  /**
   * Items a question can find now, over the in-scope population: indexed
   * (embedded) items, or read items for a keyword-only source whose
   * embedding stage does not apply. Zero when the store publishes no
   * per-item embedding count: unknown is never claimed as searchable.
   */
  searchable?: { done: number; total: number };
}

interface MeasuredSourceProgress {
  progress: SourceProgress;
  counts: StageCounts;
}

/**
 * One source's progress from the engine's own three phase bars
 * (dashboard/phases.ts, the "In Olympus" rows): the first phase that is not
 * done names the stage. Only numbers and enums are read off the phases, never
 * their words. The population is the phases' own in-scope one, so items kept
 * as names only are finished once listed and never count as unread.
 */
function measuredSourceProgress(
  card: DashboardSourceCard,
  scrubbed: DashboardSourceCard,
  embedding: DashboardViewModelV1['models']['embedding'],
  signIn: boolean,
  now: Date,
): MeasuredSourceProgress {
  const unit = unitFor(scrubbed);
  // A source whose sign-in is the owner's to fix (wantsReconnect: the signal
  // the local dashboard's Reconnect reads) is waiting on that sign-in, and its
  // row says so (review 2026-10-09, bug 1: a signed-out Dropbox, which lost
  // its sign-in while holding data, was stalled with no reason, so its row had
  // no line at all).
  const credentialsMissing = signIn;
  const found = count(scrubbed.coverage.indexed_items);
  if (scopePending(scrubbed)) {
    return {
      progress: { stage: 'listing', unit, done: 0, total: 0, percent: 0, stalled: true, stalledReason: 'scope_pending' },
      counts: { found: 0 },
    };
  }
  let phases: DashboardPhase[];
  try {
    phases = dashboardSourceProgress(card, { now }).phases;
  } catch {
    phases = [];
  }
  const counts: StageCounts = { found };
  for (const phase of phases) {
    if (phase.measure.kind !== 'ratio' || phase.not_applicable) continue;
    const entry = { done: count(Math.min(phase.measure.done, phase.measure.total)), total: count(phase.measure.total) };
    if (phase.id === 'extraction') counts.reading = entry;
    if (phase.id === 'embedding') counts.indexing = entry;
  }
  const embeddingApplies = !phases.some((phase) => phase.id === 'embedding' && phase.not_applicable === true);
  if (counts.indexing) counts.searchable = counts.indexing;
  else if (counts.reading) counts.searchable = embeddingApplies ? { done: 0, total: counts.reading.total } : counts.reading;
  // An embedding row whose store publishes no per-item count is finished when
  // the chunk backlog says nothing is missing; otherwise it is still indexing.
  const embeddingBehind = (scrubbed.embedding_backlog?.missing_chunks ?? 0) > 0
    || scrubbed.embedding_backlog?.refresh_needed === true;
  const open = phases.find((phase) => phase.state !== 'done' && !(phase.unmeasured === true && !embeddingBehind));
  if (!open) {
    const summary = dashboardWorkingSummary(scrubbed);
    const total = summary?.in_scope_items ?? 0;
    const progress: SourceProgress = credentialsMissing
      ? { stage: 'done', unit, done: total, total, percent: 100, stalled: true, stalledReason: 'waiting_for_credentials' }
      : { stage: 'done', unit, done: total, total, percent: 100, stalled: false };
    return { progress, counts };
  }
  const stage = STAGE_FOR_PHASE[open.id];
  const measure = open.measure;
  let done = 0;
  let total = 0;
  let percent = 0;
  if (open.id === 'metadata_sync') {
    // Listing counts the source's own items found so far; a folder walk's
    // share, when the walk is sized, is the only percentage it has.
    done = found;
    if (measure.kind === 'ratio' && open.unit !== 'folders') total = measure.total;
    if (measure.kind === 'ratio' && measure.total > 0) percent = clampPercent((measure.done / measure.total) * 100);
  } else if (measure.kind === 'ratio') {
    done = count(measure.done);
    total = count(measure.total);
    percent = total > 0 ? clampPercent((done / total) * 100) : 0;
  } else if (measure.kind === 'indeterminate') {
    done = count(measure.done);
  } else {
    total = count(measure.remaining);
  }
  const reason = stalledReason({ stage, open, scrubbed, embedding, credentialsMissing });
  const stalled = reason !== undefined || open.state === 'stalled';
  const stall = stalled ? stallDetail(card, open, stage, reason, now) : undefined;
  return {
    progress: { stage, unit, done, total, percent, stalled, ...(reason ? { stalledReason: reason } : {}), ...(stall ? { stall } : {}) },
    counts,
  };
}

/**
 * What stopped a stalled source, for its See why (owner rule, 2026-10-10:
 * never say something is wrong without a way to find out exactly what it is).
 * Only closed words, counts and times leave: the failure's kind, never its
 * message; for a failure Olympus could not classify, the reference its log
 * line carries. None for a stall the row's own fix explains (sign-in,
 * folders) or the model download.
 */
function stallDetail(
  card: DashboardSourceCard,
  open: DashboardPhase,
  stage: Exclude<SourceProgress['stage'], 'done'>,
  reason: SourceStalledReason | undefined,
  now: Date,
): SourceStallDetail | undefined {
  if (reason !== undefined && reason !== 'provider_unavailable') return undefined;
  const schedule = card.schedule;
  const lastWorkedAt = isoOrUndefined(schedule?.last_success_at);
  const nextRun = isoOrUndefined(schedule?.next_run_at);
  const nextTryAt = nextRun && Date.parse(nextRun) > now.getTime() ? nextRun : undefined;
  const timing = { ...(lastWorkedAt ? { lastWorkedAt } : {}), ...(nextTryAt ? { nextTryAt } : {}) };
  if (dashboardOperatorPaused(card)) {
    return { cause: 'paused', failure: sourceFailureKind(undefined, schedule?.degraded_reason), ...timing };
  }
  const failures = count(schedule?.consecutive_failures ?? 0);
  if (reason === 'provider_unavailable' || failures > 0) {
    const failure = sourceFailureKind(schedule?.last_error_kind, schedule?.degraded_reason);
    const ref = failure === 'unknown' ? sourceFailureRef(schedule?.last_error_hash) : undefined;
    return { cause: 'failing', failure, ...(failures > 0 ? { failures } : {}), ...timing, ...(ref ? { ref } : {}) };
  }
  const drain = card.ingestion_health?.drain_state;
  if ((open.id === 'embedding' && card.embedding_lane_state === 'embedding_lane_disabled')
    || (open.id === 'extraction' && (drain === 'held' || drain === 'disabled'))) {
    return { cause: 'switched_off', stage };
  }
  const movedAt = isoOrUndefined(open.id === 'metadata_sync'
    ? card.movement?.metadata_sync_at
    : open.id === 'extraction' ? card.movement?.extraction_at : card.movement?.embedding_at);
  const stillSeconds = movedAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(movedAt)) / 1000)) : undefined;
  return {
    cause: 'no_movement',
    stage,
    ...(stillSeconds !== undefined ? { stillSeconds } : {}),
    ...(movedAt ? { lastWorkedAt: movedAt } : lastWorkedAt ? { lastWorkedAt } : {}),
  };
}

function stalledReason(input: {
  stage: Exclude<SourceProgress['stage'], 'done'>;
  open: DashboardPhase;
  scrubbed: DashboardSourceCard;
  embedding: DashboardViewModelV1['models']['embedding'];
  credentialsMissing: boolean;
}): SourceStalledReason | undefined {
  if (input.credentialsMissing) return 'waiting_for_credentials';
  if (input.stage === 'indexing' && (input.embedding.state === 'downloading' || input.embedding.state === 'verifying')) {
    return 'model_downloading';
  }
  if (input.open.state !== 'stalled') return undefined;
  const failures = input.scrubbed.schedule?.consecutive_failures ?? 0;
  if (failures > 0 || dashboardSyncKeepsFailing(input.scrubbed)) return 'provider_unavailable';
  return undefined;
}

/** The fix only re-reads the dashboard: nothing for the owner to do. */
function checksAgainOnly(fix: DashboardFix | undefined): boolean {
  return fix?.tool === DASHBOARD_TOOL_NAME && fix.openHref !== true;
}

function checkAgainFix(href?: string): DashboardFix {
  return { label: DASHBOARD_CHATGPT_VOCABULARY.checkAgain, tool: DASHBOARD_TOOL_NAME, args: {}, ...(href ? { href } : {}) };
}

/**
 * The help page naming a repair that only the computer can make (a key, a
 * pairing, a model server). Moved from /help/on-your-mac/ on 2026-10-09; the
 * old address redirects. Since option C (2026-10-09) a Fix carries the
 * /open/ page instead (openOnComputer below), which links here as the
 * fallback reference.
 */
export const ON_COMPUTER_HELP_URL = 'https://olympusplugin.ai/help/on-your-computer/';

/**
 * The olympusplugin.ai/open/ page that opens Olympus on the computer through
 * its olympus:// link, at that source's Connect panel or that fix's section
 * (core/open-targets.ts); the page itself falls back to the two steps by hand
 * and links the help page (owner decision, 2026-10-09: no Terminal step).
 */
function openOnComputer(definition: DashboardSupportedSourceDefinition | undefined, section: OpenFixSection): string {
  const source = definition
    ? (Object.keys(OPEN_CONNECT_SOURCES) as OpenConnectSource[]).find((key) => OPEN_CONNECT_SOURCES[key].sourceId === definition.source_id)
    : undefined;
  return source ? openPageUrl({ kind: 'connect', source }) : openPageUrl({ kind: 'fix', section });
}

/**
 * A disk-full failure says how much to free, then points at the item's own
 * Try again; it carries no help link (there is nothing to look up).
 */
function withDiskFreeUp(sentence: string, reason: ModelInstallFailedReason | undefined, bytes: number | undefined): string {
  if (reason !== 'disk_full') return sentence;
  const next = bytes !== undefined && bytes > 0
    ? DASHBOARD_CHATGPT_VOCABULARY.diskFreeUp.replace('{size}', formatSpaceToFree(bytes))
    : DASHBOARD_CHATGPT_VOCABULARY.diskFreeUpUnknown;
  return `${sentence} ${next}`;
}

/** Starts a failed built-in install again. */
function retryFix(model: 'embedding' | 'answers'): DashboardFix {
  return { label: DASHBOARD_CHATGPT_PICKER_COPY.tryAgain, tool: MODEL_RETRY_TOOL_NAME, args: { model } };
}

/**
 * The built-in transcription model's line in Models, when it is this
 * machine's transcriber. Download now while it is not needed yet (no audio
 * chosen: the owner may add some), not downloaded, stopped part way or
 * failed; Try again when it downloaded but would not start. Moved here from
 * the local dashboard's own row on 2026-10-09, when the panel became the one
 * dashboard.
 */
function transcriptionModel(state: BuiltInTranscriptionDashboardState | undefined): TranscriptionModelView | undefined {
  if (!state) return undefined;
  const out: TranscriptionModelView = { state: state.state };
  if (state.state === 'downloading' || state.state === 'verifying') {
    if (Number.isFinite(state.percent)) out.percent = clampPercent(state.percent!);
    if (Number.isFinite(state.bytesTotal) && (state.bytesTotal ?? 0) > 0 && Number.isFinite(state.bytesDone)) {
      out.bytesTotal = Math.floor(state.bytesTotal!);
      out.bytesDone = Math.min(Math.max(0, Math.floor(state.bytesDone!)), out.bytesTotal);
    }
  }
  if (state.state === 'failed') out.failedReason = state.failedReason ?? 'unknown';
  if (state.state === 'load_failed') out.loadFailedReason = state.loadFailedReason ?? 'unknown';
  const label = state.state === 'load_failed'
    ? DASHBOARD_CHATGPT_PICKER_COPY.tryAgain
    : TRANSCRIPTION_DOWNLOADABLE.has(state.state) ? DASHBOARD_CHATGPT_PAGE_COPY.modelDownloadNow : undefined;
  if (label) out.download = { label, tool: MODEL_RETRY_TOOL_NAME, args: { model: 'transcription' } };
  return out;
}

const TRANSCRIPTION_DOWNLOADABLE: ReadonlySet<TranscriptionModelView['state']> = new Set(['not_needed', 'not_downloaded', 'interrupted', 'failed']);

/** The publisher-app OAuth source for a definition, when ChatGPT can connect it. */
function oauthSource(definition: DashboardSupportedSourceDefinition): ChatGptOAuthSource | undefined {
  const action = definition.connect_action;
  return action.kind === 'oauth' && CHATGPT_OAUTH_SOURCES.has(action.source) ? action.source as ChatGptOAuthSource : undefined;
}

/**
 * Connect from ChatGPT: Gmail, Drive and Dropbox through Olympus's own apps.
 * X (bring-your-own app), Readwise (API key) and paired chats are set up on
 * the computer for now: their Connect opens the help page's steps for that.
 */
function connectFix(definition: DashboardSupportedSourceDefinition): DashboardFix {
  const source = oauthSource(definition);
  return source
    ? { label: CHATGPT_SETUP_LABELS.connect, tool: CONNECT_SOURCE_TOOL_NAME, args: { source } }
    : helpLinkFix(CHATGPT_SETUP_LABELS.connect, openOnComputer(definition, 'connect'));
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
  privateModel?: BuiltInPrivateModelView | undefined;
}): DashboardViewModelV1['connection'] {
  // `installing` disables every control on the page, so it covers only the
  // built-in model download. With no source yet, or a first index running,
  // Olympus is set up and the owner's next step is a control on the page:
  // Connect, or choosing folders.
  // The built-in private model downloading alone never does: it joins the
  // percent only while the embedding model is downloading too, so the bar
  // reaches 100 when both are done.
  if (input.embedding.state === 'downloading' || input.embedding.state === 'verifying') {
    const state: ConnectionState = 'installing';
    let percent = clampPercent(input.embedding.percent ?? 0);
    if (input.privateModel && PRIVATE_MODEL_INSTALLING.has(input.privateModel.state)) {
      percent = Math.min(percent, clampPercent(input.privateModel.percent ?? 0));
    }
    return {
      state,
      progress: { percent, label: DASHBOARD_CHATGPT_VOCABULARY.installingModel },
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

const PRIVATE_MODEL_INSTALLING = new Set<BuiltInPrivateModelView['state']>(['downloading', 'verifying']);

function builtInAnswers(model: BuiltInPrivateModelView | undefined): DashboardViewModelV1['models']['answers'] {
  if (!model) return undefined;
  const ready = model.state === 'ready' || model.state === 'loading';
  return {
    kind: 'built_in',
    label: ANSWER_MODEL_LABELS.built_in,
    ready,
    ...(ready ? {} : { install: builtInInstall(model) }),
  };
}

/**
 * The install line for a built-in model that is not ready. Not started yet
 * reads as a download at 0%: the install starts at boot or on the first
 * Private question, never on the owner's say-so.
 */
function builtInInstall(model: BuiltInPrivateModelView): ModelInstall {
  if (model.state === 'failed') return { state: 'failed', failedReason: model.failedReason ?? 'unknown' };
  const state = model.state === 'verifying' ? 'verifying' as const : 'downloading' as const;
  const bytes = Number.isFinite(model.bytesTotal) && (model.bytesTotal ?? 0) > 0
    ? { bytesDone: Math.max(0, Math.floor(model.bytesDone ?? 0)), bytesTotal: Math.floor(model.bytesTotal!) }
    : {};
  return { state, percent: clampPercent(model.state === 'not_started' ? 0 : model.percent ?? 0), ...bytes };
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
 * One progress block over every connected source that is not done. Each
 * stage's row sums that stage's counts across those sources (listing: items
 * found so far, no total until a first listing finishes). The headline
 * percentage and items left count what is searchable (indexed, or read for a
 * keyword-only source) when anything has a known in-scope total, else the
 * sum of the sources' own stage counts: read but not yet indexed is not done.
 * Absent once every source is done.
 */
function overallProgress(
  rows: ReadonlyArray<{ card: DashboardSourceCard; progress?: SourceProgress | undefined; counts?: StageCounts | undefined }>,
): DashboardViewModelV1['progress'] | undefined {
  const open = rows.filter((row): row is { card: DashboardSourceCard; progress: SourceProgress; counts: StageCounts } =>
    row.progress !== undefined && row.counts !== undefined && row.progress.stage !== 'done');
  if (open.length === 0) return undefined;
  let eta: number | undefined;
  let initial = false;
  const units = new Set(open.map((row) => row.progress.unit));
  const unit: Unit = units.size === 1 ? [...units][0]! : 'items';
  const listing = { done: 0, any: false };
  const reading = { done: 0, total: 0, any: false };
  const indexing = { done: 0, total: 0, any: false };
  const searchable = { done: 0, total: 0 };
  let ownDone = 0;
  let ownTotal = 0;
  for (const { card, progress, counts } of open) {
    if (progress.stage === 'listing') {
      listing.any = true;
      listing.done += counts.found;
    }
    if (counts.reading) {
      reading.any = true;
      reading.done += counts.reading.done;
      reading.total += counts.reading.total;
    }
    if (counts.indexing) {
      indexing.any = true;
      indexing.done += counts.indexing.done;
      indexing.total += counts.indexing.total;
    }
    if (counts.searchable) {
      searchable.done += Math.min(counts.searchable.done, counts.searchable.total);
      searchable.total += counts.searchable.total;
    }
    ownTotal += progress.total;
    ownDone += progress.total > 0 ? Math.min(progress.done, progress.total) : 0;
    if (card.freshness.label === DASHBOARD_FIRST_SYNC_FRESHNESS_LABEL || progress.stage === 'listing') initial = true;
    const minutes = card.progress?.eta_minutes;
    if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
      eta = Math.max(eta ?? 0, Math.round(minutes * 60));
    }
  }
  const details: NonNullable<DashboardViewModelV1['progress']>['details'] = [];
  if (listing.any) details.push({ stage: STAGE_DETAIL.listing, unit, done: listing.done, total: 0 });
  if (reading.any) details.push({ stage: STAGE_DETAIL.reading, unit, done: reading.done, total: reading.total });
  if (indexing.any) details.push({ stage: STAGE_DETAIL.indexing, unit, done: indexing.done, total: indexing.total });
  const [done, total] = searchable.total > 0 ? [searchable.done, searchable.total] : [ownDone, ownTotal];
  return {
    unit,
    phase: initial ? 'initial' : 'refresh',
    percent: total > 0 ? clampPercent((Math.min(done, total) / total) * 100) : 0,
    itemsLeft: Math.max(0, total - done),
    ...(eta !== undefined ? { etaSeconds: eta } : {}),
    stalled: open.some((row) => row.progress.stalled),
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
  const refusal = card.connection.provider_refusal;
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
      ...(finite(card.coverage.unreadable_items)
        ? { unreadable_items: count(card.coverage.unreadable_items) }
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
      // The refusal's presence and, from a closed set, the code vocabulary.ts
      // words differently. The reason (which names a callback address and a
      // provider setting) stays on the Mac.
      ...(refusal
        ? { provider_refusal: { code: KNOWN_REFUSAL_CODES.has(refusal.code) ? refusal.code : '', reason: '' } }
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
    // The one string copied off the input (owner ruling, 2026-10-10): the
    // newest unreadable files' names, cut to display text. Never a path.
    ...(card.unreadable_files
      ? { unreadable_files: { names: unreadableNames(card.unreadable_files.names).slice(0, UNREADABLE_NAMES_IN_RESULT), corpus_ids: [] } }
      : {}),
    ...(card.last_manual_sync && isoOrUndefined(card.last_manual_sync.at)
      && MANUAL_SYNC_OUTCOMES.has(card.last_manual_sync.outcome)
      ? {
          last_manual_sync: {
            at: isoOrUndefined(card.last_manual_sync.at)!,
            outcome: card.last_manual_sync.outcome,
            ...(finite(card.last_manual_sync.new_items) ? { new_items: count(card.last_manual_sync.new_items) } : {}),
            ...(isSourceFailureKind(card.last_manual_sync.failure_kind) ? { failure_kind: card.last_manual_sync.failure_kind } : {}),
            ...(sourceFailureRef(card.last_manual_sync.failure_ref) ? { failure_ref: card.last_manual_sync.failure_ref! } : {}),
          },
        }
      : {}),
  };
}

const MANUAL_SYNC_OUTCOMES: ReadonlySet<string> = new Set(['checking', 'checked', 'failed', 'busy']);

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
