/**
 * The local dashboard's source rows, after the ChatGPT dashboard's rules
 * (owner, 2026-10-02):
 *
 * 1. Each fact once. A source that needs the owner is one row, moved to the
 *    top, with its one fix; Needs you holds only what is not a source. The
 *    dot and the sentence carry the state, so no status word sits beside the
 *    name (screen readers still hear it).
 * 2. Colours: in progress is a yellow dot and bar, needs you a warm orange,
 *    ready green, off a hollow grey ring. Row buttons are outlined.
 * 3. Honest progress. Never "synced just now" while a source's items are still
 *    being found, read or indexed: the row shows its first unfinished stage as
 *    "<Stage> — N%, done of total <unit>" over a thin bar ("Finding items"
 *    while there is no total yet). A source that is not moving says why in one
 *    plain sentence, with its fix, and keeps an orange bar only when there is
 *    real progress to show.
 * 4. A sign-in still outstanding reads "Finish signing in to <Source> · link
 *    expires in N min", with one Open sign-in again.
 *
 * The state is the ChatGPT view model's own (chatgpt/dashboard-view-model.ts
 * buildChatGptDashboardViewModel, a pure function over the same engine view):
 * its honest status, its per-source progress and stall reason, its overall
 * progress block and its model installs. This module only decides how the
 * local pages print them and which local control fixes each row.
 */
import type { BuiltInPrivateModelView } from '../chatgpt/dashboard-view-model.ts';
import type { BuiltInTranscriptionDashboardState } from '../source-index/built-in-reasoning/transcription-model.ts';
import { buildChatGptDashboardViewModel } from '../chatgpt/dashboard-view-model.ts';
import type { DashboardViewModelV1, ModelInstall, SourceProgress } from '../chatgpt/dashboard-contract.ts';
import type { DashboardSourceAction, DashboardSourceCard, SourceDashboardViewModel } from '../source-dashboard.ts';
import { DASHBOARD_SUPPORTED_SOURCES } from '../source-dashboard.ts';
import type { WorkerCredentialDegradation } from '../credential-degradation.ts';
import {
  DASHBOARD_LOCAL_COPY as C,
  DASHBOARD_MODELS_BLOCKED_REASON,
  DASHBOARD_RECONNECT_LABEL,
  DASHBOARD_SIGNED_OUT,
  dashboardAttentionLine,
  dashboardCount,
  dashboardEtaWords,
  dashboardProviderRefusalDetail,
  dashboardProviderRefusalSentence,
  dashboardScopePending,
  dashboardStatus,
  dashboardSubLine,
  type DashboardStatus,
} from './vocabulary.ts';
import {
  DASHBOARD_CONTROL_GATE_ID,
  actionButton,
  dashboardGoogleProviderNote,
  dashboardNeedsSetupSheet,
  dashboardOAuthConnectSheet,
  escapeHtml,
  progressBar,
  rowControls,
  safeHref,
  type DashboardActionInput,
} from './components.ts';
import { dashboardSyncNowAction } from './attention.ts';
import { renderModelSetup } from './model-setup.ts';
import { dashboardCredentialProblem, dashboardHonestStatus } from './shared-status.ts';

/** The built-in models' installs, read by the worker before the render. */
export interface DashboardModelInstalls {
  /** The built-in embedding (search) model, when the embeddings lane reports one. */
  embedding?: DashboardViewModelV1['models']['embedding'];
  /** The built-in private (answer) model, when it is on for this machine. */
  privateModel?: BuiltInPrivateModelView;
  /** The built-in transcription model, when it is the transcriber on this machine. */
  transcription?: BuiltInTranscriptionDashboardState;
}

/** The owner's privacy settings, counts only (the same counts ChatGPT reads). */
export interface DashboardPrivacySummary {
  configured: boolean;
  pendingCount: number;
  ruleCount: number;
}

/** What the source rows need from the page's options. */
export interface DashboardRowOptions {
  now?: Date;
  basePath?: string;
  readOnly?: boolean;
  controlSessionCsrfToken?: string;
  controlMode?: 'standalone' | 'native';
  canWrite?: boolean;
  degradedCredentials?: readonly WorkerCredentialDegradation[];
  modelInstalls?: DashboardModelInstalls;
  /** Absent: the worker reports no privacy settings, and no Privacy row shows. */
  privacy?: DashboardPrivacySummary | 'unreadable';
}

export interface DashboardSourceRowState {
  source: DashboardSourceCard;
  /** The honest status: never Fresh while a stage is unfinished. */
  status: DashboardStatus;
  group: 'local' | 'cloud';
  /** Sorts first, orange dot, carries its one fix. */
  needsYou: boolean;
  /** Only while a stage is unfinished, or the source is not moving. */
  progress?: SourceProgress;
  /** A sign-in started for this source and still outstanding. */
  connecting?: { minutesLeft: number };
}

export interface DashboardSourceStates {
  /** Every card on the view, in view order. */
  rows: DashboardSourceRowState[];
  models: DashboardViewModelV1['models'];
  /** The sum over every connected source still working; absent once all are done. */
  progress?: DashboardViewModelV1['progress'];
  /** The engine's items that are not about a source (models, privacy). */
  otherNeeds: DashboardViewModelV1['needsYou'];
  /** The built-in transcription model, when it is the transcriber here (Mac dashboard only). */
  transcription?: BuiltInTranscriptionDashboardState;
}

const DEFAULT_BASE_PATH = '/dashboard';

/**
 * Every source's state, from the ChatGPT view model's own derivation. A card
 * the ChatGPT roster does not carry (an owner-named corpus) keeps the
 * vocabulary's status and has no progress of its own.
 */
export function dashboardSourceStates(view: SourceDashboardViewModel, options: DashboardRowOptions = {}): DashboardSourceStates {
  const now = options.now ?? new Date();
  const degraded = options.degradedCredentials ?? view.degraded_credentials;
  const engineView: SourceDashboardViewModel = degraded === view.degraded_credentials
    ? view
    : { ...view, degraded_credentials: degraded ? [...degraded] : [] };
  const privacy = options.privacy !== undefined && options.privacy !== 'unreadable' ? options.privacy : undefined;
  const v1 = buildChatGptDashboardViewModel(engineView, {
    now,
    ...(options.modelInstalls?.embedding ? { embedding: options.modelInstalls.embedding } : {}),
    ...(options.modelInstalls?.privateModel ? { privateModel: options.modelInstalls.privateModel } : {}),
    ...(privacy ? { privacy } : {}),
  });
  const engine = new Map(v1.sources.map((entry) => [entry.id, entry]));
  const rows = view.sources.map((source): DashboardSourceRowState => {
    const entry = engine.get(source.source_id);
    const connecting = connectingFor(source, now);
    // A refused sign-in or a credential problem needs the owner whatever the
    // progress says (Codex review, 2026-10-02): the row shows that sentence
    // and its reconnect, not a stage line over work that cannot finish.
    const credential = !connecting && dashboardCredentialProblem(source, degraded);
    const progress = !connecting && !credential && entry?.progress && (entry.progress.stage !== 'done' || entry.progress.stalled)
      ? entry.progress
      : undefined;
    // The same derivation ChatGPT uses (shared-status.ts): the vocabulary's
    // word held to the progress bar, so this page never says Fresh while the
    // ChatGPT dashboard says Working over the same engine state.
    const local = dashboardHonestStatus(
      dashboardStatus({ source, ...(degraded ? { degradedCredentials: degraded } : {}) }),
      progress,
    );
    let status: DashboardStatus = entry?.status ?? local;
    // The engine's view for ChatGPT never sees a provider's refusal or the
    // provider's own words (they stay on this computer), so a problem only the
    // full card shows keeps its Needs you here, unless the source is simply
    // working through an unfinished stage, which needs nothing.
    const working = progress !== undefined && progress.stage !== 'done' && !progress.stalled;
    if ((local === 'Needs you' || local === 'Failing') && status !== 'Needs you' && status !== 'Failing' && !working) {
      status = local;
    }
    if (credential) status = 'Needs you';
    // Mid-sign-in reads Needs you whatever else the card says: finishing the
    // sign-in is the owner's next step (the ChatGPT rule, for every source).
    if (connecting) status = 'Needs you';
    return {
      source,
      status,
      group: groupOf(source),
      needsYou: status === 'Needs you' || status === 'Failing',
      ...(progress ? { progress } : {}),
      ...(connecting ? { connecting } : {}),
    };
  });
  return {
    rows,
    models: v1.models,
    ...(options.modelInstalls?.transcription ? { transcription: options.modelInstalls.transcription } : {}),
    ...(v1.progress ? { progress: v1.progress } : {}),
    otherNeeds: v1.needsYou.filter((item) => !item.id.startsWith('source:')),
  };
}

function groupOf(source: DashboardSourceCard): 'local' | 'cloud' {
  const definition = DASHBOARD_SUPPORTED_SOURCES.find((entry) => entry.source_id === source.source_id);
  return definition?.connect_kind === 'local' ? 'local' : 'cloud';
}

/** A pending sign-in that has not lapsed: the minutes it has left. */
function connectingFor(source: DashboardSourceCard, now: Date): { minutesLeft: number } | undefined {
  if (source.connection.state !== 'awaiting_consent') return undefined;
  const pending = source.connection.pending;
  if (!pending) return undefined;
  const expiresAt = Date.parse(pending.expires_at);
  if (Number.isFinite(expiresAt)) {
    const left = expiresAt - now.getTime();
    return left > 0 ? { minutesLeft: Math.max(1, Math.ceil(left / 60_000)) } : undefined;
  }
  const minutes = pending.expires_in_minutes;
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
    ? { minutesLeft: Math.max(1, Math.ceil(minutes)) }
    : undefined;
}

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

export function fill(template: string, values: Record<string, string | number>): string {
  let out = template;
  for (const key of Object.keys(values)) out = out.split(`{${key}}`).join(String(values[key]));
  return out;
}

function unitWord(unit: SourceProgress['unit'], n: number): string {
  const words = C.units[unit] ?? C.units.items;
  return n === 1 ? words.one : words.many;
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** "Reading — 40%, 1,240 of 3,100 files", or "Finding items" while there is no total. */
export function dashboardSourceProgressLabel(progress: SourceProgress): string {
  if (progress.total <= 0 || progress.stage === 'done') return C.findingItems;
  return fill(C.sourceProgress, {
    stage: C.sourceStages[progress.stage],
    percent: Math.floor(Math.max(0, Math.min(100, progress.percent))),
    done: dashboardCount(progress.done),
    total: dashboardCount(progress.total),
    unit: unitWord(progress.unit, progress.total),
  });
}

/** The one pause sentence for a source that is not moving, or '' when the reason is not known. */
export function dashboardStallSentence(state: DashboardSourceRowState): string {
  const reason = state.progress?.stalled ? state.progress.stalledReason : undefined;
  if (!reason) return '';
  if (reason === 'scope_pending' && state.source.scope_selection?.kind === 'mail') return C.stalledReasons.scope_pending_mail;
  return fill(C.stalledReasons[reason], { source: state.source.label });
}

/** A stalled bar is drawn only over real progress: a known total, some of it done, a stage still open. */
function realProgress(progress: SourceProgress): boolean {
  return progress.total > 0 && progress.percent > 0 && progress.stage !== 'done';
}

/** "Finish signing in to Gmail · link expires in 8 min". */
export function dashboardConnectingLine(state: DashboardSourceRowState): string {
  if (!state.connecting) return '';
  return `${fill(C.connecting, { source: state.source.label })} · ${fill(C.linkExpires, { n: state.connecting.minutesLeft })}`;
}

/* ------------------------------------------------------------------ */
/* Fixes                                                               */
/* ------------------------------------------------------------------ */

export function dashboardControlsAvailable(options: DashboardRowOptions | undefined): boolean {
  return options?.controlMode === 'native'
    ? options.canWrite === true
    : options?.controlSessionCsrfToken !== undefined;
}

export function setupHref(basePath?: string): string {
  const path = basePath ?? DEFAULT_BASE_PATH;
  return `${path}${path.includes('?') ? '&' : '?'}setup`;
}

/** A source's detail page. */
export function detailHref(source: Pick<DashboardSourceCard, 'source_id'>, basePath?: string): string {
  const path = basePath ?? DEFAULT_BASE_PATH;
  return `${path}${path.includes('?') ? '&' : '?'}source=${encodeURIComponent(source.source_id)}`;
}

/** The Privacy editor. */
export function privacyHref(basePath?: string): string {
  const path = basePath ?? DEFAULT_BASE_PATH;
  return `${path}${path.includes('?') ? '&' : '?'}privacy`;
}

/**
 * The control a locked reader sees: the same verb, pointing at Setup's gate
 * where the controls are unlocked, with the one-line reason.
 */
export function lockedAction(label: string, basePath: string | undefined): DashboardActionInput {
  return { label, kind: 'link', href: `${setupHref(basePath)}#${DASHBOARD_CONTROL_GATE_ID}`, hint: 'unlock controls in Setup' };
}

/**
 * A provider refusal for a connect sheet: the translated sentence on top, the
 * provider's own words under How to fix. Empty when nothing was refused.
 */
export function dashboardRefusalNotice(source: DashboardSourceCard): { notice?: string; noticeDetail?: string } {
  if (!source.connection.provider_refusal) return {};
  const detail = dashboardProviderRefusalDetail(source);
  return {
    notice: dashboardProviderRefusalSentence(source),
    ...(detail === undefined ? {} : { noticeDetail: detail }),
  };
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
 * The fix for a problem row with no connect control: Sync now where the worker
 * can run one, otherwise the source page where the problem is explained. A
 * problem row never ends without a button.
 */
export function fallbackFix(
  source: DashboardSourceCard,
  options: DashboardRowOptions | undefined,
): { action: DashboardActionInput; sheet?: string } {
  const readOnly = !dashboardControlsAvailable(options);
  const sync = dashboardSyncNowAction(source, { readOnly, setupPath: setupHref(options?.basePath) });
  if (sync !== undefined) return { action: { ...sync, primary: false } };
  return { action: { label: 'See what happened', kind: 'link', href: detailHref(source, options?.basePath) } };
}

/**
 * The real control for a source the owner has to reconnect, or undefined when
 * the row's way forward is its detail page.
 *
 * A reader holding the controls gets the control itself (the connect sheet,
 * opening in place under the row); a reader who cannot call the control routes
 * gets a link to Setup's gate with the reason stated. A guided-session source
 * has no route on either path.
 */
export function dashboardReconnectAction(
  source: DashboardSourceCard,
  view: SourceDashboardViewModel,
  options: DashboardRowOptions | undefined,
): { action: DashboardActionInput; sheet?: string } | undefined {
  const action = source.connection.action;
  // A data-bearing source is here because its connection broke, so its verb is
  // the repair verb whatever the registry now calls it.
  const reconnecting = source.coverage.indexed_items > 0;
  // Connecting is refused by the worker until models are ready, so the button
  // says so instead of looking like it works.
  const blocked = view.model_setup !== undefined && !view.model_setup.ready
    ? { blockedReason: DASHBOARD_MODELS_BLOCKED_REASON }
    : {};
  if (action.kind === 'needs_setup') {
    const label = reconnecting ? DASHBOARD_RECONNECT_LABEL : action.label;
    if (!dashboardControlsAvailable(options)) return { action: lockedAction(label, options?.basePath) };
    const { sheetId, sheet } = dashboardNeedsSetupSheet(source, action, providerNote(view, action));
    return { action: { label, kind: 'none', sheet: sheetId, ...blocked }, sheet };
  }
  if (action.kind === 'none' && dashboardCredentialProblem(source, options?.degradedCredentials)) {
    // A connected source whose sign-in was refused or lapsed carries no
    // connect action of its own; its repair is the source's own connect
    // route, worded as Reconnect.
    const definition = DASHBOARD_SUPPORTED_SOURCES.find((entry) => entry.source_id === source.source_id);
    const route = definition?.connect_action;
    if (route?.kind !== 'oauth' && route?.kind !== 'api_key') return undefined;
    if (!dashboardControlsAvailable(options)) return { action: lockedAction(DASHBOARD_RECONNECT_LABEL, options?.basePath) };
    return { action: { label: DASHBOARD_RECONNECT_LABEL, kind: route.kind, source: route.source, ...blocked } };
  }
  if (action.kind !== 'oauth' && action.kind !== 'api_key') return undefined;
  const label = reconnecting && action.label === 'Connect' ? DASHBOARD_RECONNECT_LABEL : action.label;
  if (!dashboardControlsAvailable(options)) return { action: lockedAction(label, options?.basePath) };
  if (action.kind === 'oauth') {
    const connect = dashboardOAuthConnectSheet(source, action, {
      ...dashboardRefusalNotice(source),
      ...providerNote(view, action),
    });
    if (connect) return { action: { label, kind: 'none', sheet: connect.sheetId, ...blocked }, sheet: connect.sheet };
  }
  return { action: { label, kind: action.kind, source: action.source, ...blocked } };
}

/**
 * Open sign-in again, for a sign-in still outstanding. Olympus's own app
 * needs nothing first, so the button starts a fresh attempt (which replaces
 * the outstanding one) and opens the provider's page; a bring-your-own app
 * opens its sheet, where the client fields live.
 */
function reopenSignIn(
  source: DashboardSourceCard,
  view: SourceDashboardViewModel,
  options: DashboardRowOptions | undefined,
): { action?: DashboardActionInput; sheet?: string; cancel?: DashboardActionInput } {
  const action = source.connection.action;
  if (!dashboardControlsAvailable(options)) return { action: lockedAction(C.openSignInAgain, options?.basePath) };
  if (action.kind !== 'oauth') return {};
  const cancel: DashboardActionInput | undefined = action.pending_attempt === true
    ? { label: C.cancelSignIn, kind: 'oauth_cancel', source: action.source }
    : undefined;
  if (action.publisher_client === true) {
    return { action: { label: C.openSignInAgain, kind: 'oauth', source: action.source }, ...(cancel ? { cancel } : {}) };
  }
  const connect = dashboardOAuthConnectSheet(source, action, {
    ...dashboardRefusalNotice(source),
    ...providerNote(view, action),
  });
  if (connect) {
    return { action: { label: C.openSignInAgain, kind: 'none', sheet: connect.sheetId }, sheet: connect.sheet, ...(cancel ? { cancel } : {}) };
  }
  return { action: { label: C.openSignInAgain, kind: 'oauth', source: action.source }, ...(cancel ? { cancel } : {}) };
}

/** Choose folders or Choose mail: the picker, where it exists; else the source page. */
function chooseScope(
  source: DashboardSourceCard,
  view: SourceDashboardViewModel,
  options: DashboardRowOptions | undefined,
): DashboardActionInput {
  const label = source.scope_selection?.kind === 'mail' ? C.chooseMail : C.chooseFolders;
  if (!dashboardControlsAvailable(options)) return lockedAction(label, options?.basePath);
  const picker = view.folder_picker?.available === true ? view.folder_picker.path : undefined;
  if (!picker) return { label, kind: 'link', href: detailHref(source, options?.basePath) };
  return { label, kind: 'control_link', href: `${picker}${picker.includes('?') ? '&' : '?'}source_id=${encodeURIComponent(source.source_id)}` };
}

/** The row's one custody control: Unpair for a paired session, Disconnect for a broker grant. */
export function custodyAction(source: DashboardSourceCard): DashboardActionInput | undefined {
  const unpair = source.connection.unpair;
  if (unpair) {
    return {
      label: unpair.label,
      kind: 'unpair',
      quiet: true,
      source: unpair.source_id,
      confirmation: unpair.confirmation,
      providerRevocationUrl: unpair.provider_unlink_url,
      providerLinkLabel: unpair.provider_unlink_label,
    };
  }
  const disconnect = source.connection.disconnect;
  if (!disconnect) return undefined;
  return {
    label: disconnect.label,
    kind: 'disconnect',
    quiet: true,
    source: disconnect.source_id,
    confirmation: disconnect.confirmation,
    providerRevocationUrl: disconnect.provider_revocation_url,
  };
}

export interface DashboardRowFix {
  /** The row's one fix, outlined. */
  action?: DashboardActionInput;
  /** The sheet that fix opens, rendered directly under the row. */
  sheet?: string;
  /** Secondary acts for the ⋯ menu (Setup only). */
  menu: DashboardActionInput[];
}

/** The one fix a row offers, chosen from the state that holds it up. */
export function dashboardSourceRowFix(
  state: DashboardSourceRowState,
  view: SourceDashboardViewModel,
  options: DashboardRowOptions | undefined,
  withMenu: boolean,
): DashboardRowFix {
  const source = state.source;
  const menu: DashboardActionInput[] = [];
  // Setup carries the controls themselves: its own gate unlocks them, and the
  // controller holds every form disabled until it does. Home sends a locked
  // reader to that gate instead of showing a button that can only fail.
  const live: DashboardRowOptions | undefined = withMenu ? { ...options, controlMode: 'native', canWrite: true } : options;
  let fix: { action?: DashboardActionInput; sheet?: string } = {};
  if (state.connecting) {
    const reopen = reopenSignIn(source, view, live);
    fix = { ...(reopen.action ? { action: reopen.action } : {}), ...(reopen.sheet ? { sheet: reopen.sheet } : {}) };
    if (reopen.cancel && withMenu) menu.push(reopen.cancel);
  } else if (state.progress?.stalledReason === 'scope_pending' || dashboardScopePending(source)) {
    fix = { action: chooseScope(source, view, live) };
  } else if (state.needsYou || state.progress?.stalledReason === 'waiting_for_credentials') {
    fix = dashboardReconnectAction(source, view, live) ?? fallbackFix(source, options);
  } else if (state.progress?.stalledReason === 'provider_unavailable') {
    const sync = dashboardSyncNowAction(source, {
      readOnly: !dashboardControlsAvailable(options),
      setupPath: setupHref(options?.basePath),
    });
    if (sync) fix = { action: sync };
  }
  if (withMenu && !state.connecting) {
    const custody = custodyAction(source);
    if (custody) menu.push(custody);
  }
  return {
    // Row buttons are outlined: the accent belongs to the page's one primary action.
    ...(fix.action ? { action: { ...fix.action, primary: false } } : {}),
    ...(fix.sheet ? { sheet: fix.sheet } : {}),
    menu,
  };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const TONE: Readonly<Record<DashboardStatus, string>> = {
  'Fresh': 'good',
  'Working': 'run',
  'Waiting': 'off',
  'Needs you': 'warn',
  'Failing': 'bad',
  'Off': 'none',
};

function dot(tone: string): string {
  return tone === 'none'
    ? '<span class="dot hollow" aria-hidden="true"></span>'
    : `<span class="dot tone-${tone}" aria-hidden="true"></span>`;
}

/** The lines under a row's name: one sentence, then the progress block when there is one. */
function rowBody(state: DashboardSourceRowState, options: DashboardRowOptions | undefined): string {
  const source = state.source;
  const vocabulary = options?.degradedCredentials ? { degradedCredentials: options.degradedCredentials } : {};
  if (state.connecting) return `<p class="sline">${escapeHtml(dashboardConnectingLine(state))}</p>`;
  const progress = state.progress;
  if (progress) {
    const name = source.label;
    if (progress.stalled) {
      // A refused sign-in says what the provider refused; any other pause says why in one plain sentence.
      // A pause with no known reason (a first sync not started yet, say) says
      // what the card says, rather than an alarm.
      const sentence = source.connection.provider_refusal
        ? capitalise(dashboardAttentionLine(source, vocabulary))
        : dashboardStallSentence(state)
          || capitalise(state.needsYou ? dashboardAttentionLine(source, vocabulary) : dashboardSubLine(source, vocabulary))
          || `${dashboardSourceProgressLabel(progress)} · ${C.stalled}`;
      const bar = realProgress(progress)
        ? progressBar({ percent: progress.percent, label: `${name}: ${sentence}` }).replace('class="bar"', 'class="bar stalled"')
        : '';
      return `<div class="sprog stalled"><p class="sline">${escapeHtml(sentence)}</p>${bar}</div>`;
    }
    const label = dashboardSourceProgressLabel(progress);
    // No total and no measured share: a bar at any width would be a claim.
    const bar = progress.total > 0 || progress.percent > 0
      ? progressBar({ percent: progress.percent, label: `${name}: ${label}` })
      : '';
    return `<div class="sprog"><p class="sline">${escapeHtml(label)}</p>${bar}</div>`;
  }
  const line = state.needsYou ? dashboardAttentionLine(source, vocabulary) : dashboardSubLine(source, vocabulary);
  // Signed out reads the same on every row, with or without a stage behind it.
  if (line === DASHBOARD_SIGNED_OUT) {
    return `<p class="sline">${escapeHtml(fill(C.stalledReasons.waiting_for_credentials, { source: source.label }))}</p>`;
  }
  return line.trim() === '' ? '' : `<p class="sline">${escapeHtml(capitalise(line))}</p>`;
}

/**
 * One source as one row: the dot and the name, one sentence (or the stage
 * line over its bar), its one outlined fix, and on Setup the ⋯ menu. The
 * sheet the fix opens follows the row, so it opens in place.
 */
export function dashboardSourceRow(
  state: DashboardSourceRowState,
  view: SourceDashboardViewModel,
  pageOptions: DashboardRowOptions | undefined,
  withMenu: boolean,
): string {
  // The worker's credential degradations ride on the view unless the page
  // names its own: the row's sentence and fix must see the same ones its
  // status did.
  const degraded = pageOptions?.degradedCredentials ?? view.degraded_credentials;
  const options: DashboardRowOptions = { ...pageOptions, ...(degraded ? { degradedCredentials: degraded } : {}) };
  const source = state.source;
  const href = safeHref(detailHref(source, options?.basePath));
  const fix = dashboardSourceRowFix(state, view, options, withMenu);
  const tone = state.needsYou && state.status !== 'Failing' ? 'warn' : TONE[state.status];
  const name = href === undefined
    ? `<span class="name">${escapeHtml(source.label)}</span>`
    : `<a class="name" href="${escapeHtml(href)}">${escapeHtml(source.label)}</a>`;
  const spoken = state.status === 'Off' ? '' : `<span class="sr"> — ${escapeHtml(state.needsYou ? C.needsYou : state.status)}</span>`;
  // The fix and the ⋯ menu sit apart, so the menu stays top-right of the row
  // at every width while the fix wraps under the sentence on a phone.
  const controls = rowControls(source.label, [fix.action]);
  const menu = fix.menu.length > 0 ? rowControls(source.label, fix.menu) : '';
  const klass = `srow${state.needsYou ? ' need' : ''}`;
  return `<div class="${klass}" data-source-row="${escapeHtml(source.source_id)}"${href ? ` data-dashboard-href="${escapeHtml(href)}"` : ''}>`
    + `<div class="smain"><div class="shead">${dot(tone)}${name}${spoken}</div>${rowBody(state, options)}</div>`
    + (controls === '' ? '' : `<div class="sact">${controls}</div>`)
    + (menu === '' ? '' : `<div class="smenu">${menu}</div>`)
    + `</div>${fix.sheet ?? ''}`;
}

/** Rows that need the owner first; otherwise the view's own order. */
export function dashboardOrderRows(rows: readonly DashboardSourceRowState[]): DashboardSourceRowState[] {
  return [...rows.filter((row) => row.needsYou), ...rows.filter((row) => !row.needsYou)];
}

/**
 * The Sources list: one row per source, the local group first, sources that
 * need the owner at the top of each group. The group headings show only when
 * both groups have members.
 */
export function dashboardSourceList(
  rows: readonly DashboardSourceRowState[],
  view: SourceDashboardViewModel,
  options: DashboardRowOptions | undefined,
  withMenu: boolean,
): string {
  const local = dashboardOrderRows(rows.filter((row) => row.group === 'local'));
  const cloud = dashboardOrderRows(rows.filter((row) => row.group === 'cloud'));
  const both = local.length > 0 && cloud.length > 0;
  const block = (heading: string, members: readonly DashboardSourceRowState[]) => members.length === 0
    ? ''
    : `${both ? `<div class="sect sub">${escapeHtml(heading)}</div>` : ''}<div class="srows">${members
      .map((row) => dashboardSourceRow(row, view, options, withMenu)).join('')}</div>`;
  return block(C.sourcesLocal, local) + block(C.sourcesCloud, cloud);
}

/** The page-wide progress line repeats one row's bar, so it shows only while 2+ sources are working. */
export function dashboardProgressSection(states: DashboardSourceStates): string {
  const progress = states.progress;
  if (!progress) return '';
  const working = states.rows.filter((row) => row.progress && !row.progress.stalled).length;
  if (working < 2) return '';
  // A source that is not moving says so in its own row, with its fix; the
  // page-wide line is about the work that is moving.
  const text = dashboardProgressText({ ...progress, stalled: false });
  return `<div class="sect">${escapeHtml(C.progress)}</div>`
    + `<div class="sprog overall"><p class="sline">${escapeHtml(text)}</p>`
    + `${progressBar({ percent: progress.percent, label: text })}</div>`;
}

/** "First index: 40% done, 1,860 files left, about 2 hours" — an ETA only from a measured rate. */
export function dashboardProgressText(progress: NonNullable<DashboardViewModelV1['progress']>): string {
  const phase = progress.phase === 'initial' ? C.progressInitial : C.progressRefresh;
  const unknown = progress.details.length > 0 && progress.details.every((stage) => !(stage.total > 0));
  if (unknown) return `${phase}: ${C.findingItems}${progress.stalled ? `, ${C.stalled}` : ''}`;
  const parts = [fill(C.percentDone, { percent: Math.floor(progress.percent) })];
  parts.push(fill(C.left, { count: dashboardCount(progress.itemsLeft), unit: unitWord(progress.unit, progress.itemsLeft) }));
  if (typeof progress.etaSeconds === 'number' && progress.etaSeconds > 0 && !progress.stalled) {
    parts.push(dashboardEtaWords(progress.etaSeconds * 1000));
  }
  if (progress.stalled) parts.push(C.stalled);
  return `${phase}: ${parts.join(', ')}`;
}

/* ------------------------------------------------------------------ */
/* Needs you (not sources), Privacy, Models                            */
/* ------------------------------------------------------------------ */

export interface DashboardNeedItem {
  id: string;
  sentence: string;
  action: DashboardActionInput;
}

/**
 * What needs the owner that is not a source: a built-in model whose download
 * failed, models that are not ready, and privacy not yet set up. Each has its
 * one fix.
 */
export function dashboardOtherNeeds(
  states: DashboardSourceStates,
  view: SourceDashboardViewModel,
  options: DashboardRowOptions | undefined,
  page: 'home' | 'setup',
): DashboardNeedItem[] {
  const items: DashboardNeedItem[] = [];
  const controls = dashboardControlsAvailable(options);
  for (const need of states.otherNeeds) {
    if (need.id === 'model:embedding' || need.id === 'model:answers') {
      const model = need.id === 'model:embedding' ? 'embedding' : 'answers';
      const builtIn = model === 'embedding' ? states.models.embedding.kind === 'built_in' : states.models.answers?.kind === 'built_in';
      items.push({
        id: need.id,
        sentence: need.sentence,
        action: builtIn
          ? controls
            ? { label: C.modelTryAgain, kind: 'model_retry', source: model }
            : lockedAction(C.modelTryAgain, options?.basePath)
          : { label: C.seeModels, kind: 'link', href: `${setupHref(options?.basePath)}#models` },
      });
    } else if (need.id === 'privacy:setup' && page === 'home') {
      items.push({
        id: need.id,
        sentence: C.privacy.setUpSentence,
        action: { label: C.privacy.setUp, kind: 'link', href: privacyHref(options?.basePath) },
      });
    }
  }
  // Models that block every connection are a blocker on Setup; Home names it once, here.
  if (page === 'home' && view.model_setup !== undefined && !view.model_setup.ready
    && !items.some((item) => item.id === 'model:embedding')) {
    items.unshift({
      id: 'models:setup',
      sentence: C.modelsNotReady,
      action: { label: C.seeModels, kind: 'link', href: `${setupHref(options?.basePath)}#models` },
    });
  }
  return items;
}

export function dashboardNeedsSection(items: readonly DashboardNeedItem[]): string {
  if (items.length === 0) return '';
  return `<div class="sect">${escapeHtml(C.needsYou)}</div><div class="srows">${items.map((item) =>
    `<div class="srow need" data-need="${escapeHtml(item.id)}"><div class="smain"><div class="shead">${dot('warn')}`
    + `<span class="sneed">${escapeHtml(item.sentence)}</span></div></div>`
    + `<div class="sact">${actionButton({ ...item.action, primary: false })}</div></div>`).join('')}</div>`;
}

/**
 * The Privacy row on Setup: "Your description · N always-private rules" and
 * Edit, or the one ask to set it up. Absent when the worker reports nothing.
 */
export function dashboardPrivacySection(options: DashboardRowOptions | undefined): string {
  const privacy = options?.privacy;
  if (privacy === undefined) return '';
  const href = privacyHref(options?.basePath);
  let lines: string[];
  let action: DashboardActionInput;
  if (privacy === 'unreadable') {
    lines = [`<p class="sline strong">${escapeHtml(C.privacy.unreadable)}</p>`];
    action = { label: C.privacy.edit, kind: 'link', href };
  } else if (!privacy.configured) {
    lines = [`<p class="sline strong">${escapeHtml(C.privacy.setUpSentence)}</p>`];
    action = { label: C.privacy.setUp, kind: 'link', href };
  } else {
    const rules = Math.max(0, Math.floor(privacy.ruleCount));
    const words = rules === 0 ? C.privacy.row.none : rules === 1 ? C.privacy.row.one : C.privacy.row.many;
    lines = [`<p class="sline strong">${escapeHtml(fill(words, { n: dashboardCount(rules) }))}</p>`];
    action = { label: C.privacy.edit, kind: 'link', href };
  }
  if (privacy !== 'unreadable' && privacy.pendingCount > 0) {
    const pending = Math.floor(privacy.pendingCount);
    lines.push(`<p class="sline">${escapeHtml(fill(pending === 1 ? C.privacy.pending.one : C.privacy.pending.many, { n: dashboardCount(pending) }))}</p>`);
  }
  return `<div class="sect" id="privacy">${escapeHtml(C.privacy.section)}</div>`
    + `<div class="srows"><div class="srow nodot" data-privacy-row><div class="smain">${lines.join('')}</div>`
    + `<div class="sact">${actionButton(action)}</div></div></div>`;
}

interface InstallLine {
  which: 'search' | 'answers' | 'transcription';
  state: 'downloading' | 'verifying' | 'failed';
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  reason: keyof typeof C.modelInstallReasons;
}

function installLine(
  which: InstallLine['which'],
  install: ModelInstall | DashboardViewModelV1['models']['embedding'] | BuiltInTranscriptionDashboardState | undefined,
): InstallLine | undefined {
  if (!install) return undefined;
  if (install.state !== 'downloading' && install.state !== 'verifying' && install.state !== 'failed') return undefined;
  const reason = install.failedReason && install.failedReason in C.modelInstallReasons ? install.failedReason : 'unknown';
  return {
    which,
    state: install.state,
    ...(typeof install.percent === 'number' && Number.isFinite(install.percent) ? { percent: install.percent } : {}),
    ...(typeof install.bytesDone === 'number' ? { bytesDone: install.bytesDone } : {}),
    ...(typeof install.bytesTotal === 'number' && install.bytesTotal > 0 ? { bytesTotal: install.bytesTotal } : {}),
    reason,
  };
}

/** "1.2 of 3.0 GB", in the total's unit. */
export function dashboardInstallBytes(done: number, total: number): string {
  const units: Array<[number, string]> = [[1e12, 'TB'], [1e9, 'GB'], [1e6, 'MB'], [1e3, 'KB']];
  const [scale, unit] = units.find(([size]) => total >= size) ?? [1, 'bytes'];
  const shown = (value: number) => (scale === 1 ? String(Math.round(value)) : (value / scale).toFixed(1));
  return fill(C.modelInstallBytes, { done: shown(Math.min(done, total)), total: `${shown(total)} ${unit}` });
}

function installHtml(line: InstallLine): string {
  const model = C.modelNames[line.which];
  if (line.state === 'failed') {
    return `<div class="minstall failed"><p class="sline">${escapeHtml(fill(C.modelInstallFailed, { model, reason: C.modelInstallReasons[line.reason] }))}</p></div>`;
  }
  let text: string;
  if (line.state === 'verifying') text = fill(C.modelInstallVerifying, { model });
  else {
    const parts = [fill(C.modelInstallDownloading, { model })];
    if (line.percent !== undefined) parts.push(`${Math.floor(Math.max(0, Math.min(100, line.percent)))}%`);
    if (line.bytesTotal !== undefined && line.bytesDone !== undefined) parts.push(dashboardInstallBytes(line.bytesDone, line.bytesTotal));
    text = parts.join(' · ');
  }
  const bar = line.percent === undefined ? '' : progressBar({ percent: line.percent, label: text });
  return `<div class="minstall"><p class="sline">${escapeHtml(text)}</p>${bar}</div>`;
}

function modelStateWord(state: ModelInstall['state']): string {
  if (state === 'ready') return C.modelReady;
  if (state === 'failed') return C.modelNotWorking;
  if (state === 'verifying') return C.modelChecking;
  return C.modelGettingReady;
}

/** The install lines under Models: search, answers, then transcription. */
function modelInstallLines(states: DashboardSourceStates): InstallLine[] {
  return [
    installLine('search', states.models.embedding),
    installLine('answers', states.models.answers?.install),
    installLine('transcription', states.transcription),
  ].filter((line): line is InstallLine => line !== undefined);
}

/** "Models — Built-in · Ready", "… · Getting ready" or "… · Needs you". */
export function dashboardModelsSummary(states: DashboardSourceStates, view: SourceDashboardViewModel): string {
  const models = states.models;
  const kind = models.embedding.kind === 'built_in' ? C.modelBuiltIn : C.modelCustom;
  const installs = modelInstallLines(states);
  let overall: string = C.modelReady;
  if (installs.some((line) => line.state === 'failed') || (view.model_setup !== undefined && !view.model_setup.ready)
    || models.embedding.state === 'failed') {
    overall = C.modelNeedsYou;
  } else if (installs.length > 0) {
    overall = C.modelGettingReady;
  }
  return `${C.models} — ${kind} · ${overall}`;
}

/**
 * The Models row: one line that opens to the model setup, with each built-in
 * model's install shown under it without opening (status only: keys are
 * entered in the setup inside, as before). Open by itself while models need
 * the owner.
 */
export function dashboardModelsSection(states: DashboardSourceStates, view: SourceDashboardViewModel): string {
  const models = states.models;
  const installs = modelInstallLines(states);
  const summary = dashboardModelsSummary(states, view);
  const open = view.model_setup !== undefined && !view.model_setup.ready;
  const search = `${models.embedding.kind === 'built_in' ? C.modelBuiltIn : C.modelCustom} · ${modelStateWord(models.embedding.state)}`;
  const answers = models.answers
    ? `${models.answers.label} · ${models.answers.ready ? C.modelReady : models.answers.install ? modelStateWord(models.answers.install.state) : C.modelNotReady}`
    : '';
  const transcription = states.transcription
    ? states.transcription.state === 'not_needed'
      ? C.modelNotNeededNoAudio
      : `${C.modelBuiltIn} · ${modelStateWord(states.transcription.state)}`
    : '';
  const body = `<ul class="mlist"><li>${escapeHtml(`${C.modelSearch}: ${search}`)}</li>`
    + (answers ? `<li>${escapeHtml(`${C.modelAnswers}: ${answers}`)}</li>` : '')
    + (transcription ? `<li>${escapeHtml(`${C.modelTranscription}: ${transcription}`)}</li>` : '')
    + `</ul>${renderModelSetup(view.model_setup, { heading: false })}`;
  return `<section class="modelsrow" id="models" aria-label="${escapeHtml(C.models)}">`
    + `<details class="models" data-poll-key="models"${open ? ' open' : ''}><summary>${escapeHtml(summary)}</summary>`
    + `<div class="modelsbody">${body}</div></details>`
    + (installs.length > 0 ? `<div class="minstalls">${installs.map(installHtml).join('')}</div>` : '')
    + `</section>`;
}
