import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConnectorStoreMountsFromEnv } from '../src/workers/email-source/server.ts';
import {
  createDropboxConnectorStore,
  DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
} from '../src/workers/dropbox-files/connector-store.ts';

describe('connector-store mount declaration guards', () => {
  // Every secure gate in the worker is exact equality against 'secure_local',
  // so a typo'd trust domain does not degrade the mount — it leaves the secure
  // band entirely and the store is handed the internal-band embedding provider.
  test.each([
    ['trustDomain', { trustDomain: 'secure-local' }, 'trustDomain must be one of'],
    ['trustDomain', { trustDomain: 'Secure_Local' }, 'trustDomain must be one of'],
    ['family', { family: 'notes' }, 'family must be one of'],
    ['family', { family: 'CHAT' }, 'family must be one of'],
  ] as const)('skips a declaration whose %s is not a declared enum value', (_field, override, detail) => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-mount-enum-'));
    const dbPath = join(dir, 'reflect-notes.sqlite');
    const failures: string[] = [];
    try {
      const mounts = parseConnectorStoreMountsFromEnv(JSON.stringify([{
        dbPath,
        corpusId: 'secure_local.reflect.notes',
        family: 'note',
        trustDomain: 'secure_local',
        ...override,
      }]), { reportFailure: (message) => failures.push(message) });

      expect(mounts).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('secure_local.reflect.notes skipped:');
      expect(failures[0]).toContain(detail);
      // Validation runs before any SQLite open, so the refused mount leaves no file.
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts the built-in enums and the extension id form', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-mount-enum-ok-'));
    const failures: string[] = [];
    let mounts: ReturnType<typeof parseConnectorStoreMountsFromEnv> = [];
    try {
      mounts = parseConnectorStoreMountsFromEnv(JSON.stringify([
        {
          dbPath: join(dir, 'reflect-notes.sqlite'),
          corpusId: 'secure_local.reflect.notes',
          family: 'note',
          trustDomain: 'secure_local',
        },
        {
          dbPath: join(dir, 'extension.sqlite'),
          corpusId: 'x-lab.fixture.items',
          family: 'x-lab',
          trustDomain: 'x-lab',
        },
      ]), { reportFailure: (message) => failures.push(message) });

      expect(failures).toEqual([]);
      expect(mounts.map((mount) => mount.store.corpusId)).toEqual([
        'secure_local.reflect.notes',
        'x-lab.fixture.items',
      ]);
    } finally {
      for (const mount of mounts) mount.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The identity reconcile is keyed on corpusId, but the resource it protects
  // is the SQLite file. A new corpus id over a lane store's dbPath used to skip
  // the fence entirely and open a second handle presenting the same rows under
  // whatever family/trustDomain the declaration stated.
  test('refuses a declaration pointing a new corpus id at a lane store dbPath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-mount-dbpath-'));
    const dbPath = join(dir, 'dropbox.sqlite');
    const laneStore = createDropboxConnectorStore({
      OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: dbPath,
      OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: join(dir, 'no-exclusions.json'),
    });
    const failures: string[] = [];
    try {
      const mounts = parseConnectorStoreMountsFromEnv(JSON.stringify([{
        dbPath,
        corpusId: 'internal.dropbox.files',
        family: 'file',
        trustDomain: 'internal',
      }]), {
        collidingStores: [laneStore],
        reportFailure: (message) => failures.push(message),
      });

      expect(mounts).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('internal.dropbox.files skipped:');
      expect(failures[0]).toContain('already mounted as corpus');
      expect(failures[0]).toContain(DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID);
    } finally {
      laneStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a second declaration in the same pass that reuses an accepted dbPath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-mount-dbpath-pass-'));
    const dbPath = join(dir, 'reflect-notes.sqlite');
    const failures: string[] = [];
    let mounts: ReturnType<typeof parseConnectorStoreMountsFromEnv> = [];
    try {
      mounts = parseConnectorStoreMountsFromEnv(JSON.stringify([
        {
          dbPath,
          corpusId: 'secure_local.reflect.notes',
          family: 'note',
          trustDomain: 'secure_local',
        },
        {
          dbPath,
          corpusId: 'internal.reflect.notes',
          family: 'note',
          trustDomain: 'internal',
        },
      ]), { reportFailure: (message) => failures.push(message) });

      expect(mounts.map((mount) => mount.store.corpusId)).toEqual(['secure_local.reflect.notes']);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('internal.reflect.notes skipped:');
      expect(failures[0]).toContain('already mounted as corpus');
    } finally {
      for (const mount of mounts) mount.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('still accepts a matching declaration for the lane store it collides with', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-mount-dbpath-match-'));
    const dbPath = join(dir, 'dropbox.sqlite');
    const laneStore = createDropboxConnectorStore({
      OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: dbPath,
      OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: join(dir, 'no-exclusions.json'),
    });
    const failures: string[] = [];
    try {
      const mounts = parseConnectorStoreMountsFromEnv(JSON.stringify([{
        dbPath,
        corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
        family: 'file',
        trustDomain: 'secure_local',
        principalProvider: 'dropbox',
        principalAccountScope: 'personal',
      }]), {
        collidingStores: [laneStore],
        reportFailure: (message) => failures.push(message),
      });

      expect(failures).toEqual([]);
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.store).toBe(laneStore);
    } finally {
      laneStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
