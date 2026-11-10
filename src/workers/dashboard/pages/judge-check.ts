/**
 * "Check how Olympus labelled your items" (issue #887; mockups release-1.5/l3/v2
 * L3-4, L3-5): an optional card at the top of Privacy › Your items (moved from
 * Private questions' Inbox, owner 2026-11-10: the Inbox holds answers only). One item at a time,
 * the owner answers Personal, Private or Not sure; the judge's label shows
 * only afterwards. The round and its answers live on this computer
 * (classification/judge-check.ts), behind `/dashboard/privacy/judge-check`,
 * which only a session minted here reaches.
 */
import { escapeScriptJson } from '../components.ts';
import { sourceLogoTilesByProvider } from '../source-logos.ts';
import { DASHBOARD_JUDGE_CHECK_COPY as J } from '../vocabulary.ts';

export const DASHBOARD_JUDGE_CHECK_PATH = '/dashboard/privacy/judge-check';

/** Fired (bubbling) from the card when an answer set an item, so the Your items list below reloads. */
export const JUDGE_CHECK_ITEMS_CHANGED_EVENT = 'olympus-judge-check-items-changed';

/** Where the card goes: the top of Your items. Empty until the script reads the round. */
export const JUDGE_CHECK_MOUNT = '<div class="jc" data-judge-check aria-live="polite"></div>';

export const JUDGE_CHECK_CSS = `
.jc:empty { display: none; }
.jc { margin: 0 0 14px; }
.jc .jccard { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; min-width: 0; }
.jc .jchead { display: flex; align-items: flex-start; gap: 12px; }
.jc .jchead > div { flex: 1; min-width: 0; }
.jc .jctitle { font-size: var(--fs-row); color: var(--t1); }
.jc .jcopt { color: var(--t3); }
.jc .jcintro { margin: 4px 0 0; color: var(--t2); font-size: var(--fs-body); }
.jc .jcx { flex: none; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; color: var(--t3); font-size: 18px; border: 0; background: none; cursor: pointer; }
.jc .jcx:focus-visible { outline: 2px solid var(--link); }
.jc .jcline { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.jc .jcline p { flex: 1; min-width: 12em; margin: 0; color: var(--t2); font-size: var(--fs-body); }
.jc .jcitem { margin-top: 14px; padding: 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel2); min-width: 0; }
.jc .jcpos { color: var(--t3); font-size: 13px; }
.jc .jcwho { display: flex; gap: 12px; align-items: center; margin-top: 8px; min-width: 0; }
.jc .jcwho > span:last-child { min-width: 0; }
.jc .jcname { display: block; color: var(--t1); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jc .jcmeta { display: block; color: var(--t3); font-size: var(--fs-body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jc .jcprev { margin-top: 10px; background: var(--bg); border: 1px solid var(--line2); border-radius: 8px; padding: 11px 13px; color: var(--t2); font-size: var(--fs-body); line-height: 1.5; overflow-wrap: anywhere; white-space: pre-wrap; max-height: 12em; overflow: auto; }
.jc .jcq { margin: 12px 0 0; color: var(--t1); font-weight: 600; }
.jc .jcthree { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.jc .jcthree .btn { padding: 9px 8px; text-align: center; white-space: normal; }
.jc .jcthree small { display: block; color: var(--t3); font-weight: 400; font-size: 12.5px; margin-top: 2px; }
.jc .jchidden { margin: 10px 0 0; color: var(--t3); font-size: 13px; }
.jc .jcdone { display: flex; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line2); color: var(--t2); font-size: var(--fs-body); min-width: 0; flex-wrap: wrap; }
.jc .jcdone .grow { flex: 1; min-width: 8em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jc .jcverdict { color: var(--t3); }
.jc .jcsofar { display: flex; gap: 12px; align-items: center; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line2); flex-wrap: wrap; }
.jc .jcsofar p { flex: 1; min-width: 12em; margin: 0; color: var(--t2); font-size: var(--fs-body); }
.jc .jcsofar b, .jc .jcrange b { color: var(--t1); }
.jc .jcresult { margin: 10px 0 0; font-size: 20px; font-weight: 600; color: var(--t1); }
.jc .jcrange { margin: 6px 0 0; color: var(--t2); }
.jc .jcscale { position: relative; height: 8px; border-radius: 4px; background: var(--panel2); border: 1px solid var(--line2); margin: 14px 0 4px; }
.jc .jcscale > i { position: absolute; top: -1px; bottom: -1px; border-radius: 4px; background: color-mix(in srgb, var(--link) 55%, transparent); border: 1px solid var(--link); }
.jc .jcscale > s { position: absolute; top: -5px; width: 2px; height: 18px; background: var(--t1); }
.jc .jcticks { display: flex; justify-content: space-between; color: var(--t4); font-size: 12px; }
.jc .jchonest { margin: 14px 0 0; color: var(--t2); font-size: var(--fs-body); }
.jc .jcsum { color: var(--t3); }
.jc .jcsum a { color: var(--link); }
.jc .jcnext { display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
.jc .jcmsg { margin: 10px 0 0; color: var(--bad); font-size: var(--fs-body); }
.jc .jcmsg:empty { display: none; }
.jc .pipill { display: inline-flex; align-items: center; padding: 2px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.jc .pipill.Personal { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
.jc .pipill.Private { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.jc .logotile.sm { width: 28px; height: 28px; border-radius: 7px; }
.jc .logotile.sm svg { width: 17px; height: 17px; }
@media (max-width: 719px) { .jc .jcthree small { display: none; } }
`;

/** The card's controller. Reads the round, then redraws from each answer the route sends back. */
export function judgeCheckClientScript(input: { csrfToken: string; itemsHref: string }): string {
  const config = {
    csrfToken: input.csrfToken,
    path: DASHBOARD_JUDGE_CHECK_PATH,
    changedEvent: JUDGE_CHECK_ITEMS_CHANGED_EVENT,
    itemsHref: input.itemsHref,
    logos: sourceLogoTilesByProvider(),
    copy: J,
  };
  return `(function () {
  var config = ${escapeScriptJson(JSON.stringify(config))};
  var J = config.copy;
  var mount = document.querySelector('[data-judge-check]');
  if (!mount) return;
  var round = null;
  var message = '';
  function fill(template, values) { return String(template).replace(/\\{(\\w+)\\}/g, function (m, key) { return values[key] === undefined ? m : values[key]; }); }
  function esc(value) { return String(value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function logo(item, small) {
    var tile = config.logos[item.source] || '<span class="logotile letter" aria-hidden="true"><span class="logoletter" style="background:#5b5bd6">' + esc((item.source || '?').charAt(0).toUpperCase()) + '</span></span>';
    return small ? tile.replace('class="logotile', 'class="logotile sm') : tile;
  }
  function pill(tier) { return '<span class="pipill ' + esc(tier) + '">' + esc(tier) + '</span>'; }
  function title(item) { return item.title || (item.location ? String(item.location).split('/').pop() : '') || item.sender || ''; }
  function pct(value) { return Math.round(value * 100); }

  async function send(body) {
    var response;
    try {
      response = await fetch(config.path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-Olympus-CSRF': config.csrfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) { message = J.unreachable; render(); return; }
    var result = {};
    try { result = (await response.json()) || {}; } catch (error) { result = {}; }
    if (response.ok && result.ok === true && result.round) {
      var setBefore = round ? round.changed : 0;
      round = result.round; message = '';
      // An answer set an item: the list below shows it as changed by the owner.
      if (round.changed > setBefore) {
        var changedEvent = document.createEvent('Event');
        changedEvent.initEvent(config.changedEvent, true, false);
        mount.dispatchEvent(changedEvent);
      }
    }
    else message = (result.error && result.error.message) || J.failed;
    render();
  }

  function answeredRow(item) {
    var you = item.answer === 'not_sure' ? '' : '<span>' + esc(J.you) + ' ' + pill(item.answer) + '</span>';
    var verdict = item.answer === 'not_sure' ? fill(J.notSureRow, { judge: item.judge })
      : item.answer === item.judge ? J.agreed : fill(item.not_applied ? J.notApplied : J.changed, { judge: item.judge });
    return '<div class="jcdone" data-jc-answered="' + esc(item.item_id) + '">' + logo(item, true) + '<span class="grow">' + esc(title(item)) + '</span>' + you + '<span class="jcverdict">' + esc(verdict) + '</span></div>';
  }

  function head(state) {
    return '<div class="jchead" data-jc-head><div><b class="jctitle">' + esc(J.title) + '</b> <span class="jcopt">· ' + esc(state) + '</span>'
      + (round && round.state === 'active' ? '<p class="jcintro">' + esc(fill(J.intro, { total: round.total })) + '</p>' : '') + '</div>'
      + '<button type="button" class="jcx" data-jc-act="put_away" aria-label="' + esc(J.putAway) + '">✕</button></div>';
  }

  function render() {
    var msg = '<p class="jcmsg" data-jc-msg role="status">' + esc(message) + '</p>';
    if (!round) { mount.innerHTML = message ? '<div class="jccard">' + msg + '</div>' : ''; return; }
    var html = '';
    if (round.put_away || round.state === 'none') {
      var paused = round.state === 'active';
      html = '<div class="jccard jcline" data-jc-offer><p><b class="jctitle">' + esc(J.title) + '</b> <span class="jcopt">· ' + esc(J.optional) + '</span> · '
        + esc(paused ? fill(J.paused, { answered: round.answered.length, total: round.total }) : J.offer) + '</p>'
        + '<button type="button" class="btn" data-jc-act="' + (paused ? 'resume' : 'start') + '">' + esc(paused ? J.resume : J.start) + '</button></div>';
      mount.innerHTML = html + (message ? '<div class="jccard">' + msg + '</div>' : '');
      return;
    }
    if (round.total === 0) {
      mount.innerHTML = '<div class="jccard">' + head(J.optional) + '<p class="jcintro" data-jc-nothing>' + esc(J.nothing) + '</p>' + msg + '</div>';
      return;
    }
    if (round.state === 'active') {
      var item = round.current;
      var group = item.sender ? fill(J.hiddenGroup, { sender: item.sender }) : J.hiddenGroupNoSender;
      html = '<div class="jccard" data-jc-round>' + head(J.optional)
        + '<div class="jcitem" data-jc-item="' + esc(item.item_id) + '"><span class="jcpos" data-jc-position>' + esc(fill(J.position, { position: round.position, total: round.total })) + '</span>'
        + '<div class="jcwho">' + logo(item) + '<span><span class="jcname">' + esc(title(item)) + '</span><span class="jcmeta">' + esc(item.sender && title(item) !== item.sender ? item.sender : '') + '</span></span></div>'
        + (item.preview ? '<div class="jcprev" data-jc-preview>' + esc(item.preview) + '</div>' : '')
        + '<p class="jcq">' + esc(J.question) + '</p>'
        + '<div class="jcthree" data-jc-answers>'
        + '<button type="button" class="btn" data-jc-answer="Personal">' + esc(J.personal) + '<small>' + esc(J.personalHint) + '</small></button>'
        + '<button type="button" class="btn" data-jc-answer="Private">' + esc(J.private) + '<small>' + esc(J.privateHint) + '</small></button>'
        + '<button type="button" class="btn" data-jc-answer="not_sure">' + esc(J.notSure) + '<small>' + esc(J.notSureHint) + '</small></button></div>'
        + '<p class="jchidden">' + esc(fill(J.hidden, { group: group })) + '</p></div>'
        + (round.answered.length ? '<div data-jc-answered-list style="margin-top:12px">' + round.answered.map(answeredRow).join('') + '</div>' : '')
        + '<div class="jcsofar"><p data-jc-sofar>' + (round.compared ? fill(esc(J.soFar), { agreed: '<b>' + round.agreed, compared: round.compared + '</b>' }) + ' ' + esc(J.tooFew) : '') + '</p>'
        + '<button type="button" class="btn" data-jc-act="put_away">' + esc(J.stop) + '</button></div>' + msg + '</div>';
      mount.innerHTML = html;
      return;
    }
    var result = round.compared ? esc(fill(J.result, { agreed: round.agreed, compared: round.compared })) : esc(J.resultNone);
    var range = '';
    var mix = round.compared ? esc(J.roundMix) + ' ' : '';
    if (!round.range && round.random) {
      range = '<p class="jcrange" data-jc-need>' + mix + esc(fill(J.needMore, { needed: round.random.needed, compared: round.random.compared, perRound: round.random.per_round })) + '</p>';
    }
    if (round.range) {
      var low = pct(round.range.low), high = pct(round.range.high), mark = pct(round.range.agreed / round.range.from);
      range = '<p class="jcrange">' + fill(esc(J.rangeLine), { compared: round.range.from, low: '<b>' + low, high: high + '%</b>' }).replace('%</b>%', '%</b>') + '</p>'
        + '<div data-jc-range role="img" aria-label="' + esc(fill(J.rangeLabel, { low: low, high: high })) + '"><div class="jcscale"><i style="left:' + low + '%;width:' + (high - low) + '%"></i><s style="left:' + mark + '%"></s></div>'
        + '<div class="jcticks"><span>0%</span><span>50%</span><span>100%</span></div></div>';
    }
    var changed = round.answered.filter(function (answered) { return answered.changed; });
    var shownRows = round.answered.filter(function (answered) { return answered.changed || answered.not_applied; });
    var confirmed = round.answered.filter(function (answered) { return answered.answer === answered.judge; }).length;
    html = '<div class="jccard" data-jc-result>' + head(J.roundDone)
      + '<p class="jcresult" data-jc-count>' + result + '</p>' + range
      + '<p class="jchonest">' + (round.range ? mix + esc(J.honest) : esc(J.fixesOnly)) + '</p>'
      + '<div style="margin-top:12px" data-jc-fixed>' + shownRows.map(answeredRow).join('')
      + '<div class="jcdone jcsum"><span class="grow">' + esc(fill(J.summary, { changed: changed.length, confirmed: confirmed, notSure: round.not_sure })) + '</span><a href="' + esc(config.itemsHref) + '">' + esc(J.seeThem) + '</a></div></div>'
      + '<div class="jcnext"><button type="button" class="btn" data-jc-act="put_away">' + esc(J.done) + '</button><button type="button" class="btn primary" data-jc-act="start">' + esc(J.more) + '</button></div>' + msg + '</div>';
    mount.innerHTML = html;
  }

  mount.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    var answer = target.closest('[data-jc-answer]');
    if (answer && round && round.current) {
      var buttons = mount.querySelectorAll('[data-jc-answer]');
      for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
      send({ action: 'answer', item_id: round.current.item_id, answer: answer.getAttribute('data-jc-answer') });
      return;
    }
    var act = target.closest('[data-jc-act]');
    if (act) send({ action: act.getAttribute('data-jc-act') });
  });
  send({ action: 'status' });
})();`;
}
