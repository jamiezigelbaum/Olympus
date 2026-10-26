// Media bindings (docs/design/child-items.md, "Manifest"): the media files a
// folder-chosen archive refers to that its manifest does not hold. Each is
// bound in an append-only table beside the archive record, before the page
// that lists its child goes out; the child's locator names the binding; the
// import is whole only when the manifest and the bindings both are; a read
// finds the bound version or settles as gone; a single chosen file never
// widens to its folder; removal and Delete forget them.
//
// The connector is the child-items fixture (it binds through the same
// `ArchiveConnectorInput.media` a format connector gets); the import, the tier
// set, the extraction runtime and the removal are the real ones.

import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  archiveFormatConnector,
  getArchiveFormat,
  registerArchiveFormatConnector,
  type ArchiveConnectorFactory,
  type ArchiveConnectorInput,
} from '../src/core/archive-formats.ts';
import type { SourceConnector } from '../src/core/contracts.ts';
import { defaultConfig } from '../src/core/config.ts';
import { accountFolder, accountRawPath, legacyAccountPaths, olympusDataRoot } from '../src/core/olympus-layout.ts';
import { ScopeRoot, ScopeSafeError } from '../src/core/scope-safe-fs.ts';
import { resolvedRawPath } from '../src/core/source-placement.ts';
import { deleteOlympusData, exportOlympusData } from '../src/data-lifecycle.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import {
  ARCHIVE_MEDIA_DEFAULT_READ_BYTES,
  ArchiveMediaBindingStore,
  archiveMediaAccess,
  archiveMediaBindingsPath,
  createArchiveMediaBindings,
  defaultArchiveMediaBindingsPath,
  mediaBindingId,
  verifyArchiveMediaBindings,
} from '../src/workers/archive-import/media-bindings.ts';
import { requestArchiveRemoval, runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { archiveImportTaskId, createArchiveImportsSchedulerSource } from '../src/workers/archive-import/scheduler-source.ts';
import { archiveConnectorId, defaultArchiveImportStatePath } from '../src/workers/archive-import/state.ts';
import {
  FIXTURE_MEDIA_LOCATOR_PREFIX,
  childProviderItemId,
  createFixtureChildConnector,
  type FixtureParentSpec,
} from './helpers/child-items-fixture.ts';
import { childItemsArchiveHarness, FIXTURE_ARCHIVE_FORMAT } from './support/child-items-archive-harness.ts';
import { childItemsExtraction } from './support/child-items-extraction-harness.ts';

const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;
const cleanups: Array<() => void> = [];
afterEach(() => {
  registerInstalledTierClassification(undefined);
  while (cleanups.length) cleanups.pop()!();
});

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-media-bindings-')));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const LEASE = 'The lease term is thirty-seven months.';
const NOTES = 'Remember the deposit.';

/** A chat with three media children: two files in the folder and one the export left out. */
function chat(): FixtureParentSpec[] {
  return [{
    id: 'm1', subject: 'Flat', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z', body: 'The documents are attached.',
    children: [
      { key: 'p1', name: 'lease.txt', mimeType: 'text/plain', mediaPath: 'media/lease.txt' },
      { key: 'p2', name: 'notes.txt', mimeType: 'text/plain', mediaPath: 'media/notes.txt' },
      { key: 'p3', name: 'lost.txt', mimeType: 'text/plain', mediaPath: 'media/lost.txt' },
    ],
  }];
}

function mediaFiles(): Record<string, string> {
  return { 'media/lease.txt': LEASE, 'media/notes.txt': NOTES };
}

function bindingRows(path: string, archiveId?: string): Array<{ archive_id: string; binding_id: string; rel_path: string; size: number }> {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(`SELECT archive_id, binding_id, rel_path, size FROM media_bindings ${archiveId ? 'WHERE archive_id = ?' : ''} ORDER BY rel_path`)
      .all(...(archiveId ? [archiveId] : [])) as Array<{ archive_id: string; binding_id: string; rel_path: string; size: number }>;
  } finally {
    db.close();
  }
}

describe('where the bindings live is the layout resolvers\' answer', () => {
  const account = (layout: 'folder' | 'legacy') => ({ source_id: 'archive.imports', slot: '1', layout });

  test('a folder account keeps them in its raw folder; a legacy one beside its record, wherever that is', () => {
    const home = temp();
    const env = { HOME: home, XDG_DATA_HOME: join(home, 'xdg') };
    expect(accountRawPath(account('folder'), 'archive-media-bindings.sqlite', env))
      .toBe(join(accountFolder({ source_id: 'archive.imports', slot: '1' }, env), 'raw', 'archive-media-bindings.sqlite'));
    expect(accountRawPath(account('legacy'), 'archive-media-bindings.sqlite', env))
      .toBe(join(olympusDataRoot(env), 'archive-media-bindings.sqlite'));
    // No env variable relocates the record since step 6; a record a caller keeps elsewhere has its bindings beside it.
    const moved = { ...env, OLYMPUS_ARCHIVE_IMPORTS_STATE_PATH: join(home, 'elsewhere', 'records.json') };
    expect(accountRawPath(account('legacy'), 'archive-media-bindings.sqlite', moved))
      .toBe(join(olympusDataRoot(env), 'archive-media-bindings.sqlite'));
    expect(archiveMediaBindingsPath(join(home, 'elsewhere', 'records.json'))).toBe(join(home, 'elsewhere', 'archive-media-bindings.sqlite'));
  });

  test('the resolver, the record\'s directory and the runtime default agree in both layouts', () => {
    const home = temp();
    const env = { HOME: home, XDG_DATA_HOME: join(home, 'xdg') };
    const agree = (): string => {
      const resolved = resolvedRawPath('archive.imports', 'archive-media-bindings.sqlite', env);
      expect(defaultArchiveMediaBindingsPath(env)).toBe(resolved);
      expect(archiveMediaBindingsPath(defaultArchiveImportStatePath(env))).toBe(resolved);
      return resolved;
    };
    // A fresh install: the account's folder.
    expect(agree()).toBe(join(accountFolder({ source_id: 'archive.imports', slot: '1' }, env), 'raw', 'archive-media-bindings.sqlite'));
    // A record at the legacy location places the account there, and the bindings with it.
    mkdirSync(olympusDataRoot(env), { recursive: true });
    writeFileSync(join(olympusDataRoot(env), 'archive-imports.json'), '');
    expect(agree()).toBe(join(olympusDataRoot(env), 'archive-media-bindings.sqlite'));
  });

  test('a file at the legacy location is evidence of a legacy account, and only this source owns the name', () => {
    const env = { HOME: temp() };
    expect(legacyAccountPaths('archive.imports', env).raw).toContain(join(olympusDataRoot(env), 'archive-media-bindings.sqlite'));
    expect(() => accountRawPath({ source_id: 'x.bookmarks', slot: '1', layout: 'folder' }, 'archive-media-bindings.sqlite', env)).toThrow(TypeError);
  });
});

describe('the table is append-only', () => {
  function store(): { store: ArchiveMediaBindingStore; path: string } {
    const path = join(temp(), 'bindings.sqlite');
    const opened = new ArchiveMediaBindingStore({ path, env: { HOME: dirname(path) } });
    cleanups.push(() => opened.close());
    return { store: opened, path };
  }
  const v1 = { dev: '1', ino: '10', size: 5, mtimeMs: 1000 };

  test('binding a path twice keeps the first binding, whatever the file is now', () => {
    const { store: bindings } = store();
    const first = bindings.bind('a1', 'media/a.jpg', v1);
    const again = bindings.bind('a1', 'media/a.jpg', { dev: '1', ino: '99', size: 7, mtimeMs: 2000 });
    expect(again).toEqual(first);
    expect(first.bindingId).toBe(mediaBindingId('a1', 'media/a.jpg'));
    expect(first.version).toEqual(v1);
    expect(bindings.count('a1')).toBe(1);
  });

  test('a binding cannot be rewritten, by the store or by anything else holding the file', () => {
    const { store: bindings, path } = store();
    const bound = bindings.bind('a1', 'media/a.jpg', v1);
    const other = new Database(path);
    try {
      expect(() => other.query('UPDATE media_bindings SET size = 1 WHERE binding_id = ?').run(bound.bindingId)).toThrow('append-only');
      expect(() => other.query('UPDATE media_bindings SET rel_path = ? WHERE binding_id = ?').run('media/b.jpg', bound.bindingId)).toThrow('append-only');
    } finally {
      other.close();
    }
    expect(bindings.get('a1', bound.bindingId)?.version).toEqual(v1);
  });

  test('two archives bind the same path to different bindings; forgetting one leaves the other', () => {
    const { store: bindings } = store();
    const one = bindings.bind('a1', 'media/a.jpg', v1);
    const two = bindings.bind('a2', 'media/a.jpg', v1);
    expect(one.bindingId).not.toBe(two.bindingId);
    bindings.bind('a1', 'media/b.jpg', v1);
    expect(bindings.forgetArchive('a1')).toBe(2);
    expect(bindings.count('a1')).toBe(0);
    expect(bindings.get('a1', one.bindingId)).toBeUndefined();
    expect(bindings.get('a2', two.bindingId)).toBeDefined();
    expect(bindings.forgetArchive('a1')).toBe(0);
  });

  test('pages come in binding order and cover every binding once', () => {
    const { store: bindings } = store();
    for (let i = 0; i < 7; i += 1) bindings.bind('a1', `media/${i}.jpg`, v1);
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = bindings.page('a1', after, 3);
      seen.push(...page.map((binding) => binding.bindingId));
      if (page.length < 3) break;
      after = page[page.length - 1]!.bindingId;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort()).toEqual(seen);
  });

  test('a file from a newer build is refused rather than read as this one', () => {
    const { store: bindings, path } = store();
    bindings.bind('a1', 'media/a.jpg', v1);
    bindings.close();
    const db = new Database(path);
    db.query('UPDATE schema_version SET version = 9').run();
    db.close();
    expect(() => new ArchiveMediaBindingStore({ path, env: { HOME: dirname(path) } })).toThrow();
  });

  test('the lazy handle creates no file until something binds, and peek never creates one', () => {
    const path = join(temp(), 'sub', 'bindings.sqlite');
    const handle = createArchiveMediaBindings({ path, env: { HOME: dirname(path) } });
    cleanups.push(() => handle.close());
    expect(handle.peek()).toBeUndefined();
    expect(handle.forgetArchive('a1')).toBe(0);
    expect(existsSync(path)).toBe(false);
    handle.open().bind('a1', 'media/a.jpg', v1);
    expect(existsSync(path)).toBe(true);
    expect(handle.peek()?.count('a1')).toBe(1);
    expect(handle.forgetArchive('a1')).toBe(1);
    handle.close();
    expect(handle.peek()).toBeUndefined();
  });
});

describe('what a connector is given to bind and read', () => {
  function folder(files: Record<string, string> = mediaFiles()) {
    const dir = temp();
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    const root = ScopeRoot.open(dir);
    cleanups.push(() => root.close());
    const bindings = createArchiveMediaBindings({ path: join(temp(), 'bindings.sqlite'), env: { HOME: dir } });
    cleanups.push(() => bindings.close());
    const media = (chosenRelPath = '') => archiveMediaAccess({ bindings, archiveId: 'a1', root, chosenRelPath });
    return { dir, root, bindings, media };
  }

  test('a file under the chosen folder binds once, with its size, and reads back', () => {
    const { media, bindings } = folder();
    const access = media();
    const bound = access.bind('media/lease.txt');
    expect(bound).toEqual({ ok: true, bindingId: mediaBindingId('a1', 'media/lease.txt'), sizeBytes: LEASE.length });
    expect(access.bind('media/lease.txt')).toEqual(bound);
    expect(bindings.peek()?.count('a1')).toBe(1);
    if (!bound.ok) throw new Error('unreachable');
    expect(new TextDecoder().decode(access.read(bound.bindingId))).toBe(LEASE);
  });

  test('one spelling per file: a path with doubled separators binds as the plain one', () => {
    const { media, bindings } = folder();
    const access = media();
    const plain = access.bind('media/lease.txt');
    expect(access.bind('media//lease.txt')).toEqual(plain);
    expect(bindings.peek()?.count('a1')).toBe(1);
    expect(bindings.peek()?.page('a1', undefined, 5)[0]?.relPath).toBe('media/lease.txt');
  });

  test('a whole-file read is never unbounded: with no limit named, a file past the default is refused unread', () => {
    const { media, dir } = folder();
    const big = join(dir, 'media', 'big.bin');
    // A sparse file: no disk is used, and it is larger than the default whole-file read.
    writeFileSync(big, '');
    truncateSync(big, ARCHIVE_MEDIA_DEFAULT_READ_BYTES + 1);
    const access = media();
    const bound = access.bind('media/big.bin');
    if (!bound.ok) throw new Error('not bound');
    expect(bound.sizeBytes).toBe(ARCHIVE_MEDIA_DEFAULT_READ_BYTES + 1);
    try { access.read(bound.bindingId); } catch (error) { expect((error as ScopeSafeError).code).toBe('too_large'); }
    expect.assertions(2);
  });

  test('a single chosen file never widens to its folder: nothing beside it is bound, and no file is made', () => {
    const { media, bindings } = folder();
    expect(media('result.json').bind('media/lease.txt')).toEqual({ ok: false, reason: 'chosen_file' });
    expect(existsSync(bindings.path)).toBe(false);
  });

  test('what cannot be bound says why: missing, a link, a folder, a path out of the folder', () => {
    const { media, dir } = folder();
    symlinkSync(join(dir, 'media', 'lease.txt'), join(dir, 'media', 'link.txt'));
    const access = media();
    expect(access.bind('media/nothing.txt')).toEqual({ ok: false, reason: 'missing' });
    expect(access.bind('media/link.txt')).toEqual({ ok: false, reason: 'not_regular' });
    expect(access.bind('media')).toEqual({ ok: false, reason: 'not_regular' });
    expect(access.bind('../outside.txt')).toEqual({ ok: false, reason: 'not_regular' });
    expect(access.bind('/etc/hosts')).toEqual({ ok: false, reason: 'not_regular' });
  });

  test('a read finds the bound version or throws: replaced, rewritten, deleted, never bound', () => {
    const { media, dir } = folder();
    const access = media();
    const bound = (rel: string): string => {
      const result = access.bind(rel);
      if (!result.ok) throw new Error('not bound');
      return result.bindingId;
    };
    const lease = bound('media/lease.txt');
    const notes = bound('media/notes.txt');
    // The same bytes, written again: another modification time is another version.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'media', 'lease.txt'), later, later);
    expect(() => access.read(lease)).toThrow(ScopeSafeError);
    try { access.read(lease); } catch (error) { expect((error as ScopeSafeError).code).toBe('changed'); }
    // Longer.
    appendFileSync(join(dir, 'media', 'notes.txt'), ' More.');
    try { access.read(notes); } catch (error) { expect((error as ScopeSafeError).code).toBe('changed'); }
    // Gone.
    unlinkSync(join(dir, 'media', 'notes.txt'));
    try { access.read(notes); } catch (error) { expect((error as ScopeSafeError).code).toBe('not_found'); }
    // A binding nobody wrote.
    try { access.read('mb-00000000000000000000000000000000'); } catch (error) { expect((error as ScopeSafeError).code).toBe('not_found'); }
    expect.assertions(5);
  });

  test('a read over the limit is refused before a byte is read; an open reader checks again after reading', () => {
    const { media, dir } = folder();
    const access = media();
    const bound = access.bind('media/lease.txt');
    if (!bound.ok) throw new Error('not bound');
    try { access.read(bound.bindingId, { maxBytes: 5 }); } catch (error) { expect((error as ScopeSafeError).code).toBe('too_large'); }
    expect(access.read(bound.bindingId, { maxBytes: LEASE.length }).byteLength).toBe(LEASE.length);
    const reader = access.open(bound.bindingId);
    try {
      expect(reader.readAt(0, 3).byteLength).toBe(3);
      appendFileSync(join(dir, 'media', 'lease.txt'), '!');
      expect(() => reader.assertCurrent()).toThrow(ScopeSafeError);
    } finally {
      reader.close();
    }
    expect.assertions(4);
  });

  test('whole-import verification finds the first bound file that is not the bound version', async () => {
    const { media, bindings, root, dir } = folder();
    const access = media();
    for (const rel of ['media/lease.txt', 'media/notes.txt']) access.bind(rel);
    const verify = (batch?: number) => verifyArchiveMediaBindings({ bindings, archiveId: 'a1', root, shouldContinue: () => true, ...(batch ? { batch } : {}) });
    expect(await verify()).toEqual({ ok: true });
    // Another archive's bindings are not this one's to answer for.
    expect(await verifyArchiveMediaBindings({ bindings, archiveId: 'a2', root, shouldContinue: () => true })).toEqual({ ok: true });

    appendFileSync(join(dir, 'media', 'notes.txt'), ' More.');
    for (const batch of [1, 2, 500]) {
      expect(await verify(batch)).toMatchObject({ ok: false, code: 'file_changed', relPath: 'media/notes.txt' });
    }
    unlinkSync(join(dir, 'media', 'notes.txt'));
    expect(await verify()).toMatchObject({ ok: false, code: 'file_missing', relPath: 'media/notes.txt' });
    // Asked to stop, it neither passes nor fails the import.
    expect(await verifyArchiveMediaBindings({ bindings, archiveId: 'a1', root, shouldContinue: () => false })).toBeUndefined();
  });

  test('a replaced file at the same name is a changed file, not the bound one', async () => {
    const { media, bindings, root, dir } = folder();
    media().bind('media/lease.txt');
    unlinkSync(join(dir, 'media', 'lease.txt'));
    writeFileSync(join(dir, 'media', 'lease.txt'), LEASE);
    expect(await verifyArchiveMediaBindings({ bindings, archiveId: 'a1', root, shouldContinue: () => true }))
      .toMatchObject({ ok: false, code: 'file_changed', relPath: 'media/lease.txt' });
  });
});

describe('an import of a chosen folder', () => {
  async function started(extra: Record<string, string | Uint8Array> = {}) {
    const h = childItemsArchiveHarness(cleanups);
    const { archiveId, folder } = h.startFolder('Chat-1', { ...mediaFiles(), ...extra });
    return { h, archiveId, folder };
  }
  /** A factory for the fixture connector that wraps each listing so a test sees every page as it goes out. */
  function observing(
    h: ReturnType<typeof childItemsArchiveHarness>,
    parents: readonly FixtureParentSpec[],
    options: { onPage?: (page: { items: Array<{ identity: { providerItemId: string }; deferredBytes?: { locator: string; available: boolean } }>; done?: boolean }) => void; beforePage?: (firstItem: number) => void } = {},
  ) {
    return (): ArchiveConnectorFactory => (input: ArchiveConnectorInput): SourceConnector => {
      const inner = createFixtureChildConnector({
        accountScope: input.accountScope,
        provider: format.provider,
        family: format.family,
        id: input.connectorId,
        parents,
        log: h.log,
        pageSize: input.pageSize ?? 2,
        reportItemPositions: (positions) => input.reportItemPositions?.(positions),
        ...(input.media ? { media: input.media } : {}),
        ...(options.beforePage ? { beforePage: options.beforePage } : {}),
      });
      const wrapped = Object.create(inner) as SourceConnector;
      wrapped.listItems = (listOptions) => {
        const pages = inner.listItems(listOptions);
        return (async function* () {
          for await (const page of pages) {
            options.onPage?.(page as never);
            yield page;
          }
        })();
      };
      return wrapped;
    };
  }

  test('each media child is bound before the page that lists it goes out, and its locator names the binding', async () => {
    const { h, archiveId } = await started();
    const bindingsPath = h.runtime.media.path;
    const sawBefore: Array<{ providerItemId: string; bound: boolean; rowExists: boolean }> = [];
    const factory = observing(h, chat(), {
      onPage: (page) => {
        for (const item of page.items) {
          const locator = item.deferredBytes?.locator;
          if (!locator?.startsWith(FIXTURE_MEDIA_LOCATOR_PREFIX) || locator.endsWith('none')) continue;
          const bindingId = locator.slice(FIXTURE_MEDIA_LOCATOR_PREFIX.length);
          // From another connection: the binding is committed, and the store has no row for the child yet.
          sawBefore.push({
            providerItemId: item.identity.providerItemId,
            bound: bindingRows(bindingsPath, archiveId).some((row) => row.binding_id === bindingId),
            rowExists: h.rows(archiveId).some((row) => row.providerItemId === item.identity.providerItemId),
          });
        }
      },
    });
    const outcome = await h.importAll(archiveId, chat(), { connectorFactory: factory });
    expect(outcome.record?.status).toBe('imported');
    expect(sawBefore.map((entry) => entry.providerItemId).sort()).toEqual([childProviderItemId('m1', 'p1'), childProviderItemId('m1', 'p2')]);
    expect(sawBefore.every((entry) => entry.bound && !entry.rowExists)).toBe(true);

    // The names are in the table; the locators in the store carry the binding and no path.
    const rows = bindingRows(bindingsPath, archiveId);
    expect(rows.map((row) => row.rel_path)).toEqual(['media/lease.txt', 'media/notes.txt']);
    expect(rows.map((row) => row.size)).toEqual([LEASE.length, NOTES.length]);
    const children = h.rows(archiveId).filter((row) => row.providerItemId.includes('#child:'));
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.locator).not.toContain('media/');
      if (child.available === 1) expect(rows.some((row) => child.locator === `${FIXTURE_MEDIA_LOCATOR_PREFIX}${row.binding_id}`)).toBe(true);
    }
    // The one the export left out keeps its name, unavailable, with nothing bound for it.
    const lost = children.find((row) => row.providerItemId.endsWith('#child:p3'))!;
    expect(lost.available).toBe(0);
    expect(h.log.binds.find((entry) => entry.mediaPath === 'media/lost.txt')?.result).toBe('missing');
  });

  test('a listing that fails after binding leaves bindings and no children; the replay binds the same ones and every locator resolves', async () => {
    const { h, archiveId } = await started();
    let failed = false;
    const failing = observing(h, chat(), {
      beforePage: (firstItem) => {
        if (firstItem >= 2 && !failed) {
          failed = true;
          throw new Error('the listing broke');
        }
      },
    });
    await expect(h.pull(archiveId, chat(), { connectorFactory: failing })).rejects.toThrow('the listing broke');
    // Bound before the break; no child was stored, and nothing was checkpointed.
    expect(bindingRows(h.runtime.media.path, archiveId).map((row) => row.rel_path)).toEqual(['media/lease.txt']);
    expect(h.rows(archiveId).filter((row) => row.providerItemId.includes('#child:'))).toEqual([]);
    expect(h.runtime.lane(format.family).set.committedCursor(archiveConnectorId(archiveId))).toBeUndefined();

    const outcome = await h.importAll(archiveId, chat(), { connectorFactory: failing });
    expect(outcome.record?.status).toBe('imported');
    const rows = bindingRows(h.runtime.media.path, archiveId);
    expect(rows.map((row) => row.rel_path)).toEqual(['media/lease.txt', 'media/notes.txt']);
    const ids = new Set(rows.map((row) => row.binding_id));
    for (const child of h.rows(archiveId).filter((row) => row.available === 1)) {
      expect(ids.has(child.locator!.slice(FIXTURE_MEDIA_LOCATOR_PREFIX.length))).toBe(true);
    }
  });

  test('the import is whole only when the bound media are too: a file that changed or went missing stops it, naming the file', async () => {
    for (const [change, code] of [
      [(folder: string) => appendFileSync(join(folder, 'media', 'lease.txt'), ' Changed.'), 'file_changed'],
      [(folder: string) => unlinkSync(join(folder, 'media', 'lease.txt')), 'file_missing'],
    ] as const) {
      const { h, archiveId, folder } = await started();
      // The file is bound on the first page; it changes before the listing reaches the end.
      const factory = observing(h, chat(), { beforePage: (firstItem) => { if (firstItem >= 2) change(folder); } });
      const outcome = await h.importAll(archiveId, chat(), { connectorFactory: factory });
      expect(outcome.record?.status).toBe('stopped');
      expect(outcome.record?.stop).toMatchObject({ code, rel_path: 'media/lease.txt' });
      expect(outcome.record?.completed_at).toBeUndefined();
    }
  });

  test('a file that changes while the last page is stored is found as the import is called complete', async () => {
    const { h, archiveId, folder } = await started();
    // The completion phase reads the bindings twice: before the last page goes on, and as the record
    // is marked complete. The second read is where this file changes.
    let reads = 0;
    const media = new Proxy(h.runtime.media, {
      get(target, property, receiver) {
        if (property === 'peek') {
          return () => {
            reads += 1;
            if (reads === 2) appendFileSync(join(folder, 'media', 'notes.txt'), ' Late.');
            return target.peek();
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const outcome = await h.importAll(archiveId, chat(), { media });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(outcome.record?.status).toBe('stopped');
    expect(outcome.record?.stop).toMatchObject({ code: 'file_changed', rel_path: 'media/notes.txt' });
  });

  test('an import whose media are all where they were is complete, and the manifest is the one it started with', async () => {
    const { h, archiveId } = await started();
    const before = h.runtime.state.get(archiveId)!;
    const outcome = await h.importAll(archiveId, chat());
    const after = outcome.record!;
    expect(after.status).toBe('imported');
    expect(after.manifest_sha256).toBe(before.manifest_sha256);
    expect(after.files.map((file) => file.rel_path)).toEqual(before.files.map((file) => file.rel_path));
    // The media are bound, not manifest files.
    expect(after.files.some((file) => file.rel_path.startsWith('media/'))).toBe(false);
  });

  test('a single chosen file lists its media as left out and binds nothing', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    const outcome = await h.importAll(archiveId, chat());
    expect(outcome.record?.status).toBe('imported');
    expect(h.log.binds.map((entry) => entry.result)).toEqual(['chosen_file', 'chosen_file', 'chosen_file']);
    expect(existsSync(h.runtime.media.path)).toBe(false);
    const children = h.rows(archiveId).filter((row) => row.providerItemId.includes('#child:'));
    // Their names are kept; none can be read.
    expect(children).toHaveLength(3);
    expect(children.every((row) => row.available === 0)).toBe(true);
    const ext = childItemsExtraction(h, cleanups, { parents: chat() });
    expect((await ext.drive(archiveId)).queued).toBe(0);
  });
});

describe('reading a bound media file later', () => {
  function sniffedPrivate(): void {
    registerInstalledTierClassification({ forLedger: () => ({ sniffer: { id: 's', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) } }) });
  }
  async function imported() {
    sniffedPrivate();
    const h = childItemsArchiveHarness(cleanups);
    const { archiveId, folder } = h.startFolder('Chat-1', mediaFiles());
    await h.importAll(archiveId, chat());
    const ext = childItemsExtraction(h, cleanups, { parents: chat() });
    return { h, archiveId, folder, ext };
  }
  const chunksOf = (h: ReturnType<typeof childItemsArchiveHarness>, archiveId: string, key: string): number =>
    h.rows(archiveId).filter((row) => row.providerItemId === childProviderItemId('m1', key)).reduce((total, row) => total + row.chunks, 0);
  function jobErrors(ext: ReturnType<typeof childItemsExtraction>): Array<{ id: string; status: string; kind: string | null }> {
    const db = new Database(ext.jobsDbPath, { readonly: true });
    try {
      return (db.query('SELECT provider_item_id AS id, status, last_error_kind AS kind FROM extraction_jobs ORDER BY provider_item_id').all() as Array<{ id: string; status: string; kind: string | null }>);
    } finally {
      db.close();
    }
  }

  test('the bytes come from the bound file through the binding the locator names, and land as the child\'s text', async () => {
    const { h, archiveId, ext } = await imported();
    // The unavailable one is never offered.
    const driven = await ext.drive(archiveId);
    expect(driven.queued).toBe(2);
    expect(driven.run.counts.indexed).toBe(2);
    expect(chunksOf(h, archiveId, 'p1')).toBeGreaterThan(0);
    expect(chunksOf(h, archiveId, 'p2')).toBeGreaterThan(0);
    expect(chunksOf(h, archiveId, 'p3')).toBe(0);
    expect(jobErrors(ext).map((job) => job.status)).toEqual(['indexed', 'indexed']);
  });

  test('a file that changed, was rewritten or went missing since the import settles as a version that is gone', async () => {
    const { h, archiveId, folder, ext } = await imported();
    appendFileSync(join(folder, 'media', 'lease.txt'), ' Changed.');
    unlinkSync(join(folder, 'media', 'notes.txt'));
    const driven = await ext.drive(archiveId);
    expect(driven.run.counts.indexed).toBe(0);
    expect(jobErrors(ext)).toEqual([
      { id: childProviderItemId('m1', 'p1'), status: 'failed_terminal', kind: 'source_version_gone' },
      { id: childProviderItemId('m1', 'p2'), status: 'failed_terminal', kind: 'source_version_gone' },
    ]);
    expect(chunksOf(h, archiveId, 'p1')).toBe(0);
    expect(chunksOf(h, archiveId, 'p2')).toBe(0);
  });

  test('the same bytes written again are another version, the conservative answer', async () => {
    const { archiveId, folder, ext } = await imported();
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(folder, 'media', 'lease.txt'), later, later);
    const driven = await ext.drive(archiveId);
    expect(driven.run.counts.indexed).toBe(1);
    expect(jobErrors(ext).find((job) => job.id === childProviderItemId('m1', 'p1'))).toMatchObject({ status: 'failed_terminal', kind: 'source_version_gone' });
  });

  test('a media file that is no longer a file the person approved is never followed: a link put in its place is gone, not read', async () => {
    const { h, archiveId, folder, ext } = await imported();
    unlinkSync(join(folder, 'media', 'lease.txt'));
    symlinkSync(join(folder, 'mbox'), join(folder, 'media', 'lease.txt'));
    const driven = await ext.drive(archiveId);
    expect(driven.run.counts.indexed).toBe(1);
    expect(jobErrors(ext).find((job) => job.id === childProviderItemId('m1', 'p1'))).toMatchObject({ status: 'failed_terminal', kind: 'source_version_gone' });
    expect(chunksOf(h, archiveId, 'p1')).toBe(0);
  });
});

describe('removing an archive forgets its bindings', () => {
  test('its rows go with it, the record last; another archive\'s stay', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const first = h.startFolder('Chat-1', mediaFiles());
    const second = h.startFolder('Chat-2', mediaFiles());
    await h.importAll(first.archiveId, chat());
    await h.importAll(second.archiveId, chat());
    const rows = (id: string) => bindingRows(h.runtime.media.path, id).length;
    expect(rows(first.archiveId)).toBe(2);
    expect(rows(second.archiveId)).toBe(2);

    requestArchiveRemoval(h.runtime.state, first.archiveId);
    let outcome = await runArchiveRemoval({ state: h.runtime.state, lane: h.runtime.lane(format.family), archiveId: first.archiveId, media: h.runtime.media });
    while (outcome.kind === 'progress') outcome = await runArchiveRemoval({ state: h.runtime.state, lane: h.runtime.lane(format.family), archiveId: first.archiveId, media: h.runtime.media });
    expect(outcome.kind).toBe('removed');
    expect(rows(first.archiveId)).toBe(0);
    expect(rows(second.archiveId)).toBe(2);
    expect(h.runtime.state.get(first.archiveId)).toBeUndefined();
    // The person's own files are never touched.
    expect(existsSync(join(first.folder, 'media', 'lease.txt'))).toBe(true);
  });

  test('the scheduler\'s removal task forgets them (the product path), and its import task binds (the same runtime\'s handle)', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const { archiveId } = h.startFolder('Chat-1', mediaFiles());
    // The scheduler reads the registered connector of the format: the fixture stands in for the real one.
    const original = archiveFormatConnector(format.id);
    cleanups.push(() => { if (original) registerArchiveFormatConnector(format.id, original); });
    registerArchiveFormatConnector(format.id, (input) => createFixtureChildConnector({
      accountScope: input.accountScope,
      provider: format.provider,
      family: format.family,
      id: input.connectorId,
      parents: chat(),
      log: h.log,
      ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
      ...(input.media ? { media: input.media } : {}),
    }));

    const importing = createArchiveImportsSchedulerSource({ runtime: h.runtime, config: defaultConfig() })!;
    const importTask = importing.tasks.find((task) => task.id === archiveImportTaskId(archiveId))!;
    for (let pass = 0; pass < 20 && h.runtime.state.get(archiveId)?.status === 'importing'; pass += 1) await importTask.run({} as never);
    expect(h.runtime.state.get(archiveId)?.status).toBe('imported');
    expect(bindingRows(h.runtime.media.path, archiveId)).toHaveLength(2);

    requestArchiveRemoval(h.runtime.state, archiveId);
    const removing = createArchiveImportsSchedulerSource({ runtime: h.runtime, config: defaultConfig() })!;
    const removalTask = removing.tasks.find((task) => task.id === archiveImportTaskId(archiveId))!;
    for (let pass = 0; pass < 20 && h.runtime.state.get(archiveId); pass += 1) await removalTask.run({} as never);
    expect(h.runtime.state.get(archiveId)).toBeUndefined();
    expect(bindingRows(h.runtime.media.path, archiveId)).toEqual([]);
  });
});

describe('Delete and export treat the bindings as the person\'s file names', () => {
  function seeded() {
    const home = temp();
    const env = { HOME: home, XDG_DATA_HOME: join(home, 'xdg') };
    const path = defaultArchiveMediaBindingsPath(env);
    const bindings = new ArchiveMediaBindingStore({ path, env });
    bindings.bind('a1', 'media/lease.txt', { dev: '1', ino: '10', size: 5, mtimeMs: 1000 });
    bindings.close();
    return { home, env, path };
  }

  test('deleting the archive source takes the file and its sidecars', () => {
    const { home, env, path } = seeded();
    expect(existsSync(path)).toBe(true);
    const result = deleteOlympusData({ sourceId: 'archive.imports', homeDir: home, env });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(result.removed.some((removed) => path === removed || path.startsWith(`${removed}/`))).toBe(true);
  });

  test('export names the file as skipped and never copies it', () => {
    const { home, env, path } = seeded();
    const destination = join(temp(), 'export');
    const result = exportOlympusData({ destination, sourceId: 'archive.imports', homeDir: home, env });
    expect(result.skipped).toContain(path);
    for (const file of result.files) {
      if (file.endsWith('manifest.json')) continue;
      expect(readFileSync(file).includes('lease.txt')).toBe(false);
    }
  });

  test('in a legacy layout the file is beside the record, and Delete takes it from there', () => {
    const home = temp();
    const env = { HOME: home, XDG_DATA_HOME: join(home, 'xdg') };
    mkdirSync(olympusDataRoot(env), { recursive: true });
    writeFileSync(join(olympusDataRoot(env), 'archive-imports.json'), '');
    const path = defaultArchiveMediaBindingsPath(env);
    expect(path).toBe(join(olympusDataRoot(env), 'archive-media-bindings.sqlite'));
    const bindings = new ArchiveMediaBindingStore({ path, env });
    bindings.bind('a1', 'media/lease.txt', { dev: '1', ino: '10', size: 5, mtimeMs: 1000 });
    bindings.close();
    deleteOlympusData({ sourceId: 'archive.imports', homeDir: home, env });
    expect(existsSync(path)).toBe(false);
  });
});
