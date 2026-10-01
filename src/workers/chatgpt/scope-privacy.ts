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
 */
import { loadOwnerTierRules } from '../classification/tier-rules.ts';
import type { OwnerTierRule } from '../classification/tier-classifier.ts';

export interface SecretLocations {
  folderKeys: ReadonlySet<string>;
  /** Lowercased, without a trailing slash. */
  pathPrefixes: readonly string[];
  labelIds: ReadonlySet<string>;
  /** Lowercased addresses or `@domain` suffixes. */
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
      case 'folderKey': folderKeys.add(value); break;
      case 'pathPrefix': pathPrefixes.push(normalizePath(value)); break;
      case 'label': labelIds.add(value); break;
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
  if (locations.folderKeys.has(key) || ancestorKeys.some((ancestor) => locations.folderKeys.has(ancestor))) return true;
  if (!key.startsWith('/')) return false;
  const path = normalizePath(key);
  return locations.pathPrefixes.some((prefix) => prefix === '' || path === prefix || path.startsWith(`${prefix}/`));
}

export function isSecretLabel(locations: SecretLocations, labelId: string): boolean {
  return locations.labelIds.has(labelId);
}

export function isSecretSender(locations: SecretLocations, sender: string): boolean {
  const value = sender.trim().toLowerCase();
  return locations.senders.some((rule) => (rule.startsWith('@') ? value.endsWith(rule) : value === rule));
}

function normalizePath(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}
