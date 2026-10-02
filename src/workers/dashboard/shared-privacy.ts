/**
 * The pure rules both privacy editors share: the ChatGPT engine's
 * olympus_privacy_set (chatgpt/setup-tools.ts) and the local Privacy editor
 * (pages/privacy.ts and its save route). One definition of what makes two
 * rules the same rule, of what lowers the owner's protection, of what a valid
 * rule of each kind is, and of how a rule is named on screen, so the two
 * surfaces cannot disagree about any of them.
 *
 * Pure: values in, values out. Nothing here reads or writes the profile.
 */
import type { PrivacySettings } from '../chatgpt/dashboard-contract.ts';
import { isSecretFolder, isSecretLabel, isSecretSender, type SecretLocations } from '../chatgpt/scope-privacy.ts';
import { privacyRuleId } from '../classification/privacy-profile.ts';
import type { PrivacyRuleLike } from './shared-privacy-rules.ts';

export {
  PRIVACY_FOLDER_SOURCE_NAMES,
  privacyRuleProblem,
  privacyRuleWords,
  type PrivacyRuleLike,
} from './shared-privacy-rules.ts';

/**
 * The backend's identity for a rule (classification/privacy-profile.ts
 * privacyRuleId): a folder or label by its key, a sender by its trimmed,
 * lowercased value. Two rules with one identity are one rule.
 */
export function privacyRuleIdentity(rule: PrivacyRuleLike): string {
  if (rule.kind === 'sender') {
    return privacyRuleId({ kind: 'sender', source_id: rule.source_id as never, value: (rule.value ?? '').trim().toLowerCase() });
  }
  return privacyRuleId({ kind: rule.kind as never, source_id: rule.source_id as never, key: rule.key ?? '' });
}

/** The saved rules a draft no longer keeps: each is protection the save would remove. */
export function privacyRemovedRules<T extends PrivacyRuleLike>(saved: readonly T[], draft: readonly PrivacyRuleLike[]): T[] {
  const kept = new Set(draft.map(privacyRuleIdentity));
  return saved.filter((rule) => !kept.has(privacyRuleIdentity(rule)));
}

/**
 * Whether a save would lower the owner's protection: it removes a saved rule
 * or changes the owner's description (which the private classifier reads).
 * Adding rules, or saving the description unchanged, never lowers it.
 */
export function lowersPrivacy(
  update: { description?: string; rules?: readonly PrivacyRuleLike[] },
  current: Pick<PrivacySettings, 'description' | 'rules'>,
): boolean {
  if (update.description !== undefined && update.description !== current.description) return true;
  if (!update.rules) return false;
  return privacyRemovedRules(current.rules, update.rules).length > 0;
}

/** A rule on one of the owner's Secrets locations: never shown, kept as saved. */
export function isSecretPrivacyRule(secrets: SecretLocations, rule: { kind: string; key?: string; value?: string }): boolean {
  if (rule.kind === 'folder') return isSecretFolder(secrets, rule.key ?? '');
  if (rule.kind === 'label') return isSecretLabel(secrets, rule.key ?? '');
  return isSecretSender(secrets, rule.value ?? '');
}

/** The settings without any rule on a Secrets location: those never leave the Mac. */
export function visiblePrivacy(settings: PrivacySettings, secrets: SecretLocations): PrivacySettings {
  return { ...settings, rules: settings.rules.filter((rule) => !isSecretPrivacyRule(secrets, rule)) };
}
