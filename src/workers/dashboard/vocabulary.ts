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
  if (degradationForSource(source, input.degradedCredentials)) {
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
      return freshLine(source);
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
  const degradation = degradationForSource(source, options?.degradedCredentials);
  if (degradation) {
    const clause = degradationClause(degradation);
    return clause ? `credential unavailable · ${clause}` : 'credential unavailable';
  }
  // The provider's own refusal, in this page's bounded words. It replaces every
  // connection-state line below, because "not connected" over an attempt the
  // provider explicitly rejected explains nothing the owner can act on.
  const refusal = source.connection.provider_refusal;
  if (refusal) return refusal.reason;
  switch (source.connection.state) {
    case 'reauth_required':
      return 'reauth required';
    case 'awaiting_consent': {
      // The label is the provider's own name off the card, so the sentence
      // points at the tab the owner is actually looking at.
      const base = `waiting for you to approve in the ${source.label} tab`;
      const minutes = source.connection.pending?.expires_in_minutes;
      return minutes !== undefined && minutes > 0
        ? `${base} · expires in ${dashboardDuration(minutes * 60)}`
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
        ? 'connection lost · reauthenticate to resume syncing'
        : source.connection.label;
    default:
      break;
  }
  if (source.answer_readiness.state === 'needs_attention') return lowerFirst(source.answer_readiness.label);
  // Owner ruling, 2026-08-24: NO ERROR COUNTS ANYWHERE. This line used to end
  // "3 items need attention · 1 task retrying", which is a number about queue
  // depth dressed as a number about the reader's data — and the reader can do
  // nothing with either figure. The row still says which of the two states it
  // is in, because the row exists and has to explain itself; it just stops
  // quantifying a fault nobody can act on by the size of it.
  if (source.queue_health.needs_attention > 0) return 'some work is stuck part-way through';
  if ((source.queue_health.retrying_tasks ?? 0) > 0) return 'a sync task is retrying itself';
  return '';
}

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
  if (paused > 0) parts.push(`ingestion paused on ${dashboardCount(paused)} ${plural(paused, 'source')}`);
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
    read_percent: readPercent,
    ...(searchablePercent !== undefined ? { searchable_percent: searchablePercent } : {}),
    fully_working: read >= inScope && !parityShort,
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
    return `everything in scope is working — ${dashboardCount(summary.in_scope_items)}`
      + ` ${plural(summary.in_scope_items, 'file')}`;
  }
  const read = `${formatPercent(summary.read_percent)} of text extracted`;
  return summary.searchable_percent === undefined
    ? read
    : `${read} · ${formatPercent(summary.searchable_percent)} searchable until re-embed completes`;
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

function freshLine(source: DashboardSourceCard): string {
  // The answer lane has nothing to sync, and its freshness label is the only
  // field that says so.
  if (source.freshness.label.startsWith('Answer lane:')) return 'answers questions directly';
  const hours = source.freshness.hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return '';
  const relative = dashboardRelativeFromHours(hours);
  if (!relative) return '';
  // A lane Olympus parked is calm, not idle by accident. Saying so keeps this
  // line from implying the sync is still running, and matches the detail
  // page's paused sentence for the same marker.
  return dashboardOperatorPaused(source) ? `synced ${relative} · sync paused` : `synced ${relative}`;
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
  const firstIngest = source.freshness.label === DASHBOARD_FIRST_SYNC_FRESHNESS_LABEL ? 'first ingest' : undefined;
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
  return parts.join(' · ');
}

function waitingLine(source: DashboardSourceCard): string {
  if (dashboardScopePending(source)) {
    return source.scope_selection?.kind === 'mail' ? 'waiting for mail selection' : 'waiting for folder selection';
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
      return 'resolved · restart required';
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
function degradationForSource(
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

function lowerFirst(value: string): string {
  return value.length > 0 ? value[0]!.toLowerCase() + value.slice(1) : value;
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
  installingModel: 'Getting search ready on your Mac',
  installingFirstIndex: 'Indexing your sources for the first time',
  connectOnMac: 'Connect sources in Olympus on your Mac.',
  reconnect: 'Reconnect',
  checkAgain: 'Check again',
  openOnMac: 'Open Olympus on your Mac',
  stageReading: 'Reading',
  stageSearchable: 'Indexing',
  embeddingNeedsAttention: 'Search has stopped working on your Mac.',
  answerModelNeedsAttention: 'Answers have stopped working on your Mac.',
  fixOnMac: 'Open Olympus on your Mac to fix this.',
  privateMatches: 'Some matching items are private and stay on your Mac.',
  changeModelsOnMac: 'Change models in Olympus on your Mac.',
} as const;

/**
 * The ChatGPT dashboard's own copy for the five connection states. The view
 * model carries only the state; the page owns these words (the relay renders
 * two of the states without reading this file). `disabledReason` is printed
 * beside every other control while the state holds.
 */
export const DASHBOARD_CHATGPT_CONNECTION_COPY = {
  not_installed: {
    title: 'Olympus isn\'t on your Mac yet',
    disabledReason: 'Install Olympus first',
  },
  installing: {
    title: 'Installing Olympus on your Mac…',
    disabledReason: 'Available once Olympus is set up',
  },
  mac_offline: {
    title: 'Your Mac is offline or asleep, so answers are paused',
    lastSeen: 'Last seen {when}',
    disabledReason: 'Your Mac is offline',
  },
  relay_unavailable: {
    title: 'Olympus can\'t reach your Mac right now; retrying',
    disabledReason: 'Can\'t reach your Mac',
  },
  /** Labels for `connection.action.id`; `help` is shown as text when the action has no link. */
  actions: {
    install: { label: 'Install on your Mac', help: 'In ChatGPT on your Mac, ask: Install Olympus on my Mac.' },
    open_olympus: { label: 'Open Olympus on your Mac', help: 'Open Olympus on your Mac, then check again here.' },
    wake_mac: {
      label: 'How to keep it available',
      help: 'Keep your Mac on, awake and online with Olympus running. Answers resume on their own when it is back.',
    },
    retry: { label: 'Try again', help: '' },
  },
} as const;

/** Every other word the ChatGPT dashboard page prints. */
export const DASHBOARD_CHATGPT_PAGE_COPY = {
  title: 'Olympus',
  loading: 'Checking your Mac…',
  upToDate: 'Olympus is up to date.',
  needsYou: 'Needs you',
  sources: 'Sources',
  sourcesLocal: 'On your Mac',
  sourcesCloud: 'Accounts',
  sourcesOnMac: 'Set up on your Mac',
  sourcesOnMacHelp: 'These connect on your Mac in Olympus. They\'ll show up here once connected.',
  notConnected: 'Not connected',
  noSources: 'No sources yet.',
  progress: 'Progress',
  progressInitial: 'First index',
  progressRefresh: 'Catching up',
  percentDone: '{percent}% done',
  left: '{count} {unit} left',
  eta: 'about {duration}',
  stalled: 'stalled',
  progressPaused: 'paused while your Mac is offline',
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
} as const;

/**
 * Control labels the ChatGPT producer puts on setup fixes
 * (src/workers/chatgpt/dashboard-view-model.ts, which proposed them as
 * CHATGPT_SETUP_LABELS). Closed set, owner words.
 */
export const DASHBOARD_CHATGPT_SETUP_LABELS = {
  connect: 'Connect',
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
 * Words for the ChatGPT page's privacy setup (src/workers/dashboard/chatgpt/privacy.ts)
 * and the dashboard's Privacy row. Two tiers are a person's to choose:
 * shared with ChatGPT (the default) and private (answered on the Mac only);
 * secrets are detected on the Mac and never a choice. Folder, label and
 * sender names and the person's own description are never part of this copy.
 */
export const DASHBOARD_CHATGPT_PRIVACY_COPY = {
  back: 'Back to Olympus',
  title: 'What\'s private for you?',
  intro: 'Olympus shares your items with ChatGPT unless you say they\'re private. Private items are answered on your Mac and never sent to ChatGPT. Passwords and other secrets are always kept on your Mac.',
  loading: 'Loading your privacy settings…',
  loadFailed: 'Olympus could not load your privacy settings. Try again.',
  tryAgain: 'Try again',
  descriptionLabel: 'In your own words',
  descriptionPlaceholder: 'For example: my health and therapy, money and taxes, anything about my kids, my divorce',
  rulesTitle: 'Always private (optional)',
  rulesEmpty: 'No folders, labels or senders yet.',
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
    one: '{n} item is waiting to be checked on your Mac.',
    many: '{n} items are waiting to be checked on your Mac.',
  },
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  saveFailed: 'Olympus could not save. Your changes are still here. Try again.',
  saved: 'Privacy saved.',
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
  labelIntro: 'Mail with a private label is answered only on your Mac.',
  loadingLabels: 'Loading your labels…',
  noLabels: 'This mailbox has no labels of its own.',
  sentLabel: 'Sent',
  senderTitle: 'Add a sender',
  senderIntro: 'Mail from this sender is answered only on your Mac.',
  senderLabel: 'Email address or @domain',
  senderPlaceholder: 'name@example.com or @example.com',
  senderAdd: 'Add',
  senderInvalid: 'Enter an email address like name@example.com, or a domain like @example.com.',
  senderDuplicate: 'That sender is already private.',
  section: 'Privacy',
  row: {
    one: 'Your description and {n} always-private rule',
    many: 'Your description and {n} always-private rules',
  },
  rowNoCount: 'Your description and always-private rules',
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
