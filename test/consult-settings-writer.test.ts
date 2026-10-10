// The outside-help settings writer (src/core/consult-settings-writer.ts;
// design docs/design/frontier-consult-lane.md §A.9, stage C5): every rule
// recorded for it in PR #152's body, each held here, plus the import-graph
// boundary that keeps it off every hosted surface.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { dirname, join, relative, resolve } from 'node:path';
import { withFileLeaseSync } from '../src/core/file-lease.ts';
import { DEFAULT_CONSULT_DOMAIN_PACKS } from '../src/core/consult-gate.ts';
import { DEFAULT_CONSULT_SETTINGS, readConsultSettings } from '../src/core/consult-settings.ts';
import { __consultSettingsWriterTestHooks, writeConsultSettings, type ConsultSettingsWriteInput } from '../src/core/consult-settings-writer.ts';

const repoRoot = join(import.meta.dir, '..');
const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'olympus-consult-writer-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  __consultSettingsWriterTestHooks.afterPublish = undefined;
  for (const home of homes.splice(0)) {
    try {
      chmodSync(join(home, '.olympus'), 0o700);
      chmodSync(join(home, '.olympus', 'consult.json'), 0o600);
    } catch {
      // Not every test leaves these behind.
    }
    rmSync(home, { recursive: true, force: true });
  }
});

const UPDATE: ConsultSettingsWriteInput = {
  enabled: true,
  languages: ['en', 'pt-BR'],
  domains: { ...DEFAULT_CONSULT_DOMAIN_PACKS },
  strict: false,
  level: 'unnamed',
  expectedRevision: 0,
};

function settingsFile(home: string): string {
  return join(home, '.olympus', 'consult.json');
}

describe('writeConsultSettings: the happy path', () => {
  test('creates ~/.olympus at 0700 and the file at 0600, revision 1, exactly the schema; the reader accepts it', () => {
    const home = tempHome();
    const env = { HOME: home };
    const result = writeConsultSettings(UPDATE, { env });
    expect(result).toEqual({ ok: true, settings: { v: 1, revision: 1, enabled: true, languages: ['en', 'pt-BR'], domains: UPDATE.domains, strict: false, level: 'unnamed' } });
    expect(statSync(join(home, '.olympus')).mode & 0o777).toBe(0o700);
    expect(statSync(settingsFile(home)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(settingsFile(home), 'utf8'))).toEqual({ v: 1, revision: 1, enabled: true, languages: ['en', 'pt-BR'], domains: UPDATE.domains, strict: false, level: 'unnamed' });
    const read = readConsultSettings({ env });
    expect(read.state).toBe('valid');
    expect(read.settings.enabled).toBe(true);
    // No temporary file or lock is left behind.
    expect(readdirSync(join(home, '.olympus'))).toEqual(['consult.json']);
  });

  test('the level is always written, so the file never relies on the reader\'s default; an invalid level writes nothing', () => {
    const home = tempHome();
    const env = { HOME: home };
    expect(writeConsultSettings({ ...UPDATE, level: 'general' }, { env })).toMatchObject({ ok: true, settings: { level: 'general' } });
    expect(JSON.parse(readFileSync(settingsFile(home), 'utf8')).level).toBe('general');
    expect(writeConsultSettings({ ...UPDATE, level: 'everything' as never, expectedRevision: 1 }, { env })).toEqual({ ok: false, reason: 'invalid_input' });
    expect(JSON.parse(readFileSync(settingsFile(home), 'utf8'))).toMatchObject({ revision: 1, level: 'general' });
  });

  test('compare-and-swap: each write bumps the revision; a stale expected revision is refused and writes nothing', () => {
    const home = tempHome();
    const env = { HOME: home };
    expect(writeConsultSettings(UPDATE, { env }).ok).toBe(true);
    const second = writeConsultSettings({ ...UPDATE, enabled: false, expectedRevision: 1 }, { env });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.settings).toMatchObject({ revision: 2, enabled: false });
    // A page built from revision 1 (or 0) tries again: refused, the file untouched.
    for (const expectedRevision of [0, 1, 5]) {
      const stale = writeConsultSettings({ ...UPDATE, expectedRevision }, { env });
      expect(stale.ok).toBe(false);
      if (!stale.ok) {
        expect(stale.reason).toBe('revision_conflict');
        expect(stale.current?.state).toBe('valid');
        if (stale.current?.state === 'valid') expect(stale.current.settings.revision).toBe(2);
      }
    }
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { revision: 2, enabled: false } });
    // Absent file: only expected revision 0 writes.
    const other = tempHome();
    const conflict = writeConsultSettings({ ...UPDATE, expectedRevision: 1 }, { env: { HOME: other } });
    expect(conflict).toMatchObject({ ok: false, reason: 'revision_conflict', current: { state: 'absent' } });
    expect(existsSync(settingsFile(other))).toBe(false);
  });

  test('the replace is atomic: the old file keeps its inode-independent contents until the rename, and a failed write leaves it intact', () => {
    const home = tempHome();
    const env = { HOME: home };
    expect(writeConsultSettings(UPDATE, { env }).ok).toBe(true);
    const before = readFileSync(settingsFile(home), 'utf8');
    // A write that cannot complete: the directory is made read-only for the
    // duration, so the temporary file cannot be created. The existing file
    // is untouched.
    chmodSync(join(home, '.olympus'), 0o500);
    const failed = writeConsultSettings({ ...UPDATE, enabled: false, expectedRevision: 1 }, { env });
    chmodSync(join(home, '.olympus'), 0o700);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(['write_failed', 'directory_custody']).toContain(failed.reason);
    expect(readFileSync(settingsFile(home), 'utf8')).toBe(before);
    // No temp file was left behind either.
    expect(readdirSync(join(home, '.olympus')).filter((name) => name !== 'consult.json')).toEqual([]);
  });

  test('a failure after the publish (the rename) is not "nothing changed": the file is read back and the new state reported', () => {
    const home = tempHome();
    const env = { HOME: home };
    expect(writeConsultSettings(UPDATE, { env }).ok).toBe(true);
    __consultSettingsWriterTestHooks.afterPublish = () => { throw new Error('directory flush failed'); };
    const result = writeConsultSettings({ ...UPDATE, enabled: false, expectedRevision: 1 }, { env });
    expect(result).toMatchObject({ ok: true, publishedDespiteError: true, settings: { revision: 2, enabled: false } });
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { revision: 2, enabled: false } });
    __consultSettingsWriterTestHooks.afterPublish = undefined;
    // A failure before the publish is "nothing changed", and says so.
    chmodSync(join(home, '.olympus'), 0o500);
    const before = writeConsultSettings({ ...UPDATE, enabled: true, expectedRevision: 2 }, { env });
    chmodSync(join(home, '.olympus'), 0o700);
    if (!before.ok) expect(['write_failed', 'directory_custody']).toContain(before.reason);
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { revision: before.ok ? 3 : 2 } });
  });

  test('a lease release that throws after the publish is reported from the file, never as "nothing changed"', () => {
    const home = tempHome();
    const env = { HOME: home };
    expect(writeConsultSettings(UPDATE, { env }).ok).toBe(true);
    const lockPath = `${settingsFile(home)}.lock`;
    // After the publish the lock file becomes a directory: the release's read
    // of its own record throws (not ENOENT), and so does the release.
    __consultSettingsWriterTestHooks.afterPublish = () => {
      rmSync(lockPath, { force: true });
      mkdirSync(lockPath);
    };
    const result = writeConsultSettings({ ...UPDATE, enabled: false, expectedRevision: 1 }, { env });
    __consultSettingsWriterTestHooks.afterPublish = undefined;
    rmSync(lockPath, { recursive: true, force: true });
    expect(result).toMatchObject({ ok: true, publishedDespiteError: true, settings: { revision: 2, enabled: false } });
    expect(readConsultSettings({ env })).toMatchObject({ state: 'valid', settings: { revision: 2, enabled: false } });
    // The next write works once the lock is gone.
    expect(writeConsultSettings({ ...UPDATE, expectedRevision: 2 }, { env })).toMatchObject({ ok: true, settings: { revision: 3 } });
  });

  test('an explicit path wins over HOME, like the reader', () => {
    const home = tempHome();
    mkdirSync(join(home, 'elsewhere'), { mode: 0o700 });
    const path = join(home, 'elsewhere', 'consult.json');
    const result = writeConsultSettings(UPDATE, { path, env: { HOME: join(home, 'unused') } });
    expect(result.ok).toBe(true);
    expect(readConsultSettings({ path }).state).toBe('valid');
    expect(existsSync(join(home, 'unused'))).toBe(false);
  });
});

describe('writeConsultSettings: refusals', () => {
  test('HOME absent, empty or relative: refused, nothing created anywhere, no fallback to the OS home', () => {
    for (const env of [{}, { HOME: '' }, { HOME: '   ' }, { HOME: 'relative/home' }]) {
      expect(writeConsultSettings(UPDATE, { env })).toEqual({ ok: false, reason: 'no_home' });
    }
    expect(existsSync(join('relative/home', '.olympus'))).toBe(false);
  });

  test('a HOME that does not exist is refused rather than created', () => {
    const home = join(tempHome(), 'nowhere');
    expect(writeConsultSettings(UPDATE, { env: { HOME: home } })).toEqual({ ok: false, reason: 'home_missing' });
    expect(existsSync(home)).toBe(false);
  });

  test('invalid input never reaches the disk: empty, unknown or duplicated languages, a bad expected revision', () => {
    const home = tempHome();
    const env = { HOME: home };
    const cases: ConsultSettingsWriteInput[] = [
      { ...UPDATE, languages: [] },
      { ...UPDATE, languages: ['en', 'xx' as never] },
      { ...UPDATE, languages: ['en', 'en'] },
      { ...UPDATE, expectedRevision: -1 },
      { ...UPDATE, expectedRevision: 1.5 },
      { ...UPDATE, domains: { ...UPDATE.domains, extra: true } as never },
    ];
    for (const input of cases) {
      expect(writeConsultSettings(input, { env })).toEqual({ ok: false, reason: 'invalid_input' });
    }
    expect(existsSync(join(home, '.olympus'))).toBe(false);
  });

  test('an invalid current file is refused unless replaceInvalid is given; then it is replaced at the next revision', () => {
    const home = tempHome();
    const env = { HOME: home };
    mkdirSync(join(home, '.olympus'), { mode: 0o700 });
    writeFileSync(settingsFile(home), '{"v":1,"revision":4,"enabled":true', { mode: 0o600 });
    const refused = writeConsultSettings({ ...UPDATE, expectedRevision: 0 }, { env });
    expect(refused).toMatchObject({ ok: false, reason: 'invalid_current', invalidReason: 'malformed_json', current: { state: 'invalid' } });
    expect(readFileSync(settingsFile(home), 'utf8')).toBe('{"v":1,"revision":4,"enabled":true');
    // The same with every other reader reason: a duplicate key, a wrong shape.
    writeFileSync(settingsFile(home), '{"v":1,"revision":4,"enabled":false,"enabled":true,"languages":["en"],"domains":{"units":true,"countries":true,"places":true,"technical":true,"medicines":true,"medicineBrands":false},"strict":false}', { mode: 0o600 });
    expect(writeConsultSettings({ ...UPDATE, expectedRevision: 4 }, { env })).toMatchObject({ ok: false, reason: 'invalid_current', invalidReason: 'duplicate_key' });
    const replaced = writeConsultSettings({ ...UPDATE, expectedRevision: 0, replaceInvalid: true }, { env });
    expect(replaced).toMatchObject({ ok: true, settings: { revision: 1, enabled: true } });
    expect(readConsultSettings({ env }).state).toBe('valid');
  });

  test('a file another account could write (insecure permissions) is invalid to the reader and is not overwritten without replaceInvalid', () => {
    const home = tempHome();
    const env = { HOME: home };
    expect(writeConsultSettings(UPDATE, { env }).ok).toBe(true);
    chmodSync(settingsFile(home), 0o666);
    const refused = writeConsultSettings({ ...UPDATE, expectedRevision: 1 }, { env });
    expect(refused).toMatchObject({ ok: false, reason: 'invalid_current', invalidReason: 'insecure_permissions' });
    expect(statSync(settingsFile(home)).mode & 0o777).toBe(0o666);
    // Replacing it restores owner-only mode.
    const replaced = writeConsultSettings({ ...UPDATE, expectedRevision: 0, replaceInvalid: true }, { env });
    expect(replaced.ok).toBe(true);
    expect(statSync(settingsFile(home)).mode & 0o777).toBe(0o600);
  });

  test('directory custody: a symlinked ~/.olympus is refused and never written through', () => {
    const home = tempHome();
    const real = join(home, 'real-olympus');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(home, '.olympus'));
    expect(writeConsultSettings(UPDATE, { env: { HOME: home } })).toEqual({ ok: false, reason: 'directory_symlink' });
    expect(readdirSync(real)).toEqual([]);
    expect(lstatSync(join(home, '.olympus')).isSymbolicLink()).toBe(true);
  });

  test('directory custody: group- or other-accessible, or not a directory, is refused with nothing written', () => {
    for (const mode of [0o750, 0o705, 0o755, 0o770]) {
      const home = tempHome();
      mkdirSync(join(home, '.olympus'), { mode });
      chmodSync(join(home, '.olympus'), mode);
      expect(writeConsultSettings(UPDATE, { env: { HOME: home } })).toEqual({ ok: false, reason: 'directory_custody' });
      expect(readdirSync(join(home, '.olympus'))).toEqual([]);
      // The mode is left as found: the writer repairs nothing it did not create.
      expect(statSync(join(home, '.olympus')).mode & 0o777).toBe(mode);
    }
    const home = tempHome();
    writeFileSync(join(home, '.olympus'), 'not a directory', { mode: 0o600 });
    expect(writeConsultSettings(UPDATE, { env: { HOME: home } })).toEqual({ ok: false, reason: 'directory_custody' });
    expect(readFileSync(join(home, '.olympus'), 'utf8')).toBe('not a directory');
  });

  test('a held lease is reported as busy at once, with nothing written; the write proceeds once it is released', () => {
    const home = tempHome();
    const env = { HOME: home };
    mkdirSync(join(home, '.olympus'), { mode: 0o700 });
    const path = settingsFile(home);
    // Hold the lease (the nested call is what a second process would be).
    withFileLeaseSync(path, () => {
      const started = Date.now();
      const busy = writeConsultSettings(UPDATE, { env });
      expect(busy).toEqual({ ok: false, reason: 'lease_busy' });
      // Bounded wait: the lease timeout plus slack, never a hang.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(existsSync(path)).toBe(false);
    }, { acquireTimeoutMs: 50, pollIntervalMs: 5, staleAfterMs: 60_000, heartbeatIntervalMs: 60_000 });
    expect(writeConsultSettings(UPDATE, { env }).ok).toBe(true);
  });

  test('the default settings are what a missing file means; the writer never writes them implicitly', () => {
    const home = tempHome();
    expect(readConsultSettings({ env: { HOME: home } })).toEqual({ state: 'absent', settings: DEFAULT_CONSULT_SETTINGS });
    expect(existsSync(join(home, '.olympus'))).toBe(false);
  });
});

// The writer is reachable from exactly one module, the Mac dashboard's
// Outside help adapter, which the product server wires into the worker as a
// backend object. Neither module may be reached from any hosted surface: the
// MCP tool surface, the ChatGPT setup tools and backend, the relay and the
// remote workers, the OpenClaw Control UI gateway, or the browser bundle.
describe('the writer stays off every hosted surface', () => {
  const WRITER = 'src/core/consult-settings-writer.ts';
  const ADAPTER = 'src/workers/email-source/dashboard-consult.ts';
  /** The only module that may import the writer (value import). */
  const WRITER_IMPORTERS: readonly string[] = [ADAPTER];
  /** The adapter's importers: the composition root (value) and the worker's option type (type-only). */
  const ADAPTER_VALUE_IMPORTERS: readonly string[] = ['src/workers/email-source/server.ts'];
  const ADAPTER_TYPE_IMPORTERS: readonly string[] = ['src/workers/email-source/index.ts'];
  /** Seeds: every hosted entry into the engine. None may reach the writer or the adapter. */
  const HOSTED_SEEDS: readonly string[] = [
    'src/workers/chatgpt/mcp-surface.ts',
    'src/workers/chatgpt/setup-tools.ts',
    'src/workers/chatgpt/setup-backend.ts',
    'src/workers/chatgpt/private-answer-jobs.ts',
    'src/workers/chatgpt/consult-orchestrator.ts',
    'src/workers/remote-mcp.ts',
    'src/workers/remote-openapi.ts',
    'src/workers/remote-access-control.ts',
    'src/core/control-ui-gateway.ts',
    'src/core/remote-relay-runtime.ts',
    'src/core/operations.ts',
    'src/control-ui.ts',
    'src/core/doctor.ts',
  ];

  function sourceFiles(dir: string): string[] {
    const root = join(repoRoot, dir);
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'generated') continue;
        const path = join(current, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(relative(repoRoot, path));
      }
    };
    walk(root);
    return out;
  }

  const IMPORT = /(?:^|[^\w])import\s*(type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g;

  /** Relative import specifiers of a file, resolved to repo-relative paths, with whether the statement is type-only. */
  function importsOf(file: string): Array<{ target: string; typeOnly: boolean }> {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    const out: Array<{ target: string; typeOnly: boolean }> = [];
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[2] ?? match[3] ?? match[4];
      if (!specifier || !specifier.startsWith('.')) continue;
      let target = relative(repoRoot, resolve(dirname(join(repoRoot, file)), specifier));
      if (!/\.(ts|tsx|js|mjs|json)$/.test(target)) target = `${target}.ts`;
      out.push({ target, typeOnly: match[1] !== undefined });
    }
    return out;
  }

  const ALL = [...sourceFiles('src'), ...sourceFiles('connect-relay'), ...sourceFiles('exchange'), ...sourceFiles('scripts')];

  test('exactly one module imports the writer, and exactly the composition root and the worker (type-only) import the adapter', () => {
    const writerImporters = ALL.filter((file) => file !== WRITER && importsOf(file).some((entry) => entry.target === WRITER));
    expect(writerImporters.sort()).toEqual([...WRITER_IMPORTERS].sort());
    for (const file of writerImporters) {
      expect(importsOf(file).filter((entry) => entry.target === WRITER).every((entry) => !entry.typeOnly)).toBe(true);
    }
    const adapterImporters = ALL.filter((file) => file !== ADAPTER && importsOf(file).some((entry) => entry.target === ADAPTER));
    expect(adapterImporters.sort()).toEqual([...ADAPTER_VALUE_IMPORTERS, ...ADAPTER_TYPE_IMPORTERS].sort());
    for (const file of ADAPTER_TYPE_IMPORTERS) {
      expect(importsOf(file).filter((entry) => entry.target === ADAPTER).every((entry) => entry.typeOnly)).toBe(true);
    }
  });

  test('no hosted entry reaches the writer or the adapter through the import graph (type-only edges excluded)', () => {
    for (const seed of HOSTED_SEEDS) {
      expect(existsSync(join(repoRoot, seed)), `seed ${seed} missing`).toBe(true);
      const seen = new Set<string>();
      const queue = [seed];
      while (queue.length > 0) {
        const file = queue.pop()!;
        if (seen.has(file) || !existsSync(join(repoRoot, file)) || !/\.(ts|tsx|js|mjs)$/.test(file)) continue;
        seen.add(file);
        for (const entry of importsOf(file)) if (!entry.typeOnly) queue.push(entry.target);
      }
      expect(seen.has(WRITER), `${seed} reaches the writer`).toBe(false);
      expect(seen.has(ADAPTER), `${seed} reaches the adapter`).toBe(false);
    }
  });

  test('the composition root reaches the adapter, so the product path exists', () => {
    expect(importsOf('src/workers/email-source/server.ts').some((entry) => entry.target === ADAPTER && !entry.typeOnly)).toBe(true);
  });
});
