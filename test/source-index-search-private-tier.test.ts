// source_index_search judges a hit by its row's own tier, not only by its
// store's domain. A Personal (internal) store can hold a row that is Private
// by its own tier (S4: a lane's placement, a corpus default, misplacement).
// Such a hit used to come back with its title, `local_only: false` and
// `trust_domain: "internal"`, and (since the tier is stripped from the result)
// nothing to say it was Private.

import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity, type SourceTrustDomain, type SourceTrustTier } from '../src/core/source-index/types.ts';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';

const ACCOUNT = 'personal';
const INTERNAL = 'internal.fixture.files';
const SECURE = 'secure_local.fixture.files';
const S4_TITLE = 'orchard-ledger-private.md';

interface Fixture { id: string; name: string; text: string; tier: SourceTrustTier }

function connector(fixtures: readonly Fixture[]): SourceConnector {
  const items = fixtures.map((fixture): RawItem => ({
    identity: {
      family: 'file',
      provider: 'fixture',
      accountScope: ACCOUNT,
      providerItemId: fixture.id,
      localItemId: `${ACCOUNT}:${fixture.id}`,
      sourceVersion: `${fixture.id}:v1`,
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
): Promise<LocalConnectorStore> {
  const opened = new LocalConnectorStore({ dbPath: ':memory:', corpusId, family: 'file', trustDomain, tierLedger: null });
  const tiers = new Map(fixtures.map((fixture) => [`${ACCOUNT}:${fixture.id}`, fixture.tier]));
  await opened.syncFromConnector(connector(fixtures), {
    fetchContent: true,
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

  test('a search across tiers that reads a Private store returns the S4 row under local_only', async () => {
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
      expect(JSON.stringify(result.hits)).toContain(S4_TITLE);
      expect(result.audit).not.toHaveProperty('private_tier_withheld');
      expect(result.policy).toMatchObject({ local_only: true, trust_domain: 'secure_local' });
    } finally {
      internal.close();
      secure.close();
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
