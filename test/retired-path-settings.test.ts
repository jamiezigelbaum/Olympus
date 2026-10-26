// The per-store path settings delivery step 6 retired are not read any more
// (docs/design/source-storage.md, owner decision 3). A worker started with one
// would open an empty store beside the account's real files, so the worker
// refuses to start, naming each; this is the list it names.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountStorePath } from '../src/core/olympus-layout.ts';
import { resolvedStorePath, retiredPathSettings } from '../src/core/source-placement.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'retired-path-settings-'));
  roots.push(home);
  return { HOME: home, XDG_DATA_HOME: join(home, 'data'), ...extra };
}

describe('retired path settings', () => {
  test('nothing set: nothing named', () => {
    expect(retiredPathSettings(env())).toEqual([]);
  });

  test('every OLYMPUS_*_DB_PATH and the archive record path are named; a blank one is not', () => {
    const found = retiredPathSettings(env({
      OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_DB_PATH: '/old/gmail.sqlite',
      OLYMPUS_WHATSAPP_LIVE_DRAIN_DB_PATH: ' /old/wa.db ',
      OLYMPUS_REMOTE_CONNECTIONS_DB_PATH: '/old/remote.sqlite',
      OLYMPUS_ARCHIVE_IMPORTS_STATE_PATH: '/old/archive-imports.json',
      OLYMPUS_FILE_EXTRACTION_JOBS_DB_PATH: '   ',
      OLYMPUS_TELEGRAM_SESSION_PATH: '/capture/telegram.session',
    }));
    expect(found).toEqual([
      'OLYMPUS_ARCHIVE_IMPORTS_STATE_PATH=/old/archive-imports.json',
      'OLYMPUS_REMOTE_CONNECTIONS_DB_PATH=/old/remote.sqlite',
      'OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_DB_PATH=/old/gmail.sqlite',
      'OLYMPUS_WHATSAPP_LIVE_DRAIN_DB_PATH=/old/wa.db',
    ]);
  });

  test('a mount that names a placed source\'s store elsewhere is named; at its own place, or for Reflect, it is not', () => {
    const base = env();
    const placed = resolvedStorePath('whatsapp.personal.messages', 'secure_local', base);
    const mounts = (dbPath: string) => JSON.stringify([
      { corpusId: 'secure_local.whatsapp.messages', family: 'chat', trustDomain: 'secure_local', dbPath },
      { corpusId: 'secure_local.reflect.notes', family: 'note', trustDomain: 'secure_local', dbPath: '/anywhere/reflect-notes.sqlite' },
    ]);
    expect(retiredPathSettings({ ...base, OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: mounts(placed) })).toEqual([]);
    // The usual legacy place stays fine after the boot migration moved the store into its folder.
    const legacy = accountStorePath({ source_id: 'whatsapp.personal.messages', slot: '1', layout: 'legacy' }, 'secure_local', base);
    expect(legacy).not.toBe(placed);
    expect(retiredPathSettings({ ...base, OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: mounts(legacy) })).toEqual([]);
    expect(retiredPathSettings({ ...base, OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: mounts('/old/wa/connector-store.db') })).toEqual([
      `OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON secure_local.whatsapp.messages dbPath=/old/wa/connector-store.db (Olympus keeps it at ${placed})`,
    ]);
  });
});
