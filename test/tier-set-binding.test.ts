// Where a store bound to a tiered store set looks for the set's ledger
// (classification/tier-set-binding.ts), and the layout rule it leans on.

import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { FOLDER_LAYOUT_SOURCES, accountSiblingStorePath, accountStorePath } from '../src/core/olympus-layout.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { findTierSetLedger, tierSetLedgerCandidates } from '../src/workers/classification/tier-set-binding.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-set-binding-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ledgerAt(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const ledger = new TierLedger({ dbPath: path });
  try {
    return ledger.ledgerId();
  } finally {
    ledger.close();
  }
}

describe('the sibling store of an account folder', () => {
  const root = '/anywhere/olympus/sources/dropbox.files/1/stores';

  test('swaps the tier and keeps the folder, wherever the data folder sits', () => {
    expect(accountSiblingStorePath(`${root}/internal.sqlite`, 'secure_local')).toBe(`${root}/secure_local.sqlite`);
    expect(accountSiblingStorePath(`${root}/public_safe.sqlite`, 'secure_local')).toBe(`${root}/secure_local.sqlite`);
    expect(accountSiblingStorePath(`${root}/secure_local.sqlite`, 'secure_local')).toBe(`${root}/secure_local.sqlite`);
    expect(accountSiblingStorePath(`${root}/secure_local.sqlite`, 'internal')).toBe(`${root}/internal.sqlite`);
    expect(accountSiblingStorePath('/mnt/other/place/sources/readwise.library/2/stores/internal.sqlite', 'secure_local'))
      .toBe('/mnt/other/place/sources/readwise.library/2/stores/secure_local.sqlite');
  });

  test('keeps an imported archive\'s family', () => {
    const archive = '/data/sources/archive.imports/1/stores';
    expect(accountSiblingStorePath(`${archive}/chat.public_safe.sqlite`, 'secure_local')).toBe(`${archive}/chat.secure_local.sqlite`);
    expect(accountSiblingStorePath(`${archive}/mail-2020.internal.sqlite`, 'secure_local')).toBe(`${archive}/mail-2020.secure_local.sqlite`);
  });

  test('says nothing about a path that is not a store of an account folder', () => {
    for (const path of [
      '/data/dropbox-files-internal-connector-store.sqlite',
      '/data/sources/dropbox.files/1/raw/internal.sqlite',
      '/data/stores/internal.sqlite',
      '/data/sources/dropbox.files/stores/internal.sqlite',
      '/data/sources/dropbox.files/1/stores/sub/internal.sqlite',
      '/data/other/dropbox.files/1/stores/internal.sqlite',
      '/data/sources/dropbox.files/1/stores/cache.sqlite',
      '/data/sources/dropbox.files/1/stores/internal.db',
      '/data/sources/dropbox.files/1/stores/internal.sqlite-wal',
      '/data/sources/dropbox.files/1/stores/internal.tier-ledger.sqlite',
      '/data/sources/dropbox.files/1/stores/a.b.internal.sqlite',
      '/data/sources/../1/stores/internal.sqlite',
      '/data/sources/dropbox.files/ /stores/internal.sqlite',
      ':memory:',
    ]) expect(accountSiblingStorePath(path, 'secure_local')).toBeUndefined();
  });

  test('names the secure store as the layout does, for every source and tier', () => {
    const env = { HOME: tempDir() };
    for (const sourceId of FOLDER_LAYOUT_SOURCES.filter((id) => id !== 'archive.imports')) {
      const account = { source_id: sourceId, slot: '1', layout: 'folder' } as const;
      for (const tier of ['secure_local', 'internal', 'public_safe'] as const) {
        expect(accountSiblingStorePath(accountStorePath(account, tier, env), 'secure_local')).toBe(accountStorePath(account, 'secure_local', env));
      }
    }
    const archive = { source_id: 'archive.imports', slot: '1', layout: 'folder' } as const;
    for (const tier of ['secure_local', 'internal', 'public_safe'] as const) {
      expect(accountSiblingStorePath(accountStorePath(archive, `chat.${tier}`, env), 'secure_local')).toBe(accountStorePath(archive, 'chat.secure_local', env));
    }
  });
});

describe('where a bound store looks for its ledger', () => {
  test('the recorded path first, then the folder\'s secure ledger, then the recorded name beside the store', () => {
    expect(tierSetLedgerCandidates('/data/sources/dropbox.files/1/stores/internal.sqlite', '/old/dropbox-files-connector-store.tier-ledger.sqlite'))
      .toEqual([
        '/old/dropbox-files-connector-store.tier-ledger.sqlite',
        '/data/sources/dropbox.files/1/stores/secure_local.tier-ledger.sqlite',
        '/data/sources/dropbox.files/1/stores/dropbox-files-connector-store.tier-ledger.sqlite',
      ]);
    expect(tierSetLedgerCandidates('/data/dropbox-files-internal-connector-store.sqlite', '/old/dropbox-files-connector-store.tier-ledger.sqlite'))
      .toEqual(['/old/dropbox-files-connector-store.tier-ledger.sqlite', '/data/dropbox-files-connector-store.tier-ledger.sqlite']);
  });

  test('lists a place once, and looks nowhere else for an in-memory store or ledger', () => {
    expect(tierSetLedgerCandidates('/data/a.sqlite', '/data/a.tier-ledger.sqlite')).toEqual(['/data/a.tier-ledger.sqlite']);
    expect(tierSetLedgerCandidates(':memory:', '/data/a.tier-ledger.sqlite')).toEqual(['/data/a.tier-ledger.sqlite']);
    expect(tierSetLedgerCandidates('/data/a.sqlite', ':memory:')).toEqual([':memory:']);
  });

  test('accepts a candidate only when its id is the bound one, and passes over the others', () => {
    const dir = tempDir();
    const store = join(dir, 'sources', 'dropbox.files', '1', 'stores', 'internal.sqlite');
    const folderLedger = tierLedgerPathForStore(join(dir, 'sources', 'dropbox.files', '1', 'stores', 'secure_local.sqlite'));
    const recorded = join(dir, 'old', 'set.tier-ledger.sqlite');
    const folderId = ledgerAt(folderLedger);
    const recordedId = ledgerAt(recorded);
    expect(recordedId).not.toBe(folderId);

    expect(findTierSetLedger(store, { ledgerId: recordedId, ledgerPath: recorded })).toBe(recorded);
    expect(findTierSetLedger(store, { ledgerId: folderId, ledgerPath: recorded })).toBe(folderLedger);
    expect(findTierSetLedger(store, { ledgerId: 'ffffffffffffffffffffffffffffffff', ledgerPath: recorded })).toBeUndefined();
    expect(findTierSetLedger(store, { ledgerId: folderId, ledgerPath: join(dir, 'gone.tier-ledger.sqlite') })).toBe(folderLedger);
  });
});

describe('reading a ledger\'s identity', () => {
  test('creates nothing and changes nothing', () => {
    const dir = tempDir();
    const missing = join(dir, 'missing.tier-ledger.sqlite');
    expect(TierLedger.readLedgerId(missing)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);

    const path = join(dir, 'set.tier-ledger.sqlite');
    const id = ledgerAt(path);
    const before = { sha: createHash('sha256').update(readFileSync(path)).digest('hex'), mtimeMs: statSync(path).mtimeMs };
    expect(TierLedger.readLedgerId(path)).toBe(id);
    expect(TierLedger.readLedgerId(path)).toBe(id);
    expect({ sha: createHash('sha256').update(readFileSync(path)).digest('hex'), mtimeMs: statSync(path).mtimeMs }).toEqual(before);
  });

  test('reads a ledger whose -wal is gone, which a read-only connection cannot open on macOS', () => {
    const dir = tempDir();
    const path = join(dir, 'set.tier-ledger.sqlite');
    const id = ledgerAt(path);
    for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    expect(TierLedger.readLedgerId(path)).toBe(id);
  });

  test('has no identity for what is not a ledger, and never migrates it', () => {
    const dir = tempDir();
    const empty = join(dir, 'empty.sqlite');
    writeFileSync(empty, '');
    expect(TierLedger.readLedgerId(empty)).toBeUndefined();
    expect(statSync(empty).size).toBe(0);

    const other = join(dir, 'other.sqlite');
    const db = new Database(other);
    db.exec('CREATE TABLE notes (a TEXT); INSERT INTO notes VALUES (\'x\');');
    db.close();
    expect(TierLedger.readLedgerId(other)).toBeUndefined();
    const check = new Database(other, { readonly: true });
    expect(check.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: 'notes' }]);
    check.close();

    const garbage = join(dir, 'garbage.sqlite');
    writeFileSync(garbage, 'this is not a database'.repeat(100));
    expect(TierLedger.readLedgerId(garbage)).toBeUndefined();
    expect(existsSync(`${garbage}-wal`)).toBe(false);
  });
});

describe('reading a ledger\'s identity leaves the ledger file as it was', () => {
  const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

  test('a ledger a crash left with frames in its -wal keeps its main file and its frames', () => {
    const dir = tempDir();
    const live = join(dir, 'live', 'set.tier-ledger.sqlite');
    const id = ledgerAt(live);
    const writer = new TierLedger({ dbPath: live });
    const crashed = join(dir, 'crashed', 'set.tier-ledger.sqlite');
    try {
      writer.writeMeta('resume_point', 'written-before-the-crash');
      // What a crash leaves behind: the main file and the -wal as they are while the writer still has them open.
      mkdirSync(dirname(crashed), { recursive: true });
      copyFileSync(live, crashed);
      copyFileSync(`${live}-wal`, `${crashed}-wal`);
    } finally {
      writer.close();
    }
    expect(statSync(`${crashed}-wal`).size).toBeGreaterThan(0);
    const before = { main: sha(crashed), wal: sha(`${crashed}-wal`), walSize: statSync(`${crashed}-wal`).size };

    expect(TierLedger.readLedgerId(crashed)).toBe(id);
    expect(TierLedger.readLedgerId(crashed)).toBe(id);

    // Nothing was merged into the main file and the -wal was not truncated (an -shm may have appeared).
    expect({ main: sha(crashed), wal: sha(`${crashed}-wal`), walSize: statSync(`${crashed}-wal`).size }).toEqual(before);
    // What the frames held is still there to be recovered by whoever opens the ledger next.
    const reopened = new TierLedger({ dbPath: crashed });
    try {
      expect(reopened.readMeta('resume_point')).toBe('written-before-the-crash');
    } finally {
      reopened.close();
    }
  });

  test('a missing path, an empty file and files that are not ledgers create nothing in their folder and change nothing', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'empty.sqlite'), '');
    writeFileSync(join(dir, 'garbage.sqlite'), 'this is not a database'.repeat(100));
    const other = new Database(join(dir, 'other.sqlite'));
    other.exec('CREATE TABLE notes (a TEXT); INSERT INTO notes VALUES (\'x\');');
    other.close();
    const folder = (): Record<string, string> => Object.fromEntries(readdirSync(dir).sort().map((name) => [name, sha(join(dir, name))]));
    const before = folder();

    for (const name of ['missing.sqlite', 'empty.sqlite', 'garbage.sqlite', 'other.sqlite']) {
      expect(TierLedger.readLedgerId(join(dir, name))).toBeUndefined();
    }
    expect(folder()).toEqual(before);
  });

  test('a ledger held exclusively is given up on after one wait, not one for each way of opening it', () => {
    const dir = tempDir();
    const path = join(dir, 'set.tier-ledger.sqlite');
    ledgerAt(path);
    const holder = new Database(path);
    holder.exec(`PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; INSERT OR REPLACE INTO tier_ledger_meta (key, value) VALUES ('held', '1');`);
    try {
      const started = performance.now();
      expect(TierLedger.readLedgerId(path, { busyTimeoutMs: 600 })).toBeUndefined();
      const took = performance.now() - started;
      expect(took).toBeGreaterThanOrEqual(500);
      expect(took).toBeLessThan(1000);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});
