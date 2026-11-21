// source_index_search judges a hit by its row's own tier, not only by its
// store's domain. A Personal (internal) store can hold a row that is Private
// by its own tier (S4: a lane's placement, a corpus default, misplacement).
// Such a hit used to come back with its title, `local_only: false` and
// `trust_domain: "internal"`, and (since the tier is stripped from the result)
// nothing to say it was Private.

import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity, type SourceTrustDomain, type SourceTrustTier } from '../src/core/source-index/types.ts';
import { findOperationByName } from '../src/core/operations.ts';
import { createInProcessOperationContext } from '../src/workers/remote-mcp.ts';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { JUDGED_PERSONAL_SNIFFER } from './helpers/tier-fixtures.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
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
    metadata: Object.freeze({ name: fixture.name }),
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
): Promise<LocalConnectorStore> {
  const opened = new LocalConnectorStore({ dbPath: ':memory:', corpusId, family: 'file', trustDomain, tierLedger });
  const tiers = new Map(fixtures.map((fixture) => [`${ACCOUNT}:${fixture.id}`, fixture.tier]));
  await opened.syncFromConnector(connector(fixtures), {
    fetchContent: true,
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

  test.each(['caller', 'worker'])('all-sources search skips a mounted sibling opted out by the %s', async authority => {
    const config = defaultConfig();
    const internalId = 'internal.drive.docs';
    const secureId = 'secure_local.drive.docs';
    const registry = config.sourceIndex.corpusRegistry;
    registry.corpora = registry.corpora.filter(entry => [internalId, secureId].includes(entry.corpusId));
    if (authority === 'caller') registry.corpora.find(entry => entry.corpusId === secureId)!.capabilities = ['status'];
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
      const worker = createEmailSourceWorker({
        connectorStores: [internal, secure],
        connectorStoreTierSiblings: () => [secureId],
        searchableCorpusIds: new Set(authority === 'worker' ? [internalId] : [internalId, secureId]),
        connectorStoreReadScope: holder => { reads.push(holder.corpusId); return { allowed: true }; },
      });
      const context = createInProcessOperationContext({
        config, sourceIndexReadEnabled: true, workerFetch: worker.fetch,
        caller: { surface: 'remote', displayName: 'fixture' },
      });
      const operation = findOperationByName('source_index_search')!;
      const result = await operation.handler(context, { query: 'orchard' });
      expect(result).toMatchObject({
        audit: { searched_corpora: [internalId], queries_attempted: 1, items_returned: 1 },
        hits: [{ selected_item: { corpus_id: internalId, provider_item_id: 'plan' } }],
      });
      expect(await operation.handler(context, { query: 'orchard', corpus_id: internalId })).toMatchObject({
        audit: { queries_attempted: 1, items_returned: 1 },
        hits: [{ selected_item: { corpus_id: internalId, provider_item_id: 'plan' } }],
      });
      expect(reads).not.toContain(secureId);
    } finally {
      internal.close();
      secure.close();
      ledger.close();
    }
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
