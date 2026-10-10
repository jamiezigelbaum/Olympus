/**
 * Which picker locations are Secrets-tier, so their names (and, for Dropbox,
 * their path keys) never leave the Mac even through the picker tools.
 *
 * The source is the owner's tier rules (`~/.olympus/tier-rules.json`,
 * workers/classification/tier-rules.ts) with tier `secrets`: a folder key, a
 * path prefix, a Gmail label id or a sender. A rule's optional `source` is
 * ignored here on purpose: matching it wrongly would show a Secrets location,
 * matching every source can only hide more. An unreadable rules file fails
 * closed (the caller refuses the picker rather than guessing).
 *
 * Matching is the classifier's own (core/location-rules.ts and
 * core/sender-rules.ts): case-insensitive, on folder boundaries, and
 * parent-aware when a folder's ancestor keys are given.
 */
import { locationKeyMatches, normalizeLocationPath, pathPrefixMatches } from '../../core/location-rules.ts';
import { ownerSenderRuleMatches } from '../../core/sender-rules.ts';
import { loadOwnerTierRules } from '../classification/tier-rules.ts';
import type { OwnerTierRule } from '../classification/tier-classifier.ts';

export interface SecretLocations {
  /** Lowercased. */
  folderKeys: ReadonlySet<string>;
  /** Lowercased, without a trailing slash. */
  pathPrefixes: readonly string[];
  /** Lowercased. */
  labelIds: ReadonlySet<string>;
  /** Lowercased sender rules: addresses, `@domain` suffixes or fragments. */
  senders: readonly string[];
}

export const NO_SECRET_LOCATIONS: SecretLocations = {
  folderKeys: new Set(),
  pathPrefixes: [],
  labelIds: new Set(),
  senders: [],
};

export function secretLocationsFromRules(rules: readonly OwnerTierRule[]): SecretLocations {
  const folderKeys = new Set<string>();
  const pathPrefixes: string[] = [];
  const labelIds = new Set<string>();
  const senders: string[] = [];
  for (const rule of rules) {
    if (rule.tier !== 'secrets') continue;
    const value = rule.match.value;
    switch (rule.match.kind) {
      case 'folderKey': folderKeys.add(value.trim().toLowerCase()); break;
      case 'pathPrefix': if (value.trim()) pathPrefixes.push(normalizeLocationPath(value)); break;
      case 'label': labelIds.add(value.trim().toLowerCase()); break;
      case 'sender': senders.push(value.trim().toLowerCase()); break;
      default: break;
    }
  }
  return { folderKeys, pathPrefixes, labelIds, senders };
}

/** The owner's Secrets locations from their tier rules file. Throws when the file is unreadable. */
export function loadSecretLocations(env: Record<string, string | undefined> = process.env): SecretLocations {
  return secretLocationsFromRules(loadOwnerTierRules({ env, allowMissing: true }));
}

/** A folder (by key and its ancestors' keys) that is or sits under a Secrets location. */
export function isSecretFolder(locations: SecretLocations, key: string, ancestorKeys: readonly string[] = []): boolean {
  const keys = [key, ...ancestorKeys];
  for (const folderKey of locations.folderKeys) if (locationKeyMatches(keys, folderKey)) return true;
  if (!key.startsWith('/')) return false;
  // A path prefix written as `/` stored as '' and matches every path.
  return locations.pathPrefixes.some((prefix) => pathPrefixMatches(key, prefix === '' ? '/' : prefix));
}

export function isSecretLabel(locations: SecretLocations, labelId: string): boolean {
  for (const label of locations.labelIds) if (locationKeyMatches([labelId], label)) return true;
  return false;
}

export function isSecretSender(locations: SecretLocations, sender: string): boolean {
  // Secrets always raises the tier, so a bare fragment matches by substring, as in the classifier.
  return locations.senders.some((rule) => ownerSenderRuleMatches(sender, rule, true));
}
