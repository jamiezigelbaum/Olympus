/**
 * Outside help: the Mac dashboard card that turns consults on (design
 * docs/design/frontier-consult-lane.md §A.9, §A.10, §A.14, stage C5). The
 * card's facts come from the worker's adapter (email-source/dashboard-consult.ts)
 * as content-free codes and counts; this module holds the shapes, the words
 * and the inert markup. The page is served only to a reader holding the
 * local dashboard's control session (pages/outside-help.ts): the native
 * OpenClaw and ChatGPT surfaces get one sentence, never the controls.
 *
 * Content-free by construction: no question, reply, key or daemon
 * configuration is ever in the status, so none can reach the page. The one
 * exception is the writer check's result: questions the owner's model wrote
 * for the check's invented cases (core/consult-writer-check.ts), shown so the
 * owner can judge the model. Nothing in them is the owner's.
 */
import type { ConsultDomainPacks, ConsultLanguage, ConsultLevel } from '../../core/consult-gate.ts';
import type { ZkapiConsultErrorCode } from '../../core/consult-transport-zkapi.ts';
import type { ConsultWriterCheckReport } from '../../core/consult-writer-check.ts';
import { ZKAPI_RISK_ACKNOWLEDGEMENTS } from '../../core/zkapi-consult-settings.ts';
import { escapeHtml, escapeScriptJson } from './components.ts';
import { DASHBOARD_OUTSIDE_HELP_COPY as W } from './vocabulary.ts';
import { fill } from './vocabulary.ts';
import {
  DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH,
  DASHBOARD_OUTSIDE_HELP_TOOLS_COPY,
  outsideHelpToolsNeedAttention,
  renderOutsideHelpTools,
  renderOutsideHelpToolsFix,
  renderOutsideHelpToolsScript,
  type DashboardOutsideHelpTools,
} from './outside-help-tools.ts';

/** How Standard prepares a question (consult-settings.ts ConsultStandardMode; not imported: the settings module stays off the page renderer). */
export type DashboardOutsideHelpStandardMode = 'as_written' | 'light_cleanup' | 'custom';

/** One word for the card's state line. */
export interface DashboardOutsideHelpSummary {
  /** `needs_acceptance`: on, but paused until the current statements are accepted. `blocked`: on, but another problem stops a question. */
  readonly state: 'off' | 'on' | 'invalid' | 'route_not_configured' | 'fence_held' | 'needs_acceptance' | 'blocked';
}

export interface DashboardOutsideHelpLanguage {
  readonly language: ConsultLanguage;
  readonly pack: string;
  /** The pack file's state: 'verified' is installed. */
  readonly state: string;
  readonly installed: boolean;
}

export interface DashboardOutsideHelpReadiness {
  readonly ready: boolean;
  readonly blockers: readonly ZkapiConsultErrorCode[];
  readonly daemonFound: boolean;
  readonly daemonVersion?: string;
  /** Whether Olympus starts a Tor client per consult, or the daemon goes direct. */
  readonly torMode: 'per_consult' | 'off';
  readonly torFound: boolean;
  readonly apiKeyConfigured: boolean;
  readonly expiry: { readonly state: 'unknown' | 'invalid' | 'active' | 'expired'; readonly daysLeft?: number; readonly expiryDate?: string };
  readonly requestsToday: { readonly count: number; readonly cap?: number };
  readonly spendToday: { readonly reservedUsd: number; readonly capUsd?: number };
  readonly fences: ReadonlyArray<{ readonly scope: string; readonly at: string; readonly thisWallet: boolean }>;
  readonly routeLabel: string;
  readonly lastSession?: { readonly at: string; readonly result: string };
}

export type DashboardOutsideHelpRoute =
  | { readonly state: 'not_configured'; readonly policyWritable: boolean }
  | {
    readonly state: 'configured';
    readonly profileId: string;
    readonly model: string;
    readonly policyWritable: boolean;
    /** The profile's key reference (`env:NAME` or `store:name`), never the key. */
    readonly secretRef: string;
    readonly acknowledgements: { readonly version: number; readonly accepted: readonly string[]; readonly complete: boolean };
    readonly fundingDate?: string;
    readonly depositUsd?: number;
    readonly dailyRequestCap?: number;
    readonly dailySpendCapUsd?: number;
    readonly readiness?: DashboardOutsideHelpReadiness;
    /** The readiness probe itself failed; the card says so instead of guessing. */
    readonly readinessUnavailable?: boolean;
  };

/**
 * Who writes the outside question (owner decision 2026-10-10): the built-in
 * model, or the owner's own model server; the zkAPI model for questions from
 * ChatGPT and the one for questions from Claude; and the writer check, run
 * only on the owner's click.
 */
export interface DashboardOutsideHelpWriter {
  /** The owner's own writer; absent: the built-in model writes. The key itself is never here. */
  readonly choice?: { readonly baseUrl: string; readonly model: string; readonly secretRef?: string; readonly keyPresent?: boolean };
  readonly chatgptFrontierModel?: string;
  /** The model ChatGPT questions go to now (the choice, else Claude Sonnet). */
  readonly effectiveChatgptModel?: string;
  readonly claudeFrontierModel?: string;
  /** The model questions from Claude (Claude Code, Claude Desktop) go to now (the choice, else the OpenAI default). */
  readonly effectiveClaudeModel?: string;
  /** The ChatGPT model was missing from the live zkAPI listing at the last consult. */
  readonly modelProblem?: { readonly at: string; readonly message: string };
  /** Whether this Olympus can run the check. */
  readonly testAvailable: boolean;
  readonly check:
    | { readonly state: 'idle' }
    | { readonly state: 'running'; readonly done: number; readonly total: number }
    | { readonly state: 'done'; readonly at: string; readonly report: ConsultWriterCheckReport }
    | { readonly state: 'failed'; readonly message: string };
}

export interface DashboardOutsideHelpStatus {
  readonly settings: {
    readonly state: 'off' | 'on' | 'invalid';
    /** 0 when there is no valid file. */
    readonly revision: number;
    readonly languages: readonly ConsultLanguage[];
    readonly domains: ConsultDomainPacks;
    readonly strict: boolean;
    /** What zkAPI may send: "unnamed" (Standard: the situation without names) or "general" (Strict: general questions only). */
    readonly level: ConsultLevel;
    readonly invalidReason?: string;
  };
  readonly route: DashboardOutsideHelpRoute;
  readonly languages: readonly DashboardOutsideHelpLanguage[];
  /** A policy write happened and the worker could not restart itself. */
  readonly restartPending: boolean;
  /** Tor and zkapi-clientd: where each was found, and the one-click install's progress (outside-help-tools.ts). */
  readonly tools?: DashboardOutsideHelpTools;
  /** Who writes the outside question, and the writer check. */
  readonly writer?: DashboardOutsideHelpWriter;
  /** How Standard prepares a question (owner decision 2026-10-10). */
  readonly standard?: {
    readonly mode: DashboardOutsideHelpStandardMode;
    /** The light-cleanup instruction, shown in full. */
    readonly preset: string;
    /** The user's own instruction, when saved. */
    readonly instruction?: string;
    readonly maxChars: number;
  };
}

/** The query flag the page answers to; same /dashboard path and auth as every page. */
export const DASHBOARD_OUTSIDE_HELP_QUERY_PARAM = 'outside-help';

/** The worker's four control routes, in one place for the page, the HTTP boundary and the public route list. */
export const DASHBOARD_OUTSIDE_HELP_PATHS = {
  /** The local-only session mint (workers/http.ts); not a consult route itself. */
  unlock: '/dashboard/control/session/local',
  enable: '/dashboard/consult',
  route: '/dashboard/consult/route',
  addRoute: '/dashboard/consult/route/add',
  recover: '/dashboard/consult/recover',
  abandon: '/dashboard/consult/abandon',
  installTools: DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH,
  /** The owner's own writer model and the zkAPI models for questions from ChatGPT and from Claude (consult.json). */
  writer: '/dashboard/consult/writer',
  /** How Standard prepares a question (consult.json `standardMode`, `standardInstruction`). */
  standard: '/dashboard/consult/standard',
  /** The writer check: started only by the owner's click; sends nothing to zkAPI. */
  writerTest: '/dashboard/consult/writer/test',
} as const;

export function outsideHelpHref(basePath = '/dashboard'): string {
  return `${basePath}${basePath.includes('?') ? '&' : '?'}${DASHBOARD_OUTSIDE_HELP_QUERY_PARAM}`;
}

/** The one-line state the card opens with. */
export function outsideHelpStateLine(summary: DashboardOutsideHelpSummary): string {
  return W.state[summary.state];
}

export function summaryOf(status: DashboardOutsideHelpStatus): DashboardOutsideHelpSummary {
  if (status.settings.state === 'invalid') return { state: 'invalid' };
  if (status.route.state === 'not_configured') return { state: 'route_not_configured' };
  const readiness = status.route.readiness;
  if (readiness && readiness.fences.length > 0) return { state: 'fence_held' };
  if (status.settings.state === 'on' && !status.route.acknowledgements.complete) return { state: 'needs_acceptance' };
  // On, but something else stops a question: said as paused, the fix below.
  if (status.settings.state === 'on' && (status.route.readinessUnavailable || (readiness && readiness.blockers.some((code) => code !== 'acknowledgements_incomplete')))) {
    return { state: 'blocked' };
  }
  return { state: status.settings.state };
}

const LANGUAGE_NAMES: Readonly<Record<ConsultLanguage, string>> = {
  en: 'English',
  nl: 'Dutch',
  fr: 'French',
  es: 'Spanish',
  'pt-PT': 'Portuguese (Portugal)',
  'pt-BR': 'Portuguese (Brazil)',
  de: 'German',
  it: 'Italian',
};

/** The plain-words sentence for a readiness blocker code. */
export function outsideHelpBlockerWords(code: ZkapiConsultErrorCode): string {
  return (W.blockers as Readonly<Record<string, string>>)[code] ?? fill(W.blockerOther, { code });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-06" → "6 Nov"; anything else is shown as given. */
function shortDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${Number(match[3])} ${month}` : iso;
}

/** "2026-10-10T17:09:07Z" → "10 Oct 17:09". */
function shortTime(iso: string): string {
  return `${shortDate(iso.slice(0, 10))} ${iso.slice(11, 16)}`.trim();
}

type ConfiguredRoute = Extract<DashboardOutsideHelpRoute, { state: 'configured' }>;

/** Blockers whose fix is the daily limits: one line, one "No daily limit". */
const CAP_BLOCKERS: ReadonlySet<string> = new Set(['daily_cap_reached', 'spend_cap_reached']);
/** Blockers fixed under Balance and limits (the funding date). */
const FUNDING_BLOCKERS: ReadonlySet<string> = new Set(['funding_date_missing', 'funding_date_invalid']);
/** Blockers the setup steps fix. */
const SETUP_BLOCKERS: ReadonlySet<string> = new Set(['daemon_not_found', 'daemon_version_unsupported', 'daemon_supervisor_unsupported', 'tor_not_found', 'daemon_api_key_missing', 'key_reuse_on', 'note_expired']);

/**
 * The card body. `csrfToken` present means the reader holds the controls;
 * without it the card is read-only text (the worker also refuses every write
 * without the control session, so this is presentation, not the boundary).
 *
 * Layout (owner, 2026-10-10: "way too complicated"): one status line with the
 * switch and today's count; the problems, one line and one button each; the
 * statements in full only until they are accepted; everything else one line
 * each, collapsed, showing its current value. Nothing is asked from this page.
 */
export function renderOutsideHelpCard(status: DashboardOutsideHelpStatus, input: { csrfToken?: string; localSession?: boolean; basePath?: string }): string {
  const summary = summaryOf(status);
  // Controls only for a local-grade session: a bearer-grade session (the
  // launch flow, or a bearer mint) reads the card and is offered the local
  // unlock, which the worker's HTTP boundary grants to a loopback browser
  // presenting no bearer. Until then the unlock is the card's only control.
  const canEdit = input.csrfToken !== undefined && input.localSession === true;
  const canUnlock = input.csrfToken !== undefined && input.localSession !== true;
  const route = status.route;
  const on = status.settings.state === 'on';
  const parts: string[] = [];
  parts.push(`<h2 class="ptitle">${escapeHtml(W.title)}</h2>`);
  if (canUnlock) {
    parts.push(`<form class="ohform ohunlock" data-outside-form="unlock" data-outside-unlock>`
      + `<button type="submit" class="btn primary">${escapeHtml(W.unlock)}</button><span class="hint">${escapeHtml(W.unlockIntro)}</span>`
      + `<span class="actmsg" data-action-message role="status"></span></form>`);
  }

  // 1. One status line: the switch, and today's count.
  const access: Access = canEdit ? 'edit' : canUnlock ? 'unlock' : 'read';
  parts.push(renderStatusBlock(status, summary, access));
  if (status.restartPending) parts.push(`<p class="pnote ohwarn" data-outside-restart-pending>${escapeHtml(W.restartPending)}</p>`);

  // 2. Problems: one line each, one button each.
  parts.push(renderProblems(status, access));

  // 3. The statements, in full only until accepted.
  if (route.state === 'configured' && !route.acknowledgements.complete) parts.push(renderStatementsToAccept(access));

  // 4. Everything else: one line each with its current value, collapsed.
  const more: string[] = [];
  if (!on) more.push(renderBeforeTurningOn());
  more.push(renderLevel(status, canEdit));
  if (status.standard) more.push(renderStandard(status.standard, status.settings.level, status.settings.state === 'invalid' ? false : canEdit));
  if (status.writer) more.push(renderWriter(status.writer, canEdit));
  more.push(renderLanguages(status, canEdit));
  if (route.state === 'configured') more.push(renderLimits(route, canEdit));
  if (route.state === 'configured' && route.acknowledgements.complete) more.push(renderAccepted());
  more.push(renderSetupSteps(
    route.state === 'configured' ? route.secretRef : `env:OLYMPUS_ZKAPI_API_KEY`,
    renderOutsideHelpTools(status.tools, { canEdit }),
  ));
  more.push(renderDetails(status));
  parts.push(`<div class="ohmore">${more.join('')}</div>`);

  const config = {
    csrfToken: input.csrfToken ?? '',
    paths: DASHBOARD_OUTSIDE_HELP_PATHS,
    copy: {
      saving: W.saving,
      failed: W.saveFailed,
      failedStatus: W.saveFailedStatus,
      unreachable: W.saveUnreachable,
      restarting: W.restarting,
      on: W.state.on,
      off: W.state.off,
    },
    writerPollMs: OUTSIDE_HELP_WRITER_POLL_MS,
  };
  const script = canEdit || canUnlock ? `<script>${outsideHelpClientScript(config)}</script>` : '';
  const toolsScript = renderOutsideHelpToolsScript(status.tools, { canEdit, ...(input.csrfToken !== undefined ? { csrfToken: input.csrfToken } : {}) });
  return `<div class="privacy outside" data-outside-help data-revision="${escapeHtml(String(status.settings.revision))}">${parts.join('')}</div>${script}${toolsScript}`;
}

function renderStatusBlock(status: DashboardOutsideHelpStatus, summary: DashboardOutsideHelpSummary, access: Access): string {
  const route = status.route;
  const on = status.settings.state === 'on';
  const invalid = status.settings.state === 'invalid';
  const blockedReason = invalid
    ? undefined
    : route.state === 'not_configured'
      ? W.enableBlockedRoute
      : !route.acknowledgements.complete ? W.enableBlockedAcks : undefined;
  // Locked: the switch's first click unlocks; read-only: no switch at all.
  const button = access === 'read'
    ? ''
    : access === 'unlock'
      ? unlockFirst(invalid ? W.replaceFile : on ? W.turnOff : W.turnOn, !on)
      : invalid
      ? `<button type="submit" class="btn primary" data-outside-replace>${escapeHtml(W.replaceFile)}</button>`
      : on
        ? `<button type="submit" class="btn" data-outside-enabled="false">${escapeHtml(W.turnOff)}</button>`
        : blockedReason
          ? `<span class="blocked"><button type="button" class="btn primary" disabled aria-disabled="true">${escapeHtml(W.turnOn)}</button><span class="hint">${escapeHtml(blockedReason)}</span></span>`
          : `<button type="submit" class="btn primary" data-outside-enabled="true">${escapeHtml(W.turnOn)}</button>`;
  const tone = summary.state === 'on' ? 'on' : summary.state === 'off' ? 'off' : 'attn';
  const usage = route.state === 'configured' && route.readiness ? usageLine(route.readiness) : '';
  const head = `<div class="ohhead"><div class="ohstatewrap"><p class="ohstate"><span class="dot ${tone}" aria-hidden="true"></span>`
    + `<span data-outside-state-text data-outside-state="${escapeHtml(summary.state)}">${escapeHtml(outsideHelpStateLine(summary))}</span></p>`
    + (usage ? `<p class="ohline" data-outside-usage>${escapeHtml(usage)}</p>` : '')
    // Tor off is said where the reader looks first: the provider sees the address.
    + (route.state === 'configured' && route.readiness?.torMode === 'off' ? `<p class="ohline attn" data-outside-address-visible>${escapeHtml(W.addressVisible)}</p>` : '')
    + `</div>${button ? `<div class="pbuttons">${button}</div>` : ''}</div>`;
  return `<form class="ohpanel" data-outside-form="enable" data-outside-current="${on ? 'on' : 'off'}" data-outside-invalid="${invalid ? 'yes' : 'no'}">`
    + head + `<span class="actmsg" data-action-message role="status"></span></form>`;
}

/** "4 questions today, counted as up to $12 · balance until about 31 Oct". */
function usageLine(ready: DashboardOutsideHelpReadiness): string {
  const count = ready.requestsToday.count;
  // The ledger records each question's hold (its model's allowance), never
  // the settled price, so the day's figure is what counts against limits,
  // never money spent.
  const today = count === 0
    ? W.usageNone
    : `${count === 1 ? W.usageOne : fill(W.usageMany, { n: String(count) })} ${fill(W.usageCounted, { usd: ready.spendToday.reservedUsd.toFixed(0) })}`;
  const expiry = ready.expiry.state === 'active' && ready.expiry.expiryDate
    ? fill(W.usageExpiry, { date: shortDate(ready.expiry.expiryDate), days: String(ready.expiry.daysLeft ?? '') })
    : ready.expiry.state === 'expired' ? W.usageExpired : undefined;
  return expiry ? `${today} · ${expiry}` : today;
}

/**
 * One problem line: the words, and the one button that fixes it. `kind`
 * picks the button: a post (a form route), opening the section that holds the
 * fix, or checking again (a reload: readiness runs on every read).
 */
type ProblemFix =
  | { readonly kind: 'post'; readonly form: string; readonly label: string; readonly attrs?: string; readonly primary?: boolean }
  | { readonly kind: 'open'; readonly section: string; readonly label: string; readonly focus?: string }
  | { readonly kind: 'recheck' };

/**
 * Locked (a bearer-grade session): a fix that changes something is still
 * shown, and its first click opens the local session (the card's only
 * control until then); after the reload the same button does its work.
 */
function unlockFirst(label: string, primary = true): string {
  return `<button type="button" class="btn${primary ? ' primary' : ''}" data-outside-needs-unlock>${escapeHtml(label)}</button>`;
}

function problemLine(words: string, fix: ProblemFix | undefined, access: Access, input: { attrs?: string; extra?: string } = {}): string {
  const canEdit = access === 'edit';
  let action = '';
  if (fix?.kind === 'post' && access === 'unlock') {
    action = unlockFirst(fix.label, fix.primary !== false);
  } else if (fix?.kind === 'post' && canEdit) {
    action = `<form class="ohform ohinline" data-outside-form="${escapeHtml(fix.form)}"${fix.attrs ?? ''}>`
      + `<button type="submit" class="btn${fix.primary === false ? '' : ' primary'}">${escapeHtml(fix.label)}</button>`
      + `${input.extra ?? ''}<span class="actmsg" data-action-message role="status"></span></form>`;
  } else if (fix?.kind === 'open') {
    action = `<button type="button" class="btn" data-outside-open="${escapeHtml(fix.section)}"${fix.focus ? ` data-outside-focus="${escapeHtml(fix.focus)}"` : ''}>${escapeHtml(fix.label)}</button>`;
  } else if (fix?.kind === 'recheck') {
    action = `<button type="button" class="btn" data-outside-recheck>${escapeHtml(W.checkAgain)}</button>`;
  }
  return `<li${input.attrs ?? ''}><span>${escapeHtml(words)}</span>${action}</li>`;
}

/** What the reader may do: change things, unlock first, or only read. */
type Access = 'edit' | 'unlock' | 'read';

function renderProblems(status: DashboardOutsideHelpStatus, access: Access): string {
  const canEdit = access === 'edit';
  const route = status.route;
  const items: string[] = [];
  // Missing programs: one line with the install button (or its progress).
  const tools = renderOutsideHelpToolsFix(status.tools, { canEdit });
  if (tools) items.push(tools);
  if (route.state === 'not_configured') {
    items.push(route.policyWritable
      ? problemLine(W.routeMissing, { kind: 'post', form: 'add-route', label: W.addRoute, attrs: ` data-outside-confirm="${escapeHtml(W.addRouteConfirm)}"` }, access, { attrs: ' data-outside-route-missing' })
      : problemLine(W.policyNotFile, { kind: 'open', section: 'steps', label: W.showSteps }, access, { attrs: ' data-outside-route-missing' }));
  } else if (route.readinessUnavailable || !route.readiness) {
    items.push(problemLine(W.routeUnknown, { kind: 'recheck' }, access, { attrs: ' data-outside-blocker="readiness_unavailable"' }));
  } else {
    const ready = route.readiness;
    const blockers = ready.blockers;
    const caps = blockers.filter((code) => CAP_BLOCKERS.has(code));
    for (const code of blockers) {
      // The statements block below is its own fix; and both limits share one line.
      if (code === 'acknowledgements_incomplete') continue;
      if (CAP_BLOCKERS.has(code) && code !== caps[0]) continue;
      const attrs = ` data-outside-blocker="${escapeHtml(code)}"`;
      const tool = TOOL_BLOCKERS.get(code);
      const entry = tool ? status.tools?.tools.find((item) => item.tool === tool) : undefined;
      // Missing and installable: the parts' own line (above) says it, with its button.
      if (entry?.source === 'missing') continue;
      if (entry?.source === 'configured_missing') {
        items.push(problemLine(fill(DASHBOARD_OUTSIDE_HELP_TOOLS_COPY.configuredMissing, { tool: entry.label, path: entry.path ?? '' }), { kind: 'open', section: 'steps', label: W.showSteps }, access, { attrs }));
        continue;
      }
      if (code === 'unresolved_session') {
        items.push(renderFenceLine(ready, access));
        continue;
      }
      if (code === 'unresolved_session_other_wallet') {
        items.push(...ready.fences.filter((fence) => !fence.thisWallet).map((fence) => problemLine(
          fill(W.blockers.unresolved_session_other_wallet, { at: shortTime(fence.at) }),
          { kind: 'post', form: 'abandon', label: W.abandon, primary: false, attrs: ` data-outside-scope="${escapeHtml(fence.scope)}" data-outside-confirm="${escapeHtml(W.abandonConfirm)}"` },
          access,
          { attrs },
        )));
        continue;
      }
      const words = CAP_BLOCKERS.has(code) && caps.length > 1 ? W.capsReached : outsideHelpBlockerWords(code);
      const fix: ProblemFix = CAP_BLOCKERS.has(code)
        ? { kind: 'post', form: 'route', label: W.removeLimits, attrs: ' data-outside-nolimit' }
        : FUNDING_BLOCKERS.has(code)
          ? { kind: 'open', section: 'limits', label: W.enterFundingDate, focus: 'funding_date' }
          : SETUP_BLOCKERS.has(code)
            ? { kind: 'open', section: 'steps', label: W.showSteps }
            : { kind: 'recheck' };
      items.push(problemLine(words, fix, access, { attrs }));
    }
  }
  if (status.writer?.modelProblem) {
    items.push(problemLine(status.writer.modelProblem.message, { kind: 'open', section: 'writer', label: W.chooseModel, focus: 'chatgpt_frontier_model' }, access, { attrs: ' data-outside-model-problem' }));
  }
  if (items.length === 0) return '';
  return `<ul class="ohfix" data-outside-blockers aria-label="${escapeHtml(W.problemsTitle)}">${items.join('')}</ul>`;
}

/**
 * The held payment of this wallet: one line, Recover. Abandon sits beside it
 * as a quiet second choice, because a recovery can fail and the owner must
 * never be left with a problem and no way out.
 */
function renderFenceLine(ready: DashboardOutsideHelpReadiness, access: Access): string {
  const canEdit = access === 'edit';
  const mine = ready.fences.find((fence) => fence.thisWallet);
  const words = fill(W.blockers.unresolved_session, { at: mine ? shortTime(mine.at) : '' });
  if (access === 'unlock') return `<li data-outside-blocker="unresolved_session" data-outside-fence><span>${escapeHtml(words)}</span>${unlockFirst(W.recover)}</li>`;
  const abandon = mine && canEdit
    ? `<form class="ohform ohinline" data-outside-form="abandon" data-outside-scope="${escapeHtml(mine.scope)}" data-outside-confirm="${escapeHtml(W.abandonConfirm)}">`
      + `<button type="submit" class="btn quiet" title="${escapeHtml(W.abandonHint)}">${escapeHtml(W.abandon)}</button><span class="actmsg" data-action-message role="status"></span></form>`
    : '';
  const recover = canEdit
    ? `<form class="ohform ohinline" data-outside-form="recover" data-outside-confirm="${escapeHtml(W.recoverConfirm)}">`
      + `<button type="submit" class="btn primary" title="${escapeHtml(W.recoverHint)}">${escapeHtml(W.recover)}</button><span class="actmsg" data-action-message role="status"></span></form>`
    : '';
  return `<li data-outside-blocker="unresolved_session" data-outside-fence><span>${escapeHtml(words)}</span>${recover || abandon ? `<span class="ohactions">${recover}${abandon}</span>` : ''}</li>`;
}

function renderSection(input: { id: string; title: string; summary: string; open?: boolean; body: string }): string {
  return `<details class="ohsect" id="outside-${escapeHtml(input.id)}" data-outside-section="${escapeHtml(input.id)}"${input.open ? ' open' : ''}>`
    + `<summary><span class="ohsect-title">${escapeHtml(input.title)}</span><span class="ohsect-sum">${escapeHtml(input.summary)}</span></summary>`
    + `<div class="ohsect-body">${input.body}</div></details>`;
}

/** The not-installed blockers the parts' own "To fix" line (outside-help-tools.ts) stands in for. */
const TOOL_BLOCKERS: ReadonlyMap<string, 'zkapi-clientd' | 'tor'> = new Map([['daemon_not_found', 'zkapi-clientd'], ['tor_not_found', 'tor']]);

/** The current statements as a plain list; with `inputs`, the ids an Accept posts. */
function renderStatements(inputs: boolean): string {
  return `<ul class="ohlist" data-outside-statements>${ZKAPI_RISK_ACKNOWLEDGEMENTS.map((entry) => `<li data-statement="${escapeHtml(entry.id)}">${escapeHtml(entry.statement)}</li>`).join('')}</ul>`
    + (inputs ? ZKAPI_RISK_ACKNOWLEDGEMENTS.map((entry) => `<input type="hidden" name="acknowledged" value="${escapeHtml(entry.id)}">`).join('') : '');
}

/** Not accepted at the current wording: the statements in full, one Accept. */
function renderStatementsToAccept(access: Access): string {
  return `<form class="ohform ohaccept" data-outside-form="route" data-outside-accept data-outside-acknowledged="no">`
    + `<div class="sect">${escapeHtml(W.costTitle)}</div><p class="pnote">${escapeHtml(W.costIntro)}</p>${renderStatements(true)}`
    + (access === 'edit'
      ? `<div class="pbuttons"><button type="submit" class="btn primary">${escapeHtml(W.accept)}</button><span class="hint">${escapeHtml(W.saveRestarts)}</span></div>`
      : access === 'unlock' ? `<div class="pbuttons">${unlockFirst(W.accept)}</div>` : '')
    + `<span class="actmsg" data-action-message role="status"></span></form>`;
}

/** Accepted at the current wording: one line, the statements inside. */
function renderAccepted(): string {
  return renderSection({
    id: 'statements',
    title: W.costTitle,
    summary: fill(W.acknowledged, { n: String(ZKAPI_RISK_ACKNOWLEDGEMENTS.length) }),
    body: `<div data-outside-acknowledged="yes">${renderStatements(false)}</div>`,
  });
}

/** Shown only while off: what turning on means, in a few lines. */
function renderBeforeTurningOn(): string {
  return renderSection({
    id: 'before',
    title: W.disclosureTitle,
    summary: '',
    body: `<p class="pnote">${escapeHtml(W.intro)}</p>`
      + `<ul class="ohshort" data-outside-disclosure>${W.disclosureShort.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
      + `<p class="pnote" data-outside-privacy>${escapeHtml(W.privacy)}</p>`
      + `<p class="pnote" data-outside-cost>${escapeHtml(W.costLine)}</p>`,
  });
}

/**
 * "What may zkAPI send?": Standard (recommended, the default) and Strict,
 * saved through the same local-grade, CSRF-protected settings route as the
 * switch (the worker re-checks every rule). Saving a level is never refused
 * for the statements: nothing is sent until they are accepted.
 */
function renderLevel(status: DashboardOutsideHelpStatus, canEdit: boolean): string {
  const invalid = status.settings.state === 'invalid';
  const current = status.settings.level;
  const blocked = !canEdit || invalid ? ' disabled aria-disabled="true"' : '';
  const options = (['unnamed', 'general'] as const).map((level) => {
    const copy = W.levels[level];
    return `<label class="ohack ohlevel"><input type="radio" name="level" value="${level}"${level === current ? ' checked' : ''}${blocked}>`
      + `<span><strong>${escapeHtml(copy.title)}</strong> ${escapeHtml(copy.body)}</span></label>`;
  }).join('');
  const body = `<form class="ohform" data-outside-form="level" data-outside-level="${escapeHtml(current)}" data-outside-current="${status.settings.state === 'on' ? 'on' : 'off'}">`
    + options
    + (canEdit && !invalid ? `<div class="pbuttons"><button type="submit" class="btn" data-outside-level-save>${escapeHtml(W.levelSave)}</button></div>` : '')
    + `<span class="actmsg" data-action-message role="status"></span></form>`;
  return renderSection({ id: 'level', title: W.levelTitle, summary: W.levels[current].short, body });
}

/**
 * "How your model prepares a question" (Standard, owner decision
 * 2026-10-10): exactly as written, lightly cleaned (the preset shown in full
 * and editable: an edited preset is saved as the user's own), or by the
 * user's own instruction. No built-in content rules.
 */
function renderStandard(standard: NonNullable<DashboardOutsideHelpStatus['standard']>, level: ConsultLevel, canEdit: boolean): string {
  const C = W.standard;
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const options = (['as_written', 'light_cleanup', 'custom'] as const).map((mode) => {
    const copy = C.modes[mode];
    return `<label class="ohack ohlevel"><input type="radio" name="standard_mode" value="${mode}"${mode === standard.mode ? ' checked' : ''}${disabled}>`
      + `<span><strong>${escapeHtml(copy.title)}</strong> ${escapeHtml(copy.body)}</span></label>`;
  }).join('');
  const text = standard.mode === 'custom' && standard.instruction !== undefined ? standard.instruction : standard.preset;
  const body = `<form class="ohform" data-outside-form="standard" data-outside-standard="${escapeHtml(standard.mode)}" data-outside-preset="${escapeHtml(standard.preset)}">`
    + `<p class="pnote">${escapeHtml(C.intro)}</p>${options}`
    + `<label class="plabel" for="outside-standard-instruction">${escapeHtml(C.instructionLabel)}</label>`
    + `<textarea class="keyfield" id="outside-standard-instruction" name="standard_instruction" rows="5" maxlength="${standard.maxChars}" data-outside-standard-instruction${disabled}>${escapeHtml(text)}</textarea>`
    + (canEdit ? `<div class="pbuttons"><button type="submit" class="btn">${escapeHtml(C.save)}</button></div>` : '')
    + `<span class="actmsg" data-action-message role="status"></span></form>`;
  const summary = level === 'general' ? fill(C.unusedAtStrict, { mode: C.modes[standard.mode].short }) : C.modes[standard.mode].short;
  return renderSection({ id: 'standard', title: C.title, summary, body });
}

function renderSetupSteps(secretRef: string, tools = ''): string {
  const steps = W.steps.map((step) => fill(step, { secretRef }));
  return renderSection({
    id: 'steps',
    title: W.stepsTitle,
    summary: '',
    body: `${tools}<div data-outside-steps><p class="pnote">${escapeHtml(W.stepsIntro)}</p><ol class="ohsteps">${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol></div>`,
  });
}

function renderLimits(route: ConfiguredRoute, canEdit: boolean): string {
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const capped = route.dailyRequestCap !== undefined || route.dailySpendCapUsd !== undefined;
  const limit = capped
    ? [
      ...(route.dailyRequestCap !== undefined ? [fill(W.limitsRequests, { n: String(route.dailyRequestCap) })] : []),
      ...(route.dailySpendCapUsd !== undefined ? [fill(W.limitsUsd, { usd: String(route.dailySpendCapUsd) })] : []),
    ].join(', ')
    : W.limitsNone;
  const funded = route.fundingDate ? fill(W.fundedOn, { date: shortDate(route.fundingDate) }) : W.notFunded;
  // The one-click "no daily limit": clears both caps through the same
  // transactional policy write as Save.
  const noLimit = capped && canEdit
    ? `<form class="ohform ohinline" data-outside-form="route" data-outside-nolimit>`
      + `<div class="pbuttons"><button type="submit" class="btn">${escapeHtml(W.removeLimits)}</button><span class="hint">${escapeHtml(W.removeLimitsHint)}</span></div>`
      + `<span class="actmsg" data-action-message role="status"></span></form>`
    : '';
  const today = route.readiness && route.readiness.requestsToday.count > 0
    ? `<p class="pnote" data-outside-limits-today>${escapeHtml(fill(W.limitsToday, { n: String(route.readiness.requestsToday.count), usd: route.readiness.spendToday.reservedUsd.toFixed(0) }))}</p>`
    : '';
  const body = `<p class="pnote" data-outside-cost-line>${escapeHtml(W.costLine)} ${escapeHtml(W.noLimitIntro)}</p>` + today + noLimit
    + `<form class="ohform" data-outside-form="route">`
    + `<label class="plabel" for="outside-funding-date">${escapeHtml(W.fundingDate)}</label>`
    + `<input class="keyfield ptextline" id="outside-funding-date" name="funding_date" type="text" inputmode="numeric" autocomplete="off" placeholder="YYYY-MM-DD" value="${escapeHtml(route.fundingDate ?? '')}"${disabled}>`
    + `<label class="plabel" for="outside-cap-requests">${escapeHtml(W.capRequests)}</label>`
    + `<input class="keyfield ptextline" id="outside-cap-requests" name="daily_request_cap" type="number" min="1" step="1" value="${route.dailyRequestCap !== undefined ? escapeHtml(String(route.dailyRequestCap)) : ''}"${disabled}>`
    + `<label class="plabel" for="outside-cap-usd">${escapeHtml(W.capUsd)}</label>`
    + `<input class="keyfield ptextline" id="outside-cap-usd" name="daily_spend_cap_usd" type="number" min="1" step="1" value="${route.dailySpendCapUsd !== undefined ? escapeHtml(String(route.dailySpendCapUsd)) : ''}"${disabled}>`
    + (canEdit ? `<div class="pbuttons"><button type="submit" class="btn" data-outside-save-limits>${escapeHtml(W.saveRoute)}</button><span class="hint">${escapeHtml(W.saveRestarts)}</span></div>` : '')
    + `<span class="actmsg" data-action-message role="status"></span></form>`;
  return renderSection({ id: 'limits', title: W.limitsTitle, summary: `${limit} · ${funded}`, body });
}

/** How often the page re-reads itself while the writer check runs. */
export const OUTSIDE_HELP_WRITER_POLL_MS = 5_000;

/** True when a model id names an OpenAI model (the zkAPI catalog's `openai/` prefix). */
function openAiModel(model: string | undefined): boolean {
  return typeof model === 'string' && /^openai\//i.test(model.trim());
}

/** True when a model id names an Anthropic model (the zkAPI catalog's `anthropic/` prefix). */
function anthropicModel(model: string | undefined): boolean {
  return typeof model === 'string' && /^anthropic\//i.test(model.trim());
}

/**
 * "Who writes the question": the built-in model by default, or the owner's
 * own model server; the zkAPI models for questions from ChatGPT and from
 * Claude; and the test button, which runs only when clicked. No gate on the
 * model: the copy only says a substantial model works best.
 */
function renderWriter(writer: DashboardOutsideHelpWriter, canEdit: boolean): string {
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const C = W.writer;
  const choice = writer.choice;
  const effectiveModel = writer.effectiveChatgptModel ?? writer.chatgptFrontierModel;
  const effectiveClaudeModel = writer.effectiveClaudeModel ?? writer.claudeFrontierModel;
  const parts: string[] = [`<p class="pnote">${escapeHtml(C.intro)}</p>`];
  parts.push(`<p class="pnote" data-outside-writer-current="${choice ? 'own' : 'built_in'}">${escapeHtml(choice ? fill(C.currentOwn, { model: choice.model, address: choice.baseUrl }) : C.currentBuiltIn)}</p>`);
  if (choice?.secretRef && choice.keyPresent === false) parts.push(`<p class="pnote ohwarn" data-outside-writer-key-missing>${escapeHtml(fill(C.keyMissing, { secretRef: choice.secretRef }))}</p>`);
  parts.push(`<form class="ohform" data-outside-form="writer">`
    + `<label class="plabel" for="outside-writer-url">${escapeHtml(C.baseUrl)}</label>`
    + `<input class="keyfield ptextline" id="outside-writer-url" name="writer_base_url" type="url" autocomplete="off" placeholder="http://127.0.0.1:11434/v1" value="${escapeHtml(choice?.baseUrl ?? '')}"${disabled}>`
    + `<label class="plabel" for="outside-writer-model">${escapeHtml(C.model)}</label>`
    + `<input class="keyfield ptextline" id="outside-writer-model" name="writer_model" type="text" autocomplete="off" value="${escapeHtml(choice?.model ?? '')}"${disabled}>`
    + `<label class="plabel" for="outside-writer-key">${escapeHtml(C.secretRef)}</label>`
    + `<input class="keyfield ptextline" id="outside-writer-key" name="writer_secret_ref" type="text" autocomplete="off" placeholder="env:NAME" value="${escapeHtml(choice?.secretRef ?? '')}"${disabled}>`
    + `<p class="pnote ohsmall">${escapeHtml(C.where)}</p>`
    + `<label class="plabel" for="outside-frontier-model">${escapeHtml(C.frontierModel)}</label>`
    + `<input class="keyfield ptextline" id="outside-frontier-model" name="chatgpt_frontier_model" type="text" autocomplete="off" placeholder="${escapeHtml(writer.effectiveChatgptModel ?? '')}" value="${escapeHtml(writer.chatgptFrontierModel ?? '')}"${disabled}>`
    + `<p class="pnote ohsmall">${escapeHtml(C.frontierHint)}</p>`
    + (openAiModel(effectiveModel) ? `<p class="pnote ohwarn" data-outside-writer-openai>${escapeHtml(fill(C.openAiNote, { model: effectiveModel ?? '' }))}</p>` : '')
    + `<label class="plabel" for="outside-claude-frontier-model">${escapeHtml(C.claudeFrontierModel)}</label>`
    + `<input class="keyfield ptextline" id="outside-claude-frontier-model" name="claude_frontier_model" type="text" autocomplete="off" placeholder="${escapeHtml(writer.effectiveClaudeModel ?? '')}" value="${escapeHtml(writer.claudeFrontierModel ?? '')}"${disabled}>`
    + `<p class="pnote ohsmall">${escapeHtml(C.claudeFrontierHint)}</p>`
    + (anthropicModel(effectiveClaudeModel) ? `<p class="pnote ohwarn" data-outside-writer-anthropic>${escapeHtml(fill(C.anthropicNote, { model: effectiveClaudeModel ?? '' }))}</p>` : '')
    + `<div class="pbuttons"><button type="submit" class="btn primary" data-outside-writer-save${disabled}>${escapeHtml(C.save)}</button>`
    + (choice ? `<button type="submit" class="btn quiet" data-outside-writer-clear${disabled}>${escapeHtml(C.useBuiltIn)}</button>` : '')
    + `</div><span class="actmsg" data-action-message role="status"></span></form>`);
  parts.push(renderWriterCheck(writer, canEdit));
  const summary = choice ? choice.model : C.builtInShort;
  return renderSection({ id: 'writer', title: C.title, summary, open: writer.check.state !== 'idle', body: `<div data-outside-writer>${parts.join('')}</div>` });
}

function renderWriterCheck(writer: DashboardOutsideHelpWriter, canEdit: boolean): string {
  const C = W.writer;
  if (!writer.testAvailable) return '';
  const disabled = canEdit && writer.choice && writer.check.state !== 'running' ? '' : ' disabled aria-disabled="true"';
  const check = writer.check;
  const parts: string[] = [`<div class="sect">${escapeHtml(C.testTitle)}</div>`, `<p class="pnote">${escapeHtml(C.testIntro)}</p>`];
  if (!writer.choice) parts.push(`<p class="pnote ohsmall">${escapeHtml(C.testNeedsChoice)}</p>`);
  if (check.state === 'running') {
    parts.push(`<p class="pnote" role="status">${escapeHtml(check.total > 0 ? fill(C.testProgress, { done: String(check.done), total: String(check.total) }) : C.testStarting)}</p>`);
  } else if (check.state === 'failed') {
    parts.push(`<p class="pnote ohwarn" role="status">${escapeHtml(check.message)}</p>`);
  } else if (check.state === 'done') {
    const report = check.report;
    parts.push(`<p class="pnote" data-outside-writer-summary>${escapeHtml(fill(C.testSummary, {
      cases: String(report.cases),
      written: String(report.written),
      declined: String(report.declined),
      failed: String(report.failed),
      passed: String(report.gatePassed),
      refused: String(report.gateRefused),
    }))}</p>`);
    parts.push(report.canaryLeaks.length === 0
      ? `<p class="pnote good" data-outside-writer-leaks="0">${escapeHtml(C.testNoLeaks)}</p>`
      : `<p class="pnote ohwarn" data-outside-writer-leaks="${report.canaryLeaks.length}">${escapeHtml(fill(C.testLeaks, { n: String(report.canaryLeaks.length) }))}</p>`);
    if (report.documentQuestions.length > 0) parts.push(`<p class="pnote ohwarn" data-outside-writer-document-questions>${escapeHtml(fill(C.testDocumentQuestions, { n: String(report.documentQuestions.length) }))}</p>`);
    const rows = report.results.map((result) => {
      const verdict = result.outcome === 'questions'
        ? result.gate === 'pass' ? C.testPassed : fill(C.testRefused, { reasons: result.gateReasons.join(', ') })
        : result.outcome === 'declined' ? C.testDeclined : fill(C.testFailed, { reason: result.reason ?? result.outcome });
      const questions = result.questions.map((question) => `<li>${escapeHtml(question)}</li>`).join('');
      return `<li data-outside-writer-case="${escapeHtml(result.id)}"><strong>${escapeHtml(result.id)}</strong>: ${escapeHtml(verdict)}${result.canaryLeak ? ` <span class="attn">${escapeHtml(C.testLeakMark)}</span>` : ''}`
        + `${result.asksAboutDocuments ? ` <span class="attn">${escapeHtml(C.testDocumentMark)}</span>` : ''}${questions ? `<ul class="ohlist">${questions}</ul>` : ''}</li>`;
    }).join('');
    parts.push(`<ul class="ohfacts" data-outside-writer-results>${rows}</ul>`);
  }
  parts.push(`<form class="ohform" data-outside-form="writer-test"><div class="pbuttons"><button type="submit" class="btn"${disabled}>${escapeHtml(check.state === 'done' || check.state === 'failed' ? C.testAgain : C.test)}</button></div>`
    + `<span class="actmsg" data-action-message role="status"></span></form>`);
  return `<div data-outside-writer-check="${escapeHtml(check.state)}">${parts.join('')}</div>`;
}

function renderLanguages(status: DashboardOutsideHelpStatus, canEdit: boolean): string {
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const chosen = new Set(status.settings.languages);
  const languages = status.languages.map((entry) => {
    const name = LANGUAGE_NAMES[entry.language];
    const off = !entry.installed;
    return `<label class="ohack${off ? ' ohoff' : ''}"><input type="checkbox" name="languages" value="${escapeHtml(entry.language)}"`
      + `${chosen.has(entry.language) && !off ? ' checked' : ''}${off ? ' disabled aria-disabled="true"' : disabled}>`
      + `<span>${escapeHtml(name)}${off ? ` <span class="hint">${escapeHtml(W.packMissing)}</span>` : ''}</span></label>`;
  }).join('');
  // The domain packs the gate admits beside the languages (the defaults, or
  // the file's own choices): named in plain words, on and off.
  const domainNames = W.domainNames as Readonly<Record<string, string>>;
  const domainsOn = Object.entries(status.settings.domains).filter(([, on]) => on).map(([key]) => domainNames[key] ?? key);
  const domainsOff = Object.entries(status.settings.domains).filter(([, on]) => !on).map(([key]) => domainNames[key] ?? key);
  const domains = `<p class="pnote" data-outside-domains="${escapeHtml(Object.entries(status.settings.domains).filter(([, on]) => on).map(([key]) => key).join(','))}">`
    + `${escapeHtml(fill(W.domainsOn, { list: domainsOn.join(', ') || W.domainsNone }))}`
    + `${domainsOff.length > 0 ? ` ${escapeHtml(fill(W.domainsOff, { list: domainsOff.join(', ') }))}` : ''}</p>`;
  const named = status.languages.filter((entry) => entry.installed && chosen.has(entry.language)).map((entry) => LANGUAGE_NAMES[entry.language]);
  // The language boxes are read by the switch above (the enable post carries them).
  return renderSection({
    id: 'languages',
    title: W.languagesTitle,
    summary: named.join(', '),
    open: false,
    body: `<p class="pnote">${escapeHtml(W.languagesIntro)}</p><div class="ohgrid" data-outside-languages>${languages}</div>${domains}`,
  });
}

/**
 * Details: what anonymous answers are, the fuller cost-and-risk detail
 * ("Everything to know first"), and the route's technical facts. Never on
 * first view.
 */
function renderDetails(status: DashboardOutsideHelpStatus): string {
  const route = status.route;
  // While off, Before you turn this on says what it is; Details does not repeat it.
  const about = (status.settings.state === 'on'
    ? `<p class="pnote">${escapeHtml(W.intro)}</p><p class="pnote" data-outside-privacy>${escapeHtml(W.privacy)}</p>`
    : '')
    + `<p class="pnote ohsmall">${escapeHtml(W.experimental)}</p>`;
  const more = `<div class="sect">${escapeHtml(W.disclosureMore)}</div>`
    + `<ul class="ohlist" data-outside-disclosure-more>${W.disclosure.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
  let facts = '';
  if (route.state === 'configured' && route.readiness && !route.readinessUnavailable) {
    const ready = route.readiness;
    const list = [
      ready.daemonFound ? fill(W.facts.daemon, { version: ready.daemonVersion ?? W.facts.versionUnknown }) : W.facts.daemonMissing,
      ready.torMode === 'off' ? W.facts.torOff : ready.torFound ? W.facts.tor : W.facts.torMissing,
      ready.apiKeyConfigured ? W.facts.key : W.facts.keyMissing,
      fill(ready.requestsToday.count === 1 ? W.facts.todayOne : W.facts.today, { n: String(ready.requestsToday.count), usd: ready.spendToday.reservedUsd.toFixed(0) }),
      ready.expiry.state === 'active' && ready.expiry.expiryDate
        ? fill(W.facts.expiry, { date: ready.expiry.expiryDate, days: String(ready.expiry.daysLeft ?? '') })
        : ready.expiry.state === 'expired' ? W.facts.expired : W.facts.expiryUnknown,
      fill(W.routeLabel, { label: ready.routeLabel }),
      ...ready.fences.map((fence) => fill(fence.thisWallet ? W.fenceThis : W.fenceOther, { at: shortTime(fence.at) })),
      ...(ready.lastSession ? [fill(W.lastSession, { at: shortTime(ready.lastSession.at), result: ready.lastSession.result })] : []),
    ];
    facts = `<div class="sect">${escapeHtml(W.factsTitle)}</div><ul class="ohfacts" data-outside-facts>${list.map((fact) => `<li>${escapeHtml(fact)}</li>`).join('')}</ul>`;
  }
  return renderSection({ id: 'details', title: W.detailsTitle, summary: '', body: about + more + facts });
}

/**
 * The card's own controller: small forms posted as JSON with the control
 * session's CSRF token. Deliberately not the shared dashboard controller or
 * the Control UI action set: those are shared with the native surfaces, and
 * these routes exist for this page alone.
 */
export interface OutsideHelpClientCopy {
  saving: string;
  failed: string;
  failedStatus: string;
  unreachable: string;
  restarting: string;
  on: string;
  off: string;
}

export function outsideHelpClientScript(config: { csrfToken: string; paths: typeof DASHBOARD_OUTSIDE_HELP_PATHS; copy: OutsideHelpClientCopy; writerPollMs?: number }): string {
  return `(function () {
  var config = ${escapeScriptJson(JSON.stringify(config))};
  var root = document.querySelector('[data-outside-help]');
  if (!root) return;
  function message(form, text, bad) {
    var out = form.querySelector('[data-action-message]');
    if (!out) return;
    out.textContent = text;
    out.setAttribute('data-state', bad ? 'error' : 'ok');
  }
  function numberOrNull(value) {
    var trimmed = String(value || '').trim();
    if (trimmed === '') return null;
    var n = Number(trimmed);
    return isFinite(n) ? n : NaN;
  }
  function checked(name) {
    return Array.prototype.map.call(root.querySelectorAll('input[name="' + name + '"]:checked'), function (input) { return input.value; });
  }
  function field(name) {
    var input = root.querySelector('[name="' + name + '"]');
    return input ? input.value : '';
  }
  // The statement ids an Accept posts: the ones listed in that form.
  function statementIds(container) {
    return Array.prototype.map.call(container.querySelectorAll('input[name="acknowledged"]'), function (input) { return input.value; });
  }
  // The server's own words for a refusal; the generic line only when there are none.
  function failure(response, result) {
    if (result && result.error && typeof result.error.message === 'string' && result.error.message) return result.error.message;
    if (result && typeof result.message === 'string' && result.message) return result.message;
    if (result && typeof result.error === 'string' && result.error) return result.error;
    return response && response.status ? config.copy.failedStatus.replace('{status}', String(response.status)) : config.copy.failed;
  }
  // A problem's button that opens the section holding its fix: open it,
  // bring it into view, and put the cursor in the field that needs the owner.
  root.querySelectorAll('[data-outside-open]').forEach(function (button) {
    button.addEventListener('click', function () {
      var section = root.querySelector('details[data-outside-section="' + button.getAttribute('data-outside-open') + '"]');
      if (!section) return;
      section.open = true;
      if (section.scrollIntoView) section.scrollIntoView({ block: 'start' });
      var focus = button.getAttribute('data-outside-focus');
      var target = focus ? section.querySelector('[name="' + focus + '"]') : section.querySelector('summary');
      if (target && target.focus) target.focus();
    });
  });
  // Locked: a fix's first click opens the local session (the reload then shows the real button).
  var unlockForm = root.querySelector('form[data-outside-form="unlock"]');
  root.querySelectorAll('[data-outside-needs-unlock]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (!unlockForm) return;
      if (unlockForm.requestSubmit) unlockForm.requestSubmit(); else unlockForm.dispatchEvent(new Event('submit', { cancelable: true }));
      if (unlockForm.scrollIntoView) unlockForm.scrollIntoView({ block: 'start' });
    });
  });
  // Check again: readiness runs on every read of the page.
  root.querySelectorAll('[data-outside-recheck]').forEach(function (button) {
    button.addEventListener('click', function () { window.location.reload(); });
  });
  // Each post carries the whole card's state for its route, wherever on the
  // card the fields sit: the switch reads the language boxes, and a limits
  // save reads the funding date and both limits. Only an Accept posts the
  // statements; any other save leaves the recorded acceptance as it is.
  function bodyFor(form, kind, submitter) {
    if (kind === 'enable') {
      var invalid = form.getAttribute('data-outside-invalid') === 'yes';
      var enabled = invalid ? false : (submitter && submitter.getAttribute('data-outside-enabled') === 'true');
      var body = { enabled: enabled, revision: Number(root.getAttribute('data-revision') || '0'), languages: checked('languages') };
      if (invalid) body.replace_invalid = true;
      return body;
    }
    if (kind === 'route') {
      if (form.hasAttribute('data-outside-accept')) return { acknowledged: statementIds(form) };
      if (form.hasAttribute('data-outside-nolimit')) return { daily_request_cap: null, daily_spend_cap_usd: null };
      return {
        funding_date: String(field('funding_date') || ''),
        daily_request_cap: numberOrNull(field('daily_request_cap')),
        daily_spend_cap_usd: numberOrNull(field('daily_spend_cap_usd')),
      };
    }
    if (kind === 'level') {
      var picked = form.querySelector('input[name="level"]:checked');
      // On or off as the switch says now: the status line once the switch has
      // updated it in place, else the saved setting (a paused card is still
      // on), so saving a level never flips the switch.
      var state = root.querySelector('[data-outside-state-text]');
      var said = state ? state.getAttribute('data-outside-state') : '';
      var current = said === 'on' || said === 'off' ? said : form.getAttribute('data-outside-current');
      return { enabled: current === 'on', revision: Number(root.getAttribute('data-revision') || '0'), level: picked ? picked.value : form.getAttribute('data-outside-level') };
    }
    if (kind === 'writer') {
      var clearing = submitter && submitter.hasAttribute('data-outside-writer-clear');
      var revisionNow = Number(root.getAttribute('data-revision') || '0');
      var frontier = String(field('chatgpt_frontier_model') || '').trim();
      var claudeFrontier = String(field('claude_frontier_model') || '').trim();
      if (clearing) return { revision: revisionNow, writer: null };
      var writerBody = { base_url: String(field('writer_base_url') || '').trim(), model: String(field('writer_model') || '').trim(), secret_ref: String(field('writer_secret_ref') || '').trim() };
      var writerSave = {
        revision: revisionNow,
        chatgpt_frontier_model: frontier === '' ? null : frontier,
        claude_frontier_model: claudeFrontier === '' ? null : claudeFrontier,
      };
      // No server named: the writer stays as it is (the built-in one), and only the zkAPI models are saved.
      if (writerBody.base_url !== '' || writerBody.model !== '' || writerBody.secret_ref !== '') writerSave.writer = writerBody;
      return writerSave;
    }
    if (kind === 'standard') {
      var mode = form.querySelector('input[name="standard_mode"]:checked');
      var chosen = mode ? mode.value : form.getAttribute('data-outside-standard');
      var instruction = String(field('standard_instruction') || '');
      // An edited preset is saved as the user's own instruction.
      if (chosen === 'light_cleanup' && instruction.trim() !== String(form.getAttribute('data-outside-preset') || '').trim()) chosen = 'custom';
      var standardBody = { revision: Number(root.getAttribute('data-revision') || '0'), standard_mode: chosen };
      if (chosen === 'custom') standardBody.standard_instruction = instruction;
      return standardBody;
    }
    if (kind === 'abandon') return { confirm: true, scope: form.getAttribute('data-outside-scope') || '' };
    if (kind === 'unlock') return {};
    return { confirm: true };
  }
  // After a restart the worker is briefly away: wait for it to answer, then reload.
  function reloadWhenBack(delay) {
    var tries = 0;
    function poll() {
      tries += 1;
      fetch(window.location.href, { credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
        if (response.ok || tries > 40) window.location.reload(); else setTimeout(poll, 1500);
      }, function () { if (tries > 40) window.location.reload(); else setTimeout(poll, 1500); });
    }
    setTimeout(poll, delay);
  }
  var paths = { unlock: config.paths.unlock, enable: config.paths.enable, level: config.paths.enable, route: config.paths.route, 'add-route': config.paths.addRoute, recover: config.paths.recover, abandon: config.paths.abandon, writer: config.paths.writer, 'writer-test': config.paths.writerTest, standard: config.paths.standard };
  // While the writer check runs (only after the owner's click), the page re-reads itself.
  if (root.querySelector('[data-outside-writer-check="running"]') && config.writerPollMs) {
    setTimeout(function () { window.location.reload(); }, config.writerPollMs);
  }
  // One post; a network failure (Olympus restarting, say) is its own answer, never a thrown error.
  async function send(path, body) {
    var response;
    try {
      response = await fetch(path, body === null
        ? { method: 'POST', credentials: 'same-origin', cache: 'no-store' }
        : {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'X-Olympus-CSRF': config.csrfToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
    } catch (error) {
      return { ok: false, text: config.copy.unreachable, result: {} };
    }
    var result = {};
    try { result = await response.json(); } catch (error) { result = {}; }
    if (!response.ok || !result || !result.ok) return { ok: false, text: failure(response, result), result: result || {} };
    return { ok: true, text: result.status_message || '', result: result };
  }
  root.querySelectorAll('form[data-outside-form]').forEach(function (form) {
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var kind = form.getAttribute('data-outside-form');
      var confirmText = form.getAttribute('data-outside-confirm');
      if (confirmText && !window.confirm(confirmText)) return;
      var buttons = form.querySelectorAll('button');
      buttons.forEach(function (button) { button.disabled = true; });
      function fail(text) {
        message(form, text, true);
        buttons.forEach(function (button) { button.disabled = false; });
      }
      message(form, config.copy.saving, false);
      try {
        // The local unlock presents no credential at all: the boundary wants a
        // loopback browser and nothing else. Every other form carries the CSRF token.
        var body = kind === 'unlock' ? null : bodyFor(form, kind, event.submitter);
        var outcome = await send(paths[kind], body);
        if (!outcome.ok) return fail(outcome.text);
        var text = outcome.text;
        var result = outcome.result;
        message(form, text, false);
        if (kind === 'enable' && body && !body.replace_invalid) {
          // Say the new state at once, before the reload that redraws the card.
          var line = root.querySelector('[data-outside-state-text]');
          if (line) line.textContent = body.enabled ? config.copy.on : config.copy.off;
          if (line) line.setAttribute('data-outside-state', body.enabled ? 'on' : 'off');
        }
        if (typeof result.revision === 'number') root.setAttribute('data-revision', String(result.revision));
        if (result.restarting) {
          message(form, text + ' ' + config.copy.restarting, false);
          reloadWhenBack(4000);
        } else {
          setTimeout(function () { window.location.reload(); }, 900);
        }
      } catch (error) {
        fail(config.copy.failed);
      }
    });
  });
})();`;
}
