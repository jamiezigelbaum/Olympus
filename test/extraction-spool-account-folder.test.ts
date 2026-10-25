// Where a file reader's scratch files go (docs/design/source-storage.md,
// "Layout"; docs/design/child-items.md, "Removal"). They hold raw bytes (a
// recording, a part of a message), so an account keeps them in its own folder,
// `raw/extraction-spool`, where a Delete of the account takes them with the
// folder. Only an account that lives in the legacy layout uses the folder every
// legacy account shares, and only for it does the forget step look there.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { accountExtractionSpoolRoot, accountFolder, extractionSpoolRoot } from '../src/core/olympus-layout.ts';
import { extractionSpoolPlacementForCorpus, extractionSpoolRootForCorpus, placedAccount, resolvedStorePath } from '../src/core/source-placement.ts';
import { updateSourceRegistry } from '../src/core/source-registry.ts';
import { deleteOlympusData } from '../src/data-lifecycle.ts';
import { DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID } from '../src/workers/dropbox-files/connector-store.ts';
import { readItemToFile } from '../src/workers/file-extraction/connector-source.ts';
import { extractionSpoolOwnerDir, prepareExtractionSpool } from '../src/workers/file-extraction/spool.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

type Env = Record<string, string>;

function fixture(): { homeDir: string; env: Env } {
  const base = mkdtempSync(join(tmpdir(), 'extraction-spool-account-'));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  return {
    homeDir,
    env: { HOME: homeDir, XDG_DATA_HOME: join(homeDir, '.local', 'share'), XDG_STATE_HOME: join(homeDir, '.local', 'state'), PATH: process.env.PATH ?? '' },
  };
}

function record(env: Env, sourceId: string, layout: 'legacy' | 'folder', corpusIds: string[] = []): void {
  updateSourceRegistry(env, (registry) => {
    registry.accounts.push({ source_id: sourceId, slot: '1', state: 'active', layout, corpus_ids: corpusIds, created_at: '2026-10-25T00:00:00.000Z' });
  });
}

function put(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  writeFileSync(path, 'raw recording bytes', { mode: 0o600 });
  return path;
}

const DROPBOX = { corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID, trustDomain: 'secure_local' };

describe('where a corpus\'s scratch files go', () => {
  test('an account in its folder with its store there: raw/extraction-spool in the folder', () => {
    const { env } = fixture();
    record(env, 'dropbox.files', 'folder');
    const storePath = resolvedStorePath('dropbox.files', 'secure_local', env);
    const expected = join(accountFolder({ source_id: 'dropbox.files', slot: '1' }, env), 'raw', 'extraction-spool');
    expect(extractionSpoolRootForCorpus({ ...DROPBOX, storePath }, env)).toBe(expected);
    expect(accountExtractionSpoolRoot(placedAccount('dropbox.files', env), env)).toBe(expected);
  });

  test('an imported archive\'s corpus, of any family, belongs to the archive account', () => {
    const { env } = fixture();
    record(env, 'archive.imports', 'folder');
    const root = extractionSpoolRootForCorpus({ corpusId: 'secure_local.archive.mail', trustDomain: 'secure_local' }, env);
    expect(root).toBe(join(accountFolder({ source_id: 'archive.imports', slot: '1' }, env), 'raw', 'extraction-spool'));
  });

  test('a store held in memory or outside the folder, a legacy account and a corpus no account owns keep the shared spool', () => {
    const { env } = fixture();
    const shared = extractionSpoolRoot(env);
    record(env, 'dropbox.files', 'folder');
    expect(extractionSpoolRootForCorpus({ ...DROPBOX, storePath: ':memory:' }, env)).toBe(shared);
    expect(extractionSpoolRootForCorpus({ ...DROPBOX, storePath: join(tmpdir(), 'somewhere-else', 'store.sqlite') }, env)).toBe(shared);
    expect(extractionSpoolRootForCorpus({ corpusId: 'internal.operator.notes', trustDomain: 'internal', storePath: ':memory:' }, env)).toBe(shared);

    const legacy = fixture();
    record(legacy.env, 'dropbox.files', 'legacy');
    expect(extractionSpoolRootForCorpus({ ...DROPBOX, storePath: resolvedStorePath('dropbox.files', 'secure_local', legacy.env) }, legacy.env))
      .toBe(extractionSpoolRoot(legacy.env));
  });
});

describe('Delete of an account', () => {
  test('in its folder takes its scratch files with the folder, and the forget step reports none of its own', () => {
    const { homeDir, env } = fixture();
    record(env, 'readwise.library', 'folder');
    const spool = accountExtractionSpoolRoot(placedAccount('readwise.library', env), env);
    const file = put(extractionSpoolOwnerDir(spool, { corpusId: 'internal.readwise.library', accountScope: 'x' }), 'spool-1-1-a');
    const beside = put(extractionSpoolOwnerDir(extractionSpoolRoot(env), { corpusId: 'internal.other', accountScope: 'x' }), 'spool-1-1-o');

    const preview = deleteOlympusData({ sourceId: 'readwise.library', homeDir, env, dryRun: true });
    expect(preview.forgotten?.join('\n') ?? '').not.toContain('scratch files');
    expect(existsSync(file)).toBe(true);

    const result = deleteOlympusData({ sourceId: 'readwise.library', homeDir, env });
    expect(result.forgotten?.join('\n') ?? '').not.toContain('scratch files');
    expect(existsSync(accountFolder({ source_id: 'readwise.library', slot: '1' }, env))).toBe(false);
    expect(existsSync(file)).toBe(false);
    // Another account's scratch files, wherever they are, are not its to take.
    expect(existsSync(beside)).toBe(true);
  });

  test('in the legacy layout forgets its scratch files from the shared spool, and only its own corpora\'s', () => {
    const { homeDir, env } = fixture();
    record(env, 'readwise.library', 'legacy', ['internal.readwise.library']);
    const shared = extractionSpoolRoot(env);
    const mine = put(extractionSpoolOwnerDir(shared, { corpusId: 'internal.readwise.library', accountScope: 'x' }), 'spool-1-1-a');
    const other = put(extractionSpoolOwnerDir(shared, { corpusId: 'internal.other', accountScope: 'x' }), 'spool-1-1-o');

    const preview = deleteOlympusData({ sourceId: 'readwise.library', homeDir, env, dryRun: true });
    expect(preview.forgotten?.join('\n')).toContain('scratch files: 1');
    expect(existsSync(mine)).toBe(true);

    const result = deleteOlympusData({ sourceId: 'readwise.library', homeDir, env });
    expect(result.forgotten?.join('\n')).toContain('scratch files: 1');
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});

describe('a read under a running worker', () => {
  /** A connector that answers every read with a few bytes, and nothing else. */
  const connector = {
    async fetchItem() {
      return { content: { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/ogg' } } as unknown as RawItem;
    },
  } as unknown as SourceConnector;

  test('makes the spool on its first write, below the account\'s folder, owner-only', async () => {
    const { env } = fixture();
    record(env, 'readwise.library', 'folder');
    const folder = accountFolder({ source_id: 'readwise.library', slot: '1' }, env);
    mkdirSync(folder, { recursive: true });
    const root = accountExtractionSpoolRoot(placedAccount('readwise.library', env), env);
    const owner = extractionSpoolOwnerDir(root, { corpusId: 'internal.readwise.library', accountScope: 'x' });
    expect(existsSync(join(folder, 'raw'))).toBe(false);

    const read = await readItemToFile(connector, 'x:item', { spoolDir: owner, spoolAnchor: folder });

    expect(read.spooled).toBe(true);
    expect(read.path.startsWith(`${root}/`)).toBe(true);
    expect(existsSync(read.path)).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(owner).mode & 0o777).toBe(0o700);
  });

  test('does not bring back an account\'s folder that a Delete removed under it, and writes no bytes', async () => {
    const { env } = fixture();
    record(env, 'readwise.library', 'folder');
    const folder = accountFolder({ source_id: 'readwise.library', slot: '1' }, env);
    const root = accountExtractionSpoolRoot(placedAccount('readwise.library', env), env);
    const owner = extractionSpoolOwnerDir(root, { corpusId: 'internal.readwise.library', accountScope: 'x' });
    expect(existsSync(folder)).toBe(false);

    await expect(readItemToFile(connector, 'x:item', { spoolDir: owner, spoolAnchor: folder })).rejects.toThrow();

    expect(existsSync(folder)).toBe(false);
  });

  test('a shared (legacy) spool is made whole on the first write', async () => {
    const { env } = fixture();
    const shared = extractionSpoolRoot(env);
    const owner = extractionSpoolOwnerDir(shared, { corpusId: 'internal.readwise.library', accountScope: 'x' });
    expect(existsSync(shared)).toBe(false);

    const read = await readItemToFile(connector, 'x:item', { spoolDir: owner });

    expect(existsSync(read.path)).toBe(true);
  });

  test('preparing a spool that is not there makes nothing', () => {
    const { env } = fixture();
    record(env, 'readwise.library', 'folder');
    const folder = accountFolder({ source_id: 'readwise.library', slot: '1' }, env);
    mkdirSync(folder, { recursive: true });
    const root = accountExtractionSpoolRoot(placedAccount('readwise.library', env), env);

    expect(prepareExtractionSpool(root)).toBe(root);

    expect(readdirSync(folder)).toEqual([]);
  });

  test('says where the account\'s folder is for a corpus in a folder, and nothing for a legacy one', () => {
    const { env } = fixture();
    record(env, 'dropbox.files', 'folder');
    const storePath = resolvedStorePath('dropbox.files', 'secure_local', env);
    const folder = accountFolder({ source_id: 'dropbox.files', slot: '1' }, env);
    expect(extractionSpoolPlacementForCorpus({ ...DROPBOX, storePath }, env).anchor).toBe(folder);
    expect(extractionSpoolPlacementForCorpus({ ...DROPBOX, storePath: ':memory:' }, env).anchor).toBeUndefined();
  });

  test('refuses, leaving no file, once what it reads is no longer served', async () => {
    const { env } = fixture();
    const shared = extractionSpoolRoot(env);
    const owner = extractionSpoolOwnerDir(shared, { corpusId: 'internal.readwise.library', accountScope: 'x' });

    // Retired before the folder is made: nothing is made.
    await expect(readItemToFile(connector, 'x:item', { spoolDir: owner, stillServed: () => false })).rejects.toThrow();
    expect(existsSync(shared)).toBe(false);

    // Retired while the bytes were being written: the file is taken back.
    let asked = 0;
    await expect(readItemToFile(connector, 'x:item', { spoolDir: owner, stillServed: () => (asked += 1) === 1 })).rejects.toThrow();
    expect(asked).toBe(2);
    expect(existsSync(owner)).toBe(false);
  });
});
