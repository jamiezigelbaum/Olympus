// The read-only store probe (eval/store-probe.ts, #1242) times the vector
// lane's exact page query and the FTS step on a real store file, and prints
// counts only. Synthetic data only.
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { DROPBOX_TIER_CORPUS_IDS } from '../src/workers/dropbox-files/connector-store.ts';
import { probeStoreFile, parseStoreProbeArgs } from '../eval/store-probe.ts';
import { fixtureConnector, RecordingProvider, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

test('reports counts, the primary-key plan and scan timings, with no item text', async () => {
  const { dir, cleanup } = tempDir('olympus-store-probe-');
  cleanups.push(cleanup);
  const dbPath = join(dir, 'internal.sqlite');
  const store = new LocalConnectorStore({ dbPath, corpusId: DROPBOX_TIER_CORPUS_IDS.internal!, family: 'file', trustDomain: 'internal', tierLedger: null });
  try {
    await store.syncFromConnector(fixtureConnector(() => [
      { id: 'k1', name: 'kestrel-invoice.txt', text: 'The Kestrel boatyard invoice total is 4182 dollars.' },
      { id: 'k2', name: 'garden.txt', text: 'Tomatoes along the south fence.' },
    ]), { fetchContent: true });
    await store.embedChunks({ provider: new RecordingProvider('built-in', 'probe-model', 'local') });
  } finally {
    store.close();
  }

  const report = probeStoreFile({ label: 'personal', dbPath, term: 'invoice', scanCapMs: 60_000 });
  expect(report).toMatchObject({ store: 'personal', items: 2, itemsTombstoned: 0 });
  expect(report.embeddingModels).toEqual([expect.objectContaining({ modelId: 'probe-model', rows: 2, currentRows: 2 })]);
  expect((report.vectorPagePlan as string[]).some((detail) => /sqlite_autoindex_chunk_embeddings_1 \(chunk_pk>\?\)/.test(detail))).toBe(true);
  expect(report.vectorFullScan).toMatchObject({ rows: 2, capped: false });
  expect((report.ftsMatch as { rowsUpTo1000: number }).rowsUpTo1000).toBeGreaterThan(0);
  const printed = JSON.stringify(report);
  for (const text of ['Kestrel', 'kestrel-invoice', '4182', 'Tomatoes', 'invoice']) expect(printed).not.toContain(text);
});

test('parses its flags with safe defaults', () => {
  expect(parseStoreProbeArgs([])).toMatchObject({ scanCapMs: 60_000 });
  expect(parseStoreProbeArgs(['--scan-cap-seconds', '5', '--term', 'x'])).toMatchObject({ scanCapMs: 5_000, term: 'x' });
});
