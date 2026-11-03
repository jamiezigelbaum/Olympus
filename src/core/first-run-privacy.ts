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

/** Infer the saved mode from the active Private route, including older installs. */
export function privateAnswerMode(config: SovereigntyConfig): SovereigntyPresetName | 'custom' {
  // Older or partial policies may lack routes or profiles: they read as custom.
  const route = config.routes?.secure_local;
  if (route?.mode === 'disabled') return 'no-sensitive';
  const members = route?.pool?.order ?? route?.pool?.members ?? route?.analyst ?? [];
  const providers = members.map(id => config.modelProfiles?.[id]?.provider);
  if (providers.length === 1 && providers[0] === 'venice') return 'private-cloud-only';
  if (providers.length === 1 && providers[0] === 'local-openai-compatible') return 'local-only';
  if (route?.pool?.order && providers.length === 2 && providers[0] === 'local-openai-compatible' && providers[1] === 'venice') return 'local-first';
  return 'custom';
}

/** Change the Private lane and its permissions; keep search model identity and local endpoints. */
export function savePrivateAnswerMode(path: string, choice: SovereigntyPresetName, expect: SovereigntyConfig) {
  if (isPendingPrivacyPolicy(expect)) return saveFirstRunPrivacyChoice(path, choice);
  return updateSovereigntyConfigFile({ path, expect, patch: current => {
    const next = structuredClone(current);
    const preset = loadSovereigntyPreset(choice);
    const route = structuredClone(preset.routes.secure_local!);
    const oldMembers = current.routes.secure_local?.pool?.members ?? current.routes.secure_local?.analyst ?? [];
    const mapped = new Map<string, string>();
    for (const id of route.pool?.members ?? route.analyst ?? []) {
      const profile = preset.modelProfiles[id]!;
      const existing = oldMembers.find(member => current.modelProfiles[member]?.provider === profile.provider);
      if (existing) { mapped.set(id, existing); continue; }
      // Never overwrite an endpoint the owner already runs with a different provider.
      if (next.modelProfiles[id] && next.modelProfiles[id]!.provider !== profile.provider) throw new Error('The selected mode conflicts with a custom model.');
      next.modelProfiles[id] ??= profile;
      mapped.set(id, id);
    }
    if (route.pool) {
      route.pool.members = route.pool.members.map(id => mapped.get(id)!);
      if (route.pool.order) route.pool.order = route.pool.order.map(id => mapped.get(id)!);
    }
    if (route.analyst) route.analyst = route.analyst.map(id => mapped.get(id)!);
    next.routes.secure_local = route;
    const retrieval = next.retrieval.trustDomains.secure_local;
    const target = preset.retrieval.trustDomains.secure_local!;
    if (!retrieval) throw new Error('Private search settings are unavailable.');
    retrieval.minimumExecutionTrust = target.minimumExecutionTrust;
    retrieval.allowedEmbeddingTrust = [...target.allowedEmbeddingTrust];
    if (target.secureHandling) retrieval.secureHandling = target.secureHandling;
    else delete retrieval.secureHandling;
    retrieval.allowCloudQuery = false;
    return next;
  } });
}
