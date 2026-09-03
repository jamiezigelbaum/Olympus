import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import {
  assertManagedPathParentsSync,
  ensurePrivateDirectoryTreeSync,
  syncDirectorySync,
  writePrivateFileAtomicSync,
} from './atomic-file.ts';
import { OperationError } from './operation-error.ts';

const MAX_UPGRADE_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_UPGRADE_ARCHIVE_ENTRIES = 20_000;
const MAX_UPGRADE_EXPANDED_BYTES = 64 * 1024 * 1024;

export interface PreparedWorkerUpgradeArtifact {
  artifactSha256: string;
  packageVersion: string;
  workingDirectory: string;
}

export function prepareWorkerUpgradeArtifact(options: {
  artifactPath: string;
  homeDir: string;
  bunBin: string;
  dryRun: boolean;
}): PreparedWorkerUpgradeArtifact {
  const sourcePath = validateArtifactPath(options.artifactPath);
  const artifactBytes = readFileSync(sourcePath);
  if (artifactBytes.byteLength <= 0 || artifactBytes.byteLength > MAX_UPGRADE_ARTIFACT_BYTES) {
    throw new OperationError('invalid_params', `Upgrade artifact must be between 1 byte and ${MAX_UPGRADE_ARTIFACT_BYTES} bytes.`);
  }
  const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');
  const snapshotDir = mkdtempSync(join(tmpdir(), '.olympus-artifact-snapshot-'));
  const artifactPath = join(snapshotDir, 'artifact.tgz');
  const descriptor = openSync(artifactPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, artifactBytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectorySync(snapshotDir);

  try {
    inspectArchive(artifactPath);

    const versionsDir = join(options.homeDir, '.local', 'share', 'olympus', 'versions');
    const workingDirectory = join(versionsDir, artifactSha256);
    assertVersionParentSafety(options.homeDir, workingDirectory);

    const stagingParent = options.dryRun ? tmpdir() : versionsDir;
    if (!options.dryRun) ensurePrivateDirectoryTreeSync(options.homeDir, versionsDir);
    const staging = mkdtempSync(join(stagingParent, '.olympus-upgrade-'));
    try {
      extractArchive(artifactPath, staging);
      assertRegularTree(staging);
      const extractedDigest = versionTreeDigest(staging);
      const packageVersion = validateExtractedPackage(staging, options.bunBin, true);
      assertRegularTree(staging);
      if (versionTreeDigest(staging) !== extractedDigest) {
        throw new OperationError(
          'invalid_params',
          'Upgrade artifact CLI preflight mutated its extracted byte tree.',
        );
      }
      if (options.dryRun) return { artifactSha256, packageVersion, workingDirectory };

      const metadataPath = join(staging, '.olympus-artifact-v1.json');
      writePrivateFileAtomicSync(metadataPath, `${JSON.stringify({
        schema_version: 1,
        artifact_sha256: artifactSha256,
        package_version: packageVersion,
      }, null, 2)}\n`);
      makeVersionTreeReadOnly(staging);
      syncVersionTree(staging);
      if (existsSync(workingDirectory)) {
        assertManagedVersionRoot(workingDirectory, artifactSha256);
        const expectedDigest = versionTreeDigest(staging);
        if (versionTreeDigest(workingDirectory) === expectedDigest) {
          removeStagingTree(staging);
          syncDirectorySync(versionsDir);
          return { artifactSha256, packageVersion, workingDirectory };
        }
      }
      publishVersionTree(staging, workingDirectory, versionsDir);
      return { artifactSha256, packageVersion, workingDirectory };
    } catch (error) {
      if (existsSync(staging)) removeStagingTree(staging);
      if (error instanceof OperationError) throw error;
      throw new OperationError(
        'config_error',
        'Could not prepare the Olympus upgrade artifact.',
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      if (options.dryRun && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function assertVersionParentSafety(homeDir: string, workingDirectory: string): void {
  try {
    assertManagedPathParentsSync(homeDir, workingDirectory, 'managed upgrade version');
  } catch (error) {
    throw new OperationError(
      'config_error',
      'Refusing an unsafe managed upgrade version parent path.',
      error instanceof Error ? error.message : undefined,
    );
  }
}

function validateArtifactPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || !isAbsolute(trimmed) || /[\0\r\n]/.test(trimmed)) {
    throw new OperationError('invalid_params', 'olympus worker upgrade requires an absolute --artifact path.');
  }
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(trimmed);
  } catch {
    throw new OperationError('invalid_params', `Upgrade artifact does not exist: ${trimmed}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new OperationError('invalid_params', 'Upgrade artifact must be a regular non-symlink file.');
  }
  if (stats.size <= 0 || stats.size > MAX_UPGRADE_ARTIFACT_BYTES) {
    throw new OperationError('invalid_params', `Upgrade artifact must be between 1 byte and ${MAX_UPGRADE_ARTIFACT_BYTES} bytes.`);
  }
  return trimmed;
}

function inspectArchive(artifactPath: string): void {
  const names = runTar(['-tzf', artifactPath], 'list').split('\n').filter(Boolean);
  const verbose = runTar(['-tvzf', artifactPath], 'inspect').split('\n').filter(Boolean);
  if (names.length === 0 || names.length > MAX_UPGRADE_ARCHIVE_ENTRIES || names.length !== verbose.length) {
    throw new OperationError('invalid_params', 'Upgrade artifact has an invalid or unbounded archive inventory.');
  }
  let expandedBytes = 0;
  for (let index = 0; index < names.length; index += 1) {
    validateArchiveEntry(names[index]!);
    const verboseEntry = verbose[index]!;
    const type = verboseEntry[0];
    if (type !== '-' && type !== 'd') {
      throw new OperationError('invalid_params', `Upgrade artifact contains a non-regular archive entry: ${names[index]}`);
    }
    if (type === '-') {
      expandedBytes += archiveEntrySize(verboseEntry, names[index]!);
      if (expandedBytes > MAX_UPGRADE_EXPANDED_BYTES) {
        throw new OperationError(
          'invalid_params',
          `Upgrade artifact expands beyond the ${MAX_UPGRADE_EXPANDED_BYTES}-byte safety limit.`,
        );
      }
    }
  }
}

function archiveEntrySize(verboseEntry: string, name: string): number {
  if (!verboseEntry.endsWith(name)) {
    throw new OperationError('invalid_params', 'Upgrade artifact has an unreadable archive inventory.');
  }
  const fields = verboseEntry.slice(0, -name.length).trim().split(/\s+/);
  const candidate = /^\d+$/.test(fields[1] ?? '') ? fields[4] : fields[2];
  if (!candidate || !/^\d+$/.test(candidate)) {
    throw new OperationError('invalid_params', 'Upgrade artifact has an unreadable expanded-size inventory.');
  }
  const size = Number(candidate);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_UPGRADE_EXPANDED_BYTES) {
    throw new OperationError('invalid_params', 'Upgrade artifact contains an unbounded regular file.');
  }
  return size;
}

function validateArchiveEntry(name: string): void {
  if (/^[\\/]/.test(name) || name.includes('\\') || /[\0\r]/.test(name)) {
    throw new OperationError('invalid_params', 'Upgrade artifact contains an unsafe archive path.');
  }
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  const components = trimmed.split('/');
  if (components[0] !== 'package' || components.some((component) => !component || component === '.' || component === '..')) {
    throw new OperationError('invalid_params', `Upgrade artifact entry is outside package/: ${name}`);
  }
  if (components.slice(1).join('/') === '.olympus-artifact-v1.json') {
    throw new OperationError('invalid_params', 'Upgrade artifact contains a reserved lifecycle metadata path.');
  }
}

function extractArchive(artifactPath: string, staging: string): void {
  runTar(['-xzf', artifactPath, '-C', staging, '--strip-components=1'], 'extract');
}

function runTar(args: string[], action: string): string {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new OperationError(
      'invalid_params',
      `Could not ${action} the Olympus upgrade artifact.`,
      (result.stderr || result.stdout || '').trim().slice(0, 240) || undefined,
    );
  }
  return result.stdout;
}

function assertRegularTree(root: string, budget: { bytes: number } = { bytes: 0 }): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      throw new OperationError('invalid_params', `Upgrade artifact extracted an unsafe entry: ${entry.name}`);
    }
    if (stats.isDirectory()) {
      assertRegularTree(path, budget);
      continue;
    }
    budget.bytes += stats.size;
    if (budget.bytes > MAX_UPGRADE_EXPANDED_BYTES) {
      throw new OperationError('invalid_params', 'Upgrade artifact extracted beyond its expanded-size safety limit.');
    }
  }
}

function validateExtractedPackage(root: string, bunBin: string, executePreflight: boolean): string {
  const packageJson = readJsonRecord(join(root, 'package.json'), 'package.json');
  const manifest = readJsonRecord(join(root, 'openclaw.plugin.json'), 'openclaw.plugin.json');
  const cliPath = join(root, 'dist', 'cli.js');
  assertRegularFile(cliPath, 'dist/cli.js');
  const version = typeof packageJson.version === 'string' ? packageJson.version.trim() : '';
  if (packageJson.name !== 'olympus' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new OperationError('invalid_params', 'Upgrade artifact package identity or version is invalid.');
  }
  if (manifest.version !== version) {
    throw new OperationError('invalid_params', 'Upgrade artifact package and plugin manifest versions do not match.');
  }
  if (executePreflight) {
    const result = spawnSync(bunBin, [cliPath, '--version'], { encoding: 'utf8', timeout: 15_000 });
    if (result.status !== 0 || result.stdout.trim() !== `olympus ${version}`) {
      throw new OperationError('invalid_params', 'Upgrade artifact CLI preflight did not report its declared Olympus version.');
    }
  }
  return version;
}

function assertManagedVersionRoot(root: string, artifactSha256: string): void {
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink() || basename(root) !== artifactSha256) {
    throw new OperationError('config_error', 'Managed upgrade version path is unsafe.');
  }
  assertRegularTree(root);
}

function readJsonRecord(path: string, label: string): Record<string, unknown> {
  assertRegularFile(path, label);
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch (error) {
    throw new OperationError(
      'invalid_params',
      `Upgrade artifact ${label} is invalid.`,
      error instanceof Error ? error.message : undefined,
    );
  }
}

function assertRegularFile(path: string, label: string): void {
  try {
    const stats = lstatSync(path);
    if (stats.isFile() && !stats.isSymbolicLink()) return;
  } catch {
    // Fall through to the typed refusal.
  }
  throw new OperationError('invalid_params', `Upgrade artifact is missing a regular ${label}.`);
}

function makeVersionTreeReadOnly(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      makeVersionTreeReadOnly(path);
      chmodSync(path, 0o555);
    } else {
      chmodSync(path, 0o444);
    }
  }
  chmodSync(root, 0o555);
  if (!statSync(root).isDirectory()) throw new OperationError('config_error', 'Managed upgrade version root changed during staging.');
}

function syncVersionTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      syncVersionTree(path);
      continue;
    }
    const descriptor = openSync(path, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  syncDirectorySync(root);
}

function versionTreeDigest(root: string): string {
  const digest = createHash('sha256');
  hashVersionTree(root, '', digest);
  return digest.digest('hex');
}

function hashVersionTree(
  root: string,
  relativeRoot: string,
  digest: ReturnType<typeof createHash>,
): void {
  const entries = readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    const stats = lstatSync(path);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      digest.update(`d\0${relativePath}\0${stats.mode & 0o777}\0`);
      hashVersionTree(path, relativePath, digest);
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new OperationError('config_error', `Managed upgrade version contains an unsafe entry: ${relativePath}`);
    }
    digest.update(`f\0${relativePath}\0${stats.mode & 0o777}\0${stats.size}\0`);
    digest.update(readFileSync(path));
  }
}

function publishVersionTree(staging: string, workingDirectory: string, versionsDir: string): void {
  let replacedPath: string | undefined;
  if (existsSync(workingDirectory)) {
    replacedPath = join(versionsDir, `.olympus-replaced-${basename(workingDirectory)}-${randomUUID()}`);
    renameSync(workingDirectory, replacedPath);
    syncDirectorySync(versionsDir);
  }
  try {
    renameSync(staging, workingDirectory);
    syncDirectorySync(versionsDir);
  } catch (error) {
    if (replacedPath && existsSync(replacedPath) && !existsSync(workingDirectory)) {
      renameSync(replacedPath, workingDirectory);
      syncDirectorySync(versionsDir);
    }
    throw error;
  }
  if (replacedPath && existsSync(replacedPath)) {
    removeStagingTree(replacedPath);
    syncDirectorySync(versionsDir);
  }
}

function removeStagingTree(root: string): void {
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) removeStagingTree(join(root, entry.name));
  }
  rmSync(root, { recursive: true, force: true });
}
