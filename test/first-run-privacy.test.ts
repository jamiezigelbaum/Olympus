import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPendingPrivacyPolicy, isPendingPrivacyPolicy, saveFirstRunPrivacyChoice } from '../src/core/first-run-privacy.ts';
import { engineServicePaths, seedEngineSovereignty } from '../src/core/engine-service.ts';
import { ModelSetupService } from '../src/core/model-setup.ts';
import { loadSovereigntyPreset, validateSovereigntyConfig, writeSovereigntyConfigFile } from '../src/core/sovereignty.ts';

test('pending policy disables remote answer routes and each choice is saved once', () => {
  for (const choice of ['local-first', 'local-only', 'private-cloud-only', 'no-sensitive'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-first-privacy-'));
    try {
      const path = join(dir, 'sovereignty.json');
      const pending = createPendingPrivacyPolicy();
      expect(isPendingPrivacyPolicy(pending)).toBe(true);
      expect(pending.routes.internal?.mode).toBe('disabled');
      expect(pending.routes.secure_local?.mode).toBe('disabled');
      writeSovereigntyConfigFile({ path, config: pending });
      expect(saveFirstRunPrivacyChoice(path, choice)).toMatchObject({ ok: true, changed: true });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(loadSovereigntyPreset(choice));
      expect(saveFirstRunPrivacyChoice(path, 'local-first')).toMatchObject({ ok: true, changed: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('existing policies are never treated as a pending first run', () => {
  for (const choice of ['local-first', 'local-only', 'private-cloud-only', 'no-sensitive'] as const) {
    expect(isPendingPrivacyPolicy(loadSovereigntyPreset(choice))).toBe(false);
  }
});

test('a new engine waits for a choice and does not replace an existing policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-first-install-'));
  try {
    const path = join(dir, 'sovereignty.json');
    seedEngineSovereignty(path);
    const pending = JSON.parse(readFileSync(path, 'utf8'));
    expect(isPendingPrivacyPolicy(pending)).toBe(true);
    const status = new ModelSetupService({ config: pending, credentialState: () => 'ready', autoCheck: false }).getStatus();
    expect(status.ready).toBe(false);
    expect(status.privacy_choice_pending).toBe(true);
    saveFirstRunPrivacyChoice(path, 'local-only');
    seedEngineSovereignty(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(loadSovereigntyPreset('local-only'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test.each(['env', 'inline', 'custom-path'] as const)('agent setup preserves an existing %s policy without the default policy file', mode => {
  const home = mkdtempSync(join(tmpdir(), 'olympus-policy-upgrade-'));
  try {
    mkdirSync(join(home, '.olympus'));
    const env = { ...process.env, HOME: home, OLYMPUS_CONFIG: join(home, '.olympus', 'config.json'),
      OLYMPUS_SOVEREIGNTY_CONFIG: '', OLYMPUS_SOVEREIGNTY_CONFIG_PATH: '' };
    const paths = engineServicePaths({ env });
    mkdirSync(dirname(paths.configPath), { recursive: true });
    writeFileSync(paths.configPath, JSON.stringify({})); // an installed host, not just this shell
    const policy = loadSovereigntyPreset('local-only');
    if (mode === 'env') {
      mkdirSync(dirname(paths.workerEnvPath), { recursive: true });
      writeFileSync(paths.workerEnvPath, 'OLYMPUS_ARGUS_BASE_URL=http://127.0.0.1:11434/v1\n');
    }
    if (mode === 'inline') writeFileSync(paths.configPath, JSON.stringify({ sovereignty: { policy } }));
    if (mode === 'custom-path') {
      const path = join(home, 'custom-policy.json');
      writeFileSync(path, JSON.stringify(policy));
      writeFileSync(paths.configPath, JSON.stringify({ sovereignty: { configPath: path } }));
    }
    const result = Bun.spawnSync([process.execPath, 'src/cli.ts', 'setup', '--privacy-options'], { env });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).state).toBe('configured');
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('earlier pending policies acquire the durable marker even after a Personal model change', () => {
  const legacy = createPendingPrivacyPolicy();
  delete legacy.privacyChoicePending;
  const changedModels = loadSovereigntyPreset('local-first');
  Object.assign(legacy.modelProfiles, changedModels.modelProfiles);
  legacy.routes.internal = changedModels.routes.internal!;
  const loaded = validateSovereigntyConfig(legacy);
  expect(loaded.privacyChoicePending).toBe(true);
  expect(isPendingPrivacyPolicy(loaded)).toBe(true);
  expect(() => validateSovereigntyConfig({ ...loaded, privacyChoicePending: false } as never)).toThrow('privacyChoicePending');
});
