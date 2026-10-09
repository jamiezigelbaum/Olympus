/**
 * The page's shared HTML pieces: status glyphs, cards, rows, the connector
 * sheet, and the standalone bootstrap for the shared browser controller.
 *
 * Every dynamic value that reaches a page goes through escapeHtml here, and
 * every serialized view model through escapeScriptJson. Both are implemented
 * rather than stubbed so the three pages cannot each grow their own copy.
 */
import { createHash } from 'node:crypto';
import { mountDashboardController } from '../../control-ui/browser-controller.ts';
import { DASHBOARD_SAVED_SECRET_FIELD_VALUE, isGoogleOAuthSource } from '../source-dashboard.ts';
import type {
  DashboardCallbackRegistration,
  DashboardConnectField,
  DashboardConnectFieldName,
  DashboardSourceAction,
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../source-dashboard.ts';
import { DASHBOARD_STATUS_COLORS, DASHBOARD_THEME_CSS } from './theme.ts';
import { DASHBOARD_WORKER_TOKEN_AGENT_PROMPT, dashboardActionLabel, type DashboardStatus } from './vocabulary.ts';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeScriptJson(value: string): string {
  return value.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

/** Circumference of the wedge circle: 2π × r, r = 2. */
const DONUT_CIRCUMFERENCE = 12.566;

/**
 * Glyph colors are a literal hex or one theme variable (so a glyph follows the
 * light or dark theme); anything else is a style injection.
 */
const SAFE_COLOR = /^(?:#[0-9A-Fa-f]{3,8}|var\(--[a-z0-9-]+\))$/;

function safeColor(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return SAFE_COLOR.test(trimmed) ? trimmed : fallback;
}

function clampFraction(value: number): number {
  // A missing ratio reads as no progress, never as full.
  if (Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Ids reach the page twice — as an attribute and inside a CSS selector — so
 * they are reduced to characters that are safe in both.
 */
function safeId(value: string): string {
  const reduced = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return reduced === '' ? 'sheet' : reduced;
}

/** A href we will not render at all rather than render as a script trigger. */
export function safeHref(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return undefined;
  // Dashboard links are same-document targets and nothing else, so a scheme of
  // any kind is refused rather than reasoned about.
  if (!/^[/?#]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * The one exception to safeHref: a provider's own console, which a setup blurb
 * has to be able to point at ("where the key lives").
 *
 * Parsed rather than pattern-matched, and https only — a javascript: or data:
 * URL never survives `new URL(...).protocol`, and a provider console that is
 * not on TLS is not a link this page will offer.
 */
export function safeExternalHref(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export interface DashboardExternalLinkInput {
  label: string;
  /** https:// only; anything else renders nothing at all. */
  url: string;
}

/**
 * A link out to a provider's console, opened in its own tab.
 *
 * rel carries noopener AND noreferrer: the new tab must not reach back through
 * window.opener, and the dashboard URL — which carries the read-only view token
 * in its query string on every browser visit — must never travel in a Referer
 * header to a provider.
 */
export function externalLink(input: DashboardExternalLinkInput): string {
  const href = safeExternalHref(input.url);
  if (href === undefined) return '';
  return `<a class="ext" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(input.label)}</a>`;
}

export interface DashboardPageShellInput {
  /** Page <title> and the header's left-hand brand line. */
  title: string;
  /** Trailing crumb after "Olympus /", e.g. a source label. */
  crumb?: string;
  /** Where the brand lead links back to on crumb pages. Defaults to /dashboard. */
  basePath?: string;
  /** Header's right-hand meta line. */
  meta: string;
  /** Already-escaped page body markup. */
  body: string;
  /** Already-built inline scripts, in order. */
  scripts?: readonly string[];
  /**
   * Extra stylesheet text for the pages that need it, inlined after the theme.
   * Never reader data: these are module constants, like the theme itself.
   */
  styles?: readonly string[];
  /**
   * Present when the page polls itself; the signature is taken from `body`.
   * `unlocked` is the custody state this render was made under: a poll that
   * sees it change reloads the page, because swapped-in markup does not run
   * its scripts and the control handler would keep a stale CSRF token.
   */
  poll?: { intervalMs?: number; unlocked?: boolean; controlSessionCsrfToken?: string };
  /** Inert body-only output for the native Control UI host. */
  format?: 'document' | 'fragment';
  /** Use the shared browser controller for the standalone worker page. */
  controller?: { csrfToken?: string };
}

/**
 * What the poll compares: a fingerprint of the rendered body itself.
 *
 * Every earlier attempt to enumerate "what the page can differ on" missed
 * something — custody, a lane's run state, a phase word, a stall duration,
 * the background runtime — and each miss was a page that froze. The body
 * IS the list. Seconds-level timers are normalised so a "moved 40s ago" does
 * not force a swap on every poll; anything at minute resolution or above,
 * and anything else at all, changes the fingerprint.
 */
export function dashboardPageSignature(body: string): string {
  const normalised = body
    .replace(/<span id="dashboard-poll-signature"[^>]*><\/span>/g, '')
    .replace(/\b\d+s\b/g, '0s');
  return createHash('sha256').update(normalised).digest('hex');
}

export function pageShell(input: DashboardPageShellInput): string {
  const crumb = (input.crumb ?? '').trim();
  const documentTitle = crumb === '' ? input.title : `${input.title} / ${crumb}`;
  // On crumb pages the lead is a real link home, so the breadcrumb affords
  // what it looks like it affords.
  const leadHref = safeHref(input.basePath) ?? '/dashboard';
  const brand = crumb === ''
    ? escapeHtml(input.title)
    : `<a class="lead" href="${escapeHtml(leadHref)}">${escapeHtml(input.title)}</a> <span class="crumb">/</span> ${escapeHtml(crumb)}`;
  // The poll's signature is taken from the very body being shipped, so the
  // page and its signature can never disagree about the clock or the facts.
  const sessionMarker = input.poll?.controlSessionCsrfToken === undefined
    ? ''
    : createHash('sha256').update('olympus-dashboard-session-marker\0').update(input.poll.controlSessionCsrfToken).digest('hex').slice(0, 24);
  const useController = input.controller !== undefined || input.poll !== undefined;
  const controller = !useController
    ? []
    : [standaloneDashboardControllerScript({
      csrfToken: input.controller?.csrfToken ?? '',
      signature: dashboardPageSignature(input.body),
      session: sessionMarker,
      intervalMs: input.poll?.intervalMs ?? 15_000,
    })];
  const scripts = !useController
    ? [...(input.scripts ?? [])].join('\n    ')
    : controller.join('\n    ');
  const styles = [DASHBOARD_THEME_CSS, ...(input.styles ?? [])].join('\n');
  const content = `<div class="frame">
      <div class="page">
      <div class="top">
        <span class="brand">${brand}</span>${input.meta ? `
        <span class="meta">${escapeHtml(input.meta)}</span>` : ''}
      </div>
      ${input.body}
      </div>
    </div>`;
  if (input.format === 'fragment') return content;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(documentTitle)}</title>
    <style>${styles}</style>
  </head>
  <body>
    <div data-olympus-dashboard-root data-signature="${escapeHtml(dashboardPageSignature(input.body))}" data-unlocked="${input.poll?.unlocked === true ? 'true' : 'false'}" data-session="${escapeHtml(sessionMarker)}">${content}</div>
    ${scripts}
  </body>
</html>`;
}

/**
 * The working donut: 14x14 SVG, outer ring plus a wedge whose dash length is
 * fraction * 12.566. Fractions outside 0..1 are clamped.
 */
export function donutGlyph(fraction: number, color?: string): string {
  const stroke = safeColor(color, DASHBOARD_STATUS_COLORS.Working);
  const dash = (clampFraction(fraction) * DONUT_CIRCUMFERENCE).toFixed(2);
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">`
    + `<circle cx="7" cy="7" r="6" style="stroke:${stroke}" stroke-width="1.5"/>`
    + `<circle cx="7" cy="7" r="2" style="stroke:${stroke}" stroke-width="4" stroke-dasharray="${dash} ${DONUT_CIRCUMFERENCE}" transform="rotate(-90 7 7)"/>`
    + `</svg>`;
}

/** The outer ring alone: work is running, but no ratio is defensible. */
function ringGlyph(color: string): string {
  const stroke = safeColor(color, DASHBOARD_STATUS_COLORS.Working);
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">`
    + `<circle cx="7" cy="7" r="6" style="stroke:${stroke}" stroke-width="1.5"/>`
    + `</svg>`;
}

/** The waiting glyph: grey double ring, no progress claim. */
export function waitingGlyph(color?: string): string {
  const stroke = safeColor(color, DASHBOARD_STATUS_COLORS.Waiting);
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">`
    + `<circle cx="7" cy="7" r="6" style="stroke:${stroke}" stroke-width="1.5"/>`
    + `<circle cx="7" cy="7" r="2.6" style="stroke:${stroke}" stroke-width="1.5"/>`
    + `</svg>`;
}

/** A plain filled dot, used by Fresh and by the not-connected rows. */
export function dotGlyph(color: string): string {
  return `<span class="dot" style="background:${safeColor(color, DASHBOARD_STATUS_COLORS.Waiting)}"></span>`;
}

/** The right glyph for a status word; fraction is used only by Working. */
export function statusGlyph(status: DashboardStatus, fraction?: number): string {
  if (status === 'Working') {
    return fraction === undefined
      ? ringGlyph(DASHBOARD_STATUS_COLORS.Working)
      : donutGlyph(fraction, DASHBOARD_STATUS_COLORS.Working);
  }
  if (status === 'Waiting') return waitingGlyph(DASHBOARD_STATUS_COLORS.Waiting);
  // Off claims nothing: a hollow grey ring (owner rule, 2026-10-02).
  if (status === 'Off') return '<span class="dot hollow"></span>';
  return dotGlyph(DASHBOARD_STATUS_COLORS[status]);
}

export interface DashboardActionInput {
  label: string;
  /**
   * Which control form the button submits; 'none' renders no button, and
   * 'link' renders a plain link, while 'control_link' mints the same bounded
   * control session as a form before navigating to a protected dashboard page.
   */
  kind: 'oauth' | 'oauth_cancel' | 'api_key' | 'sync_now' | 'model_retry' | 'disconnect' | 'unpair' | 'link' | 'control_link' | 'none';
  /** The `source` value the control route expects. */
  source?: string;
  primary?: boolean;
  /** Visually quiet: for a destructive or rarely-wanted act beside a healthy row. */
  quiet?: boolean;
  /** Id of a sheet this button toggles instead of submitting (kind 'none'). */
  sheet?: string;
  /** Where a 'link' or 'control_link' action goes. Same-origin paths only. */
  href?: string;
  /** The quiet clause beside a link, e.g. "needs the worker token". */
  hint?: string;
  /** Exact facts shown before a bounded Disconnect or Unpair. */
  confirmation?: string;
  /** Provider-side grant or device surface retained after the local act. */
  providerRevocationUrl?: string;
  /**
   * What that provider-side surface is called there, e.g. "WhatsApp linked
   * devices". Unpair leaves a device linked at the provider, so the link has to
   * name the screen the reader will actually look for; Disconnect's generic
   * "Provider access" is the default.
   */
  providerLinkLabel?: string;
  /**
   * What the form says while its request is outstanding ("Checking Dropbox…"),
   * worded here so the browser script carries no source names of its own.
   */
  pendingMessage?: string;
  /**
   * Why this control cannot be used right now. Set, the button renders
   * visibly disabled with the reason beside it, and submits nothing — a
   * blocked control never looks like a working one.
   */
  blockedReason?: string;
}

/**
 * Control buttons stay in the form shape the worker's control script already
 * binds to (data-connect-kind / data-sync-kind), so the bearer-token path is
 * unchanged: the read-only dash_ token never reaches these routes.
 */
export function actionButton(input: DashboardActionInput | undefined): string {
  // Every label a button shows passes the vocabulary: the view model may still
  // say Reauthenticate, the owner reads Reconnect.
  const action = input === undefined ? undefined : { ...input, label: dashboardActionLabel(input.label) };
  if (action?.blockedReason !== undefined && action.kind !== 'link' && (action.kind !== 'none' || action.sheet !== undefined)) {
    return `<span class="blocked"><button class="btn" type="button" disabled aria-disabled="true">${escapeHtml(action.label)}</button>`
      + `<span class="hint">${escapeHtml(action.blockedReason)}</span></span>`;
  }
  if (action === undefined || action.kind === 'none') {
    if (action?.sheet === undefined) return '';
    const sheetId = safeId(action.sheet);
    // A sheet toggle that is the row's main act is styled like every other
    // main act (owner note, 2026-09-01: Dropbox's Reauthenticate opened a
    // sheet and looked different from X's, "no reason for them to differ").
    return `<button class="btn${action.primary ? ' primary' : ''}" type="button" data-sheet-toggle="#${sheetId}" aria-controls="${sheetId}" aria-expanded="false">${escapeHtml(action.label)}</button>`;
  }
  if (action.kind === 'link') {
    // A link, never a disabled-looking button: the control route this reader
    // cannot call is not offered as one. The hint says what the destination
    // will ask of them, in the same words the detail page's picker link uses.
    const href = safeHref(action.href);
    if (href === undefined) return '';
    const hint = (action.hint ?? '').trim();
    return `<span class="rowlink"><a class="btn" href="${escapeHtml(href)}">${escapeHtml(action.label)}</a>`
      + `${hint === '' ? '' : `<span class="hint">${escapeHtml(hint)}</span>`}</span>`;
  }
  if (action.kind === 'control_link') {
    const href = safeHref(action.href);
    // Control-session navigation never leaves this worker. `//host/path` is a
    // valid browser URL but is cross-origin, so a leading double slash is not
    // an acceptable dashboard control target.
    if (href === undefined || !href.startsWith('/') || href.startsWith('//')) return '';
    const hint = (action.hint ?? '').trim();
    return `<span class="rowlink"><button class="btn${action.primary ? ' primary' : ''}" type="button" data-control-link="${escapeHtml(href)}">${escapeHtml(action.label)}</button>`
      + `${hint === '' ? '' : `<span class="hint">${escapeHtml(hint)}</span>`}`
      + `<span class="actmsg" data-action-message role="status"></span></span>`;
  }
  const button = `<button class="btn${action.primary ? ' primary' : ''}${action.quiet ? ' quiet' : ''}" type="submit">${escapeHtml(action.label)}</button>`;
  const source = `<input type="hidden" name="source" value="${escapeHtml(action.source ?? '')}">`;
  const message = `<span class="actmsg" data-action-message role="status"></span>`;
  if (action.kind === 'sync_now') {
    const pending = action.pendingMessage ? ` data-pending-message="${escapeHtml(action.pendingMessage)}"` : '';
    return `<form class="rowform" data-sync-kind="sync_now"${pending}>${source}${button}${message}</form>`;
  }
  // A built-in model's failed install, started again; `source` names the model.
  if (action.kind === 'model_retry') {
    return `<form class="rowform" data-model-retry="${escapeHtml(action.source ?? '')}">${button}${message}</form>`;
  }
  // Disconnect and Unpair are the same bounded shape — confirm, acknowledge,
  // one source_id — over two different routes, because they remove two
  // different things: a broker credential grant, and this computer's pairing
  // session. The form attribute is what selects the route.
  if (action.kind === 'disconnect' || action.kind === 'unpair') {
    const revocationUrl = safeExternalHref(action.providerRevocationUrl);
    const providerLink = revocationUrl
      ? `<a class="hint" href="${escapeHtml(revocationUrl)}" target="_blank" rel="noreferrer">${escapeHtml(action.providerLinkLabel ?? 'Provider access')}</a>`
      : '';
    const kindAttribute = action.kind === 'unpair'
      ? 'data-unpair-kind="unpair"'
      : 'data-disconnect-kind="disconnect"';
    return `<form class="rowform" ${kindAttribute} data-confirmation="${escapeHtml(action.confirmation ?? '')}">`
      + `<input type="hidden" name="source_id" value="${escapeHtml(action.source ?? '')}">`
      + `${button}${providerLink}${message}</form>`;
  }
  // The api-key route rejects a body without `api_key`, so the form carries
  // the field the route reads rather than a button that can only 400.
  const key = action.kind === 'api_key'
    ? `<input class="keyfield" type="password" name="api_key" required placeholder="API key" aria-label="API key">`
    : '';
  return `<form class="rowform" data-connect-kind="${action.kind}">${source}${key}${button}${message}</form>`;
}

export interface DashboardControlGateInput {
  connected: boolean;
}

/** Anchor every locked control links back to: the one place the token goes. */
export const DASHBOARD_CONTROL_GATE_ID = 'dashboard-controls';

export { DASHBOARD_WORKER_TOKEN_AGENT_PROMPT } from './vocabulary.ts';

/**
 * The one dashboard-level custody gate for every mutating source control.
 *
 * Locked, it asks for one thing — the token — and says exactly where it comes
 * from behind a single disclosure (owner note, 2026-09-01: "too much text;
 * just say what to do to get the token"). The sheet carries the copyable
 * agent prompt and the CLI command; the page never holds the token itself.
 */
export function dashboardControlGate(input: DashboardControlGateInput): string {
  if (input.connected) {
    return `<div class="sect" id="${DASHBOARD_CONTROL_GATE_ID}">Dashboard controls</div>`
      + `<div class="attncard plain" data-dashboard-control-gate data-state="connected">`
      + `<div class="grow"><span class="name">Dashboard controls unlocked</span>`
      + `<span class="why"> — on this browser for 30 days from opening, or until the worker token is rotated</span></div>`
      // Lock clears this browser's cookie. Same custody proof as any control
      // (cookie, same origin, CSRF); a scriptless submit posts nothing useful.
      + `<form class="rowform" data-control-session-kind="lock" method="post" action="/dashboard/control/session/lock">`
      + `<button class="btn" type="submit">Lock</button>`
      + `<span class="actmsg" data-action-message role="status"></span></form></div>`;
  }
  const sheetId = `${DASHBOARD_CONTROL_GATE_ID}-how`;
  const promptId = `${sheetId}-prompt`;
  return `<div class="sect" id="${DASHBOARD_CONTROL_GATE_ID}">Dashboard controls</div>`
    + `<div class="attncard" data-dashboard-control-gate data-state="locked">`
    + `<div class="grow"><span class="name">Open dashboard controls</span>`
    + `<span class="why"> — ask your agent for a fresh opening link. No token copying needed.</span></div>`
    + `<button class="btn primary" type="button" data-sheet-toggle="#${sheetId}" aria-controls="${sheetId}" aria-expanded="false">Get opening link</button></div>`
    + `<div class="sheet gate" id="${sheetId}" aria-hidden="true">`
    + `<h4>Open dashboard controls</h4>`
    + `<p>Copy this request to your agent, then open the link it gives you. The link works once and expires after fifteen minutes.</p>`
    + `<div class="promptbox" id="${promptId}">${escapeHtml(DASHBOARD_WORKER_TOKEN_AGENT_PROMPT)}</div>`
    + `<button class="btn" type="button" data-copy-target="#${promptId}">Copy prompt</button>`
    + `<span class="copystatus" data-copy-status aria-live="polite"></span>`
    + `<details><summary>Advanced: use a worker token</summary>`
    // No name: native form submission cannot put a bearer in a URL or body.
    + `<form class="rowform" data-control-session-kind="unlock" method="post" action="/dashboard/control/session">`
    + `<input class="keyfield" data-dashboard-control-token type="password"`
    + ` required autocomplete="off" placeholder="Worker token" aria-label="Worker token">`
    + `<button class="btn" type="submit">Unlock</button>`
    + `<span class="actmsg" data-action-message role="status"></span></form></details></div>`;
}

/**
 * The ⋯ menu: a native <details>, so it opens before any script runs and reads
 * as a disclosure. Empty when the row has no secondary act.
 */
export function rowMenu(label: string, itemsHtml: string): string {
  if (itemsHtml.trim() === '') return '';
  return `<details class="rowmenu"><summary class="btn" aria-label="${escapeHtml(`More actions for ${label}`)}">⋯</summary>`
    + `<div class="menu">${itemsHtml}</div></details>`;
}

export interface DashboardSetupRowInput {
  label: string;
  href?: string;
  /** The source this row sets up (`data-source-id`): where an open link (#olympus-open=connect.x) lands. */
  sourceId?: string;
  /** One plain sentence about what connecting this source does. */
  blurb: string;
  /**
   * The one line shown on the row when the blurb is a set of instructions:
   * the requirement and its most important caveat. Set, the full blurb and
   * its link move behind a "How to set this up" disclosure.
   */
  summary?: string;
  /** The caveat a reader must see before starting, e.g. "Needs paid X API access". */
  caveat?: string;
  action: DashboardActionInput;
  /**
   * Where the key or app this row asks for actually lives, as a link out to
   * the provider's own console. Rendered at the end of the blurb.
   */
  blurbLink?: DashboardExternalLinkInput;
}

export function setupRow(input: DashboardSetupRowInput): string {
  const href = safeHref(input.href);
  // No blurb means no empty span and no empty grid column: the row closes up
  // (.setrow.noblurb) rather than holding a visible gap for absent copy.
  const blurb = input.blurb.trim();
  // The blurb is escaped text and the link is built from a parsed https URL,
  // so the one piece of markup inside this span is this module's own — the
  // provider copy never reaches the page as markup.
  const link = input.blurbLink === undefined ? '' : externalLink(input.blurbLink);
  const blurbText = blurb === '' ? '' : escapeHtml(blurb);
  const instructions = [blurbText, link].filter((part) => part !== '').join(' ');
  const summary = (input.summary ?? '').trim();
  const caveat = (input.caveat ?? '').trim();
  const lead = [
    caveat === '' ? '' : `<span class="caveat">${escapeHtml(caveat)}.</span>`,
    summary === '' ? '' : escapeHtml(summary),
  ].filter((part) => part !== '').join(' ');
  const blurbBody = lead === ''
    ? instructions
    : `${lead}${instructions === '' ? '' : detailsDisclosure('How to set this up', `<p>${instructions}</p>`)}`;
  const blurbSpan = blurbBody === '' ? '' : `<span class="blurb">${blurbBody}</span>`;
  // The column closes up only when NOTHING is in it: a row whose whole blurb is
  // the key-location link still needs its column.
  const sourceId = input.sourceId ? ` data-source-id="${escapeHtml(input.sourceId)}"` : '';
  return `<div class="${blurbBody === '' ? 'setrow noblurb' : 'setrow'}"${sourceId}${href ? ` data-dashboard-href="${escapeHtml(href)}"` : ''}>`
    + `${statusGlyph('Off')}`
    + (href ? `<a class="name" href="${escapeHtml(href)}">${escapeHtml(input.label)}</a>` : `<span class="name">${escapeHtml(input.label)}</span>`)
    + `${blurbSpan}`
    // Every source row's button is outlined, on every row alike, so Connect
    // never reads filled on one row and outlined on the next; the accent fill
    // belongs to the page's one primary action (owner rule, 2026-10-02). A
    // row that IS a section's one main act (Agents' Connect an agent) says so.
    + `${actionButton({ ...input.action, primary: input.action.primary ?? false })}`
    + `</div>`;
}

export interface DashboardBlockerBannerInput {
  /** One sentence naming what is stopping the page. */
  sentence: string;
  /** The one control that clears it, when one exists. */
  action?: DashboardActionInput;
  /** A control that is not a source action (a model check), already rendered. */
  controlHtml?: string;
}

/**
 * The page's one blocker: full width, at the top, one sentence and one
 * button. Only for a condition that stops the rest of the page.
 */
export function blockerBanner(input: DashboardBlockerBannerInput): string {
  return `<div class="attncard banner blocker" role="status" data-blocker>`
    + `<div class="grow"><span class="name">${escapeHtml(input.sentence)}</span></div>`
    + `${input.controlHtml ?? actionButton(input.action)}`
    + `</div>`;
}

/**
 * The technical half of a problem: closed by default under one plain summary,
 * so the row or sheet above it stays one sentence.
 */
export function detailsDisclosure(summary: string, body: string): string {
  if (body.trim() === '') return '';
  return `<details class="howto"><summary>${escapeHtml(summary)}</summary>${body}</details>`;
}

/**
 * Layout for the two policy surfaces: the sensitivity page's tier table, and the detail page's scope rows and review chips.
 *
 * One constant rather than two because both pages want the same quiet line and
 * the same tabular treatment, and a page carrying a few unused rules costs less
 * than the same rule written twice.
 */

export interface DashboardSheetInput {
  id: string;
  heading: string;
  /** Plain-language paragraph above the prompt box. */
  intro: string;
  /** The copyable prompt text. Never a secret, never a token. */
  promptText: string;
  copyButtonLabel: string;
}

/** The collapsible "Build a connector with your agent" sheet. */
export function connectorSheet(input: DashboardSheetInput): string {
  const id = safeId(input.id);
  const promptId = `${id}-prompt`;
  return `<div class="sheet" id="${id}" aria-hidden="true">`
    + `<h4>${escapeHtml(input.heading)}</h4>`
    + `<p>${escapeHtml(input.intro)}</p>`
    + `<div class="promptbox" id="${promptId}">${escapeHtml(input.promptText)}</div>`
    + `<button class="btn" type="button" data-copy-target="#${promptId}">${escapeHtml(input.copyButtonLabel)}</button>`
    + `<span class="copystatus" data-copy-status aria-live="polite"></span>`
    + `</div>`;
}

export interface DashboardConnectSheetInput {
  id: string;
  heading: string;
  /** The instructions' own plain_intro, verbatim. */
  intro: string;
  /** The instructions' agent_prompt, verbatim. */
  promptText: string;
  /** The `source` value /dashboard/connect/oauth/start expects. */
  source: string;
  /** The instructions' declared fields; the route reads them by name. */
  fields: readonly DashboardConnectField[];
  /**
   * The exact callback URI the provider must accept, plus the one line saying
   * where it goes in that provider's console. Rendered ABOVE the Client ID
   * field, because registering it is the step before the key is worth pasting.
   *
   * Used only when no `registration` walkthrough is supplied; the walkthrough
   * carries the URI inside its own numbered step.
   */
  redirectUri?: { uri: string; guidance?: string };
  /**
   * The numbered, provider-specific walkthrough for registering that URI.
   * Rendered above the fields, with the agent prompt demoted to a disclosure
   * beneath them: every BYO client has to do this, and the card is where the
   * owner is standing when they find out (owner ruling, 2026-09-03).
   */
  registration?: DashboardCallbackRegistration;
  /** Values to prefill a field with, by field name. Never a secret. */
  values?: Partial<Record<DashboardConnectFieldName, string>>;
  /**
   * Secret fields whose value is already stored. Each renders filled with
   * DASHBOARD_SAVED_SECRET_FIELD_VALUE, so it shows as masked dots; the real
   * secret never reaches the page.
   */
  savedSecrets?: readonly DashboardConnectFieldName[];
  /** Per-field placeholder overrides, by field name. */
  placeholders?: Partial<Record<DashboardConnectFieldName, string>>;
  /** A bounded sentence above everything, e.g. what the provider refused. */
  notice?: string;
  /** The provider's own words behind the notice, under How to fix. */
  noticeDetail?: string;
  /**
   * What the provider's own consent screen may say about the app asking, e.g.
   * Google's unverified-app warning. Shown only inside the sheet, so it meets
   * the reader who is about to connect and nobody else.
   */
  providerNote?: string;
  /** Renders the Cancel control for a source whose attempt is still pending. */
  cancellable?: boolean;
  /** The submit button's word; defaults to Connect. */
  submitLabel?: string;
  /**
   * Publisher mode: this source connects through Olympus's OWN registered app,
   * so the sheet leads with a single Connect button and no fields at all. The
   * bring-your-own path is not removed — every field, walkthrough and prompt
   * above moves inside the named disclosure, one click away.
   */
  publisher?: {
    /** The sentence above the one-click control. */
    intro: string;
    /** The disclosure's summary, e.g. "Use my own app instead". */
    byoSummary: string;
  };
}

/**
 * The one-time-setup sheet for a needs_setup source: the copyable agent
 * prompt, and the client id/secret form the oauth start route accepts inline.
 * Every word is a field off the card's own instructions.
 */
export function connectSetupSheet(input: DashboardConnectSheetInput): string {
  const id = safeId(input.id);
  const promptId = `${id}-prompt`;
  const inputs = input.fields.map((field) => {
    const value = field.secret && input.savedSecrets?.includes(field.name)
      ? DASHBOARD_SAVED_SECRET_FIELD_VALUE
      : input.values?.[field.name];
    const placeholder = input.placeholders?.[field.name] ?? field.label;
    // A prefilled value is rendered as an ordinary editable input, never as a
    // read-only display: a wrong Client ID is exactly the thing the owner came
    // here to change (owner, 2026-09-03).
    return `<input class="keyfield" type="${field.secret ? 'password' : 'text'}" name="${escapeHtml(field.name)}"`
      + `${field.required ? ' required' : ''}`
      + `${value === undefined ? '' : ` value="${escapeHtml(value)}"`}`
      + ` placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(field.label)}">`;
  }).join('');
  const notice = (input.notice === undefined || input.notice.trim() === ''
    ? ''
    : `<p class="why">${escapeHtml(input.notice)}</p>`
      + detailsDisclosure('How to fix', input.noticeDetail === undefined ? '' : `<p class="hint">${escapeHtml(input.noticeDetail)}</p>`))
    + (input.providerNote === undefined || input.providerNote.trim() === ''
      ? ''
      : `<p class="providernote">${escapeHtml(input.providerNote)}</p>`);
  const registration = callbackRegistrationSteps(id, input.registration);
  // The redirect URI sits above the key fields and is selectable text with its
  // own copy button (.promptbox is already `user-select: all`), because every
  // provider demands an EXACT match and a retyped URI is a silent mismatch.
  const redirect = input.registration !== undefined || input.redirectUri === undefined
    ? ''
    : `<p class="hint">Redirect URI</p>`
      + `<div class="promptbox" id="${id}-redirect">${escapeHtml(input.redirectUri.uri)}</div>`
      + `<button class="btn" type="button" data-copy-target="#${id}-redirect">Copy redirect URI</button>`
      + `<span class="copystatus" data-copy-status aria-live="polite"></span>`
      + `${input.redirectUri.guidance === undefined ? '' : `<p class="hint">${escapeHtml(input.redirectUri.guidance)}</p>`}`;
  const cancel = input.cancellable !== true
    ? ''
    : `<form class="rowform" data-connect-kind="oauth_cancel" style="margin-top:8px">`
      + `<input type="hidden" name="source" value="${escapeHtml(input.source)}">`
      + `<button class="btn" type="submit">Cancel connection attempt</button>`
      + `<span class="actmsg" data-action-message role="status"></span>`
      + `</form>`;
  // The agent prompt is SECONDARY now. It used to be the only walkthrough on
  // the card, which meant the one step every BYO client must take — registering
  // this callback — lived in text the owner had to copy into another program.
  const prompt = `<details class="agentprompt">`
    + `<summary>Ask your agent to walk you through it</summary>`
    + `<div class="promptbox" id="${promptId}">${escapeHtml(input.promptText)}</div>`
    + `<button class="btn" type="button" data-copy-target="#${promptId}">Copy prompt</button>`
    + `<span class="copystatus" data-copy-status aria-live="polite"></span>`
    + `</details>`;
  const submitLabel = escapeHtml(input.submitLabel ?? 'Connect');
  const sourceField = `<input type="hidden" name="source" value="${escapeHtml(input.source)}">`;
  const byoForm = `<form class="rowform" data-connect-kind="oauth" style="margin-top:12px">`
    + sourceField
    + `${inputs}`
    + `<button class="btn primary" type="submit">${submitLabel}</button>`
    + `<span class="actmsg" data-action-message role="status"></span>`
    // Where the authorization link lands when the browser blocks the new tab.
    + `<span class="authfallback" data-authorization-fallback></span>`
    + `</form>`;
  if (input.publisher) {
    // The whole point of publisher mode is that there is nothing to do first.
    // The one-click form carries the source and NOTHING else: no client id
    // field to fill, no redirect URI to register, no console to visit. The
    // start route reads the absence of a client id as "use the publisher app".
    const publisherForm = `<form class="rowform" data-connect-kind="oauth"${input.cancellable ? '' : ' data-oauth-autostart'} style="margin-top:12px">`
      + sourceField
      + `<button class="btn primary" type="submit">${submitLabel}</button>`
      + `<span class="actmsg" data-action-message role="status"></span>`
      + `<span class="authfallback" data-authorization-fallback></span>`
      + `</form>`;
    return `<div class="sheet" id="${id}" aria-hidden="true">`
      + `<h4>${escapeHtml(input.heading)}</h4>`
      + `${notice}`
      + `<p>${escapeHtml(input.publisher.intro)}</p>`
      + `${publisherForm}`
      + `${cancel}`
      + `<details class="agentprompt">`
      + `<summary>${escapeHtml(input.publisher.byoSummary)}</summary>`
      + `<p>${escapeHtml(input.intro)}</p>`
      + `${registration}`
      + `${redirect}`
      + `${byoForm}`
      + `${prompt}`
      + `</details>`
      + `</div>`;
  }
  return `<div class="sheet" id="${id}" aria-hidden="true">`
    + `<h4>${escapeHtml(input.heading)}</h4>`
    + `${notice}`
    + `<p>${escapeHtml(input.intro)}</p>`
    + `${registration}`
    + `${redirect}`
    + `${byoForm}`
    + `${cancel}`
    + `${prompt}`
    + `</div>`;
}

/**
 * The four numbered steps, or the one sentence that replaces them.
 *
 * Step 3 carries the URI itself as selectable text with its own copy button:
 * every provider matches it EXACTLY, so a retyped character is a silent
 * mismatch and the owner is sent back to a console they have already left.
 */
function callbackRegistrationSteps(
  id: string,
  registration: DashboardCallbackRegistration | undefined,
): string {
  if (registration === undefined) return '';
  const uriBlock = `<div class="promptbox" id="${id}-redirect">${escapeHtml(registration.redirect_uri)}</div>`
    + `<button class="btn" type="button" data-copy-target="#${id}-redirect">Copy redirect URI</button>`
    + `<span class="copystatus" data-copy-status aria-live="polite"></span>`;
  if (!registration.required) {
    return `<p class="hint">${escapeHtml(registration.skip_note ?? 'No registration needed on this machine.')}</p>`
      + `<p class="hint">Redirect URI</p>`
      + uriBlock;
  }
  const consoleUrl = safeExternalHref(registration.console.url);
  const consoleStep = consoleUrl === undefined
    ? escapeHtml(registration.console.label)
    : `${escapeHtml(registration.console.label)}: `
      + `<a class="ext" href="${escapeHtml(consoleUrl)}" target="_blank" rel="noreferrer">${escapeHtml(new URL(consoleUrl).host)} →</a>`;
  return `<ol class="steps">`
    + `<li>${consoleStep}</li>`
    + `<li>${escapeHtml(registration.app_requirements)}</li>`
    + `<li>In <b>${escapeHtml(registration.setting_label)}</b>, add this exact URL:${uriBlock}</li>`
    + `<li>${escapeHtml(registration.finish)}</li>`
    + `</ol>`;
}

/**
 * The one-time-setup sheet for a data-bearing or never-connected source whose
 * app key is missing, and the id its opening button toggles. One builder for
 * every page that offers it (home's Needs-you row, setup's rows), so they can
 * never drift apart. Source-derived id; the groups that use it are disjoint.
 */
export function dashboardNeedsSetupSheet(
  source: Pick<DashboardSourceCard, 'source_id' | 'label'>,
  action: Extract<DashboardSourceAction, { kind: 'needs_setup' }>,
  options: { providerNote?: string } = {},
): { sheetId: string; sheet: string } {
  const sheetId = `setup-${source.source_id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
  const sheet = connectSetupSheet({
    id: sheetId,
    heading: `Set up ${source.label}`,
    intro: action.instructions.plain_intro,
    promptText: action.instructions.agent_prompt,
    source: action.source,
    fields: action.instructions.fields,
    ...(options.providerNote === undefined ? {} : { providerNote: options.providerNote }),
    ...redirectUriInput(action),
  });
  return { sheetId, sheet };
}

/**
 * The connect sheet for an OAuth source whose client key is already on file,
 * and the id its button toggles.
 *
 * It exists because a registered key does not make the flow ready: the provider
 * still has to accept this dashboard's callback URI, and the owner still has to
 * be able to correct a client id they typed wrong. Before this, both of those
 * were unreachable from the page — the row's only control started the identical
 * failing attempt again (owner, 2026-09-03).
 *
 * Returns undefined when the action carries no instructions, which is the
 * shape a caller that only wants the plain one-click control keeps.
 */
export function dashboardOAuthConnectSheet(
  source: Pick<DashboardSourceCard, 'source_id' | 'label'>,
  action: Extract<DashboardSourceAction, { kind: 'oauth' }>,
  options: { notice?: string; noticeDetail?: string; providerNote?: string } = {},
): { sheetId: string; sheet: string } | undefined {
  const instructions = action.instructions;
  if (instructions === undefined) return undefined;
  const sheetId = `connect-${source.source_id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
  // Everything inside the disclosure is the bring-your-own walkthrough, which
  // on a publisher action lives under `advanced_byo` — the top level of a
  // publisher action's instructions is the one-click text the sheet leads with.
  const byo = instructions.advanced_byo ?? instructions;
  // A saved secret renders as a filled, masked field; an empty field always
  // means "put something here". The old placeholder "leave blank to keep the
  // stored one" truncated to "leave blan" and read as an instruction to leave
  // a needed field empty (owner, olympus-test, 2026-09-23). The field stays
  // optional so clearing it also keeps the stored secret.
  const secretOnFile = action.client_secret_on_file === true;
  const fields = byo.fields.map((field) => (
    field.name === 'client_id' || !secretOnFile ? field : { ...field, required: false }
  ));
  const savedSecrets = secretOnFile ? byo.fields.filter((field) => field.secret).map((field) => field.name) : [];
  // A provider that does not know this callback URI answers with its own
  // generic error page and never calls back, so the attempt just sits pending.
  // Say so while it does: the owner otherwise retries the identical request.
  const pendingNote = action.pending_attempt && action.redirect_uri_to_register
    ? `If ${source.label}'s page shows an error instead of asking you to approve, the callback URL below is not`
      + ` registered exactly on your app. Add it, press Cancel connection attempt, then Connect again.`
    : undefined;
  const notice = options.notice ?? pendingNote;
  const sheet = connectSetupSheet({
    id: sheetId,
    heading: `${dashboardActionLabel(action.label)} ${source.label}`,
    intro: byo.plain_intro,
    promptText: byo.agent_prompt,
    source: action.source,
    fields,
    submitLabel: dashboardActionLabel(action.label),
    // Publisher mode: Olympus's own registered app does the asking, so the
    // sheet leads with the button and keeps the bring-your-own walkthrough
    // one click away rather than deleting it. The sentence is the action's own
    // plain_intro, so the page and dashboard.json cannot drift apart.
    ...(action.publisher_client
      ? {
        publisher: {
          intro: instructions.plain_intro,
          byoSummary: instructions.diy_summary,
        },
      }
      : {}),
    ...(savedSecrets.length > 0 ? { savedSecrets } : {}),
    ...(action.known_client_id ? { values: { client_id: action.known_client_id } } : {}),
    ...(action.pending_attempt ? { cancellable: true } : {}),
    ...(notice === undefined ? {} : { notice }),
    ...(options.noticeDetail === undefined ? {} : { noticeDetail: options.noticeDetail }),
    ...(options.providerNote === undefined ? {} : { providerNote: options.providerNote }),
    ...redirectUriInput(action),
  });
  return { sheetId, sheet };
}

/**
 * Google's unverified-app warning, for the Google connect sheets only.
 *
 * It used to be a banner over the whole Setup source list, read by everyone
 * whether or not they meant to connect Google (owner, 2026-09-23). Now it sits
 * inside the Gmail and Drive sheets, and only while this install connects
 * through Olympus's shared, still-unverified Google app: a bring-your-own app
 * consents to the owner's own client and has nothing to be told.
 */
export function dashboardGoogleProviderNote(
  view: Pick<SourceDashboardViewModel, 'google_pilot'>,
  action: Extract<DashboardSourceAction, { kind: 'oauth' | 'needs_setup' }>,
): string | undefined {
  if (view.google_pilot?.mode !== 'shared_pilot' || !isGoogleOAuthSource(action.source)) return undefined;
  return `${view.google_pilot.warning} Gmail and Drive ask for their read access separately.`;
}

function redirectUriInput(
  action: Extract<DashboardSourceAction, { kind: 'oauth' | 'needs_setup' }>,
): { redirectUri?: { uri: string; guidance?: string }; registration?: DashboardCallbackRegistration } {
  const registration = action.callback_registration === undefined
    ? {}
    : { registration: action.callback_registration };
  const uri = action.redirect_uri_to_register;
  if (uri === undefined) return registration;
  return {
    ...registration,
    redirectUri: {
      uri,
      ...(action.redirect_uri_guidance === undefined ? {} : { guidance: action.redirect_uri_guidance }),
    },
  };
}

interface StandaloneDashboardControllerScriptInput {
  csrfToken: string;
  signature: string;
  session: string;
  intervalMs: number;
}

/**
 * Trusted standalone bootstrap for the same controller the native module
 * imports. The fetched HTML contributes only the known root's inert contents;
 * its scripts are never copied or evaluated.
 */
export function standaloneDashboardControllerScript(
  input: StandaloneDashboardControllerScriptInput,
): string {
  const mountSource = mountDashboardController.toString().replaceAll('</script', '<\\/script');
  const config = escapeScriptJson(JSON.stringify(input));
  return `<script>
    (function () {
      var config = ${config};
      var csrfToken = config.csrfToken;
      var sessionMarker = config.session;
      var root = document.querySelector('[data-olympus-dashboard-root]');
      if (!root) return;
      var abort = new AbortController();
      var mount = ${mountSource};
      function route(params) {
        var action = params.action;
        if (action === 'start_oauth') return ['/dashboard/connect/oauth/start', withoutAction(params)];
        if (action === 'cancel_oauth') return ['/dashboard/connect/oauth/cancel', withoutAction(params)];
        if (action === 'check_model_setup') return ['/dashboard/models/check', {}];
        if (action === 'connect_api_key') return ['/dashboard/connect/api-key', withoutAction(params)];
        if (action === 'sync_now') return ['/dashboard/sync-now', withoutAction(params)];
        if (action === 'set_embedding_priority') return ['/dashboard/embedding-priority', withoutAction(params)];
        if (action === 'retry_model') return ['/dashboard/models/retry', withoutAction(params)];
        if (action === 'disconnect') return ['/dashboard/disconnect', withoutAction(params)];
        if (action === 'unpair') return ['/dashboard/unpair', withoutAction(params)];
        if (action === 'mint_agent_pairing_code') return ['/dashboard/agents/pairing-code', {}];
        if (action === 'create_agent_key') return ['/dashboard/agents/keys', withoutAction(params)];
        if (action === 'revoke_agent_connection') return ['/dashboard/agents/revoke', withoutAction(params)];
        if (action === 'set_remote_access') return ['/dashboard/agents/remote-access', withoutAction(params)];
        return null;
      }
      function withoutAction(params) {
        var body = {};
        Object.keys(params).forEach(function (key) { if (key !== 'action') body[key] = params[key]; });
        return body;
      }
      async function json(response) {
        try { return await response.json(); } catch (error) { return {}; }
      }
      var controller = mount({
        root: root,
        transport: {
          async control(params) {
            var target = route(params);
            if (!target) return { status: 400, body: { error: { message: 'Unsupported dashboard action.' } } };
            var response = await fetch(target[0], {
              method: 'POST', credentials: 'same-origin',
              headers: { 'X-Olympus-CSRF': csrfToken, 'Content-Type': 'application/json' },
              body: JSON.stringify(target[1]),
            });
            return { status: response.status, body: await json(response) };
          },
          async unlock(workerToken) {
            var response = await fetch('/dashboard/control/session', {
              method: 'POST', cache: 'no-store', credentials: 'same-origin',
              headers: { 'Authorization': 'Bearer ' + workerToken },
            });
            var body = await json(response);
            if (response.ok && typeof body.csrf_token === 'string') csrfToken = body.csrf_token;
            return { ok: response.ok, csrf_token: body.csrf_token };
          },
          async lock() {
            var response = await fetch('/dashboard/control/session/lock', {
              method: 'POST', cache: 'no-store', credentials: 'same-origin',
              headers: { 'X-Olympus-CSRF': csrfToken },
            });
            if (response.ok) csrfToken = '';
            return response.ok;
          },
        },
        navigate: function (href) { window.location.assign(href); },
        refresh: async function () {
          var response = await fetch(window.location.href, { cache: 'no-store' });
          if (!response.ok) return undefined;
          var next = new DOMParser().parseFromString(await response.text(), 'text/html');
          var nextRoot = next.querySelector('[data-olympus-dashboard-root]');
          if (!nextRoot) return undefined;
          var nextSession = nextRoot.getAttribute('data-session') || '';
          if (nextSession !== sessionMarker) { window.location.reload(); return undefined; }
          return {
            status: response.status,
            title: next.title,
            body: nextRoot.innerHTML,
            controller: 'dashboard',
            can_write: nextRoot.getAttribute('data-unlocked') === 'true',
            signature: nextRoot.getAttribute('data-signature') || '',
            poll_interval_ms: config.intervalMs,
          };
        },
        returnUrl: window.location.href,
        canWrite: Boolean(csrfToken),
        authority: 'worker-session',
        signal: abort.signal,
        signature: config.signature,
        pollIntervalMs: config.intervalMs,
        csrfToken: csrfToken,
      });
      window.addEventListener('pagehide', function () { controller.dispose(); abort.abort(); }, { once: true });
    })();
  </script>`;
}
