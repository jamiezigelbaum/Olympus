import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDirectoryTreeSync, ensurePrivateRootDirectorySync } from './atomic-file.ts';

/** The private virtual environment Telegram's helpers run in: Olympus makes it on first pairing. */
export function telegramPythonVenvDir(options: { homeDir?: string; env?: Record<string, string | undefined> } = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  return join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'olympus', 'telegram-python');
}

export function telegramPythonExecutable(options: {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  pythonExecutable?: string;
} = {}): string | undefined {
  if (options.pythonExecutable) return options.pythonExecutable;
  const isolated = join(telegramPythonVenvDir(options), 'bin', 'python');
  if (existsSync(isolated)) return isolated;
  if (typeof Bun !== 'undefined') return Bun.which('python3') ?? undefined;
  const resolved = spawnSync('which', ['python3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return resolved.status === 0 ? resolved.stdout.trim() || undefined : undefined;
}

/** Select the pairing interpreter without launching the macOS Command Line Tools stub. */
export function defaultTelegramPython(platform: 'darwin' | 'linux' | 'other'): string | undefined {
  const python = telegramPythonExecutable();
  if (platform === 'darwin' && python === '/usr/bin/python3' && spawnSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' }).status !== 0) return undefined;
  return python;
}

/** The one Telethon the helpers are written against, installed into the private environment. */
export const TELEGRAM_TELETHON_VERSION = '1.45.0';
export const TELEGRAM_TELETHON_REQUIREMENT = `Telethon==${TELEGRAM_TELETHON_VERSION}`;

/**
 * Telethon and everything it needs, pinned by version and SHA-256 (#1067): pip refuses any file whose hash is
 * not listed. The build file holds the setuptools that builds pyaes (published only as source), installed first so
 * no unchecked build tool is fetched. Both ship in the package beside the Telegram helpers.
 */
export const TELEGRAM_REQUIREMENTS_FILE = 'scripts/telegram-requirements.txt';
export const TELEGRAM_BUILD_REQUIREMENTS_FILE = 'scripts/telegram-build-requirements.txt';

/** The package folder that holds the requirements files, from source modules and the flattened dist bundles alike. */
export function telegramRequirementsRoot(moduleUrl: string = import.meta.url, exists: (path: string) => boolean = existsSync): string | undefined {
  let directory = dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 6; depth += 1) {
    if (exists(join(directory, TELEGRAM_REQUIREMENTS_FILE))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/** The pip commands that fill a fresh private environment, every file hash-checked and nothing resolved beyond the lists. */
export function telegramInstallCommands(input: { venvDir: string; packageRoot: string }): string[][] {
  const python = join(input.venvDir, 'bin', 'python');
  const pip = [python, '-m', 'pip', 'install', '--quiet', '--require-hashes', '--no-deps'];
  return [
    [...pip, '-r', join(input.packageRoot, TELEGRAM_BUILD_REQUIREMENTS_FILE)],
    [...pip, '--no-build-isolation', '-r', join(input.packageRoot, TELEGRAM_REQUIREMENTS_FILE)],
  ];
}

/** The manual steps, naming the same pinned files Olympus installs from. */
export function telegramDependencyHint(packageRoot: string | undefined = telegramRequirementsRoot()): string {
  const venv = '~/.cache/olympus/telegram-python';
  const root = packageRoot ?? '<Olympus package>';
  const [build, telethon] = telegramInstallCommands({ venvDir: venv, packageRoot: root })
    .map((argv) => argv.filter((arg) => arg !== '--quiet').map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' '));
  return `Use a private virtual environment: python3 -m venv ${venv}, then ${build}, then ${telethon}. Re-run olympus connect telegram --pair.`;
}

export const TELEGRAM_DEPENDENCY_HINT = telegramDependencyHint();

/** pip's own words when a downloaded file's hash is not one the requirements file lists. */
const PIP_HASH_MISMATCH = /DO NOT MATCH THE HASHES|hashes are required in --require-hashes mode/i;

export function telegramDependencyRefusedMessage(packageRoot: string): string {
  return `Olympus refused to install Telethon for Telegram: a downloaded package did not match the SHA-256 pinned in ${join(packageRoot, TELEGRAM_REQUIREMENTS_FILE)}, so it may have been tampered with or substituted on the way. Nothing was installed. Check any pip mirror or proxy this computer uses, then re-run olympus connect telegram --pair; if it happens again, report it to the Olympus maintainers.`;
}

export interface PipRunResult { code: number | 'timeout'; stderr: string }

export interface TelegramPythonSeams {
  pythonHasTelethon?: (python: string) => Promise<boolean>;
  provisionTelegramPython?: (input: { python3: string; venvDir: string }) => Promise<boolean>;
}

const installing = new Map<string, Promise<boolean>>();

/**
 * The Python Telegram's helpers run with, ready to import Telethon: a configured one as it is, the private
 * environment when it imports Telethon, a system Python that has Telethon. Otherwise the private environment is made, the
 * way WhatsApp's bridge is built: without it pairing dead-ended on the hint, and capture started a Python that
 * exited at once with nothing recorded (a cleaned cache, test-omarchy 2026-10-29). Pairing and capture share
 * one install of a folder at a time.
 */
export async function readyTelegramPython(options: {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  pythonExecutable?: string;
  onInstall?: (venvDir: string) => void;
} & TelegramPythonSeams = {}): Promise<string> {
  if (options.pythonExecutable) return options.pythonExecutable;
  const venvDir = telegramPythonVenvDir(options);
  const isolated = join(venvDir, 'bin', 'python');
  const hasTelethon = options.pythonHasTelethon ?? pythonImportsTelethon;
  // An install in flight owns the folder: its bin/python exists before pip has finished, so only the
  // install's own result says the private Python is ready (pairing while capture rebuilds it, Codex on #635).
  // Two processes can still both install; the second install reuses the venv and pip settles it.
  if (!installing.has(venvDir) && existsSync(isolated) && await hasTelethon(isolated)) return isolated;
  const system = Bun.which('python3') ?? undefined;
  if (!installing.has(venvDir) && system && await hasTelethon(system)) return system;
  let install = installing.get(venvDir);
  if (!install) {
    if (!system) throw new Error(`Python 3 is required for Telegram. ${TELEGRAM_DEPENDENCY_HINT}`);
    options.onInstall?.(venvDir);
    install = (options.provisionTelegramPython ?? provisionTelegramPython)({ python3: system, venvDir }).finally(() => installing.delete(venvDir));
    installing.set(venvDir, install);
  }
  if (!await install || !existsSync(isolated)) throw new Error(`Olympus could not install Telethon for Telegram. ${TELEGRAM_DEPENDENCY_HINT}`);
  return isolated;
}

async function pythonImportsTelethon(python: string): Promise<boolean> {
  const child = Bun.spawn([python, '-c', 'import telethon'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  return await child.exited === 0;
}

/** A fresh private venv with the hash-pinned Telethon. A half-made one is removed, so the next try starts clean. */
export async function provisionTelegramPython(
  input: { python3: string; venvDir: string },
  seams: { run?: (argv: string[]) => Promise<PipRunResult>; packageRoot?: string } = {},
): Promise<boolean> {
  const packageRoot = seams.packageRoot ?? telegramRequirementsRoot();
  if (!packageRoot) throw new Error(`Olympus could not find its pinned Telethon list (${TELEGRAM_REQUIREMENTS_FILE}); reinstall Olympus, then re-run olympus connect telegram --pair.`);
  const run = seams.run ?? runPip;
  const cacheHome = dirname(dirname(input.venvDir));
  ensurePrivateRootDirectorySync(cacheHome);
  ensurePrivateDirectoryTreeSync(cacheHome, dirname(input.venvDir));
  const python = join(input.venvDir, 'bin', 'python');
  const steps = [[input.python3, '-m', 'venv', input.venvDir], ...telegramInstallCommands({ venvDir: input.venvDir, packageRoot }), [python, '-c', 'import telethon']];
  for (const argv of steps) {
    const result = await run(argv);
    if (result.code === 0) continue;
    rmSync(input.venvDir, { recursive: true, force: true });
    if (PIP_HASH_MISMATCH.test(result.stderr)) throw new Error(telegramDependencyRefusedMessage(packageRoot));
    return false;
  }
  return true;
}

async function runPip(argv: string[]): Promise<PipRunResult> {
  const child = Bun.spawn(argv, { env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' }, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  const stderr = new Response(child.stderr).text().catch(() => '');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    child.exited,
    new Promise<'timeout'>((resolve) => { timeout = setTimeout(() => resolve('timeout'), 5 * 60 * 1000); }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (result === 'timeout') child.kill('SIGKILL');
  return { code: result, stderr: result === 'timeout' ? '' : await stderr };
}
