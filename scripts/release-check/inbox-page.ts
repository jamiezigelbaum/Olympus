/**
 * What the release check reads off the dashboard's Private answers page (the Ask page and the Inbox), as the page itself shows it.
 *
 * These are page scripts for the in-machine agent to evaluate in the owner's browser: plain strings, because the harness has no DOM
 * types. They only read the page or call the page's own route the way its own script does (same origin, the session's cookie and
 * CSRF token). They are tested against the product's own rendered page in a DOM (test/release-check-inbox.test.ts), so a change
 * to the page's markup that the check no longer understands fails there first.
 *
 * Private text stays in the machine: callers compare an answer with the expected facts in place and send out booleans and counts.
 */

/** The route the page posts to. A test holds it equal to the product's own constant. */
export const PRIVATE_ANSWERS_POST_PATH = '/dashboard/private-answers';

/** The page's visible state as JSON: where it is, whether it is locked, the three destination cards, the Inbox rows. */
export const PAGE_STATE = String.raw`(() => {
  const clean = (node) => (node && node.textContent ? node.textContent.replace(/\s+/g, ' ').trim() : '');
  const cards = {};
  document.querySelectorAll('[data-pa-card]').forEach((card) => {
    const key = card.getAttribute('data-pa-card');
    const state = card.getAttribute('data-pa-state');
    const action = card.querySelector('.paaction');
    const control = action ? action.querySelector('button, a') : null;
    cards[key] = {
      state,
      status: clean(card.querySelector('[data-pa-status="' + state + '"]')),
      reason: clean(action ? action.querySelector('.pareason') : null),
      control: control ? {
        tag: control.tagName.toLowerCase(),
        text: clean(control),
        href: control.getAttribute('href'),
        action: control.getAttribute('data-pa-action'),
        submit: control.tagName === 'BUTTON' && (control.getAttribute('type') || 'submit') === 'submit',
        disabled: control.disabled === true,
      } : null,
    };
  });
  const rows = Array.from(document.querySelectorAll('[data-pa-question]')).map((row) => ({
    id: row.getAttribute('data-pa-question'),
    question: clean(row.querySelector('.paq')),
    from: clean(row.querySelector('.pafrom')),
    unread: row.classList.contains('unread'),
  }));
  return JSON.stringify({
    where: location.pathname + location.search + location.hash,
    title: document.title,
    page: !!document.querySelector('[data-private-answers]'),
    unlock: !!document.querySelector('form[data-pa-unlock]'),
    locked: !!document.querySelector('[data-pa-locked]'),
    unavailable: !!document.querySelector('[data-pa-unavailable]'),
    ask: !!document.querySelector('form[data-pa-ask]'),
    cards,
    rows,
  });
})()`;

/** Whether the page's own script has finished loading with the controls (a local session): the Ask form and the Inbox list. */
export const PAGE_UNLOCKED = String.raw`(() => !!document.querySelector('[data-private-answers] form[data-pa-ask]') && !!document.querySelector('[data-private-answers] [data-pa-list]'))()`;

/** The Unlock form is offered (a launch session reads nothing until the owner unlocks). */
export const PAGE_UNLOCK_OFFERED = String.raw`(() => !!document.querySelector('[data-private-answers] form[data-pa-unlock] button'))()`;

/**
 * A call to the page's route, as the page's own script makes it. Returns JSON { status, body }. The CSRF token is the one the page
 * itself holds in its script; nothing else authorizes the call.
 */
export function pageApi(body: unknown): string {
  return String.raw`(async () => {
    const source = Array.from(document.scripts).map((script) => script.textContent || '').join('\n');
    const csrf = (/"csrfToken":"([^"]+)"/.exec(source) || [])[1];
    if (!csrf) return JSON.stringify({ status: 0, body: null });
    let response;
    try {
      response = await fetch(${JSON.stringify(PRIVATE_ANSWERS_POST_PATH)}, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-Olympus-CSRF': csrf, 'Content-Type': 'application/json' },
        body: ${JSON.stringify(JSON.stringify(body))},
      });
    } catch (error) { return JSON.stringify({ status: 0, body: null }); }
    let parsed = null;
    try { parsed = await response.json(); } catch (error) { parsed = null; }
    return JSON.stringify({ status: response.status, body: parsed });
  })()`;
}

/**
 * One Inbox row as it is on screen: whether it is there, and its opened answer and sources. The answer text is returned to the
 * agent only to be compared in place.
 */
export function rowView(id: string): string {
  return String.raw`(() => {
    const clean = (node) => (node && node.textContent ? node.textContent.replace(/\s+/g, ' ').trim() : '');
    const row = Array.from(document.querySelectorAll('[data-pa-question]')).find((node) => node.getAttribute('data-pa-question') === ${JSON.stringify(id)});
    if (!row) return JSON.stringify({ found: false });
    const out = row.querySelector('[data-pa-out]');
    const answer = out ? out.querySelector('.paanswer') : null;
    const sources = out ? Array.from(out.querySelectorAll('.pasrc li')).map((item) => clean(item)) : [];
    return JSON.stringify({ found: true, opened: !!answer, answer: clean(answer), sources, message: clean(out ? out.querySelector('.pamsg') : null) });
  })()`;
}

/** The Ask form's panel: the answer under the question just asked, its sources, or the message that stands in for it. */
export const ASK_VIEW = String.raw`(() => {
  const clean = (node) => (node && node.textContent ? node.textContent.replace(/\s+/g, ' ').trim() : '');
  const out = document.querySelector('form[data-pa-ask] [data-pa-out]');
  if (!out) return JSON.stringify({ found: false });
  const answer = out.querySelector('.paanswer');
  const message = out.querySelector('.pamsg');
  return JSON.stringify({
    found: true,
    answer: clean(answer),
    sources: Array.from(out.querySelectorAll('.pasrc li')).map((item) => clean(item)),
    message: clean(message),
    error: !!(message && message.getAttribute('data-state') === 'error'),
    busy: !!document.querySelector('form[data-pa-ask] [aria-busy="true"]'),
  });
})()`;

/** Puts the textarea in view and focuses it, ready for the question to be typed. */
export const FOCUS_QUESTION = String.raw`(() => {
  const field = document.querySelector('form[data-pa-ask] textarea[name="question"]');
  if (!field || field.disabled) return false;
  field.scrollIntoView({ block: 'center' });
  field.focus();
  field.value = '';
  return document.activeElement === field;
})()`;

/** The centre of an element in the viewport after scrolling it into view, for a real click. */
export function centerOf(selector: string): string {
  return String.raw`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    node.scrollIntoView({ block: 'center' });
    const box = node.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), w: Math.round(box.width), h: Math.round(box.height) });
  })()`;
}

/** The sources a card's link points to, resolved on the Models page it leads to. */
export function anchorPresent(id: string): string {
  return String.raw`(() => { const node = document.getElementById(${JSON.stringify(id)}); return !!node && node.getBoundingClientRect().height > 0; })()`;
}

/** The facts compared in place: every expected fact, ignoring case and spacing, appears in the answer. */
export function factsIn(answer: string, facts: readonly string[]): boolean[] {
  const flat = answer.toLowerCase().replace(/\s+/g, ' ');
  return facts.map((fact) => flat.includes(fact.toLowerCase().replace(/\s+/g, ' ')));
}

/** Whether any source line names the expected Private item. */
export function sourceNames(sources: readonly string[], title: string): boolean {
  const wanted = title.toLowerCase();
  return sources.some((line) => line.toLowerCase().includes(wanted));
}
