// Export is the first half of the documented exit ("export, then delete"), so
// what it writes has to be a snapshot the owner can actually restore from.
//
// Two defects sat in that half. A file copy of a live WAL store is not a
// snapshot: a checkpoint between the main-file copy and the sidecar copies
// installs already-committed pages into the live main file and truncates the
// WAL, so the copied pair can omit a transaction that committed BEFORE the
// export began — and the manifest still says success. And the WhatsApp
// connector store belonged to no lifecycle spec at all, so `delete --all`
// erased it (it lives inside a known Olympus root) while export never copied
// it or even reported it as skipped.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  exportDurabilityBoundary,
  exportOlympusData,
  lifecycleSourceSpecs,
  verifyOlympusDataExport,
} from '../src/data-lifecycle.ts';

const LIFECYCLE_SOURCE = readFileSync(join(import.meta.dir, '..', 'src', 'data-lifecycle.ts'), 'utf8');

const openStores: Database[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
});

/**
 * Seeds a store and leaves the writer OPEN. Closing it checkpoints the WAL
 * back into the main file, which is exactly the state these tests must not be
 * in: the committed row has to still live only in the sidecar when the export
 * runs.
 */
function seedWalStore(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  openStores.push(db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  db.query('INSERT INTO rows (value) VALUES (?)').run(value);
}

function readSnapshotRows(path: string): unknown[] {
  const snapshot = new Database(path, { readonly: true });
  try {
    return snapshot.query('SELECT value FROM rows').all();
  } finally {
    snapshot.close();
  }
}

function whatsappStorePath(homeDir: string): string {
  // The installer's default, read independently of the lifecycle inventory
  // under test (scripts/ops/install-private-host-whatsapp-live-drain-systemd.sh).
  return join(homeDir, '.local', 'share', 'olympus', 'whatsapp-live', 'connector-store.db');
}

describe('data export produces a verified crash-durable snapshot', () => {
  test('a transaction still living in the WAL survives into the exported file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-export-snapshot-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'x.bookmarks')!;
      const storePath = spec.connectorStorePaths!({ homeDir })[0]!;
      seedWalStore(storePath, 'committed-before-export');
      expect(existsSync(`${storePath}-wal`)).toBe(true);

      const result = exportOlympusData({ destination, sourceId: 'x.bookmarks', homeDir });

      const exported = result.files.find((file) => file.endsWith('/x-bookmarks-connector-store.sqlite'));
      expect(exported).toBeDefined();
      // Opened WITHOUT its sidecars: a consolidated snapshot carries the
      // committed row on its own, a copied main file does not.
      expect(readSnapshotRows(exported!)).toEqual([{ value: 'committed-before-export' }]);
      expect(existsSync(`${exported!}-wal`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the published snapshot passes an integrity check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-export-integrity-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'x.bookmarks')!;
      seedWalStore(spec.connectorStorePaths!({ homeDir })[0]!, 'integrity');

      const result = exportOlympusData({ destination, sourceId: 'x.bookmarks', homeDir });

      const exported = result.files.find((file) => file.endsWith('/x-bookmarks-connector-store.sqlite'))!;
      const snapshot = new Database(exported, { readonly: true });
      try {
        expect(snapshot.query('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      } finally {
        snapshot.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a declared path that is not a SQLite database fails closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-export-nonsqlite-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'x.bookmarks')!;
      const storePath = spec.connectorStorePaths!({ homeDir })[0]!;
      mkdirSync(dirname(storePath), { recursive: true });
      writeFileSync(storePath, 'not a database');

      expect(() => exportOlympusData({ destination, sourceId: 'x.bookmarks', homeDir }))
        .toThrow('Declared Olympus SQLite store is not a readable database');
      expect(existsSync(join(destination, 'manifest.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the WhatsApp connector store that delete --all erases is in the inventory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-export-whatsapp-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'whatsapp.personal.messages');
      expect(spec).toBeDefined();
      expect(spec!.connectorStorePaths!({ homeDir })).toEqual([whatsappStorePath(homeDir)]);

      seedWalStore(whatsappStorePath(homeDir), 'whatsapp-chat-history');

      const result = exportOlympusData({ destination, homeDir });

      const exported = result.files.find((file) => file.includes('whatsapp.personal.messages'));
      expect(exported).toBeDefined();
      expect(readSnapshotRows(exported!)).toEqual([{ value: 'whatsapp-chat-history' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Every fsync in the export hangs off the directory chain leading to it, and
  // `mkdir -p` builds that chain silently. A dated backup target
  // (--output ~/exports/olympus/2026-08-18, with ~/exports/olympus absent)
  // creates two levels; flushing only the destination's parent leaves the
  // topmost new entry unwritten, so a power loss takes the entire export —
  // manifest included — while every file inside it was durably synced.
  test('the durability boundary is the deepest directory the export did not create', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-export-boundary-'));
    try {
      const twoLevelsMissing = join(dir, 'exports', 'olympus', '2026-08-18');
      expect(exportDurabilityBoundary(twoLevelsMissing)).toBe(dir);

      mkdirSync(dirname(twoLevelsMissing), { recursive: true });
      // Nothing new to create, so the parent is the boundary again.
      expect(exportDurabilityBoundary(twoLevelsMissing)).toBe(dirname(twoLevelsMissing));

      // An fsync leaves no trace in the exported tree, so which boundary the
      // export walks to is pinned in the one place it is visible.
      expect(LIFECYCLE_SOURCE).toContain('const durabilityBoundary = exportDurabilityBoundary(destination);');
      expect(LIFECYCLE_SOURCE).not.toContain('durabilityBoundary = dirname(');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an export into a destination two levels below anything that exists still publishes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-export-deep-destination-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'exports', 'olympus', '2026-08-18');
    try {
      const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'x.bookmarks')!;
      seedWalStore(spec.connectorStorePaths!({ homeDir })[0]!, 'deep-destination');

      const result = exportOlympusData({ destination, sourceId: 'x.bookmarks', homeDir });

      expect(result.files.at(-1)).toBe(join(destination, 'manifest.json'));
      expect(existsSync(join(destination, 'manifest.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Both new failure messages tell the owner to retry, and the natural retry
  // reuses --output. The retry starts replacing the snapshots the standing
  // manifest describes, so a manifest that survives a failed second run
  // describes a mixture of two exports while reading as a completed one.
  test('a failed retry into the same destination leaves no manifest standing over it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-export-retry-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'x.bookmarks')!;
      const storePath = spec.connectorStorePaths!({ homeDir })[0]!;
      seedWalStore(storePath, 'first-run');

      exportOlympusData({ destination, sourceId: 'x.bookmarks', homeDir });
      expect(existsSync(join(destination, 'manifest.json'))).toBe(true);

      // A store the retry cannot read at all: the run aborts after it has
      // begun rewriting the destination.
      for (const path of [storePath, `${storePath}-wal`, `${storePath}-shm`]) rmSync(path, { force: true });
      mkdirSync(storePath, { recursive: true });

      expect(() => exportOlympusData({ destination, sourceId: 'x.bookmarks', homeDir })).toThrow();
      expect(existsSync(join(destination, 'manifest.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the manifest names only files that are already on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-export-manifest-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'x.bookmarks')!;
      seedWalStore(spec.connectorStorePaths!({ homeDir })[0]!, 'manifest-ordering');

      const result = exportOlympusData({ destination, homeDir });

      const manifestPath = join(destination, 'manifest.json');
      expect(result.files.at(-1)).toBe(manifestPath);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: string[] };
      expect(manifest.files).not.toContain(manifestPath);
      expect(manifest.files.length).toBeGreaterThan(0);
      for (const file of manifest.files) expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the v2 manifest hashes every artifact and verifies independently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-export-verify-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'x.bookmarks')!;
      seedWalStore(spec.connectorStorePaths!({ homeDir })[0]!, 'verified');

      const exported = exportOlympusData({ destination, sourceId: 'x.bookmarks', homeDir });
      expect(exported.artifacts).toHaveLength(1);
      expect(exported.artifacts[0]).toMatchObject({
        sourceId: 'x.bookmarks',
        role: 'connector_store',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sqlite: {
          integrityCheck: 'ok',
          foreignKeyViolations: 0,
          expectedStoreId: 'connector-store',
        },
      });

      expect(verifyOlympusDataExport({ destination })).toMatchObject({
        ok: true,
        artifactCount: 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verification refuses a changed artifact and a traversal path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-export-tamper-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'x.bookmarks')!;
      seedWalStore(spec.connectorStorePaths!({ homeDir })[0]!, 'verified');
      const exported = exportOlympusData({ destination, sourceId: 'x.bookmarks', homeDir });
      writeFileSync(join(destination, exported.artifacts[0]!.relativePath), 'changed');
      expect(() => verifyOlympusDataExport({ destination })).toThrow('failed verification');

      const manifestPath = join(destination, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { artifacts: Array<Record<string, unknown>> };
      manifest.artifacts[0]!.relativePath = '../outside.sqlite';
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => verifyOlympusDataExport({ destination })).toThrow('unsafe artifact path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
