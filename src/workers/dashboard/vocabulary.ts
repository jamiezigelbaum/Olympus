/**
 * The page's whole user-visible status language, and the grammar of the one
 * line under each source name.
 *
 * Closed vocabulary on purpose: six words, exact strings, nothing else reaches
 * a reader. Every function here is pure and reads only fields that exist on the
 * real view model, so a status can never be asserted from a value the worker
 * does not actually produce.
 */
import type {
  DashboardAnswerLaneCard,
  DashboardCaptureSupervisorReason,
  DashboardConnectionState,
  DashboardImportAttention,
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../source-dashboard.ts';
import type { DashboardLivePassErrorKind, DashboardSyncName } from '../source-dashboard.ts';
import { DASHBOARD_FIRST_SYNC_FRESHNESS_LABEL, DASHBOARD_UNSETTLED_CUSTODY_LABELS } from '../source-dashboard.ts';
import { ARCHIVE_FORMATS } from '../../core/archive-formats.ts';
import type { WorkerCredentialDegradation } from '../credential-degradation.ts';
import { answerReadyEligibleItems, clampPercent } from './answer-ready-coverage.ts';
import { displayText } from './display-text.ts';
import { OPERATOR_PAUSED_SCHEDULER_MARKERS } from './scheduler-markers.ts';
import type { ModelLoadFailedReason, SourceFailureKind } from '../chatgpt/dashboard-contract.ts';

export const DASHBOARD_UPDATE_COPY = {
  notice: (version: string) => `Olympus ${version} is available. To update, run this in Terminal:`,
  copy: 'Copy command',
  copied: 'Copied',
  copyFailed: 'Select the command and copy it.',
};

export const DASHBOARD_MISSING_FOLDER = 'A folder you chose is missing';
export const DASHBOARD_FOLDER_NEEDS_PERMISSION = 'Your Mac will not let Olympus open a folder you chose. In System Settings, choose Privacy & Security, then Files & Folders, and switch on Olympus Engine (or the app your Mac named when it asked).';
export const DASHBOARD_FOLDER_NEEDS_HELPER = 'A folder you chose is in Desktop, Documents, Downloads, iCloud Drive or another disk, which Olympus cannot open on this Mac yet. That needs the Olympus helper app, which comes in a later update. Choose a folder outside them, or drag files onto the dashboard.';
export const DASHBOARD_FOLDER_UNREADABLE = 'Your user account is not allowed to open a folder you chose. Change who may open that folder, or choose another one.';

export type DashboardStatus = 'Fresh' | 'Working' | 'Waiting' | 'Needs you' | 'Failing' | 'Off';

/** Section order on the home page: attention first, dormant last. */
export const DASHBOARD_STATUS_ORDER: readonly DashboardStatus[] = [
  'Needs you',
  'Failing',
  'Working',
  'Waiting',
  'Fresh',
  'Off',
];

/** Which theme token colors a status word. Keys of DASHBOARD_THEME_TOKENS. */
export type DashboardStatusColorToken = 'good' | 'run' | 'off' | 'warn' | 'bad' | 'line';

/** Which of the three glyph shapes a status word draws. */
export type DashboardGlyphKind = 'dot' | 'donut' | 'ring';

export interface DashboardStatusPresentation {
  /** The exact word a reader sees. Same string as the key. */
  label: DashboardStatus;
  colorToken: DashboardStatusColorToken;
  glyphKind: DashboardGlyphKind;
}

/**
 * The one place a status word turns into pixels. Only Working draws the donut,
 * because only Working has a fraction worth asserting; Waiting draws the empty
 * double ring, which claims no progress at all.
 */
export const DASHBOARD_STATUS_PRESENTATION: Readonly<Record<DashboardStatus, DashboardStatusPresentation>> = {
  'Fresh': { label: 'Fresh', colorToken: 'good', glyphKind: 'dot' },
  'Working': { label: 'Working', colorToken: 'run', glyphKind: 'donut' },
  'Waiting': { label: 'Waiting', colorToken: 'off', glyphKind: 'ring' },
  'Needs you': { label: 'Needs you', colorToken: 'warn', glyphKind: 'dot' },
  'Failing': { label: 'Failing', colorToken: 'bad', glyphKind: 'dot' },
  'Off': { label: 'Off', colorToken: 'line', glyphKind: 'dot' },
};

type DashboardAnswerReadinessState = DashboardSourceCard['answer_readiness']['state'];

/**
 * queue_health.label is typed `string` on the view model but the worker only
 * ever writes these four; naming them here is what makes the mapping total and
 * what makes a fifth one show up as a counted unknown instead of silently
 * reading as Fresh.
 */
export type DashboardQueueHealthLabel =
  | 'Needs attention'
  | 'Working now'
  | 'Waiting to catch up'
  | 'Caught up';

type DashboardAnswerLaneState = DashboardAnswerLaneCard['connection']['state'];

/**
 * A source that was never connected reads Off, not Needs you: the calm page
 * does not nag about a source the owner never asked for. Needs you is reserved
 * for a source that is waiting on the owner right now — a consent tab still
 * open, or a credential that has expired under them.
 */
export const DASHBOARD_CONNECTION_STATE_STATUS: Readonly<Record<DashboardConnectionState, DashboardStatus>> = {
  not_connected: 'Off',
  needs_setup: 'Off',
  awaiting_consent: 'Needs you',
  reauth_required: 'Needs you',
  connected: 'Fresh',
  waiting_for_first_sync: 'Waiting',
  syncing: 'Working',
  synced: 'Fresh',
};

// needs_attention no longer maps to 'Failing' (owner-driven, 2026-08-24):
// with the attention-banner system, every needs-attention state renders a
// banner that says exactly what is wrong and what to do — including cases the
// banner itself calls fine ("your folder choices are fine, 194 files are
// unreadable"). A one-word 'Failing' in the header over that banner is a
// contradiction, and it was the exact "failing checks that do not help"
// complaint that started the redesign. 'Needs you' is what the state actually
// means: items are waiting on the owner. 'Failing' stays in the vocabulary
// union for schema stability but nothing maps to it today.
export const DASHBOARD_ANSWER_READINESS_STATUS: Readonly<Record<DashboardAnswerReadinessState, DashboardStatus>> = {
  ready: 'Fresh',
  syncing: 'Working',
  needs_attention: 'Needs you',
  empty: 'Waiting',
  disconnected: 'Off',
};

export const DASHBOARD_QUEUE_HEALTH_STATUS: Readonly<Record<DashboardQueueHealthLabel, DashboardStatus>> = {
  'Needs attention': 'Needs you',
  'Working now': 'Working',
  'Waiting to catch up': 'Waiting',
  'Caught up': 'Fresh',
};

export const DASHBOARD_ANSWER_LANE_STATUS: Readonly<Record<DashboardAnswerLaneState, DashboardStatus>> = {
  validated: 'Fresh',
  missing: 'Off',
};

/**
 * What an unrecognized enum value reads as. Waiting is the only word that
 * asserts nothing about the source; every other word would be a claim made
 * from a value this module has never seen.
 */
export const DASHBOARD_UNKNOWN_STATUS: DashboardStatus = 'Waiting';

export interface DashboardStatusInput {
  source: DashboardSourceCard;
  /** Worker-level credential failures, matched to a card by display name. */
  degradedCredentials?: readonly WorkerCredentialDegradation[];
}

export interface DashboardStatusGroup {
  status: DashboardStatus;
  sources: DashboardSourceCard[];
}

export interface DashboardVocabularyOptions {
  now?: Date;
  degradedCredentials?: readonly WorkerCredentialDegradation[];
  /**
   * Which dashboard the words are for. The ChatGPT dashboard has no How to fix
   * sheet and its owner signs in through Olympus's own apps, so a provider
   * refusal there reads DASHBOARD_CHATGPT_REFUSAL_COPY. Defaults to the local
   * dashboard.
   */
  surface?: 'local' | 'chatgpt';
}

export interface DashboardStatusResolution {
  status: DashboardStatus;
  /** True when a value outside the known enums forced the Waiting fallback. */
  mappedUnknown: boolean;
  /** The unrecognized raw value, for the page's own counter. Never rendered. */
  unknownValue?: string;
}

/**
 * The status word for a card, with the unknown marker still attached.
 *
 * Order is precedence, not preference: a credential the owner must fix outranks
 * everything, a source that was never connected is never called broken, and a
 * failure only reads as Failing once the connection itself is fine.
 */
export function dashboardStatusResolution(input: DashboardStatusInput): DashboardStatusResolution {
  const source = input.source;
  const unknownValue = firstUnknownEnumValue(source);
  // The presence of a degradation record is the signal, not its state word:
  // retrying, stopped and resolved_restart_required all end with the owner
  // doing something. It outranks the unknown fallback too — an expired
  // credential still needs them whatever else on the card has drifted — so the
  // marker rides along rather than swallowing the word.
  if (dashboardDegradationForSource(source, input.degradedCredentials)) {
    return {
      status: 'Needs you',
      mappedUnknown: unknownValue !== undefined,
      ...(unknownValue !== undefined ? { unknownValue } : {}),
    };
  }
  // A provider that refused the last consent attempt is the owner's homework
  // whatever the registry currently says, and outranks the unknown fallback for
  // the same reason a degraded credential does: the refusal is a fresh, exact
  // fact about a thing they just tried to do. Without this a refused first
  // connect read 'Off' and left home entirely (owner, 2026-09-03).
  if (source.connection.provider_refusal) {
    return {
      status: 'Needs you',
      mappedUnknown: unknownValue !== undefined,
      ...(unknownValue !== undefined ? { unknownValue } : {}),
    };
  }
  if (unknownValue !== undefined) return unknownStatus(unknownValue);
  // An import that stopped, a request waiting for an answer, imported items
  // no private model can judge now, or a record that cannot be read: each is
  // the person's to answer, whatever the imports' progress says (owner rule,
  // 2026-10-10: nothing wrong without a route to exactly what).
  if ((source.connection.imports_attention?.length ?? 0) > 0) return { status: 'Needs you', mappedUnknown: false };
  // Its files were being moved into their folder and that did not finish or did
  // not hold: the owner's, whatever the connection says, and the source may be
  // disconnected with its data kept.
  if (source.storage_notice) return { status: 'Needs you', mappedUnknown: false };

  const connectionStatus = DASHBOARD_CONNECTION_STATE_STATUS[source.connection.state];
  const readinessStatus = DASHBOARD_ANSWER_READINESS_STATUS[source.answer_readiness.state];
  const queueStatus = DASHBOARD_QUEUE_HEALTH_STATUS[source.queue_health.label as DashboardQueueHealthLabel];
  if (connectionStatus === 'Needs you' || connectionStatus === 'Off') {
    // A card that reads never-connected while its corpus still holds indexed
    // items has no grant at all (no handle, no this-computer record): the
    // owner disconnected it and its data was kept (owner ruling, 2026-10-23).
    // It stays Off, worded "Disconnected · indexed data kept"; a grant that
    // is still present but expired or revoked reads reauth_required (Needs
    // you), a degradation or a provider refusal, all decided above. Custody
    // that is not settled (registry or unpair record unreadable, an unpair
    // that left files) keeps its warning: Needs you, with its own label.
    if (connectionStatus === 'Off' && dashboardUnsettledWithData(source)) {
      return { status: 'Needs you', mappedUnknown: false };
    }
    return { status: connectionStatus, mappedUnknown: false };
  }
  if (readinessStatus === 'Needs you' || queueStatus === 'Needs you') {
    return { status: 'Needs you', mappedUnknown: false };
  }
  // A live feed that has gone quiet or whose helper is not running is the
  // owner's whatever the readiness label says: another problem's label must
  // not be what decides whether this one is seen.
  if (dashboardCaptureProblem(source) !== undefined) return { status: 'Needs you', mappedUnknown: false };
  // The computer's disk is nearly full: new media waits to download until the owner frees space.
  if (source.media_storage) return { status: 'Needs you', mappedUnknown: false };
  // A folder source that is connected but has no approved scope has read
  // nothing and will read nothing until the owner chooses folders. Its
  // connection state is `connected`, which alone reads Fresh — a green dot and
  // "synced just now" over an empty corpus (first-install test, 2026-09-23).
  // It is waiting, exactly as a source before its first sync is; the Choose
  // folders banner carries the ask.
  if (dashboardScopePending(source)) return { status: 'Waiting', mappedUnknown: false };
  // A pairing that has not captured its first message is waiting, whatever
  // older messages the index still holds from before it.
  if (connectionStatus === 'Fresh' && source.freshness.capture?.state === 'awaiting') {
    return { status: 'Waiting', mappedUnknown: false };
  }
  return { status: connectionStatus, mappedUnknown: false };
}

/**
 * True when a connected source that requires an explicit folder scope has not
 * had one approved yet. Generic over every source that declares
 * `scope_selection`, never a named provider.
 */
export function dashboardScopePending(source: DashboardSourceCard): boolean {
  return source.scope_selection?.connected === true && source.scope_selection.status === 'scope_pending';
}

/** The first value on the card that no mapping table knows about. */
function firstUnknownEnumValue(source: DashboardSourceCard): string | undefined {
  if (DASHBOARD_CONNECTION_STATE_STATUS[source.connection.state] === undefined) return source.connection.state;
  if (DASHBOARD_ANSWER_READINESS_STATUS[source.answer_readiness.state] === undefined) {
    return source.answer_readiness.state;
  }
  if (DASHBOARD_QUEUE_HEALTH_STATUS[source.queue_health.label as DashboardQueueHealthLabel] === undefined) {
    return source.queue_health.label;
  }
  return undefined;
}

/** The one status word for a card. Never returns anything outside the six. */
export function dashboardStatus(input: DashboardStatusInput): DashboardStatus {
  return dashboardStatusResolution(input).status;
}

/**
 * The two connection states that mean the owner has never connected this
 * source. Both are the same fact — nothing is connected — differing only in
 * whether an app key would also be needed first, which is a setup-page detail.
 */
const DASHBOARD_UNCONNECTED_STATES: ReadonlySet<DashboardConnectionState> = new Set<DashboardConnectionState>([
  'not_connected',
  'needs_setup',
]);

/**
 * True when the owner has connected this source at all.
 *
 * VERIFIED against DASHBOARD_CONNECTION_STATE_STATUS: these are exactly the
 * two states that read Off, and there is no third — no connection state means
 * "configured, then paused". So on the home page, Off and never-connected are
 * the same set, and home drops it entirely (owner ruling, 2026-08-18) rather
 * than keeping a group for a state that cannot occur. If a paused state is
 * ever added, it belongs here as connected and needs its own home group.
 *
 * One evidence-based exception: indexed data proves a past connection. A
 * revoked or deleted handle can drop connection.state back to a
 * never-connected value while the corpus still holds items; that source is
 * connected-but-broken — the set the owner ruled onto home — not an untouched
 * option, so it stays on home (in Needs you, via dashboardStatusResolution)
 * instead of vanishing from every navigable surface.
 */
export function dashboardIsConnectedSource(source: DashboardSourceCard): boolean {
  if (!DASHBOARD_UNCONNECTED_STATES.has(source.connection.state)) return true;
  // A provider refusal is the second piece of evidence that this source is not
  // an untouched option: the owner pressed Connect and something said no. That
  // is exactly the report home exists to carry, and dropping the card because
  // the attempt never produced a handle would hide the failure on the page the
  // owner is looking at.
  return source.connection.provider_refusal !== undefined || dashboardUnsettledWithData(source);
}

/** Cards bucketed by status, in DASHBOARD_STATUS_ORDER, empty groups dropped. */
export function dashboardStatusGroups(
  view: SourceDashboardViewModel,
  options?: DashboardVocabularyOptions,
): DashboardStatusGroup[] {
  return groupSourcesByStatus(view.sources, resolveDegraded(view, options));
}

/**
 * The same grouping over connected sources only — what home renders.
 *
 * A source the owner never connected is not news about their system, so it
 * appears on the setup page and nowhere else.
 */
export function dashboardConnectedStatusGroups(
  view: SourceDashboardViewModel,
  options?: DashboardVocabularyOptions,
): DashboardStatusGroup[] {
  return groupSourcesByStatus(
    view.sources.filter((source) => dashboardIsConnectedSource(source)),
    resolveDegraded(view, options),
  );
}

function groupSourcesByStatus(
  sources: readonly DashboardSourceCard[],
  degradedCredentials: readonly WorkerCredentialDegradation[] | undefined,
): DashboardStatusGroup[] {
  const buckets = new Map<DashboardStatus, DashboardSourceCard[]>();
  for (const source of sources) {
    const status = dashboardStatus({ source, ...degradedInput(degradedCredentials) });
    const bucket = buckets.get(status);
    if (bucket) bucket.push(source);
    else buckets.set(status, [source]);
  }
  return DASHBOARD_STATUS_ORDER
    .map((status) => ({ status, sources: buckets.get(status) ?? [] }))
    .filter((group) => group.sources.length > 0);
}

/**
 * How many cards had to fall back to Waiting because the worker produced an
 * enum value this module does not know. Zero on every shipped view; anything
 * else means the vocabulary is behind the worker.
 */
export function dashboardMappedUnknownCount(
  view: SourceDashboardViewModel,
  options?: DashboardVocabularyOptions,
): number {
  const degradedCredentials = resolveDegraded(view, options);
  return view.sources
    .filter((source) => dashboardStatusResolution({ source, ...degradedInput(degradedCredentials) }).mappedUnknown)
    .length;
}

/** The status word for an answer lane, which has no sync of its own. */
export function dashboardAnswerLaneStatus(lane: DashboardAnswerLaneCard): DashboardStatus {
  return DASHBOARD_ANSWER_LANE_STATUS[lane.connection.state] ?? DASHBOARD_UNKNOWN_STATUS;
}

/**
 * The card's second line — what this source is doing, in its own grammar.
 * Returns an empty string when no backing field says anything true.
 */
export function dashboardSubLine(
  source: DashboardSourceCard,
  options?: DashboardVocabularyOptions,
): string {
  const status = dashboardStatus({ source, ...degradedInput(options?.degradedCredentials) });
  switch (status) {
    case 'Needs you':
    case 'Failing':
      return dashboardAttentionLine(source, options);
    case 'Working':
      // A card with no corpus of its own whose connection is its imports (an import-only source) says what they do.
      return source.connection.action.kind === 'archive_import' && source.coverage.indexed_items === 0 && source.connection.label
        ? source.connection.label
        : workingLine(source);
    case 'Waiting':
      return waitingLine(source);
    case 'Fresh':
      return freshLine(source, options?.now ?? new Date());
    case 'Off':
      // Not connected with indexed data left: disconnected on purpose, data
      // kept (owner ruling, 2026-10-23), not a lost sign-in. A card whose
      // connection is its imports has no account to disconnect: its line is its imports'.
      return source.coverage.indexed_items > 0 && dashboardIsUnconnectedState(source)
        && source.connection.action.kind !== 'archive_import'
        && !dashboardUnsettledWithData(source)
        ? DASHBOARD_DISCONNECTED_DATA_KEPT
        : source.connection.label;
  }
}

function dashboardIsUnconnectedState(source: DashboardSourceCard): boolean {
  return DASHBOARD_UNCONNECTED_STATES.has(source.connection.state);
}

/** Unconnected with indexed data, but custody is not settled (see DASHBOARD_UNSETTLED_CUSTODY_LABELS). */
export function dashboardUnsettledWithData(source: DashboardSourceCard): boolean {
  return source.coverage.indexed_items > 0
    && dashboardIsUnconnectedState(source)
    && DASHBOARD_UNSETTLED_CUSTODY_LABELS.has(source.connection.label);
}

/**
 * The reason half of a Needs you / Failing row ("— reauth required"). Empty
 * when the view model carries no reason, so the row states the source and
 * stops rather than inventing a cause.
 */
export function dashboardAttentionLine(
  source: DashboardSourceCard,
  options?: DashboardVocabularyOptions,
): string {
  const { reason, capture, media } = dashboardAttentionParts(source, options);
  return [reason, capture, media].filter((part): part is string => !!part).join(' · ');
}

/**
 * The attention line in its independent parts: `reason`, the source's
 * own problem (empty when it has none besides capture), `capture`, the
 * live feed's problem when there is one, and `media`, when the media it keeps
 * has filled its storage. A row states both in its one line;
 * the Needs you list gives each its own item and its own route, because the
 * route for a late refresh (Sync now) is not the route for a feed that stopped
 * (open the source on the computer). Neither hides the other.
 */
export function dashboardAttentionParts(
  source: DashboardSourceCard,
  options?: DashboardVocabularyOptions,
): { reason: string; capture?: string; media?: string } {
  const capture = dashboardCaptureAttentionReason(source);
  // Kept media that filled its storage: a third half, beside whatever else the source has.
  const media = source.media_storage ? DASHBOARD_MEDIA_STORAGE_COPY.reason : undefined;
  const withCapture = (reason: string): { reason: string; capture?: string; media?: string } => ({
    reason,
    ...(capture ? { capture } : {}),
    ...(media ? { media } : {}),
  });
  const degradation = dashboardDegradationForSource(source, options?.degradedCredentials);
  if (degradation) {
    const clause = degradationClause(degradation);
    return withCapture(clause ? `can't sign in · ${clause}` : `can't sign in`);
  }
  // The provider's refusal, translated. It replaces every connection-state
  // line below, because "not connected" over an attempt the provider
  // explicitly rejected explains nothing the owner can act on. The provider's
  // own words stay in the sheet's How to fix disclosure.
  if (source.connection.provider_refusal) return withCapture(dashboardProviderRefusalLine(source, options));
  if (source.storage_notice) return withCapture(DASHBOARD_STORAGE_NOTICE_COPY.reason[source.storage_notice.kind]);
  switch (source.connection.state) {
    case 'reauth_required':
      return withCapture(DASHBOARD_SIGNED_OUT);
    case 'awaiting_consent': {
      // The label is the provider's own name off the card, so the sentence
      // points at the tab the owner is actually looking at.
      // The sign-in may be in any browser or on any device, so the line says
      // what to do, never which tab to look in (owner rule, 2026-10-02).
      const base = `finish signing in to ${source.label}`;
      const minutes = source.connection.pending?.expires_in_minutes;
      return withCapture(minutes !== undefined && minutes > 0
        ? `${base} · link expires in ${Math.max(1, Math.ceil(minutes))} min`
        : base);
    }
    case 'needs_setup':
    case 'not_connected':
      return withCapture(source.connection.label);
    default:
      break;
  }
  // What an import source's imports need is one Needs you item each
  // (dashboardImportAttentionSentence); the row keeps its own line.
  if (source.connection.imports_attention?.length) return withCapture(source.connection.label);
  if (source.schedule?.degraded_reason === 'scope_root_permission_needed') return withCapture(DASHBOARD_FOLDER_NEEDS_PERMISSION);
  if (source.schedule?.degraded_reason === 'scope_root_helper_needed') return withCapture(DASHBOARD_FOLDER_NEEDS_HELPER);
  if (source.schedule?.degraded_reason === 'scope_root_unreadable') return withCapture(DASHBOARD_FOLDER_UNREADABLE);
  if (source.schedule?.degraded_reason === 'scope_root_missing' || (source.schedule?.missing_folders?.length ?? 0) > 0) return withCapture(DASHBOARD_MISSING_FOLDER);
  // "Paused" is said only of a real pause — Olympus parked the lane on a budget
  // or a rate limit (owner ruling, 2026-10-08). A broken file, a stale sync or
  // a failing task is stated as itself. A readiness that only names the live
  // feed has its words in `capture`; it is not a pause.
  if (source.answer_readiness.state === 'needs_attention' && !dashboardReadinessNamesCapture(source)) {
    return withCapture(dashboardOperatorPaused(source) ? `paused — ${pausedReason(source)}` : pausedReason(source));
  }
  // Owner ruling, 2026-08-24: NO ERROR COUNTS ANYWHERE. This line used to end
  // "3 items need attention · 1 task retrying", which is a number about queue
  // depth dressed as a number about the reader's data — and the reader can do
  // nothing with either figure. The row still says which of the two states it
  // is in, because the row exists and has to explain itself; it just stops
  // quantifying a fault nobody can act on by the size of it.
  if (source.queue_health.needs_attention > 0) return withCapture('some items could not be read');
  if ((source.queue_health.retrying_tasks ?? 0) > 0) return withCapture('a sync is retrying on its own');
  return withCapture('');
}

/** The row word for a connection the owner has to sign back into. */
export const DASHBOARD_SIGNED_OUT = 'signed out';
/** A source the owner disconnected whose indexed data is still on the computer. */
export const DASHBOARD_DISCONNECTED_DATA_KEPT = 'Disconnected · indexed data kept';

/**
 * The one verb for repairing a connection, everywhere on owner surfaces. The
 * view model still names it "Reauthenticate" on some actions; every label a
 * button shows passes through dashboardActionLabel, which says Reconnect.
 */
export const DASHBOARD_RECONNECT_LABEL = 'Reconnect';

/** A button's words, in the dashboard's vocabulary. */
export function dashboardActionLabel(label: string): string {
  return /^re-?auth/i.test(label.trim()) ? DASHBOARD_RECONNECT_LABEL : label;
}

/** Why a source whose answers are held back is paused, in one clause. */
function pausedReason(source: DashboardSourceCard): string {
  // A readiness label that names its own cause is already the sentence; only
  // the generic one is replaced with the reason the card's fields carry.
  const label = source.answer_readiness.label.trim();
  const known = READINESS_REASONS[label];
  if (known !== undefined) return known;
  if (label !== '' && label !== GENERIC_READINESS_ATTENTION_LABEL) return lowerFirst(label);
  if ((source.queue_health.failing_tasks ?? 0) > 0) return 'its sync keeps failing';
  if (source.queue_health.needs_attention > 0) return 'some items could not be read';
  const relative = typeof source.freshness.hours === 'number' ? dashboardRelativeFromHours(source.freshness.hours) : '';
  return relative ? `last synced ${relative}, later than expected` : 'it has not synced when expected';
}

/**
 * The readiness label source-dashboard.ts raises when more than
 * DASHBOARD_UNREADABLE_ALARM_SHARE of a source's in-scope files can't be read:
 * past that, it is an extractor regression, not a few damaged files.
 */
export const DASHBOARD_MANY_UNREADABLE_LABEL = 'Many files cannot be read';

/**
 * Files the boot migration could not finish moving into their account folder
 * (core/source-account-migration.ts). `reason` is the clause after the source's
 * name on its row; `nextAction` is the step on its sheet. A restart is named only
 * where it can help: the migration finishes or undoes a half move at every boot.
 */
export const DASHBOARD_STORAGE_NOTICE_COPY = {
  reason: {
    moved_back: 'its files could not be moved, so they were put back',
    stuck: 'its files are part way through a move',
    unreadable: 'Olympus cannot open the folder its files are in',
    in_the_way: 'its files are in two places',
  },
  nextAction: {
    moved_back: (label: string) => `Olympus tried to move ${label}'s files into their own folder, a check failed, and it put everything back, so nothing was lost and ${label} works as before. Ask your agent to find out what failed before the move is tried again.`,
    stuck: (label: string) => `${label}'s files are part way through a move and ${label} is closed until it ends. Restart Olympus to finish it; if this stays after a restart, ask your agent to look at it.`,
    unreadable: (label: string) => `Olympus cannot open the folder where ${label}'s files are, so it cannot move them. Ask your agent to check that your user account may open Olympus's data folder.`,
    in_the_way: (label: string) => `${label}'s files are where they have always been and in their own folder too, so Olympus moved nothing. Ask your agent to compare the two before anything is moved.`,
  },
} as const;

/**
 * The computer's disk is nearly full, so a source's new media waits to
 * download (DashboardSourceCard `media_storage`; owner, 2026-10-26). `reason`
 * is the clause after the source's name on its row, with no counts (owner
 * ruling, 2026-08-24); `nextAction` is the step on its setup sheet.
 */
export const DASHBOARD_MEDIA_STORAGE_COPY = {
  reason: 'the computer\'s disk is nearly full; new media will download once space is freed',
  nextAction: (label: string) => `This computer's disk is nearly full, so new photos and files from ${label} wait to download. `
    + 'Messages still arrive. Free space on this computer, and the waiting media downloads on its own.',
} as const;

/** The view model's readiness labels that name a cause, in the owner's words. */
const READINESS_REASONS: Readonly<Record<string, string>> = {
  'Reauthenticate this source': DASHBOARD_SIGNED_OUT,
  'Embedding lane needs attention': 'indexing has stopped',
  'Content extraction is stalled': 'reading files has stalled',
  [DASHBOARD_MANY_UNREADABLE_LABEL]: "many files can't be read",
};

/** The view model's catch-all readiness label, which names no cause. */
const GENERIC_READINESS_ATTENTION_LABEL = 'Needs attention before answers';

/**
 * Live capture: WhatsApp and Telegram messages arrive through a helper that
 * holds a linked session. A pull of what it captured can succeed on schedule
 * while the helper has captured nothing for days, so "synced a minute ago"
 * and "no new messages in days" are different facts and the card says both.
 *
 * The readiness labels source-dashboard.ts raises for a live feed; the
 * sentence is built from the card's capture fields, not from the label (see
 * dashboardCaptureProblem), so another problem owning the label hides nothing.
 */
export const DASHBOARD_CAPTURE_STALE_LABEL = 'Live capture is stale';
export const DASHBOARD_CAPTURE_BLOCKED_LABEL = 'Live capture cannot start';

export const DASHBOARD_CAPTURE_COPY = {
  /** The label of the route to the source's panel on the computer. */
  fixLabel: 'Check capture',
  /** The newest captured message is older than the threshold. */
  stale: (age: string) => `capture stale: newest message ${age}`,
  /** Nothing was captured since the pairing, for longer than the threshold. */
  staleNoAge: 'capture stale: nothing captured since linking',
  /** A pull succeeded, and nothing it holds says when a message was captured. */
  unavailable: 'no live messages captured yet',
  /** Media the helper could not download for want of disk space: its messages are kept, the media follows when there is room. */
  disk: 'media waiting for disk space',
  /** Linked a moment ago and no message has arrived under this pairing yet. */
  awaiting: 'waiting for the first live message',
  /** The same, over messages kept from an earlier pairing: their age stays visible. */
  awaitingWithHistory: (age: string) => `waiting for the first live message · newest kept message ${age}`,
  /** The helper's own state, by reason: every fault names what is wrong and none names a chat. */
  helper: {
    grant_invalid: 'capture cannot start: its approval cannot be read',
    session_missing: 'capture cannot start: its linked session is missing',
    secret_missing: 'capture cannot start: its saved sign-in key is missing',
    start_failed: 'capture cannot start: its helper would not start',
    helper_exited: 'capture keeps stopping: its helper exits soon after it starts',
    grant_missing: 'capture stopped: its approval is missing',
    handle_unavailable: 'capture stopped: its sign-in is no longer available',
    helper_running: 'capture cannot start: another capture helper is using its linked session',
    account_moving: 'capture paused: its files are part way through a move',
  } satisfies Record<Exclude<DashboardCaptureSupervisorReason, 'restarting'>, string>,
  /** A helper fault with no reason the page knows. */
  helperUnknown: 'capture cannot start',
  running: 'capture running',
  stopped: 'capture stopped',
  /** The helper exited and the next check will start it again: not a fault, and not running either. */
  restarting: 'capture restarting',
  wholeAccount: 'whole account',
  chats: (count: number) => `${dashboardCount(count)} ${count === 1 ? 'chat' : 'chats'}`,
  nextAction: {
    stale: (label: string) => `Open ${label} on this computer to check the link and capture. Syncing again will not bring in messages that were never captured.`,
    blocked: (label: string) => `Open ${label} on this computer and link it again so live capture can start.`,
    awaiting: (label: string) => `Keep ${label} linked. The first live message since linking will end this wait; if none arrives within the day, this row says so.`,
    disk: (label: string) => `Free some space on this computer. Every ${label} message is kept meanwhile, and the waiting pictures, videos and voice notes download on their own once there is room.`,
  },
} as const;

/** The connection states a live feed can be judged in: it is linked and has had a pull. */
const CAPTURE_JUDGED_CONNECTION_STATES: ReadonlySet<DashboardConnectionState> = new Set<DashboardConnectionState>([
  'connected',
  'waiting_for_first_sync',
  'syncing',
  'synced',
]);

/**
 * A stop that nobody asked for. A helper stopped for no reason (the secure-
 * local posture forbids capture) is a choice and stays a quiet clause; one
 * stopped because its approval or its sign-in is gone, on a source that still
 * reads connected, is a feed that is not being captured.
 */
const CAPTURE_UNEXPECTED_STOP_REASONS: ReadonlySet<string> = new Set(['grant_missing', 'handle_unavailable']);

export interface DashboardCaptureProblem {
  /**
   * `helper`: nothing is capturing. `stale`: the helper may run, but the feed went quiet. `disk`: messages are
   * captured, and their media waits for disk space on this computer.
   */
  cause: 'helper' | 'stale' | 'disk';
  /** The supervisor's reason, for `helper`. */
  reason?: DashboardCaptureSupervisorReason;
}

/**
 * Whether the live feed of a connected source is a problem, from the card's
 * capture fields alone, never from the readiness label: another problem
 * (a late refresh, a queue) may own the label and must not hide this one. A
 * helper that cannot run outranks a quiet feed, being its likely cause.
 */
export function dashboardCaptureProblem(source: DashboardSourceCard): DashboardCaptureProblem | undefined {
  if (!CAPTURE_JUDGED_CONNECTION_STATES.has(source.connection.state)) return undefined;
  const supervisor = source.capture?.supervisor;
  if (supervisor?.state === 'blocked'
    || (supervisor?.state === 'stopped' && supervisor.reason !== undefined && CAPTURE_UNEXPECTED_STOP_REASONS.has(supervisor.reason))) {
    return { cause: 'helper', ...(supervisor.reason ? { reason: supervisor.reason } : {}) };
  }
  if (source.freshness.capture?.state === 'stale') return { cause: 'stale' };
  if (source.freshness.capture?.media_waiting_for_disk === true) return { cause: 'disk' };
  return undefined;
}

/** True when the card's readiness label is one of the two that only name the live feed. */
export function dashboardReadinessNamesCapture(source: DashboardSourceCard): boolean {
  return source.answer_readiness.label === DASHBOARD_CAPTURE_STALE_LABEL
    || source.answer_readiness.label === DASHBOARD_CAPTURE_BLOCKED_LABEL;
}

/**
 * The reason half of a Needs you row for a live feed that is stale or whose
 * helper is not running, or undefined when the feed is no problem. "capture
 * stale: newest message 3d ago", with an intentionally stopped helper named
 * beside it.
 */
export function dashboardCaptureAttentionReason(source: DashboardSourceCard): string | undefined {
  const problem = dashboardCaptureProblem(source);
  if (!problem) return undefined;
  if (problem.cause === 'helper') {
    return problem.reason === undefined || problem.reason === 'restarting'
      ? DASHBOARD_CAPTURE_COPY.helperUnknown
      : DASHBOARD_CAPTURE_COPY.helper[problem.reason];
  }
  if (problem.cause === 'disk') return DASHBOARD_CAPTURE_COPY.disk;
  const age = source.freshness.capture?.age_seconds;
  const relative = typeof age === 'number' ? dashboardRelativeFromMs(age * 1_000) : '';
  const base = relative ? DASHBOARD_CAPTURE_COPY.stale(relative) : DASHBOARD_CAPTURE_COPY.staleNoAge;
  return source.capture?.supervisor?.state === 'stopped' ? `${base} · ${dashboardStoppedClause(source)}` : base;
}

/** A stopped helper in words: restarting when it only exited and will be started again, else stopped. */
function dashboardStoppedClause(source: DashboardSourceCard): string {
  return source.capture?.supervisor?.reason === 'restarting' ? DASHBOARD_CAPTURE_COPY.restarting : DASHBOARD_CAPTURE_COPY.stopped;
}

/**
 * A pairing that has not captured its first message yet, in words, with the
 * age of the newest message kept from before it when there is one. Empty when
 * the feed is not awaiting.
 */
export function dashboardCaptureAwaitingClause(source: DashboardSourceCard): string {
  const capture = source.freshness.capture;
  if (capture?.state !== 'awaiting') return '';
  const relative = typeof capture.age_seconds === 'number' ? dashboardRelativeFromMs(capture.age_seconds * 1_000) : '';
  return relative ? DASHBOARD_CAPTURE_COPY.awaitingWithHistory(relative) : DASHBOARD_CAPTURE_COPY.awaiting;
}

/**
 * What a quiet row says about live capture beside its sync time: nothing
 * captured yet, whether the helper runs, and what it was approved to read.
 * Empty for a source that reports none of it.
 */
export function dashboardCaptureClause(source: DashboardSourceCard): string {
  const parts: string[] = [];
  if (source.freshness.capture?.state === 'unavailable') parts.push(DASHBOARD_CAPTURE_COPY.unavailable);
  const supervisor = source.capture?.supervisor?.state;
  if (supervisor === 'running') parts.push(DASHBOARD_CAPTURE_COPY.running);
  else if (supervisor === 'stopped') parts.push(dashboardStoppedClause(source));
  const scope = source.capture?.scope;
  if (scope?.kind === 'whole_account') parts.push(DASHBOARD_CAPTURE_COPY.wholeAccount);
  else if (scope?.kind === 'chats' && scope.count > 0) parts.push(DASHBOARD_CAPTURE_COPY.chats(scope.count));
  return parts.join(' · ');
}

function lowerFirst(value: string): string {
  return value.length > 0 ? value[0]!.toLowerCase() + value.slice(1) : value;
}

/** Provider error codes that mean the sign-in address is not registered. */
const REDIRECT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'redirect_uri_mismatch',
  'invalid_redirect_uri',
  'redirect_uri_not_registered',
]);

/**
 * A provider's refusal as the row's reason half ("rejected the sign-in
 * address — fix it in your Dropbox app settings"). The provider's own code and
 * the address to register are technical detail; they live in the connect
 * sheet's How to fix disclosure, never on the row.
 */
export function dashboardProviderRefusalLine(source: DashboardSourceCard, options?: DashboardVocabularyOptions): string {
  const code = source.connection.provider_refusal?.code ?? '';
  if (options?.surface === 'chatgpt') return DASHBOARD_CHATGPT_REFUSAL_COPY.line[chatgptRefusalKind(code)];
  if (REDIRECT_REFUSAL_CODES.has(code)) {
    return `rejected the sign-in address — fix it in your ${source.label} app settings`;
  }
  if (code === 'access_denied') return 'sign-in was declined — connect again to retry';
  return 'refused the sign-in — see How to fix';
}

/** The same refusal as a full sentence, for the top of the connect sheet. */
export function dashboardProviderRefusalSentence(source: DashboardSourceCard, options?: DashboardVocabularyOptions): string {
  const code = source.connection.provider_refusal?.code ?? '';
  if (options?.surface === 'chatgpt') return DASHBOARD_CHATGPT_REFUSAL_COPY.sentence[chatgptRefusalKind(code)](source.label);
  if (REDIRECT_REFUSAL_CODES.has(code)) {
    return `${source.label} rejected the sign-in address. Fix it in your ${source.label} app settings, then connect again.`;
  }
  if (code === 'access_denied') return `${source.label} sign-in was declined. Connect again to retry.`;
  return `${source.label} refused the sign-in. How to fix has the details.`;
}

function chatgptRefusalKind(code: string): keyof typeof DASHBOARD_CHATGPT_REFUSAL_COPY.line {
  if (REDIRECT_REFUSAL_CODES.has(code)) return 'address';
  if (code === 'access_denied') return 'declined';
  return 'unfinished';
}

/** The raw refusal, for the How to fix disclosure only. */
export function dashboardProviderRefusalDetail(source: DashboardSourceCard): string | undefined {
  return source.connection.provider_refusal?.reason;
}

/* ------------------------------------------------------ progress words -- */

/**
 * Where indexing stands, as the page measured it.
 *
 * `percent` is the share of the work done (its unit is whatever the backlog
 * counts; a percentage carries no unit). `itemsLeft` is set only from a real
 * per-item count — never relabelled chunks. `etaMs` is set only from a
 * measured rate.
 */
export interface DashboardIndexingProgress {
  /** 0..100, absent when there is no denominator (nothing to index). */
  percent?: number;
  itemsLeft?: number;
  etaMs?: number;
  state: 'done' | 'moving' | 'stalled' | 'paused' | 'off' | 'unknown';
}

/** The owner's name for indexing — the embedding work. */
export const DASHBOARD_INDEXING_NAME = 'Indexing';

/**
 * "98% done, 4,055 items left, about 2 hours" — the half after the name.
 *
 * Moving with no measured rate says nothing about time (owner rule,
 * 2026-10-02: no ETA unless measured, and no placeholder for one); a stopped
 * lane says stalled; a lane something parked says paused.
 */
export function dashboardIndexingFacts(progress: DashboardIndexingProgress): string {
  if (progress.state === 'done') return 'up to date';
  const parts: string[] = [];
  if (progress.percent !== undefined) parts.push(`${Math.floor(progress.percent)}% done`);
  if (progress.itemsLeft !== undefined && progress.itemsLeft > 0) {
    parts.push(`${dashboardCount(progress.itemsLeft)} ${plural(progress.itemsLeft, 'item')} left`);
  }
  switch (progress.state) {
    case 'moving':
      if (progress.etaMs !== undefined && progress.etaMs > 0) parts.push(dashboardEtaWords(progress.etaMs));
      break;
    case 'stalled':
      parts.push('stalled');
      break;
    case 'paused':
      parts.push('paused');
      break;
    case 'off':
      parts.push('switched off');
      break;
    case 'unknown':
      break;
  }
  return parts.join(', ');
}

/** "Indexing — 98% done, 4,055 items left, about 2 hours". */
export function dashboardIndexingLine(progress: DashboardIndexingProgress): string {
  return `${DASHBOARD_INDEXING_NAME} — ${dashboardIndexingFacts(progress)}`;
}

/**
 * "about 2 hours" — an estimate rounded to the precision it has. A rate
 * measured over minutes cannot support seconds.
 */
export function dashboardEtaWords(etaMs: number): string {
  const minutes = etaMs / 60_000;
  if (minutes < 1.5) return 'about a minute';
  if (minutes < 60) return `about ${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 1.5) return 'about an hour';
  if (hours < 36) return `about ${Math.round(hours)} hours`;
  const days = Math.round(hours / 24);
  return `about ${days} ${plural(days, 'day')}`;
}

/** "1 job running" / "3 jobs running" / "nothing running", with stalls named. */
export function dashboardJobsLine(running: number, stalled = 0): string {
  const head = running > 0 ? `${dashboardCount(running)} ${plural(running, 'job')} running` : 'nothing running';
  return stalled > 0 ? `${head} · ${dashboardCount(stalled)} stalled` : head;
}

/** "4 sources connected, 1 ready to answer". */
export function dashboardConnectedSummary(connected: number, ready: number): string {
  return `${dashboardCount(connected)} ${plural(connected, 'source')} connected, ${dashboardCount(ready)} ready to answer`;
}

/** Why a connect control is greyed out while models are not ready. */
export const DASHBOARD_MODELS_BLOCKED_REASON = 'Locked until models are ready';

/**
 * The one line a setup row shows before "How to set this up": what the source
 * needs and, first, the caveat a reader must accept before starting. The view
 * model carries only the full instructions paragraph, so the short lines live
 * here until it carries its own summary and caveat fields; any other source
 * shows the paragraph's first sentence.
 */
const SETUP_LEADS: Readonly<Record<string, { summary: string; caveat?: string }>> = {
  'x.bookmarks': { caveat: 'Needs paid X API access', summary: 'Create an X app once, then add its Client ID and secret.' },
  'dropbox.files': { summary: 'Needs the app key from your Dropbox developer account.' },
  'readwise.library': { summary: 'Needs your Readwise access token.' },
};

export function dashboardSetupLead(sourceId: string, instructions: string): { summary: string; caveat?: string } {
  const known = SETUP_LEADS[sourceId];
  if (known !== undefined) return known;
  const first = /^.*?[.!?](?=\s|$)/.exec(instructions.trim())?.[0] ?? instructions.trim();
  return { summary: first };
}

/** The control that speeds indexing up, and what it costs. */
/** Fills `{name}` placeholders in a fixed sentence. */
export function fill(template: string, values: Record<string, string | number>): string {
  let out = template;
  for (const key of Object.keys(values)) out = out.split(`{${key}}`).join(String(values[key]));
  return out;
}

export const DASHBOARD_INDEX_FASTER = {
  on: 'Index faster',
  off: 'Stop indexing faster',
  explainOn: 'Syncing pauses until you turn this off.',
  explainOff: 'Syncing is paused until you turn this off.',
} as const;

/**
 * Fraction of the working donut, 0..1, or undefined when nothing on the card
 * gives a defensible ratio (the glyph then falls back to the plain ring).
 *
 * The ratio is ingestion coverage — the share of indexed items that are
 * answer-ready — because it is the only ratio on the card with both halves
 * present. It is NOT embedding progress; there is no embedding denominator on
 * the view model. dashboardSubLine states the ratio in words next to the
 * glyph so the wedge is never left to mean whatever the reader assumes.
 */
export function dashboardWorkFraction(source: DashboardSourceCard): number | undefined {
  if (source.coverage.indexed_items <= 0) return undefined;
  const percent = source.ingestion_health.coverage_percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined;
  return Math.max(0, Math.min(1, percent / 100));
}

/** "checked 12s ago", from generated_at. Empty when the stamp will not parse. */
export function dashboardCheckedLabel(generatedAt: string, now: Date): string {
  const at = Date.parse(generatedAt);
  if (!Number.isFinite(at)) return '';
  const relative = dashboardRelativeFromMs(now.getTime() - at);
  return relative ? `checked ${relative}` : '';
}

/**
 * The home page's meta line: "checked 12s ago", and nothing else.
 *
 * The connected-count arithmetic that used to lead this line ("3 of 5
 * connected") is gone by owner ruling 2026-08-19 evening: the groups
 * themselves already say which sources need attention, and the count was
 * noise that invited exactly the header-vs-rows reconciliation the earlier
 * arithmetic rulings existed to police. Only the staleness fact remains —
 * it is the one thing the rows cannot say about themselves.
 */
export function dashboardHomeMeta(
  view: SourceDashboardViewModel,
  options?: DashboardVocabularyOptions,
): string {
  return dashboardCheckedLabel(view.generated_at, options?.now ?? new Date());
}

/**
 * The setup page's meta line: nothing.
 *
 * Same owner ruling as dashboardHomeMeta: the count is gone, and this page
 * has no staleness fact of its own to state.
 */
export function dashboardSetupMeta(
  _view: SourceDashboardViewModel,
  _options?: DashboardVocabularyOptions,
): string {
  return '';
}

/** True when nothing is connected yet and the first-run page should serve. */
export function dashboardIsFirstRun(view: SourceDashboardViewModel): boolean {
  return view.summary.connected_sources === 0 || view.sources.every((source) => !source.configured);
}

/**
 * The home page's foot line about background work, or undefined when no
 * backing field reports any. Carries its own "Background:" lead-in; the page
 * renders the string verbatim.
 *
 * Built from queue depth and drain state only. The mockup's vision-extraction
 * queue and embedding drain ETA have no field behind them anywhere in the view
 * model, so neither number appears.
 */
export function dashboardBackgroundLine(view: SourceDashboardViewModel): string | undefined {
  let queued = 0;
  let attention = 0;
  let retrying = 0;
  let paused = 0;
  for (const source of view.sources) {
    queued += source.queue_health.waiting + source.queue_health.active;
    attention += source.queue_health.needs_attention;
    retrying += source.queue_health.retrying_tasks ?? 0;
    const drain = source.ingestion_health.drain_state;
    if (drain === 'held' || drain === 'disabled') paused += 1;
  }
  const parts: string[] = [];
  if (queued > 0) parts.push(`${dashboardCount(queued)} ${plural(queued, 'item')} queued`);
  if (attention > 0) parts.push(`${dashboardCount(attention)} needing attention`);
  if (retrying > 0) parts.push(`${dashboardCount(retrying)} ${plural(retrying, 'task')} retrying`);
  if (paused > 0) parts.push(`reading paused on ${dashboardCount(paused)} ${plural(paused, 'source')}`);
  if (parts.length === 0) return undefined;
  return `Background: ${parts.join(' · ')}`;
}

export function dashboardSourceById(
  view: SourceDashboardViewModel,
  sourceId: string,
): DashboardSourceCard | undefined {
  return view.sources.find((source) => source.source_id === sourceId);
}

/**
 * "12s ago" / "41m ago" / "2h ago" / "3d ago".
 *
 * A negative elapsed time is clock skew, not the future, so it clamps to now
 * rather than rendering a countdown nobody asked for.
 */
export function dashboardRelativeFromMs(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs)) return '';
  // Rounded, not floored. freshness.hours arrives already rounded off upstream,
  // so a check 41 minutes old reaches here as 0.6833 hours — 40.98 minutes —
  // and flooring reports it a whole minute staler than it is.
  const seconds = Math.round(Math.max(0, elapsedMs) / 1000);
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The same grammar from freshness.hours, which is a raw float of hours. */
export function dashboardRelativeFromHours(hours: number): string {
  if (!Number.isFinite(hours)) return '';
  return dashboardRelativeFromMs(hours * 3_600_000);
}

/** "0s" / "18s" / "2m 10s" / "1h 5m" / "3d 4h". Never negative. */
export function dashboardDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const rest = total % 60;
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
}

/**
 * "67,412 files not read by policy" — the fact that keeps an answer-ready
 * percentage honest.
 *
 * The percentage now divides by what the system is asked to read (owner
 * ruling, 2026-08-21), so a corpus can read 100% of its eligible files while
 * most of what it stores was never opened. This sentence is printed wherever
 * that percentage is, so the 100 can never stand alone.
 *
 * "files", not "media and book files": the count also carries privacy-fenced
 * items, and naming only the media half would misdescribe them. Nothing here
 * is operator work, so no verb asks the reader for anything.
 */
export function dashboardNotReadByPolicyPhrase(count: number): string {
  return `${dashboardCount(count)} ${plural(count, 'file')} not read by policy`;
}

/**
 * What replaces the percentage when the policy leaves nothing to read at all.
 *
 * The ratio is 100 there — nothing was left unread — but printing "100%
 * answer-ready" over a corpus with zero readable files states the opposite of
 * what happened, so the words say what the number cannot.
 */
export const DASHBOARD_NONE_READ_BY_POLICY = 'none of these files are read by policy';

/**
 * The same fact for mail. Mail is never "not read by policy": what Olympus
 * leaves unread is older than the window the owner chose when connecting, and
 * it is kept as names only. Says so in those words, with no file or policy.
 */
export const DASHBOARD_NONE_READ_OLD_MAIL = 'older mail is kept as names only';

/** What replaces the percentage when nothing in scope is read at all, in this family's words. */
export function dashboardNoneReadSentence(family: string): string {
  return family === 'email' ? DASHBOARD_NONE_READ_OLD_MAIL : DASHBOARD_NONE_READ_BY_POLICY;
}

/**
 * The one number the detail page leads with, and the counts underneath it.
 *
 * Owner ruling, 2026-08-24: THE metric is a single percentage — fully-working
 * files over the files Olympus is SUPPOSED to handle. What has been excluded is
 * not a headline number ("It doesn't matter what's been excluded. We're not
 * trying to count that here."), so `not_read_by_policy_items` is deliberately
 * absent from this summary and is printed as a footnote elsewhere. It must
 * never sit beside the percentage again.
 *
 * "Fully working" means a file Olympus can actually answer from, which takes
 * BOTH halves: its text has been extracted, and its chunks are embedded on the
 * current epoch. A file whose chunks are waiting to be re-embedded is not
 * working yet, however cleanly its text came out.
 *
 * Those two halves are counted in different units — extraction per file, parity
 * per chunk (`embedded_items` is really `embedded_chunks`, and nothing in the
 * view model counts items embedded on the current epoch). Folding a chunk ratio
 * into a per-file ratio would invent a number nothing measured, so when parity
 * is short this returns BOTH and the page prints both: "97% of text extracted ·
 * 12% searchable until re-embed completes". One number is reported only when
 * one number is true.
 */
export interface DashboardWorkingSummary {
  /** Files Olympus is supposed to handle — the only denominator here. */
  in_scope_items: number;
  /** Of those, how many have their text extracted. */
  read_items: number;
  /**
   * Of those, how many extraction gave up on for good. Settled, not pending:
   * they finish the stage without ever counting as read.
   */
  unreadable_items?: number;
  /** Percent of in-scope files whose text is extracted, 0..100. */
  read_percent: number;
  /**
   * Percent of this corpus's chunks embedded on the current epoch, when parity
   * is reported and short. Absent when parity is met or unreported — and its
   * absence is what lets `read_percent` stand as the whole answer.
   */
  searchable_percent?: number;
  /**
   * True when every in-scope file is read AND parity is met, so the headline
   * may say so outright.
   */
  fully_working: boolean;
}

/**
 * The summary, or undefined when the card gives no defensible denominator.
 *
 * Nothing in scope is not an achievement: a card with no eligible files gets
 * undefined rather than a 100 that would assert a finished corpus.
 */
export function dashboardWorkingSummary(
  source: DashboardSourceCard,
): DashboardWorkingSummary | undefined {
  const inScope = answerReadyEligibleItems(
    source.coverage.indexed_items,
    source.coverage.not_read_by_policy_items,
    source.coverage.answer_ready_eligible_items,
  );
  if (inScope <= 0) return undefined;
  const read = Math.max(0, Math.min(inScope, source.coverage.content_ready_items));
  const readPercent = clampPercent((read / inScope) * 100);
  const unreadable = Math.max(0, Math.min(inScope - read, Math.trunc(source.coverage.unreadable_items ?? 0)));
  const backlog = source.embedding_backlog;
  // Parity counts chunks, so it can only ever qualify the headline — never
  // become it. `chunks` is documented as always > 0 where a backlog exists.
  const parityShort = backlog !== undefined
    && (backlog.missing_chunks > 0 || backlog.refresh_needed)
    && backlog.chunks > 0;
  const searchablePercent = parityShort
    ? clampPercent((backlog.embedded_chunks / backlog.chunks) * 100)
    : undefined;
  return {
    in_scope_items: inScope,
    read_items: read,
    ...(unreadable > 0 ? { unreadable_items: unreadable } : {}),
    read_percent: readPercent,
    ...(searchablePercent !== undefined ? { searchable_percent: searchablePercent } : {}),
    fully_working: read + unreadable >= inScope && !parityShort,
  };
}

/**
 * The headline line: one percentage when one is true, two when two are.
 *
 * A bare "100%" is refused while anything in scope is still unread or still
 * waiting to embed — the honesty rule the whole page is built on. `fully_working`
 * is the only thing that earns the unqualified sentence.
 */
export function dashboardWorkingHeadline(summary: DashboardWorkingSummary): string {
  if (summary.fully_working) {
    const unreadable = summary.unreadable_items ?? 0;
    if (unreadable > 0) {
      return `everything readable is working — ${dashboardCount(summary.read_items)} of`
        + ` ${dashboardCount(summary.in_scope_items)} ${plural(summary.in_scope_items, 'file')}`
        + ` · ${dashboardCount(unreadable)} can't be read`;
    }
    return `everything in scope is working — ${dashboardCount(summary.in_scope_items)}`
      + ` ${plural(summary.in_scope_items, 'file')}`;
  }
  const read = `${formatPercent(summary.read_percent)} of text extracted`;
  return summary.searchable_percent === undefined
    ? read
    : `${read} · ${formatPercent(summary.searchable_percent)} searchable until re-indexing completes`;
}

/** Whole numbers stay whole; a fraction keeps one decimal. */
function formatPercent(percent: number): string {
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

/** Thousands-separated, locale-independent: "129,948". */
export function dashboardCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rounded < 0 ? `-${digits}` : digits;
}

function freshLine(source: DashboardSourceCard, now: Date): string {
  // The answer lane has nothing to sync, and its freshness label is the only
  // field that says so.
  if (source.freshness.label.startsWith('Answer lane:')) return 'answers questions directly';
  // Imports are read once, never synced: the line says how many are held.
  if (source.connection.action.kind === 'archive_import') return source.connection.label;
  const unreadable = dashboardUnreadablePhrase(source);
  // The owner's own Sync now press, while it is the latest word, says what it
  // found in place of the bare sync time.
  const manual = dashboardManualSyncLine(source, now);
  const capture = dashboardCaptureClause(source);
  const pass = dashboardLivePassClause(source);
  const tail = [pass, unreadable, capture].filter((part): part is string => !!part).join(' · ');
  if (manual) return tail ? `${manual} · ${tail}` : manual;
  const hours = source.freshness.hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return tail;
  const relative = dashboardRelativeFromHours(hours);
  if (!relative) return tail;
  // A lane Olympus parked is calm, not idle by accident. Saying so keeps this
  // line from implying the sync is still running, and matches the detail
  // page's paused sentence for the same marker.
  const synced = dashboardOperatorPaused(source) ? `synced ${relative} · sync paused` : `synced ${relative}`;
  return tail ? `${synced} · ${tail}` : synced;
}

/** What stopped a source's latest pass, in words (`DashboardLivePass.error`). */
export const DASHBOARD_LIVE_PASS_ERROR_COPY: Readonly<Record<DashboardLivePassErrorKind, string>> = Object.freeze({
  auth: 'the last check could not sign in',
  rate_limited: 'the last check was slowed by the provider and resumes on its own',
  listing_incomplete: 'the last check could not list every note, so nothing was changed',
  account_changed: 'the last check found a different Evernote account than the notes stored here, so nothing was changed: reconnect the earlier account, or delete this card\'s indexed data first',
  unavailable: 'the last check could not reach the provider',
});

/**
 * A pass-read source's last pass: "1,204 notes in 12 notebooks · 3 shared
 * with you, not imported", and what stopped a later pass. Undefined before
 * the first pass.
 */
export function dashboardLivePassClause(source: Pick<DashboardSourceCard, 'live_pass'>): string | undefined {
  const pass = source.live_pass;
  if (!pass) return undefined;
  const parts: string[] = [];
  if (pass.completed_at) {
    parts.push(`${dashboardCount(pass.notes)} ${pass.notes === 1 ? 'note' : 'notes'} in ${dashboardCount(pass.notebooks)} ${pass.notebooks === 1 ? 'notebook' : 'notebooks'}`);
    if (pass.shared_not_imported > 0) parts.push(`${dashboardCount(pass.shared_not_imported)} shared with you, not imported`);
  }
  if (pass.error) parts.push(DASHBOARD_LIVE_PASS_ERROR_COPY[pass.error.kind]);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * The noun a source's items go by (owner note, 2026-09-01: "the units need to
 * be correct for each bar" — Gmail was counting "files"). Off the card's
 * family, which is the one field that says what kind of thing an item is.
 */
export function dashboardItemNoun(source: Pick<DashboardSourceCard, 'family'>): string {
  switch (source.family) {
    case 'email':
    case 'chat':
      return 'messages';
    // Readwise indexes Reader documents and highlights alike, so neither word
    // alone names what is counted (owner review, 2026-09-24).
    case 'readwise':
      return 'items';
    case 'x':
      return 'posts';
    case 'file':
      return 'files';
    default:
      return 'items';
  }
}

/** "1 file", "2 files", "12 new files": the item noun at a count. */
function itemsPhrase(source: Pick<DashboardSourceCard, 'family'>, count: number, adjective = ''): string {
  const noun = dashboardItemNoun(source);
  return `${dashboardCount(count)} ${adjective ? `${adjective} ` : ''}${count === 1 ? noun.replace(/s$/, '') : noun}`;
}

/**
 * "2 files can't be read", or undefined when nothing is unreadable.
 *
 * Owner ruling, 2026-10-08: a damaged file, or one in a format nothing reads,
 * is a fact the row states beside its normal line — never a pause and never a
 * Needs you of its own (the readiness guard re-alarms past
 * DASHBOARD_UNREADABLE_ALARM_SHARE). Counts only; no file is ever named.
 */
export function dashboardUnreadablePhrase(source: DashboardSourceCard): string | undefined {
  const count = Math.max(0, Math.trunc(source.coverage.unreadable_items ?? 0));
  return count > 0 ? `${itemsPhrase(source, count)} can't be read` : undefined;
}

/** A finished phase that left some files unread for good: "Done · 252 read · 2 can't be read". */
export function dashboardPhaseUnreadableWords(read: number, unreadable: number): string {
  return `Done · ${dashboardCount(read)} read · ${dashboardCount(unreadable)} can't be read`;
}

/**
 * The detail page's plain reason for those files (2026-10-08). Never a file
 * name: the reason is the same for every one of them.
 */
export function dashboardUnreadableSentence(source: DashboardSourceCard): string | undefined {
  const phrase = dashboardUnreadablePhrase(source);
  if (!phrase) return undefined;
  if ((source.coverage.settled_unreadable_items ?? 0) > 0) {
    return `${phrase[0]!.toUpperCase()}${phrase.slice(1)}. Some items were kept Private without being read because their privacy checks were missing. See why lists the items; open them to check them, then use Sync now to try reading them again.`;
  }
  const lead = `${phrase[0]!.toUpperCase()}${phrase.slice(1)}: extraction failed permanently — the file is damaged`
    + " or in a format Olympus can't read.";
  // Past the alarm share the row says Needs you, so this sentence must not say
  // nothing is waiting — and the rest of the source still answers.
  return source.answer_readiness.label === DASHBOARD_MANY_UNREADABLE_LABEL
    ? `${lead} ${DASHBOARD_UNREADABLE_NOTE_MANY}`
    : `${lead} ${DASHBOARD_UNREADABLE_NOTE}`;
}

/** The note under See why, and the detail page's tail: nothing to do, the rest answers. */
export const DASHBOARD_UNREADABLE_NOTE = 'Olympus does not retry these, and nothing is waiting on you.';

/**
 * The unreadable files a list leaves out ("and 12 more"): in ChatGPT the
 * link to the computer's full list, on the computer the tail past its limit.
 */
export const DASHBOARD_UNREADABLE_MORE = 'and {count} more';

export function dashboardUnreadableMoreLabel(count: number): string {
  return DASHBOARD_UNREADABLE_MORE.replace('{count}', dashboardCount(count));
}

/** The same note past DASHBOARD_UNREADABLE_ALARM_SHARE, where the row already says Needs you. */
export const DASHBOARD_UNREADABLE_NOTE_MANY =
  'That is more than a healthy source has, so it may be a problem in Olympus rather than your files.'
  + ' The other files still answer questions.';

/**
 * Why files can't be read, as a closed list (phase 3 of the unified dashboard).
 * Today extraction records one permanent failure, so one reason exists: a
 * damaged file and a format nothing reads are the same to the engine. More
 * codes need extraction to store one first. The view model carries a code and
 * a count per code (names travel beside it, never in a reason); the panel
 * holds these words.
 */
export const DASHBOARD_UNREADABLE_REASON_CODES = ['damaged_or_unsupported', 'privacy_check_missing'] as const;
export type DashboardUnreadableReasonCode = (typeof DASHBOARD_UNREADABLE_REASON_CODES)[number];

export const DASHBOARD_UNREADABLE_REASON_WORDS: Readonly<
  Record<DashboardUnreadableReasonCode, { one: string; other: string }>
> = {
  privacy_check_missing: {
    one: "{count} item was kept Private without being read because its privacy check was missing. Open it below to check it, then use Sync now to try reading it again.",
    other: "{count} items were kept Private without being read because their privacy checks were missing. Open them below to check them, then use Sync now to try reading them again.",
  },
  damaged_or_unsupported: {
    one: "{count} file is damaged or in a format Olympus can't read",
    other: "{count} files are damaged or in a format Olympus can't read",
  },
};

/**
 * Why a source's sync failed or paused, one sentence per closed failure kind
 * (dashboard/source-failure.ts); {source} is the source's name. Never the
 * provider's words: an `unknown` failure adds the reference Olympus's log
 * keeps the message under (owner rule, 2026-10-10: never say something is
 * wrong without a way to find out exactly what it is).
 */
export const DASHBOARD_SOURCE_FAILURE_WORDS: Readonly<Record<SourceFailureKind, string>> = {
  sign_in: '{source} needs you to sign in again.',
  network: 'Olympus couldn\'t reach {source} over the network.',
  timeout: '{source} took too long to answer.',
  rate_limited: '{source} asked Olympus to slow down for a while.',
  provider_busy: '{source} was busy and asked Olympus to try later.',
  provider_refused: '{source} refused Olympus\'s request.',
  daily_limit: 'Olympus reached its daily limit for {source}.',
  search_model_unavailable: 'The search model wasn\'t running.',
  reader_unavailable: 'The file reader wasn\'t running.',
  busy_here: 'Olympus was busy with other work.',
  setup: '{source}\'s setup isn\'t finished.',
  not_started: 'The check didn\'t start.',
  unknown: 'Olympus hit an error it doesn\'t recognise.',
};

/** After an `unknown` failure or an opaque tool error: where its exact words are. */
export const DASHBOARD_FAILURE_REF = 'Olympus\'s log on the computer has the details under reference {ref}.';

/** The same, for an unrecognised error that came without a reference (an older run). */
export const DASHBOARD_FAILURE_LOG = 'Olympus\'s log on the computer has the details.';

/**
 * "Dropbox took too long to answer." — and for a failure Olympus could not
 * classify, where its log keeps the exact words.
 */
export function dashboardSourceFailureSentence(kind: SourceFailureKind, label: string, ref?: string): string {
  const sentence = DASHBOARD_SOURCE_FAILURE_WORDS[kind].replace('{source}', label);
  if (kind !== 'unknown') return sentence;
  return `${sentence} ${ref ? DASHBOARD_FAILURE_REF.replace('{ref}', ref) : DASHBOARD_FAILURE_LOG}`;
}

/**
 * A Sync now that could not run, in plain words, with why when the engine
 * knows it; the provider's own text stays in the log.
 */
export function dashboardManualSyncFailedLine(
  label: string,
  failure?: SourceFailureKind,
  ref?: string,
  when = 'just now',
  name?: DashboardSyncName,
): string {
  const mid = name?.mid ?? label;
  if (!failure) return `Couldn't check ${mid} ${when} — Olympus will try again on its own`;
  return `Couldn't check ${mid} ${when}: ${dashboardSourceFailureSentence(failure, label, ref)} Olympus will try again on its own.`;
}

/** While a Sync now press is outstanding: "Checking Dropbox…". */
export function dashboardManualSyncPendingLine(label: string | DashboardSyncName): string {
  return `Checking ${syncMid(label)}…`;
}

/** A source's name in the Sync now copy: its declared phrases, else its label. */
function syncMid(name: string | DashboardSyncName): string {
  return typeof name === 'string' ? name : name.mid;
}

/** A Sync now press that found a sync of this source already running, so started nothing new. */
export function dashboardManualSyncBusyLine(label: string | DashboardSyncName): string {
  return `Already checking ${syncMid(label)}`;
}

/**
 * A Sync now pressed again within a minute of the last one (2026-10-09): the
 * press starts nothing, and says why.
 */
export function dashboardManualSyncTooSoonLine(label: string | DashboardSyncName): string {
  const start = typeof label === 'string' ? label : label.start;
  const verb = typeof label !== 'string' && label.plural === true ? 'were' : 'was';
  return `${start} ${verb} checked a moment ago — try again in a minute`;
}

/**
 * What the last Sync now press found, while the card still carries it
 * (DASHBOARD_MANUAL_SYNC_SHOWN_MS): "Checked just now — no new files",
 * "Checked 3m ago — 12 new files, reading them now". While the press's sync
 * still runs: "Checking Dropbox…". Never provider text.
 */
export function dashboardManualSyncLine(
  source: Pick<DashboardSourceCard, 'label' | 'family' | 'last_manual_sync'> & { sync_name?: DashboardSyncName },
  now: Date,
): string | undefined {
  const name = source.sync_name ?? source.label;
  const sync = source.last_manual_sync;
  if (!sync) return undefined;
  const at = Date.parse(sync.at);
  if (!Number.isFinite(at)) return undefined;
  const elapsed = now.getTime() - at;
  const when = elapsed < 60_000 ? 'just now' : dashboardRelativeFromMs(elapsed);
  switch (sync.outcome) {
    case 'checking':
      return dashboardManualSyncPendingLine(name);
    case 'busy':
      return dashboardManualSyncBusyLine(name);
    case 'failed':
      return dashboardManualSyncFailedLine(source.label, sync.failure_kind, sync.failure_kind === 'unknown' ? sync.failure_ref : undefined, when, source.sync_name);
    case 'checked': {
      const found = sync.new_items;
      if (found === undefined) return `Checked ${when}`;
      if (found <= 0) return `Checked ${when} — no new ${dashboardItemNoun(source)}`;
      return `Checked ${when} — ${itemsPhrase(source, found, 'new')}, reading them now`;
    }
    default:
      return undefined;
  }
}

/**
 * True when Olympus parked this lane itself, off the card's own schedule.
 *
 * `degraded_reason` only — the marker the scheduler is carrying right now.
 * `last_error_kind` is what the lane was doing before a guard stopped it, and
 * the view model already refuses to let that stale kind speak for the pause.
 */
export function dashboardOperatorPaused(source: DashboardSourceCard): boolean {
  const reason = source.schedule?.degraded_reason;
  return reason !== undefined && OPERATOR_PAUSED_SCHEDULER_MARKERS.has(reason);
}

/**
 * True when a scheduled sync on this card keeps failing and nothing Olympus
 * paused itself explains it — the one predicate home, the page header, the
 * source banner and the background page read (owner-reported, 2026-09-24).
 * `failing_tasks` is the worker's count; see dashboardSchedulerTaskFailing.
 */
export function dashboardSyncKeepsFailing(source: DashboardSourceCard): boolean {
  return (source.queue_health.failing_tasks ?? 0) > 0 && !dashboardOperatorPaused(source);
}

/**
 * The one line under a working source's name.
 *
 * Owner ruling, 2026-08-23/24, superseding the 2026-08-21 phrasing guard: the
 * exclusion count must not sit beside the percentage ANYWHERE he looks, and
 * this card is one of those places. So the ratio leads and
 * `not_read_by_policy_items` is gone from this line entirely — its home is the
 * detail page's foot, one click away, where it reads as the footnote it is
 * rather than as a competing headline.
 *
 * What the old pairing was defending is still defended, by a stricter rule.
 * "100% answer-ready" used to need the exclusion clause beside it or a reader
 * would take it for "all of it"; now the percentage divides by the in-scope
 * population and a bare 100% is refused unless the corpus is genuinely
 * finished — every in-scope file read AND its chunks embedded on the current
 * epoch. A corpus with a re-embed backlog prints the second number instead of
 * a 100 that would be a lie, which is a guarantee the old clause never gave.
 *
 * Owner ruling, 2026-08-24 design session: the home card LEADS with the working
 * percentage. `first ingest` used to lead — it is a phase and not a competing
 * number, which was the argument for putting it first — but the card is scanned
 * for one thing across a grid of sources, and that thing is the percentage. The
 * phase clause keeps its place immediately after, where it still qualifies the
 * ratio before the reader acts on it.
 */
function workingLine(source: DashboardSourceCard): string {
  const parts: string[] = [];
  const firstIngest = source.freshness.label === DASHBOARD_FIRST_SYNC_FRESHNESS_LABEL ? 'first sync' : undefined;
  const readyWhileUpdating = source.answer_readiness.state === 'ready'
    && source.coverage.indexed_items > 0
    && (source.connection.state === 'syncing' || source.queue_health.active > 0 || source.queue_health.waiting > 0);
  const summary = dashboardWorkingSummary(source);
  if (readyWhileUpdating) {
    parts.push('Ready · updating new material');
  } else if (summary) {
    // Whole percent on the card, one decimal on the detail page: the card has a
    // line's worth of room and the reader is scanning several of them.
    parts.push(`${Math.round(summary.read_percent)}% answer-ready`);
    // The half that is not a per-file ratio. Printed only when parity is short,
    // which is exactly when the first number alone would overstate.
    if (summary.searchable_percent !== undefined) {
      parts.push(`${Math.round(summary.searchable_percent)}% searchable`);
    }
  } else if (source.coverage.indexed_items > 0) {
    // Nothing in scope at all. This states a fact and quotes no count, so it
    // survives the ruling above unchanged.
    parts.push(dashboardNoneReadSentence(source.family));
  }
  if (firstIngest) parts.push(firstIngest);
  if (!readyWhileUpdating && source.coverage.indexed_items > 0) parts.push(`${dashboardCount(source.coverage.indexed_items)} indexed`);
  const eta = source.progress?.eta_minutes;
  if (typeof eta === 'number' && Number.isFinite(eta) && eta > 0) {
    parts.push(`~${dashboardDuration(eta * 60)} left`);
  }
  const unreadable = dashboardUnreadablePhrase(source);
  if (unreadable) parts.push(unreadable);
  return parts.join(' · ');
}

function waitingLine(source: DashboardSourceCard): string {
  const awaiting = dashboardCaptureAwaitingClause(source);
  if (awaiting) {
    const clause = dashboardCaptureClause(source);
    return clause ? `${awaiting} · ${clause}` : awaiting;
  }
  if (dashboardScopePending(source)) {
    return source.scope_selection?.kind === 'mail' ? 'choose which mail to include' : 'choose which folders to include';
  }
  if (source.connection.state === 'waiting_for_first_sync') return 'waiting for the first sync';
  const queued = source.queue_health.waiting + source.queue_health.active;
  if (queued > 0) return `${dashboardCount(queued)} in queue`;
  return '';
}

function degradationClause(degradation: WorkerCredentialDegradation): string {
  switch (degradation.state) {
    case 'retrying':
      return `retrying (${dashboardCount(degradation.attempts)} of ${dashboardCount(degradation.max_attempts)})`;
    case 'stopped':
      return 'retries stopped';
    case 'resolved_restart_required':
      return 'fixed · restart Olympus to use it';
    default:
      return '';
  }
}

/**
 * Matches a worker-level credential failure to the card it belongs to.
 *
 * Name-based because display_name is the only identifier the degradation
 * carries. `family` is deliberately not in the candidate set: it holds values
 * like 'email' and 'file' that several cards share, and a shared name would
 * light up every one of them.
 */
/**
 * The worker credential degradation that names this source, if any: matched by
 * label, provider, source id or its family prefix, case- and punctuation-blind.
 * The one match both dashboards make (shared-status.ts reads it too); the name
 * is matched, never printed.
 */
export function dashboardDegradationForSource(
  source: DashboardSourceCard,
  degraded: readonly WorkerCredentialDegradation[] | undefined,
): WorkerCredentialDegradation | undefined {
  if (!degraded || degraded.length === 0) return undefined;
  const candidates = new Set([
    normalizeName(source.label),
    normalizeName(source.provider),
    normalizeName(source.source_id),
    normalizeName(source.source_id.split('.')[0] ?? ''),
  ]);
  candidates.delete('');
  return degraded.find((entry) => candidates.has(normalizeName(entry.display_name)));
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function resolveDegraded(
  view: SourceDashboardViewModel,
  options: DashboardVocabularyOptions | undefined,
): readonly WorkerCredentialDegradation[] | undefined {
  return options?.degradedCredentials ?? view.degraded_credentials;
}

// The option is optional, not nullable, so an absent list is an absent key.
function degradedInput(
  degraded: readonly WorkerCredentialDegradation[] | undefined,
): Pick<DashboardStatusInput, 'degradedCredentials'> {
  return degraded ? { degradedCredentials: degraded } : {};
}

function unknownStatus(value: string): DashboardStatusResolution {
  return { status: DASHBOARD_UNKNOWN_STATUS, mappedUnknown: true, unknownValue: value };
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/**
 * Sentences the ChatGPT dashboard's producer composes into the view model
 * (src/workers/chatgpt/dashboard-view-model.ts). Same keys the producer used
 * while they were pending there; every value is a fixed string.
 */
export const DASHBOARD_CHATGPT_VOCABULARY = {
  installingNoSource: 'Connect a source to begin',
  installingModel: 'Getting search ready on your computer',
  installingFirstIndex: 'Indexing your sources for the first time',
  connectOnMac: 'Connect sources in Olympus on your computer.',
  reconnect: 'Reconnect',
  checkAgain: 'Check again',
  openOnMac: 'Open Olympus on your computer',
  stageReading: 'Reading',
  stageSearchable: 'Indexing',
  embeddingNeedsAttention: 'Search has stopped working on your computer.',
  answerModelNeedsAttention: 'Answers have stopped working on your computer.',
  /**
   * A built-in model whose install failed, by its fixed failure code
   * (ModelInstallFailedReason); the item's fix starts the install again.
   */
  modelInstallFailed: {
    embedding: {
      disk_full: 'Couldn\'t download the search model: the disk is full.',
      network: 'Couldn\'t download the search model: the network dropped.',
      checksum: 'Couldn\'t download the search model: the download was damaged.',
      unknown: 'Couldn\'t download the search model.',
    },
    answers: {
      disk_full: 'Couldn\'t download the private model: the disk is full.',
      network: 'Couldn\'t download the private model: the network dropped.',
      checksum: 'Couldn\'t download the private model: the download was damaged.',
      unknown: 'Couldn\'t download the private model.',
    },
  },
  /** After a disk-full install failure: how much to free, then the item's own Try again. */
  diskFreeUp: 'Free up {size}, then Try again.',
  diskFreeUpUnknown: 'Free up some space, then Try again.',
  fixOnMac: 'Open Olympus on your computer to fix this.',
  privateMatches: 'Some matching items are private and stay on your computer.',
  changeModelsOnMac: 'Change models in Olympus on your computer.',
  /**
   * A working Google connection made before sign-in moved onto the computer
   * (2026-10-13). Optional: the row's Reconnect Google switches it.
   */
  googleSigninMoved: 'Google sign-in now happens on your computer. Reconnect once to switch.',
  reconnectGoogle: 'Reconnect Google',
  /**
   * A Google sign-in in progress while Olympus runs on a server: Google
   * returns to the server's loopback, which a browser elsewhere reaches only
   * through the SSH tunnel; otherwise the address is pasted on the server.
   */
  googleConnectingOnServer: 'Waiting for you to finish signing in… If Google ends on a page that does not load, copy its address and run olympus connect finish \'<address>\' on the server.',
} as const;

/**
 * A provider refusal as the ChatGPT dashboard words it, by the refusal's kind.
 * ChatGPT has no How to fix sheet, and its owner signs in through Olympus's own
 * apps (no app settings of their own to fix), so every refusal points at the
 * row's Reconnect. `line` is the reason half after "<Source> — "; `sentence`
 * stands alone. A declined sign-in already reads as a retry on both
 * dashboards, so it keeps the shared words. The local dashboard keeps its own
 * words for the rest (dashboardProviderRefusalLine).
 */
export const DASHBOARD_CHATGPT_REFUSAL_COPY = {
  line: {
    address: 'sign-in didn\'t go through — try Reconnect',
    declined: 'sign-in was declined — connect again to retry',
    unfinished: 'didn\'t finish signing in — try Reconnect',
  },
  sentence: {
    address: (source: string) => `${source} sign-in didn't go through. Try Reconnect.`,
    declined: (source: string) => `${source} sign-in was declined. Connect again to retry.`,
    unfinished: (source: string) => `${source} didn't finish signing in. Try Reconnect.`,
  },
} as const;

/**
 * The ChatGPT dashboard's own copy for the five connection states. The view
 * model carries only the state; the page owns these words (the relay renders
 * two of the states without reading this file). `disabledReason` is printed
 * beside every other control while the state holds.
 */
export const DASHBOARD_CHATGPT_CONNECTION_COPY = {
  /**
   * No Olympus link for this ChatGPT account. The relay cannot tell an owner
   * who has not linked yet from one with no install, so the page offers
   * Connect first and the install link beside it.
   */
  not_connected: {
    title: 'Olympus isn\'t connected to ChatGPT yet',
    disabledReason: 'Connect Olympus first',
    install: 'Not installed yet?',
  },
  /** Linked to this ChatGPT account, first-run setup (models, first index) not finished. */
  installing: {
    title: 'Olympus is setting up on your computer…',
    disabledReason: 'Available once Olympus is set up',
  },
  mac_offline: {
    title: 'Your computer is offline or asleep, so answers are paused',
    lastSeen: 'Last seen {when}',
    disabledReason: 'Your computer is offline',
  },
  relay_unavailable: {
    title: 'Olympus can\'t reach your computer right now.',
    disabledReason: 'Can\'t reach your computer',
    /**
     * Behind the banner's See why: what the last failed read got back
     * (owner rule, 2026-10-10). `error` quotes Olympus's own fixed sentence,
     * `host` the chat app's own error message, capped.
     */
    why: {
      no_answer: 'Olympus didn\'t answer within {seconds} seconds.',
      error: 'Olympus answered with an error: {text}',
      unreadable: 'Olympus answered with something this page can\'t read.',
      host: 'The connection to Olympus failed: {text}',
      at: 'Last tried {when}.',
    },
  },
  /** Labels for `connection.action.id`; `help` is shown as text when the action has no link. */
  actions: {
    /** Re-reads the dashboard, whose result carries ChatGPT's own connect prompt. */
    connect: { label: 'Connect Olympus', help: '' },
    open_olympus: { label: 'Open Olympus on your computer', help: 'Open Olympus on your computer, then check again here.' },
    wake_mac: {
      label: 'How to keep it available',
      help: 'Keep your computer on, awake and online with Olympus running. Answers resume on their own when it is back.',
    },
    retry: { label: 'Try again', help: '' },
  },
} as const;

/** Every other word the ChatGPT dashboard page prints. */
export const DASHBOARD_CHATGPT_PAGE_COPY = {
  title: 'Olympus',
  loading: 'Checking your computer…',
  upToDate: 'Olympus is up to date.',
  needsYou: 'Needs you',
  sources: 'Sources',
  sourcesLocal: 'On your computer',
  sourcesCloud: 'Accounts',
  notConnected: 'Not connected',
  noSources: 'No sources yet.',
  /**
   * The Archives card, in its own section below Sources (owner, 2026-10-25):
   * exports that are not from one of the sources above. A source's own
   * exports are imported from its card's ⋯ menu (Import an archive).
   */
  otherArchives: { title: 'Other archives', line: "For an export that isn't from one of your sources above." },
  progress: 'Progress',
  progressInitial: 'First index',
  progressRefresh: 'Catching up',
  percentDone: '{percent}% done',
  left: '{count} {unit} left',
  eta: 'about {duration}',
  stalled: 'stalled',
  progressPaused: 'paused while your computer is offline',
  details: 'Details',
  stageLine: '{stage}: {done} of {total} {unit}',
  models: 'Models',
  modelSearch: 'Search',
  modelAnswers: 'Answers',
  modelBuiltIn: 'Built-in',
  modelCustom: 'Custom',
  modelReady: 'Ready',
  modelDownloading: 'Downloading {percent}%',
  modelNotWorking: 'Not working',
  modelNotReady: 'Not ready',
  modelGettingReady: 'Getting ready',
  modelNeedsYou: 'Needs you',
  modelChecking: 'Checking',
  /** The install lines under the Models summary; {model} is one of modelNames. */
  modelNames: { search: 'the search model', answers: 'the private model', transcription: 'the transcription model' },
  /** The built-in transcription model's line in Models (models.transcription). */
  modelTranscription: 'Transcription',
  /** Not installed because the chosen sources hold no audio: nothing to download yet. */
  modelNotNeededNoAudio: 'Not needed: no audio in your chosen folders',
  /** Starts the transcription model's download ahead of any audio, or again after a failure. */
  modelDownloadNow: 'Download now',
  /** No readable record that this model is on disk (an unreadable or older status file). */
  modelNotDownloaded: 'Not downloaded',
  /** A download that stopped part way (the engine restarted mid-download). */
  modelDownloadInterrupted: 'Download stopped before it finished',
  /** Downloaded, but it would not start. */
  modelCouldNotStart: 'Couldn\'t start {model}',
  /** The same, with why (modelLoadFailedReasons). */
  modelCouldNotStartBecause: 'Couldn\'t start {model}: {reason}',
  modelLoadFailedReasons: {
    not_installed: 'its files are missing or incomplete; Download now fetches them again',
    stopped_while_starting: 'it stopped while starting',
    too_slow: 'it took too long to start',
    port_taken: 'another program was using the port it needs',
    unknown: 'Olympus\'s log on the computer has the details',
  } satisfies Record<ModelLoadFailedReason, string>,
  /** A model whose download failed, on its own line in Models: "Not working: the disk is full". */
  modelNotWorkingBecause: 'Not working: {reason}',
  modelInstallDownloading: 'Downloading {model}',
  modelInstallVerifying: 'Checking {model}…',
  modelInstallFailed: 'Couldn\'t download {model}: {reason}',
  modelInstallBytes: '{done} of {total}',
  modelInstallReasons: {
    disk_full: 'the disk is full',
    network: 'the connection dropped',
    checksum: 'the download was damaged',
    unknown: 'something went wrong',
  },
  synced: 'Synced {when}',
  updated: 'Updated {when}',
  checkAgain: 'Check again',
  tryAgain: 'Try again',
  openOlympus: 'Open Olympus',
  moreActions: 'More actions for {source}',
  confirmPrompt: 'Are you sure?',
  confirm: 'Yes, {label}',
  cancel: 'Cancel',
  working: 'Working…',
  justNow: 'just now',
  minutesAgo: '{n} min ago',
  hoursAgo: '{n} hr ago',
  daysAgo: '{n} days ago',
  dayAgo: '1 day ago',
  durationMinutes: '{n} min',
  durationHours: '{n} hr',
  durationHoursMinutes: '{h} hr {m} min',
  durationDays: '{n} days',
  durationLessThanMinute: 'less than a minute',
  units: {
    files: { one: 'file', many: 'files' },
    messages: { one: 'message', many: 'messages' },
    items: { one: 'item', many: 'items' },
  },
  /** A source's progress bar: its first unfinished stage. */
  sourceStages: { listing: 'Finding items', reading: 'Reading', indexing: 'Indexing' },
  findingItems: 'Finding items',
  /** Before a total is known, what is: no percentage, only the count so far. {unit} is plural. */
  findingFound: 'Finding {unit} · {done} found so far',
  sourceProgress: '{stage} — {percent}%, {done} of {total} {unit}',
  /**
   * The page-wide progress line names what stopped instead of a bare
   * "stalled" (2026-10-10): "Dropbox paused", "Dropbox and Gmail paused",
   * "Dropbox, Gmail and 2 more paused".
   */
  stalledSources: '{sources} paused',
  stalledAnd: '{first} and {last}',
  stalledMore: '{count} more',
  /**
   * Behind a stalled row's See why (owner rule, 2026-10-10): why, from the
   * engine's closed words, then when it last worked and when it tries again.
   */
  sourceFailures: DASHBOARD_SOURCE_FAILURE_WORDS,
  failureRef: DASHBOARD_FAILURE_REF,
  failureLog: DASHBOARD_FAILURE_LOG,
  stallWhy: {
    failedOnce: 'The last try failed.',
    failedMany: 'The last {count} tries failed.',
    switchedOff: '{stage} is turned off in Olympus\'s settings.',
    stillFor: '{stage} hasn\'t moved for {duration}.',
    still: '{stage} hasn\'t moved for a while.',
    lastWorked: 'Last worked {when}.',
    nextTry: 'Olympus tries again in {duration}.',
    watchLog: 'Olympus\'s log on the computer shows what it is doing.',
  },
  /** One plain sentence per stalled reason; {source} is the source's name. */
  stalledReasons: {
    waiting_for_credentials: 'Paused: Olympus needs you to sign in to {source} again',
    scope_pending: 'Paused until you choose folders',
    scope_root_missing: DASHBOARD_MISSING_FOLDER,
    scope_root_permission_needed: DASHBOARD_FOLDER_NEEDS_PERMISSION,
    scope_root_helper_needed: DASHBOARD_FOLDER_NEEDS_HELPER,
    scope_root_unreadable: DASHBOARD_FOLDER_UNREADABLE,
    provider_unavailable: 'Paused: {source} isn\'t responding; Olympus will retry',
    model_downloading: 'Waiting for the search model to finish downloading',
  },
  linkExpires: 'link expires in {n} min',
  linkExpired: 'link expired',
  /**
   * Beside a control only the computer can act on: the olympusplugin.ai open
   * page. "Fix" only beside a real problem (Needs you, the blocker); "Do"
   * wherever nothing is broken (Models' Change, a Connect).
   */
  howOnComputer: 'Do this on your computer',
  howOnComputerFix: 'Fix this on your computer',
  /**
   * The panel's last line away from the computer (owner request, 2026-10-12):
   * the controls only the computer's On this computer section has, with Open
   * on the olympusplugin.ai page that opens Olympus there.
   */
  moreOnComputer: 'More controls on your computer: Private answers, anonymous answers, keys and agents',
  moreOnComputerOpen: 'Open',
  moreOnComputerOpenLabel: 'Open Olympus on your computer',
  /**
   * Remote mode (2026-10-10; core/remote-open.ts): the engine runs on a
   * server, so a "do this on your computer" control opens this box instead of
   * the olympus:// page. The two command lines are built from the engine's
   * port and the owner's own SSH name (remoteOpenInstructions).
   */
  remote: {
    title: 'Olympus runs on a server, so this opens on your computer through a secure tunnel.',
    askLine: 'Ask your assistant:',
    askPhrase: 'Open Olympus on my computer',
    askPhraseFor: 'Open Olympus on my computer to connect {source}',
    byHandAfterAsk: 'Or do it yourself:',
    onComputer: 'On your computer, run:',
    onServer: 'Then on the server, run this and open the link it prints in your computer\'s browser:',
    portNote: 'Keep {port} on both sides of the tunnel: the link only works on that port.',
    copy: 'Copy',
    copied: 'Copied',
    copySelected: 'Selected: press Ctrl+C or ⌘C to copy',
  },
  /** A source that is not moving and whose reason the engine did not send (never a blank row). */
  sourcePaused: 'Paused',
  /**
   * Sync now, pressed (2026-10-09): the control while its sync runs, and the
   * row's line until the dashboard's next read says the same ("Checking
   * Dropbox…", dashboardManualSyncPendingLine). The result line after it is
   * the engine's own (dashboardManualSyncLine), the same on both surfaces.
   */
  syncChecking: 'Checking…',
  /**
   * Delete indexed data (owner, 2026-10-23), for a source that is already
   * disconnected. The confirmation says what goes and what does not, in the
   * user's words; {source} is the source's name. Disconnect's confirmation
   * tells the reader the indexed data stays and can be deleted afterwards.
   */
  deleteDataConfirm: 'Delete indexed data for {source}? Olympus removes everything it indexed from {source} on this computer: search results, summaries and its privacy records. Your files and accounts are not touched. This cannot be undone.',
  /**
   * The same, for a source where Olympus also keeps its own copy of the raw
   * messages outside the search index: the delete removes those too, so the
   * confirmation says it. Chosen by the Fix's `deletesCopies`, never by name.
   */
  deleteDataConfirmMessages: 'Delete indexed data for {source}? Olympus removes everything it indexed from {source} on this computer: search results, summaries and its privacy records, and also its own copies of your messages. Your {source} account and the messages in the app are not touched. This cannot be undone.',
  deleteDataConfirmMessagesMedia: 'Delete indexed data for {source}? Olympus removes everything it indexed from {source} on this computer: search results, summaries and its privacy records, and also its own copies of your messages, voice notes and media. Your {source} account and the messages in the app are not touched. This cannot be undone.',
  /**
   * Added to that confirmation, on the computer, for a source with archives
   * imported into it: their items are the source's own, so the delete takes
   * them too, and the person's archive files are not touched. {source} is the
   * source's name.
   */
  deleteDataImports: 'Archives you imported into {source} are part of it: their history goes too, and the archive files themselves stay where they are.',
  deleteDataDone: 'Indexed data deleted',
  disconnectConfirm: 'Disconnect {source}? Olympus stops reading it. What it already indexed stays on this computer until you delete it.',
  syncCheckingLine: dashboardManualSyncPendingLine('{source}'),
  /**
   * The disclosure under a row whose files can't be read: counts and
   * reasons, then the files' names (owner ruling, 2026-10-10); on the
   * computer each name opens its file.
   */
  seeWhy: 'See why',
  unreadableMore: DASHBOARD_UNREADABLE_MORE,
  /** The accessible name of an unreadable file's open control: "Open report.pdf". */
  unreadableOpen: 'Open {name}',
  unreadableReasons: DASHBOARD_UNREADABLE_REASON_WORDS,
  unreadableNote: DASHBOARD_UNREADABLE_NOTE,
  unreadableNoteMany: DASHBOARD_UNREADABLE_NOTE_MANY,
} as const;

/**
 * What the same panel adds when the computer itself hosts it (unified
 * dashboard phase 4, design signed off by Jamie 2026-10-09): the one "On this
 * computer" section, the locked-controls reason, and Index faster under
 * Progress → Details. Nothing else on the page has words of its own here.
 */
/** Opening-link handoff for the host-owning agent; never request a durable secret. */
export const DASHBOARD_WORKER_TOKEN_AGENT_PROMPT =
  'Open the Olympus dashboard for me with its controls ready. On the machine hosting Olympus, '
  + 'resolve the installed plugin rootDir yourself with `openclaw plugins inspect olympus --json`, '
  + 'run `<rootDir>/bin/olympus dashboard --no-open`, and give me the new opening link. '
  + 'Do not read or print the worker token. Do not change configuration or connect sources.';

/**
 * The computer host page's banner while the local controls are locked. It
 * leads with the one-click `olympus://open/dashboard` link (the browser asks
 * first, then Olympus opens an unlocked dashboard); the terminal command is
 * the fallback line, and an agent's opening link or a worker token sit behind
 * "Other ways". It is the only place the locked state is explained: the
 * panel's controls are disabled without a reason of their own.
 */
export const DASHBOARD_HOST_GATE_COPY = {
  title: 'Dashboard controls are locked',
  open: 'Open dashboard controls',
  /** Before and after the command, which renders as code. */
  fallbackBefore: 'or run ',
  fallbackCommand: 'olympus dashboard',
  fallbackAfter: ' in a terminal',
  button: 'Other ways',
  how: 'Ask your agent for a fresh opening link: copy this request to it, then open the link it gives you. The link works once and expires after fifteen minutes.',
  copy: 'Copy prompt',
  copied: 'Copied',
  copyFailed: 'Select the text and copy it.',
  advanced: 'Advanced: use a worker token',
  tokenField: 'Worker token',
  unlock: 'Unlock',
  unlocking: 'Unlocking…',
  pasteToken: 'Paste the worker bearer token.',
  readToken: 'That is the read-only view token; use the worker bearer token from setup.',
  refused: 'That token was not accepted.',
  /** Beside the panel when the browser kept a page the panel opened (a sign-in) from opening. */
  openBlocked: 'Your browser did not open the page.',
  openBlockedLink: 'Open it',
} as const;

/**
 * The Archives row on the computer (archive-import/dashboard.ts): Import an
 * archive, each imported archive and its state, and the imports waiting on
 * the person. Names and folders are the person's own; they appear only
 * beside these words, on the computer.
 */
/**
 * The drop screen's opening sentence, from what each registered format says
 * about the export it reads, so a new format is offered without editing this
 * file. Olympus copies what is dropped into its own storage to read it, and
 * says so.
 */
export function archivePickIntro(formats: readonly { label: string; chooseHint?: string }[] = ARCHIVE_FORMATS): string {
  return `Drop a file or folder from this computer: ${
    formats.map((format) => format.chooseHint ?? format.label).join('; or ')
  }. Olympus keeps a copy in its own storage to read it until you remove the import, and never changes the original.`;
}

const ARCHIVE_PICK_INTRO = archivePickIntro();

export interface DashboardArchiveNouns {
  readonly one: string;
  readonly many: string;
  readonly none: string;
  readonly plural: string;
  /**
   * Said beside the archive's dates when its family's exports are a copy of
   * a conversation as it was on the day it was exported: later messages are
   * not added. Empty for a family whose archives are not.
   */
  readonly snapshot: string;
}

/**
 * What an archive's items are called, by the family of the format that made
 * them (`family` of the archive's entry). A family with no entry says items.
 */
export const DASHBOARD_ARCHIVE_NOUNS: Readonly<Record<'email' | 'chat' | 'note' | 'other', DashboardArchiveNouns>> = {
  email: { one: '1 message', many: '{n} messages', none: 'no messages', plural: 'messages', snapshot: '' },
  chat: { one: '1 message', many: '{n} messages', none: 'no messages', plural: 'messages', snapshot: 'Snapshot, not updated' },
  note: { one: '1 note', many: '{n} notes', none: 'no notes', plural: 'notes', snapshot: '' },
  other: { one: '1 item', many: '{n} items', none: 'no items', plural: 'items', snapshot: '' },
};

/** The nouns for an archive's family, or the neutral ones. */
export function dashboardArchiveNouns(family: unknown): DashboardArchiveNouns {
  const nouns: Readonly<Record<string, DashboardArchiveNouns>> = DASHBOARD_ARCHIVE_NOUNS;
  return typeof family === 'string' && Object.prototype.hasOwnProperty.call(nouns, family) ? nouns[family]! : DASHBOARD_ARCHIVE_NOUNS.other;
}

export const DASHBOARD_ARCHIVE_COPY = {
  /** The Other archives section's button: any export, routed to its source when one reads it. */
  importAction: 'Import another archive',
  /**
   * A source's own ⋯ menu entry: the picker for that source's exports only
   * (`ComputerArchiveSourceMeta`). {source} is the source's name.
   */
  sourceImport: { action: 'Import an archive', title: 'Import an archive into {source}' },
  /**
   * The Import screen: a drop zone for one folder (or one file), uploaded to
   * Olympus's own storage and imported from there (owner decision 2026-10-26).
   * No size limit; the upload waits when this computer runs low on space.
   */
  pick: {
    back: 'Back to Olympus',
    title: 'Import another archive',
    /** Any export: one of a source's own still joins that source (start.ts), so the line says where each goes. */
    intro: `${ARCHIVE_PICK_INTRO} An export from one of your sources joins that source; any other is kept under Other archives.`,
    zone: 'Upload folder',
    over: 'Drop to import',
    hint: 'Drag a folder here, or click to choose one.',
    zoneLabel: 'Upload folder: choose a folder, or drop one here',
    chooseFile: 'or choose a file',
    reading: 'Reading the folder…',
    uploading: 'Uploading {name}',
    progress: '{sent} of {total}',
    progressFiles: '{sent} of {total} · {files} of {of} files',
    paused: 'This computer is low on space. The upload waits and goes on by itself when space is free.',
    cancel: 'Cancel',
    starting: 'Starting…',
    empty: 'There was no file in that. Drop a folder or a file from this computer.',
    unreadable: 'Olympus could not read what you dropped. Try again.',
    failed: 'The upload stopped before it finished. Nothing was imported. Try again.',
    several: '{n} items',
    chooseAnother: 'Start over',
  },
  listLabel: 'Imported archives',
  status: { importing: 'Importing', imported: 'Imported', stopped: 'Stopped', removing: 'Removing', notRunning: 'Not running' },
  dates: '{earliest} to {latest}',
  nouns: DASHBOARD_ARCHIVE_NOUNS,
  importingLine: '{percent}% read · {items} so far',
  importingLineUncounted: '{percent}% read',
  importedLine: '{items} · imported {when}',
  importedLineNoTime: '{items}',
  /**
   * A finished import that found nothing at all (no items, nothing left out,
   * nothing it could not read): said as that, never as a count of nothing and
   * never as an index that cannot be read. {none} is "no notes".
   */
  emptyImport: 'Imported: {none} found in this archive.',
  emptyImportWhen: 'Imported {when}: {none} found in this archive.',
  /**
   * A finished import that stored nothing although the archive held things it
   * left out or could not read: never said as an empty archive, and the
   * reasons stay under the See button. {None} is "No notes".
   */
  nothingImported: '{None} imported.',
  nothingImportedWhen: '{None} imported {when}.',
  removingLine: 'Removing everything Olympus made from this archive. The file itself stays where it is.',
  /** An import or a removal this computer's settings keep from running: no progress bar, nothing moving. */
  notRunningLine: '{percent}% read · {items} so far. It goes on from there once imports can run.',
  notRunningLineUncounted: '{percent}% read. It goes on from there once imports can run.',
  removingNotRunningLine: 'It is removed once removals can run. The file itself stays where it is.',
  judgedLine: '{judged} judged · {held} waiting for the private model',
  heldWhy: {
    ready: 'Until the private model judges them, they stay Private.',
    waiting: 'They stay Private until the private model judges them, and it is not answering right now.',
    off: 'No private model is set up, so they stay Private and are not judged.',
  },
  setUpPrivateModel: 'Set up the private model',
  /** An archive whose index cannot be opened now: never shown as empty. */
  countsUnavailable: {
    why: "Olympus can't count what this archive holds right now: its index could not be opened.",
    fix: 'Open this page again in a minute. If it still says this, restart Olympus, or ask for help at olympusplugin.ai/support.',
  },
  /**
   * See why under the Archives row while this computer's settings keep
   * imports and removals from running: the plain reason, then the setting.
   */
  notRunning: {
    why: {
      disabled: "Background syncing is turned off in Olympus's settings, so imports can't run.",
      not_selected: "Background syncing in Olympus's settings leaves out archives, so imports can't run.",
    },
    fix: {
      disabled: 'The setting is worker.scheduler.enabled: turn it on, and restart Olympus after changing it. Each import and removal goes on from where it is.',
      not_selected: 'The setting is worker.scheduler.sourceIds: add archive.imports to it, or empty it, and restart Olympus after changing it. Each import and removal goes on from where it is.',
    },
  },
  /** Beside Remove, shown but not pressable, while removals cannot run. */
  removeNotRunning: {
    disabled: "Remove can't run while background syncing is turned off.",
    not_selected: "Remove can't run while background syncing leaves out archives.",
  },
  stopped: {
    file_changed: { why: '{file} changed after the import started.', fix: 'Remove this archive, then import the file again once it has stopped changing.' },
    file_missing: { why: '{file} is no longer where it was.', fix: 'Remove this archive, then import it again from where it is now.' },
    file_unreadable: { why: 'Olympus could not read {file}.', fix: 'Check that your user account can open it, then remove this archive and import it again.' },
    resume_point_invalid: { why: 'Olympus lost its place in this archive.', fix: 'Remove this archive and import it again.' },
    format_unavailable: { why: 'This version of Olympus cannot read this kind of archive.', fix: 'Update Olympus, or remove this archive.' },
    root_changed: { why: 'The folder it was in was moved or replaced.', fix: 'Remove this archive, then import it again from where it is now.' },
    other: { why: 'The import stopped.', fix: 'Remove this archive and import it again.' },
  },
  /** A file of the archive, when the stop names none. */
  thisFile: 'A file of this archive',
  /**
   * An export of a source Olympus already reads, whose account the export does
   * not prove is the connected one: the import sheet asks, and nothing is
   * imported until the person answers.
   */
  account: {
    line: '{name} does not say which {source} account it came from. Is it the {source} account Olympus has connected?',
    note: 'Added to {source}, it joins what Olympus already reads there, and anything {source} already has is not added twice. Kept under Other archives, it stays apart, with its own Remove.',
    add: 'Add to {source}',
    apart: 'Keep it under Other archives',
    addFor: 'Add {name} to {source}',
    apartFor: 'Keep {name} under Other archives',
    sourceFallback: 'this source',
    /** The same question for an import already inside a source, stopped because the source now holds another account. */
    reconfirm: {
      line: '{source} now holds a different account than the one you said {name} belongs to. Is {name} from the {source} account Olympus has connected now?',
      note: 'To keep it apart instead, delete this import from the {source} card, then import it again under Other archives.',
    },
  },
  /**
   * An import that is one input of a source, inside that source's card: its own
   * progress and findings, how much of it the source already had, and Stop.
   * It has no Remove: its items are the source's, deleted with the whole source.
   */
  inSource: {
    listLabel: 'Imported archives',
    importingLine: '{percent}% read · {items} from this archive so far',
    importingLineNone: '{percent}% read',
    importedLine: '{items} from this archive',
    importedWhen: ' · imported {when}',
    /** Appended to a count line when the source already had some of the archive's items. */
    alreadyThere: { one: ', of which 1 was already there', many: ', of which {n} were already there' },
    notRunningLine: '{percent}% read. It goes on from there once imports can run.',
    stop: 'Stop',
    stopped: 'Stopped {name}. What it imported stays.',
    /** What the card says about the history its inputs cover. */
    covers: { imported: 'History imported up to {to}', live: 'live since {since}' },
    /** Why an import stopped and what to do: none of them has a Remove, so each says how to go on. */
    stoppedWhy: {
      stopped_by_owner: { why: 'You stopped this import. What it imported stays.', fix: 'To go on from here, choose the same file again with Import an archive.' },
      file_changed: { why: '{file} changed after the import started.', fix: 'Choose the file again with Import an archive once it has stopped changing. What is already here is not added twice.' },
      file_missing: { why: '{file} is no longer where it was.', fix: 'Choose it again with Import an archive from where it is now. What is already here is not added twice.' },
      file_unreadable: { why: 'Olympus could not read {file}.', fix: 'Check that your user account can open it, then choose it again with Import an archive.' },
      resume_point_invalid: { why: 'Olympus lost its place in this archive.', fix: 'It cannot go on from here, and choosing the file again does not change that. What it imported stays; deleting the source removes it with the rest of its history.' },
      format_unavailable: { why: 'This version of Olympus cannot read this kind of archive.', fix: 'Update Olympus, then choose the file again with Import an archive.' },
      root_changed: { why: 'The folder it was in was moved or replaced.', fix: 'Choose it again with Import an archive from where it is now. What is already here is not added twice.' },
      account_changed: { why: 'The account this source holds now is not the one this export belongs to, so nothing more was imported.', fix: 'What it imported stays. To import it into the account it belongs to, connect that account first, then choose the file again with Import an archive.' },
      source_unavailable: { why: 'This source was being deleted or moved, so nothing more was imported.', fix: 'Once that has finished, choose the file again with Import an archive if you still want it.' },
      other: { why: 'The import stopped.', fix: 'Choose the file again with Import an archive. What is already here is not added twice.' },
    },
  },
  /**
   * One sentence for each kind of finding an archive reports. Which of the two
   * lists a kind is shown in (`lists`) is `listOf`, directly below.
   */
  gaps: {
    message_too_large: { one: '1 message too large to read', many: '{n} messages too large to read' },
    message_unreadable: { one: '1 message could not be read', many: '{n} messages could not be read' },
    message_content_unsupported: { one: '1 message with a kind of content Olympus cannot read yet', many: '{n} messages with a kind of content Olympus cannot read yet' },
    charset_not_decoded: { one: '1 message in a character set Olympus could not read', many: '{n} messages in a character set Olympus could not read' },
    attachments_not_read: { one: '1 attachment not read (its name is kept)', many: '{n} attachments not read (their names are kept)' },
    // Old records only (a message used to be cut at a million characters; nothing is cut now).
    text_cut: { one: '1 message too long: the start of it is kept', many: '{n} messages too long: the start of each is kept' },
    spam_or_trash: { one: '1 message in Spam or Trash left out', many: '{n} messages in Spam or Trash left out' },
    mail_for_another_account: { one: '1 message delivered to another address left out', many: '{n} messages delivered to another address left out' },
    // Why an import waits (the record's `waiting`): for a limit too small, {n} is the least it must be.
    gmail_budget_too_small: {
      one: 'Waiting: the daily limit on Gmail requests is too low to import. Set OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET to {n} or more, then restart Olympus.',
      many: 'Waiting: the daily limit on Gmail requests is too low to import. Set OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET to {n} or more, then restart Olympus.',
    },
    gmail_import_allowance_spent: { one: "Waiting until tomorrow: imports have used their share of today's Gmail requests.", many: "Waiting until tomorrow: imports have used their share of today's Gmail requests." },
    gmail_requests_spent: { one: "Waiting until tomorrow: today's Gmail requests are used up.", many: "Waiting until tomorrow: today's Gmail requests are used up." },
    gmail_labels_unavailable: { one: "Waiting: one of your rules names a Gmail label, and Gmail's labels can't be read now.", many: "Waiting: one of your rules names a Gmail label, and Gmail's labels can't be read now." },
    system_message: { one: "1 notice from WhatsApp itself (such as someone joining) left out", many: "{n} notices from WhatsApp itself (such as people joining) left out" },
    message_empty: { one: '1 message with no text left out', many: '{n} messages with no text left out' },
    // WhatsApp export beside live capture (whatsapp/archive-input.ts).
    match_near_miss: { one: '1 message may also be in the live chat, shown differently there (a renamed contact, an edited caption), so it was kept as its own', many: '{n} messages may also be in the live chat, shown differently there (a renamed contact, an edited caption), so each was kept as its own' },
    // Old records only (the status updates chat used to be left out; it is read like any chat now).
    status_updates: { one: "1 status update left out: it is not a conversation", many: "{n} status updates left out: they are not a conversation" },
    // Notes exports (Reflect, Roam): archive-import/notes/note.ts NOTE_FINDINGS.
    note_empty: { one: '1 note with nothing written in it left out', many: '{n} notes with nothing written in them left out' },
    note_unreadable: { one: '1 note could not be read', many: '{n} notes could not be read' },
    note_too_large: { one: '1 note too large to read', many: '{n} notes too large to read' },
    note_content_unsupported: { one: '1 note with a kind of content Olympus cannot read yet', many: '{n} notes with a kind of content Olympus cannot read yet' },
    note_date_assumed: { one: '1 note has no date in the archive: Olympus used the day the file was saved', many: '{n} notes have no date in the archive: Olympus used the day the file was saved' },
    // Old records only (joins, calls and pins used to be left out; they are messages now).
    service_message: { one: '1 service message (a join, a call or a pin) left out', many: '{n} service messages (joins, calls or pins) left out' },
    message_without_text: { one: '1 message with nothing to read (no text, picture or file) left out', many: '{n} messages with nothing to read (no text, picture or file) left out' },
    // Kinds any format can report (ARCHIVE_COMMON_FINDINGS).
    media_not_imported: { one: '1 picture, recording or other file the archive refers to was not imported', many: '{n} pictures, recordings or other files the archive refers to were not imported' },
    // Old records only (nothing is cut now).
    item_truncated: { one: '1 item too long: the start of it is kept', many: '{n} items too long: the start of each is kept' },
    // What was taken as given, one sentence for each thing and, where it is known, the value taken.
    time_zone_assumed: { one: "The times have no time zone, so Olympus read them in this computer's time zone", many: "The times in {n} files have no time zone, so Olympus read them in this computer's time zone" },
    date_order_assumed: { one: 'The dates do not say which part is the day, so Olympus read them day first', many: 'The dates in {n} files do not say which part is the day, so Olympus read them day first' },
    item_start_assumed: { one: '1 line that looks like the start of a new message was taken as one, though it is dated before the message above it or written in another style, so it may belong to that message', many: '{n} lines that look like the start of a new message were taken as new messages, though each is dated before the message above it or written in another style, so they may belong to those messages' },
    zip_overlap_unchecked: { one: '1 zip is too large to check whether its files share the same bytes, so Olympus took it that they do not (a damaged zip could break that)', many: '{n} zips are too large to check whether their files share the same bytes, so Olympus took it that they do not (a damaged zip could break that)' },
    // Only for an archive recorded before the kinds above: it kept the one kind it was written with.
    assumption: { one: '1 thing Olympus had to assume because the archive does not say or is too large to check (this archive was imported before Olympus named each one: remove it and import it again to see which)', many: '{n} things Olympus had to assume because the archive does not say or is too large to check (this archive was imported before Olympus named each one: remove it and import it again to see which)' },
    section_not_imported: { one: '1 part of the archive is not imported', many: '{n} parts of the archive are not imported' },
    file_damaged: { one: '1 file in the archive looks damaged, so what was read from it may be wrong', many: '{n} files in the archive look damaged, so what was read from them may be wrong' },
    item_repeated: { one: '1 message was in more than one export file and was imported once', many: '{n} messages were in more than one export file and were imported once' },
    item_refused: { one: '1 item was not imported because the place it belongs in would not take it (nothing was stored in the wrong place)', many: '{n} items were not imported because the place they belong in would not take them (nothing was stored in the wrong place)' },
    files_not_looked_at: { one: '1 file in what you chose was not looked at, so it was not imported if it is an export', many: '{n} files in what you chose were not looked at, so any of them that are exports were not imported' },
    files_unconfirmed: { one: '1 file in the chosen folder looks like an export but is not named like one, so it was not imported (choose it by itself to import it)', many: '{n} files in the chosen folder look like exports but are not named like one, so they were not imported (choose them by themselves to import them)' },
    other: { one: '1 item not read fully', many: '{n} items not read fully' },
  },
  /**
   * The two lists under an archive's row. Not imported: what Olympus does not
   * have (damaged, unread, unsupported, pictures and files not read, files
   * not looked at). How it was read: what Olympus took as given or left out
   * on purpose, with nothing lost by it (a time zone, a date order, items
   * repeated and imported once, notices and empty messages).
   */
  lists: { notImported: 'Not imported', howRead: 'How it was read' },
  /** The button that opens them, by which of the two there are. */
  seeWhy: {
    notImported: 'See what was not imported',
    howRead: 'See how it was read',
    both: 'See what was not imported and how it was read',
  },
  /**
   * The list every kind of finding is shown in: one line each, beside the
   * sentences above. A kind missing here is shown under Not imported, so a
   * problem never disappears; test/archive-import-finding-lists.test.ts
   * fails when a kind any format reports has no entry.
   */
  listOf: {
    // Kinds any format can report (ARCHIVE_COMMON_FINDINGS).
    media_not_imported: 'not_imported',
    item_truncated: 'not_imported',
    section_not_imported: 'not_imported',
    file_damaged: 'not_imported',
    item_refused: 'not_imported',
    files_not_looked_at: 'not_imported',
    files_unconfirmed: 'not_imported',
    time_zone_assumed: 'how_read',
    date_order_assumed: 'how_read',
    item_start_assumed: 'how_read',
    zip_overlap_unchecked: 'how_read',
    assumption: 'how_read',
    item_repeated: 'how_read',
    // Mail (mbox).
    message_too_large: 'not_imported',
    message_unreadable: 'not_imported',
    charset_not_decoded: 'not_imported',
    attachments_not_read: 'not_imported',
    text_cut: 'not_imported',
    spam_or_trash: 'not_imported',
    mail_for_another_account: 'not_imported',
    gmail_budget_too_small: 'not_imported',
    gmail_import_allowance_spent: 'not_imported',
    gmail_requests_spent: 'not_imported',
    gmail_labels_unavailable: 'not_imported',
    // Chats (WhatsApp, Telegram).
    message_content_unsupported: 'not_imported',
    system_message: 'how_read',
    message_empty: 'how_read',
    match_near_miss: 'how_read',
    message_without_text: 'how_read',
    status_updates: 'not_imported',
    service_message: 'not_imported',
    // Notes (Reflect, Roam).
    note_unreadable: 'not_imported',
    note_too_large: 'not_imported',
    note_content_unsupported: 'not_imported',
    note_empty: 'how_read',
    note_date_assumed: 'how_read',
    // Any kind this version does not know (an older or newer record).
    other: 'not_imported',
  },
  /** A gap line for an archive of several files: which file it is in. */
  gapInFile: '{file}: {gap}',
  remove: 'Remove',
  removeConfirm: 'Remove {name}? Everything Olympus made from it is deleted. The file itself stays where it is.',
  /** An agent's request, waiting for the person. */
  requestLine: 'An agent asked to import {name} from {where}.',
  /** Under an agent's request: the whole path it acts on, with hidden characters written out. */
  fullPath: 'Full path: {path}',
  /** An agent's request to remove an archive; the archive's own name and folder. */
  removeRequestLine: 'An agent asked to remove {name}, imported from {where}.',
  removeRequestLineNoWhere: 'An agent asked to remove {name}.',
  removeRequestNote: 'Removing deletes everything Olympus made from it. The file itself stays where it is.',
  approve: 'Import',
  decline: 'Decline',
  checkingLine: 'Checking whether {name} is already imported. Olympus reads it once to compare.',
  /** Stops a check: nothing is imported. */
  cancel: 'Cancel',
  cancelled: 'Cancelled. {name} was not imported.',
  alreadyLine: '{name} is already imported as {archive}.',
  alreadyLineUnnamed: '{name} is already imported.',
  failedLine: '{name} was not imported: {reason}',
  failed: {
    not_found: 'it is no longer there.',
    permission_denied: 'your user account is not allowed to open it.',
    changed: 'it changed while Olympus was reading it.',
    unreadable: 'Olympus could not read it.',
    unsupported: 'Olympus does not import this kind of file.',
    ambiguous: 'Olympus could not tell which kind of export it is.',
    replaced: 'it was moved, replaced or changed after you chose it.',
  },
  /** A check that ended without importing: the same path approved again. */
  tryAgain: 'Try again',
  dismiss: 'Dismiss',
  /** After a choice in the picker. */
  started: 'Importing {name}. It shows under Other archives as it is read.',
  /** An import that joined a source: it shows in that source's card. */
  startedIn: 'Importing {name} into {source}. It shows in {source} as it is read.',
  checking: 'Checking whether {name} is already imported…',
  already: '{name} is already imported as {archive}.',
  alreadyUnnamed: '{name} is already imported.',
  removing: 'Removing {name}.',
  declined: 'Declined.',
  /**
   * Under Needs you, one line each, with the way to exactly that archive or
   * request (on the computer the line's button goes to it in place).
   */
  needsYou: {
    stopped: 'An import stopped: {name}',
    request: 'An agent asked to import {name}',
    removal: 'An agent asked to remove {name}',
    failed: 'An import did not start: {name}',
    counts: "Olympus can't count what is in {name}",
    scheduler: {
      disabled: "Imports can't run: background syncing is turned off",
      not_selected: "Imports can't run: background syncing leaves out archives",
    },
    held: { one: '1 imported item waits for the private model', many: '{n} imported items wait for the private model' },
    unreadable: "Olympus can't read its list of imported archives",
    /** An import waits for a limit the owner must raise; {n} is the least it must be. */
    waiting: {
      gmail_budget_too_small: "An import waits: {name}. The daily limit on Gmail requests is too low; set OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET to {n} or more",
      other: 'An import waits: {name}',
    },
    seeWhy: 'See why',
    review: 'Review',
    setUp: 'Set up the private model',
    check: 'Check the private model',
  },
  /** See why under the Archives row while its list cannot be read; {file} is where the list is kept. */
  unreadable: {
    why: {
      damaged: '{file} is damaged, so Olympus cannot tell which archives it imported.',
      unknown_form: '{file} was written by a newer version of Olympus, or it is damaged.',
      permission: 'Your user account is not allowed to open {file}.',
      other: 'Olympus could not open {file}.',
    },
    kept: 'Nothing Olympus imported is deleted. Until it can read this list, no archive can be imported, so nothing overwrites it.',
    fix: {
      damaged: 'Restore that file from a backup, or ask for help at olympusplugin.ai/support.',
      unknown_form: 'Update Olympus, then open this page again.',
      permission: 'Check that your user account can open that file, then open this page again.',
      other: 'Open this page again in a minute. If it still says this, ask for help at olympusplugin.ai/support.',
    },
  },
} as const;

/**
 * The sentence one Needs you item about imports carries (both surfaces read
 * the same words). A name is the person's own file name, or an agent's idea
 * of one: it is shown through `displayText`, so nothing in it can hide or
 * reorder the words around it.
 */
export function dashboardImportAttentionSentence(entry: DashboardImportAttention): string {
  const words = DASHBOARD_ARCHIVE_COPY.needsYou;
  switch (entry.kind) {
    case 'stopped':
      return words.stopped.replace('{name}', () => displayText(entry.name));
    case 'request':
      return words.request.replace('{name}', () => displayText(entry.name));
    case 'removal':
      return words.removal.replace('{name}', () => displayText(entry.name));
    case 'failed':
      return words.failed.replace('{name}', () => displayText(entry.name));
    case 'counts':
      return words.counts.replace('{name}', () => displayText(entry.name));
    case 'scheduler':
      return words.scheduler[entry.setting];
    case 'held':
      return entry.count === 1 ? words.held.one : words.held.many.replace('{n}', dashboardCount(entry.count));
    case 'unreadable':
      return words.unreadable;
    case 'waiting': {
      const template = entry.reason === 'gmail_budget_too_small' ? words.waiting.gmail_budget_too_small : words.waiting.other;
      return template.replace('{name}', () => displayText(entry.name)).replace('{n}', dashboardCount(entry.minimum));
    }
  }
}

export const DASHBOARD_COMPUTER_PANEL_COPY = {
  section: 'On this computer',
  onlyHere: 'only here',
  open: 'Open',
  rows: {
    keys: { title: 'Keys', line: 'Venice, Readwise and X keys' },
    agents: { title: 'Agents', line: 'Remote access and connected agents' },
    privateAnswers: { title: 'Inbox', line: 'Answers from every model, kept on this computer.' },
    connector: { title: 'Build a connector', line: 'For a source Olympus does not have yet' },
  },
  /**
   * Why a control waits while the local dashboard controls are locked. The
   * computer's banner carries it, so the panel shows it beside no control
   * there; kept for a host without that banner.
   */
  /**
   * The computer's Needs you line while private questions wait (design
   * background-agents.md, "Dashboard changes" 2). Only the computer's meta
   * carries the count; ChatGPT never sees this line.
   */
  waiting: { one: '1 unread private answer', many: '{count} unread private answers' },
  locked: 'Open dashboard controls first',
  /** The OpenClaw tab for a connection without operator.write. */
  readOnlyOpenClaw: 'Reconnect OpenClaw with operator.write access to change this',
  indexFaster: DASHBOARD_INDEX_FASTER,
  archives: DASHBOARD_ARCHIVE_COPY,
} as const;

/**
 * Control labels the ChatGPT producer puts on setup fixes
 * (src/workers/chatgpt/dashboard-view-model.ts, which proposed them as
 * CHATGPT_SETUP_LABELS). Closed set, owner words.
 */
export const DASHBOARD_CHATGPT_SETUP_LABELS = {
  connect: 'Connect',
  syncNow: 'Sync now',
  chooseFolders: 'Choose folders',
  chooseMail: 'Choose mail',
  disconnect: 'Disconnect',
  deleteData: 'Delete indexed data',
  changeModels: 'Change',
  importArchive: DASHBOARD_ARCHIVE_COPY.importAction,
} as const;

/**
 * Words for the ChatGPT page's in-place Connect flow and its folder and mail
 * pickers (src/workers/dashboard/chatgpt/picker.ts). Folder names, label names
 * and senders are never part of this copy: the picker prints them only beside
 * these words, inside the picker view.
 */
export const DASHBOARD_CHATGPT_PICKER_COPY = {
  back: 'Back to Olympus',
  cancel: 'Cancel',
  tryAgain: 'Try again',
  checkAgain: 'Check again',
  connectTitle: 'Connect {source}',
  connectStarting: 'Opening sign-in…',
  connectWaiting: 'Waiting for you to finish signing in…',
  connectWaitingHelp: 'Sign in to {source} in the window that opened. This page updates on its own when you are done.',
  connectReopen: 'Open sign-in again',
  connectTimeout: 'Olympus has not heard back from {source} yet. If you finished signing in, check again.',
  connectFailed: 'Olympus could not start signing in to {source}. Try again.',
  goToModels: 'Go to Models',
  connected: '{source} is connected.',
  foldersTitle: 'Choose folders',
  /** Beside a folder your Mac asks about before Olympus may open it. */
  needsPermission: 'Needs permission',
  openPrivacySettings: 'Open privacy settings',
  /** Beside a mounted disk in the list of folders, so it does not read as a folder. */
  disk: 'Disk',
  foldersIntro: 'Choose what Olympus may read in {source}. A folder follows the one above it until you change it. Nothing starts until you save.',
  mailTitle: 'Choose mail',
  mailIntro: 'Choose which {source} mail Olympus may read. Nothing starts until you save.',
  loadingFolders: 'Loading folders…',
  loadingMail: 'Reading your labels and senders…',
  loadFailed: 'Olympus could not load this list. Try again.',
  up: 'Back',
  upTo: 'Back to {name}',
  pathMore: '…',
  accountRow: 'Everything in {source}',
  exceptions: 'Exceptions ({n})',
  foldersHeading: 'Folders',
  thisFolder: 'This folder',
  unknownFolder: 'A folder not opened yet',
  insideFolder: 'A folder inside {name}',
  noFolders: 'No folders here.',
  loadMore: 'Load more folders',
  loadMoreCount: { one: 'Load 1 more folder', many: 'Load {n} more folders' },
  /** The level has more folders than Olympus reads at once; some are not listed. */
  truncated: 'This folder has more folders than Olympus can list here, so this list is incomplete.',
  states: { ingest: 'Fully indexed', metadata_only: 'Names only', exclude: 'Skipped' },
  statesLower: { ingest: 'fully indexed', metadata_only: 'names only', exclude: 'skipped' },
  notIncluded: 'Not included',
  mixed: 'Mixed',
  mixedSome: 'Mixed: some folders inside are {state}',
  /** The row control's segments: [full label, short label under ~420px]. */
  segments: { ingest: ['Full', 'Full'], metadata_only: ['Names only', 'Names'], exclude: ['Skip', 'Skip'] },
  choiceGroup: 'Choice for {name}',
  openFolder: 'Open {name}',
  cannotChoose: 'Olympus cannot read this folder.',
  wholeOnlyFull: 'The whole account is all or nothing. Set Names only or Skip on folders instead.',
  inheritedFrom: 'Inherited from {parent}',
  overridden: 'This folder is set to {own}, but {parent} is {state}, which wins.',
  notPossible: 'Not possible while {parent} is {state}.',
  capReached: 'You have {max} folder choices, the most Olympus can save. Clear a folder\'s choice to choose another.',
  folderFiles: { one: '{n} file', many: '{n} files' },
  wholePrompt: 'Olympus will read every folder in {source}, now and later, except folders you set to Names only or Skip.',
  wholeConfirm: 'Yes, use the entire account',
  summaryTitle: 'What happens when you save',
  summaryNone: 'Nothing chosen yet, so nothing will be read.',
  summaryWhole: 'Everything else in {source}: fully indexed, including folders added later.',
  summaryFolder: { one: 'folder', many: 'folders' },
  summaryIngest: '{n} fully indexed',
  summaryMetadata: '{n} with names only',
  summaryExclude: '{n} skipped',
  summarySize: 'about {size}',
  needChoice: 'Choose at least one folder first.',
  needConfirm: 'Confirm the entire account first.',
  saveFolders: 'Save and start',
  saveNoStart: 'Save',
  saveMail: 'Save and start',
  saving: 'Saving…',
  saveFailed: 'Olympus could not save. Your choices are still here. Try again.',
  conflict: 'These choices were changed somewhere else, so this view has been refreshed. Check it and save again.',
  saved: '{source}: saved. Olympus is starting.',
  discardPrompt: 'Discard your changes?',
  discard: 'Discard changes',
  keep: 'Keep choosing',
  mailWindow: 'Read the full text of mail from',
  mailWindowHelp: 'For older mail Olympus keeps only the subject, sender, date and labels.',
  mailWindows: {
    '6m': 'The last 6 months',
    '1y': 'The last year',
    '2y': 'The last 2 years',
    '5y': 'The last 5 years',
    all: 'All time',
  },
  mailRecommended: 'Recommended',
  mailCategories: 'Gmail categories',
  mailCategoriesHelp: 'Checked categories are read. Promotions and Social are skipped at first.',
  mailCategoryNames: {
    primary: ['Primary', 'Personal mail'],
    updates: ['Updates', 'Receipts, statements, confirmations'],
    forums: ['Forums', 'Mailing lists and groups'],
    social: ['Social', 'Social network notifications'],
    promotions: ['Promotions', 'Marketing and offers'],
  },
  mailCategoryCount: '{count} in your mailbox',
  mailLabels: 'Labels',
  mailLabelsHelp: 'Checked labels are read. Uncheck a label to skip all mail that has it.',
  mailLabelsEmpty: 'This mailbox has no labels of its own.',
  mailSentLabel: 'Sent',
  mailSenders: 'Senders',
  mailPrivate: 'Always private',
  mailPrivateHelp: 'One address or @domain per line. Their new mail is treated as private and never goes to the cloud.',
  mailSkip: 'Skip',
  mailSkipHelp: 'One address or @domain per line. Their new mail is never read.',
  mailSuggestions: 'Frequent senders in a sample of your recent mail',
  mailSuggestionCount: '{n} of {total}',
  mailEstimate: 'About {content} messages read in full and {metadata} by subject and sender only.',
  mailCost: 'Indexing costs at most ${cost}.',
  mailEstimateNote: 'Counts are Gmail\'s own estimates. Nothing has been read yet.',
  mailUpdateEstimate: 'Update estimate',
  mailSummaryWindow: 'Full text from {window}',
  mailSummarySkipped: { one: '{n} category or label skipped', many: '{n} categories and labels skipped' },
  mailSummaryPrivate: { one: '{n} sender always private', many: '{n} senders always private' },
  mailSummarySkipSenders: { one: '{n} sender skipped', many: '{n} senders skipped' },
} as const;

/**
 * The follow-up questions both privacy editors ask when the owner's words name
 * a broad area (shared-privacy-logic.ts holds which areas, how they are
 * spotted and each choice's default). An answered area becomes one sentence
 * in the description, built from `about`, `privateList` and `shareList`, and
 * read back from them: changing these words changes how saved answers read.
 */
export const DASHBOARD_PRIVACY_QUESTIONS_COPY = {
  title: 'A few quick questions',
  intro: 'Your words name some broad areas. Pick what\'s private in each, so Olympus keeps only those things private. Your answers are added to your description, where you can still edit them.',
  private: 'Private',
  share: 'Fine to share',
  /** A choice whose sentence would not fit in the description: nothing changes. */
  tooLong: 'Your description is too long to add this answer. Shorten your own words, then choose again.',
  about: 'About {topic}:',
  privateList: 'private — {list}',
  shareList: 'fine to share — {list}',
  topics: {
    family: {
      name: 'family',
      question: 'Which family things are private?',
      options: {
        medical: 'Family members\' medical records',
        legal_money: 'Family legal and money papers (divorce, custody, trusts)',
        conversations: 'Private family conversations and journals',
        logistics: 'School plans and family logistics',
        contacts: 'Alumni, contact and address lists',
        history: 'Family history and photos',
      },
    },
    health: {
      name: 'health',
      question: 'Which health things are private?',
      options: {
        results: 'My lab, test and medical results',
        prescriptions: 'Prescriptions and clinic or visit notes',
        therapy: 'Therapy sessions',
        exports: 'Health-data exports',
        wellness: 'Wellness programs, diets and detox plans',
        guides: 'Health books, guides and courses',
        product_tests: 'Product or supplement test reports',
      },
    },
    money: {
      name: 'money',
      question: 'Which money things are private?',
      options: {
        statements: 'Bank, card, brokerage and crypto statements',
        tax: 'Tax and payroll papers',
        bills: 'Invoices, bills and receipts',
        loans: 'Loans and proof of funds',
        articles: 'Articles and guides about money',
        projects: 'Crypto project whitepapers and research',
        prices: 'Prices and quotes I am researching',
      },
    },
    work: {
      name: 'work',
      question: 'Which work things are private?',
      options: {
        contracts: 'Contracts, NDAs, offers and salaries',
        hr: 'HR and legal matters',
        projects: 'Project notes, specs and plans',
        meetings: 'Work meeting transcripts',
        wikis: 'Team wikis and assistant instruction files',
      },
    },
    relationships: {
      name: 'relationships',
      question: 'Which relationship things are private?',
      options: {
        journals: 'Journals and personal session transcripts',
        conversations: 'Private conversations',
        teachings: 'Books and teachings about relationships',
        groups: 'Group sessions and courses',
      },
    },
    home: {
      name: 'home',
      question: 'Which home things are private?',
      options: {
        deeds: 'Deeds, purchase contracts and leases',
        info: 'Property information and certificates',
        plans: 'Listings, renovation and moving plans',
      },
    },
  },
} as const;

/**
 * Words for the ChatGPT page's privacy setup (src/workers/dashboard/chatgpt/privacy.ts)
 * and the dashboard's Privacy row. Two tiers are a person's to choose:
 * shared with ChatGPT (the default) and private (answered on the Mac only);
 * secrets are detected on the Mac and never a choice. Folder, label and
 * sender names and the person's own description are never part of this copy.
 */
export const DASHBOARD_CHATGPT_PRIVACY_COPY = {
  back: 'Back to Olympus',
  title: 'What\'s private for you?',
  intro: 'Olympus shares your items with ChatGPT unless you say they\'re private. Private items are answered on your computer and never sent to ChatGPT. Passwords and other secrets are always kept on your computer.',
  loading: 'Loading your privacy settings…',
  loadFailed: 'Olympus could not load your privacy settings. Try again.',
  tryAgain: 'Try again',
  descriptionLabel: 'In your own words',
  descriptionPlaceholder: 'For example: my health and therapy, money and taxes, anything about my kids, my divorce',
  /** Under the description box: the description is saved through ChatGPT, so it sees it. */
  descriptionShared: 'ChatGPT sees what you type here so it can save it; keep it to topics, like "my health", not details.',
  /** The follow-up questions under the description, and the sentences they add to it. */
  questions: DASHBOARD_PRIVACY_QUESTIONS_COPY,
  rulesTitle: 'Always private (optional)',
  rulesEmpty: 'No folders, labels or senders yet.',
  /** Under the always-private rules: their names travel through ChatGPT to be listed and saved. */
  namesShared: 'Folder and label names and senders you add here are shown to ChatGPT.',
  kindFolder: 'Folder in {source}',
  kindLabel: 'Gmail label',
  kindSender: 'Sender',
  remove: 'Remove',
  removeFor: 'Remove {name}',
  removed: 'Removed: {name}',
  undo: 'Undo',
  undoFor: 'Undo removing {name}',
  addFolder: 'Add a folder',
  addLabel: 'Add a Gmail label',
  addSender: 'Add a sender',
  needFolderSource: 'Connect Dropbox or Google Drive to add a folder.',
  needGmail: 'Connect Gmail to add a label.',
  nothingToSave: 'Nothing to save yet. Change a rule or the description first.',
  pending: {
    one: '{n} item is waiting to be checked on your computer.',
    many: '{n} items are waiting to be checked on your computer.',
  },
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  saveFailed: 'Olympus could not save. Your changes are still here. Try again.',
  saved: 'Privacy saved.',
  /** The inline step before a save that lowers protection; {list} names the removed rules. */
  confirmRemove: 'This removes protection from {list}.',
  confirmDescription: 'This changes your description, which decides what Olympus keeps private.',
  confirm: 'Confirm',
  /** A save refused because the settings changed elsewhere: the draft stays until the person picks. */
  conflict: 'Your changes weren\'t saved because the privacy settings changed elsewhere.',
  conflictNow: 'What is saved now:',
  conflictDescription: 'Your description: {text}',
  conflictNoDescription: 'No description',
  applyAgain: 'Apply my changes again',
  discardMine: 'Discard my changes',
  /** A folder rule saved without its name. */
  folderUnnamed: 'A folder in {source}',
  discardPrompt: 'Discard your changes?',
  discard: 'Discard changes',
  keep: 'Keep editing',
  backToPrivacy: 'Back to privacy',
  folderSourceTitle: 'Add a folder',
  folderSourceIntro: 'Which account is the folder in?',
  folderTitle: 'Add a folder',
  folderIntro: 'Open a folder in {source} to look inside it. Make private covers everything in the folder.',
  makePrivate: 'Make private',
  makePrivateFor: 'Make {name} private',
  alreadyPrivate: 'Already private',
  labelTitle: 'Add a Gmail label',
  labelIntro: 'Mail with a private label is answered only on your computer.',
  loadingLabels: 'Loading your labels…',
  noLabels: 'This mailbox has no labels of its own.',
  sentLabel: 'Sent',
  senderTitle: 'Add a sender',
  senderIntro: 'Mail from this sender is answered only on your computer.',
  senderLabel: 'Email address or @domain',
  senderPlaceholder: 'name@example.com or @example.com',
  senderAdd: 'Add',
  senderInvalid: 'Enter an email address like name@example.com, or a domain like @example.com.',
  senderDuplicate: 'That sender is already private.',
  section: 'Privacy',
  row: {
    none: 'Uses your description. No always-private rules.',
    one: 'Uses your description and {n} always-private rule.',
    many: 'Uses your description and {n} always-private rules.',
  },
  rowNoCount: 'Uses your description and always-private rules.',
  edit: 'Edit',
  editLabel: 'Edit what\'s private',
  dashboardPending: {
    one: '{n} item waiting to be checked',
    many: '{n} items waiting to be checked',
  },
} as const;

/** The dashboard's prompt to set up privacy, until the person has said what's private for them. */
export const DASHBOARD_CHATGPT_PRIVACY_SETUP_COPY = {
  sentence: 'Tell Olympus what\'s private for you',
  label: 'Set up privacy',
} as const;

/** needsYou while the privacy check waits for the owner to approve its model (approved on the computer only). */
export const DASHBOARD_CHATGPT_PRIVACY_CLASSIFIER_APPROVAL_COPY = {
  sentence: 'Approve the model that checks what\'s private. Until you do, new items it would check wait. On your computer, run olympus tier classifier approve --why, followed by your reason',
} as const;

/**
 * The private answer panel under a ChatGPT search result
 * (src/workers/dashboard/chatgpt/private-answer.ts). `{n}`, `{percent}`,
 * `{list}` are filled in by the panel. Nothing here names a source item.
 */
export const DASHBOARD_CHATGPT_PRIVATE_ANSWER_COPY = {
  pageTitle: 'Olympus private answer',
  title: 'Private answer from your computer',
  /** The muted line under the title once the answer is shown. */
  notSent: 'Not sent to ChatGPT',
  /** The muted line once the person hid the answer; Show brings it back from memory. */
  hidden: 'Private answer hidden',
  show: 'Show',
  /** The Show button's accessible name (its visible text is its start). */
  showLabel: 'Show private answer',
  hide: 'Hide',
  hideLabel: 'Hide private answer',
  tryAgain: 'Try again',
  /** No job exists in these two states, so the panel can only say what to do and to ask again. */
  noModel: 'Private answers need the private model on your computer. Open the Olympus dashboard to finish setup, then ask again.',
  downloading: 'The private model is downloading ({percent}%). Ask again when it\'s ready.',
  downloadingUnknown: 'The private model is downloading. Ask again when it\'s ready.',
  downloadingLabel: 'Private model download',
  preparing: 'Preparing the answer on your computer…',
  /** A full-detail answer reads selected parts more closely, not necessarily every page. */
  preparingFull: 'Reading your report in more detail on your computer…',
  slow: 'Your computer is taking longer than usual to prepare the answer.',
  failed: 'Olympus couldn\'t answer this on your computer.',
  claimed: 'This answer was already opened in another window.',
  expired: 'This answer has expired. Ask again to get a new one.',
  rateLimited: 'Too many requests — try again in a moment.',
  macOffline: 'Your computer is offline, so the private answer can\'t be shown.',
  unreachable: 'Olympus couldn\'t reach your computer. Try again in a moment.',
  generic: 'Olympus couldn\'t show the private answer here.',
  /** The collapsed disclosure under the answer; it opens a list of titles. */
  sourcesToggle: 'Sources ({n})',
  /** Brief inline result after a source is opened on the person's Mac. */
  openedOnMac: 'Opened on your computer',
  openFailed: 'Couldn\'t open it on your computer',
  unanswered: 'Not found in your private items: {list}',
} as const;

/**
 * The private question panel (src/workers/dashboard/chatgpt/private-question.ts):
 * a question typed in ChatGPT's panel that ChatGPT never sees, asked
 * anonymously through zkAPI from the user's own computer. `{model}` is
 * filled in by the panel. Nothing here names a source item.
 */
export const DASHBOARD_CHATGPT_PRIVATE_QUESTION_COPY = {
  pageTitle: 'Olympus private question',
  title: 'Private question',
  /** The muted line under the title while composing and once answered. */
  notSeen: 'ChatGPT does not see this question or its answer. It goes out anonymously through zkAPI from your computer.',
  /** The muted line when the ask was refused before anything left the computer. */
  notSent: 'Nothing was sent.',
  /** The send was attempted and failed afterwards: it may have reached the provider and used some of the balance. */
  mayHaveLeft: 'The question left your computer but no answer came back. It may have used some of your zkAPI balance; check before asking again.',
  questionLabel: 'Your question',
  strict: 'Strict',
  strictHint: 'Your own model rewrites it into general questions first, so nothing identifying can leave.',
  standard: 'Standard',
  standardHint: 'Your words, prepared the way you chose on the dashboard.',
  prepLabel: 'Prepared',
  asWritten: 'as written',
  lightCleanup: 'lightly cleaned up',
  custom: 'by your saved instruction',
  send: 'Ask anonymously',
  /** The one side-effect line (owner decision 2026-10-10: no money words inside ChatGPT; zkapi-copy.ts). */
  cost: 'Uses your zkAPI balance.',
  sending: 'Sealing your question for your computer…',
  waiting: 'Asking from your computer… this can take a few minutes.',
  empty: 'Type a question first.',
  /** The box never clips a paste; the count and this message say how far over it is. */
  tooLong: 'The question is {n} characters; keep it under {max}.',
  count: '{n} / {max} characters',
  slow: 'Your computer is taking longer than usual to get the answer.',
  failed: 'Olympus couldn\'t ask this from your computer.',
  claimed: 'This question was already opened in another window.',
  expired: 'This panel has expired. Ask ChatGPT to open a new private question.',
  rateLimited: 'Too many requests — try again in a moment.',
  macOffline: 'Your computer is offline, so the question can\'t be asked.',
  unreachable: 'Olympus couldn\'t reach your computer. Try again in a moment.',
  generic: 'Olympus couldn\'t ask this here.',
  answeredBy: 'Answered by {model}',
  howStrict: 'rewritten by your own model before it left',
  howAsWritten: 'sent as written',
  howLightCleanup: 'lightly cleaned up before it left',
  howCustom: 'prepared by your saved instruction before it left',
  networkVisible: 'Tor was off or bypassed, so the network address was visible and the question was not anonymous.',
  networkUnverified: 'The network route could not be verified on this computer.',
  showSent: 'Show what was sent',
  hideSent: 'Hide what was sent',
  askAnother: 'Ask another',
  /** Ask another: the panel opens a new question in place (a new sealed job from this computer). */
  opening: 'Opening a new question…',
  /** Ask another could not open one here (the job is gone, or this computer is offline): a new panel from ChatGPT still works. */
  askAgain: 'To ask another private question, ask ChatGPT to open a new one.',
} as const;

/**
 * The local folder picker's words (native Control UI page and the standalone
 * /dashboard/dispositions page). The same layout and wording as the approved
 * ChatGPT picker (DASHBOARD_CHATGPT_PICKER_COPY), minus what only applies
 * there. Rendered onto the picker form as JSON: the browser controller is
 * serialized into the standalone page, so it cannot import this module.
 */
export const DASHBOARD_PICKER_COPY = {
  foldersTitle: 'Choose folders',
  foldersIntro: 'Choose what Olympus may read. A folder follows the one above it until you change it. Nothing starts until you save.',
  backTo: 'Back to {source}',
  up: 'Back',
  locations: 'Locations',
  loadingFolders: 'Loading folders…',
  loadFailed: 'Olympus could not load this list. Try again.',
  tryAgain: 'Try again',
  connectFirst: 'Connect this account first, then return here to choose folders. Connecting does not start anything.',
  connect: 'Connect {source}',
  pathMore: '…',
  accountRow: 'Everything in {source}',
  exceptions: 'Exceptions ({n})',
  foldersHeading: 'Folders',
  thisFolder: 'This folder',
  unknownFolder: 'A folder not opened yet',
  insideFolder: 'A folder inside {name}',
  noFolders: 'No folders here.',
  loadMore: 'Load more folders',
  states: { ingest: 'Fully indexed', metadata_only: 'Names only', exclude: 'Skipped' },
  statesLower: { ingest: 'fully indexed', metadata_only: 'names only', exclude: 'skipped' },
  mixed: 'Mixed',
  mixedSome: 'Mixed: some folders inside are {state}',
  /** The row control's segments: [full label, short label when the picker is narrow]. */
  segments: { ingest: ['Full', 'Full'], metadata_only: ['Names only', 'Names'], exclude: ['Skip', 'Skip'] },
  choiceGroup: 'Choice for {name}',
  openFolder: 'Open {name}',
  cannotChoose: 'Olympus cannot read this folder.',
  wholeOnlyFull: 'The whole account is all or nothing. Set Names only or Skip on folders instead.',
  inheritedFrom: 'Inherited from {parent}',
  overridden: 'This folder is set to {own}, but {parent} is {state}, which wins.',
  notPossible: 'Not possible while {parent} is {state}.',
  capReached: 'You have {max} folder choices, the most Olympus can save. Clear a folder\'s choice to choose another.',
  wholePrompt: 'Olympus will read every folder in {source}, now and later, except folders you set to Names only or Skip.',
  wholeConfirm: 'Yes, use the entire account',
  wholeCancel: 'Cancel',
  summaryTitle: 'What happens when you save',
  summaryNone: 'Nothing chosen yet, so nothing will be read.',
  summaryWhole: 'Everything else in {source}: fully indexed, including folders added later.',
  summaryFolder: { one: 'folder', many: 'folders' },
  summaryIngest: '{n} fully indexed',
  summaryMetadata: '{n} with names only',
  summaryExclude: '{n} skipped',
  needChoice: 'Choose at least one folder first.',
  needConfirm: 'Confirm the entire account first.',
  saveFolders: 'Save and start',
  saveNoStart: 'Save',
  saving: 'Saving…',
  discard: 'Discard changes',
  discarded: 'Changes discarded. Loading your saved folders…',
  saveFailed: 'Olympus could not save. Your choices are still here. Try again.',
  conflict: 'The account or saved choices changed somewhere else. Reopen this picker before saving.',
  cycle: 'The folder list loops back on itself. Reopen this picker before continuing.',
  readOnly: 'Write access expired. Reconnect before browsing private folders.',
  browseFailed: 'Could not list folders. Your choices are still here; try again when the connection is ready.',
  saved: 'Saved. Opening the source status…',
  unconfirmed: 'Could not confirm the result. Reopen the picker to check your saved choices before retrying.',
} as const;

/**
 * The local dashboard's words for the ChatGPT dashboard's rules, ported on
 * 2026-10-02 for the computer's own pages (since 2026-10-09 the panel is the
 * one dashboard; Keys and the other local pages still read these). Where
 * both surfaces say the same thing the value is the ChatGPT block's own, so
 * they cannot drift apart; wording that names ChatGPT or "your Mac" is
 * rewritten here for the computer Olympus runs on. Never "Public": the owner's
 * choices are private or not.
 */
export const DASHBOARD_LOCAL_COPY = {
  needsYou: DASHBOARD_CHATGPT_PAGE_COPY.needsYou,
  sources: DASHBOARD_CHATGPT_PAGE_COPY.sources,
  sourcesLocal: 'On this computer',
  sourcesCloud: DASHBOARD_CHATGPT_PAGE_COPY.sourcesCloud,
  notConnected: DASHBOARD_CHATGPT_PAGE_COPY.notConnected,
  noSources: 'No sources connected yet.',
  progress: DASHBOARD_CHATGPT_PAGE_COPY.progress,
  progressInitial: DASHBOARD_CHATGPT_PAGE_COPY.progressInitial,
  progressRefresh: DASHBOARD_CHATGPT_PAGE_COPY.progressRefresh,
  percentDone: DASHBOARD_CHATGPT_PAGE_COPY.percentDone,
  left: DASHBOARD_CHATGPT_PAGE_COPY.left,
  eta: DASHBOARD_CHATGPT_PAGE_COPY.eta,
  stalled: DASHBOARD_CHATGPT_PAGE_COPY.stalled,
  units: DASHBOARD_CHATGPT_PAGE_COPY.units,
  /** A source's bar: its first unfinished stage. */
  sourceStages: DASHBOARD_CHATGPT_PAGE_COPY.sourceStages,
  findingItems: DASHBOARD_CHATGPT_PAGE_COPY.findingItems,
  findingFound: DASHBOARD_CHATGPT_PAGE_COPY.findingFound,
  sourceProgress: DASHBOARD_CHATGPT_PAGE_COPY.sourceProgress,
  /** One plain sentence per reason a source is not moving; {source} is its name. */
  stalledReasons: {
    waiting_for_credentials: DASHBOARD_CHATGPT_PAGE_COPY.stalledReasons.waiting_for_credentials,
    scope_pending: DASHBOARD_CHATGPT_PAGE_COPY.stalledReasons.scope_pending,
    scope_pending_mail: 'Paused until you choose mail',
    provider_unavailable: DASHBOARD_CHATGPT_PAGE_COPY.stalledReasons.provider_unavailable,
    model_downloading: DASHBOARD_CHATGPT_PAGE_COPY.stalledReasons.model_downloading,
  },
  /** A sign-in that is still outstanding: what to do, and how long the link stays good. */
  connecting: 'Finish signing in to {source}',
  linkExpires: DASHBOARD_CHATGPT_PAGE_COPY.linkExpires,
  openSignInAgain: DASHBOARD_CHATGPT_PICKER_COPY.connectReopen,
  cancelSignIn: 'Cancel sign-in',
  chooseFolders: DASHBOARD_CHATGPT_SETUP_LABELS.chooseFolders,
  chooseMail: DASHBOARD_CHATGPT_SETUP_LABELS.chooseMail,
  syncNow: 'Sync now',
  seeModels: 'See models',
  models: DASHBOARD_CHATGPT_PAGE_COPY.models,
  modelBuiltIn: DASHBOARD_CHATGPT_PAGE_COPY.modelBuiltIn,
  modelCustom: DASHBOARD_CHATGPT_PAGE_COPY.modelCustom,
  modelReady: DASHBOARD_CHATGPT_PAGE_COPY.modelReady,
  modelGettingReady: DASHBOARD_CHATGPT_PAGE_COPY.modelGettingReady,
  modelNeedsYou: DASHBOARD_CHATGPT_PAGE_COPY.modelNeedsYou,
  modelNotReady: DASHBOARD_CHATGPT_PAGE_COPY.modelNotReady,
  modelNotWorking: DASHBOARD_CHATGPT_PAGE_COPY.modelNotWorking,
  modelChecking: DASHBOARD_CHATGPT_PAGE_COPY.modelChecking,
  modelSearch: DASHBOARD_CHATGPT_PAGE_COPY.modelSearch,
  modelAnswers: DASHBOARD_CHATGPT_PAGE_COPY.modelAnswers,
  modelNames: DASHBOARD_CHATGPT_PAGE_COPY.modelNames,
  modelTranscription: DASHBOARD_CHATGPT_PAGE_COPY.modelTranscription,
  modelNotNeededNoAudio: DASHBOARD_CHATGPT_PAGE_COPY.modelNotNeededNoAudio,
  modelDownloadNow: DASHBOARD_CHATGPT_PAGE_COPY.modelDownloadNow,
  modelNotDownloaded: DASHBOARD_CHATGPT_PAGE_COPY.modelNotDownloaded,
  modelDownloadInterrupted: DASHBOARD_CHATGPT_PAGE_COPY.modelDownloadInterrupted,
  modelCouldNotStart: DASHBOARD_CHATGPT_PAGE_COPY.modelCouldNotStart,
  modelInstallDownloading: DASHBOARD_CHATGPT_PAGE_COPY.modelInstallDownloading,
  modelInstallVerifying: DASHBOARD_CHATGPT_PAGE_COPY.modelInstallVerifying,
  modelInstallFailed: DASHBOARD_CHATGPT_PAGE_COPY.modelInstallFailed,
  modelInstallBytes: DASHBOARD_CHATGPT_PAGE_COPY.modelInstallBytes,
  modelInstallReasons: DASHBOARD_CHATGPT_PAGE_COPY.modelInstallReasons,
  modelTryAgain: DASHBOARD_CHATGPT_PICKER_COPY.tryAgain,
  /** A built-in model whose install failed, in Needs you: its sentence, by failure code. */
  modelInstallFailedItem: DASHBOARD_CHATGPT_VOCABULARY.modelInstallFailed,
  modelsNotReady: 'Models are not ready, so sources stay locked.',
  privacy: {
    section: DASHBOARD_CHATGPT_PRIVACY_COPY.section,
    row: DASHBOARD_CHATGPT_PRIVACY_COPY.row,
    edit: DASHBOARD_CHATGPT_PRIVACY_COPY.edit,
    editLabel: DASHBOARD_CHATGPT_PRIVACY_COPY.editLabel,
    setUpSentence: DASHBOARD_CHATGPT_PRIVACY_SETUP_COPY.sentence,
    setUp: DASHBOARD_CHATGPT_PRIVACY_SETUP_COPY.label,
    pending: DASHBOARD_CHATGPT_PRIVACY_COPY.dashboardPending,
    unreadable: 'Olympus could not read your privacy settings.',
  },
} as const;

/**
 * The Private answers page (pages/private-answers.ts; design
 * background-agents.md sections A and B, "Dashboard changes" 1 and 2).
 * The privacy ladder offers Local, zkAPI and Venice models; setup lives in Models.
 */
export const DASHBOARD_PRIVATE_ANSWERS_COPY = {
  crumb: 'Inbox',
  title: 'Ask a question',
  intro: "Pick which model answers. Answers land in your inbox on this computer.",
  chooserLabel: 'Which model should answer?',
  readyStatus: 'Ready',
  downloadingStatus: 'Downloading',
  notSetUpStatus: 'Not set up',
  notConnectedStatus: 'Not connected',
  offStatus: 'Turned off',
  pausedStatus: 'Paused',
  stays: 'Stays on this computer',
  leaves: 'Leaves this computer',
  order: 'Least shared first',
  computerTag: 'On this computer',
  zkapiTag: 'In the cloud, paid anonymously',
  veniceTag: 'In Venice’s cloud',
  zkapiOff: 'Turned off. zkAPI is turned off.',
  zkapiPaused: 'Paused. Accept the updated statements to continue.',
  turnOnInModels: 'Turn on in Models',
  afterAsk: 'Sent. The answer will appear in your inbox.',
  computerName: "Local model",
  veniceName: "Venice model",
  zkapiName: "zkAPI model",
  computerLeaves: "The most private. Nothing leaves, but the model is smaller.",
  computerKnows: "It searches your files.",
  veniceLeaves: "A strong model that reads the passages it needs from your files. Venice knows it’s you.",
  veniceKnows: "Venice says it doesn’t keep them.",
  zkapiLeaves: "A top model that can’t see your files. It reads your question but isn’t told who’s asking. What you ask can still identify you.",
  zkapiKnows: "Takes 1 to 3 minutes.",
  /** Strict or Standard for this one question (owner, 2026-10-24); the saved setting is the starting choice. */
  levelLegend: "How this question leaves",
  levelStrict: "Strict",
  levelStrictHint: "Your own model rewrites it into general questions first, so nothing identifying can leave.",
  levelStandard: "Standard",
  levelStandardHint: "Your words, prepared the way you chose in {models}.",
  levelModelsLink: "Models",
  askComputer: "Ask the local model",
  askVenice: "Ask a Venice model",
  askZkapi: "Ask a model through zkAPI",
  setUpComputer: "Go to Models",
  setUpVenice: "Connect Venice",
  veniceKey: 'Venice API key',
  connectVenice: 'Connect Venice',
  veniceSetupHelp: 'Connect your Venice account here, then check your privacy settings for Private answers.',
  setUpZkapi: "Connect zkAPI",
  veniceNotSetUp: "Not connected. Connect Venice to use its models.",
  veniceNotAllowed: "Turned off. Private questions can’t go to Venice until you allow it.",
  privacySetting: 'Privacy settings for Private answers',
  privacySettingHelp: 'Your sovereignty privacy preset controls whether Private items may go to Venice. The default keeps them on this computer. Ask your agent to show your current preset and, if you choose, change it with Olympus setup. Connecting a Venice key alone does not allow Private items to leave.',
  changePrivacy: "Allow in Models",
  zkapiNotSetUp: "Not connected. Connect zkAPI and add money to use it.",
  destinationBusy: 'This destination is answering. Please wait.',
  sentItems: "What was sent to Venice",
  oneSource: 'One source',
  emptyQuestion: 'Type a question first.',

  privateIntro: 'Answered by the built-in model on this computer. Nothing leaves.',
  anonymousIntro: 'Answered by a stronger outside model without your name. Your prepared question leaves this computer, paid through zkAPI.',
  anonymousAsk: 'Ask anonymously',
  anonymousPlaceholder: 'Ask with outside help',
  anonymousNotSetUp: 'Anonymous answers are not set up.',
  levelInvalid: 'Choose Strict or Standard.',
  anonymousPending: 'Anonymous question pending',
  inboxUnavailable: 'The inbox cannot keep another answer right now. Try again later.',
  inboxBeforeSend: 'The inbox cannot keep this answer right now. Nothing was sent.',
  anonymousFailed: 'Olympus could not answer this question.',
  goToModels: 'Go to Models',
  privatePath: "Local model",
  anonymousPath: "zkAPI model",
  sent: "What was sent to zkAPI",
  askLabel: 'Your question',
  askPlaceholder: "Type your question",
  ask: 'Ask',
  waitingTitle: 'Inbox',
  waitingIntro: "Answers from every model, kept on this computer.",
  noneWaiting: "Your private inbox is empty.",
  olderRemoved: 'Older private answers were removed.',
  delete: 'Delete',
  deleteAll: 'Delete all',
  deleteAllConfirm: 'Delete every question and answer in your private inbox?',
  deleted: 'That answer was deleted',
  // A delete that removed nothing says so; the page keeps what it shows (owner rule: nothing looks deleted when it isn't).
  deleteNotFound: 'Olympus could not find this answer, so nothing was deleted. Reload to see your inbox as it is now.',
  deleteUnavailable: 'Private answers cannot be changed right now, so nothing was deleted. Try again in a moment.',
  nothingDeleted: 'Nothing was deleted. Reload to see your inbox as it is now.',
  retrying: 'Retrying on this computer…',
  queued: 'Queued on this computer. Automatic answers wait for their turn.',
  checkUnavailable: "Couldn't check this answer right now",
  unchecked: 'not checked yet',
  answering: 'Answering…',
  sources: 'Sources',
  open: 'Open',
  leftOut: 'Left out: {sources}. Olympus cannot search them on this computer.',
  unanswered: 'Not found here: {parts}.',
  notFound: 'Nothing on this computer answers this.',
  noModel: 'The model built into Olympus is not set up yet.',
  downloading: 'Downloading. The local model is still downloading.',
  changed: 'Something it read changed. Ask again.',
  failed: 'Olympus could not answer this. Try again.',
  unreachable: 'Olympus is not responding. Try again in a moment.',
  locked: 'Open dashboard controls to see and answer private questions.',
  openControls: 'Open dashboard controls →',
  unlockIntro: 'Private answers need a session opened here, not by an agent or the launch link.',
  unlock: 'Unlock on this computer',
  unavailable: 'Private answers are not available from this worker.',
  anonymousTitle: 'Anonymous answers',
  anonymousSum: 'Outside help',
  /** The computer's Needs you line: only on the computer, never in ChatGPT. */
} as const;

/**
 * The Outside help card (outside-help.ts; design frontier-consult-lane.md
 * §A.10 for the disclosure, §A.14 for the enable flow). Plain words, no
 * content: the card never shows a question, a reply, a key or the daemon's
 * configuration. "Daemon" is the program's own name for itself; the card
 * says "the zkapi-clientd program".
 */
/**
 * The one line the card shows where zkAPI cannot run: no network confinement
 * on this platform (owner ruling 2026-10-12: no weaker mode).
 */
const OUTSIDE_HELP_CONFINEMENT_UNAVAILABLE = 'Anonymous answers aren\'t available on this computer because its network isolation check hasn\'t passed. Nothing is sent without it.';

export const DASHBOARD_OUTSIDE_HELP_COPY = {
  crumb: 'Anonymous answers',
  title: 'Anonymous answers',
  /** Setup's section heading and its one row (owner naming, 2026-10-07). */
  sectionTitle: 'Private answers',
  row: {
    off: 'Anonymous answers: off',
    on: 'Anonymous answers: on',
    invalid: 'Anonymous answers: off · settings file damaged',
    route_not_configured: 'Anonymous answers: off · not set up',
    fence_held: 'Anonymous answers: paused · unfinished payment',
    needs_acceptance: 'Anonymous answers: paused · accept the updated statements',
    blocked: 'Anonymous answers: paused · needs a fix',
    unavailable: 'Anonymous answers: not available on this computer',
  },
  /** The route claim belongs to a verified, completed session, never the platform alone. */
  experimental: 'Experimental: Olympus says “anonymous route” only after a session passes its Tor, network confinement and key checks and the payment settles. Otherwise: network route not verified.',
  /** What outside help is, before anything technical (owner, 2026-10-07). */
  intro: 'For people running a strong local model at home: ask frontier models anonymously when your model needs help. Ask your agent to use Olympus zkAPI, and Olympus sends your question to a top AI model through zkAPI, paid and sent anonymously. The provider reads the question, and an unusual situation could still hint at who you are.',
  /** What zkAPI may send (owner titles 2026-10-08; internal ids 'unnamed' and 'general'); since 2026-10-24 only each question's starting choice. */
  levelTitle: 'What may zkAPI send by default?',
  /** Who writes the outside question (owner decision 2026-10-10): the built-in model, or the owner's own. No gate on the model. */
  writer: {
    title: 'Who writes the question',
    builtInShort: 'the model built into Olympus',
    intro: 'By default the small model built into Olympus prepares your question before it leaves. If you run a stronger model at home (Ollama, LM Studio, a llama.cpp server, or a home server), Olympus can use it instead: it rewrites the question into general ones at Strict, or prepares it the way you chose at Standard. At Strict, Olympus\'s privacy check still runs before anything is sent; at Standard, only passwords, keys and tokens are stopped. This works best with a substantial model.',
    currentBuiltIn: 'Now: the model built into Olympus.',
    currentOwn: 'Now: your model {model} at {address}.',
    baseUrl: 'Your model server\'s address (OpenAI-compatible, usually ending in /v1)',
    model: 'Model name',
    secretRef: 'Key reference, if your server needs one (optional: env:NAME or store:name)',
    where: 'Your private material goes to this address, so use a server you control. A server on another computer is reached over your network; prefer https or a private network such as a tailnet.',
    keyMissing: 'The key reference {secretRef} is not set on this computer, so your model cannot be used until it is.',
    frontierModel: 'zkAPI model for questions from ChatGPT',
    frontierHint: 'A model from a provider other than OpenAI is better here: OpenAI also holds your ChatGPT conversation and could link the two. Empty uses Claude Sonnet.',
    openAiNote: 'Questions from ChatGPT now go to {model}, an OpenAI model. OpenAI also holds your ChatGPT conversation; a model from another provider is better here.',
    claudeFrontierModel: 'zkAPI model for questions from Claude (Claude Code, Claude Desktop)',
    claudeFrontierHint: 'A model from a provider other than Anthropic is better here: Anthropic also holds your Claude conversation and could link the two. Empty uses GPT-5.5.',
    anthropicNote: 'Questions from Claude now go to {model}, an Anthropic model. Anthropic also holds your Claude conversation; a model from another provider is better here.',
    save: 'Save',
    useBuiltIn: 'Use the built-in model',
    testTitle: 'Test your model',
    testIntro: 'Runs six invented cases through your model and Olympus\'s privacy check, and shows the questions it wrote. Nothing is sent to zkAPI and nothing costs money. It runs only when you click, and can take several minutes on a home server.',
    testNeedsChoice: 'Choose and save your model first.',
    test: 'Test your model',
    testAgain: 'Test again',
    testStarting: 'Starting the test…',
    testProgress: 'Testing: {done} of {total} cases done…',
    testSummary: '{cases} cases: {written} written, {declined} with no question, {failed} failed. The privacy check would send {passed} and refuse {refused}.',
    testNoLeaks: 'No invented name, place or figure got past the privacy check.',
    testLeaks: '{n} cases let an invented name, place or figure past the privacy check. Do not rely on this model yet.',
    testDocumentQuestions: '{n} cases asked about a document the frontier model cannot see.',
    testPassed: 'would be sent',
    testRefused: 'refused by the privacy check ({reasons})',
    testDeclined: 'no question (the model decided outside help would not help)',
    testFailed: 'no usable reply ({reason})',
    testLeakMark: 'leak',
    testDocumentMark: 'asks about a document',
  },
  levels: {
    unnamed: {
      short: 'Standard',
      title: 'Standard (recommended)',
      body: 'Your question goes out as you choose: exactly as written, lightly cleaned, or by your own instruction. The provider can read it but isn\'t told who sent it.',
    },
    general: {
      short: 'Strict',
      title: 'Strict',
      body: 'Your model rewrites it into general questions first (Vitalik Buterin\'s approach).',
    },
  },
  /** How Standard prepares a question (owner decision 2026-10-10: open, the user's choice). */
  standard: {
    title: 'How your model prepares a question',
    intro: 'At Standard, before a question leaves:',
    /** The section's one line while Strict is chosen: the choice is kept, but only Standard uses it. */
    unusedAtStrict: '{mode} (used at Standard only)',
    modes: {
      as_written: { short: 'Exactly as written', title: 'Exactly as written', body: 'No model step: the question goes out unchanged.' },
      light_cleanup: { short: 'Lightly cleaned', title: 'Lightly cleaned (default)', body: 'Your model follows this instruction. Edit it to make it your own.' },
      custom: { short: 'Your own instruction', title: 'By your own instruction', body: 'Your model follows exactly what you write here.' },
    },
    instructionLabel: 'Instruction for your model',
    save: 'Save',
  },
  levelSave: 'Save',
  /** The public privacy line, in plain words (design §2, §A.10). */
  privacy: 'Your files and private answer stay on this computer. The outside model sees only the short question, and that question could still hint at private things.',
  state: {
    off: 'Anonymous answers are off.',
    on: 'Anonymous answers are on.',
    invalid: 'Anonymous answers are off: the settings file on this computer is damaged.',
    route_not_configured: 'Anonymous answers are off: zkAPI is not set up yet.',
    fence_held: 'Paused: an earlier question has not finished paying yet.',
    needs_acceptance: 'Paused until you accept the updated statements below.',
    blocked: 'Paused: fix the problem below.',
    unavailable: OUTSIDE_HELP_CONFINEMENT_UNAVAILABLE,
  },
  /** Where zkAPI cannot run (the card's whole body, and the worker's refusal). */
  confinementUnavailable: OUTSIDE_HELP_CONFINEMENT_UNAVAILABLE,
  /** Said only when a saved change needs a restart this worker could not do itself. */
  restartPending: 'Saved, but not applied yet: this Olympus cannot restart itself. Restart Olympus to apply the change.',
  /** Said under the status line when Tor is off, in plain words (Details names Tor). */
  addressVisible: 'Your network address will be visible to the provider.',
  routeUnknown: 'Olympus could not check zkAPI right now.',
  /**
   * Today's usage. Only each question's hold (the amount zkAPI holds for its
   * model, $1 to $6) is recorded, never the settled price, so the day's figure
   * is said as what counts against limits, never as money spent.
   */
  usageNone: 'No questions today',
  usageOne: '1 question today',
  usageMany: '{n} questions today',
  usageCounted: '(counted as up to ${usd} against your limits)',
  usageExpiry: 'balance expires about {date} ({days} days left)',
  usageExpired: 'balance past its estimated expiry',
  /** How cost works, real cost first, in one line (owner, 2026-10-08); the statements carry the recorded wording. */
  costLine: 'A question usually costs a few cents. Up to $6 is held while it runs, and the rest comes back.',
  problemsTitle: 'To fix',
  /** The one button of a problem whose fix sits in a section below, or that clears itself. */
  checkAgain: 'Check again',
  showSteps: 'Show the steps',
  enterFundingDate: 'Enter the date',
  chooseModel: 'Choose a model',
  capsReached: 'Today\'s question and spending limits are reached.',
  disclosureTitle: 'Before you turn this on',
  /** Two short lines at first view; the fuller detail sits behind disclosureMore. */
  disclosureShort: [
    'It asks only when you do: tell your agent to use Olympus zkAPI, and Olympus sends one short question.',
    'The provider reads the question, prepared the way you choose; zkAPI hides who paid.',
  ],
  disclosureMore: 'Everything to know first',
  /**
   * The fuller detail, in calm words (owner, 2026-10-08). It keeps what the
   * shorter statements leave out: when a question is sent, the hold counted against
   * limits, no default limit, deposit fees and no top-up, the estimated
   * expiry date, the fee buffer, the API key and key reuse, the operator
   * and the proof setup, and when the network route can be confirmed.
   */
  disclosure: [
    'Olympus sends a question only when you ask your agent to use Olympus zkAPI. Nothing is sent on its own.',
    'A question usually costs a few cents. While it runs, up to $6 of your zkAPI balance is held, and the rest comes back when it settles. Olympus counts each question at the amount held for its model (between $1 and $6) when checking the daily limits you set.',
    'There is no daily limit unless you set one under Balance and limits. Your balance is the most that can be spent.',
    'Adding money and taking it out are each an Ethereum transaction with its own network fee (about $7 each when Olympus last checked). There is no top-up: each deposit starts a new balance with its own fee and its own 30-day clock.',
    'Olympus estimates the 30-day date from the funding date you enter; the exact date is set on-chain when the deposit is confirmed.',
    'When you add money, send one transfer with the deposit plus the fee buffer zkapi-clientd shows. Network fees move, so the buffer can fall short and need a second transfer.',
    'Set zkapi-clientd to require an API key, so only Olympus on this computer can spend the balance. Olympus refuses to send while key reuse is on, so separate questions are not linked by a shared payment key.',
    'One operator account can pause deposits and withdrawals while the 30-day clock keeps running, and one party ran zkAPI\'s proof setup. Your balance lives in files on this computer; losing them loses the money.',
    'The provider reads the question; zkAPI hides who paid. On macOS, a compatible zkAPI app lets Olympus confirm the Tor route for each completed session. “Anonymous route” appears only when every check passes; it does not hide identifying details in your question.',
  ],
  routeMissing: 'zkAPI is not set up. Add it, then follow Set up zkAPI below.',
  policyNotFile: 'Your privacy policy is not kept in a file on this computer, so the route must be added where that policy lives.',
  addRoute: 'Add zkAPI to Olympus',
  addRouteConfirm: 'This adds a consult-only zkAPI route to your privacy policy and restarts the Olympus worker. No money moves. Continue?',
  /** The Details disclosure: the route's technical facts, never on first view. */
  detailsTitle: 'Details',
  factsTitle: 'This computer\'s zkAPI route',
  facts: {
    daemon: 'zkapi-clientd {version} found',
    versionUnknown: '(version unknown)',
    daemonMissing: 'zkapi-clientd not installed',
    tor: 'Tor found (a fresh Tor client per consult)',
    torOff: 'Tor off: the route is direct and your network address is visible to the provider',
    torMissing: 'Tor not installed',
    key: 'API key configured',
    keyMissing: 'API key not configured',
    today: '{n} requests today (${usd} counted against your limits)',
    todayOne: '1 request today (${usd} counted against your limits)',
    expiry: 'balance estimated to expire {date} ({days} days left)',
    expired: 'balance past its estimated expiry',
    expiryUnknown: 'balance expiry unknown until you enter the funding date',
  },
  routeLabel: 'Route: {label}.',
  lastSession: 'Last consult: {at}, {result}.',
  /** The To fix list: plain words, each with where its fix is. Technical names stay in Set up zkAPI and Details. */
  blockers: {
    daemon_not_found: 'The zkAPI app is not installed on this computer.',
    daemon_version_unsupported: 'This version of the zkAPI app has not been checked by Olympus. Use a reviewed version: 0.1.5, 0.1.6 or the Olympus fork 0.1.6-olympus2.',
    daemon_supervisor_unsupported: 'This zkAPI app needs the Olympus fork (0.1.6-olympus2) to confirm the anonymous route on macOS. Nothing was sent.',
    tor_not_found: 'The program that hides your network address is not installed.',
    daemon_api_key_missing: 'Olympus does not have your zkAPI access key yet.',
    acknowledgements_incomplete: 'The statements on this page are not accepted yet. Nothing is sent until they are.',
    funding_date_missing: 'Olympus needs the day you paid in to tell when your balance expires.',
    funding_date_invalid: 'The day you paid in is in the future.',
    note_expired: 'Your balance is past its estimated 30-day expiry. A new deposit starts a new balance.',
    unresolved_session: 'An earlier question has not finished paying (held since {at}). No question is sent until it does.',
    unresolved_session_other_wallet: 'An unfinished payment from another zkAPI wallet (held since {at}) stops questions. Finish it from that wallet, or abandon it.',
    stranded_processes: 'Tor or the zkAPI app from an earlier question is still running and Olympus could not stop it. If checking again does not clear it, restart Olympus (olympus engine restart).',
    daemon_already_running: 'Another copy of the zkAPI app is already running. Close it; Olympus starts its own for each question.',
    tor_port_busy: 'Another program is using the connection Olympus needs to hide your network address.',
    daily_cap_reached: 'Today\'s question limit is reached.',
    spend_cap_reached: 'Another question would pass today\'s spending limit.',
    state_unavailable: 'Olympus could not read its record of questions on this computer.',
    key_reuse_on: 'The zkAPI app is set to reuse payment keys, which can link your questions. Turn that off (the last step).',
    confinement_unavailable: OUTSIDE_HELP_CONFINEMENT_UNAVAILABLE,
  },
  blockerOther: 'Not ready yet ({code}).',
  stepsTitle: 'Set up zkAPI',
  stepsIntro: 'Install the parts above with one click, then run the rest in Terminal, in this order. This is the order that worked live.',
  /** `{daemon}` is the zkAPI program as Terminal needs it named (outside-help-tools.ts outsideHelpDaemonCommand); `{secretRef}` the route's key reference. */
  steps: [
    'Install Tor and zkAPI with the button above (or run olympus zkapi install-tools). On macOS, the confined route requires the Olympus zkapi-clientd fork 0.1.6-olympus2; the upstream 0.1.5/0.1.6 build cannot confirm it.',
    'Run: {daemon} config --usd N. Send one transfer: the deposit plus the fee buffer the tool shows. Network fees move, so the buffer can fall short and need a second transfer.',
    'Wait until the tool prints "Private inference balance activated".',
    'Run: {daemon} config --relay-url socks5://127.0.0.1:19050',
    'Run: {daemon} config --require-api-key',
    'Run: {daemon} config --api-key. Pipe its output directly into an owner-only file; never paste it into chat or logs. Store that key where the route\'s key reference points ({secretRef}); for env:NAME that is a NAME=<key> line in ~/.config/olympus/worker.env (owner-only), then restart the Olympus worker.',
    'Run: {daemon} config --key-reuse-window-seconds 0. Olympus refuses to send while the key-reuse window is on.',
  ],
  costTitle: 'Cost and risk',
  costIntro: 'Nothing is sent until you accept these. If the wording changes, you are asked again.',
  accept: 'Accept',
  acknowledged: 'You accepted all {n}',
  limitsTitle: 'Balance and limits',
  limitsNone: 'No daily limit',
  limitsRequests: '{n} questions a day',
  limitsUsd: '${usd} a day',
  fundedOn: 'paid in on {date}',
  notFunded: 'payment date not set',
  /** Today's worst-case count, inside Balance and limits. */
  limitsToday: 'Questions today: {n}, counted as up to ${usd} against your limits.',
  fundingDate: 'Funding date: the day your deposit was confirmed (YYYY-MM-DD)',
  capRequests: 'Daily question limit (optional)',
  capUsd: 'Daily spending limit in dollars, counting each question at the amount held for its model (optional)',
  noLimitIntro: 'There is no daily limit unless you set one. Your balance is the most that can be spent.',
  removeLimits: 'No daily limit',
  removeLimitsHint: 'Clears both limits.',
  saveRestarts: 'Saving restarts Olympus to apply it.',
  saveRoute: 'Save',
  fenceThis: 'Unfinished payment held since {at} (this wallet)',
  fenceOther: 'Unfinished payment held since {at} (another wallet folder)',
  recover: 'Recover',
  recoverHint: 'Sends one empty request to finish it; up to $6 is held while it runs.',
  recoverConfirm: 'Recovery sends one fixed request with no content through the same route and reserves up to $6. Continue?',
  abandon: 'Abandon',
  abandonHint: 'Stops waiting without finishing it; the unfinished payment may later link two sessions.',
  abandonConfirm: 'Abandoning means the unsettled request may later settle under another session\'s network identity, linking the two. It stops blocking consults and stays in the ledger as a record. Continue?',
  languagesTitle: 'Languages',
  languagesIntro: 'The outside question may use these languages. Only languages with a word pack installed on this computer can be chosen.',
  packMissing: 'pack not installed',
  /** The gate's domain packs beside the languages: which word lists a question may draw on. */
  domainsOn: 'Besides everyday words in these languages, a question may use: {list}.',
  domainsOff: 'Not admitted: {list}.',
  domainsNone: 'no extra word lists',
  domainNames: {
    units: 'units of measure',
    countries: 'country names',
    places: 'place names',
    technical: 'technical terms',
    medicines: 'medicine names',
    medicineBrands: 'medicine brand names',
  },
  turnOn: 'Turn on anonymous answers',
  turnOff: 'Turn off anonymous answers',
  replaceFile: 'Replace the damaged settings file (anonymous answers stay off)',
  enableBlockedRoute: 'Add zkAPI first.',
  enableBlockedAcks: 'Accept the statements on this page first.',
  saving: 'Saving…',
  saveFailed: 'Olympus could not save this. Try again.',
  /** A refusal that carried no words of its own: the HTTP status at least. */
  saveFailedStatus: 'Olympus could not save this (error {status}). Try again.',
  /** No answer at all, usually because Olympus is restarting. */
  saveUnreachable: 'Olympus did not answer. If it is restarting, wait a moment and try again.',
  restarting: 'Restarting Olympus to apply it…',
  restartRecovery: 'Olympus restarted to apply your change. Close this window and open Olympus again.',
  staleWindow: 'This Olympus window is out of date, so your change was not saved. Close this window, open Olympus again, and make the change again.',
  locked: 'Open dashboard controls to see and change anonymous answers.',
  unlockIntro: 'Changes need a session opened here, not by an agent or the launch link.',
  unlock: 'Unlock on this computer',
  native: 'Anonymous answers are set up on this computer\'s own dashboard only, never from an agent or ChatGPT.',
  unavailable: 'Anonymous answers are not available from this worker.',
} as const;

/** Which of an archive's two lists a kind of finding is shown in; a kind nobody has heard of is Not imported, so it is never hidden. */
export function archiveFindingList(kind: string): 'not_imported' | 'how_read' {
  const lists: Readonly<Record<string, 'not_imported' | 'how_read'>> = DASHBOARD_ARCHIVE_COPY.listOf;
  return Object.prototype.hasOwnProperty.call(lists, kind) ? lists[kind]! : 'not_imported';
}

/** Fixed, content-free Inbox failure copy. Broad codes must not invent a key or provider failure. */
export const PRIVATE_ANSWER_FAILURES = {
  answer_failed: { message: 'The model could not finish the answer.', href: '/dashboard?keys', action: 'Check models' },
  no_model: { message: 'Your local model is not available.', href: '/dashboard?keys', action: 'Set up local models' },
  model_downloading: { message: 'Your local model is still downloading.', href: '/dashboard?keys', action: 'Check models' },
  evidence_changed: { message: 'Items changed before Olympus could finish the answer.', href: '/dashboard?keys', action: 'Check setup' },
  eligibility_unavailable: { message: 'Olympus could not check whether the items are still available.', href: '/dashboard?keys', action: 'Check setup' },
  save_refused: { message: 'Olympus could not save the answer.', href: '/dashboard?keys', action: 'Check setup' },
} as const satisfies Record<import('../../core/waiting-private-questions.ts').WaitingQuestionRetryReason, { message: string; href: string; action: string }>;

/** Also embedded in the browser controller so initial, polled and opened rows use the same mapping. */
export function privateAnswerFailure(reason: unknown, mapping = PRIVATE_ANSWER_FAILURES): { message: string; action: string; href?: string } {
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(mapping, reason)
    ? mapping[reason as keyof typeof mapping] : { message: 'Olympus could not answer this.', action: 'Try again.' };
}
