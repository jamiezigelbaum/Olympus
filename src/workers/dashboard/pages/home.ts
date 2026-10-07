/**
 * Home: every CONNECTED source as one row, the ones that need the owner first.
 *
 * A source the owner never connected is not on this page at all (owner ruling,
 * 2026-08-18) — it is an option, and options live on the setup page, which the
 * foot link always leads to. Each fact appears once (owner rule, 2026-10-02):
 * a source that needs the owner is its own row, at the top, with its one fix;
 * Needs you holds only what is not a source (a model download that failed,
 * privacy not set up yet). The rows, their words and their colours are
 * source-rows.ts, shared with Setup.
 */
import type { DashboardAgentsView } from '../../agent-connections.ts';
import type { SourceDashboardViewModel } from '../../source-dashboard.ts';
import {
  DASHBOARD_INDEXING_NAME,
  DASHBOARD_LOCAL_COPY,
  dashboardHomeMeta,
  dashboardIsConnectedSource,
  type DashboardVocabularyOptions,
} from '../vocabulary.ts';
import {
  DASHBOARD_LANE_CSS,
  backgroundRow,
  escapeHtml,
  pageShell,
} from '../components.ts';
import { dashboardBackgroundLanes, dashboardBackgroundRowLines } from './background.ts';
import type { EmbeddingRuntimeFacts } from '../embedding-runtime.ts';
import { DASHBOARD_NAV_CSS, renderDashboardNav } from '../nav.ts';
import { DASHBOARD_SOURCE_ROWS_CSS } from '../static-styles.ts';
import {
  dashboardNeedsSection,
  dashboardOtherNeeds,
  dashboardProgressSection,
  dashboardSourceList,
  dashboardSourceStates,
  setupHref,
  type DashboardModelInstalls,
  type DashboardPrivacySummary,
} from '../source-rows.ts';
import type { PrivacySettings } from '../../chatgpt/dashboard-contract.ts';
import type { DashboardOutsideHelpStatus, DashboardOutsideHelpSummary } from '../outside-help.ts';

export {
  dashboardRefusalNotice,
  detailHref,
  fallbackFix,
} from '../source-rows.ts';

export interface DashboardPageOptions extends DashboardVocabularyOptions {
  /** Path prefix the page's own links are built from. Defaults to /dashboard. */
  basePath?: string;
  /**
   * True when this reader arrived with the read-only dash_ query token.
   *
   * The control routes take the worker bearer token and nothing weaker, so a
   * read-only reader gets a link to the setup page where the control lives,
   * with the token requirement stated — never a button that can only fail.
   * index.ts sets it from the URL; absent means "not known to be read-only",
   * which is the operator holding the bearer token.
   */
  readOnly?: boolean;
  /** Server-injected token for an already-minted HttpOnly control session. */
  controlSessionCsrfToken?: string;
  /**
   * What the embedding lane is doing, read off the guard's and the drain's own
   * files by the worker before the render.
   *
   * Passed in rather than read here because every read behind it touches the
   * filesystem or the router, and these renderers are synchronous and pure by
   * design. Absent means the worker did not supply it — the Background page
   * then states nothing about the lane's run state, which is the correct
   * silence rather than a guess.
   */
  embeddingRuntime?: EmbeddingRuntimeFacts;
  /** Native Control UI asks for inert body markup instead of a document. */
  format?: 'document' | 'fragment';
  /** Native mode inherits Gateway authority and never shows the worker-token gate. */
  controlMode?: 'standalone' | 'native';
  /** Presentation only; the Gateway still enforces operator.write server-side. */
  canWrite?: boolean;
  /** Native OAuth needs a trusted Gateway public origin for its callback. */
  nativeOAuthAvailable?: boolean;
  /** Remote agent connections and remote access, for Setup's Agents section. */
  agents?: DashboardAgentsView;
  /** The built-in models' installs, for the Models row and its install lines. */
  modelInstalls?: DashboardModelInstalls;
  /**
   * The owner's privacy settings, counts only, for Setup's Privacy row and
   * Home's one ask to set it up. 'unreadable' when the profile cannot be read.
   */
  privacy?: DashboardPrivacySummary | 'unreadable';
  /**
   * The full privacy settings, for the Privacy editor only: the owner's
   * description and the always-private rules with their names (Secrets-tier
   * locations already left out by the engine).
   */
  privacySettings?: PrivacySettings;
  /**
   * The Outside help card's facts (outside-help.ts), for that page only, and
   * only for a standalone reader with the control session: the worker reads
   * them (a daemon version call and two port probes) for no other render.
   */
  outsideHelp?: DashboardOutsideHelpStatus;
  /** One word for Setup's Outside help row; absent, the row is not shown. */
  outsideHelpSummary?: DashboardOutsideHelpSummary;
  /** Private builds retain the append-only embedding decision ledger. */
}

const DEFAULT_BASE_PATH = '/dashboard';

/** Duplicated rather than imported: index.ts imports this module. */
const BACKGROUND_QUERY_PARAM = 'background';

export function renderDashboardHomePage(
  view: SourceDashboardViewModel,
  options?: DashboardPageOptions,
): string {
  const states = dashboardSourceStates(view, options);
  const connected = states.rows.filter((row) => dashboardIsConnectedSource(row.source));
  const sources = connected.length === 0
    ? `<p class="foot">${escapeHtml(DASHBOARD_LOCAL_COPY.noSources)}</p>`
    : dashboardSourceList(connected, view, options, false);
  const progress = dashboardProgressSection({ ...states, rows: connected });
  const blocks = [
    dashboardNeedsSection(dashboardOtherNeeds(states, view, options, 'home')),
    `<div class="sect">${escapeHtml(DASHBOARD_LOCAL_COPY.sources)}</div>`,
    sources,
    progress,
    // Each fact once: while the page-wide Progress line shows, the Background
    // card does not repeat an indexing number of its own beside it.
    renderBackgroundSection(view, options, progress !== ''),
    renderSetupLink(options),
  ];
  const nav = renderDashboardNav('home', {
    ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
  });
  return pageShell({
    title: 'Olympus',
    meta: dashboardHomeMeta(view, options),
    // The token gate lives on the setup page only (owner ruling, 2026-09-01:
    // "Setup is the only place you need to think about the worker token").
    // A locked control here links there.
    body: [
      nav,
      ...blocks.filter((block) => block.length > 0),
    ].join('\n'),
    styles: [DASHBOARD_LANE_CSS, DASHBOARD_NAV_CSS, DASHBOARD_SOURCE_ROWS_CSS],
    controller: { ...(options?.controlSessionCsrfToken === undefined ? {} : { csrfToken: options.controlSessionCsrfToken }) },
    poll: {
      unlocked: options?.controlSessionCsrfToken !== undefined,
      ...(options?.controlSessionCsrfToken === undefined ? {} : { controlSessionCsrfToken: options.controlSessionCsrfToken }),
    },
    ...(options?.format === undefined ? {} : { format: options.format }),
  });
}

/**
 * The one path from home to the setup page, and it is always here.
 *
 * Not conditional on an unconnected source existing any more: never-connected
 * sources left this page entirely, so a reader with everything connected would
 * otherwise have no way back to the page where a new connector is built.
 */
function renderSetupLink(options: DashboardPageOptions | undefined): string {
  return `<div class="foot"><a href="${escapeHtml(setupHref(options?.basePath))}">Connect more sources →</a></div>`;
}

/**
 * One card, one line per lane, the whole card a link to the background page.
 *
 * The section heading is the same heading every other section on this page
 * gets, because background work is a section of the page and not a footnote to
 * it. Nothing renders at all when no lane reports.
 */
function renderBackgroundSection(
  view: SourceDashboardViewModel,
  options: DashboardPageOptions | undefined,
  progressShown = false,
): string {
  const lanes = dashboardBackgroundLanes(view, options)
    .filter((lane) => !progressShown || lane.name !== DASHBOARD_INDEXING_NAME);
  if (lanes.length === 0 || dashboardBackgroundRowLines(lanes).length === 0) return '';
  return [
    '<div class="sect">Background</div>',
    backgroundRow({
      href: backgroundHref(options?.basePath),
      label: 'Background work details',
      lines: dashboardBackgroundRowLines(lanes),
    }),
  ].join('\n');
}

function backgroundHref(basePath?: string): string {
  const path = basePath ?? DEFAULT_BASE_PATH;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${BACKGROUND_QUERY_PARAM}`;
}
