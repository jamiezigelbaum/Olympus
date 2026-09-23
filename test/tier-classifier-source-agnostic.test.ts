// The tier classifier and the store's placement/recording layer may read
// SIGNAL KINDS only. They never branch on which source an item came from
// (AGENTS.md: only SourceConnector is per-source). Two checks: no source name
// appears as a literal in these modules, and identical signals and text get an
// identical decision whatever provider the item claims.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';

const MODULES = [
  'src/workers/classification/tier-classifier.ts',
  'src/workers/classification/tier-ledger.ts',
  'src/workers/connector-store/tier-placement.ts',
  'src/core/classification-signals.ts',
];

const SOURCE_NAMES = [
  'gmail',
  'google',
  'drive',
  'dropbox',
  'readwise',
  'telegram',
  'whatsapp',
  'apple_messages',
  'imessage',
  'roam',
  'reflect',
  'twitter',
  'x',
  'x_bookmarks',
  'slack',
  'notion',
];

function codeWithoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('tier classification is source-agnostic', () => {
  for (const modulePath of MODULES) {
    test(`${modulePath} names no source in code`, () => {
      const code = codeWithoutComments(readFileSync(join(import.meta.dir, '..', modulePath), 'utf8')).toLowerCase();
      for (const name of SOURCE_NAMES) {
        // A string literal equal to, or starting with, a source name is a
        // branch on that source (or a table keyed by it).
        const hit = code.match(new RegExp(`['"\`]${name}(?:[._:'"\`])`));
        expect(hit?.[0]).toBeUndefined();
      }
      expect(code).not.toContain('identity.provider ===');
      expect(code).not.toContain('connector.id ===');
    });
  }

  test('identical signals and text decide identically for every provider', () => {
    const cases = [
      { signals: { title: 'Garden plan' }, text: 'weekly notes' },
      { signals: { title: 'biopsy results' }, text: 'The lab results confirm the diagnosis for the patient.' },
      { signals: { title: 'launch', sharing: 'public_link' as const }, text: 'hello world' },
      { signals: { title: 'env', path: '/cfg/env' }, text: 'AKIAABCDEFGHIJKLMNOP' },
      { signals: { title: 'chat', prior: { tier: 'secure' as const, strength: 'prior' as const, basis: 'b' } }, text: 'hi' },
    ];
    for (const entry of cases) {
      const decisions = ['gmail', 'dropbox', 'telegram', 'whatsapp', 'readwise', 'x', 'unknown-provider'].map((provider) =>
        classifyItemTiers({ signals: entry.signals, text: entry.text, provider }));
      for (const decision of decisions) expect(decision).toEqual(decisions[0]!);
    }
  });
});
