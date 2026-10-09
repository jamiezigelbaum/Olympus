/**
 * The `olympus://` link handler on this computer (owner decision, 2026-10-09:
 * "do this on your computer" with no Terminal step).
 *
 * The handler is a thin door: the operating system hands it a link, it hands
 * the link to `olympus open` (cli.ts runOpenCommand), and that command reads
 * it against a closed list (open-targets.ts) and opens the local dashboard
 * there through the same one-time opening link `olympus dashboard` mints.
 * Nothing here interprets the link. docs/design/open-on-computer.md holds the threat
 * model.
 *
 * - macOS: a small AppleScript applet, `Olympus.app`, in Olympus's own
 *   Application Support folder, built on the Mac by the system's own
 *   osacompile, given `CFBundleURLTypes` for `olympus`, re-signed ad hoc
 *   (the Info.plist edit breaks osacompile's seal) and registered with
 *   LaunchServices. Built on this Mac, it carries no quarantine flag, so
 *   Gatekeeper does not assess it; a Developer ID signature and notarization
 *   would only matter if it were downloaded prebuilt.
 * - Linux: a hidden `.desktop` entry with `MimeType=x-scheme-handler/olympus`
 *   made the default with `xdg-mime`.
 *
 * Both run Olympus as it is installed: an absolute Bun and the package's
 * dist/cli.js, the same pair the engine's LaunchAgent runs, and the same way:
 * from the package's own folder with `--no-env-file`. A browser can start the
 * handler from any folder, and Bun would otherwise read that folder's `.env`
 * and `bunfig.toml` (whose `preload` runs code).
 *
 * Neither is ever written as root, or into a home folder the user running it
 * does not own: a root-owned handler or applications folder would break the
 * user's own desktop.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { OLYMPUS_URL_SCHEME, OPEN_URL_MAX_LENGTH } from './open-targets.ts';
import { olympusPackageRoot } from './package-root.ts';

export const OPEN_HANDLER_BUNDLE_ID = 'ai.olympusplugin.open';
export const OPEN_HANDLER_DESKTOP_ID = `${OPEN_HANDLER_BUNDLE_ID}.desktop`;
export const OPEN_HANDLER_MIME_TYPE = `x-scheme-handler/${OLYMPUS_URL_SCHEME}`;
/** The line that marks a file as this module's own; uninstall removes nothing without it. */
export const OPEN_HANDLER_MARK = 'Written by olympus open-handler install';
export const LSREGISTER_PATH = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export interface OpenHandlerExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type OpenHandlerExec = (command: string, args: string[]) => OpenHandlerExecResult;

/** What the handler runs: absolute paths to Bun and the package's dist/cli.js. */
export interface OpenHandlerProgram {
  runtimePath: string;
  entryPath: string;
  /** The folder it runs in; the package root (two folders above dist/cli.js) when absent. */
  workingDirectory?: string;
}

export interface OpenHandlerOptions {
  platform?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  exec?: OpenHandlerExec;
  program?: OpenHandlerProgram;
  /** The effective user id; process.getuid() when absent. */
  uid?: number;
}

export interface OpenHandlerResult {
  ok: boolean;
  platform: string;
  /** installed / removed: changed now; present / absent: status, or nothing to do; unsupported: not macOS or Linux. */
  action: 'installed' | 'removed' | 'present' | 'absent' | 'unsupported' | 'failed';
  path?: string;
  /** Linux: whether xdg-mime accepted the default. macOS: whether LaunchServices registered the app. */
  registered?: boolean;
  detail?: string;
}

export interface OpenHandlerPaths {
  /** macOS: the applet bundle. Linux: the .desktop entry. */
  handlerPath: string;
  /** Linux only: the per-user default-application list xdg-mime writes. */
  mimeappsPath?: string;
}

export function openHandlerPaths(platform: string, homeDir: string, env: Record<string, string | undefined> = {}): OpenHandlerPaths {
  if (platform === 'darwin') {
    return { handlerPath: join(homeDir, 'Library', 'Application Support', 'Olympus', 'Olympus.app') };
  }
  const dataHome = absoluteOr(env.XDG_DATA_HOME, join(homeDir, '.local', 'share'));
  const configHome = absoluteOr(env.XDG_CONFIG_HOME, join(homeDir, '.config'));
  return {
    handlerPath: join(dataHome, 'applications', OPEN_HANDLER_DESKTOP_ID),
    mimeappsPath: join(configHome, 'mimeapps.list'),
  };
}

/** The applet's source. The link reaches the shell only as `quoted form of`, and only `olympus open` reads it. */
export function renderMacOpenHandlerScript(program: OpenHandlerProgram): string {
  assertProgram(program);
  const workDir = programWorkingDirectory(program);
  return [
    `-- ${OPEN_HANDLER_MARK}. It hands an ${OLYMPUS_URL_SCHEME}:// link to`,
    '-- `olympus open`, which opens the Olympus dashboard and changes nothing.',
    'on open location theURL',
    '\tmy handOff(theURL as text)',
    'end open location',
    '',
    'on run',
    `\tmy handOff("${OLYMPUS_URL_SCHEME}://open/dashboard")`,
    'end run',
    '',
    'on handOff(theURL)',
    `\tif (length of theURL) > ${OPEN_URL_MAX_LENGTH} then return`,
    `\tset runtimePath to ${appleScriptString(program.runtimePath)}`,
    `\tset cliPath to ${appleScriptString(program.entryPath)}`,
    `\tset workDir to ${appleScriptString(workDir)}`,
    '\ttry',
    '\t\tdo shell script "cd " & quoted form of workDir & " && " & quoted form of runtimePath & " --no-env-file " & quoted form of cliPath & " open " & quoted form of theURL & " >/dev/null 2>&1"',
    '\tend try',
    'end handOff',
    '',
  ].join('\n');
}

/** The Linux entry: hidden from menus, `%u` the only thing the desktop passes. */
export function renderLinuxDesktopEntry(program: OpenHandlerProgram): string {
  assertProgram(program);
  const workDir = programWorkingDirectory(program);
  for (const path of [program.runtimePath, program.entryPath, workDir]) {
    // Desktop-entry quoting has its own escapes; a path that needs one is refused, not escaped.
    if (/["`$\\%]/.test(path)) throw new Error(`The path ${path} cannot be written into a desktop entry.`);
  }
  return [
    '[Desktop Entry]',
    `# ${OPEN_HANDLER_MARK}; olympus open-handler uninstall removes it.`,
    'Type=Application',
    'Name=Olympus',
    'Comment=Opens the Olympus dashboard on this computer',
    `Exec="${program.runtimePath}" --no-env-file "${program.entryPath}" open %u`,
    `Path=${workDir}`,
    'Terminal=false',
    'NoDisplay=true',
    `MimeType=${OPEN_HANDLER_MIME_TYPE};`,
    '',
  ].join('\n');
}

export function installOpenHandler(options: OpenHandlerOptions = {}): OpenHandlerResult {
  const platform = options.platform ?? osPlatform();
  try {
    const refused = refuseForeignUser(platform, options);
    if (refused) return refused;
    if (platform === 'darwin') return installMac(options);
    if (platform === 'linux') return installLinux(options);
    return { ok: true, platform, action: 'unsupported', detail: 'olympus:// links are handled on macOS and Linux only.' };
  } catch (error) {
    return { ok: false, platform, action: 'failed', detail: truncatedDetail(error instanceof Error ? error.message : String(error)) };
  }
}

export function uninstallOpenHandler(options: OpenHandlerOptions = {}): OpenHandlerResult {
  const platform = options.platform ?? osPlatform();
  try {
    const refused = refuseForeignUser(platform, options);
    if (refused) return refused;
    if (platform === 'darwin') return uninstallMac(options);
    if (platform === 'linux') return uninstallLinux(options);
    return { ok: true, platform, action: 'unsupported' };
  } catch (error) {
    return { ok: false, platform, action: 'failed', detail: truncatedDetail(error instanceof Error ? error.message : String(error)) };
  }
}

export function openHandlerStatus(options: OpenHandlerOptions = {}): OpenHandlerResult {
  const platform = options.platform ?? osPlatform();
  if (platform !== 'darwin' && platform !== 'linux') return { ok: true, platform, action: 'unsupported' };
  const { handlerPath } = openHandlerPaths(platform, home(options), options.env ?? process.env);
  return { ok: true, platform, action: ownedHandler(platform, handlerPath) ? 'present' : 'absent', path: handlerPath };
}

// ---------------------------------------------------------------------------
// macOS

function installMac(options: OpenHandlerOptions): OpenHandlerResult {
  const exec = options.exec ?? defaultExec;
  const program = options.program ?? defaultProgram();
  const { handlerPath } = openHandlerPaths('darwin', home(options));
  if (existsSync(handlerPath) && !ownedHandler('darwin', handlerPath)) {
    return { ok: false, platform: 'darwin', action: 'failed', path: handlerPath, detail: `${handlerPath} is not the Olympus link handler, so it was left alone.` };
  }
  const script = renderMacOpenHandlerScript(program);
  const support = dirname(handlerPath);
  mkdirSync(support, { recursive: true, mode: 0o700 });
  // osacompile makes an applet only for a name ending in .app.
  const staging = join(support, '.Olympus-next.app');
  const scriptPath = join(support, '.open-handler.applescript');
  rmSync(staging, { recursive: true, force: true });
  writeFileSync(scriptPath, script, { mode: 0o600 });
  try {
    must(exec('/usr/bin/osacompile', ['-o', staging, scriptPath]), 'build the link handler');
  } finally {
    rmSync(scriptPath, { force: true });
  }
  const plist = join(staging, 'Contents', 'Info.plist');
  must(exec('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', OPEN_HANDLER_BUNDLE_ID, plist]), 'name the link handler');
  must(exec('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', 'Olympus', plist]), 'name the link handler');
  // No Dock icon: the applet runs for a moment and quits.
  must(exec('/usr/bin/plutil', ['-replace', 'LSUIElement', '-bool', 'YES', plist]), 'hide the link handler from the Dock');
  must(exec('/usr/bin/plutil', ['-replace', 'CFBundleURLTypes', '-json',
    JSON.stringify([{ CFBundleURLName: OPEN_HANDLER_BUNDLE_ID, CFBundleURLSchemes: [OLYMPUS_URL_SCHEME] }]), plist]), 'claim olympus:// links');
  // The plist edit invalidates osacompile's ad-hoc seal; seal it again.
  must(exec('/usr/bin/codesign', ['--force', '--sign', '-', staging]), 'sign the link handler');
  if (existsSync(handlerPath)) {
    exec(LSREGISTER_PATH, ['-u', handlerPath]);
    rmSync(handlerPath, { recursive: true, force: true });
  }
  renameSync(staging, handlerPath);
  const registered = exec(LSREGISTER_PATH, ['-f', handlerPath]).status === 0;
  return {
    ok: registered,
    platform: 'darwin',
    action: 'installed',
    path: handlerPath,
    registered,
    ...(registered ? {} : { detail: 'LaunchServices did not register the link handler; olympus:// links may not open until it does.' }),
  };
}

function uninstallMac(options: OpenHandlerOptions): OpenHandlerResult {
  const exec = options.exec ?? defaultExec;
  const { handlerPath } = openHandlerPaths('darwin', home(options));
  const staging = join(dirname(handlerPath), '.Olympus-next.app');
  rmSync(staging, { recursive: true, force: true });
  if (!existsSync(handlerPath)) return { ok: true, platform: 'darwin', action: 'absent', path: handlerPath };
  if (!ownedHandler('darwin', handlerPath)) {
    return { ok: false, platform: 'darwin', action: 'failed', path: handlerPath, detail: `${handlerPath} is not the Olympus link handler, so it was left alone.` };
  }
  exec(LSREGISTER_PATH, ['-u', handlerPath]);
  rmSync(handlerPath, { recursive: true, force: true });
  return { ok: true, platform: 'darwin', action: 'removed', path: handlerPath };
}

// ---------------------------------------------------------------------------
// Linux

function installLinux(options: OpenHandlerOptions): OpenHandlerResult {
  const exec = options.exec ?? defaultExec;
  const program = options.program ?? defaultProgram();
  const { handlerPath } = openHandlerPaths('linux', home(options), options.env ?? process.env);
  const entry = renderLinuxDesktopEntry(program);
  if (existsSync(handlerPath) && !ownedHandler('linux', handlerPath)) {
    return { ok: false, platform: 'linux', action: 'failed', path: handlerPath, detail: `${handlerPath} was not written by Olympus, so it was left alone.` };
  }
  mkdirSync(dirname(handlerPath), { recursive: true, mode: 0o700 });
  writeAtomic(handlerPath, entry, 0o644);
  const registered = exec('xdg-mime', ['default', OPEN_HANDLER_DESKTOP_ID, OPEN_HANDLER_MIME_TYPE]).status === 0;
  exec('update-desktop-database', [dirname(handlerPath)]);
  return {
    ok: registered,
    platform: 'linux',
    action: 'installed',
    path: handlerPath,
    registered,
    ...(registered ? {} : { detail: 'xdg-mime could not make Olympus the handler for olympus:// links (is xdg-utils installed?).' }),
  };
}

function uninstallLinux(options: OpenHandlerOptions): OpenHandlerResult {
  const exec = options.exec ?? defaultExec;
  const { handlerPath, mimeappsPath } = openHandlerPaths('linux', home(options), options.env ?? process.env);
  if (mimeappsPath) forgetLinuxDefault(mimeappsPath);
  if (!existsSync(handlerPath)) return { ok: true, platform: 'linux', action: 'absent', path: handlerPath };
  if (!ownedHandler('linux', handlerPath)) {
    return { ok: false, platform: 'linux', action: 'failed', path: handlerPath, detail: `${handlerPath} was not written by Olympus, so it was left alone.` };
  }
  rmSync(handlerPath, { force: true });
  exec('update-desktop-database', [dirname(handlerPath)]);
  return { ok: true, platform: 'linux', action: 'removed', path: handlerPath };
}

/**
 * Take this handler out of `mimeapps.list`: every `x-scheme-handler/olympus=`
 * value loses `ai.olympusplugin.open.desktop`, and a line left empty goes.
 * Every other line stays byte for byte. A list that is not a regular file is
 * left alone.
 */
export function forgetLinuxDefault(mimeappsPath: string): boolean {
  if (!existsSync(mimeappsPath)) return false;
  const stat = lstatSync(mimeappsPath);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const text = readFileSync(mimeappsPath, 'utf8');
  let changed = false;
  const lines = text.split('\n').flatMap((line) => {
    const match = /^(\s*x-scheme-handler\/olympus\s*=\s*)(.*)$/.exec(line);
    if (!match) return [line];
    const kept = match[2]!.split(';').map((id) => id.trim()).filter((id) => id !== '' && id !== OPEN_HANDLER_DESKTOP_ID);
    if (kept.length === match[2]!.split(';').map((id) => id.trim()).filter((id) => id !== '').length) return [line];
    changed = true;
    return kept.length === 0 ? [] : [`${match[1]}${kept.join(';')};`];
  });
  if (!changed) return false;
  writeAtomic(mimeappsPath, lines.join('\n'), stat.mode & 0o777);
  return true;
}

// ---------------------------------------------------------------------------

/** The handler on disk is this module's own: the applet's bundle id, or the entry's mark. */
function ownedHandler(platform: string, handlerPath: string): boolean {
  try {
    if (platform === 'darwin') {
      const plist = join(handlerPath, 'Contents', 'Info.plist');
      return lstatSync(handlerPath).isDirectory() && readFileSync(plist, 'utf8').includes(OPEN_HANDLER_BUNDLE_ID);
    }
    const stat = lstatSync(handlerPath);
    return stat.isFile() && !stat.isSymbolicLink() && readFileSync(handlerPath, 'utf8').includes(OPEN_HANDLER_MARK);
  } catch {
    return false;
  }
}

function defaultProgram(): OpenHandlerProgram {
  const root = olympusPackageRoot();
  return { runtimePath: process.execPath, entryPath: join(root, 'dist', 'cli.js'), workingDirectory: root };
}

function programWorkingDirectory(program: OpenHandlerProgram): string {
  return program.workingDirectory ?? dirname(dirname(program.entryPath));
}

/**
 * Root, or a home folder that belongs to someone else (sudo keeps HOME on
 * macOS), would leave root-owned files in the user's own folders. Status
 * only reads, so it is never refused.
 */
function refuseForeignUser(platform: string, options: OpenHandlerOptions): OpenHandlerResult | undefined {
  if (platform !== 'darwin' && platform !== 'linux') return undefined;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) return undefined;
  if (uid === 0) {
    return { ok: false, platform, action: 'failed', detail: 'The link handler is per user; run this as yourself, not as root.' };
  }
  const homeDir = home(options);
  let owner: number | undefined;
  try {
    owner = statSync(homeDir).uid;
  } catch {
    owner = undefined;
  }
  if (owner !== undefined && owner !== uid) {
    return { ok: false, platform, action: 'failed', detail: `${homeDir} belongs to another user; run this as that user.` };
  }
  return undefined;
}

function assertProgram(program: OpenHandlerProgram): void {
  for (const path of [program.runtimePath, program.entryPath, programWorkingDirectory(program)]) {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('The link handler needs absolute paths to Bun and the Olympus CLI.');
  }
}

/** An AppleScript string literal: backslash and double quote escaped; control characters were refused already. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function home(options: OpenHandlerOptions): string {
  const value = options.homeDir ?? homedir();
  if (!isAbsolute(value)) throw new Error('The home folder must be an absolute path.');
  return value;
}

function absoluteOr(value: string | undefined, fallback: string): string {
  return value && isAbsolute(value) ? value : fallback;
}

function writeAtomic(path: string, text: string, mode: number): void {
  const next = `${path}.olympus-next`;
  writeFileSync(next, text, { mode });
  renameSync(next, path);
}

function must(result: OpenHandlerExecResult, what: string): void {
  if (result.status === 0) return;
  const detail = `${result.stderr || result.stdout}`.trim().split(/\r?\n/)[0] ?? '';
  throw new Error(`Could not ${what}${detail ? `: ${truncatedDetail(detail)}` : '.'}`);
}

function truncatedDetail(text: string): string {
  return text.slice(0, 300);
}

function defaultExec(command: string, args: string[]): OpenHandlerExecResult {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? `${command}: ${result.error.message}` : ''),
  };
}
