/**
 * Home: every CONNECTED source as one card, grouped by status word, attention
 * first.
 *
 * A source the owner never connected is not on this page at all (owner ruling,
 * 2026-08-18) — it is an option, and options live on the setup page, which the
 * foot link always leads to. A section exists only while it has members, so the
 * steady state is a short page of quiet cards and nothing else. Every word and
 * number on it comes from vocabulary.ts, which reads only fields the worker
 * actually produces.
 */
import type { DashboardSourceCard, SourceDashboardViewModel } from '../../source-dashboard.ts';
import {
  dashboardAttentionLine,
  dashboardConnectedStatusGroups,
  dashboardHomeMeta,
  dashboardSubLine,
  dashboardWorkFraction,
  type DashboardStatus,
  type DashboardStatusGroup,
  type DashboardVocabularyOptions,
} from '../vocabulary.ts';
import {
  DASHBOARD_CONTROL_GATE_ID,
  DASHBOARD_LANE_CSS,
  attentionRow,
  backgroundRow,
  clipboardScript,
  controlScript,
  dashboardNeedsSetupSheet,
  dashboardOAuthConnectSheet,
  escapeHtml,
  pageShell,
  sourceCard,
  type DashboardActionInput,
} from '../components.ts';
import { dashboardBackgroundLanes, dashboardBackgroundRowLines } from './background.ts';
import type { EmbeddingRuntimeFacts } from '../embedding-runtime.ts';
import { DASHBOARD_NAV_CSS, renderDashboardNav } from '../nav.ts';

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
}

/** Statuses that read as a row with a reason and a control, not as a card. */
const ATTENTION_STATUSES: readonly DashboardStatus[] = ['Needs you', 'Failing'];

const DEFAULT_BASE_PATH = '/dashboard';

/**
 * Duplicates DASHBOARD_DETAIL_QUERY_PARAM rather than importing it: index.ts
 * imports this module, so reading the constant back from there would close an
 * import cycle for one string.
 */
const DETAIL_QUERY_PARAM = 'source';

/** Duplicated for the same reason as DETAIL_QUERY_PARAM: index.ts imports here. */
const BACKGROUND_QUERY_PARAM = 'background';

/** Duplicated for the same reason as DETAIL_QUERY_PARAM: index.ts imports here. */
const SETUP_QUERY_PARAM = 'setup';

export function renderDashboardHomePage(
  view: SourceDashboardViewModel,
  options?: DashboardPageOptions,
): string {
  const groups = dashboardConnectedStatusGroups(view, options);
  // Rendered before the card sections so the last card grid knows whether a
  // section follows it and keeps its bottom margin when one does.
  const background = renderBackgroundSection(view, options);
  const blocks = groups.map((group, index) =>
    renderSection(group, options, background === '' && index === groups.length - 1)
  );
  blocks.push(background);
  blocks.push(renderSetupLink(options));
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
    styles: [DASHBOARD_LANE_CSS, DASHBOARD_NAV_CSS],
    scripts: [
      controlScript({ csrfToken: options?.controlSessionCsrfToken }),
      clipboardScript(),
    ],
    poll: {
      unlocked: options?.controlSessionCsrfToken !== undefined,
      ...(options?.controlSessionCsrfToken === undefined ? {} : { controlSessionCsrfToken: options.controlSessionCsrfToken }),
    },
  });
}

/**
 * The one path from home to the setup page, and it is always here.
 *
 * Not conditional on an unconnected source existing any more: never-connected
 * sources left this page entirely, so a reader with everything connected would
 * otherwise have no way back to the page where a new connector is built. It is
 * the only navigation home offers besides the cards themselves.
 */
function renderSetupLink(options: DashboardPageOptions | undefined): string {
  return `<div class="foot"><a href="${escapeHtml(setupHref(options?.basePath))}">Connect more sources →</a></div>`;
}

function setupHref(basePath?: string): string {
  const path = basePath ?? DEFAULT_BASE_PATH;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${SETUP_QUERY_PARAM}`;
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
): string {
  const lanes = dashboardBackgroundLanes(view, options);
  if (lanes.length === 0) return '';
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

function renderSection(
  group: DashboardStatusGroup,
  options: DashboardPageOptions | undefined,
  last: boolean,
): string {
  return ATTENTION_STATUSES.includes(group.status)
    ? renderAttentionSection(group, options)
    : renderCardSection(group, options, last);
}

function renderAttentionSection(
  group: DashboardStatusGroup,
  options: DashboardPageOptions | undefined,
): string {
  const rows = group.sources.map((source) => {
    const resolved = attentionAction(source, options);
    const row = attentionRow({
      label: source.label,
      why: dashboardAttentionLine(source, options),
      // Every warning leads somewhere: the row with a control keeps it and
      // links its name to detail; the row without one becomes the link.
      href: detailHref(source, options?.basePath),
      attention: true,
      ...(resolved === undefined ? {} : { action: resolved.action }),
    });
    // The act happens HERE (owner ruling, 2026-09-01): a setup sheet opens
    // under its own row rather than sending the reader to another page to
    // press the same button again.
    return resolved?.sheet === undefined ? row : `${row}\n${resolved.sheet}`;
  });
  return [sectionHeading(group, true), ...rows].join('\n');
}

function renderCardSection(
  group: DashboardStatusGroup,
  options: DashboardPageOptions | undefined,
  last: boolean,
): string {
  const cards = group.sources.map((source) => {
    // Only Working spends a fraction, and an absent one has to stay absent
    // rather than arrive as undefined: the glyph reads "no ratio claimed" and
    // draws the plain ring.
    const fraction = group.status === 'Working' ? dashboardWorkFraction(source) : undefined;
    return sourceCard({
      label: source.label,
      status: group.status,
      subLine: dashboardSubLine(source, options),
      href: detailHref(source, options?.basePath),
      ...(fraction === undefined ? {} : { fraction }),
    });
  });
  return [
    sectionHeading(group, false),
    `<div class="cards"${gridStyle(group.sources.length, last)}>`,
    ...cards,
    '</div>',
  ].join('\n');
}

function sectionHeading(group: DashboardStatusGroup, attention: boolean): string {
  const text = escapeHtml(`${group.status} — ${group.sources.length}`);
  return attention
    ? `<div class="sect attn">▲ ${text}</div>`
    : `<div class="sect">${text}</div>`;
}

/**
 * Four abreast once a section fills a row, so the fourth card does not sit
 * alone on a second line; three otherwise, which is the .cards default.
 */
function gridStyle(count: number, last: boolean): string {
  const rules: string[] = [];
  if (count >= 4) {
    rules.push('grid-template-columns:repeat(4,1fr)');
  }
  if (!last) {
    rules.push('margin-bottom:22px');
  }
  return rules.length === 0 ? '' : ` style="${escapeHtml(rules.join('; '))}"`;
}

/** A source's detail page. Exported so the setup page links by the same rule. */
export function detailHref(source: DashboardSourceCard, basePath?: string): string {
  const path = basePath ?? DEFAULT_BASE_PATH;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${DETAIL_QUERY_PARAM}=${encodeURIComponent(source.source_id)}`;
}

/**
 * The real control for a warning row, or undefined when the row's way forward
 * is the detail page the whole row already links to.
 *
 * Two honest shapes and no third. A reader holding the worker bearer token gets
 * the control itself, posting to the same /dashboard/connect/oauth/start and
 * /dashboard/connect/api-key routes the setup page uses. A reader who arrived
 * with the read-only dash_ URL token cannot call those routes at all, so they
 * get a link to the setup page with the token requirement stated — the button
 * they would otherwise press could only ever fail on them. A guided_session
 * source has no route on either path, so it carries no control and the row
 * leads to its detail page instead of to a dead button.
 */
function attentionAction(
  source: DashboardSourceCard,
  options: DashboardPageOptions | undefined,
): { action: DashboardActionInput; sheet?: string } | undefined {
  const action = source.connection.action;
  // A data-bearing source is only on this page because its connection broke,
  // so its verb is the repair verb whatever the registry now calls it: a
  // "Connect" on a source holding 4,000 files reads as a demand to set up
  // something the owner already set up (owner note, 2026-09-01).
  const reconnecting = source.coverage.indexed_items > 0;
  // A source whose app key was never registered has a real path forward, and
  // it opens right here: the same sheet the setup page offers — copyable
  // prompt plus the client-key form the oauth start route accepts — under
  // this row. This is the state an expired X or Google credential lands in
  // when the operator's client id is missing, so the row must not dead-end.
  if (action.kind === 'needs_setup') {
    if (options?.controlSessionCsrfToken === undefined) {
      return { action: lockedAction(reconnecting ? 'Reauthenticate' : action.label, options?.basePath) };
    }
    const { sheetId, sheet } = dashboardNeedsSetupSheet(source, action);
    return {
      action: { label: reconnecting ? 'Reauthenticate' : action.label, kind: 'none', sheet: sheetId, primary: true },
      sheet,
    };
  }
  if (action.kind !== 'oauth' && action.kind !== 'api_key') return undefined;
  const label = reconnecting && action.label === 'Connect' ? 'Reauthenticate' : action.label;
  if (options?.controlSessionCsrfToken === undefined) {
    return { action: lockedAction(label, options?.basePath) };
  }
  // An oauth source whose key is on file opens the same sheet the setup page
  // shows: the redirect URI its provider must accept, its client id prefilled
  // and editable, and Cancel while an attempt is pending. Pressing the bare
  // button used to start the identical attempt the provider had just refused
  // (owner, 2026-09-03).
  if (action.kind === 'oauth') {
    const connect = dashboardOAuthConnectSheet(source, action, {
      ...(source.connection.provider_refusal ? { notice: source.connection.provider_refusal.reason } : {}),
    });
    if (connect) {
      return {
        action: { label, kind: 'none', sheet: connect.sheetId, primary: true },
        sheet: connect.sheet,
      };
    }
  }
  return { action: { label, kind: action.kind, source: action.source, primary: true } };
}

/**
 * The control a locked reader sees: the same verb, pointing at the setup
 * page's gate where the token goes, with the one-line reason. Never a button
 * that can only fail.
 */
function lockedAction(label: string, basePath: string | undefined): DashboardActionInput {
  return { label, kind: 'link', href: `${setupHref(basePath)}#${DASHBOARD_CONTROL_GATE_ID}`, hint: 'unlock controls in Setup' };
}
