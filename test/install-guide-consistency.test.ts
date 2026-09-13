import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

// Repeated clean-install failures came from copied commands drifting apart.
// Keep the commands in the public entry points on the qualified package path.
describe('pilot installation entry points', () => {
  test('the candidate guide keeps the supplied archive and its exact identity', () => {
    const install = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const quickstart = readFileSync(join(ROOT, 'docs/QUICKSTART.md'), 'utf8');
    expect(readme).toContain('Verify the supplied Olympus tarball against its SHA-256 and byte count.');
    expect(readme).toContain('Use those exact');
    expect(quickstart).toContain("maintainer's qualified Olympus tarball, SHA-256, and byte count");
    expect(install).toContain('**ASK THE OPERATOR** for the candidate and receipt if either is missing');
    expect(install).toContain('SHA-256');
    expect(install).not.toContain('### Pilot download');
    expect(install).not.toContain('/releases/download/v0.4.0-pilot.1/');
  });

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

  test('the agent guide requires provider readiness before source Connect', () => {
    const document = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const receipt = document.indexOf('**Pre-source completion receipt — mandatory before inviting Connect.**');
    const handoff = document.indexOf('> Setup is complete. In the Olympus dashboard, connect the sources you use.');
    expect(receipt).toBeGreaterThan(0);
    expect(receipt).toBeLessThan(handoff);
    const section = document.slice(receipt, handoff);
    expect(section).toContain('Gemini — every posture');
    expect(section).toContain('Venice — only when the posture uses it');
    expect(section).toContain('secure embeddings');
    expect(section).toContain('approved cost');
    expect(section).toContain('Preserve existing vectors');
    expect(section).toContain('worker_credential_lanes');
    expect(section).toContain('source_index_status');
    expect(section).toContain('email_worker');
    expect(section).toContain('Skipped');
    expect(section).toContain('key being present');
    expect(section).toContain('keep source Connect unopened');
  });
});
