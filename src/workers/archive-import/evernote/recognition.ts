/**
 * Evernote's own reading of an attachment (`<recognition>`: a `recoIndex`
 * document of the words it found in an image or a PDF, handwriting included)
 * as text: the likeliest word of each place, in reading order, and the other
 * candidates as search terms only (docs/design/child-items.md, "Text the
 * provider supplies").
 *
 * A `recoIndex` lists places (`<item x y w h>`), each with candidate words
 * (`<t w="87">word</t>`, `w` the confidence). Places are put in lines by
 * vertical overlap (more than half the shorter one's height), lines top to
 * bottom, places in a line left to right. Shapes, barcodes and objects are not
 * words and are left out.
 */
import { decodeXmlEntities } from '../xml-stream.ts';

export interface RecognizedText {
  /** One line per line of the image, the likeliest word of each place. */
  text: string;
  /** How many words `text` holds. */
  words: number;
  /** The other candidates, once each: search terms, never the text. */
  alternatives: string[];
}

interface Place {
  x: number;
  y: number;
  h: number;
  best: string;
  others: string[];
}

/** At most this many places (words) are read from one attachment; the rest are left out. */
export const RECOGNITION_MAX_PLACES = 20_000;
/** At most this many candidates are read from one place. */
const MAX_CANDIDATES_PER_PLACE = 16;
/** At most this many other candidates are kept as search terms. */
export const RECOGNITION_MAX_ALTERNATIVES = 2_000;

const NUMBER_ATTRIBUTE = /([A-Za-z_][\w-]*)\s*=\s*["']\s*(-?\d+(?:\.\d+)?)\s*["']/g;

/** A tag's numeric attributes, read once. */
function numbers(attributes: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const match of attributes.matchAll(NUMBER_ATTRIBUTE)) out.set(match[1]!, Number(match[2]));
  return out;
}

/**
 * Each `<tag ...>body</tag>` in `text` from `from` to `to`, in one pass: a start tag without its end stops the
 * scan (nothing after it is a whole element), so no part of the text is looked at twice.
 */
function* elements(text: string, name: string, from: number, to: number): Generator<{ attributes: string; body: number; end: number }> {
  const open = `<${name}`;
  const close = `</${name}>`;
  let at = from;
  for (;;) {
    const start = text.indexOf(open, at);
    if (start < 0 || start >= to) return;
    const after = text.charCodeAt(start + open.length);
    // `<item` must be the whole name: `<itemx` is another element.
    if (!(after === 0x20 || after === 0x3e || after === 0x09 || after === 0x0a || after === 0x0d || after === 0x2f)) {
      at = start + open.length;
      continue;
    }
    const tagEnd = text.indexOf('>', start);
    if (tagEnd < 0 || tagEnd >= to) return;
    if (text.charCodeAt(tagEnd - 1) === 0x2f) {
      // An empty element: no body.
      at = tagEnd + 1;
      continue;
    }
    const end = text.indexOf(close, tagEnd + 1);
    if (end < 0 || end + close.length > to) return;
    yield { attributes: text.slice(start + open.length, tagEnd), body: tagEnd + 1, end };
    at = end + close.length;
  }
}

export function recognizedText(recoIndex: string): RecognizedText {
  const places: Place[] = [];
  for (const item of elements(recoIndex, 'item', 0, recoIndex.length)) {
    if (places.length >= RECOGNITION_MAX_PLACES) break;
    const words: Array<{ text: string; weight: number; order: number }> = [];
    for (const t of elements(recoIndex, 't', item.body, item.end)) {
      if (words.length >= MAX_CANDIDATES_PER_PLACE) break;
      const text = decodeXmlEntities(recoIndex.slice(t.body, t.end)).trim();
      if (text !== '') words.push({ text, weight: numbers(t.attributes).get('w') ?? 0, order: words.length });
    }
    if (words.length === 0) continue;
    words.sort((a, b) => b.weight - a.weight || a.order - b.order);
    const at = numbers(item.attributes);
    places.push({
      x: at.get('x') ?? 0,
      y: at.get('y') ?? 0,
      h: Math.max(1, at.get('h') ?? 0),
      best: words[0]!.text,
      others: words.slice(1).map((word) => word.text),
    });
  }
  places.sort((a, b) => a.y - b.y || a.x - b.x);
  // Lines by vertical overlap, each line's extent kept as places join it: one pass.
  const lines: Array<{ top: number; bottom: number; places: Place[] }> = [];
  for (const place of places) {
    const line = lines[lines.length - 1];
    if (line) {
      const overlap = Math.min(line.bottom, place.y + place.h) - Math.max(line.top, place.y);
      const shorter = Math.min(line.bottom - line.top, place.h);
      if (overlap > shorter / 2) {
        line.places.push(place);
        line.top = Math.min(line.top, place.y);
        line.bottom = Math.max(line.bottom, place.y + place.h);
        continue;
      }
    }
    lines.push({ top: place.y, bottom: place.y + place.h, places: [place] });
  }
  const best = new Set(places.map((place) => place.best));
  const alternatives: string[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    for (const word of place.others) {
      if (alternatives.length >= RECOGNITION_MAX_ALTERNATIVES) break;
      if (best.has(word) || seen.has(word)) continue;
      seen.add(word);
      alternatives.push(word);
    }
  }
  return {
    text: lines.map((line) => line.places.sort((a, b) => a.x - b.x).map((place) => place.best).join(' ')).join('\n'),
    words: places.length,
    alternatives,
  };
}
