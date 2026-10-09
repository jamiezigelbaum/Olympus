/**
 * The computer's own pages (unified dashboard phase 4, 2026-10-09): what
 * cannot work through ChatGPT, each opened from the panel's "On this
 * computer" section and still rendered here on the server.
 *
 * - Keys (`?keys`): the model keys and the setup sheets for the sources that
 *   connect on the computer (X bookmarks, Readwise, Telegram, WhatsApp, and
 *   any source whose own app registration is needed). The panel's Connect
 *   and Change models open this page at the right sheet.
 * - Agents (`?agents`): remote access and connected agents.
 * - Build a connector (`?connector`): the prompt for a coding agent.
 *
 * Outside help keeps its own page (outside-help.ts). Each page holds the
 * "Open dashboard controls" gate while the controls are locked, so a page
 * opened on its own still says what to do.
 *
 * Every row only carries a button when a control route exists that the
 * button can complete (owner ruling, 2026-08-18): buttons say Connect or Set
 * up, and every blurb is a fact — where the key lives, what it costs, what
 * the provider will show.
 */
import type { DashboardAgentsView } from '../../agent-connections.ts';
import type { WorkerCredentialDegradation } from '../../credential-degradation.ts';
import type {
  DashboardSetupInstructions,
  DashboardSourceAction,
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../../source-dashboard.ts';
import { dashboardGuidedSessionAgentPrompt } from '../../source-dashboard.ts';
import { renderDashboardAgentsSection } from '../agents.ts';
import {
  connectorSheet,
  dashboardControlGate,
  dashboardGoogleProviderNote,
  dashboardNeedsSetupSheet,
  dashboardOAuthConnectSheet,
  escapeHtml,
  pageShell,
  safeExternalHref,
  setupRow,
  type DashboardActionInput,
} from '../components.ts';
import { renderModelSetup, renderModelSetupBlocker } from '../model-setup.ts';
import type { DashboardOutsideHelpStatus } from '../outside-help.ts';
import { AGENT_CONNECT_CSS, LOCAL_PAGE_CSS, MODEL_SETUP_CSS } from '../static-styles.ts';
import {
  DASHBOARD_COMPUTER_PANEL_COPY,
  DASHBOARD_MODELS_BLOCKED_REASON,
  dashboardCheckedLabel,
  dashboardProviderRefusalDetail,
  dashboardProviderRefusalSentence,
  dashboardSetupLead,
} from '../vocabulary.ts';

export interface DashboardPageOptions {
  now?: Date;
  degradedCredentials?: readonly WorkerCredentialDegradation[];
  /** Where the page's "Olympus" lead links back to: /dashboard, with a dash_ reader's token. */
  basePath?: string;
  /** Server-injected token for an already-minted HttpOnly control session. */
  controlSessionCsrfToken?: string;
  /** Remote agent connections and remote access, for Agents. */
  agents?: DashboardAgentsView;
  /** The Outside help card's facts, for that page only, with the control session. */
  outsideHelp?: DashboardOutsideHelpStatus;
  /** True when the live control session was minted locally (the only grade the consult routes take). */
  outsideHelpLocalSession?: boolean;
}

const CONNECTOR_SHEET_ID = 'connector-sheet';
const CONNECTOR_SHEET_HEADING = 'Build a connector with your agent';
// The playbook the prompt names is a contributor guide: it is deliberately
// outside the published package, so an install alone cannot satisfy the
// prompt's own first clause. The sheet says that here rather than letting the
// agent go looking for a file the managed plugin root does not contain.
const CONNECTOR_SHEET_INTRO = 'Copy this prompt, replace the source name, and paste it into your coding '
  + 'agent. The connector playbook it names lives in an Olympus source checkout, not in the installed '
  + 'package — CONTRIBUTING.md says how to get one. A finished connector appears in Olympus like any '
  + 'built-in.';

/** The prompt the owner pastes into their own coding tool. */
export const CONNECTOR_PROMPT = [
  'I’m working in my Olympus checkout. I want to add a new source connector for <SOURCE>.',
  '',
  'Read docs/CREATE_CONNECTOR.md and follow it exactly. Start by asking me its Leg 0 '
  + 'identity questions, then build leg by leg — connector contract, corpus registry, store mount, '
  + 'scheduler tasks, request budget, tests, host enablement — using the Readwise and Drive '
  + 'connectors as reference stampings. The one rule: SourceConnector is the only per-source code; '
  + 'everything downstream is shared. Keep the required CI check green.',
].join('\n');

const W = DASHBOARD_COMPUTER_PANEL_COPY.rows;

function unlocked(options: DashboardPageOptions | undefined): boolean {
  return options?.controlSessionCsrfToken !== undefined;
}

/** The shell every local page shares: "Olympus / <Page>", the lead back to the dashboard, the shared controller. */
function localShell(input: {
  crumb: string;
  meta: string;
  body: string;
  styles: readonly string[];
  options: DashboardPageOptions | undefined;
}): string {
  const csrf = input.options?.controlSessionCsrfToken;
  return pageShell({
    title: 'Olympus',
    crumb: input.crumb,
    ...(input.options?.basePath === undefined ? {} : { basePath: input.options.basePath }),
    meta: input.meta,
    body: input.body,
    controller: { ...(csrf === undefined ? {} : { csrfToken: csrf }) },
    poll: {
      unlocked: csrf !== undefined,
      ...(csrf === undefined ? {} : { controlSessionCsrfToken: csrf }),
    },
    styles: [LOCAL_PAGE_CSS, ...input.styles],
  });
}

/** Keys: the model keys, then the sources that connect on this computer. */
export function renderDashboardKeysPage(view: SourceDashboardViewModel, options?: DashboardPageOptions): string {
  const blocked = view.model_setup !== undefined && !view.model_setup.ready;
  const sources = view.sources.filter((source) => source.connection.action.kind !== 'none');
  const body = [
    dashboardControlGate({ connected: unlocked(options) }),
    renderModelSetupBlocker(view.model_setup),
    renderModelSetup(view.model_setup),
    sources.length === 0 ? '' : '<div class="sect" id="sources">Sources</div>',
    sources.length === 0
      ? ''
      : `<div class="srows">${sources.map((source) => renderSetupRow(source, view, blocked)).join('\n')}</div>`,
  ].filter((block) => block !== '').join('\n');
  return localShell({
    crumb: W.keys.title,
    meta: dashboardCheckedLabel(view.generated_at, options?.now ?? new Date()),
    body,
    styles: [MODEL_SETUP_CSS],
    options,
  });
}

/** Agents: remote access and the agents connected to Olympus. */
export function renderDashboardAgentsPage(options?: DashboardPageOptions): string {
  const now = options?.now ?? new Date();
  const body = [
    dashboardControlGate({ connected: unlocked(options) }),
    options?.agents
      ? renderDashboardAgentsSection({ view: options.agents, now })
      : '<p class="foot">Agent connections are not available on this install.</p>',
  ].join('\n');
  return localShell({ crumb: W.agents.title, meta: '', body, styles: [AGENT_CONNECT_CSS], options });
}

/** Build a connector: the prompt, open. Nothing on it calls a control route. */
export function renderDashboardConnectorPage(options?: DashboardPageOptions): string {
  const body = [
    `<div class="sect">${escapeHtml(CONNECTOR_SHEET_HEADING)}</div>`,
    connectorSheet({
      id: CONNECTOR_SHEET_ID,
      heading: W.connector.line,
      intro: CONNECTOR_SHEET_INTRO,
      promptText: CONNECTOR_PROMPT,
      copyButtonLabel: 'Copy prompt',
    }).replace('class="sheet"', 'class="sheet on"').replace('aria-hidden="true"', 'aria-hidden="false"'),
  ].join('\n');
  return localShell({ crumb: W.connector.title, meta: '', body, styles: [], options });
}

/**
 * A provider refusal for a connect sheet: the translated sentence on top, the
 * provider's own words under How to fix. Empty when nothing was refused.
 */
function refusalNotice(source: DashboardSourceCard): { notice?: string; noticeDetail?: string } {
  if (!source.connection.provider_refusal) return {};
  const detail = dashboardProviderRefusalDetail(source);
  return {
    notice: dashboardProviderRefusalSentence(source),
    ...(detail === undefined ? {} : { noticeDetail: detail }),
  };
}

function renderSetupRow(source: DashboardSourceCard, view: SourceDashboardViewModel, blocked: boolean): string {
  const action = source.connection.action;
  const gate = blocked ? { blockedReason: DASHBOARD_MODELS_BLOCKED_REASON } : {};
  const id = { sourceId: source.source_id };
  if (action.kind === 'guided_session') {
    const sheetId = `agent-${source.source_id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
    const row = setupRow({
      ...id,
      label: source.label,
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
      ...id,
      label: source.label,
      blurb: action.instructions.plain_intro,
      ...dashboardSetupLead(source.source_id, action.instructions.plain_intro),
      action: { label: action.label, kind: 'none', sheet: sheetId, ...gate },
      ...(link === undefined ? {} : { blurbLink: link }),
    });
    return `${row}\n${sheet}`;
  }
  // An oauth row whose key is on file still has one thing to show before the
  // consent screen: the redirect URI the provider has to accept.
  if (action.kind === 'oauth') {
    const connect = dashboardOAuthConnectSheet(source, action, { ...refusalNotice(source), ...providerNote(view, action) });
    if (connect) {
      const row = setupRow({
        ...id,
        label: source.label,
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
    ...id,
    label: source.label,
    blurb: setupBlurb(source),
    ...(action.kind === 'api_key' ? dashboardSetupLead(source.source_id, action.instructions.plain_intro) : {}),
    action: { ...(connectAction(source) ?? { label: actionStateLabel(source), kind: 'none' as const }), ...gate },
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
 * Where the key or app key this row asks for actually lives: the
 * instructions' own `provider_console_url`, labelled by its host and path so
 * the reader sees where the click goes before they take it.
 */
function keyLocationLink(instructions: DashboardSetupInstructions): { label: string; url: string } | undefined {
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
  if (action.kind === 'guided_session') return action.instructions[0] ?? source.connection.label;
  if (action.kind === 'api_key') return action.instructions.plain_intro;
  return '';
}

/** `oauth` and `api_key` are the two kinds with a control route behind a plain button. */
function connectAction(source: DashboardSourceCard): DashboardActionInput | undefined {
  const action = source.connection.action;
  if (action.kind === 'oauth') return { label: action.label, kind: 'oauth', source: action.source, primary: false };
  if (action.kind === 'api_key') return { label: action.label, kind: 'api_key', source: action.source, primary: false };
  return undefined;
}
