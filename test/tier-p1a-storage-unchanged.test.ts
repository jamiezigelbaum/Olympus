// Phase P1a records a four-tier decision for every ingested item and changes
// NOTHING about storage or embeddings (design
// docs/design/per-item-four-tier-classification.md, section 4.2: "Tier
// unchanged: none. Kept, byte-identical. This is the core guarantee.").
//
// A store that records into the tier ledger must end in exactly the state of
// one that records nothing: same items, same tiers, same chunks, same vector
// bytes. Re-syncing must not re-embed, rebind, or reach the whole-corpus
// invalidateEmbeddingModelCurrency path.

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { TierLedger, tierLedgerPathForStore } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { DROPBOX_STORE_PLACEMENT } from '../src/workers/dropbox-files/connector-store.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';
const ITEMS: Array<{ id: string; name: string; text: string; sharing?: 'public_link' }> = [
  { id: 'benign', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden and the compost bins.' },
  { id: 'health', name: 'biopsy results.txt', text: 'The lab results confirm the diagnosis; the patient starts treatment.' },
  { id: 'public', name: 'launch-post.txt', text: 'Our launch post, already on the blog.', sharing: 'public_link' },
  { id: 'secret', name: 'env.txt', text: 'aws key AKIAABCDEFGHIJKLMNOP for the deploy' },
];

function rawItem(spec: (typeof ITEMS)[number]): RawItem {
  return {
    identity: {
      family: 'file',
      provider: 'fixture',
      accountScope: ACCOUNT,
      providerItemId: spec.id,
      localItemId: `${ACCOUNT}:${spec.id}`,
      sourceVersion: 'v1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: spec.text },
    metadata: Object.freeze({ name: spec.name, pathDisplay: `/Files/${spec.name}` }),
    fetchedAt: '2026-09-23T00:00:00.000Z',
  };
}

function connector(): SourceConnector {
  return {
    id: 'fixture',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* () { yield { items: ITEMS.map(rawItem), done: true }; })();
    },
    async fetchItem(localItemId) {
      return rawItem(ITEMS.find((spec) => `${ACCOUNT}:${spec.id}` === localItemId)!);
    },
    classificationSignals(item) {
      const spec = ITEMS.find((entry) => entry.id === item.identity.providerItemId)!;
      return {
        title: spec.name,
        path: `/Files/${spec.name}`,
        ...(spec.sharing ? { sharing: spec.sharing } : {}),
      };
    },
  };
}

let embedCalls = 0;
const provider: SourceEmbeddingProvider = {
  provider: 'fixture',
  modelId: 'p1a-fixture-model',
  dimension: 4,
  configHash: 'p1a',
  epochId: 'epoch:p1a',
  backend: 'local',
  async embed(inputs: SourceEmbeddingInput[]) {
    embedCalls += inputs.length;
    return inputs.map((input) => {
      const text = input.text;
      return [text.length % 7, text.length % 11, text.length % 13, 1];
    });
  },
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-p1a-'));
  dirs.push(dir);
  return dir;
}

function openStore(dbPath: string, tierLedger?: TierLedger | null): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath,
    corpusId: 'secure_local.fixture.files',
    family: 'file',
    trustDomain: 'secure_local',
    ...(tierLedger !== undefined ? { tierLedger } : {}),
  });
}

function snapshot(dbPath: string): { items: unknown[]; chunks: unknown[]; vectors: unknown[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      items: db.query(`
        SELECT local_item_id, trust_tier, tombstoned, content_hash, title
        FROM items ORDER BY local_item_id
      `).all(),
      chunks: db.query(`
        SELECT i.local_item_id, c.chunk_index, c.content_hash, c.bounded_text
        FROM chunks c JOIN items i ON i.item_pk = c.item_pk
        ORDER BY i.local_item_id, c.chunk_index
      `).all(),
      vectors: db.query(`
        SELECT i.local_item_id, c.chunk_index, e.model_id, e.content_hash, hex(e.embedding) AS bytes
        FROM chunk_embeddings e
        JOIN chunks c ON c.chunk_pk = e.chunk_pk
        JOIN items i ON i.item_pk = e.item_pk
        ORDER BY i.local_item_id, c.chunk_index
      `).all(),
    };
  } finally {
    db.close();
  }
}

async function syncAndEmbed(store: LocalConnectorStore): Promise<void> {
  await store.syncFromConnector(connector(), { fetchContent: true, placement: DROPBOX_STORE_PLACEMENT });
  await store.embedChunks({ provider });
}

describe('P1a: every item gets a recorded decision; storage and embeddings do not change', () => {
  test('a recording store ends byte-identical to a store that records nothing', async () => {
    const withoutDir = tempDir();
    const withDir = tempDir();
    const without = openStore(join(withoutDir, 'store.sqlite'), null);
    const recording = openStore(join(withDir, 'store.sqlite'));
    await syncAndEmbed(without);
    await syncAndEmbed(recording);
    without.close();
    recording.close();

    const a = snapshot(join(withoutDir, 'store.sqlite'));
    const b = snapshot(join(withDir, 'store.sqlite'));
    expect(b).toEqual(a);
    expect(a.vectors.length).toBeGreaterThan(0);

    // The placement is the lane's existing one: Personal and even Public
    // decisions stay in the secure store at S4, and the secret is S5.
    expect(b.items).toEqual([
      expect.objectContaining({ local_item_id: `${ACCOUNT}:benign`, trust_tier: 'S4', tombstoned: 0 }),
      expect.objectContaining({ local_item_id: `${ACCOUNT}:health`, trust_tier: 'S4', tombstoned: 0 }),
      expect.objectContaining({ local_item_id: `${ACCOUNT}:public`, trust_tier: 'S4', tombstoned: 0 }),
      expect.objectContaining({ local_item_id: `${ACCOUNT}:secret`, tombstoned: 1 }),
    ]);
  });

  test('each item has a two-tier decision beside its unchanged placement', async () => {
    const dir = tempDir();
    const store = openStore(join(dir, 'store.sqlite'));
    await syncAndEmbed(store);
    store.close();

    const ledger = new TierLedger({ dbPath: tierLedgerPathForStore(join(dir, 'store.sqlite')) });
    try {
      const row = (id: string) => ledger.getCurrent({ provider: 'fixture', accountScope: ACCOUNT, providerItemId: id })!;
      expect(row('benign')).toMatchObject({ metadataTier: 'private', contentTier: 'private', state: 'current', storedTrustDomain: 'secure_local', storedTrustTier: 'S4' });
      expect(row('health')).toMatchObject({ metadataTier: 'private', contentTier: 'secure', state: 'pending', storedTrustTier: 'S4' });
      expect(row('public')).toMatchObject({ metadataTier: 'public', contentTier: 'public', storedTrustTier: 'S4' });
      expect(row('secret')).toMatchObject({ contentTier: 'secrets', storedTrustTier: 'S5' });
      expect(ledger.listPending().map((pending) => pending.providerItemId)).toEqual(['health']);
    } finally {
      ledger.close();
    }
  });

  test('re-syncing a store that predates the ledger rewrites nothing and never re-embeds or invalidates', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'store.sqlite');
    const legacy = openStore(dbPath, null);
    await syncAndEmbed(legacy);
    legacy.close();
    const before = snapshot(dbPath);

    const invalidate = spyOn(
      LocalConnectorStore.prototype as unknown as { invalidateEmbeddingModelCurrency(modelId: string): void },
      'invalidateEmbeddingModelCurrency',
    );
    try {
        embedCalls = 0;
        const upgraded = openStore(dbPath);
        await syncAndEmbed(upgraded);
        await syncAndEmbed(upgraded);
        upgraded.close();
        expect(invalidate).not.toHaveBeenCalled();
        expect(embedCalls).toBe(0);
    } finally {
      invalidate.mockRestore();
    }
    const after = snapshot(dbPath);
    expect(after).toEqual(before);

    const ledger = new TierLedger({ dbPath: tierLedgerPathForStore(join(dir, 'store.sqlite')) });
    try {
      expect(ledger.counts().items).toBe(ITEMS.length);
      // The second recording pass saw the same decisions and wrote nothing new.
      expect(ledger.history({ provider: 'fixture', accountScope: ACCOUNT, providerItemId: 'benign' })).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });
});
