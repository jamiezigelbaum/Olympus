import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isPathDigest, pathDigest, redactedPathOffenders } from './redacted-path-digest.ts';
import { OWNER_IDENTIFIER_PATTERNS, pathCarriesOwnerIdentityToken } from './owner-identifier-patterns.ts';

const root = resolve(import.meta.dir, '..');
const PRIVATE_OPS_COMMIT = '13ae3694953b252b6805ef2c00f08585af78d433';
const PRIVATE_OPS_CI = 'https://github.com/jamiezigelbaum/olympus-ops/actions/runs/33334480340';
const LIVE_RECEIPT_PATH = 'config/private-ops-live-proof.json';
const LIVE_ATTESTATION_PATH = 'config/private-ops-live-attestation.json';
const REDACTED_FLOOR_PATH = 'config/private-ops-redacted-floor.json';
const REDACTED_FLOOR_MINIMUM = 75;
const PUBLIC_INVENTORY_COMMIT = 'c09b8feadf3f3b542f21405a7caed8e711581b34';

const RETAINED_PATHS = new Set([
  'docs/ops/HARNESS_PROTOCOL.md',
  'docs/ops/OPENCLAW_CHANGE_PROTOCOL.md',
  'scripts/ops/openclaw-safe-restart.sh',
  'scripts/ops/lib/gateway-runtime-proof.sh',
  'scripts/ops/lib/systemd-activity-classifier.sh',
  'scripts/castor-workspace-proof.ts',
  'test/openclaw-safe-restart.test.ts',
  'test/analyst-delphi.test.ts',
  'test/castor-workspace-proof.test.ts',
  'test/castor-workspace-worker-hardening.test.ts',
  'test/castor-workspace.test.ts',
  'test/credential-broker-permanent-oauth-client-errors.test.ts',
  'test/credential-broker-provider-echo-redaction.test.ts',
  'test/credential-broker-refresh-marker-lifecycle.test.ts',
  'test/credential-broker-refresh-rotation.test.ts',
  'test/credential-broker-service-account.test.ts',
  'test/credential-broker.test.ts',
  'test/delphi-scorer.test.ts',
  'test/delphi.test.ts',
]);

const ALLOWED_DOCS = new Set([
  'docs/CONTRACTS.md',
  'docs/ENGINEERING_PROCESS.md',
  'docs/QUICKSTART.md',
  'docs/SOURCE_CAPABILITIES.md',
  'docs/SOVEREIGNTY_CONFIG.md',
  'docs/TRUST_MODEL.md',
  'docs/UNINSTALL.md',
  'docs/V0_4_BASELINE.md',
  'docs/V0_4_RELEASE.md',
  'docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md',
  'docs/ops/HARNESS_PROTOCOL.md',
  'docs/ops/OAUTH_RELAY.md',
  'docs/ops/OPENCLAW_CHANGE_PROTOCOL.md',
  'docs/ops/PUBLIC_FLIP_RUNBOOK.md',
  'docs/reference/delphi-consumer-contract.md',
]);

type Disposition = 'already_absent' | 'delete_after_live_proof' | 'retained_product_or_governance';
/**
 * A disposed path whose filename carries the private host alias is recorded as
 * `path_sha256` instead of `path`: the guard hashes candidate paths and
 * compares, so it still fires on the real name without publishing it. Only
 * disposed rows may be redacted — a retained row has to name a file that is
 * still here. See scripts/redacted-path-digest.ts.
 */
interface Entry { path?: string; path_sha256?: string; source_sha256: string; replacement_sha256: string; disposition: Disposition; public_sha256?: string }
interface Ledger {
  schema_version: 1;
  source_baseline_commit: string;
  public_inventory_commit: string;
  private_ops_commit: string;
  private_ops_ci: string;
  entries: Entry[];
  counts: Record<Disposition, number>;
  live_proof: { status: 'pending' | 'passed'; receipt_path: string; receipt_sha256?: string; attestation_path: string; attestation_sha256?: string };
}

// Guarded so the redaction rule and its fail-closed assertion can be imported
// and tested without the CLI running on import.
if (import.meta.main) {
  const command = process.argv[2];
  if (command === 'generate') generate();
  else if (command === 'verify') verify(process.argv.includes('--allow-pending'));
  else throw new Error('Usage: private-ops-disposition.ts generate --source MANIFEST --replacements MANIFEST --output JSON | verify [--allow-pending]');
}

function generate(): never {
  const source = readManifest(required('--source'));
  const replacements = readManifest(required('--replacements'));
  const floor = readRedactedFloor();
  if (source.size !== replacements.size) throw new Error('Source and replacement manifest sizes differ.');
  const entries: Entry[] = [];
  for (const [path, sourceSha] of source) {
    const replacementSha = replacements.get(path);
    if (!replacementSha) throw new Error(`Missing private replacement: ${path}.`);
    const absolute = containedPath(path);
    const existedAtInventory = pathExistsAtCommit(path, PUBLIC_INVENTORY_COMMIT);
    const disposition: Disposition = !existedAtInventory ? 'already_absent' : RETAINED_PATHS.has(path) ? 'retained_product_or_governance' : 'delete_after_live_proof';
    // Redaction is decided by the rule, never by what the previous public
    // ledger happened to contain: a NEW identity-bearing path in a later
    // manifest must be redacted the first time it appears, and reading the
    // policy back out of the last published output cannot do that.
    const digest = pathDigest(path);
    const redact = disposition !== 'retained_product_or_governance'
      && classifyIdentityPath(path, { historicalDigests: floor }).carriesIdentity;
    entries.push({
      ...(redact ? { path_sha256: digest } : { path }),
      source_sha256: sourceSha,
      replacement_sha256: replacementSha,
      disposition,
      ...(disposition === 'retained_product_or_governance' ? { public_sha256: sha256File(absolute) } : {}),
    });
  }
  // Fail generation rather than publish an identity-bearing path. A disposed
  // path is redacted above, so this can only fire for a retained one — which
  // cannot be redacted, because a retained entry has to name a file that is
  // still here in order to hash it. That is a decision for a human.
  assertNoUnredactedIdentityPaths(entries, { historicalDigests: floor });
  const counts = Object.fromEntries(['already_absent', 'delete_after_live_proof', 'retained_product_or_governance'].map((value) => [value, entries.filter((entry) => entry.disposition === value).length])) as Ledger['counts'];
  const ledger: Ledger = {
    schema_version: 1,
    source_baseline_commit: '32f0cefa88a3fd76b2db2d55387c37a096fb8f1f',
    public_inventory_commit: PUBLIC_INVENTORY_COMMIT,
    private_ops_commit: PRIVATE_OPS_COMMIT,
    private_ops_ci: PRIVATE_OPS_CI,
    entries,
    counts,
    live_proof: { status: 'pending', receipt_path: LIVE_RECEIPT_PATH, attestation_path: LIVE_ATTESTATION_PATH },
  };
  const output = resolve(required('--output'));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(JSON.stringify({ kind: 'olympus_private_ops_disposition_generated', schema_version: 1, entries: entries.length, counts, content_free: true }));
  process.exit(0);
}

function verify(allowPending: boolean): never {
  const ledger = JSON.parse(readFileSync(join(root, 'config/private-ops-disposition.json'), 'utf8')) as Ledger;
  if (ledger.schema_version !== 1 || ledger.source_baseline_commit !== '32f0cefa88a3fd76b2db2d55387c37a096fb8f1f' || ledger.public_inventory_commit !== PUBLIC_INVENTORY_COMMIT || ledger.private_ops_commit !== PRIVATE_OPS_COMMIT || ledger.private_ops_ci !== PRIVATE_OPS_CI) throw new Error('Private-ops disposition authority is invalid.');
  if (!Array.isArray(ledger.entries) || ledger.entries.length !== 427 || new Set(ledger.entries.map(entryKey)).size !== 427) throw new Error('Private-ops disposition ledger is not an exact 427-path inventory.');
  const redactedDigests = new Set<string>();
  for (const entry of ledger.entries) {
    const label = entryKey(entry);
    if (!/^[0-9a-f]{64}$/.test(entry.source_sha256) || !/^[0-9a-f]{64}$/.test(entry.replacement_sha256)) throw new Error(`Invalid digest for ${label}.`);
    if (entry.path_sha256 !== undefined) {
      if (entry.path !== undefined || !isPathDigest(entry.path_sha256)) throw new Error(`Redacted entry is malformed: ${label}.`);
      // A retained path has to be readable by name to hash its contents, so it
      // can never be redacted.
      if (entry.disposition === 'retained_product_or_governance') throw new Error('A retained path may not be redacted.');
      redactedDigests.add(entry.path_sha256);
      continue;
    }
    if (entry.path === undefined) throw new Error('Entry has neither a path nor a path digest.');
    const absolute = containedPath(entry.path);
    if (entry.disposition === 'retained_product_or_governance') {
      if (!RETAINED_PATHS.has(entry.path) || !entry.public_sha256 || !existsSync(absolute) || sha256File(absolute) !== entry.public_sha256) throw new Error(`Retained path is not exact: ${entry.path}.`);
    } else if (existsSync(absolute)) throw new Error(`Disposed private path remains in Olympus: ${entry.path}.`);
    if (redactedDigests.has(pathDigest(entry.path))) throw new Error('A literal entry duplicates a redacted entry.');
  }
  // The committed ledger must satisfy the same rule generation enforces, so a
  // literal path can never be published carrying an owner identity.
  const floor = readRedactedFloor();
  assertFloorStillRedacted(floor, redactedDigests);
  assertNoUnredactedIdentityPaths(ledger.entries, { historicalDigests: floor });
  // The redacted rows are checked against every present path rather than by
  // name. Tracked files alone are not enough: a disposed file recreated but
  // never `git add`ed is still sitting in the working tree. The sweep is
  // therefore tracked files unioned with git's own untracked-but-not-ignored
  // listing, so every ignore source git honours — .gitignore at any depth,
  // .git/info/exclude, core.excludesFile — applies here identically, with no
  // second implementation to drift.
  const present = new Set([...trackedFiles(), ...untrackedFiles()]);
  const returned = redactedPathOffenders(present, redactedDigests);
  if (returned.length > 0) throw new Error(`Disposed private paths remain in Olympus: ${returned.length} file(s).`);
  if (redactedDigests.size !== 75) throw new Error('Redacted disposed-path count drifted.');
  const observed = Object.fromEntries(['already_absent', 'delete_after_live_proof', 'retained_product_or_governance'].map((value) => [value, ledger.entries.filter((entry) => entry.disposition === value).length]));
  if (JSON.stringify(observed) !== JSON.stringify(ledger.counts)) throw new Error('Private-ops disposition counts drifted.');
  const docs = allFiles(join(root, 'docs')).map((path) => relative(root, path).split(sep).join('/')).sort();
  const unexpectedDocs = docs.filter((path) => !ALLOWED_DOCS.has(path));
  const missingDocs = [...ALLOWED_DOCS].filter((path) => !docs.includes(path));
  if (unexpectedDocs.length || missingDocs.length) throw new Error(`Canonical documentation mismatch: unexpected=${unexpectedDocs.join(',')} missing=${missingDocs.join(',')}.`);
  if (ledger.live_proof.status === 'pending') {
    if (!allowPending) throw new Error('Private topology deployment and rollback proof is still pending.');
  } else {
    if (ledger.live_proof.receipt_path !== LIVE_RECEIPT_PATH || !ledger.live_proof.receipt_sha256 || ledger.live_proof.attestation_path !== LIVE_ATTESTATION_PATH || !ledger.live_proof.attestation_sha256) throw new Error('Live proof receipt binding is incomplete.');
    const receiptPath = containedPath(ledger.live_proof.receipt_path);
    if (sha256File(receiptPath) !== ledger.live_proof.receipt_sha256) throw new Error('Live proof receipt digest mismatch.');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    assertExactKeys(receipt, [
      'kind', 'schema_version', 'candidate_artifact_sha256', 'candidate_artifact_bytes',
      'previous_artifact_sha256', 'previous_artifact_bytes', 'platform', 'content_free',
      'proof_scope', 'transitions', 'final_service_state', 'final_artifact_sha256',
      'managed_plugin_installs', 'worker_upgrades', 'worker_lifecycle_dry_runs',
      'service_mutation_performed', 'mutation_performed', 'rollback_complete',
      'credential_contents_returned', 'provider_content_returned',
    ], 'Live proof receipt');
    const qualification = JSON.parse(readFileSync(join(root, 'config/release-qualification-plan.json'), 'utf8')) as { candidate_artifact: { artifact_sha256: string; artifact_bytes: number }; rollback_baseline: { artifact_sha256: string; artifact_bytes: number } };
    if (receipt.kind !== 'olympus_private_release_deploy_rollback_proof'
      || receipt.schema_version !== 1
      || receipt.candidate_artifact_sha256 !== qualification.candidate_artifact.artifact_sha256
      || receipt.candidate_artifact_bytes !== qualification.candidate_artifact.artifact_bytes
      || receipt.previous_artifact_sha256 !== qualification.rollback_baseline.artifact_sha256
      || receipt.previous_artifact_bytes !== qualification.rollback_baseline.artifact_bytes
      || receipt.platform !== 'linux'
      || receipt.proof_scope !== 'isolated_managed_plugin'
      || JSON.stringify(receipt.transitions) !== JSON.stringify(['previous_established', 'candidate_deployed', 'previous_rolled_back'])
      || receipt.final_service_state !== 'not_touched'
      || receipt.final_artifact_sha256 !== receipt.previous_artifact_sha256
      || receipt.managed_plugin_installs !== 3
      || receipt.worker_upgrades !== 0
      || receipt.worker_lifecycle_dry_runs !== 3
      || receipt.service_mutation_performed !== false
      || receipt.mutation_performed !== true
      || receipt.rollback_complete !== true
      || receipt.credential_contents_returned !== false
      || receipt.provider_content_returned !== false
      || receipt.content_free !== true) throw new Error('Live proof receipt is not the exact isolated rollback proof.');
    const attestationPath = containedPath(ledger.live_proof.attestation_path);
    if (sha256File(attestationPath) !== ledger.live_proof.attestation_sha256) throw new Error('Live proof attestation digest mismatch.');
    const attestation = JSON.parse(readFileSync(attestationPath, 'utf8')) as Record<string, unknown>;
    assertExactKeys(attestation, [
      'kind', 'schema_version', 'execution_id', 'private_ops_commit', 'private_ops_ci',
      'proof_receipt_sha256', 'authorization', 'execution_count', 'retry_count',
      'platform', 'host', 'host_redacted', 'host_class', 'isolation', 'production_before',
      'production_after', 'production_unchanged', 'production_actions', 'content_free',
    ], 'Live proof attestation');
    const production = { plugin_version: '0.3.0-alpha.1', plugin_status: 'loaded', activated: true, artifact_kind: null };
    const isolation = { temporary_home: true, temporary_openclaw_state: true, temporary_openclaw_config: true, temporary_xdg_roots: true, temporary_state_removed: true };
    const productionActions = {
      gateway_config_writes: 0, gateway_starts: 0, gateway_stops: 0, gateway_restarts: 0, service_manager_actions: 0,
      managed_plugin_installs: 0, managed_plugin_updates: 0, managed_plugin_uninstalls: 0,
      worker_installs: 0, worker_starts: 0, worker_stops: 0, worker_uninstalls: 0, worker_upgrades: 0,
      credential_reads: 0, credential_writes: 0, credential_deletes: 0,
      provider_requests: 0,
      source_data_reads: 0, source_data_writes: 0, source_data_deletes: 0,
    };
    if (attestation.kind !== 'olympus_private_release_live_attestation'
      || attestation.schema_version !== 1
      || typeof attestation.execution_id !== 'string' || !/^[0-9a-f]{64}$/.test(attestation.execution_id)
      || attestation.private_ops_commit !== PRIVATE_OPS_COMMIT
      || attestation.private_ops_ci !== PRIVATE_OPS_CI
      || attestation.proof_receipt_sha256 !== ledger.live_proof.receipt_sha256
      || attestation.authorization !== 'owner_explicit_one_isolated_plugin_proof'
      || attestation.execution_count !== 1 || attestation.retry_count !== 0
      || attestation.platform !== 'linux'
      || attestation.host !== '[redacted:private-host]'
      || attestation.host_redacted !== true
      || attestation.host_class !== 'supported_linux_private_topology'
      || JSON.stringify(attestation.isolation) !== JSON.stringify(isolation)
      || JSON.stringify(attestation.production_before) !== JSON.stringify(production)
      || JSON.stringify(attestation.production_after) !== JSON.stringify(production)
      || attestation.production_unchanged !== true
      || JSON.stringify(attestation.production_actions) !== JSON.stringify(productionActions)
      || attestation.content_free !== true) throw new Error('Live proof attestation is incomplete or not production-unchanged.');
  }
  console.log(JSON.stringify({ kind: 'olympus_private_ops_disposition_proof', schema_version: 1, entries: ledger.entries.length, counts: ledger.counts, canonical_docs: docs.length, live_proof: ledger.live_proof.status, content_free: true }));
  process.exit(0);
}

export interface IdentityPathClassification {
  /** One of the scanner's `identity` content patterns matched the path text. */
  readonly byContentPattern: boolean;
  /** An identity token appears as a substring of the path or one of its components. */
  readonly byPathToken: boolean;
  /** The path's digest is in the historically redacted set. */
  readonly byHistoricalDigest: boolean;
  /** Any of the above. This is what decides redaction. */
  readonly carriesIdentity: boolean;
}

export interface RedactedFloor {
  schema_version: 1;
  note: string;
  digests: string[];
  digests_sha256: string;
}

/**
 * The append-only redaction floor: a path that was redacted before is redacted
 * again, no matter what the matchers say.
 *
 * It lives in its OWN file, not in the ledger it protects. A floor read back
 * out of the ledger being regenerated is self-derived and worthless: swap one
 * digest for another and the count is unchanged, so nothing notices that a path
 * lost its protection. This file is the independent record, checksummed over
 * its own contents and never allowed to shrink.
 *
 * It is a floor, not the policy — the policy has to classify a path that has
 * never been published, which a set of digests cannot do.
 */
export function readRedactedFloor(floorPath: string = join(root, REDACTED_FLOOR_PATH)): Set<string> {
  const floor = JSON.parse(readFileSync(floorPath, 'utf8')) as RedactedFloor;
  if (floor.schema_version !== 1) throw new Error('Redaction floor schema is not version 1.');
  if (!Array.isArray(floor.digests) || !floor.digests.every(isPathDigest)) {
    throw new Error('Redaction floor contains a value that is not a SHA-256 digest.');
  }
  if (new Set(floor.digests).size !== floor.digests.length) throw new Error('Redaction floor has duplicate digests.');
  const sorted = [...floor.digests].sort();
  if (sorted.join('\n') !== floor.digests.join('\n')) throw new Error('Redaction floor digests are not sorted.');
  if (createHash('sha256').update(floor.digests.join('\n')).digest('hex') !== floor.digests_sha256) {
    throw new Error('Redaction floor checksum does not match its digests.');
  }
  // Append-only: the floor may grow, never shrink. The constant is the pin.
  if (floor.digests.length < REDACTED_FLOOR_MINIMUM) {
    throw new Error(`Redaction floor shrank below its append-only minimum of ${REDACTED_FLOOR_MINIMUM}.`);
  }
  return new Set(floor.digests);
}

/** Every floor digest must still be carried as a redacted entry. */
export function assertFloorStillRedacted(floor: ReadonlySet<string>, redacted: ReadonlySet<string>): void {
  const dropped = [...floor].filter((digest) => !redacted.has(digest));
  if (dropped.length === 0) return;
  throw new Error(
    `${dropped.length} path(s) on the append-only redaction floor are no longer redacted. `
    + 'A regeneration that substitutes a digest keeps the count identical, which is exactly what the floor exists to catch.',
  );
}

/**
 * Whether a path's own text carries an owner identity.
 *
 * Three independent signals, unioned, because each covers what the others
 * miss:
 *
 * - the scanner's `identity` CONTENT patterns, which catch shape-based
 *   identities a filename can carry (a home directory, a project id);
 * - SUBSTRING matching of the identity tokens over the path and each
 *   component, with no word boundaries, because a filename can run a token
 *   into the next word — the case that left three of the seventy-five
 *   historically redacted paths unclassified by the content patterns alone;
 * - the historical redacted digest set as a floor, so nothing that was once
 *   redacted can become literal again through a matcher regression.
 */
export function classifyIdentityPath(
  path: string,
  options: {
    patterns?: ReadonlyArray<{ pattern: RegExp; severity: string }>;
    tokens?: readonly string[];
    historicalDigests?: ReadonlySet<string>;
  } = {},
): IdentityPathClassification {
  const patterns = options.patterns ?? OWNER_IDENTIFIER_PATTERNS;
  const byContentPattern = patterns.some((entry) => entry.severity === 'identity'
    && new RegExp(entry.pattern.source, entry.pattern.flags.replace('g', '')).test(path));
  const byPathToken = pathCarriesOwnerIdentityToken(path, options.tokens);
  const byHistoricalDigest = options.historicalDigests?.has(pathDigest(path)) ?? false;
  return {
    byContentPattern,
    byPathToken,
    byHistoricalDigest,
    carriesIdentity: byContentPattern || byPathToken || byHistoricalDigest,
  };
}

export function pathCarriesOwnerIdentifier(
  path: string,
  patterns?: ReadonlyArray<{ pattern: RegExp; severity: string }>,
  tokens?: readonly string[],
): boolean {
  return classifyIdentityPath(path, { ...(patterns ? { patterns } : {}), ...(tokens ? { tokens } : {}) }).carriesIdentity;
}

/**
 * Refuse to write a ledger that publishes an identity-bearing path literally.
 * Any of the three signals is enough: a literal path that only the token
 * matcher catches, or only the historical floor catches, is still a leak.
 */
export function assertNoUnredactedIdentityPaths(
  entries: readonly Entry[],
  options?: {
    patterns?: ReadonlyArray<{ pattern: RegExp; severity: string }>;
    tokens?: readonly string[];
    historicalDigests?: ReadonlySet<string>;
  },
): void {
  const offenders = entries.filter((entry) => entry.path !== undefined
    && classifyIdentityPath(entry.path, options ?? {}).carriesIdentity);
  if (offenders.length === 0) return;
  throw new Error(
    `Refusing to write ${offenders.length} path(s) carrying an owner identity. `
    + 'A disposed path is redacted automatically; a retained one cannot be, so remove or rename it first.',
  );
}

function entryKey(entry: Entry): string {
  return entry.path ?? `sha256:${entry.path_sha256 ?? '<missing>'}`;
}

/**
 * Files present in the working tree that git does not track and does not
 * ignore. `--exclude-standard` applies every ignore source git itself applies,
 * which is the point: a hand-rolled .gitignore reader would miss nested
 * ignore files, core.excludesFile and .git/info/exclude, and would drift.
 */
function untrackedFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ls-files --others failed: ${result.stderr ?? ''}`);
  return result.stdout.split('\u0000').filter(Boolean);
}

function trackedFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr ?? ''}`);
  return result.stdout.split('\u0000').filter(Boolean);
}

function readManifest(pathValue: string): Map<string, string> {
  const rows = readFileSync(resolve(pathValue), 'utf8').split('\n').filter(Boolean);
  const result = new Map<string, string>();
  for (const row of rows) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._/+@=-]+)$/.exec(row);
    if (!match || result.has(match[2]!)) throw new Error('Manifest row is invalid or duplicated.');
    result.set(match[2]!, match[1]!);
  }
  return result;
}
function required(name: string): string { const index = process.argv.indexOf(name); const value = index >= 0 ? process.argv[index + 1] : undefined; if (!value) throw new Error(`${name} is required.`); return value; }
function containedPath(relativePath: string): string { const absolute = resolve(root, relativePath); if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`Path escapes repository: ${relativePath}.`); return absolute; }
function sha256File(path: string): string { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${path}.`); return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) throw new Error(`${label} fields are not exact.`);
}
function allFiles(directory: string): string[] { return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? allFiles(join(directory, entry.name)) : [join(directory, entry.name)]); }
function pathExistsAtCommit(path: string, commit: string): boolean {
  const result = spawnSync('git', ['cat-file', '-e', `${commit}:${path}`], { cwd: root, stdio: 'ignore' });
  if (result.status === 0) return true;
  if (result.status === 128) return false;
  throw new Error(`Could not inspect ${path} at ${commit}.`);
}
