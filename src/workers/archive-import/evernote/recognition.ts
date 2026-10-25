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

/** At most this many places are read from one attachment. */
const MAX_PLACES = 100_000;

function number(attributes: string, name: string): number {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']\\s*(-?\\d+(?:\\.\\d+)?)\\s*["']`).exec(attributes);
  return match ? Number(match[1]) : 0;
}

export function recognizedText(recoIndex: string): RecognizedText {
  const places: Place[] = [];
  const item = /<item\b([^>]*)>([\s\S]*?)<\/item>/g;
  const candidate = /<t\b([^>]*)>([\s\S]*?)<\/t>/g;
  for (const match of recoIndex.matchAll(item)) {
    if (places.length >= MAX_PLACES) break;
    const words: Array<{ text: string; weight: number; order: number }> = [];
    let order = 0;
    for (const t of match[2]!.matchAll(candidate)) {
      const text = decodeXmlEntities(t[2]!).trim();
      if (text !== '') words.push({ text, weight: number(t[1]!, 'w'), order: order++ });
    }
    if (words.length === 0) continue;
    words.sort((a, b) => b.weight - a.weight || a.order - b.order);
    places.push({
      x: number(match[1]!, 'x'),
      y: number(match[1]!, 'y'),
      h: Math.max(1, number(match[1]!, 'h')),
      best: words[0]!.text,
      others: words.slice(1).map((word) => word.text),
    });
  }
  places.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Place[][] = [];
  for (const place of places) {
    const line = lines[lines.length - 1];
    if (line) {
      const top = Math.min(...line.map((entry) => entry.y));
      const bottom = Math.max(...line.map((entry) => entry.y + entry.h));
      const overlap = Math.min(bottom, place.y + place.h) - Math.max(top, place.y);
      const shorter = Math.min(bottom - top, place.h);
      if (overlap > shorter / 2) {
        line.push(place);
        continue;
      }
    }
    lines.push([place]);
  }
  const best = new Set(places.map((place) => place.best));
  const alternatives = [...new Set(places.flatMap((place) => place.others))].filter((word) => !best.has(word));
  return {
    text: lines.map((line) => line.sort((a, b) => a.x - b.x).map((place) => place.best).join(' ')).join('\n'),
    words: places.length,
    alternatives,
  };
}
