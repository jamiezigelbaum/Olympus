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
 * Anonymous model settings live here in Models (outside-help.ts). Each page holds the
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
import { renderMessagingCard } from '../messaging.ts';
import { DASHBOARD_OPEN_FRAGMENT_KEY, dashboardImportLandingToken } from '../../../core/open-targets.ts';
import { renderDashboardAgentsSection, type AgentConnectHost } from '../agents.ts';
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
  setupStepsSheet,
  type DashboardActionInput,
} from '../components.ts';
import { DASHBOARD_PRIVATE_ANSWERS_COPY } from '../vocabulary.ts';
import { DASHBOARD_OUTSIDE_HELP_CSS } from '../static-styles.ts';
import { renderModelSetup, renderModelSetupBlocker } from '../model-setup.ts';
import { renderOutsideHelpCard, type DashboardOutsideHelpStatus } from '../outside-help.ts';
import { AGENT_CONNECT_CSS, LOCAL_PAGE_CSS, MODEL_SETUP_CSS } from '../static-styles.ts';
import {
  DASHBOARD_COMPUTER_PANEL_COPY,
  DASHBOARD_EVERNOTE_CONSENT_HELP,
  DASHBOARD_MODELS_BLOCKED_REASON,
  dashboardCheckedLabel,
  dashboardProviderRefusalDetail,
  dashboardProviderRefusalSentence,
  dashboardSetupLead,
} from '../vocabulary.ts';

export interface DashboardPageOptions {
  now?: Date;
  /** Pairing credentials and chat choices require locally minted controls. */
  messagingLocalSession?: boolean;
  degradedCredentials?: readonly WorkerCredentialDegradation[];
  /** Where the page's "Olympus" lead links back to: /dashboard, with a dash_ reader's token. */
  basePath?: string;
  /** Server-injected token for an already-minted HttpOnly control session. */
  controlSessionCsrfToken?: string;
  /** Remote agent connections and remote access, for Agents. */
  agents?: DashboardAgentsView;
  /** OPENER supplies the current desktop/headless approval handoff. */
  agentConnectHost?: AgentConnectHost;
  /** The Outside help card's facts, for that page only, with the control session. */
  outsideHelp?: DashboardOutsideHelpStatus | undefined;
  /** True when the live control session was minted locally (the only grade the consult routes take). */
  outsideHelpLocalSession?: boolean;
  /**
   * The Private answers page's facts. `waiting` only for a local control
   * session; undefined when the record of waiting questions cannot be read.
   */
  privateAnswers?: {
    available: boolean;
    destinations?: import('../../email-source/venice-inbox-answer.ts').AskDestinationStates | undefined;
    waiting?: { questions: readonly DashboardWaitingQuestion[]; olderRemoved: boolean };
  };
}

/** One question waiting for this computer, as the Private answers page lists it. */
export interface DashboardWaitingQuestion {
  path?: 'private' | 'anonymous' | 'venice';
  id: string;
  question: string;
  /** Who asked: the connection's name. */
  from: string;
  askedAt: string;
  unchecked: boolean;
  state?: 'answering' | 'retrying' | 'answered' | 'unchecked' | 'queued' | 'changed' | 'failed';
  unread?: boolean;
  answeredAt?: string;
  failureReason?: string;
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
  const sources = view.sources.filter((source) => source.connection.action.kind !== 'none' || source.source_id === 'telegram.messages' || source.source_id === 'whatsapp.personal.messages');
  const body = [
    dashboardControlGate({ connected: unlocked(options) }),
    renderModelSetupBlocker(view.model_setup),
    `<div id="private-routing"><div${view.model_setup?.cards.some(card => card.id === 'venice') ? ' id="venice-setup"' : ''}>${renderModelSetup(view.model_setup)}</div></div>`,
    view.model_setup?.cards.some(card => card.id === 'venice') ? '' : `<section id="venice-setup"><h3 class="sect">${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.setUpVenice)}</h3><p class="pnote">${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.veniceSetupHelp)}</p><div class="modelaction"><form method="post" action="/dashboard/connect/api-key" data-connect-kind="api_key" data-model-provider="venice"><input type="hidden" name="source" value="venice"><input class="keyfield" type="password" name="api_key" required autocomplete="new-password" placeholder="${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.veniceKey)}" aria-label="${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.veniceKey)}"><button type="submit" class="btn primary">${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.connectVenice)}</button><span data-action-message role="status"></span></form></div></section>`,
    `<section id="anonymous"><h3 class="sect">${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.anonymousTitle)}</h3>${options?.outsideHelp ? renderOutsideHelpCard(options.outsideHelp, { ...(options.controlSessionCsrfToken !== undefined ? { csrfToken: options.controlSessionCsrfToken } : {}), localSession: options.outsideHelpLocalSession === true, untitled: true }) : `<p data-outside-unavailable>${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.anonymousNotSetUp)}</p>`}</section>`,
    sources.length === 0 ? '' : '<div class="sect" id="sources">Sources</div>',
    sources.length === 0
      ? ''
      : `<div class="srows">${sources.map((source) => renderSetupRow(source, view, blocked, options?.basePath ?? '/dashboard', options?.messagingLocalSession === true)).join('\n')}</div>`,
  ].filter((block) => block !== '').join('\n');
  return localShell({
    crumb: W.keys.title,
    meta: dashboardCheckedLabel(view.generated_at, options?.now ?? new Date()),
    body,
    styles: [MODEL_SETUP_CSS, DASHBOARD_OUTSIDE_HELP_CSS],
    options,
  });
}

/** Agents: remote access and the agents connected to Olympus. */
export function renderDashboardAgentsPage(options?: DashboardPageOptions): string {
  const now = options?.now ?? new Date();
  const body = [
    dashboardControlGate({ connected: unlocked(options) }),
    options?.agents
      ? renderDashboardAgentsSection({ ...options.agentConnectHost, view: options.agents, now })
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

function renderSetupRow(source: DashboardSourceCard, view: SourceDashboardViewModel, blocked: boolean, basePath: string, messagingLocalSession = false): string {
  const action = source.connection.action;
  if (source.source_id === 'telegram.messages' || source.source_id === 'whatsapp.personal.messages') {
    return renderMessagingCard(source.source_id === 'telegram.messages' ? 'telegram' : 'whatsapp', messagingLocalSession);
  }
  const gate = blocked ? { blockedReason: DASHBOARD_MODELS_BLOCKED_REASON } : {};
  const id = { sourceId: source.source_id };
  // Imports happen on the main page, from the source's card: the button goes there and opens its Import an archive.
  if (action.kind === 'archive_import') {
    return setupRow({
      ...id,
      label: source.label,
      blurb: setupBlurb(source),
      action: { label: action.label, kind: 'link', href: `${basePath}#${DASHBOARD_OPEN_FRAGMENT_KEY}=${dashboardImportLandingToken(source.source_id)}` },
    });
  }
  if (action.kind === 'guided_session' && (action.source === 'telegram' || action.source === 'whatsapp')) {
    return renderMessagingCard(action.source, messagingLocalSession);
  }
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
  if (action.kind === 'api_key' && action.source === 'venice') {
    const sheetId = 'setup-venice-api';
    const form = (formId: string) => `<form id="${formId}" class="setupfields" data-connect-kind="api_key"><input type="hidden" name="source" value="venice"><input class="keyfield" type="password" name="api_key" required autocomplete="new-password" placeholder="API key" aria-label="API key"><span class="actmsg" data-action-message role="status"></span></form>`;
    const sheet = `<div class="sheet" id="${sheetId}" aria-hidden="true"><h4>Set up Venice</h4>${setupStepsSheet({ id: sheetId, provider: 'Venice', steps: action.instructions.diy_steps, finalForm: form })}</div>`;
    return setupRow({ ...id, label: source.label, blurb: action.instructions.plain_intro, action: { label: action.label, kind: 'none', sheet: sheetId, ...gate } }) + sheet;
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
  if (action.kind === 'oauth' && action.source === 'evernote') return DASHBOARD_EVERNOTE_CONSENT_HELP;
  if (action.kind === 'guided_session') return action.instructions[0] ?? source.connection.label;
  if (action.kind === 'api_key') return action.instructions.plain_intro;
  if (action.kind === 'this_computer') return 'Choose the folders on this computer Olympus may read. Nothing is read until you choose.';
  if (action.kind === 'archive_import') {
    // Import-only sources (Reflect, Roam, Evernote) and Archives, for exports from anywhere else; none is mail only.
    const where = source.source_id === 'archive.imports'
      ? 'Import an export from another app under Other archives on the main page'
      : `Import your ${source.label} export from its card on the main page`;
    return `${where}. Olympus copies it into its own storage to read it, and never changes the original.`;
  }
  return '';
}

/** `oauth` and `api_key` are the two kinds with a control route behind a plain button. */
function connectAction(source: DashboardSourceCard): DashboardActionInput | undefined {
  const action = source.connection.action;
  if (action.kind === 'oauth') return { label: action.label, kind: 'oauth', source: action.source, primary: false };
  if (action.kind === 'api_key') return { label: action.label, kind: 'api_key', source: action.source, primary: false };
  if (action.kind === 'this_computer') return { label: action.label, kind: 'this_computer', source: action.source, primary: false };
  return undefined;
}
