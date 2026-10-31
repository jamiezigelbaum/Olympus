/** The new standalone install's pending choice, stored in the policy itself.
 * An exact match is required before replacing it, so an existing or edited
 * policy is never mistaken for a first run. */
import { loadSovereigntyPreset, updateSovereigntyConfigFile, validateSovereigntyConfig, type SovereigntyConfig, type SovereigntyPresetName } from './sovereignty.ts';

const PENDING_REASON = 'Choose how Olympus may answer with Private items before setup continues.';

export function createPendingPrivacyPolicy(): SovereigntyConfig {
  const config = loadSovereigntyPreset('no-sensitive');
  config.routes.internal = { mode: 'disabled', pool: { members: [] }, disabledReason: PENDING_REASON };
  config.routes.secure_local = { mode: 'disabled', pool: { members: [] }, disabledReason: PENDING_REASON };
  config.retrieval.trustDomains.internal!.allowCloudQuery = false;
  return validateSovereigntyConfig(config);
}

export function isPendingPrivacyPolicy(config: SovereigntyConfig): boolean {
  if (config.routes?.secure_local?.disabledReason !== PENDING_REASON) return false;
  // If a policy carrying the pending marker is malformed, do not unlock it.
  try { return JSON.stringify(validateSovereigntyConfig(config)) === JSON.stringify(createPendingPrivacyPolicy()); }
  catch { return true; }
}

/** The shared compare-and-save path. A second or stale answer cannot replace a policy. */
export function saveFirstRunPrivacyChoice(path: string, choice: SovereigntyPresetName) {
  return updateSovereigntyConfigFile({ path, patch: current => isPendingPrivacyPolicy(current) ? loadSovereigntyPreset(choice) : current });
}
