/** One owner question, three destinations, then the local Inbox.
 * Copy is in vocabulary.ts and layout in PRIVATE_ANSWERS_CSS.
 * Waiting text and every action require a locally minted control session.
 */
import { DASHBOARD_CONTROL_GATE_ID, escapeHtml, escapeScriptJson, pageShell } from '../components.ts';
import { chatgptMarkdownRender, CHATGPT_MARKDOWN_CSS } from '../chatgpt/markdown.ts';
import { dashboardLocalPageHref } from '../host-page.ts';
import { DASHBOARD_OUTSIDE_HELP_PATHS, summaryOf } from '../outside-help.ts';
import { DASHBOARD_OUTSIDE_HELP_CSS, LOCAL_PAGE_CSS } from '../static-styles.ts';
import {
  DASHBOARD_OUTSIDE_HELP_COPY as OH,
  DASHBOARD_PRIVATE_ANSWERS_COPY as W,
  dashboardRelativeFromMs,
} from '../vocabulary.ts';
import type { AskDestinationStates } from '../../email-source/venice-inbox-answer.ts';
import type { DashboardPageOptions, DashboardWaitingQuestion } from './local.ts';

/** The fragment the old Anonymous answers address lands on: that section, opened. */
export const DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT = 'anonymous';
const POST_PATH = '/dashboard/private-answers';

const PRIVATE_ANSWERS_CSS = `
.pa { width: 100%; min-width: 0; max-width: min(920px, 100%); }
.pa .pasection, .pa .paask, .pa .palist, .pa .srow, .pa .paout, .pa .pacard { min-width: 0; max-width: 100%; }
.pa .pintro, .pa .pnote, .pa .pafrom, .pa .paquestion { overflow-wrap: anywhere; white-space: normal; }
.pa .pasection + .pasection { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line); }
.pa .pasection > .sect { margin: 0 0 12px; }
.pa .paquestion { margin: 0 0 12px; color: var(--t1); font-size: var(--fs-row); }
.pa .paanswer { color: var(--t1); line-height: 1.55; overflow-wrap: anywhere; }
.pa .pasent { white-space: pre-wrap; }
.pa .paanswer:not(.md) { white-space: pre-wrap; }
.pa .paanswer pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.pa .paanswer table { table-layout: fixed; display: table; }
.pa .paask { display: grid; gap: 8px; margin: 0 0 8px; }
.pa .paask textarea { background: var(--bg); border: 1px solid var(--field); border-radius: 7px; color: var(--t1); font: inherit; font-size: var(--fs-body); padding: 8px 10px; min-height: 64px; resize: vertical; width: 100%; box-sizing: border-box; }
.pa .paask textarea:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
.pa ul.palist { list-style: none; padding: 0; margin-top: 0; }
.pa .paq { color: var(--t1); font-size: var(--fs-row); overflow-wrap: anywhere; }
.pa .pafrom { margin: 4px 0 0; color: var(--t3); font-size: var(--fs-body); }
.pa .paout { grid-column: 1 / -1; }
.pa .paout:empty { display: none; }
.pa .srow.unread .paq { font-weight: 700; }
.pa .pa-read { display: block; width: 100%; min-width: 0; border: 0; padding: 0; text-align: left; background: none; color: inherit; font: inherit; cursor: pointer; overflow-wrap: anywhere; white-space: normal; }
.pa .smain { min-width: 0; }
.pa .pa-read:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }
.pa .pacard { margin: 10px 0 0; padding: 14px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.pa .paanswer p { margin: 0 0 10px; max-width: 72ch; overflow-wrap: anywhere; }
.pa .paanswer p:last-child { margin-bottom: 0; }
.pa .pameta { margin: 12px 0 0; padding: 10px 0 0; border-top: 1px solid var(--line); color: var(--t3); font-size: var(--fs-body); }
.pa .pameta .palabel { margin: 0 0 4px; color: var(--t3); }
.pa .pasrc { margin: 0; padding-left: 18px; color: var(--t2); }
.pa .pasrc li { margin: 0 0 2px; overflow-wrap: anywhere; }
.pa .pasrc .paopen { margin-left: 8px; padding: 0; background: none; border: 0; color: var(--link); font: inherit; cursor: pointer; }
.pa .pasrc .paopen:disabled { color: var(--t3); cursor: default; }
.pa .pameta .pamsg { margin: 8px 0 0; color: var(--t3); }
.pa .pamsg { color: var(--t2); margin: 0 0 8px; }
.pa .pamsg[data-state="error"] { color: var(--bad); }
.pa .paunlock { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin: 0 0 16px; padding: 10px 14px; background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; }
.pa .paunlock .hint { color: var(--t2); }
.pa .paasks { --ladder-columns: 24px 164px minmax(0, 1fr) 210px; display: grid; grid-template-columns: var(--ladder-columns); column-gap: 16px; width: 100%; max-width: 920px; margin: 0 0 24px; }
.pa .padestination { grid-column: 1 / -1; display: grid; grid-template-columns: var(--ladder-columns); column-gap: 16px; align-items: start; min-width: 0; padding: 16px 0; border-bottom: 1px solid var(--line); position: relative; }
.pa .padestination:last-child { border-bottom: 0; }
.pa .padestination > * { min-width: 0; }
.pa .padestination .sect, .pa .padestination .pnote { margin: 0; }
.pa .paname { grid-column: 2; }
.pa .pastatus { display: none; align-items: center; gap: 6px; margin-top: 6px; color: var(--t3); font-size: var(--fs-body); }
.pa [data-pa-state="ready"] [data-pa-status="ready"], .pa [data-pa-state="not_set_up"] [data-pa-status="not_set_up"], .pa [data-pa-state="not_allowed"] [data-pa-status="not_allowed"], .pa [data-pa-state="busy"] [data-pa-status="busy"] { display: flex; }
.pa .pastatus .dot.ok { background: var(--good); }
.pa .pastatus .dot.run { background: var(--run-fill); }
.pa .pastatus .dot.pause { background: var(--warn-fill); }
.pa .pawhat { grid-column: 3; }
.pa .patag, .pa .paknows { color: var(--t3); font-size: var(--fs-body); }
.pa .padestination .patag, .pa .padestination .paknows { margin-top: 4px; }
.pa .padestination .paaction { grid-column: 4; display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
.pa .padestination .btn { white-space: normal; text-align: center; }
.pa .padestination .pareason { color: var(--t3); font-size: var(--fs-body); overflow-wrap: anywhere; }
.pa .panode { grid-column: 1; width: 12px; height: 12px; margin: 5px 0 0 6px; border-radius: 50%; background: var(--t3); position: relative; }
.pa #computer .panode { background: var(--t1); }
.pa .parail { position: absolute; left: 11px; width: 2px; background: var(--line); top: 0; bottom: -1px; }
.pa #computer .parail { top: 27px; }
.pa #venice .parail { bottom: auto; height: 27px; }
.pa .pazone { grid-column: 1 / -1; position: relative; padding: 12px 0 6px 40px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; gap: 12px; color: var(--t3); font-size: var(--fs-caption); }
.pa .pazone b { color: var(--t2); font-weight: 600; }
.pa .paboundary { border-top: 1px dashed var(--field); }
.pa .palevel { border: 0; margin: 12px 0 0; padding: 0; min-width: 0; display: grid; gap: 6px; }
.pa .palevel legend { padding: 0; margin: 0 0 2px; color: var(--t2); font-size: var(--fs-body); font-weight: 600; }
.pa .palevelopt { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: start; font-size: var(--fs-body); color: var(--t1); cursor: pointer; }
.pa .palevelopt input { margin: 3px 0 0; accent-color: var(--link); }
.pa .palevelopt b { font-weight: 600; }
.pa .palevelhint { display: block; color: var(--t3); }
.pa [data-pa-card="anonymous"]:not([data-pa-state="ready"]) .palevel { display: none; }
.pa .pachooser { margin: 12px 0 8px; color: var(--t2); font-size: var(--fs-body); }
@media (max-width: 640px) {
  .pa .paasks { grid-template-columns: minmax(0, 1fr); }
  .pa .padestination { grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 14px 0; }
  .pa .panode, .pa .parail { display: none; }
  .pa .paname, .pa .pawhat, .pa .padestination .paaction { grid-column: 1; }
  .pa .pazone { padding-left: 0; }
}

`;

export function renderDashboardPrivateAnswersPage(options?: DashboardPageOptions): string {
  const basePath = options?.basePath;
  return pageShell({
    title: 'Olympus',
    crumb: W.crumb,
    ...(basePath === undefined ? {} : { basePath }),
    meta: '',
    body: renderPrivateAnswersBody(options),
    styles: [CHATGPT_MARKDOWN_CSS, LOCAL_PAGE_CSS, DASHBOARD_OUTSIDE_HELP_CSS, PRIVATE_ANSWERS_CSS],
    // The local inbox carries its own small controller and visible-page poll.
  });
}

/** The read-only token a dash_ reader's basePath carries, for the link to the gate. */
function readToken(basePath: string | undefined): string | undefined {
  if (!basePath) return undefined;
  const query = basePath.indexOf('?');
  if (query < 0) return undefined;
  return new URLSearchParams(basePath.slice(query + 1)).get('token') ?? undefined;
}

function renderPrivateAnswersBody(options: DashboardPageOptions | undefined): string {
  const head = `<h2 class="ptitle">${escapeHtml(W.title)}</h2><p class="pintro">${escapeHtml(W.intro)}</p>`;
  const csrfToken = options?.controlSessionCsrfToken;
  const localSession = csrfToken !== undefined && options?.outsideHelpLocalSession === true;
  const parts: string[] = [head];
  let script = '';
  if (csrfToken === undefined) {
    const gate = `${dashboardLocalPageHref('keys', readToken(options?.basePath))}#${DASHBOARD_CONTROL_GATE_ID}`;
    parts.push(`<p class="pnote" data-pa-locked>${escapeHtml(W.locked)} <a href="${escapeHtml(gate)}">${escapeHtml(W.openControls)}</a></p>`);
  } else if (!localSession) {
    // A bearer-grade session (the launch flow) reads nothing here: the local
    // unlock comes first, as on the outside-help card.
    parts.push(`<form class="paunlock" data-pa-unlock>`
      + `<button type="submit" class="btn primary">${escapeHtml(W.unlock)}</button><span class="hint">${escapeHtml(W.unlockIntro)}</span>`
      + `<span class="pamsg" data-pa-msg role="status"></span></form>`);
    script = `<script>${privateAnswersClientScript({ csrfToken: '', unlockOnly: true })}</script>`;
  } else if (options?.privateAnswers?.available !== true) {
    parts.push(`<p class="pnote" data-pa-unavailable>${escapeHtml(W.unavailable)}</p>`);
  } else {
    parts.push(renderDestinations(options, true));
    parts.push(renderWaiting(options.privateAnswers.waiting, options.now ?? new Date()));
    script = `<script>${privateAnswersClientScript({ csrfToken, unlockOnly: false })}</script>`;
  }
  if (!localSession || options?.privateAnswers?.available !== true) parts.push(renderDestinations(options, false));
  return `<div class="privacy pa" data-private-answers>${parts.join('')}</div>${script}`;
}

function renderDestinations(options: DashboardPageOptions | undefined, enabled: boolean): string {
  const models = dashboardLocalPageHref('keys', readToken(options?.basePath));
  const states: AskDestinationStates = options?.privateAnswers?.destinations ?? { computer: 'not_set_up', venice: 'not_set_up' };
  const zk = options?.outsideHelp;
  const zkState = zk && summaryOf(zk).state;
  const destinations = [
    { id: 'computer', name: W.computerName, tag: W.computerTag, leaves: W.computerLeaves, knows: W.computerKnows, ask: W.askComputer, setup: W.setUpComputer, state: states.computer, reason: states.computerReason ?? W.noModel, href: models, action: 'ask' },
    { id: 'anonymous', name: W.zkapiName, tag: W.zkapiTag, leaves: W.zkapiLeaves, knows: W.zkapiKnows, ask: W.askZkapi, setup: zkState === 'off' ? W.turnOnInModels : zkState === 'needs_acceptance' ? W.goToModels : W.setUpZkapi, state: zkState === 'on' ? 'ready' : 'not_set_up', reason: zkState === 'off' ? W.zkapiOff : zkState === 'needs_acceptance' ? W.zkapiPaused : !zkState || zkState === 'route_not_configured' ? W.zkapiNotSetUp : OH.row[zkState], href: models + '#anonymous', action: 'ask_anonymous' },
    { id: 'venice', name: W.veniceName, tag: W.veniceTag, leaves: W.veniceLeaves, knows: W.veniceKnows, ask: W.askVenice, setup: W.setUpVenice, state: states.venice, reason: W.veniceNotSetUp, href: models + '#venice-setup', action: 'ask_venice' },
  ];
  return `<form class="paask" data-pa-ask><label class="sect" for="pa-question">${escapeHtml(W.askLabel)}</label>`
    + `<textarea id="pa-question" name="question" maxlength="2000" placeholder="${escapeHtml(W.askPlaceholder)}"${enabled ? '' : ' disabled'}></textarea>`
    + `<p class="pachooser" id="pa-chooser">${escapeHtml(W.chooserLabel)}</p><div class="paasks" role="group" aria-labelledby="pa-chooser"><div class="pazone"><b>${escapeHtml(W.stays)}</b></div>${destinations.map(d => {
      const actions = {
        ready: `<button type="submit" class="btn primary" data-pa-destination="${d.id}" data-pa-action="${d.action}">${escapeHtml(d.ask)}</button><span class="pareason" role="status"></span>`,
        not_set_up: `<a class="btn" href="${escapeHtml(d.href)}">${escapeHtml(d.setup)}</a><span class="pareason" role="status">${escapeHtml(d.reason)}</span>`,
        not_allowed: `<a class="btn" href="${escapeHtml(models + '#private-routing')}">${escapeHtml(W.changePrivacy)}</a><span class="pareason" role="status">${escapeHtml(W.veniceNotAllowed)}</span>`,
        busy: `<button type="button" class="btn" disabled>${escapeHtml(W.answering)}</button><span class="pareason" role="status">${escapeHtml(W.destinationBusy)}</span>`,
      };
      const state = d.state as keyof typeof actions;
      const action = enabled ? actions[state] : `<a class="btn" href="${escapeHtml(models)}">${escapeHtml(W.openControls)}</a><span class="pareason">${escapeHtml(W.locked)}</span>`;
      const notReadyLabel = d.id === 'computer' ? d.reason === W.downloading ? W.downloadingStatus : W.notSetUpStatus
        : d.id === 'anonymous' && zkState === 'off' ? W.offStatus : d.id === 'anonymous' && zkState === 'needs_acceptance' ? W.pausedStatus : W.notConnectedStatus;
      const notReadyDot = notReadyLabel === W.downloadingStatus ? 'run' : notReadyLabel === W.pausedStatus ? 'pause' : 'hollow';
      const statuses = [['ready', W.readyStatus, 'ok'], ['not_set_up', notReadyLabel, notReadyDot], ['not_allowed', W.offStatus, 'hollow'], ['busy', W.answering, 'run']]
        .map(([key, label, dot]) => `<span class="pastatus" data-pa-status="${key}"><span class="dot ${dot}" aria-hidden="true"></span>${escapeHtml(label!)}</span>`).join('');
      return (d.id === 'anonymous' ? `<div class="pazone paboundary"><span class="parail" aria-hidden="true"></span><b>${escapeHtml(W.leaves)}</b><span>${escapeHtml(W.order)}</span></div>` : '') + `<section class="padestination" id="${d.id}" data-pa-card="${d.id}" data-pa-state="${state}"><span class="parail" aria-hidden="true"></span><span class="panode" aria-hidden="true"></span><div class="paname"><h3 class="sect">${escapeHtml(d.name)}</h3><p class="pnote patag">${escapeHtml(d.tag)}</p>${statuses}</div><div class="pawhat"><p class="pnote paleaves">${escapeHtml(d.leaves)}</p><p class="pnote paknows">${escapeHtml(d.knows)}</p>${d.id === 'anonymous' && enabled ? renderLevelChoice(zk?.settings.level === 'general' ? 'strict' : 'standard', models + '#anonymous') : ''}</div><div class="paaction">${action}</div>${Object.entries(actions).map(([key, html]) => `<template data-pa-template="${key}">${html}</template>`).join('')}</section>`;
    }).join('')}</div><div class="paout" data-pa-out aria-live="polite"></div></form>`;
}

// Strict or Standard for this question (owner, 2026-10-24): the saved
// setting is only the starting choice; the pick goes with the question.
function renderLevelChoice(level: 'strict' | 'standard', settingsHref: string): string {
  const option = (value: 'strict' | 'standard', label: string, hint: string) =>
    `<label class="palevelopt"><input type="radio" name="level" value="${value}"${value === level ? ' checked' : ''}><span><b>${escapeHtml(label)}</b><span class="palevelhint">${hint}</span></span></label>`;
  const standardHint = escapeHtml(W.levelStandardHint).replace('{models}', `<a href="${escapeHtml(settingsHref)}">${escapeHtml(W.levelModelsLink)}</a>`);
  return `<fieldset class="palevel" data-pa-level><legend>${escapeHtml(W.levelLegend)}</legend>`
    + option('strict', W.levelStrict, escapeHtml(W.levelStrictHint))
    + option('standard', W.levelStandard, standardHint)
    + '</fieldset>';
}

function renderWaiting(waiting: { questions: readonly DashboardWaitingQuestion[]; olderRemoved: boolean } | undefined, now: Date): string {
  const parts: string[] = [`<section class="pasection" aria-labelledby="waiting"><h3 class="sect" id="waiting">${escapeHtml(W.waitingTitle)}</h3>`];
  if (!waiting) {
    parts.push(`<p class="pnote" data-pa-unreadable>${escapeHtml(W.unavailable)}</p>`);
    return parts.join('') + '</section>';
  }
  parts.push(`<p class="pnote" data-pa-none${waiting.questions.length ? ' hidden' : ''}>${escapeHtml(W.noneWaiting)}</p>`);
  parts.push(`<p class="pnote">${escapeHtml(W.waitingIntro)}</p>`);
  const rows = [...waiting.questions].sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt)).map((question) => {
    const asked = Date.parse(question.askedAt);
    const when = Number.isFinite(asked) ? dashboardRelativeFromMs(now.getTime() - asked) : '';
    const state = question.state ?? (question.unchecked ? 'unchecked' : 'answering');
    const status = state === 'changed' ? W.changed : state === 'queued' ? W.queued : state === 'retrying' ? W.retrying : state === 'answering' ? W.answering : state === 'unchecked' ? W.unchecked : '';
    const from = [question.path === 'venice' ? W.veniceName : question.path === 'anonymous' ? W.anonymousPath : W.privatePath, question.from, when, status].filter(Boolean).join(' · ');
    return `<li class="srow nodot${question.unread ? ' unread' : ''}" id="${escapeHtml(question.id)}" data-pa-question="${escapeHtml(question.id)}">`
      + `<div class="smain"><button type="button" class="pa-read" data-pa-read><span class="paq">${escapeHtml(question.question)}</span><span class="pafrom" title="${escapeHtml(question.askedAt)}"> · ${escapeHtml(from)}</span></button></div>`
      + `<div class="sact"><button type="button" class="btn" data-pa-delete>${escapeHtml(W.delete)}</button></div>`
      + `<div class="paout" data-pa-out aria-live="polite"></div></li>`;
  });
  parts.push(`<ul class="srows palist" data-pa-list>${rows.join('')}</ul>`);
  parts.push(`<div class="pbuttons"><button type="button" class="btn" data-pa-delete-all${waiting.questions.length ? '' : ' hidden'}>${escapeHtml(W.deleteAll)}</button></div>`);
  parts.push(`<p class="pnote hint" data-pa-older-removed${waiting.olderRemoved ? '' : ' hidden'}>${escapeHtml(W.olderRemoved)}</p>`);
  parts.push('<p class="pnote" data-pa-missing hidden role="status"></p>');
  return parts.join('') + '</section>';
}

/**
 * The page's own script. Posts carry the control session's CSRF token; the
 * local unlock carries nothing (the boundary wants a loopback browser). An
 * answer's acknowledgment is posted back only after the answer is on screen.
 */
function privateAnswersClientScript(input: { csrfToken: string; unlockOnly: boolean }): string {
  const config = {
    csrfToken: input.csrfToken,
    path: POST_PATH,
    unlockPath: DASHBOARD_OUTSIDE_HELP_PATHS.unlock,
    unlockOnly: input.unlockOnly,
    fragment: DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT,
    copy: {
      answering: W.answering,
      sources: W.sources,
      sentItems: W.sentItems,
      venicePath: W.veniceName,
      destinationBusy: W.destinationBusy,
      sent: W.sent,
      privatePath: W.privatePath,
      anonymousPath: W.anonymousPath,
      open: W.open,
      leftOut: W.leftOut,
      unanswered: W.unanswered,
      notFound: W.notFound,
      noModel: W.noModel,
      downloading: W.downloading,
      changed: W.changed,
      failed: W.failed,
      unreachable: W.unreachable,
      delete: W.delete,
      deleteAllConfirm: W.deleteAllConfirm,
      deleted: W.deleted,
      nothingDeleted: W.nothingDeleted,
      retrying: W.retrying,
      queued: W.queued,
      checkUnavailable: W.checkUnavailable,
      unchecked: W.unchecked,
    },
  };
  return `window.olympusMarkdown=(${chatgptMarkdownRender.toString()});
(function () {
  var config = ${escapeScriptJson(JSON.stringify(config))};
  var root = document.querySelector('[data-private-answers]');
  if (!root) return;
  function openAnonymous() {
    if (window.location.hash !== '#' + config.fragment) return;
    var section = document.getElementById(config.fragment);
    if (section) { if (section.scrollIntoView) section.scrollIntoView({ block: 'start' }); }
  }
  openAnonymous();
  window.addEventListener('hashchange', openAnonymous);
  var unlock = root.querySelector('form[data-pa-unlock]');
  if (unlock) {
    unlock.addEventListener('submit', function (event) {
      event.preventDefault();
      var button = unlock.querySelector('button');
      if (button) button.disabled = true;
      fetch(config.unlockPath, { method: 'POST', credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
        if (response.ok) { window.location.reload(); return; }
        var msg = unlock.querySelector('[data-pa-msg]');
        if (msg) { msg.textContent = config.copy.failed; msg.setAttribute('data-state', 'error'); }
        if (button) button.disabled = false;
      }, function () {
        var msg = unlock.querySelector('[data-pa-msg]');
        if (msg) { msg.textContent = config.copy.unreachable; msg.setAttribute('data-state', 'error'); }
        if (button) button.disabled = false;
      });
    });
  }
  if (config.unlockOnly) return;
  async function send(body) {
    var response;
    try {
      response = await fetch(config.path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-Olympus-CSRF': config.csrfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return { ok: false, status: 0, result: { error: { message: config.copy.unreachable } } };
    }
    var result = {};
    try { result = await response.json(); } catch (error) { result = {}; }
    return { ok: response.ok && result && result.ok === true, status: response.status, result: result || {} };
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function panel(out, question) {
    out.textContent = '';
    var card = el('div', 'pacard');
    var heading = el('p', 'paquestion');
    heading.appendChild(el('strong', '', question));
    card.appendChild(heading);
    out.appendChild(card);
    return card;
  }
  function message(out, text, bad, question) {
    var card = panel(out, question || '');
    var line = el('p', 'pamsg', text);
    if (bad) line.setAttribute('data-state', 'error');
    card.appendChild(line);
  }
  function errorText(outcome) {
    var error = outcome.result && outcome.result.error;
    if (error && typeof error.message === 'string' && error.message) return error.message;
    return outcome.status === 0 ? config.copy.unreachable : config.copy.failed;
  }
  function openFile(token, button) {
    button.disabled = true;
    send({ action: 'open', token: token }).then(function (outcome) {
      button.disabled = false;
      if (!outcome.ok) { button.textContent = errorText(outcome); button.disabled = true; }
    });
  }
  function renderSent(parent, result) {
    if (!Array.isArray(result.sent_items)) return;
    parent.appendChild(el('div', 'palabel', config.copy.sentItems));
    var sentList = el('ul', 'pasrc');
    result.sent_items.forEach(function (item) { sentList.appendChild(el('li', '', [item.title, item.source, item.date].filter(Boolean).join(' · '))); });
    parent.appendChild(sentList);
  }
  // Shared Markdown builds text-only DOM nodes; no model HTML is interpreted.
  function render(out, result, question) {
    var card = panel(out, question);
    var status = result.status;
    var leftOut = Array.isArray(result.left_out) ? result.left_out : [];
    if (status === 'withdrawn') { renderSent(card, result); card.appendChild(el('p', 'pamsg', result.reason)); return; }
    if (status === 'answered') {
      var box = el('div', 'paanswer answer');
      var markdown = window.olympusMarkdown;
      if (typeof markdown === 'function') {
        box.classList.add('md');
        markdown(document, box, String(result.answer || ''));
      } else {
        box.textContent = String(result.answer || '');
      }
      card.appendChild(box);
      if (typeof result.sent === 'string') { card.appendChild(el('p', 'palabel', config.copy.sent)); card.appendChild(el('p', 'paquestion pasent', result.sent)); }
      var meta = el('div', 'pameta');
      renderSent(meta, result);
      var citations = Array.isArray(result.citations) ? result.citations : [];
      if (citations.length > 0) {
        meta.appendChild(el('div', 'palabel', config.copy.sources));
        var list = el('ol', 'pasrc');
        citations.forEach(function (citation) {
          var item = el('li');
          var label = [citation.title, citation.source, citation.date].filter(function (part) { return typeof part === 'string' && part !== ''; }).join(' · ');
          item.appendChild(document.createTextNode(label));
          if (typeof citation.open === 'string') {
            var button = el('button', 'paopen', config.copy.open);
            button.type = 'button';
            button.addEventListener('click', function () { openFile(citation.open, button); });
            item.appendChild(button);
          }
          list.appendChild(item);
        });
        meta.appendChild(list);
      }
      if (Array.isArray(result.unanswered) && result.unanswered.length > 0) {
        meta.appendChild(el('p', 'pamsg', config.copy.unanswered.replace('{parts}', result.unanswered.join('; '))));
      }
      if (leftOut.length > 0) meta.appendChild(el('p', 'pamsg', config.copy.leftOut.replace('{sources}', leftOut.join(', '))));
      if (meta.childNodes.length > 0) card.appendChild(meta);
      return;
    } else if (status === 'answering' || status === 'retrying' || status === 'unchecked' || status === 'queued' || status === 'check_unavailable') {
      card.appendChild(el('p', 'pamsg', status === 'check_unavailable' ? config.copy.checkUnavailable : status === 'queued' ? config.copy.queued : status === 'retrying' ? config.copy.retrying : status === 'unchecked' ? config.copy.unchecked : config.copy.answering));
    } else if (status === 'not_found') {
      card.appendChild(el('p', 'pamsg', config.copy.notFound));
    } else {
      var words = status === 'no_model' ? config.copy.noModel
        : status === 'model_downloading' ? config.copy.downloading
        : status === 'changed' ? config.copy.changed
        : config.copy.failed;
      message(out, words, true, question);
      card = out.firstChild;
    }
    if (leftOut.length > 0) card.appendChild(el('p', 'pamsg hint', config.copy.leftOut.replace('{sources}', leftOut.join(', '))));
  }
  root.querySelectorAll('form[data-pa-ask]').forEach(function (ask) {
    ask.addEventListener('submit', async function (event) {
      event.preventDefault();
      var field = ask.querySelector('textarea[name="question"]');
      var out = ask.querySelector('[data-pa-out]');
      var button = event.submitter || ask.querySelector('button[type="submit"]');
      if (!button || button.disabled || !button.getAttribute('data-pa-action')) return;
      var reason = button.parentElement.querySelector('.pareason');
      var question = field ? String(field.value || '').trim() : '';
      if (!question || !out) return;
      if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
      if (reason) reason.textContent = config.copy.destinationBusy;
      message(out, config.copy.answering, false, question);
      var body = { action: button.getAttribute('data-pa-action'), question: question };
      var level = body.action === 'ask_anonymous' ? Array.from(ask.querySelectorAll('[data-pa-level] input[name="level"]')).find(function (input) { return input.checked; }) : null;
      if (level) body.level = level.value;
      var outcome = await send(body);
      if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
      if (reason) reason.textContent = '';
      if (!outcome.ok) { message(out, errorText(outcome), true, question); return; }
      render(out, outcome.result, question);
      await poll();
    });
  });
  var selected = null;
  var readVersion = 0;
  var seen = {};
  var list = root.querySelector('[data-pa-list]');
  function rows() { return Array.from(root.querySelectorAll('[data-pa-question]')); }
  function findRow(id) { return rows().find(function (row) { return row.getAttribute('data-pa-question') === id; }); }
  function missing() {
    var note = root.querySelector('[data-pa-missing]');
    if (note) { note.hidden = false; note.textContent = config.copy.deleted; }
  }
  async function read(row, quiet) {
    var id = row.getAttribute('data-pa-question');
    selected = id;
    var version = ++readVersion;
    var question = row.querySelector('.paq').textContent;
    var out = row.querySelector('[data-pa-out]');
    if (!quiet) {
      rows().forEach(function (other) { if (other !== row) other.querySelector('[data-pa-out]').textContent = ''; });
      message(out, config.copy.answering, false, question);
    }
    var outcome = await send({ action: 'read', id: id });
    if (version !== readVersion || selected !== id || !row.isConnected) return;
    if (!outcome.ok) {
      message(out, outcome.status === 410 || outcome.status === 404 ? config.copy.deleted : errorText(outcome), true, question);
      return;
    }
    render(out, outcome.result, question);
    var generation = outcome.result.generation;
    if ((outcome.result.status === 'answered' || outcome.result.status === 'not_found' || outcome.result.status === 'withdrawn') && (typeof generation === 'number' || typeof generation === 'string') && seen[id] !== generation) {
      var ack = await send({ action: 'seen', id: id, generation: generation });
      if (ack.ok) { seen[id] = generation; row.classList.remove('unread'); }
    }
  }
  function bind(row) {
    row.querySelector('[data-pa-read]').addEventListener('click', function () { read(row, false); });
    row.querySelector('[data-pa-delete]').addEventListener('click', async function () {
      var button = this;
      button.disabled = true;
      var id = row.getAttribute('data-pa-question');
      var outcome = await send({ action: 'delete', id: id });
      button.disabled = false;
      // What the server says it removed, for the release check to read (never shown).
      root.setAttribute('data-pa-removed', String(outcome.ok && typeof outcome.result.removed === 'number' ? outcome.result.removed : 0));
      // 410: the answer is not there (a retry after a lost reply, or deleted elsewhere), so its row goes quietly.
      // Any other failure keeps the row and says why.
      if (!outcome.ok && outcome.status !== 410) { message(row.querySelector('[data-pa-out]'), errorText(outcome), true, row.querySelector('.paq').textContent); return; }
      if (outcome.ok && outcome.result.removed !== 1) {
        // Ok with nothing removed (an older worker): the worker's own list decides whether the row stays.
        await poll();
        var still = findRow(id);
        if (still) message(still.querySelector('[data-pa-out]'), config.copy.nothingDeleted, true, still.querySelector('.paq').textContent);
        return;
      }
      if (selected === id) { selected = null; ++readVersion; }
      row.remove();
      empty();
    });
  }
  function empty() {
    var count = rows().length;
    var none = root.querySelector('[data-pa-none]');
    var all = root.querySelector('[data-pa-delete-all]');
    if (none) none.hidden = count !== 0;
    if (all) all.hidden = count === 0;
    // "Nothing was deleted" is about rows still listed: an empty inbox has nothing left to say it of.
    var note = root.querySelector('[data-pa-missing]');
    if (note && count === 0 && note.textContent === config.copy.nothingDeleted) { note.hidden = true; note.textContent = ''; }
  }
  rows().forEach(bind);
  var all = root.querySelector('[data-pa-delete-all]');
  if (all) all.addEventListener('click', async function () {
    if (!window.confirm(config.copy.deleteAllConfirm)) return;
    all.disabled = true;
    var outcome = await send({ action: 'delete_all' });
    all.disabled = false;
    var removed = outcome.ok && typeof outcome.result.removed === 'number' ? outcome.result.removed : 0;
    root.setAttribute('data-pa-removed', String(removed));
    var note = root.querySelector('[data-pa-missing]');
    if (outcome.ok && removed > 0) { selected = null; ++readVersion; rows().forEach(function (row) { row.remove(); }); empty(); return; }
    if (!outcome.ok) { if (note) { note.hidden = false; note.textContent = errorText(outcome); } return; }
    // None removed: the worker's own list says what is left (the rows may have gone already). Only rows still
    // listed are "nothing was deleted".
    await poll();
    if (note && rows().length > 0) { note.hidden = false; note.textContent = config.copy.nothingDeleted; }
    empty();
  });
  function openFragment() {
    var id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (_) { return; }
    if (!id || id === config.fragment) return;
    var row = findRow(id);
    if (!row) { missing(); return; }
    if (row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    read(row, false);
  }
  openFragment();
  window.addEventListener('hashchange', openFragment);
  var relative = ${dashboardRelativeFromMs.toString()};
  async function poll() {
    if (document.hidden) return;
    var outcome = await send({ action: 'list' });
    if (!outcome.ok || !Array.isArray(outcome.result.questions) || !list) {
      var openRow = selected && findRow(selected);
      if (openRow) await read(openRow, true);
      return;
    }
    if (outcome.result.destinations) root.querySelectorAll('[data-pa-card]').forEach(function (card) {
      var key = card.getAttribute('data-pa-card');
      var state = outcome.result.destinations[key];
      if (!state || state === card.getAttribute('data-pa-state') || card.querySelector('[aria-busy="true"]')) return;
      var template = card.querySelector('[data-pa-template="' + state + '"]');
      if (!template) return;
      var action = card.querySelector('.paaction');
      action.textContent = ''; action.appendChild(template.content.cloneNode(true)); card.setAttribute('data-pa-state', state);
    });
    var questions = outcome.result.questions.slice().sort(function (a, b) { return Date.parse(b.askedAt) - Date.parse(a.askedAt); });
    rows().forEach(function (row) {
      if (!questions.some(function (q) { return q.id === row.getAttribute('data-pa-question'); })) {
        if (selected === row.getAttribute('data-pa-question')) { selected = null; ++readVersion; missing(); }
        row.remove();
      }
    });
    questions.forEach(function (q) {
      var row = findRow(q.id);
      if (!row) {
        row = el('li', 'srow nodot'); row.id = q.id; row.setAttribute('data-pa-question', q.id);
        var main = el('div', 'smain'); var link = el('button', 'pa-read'); link.type = 'button'; link.setAttribute('data-pa-read', '');
        link.appendChild(el('span', 'paq')); link.appendChild(el('span', 'pafrom')); main.appendChild(link); row.appendChild(main);
        var actions = el('div', 'sact'); var remove = el('button', 'btn', config.copy.delete); remove.type = 'button'; remove.setAttribute('data-pa-delete', ''); actions.appendChild(remove); row.appendChild(actions);
        var out = el('div', 'paout'); out.setAttribute('data-pa-out', ''); out.setAttribute('aria-live', 'polite'); row.appendChild(out); bind(row);
      }
      row.classList.toggle('unread', q.unread === true);
      row.querySelector('.paq').textContent = q.question;
      if (selected === q.id && q.state !== 'answered') {
        message(row.querySelector('[data-pa-out]'), q.state === 'changed' ? config.copy.changed : q.state === 'queued' ? config.copy.queued : q.state === 'retrying' ? config.copy.retrying : q.state === 'unchecked' ? config.copy.unchecked : config.copy.answering, false, q.question);
      }
      var state = q.state === 'changed' ? config.copy.changed : q.state === 'queued' ? config.copy.queued : q.state === 'retrying' ? config.copy.retrying : q.state === 'answering' ? config.copy.answering : q.state === 'unchecked' ? config.copy.unchecked : '';
      var date = new Date(q.askedAt);
      row.querySelector('.pafrom').textContent = ' · ' + [q.path === 'venice' ? config.copy.venicePath : q.path === 'anonymous' ? config.copy.anonymousPath : config.copy.privatePath, q.from, isNaN(date.getTime()) ? '' : relative(Date.now() - date.getTime()), state].filter(Boolean).join(' · ');
      row.querySelector('.pafrom').title = q.askedAt;
      list.appendChild(row);
    });
    empty();
    var older = root.querySelector('[data-pa-older-removed]');
    if (older) older.hidden = !outcome.result.olderRemoved;
    var current = selected && findRow(selected);
    if (current) await read(current, true);
  }
  // A selected answer is rechecked through read eligibility on each visible poll.
  function schedule() {
    if (typeof window.setTimeout !== 'function') return;
    window.setTimeout(async function () { await poll(); schedule(); }, 5000);
  }
  schedule();
})();`;
}
