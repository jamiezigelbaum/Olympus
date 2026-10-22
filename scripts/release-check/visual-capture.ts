/**
 * What the machine needs to take the pictures for the visual baselines (visual.ts holds the comparison): which screens, at which
 * sizes, and the one script that makes the parts that vary between two runs of the same product fixed before the picture is taken.
 * No dependencies: this file is bundled into the in-machine agent, and the image library stays on the computer that runs the harness.
 */

// ---------------------------------------------------------------------------
// The screens

export interface Screen {
  id: string;
  /** The page, as a path in the signed-in browser. */
  path: string;
  title: string;
}

/**
 * The pages the owner sees. The Inbox entry and the answer under a question hold a model's words, which differ from run to run, so
 * they are not baselined (the Inbox leg checks them by fact).
 */
export const SCREENS: readonly Screen[] = [
  { id: 'dashboard', path: '/dashboard', title: 'The dashboard' },
  { id: 'keys', path: '/dashboard?keys', title: 'Keys' },
  { id: 'agents', path: '/dashboard?agents', title: 'Agents' },
  { id: 'ask', path: '/dashboard?private-answers', title: 'Ask a question' },
  { id: 'connector', path: '/dashboard?connector', title: 'Build a connector' },
];

export const SCREEN_WIDTHS: readonly number[] = [390, 1280];
export const SCREEN_THEMES: readonly ('light' | 'dark')[] = ['light', 'dark'];

/** The file name of one screen at one size: `ask-1280-dark`. */
export const screenName = (screen: string, width: number, theme: string): string => `${screen}-${width}-${theme}`;

// ---------------------------------------------------------------------------
// What may differ between two runs, and how it is made not to

/**
 * Text that varies by the clock or by the run, with the fixed text it is replaced by. Applied to every text node of the page and of
 * the framed panel before the picture. Each rule names what it covers, so a new kind of varying text is added here, in one place.
 */
export const DYNAMIC_TEXT_RULES: ReadonlyArray<{ what: string; pattern: RegExp; replacement: string }> = [
  { what: 'a time since: "2m ago", "3 min ago", "1 hr ago", "4 days ago", "just now"', pattern: /\b(?:just now|\d+\s*(?:s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)\s+ago)\b/gi, replacement: '0 min ago' },
  { what: 'a time to come: "in 5 min", "about 12 min", "link expires in 14 min"', pattern: /\b(in|about|for|within)\s+(?:less than a minute|\d+\s*(?:s|sec|seconds?|min|minutes?|hr|hours?|days?)(?:\s+\d+\s*min)?)\b/gi, replacement: '$1 0 min' },
  { what: 'a calendar date: "Oct 22, 2026"', pattern: /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/g, replacement: 'Jan 1, 2000' },
  { what: 'a clock time: "14:05"', pattern: /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?\b/g, replacement: '0:00' },
  { what: 'progress: "42% done", "3 of 12 files", "Downloading 61%"', pattern: /\b\d+(?:\.\d+)?%/g, replacement: '0%' },
  { what: 'a count of a total', pattern: /\b\d[\d,]*\s+of\s+\d[\d,]*\b/g, replacement: '0 of 0' },
  { what: 'a size: "1.2 GB", "340 MB"', pattern: /\b\d+(?:\.\d+)?\s?(?:KB|MB|GB|TB)\b/g, replacement: '0 MB' },
  { what: 'the Needs you line about answers waiting: "1 unread private answer", "3 unread private answers"', pattern: /\b\d+\s+unread\s+private\s+answers?\b/gi, replacement: '0 unread private answers' },
  { what: 'a number of items, files, messages or answers', pattern: /\b\d[\d,]*\s+(?:items?|files?|messages?|answers?|questions?|documents?|emails?)\b/gi, replacement: '0 items' },
];

/** Elements left out of the picture because how many there are depends on what the run did (display:none, so the page closes up). */
export const MASK_SELECTORS_HIDDEN: readonly string[] = [
  // The Inbox: one row per question the run has asked (the agents' and the Ask page's). Its heading stays; what is under it
  // (the rows, the empty-inbox line, Delete all, the older-answers note) depends on how many questions this run asked.
  'section.pasection[aria-labelledby="waiting"] > :not(h3)',
];

/**
 * The script the machine runs in the page and in the framed panel before a capture: freezes motion, normalises the varying text and
 * hides the run-dependent lists. Deterministic, idempotent, and the same text every time (it is also run by the tests).
 */
export function maskScript(): string {
  const rules = DYNAMIC_TEXT_RULES.map((rule) => ({ pattern: rule.pattern.source, flags: rule.pattern.flags, replacement: rule.replacement }));
  return String.raw`(() => {
    if (!document.documentElement) return 0;
    let style = document.getElementById('rc-visual-mask');
    if (!style) {
      style = document.createElement('style');
      style.id = 'rc-visual-mask';
      style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}'
        + ${JSON.stringify(MASK_SELECTORS_HIDDEN.join(',') + '{display:none!important}')};
      document.head.appendChild(style);
    }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const rules = ${JSON.stringify(rules)}.map((rule) => ({ re: new RegExp(rule.pattern, rule.flags), replacement: rule.replacement }));
    let changed = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || /^(script|style|noscript|textarea)$/i.test(parent.tagName)) continue;
      let text = node.nodeValue || '';
      const before = text;
      for (const rule of rules) { rule.re.lastIndex = 0; text = text.replace(rule.re, rule.replacement); }
      if (text !== before) { node.nodeValue = text; changed += 1; }
    }
    return changed;
  })()`;
}

/** The same normalisation on a plain string, for the tests and for anything that must compare text the way the picture does. */
export function normaliseDynamicText(text: string): string {
  let out = text;
  for (const rule of DYNAMIC_TEXT_RULES) out = out.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replacement);
  return out;
}

