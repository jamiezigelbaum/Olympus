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
  DashboardConnectionState,
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../source-dashboard.ts';
import { DASHBOARD_FIRST_SYNC_FRESHNESS_LABEL } from '../source-dashboard.ts';
import type { WorkerCredentialDegradation } from '../credential-degradation.ts';
import { answerReadyEligibleItems, clampPercent } from './answer-ready-coverage.ts';
import { OPERATOR_PAUSED_SCHEDULER_MARKERS } from './scheduler-markers.ts';

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

  const connectionStatus = DASHBOARD_CONNECTION_STATE_STATUS[source.connection.state];
  const readinessStatus = DASHBOARD_ANSWER_READINESS_STATUS[source.answer_readiness.state];
  const queueStatus = DASHBOARD_QUEUE_HEALTH_STATUS[source.queue_health.label as DashboardQueueHealthLabel];
  if (connectionStatus === 'Needs you' || connectionStatus === 'Off') {
    // 'Off' is only honest for a source with nothing behind it. A card whose
    // connection state reads never-connected while its corpus holds indexed
    // items is connected-but-broken — a revoked or deleted handle — so it
    // reads Needs you rather than hiding behind a calm word.
    if (connectionStatus === 'Off' && source.coverage.indexed_items > 0) {
      return { status: 'Needs you', mappedUnknown: false };
    }
    return { status: connectionStatus, mappedUnknown: false };
  }
  if (readinessStatus === 'Needs you' || queueStatus === 'Needs you') {
    return { status: 'Needs you', mappedUnknown: false };
  }
  // A folder source that is connected but has no approved scope has read
  // nothing and will read nothing until the owner chooses folders. Its
  // connection state is `connected`, which alone reads Fresh — a green dot and
  // "synced just now" over an empty corpus (first-install test, 2026-09-23).
  // It is waiting, exactly as a source before its first sync is; the Choose
  // folders banner carries the ask.
  if (dashboardScopePending(source)) return { status: 'Waiting', mappedUnknown: false };
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
  if (source.connection.provider_refusal) return true;
  return source.coverage.indexed_items > 0;
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
      return workingLine(source);
    case 'Waiting':
      return waitingLine(source);
    case 'Fresh':
      return freshLine(source, options?.now ?? new Date());
    case 'Off':
      return source.connection.label;
  }
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
  const degradation = dashboardDegradationForSource(source, options?.degradedCredentials);
  if (degradation) {
    const clause = degradationClause(degradation);
    return clause ? `can't sign in · ${clause}` : `can't sign in`;
  }
  // The provider's refusal, translated. It replaces every connection-state
  // line below, because "not connected" over an attempt the provider
  // explicitly rejected explains nothing the owner can act on. The provider's
  // own words stay in the sheet's How to fix disclosure.
  if (source.connection.provider_refusal) return dashboardProviderRefusalLine(source, options);
  switch (source.connection.state) {
    case 'reauth_required':
      return DASHBOARD_SIGNED_OUT;
    case 'awaiting_consent': {
      // The label is the provider's own name off the card, so the sentence
      // points at the tab the owner is actually looking at.
      // The sign-in may be in any browser or on any device, so the line says
      // what to do, never which tab to look in (owner rule, 2026-10-02).
      const base = `finish signing in to ${source.label}`;
      const minutes = source.connection.pending?.expires_in_minutes;
      return minutes !== undefined && minutes > 0
        ? `${base} · link expires in ${Math.max(1, Math.ceil(minutes))} min`
        : base;
    }
    case 'needs_setup':
    case 'not_connected':
      // A source that holds data and reads not-connected has LOST its
      // connection — a revoked or deleted handle — and the row says that,
      // not the registry's bare word (owner note, 2026-09-01: "not connected
      // — Set up" on a source with 4,000 files read as a demand for a source
      // nobody asked for).
      return source.coverage.indexed_items > 0
        ? DASHBOARD_SIGNED_OUT
        : source.connection.label;
    default:
      break;
  }
  // "Paused" is said only of a real pause — Olympus parked the lane on a budget
  // or a rate limit (owner ruling, 2026-10-08). A broken file, a stale sync or
  // a failing task is stated as itself.
  if (source.answer_readiness.state === 'needs_attention') {
    return dashboardOperatorPaused(source) ? `paused — ${pausedReason(source)}` : pausedReason(source);
  }
  // Owner ruling, 2026-08-24: NO ERROR COUNTS ANYWHERE. This line used to end
  // "3 items need attention · 1 task retrying", which is a number about queue
  // depth dressed as a number about the reader's data — and the reader can do
  // nothing with either figure. The row still says which of the two states it
  // is in, because the row exists and has to explain itself; it just stops
  // quantifying a fault nobody can act on by the size of it.
  if (source.queue_health.needs_attention > 0) return 'some items could not be read';
  if ((source.queue_health.retrying_tasks ?? 0) > 0) return 'a sync is retrying on its own';
  return '';
}

/** The row word for a connection the owner has to sign back into. */
export const DASHBOARD_SIGNED_OUT = 'signed out';

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

/** The view model's readiness labels that name a cause, in the owner's words. */
const READINESS_REASONS: Readonly<Record<string, string>> = {
  'Reauthenticate this source': DASHBOARD_SIGNED_OUT,
  'Embedding lane needs attention': 'indexing has stopped',
  'Content extraction is stalled': 'reading files has stalled',
  [DASHBOARD_MANY_UNREADABLE_LABEL]: "many files can't be read",
};

/** The view model's catch-all readiness label, which names no cause. */
const GENERIC_READINESS_ATTENTION_LABEL = 'Needs attention before answers';

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
  const unreadable = dashboardUnreadablePhrase(source);
  // The owner's own Sync now press, while it is the latest word, says what it
  // found in place of the bare sync time.
  const manual = dashboardManualSyncLine(source, now);
  if (manual) return unreadable ? `${manual} · ${unreadable}` : manual;
  const hours = source.freshness.hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return unreadable ?? '';
  const relative = dashboardRelativeFromHours(hours);
  if (!relative) return unreadable ?? '';
  // A lane Olympus parked is calm, not idle by accident. Saying so keeps this
  // line from implying the sync is still running, and matches the detail
  // page's paused sentence for the same marker.
  const synced = dashboardOperatorPaused(source) ? `synced ${relative} · sync paused` : `synced ${relative}`;
  return unreadable ? `${synced} · ${unreadable}` : synced;
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

/** The same note past DASHBOARD_UNREADABLE_ALARM_SHARE, where the row already says Needs you. */
export const DASHBOARD_UNREADABLE_NOTE_MANY =
  'That is more than a healthy source has, so it may be a problem in Olympus rather than your files.'
  + ' The other files still answer questions.';

/**
 * Why files can't be read, as a closed list (phase 3 of the unified dashboard).
 * Today extraction records one permanent failure, so one reason exists: a
 * damaged file and a format nothing reads are the same to the engine. More
 * codes need extraction to store one first. The view model carries a code and
 * a count, never a file name; the panel holds these words.
 */
export const DASHBOARD_UNREADABLE_REASON_CODES = ['damaged_or_unsupported'] as const;
export type DashboardUnreadableReasonCode = (typeof DASHBOARD_UNREADABLE_REASON_CODES)[number];

export const DASHBOARD_UNREADABLE_REASON_WORDS: Readonly<
  Record<DashboardUnreadableReasonCode, { one: string; other: string }>
> = {
  damaged_or_unsupported: {
    one: "{count} file is damaged or in a format Olympus can't read",
    other: "{count} files are damaged or in a format Olympus can't read",
  },
};

/** A Sync now that could not run, in plain words; the provider's own text stays in the log. */
export function dashboardManualSyncFailedLine(label: string): string {
  return `Couldn't check ${label} just now — Olympus will try again on its own`;
}

/** While a Sync now press is outstanding: "Checking Dropbox…". */
export function dashboardManualSyncPendingLine(label: string): string {
  return `Checking ${label}…`;
}

/** A Sync now press that found a sync of this source already running, so started nothing new. */
export function dashboardManualSyncBusyLine(label: string): string {
  return `Already checking ${label}`;
}

/**
 * A Sync now pressed again within a minute of the last one (2026-10-09): the
 * press starts nothing, and says why.
 */
export function dashboardManualSyncTooSoonLine(label: string): string {
  return `${label} was checked a moment ago — try again in a minute`;
}

/**
 * What the last Sync now press found, while the card still carries it
 * (DASHBOARD_MANUAL_SYNC_SHOWN_MS): "Checked just now — no new files",
 * "Checked 3m ago — 12 new files, reading them now". While the press's sync
 * still runs: "Checking Dropbox…". Never provider text.
 */
export function dashboardManualSyncLine(
  source: Pick<DashboardSourceCard, 'label' | 'family' | 'last_manual_sync'>,
  now: Date,
): string | undefined {
  const sync = source.last_manual_sync;
  if (!sync) return undefined;
  const at = Date.parse(sync.at);
  if (!Number.isFinite(at)) return undefined;
  const elapsed = now.getTime() - at;
  const when = elapsed < 60_000 ? 'just now' : dashboardRelativeFromMs(elapsed);
  switch (sync.outcome) {
    case 'checking':
      return dashboardManualSyncPendingLine(source.label);
    case 'busy':
      return dashboardManualSyncBusyLine(source.label);
    case 'failed':
      return when === 'just now'
        ? dashboardManualSyncFailedLine(source.label)
        : `Couldn't check ${source.label} ${when} — Olympus will try again on its own`;
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
    parts.push(DASHBOARD_NONE_READ_BY_POLICY);
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
  sourceProgress: '{stage} — {percent}%, {done} of {total} {unit}',
  /** One plain sentence per stalled reason; {source} is the source's name. */
  stalledReasons: {
    waiting_for_credentials: 'Paused: Olympus needs you to sign in to {source} again',
    scope_pending: 'Paused until you choose folders',
    provider_unavailable: 'Paused: {source} isn\'t responding; Olympus will retry',
    model_downloading: 'Waiting for the search model to finish downloading',
  },
  linkExpires: 'link expires in {n} min',
  linkExpired: 'link expired',
  /** Beside a control whose fix only the Mac can make: the fix's olympusplugin.ai help page. */
  howOnMac: 'Fix this on your computer',
  /** A source that is not moving and whose reason the engine did not send (never a blank row). */
  sourcePaused: 'Paused',
  /**
   * Sync now, pressed (2026-10-09): the control while its sync runs, and the
   * row's line until the dashboard's next read says the same ("Checking
   * Dropbox…", dashboardManualSyncPendingLine). The result line after it is
   * the engine's own (dashboardManualSyncLine), the same on both surfaces.
   */
  syncChecking: 'Checking…',
  syncCheckingLine: dashboardManualSyncPendingLine('{source}'),
  /** The disclosure under a row whose files can't be read (counts and reasons, never names). */
  seeWhy: 'See why',
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
} as const;

export const DASHBOARD_COMPUTER_PANEL_COPY = {
  section: 'On this computer',
  onlyHere: 'only here',
  open: 'Open',
  rows: {
    keys: { title: 'Keys', line: 'Venice, Readwise and X keys' },
    agents: { title: 'Agents', line: 'Remote access and connected agents' },
    outsideHelp: { title: 'Outside help', line: 'Anonymous answers (zkAPI)' },
    connector: { title: 'Build a connector', line: 'For a source Olympus does not have yet' },
  },
  /**
   * Why a control waits while the local dashboard controls are locked. The
   * computer's banner carries it, so the panel shows it beside no control
   * there; kept for a host without that banner.
   */
  locked: 'Open dashboard controls first',
  /** The OpenClaw tab for a connection without operator.write. */
  readOnlyOpenClaw: 'Reconnect OpenClaw with operator.write access to change this',
  indexFaster: DASHBOARD_INDEX_FASTER,
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
  changeModels: 'Change',
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
  connected: '{source} is connected.',
  foldersTitle: 'Choose folders',
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
  /** The answer was withdrawn on the Mac after it was shown (an item is no longer Private-eligible). */
  withdrawn: 'This private answer is no longer available from your computer.',
  /**
   * The outside block's own container (design docs/design/frontier-consult-lane.md
   * §A.6): its application-owned attribution, pinned while the text scrolls.
   */
  outsideTitle: 'Anonymous answer · zkAPI',
  outsideNote: 'General information from an outside model. It did not read your documents and has not been checked.',
  /** The container shows while an outside reply is on its way, or paused. */
  outsidePending: 'Looking up general background…',
  outsidePaused: 'Anonymous answers are paused.',
  /** The label over the exact question(s) sent, shown above the reply: the general level, then the unnamed level. */
  outsideAsked: 'What Olympus asked:',
  outsideSentUnnamed: 'Sent without names:',
  /** The application-owned footer when the reply was shortened. */
  outsideShortened: 'Shortened by Olympus.',
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
 * The Outside help card (outside-help.ts; design frontier-consult-lane.md
 * §A.10 for the disclosure, §A.14 for the enable flow). Plain words, no
 * content: the card never shows a question, a reply, a key or the daemon's
 * configuration. "Daemon" is the program's own name for itself; the card
 * says "the zkapi-clientd program".
 */
export const DASHBOARD_OUTSIDE_HELP_COPY = {
  crumb: 'Anonymous answers',
  title: 'Anonymous answers · zkAPI',
  /** Setup's section heading and its one row (owner naming, 2026-10-07). */
  sectionTitle: 'Private answers',
  row: {
    off: 'Anonymous answers (zkAPI): off',
    on: 'Anonymous answers (zkAPI): on',
    invalid: 'Anonymous answers (zkAPI): off · settings file damaged',
    route_not_configured: 'Anonymous answers (zkAPI): off · not set up',
    fence_held: 'Anonymous answers (zkAPI): paused · unfinished payment',
    needs_acceptance: 'Anonymous answers (zkAPI): paused · accept the updated statements',
  },
  /** The honesty label: the network route is not verified on macOS, said plainly. */
  experimental: 'Experimental: on macOS, Olympus can\'t yet confirm the connection is anonymous (network route not verified).',
  /** What outside help is, before anything technical (owner, 2026-10-07). */
  intro: 'For people running a strong local model at home: ask frontier models anonymously when your model needs help. When the answer from your computer is missing something, Olympus can send a top AI model a short question through zkAPI, paid and sent anonymously, with identifiers removed. The provider reads the question, and an unusual situation could still hint at who you are.',
  /** What zkAPI may send (owner titles 2026-10-08; internal ids 'unnamed' and 'general'). */
  levelTitle: 'What may zkAPI send?',
  /** Who writes the outside question (owner decision 2026-10-10): the built-in model, or the owner's own. No gate on the model. */
  writer: {
    title: 'Who writes the question',
    builtInShort: 'the model built into Olympus',
    intro: 'By default the small model built into Olympus writes the outside question from the first answer. If you run a stronger model at home (Ollama, LM Studio, a llama.cpp server, or a home server), Olympus can use it instead: it reads the private material the answer used, decides whether a frontier model would help, and writes the question in its own words. Olympus\'s privacy check still runs before anything is sent. This works best with a substantial model.',
    currentBuiltIn: 'Now: the model built into Olympus.',
    currentOwn: 'Now: your model {model} at {address}.',
    baseUrl: 'Your model server\'s address (OpenAI-compatible, usually ending in /v1)',
    model: 'Model name',
    secretRef: 'Key reference, if your server needs one (optional: env:NAME or store:name)',
    where: 'Your private material goes to this address, so use a server you control. A server on another computer is reached over your network; prefer https or a private network such as a tailnet.',
    keyMissing: 'The key reference {secretRef} is not set on this computer, so your model cannot be used until it is.',
    frontierModel: 'zkAPI model for questions from ChatGPT (optional)',
    frontierHint: 'A model from a provider other than OpenAI is better here: OpenAI also holds your ChatGPT conversation and could link the two. Empty uses the zkAPI route\'s own model.',
    openAiNote: 'Questions from ChatGPT now go to {model}, an OpenAI model. OpenAI also holds your ChatGPT conversation; a model from another provider is better here.',
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
      title: 'Standard (recommended)',
      body: 'Sends your actual question with names, places, exact dates, amounts and account numbers removed. Gets real answers.',
    },
    general: {
      title: 'Strict',
      body: 'Sends only general questions; nothing about your situation leaves. Safest, but rarely helpful.',
    },
  },
  levelSave: 'Save',
  /** Standard chosen while the statements are not accepted: they show inline with one action. */
  levelAcceptSave: 'Accept and save',
  levelAcceptIntro: 'Nothing is sent until you accept these:',
  /** The public privacy line, in plain words (design §2, §A.10). */
  privacy: 'Your files and private answer stay on this computer. The outside model sees only the short question, and that question could still hint at private things.',
  state: {
    off: 'Anonymous answers are off.',
    on: 'Anonymous answers are on.',
    invalid: 'Anonymous answers are off: the settings file on this computer is damaged.',
    route_not_configured: 'Anonymous answers are off: zkAPI is not set up yet.',
    fence_held: 'Paused: an earlier question has not finished paying yet.',
    needs_acceptance: 'Paused until you accept the updated statements below.',
  },
  /** Said only when a saved change needs a restart this worker could not do itself. */
  restartPending: 'Saved, but not applied yet: this Olympus cannot restart itself. Restart Olympus to apply the change.',
  /** The status block: route health in one line. */
  routeReady: 'Ready to ask.',
  routeReadyNoTor: 'Ready to ask.',
  /** Said beside Ready when Tor is off, in plain words (Details names Tor). */
  addressVisible: 'Your network address will be visible to the provider.',
  routeNotReady: 'Not ready: {reason}',
  /** Only the statements are missing: everything else is ready, said without repeating them. */
  routeReadyButStatements: 'Everything else is ready.',
  routeMore: '(+{n} more below)',
  routeUnknown: 'Olympus could not check zkAPI right now.',
  routeMissingShort: 'Not ready: zkAPI is not set up yet.',
  /**
   * Today's usage. Only the $6 hold per question is recorded, never the
   * settled price, so the day's figure is said as what counts against limits,
   * never as money spent.
   */
  usageNone: 'No questions today',
  usageOne: '1 question today',
  usageMany: '{n} questions today',
  usageCounted: '(counted as up to ${usd} against your limits)',
  usageExpiry: 'balance expires about {date} ({days} days left)',
  usageExpired: 'balance past its estimated expiry',
  usageExpiryUnknown: 'balance expiry unknown',
  /** How cost works, real cost first, in one line (owner, 2026-10-08); the statements carry the recorded wording. */
  costLine: 'A question usually costs a few cents. Up to $6 is held while it runs, and the rest comes back.',
  problemsTitle: 'To fix',
  disclosureTitle: 'Before you turn this on',
  /** Two short lines at first view; the fuller detail sits behind disclosureMore. */
  disclosureShort: [
    'It asks on its own: when an answer from your computer is missing something, Olympus may send one short question. You can turn it off at any time.',
    'The provider reads the question, with names and identifying details removed; zkAPI hides who paid.',
  ],
  disclosureMore: 'Everything to know first',
  /**
   * The fuller detail, in calm words (owner, 2026-10-08). It keeps what the
   * shorter statements leave out: the timing window, the $6 counted against
   * limits, no default limit, deposit fees and no top-up, the estimated
   * expiry date, the fee buffer, the API key and key reuse, the operator
   * and the proof setup, and that the route is not verified on macOS.
   */
  disclosure: [
    'Olympus sends a question only within about five minutes of a private answer appearing in ChatGPT, and only if the panel was recently active. Closing the panel does not guarantee nothing is sent in that window.',
    'A question usually costs a few cents. While it runs, up to $6 of your zkAPI balance is held, and the rest comes back when it settles. Olympus counts each question as $6 when checking the daily limits you set.',
    'There is no daily limit unless you set one under Balance and limits. Your balance is the most that can be spent.',
    'Adding money and taking it out are each an Ethereum transaction with its own network fee (about $7 each when Olympus last checked). There is no top-up: each deposit starts a new balance with its own fee and its own 30-day clock.',
    'Olympus estimates the 30-day date from the funding date you enter; the exact date is set on-chain when the deposit is confirmed.',
    'When you add money, send one transfer with the deposit plus the fee buffer zkapi-clientd shows. Network fees move, so the buffer can fall short and need a second transfer.',
    'Set zkapi-clientd to require an API key, so only Olympus on this computer can spend the balance. Olympus refuses to send while key reuse is on, so separate questions are not linked by a shared payment key.',
    'One operator account can pause deposits and withdrawals while the 30-day clock keeps running, and one party ran zkAPI\'s proof setup. Your balance lives in files on this computer; losing them loses the money.',
    'The provider reads the question; zkAPI hides who paid. On macOS, Olympus cannot yet confirm the network route is anonymous.',
  ],
  routeMissing: 'zkAPI is not set up. Add it, then follow Set up zkAPI below.',
  policyNotFile: 'Your privacy policy is not kept in a file on this computer, so the route must be added where that policy lives.',
  addRoute: 'Add zkAPI to Olympus',
  addRouteConfirm: 'This adds a consult-only zkAPI route to your privacy policy and restarts the Olympus worker. No money moves. Continue?',
  /** The Details disclosure: the route's technical facts, never on first view. */
  detailsTitle: 'Details',
  facts: {
    daemon: 'zkapi-clientd {version} found',
    versionUnknown: '(version unknown)',
    daemonMissing: 'zkapi-clientd not installed',
    tor: 'Tor found (a fresh Tor client per consult)',
    torOff: 'Tor off: the route is direct and your network address is visible to the provider',
    torMissing: 'Tor not installed',
    key: 'API key configured',
    keyMissing: 'API key not configured',
    today: '{n} requests today (${usd} counted at $6 each)',
    todayOne: '1 request today (${usd} counted at $6 each)',
    expiry: 'balance estimated to expire {date} ({days} days left)',
    expired: 'balance past its estimated expiry',
    expiryUnknown: 'balance expiry unknown until you enter the funding date',
  },
  routeLabel: 'Route: {label}.',
  lastSession: 'Last consult: {at}, {result}.',
  /** The To fix list: plain words, each with where its fix is. Technical names stay in Set up zkAPI and Details. */
  blockers: {
    daemon_not_found: 'The zkAPI app is not installed on this computer. See Set up zkAPI.',
    daemon_version_unsupported: 'This version of the zkAPI app has not been checked by Olympus. Install version 0.1.5 or 0.1.6: see Set up zkAPI.',
    tor_not_found: 'The program that hides your network address is not installed. See Set up zkAPI.',
    daemon_api_key_missing: 'Olympus does not have your zkAPI access key yet. See Set up zkAPI.',
    acknowledgements_incomplete: 'The statements on this page are not accepted yet. Nothing is sent until they are.',
    funding_date_missing: 'Enter the day you paid in under Balance and limits, so Olympus can tell when the balance expires.',
    funding_date_invalid: 'The day you paid in is in the future. Fix it under Balance and limits.',
    note_expired: 'Your balance is past its estimated 30-day expiry.',
    unresolved_session: 'An earlier question has not finished paying. Use Recover under Unfinished payment.',
    unresolved_session_other_wallet: 'An unfinished payment belongs to another zkAPI wallet. Finish it there, or abandon it under Unfinished payment.',
    stranded_processes: 'Programs from an earlier question may still be running.',
    daemon_already_running: 'Another copy of the zkAPI app is already running. Close it; Olympus starts its own for each question.',
    tor_port_busy: 'Another program is using the connection Olympus needs to hide your network address.',
    daily_cap_reached: 'Today\'s question limit is reached. Raise or remove it under Balance and limits.',
    spend_cap_reached: 'Another question would pass today\'s spending limit. Raise or remove it under Balance and limits.',
    state_unavailable: 'Olympus could not read its record of questions on this computer.',
    key_reuse_on: 'The zkAPI app is set to reuse payment keys, which can link your questions. Turn that off: see Set up zkAPI.',
  },
  blockerOther: 'Not ready yet ({code}).',
  stepsTitle: 'Set up zkAPI',
  stepsIntro: 'Install the parts above with one click, then run the rest in Terminal, in this order. This is the order that worked live.',
  steps: [
    'Install Tor and zkAPI with the button above (or run olympus zkapi install-tools). If you installed them yourself, zkapi-clientd must be version 0.1.5 or 0.1.6.',
    'Run: zkapi-clientd config --usd N. Send one transfer: the deposit plus the fee buffer the tool shows. Network fees move, so the buffer can fall short and need a second transfer.',
    'Wait until the tool prints "Private inference balance activated".',
    'Run: zkapi-clientd config --relay-url socks5://127.0.0.1:19050',
    'Run: zkapi-clientd config --require-api-key',
    'Run: zkapi-clientd config --api-key <key>. Store the same key where the route\'s key reference points ({secretRef}); for env:NAME that is a NAME=<key> line in ~/.config/olympus/worker.env (owner-only), then restart the Olympus worker.',
    'Run: zkapi-clientd config --key-reuse-window-seconds 0. Olympus refuses to send while the key-reuse window is on.',
  ],
  costTitle: 'Cost and risk',
  costIntro: 'Nothing is sent until you accept these. If the wording changes, you are asked again.',
  accept: 'Accept',
  acknowledged: 'You accepted the {n} cost and risk statements.',
  acknowledgedReview: 'Review',
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
  capUsd: 'Daily spending limit in dollars, counted at $6 per question (optional)',
  noLimitIntro: 'There is no daily limit unless you set one. Your balance is the most that can be spent.',
  removeLimits: 'No daily limit',
  removeLimitsHint: 'Clears both limits.',
  saveRestarts: 'Saving restarts Olympus to apply it.',
  saveRoute: 'Save',
  fenceTitle: 'Unfinished payment',
  fenceIntro: 'An earlier question has not been confirmed as paid. Until it is, no question is sent.',
  fenceThis: 'Held since {at} (this wallet)',
  fenceOther: 'Held since {at} (another wallet folder)',
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
  edit: 'Edit',
  setUp: 'Set up',
  saving: 'Saving…',
  saveFailed: 'Olympus could not save this. Try again.',
  /** A refusal that carried no words of its own: the HTTP status at least. */
  saveFailedStatus: 'Olympus could not save this (error {status}). Try again.',
  /** No answer at all, usually because Olympus is restarting. */
  saveUnreachable: 'Olympus did not answer. If it is restarting, wait a moment and try again.',
  restarting: 'Restarting Olympus to apply it…',
  locked: 'Open dashboard controls to see and change anonymous answers.',
  unlockIntro: 'Changing anonymous answers needs a session opened on this computer itself, not one an agent or the launch link opened. One click, in this browser.',
  unlock: 'Unlock anonymous answers on this computer',
  native: 'Anonymous answers are set up on this computer\'s own dashboard only, never from an agent or ChatGPT.',
  unavailable: 'Anonymous answers are not available from this worker.',
} as const;
