import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  approveFileSourceScope,
  connectedFileSourceAccountGeneration,
  fileSourceScopeAllowsContent,
  fileSourceScopeAllowsMetadata,
  readFileSourceScopeApproval,
} from '../src/core/source-scope-approval.ts';
import {
  FileSourceScopeAuthority,
  fileSourceScopeContentFilters,
  fileSourceScopeDropboxPolicy,
  fileSourceScopeMetadataFilters,
  scopeBoundSchedulerSource,
} from '../src/workers/source-scope-runtime.ts';
import {
  createDropboxFolderScopeBrowser,
  createGoogleDriveFolderScopeBrowser,
} from '../src/workers/source-scope-browser.ts';
import {
  LocalConnectorStore,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { GoogleDriveSourceConnector } from '../src/workers/google-connectors/drive.ts';
import { createGoogleDriveConnectorStoreSyncHandler } from '../src/workers/google-connectors/drive-live-sync.ts';
import { createDropboxProviderStoreSyncHandler } from '../src/workers/dropbox-files/provider-store-sync.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { SourceScheduler } from '../src/workers/source-scheduler.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

function registry(connectedAt = '2026-09-10T10:00:00.000Z') {
  return {
    version: 1 as const,
    handles: [{
      handle: 'dropbox.personal',
      provider: 'dropbox' as const,
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: [],
      connectedAt,
      accountRole: 'personal',
      providerAccountId: 'account-1',
    }],
  };
}

describe('file-source scope approval', () => {
  test('missing state is stable pending and a reconnect invalidates approval', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-scope-'));
    const statePath = join(dir, 'scope.json');
    const first = readFileSourceScopeApproval({ sourceId: 'dropbox.files', registry: registry(), statePath });
    expect(first).toMatchObject({ status: 'scope_pending', wholeAccount: false, selections: [] });
    expect(readFileSourceScopeApproval({ sourceId: 'dropbox.files', registry: registry(), statePath }).revision)
      .toBe(first.revision);
    expect(connectedFileSourceAccountGeneration('dropbox.files', {
      ...registry(),
      handles: registry().handles.map((handle) => ({
        ...handle,
        backendState: { status: 'available', refreshedAt: '2026-09-10T10:30:00.000Z' },
      })),
    })!.generation).toBe(first.accountGeneration!);
    const generation = connectedFileSourceAccountGeneration('dropbox.files', registry())!.generation;
    const approved = approveFileSourceScope({
      sourceId: 'dropbox.files',
      registry: registry(),
      statePath,
      accountGeneration: generation,
      expectedRevision: first.revision,
      selections: [{ key: '/team/work', state: 'ingest', ancestorKeys: ['/team'] }],
      wholeAccount: false,
      explicitWholeAccountConfirmation: false,
    });
    expect(approved.status).toBe('approved');
    expect(readFileSourceScopeApproval({ sourceId: 'dropbox.files', registry: registry(), statePath }).selections)
      .toEqual([{ key: '/team/work', state: 'ingest', ancestorKeys: ['/team'] }]);
    expect(readFileSourceScopeApproval({
      sourceId: 'dropbox.files',
      registry: registry('2026-09-10T11:00:00.000Z'),
      statePath,
    })).toMatchObject({ status: 'scope_pending', reason: 'account_changed' });
  });

  test('whole account needs explicit confirmation and exclude-only is approved as no ingestion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-scope-'));
    const statePath = join(dir, 'scope.json');
    const pending = readFileSourceScopeApproval({ sourceId: 'dropbox.files', registry: registry(), statePath });
    expect(() => approveFileSourceScope({
      sourceId: 'dropbox.files', registry: registry(), statePath,
      accountGeneration: pending.accountGeneration!, expectedRevision: pending.revision,
      selections: [], wholeAccount: true, explicitWholeAccountConfirmation: false,
    })).toThrow('Whole-account access requires');
    const denied = approveFileSourceScope({
      sourceId: 'dropbox.files', registry: registry(), statePath,
      accountGeneration: pending.accountGeneration!, expectedRevision: pending.revision,
      selections: [{ key: '/private', state: 'exclude' }],
      wholeAccount: false, explicitWholeAccountConfirmation: false,
    });
    expect(denied.status).toBe('approved');
    expect(fileSourceScopeContentFilters(denied)).toEqual({ allowed: false });
  });

  test('malformed state fails closed and default policy root never becomes consent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-scope-'));
    const statePath = join(dir, 'scope.json');
    writeFileSync(statePath, '{bad');
    const snapshot = readFileSourceScopeApproval({ sourceId: 'dropbox.files', registry: registry(), statePath });
    expect(snapshot).toMatchObject({ status: 'scope_pending', reason: 'malformed' });
    const base = {
      schemaVersion: 1 as const,
      source: 'dropbox.personal', corpusId: 'secure_local.dropbox.files',
      roots: [{ path: '/', approved_scope_key: 'dropbox.personal:/', default_action: 'full_extract' as const }],
      rules: [], sync: { cadence: 'continuous' as const, max_entries_per_pass: 25_000, max_pages_per_pass: 1_000 },
      content: { default_extractor_kind: 'text', default_extractor_version: '1', plan_limit: 10, batch_size: 5 },
    };
    expect(fileSourceScopeDropboxPolicy(base, snapshot).roots).toEqual([]);

    writeFileSync(statePath, JSON.stringify({
      version: 1,
      approvals: [{
        source_id: 'dropbox.files', account_generation: 'a'.repeat(64), revision: 'a'.repeat(36),
        status: 'approved', selections: [{ key: '/work', state: 'ingest' }], whole_account: false,
        approved_at: '2026-09-10T10:00:00.000Z',
      }],
    }));
    expect(readFileSourceScopeApproval({ sourceId: 'dropbox.files', registry: registry(), statePath }))
      .toMatchObject({ status: 'scope_pending', reason: 'malformed' });
  });

  test('authority fails closed when the registry is unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-scope-'));
    const authority = new FileSourceScopeAuthority({
      registryPath: join(dir, 'handles.json'),
      statePath: join(dir, 'scope.json'),
      readRegistry: () => { throw new Error('bad registry'); },
    });
    expect(authority.snapshot('dropbox.files')).toMatchObject({ status: 'scope_pending', reason: 'malformed' });
    expect(authority.policyRef('dropbox.files')).toBeUndefined();
  });
});

describe('lazy folder browsing', () => {
  test('Drive lists folders without calling content methods', async () => {
    const calls: string[] = [];
    const browser = createGoogleDriveFolderScopeBrowser({
      credentialHandle: 'google_drive.personal',
      apiClient: {
        async listFiles(request) {
          calls.push(request.query ?? '');
          return { files: [{ id: 'folder-1', name: 'Work', mimeType: 'application/vnd.google-apps.folder' }] };
        },
        async exportGoogleDocText() { throw new Error('content read'); },
        async downloadTextFile() { throw new Error('content read'); },
        async downloadFileBytes() { throw new Error('content read'); },
      },
    });
    const page = await browser.browse({});
    expect(page.nodes).toEqual([expect.objectContaining({ key: 'folder-1', name: 'Work' })]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("'root' in parents");
  });

  test('Drive validation records ancestry and narrows a child under metadata-only', async () => {
    const browser = createGoogleDriveFolderScopeBrowser({
      credentialHandle: 'google_drive.personal',
      apiClient: {
        async listFiles() { return { files: [] }; },
        async getFolder(id) {
          if (id === 'folder-a') return { id, parents: ['root'] };
          if (id === 'folder-b') return { id, parents: ['folder-a'] };
          return { id, parents: [] };
        },
        async exportGoogleDocText() { throw new Error('content read'); },
        async downloadTextFile() { throw new Error('content read'); },
        async downloadFileBytes() { throw new Error('content read'); },
      },
    });
    expect(await browser.validateSelections([
      { key: 'folder-a', state: 'metadata_only' },
      { key: 'folder-b', state: 'ingest' },
    ])).toEqual([
      { key: 'folder-a', state: 'metadata_only', ancestorKeys: ['root'] },
      { key: 'folder-b', state: 'metadata_only', ancestorKeys: ['folder-a', 'root'] },
    ]);
  });

  test('Dropbox uses a non-recursive metadata request only', async () => {
    const requests: unknown[] = [];
    const browser = createDropboxFolderScopeBrowser({
      credentialHandle: 'dropbox.personal',
      metadataClient: {
        async listFolder(request) {
          requests.push(request);
          return { entries: [{ tag: 'folder', id: 'id:1', name: 'Photos', pathLower: '/photos' }] };
        },
        async listFolderContinue() { throw new Error('unexpected continuation'); },
      },
    });
    const page = await browser.browse({});
    expect(page.nodes[0]).toMatchObject({ key: '/photos', name: 'Photos' });
    expect(requests).toEqual([expect.objectContaining({ path: '', recursive: false, includeDeleted: false })]);
  });
});

test('whole-account scope still honors narrower metadata-only and excluded descendants', () => {
  const approval = {
    sourceId: 'google_drive.docs' as const,
    status: 'approved' as const,
    accountGeneration: '9'.repeat(64),
    revision: '99999999-9999-4999-9999-999999999999',
    selections: [
      { key: 'metadata-folder', state: 'metadata_only' as const },
      { key: 'excluded-folder', state: 'exclude' as const },
    ],
    wholeAccount: true,
  };
  expect(fileSourceScopeAllowsMetadata(approval, ['metadata-folder'])).toBe(true);
  expect(fileSourceScopeAllowsContent(approval, ['metadata-folder'])).toBe(false);
  expect(fileSourceScopeAllowsMetadata(approval, ['excluded-folder'])).toBe(false);
  expect(fileSourceScopeAllowsContent(approval, ['excluded-folder'])).toBe(false);
  expect(fileSourceScopeAllowsContent(approval, ['unselected-folder'])).toBe(true);
});

test('Drive metadata-only scope reads no content and creates no vectors', async () => {
  let contentReads = 0;
  const connector = new GoogleDriveSourceConnector({
    account: 'personal',
    maxFiles: 10,
    maxContentFiles: 10,
    apiClient: {
      async listFiles() {
        return { files: [{
          id: 'file-1', name: 'Notes', mimeType: 'text/plain', parents: ['folder-1'], modifiedTime: '2026-09-10T10:00:00.000Z',
        }] };
      },
      async getFolder(id) { return { id, name: 'Folder', parents: ['root'] }; },
      async exportGoogleDocText() { contentReads += 1; return 'secret'; },
      async downloadTextFile() { contentReads += 1; return 'secret'; },
      async downloadFileBytes() { contentReads += 1; return { bytes: new Uint8Array(), sizeBytes: 0 }; },
    },
    scope: {
      generation: 'c'.repeat(64),
      revision: '33333333-3333-4333-8333-333333333333',
      allowsMetadata: () => true,
      allowsContent: () => false,
    },
  });
  const store = new LocalConnectorStore({
    dbPath: ':memory:', corpusId: 'internal.drive.docs', family: 'file', trustDomain: 'internal',
  });
  await store.syncFromConnector(connector, {
    fetchContent: true,
  });
  expect(contentReads).toBe(0);
  expect(store.status().counts.embeddedChunks).toBe(0);
  expect(store.localContent('personal:file-1', 100)?.chunks).toEqual([]);
  store.close();
});

test('cached rows from a prior approval revision stay quarantined after a same-account scope edit', async () => {
  const store = new LocalConnectorStore({
    dbPath: ':memory:', corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local',
  });
  const item = (): RawItem => ({
    identity: {
      family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: 'id:1',
      providerFileId: 'id:1', localItemId: 'personal:id:1', sourceVersion: 'rev-1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: 'quarterly plan' },
    metadata: Object.freeze({
      name: 'plan.txt', pathDisplay: '/work/plan.txt',
      identityAliases: [`scope-generation:${'b'.repeat(64)}`, 'drive-folder:forged'],
    }),
    fetchedAt: '2026-09-10T10:00:00.000Z',
  });
  const connector = (raw: RawItem): SourceConnector => ({
    id: 'dropbox-scope-test', family: 'file', async authenticate() {},
    async *listItems() { yield { items: [raw], done: true }; },
    async fetchItem() { return raw; },
    classify() { return { trustTier: 'S4', trustDomain: 'secure_local', cloudEmbeddingEligible: false, localOnly: true }; },
  });
  await store.syncFromConnector(connector(item()), {
    fetchContent: true,
    sourceScopeObservation: () => ({
      accountGeneration: 'b'.repeat(64),
      scopeRevision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }),
  });
  const approval = {
    sourceId: 'dropbox.files' as const,
    status: 'approved' as const,
    accountGeneration: 'b'.repeat(64),
    revision: '11111111-1111-4111-8111-111111111111',
    selections: [{ key: '/work', state: 'ingest' as const }],
    wholeAccount: false,
  };
  const scope = fileSourceScopeContentFilters(approval);
  expect(scope.allowed).toBe(true);
  const adapter = createConnectorStoreCorpusAdapter({
    store,
    accountScope: 'personal',
    ...(scope.allowed && scope.filters ? { filters: scope.filters } : {}),
  });
  const request = {
    query: 'quarterly', maxResults: 5,
    corpus: defineConnectorCorpus({
      corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain,
    }),
    context: { allowedTrustDomains: ['secure_local' as const], allowedCorpusIds: [store.corpusId] },
  };
  expect((await adapter(request)).hits).toEqual([]);
  const refreshed = await store.syncFromConnector(connector(item()), {
    fetchContent: true,
    sourceScopeObservation: () => ({
      accountGeneration: 'b'.repeat(64),
      scopeRevision: approval.revision,
    }),
  });
  expect(refreshed.itemsChanged).toBe(0);
  expect((await adapter(request)).hits).toHaveLength(1);
  store.close();
});

test('metadata-only scope excludes retained chunks from direct and hybrid vector retrieval', async () => {
  const generation = 'f'.repeat(64);
  const revision = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  const store = new LocalConnectorStore({
    dbPath: ':memory:', corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local',
  });
  const raw: RawItem = {
    identity: {
      family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: 'id:vector',
      providerFileId: 'id:vector', localItemId: 'personal:id:vector', sourceVersion: 'rev-1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: 'retained semantic body' },
    metadata: Object.freeze({ name: 'Visible title.txt', pathDisplay: '/metadata/visible.txt' }),
    fetchedAt: '2026-09-10T10:00:00.000Z',
  };
  const connector: SourceConnector = {
    id: 'metadata-vector-scope-test', family: 'file', async authenticate() {},
    async *listItems() { yield { items: [raw], done: true }; },
    async fetchItem() { return raw; },
    classify() { return { trustTier: 'S4', trustDomain: 'secure_local', cloudEmbeddingEligible: false, localOnly: true }; },
  };
  await store.syncFromConnector(connector, {
    fetchContent: true,
    sourceScopeObservation: () => ({ accountGeneration: generation, scopeRevision: revision }),
  });
  const provider: SourceEmbeddingProvider = {
    provider: 'scope-test-local', modelId: 'scope-test-v1', dimension: 2,
    configHash: 'scope-test-config', epochId: 'local:scope-test-v1', backend: 'local',
    async embed(inputs) { return inputs.map(() => [1, 0]); },
  };
  await store.embedChunks({ provider });
  const metadataScope = fileSourceScopeMetadataFilters({
    sourceId: 'dropbox.files', status: 'approved', accountGeneration: generation, revision,
    selections: [{ key: '/metadata', state: 'metadata_only' }], wholeAccount: false,
  });
  if (!metadataScope.allowed) throw new Error('metadata fixture scope must be approved');
  expect(await store.vectorSearchItems(
    'semantically identical', provider, 5, 'personal', metadataScope.filters,
  )).toEqual([]);
  const response = await createConnectorStoreCorpusAdapter({
    store, accountScope: 'personal', filters: metadataScope.filters,
    retrievalMode: 'hybrid', embeddingProvider: provider,
  })({
    query: 'semantically identical', maxResults: 5,
    corpus: defineConnectorCorpus({ corpusId: store.corpusId, family: 'file', trustDomain: 'secure_local' }),
    context: { allowedTrustDomains: ['secure_local'], allowedCorpusIds: [store.corpusId] },
  });
  expect(response.hits).toEqual([]);
  expect(response.laneAudits).toContainEqual(expect.objectContaining({ laneType: 'semantic', candidateCount: 0 }));
  store.close();
});

test('a forged Drive folder alias cannot satisfy the trusted folder scope', async () => {
  const store = new LocalConnectorStore({
    dbPath: ':memory:', corpusId: 'internal.drive.docs', family: 'file', trustDomain: 'internal',
  });
  const raw: RawItem = {
    identity: {
      family: 'file', provider: 'google_drive', accountScope: 'personal', providerItemId: 'file',
      providerFileId: 'id:1', localItemId: 'personal:id:1', sourceVersion: '1',
    },
    mimeType: 'text/plain', content: { kind: 'text', text: 'scope test' },
    metadata: Object.freeze({ name: 'drive-folder:selected', identityAliases: ['drive-folder:selected'] }),
    fetchedAt: '2026-09-10T10:00:00.000Z',
  };
  const connector: SourceConnector = {
    id: 'drive-scope-test', family: 'file', async authenticate() {},
    async *listItems() { yield { items: [raw], done: true }; },
    async fetchItem() { return raw; },
    classify() { return { trustTier: 'S3', trustDomain: 'internal', cloudEmbeddingEligible: true, localOnly: false }; },
  };
  await store.syncFromConnector(connector, {
    fetchContent: true,
    sourceScopeObservation: () => ({
      accountGeneration: 'd'.repeat(64),
      scopeRevision: '22222222-2222-4222-8222-222222222222',
      folderKeys: ['different'],
    }),
  });
  const scope = fileSourceScopeContentFilters({
    sourceId: 'google_drive.docs', status: 'approved', accountGeneration: 'd'.repeat(64),
    revision: '22222222-2222-4222-8222-222222222222',
    selections: [{ key: 'selected', state: 'ingest' }], wholeAccount: false,
  });
  const adapter = createConnectorStoreCorpusAdapter({
    store,
    ...(scope.allowed && scope.filters ? { filters: scope.filters } : {}),
  });
  const result = await adapter({
    query: 'scope', maxResults: 5,
    corpus: defineConnectorCorpus({ corpusId: store.corpusId, family: 'file', trustDomain: 'internal' }),
    context: { allowedTrustDomains: ['internal'], allowedCorpusIds: [store.corpusId] },
  });
  expect(result.hits).toEqual([]);
  store.close();
});

test('provider syncs stamp trusted generation and Drive ancestry observations', async () => {
  const generation = 'e'.repeat(64);
  const revision = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const dropboxStore = new LocalConnectorStore({
    dbPath: ':memory:', corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local',
  });
  const dropbox = createDropboxProviderStoreSyncHandler({
    store: dropboxStore,
    account: 'personal',
    broker: {
      async issueSession() { return { kind: 'bearer_token' as const, token: 'fixture-token' }; },
    } as never,
    metadataClient: {
      supportsNativeRecursive: true,
      async listFolder() {
        return { entries: [{ tag: 'file', id: 'id:1', name: 'One.txt', pathLower: '/work/one.txt' }] };
      },
      async listFolderContinue() { throw new Error('unexpected continuation'); },
    },
    scope: {
      generation, revision, assertCurrent() {}, allowsMetadata: () => true, allowsContent: () => true,
    },
  });
  await dropbox.pull({ approved_scope_key: 'dropbox.personal:/work' });
  expect(dropboxStore.itemMatchesSearchFilters('personal:id:1', 'personal', {
    sourceScopeGeneration: generation,
    sourceScopeRevision: revision,
  })).toBe(true);

  const internal = new LocalConnectorStore({
    dbPath: ':memory:', corpusId: 'internal.drive.docs', family: 'file', trustDomain: 'internal',
  });
  const secure = new LocalConnectorStore({
    dbPath: ':memory:', corpusId: 'secure_local.drive.docs', family: 'file', trustDomain: 'secure_local',
  });
  const drive = createGoogleDriveConnectorStoreSyncHandler({
    internalStore: internal,
    secureStore: secure,
    account: 'personal',
    maxFiles: 10,
    maxContentFiles: 10,
    apiClient: {
      async listFiles() {
        return { files: [{ id: 'file-1', name: 'One.txt', mimeType: 'text/plain', parents: ['folder-1'] }] };
      },
      async getFolder(id) {
        return id === 'folder-1' ? { id, parents: ['root'] } : { id, parents: [] };
      },
      async exportGoogleDocText() { throw new Error('content disabled'); },
      async downloadTextFile() { throw new Error('content disabled'); },
      async downloadFileBytes() { throw new Error('content disabled'); },
    },
    scope: {
      generation, revision, allowsMetadata: () => true, allowsContent: () => false,
    },
  });
  await drive.sync();
  expect(internal.itemMatchesSearchFilters('personal:file-1', 'personal', {
    sourceScopeGeneration: generation,
    sourceScopeRevision: revision,
    sourceScopeFolderAnyKeys: ['folder-1'],
  })).toBe(true);
  dropboxStore.close();
  internal.close();
  secure.close();
});

test('direct connector-store search fails closed while file scope is pending', async () => {
  const store = new LocalConnectorStore({
    dbPath: ':memory:', corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local',
  });
  const worker = createEmailSourceWorker({
    connectorStores: [store],
    connectorStoreReadScope: () => ({ allowed: false }),
  });
  const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ corpus_id: store.corpusId, query: 'anything' }),
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: 'source_index_policy_violation' } });
  worker.close();
  store.close();
});

for (const provider of [
  { sourceId: 'dropbox.files', corpusId: 'secure_local.dropbox.files', dashboardSource: 'dropbox' },
  { sourceId: 'google_drive.docs', corpusId: 'internal.drive.docs', dashboardSource: 'google-drive' },
] as const) {
test.each(['missing', 'pending', 'empty', 'approved'] as const)(`${provider.sourceId} manual sync routes enforce explicit file scope: %s`, async (scopeCase) => {
  let taskRuns = 0;
  const scheduler = new SourceScheduler({
    enabled: true,
    tickMs: 1_000,
    errorBackoffMs: 1_000,
    maxTransientRetries: 1,
    sources: [{
      sourceId: provider.sourceId,
      corpusId: provider.corpusId,
      cadence: 'manual',
      intervalMs: 60_000,
      freshnessThresholdHours: 1,
      tasks: [{
        id: 'unsafe-existing-task', kind: 'sync', writer: true,
        async run() { taskRuns += 1; return { status: 'progress' }; },
      }],
    }],
  });
  const worker = createEmailSourceWorker({
    sourceScheduler: scheduler,
    sourceDashboard: {
      sovereigntyEngine: {} as never,
      registryAdoptionIntervalMs: 0,
      ...(scopeCase !== 'missing' ? { fileSourceScopes: {
        summaries: () => [{
          source_id: provider.sourceId, disposition_source_id: 'dropbox', label: 'Dropbox',
          connected: true, status: scopeCase === 'pending' ? 'scope_pending' : 'approved', scope_revision: 'revision',
          selections: scopeCase === 'approved' ? [{ key: '/work', state: 'metadata_only' }] : [],
        }],
        async browse() { throw new Error('not used'); },
        async approveAndStart() { throw new Error('not used'); },
      } } : {}),
    },
  });
  for (const [path, body] of [
    ['/dashboard/sync-now', { source: provider.dashboardSource }],
    ['/v1/source/index/sync', { corpus_id: provider.corpusId }],
  ] as const) {
    const response = await worker.fetch(new Request(`http://worker.test${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(scopeCase === 'approved' ? 200 : 403);
  }
  expect(taskRuns).toBe(scopeCase === 'approved' ? 2 : 0);
  worker.close();
});
}

test('queued scheduler work is revision-bound and refuses an account switch before running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-scope-'));
  const statePath = join(dir, 'scope.json');
  let currentRegistry = registry();
  const authority = new FileSourceScopeAuthority({
    registryPath: join(dir, 'handles.json'), statePath, readRegistry: () => currentRegistry,
  });
  const pending = authority.snapshot('dropbox.files');
  const approved = authority.approve({
    sourceId: 'dropbox.files', accountGeneration: pending.accountGeneration!,
    expectedRevision: pending.revision, selections: [{ key: '/work', state: 'ingest' }],
    wholeAccount: false, explicitWholeAccountConfirmation: false,
  });
  const ref = authority.policyRef('dropbox.files')!;
  let runs = 0;
  const source = scopeBoundSchedulerSource({
    authority, ref,
    source: {
      sourceId: 'dropbox.files', corpusId: 'secure_local.dropbox.files', cadence: 'manual',
      intervalMs: 1_000, freshnessThresholdHours: 1,
      tasks: [{ id: 'pull', kind: 'sync', writer: true, async run() { runs += 1; return { status: 'idle' }; } }],
    },
  });
  expect(source.tasks[0]?.id).toContain(approved.revision.replaceAll('-', '').slice(0, 16));
  currentRegistry = registry('2026-09-10T11:00:00.000Z');
  await expect(source.tasks[0]!.run()).rejects.toThrow('scope approval is required');
  expect(runs).toBe(0);
});
