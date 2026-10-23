/**
 * The page-side half of the journey runner: one small script, injected into a page (and into the dashboard's framed panel) with
 * `Runtime.evaluate`, that finds controls the way a person (or a screen reader) names them and audits the page for the generic
 * rules. Plain source text, because the harness has no DOM types and the same text runs in the real browser on the machine and in a
 * DOM in the tests (test/release-check-journeys.test.ts).
 *
 * Finding: a control is named by its role and its accessible name (aria-labelledby, aria-label, its label, its visible text, the
 * placeholder, the title), or by its visible text. A hidden element (no box, `visibility:hidden`) is never found. A `css` selector is
 * the last resort for a control that has no name.
 */

/** A target as the page-side script takes it: regular expressions arrive as { re, flags }. */
export interface WireTarget {
  role?: string;
  name?: string | { re: string; flags: string };
  text?: string | { re: string; flags: string };
  css?: string;
  /** Match a name or text that merely contains the string (the default is the whole name, ignoring case and spacing). */
  contains?: boolean;
  within?: WireTarget;
  /** Which match, counting from 0 (the default is the first). */
  nth?: number;
}

export const PROBE_SOURCE = String.raw`(() => {
  if (window.__rc) return;
  const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const ROLE_SELECTORS = {
    button: 'button, [role="button"], input[type="button"], input[type="submit"], summary',
    link: 'a[href], [role="link"]',
    textbox: 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="password"], input[type="number"], [role="textbox"]',
    checkbox: 'input[type="checkbox"], [role="checkbox"], [role="switch"]',
    radio: 'input[type="radio"], [role="radio"]',
    heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
    combobox: 'select, [role="combobox"]',
    tab: '[role="tab"]',
  };
  const INTERACTIVE = [ROLE_SELECTORS.button, ROLE_SELECTORS.link, ROLE_SELECTORS.textbox, ROLE_SELECTORS.checkbox, ROLE_SELECTORS.radio, ROLE_SELECTORS.combobox, ROLE_SELECTORS.tab, '[tabindex]', 'label'].join(', ');
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const nameOf = (el) => {
    const labelled = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelled) {
      const text = labelled.split(/\s+/).map((id) => { const target = document.getElementById(id); return target ? target.textContent : ''; }).join(' ');
      if (clean(text)) return clean(text);
    }
    const label = el.getAttribute && el.getAttribute('aria-label');
    if (clean(label)) return clean(label);
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit') return clean(el.value);
      const labels = el.labels ? Array.from(el.labels).map((l) => l.textContent).join(' ') : '';
      if (clean(labels)) return clean(labels);
      return clean(el.getAttribute('placeholder') || el.getAttribute('title') || '');
    }
    const text = clean(el.textContent);
    if (text) return text;
    const image = el.querySelector ? el.querySelector('img[alt], svg[aria-label], [aria-label]') : null;
    if (image) return clean(image.getAttribute('alt') || image.getAttribute('aria-label'));
    return clean(el.getAttribute && el.getAttribute('title'));
  };
  const matcher = (want, contains) => {
    if (want && typeof want === 'object') { const re = new RegExp(want.re, want.flags || ''); return (value) => re.test(value); }
    const wanted = clean(want).toLowerCase();
    return (value) => (contains ? clean(value).toLowerCase().includes(wanted) : clean(value).toLowerCase() === wanted);
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    for (const role of Object.keys(ROLE_SELECTORS)) if (el.matches(ROLE_SELECTORS[role])) return role;
    return '';
  };
  const infoOf = (el) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el), text: clean(el.textContent).slice(0, 160),
      x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), w: Math.round(box.width), h: Math.round(box.height),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      href: el.getAttribute('href'), value: typeof el.value === 'string' ? el.value : null,
      checked: typeof el.checked === 'boolean' ? el.checked : null, expanded: el.getAttribute('aria-expanded'),
      open: typeof el.open === 'boolean' ? el.open : (el.parentElement && el.tagName === 'SUMMARY' && typeof el.parentElement.open === 'boolean' ? el.parentElement.open : null),
    };
  };
  const scopeOf = (within) => {
    if (!within) return [document];
    return all(within, [document]).filter(isVisible);
  };
  /** Every visible element a target names, in document order. */
  function all(target, roots) {
    const scopes = roots || scopeOf(target.within);
    const found = [];
    const seen = new Set();
    for (const scope of scopes) {
      let candidates;
      if (target.css) candidates = Array.from(scope.querySelectorAll(target.css));
      else if (target.role) candidates = Array.from(scope.querySelectorAll(ROLE_SELECTORS[target.role] || '[role="' + target.role + '"]'));
      else if (target.name !== undefined || target.text !== undefined) candidates = Array.from(scope.querySelectorAll(INTERACTIVE));
      else candidates = [];
      for (const el of candidates) {
        if (seen.has(el) || !isVisible(el)) continue;
        if (target.name !== undefined && !matcher(target.name, target.contains)(nameOf(el))) continue;
        if (target.text !== undefined && !matcher(target.text, target.contains)(clean(el.textContent))) continue;
        seen.add(el);
        found.push(el);
      }
      // A text that no control carries: the smallest element that holds it (a heading, a line, a card).
      if (target.text !== undefined && !target.css && !target.role && found.length === 0) {
        const test = matcher(target.text, target.contains);
        const walker = document.createTreeWalker(scope === document ? document.body : scope, NodeFilter.SHOW_ELEMENT);
        const hits = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!isVisible(node) || !test(clean(node.textContent))) continue;
          const childHolds = Array.from(node.children).some((child) => isVisible(child) && test(clean(child.textContent)));
          if (!childHolds) hits.push(node);
        }
        for (const el of hits) if (!seen.has(el)) { seen.add(el); found.push(el); }
      }
    }
    return found;
  }
  const pick = (target) => { const list = all(target); return list[target.nth || 0] || null; };

  window.__rc = {
    clean,
    /** The first match itself (for the tests' DOM, which has no mouse). */
    element: (target) => pick(target),
    count: (target) => all(target).length,
    find: (target) => { const el = pick(target); return el ? infoOf(el) : null; },
    list: (target, limit) => all(target).slice(0, limit || 50).map((el) => ({ role: roleOf(el), name: nameOf(el), text: clean(el.textContent).slice(0, 160) })),
    /** Puts the first match's field in view, selects what is in it, and focuses it, ready for typing. */
    focus: (target) => {
      const el = pick(target);
      if (!el) return null;
      const info = infoOf(el);
      if (typeof el.focus === 'function') el.focus();
      if (typeof el.select === 'function') { try { el.select(); } catch (error) { /* not selectable */ } }
      return info;
    },
    attr: (target, name) => { const el = pick(target); return el ? el.getAttribute(name) : null; },
    value: (target) => { const el = pick(target); return el ? (typeof el.value === 'string' ? el.value : clean(el.textContent)) : null; },
    visibleText: () => (document.body ? document.body.innerText : ''),
    /** The generic rules, read off the page as it stands. */
    audit: () => {
      const text = document.body ? document.body.innerText : '';
      const bad = [];
      const pattern = /(^|[^A-Za-z0-9_.-])(undefined|NaN|\[object Object\])(?![A-Za-z0-9_-])/g;
      for (let match = pattern.exec(text); match && bad.length < 5; match = pattern.exec(text)) {
        const from = Math.max(0, match.index - 30);
        bad.push(clean(text.slice(from, match.index + match[0].length + 30)));
      }
      const emptyButtons = [];
      for (const el of document.querySelectorAll(ROLE_SELECTORS.button + ', ' + ROLE_SELECTORS.link)) {
        if (!isVisible(el)) continue;
        if (nameOf(el) === '') emptyButtons.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''));
        if (emptyButtons.length >= 5) break;
      }
      const root = document.documentElement;
      return { bad, emptyButtons, overflowX: Math.max(0, root.scrollWidth - root.clientWidth), textLength: text.length };
    },
    /** A short account of what is on the page, for the trace: headings, controls and the first lines of text. */
    inventory: () => {
      const text = clean(document.body ? document.body.innerText : '').slice(0, 700);
      const controls = [];
      for (const el of document.querySelectorAll(ROLE_SELECTORS.button + ', ' + ROLE_SELECTORS.link + ', ' + ROLE_SELECTORS.textbox + ', ' + ROLE_SELECTORS.checkbox)) {
        if (!isVisible(el)) continue;
        controls.push(roleOf(el) + ': ' + (nameOf(el).slice(0, 60) || '(no name)') + (el.disabled ? ' [disabled]' : ''));
        if (controls.length >= 40) break;
      }
      return { text, controls };
    },
    /**
     * Every control the page's own code gave a key (data-key), whether or not it is showing: a closed menu's items are on the page but
     * not visible. With what the exploration needs to know about each: its row, the menu it sits in, and the reason shown beside it.
     */
    controls: (scopeCss) => {
      const root = scopeCss ? document.querySelector(scopeCss) : document;
      if (!root) return [];
      const out = [];
      for (const el of root.querySelectorAll('[data-key]')) {
        const tag = el.tagName.toLowerCase();
        if (!['button', 'a', 'summary', 'input', 'select', 'textarea'].includes(tag) && el.getAttribute('role') !== 'button') continue;
        const row = el.closest('li.source, li.row');
        const rowName = row ? row.querySelector('.source-name') : null;
        const menu = el.closest('details.menu');
        const fix = el.closest('.fix, .source-actions') || el.parentElement;
        const reason = fix ? fix.querySelector('.reason') : null;
        out.push({
          key: el.getAttribute('data-key'), tag, role: roleOf(el), name: nameOf(el), text: clean(el.textContent).slice(0, 120),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          visible: isVisible(el), expanded: el.getAttribute('aria-expanded'),
          reason: reason && !reason.contains(el) ? clean(reason.textContent).slice(0, 200) : '',
          rowName: rowName ? clean(rowName.textContent) : '', rowKind: row ? (row.classList.contains('source') ? 'source' : 'need') : '',
          menuKey: menu ? menu.getAttribute('data-open-key') : '', href: el.getAttribute('href'),
        });
      }
      return out;
    },
    /** Starts recording every window.open the page makes (a window that flashes up and goes is still counted). */
    watchWindows: () => {
      if (window.__rcOpened) return window.__rcOpened.length;
      window.__rcOpened = [];
      const original = window.open;
      window.open = function () { window.__rcOpened.push(String(arguments[0] || '').slice(0, 120)); return original ? original.apply(window, arguments) : null; };
      return 0;
    },
    openedWindows: () => (window.__rcOpened ? window.__rcOpened.slice() : []),
    /** Every details element's state, for the menus and See why. */
    openDetails: () => Array.from(document.querySelectorAll('details[data-open-key]')).map((el) => ({ key: el.getAttribute('data-open-key'), open: el.open === true })),
    /** The rectangle of the framed panel in this page, if there is one. */
    frameBox: (id) => { const el = document.getElementById(id); if (!el) return null; const box = el.getBoundingClientRect(); return { x: box.left, y: box.top, w: box.width, h: box.height }; },
    scrollHeight: () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
  };
})()`;

/** A target as the page-side script takes it. */
export function wireTarget(target: Target): WireTarget {
  const wire: WireTarget = {};
  if (target.role !== undefined) wire.role = target.role;
  if (target.name !== undefined) wire.name = wireMatch(target.name);
  if (target.text !== undefined) wire.text = wireMatch(target.text);
  if (target.css !== undefined) wire.css = target.css;
  if (target.contains) wire.contains = true;
  if (target.within) wire.within = wireTarget(target.within);
  if (target.nth !== undefined) wire.nth = target.nth;
  return wire;
}

function wireMatch(value: string | RegExp): string | { re: string; flags: string } {
  return typeof value === 'string' ? value : { re: value.source, flags: value.flags };
}

/** A control or a place on a page, named the way a person names it. */
export interface Target {
  role?: 'button' | 'link' | 'textbox' | 'checkbox' | 'radio' | 'heading' | 'combobox' | 'tab' | (string & {});
  name?: string | RegExp;
  text?: string | RegExp;
  css?: string;
  contains?: boolean;
  within?: Target;
  nth?: number;
}

/** What a target looks like in a trace line: `button "Save"`, `heading /Models/`. */
export function describeTarget(target: Target): string {
  const part = (value: string | RegExp): string => (typeof value === 'string' ? `"${value}"` : String(value));
  const bits = [target.role ?? (target.css ? 'element' : 'control')];
  if (target.name !== undefined) bits.push(part(target.name));
  if (target.text !== undefined) bits.push(`with text ${part(target.text)}`);
  if (target.css !== undefined) bits.push(`[${target.css}]`);
  if (target.within) bits.push(`in ${describeTarget(target.within)}`);
  if (target.nth) bits.push(`#${target.nth + 1}`);
  return bits.join(' ');
}
