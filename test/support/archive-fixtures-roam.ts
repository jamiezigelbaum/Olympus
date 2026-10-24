/**
 * Synthetic Roam exports built in code, for tests and for the release check:
 * pages of nested blocks as Roam's "Export All" JSON writes them, and a zip
 * holding that JSON. Nothing here is a real export; the shapes are the ones
 * the connector reads (archive-import/roam), each page carrying a search word
 * of its own so a question can find it.
 */
import { buildZip, type ZipFixtureEntry } from '../helpers/zip-fixture.ts';

export interface RoamBlockInput {
  string: string;
  uid?: string;
  'create-time'?: number;
  'edit-time'?: number;
  children?: readonly RoamBlockInput[];
}

export interface RoamPageInput {
  title?: string;
  uid?: string;
  'create-time'?: number;
  'edit-time'?: number;
  children?: readonly RoamBlockInput[];
}

/** A Roam JSON export: a list of pages. */
export function roamJson(pages: readonly (RoamPageInput | Record<string, unknown>)[], pretty = false): string {
  return pretty ? JSON.stringify(pages, null, 2) : JSON.stringify(pages);
}

/** A numbered run of ordinary pages, each with a nested block and a word of its own. */
export function roamPages(count: number, word = 'lighthouse'): RoamPageInput[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Synthetic ${word} page ${index}`,
    uid: `${word}-${index}`,
    'create-time': Date.UTC(2024, 5, 1 + index, 9),
    'edit-time': Date.UTC(2024, 5, 1 + index, 10),
    children: [
      {
        string: `The synthetic ${word} log, entry ${index}`,
        uid: `${word}-${index}-b1`,
        'create-time': Date.UTC(2024, 5, 1 + index, 9, 1),
        children: [{ string: `Nested detail ${index} with [[${word}]]`, uid: `${word}-${index}-b2`, 'edit-time': Date.UTC(2024, 5, 1 + index, 10, 5) }],
      },
    ],
  }));
}

/** A zip holding the JSON ("Export All" delivers an archive). */
export function roamJsonZip(
  json: string,
  options: { name?: string; method?: 'stored' | 'deflate'; extra?: readonly ZipFixtureEntry[]; before?: readonly ZipFixtureEntry[] } = {},
): Uint8Array {
  return buildZip([
    ...(options.before ?? []),
    { name: options.name ?? 'roam-export.json', data: json, method: options.method ?? 'deflate' },
    ...(options.extra ?? []),
  ]);
}
