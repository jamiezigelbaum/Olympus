// Outside-help settings, the internal mechanism (design frontier-consult-lane
// §A.9, stage C3). Every test uses its own temporary HOME; nothing here may
// touch the real ~/.olympus.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  CONSULT_SETTINGS_MAX_BYTES,
  DEFAULT_CONSULT_SETTINGS,
  bindConsultJobPolicy,
  consultGateOptionsFromSettings,
  consultOutsideHelpEnabled,
  consultSettingsPath,
  parseConsultSettings,
  readConsultSettings,
  recheckConsultJobPolicy,
  writeConsultSettings,
  type ConsultSettingsChange,
} from '../src/core/consult-settings.ts';
import { operations } from '../src/core/operations.ts';

const repoRoot = join(import.meta.dir, '..');
const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'olympus-consult-settings-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    try {
      chmodSync(join(home, '.olympus', 'consult.json'), 0o600);
    } catch {
      // Not every test leaves a file behind.
    }
    rmSync(home, { recursive: true, force: true });
  }
});

const VALID = {
  v: 1,
  revision: 3,
  enabled: true,
  languages: ['en', 'pt-BR'],
  domains: { units: true, countries: false, medicines: true, medicineBrands: false },
  strict: false,
};

const ON: ConsultSettingsChange = {
  enabled: true,
  languages: ['en', 'pt-BR'],
  domains: { units: true, countries: true, medicines: true, medicineBrands: false },
  strict: false,
};

function settingsFile(home: string): string {
  return join(home, '.olympus', 'consult.json');
}

function placeFile(home: string, text: string, mode = 0o600): string {
  mkdirSync(join(home, '.olympus'), { recursive: true, mode: 0o700 });
  const path = settingsFile(home);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
}

describe('parseConsultSettings', () => {
  test('accepts exactly the schema', () => {
    expect(parseConsultSettings(VALID)).toEqual(VALID as never);
    expect(parseConsultSettings({ ...VALID, revision: 0, enabled: false, strict: true, languages: ['de', 'it', 'nl', 'fr', 'es', 'pt-PT'] })).toBeDefined();
    expect(Object.isFrozen(parseConsultSettings(VALID))).toBe(true);
  });

  const rejected: Array<[string, unknown]> = [
    ['null', null],
    ['an array', [VALID]],
    ['a string', JSON.stringify(VALID)],
    ['an unknown top-level key', { ...VALID, route: 'zkapi' }],
    ['a missing key', (({ strict: _strict, ...rest }) => rest)(VALID)],
    ['version 2', { ...VALID, v: 2 }],
    ['version as a string', { ...VALID, v: '1' }],
    ['a negative revision', { ...VALID, revision: -1 }],
    ['a fractional revision', { ...VALID, revision: 1.5 }],
    ['an unsafe revision', { ...VALID, revision: Number.MAX_SAFE_INTEGER + 1 }],
    ['a string revision', { ...VALID, revision: '3' }],
    ['enabled as a string', { ...VALID, enabled: 'true' }],
    ['enabled as 1', { ...VALID, enabled: 1 }],
    ['strict as null', { ...VALID, strict: null }],
    ['empty languages', { ...VALID, languages: [] }],
    ['an unknown language', { ...VALID, languages: ['en', 'xx'] }],
    ['a wrongly cased language', { ...VALID, languages: ['pt-br'] }],
    ['a duplicated language', { ...VALID, languages: ['en', 'en'] }],
    ['languages as a string', { ...VALID, languages: 'en' }],
    ['a non-string language', { ...VALID, languages: ['en', 7] }],
    ['an unknown domain', { ...VALID, domains: { ...VALID.domains, names: true } }],
    ['a missing domain', { ...VALID, domains: { units: true, countries: false, medicines: true } }],
    ['a non-boolean domain', { ...VALID, domains: { ...VALID.domains, units: 'yes' } }],
    ['domains as an array', { ...VALID, domains: [] }],
  ];
  for (const [label, value] of rejected) {
    test(`rejects ${label}`, () => {
      expect(parseConsultSettings(value)).toBeUndefined();
    });
  }
});

describe('readConsultSettings fails closed', () => {
  test('absent file, absent directory and an environment without HOME read as off', () => {
    const home = tempHome();
    expect(readConsultSettings({ env: { HOME: home } })).toEqual({ state: 'absent', settings: DEFAULT_CONSULT_SETTINGS });
    expect(readConsultSettings({ env: {} })).toEqual({ state: 'absent', settings: DEFAULT_CONSULT_SETTINGS });
    expect(DEFAULT_CONSULT_SETTINGS).toMatchObject({ enabled: false, revision: 0, languages: ['en'], strict: false });
  });

  test('a valid file with outside help on is the only thing that turns it on', () => {
    const home = tempHome();
    placeFile(home, JSON.stringify(VALID));
    const read = readConsultSettings({ env: { HOME: home } });
    expect(read.state).toBe('valid');
    expect(consultOutsideHelpEnabled(read)).toBe(true);
    expect(consultGateOptionsFromSettings(read.settings)).toEqual({ languages: ['en', 'pt-BR'], domains: VALID.domains });
  });

  const invalidCases: Array<[string, (home: string) => void, string]> = [
    ['malformed JSON', (home) => placeFile(home, '{"v":1,'), 'malformed_json'],
    ['an unknown key', (home) => placeFile(home, JSON.stringify({ ...VALID, extra: 1 })), 'invalid_shape'],
    ['a group-writable file', (home) => placeFile(home, JSON.stringify(VALID), 0o620), 'insecure_permissions'],
    ['a world-writable file', (home) => placeFile(home, JSON.stringify(VALID), 0o602), 'insecure_permissions'],
    ['an oversized file', (home) => placeFile(home, JSON.stringify({ ...VALID, pad: 'x'.repeat(CONSULT_SETTINGS_MAX_BYTES) })), 'too_large'],
    ['a directory', (home) => mkdirSync(settingsFile(home), { recursive: true }), 'not_a_regular_file'],
    ['a symlink to a valid file', (home) => {
      const target = join(home, 'elsewhere.json');
      writeFileSync(target, JSON.stringify(VALID), { mode: 0o600 });
      mkdirSync(join(home, '.olympus'), { recursive: true });
      symlinkSync(target, settingsFile(home));
    }, 'not_a_regular_file'],
  ];
  for (const [label, arrange, reason] of invalidCases) {
    test(`${label} reads as invalid (${reason}) and outside help off`, () => {
      const home = tempHome();
      arrange(home);
      const read = readConsultSettings({ env: { HOME: home } });
      expect(read).toMatchObject({ state: 'invalid', reason });
      expect(read.settings).toBe(DEFAULT_CONSULT_SETTINGS);
      expect(consultOutsideHelpEnabled(read)).toBe(false);
      expect(bindConsultJobPolicy(read).outsideHelp).toBe(false);
    });
  }

  test('an unreadable file reads as invalid, never throws', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads anything
    const home = tempHome();
    placeFile(home, JSON.stringify(VALID), 0o000);
    expect(readConsultSettings({ env: { HOME: home } })).toMatchObject({ state: 'invalid', reason: 'unreadable' });
  });
});

describe('settings location honours the injected HOME', () => {
  test('the path comes from env.HOME, never the process owner\'s home', () => {
    const home = tempHome();
    expect(consultSettingsPath({ HOME: home })).toBe(join(home, '.olympus', 'consult.json'));
    expect(consultSettingsPath({ HOME: '  ' })).toBeUndefined();
    expect(consultSettingsPath({})).toBeUndefined();
  });

  test('a write without a HOME refuses instead of falling back', () => {
    expect(() => writeConsultSettings({ env: {} }, 0, ON)).toThrow('no HOME');
  });
});

describe('writeConsultSettings', () => {
  test('creates an owner-only file in an owner-only directory, atomically, at revision 1', () => {
    const home = tempHome();
    const result = writeConsultSettings({ env: { HOME: home } }, 0, ON);
    expect(result).toMatchObject({ ok: true, settings: { revision: 1, enabled: true } });
    const path = settingsFile(home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.olympus')).mode & 0o777).toBe(0o700);
    // Only the file itself remains: no temp file and no lease lockfile.
    expect(readdirSync(join(home, '.olympus'))).toEqual(['consult.json']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1, revision: 1, ...ON });
  });

  test('reads at each use: a change is visible to the next read with no restart', () => {
    const home = tempHome();
    const location = { env: { HOME: home } };
    expect(consultOutsideHelpEnabled(readConsultSettings(location))).toBe(false);
    writeConsultSettings(location, 0, ON);
    expect(consultOutsideHelpEnabled(readConsultSettings(location))).toBe(true);
    writeConsultSettings(location, 1, { ...ON, enabled: false });
    expect(readConsultSettings(location)).toMatchObject({ state: 'valid', settings: { revision: 2, enabled: false } });
  });

  test('compare-and-swap: a stale revision is refused and leaves the file untouched', () => {
    const home = tempHome();
    const location = { env: { HOME: home } };
    expect(writeConsultSettings(location, 0, ON).ok).toBe(true);
    const before = readFileSync(settingsFile(home), 'utf8');
    expect(writeConsultSettings(location, 0, { ...ON, enabled: false })).toEqual({ ok: false, reason: 'revision_conflict', currentRevision: 1 });
    expect(writeConsultSettings(location, 5, { ...ON, enabled: false })).toEqual({ ok: false, reason: 'revision_conflict', currentRevision: 1 });
    expect(readFileSync(settingsFile(home), 'utf8')).toBe(before);
    expect(writeConsultSettings(location, 1, { ...ON, enabled: false })).toMatchObject({ ok: true, settings: { revision: 2 } });
  });

  test('never overwrites an invalid file', () => {
    const home = tempHome();
    placeFile(home, '{"v":1,"enabled":true}');
    expect(writeConsultSettings({ env: { HOME: home } }, 0, ON)).toEqual({ ok: false, reason: 'current_invalid', invalidReason: 'invalid_shape' });
    expect(readFileSync(settingsFile(home), 'utf8')).toBe('{"v":1,"enabled":true}');
  });

  test('replaces an existing file with owner-only permissions', () => {
    const home = tempHome();
    placeFile(home, JSON.stringify({ ...VALID, revision: 4 }), 0o644);
    expect(writeConsultSettings({ env: { HOME: home } }, 4, ON)).toMatchObject({ ok: true, settings: { revision: 5 } });
    expect(statSync(settingsFile(home)).mode & 0o777).toBe(0o600);
  });

  test('refuses a change that is not valid settings, writing nothing', () => {
    const home = tempHome();
    const location = { env: { HOME: home } };
    expect(() => writeConsultSettings(location, 0, { ...ON, languages: [] })).toThrow('not valid');
    expect(() => writeConsultSettings(location, 0, { ...ON, languages: ['xx' as never] })).toThrow('not valid');
    expect(() => writeConsultSettings(location, -1, ON)).toThrow('non-negative');
    expect(existsSync(settingsFile(home))).toBe(false);
  });
});

describe('per-job binding', () => {
  test('a job keeps the policy it bound; final authorization refuses once outside help is off', () => {
    const home = tempHome();
    const location = { env: { HOME: home } };
    writeConsultSettings(location, 0, ON);
    const policy = bindConsultJobPolicy(readConsultSettings(location));
    expect(policy).toEqual({ settingsRevision: 1, outsideHelp: true, languages: ['en', 'pt-BR'], domains: ON.domains, strict: false });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: true });

    // A later change does not alter the bound policy.
    writeConsultSettings(location, 1, { ...ON, languages: ['en'] });
    expect(policy.languages).toEqual(['en', 'pt-BR']);
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: true });

    writeConsultSettings(location, 2, { ...ON, enabled: false });
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_off' });

    rmSync(settingsFile(home));
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_absent' });

    placeFile(home, 'not json');
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_invalid' });
  });

  test('a job bound while outside help was off never consults, even if it is turned on later', () => {
    const home = tempHome();
    const location = { env: { HOME: home } };
    const policy = bindConsultJobPolicy(readConsultSettings(location));
    expect(policy).toMatchObject({ settingsRevision: 0, outsideHelp: false });
    writeConsultSettings(location, 0, ON);
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'bound_off' });
  });
});

// Design §A.9: changed only on the Mac, never from ChatGPT, an agent tool or
// the relay. Until the Mac dashboard enable path (C5) lands, nothing calls the
// writer at all; the hosted-agent surfaces must never import the module.
describe('nothing outside the Mac can change the settings', () => {
  const WRITER_SYMBOLS = ['writeConsultSettings'];
  const SETTINGS_MODULE = 'src/core/consult-settings.ts';
  /** Files allowed to call the writer. Empty until C5's Mac dashboard path. */
  const WRITER_CALLERS: readonly string[] = [];
  /** Files allowed to import the settings module at all. */
  const SETTINGS_IMPORTERS: readonly string[] = ['src/core/doctor.ts'];

  function sourceFiles(dir: string): string[] {
    const root = join(repoRoot, dir);
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const path = join(current, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(relative(repoRoot, path));
      }
    };
    walk(root);
    return out;
  }

  const sources = [...sourceFiles('src'), ...sourceFiles('connect-relay'), ...sourceFiles('exchange'), ...sourceFiles('scripts')];

  test('no source file other than the module references the writer', () => {
    const offenders = sources.filter((file) => file !== SETTINGS_MODULE
      && WRITER_SYMBOLS.some((symbol) => readFileSync(join(repoRoot, file), 'utf8').includes(symbol)))
      .filter((file) => !WRITER_CALLERS.includes(file));
    expect(offenders).toEqual([]);
  });

  test('only the allowed modules import the settings module', () => {
    const importers = sources.filter((file) => file !== SETTINGS_MODULE
      && /from ['"][./]*(?:core\/)?consult-settings(?:\.ts)?['"]/.test(readFileSync(join(repoRoot, file), 'utf8')));
    expect(importers.sort()).toEqual([...SETTINGS_IMPORTERS].sort());
  });

  test('MCP, setup tools, the ChatGPT surface and the relay never reach the settings module', () => {
    const hostedSurfaces = sources.filter((file) =>
      file.startsWith('src/mcp/')
      || file.startsWith('connect-relay/')
      || file.startsWith('exchange/')
      || file.startsWith('src/workers/chatgpt/')
      || file.startsWith('src/workers/remote-')
      || file.startsWith('src/core/remote-')
      || /^src\/core\/setup[^/]*\.ts$/.test(file));
    expect(hostedSurfaces.length).toBeGreaterThan(0);
    const offenders = hostedSurfaces.filter((file) => readFileSync(join(repoRoot, file), 'utf8').includes('consult-settings'));
    expect(offenders).toEqual([]);
  });

  test('no registered operation (every MCP, native, CLI and remote tool) is a consult settings operation', () => {
    const names = operations.map((operation) => operation.name);
    expect(names.filter((name) => /consult/i.test(name))).toEqual([]);
  });
});
