/**
 * Privacy › What AI apps received (#1061; signed-off mockup
 * 3-shared-with-apps): one row per request an AI app or agent made, opened to
 * the items shared, each with "This should be Private".
 *
 * The page itself carries no request, question or title: its script reads the
 * list through POST /dashboard/apps-received, which only a locally minted
 * control session reaches (workers/http.ts). A locked reader or a bearer-grade
 * session gets the page's frame and the way to unlock, nothing else.
 */
import { DASHBOARD_CONTROL_GATE_ID, escapeHtml, escapeScriptJson, pageShell } from '../components.ts';
import { dashboardLocalPageHref } from '../host-page.ts';
import { DASHBOARD_OUTSIDE_HELP_PATHS } from '../outside-help.ts';
import { LOCAL_PAGE_CSS } from '../static-styles.ts';
import { dashboardTopNav, TOP_NAV_CSS } from '../top-nav.ts';
import { DASHBOARD_APPS_RECEIVED_COPY as A, DASHBOARD_PRIVATE_ANSWERS_COPY as W } from '../vocabulary.ts';
import type { DashboardPageOptions } from './local.ts';
import { dashboardPrivacyTabs, PRIVACY_TABS_CSS } from './private-answers.ts';

const POST_PATH = '/dashboard/apps-received';

const APPS_RECEIVED_CSS = `
.ar { width: 100%; min-width: 0; max-width: min(920px, 100%); }
.ar .arhead { margin: 0 0 8px; }
.ar .arintro { margin: 0 0 16px; color: var(--t2); overflow-wrap: anywhere; }
.ar .arbar { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; padding: 0 0 12px; border-bottom: 1px solid var(--line); color: var(--t2); }
.ar .arkept { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ar .arkept select { font: inherit; color: var(--t1); background: var(--bg); border: 1px solid var(--field, var(--line)); border-radius: 6px; padding: 2px 6px; }
.ar .arclear { padding: 0; border: 0; background: none; color: var(--t2); font: inherit; text-decoration: underline; cursor: pointer; }
.ar .arclear:hover, .ar .arclear:focus-visible { color: var(--link); }
.ar .arclear[hidden] { display: none; }
.ar ul.arlist { list-style: none; margin: 0; padding: 0; }
.ar .arrow { border-bottom: 1px solid var(--line); }
.ar .arrow > details > summary { list-style: none; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; padding: 16px 0; cursor: pointer; }
.ar .arrow > details > summary::-webkit-details-marker { display: none; }
.ar .arrow > details > summary::after { content: "\\25B8"; color: var(--t2); font-size: .8em; grid-column: 2; grid-row: 1; align-self: center; }
.ar .arrow > details[open] > summary::after { content: "\\25BE"; }
.ar .arrow > details > summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.ar .artitle { grid-column: 1; min-width: 0; overflow-wrap: anywhere; }
.ar .arq { color: var(--t1); font-weight: 600; }
.ar .arfrom { color: var(--t3); }
.ar .arcount { grid-column: 1 / -1; color: var(--t2); }
.ar .aritems { margin: 0 0 20px; padding: 4px 0 4px 20px; border-left: 3px solid var(--line); display: grid; gap: 12px; }
.ar .aritem { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; align-items: center; }
.ar .arname { min-width: 0; color: var(--t1); overflow-wrap: anywhere; }
.ar .arname b { font-weight: 600; }
.ar .artier { color: var(--t3); }
.ar .armake { white-space: nowrap; border-color: var(--link); color: var(--link); border-radius: 8px; }
.ar .armake:disabled { border-color: var(--line); color: var(--t3); cursor: default; }
.ar .arnote { margin: 0; color: var(--t2); overflow-wrap: anywhere; }
.ar .armsg { color: var(--t2); margin: 8px 0 0; }
.ar .armsg[data-state="error"] { color: var(--bad); }
.ar .armsg:empty { display: none; }
.ar .arunlock { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin: 0 0 16px; padding: 10px 14px; background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; }
@media (max-width: 560px) {
  .ar .aritem { grid-template-columns: minmax(0, 1fr); }
  .ar .armake { justify-self: start; }
}
`;

export function renderDashboardAppsReceivedPage(options?: DashboardPageOptions): string {
  const basePath = options?.basePath;
  const token = readToken(basePath);
  return pageShell({
    title: 'Olympus',
    crumb: W.crumb,
    ...(basePath === undefined ? {} : { basePath }),
    nav: dashboardTopNav({ active: 'privacy', unlocked: options?.controlSessionCsrfToken !== undefined, lockable: false, ...(token ? { token } : {}) }),
    meta: '',
    body: dashboardPrivacyTabs('apps', token) + renderBody(options),
    styles: [LOCAL_PAGE_CSS, TOP_NAV_CSS, PRIVACY_TABS_CSS, APPS_RECEIVED_CSS],
  });
}

function readToken(basePath: string | undefined): string | undefined {
  if (!basePath) return undefined;
  const query = basePath.indexOf('?');
  if (query < 0) return undefined;
  return new URLSearchParams(basePath.slice(query + 1)).get('token') ?? undefined;
}

function renderBody(options: DashboardPageOptions | undefined): string {
  const csrfToken = options?.controlSessionCsrfToken;
  const local = csrfToken !== undefined && options?.outsideHelpLocalSession === true;
  const head = `<h3 class="sect arhead">${escapeHtml(A.title)}</h3><p class="pnote arintro">${escapeHtml(A.intro)}</p>`;
  if (csrfToken === undefined) {
    const gate = `${dashboardLocalPageHref('keys', readToken(options?.basePath))}#${DASHBOARD_CONTROL_GATE_ID}`;
    return `<div class="privacy ar" data-apps-received>${head}<p class="pnote" data-ar-locked>${escapeHtml(A.locked)} <a href="${escapeHtml(gate)}">${escapeHtml(A.openControls)}</a></p></div>`;
  }
  if (!local) {
    // A bearer-grade session (the launch flow, a remote page) reads nothing here: the local unlock comes first.
    return `<div class="privacy ar" data-apps-received>${head}<form class="arunlock" data-ar-unlock>`
      + `<button type="submit" class="btn primary">${escapeHtml(A.unlock)}</button><span class="hint">${escapeHtml(A.unlockIntro)}</span>`
      + `<span class="armsg" data-ar-msg role="status"></span></form></div>`
      + `<script>${clientScript(csrfToken, true)}</script>`;
  }
  if (options?.appsReceivedAvailable !== true) {
    return `<div class="privacy ar" data-apps-received>${head}<p class="pnote" data-ar-unavailable>${escapeHtml(A.unavailable)}</p></div>`;
  }
  const choices = [7, 30, 90, 0].map((days) => `<option value="${days}"${days === 30 ? ' selected' : ''}>${escapeHtml(A.retention[String(days)]!)}</option>`).join('');
  return `<div class="privacy ar" data-apps-received>${head}`
    + `<div class="arbar"><span class="arkept"><label for="ar-retention">${escapeHtml(A.keptFor)}</label>`
    + `<select id="ar-retention" data-ar-retention aria-label="${escapeHtml(A.keptLabel)}" disabled>${choices}</select>`
    + `<span>· ${escapeHtml(A.includedInDeleteAll)}</span></span>`
    + `<button type="button" class="arclear" data-ar-clear hidden>${escapeHtml(A.clear)}</button></div>`
    + `<p class="pnote" data-ar-none hidden></p>`
    + `<ul class="arlist" data-ar-list aria-live="polite"></ul>`
    + `<p class="armsg" data-ar-msg role="status"></p></div>`
    + `<script>${clientScript(csrfToken, false)}</script>`;
}

function clientScript(csrfToken: string, unlockOnly: boolean): string {
  const config = { csrfToken, path: POST_PATH, unlockPath: DASHBOARD_OUTSIDE_HELP_PATHS.unlock, unlockOnly, copy: A };
  return `(function () {
  var config = ${escapeScriptJson(JSON.stringify(config))};
  var copy = config.copy;
  var root = document.querySelector('[data-apps-received]');
  if (!root) return;
  var msg = root.querySelector('[data-ar-msg]');
  function say(text, bad) { if (!msg) return; msg.textContent = text || ''; if (bad) msg.setAttribute('data-state', 'error'); else msg.removeAttribute('data-state'); }
  var unlock = root.querySelector('form[data-ar-unlock]');
  if (unlock) unlock.addEventListener('submit', function (event) {
    event.preventDefault();
    var button = unlock.querySelector('button');
    if (button) button.disabled = true;
    fetch(config.unlockPath, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Olympus-CSRF': config.csrfToken } }).then(function (response) {
      if (response.ok) { window.location.reload(); return; }
      say(copy.failed, true); if (button) button.disabled = false;
    }, function () { say(copy.unreachable, true); if (button) button.disabled = false; });
  });
  if (config.unlockOnly) return;
  async function send(body) {
    var response;
    try {
      response = await fetch(config.path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-Olympus-CSRF': config.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (error) { return { ok: false, message: copy.unreachable }; }
    var result = {};
    try { result = await response.json(); } catch (error) { result = {}; }
    var ok = response.ok && result && result.ok === true;
    return { ok: ok, result: result || {}, message: ok ? '' : (result && result.error && result.error.message) || copy.failed };
  }
  function el(tag, cls, text) { var node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
  function plural(forms, n) { return (n === 1 ? forms.one : forms.other).replace('{n}', String(n)); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function when(ms) {
    var date = new Date(ms); var now = new Date();
    var day = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    var diff = Math.round((day(now) - day(date)) / 86400000);
    if (diff <= 0) return pad(date.getHours()) + ':' + pad(date.getMinutes());
    if (diff === 1) return copy.yesterday;
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function appName(request) { return request.connection.kind === 'agent' ? request.connection.name + ' ' + copy.agentSuffix : request.connection.name; }
  function counts(request) {
    var personal = request.items.filter(function (item) { return item.tier !== 'private'; }).length;
    var privateShared = request.items.length - personal;
    var parts = [plural(copy.shared, personal)];
    if (privateShared > 0) parts.push(plural(copy.sharedPrivate, privateShared));
    if (request.heldBack > 0) parts.push(copy.heldBack.replace('{n}', String(request.heldBack)));
    if (request.withheld) parts.push(copy.withheld);
    else if (request.items.length === 0 && request.heldBack === 0) parts.push(copy.noItems);
    return parts.join(' · ');
  }
  var open = {};
  function row(request) {
    var li = el('li', 'arrow'); li.setAttribute('data-ar-request', request.id);
    var details = el('details'); if (open[request.id]) details.open = true;
    details.addEventListener('toggle', function () { open[request.id] = details.open; });
    var summary = el('summary');
    var title = el('span', 'artitle');
    title.appendChild(el('span', 'arq', request.question));
    title.appendChild(el('span', 'arfrom', ' · ' + appName(request) + ' · ' + when(request.at)));
    summary.appendChild(title);
    summary.appendChild(el('span', 'arcount', counts(request)));
    details.appendChild(summary);
    var box = el('div', 'aritems');
    request.items.forEach(function (item) {
      var line = el('div', 'aritem');
      var name = el('span', 'arname');
      name.appendChild(el('b', '', item.source));
      if (item.title) name.appendChild(document.createTextNode(' · ' + item.title));
      if (item.tier === 'private') name.appendChild(el('span', 'artier', ' · Private'));
      line.appendChild(name);
      if (item.tier !== 'private') {
        var button = el('button', 'btn armake', item.madePrivate ? copy.madePrivate : copy.makePrivate);
        button.type = 'button';
        button.setAttribute('data-ar-make-private', String(item.position));
        if (item.madePrivate) button.disabled = true;
        button.addEventListener('click', async function () {
          button.disabled = true; button.textContent = copy.makingPrivate;
          var outcome = await send({ action: 'make_private', request: request.id, item: item.position });
          if (outcome.ok) { button.textContent = copy.madePrivate; item.madePrivate = true; return; }
          button.disabled = false; button.textContent = copy.makePrivate; say(outcome.message, true);
        });
        line.appendChild(button);
      }
      box.appendChild(line);
    });
    if (request.heldBack > 0) {
      var note = plural(copy.heldBackLine, request.heldBack);
      if (request.answeredPrivately) note += ' ' + copy.answeredPrivately.replace('{app}', appName(request));
      box.appendChild(el('p', 'arnote', note));
    }
    if (box.childNodes.length === 0) box.appendChild(el('p', 'arnote', request.withheld ? copy.withheld : copy.noItems));
    details.appendChild(box);
    li.appendChild(details);
    return li;
  }
  var list = root.querySelector('[data-ar-list]');
  var none = root.querySelector('[data-ar-none]');
  var clear = root.querySelector('[data-ar-clear]');
  var retention = root.querySelector('[data-ar-retention]');
  function render(result) {
    if (retention) { retention.value = String(result.retentionDays); retention.disabled = false; }
    var requests = Array.isArray(result.requests) ? result.requests : [];
    list.textContent = '';
    requests.forEach(function (request) { list.appendChild(row(request)); });
    if (none) { none.hidden = requests.length > 0; none.textContent = result.retentionDays === 0 ? copy.notKept : copy.none; }
    if (clear) clear.hidden = requests.length === 0;
  }
  async function load() {
    if (document.hidden) return;
    var outcome = await send({ action: 'list' });
    if (!outcome.ok) { say(outcome.message, true); return; }
    render(outcome.result);
  }
  if (retention) retention.addEventListener('change', async function () {
    retention.disabled = true;
    var outcome = await send({ action: 'retention', days: Number(retention.value) });
    if (!outcome.ok) say(outcome.message, true); else say('');
    await load();
  });
  if (clear) clear.addEventListener('click', async function () {
    if (!window.confirm(copy.clearConfirm)) return;
    clear.disabled = true;
    var outcome = await send({ action: 'clear' });
    clear.disabled = false;
    if (!outcome.ok) { say(outcome.message, true); return; }
    open = {};
    await load();
  });
  load();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
})();`;
}
