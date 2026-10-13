/**
 * Puts an Olympus release on the website, ready for site/deploy/deploy.sh.
 *
 *   bun scripts/publish-release-to-site.ts   (Olympus 1.0: the source-default beta.11 Desktop client)
 *   OLYMPUS_GOOGLE_PILOT_CLIENT_ID=<desktop client id>|none bun scripts/publish-release-to-site.ts
 *   bun scripts/publish-release-to-site.ts --artifact release-artifacts/olympus-<version>.tgz
 *   bun scripts/publish-release-to-site.ts --check
 *   bun scripts/publish-release-to-site.ts --pin-bun bun-darwin-aarch64.zip
 *   bun scripts/publish-release-to-site.ts --linux --artifact release-artifacts/olympus-<version>.tgz
 *   bun scripts/publish-release-to-site.ts --linux --check
 *
 * Builds the release tarball with scripts/release-artifact.ts (or takes the
 * one `--artifact` names), copies it to
 * site/releases/<version>/olympus-<version>.tgz, and writes site/install.sh
 * from scripts/install-macos.sh with the tarball's version, SHA-256 and size
 * pinned. scripts/install-macos.sh is the one source of the installer; both
 * outputs are build products (gitignored, never committed).
 *
 * `--pin-bun <bun-darwin-aarch64.zip>` checks a Bun archive against the
 * template's archive pin (SHA-256 and size) and writes the SHA-256 of the bun
 * program inside it into the template's BUN_EXE_SHA256_DARWIN_AARCH64 line:
 * the installer runs an already-installed Bun only when it matches that.
 * Run it with the archive from the pinned URL whenever the Bun pin changes.
 *
 * `--check` is what deploy.sh runs before publishing: site/install.sh must be
 * exactly the template rendered with its own pins, pin the version in
 * package.json, and name a tarball in site/releases/ with that SHA-256 and
 * size whose package is that version; site/uninstall.sh must be present.
 * Nothing is published that a fresh install would refuse.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ReleasePins {
  version: string;
  sha256: string;
  bytes: number;
}

export interface LinuxRuntimePins {
  schema: 'olympus.linux-runtime-pins.v1';
  bun: {
    version: string;
    platform: 'linux-x64';
    url: string;
    entry: 'bun-linux-x64-baseline/bun';
    bytes: number;
    sha256: string;
    executableSha256: string;
    glibcMin: '2.17';
    cpuRequired: ['sse4_2'];
    qualification: 'pending-omarchy' | 'qualified-omarchy';
  };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const INSTALL_TEMPLATE = 'scripts/install-macos.sh';
export const SERVED_INSTALL_SCRIPT = 'site/install.sh';
export const SERVED_UNINSTALL_SCRIPT = 'site/uninstall.sh';
export const LINUX_INSTALL_TEMPLATE = 'scripts/install-linux.sh';
export const SERVED_LINUX_INSTALL_SCRIPT = 'site/install-linux.sh';
export const SERVED_LINUX_UNINSTALL_SCRIPT = 'site/uninstall-linux.sh';
export const LINUX_RUNTIME_PINS = 'config/linux-runtime-pins.json';
export const SITE_RELEASES = 'site/releases';
/** Safe unquoted in sh and in a URL path segment. */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const PLACEHOLDERS = {
  version: 'OLYMPUS_VERSION=@OLYMPUS_VERSION@',
  sha256: 'OLYMPUS_SHA256=@OLYMPUS_SHA256@',
  bytes: 'OLYMPUS_BYTES=@OLYMPUS_BYTES@',
} as const;
const LINUX_PLACEHOLDERS = {
  OLYMPUS_VERSION: (release: ReleasePins) => release.version,
  OLYMPUS_SHA256: (release: ReleasePins) => release.sha256,
  OLYMPUS_BYTES: (release: ReleasePins) => release.bytes,
  BUN_VERSION: (_release: ReleasePins, runtime: LinuxRuntimePins) => runtime.bun.version,
  BUN_URL: (_release: ReleasePins, runtime: LinuxRuntimePins) => runtime.bun.url,
  BUN_ENTRY: (_release: ReleasePins, runtime: LinuxRuntimePins) => runtime.bun.entry,
  BUN_BYTES: (_release: ReleasePins, runtime: LinuxRuntimePins) => runtime.bun.bytes,
  BUN_SHA256: (_release: ReleasePins, runtime: LinuxRuntimePins) => runtime.bun.sha256,
  BUN_EXE_SHA256: (_release: ReleasePins, runtime: LinuxRuntimePins) => runtime.bun.executableSha256,
  BUN_GLIBC_MIN: (_release: ReleasePins, runtime: LinuxRuntimePins) => runtime.bun.glibcMin,
} as const;

export function releaseTarballPath(version: string): string {
  return `${SITE_RELEASES}/${version}/olympus-${version}.tgz`;
}

export function assertReleasePins(pins: ReleasePins): void {
  if (!VERSION_PATTERN.test(pins.version)) throw new Error(`Release version ${JSON.stringify(pins.version)} is not plain semver.`);
  if (!/^[0-9a-f]{64}$/.test(pins.sha256)) throw new Error('Release SHA-256 must be 64 lowercase hex characters.');
  if (!Number.isSafeInteger(pins.bytes) || pins.bytes <= 0) throw new Error('Release size must be a positive byte count.');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}.`);
  }
}

/** Validate the fail-closed Linux x64 runtime manifest without qualifying it. */
export function validateLinuxRuntimePins(value: unknown): LinuxRuntimePins {
  const manifest = record(value, LINUX_RUNTIME_PINS);
  requireExactKeys(manifest, ['schema', 'bun'], LINUX_RUNTIME_PINS);
  if (manifest.schema !== 'olympus.linux-runtime-pins.v1') throw new Error(`${LINUX_RUNTIME_PINS} has an unsupported schema.`);
  const bun = record(manifest.bun, `${LINUX_RUNTIME_PINS} bun pin`);
  requireExactKeys(bun, ['version', 'platform', 'url', 'entry', 'bytes', 'sha256', 'executableSha256', 'glibcMin', 'cpuRequired', 'qualification'], `${LINUX_RUNTIME_PINS} bun pin`);
  if (typeof bun.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(bun.version)) throw new Error('Linux Bun version must be stable X.Y.Z.');
  if (bun.platform !== 'linux-x64') throw new Error('Linux Bun platform must be linux-x64; arm64 and other targets are not qualified.');
  const expectedUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${bun.version}/bun-linux-x64-baseline.zip`;
  if (bun.url !== expectedUrl) throw new Error(`Linux Bun URL must be the exact versioned oven-sh baseline URL ${expectedUrl}.`);
  if (bun.entry !== 'bun-linux-x64-baseline/bun') throw new Error('Linux Bun archive entry must be bun-linux-x64-baseline/bun.');
  if (!Number.isSafeInteger(bun.bytes) || (bun.bytes as number) <= 0) throw new Error('Linux Bun archive size must be a positive byte count.');
  for (const [label, digest] of [['archive', bun.sha256], ['executable', bun.executableSha256]] as const) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error(`Linux Bun ${label} SHA-256 must be 64 lowercase hex characters.`);
  }
  if (bun.glibcMin !== '2.17') throw new Error('Linux Bun glibcMin must be 2.17.');
  if (!Array.isArray(bun.cpuRequired) || bun.cpuRequired.length !== 1 || bun.cpuRequired[0] !== 'sse4_2') {
    throw new Error('Linux Bun cpuRequired must be exactly ["sse4_2"].');
  }
  if (bun.qualification !== 'pending-omarchy' && bun.qualification !== 'qualified-omarchy') {
    throw new Error('Linux Bun qualification must be pending-omarchy or qualified-omarchy.');
  }
  return value as LinuxRuntimePins;
}

export function readLinuxRuntimePins(path: string): LinuxRuntimePins {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateLinuxRuntimePins(parsed);
}

/** The template with its three pin lines filled in; nothing else changes. */
export function renderInstallScript(template: string, pins: ReleasePins): string {
  assertReleasePins(pins);
  let rendered = template;
  for (const [key, line] of Object.entries(PLACEHOLDERS) as Array<[keyof ReleasePins, string]>) {
    const lines = rendered.split('\n').filter((candidate) => candidate === line);
    if (lines.length !== 1) throw new Error(`${INSTALL_TEMPLATE} must contain the line ${line} exactly once.`);
    rendered = rendered.replace(`\n${line}\n`, `\n${line.split('=')[0]}=${pins[key]}\n`);
  }
  if (rendered.includes('@OLYMPUS_')) throw new Error(`${INSTALL_TEMPLATE} has a placeholder this script does not fill.`);
  return rendered;
}

/** Fill every release/runtime pin in the Linux template; pending pins may be rendered for tests. */
export function renderLinuxInstallScript(template: string, releasePins: ReleasePins, runtimePins: LinuxRuntimePins): string {
  assertReleasePins(releasePins);
  validateLinuxRuntimePins(runtimePins);
  let rendered = template;
  for (const [name, value] of Object.entries(LINUX_PLACEHOLDERS) as Array<[
    keyof typeof LINUX_PLACEHOLDERS,
    (release: ReleasePins, runtime: LinuxRuntimePins) => string | number,
  ]>) {
    const placeholder = `${name}=@${name}@`;
    const assignments = rendered.split('\n').filter((line) => line.startsWith(`${name}=`));
    if (assignments.length !== 1 || assignments[0] !== placeholder) {
      throw new Error(`${LINUX_INSTALL_TEMPLATE} must contain exactly one ${name}= assignment, and it must be ${placeholder}.`);
    }
    rendered = rendered.replace(placeholder, `${name}=${value(releasePins, runtimePins)}`);
  }
  const unfilled = rendered.match(/@[A-Z][A-Z0-9_]*@/gi);
  if (unfilled) throw new Error(`${LINUX_INSTALL_TEMPLATE} has an unfilled placeholder: ${unfilled[0]}.`);
  return rendered;
}

/** The pins a rendered installer carries, or undefined when it has none. */
export function readInstallScriptPins(script: string): ReleasePins | undefined {
  const version = /^OLYMPUS_VERSION=(\S+)$/m.exec(script)?.[1];
  const sha256 = /^OLYMPUS_SHA256=(\S+)$/m.exec(script)?.[1];
  const bytes = /^OLYMPUS_BYTES=(\S+)$/m.exec(script)?.[1];
  if (!version || !sha256 || !bytes || !/^[0-9]+$/.test(bytes)) return undefined;
  return { version, sha256, bytes: Number(bytes) };
}

export interface BunPins {
  zipSha256: string;
  zipBytes: number;
  exeSha256: string;
}
/** The program inside Bun's Apple-silicon release archive. */
export const BUN_ZIP_ENTRY = 'bun-darwin-aarch64/bun';

/** The Bun pins the installer template carries, or undefined when one is missing. */
export function readBunPins(template: string): BunPins | undefined {
  const zipSha256 = /^BUN_SHA256_DARWIN_AARCH64=([0-9a-f]{64})$/m.exec(template)?.[1];
  const zipBytes = /^BUN_BYTES_DARWIN_AARCH64=([0-9]+)$/m.exec(template)?.[1];
  const exeSha256 = /^BUN_EXE_SHA256_DARWIN_AARCH64=([0-9a-f]{64})$/m.exec(template)?.[1];
  if (!zipSha256 || !zipBytes || !exeSha256) return undefined;
  return { zipSha256, zipBytes: Number(zipBytes), exeSha256 };
}

/**
 * The SHA-256 of the bun program inside a Bun release archive, once the
 * archive matches the template's pinned SHA-256 and size.
 */
export function bunExecutableDigest(zipPath: string, pins: Pick<BunPins, 'zipSha256' | 'zipBytes'>): string {
  const archive = fileDigest(zipPath);
  if (archive.sha256 !== pins.zipSha256 || archive.bytes !== pins.zipBytes) {
    throw new Error(`${zipPath} is not the pinned Bun archive: SHA-256 ${archive.sha256} and ${archive.bytes} bytes, not ${pins.zipSha256} and ${pins.zipBytes}.`);
  }
  const entry = spawnSync('unzip', ['-p', zipPath, BUN_ZIP_ENTRY], { maxBuffer: 512 * 1024 * 1024 });
  if (entry.status !== 0 || entry.stdout.length === 0) {
    throw new Error(`${zipPath} has no ${BUN_ZIP_ENTRY}: ${entry.stderr.toString().trim()}`);
  }
  return createHash('sha256').update(entry.stdout).digest('hex');
}

/** Verify the Linux Bun archive before reading its pinned executable; never execute it. */
export function verifyLinuxRuntimeArchive(zipPath: string, runtimePins: LinuxRuntimePins): { sha256: string; bytes: number; executableSha256: string } {
  const pins = validateLinuxRuntimePins(runtimePins);
  const archive = fileDigest(zipPath);
  if (archive.sha256 !== pins.bun.sha256 || archive.bytes !== pins.bun.bytes) {
    throw new Error(`${zipPath} is not the pinned Linux Bun archive: SHA-256 ${archive.sha256} and ${archive.bytes} bytes, not ${pins.bun.sha256} and ${pins.bun.bytes}.`);
  }
  const entry = spawnSync('unzip', ['-p', zipPath, pins.bun.entry], { maxBuffer: 512 * 1024 * 1024 });
  if (entry.status !== 0 || entry.stdout.length === 0) {
    throw new Error(`${zipPath} has no ${pins.bun.entry}: ${entry.stderr.toString().trim()}`);
  }
  const executableSha256 = createHash('sha256').update(entry.stdout).digest('hex');
  if (executableSha256 !== pins.bun.executableSha256) {
    throw new Error(`${zipPath} contains Linux Bun executable SHA-256 ${executableSha256}, not ${pins.bun.executableSha256}.`);
  }
  return { ...archive, executableSha256 };
}

/** The template with its BUN_EXE_SHA256_DARWIN_AARCH64 line set to `exeSha256`. */
export function pinBunExecutable(template: string, exeSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(exeSha256)) throw new Error('The Bun program SHA-256 must be 64 lowercase hex characters.');
  const line = /^BUN_EXE_SHA256_DARWIN_AARCH64=.*$/m;
  if (template.split('\n').filter((candidate) => candidate.startsWith('BUN_EXE_SHA256_DARWIN_AARCH64=')).length !== 1) {
    throw new Error(`${INSTALL_TEMPLATE} must contain one BUN_EXE_SHA256_DARWIN_AARCH64= line.`);
  }
  return template.replace(line, `BUN_EXE_SHA256_DARWIN_AARCH64=${exeSha256}`);
}

export function fileDigest(path: string): { sha256: string; bytes: number } {
  const data = readFileSync(path);
  return { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
}

/** name and version from package/package.json inside a release tarball. */
export function tarballPackage(path: string): { name?: string; version?: string } {
  const result = spawnSync('tar', ['-xzOf', path, 'package/package.json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${path} has no package/package.json: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout) as { name?: string; version?: string };
}

export function sourceVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
  if (!pkg.version) throw new Error('package.json has no version.');
  return pkg.version;
}

/** Copy a tarball into site/releases and write site/install.sh pinned to it. */
export function publishToSite(input: { root: string; artifact: string }): ReleasePins & { tarball: string; installScript: string } {
  if (!existsSync(input.artifact)) throw new Error(`${input.artifact} does not exist.`);
  const version = sourceVersion(input.root);
  const expectedName = `olympus-${version}.tgz`;
  if (basename(input.artifact) !== expectedName) {
    throw new Error(`${input.artifact} is not ${expectedName}, the tarball for package.json version ${version}.`);
  }
  const packaged = tarballPackage(input.artifact);
  if (packaged.name !== 'olympus' || packaged.version !== version) {
    throw new Error(`${input.artifact} packages ${packaged.name}@${packaged.version}, not olympus@${version}.`);
  }
  const pins = { version, ...fileDigest(input.artifact) };
  const template = readFileSync(join(input.root, INSTALL_TEMPLATE), 'utf8');
  const script = renderInstallScript(template, pins);
  const tarball = join(input.root, releaseTarballPath(version));
  let preserveLinuxAsset = false;
  const linuxInstaller = join(input.root, SERVED_LINUX_INSTALL_SCRIPT);
  if (existsSync(linuxInstaller)) {
    const linuxProblems = checkLinuxSiteRelease(input.root);
    if (linuxProblems.length > 0) throw new Error(`The existing Linux site release does not check out:\n${linuxProblems.map((line) => `  - ${line}`).join('\n')}`);
    const linuxPins = readInstallScriptPins(readFileSync(linuxInstaller, 'utf8'))!;
    if (linuxPins.version === version) {
      if (linuxPins.sha256 !== pins.sha256 || linuxPins.bytes !== pins.bytes) {
        throw new Error(`${releaseTarballPath(version)} is pinned by ${SERVED_LINUX_INSTALL_SCRIPT}; refusing to replace its immutable tarball or checksum.`);
      }
      preserveLinuxAsset = true;
    }
  }
  mkdirSync(dirname(tarball), { recursive: true });
  if (!preserveLinuxAsset) {
    if (resolve(input.artifact) !== resolve(tarball)) copyFileSync(input.artifact, tarball);
    chmodSync(tarball, 0o644);
    writeFileSync(`${tarball}.sha256`, `${pins.sha256}  ${expectedName}\n`, { mode: 0o644 });
  }
  const installScript = join(input.root, SERVED_INSTALL_SCRIPT);
  writeFileSync(installScript, script, { mode: 0o644 });
  chmodSync(installScript, 0o644);
  const problems = checkSiteRelease(input.root);
  if (problems.length > 0) throw new Error(`The site release does not check out:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
  return { ...pins, tarball, installScript };
}

function linuxQualificationProblem(pins: LinuxRuntimePins): string | undefined {
  if (pins.bun.qualification !== 'qualified-omarchy') {
    return `${LINUX_RUNTIME_PINS} is ${pins.bun.qualification}; Linux publication requires qualified-omarchy.`;
  }
  return undefined;
}

/** Publish only the Linux installer and its shared immutable release asset. */
export function publishLinuxToSite(input: { root: string; artifact: string }): ReleasePins & { tarball: string; installScript: string } {
  if (!existsSync(input.artifact)) throw new Error(`${input.artifact} does not exist.`);
  const version = sourceVersion(input.root);
  const expectedName = `olympus-${version}.tgz`;
  if (basename(input.artifact) !== expectedName) {
    throw new Error(`${input.artifact} is not ${expectedName}, the tarball for package.json version ${version}.`);
  }
  const packaged = tarballPackage(input.artifact);
  if (packaged.name !== 'olympus' || packaged.version !== version) {
    throw new Error(`${input.artifact} packages ${packaged.name}@${packaged.version}, not olympus@${version}.`);
  }
  const pins = { version, ...fileDigest(input.artifact) };
  const runtime = readLinuxRuntimePins(join(input.root, LINUX_RUNTIME_PINS));
  const qualificationProblem = linuxQualificationProblem(runtime);
  if (qualificationProblem) throw new Error(qualificationProblem);
  if (!existsSync(join(input.root, SERVED_LINUX_UNINSTALL_SCRIPT))) throw new Error(`${SERVED_LINUX_UNINSTALL_SCRIPT} is missing.`);
  const script = renderLinuxInstallScript(readFileSync(join(input.root, LINUX_INSTALL_TEMPLATE), 'utf8'), pins, runtime);
  const tarball = join(input.root, releaseTarballPath(version));
  const checksum = `${tarball}.sha256`;
  const installScript = join(input.root, SERVED_LINUX_INSTALL_SCRIPT);
  const expectedChecksum = `${pins.sha256}  ${expectedName}\n`;

  // Finish every read-only preflight before creating or replacing site assets.
  if (existsSync(installScript) && (!lstatSync(installScript).isFile() || lstatSync(installScript).isSymbolicLink())) {
    throw new Error(`${SERVED_LINUX_INSTALL_SCRIPT} is not a regular file.`);
  }
  if (existsSync(tarball)) {
    if (!lstatSync(tarball).isFile() || lstatSync(tarball).isSymbolicLink()) throw new Error(`${releaseTarballPath(version)} is not a regular immutable asset.`);
    const existing = fileDigest(tarball);
    if (existing.sha256 !== pins.sha256 || existing.bytes !== pins.bytes) throw new Error(`${releaseTarballPath(version)} already exists with different contents; refusing to overwrite it.`);
  }
  if (existsSync(checksum)) {
    if (!lstatSync(checksum).isFile() || lstatSync(checksum).isSymbolicLink()) throw new Error(`${releaseTarballPath(version)}.sha256 is not a regular immutable asset.`);
    if (readFileSync(checksum, 'utf8') !== expectedChecksum) throw new Error(`${releaseTarballPath(version)}.sha256 already exists with different contents; refusing to overwrite it.`);
  }

  mkdirSync(dirname(tarball), { recursive: true });
  let createdTarball = false;
  if (!existsSync(tarball)) {
    try {
      copyFileSync(input.artifact, tarball, constants.COPYFILE_EXCL);
      createdTarball = true;
    } catch (error) {
      const existing = existsSync(tarball) && lstatSync(tarball).isFile() && !lstatSync(tarball).isSymbolicLink() ? fileDigest(tarball) : undefined;
      if (!existing || existing.sha256 !== pins.sha256 || existing.bytes !== pins.bytes) throw error;
    }
  }
  if (createdTarball) chmodSync(tarball, 0o644);
  let createdChecksum = false;
  if (!existsSync(checksum)) {
    try {
      writeFileSync(checksum, expectedChecksum, { mode: 0o644, flag: 'wx' });
      createdChecksum = true;
    } catch (error) {
      if (!existsSync(checksum) || !lstatSync(checksum).isFile() || lstatSync(checksum).isSymbolicLink() || readFileSync(checksum, 'utf8') !== expectedChecksum) throw error;
    }
  }
  if (createdChecksum) chmodSync(checksum, 0o644);
  writeFileSync(installScript, script, { mode: 0o644 });
  chmodSync(installScript, 0o644);
  const problems = checkLinuxSiteRelease(input.root);
  if (problems.length > 0) throw new Error(`The Linux site release does not check out:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
  return { ...pins, tarball, installScript };
}

/** Why the site's installer and release are not safe to publish; empty when they are. */
export function checkSiteRelease(root: string): string[] {
  const problems: string[] = [];
  const finish = (): string[] => {
    if (existsSync(join(root, SERVED_LINUX_INSTALL_SCRIPT))) problems.push(...checkLinuxSiteRelease(root));
    return problems;
  };
  if (!existsSync(join(root, SERVED_UNINSTALL_SCRIPT))) problems.push(`${SERVED_UNINSTALL_SCRIPT} is missing.`);
  const installPath = join(root, SERVED_INSTALL_SCRIPT);
  if (!existsSync(installPath)) {
    problems.push(`${SERVED_INSTALL_SCRIPT} is missing: run bun scripts/publish-release-to-site.ts.`);
    return finish();
  }
  const served = readFileSync(installPath, 'utf8');
  const pins = readInstallScriptPins(served);
  if (!pins) {
    problems.push(`${SERVED_INSTALL_SCRIPT} carries no release pins.`);
    return finish();
  }
  try {
    const expected = renderInstallScript(readFileSync(join(root, INSTALL_TEMPLATE), 'utf8'), pins);
    if (expected !== served) {
      problems.push(`${SERVED_INSTALL_SCRIPT} differs from ${INSTALL_TEMPLATE} rendered with its pins: run bun scripts/publish-release-to-site.ts again.`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const version = sourceVersion(root);
  if (pins.version !== version) problems.push(`${SERVED_INSTALL_SCRIPT} pins ${pins.version}, but package.json is ${version}.`);
  const tarball = join(root, releaseTarballPath(pins.version));
  if (!existsSync(tarball)) {
    problems.push(`${releaseTarballPath(pins.version)} is missing.`);
    return finish();
  }
  const digest = fileDigest(tarball);
  if (digest.sha256 !== pins.sha256) problems.push(`${releaseTarballPath(pins.version)} has SHA-256 ${digest.sha256}, not the pinned ${pins.sha256}.`);
  if (digest.bytes !== pins.bytes) problems.push(`${releaseTarballPath(pins.version)} is ${digest.bytes} bytes, not the pinned ${pins.bytes}.`);
  try {
    const packaged = tarballPackage(tarball);
    if (packaged.name !== 'olympus' || packaged.version !== pins.version) {
      problems.push(`${releaseTarballPath(pins.version)} packages ${packaged.name}@${packaged.version}, not olympus@${pins.version}.`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return finish();
}

/** Why the Linux installer and release are not safe to publish; empty when they are. */
export function checkLinuxSiteRelease(root: string): string[] {
  const problems: string[] = [];
  if (!existsSync(join(root, SERVED_LINUX_UNINSTALL_SCRIPT))) problems.push(`${SERVED_LINUX_UNINSTALL_SCRIPT} is missing.`);
  let runtime: LinuxRuntimePins;
  try {
    runtime = readLinuxRuntimePins(join(root, LINUX_RUNTIME_PINS));
    const qualificationProblem = linuxQualificationProblem(runtime);
    if (qualificationProblem) problems.push(qualificationProblem);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return problems;
  }
  const installPath = join(root, SERVED_LINUX_INSTALL_SCRIPT);
  if (!existsSync(installPath)) {
    problems.push(`${SERVED_LINUX_INSTALL_SCRIPT} is missing: run bun scripts/publish-release-to-site.ts --linux --artifact <artifact>.`);
    return problems;
  }
  const served = readFileSync(installPath, 'utf8');
  const pins = readInstallScriptPins(served);
  if (!pins) {
    problems.push(`${SERVED_LINUX_INSTALL_SCRIPT} carries no release pins.`);
    return problems;
  }
  try {
    const expected = renderLinuxInstallScript(readFileSync(join(root, LINUX_INSTALL_TEMPLATE), 'utf8'), pins, runtime);
    if (expected !== served) problems.push(`${SERVED_LINUX_INSTALL_SCRIPT} differs from ${LINUX_INSTALL_TEMPLATE} rendered with its pins.`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const version = sourceVersion(root);
  if (pins.version !== version) problems.push(`${SERVED_LINUX_INSTALL_SCRIPT} pins ${pins.version}, but package.json is ${version}.`);
  const tarball = join(root, releaseTarballPath(pins.version));
  if (!existsSync(tarball)) {
    problems.push(`${releaseTarballPath(pins.version)} is missing.`);
    return problems;
  }
  if (!lstatSync(tarball).isFile() || lstatSync(tarball).isSymbolicLink()) {
    problems.push(`${releaseTarballPath(pins.version)} is not a regular immutable asset.`);
    return problems;
  }
  const digest = fileDigest(tarball);
  if (digest.sha256 !== pins.sha256) problems.push(`${releaseTarballPath(pins.version)} has SHA-256 ${digest.sha256}, not the pinned ${pins.sha256}.`);
  if (digest.bytes !== pins.bytes) problems.push(`${releaseTarballPath(pins.version)} is ${digest.bytes} bytes, not the pinned ${pins.bytes}.`);
  const checksumPath = `${tarball}.sha256`;
  const expectedChecksum = `${pins.sha256}  olympus-${pins.version}.tgz\n`;
  if (!existsSync(checksumPath)) problems.push(`${releaseTarballPath(pins.version)}.sha256 is missing.`);
  else if (!lstatSync(checksumPath).isFile() || lstatSync(checksumPath).isSymbolicLink()) problems.push(`${releaseTarballPath(pins.version)}.sha256 is not a regular immutable asset.`);
  else if (readFileSync(checksumPath, 'utf8') !== expectedChecksum) problems.push(`${releaseTarballPath(pins.version)}.sha256 does not match the installer pins.`);
  try {
    const packaged = tarballPackage(tarball);
    if (packaged.name !== 'olympus' || packaged.version !== pins.version) {
      problems.push(`${releaseTarballPath(pins.version)} packages ${packaged.name}@${packaged.version}, not olympus@${pins.version}.`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}

/** Local acceptance uses the real pinned installer without weakening publication qualification. */
export function prepareLinuxLocalBundle(input: { root: string; artifact: string; output: string }): ReleasePins & { directory: string } {
  const version = sourceVersion(input.root);
  const packaged = tarballPackage(input.artifact);
  if (packaged.name !== 'olympus' || packaged.version !== version) throw new Error('Local tarball identity does not match the source package version.');
  const pins = { version, ...fileDigest(input.artifact) };
  const runtime = readLinuxRuntimePins(join(input.root, LINUX_RUNTIME_PINS));
  const script = renderLinuxInstallScript(readFileSync(join(input.root, LINUX_INSTALL_TEMPLATE), 'utf8'), pins, runtime);
  // Refuse an existing output rather than accidentally mixing two candidates.
  mkdirSync(input.output, { mode: 0o700 });
  const name = `olympus-${version}.tgz`;
  copyFileSync(input.artifact, join(input.output, name), constants.COPYFILE_EXCL);
  writeFileSync(join(input.output, 'install-linux.sh'), script, { mode: 0o700, flag: 'wx' });
  copyFileSync(join(input.root, SERVED_LINUX_UNINSTALL_SCRIPT), join(input.output, 'uninstall-linux.sh'), constants.COPYFILE_EXCL);
  writeFileSync(join(input.output, 'SHA256SUMS'), `${pins.sha256}  ${name}\n`, { flag: 'wx' });
  writeFileSync(join(input.output, 'README.txt'),
    `Local Linux x64 acceptance candidate; not host-qualified or published.\n`
    + `sha256sum -c SHA256SUMS\nsh ./install-linux.sh --tarball "$(pwd)/${name}"\n`
    + `sh ./uninstall-linux.sh\nData is retained by default. See the Omarchy acceptance runbook for explicit purge and recovery.\n`, { flag: 'wx' });
  return { ...pins, directory: input.output };
}

function main(args: string[]): void {
  if (args[0] === '--linux-local' && args[1] === '--artifact' && args[2]
    && args[3] === '--output' && args[4] && args.length === 5) {
    const result = prepareLinuxLocalBundle({ root: ROOT, artifact: resolve(args[2]), output: resolve(args[4]) });
    console.log(`Local Omarchy acceptance bundle: ${result.directory}`);
    console.log(`SHA-256 ${result.sha256}; ${result.bytes} bytes. Not published or host-qualified.`);
    return;
  }
  if (args[0] === '--linux' && args[1] === '--check' && args.length === 2) {
    const problems = checkLinuxSiteRelease(ROOT);
    if (problems.length > 0) {
      console.error(`The site's Linux installer and release are not ready to publish:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
      process.exit(1);
    }
    const pins = readInstallScriptPins(readFileSync(join(ROOT, SERVED_LINUX_INSTALL_SCRIPT), 'utf8'))!;
    console.log(`site/install-linux.sh pins olympus ${pins.version} (SHA-256 ${pins.sha256}, ${pins.bytes} bytes); the tarball matches.`);
    return;
  }
  if (args[0] === '--linux' && args[1] === '--artifact' && args[2] && args.length === 3) {
    const result = publishLinuxToSite({ root: ROOT, artifact: resolve(args[2]) });
    console.log(`Wrote ${result.tarball}`);
    console.log(`Wrote ${result.installScript}`);
    console.log(`Pinned Linux olympus ${result.version}: SHA-256 ${result.sha256}, ${result.bytes} bytes.`);
    console.log('Publish with: site/deploy/deploy.sh --dry-run, then site/deploy/deploy.sh');
    return;
  }
  if (args[0] === '--check' && args.length === 1) {
    const problems = checkSiteRelease(ROOT);
    if (problems.length > 0) {
      console.error(`The site's installer and release are not ready to publish:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
      process.exit(1);
    }
    const pins = readInstallScriptPins(readFileSync(join(ROOT, SERVED_INSTALL_SCRIPT), 'utf8'))!;
    console.log(`site/install.sh pins olympus ${pins.version} (SHA-256 ${pins.sha256}, ${pins.bytes} bytes); the tarball matches.`);
    return;
  }
  if (args[0] === '--pin-bun' && args[1] && args.length === 2) {
    const templatePath = join(ROOT, INSTALL_TEMPLATE);
    const template = readFileSync(templatePath, 'utf8');
    const pins = readBunPins(template);
    if (!pins) {
      console.error(`${INSTALL_TEMPLATE} has no complete Bun pins.`);
      process.exit(1);
    }
    const exeSha256 = bunExecutableDigest(resolve(args[1]), pins);
    if (exeSha256 === pins.exeSha256) {
      console.log(`${INSTALL_TEMPLATE} already pins the bun program in that archive: ${exeSha256}.`);
      return;
    }
    writeFileSync(templatePath, pinBunExecutable(template, exeSha256));
    console.log(`Pinned the bun program in ${INSTALL_TEMPLATE}: ${exeSha256} (was ${pins.exeSha256}).`);
    return;
  }
  let artifact: string | undefined;
  if (args[0] === '--artifact' && args[1] && args.length === 2) artifact = resolve(args[1]);
  else if (args.length > 0) {
    console.error('Usage: bun scripts/publish-release-to-site.ts [--artifact <olympus-<version>.tgz> | --check | --pin-bun <bun-darwin-aarch64.zip> | --linux --artifact <olympus-<version>.tgz> | --linux --check]');
    process.exit(2);
  }
  if (!artifact) {
    const built = spawnSync('bun', [join(ROOT, 'scripts/release-artifact.ts')], { cwd: ROOT, stdio: 'inherit' });
    if (built.status !== 0) process.exit(built.status ?? 1);
    artifact = join(ROOT, 'release-artifacts', `olympus-${sourceVersion(ROOT)}.tgz`);
  }
  const result = publishToSite({ root: ROOT, artifact });
  console.log(`Wrote ${result.tarball}`);
  console.log(`Wrote ${result.installScript}`);
  console.log(`Pinned olympus ${result.version}: SHA-256 ${result.sha256}, ${result.bytes} bytes.`);
  console.log('Publish with: site/deploy/deploy.sh --dry-run, then site/deploy/deploy.sh');
}

if (import.meta.main) main(process.argv.slice(2));
