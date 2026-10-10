/**
 * Olympus-managed tools: the one-click install of Tor and zkapi-clientd for
 * anonymous answers (design docs/design/private-answers.md, "One-click
 * install"), and the lookup the zkAPI consult transport uses to find them.
 *
 * Every download is pinned here by version, URL, size and SHA-256. The
 * installer:
 *   - downloads into the tool's own folder under an owner-only tree, hashing as
 *     it writes, and refuses anything whose size or SHA-256 differs from the pin
 *     BEFORE a single entry is extracted;
 *   - checks the whole archive before writing anything: no absolute paths, no
 *     `..`, no hard links, no device or FIFO entries, and no symlink that
 *     resolves outside the install;
 *   - extracts into a private staging folder, clears macOS quarantine on those
 *     verified files only, on Apple silicon ad-hoc signs the Tor files that
 *     `/usr/bin/codesign -dv` reports unsigned (never anything already
 *     signed), asks each program for its version (a program the
 *     system will not run is not installed), writes a manifest, and only then
 *     renames the staging folder into `<tool>/<version>` in one step;
 *   - holds one install lease, so the dashboard and the CLI never install at
 *     the same time, and re-running is a no-op when the pinned build is there.
 *
 * It never configures anything: no wallet, no key, no setting. Olympus never
 * runs `zkapi-clientd config`; the only command it runs is `--version`.
 *
 * Discovery (`managedToolExecutable`) trusts nothing it did not check: the
 * manifest must name the pinned version and hash, and the executable's real
 * path must sit inside the version folder, with that file and every folder
 * from the Olympus folder down owned by this user and writable by no one else.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, sep } from 'node:path';
import { gunzip } from 'node:zlib';
import { FileLeaseBusyError, FileLeaseLostError, withFileLease, type FileLease } from './file-lease.ts';

// ---------------------------------------------------------------------------
// Pins

export type ManagedToolName = 'tor' | 'zkapi-clientd';
export type ManagedToolPlatform = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'linux-ia32';

export interface ManagedToolAsset {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Executable path inside the version folder: what discovery returns. */
  readonly executable: string;
  /** Files that must exist after extraction (beside the executable). */
  readonly required: readonly string[];
  /** Archive path prefixes left out (debug symbols). */
  readonly skip?: readonly string[];
  /** Archive path → install path, for files the bundle keeps at its root. */
  readonly rename?: Readonly<Record<string, string>>;
  /** A small launcher Olympus writes (Linux Tor needs its bundled libraries on LD_LIBRARY_PATH). */
  readonly launcher?: { readonly path: string; readonly target: string; readonly libraryDir: string };
  /**
   * Mach-O files Olympus ad-hoc signs after verification when, and only when,
   * `codesign -dv` reports them unsigned (Apple silicon runs no unsigned arm64
   * code; Homebrew does the same for relocated binaries). darwin-arm64 only.
   */
  readonly adhocSign?: readonly string[];
}

export interface ManagedToolPin {
  readonly tool: ManagedToolName;
  /** Plain name for people. */
  readonly label: string;
  readonly version: string;
  /** What `<executable> --version` prints first, for this pin. */
  readonly versionLine: RegExp;
  readonly assets: Readonly<Partial<Record<ManagedToolPlatform, ManagedToolAsset>>>;
}

const ZKAPI_RELEASE = 'https://github.com/ethereum/zkapi/releases/download/clientd-v0.1.6';
const ZKAPI_REQUIRED = [
  'bin/zkapi-clientd',
  'bin/zkapi-walletd',
  'share/zkapi-clientd/build-info.json',
  'share/zkapi-clientd/proof-setup/manifest.json',
  'share/zkapi-clientd/proof-setup/request.pk',
  'share/zkapi-clientd/proof-setup/request.vk',
  'share/zkapi-clientd/proof-setup/withdrawal.pk',
  'share/zkapi-clientd/proof-setup/withdrawal.vk',
];
// The bundle keeps both programs at its root; upstream's installer moves them
// to bin/ beside share/, which is where the daemon looks for its proof files.
const ZKAPI_RENAME = { 'zkapi-clientd': 'bin/zkapi-clientd', 'zkapi-walletd': 'bin/zkapi-walletd' } as const;

function zkapiAsset(name: string, sha256: string, bytes: number): ManagedToolAsset {
  return { url: `${ZKAPI_RELEASE}/${name}`, sha256, bytes, executable: 'bin/zkapi-clientd', required: ZKAPI_REQUIRED, rename: ZKAPI_RENAME };
}

const TOR_RELEASE = 'https://dist.torproject.org/torbrowser/15.0.24';

function torMacAsset(name: string, sha256: string, bytes: number, adhocSign?: readonly string[]): ManagedToolAsset {
  return { url: `${TOR_RELEASE}/${name}`, sha256, bytes, executable: 'tor/tor', required: ['tor/tor', 'tor/libevent-2.1.7.dylib'], ...(adhocSign ? { adhocSign } : {}) };
}

function torLinuxAsset(name: string, sha256: string, bytes: number): ManagedToolAsset {
  return {
    url: `${TOR_RELEASE}/${name}`,
    sha256,
    bytes,
    executable: 'bin/tor',
    required: ['tor/tor', 'tor/libevent-2.1.so.7', 'tor/libssl.so.3', 'tor/libcrypto.so.3'],
    skip: ['debug/'],
    launcher: { path: 'bin/tor', target: 'tor/tor', libraryDir: 'tor' },
  };
}

/**
 * The pinned builds. Verified 2026-10-07 (docs/design/private-answers.md):
 * zkapi-clientd hashes computed from the downloaded archives and matched to
 * the release's SHA256SUMS and GitHub's asset digests; Tor hashes computed and
 * matched to sha256sums-signed-build.txt, whose signature and each archive's
 * own .asc verified as good signatures by the Tor Browser Developers signing
 * key EF6E 286D DA85 EA2A 4BA7 DE68 4E2C 6E87 9329 8290 (subkey 022D A248 432D
 * 2A0E 0F54 E65E 316C 1FAC D62D 07D9). Tor publishes no Linux arm64 bundle.
 */
export const MANAGED_TOOL_PINS: Readonly<Record<ManagedToolName, ManagedToolPin>> = {
  tor: {
    tool: 'tor',
    label: 'Tor',
    version: '15.0.24',
    versionLine: /^Tor version \d+\.\d+\.\d+/,
    assets: {
      'darwin-arm64': torMacAsset('tor-expert-bundle-macos-aarch64-15.0.24.tar.gz', 'd47afd04b6c751129978390ad003d74ac8b88adfbb939350f0f89999e6570644', 18_724_201, ['tor/tor', 'tor/libevent-2.1.7.dylib']),
      'darwin-x64': torMacAsset('tor-expert-bundle-macos-x86_64-15.0.24.tar.gz', '8acb0b590f6be34084dcb6d84009ac0c61cc7c5261b7a19d2ab94845aa9bd5b6', 19_356_806),
      'linux-x64': torLinuxAsset('tor-expert-bundle-linux-x86_64-15.0.24.tar.gz', '8e012ec6815d7899cb64011582e2dade88e74119c6661068a2a3252de0ccd7f2', 32_348_376),
      'linux-ia32': torLinuxAsset('tor-expert-bundle-linux-i686-15.0.24.tar.gz', '7537fea3478d05b8af25d7f8199c031b281f7015c32bb4177bef71f8e5100d9b', 25_964_591),
    },
  },
  'zkapi-clientd': {
    tool: 'zkapi-clientd',
    label: 'zkAPI',
    version: '0.1.6',
    versionLine: /^zkapi-clientd 0\.1\.6(\s|$)/,
    assets: {
      'darwin-arm64': zkapiAsset('zkapi-clientd_0.1.6_darwin_arm64.tar.gz', '0e045245332fbe5d832d73f4ec1633bada2a5058032dd137b9e447f83bdc86c4', 22_904_346),
      'darwin-x64': zkapiAsset('zkapi-clientd_0.1.6_darwin_amd64.tar.gz', 'ac9bb3f0f64c3f9c5c271291f38065cb1b008b5d8b2eb5e998ea9b615fc54a12', 23_547_367),
      'linux-x64': zkapiAsset('zkapi-clientd_0.1.6_linux_amd64.tar.gz', '41f9df6c24fd1e1491bc21fcc5be89289525c01f5a850bd64326a85152bbff95', 23_826_995),
      'linux-arm64': zkapiAsset('zkapi-clientd_0.1.6_linux_arm64.tar.gz', '41549a752cdffdace74cdabd872ad71190d7509a9b307e54f5ee0e5f863b7cdf', 23_612_951),
    },
  },
};

/** Install order: Tor first (smaller, and the part people most often lack). */
export const MANAGED_TOOL_ORDER: readonly ManagedToolName[] = ['tor', 'zkapi-clientd'];

const MANIFEST_FILE = 'olympus-tool.json';
/** A bundle that inflates past this is refused (both pinned bundles are under 110 MB unpacked). */
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Where

export interface ManagedToolsHost {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  arch?: string;
  /** This user's id; defaults to process.getuid(). */
  uid?: number;
  /** Override the pins (tests serve fixture archives under fixture pins). */
  pins?: Readonly<Record<ManagedToolName, ManagedToolPin>>;
}

export function managedToolsPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ManagedToolPlatform | undefined {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `darwin-${arch}`;
  if (platform === 'linux' && (arch === 'arm64' || arch === 'x64' || arch === 'ia32')) return `linux-${arch}`;
  return undefined;
}

/**
 * The Olympus folder the tools live under: `~/Library/Application Support/Olympus`
 * on macOS, `$XDG_DATA_HOME/olympus` (default `~/.local/share/olympus`) on Linux.
 */
export function managedToolsBase(host: ManagedToolsHost = {}): string | undefined {
  const env = host.env ?? process.env;
  const platform = host.platform ?? process.platform;
  const home = env.HOME?.trim() || (host.env ? undefined : homedir());
  if (platform === 'darwin') return home && isAbsolute(home) ? join(home, 'Library', 'Application Support', 'Olympus') : undefined;
  if (platform === 'linux') {
    const xdg = env.XDG_DATA_HOME?.trim();
    if (xdg && isAbsolute(xdg)) return join(xdg, 'olympus');
    return home && isAbsolute(home) ? join(home, '.local', 'share', 'olympus') : undefined;
  }
  return undefined;
}

/** `<base>/tools`: one folder per tool, one folder per version inside it. */
export function managedToolsRoot(host: ManagedToolsHost = {}): string | undefined {
  const base = managedToolsBase(host);
  return base ? join(base, 'tools') : undefined;
}

// ---------------------------------------------------------------------------
// Discovery

interface ToolManifest {
  schema: 1;
  tool: ManagedToolName;
  version: string;
  platform: ManagedToolPlatform;
  asset: string;
  sha256: string;
  installedAt: string;
  /** Files Olympus ad-hoc signed after verification (darwin-arm64 Tor); absent when none. */
  adhocSigned?: string[];
}

function currentUid(host: ManagedToolsHost): number | undefined {
  return host.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
}

/** Owned by this user and writable by no one else (group or world). */
function privatelyOwned(path: string, uid: number | undefined, kind: 'dir' | 'file'): boolean {
  try {
    const stats = statSync(path);
    if (kind === 'dir' ? !stats.isDirectory() : !stats.isFile()) return false;
    if (uid !== undefined && stats.uid !== uid) return false;
    return (stats.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function within(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function readManifest(path: string, uid: number | undefined): ToolManifest | undefined {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || (uid !== undefined && stats.uid !== uid) || (stats.mode & 0o022) !== 0) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ToolManifest>;
    if (parsed.schema !== 1 || typeof parsed.tool !== 'string' || typeof parsed.version !== 'string' || typeof parsed.sha256 !== 'string') return undefined;
    return parsed as ToolManifest;
  } catch {
    return undefined;
  }
}

/**
 * The installed, pinned build of `tool` in the Olympus-managed folder, as a
 * real path, or undefined. Checked on every call (no cache): the manifest
 * names the pinned version, platform and hash; the executable's real path is
 * inside the version folder; it and every folder from the Olympus folder down
 * belong to this user and are writable by no one else.
 */
export function managedToolExecutable(tool: ManagedToolName, host: ManagedToolsHost = {}): string | undefined {
  const pin = (host.pins ?? MANAGED_TOOL_PINS)[tool];
  const platformKey = managedToolsPlatform(host.platform, host.arch);
  const asset = platformKey && pin ? pin.assets[platformKey] : undefined;
  const base = managedToolsBase(host);
  if (!pin || !asset || !base) return undefined;
  const uid = currentUid(host);
  const root = join(base, 'tools');
  const versionDir = join(root, tool, pin.version);
  for (const dir of [base, root, join(root, tool), versionDir]) {
    try {
      if (lstatSync(dir).isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
    if (!privatelyOwned(dir, uid, 'dir')) return undefined;
  }
  const manifest = readManifest(join(versionDir, MANIFEST_FILE), uid);
  if (!manifest || manifest.tool !== tool || manifest.version !== pin.version || manifest.platform !== platformKey || manifest.sha256 !== asset.sha256) return undefined;
  try {
    const realDir = realpathSync(versionDir);
    // Every file the program needs to run, not only the one Olympus starts:
    // each must resolve inside the version folder, and it and every folder
    // between there and it must be this user's alone. One missing or exposed
    // file reads as not installed, and the next install replaces the folder.
    for (const required of new Set([...asset.required, asset.executable])) {
      if (!trustedInside(realDir, join(versionDir, required), uid, versionDir)) return undefined;
    }
    const real = realpathSync(join(versionDir, asset.executable));
    accessSync(real, constants.X_OK);
    return real;
  } catch {
    return undefined;
  }
}

/** `path` resolves inside `realDir`; the file and each folder from `realDir` down to it are privately owned. */
function trustedInside(realDir: string, path: string, uid: number | undefined, versionDir?: string): boolean {
  // The path as written, first: every folder from the version folder down and
  // every link on the way (lstat, not followed) must be this user's or root's,
  // and no folder writable by others, or someone else could retarget a link.
  if (versionDir) {
    const parts = path.slice(versionDir.length + 1).split(sep);
    for (let index = 1; index <= parts.length; index += 1) {
      let stats;
      try {
        stats = lstatSync(join(versionDir, ...parts.slice(0, index)));
      } catch {
        return false;
      }
      if (uid !== undefined && stats.uid !== uid && stats.uid !== 0) return false;
      // A link's own mode means nothing on Linux (always 0777); its folder's mode guards it.
      if (!stats.isSymbolicLink() && (stats.mode & 0o022) !== 0) return false;
    }
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  if (!within(realDir, real) || !privatelyOwned(real, uid, 'file')) return false;
  for (let dir = dirname(real); dir !== realDir; dir = dirname(dir)) {
    if (!within(realDir, dir) || !privatelyOwned(dir, uid, 'dir')) return false;
  }
  return true;
}

export type ManagedToolSource = 'olympus' | 'system' | 'missing' | 'not_offered';

export interface ManagedToolState {
  readonly tool: ManagedToolName;
  readonly label: string;
  readonly version: string;
  /** Whether Olympus has a pinned download for this computer. */
  readonly offered: boolean;
  readonly installed: boolean;
  readonly executable?: string;
}

/** Each tool's managed install state; probes files only. */
export function managedToolsState(host: ManagedToolsHost = {}): ManagedToolState[] {
  const platformKey = managedToolsPlatform(host.platform, host.arch);
  return MANAGED_TOOL_ORDER.map((tool) => {
    const pin = (host.pins ?? MANAGED_TOOL_PINS)[tool];
    const executable = managedToolExecutable(tool, host);
    return {
      tool,
      label: pin.label,
      version: pin.version,
      offered: platformKey !== undefined && pin.assets[platformKey] !== undefined,
      installed: executable !== undefined,
      ...(executable ? { executable } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Install

export type ManagedToolsErrorCode =
  | 'unsupported_platform'
  | 'folder_unsafe'
  | 'busy'
  | 'download_failed'
  | 'size_mismatch'
  | 'hash_mismatch'
  | 'unsafe_archive'
  | 'archive_incomplete'
  | 'will_not_run'
  | 'signing_failed'
  | 'lease_lost'
  | 'install_failed';

export class ManagedToolsError extends Error {
  constructor(readonly code: ManagedToolsErrorCode, message: string, readonly tool?: ManagedToolName) {
    super(message);
  }
}

export type ManagedToolsPhase = 'downloading' | 'checking' | 'installing';

export interface ManagedToolsProgressEvent {
  readonly tool: ManagedToolName;
  readonly phase: ManagedToolsPhase;
  readonly receivedBytes?: number;
  readonly totalBytes?: number;
}

export interface ManagedToolResult {
  readonly tool: ManagedToolName;
  readonly version: string;
  readonly outcome: 'installed' | 'already_installed' | 'not_offered' | 'failed';
  readonly executable?: string;
  readonly code?: ManagedToolsErrorCode;
  readonly message?: string;
}

export interface ManagedToolsInstallResult {
  readonly ok: boolean;
  readonly root?: string;
  readonly tools: readonly ManagedToolResult[];
}

/** Runs `<executable> --version`; the seam tests replace so no binary runs. */
export type ManagedToolVersionCheck = (executable: string, options: { cwd: string; env: Record<string, string> }) => Promise<{ ok: true; stdout: string } | { ok: false; detail: string }>;

export interface ManagedToolsInstallOptions extends ManagedToolsHost {
  fetchImpl?: typeof fetch;
  onProgress?: (event: ManagedToolsProgressEvent) => void;
  versionCheck?: ManagedToolVersionCheck;
  /** Clears com.apple.quarantine on the verified staging folder (macOS). */
  clearQuarantine?: (dir: string) => Promise<void>;
  /** Runs a system command (codesign); the seam tests replace. */
  runCommand?: ManagedToolsCommandRunner;
  now?: () => Date;
  /** Which tools; default both. */
  tools?: readonly ManagedToolName[];
  signal?: AbortSignal;
}

export type ManagedToolsCommandRunner = (command: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;

export const defaultCommandRunner: ManagedToolsCommandRunner = (command, args) => new Promise((resolve) => {
  execFile(command, [...args], { timeout: 60_000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (!error) {
      resolve({ code: 0, stdout, stderr });
      return;
    }
    const failure = error as NodeJS.ErrnoException & { code?: number | string };
    // A spawn failure (ENOENT: no codesign) has a string code and no exit status.
    if (typeof failure.code === 'string') resolve({ code: null, stdout: stdout ?? '', stderr: stderr ?? '', error: failure.code });
    else resolve({ code: typeof failure.code === 'number' ? failure.code : 1, stdout: stdout ?? '', stderr: stderr ?? '' });
  });
});

const CODESIGN = '/usr/bin/codesign';

/**
 * Ad-hoc signs the asset's listed Mach-O files in the verified staging folder
 * when codesign reports them unsigned; anything already signed is left alone.
 * Returns the files signed. darwin-arm64 only; codesign only from /usr/bin.
 */
async function adhocSignUnsigned(staging: string, asset: ManagedToolAsset, platformKey: ManagedToolPlatform, run: ManagedToolsCommandRunner, label: string, tool: ManagedToolName): Promise<string[]> {
  if (platformKey !== 'darwin-arm64' || !asset.adhocSign?.length) return [];
  const realStaging = realpathSync(staging);
  const signed: string[] = [];
  for (const relative of asset.adhocSign) {
    const file = join(staging, relative);
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      throw new ManagedToolsError('archive_incomplete', `The ${label} download is missing ${relative}, so nothing was installed.`, tool);
    }
    if (!within(realStaging, real) || !lstatSync(file).isFile()) {
      throw new ManagedToolsError('unsafe_archive', `The ${label} download has an unexpected ${relative}, so nothing was installed.`, tool);
    }
    const inspect = await run(CODESIGN, ['-dv', real]);
    if (inspect.error) throw new ManagedToolsError('signing_failed', `Olympus could not find the macOS code-signing tool, so ${label} was not installed.`, tool);
    if (inspect.code === 0) continue; // already signed: never re-signed
    if (!/code object is not signed at all/.test(`${inspect.stderr}\n${inspect.stdout}`)) {
      throw new ManagedToolsError('signing_failed', `macOS could not read the signature of ${label}'s ${relative}, so it was not installed.`, tool);
    }
    const sign = await run(CODESIGN, ['--force', '--sign', '-', real]);
    if (sign.error || sign.code !== 0) {
      throw new ManagedToolsError('signing_failed', `macOS could not prepare ${label} to run on this Mac (signing ${relative} failed), so it was not installed.`, tool);
    }
    signed.push(relative);
  }
  return signed;
}

export const defaultVersionCheck: ManagedToolVersionCheck = (executable, options) => new Promise((resolve) => {
  execFile(executable, ['--version'], { cwd: options.cwd, env: options.env, timeout: VERSION_CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
    if (error) {
      const failure = error as NodeJS.ErrnoException & { signal?: string | null; killed?: boolean };
      const detail = failure.signal ? `stopped by ${failure.signal}` : failure.code !== undefined ? `exit ${String(failure.code)}` : failure.message;
      resolve({ ok: false, detail });
      return;
    }
    resolve({ ok: true, stdout });
  });
});

async function defaultClearQuarantine(dir: string): Promise<void> {
  await new Promise<void>((resolve) => {
    // Recursive over the staging folder alone: it holds only files this
    // install extracted after the archive matched its pinned SHA-256. A file
    // without the attribute makes xattr report an error; that is expected.
    execFile('/usr/bin/xattr', ['-r', '-d', 'com.apple.quarantine', dir], { timeout: 30_000 }, () => resolve());
  });
}

/**
 * Creates `path` 0700 if missing; otherwise it must be ours, a real folder, and
 * writable by no one else. `repairWriteBits` drops group/other write from a
 * folder that is already ours instead of refusing it: only for the Olympus
 * folder itself, which a service under umask 002 used to create 0775
 * (olympus-test, 2026-10-10). Everything inside it is still checked as-is.
 */
function ensureOwnedDirectory(path: string, uid: number | undefined, label: string, options: { repairWriteBits?: boolean } = {}): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ManagedToolsError('folder_unsafe', `Olympus could not create ${label}.`);
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new ManagedToolsError('folder_unsafe', `Olympus could not read ${label}.`);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new ManagedToolsError('folder_unsafe', `${label} is not a plain folder.`);
  if (uid !== undefined && stats.uid !== uid) throw new ManagedToolsError('folder_unsafe', `${label} belongs to another user.`);
  if ((stats.mode & 0o022) !== 0 && options.repairWriteBits === true) {
    try {
      chmodSync(path, stats.mode & 0o755);
      stats = lstatSync(path);
    } catch {
      throw new ManagedToolsError('folder_unsafe', `${label} can be changed by other users, and Olympus could not fix that.`);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      throw new ManagedToolsError('folder_unsafe', `${label} is not a plain folder.`);
    }
  }
  if ((stats.mode & 0o022) !== 0) throw new ManagedToolsError('folder_unsafe', `${label} can be changed by other users.`);
}

/**
 * Installs the pinned builds, one at a time, under one lease. Each tool ends
 * installed, already installed, not offered for this computer, or failed with
 * a code; a failure never leaves a partial install where discovery would look.
 */
export async function installManagedTools(options: ManagedToolsInstallOptions = {}): Promise<ManagedToolsInstallResult> {
  const pins = options.pins ?? MANAGED_TOOL_PINS;
  const tools = options.tools ?? MANAGED_TOOL_ORDER;
  const platformKey = managedToolsPlatform(options.platform, options.arch);
  const base = managedToolsBase(options);
  if (!platformKey || !base) {
    return {
      ok: false,
      tools: tools.map((tool) => ({ tool, version: pins[tool].version, outcome: 'failed', code: 'unsupported_platform', message: 'Olympus has no downloads for this kind of computer.' })),
    };
  }
  const uid = currentUid(options);
  const root = join(base, 'tools');
  try {
    // The folder above Olympus's own (Application Support, ~/.local/share) is the system's: created if missing, never re-permissioned.
    mkdirSync(dirname(base), { recursive: true, mode: 0o700 });
    ensureOwnedDirectory(base, uid, 'The Olympus folder', { repairWriteBits: true });
    ensureOwnedDirectory(root, uid, 'The Olympus tools folder');
  } catch (error) {
    const failure = error instanceof ManagedToolsError ? error : new ManagedToolsError('folder_unsafe', 'Olympus could not prepare its tools folder.');
    return { ok: false, root, tools: tools.map((tool) => ({ tool, version: pins[tool].version, outcome: 'failed', code: failure.code, message: failure.message })) };
  }
  try {
    return await withFileLease(join(root, 'install'), async (lease) => {
      const results: ManagedToolResult[] = [];
      for (const tool of tools) {
        try {
          results.push(await installOne(tool, pins[tool], platformKey, root, uid, options, lease));
        } catch (error) {
          if (!(error instanceof FileLeaseLostError)) throw error;
          // Another install took the lease over: stop at once, touch nothing more.
          for (const rest of tools.slice(results.length)) {
            results.push({ tool: rest, version: pins[rest].version, outcome: 'failed', code: 'lease_lost', message: 'Another install took over, so this one stopped without changing anything more.' });
          }
          break;
        }
      }
      return { ok: results.every((result) => result.outcome !== 'failed'), root, tools: results };
    }, { acquireTimeoutMs: 500, staleAfterMs: 60_000 });
  } catch (error) {
    if (error instanceof FileLeaseBusyError) {
      return { ok: false, root, tools: tools.map((tool) => ({ tool, version: pins[tool].version, outcome: 'failed', code: 'busy', message: 'Another install is already running.' })) };
    }
    throw error;
  }
}

async function installOne(
  tool: ManagedToolName,
  pin: ManagedToolPin,
  platformKey: ManagedToolPlatform,
  root: string,
  uid: number | undefined,
  options: ManagedToolsInstallOptions,
  lease: FileLease,
): Promise<ManagedToolResult> {
  // Every change to the shared tools folder runs under lease.commit (which
  // proves ownership first); each step also checks the lease is still ours.
  const commit = <T>(write: () => Promise<T>): Promise<T> => lease.commit(write);
  const asset = pin.assets[platformKey];
  if (!asset) {
    return { tool, version: pin.version, outcome: 'not_offered', message: `${pin.label} publishes no build for this computer.` };
  }
  const host = { ...options, ...(uid !== undefined ? { uid } : {}) };
  const existing = managedToolExecutable(tool, host);
  if (existing) return { tool, version: pin.version, outcome: 'already_installed', executable: existing };
  const toolDir = join(root, tool);
  const versionDir = join(toolDir, pin.version);
  const id = randomUUID();
  const download = join(toolDir, `.download-${id}`);
  const staging = join(toolDir, `.staging-${id}`);
  try {
    await commit(async () => {
      ensureOwnedDirectory(toolDir, uid, `The ${pin.label} folder`);
      // Leftovers of an interrupted install (the lease is ours, so nobody else is using them).
      for (const entry of readdirSync(toolDir)) {
        if (/^\.(download|staging|old)-/.test(entry)) rmSync(join(toolDir, entry), { recursive: true, force: true });
      }
    });
    options.onProgress?.({ tool, phase: 'downloading', receivedBytes: 0, totalBytes: asset.bytes });
    const sha256 = await downloadTo(download, asset, options, (receivedBytes) => options.onProgress?.({ tool, phase: 'downloading', receivedBytes, totalBytes: asset.bytes }), tool, pin.label);
    options.onProgress?.({ tool, phase: 'checking' });
    if (sha256 !== asset.sha256) {
      throw new ManagedToolsError('hash_mismatch', `The ${pin.label} download did not match its pinned fingerprint, so nothing was installed.`, tool);
    }
    options.onProgress?.({ tool, phase: 'installing' });
    await lease.assertOwned();
    mkdirSync(staging, { mode: 0o700 });
    await extractVerifiedArchive(download, staging, asset, tool);
    rmSync(download, { force: true });
    for (const required of asset.required) {
      if (!privatelyOwned(join(staging, required), uid, 'file')) {
        throw new ManagedToolsError('archive_incomplete', `The ${pin.label} download is missing ${required}, so nothing was installed.`, tool);
      }
    }
    if ((options.platform ?? process.platform) === 'darwin') await (options.clearQuarantine ?? defaultClearQuarantine)(staging);
    const adhocSigned = await adhocSignUnsigned(staging, asset, platformKey, options.runCommand ?? defaultCommandRunner, pin.label, tool);
    const check = await (options.versionCheck ?? defaultVersionCheck)(join(staging, asset.executable), {
      cwd: staging,
      env: { PATH: '/usr/bin:/bin', ...(options.env?.HOME ? { HOME: options.env.HOME } : process.env.HOME ? { HOME: process.env.HOME } : {}) },
    });
    if (!check.ok || !pin.versionLine.test(check.stdout.trim())) {
      const detail = check.ok ? `it reported "${check.stdout.trim().split('\n')[0]?.slice(0, 80) ?? ''}"` : check.detail;
      throw new ManagedToolsError('will_not_run', `${pin.label} was downloaded and its fingerprint matched, but this computer would not run it (${detail}), so it was not installed.`, tool);
    }
    const manifest: ToolManifest = {
      schema: 1,
      tool,
      version: pin.version,
      platform: platformKey,
      asset: asset.url.slice(asset.url.lastIndexOf('/') + 1),
      sha256: asset.sha256,
      installedAt: (options.now ?? (() => new Date()))().toISOString(),
      ...(adhocSigned.length > 0 ? { adhocSigned } : {}),
    };
    writeFileSync(join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    // Publish: one rename. Whatever stood at the version folder failed
    // discovery above, so it is moved aside first and removed after.
    await commit(async () => {
      let old: string | undefined;
      try {
        lstatSync(versionDir);
        old = join(toolDir, `.old-${id}`);
        renameSync(versionDir, old);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      renameSync(staging, versionDir);
      if (old) rmSync(old, { recursive: true, force: true });
    });
    const executable = managedToolExecutable(tool, host);
    if (!executable) throw new ManagedToolsError('install_failed', `${pin.label} was installed but could not be found afterwards.`, tool);
    return { tool, version: pin.version, outcome: 'installed', executable };
  } catch (error) {
    // Our own uniquely named scratch files: safe to remove without the lease
    // (no concurrent attempt can share the id), so a lost lease still leaves
    // nothing behind. The lease itself gates only the shared, enumerable
    // state: the leftover sweep above and the version-folder rename below.
    rmSync(download, { force: true });
    rmSync(staging, { recursive: true, force: true });
    if (error instanceof FileLeaseLostError) throw error;
    const failure = error instanceof ManagedToolsError
      ? error
      : new ManagedToolsError('install_failed', `${pin.label} could not be installed: ${(error as Error).message}`, tool);
    return { tool, version: pin.version, outcome: 'failed', code: failure.code, message: failure.message };
  }
}

async function downloadTo(
  path: string,
  asset: ManagedToolAsset,
  options: ManagedToolsInstallOptions,
  onBytes: (received: number) => void,
  tool: ManagedToolName,
  label: string,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(asset.url, { signal, redirect: 'follow' });
  } catch {
    throw new ManagedToolsError('download_failed', `${label} could not be downloaded. Check the connection and try again.`, tool);
  }
  if (!response.ok || !response.body) {
    throw new ManagedToolsError('download_failed', `${label} could not be downloaded (HTTP ${response.status}). Try again later.`, tool);
  }
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > 0 && declared !== asset.bytes) {
    await response.body.cancel().catch(() => undefined);
    throw new ManagedToolsError('size_mismatch', `The ${label} download is not the pinned size, so nothing was installed.`, tool);
  }
  const hash = createHash('sha256');
  const file = await open(path, 'wx', 0o600);
  let received = 0;
  let lastReport = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const chunk = await reader.read().catch(() => {
        throw new ManagedToolsError('download_failed', `The ${label} download stopped part way. Try again.`, tool);
      });
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > asset.bytes) {
        await reader.cancel().catch(() => undefined);
        throw new ManagedToolsError('size_mismatch', `The ${label} download is larger than the pinned size, so nothing was installed.`, tool);
      }
      hash.update(chunk.value);
      await file.write(chunk.value);
      if (received - lastReport >= 1024 * 1024) {
        lastReport = received;
        onBytes(received);
      }
    }
  } finally {
    await file.close();
  }
  onBytes(received);
  if (received !== asset.bytes) {
    throw new ManagedToolsError('size_mismatch', `The ${label} download is not the pinned size, so nothing was installed.`, tool);
  }
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// The archive: parsed whole and checked before a single file is written

interface ArchiveEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  data?: Buffer;
  linkTarget?: string;
}

function octal(field: Buffer): number {
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new ManagedToolsError('unsafe_archive', 'The archive has a malformed header.');
  return Number.parseInt(text, 8);
}

function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('latin1'), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) throw new ManagedToolsError('unsafe_archive', 'The archive has a malformed extended header.');
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return out;
}

/** Parses a ustar/GNU/pax archive into entries; refuses links, devices and FIFOs. */
export function parseTarArchive(tar: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stored = octal(header.subarray(148, 156));
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    if (sum !== stored) throw new ManagedToolsError('unsafe_archive', 'The archive has a header with a bad checksum.');
    const typeflag = String.fromCharCode(header[156]!);
    const size = octal(header.subarray(124, 136));
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new ManagedToolsError('unsafe_archive', 'The archive is truncated.');
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (typeflag === 'x') {
      pax = parsePax(data);
      continue;
    }
    if (typeflag === 'g') continue;
    if (typeflag === 'L') {
      longName = cString(data);
      continue;
    }
    if (typeflag === 'K') {
      longLink = cString(data);
      continue;
    }
    const magic = header.subarray(257, 263).toString('latin1');
    // POSIX ustar keeps a name prefix; GNU ("ustar  ") uses those bytes for other fields.
    const prefix = magic === 'ustar\0' ? cString(header.subarray(345, 500)) : '';
    const baseName = cString(header.subarray(0, 100));
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    const link = pax.linkpath ?? longLink ?? cString(header.subarray(157, 257));
    const mode = octal(header.subarray(100, 108));
    pax = {};
    longName = undefined;
    longLink = undefined;
    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      entries.push({ path: name, type: 'file', mode, data: Buffer.from(data) });
    } else if (typeflag === '5') {
      entries.push({ path: name, type: 'dir', mode });
    } else if (typeflag === '2') {
      entries.push({ path: name, type: 'symlink', mode, linkTarget: link });
    } else if (typeflag === '1') {
      throw new ManagedToolsError('unsafe_archive', `The archive has a hard link (${name}).`);
    } else {
      throw new ManagedToolsError('unsafe_archive', `The archive has a special file (${name}).`);
    }
  }
  return entries;
}

/** A relative, `..`-free, normalized archive path, or a refusal. */
function safeRelativePath(raw: string): string {
  if (raw.includes('\0') || raw.includes('\\')) throw new ManagedToolsError('unsafe_archive', `The archive has an unsafe path (${raw}).`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new ManagedToolsError('unsafe_archive', `The archive has an absolute path (${raw}).`);
  const trimmed = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '.') return '';
  if (trimmed.split('/').some((part) => part === '..')) throw new ManagedToolsError('unsafe_archive', `The archive has a path that leaves its folder (${raw}).`);
  const normal = posix.normalize(trimmed);
  if (normal.startsWith('../') || normal === '..' || posix.isAbsolute(normal)) throw new ManagedToolsError('unsafe_archive', `The archive has a path that leaves its folder (${raw}).`);
  return normal;
}

async function extractVerifiedArchive(archivePath: string, staging: string, asset: ManagedToolAsset, tool: ManagedToolName): Promise<void> {
  const compressed = readFileSync(archivePath);
  let tar: Buffer;
  try {
    tar = await new Promise<Buffer>((resolve, reject) => gunzip(compressed, { maxOutputLength: MAX_UNPACKED_BYTES }, (error, out) => (error ? reject(error) : resolve(out))));
  } catch {
    throw new ManagedToolsError('unsafe_archive', 'The archive could not be unpacked.', tool);
  }
  let entries: ArchiveEntry[];
  try {
    entries = parseTarArchive(tar);
  } catch (error) {
    if (error instanceof ManagedToolsError) throw new ManagedToolsError(error.code, error.message, tool);
    throw error;
  }
  // Pass 1: every path and link checked; nothing written yet.
  const planned: Array<ArchiveEntry & { target: string }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const relative = safeRelativePath(entry.path);
    if (relative === '') continue;
    if (asset.skip?.some((prefix) => relative === prefix.replace(/\/$/, '') || relative.startsWith(prefix))) continue;
    const target = asset.rename?.[relative] ?? relative;
    if (seen.has(target) && entry.type !== 'dir') throw new ManagedToolsError('unsafe_archive', `The archive names ${target} twice.`, tool);
    seen.add(target);
    if (entry.type === 'symlink') {
      const link = entry.linkTarget ?? '';
      if (link === '' || link.includes('\0') || posix.isAbsolute(link)) throw new ManagedToolsError('unsafe_archive', `The archive has a link that leaves its folder (${entry.path}).`, tool);
      const resolved = posix.normalize(posix.join(posix.dirname(target), link));
      if (resolved === '..' || resolved.startsWith('../')) throw new ManagedToolsError('unsafe_archive', `The archive has a link that leaves its folder (${entry.path}).`, tool);
    }
    planned.push({ ...entry, target });
  }
  for (const pathName of [...seen]) {
    // A path below a symlink would be written through it.
    const parts = pathName.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (planned.some((entry) => entry.type === 'symlink' && entry.target === parent)) {
        throw new ManagedToolsError('unsafe_archive', `The archive writes through a link (${pathName}).`, tool);
      }
    }
  }
  // Pass 2: folders and files (owner-only modes), then links last.
  const mkdirs = (relative: string): void => {
    mkdirSync(join(staging, relative), { recursive: true, mode: 0o700 });
  };
  for (const entry of planned) {
    if (entry.type === 'dir') mkdirs(entry.target);
  }
  for (const entry of planned) {
    if (entry.type !== 'file') continue;
    mkdirs(posix.dirname(entry.target));
    const destination = join(staging, entry.target);
    writeFileSync(destination, entry.data ?? Buffer.alloc(0), { flag: 'wx', mode: entry.mode & 0o100 ? 0o700 : 0o600 });
    chmodSync(destination, entry.mode & 0o100 ? 0o700 : 0o600);
  }
  for (const entry of planned) {
    if (entry.type !== 'symlink') continue;
    mkdirs(posix.dirname(entry.target));
    symlinkSync(entry.linkTarget!, join(staging, entry.target));
  }
  // Links through links can leave the folder where each one alone does not:
  // every link must resolve, for real, inside the staging folder.
  const realStaging = realpathSync(staging);
  for (const entry of planned) {
    if (entry.type !== 'symlink') continue;
    let real: string;
    try {
      real = realpathSync(join(staging, entry.target));
    } catch {
      throw new ManagedToolsError('unsafe_archive', `The archive has a link that leads nowhere (${entry.path}).`, tool);
    }
    if (!within(realStaging, real)) throw new ManagedToolsError('unsafe_archive', `The archive has a link that leaves its folder (${entry.path}).`, tool);
  }
  if (asset.launcher) {
    mkdirs(posix.dirname(asset.launcher.path));
    const launcher = [
      '#!/bin/sh',
      '# Written by Olympus: runs the bundled Tor with its own libraries.',
      '# No external command: the folder comes from $0 by parameter expansion.',
      'case "$0" in',
      '  */*) here="${0%/*}/.." ;;',
      '  *) echo "olympus tor launcher: run it by its path (with a /), not a bare PATH lookup" >&2; exit 127 ;;',
      'esac',
      `LD_LIBRARY_PATH="$here/${asset.launcher.libraryDir}" exec "$here/${asset.launcher.target}" "$@"`,
      '',
    ].join('\n');
    writeFileSync(join(staging, asset.launcher.path), launcher, { flag: 'wx', mode: 0o700 });
    chmodSync(join(staging, asset.launcher.path), 0o700);
  }
  for (const entry of planned) {
    if (entry.type === 'dir') chmodSync(join(staging, entry.target), 0o700);
  }
}

// ---------------------------------------------------------------------------
// One background install for the dashboard

export type ManagedToolsJobState =
  | { readonly state: 'idle' }
  | { readonly state: 'running'; readonly tool: ManagedToolName; readonly phase: ManagedToolsPhase; readonly receivedBytes?: number; readonly totalBytes?: number; readonly startedAt: string }
  | { readonly state: 'done'; readonly at: string; readonly result: ManagedToolsInstallResult }
  | { readonly state: 'failed'; readonly at: string; readonly tool?: ManagedToolName; readonly code: ManagedToolsErrorCode; readonly message: string; readonly result?: ManagedToolsInstallResult };

export interface ManagedToolsJob {
  /** Starts an install in the background; 'running' when one is already going here. */
  start(): 'started' | 'running';
  progress(): ManagedToolsJobState;
  /** Resolves when the current install finishes (tests). */
  settled(): Promise<void>;
}

export function createManagedToolsJob(options: ManagedToolsInstallOptions = {}): ManagedToolsJob {
  const now = options.now ?? (() => new Date());
  let state: ManagedToolsJobState = { state: 'idle' };
  let current: Promise<void> = Promise.resolve();
  return {
    start() {
      if (state.state === 'running') return 'running';
      const startedAt = now().toISOString();
      state = { state: 'running', tool: (options.tools ?? MANAGED_TOOL_ORDER)[0]!, phase: 'downloading', startedAt };
      current = installManagedTools({
        ...options,
        onProgress: (event) => {
          state = { state: 'running', tool: event.tool, phase: event.phase, ...(event.receivedBytes !== undefined ? { receivedBytes: event.receivedBytes } : {}), ...(event.totalBytes !== undefined ? { totalBytes: event.totalBytes } : {}), startedAt };
          options.onProgress?.(event);
        },
      }).then((result) => {
        const failed = result.tools.find((tool) => tool.outcome === 'failed');
        state = failed
          ? { state: 'failed', at: now().toISOString(), tool: failed.tool, code: failed.code ?? 'install_failed', message: failed.message ?? 'The install did not finish.', result }
          : { state: 'done', at: now().toISOString(), result };
      }, (error: unknown) => {
        state = { state: 'failed', at: now().toISOString(), code: 'install_failed', message: `The install did not finish: ${(error as Error).message}` };
      });
      return 'started';
    },
    progress: () => state,
    settled: () => current,
  };
}
