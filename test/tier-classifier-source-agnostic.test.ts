// The tier classifier and the store's placement/recording layer may read
// SIGNAL KINDS only. They never branch on which source an item came from
// (AGENTS.md: only SourceConnector is per-source). Two checks: no source name
// appears as a literal in these modules, and identical signals and text get an
// identical decision whatever provider the item claims.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';

// Built at runtime so the repository's credential-pattern check never sees a
// literal key in the diff (the same approach as test/credential-pattern-check.test.ts).
const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

const MODULES = [
  'src/workers/classification/tier-classifier.ts',
  'src/workers/classification/tier-ledger.ts',
  'src/workers/classification/tier-ledger-path.ts',
  'src/workers/connector-store/tier-placement.ts',
  'src/core/classification-signals.ts',
  // The one sender matcher owner sender rules use; scanned like the rest.
  'src/core/sender-rules.ts',
  'src/workers/classification/tier-rules.ts',
  'src/workers/classification/sniffer.ts',
  'src/workers/classification/sniffer-store.ts',
  'src/workers/classification/sniffer-resolver.ts',
  'src/workers/classification/installed-tier-classification.ts',
];

// Everything these modules may import. A new import has to be added here on
// purpose, so a per-source constant cannot arrive through an import.
const IMPORT_ALLOWLIST = new Set([
  'node:fs',
  'node:path',
  'bun:sqlite',
  '../../core/contracts.ts',
  '../../core/sender-rules.ts',
  '../../core/sensitivity-map.ts',
  '../../core/source-index/types.ts',
  '../../core/sqlite-migrations.ts',
  '../../core/sqlite-store.ts',
  '../classification/engine.ts',
  '../classification/tier-classifier.ts',
  '../classification/tier-ledger.ts',
  './contracts.ts',
  './engine.ts',
  './source-index/types.ts',
  './tier-classifier.ts',
  './tier-ledger-path.ts',
  // Phase P2: owner rules, the privacy-safe sniffer and its background pass.
  'node:crypto',
  'node:os',
  '../../core/analyst.ts',
  '../../core/atomic-file.ts',
  '../../core/operation-error.ts',
  '../../core/sender-rules.ts',
  '../classification/installed-tier-classification.ts',
  './delphi-scorer.ts',
  './sniffer.ts',
  './sniffer-lane.ts',
  './sniffer-store.ts',
  './tier-ledger.ts',
  './tier-rules.ts',
]);

const SOURCE_NAMES = [
  'gmail',
  'google',
  'gdrive',
  'dropbox',
  'readwise',
  'telegram',
  'whatsapp',
  'apple',
  'imessage',
  'roam',
  'reflect',
  'twitter',
  'x_bookmarks',
  'xbookmarks',
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
    test(`${modulePath} names no source anywhere in code and imports only allowlisted modules`, () => {
      const raw = readFileSync(join(import.meta.dir, '..', modulePath), 'utf8');
      // The one sanctioned comparison: an owner rule that names a source is
      // matched against the item's provider as opaque data the owner wrote.
      const code = codeWithoutComments(raw).toLowerCase()
        .replace('rule.source !== undefined && rule.source !== provider', '');
      for (const name of SOURCE_NAMES) {
        // Identifiers, string literals, template literals, regex literals and
        // prefixes alike ("gmail_", "dropboxpath").
        const hit = code.match(new RegExp(`(?<![a-z0-9])${name}`));
        expect(hit?.[0]).toBeUndefined();
      }
      // The one-letter X provider id only as a quoted literal or a prefix of one.
      expect(code.match(/['"\`]x(?:[._:'"\`])/)?.[0]).toBeUndefined();
      // No comparison against the item's provider, connector or family.
      expect(code.match(/(?:provider|connector\.id|\.family)\s*[!=]==?/)?.[0]).toBeUndefined();
      expect(code.match(/[!=]==?\s*(?:\w+\.)?(?:provider|family)\b/)?.[0]).toBeUndefined();
      expect(code).not.toContain('switch (input.provider');
      expect(code).not.toContain('switch (item.identity.provider');

      const imports = [...raw.matchAll(/(?:^|\n)\s*(?:import|export)[^'";]*?from\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);
      for (const specifier of imports) expect(`${modulePath} -> ${specifier}:${IMPORT_ALLOWLIST.has(specifier)}`).toBe(`${modulePath} -> ${specifier}:true`);
    });
  }

  test('identical signals and text decide identically for every provider', () => {
    const cases = [
      { signals: { title: 'Garden plan' }, text: 'weekly notes' },
      { signals: { title: 'biopsy results' }, text: 'The lab results confirm the diagnosis for the patient.' },
      { signals: { title: 'launch', sharing: 'public_link' as const }, text: 'hello world' },
      { signals: { title: 'env', path: '/cfg/env' }, text: FAKE_AWS_KEY },
      { signals: { title: 'chat', prior: { tier: 'secure' as const, strength: 'prior' as const, basis: 'b' } }, text: 'hi' },
    ];
    for (const entry of cases) {
      const decisions = ['gmail', 'dropbox', 'telegram', 'whatsapp', 'readwise', 'x', 'unknown-provider'].map((provider) =>
        classifyItemTiers({ signals: entry.signals, text: entry.text, provider }));
      for (const decision of decisions) expect(decision).toEqual(decisions[0]!);
    }
  });
});
