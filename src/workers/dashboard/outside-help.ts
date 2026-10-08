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
 * configuration is ever in the status, so none can reach the page.
 */
import type { ConsultDomainPacks, ConsultLanguage, ConsultLevel } from '../../core/consult-gate.ts';
import type { ZkapiConsultErrorCode } from '../../core/consult-transport-zkapi.ts';
import { ZKAPI_RISK_ACKNOWLEDGEMENTS } from '../../core/zkapi-consult-settings.ts';
import { escapeHtml, escapeScriptJson } from './components.ts';
import { DASHBOARD_OUTSIDE_HELP_COPY as W } from './vocabulary.ts';
import { fill } from './source-rows.ts';
import {
  DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH,
  DASHBOARD_OUTSIDE_HELP_TOOLS_COPY,
  outsideHelpToolsNeedAttention,
  renderOutsideHelpTools,
  renderOutsideHelpToolsFix,
  renderOutsideHelpToolsScript,
  type DashboardOutsideHelpTools,
} from './outside-help-tools.ts';

/** One word for Setup's row. */
export interface DashboardOutsideHelpSummary {
  /** `needs_acceptance`: on, but paused until the current statements are accepted. */
  readonly state: 'off' | 'on' | 'invalid' | 'route_not_configured' | 'fence_held' | 'needs_acceptance';
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
} as const;

export function outsideHelpHref(basePath = '/dashboard'): string {
  return `${basePath}${basePath.includes('?') ? '&' : '?'}${DASHBOARD_OUTSIDE_HELP_QUERY_PARAM}`;
}

/** The one-line state Setup's row and the card both open with. */
export function outsideHelpStateLine(summary: DashboardOutsideHelpSummary): string {
  return W.state[summary.state];
}

export function summaryOf(status: DashboardOutsideHelpStatus): DashboardOutsideHelpSummary {
  if (status.settings.state === 'invalid') return { state: 'invalid' };
  if (status.route.state === 'not_configured') return { state: 'route_not_configured' };
  if (status.route.state === 'configured' && status.route.readiness && status.route.readiness.fences.length > 0) return { state: 'fence_held' };
  if (status.settings.state === 'on' && status.route.state === 'configured' && !status.route.acknowledgements.complete) return { state: 'needs_acceptance' };
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

type ConfiguredRoute = Extract<DashboardOutsideHelpRoute, { state: 'configured' }>;

/** Blockers the Balance and limits section fixes: it opens when one is present. */
const LIMIT_BLOCKERS: ReadonlySet<string> = new Set(['funding_date_missing', 'funding_date_invalid', 'note_expired', 'daily_cap_reached', 'spend_cap_reached']);
/** Blockers the setup steps fix. */
const SETUP_BLOCKERS: ReadonlySet<string> = new Set(['daemon_not_found', 'daemon_version_unsupported', 'tor_not_found', 'daemon_api_key_missing', 'key_reuse_on']);

/**
 * The card body. `csrfToken` present means the reader holds the controls;
 * without it the card is read-only text (the worker also refuses every write
 * without the control session, so this is presentation, not the boundary).
 *
 * Layout (owner redesign, 2026-10-07): one status block (the switch, route
 * health in one line, today's usage), one list of problems each with its fix,
 * three short lines before turning on with the full statements behind a
 * disclosure, the acknowledgements collapsed once accepted, and the secondary
 * sections (languages, balance and limits, a held request, setup, details)
 * collapsed unless they need attention.
 */
export function renderOutsideHelpCard(status: DashboardOutsideHelpStatus, input: { csrfToken?: string; localSession?: boolean; basePath?: string }): string {
  const summary = summaryOf(status);
  // Controls only for a local-grade session: a bearer-grade session (the
  // launch flow, or a bearer mint) reads the card and is offered the local
  // unlock, which the worker's HTTP boundary grants to a loopback browser
  // presenting no bearer.
  const canEdit = input.csrfToken !== undefined && input.localSession === true;
  const canUnlock = input.csrfToken !== undefined && input.localSession !== true;
  const route = status.route;
  const blockers = route.state === 'configured' && route.readiness ? route.readiness.blockers : [];
  const parts: string[] = [];
  parts.push(`<h2 class="ptitle">${escapeHtml(W.title)}</h2>`);
  parts.push(`<p class="ohlabel">${escapeHtml(W.experimental)}</p>`);
  parts.push(`<p class="pintro">${escapeHtml(W.intro)}</p>`);
  parts.push(`<p class="pnote" data-outside-privacy>${escapeHtml(W.privacy)}</p>`);
  if (status.restartPending) parts.push(`<p class="pnote ohwarn" data-outside-restart-pending>${escapeHtml(W.restartPending)}</p>`);
  if (canUnlock) {
    parts.push(`<form class="ohform ohunlock" data-outside-form="unlock" data-outside-unlock><p class="pnote">${escapeHtml(W.unlockIntro)}</p>`
      + `<div class="pbuttons"><button type="submit" class="btn primary">${escapeHtml(W.unlock)}</button></div>`
      + `<span class="actmsg" data-action-message role="status"></span></form>`);
  }

  // 1. The status block: the switch, the route in one line, today's usage.
  parts.push(renderStatusBlock(status, summary, canEdit));

  // 1b. What zkAPI may send: the two levels.
  parts.push(renderLevel(status, canEdit));

  // 2. Problems, one list, each line with its fix.
  parts.push(renderProblems(status, canEdit));

  // 3. The disclosure (design §A.10: up front) while outside help is off:
  // two short lines, the rest one click away. Once it is on, the same
  // content moves into its own collapsed section below.
  const shortList = `<ul class="ohshort" data-outside-disclosure>${W.disclosureShort.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
  const fullList = `<ul class="ohlist">${W.disclosure.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
  const on = status.settings.state === 'on';
  if (!on) {
    parts.push(`<div class="sect">${escapeHtml(W.disclosureTitle)}</div>${shortList}`
      + `<details class="howto" data-outside-disclosure-more><summary>${escapeHtml(W.disclosureMore)}</summary>${fullList}</details>`);
  }

  // 4. The statements: one line once accepted; otherwise, while Strict is
  // chosen, here with one Accept (with Standard chosen they sit inside
  // What may zkAPI send?, beside the choice that needs them).
  if (route.state === 'configured') parts.push(renderAcknowledgements(route, status.settings.level, canEdit));

  // 5. Secondary sections, collapsed unless they need attention.
  const more: string[] = [];
  if (route.state === 'configured' && route.readiness && route.readiness.fences.length > 0) more.push(renderFence(route.readiness, canEdit));
  more.push(renderLanguages(status, canEdit));
  if (route.state === 'configured') more.push(renderLimits(route, blockers, canEdit));
  more.push(renderSetupSteps(
    route.state === 'configured' ? route.secretRef : `env:OLYMPUS_ZKAPI_API_KEY`,
    route.state === 'not_configured' || blockers.some((code) => SETUP_BLOCKERS.has(code)) || outsideHelpToolsNeedAttention(status.tools),
    renderOutsideHelpTools(status.tools, { canEdit }),
  ));
  if (route.state === 'configured') more.push(renderDetails(route));
  if (on) more.push(renderSection({ id: 'disclosure', title: W.disclosureMore, summary: '', open: false, body: `<div data-outside-disclosure-more>${shortList}${fullList}</div>` }));
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
      levelSave: W.levelSave,
      levelAcceptSave: W.levelAcceptSave,
    },
  };
  const script = canEdit || canUnlock ? `<script>${outsideHelpClientScript(config)}</script>` : '';
  const toolsScript = renderOutsideHelpToolsScript(status.tools, { canEdit, ...(input.csrfToken !== undefined ? { csrfToken: input.csrfToken } : {}) });
  return `<div class="privacy outside" data-outside-help data-revision="${escapeHtml(String(status.settings.revision))}">${parts.join('')}</div>${script}${toolsScript}`;
}

function renderStatusBlock(status: DashboardOutsideHelpStatus, summary: DashboardOutsideHelpSummary, canEdit: boolean): string {
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const route = status.route;
  const on = status.settings.state === 'on';
  const invalid = status.settings.state === 'invalid';
  const blockedReason = invalid
    ? undefined
    : route.state === 'not_configured'
      ? W.enableBlockedRoute
      : !route.acknowledgements.complete ? W.enableBlockedAcks : undefined;
  const button = invalid
    ? `<button type="submit" class="btn primary" data-outside-replace${disabled}>${escapeHtml(W.replaceFile)}</button>`
    : on
      ? `<button type="submit" class="btn" data-outside-enabled="false"${disabled}>${escapeHtml(W.turnOff)}</button>`
      : blockedReason
        ? `<span class="blocked"><button type="button" class="btn primary" disabled aria-disabled="true">${escapeHtml(W.turnOn)}</button><span class="hint">${escapeHtml(blockedReason)}</span></span>`
        : `<button type="submit" class="btn primary" data-outside-enabled="true"${disabled}>${escapeHtml(W.turnOn)}</button>`;
  const tone = summary.state === 'on' ? 'on' : summary.state === 'off' ? 'off' : 'attn';
  const head = `<div class="ohhead"><p class="ohstate"><span class="dot ${tone}" aria-hidden="true"></span>`
    + `<span data-outside-state-text data-outside-state="${escapeHtml(summary.state)}">${escapeHtml(outsideHelpStateLine(summary))}</span></p>`
    + `<div class="pbuttons">${button}</div></div>`;
  const lines: string[] = [renderRouteLine(route)];
  if (route.state === 'configured' && route.readiness) lines.push(`<p class="ohline" data-outside-usage>${escapeHtml(usageLine(route.readiness))}</p>`);
  return `<form class="ohpanel" data-outside-form="enable" data-outside-current="${on ? 'on' : 'off'}" data-outside-invalid="${invalid ? 'yes' : 'no'}">`
    + head + lines.join('')
    + `<p class="ohsmall" data-outside-cost>${escapeHtml(W.costLine)}</p>`
    + `<span class="actmsg" data-action-message role="status"></span></form>`;
}

/**
 * "What may zkAPI send?": Standard (recommended, the default) and Strict,
 * saved through the same local-grade, CSRF-protected settings route as the
 * switch (the worker re-checks every rule). Both are always selectable.
 * While the current statements are not accepted, choosing Standard shows
 * them right here with one "Accept and save": the level is saved, then the
 * statements are recorded. Saving a level alone is never refused for them;
 * nothing is sent until they are accepted, and the card says so.
 */
function renderLevel(status: DashboardOutsideHelpStatus, canEdit: boolean): string {
  const invalid = status.settings.state === 'invalid';
  const route = status.route;
  const needsAcceptance = route.state === 'configured' && !route.acknowledgements.complete;
  const current = status.settings.level;
  const blocked = !canEdit || invalid ? ' disabled aria-disabled="true"' : '';
  const options = (['unnamed', 'general'] as const).map((level) => {
    const copy = W.levels[level];
    return `<label class="ohack ohlevel"><input type="radio" name="level" value="${level}"${level === current ? ' checked' : ''}${blocked}>`
      + `<span><strong>${escapeHtml(copy.title)}</strong> ${escapeHtml(copy.body)}</span></label>`;
  }).join('');
  const accepting = needsAcceptance && current === 'unnamed';
  const acceptBlock = needsAcceptance
    ? `<div class="ohaccept" data-outside-level-acks${accepting ? '' : ' hidden'}>`
      + `<p class="pnote">${escapeHtml(W.levelAcceptIntro)}</p>${renderStatements(true)}</div>`
    : '';
  return `<form class="ohform" data-outside-form="level" data-outside-level="${escapeHtml(current)}" data-outside-current="${status.settings.state === 'on' ? 'on' : 'off'}">`
    + `<div class="sect">${escapeHtml(W.levelTitle)}</div>${options}${acceptBlock}`
    + `<div class="pbuttons"><button type="submit" class="btn${accepting ? ' primary' : ''}" data-outside-level-save${blocked}>${escapeHtml(accepting ? W.levelAcceptSave : W.levelSave)}</button></div>`
    + `<span class="actmsg" data-action-message role="status"></span></form>`;
}

/** The current statements as a plain list; with `inputs`, the ids an Accept posts. */
function renderStatements(inputs: boolean): string {
  return `<ul class="ohlist" data-outside-statements>${ZKAPI_RISK_ACKNOWLEDGEMENTS.map((entry) => `<li data-statement="${escapeHtml(entry.id)}">${escapeHtml(entry.statement)}</li>`).join('')}</ul>`
    + (inputs ? ZKAPI_RISK_ACKNOWLEDGEMENTS.map((entry) => `<input type="hidden" name="acknowledged" value="${escapeHtml(entry.id)}">`).join('') : '');
}

function renderRouteLine(route: DashboardOutsideHelpRoute): string {
  if (route.state === 'not_configured') return `<p class="ohline attn" data-outside-route="not_configured">${escapeHtml(W.routeMissingShort)}</p>`;
  if (route.readinessUnavailable || !route.readiness) return `<p class="ohline attn" data-outside-route="unknown">${escapeHtml(W.routeUnknown)}</p>`;
  const ready = route.readiness;
  if (ready.ready) {
    // Tor off is said where the reader looks first: the provider sees the address.
    return ready.torMode === 'off'
      ? `<p class="ohline good" data-outside-route="ready">${escapeHtml(W.routeReadyNoTor)} <span class="attn">${escapeHtml(W.addressVisible)}</span></p>`
      : `<p class="ohline good" data-outside-route="ready">${escapeHtml(W.routeReady)}</p>`;
  }
  // The statements are said once, where they are accepted (and by the state line), never again here.
  const others = ready.blockers.filter((code) => code !== 'acknowledgements_incomplete');
  if (others.length === 0) return `<p class="ohline" data-outside-route="ready_but_statements">${escapeHtml(W.routeReadyButStatements)}</p>`;
  const first = others[0];
  const reason = first ? outsideHelpBlockerWords(first) : W.routeUnknown;
  const more = others.length > 1 ? ` ${fill(W.routeMore, { n: String(others.length - 1) })}` : '';
  return `<p class="ohline attn" data-outside-route="blocked">${escapeHtml(fill(W.routeNotReady, { reason }))}${escapeHtml(more)}</p>`
    + (ready.torMode === 'off' ? `<p class="ohline attn">${escapeHtml(W.addressVisible)}</p>` : '');
}

function usageLine(ready: DashboardOutsideHelpReadiness): string {
  const count = ready.requestsToday.count;
  const pieces = [count === 0 ? W.usageNone : count === 1 ? W.usageOne : fill(W.usageMany, { n: String(count) })];
  // The ledger records the $6 hold per question, never the settled price, so
  // the day's figure is what counts against limits, never money spent.
  const head = count > 0 ? `${pieces[0]} ${fill(W.usageCounted, { usd: ready.spendToday.reservedUsd.toFixed(0) })}` : pieces[0]!;
  pieces.splice(0, 1, head);
  pieces.push(ready.expiry.state === 'active' && ready.expiry.expiryDate
    ? fill(W.usageExpiry, { date: shortDate(ready.expiry.expiryDate), days: String(ready.expiry.daysLeft ?? '') })
    : ready.expiry.state === 'expired' ? W.usageExpired : W.usageExpiryUnknown);
  return pieces.join(' · ');
}

function renderProblems(status: DashboardOutsideHelpStatus, canEdit: boolean): string {
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const route = status.route;
  const items: string[] = [];
  if (route.state === 'not_configured') {
    const action = route.policyWritable
      ? `<form class="ohform" data-outside-form="add-route" data-outside-confirm="${escapeHtml(W.addRouteConfirm)}">`
        + `<button type="submit" class="btn"${disabled}>${escapeHtml(W.addRoute)}</button>`
        + `<span class="actmsg" data-action-message role="status"></span></form>`
      : '';
    items.push(`<li data-outside-route-missing><span>${escapeHtml(route.policyWritable ? W.routeMissing : W.policyNotFile)}</span>${action}</li>`);
  } else if (route.readinessUnavailable || !route.readiness) {
    items.push(`<li><span>${escapeHtml(W.routeUnknown)}</span></li>`);
  } else {
    for (const code of route.readiness.blockers) {
      // Said once, beside the statements themselves (inline under Standard, or Cost and risk).
      if (code === 'acknowledgements_incomplete') continue;
      const tool = TOOL_BLOCKERS.get(code);
      const entry = tool ? status.tools?.tools.find((item) => item.tool === tool) : undefined;
      // Missing and installable: the parts' own To fix line (below) says it, with its button.
      if (entry?.source === 'missing') continue;
      // A path set in the route: the button cannot fix it, so it is said plainly.
      const words = entry?.source === 'configured_missing'
        ? fill(DASHBOARD_OUTSIDE_HELP_TOOLS_COPY.configuredMissing, { tool: entry.label, path: entry.path ?? '' })
        : outsideHelpBlockerWords(code);
      items.push(`<li${entry ? ` data-outside-blocker="${escapeHtml(code)}"` : ''}><span>${escapeHtml(words)}</span></li>`);
    }
  }
  // Missing programs: one line with the install button (or its progress).
  const tools = renderOutsideHelpToolsFix(status.tools, { canEdit });
  if (tools) items.unshift(tools);
  if (items.length === 0) return '';
  return `<div class="sect attn">${escapeHtml(W.problemsTitle)}</div><ul class="ohfix" data-outside-blockers>${items.join('')}</ul>`;
}

function renderSection(input: { id: string; title: string; summary: string; open: boolean; body: string; attn?: boolean }): string {
  return `<details class="ohsect" data-outside-section="${escapeHtml(input.id)}"${input.open ? ' open' : ''}>`
    + `<summary><span class="ohsect-title${input.attn ? ' attn' : ''}">${escapeHtml(input.title)}</span><span class="ohsect-sum">${escapeHtml(input.summary)}</span></summary>`
    + `<div class="ohsect-body">${input.body}</div></details>`;
}

/** The not-installed blockers the parts' own "To fix" line (outside-help-tools.ts) stands in for. */
const TOOL_BLOCKERS: ReadonlyMap<string, 'zkapi-clientd' | 'tor'> = new Map([['daemon_not_found', 'zkapi-clientd'], ['tor_not_found', 'tor']]);

function renderSetupSteps(secretRef: string, needed: boolean, tools = ''): string {
  const steps = W.steps.map((step) => fill(step, { secretRef }));
  return renderSection({
    id: 'steps',
    title: W.stepsTitle,
    summary: '',
    open: needed,
    attn: needed,
    body: `${tools}<div data-outside-steps><p class="pnote">${escapeHtml(W.stepsIntro)}</p><ol class="ohsteps">${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol></div>`,
  });
}

function renderAcknowledgements(route: ConfiguredRoute, level: ConsultLevel, canEdit: boolean): string {
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const n = String(ZKAPI_RISK_ACKNOWLEDGEMENTS.length);
  if (route.acknowledgements.complete) {
    // Accepted at the current wording: one line, the statements one click away.
    return `<div class="sect">${escapeHtml(W.costTitle)}</div>`
      + `<p class="pnote" data-outside-acknowledged="yes">${escapeHtml(fill(W.acknowledged, { n }))}</p>`
      + `<details class="howto" data-outside-ack-review><summary>${escapeHtml(W.acknowledgedReview)}</summary>${renderStatements(false)}</details>`;
  }
  // Not accepted: with Standard chosen the statements sit in What may zkAPI
  // send? (one Accept and save); with Strict, here, with one Accept.
  return `<div data-outside-ack-standalone${level === 'unnamed' ? ' hidden' : ''}>`
    + `<div class="sect attn">${escapeHtml(W.costTitle)}</div>`
    + `<p class="pnote" data-outside-acknowledged="no">${escapeHtml(W.costIntro)}</p>`
    + `<form class="ohform" data-outside-form="route" data-outside-accept>${renderStatements(true)}`
    + `<div class="pbuttons"><button type="submit" class="btn primary"${disabled}>${escapeHtml(W.accept)}</button>`
    + `<span class="hint">${escapeHtml(W.saveRestarts)}</span></div>`
    + `<span class="actmsg" data-action-message role="status"></span></form></div>`;
}

function renderLimits(route: ConfiguredRoute, blockers: readonly string[], canEdit: boolean): string {
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const capped = route.dailyRequestCap !== undefined || route.dailySpendCapUsd !== undefined;
  const limit = capped
    ? [
      ...(route.dailyRequestCap !== undefined ? [fill(W.limitsRequests, { n: String(route.dailyRequestCap) })] : []),
      ...(route.dailySpendCapUsd !== undefined ? [fill(W.limitsUsd, { usd: String(route.dailySpendCapUsd) })] : []),
    ].join(', ')
    : W.limitsNone;
  const funded = route.fundingDate ? fill(W.fundedOn, { date: shortDate(route.fundingDate) }) : W.notFunded;
  const needed = blockers.some((code) => LIMIT_BLOCKERS.has(code));
  // The one-click "no daily limit": clears both caps through the same
  // transactional policy write as Save.
  const noLimit = capped
    ? `<form class="ohform ohinline" data-outside-form="route" data-outside-nolimit>`
      + `<div class="pbuttons"><button type="submit" class="btn primary"${disabled}>${escapeHtml(W.removeLimits)}</button><span class="hint">${escapeHtml(W.removeLimitsHint)}</span></div>`
      + `<span class="actmsg" data-action-message role="status"></span></form>`
    : `<p class="pnote">${escapeHtml(W.noLimitIntro)}</p>`;
  const today = route.readiness && route.readiness.requestsToday.count > 0
    ? `<p class="pnote" data-outside-limits-today>${escapeHtml(fill(W.limitsToday, { n: String(route.readiness.requestsToday.count), usd: route.readiness.spendToday.reservedUsd.toFixed(0) }))}</p>`
    : '';
  const body = today + noLimit
    + `<form class="ohform" data-outside-form="route">`
    + `<label class="plabel" for="outside-funding-date">${escapeHtml(W.fundingDate)}</label>`
    + `<input class="keyfield ptextline" id="outside-funding-date" name="funding_date" type="text" inputmode="numeric" autocomplete="off" placeholder="YYYY-MM-DD" value="${escapeHtml(route.fundingDate ?? '')}"${disabled}>`
    + `<label class="plabel" for="outside-cap-requests">${escapeHtml(W.capRequests)}</label>`
    + `<input class="keyfield ptextline" id="outside-cap-requests" name="daily_request_cap" type="number" min="1" step="1" value="${route.dailyRequestCap !== undefined ? escapeHtml(String(route.dailyRequestCap)) : ''}"${disabled}>`
    + `<label class="plabel" for="outside-cap-usd">${escapeHtml(W.capUsd)}</label>`
    + `<input class="keyfield ptextline" id="outside-cap-usd" name="daily_spend_cap_usd" type="number" min="1" step="1" value="${route.dailySpendCapUsd !== undefined ? escapeHtml(String(route.dailySpendCapUsd)) : ''}"${disabled}>`
    + `<div class="pbuttons"><button type="submit" class="btn" data-outside-save-limits${disabled}>${escapeHtml(W.saveRoute)}</button><span class="hint">${escapeHtml(W.saveRestarts)}</span></div>`
    + `<span class="actmsg" data-action-message role="status"></span></form>`;
  return renderSection({ id: 'limits', title: W.limitsTitle, summary: `${limit} · ${funded}`, open: needed, attn: needed, body });
}

function renderFence(ready: DashboardOutsideHelpReadiness, canEdit: boolean): string {
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const mine = ready.fences.some((fence) => fence.thisWallet);
  const rows = ready.fences.map((fence) => `<li>${escapeHtml(fill(fence.thisWallet ? W.fenceThis : W.fenceOther, { at: fence.at.slice(0, 16).replace('T', ' ') }))}</li>`).join('');
  const body = `<p class="pnote ohwarn" data-outside-fence>${escapeHtml(W.fenceIntro)}</p><ul class="ohlist">${rows}</ul>`
    + `<div class="ohfence">`
    + `<form class="ohform" data-outside-form="recover" data-outside-confirm="${escapeHtml(W.recoverConfirm)}">`
    + `<button type="submit" class="btn primary"${mine ? '' : ' disabled aria-disabled="true"'}${disabled}>${escapeHtml(W.recover)}</button>`
    + `<span class="hint">${escapeHtml(W.recoverHint)}</span><span class="actmsg" data-action-message role="status"></span></form>`
    + ready.fences.map((fence) => `<form class="ohform" data-outside-form="abandon" data-outside-scope="${escapeHtml(fence.scope)}" data-outside-confirm="${escapeHtml(W.abandonConfirm)}">`
      + `<button type="submit" class="btn quiet"${disabled}>${escapeHtml(W.abandon)}</button>`
      + `<span class="hint">${escapeHtml(W.abandonHint)}</span><span class="actmsg" data-action-message role="status"></span></form>`).join('')
    + `</div>`;
  return renderSection({ id: 'fence', title: W.fenceTitle, summary: '', open: true, attn: true, body });
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

function renderDetails(route: ConfiguredRoute): string {
  if (route.readinessUnavailable || !route.readiness) return '';
  const ready = route.readiness;
  const facts = [
    ready.daemonFound ? fill(W.facts.daemon, { version: ready.daemonVersion ?? W.facts.versionUnknown }) : W.facts.daemonMissing,
    ready.torMode === 'off' ? W.facts.torOff : ready.torFound ? W.facts.tor : W.facts.torMissing,
    ready.apiKeyConfigured ? W.facts.key : W.facts.keyMissing,
    fill(ready.requestsToday.count === 1 ? W.facts.todayOne : W.facts.today, { n: String(ready.requestsToday.count), usd: ready.spendToday.reservedUsd.toFixed(0) }),
    ready.expiry.state === 'active' && ready.expiry.expiryDate
      ? fill(W.facts.expiry, { date: ready.expiry.expiryDate, days: String(ready.expiry.daysLeft ?? '') })
      : ready.expiry.state === 'expired' ? W.facts.expired : W.facts.expiryUnknown,
    fill(W.routeLabel, { label: ready.routeLabel }),
    ...(ready.lastSession ? [fill(W.lastSession, { at: ready.lastSession.at.slice(0, 16).replace('T', ' '), result: ready.lastSession.result })] : []),
  ];
  return renderSection({
    id: 'details',
    title: W.detailsTitle,
    summary: '',
    open: false,
    body: `<ul class="ohfacts" data-outside-facts>${facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join('')}</ul>`,
  });
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
  levelSave: string;
  levelAcceptSave: string;
}

export function outsideHelpClientScript(config: { csrfToken: string; paths: typeof DASHBOARD_OUTSIDE_HELP_PATHS; copy: OutsideHelpClientCopy }): string {
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
  // Standard chosen while the statements are not accepted: they show inline,
  // and the button reads Accept and save. Strict: the button is a plain Save,
  // and the statements show in their own section instead.
  var levelForm = root.querySelector('form[data-outside-form="level"]');
  var levelAcks = levelForm ? levelForm.querySelector('[data-outside-level-acks]') : null;
  var standalone = root.querySelector('[data-outside-ack-standalone]');
  function levelAccepting() {
    var picked = levelForm ? levelForm.querySelector('input[name="level"]:checked') : null;
    return Boolean(levelAcks) && Boolean(picked) && picked.value === 'unnamed';
  }
  function syncLevel() {
    if (!levelForm || !levelAcks) return;
    var accepting = levelAccepting();
    if (accepting) levelAcks.removeAttribute('hidden'); else levelAcks.setAttribute('hidden', '');
    if (standalone) { if (accepting) standalone.setAttribute('hidden', ''); else standalone.removeAttribute('hidden'); }
    var save = levelForm.querySelector('[data-outside-level-save]');
    if (save) {
      save.textContent = accepting ? config.copy.levelAcceptSave : config.copy.levelSave;
      if (accepting) save.classList.add('primary'); else save.classList.remove('primary');
    }
  }
  if (levelForm) {
    levelForm.querySelectorAll('input[name="level"]').forEach(function (input) { input.addEventListener('change', syncLevel); });
  }
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
      // On or off as the status line says now (the switch updates it in place), so saving a level never flips the switch.
      var state = root.querySelector('[data-outside-state-text]');
      var current = state ? state.getAttribute('data-outside-state') : form.getAttribute('data-outside-current');
      return { enabled: current === 'on' || current === 'needs_acceptance', revision: Number(root.getAttribute('data-revision') || '0'), level: picked ? picked.value : form.getAttribute('data-outside-level') };
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
  var paths = { unlock: config.paths.unlock, enable: config.paths.enable, level: config.paths.enable, route: config.paths.route, 'add-route': config.paths.addRoute, recover: config.paths.recover, abandon: config.paths.abandon };
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
        var accepting = kind === 'level' && levelAccepting();
        var body = kind === 'unlock' ? null : bodyFor(form, kind, event.submitter);
        var outcome = await send(paths[kind], body);
        if (!outcome.ok) return fail(outcome.text);
        var text = outcome.text;
        var result = outcome.result;
        if (accepting) {
          // Accept and save: the level is saved; now record the statements.
          if (typeof result.revision === 'number') root.setAttribute('data-revision', String(result.revision));
          var accepted = await send(config.paths.route, { acknowledged: statementIds(levelAcks) });
          if (!accepted.ok) return fail(accepted.text);
          text = accepted.text;
          result = accepted.result;
        }
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

/** Setup's row: one line and a link to the card. */
export function renderOutsideHelpSection(summary: DashboardOutsideHelpSummary | undefined, basePath?: string): string {
  if (!summary) return '';
  const href = outsideHelpHref(basePath);
  const label = summary.state === 'route_not_configured' ? W.setUp : W.edit;
  return `<div class="sect" id="outside-help">${escapeHtml(W.sectionTitle)}</div>`
    + `<div class="srows"><div class="srow nodot" data-outside-help-row><div class="smain"><p class="sline strong">${escapeHtml(W.row[summary.state])}</p></div>`
    + `<div class="sact"><a class="btn" href="${escapeHtml(href)}">${escapeHtml(label)}</a></div></div></div>`;
}
