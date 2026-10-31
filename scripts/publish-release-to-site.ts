/**
 * Puts an Olympus release on the website, ready for site/deploy/deploy.sh.
 *
 *   bun scripts/publish-release-to-site.ts   (Olympus 1.0: the source-default beta.11 Desktop client)
 *   OLYMPUS_GOOGLE_PILOT_CLIENT_ID=<desktop client id>|none bun scripts/publish-release-to-site.ts
 *   bun scripts/publish-release-to-site.ts --artifact release-artifacts/olympus-<version>.tgz
 *   bun scripts/publish-release-to-site.ts --check
 *   bun scripts/publish-release-to-site.ts --pin-bun bun-darwin-aarch64.zip
 *   bun scripts/publish-release-to-site.ts --linux --artifact release-artifacts/olympus-<version>.tgz --whatsapp-bridge <bridge>-linux-x64
 *   bun scripts/publish-release-to-site.ts --linux --check
 *   bun scripts/publish-release-to-site.ts --mac-local --artifact <olympus-<version>.tgz> --output <new dir>
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
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { whatsappBridgeFileName } from '../src/core/whatsapp-bridge-name.ts';

export interface ReleasePins {
  version: string;
  sha256: string;
  bytes: number;
}

/**
 * A release's prebuilt WhatsApp bridge, for Apple silicon or Linux x64
 * (.github/workflows/whatsapp-bridge-build.yml). The installer downloads it
 * beside the tarball and places it where pairing looks, so pairing needs no
 * Go or C compiler. `name` is the bridge's source fingerprint name.
 */
export interface WhatsAppBridgePins {
  name: string;
  sha256: string;
  bytes: number;
}

/** The platforms a release bridge is built for, and the served file's suffix. */
export type WhatsAppBridgePlatform = 'darwin-arm64' | 'linux-x64';

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
const BRIDGE_PLACEHOLDERS = {
  name: 'WHATSAPP_BRIDGE_NAME=@WHATSAPP_BRIDGE_NAME@',
  sha256: 'WHATSAPP_BRIDGE_SHA256=@WHATSAPP_BRIDGE_SHA256@',
  bytes: 'WHATSAPP_BRIDGE_BYTES=@WHATSAPP_BRIDGE_BYTES@',
} as const;
/** Pins an installer without a prebuilt bridge carries: pairing then builds the bridge from source. */
const HELPER_PLACEHOLDERS = { name: 'MACOS_HELPER_NAME=@MACOS_HELPER_NAME@', sha256: 'MACOS_HELPER_SHA256=@MACOS_HELPER_SHA256@', bytes: 'MACOS_HELPER_BYTES=@MACOS_HELPER_BYTES@', teamId: 'MACOS_HELPER_TEAM_ID=@MACOS_HELPER_TEAM_ID@' } as const;
const EXPECTED_HELPER_TEAM = 'ND2P3ZTQRD';
type HelperPins = { name: string; sha256: string; bytes: number; teamId: string };
const NO_HELPER: HelperPins = { name: 'none', sha256: 'none', bytes: 0, teamId: 'none' };
function assertHelperPins(p: HelperPins): void {
  if (!/^olympus-engine-helper-[0-9a-f]{16}\.zip$/.test(p.name) || !/^[0-9a-f]{64}$/.test(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes <= 0 || p.teamId !== EXPECTED_HELPER_TEAM) throw new Error('Invalid macOS helper pins.');
}
function readHelperPins(script: string): HelperPins | undefined {
  const get = (key: string) => new RegExp(`^MACOS_HELPER_${key}=(\\S+)$`, 'm').exec(script)?.[1];
  const name = get('NAME'), sha256 = get('SHA256'), bytes = get('BYTES'), teamId = get('TEAM_ID');
  if (!name || name === 'none' || !sha256 || !bytes || !teamId) return undefined;
  return { name, sha256, bytes: Number(bytes), teamId };
}
const NO_BRIDGE = { name: 'none', sha256: 'none', bytes: 0 } as const;
const BRIDGE_NAME_PATTERN = /^olympus-whatsapp-bridge-[0-9a-f]{16}$/;
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

/** Where the site serves a release's bridge for one platform. */
export function releaseBridgePath(version: string, name: string, platform: WhatsAppBridgePlatform = 'darwin-arm64'): string {
  return `${SITE_RELEASES}/${version}/${name}-${platform}`;
}

export function assertBridgePins(pins: WhatsAppBridgePins): void {
  if (!BRIDGE_NAME_PATTERN.test(pins.name)) throw new Error(`WhatsApp bridge name ${JSON.stringify(pins.name)} is not olympus-whatsapp-bridge-<fingerprint>.`);
  if (!/^[0-9a-f]{64}$/.test(pins.sha256)) throw new Error('WhatsApp bridge SHA-256 must be 64 lowercase hex characters.');
  if (!Number.isSafeInteger(pins.bytes) || pins.bytes <= 0) throw new Error('WhatsApp bridge size must be a positive byte count.');
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

/**
 * The template with its pin lines filled in; nothing else changes. Without
 * `bridge` the installer carries no prebuilt WhatsApp bridge (`none`).
 */
export function renderInstallScript(template: string, pins: ReleasePins, bridge?: WhatsAppBridgePins, helper?: HelperPins): string {
  assertReleasePins(pins);
  if (helper) assertHelperPins(helper);
  if (bridge) assertBridgePins(bridge);
  const bridgePins = bridge ?? NO_BRIDGE;
  let rendered = template;
  const fill = (line: string, value: string | number): void => {
    const lines = rendered.split('\n').filter((candidate) => candidate === line);
    if (lines.length !== 1) throw new Error(`${INSTALL_TEMPLATE} must contain the line ${line} exactly once.`);
    rendered = rendered.replace(`\n${line}\n`, `\n${line.split('=')[0]}=${value}\n`);
  };
  for (const [key, line] of Object.entries(PLACEHOLDERS) as Array<[keyof ReleasePins, string]>) fill(line, pins[key]);
  for (const [key, line] of Object.entries(BRIDGE_PLACEHOLDERS) as Array<[keyof WhatsAppBridgePins, string]>) fill(line, bridgePins[key]);
  for (const [key, line] of Object.entries(HELPER_PLACEHOLDERS) as Array<[keyof HelperPins, string]>) fill(line, (helper ?? NO_HELPER)[key]);
  if (/@(OLYMPUS|WHATSAPP|MACOS_HELPER)_/.test(rendered)) throw new Error(`${INSTALL_TEMPLATE} has a placeholder this script does not fill.`);
  return rendered;
}

/** The prebuilt-bridge pins a rendered installer carries; undefined for `none` or none at all. */
export function readInstallScriptBridgePins(script: string): WhatsAppBridgePins | undefined {
  const name = /^WHATSAPP_BRIDGE_NAME=(\S+)$/m.exec(script)?.[1];
  const sha256 = /^WHATSAPP_BRIDGE_SHA256=(\S+)$/m.exec(script)?.[1];
  const bytes = /^WHATSAPP_BRIDGE_BYTES=(\S+)$/m.exec(script)?.[1];
  if (!name || name === 'none' || !sha256 || !bytes || !/^[0-9]+$/.test(bytes)) return undefined;
  return { name, sha256, bytes: Number(bytes) };
}

/** Whether a file is a program for the platform: its executable header, not its name. */
function isBridgeProgram(data: Buffer, platform: WhatsAppBridgePlatform): boolean {
  // MH_MAGIC_64 then CPU_TYPE_ARM64, little-endian.
  if (platform === 'darwin-arm64') return data.length >= 8 && data.readUInt32LE(0) === 0xfeedfacf && data.readUInt32LE(4) === 0x0100000c;
  // ELF, 64-bit, little-endian, an executable or PIE (ET_EXEC/ET_DYN), EM_X86_64.
  return data.length >= 20 && data.readUInt32BE(0) === 0x7f454c46 && data[4] === 2 && data[5] === 1
    && [2, 3].includes(data.readUInt16LE(16)) && data.readUInt16LE(18) === 0x3e;
}

const BRIDGE_PLATFORM_LABEL: Record<WhatsAppBridgePlatform, string> = {
  'darwin-arm64': 'an Apple-silicon (arm64 Mach-O)',
  'linux-x64': 'a Linux x64 (x86-64 ELF)',
};

/**
 * Pins for a prebuilt bridge, once it is a program for `platform` whose name
 * is the fingerprint of the bridge source inside `artifact`: a bridge built
 * from other source is never published beside this tarball.
 */
export function bridgePinsFor(bridgePath: string, artifact: string, platform: WhatsAppBridgePlatform = 'darwin-arm64'): WhatsAppBridgePins {
  if (!existsSync(bridgePath) || !lstatSync(bridgePath).isFile()) throw new Error(`${bridgePath} is not a file.`);
  if (!isBridgeProgram(readFileSync(bridgePath), platform)) throw new Error(`${bridgePath} is not ${BRIDGE_PLATFORM_LABEL[platform]} program.`);
  const unpacked = mkdtempSync(join(tmpdir(), 'olympus-bridge-source-'));
  try {
    const result = spawnSync('tar', ['-xzf', artifact, '-C', unpacked, 'package/tools/whatsapp-bridge'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${artifact} has no package/tools/whatsapp-bridge: ${result.stderr.trim()}`);
    const name = whatsappBridgeFileName(join(unpacked, 'package', 'tools', 'whatsapp-bridge'));
    const given = basename(bridgePath).replace(new RegExp(`-${platform}$`), '');
    if (given !== name) throw new Error(`${basename(bridgePath)} was not built from this release's bridge source (expected ${name}-${platform}).`);
    return { name, ...fileDigest(bridgePath) };
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}

/**
 * Fill every release/runtime pin in the Linux template; pending pins may be rendered for tests.
 * Without `bridge` the installer carries no prebuilt WhatsApp bridge (`none`).
 */
export function renderLinuxInstallScript(template: string, releasePins: ReleasePins, runtimePins: LinuxRuntimePins, bridge?: WhatsAppBridgePins): string {
  assertReleasePins(releasePins);
  validateLinuxRuntimePins(runtimePins);
  if (bridge) assertBridgePins(bridge);
  const bridgePins = bridge ?? NO_BRIDGE;
  const values: Array<[string, string | number]> = [
    ...(Object.entries(LINUX_PLACEHOLDERS) as Array<[string, (release: ReleasePins, runtime: LinuxRuntimePins) => string | number]>)
      .map(([name, value]): [string, string | number] => [name, value(releasePins, runtimePins)]),
    ['WHATSAPP_BRIDGE_NAME', bridgePins.name],
    ['WHATSAPP_BRIDGE_SHA256', bridgePins.sha256],
    ['WHATSAPP_BRIDGE_BYTES', bridgePins.bytes],
  ];
  let rendered = template;
  for (const [name, value] of values) {
    const placeholder = `${name}=@${name}@`;
    const assignments = rendered.split('\n').filter((line) => line.startsWith(`${name}=`));
    if (assignments.length !== 1 || assignments[0] !== placeholder) {
      throw new Error(`${LINUX_INSTALL_TEMPLATE} must contain exactly one ${name}= assignment, and it must be ${placeholder}.`);
    }
    rendered = rendered.replace(placeholder, `${name}=${value}`);
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

/** On macOS verify the archive; elsewhere require the receipt from Mac verification. */
function verifyHelperArchive(path: string): void {
  {
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(readFileSync(`${path}.receipt.json`, 'utf8')); }
    catch { throw new Error('macOS helper receipt is missing or invalid.'); }
    const digest = fileDigest(path);
    if (!receipt || receipt.name !== basename(path) || receipt.sha256 !== digest.sha256 || receipt.bytes !== digest.bytes || receipt.team !== EXPECTED_HELPER_TEAM || receipt.bundleId !== 'ai.olympusplugin.engine-host') {
      throw new Error('macOS helper receipt does not match the archive.');
    }
    if (process.platform !== 'darwin') return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'olympus-helper-verify-'));
  try {
    const extracted = spawnSync('unzip', ['-q', path, '-d', dir], { encoding: 'utf8' });
    if (extracted.status !== 0) throw new Error('Could not unzip macOS helper.');
    const app = join(dir, 'Olympus Engine.app');
    const plist = join(app, 'Contents', 'Info.plist');
    if (!existsSync(plist) || !/<key>CFBundleIdentifier<\/key>\s*<string>ai\.olympusplugin\.engine-host<\/string>/.test(readFileSync(plist, 'utf8')) || !existsSync(join(app, 'Contents', '_CodeSignature', 'CodeResources'))) {
      throw new Error('macOS helper has an invalid bundle identifier or signature structure.');
    }
    if (process.platform === 'darwin') {
      const check = (command: string, args: string[]) => {
        const result = spawnSync(command, args, { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`macOS helper verification failed: ${command} ${result.stderr}`);
        return result.stdout + result.stderr;
      };
      check('/usr/bin/codesign', ['--verify', '--strict', '--deep', app]);
      const details = check('/usr/bin/codesign', ['-dvv', app]);
      if (!/^Identifier=ai\.olympusplugin\.engine-host$/m.test(details) || !/^TeamIdentifier=ND2P3ZTQRD$/m.test(details)) throw new Error('macOS helper signing identifier or team does not match.');
      if (!check('/usr/sbin/spctl', ['-a', '-t', 'exec', '-vv', app]).includes('source=Notarized Developer ID')) throw new Error('macOS helper is not notarized.');
      check('/usr/bin/xcrun', ['stapler', 'validate', app]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Copy a tarball into site/releases and write site/install.sh pinned to it. */
export function publishToSite(input: { root: string; artifact: string; bridge?: string; macosHelper?: string; macosHelperTeamId?: string }): ReleasePins & { tarball: string; installScript: string; bridge?: WhatsAppBridgePins } {
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
  const bridge = input.bridge ? bridgePinsFor(input.bridge, input.artifact) : undefined;
  if (input.macosHelperTeamId && input.macosHelperTeamId !== EXPECTED_HELPER_TEAM) throw new Error('The macOS helper team does not match the required team.');
  if (input.macosHelper) verifyHelperArchive(input.macosHelper);
  const helper = input.macosHelper ? { name: basename(input.macosHelper), ...fileDigest(input.macosHelper), teamId: EXPECTED_HELPER_TEAM } : undefined;
  if (helper) assertHelperPins(helper);
  const template = readFileSync(join(input.root, INSTALL_TEMPLATE), 'utf8');
  const script = renderInstallScript(template, pins, bridge, helper);
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
  if (bridge && input.bridge) {
    const served = join(input.root, releaseBridgePath(version, bridge.name));
    if (resolve(input.bridge) !== resolve(served)) copyFileSync(input.bridge, served);
    chmodSync(served, 0o644);
  }
  if (helper && input.macosHelper) {
    const served = join(dirname(tarball), helper.name);
    if (resolve(served) !== resolve(input.macosHelper)) copyFileSync(input.macosHelper, served);
    chmodSync(served, 0o644);
    const receipt = `${input.macosHelper}.receipt.json`;
    if (existsSync(receipt)) {
      if (resolve(receipt) !== resolve(`${served}.receipt.json`)) copyFileSync(receipt, `${served}.receipt.json`);
      chmodSync(`${served}.receipt.json`, 0o644);
    }
  }
  const installScript = join(input.root, SERVED_INSTALL_SCRIPT);
  writeFileSync(installScript, script, { mode: 0o644 });
  chmodSync(installScript, 0o644);
  const problems = checkSiteRelease(input.root);
  if (problems.length > 0) throw new Error(`The site release does not check out:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
  return { ...pins, tarball, installScript, ...(bridge ? { bridge } : {}) };
}

function linuxQualificationProblem(pins: LinuxRuntimePins): string | undefined {
  if (pins.bun.qualification !== 'qualified-omarchy') {
    return `${LINUX_RUNTIME_PINS} is ${pins.bun.qualification}; Linux publication requires qualified-omarchy.`;
  }
  return undefined;
}

/** Publish only the Linux installer and its shared immutable release asset. */
export function publishLinuxToSite(input: { root: string; artifact: string; bridge?: string }): ReleasePins & { tarball: string; installScript: string; bridge?: WhatsAppBridgePins } {
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
  const bridge = input.bridge ? bridgePinsFor(input.bridge, input.artifact, 'linux-x64') : undefined;
  const script = renderLinuxInstallScript(readFileSync(join(input.root, LINUX_INSTALL_TEMPLATE), 'utf8'), pins, runtime, bridge);
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
  if (bridge && input.bridge) {
    const served = join(input.root, releaseBridgePath(version, bridge.name, 'linux-x64'));
    if (resolve(input.bridge) !== resolve(served)) copyFileSync(input.bridge, served);
    chmodSync(served, 0o644);
  }
  writeFileSync(installScript, script, { mode: 0o644 });
  chmodSync(installScript, 0o644);
  const problems = checkLinuxSiteRelease(input.root);
  if (problems.length > 0) throw new Error(`The Linux site release does not check out:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
  return { ...pins, tarball, installScript, ...(bridge ? { bridge } : {}) };
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
  const bridge = readInstallScriptBridgePins(served);
  const helper = readHelperPins(served);
  try {
    const expected = renderInstallScript(readFileSync(join(root, INSTALL_TEMPLATE), 'utf8'), pins, bridge, helper);
    if (expected !== served) {
      problems.push(`${SERVED_INSTALL_SCRIPT} differs from ${INSTALL_TEMPLATE} rendered with its pins: run bun scripts/publish-release-to-site.ts again.`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (bridge) {
    const bridgePath = join(root, releaseBridgePath(pins.version, bridge.name));
    if (!existsSync(bridgePath)) problems.push(`${releaseBridgePath(pins.version, bridge.name)} is missing.`);
    else {
      const digest = fileDigest(bridgePath);
      if (digest.sha256 !== bridge.sha256 || digest.bytes !== bridge.bytes) {
        problems.push(`${releaseBridgePath(pins.version, bridge.name)} does not match the installer's WhatsApp bridge pins.`);
      }
    }
  }
  if (helper) {
    const path = join(root, SITE_RELEASES, pins.version, helper.name);
    if (!existsSync(path)) problems.push(`macOS helper ${helper.name} is missing.`);
    else { const digest = fileDigest(path); if (digest.sha256 !== helper.sha256 || digest.bytes !== helper.bytes) problems.push('macOS helper does not match installer pins.'); }
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
    problems.push(`${SERVED_LINUX_INSTALL_SCRIPT} is missing: run bun scripts/publish-release-to-site.ts --linux --artifact <artifact> --whatsapp-bridge <bridge>.`);
    return problems;
  }
  const served = readFileSync(installPath, 'utf8');
  const pins = readInstallScriptPins(served);
  if (!pins) {
    problems.push(`${SERVED_LINUX_INSTALL_SCRIPT} carries no release pins.`);
    return problems;
  }
  const bridge = readInstallScriptBridgePins(served);
  try {
    const expected = renderLinuxInstallScript(readFileSync(join(root, LINUX_INSTALL_TEMPLATE), 'utf8'), pins, runtime, bridge);
    if (expected !== served) problems.push(`${SERVED_LINUX_INSTALL_SCRIPT} differs from ${LINUX_INSTALL_TEMPLATE} rendered with its pins.`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (bridge) {
    const bridgePath = releaseBridgePath(pins.version, bridge.name, 'linux-x64');
    if (!existsSync(join(root, bridgePath))) problems.push(`${bridgePath} is missing.`);
    else {
      const digest = fileDigest(join(root, bridgePath));
      if (digest.sha256 !== bridge.sha256 || digest.bytes !== bridge.bytes) problems.push(`${bridgePath} does not match the Linux installer's WhatsApp bridge pins.`);
    }
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
export function prepareLinuxLocalBundle(input: { root: string; artifact: string; output: string; bridge?: string }): ReleasePins & { directory: string } {
  const version = sourceVersion(input.root);
  const packaged = tarballPackage(input.artifact);
  if (packaged.name !== 'olympus' || packaged.version !== version) throw new Error('Local tarball identity does not match the source package version.');
  const pins = { version, ...fileDigest(input.artifact) };
  const runtime = readLinuxRuntimePins(join(input.root, LINUX_RUNTIME_PINS));
  const bridge = input.bridge ? bridgePinsFor(input.bridge, input.artifact, 'linux-x64') : undefined;
  const script = renderLinuxInstallScript(readFileSync(join(input.root, LINUX_INSTALL_TEMPLATE), 'utf8'), pins, runtime, bridge);
  // Refuse an existing output rather than accidentally mixing two candidates.
  mkdirSync(input.output, { mode: 0o700 });
  const name = `olympus-${version}.tgz`;
  const bridgeName = bridge ? `${bridge.name}-linux-x64` : undefined;
  copyFileSync(input.artifact, join(input.output, name), constants.COPYFILE_EXCL);
  if (bridge && bridgeName && input.bridge) copyFileSync(input.bridge, join(input.output, bridgeName), constants.COPYFILE_EXCL);
  writeFileSync(join(input.output, 'install-linux.sh'), script, { mode: 0o700, flag: 'wx' });
  copyFileSync(join(input.root, SERVED_LINUX_UNINSTALL_SCRIPT), join(input.output, 'uninstall-linux.sh'), constants.COPYFILE_EXCL);
  writeFileSync(join(input.output, 'SHA256SUMS'), `${pins.sha256}  ${name}\n${bridge && bridgeName ? `${bridge.sha256}  ${bridgeName}\n` : ''}`, { flag: 'wx' });
  writeFileSync(join(input.output, 'README.txt'),
    `Local Linux x64 acceptance candidate; not host-qualified or published.\n`
    + `sha256sum -c SHA256SUMS\nsh ./install-linux.sh --tarball "$(pwd)/${name}"${bridgeName ? ` --whatsapp-bridge "$(pwd)/${bridgeName}"` : ''}\n`
    + `sh ./uninstall-linux.sh\nData is retained by default. See the Omarchy acceptance runbook for explicit purge and recovery.\n`, { flag: 'wx' });
  return { ...pins, directory: input.output };
}

/**
 * The Mac installer exactly as the site serves it (the template with the candidate's pins), the
 * candidate's tarball and the uninstaller, in a fresh folder, without touching site/. The release
 * check serves the two files from a stand-in for the site inside a throwaway machine and runs the
 * published command there, so the installer itself is never edited for a test.
 */
export function prepareMacLocalBundle(input: { root: string; artifact: string; output: string; bridge?: string }): ReleasePins & { directory: string } {
  const version = sourceVersion(input.root);
  const packaged = tarballPackage(input.artifact);
  if (packaged.name !== 'olympus' || packaged.version !== version) throw new Error('Local tarball identity does not match the source package version.');
  const pins = { version, ...fileDigest(input.artifact) };
  const bridge = input.bridge ? bridgePinsFor(input.bridge, input.artifact) : undefined;
  const script = renderInstallScript(readFileSync(join(input.root, INSTALL_TEMPLATE), 'utf8'), pins, bridge);
  // Refuse an existing output rather than accidentally mixing two candidates.
  mkdirSync(input.output, { mode: 0o700 });
  const name = `olympus-${version}.tgz`;
  copyFileSync(input.artifact, join(input.output, name), constants.COPYFILE_EXCL);
  if (bridge && input.bridge) copyFileSync(input.bridge, join(input.output, `${bridge.name}-darwin-arm64`), constants.COPYFILE_EXCL);
  writeFileSync(join(input.output, 'install.sh'), script, { mode: 0o644, flag: 'wx' });
  copyFileSync(join(input.root, SERVED_UNINSTALL_SCRIPT), join(input.output, 'uninstall.sh'), constants.COPYFILE_EXCL);
  writeFileSync(join(input.output, 'SHA256SUMS'), `${pins.sha256}  ${name}\n`, { flag: 'wx' });
  writeFileSync(join(input.output, 'README.txt'),
    `Local macOS candidate for the release check; not published.\n`
    + `install.sh is site/install.sh for this tarball, ${name} is what it downloads (checked against its pins).\n`, { flag: 'wx' });
  return { ...pins, directory: input.output };
}

function main(args: string[]): void {
  if (args[0] === '--mac-local' && args[1] === '--artifact' && args[2]
    && args[3] === '--output' && args[4] && (args.length === 5 || (args.length === 7 && args[5] === '--whatsapp-bridge' && args[6]))) {
    const result = prepareMacLocalBundle({ root: ROOT, artifact: resolve(args[2]), output: resolve(args[4]), ...(args[6] ? { bridge: resolve(args[6]) } : {}) });
    console.log(`Local macOS release-check bundle: ${result.directory}`);
    console.log(`SHA-256 ${result.sha256}; ${result.bytes} bytes. Not published.`);
    return;
  }
  if (args[0] === '--linux-local' && args[1] === '--artifact' && args[2]
    && args[3] === '--output' && args[4] && (args.length === 5 || (args.length === 7 && args[5] === '--whatsapp-bridge' && args[6]))) {
    const result = prepareLinuxLocalBundle({ root: ROOT, artifact: resolve(args[2]), output: resolve(args[4]), ...(args[6] ? { bridge: resolve(args[6]) } : {}) });
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
  if (args[0] === '--linux' && args[1] === '--artifact' && args[2]
    && (args.length === 4 && args[3] === '--no-whatsapp-bridge' || (args.length === 5 && args[3] === '--whatsapp-bridge' && args[4]))) {
    // The Linux release carries its prebuilt WhatsApp bridge; leaving it out is said out loud.
    const result = publishLinuxToSite({ root: ROOT, artifact: resolve(args[2]), ...(args[4] ? { bridge: resolve(args[4]) } : {}) });
    console.log(`Wrote ${result.tarball}`);
    console.log(`Wrote ${result.installScript}`);
    console.log(`Pinned Linux olympus ${result.version}: SHA-256 ${result.sha256}, ${result.bytes} bytes.`);
    console.log(result.bridge
      ? `Pinned the Linux WhatsApp bridge ${result.bridge.name}: SHA-256 ${result.bridge.sha256}, ${result.bridge.bytes} bytes.`
      : 'No prebuilt Linux WhatsApp bridge: pairing on this release needs Go and a C compiler.');
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
  // The Mac release carries its prebuilt WhatsApp bridge; leaving it out is said out loud.
  if (process.env.OLYMPUS_MACOS_HELPER_TEAM_ID && process.env.OLYMPUS_MACOS_HELPER_TEAM_ID !== EXPECTED_HELPER_TEAM) {
    console.error('The macOS helper team does not match the required team.');
    process.exit(2);
  }
  let macosHelper: string | undefined;
  const helperFlag = args.indexOf('--macos-helper');
  if (helperFlag >= 0 && args[helperFlag + 1]) { macosHelper = resolve(args[helperFlag + 1]!); args = [...args.slice(0, helperFlag), ...args.slice(helperFlag + 2)]; }
  const noHelper = args.includes('--no-macos-helper');
  args = args.filter((arg) => arg !== '--no-macos-helper');
  if ((!macosHelper && !noHelper) || (macosHelper && noHelper)) {
    console.error('Choose --macos-helper <zip> or --no-macos-helper.');
    process.exit(2);
  }
  let bridge: string | undefined;
  const bridgeFlag = args.indexOf('--whatsapp-bridge');
  if (bridgeFlag >= 0 && args[bridgeFlag + 1]) {
    bridge = resolve(args[bridgeFlag + 1]!);
    args = [...args.slice(0, bridgeFlag), ...args.slice(bridgeFlag + 2)];
  }
  const noBridge = args.includes('--no-whatsapp-bridge');
  args = args.filter((arg) => arg !== '--no-whatsapp-bridge');
  let artifact: string | undefined;
  if (args[0] === '--artifact' && args[1] && args.length === 2) artifact = resolve(args[1]);
  else if (args.length > 0 || (!bridge && !noBridge)) {
    console.error('Usage: bun scripts/publish-release-to-site.ts [--artifact <olympus-<version>.tgz>] (--whatsapp-bridge <olympus-whatsapp-bridge-<fingerprint>-darwin-arm64> | --no-whatsapp-bridge) | --check | --pin-bun <bun-darwin-aarch64.zip> | --linux --artifact <olympus-<version>.tgz> (--whatsapp-bridge <olympus-whatsapp-bridge-<fingerprint>-linux-x64> | --no-whatsapp-bridge) | --linux --check | --mac-local --artifact <olympus-<version>.tgz> --output <new dir> [--whatsapp-bridge <bridge>] | --linux-local --artifact <olympus-<version>.tgz> --output <new dir> [--whatsapp-bridge <bridge>]');
    process.exit(2);
  }
  if (!artifact) {
    const built = spawnSync('bun', [join(ROOT, 'scripts/release-artifact.ts')], { cwd: ROOT, stdio: 'inherit' });
    if (built.status !== 0) process.exit(built.status ?? 1);
    artifact = join(ROOT, 'release-artifacts', `olympus-${sourceVersion(ROOT)}.tgz`);
  }
  const result = publishToSite({ root: ROOT, artifact, ...(bridge ? { bridge } : {}), ...(macosHelper ? { macosHelper, macosHelperTeamId: process.env.OLYMPUS_MACOS_HELPER_TEAM_ID ?? '' } : {}) });
  console.log(`Wrote ${result.tarball}`);
  console.log(`Wrote ${result.installScript}`);
  console.log(`Pinned olympus ${result.version}: SHA-256 ${result.sha256}, ${result.bytes} bytes.`);
  console.log(result.bridge
    ? `Pinned the WhatsApp bridge ${result.bridge.name}: SHA-256 ${result.bridge.sha256}, ${result.bridge.bytes} bytes.`
    : 'No prebuilt WhatsApp bridge: pairing on this release needs Go and a C compiler.');
  console.log('Publish with: site/deploy/deploy.sh --dry-run, then site/deploy/deploy.sh');
}

if (import.meta.main) main(process.argv.slice(2));
