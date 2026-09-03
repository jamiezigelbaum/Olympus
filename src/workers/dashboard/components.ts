/**
 * The page's shared HTML pieces: status glyphs, cards, rows, the connector
 * sheet, and the two inline scripts.
 *
 * Every dynamic value that reaches a page goes through escapeHtml here, and
 * every serialized view model through escapeScriptJson. Both are implemented
 * rather than stubbed so the three pages cannot each grow their own copy.
 */
import { createHash } from 'node:crypto';
import type { DashboardCallbackRegistration, DashboardConnectField, DashboardConnectFieldName, DashboardSourceAction, DashboardSourceCard } from '../source-dashboard.ts';
import type { EmbeddingRuntimeFacts } from './embedding-runtime.ts';
import { dashboardSourceProgress, type DashboardPhaseId } from './phases.ts';
import { DASHBOARD_STATUS_COLORS, DASHBOARD_THEME_CSS, DASHBOARD_THEME_TOKENS } from './theme.ts';
import type { DashboardStatus } from './vocabulary.ts';

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

/** Glyph colors are literal hex, so anything else is a style injection. */
const HEX_COLOR = /^#[0-9A-Fa-f]{3,8}$/;

function safeColor(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return HEX_COLOR.test(trimmed) ? trimmed : fallback;
}

function clampFraction(value: number): number {
  // A missing ratio reads as no progress, never as full.
  if (Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return Math.round(value * 10) / 10;
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
  const poll = input.poll === undefined
    ? []
    : [pollScript({
      signature: dashboardPageSignature(input.body),
      unlocked: input.poll.unlocked === true,
      // A non-secret fingerprint of the session this render's control
      // handler holds: a re-mint elsewhere (new nonce, new CSRF) changes it
      // and forces a reload, where a bare unlocked flag would not.
      session: input.poll.controlSessionCsrfToken === undefined
        ? ''
        : createHash('sha256').update('olympus-dashboard-session-marker\0').update(input.poll.controlSessionCsrfToken).digest('hex').slice(0, 24),
      ...(input.poll.intervalMs === undefined ? {} : { intervalMs: input.poll.intervalMs }),
    })];
  const scripts = [...(input.scripts ?? []), ...poll].join('\n    ');
  const styles = [DASHBOARD_THEME_CSS, ...(input.styles ?? [])].join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(documentTitle)}</title>
    <style>${styles}</style>
  </head>
  <body>
    <div class="frame">
      <div class="page">
      <div class="top">
        <span class="brand">${brand}</span>${input.meta ? `
        <span class="meta">${escapeHtml(input.meta)}</span>` : ''}
      </div>
      ${input.body}
      </div>
    </div>
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
    + `<circle cx="7" cy="7" r="6" stroke="${stroke}" stroke-width="1.5"/>`
    + `<circle cx="7" cy="7" r="2" stroke="${stroke}" stroke-width="4" stroke-dasharray="${dash} ${DONUT_CIRCUMFERENCE}" transform="rotate(-90 7 7)"/>`
    + `</svg>`;
}

/** The outer ring alone: work is running, but no ratio is defensible. */
function ringGlyph(color: string): string {
  const stroke = safeColor(color, DASHBOARD_STATUS_COLORS.Working);
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">`
    + `<circle cx="7" cy="7" r="6" stroke="${stroke}" stroke-width="1.5"/>`
    + `</svg>`;
}

/** The waiting glyph: grey double ring, no progress claim. */
export function waitingGlyph(color?: string): string {
  const stroke = safeColor(color, DASHBOARD_STATUS_COLORS.Waiting);
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">`
    + `<circle cx="7" cy="7" r="6" stroke="${stroke}" stroke-width="1.5"/>`
    + `<circle cx="7" cy="7" r="2.6" stroke="${stroke}" stroke-width="1.5"/>`
    + `</svg>`;
}

/** A plain filled dot, used by Fresh and by the not-connected rows. */
export function dotGlyph(color: string): string {
  return `<span class="dot" style="background:${safeColor(color, DASHBOARD_THEME_TOKENS.off)}"></span>`;
}

/** The right glyph for a status word; fraction is used only by Working. */
export function statusGlyph(status: DashboardStatus, fraction?: number): string {
  if (status === 'Working') {
    return fraction === undefined
      ? ringGlyph(DASHBOARD_STATUS_COLORS.Working)
      : donutGlyph(fraction, DASHBOARD_STATUS_COLORS.Working);
  }
  if (status === 'Waiting') return waitingGlyph(DASHBOARD_STATUS_COLORS.Waiting);
  return dotGlyph(DASHBOARD_STATUS_COLORS[status]);
}

export interface DashboardCardInput {
  label: string;
  status: DashboardStatus;
  /** The card's second line; omitted or empty renders no line at all. */
  subLine?: string;
  /** 0..1 for the Working donut. */
  fraction?: number;
  /** Detail-page link target, when this card has a detail page. */
  href?: string;
}

/**
 * One source, as a card.
 *
 * The WHOLE card is the link, not the name inside it (owner ruling,
 * 2026-08-18): a card that looks like a target should behave like one
 * everywhere inside its own border. It is a real anchor rather than a scripted
 * div, so it works before any script runs and reads as a link to a screen
 * reader; it keeps the card's own weight and color (a.card.cardlink in the
 * theme) so a source name is still a name you can follow rather than a blue
 * link. Without a href it stays a plain div — a card with nowhere to go must
 * not pretend to be a target.
 */
export function sourceCard(input: DashboardCardInput): string {
  const href = safeHref(input.href);
  const subLine = (input.subLine ?? '').trim();
  const line = subLine === '' ? '' : `<div class="ln">${escapeHtml(subLine)}</div>`;
  const inner = `<div class="hd">${statusGlyph(input.status, input.fraction)}${escapeHtml(input.label)}</div>${line}`;
  if (href === undefined) return `<div class="card">${inner}</div>`;
  return `<a class="card cardlink" href="${escapeHtml(href)}">${inner}</a>`;
}

export interface DashboardActionInput {
  label: string;
  /**
   * Which control form the button submits; 'none' renders no button, and
   * 'link' renders a plain link, while 'control_link' mints the same bounded
   * control session as a form before navigating to a protected dashboard page.
   */
  kind: 'oauth' | 'oauth_cancel' | 'api_key' | 'sync_now' | 'disconnect' | 'unpair' | 'link' | 'control_link' | 'none';
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
}

/**
 * Control buttons stay in the form shape the worker's control script already
 * binds to (data-connect-kind / data-sync-kind), so the bearer-token path is
 * unchanged: the read-only dash_ token never reaches these routes.
 */
export function actionButton(action: DashboardActionInput | undefined): string {
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
    return `<form class="rowform" data-sync-kind="sync_now">${source}${button}${message}</form>`;
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

/**
 * The prompt a reader hands their agent to get the worker token (owner ruling,
 * 2026-09-01: the agent may read it out of the worker env file and hand it
 * over in chat). Names the file and the command, never the value.
 */
export const DASHBOARD_WORKER_TOKEN_AGENT_PROMPT =
  'I need the Olympus worker token to unlock the dashboard controls. Run `olympus dashboard token` '
  + '(or read OLYMPUS_WORKER_AUTH_TOKEN from the Olympus worker.env file) and give me the token so I can '
  + 'paste it into the dashboard. Do not change any configuration.';

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
      + `<span class="why"> — on this browser for 30 days from the paste, or until the worker token is rotated</span></div>`
      // Lock clears this browser's cookie. Same custody proof as any control
      // (cookie, same origin, CSRF); a scriptless submit posts nothing useful.
      + `<form class="rowform" data-control-session-kind="lock" method="post" action="/dashboard/control/session/lock">`
      + `<button class="btn quiet" type="submit">Lock</button>`
      + `<span class="actmsg" data-action-message role="status"></span></form></div>`;
  }
  const sheetId = `${DASHBOARD_CONTROL_GATE_ID}-how`;
  const promptId = `${sheetId}-prompt`;
  return `<div class="sect" id="${DASHBOARD_CONTROL_GATE_ID}">Dashboard controls</div>`
    + `<div class="attncard" data-dashboard-control-gate data-state="locked">`
    + `<div class="grow"><span class="name">Input token</span>`
    + `<span class="why"> — unlocks every action on this dashboard; never stored by the page.</span></div>`
    // Fail closed without JavaScript: the field carries NO name, so a native
    // submit sends no token anywhere, and the form's own method is POST to
    // the session route, so a scriptless submit can never put the bearer in
    // a URL, the history, or a request log. The script reads the field by
    // its data attribute and sends the bearer as a header, never as a body.
    + `<form class="rowform" data-control-session-kind="unlock" method="post" action="/dashboard/control/session">`
    + `<input class="keyfield" data-dashboard-control-token type="password"`
    + ` required autocomplete="off" placeholder="Worker token" aria-label="Worker token">`
    + `<button class="btn primary" type="submit">Unlock</button>`
    + `<button class="btn" type="button" data-sheet-toggle="#${sheetId}" aria-controls="${sheetId}" aria-expanded="false">Where is my token?</button>`
    + `<span class="actmsg" data-action-message role="status"></span></form></div>`
    + `<div class="sheet gate" id="${sheetId}" aria-hidden="true">`
    + `<h4>Getting the worker token</h4>`
    + `<p>Ask your agent — copy this prompt into it:</p>`
    + `<div class="promptbox" id="${promptId}">${escapeHtml(DASHBOARD_WORKER_TOKEN_AGENT_PROMPT)}</div>`
    + `<button class="btn primary" type="button" data-copy-target="#${promptId}">Copy prompt</button>`
    + `<span class="copystatus" data-copy-status aria-live="polite"></span>`
    + `<p style="margin-top:12px">Or run this on the machine that hosts Olympus:</p>`
    + `<div class="promptbox"><code>olympus dashboard token</code></div>`
    + `</div>`;
}

export interface DashboardAttentionRowInput {
  label: string;
  /** The "— why" half; empty renders nothing rather than a guess. */
  why?: string;
  action?: DashboardActionInput;
  /** Optional second bounded action, used when Reconnect and Disconnect coexist. */
  secondaryAction?: DashboardActionInput;
  /** 0..100 progress bar, for a first-ingest row. */
  barPercent?: number;
  /** Warm attention tint (true) or plain panel weight (false). */
  attention?: boolean;
  /** This source's detail page. Absent means the row leads nowhere. */
  href?: string;
}

/**
 * A row that says something is wrong, and offers the way to act on it.
 *
 * No warning is a dead end (owner ruling, 2026-08-18): a row with a control
 * keeps the control and turns its name into a link to the source's detail
 * page; a row with no control becomes a link in FULL — same hit zone as a
 * card, with the arrow affordance on the right. A row with neither renders as
 * it always did, because there is genuinely nowhere to send the reader.
 */
export function attentionRow(input: DashboardAttentionRowInput): string {
  const why = (input.why ?? '').trim();
  const reason = why === '' ? '' : `<span class="why"> — ${escapeHtml(why)}</span>`;
  const bar = input.barPercent === undefined
    ? ''
    : progressBar({ percent: input.barPercent, label: `${clampPercent(input.barPercent)} percent` });
  const klass = input.attention === true ? 'attncard' : 'attncard plain';
  const href = safeHref(input.href);
  const control = actionButton(input.action) + actionButton(input.secondaryAction);
  if (href !== undefined && control === '') {
    // A div inside the anchor, not a span: the progress bar is flow content and
    // a span parent would have it reparented out of the row by the parser.
    return `<a class="${klass} rowzone" href="${escapeHtml(href)}">`
      + `<div class="grow"><span class="name">${escapeHtml(input.label)}</span>${reason}${bar}</div>`
      + `<span class="go" aria-hidden="true">→</span>`
      + `</a>`;
  }
  const name = href === undefined
    ? `<span class="name">${escapeHtml(input.label)}</span>`
    : `<a class="name" href="${escapeHtml(href)}">${escapeHtml(input.label)}</a>`;
  // A row that carries a control still leads to its page: the name is the
  // link and so is the arrow at the end, the same affordance the control-less
  // row has, so the reader is never left guessing where to click (owner note,
  // 2026-09-01: "why can't I click on Gmail in the setup page?").
  const go = href === undefined
    ? ''
    : `<a class="go" href="${escapeHtml(href)}" aria-label="${escapeHtml(`${input.label} details`)}">→</a>`;
  return `<div class="${klass}">`
    + `<div class="grow">${name}${reason}${bar}</div>`
    + `${control}${go}`
    + `</div>`;
}

export interface DashboardSetupRowInput {
  label: string;
  /** One plain sentence about what connecting this source does. */
  blurb: string;
  action: DashboardActionInput;
  /**
   * Where the key or app this row asks for actually lives, as a link out to
   * the provider's own console. Rendered at the end of the blurb.
   */
  blurbLink?: DashboardExternalLinkInput;
}

export function setupRow(input: DashboardSetupRowInput): string {
  // No blurb means no empty span and no empty grid column: the row closes up
  // (.setrow.noblurb) rather than holding a visible gap for absent copy.
  const blurb = input.blurb.trim();
  // The blurb is escaped text and the link is built from a parsed https URL,
  // so the one piece of markup inside this span is this module's own — the
  // provider copy never reaches the page as markup.
  const link = input.blurbLink === undefined ? '' : externalLink(input.blurbLink);
  const blurbText = blurb === '' ? '' : escapeHtml(blurb);
  const blurbBody = [blurbText, link].filter((part) => part !== '').join(' ');
  const blurbSpan = blurbBody === '' ? '' : `<span class="blurb">${blurbBody}</span>`;
  // The column closes up only when NOTHING is in it: a row whose whole blurb is
  // the key-location link still needs its column.
  return `<div class="${blurbBody === '' ? 'setrow noblurb' : 'setrow'}">`
    + `${dotGlyph(DASHBOARD_STATUS_COLORS.Off)}`
    + `<span class="name">${escapeHtml(input.label)}</span>`
    + `${blurbSpan}`
    + `${actionButton(input.action)}`
    + `</div>`;
}

export interface DashboardProgressBarInput {
  percent: number;
  /** aria-label text, e.g. "8 percent". */
  label: string;
}

export function progressBar(input: DashboardProgressBarInput): string {
  const percent = clampPercent(input.percent);
  return `<div class="bar" role="progressbar" aria-label="${escapeHtml(input.label)}" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">`
    + `<i style="width:${percent}%"></i>`
    + `</div>`;
}

/**
 * Layout for the background lanes and the home strip that links to them.
 *
 * Kept next to the two components that use it rather than folded into the
 * theme: it is layout for one page and one home section, and the theme file is
 * the token ground truth the whole dashboard shares.
 */
export const DASHBOARD_LANE_CSS = `.bgrow { position: relative; display: block; background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 10px 14px; color: inherit; text-decoration: none; }
.bgrow .bgl { display: grid; grid-template-columns: 110px 1fr 64px; gap: 12px; align-items: center; padding: 3px 0; }
.bgrow .nm { font-weight: 500; font-size: 13px; color: var(--t2); }
.bgrow .fx { color: var(--t3); font-size: 12px; }
.bgrow .go { position: absolute; right: 14px; top: 10px; color: var(--t4); font-size: 13px; }
.bgrow:hover .go, .bgrow:focus-visible .go { color: var(--link); }
.bgrow:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
.minibar { display: block; width: 64px; height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; justify-self: end; }
.minibar i { display: block; height: 100%; background: var(--t3); }
.lanerow { display: grid; grid-template-columns: 110px 64px 1fr auto; gap: 12px; align-items: center; background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
.lanerow .nm { font-weight: 500; font-size: 13px; color: var(--t2); }
.lanerow .st { color: var(--t3); font-size: 12px; }
.lanerow .minibar { justify-self: start; }
.lanestrip { display: flex; gap: 2px; }
.lanestrip i { display: block; width: 7px; height: 20px; border-radius: 2px; }
.disp { font-family: system-ui, sans-serif; font-size: 11px; letter-spacing: .04em; }
.disp.heal { color: var(--good); }
.disp.attn { color: var(--warn); }
@media (max-width: 700px) {
  .lanerow { grid-template-columns: 110px 1fr; }
  .lanerow .minibar, .lanerow .lanestrip { display: none; }
  /* The go arrow is absolutely positioned at the right edge, so the facts
     column keeps clear of it rather than running underneath. */
  .bgrow .bgl { grid-template-columns: 1fr auto; padding-right: 18px; }
}
`;

/**
 * Layout for the three phase bars, the attention banner and the Advanced fold.
 *
 * `.bar.indet` is the bar that refuses to claim a share: a quiet moving band
 * rather than a fill, because a fill at ANY width is a percentage the caller
 * has already said it does not have. The animation is disabled under
 * prefers-reduced-motion, where it becomes a flat neutral band.
 */
export const DASHBOARD_PROGRESS_CSS = `.phase { margin: 0 0 14px; max-width: 520px; }
.phase .ph { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.phase .pn { font-size: 12.5px; font-weight: 600; color: var(--t2); }
.phase .pv { font-size: 12px; color: var(--t3); font-variant-numeric: tabular-nums; text-align: right; }
.phase .bar { max-width: none; margin-top: 6px; height: 5px; border-radius: 3px; }
.phase .pv .st { display: inline-block; margin-left: 10px; padding-left: 10px; border-left: 1px solid var(--line2); font-weight: 600; color: var(--t2); }
.phase.done .pv .st { color: var(--good); }
.phase.working .pv .st { color: var(--run); }
.phase.stalled .pv .st { color: var(--warn); }
.phase.waiting .pv .st { color: var(--t4); }
.phase.waiting .bar { background: var(--line2); }
.phase.waiting .bar i { display: none; }
.bar.indet.working { position: relative; }
.bar.indet.working i { width: 34%; background: var(--run); animation: dashsweep 1.6s ease-in-out infinite; }
@keyframes dashsweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(294%); } }
.settled { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; color: var(--t2); font-size: 13px; max-width: 520px; }
.banner { margin-bottom: 6px; }
.advanced { border-top: 1px solid var(--line); margin-top: 28px; padding-top: 4px; }
.advanced > summary { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--t4); cursor: pointer; padding: 12px 0; list-style: none; }
.advanced > summary::-webkit-details-marker { display: none; }
.advanced > summary::before { content: '\\25B8 '; display: inline-block; transition: transform .12s ease; }
.advanced[open] > summary::before { transform: rotate(90deg); }
.advanced > summary:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  .bar.indet.working i { animation: none; width: 100%; background: var(--line2); }
}
`;

export interface DashboardPhaseBarInput {
  /** The phase's own name, e.g. "Extraction". */
  name: string;
  /** The right-hand facts line, already composed by the caller. */
  facts: string;
  /**
   * 0..100. OMITTED means the caller has no defensible share — the bar then
   * draws the indeterminate band and states no value. Passing a number here is
   * a claim, so a caller that had to fall back must not pass one.
   */
  percent?: number;
  /** What the bar means, for a reader who gets the value read out to them. */
  label: string;
  /** The row's one state word (owner ruling, 2026-09-01). */
  state: 'done' | 'working' | 'stalled' | 'waiting';
  /** The state in words: "Working · moved 40s ago". */
  stateWords: string;
}

/**
 * One phase's bar: its name, its facts in its own unit, its state, and a track.
 *
 * Every bar is the same colour (owner ruling, 2026-09-01: three bars, one
 * colour, correct units — the state word carries the colour instead). A
 * determinate bar carries aria-valuenow, because it has one. An indeterminate
 * bar carries aria-valuetext and NO valuenow, which is the ARIA way of saying
 * the position is unknown — the same honesty the pixels are making, said to a
 * reader who cannot see them.
 */
export function phaseBar(input: DashboardPhaseBarInput): string {
  const state = input.state;
  const heading = `<div class="ph"><span class="pn">${escapeHtml(input.name)}</span>`
    + `<span class="pv">${escapeHtml(input.facts)}<span class="st" data-phase-state="${state}">${escapeHtml(input.stateWords)}</span></span></div>`;
  if (input.percent === undefined) {
    return `<div class="phase ${state}">${heading}`
      + `<div class="bar indet ${state}" role="progressbar" aria-label="${escapeHtml(input.label)}"`
      + ` aria-valuetext="${escapeHtml(`${input.facts} · ${input.stateWords}`)}"><i></i></div></div>`;
  }
  const percent = clampPercent(input.percent);
  return `<div class="phase ${state}">${heading}`
    + `<div class="bar ${state}" role="progressbar" aria-label="${escapeHtml(input.label)}"`
    + ` aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="${escapeHtml(`${input.facts} · ${input.stateWords}`)}"><i style="width:${percent}%"></i></div>`
    + `</div>`;
}

export interface DashboardAttentionBannerInput {
  /** The source this is about. */
  label: string;
  /** What is wrong and what to do, in one sentence. */
  sentence: string;
  /** The real control, when a route for the act exists. */
  action?: DashboardActionInput;
  /** A second control, e.g. the sheet toggle for an agent prompt. */
  secondaryAction?: DashboardActionInput;
}

/**
 * The one banner at the top of a source page.
 *
 * Built on the same row and the same control wiring every other warning uses,
 * so the button here and the button on home cannot behave differently. No live
 * region: it is present on first paint, and announcing it on every 15-second
 * poll would interrupt a reader who is already reading it.
 */
export function attentionBanner(input: DashboardAttentionBannerInput): string {
  return `<div class="attncard banner">`
    + `<div class="grow"><span class="name">${escapeHtml(input.label)}</span>`
    + `<span class="why"> — ${escapeHtml(input.sentence)}</span></div>`
    + `${actionButton(input.action)}${actionButton(input.secondaryAction)}`
    + `</div>`;
}

export interface DashboardAdvancedInput {
  /** Summary text. One word by design: "Advanced". */
  label: string;
  /** Already-escaped section markup, in the order it should appear. */
  body: string;
}

/**
 * The collapsed fold everything else lives under.
 *
 * A real <details>, so it is closed before any script runs, opens without one,
 * and reads as a disclosure to a screen reader. Nothing inside it is altered by
 * being here — the sections keep their own markup, and the fold is the only
 * thing that changed about them.
 */
export function advancedPanel(input: DashboardAdvancedInput): string {
  if (input.body.trim() === '') return '';
  return `<details class="advanced" data-poll-key="advanced"><summary>${escapeHtml(input.label)}</summary>${input.body}</details>`;
}

export interface DashboardMiniBarInput {
  /** 0..100. A lane with no denominator passes no bar at all. */
  percent: number;
  label: string;
}

/** The thin grey lane bar: progress, stated quietly, never in the run color. */
export function miniBar(input: DashboardMiniBarInput): string {
  const percent = clampPercent(input.percent);
  return `<span class="minibar" role="progressbar" aria-label="${escapeHtml(input.label)}" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">`
    + `<i style="width:${percent}%"></i>`
    + `</span>`;
}

/** The four outcomes a strip bar can carry. Colors stay out of the caller. */
export type DashboardLaneTone = 'good' | 'bad' | 'run' | 'idle';

const LANE_TONE_COLORS: Readonly<Record<DashboardLaneTone, string>> = {
  good: 'var(--good)',
  bad: 'var(--bad)',
  run: 'var(--run)',
  idle: 'var(--line)',
};

export interface DashboardLaneStripItem {
  tone: DashboardLaneTone;
  /** What this bar stands for, e.g. "Gmail · completed". Title text only. */
  label: string;
}

export interface DashboardLaneRowInput {
  name: string;
  /** The one line of facts. Empty renders an empty cell, never a guess. */
  facts: string;
  /** 0..100, only for a lane whose progress has a real denominator. */
  percent?: number;
  strip?: readonly DashboardLaneStripItem[];
  /** What the strip is, for the reader who cannot see color. */
  stripLabel?: string;
}

/**
 * One background lane: name, optional bar, facts, optional outcome strip.
 *
 * No status glyph, deliberately — the six-word source vocabulary describes
 * sources, and a lane is not one. Absent cells stay as empty spans so every
 * row's four columns line up down the page.
 */
export function laneRow(input: DashboardLaneRowInput): string {
  const bar = input.percent === undefined
    ? '<span></span>'
    : miniBar({ percent: input.percent, label: `${input.name} progress` });
  const strip = input.strip === undefined || input.strip.length === 0
    ? '<span></span>'
    : `<span class="lanestrip"${input.stripLabel ? ` role="img" aria-label="${escapeHtml(input.stripLabel)}"` : ''}>`
      + input.strip.map((item) =>
        `<i style="background:${LANE_TONE_COLORS[item.tone] ?? LANE_TONE_COLORS.idle}" title="${escapeHtml(item.label)}"></i>`).join('')
      + `</span>`;
  return `<div class="lanerow">`
    + `<span class="nm">${escapeHtml(input.name)}</span>`
    + `${bar}`
    + `<span class="st">${escapeHtml(input.facts)}</span>`
    + `${strip}`
    + `</div>`;
}

export interface DashboardBackgroundRowLine {
  name: string;
  facts: string;
  /** 0..100; omitted for a lane with nothing measurable to show. */
  percent?: number;
}

export interface DashboardBackgroundRowInput {
  /** Where the whole card leads. Same-document paths only. */
  href: string;
  /** Accessible name for the link, e.g. "Background work details". */
  label: string;
  lines: readonly DashboardBackgroundRowLine[];
}

/**
 * Home's background card: one line per lane, the whole card a link. A real
 * anchor rather than the mockup's scripted div, so it works before any script
 * runs and reads as a link to a screen reader.
 */
export function backgroundRow(input: DashboardBackgroundRowInput): string {
  const href = safeHref(input.href);
  const lines = input.lines.map((line) => {
    const bar = line.percent === undefined
      ? '<span></span>'
      : miniBar({ percent: line.percent, label: `${line.name} progress` });
    return `<span class="bgl"><span class="nm">${escapeHtml(line.name)}</span>`
      + `<span class="fx">${escapeHtml(line.facts)}</span>${bar}</span>`;
  }).join('');
  if (href === undefined) {
    return `<div class="bgrow">${lines}</div>`;
  }
  return `<a class="bgrow" href="${escapeHtml(href)}" aria-label="${escapeHtml(input.label)}">`
    + `${lines}<span class="go" aria-hidden="true">→</span>`
    + `</a>`;
}

/**
 * Layout for the two policy surfaces: the sensitivity page's category rows and
 * tier table, and the detail page's scope rows and review chips.
 *
 * One constant rather than two because both pages want the same quiet line and
 * the same tabular treatment, and a page carrying a few unused rules costs less
 * than the same rule written twice.
 */
export const DASHBOARD_POLICY_CSS = `.catrow { display: grid; grid-template-columns: 140px 1fr auto; gap: 12px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
.catrow .name { font-weight: 600; color: var(--t2); }
.catrow .what { color: var(--t4); font-size: 12px; }
.catrow .tier { color: var(--t3); font-size: 12px; font-variant-numeric: tabular-nums; }
.scoperow { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 10px 14px; margin-bottom: 6px; }
.scoperow .rid { font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--t2); }
.scoperow .what { color: var(--t3); font-size: 12.5px; }
.sect.gap { margin-top: 44px; }
.quiet { color: var(--t4); font-size: 12px; margin: -2px 0 10px; max-width: 66ch; }
.quiet.after { margin: 8px 0 0; }
.tiersnote { color: var(--t3); font-size: 12.5px; margin: 0 0 12px; max-width: 66ch; }
.tiernote { font-size: 12.5px; margin-top: 10px; }
.pm { color: var(--t4); }
.pm.yes { color: var(--good); }
.tname { color: var(--t1); font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: var(--panel); border: 1px solid var(--line2); border-radius: 999px; padding: 3px 11px; color: var(--t3); font-size: 12px; }
.chip b { color: var(--t2); font-weight: 600; font-variant-numeric: tabular-nums; }
.vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (max-width: 700px) {
  .catrow { grid-template-columns: 1fr; gap: 4px; }
}
`;

export interface DashboardCategoryRowInput {
  /** The owner's category name, e.g. Financial. */
  name: string;
  /** Their own examples, joined. Empty renders an empty cell, never filler. */
  interpretation: string;
  /** The quiet right-hand fact, e.g. "Secure (S4) · 12 match terms". */
  note: string;
}

/**
 * One secure category, read-only.
 *
 * No remove control and no add field: neither has a write route, and a button
 * that cannot do what it says is worse than an honest list.
 */
export function categoryRow(input: DashboardCategoryRowInput): string {
  return `<div class="catrow">`
    + `<span class="name">${escapeHtml(input.name)}</span>`
    + `<span class="what">${escapeHtml(input.interpretation)}</span>`
    + `<span class="tier">${escapeHtml(input.note)}</span>`
    + `</div>`;
}

/**
 * A tier-table permission cell. The mark is decorative and the word beside it
 * is the real content, so a reader who cannot see the glyph still hears which
 * way the policy falls.
 */
export function permissionCell(allowed: boolean): string {
  const mark = allowed ? '✓' : '✕';
  const word = allowed ? 'Permitted' : 'Not permitted';
  return `<td class="pm${allowed ? ' yes' : ''}">`
    + `<span aria-hidden="true">${mark}</span><span class="vh">${word}</span>`
    + `</td>`;
}

export interface DashboardScopeRowInput {
  /** The rule's own id. Never its prefix, folder name or reason. */
  ruleId: string;
  /** The one line of facts about this rule, already composed. */
  facts: string;
}

/**
 * One scope rule: id, disposition and counts.
 *
 * The configured prefix stays off this page — /dashboard.json promises no file
 * paths and no file names, and it is reachable with the read-only query token —
 * so the row names the rule and the bearer-gated picker carries the paths.
 */
export function scopeRow(input: DashboardScopeRowInput): string {
  return `<div class="scoperow">`
    + `<span><b class="rid">${escapeHtml(input.ruleId)}</b> <span class="what">${escapeHtml(input.facts)}</span></span>`
    + `</div>`;
}

export interface DashboardCountChipInput {
  count: string;
  label: string;
}

/** A count and what it counts, in one quiet pill. */
export function countChip(input: DashboardCountChipInput): string {
  return `<span class="chip"><b>${escapeHtml(input.count)}</b> ${escapeHtml(input.label)}</span>`;
}

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
    + `<button class="btn primary" type="button" data-copy-target="#${promptId}">${escapeHtml(input.copyButtonLabel)}</button>`
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
  /** Per-field placeholder overrides, by field name. */
  placeholders?: Partial<Record<DashboardConnectFieldName, string>>;
  /** A bounded sentence above everything, e.g. what the provider refused. */
  notice?: string;
  /** Renders the Cancel control for a source whose attempt is still pending. */
  cancellable?: boolean;
  /** The submit button's word; defaults to Connect. */
  submitLabel?: string;
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
    const value = input.values?.[field.name];
    const placeholder = input.placeholders?.[field.name] ?? field.label;
    // A prefilled value is rendered as an ordinary editable input, never as a
    // read-only display: a wrong Client ID is exactly the thing the owner came
    // here to change (owner, 2026-09-03).
    return `<input class="keyfield" type="${field.secret ? 'password' : 'text'}" name="${escapeHtml(field.name)}"`
      + `${field.required ? ' required' : ''}`
      + `${value === undefined ? '' : ` value="${escapeHtml(value)}"`}`
      + ` placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(field.label)}">`;
  }).join('');
  const notice = input.notice === undefined || input.notice.trim() === ''
    ? ''
    : `<p class="why">${escapeHtml(input.notice)}</p>`;
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
      + `<button class="btn quiet" type="submit">Cancel connection attempt</button>`
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
  return `<div class="sheet" id="${id}" aria-hidden="true">`
    + `<h4>${escapeHtml(input.heading)}</h4>`
    + `${notice}`
    + `<p>${escapeHtml(input.intro)}</p>`
    + `${registration}`
    + `${redirect}`
    + `<form class="rowform" data-connect-kind="oauth" style="margin-top:12px">`
    + `<input type="hidden" name="source" value="${escapeHtml(input.source)}">`
    + `${inputs}`
    + `<button class="btn primary" type="submit">${escapeHtml(input.submitLabel ?? 'Connect')}</button>`
    + `<span class="actmsg" data-action-message role="status"></span>`
    // Where the authorization link lands when the browser blocks the new tab.
    + `<span class="authfallback" data-authorization-fallback></span>`
    + `</form>`
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
): { sheetId: string; sheet: string } {
  const sheetId = `setup-${source.source_id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
  const sheet = connectSetupSheet({
    id: sheetId,
    heading: `Set up ${source.label}`,
    intro: action.instructions.plain_intro,
    promptText: action.instructions.agent_prompt,
    source: action.source,
    fields: action.instructions.fields,
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
  options: { notice?: string } = {},
): { sheetId: string; sheet: string } | undefined {
  const instructions = action.instructions;
  if (instructions === undefined) return undefined;
  const sheetId = `connect-${source.source_id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
  // Only the client id is required here. The secret this source already stored
  // is what makes it an `oauth` action rather than a `needs_setup` one, so a
  // required secret field would demand the owner re-paste a credential the
  // worker already holds; blank means "keep the stored one".
  const fields = instructions.fields.map((field) => (
    field.name === 'client_id' ? field : { ...field, required: false }
  ));
  const secretPlaceholders = Object.fromEntries(instructions.fields
    .filter((field) => field.name !== 'client_id')
    .map((field) => [field.name, `${field.label} — leave blank to keep the stored one`]));
  const sheet = connectSetupSheet({
    id: sheetId,
    heading: `${action.label} ${source.label}`,
    intro: instructions.plain_intro,
    promptText: instructions.agent_prompt,
    source: action.source,
    fields,
    submitLabel: action.label,
    ...(Object.keys(secretPlaceholders).length > 0 ? { placeholders: secretPlaceholders } : {}),
    ...(action.known_client_id ? { values: { client_id: action.known_client_id } } : {}),
    ...(action.pending_attempt ? { cancellable: true } : {}),
    ...(options.notice === undefined ? {} : { notice: options.notice }),
    ...redirectUriInput(action),
  });
  return { sheetId, sheet };
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

/**
 * Control wiring for every connect, sync, embedding, or Disconnect form on
 * the page. Delegated from document, like the
 * clipboard script, because the poll replaces the whole body.
 *
 * The endpoint is chosen from a closed set of attributes rather than read off
 * the form: a page that could name its own POST target would turn any future
 * markup bug into a request at an arbitrary path.
 *
 * The worker bearer token is used once to mint a short-lived HttpOnly control
 * session, then discarded. The session is origin-bound and every control POST
 * carries its CSRF token. Neither the worker bearer nor the session id is ever
 * placed in localStorage/sessionStorage or a URL. The read-only dash_ token is
 * refused by name.
 */
export function controlScript(input: { csrfToken?: string | undefined } = {}): string {
  const initialCsrfToken = escapeScriptJson(JSON.stringify(input.csrfToken ?? ''));
  return `<script>
      (function () {
        var csrfToken = ${initialCsrfToken};
        function say(form, text) {
          var message = form.querySelector('[data-action-message]');
          if (message) message.textContent = text;
        }
        async function mintSession(form) {
          var field = form.querySelector('[data-dashboard-control-token]');
          var pasted = field instanceof HTMLInputElement ? field.value.trim() : '';
          if (!pasted) { say(form, 'Paste the worker bearer token.'); if (field) field.focus(); return false; }
          if (pasted.indexOf('dash_') === 0) {
            say(form, 'That is the read-only view token; use the worker bearer token from setup.');
            field.value = '';
            field.focus();
            return false;
          }
          try {
            var response = await fetch('/dashboard/control/session', {
              method: 'POST', cache: 'no-store', credentials: 'same-origin',
              headers: { 'Authorization': 'Bearer ' + pasted },
            });
            pasted = '';
            field.value = '';
            var payload = {};
            try { payload = await response.json(); } catch (error) {}
            if (!response.ok || !payload.csrf_token) { say(form, 'That token was not accepted.'); return false; }
            csrfToken = payload.csrf_token;
            window.location.reload();
            return true;
          } catch (error) {
            pasted = '';
            field.value = '';
            say(form, 'Could not reach the worker.');
            return false;
          }
        }
        async function ensureSession(form) {
          if (csrfToken) return true;
          var field = document.querySelector('[data-dashboard-control-token]');
          say(form, 'Unlock dashboard controls above first.');
          if (field instanceof HTMLInputElement) { field.focus(); field.scrollIntoView({ block: 'center' }); }
          return false;
        }
        async function lockSession(form) {
          say(form, 'Locking\u2026');
          try {
            var response = await fetch('/dashboard/control/session/lock', {
              method: 'POST', cache: 'no-store', credentials: 'same-origin',
              headers: { 'X-Olympus-CSRF': csrfToken },
            });
            if (!response.ok) { say(form, 'Could not lock.'); return; }
            csrfToken = '';
            window.location.reload();
          } catch (error) { say(form, 'Could not reach the worker.'); }
        }
        function clearFallback(form) {
          var slot = form.querySelector('[data-authorization-fallback]');
          if (slot) slot.textContent = '';
        }
        // The tab the authorization will land in, opened SYNCHRONOUSLY inside
        // the submit event so the browser counts it as user-initiated. It
        // cannot be opened later: /dashboard/connect/oauth/start has to be
        // awaited first, and a window.open after that await is a popup.
        //
        // 'noopener' is deliberately NOT passed here. Per the HTML spec a
        // window.open with noopener returns null even when it succeeds, so the
        // old call could never tell a blocked tab from an opened one and every
        // connect claimed the browser had blocked it. The opener reference is
        // severed by hand instead, which is what noopener was there for.
        function openAuthorizationTab() {
          var tab = null;
          try { tab = window.open('', '_blank'); } catch (error) { tab = null; }
          if (tab) { try { tab.opener = null; } catch (error) {} }
          return tab;
        }
        function closeAuthorizationTab(tab) {
          if (!tab) return;
          try { tab.close(); } catch (error) {}
        }
        // Where the reader goes when no tab could be pre-opened. It says only
        // what is true — no tab opened — without asserting a cause the page
        // cannot know. Built as a node with a checked https href, never as
        // markup: the URL is the worker's own origin-checked authorization
        // URL, and it is still never interpolated into HTML.
        function showFallback(form, url) {
          var slot = form.querySelector('[data-authorization-fallback]');
          if (!slot || String(url).indexOf('https://') !== 0) return;
          slot.textContent = '';
          var link = document.createElement('a');
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.className = 'hint';
          link.textContent = "If a new tab didn't open, open it here";
          slot.appendChild(link);
        }
        async function submitControl(form, authorizationTab) {
          if (!await ensureSession(form)) { closeAuthorizationTab(authorizationTab); return; }
          var body = Object.fromEntries(new FormData(form).entries());
          var connectKind = form.getAttribute('data-connect-kind');
          var disconnectKind = form.getAttribute('data-disconnect-kind');
          var unpairKind = form.getAttribute('data-unpair-kind');
          if (disconnectKind || unpairKind) {
            var fallbackConfirmation = unpairKind ? 'Unpair this source?' : 'Disconnect this source?';
            var confirmation = form.getAttribute('data-confirmation') || fallbackConfirmation;
            if (!window.confirm(confirmation)) return;
            body.acknowledge = true;
          }
          var endpoint = unpairKind
            ? '/dashboard/unpair'
            : disconnectKind
            ? '/dashboard/disconnect'
            : connectKind
            ? (connectKind === 'oauth'
              ? '/dashboard/connect/oauth/start'
              : connectKind === 'oauth_cancel'
                ? '/dashboard/connect/oauth/cancel'
                : '/dashboard/connect/api-key')
            : form.hasAttribute('data-embedding-kind')
              ? '/dashboard/embedding-priority'
              : '/dashboard/sync-now';
          if (connectKind === 'oauth') { body.return_to = window.location.href; clearFallback(form); }
          say(form, 'Starting\\u2026');
          try {
            var response = await fetch(endpoint, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'X-Olympus-CSRF': csrfToken, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            var payload = {};
            try { payload = await response.json(); } catch (error) {}
            if (response.status === 401) {
              csrfToken = '';
              closeAuthorizationTab(authorizationTab);
              say(form, 'The control session expired \\u2014 submit again to unlock controls.');
              return;
            }
            if (!response.ok || payload.ok !== true) {
              closeAuthorizationTab(authorizationTab);
              say(form, (payload && payload.error && payload.error.message) || 'Request failed.');
              return;
            }
            if (payload.authorization_url) {
              // A NEW TAB, never this one. Navigating the dashboard away lost
              // the page the owner has to come back to, and a provider that
              // refuses the request leaves them on the provider's error page
              // with no way back (owner, 2026-09-03). The dashboard keeps
              // polling here and updates when the callback lands.
              if (authorizationTab) {
                authorizationTab.location = payload.authorization_url;
                say(form, 'Authorization opened in a new tab. Approve it there, then come back to this page.');
              } else {
                say(form, 'Open the authorization page to continue.');
                showFallback(form, payload.authorization_url);
              }
              return;
            }
            closeAuthorizationTab(authorizationTab);
            form.reset();
            // The route's own words when it has any. A partial Unpair reports
            // what is still on disk, and showing the generic "Done" over that
            // was a completion claim the response did not make.
            say(form, payload.status_message || 'Done. Waiting for the next refresh.');
          } catch (error) {
            closeAuthorizationTab(authorizationTab);
            say(form, 'Could not reach the worker.');
          }
        }
        document.addEventListener('submit', function (event) {
          var form = event.target;
          if (!(form instanceof HTMLFormElement)) return;
          if (form.hasAttribute('data-control-session-kind')) {
            event.preventDefault();
            if (form.getAttribute('data-control-session-kind') === 'lock') void lockSession(form);
            else void mintSession(form);
            return;
          }
          if (!form.hasAttribute('data-connect-kind')
            && !form.hasAttribute('data-sync-kind')
            && !form.hasAttribute('data-embedding-kind')
            && !form.hasAttribute('data-disconnect-kind')
            && !form.hasAttribute('data-unpair-kind')) return;
          event.preventDefault();
          // Still inside the user gesture: the only moment a new tab may be
          // opened without the browser treating it as a popup.
          var authorizationTab = form.getAttribute('data-connect-kind') === 'oauth'
            ? openAuthorizationTab()
            : null;
          void submitControl(form, authorizationTab);
        });
        document.addEventListener('click', function (event) {
          var target = event.target instanceof Element ? event.target : null;
          var control = target && target.closest('[data-control-link]');
          if (!control) return;
          event.preventDefault();
          var host = control.closest('.rowlink') || control;
          void ensureSession(host).then(function (ready) {
            if (!ready) return;
            window.location.assign(control.getAttribute('data-control-link'));
          });
        });
      })();
    </script>`;
}

/**
 * Clipboard copy wiring for every [data-copy-target] on the page.
 *
 * Delegated from document, never bound per element: the poll below replaces
 * the whole body, and a listener on a replaced node dies with it.
 */
export function clipboardScript(): string {
  return `<script>
      (function () {
        function copyText(node) {
          if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return node.value;
          return node.innerText || node.textContent || '';
        }
        function announce(button, message) {
          var status = button.parentElement && button.parentElement.querySelector('[data-copy-status]');
          if (status) status.textContent = message;
        }
        document.addEventListener('click', function (event) {
          var target = event.target instanceof Element ? event.target : null;
          if (!target) return;
          var toggle = target.closest('[data-sheet-toggle]');
          if (toggle) {
            var sheet = document.querySelector(toggle.getAttribute('data-sheet-toggle'));
            if (!sheet) return;
            var open = sheet.classList.toggle('on');
            sheet.setAttribute('aria-hidden', open ? 'false' : 'true');
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            return;
          }
          var copy = target.closest('[data-copy-target]');
          if (!copy) return;
          var source = document.querySelector(copy.getAttribute('data-copy-target'));
          if (!source) return;
          var text = copyText(source);
          var label = copy.textContent;
          if (!navigator.clipboard) {
            announce(copy, 'Clipboard unavailable — select the text and copy it with your keyboard.');
            return;
          }
          navigator.clipboard.writeText(text).then(function () {
            copy.textContent = 'Copied';
            announce(copy, 'Copied to the clipboard.');
            setTimeout(function () { copy.textContent = label; }, 1600);
          }).catch(function () {
            announce(copy, 'Clipboard unavailable — select the text and copy it with your keyboard.');
          });
        });
      })();
    </script>`;
}

export interface DashboardPollScriptInput {
  /** Poll cadence. Every page today takes the 15000ms default. */
  intervalMs?: number;
  /** Signature of the currently rendered view, compared to each poll. */
  signature: string;
  /** The custody state this render was made under. */
  unlocked?: boolean;
  /** Non-secret fingerprint of the control session this render holds; '' when locked. */
  session?: string;
}

/**
 * The /dashboard.json poll loop. Carries the dash_ query token through from
 * window.location, never from a server-side interpolation, and refuses to
 * reload over unsaved input.
 *
 * It refetches this page's own URL — the token already in the address bar
 * rides along — and swaps the body only when the served signature differs, so
 * a quiet dashboard never flickers. The header meta is copied over on every
 * poll regardless, so "checked Ns ago" never freezes on a quiet page, and an
 * open sheet blocks the swap so a prompt is never yanked mid-read. The
 * signature travels in the marker span below, which the fetched document
 * carries too.
 *
 * One poll at a time. A render costs what the server's slowest source costs,
 * and a bare interval starts another the moment the clock says so whether or
 * not the last one came back — so a page that renders slower than its cadence
 * builds a queue of overlapping renders, each of them making the next one
 * slower. Skipping a tick while one is still in flight bounds the page to one
 * outstanding render however slow the server gets.
 */
export function pollScript(input: DashboardPollScriptInput): string {
  const interval = Number.isFinite(input.intervalMs) && (input.intervalMs ?? 0) > 0
    ? Math.round(input.intervalMs as number)
    : 15000;
  const signature = escapeScriptJson(JSON.stringify(input.signature));
  const unlocked = input.unlocked === true ? 'true' : 'false';
  const session = escapeScriptJson(JSON.stringify(input.session ?? ''));
  return `<span id="dashboard-poll-signature" data-signature="${escapeHtml(input.signature)}" data-unlocked="${unlocked}" data-session="${escapeHtml(input.session ?? '')}" style="display:none"></span>
    <script>
      (function () {
        var current = ${signature};
        var unlocked = ${unlocked};
        var session = ${session};
        var deferredSince = 0;
        function signatureOf(doc) {
          var marker = doc.getElementById('dashboard-poll-signature');
          return marker ? marker.getAttribute('data-signature') || '' : '';
        }
        function unlockedIn(doc) {
          var marker = doc.getElementById('dashboard-poll-signature');
          return marker ? marker.getAttribute('data-unlocked') === 'true' : false;
        }
        function sessionIn(doc) {
          var marker = doc.getElementById('dashboard-poll-signature');
          return marker ? marker.getAttribute('data-session') || '' : '';
        }
        function focusKey(node) {
          if (!node || node === document.body || node === document.documentElement) return '';
          return node.id ? '#' + node.id
            : node.getAttribute && node.getAttribute('href') ? 'href:' + node.getAttribute('href')
            : node.tagName + ':' + (node.textContent || '').trim().slice(0, 60);
        }
        function findByFocusKey(key) {
          if (!key) return null;
          if (key.charAt(0) === '#') return document.getElementById(key.slice(1));
          var candidates = document.querySelectorAll('a, button, summary, [tabindex]');
          for (var index = 0; index < candidates.length; index += 1) {
            if (focusKey(candidates[index]) === key) return candidates[index];
          }
          return null;
        }
        function typing() {
          var active = document.activeElement;
          if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return true;
          // A focused button or link defers a swap, but not forever: after two
          // minutes the page refreshes and puts focus back by key, so a reader
          // who tabbed onto a link and walked away is not left stale.
          if (active && active !== document.body && active !== document.documentElement) {
            if (!deferredSince) deferredSince = Date.now();
            if (Date.now() - deferredSince < 120000) return true;
          } else {
            deferredSince = 0;
          }
          var fields = document.querySelectorAll('input:not([type=hidden]), textarea');
          for (var index = 0; index < fields.length; index += 1) {
            if ((fields[index].value || '').trim() !== '') return true;
          }
          return false;
        }
        var inFlight = false;
        async function refresh() {
          if (document.hidden) return;
          if (typing()) return;
          if (document.querySelector('.sheet.on')) return;
          if (inFlight) return;
          inFlight = true;
          try {
            var response = await fetch(window.location.href, { cache: 'no-store' });
            if (!response.ok) return;
            var next = new DOMParser().parseFromString(await response.text(), 'text/html');
            var meta = document.querySelector('.top .meta');
            var nextMeta = next.querySelector('.top .meta');
            if (meta && nextMeta) meta.textContent = nextMeta.textContent;
            // Custody changed under this tab (unlocked elsewhere, expired,
            // rotated): swapped-in markup does not run its scripts, so the
            // control handler would keep a stale CSRF token. Reload instead.
            if (unlockedIn(next) !== unlocked || sessionIn(next) !== session) { window.location.reload(); return; }
            var signature = signatureOf(next);
            if (signature !== '' && signature === current) return;
            current = signature;
            // Keep the reader's open disclosures open across the swap, keyed
            // by their summary text so a disclosure that came or went does
            // not shift the others.
            var open = {};
            function disclosureKey(node) {
              var summary = node.querySelector('summary');
              return node.getAttribute('data-poll-key') || (summary ? summary.textContent.trim() : '');
            }
            Array.prototype.forEach.call(document.querySelectorAll('details'), function (node) {
              if (node.open) open[disclosureKey(node)] = true;
            });
            var focused = focusKey(document.activeElement);
            document.body.innerHTML = next.body.innerHTML;
            Array.prototype.forEach.call(document.querySelectorAll('details'), function (node) {
              if (open[disclosureKey(node)]) node.open = true;
            });
            var restore = findByFocusKey(focused);
            if (restore && typeof restore.focus === 'function') restore.focus();
            deferredSince = 0;
          } catch (error) {
          } finally {
            inFlight = false;
          }
        }
        setInterval(refresh, ${interval});
      })();
    </script>`;
}

/** The change signature a poll compares against; same shape for both sides. */
export interface DashboardSignatureOptions {
  /** True when the render was unlocked: custody is part of what the page shows. */
  controlSession?: boolean;
  embeddingRuntime?: EmbeddingRuntimeFacts;
  now?: Date;
}

/**
 * Everything the rendered page can differ on, so the poll swaps the body when
 * — and only when — something visible changed.
 *
 * Beyond the counts: the custody state (an expired or rotated session must
 * not leave a page reading "unlocked" with dead controls), the embedding
 * lane's own run state, each row's phase state word, and — while a row is
 * Working — the age of its last rise in whole minutes, so "moved 40s ago"
 * cannot sit unchanged for an hour and a Working row flips to Stalled the
 * minute it should.
 */
export function dashboardSignature(
  sources: readonly DashboardSourceCard[],
  options: DashboardSignatureOptions = {},
): string {
  const now = options.now ?? new Date();
  return JSON.stringify([
    options.controlSession === true,
    options.embeddingRuntime?.state ?? null,
    options.embeddingRuntime?.stateLine ?? null,
    sources.map((source) => {
      const progress = dashboardSourceProgress(source, {
        now,
        ...(options.embeddingRuntime === undefined ? {} : { embeddingRuntime: options.embeddingRuntime }),
      });
      return [
        source.source_id,
        source.connection.state,
        source.connection.label,
        source.answer_readiness.state,
        source.coverage.indexed_items,
        source.coverage.content_ready_items,
        source.coverage.embedded_items,
        source.coverage.embedded_files ?? null,
        source.queue_health.waiting,
        source.queue_health.needs_attention,
        progress.phases.map((phase) => [
          phase.state,
          phase.state === 'working' ? movementAgeMinutes(source, phase.id, now) : null,
        ]),
      ];
    }),
  ]);
}

function movementAgeMinutes(source: DashboardSourceCard, id: DashboardPhaseId, now: Date): number | null {
  const movement = source.movement;
  const at = id === 'metadata_sync'
    ? movement?.metadata_sync_at
    : id === 'extraction'
      ? movement?.extraction_at
      : movement?.embedding_at;
  const movedAt = Date.parse(at ?? '');
  return Number.isFinite(movedAt) ? Math.max(0, Math.floor((now.getTime() - movedAt) / 60_000)) : null;
}
