import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
