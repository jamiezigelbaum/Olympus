// Every item a source brings in is judged on its own and lands in the store
// its tier names: a lane writes only through its tier set. A lane that wrote
// straight into one store skipped that judgment; Dropbox, local files,
// WhatsApp, Readwise and X each kept such a path until 2026-10-29. So outside
// the store layer itself, only the tiered extraction sink (which lands text
// in the store the set already chose) writes into a store directly.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('tier paths', () => {
  test('no source writes into a store except through its tier set', () => {
    const writing = sourceFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => !path.startsWith('workers/connector-store/'))
      .filter((path) => /\.(syncFromConnector|syncAndEmbedFromConnector)\(|\bsyncAndEmbedFromConnector\(/.test(readFileSync(join(SRC, path), 'utf8')));
    expect(writing).toEqual(['workers/file-extraction/tiered-store-sink.ts']);
  });
});
