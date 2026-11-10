import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  provisionTelegramPython,
  readyTelegramPython,
  TELEGRAM_BUILD_REQUIREMENTS_FILE,
  TELEGRAM_DEPENDENCY_HINT,
  TELEGRAM_REQUIREMENTS_FILE,
  TELEGRAM_TELETHON_REQUIREMENT,
  TELEGRAM_TELETHON_VERSION,
  telegramDependencyHint,
  telegramInstallCommands,
  telegramRequirementsRoot,
  type PipRunResult,
} from '../src/core/messaging-runtime.ts';
import { V0_4_PUBLIC_PACKAGE_FILES } from '../src/core/public-surface.ts';

const ROOT = join(import.meta.dir, '..');

/** Each requirement as pip reads it: name, exact version, and the hashes on its continuation lines. */
function requirements(path: string): Map<string, { version: string; hashes: string[] }> {
  const text = readFileSync(join(ROOT, path), 'utf8').replace(/\\\n/g, ' ');
  const entries = new Map<string, { version: string; hashes: string[] }>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_.-]+)==([^\s;]+)\s+(.*)$/.exec(line);
    if (!match) throw new Error(`Not an exact, hashed pin: ${line}`);
    const hashes = [...match[3]!.matchAll(/--hash=sha256:([0-9a-f]+)/g)].map((hash) => hash[1]!);
    expect(match[3]!.replace(/--hash=sha256:[0-9a-f]{64}/g, '').trim()).toBe('');
    entries.set(match[1]!.toLowerCase(), { version: match[2]!, hashes });
  }
  return entries;
}

describe('Telegram installs Telethon only from hash-pinned lists (#1067)', () => {
  test('the Telethon version in code is the one the requirements file pins', () => {
    expect(TELEGRAM_TELETHON_REQUIREMENT).toBe(`Telethon==${TELEGRAM_TELETHON_VERSION}`);
    expect(requirements(TELEGRAM_REQUIREMENTS_FILE).get('telethon')?.version).toBe(TELEGRAM_TELETHON_VERSION);
  });

  test('Telethon and each dependency it needs are pinned exactly, with a SHA-256 for every file', () => {
    const pinned = requirements(TELEGRAM_REQUIREMENTS_FILE);
    // Telethon needs pyaes and rsa; rsa needs pyasn1. --no-deps means anything missing here fails the import check.
    expect([...pinned.keys()].sort()).toEqual(['pyaes', 'pyasn1', 'rsa', 'telethon']);
    for (const [, entry] of pinned) {
      expect(entry.hashes.length).toBeGreaterThan(0);
      for (const hash of entry.hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const build = requirements(TELEGRAM_BUILD_REQUIREMENTS_FILE);
    expect([...build.keys()]).toEqual(['setuptools']);
    expect(build.get('setuptools')!.hashes.length).toBeGreaterThan(0);
  });

  test('both lists ship in the public package beside the Telegram helpers', () => {
    expect(V0_4_PUBLIC_PACKAGE_FILES).toContain(TELEGRAM_REQUIREMENTS_FILE);
    expect(V0_4_PUBLIC_PACKAGE_FILES).toContain(TELEGRAM_BUILD_REQUIREMENTS_FILE);
    expect(telegramRequirementsRoot()).toBe(ROOT);
    // The flattened bundles sit one folder below the package root.
    expect(telegramRequirementsRoot(pathToFileURL(join(ROOT, 'dist', 'cli.js')).href)).toBe(ROOT);
  });

  test('pip runs with --require-hashes and --no-deps, build tool first, never resolving anything else', () => {
    expect(telegramInstallCommands({ venvDir: '/v', packageRoot: '/pkg' })).toEqual([
      ['/v/bin/python', '-m', 'pip', 'install', '--quiet', '--require-hashes', '--no-deps', '-r', '/pkg/scripts/telegram-build-requirements.txt'],
      ['/v/bin/python', '-m', 'pip', 'install', '--quiet', '--require-hashes', '--no-deps', '--no-build-isolation', '-r', '/pkg/scripts/telegram-requirements.txt'],
    ]);
  });

  test('the manual hint installs from the same files the same way', () => {
    const hint = telegramDependencyHint('/pkg');
    expect(hint).toContain('python3 -m venv ~/.cache/olympus/telegram-python');
    expect(hint).toContain('-m pip install --require-hashes --no-deps -r /pkg/scripts/telegram-build-requirements.txt');
    expect(hint).toContain('-m pip install --require-hashes --no-deps --no-build-isolation -r /pkg/scripts/telegram-requirements.txt');
    expect(hint).not.toContain('Telethon==');
    expect(TELEGRAM_DEPENDENCY_HINT).toContain(join(ROOT, TELEGRAM_REQUIREMENTS_FILE));
  });
});

describe('provisioning the private Telegram Python', () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-telethon-'));
    return { root, venvDir: join(root, 'cache', 'olympus', 'telegram-python') };
  };
  const runner = (fail?: { step: number; stderr: string }) => {
    const ran: string[][] = [];
    const run = async (argv: string[]): Promise<PipRunResult> => {
      ran.push(argv);
      if (argv.includes('venv')) mkdirSync(join(argv[argv.length - 1]!, 'bin'), { recursive: true });
      if (fail && ran.length === fail.step) return { code: 1, stderr: fail.stderr };
      return { code: 0, stderr: '' };
    };
    return { ran, run };
  };

  test('makes the venv, installs both lists and checks the import', async () => {
    const { venvDir } = fixture();
    const { ran, run } = runner();
    expect(await provisionTelegramPython({ python3: '/usr/bin/python3', venvDir }, { run, packageRoot: '/pkg' })).toBe(true);
    expect(ran).toEqual([
      ['/usr/bin/python3', '-m', 'venv', venvDir],
      ...telegramInstallCommands({ venvDir, packageRoot: '/pkg' }),
      [join(venvDir, 'bin', 'python'), '-c', 'import telethon'],
    ]);
  });

  test('a tampered or substituted package is refused with a clear message, and nothing is left installed', async () => {
    const { venvDir } = fixture();
    const { ran, run } = runner({
      step: 3,
      stderr: 'ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE. If you have updated the package versions, please update the hashes. Otherwise, examine the package contents carefully; someone may have tampered with them.\n    telethon==1.45.0 from https://files.pythonhosted.org/...',
    });
    await expect(provisionTelegramPython({ python3: '/usr/bin/python3', venvDir }, { run, packageRoot: '/pkg' }))
      .rejects.toThrow('Olympus refused to install Telethon for Telegram: a downloaded package did not match the SHA-256 pinned in /pkg/scripts/telegram-requirements.txt, so it may have been tampered with or substituted on the way. Nothing was installed.');
    expect(ran).toHaveLength(3);
    expect(existsSync(venvDir)).toBe(false);
  });

  test('pairing surfaces the refusal rather than the generic install failure', async () => {
    const { root, venvDir } = fixture();
    const { run } = runner({ step: 2, stderr: 'ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE.' });
    await expect(readyTelegramPython({
      env: { XDG_CACHE_HOME: join(root, 'cache') },
      pythonHasTelethon: async () => false,
      provisionTelegramPython: (input) => provisionTelegramPython(input, { run, packageRoot: '/pkg' }),
    })).rejects.toThrow(/refused to install Telethon.*tampered/);
    expect(existsSync(venvDir)).toBe(false);
  });

  test('any other failure removes the half-made venv and reports failure', async () => {
    const { venvDir } = fixture();
    const { run } = runner({ step: 3, stderr: 'ERROR: Could not find a version that satisfies the requirement telethon==1.45.0' });
    expect(await provisionTelegramPython({ python3: '/usr/bin/python3', venvDir }, { run, packageRoot: '/pkg' })).toBe(false);
    expect(existsSync(venvDir)).toBe(false);
  });

  test('outside a package that holds the list, no root is found (so provisioning refuses rather than installing unpinned)', () => {
    expect(telegramRequirementsRoot(pathToFileURL('/nowhere/dist/cli.js').href, () => false)).toBeUndefined();
  });
});
