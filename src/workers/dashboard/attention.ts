/**
 * The one banner that replaces every error surface on a source page.
 *
 * Owner ruling, 2026-08-24 design session: NO ERROR COUNTS ANYWHERE. A number
 * of errors is not a thing a reader can act on, and the old page led with three
 * of them. What replaces all of it is a single banner that appears only when
 * something is genuinely waiting on a person, says what is wrong and what to
 * do, and carries the real control wherever one exists.
 *
 * SELF-HEALING CONDITIONS SHOW NOTHING. A provider outage, a rate limit, a
 * transient backend failure, a lane parked by its own daily budget until the
 * rollover — none of these reach the reader, because none of them is theirs.
 * That silence is the feature; the module is written so that arming is the
 * exception it has to earn.
 *
 * Exactly three classes can surface, in this precedence:
 *
 *   1. CREDENTIAL — the connection needs an act before anything else can
 *      matter. Wired to the same connect controls the rest of the dashboard
 *      already uses, so a reader never gets a button that only fails.
 *   2. TERMINAL_EXTRACTION — files no lane will ever retry. One real action:
 *      exclude the folders they sit in, or leave them.
 *   3. LANE_STUCK — machine-detected. A lane with open work that has not moved
 *      beyond its own grace window, named in plain words with the last
 *      condition that governed it.
 *
 * One banner, not three: the highest-precedence class speaks. A credential that
 * cannot authenticate makes every other complaint on the page moot, and the
 * lower classes stay reachable in Advanced, where their sections live.
 */
import type { DashboardSourceCard } from '../source-dashboard.ts';
import { DASHBOARD_SUPPORTED_SOURCES } from '../source-dashboard.ts';
import type { WorkerCredentialDegradation } from '../credential-degradation.ts';
import type { DashboardActionInput } from './components.ts';
import { dashboardSourceProgress } from './phases.ts';
import { dashboardCount, dashboardDuration } from './vocabulary.ts';

export type DashboardAttentionKind = 'credential' | 'terminal_extraction' | 'lane_stuck';

export interface DashboardAttentionBanner {
  kind: DashboardAttentionKind;
  /** What is wrong and what to do about it, in one sentence. */
  sentence: string;
  /** The real control, when a route for this act exists at all. */
  action?: DashboardActionInput;
  /**
   * A prompt the reader can hand their agent when the banner names a fault
   * no dashboard route can clear on its own (a lane that stopped for no
   * reported reason). Rendered as a second control that opens a copy sheet,
   * so a warning is never a dead end (owner note, 2026-09-01: "needs
   * attention, then no instructions or buttons for me to fix it").
   */
  agent_prompt?: string;
}

export interface DashboardAttentionOptions {
  now?: Date;
  /**
   * Credential failures ALREADY matched to this source. Matching is by display
   * name and belongs to the caller that holds the whole report; passing an
   * unfiltered list here would banner one lane's expired key on every card.
   */
  degradedCredentials?: readonly WorkerCredentialDegradation[];
  /** True for a reader on the read-only dash_ token: controls cannot be offered. */
  readOnly?: boolean;
  /** Where the setup sheet lives, for the acts that happen there. */
  setupPath: string;
  /** The bearer-gated folder picker; absent means no Choose-folders control. */
  folderPickerPath?: string;
}

/**
 * The needs-review reason that means "no lane will retry this".
 *
 * ONE key, deliberately. Its own published note is `retried once already, so
 * these wait for you`, and the candidate query skips any row that already has a
 * job at these bytes whatever its status — so a second failure is permanent
 * until a person intervenes. That is the definition the ruling used.
 *
 * The three neighbours that look similar and are not: `pages_not_extracted` is
 * a part-read file rather than a failure; `image_only_no_text` is a reader
 * nobody has switched on, which is a capability gap and not an error; and
 * `extraction_jobs_failed` says of itself that some retry themselves, so
 * counting it here would inflate a number whose whole point is that it is
 * terminal.
 */
const TERMINAL_EXTRACTION_REVIEW_KEY = 'extraction_failed';

/**
 * How long a lane with no refresh window of its own may sit still before it is
 * stuck rather than idle.
 *
 * Sources that publish `freshness.threshold_hours` use that instead: it is the
 * lane's OWN declared refresh window, which is a better grace window than any
 * constant here could be.
 */
const DEFAULT_GRACE_HOURS = 24;

/**
 * Connection states that are not waiting on the reader for anything.
 *
 * Exported because the detail page's CONNECTION check asserts the same
 * predicate: a state the banner treats as healthy and a check row marks failing
 * would be one page disagreeing with itself.
 */
export const HEALTHY_CONNECTION_STATES: ReadonlySet<string> = new Set([
  'connected',
  'syncing',
  'synced',
  'waiting_for_first_sync',
]);

/**
 * The scheduler's own markers, each with what it means for a stuck lane.
 *
 * Every key is a value the scheduler really writes. A marker outside this map
 * is printed as itself rather than paraphrased from its name: an untranslated
 * marker is ugly, an invented translation is a lie.
 */
export const DASHBOARD_GUARD_CONSEQUENCES: Readonly<Record<string, string>> = {
  api_request_guard: 'the provider is refusing requests — reconnect the credential',
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
  credential_missing: 'the credential this source needs is not in the store',
  credential_reauth_required: 'the credential expired — reconnect it',
  credential_refresh_busy: 'another refresh of this credential is in flight',
  credential_session_latched: 'the credential session is latched by another run',
  config_missing_folder_argument: 'this sync is configured without the folder it needs',
  reconcile_incomplete: 'the last reconcile did not cover everything it was asked to',
};

/** The two drain states that are a switch somebody threw, not a fault. */
export const DASHBOARD_DRAIN_CONSEQUENCES: Readonly<Record<'held' | 'disabled', string>> = {
  held: 'the extraction lane is held, so no new text is being extracted',
  disabled: 'the extraction lane is switched off, so no new text is being extracted',
};

/** The banner for this source, or undefined when nothing is waiting on anyone. */
export function dashboardAttentionBanner(
  source: DashboardSourceCard,
  options: DashboardAttentionOptions,
): DashboardAttentionBanner | undefined {
  return credentialBanner(source, options)
    ?? terminalExtractionBanner(source, options)
    ?? laneStuckBanner(source, options.now ?? new Date(), options);
}

/**
 * The connection needs an act.
 *
 * A credential the broker cannot READ outranks everything, including a connect
 * button: authorizing again would write a fresh secret into a store that still
 * cannot be read, so the sentence sends the reader where the act actually is
 * and offers nothing to press. Below that, a route that exists gets the real
 * control and a route that does not gets a sentence saying where it lives.
 *
 * A connected source still carrying a connect action means the provider is
 * refusing requests — the view model only re-arms a healthy connection for that
 * reason, and never for a lane Olympus parked itself — so that reconnect leads
 * exactly as an expired credential's would.
 */
function credentialBanner(
  source: DashboardSourceCard,
  options: DashboardAttentionOptions,
): DashboardAttentionBanner | undefined {
  const label = source.label;
  const degraded = options.degradedCredentials ?? [];
  if (degraded.length > 0) {
    return {
      kind: 'credential',
      sentence: `Olympus cannot read the stored credential for ${label}. Add the key back in 1Password —`
        + ` nothing on this page can do it.`,
    };
  }
  const action = source.connection.action;
  const healthy = HEALTHY_CONNECTION_STATES.has(source.connection.state);
  if (!healthy) {
    if (action.kind === 'needs_setup') {
      return {
        kind: 'credential',
        sentence: `${label} needs its own app key before it can connect.`
          + ` The setup page carries the form and the steps.`,
        action: { label: action.label, kind: 'link', href: options.setupPath },
      };
    }
    if (action.kind === 'oauth' || action.kind === 'api_key') {
      return { kind: 'credential', ...connectAct(source, action, options) };
    }
    if (action.kind === 'guided_session') {
      // The definition's own last instruction is the one line that names the
      // act; there is no pairing route to offer as a button.
      return {
        kind: 'credential',
        sentence: action.instructions.at(-1)
          ?? `${label} is ${source.connection.label}, and this page carries no control for it.`,
      };
    }
    return {
      kind: 'credential',
      sentence: `${label} is ${source.connection.label}, and this page carries no control for it.`,
    };
  }
  if (action.kind === 'needs_setup') {
    return {
      kind: 'credential',
      sentence: `${label}'s provider is refusing requests, and reconnecting needs the app key first — the setup`
        + ` page carries the form and the steps.`,
      action: { label: action.label, kind: 'link', href: options.setupPath },
    };
  }
  if (action.kind === 'oauth' || action.kind === 'api_key') {
    return { kind: 'credential', ...refusingAct(source, action, options) };
  }
  // A chat source reads connected on sync evidence alone — nothing exposes its
  // session — so a card whose syncing has gone stale past its own window is
  // saying the only thing it can say: pairing is the lever, and this page
  // cannot tell you whether the session is what broke. Gated on staleness, or
  // it would nag every healthy chat source forever.
  if (action.kind === 'guided_session' && action.label === 'Session state not surfaced' && source.freshness.stale) {
    return {
      kind: 'credential',
      sentence: `Olympus cannot read the ${label} session from here. If it has stopped syncing, pairing is the`
        + ` only lever: ${action.instructions.at(-1) ?? 'pairing happens outside the dashboard'}`,
    };
  }
  return undefined;
}

type ConnectAction = Extract<DashboardSourceCard['connection']['action'], { kind: 'oauth' | 'api_key' }>;

/** The act for a connection that is not up: press the control, or go where it is. */
function connectAct(
  source: DashboardSourceCard,
  action: ConnectAction,
  options: DashboardAttentionOptions,
): { sentence: string; action: DashboardActionInput } {
  const label = source.label;
  if (options.readOnly === true) {
    return {
      sentence: `${label} has to be connected from the setup page — this control takes the worker token, and the`
        + ` link you arrived with is read-only.`,
      action: { label: action.label, kind: 'link', href: options.setupPath, hint: 'needs the worker token' },
    };
  }
  return {
    sentence: action.kind === 'oauth'
      ? `Press ${action.label} and approve Olympus on ${label}'s own consent page.`
      : `Paste a working ${label} API key here and press ${action.label}.`,
    action: { label: action.label, kind: action.kind, source: action.source, primary: true },
  };
}

/** The same act, for a connection that is up while the provider refuses it. */
function refusingAct(
  source: DashboardSourceCard,
  action: ConnectAction,
  options: DashboardAttentionOptions,
): { sentence: string; action: DashboardActionInput } {
  const label = source.label;
  if (options.readOnly === true) {
    return {
      sentence: `${label}'s provider is refusing requests — reconnect the credential from the setup page; the`
        + ` link you arrived with is read-only.`,
      action: { label: action.label, kind: 'link', href: options.setupPath, hint: 'needs the worker token' },
    };
  }
  return {
    sentence: action.kind === 'oauth'
      ? `${label}'s provider is refusing requests — press ${action.label} and approve Olympus on`
        + ` ${label}'s own consent page.`
      : `${label}'s provider is refusing requests — paste a working ${label} API key here and`
        + ` press ${action.label}.`,
    action: { label: action.label, kind: action.kind, source: action.source, primary: true },
  };
}

/** Files that failed extraction outright, and the one lever that changes them. */
function terminalExtractionBanner(
  source: DashboardSourceCard,
  options: DashboardAttentionOptions,
): DashboardAttentionBanner | undefined {
  const count = source.needs_review?.reasons
    .find((reason) => reason.key === TERMINAL_EXTRACTION_REVIEW_KEY)?.count ?? 0;
  if (count <= 0) return undefined;
  const files = `${dashboardCount(count)} ${count === 1 ? 'file' : 'files'}`;
  const they = count === 1 ? 'it' : 'them';
  const pickerPath = options.folderPickerPath;
  // The first draft of this banner led with "Choose folders", and the owner
  // read it as the dashboard forgetting his scope selection (2026-08-24). The
  // scope is fine; these are individual unreadable files INSIDE it. The copy
  // now says that first, and the action is framed as optional tidying, not a
  // setup step owed.
  if (pickerPath === undefined) {
    return {
      kind: 'terminal_extraction',
      sentence: `Your folder choices are fine — but ${files} inside ${count === 1 ? 'it' : 'them'}`
        + ` ${count === 1 ? 'is' : 'are'} unreadable (extraction failed permanently, no lane retries`
        + ` ${they}). ${count === 1 ? 'It' : 'They'} will stay metadata-only unless excluded.`,
    };
  }
  return {
    kind: 'terminal_extraction',
    sentence: `Your folder choices are fine — but ${files} inside ${count === 1 ? 'it' : 'them'}`
      + ` ${count === 1 ? 'is' : 'are'} unreadable (extraction failed permanently, no lane retries`
      + ` ${they}). Leaving ${they} as metadata-only is fine; excluding ${they} is optional tidying.`,
    // The picker takes the control session; a read-only reader is sent to the
    // setup page's gate first rather than to a page that will refuse them.
    action: options.readOnly === true
      ? { label: 'Exclude unreadable files', kind: 'link', href: `${options.setupPath}#dashboard-controls`, hint: 'unlock controls in Setup' }
      : { label: 'Exclude unreadable files', kind: 'link', href: pickerPath },
  };
}

/**
 * A lane with open work that has stopped moving for longer than its own grace
 * window.
 *
 * Every clause here exists to keep the banner quiet. It needs open work, it
 * needs evidence of idleness measured in hours rather than inferred, and it
 * needs that idleness to exceed the lane's own refresh window. A lane that is
 * merely between runs, retrying, rate-limited or waiting out a daily budget has
 * none of those and says nothing at all.
 *
 * The one condition that arms without a clock is a lane switched off — a held
 * or disabled extraction drain, or an embedding lane reporting itself disabled.
 * A lane nothing is driving will not move however long anyone waits, so its
 * grace window never elapses and waiting for it to would be silence forever.
 */
function laneStuckBanner(
  source: DashboardSourceCard,
  now: Date,
  options: DashboardAttentionOptions,
): DashboardAttentionBanner | undefined {
  if (!hasOpenWork(source)) return undefined;
  const idleHours = idleEvidenceHours(source);
  if (!switchedOff(source)) {
    if (idleHours === undefined) return undefined;
    if (idleHours <= graceHours(source)) return undefined;
    if (isSelfHealing(source, now)) return undefined;
  }
  const condition = governingCondition(source);
  const stillness = idleHours === undefined
    ? 'has stopped moving'
    : `has not moved for ${dashboardDuration(idleHours * 3600)}`;
  // The one act a route exists for is a manual sync, offered wherever the
  // source has a sync route (the oauth and api-key families). A read-only
  // reader gets the gate link instead of a button that can only 401. The
  // agent prompt is the second act and the only one for a paired chat source.
  // Read off the source definition, not the card's connect action: a
  // connected source carries no connect action at all, and it is exactly the
  // connected-but-stuck source this banner is for.
  const definition = DASHBOARD_SUPPORTED_SOURCES.find((entry) => entry.source_id === source.source_id);
  const syncSource = definition?.connect_action.kind === 'oauth' || definition?.connect_action.kind === 'api_key'
    ? definition.connect_action.source
    : undefined;
  const action: DashboardActionInput | undefined = syncSource === undefined
    ? undefined
    : options.readOnly === true
      ? { label: 'Sync now', kind: 'link', href: `${options.setupPath}#dashboard-controls`, hint: 'unlock controls in Setup' }
      : { label: 'Sync now', kind: 'sync_now', source: syncSource, primary: true };
  return {
    kind: 'lane_stuck',
    sentence: `${source.label} still has work to do and its lane ${stillness}. Last condition on the lane:`
      + ` ${condition}. Try a sync now; if it still does not move, ask your agent to look at the lane.`,
    ...(action === undefined ? {} : { action }),
    agent_prompt: `Olympus says the ${source.label} lane still has work to do and ${stillness}`
      + ` (last condition: ${condition}). Please check why the ${source.label} ingestion lane is not`
      + ' moving — the worker logs and the scheduler state for this source — and fix it using'
      + ' supported Olympus commands. Do not ask me to edit files, configuration, or code.',
  };
}

/**
 * True when a lane this source depends on is switched off rather than merely
 * between runs.
 *
 * Both halves are an explicit state somebody set: the extraction drain being
 * held or disabled, and the embedding lane reporting itself disabled. Neither
 * elapses, so neither waits for a grace window — a lane nothing is driving is
 * as stuck at one minute as it is at one week.
 */
function switchedOff(source: DashboardSourceCard): boolean {
  const drain = source.ingestion_health.drain_state;
  if (drain === 'held' || drain === 'disabled') return true;
  return source.embedding_lane_state === 'embedding_lane_disabled';
}

/** True when some phase still has work, or something is stuck part-way. */
function hasOpenWork(source: DashboardSourceCard): boolean {
  if (source.ingestion_health.stuck_count > 0) return true;
  const progress = dashboardSourceProgress(source);
  return progress.phases.length > 0 && !progress.settled;
}

/**
 * The longest stillness the card can actually measure, in hours.
 *
 * Undefined means nothing on the card measures it — and an unmeasured lane is
 * never called stuck. `freshness.hours` only counts when the source's own
 * staleness rule says it is late; on a fresh lane it is just the time since the
 * last check, which proves nothing.
 */
function idleEvidenceHours(source: DashboardSourceCard): number | undefined {
  const candidates = [
    source.freshness.stale ? source.freshness.hours : undefined,
    source.ingestion_health.last_drain_activity_hours,
    source.ingestion_health.oldest_stuck_age_hours,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (candidates.length === 0) return undefined;
  return Math.max(...candidates);
}

/** The lane's own refresh window where it declares one; a day where it does not. */
function graceHours(source: DashboardSourceCard): number {
  const threshold = source.freshness.threshold_hours;
  return typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0
    ? threshold
    : DEFAULT_GRACE_HOURS;
}

/**
 * True when the lane is going to clear this by itself.
 *
 * A run due inside the grace window is the whole test, and it counts only while
 * the lane is not already failing: a sync that has failed three times in a row
 * is due again in five minutes too, and calling that self-healing is how a
 * page ends up silent about a lane that has been broken for days.
 */
function isSelfHealing(source: DashboardSourceCard, now: Date): boolean {
  const schedule = source.schedule;
  if (!schedule || schedule.consecutive_failures > 0) return false;
  const nextAt = Date.parse(schedule.next_run_at ?? '');
  if (!Number.isFinite(nextAt)) return false;
  const aheadHours = (nextAt - now.getTime()) / 3_600_000;
  return aheadHours <= graceHours(source);
}

/**
 * The last thing that governed this lane, in plain words.
 *
 * A switch somebody threw leads: it is both the most specific fact available
 * and, when it is what armed the banner, the only one that explains it. A
 * scheduler marker under a held drain would describe a different lane than the
 * one that has stopped.
 *
 * Below that, the pause the scheduler is carrying NOW outranks the error kind
 * it recorded on the way in: a budget guard parks a lane holding whatever kind
 * it last saw, and printing that stale kind is the same mistake one level down.
 */
function governingCondition(source: DashboardSourceCard): string {
  const drain = source.ingestion_health.drain_state;
  if (drain === 'held' || drain === 'disabled') return DASHBOARD_DRAIN_CONSEQUENCES[drain];
  if (source.embedding_lane_state === 'embedding_lane_disabled') {
    return 'the embedding lane is switched off, so no new chunks are being embedded';
  }
  const schedule = source.schedule;
  const degradedReason = schedule?.degraded_reason;
  if (degradedReason) return DASHBOARD_GUARD_CONSEQUENCES[degradedReason] ?? degradedReason;
  const errorKind = schedule && schedule.consecutive_failures > 0 ? schedule.last_error_kind : undefined;
  if (errorKind) return DASHBOARD_GUARD_CONSEQUENCES[errorKind] ?? errorKind;
  return 'nothing has reported a reason';
}
