// The vector lane walks chunk_embeddings in primary-key order (#1242).
//
// Its page query once let SQLite take the model_id index, so every 256-row
// page read and sorted (blobs included) all of the model's rows: quadratic in
// the store's vector count, which ran a 1.3 GB store past the 10 s lane
// deadline on every eval question (2026-11-10 rerun 5). This pins the plan:
// a range walk on the primary key, no sort.
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

test('the vector lane pages by primary key without sorting the model\'s rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-vector-scan-plan-'));
  const dbPath = join(dir, 'store.sqlite');
  const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fake.scan', family: 'file', trustDomain: 'internal', tierLedger: null });
  const pageQueries: string[] = [];
  try {
    const items: RawItem[] = Array.from({ length: 40 }, (_, index) => ({
      identity: { family: 'file', provider: 'fake', accountScope: 'personal', providerItemId: `f${index}`, providerFileId: `f${index}`, localItemId: `personal:f${index}`, sourceVersion: 'v1' },
      mimeType: 'text/plain',
      content: { kind: 'text', text: `note ${index} about the harbor` },
      metadata: { name: `f${index}.txt`, locatorUri: `/f${index}.txt`, pathDisplay: `/f${index}.txt`, updatedAt: '2026-11-10T00:00:00Z' },
      fetchedAt: '2026-11-10T00:00:00Z',
    }));
    const connector: SourceConnector = {
      id: 'fake', family: 'file', async authenticate() {},
      async *listItems() { yield { items, done: true }; },
      async fetchItem(id) { return items.find((item) => item.identity.localItemId === id)!; },
      classificationSignals() { return {}; },
    };
    await store.syncFromConnector(connector, { fetchContent: true });
    const provider: SourceEmbeddingProvider = {
      provider: 'built-in', backend: 'local', modelId: 'scan-plan-v1', epochId: '1', configHash: '1', dimension: 2,
      async embed(inputs) { return inputs.map(() => [1, 0]); },
    };
    await store.embedChunks({ provider });
    // A second model's vectors make the model filter selective, as after a model switch.
    await store.embedChunks({ provider: { ...provider, modelId: 'scan-plan-v2', epochId: '2' } });

    // The pages are read on the store's read-pool thread (#1305).
    setReadPoolObserverForTests((_, read) => {
      if (/FROM chunk_embeddings emb/.test(read.sql) && /emb\.chunk_pk > \?/.test(read.sql)) pageQueries.push(read.sql);
    }, { snapshots: true });
    const lane = await store.vectorSearchLane('harbor', provider, 10, 'personal');
    setReadPoolObserverForTests();
    expect(lane.rows.length).toBeGreaterThan(0);
    expect(pageQueries.length).toBeGreaterThan(0);

    const db = new Database(dbPath, { readonly: true });
    try {
      const plan = (db.query(`EXPLAIN QUERY PLAN ${pageQueries[0]}`).all('scan-plan-v1', 0, 'personal', 256) as Array<{ detail: string }>)
        .map((row) => row.detail);
      expect(plan.some((detail) => /SEARCH emb USING INDEX sqlite_autoindex_chunk_embeddings_1 \(chunk_pk>\?\)/.test(detail))).toBe(true);
      expect(plan.some((detail) => /TEMP B-TREE/.test(detail))).toBe(false);
    } finally {
      db.close();
    }
  } finally {
    setReadPoolObserverForTests();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
