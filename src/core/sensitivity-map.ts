import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { OperationError } from './operation-error.ts';
import { readOwnerConfigFile } from './owner-config-read.ts';
import {
  SOURCE_TRUST_DOMAINS,
  SOURCE_TRUST_TIERS,
  type SourceTrustDomain,
  type SourceTrustTier,
} from './source-index/types.ts';

/**
 * The newest map schema. Version 2 lets a category target any of the four
 * tiers, including the lowering targets Public and Personal. Version 1 maps are
 * still read, and still refuse lowering targets, so an existing map keeps its
 * raise-only meaning until its owner rewrites it as version 2.
 */
export const SENSITIVITY_MAP_SCHEMA_VERSION = 2;
export const SUPPORTED_SENSITIVITY_MAP_SCHEMA_VERSIONS = [1, 2] as const;
export type SensitivityMapSchemaVersion = (typeof SUPPORTED_SENSITIVITY_MAP_SCHEMA_VERSIONS)[number];
export const OLYMPUS_SENSITIVITY_MAP_ENV = 'OLYMPUS_SENSITIVITY_MAP_PATH';

// Schema-v1 identifiers: private means Personal; secure means Private.
// Display names are defined in privacy-language.ts; never rename these keys in place.
export const USER_FACING_TIER_MAPPING = {
  public: { targetTrustTier: 'S0', targetTrustDomain: 'public_safe' },
  private: { targetTrustTier: 'S3', targetTrustDomain: 'internal' },
  secure: { targetTrustTier: 'S4', targetTrustDomain: 'secure_local' },
  secrets: { targetTrustTier: 'S5', targetTrustDomain: 'secure_local' },
} as const satisfies Record<string, { targetTrustTier: SourceTrustTier; targetTrustDomain: SourceTrustDomain }>;

export type UserFacingTierName = keyof typeof USER_FACING_TIER_MAPPING;

export interface SensitivityMapMatch {
  keywords: string[];
  senderPatterns: string[];
  pathPatterns: string[];
}

export interface SensitivityMapCategory {
  id: string;
  label: string;
  targetTierName: UserFacingTierName;
  targetTrustTier: SourceTrustTier;
  targetTrustDomain: SourceTrustDomain;
  examples: string[];
  notes: string;
  match: SensitivityMapMatch;
}

export interface SensitivityMap {
  schemaVersion: SensitivityMapSchemaVersion;
  userFacingTiers: typeof USER_FACING_TIER_MAPPING;
  categories: SensitivityMapCategory[];
}

export interface SensitivityMapLoadOptions {
  path?: string;
  env?: Record<string, string | undefined>;
  allowMissing?: boolean;
  ignoreInvalid?: boolean;
}

export interface SensitivityMapValidationResult {
  ok: boolean;
  path: string;
  schemaVersion?: SensitivityMapSchemaVersion;
  categories: number;
  categoryIds: string[];
  /** The file's mode after validation, as a 4-digit octal string (e.g. "0600"). */
  permissions?: string;
  /** True when validation had to tighten a group- or world-readable map. */
  permissionsTightened?: boolean;
}

export interface SensitivityMapMatchInput {
  subject?: string;
  title?: string;
  sender?: string;
  path?: string;
  text?: string;
}

export interface SensitivityMapMatchResult {
  categoryIds: string[];
  targetTrustTier: Extract<SourceTrustTier, 'S4' | 'S5'>;
  targetTrustDomain: 'secure_local';
}

const USER_FACING_TIER_NAMES = Object.keys(USER_FACING_TIER_MAPPING) as UserFacingTierName[];
const USER_FACING_TIER_SET = new Set(USER_FACING_TIER_NAMES);
const TRUST_TIER_SET = new Set<string>(SOURCE_TRUST_TIERS);
const TRUST_DOMAIN_SET = new Set<string>(SOURCE_TRUST_DOMAINS);
const MAX_CATEGORIES = 64;
const MAX_EXAMPLES_PER_CATEGORY = 12;
const MAX_MATCH_TERMS_PER_FIELD = 64;
const MAX_STRING_LENGTH = 240;
const CATEGORY_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function defaultSensitivityMapPath(): string {
  return join(homedir(), '.olympus', 'sensitivity-map.json');
}

export function resolveSensitivityMapPath(options: Pick<SensitivityMapLoadOptions, 'path' | 'env'> = {}): string {
  const env = options.env ?? process.env;
  return options.path?.trim()
    || env[OLYMPUS_SENSITIVITY_MAP_ENV]?.trim()
    || defaultSensitivityMapPath();
}

/**
 * The owner's installed sensitivity map, for any lane's tier classification:
 * absent or invalid means none (the classifier then uses its defaults). One
 * loader for every source, so no lane judges items without the owner's map.
 */
export function loadOwnerSensitivityMap(
  env: Record<string, string | undefined> = process.env,
): SensitivityMap | undefined {
  const read = readOwnerSensitivityMap(env);
  return read.status === 'ok' ? read.map : undefined;
}

export type OwnerSensitivityMapRead =
  | { status: 'missing' }
  | { status: 'ok'; map: SensitivityMap; stamp: string }
  | { status: 'invalid'; reason: 'unsafe_permissions' | 'torn_read' | 'unreadable' | 'invalid_map'; stamp: string };

/**
 * The same loader, telling "absent" from "present but unusable": a map that
 * does not parse (a trailing comma, a partial write), changed while it was
 * read, or is writable by anyone but its owner is `invalid`, which the tier
 * classifiers treat as "hold items pending", never as "no map".
 */
export function readOwnerSensitivityMap(
  env: Record<string, string | undefined> = process.env,
): OwnerSensitivityMapRead {
  const path = resolveSensitivityMapPath({ env });
  const read = readOwnerConfigFile(path);
  if (read.status === 'missing') return { status: 'missing' };
  if (read.status === 'refused') return { status: 'invalid', reason: read.reason, stamp: read.stamp };
  try {
    return { status: 'ok', map: parseSensitivityMap(JSON.parse(read.text) as unknown, path), stamp: read.stamp };
  } catch {
    return { status: 'invalid', reason: 'invalid_map', stamp: read.stamp };
  }
}

export function loadSensitivityMap(options: SensitivityMapLoadOptions = {}): SensitivityMap | undefined {
  const path = resolveSensitivityMapPath(options);
  if (!existsSync(path)) {
    if (options.allowMissing) return undefined;
    throw new OperationError('config_error', `Sensitivity map not found at ${path}.`, sensitivityMapRemedy(path));
  }
  try {
    return parseSensitivityMap(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
  } catch (error) {
    if (options.ignoreInvalid) return undefined;
    throw error;
  }
}

export function validateSensitivityMapFile(options: SensitivityMapLoadOptions = {}): SensitivityMapValidationResult {
  const path = resolveSensitivityMapPath(options);
  const map = loadSensitivityMap({ ...options, path });
  if (!map) throw new OperationError('config_error', `Sensitivity map not found at ${path}.`, sensitivityMapRemedy(path));
  const custody = tightenSensitivityMapPermissions(path);
  return {
    ok: true,
    path,
    schemaVersion: map.schemaVersion,
    categories: map.categories.length,
    categoryIds: map.categories.map((category) => category.id),
    ...custody,
  };
}

/**
 * Make the map owner-only, and say whether it had to be changed.
 *
 * Nothing in Olympus writes this file: the install guide has the owner's agent
 * write it, which lands it at the process umask — 0644 on a clean macOS install
 * (clean-install rehearsal, 2026-09-05). It is a list of what the owner
 * considers sensitive and what it looks like, sitting inside a 0700 directory
 * that hides it from other users but not from anything running as them.
 * Validation is the one command that opens this file by name and is entitled to
 * fix it, so it does, and reports the change rather than performing it silently.
 */
function tightenSensitivityMapPermissions(path: string): {
  permissions?: string;
  permissionsTightened?: boolean;
} {
  try {
    const stat = lstatSync(path);
    // Never chmod through a symlink or at a non-regular file: that is somebody
    // else's inode, and this command has no business changing its mode.
    if (!stat.isFile()) return {};
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) === 0) return { permissions: formatFileMode(mode) };
    chmodSync(path, 0o600);
    return { permissions: '0600', permissionsTightened: true };
  } catch {
    return {};
  }
}

function formatFileMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/**
 * The map is written by hand (or by the owner's agent) into the private policy
 * directory olympus setup creates. Naming the directory turns "not found" from
 * a dead end into an instruction.
 */
function sensitivityMapRemedy(path: string): string {
  return `Write the map to ${path}. Run olympus setup first if ${dirname(path)} does not exist yet; it creates that directory with owner-only permissions.`;
}

export function parseSensitivityMap(rawMap: unknown, label = 'sensitivity map'): SensitivityMap {
  const root = asRecord(rawMap);
  if (!root) throw new OperationError('config_error', `${label} must be an object.`);
  const schemaVersion = root.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new OperationError('config_error', `${label}.schemaVersion must be 1 or 2.`);
  }
  assertUserFacingTierMapping(root.userFacingTiers, `${label}.userFacingTiers`);

  if (!Array.isArray(root.categories)) {
    throw new OperationError('config_error', `${label}.categories must be an array.`);
  }
  if (root.categories.length === 0) {
    throw new OperationError('config_error', `${label}.categories must include at least one category.`);
  }
  if (root.categories.length > MAX_CATEGORIES) {
    throw new OperationError('config_error', `${label}.categories must include at most ${MAX_CATEGORIES} categories.`);
  }

  const seenIds = new Set<string>();
  const categories = root.categories.map((value, index) => {
    const category = parseCategory(value, `${label}.categories[${index}]`, schemaVersion);
    if (seenIds.has(category.id)) {
      throw new OperationError('config_error', `${label}.categories id "${category.id}" must be unique.`);
    }
    seenIds.add(category.id);
    return category;
  });

  return {
    schemaVersion,
    userFacingTiers: USER_FACING_TIER_MAPPING,
    categories,
  };
}

/** Tier names a category may RAISE an item to. Every other target lowers. */
const RAISING_TIER_NAMES: ReadonlySet<UserFacingTierName> = new Set(['secure', 'secrets']);

export function isRaisingSensitivityTier(tierName: UserFacingTierName): boolean {
  return RAISING_TIER_NAMES.has(tierName);
}

/**
 * The raise-only reading every pre-tier-ledger caller depends on.
 *
 * Only categories that target Private or Secrets are considered, so a version 2
 * map's lowering categories can never reach a caller that treats any match as
 * a raise. That keeps existing storage placement byte-for-byte unchanged when
 * an owner upgrades the map.
 */
export function matchSensitivityMap(
  map: SensitivityMap | undefined,
  input: SensitivityMapMatchInput,
): SensitivityMapMatchResult | undefined {
  if (!map) return undefined;
  const textHaystack = [input.subject, input.title, input.text]
    .map((part) => part?.trim().toLowerCase())
    .filter((part): part is string => Boolean(part))
    .join('\n');
  const sender = input.sender?.trim().toLowerCase() ?? '';
  const path = input.path?.trim().toLowerCase() ?? '';
  const categoryIds: string[] = [];
  let targetTrustTier: Extract<SourceTrustTier, 'S4' | 'S5'> = 'S4';

  for (const category of map.categories) {
    if (!isRaisingSensitivityTier(category.targetTierName)) continue;
    if (!categoryMatches(category, { textHaystack, sender, path })) continue;
    categoryIds.push(category.id);
    if (category.targetTrustTier === 'S5') targetTrustTier = 'S5';
  }

  if (categoryIds.length === 0) return undefined;
  return {
    categoryIds,
    targetTrustTier,
    targetTrustDomain: 'secure_local',
  };
}

export interface SensitivityMapTierMatch {
  categoryId: string;
  tierName: UserFacingTierName;
}

/**
 * What the tier classifier hands the map. Names are kept apart on purpose:
 * `path`, `folderKeys` and `sender` are the item's real structured fields;
 * `title` is a display name. Lowering categories may only match the
 * structured fields.
 */
export interface SensitivityMapTierMatchInput {
  title?: string;
  text?: string;
  path?: string;
  folderKeys?: readonly string[];
  sender?: string;
}

/**
 * Every category the input matches, with the tier it targets.
 *
 * Raising categories (Private, Secrets) keep the forgiving v1 semantics:
 * substring matches over the title and text, the sender, and the path joined
 * with the title. A wider haystack can only make an item more private.
 *
 * Lowering categories (Public, Personal) are held to the opposite standard,
 * because a false match there loosens a tier:
 * - keywords never lower (they match free text and display names);
 * - a path pattern matches only the real path, anchored at the start and
 *   ending on a segment boundary, or equals one of the item's folder keys;
 * - a sender pattern matches only the sender's address exactly, or its domain
 *   at a label boundary (`example.com` matches `a@example.com` and
 *   `a@mail.example.com`, never `a@notexample.com`).
 *
 * Category ids are the owner's own configuration, not item content.
 */
export function matchSensitivityMapTiers(
  map: SensitivityMap | undefined,
  input: SensitivityMapTierMatchInput,
): SensitivityMapTierMatch[] {
  if (!map) return [];
  const textHaystack = [input.title, input.text]
    .map((part) => part?.trim().toLowerCase())
    .filter((part): part is string => Boolean(part))
    .join('\n');
  const sender = input.sender?.trim().toLowerCase() ?? '';
  const realPath = input.path?.trim().toLowerCase() ?? '';
  const raisePath = [realPath, input.title?.trim().toLowerCase() ?? '']
    .filter(Boolean)
    .join('\n');
  const folderKeys = (input.folderKeys ?? []).map((key) => key.trim().toLowerCase()).filter(Boolean);
  const address = senderAddress(sender);
  return map.categories
    .filter((category) => (isRaisingSensitivityTier(category.targetTierName)
      ? categoryMatches(category, { textHaystack, sender, path: raisePath })
      : loweringCategoryMatches(category, { realPath, folderKeys, address })))
    .map((category) => ({ categoryId: category.id, tierName: category.targetTierName }));
}

function loweringCategoryMatches(
  category: SensitivityMapCategory,
  input: { realPath: string; folderKeys: readonly string[]; address: string | undefined },
): boolean {
  const pathHit = category.match.pathPatterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (input.folderKeys.includes(pattern)) return true;
    if (!input.realPath) return false;
    const prefix = pattern.endsWith('/') ? pattern : `${pattern}/`;
    return input.realPath === pattern.replace(/\/+$/, '') || input.realPath.startsWith(prefix);
  });
  if (pathHit) return true;
  const address = input.address;
  if (!address) return false;
  return category.match.senderPatterns.some((raw) => {
    const pattern = raw.trim().toLowerCase().replace(/^@/, '');
    if (!pattern) return false;
    if (pattern.includes('@')) return address === pattern;
    const domain = address.slice(address.lastIndexOf('@') + 1);
    return domain === pattern || domain.endsWith(`.${pattern}`);
  });
}

/** The bare address inside `Name <addr>`, or the field itself when it is one. */
function senderAddress(sender: string): string | undefined {
  const bracketed = /<([^<>\s]+@[^<>\s]+)>/.exec(sender)?.[1];
  const candidate = (bracketed ?? sender).trim();
  return /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate : undefined;
}

/**
 * A short, stable revision id for a parsed map, recorded beside every tier
 * decision so a later map edit can be told apart from a classifier change.
 */
export function sensitivityMapRevision(map: SensitivityMap | undefined): string {
  if (!map) return 'none';
  const canonical = JSON.stringify({
    schemaVersion: map.schemaVersion,
    categories: map.categories.map((category) => ({
      id: category.id,
      targetTierName: category.targetTierName,
      match: category.match,
    })),
  });
  return `v${map.schemaVersion}:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

function categoryMatches(
  category: SensitivityMapCategory,
  input: { textHaystack: string; sender: string; path: string },
): boolean {
  return category.match.keywords.some((keyword) => input.textHaystack.includes(keyword.toLowerCase()))
    || category.match.senderPatterns.some((pattern) => input.sender.includes(pattern.toLowerCase()))
    || category.match.pathPatterns.some((pattern) => input.path.includes(pattern.toLowerCase()));
}

function assertUserFacingTierMapping(value: unknown, label: string): void {
  const record = asRecord(value);
  if (!record) throw new OperationError('config_error', `${label} must be an object.`);
  for (const tierName of USER_FACING_TIER_NAMES) {
    const mapped = asRecord(record[tierName]);
    const expected = USER_FACING_TIER_MAPPING[tierName];
    if (!mapped || mapped.targetTrustTier !== expected.targetTrustTier || mapped.targetTrustDomain !== expected.targetTrustDomain) {
      throw new OperationError(
        'config_error',
        `${label}.${tierName} must map to ${expected.targetTrustTier}/${expected.targetTrustDomain}.`,
      );
    }
  }
}

function parseCategory(
  value: unknown,
  label: string,
  schemaVersion: SensitivityMapSchemaVersion,
): SensitivityMapCategory {
  const record = asRecord(value);
  if (!record) throw new OperationError('config_error', `${label} must be an object.`);
  const id = boundedString(record.id, `${label}.id`);
  if (!CATEGORY_ID_PATTERN.test(id)) {
    throw new OperationError('config_error', `${label}.id must be a stable lowercase slug like "therapy" or "family-finance".`);
  }
  const targetTierName = enumString(record.targetTierName, USER_FACING_TIER_NAMES, `${label}.targetTierName`) as UserFacingTierName;
  if (schemaVersion === 1 && (targetTierName === 'public' || targetTierName === 'private')) {
    throw new OperationError(
      'config_error',
      `${label}.targetTierName is ${targetTierName}, but a schemaVersion 1 map is raise-only: Public/Personal downgrade guidance is not supported yet. Write the map as schemaVersion 2 to use lowering categories.`,
    );
  }

  const targetTrustTier = enumString(record.targetTrustTier, SOURCE_TRUST_TIERS, `${label}.targetTrustTier`) as SourceTrustTier;
  const targetTrustDomain = enumString(record.targetTrustDomain, SOURCE_TRUST_DOMAINS, `${label}.targetTrustDomain`) as SourceTrustDomain;
  const expected = USER_FACING_TIER_MAPPING[targetTierName];
  if (targetTrustTier !== expected.targetTrustTier || targetTrustDomain !== expected.targetTrustDomain) {
    throw new OperationError(
      'config_error',
      `${label} target fields must match ${targetTierName}: ${expected.targetTrustTier}/${expected.targetTrustDomain}.`,
    );
  }

  const examples = boundedStringList(record.examples, `${label}.examples`, {
    min: 1,
    max: MAX_EXAMPLES_PER_CATEGORY,
  });
  const matchRecord = asRecord(record.match);
  if (!matchRecord) throw new OperationError('config_error', `${label}.match must be an object.`);
  const match = {
    keywords: boundedStringList(matchRecord.keywords, `${label}.match.keywords`, { max: MAX_MATCH_TERMS_PER_FIELD }),
    senderPatterns: boundedStringList(matchRecord.senderPatterns, `${label}.match.senderPatterns`, { max: MAX_MATCH_TERMS_PER_FIELD }),
    pathPatterns: boundedStringList(matchRecord.pathPatterns, `${label}.match.pathPatterns`, { max: MAX_MATCH_TERMS_PER_FIELD }),
  };
  if (match.keywords.length + match.senderPatterns.length + match.pathPatterns.length === 0) {
    throw new OperationError('config_error', `${label}.match must include at least one keyword, sender pattern, or path pattern.`);
  }

  return {
    id,
    label: boundedString(record.label, `${label}.label`),
    targetTierName,
    targetTrustTier,
    targetTrustDomain,
    examples,
    notes: typeof record.notes === 'string' ? record.notes.trim().slice(0, 2_000) : '',
    match,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function enumString(value: unknown, allowed: readonly string[], label: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new OperationError('config_error', `${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OperationError('config_error', `${label} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_STRING_LENGTH) {
    throw new OperationError('config_error', `${label} must be ${MAX_STRING_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function boundedStringList(
  value: unknown,
  label: string,
  bounds: { min?: number; max: number },
): string[] {
  if (!Array.isArray(value)) throw new OperationError('config_error', `${label} must be an array.`);
  if (bounds.min !== undefined && value.length < bounds.min) {
    throw new OperationError('config_error', `${label} must include at least ${bounds.min} item.`);
  }
  if (value.length > bounds.max) {
    throw new OperationError('config_error', `${label} must include at most ${bounds.max} items.`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = boundedString(entry, label);
    const key = text.toLowerCase();
    if (!seen.has(key)) {
      normalized.push(text);
      seen.add(key);
    }
  }
  return normalized;
}

export function isAllowedSensitivityTrustTier(value: string): value is SourceTrustTier {
  return TRUST_TIER_SET.has(value);
}

export function isAllowedSensitivityTrustDomain(value: string): value is SourceTrustDomain {
  return TRUST_DOMAIN_SET.has(value);
}

export function isUserFacingTierName(value: string): value is UserFacingTierName {
  return USER_FACING_TIER_SET.has(value as UserFacingTierName);
}
