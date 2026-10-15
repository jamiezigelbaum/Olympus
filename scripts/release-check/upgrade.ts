/**
 * The release check's upgrade leg: what is compared between an install made by
 * an earlier release and the same install after the newer release's installer
 * ran over it, the way a user updates ("Olympus 1.0.1 is available. To update,
 * run this in Terminal"). Everything here is a pure function over two state
 * snapshots (taken inside the machine by machine-agent.ts `snapshot-state`), so
 * every rule can be tested without a machine.
 *
 * What an upgrade must do, as the release states it:
 *   - the installed version is the newer one, and the engine runs;
 *   - the owner's data stays: the same items in the same tiers, no re-ingest;
 *   - the owner's settings stay: tier rules, the privacy policy's other fields,
 *     the connection an agent already holds, the install's identity;
 *   - an install still on the earlier release's DEFAULT privacy settings
 *     switches to the new default (Private items findable by meaning on the
 *     computer), with the original bytes backed up, and nothing else changes.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CheckResult } from './report.ts';

/** One stored item as the connector stores hold it. Ids are the fixture's synthetic ids. */
export interface ItemRow {
  store: string;
  id: string;
  tier: string | null;
  tombstoned: number | boolean | null;
  contentHash: string | null;
  /** The tier ledger's verdicts for the item, when the ledger has a row. */
  metadataTier?: string | null;
  contentTier?: string | null;
}

export interface PolicyState {
  sha256: string;
  /** The privacy policy file, parsed. It holds profile names and settings, never credentials. */
  json: any;
  /** Owner-only backups the product wrote beside the policy (name and digest), oldest first. */
  backups: Array<{ name: string; sha256: string }>;
}

export interface DashboardCounts {
  seen: number;
  indexed: number;
  contentReady: number;
  embedded: number;
  secretsLocated: number;
  personal: number;
  privateItems: number;
}

/** What `snapshot-state` reports from inside the machine. Counts, names and digests only. */
export interface StateSnapshot {
  version: string | null;
  build: string | null;
  engineState: string | null;
  installId: string | null;
  relayConnected: boolean | null;
  policy: PolicyState | null;
  configFiles: string[];
  /** Names (never contents) in the install's data folder: what a newer release adds there shows in the differences table. */
  dataFiles?: string[];
  workerEnvKeys: string[];
  tierRuleIds: string[];
  connections: string[];
  items: ItemRow[] | null;
  itemsError?: string;
  dashboard: DashboardCounts | null;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The release's version, read from the tarball name in an installer bundle (`olympus-<version>.tgz`). */
export function versionFromTarballName(name: string): string | undefined {
  return /^olympus-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/.exec(name)?.[1];
}

/** The Private retrieval block the earlier release shipped as its default: keyword search only. */
export function isKeywordOnlyPrivate(policy: PolicyState | null): boolean {
  const secure = policy?.json?.retrieval?.trustDomains?.secure_local;
  return secure?.activationMode === 'metadata_only' && (secure?.embeddingProfile ?? null) === null;
}

/** The new default: Private items searched by meaning, on the computer only. */
export function isLocalMeaningPrivate(policy: PolicyState | null): boolean {
  const secure = policy?.json?.retrieval?.trustDomains?.secure_local;
  return secure?.activationMode === 'hybrid_shadow'
    && secure?.embeddingProfile === 'built-in-embedding'
    && secure?.allowCloudQuery === false
    && Array.isArray(secure?.allowedEmbeddingTrust) && secure.allowedEmbeddingTrust.length === 1 && secure.allowedEmbeddingTrust[0] === 'local'
    && policy?.json?.modelProfiles?.['built-in-embedding']?.trust === 'local';
}

/**
 * The policy with the two things an upgrade of the default is allowed to change taken out: the Private
 * retrieval block and the explanatory text of the Private route. Whatever is left must be byte-for-meaning
 * identical before and after, so any other setting that moved shows up.
 */
export function withoutMigratedParts(json: any): any {
  const copy = JSON.parse(JSON.stringify(json ?? {}));
  if (copy.retrieval?.trustDomains) delete copy.retrieval.trustDomains.secure_local;
  if (copy.routes?.secure_local) delete copy.routes.secure_local.disabledReason;
  return copy;
}

/** Paths (dot-joined) at which two JSON values differ; arrays compare by index. Bounded, for a readable detail. */
export function differingPaths(a: unknown, b: unknown, base = '', out: string[] = []): string[] {
  if (out.length >= 12) return out;
  if (isDeepStrictEqual(a, b)) return out;
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
  if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) {
    out.push(base || '(root)');
    return out;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    differingPaths((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], base ? `${base}.${key}` : key, out);
  }
  return out;
}

const rowKey = (row: ItemRow): string => `${row.store}/${row.id}`;
const rowFingerprint = (row: ItemRow): string => JSON.stringify([row.tier, Boolean(row.tombstoned), row.contentHash, row.metadataTier ?? null, row.contentTier ?? null]);

/** Which stored items differ: gone, new, or changed (tier, deletion mark, content digest, ledger verdicts). */
export function compareItems(before: readonly ItemRow[], after: readonly ItemRow[]): { missing: string[]; added: string[]; changed: string[] } {
  const was = new Map(before.map((row) => [rowKey(row), rowFingerprint(row)]));
  const now = new Map(after.map((row) => [rowKey(row), rowFingerprint(row)]));
  return {
    missing: [...was.keys()].filter((key) => !now.has(key)).sort(),
    added: [...now.keys()].filter((key) => !was.has(key)).sort(),
    changed: [...was.keys()].filter((key) => now.has(key) && now.get(key) !== was.get(key)).sort(),
  };
}

function check(id: string, title: string, ok: boolean, detail: string): CheckResult {
  return { id, title, status: ok ? 'pass' : 'fail', detail };
}

export interface UpgradeExpectation {
  /** The version the baseline must report, and the version the upgraded install must report. */
  fromVersion?: string;
  toVersion?: string;
}

/**
 * The checks that need only the two snapshots (taken before the installer ran and right after the engine came
 * back). Ingest counts are compared separately once the upgraded install has settled (`evaluateCounts`).
 */
export function evaluateUpgrade(before: StateSnapshot, after: StateSnapshot, expected: UpgradeExpectation = {}): CheckResult[] {
  const checks: CheckResult[] = [];

  const versionOk = after.version !== null && after.version !== before.version
    && (expected.toVersion === undefined || after.version === expected.toVersion)
    && (expected.fromVersion === undefined || before.version === expected.fromVersion);
  checks.push(check(
    'upgrade.version',
    `The installed version changed from ${expected.fromVersion ?? 'the baseline'} to ${expected.toVersion ?? 'the candidate'}`,
    versionOk,
    `${before.version ?? 'unknown'} (${before.build ?? 'no build'}) -> ${after.version ?? 'unknown'} (${after.build ?? 'no build'})`,
  ));
  checks.push(check('upgrade.engine-running', 'The engine is running after the upgrade', after.engineState === 'running', `engine state ${after.engineState ?? 'unknown'}`));

  checks.push(check(
    'upgrade.install-identity',
    'The install keeps its identity with the relay (not registered again)',
    before.installId !== null && before.installId === after.installId,
    before.installId === after.installId ? 'same install id before and after' : 'the install id changed or was not reported',
  ));

  // The migration only applies to an install on the earlier default. An install the earlier release itself already
  // migrated (1.0.1 and later) is left alone by the update: same policy, no second backup.
  const wasDefault = isKeywordOnlyPrivate(before.policy);
  const wasMigrated = isLocalMeaningPrivate(before.policy);
  checks.push(check(
    'upgrade.baseline-default',
    'The baseline\'s Private search setting is one the migration knows: the earlier default (keyword-only) or the new default (already migrated)',
    wasDefault || wasMigrated,
    wasDefault
      ? 'Private search was keyword-only (metadata_only, no embedding profile): the update must migrate it'
      : wasMigrated ? 'Private search was already on the new default (searched by meaning on this computer): the update must leave it alone'
        : 'the baseline policy was neither the earlier default nor the new default, so the migration cannot be checked',
  ));

  const privacyTitle = 'A keyword-only Private setting switched to the new default with its original settings backed up; one already on the new default is left alone, with no second backup';
  if (before.policy && after.policy) {
    const migrated = isLocalMeaningPrivate(after.policy);
    const backedUp = after.policy.backups.some((backup) => backup.sha256 === before.policy!.sha256);
    const secure = after.policy.json?.retrieval?.trustDomains?.secure_local;
    if (wasMigrated) {
      const unchanged = isDeepStrictEqual(before.policy.json, after.policy.json);
      const newBackups = after.policy.backups.length - before.policy.backups.length;
      checks.push(check(
        'upgrade.privacy-migration',
        privacyTitle,
        migrated && unchanged && newBackups === 0,
        migrated && unchanged && newBackups === 0
          ? `no migration needed and none done: the policy is unchanged and no new backup was written (${after.policy.backups.length} backup file(s), as before)`
          : `${unchanged ? 'the policy is unchanged' : `the policy changed (${differingPaths(before.policy.json, after.policy.json).join(', ') || 'unknown fields'})`}; ${newBackups} new backup file(s); Private search ${migrated ? 'still searches by meaning' : `is now ${secure?.activationMode ?? 'unset'}`}`,
      ));
    } else {
      checks.push(check(
        'upgrade.privacy-migration',
        privacyTitle,
        wasDefault && migrated && backedUp,
        migrated
          ? `Private search now ${secure?.activationMode} with ${secure?.embeddingProfile}; ${backedUp ? 'a backup holds the original bytes' : `no backup holds the original bytes (${after.policy.backups.length} backup file(s))`}`
          : `Private search is still ${secure?.activationMode ?? 'unset'} with embedding profile ${secure?.embeddingProfile ?? 'none'}; the policy file was not migrated (${after.policy.backups.length} backup file(s))`,
      ));
    }
    const moved = differingPaths(withoutMigratedParts(before.policy.json), withoutMigratedParts(after.policy.json));
    checks.push(check(
      'upgrade.settings-kept',
      'The owner\'s other privacy settings are kept (only the Private search setting may change)',
      moved.length === 0,
      moved.length === 0 ? `every other field of the policy is unchanged (internal.allowCloudQuery ${String(after.policy.json?.retrieval?.trustDomains?.internal?.allowCloudQuery)})` : `changed: ${moved.join(', ')}`,
    ));
  } else {
    checks.push(check('upgrade.privacy-migration', privacyTitle, false, 'the privacy policy file could not be read before or after the upgrade'));
    checks.push(check('upgrade.settings-kept', 'The owner\'s other privacy settings are kept (only the Private search setting may change)', false, 'the privacy policy file could not be read before or after the upgrade'));
  }

  const lostRules = before.tierRuleIds.filter((id) => !after.tierRuleIds.includes(id));
  checks.push(check(
    'upgrade.tier-rules-kept',
    'The owner\'s tier rules are kept',
    before.tierRuleIds.length > 0 && lostRules.length === 0,
    before.tierRuleIds.length === 0 ? 'the baseline had no tier rules to keep' : lostRules.length === 0 ? `${after.tierRuleIds.length} rule(s) kept` : `lost: ${lostRules.join(', ')}`,
  ));

  const lostEnv = before.workerEnvKeys.filter((key) => !after.workerEnvKeys.includes(key));
  checks.push(check(
    'upgrade.worker-settings-kept',
    'The engine\'s own settings file keeps its entries',
    lostEnv.length === 0,
    lostEnv.length === 0 ? `${before.workerEnvKeys.length} entries kept` : `lost: ${lostEnv.join(', ')}`,
  ));

  const lostConnections = before.connections.filter((id) => !after.connections.includes(id));
  checks.push(check(
    'upgrade.connection-kept',
    'The agent connection made before the upgrade is still approved',
    before.connections.length > 0 && lostConnections.length === 0,
    before.connections.length === 0 ? 'the baseline had no agent connection to keep' : lostConnections.length === 0 ? `${after.connections.length} connection(s) kept` : `lost: ${lostConnections.join(', ')}`,
  ));

  if (before.items && after.items) {
    const moved = compareItems(before.items, after.items);
    const same = moved.missing.length === 0 && moved.added.length === 0 && moved.changed.length === 0;
    checks.push(check(
      'upgrade.items-kept',
      'The test life is kept: the same items, in the same tiers, with the same content',
      same && before.items.length > 0,
      same ? `${after.items.length} stored item(s) identical (tier, content digest, ledger verdicts)` : `missing ${moved.missing.join(', ') || 'none'}; new ${moved.added.join(', ') || 'none'}; changed ${moved.changed.join(', ') || 'none'}`,
    ));
  } else {
    checks.push(check('upgrade.items-kept', 'The test life is kept: the same items, in the same tiers, with the same content', false, `the stored items could not be read (${before.itemsError ?? after.itemsError ?? 'unknown'})`));
  }
  return checks;
}

/**
 * Counts after the upgraded install settled, against the baseline's settled counts. The upgraded install was never
 * told to sync again, so equal counts mean nothing was re-ingested or lost. Embedded may grow: the new default
 * embeds Private items, which the old default did not.
 */
export function evaluateCounts(before: DashboardCounts | null, after: DashboardCounts | null): CheckResult[] {
  if (!before || !after) return [check('upgrade.counts-kept', 'Ingest counts are unchanged without another sync', false, 'the dashboard counts could not be read before or after the upgrade')];
  const fields: Array<keyof DashboardCounts> = ['seen', 'indexed', 'contentReady', 'secretsLocated', 'personal', 'privateItems'];
  const moved = fields.filter((field) => before[field] !== after[field]);
  const embeddedOk = after.embedded >= before.embedded;
  return [check(
    'upgrade.counts-kept',
    'Ingest counts are unchanged without another sync (embedded may only grow)',
    moved.length === 0 && embeddedOk,
    moved.length === 0 && embeddedOk
      ? `seen ${after.seen}, indexed ${after.indexed}, Personal ${after.personal}, Private ${after.privateItems}, Secrets ${after.secretsLocated}; embedded ${before.embedded} -> ${after.embedded}`
      : `${moved.map((field) => `${field} ${before[field]} -> ${after[field]}`).join('; ')}${embeddedOk ? '' : `; embedded fell ${before.embedded} -> ${after.embedded}`}`,
  )];
}

export interface Difference { what: string; before: string; after: string }

/** The table of what changed across the upgrade, for the report: informational, never a verdict. */
export function describeDifferences(before: StateSnapshot, after: StateSnapshot): Difference[] {
  const rows: Difference[] = [];
  const add = (what: string, was: string, now: string): void => { if (was !== now) rows.push({ what, before: was, after: now }); };
  add('Version', before.version ?? 'unknown', after.version ?? 'unknown');
  add('Engine build', before.build ?? 'unknown', after.build ?? 'unknown');
  const secureOf = (s: StateSnapshot): string => {
    const secure = s.policy?.json?.retrieval?.trustDomains?.secure_local;
    return secure ? `${secure.activationMode}, embedding profile ${secure.embeddingProfile ?? 'none'}` : 'no policy';
  };
  add('Private search setting', secureOf(before), secureOf(after));
  const reason = (s: StateSnapshot): string => String(s.policy?.json?.routes?.secure_local?.disabledReason ?? '');
  add('Private route explanation', reason(before), reason(after));
  add('Policy backups beside the policy file', String(before.policy?.backups.length ?? 0), String(after.policy?.backups.length ?? 0));
  const addedFiles = after.configFiles.filter((name) => !before.configFiles.includes(name));
  const removedFiles = before.configFiles.filter((name) => !after.configFiles.includes(name));
  if (addedFiles.length > 0 || removedFiles.length > 0) add('Files in the config folder', `${before.configFiles.length}`, `${after.configFiles.length}: +${addedFiles.join(', ') || 'none'} -${removedFiles.join(', ') || 'none'}`);
  if (before.dataFiles && after.dataFiles) {
    const addedData = after.dataFiles.filter((name) => !before.dataFiles!.includes(name));
    const removedData = before.dataFiles.filter((name) => !after.dataFiles!.includes(name));
    if (addedData.length > 0 || removedData.length > 0) add('Files in the data folder', `${before.dataFiles.length}`, `${after.dataFiles.length}: +${addedData.join(', ') || 'none'} -${removedData.join(', ') || 'none'}`);
  }
  if (before.dashboard && after.dashboard) {
    add('Items embedded', String(before.dashboard.embedded), String(after.dashboard.embedded));
    add('Items seen / indexed', `${before.dashboard.seen} / ${before.dashboard.indexed}`, `${after.dashboard.seen} / ${after.dashboard.indexed}`);
  }
  return rows;
}
