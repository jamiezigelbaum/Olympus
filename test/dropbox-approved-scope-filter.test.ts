import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  connectorStoreCurrentEmbeddingRows,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
  type ConnectorStoreSearchFilters,
  type ConnectorStoreSearchRow,
} from '../src/workers/connector-store/index.ts';
import { DROPBOX_FILES_CORPUS_ID } from '../src/workers/dropbox-files/index.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import type {
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

const COMMON_TEXT = 'approved scope lane fixture';
const DROPBOX_PRINCIPAL = Object.freeze({ provider: 'dropbox', accountScope: 'personal' });
const PATH_ITEMS = [
  scopeItem('exact', '/2 Areas', '2026-07-01T10:00:00.000Z'),
  scopeItem('child', '/2 Areas/Child/report.txt', '2026-07-02T10:00:00.000Z'),
  scopeItem('case', '/2 Areas/Case/report.txt', '2026-07-03T10:00:00.000Z'),
  scopeItem('literal-meta', '/2 Areas/100%_Ready/report.txt', '2026-07-04T10:00:00.000Z'),
  scopeItem('percent-trap', '/2 Areas/100ABC_Ready/report.txt', '2026-07-05T10:00:00.000Z'),
  scopeItem('underscore-trap', '/2 Areas/100%XReady/report.txt', '2026-07-06T10:00:00.000Z'),
  scopeItem('sibling', '/2 AreasX/trap.txt', '2026-07-07T10:00:00.000Z'),
  scopeItem('other-root', '/1 Projects/plan.txt', '2026-07-08T10:00:00.000Z'),
  scopeItem('null-locator', undefined, '2026-07-09T10:00:00.000Z'),
  scopeItem('non-ascii-case', '/Ångström/Case/report.txt', '2026-07-10T10:00:00.000Z'),
] as const;

describe('Dropbox connector-store approved scope narrowing', () => {
  test('the generic locator predicate constrains keyword, vector eligibility, hydration, and recency', async () => {
    await withScopeStore(async (store) => {
      const provider = fakeEmbeddingProvider();
      await store.embedChunks({ provider });
      const filters: ConnectorStoreSearchFilters = {
        provider: 'dropbox',
        locatorPathScope: '/2 areas',
      };
      const expected = [
        'exact',
        'child',
        'case',
        'literal-meta',
        'percent-trap',
        'underscore-trap',
      ];

      expect(ids(store.searchItems(COMMON_TEXT, 20, 'personal', filters)).sort()).toEqual([...expected].sort());
      expect(ids(store.recentItems(20, 'personal', filters)).sort()).toEqual([...expected].sort());
      expect(ids(await store.vectorSearchItems(COMMON_TEXT, provider, 20, 'personal', filters)).sort())
        .toEqual([...expected].sort());
      expect(connectorStoreCurrentEmbeddingRows(storeDb(store), {
        modelId: provider.modelId,
        accountScope: 'personal',
        filters,
      }).map((row) => providerId(row.localItemId)).sort()).toEqual([...expected].sort());

      const pks = storeDb(store).query(
        'SELECT item_pk FROM items WHERE provider = ? ORDER BY item_pk',
      ).all('dropbox') as Array<{ item_pk: number }>;
      const hydrated = (store as unknown as {
        searchRowsByItemPks(
          itemPks: number[],
          accountScope?: string,
          selectedFilters?: ConnectorStoreSearchFilters,
        ): ConnectorStoreSearchRow[];
      }).searchRowsByItemPks(pks.map((row) => row.item_pk), 'personal', filters);
      expect(ids(hydrated).sort()).toEqual([...expected].sort());

      const adapter = createConnectorStoreCorpusAdapter({
        store,
        embeddingProvider: provider,
        retrievalMode: 'hybrid',
        accountScope: 'personal',
        filters,
      });
      const response = await adapter({
        corpus: defineConnectorCorpus({
          corpusId: store.corpusId,
          family: store.family,
          trustDomain: store.trustDomain,
        }),
        query: COMMON_TEXT,
        maxResults: 20,
        context: { allowedTrustDomains: ['secure_local'] },
      });
      expect(response.hits.map((hit) => hit.sourceItem.providerItemId).sort()).toEqual([...expected].sort());
      expect((response.laneAudits ?? []).map((lane) => lane.laneType).sort()).toEqual([
        'hybrid',
        'keyword',
        'semantic',
      ]);
    });
  });

  test('matches exact-or-child paths case-insensitively while escaping LIKE metacharacters and excluding NULL', async () => {
    await withScopeStore(async (store) => {
      const search = (locatorPathScope: string) => ids(store.searchItems(COMMON_TEXT, 20, 'personal', {
        provider: 'dropbox',
        locatorPathScope,
      }));

      expect(search('/2 areas')).toContain('exact');
      expect(search('/2 areas')).toContain('child');
      expect(search('/2 areas')).not.toContain('sibling');
      expect(search('/2 areas')).not.toContain('null-locator');
      expect(search('/2 Areas/100%_Ready')).toEqual(['literal-meta']);
      expect(search('/ÅNGSTRöM')).toEqual(['non-ascii-case']);
      expect(search('/')).toEqual(expect.arrayContaining(PATH_ITEMS
        .filter((item) => item.locatorUri !== undefined)
        .map((item) => item.id)));
      expect(search('/')).not.toContain('null-locator');
    });
  });

  test('the worker composes scope with account, dates, trust domain, and every fail-closed edge', async () => {
    await withScopeStore(async (dropboxStore) => {
      const driveDir = mkdtempSync(join(tmpdir(), 'olympus-drive-scope-control-'));
      const driveStore = new LocalConnectorStore({
        dbPath: join(driveDir, 'drive.sqlite'),
        corpusId: 'internal.drive.docs',
        family: 'file',
        trustDomain: 'internal',
      });
      const worker = createEmailSourceWorker({
        connectorStores: [dropboxStore, driveStore],
        connectorStorePrincipals: new Map([
          [DROPBOX_FILES_CORPUS_ID, DROPBOX_PRINCIPAL],
          ['internal.drive.docs', { provider: 'google_drive', accountScope: 'personal' }],
        ]),
      });
      const search = async (
        corpusId: string,
        body: Record<string, unknown>,
      ): Promise<{ status: number; body: Record<string, any> }> => {
        const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
          method: 'POST',
          body: JSON.stringify({ corpus_id: corpusId, query: COMMON_TEXT, ...body }),
          headers: { 'Content-Type': 'application/json' },
        }));
        return { status: response.status, body: await response.json() };
      };

      try {
        const narrowed = await search(DROPBOX_FILES_CORPUS_ID, {
          approved_scope_key: 'dropbox.personal:/2 areas',
          account: 'personal',
          authored_after: '2026-07-02T00:00:00Z',
          authored_before: '2026-07-03T23:59:59Z',
          trust_domain: 'secure_local',
        });
        expect(narrowed.status).toBe(200);
        expect(resultIds(narrowed.body)).toEqual(['case', 'child']);

        const root = await search(DROPBOX_FILES_CORPUS_ID, {
          approved_scope_key: 'dropbox.personal:/',
        });
        expect(root.status).toBe(200);
        expect(resultIds(root.body)).toEqual(expect.arrayContaining(PATH_ITEMS
          .filter((item) => item.locatorUri !== undefined)
          .map((item) => item.id)));
        expect(resultIds(root.body)).not.toContain('null-locator');
        expect(resultIds(root.body)).not.toContain('drive-trap');

        const folderId = await search(DROPBOX_FILES_CORPUS_ID, {
          approved_scope_key: 'dropbox.personal:folder_id:id:abc123',
        });
        expect(folderId.status).toBe(400);
        expect(folderId.body.error).toMatchObject({ code: 'invalid_request' });
        expect(folderId.body.error.message).toContain('folder_id');
        expect(folderId.body.error.message).toContain('not persisted');

        for (const approvedScopeKey of [
          'dropbox.personal:',
          'dropbox.personal',
          'dropbox.work:/2 Areas',
          'google_drive.personal:/2 Areas',
          ' dropbox.personal:/2 Areas',
          'dropbox.personal:/2 Areas ',
          'dropbox.personal:/2 Areas/',
          'dropbox.personal:\t/2 Areas',
          'dropbox.personal:/2 Areas\u0080Control',
          'dropbox.personal:/2 Areas\u009fControl',
        ]) {
          const malformed = await search(DROPBOX_FILES_CORPUS_ID, {
            approved_scope_key: approvedScopeKey,
          });
          expect({ approvedScopeKey, status: malformed.status }).toEqual({ approvedScopeKey, status: 400 });
          expect(malformed.body.error.code).toBe('invalid_request');
        }

        const contradiction = await search(DROPBOX_FILES_CORPUS_ID, {
          approved_scope_key: 'dropbox.personal:/2 Areas',
          account: 'work',
        });
        expect(contradiction.status).toBe(400);
        expect(contradiction.body.error).toMatchObject({ code: 'invalid_request' });
        expect(contradiction.body.error.message).toContain('account');
        expect(contradiction.body.error.message).toContain('approved_scope_key');

        const drive = await search('internal.drive.docs', {
          approved_scope_key: 'dropbox.personal:/2 Areas',
        });
        expect(drive.status).toBe(400);
        expect(drive.body.error).toMatchObject({ code: 'unsupported_filter' });
      } finally {
        driveStore.close();
        rmSync(driveDir, { recursive: true, force: true });
      }
    });
  });

});

interface ScopeItem {
  id: string;
  locatorUri?: string;
  authoredAt: string;
  provider?: string;
}

function scopeItem(id: string, locatorUri: string | undefined, authoredAt: string): ScopeItem {
  return { id, ...(locatorUri !== undefined ? { locatorUri } : {}), authoredAt };
}

async function withScopeStore(run: (store: LocalConnectorStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-dropbox-scope-store-'));
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'dropbox.sqlite'),
    corpusId: DROPBOX_FILES_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  try {
    await store.syncFromConnector(scopeConnector(PATH_ITEMS), { fetchContent: true });
    await store.syncFromConnector(scopeConnector([
      { ...scopeItem('drive-trap', '/2 Areas/Drive Trap.txt', '2026-07-02T12:00:00.000Z'), provider: 'google_drive' },
    ]), { fetchContent: true });
    await run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function scopeConnector(items: readonly ScopeItem[]): SourceConnector {
  const rawItems = items.map((item): RawItem => ({
    identity: {
      family: 'file',
      provider: item.provider ?? 'dropbox',
      accountScope: 'personal',
      providerItemId: item.id,
      providerFileId: item.id,
      localItemId: `personal:${item.id}`,
      sourceVersion: `${item.id}:v1`,
    },
    mimeType: 'text/plain; charset=utf-8',
    content: { kind: 'text', text: COMMON_TEXT },
    metadata: Object.freeze({
      title: item.id,
      authoredAt: item.authoredAt,
      updatedAt: item.authoredAt,
      ...(item.locatorUri !== undefined
        ? { locatorUri: item.locatorUri, pathDisplay: item.locatorUri }
        : {}),
    }),
    fetchedAt: item.authoredAt,
  }));
  const byId = new Map(rawItems.map((item) => [item.identity.localItemId, item]));
  return {
    id: `scope-${items[0]?.provider ?? 'dropbox'}-fixture`,
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: rawItems, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = byId.get(localItemId);
      if (!item) throw new Error(`missing scope fixture ${localItemId}`);
      return item;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}

function fakeEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'scope-fixture',
    modelId: 'scope-fixture-v1',
    dimension: 2,
    configHash: 'scope-fixture-config',
    epochId: 'scope-fixture-epoch',
    backend: 'local',
    async embed(inputs: SourceEmbeddingInput[]): Promise<number[][]> {
      return inputs.map(() => [1, 0]);
    },
  };
}

function storeDb(store: LocalConnectorStore): import('bun:sqlite').Database {
  return (store as unknown as { db: import('bun:sqlite').Database }).db;
}

function ids(rows: readonly ConnectorStoreSearchRow[]): string[] {
  return rows.map((row) => row.sourceItem.providerItemId);
}

function providerId(localItemId: string): string {
  return localItemId.slice(localItemId.indexOf(':') + 1);
}

function resultIds(body: Record<string, any>): string[] {
  return (body.hits ?? []).map((hit: { sourceItem: { providerItemId: string } }) => hit.sourceItem.providerItemId).sort();
}
