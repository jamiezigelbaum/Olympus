/**
 * Bounded exploration of the dashboard's other pages (release-testing design, layer 3, beyond the Sources section): the computer's own
 * pages, Keys (which holds the model setup), Agents, the Inbox of private answers, and Build a connector.
 *
 * Each page is a server-rendered document in the owner's signed-in browser. The crawl lists the page's controls (buttons, links,
 * summaries, fields), then presses each one by itself from a freshly loaded page and judges the press by the generic rules plus the
 * control's own expected outcome where one is cheap to state:
 *
 *  - a control that opens or closes something must change what the page shows (a sheet, a summary);
 *  - a form with a required field that is empty must say so and send nothing;
 *  - Get pairing code and Create key must show the code or key they made;
 *  - Revoke asks first (the page's own confirmation), Cancel leaves the connection, OK removes it;
 *  - Lock leaves the page without its Lock control.
 *
 * Rules that block: an unexpected console error or failed request, `undefined`/`NaN`/an empty name, a disabled control that does not
 * say why, sideways overflow, a window opened to a page that is not Olympus's own, a press that leaves for a page that is not the
 * dashboard's, a press that does nothing. A link to another site is validated, not followed (the destination must be https and open
 * with no opener); a control whose press would reach outside the throwaway machine (public certificate issuance, a sign-in at a real
 * provider, a question sent to a model) is listed with the reason it is not pressed. Destructive controls are pressed here only
 * because this is the throwaway install, and last.
 *
 * Coverage is reported against the list taken from the page templates (explore-pages-inventory.ts): found, pressed, missed. It is
 * advisory; the rules are blocking.
 */
import type { PageControlEntry, PageInventory } from './explore-pages-inventory.ts';
import type { ElementInfo, JourneyDriver, JourneyTrace, StepTrace } from './journey.ts';
import type { CheckResult } from './report.ts';

export interface PageDef { id: string; title: string; path: string }

export const PAGES: readonly PageDef[] = [
  { id: 'keys', title: 'Keys and model setup', path: '/dashboard?keys' },
  { id: 'agents', title: 'Agents', path: '/dashboard?agents' },
  { id: 'inbox', title: 'Inbox', path: '/dashboard?private-answers' },
  { id: 'connector', title: 'Build a connector', path: '/dashboard?connector' },
];

export interface PageControl {
  n: number;
  sig: string;
  tag: string;
  type: string;
  name: string;
  text: string;
  href: string | null;
  target: string | null;
  rel: string | null;
  disabled: boolean;
  reason: string;
  visible: boolean;
  /** `data-*` attribute names on the control and its form. */
  attrs: string[];
  /** The form's own kind attribute and value, as `data-agent-kind=pair`. */
  formKind: string;
  expanded: string | null;
  copy: boolean;
  field: boolean;
  /** A form's submit with a required field empty. */
  invalid: boolean;
  /** The form asks before it acts (its own confirmation). */
  confirms: boolean;
}

export interface PageObservation {
  url: string;
  text: string;
  expanded: string;
  open: string;
  secret: number;
  statuses: string;
  confirms: string[];
}

export interface PagesOptions {
  driver: JourneyDriver;
  pages?: readonly PageDef[];
  inventory: PageInventory;
  /** Extra page-level findings (the accessibility audit), judged with the seeded page. */
  audit?: (driver: JourneyDriver, page: PageDef) => Promise<string[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The time (epoch ms) after which no new page or press is started. */
  deadlineAt?: number;
  /** The most presses one page may take. */
  maxPresses?: number;
  settleMs?: number;
}

export interface PageSummary { id: string; title: string; path: string; found: number; pressed: number; validated: number; skipped: number; failed: number; presses: number; error?: string }
export interface PageCoverageEntry { id: string; label: string; file: string; status: 'pressed' | 'found' | 'missed'; detail: string; pages: string[] }
export interface PagesResult {
  pages: PageSummary[];
  traces: JourneyTrace[];
  coverage: { entries: PageCoverageEntry[]; listed: number; found: number; pressed: number; missed: number; unmatchable: number };
  presses: number;
}

const ALWAYS_ALLOWED_REQUESTS: RegExp[] = [/\/favicon\.ico(\?|$)/];
const ALWAYS_ALLOWED_CONSOLE: RegExp[] = [/favicon/i];
const OWN_HOSTS = /^https:\/\/(www\.)?olympusplugin\.ai\//;
const DASHBOARD_PATH = /^\/dashboard(\/|\?|#|$)/;
/** The kinds of copy that need the clipboard: a headless browser may refuse it, and the page says nothing then. */
const CLIPBOARD_REFUSAL = /clipboard|permission|NotAllowed/i;

/** Controls whose press would reach outside the throwaway machine, with why they are not pressed. */
const NOT_PRESSED: Array<{ test: (control: PageControl) => boolean; reason: string }> = [
  { test: (c) => /^(Turn on remote access|Review agreement|I accept, turn on remote access)$/i.test(c.name) || /agent-kind=remote-(on|accept)/.test(c.formKind), reason: 'it starts a public address and a certificate from a public authority; not on a throwaway machine' },
  { test: (c) => /data-connect-kind=oauth/.test(c.formKind), reason: 'it starts a sign-in at a real provider' },
  { test: (c) => /data-pa-destination/.test(c.attrs.join(' ')), reason: 'it sends a question to a model' },
];

/** The longest one press (load, press, settle, judge) may take: a page that hangs fails that press, it does not take the run with it. */
const ITEM_BOUND_MS = 60_000;
async function withBound<T>(work: () => Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
const sleepFor = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------
// The page-side scripts

const ENUMERATE = String.raw`(() => {
  const clean = __rc.clean;
  const vis = (el) => { const b = el.getBoundingClientRect(); if (!b.width || !b.height) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const nameOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    if (clean(aria)) return clean(aria);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit') return clean(el.value);
      const labels = el.labels ? Array.from(el.labels).map((l) => l.textContent).join(' ') : '';
      return clean(labels) || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title'));
    }
    return clean(el.textContent) || clean(el.getAttribute('title'));
  };
  const seen = {};
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll('button, a[href], summary, input:not([type="hidden"]), select, textarea, [role="button"]')) {
    n += 1;
    el.setAttribute('data-rc-n', String(n));
    const tag = el.tagName.toLowerCase();
    const type = clean(el.getAttribute('type'));
    const name = nameOf(el);
    const href = el.getAttribute('href');
    const base = tag + '|' + type + '|' + name + '|' + (href || '');
    seen[base] = (seen[base] || 0) + 1;
    const form = el.closest('form');
    const attrs = Array.from(el.getAttributeNames()).filter((a) => a.startsWith('data-') && a !== 'data-rc-n');
    let formKind = '';
    if (form) {
      for (const a of form.getAttributeNames()) {
        if (a.startsWith('data-')) { attrs.push(a); if (/-kind$/.test(a) && !formKind) formKind = a + '=' + form.getAttribute(a); }
      }
    }
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    const parent = el.parentElement;
    // What says why a control is off: its title, what it points to, or the words beside it in a wrapper of its own.
    const solo = parent && parent.querySelectorAll('button, a, input, select, textarea, summary').length === 1;
    const describedBy = el.getAttribute('aria-describedby');
    const described = describedBy ? describedBy.split(/\s+/).map((id) => { const t = document.getElementById(id); return t ? t.textContent : ''; }).join(' ') : '';
    // Words beside the control (the paragraph just before or after it, or its wrapper) that carry no control of their own also say why.
    const near = (node) => {
      if (!node || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return '';
      if (node.querySelector && node.querySelector('button, a, input, select, textarea, summary')) return '';
      const text = clean(node.textContent);
      return text.length > 0 && text.length <= 240 ? text : '';
    };
    const beside = disabled ? (() => { let words = ''; let node = el; for (let depth = 0; node && depth < 3 && node !== document.body; depth++, node = node.parentElement) words += ' ' + near(node.previousElementSibling) + ' ' + near(node.nextElementSibling); return words; })() : '';
    const reason = disabled ? clean(beside + ' ' + (solo ? (parent.textContent || '').replace(el.textContent || '', '') : '') + ' ' + described + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-description') || '')) : '';
    const field = tag === 'input' || tag === 'textarea' || tag === 'select';
    const submit = (tag === 'button' && (el.getAttribute('type') || 'submit') === 'submit') || (tag === 'input' && type === 'submit');
    out.push({
      n, sig: base + '#' + seen[base], tag, type, name, text: clean(el.textContent).slice(0, 120),
      href, target: el.getAttribute('target'), rel: el.getAttribute('rel'), disabled, reason: reason.slice(0, 200),
      visible: vis(el), attrs, formKind, expanded: el.getAttribute('aria-expanded'),
      copy: el.hasAttribute('data-copy-target'), field,
      invalid: !!(submit && form && typeof form.checkValidity === 'function' && !form.checkValidity()),
      confirms: !!(form && form.hasAttribute('data-confirmation')),
    });
  }
  return out;
})()`;

const OBSERVE = String.raw`(() => {
  const clean = __rc.clean;
  return {
    url: location.pathname + location.search + location.hash,
    text: clean(document.body ? document.body.innerText : ''),
    expanded: Array.from(document.querySelectorAll('[aria-expanded]')).map((e) => e.getAttribute('aria-expanded')).join(','),
    open: Array.from(document.querySelectorAll('details')).map((d) => (d.open ? 1 : 0)).join(''),
    secret: Array.from(document.querySelectorAll('[data-agent-secret]')).filter((e) => e.value).length,
    statuses: Array.from(document.querySelectorAll('[role="status"]')).map((e) => clean(e.textContent)).filter(Boolean).join(' | ').slice(0, 300),
    confirms: (() => { try { return JSON.parse(sessionStorage.getItem('__rcConfirms') || '[]'); } catch (error) { return window.__rcConfirms ? window.__rcConfirms.slice() : []; } })(),
  };
})()`;

const HOOK_CONFIRM = (answer: boolean): string => `(() => {
  if (!window.__rcConfirms) {
    window.__rcConfirms = [];
    window.confirm = function (text) {
      const line = String(text == null ? '' : text).slice(0, 200);
      window.__rcConfirms.push(line);
      try { const kept = JSON.parse(sessionStorage.getItem('__rcConfirms') || '[]'); kept.push(line); sessionStorage.setItem('__rcConfirms', JSON.stringify(kept)); } catch (error) { /* no storage */ }
      return window.__rcAnswer !== false;
    };
  }
  window.__rcAnswer = ${answer ? 'true' : 'false'};
  return true;
})()`;

// ---------------------------------------------------------------------------
// Matching the page's controls to the source-derived list

const wordsIn = (label: string, name: string): boolean => {
  const hay = name.toLowerCase();
  let at = 0;
  for (const word of label.toLowerCase().split(/\s+/).filter(Boolean)) {
    const found = hay.indexOf(word, at);
    if (found < 0) return false;
    at = found + word.length;
  }
  return true;
};

export function matches(entry: PageControlEntry, control: PageControl): boolean {
  if (entry.attr && control.attrs.includes(entry.attr)) return true;
  if (!entry.label) return false;
  if (entry.tag === 'input' || entry.tag === 'textarea' || entry.tag === 'select') return control.field && (wordsIn(entry.label, control.name) || control.attrs.some((a) => a === `data-${entry.label}`));
  const sameTag = entry.tag === 'a' ? control.tag === 'a' : entry.tag === 'summary' ? control.tag === 'summary' : control.tag === 'button';
  return sameTag && wordsIn(entry.label, control.name || control.text);
}

// ---------------------------------------------------------------------------
// The crawl

/** `rank` orders the presses: 0 first, 1 for the ones that cannot be undone, 2 for Lock, which ends the session. */
interface Item { path: string[]; answer?: boolean; rank: 0 | 1 | 2 }

interface Judged { ok: boolean; findings: string[]; expected: string; actual: string }

export async function explorePages(options: PagesOptions): Promise<PagesResult> {
  const { driver } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const settleMs = options.settleMs ?? 10_000;
  const maxPresses = options.maxPresses ?? 60;
  const summaries: PageSummary[] = [];
  const traces: JourneyTrace[] = [];
  const entryState = new Map<string, { pressed: boolean; pages: Set<string> }>();
  let totalPresses = 0;

  const read = async <T>(call: string): Promise<T | undefined> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await Promise.race([driver.probe('host', call) as Promise<T>, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the page did not answer')), 15_000))]); } catch { await sleep(400); }
    }
    return undefined;
  };
  const enumerate = async (): Promise<PageControl[]> => {
    const got = await read<PageControl[]>(ENUMERATE);
    return Array.isArray(got) ? got : [];
  };
  const observe = async (): Promise<PageObservation | undefined> => await read<PageObservation>(OBSERVE);

  const settle = async (): Promise<void> => {
    const until = now() + settleMs;
    let last = '';
    let stable = 0;
    await sleep(500);
    for (;;) {
      const text = (await read<string>('__rc.visibleText()')) ?? '';
      const busy = await read<boolean>(`!!document.querySelector('[aria-busy="true"]')`);
      stable = squash(text) === last && busy !== true ? stable + 1 : 0;
      last = squash(text);
      if (stable >= 2 || now() >= until) return;
      await sleep(400);
    }
  };

  const loadPage = async (page: PageDef, answer = true): Promise<void> => {
    await driver.go(page.path);
    await settle();
    await read("(() => { try { sessionStorage.removeItem('__rcConfirms'); } catch (error) { /* none */ } return true; })()");
    await read(HOOK_CONFIRM(answer));
    await read('__rc.watchWindows()');
  };

  /** The rules about what a page shows, as it stands. */
  const pageFindings = async (controls: PageControl[]): Promise<string[]> => {
    const findings: string[] = [];
    const audit = await read<{ bad: string[]; emptyButtons: string[]; overflowX: number }>('__rc.audit()');
    for (const text of audit?.bad ?? []) findings.push(`the page shows a placeholder value: "${text}"`);
    for (const control of audit?.emptyButtons ?? []) findings.push(`a button or link has no name: ${control}`);
    if ((audit?.overflowX ?? 0) > 0) findings.push(`the page scrolls sideways (${audit!.overflowX} px too wide)`);
    for (const control of controls) {
      if (control.visible && control.disabled && !control.reason.trim()) findings.push(`"${control.name || control.tag}" is disabled and says nothing about why`);
      if (control.visible && control.field && !control.name) findings.push(`a ${control.tag === 'input' ? 'field' : control.tag} has no name (nothing says what to enter)`);
    }
    return findings;
  };

  const pageList = options.pages ?? PAGES;
  const lastPageId = pageList[pageList.length - 1]?.id;
  for (const [pageIndex, page] of pageList.entries()) {
    // Each page gets an equal share of the time left, so one large page cannot use up the others' turns.
    const pageDeadline = options.deadlineAt === undefined ? undefined : now() + Math.max(0, options.deadlineAt - now()) / (pageList.length - pageIndex);
    const reported = new Set<string>();
    const summary: PageSummary = { id: page.id, title: page.title, path: page.path, found: 0, pressed: 0, validated: 0, skipped: 0, failed: 0, presses: 0 };
    summaries.push(summary);
    const steps: StepTrace[] = [];
    const record = (control: PageControl, pressed: boolean): void => {
      for (const entry of options.inventory.entries) {
        if (!matches(entry, control)) continue;
        const state = entryState.get(entry.id) ?? { pressed: false, pages: new Set<string>() };
        state.pages.add(page.id);
        state.pressed = state.pressed || pressed;
        entryState.set(entry.id, state);
      }
    };
    try {
      await loadPage(page);
      const load = driver.drainEvents();
      const loadRequests = load.requests.filter((request) => !ALWAYS_ALLOWED_REQUESTS.some((rule) => rule.test(request.url)));
      const loadConsole = load.console.filter((message) => !ALWAYS_ALLOWED_CONSOLE.some((rule) => rule.test(message)) && !(/Failed to load resource/.test(message) && load.requests.length > 0));
      const base = await enumerate();
      const baseFindings = [
        ...await pageFindings(base),
        ...(options.audit ? await options.audit(driver, page).catch((error: unknown) => [`the page audit failed to run: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`]) : []),
        ...loadConsole.map((message) => `console error while loading: ${message.slice(0, 200)}`),
        ...loadRequests.map((request) => `failed request while loading: ${request.text} -> ${request.status || 'failed'}`),
      ];
      steps.push({
        n: 1, name: `The ${page.title} page as loaded`, action: `open ${page.path}`,
        expected: 'the page follows the generic rules (names, reasons for disabled controls, no placeholder words, no sideways scroll)',
        actual: baseFindings.length === 0 ? `${base.filter((c) => c.visible).length} control(s) showing` : baseFindings.join('; '),
        ok: baseFindings.length === 0, ms: 0, at: page.path,
        consoleErrors: loadConsole.map((message) => message.slice(0, 300)), failedRequests: loadRequests.map((request) => `${request.text} -> ${request.status || 'failed'}`), findings: baseFindings,
      });
      for (const text of baseFindings) reported.add(text);
      if (baseFindings.length > 0) summary.failed += 1;

      const queue: Item[] = [];
      const queued = new Set<string>();
      const seenSigs = new Set<string>();
      const foundSigs = new Set<string>();
      const enqueue = (item: Item): void => {
        const id = `${item.path.join(' > ')}|${item.answer ?? ''}`;
        if (queued.has(id)) return;
        queued.add(id);
        queue.push(item);
      };
      const consider = (controls: PageControl[], via: string[]): void => {
        for (const control of controls) {
          if (seenSigs.has(`${via.join('>')}|${control.sig}`)) continue;
          seenSigs.add(`${via.join('>')}|${control.sig}`);
          if (!foundSigs.has(control.sig)) { foundSigs.add(control.sig); summary.found += 1; }
          if (!control.visible && via.length === 0 && control.tag !== 'summary') {
            // Inside something closed: reached through what opens it (a sheet's toggle), found but not pressed on its own.
            record(control, false);
            continue;
          }
          if (!control.visible) continue;
          const skip = NOT_PRESSED.find((rule) => rule.test(control));
          if (control.field) { record(control, false); continue; }
          if (skip) { record(control, false); summary.skipped += 1; steps.push(skippedStep(steps.length + 1, control, skip.reason, page)); continue; }
          if (control.tag === 'a' && isExternal(control.href)) { validateLink(control, page, steps, summary, record); continue; }
          const destructive = control.confirms || /^(Lock|Delete( all)?)$/i.test(control.name) || /data-pa-delete/.test(control.attrs.join(' '));
          // Lock ends the browser's session, so it is pressed once, on the last page.
          if (/^Lock$/i.test(control.name) && page.id !== lastPageId) { record(control, false); summary.skipped += 1; steps.push(skippedStep(steps.length + 1, control, 'Lock ends the session for the pages after it; it is pressed once, on the last page', page)); continue; }
          if (control.confirms) {
            enqueue({ path: [...via, control.sig], answer: false, rank: 0 });
            enqueue({ path: [...via, control.sig], answer: true, rank: 1 });
          } else enqueue({ path: [...via, control.sig], rank: /^Lock$/i.test(control.name) ? 2 : destructive ? 1 : 0 });
        }
      };
      consider(base, []);

      let wave = 0;
      while (summary.presses < maxPresses && !(pageDeadline !== undefined && now() >= pageDeadline)) {
        if ((queue.length === 0 || queue.every((entry) => entry.rank === 2)) && wave < 2) {
          // What the earlier presses made (a pairing code leaves a connection to revoke) shows on a fresh page; looked for before Lock ends the session.
          wave += 1;
          await loadPage(page);
          driver.drainEvents();
          const again = (await enumerate()).filter((control) => !seenSigs.has(`|${control.sig}`));
          if (again.length > 0) consider(again, []);
          continue;
        }
        if (queue.length === 0) break;
        queue.sort((a, b) => a.rank - b.rank);
        const item = queue.shift()!;
        const started = now();
        let phase = 'loading the page';
        try {
          await withBound(async () => {
          await loadPage(page, item.answer ?? true);
          phase = 'reaching the control';
          driver.drainEvents();
          let controls = await enumerate();
          let reachable = true;
          for (const sig of item.path.slice(0, -1)) {
            const via = controls.find((candidate) => candidate.sig === sig);
            const info = via ? await driver.click('host', { css: `[data-rc-n="${via.n}"]` }) : null;
            if (!info) { reachable = false; break; }
            await settle();
            controls = await enumerate();
          }
          const finalSig = item.path[item.path.length - 1]!;
          const control = controls.find((candidate) => candidate.sig === finalSig);
          if (!reachable || !control) {
            steps.push(failureStep(steps.length + 1, finalSig, !reachable ? 'a control on its way could not be pressed' : 'it was on the page as loaded but is not there on a fresh page'));
            summary.failed += 1;
            return;
          }
          if (control.disabled) {
            const ok = control.reason.trim() !== '';
            steps.push({ n: steps.length + 1, name: `${control.name || control.tag} (disabled)`, action: `look at "${control.name}"`, expected: 'a disabled control says why', actual: ok ? control.reason : 'it says nothing', ok, ms: now() - started, at: page.path, consoleErrors: [], failedRequests: [], findings: ok ? [] : [`"${control.name}" is disabled and says nothing about why`] });
            if (!ok) summary.failed += 1;
            return;
          }
          phase = 'reading the page before the press';
          const before = (await observe())!;
          const pagesBefore = await driver.pages();
          driver.drainEvents();
          phase = 'pressing it';
          const info = await driver.click('host', { css: `[data-rc-n="${control.n}"]` });
          phase = 'waiting for the page to settle after the press';
          summary.presses += 1;
          summary.pressed += 1;
          totalPresses += 1;
          record(control, true);
          let pagesMax = pagesBefore;
          const settling = (async () => { for (let i = 0; i < 6; i++) { await sleep(250); pagesMax = Math.max(pagesMax, await driver.pages().catch(() => pagesMax)); } })();
          await settle();
          await settling;
          const after = await observe();
          const afterControls = await enumerate();
          const events = driver.drainEvents();
          const opened = ((await read<string[]>('__rc.openedWindows()')) ?? []);
          const pagesAfter = await driver.pages();
          phase = 'judging';
          const judged = judge({ page, control, info, before, after, afterControls, controlsBefore: controls, events, opened, pagesBefore, pagesAfter, pagesMax, answer: item.answer });
          // A rule about the page as it stands is reported once for the page, not on every press after it.
          const extra = (after ? await pageFindings(afterControls).catch(() => []) : []).filter((text) => !reported.has(text));
          for (const text of extra) reported.add(text);
          judged.findings.push(...extra);
          const ok = judged.ok && extra.length === 0;
          if (!ok) summary.failed += 1;
          const trace: StepTrace = {
            n: steps.length + 1,
            name: `${control.name || control.tag}${item.answer === false ? ' (answer Cancel to its question)' : item.answer === true && control.confirms ? ' (answer OK to its question)' : ''}${item.path.length > 1 ? ` (after ${item.path.length - 1} earlier press)` : ''}`,
            action: `press ${control.tag} "${control.name}" on ${page.path}`,
            expected: judged.expected, actual: judged.actual, ok, ms: now() - started,
            at: (after?.url ?? page.path).replace(/token=[^&#]*/g, 'token=…'),
            consoleErrors: events.console.filter((message) => !ALWAYS_ALLOWED_CONSOLE.some((rule) => rule.test(message))).map((message) => message.slice(0, 300)),
            failedRequests: events.requests.filter((request) => !ALWAYS_ALLOWED_REQUESTS.some((rule) => rule.test(request.url))).map((request) => `${request.text} -> ${request.status || 'failed'}`),
            findings: [...new Set(judged.findings)].slice(0, 10),
          };
          const shot = `pages-${page.id}/${String(trace.n).padStart(2, '0')}.jpg`;
          // A capture of a page that is not in front never answers; it is given a few seconds and the step goes without a picture.
          phase = 'taking a picture';
          if (await Promise.race([driver.screenshot(shot).catch(() => false), new Promise<boolean>((done) => setTimeout(() => done(false), 8_000))])) trace.screenshot = shot;
          steps.push(trace);
          // What the press revealed gets its own turn.
          if (after && item.path.length < 2) {
            const revealed = afterControls.filter((candidate) => candidate.visible && !controls.some((was) => was.sig === candidate.sig && was.visible));
            if (revealed.length > 0 && (control.tag === 'summary' || control.expanded !== null || control.attrs.includes('data-sheet-toggle'))) consider(revealed, item.path);
          }
          }, ITEM_BOUND_MS, `pressing ${item.path[item.path.length - 1] ?? 'a control'}`);
        } catch (error) {
          steps.push(failureStep(steps.length + 1, item.path[item.path.length - 1] ?? '', `the press could not be judged: ${error instanceof Error ? error.message.slice(0, 200) : String(error)} (while ${phase})`));
          summary.failed += 1;
        }
      }
      if (queue.length > 0) steps.push({ n: steps.length + 1, name: 'Stopped at the bound', action: 'bounded exploration', expected: 'every control pressed', actual: `${queue.length} control(s) left when the press or time bound was reached`, ok: true, ms: 0, at: '', consoleErrors: [], failedRequests: [], findings: [] });
    } catch (error) {
      summary.error = error instanceof Error ? error.message.slice(0, 200) : String(error);
      steps.push(failureStep(steps.length + 1, page.path, `the page could not be explored: ${summary.error}`));
      summary.failed += 1;
    }
    traces.push({ id: `pages-${page.id}`, title: `Pressing every control on the ${page.title} page`, source: 'bounded exploration of the other dashboard pages (layer 3 of the release-testing design)', ok: steps.every((step) => step.ok), steps, ms: steps.reduce((sum, step) => sum + step.ms, 0) });
  }

  const entries: PageCoverageEntry[] = options.inventory.entries.map((entry) => {
    const state = entryState.get(entry.id);
    const base = { id: entry.id, label: entry.label ?? entry.attr ?? entry.id, file: entry.file };
    if (state?.pressed) return { ...base, status: 'pressed' as const, detail: `pressed on: ${[...state.pages].join(', ')}`, pages: [...state.pages] };
    if (state) return { ...base, status: 'found' as const, detail: `found on ${[...state.pages].join(', ')}, not pressed (a field, a link to another site, or a control the throwaway machine must not press)`, pages: [...state.pages] };
    return { ...base, status: 'missed' as const, detail: 'never showed on these pages in the state the throwaway install was in (it needs data the machine does not have, or belongs to another page)', pages: [] };
  });
  const pressed = entries.filter((entry) => entry.status === 'pressed').length;
  const found = entries.filter((entry) => entry.status !== 'missed').length;
  return {
    pages: summaries, traces,
    coverage: { entries, listed: entries.length, found, pressed, missed: entries.length - pressed, unmatchable: options.inventory.unmatchable },
    presses: totalPresses,
  };
}

// ---------------------------------------------------------------------------
// Judging

const isExternal = (href: string | null): boolean => {
  if (!href) return false;
  if (/^(mailto:|tel:)/i.test(href)) return true;
  if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return false;
  try { return !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(href, 'http://127.0.0.1').hostname); } catch { return true; }
};

function validateLink(control: PageControl, page: PageDef, steps: StepTrace[], summary: PageSummary, record: (control: PageControl, pressed: boolean) => void): void {
  const findings: string[] = [];
  const href = control.href ?? '';
  if (!/^https:\/\//i.test(href)) findings.push(`a link to another site is not https: ${href.slice(0, 80)}`);
  if (control.target === '_blank' && !/noopener|noreferrer/.test(control.rel ?? '')) findings.push(`a link that opens a new window keeps a hold on this page (no noopener): ${href.slice(0, 80)}`);
  if (!control.name) findings.push(`a link to another site has no name: ${href.slice(0, 80)}`);
  const ok = findings.length === 0;
  summary.validated += 1;
  if (!ok) summary.failed += 1;
  record(control, true);
  steps.push({ n: steps.length + 1, name: `${control.name || href} (link to another site, validated)`, action: `check the link to ${href.slice(0, 80)}`, expected: 'an https destination that opens with no hold on this page', actual: ok ? `${new URL(href, 'https://x.invalid').host}, ${control.target === '_blank' ? 'new window, no opener' : 'same window'}` : findings.join('; '), ok, ms: 0, at: page.path, consoleErrors: [], failedRequests: [], findings });
}

function skippedStep(n: number, control: PageControl, reason: string, page: PageDef): StepTrace {
  return { n, name: `${control.name || control.tag} (not pressed)`, action: `list "${control.name}"`, expected: 'a control the throwaway machine must not press is named, with why', actual: reason, ok: true, ms: 0, at: page.path, consoleErrors: [], failedRequests: [], findings: [] };
}

function failureStep(n: number, name: string, actual: string): StepTrace {
  return { n, name, action: `press ${name}`, expected: 'the control can be pressed', actual, ok: false, ms: 0, at: '', consoleErrors: [], failedRequests: [], findings: [actual] };
}

interface JudgeInput {
  page: PageDef;
  control: PageControl;
  info: ElementInfo | null;
  before: PageObservation;
  after: PageObservation | undefined;
  afterControls: PageControl[];
  controlsBefore: PageControl[];
  events: ReturnType<JourneyDriver['drainEvents']>;
  opened: string[];
  pagesBefore: number;
  pagesAfter: number;
  pagesMax: number;
  answer: boolean | undefined;
}

export function judge(input: JudgeInput): Judged {
  const { page, control, info, before, after, afterControls, controlsBefore, events, opened } = input;
  const findings: string[] = [];
  const requests = events.requests.filter((request) => !ALWAYS_ALLOWED_REQUESTS.some((rule) => rule.test(request.url)));
  let consoleErrors = events.console.filter((message) => !ALWAYS_ALLOWED_CONSOLE.some((rule) => rule.test(message)) && !(/Failed to load resource/.test(message) && events.requests.length > 0));
  if (control.copy) consoleErrors = consoleErrors.filter((message) => !CLIPBOARD_REFUSAL.test(message));
  if (!info) findings.push('the control could not be pressed');
  if (!after) {
    findings.push(`pressing "${control.name}" left the page in a state that could not be read`);
    return { ok: false, findings, expected: 'the page shows what the press did', actual: 'the page could not be read afterwards' };
  }
  const left = after.url.split('#')[0] !== before.url.split('#')[0];
  if (left && !DASHBOARD_PATH.test(after.url)) findings.push(`pressing "${control.name}" left for a page that is not the dashboard's: ${after.url.slice(0, 80)}`);
  const visibleCount = (list: PageControl[]): number => list.filter((candidate) => candidate.visible).length;
  const changed = left || after.text !== before.text || after.expanded !== before.expanded || after.open !== before.open
    || visibleCount(afterControls) !== visibleCount(controlsBefore) || opened.length > 0 || input.pagesAfter !== input.pagesBefore
    || events.requests.length + events.console.length > 0 || after.confirms.length !== before.confirms.length || after.secret !== before.secret;
  const outcomes: Array<{ ok: boolean; expected: string; actual: string }> = [];
  const revokeNamed = (list: PageControl[]): number => list.filter((candidate) => candidate.visible && /^Revoke$/i.test(candidate.name)).length;

  if (control.invalid) {
    // A required field is empty: the browser says so and nothing is sent.
    outcomes.push({ ok: requests.length === 0 && !left, expected: 'a form with a required field left empty asks for it and sends nothing', actual: requests.length === 0 && !left ? 'nothing was sent' : 'the form was sent with a required field empty' });
  } else if (/data-agent-kind=(pair|key)$/.test(control.formKind)) {
    outcomes.push({ ok: after.secret > 0, expected: `${control.name} shows what it made`, actual: after.secret > 0 ? 'a code is showing' : `no code or key is showing${squash(after.statuses ?? '') ? ` (the page says: ${squash(after.statuses).slice(0, 160)})` : ''}` });
  } else if (control.confirms) {
    const asked = after.confirms.length > before.confirms.length && after.confirms[after.confirms.length - 1]!.trim().length > 0;
    if (input.answer === false) {
      const same = revokeNamed(afterControls) === revokeNamed(controlsBefore);
      outcomes.push({ ok: asked && same, expected: `${control.name} asks first, and Cancel leaves things as they were`, actual: !asked ? 'it did not ask' : same ? 'it asked and Cancel changed nothing' : 'Cancel went ahead anyway' });
    } else if (/Revoke/i.test(control.name)) {
      outcomes.push({ ok: asked && revokeNamed(afterControls) < revokeNamed(controlsBefore), expected: 'Revoke asks first, and OK removes the connection', actual: !asked ? 'it did not ask' : revokeNamed(afterControls) < revokeNamed(controlsBefore) ? 'it asked and the connection is gone' : 'it asked, but the connection is still listed' });
    } else outcomes.push({ ok: asked, expected: `${control.name} asks first`, actual: asked ? 'it asked' : 'it did not ask' });
  } else if (/^Lock$/i.test(control.name)) {
    const gone = !afterControls.some((candidate) => candidate.visible && /^Lock$/i.test(candidate.name));
    outcomes.push({ ok: gone, expected: 'after Lock the page no longer offers Lock', actual: gone ? 'it is gone' : 'the page still offers Lock' });
  } else if (control.tag === 'summary' || control.expanded !== null || control.attrs.includes('data-sheet-toggle')) {
    const moved = after.expanded !== before.expanded || after.open !== before.open || visibleCount(afterControls) > visibleCount(controlsBefore) || after.text !== before.text;
    outcomes.push({ ok: moved, expected: 'a control that opens something shows it', actual: moved ? 'it opened' : 'nothing opened' });
  }
  if (!changed && !control.copy && !control.invalid) findings.push(`pressing "${control.name}" did nothing: nothing on the page changed`);
  for (const message of consoleErrors) findings.push(`console error: ${message.slice(0, 200)}`);
  for (const request of requests) findings.push(`failed request: ${request.text} -> ${request.status || 'failed'}`);
  for (const url of opened) if (!OWN_HOSTS.test(url) && !/^https:\/\//.test(url)) findings.push(`a window was opened to a page that is not Olympus's own: ${url.slice(0, 80)}`);
  if (opened.length > 1) findings.push(`one press opened ${opened.length} windows`);
  if (input.pagesMax > input.pagesBefore && input.pagesAfter <= input.pagesBefore) findings.push('a window flashed up and vanished');
  const ok = findings.length === 0 && outcomes.every((outcome) => outcome.ok);
  return {
    ok, findings,
    expected: outcomes.length > 0 ? outcomes.map((outcome) => outcome.expected).join('; ') : 'something happens, and the generic rules hold',
    actual: left ? `the press went to ${after.url.slice(0, 80)}` : outcomes.length > 0 ? outcomes.map((outcome) => outcome.actual).join('; ') : changed ? 'the page changed' : 'nothing changed',
  };
}

// ---------------------------------------------------------------------------
// Checks

/** Blocking: a check per page. Advisory: the coverage. */
export function pagesChecks(result: PagesResult): CheckResult[] {
  const checks: CheckResult[] = [];
  for (const page of result.pages) {
    const trace = result.traces.find((candidate) => candidate.id === `pages-${page.id}`);
    const failed = trace?.steps.filter((step) => !step.ok) ?? [];
    checks.push({
      id: `pages.${page.id}`,
      title: `Every control on the ${page.title} page meets its outcome and the generic rules`,
      status: failed.length === 0 ? 'pass' : 'fail',
      detail: failed.length === 0
        ? `${page.found} control(s) found: ${page.pressed} pressed, ${page.validated} link(s) to other sites validated, ${page.skipped} named and not pressed; each with its outcome and no rule broken`
        : failed.slice(0, 4).map((step) => `${step.name}: ${step.findings.length > 0 ? step.findings.join('; ') : `expected ${step.expected}; got ${step.actual}`}`).join(' | '),
      ...(trace ? { ms: trace.ms } : {}),
    });
  }
  const c = result.coverage;
  checks.push({
    id: 'pages.coverage', title: 'Coverage of the other pages\' controls (advisory)',
    status: c.missed === 0 ? 'pass' : 'warn',
    detail: `${c.listed} controls listed from the page templates (${c.unmatchable} more carry no fixed name and cannot be matched); ${c.found} found on the pages, ${c.pressed} pressed, ${c.missed} missed (reasons in the report)`,
  });
  return checks;
}
