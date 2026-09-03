/**
 * Background: the work the owner never asked for by hand — embedding, vision
 * extraction, scheduled syncs, the drains and supervisors — one block per lane
 * and nothing the evidence cannot support.
 *
 * THE LAW THIS PAGE OBEYS (owner ruling, 2026-08-24): no lane may be non-moving
 * without a printed reason. The complaint it answers, verbatim: "78% embedded —
 * I have no idea if it's stuck or moving. Way too often things are just stuck
 * for unknown reasons." A percentage is a denominator, not a verb, so every lane
 * here resolves to exactly one state and each state owes the reader something
 * specific:
 *   ACTIVE   progress, a trailing rate in the lane's own units, an ETA where one
 *            is derivable, and how long since the lane's own heartbeat moved.
 *   WAITING  the governing condition, quoted from the arbiter that decided it —
 *            the overnight guard's park line, the supervisor's provider pause,
 *            the scheduler's booked next run, a daily-budget park.
 *   DONE     one quiet line, and nothing else.
 *   unknown  the words "state unknown" plus what was consulted and found
 *            silent. Never a guess; a test pins this.
 *
 * WHERE THE MOVEMENT EVIDENCE COMES FROM. The drains and supervisors each
 * rewrite a `*-current.json` on every heartbeat, carrying `heartbeat_seq`,
 * `updated_at` and their own cumulative counters. background-runtime.ts reads
 * them and keeps a trailing sample window; lane-state.ts turns that window into
 * a rate and decides the state. This page only writes sentences.
 *
 * THERE IS NO FAILURES LANE (owner ruling). The source pages settled this shape
 * and it holds here: a condition the system is already fixing renders NOTHING,
 * and only two things reach the top of the page — a lane the stuck detector
 * caught, and a condition that genuinely needs a person. A list of everything
 * that has ever gone wrong trains the owner to stop reading the page.
 *
 * WHAT IS STILL NOT CLAIMED. No per-hour history, no batch series and no lane
 * event stream exists upstream, so no sparkline, no batch strip and no feed is
 * drawn. The one strip that IS drawn is real: the last recorded run of each
 * scheduled source.
 */
import type { DashboardSourceCard, SourceDashboardViewModel } from '../../source-dashboard.ts';
import {
  DASHBOARD_LANE_CSS,
  attentionRow,
  controlScript,
  escapeHtml,
  miniBar,
  pageShell,
  safeHref,
  type DashboardBackgroundRowLine,
  type DashboardLaneStripItem,
  type DashboardLaneTone,
} from '../components.ts';
import type { BackgroundRuntimeFacts, BackgroundLaneRuntime } from '../background-runtime.ts';
import type { EmbeddingRunState, EmbeddingRuntimeFacts } from '../embedding-runtime.ts';
import {
  armLaneBanners,
  deriveLaneState,
  type DashboardLaneActionable,
  type DashboardLaneBanner,
  type DashboardLaneGoverningCondition,
  type DashboardLaneQueuedItem,
  type DashboardLaneStateKind,
  type DashboardLaneStatus,
} from '../lane-state.ts';
import { DASHBOARD_NAV_CSS, renderDashboardNav } from '../nav.ts';
import { OPERATOR_PAUSED_SCHEDULER_MARKERS } from '../scheduler-markers.ts';
import {
  dashboardCheckedLabel,
  dashboardCount,
  dashboardDuration,
  dashboardRelativeFromMs,
} from '../vocabulary.ts';
import type { DashboardPageOptions } from './home.ts';

/** How many rows the recent-runs table will draw. */
const RECENT_RUN_LIMIT = 8;

const DEFAULT_BASE_PATH = '/dashboard';

/** Duplicated from index.ts, which imports this module: one string, no cycle. */
const DETAIL_QUERY_PARAM = 'source';

/**
 * The embedding ledger's address. Another page owns it; this is a link and
 * nothing more, so nothing here depends on it existing yet.
 */
const EMBEDDING_LEDGER_QUERY_PARAM = 'embedding-ledger';

/**
 * The page's own options: everything home's renderer takes, plus the lane
 * reports the worker read before the render.
 *
 * Extended here rather than on DashboardPageOptions because that interface is
 * home's and this field is only ever read by this page. Every member is
 * optional, so a caller holding a plain DashboardPageOptions still satisfies it
 * and index.ts needs no change to pass one through.
 */
export interface DashboardBackgroundPageOptions extends DashboardPageOptions {
  /**
   * What the lanes' own report files said, read by the worker before the
   * render. Absent means the worker supplied nothing — every lane then falls
   * back to what the view model alone can support, which is honest and quiet
   * rather than a fabricated heartbeat.
   */
  backgroundRuntime?: BackgroundRuntimeFacts;
}

/**
 * What happens next about a failure, and who has to do it.
 *
 * `self_healing` may be claimed ONLY from a field that says something is
 * already going to run again — a parsed next_run_at, a retrying task count, an
 * embedding lane that is not disabled. Everything else is `needs_you`, because
 * "we don't know" and "it will fix itself" are not the same sentence.
 *
 * Retained because the disposition still decides what reaches the top of the
 * page: self-healing renders nothing at all, needs-you arms a banner.
 */
export type DashboardBackgroundDisposition = 'self_healing' | 'needs_you';

/** A condition found under a lane, with what happens about it next. */
export interface DashboardBackgroundCheck {
  name: string;
  observed: string;
  expectation?: string;
  cause?: string;
  ok: boolean;
  /** Required on every failing row; an ok row has nothing to dispose of. */
  disposition?: DashboardBackgroundDisposition;
  /** The real word for the retry state behind a self-healing row. */
  dispositionNote?: string;
  /** Where a needs-you row leads, when a page exists that can act on it. */
  href?: string;
  /** The link's own words, e.g. "Open Gmail →". */
  hrefLabel?: string;
}

export interface DashboardBackgroundLane {
  name: string;
  /** The one line of facts under the lane name. */
  facts: string;
  /** 0..1, only where a real denominator exists. */
  fraction?: number;
  /** True while the lane still has work of its own outstanding. */
  working: boolean;
  /** Heading for this lane's verdict tip. */
  checksHeading?: string;
  checks: DashboardBackgroundCheck[];
  strip?: DashboardLaneStripItem[];
  stripLabel?: string;
  /**
   * Pre-rendered HTML that sits under this lane's row.
   *
   * Only the embedding lane uses it, and only because that lane is the one with
   * facts a single line cannot carry — a run state, what governs it, the model,
   * and a control. Home ignores it: its background card is one line per lane by
   * design and this block would not fit there.
   */
  detail?: string;
}

/**
 * The lanes the VIEW MODEL can describe, in reading order.
 *
 * This is home's function and its shape is deliberately unchanged: home draws
 * one line per lane in a card, and the three lanes with a denominator or a queue
 * on the view model are exactly what fits there. The Background page builds a
 * richer list (backgroundLaneViews) that also includes the lanes known only
 * from their report files — those have no line for home's card, because home
 * cannot show a rate or a governing condition in one row.
 */
export function dashboardBackgroundLanes(
  view: SourceDashboardViewModel,
  options?: DashboardPageOptions,
): DashboardBackgroundLane[] {
  const now = options?.now ?? new Date();
  const basePath = options?.basePath;
  return [embeddingsLane(view, options), visionLane(view, basePath), syncsLane(view, now, basePath)]
    .filter((lane): lane is DashboardBackgroundLane => lane !== undefined);
}

/** This source's detail page, on whatever prefix carries the reader's token. */
function detailHref(source: DashboardSourceCard, basePath?: string): string {
  const path = basePath ?? DEFAULT_BASE_PATH;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${DETAIL_QUERY_PARAM}=${encodeURIComponent(source.source_id)}`;
}

/**
 * The action half of a needs-you row: the source's own detail page, which is
 * the one route that exists for every card and can act on any of these
 * failures. No control is offered here — a lane has no route of its own.
 */
function detailLink(
  source: DashboardSourceCard,
  basePath: string | undefined,
): { href: string; hrefLabel: string } {
  return { href: detailHref(source, basePath), hrefLabel: `Open ${source.label} →` };
}

/** The lines home draws inside its one background card. */
export function dashboardBackgroundRowLines(
  lanes: readonly DashboardBackgroundLane[],
): DashboardBackgroundRowLine[] {
  return lanes.map((lane) => ({
    name: lane.name,
    facts: lane.facts,
    ...(lane.fraction === undefined ? {} : { percent: lane.fraction * 100 }),
  }));
}

/* ------------------------------------------------------------ lane views -- */

/** One lane as this page draws it: a state, the numbers, and what is queued. */
interface BackgroundLaneView {
  id: string;
  name: string;
  status: DashboardLaneStatus;
  /** The denominator line, where the lane has one. */
  facts?: string;
  /** 0..1, only where a real denominator exists. */
  fraction?: number;
  queued: readonly DashboardLaneQueuedItem[];
  /** Pre-rendered HTML under the lane row — only the embedding panel. */
  detail?: string;
  strip?: readonly DashboardLaneStripItem[];
  stripLabel?: string;
}

/**
 * The self-pause markers, in the words the detail page already uses for them.
 *
 * Duplicated from detail.ts rather than imported: that map is private to a page
 * another builder owns, and reaching into it would couple two pages' copy
 * together. The ten keys here are exactly OPERATOR_PAUSED_SCHEDULER_MARKERS —
 * the markers that mean Olympus paused ITSELF and no reader action helps — so a
 * marker outside the set never reaches this map and is treated as a fault.
 */
const SCHEDULER_SELF_PAUSE_SENTENCES: Readonly<Record<string, string>> = {
  daily_api_request_guard: 'paused by the daily request budget until 00:00 UTC',
  daily_resource_read_guard: 'paused by the daily read budget until 00:00 UTC',
  daily_cost_guard: 'paused by the daily budget until 00:00 UTC',
  readwise_daily_api_request_guard: 'paused by the daily request budget until 00:00 UTC',
  gmail_daily_api_request_guard: 'paused by the daily request budget until 00:00 UTC',
  google_drive_daily_api_request_guard: 'paused by the daily request budget until 00:00 UTC',
  head_api_request_reserve_guard: 'paused by the daily request budget until 00:00 UTC',
  head_resource_read_reserve_guard: 'paused by the daily read budget until 00:00 UTC',
  head_cost_reserve_guard: 'paused by the daily budget until 00:00 UTC',
  provider_rate_limit: 'the provider is rate-limiting this source right now',
};

/** The runtime lane with this id, when the worker read one. */
function runtimeLane(
  runtime: BackgroundRuntimeFacts | undefined,
  id: string,
): BackgroundLaneRuntime | undefined {
  return runtime?.lanes.find((lane) => lane.id === id);
}

/**
 * Every lane this page draws, in reading order.
 *
 * The three view-model lanes come first because they are the ones with
 * denominators the owner recognises, then every reporting lane the worker read
 * that is not already one of them. A lane whose report file is absent is not
 * here at all: absent means the host does not run it, and a row reading zero for
 * an uninstalled lane is the same lie as a percentage with no verb.
 */
function backgroundLaneViews(
  view: SourceDashboardViewModel,
  options: DashboardBackgroundPageOptions | undefined,
  now: Date,
): BackgroundLaneView[] {
  const runtime = options?.backgroundRuntime;
  const views: BackgroundLaneView[] = [];
  const embeddings = embeddingsLaneView(view, options, now);
  if (embeddings) views.push(embeddings);
  const vision = visionLaneView(view, options, now);
  if (vision) views.push(vision);
  const syncs = syncsLaneView(view, options, now);
  if (syncs) views.push(syncs);
  // Every other reporting lane, exactly as its own report describes it. The
  // embedding drain is excluded because the embeddings lane above already IS it
  // — merged with the chunk denominator the view model carries.
  for (const lane of runtime?.lanes ?? []) {
    if (lane.id === 'embedding-drain') continue;
    views.push(runtimeOnlyLaneView(lane, now));
  }
  return views;
}

/** A reporting lane with no view-model half: state, rate, heartbeat, queue. */
function runtimeOnlyLaneView(lane: BackgroundLaneRuntime, now: Date): BackgroundLaneView {
  const status = deriveLaneState({
    name: lane.name,
    unit: lane.unit,
    samples: lane.samples,
    ...(lane.lastActivityAt === undefined ? {} : { lastActivityAt: lane.lastActivityAt }),
    ...(lane.remaining === undefined ? {} : { remaining: lane.remaining }),
    ...(lane.governing === undefined ? {} : { governing: lane.governing }),
    reportsLive: lane.reportsLive,
  }, now);
  const queued: DashboardLaneQueuedItem[] = lane.remaining !== undefined && lane.remaining > 0
    ? [{
      what: `${dashboardCount(lane.remaining)} ${lane.unit} not yet processed`,
      waitingOn: waitingOnPhrase(status, lane.name),
    }]
    : [];
  return { id: lane.id, name: lane.name, status, queued };
}

/**
 * What a queued item is waiting on, in the lane's own current state.
 *
 * A queue line whose second half is missing is the page the owner already had —
 * a number with no explanation — so this never returns an empty string.
 */
function waitingOnPhrase(status: DashboardLaneStatus, laneName: string): string {
  if (status.kind === 'waiting' && status.reason !== undefined) {
    return `${laneName}, which is waiting: ${status.reason}`;
  }
  if (status.kind === 'active') return `${laneName}, which is working through them now`;
  if (status.stuck !== undefined) return `${laneName}, which is not moving`;
  return `${laneName}, whose state is unknown`;
}

/**
 * The embeddings lane: the chunk denominator from the view model, the movement
 * from the drain's own report, and the arbitration from the guard.
 *
 * Three sources for one lane because no single one of them can answer the
 * owner's question: the view model knows how much is left and nothing about
 * speed, the drain report knows the speed and no denominator, and only the
 * guard knows why either of them is idle.
 */
function embeddingsLaneView(
  view: SourceDashboardViewModel,
  options: DashboardBackgroundPageOptions | undefined,
  now: Date,
): BackgroundLaneView | undefined {
  const backlog = view.background_work?.embedding_backlog;
  const disabled = view.background_work?.embedding_lane_state === 'embedding_lane_disabled';
  const embeddingRuntime = options?.embeddingRuntime;
  const lane = runtimeLane(options?.backgroundRuntime, 'embedding-drain');
  if (!backlog && !disabled && !embeddingRuntime && !lane) return undefined;
  const governing = embeddingGoverning(lane, embeddingRuntime, disabled);
  const fraction = backlog && backlog.chunks > 0
    ? clampFraction(backlog.embedded_chunks / backlog.chunks)
    : undefined;
  const facts: string[] = [];
  if (fraction !== undefined) facts.push(`${Math.round(fraction * 100)}% embedded`);
  if (backlog) {
    facts.push(backlog.missing_chunks > 0
      ? `${compactCount(backlog.missing_chunks)} of ${compactCount(backlog.chunks)} chunks left`
      : `all ${compactCount(backlog.chunks)} chunks embedded`);
    if (backlog.refresh_needed) facts.push('re-embed needed');
  }
  const status = deriveLaneState({
    name: 'Embeddings',
    unit: 'chunks',
    ...(lane?.samples === undefined ? {} : { samples: lane.samples }),
    ...(lane?.lastActivityAt === undefined ? {} : { lastActivityAt: lane.lastActivityAt }),
    ...(backlog === undefined ? {} : { remaining: backlog.missing_chunks }),
    ...(governing === undefined ? {} : { governing }),
    // The drain's own run report counts as the lane reporting live: the panel
    // below used to say "running now" under a headline reading "state
    // unknown" because only the runtime lane's heartbeat was consulted
    // (owner note, 2026-09-01).
    reportsLive: lane?.reportsLive === true
      || embeddingRuntime?.state === 'running'
      || embeddingRuntime?.state === 'operator_priority',
  }, now);
  const queued: DashboardLaneQueuedItem[] = backlog && backlog.missing_chunks > 0
    ? [{
      what: `${dashboardCount(backlog.missing_chunks)} chunks not yet embedded`,
      waitingOn: waitingOnPhrase(status, 'the embedding drain'),
    }]
    : [];
  return {
    id: 'embeddings',
    name: 'Embeddings',
    status,
    ...(facts.length === 0 ? {} : { facts: facts.join(' · ') }),
    ...(fraction === undefined ? {} : { fraction }),
    queued,
    ...(embeddingRuntime === undefined
      ? {}
      : { detail: renderEmbeddingDetail(embeddingRuntime, options) }),
  };
}

/**
 * Who decided the embedding lane is not running, in their own words.
 *
 * The guard's park line is preferred because it names the actual reason ("
 * metadata frontier pending"); the runtime panel's state line is the fallback
 * because it is already a written sentence about the same arbitration. A
 * disabled lane outranks both — nothing will pick the work up at all, and that
 * is not the guard's doing.
 */
function embeddingGoverning(
  lane: BackgroundLaneRuntime | undefined,
  runtime: EmbeddingRuntimeFacts | undefined,
  disabled: boolean,
): DashboardLaneGoverningCondition | undefined {
  if (disabled) {
    return {
      text: 'the embedding lane is switched off for this corpus',
      decidedBy: 'the corpus configuration',
    };
  }
  if (lane?.governing !== undefined) return lane.governing;
  if (runtime === undefined) return undefined;
  if (PARKED_EMBEDDING_STATES.has(runtime.state)) {
    // The panel writes its line as "Embeddings: parked — …" because it stands
    // alone down the page. Here it sits under a heading that already says
    // Embeddings, so the prefix is dropped rather than read twice.
    return { text: runtime.stateLine.replace(/^Embeddings:\s*/, ''), decidedBy: 'the overnight guard' };
  }
  return undefined;
}

/** The run states in which the embedding lane is knowingly not running. */
const PARKED_EMBEDDING_STATES: ReadonlySet<EmbeddingRunState> = new Set<EmbeddingRunState>([
  'parked',
  'guard_paused',
]);

/**
 * Vision extraction: a queue depth from the view model, a heartbeat from the
 * ingestion health block, and a held or disabled drain as the governing reason.
 *
 * `last_drain_activity_hours` is the lane's real heartbeat — the ingestion
 * ledger's own record of when this drain last did anything — so this lane can
 * answer "is it moving" without a report file of its own.
 */
function visionLaneView(
  view: SourceDashboardViewModel,
  options: DashboardBackgroundPageOptions | undefined,
  now: Date,
): BackgroundLaneView | undefined {
  const queued = view.background_work?.vlm_extraction_queued;
  const held = view.sources.filter((source) => source.ingestion_health.drain_state === 'held');
  const off = view.sources.filter((source) => source.ingestion_health.drain_state === 'disabled');
  const stuck = view.sources.filter((source) => source.ingestion_health.stuck_count > 0);
  if (queued === undefined && held.length === 0 && stuck.length === 0) return undefined;
  const facts: string[] = [];
  if (queued !== undefined) facts.push(`${dashboardCount(queued)} ${plural(queued, 'job')} queued`);
  const stuckItems = stuck.reduce((total, source) => total + source.ingestion_health.stuck_count, 0);
  if (stuckItems > 0) {
    facts.push(`${dashboardCount(stuckItems)} ${plural(stuckItems, 'item')} stuck`);
  }
  // The freshest drain activity any source reports: the lane is one drain, and
  // the most recent beat is the one that says whether it is alive.
  const activityHours = view.sources
    .map((source) => source.ingestion_health.last_drain_activity_hours)
    .filter((hours): hours is number => typeof hours === 'number' && Number.isFinite(hours))
    .sort((left, right) => left - right)[0];
  const stopped = [...held, ...off][0];
  const governing: DashboardLaneGoverningCondition | undefined = stopped === undefined
    ? undefined
    : {
      text: stopped.ingestion_health.drain_state === 'held'
        ? `extraction is held on ${stopped.label}`
        : `extraction is switched off on ${stopped.label}`,
      decidedBy: 'the extraction drain',
    };
  const status = deriveLaneState({
    name: 'Vision',
    unit: 'jobs',
    ...(activityHours === undefined
      ? {}
      : { lastActivityAt: new Date(now.getTime() - activityHours * 3_600_000) }),
    ...(queued === undefined ? {} : { remaining: queued }),
    ...(governing === undefined ? {} : { governing }),
    // A drain the ledger calls enabled is a lane claiming it is working; that
    // claim plus a stopped heartbeat is exactly what the stuck rule is for.
    reportsLive: held.length === 0 && off.length === 0
      && view.sources.some((source) => source.ingestion_health.drain_state === 'enabled'),
  }, now);
  const items: DashboardLaneQueuedItem[] = [];
  if (queued !== undefined && queued > 0) {
    items.push({
      what: `${dashboardCount(queued)} extraction ${plural(queued, 'job')} queued`,
      waitingOn: waitingOnPhrase(status, 'the vision extractor'),
    });
  }
  for (const source of stuck) {
    const retrying = source.queue_health.retrying_tasks ?? 0;
    items.push({
      what: `${dashboardCount(source.ingestion_health.stuck_count)} stuck ${plural(source.ingestion_health.stuck_count, 'item')} on ${source.label}`,
      waitingOn: retrying > 0
        ? `${dashboardCount(retrying)} ${plural(retrying, 'task')} already retrying them`
        : 'nothing on the model says what will pick them up',
    });
  }
  return {
    id: 'vision',
    name: 'Vision',
    status,
    ...(facts.length === 0 ? {} : { facts: facts.join(' · ') }),
    queued: items,
  };
}

/**
 * The scheduler lane.
 *
 * Its arbiter is the scheduler itself, and it publishes two kinds of reason: a
 * booked next run (the ordinary one — a scheduler between runs is waiting, not
 * broken) and a self-pause marker, which is a real park with a real clock on it.
 * Its strip is one bar per scheduled source, because that is the only run
 * evidence that exists; there is no series of batches behind any lane.
 */
function syncsLaneView(
  view: SourceDashboardViewModel,
  options: DashboardBackgroundPageOptions | undefined,
  now: Date,
): BackgroundLaneView | undefined {
  const scheduled = view.sources.filter((source) => source.schedule !== undefined);
  if (scheduled.length === 0) return undefined;
  const basePath = options?.basePath;
  const running = scheduled.filter((source) => source.schedule?.running === true);
  const facts: string[] = [];
  facts.push(running.length > 0
    ? `${dashboardCount(running.length)} syncing now`
    : `${dashboardCount(scheduled.length)} on schedule`);
  const waiting = view.sources.reduce(
    (total, source) => total + source.queue_health.waiting + source.queue_health.active,
    0,
  );
  if (waiting > 0) facts.push(`${dashboardCount(waiting)} ${plural(waiting, 'item')} queued`);
  const lastAttempt = latestAttempt(scheduled);
  const governing = schedulerGoverning(scheduled, now);
  const status = deriveLaneState({
    name: 'Syncs',
    unit: 'items',
    ...(lastAttempt === undefined ? {} : { lastActivityAt: lastAttempt }),
    remaining: waiting,
    ...(governing === undefined ? {} : { governing }),
    reportsLive: running.length > 0,
  }, now);
  const items: DashboardLaneQueuedItem[] = [];
  for (const source of view.sources) {
    const pending = source.queue_health.waiting + source.queue_health.active;
    if (pending === 0) continue;
    items.push({
      what: `${dashboardCount(pending)} ${plural(pending, 'item')} in the ${source.label} queue`,
      waitingOn: sourceWaitingOn(source, now),
    });
  }
  const strip = runStrip(scheduled);
  return {
    id: 'syncs',
    name: 'Syncs',
    status,
    ...(facts.length === 0 ? {} : { facts: facts.join(' · ') }),
    queued: items,
    ...(strip.length === 0
      ? {}
      : { strip, stripLabel: 'The last recorded run of each scheduled source, oldest to newest' }),
  };
}

/** The most recent attempt any scheduled source recorded. The lane's heartbeat. */
function latestAttempt(sources: readonly DashboardSourceCard[]): Date | undefined {
  let latest: number | undefined;
  for (const source of sources) {
    const at = Date.parse(source.schedule?.last_attempt_at ?? source.schedule?.last_success_at ?? '');
    if (!Number.isFinite(at)) continue;
    if (latest === undefined || at > latest) latest = at;
  }
  return latest === undefined ? undefined : new Date(latest);
}

/**
 * What the scheduler says about why nothing is syncing.
 *
 * A self-pause marker wins over a booked run: both can be true at once, and
 * "paused by the daily budget until 00:00 UTC" is the fact that explains why the
 * booked run will not help before then.
 */
function schedulerGoverning(
  scheduled: readonly DashboardSourceCard[],
  now: Date,
): DashboardLaneGoverningCondition | undefined {
  for (const source of scheduled) {
    const schedule = source.schedule;
    if (schedule === undefined) continue;
    for (const marker of [schedule.degraded_reason, schedule.last_error_kind]) {
      if (marker === undefined || !OPERATOR_PAUSED_SCHEDULER_MARKERS.has(marker)) continue;
      const sentence = SCHEDULER_SELF_PAUSE_SENTENCES[marker];
      if (sentence === undefined) continue;
      return { text: `${source.label}: ${sentence}`, decidedBy: 'the scheduler' };
    }
  }
  // A scheduler between runs is waiting, not broken, and the booked run is the
  // real answer to "when will this move". Worded as a sentence rather than
  // reusing home's "next: Gmail in 4m" label, which reads as a second colon
  // inside the reason line.
  const soonest = soonestRun(scheduled, now);
  if (soonest === undefined) return undefined;
  return {
    text: soonest.aheadMs <= 0
      ? `${soonest.label} is next, and is due now`
      : `${soonest.label} is next, in ${dashboardDuration(soonest.aheadMs / 1000)}`,
    decidedBy: 'the scheduler',
  };
}

/** What one source's queued items are waiting on, from its own schedule. */
function sourceWaitingOn(source: DashboardSourceCard, now: Date): string {
  if (source.schedule?.running === true) return 'the run that is going now';
  const at = Date.parse(source.schedule?.next_run_at ?? '');
  if (Number.isFinite(at)) {
    const ahead = at - now.getTime();
    return ahead <= 0
      ? 'the next scheduled run, which is due now'
      : `the next scheduled run, in ${dashboardDuration(ahead / 1000)}`;
  }
  const retrying = source.queue_health.retrying_tasks ?? 0;
  if (retrying > 0) return `${dashboardCount(retrying)} ${plural(retrying, 'task')} already retrying`;
  return 'nothing on the model says when this runs again';
}

/* -------------------------------------------------------- actionable set -- */

/**
 * The conditions that need a person, and only those.
 *
 * Everything the system is already fixing is deliberately absent: a booked
 * retry, a task in a retry loop, and a chunk backlog behind a live lane all
 * render NOTHING anywhere on this page. That is the same rule the source pages
 * follow, and the reason this page has no failures lane.
 */
function actionableConditions(
  view: SourceDashboardViewModel,
  options: DashboardBackgroundPageOptions | undefined,
): DashboardLaneActionable[] {
  const basePath = options?.basePath;
  const actionable: DashboardLaneActionable[] = [];
  if (view.background_work?.embedding_lane_state === 'embedding_lane_disabled') {
    actionable.push({
      lane: 'Embeddings',
      words: 'The embedding lane is switched off, so nothing will embed the chunks that are left.',
    });
  }
  if (options?.embeddingRuntime?.state === 'guard_paused') {
    // A paused guard is not a lane waiting its turn: the arbiter itself has
    // stopped, so nothing will ever start this lane again on its own. No route
    // here lifts the pause, so this is stated rather than offered as a control.
    actionable.push({
      lane: 'Embeddings',
      words: 'The overnight guard is paused, so nothing will start or stop the embedding lane '
        + 'until the pause is lifted.',
    });
  }
  for (const source of view.sources) {
    const drain = source.ingestion_health.drain_state;
    if (drain === 'held' || drain === 'disabled') {
      actionable.push({
        lane: 'Vision',
        words: `Extraction is ${drain === 'held' ? 'held' : 'switched off'} on ${source.label}, so no new text is being extracted from it.`,
        ...detailLink(source, basePath),
      });
    }
  }
  for (const source of view.sources) {
    const schedule = source.schedule;
    if (schedule === undefined || schedule.consecutive_failures <= 0) continue;
    const booked = Number.isFinite(Date.parse(schedule.next_run_at ?? ''));
    const retrying = (source.queue_health.retrying_tasks ?? 0) > 0;
    // A booked run or a live retry means the system is handling it. Silence is
    // the correct output for both.
    if (booked || retrying) continue;
    actionable.push({
      lane: 'Syncs',
      words: `${source.label} has failed ${dashboardCount(schedule.consecutive_failures)} `
        + `${plural(schedule.consecutive_failures, 'time')} in a row and nothing is scheduled to try it again.`,
      ...detailLink(source, basePath),
    });
  }
  for (const source of view.sources) {
    const reason = source.schedule?.degraded_reason;
    // A self-pause is not a fault: it has its own clock and appears as the
    // Syncs lane's governing condition instead.
    if (reason === undefined || OPERATOR_PAUSED_SCHEDULER_MARKERS.has(reason)) continue;
    actionable.push({
      lane: 'Syncs',
      words: `The scheduler is running ${source.label} degraded — ${maskSecrets(reason)}.`,
      ...detailLink(source, basePath),
    });
  }
  return actionable;
}

/* ---------------------------------------------------------------- render -- */

export function renderDashboardBackgroundPage(
  view: SourceDashboardViewModel,
  options?: DashboardBackgroundPageOptions,
): string {
  const now = options?.now ?? new Date();
  const lanes = backgroundLaneViews(view, options, now);
  const checked = dashboardCheckedLabel(view.generated_at, now);
  const head = laneHeadline(lanes);
  return pageShell({
    title: 'Olympus',
    crumb: 'Background',
    ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
    meta: checked ? `${head} · ${checked}` : head,
    body: renderBackgroundBody(view, lanes, now, options),
    styles: [DASHBOARD_LANE_CSS, DASHBOARD_NAV_CSS, BACKGROUND_CSS],
    // The embedding toggle is the first control this page has ever carried, so
    // it is also the first time this page needs the shared control wiring — the
    // same token prompt and the same auth-check every other control uses.
    scripts: [
      controlScript({ csrfToken: options?.controlSessionCsrfToken }),
    ],
    poll: {
      unlocked: options?.controlSessionCsrfToken !== undefined,
      ...(options?.controlSessionCsrfToken === undefined ? {} : { controlSessionCsrfToken: options.controlSessionCsrfToken }),
    },
  });
}

/**
 * The body without the shell, so the page's composition can be read alone.
 *
 * The lanes are built here rather than passed in: a lane's state is derived
 * from the report evidence in `options`, so a caller handing in its own lane
 * list could only ever hand in one that had never seen a heartbeat.
 */
export function renderDashboardBackgroundBody(
  view: SourceDashboardViewModel,
  now: Date,
  options?: DashboardBackgroundPageOptions,
): string {
  return renderBackgroundBody(view, backgroundLaneViews(view, options, now), now, options);
}

function renderBackgroundBody(
  view: SourceDashboardViewModel,
  lanes: readonly BackgroundLaneView[],
  now: Date,
  options?: DashboardBackgroundPageOptions,
): string {
  const nav = renderDashboardNav('background', {
    ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
  });
  if (lanes.length === 0) {
    return `${nav}
        <div class="foot">No background lane is reporting right now.</div>${renderInformational(options)}`;
  }
  const banners = armLaneBanners({
    lanes: lanes.map((lane) => ({ name: lane.name, status: lane.status })),
    actionable: actionableConditions(view, options),
  });
  return [
    nav,
    renderBanners(banners),
    renderKpis(backgroundKpis(view, lanes)),
    renderLanes(lanes),
    renderRecentRuns(view, now),
    renderInformational(options),
  ].filter((section) => section.length > 0).join('');
}

function laneHeadline(lanes: readonly BackgroundLaneView[]): string {
  if (lanes.length === 0) return 'nothing reporting';
  const stuck = lanes.filter((lane) => lane.status.stuck !== undefined).length;
  if (stuck > 0) return `${dashboardCount(stuck)} ${plural(stuck, 'lane')} not moving`;
  const working = lanes.filter((lane) => lane.status.kind === 'active').length;
  return working === 0
    ? 'no lane working'
    : `${dashboardCount(working)} ${plural(working, 'lane')} working`;
}

/**
 * The attention banners.
 *
 * Nothing renders when nothing needs a person — no "all clear" panel, which is
 * only a banner that has learnt to cry wolf. Each banner reuses the shared
 * attention row so a stuck lane looks exactly like every other thing on this
 * dashboard that wants the owner's eyes.
 */
function renderBanners(banners: readonly DashboardLaneBanner[]): string {
  if (banners.length === 0) return '';
  const rows = banners.map((banner) => {
    const why = banner.lastGoverning === undefined
      ? banner.words
      : `${banner.words} Last governing condition: ${banner.lastGoverning}.`;
    return attentionRow({
      label: banner.lane,
      why: maskSecrets(why),
      attention: true,
      ...(safeHref(banner.href) === undefined ? {} : { href: banner.href! }),
    });
  }).join('');
  return `
        <div class="sect attn">Needs a look</div>${rows}`;
}

/** The state word a lane's pill carries. Never a claim the state does not make. */
const LANE_STATE_WORDS: Readonly<Record<DashboardLaneStateKind, string>> = {
  active: 'Working now',
  waiting: 'Waiting',
  done: 'Nothing waiting',
  unknown: 'State unknown',
};

function laneStateTone(status: DashboardLaneStatus): string {
  if (status.stuck !== undefined) return 'var(--bad)';
  if (status.kind === 'active') return 'var(--good)';
  if (status.kind === 'waiting') return 'var(--warn)';
  if (status.kind === 'done') return 'var(--t3)';
  return 'var(--t3)';
}

function renderLanes(lanes: readonly BackgroundLaneView[]): string {
  const blocks = lanes.map((lane) => renderLane(lane)).join('');
  return `
        <div class="dsect">Work running in the background</div>${blocks}`;
}

/**
 * One lane block.
 *
 * A DONE lane collapses to a single quiet line — no bar, no rate, no queue —
 * because a lane with nothing outstanding has nothing to explain, and four
 * empty rows per idle lane is how a page stops being read.
 */
function renderLane(lane: BackgroundLaneView): string {
  const status = lane.status;
  if (status.kind === 'done') {
    return `
        <div class="lane quiet"><span class="lnm">${escapeHtml(lane.name)}</span>`
      + `<span class="lquiet">${escapeHtml(doneLine(lane))}</span></div>`;
  }
  // A stuck lane's word is "Not moving" whatever its underlying state: the
  // reader is being told the answer to their question, not the internal
  // classification that produced it.
  const stateWord = status.stuck === undefined ? LANE_STATE_WORDS[status.kind] : 'Not moving';
  const lines: string[] = [];
  if (lane.facts !== undefined) {
    lines.push(`<div class="lfacts">${escapeHtml(lane.facts)}</div>`);
  }
  const movement = movementLine(status);
  if (movement !== '') lines.push(`<div class="lmove">${escapeHtml(movement)}</div>`);
  const reason = reasonBlock(status);
  if (reason !== '') lines.push(reason);
  if (lane.fraction !== undefined) {
    lines.push(`<div class="lbar">${miniBar({ percent: lane.fraction * 100, label: `${lane.name} progress` })}</div>`);
  }
  if (lane.strip !== undefined && lane.strip.length > 0) {
    lines.push(renderStrip(lane.strip, lane.stripLabel));
  }
  lines.push(renderQueue(lane.queued));
  return `
        <div class="lane">
          <div class="lanehd"><span class="lnm">${escapeHtml(lane.name)}</span>`
    + `<span class="lstate" style="color:${laneStateTone(status)}">${escapeHtml(stateWord)}</span></div>`
    + `${lines.filter((line) => line !== '').join('')}
        </div>${lane.detail ?? ''}`;
}

/** The one line an idle lane gets, with its own facts folded in. */
function doneLine(lane: BackgroundLaneView): string {
  return lane.facts === undefined
    ? 'Nothing waiting.'
    : `Nothing waiting · ${lane.facts}`;
}

/**
 * The movement line: rate, ETA, heartbeat.
 *
 * A lane that is working and has no measurable rate yet says so rather than
 * printing nothing — "working now" with no number was the original complaint,
 * and an admitted gap is the honest half of fixing it.
 */
function movementLine(status: DashboardLaneStatus): string {
  const parts: string[] = [];
  if (status.kind === 'active') {
    parts.push(status.rate === undefined ? 'rate not measured yet' : status.rate.text);
    if (status.etaMs !== undefined) parts.push(`about ${etaWords(status.etaMs)} left`);
  } else if (status.rate !== undefined && status.rate.perMinute > 0) {
    // A lane that is parked but still finishing a batch: the rate is real and
    // saying it prevents the page from reading as more stopped than it is.
    parts.push(`still ${status.rate.text}`);
  }
  if (status.sinceActivityMs !== undefined) {
    parts.push(`last activity ${dashboardRelativeFromMs(status.sinceActivityMs)}`);
  }
  return parts.join(' · ');
}

/**
 * An ETA, rounded to the precision it actually has.
 *
 * The estimate is a remainder divided by a rate measured over minutes, so its
 * error is minutes wide — printing "46m 43s left" claims a second-level
 * precision the arithmetic does not have. Anything over ninety seconds is
 * rounded to the minute; below that the seconds are the whole answer.
 */
function etaWords(etaMs: number): string {
  const seconds = etaMs / 1000;
  return seconds <= 90 ? dashboardDuration(seconds) : dashboardDuration(Math.round(seconds / 60) * 60);
}

/**
 * The reason half of the law: what the arbiter said, or the admission that
 * nothing did.
 *
 * A stuck lane's line is drawn here too, because "why is this not moving" and
 * "this is not moving and should be" are the same question to a reader.
 */
function reasonBlock(status: DashboardLaneStatus): string {
  if (status.stuck !== undefined) {
    const governing = status.stuck.lastGoverning === undefined
      ? ''
      : ` Last governing condition: ${status.stuck.lastGoverning}.`;
    return `<div class="lreason stuck">${escapeHtml(maskSecrets(`${status.stuck.words}${governing}`))}</div>`;
  }
  if (status.kind === 'waiting' && status.reason !== undefined) {
    const who = status.reasonBy === undefined ? '' : ` — ${status.reasonBy}`;
    return `<div class="lreason">Waiting: ${escapeHtml(maskSecrets(`${status.reason}${who}`))}</div>`;
  }
  if (status.kind === 'unknown') {
    const why = status.unknownWhy === undefined ? '' : ` — ${status.unknownWhy}`;
    return `<div class="lreason unknown">${escapeHtml(maskSecrets(`State unknown${why}`))}</div>`;
  }
  return '';
}

/** The queued items: what each one is, and what it is waiting on. */
function renderQueue(items: readonly DashboardLaneQueuedItem[]): string {
  if (items.length === 0) return '';
  const rows = items.map((item) =>
    `<div class="lq"><b>${escapeHtml(maskSecrets(item.what))}</b> — waiting on ${escapeHtml(maskSecrets(item.waitingOn))}</div>`).join('');
  return `<div class="lqueue">${rows}</div>`;
}

function renderStrip(strip: readonly DashboardLaneStripItem[], label: string | undefined): string {
  const bars = strip.map((item) =>
    `<i style="background:${STRIP_TONE_COLORS[item.tone] ?? STRIP_TONE_COLORS.idle}" title="${escapeHtml(item.label)}"></i>`).join('');
  return `<span class="lanestrip"${label ? ` role="img" aria-label="${escapeHtml(label)}"` : ''}>${bars}</span>`;
}

const STRIP_TONE_COLORS: Readonly<Record<DashboardLaneTone, string>> = {
  good: 'var(--good)',
  bad: 'var(--bad)',
  run: 'var(--run)',
  idle: 'var(--line)',
};

/**
 * The informational close: what these lanes are, and the one link out.
 *
 * The embedding ledger is another page's job. This is a link and nothing more,
 * so a worktree where that page does not exist yet renders a link that 404s
 * rather than a page that fails to build.
 */
function renderInformational(options: DashboardBackgroundPageOptions | undefined): string {
  const basePath = options?.basePath ?? DEFAULT_BASE_PATH;
  const separator = basePath.includes('?') ? '&' : '?';
  const href = safeHref(`${basePath}${separator}${EMBEDDING_LEDGER_QUERY_PARAM}`);
  const link = href === undefined
    ? ''
    : `<div class="infolink"><a href="${escapeHtml(href)}">Embedding decisions &amp; history →</a>`
      + `<span class="quiet"> Model changes, re-embeds, and who approved them.</span></div>`;
  return `
        <div class="dsect">About these lanes</div>
        <div class="info">Nothing here is on a clock. Each lane runs when the machine has room for it, and
        the overnight guard decides every minute which lane that is. A lane that is not moving says who
        stopped it; a lane whose state cannot be read says exactly that instead of guessing.</div>${link}`;
}

/* ------------------------------------------------------------------ kpis -- */

interface BackgroundKpi {
  unit: string;
  value: string;
  sub: string;
  /** A theme variable, never reader data. */
  color?: string | undefined;
}

/**
 * The tiles, minus any whose field is absent.
 *
 * Nothing here is windowed: no field counts items or failures over a day, so
 * "items today", "last hour" and "last 24h" are not claimed. There is no
 * failures tile any more — a count of failures with no disposition is the
 * failures lane in a smaller box.
 */
function backgroundKpis(
  view: SourceDashboardViewModel,
  lanes: readonly BackgroundLaneView[],
): BackgroundKpi[] {
  const kpis: BackgroundKpi[] = [];
  const working = lanes.filter((lane) => lane.status.kind === 'active').length;
  const stuck = lanes.filter((lane) => lane.status.stuck !== undefined).length;
  kpis.push({
    unit: 'Lanes',
    value: `${dashboardCount(working)} of ${dashboardCount(lanes.length)}`,
    sub: stuck > 0
      ? `working · ${dashboardCount(stuck)} ${plural(stuck, 'lane')} not moving`
      : 'working · none stuck',
    color: stuck > 0 ? 'var(--bad)' : undefined,
  });
  const waiting = lanes.filter((lane) => lane.status.kind === 'waiting').length;
  if (waiting > 0) {
    kpis.push({
      unit: 'Waiting',
      value: dashboardCount(waiting),
      sub: 'each with a stated reason',
      color: 'var(--warn)',
    });
  }
  if (view.sources.length > 0) {
    const queuedWaiting = view.sources.reduce((total, source) => total + source.queue_health.waiting, 0);
    const active = view.sources.reduce((total, source) => total + source.queue_health.active, 0);
    kpis.push({
      unit: 'Queued',
      value: compactCount(queuedWaiting + active),
      sub: queuedWaiting + active === 0
        ? 'nothing waiting'
        : active > 0
          ? `${dashboardCount(active)} active now`
          : 'items waiting in queue',
    });
  }
  const longest = longestEta(view.sources);
  if (longest) {
    kpis.push({
      unit: 'Longest ETA',
      value: `~${dashboardDuration(longest.minutes * 60)}`,
      // The only ETA on the model is the ingestion queue's, per source. It is
      // not an embedding ETA, and the tile says which source it belongs to.
      sub: `${longest.label} ingest`,
    });
  }
  return kpis;
}

function longestEta(
  sources: readonly DashboardSourceCard[],
): { minutes: number; label: string } | undefined {
  let longest: { minutes: number; label: string } | undefined;
  for (const source of sources) {
    const minutes = source.progress?.eta_minutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) continue;
    if (longest === undefined || minutes > longest.minutes) longest = { minutes, label: source.label };
  }
  return longest;
}

function renderKpis(kpis: readonly BackgroundKpi[]): string {
  if (kpis.length === 0) return '';
  const tiles = kpis.map((kpi) => `
          <div class="kpi"><div class="u">${escapeHtml(kpi.unit)}</div><div class="n"${kpi.color ? ` style="color:${kpi.color}"` : ''}>${escapeHtml(kpi.value)}</div><div class="s">${escapeHtml(kpi.sub)}</div></div>`).join('');
  return `
        <div class="kpis">${tiles}
        </div>`;
}

/* ------------------------------------------------- home's view-model lanes -- */

/**
 * Chunk parity is the only background ratio with both halves on the model, so
 * it is the only lane that earns a bar in home's card.
 */
function embeddingsLane(
  view: SourceDashboardViewModel,
  options: DashboardPageOptions | undefined,
): DashboardBackgroundLane | undefined {
  const backlog = view.background_work?.embedding_backlog;
  const disabled = view.background_work?.embedding_lane_state === 'embedding_lane_disabled';
  const runtime = options?.embeddingRuntime;
  if (!backlog && !disabled && !runtime) return undefined;
  const facts: string[] = [];
  const checks: DashboardBackgroundCheck[] = [];
  let fraction: number | undefined;
  if (backlog) {
    fraction = backlog.chunks > 0 ? clampFraction(backlog.embedded_chunks / backlog.chunks) : undefined;
    if (fraction !== undefined) facts.push(`${Math.round(fraction * 100)}% embedded`);
    facts.push(backlog.missing_chunks > 0
      ? `${compactCount(backlog.missing_chunks)} of ${compactCount(backlog.chunks)} chunks left`
      : `all ${compactCount(backlog.chunks)} chunks embedded`);
    if (backlog.refresh_needed) {
      facts.push('re-embed needed');
      checks.push({
        name: 'EMBEDDING_PARITY',
        observed: `${dashboardCount(backlog.missing_chunks)} of ${dashboardCount(backlog.chunks)} chunks missing`,
        expectation: '== up to date',
        ok: false,
        disposition: disabled ? 'needs_you' : 'self_healing',
        ...(disabled ? {} : { dispositionNote: 'queued' }),
      });
    }
  }
  if (disabled) {
    facts.push('embedding lane disabled');
    checks.push({
      name: 'EMBEDDING_LANE',
      observed: 'disabled',
      expectation: '== enabled',
      ok: false,
      disposition: 'needs_you',
    });
  }
  return {
    name: 'Embeddings',
    facts: facts.join(' · '),
    working: runtime === undefined
      ? !disabled && (backlog?.missing_chunks ?? 0) > 0
      : runtime.state === 'running' || runtime.state === 'operator_priority',
    checks,
    checksHeading: 'Embeddings',
    ...(fraction === undefined ? {} : { fraction }),
  };
}

/** Vision extraction has a queue depth and no denominator, so no bar. */
function visionLane(
  view: SourceDashboardViewModel,
  basePath: string | undefined,
): DashboardBackgroundLane | undefined {
  const queued = view.background_work?.vlm_extraction_queued;
  const held = view.sources.filter((source) => source.ingestion_health.drain_state === 'held');
  const off = view.sources.filter((source) => source.ingestion_health.drain_state === 'disabled');
  const stuck = view.sources.filter((source) => source.ingestion_health.stuck_count > 0);
  if (queued === undefined && held.length === 0 && stuck.length === 0) return undefined;
  const facts: string[] = [];
  if (queued !== undefined) facts.push(`${dashboardCount(queued)} ${plural(queued, 'job')} queued`);
  const waitingOn = view.sources
    .filter((source) => (source.vlm_extraction_queued ?? 0) > 0)
    .map((source) => source.label);
  if (waitingOn.length > 0) facts.push(waitingOn.join(', '));
  if (held.length > 0) {
    facts.push(`extraction held on ${dashboardCount(held.length)} ${plural(held.length, 'source')}`);
  }
  if (off.length > 0) {
    facts.push(`extraction off on ${dashboardCount(off.length)} ${plural(off.length, 'source')}`);
  }
  const checks: DashboardBackgroundCheck[] = [];
  for (const source of [...held, ...off]) {
    checks.push({
      name: 'EXTRACTION_DRAIN',
      observed: `${source.label}: ${source.ingestion_health.drain_state}`,
      expectation: '== enabled',
      ...(source.ingestion_health.drain_unit ? { cause: source.ingestion_health.drain_unit } : {}),
      ok: false,
      disposition: 'needs_you',
      ...detailLink(source, basePath),
    });
  }
  for (const source of stuck) {
    const retrying = source.queue_health.retrying_tasks ?? 0;
    checks.push({
      name: 'STUCK_ITEMS',
      observed: `${source.label}: ${dashboardCount(source.ingestion_health.stuck_count)}`,
      expectation: '== 0',
      cause: source.ingestion_health.label,
      ok: false,
      disposition: retrying > 0 ? 'self_healing' : 'needs_you',
      ...(retrying > 0
        ? { dispositionNote: `${dashboardCount(retrying)} ${plural(retrying, 'task')} retrying` }
        : detailLink(source, basePath)),
    });
  }
  return {
    name: 'Vision',
    facts: facts.join(' · '),
    working: (queued ?? 0) > 0 && held.length === 0,
    checks,
    checksHeading: 'Vision',
  };
}

/** The scheduler lane, as home's card states it. */
function syncsLane(
  view: SourceDashboardViewModel,
  now: Date,
  basePath: string | undefined,
): DashboardBackgroundLane | undefined {
  const scheduled = view.sources.filter((source) => source.schedule !== undefined);
  if (scheduled.length === 0) return undefined;
  const running = scheduled.filter((source) => source.schedule?.running === true);
  const failing = scheduled.filter((source) => (source.schedule?.consecutive_failures ?? 0) > 0);
  const facts: string[] = [];
  if (running.length > 0) {
    facts.push(`${dashboardCount(running.length)} syncing now`);
  } else if (failing.length === 0) {
    facts.push(`all ${dashboardCount(scheduled.length)} on schedule`);
  } else {
    facts.push(`${dashboardCount(scheduled.length - failing.length)} of ${dashboardCount(scheduled.length)} on schedule`);
  }
  if (failing.length > 0) {
    facts.push(`${dashboardCount(failing.length)} ${plural(failing.length, 'source')} failing`);
  }
  const queued = view.sources.reduce(
    (total, source) => total + source.queue_health.waiting + source.queue_health.active,
    0,
  );
  if (queued > 0) facts.push(`${dashboardCount(queued)} ${plural(queued, 'item')} queued`);
  const next = nextRunLabel(scheduled, now);
  if (next) facts.push(next);
  const checks: DashboardBackgroundCheck[] = [];
  for (const source of failing) {
    const schedule = source.schedule;
    if (!schedule) continue;
    const retryAt = schedule.next_run_at ? Date.parse(schedule.next_run_at) : Number.NaN;
    const booked = Number.isFinite(retryAt);
    const retrying = source.queue_health.retrying_tasks ?? 0;
    const selfHealing = booked || retrying > 0;
    checks.push({
      name: 'CONSECUTIVE_FAILURES',
      observed: `${source.label}: ${dashboardCount(schedule.consecutive_failures)}`,
      expectation: '== 0',
      ...(schedule.last_error_kind ? { cause: schedule.last_error_kind } : {}),
      ok: false,
      disposition: selfHealing ? 'self_healing' : 'needs_you',
      ...(selfHealing
        ? { dispositionNote: booked ? 'requeued' : `${dashboardCount(retrying)} ${plural(retrying, 'task')} retrying` }
        : detailLink(source, basePath)),
    });
  }
  const strip = runStrip(scheduled);
  return {
    name: 'Syncs',
    facts: facts.join(' · '),
    working: running.length > 0,
    checks,
    checksHeading: 'Syncs',
    ...(strip.length === 0
      ? {}
      : { strip, stripLabel: 'The last recorded run of each scheduled source, oldest to newest' }),
  };
}

/* ------------------------------------------------------- embedding panel -- */

/** The tone the state line is drawn in. Never a claim the state does not make. */
function embeddingStateTone(state: EmbeddingRunState): string {
  if (state === 'running' || state === 'operator_priority') return 'var(--good)';
  if (state === 'guard_paused') return 'var(--bad)';
  if (state === 'unknown') return 'var(--t3)';
  return 'var(--warn)';
}

/**
 * The embedding block: what it is doing, what governs it, what model, and the
 * one control that changes it. Merged 2026-08-24 and kept intact.
 *
 * Every string here comes off EmbeddingRuntimeFacts, which reads the guard's
 * and the drain's own files. Nothing is computed from this process's clock, and
 * an unknown state renders as the words "state unknown" rather than as a guess
 * dressed up in a color.
 */
function renderEmbeddingDetail(
  runtime: EmbeddingRuntimeFacts,
  options: DashboardPageOptions | undefined,
): string {
  const lines: string[] = [];
  lines.push(`<div class="embstate" style="color:${embeddingStateTone(runtime.state)}">`
    + `${escapeHtml(runtime.stateLine)}</div>`);
  lines.push(`<div class="embline">${escapeHtml(runtime.scheduleLine)}</div>`);
  if (runtime.model) {
    lines.push(`<div class="embline">Model: ${escapeHtml(runtime.model.text)}</div>`);
  }
  if (runtime.override === 'unknown_token') {
    lines.push(`<div class="embline warn">The operator override file holds a value the guard does not `
      + `recognise, so it is being ignored and normal arbitration applies.</div>`);
  }
  if (runtime.override === 'unreadable') {
    lines.push(`<div class="embline warn">The operator override file could not be read, so the toggle `
      + `below cannot report its current position.</div>`);
  }
  lines.push(renderEmbeddingToggle(runtime, options));
  return `
        <div class="embblock">${lines.join('')}
        </div>`;
}

/**
 * The toggle.
 *
 * A read-only reader gets the sentence and no button, exactly as every other
 * control on this dashboard does: the control route takes the worker bearer
 * token and nothing weaker, so a button here could only ever 401.
 */
function renderEmbeddingToggle(
  runtime: EmbeddingRuntimeFacts,
  options: DashboardPageOptions | undefined,
): string {
  const takesEffect = '<div class="embline">Takes effect within a minute — the guard re-reads this on its next tick.</div>';
  if (options?.readOnly === true) {
    return `<div class="embline">Embedding priority is ${runtime.overrideOn ? 'on' : 'off'}. `
      + `Changing it asks for the worker bearer token, which this read-only link does not carry.</div>`;
  }
  const label = runtime.overrideOn
    ? 'Turn off embedding priority'
    : 'Give embedding priority';
  const explain = runtime.overrideOn
    ? 'Priority is on: the supervisors are parked and this lane keeps running. Turning it off restores normal arbitration.'
    : 'Turning this on parks the source-processing supervisors so this lane keeps running until you turn it off.';
  return `<div class="embline">${escapeHtml(explain)}</div>`
    + `<form class="rowform" data-embedding-kind="operator_override">`
    + `<input type="hidden" name="on" value="${runtime.overrideOn ? 'false' : 'true'}">`
    + `<button class="btn" type="submit">${escapeHtml(label)}</button>`
    + `<span class="actmsg" data-action-message role="status"></span>`
    + `</form>`
    + takesEffect;
}

/**
 * This page's own layout: the lane blocks, and the embedding block that sits
 * under one of them. Self-contained rather than folded into the shared theme —
 * these rules describe one page.
 */
const BACKGROUND_CSS = `.lane { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
.lane .lanehd { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.lane .lnm { font-weight: 600; font-size: 13.5px; color: var(--t2); }
.lane .lstate { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
.lane .lfacts { color: var(--t2); font-size: 12.5px; margin-top: 5px; font-variant-numeric: tabular-nums; }
.lane .lmove { color: var(--t3); font-size: 12px; margin-top: 3px; font-variant-numeric: tabular-nums; }
.lane .lreason { color: var(--warn); font-size: 12px; margin-top: 5px; max-width: 74ch; }
.lane .lreason.stuck { color: var(--bad); }
.lane .lreason.unknown { color: var(--t3); }
.lane .lbar { margin-top: 8px; }
.lane .lbar .minibar { width: 100%; max-width: 340px; }
.lane .lanestrip { margin-top: 8px; }
.lane .lqueue { margin-top: 8px; border-top: 1px solid var(--line2); padding-top: 7px; }
.lane .lq { color: var(--t3); font-size: 12px; line-height: 1.55; }
.lane .lq b { color: var(--t2); font-weight: 600; font-variant-numeric: tabular-nums; }
.lane.quiet { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 9px 14px; }
.lane.quiet .lquiet { color: var(--t4); font-size: 12px; }
.info { color: var(--t3); font-size: 12.5px; line-height: 1.6; max-width: 74ch; }
.infolink { margin-top: 8px; font-size: 12.5px; }
.embblock { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin: -3px 0 7px; }
.embblock .embstate { font-size: 13px; font-weight: 500; margin-bottom: 6px; }
.embblock .embline { color: var(--t3); font-size: 12px; line-height: 1.5; margin-bottom: 4px; }
.embblock .embline.warn { color: var(--warn); }
.embblock .rowform { margin: 8px 0 6px; }
@media (max-width: 700px) {
  .lane .lanehd { flex-wrap: wrap; }
}
`;

/* ----------------------------------------------------------------- runs -- */

function runStrip(sources: readonly DashboardSourceCard[]): DashboardLaneStripItem[] {
  return sources
    .filter((source) => source.last_run !== undefined)
    .sort((left, right) => runOrder(left) - runOrder(right))
    .map((source) => ({
      tone: runTone(source.last_run?.status ?? ''),
      label: `${source.label} · ${source.last_run?.status ?? 'no run recorded'}`,
    }));
}

function runOrder(source: DashboardSourceCard): number {
  const stamp = source.last_run?.completed_at ?? source.last_run?.started_at ?? '';
  const at = Date.parse(stamp);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

function runTone(status: string): DashboardLaneTone {
  if (status === 'completed') return 'good';
  if (status === 'failed') return 'bad';
  if (status === 'running') return 'run';
  return 'idle';
}

/**
 * The Result cell's designed copy — mark plus sentence case — instead of the
 * raw enum, matching the detail page's table.
 */
function runResultLabel(status: string): string {
  if (status === 'completed') return '✓ Completed';
  if (status === 'failed') return '✕ Failed';
  if (status === 'running') return '● Running';
  return status.length > 0 ? status[0]!.toUpperCase() + status.slice(1) : status;
}

/** The soonest booked run any card carries, and how far ahead it is. */
function soonestRun(
  sources: readonly DashboardSourceCard[],
  now: Date,
): { label: string; aheadMs: number } | undefined {
  let soonest: { at: number; label: string } | undefined;
  for (const source of sources) {
    const at = Date.parse(source.schedule?.next_run_at ?? '');
    if (!Number.isFinite(at)) continue;
    if (soonest === undefined || at < soonest.at) soonest = { at, label: source.label };
  }
  return soonest === undefined
    ? undefined
    : { label: soonest.label, aheadMs: soonest.at - now.getTime() };
}

/** "next: Gmail in 4m", from the earliest next_run_at the cards carry. */
function nextRunLabel(sources: readonly DashboardSourceCard[], now: Date): string {
  const soonest = soonestRun(sources, now);
  if (soonest === undefined) return '';
  return soonest.aheadMs <= 0
    ? `next: ${soonest.label} due now`
    : `next: ${soonest.label} in ${dashboardDuration(soonest.aheadMs / 1000)}`;
}

/**
 * The most recent run each source recorded, newest first. The owner asked for
 * this block by name, so it survives the redesign unchanged.
 *
 * Not an event stream and not labelled as one: there is no feed of lane
 * completions anywhere upstream, so the table names exactly what it holds.
 */
function renderRecentRuns(view: SourceDashboardViewModel, now: Date): string {
  const runs = view.sources
    .filter((source) => source.last_run !== undefined)
    .sort((left, right) => runOrder(right) - runOrder(left))
    .slice(0, RECENT_RUN_LIMIT);
  if (runs.length === 0) return '';
  const rows = runs.map((source) => {
    const run = source.last_run;
    if (!run) return '';
    return `
            <tr><td>${escapeHtml(runWhen(source, now))}</td><td>${escapeHtml(source.label)}</td><td style="color:${toneColor(runTone(run.status))}">${escapeHtml(runResultLabel(run.status))}</td><td>${escapeHtml(runTook(source))}</td><td>${escapeHtml(dashboardCount(run.items_indexed))}</td></tr>`;
  }).join('');
  return `
        <div class="dsect">Last run of each source</div>
        <table>
          <tr><th>When</th><th>Source</th><th>Result</th><th>Took</th><th>Indexed</th></tr>${rows}
        </table>`;
}

function runWhen(source: DashboardSourceCard, now: Date): string {
  const at = runOrder(source);
  if (!Number.isFinite(at)) return 'time not recorded';
  return dashboardRelativeFromMs(now.getTime() - at);
}

function runTook(source: DashboardSourceCard): string {
  const seconds = source.last_run?.duration_seconds;
  // An unfinished or unstamped run has no duration, and zero would be a claim.
  return typeof seconds === 'number' && Number.isFinite(seconds) ? dashboardDuration(seconds) : '—';
}

function toneColor(tone: DashboardLaneTone): string {
  if (tone === 'good') return 'var(--good)';
  if (tone === 'bad') return 'var(--bad)';
  if (tone === 'run') return 'var(--run)';
  return 'var(--line)';
}

/**
 * Nothing on this page is supposed to carry a secret, so this is a backstop
 * rather than a formatter, matching the one the detail page applies to the
 * same ledger and scheduler prose.
 */
function maskSecrets(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/g, '[REDACTED]')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|ghu|ghr|xox[abpsr]|dash|tok|key|secret|token)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[REDACTED]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]');
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/** "9,412" up to five figures, "133k" past it: a lane line has one line. */
function compactCount(value: number): string {
  if (!Number.isFinite(value) || value < 10_000) return dashboardCount(value);
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
  }
  return `${Math.round(value / 100_000) / 10}M`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
