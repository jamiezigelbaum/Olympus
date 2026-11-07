import { judgeArchiveEstimate, JUDGE_PRICE_DATE, LOCAL_JUDGE_MEASUREMENT, VENICE_JUDGE_ESTIMATE, type JudgeSpendingStatus } from '../../classification/judge-spending.ts';
import { sourceFailureKind, sourceSupportDetails } from '../source-failure.ts';
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
import { DASHBOARD_PRIVACY_SETTINGS_COPY as S, DASHBOARD_PRIVATE_ANSWERS_COPY } from '../vocabulary.ts';
import { dashboardPrivacyTabs, PRIVACY_TABS_CSS } from './private-answers.ts';
import { renderModelSetup, renderModelSetupBlocker, dashboardModelsBlockedReason } from '../model-setup.ts';
import type { DashboardOutsideHelpStatus } from '../outside-help.ts';
import { AGENT_CONNECT_CSS, LOCAL_PAGE_CSS, MODEL_SETUP_CSS } from '../static-styles.ts';
import {
  DASHBOARD_COMPUTER_PANEL_COPY,
  DASHBOARD_EVERNOTE_CONSENT_HELP,
  dashboardCheckedLabel,
  dashboardProviderRefusalDetail,
  dashboardProviderRefusalSentence,
  dashboardSetupLead,
} from '../vocabulary.ts';

export interface DashboardJudgeSetup extends JudgeSpendingStatus { cloudModel: string | null; cloudAvailable: boolean }
export interface DashboardPageOptions {
  judgeSetup?: DashboardJudgeSetup;
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
  systemReport?: string;
  /** OPENER supplies the current desktop/headless approval handoff. */
  agentConnectHost?: AgentConnectHost;
  /** The saved Private-answer mode, for Privacy settings: its id and its label. */
  answerMode?: { id: string; label: string };
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

/**
 * Privacy settings (`?keys`), the Privacy page's second tab (owner, 2026-11-07):
 * what's private, how Private items are answered (the default and the two
 * models it can use), and who sorts the archive by privacy. zkAPI lives on
 * Private questions, since it only answers questions asked there; sources
 * set up on the computer live on Connect a source (`?connect`).
 */
export function renderDashboardKeysPage(view: SourceDashboardViewModel, options?: DashboardPageOptions): string {
  const home = options?.basePath ?? '/dashboard';
  const token = readToken(options?.basePath);
  const mode = options?.answerMode;
  const body = [
    dashboardControlGate({ connected: unlocked(options) }),
    dashboardPrivacyTabs('settings', token),
    `<section id="whats-private"><h3 class="sect">${escapeHtml(S.whatsPrivate)}</h3><p class="pnote">${escapeHtml(S.intro)}</p>`
      + `<div class="srow nodot"><div class="smain"><b>${escapeHtml(S.wordsTitle)}</b><p class="pnote">${escapeHtml(S.wordsLine)}</p></div><div class="sact"><a class="btn" href="${escapeHtml(home)}">${escapeHtml(S.wordsOpen)}</a></div></div></section>`,
    `<section id="private-routing"><h3 class="sect">${escapeHtml(S.answeredTitle)}</h3><p class="pnote">${escapeHtml(S.answeredIntro)}</p>`
      + (mode ? `<div class="srow nodot" data-answer-mode="${escapeHtml(mode.id)}"><div class="smain"><b>${escapeHtml(mode.label)}</b>${mode.id === 'local-first' ? ` <span class="pnote">· ${escapeHtml(S.recommended)}</span>` : ''}</div><div class="sact"><a class="btn" href="${escapeHtml(home)}">${escapeHtml(S.change)}</a></div></div>` : '')
      + renderModelSetupBlocker(view.model_setup)
      + `<div${view.model_setup?.cards.some(card => card.id === 'venice') ? ' id="venice-setup"' : ''}>${renderModelSetup(view.model_setup, { heading: false })}</div></section>`,
    view.model_setup?.cards.some(card => card.id === 'venice') ? '' : `<section id="venice-setup"><h3 class="sect">${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.setUpVenice)}</h3><p class="pnote">${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.veniceSetupHelp)}</p><div class="modelaction"><form method="post" action="/dashboard/connect/api-key" data-connect-kind="api_key" data-model-provider="venice"><input type="hidden" name="source" value="venice"><input class="keyfield" type="password" name="api_key" required autocomplete="new-password" placeholder="${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.veniceKey)}" aria-label="${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.veniceKey)}"><button type="submit" class="btn primary">${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.connectVenice)}</button><span data-action-message role="status"></span></form></div></section>`,
    renderJudgeChoice(view, options),
  ].filter((block) => block !== '').join('\n');
  return localShell({
    crumb: DASHBOARD_PRIVATE_ANSWERS_COPY.crumb,
    meta: dashboardCheckedLabel(view.generated_at, options?.now ?? new Date()),
    body,
    styles: [MODEL_SETUP_CSS, PRIVACY_TABS_CSS],
    options,
  });
}

/** Connect a source (`?connect`): the setup sheets for the sources that connect on this computer, where Connect lands. */
export function renderDashboardConnectPage(view: SourceDashboardViewModel, options?: DashboardPageOptions): string {
  const blocked = view.model_setup !== undefined && !view.model_setup.ready;
  const sources = view.sources.filter((source) => source.connection.action.kind !== 'none' || source.source_id === 'telegram.messages' || source.source_id === 'whatsapp.personal.messages');
  const body = [
    dashboardControlGate({ connected: unlocked(options) }),
    renderModelSetupBlocker(view.model_setup),
    sources.length === 0
      ? `<p class="pnote">${escapeHtml(W.connect.empty)}</p>`
      : `<div class="srows" id="sources">${sources.map((source) => renderSetupRow(source, view, blocked, options?.basePath ?? '/dashboard', options?.messagingLocalSession === true) + sourceSupportBlock(source)).join('\n')}</div>`,
  ].filter((block) => block !== '').join('\n');
  return localShell({
    crumb: W.connect.title,
    meta: dashboardCheckedLabel(view.generated_at, options?.now ?? new Date()),
    body,
    styles: [MODEL_SETUP_CSS],
    options,
  });
}

/** The read-only token a dash_ reader's basePath carries, so the tabs keep it. */
function readToken(basePath: string | undefined): string | undefined {
  if (!basePath) return undefined;
  const query = basePath.indexOf('?');
  if (query < 0) return undefined;
  return new URLSearchParams(basePath.slice(query + 1)).get('token') ?? undefined;
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
    return renderMessagingCard(source.source_id === 'telegram.messages' ? 'telegram' : 'whatsapp', messagingLocalSession, { paired: ['connected', 'syncing', 'synced', 'waiting_for_first_sync'].includes(source.connection.state) });
  }
  const gate = blocked ? { blockedReason: dashboardModelsBlockedReason(view.model_setup) } : {};
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
      action: { label: providerNote(view, action).lead?.button ?? action.label, kind: 'none', sheet: sheetId, ...gate },
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
        blurb: providerNote(view, action).lead?.title ?? setupBlurb(source),
        action: { label: providerNote(view, action).lead?.button ?? action.label, kind: 'none', sheet: connect.sheetId, ...gate },
      });
      return `${row}\n${connect.sheet}`;
    }
  }
  if (action.kind === 'api_key' && action.source === 'venice') {
    const sheetId = 'setup-venice-api';
    const form = (formId: string) => `<form id="${formId}" class="setupfields" data-connect-kind="api_key"><input type="hidden" name="source" value="venice"><input class="keyfield" type="password" name="api_key" required autocomplete="new-password" placeholder="API key" aria-label="API key"><span class="actmsg" data-action-message role="status"></span></form>`;
    const sheet = `<div class="sheet" id="${sheetId}" aria-hidden="true"><h4>Set up Venice</h4>${setupStepsSheet({ id: sheetId, provider: 'Venice', steps: action.instructions.diy_steps, ...(action.instructions.setup_shortcut ? { shortcut: action.instructions.setup_shortcut } : {}), finalForm: form })}</div>`;
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
): { providerNote?: string; lead?: { title: string; body: string; button: string; notes: string[] } } {
  if ((action.source === 'gmail' || action.source === 'google-drive') && view.google_pilot?.mode === 'advanced_byo_required') return { lead: {
    title: "Olympus's Google sign-in is full",
    body: "Until Google reviews Olympus, it lets 100 people use Olympus's Google app. You can still connect Gmail and Drive with a free app of your own. It takes about ten minutes.",
    button: 'Set up my own Google app',
    notes: ["What changes: Google shows your own name on its warning, not Olympus's.", "What stays the same: Olympus reads your mail on this computer, and judges each message Personal, Private or Secret as before."],
  } };
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

/** A local, content-free report using the same copy control as pairing errors. */
export function renderDashboardHelpPage(options?: DashboardPageOptions): string {
  const report = options?.systemReport;
  return localShell({ crumb: 'Help', meta: '', options, styles: [], body:
    dashboardControlGate({ connected: unlocked(options) })
    + '<h3>Help with Olympus</h3><p>If something is not working, copy the system report and send it to support.</p>'
    + (report ? `<pre id="system-report" class="promptbox">${escapeHtml(report)}</pre><p>Only system states and error codes: no names, numbers, emails, chats, notebook or folder titles, or home folder paths.</p><button type="button" class="btn" data-copy-target="#system-report">Copy system report</button><span data-copy-status aria-live="polite"></span>` : unlocked(options) ? '<p>Olympus could not read the system report. Try again, or contact support.</p>' : '<p>Open dashboard controls on this computer to copy a system report.</p>')
    + '<p><a href="https://olympusplugin.ai/support" target="_blank" rel="noopener noreferrer">Contact support</a></p>',
  });
}

function sourceSupportBlock(source: DashboardSourceCard): string {
  if (!(source.schedule?.consecutive_failures || source.connection.state === 'reauth_required' || source.answer_readiness?.state === 'needs_attention')) return '';
  const id = `source-support-${source.source_id.replace(/[^a-z0-9-]/gi, '-')}`;
  const report = sourceSupportDetails({ sourceId: source.source_id, state: source.connection.state, failure: sourceFailureKind(source.schedule?.last_error_kind, source.schedule?.degraded_reason), ref: source.schedule?.last_error_hash });
  return `<details><summary>Details for support</summary><pre class="promptbox" id="${id}">${escapeHtml(report)}</pre><button type="button" class="btn" data-copy-target="#${id}">Copy details</button><span data-copy-status aria-live="polite"></span><p>No names, numbers, emails, chats or folder titles.</p></details>`;
}

/** Counts are the connected sources' stored items, not a promise of full discovery. */
export function renderJudgeChoice(view: SourceDashboardViewModel, options?: DashboardPageOptions): string {
  const status = options?.judgeSetup;
  if (!status) return '';
  const items = view.sources.reduce((sum, source) => sum + (source.coverage.stored_items ?? source.coverage.indexed_items), 0);
  const estimate = judgeArchiveEstimate(items, status.cloudModel ?? '');
  const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const hours = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  const cloud = status.stop !== 'storage' && status.cloudAvailable && estimate.cloudDollars !== null;
  const stopped = status.stop === 'storage'
    ? '<p role="alert">The saved spending record cannot be read. Cloud judging is off; local judging can continue. Restore the spending record from a backup or repair its access, then restart Olympus. <a href="/dashboard?help">Open Help</a></p>'
    : status.stop === 'payment'
    ? '<p role="alert">Venice stopped because your account needs credit (HTTP 402). <a href="https://venice.ai/settings/api" target="_blank" rel="noopener noreferrer">Check your Venice credit or account</a>, then approve cloud judging again below. Your remaining items stay Private and use the free local judge when available.</p>'
    : status.stop === 'cap' ? '<p role="status">Cloud judging reached your spending limit. Remaining items stay Private and use the free local judge when available. Raise the total limit below to continue with Venice.</p>' : '';
  const nights = `${hours(estimate.shortHours / 8)} to ${hours(estimate.longHours / 8)} nights`;
  const venicePrice = estimate.cloudDollars === null ? 'Cost unavailable' : `About ${money(estimate.cloudDollars)}`;
  const row = (term: string, value: string) => `<span class="judgeterm">${escapeHtml(term)}</span><span>${value}</span>`;
  // Each way to sort is one card; clicking the other card opens a
  // confirmation under the cards (pure CSS on the checked radio), and
  // Cancel resets the form to the choice in use.
  const option = (id: 'local' | 'venice', title: string, lead: string, rows: string, fit: string, enabled: boolean) =>
    `<label class="judgeopt"><span class="judgehead"><input type="radio" name="choice" value="${id}"${status.choice === id ? ' checked' : ''}${enabled ? '' : ' disabled'}> <b>${escapeHtml(title)}</b>${status.choice === id ? ` <span class="judgenow">${escapeHtml(S.judgeNow)}</span>` : ''}</span>`
    + `<span class="judgelead">${lead}</span><span class="judgerows">${rows}</span><span class="judgefit">${fit}</span></label>`;
  const local = option('local', S.judgeLocal, escapeHtml(S.judgeLocalLead),
    row(S.judgeCost, 'Free')
    + row(S.judgeTime, `About ${nights} of 8 hours (${hours(estimate.shortHours)} to ${hours(estimate.longHours)} hours)`)
    + row(S.judgeWhen, escapeHtml(S.judgeLocalWhen)),
    escapeHtml(S.judgeLocalFit), true);
  const venice = option('venice', S.judgeVenice, 'Venice reads every item to sort it, including items it marks Private.',
    row(S.judgeCost, `${venicePrice}, on your own Venice account`)
    + row(S.judgeTime, `About ${hours(estimate.cloudHours)} hours`)
    + row(S.judgeWhen, escapeHtml(S.judgeVeniceWhen))
    + (status.cloudModel ? row(S.judgeModel, escapeHtml(status.cloudModel)) : ''),
    escapeHtml(S.judgeVeniceFit), cloud);
  const spent = status.uncapped
    ? 'No spending limit is set, so Olympus isn\'t tracking cloud spending yet. Your Venice account shows what you\'ve spent.'
    : `${status.stop === 'storage' ? 'Spending amounts are unavailable.' : `Spent or reserved: ${money(status.spentDollars)}. Remaining: ${money(status.remainingDollars)}.`} Olympus stops before going past this limit. Items not yet sorted then stay Private and wait for this computer.`;
  const cap = `<label class="judgecap">${escapeHtml(S.judgeCap)} <input type="number" name="cap_dollars" min="0" step="0.01" value="${status.uncapped ? '' : status.capDollars}"></label><p class="pnote">${spent}</p>`;
  const reply = '<span data-action-message role="status"></span>';
  const dialog = (pick: 'local' | 'venice', title: string, body: string, button: string) =>
    `<dialog class="judgedialog" data-judge-dialog="${pick}" aria-labelledby="judge-dialog-${pick}"><h3 id="judge-dialog-${pick}">${escapeHtml(title)}</h3>${body}`
    + `<div class="judgedialogbar"><button class="btn" type="button" data-judge-cancel>${escapeHtml(S.judgeCancel)}</button><button class="btn primary" type="submit">${escapeHtml(button)}</button></div></dialog>`;
  const confirm = status.choice === 'venice'
    ? dialog('local', S.judgeToLocal, `<p>${escapeHtml(S.judgeToLocalLine)}</p>`, S.judgeToLocalButton)
      + `<div class="judgekeep">${cap}<button class="btn" type="submit">${escapeHtml(S.judgeSaveLimit)}</button></div>`
    : dialog('venice', S.judgeToVenice, `<p>Venice will read each item it sorts, including items it marks Private, and charge your Venice account${estimate.cloudDollars === null ? '' : `: about ${money(estimate.cloudDollars)} for the ${items.toLocaleString('en-US')} items found so far`}.</p>${cap}`, S.judgeToVeniceButton);
  return `<section id="privacy-judge"><h3 class="sect">${escapeHtml(S.judgeTitle)}</h3><p class="pnote">${escapeHtml(S.judgeIntro)}</p>
    <form data-judge-choice data-judge-current="${status.choice}"><fieldset${unlocked(options) ? '' : ' disabled'}><legend class="judgelegend">${escapeHtml(S.judgeLegend)}</legend>
    ${status.upgradeNote ? '<p role="status">You can now set a spending limit for cloud judging. Venice keeps sorting your items as you approved, with no limit, until you set one.</p>' : ''}${stopped}
    <div class="judgeopts">${local}${venice}</div>
    ${cloud || status.stop === 'storage' ? '' : '<p class="pnote">To use Venice, connect your Venice key under How Private items are answered. Venice needs a model with a listed price.</p>'}
    ${confirm}${reply}
    <p class="pnote">Estimates for the ${items.toLocaleString('en-US')} items found so far. Recommended: ${estimate.recommended === 'venice' ? 'Venice for this archive size, if you choose to send it to the cloud' : 'the free judge on this computer'}. Cloud stays off until you choose and approve it.</p>
    <details class="judgehow"><summary>How these estimates are made</summary>
    <p>Counts grow as Olympus reads more, and long documents take longer and cost more. This computer: measured on an ${LOCAL_JUDGE_MEASUREMENT.computer} with a ${LOCAL_JUDGE_MEASUREMENT.model}, ${LOCAL_JUDGE_MEASUREMENT.shortPerMinute} short or ${LOCAL_JUDGE_MEASUREMENT.longPerMinute} long items a minute (${LOCAL_JUDGE_MEASUREMENT.date}); yours may differ. Venice: 800 input and 80 output tokens per item, one call per item, about ${VENICE_JUDGE_ESTIMATE.itemsPerMinute} items a minute (${VENICE_JUDGE_ESTIMATE.date}); listed prices checked ${JUDGE_PRICE_DATE}. Your account limits and extra privacy checks can change both. Olympus reserves an estimated maximum before each Venice call, and your Venice bill may differ from these estimates.</p>
    <p>Venice uses your own account and API key, and you pay Venice; Olympus pays for nothing. An end-to-end encrypted option is not available yet.</p></details>
    </fieldset></form></section>`;
}
