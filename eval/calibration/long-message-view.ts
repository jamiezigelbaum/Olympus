// What the labeling page shows for a message longer than the judge's excerpt:
// the whole message, split into the parts the judge reads and the parts it
// does not. The parts come from the judge's own input, so a queued production
// question and a rebuilt one are shown the same way.

import { SNIFFER_EXCERPT_MAX_CHARS } from '../../src/workers/classification/tier-classifier.ts';

/** snifferExcerpt's separator between the opening and each passage. */
const EXCERPT_GAP = ' … ';
const EXCERPT_LABEL = '\nExcerpt: ';

export interface LongMessageView {
  /** The judge's lines before the excerpt: names and any parent context. */
  names: string;
  parts: Array<{ text: string; read: boolean }>;
  /** False when the judge's parts could not be placed: nothing is highlighted. */
  located: boolean;
  /** The message runs past the page's display limit. */
  cutOff: boolean;
  totalChars: number;
}

export function longMessageView(text: string, judgeSees: string, displayLimit: number): LongMessageView | undefined {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SNIFFER_EXCERPT_MAX_CHARS) return undefined;
  const at = judgeSees.indexOf(EXCERPT_LABEL);
  const names = at < 0 ? '' : judgeSees.slice(0, at);
  const excerpt = at < 0 ? judgeSees : judgeSees.slice(at + EXCERPT_LABEL.length);

  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  let located = true;
  for (const piece of excerpt.split(EXCERPT_GAP)) {
    const start = flat.indexOf(piece, cursor);
    if (!piece || start < 0) { located = false; break; }
    ranges.push([start, start + piece.length]);
    cursor = start + piece.length;
  }

  const shown = flat.slice(0, displayLimit);
  const parts: LongMessageView['parts'] = [];
  const add = (from: number, to: number, read: boolean) => {
    const slice = shown.slice(from, to);
    if (slice) parts.push({ text: slice, read });
  };
  let end = 0;
  if (located) {
    for (const [from, to] of ranges) {
      add(end, from, false);
      add(from, to, true);
      end = to;
    }
  }
  add(end, shown.length, false);
  return { names, parts, located, cutOff: flat.length > displayLimit, totalChars: flat.length };
}
