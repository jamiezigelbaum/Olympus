/**
 * Puts an Olympus release on the website, ready for site/deploy/deploy.sh.
 *
 *   OLYMPUS_GOOGLE_PILOT_CLIENT_ID=<publisher client id> bun scripts/publish-release-to-site.ts
 *   bun scripts/publish-release-to-site.ts --artifact release-artifacts/olympus-<version>.tgz
 *   bun scripts/publish-release-to-site.ts --check
 *
 * Builds the release tarball with scripts/release-artifact.ts (or takes the
 * one `--artifact` names), copies it to
 * site/releases/<version>/olympus-<version>.tgz, and writes site/install.sh
 * from scripts/install-macos.sh with the tarball's version, SHA-256 and size
 * pinned. scripts/install-macos.sh is the one source of the installer; both
 * outputs are build products (gitignored, never committed).
 *
 * `--check` is what deploy.sh runs before publishing: site/install.sh must be
 * exactly the template rendered with its own pins, pin the version in
 * package.json, and name a tarball in site/releases/ with that SHA-256 and
 * size whose package is that version; site/uninstall.sh must be present.
 * Nothing is published that a fresh install would refuse.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ReleasePins {
  version: string;
  sha256: string;
  bytes: number;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const INSTALL_TEMPLATE = 'scripts/install-macos.sh';
export const SERVED_INSTALL_SCRIPT = 'site/install.sh';
export const SERVED_UNINSTALL_SCRIPT = 'site/uninstall.sh';
export const SITE_RELEASES = 'site/releases';
/** Safe unquoted in sh and in a URL path segment. */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const PLACEHOLDERS = {
  version: 'OLYMPUS_VERSION=@OLYMPUS_VERSION@',
  sha256: 'OLYMPUS_SHA256=@OLYMPUS_SHA256@',
  bytes: 'OLYMPUS_BYTES=@OLYMPUS_BYTES@',
} as const;

export function releaseTarballPath(version: string): string {
  return `${SITE_RELEASES}/${version}/olympus-${version}.tgz`;
}

export function assertReleasePins(pins: ReleasePins): void {
  if (!VERSION_PATTERN.test(pins.version)) throw new Error(`Release version ${JSON.stringify(pins.version)} is not plain semver.`);
  if (!/^[0-9a-f]{64}$/.test(pins.sha256)) throw new Error('Release SHA-256 must be 64 lowercase hex characters.');
  if (!Number.isSafeInteger(pins.bytes) || pins.bytes <= 0) throw new Error('Release size must be a positive byte count.');
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

/** The pins a rendered installer carries, or undefined when it has none. */
export function readInstallScriptPins(script: string): ReleasePins | undefined {
  const version = /^OLYMPUS_VERSION=(\S+)$/m.exec(script)?.[1];
  const sha256 = /^OLYMPUS_SHA256=(\S+)$/m.exec(script)?.[1];
  const bytes = /^OLYMPUS_BYTES=(\S+)$/m.exec(script)?.[1];
  if (!version || !sha256 || !bytes || !/^[0-9]+$/.test(bytes)) return undefined;
  return { version, sha256, bytes: Number(bytes) };
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
  mkdirSync(dirname(tarball), { recursive: true });
  if (resolve(input.artifact) !== resolve(tarball)) copyFileSync(input.artifact, tarball);
  chmodSync(tarball, 0o644);
  writeFileSync(`${tarball}.sha256`, `${pins.sha256}  ${expectedName}\n`, { mode: 0o644 });
  const installScript = join(input.root, SERVED_INSTALL_SCRIPT);
  writeFileSync(installScript, script, { mode: 0o644 });
  chmodSync(installScript, 0o644);
  const problems = checkSiteRelease(input.root);
  if (problems.length > 0) throw new Error(`The site release does not check out:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
  return { ...pins, tarball, installScript };
}

/** Why the site's installer and release are not safe to publish; empty when they are. */
export function checkSiteRelease(root: string): string[] {
  const problems: string[] = [];
  if (!existsSync(join(root, SERVED_UNINSTALL_SCRIPT))) problems.push(`${SERVED_UNINSTALL_SCRIPT} is missing.`);
  const installPath = join(root, SERVED_INSTALL_SCRIPT);
  if (!existsSync(installPath)) {
    problems.push(`${SERVED_INSTALL_SCRIPT} is missing: run bun scripts/publish-release-to-site.ts.`);
    return problems;
  }
  const served = readFileSync(installPath, 'utf8');
  const pins = readInstallScriptPins(served);
  if (!pins) {
    problems.push(`${SERVED_INSTALL_SCRIPT} carries no release pins.`);
    return problems;
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
    return problems;
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
  return problems;
}

function main(args: string[]): void {
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
  let artifact: string | undefined;
  if (args[0] === '--artifact' && args[1] && args.length === 2) artifact = resolve(args[1]);
  else if (args.length > 0) {
    console.error('Usage: bun scripts/publish-release-to-site.ts [--artifact <olympus-<version>.tgz> | --check]');
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
