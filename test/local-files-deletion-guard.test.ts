import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetScopeSafeNativeForTests, scopeSafeNativeForTests } from '../src/core/scope-safe-fs.ts';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { defaultLocalFilesIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  createLocalFilesSourceConnector,
  LOCAL_FILES_POLL_CURSOR,
  localFilesItemId,
} from '../src/workers/local-files/connector.ts';
import { defaultExclusionContext, type DefaultExclusionContext } from '../src/workers/local-files/paths.ts';
import {
  createLocalFilesProviderStoreSyncHandler,
  type LocalFilesProviderStoreSyncHandler,
} from '../src/workers/local-files/provider-store-sync.ts';
import {
  decideLocalFilesPath,
  localFilesRoots,
  LOCAL_FILES_POLICY_SOURCE,
  type LocalFilesContentScope,
} from '../src/workers/local-files/scope.ts';
import {
  createLocalFilesConnectorStore,
} from '../src/workers/local-files/store.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { WatchHub } from '../src/workers/local-files/watch-hub.ts';
import { localFilesTestTierSet } from './helpers/lane-tier-sets.ts';
import { createLocalFilesDeletionGuards } from '../src/workers/local-files/deletion-guard.ts';

const clock = { now: 1_000_000 };

type Selection = { key: string; state: 'ingest' | 'metadata_only' | 'exclude' };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  resetScopeSafeNativeForTests(undefined);
  while (cleanups.length) await cleanups.pop()!();
});

interface Fixture {
  base: string;
  home: string;
  proj: string;
  store: LocalConnectorStore;
  scope: LocalFilesContentScope;
  context: DefaultExclusionContext;
  selections: Selection[];
  handler: (hub?: WatchHub | null) => LocalFilesProviderStoreSyncHandler;
  approvedKey: string;
  hub: WatchHub;
  snapshotDir: string;
}

function fixture(selectionFor: (proj: string) => Selection[] = (proj) => [{ key: proj, state: 'ingest' }]): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'local-files-')));
  const home = join(base, 'home');
  const proj = join(home, 'proj');
  mkdirSync(proj, { recursive: true });
  const env = {
    // The store goes where its layout puts it, under a home of its own.
    HOME: join(base, 'olympus-home'),
    [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(base, 'no-exclusions.json'),
  };
  const store = createLocalFilesConnectorStore(env, { policy: defaultLocalFilesIngestionPolicy({ stillImagesRead: false }) });
  const selections = selectionFor(proj);
  const context: DefaultExclusionContext = { ...defaultExclusionContext({}), home, syncedRoots: [] };
  const approval = { selections, wholeAccount: false };
  const scope: LocalFilesContentScope = {
    generation: 'a'.repeat(64),
    revision: '11111111-2222-4333-8444-555555555555',
    assertCurrent() {},
    decide: (path) => decideLocalFilesPath({ selections, wholeAccount: false }, path, context),
    snapshotDecider: () => (path) => decideLocalFilesPath({ selections, wholeAccount: false }, path, context),
    roots: () => localFilesRoots(approval),
  };
  const snapshotDir = join(base, 'watch');
  mkdirSync(snapshotDir, { recursive: true });
  const hub = new WatchHub();
  const deletionGuards = createLocalFilesDeletionGuards({ now: () => clock.now });
  const volumes = new VolumeResolver();
  cleanups.push(async () => {
    await hub.close();
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  return {
    base, home, proj, store, scope, context, selections, hub, snapshotDir,
    approvedKey: `${LOCAL_FILES_POLICY_SOURCE}:${proj}`,
    handler: (useHub: WatchHub | null = hub) => createLocalFilesProviderStoreSyncHandler({
      store,
      tierSet: localFilesTestTierSet(store),
      scope,
      volumes,
      snapshotDir,
      ...(useHub ? { hub: useHub } : {}),
      pageSize: 3,
      deletionGuards,
    }),
  };
}

/** The operating system reports file changes a moment after they happen. */
const settleFileEvents = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1500));

function names(store: LocalConnectorStore, query: string): string[] {
  return store.searchItems(query, 50, 'this_computer').map((row) => String(row.title ?? '')).sort();
}


describe('a folder that suddenly empties keeps its files', () => {
  const notes = (f: Fixture, count: number): void => {
    for (let index = 0; index < count; index += 1) writeFileSync(join(f.proj, `note-${index}.md`), `note body ${index}`);
  };
  const clear = (f: Fixture): void => {
    for (const name of readdirSync(f.proj)) rmSync(join(f.proj, name), { recursive: true, force: true });
  };

  test('an emptied folder deletes nothing, however often it is walked', async () => {
    const f = fixture();
    notes(f, 10);
    const handler = f.handler(null);
    await handler.pull({ approved_scope_key: f.approvedKey });
    expect(names(f.store, 'note')).toHaveLength(10);
    clear(f);
    for (let pass = 0; pass < 3; pass += 1) {
      clock.now += 120_000;
      const out = await handler.pull({ approved_scope_key: f.approvedKey });
      expect(out.receipt.counts.items_tombstoned).toBe(0);
      expect(out.receipt.counts.deletions_held).toBe(10);
      expect(out.receipt.warnings).toContain('local_files_deletions_held');
    }
    expect(names(f.store, 'note')).toHaveLength(10);
    // The files come back (the mirror finished): nothing was lost and the hold clears.
    notes(f, 10);
    clock.now += 120_000;
    const back = await handler.pull({ approved_scope_key: f.approvedKey });
    expect(back.receipt.counts.deletions_held).toBe(0);
    expect(names(f.store, 'note')).toHaveLength(10);
  });

  test('a large shrink waits for a second walk a minute later, then applies', async () => {
    const f = fixture();
    notes(f, 20);
    const handler = f.handler(null);
    await handler.pull({ approved_scope_key: f.approvedKey });
    for (let index = 0; index < 12; index += 1) rmSync(join(f.proj, `note-${index}.md`));
    const first = await handler.pull({ approved_scope_key: f.approvedKey });
    expect(first.receipt.counts.deletions_held).toBe(12);
    expect(names(f.store, 'note')).toHaveLength(20);
    // Too soon to agree.
    clock.now += 10_000;
    const soon = await handler.pull({ approved_scope_key: f.approvedKey });
    expect(soon.receipt.counts.deletions_held).toBe(12);
    clock.now += 60_000;
    const agreed = await handler.pull({ approved_scope_key: f.approvedKey });
    expect(agreed.receipt.counts.deletions_held).toBe(0);
    expect(names(f.store, 'note')).toHaveLength(8);
  });

  test('a small deletion applies at once', async () => {
    const f = fixture();
    notes(f, 20);
    const handler = f.handler(null);
    await handler.pull({ approved_scope_key: f.approvedKey });
    for (let index = 0; index < 3; index += 1) rmSync(join(f.proj, `note-${index}.md`));
    const out = await handler.pull({ approved_scope_key: f.approvedKey });
    expect(out.receipt.counts.deletions_held).toBe(0);
    expect(names(f.store, 'note')).toHaveLength(17);
  });
});
