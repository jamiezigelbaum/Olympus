import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macosHelperFileName } from '../scripts/macos-helper-name.ts';

test('the helper name changes with each build input, but not the package version', () => {
  const root = mkdtempSync(join(tmpdir(), 'helper-name-'));
  try {
    mkdirSync(join(root, 'native/macos-engine-host'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    const paths = ['native/macos-engine-host/main.c', 'native/macos-engine-host/Info.plist.in', 'scripts/build-macos-helper.sh'];
    for (const path of paths) writeFileSync(join(root, path), path);
    const original = macosHelperFileName(root);
    expect(original).toMatch(/^olympus-engine-helper-[0-9a-f]{16}\.zip$/);
    writeFileSync(join(root, 'package.json'), '{"version":"9.9.9"}');
    expect(macosHelperFileName(root)).toBe(original);
    for (const path of paths) {
      writeFileSync(join(root, path), `${path} changed`);
      expect(macosHelperFileName(root)).not.toBe(original);
      writeFileSync(join(root, path), path);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
