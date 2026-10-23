/**
 * The controls of the dashboard's other pages, listed from the product's source (the page-crawl's counterpart of explore-inventory.ts).
 *
 * The computer's own pages (Keys, Agents, Inbox, Build a connector) are rendered on the server from a handful of files. Every control
 * those files can emit (a button, a link, a summary, a field) is read from the templates and named by what a page shows for it: a
 * `data-*` attribute that identifies it, or its fixed words. The list is the yardstick for the crawl's coverage; a control whose words
 * come from the data (a row's name) and that carries no identifying attribute is counted separately, because it cannot be matched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PageControlEntry {
  /** `file:handle`, stable across edits that do not change the control. */
  id: string;
  file: string;
  tag: 'button' | 'a' | 'summary' | 'input' | 'select' | 'textarea';
  /** The identifying data attribute (without its value), when the template gives one. */
  attr?: string;
  /** The fixed words, when the template gives them. */
  label?: string;
}

export interface PageInventory {
  entries: PageControlEntry[];
  /** Controls the templates emit with neither an identifying attribute nor fixed words: counted, not matched. */
  unmatchable: number;
  files: string[];
}

/** The server-rendered files that make the computer's pages. */
export const PAGE_FILES = [
  'src/workers/dashboard/pages/local.ts',
  'src/workers/dashboard/pages/private-answers.ts',
  'src/workers/dashboard/agents.ts',
  'src/workers/dashboard/components.ts',
  'src/workers/dashboard/model-setup.ts',
] as const;

/** Data attributes that say where a control sits or how it is polled, not what it is. */
const NOT_IDENTIFYING = new Set(['data-key', 'data-open-key', 'data-poll-key', 'data-rc-n', 'data-confirmation', 'data-copy-target', 'data-sheet-toggle', 'data-focus-target']);
const TAGS = ['button', 'a', 'summary', 'input', 'select', 'textarea'] as const;

const wordsOf = (text: string): string => text.replace(/\$\{[^}]*\}/g, '').replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

/** Reads the controls out of one template file. */
export function scanControls(file: string, source: string): { entries: PageControlEntry[]; unmatchable: number } {
  const entries = new Map<string, PageControlEntry>();
  let unmatchable = 0;
  const open = /<(button|a|summary|input|select|textarea)(?=[\s>])/g;
  for (let match = open.exec(source); match; match = open.exec(source)) {
    const tag = match[1] as (typeof TAGS)[number];
    // The opening tag, up to the first `>` outside a `${ }` expression.
    let depth = 0;
    let end = open.lastIndex;
    for (; end < source.length; end++) {
      const ch = source[end]!;
      if (ch === '$' && source[end + 1] === '{') depth++;
      else if (ch === '}' && depth > 0) depth--;
      else if (ch === '>' && depth === 0) break;
    }
    const head = source.slice(match.index, end + 1);
    if (/type="hidden"/.test(head)) continue;
    const rest = source.slice(end + 1, end + 400);
    const closing = rest.search(new RegExp(`</${tag}>`));
    const inner = tag === 'input' || tag === 'select' || tag === 'textarea' ? '' : wordsOf(closing >= 0 ? rest.slice(0, closing) : rest.slice(0, 80));
    const attr = [...head.matchAll(/\s(data-[a-z0-9-]+)/g)].map((found) => found[1]!).find((name) => !NOT_IDENTIFYING.has(name));
    const aria = /aria-label="([^"$]+)"/.exec(head)?.[1];
    const named = /name="([a-z_]+)"/.exec(head)?.[1];
    const words = aria ?? (inner.length > 0 && inner.length <= 60 ? inner : undefined);
    const label = (words && /[A-Za-z]{3}/.test(words) ? words : undefined) || (tag === 'input' || tag === 'textarea' || tag === 'select' ? named : undefined);
    if (!attr && !label) { unmatchable += 1; continue; }
    const id = `${file.split('/').pop()}:${attr ?? label}`;
    if (!entries.has(id)) entries.set(id, { id, file, tag, ...(attr ? { attr } : {}), ...(label ? { label } : {}) });
  }
  return { entries: [...entries.values()], unmatchable };
}

export function buildPageInventory(root = join(import.meta.dir, '..', '..')): PageInventory {
  const all = new Map<string, PageControlEntry>();
  let unmatchable = 0;
  for (const file of PAGE_FILES) {
    const scanned = scanControls(file, readFileSync(join(root, file), 'utf8'));
    unmatchable += scanned.unmatchable;
    for (const entry of scanned.entries) if (!all.has(entry.id)) all.set(entry.id, entry);
  }
  return { entries: [...all.values()], unmatchable, files: [...PAGE_FILES] };
}
