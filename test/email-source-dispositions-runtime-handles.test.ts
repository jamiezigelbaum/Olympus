import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIngestionDispositionsRuntime } from '../src/workers/email-source/server.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

function seedStore(dbPath: string, corpusId: string, trustDomain: 'internal' | 'secure_local'): void {
  const store = new LocalConnectorStore({ dbPath, corpusId, family: 'file', trustDomain });
  store.close();
}

describe('ingestion dispositions runtime', () => {
  // The runtime accumulates read-only handles and hands back the only closer.
  // A throw from a later store open therefore escaped before the caller could
  // enter its `try { … } finally { runtime.close() }`, orphaning every handle
  // opened so far — on a page a refresh re-runs. The function already carries a
  // gate that refuses to compile as data; the store leg now does the same.
  test('carries a store that refuses to open as data instead of orphaning earlier handles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dispositions-runtime-'));
    try {
      const dropboxDb = join(dir, 'dropbox.sqlite');
      const driveInternalDb = join(dir, 'drive-internal.sqlite');
      const driveSecureTarget = join(dir, 'drive-secure-target.sqlite');
      const driveSecureDb = join(dir, 'drive-secure.sqlite');
      seedStore(dropboxDb, 'secure_local.dropbox.files', 'secure_local');
      seedStore(driveInternalDb, 'internal.google_drive.docs', 'internal');
      seedStore(driveSecureTarget, 'secure_local.google_drive.docs', 'secure_local');
      // existsSync follows the link, so the refusal lands inside the read-only
      // constructor — after the Drive internal handle is already open.
      symlinkSync(driveSecureTarget, driveSecureDb);

      const env = {
        OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: dropboxDb,
        OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CONNECTOR_STORE_DB_PATH: driveInternalDb,
        OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_SECURE_CONNECTOR_STORE_DB_PATH: driveSecureDb,
        OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: join(dir, 'no-exclusions.json'),
      };

      const runtime = openIngestionDispositionsRuntime(env);
      try {
        const dropbox = runtime.sources.find((source) => source.label === 'Dropbox');
        const drive = runtime.sources.find((source) => source.label === 'Google Drive');
        expect(dropbox?.store_present).toBe(true);
        expect(dropbox?.error).toBeUndefined();
        expect(drive?.store_present).toBe(false);
        expect(drive?.error).toContain('regular non-symlink database file');
        // The failing source names its corpora so the page can still say what
        // it could not read.
        expect(drive?.corpus_ids).toHaveLength(2);
      } finally {
        runtime.close();
      }

      // Every handle the runtime still owns is closable, and closing is
      // idempotent enough to survive a second call from the route's finally.
      expect(() => openIngestionDispositionsRuntime(env).close()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
