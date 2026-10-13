import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundledPackages, NOTICES_FILE, noticedPackages, renderNotices } from '../scripts/build-third-party-notices.ts';
import { V0_4_PUBLIC_PACKAGE_FILES } from '../src/core/public-surface.ts';

const ROOT = join(import.meta.dir, '..');

describe('third-party notices', () => {
  test('every npm package bundled into dist/ has its notice in THIRD_PARTY_NOTICES.md', () => {
    const bundled = bundledPackages(ROOT);
    expect(bundled.length).toBeGreaterThan(0);
    const noticed = noticedPackages(readFileSync(join(ROOT, NOTICES_FILE), 'utf8'));
    expect(bundled.filter((name) => !noticed.includes(name))).toEqual([]);
  });

  test('THIRD_PARTY_NOTICES.md matches what the installed packages say (versions, copyrights, licence text)', () => {
    // Regenerate with `bun scripts/build-third-party-notices.ts` after a dependency change.
    expect(readFileSync(join(ROOT, NOTICES_FILE), 'utf8')).toBe(renderNotices(ROOT));
  });

  test('the notices ship in the release package', () => {
    expect(V0_4_PUBLIC_PACKAGE_FILES).toContain(NOTICES_FILE);
  });
});
