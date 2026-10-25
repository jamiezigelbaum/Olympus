// P1b data lifecycle: a tiered store set's ledger (the secure store's
// co-located ledger), its secret-locations index (beside the same store) and
// its on-demand Public store are all in the lifecycle inventory, so
// `delete --source` takes exactly that source's files, relocated or not, and
// `delete --all` takes every one.

import { resolvedStorePath } from '../src/core/source-placement.ts';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { deleteOlympusData, lifecycleAccountFiles } from '../src/data-lifecycle.ts';
import { SecretLocationsIndex, secretLocationsPathForStore } from '../src/workers/classification/secret-locations.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import {
  GMAIL_PUBLIC_CONNECTOR_CORPUS_ID,
} from '../src/workers/google-connectors/index.ts';

function seed(secureStorePath: string, publicStorePath: string, provider: string): string[] {
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(secureStorePath) });
  const secrets = new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureStorePath) });
  const publicStore = new LocalConnectorStore({
    dbPath: publicStorePath,
    corpusId: GMAIL_PUBLIC_CONNECTOR_CORPUS_ID,
    family: 'email',
    trustDomain: 'public_safe',
    tierLedger: ledger,
  });
  try {
    ledger.commitSetCursor(`${provider}.set`, provider, 'cursor-1');
    secrets.record({
      identity: { provider, accountScope: 'personal', providerItemId: `${provider}-secret` },
      locator: `/${provider}/env.txt`,
      findingKinds: ['aws_access_key_id'],
    });
  } finally {
    publicStore.close();
    secrets.close();
    ledger.close();
  }
  return [tieredStoreSetLedgerPath(secureStorePath), secretLocationsPathForStore(secureStorePath), publicStorePath];
}

describe('tiered store sets are covered by data deletion', () => {
  test('the Public stores are in their sources\' inventory', () => {
    const env = { HOME: '/home/owner', XDG_DATA_HOME: '/data' };
    const paths = (sourceId: string) => lifecycleAccountFiles(sourceId, { env }).stores;
    expect(paths('gmail.email')).toContain(resolvedStorePath('gmail.email', 'public_safe', env));
    expect(paths('google_drive.docs')).toContain(resolvedStorePath('google_drive.docs', 'public_safe', env));
  });

  test('delete --source takes the set ledger, the secret-locations index and the Public store of that source only, even relocated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-set-lifecycle-'));
    try {
      const homeDir = join(dir, 'home');
      const env = {
        HOME: homeDir,
        XDG_DATA_HOME: join(dir, 'xdg-data'),
        // The Drive secure store (and so its set ledger and secret index) and
        // the Gmail Public store are relocated outside every Olympus root.
        OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_SECURE_CONNECTOR_STORE_DB_PATH: join(dir, 'elsewhere', 'drive-secure.sqlite'),
        OLYMPUS_SOURCE_INDEX_GMAIL_PUBLIC_CONNECTOR_STORE_DB_PATH: join(dir, 'elsewhere', 'gmail-public.sqlite'),
      };
      const gmail = seed(resolvedStorePath('gmail.email', 'secure_local', env), resolvedStorePath('gmail.email', 'public_safe', env), 'gmail');
      const drive = seed(resolvedStorePath('google_drive.docs', 'secure_local', env), resolvedStorePath('google_drive.docs', 'public_safe', env), 'google_drive');
      for (const path of [...gmail, ...drive]) expect(existsSync(path)).toBe(true);

      deleteOlympusData({ sourceId: 'google_drive.docs', homeDir, env });
      for (const path of drive) expect(`${path}:${existsSync(path)}`).toBe(`${path}:false`);
      for (const path of gmail) expect(existsSync(path)).toBe(true);

      deleteOlympusData({ all: true, homeDir, env });
      for (const path of gmail) {
        expect(`${path}:${existsSync(path)}`).toBe(`${path}:false`);
        expect(existsSync(`${path}-wal`)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
