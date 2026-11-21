// source_index_search judges a hit by its row's own tier, not only by its
// store's domain. A Personal (internal) store can hold a row that is Private
// by its own tier (S4: a lane's placement, a corpus default, misplacement).
// Such a hit used to come back with its title, `local_only: false` and
// `trust_domain: "internal"`, and (since the tier is stripped from the result)
// nothing to say it was Private.

import { describe, expect, spyOn, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity, type SourceTrustDomain, type SourceTrustTier } from '../src/core/source-index/types.ts';
import { findOperationByName } from '../src/core/operations.ts';
import { createInProcessOperationContext } from '../src/workers/remote-mcp.ts';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { fixtureLanes } from './helpers/admission-fixture.ts';
import { JUDGED_PERSONAL_SNIFFER } from './helpers/tier-fixtures.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { hiddenProbesByParentIdentity } from '../src/workers/connector-store/child-visibility.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { defineConnectorCorpus, LocalConnectorStore, type ConnectorStoreSyncOptions } from '../src/workers/connector-store/index.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';
const INTERNAL = 'internal.fixture.files';
const SECURE = 'secure_local.fixture.files';
const S4_TITLE = 'orchard-ledger-private.md';

interface Fixture {
  id: string;
  name: string;
  text: string;
  tier: SourceTrustTier;
  parentId?: string;
  authoredAt?: string;
}

function connector(fixtures: readonly Fixture[]): SourceConnector {
  const items = fixtures.map((fixture): RawItem => ({
    identity: {
      family: 'file',
      provider: 'fixture',
      accountScope: ACCOUNT,
      providerItemId: fixture.id,
      localItemId: `${ACCOUNT}:${fixture.id}`,
      sourceVersion: `${fixture.id}:v1`,
      ...(fixture.parentId ? {
        parent: {
          providerItemId: fixture.parentId,
          localItemId: `${ACCOUNT}:${fixture.parentId}`,
        },
      } : {}),
    },
    mimeType: 'text/markdown',
    content: { kind: 'text', text: fixture.text },
    metadata: Object.freeze({ name: fixture.name, ...(fixture.authoredAt ? { authoredAt: fixture.authoredAt } : {}) }),
    fetchedAt: '2026-10-05T00:00:00.000Z',
  }));
  return {
    id: 'fixture',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const found = items.find((item) => item.identity.localItemId === localItemId);
      if (!found) throw new Error(`missing fixture ${localItemId}`);
      return found;
    },
    classificationSignals() {
      return {};
    },
  };
}

async function store(
  corpusId: string,
  trustDomain: SourceTrustDomain,
  fixtures: readonly Fixture[],
  tierLedger: TierLedger | null = null,
  sourceScopeObservation?: ConnectorStoreSyncOptions['sourceScopeObservation'],
): Promise<LocalConnectorStore> {
  const opened = new LocalConnectorStore({ dbPath: ':memory:', corpusId, family: 'file', trustDomain, tierLedger });
  const tiers = new Map(fixtures.map((fixture) => [`${ACCOUNT}:${fixture.id}`, fixture.tier]));
  await opened.syncFromConnector(connector(fixtures), {
    fetchContent: true,
    ...(sourceScopeObservation ? { sourceScopeObservation } : {}),
    ...(tierLedger ? { tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER } } : {}),
    placement: (item: RawItem) => buildSourceSensitivity({
      trustTier: tiers.get(item.identity.localItemId)!,
      trustDomain,
    }),
  });
  return opened;
}

const INTERNAL_FIXTURES: Fixture[] = [
  { id: 'plan', name: 'orchard-plan.md', text: 'Orchard pruning plan for the apple trees.', tier: 'S3' },
  { id: 'ledger', name: S4_TITLE, text: 'Orchard ledger with the private figures.', tier: 'S4' },
];

async function search(
  worker: ReturnType<typeof createEmailSourceWorker>,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }));
  const payload = await response.json() as Record<string, any>;
  expect({ status: response.status, payload }).toMatchObject({ status: 200 });
  return payload;
}

describe('source_index_search and rows Private by their own tier', () => {
  test('a search that reads no Private store withholds an S4 row of a Personal store, counted', async () => {
    const internal = await store(INTERNAL, 'internal', INTERNAL_FIXTURES);
    try {
      const worker = createEmailSourceWorker({ connectorStores: [internal] });
      const result = await search(worker, { query: 'orchard', corpus_id: INTERNAL });

      expect(JSON.stringify(result)).not.toContain(S4_TITLE);
      expect(JSON.stringify(result)).not.toContain('ledger');
      expect(JSON.stringify(result.hits)).toContain('orchard-plan.md');
      expect(result.hits).toHaveLength(1);
      expect(result.audit.private_tier_withheld).toBe(1);
      expect(result.audit.items_returned).toBe(1);
      // What is returned is Personal only, and says so truthfully.
      expect(result.policy).toMatchObject({ local_only: false, trust_domain: 'internal' });
      // The row's tier never leaves the worker.
      expect(JSON.stringify(result)).not.toContain('trustTier');
    } finally {
      internal.close();
    }
  });

  test('a Personal-only result carries no withheld marker', async () => {
    const internal = await store(INTERNAL, 'internal', [INTERNAL_FIXTURES[0]!]);
    try {
      const worker = createEmailSourceWorker({ connectorStores: [internal] });
      const result = await search(worker, { query: 'orchard', corpus_id: INTERNAL });
      expect(result.hits).toHaveLength(1);
      expect(result.audit).not.toHaveProperty('private_tier_withheld');
      expect(result.policy.local_only).toBe(false);
    } finally {
      internal.close();
    }
  });

  test('legacy requests across tiers withhold Private names and an explicit Private probe can read them', async () => {
    const internal = await store(INTERNAL, 'internal', INTERNAL_FIXTURES);
    const secure = await store(SECURE, 'secure_local', [
      { id: 'deed', name: 'orchard-deed.md', text: 'Orchard deed held privately.', tier: 'S4' },
    ]);
    try {
      const worker = createEmailSourceWorker({
        connectorStores: [internal, secure],
        connectorStoreTierSiblings: (corpusId) => [INTERNAL, SECURE].filter((sibling) => sibling !== corpusId),
      });
      const result = await search(worker, { query: 'orchard', corpus_id: INTERNAL });
      expect(JSON.stringify(result.hits)).not.toContain(S4_TITLE);
      expect(result.hits.map((hit: any) => hit.sourceItem.providerItemId)).toEqual(['plan']);
      expect(result.audit.private_tier_withheld).toBe(2);
      const probe = await search(worker, {
        query: 'orchard', corpus_id: SECURE, all_tiers: false, include_private_names: true,
      });
      expect(probe.hits.map((hit: any) => hit.sourceItem.providerItemId)).toEqual(['deed']);
      expect(probe.audit).not.toHaveProperty('private_tier_withheld');
      expect(probe.policy).toMatchObject({ local_only: true, trust_domain: 'secure_local' });
    } finally {
      internal.close();
      secure.close();
    }
  });

  test.each([
    ['caller', 'first'], ['worker', 'first'], ['caller', 'sibling'], ['worker', 'sibling'], ['unmounted', 'first'],
  ])('all-sources search honors %s availability on the %s tier', async (authority, position) => {
    const config = defaultConfig();
    const internalId = 'internal.drive.docs';
    const secureId = 'secure_local.drive.docs';
    const optedOut = position === 'first' ? internalId : secureId;
    const allowed = position === 'first' ? secureId : internalId;
    const expectedHit = { corpus_id: allowed, selected_item: { corpus_id: allowed, provider_item_id: allowed === internalId ? 'plan' : 'deed' } };
    const registry = config.sourceIndex.corpusRegistry;
    registry.corpora = registry.corpora.filter(entry => [internalId, secureId].includes(entry.corpusId));
    if (authority === 'caller') registry.corpora.find(entry => entry.corpusId === optedOut)!.capabilities = ['status'];
    const internal = await store(internalId, 'internal', [INTERNAL_FIXTURES[0]!]);
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const secure = await store(secureId, 'secure_local', [
      { id: 'deed', name: 'orchard-deed.md', text: 'Orchard deed.', tier: 'S4' },
    ], ledger);
    try {
      const unrestricted = createEmailSourceWorker({ connectorStores: [secure] });
      expect((await search(unrestricted, { corpus_id: secureId, query: 'orchard' })).hits).toMatchObject([
        { selected_item: { provider_item_id: 'deed', title: 'orchard-deed.md' } },
      ]);
      const reads: string[] = [];
      const siblingLookups: string[] = [];
      const refreshes: string[][] = [];
      const worker = createEmailSourceWorker({
        refreshConnectorStores: ids => { if (ids) refreshes.push([...ids]); },
        connectorStores: authority === 'unmounted' ? [secure] : [internal, secure],
        connectorStoreTierSiblings: id => {
          siblingLookups.push(id);
          return [internalId, secureId].filter(sibling => sibling !== id);
        },
        searchableCorpusIds: new Set(authority === 'worker' ? [allowed] : [internalId, secureId]),
        connectorStoreReadScope: holder => { reads.push(holder.corpusId); return { allowed: true }; },
      });
      const requests: unknown[] = [];
      const context = createInProcessOperationContext({
        config, sourceIndexReadEnabled: true,
        workerFetch: async request => {
          requests.push(await request.clone().json());
          return worker.fetch(request);
        },
        caller: { surface: 'remote', displayName: 'fixture' },
      });
      const operation = findOperationByName('source_index_search')!;
      const result = await operation.handler(context, { query: 'orchard' });
      expect(requests).toEqual([{
        query: 'orchard', personal_names_only: true, corpus_ids: authority === 'caller' ? [allowed] : [internalId, secureId],
      }]);
      expect(siblingLookups).toEqual([]);
      expect(refreshes).toEqual([authority === 'unmounted' ? [internalId, secureId] : [allowed]]);
      expect(result).toMatchObject({
        corpus_id: allowed, corpus_ids: [allowed],
        audit: {
          searched_corpora: [allowed], skipped_corpora: authority === 'caller' ? [] : [optedOut],
          queries_attempted: 1, items_returned: 1,
        },
        hits: [expectedHit],
      });
      expect(result).not.toHaveProperty('coverage_notes');
      expect(await operation.handler(context, { query: 'orchard', corpus_id: authority === 'worker' ? optedOut : allowed })).toMatchObject({
        audit: { queries_attempted: 1, items_returned: 1 },
        hits: [expectedHit],
      });
      if (authority === 'worker') {
        await expect(operation.handler(context, { query: 'orchard', corpus_id: optedOut, all_tiers: false }))
          .rejects.toThrow('HTTP 403');
      }
      expect(reads).not.toContain(optedOut);
    } finally {
      internal.close();
      secure.close();
      ledger.close();
    }
  });

  test('searching without locators keeps a corpus with no locator projector', async () => {
    const corpusId = 'internal.drive.docs';
    const config = defaultConfig();
    config.sourceIndex.corpusRegistry.corpora = config.sourceIndex.corpusRegistry.corpora.filter(c => c.corpusId === corpusId);
    const personal = await store(corpusId, 'internal', [INTERNAL_FIXTURES[0]!]);
    try {
      const context = createInProcessOperationContext({
        config, sourceIndexReadEnabled: true, workerFetch: createEmailSourceWorker({ connectorStores: [personal] }).fetch,
        caller: { surface: 'remote', displayName: 'fixture' },
      });
      for (const selector of [{}, { corpus_id: corpusId }]) {
        const result = await findOperationByName('source_index_search')!.handler(context, {
          query: 'orchard', include_locators: false, ...selector,
        });
        expect(result).toMatchObject({ hits: [{ corpus_id: corpusId, selected_item: { provider_item_id: 'plan' } }] });
      }
    } finally { personal.close(); }
  });

  test('parent checks never read a skipped sibling or release a child through its parent there', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const parentId = 'contract-parent';
    const childId = parentId + '-attachment';
    const internal = await store(INTERNAL, 'internal', [
      INTERNAL_FIXTURES[0]!,
      { id: childId, parentId, name: 'orchard attachment', text: 'orchard', tier: 'S3' },
      { id: parentId + '#child:unlinked', name: 'orchard enclosure', text: 'orchard', tier: 'S3' },
    ], ledger);
    const secure = await store(SECURE, 'secure_local', [
      { id: parentId, name: 'contract', text: 'contract', tier: 'S3' },
    ], ledger);
    const stores = [secure, internal];
    const lane = { stores: () => stores, ledger: () => ledger };
    internal.useChildVisibility(lane);
    secure.useChildVisibility(lane);
    const searchable = new Set([INTERNAL, SECURE]);
    const worker = createEmailSourceWorker({
      connectorStores: stores, searchableCorpusIds: searchable,
      sourceIndexVisibilityGate: createTierVisibilityGate(() => [{
        stores: lane.stores, ledger, corpusIds: new Set([INTERNAL, SECURE]),
      }]),
    });
    try {
      const find = () => search(worker, { query: 'orchard', corpus_ids: [INTERNAL, SECURE] });
      expect(JSON.stringify((await find()).results[0].hits)).toContain(childId);
      searchable.delete(SECURE);
      const reads = [
        spyOn(secure, 'parentLinksOf'), spyOn(secure, 'parentLinksOfOffThread'),
        spyOn(secure, 'parentStandings'), spyOn(secure, 'parentStandingsOffThread'),
        spyOn(secure, 'itemStandings'), spyOn(secure, 'itemStandingsOffThread'),
      ];
      const result = await find();
      expect(result.audit.skipped_corpora).toEqual([SECURE]);
      expect(result.results[0].hits).toContainEqual(expect.objectContaining({
        selected_item: expect.objectContaining({ provider_item_id: 'plan' }),
      }));
      expect(result.results[0].hits).toContainEqual(expect.objectContaining({
        provenance: expect.objectContaining({ citation: expect.objectContaining({ title: 'orchard enclosure' }) }),
      }));
      expect(JSON.stringify(result)).not.toContain(parentId);
      for (const read of reads) expect(read).not.toHaveBeenCalled();
    } finally {
      internal.close();
      secure.close();
      ledger.close();
    }
  });

  test('the default all-sources page can return a hit from each requested tier', async () => {
    const config = defaultConfig();
    const ids = ['internal.drive.docs', 'secure_local.drive.docs'] as const;
    config.sourceIndex.corpusRegistry.corpora = config.sourceIndex.corpusRegistry.corpora.filter(c => ids.some(id => id === c.corpusId));
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const personal = await store(ids[0], 'internal', [INTERNAL_FIXTURES[0]!]);
    const secure = await store(ids[1], 'secure_local', [{ id: 'deed', name: 'orchard-deed.md', text: 'Orchard deed.', tier: 'S4' }], ledger);
    try {
      const context = createInProcessOperationContext({
        config, sourceIndexReadEnabled: true, workerFetch: createEmailSourceWorker({ connectorStores: [personal, secure] }).fetch,
        caller: { surface: 'remote', displayName: 'fixture' },
      });
      expect(await findOperationByName('source_index_search')!.handler(context, { query: 'orchard' })).toMatchObject({
        hits: ids.map(corpus_id => ({ corpus_id, selected_item: { corpus_id } })),
        audit: { searched_corpora: [...ids], skipped_corpora: [], queries_attempted: 2, items_returned: 2 },
      });
    } finally {
      personal.close();
      secure.close();
      ledger.close();
    }
  });

  test('an entirely unmounted search returns empty hits and accounts for every requested corpus', async () => {
    const config = defaultConfig();
    const ids = ['internal.drive.docs', 'secure_local.drive.docs'];
    config.sourceIndex.corpusRegistry.corpora = config.sourceIndex.corpusRegistry.corpora.filter(c => ids.includes(c.corpusId));
    const context = createInProcessOperationContext({
      config, sourceIndexReadEnabled: true, workerFetch: createEmailSourceWorker({ connectorStores: [] }).fetch,
      caller: { surface: 'remote', displayName: 'fixture' },
    });
    const result = await findOperationByName('source_index_search')!.handler(context, { query: 'orchard' });
    expect(result).toMatchObject({
      corpus_ids: [], hits: [], audit: { searched_corpora: [], skipped_corpora: ids, queries_attempted: 0, latency_ms: 0 },
    });
    expect(result).not.toHaveProperty('corpus_id');
    expect(result).not.toHaveProperty('coverage_notes');
  });

  test.each(['legacy placement', 'owner names verdict'] as const)('a Personal child omits every copy of its Private parent’s identifiers (%s)', async mode => {
    const ledger = mode === 'owner names verdict' ? new TierLedger({ dbPath: ':memory:' }) : null;
    const parentId = 'private-parent-marker';
    const childId = `attachment-of-${parentId}-document`;
    const internal = await store(INTERNAL, 'internal', [
      { id: parentId, name: 'a private contract', text: 'Restricted figures', tier: ledger ? 'S3' : 'S4' },
      { id: childId, name: 'orchard attachment', text: 'Orchard pruning dates', tier: 'S3', parentId },
    ], ledger);
    try {
      const worker = createEmailSourceWorker({ connectorStores: [internal] });
      const find = () => search(worker, { query: 'orchard', corpus_id: INTERNAL, personal_names_only: true });
      if (ledger) {
        expect((await find()).hits[0].selected_item.provider_item_id).toBe(childId);
        ledger.setOverride({ provider: 'fixture', accountScope: ACCOUNT, providerItemId: parentId }, { kind: 'tier', tier: 'secure' });
      }
      const result = await find();
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].corpus_id).toBe(INTERNAL);
      expect(result.hits[0].provenance.citation.title).toBe('orchard attachment');
      expect(result.hits[0]).not.toHaveProperty('selected_item');
      expect(result.hits[0].sourceItem).not.toHaveProperty('providerItemId');
      expect(result.hits[0].sourceItem).not.toHaveProperty('localItemId');
      expect(JSON.stringify(result)).not.toContain(parentId);
    } finally {
      internal.close();
      ledger?.close();
    }
  });

  test('a linked Personal child withholds its id when its parent embeds an unlinked Private grandparent', async () => {
    const grandparentId = 'private-contract-marker';
    const parentId = `${grandparentId}#child:folder`;
    const internal = await store(INTERNAL, 'internal', [
      { id: grandparentId, name: 'contract', text: 'Restricted figures', tier: 'S4' },
      { id: parentId, name: 'folder', text: 'Attachments', tier: 'S3' },
      { id: `${parentId}#child:notes`, parentId, name: 'pruning notes', text: 'orchard', tier: 'S3' },
    ]);
    try {
      const worker = createEmailSourceWorker({ connectorStores: [internal] });
      const result = await search(worker, { query: 'orchard', corpus_id: INTERNAL, personal_names_only: true });
      expect(result.hits).toMatchObject([{ provenance: { citation: { title: 'pruning notes' } } }]);
      expect(result.hits[0]).not.toHaveProperty('selected_item');
      expect(JSON.stringify(result)).not.toContain(grandparentId);
    } finally { internal.close(); }
  });

  test('an unlinked child keeps its identifiers when its encoded parent has Personal names', async () => {
    const parentId = 'garden-plan';
    const childId = `${parentId}#child:notes`;
    const internal = await store(INTERNAL, 'internal', [
      { id: parentId, name: 'plan', text: 'Garden layout', tier: 'S3' },
      { id: childId, name: 'pruning notes', text: 'orchard', tier: 'S3' },
    ]);
    try {
      const worker = createEmailSourceWorker({ connectorStores: [internal] });
      const result = await search(worker, { query: 'orchard', corpus_id: INTERNAL, personal_names_only: true });
      expect(result.hits).toMatchObject([{
        sourceItem: { providerItemId: childId, localItemId: `${ACCOUNT}:${childId}` },
        selected_item: { provider_item_id: childId },
      }]);
    } finally { internal.close(); }
  });

  test.each(['folder', 'account'] as const)('an unlinked child withholds its id when its encoded parent is outside the approved %s scope', async exclusion => {
    const parentId = 'garden-plan';
    const childId = `${parentId}#child:notes`;
    const parent: Fixture = { id: parentId, name: 'plan', text: 'Garden layout', tier: 'S3' };
    const child: Fixture = { id: childId, name: 'pruning notes', text: 'orchard', tier: 'S3' };
    const internal = await store(INTERNAL, 'internal', exclusion === 'folder' ? [parent, child] : [child], null, item => ({
      accountGeneration: 'a'.repeat(64), scopeRevision: '00000000-0000-4000-8000-000000000001',
      folderKeys: [item.identity.providerItemId === parentId ? 'plans' : 'notes'],
    }));
    // Encoded relatives share an identity account, but each store has its own account approval.
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const sibling = await store(SECURE, 'secure_local', exclusion === 'account' ? [parent] : [], ledger);
    const stores = [internal, sibling];
    const lane = { stores: () => stores, ledger: () => ledger };
    for (const holder of stores) holder.useChildVisibility(lane);
    let restricted = false;
    try {
      const worker = createEmailSourceWorker({
        connectorStores: stores,
        connectorStoreReadScope: holder => ({
          allowed: true,
          accountScope: restricted && exclusion === 'account' && holder === sibling ? 'other' : ACCOUNT,
          filters: { sourceScopeFolderNoneKeys: restricted && exclusion === 'folder' ? ['plans'] : [] },
        }),
      });
      const find = () => exclusion === 'folder'
        ? search(worker, { query: 'orchard', corpus_id: INTERNAL })
        : search(worker, { query: 'orchard', corpus_ids: [INTERNAL, SECURE] }).then(page => page.results[0]);
      expect((await find()).hits[0].selected_item.provider_item_id).toBe(childId);
      restricted = true;
      const result = await find();
      const sourceItem = { family: 'file', provider: 'fixture', accountScope: ACCOUNT };
      expect(result.hits).toEqual([{
        corpus_id: INTERNAL, sourceItem, score: expect.any(Number), rawExposed: false,
        provenance: { sourceItem, citation: { sourceLabel: 'fixture', title: 'pruning notes' } },
      }]);
      expect(JSON.stringify(result)).not.toContain(parentId);
      expect(result.audit).not.toHaveProperty('private_tier_withheld');
    } finally {
      internal.close();
      sibling.close();
      ledger.close();
    }
  });

  test('a date-filtered child keeps its selected item when its approved parent is older', async () => {
    const parentId = 'garden-plan';
    const childId = `${parentId}#child:notes`;
    const internal = await store(INTERNAL, 'internal', [
      { id: parentId, name: 'orchard plan', text: 'orchard', tier: 'S3', authoredAt: '2025-01-01T00:00:00Z' },
      { id: childId, parentId, name: 'orchard notes', text: 'orchard', tier: 'S3', authoredAt: '2026-01-01T00:00:00Z' },
    ]);
    try {
      const worker = createEmailSourceWorker({ connectorStores: [internal] });
      const page = await search(worker, { query: 'orchard', corpus_id: INTERNAL, after: '2025-12-01T00:00:00Z' });
      expect(page.hits).toMatchObject([{ selected_item: { provider_item_id: childId } }]);
    } finally { internal.close(); }
  });

  test('partial results use the current owner scope of the store holding the parent', async () => {
    const parentId = 'message';
    const childId = `${parentId}#child:notes`;
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const parent = await store(INTERNAL, 'internal', [{ id: parentId, name: 'plan', text: 'plan', tier: 'S3' }], ledger);
    const child = await store(SECURE, 'secure_local', [{ id: childId, name: 'notes', text: 'orchard', tier: 'S3' }], ledger);
    const stores = [parent, child];
    for (const holder of stores) holder.useChildVisibility({ stores: () => stores, ledger: () => ledger });
    let parentAccount = ACCOUNT;
    try {
      const lanes = fixtureLanes(stores, holder => ({
        allowed: true, contentAllowed: true, accountScope: holder === parent ? parentAccount : ACCOUNT,
      }), () => ({ provider: 'fixture', accountScope: ACCOUNT }))({ question: 'orchard' });
      const partialIds = async (allowedCorpusIds: string[]) => {
        const ids: string[] = [];
        await lanes.adapters[SECURE]!({
          corpus: defineConnectorCorpus(child), query: 'orchard', maxResults: 5,
          context: { allowedCorpusIds, allowedTrustDomains: ['internal', 'secure_local'] },
          onPartialResponse: page => { ids.push(...page.hits.map(hit => hit.sourceItem.providerItemId)); },
        });
        return ids;
      };
      expect(await partialIds([INTERNAL, SECURE])).toContain(childId);
      expect(await partialIds([SECURE])).not.toContain(childId);
      parentAccount = 'other';
      expect(await partialIds([INTERNAL, SECURE])).not.toContain(childId);
    } finally {
      parent.close();
      child.close();
      ledger.close();
    }
  });

  test.each(['account', 'folder', 'approval'] as const)('a Secret attachment withholds its locator outside its parent’s %s scope', async exclusion => {
    const parentId = 'parentmarker';
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const secrets = new SecretLocationsIndex({ dbPath: ':memory:' });
    const internal = await store(INTERNAL, 'internal', [
      { id: parentId, name: 'message', text: 'message', tier: 'S3' },
    ], ledger, () => ({
      accountGeneration: 'a'.repeat(64), scopeRevision: '00000000-0000-4000-8000-000000000001', folderKeys: ['inbox'],
    }));
    const secure = await store(SECURE, 'secure_local', [], ledger);
    const stores = [internal, secure];
    const lane = { stores: () => stores, ledger: () => ledger };
    // Retained stores may be mounted without a live sync tier set after restart.
    const locator = `https://mail.google.com/mail/u/0/#all/${parentId}`;
    secrets.record({
      identity: { provider: 'fixture', accountScope: ACCOUNT, providerItemId: `${parentId}#child:part1` },
      namesReleasable: true, locator, title: 'attachment', findingKinds: ['credential_assignment'],
    });
    let restricted = false;
    try {
      const worker = createEmailSourceWorker({
        connectorStores: stores,
        connectorStoreTierSiblings: () => [SECURE],
        connectorStoreReadScope: holder => restricted && holder === internal
          ? { allowed: true, accountScope: exclusion === 'account' ? 'other' : ACCOUNT, filters: {
              ...(exclusion === 'folder' ? { sourceScopeFolderNoneKeys: ['inbox'] } : {}),
              ...(exclusion === 'approval' ? { sourceScopeGeneration: 'b'.repeat(64) } : {}),
            } }
          : { allowed: true, accountScope: ACCOUNT },
        secretLocationSearch: (query, searched, withholdLocators) => secrets.search(query,
          searched.find(scope => scope.corpusId === SECURE)!, {
            hide: ids => hiddenProbesByParentIdentity(lane, ids),
            withholdLocators: ids => withholdLocators(SECURE, ids, lane),
          }),
      });
      const find = (query: string) => search(worker, { query, corpus_id: INTERNAL });
      const [allowed] = (await find('attachment')).secret_locations;
      expect(allowed.ref).toMatch(/^secret:/);
      expect(allowed).toMatchObject({ locator, title: 'attachment' });
      restricted = true;
      const page = await find('attachment');
      expect(page.secret_locations).toEqual([{
        source: 'fixture', ref: allowed.ref, title: 'attachment', finding_kinds: ['credential_assignment'],
      }]);
      expect(JSON.stringify(page)).not.toContain(parentId);
      expect((await find(parentId)).secret_locations).toBeUndefined();
    } finally {
      secrets.close();
      internal.close();
      secure.close();
      ledger.close();
    }
  });

  test('a withheld top-ranked hit leaves room for the next eligible match', async () => {
    const internal = await store(INTERNAL, 'internal', [
      ...Array.from({ length: 55 }, (_, index): Fixture => ({
        id: `private-${index}`, name: 'orchard', text: 'orchard', tier: 'S4',
      })),
      { id: 'personal-second', name: 'planting notes', text: 'The orchard pruning plan concerns apple trees.', tier: 'S3' },
    ]);
    try {
      const worker = createEmailSourceWorker({ connectorStores: [internal] });
      const result = await search(worker, {
        query: 'orchard', corpus_id: INTERNAL, personal_names_only: true, max_results: 1,
      });
      expect(result.hits.map((hit: any) => hit.sourceItem.providerItemId)).toEqual(['personal-second']);
      expect(result.audit.private_tier_withheld).toBe(55);
    } finally {
      internal.close();
    }
  });

  test('a hybrid search refills its semantic lane from matches below withheld winners', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const privateIds = Array.from({ length: 55 }, (_, index) => `private-${index}`);
    const internal = await store(INTERNAL, 'internal', [
      ...privateIds.map((id): Fixture => ({ id, name: 'restricted', text: 'financial figures', tier: 'S3' })),
      { id: 'personal', name: 'planting notes', text: 'growing apples', tier: 'S3' },
    ], ledger);
    const provider: SourceEmbeddingProvider = {
      provider: 'built-in', backend: 'local', modelId: 'fixture-search-vectors', epochId: '1', configHash: 'fixture', dimension: 2,
      async embed(inputs) { return inputs.map(input => input.text.includes('growing apples') ? [0.95, 0.31] : [1, 0]); },
    };
    try {
      expect((await internal.embedChunks({ provider })).chunksEmbedded).toBe(56);
      for (const providerItemId of privateIds) {
        ledger.setOverride({ provider: 'fixture', accountScope: ACCOUNT, providerItemId }, { kind: 'tier', tier: 'secure' });
      }
      const worker = createEmailSourceWorker({
        connectorStores: [internal], connectorStoreEmbeddingProviders: new Map([[INTERNAL, provider]]),
      });
      const find = () => search(worker, { query: 'orchard', corpus_id: INTERNAL, max_results: 1, retrieval_mode: 'hybrid' });
      expect((await find()).hits.map((hit: any) => hit.sourceItem.providerItemId)).toEqual(['personal']);
      expect(internal.backfillVectorDigest(provider.modelId, 100).completed).toBe(true);
      expect((await find()).hits.map((hit: any) => hit.sourceItem.providerItemId)).toEqual(['personal']);
    } finally {
      internal.close();
      ledger.close();
    }
  });

  test('the operation client carries the withheld count through to the tool result', async () => {
    const corpusId = 'internal.drive.docs';
    const internal = await store(corpusId, 'internal', INTERNAL_FIXTURES);
    try {
      const worker = createEmailSourceWorker({ connectorStores: [internal] });
      const config = defaultConfig();
      config.email.enabled = true;
      config.sourceIndex.enabled = true;
      const client = new EmailClient(config, new DirectHttpEmailTransport(async (input, init) => (
        worker.fetch(new Request(String(input).replace(config.email.baseUrl, 'http://worker.test/v1'), init))
      )));
      const result = await client.sourceIndexSearch({ corpusId, query: 'orchard' });
      expect(result.audit.private_tier_withheld).toBe(1);
      expect(result.policy.local_only).toBe(false);
      expect(JSON.stringify(result)).not.toContain(S4_TITLE);
    } finally {
      internal.close();
    }
  });
});
