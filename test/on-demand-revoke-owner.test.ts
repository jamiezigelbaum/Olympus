import { afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { connectThisComputerSource } from '../src/core/this-computer.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createLaneTieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { createFileExtractionRuntime } from '../src/workers/engine/runtime/file-extraction-runtime.ts';
import { fixtureConnector, fixtureItem, expectHeldThenPersonal } from './helpers/tier-fixtures.ts';
import { createOwnerTierItems, ownerTierItemId } from '../src/workers/classification/tier-owner-items.ts';
import { FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';
import { createSourceExclusionMatcher } from '../src/core/source-ingestion-exclusions.ts';
import { waitFor } from './helpers/test-clock.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

async function fixture() {
  const dir = mkdtempSync('/tmp/on-demand-owner-');
  cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
  const stores = (['internal', 'secure_local'] as const).map(trustDomain => new LocalConnectorStore({
    corpusId: `${trustDomain}.local.files`, family: 'file', trustDomain, dbPath: join(dir, trustDomain + '.sqlite'),
  }));
  cleanups.push(() => stores.forEach(store => store.close()));
  const [home, sibling] = stores as [LocalConnectorStore, LocalConnectorStore];
  const body = 'quartzneedle';
  const corpusId = home.corpusId;
  const set = createLaneTieredStoreSet({ setId: corpusId, internalStore: home, secureStore: sibling });
  const registryPath = join(dir, 'handles.json');
  connectThisComputerSource(registryPath, 'local.files');
  const authority = new FileSourceScopeAuthority({ registryPath });
  const initial = authority.snapshot('local.files');
  const approval = authority.approve({ sourceId: 'local.files', accountGeneration: initial.accountGeneration!,
    expectedRevision: initial.revision, selections: [{ key: '/Files', state: 'on_demand' }],
    wholeAccount: false, explicitWholeAccountConfirmation: false });
  const item = fixtureItem({ id: 'report', name: 'report.txt' });
  item.identity.provider = 'local_files';
  await home.syncFromConnector({
    ...fixtureConnector(() => []),
    async *listItems() { yield { items: [item], done: true }; },
  }, {
    sourceScopeObservation: () => ({ accountGeneration: approval.accountGeneration!, scopeRevision: approval.revision }),
    fetchContent: false, placement: { trustTier: 'S2', trustDomain: 'internal' },
  });
  const runtime = createFileExtractionRuntime({
    enabled: true, env: { OLYMPUS_DATA_DIR: dir }, jobsDbPath: join(dir, 'jobs.sqlite'),
    connectorStores: [home], tierSets: new Map([[corpusId, set]]),
    corpora: [{ corpusId, provider: 'local_files', scopes: ['files:/Files'] }],
    onDemandPolicy: () => ({ allowed: true, readableOnRequest: true }),
    sourceFactories: new Map([['local_files', () => ({
      id: 'fixture', corpusId, provider: 'local_files', async listCandidates() { throw new Error('Individual reads do not list a folder'); },
      async fetch() { return { bytes: new TextEncoder().encode(body) }; },
    })]]),
  })!;
  cleanups.push(() => runtime.close());
  const worker = createEmailSourceWorker({
    ownerTierItems: createOwnerTierItems({ storePaths: stores.map(store => store.dbPath) }),
    connectorStores: stores, requestOnDemandRead: runtime.requestOnDemandRead,
    connectorStoreReadScope: () => ({ allowed: true, contentAllowed: false, filters: { metadataOnlyLocatorPathScopes: ['/Files'] } }),
    sourceDashboard: {
      registryPath, registryAdoptionIntervalMs: 0, sovereigntyEngine: { config: {} } as never,
      ingestionDispositions: () => ({ rulesPath: join(dir, 'rules.json'), sources: [{
        source_id: 'local.files', label: 'Files', corpus_ids: stores.map(store => store.corpusId),
        enforceable: ['path_prefix'], matcher: createSourceExclusionMatcher(undefined), store_present: true,
      }] }),
      fileSourceScopes: {
        summaries: () => [], browse: async () => { throw new Error('Unused'); },
        approveAndStart: async input => ({ ok: true, ...authority.approve(input) }),
      },
    },
  });
  cleanups.push(() => worker.close());
  const post = (path: string, payload: unknown) => worker.fetch(new Request('http://localhost' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }));
  const read = await post('/v1/source/index/files/read-on-demand', { itemRef: { corpusId, providerItemId: item.identity.providerItemId }, requester: 'analyst' });
  expect(await read.json()).toMatchObject({ state: 'queued' });
  await waitFor(() => runtime.jobs.itemExtractionState(item.identity) === 'settled');
  await expectHeldThenPersonal(set, item.identity, body);
  const search = async (store: LocalConnectorStore) => {
    const response = await post('/v1/source/index/search', { corpus_id: store.corpusId, query: body, all_tiers: false });
    expect(response.status).toBe(200);
    return (await response.json() as { hits: unknown[] }).hits;
  };
  const granted = () => stores.map(store => store.readOnDemand('personal:report', 'v1'));
  expect(granted()).toEqual([true, true]);
  expect((await Promise.all(stores.map(search))).flat().length).toBeGreaterThan(0);
  const scopeSave = (state: 'on_demand' | 'metadata_only' | 'exclude', key = '/Files') => post('/dashboard/dispositions', {
    action: 'approve_source_scope_and_start', source_id: 'local.files', account_generation: approval.accountGeneration,
    expected_scope_revision: approval.revision, whole_account: false, selections: [{ key, state }],
  });
  return { stores, sibling, granted, search, scopeSave,
    excludeFolder: () => post('/dashboard/dispositions', { source: 'local.files', edits: [{ path: '/Files', state: 'metadata_only' }] }),
    makePrivate: () => post('/v1/privacy-item/raise', { item_id: ownerTierItemId(item.identity) }),
    disconnect: () => post('/dashboard/disconnect', { source_id: 'local.files', acknowledge: true }) };
}

test('disconnect revokes an on-demand body match in every store', async () => {
  const f = await fixture();
  expect(await (await f.disconnect()).json()).toMatchObject({ ok: true });
  for (const store of f.stores) expect(await f.search(store)).toEqual([]);
  expect(f.granted()).toEqual([false, false]);
});

test('disconnect reports a failed store revoke and a retry completes it', async () => {
  const f = await fixture();
  const failed = spyOn(f.sibling, 'revokeOnDemandRead').mockImplementationOnce(() => { throw new Error('store write failed'); });
  try {
    const response = await f.disconnect();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(failed).toHaveBeenCalled();
    expect(f.granted()[1]).toBe(true);
  } finally { failed.mockRestore(); }
  expect(await (await f.disconnect()).json()).toMatchObject({ ok: true });
  expect(f.granted()).toEqual([false, false]);
});

test('making the item Private removes the grant from its other tier too', async () => {
  const f = await fixture();
  expect(await (await f.makePrivate()).json()).toMatchObject({ ok: true });
  expect(f.granted()).toEqual([false, false]);
  for (const store of f.stores) expect(await f.search(store)).toEqual([]);
});

test.each(['metadata_only', 'exclude'] as const)('saving %s ends reads even when the stored body stays indexed', async state => {
  const f = await fixture();
  expect(await (await f.scopeSave(state)).json()).toMatchObject({ ok: true });
  expect(f.granted()).toEqual([false, false]);
  for (const store of f.stores) expect(await f.search(store)).toEqual([]);
});

test('a replay of a saved folder choice retries a failed revocation', async () => {
  const f = await fixture();
  const failed = spyOn(f.sibling, 'revokeOnDemandRead').mockImplementationOnce(() => { throw new Error('store write failed'); });
  try {
    expect((await f.scopeSave('on_demand', '/Elsewhere')).status).toBeGreaterThanOrEqual(400);
    expect(f.granted()[1]).toBe(true);
  } finally { failed.mockRestore(); }
  expect(await (await f.scopeSave('on_demand', '/Elsewhere')).json()).toMatchObject({ ok: true, replayed: true });
  expect(f.granted()).toEqual([false, false]);
});

test('a folder which stays on demand retains its grant across the new scope revision', async () => {
  const f = await fixture();
  expect(await (await f.scopeSave('on_demand')).json()).toMatchObject({ ok: true });
  expect(f.granted()).toEqual([true, true]);
});

test('the rules editor revokes existing grants when a folder is saved as names only', async () => {
  const f = await fixture();
  expect(await (await f.excludeFolder()).json()).toMatchObject({ ok: true, policy: { writes_config_only: false } });
  expect(f.granted()).toEqual([false, false]);
  for (const store of f.stores) expect(await f.search(store)).toEqual([]);
});
