// Local files across the boot migration (docs/design/source-storage.md, "What
// must not break": local files catch up from the watch snapshot without a
// rescan). The real provider-store sync handler and the real file watcher run
// on an isolated data folder: a first pass indexes a folder and writes its
// change snapshot, the account is moved into its folder while Olympus is
// "stopped" and files change, and the next pass finds the changes from the
// snapshot where it now is, with no full listing.

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountFolder, olympusDataRoot } from '../src/core/olympus-layout.ts';
import { resetScopeSafeNativeForTests } from '../src/core/scope-safe-fs.ts';
import { MIGRATE_ACCOUNT_FOLDERS_ENV, migrateAccountFolders } from '../src/core/source-account-migration.ts';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { defaultLocalFilesIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { updateSourceRegistry } from '../src/core/source-registry.ts';
import { __sourceStorageTestHooks, enableSourceRegistryAdoption } from '../src/core/source-storage.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { defaultExclusionContext, type DefaultExclusionContext } from '../src/workers/local-files/paths.ts';
import { createLocalFilesProviderStoreSyncHandler } from '../src/workers/local-files/provider-store-sync.ts';
import {
  LOCAL_FILES_POLICY_SOURCE,
  decideLocalFilesPath,
  localFilesRoots,
  type LocalFilesContentScope,
} from '../src/workers/local-files/scope.ts';
import { createLocalFilesConnectorStore, localFilesWatchDir } from '../src/workers/local-files/store.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { WatchHub } from '../src/workers/local-files/watch-hub.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  resetScopeSafeNativeForTests(undefined);
  __sourceStorageTestHooks.disableAdoption();
  while (cleanups.length) await cleanups.pop()!();
});

/** The operating system reports file changes a moment after they happen. */
const settleFileEvents = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1500));

const names = (store: LocalConnectorStore, query: string): string[] =>
  store.searchItems(query, 50, 'this_computer').map((row) => String(row.title ?? '')).sort();

test('after the move, changes made while Olympus was stopped are found from the snapshot where it now is, with no rescan', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'olympus-migration-local-files-')));
  cleanups.push(async () => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const proj = join(home, 'proj');
  mkdirSync(proj, { recursive: true });
  const env: Record<string, string> = {
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    PATH: process.env.PATH ?? '',
    [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(base, 'no-exclusions.json'),
  };
  const policy = defaultLocalFilesIngestionPolicy({ stillImagesRead: false });
  const selections = [{ key: proj, state: 'ingest' as const }];
  const context: DefaultExclusionContext = { ...defaultExclusionContext({}), home, syncedRoots: [] };
  const approval = { selections, wholeAccount: false };
  const scope: LocalFilesContentScope = {
    generation: 'a'.repeat(64),
    revision: '11111111-2222-4333-8444-555555555555',
    assertCurrent() {},
    decide: (path) => decideLocalFilesPath(approval, path, context),
    snapshotDecider: () => (path) => decideLocalFilesPath(approval, path, context),
    roots: () => localFilesRoots(approval),
  };
  const approvedKey = `${LOCAL_FILES_POLICY_SOURCE}:${proj}`;
  // The account as a build from before the folders recorded it: legacy, so everything resolves to the old places.
  updateSourceRegistry(env, (registry) => {
    registry.accounts.push({
      source_id: 'local.files',
      slot: '1',
      state: 'active',
      layout: 'legacy',
      corpus_ids: ['secure_local.local.files'],
      created_at: '2026-10-01T00:00:00.000Z',
    });
  });
  const handler = (store: LocalConnectorStore, hub: WatchHub) => createLocalFilesProviderStoreSyncHandler({
    store,
    scope,
    volumes: new VolumeResolver(),
    snapshotDir: localFilesWatchDir(env),
    hub,
    pageSize: 3,
  });

  // Before: an account at the old places, as a build from before the folders left it.
  writeFileSync(join(proj, 'before-restart.txt'), 'one');
  writeFileSync(join(proj, 'gone-while-stopped.txt'), 'two');
  mkdirSync(localFilesWatchDir(env), { recursive: true });
  const firstHub = new WatchHub();
  cleanups.push(() => firstHub.close());
  const firstStore = createLocalFilesConnectorStore(env, { policy });
  const first = await handler(firstStore, firstHub).pull({ approved_scope_key: approvedKey });
  expect(names(firstStore, 'txt')).toEqual(['before-restart.txt', 'gone-while-stopped.txt']);
  firstStore.close();
  await firstHub.close();
  expect(localFilesWatchDir(env)).toBe(join(olympusDataRoot(env), 'local-files-watch'));

  // While Olympus is stopped, files change; the next boot moves the account.
  writeFileSync(join(proj, 'written-while-stopped.txt'), 'three');
  rmSync(join(proj, 'gone-while-stopped.txt'));
  // macOS keeps a closed connection's file open until it is collected, and a file renamed under it will not reopen.
  Bun.gc(true);
  const report = migrateAccountFolders({ ...env, [MIGRATE_ACCOUNT_FOLDERS_ENV]: '1' });
  expect(report, JSON.stringify(report)).toMatchObject({ moved: ['local.files'], movedBack: [], stuck: [] });
  enableSourceRegistryAdoption();
  const folder = accountFolder({ source_id: 'local.files', slot: '1' }, env);
  expect(localFilesWatchDir(env)).toBe(join(folder, 'raw', 'watch'));

  // After: a new process, a new hub, the store and the snapshot where they now are.
  const hub = new WatchHub();
  cleanups.push(() => hub.close());
  const store = createLocalFilesConnectorStore(env, { policy });
  cleanups.push(() => store.close());
  await settleFileEvents();
  const second = await handler(store, hub).pull({ approved_scope_key: approvedKey, checkpoint: first.checkpoint! });

  expect(second.receipt.counts.full_listing).toBe(0);
  expect(second.receipt.counts.history_reset ?? 0).toBe(0);
  expect(names(store, 'txt')).toEqual(['before-restart.txt', 'written-while-stopped.txt']);
}, 60_000);
