import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensurePrivateRootDirectorySync, writePrivateFileAtomicSync } from './atomic-file.ts';
/** The new standalone install's durable pending choice. */
import { PENDING_PRIVACY_REASON, loadSovereigntyPreset, updateSovereigntyConfigFile, validateSovereigntyConfig, type SovereigntyConfig, type SovereigntyPresetName } from './sovereignty.ts';


export function createPendingPrivacyPolicy(): SovereigntyConfig {
  const config = loadSovereigntyPreset('no-sensitive');
  config.privacyChoicePending = true;
  config.routes.internal = { mode: 'disabled', pool: { members: [] }, disabledReason: PENDING_PRIVACY_REASON };
  config.routes.secure_local = { mode: 'disabled', pool: { members: [] }, disabledReason: PENDING_PRIVACY_REASON };
  config.retrieval.trustDomains.internal!.allowCloudQuery = false;
  return validateSovereigntyConfig(config);
}

export function isPendingPrivacyPolicy(config: SovereigntyConfig): boolean {
  // The reason recognizes pending policies written by the earlier 1.3 build,
  // including ones whose unrelated model setting has already changed.
  return config.privacyChoicePending === true
    || config.routes?.secure_local?.disabledReason === PENDING_PRIVACY_REASON;
}

/** The shared compare-and-save path. A second or stale answer cannot replace a policy. */
export function saveFirstRunPrivacyChoice(path: string, choice: SovereigntyPresetName) {
  return updateSovereigntyConfigFile({ path, patch: current => isPendingPrivacyPolicy(current) ? loadSovereigntyPreset(choice) : current });
}

/** Re-read a boot-time pending choice; unreadable policy never unlocks egress. */
export function privacyChoicePending(policy: { config: SovereigntyConfig; path?: string }): boolean {
  if (!isPendingPrivacyPolicy(policy.config)) return false;
  if (!policy.path) return true;
  try { return isPendingPrivacyPolicy(validateSovereigntyConfig(JSON.parse(readFileSync(policy.path, 'utf8')))); }
  catch { return true; }
}

/** The installation question lives beside the initial privacy choice, and is seeded only on a fresh install. */
export interface ComputerUseState {
  schema: 'olympus.computer-use.v1';
  choice: 'everyday' | 'server' | null;
}
export function computerUseStatePath(policyPath: string): string { return join(dirname(policyPath), 'computer-use.json'); }
export function readComputerUseState(policyPath: string): ComputerUseState | undefined {
  try {
    const value = JSON.parse(readFileSync(computerUseStatePath(policyPath), 'utf8'));
    if (value?.schema === 'olympus.computer-use.v1' && [null, 'everyday', 'server'].includes(value.choice)) return value;
  } catch { /* Existing installs have no question to answer. */ }
  return undefined;
}
export function seedComputerUseState(policyPath: string): void {
  const path = computerUseStatePath(policyPath);
  ensurePrivateRootDirectorySync(dirname(path));
  if (!existsSync(path)) writePrivateFileAtomicSync(path, JSON.stringify({ schema: 'olympus.computer-use.v1', choice: null }) + '\n');
}
export function saveComputerUseChoice(policyPath: string, choice: 'everyday' | 'server'): void {
  const current = readComputerUseState(policyPath);
  if (!current || current.choice !== null) return;
  writePrivateFileAtomicSync(computerUseStatePath(policyPath), JSON.stringify({ ...current, choice }) + '\n');
}
