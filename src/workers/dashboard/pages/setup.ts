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
import type { WorkerCredentialDegradation } from '../../credential-degradation.ts';
import { dashboardAttentionLine, dashboardIsConnectedSource, dashboardSetupMeta, dashboardStatus } from '../vocabulary.ts';
import {
  attentionRow,
  clipboardScript,
  dashboardNeedsSetupSheet,
  dashboardOAuthConnectSheet,
  connectorSheet,
  controlScript,
  dashboardControlGate,
  escapeHtml,
  pageShell,
  safeExternalHref,
  setupRow,
  type DashboardActionInput,
} from '../components.ts';
import { detailHref, type DashboardPageOptions } from './home.ts';
import { DASHBOARD_NAV_CSS, renderDashboardNav } from '../nav.ts';

const CONNECTOR_SHEET_ID = 'connector-sheet';

const CONNECTOR_SHEET_HEADING = 'Build a connector with your agent';
// The playbook the prompt names is a repo-development skill: it is deliberately
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
  'Read skills/create-connector/SKILL.md and follow it exactly. Start by asking me its Leg 0 '
  + 'identity questions, then build leg by leg — connector contract, corpus registry, store mount, '
  + 'scheduler tasks, request budget, tests, host enablement — using the Readwise and Drive '
  + 'connectors as reference stampings. The one rule: SourceConnector is the only per-source code; '
  + 'everything downstream is shared. Keep the required CI check green.',
].join('\n');

const SETUP_JOURNEY_CSS = `.setupsummary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 18px; }
.setupsummary .sumcard { min-width: 0; border: 1px solid var(--line2); border-radius: 8px; padding: 11px 12px; background: var(--panel); }
.setupsummary b { display: block; color: var(--t4); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 4px; }
.setupsummary span { display: block; color: var(--t2); font-size: 13px; line-height: 1.3; }
.pilotnote { border: 1px solid var(--warn-line); background: var(--warn-bg); border-radius: 8px; color: var(--t3); font-size: 12px; padding: 10px 12px; margin-bottom: 18px; }
.pilotnote b { color: var(--warn); }
@media (max-width: 700px) { .setupsummary { grid-template-columns: 1fr; } }`;

type SetupGroupId = 'needs_you' | 'working' | 'connecting' | 'fresh' | 'not_connected';

interface SetupGroupDefinition {
  id: SetupGroupId;
  heading: string;
  attention: boolean;
}

// The mockup's first-run headings "Connecting" and "Not connected" sit outside
// the closed six-word status vocabulary; the owner's 2026-08-18 ruling settled
// the second of them — this page offers options rather than reporting a
// deficit, so the group of sources nobody has connected is "Available to
// connect". "Connecting" stays: it names a handshake in flight, which is a
// first-run fact and not a status word about a source.
const SETUP_GROUPS: readonly SetupGroupDefinition[] = [
  { id: 'needs_you', heading: 'Needs you', attention: true },
  { id: 'working', heading: 'Working', attention: false },
  { id: 'connecting', heading: 'Connecting', attention: false },
  { id: 'fresh', heading: 'Fresh', attention: false },
  { id: 'not_connected', heading: 'Available to connect', attention: false },
];

export function renderDashboardSetupPage(
  view: SourceDashboardViewModel,
  options?: DashboardPageOptions,
): string {
  const degraded = options?.degradedCredentials ?? view.degraded_credentials;
  const grouped = groupSources(view.sources, degraded);
  const pilotNote = renderGooglePilotNote(view);
  const sections = SETUP_GROUPS
    .map((group) => renderGroup(group, grouped[group.id], degraded, options?.basePath))
    .filter((section) => section.length > 0);
  const body = [
    renderDashboardNav('setup', {
      ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
    }),
    dashboardControlGate({ connected: options?.controlSessionCsrfToken !== undefined }),
    renderSetupSummary(view),
    // Above every Google row, because Google raises its unverified-app screen
    // only after the reader has already pressed Connect.
    ...(pilotNote ? [pilotNote] : []),
    ...sections,
    connectorRow(),
    connectorSheet({
      id: CONNECTOR_SHEET_ID,
      heading: CONNECTOR_SHEET_HEADING,
      intro: CONNECTOR_SHEET_INTRO,
      promptText: CONNECTOR_PROMPT,
      copyButtonLabel: CONNECTOR_SHEET_COPY_LABEL,
    }),
  ].join('\n');
  return pageShell({
    title: 'Olympus',
    // The vocabulary's shared count — the same predicate home uses — so this
    // header can never disagree with home's over the same view. The degraded
    // list rides along because it is part of that predicate: a source whose
    // credential is unavailable is grouped under Needs you below, and the
    // header must not count it as connected.
    meta: dashboardSetupMeta(view, degraded ? { degradedCredentials: degraded } : {}),
    // "Olympus / Setup", like every page but home (owner note, 2026-09-02).
    crumb: 'Setup',
    ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
    body,
    scripts: [
      clipboardScript(),
      controlScript({ csrfToken: options?.controlSessionCsrfToken }),
    ],
    poll: {
      unlocked: options?.controlSessionCsrfToken !== undefined,
      ...(options?.controlSessionCsrfToken === undefined ? {} : { controlSessionCsrfToken: options.controlSessionCsrfToken }),
    },
    styles: [DASHBOARD_NAV_CSS, SETUP_JOURNEY_CSS],
  });
}

function renderSetupSummary(view: SourceDashboardViewModel): string {
  const ready = view.summary.answer_ready_sources;
  const connected = view.sources.filter(dashboardIsConnectedSource).length;
  // Two counts with two names, because they measure different things: a
  // connected source is syncing; an answer-ready one can already be cited.
  // "0 sources ready" beside four Fresh cards read as a contradiction
  // (owner note, 2026-09-01).
  const line = `${ready} answer-ready · ${connected} connected`;
  return `<div class="setupsummary" aria-label="Setup summary">`
    + `<div class="sumcard"><b>Security preset</b><span>Configured</span></div>`
    + `<div class="sumcard"><b>Sources</b><span>${escapeHtml(line)}</span></div>`
    + `</div>`;
}

/**
 * The v0.4 shared-OAuth decision: the packaged pilot client is published but
 * unverified, and this page — the one carrying the Connect button — is where
 * that is named, so the reader meets the fact before Google's own interstitial
 * rather than after it.
 *
 * Only the shared client raises the warning. An install running the advanced
 * BYO path consents to the reader's own Google app and has nothing to be told,
 * so it gets no note: the reviewed design's shared-client-is-the-normal-journey
 * ruling leaves the default page unscolded.
 */
function renderGooglePilotNote(view: SourceDashboardViewModel): string {
  const pilot = view.google_pilot;
  if (pilot?.mode !== 'shared_pilot') return '';
  return `<div class="pilotnote"><b>Shared Google pilot client:</b> ${escapeHtml(pilot.warning)} `
    + `Gmail and Drive request their read scopes separately.</div>`;
}

function groupSources(
  sources: readonly DashboardSourceCard[],
  degraded: readonly WorkerCredentialDegradation[] | undefined,
): Record<SetupGroupId, DashboardSourceCard[]> {
  const grouped: Record<SetupGroupId, DashboardSourceCard[]> = {
    needs_you: [],
    working: [],
    connecting: [],
    fresh: [],
    not_connected: [],
  };
  for (const source of sources) grouped[setupGroupOf(source, degraded)].push(source);
  return grouped;
}

/**
 * The vocabulary is consulted before the connection-state switch so this page
 * can never print a calm heading over a source home calls broken: a synced
 * card with a degraded credential or a needs-attention answer lane is
 * Needs you here too. The awaiting-consent row keeps its own Connecting group
 * — mid-handshake is this page's subject, not a fault.
 */
function setupGroupOf(
  source: DashboardSourceCard,
  degraded: readonly WorkerCredentialDegradation[] | undefined,
): SetupGroupId {
  if (source.connection.state !== 'awaiting_consent') {
    const status = dashboardStatus({ source, ...(degraded ? { degradedCredentials: degraded } : {}) });
    if (status === 'Needs you' || status === 'Failing') return 'needs_you';
  }
  switch (source.connection.state) {
    case 'reauth_required':
      return 'needs_you';
    case 'syncing':
    case 'waiting_for_first_sync':
      return 'working';
    case 'awaiting_consent':
      return 'connecting';
    case 'connected':
    case 'synced':
      return 'fresh';
    case 'not_connected':
    case 'needs_setup':
      return 'not_connected';
  }
}

function renderGroup(
  group: SetupGroupDefinition,
  sources: readonly DashboardSourceCard[],
  degraded: readonly WorkerCredentialDegradation[] | undefined,
  basePath: string | undefined,
): string {
  if (sources.length === 0) return '';
  const rows = sources
    .map((source) => (
      group.id === 'not_connected' ? renderSetupRow(source) : renderStateRow(group, source, degraded, basePath)))
    .join('\n');
  return `${sectionHeading(group.heading, sources.length, group.attention)}\n${rows}`;
}

function sectionHeading(heading: string, count: number, attention: boolean): string {
  const marker = attention ? '▲ ' : '';
  return `<div class="sect${attention ? ' attn' : ''}">${marker}${heading} — ${count}</div>`;
}

/**
 * A row for a source that is already engaged: state line, the way to act, and
 * always a click-through to its detail page — home's rule, so a reader sent
 * here by a degradation link never lands on a dead end.
 */
function renderStateRow(
  group: SetupGroupDefinition,
  source: DashboardSourceCard,
  degraded: readonly WorkerCredentialDegradation[] | undefined,
  basePath: string | undefined,
): string {
  const why = stateLine(group.id, source, degraded);
  const href = detailHref(source, basePath);
  const action = source.connection.action;
  // A Needs-you source whose app key was never registered has the same real
  // path forward the Available-to-connect group offers — the sheet with the
  // copyable prompt and the client-key form the oauth start route accepts —
  // so it gets the same sheet, not a bare row. This is exactly where home's
  // "Set up" degradation link sends the reader.
  if (group.id === 'needs_you' && action.kind === 'needs_setup') {
    const { sheetId, sheet } = dashboardNeedsSetupSheet(source, action);
    const disconnect = custodyAction(source);
    const row = attentionRow({
      label: source.label,
      attention: group.attention,
      href,
      ...(why ? { why } : {}),
      // Same verb home uses for a data-bearing source: the owner is repairing
      // a connection they already made, not setting up a new one.
      action: { label: source.coverage.indexed_items > 0 ? 'Reauthenticate' : action.label, kind: 'none', sheet: sheetId, primary: true },
      ...(disconnect ? { secondaryAction: disconnect } : {}),
    });
    return `${row}\n${sheet}`;
  }
  // A source with a key on file gets the same sheet rather than a bare button:
  // the redirect URI it must register lives there, its client id is editable
  // there, and a pending attempt is cancellable there. The Connecting group's
  // row had NO control at all before this — the reader could only wait out the
  // ten-minute record (owner, 2026-09-03).
  if ((group.id === 'needs_you' || group.id === 'connecting') && action.kind === 'oauth') {
    const connect = dashboardOAuthConnectSheet(source, action, {
      ...(source.connection.provider_refusal ? { notice: source.connection.provider_refusal.reason } : {}),
    });
    if (connect) {
      const secondary = group.id === 'connecting' ? cancelAction(action) : custodyAction(source);
      const row = attentionRow({
        label: source.label,
        attention: group.attention,
        href,
        ...(why ? { why } : {}),
        action: { label: action.label, kind: 'none', sheet: connect.sheetId, primary: true },
        ...(secondary ? { secondaryAction: secondary } : {}),
      });
      return `${row}\n${connect.sheet}`;
    }
  }
  const control = group.id === 'needs_you'
    ? connectAction(source, true)
    : group.id === 'working' || group.id === 'fresh'
      ? custodyAction(source)
      : undefined;
  const disconnect = group.id === 'needs_you' ? custodyAction(source) : undefined;
  return attentionRow({
    label: source.label,
    attention: group.attention,
    href,
    ...(why ? { why } : {}),
    ...(control ? { action: control } : {}),
    ...(disconnect ? { secondaryAction: disconnect } : {}),
  });
}

function renderSetupRow(source: DashboardSourceCard): string {
  const action = source.connection.action;
  if (action.kind === 'guided_session') {
    const sheetId = `agent-${source.source_id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
    const row = setupRow({
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
    const { sheetId, sheet } = dashboardNeedsSetupSheet(source, action);
    const link = keyLocationLink(action.instructions);
    const row = setupRow({
      label: source.label,
      blurb: action.instructions.plain_intro,
      action: { label: action.label, kind: 'none', sheet: sheetId },
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
      ...(source.connection.provider_refusal ? { notice: source.connection.provider_refusal.reason } : {}),
    });
    if (connect) {
      const row = setupRow({
        label: source.label,
        blurb: setupBlurb(source),
        action: { label: action.label, kind: 'none', sheet: connect.sheetId },
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
    blurb: setupBlurb(source),
    action: connectAction(source, false) ?? { label: actionStateLabel(source), kind: 'none' },
    ...(link === undefined ? {} : { blurbLink: link }),
  });
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

/**
 * The row's one line. Every part reads a field the view model really carries:
 * a first ingest has a count but no total at the provider, so it states what
 * has landed rather than a fraction of an unknown whole.
 */
function stateLine(
  group: SetupGroupId,
  source: DashboardSourceCard,
  degraded: readonly WorkerCredentialDegradation[] | undefined,
): string {
  if (group === 'working') return workingLine(source);
  if (group === 'connecting') return connectingLine(source);
  if (group === 'needs_you') {
    // The vocabulary's reason line, so a degraded credential or stalled answer
    // lane states its actual cause instead of the bare connection label.
    const line = dashboardAttentionLine(source, degraded ? { degradedCredentials: degraded } : {});
    if (line !== '') return line;
  }
  return source.connection.label;
}

function workingLine(source: DashboardSourceCard): string {
  if (source.connection.state === 'waiting_for_first_sync') return source.connection.label;
  const firstIngest = source.freshness.hours === undefined;
  const parts = [firstIngest ? 'first ingest' : 'syncing'];
  if (source.coverage.indexed_items > 0) parts.push(`${formatCount(source.coverage.indexed_items)} indexed so far`);
  const eta = source.progress?.eta_minutes;
  if (eta !== undefined && eta > 0) parts.push(`~${formatDuration(eta)} left`);
  return parts.join(' · ');
}

function connectingLine(source: DashboardSourceCard): string {
  const line = `waiting for you to approve in the ${source.label} tab`;
  const minutes = source.connection.pending?.expires_in_minutes;
  return minutes !== undefined && minutes > 0
    ? `${line} · expires in ${formatDuration(minutes)}`
    : line;
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

/**
 * Abandon a consent attempt that is still pending.
 *
 * Quiet, and only where an attempt actually exists: it is the way out of a
 * handshake the provider refused or the owner walked away from, which the page
 * previously had no control for at all.
 */
function cancelAction(
  action: Extract<DashboardSourceAction, { kind: 'oauth' }>,
): DashboardActionInput | undefined {
  if (action.pending_attempt !== true) return undefined;
  return { label: 'Cancel', kind: 'oauth_cancel', quiet: true, source: action.source };
}

/**
 * The row's one custody control: Unpair for a paired session, Disconnect for a
 * broker grant.
 *
 * The view model attaches exactly one of the two, so this is a selection and
 * never a choice: a paired chat source has no broker credential to disconnect,
 * and a broker source has no pairing session to unpair.
 */
function custodyAction(source: DashboardSourceCard): DashboardActionInput | undefined {
  return unpairAction(source) ?? disconnectAction(source);
}

function unpairAction(source: DashboardSourceCard): DashboardActionInput | undefined {
  const unpair = source.connection.unpair;
  if (!unpair) return undefined;
  return {
    label: unpair.label,
    kind: 'unpair',
    // Quiet for the same reason Disconnect is: it is the one act on a healthy
    // row that nobody wants by default.
    quiet: true,
    source: unpair.source_id,
    confirmation: unpair.confirmation,
    providerRevocationUrl: unpair.provider_unlink_url,
    providerLinkLabel: unpair.provider_unlink_label,
  };
}

function disconnectAction(source: DashboardSourceCard): DashboardActionInput | undefined {
  const disconnect = source.connection.disconnect;
  if (!disconnect) return undefined;
  return {
    label: disconnect.label,
    kind: 'disconnect',
    // Quiet by design (owner note, 2026-09-01): on a healthy row this was the
    // only button, so the loudest thing on the page was the one act nobody
    // wants by default. Connect and Reauthenticate stay primary.
    quiet: true,
    source: disconnect.source_id,
    confirmation: disconnect.confirmation,
    providerRevocationUrl: disconnect.provider_revocation_url,
  };
}

/** The last row: no source behind it, so its button opens the sheet instead. */
function connectorRow(): string {
  return setupRow({
    label: CONNECTOR_ROW_LABEL,
    blurb: CONNECTOR_ROW_BLURB,
    action: { label: CONNECTOR_ROW_BUTTON_LABEL, kind: 'none', sheet: CONNECTOR_SHEET_ID },
  });
}

function formatCount(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDuration(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole}m`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
