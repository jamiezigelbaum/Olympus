/**
 * The Node-loaded plugin entry must not import `bun:sqlite`.
 *
 * OpenClaw loads `dist/index.js` in Node, where `bun:sqlite` does not exist, so
 * one such import fails the plugin before `register` runs ("deploy tests 3/3",
 * #101, 2026-09-24). Bun's bundler tree-shakes the SQLite-backed stores out of
 * this entry only while nothing in their modules has a side effect at load: a
 * class-field initializer (`private x = new Set()`) is one, and it pulled
 * LocalConnectorStore — and bun:sqlite with it — into the bundle. The worker
 * CLI (dist/cli.js) runs under Bun and may import it freely.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');

describe('plugin bundle', () => {
  test('dist/index.js carries no bun:sqlite import', () => {
    const bundle = readFileSync(join(ROOT, 'dist/index.js'), 'utf8');
    expect(bundle.includes('bun:sqlite')).toBe(false);
  });
});
