import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPendingPrivacyPolicy, isPendingPrivacyPolicy, saveFirstRunPrivacyChoice } from '../src/core/first-run-privacy.ts';
import { seedEngineSovereignty } from '../src/core/engine-service.ts';
import { ModelSetupService } from '../src/core/model-setup.ts';
import { loadSovereigntyPreset, writeSovereigntyConfigFile } from '../src/core/sovereignty.ts';

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
