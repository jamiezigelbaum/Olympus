// P1c data lifecycle: every new tier store of the Dropbox, Readwise, X and
// WhatsApp lanes, and each lane's set ledger and secret-locations index (beside
// its secure_local store's path, created or not), are in the lifecycle
// inventory, so `delete --source` takes exactly that source's files, relocated
// or not, and `delete --all` takes every one.

import { resolvedStorePath } from '../src/core/source-placement.ts';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { SourceFamily, SourceTrustDomain } from '../src/core/source-index/types.ts';
import { deleteOlympusData, lifecycleAccountFiles } from '../src/data-lifecycle.ts';
import { SecretLocationsIndex, secretLocationsPathForStore } from '../src/workers/classification/secret-locations.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';

/** A lane's set ledger and secret index beside its secure path, plus its new tier stores. */
function seed(input: {
  provider: string;
  family: SourceFamily;
  securePath: string;
  newStores: ReadonlyArray<{ path: string; trustDomain: SourceTrustDomain; corpusId: string }>;
}): string[] {
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(input.securePath) });
  const secrets = new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(input.securePath) });
  const stores = input.newStores.map((spec) => new LocalConnectorStore({
    dbPath: spec.path,
    corpusId: spec.corpusId,
    family: input.family,
    trustDomain: spec.trustDomain,
    tierLedger: ledger,
  }));
  try {
    for (const store of stores) store.bindTierSet(ledger);
    ledger.commitSetCursor(`${input.provider}.set`, input.provider, 'cursor-1');
    secrets.record({
      identity: { provider: input.provider, accountScope: 'personal', providerItemId: `${input.provider}-secret` },
      locator: `/${input.provider}/env.txt`,
      findingKinds: ['aws_access_key_id'],
    });
  } finally {
    for (const store of stores) store.close();
    secrets.close();
    ledger.close();
  }
  return [
    tieredStoreSetLedgerPath(input.securePath),
    secretLocationsPathForStore(input.securePath),
    ...input.newStores.map((spec) => spec.path),
  ];
}

describe('P1c tier stores are covered by data deletion', () => {
  test('every new tier store is in its source\'s inventory', () => {
    const env = { HOME: '/home/owner', XDG_DATA_HOME: '/data' };
    const paths = (sourceId: string) => lifecycleAccountFiles(sourceId, { env }).stores;
    expect(paths('dropbox.files')).toEqual([
      resolvedStorePath('dropbox.files', 'secure_local', env),
      resolvedStorePath('dropbox.files', 'internal', env),
      resolvedStorePath('dropbox.files', 'public_safe', env),
    ]);
    expect(paths('readwise.library')).toEqual([
      resolvedStorePath('readwise.library', 'internal', env),
      resolvedStorePath('readwise.library', 'secure_local', env),
    ]);
    expect(paths('x.bookmarks')).toEqual([
      resolvedStorePath('x.bookmarks', 'internal', env),
      resolvedStorePath('x.bookmarks', 'secure_local', env),
    ]);
    expect(paths('whatsapp.personal.messages')).toEqual([
      resolvedStorePath('whatsapp.personal.messages', 'secure_local', env),
      resolvedStorePath('whatsapp.personal.messages', 'internal', env),
    ]);
  });

  test('delete --source takes a lane\'s set ledger, secret index and new tier stores only, even relocated; delete --all takes the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-p1c-lifecycle-'));
    try {
      const homeDir = join(dir, 'home');
      const elsewhere = join(dir, 'elsewhere');
      const env = {
        HOME: homeDir,
        XDG_DATA_HOME: join(dir, 'xdg-data'),
        // Relocated outside every Olympus root.
        OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: join(elsewhere, 'dropbox-secure.sqlite'),
        OLYMPUS_SOURCE_INDEX_DROPBOX_INTERNAL_CONNECTOR_STORE_DB_PATH: join(elsewhere, 'dropbox-internal.sqlite'),
        OLYMPUS_SOURCE_INDEX_READWISE_SECURE_CONNECTOR_STORE_DB_PATH: join(elsewhere, 'readwise-secure.sqlite'),
        OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH: join(elsewhere, 'whatsapp-internal.db'),
      };
      const dropbox = seed({
        provider: 'dropbox',
        family: 'file',
        securePath: resolvedStorePath('dropbox.files', 'secure_local', env),
        newStores: [
          { path: resolvedStorePath('dropbox.files', 'internal', env), trustDomain: 'internal', corpusId: 'internal.dropbox.files' },
          { path: resolvedStorePath('dropbox.files', 'public_safe', env), trustDomain: 'public_safe', corpusId: 'public_safe.dropbox.files' },
        ],
      });
      const readwise = seed({
        provider: 'readwise',
        family: 'readwise',
        securePath: resolvedStorePath('readwise.library', 'secure_local', env),
        newStores: [{ path: resolvedStorePath('readwise.library', 'secure_local', env), trustDomain: 'secure_local', corpusId: 'secure_local.readwise.library' }],
      });
      const x = seed({
        provider: 'x',
        family: 'x',
        securePath: resolvedStorePath('x.bookmarks', 'secure_local', env),
        newStores: [{ path: resolvedStorePath('x.bookmarks', 'secure_local', env), trustDomain: 'secure_local', corpusId: 'secure_local.x.bookmarks' }],
      });
      const whatsapp = seed({
        provider: 'whatsapp',
        family: 'chat',
        securePath: resolvedStorePath('whatsapp.personal.messages', 'secure_local', env),
        newStores: [{ path: resolvedStorePath('whatsapp.personal.messages', 'internal', env), trustDomain: 'internal', corpusId: 'internal.whatsapp.messages' }],
      });
      const all = [...dropbox, ...readwise, ...x, ...whatsapp];
      for (const path of all) expect(`${path}:${existsSync(path)}`).toBe(`${path}:true`);

      deleteOlympusData({ sourceId: 'dropbox.files', homeDir, env });
      for (const path of dropbox) expect(`${path}:${existsSync(path)}`).toBe(`${path}:false`);
      for (const path of [...readwise, ...x, ...whatsapp]) expect(existsSync(path)).toBe(true);

      deleteOlympusData({ sourceId: 'readwise.library', homeDir, env });
      for (const path of readwise) expect(`${path}:${existsSync(path)}`).toBe(`${path}:false`);
      for (const path of [...x, ...whatsapp]) expect(existsSync(path)).toBe(true);

      deleteOlympusData({ all: true, homeDir, env });
      for (const path of all) {
        expect(`${path}:${existsSync(path)}`).toBe(`${path}:false`);
        expect(existsSync(`${path}-wal`)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
