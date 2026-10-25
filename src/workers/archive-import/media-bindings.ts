/**
 * Media bindings: the media files a folder-chosen archive refers to that its
 * manifest does not hold (docs/design/child-items.md, "Manifest").
 *
 * The manifest never changes after an import starts: its digest binds every
 * resume point, and a connector receives exactly its input files. A chat
 * export's media sit beside its message file and are named inside it, so
 * each one the import reads gets a binding instead: its path under the chosen
 * folder and its file identity, size and modification time when it was bound.
 * Choosing the folder approved them. They live in an append-only table beside
 * the archive record, and a resume point does not hash them.
 *
 * - A binding is written, durably, before the listing yields the page whose
 *   child names it, so before the child row and the checkpoint that follow.
 *   A restart that replays the page binds the same path to the same binding.
 * - A child's locator names the binding, never the path.
 * - Checking that an import is whole covers the manifest and the bindings
 *   together (`verifyArchiveMediaBindings`).
 * - A single chosen file never widens to its folder: nothing is bound, and
 *   the connector says the media were left out.
 * - Reads go through the scope-safe module, descriptor-relative, at the bound
 *   version, and are checked again after they were read. A changed or missing
 *   file is a `ScopeSafeError`; the extraction source settles it as
 *   `source_version_gone`.
 *
 * The file is raw state of the archive account, reached through the layout
 * resolvers: `raw/archive-media-bindings.sqlite` in a folder account, beside
 * the record for a legacy one. Names are Personal; the table holds paths and
 * versions, never content. Removing an archive forgets its bindings; deleting
 * the source takes the file.
 *
 * Nothing here names a source or a format.
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ArchiveMediaAccess, ArchiveMediaBindResult } from '../../core/archive-formats.ts';
import { assertSqliteSchemaCanOpen, runSqliteMigrations, type SqliteMigration } from '../../core/sqlite-migrations.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import {
  SCOPE_FILE_MAX_RANGE_BYTES,
  ScopeSafeError,
  sameScopeFileVersion,
  splitRelative,
  type ScopeFileReader,
  type ScopeFileVersion,
  type ScopeRoot,
} from '../../core/scope-safe-fs.ts';
import { resolvedRawPath } from '../../core/source-placement.ts';
import { recordAccountPlacement } from '../../core/source-storage.ts';
import type { ArchiveManifestCheck } from './manifest.ts';
import { ARCHIVE_IMPORTS_SOURCE_ID } from './state.ts';

export const ARCHIVE_MEDIA_BINDINGS_STORE_ID = 'archive-media-bindings';
const SCHEMA_VERSION = 1;
export const ARCHIVE_MEDIA_BINDINGS_FILE = 'archive-media-bindings.sqlite' as const;

/**
 * Bindings checked before the verification yields to the scheduler.
 */
export const ARCHIVE_MEDIA_VERIFY_BATCH = 500;

/**
 * The most `ArchiveMediaAccess.read` returns when the caller names no limit:
 * a media file can be gigabytes, and a whole-file read is never unbounded.
 * Larger files are read in ranges through `open`.
 */
export const ARCHIVE_MEDIA_DEFAULT_READ_BYTES = SCOPE_FILE_MAX_RANGE_BYTES;

/**
 * The bindings file beside an archive record: the same folder whether the
 * account lives in its own folder or in the legacy data folder, which is what
 * the layout resolvers give the record and this file alike.
 */
export function archiveMediaBindingsPath(statePath: string): string {
  return join(dirname(statePath), ARCHIVE_MEDIA_BINDINGS_FILE);
}

/**
 * Where the bindings file is for an environment, from the layout resolver the
 * record's path comes from.
 */
export function defaultArchiveMediaBindingsPath(env: Record<string, string | undefined> = process.env): string {
  return resolvedRawPath(ARCHIVE_IMPORTS_SOURCE_ID, ARCHIVE_MEDIA_BINDINGS_FILE, env);
}

export interface ArchiveMediaBinding {
  archiveId: string;
  bindingId: string;
  /** Under the chosen folder. A name: Personal, never in a locator. */
  relPath: string;
  version: ScopeFileVersion;
  boundAt: string;
}

function migrations(): SqliteMigration[] {
  return [{
    version: 1,
    name: 'create_append_only_media_bindings',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS media_bindings (
          archive_id TEXT NOT NULL,
          binding_id TEXT NOT NULL,
          rel_path TEXT NOT NULL,
          dev TEXT NOT NULL,
          ino TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          bound_at TEXT NOT NULL,
          PRIMARY KEY (archive_id, binding_id),
          UNIQUE (archive_id, rel_path)
        ) WITHOUT ROWID;
        CREATE TRIGGER IF NOT EXISTS media_bindings_append_only
          BEFORE UPDATE ON media_bindings
          BEGIN
            SELECT RAISE(ABORT, 'media bindings are append-only');
          END;
      `);
    },
  }];
}

interface BindingRow {
  archive_id: string;
  binding_id: string;
  rel_path: string;
  dev: string;
  ino: string;
  size: number;
  mtime_ms: number;
  bound_at: string;
}

function bindingOf(row: BindingRow): ArchiveMediaBinding {
  return {
    archiveId: row.archive_id,
    bindingId: row.binding_id,
    relPath: row.rel_path,
    version: { dev: row.dev, ino: row.ino, size: row.size, mtimeMs: row.mtime_ms },
    boundAt: row.bound_at,
  };
}

/**
 * The binding of a path is a function of the archive and the path alone, so a
 * replay binds the same path to the same id without asking the table first.
 */
export function mediaBindingId(archiveId: string, relPath: string): string {
  return `mb-${createHash('sha256').update(`${archiveId}\0${relPath}`).digest('hex').slice(0, 32)}`;
}

export class ArchiveMediaBindingStore {
  readonly path: string;
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(options: { path: string; env?: Record<string, string | undefined>; now?: () => Date }) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
    if (options.path !== ':memory:') {
      // This can be the account's first file, before any store opened.
      recordAccountPlacement({ sourceId: ARCHIVE_IMPORTS_SOURCE_ID }, options.path, options.env ?? process.env);
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(options.path, { create: true });
    if (options.path !== ':memory:') chmodSync(options.path, 0o600);
    // FULL: a binding must be on disk before the child row that names it is.
    this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    assertSqliteSchemaCanOpen(this.db, ARCHIVE_MEDIA_BINDINGS_STORE_ID, SCHEMA_VERSION);
    runSqliteMigrations(this.db, ARCHIVE_MEDIA_BINDINGS_STORE_ID, migrations());
  }

  /**
   * Binds a path at the version given. A path already bound keeps its first
   * binding: the table is append-only, and a file that changed since is found
   * by the check, not rewritten here.
   */
  bind(archiveId: string, relPath: string, version: ScopeFileVersion): ArchiveMediaBinding {
    const bindingId = mediaBindingId(archiveId, relPath);
    this.db.query(`
      INSERT OR IGNORE INTO media_bindings (archive_id, binding_id, rel_path, dev, ino, size, mtime_ms, bound_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(archiveId, bindingId, relPath, version.dev, version.ino, version.size, version.mtimeMs, this.now().toISOString());
    return this.get(archiveId, bindingId)!;
  }

  get(archiveId: string, bindingId: string): ArchiveMediaBinding | undefined {
    const row = this.db.query('SELECT * FROM media_bindings WHERE archive_id = ? AND binding_id = ?')
      .get(archiveId, bindingId) as BindingRow | null;
    return row ? bindingOf(row) : undefined;
  }

  count(archiveId: string): number {
    const row = this.db.query('SELECT COUNT(*) AS n FROM media_bindings WHERE archive_id = ?').get(archiveId) as { n: number };
    return row.n;
  }

  /**
   * One bounded page of an archive's bindings, in binding order, after `after`.
   */
  page(archiveId: string, after: string | undefined, limit: number): ArchiveMediaBinding[] {
    const rows = this.db.query(`
      SELECT * FROM media_bindings WHERE archive_id = ? AND binding_id > ? ORDER BY binding_id LIMIT ?
    `).all(archiveId, after ?? '', Math.max(1, limit)) as BindingRow[];
    return rows.map(bindingOf);
  }

  /**
   * Forgets every binding of an archive: the one way a binding leaves the
   * table, once nothing derived from the archive is left.
   */
  forgetArchive(archiveId: string): number {
    return this.db.query('DELETE FROM media_bindings WHERE archive_id = ?').run(archiveId).changes;
  }

  close(): void {
    closeSqliteStore(this.db);
  }
}

/**
 * The bindings file of one record, opened when something needs it and not
 * before: an install that never imports a chat export creates no file. One
 * connection for the life of the runtime.
 */
export interface ArchiveMediaBindings {
  readonly path: string;
  /** The store, created on first need (a bind). */
  open(): ArchiveMediaBindingStore;
  /** The store if the file exists already; undefined otherwise, creating nothing. */
  peek(): ArchiveMediaBindingStore | undefined;
  /** Forgets an archive's bindings; nothing to do when there is no file. */
  forgetArchive(archiveId: string): number;
  close(): void;
}

export function createArchiveMediaBindings(options: {
  path: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}): ArchiveMediaBindings {
  let store: ArchiveMediaBindingStore | undefined;
  let closed = false;
  const open = (): ArchiveMediaBindingStore => {
    if (closed) throw new Error('The media bindings are closed.');
    store ??= new ArchiveMediaBindingStore(options);
    return store;
  };
  const peek = (): ArchiveMediaBindingStore | undefined => {
    if (closed) return undefined;
    if (store) return store;
    return existsSync(options.path) ? open() : undefined;
  };
  return {
    path: options.path,
    open,
    peek,
    forgetArchive: (archiveId) => peek()?.forgetArchive(archiveId) ?? 0,
    close() {
      closed = true;
      store?.close();
      store = undefined;
    },
  };
}

/**
 * The connector's media access for one archive over the folder the person
 * chose (`chosenRelPath` is empty for a folder, a file's name for a single
 * chosen file or archive file).
 */
export function archiveMediaAccess(input: {
  bindings: ArchiveMediaBindings;
  archiveId: string;
  root: ScopeRoot;
  chosenRelPath: string;
}): ArchiveMediaAccess {
  const { bindings, archiveId, root } = input;
  const bound = (bindingId: string): ArchiveMediaBinding => {
    const binding = bindings.peek()?.get(archiveId, bindingId);
    // A locator can only name a binding that was written before it; one that is
    // not there names a version that is gone.
    if (!binding) throw new ScopeSafeError('not_found', 'no such binding');
    return binding;
  };
  const open = (bindingId: string): ScopeFileReader => {
    const binding = bound(bindingId);
    return root.openFile(binding.relPath, { expected: binding.version });
  };
  return {
    bind(requested): ArchiveMediaBindResult {
      // The choice of one file approved that file and nothing beside it.
      if (input.chosenRelPath !== '') return { ok: false, reason: 'chosen_file' };
      let relPath: string;
      let stat;
      try {
        // One spelling per file: a path with doubled separators binds as the plain one.
        relPath = splitRelative(requested).join('/');
        stat = root.statRelative(relPath);
      } catch (error) {
        if (error instanceof ScopeSafeError) {
          if (error.code === 'not_found') return { ok: false, reason: 'missing' };
          if (error.code === 'escape' || error.code === 'not_regular' || error.code === 'changed') {
            return { ok: false, reason: 'not_regular' };
          }
        }
        return { ok: false, reason: 'unreadable' };
      }
      // A placeholder would start a download when read; a link or a folder is not a file.
      if (stat.kind !== 'file' || stat.dataless) return { ok: false, reason: 'not_regular' };
      const binding = bindings.open().bind(archiveId, relPath, {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      return { ok: true, bindingId: binding.bindingId, sizeBytes: binding.version.size };
    },
    open,
    read(bindingId, options = {}) {
      const reader = open(bindingId);
      try {
        const size = reader.size;
        if (size > (options.maxBytes ?? ARCHIVE_MEDIA_DEFAULT_READ_BYTES)) throw new ScopeSafeError('too_large');
        const out = new Uint8Array(size);
        for (let offset = 0; offset < size; offset += SCOPE_FILE_MAX_RANGE_BYTES) {
          out.set(reader.readAt(offset, Math.min(SCOPE_FILE_MAX_RANGE_BYTES, size - offset)), offset);
        }
        // Read whole, then checked: the file under the descriptor and at its name is still the bound one.
        reader.assertCurrent();
        return out;
      } finally {
        reader.close();
      }
    },
  };
}

/**
 * Whether every bound media file is still the version it was bound at,
 * from metadata alone, in bounded batches that yield between them. The
 * manifest's check (`verifyArchiveManifest`) covers the manifest's own files;
 * an import is whole when both hold. Undefined when asked to stop first.
 */
export async function verifyArchiveMediaBindings(input: {
  bindings: ArchiveMediaBindings;
  archiveId: string;
  root: ScopeRoot;
  shouldContinue: () => boolean;
  batch?: number;
}): Promise<ArchiveManifestCheck | undefined> {
  const store = input.bindings.peek();
  if (!store) return { ok: true };
  const batch = Math.max(1, input.batch ?? ARCHIVE_MEDIA_VERIFY_BATCH);
  let after: string | undefined;
  for (;;) {
    if (!input.shouldContinue()) return undefined;
    const page = store.page(input.archiveId, after, batch);
    for (const binding of page) {
      const check = checkBinding(input.root, binding);
      if (!check.ok) return check;
    }
    if (page.length < batch) return { ok: true };
    after = page[page.length - 1]!.bindingId;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function checkBinding(root: ScopeRoot, binding: ArchiveMediaBinding): ArchiveManifestCheck {
  let stat;
  try {
    stat = root.statRelative(binding.relPath);
  } catch (error) {
    if (error instanceof ScopeSafeError && error.code === 'not_found') {
      return { ok: false, code: 'file_missing', relPath: binding.relPath, message: 'A media file of this archive is no longer there.' };
    }
    if (error instanceof ScopeSafeError && (error.code === 'escape' || error.code === 'not_regular' || error.code === 'changed')) {
      return { ok: false, code: 'file_changed', relPath: binding.relPath, message: 'A media file of this archive was replaced.' };
    }
    return { ok: false, code: 'file_unreadable', relPath: binding.relPath, message: 'A media file of this archive could not be opened.' };
  }
  const now: ScopeFileVersion = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  if (stat.kind !== 'file' || !sameScopeFileVersion(now, binding.version)) {
    return { ok: false, code: 'file_changed', relPath: binding.relPath, message: 'A media file of this archive changed since it was bound.' };
  }
  return { ok: true };
}
