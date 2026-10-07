import { renderModelSetupBlocker } from '../model-setup.ts';
import { AGENT_CONNECT_CSS, MODEL_SETUP_CSS, SETUP_JOURNEY_CSS } from '../static-styles.ts';
import { renderDashboardAgentsSection } from '../agents.ts';
export { SETUP_JOURNEY_CSS };
/**
 * First run: what is connecting, what is available to connect, and the way to
 * build a connector for anything else.
 *
 * The page is a list of OPTIONS, not of deficits (owner ruling, 2026-08-18):
 * buttons say Connect or Set up, headings name states rather than demands, and
 * every blurb is a fact — where the key lives, what it costs, what the provider
 * will show — with no reassurance in it.
 *
 * A row only carries a button when a control route exists that the button can
 * actually complete. Connected rows expose the bounded local Disconnect
 * action; destructive indexed-data deletion remains CLI-only.
 */
import type {
  DashboardSetupInstructions,
  DashboardSourceAction,
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../../source-dashboard.ts';
import { dashboardGuidedSessionAgentPrompt } from '../../source-dashboard.ts';
import {
  DASHBOARD_LOCAL_COPY,
  DASHBOARD_MODELS_BLOCKED_REASON,
  dashboardConnectedSummary,
  dashboardIsConnectedSource,
  dashboardSetupLead,
  dashboardSetupMeta,
} from '../vocabulary.ts';
import {
  dashboardOAuthConnectSheet,
  connectorSheet,
  dashboardControlGate,
  dashboardGoogleProviderNote,
  dashboardNeedsSetupSheet,
  escapeHtml,
  pageShell,
  safeExternalHref,
  setupRow,
  type DashboardActionInput,
} from '../components.ts';
import type { DashboardPageOptions } from './home.ts';
import { renderOutsideHelpSection } from '../outside-help.ts';
import { DASHBOARD_NAV_CSS, renderDashboardNav } from '../nav.ts';
import { DASHBOARD_SOURCE_ROWS_CSS } from '../static-styles.ts';
import {
  dashboardModelsSection,
  dashboardNeedsSection,
  dashboardOtherNeeds,
  dashboardPrivacySection,
  dashboardRefusalNotice,
  dashboardSourceList,
  dashboardSourceStates,
  detailHref,
  type DashboardSourceRowState,
} from '../source-rows.ts';

const CONNECTOR_SHEET_ID = 'connector-sheet';

const CONNECTOR_SHEET_HEADING = 'Build a connector with your agent';
// The playbook the prompt names is a contributor guide: it is deliberately
// outside the published package, so an install alone cannot satisfy the
// prompt's own first clause. The sheet says that here rather than letting the
// agent go looking for a file the managed plugin root does not contain.
const CONNECTOR_SHEET_INTRO = 'Copy this prompt, replace the source name, and paste it into your coding '
  + 'agent. The connector playbook it names lives in an Olympus source checkout, not in the installed '
  + 'package — CONTRIBUTING.md says how to get one. A finished connector appears on this page like any '
  + 'built-in.';
const CONNECTOR_SHEET_COPY_LABEL = 'Copy prompt';
const CONNECTOR_ROW_LABEL = 'Something else';
const CONNECTOR_ROW_BLURB = 'Anything with an API or an export — build the connector with your agent';
const CONNECTOR_ROW_BUTTON_LABEL = 'Build a connector';

/** The prompt the owner pastes into their own coding tool, from the mockup. */
const CONNECTOR_PROMPT = [
  'I’m working in my Olympus checkout. I want to add a new source connector for <SOURCE>.',
  '',
  'Read docs/CREATE_CONNECTOR.md and follow it exactly. Start by asking me its Leg 0 '
  + 'identity questions, then build leg by leg — connector contract, corpus registry, store mount, '
  + 'scheduler tasks, request budget, tests, host enablement — using the Readwise and Drive '
  + 'connectors as reference stampings. The one rule: SourceConnector is the only per-source code; '
  + 'everything downstream is shared. Keep the required CI check green.',
].join('\n');



export function renderDashboardSetupPage(
  view: SourceDashboardViewModel,
  options?: DashboardPageOptions,
): string {
  const degraded = options?.degradedCredentials ?? view.degraded_credentials;
  const rowOptions = { ...options, ...(degraded ? { degradedCredentials: degraded } : {}) };
  const states = dashboardSourceStates(view, rowOptions);
  // The worker refuses every source connection until models are ready, so
  // every connect control on the page is greyed with the reason beside it, and
  // the blocker banner at the top names the one thing that clears it.
  const blocked = view.model_setup !== undefined && !view.model_setup.ready;
  const engaged = states.rows.filter(isEngaged);
  const available = states.rows.filter((row) => !isEngaged(row));
  const basePath = options?.basePath;
  const body = [
    renderDashboardNav('setup', {
      ...(basePath === undefined ? {} : { basePath }),
    }),
    options?.controlMode === 'native'
      ? (options.canWrite === false
        ? '<div class="attncard plain" data-write-capability-note>Read-only OpenClaw connection — reconnect with operator.write access to change sources.</div>'
        : '')
      : dashboardControlGate({ connected: options?.controlSessionCsrfToken !== undefined }),
    renderModelSetupBlocker(view.model_setup),
    dashboardNeedsSection(dashboardOtherNeeds(states, view, rowOptions, 'setup')),
    renderSetupSummary(view),
    `<div class="sect">${escapeHtml(DASHBOARD_LOCAL_COPY.sources)}</div>`,
    // Each fact once: a source that needs the owner is its own row, at the
    // top, with its one fix; there is no separate list of them.
    engaged.length === 0 ? '' : dashboardSourceList(engaged, view, rowOptions, true),
    // "Not connected" is said once, as this heading: the rows under it carry
    // no status word of their own.
    `<div class="sect sub">${escapeHtml(DASHBOARD_LOCAL_COPY.notConnected)}</div>`,
    `<div class="srows">${available.map((row) => renderSetupRow(row.source, view, blocked, basePath)).join('\n')}${connectorRow()}</div>`,
    connectorSheet({
      id: CONNECTOR_SHEET_ID,
      heading: CONNECTOR_SHEET_HEADING,
      intro: CONNECTOR_SHEET_INTRO,
      promptText: CONNECTOR_PROMPT,
      copyButtonLabel: CONNECTOR_SHEET_COPY_LABEL,
    }),
    dashboardPrivacySection(rowOptions),
    // The Mac-only Outside help row: never on the native surfaces, whose
    // readers cannot reach the card (design §A.9).
    options?.controlMode === 'native' ? '' : renderOutsideHelpSection(options?.outsideHelpSummary, basePath),
    dashboardModelsSection(states, view),
    ...(options?.agents
      ? [renderDashboardAgentsSection({ view: options.agents, now: new Date(view.generated_at) })]
      : []),
  ].filter((block) => block !== '').join('\n');
  return pageShell({
    title: 'Olympus',
    // The vocabulary's shared count — the same predicate home uses — so this
    // header can never disagree with home's over the same view.
    meta: dashboardSetupMeta(view, degraded ? { degradedCredentials: degraded } : {}),
    // "Olympus / Setup", like every page but home (owner note, 2026-09-02).
    crumb: 'Setup',
    ...(basePath === undefined ? {} : { basePath }),
    body,
    controller: { ...(options?.controlSessionCsrfToken === undefined ? {} : { csrfToken: options.controlSessionCsrfToken }) },
    poll: {
      unlocked: options?.controlSessionCsrfToken !== undefined,
      ...(options?.controlSessionCsrfToken === undefined ? {} : { controlSessionCsrfToken: options.controlSessionCsrfToken }),
    },
    styles: [DASHBOARD_NAV_CSS, SETUP_JOURNEY_CSS, MODEL_SETUP_CSS, AGENT_CONNECT_CSS, DASHBOARD_SOURCE_ROWS_CSS],
    ...(options?.format === undefined ? {} : { format: options.format }),
  });
}

/**
 * A source the owner has engaged: connected, connecting, holding data, or
 * refused by its provider. Everything else is an option under Not connected.
 */
function isEngaged(row: DashboardSourceRowState): boolean {
  return row.status !== 'Off' || row.connecting !== undefined || dashboardIsConnectedSource(row.source);
}

function renderSetupSummary(view: SourceDashboardViewModel): string {
  const ready = view.summary.answer_ready_sources;
  // A refused first attempt keeps a source on the page, but it is not
  // connected; only a live connection or data already read counts.
  const connected = view.sources.filter((source) => dashboardIsConnectedSource(source)
    && (source.connection.provider_refusal === undefined || source.coverage.indexed_items > 0)
    && source.connection.state !== 'awaiting_consent').length;
  // Two counts with two names, because they measure different things: a
  // connected source is syncing; a ready one can already be cited. "0 sources
  // ready" beside four Fresh cards read as a contradiction (owner note,
  // 2026-09-01). One plain line; the preset tile said nothing.
  if (connected === 0) return '';
  return `<p class="setupsummary" aria-label="Setup summary">${escapeHtml(dashboardConnectedSummary(connected, ready))}</p>`;
}

function renderSetupRow(
  source: DashboardSourceCard,
  view: SourceDashboardViewModel,
  blocked: boolean,
  basePath?: string,
): string {
  const action = source.connection.action;
  const gate = blocked ? { blockedReason: DASHBOARD_MODELS_BLOCKED_REASON } : {};
  if (action.kind === 'guided_session') {
    const sheetId = `agent-${source.source_id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
    const row = setupRow({
      label: source.label,
      href: detailHref(source, basePath),
      blurb: setupBlurb(source),
      action: { label: 'Ask your agent', kind: 'none', sheet: sheetId },
    });
    const sheet = connectorSheet({
      id: sheetId,
      heading: `Pair ${source.label} with your agent`,
      intro: 'Copy this prompt into your agent. It uses the supported Olympus pairing flow and does not require code or configuration editing.',
      promptText: dashboardGuidedSessionAgentPrompt(action.source),
      copyButtonLabel: 'Copy prompt',
    });
    return `${row}\n${sheet}`;
  }
  // A needs_setup source has a real path forward: the oauth start route
  // accepts the client id/secret its instructions describe, so the row's
  // button — "Set up", the verb for a flow with a step before the consent
  // screen — opens a sheet carrying the copyable agent prompt and that form.
  if (action.kind === 'needs_setup') {
    const { sheetId, sheet } = dashboardNeedsSetupSheet(source, action, providerNote(view, action));
    const link = keyLocationLink(action.instructions);
    const row = setupRow({
      label: source.label,
      href: detailHref(source, basePath),
      blurb: action.instructions.plain_intro,
      ...dashboardSetupLead(source.source_id, action.instructions.plain_intro),
      action: { label: action.label, kind: 'none', sheet: sheetId, ...gate },
      ...(link === undefined ? {} : { blurbLink: link }),
    });
    return `${row}\n${sheet}`;
  }
  // An oauth row whose key is on file still has one thing to show before the
  // consent screen: the redirect URI the provider has to accept. It opens the
  // same sheet, so a first Connect from this page can no longer be refused for
  // a URI the owner was never shown (owner, 2026-09-03).
  if (action.kind === 'oauth') {
    const connect = dashboardOAuthConnectSheet(source, action, {
      ...dashboardRefusalNotice(source),
      ...providerNote(view, action),
    });
    if (connect) {
      const row = setupRow({
        label: source.label,
        href: detailHref(source, basePath),
        blurb: setupBlurb(source),
        action: { label: action.label, kind: 'none', sheet: connect.sheetId, ...gate },
      });
      return `${row}\n${connect.sheet}`;
    }
  }
  // An api_key row asks for a secret the reader has to go and fetch, so its
  // blurb is the instructions' own plain intro plus the page that issues the
  // key. An oauth row asks for nothing beforehand and says nothing.
  const link = action.kind === 'api_key' ? keyLocationLink(action.instructions) : undefined;
  return setupRow({
    label: source.label,
    href: detailHref(source, basePath),
    blurb: setupBlurb(source),
    ...(action.kind === 'api_key' ? dashboardSetupLead(source.source_id, action.instructions.plain_intro) : {}),
    action: { ...(connectAction(source, false) ?? { label: actionStateLabel(source), kind: 'none' as const }), ...gate },
    ...(link === undefined ? {} : { blurbLink: link }),
  });
}

/** The Google verification note for a Google sheet, spread-ready; empty otherwise. */
function providerNote(
  view: SourceDashboardViewModel,
  action: Extract<DashboardSourceAction, { kind: 'oauth' | 'needs_setup' }>,
): { providerNote?: string } {
  const note = dashboardGoogleProviderNote(view, action);
  return note === undefined ? {} : { providerNote: note };
}

/**
 * Where the key or app key this row asks for actually lives.
 *
 * `provider_console_url` is the instructions' own field — the same URL the DIY
 * steps link to — so the row cannot point somewhere the setup flow does not.
 * The label is the URL's host and path, not marketing text: the reader can see
 * where the click goes before they take it. Rendering is externalLink's job,
 * which parses the URL and refuses anything that is not https.
 */
function keyLocationLink(
  instructions: DashboardSetupInstructions,
): { label: string; url: string } | undefined {
  const url = safeExternalHref(instructions.provider_console_url);
  if (url === undefined) return undefined;
  const parsed = new URL(url);
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  return { label: `${parsed.host}${path} →`, url };
}

/** What the missing button would have said, for a row that renders none. */
function actionStateLabel(source: DashboardSourceCard): string {
  const action = source.connection.action;
  return action.kind === 'none' ? source.connection.label : action.label;
}

function setupBlurb(source: DashboardSourceCard): string {
  const action = source.connection.action;
  // No description field exists on a source card, so an oauth row that can act
  // in one click says only its name. A row that needs something of the reader
  // first says what, in the words the model carries: a guided session says what
  // pairing involves, an api_key row says which token and where it comes from.
  if (action.kind === 'guided_session') return action.instructions[0] ?? source.connection.label;
  if (action.kind === 'api_key') return action.instructions.plain_intro;
  return '';
}

/**
 * The button, or nothing. `oauth` and `api_key` are the two kinds with a
 * control route behind them (/dashboard/connect/oauth/start and
 * /dashboard/connect/api-key).
 */
function connectAction(source: DashboardSourceCard, primary: boolean): DashboardActionInput | undefined {
  const action = source.connection.action;
  if (action.kind === 'oauth') return { label: action.label, kind: 'oauth', source: action.source, primary };
  if (action.kind === 'api_key') return { label: action.label, kind: 'api_key', source: action.source, primary };
  return undefined;
}

/** The last row: no source behind it, so its button opens the sheet instead. */
function connectorRow(): string {
  return setupRow({
    label: CONNECTOR_ROW_LABEL,
    blurb: CONNECTOR_ROW_BLURB,
    action: { label: CONNECTOR_ROW_BUTTON_LABEL, kind: 'none', sheet: CONNECTOR_SHEET_ID },
  });
}
