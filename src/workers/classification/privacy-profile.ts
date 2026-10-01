// The owner's privacy profile (owner ruling 2026-10-01): set once in setup,
// inside ChatGPT, and editable later from the dashboard.
//
//   ~/.olympus/privacy.json (owner-only)
//   {
//     "schemaVersion": 1,
//     "description": "In your own words, what's private for you?",
//     "rules": [
//       { "kind": "folder", "source_id": "dropbox.files", "key": "/health" },
//       { "kind": "label",  "source_id": "gmail.email",   "key": "Label_12", "value": "Therapy" },
//       { "kind": "sender", "source_id": "gmail.email",   "value": "@clinic.example" }
//     ],
//     "updatedAt": "<ISO time>"
//   }
//
// - The description is free text in the owner's words. It feeds the privacy
//   sniffer's prompt as quoted data (sniffer.ts), never a rule by itself.
// - Each rule names a folder, a label or a sender that is ALWAYS Private. The
//   profile owns the matching owner tier rules (tier-rules.ts): every save
//   rewrites the rules whose id starts with `privacy-` and leaves every other
//   rule exactly as it was.
// - Display names (folder and label names) live only here and in the privacy
//   tools' widget data; nothing else reads them.
//
// Nothing here names a source in a branch: a rule's source id maps to the
// provider id its items carry through one table.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { OperationError } from '../../core/operation-error.ts';
import { ownerConfigStamp, readOwnerConfigFile } from '../../core/owner-config-read.ts';
import type { OwnerTierRule } from './tier-classifier.ts';
import { loadOwnerTierRules, writeOwnerTierRules } from './tier-rules.ts';

export const PRIVACY_PROFILE_SCHEMA_VERSION = 1;
export const OLYMPUS_PRIVACY_PROFILE_ENV = 'OLYMPUS_PRIVACY_PROFILE_PATH';
/** The owner's words: long enough for a paragraph, short enough for a prompt. */
export const PRIVACY_DESCRIPTION_MAX_CHARS = 2_000;
export const PRIVACY_RULES_MAX = 100;
export const PRIVACY_DISPLAY_MAX_CHARS = 200;
export const PRIVACY_KEY_MAX_CHARS = 1_024;
/** Owner tier rules this profile owns carry this id prefix. */
export const PRIVACY_RULE_ID_PREFIX = 'privacy-';

export const PRIVACY_RULE_KINDS = ['folder', 'label', 'sender'] as const;
export type PrivacyRuleKind = (typeof PRIVACY_RULE_KINDS)[number];

/**
 * Which source ids each rule kind may name, and the provider id their items
 * carry. Data, not a branch: a new source is a row here.
 */
const RULE_SOURCES: Readonly<Record<PrivacyRuleKind, Readonly<Record<string, { provider: string; match: OwnerTierRule['match']['kind'] }>>>> = {
  folder: {
    'dropbox.files': { provider: 'dropbox', match: 'pathPrefix' },
    'google_drive.docs': { provider: 'google_drive', match: 'folderKey' },
  },
  label: {
    'gmail.email': { provider: 'gmail', match: 'label' },
  },
  sender: {
    'gmail.email': { provider: 'gmail', match: 'sender' },
  },
};

export type PrivacyRuleSourceId = 'dropbox.files' | 'google_drive.docs' | 'gmail.email';

/**
 * One always-Private rule, in the dashboard contract's shape
 * (chatgpt/dashboard-contract.ts PrivacyRuleView):
 * - folder: `key` (the picker's opaque key), optional `display` (its name);
 * - label: `key` (the label id) and `value` (the label name);
 * - sender: `value` (an address or a whole `@domain`).
 */
export interface PrivacyRule {
  kind: PrivacyRuleKind;
  source_id: PrivacyRuleSourceId;
  key?: string;
  value?: string;
  display?: string;
}

export interface PrivacyProfile {
  description: string;
  rules: PrivacyRule[];
  updatedAt?: string;
}

export interface PrivacyProfilePathOptions {
  path?: string;
  env?: Record<string, string | undefined>;
}

export function defaultPrivacyProfilePath(): string {
  return join(homedir(), '.olympus', 'privacy.json');
}

export function resolvePrivacyProfilePath(options: PrivacyProfilePathOptions = {}): string {
  const env = options.env ?? process.env;
  return options.path?.trim() || env[OLYMPUS_PRIVACY_PROFILE_ENV]?.trim() || defaultPrivacyProfilePath();
}

/** The file's modification stamp, for callers that re-read only when it changes. */
export function privacyProfileStamp(options: PrivacyProfilePathOptions = {}): string {
  return ownerConfigStamp(resolvePrivacyProfilePath(options));
}

/**
 * The saved profile, or undefined when the owner has not set one yet.
 * Throws on a file that cannot be trusted (unreadable, writable by others,
 * malformed): a caller must never treat a broken profile as "not set".
 */
export function readPrivacyProfile(options: PrivacyProfilePathOptions = {}): PrivacyProfile | undefined {
  const path = resolvePrivacyProfilePath(options);
  const read = readOwnerConfigFile(path);
  if (read.status === 'missing') return undefined;
  if (read.status === 'refused') {
    throw new OperationError('config_error', `The privacy profile at ${path} could not be read safely (${read.reason}).`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.text) as unknown;
  } catch {
    throw new OperationError('config_error', `The privacy profile at ${path} is not valid JSON.`);
  }
  const record = asRecord(raw);
  if (!record || record.schemaVersion !== PRIVACY_PROFILE_SCHEMA_VERSION) {
    throw new OperationError('config_error', `The privacy profile at ${path} must have schemaVersion ${PRIVACY_PROFILE_SCHEMA_VERSION}.`);
  }
  const profile = parsePrivacyProfileInput({ description: record.description ?? '', rules: record.rules ?? [] });
  return {
    description: profile.description ?? '',
    rules: profile.rules ?? [],
    ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
  };
}

/** The owner's words for the sniffer prompt, or undefined when there are none (or the file is unusable). */
export function privacyOwnerContext(options: PrivacyProfilePathOptions = {}): string | undefined {
  try {
    const description = readPrivacyProfile(options)?.description.trim();
    return description ? description : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate a partial update (`olympus_privacy_set`): every field optional,
 * each checked and size-capped. Throws OperationError('invalid_params').
 */
export function parsePrivacyProfileInput(raw: unknown): { description?: string; rules?: PrivacyRule[] } {
  const record = asRecord(raw);
  if (!record) throw invalid('The privacy settings must be an object.');
  const unknownKeys = Object.keys(record).filter((key) => key !== 'description' && key !== 'rules');
  if (unknownKeys.length > 0) throw invalid('The privacy settings have unknown fields.');
  const out: { description?: string; rules?: PrivacyRule[] } = {};
  if (record.description !== undefined) {
    if (typeof record.description !== 'string') throw invalid('description must be text.');
    const description = record.description.replace(/\r\n/g, '\n').trim();
    if (description.length > PRIVACY_DESCRIPTION_MAX_CHARS) {
      throw invalid(`description may be at most ${PRIVACY_DESCRIPTION_MAX_CHARS} characters.`);
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) throw invalid('description has control characters.');
    out.description = description;
  }
  if (record.rules !== undefined) {
    if (!Array.isArray(record.rules)) throw invalid('rules must be a list.');
    if (record.rules.length > PRIVACY_RULES_MAX) throw invalid(`At most ${PRIVACY_RULES_MAX} rules.`);
    const seen = new Set<string>();
    out.rules = [];
    for (const entry of record.rules) {
      const rule = parsePrivacyRule(entry);
      const id = privacyRuleId(rule);
      if (seen.has(id)) continue;
      seen.add(id);
      out.rules.push(rule);
    }
  }
  return out;
}

function parsePrivacyRule(raw: unknown): PrivacyRule {
  const record = asRecord(raw);
  if (!record) throw invalid('Each rule must be an object.');
  const unknownKeys = Object.keys(record).filter((key) => !['kind', 'source_id', 'key', 'value', 'display'].includes(key));
  if (unknownKeys.length > 0) throw invalid('A rule has unknown fields.');
  const kind = record.kind;
  if (typeof kind !== 'string' || !(PRIVACY_RULE_KINDS as readonly string[]).includes(kind)) {
    throw invalid('A rule kind must be folder, label or sender.');
  }
  const sources = RULE_SOURCES[kind as PrivacyRuleKind];
  const sourceId = record.source_id;
  if (typeof sourceId !== 'string' || !Object.prototype.hasOwnProperty.call(sources, sourceId)) {
    throw invalid('A rule names a source that kind of rule does not apply to.');
  }
  const display = record.display === undefined ? undefined : boundedName(record.display, 'display');
  if (kind === 'sender') {
    if (record.key !== undefined) throw invalid('A sender rule takes value, not key.');
    const value = typeof record.value === 'string' ? record.value.trim().toLowerCase() : '';
    if (value.length > 240 || !/^(?:[^\s<>"(),;:@]+)?@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value)) {
      throw invalid('A sender rule needs an address (name@example.com) or a whole domain (@example.com).');
    }
    return { kind, source_id: sourceId as PrivacyRuleSourceId, value };
  }
  const key = typeof record.key === 'string' ? record.key.trim() : '';
  if (!key || key.length > PRIVACY_KEY_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(key)) {
    throw invalid(`A folder or label rule needs its key (at most ${PRIVACY_KEY_MAX_CHARS} characters).`);
  }
  if (sources[sourceId]!.match === 'pathPrefix' && !key.startsWith('/')) throw invalid('A folder key for this source is a path.');
  if (kind === 'label') {
    // The label's name is its value; the id is what classification matches.
    const value = boundedName(record.value, 'value');
    return { kind, source_id: sourceId as PrivacyRuleSourceId, key, value };
  }
  if (record.value !== undefined) throw invalid('A folder rule takes key, not value.');
  return { kind: kind as PrivacyRuleKind, source_id: sourceId as PrivacyRuleSourceId, key, ...(display ? { display } : {}) };
}

function boundedName(value: unknown, field: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > PRIVACY_DISPLAY_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(name)) {
    throw invalid(`A rule's ${field} must be a name of at most ${PRIVACY_DISPLAY_MAX_CHARS} characters.`);
  }
  return name;
}

/** The owner tier rule a privacy rule becomes: always Private, as a prior (item-level raises still apply). */
export function privacyRuleToTierRule(rule: PrivacyRule): OwnerTierRule {
  const source = RULE_SOURCES[rule.kind][rule.source_id]!;
  const raw = rule.kind === 'sender' ? rule.value! : rule.key!;
  // A folder path prefix ends at a path segment, so "/health" never matches "/healthy".
  const value = source.match === 'pathPrefix' ? `${raw.toLowerCase().replace(/\/+$/, '')}/` : raw;
  return {
    id: privacyRuleId(rule),
    source: source.provider,
    match: { kind: source.match, value } as OwnerTierRule['match'],
    tier: 'secure',
    strength: 'prior',
  };
}

export function privacyRuleId(rule: Pick<PrivacyRule, 'kind' | 'source_id' | 'key' | 'value'>): string {
  // What classification matches: the key for folders and labels, the value for senders.
  const matched = rule.kind === 'sender' ? rule.value ?? '' : rule.key ?? '';
  const digest = createHash('sha256')
    .update(`${rule.kind}\u0000${rule.source_id}\u0000${matched}`)
    .digest('hex')
    .slice(0, 16);
  return `${PRIVACY_RULE_ID_PREFIX}${rule.kind}-${digest}`;
}

export interface PrivacyProfileWriteOptions extends PrivacyProfilePathOptions {
  /** Where the owner tier rules live (tier-rules.ts); defaults from `env`. */
  tierRulesPath?: string;
  now?: () => Date;
}

/**
 * Apply an update: the fields given replace the saved ones, the rest stay.
 * The owner tier rules this profile owns are rewritten FIRST, so a profile
 * never claims a rule the classifier does not apply. An unreadable rules file
 * refuses the save (it is never overwritten blind).
 */
export function writePrivacyProfile(
  update: { description?: string; rules?: PrivacyRule[] },
  options: PrivacyProfileWriteOptions = {},
): PrivacyProfile {
  const current = readPrivacyProfile(options);
  const next: PrivacyProfile = {
    description: update.description ?? current?.description ?? '',
    rules: update.rules ?? current?.rules ?? [],
    updatedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  const rulesOptions = { ...(options.tierRulesPath ? { path: options.tierRulesPath } : {}), ...(options.env ? { env: options.env } : {}) };
  const existing = loadOwnerTierRules({ ...rulesOptions, allowMissing: true });
  const kept = existing.filter((rule) => !rule.id.startsWith(PRIVACY_RULE_ID_PREFIX));
  const owned = next.rules.map(privacyRuleToTierRule);
  const unchanged = existing.length === kept.length + owned.length
    && owned.every((rule) => existing.some((candidate) => candidate.id === rule.id));
  if (!unchanged) writeOwnerTierRules([...kept, ...owned], rulesOptions);

  const path = resolvePrivacyProfilePath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ schemaVersion: PRIVACY_PROFILE_SCHEMA_VERSION, ...next }, null, 2)}\n`);
  return next;
}

function invalid(message: string): OperationError {
  return new OperationError('invalid_params', message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
