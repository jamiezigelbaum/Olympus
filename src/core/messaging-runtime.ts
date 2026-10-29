import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
  return existsSync(isolated) ? isolated : Bun.which('python3') ?? undefined;
}

/** The one Telethon the helpers are written against, installed into the private environment. */
export const TELEGRAM_TELETHON_REQUIREMENT = 'Telethon==1.45.0';

export const TELEGRAM_DEPENDENCY_HINT = `Use a private virtual environment: python3 -m venv ~/.cache/olympus/telegram-python, then ~/.cache/olympus/telegram-python/bin/python -m pip install "${TELEGRAM_TELETHON_REQUIREMENT}". Re-run olympus connect telegram --pair.`;

export interface TelegramPythonSeams {
  pythonHasTelethon?: (python: string) => Promise<boolean>;
  provisionTelegramPython?: (input: { python3: string; venvDir: string }) => Promise<boolean>;
}

const installing = new Map<string, Promise<boolean>>();

/**
 * The Python Telegram's helpers run with, ready to import Telethon: a configured one as it is, the private
 * environment when it exists, a system Python that has Telethon. Otherwise the private environment is made, the
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
  const python = telegramPythonExecutable(options);
  if (!python) throw new Error(`Python 3 is required for Telegram. ${TELEGRAM_DEPENDENCY_HINT}`);
  const venvDir = telegramPythonVenvDir(options);
  const isolated = join(venvDir, 'bin', 'python');
  if (options.pythonExecutable || python === isolated) return python;
  if (await (options.pythonHasTelethon ?? pythonImportsTelethon)(python)) return python;
  let install = installing.get(venvDir);
  if (!install) {
    options.onInstall?.(venvDir);
    install = (options.provisionTelegramPython ?? provisionTelegramPython)({ python3: python, venvDir }).finally(() => installing.delete(venvDir));
    installing.set(venvDir, install);
  }
  if (!await install || !existsSync(isolated)) throw new Error(`Olympus could not install Telethon for Telegram. ${TELEGRAM_DEPENDENCY_HINT}`);
  return isolated;
}

async function pythonImportsTelethon(python: string): Promise<boolean> {
  const child = Bun.spawn([python, '-c', 'import telethon'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  return await child.exited === 0;
}

/** A fresh private venv with the pinned Telethon. A half-made one is removed, so the next try starts clean. */
async function provisionTelegramPython(input: { python3: string; venvDir: string }): Promise<boolean> {
  const run = async (argv: string[]): Promise<boolean> => {
    const child = Bun.spawn(argv, { env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      child.exited,
      new Promise<'timeout'>((resolve) => { timeout = setTimeout(() => resolve('timeout'), 5 * 60 * 1000); }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (result === 'timeout') child.kill('SIGKILL');
    return result === 0;
  };
  const cacheHome = dirname(dirname(input.venvDir));
  ensurePrivateRootDirectorySync(cacheHome);
  ensurePrivateDirectoryTreeSync(cacheHome, dirname(input.venvDir));
  const python = join(input.venvDir, 'bin', 'python');
  const ok = await run([input.python3, '-m', 'venv', input.venvDir])
    && await run([python, '-m', 'pip', 'install', '--quiet', TELEGRAM_TELETHON_REQUIREMENT])
    && await run([python, '-c', 'import telethon']);
  if (!ok) rmSync(input.venvDir, { recursive: true, force: true });
  return ok;
}
