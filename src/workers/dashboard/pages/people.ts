/**
 * People (#1076; owner-approved mockup 3-people.png, 2026-11-10): one person
 * across sources. Reached from the "People" row at the bottom of Sources.
 *
 * 1. "Same person?" asks about a name-only match, and only when both people
 *    have enough messages to be worth asking about. Not the same is kept.
 * 2. "You": every identity the sources mark as the owner.
 * 3. Find a person by name, email address, number or handle.
 * 4. One row per person with every identity and why they were linked.
 * 5. "⋯": Rename, Merge with…, Split; each choice holds across re-syncs.
 * 6. The privacy line.
 *
 * The list is Private and stays on this computer: it is rendered only for a
 * locally minted control session, and every change posts to /dashboard/people
 * with that session's CSRF token.
 */
import { escapeHtml, escapeScriptJson, pageShell } from '../components.ts';
import { dashboardLocalPageHref } from '../host-page.ts';
import { dashboardTopNav, TOP_NAV_CSS } from '../top-nav.ts';
import { LOCAL_PAGE_CSS } from '../static-styles.ts';
import type { DashboardPageOptions } from './local.ts';

export const DASHBOARD_PEOPLE_PATH = '/dashboard/people';

export interface DashboardPeopleIdentityChip {
  identityKey: string;
  provider: string;
  /** The source's name on the chip ("Gmail", "Telegram"). */
  source: string;
  /** The address, number, handle or name the chip shows. */
  detail: string;
}

export interface DashboardPeoplePerson {
  personId: string;
  displayName: string;
  isOwner: boolean;
  /** False when no source gave this person a name ("No name yet"). */
  named: boolean;
  messages: number;
  /** Why the identities were linked, in the screen's words. */
  linkedBy: string[];
  identities: DashboardPeopleIdentityChip[];
}

export interface DashboardPeopleSuggestion {
  identityA: string;
  identityB: string;
  a: { name: string; source: string; detail: string };
  b: { name: string; source: string; detail: string };
}

export interface DashboardPeopleView {
  total: number;
  sourceCount: number;
  suggestions: DashboardPeopleSuggestion[];
  people: DashboardPeoplePerson[];
}

export const PEOPLE_COPY = {
  crumb: 'People',
  title: 'People',
  breadcrumbSources: 'Sources tab',
  count: (people: number, sources: number) =>
    `${people.toLocaleString('en-US')} ${people === 1 ? 'person' : 'people'} from ${sources} ${sources === 1 ? 'source' : 'sources'}`,
  close: 'Close',
  samePerson: 'Same person?',
  toCheck: (n: number) => `${n} to check`,
  question: 'Is',
  on: 'on',
  sameAs: 'the same person as',
  in: 'in',
  onlyName: 'Only the name matches',
  notSame: 'Not the same',
  same: 'Same person',
  you: 'You',
  find: 'Find a person',
  noMatch: 'No one matches.',
  messages: (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'message' : 'messages'}`,
  noName: 'No name yet',
  onlyOneSource: 'One identity',
  more: 'More actions',
  rename: 'Rename',
  renamePrompt: 'New name',
  save: 'Save',
  cancel: 'Cancel',
  mergeWith: 'Merge with…',
  mergeChoose: 'Merge with',
  merge: 'Merge',
  split: (chip: string) => `Split off ${chip}`,
  privacy: 'Linking people never decides privacy. Every message is still judged on its own. The people list stays on this computer.',
  locked: 'People opens only in the dashboard on this computer, unlocked.',
  lockedLink: 'Go to Sources to unlock',
  unavailable: 'The people list is not ready yet. It builds after your sources sync.',
  empty: 'No people yet. They appear after a chat or email source syncs.',
  failed: 'That change did not save. Try again.',
  unreachable: 'Olympus did not answer. Try again in a moment.',
  saving: 'Saving…',
  row: 'People',
  rowLine: 'Who is who across your sources',
  rowOpen: 'Open',
} as const;

const C = PEOPLE_COPY;

/** The dot colour of a chip: the source's own colour where it has a well-known one. */
const SOURCE_DOTS: Readonly<Record<string, string>> = {
  gmail: '#EA4335',
  telegram: '#26A5E4',
  whatsapp: '#25D366',
  apple_messages: '#34C759',
};

const PEOPLE_CSS = `
.pp { width: 100%; max-width: min(760px, 100%); min-width: 0; }
.pp .ppsheet { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
.pp .pphead { display: flex; align-items: flex-start; gap: 12px; padding: 18px 22px 14px; border-bottom: 1px solid var(--line); }
.pp .pphead h2 { margin: 0; font-size: var(--fs-section); }
.pp .pphead .ppsub { margin: 2px 0 0; color: var(--t2); }
.pp .pphead .ppgrow { flex: 1; min-width: 0; }
.pp .ppclose { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 1px solid var(--line); border-radius: 50%; color: var(--t2); text-decoration: none; font-size: 1.1em; }
.pp .ppclose:hover { color: var(--t1); background: var(--panel2); }
.pp .ppbody { display: grid; gap: 12px; padding: 16px 22px 22px; }
.pp .ppcard { background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; min-width: 0; }
.pp .ppcard h3 { margin: 0 0 6px; font-size: var(--fs-row); }
.pp .ppcard h3 .hint { font-weight: 400; margin-left: 4px; font-size: var(--fs-body); }
.pp .ppask { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px 16px; align-items: center; }
.pp .ppask + .ppask { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.pp .ppask p { margin: 0; overflow-wrap: anywhere; }
.pp .ppask .hint { display: block; }
.pp .ppaskbtns { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.pp .ppaskbtns .btn { border-radius: 999px; padding: 8px 18px; }
.pp .ppname { margin: 0 0 6px; font-weight: 600; font-size: var(--fs-row); overflow-wrap: anywhere; }
.pp .ppchips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 6px; }
.pp .ppchip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 3px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--t2); font-size: var(--fs-body); }
.pp .ppchip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 22ch; }
.pp .ppdot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--t3); }
.pp .ppwhy { margin: 0; color: var(--t2); }
.pp .ppfind { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--field); border-radius: 8px; background: var(--bg); color: var(--t1); font: inherit; }
.pp .ppfind:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
.pp .pprow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: center; }
.pp .pprow[hidden] { display: none; }
.pp details.rowmenu > summary { border: 1px solid var(--line); border-radius: 50%; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; }
.pp .ppedit { display: grid; gap: 6px; padding: 6px; }
.pp .ppedit input, .pp .ppedit select { padding: 6px 8px; border: 1px solid var(--field); border-radius: 6px; background: var(--bg); color: var(--t1); font: inherit; min-width: 0; }
.pp .ppnote { margin: 4px 0 0; color: var(--t3); font-size: var(--fs-body); }
.pp .ppmsg { margin: 0; color: var(--t2); }
.pp .ppmsg[data-state="error"] { color: var(--bad); }
.pp .ppmsg:empty { display: none; }
.pp .ppempty { color: var(--t2); margin: 0; }
@media (max-width: 560px) {
  .pp .ppask { grid-template-columns: minmax(0, 1fr); }
  .pp .ppaskbtns { justify-content: flex-start; }
  .pp .pphead, .pp .ppbody { padding-left: 14px; padding-right: 14px; }
}
`;

export function renderDashboardPeoplePage(options?: DashboardPageOptions & { people?: DashboardPeopleView; peopleLocalSession?: boolean }): string {
  const basePath = options?.basePath;
  const token = readToken(basePath);
  const csrf = options?.controlSessionCsrfToken;
  const sourcesHref = dashboardLocalPageHref('connect', token);
  const view = csrf !== undefined && options?.peopleLocalSession === true ? options.people : undefined;
  const sub = view
    ? `${escapeHtml(C.breadcrumbSources)} › ${escapeHtml(C.title)} · ${escapeHtml(C.count(view.total, view.sourceCount))}`
    : `${escapeHtml(C.breadcrumbSources)} › ${escapeHtml(C.title)}`;
  const head = `<div class="pphead"><div class="ppgrow"><h2>${escapeHtml(C.title)}</h2><p class="ppsub">${sub}</p></div>`
    + `<a class="ppclose" href="${escapeHtml(sourcesHref)}" aria-label="${escapeHtml(C.close)}">✕</a></div>`;
  let inner: string;
  if (csrf === undefined || options?.peopleLocalSession !== true) {
    inner = `<p class="ppempty">${escapeHtml(C.locked)} <a href="${escapeHtml(sourcesHref)}">${escapeHtml(C.lockedLink)}</a></p>`;
  } else if (!view) {
    inner = `<p class="ppempty">${escapeHtml(C.unavailable)}</p>`;
  } else {
    inner = peopleBody(view);
  }
  const body = `<section class="pp" data-people>${`<div class="ppsheet">${head}<div class="ppbody">${inner}`
    + `<p class="ppmsg" data-pp-msg role="status"></p>`
    + `<p class="ppnote">${escapeHtml(C.privacy)}</p></div></div>`}</section>`;
  return pageShell({
    title: 'Olympus',
    crumb: C.crumb,
    ...(basePath === undefined ? {} : { basePath }),
    nav: dashboardTopNav({ active: 'sources', unlocked: csrf !== undefined, lockable: false, ...(token ? { token } : {}) }),
    meta: '',
    body,
    styles: [LOCAL_PAGE_CSS, TOP_NAV_CSS, PEOPLE_CSS],
    ...(view && csrf !== undefined ? { scripts: [`<script>${peopleClientScript(csrf)}</script>`] } : {}),
  });
}

/** The row at the bottom of Sources that opens People. */
export function dashboardPeopleRow(token?: string): string {
  return `<div class="srow nodot" data-people-row><div class="smain"><b>${escapeHtml(C.row)}</b><p class="pnote">${escapeHtml(C.rowLine)}</p></div>`
    + `<div class="sact"><a class="btn" href="${escapeHtml(dashboardLocalPageHref('people', token))}">${escapeHtml(C.rowOpen)}</a></div></div>`;
}

function peopleBody(view: DashboardPeopleView): string {
  const parts: string[] = [];
  // 1. Same person? Only when the rules left a pair worth asking about.
  if (view.suggestions.length > 0) {
    const asks = view.suggestions.slice(0, 3).map((suggestion) =>
      `<div class="ppask" data-pp-ask>`
      + `<p>${escapeHtml(C.question)} <b>${escapeHtml(suggestion.a.name)}</b> ${escapeHtml(C.on)} ${escapeHtml(suggestion.a.source)} ${escapeHtml(C.sameAs)} <b>${escapeHtml(suggestion.b.name)}</b> (${escapeHtml(suggestion.b.detail)}) ${escapeHtml(C.in)} ${escapeHtml(suggestion.b.source)}?`
      + `<span class="hint">${escapeHtml(C.onlyName)}</span></p>`
      + `<div class="ppaskbtns">`
      + `<button class="btn" type="button" data-pp-op="not_same" data-identity-a="${escapeHtml(suggestion.identityA)}" data-identity-b="${escapeHtml(suggestion.identityB)}">${escapeHtml(C.notSame)}</button>`
      + `<button class="btn primary" type="button" data-pp-op="same" data-identity-a="${escapeHtml(suggestion.identityA)}" data-identity-b="${escapeHtml(suggestion.identityB)}">${escapeHtml(C.same)}</button>`
      + `</div></div>`).join('');
    parts.push(`<div class="ppcard" data-pp-suggestions><h3>${escapeHtml(C.samePerson)}<span class="hint">${escapeHtml(C.toCheck(view.suggestions.length))}</span></h3>${asks}</div>`);
  }
  // 2. You.
  const me = view.people.find((person) => person.isOwner);
  if (me) parts.push(`<div class="ppcard" data-pp-you><p class="ppname">${escapeHtml(C.you)}</p>${chips(me)}</div>`);
  const others = view.people.filter((person) => !person.isOwner);
  if (others.length === 0) {
    parts.push(`<p class="ppempty">${escapeHtml(C.empty)}</p>`);
    return parts.join('');
  }
  // 3. Find a person.
  parts.push(`<input class="ppfind" type="search" data-pp-find placeholder="${escapeHtml(C.find)}" aria-label="${escapeHtml(C.find)}">`);
  // 4. One row per person.
  const mergeOptions = others.map((person) =>
    `<option value="${escapeHtml(person.identities[0]?.identityKey ?? '')}">${escapeHtml(`${person.displayName} · ${[...new Set(person.identities.map((chip) => chip.source))].join(', ')}`)}</option>`).join('');
  // The merge choices are rendered once and copied into a row's picker when its
  // menu opens, so the page stays linear in the number of people.
  parts.push(`<template data-pp-merge-options>${mergeOptions}</template>`);
  for (const person of others) parts.push(personRow(person));
  parts.push(`<p class="ppempty" data-pp-nomatch hidden>${escapeHtml(C.noMatch)}</p>`);
  return parts.join('');
}

function chips(person: DashboardPeoplePerson): string {
  return `<div class="ppchips">${person.identities.map((chip) =>
    `<span class="ppchip" title="${escapeHtml(`${chip.source} ${chip.detail}`)}"><i class="ppdot" style="background:${SOURCE_DOTS[chip.provider] ?? 'var(--t3)'}"></i><span>${escapeHtml(chip.source === chip.detail ? chip.source : `${chip.source} ${chip.detail}`)}</span></span>`).join('')}</div>`;
}

function personRow(person: DashboardPeoplePerson): string {
  const first = person.identities[0]?.identityKey ?? '';
  const linked = linkedSentence(person.linkedBy);
  const why = person.named
    ? [linked || C.onlyOneSource, C.messages(person.messages)].join(' · ')
    : [C.noName, ...(linked ? [linked] : []), C.messages(person.messages)].join(' · ');
  const search = [person.displayName, ...person.identities.map((chip) => `${chip.source} ${chip.detail}`)].join(' ').toLowerCase();
  const splits = person.identities.length > 1
    ? person.identities.map((chip) =>
      `<button class="btn" type="button" data-pp-op="split" data-identity="${escapeHtml(chip.identityKey)}">${escapeHtml(C.split(`${chip.source} ${chip.detail}`))}</button>`).join('')
    : '';
  const menu = `<details class="rowmenu"><summary aria-label="${escapeHtml(C.more)}">⋯</summary><div class="menu">`
    + `<form class="ppedit" data-pp-rename><label class="hint" for="rn-${escapeHtml(person.personId)}">${escapeHtml(C.renamePrompt)}</label>`
    + `<input id="rn-${escapeHtml(person.personId)}" name="name" maxlength="160" value="${escapeHtml(person.named ? person.displayName : '')}">`
    + `<input type="hidden" name="identity" value="${escapeHtml(first)}"><button class="btn" type="submit">${escapeHtml(C.rename)}</button></form>`
    + `<form class="ppedit" data-pp-merge><label class="hint" for="mg-${escapeHtml(person.personId)}">${escapeHtml(C.mergeWith)}</label>`
    + `<select id="mg-${escapeHtml(person.personId)}" name="identity_b" required></select>`
    + `<input type="hidden" name="identity_a" value="${escapeHtml(first)}"><button class="btn" type="submit">${escapeHtml(C.merge)}</button></form>`
    + splits + '</div></details>';
  return `<div class="ppcard pprow" data-pp-person="${escapeHtml(person.personId)}" data-pp-search="${escapeHtml(search)}">`
    + `<div><p class="ppname">${escapeHtml(person.displayName)}</p>${chips(person)}<p class="ppwhy">${escapeHtml(why)}</p></div>${menu}</div>`;
}

/** "Linked by phone number and your contacts": one "Linked by", the reasons joined. */
export function linkedSentence(reasons: readonly string[]): string {
  const prefix = 'Linked by ';
  if (reasons.length === 0) return '';
  const rest = reasons.slice(1).map((reason) => (reason.startsWith(prefix) ? reason.slice(prefix.length) : reason.charAt(0).toLowerCase() + reason.slice(1)));
  return [reasons[0]!, ...rest].join(' and ');
}

/** The page's own small script: search, and posts that carry the control session's CSRF token. */
function peopleClientScript(csrfToken: string): string {
  const config = escapeScriptJson(JSON.stringify({ csrfToken, path: DASHBOARD_PEOPLE_PATH, copy: { failed: C.failed, unreachable: C.unreachable, saving: C.saving } }));
  return `(function () {
  var config = ${config};
  var root = document.querySelector('[data-people]');
  if (!root) return;
  var msg = root.querySelector('[data-pp-msg]');
  function say(text, error) { if (!msg) return; msg.textContent = text; if (error) msg.setAttribute('data-state', 'error'); else msg.removeAttribute('data-state'); }
  async function send(body) {
    say(config.copy.saving, false);
    var response;
    try {
      response = await fetch(config.path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Olympus-CSRF': config.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (error) { say(config.copy.unreachable, true); return; }
    var result = {};
    try { result = await response.json(); } catch (error) { result = {}; }
    if (response.ok && result && result.ok === true) { window.location.reload(); return; }
    say((result && result.error && result.error.message) || config.copy.failed, true);
  }
  root.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-pp-op]') : null;
    if (!button) return;
    var op = button.getAttribute('data-pp-op');
    if (op === 'split') { send({ op: 'split', identity: button.getAttribute('data-identity') }); return; }
    send({ op: op, identity_a: button.getAttribute('data-identity-a'), identity_b: button.getAttribute('data-identity-b') });
  });
  root.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.matches) return;
    event.preventDefault();
    var data = new FormData(form);
    if (form.matches('[data-pp-rename]')) send({ op: 'rename', identity: data.get('identity'), name: data.get('name') });
    else if (form.matches('[data-pp-merge]')) send({ op: 'merge', identity_a: data.get('identity_a'), identity_b: data.get('identity_b') });
  });
  var mergeOptions = root.querySelector('template[data-pp-merge-options]');
  root.addEventListener('toggle', function (event) {
    var menu = event.target;
    if (!menu || !menu.open || !mergeOptions) return;
    var picker = menu.querySelector('[data-pp-merge] select');
    if (!picker || picker.options.length > 0) return;
    var own = menu.querySelector('[data-pp-merge] input[name="identity_a"]');
    picker.appendChild(mergeOptions.content.cloneNode(true));
    Array.prototype.forEach.call(picker.options, function (option) { if (own && option.value === own.value) option.disabled = true; });
  }, true);
  var find = root.querySelector('[data-pp-find]');
  if (find) find.addEventListener('input', function () {
    var wanted = String(find.value || '').trim().toLowerCase();
    var shown = 0;
    root.querySelectorAll('[data-pp-person]').forEach(function (row) {
      var match = !wanted || (row.getAttribute('data-pp-search') || '').indexOf(wanted) >= 0;
      row.hidden = !match;
      if (match) shown += 1;
    });
    var none = root.querySelector('[data-pp-nomatch]');
    if (none) none.hidden = shown > 0;
  });
})();`;
}

function readToken(basePath: string | undefined): string | undefined {
  if (!basePath) return undefined;
  const query = basePath.indexOf('?');
  if (query < 0) return undefined;
  return new URLSearchParams(basePath.slice(query + 1)).get('token') ?? undefined;
}
