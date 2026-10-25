/**
 * Planted bugs for qualifying the AI reviewer (reviewer.ts). A qualification run (`run.ts --reviewer-plants`) takes a few dashboard
 * screens as they are, then again with one bug planted in the page each time, in the test browser only: the product is never
 * changed, and a release candidate's own run never plants anything. reviewer-qualify.ts then asks the reviewer about every picture
 * and measures how often it finds each kind of bug and how often it reports one that is not there.
 *
 * `heldOut` bugs are never used while the reviewer's instructions are being written or tuned; they measure it. The first two are the
 * ones only a human caught in the first baselines (a fixed-width Linux font and misaligned buttons, 2026-10-23).
 */
import type { ReviewKind } from './reviewer.ts';

export interface Plant {
  id: string;
  kind: ReviewKind;
  heldOut: boolean;
  /** What the bug is, for the qualification record (never shown to the reviewer). */
  what: string;
  /** A page script, run in the page and in the framed panel; it returns true where it planted the bug. */
  script: string;
}

/** Page-side helpers every plant script starts with: visible elements, and leaf lines of text a person reads as a status. */
const HELPERS = String.raw`
  const visible = (el) => { const box = el.getBoundingClientRect(); const style = getComputedStyle(el); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('details:not([open]) > :not(summary)'); };
  const own = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('main') || document.body;
  const leaves = () => Array.from(main.querySelectorAll('p, span, div, li, small, strong, b, h1, h2, h3, summary, label')).filter((el) => visible(el) && own(el).length >= 6 && !el.closest('button, a, textarea, input, select'));
  // A line under a row's name that says its state; else the first short line of ordinary text.
  const statusLine = () => { const lines = leaves().filter((el) => !/^(H1|H2|H3|SUMMARY|LABEL)$/.test(el.tagName)); return lines.find((el) => /^(Not connected|Ready|Connected|Checking|No archives)/.test(own(el))) || lines.find((el) => own(el).length >= 12 && own(el).length <= 90); };
  const hasContent = () => (document.body ? document.body.innerText.trim().length > 40 : false);
  // What was planted carries a mark, so the capture can tell when the page redrew itself and took the bug away.
  const mark = (el) => { el.setAttribute('data-rc-plant', ''); return true; };
`;

const plant = (body: string): string => `(() => { ${HELPERS}\n${body}\n})()`;

export const PLANTS: readonly Plant[] = [
  {
    id: 'font-monospace', kind: 'font', heldOut: true,
    what: 'every piece of text in a fixed-width font, as when the system font is missing',
    script: plant(String.raw`
      if (!hasContent()) return false;
      const style = document.createElement('style');
      style.textContent = '*{font-family:"DejaVu Sans Mono","Liberation Mono",Menlo,monospace!important}';
      document.head.appendChild(style);
      return mark(style);`),
  },
  {
    id: 'button-misaligned', kind: 'layout', heldOut: true,
    what: 'one button of a column of like buttons pushed off line',
    script: plant(String.raw`
      const buttons = Array.from(main.querySelectorAll('button')).filter(visible);
      const groups = new Map();
      for (const button of buttons) { const key = button.textContent.trim(); groups.set(key, [...(groups.get(key) || []), button]); }
      const group = Array.from(groups.values()).find((list) => list.length >= 2);
      const target = group ? group[1] : buttons[1];
      if (!target) return false;
      target.style.transform = 'translate(-13px, 9px)';
      return mark(target);`),
  },
  {
    id: 'text-overlap', kind: 'layout', heldOut: true,
    what: 'a status line moved up over the line above it',
    script: plant(String.raw`
      const line = statusLine();
      if (!line) return false;
      line.style.position = 'relative';
      line.style.top = '-13px';
      return mark(line);`),
  },
  {
    id: 'state-contradiction', kind: 'contradiction', heldOut: true,
    what: 'a row that says both that it is not connected and that it is connected and up to date',
    script: plant(String.raw`
      const line = statusLine();
      if (!line) return false;
      const other = document.createElement(line.tagName === 'SPAN' ? 'span' : 'p');
      other.className = line.className;
      other.textContent = /^Not connected/.test(own(line)) ? 'Connected and up to date' : 'Not connected';
      if (line.tagName === 'SPAN') other.style.marginLeft = '8px';
      line.after(other);
      return mark(other);`),
  },
  {
    id: 'label-clipped', kind: 'layout', heldOut: false,
    what: 'a heading cut off part-way through a word',
    script: plant(String.raw`
      const heading = leaves().find((el) => /^(H1|H2|H3|STRONG|B|SUMMARY)$/.test(el.tagName) && own(el).length >= 8);
      if (!heading) return false;
      const width = Math.max(30, Math.round(heading.getBoundingClientRect().width * 0.42));
      heading.style.cssText += ';display:inline-block;max-width:' + width + 'px;white-space:nowrap;overflow:hidden;vertical-align:bottom';
      return mark(heading);`),
  },
  {
    id: 'developer-words', kind: 'words', heldOut: false,
    what: 'a status line replaced by an internal error code',
    script: plant(String.raw`
      const line = statusLine();
      if (!line) return false;
      line.textContent = 'ERR_SCOPE_ROOT_MISSING (index_state=degraded, errno=2)';
      return mark(line);`),
  },
  {
    id: 'impossible-number', kind: 'contradiction', heldOut: false,
    what: 'a status line whose numbers cannot be right',
    script: plant(String.raw`
      const line = statusLine();
      if (!line) return false;
      line.textContent = 'Read 12 of 7 files · 140% done';
      return mark(line);`),
  },
  {
    id: 'problem-no-fix', kind: 'no-fix', heldOut: false,
    what: 'a warning that something went wrong, with no button or link to fix it or say what',
    script: plant(String.raw`
      if (!hasContent()) return false;
      const heading = main.querySelector('h1, h2');
      const card = document.createElement('div');
      card.setAttribute('role', 'alert');
      card.style.cssText = 'border-left:4px solid #d9480f;background:#fff4e6;color:#7a2e0e;padding:12px 16px;margin:12px 0;border-radius:6px;font-weight:600';
      card.textContent = 'Some of your files could not be read.';
      if (heading) heading.after(card); else main.prepend(card);
      return mark(card);`),
  },
  {
    id: 'faint-text', kind: 'contrast', heldOut: false,
    what: 'a block of text faded until it is hard to read',
    script: plant(String.raw`
      const line = statusLine() || leaves().find((el) => el.tagName === 'P');
      if (!line) return false;
      const block = line.parentElement && line.parentElement !== main ? line.parentElement : line;
      block.style.opacity = '0.2';
      return mark(block);`),
  },
];

/** The screens a qualification run plants on: the dashboard and the pages, both widths, both themes between them. */
export const PLANT_SCREENS: ReadonlyArray<{ screen: string; width: number; theme: 'light' | 'dark' }> = [
  { screen: 'dashboard', width: 1280, theme: 'light' },
  { screen: 'dashboard', width: 390, theme: 'dark' },
  { screen: 'keys', width: 1280, theme: 'dark' },
  { screen: 'agents', width: 390, theme: 'light' },
  { screen: 'ask', width: 1280, theme: 'light' },
];

/** One picture of a qualification run: a screen as it is (`plant` null) or with one bug planted. */
export interface PlantedPicture {
  screen: string;
  width: number;
  theme: 'light' | 'dark';
  /** Relative to the plants folder. */
  picture: string;
  plant: string | null;
  kind: ReviewKind | null;
  heldOut: boolean;
}
