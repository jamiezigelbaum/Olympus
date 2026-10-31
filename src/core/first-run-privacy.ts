import { readFileSync } from 'node:fs';
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
