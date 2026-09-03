/**
 * Source detail: what this source is doing, in four sections and no more.
 *
 * Redesigned 2026-08-24 with the owner. The page used to open with a wall of
 * tiles — freshness, flow, errors, backlog, searchable — and then explain
 * itself in a checks list. It answered "what is the system's internal state"
 * when the question was "how much of my stuff is in, and is anything waiting on
 * me". The four sections answer that one instead:
 *
 *   1. The ATTENTION BANNER and the one summary number. The banner is the
 *      page's only error surface and appears only for a class a person can act
 *      on; the number is fully-working files over the files Olympus is supposed
 *      to handle.
 *   2. PROGRESS — the three pipeline phases as bars, each in its own unit, each
 *      honest about a denominator it does not have. At 100% everywhere the bars
 *      come down and one settled line replaces them.
 *   3. SCOPE — the owner's own rules, unchanged. The full picker UX is
 *      deliberately still deferred.
 *   4. ADVANCED — a closed fold holding sensitivity, the last run, the checks
 *      and needs review. Nothing was deleted, and nothing inside was rewritten:
 *      their own truth problems are separate work.
 *
 * Everything the page draws is still read off a real field, and the sections
 * with no backing field still render nothing at all. The mockup's twenty-run
 * strip and activity feed remain absent for the same reason as before:
 * `last_run` is the newest refresh, not a series, and no event stream exists.
 */
import type {
  DashboardExcludedRule,
  DashboardExcludedSource,
  DashboardNeedsReviewActor,
  DashboardNeedsReviewReason,
  DashboardSourceCard,
  DashboardSourceRun,
  SourceDashboardViewModel,
} from '../../source-dashboard.ts';
import { dashboardGuidedSessionAgentPrompt } from '../../source-dashboard.ts';
import type { WorkerCredentialDegradation } from '../../credential-degradation.ts';
import {
  DASHBOARD_POLICY_CSS,
  DASHBOARD_PROGRESS_CSS,
  actionButton,
  advancedPanel,
  attentionBanner,
  clipboardScript,
  connectorSheet,
  controlScript,
  countChip,
  escapeHtml,
  pageShell,
  phaseBar,
  scopeRow,
} from '../components.ts';
import {
  DASHBOARD_GUARD_CONSEQUENCES,
  HEALTHY_CONNECTION_STATES,
  dashboardAttentionBanner,
} from '../attention.ts';
import {
  dashboardItemNoun,
  dashboardSourceProgress,
  type DashboardPhase,
  type DashboardProgress,
} from '../phases.ts';
import type { EmbeddingRuntimeFacts } from '../embedding-runtime.ts';
import { DASHBOARD_NAV_CSS, renderDashboardNav } from '../nav.ts';
import { dashboardNeedsReview, dashboardScopeForCard } from '../contract.ts';
import { OPERATOR_PAUSED_SCHEDULER_MARKERS } from '../scheduler-markers.ts';
import {
  dashboardCheckedLabel,
  dashboardCount,
  dashboardDuration,
  dashboardRelativeFromHours,
  dashboardRelativeFromMs,
  dashboardNotReadByPolicyPhrase,
  dashboardOperatorPaused,
  dashboardSourceById,
  dashboardStatus,
  dashboardWorkingSummary,
  type DashboardVocabularyOptions,
} from '../vocabulary.ts';
import type { DashboardPageOptions } from './home.ts';

/** How many run bars the strip will draw. The mockup's window. */
const RUN_STRIP_LIMIT = 20;

/** Duplicated from index.ts, which imports this module: one string, no cycle. */
const SENSITIVITY_QUERY_PARAM = 'sensitivity';

/** Duplicated for the same reason as SENSITIVITY_QUERY_PARAM. */
const SETUP_QUERY_PARAM = 'setup';

const DEFAULT_BASE_PATH = '/dashboard';

/** The reader-facing word for each disposition a scope rule can carry. */
const SCOPE_MODE_WORDS: Readonly<Record<string, string>> = {
  exclude: 'invisible',
  metadata_only: 'metadata only',
};

/**
 * What this page needs beyond the card itself: the page-wide blocks its new
 * sections bind to, resolved by the page function so the body stays a pure
 * function of one source.
 */
export interface DashboardDetailBodyOptions extends DashboardVocabularyOptions {
  /** Path prefix this page's own links are built from, carrying the token. */
  basePath?: string;
  /** This card's share of the exclusion rules, matched by corpus id. */
  scope?: DashboardExcludedSource;
  /** Where the bearer-gated folder picker lives; absent means no Edit link. */
  folderPickerPath?: string;
  /** True for a reader on the read-only dash_ token; see DashboardPageOptions. */
  readOnly?: boolean;
  /** Shared lane movement evidence rendered beside the embedding stage. */
  embeddingRuntime?: EmbeddingRuntimeFacts;
}

/** Undefined when no card on the view model owns `sourceId`. */
export function renderDashboardDetailPage(
  view: SourceDashboardViewModel,
  sourceId: string,
  options?: DashboardPageOptions,
): string | undefined {
  const source = dashboardSourceById(view, sourceId);
  if (!source) return undefined;
  const now = options?.now ?? new Date();
  const degraded = options?.degradedCredentials ?? view.degraded_credentials ?? [];
  const status = dashboardStatus({ source, degradedCredentials: degraded });
  const checked = dashboardCheckedLabel(view.generated_at, now);
  const scope = dashboardScopeForCard(view, source);
  // The picker route refuses the read-only query token, so the link is offered
  // only where the route exists at all; `available` is the worker saying so.
  const folderPickerPath = view.folder_picker?.available === true ? view.folder_picker.path : undefined;
  return pageShell({
    title: 'Olympus',
    crumb: source.label,
    ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
    // Plain text: the shell escapes meta, so the mockup's colored status word
    // cannot be sent through it as markup.
    meta: checked ? `${status} · ${checked}` : status,
    // Detail is reached FROM home, so the Home tab stays lit and the crumb
    // above carries the source's own name — nav for the section, crumb for
    // the page.
    body: renderDashboardNav('home', {
      ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
    }) + renderDashboardDetailBody(source, {
      now,
      degradedCredentials: degraded,
      ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
      ...(scope === undefined ? {} : { scope }),
      ...(folderPickerPath === undefined ? {} : { folderPickerPath }),
      ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
      ...(options?.embeddingRuntime === undefined ? {} : { embeddingRuntime: options.embeddingRuntime }),
    }),
    styles: [DASHBOARD_POLICY_CSS, DASHBOARD_PROGRESS_CSS, DASHBOARD_NAV_CSS],
    // Same poll as home: refetches this page's own URL, so the detail view
    // stays as live as the cards that link to it. The control script rides
    // along because this page now carries the connect control for a source
    // that needs one — the row a warning on home leads to has to be able to
    // finish what the warning is about.
    scripts: [
      clipboardScript(),
      controlScript({ csrfToken: options?.controlSessionCsrfToken }),
    ],
    poll: {
      unlocked: options?.controlSessionCsrfToken !== undefined,
      ...(options?.controlSessionCsrfToken === undefined ? {} : { controlSessionCsrfToken: options.controlSessionCsrfToken }),
    },
  });
}

/**
 * The detail body without the shell, so the page's own composition can be read
 * and tested on its own. Every value here comes off the card.
 */
export function renderDashboardDetailBody(
  source: DashboardSourceCard,
  options?: DashboardDetailBodyOptions,
): string {
  const now = options?.now ?? new Date();
  const degraded = degradationsFor(source, options?.degradedCredentials ?? []);
  const progress = dashboardSourceProgress(source, {
    now,
    ...(options?.embeddingRuntime === undefined ? {} : { embeddingRuntime: options.embeddingRuntime }),
  });
  // Owner ruling, 2026-08-24 design session. Four sections, in this order, and
  // nothing else above the fold:
  //
  //   1. the banner, when something is genuinely waiting on a person, and the
  //      one summary number under it;
  //   2. PROGRESS — the three phase bars, in their own units;
  //   3. SCOPE — what the owner's rules let in;
  //   4. ADVANCED — a closed fold holding everything the page used to lead
  //      with. Nothing was deleted; it was demoted.
  //
  // The foot stays outside the fold: it is the page's footnote, not a section,
  // and the policy-exit count it carries is required to remain reachable.
  //
  // The totals line joined that order on 2026-09-02, immediately above the
  // bars: the bars describe the pass in flight, and a reader who is only ever
  // shown a batch has no way to ask how much is in Olympus at all.
  return [
    renderAttention(source, degraded, options),
    renderIngestionSelection(source),
    renderTotals(source),
    renderProgress(source, progress, now),
    renderScope(options?.scope, options?.folderPickerPath, options),
    renderAdvanced(source, degraded, options, now),
    renderFoot(source, now),
  ].filter((section) => section.length > 0).join('');
}

function renderIngestionSelection(source: DashboardSourceCard): string {
  const selection = source.ingestion_selection;
  if (!selection) return '';
  return `
        <div class="dsect">Added to Olympus</div>
        <div class="selectioncounts">
          <div><span>Metadata only</span><b>${escapeHtml(`${dashboardCount(selection.metadata_only_files)} files`)}</b></div>
          <div><span>Full ingestion</span><b>${escapeHtml(`${dashboardCount(selection.full_ingestion_files)} files`)}</b></div>
        </div>`;
}

/**
 * IN OLYMPUS — the three standing totals, in the same shape as the selection
 * counts above them (owner decision, 2026-09-02).
 *
 * The bars below describe the CURRENT PASS and come down when it drains. This
 * line does neither: it is the answer to "how much of this source is in
 * Olympus", it is there whether or not anything is moving, and it is what makes
 * a delta-scoped bar safe to show — the reader loses no corpus-wide figure by
 * the bars narrowing to the batch.
 *
 * Every number is one the page already divides by. Extraction is the in-scope
 * read count the extraction bar's numerator comes from, not the raw counter, so
 * the line and the bar can never state different figures for the same thing.
 * Embedding is clamped to it for the reason the bar is (owner ruling,
 * 2026-09-01: embedding is measured in files and never runs ahead of
 * extraction), and a store that publishes no per-item count says so in words —
 * a number there would be derived, and would print as a measured one.
 */
function renderTotals(source: DashboardSourceCard): string {
  const noun = dashboardItemNoun(source);
  const summary = dashboardWorkingSummary(source);
  const indexed = Math.max(0, source.coverage.indexed_items);
  const extracted = summary?.read_items
    ?? Math.max(0, Math.min(source.coverage.content_ready_items, indexed));
  const measured = source.coverage.embedded_files;
  const embedded = measured === undefined
    ? 'not measured'
    : `${dashboardCount(Math.max(0, Math.min(measured, extracted)))} ${noun}`;
  return `
        <div class="dsect">In Olympus</div>
        <div class="selectioncounts">
          <div><span>Indexed</span><b>${escapeHtml(`${dashboardCount(indexed)} ${noun}`)}</b></div>
          <div><span>Text extracted</span><b>${escapeHtml(`${dashboardCount(extracted)} ${noun}`)}</b></div>
          <div><span>Embedded</span><b>${escapeHtml(embedded)}</b></div>
        </div>`;
}

/**
 * ADVANCED: everything this page used to open with, folded away.
 *
 * The four sections are byte-for-byte the ones that used to sit in the reading
 * order — sensitivity and its tiers link, the last run, the checks, needs
 * review. Their own truth problems are somebody else's work order; the only
 * thing that changed here is where they sit. An empty fold renders nothing at
 * all rather than a disclosure with nothing behind it.
 */
function renderAdvanced(
  source: DashboardSourceCard,
  degraded: readonly WorkerCredentialDegradation[],
  options: DashboardDetailBodyOptions | undefined,
  now: Date,
): string {
  const body = [
    renderCapabilities(source),
    renderSensitivity(source, options?.basePath),
    renderRuns(source, now),
    renderChecksTip(detailChecks(source, degraded, now)),
    renderNeedsReview(source),
  ].filter((section) => section.length > 0).join('');
  return advancedPanel({ label: 'Advanced', body });
}

function renderCapabilities(source: DashboardSourceCard): string {
  const capability = source.capabilities;
  if (!capability) return '';
  const dependencies = capability.dependencies
    .map((dependency) => `${dependency.label} — ${dependency.required_for}`)
    .join('; ');
  return `
        <div class="dsect">Source capability</div>
        <div class="tip"><div class="h">Authentication</div>${escapeHtml(capability.authentication.type)} · ${escapeHtml(capability.authentication.ownership)}</div>
        <div class="tip"><div class="h">Contextual scope</div>${escapeHtml(capability.contextual_scopes.join('; '))}</div>
        <div class="tip"><div class="h">Dependencies</div>${escapeHtml(dependencies)}</div>
        <div class="tip"><div class="h">Provider ceiling</div>${escapeHtml(capability.provider_ceiling)}</div>`;
}

/**
 * The attention banner — the page's ONLY error surface (owner ruling,
 * 2026-08-24 design session).
 *
 * Everything the page used to say about failure said it in counts: an Errors
 * tile, a Backlog tile, a checks list opening with a red row. None of those
 * told a reader what to do, and most of what they counted was a lane retrying
 * itself. They are gone. What is left is one banner that appears only for the
 * three classes a person can actually act on, and says nothing at all for a
 * fault that clears itself.
 *
 * The classes, the precedence and the silence all live in attention.ts; this
 * function is the render, and it holds no policy of its own beyond handing that
 * module the two routes only the page knows about.
 */
function renderAttention(
  source: DashboardSourceCard,
  degraded: readonly WorkerCredentialDegradation[],
  options: DashboardDetailBodyOptions | undefined,
): string {
  const banner = dashboardAttentionBanner(source, {
    now: options?.now ?? new Date(),
    ...(degraded.length > 0 ? { degradedCredentials: degraded } : {}),
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    setupPath: setupHref(options?.basePath),
    ...(options?.folderPickerPath === undefined ? {} : { folderPickerPath: options.folderPickerPath }),
  });
  if (!banner) return '';
  const guided = source.connection.action.kind === 'guided_session'
    ? source.connection.action
    : undefined;
  const sheetId = guided === undefined
    ? undefined
    : `agent-${source.source_id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
  // A banner that names a fault no route clears carries its agent prompt as
  // a second control: the sheet under the banner, same copy wiring as pairing.
  const helpSheetId = banner.agent_prompt === undefined
    ? undefined
    : `help-${source.source_id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
  const bannerMarkup = attentionBanner({
    label: source.label,
    sentence: maskSecrets(banner.sentence),
    ...(banner.action !== undefined
      ? { action: banner.action }
      : sheetId === undefined
        ? {}
        : { action: { label: 'Ask your agent', kind: 'none', sheet: sheetId } }),
    ...(helpSheetId === undefined
      ? {}
      : { secondaryAction: { label: 'Ask your agent', kind: 'none', sheet: helpSheetId } }),
  });
  const helpSheet = helpSheetId === undefined || banner.agent_prompt === undefined
    ? ''
    : `\n        ${connectorSheet({
      id: helpSheetId,
      heading: `Ask your agent about ${source.label}`,
      intro: 'Copy this prompt into your agent. It names what the dashboard can see and asks for a fix through supported Olympus commands only.',
      promptText: maskSecrets(banner.agent_prompt),
      copyButtonLabel: 'Copy prompt',
    })}`;
  if (guided === undefined || sheetId === undefined) return `\n        ${bannerMarkup}${helpSheet}`;
  const sheet = connectorSheet({
    id: sheetId,
    heading: `Pair ${source.label} with your agent`,
    intro: 'Copy this prompt into your agent. It uses the supported Olympus pairing flow and does not require code or configuration editing.',
    promptText: dashboardGuidedSessionAgentPrompt(guided.source),
    copyButtonLabel: 'Copy prompt',
  });
  return `\n        ${bannerMarkup}\n        ${sheet}${helpSheet}`;
}

function setupHref(basePath?: string): string {
  const path = basePath ?? DEFAULT_BASE_PATH;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${SETUP_QUERY_PARAM}`;
}

/**
 * PROGRESS — the three phase bars, or the settled line that replaces all three.
 *
 * At 100% everywhere the bars come down entirely (owner ruling): a row of full
 * bars is a wall of nothing-to-report, and what the reader wants to know at
 * that point is that Olympus is still watching and when it last saw a change.
 * New material re-opens the bars, and where it re-opens them scoped to a delta
 * the section says so rather than quoting a corpus-wide share the delta has no
 * claim on.
 */
function renderProgress(
  source: DashboardSourceCard,
  progress: DashboardProgress,
  now: Date,
): string {
  const headingText = progress.delta
    ? 'Current update'
    : source.connection.state === 'syncing' || source.freshness.label === 'Waiting for first check'
      ? 'Initial ingestion'
      : 'Ingestion';
  const heading = `
        <div class="dsect">${headingText}</div>`;
  // Three rows, always, one colour, each with its own unit and its own state
  // word (owner ruling, 2026-09-01). A percent is passed ONLY for a measure
  // that has one; an indeterminate or remaining measure passes none, so the
  // component cannot draw a fill it was not given a share for.
  const bars = progress.phases.map((phase) => {
    const measure = phase.measure;
    return phaseBar({
      name: phase.label,
      facts: phaseFacts(phase),
      label: `${phase.label} progress`,
      state: phase.state,
      stateWords: phase.state_words,
      ...(measure.kind === 'ratio' ? { percent: measure.percent } : {}),
    });
  }).join('');
  const notes: string[] = [];
  if (progress.phases.some((phase) => phase.tracks_sync === true)) {
    notes.push(`${source.label} delivers its text with each item, so there is no separate extraction step: the extraction row tracks the sync row.`);
  }
  if (progress.phases.some((phase) => phase.unmeasured === true)) {
    notes.push('This store does not yet publish a per-item embedding count, so the embedding row states no share rather than deriving one from chunk totals.');
  }
  if (progress.phases.some((phase) => phase.scope === 'delta')) {
    // The last sentence belongs only to a delta that HAS no denominator. Once
    // a settled baseline gives the batch a real one, saying it would describe
    // a page that is not on screen.
    const unmeasured = progress.phases.some((phase) => phase.scope === 'delta' && phase.denominator_unavailable);
    notes.push('These counts cover only new or changed material. Existing indexed material remains searchable while this update finishes.'
      + (unmeasured ? ' No percentage is shown when the update\'s starting total was not recorded.' : ''));
  }
  const note = notes.map((text) => `
        <div class="quiet after">${escapeHtml(text)}</div>`).join('');
  const settled = progress.settled
    ? `
        <div class="settled">${escapeHtml(settledLine(source, now))}</div>`
    : '';
  return `${heading}
        ${bars}${settled}${note}`;
}

/**
 * "Fully synced · watching for changes · last change picked up 41m ago".
 *
 * The last clause is the ingestion ledger's own last-sync stamp. When the card
 * carries none, the clause degrades to the last CHECK and says so — the page
 * has never had a last-new-item time, and the owner's sentence does not create
 * one. With neither stamp the sentence simply stops.
 *
 * The middle clause is a claim, and a lane Olympus has parked is not making it:
 * a parked source is caught up on everything it has seen and is not currently
 * looking for more. It says so instead, in the same two words the home card
 * uses for the same marker.
 */
function settledLine(source: DashboardSourceCard, now: Date): string {
  const lead = dashboardOperatorPaused(source)
    ? 'Fully synced · sync paused'
    : 'Fully synced · watching for changes';
  const lastSyncAt = Date.parse(source.last_sync_at ?? '');
  if (Number.isFinite(lastSyncAt)) {
    const relative = dashboardRelativeFromMs(now.getTime() - lastSyncAt);
    if (relative) return `${lead} · last change picked up ${relative}`;
  }
  const hours = source.freshness.hours;
  if (typeof hours === 'number' && Number.isFinite(hours) && hours >= 0) {
    const relative = dashboardRelativeFromHours(hours);
    if (relative) return `${lead} · last checked ${relative}`;
  }
  return lead;
}

/** The facts line beside one bar, always in that phase's own unit. */
function phaseFacts(phase: DashboardPhase): string {
  const measure = phase.measure;
  if (phase.not_applicable === true) return 'no embedding stage for this source';
  if (phase.unmeasured === true) return 'this store does not publish a per-item count yet';
  if (measure.kind === 'indeterminate') {
    return `${dashboardCount(measure.done)} ${unitFor(measure.done, phase.unit)} so far · total not known yet`;
  }
  if (measure.kind === 'remaining') {
    return `${dashboardCount(measure.remaining)} ${unitFor(measure.remaining, phase.unit)} remaining`
      + ` · share not measured`;
  }
  // Nothing in scope is not "100%": there is no share to print.
  if (measure.total === 0) return `nothing in scope yet`;
  const noun = unitFor(measure.total, phase.unit);
  const unit = phase.scope === 'delta' ? `new ${noun}` : noun;
  const tracks = phase.tracks_sync === true ? ' · with sync' : '';
  return `${formatPercent(measure.percent)} · ${dashboardCount(measure.done)} of`
    + ` ${dashboardCount(measure.total)} ${unit}${tracks}`;
}

/**
 * "1 chunk", "3 chunks".
 *
 * Every phase unit is a regular plural ending in s — folders, items, files,
 * chunks — so one rule covers all four, and a unit that is not regular would
 * have to say so rather than be silently mangled here.
 */
function unitFor(count: number, unit: string): string {
  return count === 1 && unit.endsWith('s') ? unit.slice(0, -1) : unit;
}

/** Whole numbers stay whole; a fraction keeps one decimal. */
function formatPercent(percent: number): string {
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

/**
 * The strip and the run table, from the runs the card carries.
 *
 * Today that is at most one — `last_run` is the newest refresh and nothing
 * upstream keeps a series — so the heading counts what exists rather than
 * promising twenty. The slice is a guard for the day a series arrives.
 */
function renderRuns(source: DashboardSourceCard, now: Date): string {
  const runs = (source.last_run ? [source.last_run] : []).slice(-RUN_STRIP_LIMIT);
  if (runs.length === 0) return '';
  const bars = runs.map((run) => `<i style="background:${runColor(run.status)}"></i>`).join('');
  const heading = runs.length === 1 ? 'Last run' : `Last ${dashboardCount(runs.length)} runs`;
  const first = runs[0];
  const rows = runs.map((run) => `
            <tr><td>${escapeHtml(runWhen(run, now))}</td><td style="color:${runColor(run.status)}">${escapeHtml(runResultLabel(run.status))}</td><td>${escapeHtml(runTook(run))}</td><td>${escapeHtml(dashboardCount(run.items_indexed))}</td><td>${escapeHtml(dashboardCount(run.items_seen))}</td></tr>`).join('');
  return `
        <div class="dsect">${escapeHtml(heading)}</div>
        <div class="bigstrip" aria-label="${escapeHtml(heading)}, oldest to newest">${bars}</div>
        <div class="stripcap"><span>${escapeHtml(first ? runWhen(first, now) : '')}</span><span>${escapeHtml(nextRunLabel(source, now))}</span></div>
        <table>
          <tr><th>When</th><th>Result</th><th>Took</th><th>Indexed</th><th>Seen</th></tr>${rows}
        </table>`;
}

function runWhen(run: DashboardSourceRun, now: Date): string {
  const stamp = run.completed_at ?? run.started_at;
  if (!stamp) return 'time not recorded';
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return 'time not recorded';
  return dashboardRelativeFromMs(now.getTime() - at);
}

function runTook(run: DashboardSourceRun): string {
  const seconds = run.duration_seconds;
  // An unfinished or unstamped run has no duration, and zero is a claim.
  return typeof seconds === 'number' && Number.isFinite(seconds) ? dashboardDuration(seconds) : '—';
}

function runColor(status: string): string {
  if (status === 'completed') return 'var(--good)';
  if (status === 'failed') return 'var(--bad)';
  if (status === 'running') return 'var(--run)';
  return 'var(--line)';
}

/**
 * The Result cell's designed copy — mark plus sentence case — instead of the
 * raw enum. An unrecognized status is sentence-cased rather than dropped.
 */
function runResultLabel(status: string): string {
  if (status === 'completed') return '✓ Completed';
  if (status === 'failed') return '✕ Failed';
  if (status === 'running') return '● Running';
  return status.length > 0 ? status[0]!.toUpperCase() + status.slice(1) : status;
}

function nextRunLabel(source: DashboardSourceCard, now: Date): string {
  const nextRunAt = source.schedule?.next_run_at;
  if (!nextRunAt) return 'now';
  const at = Date.parse(nextRunAt);
  if (!Number.isFinite(at)) return 'now';
  const ahead = at - now.getTime();
  return ahead <= 0 ? 'due now' : `next in ${dashboardDuration(ahead / 1000)}`;
}

interface DetailCheck {
  /** The mechanical claim, e.g. QUEUE_ATTENTION. */
  name: string;
  /** What this page actually read. */
  observed: string;
  /** The comparison the claim makes, e.g. "== 0". */
  expectation?: string | undefined;
  /** Plain-language cause, always a prose field off the card. */
  cause?: string | undefined;
  /** What this failure means for the reader. Absent on a passing check. */
  consequence?: string | undefined;
  ok: boolean;
}

/**
 * What each failing check class means, in plain language (owner ruling,
 * 2026-08-19).
 *
 * The keys are every check name detailChecks emits, enumerated from that
 * function — CONNECTION, ANSWER_LANE, FRESHNESS, LAST_RUN,
 * CONSECUTIVE_FAILURES, SCHEDULER, QUEUE_ATTENTION, RETRYING_TASKS,
 * STUCK_ITEMS, EXTRACTION_DRAIN, EMBEDDING_PARITY, CREDENTIAL — minus LEDGER,
 * whose rows carry the connector's own prose and get their consequence from
 * ledgerConsequence instead. A class added upstream and not added here prints
 * its raw line and nothing else: never invented copy.
 */
const DETAIL_CHECK_CONSEQUENCES: Readonly<Record<string, string>> = {
  CONNECTION: 'nothing new is coming in from this source until it is connected again',
  ANSWER_LANE: 'answers cannot use this source yet',
  FRESHNESS: "the last check is older than this source's own refresh window",
  LAST_RUN: 'the last sync did not finish, so anything it had not reached is still missing',
  CONSECUTIVE_FAILURES: 'the scheduled sync keeps failing, so this source is falling behind',
  SCHEDULER: 'the scheduler has parked this source',
  QUEUE_ATTENTION: 'these items are stuck and will not be answered on until they clear',
  RETRYING_TASKS: 'a sync task is retrying itself — no action needed unless it keeps failing',
  STUCK_ITEMS: 'these items are stuck part-way through extraction',
  EXTRACTION_DRAIN: 'no new text is being extracted while the lane is not draining',
  EMBEDDING_PARITY: 'waiting on the embedding lane',
  CREDENTIAL: 'the stored credential cannot be read, so this source cannot authenticate',
};

/**
 * The scheduler's own guard and budget markers now live in attention.ts, which
 * is where the banner reads them from too.
 *
 * They were duplicated here and there for exactly as long as two surfaces
 * needed them, which is how a lane the banner calls paused and a check row
 * calls refused end up on one page. One map, one translation.
 */
const DETAIL_GUARD_CONSEQUENCES = DASHBOARD_GUARD_CONSEQUENCES;

/**
 * The verdict rows. A check is skipped rather than guessed when its field is
 * absent, and no check invents an expectation the view model cannot support.
 */
function detailChecks(
  source: DashboardSourceCard,
  degraded: readonly WorkerCredentialDegradation[],
  now: Date,
): DetailCheck[] {
  const checks: DetailCheck[] = [];
  const connectionOk = HEALTHY_CONNECTION_STATES.has(source.connection.state);
  checks.push({
    name: 'CONNECTION',
    observed: source.connection.label,
    expectation: '== connected',
    cause: !connectionOk && source.connection.action.kind !== 'none' ? source.connection.action.label : undefined,
    ok: connectionOk,
  });
  // 'syncing' and 'empty' are ordinary transit, not failures: the check only
  // asserts the lane is not broken, so a healthy syncing card never trips the
  // whole tip into view. The printed expectation names BOTH failing values —
  // it must state the predicate actually applied, or a disconnected lane
  // reads as a failing row whose observed value satisfies the expectation.
  const answerLaneOk = source.answer_readiness.state !== 'needs_attention'
    && source.answer_readiness.state !== 'disconnected';
  checks.push({
    name: 'ANSWER_LANE',
    observed: source.answer_readiness.state,
    expectation: '!= needs_attention, != disconnected',
    cause: answerLaneOk ? undefined : source.answer_readiness.label,
    ok: answerLaneOk,
  });
  const hours = source.freshness.hours;
  if (typeof hours === 'number' && Number.isFinite(hours) && hours >= 0) {
    const threshold = source.freshness.threshold_hours;
    checks.push({
      name: 'FRESHNESS',
      observed: sinceLabel(hours),
      expectation: typeof threshold === 'number' ? `<= ${sinceLabel(threshold)}` : undefined,
      cause: source.freshness.stale ? source.freshness.label : undefined,
      ok: !source.freshness.stale,
    });
  }
  const lastRun = source.last_run;
  if (lastRun) {
    checks.push({
      name: 'LAST_RUN',
      observed: lastRun.status,
      expectation: '== completed',
      // No error text exists for a run; the run's own counts are the evidence.
      cause: lastRun.status === 'completed'
        ? undefined
        : `${dashboardCount(lastRun.items_indexed)} of ${dashboardCount(lastRun.items_seen)} items indexed`,
      ok: lastRun.status === 'completed',
    });
  }
  const schedule = source.schedule;
  if (schedule) {
    checks.push({
      name: 'CONSECUTIVE_FAILURES',
      observed: dashboardCount(schedule.consecutive_failures),
      expectation: '== 0',
      cause: schedule.consecutive_failures > 0 ? schedule.last_error_kind : undefined,
      ok: schedule.consecutive_failures === 0,
    });
    if (schedule.degraded_reason) {
      checks.push({
        name: 'SCHEDULER',
        observed: 'degraded',
        cause: schedule.degraded_reason,
        ok: false,
      });
    }
  }
  checks.push({
    name: 'QUEUE_ATTENTION',
    observed: dashboardCount(source.queue_health.needs_attention),
    expectation: '== 0',
    cause: source.queue_health.needs_attention > 0 ? source.queue_health.label : undefined,
    ok: source.queue_health.needs_attention === 0,
  });
  const retrying = source.queue_health.retrying_tasks;
  if (typeof retrying === 'number') {
    checks.push({
      name: 'RETRYING_TASKS',
      observed: dashboardCount(retrying),
      expectation: '== 0',
      ok: retrying === 0,
    });
  }
  checks.push({
    name: 'STUCK_ITEMS',
    observed: dashboardCount(source.ingestion_health.stuck_count),
    expectation: '== 0',
    cause: source.ingestion_health.stuck_count > 0 ? source.ingestion_health.label : undefined,
    ok: source.ingestion_health.stuck_count === 0,
  });
  if (source.ingestion_health.drain_state !== 'unknown') {
    checks.push({
      name: 'EXTRACTION_DRAIN',
      observed: source.ingestion_health.drain_state,
      expectation: '== enabled',
      cause: source.ingestion_health.drain_state === 'enabled' ? undefined : source.ingestion_health.drain_unit,
      ok: source.ingestion_health.drain_state === 'enabled',
    });
  }
  const backlog = source.embedding_backlog;
  if (backlog) {
    checks.push({
      name: 'EMBEDDING_PARITY',
      observed: `${dashboardCount(backlog.missing_chunks)} of ${dashboardCount(backlog.chunks)} chunks missing`,
      expectation: '== up to date',
      ok: !backlog.refresh_needed,
    });
  }
  // Reasons the ingestion ledger already wrote, verbatim: the only failure
  // prose on the card that names what broke.
  for (const reason of source.attention_reasons ?? []) {
    checks.push({ name: 'LEDGER', observed: reason, ok: false });
  }
  for (const entry of degraded) {
    checks.push({
      name: 'CREDENTIAL',
      observed: `${entry.state}, attempt ${dashboardCount(entry.attempts)} of ${dashboardCount(entry.max_attempts)}`,
      expectation: '== available',
      cause: [entry.hint, retryLabel(entry.next_retry_at, now)].filter((part) => !!part).join(' · '),
      ok: false,
    });
  }
  return checks.map((check) => withConsequence(check, source));
}

/**
 * The consequence line for one failing check.
 *
 * A guard marker on the card outranks the check class, because it is the more
 * specific truth: CONSECUTIVE_FAILURES with `api_request_guard` is a provider
 * refusal, not a generic failure. An unmapped marker falls back to the class
 * line, and an unmapped class to no line at all.
 */
function withConsequence(check: DetailCheck, source: DashboardSourceCard): DetailCheck {
  if (check.ok) return check;
  if (check.name === 'LEDGER') return { ...check, consequence: ledgerConsequence(check.observed) };
  const marker = guardMarkerFor(check, source);
  const consequence = (marker ? DETAIL_GUARD_CONSEQUENCES[marker] : undefined)
    ?? DETAIL_CHECK_CONSEQUENCES[check.name];
  return consequence === undefined ? check : { ...check, consequence };
}

/**
 * The consequence line for a ledger row (owner ruling: every failing check
 * carries one — R61 finding 5 caught LEDGER exempting itself).
 *
 * A ledger reason is the connector's own prose, and when it names a marker
 * this page already translates — `credential_session_latched`,
 * `provider_rate_limit` — that translation is the honest specific line.
 * Matching is by exact token, never substring: `gmail_daily_api_request_guard`
 * contains `api_request_guard`, and a substring match would translate a budget
 * pause as a provider refusal. An unrecognized reason gets the one thing true
 * of every ledger failure.
 */
function ledgerConsequence(reason: string): string {
  for (const token of reason.split(/[^A-Za-z0-9_]+/)) {
    const consequence = DETAIL_GUARD_CONSEQUENCES[token];
    if (consequence !== undefined) return consequence;
  }
  return 'this lane is failing, so its work is not moving until the fault above clears';
}

/** The scheduler marker a check was built from, when it was built from one. */
function guardMarkerFor(check: DetailCheck, source: DashboardSourceCard): string | undefined {
  const schedule = source.schedule;
  if (check.name === 'CONSECUTIVE_FAILURES') {
    // A parked lane's failure count is history: the guard stopped it carrying
    // whatever kind it last recorded on the way in, and the pause is what holds
    // it now. Translating the stale kind here would print "reconnect the
    // credential" under a What-to-do block that just said nothing is waiting on
    // the reader — the same contradiction R61 finding 3 killed, mirrored. The
    // row still names the raw kind as its observed cause, so nothing is hidden.
    const degradedReason = schedule?.degraded_reason;
    if (degradedReason && OPERATOR_PAUSED_SCHEDULER_MARKERS.has(degradedReason)) return degradedReason;
    return schedule?.last_error_kind;
  }
  if (check.name === 'SCHEDULER') return schedule?.degraded_reason;
  return undefined;
}

/**
 * Checks, triaged (owner ruling, 2026-08-19): failing rows first, each with
 * what it means, and the passing rows collapsed into a secondary evidence list
 * underneath.
 *
 * The section still appears only when something actually failed — a calm page
 * shows no checks at all — so a page can never open with a green row under a
 * header that says Failing.
 */
function renderChecksTip(checks: readonly DetailCheck[]): string {
  const failing = checks.filter((check) => !check.ok);
  if (failing.length === 0) return '';
  const passing = checks.filter((check) => check.ok);
  return `
        <div class="dsect">Checks</div>
        <div class="tip">
          <div class="h">Why this needs attention</div>${failing.map(checkRow).join('')}
        </div>${renderChecksEvidence(passing)}`;
}

/** One check row: the mechanical line, and the consequence when one is mapped. */
function checkRow(check: DetailCheck): string {
  const mark = check.ok ? '<span class="ok">✓</span>' : '<span class="no">✗</span>';
  const expectation = check.expectation ? ` ${escapeHtml(check.expectation)}` : '';
  const cause = check.cause ? ` — ${escapeHtml(maskSecrets(check.cause))}` : '';
  const consequence = check.ok || check.consequence === undefined
    ? ''
    : `
            <div class="cq">${escapeHtml(maskSecrets(check.consequence))}</div>`;
  return `
            <div>${mark} [${escapeHtml(check.name)}] (${escapeHtml(maskSecrets(check.observed))})${expectation}${cause}</div>${consequence}`;
}

/** The passing checks, folded away. Nothing renders when none passed. */
function renderChecksEvidence(passing: readonly DetailCheck[]): string {
  if (passing.length === 0) return '';
  const heading = `evidence — ${dashboardCount(passing.length)} ${passing.length === 1 ? 'check' : 'checks'} passing`;
  return `
        <details class="evidence" data-poll-key="evidence">
          <summary>${escapeHtml(heading)}</summary>${passing.map(checkRow).join('')}
        </details>`;
}

/**
 * Scope: which of the owner's rules apply to this source, and what they left
 * behind.
 *
 * Rows name the rule and its disposition, never its prefix or folder name —
 * /dashboard.json promises no file paths and no file names, and the read-only
 * query token reaches it. Nor is there a per-rule item count: `items_present`
 * is the source's whole purge debt, not this rule's match count, so it is
 * stated once, as itself, under the rows. The default-policy row the mockup
 * drew ("Spam & Trash — invisible · default policy") is absent because no
 * default-policy exclusion model exists to read it from.
 */
function renderScope(
  scope: DashboardExcludedSource | undefined,
  editPath: string | undefined,
  options: DashboardDetailBodyOptions | undefined,
): string {
  if (!scope) return '';
  const unenforceable = new Set(scope.unenforceable_rule_ids ?? []);
  const rows = scope.entries.map((rule) =>
    scopeRow({ ruleId: rule.rule_id, facts: scopeRuleFacts(rule, unenforceable.has(rule.rule_id)) })
  );
  const debt = scopeDebtLines(scope);
  if (rows.length === 0 && debt.length === 0) return '';
  // "Rules" and not "folders": a media criterion is not a folder, and the row
  // above may be describing one.
  const legend = rows.length === 0
    ? ''
    : '\n        <div class="quiet">Invisible rules keep items out entirely; metadata-only rules index the'
      + ' title and never read the content.</div>';
  // The picker contains private folder names, so navigation first trades the
  // worker bearer for the same short-lived HttpOnly control session used by
  // the dashboard's write controls. The bearer never enters browser storage
  // or a URL.
  // A read-only reader cannot mint the session the picker needs, and the
  // token field lives on the setup page only, so the link goes there.
  const edit = editPath === undefined
    ? ''
    : `\n        <div class="tiernote">${actionButton(options?.readOnly === true
      ? {
        label: 'Edit what gets ingested →',
        kind: 'link',
        href: `${setupHref(options?.basePath)}#dashboard-controls`,
        hint: 'unlock controls in Setup',
      }
      : {
        label: 'Edit what gets ingested →',
        kind: 'control_link',
        href: editPath,
        hint: 'needs the worker token',
      })}</div>`;
  return `
        <div class="dsect">Scope</div>${legend}
        ${rows.join('\n        ')}${debt.map((line) => `\n        <div class="quiet after">${line}</div>`).join('')}${edit}`;
}

/** One rule's line: disposition, how many criteria, and whether it can bite. */
function scopeRuleFacts(rule: DashboardExcludedRule, unenforceable: boolean): string {
  const parts: string[] = [];
  // A rule from an older ledger carries no modes and no kinds; the row then
  // states its counts and stays silent about the disposition rather than
  // guessing one.
  const modes = (rule.modes ?? []).map((mode) => SCOPE_MODE_WORDS[mode] ?? mode);
  if (modes.length > 0) parts.push(modes.join(' · '));
  if (rule.prefixes > 0) parts.push(`${dashboardCount(rule.prefixes)} ${criterionNoun(rule)}`);
  // The ledger's own finding: a blanket rule this source's shape can match
  // nothing of. Saying so beats a row that looks enforced and is not.
  if (unenforceable) parts.push('nothing here for this source to enforce');
  return parts.length === 0 ? '' : `— ${parts.join(' · ')}`;
}

/**
 * "Folders" only when every criterion IS a folder. A media rule is not a
 * folder, and a row that called it one would misdescribe the owner's own
 * configuration back to them.
 */
function criterionNoun(rule: DashboardExcludedRule): string {
  if ((rule.kinds ?? []).includes('media')) return rule.prefixes === 1 ? 'rule criterion' : 'rule criteria';
  return rule.prefixes === 1 ? 'folder' : 'folders';
}

/**
 * The two debts, each said as what it is. Both read 0 once their maintenance
 * has run, and neither is rendered at 0: "nothing to purge" is the ordinary
 * state and does not need a line.
 */
function scopeDebtLines(scope: DashboardExcludedSource): string[] {
  const lines: string[] = [];
  if (scope.items_present > 0) {
    const unevaluable = scope.items_unevaluable > 0
      ? ` · ${escapeHtml(dashboardCount(scope.items_unevaluable))} with a path the gate cannot read, kept until you decide`
      : '';
    lines.push(`${escapeHtml(dashboardCount(scope.items_present))} items indexed before these rules are still`
      + ` stored under them — purge pending${unevaluable}`);
  }
  if (scope.items_metadata_only_content_present > 0) {
    lines.push(`${escapeHtml(dashboardCount(scope.items_metadata_only_content_present))} items still carry content`
      + ` a metadata-only rule says they should not — strip pending`);
  }
  return lines;
}

/**
 * Sensitivity: where this source's items actually landed.
 *
 * The mockup's "129,885 → Private (S3) · 493 → Secure (S4) · 2 refused as
 * secrets" is drawn from `tier_composition` instead, because no per-S-tier
 * count and no refusal counter exist anywhere upstream.
 *
 * The arrow lead line above the table is GONE (owner ruling, 2026-08-18): it
 * restated the table's own two columns in a formulation nobody reads twice, and
 * the table carries the split on its own. What the tiers mean is one link away.
 */
function renderSensitivity(source: DashboardSourceCard, basePath?: string): string {
  if (source.tier_composition.length === 0) return '';
  const rows = source.tier_composition.map((tier) => `
            <tr><td>${escapeHtml(tier.label)}</td><td>${escapeHtml(dashboardCount(tier.indexed_items))}</td><td>${escapeHtml(dashboardCount(tier.content_ready_items))}</td></tr>`).join('');
  return `
        <div class="dsect">Sensitivity</div>
        <table>
          <tr><th>Tier</th><th>Items</th><th>Answer-ready</th></tr>${rows}
        </table>
        <div class="tiernote"><a href="${escapeHtml(sensitivityHref(basePath))}">About tiers →</a></div>`;
}

function sensitivityHref(basePath?: string): string {
  const path = basePath ?? DEFAULT_BASE_PATH;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${SENSITIVITY_QUERY_PARAM}`;
}

/**
 * Needs review: the count and why, and nothing to click.
 *
 * The mockup's per-item rows ("Q2-invoice.pdf — attachment · extracted 1 of 6
 * pages") have no source this page may read: the only item-level list is
 * `unreadable_content`, which the dashboard route suppresses because it carries
 * names and paths. And there is no route that opens a review item, so there is
 * no Open button either.
 */
function renderNeedsReview(source: DashboardSourceCard): string {
  const review = dashboardNeedsReview(source);
  if (!review) return '';
  const heading = `
        <div class="dsect">Needs review — ${escapeHtml(dashboardCount(review.total))}</div>`;
  if (review.reasons.length === 0) return heading;
  // The summary line is the answer to "how is a user supposed to clear this
  // up?": almost all of it, they are not. It is printed before any chip so the
  // total above it can never be read as a to-do list again.
  const summary = `
        <div class="reviewsum">${escapeHtml(needsReviewSummary(review.automatic_total, review.operator_total))}</div>`;
  const groups = [
    needsReviewGroup(review.reasons, 'automatic', 'Olympus is handling these'),
    needsReviewGroup(review.reasons, 'needs_you', 'These need you'),
  ].filter((group) => group.length > 0).join('');
  return `${heading}${summary}${groups}`;
}

/** "3,670 are handled automatically · 243 need you." Both halves, always. */
function needsReviewSummary(automatic: number, operator: number): string {
  if (operator === 0) return `All of it is handled automatically — nothing here needs you.`;
  if (automatic === 0) return `${dashboardCount(operator)} of these need you.`;
  return `${dashboardCount(automatic)} handled automatically`
    + ` · ${dashboardCount(operator)} ${operator === 1 ? 'needs' : 'need'} you.`;
}

/**
 * One who-acts group, heading and chips, or empty when it holds nothing.
 *
 * The chip carries its own clause rather than relying on the group heading
 * alone, because the chips wrap and a reader who lands mid-row would otherwise
 * have to scroll back up to learn whether the number in front of them is work.
 */
function needsReviewGroup(
  reasons: readonly DashboardNeedsReviewReason[],
  who: DashboardNeedsReviewActor,
  heading: string,
): string {
  const group = reasons.filter((reason) => reason.who_acts === who);
  if (group.length === 0) return '';
  const chips = group
    .map((reason) => countChip({
      count: dashboardCount(reason.count),
      label: `${reason.label} — ${reason.actor_note}`,
    }))
    .join('');
  return `
        <div class="subsect">${escapeHtml(heading)}</div>
        <div class="chips">${chips}</div>`;
}

function renderFoot(source: DashboardSourceCard, now: Date): string {
  const parts: string[] = [];
  const lastSyncAt = source.last_sync_at ? Date.parse(source.last_sync_at) : Number.NaN;
  if (Number.isFinite(lastSyncAt)) {
    const relative = dashboardRelativeFromMs(now.getTime() - lastSyncAt);
    if (relative) parts.push(`last sync ${relative}`);
  }
  // The same sentence is the STUCK_ITEMS cause up in the tip whenever anything
  // is stuck, and one page should not say it twice.
  if (source.ingestion_health.stuck_count === 0) parts.push(source.ingestion_health.label);
  // What Olympus was never asked to read, as a footnote and nowhere else
  // (owner ruling, 2026-08-24). It used to sit beside the percentage, where it
  // read as a competing headline — a quarter-million files looking like a
  // quarter-million problems. It is not work, it is not a gap, and it is not
  // the number this page is about.
  const notRead = source.coverage.not_read_by_policy_items ?? 0;
  if (notRead > 0) parts.push(dashboardNotReadByPolicyPhrase(notRead));
  const vlmQueued = source.vlm_extraction_queued;
  if (typeof vlmQueued === 'number' && vlmQueued > 0) {
    parts.push(`${dashboardCount(vlmQueued)} vision extraction ${vlmQueued === 1 ? 'job' : 'jobs'} queued`);
  }
  // Credential handle ids are operator plumbing, not reader copy: they stay
  // off the calm page (they still travel in /dashboard.json).
  const line = parts.filter((part) => part.trim().length > 0).join(' · ');
  if (line.length === 0) return '';
  return `
        <div class="foot">${escapeHtml(maskSecrets(line))}</div>`;
}

/**
 * A credential failure names a worker lane, not a card, so it is matched to
 * this source by display name — the same candidate set vocabulary.ts uses for
 * the status word, so the tip and the header can never disagree about whether
 * this source has a degraded credential.
 */
function degradationsFor(
  source: DashboardSourceCard,
  degraded: readonly WorkerCredentialDegradation[],
): WorkerCredentialDegradation[] {
  if (degraded.length === 0) return [];
  const candidates = new Set([
    normalizeName(source.label),
    normalizeName(source.provider),
    normalizeName(source.source_id),
    normalizeName(source.source_id.split('.')[0] ?? ''),
  ]);
  candidates.delete('');
  return degraded.filter((entry) => candidates.has(normalizeName(entry.display_name)));
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Nothing on this page is supposed to carry a secret, so this is a backstop
 * rather than a formatter: token-shaped runs are replaced, and text that is
 * already masked passes through exactly as written.
 */
function maskSecrets(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/g, '[REDACTED]')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|ghu|ghr|xox[abpsr]|dash|tok|key|secret|token)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[REDACTED]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]');
}

function retryLabel(nextRetryAt: string | undefined, now: Date): string {
  if (!nextRetryAt) return '';
  const at = Date.parse(nextRetryAt);
  if (!Number.isFinite(at)) return '';
  const ahead = at - now.getTime();
  return ahead <= 0 ? 'retry due now' : `retry in ${dashboardDuration(ahead / 1000)}`;
}

/**
 * An elapsed time for a tile: seconds while it is under a minute, whole
 * minutes after that, so a KPI reads "41m" rather than "40m 48s".
 */
function sinceLabel(hours: number): string {
  const seconds = hours * 3600;
  return seconds < 60 ? dashboardDuration(seconds) : dashboardDuration(Math.round(seconds / 60) * 60);
}
