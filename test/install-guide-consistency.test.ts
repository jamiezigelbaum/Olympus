import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

// Repeated clean-install failures came from copied commands drifting apart.
// Keep the commands in the public entry points on the qualified package path.
describe('pilot installation entry points', () => {
  for (const path of ['README.md', 'INSTALL_FOR_AGENTS.md', 'docs/QUICKSTART.md', 'docs/V0_4_RELEASE.md']) {
    test(`${path} installs the qualified archive with host-version consent guidance`, () => {
      const document = readFileSync(join(ROOT, path), 'utf8');
      const commands = [...document.matchAll(/openclaw plugins install npm-pack:[^\n`]+/g)];
      expect(commands.length).toBeGreaterThan(0);
      for (const [command] of commands) {
        expect(command).toContain('--force');
        expect(command).toContain('--accept-capabilities');
      }
      expect(document).toContain('2026.7.1');
      expect(document).toMatch(/omit both|re-run with no flags/i);
      expect(document).toMatch(/SHA-256/);
      expect(document).toContain('byte count');
      expect(document).not.toMatch(/openclaw plugins install git:/);
    });
  }

  test('the manual quickstart resolves the managed executable before setup commands', () => {
    const document = readFileSync(join(ROOT, 'docs/QUICKSTART.md'), 'utf8');
    const resolution = document.indexOf('OLYMPUS_BIN="$OLYMPUS_ROOT/bin/olympus"');
    expect(resolution).toBeGreaterThan(0);
    expect(document).toContain('olympus() { "$OLYMPUS_BIN" "$@"; }');
    expect(resolution).toBeLessThan(document.indexOf('\nolympus sensitivity validate'));
  });
});
