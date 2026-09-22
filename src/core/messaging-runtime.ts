import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function telegramPythonExecutable(options: {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  pythonExecutable?: string;
} = {}): string | undefined {
  if (options.pythonExecutable) return options.pythonExecutable;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const isolated = join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'olympus', 'telegram-python', 'bin', 'python');
  return existsSync(isolated) ? isolated : Bun.which('python3') ?? undefined;
}

export const TELEGRAM_DEPENDENCY_HINT = 'Use a private virtual environment: python3 -m venv ~/.cache/olympus/telegram-python, then ~/.cache/olympus/telegram-python/bin/python -m pip install "Telethon==1.45.0". Re-run olympus connect telegram --pair.';
