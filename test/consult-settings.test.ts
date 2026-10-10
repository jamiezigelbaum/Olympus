// Outside-help settings, the internal reader (design frontier-consult-lane
// §A.9, stage C3). Every test uses its own temporary HOME; nothing here may
// touch the real ~/.olympus.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
  __consultSettingsTestHooks,
  bindConsultJobPolicy,
  consultGateOptionsFromSettings,
  consultOutsideHelpEnabled,
  consultSettingsPath,
  parseConsultSettings,
  parseConsultSettingsText,
  readConsultSettings,
  recheckConsultJobPolicy,
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
  __consultSettingsTestHooks.afterOpen = undefined;
  __consultSettingsTestHooks.afterStat = undefined;
  __consultSettingsTestHooks.afterRead = undefined;
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
  domains: { units: true, countries: false, places: true, technical: true, medicines: true, medicineBrands: false },
  strict: false,
  level: 'unnamed',
};

function settingsFile(home: string): string {
  return join(home, '.olympus', 'consult.json');
}

function placeFile(home: string, content: string | Buffer, mode = 0o600): string {
  mkdirSync(join(home, '.olympus'), { recursive: true, mode: 0o700 });
  const path = settingsFile(home);
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

function placeSettings(home: string, settings: Record<string, unknown>): void {
  placeFile(home, JSON.stringify(settings));
}

describe('parseConsultSettings', () => {
  test('a file written before the places and technical keys stays valid, with both on; unknown keys still reject', () => {
    const { places: _places, technical: _technical, ...oldDomains } = VALID.domains;
    const old = parseConsultSettings({ ...VALID, domains: oldDomains });
    expect(old?.domains).toEqual({ ...VALID.domains, places: true, technical: true });
    expect(parseConsultSettings({ ...VALID, domains: { ...oldDomains, technical: false } })?.domains.technical).toBe(false);
    expect(parseConsultSettings({ ...VALID, domains: { ...oldDomains, extra: true } })).toBeUndefined();
    const { units: _units, ...missingRequired } = oldDomains;
    expect(parseConsultSettings({ ...VALID, domains: missingRequired })).toBeUndefined();
    expect(parseConsultSettings({ ...VALID, domains: { ...oldDomains, places: 'yes' } })).toBeUndefined();
  });

  test('level: a file without it reads as "unnamed", the recommended default (sending still needs the current statements); only the two values are accepted', () => {
    const { level: _level, ...old } = VALID;
    expect(parseConsultSettings(old)?.level).toBe('unnamed');
    expect(parseConsultSettings({ ...VALID, level: 'general' })?.level).toBe('general');
    expect(parseConsultSettings({ ...VALID, level: 'unnamed' })?.level).toBe('unnamed');
    for (const level of [null, '', 'Unnamed', 'names', 1, true, ['unnamed']]) expect(parseConsultSettings({ ...VALID, level })).toBeUndefined();
    // No file at all: outside help off, and a first write records the new-setup level.
    expect(DEFAULT_CONSULT_SETTINGS.level).toBe('unnamed');
    expect(consultGateOptionsFromSettings(parseConsultSettings(old)!).level).toBe('unnamed');
    expect(consultGateOptionsFromSettings(parseConsultSettings(VALID)!).level).toBe('unnamed');
  });

  test('accepts exactly the schema', () => {
    expect(parseConsultSettings(VALID)).toEqual(VALID as never);
    expect(parseConsultSettings({ ...VALID, revision: 0, enabled: false, strict: true, languages: ['de', 'it', 'nl', 'fr', 'es', 'pt-PT'] })).toBeDefined();
    const parsed = parseConsultSettings(VALID)!;
    expect(Object.isFrozen(parsed) && Object.isFrozen(parsed.languages) && Object.isFrozen(parsed.domains)).toBe(true);
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

describe('parseConsultSettingsText rejects duplicate keys before the schema', () => {
  const body = (inner: string) => `{"v":1,"revision":3,${inner},"languages":["en"],"domains":{"units":true,"countries":false,"places":true,"technical":true,"medicines":true,"medicineBrands":false},"strict":false}`;

  test('a well-formed document is valid', () => {
    expect(parseConsultSettingsText(body('"enabled":true')).state).toBe('valid');
  });
  test('"enabled":false,"enabled":true is refused, not read as on', () => {
    const read = parseConsultSettingsText(body('"enabled":false,"enabled":true'));
    expect(read).toMatchObject({ state: 'invalid', reason: 'duplicate_key' });
    expect(consultOutsideHelpEnabled(read)).toBe(false);
  });
  test('an escaped spelling of the same key is a duplicate', () => {
    expect(parseConsultSettingsText(body('"enabled":false,"\\u0065nabled":true'))).toMatchObject({ reason: 'duplicate_key' });
  });
  test('a duplicate inside domains is refused', () => {
    const text = '{"v":1,"revision":3,"enabled":true,"languages":["en"],"domains":{"units":true,"units":false,"countries":false,"places":true,"technical":true,"medicines":true,"medicineBrands":false},"strict":false}';
    expect(parseConsultSettingsText(text)).toMatchObject({ reason: 'duplicate_key' });
  });
  test('the same key in different objects, and key-like strings in values, are not duplicates', () => {
    expect(parseConsultSettingsText('{"a":{"x":1},"b":{"x":2},"c":["a","a"],"d":"a,\\"a\\""}')).toMatchObject({ reason: 'invalid_shape' });
  });
  test('malformed JSON is malformed_json', () => {
    expect(parseConsultSettingsText('{"v":1,')).toMatchObject({ reason: 'malformed_json' });
  });
});

describe('readConsultSettings fails closed', () => {
  test('absent file and an environment without HOME read as off', () => {
    const home = tempHome();
    expect(readConsultSettings({ env: { HOME: home } })).toEqual({ state: 'absent', settings: DEFAULT_CONSULT_SETTINGS });
    expect(readConsultSettings({ env: {} })).toEqual({ state: 'absent', settings: DEFAULT_CONSULT_SETTINGS });
    expect(DEFAULT_CONSULT_SETTINGS).toMatchObject({ enabled: false, revision: 0, languages: ['en'], strict: false });
  });

  test('a valid file with outside help on is the only thing that turns it on', () => {
    const home = tempHome();
    placeSettings(home, VALID);
    const read = readConsultSettings({ env: { HOME: home } });
    expect(read.state).toBe('valid');
    expect(consultOutsideHelpEnabled(read)).toBe(true);
    expect(consultGateOptionsFromSettings(read.settings)).toEqual({ languages: ['en', 'pt-BR'], domains: VALID.domains, level: 'unnamed' });
  });

  test('reads at each use: a change is visible to the next read with no restart', () => {
    const home = tempHome();
    const location = { env: { HOME: home } };
    expect(consultOutsideHelpEnabled(readConsultSettings(location))).toBe(false);
    placeSettings(home, VALID);
    expect(consultOutsideHelpEnabled(readConsultSettings(location))).toBe(true);
    placeSettings(home, { ...VALID, revision: 4, enabled: false });
    expect(readConsultSettings(location)).toMatchObject({ state: 'valid', settings: { revision: 4, enabled: false } });
  });

  const invalidCases: Array<[string, (home: string) => void, string]> = [
    ['malformed JSON', (home) => placeFile(home, '{"v":1,'), 'malformed_json'],
    ['an unknown key', (home) => placeSettings(home, { ...VALID, extra: 1 }), 'invalid_shape'],
    ['a duplicated key', (home) => placeFile(home, JSON.stringify({ ...VALID, enabled: false }).replace('"enabled":false', '"enabled":false,"enabled":true')), 'duplicate_key'],
    ['invalid UTF-8', (home) => placeFile(home, Buffer.concat([Buffer.from('{"v":1,"x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])), 'invalid_utf8'],
    ['a group-writable file', (home) => placeFile(home, JSON.stringify(VALID), 0o620), 'insecure_permissions'],
    ['a world-writable file', (home) => placeFile(home, JSON.stringify(VALID), 0o602), 'insecure_permissions'],
    ['an oversized file', (home) => placeSettings(home, { ...VALID, pad: 'x'.repeat(CONSULT_SETTINGS_MAX_BYTES) }), 'too_large'],
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

  test('a FIFO is refused without blocking', () => {
    const home = tempHome();
    mkdirSync(join(home, '.olympus'), { recursive: true, mode: 0o700 });
    const made = spawnSync('mkfifo', ['-m', '600', settingsFile(home)]);
    if (made.status !== 0) throw new Error('mkfifo unavailable');
    // No writer ever opens the FIFO: a blocking open or read would hang here.
    expect(readConsultSettings({ env: { HOME: home } })).toMatchObject({ state: 'invalid', reason: 'not_a_regular_file' });
  }, 10_000);

  test('an unreadable file reads as invalid, never throws', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads anything
    const home = tempHome();
    placeFile(home, JSON.stringify(VALID), 0o000);
    expect(readConsultSettings({ env: { HOME: home } })).toMatchObject({ state: 'invalid', reason: 'unreadable' });
  });

  test('path resolution failures stay inside the fail-closed boundary', () => {
    const env = Object.defineProperty({}, 'HOME', { get() { throw new Error('no home for you'); } }) as Record<string, string | undefined>;
    expect(readConsultSettings({ env })).toMatchObject({ state: 'invalid', reason: 'unreadable', settings: DEFAULT_CONSULT_SETTINGS });
  });
});

describe('the file examined is the file read', () => {
  test('swapping the path after open does not change what is read', () => {
    const home = tempHome();
    placeSettings(home, { ...VALID, enabled: false });
    const replacement = join(home, 'replacement.json');
    writeFileSync(replacement, JSON.stringify(VALID), { mode: 0o600 });
    __consultSettingsTestHooks.afterOpen = (path) => renameSync(replacement, path);
    // The descriptor still names the original (off) file.
    expect(readConsultSettings({ env: { HOME: home } })).toMatchObject({ state: 'valid', settings: { enabled: false } });
    __consultSettingsTestHooks.afterOpen = undefined;
    expect(readConsultSettings({ env: { HOME: home } })).toMatchObject({ state: 'valid', settings: { enabled: true } });
  });

  test('swapping in an insecure file after open is judged by the original descriptor', () => {
    const home = tempHome();
    placeSettings(home, VALID);
    const replacement = join(home, 'replacement.json');
    writeFileSync(replacement, JSON.stringify(VALID));
    chmodSync(replacement, 0o666);
    __consultSettingsTestHooks.afterOpen = (path) => renameSync(replacement, path);
    expect(readConsultSettings({ env: { HOME: home } }).state).toBe('valid');
    __consultSettingsTestHooks.afterOpen = undefined;
    expect(readConsultSettings({ env: { HOME: home } })).toMatchObject({ reason: 'insecure_permissions' });
  });

  test('a file that grows after the size check is read only to the limit plus one byte, then refused', () => {
    const home = tempHome();
    placeSettings(home, VALID);
    let reportedSize = 0;
    __consultSettingsTestHooks.afterStat = (path) => {
      reportedSize = statSync(path).size;
      // Grow in many short chunks, to far past the limit, after fstat saw a small file.
      for (let index = 0; index < 64; index += 1) appendFileSync(path, ' '.repeat(1024));
    };
    let bytesRead = -1;
    __consultSettingsTestHooks.afterRead = (bytes) => { bytesRead = bytes; };
    const read = readConsultSettings({ env: { HOME: home } });
    expect(reportedSize).toBeLessThan(1024);
    expect(bytesRead).toBe(CONSULT_SETTINGS_MAX_BYTES + 1);
    expect(statSync(settingsFile(home)).size).toBeGreaterThan(4 * CONSULT_SETTINGS_MAX_BYTES);
    expect(read).toMatchObject({ state: 'invalid', reason: 'too_large', settings: DEFAULT_CONSULT_SETTINGS });
    expect(consultOutsideHelpEnabled(read)).toBe(false);
  });

  test('a file that grows past the limit after open is too large', () => {
    const home = tempHome();
    placeSettings(home, VALID);
    __consultSettingsTestHooks.afterOpen = (path) => appendFileSync(path, ' '.repeat(CONSULT_SETTINGS_MAX_BYTES + 10));
    expect(readConsultSettings({ env: { HOME: home } })).toMatchObject({ state: 'invalid', reason: 'too_large' });
  });
});

describe('settings location honours the injected HOME', () => {
  test('the path comes from env.HOME with no operating-system fallback', () => {
    const home = tempHome();
    expect(consultSettingsPath({ HOME: home })).toBe(join(home, '.olympus', 'consult.json'));
    expect(consultSettingsPath({ HOME: '  ' })).toBeUndefined();
    expect(consultSettingsPath({})).toBeUndefined();
  });
});

describe('per-job binding', () => {
  test('a job keeps the policy it bound and authorizes only at that revision', () => {
    const home = tempHome();
    const location = { env: { HOME: home } };
    placeSettings(home, VALID);
    const policy = bindConsultJobPolicy(readConsultSettings(location));
    expect(policy).toEqual({ settingsRevision: 3, outsideHelp: true, languages: ['en', 'pt-BR'], domains: VALID.domains, strict: false, level: 'unnamed' });
    expect(Object.isFrozen(policy) && Object.isFrozen(policy.languages) && Object.isFrozen(policy.domains)).toBe(true);
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: true });

    // A later change does not alter the bound policy, and it refuses.
    placeSettings(home, { ...VALID, revision: 4, languages: ['en'] });
    expect(policy.languages).toEqual(['en', 'pt-BR']);
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_stale' });

    // A different revision is stale even when it also turned outside help off.
    placeSettings(home, { ...VALID, revision: 5, enabled: false });
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_stale' });

    // Off at the bound revision (not something a compare-and-swap writer produces) is still off.
    placeSettings(home, { ...VALID, enabled: false });
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_off' });

    rmSync(settingsFile(home));
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_absent' });

    placeFile(home, 'not json');
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_invalid' });
  });

  test('the level is bound: a level change refuses as stale, even at the same revision (a hand edit)', () => {
    const home = tempHome();
    const location = { env: { HOME: home } };
    placeSettings(home, { ...VALID, level: 'general' });
    const policy = bindConsultJobPolicy(readConsultSettings(location));
    expect(policy.level).toBe('general');
    placeSettings(home, { ...VALID, level: 'unnamed' });
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_stale' });
    placeSettings(home, { ...VALID, revision: 4, level: 'unnamed' });
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_stale' });
    // A file without the key reads as unnamed (Standard): a job bound to general refuses, one bound to unnamed authorizes.
    const { level: _level, ...old } = VALID;
    placeSettings(home, old);
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_stale' });
    placeSettings(home, { ...VALID, level: 'unnamed' });
    const unnamed = bindConsultJobPolicy(readConsultSettings(location));
    placeSettings(home, old);
    expect(recheckConsultJobPolicy(unnamed, readConsultSettings(location))).toEqual({ ok: true });
  });

  test('turning outside help off and on again between bind and recheck refuses', () => {
    const home = tempHome();
    const location = { env: { HOME: home } };
    placeSettings(home, VALID);
    const policy = bindConsultJobPolicy(readConsultSettings(location));
    placeSettings(home, { ...VALID, revision: 4, enabled: false });
    placeSettings(home, { ...VALID, revision: 5, enabled: true });
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'settings_stale' });
  });

  test('a job bound while outside help was off never consults, even if it is turned on later', () => {
    const home = tempHome();
    const location = { env: { HOME: home } };
    const policy = bindConsultJobPolicy(readConsultSettings(location));
    expect(policy).toMatchObject({ settingsRevision: 0, outsideHelp: false });
    placeSettings(home, VALID);
    expect(recheckConsultJobPolicy(policy, readConsultSettings(location))).toEqual({ ok: false, reason: 'bound_off' });
  });
});

// Design §A.9: changed only on the Mac, never from ChatGPT, an agent tool or
// the relay. No writer ships yet. The readers: doctor (its status line), and
// since stage C4a the private-answer jobs engine, which binds each job's
// policy at creation (`bindConsultJobPolicy`) through the production wiring
// in the worker server. Both only read; the list below is exact so a new
// importer is a reviewed decision.
describe('the settings module stays off the hosted surfaces', () => {
  const SETTINGS_MODULE = 'src/core/consult-settings.ts';
  const SETTINGS_IMPORTERS: readonly string[] = [
    'src/core/doctor.ts',
    // The C4b orchestrator re-reads the settings at the gate and inside
    // final authorization (recheckConsultJobPolicy); it only reads.
    'src/workers/chatgpt/consult-orchestrator.ts',
    'src/workers/chatgpt/private-answer-jobs.ts',
    'src/workers/email-source/server.ts',
    // The C5 writer (its own module) reuses the reader's parser and re-reads
    // the file under its lease for compare-and-swap; it only writes through
    // the Mac dashboard adapter below.
    'src/core/consult-settings-writer.ts',
    // The C5 Outside help adapter reads the settings for the card's state;
    // it is also the writer's one caller (test/consult-settings-writer.test.ts
    // holds that the adapter is reachable only from the composition root).
    'src/workers/email-source/dashboard-consult.ts',
    // `olympus zkapi test-writer` reads the saved writer, level and
    // languages to run the writer check; it only reads.
    'src/cli.ts',
  ];

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

  test('only the allowed modules import the settings module', () => {
    const sources = [...sourceFiles('src'), ...sourceFiles('connect-relay'), ...sourceFiles('exchange'), ...sourceFiles('scripts')];
    // Static `from '…'` imports and dynamic `import('…')` alike.
    const importers = sources.filter((file) => file !== SETTINGS_MODULE
      && /(?:from|import\s*\()\s*['"][./]*(?:core\/)?consult-settings(?:\.ts)?['"]/.test(readFileSync(join(repoRoot, file), 'utf8')));
    expect(importers.sort()).toEqual([...SETTINGS_IMPORTERS].sort());
  });

  test('no registered operation (every MCP, native, CLI and remote tool) is a consult settings operation', () => {
    const names = operations.map((operation) => operation.name);
    expect(names.filter((name) => /consult/i.test(name))).toEqual([]);
  });
});

describe('the owner\'s writer and the ChatGPT model (2026-10-10)', () => {
  const base = { v: 1, revision: 3, enabled: true, languages: ['en'], domains: { units: true, countries: true, medicines: true, medicineBrands: false }, strict: false, level: 'unnamed' };
  test('optional; any HTTP(S) host (loopback, LAN, tailnet); a key reference and a bounded deadline', () => {
    expect(parseConsultSettings(base)?.writer).toBeUndefined();
    for (const baseUrl of ['http://127.0.0.1:11434/v1', 'http://192.168.1.20:8080/v1', 'https://delphi.tail1234.ts.net/v1']) {
      expect(parseConsultSettings({ ...base, writer: { baseUrl, model: 'qwen3-32b' } })?.writer).toEqual({ baseUrl, model: 'qwen3-32b' });
    }
    expect(parseConsultSettings({ ...base, writer: { baseUrl: 'http://h:1/v1/', model: 'm', secretRef: 'env:KEY', timeoutMs: 120_000 } })?.writer).toEqual({ baseUrl: 'http://h:1/v1', model: 'm', secretRef: 'env:KEY', timeoutMs: 120_000 });
    expect(parseConsultSettings({ ...base, chatgptFrontierModel: 'anthropic/some-model' })?.chatgptFrontierModel).toBe('anthropic/some-model');
  });

  test('anything else makes the whole file invalid (outside help off)', () => {
    for (const writer of [
      { baseUrl: 'ftp://h/v1', model: 'm' },
      { baseUrl: 'http://user:pw@h/v1', model: 'm' },
      { baseUrl: 'http://h/v1?x=1', model: 'm' },
      { baseUrl: 'http://h/v1', model: '' },
      { baseUrl: 'http://h/v1', model: 'a b' },
      { baseUrl: 'http://h/v1', model: 'm', secretRef: 'plain-key' },
      { baseUrl: 'http://h/v1', model: 'm', timeoutMs: 1_000 },
      { baseUrl: 'http://h/v1', model: 'm', apiKey: 'x' },
      { model: 'm' },
    ]) expect({ writer, parsed: parseConsultSettings({ ...base, writer }) }).toEqual({ writer, parsed: undefined });
    expect(parseConsultSettings({ ...base, chatgptFrontierModel: '' })).toBeUndefined();
  });
});
