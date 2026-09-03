import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';

const REPO_ROOT = resolve(import.meta.dir, '..');

const RETIRED_PROMISES = [
  {
    label: 'connector-store X results expose direct URLs',
    pattern: /\bdirect X URLs\b/i,
  },
  {
    label: 'connector-store X results expose actual URLs',
    pattern: /\bactual X\/Twitter URLs\b/i,
  },
  {
    label: 'connector-store X evidence returns URLs',
    pattern: /\breturn the X URLs from that evidence\b/i,
  },
  {
    label: 'connector-store X result is assumed to carry a returned URL',
    pattern: /\bspecific returned (?:public )?X URL\b/i,
  },
  {
    label: 'Dropbox folder request routes through locator release',
    pattern: /\basks? for (?:Dropbox )?(?:full )?paths, folders, Finder links\b/i,
  },
  {
    label: 'Dropbox folder request is grouped with supported file locator asks',
    pattern: /\basks? for files, folders, paths, locators\b/i,
  },
] as const;

function staleGuidanceFindings(root: string): string[] {
  const findings: string[] = [];
  for (const tree of ['skills', 'docs'] as const) {
    const treeRoot = join(root, tree);
    for (const relativePath of new Glob('**/*.md').scanSync({ cwd: treeRoot })) {
      const content = readFileSync(join(treeRoot, relativePath), 'utf8').replace(/\s+/g, ' ');
      for (const promise of RETIRED_PROMISES) {
        if (promise.pattern.test(content)) {
          findings.push(`${tree}/${relativePath}: ${promise.label}`);
        }
      }
    }
  }
  return findings.sort();
}

describe('source locator guidance drift guard', () => {
  test('skills and docs do not carry retired X URL or Dropbox folder-locator promises', () => {
    expect(staleGuidanceFindings(REPO_ROOT)).toEqual([]);
  });

  test('the grep guard detects retired promises in either documentation tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-source-locator-guidance-'));
    try {
      mkdirSync(join(root, 'skills'), { recursive: true });
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'skills', 'stale.md'), 'Bookmark results may return direct X URLs.');
      writeFileSync(
        join(root, 'docs', 'stale.md'),
        'When the owner asks for Dropbox paths, folders, Finder links, use locator release. Inspect a specific returned public X URL.',
      );

      expect(staleGuidanceFindings(root)).toEqual([
        'docs/stale.md: Dropbox folder request routes through locator release',
        'docs/stale.md: connector-store X result is assumed to carry a returned URL',
        'skills/stale.md: connector-store X results expose direct URLs',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
