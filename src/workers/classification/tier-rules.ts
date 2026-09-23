// Owner tier rules (design docs/design/per-item-four-tier-classification.md,
// section 2.4): `~/.olympus/tier-rules.json`, owner-only, validated like the
// sensitivity map.
//
//   {
//     "schemaVersion": 1,
//     "rules": [
//       { "id": "published-work", "source": "<provider>",
//         "match": { "pathPrefix": "/work/published" },
//         "tier": "public", "strength": "prior" }
//     ]
//   }
//
// - `match` holds exactly one of pathPrefix | folderKey | label | sender | chat.
//   Each is a PROVIDER identifier (a folder id, a label id, a chat key, an
//   address), so a rule survives re-syncs, renames and rebuilds.
// - `tier` uses the schema-v1 keys the sensitivity map uses: public (Public),
//   private (Personal), secure (Private), secrets (Secrets).
// - `strength`: `prior` sets the resting tier and item-level raises still
//   apply (the default); `force` fixes it, and only Secrets can still raise it.
// - `source` is optional and matched as opaque data against the item's
//   provider. This module never names a source.
//
// Sender rules are matched by the one sender matcher (core/sender-rules.ts,
// through the classifier's ownerRuleMatches). The mail scope picker's
// always-Private senders are rules of the same shape kept in the mail scope
// approval; the store merges them with these, and `olympus tier rules list`
// shows them read-only.
//
// Per-item overrides are NOT here: they live in the tier ledger, keyed by
// provider item identity (tier-ledger.ts, `setOverride`).

import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { OperationError } from '../../core/operation-error.ts';
import { ownerConfigStamp, readOwnerConfigFile } from '../../core/owner-config-read.ts';
import { TIER_KEYS, type OwnerTierRule, type TierKey } from './tier-classifier.ts';

export const TIER_RULES_SCHEMA_VERSION = 1;
export const OLYMPUS_TIER_RULES_ENV = 'OLYMPUS_TIER_RULES_PATH';

export const OWNER_TIER_RULE_MATCH_KINDS = ['pathPrefix', 'folderKey', 'label', 'sender', 'chat'] as const;
export type OwnerTierRuleMatchKind = (typeof OWNER_TIER_RULE_MATCH_KINDS)[number];

const MAX_RULES = 500;
const MAX_VALUE_LENGTH = 240;
const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const SENDER_PATTERN = /^(?:[^\s<>"(),;:@]+)?@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

export interface TierRulesLoadOptions {
  path?: string;
  env?: Record<string, string | undefined>;
  allowMissing?: boolean;
}

export interface TierRulesValidationResult {
  ok: true;
  path: string;
  schemaVersion: number;
  rules: number;
  ruleIds: string[];
  permissions?: string;
  permissionsTightened?: boolean;
}

export function defaultTierRulesPath(): string {
  return join(homedir(), '.olympus', 'tier-rules.json');
}

export function resolveTierRulesPath(options: Pick<TierRulesLoadOptions, 'path' | 'env'> = {}): string {
  const env = options.env ?? process.env;
  return options.path?.trim() || env[OLYMPUS_TIER_RULES_ENV]?.trim() || defaultTierRulesPath();
}

/**
 * Load and validate the owner's rules. A missing file is no rules when
 * `allowMissing`; an INVALID file always throws: silently dropping an owner's
 * "always Private" rule would make items less protected than the owner asked.
 */
export function loadOwnerTierRules(options: TierRulesLoadOptions = {}): OwnerTierRule[] {
  const path = resolveTierRulesPath(options);
  // The same guarded read as the sensitivity map: a file anyone but its owner
  // can write, or one that changed while it was read, is refused, never used.
  const read = readOwnerConfigFile(path);
  if (read.status === 'missing') {
    if (options.allowMissing) return [];
    throw new OperationError('config_error', `Tier rules not found at ${path}.`, tierRulesRemedy(path));
  }
  if (read.status === 'refused') {
    throw new OperationError(
      'config_error',
      read.reason === 'unsafe_permissions'
        ? `Tier rules at ${path} are writable by someone other than their owner.`
        : `Tier rules at ${path} could not be read consistently (${read.reason}).`,
      read.reason === 'unsafe_permissions' ? `chmod 600 ${path}` : tierRulesRemedy(path),
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.text) as unknown;
  } catch {
    throw new OperationError('config_error', `Tier rules at ${path} are not valid JSON.`, tierRulesRemedy(path));
  }
  return parseOwnerTierRules(raw, path);
}

/** The file's modification stamp, for callers that reload only when it changes. */
export function tierRulesFileStamp(options: Pick<TierRulesLoadOptions, 'path' | 'env'> = {}): string {
  return ownerConfigStamp(resolveTierRulesPath(options));
}

export function validateTierRulesFile(options: TierRulesLoadOptions = {}): TierRulesValidationResult {
  const path = resolveTierRulesPath(options);
  const rules = loadOwnerTierRules({ ...options, path, allowMissing: false });
  return {
    ok: true,
    path,
    schemaVersion: TIER_RULES_SCHEMA_VERSION,
    rules: rules.length,
    ruleIds: rules.map((rule) => rule.id),
    ...tightenPermissions(path),
  };
}

export function parseOwnerTierRules(raw: unknown, label = 'tier rules'): OwnerTierRule[] {
  const root = asRecord(raw);
  if (!root) throw new OperationError('config_error', `${label} must be a JSON object.`);
  if (root.schemaVersion !== TIER_RULES_SCHEMA_VERSION) {
    throw new OperationError('config_error', `${label}.schemaVersion must be ${TIER_RULES_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(root.rules)) throw new OperationError('config_error', `${label}.rules must be an array.`);
  if (root.rules.length > MAX_RULES) {
    throw new OperationError('config_error', `${label}.rules may hold at most ${MAX_RULES} rules.`);
  }
  const unknownKeys = Object.keys(root).filter((key) => key !== 'schemaVersion' && key !== 'rules');
  if (unknownKeys.length > 0) {
    throw new OperationError('config_error', `${label} has unknown field(s): ${unknownKeys.join(', ')}.`);
  }
  const seen = new Set<string>();
  return root.rules.map((entry, index) => {
    const rule = parseOwnerTierRule(entry, `${label}.rules[${index}]`);
    if (seen.has(rule.id)) throw new OperationError('config_error', `${label}: duplicate rule id "${rule.id}".`);
    seen.add(rule.id);
    return rule;
  });
}

export function parseOwnerTierRule(raw: unknown, label = 'tier rule'): OwnerTierRule {
  const record = asRecord(raw);
  if (!record) throw new OperationError('config_error', `${label} must be an object.`);
  const unknownKeys = Object.keys(record).filter((key) => !['id', 'source', 'match', 'tier', 'strength'].includes(key));
  if (unknownKeys.length > 0) {
    throw new OperationError('config_error', `${label} has unknown field(s): ${unknownKeys.join(', ')}.`);
  }
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!RULE_ID_PATTERN.test(id)) {
    throw new OperationError('config_error', `${label}.id must be a short lower-case slug (a-z, 0-9, _ . : -).`);
  }
  let source: string | undefined;
  if (record.source !== undefined) {
    if (typeof record.source !== 'string' || !SOURCE_PATTERN.test(record.source.trim())) {
      throw new OperationError('config_error', `${label}.source must be a provider id (letters, digits, _ . : -).`);
    }
    source = record.source.trim();
  }
  const match = parseMatch(record.match, `${label}.match`);
  const tier = record.tier;
  if (typeof tier !== 'string' || !(TIER_KEYS as readonly string[]).includes(tier)) {
    throw new OperationError('config_error', `${label}.tier must be one of ${TIER_KEYS.join(', ')} (schema-v1 keys).`);
  }
  const strength = record.strength ?? 'prior';
  if (strength !== 'prior' && strength !== 'force') {
    throw new OperationError('config_error', `${label}.strength must be prior or force.`);
  }
  return { id, ...(source ? { source } : {}), match, tier: tier as TierKey, strength };
}

function parseMatch(raw: unknown, label: string): OwnerTierRule['match'] {
  const record = asRecord(raw);
  if (!record) throw new OperationError('config_error', `${label} must be an object.`);
  const keys = Object.keys(record);
  if (keys.length !== 1 || !(OWNER_TIER_RULE_MATCH_KINDS as readonly string[]).includes(keys[0]!)) {
    throw new OperationError(
      'config_error',
      `${label} must hold exactly one of ${OWNER_TIER_RULE_MATCH_KINDS.join(', ')}.`,
    );
  }
  const kind = keys[0] as OwnerTierRuleMatchKind;
  const value = record[kind];
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_VALUE_LENGTH) {
    throw new OperationError('config_error', `${label}.${kind} must be a non-empty string of at most ${MAX_VALUE_LENGTH} characters.`);
  }
  if (kind === 'sender' && !SENDER_PATTERN.test(value.trim())) {
    throw new OperationError(
      'config_error',
      `${label}.sender must be an address (name@example.com) or a whole domain (@example.com).`,
    );
  }
  return { kind, value: value.trim() };
}

/** The file form of one rule (the `match` object keyed by its kind). */
export function serializeOwnerTierRule(rule: OwnerTierRule): Record<string, unknown> {
  return {
    id: rule.id,
    ...(rule.source ? { source: rule.source } : {}),
    match: { [rule.match.kind]: rule.match.value },
    tier: rule.tier,
    strength: rule.strength,
  };
}

/** Write the rules file atomically, owner-only (0600) inside an owner-only directory. */
export function writeOwnerTierRules(rules: readonly OwnerTierRule[], options: Pick<TierRulesLoadOptions, 'path' | 'env'> = {}): string {
  const path = resolveTierRulesPath(options);
  // Round-trip through the validator so the CLI can never write a file the
  // loader would refuse.
  const document = { schemaVersion: TIER_RULES_SCHEMA_VERSION, rules: rules.map(serializeOwnerTierRule) };
  parseOwnerTierRules(document, 'tier rules');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

export function addOwnerTierRule(rule: OwnerTierRule, options: Pick<TierRulesLoadOptions, 'path' | 'env'> = {}): { path: string; rules: OwnerTierRule[] } {
  const existing = loadOwnerTierRules({ ...options, allowMissing: true });
  if (existing.some((candidate) => candidate.id === rule.id)) {
    throw new OperationError('invalid_params', `A tier rule with id "${rule.id}" already exists.`, 'Remove it first or choose another id.');
  }
  const rules = [...existing, rule];
  return { path: writeOwnerTierRules(rules, options), rules };
}

export function removeOwnerTierRule(id: string, options: Pick<TierRulesLoadOptions, 'path' | 'env'> = {}): { path: string; removed: boolean; rules: OwnerTierRule[] } {
  const existing = loadOwnerTierRules({ ...options, allowMissing: true });
  const rules = existing.filter((rule) => rule.id !== id);
  if (rules.length === existing.length) return { path: resolveTierRulesPath(options), removed: false, rules: existing };
  return { path: writeOwnerTierRules(rules, options), removed: true, rules };
}

/**
 * Tier words on the command line are the DISPLAY names the owner sees
 * (Public, Personal, Private, Secrets). The file stores schema-v1 keys, where
 * `private` means Personal, so the two vocabularies are never mixed: a CLI
 * `private` always means the Private tier.
 */
export function tierKeyFromDisplayName(value: string): TierKey | undefined {
  switch (value.trim().toLowerCase()) {
    case 'public': return 'public';
    case 'personal': return 'private';
    case 'private': return 'secure';
    case 'secrets':
    case 'secret': return 'secrets';
    default: return undefined;
  }
}

export function tierDisplayName(tier: TierKey): string {
  switch (tier) {
    case 'public': return 'Public';
    case 'private': return 'Personal';
    case 'secure': return 'Private';
    case 'secrets': return 'Secrets';
  }
}

function tightenPermissions(path: string): { permissions?: string; permissionsTightened?: boolean } {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return {};
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) === 0) return { permissions: `0${mode.toString(8).padStart(3, '0')}` };
    chmodSync(path, 0o600);
    return { permissions: '0600', permissionsTightened: true };
  } catch {
    return {};
  }
}

function tierRulesRemedy(path: string): string {
  return `Write the rules to ${path} (schemaVersion 1), or add them with \`olympus tier rules add\`.`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
