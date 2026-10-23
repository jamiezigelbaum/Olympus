/**
 * Every database a process opens in src/ and scripts/ goes through
 * openStoreDatabase (core/store-open.ts), which takes shared store custody
 * first. Delete indexed data needs custody exclusive to prove nothing has a
 * store open, so a raw open is a hole in that proof. A new raw open fails here;
 * the allowlist names each exception and why it is safe.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');
const ALLOWED: Record<string, string> = {
  'src/core/store-open.ts': 'the boundary itself',
  'src/core/file-lease.ts': 'opens the lock databases themselves (custody cannot take custody of itself)',
  'src/data-lifecycle.ts': 'the deleter and exporter: they hold custody exclusive (delete) or shared (export, by the CLI) around every open',
  'src/workers/apple-messages/connector.ts': 'reads the macOS Messages chat.db, which is not an Olympus store and is never deleted by Olympus',
};

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') sources(path, out); }
    else if (/\.(ts|tsx|mts|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

// `new Database(`, `new DatabaseSync(`, `new BunDatabase(`: any constructor named like a database.
const RAW_OPEN = /\bnew\s+\w*Database\w*\s*\(/;
const ALIASED_IMPORT = /import\s*\{[^}]*\bDatabase\s+as\s+\w+/;

describe('store opens go through the custody boundary', () => {
  const files = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'scripts'))];

  test('no raw database open outside the allowlist', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (rel in ALLOWED) continue;
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, index) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (RAW_OPEN.test(line) || ALIASED_IMPORT.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, 'open stores with openStoreDatabase() from core/store-open.ts').toEqual([]);
  });

  test('every allowlisted file still exists and still needs its entry', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      expect(RAW_OPEN.test(text) || rel === 'src/core/store-open.ts', `${rel} no longer opens a database directly: drop its allowlist entry`).toBe(true);
    }
  });

  test('the boundary takes shared custody before opening', () => {
    const text = readFileSync(join(ROOT, 'src/core/store-open.ts'), 'utf8');
    expect(text.indexOf('holdStoreCustodyShared()')).toBeGreaterThan(-1);
    expect(text.indexOf('holdStoreCustodyShared()')).toBeLessThan(text.lastIndexOf('new Database('));
  });
});
