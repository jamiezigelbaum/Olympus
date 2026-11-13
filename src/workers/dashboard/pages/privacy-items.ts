/**
 * Privacy › Your items (issues #1060, #887; mockups release-1.5/l3/v2 L3-1
 * to L3-3 and L3-6): find one item, read what it says, and change its label
 * to Personal or Private for that item only, or give it back to the judge.
 *
 * The page is a thin client of the engine's dashboard routes
 * (`/dashboard/privacy/items/find` and `/set`, classification/tier-owner-items.ts),
 * which take only a session minted on this computer. Lowering to Personal
 * asks first; raising to Private never does. Secret items are never listed.
 * Copy is in vocabulary.ts (DASHBOARD_PRIVACY_ITEMS_COPY).
 */
import { DASHBOARD_CONTROL_GATE_ID, escapeHtml, escapeScriptJson, pageShell } from '../components.ts';
import { dashboardLocalPageHref } from '../host-page.ts';
import { DASHBOARD_OUTSIDE_HELP_PATHS } from '../outside-help.ts';
import { SOURCE_LOGO_CSS, sourceLogoTilesByProvider } from '../source-logos.ts';
import { LOCAL_PAGE_CSS } from '../static-styles.ts';
import { dashboardTopNav, TOP_NAV_CSS } from '../top-nav.ts';
import {
  DASHBOARD_PRIVACY_ITEMS_COPY as C,
  DASHBOARD_PRIVATE_ANSWERS_COPY as W,
  JUDGE_REASON_PHRASES,
  DASHBOARD_UNREADABLE_FILE_REASON_WORDS,
} from '../vocabulary.ts';
import { JUDGE_CHECK_CSS, JUDGE_CHECK_ITEMS_CHANGED_EVENT, JUDGE_CHECK_MOUNT, judgeCheckClientScript } from './judge-check.ts';
import type { DashboardPageOptions } from './local.ts';
import { dashboardPrivacyTabs, PRIVACY_TABS_CSS } from './private-answers.ts';

export const DASHBOARD_PRIVACY_ITEMS_PATHS = {
  find: '/dashboard/privacy/items/find',
  set: '/dashboard/privacy/items/set',
  read: '/dashboard/privacy/items/read',
} as const;

/** How long the confirmation with Undo stays up after a change. */
/** The items list on this tab, which the check's "See them in Your items" link scrolls to. */
export const PRIVACY_ITEMS_LIST_ID = 'your-items';

export const PRIVACY_ITEMS_TOAST_MS = 6_000;
/** How long typing settles before the search runs. */
export const PRIVACY_ITEMS_SEARCH_DEBOUNCE_MS = 250;

const PRIVACY_ITEMS_CSS = `
.pi { width: 100%; min-width: 0; max-width: min(1120px, 100%); }
.pi .pigrid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(340px, .9fr); gap: 28px; align-items: start; }
.pi .pimain, .pi .piside { min-width: 0; }
.pi .piside:empty { display: none; }
.pi h3.sect { margin: 0 0 6px; }
.pi .pifind { display: flex; gap: 10px; align-items: center; margin: 12px 0 0; background: var(--bg); border: 1px solid var(--field, var(--line)); border-radius: 9px; padding: 9px 12px; color: var(--t3); }
.pi .pifind:focus-within { outline: 2px solid var(--link); outline-offset: 1px; }
.pi .pifind input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: var(--t1); font: inherit; }
.pi .picap { margin: 14px 0 8px; color: var(--t3); font-size: 13px; }
.pi .picap[hidden] { display: none; }
.pi .pichips { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 14px; }
.pi .pichip { border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; color: var(--t2); font: inherit; font-size: var(--fs-body); background: none; cursor: pointer; }
.pi .pichip[aria-pressed="true"] { background: var(--panel2); border-color: var(--link); color: var(--t1); font-weight: 600; }
.pi .pichip:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.pi .pichip i { font-style: normal; color: var(--t3); font-weight: 400; margin-left: 4px; }
.pi .pichip i:empty { display: none; }
.pi .pimsg { margin: 0 0 8px; color: var(--t2); }
.pi .pimsg:empty { display: none; }
.pi .pimsg[data-state="error"] { color: var(--bad); }
.pi .pilist { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.pi .pilist > li { min-width: 0; }
.pi .pirow { display: flex; gap: 12px; align-items: center; width: 100%; padding: 11px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; min-width: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.pi .pirow:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.pi .pirow[aria-expanded="true"] { border-color: var(--link); background: var(--panel2); }
.pi .grow { flex: 1; min-width: 0; }
.pi .pititle { display: block; color: var(--t1); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pi .pimeta { display: block; color: var(--t3); font-size: var(--fs-body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pi .piend { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: none; }
.pi .piyou { color: var(--t3); font-size: 12.5px; white-space: nowrap; }
.pi .pipill, .pidialog .pipill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; white-space: nowrap; background: var(--panel2); color: var(--t2); }
.pi .pipill.Personal, .pidialog .pipill.Personal { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
.pi .pipill.Private, .pidialog .pipill.Private { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.pi .logotile.sm, .pidialog .logotile.sm { width: 28px; height: 28px; border-radius: 7px; }
.pi .logotile.sm svg, .pidialog .logotile.sm svg { width: 17px; height: 17px; }
.pi .pidetail { background: var(--panel); border: 1px solid var(--link); border-radius: 12px; padding: 18px 20px; min-width: 0; }
.pi .pilist .pidetail { margin-top: 0; }
.pi .pidhead { display: flex; gap: 12px; align-items: flex-start; }
.pi .pidhead h4 { margin: 0; font-size: var(--fs-row); line-height: 1.35; overflow-wrap: anywhere; }
.pi .pidhead .pimeta { white-space: normal; }
.pi .pix, .pidialog .pix { flex: none; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; color: var(--t3); font-size: 18px; border: 0; background: none; cursor: pointer; }
.pi .pix:focus-visible, .pidialog .pix:focus-visible { outline: 2px solid var(--link); }
.pi .pidcap { color: var(--t3); font-size: 12.5px; margin: 16px 0 6px; }
.pi .piprev { background: var(--bg); border: 1px solid var(--line2); border-radius: 8px; padding: 11px 13px; color: var(--t2); font-size: var(--fs-body); line-height: 1.5; overflow-wrap: anywhere; white-space: pre-wrap; max-height: 16em; overflow: auto; }
.pi .pipair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pi .piopt, .pidialog .piopt { display: block; width: 100%; border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; background: var(--bg); min-width: 0; color: inherit; font: inherit; text-align: left; }
.pi .piopt { cursor: pointer; }
.pi .piopt:disabled { cursor: default; }
.pi .piopt:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.pi .piopt b, .pidialog .piopt b { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; color: var(--t1); white-space: nowrap; }
.pi .piopt > span, .pidialog .piopt > span { display: block; color: var(--t3); font-size: 13px; margin-top: 3px; line-height: 1.4; }
.pi .piopt[aria-checked="true"], .pidialog .piopt.on { border-color: var(--link); background: var(--panel2); box-shadow: inset 0 0 0 1px var(--link); }
.pi .piradio { flex: none; width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--t4); box-sizing: border-box; }
.pi .piopt[aria-checked="true"] .piradio { border: 4px solid var(--link); }
.pi .piwhy { margin: 12px 0 0; color: var(--t2); font-size: var(--fs-body); }
.pi .piundo { display: flex; gap: 12px; align-items: center; margin-top: 12px; }
.pi .piundo .piwhy { margin: 0; flex: 1; }
.pi .pistatus { margin: 10px 0 0; color: var(--bad); font-size: var(--fs-body); }
.pi .pistatus:empty { display: none; }
.pi .pifoot { margin: 14px 0 0; padding-top: 12px; border-top: 1px solid var(--line2); color: var(--t3); font-size: 13px; line-height: 1.5; }
.pi .paunlock { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin: 12px 0 16px; padding: 10px 14px; background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; }
.pi .paunlock .hint { color: var(--t2); }
.pi .piapps { margin-top: 14px; color: var(--t3); font-size: 13px; }
.pidialog { padding: 0; box-shadow: 0 20px 60px rgba(0, 0, 0, .5); }
.pidialog .pidbody { padding: 20px 22px; }
.pidialog .pidtop { display: flex; align-items: flex-start; gap: 12px; }
.pidialog .pidtop h3 { flex: 1; }
.pidialog .pidtop .pix { margin: -6px -8px 0 0; }
.pidialog .piitem { display: flex; gap: 10px; align-items: center; min-width: 0; }
.pidialog .pititle { display: block; color: var(--t1); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pidialog .pimeta { display: block; color: var(--t3); font-size: var(--fs-body); }
.pidialog .piarrow { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 10px; align-items: stretch; margin: 14px 0; }
.pidialog .piarrow > i { align-self: center; font-style: normal; color: var(--t3); font-size: 20px; }
.pidialog .pionly { color: var(--t2); font-size: var(--fs-body); }
.pitoast { position: fixed; right: 24px; bottom: 24px; display: flex; gap: 14px; align-items: center; max-width: calc(100% - 32px); box-sizing: border-box; background: var(--t1); color: var(--bg); border-radius: 10px; padding: 10px 16px; box-shadow: 0 8px 30px rgba(0, 0, 0, .4); z-index: 60; }
.pitoast[hidden] { display: none; }
.pitoast > span { min-width: 0; }
.pitoast button { flex: none; white-space: nowrap; border: 0; background: none; color: inherit; font: inherit; font-weight: 600; text-decoration: underline; cursor: pointer; padding: 0; }
.pitoast button[hidden] { display: none; }
@media (max-width: 719px) {
  .pi .pigrid { grid-template-columns: minmax(0, 1fr); }
  .pitoast { left: 16px; right: 16px; bottom: 16px; }
}
`;

export function renderDashboardPrivacyItemsPage(options?: DashboardPageOptions): string {
  const basePath = options?.basePath;
  const token = readToken(basePath);
  return pageShell({
    title: 'Olympus',
    crumb: W.crumb,
    ...(basePath === undefined ? {} : { basePath }),
    nav: dashboardTopNav({ active: 'privacy', unlocked: options?.controlSessionCsrfToken !== undefined, lockable: false, ...(token ? { token } : {}) }),
    meta: '',
    body: dashboardPrivacyTabs('items', token) + renderBody(options, token),
    styles: [LOCAL_PAGE_CSS, TOP_NAV_CSS, PRIVACY_TABS_CSS, SOURCE_LOGO_CSS, PRIVACY_ITEMS_CSS, JUDGE_CHECK_CSS],
  });
}

function readToken(basePath: string | undefined): string | undefined {
  if (!basePath) return undefined;
  const query = basePath.indexOf('?');
  if (query < 0) return undefined;
  return new URLSearchParams(basePath.slice(query + 1)).get('token') ?? undefined;
}

function renderBody(options: DashboardPageOptions | undefined, token: string | undefined): string {
  const csrfToken = options?.controlSessionCsrfToken;
  const head = `<h3 class="sect">${escapeHtml(C.title)}</h3><p class="pnote">${escapeHtml(C.intro)}</p>`;
  if (csrfToken === undefined) {
    const gate = `${dashboardLocalPageHref('keys', token)}#${DASHBOARD_CONTROL_GATE_ID}`;
    return `<div class="pi">${head}<p class="pnote" data-pi-locked>${escapeHtml(C.locked)} <a href="${escapeHtml(gate)}">${escapeHtml(C.openControls)}</a></p></div>`;
  }
  if (options?.outsideHelpLocalSession !== true) {
    // A session opened by an agent or the launch link reads nothing here.
    return `<div class="pi" data-privacy-items>${head}<form class="paunlock" data-pi-unlock>`
      + `<button type="submit" class="btn primary">${escapeHtml(C.unlock)}</button><span class="hint">${escapeHtml(C.unlockIntro)}</span>`
      + `<span class="pimsg" data-pi-msg role="status"></span></form></div>`
      + `<script>${privacyItemsClientScript({ csrfToken: '', unlockOnly: true })}</script>`;
  }
  // The optional check of how Olympus labelled items (judge-check.ts) sits at the top of this tab:
  // its answers set items in the list below. Local session only, like the list.
  return `<div class="pi" data-privacy-items>${JUDGE_CHECK_MOUNT}<div class="pigrid" id="${PRIVACY_ITEMS_LIST_ID}"><div class="pimain">${head}`
    + `<label class="pifind"><span aria-hidden="true">⌕</span><input type="search" data-pi-search maxlength="200" autocomplete="off" aria-label="${escapeHtml(C.searchLabel)}" placeholder="${escapeHtml(C.searchPlaceholder)}"></label>`
    + `<div class="pichips" data-pi-filters role="group" aria-label="${escapeHtml(C.filtersLabel)}">`
    + `<button type="button" class="pichip" data-pi-filter="" aria-pressed="true">${escapeHtml(C.recentHeading)}</button>`
    + `<button type="button" class="pichip" data-pi-filter="private" aria-pressed="false">Private<i data-pi-count="private"></i></button>`
    + `<button type="button" class="pichip" data-pi-filter="personal" aria-pressed="false">Personal<i data-pi-count="personal"></i></button>`
    + `<button type="button" class="pichip" data-pi-filter="changed" aria-pressed="false">${escapeHtml(C.changedByYou)}<i data-pi-count="changed"></i></button></div>`
    + `<p class="picap" data-pi-heading hidden>${escapeHtml(C.resultsHeading)}</p>`
    + `<p class="pimsg" data-pi-msg role="status">${escapeHtml(C.loading)}</p>`
    + `<ul class="pilist" data-pi-list></ul>`
    + `<p class="pnote piapps" data-pi-apps>${escapeHtml(C.apps)}</p></div>`
    + `<div class="piside" data-pi-side></div></div>`
    + `<dialog class="judgedialog pidialog" data-pi-confirm aria-labelledby="pi-confirm-title"><div class="pidbody">`
    + `<div class="pidtop"><h3 id="pi-confirm-title">${escapeHtml(C.confirmTitle)}</h3><button type="button" class="pix" data-pi-confirm-close aria-label="${escapeHtml(C.close)}">✕</button></div>`
    + `<div class="piitem" data-pi-confirm-item></div>`
    + `<div class="piarrow"><div class="piopt"><b><span class="pipill Private">Private</span> ${escapeHtml(C.now)}</b><span>${escapeHtml(C.privateLine)}</span></div><i aria-hidden="true">→</i>`
    + `<div class="piopt on"><b><span class="pipill Personal">Personal</span> ${escapeHtml(C.after)}</b><span>${escapeHtml(C.afterPersonalLine)}</span></div></div>`
    + `<p class="pionly">${escapeHtml(C.confirmOnly)}</p>`
    + `<div class="judgedialogbar"><button type="button" class="btn" data-pi-confirm-cancel>${escapeHtml(C.cancel)}</button><button type="button" class="btn primary" data-pi-confirm-ok>${escapeHtml(C.makePersonal)}</button></div>`
    + `</div></dialog>`
    + `<div class="pitoast" data-pi-toast role="status" hidden><span data-pi-toast-text></span><button type="button" data-pi-toast-undo>${escapeHtml(C.undo)}</button></div>`
    + `</div><script>${privacyItemsClientScript({ csrfToken, unlockOnly: false })}</script>`
    + `<script>${judgeCheckClientScript({ csrfToken, itemsHref: `#${PRIVACY_ITEMS_LIST_ID}` })}</script>`;
}

/**
 * The page's controller. `window.setTimeout` and `window.matchMedia` are its
 * only clocks and layout probes, so a test can drive both.
 */
export function privacyItemsClientScript(input: { csrfToken: string; unlockOnly: boolean }): string {
  const config = {
    csrfToken: input.csrfToken,
    unlockOnly: input.unlockOnly,
    unlockPath: DASHBOARD_OUTSIDE_HELP_PATHS.unlock,
    paths: DASHBOARD_PRIVACY_ITEMS_PATHS,
    toastMs: PRIVACY_ITEMS_TOAST_MS,
    debounceMs: PRIVACY_ITEMS_SEARCH_DEBOUNCE_MS,
    logos: input.unlockOnly ? {} : sourceLogoTilesByProvider(),
    reasons: JUDGE_REASON_PHRASES,
    unreadableReasons: DASHBOARD_UNREADABLE_FILE_REASON_WORDS,
    copy: C,
  };
  return `(function () {
  var config = ${escapeScriptJson(JSON.stringify(config))};
  var C = config.copy;
  var root = document.querySelector('[data-privacy-items]');
  if (!root) return;
  function fill(template, values) { return String(template).replace(/\\{(\\w+)\\}/g, function (m, key) { return values[key] === undefined ? m : values[key]; }); }
  function esc(value) { return String(value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var unlock = root.querySelector('form[data-pi-unlock]');
  if (unlock) {
    unlock.addEventListener('submit', function (event) {
      event.preventDefault();
      var button = unlock.querySelector('button');
      if (button) button.disabled = true;
      fetch(config.unlockPath, { method: 'POST', credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
        if (response.ok) { window.location.reload(); return; }
        var msg = unlock.querySelector('[data-pi-msg]');
        if (msg) { msg.textContent = C.failed; msg.setAttribute('data-state', 'error'); }
        if (button) button.disabled = false;
      }, function () {
        var msg = unlock.querySelector('[data-pi-msg]');
        if (msg) { msg.textContent = C.unreachable; msg.setAttribute('data-state', 'error'); }
        if (button) button.disabled = false;
      });
    });
  }
  if (config.unlockOnly) return;

  var list = root.querySelector('[data-pi-list]');
  var side = root.querySelector('[data-pi-side]');
  var msg = root.querySelector('[data-pi-msg]');
  var heading = root.querySelector('[data-pi-heading]');
  var search = root.querySelector('[data-pi-search]');
  var dialog = root.querySelector('[data-pi-confirm]');
  var toast = root.querySelector('[data-pi-toast]');
  var items = [];
  var selected = null;
  var query = '';
  var filter = '';
  var counts = null;
  var seq = 0;
  var debounce = null;
  var toastTimer = null;
  var toastUndo = null;
  var pendingLower = null;
  // This visit's changes, by item: what the owner chose and what the judge had said.
  var changes = {};
  var statusFor = {};
  // Items with a change being saved: their choices wait, so a second click is never lost.
  var saving = {};

  async function post(path, body) {
    var response;
    try {
      response = await fetch(path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-Olympus-CSRF': config.csrfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return { ok: false, message: C.unreachable };
    }
    var result = {};
    try { result = (await response.json()) || {}; } catch (error) { result = {}; }
    if (response.ok && result.ok === true) return { ok: true, result: result };
    var message = (result.error && result.error.message) || result.message || C.failed;
    return { ok: false, message: message };
  }

  function narrow() { return !!(window.matchMedia && window.matchMedia('(max-width: 719px)').matches); }
  function find(id) { for (var i = 0; i < items.length; i += 1) if (items[i].item_id === id) return items[i]; return null; }
  // The owner's latest choice wins over the recorded label while it waits for the next pass.
  function shown(item) { var change = changes[item.item_id]; return change ? change.chosen : (item.owner_choice || item.tier); }
  function changedByYou(item) { return !!changes[item.item_id] || item.owner_set === true; }
  function logo(item, small) {
    var tile = config.logos[item.source];
    if (!tile) tile = '<span class="logotile letter" aria-hidden="true"><span class="logoletter" style="background:#5b5bd6">' + esc((item.source || '?').charAt(0).toUpperCase()) + '</span></span>';
    return small ? tile.replace('class="logotile', 'class="logotile sm') : tile;
  }
  function pill(tier) { return tier ? '<span class="pipill ' + esc(tier) + '">' + esc(tier) + '</span>' : '<span class="pipill">' + esc(C.notSorted) + '</span>'; }
  function title(item) { return item.title || (item.location ? String(item.location).split('/').pop() : '') || C.untitled; }
  function meta(item) {
    var parts = [];
    var where = item.sender || (item.location && String(item.location).indexOf('/') >= 0 ? String(item.location).split('/').slice(0, -1).join('/') : '');
    if (where) parts.push(where);
    if (item.decided_at) {
      var at = new Date(item.decided_at);
      if (!isNaN(at.getTime())) parts.push(at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
    }
    return parts.join(' · ');
  }
  function lower(text) { return text ? text.charAt(0).toLowerCase() + text.slice(1) : text; }
  function reason(item) {
    var code = item.judge_reason;
    if (!code) return undefined;
    var bare = code.indexOf('record_held:') === 0 ? code.slice('record_held:'.length) : code;
    var category = bare.split(':')[0];
    return Object.prototype.hasOwnProperty.call(config.reasons, category) ? config.reasons[category] : undefined;
  }

  function row(item) {
    var open = selected === item.item_id;
    var tier = shown(item);
    var note = changedByYou(item) ? '<span class="piyou">' + esc(C.changedByYou) + '</span>'
      : item.moving_to ? '<span class="piyou">' + esc(fill(C.moving, { tier: item.moving_to })) + '</span>' : '';
    return '<li><button type="button" class="pirow" data-pi-item="' + esc(item.item_id) + '" aria-expanded="' + (open ? 'true' : 'false') + '">'
      + logo(item) + '<span class="grow"><span class="pititle">' + esc(title(item)) + '</span><span class="pimeta">' + esc(meta(item)) + '</span></span>'
      + '<span class="piend">' + pill(tier) + note + '</span></button></li>';
  }

  function option(item, tier, line) {
    var on = shown(item) === tier;
    return '<button type="button" class="piopt" role="radio" data-pi-choose="' + tier + '" aria-checked="' + (on ? 'true' : 'false') + '"' + (on ? ' tabindex="-1"' : '') + (saving[item.item_id] ? ' disabled' : '') + '>'
      + '<b><i class="piradio" aria-hidden="true"></i>' + esc(tier) + '</b><span>' + esc(line) + '</span></button>';
  }

  function detail(item) {
    var tier = shown(item);
    var change = changes[item.item_id];
    var preview = item.preview ? '<div class="piprev" data-pi-preview>' + esc(item.preview) + '</div>' : '<div class="piprev" data-pi-preview>' + esc(C.noPreview) + '</div>';
    var why = '';
    var foot = '';
    if (changedByYou(item)) {
      var said = change && change.judge ? ' ' + esc(fill(C.judgeSaid, { tier: change.judge })) : '';
      why = '<div class="piundo" data-pi-undo-row><p class="piwhy"><b>' + esc(fill(C.youChose, { tier: tier || '' })) + '</b>' + (change ? ' ' + esc(C.justNow) + '.' : '.') + said + '</p>'
        + '<button type="button" class="btn" data-pi-undo>' + esc(C.undo) + '</button></div>';
      var effect = change && change.applies === 'next_pass' ? C.afterNextPass : tier === 'Personal' ? C.afterPersonal : C.afterPrivate;
      foot = esc(effect) + ' ' + esc(C.undoGivesBack);
    } else {
      var phrase = reason(item);
      // A hold for unread text, or a label from the names alone, is not a verdict on what the item says (#1295).
      var said = item.waiting_for_judge ? esc(fill(C.waitingToRead, { tier: tier }))
        : item.names_only ? esc(C.namesOnly)
          : item.not_read && item.not_read.kind === 'by_choice' ? esc(C.notReadByChoice)
          : item.not_read && item.not_read.kind === 'cannot_read' ? esc(fill(C.cannotRead, { reason: config.unreadableReasons[item.not_read.reason] || config.unreadableReasons.other }))
          : phrase ? '<b>' + esc(fill(C.judgeChose, { tier: tier })) + '</b> ' + esc(phrase) : esc(fill(C.judgeMarked, { tier: tier }));
      if (tier) why = '<p class="piwhy" data-pi-why>' + said + '</p>';
      var group = item.sender ? fill(C.promiseGroup, { sender: item.sender }) : C.promiseGroupNoSender;
      foot = esc(fill(C.promise, { group: group }));
    }
    return '<section class="pidetail" data-pi-detail="' + esc(item.item_id) + '" aria-label="' + esc(title(item)) + '">'
      + '<div class="pidhead">' + logo(item, true) + '<div class="grow"><h4>' + esc(title(item)) + '</h4><span class="pimeta">' + esc(meta(item)) + '</span></div>'
      + '<button type="button" class="pix" data-pi-close aria-label="' + esc(C.close) + '">✕</button></div>'
      + '<p class="pidcap">' + esc(C.previewCaption) + '</p>' + preview
      + (item.family === 'file' && (item.names_only || item.not_read && item.not_read.kind === 'by_choice') ? '<button type="button" class="btn" data-pi-read>Read this file</button>' : '')
      + '<p class="pidcap" id="pi-who">' + esc(C.whoCaption) + '</p>'
      + '<div class="pipair" role="radiogroup" aria-labelledby="pi-who">' + option(item, 'Personal', C.personalLine) + option(item, 'Private', C.privateLine) + '</div>'
      + why
      + '<p class="pistatus" data-pi-status role="status">' + esc(statusFor[item.item_id] || '') + '</p>'
      + '<p class="pifoot" data-pi-foot>' + foot + '</p></section>';
  }

  function render() {
    var item = selected ? find(selected) : null;
    if (!item) selected = null;
    var html = '';
    for (var i = 0; i < items.length; i += 1) {
      html += row(items[i]);
      if (item && items[i] === item && narrow()) html += '<li>' + detail(item) + '</li>';
    }
    list.innerHTML = html;
    side.innerHTML = item && !narrow() ? detail(item) : '';
  }

  function setMessage(text, error) {
    msg.textContent = text || '';
    if (error) msg.setAttribute('data-state', 'error'); else msg.removeAttribute('data-state');
  }

  function renderFilters() {
    var chips = root.querySelectorAll('[data-pi-filter]');
    for (var i = 0; i < chips.length; i += 1) chips[i].setAttribute('aria-pressed', !query && chips[i].getAttribute('data-pi-filter') === filter ? 'true' : 'false');
    var shown = root.querySelectorAll('[data-pi-count]');
    for (var j = 0; j < shown.length; j += 1) {
      var value = counts ? counts[shown[j].getAttribute('data-pi-count')] : undefined;
      shown[j].textContent = typeof value === 'number' ? value.toLocaleString('en-GB') : '';
    }
    if (query) heading.removeAttribute('hidden'); else heading.setAttribute('hidden', '');
  }

  async function load() {
    var mine = ++seq;
    var words = query;
    renderFilters();
    var body = words ? { query: words } : { recent: true };
    if (!words && filter) body.filter = filter;
    var response = await post(config.paths.find, body);
    if (mine !== seq) return;
    if (!response.ok) { setMessage(response.message, true); return; }
    items = Array.isArray(response.result.items) ? response.result.items : [];
    if (response.result.counts) counts = response.result.counts;
    renderFilters();
    setMessage(items.length ? '' : words ? C.noMatch : C.empty, false);
    render();
  }

  function showToast(text, undoItem) {
    toast.querySelector('[data-pi-toast-text]').textContent = text;
    var undoButton = toast.querySelector('[data-pi-toast-undo]');
    toastUndo = undoItem || null;
    if (undoItem) undoButton.removeAttribute('hidden'); else undoButton.setAttribute('hidden', '');
    toast.removeAttribute('hidden');
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { toast.setAttribute('hidden', ''); toastTimer = null; toastUndo = null; }, config.toastMs);
  }

  function merge(updated, before) {
    if (!updated) return;
    if (before && before.preview !== undefined && updated.preview === undefined) updated.preview = before.preview;
    for (var i = 0; i < items.length; i += 1) if (items[i].item_id === updated.item_id) items[i] = updated;
  }

  async function choose(id, tier) {
    var item = find(id);
    if (!item || saving[id]) return;
    delete statusFor[id];
    saving[id] = true;
    render();
    var response;
    try {
      response = await post(config.paths.set, { item_id: id, tier: tier === 'Personal' ? 'personal' : 'private' });
    } finally {
      delete saving[id];
    }
    if (!response.ok || response.result.ok === false) { statusFor[id] = response.message; render(); return; }
    var previous = changes[id];
    if (counts && !previous && !item.owner_set) { counts.changed += 1; renderFilters(); }
    // What the judge had said: the label before this visit's first change, if nobody had set it before.
    var judge = previous ? previous.judge : item.owner_set ? undefined : item.tier;
    changes[id] = { chosen: tier, judge: judge, applies: response.result.applies };
    merge(response.result.item, item);
    render();
    showToast(tier === 'Personal' ? C.toastPersonal : C.toastPrivate, id);
  }

  // Undo acts on the item id it was given, whether or not the item is still
  // in the list on screen (a search or a filter may have moved it out).
  async function undo(id) {
    if (saving[id]) return;
    var item = find(id);
    delete statusFor[id];
    saving[id] = true;
    if (item) render();
    var response;
    try {
      response = await post(config.paths.set, { item_id: id, tier: 'judge' });
    } finally {
      delete saving[id];
    }
    if (!response.ok || response.result.ok === false) {
      if (item) statusFor[id] = response.message; else setMessage(response.message, true);
      render();
      return;
    }
    delete changes[id];
    if (counts && counts.changed > 0) { counts.changed -= 1; renderFilters(); }
    if (item) merge(response.result.item, item);
    // Listed under Changed by you, it is no longer changed by you.
    if (!query && filter === 'changed') items = items.filter(function (listed) { return listed.item_id !== id; });
    render();
    showToast(C.toastJudge, null);
  }

  function openConfirm(id) {
    var item = find(id);
    if (!item) return;
    pendingLower = id;
    dialog.querySelector('[data-pi-confirm-item]').innerHTML = logo(item, true) + '<span class="grow"><span class="pititle">' + esc(title(item)) + '</span><span class="pimeta">' + esc(meta(item)) + '</span></span>';
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function closeConfirm() {
    pendingLower = null;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close(); else dialog.removeAttribute('open');
  }

  root.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    var rowButton = target.closest('[data-pi-item]');
    if (rowButton) {
      var id = rowButton.getAttribute('data-pi-item');
      selected = selected === id ? null : id;
      render();
      return;
    }
    if (target.closest('[data-pi-read]') && selected) {
      var button = target.closest('[data-pi-read]');
      button.disabled = true;
      post(config.paths.read, { item_id: selected }).then(function (result) {
        button.textContent = result.ok && (result.result.state === 'reading' || result.result.state === 'queued') ? 'Reading. Ask again in about a minute.' : 'Could not start reading this file.';
      }).catch(function () { button.disabled = false; button.textContent = 'Try reading again'; });
      return;
    }
    if (target.closest('[data-pi-close]')) { selected = null; render(); return; }
    var chip = target.closest('[data-pi-filter]');
    if (chip) {
      filter = chip.getAttribute('data-pi-filter') || '';
      query = '';
      search.value = '';
      selected = null;
      load();
      return;
    }
    var pick = target.closest('[data-pi-choose]');
    if (pick && selected) {
      if (saving[selected]) return;
      var item = find(selected);
      var tier = pick.getAttribute('data-pi-choose');
      if (!item || shown(item) === tier) return;
      // Lowering always asks first; raising only adds protection.
      if (tier === 'Personal') openConfirm(selected); else choose(selected, tier);
      return;
    }
    if (target.closest('[data-pi-undo]') && selected) { undo(selected); return; }
  });
  dialog.addEventListener('click', function (event) {
    // A click on the backdrop lands on the dialog itself, outside its body.
    if (event.target === dialog) { closeConfirm(); return; }
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    if (target.closest('[data-pi-confirm-close]') || target.closest('[data-pi-confirm-cancel]')) { closeConfirm(); return; }
    if (target.closest('[data-pi-confirm-ok]')) {
      var id = pendingLower;
      closeConfirm();
      if (id) choose(id, 'Personal');
    }
  });
  // Esc: the browser closes the dialog and sends cancel.
  dialog.addEventListener('cancel', function () { pendingLower = null; });
  dialog.addEventListener('close', function () { pendingLower = null; });
  toast.querySelector('[data-pi-toast-undo]').addEventListener('click', function () {
    var id = toastUndo;
    toast.setAttribute('hidden', '');
    if (toastTimer !== null) { window.clearTimeout(toastTimer); toastTimer = null; }
    toastUndo = null;
    if (id) undo(id);
  });
  search.addEventListener('input', function () {
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(function () { debounce = null; query = String(search.value || '').trim(); selected = null; load(); }, config.debounceMs);
  });
  if (window.matchMedia) {
    var media = window.matchMedia('(max-width: 719px)');
    if (media && media.addEventListener) media.addEventListener('change', render);
  }
  // The label check above set an item: reload so its label, mark and Undo match.
  root.addEventListener(${JSON.stringify(JUDGE_CHECK_ITEMS_CHANGED_EVENT)}, function (event) {
    // The check set this item after any change made here, so the stored label wins.
    if (event && event.itemId) delete changes[event.itemId];
    load();
  });
  load();
})();`;
}
