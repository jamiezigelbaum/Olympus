// Every store gets its vectors one way, whatever source filled it. A store
// that per-item routing, an import, or a later read fills has no sync of its
// own that could queue it; per-source embed wiring is how such a store once
// stayed keyword-only for good (Evernote's Personal store, test-mac
// 2026-10-28). So: no source declares its own embed task, and the one
// store-level plan gives every store served by meaning a store-wide catch-up.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { defaultSourceCorpusRegistryConfig } from '../src/core/source-corpus-registry.ts';
import { storageAccountForCorpus } from '../src/core/source-placement.ts';
import { archiveImportCorpora } from '../src/workers/archive-import/store.ts';
import { QUEUE_ONLY_METERED_EMBEDDING, planStoreEmbedding } from '../src/workers/connector-store/embedding-plan.ts';
import { storeEmbeddingScope, type SourceEmbeddingScopePolicy } from '../src/workers/connector-store/embedding-scope.ts';
import { embedPendingChunks, LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { writeConnectedHandleRegistry, type ConnectedCredentialHandle } from '../src/workers/credential-broker/connected-handles.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { createStoreEmbeddingScopeFor, registeredStoreReadScope } from '../src/workers/engine/runtime/store-scope-policies.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { withEmbeddingSweep, type SourceSchedulerSource } from '../src/workers/source-scheduler.ts';
import { FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';
import { RecordingProvider } from './helpers/tier-fixtures.ts';

const SRC = new URL('../src/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const LIVE_TEXT = 'The original live record contains a red gate.';
const IMPORTED_TEXT = 'The imported record contains a blue gate.';

function fixtureConnector(
  id: string, itemId: string, text: string,
  principal: Pick<RawItem['identity'], 'provider' | 'family' | 'accountScope'> =
    { provider: 'fixture', family: 'x-fixture', accountScope: 'owner' },
): SourceConnector {
  const item: RawItem = {
    identity: {
      ...principal,
      localItemId: itemId, providerItemId: itemId, sourceVersion: 'v1',
    },
    mimeType: 'text/plain',
    metadata: { title: itemId },
    content: { kind: 'text', text },
    fetchedAt: '2026-11-20T12:00:00.000Z',
  };
  return {
    id, family: principal.family,
    async authenticate() {},
    async *listItems() { yield { items: [item], done: true }; },
    async fetchItem() { return item; },
    classificationSignals() { return {}; },
  };
}

describe('embedding paths', () => {
  test('the shared sweep is the only embed task: no source wires its own', () => {
    const declaring = sourceFiles(SRC)
      .filter((path) => /kind:\s*'embed'/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(declaring).toEqual(['workers/source-scheduler.ts']);
    const scheduler = readFileSync(join(SRC, 'workers/source-scheduler.ts'), 'utf8');
    expect(scheduler.match(/kind:\s*'embed'/g)).toHaveLength(1);
    expect(scheduler).toMatch(/function embeddingSweepTask\([\s\S]*?kind: 'embed'/);
  });

  test('every store served by meaning catches up store-wide, whether or not a sync of its own fills it', () => {
    const corpora = [...defaultSourceCorpusRegistryConfig().corpora, ...archiveImportCorpora()]
      .filter((corpus) => corpus.activationMode !== 'lexical_only');
    // The stores per-item routing or an import fills are among them.
    expect(corpora.some((corpus) => !(corpus.capabilities ?? []).includes('sync'))).toBe(true);
    const missing = corpora.filter((corpus) => {
      const provider = corpus.trustDomain === 'secure_local'
        ? new RecordingProvider('built-in', 'embeddinggemma', 'local')
        : new RecordingProvider('google-gemini', 'gemini-embedding-2', 'cloud');
      const store = { corpusId: corpus.corpusId, trustDomain: corpus.trustDomain } as unknown as LocalConnectorStore;
      const target = planStoreEmbedding({ store, provider, servedByMeaning: true, scope: { allowed: true } });
      return target?.wholeStore !== true && QUEUE_ONLY_METERED_EMBEDDING[corpus.corpusId] === undefined;
    }).map((corpus) => corpus.corpusId);
    expect(missing).toEqual([]);
  });

  test('the registered Evernote scope restricts the sweep to approved notebooks and stops queued work after reconnect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'embedding-scope-evernote-'));
    const registryPath = join(dir, 'handles.json');
    const registryKey = 'OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH';
    const pinKey = 'OLYMPUS_SOURCE_INDEX_EVERNOTE_CREDENTIAL_HANDLE';
    const savedRegistry = process.env[registryKey];
    const savedPin = process.env[pinKey];
    const handle: ConnectedCredentialHandle = {
      handle: 'evernote.personal', provider: 'evernote', accountRole: 'personal', providerAccountId: 'fixture-owner',
      connectedAt: '2026-11-20T12:00:00.000Z', scopes: ['read'], allowedCapabilities: ['evernote.notes.sync'],
    };
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'notes.sqlite'), corpusId: 'internal.evernote.notes', family: 'note', trustDomain: 'internal', tierLedger: null,
    });
    try {
      process.env[registryKey] = registryPath;
      process.env[pinKey] = handle.handle;
      writeConnectedHandleRegistry({ version: 1, handles: [handle] }, registryPath);
      const authority = new FileSourceScopeAuthority({ registryPath, statePath: join(dir, 'scope.json') });
      const sourceIdForStore = (leg: LocalConnectorStore) => storageAccountForCorpus(leg).sourceId;
      const sourceId = sourceIdForStore(store);
      const approve = (selections: Parameters<FileSourceScopeAuthority['approve']>[0]['selections']) => {
        const current = authority.snapshot(sourceId);
        return authority.approve({
          sourceId, accountGeneration: current.accountGeneration!, expectedRevision: current.revision, selections,
          wholeAccount: false, explicitWholeAccountConfirmation: false,
        });
      };
      const first = approve([{ key: 'work', state: 'ingest' }, { key: 'home', state: 'ingest' }]);
      const bodies = { work: 'The approved notebook has a work note.', home: 'The excluded notebook has a home note.' };
      for (const [notebook, text] of Object.entries(bodies)) {
        const connector = fixtureConnector(`fixture.${notebook}`, notebook, text,
          { family: 'note', provider: 'evernote', accountScope: 'personal' });
        await store.syncFromConnector(connector, {
          fetchContent: true,
          sourceScopeObservation: () => ({
            accountGeneration: first.accountGeneration!, scopeRevision: first.revision, folderKeys: [notebook],
          }),
        });
      }
      expect(store.status().counts).toMatchObject({ chunks: 2, embeddedChunks: 0 });
      approve([{ key: 'work', state: 'ingest' }, { key: 'home', state: 'exclude' }]);
      const provider = new RecordingProvider('built-in', 'fixture', 'local');
      const embeddingScopeFor = createStoreEmbeddingScopeFor({
        authority, sourceIdForStore,
        readScope: (leg) => registeredStoreReadScope(sourceIdForStore(leg), authority),
      });
      const sweep = () => {
        const target = planStoreEmbedding({ store, provider, servedByMeaning: true, scope: embeddingScopeFor(store, provider) });
        return embedPendingChunks(target ? [target] : [], { maxItems: 10 });
      };
      store.queueEmbedding(['home'], provider);
      expect(await sweep()).toMatchObject([{ chunksEmbedded: 1 }]);
      expect(provider.inputs).toEqual([expect.stringContaining(bodies.work)]);
      expect(store.status().counts.embeddedChunks).toBe(1);

      writeConnectedHandleRegistry({ version: 1, handles: [{ ...handle, connectedAt: '2026-11-20T13:00:00.000Z' }] }, registryPath);
      store.queueEmbedding(['home'], provider);
      expect(store.queuedEmbeddingItemIds()).toEqual(['home']);
      expect(await sweep()).toEqual([]);
      expect(provider.inputs).toHaveLength(1);
      expect(store.status().counts.embeddedChunks).toBe(1);
    } finally {
      if (savedRegistry === undefined) delete process.env[registryKey];
      else process.env[registryKey] = savedRegistry;
      if (savedPin === undefined) delete process.env[pinKey];
      else process.env[pinKey] = savedPin;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe.each(['fixture.original', 'fixture.renamed'])('scope parity for %s', (sourceId) => {
    test.each([
      { origin: 'live', expected: [LIVE_TEXT] },
      { origin: 'imported', expected: [IMPORTED_TEXT] },
      { origin: 'denied', expected: [] },
    ] as const)('scheduled and manual paths honor $origin policy over the same live and imported rows', async ({ origin, expected }) => {
      const dir = mkdtempSync(join(tmpdir(), 'embedding-scope-parity-'));
      const corpusId = `internal.${sourceId}`;
      const source: SourceSchedulerSource = {
        sourceId, corpusId, cadence: 'continuous', intervalMs: 60_000, freshnessThresholdHours: 24, tasks: [],
      };
      const liveId = `${sourceId}.live`;
      const archivePrefix = `${sourceId}.archive.`;
      const policy: SourceEmbeddingScopePolicy = () => origin === 'denied'
        ? { allowed: false }
        : {
            allowed: true,
            accountScope: 'owner',
            filters: origin === 'live'
              ? { observedConnectorId: liveId }
              : { observedConnectorIdPrefix: archivePrefix },
          };
      const embeddingScopeFor = (store: LocalConnectorStore, provider: SourceEmbeddingProvider) => storeEmbeddingScope({
        store, provider, policy, scopeRef: undefined, authority: undefined,
        readScope: () => ({ allowed: true, contentAllowed: true }),
      });

      async function run(route: 'scheduled' | 'manual') {
        const store = new LocalConnectorStore({
          dbPath: join(dir, `${route}.sqlite`), corpusId, family: 'x-fixture', trustDomain: 'internal', tierLedger: null,
        });
        try {
          await store.syncFromConnector(fixtureConnector(liveId, 'live', LIVE_TEXT), { fetchContent: true });
          await store.syncFromConnector(fixtureConnector(`${archivePrefix}1`, 'imported', IMPORTED_TEXT), { fetchContent: true });
          expect(store.status().counts).toMatchObject({ chunks: 2, embeddedChunks: 0 });
          const provider = new RecordingProvider('built-in', 'fixture', 'local');
          // A stale queued item must not bypass the current population filter.
          store.queueEmbedding(origin === 'live' ? ['imported'] : ['live'], provider);
          if (route === 'scheduled') {
            const [swept] = withEmbeddingSweep([source], () => () => {
              const target = planStoreEmbedding({ store, provider, servedByMeaning: true, scope: embeddingScopeFor(store, provider) });
              return target ? [target] : [];
            });
            expect(await swept!.tasks[0]!.run()).toMatchObject({ counts: { chunks_embedded: expected.length } });
          } else {
            const worker = createEmailSourceWorker({
              connectorStores: [store], connectorStoreEmbeddingProviders: new Map([[corpusId, provider]]),
              embeddingScopeFor,
            });
            try {
              const response = await worker.fetch(new Request('http://worker.test/v1/source/index/embed', {
                method: 'POST', body: JSON.stringify({ corpus_id: corpusId }),
              }));
              expect(response.status).toBe(origin === 'denied' ? 403 : 200);
              expect(await response.json()).toMatchObject(origin === 'denied'
                ? { error: { code: 'source_index_policy_violation' } }
                : { chunksEmbedded: expected.length });
            } finally {
              worker.close();
            }
          }
          expect(store.status().counts.embeddedChunks).toBe(expected.length);
          return provider.inputs;
        } finally {
          store.close();
        }
      }

      try {
        const scheduled = await run('scheduled');
        const manual = await run('manual');
        const embeddedBodies = [LIVE_TEXT, IMPORTED_TEXT].filter((text) => scheduled.some((input) => input.includes(text)));
        expect(embeddedBodies).toEqual([...expected]);
        expect(manual).toEqual(scheduled);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
