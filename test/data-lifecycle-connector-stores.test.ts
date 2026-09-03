// The lifecycle inventory has to name the stores the read path actually reads.
//
// `delete --all` erases every connector store, because they live inside the
// known Olympus roots it removes recursively. Export and per-source delete
// walked a different, older inventory — the five grandfathered per-family
// indexes — so the documented exit (export, then delete) reported success
// while omitting the live corpora, and X bookmarks, which has no legacy index
// at all, could not be exported by any command.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  deleteOlympusData,
  exportOlympusData,
  lifecycleSourceSpecs,
} from '../src/data-lifecycle.ts';
import { defaultDropboxConnectorStoreDbPath } from '../src/workers/dropbox-files/index.ts';
import {
  defaultGmailConnectorStoreDbPath,
  defaultGmailSecureConnectorStoreDbPath,
  defaultGoogleDriveConnectorStoreDbPath,
  defaultGoogleDriveSecureConnectorStoreDbPath,
} from '../src/workers/google-connectors/index.ts';
import { defaultReadwiseConnectorStoreDbPath } from '../src/workers/readwise/index.ts';
import {
  defaultInternalTelegramConnectorStoreDbPath,
  defaultProtectedTelegramConnectorStoreDbPath,
} from '../src/workers/telegram-messages/index.ts';
import { defaultXBookmarksConnectorStoreDbPath } from '../src/workers/x-bookmarks/index.ts';

// The path helpers are the oracle here, read independently of the lifecycle
// inventory under test. Reflect and Roam have no worker helper to read, so
// their product paths are declared explicitly beside the other product paths.
function connectorStorePaths(homeDir: string) {
  const env = { HOME: homeDir, XDG_DATA_HOME: join(homeDir, '.local', 'share') };
  return {
    gmail: defaultGmailConnectorStoreDbPath(env),
    gmailSecure: defaultGmailSecureConnectorStoreDbPath(env),
    drive: defaultGoogleDriveConnectorStoreDbPath(env),
    driveSecure: defaultGoogleDriveSecureConnectorStoreDbPath(env),
    dropbox: defaultDropboxConnectorStoreDbPath(env),
    readwise: defaultReadwiseConnectorStoreDbPath(env),
    telegramInternal: defaultInternalTelegramConnectorStoreDbPath(env),
    telegramProtected: defaultProtectedTelegramConnectorStoreDbPath(env),
    xBookmarks: defaultXBookmarksConnectorStoreDbPath(env),
    reflect: join(homeDir, '.local', 'share', 'openclaw', 'olympus', 'reflect-notes.sqlite'),
    roam: join(homeDir, '.local', 'share', 'openclaw', 'olympus', 'roam-notes.sqlite'),
  };
}

function seedStores(homeDir: string) {
  const paths = connectorStorePaths(homeDir);
  for (const path of Object.values(paths)) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true });
    db.exec('CREATE TABLE preserved (value TEXT NOT NULL);');
    db.query('INSERT INTO preserved (value) VALUES (?)').run(`store bytes for ${path}`);
    db.close();
  }
  return paths;
}

describe('lifecycle inventory covers the connector stores', () => {
  test('export copies every family connector store, including X which has no legacy index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-store-export-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const paths = seedStores(homeDir);
      const result = exportOlympusData({ destination, homeDir });

      for (const [name, path] of Object.entries(paths)) {
        const copied = result.files.some((file) => file.endsWith(`/${path.split('/').pop()!}`));
        expect(`${name}:${copied}`).toBe(`${name}:true`);
      }
      expect(result.sourceIds).toContain('x.bookmarks');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete --source removes that family connector stores and leaves the others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-store-delete-'));
    const homeDir = join(dir, 'home');
    try {
      const paths = seedStores(homeDir);

      const result = deleteOlympusData({ sourceId: 'gmail.email', homeDir });

      expect(result.removed).toContain(paths.gmail);
      expect(result.removed).toContain(paths.gmailSecure);
      expect(existsSync(paths.gmail)).toBe(false);
      expect(existsSync(paths.gmailSecure)).toBe(false);
      expect(existsSync(paths.dropbox)).toBe(true);
      expect(existsSync(paths.xBookmarks)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete --source x.bookmarks removes the only store that corpus has', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-x-delete-'));
    const homeDir = join(dir, 'home');
    try {
      const paths = seedStores(homeDir);

      const result = deleteOlympusData({ sourceId: 'x.bookmarks', homeDir });

      expect(result.removed).toContain(paths.xBookmarks);
      expect(existsSync(paths.xBookmarks)).toBe(false);
      expect(existsSync(paths.gmail)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete --source reflect.notes takes the note store and leaves its Roam twin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-reflect-delete-'));
    const homeDir = join(dir, 'home');
    try {
      const paths = seedStores(homeDir);

      const result = deleteOlympusData({ sourceId: 'reflect.notes', homeDir });

      expect(result.removed).toContain(paths.reflect);
      expect(existsSync(paths.reflect)).toBe(false);
      expect(existsSync(paths.roam)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The inventory drifted out of the mount list twice (X bookmarks, then
  // WhatsApp, then the two note stores), each time silently: an unlisted store
  // is not exported and not reported as skipped, while `delete --all` still
  // erases the root it lives in. This binds the two lists so the next mount
  // cannot land without an inventory entry.
  test('every product connector store belongs to a lifecycle spec', () => {
    const homeDir = join(tmpdir(), 'olympus-lifecycle-mount-inventory');
    const inventory = new Set(lifecycleSourceSpecs().flatMap((spec) => spec.connectorStorePaths?.({ homeDir }) ?? []));
    const mounted = Object.values(connectorStorePaths(homeDir));

    expect(mounted).toHaveLength(11);
    for (const dbPath of mounted) {
      expect(`${dbPath}:${inventory.has(dbPath)}`).toBe(`${dbPath}:true`);
    }
  });

  test('every spec declares either a legacy index or a connector store', () => {
    for (const spec of lifecycleSourceSpecs()) {
      const hasLegacyIndex = spec.sqlitePath !== undefined;
      const hasConnectorStore = (spec.connectorStorePaths?.({ homeDir: '/tmp/olympus-lifecycle-shape' }) ?? []).length > 0;
      expect(`${spec.sourceId}:${hasLegacyIndex || hasConnectorStore}`).toBe(`${spec.sourceId}:true`);
    }
  });
});
