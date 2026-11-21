// bun scripts/admission-parity-bench.ts  (JSON lines, all data under /tmp).
// Each measured workload starts in a fresh reader process with mounted stores.
// Cold = first request, with no attempt to evict the OS filesystem cache.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { openConnectorStore, openTierLedger } from '../src/core/source-storage.ts';
import { forbidWritableStoreOpens } from '../src/core/store-write-guard.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { writeConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { registeredStoreReadScope } from '../src/workers/engine/runtime/store-scope-policies.ts';
import { FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';
import { fixtureLanes, listedItems } from '../test/helpers/admission-fixture.ts';
import { JUDGED_PERSONAL_SNIFFER } from '../test/helpers/tier-fixtures.ts';

const corpusIds = Array.from({ length: 24 }, (_, n) => `internal.fixture.${n}`);
const rowsPerStore = 256;
const warmRuns = 20;
const principal = { provider: 'dropbox', accountScope: 'personal' };
const sourceId = 'dropbox.files';
const query = 'orchard';
const stamp = '2026-11-01T00:00:00.000Z';
const dbPath = (dir: string, corpus: string) => join(dir, `${corpus}.sqlite`);
function authorityAt(dir: string) {
  const registryPath = join(dir, 'handles.json');
  process.env.OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH = registryPath;
  return new FileSourceScopeAuthority({ registryPath, statePath: join(dir, 'approval.json') });
}

async function seed(dir: string, heavy: boolean) {
  const authority = authorityAt(dir);
  writeConnectedHandleRegistry({ version: 1, handles: [{ provider: 'dropbox', accountRole: principal.accountScope,
    providerAccountId: 'fixture-owner', handle: 'dropbox.fixture', allowedCapabilities: ['dropbox.files.sync'],
    scopes: [], connectedAt: stamp }] }, authority.registryPath);
  const before = authority.snapshot(sourceId);
  const approval = authority.approve({ sourceId, expectedRevision: before.revision, accountGeneration: before.accountGeneration!,
    wholeAccount: false, explicitWholeAccountConfirmation: false, selections: [{ key: '/files', state: 'ingest' }] });
  assert.equal(approval.status, 'approved');
  const ledger = openTierLedger({ sourceId }, { dbPath: join(dir, 'ledger.sqlite') });
  try {
    for (const corpusId of corpusIds) {
      const store = openConnectorStore({ sourceId }, { corpusId, dbPath: dbPath(dir, corpusId), family: 'file', trustDomain: 'internal', tierLedger: null });
      try {
        const items: RawItem[] = Array.from({ length: rowsPerStore }, (_, i) => {
          const id = `${corpusId}-${i}`;
          return { identity: { ...principal, family: 'file', providerItemId: id, localItemId: `personal:${id}` },
            metadata: { title: `Orchard ${i}`, pathDisplay: `/files/${i % 32 < 2 ? 'narrow' : 'other'}/${i}` },
            mimeType: 'text/plain', fetchedAt: stamp, content: { kind: 'text', text: `The orchard document ${i}.` } };
        });
        await store.syncFromConnector(listedItems('synthetic', items), { fetchContent: true,
          sourceScopeObservation: () => ({ accountGeneration: approval.accountGeneration!, scopeRevision: approval.revision }) });
        for (const [i, item] of items.entries()) {
          const held = heavy && i % 8 !== 0;
          const decision = classifyItemTiers({ signals: { title: String(item.metadata.title) }, holdUntilJudged: held, text: 'Synthetic orchard document.' },
            held ? {} : { sniffer: JUDGED_PERSONAL_SNIFFER });
          assert.equal(decision.contentPending, held);
          ledger.recordRoutedPlacement(item.identity, decision, { embedHold: held,
            copies: [{ corpusId, trustDomain: 'internal', layers: 'both' }] });
        }
        store.bindTierSet(ledger);
        assert.equal(ledger.corpusHeldCopyCount(corpusId), heavy ? rowsPerStore * 7 / 8 : 0);
      } finally { store.close(); }
    }
  } finally { ledger.close(); }
}

function summary(samples: number[]) {
  const ordered = samples.slice(1).sort((a, b) => a - b);
  const ms = (n: number) => Number(n.toFixed(2));
  const percentile = (p: number) => ms(ordered[Math.ceil(ordered.length * p) - 1]!);
  return { cold_ms: ms(samples[0]!), warm_p50_ms: percentile(0.5), warm_p95_ms: percentile(0.95) };
}

async function measure(dir: string, narrow: boolean, heavy: boolean) {
  assert.equal(dirname(realpathSync(dir)), realpathSync('/tmp'));
  assert.match(basename(dir), /^olympus-admission-bench-[a-zA-Z0-9]+$/);
  forbidWritableStoreOpens();
  const authority = authorityAt(dir);
  const ledger = openTierLedger({ sourceId }, { dbPath: join(dir, 'ledger.sqlite'), readOnly: true });
  const stores = corpusIds.map(corpusId => openConnectorStore({ sourceId }, { dbPath: dbPath(dir, corpusId), corpusId,
    trustDomain: 'internal', family: 'file', readOnly: true, tierLedger: ledger }));
  for (const store of stores) assert.equal(store.governingTierLedger(), ledger);
  const scopes = [{ ledger, corpusIds: new Set(corpusIds), stores: () => stores }];
  // Let each entry point pay for its own first approval read.
  const askAuthority = authorityAt(dir);
  const readScope = () => registeredStoreReadScope(sourceId, authority);
  const lanesFor = fixtureLanes(stores, () => registeredStoreReadScope(sourceId, askAuthority), () => principal);
  const http = createEmailSourceWorker({ connectorStores: stores, connectorStoreReadScope: readScope,
    connectorStorePrincipals: new Map(corpusIds.map(id => [id, principal])), sourceIndexVisibilityGate: createTierVisibilityGate(() => scopes) });
  const folder = narrow ? { approved_scope_key: 'dropbox.personal:/files/narrow' } : {};
  const counter = new Int32Array(new SharedArrayBuffer(4));
  const writer = new Worker(import.meta.filename, { workerData: { dir, counter } });
  try {
    await once(writer, 'message');
    const startWrites = Atomics.load(counter, 0);
    const setup: number[] = [];
    const searches: number[] = [];
    let hitCount = 0;
    for (let i = 0; i <= warmRuns; i++) {
      const t = performance.now();
      const lanes = lanesFor({ question: query, ...folder });
      setup.push(performance.now() - t);
      assert.equal(Object.keys(lanes.adapters).length, corpusIds.length);
      const start = performance.now();
      const response = await http.fetch(new Request('http://fixture/v1/source/index/search', { method: 'POST',
        body: JSON.stringify({ corpus_ids: corpusIds, query, ...folder, max_results: 10, retrieval_mode: 'keyword' }) }));
      const result = await response.json();
      searches.push(performance.now() - start);
      assert.equal(response.status, 200);
      assert.deepEqual(result.audit.skipped_corpora, []);
      assert.equal(result.results.length, corpusIds.length);
      hitCount = 0;
      for (const [s, lane] of result.results.entries()) {
        assert.equal(lane.corpus_id, corpusIds[s]);
        assert.equal(lane.hits.length, heavy && narrow ? 8 : 10);
        for (const hit of lane.hits) {
          const n = Number(hit.sourceItem.providerItemId.split('-').at(-1));
          assert.ok(!narrow || n % 32 < 2);
          assert.ok(!heavy || n % 8 === 0);
        }
        hitCount += lane.hits.length;
      }
    }
    const writes = Atomics.load(counter, 0) - startWrites;
    assert.ok(writes > 0);
    console.log(JSON.stringify({ stores: stores.length, rows_per_store: rowsPerStore, held_per_store: heavy ? rowsPerStore * 7 / 8 : 0,
      folder: narrow ? 'narrow' : 'all approved', warm_runs: warmRuns, writer_syncs: writes, hits: hitCount,
      ask_setup: summary(setup), search: summary(searches), platform: process.platform, arch: process.arch, bun: Bun.version }));
  } finally {
    await writer.terminate();
    http.close();
    for (const store of stores) store.close();
    ledger.close();
  }
}

if (!isMainThread) {
  // A completed empty incremental sync writes a real receipt while leaving
  // the population and ranking of the measured query stable.
  const { dir, counter } = workerData as { dir: string; counter: Int32Array };
  const stores = corpusIds.map(corpusId => openConnectorStore({ sourceId }, {
    corpusId, dbPath: dbPath(dir, corpusId), family: 'file', trustDomain: 'internal',
  }));
  const writer: SourceConnector = {
    id: 'fixture.writer', family: 'file', async authenticate() {},
    async *listItems() { yield { items: [], done: true }; },
    async fetchItem(): Promise<never> { throw new Error('Empty sync has no items'); },
    classificationSignals() { return {}; },
  };
  let n = 0;
  while (true) {
    const receipt = await stores[n++ % stores.length]!.syncFromConnector(writer);
    assert.equal(receipt.status, 'completed');
    Atomics.add(counter, 0, 1);
    if (n === 1) parentPort!.postMessage('ready');
    await delay(2);
  }
} else if (process.argv[2] === 'reader') {
  await measure(process.argv[3]!, process.argv[4] === 'narrow', process.argv[5] === 'held');
} else {
  for (const heavy of [false, true]) {
    const dir = mkdtempSync('/tmp/olympus-admission-bench-');
    process.env.HOME = dir;
    try {
      await seed(dir, heavy);
      for (const folder of ['wide', 'narrow']) {
        const reader = Bun.spawn([process.execPath, import.meta.filename, 'reader', dir, folder, heavy ? 'held' : 'clear'],
          { stdout: 'inherit', stderr: 'inherit' });
        assert.equal(await reader.exited, 0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
