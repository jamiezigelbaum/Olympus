import { dashboardPeopleRow } from './people.ts';
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
 * - Build a connector (`?connector`): now a dialog on Sources; the address
 *   redirects to `?connect#build-connector`, which opens it (#1087).
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
import { DASHBOARD_ALL_SOURCES_LANDING, DASHBOARD_OPEN_FRAGMENT_KEY, dashboardImportLandingToken, dashboardSourceLandingToken } from '../../../core/open-targets.ts';
import { renderDashboardAgentsSection, type AgentConnectHost } from '../agents.ts';
import {
  connectorSheet,
  dashboardControlGate,
  dashboardGoogleProviderNote,
  dashboardNeedsSetupSheet,
  dashboardOAuthConnectSheet,
  escapeHtml,
  pageShell,
  rowMenu,
  safeExternalHref,
  setupRow,
  setupStepsSheet,
  type DashboardActionInput,
} from '../components.ts';
import { DASHBOARD_OUTSIDE_HELP_COPY, DASHBOARD_PRIVACY_SETTINGS_COPY as S, DASHBOARD_PRIVATE_ANSWERS_COPY } from '../vocabulary.ts';
import { DASHBOARD_SETTINGS_ZKAPI_ID, dashboardPrivacyTabs, PRIVACY_TABS_CSS } from './private-answers.ts';
import { dashboardLocalPageHref } from '../host-page.ts';
import { dashboardTopNav, TOP_NAV_CSS, type DashboardTab } from '../top-nav.ts';
import { sourceLogoTile, SOURCE_LOGO_CSS } from '../source-logos.ts';
import { dashboardActionLabel, DASHBOARD_DISCONNECTED_DATA_KEPT } from '../vocabulary.ts';
import { renderUpdateNotice, UPDATE_NOTICE_CSS } from '../update-now.ts';
import type { SelfUpdateStatus } from '../../../core/self-update.ts';
import { MODEL_PICKER_CSS, renderAnswerModelPickers, renderZkapiModelPicker } from '../model-pickers.ts';
import { renderModelSetup, renderModelSetupBlocker, dashboardModelsBlockedReason } from '../model-setup.ts';
import { renderOutsideHelpCard, type DashboardOutsideHelpStatus } from '../outside-help.ts';
import { AGENT_CONNECT_CSS, DASHBOARD_OUTSIDE_HELP_CSS, LOCAL_PAGE_CSS, MODEL_SETUP_CSS } from '../static-styles.ts';
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
  /** The model pickers on Privacy rules (model-choices-backend.ts). */
  modelChoices?: import('../../../core/model-choices.ts').DashboardModelChoices | undefined;
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
  /** Settings: settings an agent proposed for the owner to apply (#1050), and what the last Apply did. */
  settingsProposal?: {
    current: import('../../../core/settings-proposal.ts').SettingsProposal | undefined;
    lastApplied: import('../../settings-proposal-holder.ts').SettingsProposalApplyResult | undefined;
  };
  /** Settings: the built-in models on this computer, and an update when one is out. */
  settings?: {
    /** Settings › Models on this computer (#1043, #1085). */
    models?: import('../models-on-computer.ts').DashboardModelsOnComputer;
    update?: { version: string; command: string };
    /** Update now (#1063): this platform's Terminal command, whether the engine updates itself, and its current record. */
    updater?: { command: string; selfUpdate: boolean; status?: SelfUpdateStatus | undefined };
  };
  /** OPENER supplies the current desktop/headless approval handoff. */
  agentConnectHost?: AgentConnectHost;
  /** The saved Private-answer mode, for Privacy settings: its id and its label. */
  answerMode?: { id: string; label: string };
  /** The Outside help card's facts, for that page only, with the control session. */
  outsideHelp?: DashboardOutsideHelpStatus | undefined;
  /** True when the live control session was minted locally (the only grade the consult routes take). */
  outsideHelpLocalSession?: boolean;
  /** What AI apps received (pages/apps-received.ts): whether this worker keeps the list. */
  appsReceivedAvailable?: boolean;
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

/** The Build a connector dialog's id on Sources; `?connector` lands on `?connect#build-connector`. */
export const CONNECTOR_DIALOG_ID = 'build-connector';
const CONNECTOR_DIALOG_HEADING = 'Build a connector with your agent';
// The playbook the prompt names is a contributor guide: it is deliberately
// outside the published package, so an install alone cannot satisfy the
// prompt's own first clause. The dialog says that here rather than letting the
// agent go looking for a file the managed plugin root does not contain.
const CONNECTOR_DIALOG_INTRO = 'For a source Olympus doesn\'t have yet. Copy this to your coding agent and '
  + 'replace <SOURCE>. The connector guide is in an Olympus source checkout; CONTRIBUTING.md says how to get one.';

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

/** The unlock card while locked. Unlocked, the top bar carries "Unlocked · Lock" instead. */
function lockedGate(options: DashboardPageOptions | undefined): string {
  return unlocked(options) ? '' : dashboardControlGate({ connected: false });
}

/** The shell every local page shares: "Olympus / <Page>", the lead back to the dashboard, the shared controller. */
function localShell(input: {
  crumb: string;
  /** The top-bar tab this page sits under. */
  tab: DashboardTab;
  meta: string;
  body: string;
  styles: readonly string[];
  options: DashboardPageOptions | undefined;
}): string {
  const csrf = input.options?.controlSessionCsrfToken;
  const token = readToken(input.options?.basePath);
  return pageShell({
    title: 'Olympus',
    crumb: input.crumb,
    ...(input.options?.basePath === undefined ? {} : { basePath: input.options.basePath }),
    nav: dashboardTopNav({ active: input.tab, unlocked: csrf !== undefined, ...(token ? { token } : {}) }),
    meta: input.meta,
    body: input.body,
    controller: { ...(csrf === undefined ? {} : { csrfToken: csrf }) },
    poll: {
      unlocked: csrf !== undefined,
      ...(csrf === undefined ? {} : { controlSessionCsrfToken: csrf }),
    },
    styles: [LOCAL_PAGE_CSS, TOP_NAV_CSS, ...input.styles],
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
    lockedGate(options),
    dashboardPrivacyTabs('settings', token),
    `<section id="whats-private"><h3 class="sect">${escapeHtml(S.whatsPrivate)}</h3><p class="pnote">${escapeHtml(S.intro)}</p>`
      + `<div class="srow nodot"><div class="smain"><b>${escapeHtml(S.wordsTitle)}</b><p class="pnote">${escapeHtml(S.wordsLine)}</p></div><div class="sact"><a class="btn" href="${escapeHtml(home)}">${escapeHtml(S.wordsOpen)}</a></div></div></section>`,
    `<section id="private-routing"><h3 class="sect">${escapeHtml(S.answeredTitle)}</h3><p class="pnote">${escapeHtml(S.answeredIntro)}</p>`
      + (mode ? `<div class="srow nodot" data-answer-mode="${escapeHtml(mode.id)}"><div class="smain"><b>${escapeHtml(mode.label)}</b>${mode.id === 'local-first' ? ` <span class="pnote">· ${escapeHtml(S.recommended)}</span>` : ''}</div><div class="sact"><a class="btn" href="${escapeHtml(home)}">${escapeHtml(S.change)}</a></div></div>` : '')
      + renderModelSetupBlocker(view.model_setup)
      + `<div${view.model_setup?.cards.some(card => card.id === 'venice') ? ' id="venice-setup"' : ''}>${renderModelSetup(view.model_setup, { heading: false })}</div>`
      + renderAnswerModelPickers(options?.modelChoices, unlocked(options)) + '</section>',
    renderZkapiPrivacy(options, token),
    view.model_setup?.cards.some(card => card.id === 'venice') ? '' : `<section id="venice-setup"><h3 class="sect">${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.setUpVenice)}</h3><p class="pnote">${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.veniceSetupHelp)}</p><div class="modelaction"><form method="post" action="/dashboard/connect/api-key" data-connect-kind="api_key" data-model-provider="venice"><input type="hidden" name="source" value="venice"><input class="keyfield" type="password" name="api_key" required autocomplete="new-password" placeholder="${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.veniceKey)}" aria-label="${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.veniceKey)}"><button type="submit" class="btn primary">${escapeHtml(DASHBOARD_PRIVATE_ANSWERS_COPY.connectVenice)}</button><span data-action-message role="status"></span></form></div></section>`,
    renderJudgeChoice(view, options),
  ].filter((block) => block !== '').join('\n');
  return localShell({
    crumb: DASHBOARD_PRIVATE_ANSWERS_COPY.crumb,
    tab: 'privacy',
    meta: dashboardCheckedLabel(view.generated_at, options?.now ?? new Date()),
    body,
    styles: [MODEL_SETUP_CSS, PRIVACY_TABS_CSS, MODEL_PICKER_CSS, DASHBOARD_OUTSIDE_HELP_CSS],
    options,
  });
}

/**
 * Privacy rules › zkAPI (#1047): its model, and what may be sent, how the
 * question is prepared, who writes it and its languages. The account (status,
 * money, setup) is on Settings › zkAPI.
 */
function renderZkapiPrivacy(options: DashboardPageOptions | undefined, token: string | undefined): string {
  const picker = renderZkapiModelPicker(options?.modelChoices, unlocked(options));
  const csrfToken = options?.controlSessionCsrfToken;
  const card = options?.outsideHelp
    ? renderOutsideHelpCard(options.outsideHelp, { ...(csrfToken !== undefined ? { csrfToken } : {}), localSession: options.outsideHelpLocalSession === true, untitled: true, part: 'privacy', otherPartHref: `${dashboardLocalPageHref('settings', token)}#${DASHBOARD_SETTINGS_ZKAPI_ID}` })
    : '';
  if (!picker && !card) return '';
  return `<section id="zkapi-model"><h3 class="sect">${escapeHtml(DASHBOARD_OUTSIDE_HELP_COPY.settingsTitle)}</h3>${picker}${card}</section>`;
}

/** The sync route's own name for each source it checks (setup-backend.ts uses the same). */
const SYNC_ROUTE_SOURCES: Readonly<Record<string, string>> = {
  'gmail.email': 'gmail',
  'google_drive.docs': 'google-drive',
  'dropbox.files': 'dropbox',
  'x.bookmarks': 'x',
  'readwise.library': 'readwise',
  'evernote.notes': 'evernote',
  'local.files': 'local.files',
};

/** What each source holds, for its tile in Add a source. */
const SOURCE_TILE_LINES: Readonly<Record<string, string>> = {
  'gmail.email': 'Email',
  'google_drive.docs': 'Docs and files',
  'dropbox.files': 'Files',
  'local.files': 'Folders you pick',
  'archive.imports': 'An export from any app',
  'x.bookmarks': 'Posts you saved',
  'telegram.messages': 'Chats',
  'whatsapp.personal.messages': 'Chats',
  'readwise.library': 'Highlights',
  'evernote.notes': 'Notes',
};

const CONNECTED_STATES = new Set(['connected', 'waiting_for_first_sync', 'syncing', 'synced', 'reauth_required']);
const MESSAGING_SOURCES = new Set(['telegram.messages', 'whatsapp.personal.messages']);

function sourceDomId(sourceId: string): string {
  return sourceId.replace(/[^A-Za-z0-9_-]+/g, '-');
}

function sourceFacts(source: DashboardSourceCard): string {
  if (source.connection.state === 'reauth_required') return 'needs sign-in';
  const facts: string[] = [];
  const items = source.coverage?.indexed_items ?? 0;
  if (items > 0) facts.push(`${items.toLocaleString('en-US')} ${MESSAGING_SOURCES.has(source.source_id) ? 'messages' : 'items'}`);
  if (source.freshness?.label) facts.push(source.freshness.label);
  return facts.join(' · ');
}

function sourceStatus(source: DashboardSourceCard): 'ok' | 'attention' {
  return source.connection.state === 'reauth_required' || source.schedule?.consecutive_failures || source.answer_readiness?.state === 'needs_attention' ? 'attention' : 'ok';
}

/**
 * A connected source whose provider refused it while its sign-in still looks
 * healthy carries a Reauthenticate action: its setup stays reachable.
 */
function needsSetupAgain(source: DashboardSourceCard): boolean {
  return CONNECTED_STATES.has(source.connection.state) && source.connection.action.kind !== 'none'
    && source.connection.action.kind !== 'archive_import' && !MESSAGING_SOURCES.has(source.source_id);
}

/** One connected source: logo, name, facts, the one thing it needs, and the ⋯ menu. */
function connectedSourceRow(source: DashboardSourceCard, messagingLocalSession: boolean, off: string, kept = false, basePath = '/dashboard'): { row: string; dialogs: string } {
  const id = sourceDomId(source.source_id);
  const label = escapeHtml(source.label);
  const items: string[] = [];
  const dialogs: string[] = [];
  const sync = kept ? undefined : SYNC_ROUTE_SOURCES[source.source_id];
  // Home lists no sources (#1085): Details opens this source's own row there, with its See why, Unpair,
  // Import an archive and Details for support.
  if (!kept) items.push(`<a class="menuitem" href="${escapeHtml(`${basePath}#${DASHBOARD_OPEN_FRAGMENT_KEY}=${dashboardSourceLandingToken(source.source_id)}`)}" data-source-details>Details</a>`);
  if (sync) items.push(`<form data-source-action="sync_now"><input type="hidden" name="source" value="${escapeHtml(sync)}"><button class="menuitem" type="submit"${off}>Sync now</button><span data-action-message role="status"></span></form>`);
  const confirm = (kind: 'disconnect_source' | 'delete_source_data', title: string, line: string, button: string, danger: boolean, menuLabel = title.endsWith('?') ? title.slice(0, -1) : title): string => {
    const dialogId = `${kind === 'disconnect_source' ? 'disconnect' : 'delete'}-${id}`;
    dialogs.push(`<dialog class="adddialog" id="${dialogId}" data-closable aria-labelledby="${dialogId}-title"><div class="adddialoghead"><h3 id="${dialogId}-title">${escapeHtml(title)}</h3><button class="btn iconbtn" type="button" data-dialog-close aria-label="Close">✕</button></div>`
      + `<p class="pnote">${escapeHtml(line)}</p><form data-source-action="${kind}"><input type="hidden" name="source_id" value="${escapeHtml(source.source_id)}"><div class="pickbar"><button class="btn${danger ? ' danger' : ' primary'}" type="submit"${off}>${escapeHtml(button)}</button></div><span data-action-message role="status"></span></form></dialog>`);
    return `<button class="menuitem${danger ? ' danger' : ''}" type="button" data-dialog-open="${dialogId}"${off}>${escapeHtml(menuLabel)}${danger ? '…' : ''}</button>`;
  };
  if (kept) {
    // Olympus deletes a source's data only once it is disconnected, so Delete
    // lives on the row a disconnect leaves behind.
  } else if (MESSAGING_SOURCES.has(source.source_id)) {
    const dialogId = `pairing-${id}`;
    // The card is the dialog: its header carries the name, the ⋯ menu (Check connection, Pair again) and ✕ (#1086).
    dialogs.push(`<dialog class="adddialog msgdialog" id="${dialogId}" data-closable aria-label="${label} pairing">`
      + renderMessagingCard(source.source_id === 'telegram.messages' ? 'telegram' : 'whatsapp', messagingLocalSession, { paired: true }, { closable: true }) + '</dialog>');
    items.push(`<button class="menuitem" type="button" data-dialog-open="${dialogId}"${off}>Pairing and chats</button>`);
  } else if (source.connection.disconnect) {
    items.push('<hr>' + confirm('disconnect_source', `Disconnect ${source.label}?`, source.connection.disconnect.confirmation, 'Disconnect', false));
  }
  if (kept) items.push(confirm('delete_source_data', `Delete what Olympus indexed from ${source.label}?`, `Olympus deletes what it indexed from ${source.label}. Your ${source.label} account and files are not touched. This cannot be undone.`, 'Delete indexed data', true, 'Delete indexed data'));
  const fixLabel = kept ? 'Reconnect' : source.connection.state === 'reauth_required' ? 'Sign in'
    : needsSetupAgain(source) && 'label' in source.connection.action ? dashboardActionLabel(source.connection.action.label) : '';
  const needs = fixLabel
    ? `<button class="btn${kept ? '' : ' primary'}" type="button" data-dialog-open="add-source" data-source-open="${escapeHtml(source.source_id)}"${off}>${escapeHtml(fixLabel)}</button>`
    : '';
  const facts = kept ? `${DASHBOARD_DISCONNECTED_DATA_KEPT} · ${(source.coverage?.indexed_items ?? 0).toLocaleString('en-US')} items` : sourceFacts(source);
  const row = `<div class="srcrow${kept ? ' kept' : ''}" data-source-row="${escapeHtml(source.source_id)}"${kept ? ' data-source-kept' : ''}>${sourceLogoTile(source.source_id, kept ? 'off' : sourceStatus(source))}`
    + `<div class="srcmain"><b>${label}</b>${facts ? `<span class="pnote"> · ${escapeHtml(facts)}</span>` : ''}</div>`
    + `<div class="srcact">${needs}${items.length ? rowMenu(source.label, items.join('')) : ''}</div></div>`;
  return { row, dialogs: dialogs.join('') };
}

/**
 * Sources (`?connect`, owner 2026-11-07, mockups final-7, 7a, 7b and
 * sources-logos): the connected sources, each with its logo, facts and a ⋯
 * menu, then + Add a source, which opens the catalog in a side sheet. A tile
 * opens that source's own setup there. ✕, Esc or a click outside closes it.
 */
export function renderDashboardConnectPage(view: SourceDashboardViewModel, options?: DashboardPageOptions): string {
  const blocked = view.model_setup !== undefined && !view.model_setup.ready;
  const basePath = options?.basePath ?? '/dashboard';
  const token = readToken(options?.basePath);
  const off = unlocked(options) ? '' : ' disabled';
  const sources = view.sources.filter((source) => source.source_id !== 'venice.api');
  const connected = sources.filter((source) => CONNECTED_STATES.has(source.connection.state));
  const setupable = sources.filter((source) => source.connection.state === 'reauth_required' || needsSetupAgain(source)
    || (!CONNECTED_STATES.has(source.connection.state) && (source.connection.action.kind !== 'none' || MESSAGING_SOURCES.has(source.source_id))));
  // Disconnected with its indexed data kept: a quiet row with Reconnect and Delete.
  const kept = sources.filter((source) => !CONNECTED_STATES.has(source.connection.state) && (source.coverage?.indexed_items ?? 0) > 0
    && source.connection.action.kind !== 'archive_import');
  const rows = connected.map((source) => connectedSourceRow(source, options?.messagingLocalSession === true, off, false, basePath))
    .concat(kept.map((source) => connectedSourceRow(source, false, off, true, basePath)));
  const tiles = setupable.filter((source) => !CONNECTED_STATES.has(source.connection.state)).map((source) =>
    `<button class="srctile" type="button" data-source-pick="${escapeHtml(source.source_id)}">${sourceLogoTile(source.source_id)}<span><b>${escapeHtml(source.label)}</b><span class="pnote">${escapeHtml(SOURCE_TILE_LINES[source.source_id] ?? '')}</span></span></button>`).join('');
  const panels = setupable.map((source) =>
    `<div class="srcsetup" data-source-setup="${escapeHtml(source.source_id)}" hidden><button class="btn plainlink" type="button" data-source-back>← All sources</button>`
    + renderSetupRow(source, view, blocked, basePath, options?.messagingLocalSession === true) + sourceSupportBlock(source) + '</div>').join('');
  const sheet = '<dialog class="srcsheet" id="add-source" data-add-source data-closable data-open-hash aria-labelledby="add-source-title">'
    + '<div class="adddialoghead"><h3 id="add-source-title">Add a source</h3><button class="btn iconbtn" type="button" data-dialog-close aria-label="Close">✕</button></div>'
    + `<div data-source-catalog><input class="keyfield srcsearch" type="search" data-source-search placeholder="Search sources…" aria-label="Search sources">`
    + (tiles ? `<div class="srctiles">${tiles}</div>` : `<p class="pnote">${escapeHtml(W.connect.empty)}</p>`)
    + `<p class="pnote">Sources you've already connected aren't listed.</p><p class="pnote">Not listed? ${CONNECTOR_OPENER}</p></div>`
    + panels + '</dialog>';
  const body = [
    lockedGate(options),
    renderModelSetupBlocker(view.model_setup, { keysHref: dashboardLocalPageHref('keys', token) }),
    `<div class="srcrows" id="sources">${rows.map((entry) => entry.row).join('') || '<p class="pnote">No sources connected yet.</p>'}</div>`,
    `<div class="srcbar"><button class="btn primary" type="button" data-dialog-open="add-source">+ Add a source</button><span class="pnote">Not listed? ${CONNECTOR_OPENER} · <a href="${escapeHtml(`${basePath}#${DASHBOARD_OPEN_FRAGMENT_KEY}=${DASHBOARD_ALL_SOURCES_LANDING}`)}" data-all-sources>Imported archives and details</a></span></div>`,
    // People (#1076): who is who across these sources, at the bottom of Sources.
    dashboardPeopleRow(token),
    rows.map((entry) => entry.dialogs).join(''),
    sheet,
    connectorDialog(),
  ].filter((block) => block !== '').join('\n');
  return localShell({
    crumb: 'Sources',
    tab: 'sources',
    meta: dashboardCheckedLabel(view.generated_at, options?.now ?? new Date()),
    body,
    styles: [MODEL_SETUP_CSS, MODEL_PICKER_CSS, SOURCE_LOGO_CSS, SOURCES_CSS],
    options,
  });
}

/**
 * Settings › Models on this computer (lane 4 mockup 8): who answers Private
 * questions (the saved route, first then fallback), the built-in model and
 * whether that route uses it, and transcription with its one cause.
 */
function renderModelsOnComputer(models: import('../models-on-computer.ts').DashboardModelsOnComputer | undefined, token: string | undefined): string {
  const rules = escapeHtml(`${dashboardLocalPageHref('keys', token)}#private-routing`);
  const row = (key: string, title: string, line: string, extra = '') =>
    `<div class="srow nodot" data-model-row="${key}"><div class="smain"><b>${escapeHtml(title)}</b> — ${escapeHtml(line)}${extra}</div></div>`;
  const rows: string[] = [];
  const answers = models?.privateAnswers;
  const change = ` <a href="${rules}">Change on Privacy rules</a>`;
  if (answers && 'off' in answers) rows.push(row('private-answers', 'Private answers', 'off: Private items are never answered.', change));
  else if (answers && 'first' in answers) {
    rows.push(row('private-answers', 'Private answers', `answered by ${answers.first}${answers.fallback ? `, then ${answers.fallback} if it can't` : ''}.`, change));
  } else if (answers && 'any' in answers) {
    const names = answers.any.length > 2 ? `${answers.any.slice(0, -1).join(', ')} or ${answers.any.at(-1)}` : answers.any.join(' or ');
    rows.push(row('private-answers', 'Private answers', `answered by ${names}, whichever is working and fastest for each question.`, change));
  } else rows.push(row('private-answers', 'Private answers', 'see how they are answered on Privacy rules.', change));
  if (models?.builtIn) {
    const built = models.builtIn;
    rows.push(row('built-in', 'Built-in model', `${built.name}, ${built.state} · ${built.used ? 'used by your current route' : 'not used by your current route'}`));
  }
  if (models?.transcription) rows.push(row('transcription', 'Transcription', models.transcription.line));
  return `<section class="setpane" id="models"><h3 class="sect">Models on this computer</h3><div class="srows">${rows.join('')}</div></section>`;
}

const SOURCES_CSS = `
.srcrows { display: grid; gap: 10px; max-width: 760px; }
.srcrow { display: flex; align-items: center; gap: 14px; border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.srcmain { flex: 1; min-width: 0; }
.srcact { display: flex; align-items: center; gap: 10px; }
.srcact .rowmenu { position: relative; }
.srcact .rowmenu .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 5; min-width: 220px; display: grid; padding: 6px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel, var(--bg)); box-shadow: 0 8px 24px rgba(0,0,0,.35); }
.menuitem { font: inherit; text-align: left; background: none; border: 0; color: var(--t1); padding: 9px 12px; border-radius: 6px; cursor: pointer; width: 100%; }
.menuitem:hover, .menuitem:focus-visible { background: color-mix(in srgb, var(--link) 14%, transparent); }
.menuitem.danger { color: #f0776c; }
.rowmenu .menu hr { border: 0; border-top: 1px solid var(--line); margin: 6px 0; }
.rowmenu form { margin: 0; }
.rowmenu [data-action-message]:empty { display: none; }
.btn.danger { border-color: #f0776c; color: #f0776c; }
.srcbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin: 16px 0; }
.srcsheet { margin: 0 0 0 auto; height: 100vh; max-height: 100vh; width: min(480px, 100vw); border: 0; border-left: 1px solid var(--line); background: var(--bg); color: var(--t1); padding: 20px 22px; overflow-y: auto; }
.srcsheet::backdrop { background: rgba(0, 0, 0, 0.45); }
.srcsearch { width: 100%; margin: 12px 0; }
.srctiles { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.srctile { display: flex; gap: 12px; align-items: center; text-align: left; font: inherit; color: var(--t1); background: none; border: 1px solid var(--line); border-radius: 10px; padding: 12px; cursor: pointer; }
.srctile:hover, .srctile:focus-visible { border-color: var(--link); }
.srctile .pnote { display: block; }
.srctile[hidden] { display: none; }
.srctiles + .pnote { margin-top: 14px; }
.srcsetup .plainlink { margin: 8px 0 12px; }
.linkbtn { font: inherit; color: var(--link); background: none; border: 0; padding: 0; text-decoration: underline; cursor: pointer; }
#build-connector > .pnote { margin: 12px 0 0; }
#build-connector .promptbox { margin: 12px 0 0; word-break: normal; overflow-wrap: anywhere; }
@media (max-width: 640px) { .srctiles { grid-template-columns: 1fr; } .srcrow { flex-wrap: wrap; } }
`;

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
    lockedGate(options),
    options?.agents
      ? renderDashboardAgentsSection({ ...options.agentConnectHost, view: options.agents, now })
      : '<p class="foot">Agent connections are not available on this install.</p>',
  ].join('\n');
  return localShell({ crumb: W.agents.title, tab: 'settings', meta: '', body, styles: [AGENT_CONNECT_CSS], options });
}

const CONNECTOR_OPENER = `<button class="linkbtn" type="button" data-dialog-open="${CONNECTOR_DIALOG_ID}">Build a connector</button>`;

/**
 * Build a connector (#1087, owner 2026-11-10, mockup 9): a dialog over
 * Sources with the prompt and Copy prompt. ✕, Close, Esc or a click outside
 * closes it; `?connector` opens Sources with it open. Nothing in it calls a
 * control route.
 */
function connectorDialog(): string {
  const id = CONNECTOR_DIALOG_ID;
  return `<dialog class="adddialog" id="${id}" data-closable data-open-hash aria-labelledby="${id}-title">`
    + `<div class="adddialoghead"><h3 id="${id}-title">${escapeHtml(CONNECTOR_DIALOG_HEADING)}</h3><button class="btn iconbtn" type="button" data-dialog-close aria-label="Close">✕</button></div>`
    + `<p class="pnote">${escapeHtml(CONNECTOR_DIALOG_INTRO)}</p>`
    + `<div class="promptbox" id="${id}-prompt">${escapeHtml(CONNECTOR_PROMPT)}</div>`
    + `<div class="pickbar"><button class="btn primary" type="button" data-copy-target="#${id}-prompt">Copy prompt</button>`
    + '<button class="btn" type="button" data-dialog-close>Close</button>'
    + '<span class="copystatus" data-copy-status aria-live="polite"></span></div></dialog>';
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

const SETTINGS_SECTIONS = [
  { id: 'agents', label: 'Agents and access' },
  { id: 'models', label: 'Models on this computer' },
  { id: DASHBOARD_SETTINGS_ZKAPI_ID, label: 'zkAPI' },
  { id: 'updates', label: 'Updates' },
  { id: 'help', label: 'Help' },
] as const;

/**
 * Settings (`?settings`, owner 2026-11-07, mockup final-8): the rarely used
 * pieces in one place, with a side list. Agents and access, the built-in
 * models (machinery, so not on Home), updates, and help. The models that
 * answer and sort Private items stay on Privacy rules. The side list shows
 * one section at a time (owner, 2026-11-10): each link targets its section,
 * and with no target the first one shows. Plain CSS, so it works locked.
 */
export function renderDashboardSettingsPage(options?: DashboardPageOptions): string {
  const now = options?.now ?? new Date();
  const token = readToken(options?.basePath);
  const settings = options?.settings;
  const side = `<nav class="setside" aria-label="Settings">${SETTINGS_SECTIONS.map(section => `<a href="#${section.id}">${escapeHtml(section.label)}</a>`).join('')}</nav>`;
  const agents = `<section class="setpane" id="agents">${options?.agents
    ? renderDashboardAgentsSection({ ...options.agentConnectHost, view: options.agents, now }).replace('<div class="sect" id="agents">Agents</div>', '<h3 class="sect">Agents and access</h3>')
    : '<h3 class="sect">Agents and access</h3><p class="pnote">Agent connections are not available on this install.</p>'}</section>`;
  const models = renderModelsOnComputer(settings?.models, token);
  // zkAPI's account half (#1047): status, problems, money, setup; its privacy choices are on Privacy rules.
  const csrfToken = options?.controlSessionCsrfToken;
  const zkapi = `<section class="setpane" id="${DASHBOARD_SETTINGS_ZKAPI_ID}"><h3 class="sect">${escapeHtml(DASHBOARD_OUTSIDE_HELP_COPY.settingsTitle)}</h3><p class="pnote">${escapeHtml(DASHBOARD_OUTSIDE_HELP_COPY.settingsIntro)}</p>`
    + (options?.outsideHelp
      ? renderOutsideHelpCard(options.outsideHelp, { ...(csrfToken !== undefined ? { csrfToken } : {}), localSession: options.outsideHelpLocalSession === true, untitled: true, part: 'account', otherPartHref: `${dashboardLocalPageHref('keys', token)}#zkapi-model` })
      : `<p class="pnote" data-outside-unavailable>${escapeHtml(csrfToken === undefined ? DASHBOARD_PRIVATE_ANSWERS_COPY.locked : DASHBOARD_PRIVATE_ANSWERS_COPY.anonymousNotSetUp)}</p>`)
    + '</section>';
  const update = settings?.update;
  const updater = settings?.updater;
  const notice = updater && (update || (updater.status && updater.status.state !== 'idle'))
    ? renderUpdateNotice({
      command: updater.command,
      available: update ? { version: update.version } : undefined,
      selfUpdate: updater.selfUpdate,
      status: updater.status,
      csrfToken: options?.controlSessionCsrfToken,
      localSession: options?.outsideHelpLocalSession === true,
      idPrefix: 'settings-update',
    })
    : update
      ? renderUpdateNotice({ command: update.command, available: { version: update.version }, selfUpdate: false, idPrefix: 'settings-update' })
      : '';
  const updates = '<section class="setpane" id="updates"><h3 class="sect">Updates</h3>'
    + (notice || '<p class="pnote">Olympus is up to date.</p>')
    + '</section>';
  const help = '<section class="setpane" id="help"><h3 class="sect">Help</h3><p class="pnote">If something is not working, copy the system report and send it to support. It holds only system states and error codes.</p>'
    + `<div class="pickbar"><a class="btn" href="${escapeHtml(dashboardLocalPageHref('help', token))}">Copy a system report</a><a class="btn" href="https://olympusplugin.ai/support" target="_blank" rel="noopener noreferrer">Contact support</a></div></section>`;
  const proposal = renderSettingsProposal(options?.settingsProposal);
  const body = lockedGate(options) + proposal + `<div class="setlayout">${side}<div class="setmain">${agents}${models}${zkapi}${updates}${help}</div></div>`;
  return localShell({ crumb: 'Settings', tab: 'settings', meta: '', body, styles: [AGENT_CONNECT_CSS, DASHBOARD_OUTSIDE_HELP_CSS, SETTINGS_CSS, UPDATE_NOTICE_CSS], options });
}

/**
 * Settings an agent proposed (`olympus settings propose`, #1050): every
 * change with its current and proposed value, applied only by the owner's
 * click. After Apply, what was and was not saved, for a short while.
 */
function renderSettingsProposal(state: DashboardPageOptions['settingsProposal']): string {
  const proposal = state?.current;
  if (proposal) {
    const who = proposal.from ? escapeHtml(proposal.from) : 'An agent on this computer';
    // Turning on Venice judging sends every item, Private ones included, to
    // the cloud: say so on the card, as the Privacy judge dialog does.
    const judge = proposal.input.privacy_judge;
    const veniceJudge = judge?.choice === 'venice' ? `$${judge.spending_limit_dollars}` : undefined;
    const rows = proposal.rows.map(row => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${escapeHtml(row.current)}</td><td><b>${escapeHtml(row.proposed)}</b></td></tr>`).join('');
    const form = (kind: 'apply' | 'discard', label: string, primary: boolean) =>
      `<form data-settings-proposal="${kind}"><input type="hidden" name="id" value="${escapeHtml(proposal.id)}"><button type="submit" class="btn${primary ? ' primary' : ''}">${label}</button><span class="pnote" data-action-message aria-live="polite"></span></form>`;
    return `<section class="propcard" aria-label="Proposed settings" id="proposed-settings"><h3 class="sect">Proposed settings</h3>`
      + `<p>${who} proposed ${proposal.rows.length === 1 ? 'this change' : `these ${proposal.rows.length} changes`}. Nothing changes until you apply ${proposal.rows.length === 1 ? 'it' : 'them'}.</p>`
      + `<table class="proptable"><thead><tr><th scope="col">Setting</th><th scope="col">Now</th><th scope="col">Proposed</th></tr></thead><tbody>${rows}</tbody></table>`
      + (veniceJudge ? `<p class="propnote"><b>Before you apply:</b> Venice will read each item it sorts, including items it marks Private, and charge your own Venice account, up to the ${escapeHtml(veniceJudge)} limit above. Applying approves this, as Use Venice under Privacy judge does.</p>` : '')
      + `<div class="pickbar">${form('apply', 'Apply all', true)}${form('discard', 'Discard', false)}</div></section>`;
  }
  const applied = state?.lastApplied;
  if (!applied) return '';
  const rows = applied.rows.map(row => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${escapeHtml(row.proposed)}</td><td>${row.applied ? 'Applied' : `Not applied: ${escapeHtml(row.message ?? 'not saved')}`}</td></tr>`).join('');
  return `<section class="propcard" aria-label="Applied settings" id="proposed-settings"><h3 class="sect">${applied.ok ? 'Settings applied' : 'Some settings were not applied'}</h3>`
    + `<table class="proptable"><tbody>${rows}</tbody></table></section>`;
}

const SETTINGS_CSS = `
.propcard { border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin-bottom: 24px; }
.propcard .sect { margin-top: 0; }
.proptable { width: 100%; border-collapse: collapse; margin: 8px 0; }
.proptable th, .proptable td { text-align: left; padding: 8px 10px; border-top: 1px solid var(--line); vertical-align: top; }
.proptable thead th { border-top: 0; color: var(--t2); font-weight: 500; }
.propnote { margin: 8px 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; }
.propcard .pickbar { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.setlayout { display: grid; grid-template-columns: 220px 1fr; gap: 24px; align-items: start; }
.setside { display: grid; gap: 8px; position: sticky; top: 12px; }
.setside a { display: block; padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px; color: var(--t1); text-decoration: none; }
.setside a:hover, .setside a:focus-visible { border-color: var(--link); }
.setmain > .setpane { display: none; scroll-margin-top: 12px; }
.setmain > .setpane:target, .setmain:not(:has(> .setpane:target)) > .setpane:first-child { display: block; }
.setmain > .setpane > .sect:first-child { margin-top: 0; }
${SETTINGS_SECTIONS.map(section => `.setlayout:has(#${section.id}:target) .setside a[href="#${section.id}"]`).join(',\n')},
.setlayout:not(:has(.setpane:target)) .setside a:first-child { border-color: var(--link); background: var(--panel, transparent); font-weight: 600; }
.setmain .pickbar { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
@media (max-width: 760px) { .setlayout { grid-template-columns: 1fr; } .setside { position: static; grid-template-columns: 1fr 1fr; } }
`;

/** A local, content-free report using the same copy control as pairing errors. */
export function renderDashboardHelpPage(options?: DashboardPageOptions): string {
  const report = options?.systemReport;
  return localShell({ crumb: 'Help', tab: 'settings', meta: '', options, styles: [], body:
    lockedGate(options)
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
    `<dialog class="judgedialog" data-judge-dialog="${pick}" aria-labelledby="judge-dialog-${pick}"><h3 id="judge-dialog-${pick}">${escapeHtml(title)}</h3>${body}<p class="pnote" data-action-message role="status"></p>`
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
