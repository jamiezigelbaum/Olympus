import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

// Repeated clean-install failures came from copied commands drifting apart.
// Keep the commands in the public entry points on the qualified package path.
describe('pilot installation entry points', () => {
  test('the repo and quickstart offer the same self-contained installation prompt', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const quickstart = readFileSync(join(ROOT, 'docs/QUICKSTART.md'), 'utf8');
    const prompt = readme.match(/^> Install Olympus by reading .+$/m)?.[0];
    expect(prompt).toBeDefined();
    expect(prompt).toContain('https://raw.githubusercontent.com/jamiezigelbaum/Olympus/main/INSTALL_FOR_AGENTS.md');
    expect(quickstart).toContain(prompt!);
    expect(readme).not.toContain('Give it those files');
    expect(quickstart.replace(/\s+/g, ' ')).not.toContain('supplied receipt');
  });

  test('the agent obtains exact package identity without a user receipt or authentication', () => {
    const install = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const download = install.slice(install.indexOf('### Pilot download'), install.indexOf('Success looks like'))
      .replace(/\s+/g, ' ');
    expect(download).toContain('https://api.github.com/repos/jamiezigelbaum/Olympus/releases/tags/v0.4.0-beta.3');
    expect(download).toContain('https://github.com/jamiezigelbaum/Olympus/releases/download/v0.4.0-beta.3/olympus-0.4.0-beta.3.tgz');
    expect(download).toContain('without authentication');
    expect(download).toContain('Select exactly one uploaded asset');
    const selectedAsset = /Select exactly one uploaded asset named `([^`]+)`/.exec(install)?.[1];
    expect(selectedAsset).toBeDefined();
    const manualAsset = /choose `([^`]+)` under Assets/.exec(readFileSync(join(ROOT, 'docs/QUICKSTART.md'), 'utf8'))?.[1];
    expect(manualAsset).toBe(selectedAsset);
    expect(download).toContain('Do not use `/releases/latest`');
    expect(download).toContain('e286b19d3117ae83f82064ec05fc9e208afb0861d9ef60456c7f11220c004c78');
    expect(download).toContain('Byte count: `1052877`');
    expect(download).toContain("metadata's digest and size to match the pinned values");
    expect(download).toContain('Do not extract, execute, or install an archive unless both match');
    expect(download).toContain('missing digest, ambiguous asset, or checksum/size mismatch stops installation');
    expect(download).toContain('retaining the existing-install and consent checks');
    expect(download).toContain('Execute its plugin install command exactly once');
    expect(download).toContain('skip any candidate-selection/download section in the packaged guide');
    expect(download).toContain('The Olympus pilot download is not available yet; the maintainer needs to publish it.');
    expect(install).not.toContain('**ASK THE OPERATOR** for the candidate and receipt');
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
    const handoff = document.indexOf('> Olympus is installed. [Open your Olympus dashboard](<verified-dashboard-url>).');
    expect(receipt).toBeGreaterThan(0);
    expect(receipt).toBeLessThan(handoff);
    const section = document.slice(receipt, handoff);
    expect(section).toContain('Gemini — every posture');
    expect(section).toContain('Venice — only when the posture uses it');
    expect(section).toContain('Private embeddings');
    expect(section).toContain('approved cost');
    expect(section).toContain('Preserve existing vectors');
    expect(section).toContain('worker_credential_lanes');
    expect(section).toContain('source_index_status');
    expect(section).toContain('email_worker');
    expect(section).toContain('Skipped');
    expect(section).toContain('key being present');
    expect(section).toContain('keep source Connect unopened');
    expect(document).toContain('Sources are the point of');
    expect(document).toContain('dashboard\nhandoff that lets them choose is required');
    expect(document).toContain('/plugin?plugin=olympus&id=dashboard');
    expect(document).toContain('> Olympus is as useful as the sources you give it.');
    expect(document).toContain('**Background** shows syncing, extraction, and embeddings');
    expect(document).toContain('Come back here if');
  });

  test('the agent guide leaves model keys to the dashboard in the browser flow', () => {
    const document = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const step3 = document.slice(
      document.indexOf('## Step 3 — Model setup in the dashboard'),
      document.indexOf('### Headless credential fallback'),
    );
    expect(step3).toContain('**Model keys are entered in the dashboard, not collected by you.**');
    expect(step3).toContain("not through OpenClaw's own secret prompt or store");
    expect(document).toContain('Gemini API key (source embeddings, all presets; headless fallback only)');
    expect(document).toContain('report\nit as "finished in the dashboard\'s Models section" and continue');
  });
});
