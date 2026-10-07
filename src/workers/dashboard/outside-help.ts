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
import type { ConsultDomainPacks, ConsultLanguage } from '../../core/consult-gate.ts';
import type { ZkapiConsultErrorCode } from '../../core/consult-transport-zkapi.ts';
import { ZKAPI_RISK_ACKNOWLEDGEMENTS } from '../../core/zkapi-consult-settings.ts';
import { escapeHtml, escapeScriptJson } from './components.ts';
import { DASHBOARD_OUTSIDE_HELP_COPY as W } from './vocabulary.ts';
import { fill } from './source-rows.ts';

/** One word for Setup's row. */
export interface DashboardOutsideHelpSummary {
  readonly state: 'off' | 'on' | 'invalid' | 'route_not_configured' | 'fence_held';
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
    readonly invalidReason?: string;
  };
  readonly route: DashboardOutsideHelpRoute;
  readonly languages: readonly DashboardOutsideHelpLanguage[];
  /** A policy write happened and the worker could not restart itself. */
  readonly restartPending: boolean;
}

/** The query flag the page answers to; same /dashboard path and auth as every page. */
export const DASHBOARD_OUTSIDE_HELP_QUERY_PARAM = 'outside-help';

/** The worker's four control routes, in one place for the page, the HTTP boundary and the public route list. */
export const DASHBOARD_OUTSIDE_HELP_PATHS = {
  enable: '/dashboard/consult',
  route: '/dashboard/consult/route',
  addRoute: '/dashboard/consult/route/add',
  recover: '/dashboard/consult/recover',
  abandon: '/dashboard/consult/abandon',
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

/**
 * The card body. `csrfToken` present means the reader holds the controls;
 * without it the card is read-only text (the worker also refuses every write
 * without the control session, so this is presentation, not the boundary).
 */
export function renderOutsideHelpCard(status: DashboardOutsideHelpStatus, input: { csrfToken?: string; basePath?: string }): string {
  const summary = summaryOf(status);
  const canEdit = input.csrfToken !== undefined;
  const route = status.route;
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const parts: string[] = [];
  parts.push(`<h2 class="ptitle">${escapeHtml(W.title)}</h2>`);
  parts.push(`<p class="ohlabel">${escapeHtml(W.experimental)}</p>`);
  parts.push(`<p class="pintro">${escapeHtml(W.intro)}</p>`);
  parts.push(`<p class="ohstate" data-outside-state="${escapeHtml(summary.state)}">${escapeHtml(outsideHelpStateLine(summary))}</p>`);
  if (status.restartPending) parts.push(`<p class="pnote ohwarn" data-outside-restart-pending>${escapeHtml(W.restartPending)}</p>`);

  // 1. The disclosure, always visible (design §A.10: up front).
  parts.push(`<div class="sect">${escapeHtml(W.disclosureTitle)}</div><ul class="ohlist">${W.disclosure.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`);

  // 2. The route and its readiness.
  parts.push(`<div class="sect">${escapeHtml(W.routeTitle)}</div>`);
  if (route.state === 'not_configured') {
    parts.push(`<p class="pnote" data-outside-route="not_configured">${escapeHtml(W.routeMissing)}</p>`);
    if (route.policyWritable) {
      parts.push(`<form class="ohform" data-outside-form="add-route" data-outside-confirm="${escapeHtml(W.addRouteConfirm)}">`
        + `<button type="submit" class="btn"${disabled}>${escapeHtml(W.addRoute)}</button>`
        + `<span class="actmsg" data-action-message role="status"></span></form>`);
    } else {
      parts.push(`<p class="pnote">${escapeHtml(W.policyNotFile)}</p>`);
    }
  } else {
    parts.push(renderReadiness(route));
  }
  parts.push(renderSetupSteps(route.state === 'configured' ? route.secretRef : `env:OLYMPUS_ZKAPI_API_KEY`));

  // 3. Cost and risk: the eight acknowledgements, the funding date, the optional caps.
  if (route.state === 'configured') {
    parts.push(renderAcknowledgements(route, canEdit));
  }

  // 4. A held request: Recover and Abandon, each explicit.
  if (route.state === 'configured' && route.readiness && route.readiness.fences.length > 0) {
    parts.push(renderFence(route.readiness, canEdit));
  }

  // 5. Languages and the switch.
  parts.push(renderEnable(status, summary, canEdit));

  const config = { csrfToken: input.csrfToken ?? '', paths: DASHBOARD_OUTSIDE_HELP_PATHS, copy: { saving: W.saving, failed: W.saveFailed, restarting: W.restarting } };
  const script = canEdit ? `<script>${outsideHelpClientScript(config)}</script>` : '';
  return `<div class="privacy outside" data-outside-help data-revision="${escapeHtml(String(status.settings.revision))}">${parts.join('')}</div>${script}`;
}

function renderReadiness(route: Extract<DashboardOutsideHelpRoute, { state: 'configured' }>): string {
  if (route.readinessUnavailable || !route.readiness) {
    return `<p class="pnote ohwarn" data-outside-route="unknown">${escapeHtml(W.readinessUnavailable)}</p>`;
  }
  const ready = route.readiness;
  const facts = [
    ready.daemonFound ? fill(W.facts.daemon, { version: ready.daemonVersion ?? W.facts.versionUnknown }) : W.facts.daemonMissing,
    ready.torFound ? W.facts.tor : W.facts.torMissing,
    ready.apiKeyConfigured ? W.facts.key : W.facts.keyMissing,
    fill(ready.requestsToday.count === 1 ? W.facts.todayOne : W.facts.today, { n: String(ready.requestsToday.count), usd: ready.spendToday.reservedUsd.toFixed(0) }),
    ready.expiry.state === 'active' && ready.expiry.expiryDate
      ? fill(W.facts.expiry, { date: ready.expiry.expiryDate, days: String(ready.expiry.daysLeft ?? '') })
      : ready.expiry.state === 'expired' ? W.facts.expired : W.facts.expiryUnknown,
  ];
  const blockers = ready.blockers.map((code) => `<li>${escapeHtml(outsideHelpBlockerWords(code))}</li>`).join('');
  const head = ready.ready
    ? `<p class="ohready" data-outside-route="ready">${escapeHtml(W.ready)}</p>`
    : `<p class="pnote ohwarn" data-outside-route="blocked">${escapeHtml(W.blocked)}</p><ul class="ohlist" data-outside-blockers>${blockers}</ul>`;
  return `${head}<ul class="ohfacts">${facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join('')}</ul>`
    + `<p class="pnote ohsmall">${escapeHtml(fill(W.routeLabel, { label: ready.routeLabel }))}</p>`;
}

function renderSetupSteps(secretRef: string): string {
  const steps = W.steps.map((step) => fill(step, { secretRef }));
  return `<details class="howto" data-outside-steps><summary>${escapeHtml(W.stepsTitle)}</summary>`
    + `<p>${escapeHtml(W.stepsIntro)}</p><ol class="ohsteps">${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol></details>`;
}

function renderAcknowledgements(route: Extract<DashboardOutsideHelpRoute, { state: 'configured' }>, canEdit: boolean): string {
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const accepted = new Set(route.acknowledgements.complete ? route.acknowledgements.accepted : []);
  const boxes = ZKAPI_RISK_ACKNOWLEDGEMENTS.map((entry) => `<label class="ohack"><input type="checkbox" name="acknowledged" value="${escapeHtml(entry.id)}"`
    + `${accepted.has(entry.id) ? ' checked' : ''}${disabled}><span>${escapeHtml(entry.statement)}</span></label>`).join('');
  const state = route.acknowledgements.complete ? W.acknowledged : W.notAcknowledged;
  return `<div class="sect">${escapeHtml(W.costTitle)}</div><p class="pnote">${escapeHtml(W.costIntro)}</p>`
    + `<p class="pnote" data-outside-acknowledged="${route.acknowledgements.complete ? 'yes' : 'no'}">${escapeHtml(state)}</p>`
    + `<form class="ohform" data-outside-form="route">${boxes}`
    + `<label class="plabel" for="outside-funding-date">${escapeHtml(W.fundingDate)}</label>`
    + `<input class="keyfield ptextline" id="outside-funding-date" name="funding_date" type="text" inputmode="numeric" autocomplete="off" placeholder="YYYY-MM-DD" value="${escapeHtml(route.fundingDate ?? '')}"${disabled}>`
    + `<label class="plabel" for="outside-cap-requests">${escapeHtml(W.capRequests)}</label>`
    + `<input class="keyfield ptextline" id="outside-cap-requests" name="daily_request_cap" type="number" min="1" step="1" value="${route.dailyRequestCap !== undefined ? escapeHtml(String(route.dailyRequestCap)) : ''}"${disabled}>`
    + `<label class="plabel" for="outside-cap-usd">${escapeHtml(W.capUsd)}</label>`
    + `<input class="keyfield ptextline" id="outside-cap-usd" name="daily_spend_cap_usd" type="number" min="1" step="1" value="${route.dailySpendCapUsd !== undefined ? escapeHtml(String(route.dailySpendCapUsd)) : ''}"${disabled}>`
    + `<p class="pnote ohsmall">${escapeHtml(W.saveRestarts)}</p>`
    + `<div class="pbuttons"><button type="submit" class="btn"${disabled}>${escapeHtml(W.saveRoute)}</button>`
    + `<span class="actmsg" data-action-message role="status"></span></div></form>`;
}

function renderFence(ready: DashboardOutsideHelpReadiness, canEdit: boolean): string {
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const mine = ready.fences.some((fence) => fence.thisWallet);
  const rows = ready.fences.map((fence) => `<li>${escapeHtml(fill(fence.thisWallet ? W.fenceThis : W.fenceOther, { at: fence.at.slice(0, 16).replace('T', ' ') }))}</li>`).join('');
  return `<div class="sect">${escapeHtml(W.fenceTitle)}</div><p class="pnote ohwarn" data-outside-fence>${escapeHtml(W.fenceIntro)}</p><ul class="ohlist">${rows}</ul>`
    + `<div class="ohfence">`
    + `<form class="ohform" data-outside-form="recover" data-outside-confirm="${escapeHtml(W.recoverConfirm)}">`
    + `<button type="submit" class="btn primary"${mine ? '' : ' disabled aria-disabled="true"'}${disabled}>${escapeHtml(W.recover)}</button>`
    + `<span class="hint">${escapeHtml(W.recoverHint)}</span><span class="actmsg" data-action-message role="status"></span></form>`
    + ready.fences.map((fence) => `<form class="ohform" data-outside-form="abandon" data-outside-scope="${escapeHtml(fence.scope)}" data-outside-confirm="${escapeHtml(W.abandonConfirm)}">`
      + `<button type="submit" class="btn quiet"${disabled}>${escapeHtml(W.abandon)}</button>`
      + `<span class="hint">${escapeHtml(W.abandonHint)}</span><span class="actmsg" data-action-message role="status"></span></form>`).join('')
    + `</div>`;
}

function renderEnable(status: DashboardOutsideHelpStatus, summary: DashboardOutsideHelpSummary, canEdit: boolean): string {
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const chosen = new Set(status.settings.languages);
  const languages = status.languages.map((entry) => {
    const name = LANGUAGE_NAMES[entry.language];
    const off = !entry.installed;
    return `<label class="ohack${off ? ' ohoff' : ''}"><input type="checkbox" name="languages" value="${escapeHtml(entry.language)}"`
      + `${chosen.has(entry.language) && !off ? ' checked' : ''}${off ? ' disabled aria-disabled="true"' : disabled}>`
      + `<span>${escapeHtml(name)}${off ? ` <span class="hint">${escapeHtml(W.packMissing)}</span>` : ''}</span></label>`;
  }).join('');
  const on = status.settings.state === 'on';
  const route = status.route;
  const blockedReason = status.settings.state === 'invalid'
    ? undefined
    : route.state === 'not_configured'
      ? W.enableBlockedRoute
      : !route.acknowledgements.complete ? W.enableBlockedAcks : undefined;
  const invalid = status.settings.state === 'invalid';
  const button = invalid
    ? `<button type="submit" class="btn primary" data-outside-replace${disabled}>${escapeHtml(W.replaceFile)}</button>`
    : on
      ? `<button type="submit" class="btn" data-outside-enabled="false"${disabled}>${escapeHtml(W.turnOff)}</button>`
      : blockedReason
        ? `<span class="blocked"><button type="button" class="btn primary" disabled aria-disabled="true">${escapeHtml(W.turnOn)}</button><span class="hint">${escapeHtml(blockedReason)}</span></span>`
        : `<button type="submit" class="btn primary" data-outside-enabled="true"${disabled}>${escapeHtml(W.turnOn)}</button>`;
  return `<div class="sect">${escapeHtml(W.languagesTitle)}</div><p class="pnote">${escapeHtml(W.languagesIntro)}</p>`
    + `<form class="ohform" data-outside-form="enable" data-outside-current="${on ? 'on' : 'off'}" data-outside-invalid="${invalid ? 'yes' : 'no'}">${languages}`
    + `<div class="pfooter"><p>${escapeHtml(W.automatic)}</p><div class="pbuttons">${button}</div>`
    + `<span class="actmsg" data-action-message role="status"></span></div></form>`
    + (summary.state === 'fence_held' ? '' : '');
}

/**
 * The card's own controller: five small forms posted as JSON with the control
 * session's CSRF token. Deliberately not the shared dashboard controller or
 * the Control UI action set: those are shared with the native surfaces, and
 * these routes exist for this page alone.
 */
export function outsideHelpClientScript(config: { csrfToken: string; paths: typeof DASHBOARD_OUTSIDE_HELP_PATHS; copy: { saving: string; failed: string; restarting: string } }): string {
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
  function bodyFor(form, kind, submitter) {
    var data = new FormData(form);
    if (kind === 'enable') {
      var invalid = form.getAttribute('data-outside-invalid') === 'yes';
      var enabled = invalid ? false : (submitter && submitter.getAttribute('data-outside-enabled') === 'true');
      var body = { enabled: enabled, revision: Number(root.getAttribute('data-revision') || '0'), languages: data.getAll('languages') };
      if (invalid) body.replace_invalid = true;
      return body;
    }
    if (kind === 'route') {
      return {
        acknowledged: data.getAll('acknowledged'),
        funding_date: String(data.get('funding_date') || ''),
        daily_request_cap: numberOrNull(data.get('daily_request_cap')),
        daily_spend_cap_usd: numberOrNull(data.get('daily_spend_cap_usd')),
      };
    }
    if (kind === 'abandon') return { confirm: true, scope: form.getAttribute('data-outside-scope') || '' };
    return { confirm: true };
  }
  var paths = { enable: config.paths.enable, route: config.paths.route, 'add-route': config.paths.addRoute, recover: config.paths.recover, abandon: config.paths.abandon };
  root.querySelectorAll('form[data-outside-form]').forEach(function (form) {
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var kind = form.getAttribute('data-outside-form');
      var confirmText = form.getAttribute('data-outside-confirm');
      if (confirmText && !window.confirm(confirmText)) return;
      var buttons = form.querySelectorAll('button');
      buttons.forEach(function (button) { button.disabled = true; });
      message(form, config.copy.saving, false);
      try {
        var response = await fetch(paths[kind], {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'X-Olympus-CSRF': config.csrfToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyFor(form, kind, event.submitter)),
        });
        var result = {};
        try { result = await response.json(); } catch (error) { result = {}; }
        if (!response.ok || !result.ok) {
          message(form, (result.error && result.error.message) || config.copy.failed, true);
          buttons.forEach(function (button) { button.disabled = false; });
          return;
        }
        message(form, result.status_message || '', false);
        if (result.restarting) {
          message(form, (result.status_message || '') + ' ' + config.copy.restarting, false);
          setTimeout(function () { window.location.reload(); }, 6000);
        } else {
          setTimeout(function () { window.location.reload(); }, 1200);
        }
      } catch (error) {
        message(form, config.copy.failed, true);
        buttons.forEach(function (button) { button.disabled = false; });
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
  return `<div class="sect" id="outside-help">${escapeHtml(W.title)}</div>`
    + `<div class="srows"><div class="srow nodot" data-outside-help-row><div class="smain"><p class="sline strong">${escapeHtml(outsideHelpStateLine(summary))}</p></div>`
    + `<div class="sact"><a class="btn" href="${escapeHtml(href)}">${escapeHtml(label)}</a></div></div></div>`;
}
