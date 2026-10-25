/**
 * Picture holds are keyed by who a store is, not where its file sits
 * (docs/design/source-storage.md, "Shared files"; src/core/store-identity.ts).
 *
 * Renaming a store into its account folder (delivery step 4c) must keep every
 * picture held and leak none, with no call into the media cache. The expected
 * markers here are written out from the design (a path marker is the first 32
 * hex digits of the SHA-256 of the store's real path and contains that path),
 * not read back from the implementation, so a fixture "written the old way" is
 * what the build before this change left on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { deleteOlympusData } from '../src/data-lifecycle.ts';
import {
  MEDIA_CACHE_DIR_ENV,
  releaseMediaCacheFile,
  retainMediaCacheFile,
  sweepMediaCache,
  writeMediaCacheFile,
} from '../src/core/media-cache.ts';
import { accountStorePath } from '../src/core/olympus-layout.ts';
import { sourceRegistryPath, updateSourceRegistry, type SourceRegistryAccountLayout, type SourceRegistryAccountState } from '../src/core/source-registry.ts';
import { openConnectorStore } from '../src/core/source-storage.ts';
import { placedStoreHolder } from '../src/core/store-identity.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
import { IMAGE_MEDIA_DESCRIPTOR } from '../src/workers/file-extraction/extractors/text.ts';
import type { ExtractionSinkRequest } from '../src/workers/file-extraction/types.ts';
import { DeterministicSourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

type Env = Record<string, string | undefined>;
type StoreOf = 'local.files' | 'dropbox.files' | 'telegram.messages';

const THREE_DAYS = 3 * 24 * 60 * 60_000;

let base: string;
let env: Env;
let cache: string;
let previous: Env;
const open: LocalConnectorStore[] = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'olympus-media-identity-')));
  cache = join(base, 'cache', 'media-cache');
  env = { HOME: base, XDG_DATA_HOME: join(base, 'data') };
  // The store's own hourly sweep and the lifecycle read the process environment.
  previous = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, [MEDIA_CACHE_DIR_ENV]: process.env[MEDIA_CACHE_DIR_ENV] };
  process.env.HOME = base;
  process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
  process.env[MEDIA_CACHE_DIR_ENV] = join(base, 'cache');
});

afterEach(() => {
  for (const store of open.splice(0)) {
    try {
      store.close();
    } catch {
      // Closed already.
    }
  }
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

// --- Fixtures ----------------------------------------------------------------

function account(sourceId: StoreOf, layout: SourceRegistryAccountLayout, state: SourceRegistryAccountState = 'active'): void {
  updateSourceRegistry(env, (registry) => {
    registry.accounts.push({ source_id: sourceId, slot: '1', state, layout, corpus_ids: [], created_at: '2026-10-25T00:00:00.000Z' });
  });
}

function setAccount(sourceId: StoreOf, change: { layout?: SourceRegistryAccountLayout; state?: SourceRegistryAccountState }): void {
  updateSourceRegistry(env, (registry) => {
    const entry = registry.accounts.find((candidate) => candidate.source_id === sourceId)!;
    Object.assign(entry, change);
  });
}

function dropAccount(sourceId: StoreOf): void {
  updateSourceRegistry(env, (registry) => {
    registry.accounts = registry.accounts.filter((candidate) => candidate.source_id !== sourceId);
  });
}

function storeFile(sourceId: StoreOf, layout: SourceRegistryAccountLayout, tier = 'secure_local'): string {
  return accountStorePath({ source_id: sourceId, slot: '1', layout }, tier, env);
}

const corpusOf = (sourceId: StoreOf): string => `secure_local.${sourceId}`;

/** Prepared-JPEG bytes, distinct per seed. */
function jpeg(seed: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, seed & 0xff, (seed >> 8) & 0xff, (seed >> 16) & 0xff, 7]);
}

function photoItem(id: string): RawItem {
  return {
    identity: { family: 'file', provider: 'fake', accountScope: 'personal', providerItemId: id, localItemId: `local:${id}`, sourceVersion: 'rev-1' },
    mimeType: 'image/jpeg',
    content: { kind: 'metadata_only' },
    metadata: { name: `${id}.jpg`, pathDisplay: `/Photos/${id}.jpg` },
    fetchedAt: '2026-10-07T00:00:00.000Z',
  };
}

function connectorFor(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'fake-metadata-sync',
    family: 'file',
    async authenticate() {},
    async *listItems(): AsyncIterable<SourceConnectorListPage> {
      yield { items, done: true };
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      return items.find((item) => item.identity.localItemId === localItemId)!;
    },
    classificationSignals: () => ({}),
  };
}

/** A store the way the build before this change opened every store: by path, no storage service. */
function pathHeldStore(sourceId: StoreOf, dbPath: string): LocalConnectorStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new LocalConnectorStore({ dbPath, corpusId: corpusOf(sourceId), family: 'file', trustDomain: 'secure_local', tierLedger: null });
  open.push(store);
  return store;
}

/** A store opened through the storage service, as the worker opens it. */
function serviceStore(sourceId: StoreOf, dbPath: string): LocalConnectorStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = openConnectorStore({ sourceId }, { dbPath, corpusId: corpusOf(sourceId), family: 'file', trustDomain: 'secure_local', tierLedger: null }, env);
  open.push(store);
  return store;
}

function closeStore(store: LocalConnectorStore): void {
  store.close();
  open.splice(open.indexOf(store), 1);
  // SQLite on macOS refuses to open a file that was moved while a connection to
  // it was still alive in this process; the real migration runs in a process
  // that has opened nothing.
  Bun.gc(true);
}

/** What the runner and the sink do for one prepared picture. */
async function landPicture(store: LocalConnectorStore, seed: number, id = 'photo-1') {
  await store.syncFromConnector(connectorFor([photoItem(id)]), { fetchContent: false });
  const written = writeMediaCacheFile(cache, jpeg(seed), 'image/jpeg');
  const media = { path: written.path, sha256: written.sha256, mimeType: 'image/jpeg' as const };
  const request: ExtractionSinkRequest = {
    ref: {
      corpusId: store.corpusId,
      provider: 'fake',
      accountScope: 'personal',
      approvedScopeKey: 'scope',
      providerItemId: id,
      localItemId: `local:${id}`,
      sourceVersion: 'rev-1',
      name: `${id}.jpg`,
      mimeType: 'image/jpeg',
    },
    text: IMAGE_MEDIA_DESCRIPTOR,
    extractorKind: 'local_text',
    extractorVersion: '1',
    fetchedAt: '2026-10-07T01:00:00.000Z',
    media,
  };
  const sink = createConnectorStoreExtractionSink({
    store,
    classify: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
    syncConnectorId: 'extraction',
    ownerConnectorId: 'fake-connector',
    ownershipKind: 'observed',
  });
  await sink.accept(request);
  releaseMediaCacheFile(written.path, written.sha256, written.stagingHolder);
  return media;
}

/** A store's pictures held again, as every embed pass does first. */
async function reassert(store: LocalConnectorStore): Promise<void> {
  await store.embedChunks({ provider: new DeterministicSourceEmbeddingProvider({ dimension: 8 }) });
}

/** The marker the build before this change wrote for a store: a digest of its real path, holding that path. */
function oldMarker(storePath: string): { name: string; text: string } {
  const real = realpathSync(storePath);
  return { name: createHash('sha256').update(real).digest('hex').slice(0, 32), text: real };
}

function markers(media: { path: string }): Record<string, string> {
  const refs = `${media.path}.refs`;
  if (!existsSync(refs)) return {};
  return Object.fromEntries(readdirSync(refs).map((name) => [name, statSync(join(refs, name)).isFile() ? readFileSync(join(refs, name), 'utf8') : '<folder>']));
}

const identityMarkers = (media: { path: string }) => Object.keys(markers(media)).filter((name) => name.startsWith('store-'));
const pathMarkers = (media: { path: string }) => Object.keys(markers(media)).filter((name) => /^[0-9a-f]{32}$/.test(name));

/** A sweep that treats everything with no live holder as long abandoned. */
function sweep(sweepEnv: Env = env): number {
  return sweepMediaCache(cache, { now: Date.now() + THREE_DAYS, env: sweepEnv });
}

/** Moves a store's file, as the migration into account folders will: a rename of it and its `-wal` and `-shm`, and nothing else. */
function renameStore(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${from}${suffix}`)) renameSync(`${from}${suffix}`, `${to}${suffix}`);
  }
}

// --- Identity ----------------------------------------------------------------

describe('a store the registry places is held by who it is', () => {
  test('its marker names the account and the store, not the path', async () => {
    account('local.files', 'legacy');
    const dbPath = storeFile('local.files', 'legacy');
    const store = serviceStore('local.files', dbPath);
    const media = await landPicture(store, 1);

    const held = markers(media);
    const names = Object.keys(held);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^store-[0-9a-f]{32}$/);
    const marker = JSON.parse(held[names[0]!]!);
    expect(marker).toMatchObject({ sourceId: 'local.files', slot: '1', store: 'secure_local' });
    // The path is only a hint of where the file was seen.
    expect(marker.seen).toBe(realpathSync(dbPath));
    expect(marker.registry).toBe(sourceRegistryPath(env));
    // And the name is the same wherever the file sits.
    closeStore(store);
    renameStore(dbPath, storeFile('local.files', 'folder'));
    setAccount('local.files', { layout: 'folder' });
    const moved = serviceStore('local.files', storeFile('local.files', 'folder'));
    await reassert(moved);
    expect(identityMarkers(media)).toEqual(names);
  });

  test('a store opened outside the registry\'s placement keeps a path holder, exactly as before', async () => {
    account('local.files', 'legacy');
    const elsewhere = join(base, 'operator', 'local-files.sqlite');
    const store = serviceStore('local.files', elsewhere);
    const media = await landPicture(store, 2);
    const old = oldMarker(elsewhere);
    expect(markers(media)).toEqual({ [old.name]: old.text });
    // A source the registry does not place at all, and an account with no entry, likewise.
    expect(placedStoreHolder({ sourceId: 'reflect.notes' }, { dbPath: join(base, 'reflect.sqlite'), family: 'note', trustDomain: 'secure_local' }, env)).toBeUndefined();
    expect(placedStoreHolder({ sourceId: 'dropbox.files' }, { dbPath: storeFile('dropbox.files', 'legacy'), family: 'file', trustDomain: 'secure_local' }, env)).toBeUndefined();
    expect(placedStoreHolder({ sourceId: 'local.files' }, { dbPath: ':memory:', family: 'file', trustDomain: 'secure_local' }, env)).toBeUndefined();
    // An account being deleted has no holder to take.
    account('dropbox.files', 'legacy', 'deleting');
    expect(placedStoreHolder({ sourceId: 'dropbox.files' }, { dbPath: storeFile('dropbox.files', 'legacy'), family: 'file', trustDomain: 'secure_local' }, env)).toBeUndefined();
  });

  test('imported archives name a store by family and tier', () => {
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push({ source_id: 'archive.imports', slot: '1', state: 'active', layout: 'folder', corpus_ids: [], created_at: '2026-10-25T00:00:00.000Z' });
    });
    const dbPath = accountStorePath({ source_id: 'archive.imports', slot: '1', layout: 'folder' }, 'chat.secure_local', env);
    const holder = placedStoreHolder({ sourceId: 'archive.imports' }, { dbPath, family: 'chat', trustDomain: 'secure_local' }, env);
    expect(holder?.identity).toEqual({ sourceId: 'archive.imports', slot: '1', store: 'chat.secure_local' });
  });
});

// --- Renaming a store --------------------------------------------------------

describe('renaming a store into its account folder', () => {
  test.each(['rename then flip the layout', 'flip the layout then rename'] as const)('keeps every picture across a sweep at every point (%s)', async (order) => {
    account('local.files', 'legacy');
    const legacy = storeFile('local.files', 'legacy');
    const folder = storeFile('local.files', 'folder');
    const store = serviceStore('local.files', legacy);
    const media = await landPicture(store, 10);
    closeStore(store);

    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);
    if (order === 'rename then flip the layout') {
      renameStore(legacy, folder);
      expect(sweep()).toBe(0);
      expect(existsSync(media.path)).toBe(true);
      setAccount('local.files', { layout: 'folder' });
    } else {
      setAccount('local.files', { layout: 'folder' });
      expect(sweep()).toBe(0);
      expect(existsSync(media.path)).toBe(true);
      renameStore(legacy, folder);
    }
    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);

    // The store runs again at its new path: nothing else was told.
    const moved = serviceStore('local.files', folder);
    await reassert(moved);
    expect(JSON.parse(markers(media)[identityMarkers(media)[0]!]!).seen).toBe(realpathSync(folder));
    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);
    expect(identityMarkers(media)).toHaveLength(1);
    expect(pathMarkers(media)).toEqual([]);
  });

  test('a store that is deleted after its rename releases its pictures at the next sweep', async () => {
    account('local.files', 'legacy');
    const legacy = storeFile('local.files', 'legacy');
    const store = serviceStore('local.files', legacy);
    const media = await landPicture(store, 11);
    closeStore(store);
    renameStore(legacy, storeFile('local.files', 'folder'));
    setAccount('local.files', { layout: 'folder' });
    expect(sweep()).toBe(0);
    // Delete: the folder goes, and the entry says so.
    rmSync(dirname(dirname(storeFile('local.files', 'folder'))), { recursive: true, force: true });
    setAccount('local.files', { state: 'deleted' });
    expect(sweep()).toBe(1);
    expect(existsSync(media.path)).toBe(false);
    expect(existsSync(`${media.path}.refs`)).toBe(false);
  });
});

// --- Holds written by the build before this change ---------------------------

describe('an install whose pictures are held the old way', () => {
  test('keeps every picture through an upgrade, a re-assert, a sweep, a rename and another sweep', async () => {
    account('local.files', 'legacy');
    account('dropbox.files', 'legacy');
    const legacyA = storeFile('local.files', 'legacy');
    const legacyB = storeFile('dropbox.files', 'legacy');

    // The fixture: each store opened by its path, its picture held by a path marker.
    const oldA = pathHeldStore('local.files', legacyA);
    const mediaA = await landPicture(oldA, 20);
    const oldB = pathHeldStore('dropbox.files', legacyB);
    const mediaB = await landPicture(oldB, 21);
    closeStore(oldA);
    closeStore(oldB);
    const expectedA = oldMarker(legacyA);
    const expectedB = oldMarker(legacyB);
    expect(markers(mediaA)).toEqual({ [expectedA.name]: expectedA.text });
    expect(markers(mediaB)).toEqual({ [expectedB.name]: expectedB.text });

    // Upgraded, nothing has run yet: a sweep keeps both.
    expect(sweep()).toBe(0);
    expect(existsSync(mediaA.path) && existsSync(mediaB.path)).toBe(true);

    // Store A runs and holds its pictures again: its path marker is replaced by the identity marker.
    const upgradedA = serviceStore('local.files', legacyA);
    await reassert(upgradedA);
    expect(pathMarkers(mediaA)).toEqual([]);
    expect(identityMarkers(mediaA)).toHaveLength(1);
    expect(markers(mediaB)).toEqual({ [expectedB.name]: expectedB.text });
    expect(sweep()).toBe(0);
    expect(existsSync(mediaA.path) && existsSync(mediaB.path)).toBe(true);
    closeStore(upgradedA);

    // Both stores are renamed into their account folders. Store B has not run since the upgrade.
    const folderA = storeFile('local.files', 'folder');
    const folderB = storeFile('dropbox.files', 'folder');
    renameStore(legacyA, folderA);
    renameStore(legacyB, folderB);
    expect(sweep()).toBe(0);
    expect(existsSync(mediaA.path) && existsSync(mediaB.path)).toBe(true);
    setAccount('local.files', { layout: 'folder' });
    setAccount('dropbox.files', { layout: 'folder' });
    expect(sweep()).toBe(0);
    expect(existsSync(mediaA.path) && existsSync(mediaB.path)).toBe(true);

    // B finally runs, at its new path.
    const upgradedB = serviceStore('dropbox.files', folderB);
    await reassert(upgradedB);
    expect(pathMarkers(mediaB)).toEqual([]);
    expect(identityMarkers(mediaB)).toHaveLength(1);
    expect(sweep()).toBe(0);
    expect(existsSync(mediaA.path) && existsSync(mediaB.path)).toBe(true);

    // Delete B's account: its picture goes, A's stays.
    closeStore(upgradedB);
    rmSync(dirname(dirname(folderB)), { recursive: true, force: true });
    setAccount('dropbox.files', { state: 'deleted' });
    sweep();
    expect(existsSync(mediaB.path)).toBe(false);
    expect(existsSync(mediaA.path)).toBe(true);
  });

  test('a picture only an old path marker holds survives its store being renamed, for as long as the store exists', async () => {
    account('dropbox.files', 'legacy');
    const legacy = storeFile('dropbox.files', 'legacy');
    const store = pathHeldStore('dropbox.files', legacy);
    const media = await landPicture(store, 22);
    closeStore(store);
    renameStore(legacy, storeFile('dropbox.files', 'folder'));
    setAccount('dropbox.files', { layout: 'folder' });
    for (let pass = 0; pass < 3; pass += 1) {
      expect(sweep()).toBe(0);
      expect(existsSync(media.path)).toBe(true);
    }
    // And once the store is gone for good, so is the hold (no path is held forever).
    rmSync(storeFile('dropbox.files', 'folder'));
    expect(sweep()).toBe(1);
    expect(existsSync(media.path)).toBe(false);
  });

  test('an old path marker of a store the registry does not place behaves exactly as it did', async () => {
    account('local.files', 'legacy');
    const mounted = join(base, 'mounts', 'reflect.sqlite');
    const store = pathHeldStore('local.files', mounted);
    const media = await landPicture(store, 23);
    closeStore(store);
    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);
    // Renamed away, it is gone, as on the build before this change.
    renameStore(mounted, join(base, 'mounts', 'renamed.sqlite'));
    expect(sweep()).toBe(1);
    expect(existsSync(media.path)).toBe(false);
  });
});

// --- Release and delete ------------------------------------------------------

describe('a deleted account', () => {
  test.each([
    ['its entry says deleted', (): void => setAccount('local.files', { state: 'deleted' })],
    ['its entry has been dropped', (): void => {
      // The registry still lists another account, so it is a registry that has been read.
      account('dropbox.files', 'legacy');
      dropAccount('local.files');
    }],
  ] as const)('releases its pictures at the next sweep when %s', async (_name, change) => {
    account('local.files', 'folder');
    const dbPath = storeFile('local.files', 'folder');
    const store = serviceStore('local.files', dbPath);
    const media = await landPicture(store, 30);
    const other = await landPicture(store, 31, 'photo-2');
    closeStore(store);
    rmSync(dirname(dirname(dbPath)), { recursive: true, force: true });
    change();
    expect(sweep()).toBe(2);
    expect(existsSync(media.path) || existsSync(other.path)).toBe(false);
  });

  test('keeps them while the account is being deleted, and while its store is there', async () => {
    account('local.files', 'folder');
    const dbPath = storeFile('local.files', 'folder');
    const store = serviceStore('local.files', dbPath);
    const media = await landPicture(store, 32);
    closeStore(store);
    setAccount('local.files', { state: 'deleting' });
    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);
    setAccount('local.files', { state: 'active' });
    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);
    // The store file removed by hand while the account is active: gone, as a path marker would be.
    rmSync(dbPath);
    expect(sweep()).toBe(1);
  });

  test('a folder account whose legacy folder never existed is judged by its own folder', async () => {
    // Telegram's legacy stores sit outside the data root; on a fresh install nothing was ever there.
    account('telegram.messages', 'folder');
    const dbPath = storeFile('telegram.messages', 'folder');
    const store = serviceStore('telegram.messages', dbPath);
    const media = await landPicture(store, 35);
    closeStore(store);
    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);
    // The delete that today leaves the registry as it was: the folder is gone and a missed release is made up.
    rmSync(dirname(dirname(dbPath)), { recursive: true, force: true });
    expect(sweep()).toBe(1);
    expect(existsSync(media.path)).toBe(false);
  });

  test('a shared picture stays while another store holds it', async () => {
    account('local.files', 'folder');
    account('dropbox.files', 'folder');
    const first = serviceStore('local.files', storeFile('local.files', 'folder'));
    const media = await landPicture(first, 33);
    const second = serviceStore('dropbox.files', storeFile('dropbox.files', 'folder'));
    // The same prepared picture, extracted for the second store.
    const again = await landPicture(second, 33);
    expect(again.path).toBe(media.path);
    expect(identityMarkers(media)).toHaveLength(2);
    closeStore(first);
    closeStore(second);
    rmSync(dirname(dirname(storeFile('local.files', 'folder'))), { recursive: true, force: true });
    setAccount('local.files', { state: 'deleted' });
    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);
    expect(identityMarkers(media)).toHaveLength(1);
  });

  test('the source delete releases the pictures at once, whichever way they are held', async () => {
    account('dropbox.files', 'legacy');
    const dbPath = storeFile('dropbox.files', 'legacy');
    const store = serviceStore('dropbox.files', dbPath);
    const media = await landPicture(store, 34);
    closeStore(store);
    expect(identityMarkers(media)).toHaveLength(1);
    const result = deleteOlympusData({ sourceId: 'dropbox.files', homeDir: base, env });
    expect(result.removed).toContain(media.path);
    expect(existsSync(media.path)).toBe(false);

    // Held the old way, and moved into its folder since: released the same.
    const old = pathHeldStore('dropbox.files', dbPath);
    const oldMedia = await landPicture(old, 35);
    closeStore(old);
    renameStore(dbPath, storeFile('dropbox.files', 'folder'));
    setAccount('dropbox.files', { layout: 'folder' });
    const second = deleteOlympusData({ sourceId: 'dropbox.files', homeDir: base, env });
    expect(second.removed).toContain(oldMedia.path);
    expect(existsSync(oldMedia.path)).toBe(false);
  });
});

// --- Failing safe ------------------------------------------------------------

describe('what cannot be told is kept', () => {
  async function heldAndGone() {
    account('local.files', 'folder');
    const dbPath = storeFile('local.files', 'folder');
    const store = serviceStore('local.files', dbPath);
    const media = await landPicture(store, 40);
    closeStore(store);
    rmSync(dbPath);
    return media;
  }

  test('a registry that cannot be read drops nothing', async () => {
    const media = await heldAndGone();
    writeFileSync(sourceRegistryPath(env), 'not json');
    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);
  });

  test('old path markers survive an unreadable registry, however the store was renamed', async () => {
    account('dropbox.files', 'legacy');
    const legacy = storeFile('dropbox.files', 'legacy');
    const store = pathHeldStore('dropbox.files', legacy);
    const media = await landPicture(store, 41);
    closeStore(store);
    renameStore(legacy, storeFile('dropbox.files', 'folder'));
    writeFileSync(sourceRegistryPath(env), '{"schema": 99, "accounts": []}');
    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);
  });

  test('a registry that is not there drops nothing', async () => {
    const media = await heldAndGone();
    rmSync(sourceRegistryPath(env));
    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);
  });

  test('a sweep that reads another data folder\'s registry does not judge the hold', async () => {
    const media = await heldAndGone();
    const elsewhere = { HOME: base, XDG_DATA_HOME: join(base, 'other-data') };
    updateSourceRegistry(elsewhere, (registry) => {
      registry.accounts.push({ source_id: 'dropbox.files', slot: '1', state: 'active', layout: 'legacy', corpus_ids: [], created_at: '2026-10-25T00:00:00.000Z' });
    });
    expect(sweep(elsewhere)).toBe(0);
    expect(existsSync(media.path)).toBe(true);
    // The data folder the hold was written for does judge it: the account is active and its store is gone.
    expect(sweep()).toBe(1);
    expect(existsSync(media.path)).toBe(false);
  });

  test('a store whose folder cannot be looked at is not reported gone', async () => {
    account('dropbox.files', 'legacy');
    // A legacy store on an external volume: the override names it, and the volume is not mounted.
    const volume = join(base, 'volume', 'dropbox.sqlite');
    const pinned = { ...env, OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: volume };
    const store = openConnectorStore({ sourceId: 'dropbox.files' }, { dbPath: volume, corpusId: corpusOf('dropbox.files'), family: 'file', trustDomain: 'secure_local', tierLedger: null }, pinned);
    open.push(store);
    const media = await landPicture(store, 42);
    closeStore(store);
    expect(identityMarkers(media)).toHaveLength(1);
    renameStore(volume, join(base, 'unmounted-volume.sqlite'));
    rmSync(dirname(volume), { recursive: true });
    // Neither the default path's folder (the data root) nor the override's folder is there to look in... the data root is, but the volume is not.
    expect(sweep()).toBe(0);
    expect(existsSync(media.path)).toBe(true);
  });

  test('a marker write that never finished is removed once old, and not before', async () => {
    account('local.files', 'folder');
    const store = serviceStore('local.files', storeFile('local.files', 'folder'));
    const media = await landPicture(store, 43);
    const leftover = join(`${media.path}.refs`, `store-${'a'.repeat(32)}.${'b'.repeat(8)}.tmp`);
    writeFileSync(leftover, '{');
    expect(sweepMediaCache(cache, { env })).toBe(0);
    expect(existsSync(leftover)).toBe(true);
    sweep();
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(media.path)).toBe(true);
  });
});

// --- Other holders -----------------------------------------------------------

describe('holders the registry does not place behave as before', () => {
  test('in-memory, staging and path holders, with a registry present', async () => {
    account('local.files', 'folder');
    const memory = new LocalConnectorStore({ dbPath: ':memory:', corpusId: corpusOf('local.files'), family: 'file', trustDomain: 'secure_local', tierLedger: null });
    open.push(memory);
    const memoryMedia = await landPicture(memory, 50);
    expect(Object.values(markers(memoryMedia)).every((text) => text.startsWith('memory:'))).toBe(true);

    const staging = writeMediaCacheFile(cache, jpeg(51), 'image/jpeg');
    const mounted = join(base, 'mounts', 'notes.sqlite');
    mkdirSync(dirname(mounted), { recursive: true });
    writeFileSync(mounted, '');
    const mountedMedia = writeMediaCacheFile(cache, jpeg(52), 'image/jpeg');
    retainMediaCacheFile(mountedMedia.path, mountedMedia.sha256, mounted, cache);
    releaseMediaCacheFile(mountedMedia.path, mountedMedia.sha256, mountedMedia.stagingHolder, cache);

    // Two days on: the staging hold is stale, the in-memory and mounted holders are kept.
    expect(sweep()).toBe(1);
    expect(existsSync(staging.path)).toBe(false);
    expect(existsSync(memoryMedia.path)).toBe(true);
    expect(existsSync(mountedMedia.path)).toBe(true);
    rmSync(mounted);
    expect(sweep()).toBe(1);
    expect(existsSync(mountedMedia.path)).toBe(false);
  });
});

// --- Writing the identity marker safely --------------------------------------

describe('replacing a path marker', () => {
  test('the path marker stays until the identity marker is on disk', async () => {
    account('local.files', 'legacy');
    const legacy = storeFile('local.files', 'legacy');
    const old = pathHeldStore('local.files', legacy);
    const media = await landPicture(old, 60);
    closeStore(old);
    const expected = oldMarker(legacy);
    const holder = placedStoreHolder({ sourceId: 'local.files' }, { dbPath: legacy, family: 'file', trustDomain: 'secure_local' }, env)!;
    expect(holder).toBeDefined();

    // Another picture of the same store shows the identity marker's name.
    const other = writeMediaCacheFile(cache, jpeg(61), 'image/jpeg');
    expect(retainMediaCacheFile(other.path, other.sha256, holder)).toBe(true);
    const [identityName] = identityMarkers(other);
    expect(identityName).toMatch(/^store-/);

    // The identity marker cannot be put in place (a folder stands where it goes): the hold fails, and the old marker is untouched.
    mkdirSync(join(`${media.path}.refs`, identityName!));
    expect(retainMediaCacheFile(media.path, media.sha256, holder)).toBe(false);
    expect(markers(media)[expected.name]).toBe(expected.text);
    expect(pathMarkers(media)).toEqual([expected.name]);
    rmSync(join(`${media.path}.refs`, identityName!), { recursive: true });

    expect(retainMediaCacheFile(media.path, media.sha256, holder)).toBe(true);
    expect(pathMarkers(media)).toEqual([]);
    expect(identityMarkers(media)).toEqual([identityName!]);
    // Holding twice changes nothing.
    const before = markers(media);
    expect(retainMediaCacheFile(media.path, media.sha256, holder)).toBe(true);
    expect(markers(media)).toEqual(before);
    // The release names the same store: both kinds of marker go, and the file with the last.
    releaseMediaCacheFile(other.path, other.sha256, other.stagingHolder);
    expect(releaseMediaCacheFile(media.path, media.sha256, holder)).toBe(true);
    expect(existsSync(media.path)).toBe(false);
    expect(releaseMediaCacheFile(other.path, other.sha256, holder)).toBe(true);
    expect(existsSync(other.path)).toBe(false);
  });
});
