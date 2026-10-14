/**
 * Private answers: the computer's own page for questions answered only here
 * (design docs/design/background-agents.md, sections A and B, and
 * "Dashboard changes" 1 and 2). It replaced the Anonymous answers page in the
 * local nav; that page's card now sits beneath, collapsed, as outside help.
 *
 * Top to bottom: Ask privately; the questions waiting for this computer
 * (question · who asked · when, Answer and Dismiss, the answer in place);
 * Anonymous answers (zkAPI), collapsed.
 *
 * Everything that reads or answers is held to a local control session: the
 * worker renders the waiting list only for one, and its one POST route
 * (/dashboard/private-answers) refuses every other grade at the HTTP
 * boundary. Neither ChatGPT nor the OpenClaw Control UI tab opens this page.
 */
import { DASHBOARD_CONTROL_GATE_ID, escapeHtml, escapeScriptJson, pageShell } from '../components.ts';
import { chatgptMarkdownRender, CHATGPT_MARKDOWN_CSS } from '../chatgpt/markdown.ts';
import { dashboardLocalPageHref } from '../host-page.ts';
import { DASHBOARD_OUTSIDE_HELP_PATHS, renderOutsideHelpCard, summaryOf } from '../outside-help.ts';
import { DASHBOARD_OUTSIDE_HELP_CSS, LOCAL_PAGE_CSS } from '../static-styles.ts';
import {
  DASHBOARD_OUTSIDE_HELP_COPY as OH,
  DASHBOARD_PRIVATE_ANSWERS_COPY as W,
  dashboardRelativeFromMs,
} from '../vocabulary.ts';
import type { DashboardPageOptions, DashboardWaitingQuestion } from './local.ts';

/** The fragment the old Anonymous answers address lands on: that section, opened. */
export const DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT = 'anonymous';
const POST_PATH = '/dashboard/private-answers';

const PRIVATE_ANSWERS_CSS = `
.pa .pasection + .pasection { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line); }
.pa .pasection > .sect { margin: 0 0 12px; }
.pa .paquestion { margin: 0 0 12px; color: var(--t1); font-size: var(--fs-row); }
.pa .paanswer { color: var(--t1); line-height: 1.55; overflow-wrap: anywhere; }
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
.pa .srow.answered .paq { font-weight: 600; }
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
.pa details.paanon { margin-top: 28px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.pa details.paanon > summary { display: flex; align-items: baseline; gap: 6px 14px; flex-wrap: wrap; padding: 12px 0; cursor: pointer; list-style: none; }
.pa details.paanon > summary::-webkit-details-marker { display: none; }
.pa details.paanon > summary::before { content: '\\25B8'; color: var(--t3); font-size: var(--fs-body); width: 12px; flex: none; }
.pa details.paanon[open] > summary::before { content: '\\25BE'; }
.pa details.paanon > summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; border-radius: 4px; }
.pa .paanon-title { margin: 0; font-size: var(--fs-section); font-weight: 600; color: var(--t1); }
.pa .paanon-sum { color: var(--t3); font-size: var(--fs-body); }
.pa .paanon-body { padding: 0 0 16px; }
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
    // No shared controller and no poll: the page carries its own small
    // script, and the answer appears in place.
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
    parts.push(renderAsk());
    parts.push(renderWaiting(options.privateAnswers.waiting, options.now ?? new Date()));
    script = `<script>${privateAnswersClientScript({ csrfToken, unlockOnly: false })}</script>`;
  }
  parts.push(renderAnonymous(options, csrfToken));
  return `<div class="privacy pa" data-private-answers>${parts.join('')}</div>${script}`;
}

function renderAsk(): string {
  return `<section class="pasection" aria-labelledby="ask-heading"><h3 class="sect" id="ask-heading">${escapeHtml(W.askLabel)}</h3><form class="paask" data-pa-ask>`
    + `<textarea aria-labelledby="ask-heading" id="pa-question" name="question" maxlength="2000" placeholder="${escapeHtml(W.askPlaceholder)}"></textarea>`
    + `<div class="pbuttons"><button type="submit" class="btn primary">${escapeHtml(W.ask)}</button></div>`
    + `<div class="paout" data-pa-out aria-live="polite"></div></form></section>`;
}

function renderWaiting(waiting: { questions: readonly DashboardWaitingQuestion[]; olderRemoved: boolean } | undefined, now: Date): string {
  const parts: string[] = [`<section class="pasection" aria-labelledby="waiting"><h3 class="sect" id="waiting">${escapeHtml(W.waitingTitle)}</h3>`];
  if (!waiting) {
    parts.push(`<p class="pnote" data-pa-unreadable>${escapeHtml(W.unavailable)}</p>`);
    return parts.join('') + '</section>';
  }
  if (waiting.questions.length === 0) {
    parts.push(`<p class="pnote" data-pa-none>${escapeHtml(W.noneWaiting)}</p>`);
  } else {
    parts.push(`<p class="pnote">${escapeHtml(W.waitingIntro)}</p>`);
    const rows = waiting.questions.map((question) => {
      const asked = Date.parse(question.askedAt);
      const when = Number.isFinite(asked) ? dashboardRelativeFromMs(now.getTime() - asked) : '';
      const from = [question.from, when, question.unchecked ? W.unchecked : ''].filter((part) => part !== '').join(' · ');
      return `<li class="srow nodot" data-pa-question="${escapeHtml(question.id)}">`
        + `<div class="smain"><div class="paq">${escapeHtml(question.question)}</div><div class="pafrom">${escapeHtml(from)}</div></div>`
        + `<div class="sact"><button type="button" class="btn primary" data-pa-answer>${escapeHtml(W.answer)}</button>`
        + `<button type="button" class="btn" data-pa-dismiss>${escapeHtml(W.dismiss)}</button></div>`
        + `<div class="paout" data-pa-out aria-live="polite"></div></li>`;
    });
    parts.push(`<ul class="srows palist">${rows.join('')}</ul>`);
    if (waiting.questions.length > 1) {
      parts.push(`<div class="pbuttons"><button type="button" class="btn" data-pa-dismiss-all>${escapeHtml(W.dismissAll)}</button></div>`);
    }
  }
  if (waiting.olderRemoved) parts.push(`<p class="pnote hint" data-pa-older-removed>${escapeHtml(W.olderRemoved)}</p>`);
  return parts.join('') + '</section>';
}

/** Anonymous answers (zkAPI): outside help, collapsed beneath, never fed by waiting questions. */
function renderAnonymous(options: DashboardPageOptions | undefined, csrfToken: string | undefined): string {
  const status = options?.outsideHelp;
  let body: string;
  let sum: string = W.anonymousSum;
  if (csrfToken === undefined) {
    body = `<div class="outside"><p class="pnote">${escapeHtml(OH.intro)}</p></div>`;
  } else if (!status) {
    body = `<div class="outside" data-outside-unavailable><p class="pnote">${escapeHtml(OH.unavailable)}</p></div>`;
  } else {
    // "Outside help · off · not set up": the card's own row words, without its name.
    const row: string = OH.row[summaryOf(status).state];
    sum = `${W.anonymousSum} · ${row.replace(/^[^:]*:\s*/, '')}`;
    body = renderOutsideHelpCard(status, {
      csrfToken,
      localSession: options?.outsideHelpLocalSession === true,
      untitled: true,
      ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
    });
  }
  return `<details class="paanon" id="${DASHBOARD_PRIVATE_ANSWERS_ANONYMOUS_FRAGMENT}" data-pa-anonymous>`
    + `<summary><h3 class="paanon-title">${escapeHtml(W.anonymousTitle)}</h3><span class="paanon-sum">${escapeHtml(sum)}</span></summary>`
    + `<div class="paanon-body">${body}</div></details>`;
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
      open: W.open,
      leftOut: W.leftOut,
      unanswered: W.unanswered,
      notFound: W.notFound,
      noModel: W.noModel,
      downloading: W.downloading,
      changed: W.changed,
      failed: W.failed,
      unreachable: W.unreachable,
      dismissed: W.dismissed,
      dismissAllConfirm: W.dismissAllConfirm,
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
    if (section) { section.open = true; if (section.scrollIntoView) section.scrollIntoView({ block: 'start' }); }
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
  // Shared Markdown builds text-only DOM nodes; no model HTML is interpreted.
  function render(out, result, question) {
    var card = panel(out, question);
    var status = result.status;
    var leftOut = Array.isArray(result.left_out) ? result.left_out : [];
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
      var meta = el('div', 'pameta');
      var citations = Array.isArray(result.citations) ? result.citations : [];
      if (citations.length > 0) {
        meta.appendChild(el('div', 'palabel', config.copy.sources));
        var list = el('ol', 'pasrc');
        citations.forEach(function (citation) {
          var item = el('li');
          var label = [citation.title, citation.source, citation.date].filter(function (part) { return typeof part === 'string' && part !== ''; }).join(' · ');
          if (typeof citation.url === 'string' && /^https:\\/\\//.test(citation.url)) {
            var link = el('a', '', label || citation.url);
            link.href = citation.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            item.appendChild(link);
          } else {
            item.appendChild(document.createTextNode(label));
          }
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
  var ask = root.querySelector('form[data-pa-ask]');
  if (ask) {
    ask.addEventListener('submit', async function (event) {
      event.preventDefault();
      var field = ask.querySelector('textarea[name="question"]');
      var out = ask.querySelector('[data-pa-out]');
      var button = ask.querySelector('button[type="submit"]');
      var question = field ? String(field.value || '').trim() : '';
      if (!question || !out) return;
      if (button) button.disabled = true;
      message(out, config.copy.answering, false, question);
      var outcome = await send({ action: 'ask', question: question });
      if (button) button.disabled = false;
      if (!outcome.ok) { message(out, errorText(outcome), true, question); return; }
      render(out, outcome.result, question);
    });
  }
  root.querySelectorAll('[data-pa-question]').forEach(function (row) {
    var id = row.getAttribute('data-pa-question');
    var question = row.querySelector('.paq').textContent;
    var out = row.querySelector('[data-pa-out]');
    var actions = row.querySelector('.sact');
    var answer = row.querySelector('[data-pa-answer]');
    var dismiss = row.querySelector('[data-pa-dismiss]');
    function busy(on) {
      if (answer) answer.disabled = on;
      if (dismiss) dismiss.disabled = on;
    }
    if (answer) answer.addEventListener('click', async function () {
      busy(true);
      message(out, config.copy.answering, false, question);
      var outcome = await send({ action: 'answer', id: id });
      if (!outcome.ok) {
        message(out, errorText(outcome), true, question);
        if (outcome.status === 410 && actions) actions.remove(); else busy(false);
        return;
      }
      render(out, outcome.result, question);
      if (outcome.result.status === 'answered') row.classList.add('answered');
      // The answer is on screen: only now may the question be cleared.
      if (typeof outcome.result.ack === 'string') {
        var seen = await send({ action: 'seen', ack: outcome.result.ack });
        if (seen.ok && seen.result.status === 'cleared' && actions) { actions.remove(); return; }
      }
      busy(false);
    });
    if (dismiss) dismiss.addEventListener('click', async function () {
      busy(true);
      var outcome = await send({ action: 'dismiss', id: id });
      if (!outcome.ok) { message(out, errorText(outcome), true, question); busy(false); return; }
      row.remove();
    });
  });
  var all = root.querySelector('[data-pa-dismiss-all]');
  if (all) all.addEventListener('click', async function () {
    if (!window.confirm(config.copy.dismissAllConfirm)) return;
    all.disabled = true;
    var outcome = await send({ action: 'dismiss_all' });
    if (outcome.ok) { window.location.reload(); return; }
    all.disabled = false;
  });
})();`;
}
