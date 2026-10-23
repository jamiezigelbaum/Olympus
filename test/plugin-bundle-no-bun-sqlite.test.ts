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
    // Any module-loading form fails under Node. The file lease's one
    // runtime require is reached only behind a Bun check, so it is allowed,
    // and only that exact gated form.
    const uses = [...bundle.matchAll(/[\s\S]{0,160}bun:sqlite/g)].map((match) => match[0]);
    expect(uses.every((use) => /typeof globalThis\.Bun !== "undefined"\) \{\s*const \{ Database \} = runtimeRequire\("bun:sqlite$/.test(use))).toBe(true);
    expect(uses.length).toBeLessThanOrEqual(1);
  });
});
