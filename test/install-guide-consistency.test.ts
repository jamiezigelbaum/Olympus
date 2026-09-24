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
    expect(download).toContain('https://api.github.com/repos/jamiezigelbaum/Olympus/releases/tags/v0.4.0-beta.5');
    expect(download).toContain('https://github.com/jamiezigelbaum/Olympus/releases/download/v0.4.0-beta.5/olympus-0.4.0-beta.5.tgz');
    expect(download).toContain('without authentication');
    expect(download).toContain('Select exactly one uploaded asset');
    const selectedAsset = /Select exactly one uploaded asset named `([^`]+)`/.exec(install)?.[1];
    expect(selectedAsset).toBeDefined();
    const manualAsset = /choose `([^`]+)` under Assets/.exec(readFileSync(join(ROOT, 'docs/QUICKSTART.md'), 'utf8'))?.[1];
    expect(manualAsset).toBe(selectedAsset);
    expect(download).toContain('Do not use `/releases/latest`');
    expect(download).toContain('8d4a3daa37a3b093c82116b15fc35768f4d0386cc37a6f48b289559d56656ba3');
    expect(download).toContain('Byte count: `1196587`');
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

  test('a Control UI operator is pointed at the Olympus sidebar entry, not asked for an address', () => {
    // 2026-09-24 beta.5 fresh install: the agent asked the operator for the
    // address in their browser's address bar while Olympus was already in
    // the sidebar of the page they were chatting in.
    const document = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const where = document.slice(document.indexOf('**Where to open it.**'), document.indexOf('Deliver this required user-facing handoff'));
    expect(where).toContain('**Olympus** entry already in the sidebar');
    expect(where).toContain('do not ask for the address');
    expect(document).toContain('which becomes `Open **Olympus** in the sidebar on the left.`');
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
    // 2026-09-24 beta.4 test: a literal agent skipped the classifier gate and
    // its summary never mentioned it, so the decision is a receipt line.
    expect(section).toContain('**Privacy classifier decision.**');
    expect(section).toContain('olympus tier classifier status');
    for (const outcome of ['**approved**', '**declined**', '**refused**', '**not applicable**']) {
      expect(section).toContain(outcome);
    }
    expect(section.replace(/\s+/g, ' ')).toContain('Do not send the dashboard handoff until this line reads one of');
    expect(section.replace(/\n>\s*/g, ' ')).toContain('Privacy classifier: `<approved, declined, refused (reason), or not applicable (no-sensitive)>`');
    const handoffRules = document.slice(handoff - 3000, handoff).replace(/\s+/g, ' ');
    expect(handoffRules).toContain('Deliver this required user-facing handoff **verbatim**');
    expect(handoffRules).toContain('`/plugin?plugin=olympus&id=dashboard` on the Gateway origin');
    expect(handoffRules).toContain('it needs no ticket and does not expire.');
    expect(handoffRules).toContain('`http://127.0.0.1:8010/…`');
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

  test('the agent guide requires the gateway restart and gates the private classifier', () => {
    const document = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const step5 = document.slice(
      document.indexOf('## Step 5 — Validate, then restart the gateway'),
      document.indexOf('## Step 6 — Finish installation'),
    );
    expect(step5).toContain('**This restart is required on every OpenClaw install. Do not skip it and do\nnot tell the operator "no restart needed."**');
    const gate = document.slice(
      document.indexOf('### Privacy classifier approval — its own consent gate'),
      document.indexOf('## Step 4 — Verify the worker'),
    );
    // The browser flow skips the headless fallback, so its own instruction must
    // send the agent to the gate before Steps 4-5, and the fallback must not
    // claim the gate as headless-only.
    const browserFlow = document.slice(
      document.indexOf('For the normal browser flow,'),
      document.indexOf('### Headless credential fallback'),
    );
    expect(browserFlow).toContain('(#privacy-classifier-approval--its-own-consent-gate)');
    expect(browserFlow.indexOf('privacy classifier approval')).toBeLessThan(browserFlow.indexOf('Steps 4–5'));
    expect(document).toContain('the privacy classifier approval\nafter it applies to everyone');
    expect(document.indexOf('### Privacy classifier approval')).toBeLessThan(document.indexOf('## Step 4 — Verify the worker'));
    expect(gate).toContain('olympus tier classifier status');
    for (const refusal of ['standard_cloud', 'unsupported_provider', 'outside_private_policy', 'no_private_lane']) {
      expect(gate).toContain(refusal);
    }
    expect(gate.replace(/>\s*/g, '').replace(/\s+/g, ' ')).toContain('labels and sender');
    expect(gate).toContain('olympus tier classifier approve --why');
    expect(gate).toContain('never an ordinary cloud model');
    expect(gate).toContain('olympus tier classifier decline');
    expect(gate).not.toContain('record nothing');
    expect(gate).toContain('Privacy\nclassifier: not applicable (no-sensitive)');
    expect(document).toContain('- **Privacy classifier approval** (end of Step 3)');
    // The receipt reads the recorded `decision` field, and its outcomes are
    // exactly the ones Step 3 can leave behind.
    const receipt = document.slice(
      document.indexOf('- **Privacy classifier decision.**'),
      document.indexOf('A provider key being present'),
    );
    for (const decision of ['`approved`', '`declined`', '`refused`', '`not_applicable`', '`not_asked`']) {
      expect(receipt).toContain(decision);
      expect(gate).toContain(decision === '`refused`' ? '`refused` reason' : decision);
    }
  });

  test('Step 5 asks the Custom plugin UI opt-in before the restart, with a standalone fallback', () => {
    const document = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const step5 = document.slice(
      document.indexOf('## Step 5 — Validate, then restart the gateway'),
      document.indexOf('## Step 6 — Finish installation'),
    );
    const optIn = step5.indexOf('**Custom plugin UI opt-in (its own Rule one gate, before the restart).**');
    expect(optIn).toBeGreaterThan(0);
    expect(optIn).toBeLessThan(step5.indexOf('openclaw gateway restart\n```'));
    const text = step5.slice(optIn).replace(/>\s*/g, '').replace(/\s+/g, ' ');
    expect(text).toContain('Settings → Labs → Custom plugin UI');
    expect(text).toContain('gateway.controlUi.experimental.customPlugins');
    expect(text).toContain('every plugin you have installed, not only Olympus');
    expect(text).toContain('On a no, record nothing, leave it off, and use the standalone opening link in Step 6');
    expect(document).toContain('- **Custom plugin UI opt-in** (Step 5, before the restart)');
  });

  test('the posture is never a pick-list before the explanation and sensitivity conversation', () => {
    const document = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const rule = document.indexOf('**No pick-list before the explanation — question tools included.**');
    const explanation = document.indexOf('**Required user-facing four-tier explanation.**');
    expect(rule).toBeGreaterThan(0);
    expect(rule).toBeLessThan(explanation);
    const text = document.slice(rule, explanation).replace(/\s+/g, ' ');
    expect(text).toContain('question tool');
    expect(text).toContain('never a bare preset id');
    expect(text).toContain('sensitivity conversation');
  });

  test('Step 0 installs Bun without unzip or sudo when those are missing', () => {
    const document = readFileSync(join(ROOT, 'INSTALL_FOR_AGENTS.md'), 'utf8');
    const step0 = document.slice(document.indexOf('## Step 0 — Preflight'), document.indexOf('## Step 1 — Install the plugin'));
    expect(step0).toContain('command -v unzip');
    expect(step0).toContain('npm install -g --prefix "$HOME/.local" bun');
    expect(step0).toContain('bun.exe');
    expect(step0).toContain('npm install -g --prefix "$HOME/.local" --ignore-scripts=false bun');
    expect(step0).toContain('no unzip or sudo: see "Installing Bun" below');
    expect(step0).toContain('Never ask the operator to run a `sudo` command you can avoid.');
  });

  test('the standalone opening link lifetime matches the ticket TTL everywhere', () => {
    for (const path of ['INSTALL_FOR_AGENTS.md', 'docs/QUICKSTART.md', 'src/workers/dashboard/components.ts']) {
      const document = readFileSync(join(ROOT, path), 'utf8').replace(/\s+/g, ' ');
      expect(document).toContain('expires after fifteen minutes');
      expect(document).not.toContain('expires after two minutes');
    }
  });

  test('entry points state the OpenClaw Node range, not a stale one', () => {
    for (const path of ['README.md', 'INSTALL_FOR_AGENTS.md', 'docs/QUICKSTART.md']) {
      const document = readFileSync(join(ROOT, path), 'utf8');
      expect(document).toContain('>=24.16.0 <25');
      expect(document).toContain('npm view openclaw engines');
      expect(document).not.toContain('24.15.0');
      expect(document).not.toContain('22.22.3');
    }
  });
});
