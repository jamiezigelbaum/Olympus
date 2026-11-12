import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { classifyContentTier } from '../src/workers/classification/tier-classifier.ts';
import { approveFileSourceScope, readFileSourceScopeApproval, connectedFileSourceAccountGeneration, fileSourceScopeAllowsMetadata, fileSourceScopeAllowsContent } from '../src/core/source-scope-approval.ts';
import { createFileExtractionRuntime, fileExtractionCorporaRoster } from '../src/workers/engine/runtime/file-extraction-runtime.ts';
import { waitFor } from './helpers/test-clock.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { requestOnDemandRead, type OnDemandReadRequest } from '../src/workers/file-extraction/on-demand-read.ts';
import { defaultDropboxIngestionPolicy, parseSourceIngestionPolicy, dropboxPolicyApprovedScopeKeys, dropboxPolicyFullExtractionScopeKeys, dropboxPolicyExcludedPathPrefixes } from '../src/core/source-ingestion-policy.ts';
import { createSourceExclusionMatcher, parseSourceIngestionExclusions } from '../src/core/source-ingestion-exclusions.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';
import { LocalConnectorStore, createConnectorStoreContentProvider } from '../src/workers/connector-store/index.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { Database } from 'bun:sqlite';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'on-demand-test-'));
  const path = join(dir, 'jobs.sqlite');
  let jobs = new LocalFileExtractionJobStore(path);
  cleanup.push(() => { jobs.close(); rmSync(dir, { recursive: true, force: true }); });
  let grants = 0;
  const context = {
    get jobs() { return jobs; },
    resolve: (request: OnDemandReadRequest) => ({
      readableOnRequest: request.itemRef.providerItemId !== 'plain',
      job: {
        refs: [{ ...request.itemRef, provider: 'fixture', accountScope: 'one', approvedScopeKey: 'scope', localItemId: request.itemRef.providerItemId, sizeBytes: 8 }],
        extractorKind: 'local_text', extractorVersion: 'v1',
      },
      grant: () => { grants++; },
    }),
    limits: { files: 3, bytes: 25 },
  };
  return { context, grants: () => grants, restart: () => { jobs.close(); jobs = new LocalFileExtractionJobStore(path); } };
}
const req = (id = 'item', requester: OnDemandReadRequest['requester'] = 'analyst', questionId = 'q1'): OnDemandReadRequest => ({ itemRef: { corpusId: 'internal.fixture.files', providerItemId: id }, requester, questionId });

describe('read on demand', () => {
  test('third mode parses, approves names, and does not approve bulk extraction', () => {
    const policy = parseSourceIngestionPolicy({ ...defaultDropboxIngestionPolicy({ stillImagesRead: false }),
      roots: [{ path: '/Selected', approved_scope_key: 'dropbox.personal:/Selected', default_action: 'on_demand' }],
      rules: [{ match: { path_prefixes: ['/Selected'] }, action: 'on_demand', reason: 'owner_choice' }],
    });
    expect(dropboxPolicyApprovedScopeKeys(policy)).toEqual(['dropbox.personal:/Selected']);
    expect(dropboxPolicyFullExtractionScopeKeys(policy)).toEqual([]);
    expect(dropboxPolicyExcludedPathPrefixes(policy)).toEqual([]);
    expect(defaultDropboxIngestionPolicy({ stillImagesRead: false }).rules.every(rule => rule.action === 'metadata_only')).toBe(true);
    const matcher = createSourceExclusionMatcher(parseSourceIngestionExclusions({ schemaVersion: 1,
      rules: [{ id: 'selected', mode: 'on_demand', sources: [], path_prefixes: ['/Selected'] }],
    }), 'fixture');
    expect(matcher.evaluatePath('/Selected/a.txt')).toMatchObject({ disposition: 'metadata_only', readOnDemand: true });
  });

  test('a saved on-demand folder approves names but keeps bulk content disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-demand-approval-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const registry = { version: 1 as const, handles: [{ handle: 'dropbox.personal', provider: 'dropbox' as const, allowedCapabilities: ['dropbox.files.sync'], scopes: [], connectedAt: '2026-11-12T00:00:00Z', accountRole: 'personal', providerAccountId: 'account-1' }] };
    const statePath = join(dir, 'scope.json');
    const previous = readFileSourceScopeApproval({ sourceId: 'dropbox.files', registry, statePath });
    approveFileSourceScope({ sourceId: 'dropbox.files', registry, statePath,
      accountGeneration: connectedFileSourceAccountGeneration('dropbox.files', registry)!.generation, expectedRevision: previous.revision,
      selections: [{ key: '/Selected', state: 'on_demand' }], wholeAccount: false, explicitWholeAccountConfirmation: false,
    });
    const saved = readFileSourceScopeApproval({ sourceId: 'dropbox.files', registry, statePath });
    expect(saved.selections).toEqual([{ key: '/Selected', state: 'on_demand' }]);
    expect(fileSourceScopeAllowsMetadata(saved, ['/Selected'])).toBe(true);
    expect(fileSourceScopeAllowsContent(saved, ['/Selected'])).toBe(false);
  });

  test.each(['remote_app', 'analyst'] as const)('%s cannot read a plain Names only file', async requester => {
    const f = fixture();
    expect(await requestOnDemandRead(req('plain', requester), f.context)).toEqual({ state: 'refused', reason: 'names_only' });
    expect(f.grants()).toBe(0);
  });

  test('owner may read plain Names only without question caps', async () => {
    const f = fixture();
    expect(await requestOnDemandRead({ itemRef: req('plain').itemRef, requester: 'owner' }, { ...f.context, limits: { files: 1, bytes: 1 } })).toMatchObject({ state: 'queued' });
    expect(f.grants()).toBe(1);
  });

  test('the owner can read a file a question allowance stopped', async () => {
    const f = fixture();
    expect(await requestOnDemandRead(req('item'), f.context)).toMatchObject({ state: 'queued' });
    const lane = { corpusId: 'internal.fixture.files', provider: 'fixture', accountScope: 'one', approvedScopeKey: 'scope' };
    const leased = f.context.jobs.lease({ ...lane, workerId: 'w' });
    expect(leased.leasedJobs).toHaveLength(1);
    f.context.jobs.record({ jobId: leased.leasedJobs[0]!.jobId, workerId: 'w', leaseToken: leased.leasedJobs[0]!.leaseToken, status: 'skipped_too_large' });
    expect(await requestOnDemandRead(req('item', 'remote_app', 'q2'), f.context)).toEqual({ state: 'refused', reason: 'read_failed' });
    expect(await requestOnDemandRead({ itemRef: req('item').itemRef, requester: 'owner' }, f.context)).toMatchObject({ state: 'queued' });
    expect(f.context.jobs.get(leased.leasedJobs[0]!.jobId)?.status).toBe('queued');
  });

  test('concurrent retries and a restart keep one forced job and its active lease', async () => {
    const f = fixture();
    expect((await Promise.all([requestOnDemandRead(req(), f.context), requestOnDemandRead(req(), f.context)])).map(r => r.state)).toEqual(['queued', 'queued']);
    expect(f.grants()).toBe(1);
    const lease = f.context.jobs.lease({ corpusId: req().itemRef.corpusId, provider: 'fixture', accountScope: 'one', approvedScopeKey: 'scope', workerId: 'worker' });
    expect(lease.leasedJobs).toHaveLength(1);
    f.restart();
    expect(await requestOnDemandRead(req(), f.context)).toMatchObject({ state: 'reading' });
    expect(f.context.jobs.get(lease.leasedJobs[0]!.jobId)).toMatchObject({ status: 'leased', reason: 'on_demand', requester: 'analyst', questionId: 'q1' });
    expect(f.grants()).toBe(1);
  });

  test('count and byte stops carry the lane 7 shape and never queue extra work', async () => {
    const f = fixture();
    for (const id of ['a', 'b', 'c']) expect((await requestOnDemandRead(req(id), f.context)).state).toBe('queued');
    expect(await requestOnDemandRead(req('d'), f.context)).toEqual({ state: 'capped', reason: {
      id: 'on_demand_reads_per_question', limit: { files: 3, bytes: 25 }, used: { files: 3, bytes: 24 }, waiting_names_count: 1, resumes: 'never',
    } });
    expect(f.grants()).toBe(3);
    expect((await requestOnDemandRead(req('e'), f.context)).reason).toMatchObject({ waiting_names_count: 2 });
    expect((await requestOnDemandRead(req('d'), f.context)).reason).toMatchObject({ waiting_names_count: 2 });
    expect((await requestOnDemandRead(req('large', 'analyst', 'q2'), { ...f.context, limits: { files: 3, bytes: 7 } })).state).toBe('capped');
  });

  test('the split forwarding route carries analyst and remote-app reads, and never grants owner authority', async () => {
    const calls: OnDemandReadRequest[] = [];
    const worker = createEmailSourceWorker({ requestOnDemandRead: async request => { calls.push(request); return { state: 'queued', etaSeconds: 60 }; } });
    cleanup.push(() => worker.close());
    for (const requester of ['analyst', 'remote_app', 'owner']) {
      const response = await worker.fetch(new Request('http://localhost/v1/source/index/files/read-on-demand', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemRef: req().itemRef, requester }),
      }));
      expect(response.status).toBe(requester === 'owner' ? 400 : 200);
    }
    expect(calls.map(call => call.requester)).toEqual(['analyst', 'remote_app']);
  });

  test('analyst uses only top-three names hits when it reports a gap, with a note and no evidence', async () => {
    const calls: OnDemandReadRequest[] = [];
    const corpusId = 'internal.fixture.files';
    const identity = (id: string) => ({ family: 'file' as const, provider: 'fixture', accountScope: 'one', providerItemId: id, localItemId: id });
    let gap = true;
    const handler = createAnalystSourceIndexAnswerHandler({
      requestOnDemandRead: async request => { calls.push(request); return { state: 'queued', etaSeconds: 60 }; },
      analyst: { async analyze(pack) {
        expect(pack.candidates.every(candidate => candidate.chunks.length === 0)).toBe(true);
        return { answer: 'There is not enough evidence.', citations: [], unanswered: gap ? ['The requested contents are unread.'] : [] };
      } },
      lanes: () => ({
        registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'internal' })]),
        adapters: { [corpusId]: () => ({ hits: ['a', 'b', 'c', 'd'].map(id => ({ sourceItem: identity(id), provenance: { sourceItem: identity(id), citation: { title: id } }, score: 1, rawExposed: false as const })), latencyMs: 0, rawExposed: false as const }) },
        contentProviders: { [corpusId]: { async fetchLocalContent() { return { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: [], namesOnly: true }; } } },
      }),
    });
    const answer = await handler.answer({ question: 'What is in these files?', include_internal: true, max_results: 10 });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(call => call.questionId)).size).toBe(1);
    expect(calls.every(call => call.requester === 'analyst')).toBe(true);
    expect(answer.answer).toContain('Reading 3 files for this question. Ask again in about a minute.');
    expect(answer.evidence).toEqual([]);
    gap = false; calls.length = 0;
    await handler.answer({ question: 'What is in these files?', include_internal: true });
    expect(calls).toEqual([]);
  });

  test('a names-only scope starts one real extraction immediately and uses its persisted size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-demand-runtime-'));
    const corpusId = 'internal.fixture.files';
    const exclusions = createSourceExclusionMatcher(parseSourceIngestionExclusions({ schemaVersion: 1,
      rules: [{ id: 'selected', mode: 'on_demand', sources: [], path_prefixes: ['/Selected'] }],
    }), 'fixture');
    const store = new LocalConnectorStore({ dbPath: join(dir, 'store.sqlite'), corpusId, family: 'file', trustDomain: 'internal', exclusions });
    let runtime: ReturnType<typeof createFileExtractionRuntime>;
    cleanup.push(() => { runtime?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
    const item: RawItem = { identity: { family: 'file', provider: 'fixture', accountScope: 'one', providerItemId: 'a', localItemId: 'a', sourceVersion: 'v1' }, mimeType: 'text/plain', content: { kind: 'metadata_only' }, metadata: { name: 'a.txt', pathDisplay: '/Selected/a.txt', sizeBytes: 12 }, fetchedAt: '2026-11-12T00:00:00Z' };
    await store.syncFromConnector({ id: 'fixture', family: 'file', async authenticate() {}, async *listItems() { yield { items: [item], done: true }; }, async fetchItem() { throw new Error('No fetch at listing'); }, classificationSignals() { return {}; } }, { fetchContent: false, placement: { trustTier: 'S2', trustDomain: 'internal' } });
    expect(store.activeLocalItemRow('a')).toBeDefined();
    expect(store.itemMetadataSnapshot(item.identity)).toMatchObject({ locatorUri: '/Selected/a.txt' });
    expect(exclusions.evaluatePath('/Selected/a.txt')).toMatchObject({ disposition: 'metadata_only', readOnDemand: true });
    expect(store.onDemandReadCandidate('a')).toMatchObject({ readableOnRequest: true });
    let fetched = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    runtime = createFileExtractionRuntime({ enabled: true, connectorStores: [store], jobsDbPath: join(dir, 'jobs.sqlite'), env: {},
      corpora: [{ corpusId, provider: 'fixture', scopes: ['scope'] }],
      sourceFactories: new Map([['fixture', () => ({ id: 'fixture', corpusId, provider: 'fixture', async listCandidates() { throw new Error('An individual read must not scan a folder'); }, async fetch(_ref, options) {
        fetched++; expect(options.maxBytes).toBe(12); await ready;
        return { bytes: new TextEncoder().encode('Read on ask.') };
      } })]]),
    });
    expect((await runtime!.requestOnDemandRead(req('a'))).state).toBe('queued');
    await waitFor(() => fetched === 1);
    expect((await runtime!.requestOnDemandRead(req('a'))).state).toBe('reading');
    release();
    await waitFor(() => runtime!.jobs.itemExtractionState(item.identity) === 'settled');
    expect(fetched).toBe(1);
    expect(store.localContent('a')?.chunks ?? []).toEqual([]);
    expect(store.itemMetadataSnapshot(item.identity)).toMatchObject({ read_on_demand: true, sizeBytes: 12 });
    expect(runtime!.jobs.pendingOnDemandReads()).toEqual([]);
  });

  test('promoted text is held out of evidence until content is judged; the grant is version-bound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-demand-hold-'));
    const store = new LocalConnectorStore({ dbPath: join(dir, 'store.sqlite'), corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const item: RawItem = { identity: { family: 'file', provider: 'fixture', accountScope: 'one', providerItemId: 'a', localItemId: 'a', sourceVersion: 'v1' }, mimeType: 'text/plain', content: { kind: 'metadata_only' }, metadata: { name: 'a.txt', locatorUri: '/Names/a.txt', scopeContentDenied: true }, fetchedAt: '2026-11-12T00:00:00Z' };
    const connector: SourceConnector = { id: 'fixture', family: 'file', async authenticate() {}, async *listItems() { yield { items: [item], done: true }; }, async fetchItem() { return item; }, classificationSignals() { return {}; } };
    await store.syncFromConnector(connector, { fetchContent: false, placement: { trustTier: 'S2', trustDomain: 'internal' }, tierClassification: { holdContentUntilJudged: true } });
    store.grantOnDemandRead('a', 'v1');
    const sink = createConnectorStoreExtractionSink({ store, syncConnectorId: 'extraction', ownerConnectorId: 'fixture', ownershipKind: 'observed', classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), tierClassification: { holdContentUntilJudged: true } });
    await sink.accept({ ref: { corpusId: store.corpusId, provider: 'fixture', accountScope: 'one', approvedScopeKey: 'scope', providerItemId: 'a', localItemId: 'a', sourceVersion: 'v1' }, text: 'Unjudged confidential contents', extractorKind: 'local_text', extractorVersion: 'v1', fetchedAt: '2026-11-12T00:01:00Z' });
    expect(store.tierLedger()!.getCurrent(item.identity)?.contentPending).toBe(true);
    expect(store.localContent('a')?.chunks ?? []).toEqual([]);
    expect(store.contentServedNow('a')).toBe(false);
    expect(store.itemMetadataSnapshot(item.identity)?.read_on_demand).toBe(true);
    const decision = classifyContentTier({ text: 'Unjudged confidential contents', metadataTier: 'private', metadataForced: false, metadataFlagged: false, holdUntilJudged: true }, {
      sniffer: { id: 'test-judge', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) },
    });
    store.tierLedger()!.recordContentDecision(item.identity, decision);
    expect(store.contentServedNow('a')).toBe(true);
    expect(store.localContent('a')?.chunks).toEqual(['Unjudged confidential contents']);
    const privateDecision = classifyContentTier({ text: 'Unjudged confidential contents', metadataTier: 'private', metadataForced: false, metadataFlagged: false, holdUntilJudged: true }, {
      sniffer: { id: 'test-judge', judge: () => ({ verdict: 'decided', tier: 'secure', code: 'sensitive:0.99' }) },
    });
    store.tierLedger()!.recordContentDecision(item.identity, privateDecision);
    expect(store.contentServedNow('a')).toBe(false);
    expect(store.localContent('a')?.chunks ?? []).toEqual([]);
    expect(store.readOnDemand('a', 'v2')).toBe(false);
  });

  test.each(['path', 'folder'] as const)('metadata-only %s scopes allow body search only with a current-version grant', async scope => {
    const dir = mkdtempSync(join(tmpdir(), 'on-demand-search-'));
    const dbPath = join(dir, 'store.sqlite');
    let store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    // Retained text/vectors must obey the current folder policy, even when
    // the store previously ingested the whole folder.
    const items: RawItem[] = ['current', 'unread', 'stale', 'excluded', 'unversioned', 'held'].map(id => ({
      identity: { family: 'file', provider: 'fixture', accountScope: 'one', providerItemId: id, localItemId: id,
        ...(id === 'unversioned' ? {} : { sourceVersion: 'v2' }) },
      mimeType: 'text/plain', content: { kind: 'text', text: 'quartzneedle body contents' },
      metadata: { name: `${id}.txt`, locatorUri: `/Names/${id === 'excluded' ? 'Excluded/' : ''}${id}.txt` },
      fetchedAt: '2026-11-12T00:00:00Z',
    }));
    const connector: SourceConnector = { id: 'fixture', family: 'file', async authenticate() {}, async *listItems() { yield { items, done: true }; }, async fetchItem(id) { return items.find(item => item.identity.localItemId === id)!; }, classificationSignals() { return {}; } };
    await store.syncFromConnector(connector, { fetchContent: true, tierClassification: { holdContentUntilJudged: true }, sourceScopeObservation: item => ({
      accountGeneration: 'a'.repeat(64), scopeRevision: '00000000-0000-4000-8000-000000000001',
      folderKeys: ['names', ...(item.identity.localItemId === 'excluded' ? ['excluded'] : [])],
    }) });
    const provider: SourceEmbeddingProvider = { provider: 'built-in', backend: 'local', modelId: 'on-demand-fixture', dimension: 2, configHash: '1', epochId: '1',
      async embed(inputs) { return inputs.map(() => [1, 0]); } };
    for (const item of items.filter(item => item.identity.localItemId !== 'held')) {
      store.tierLedger()!.recordContentDecision(item.identity, classifyContentTier({
        text: 'quartzneedle body contents', metadataTier: 'private', metadataForced: false, metadataFlagged: false, holdUntilJudged: true,
      }, { sniffer: { id: 'test-judge', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) } }));
    }
    await store.embedChunks({ provider });
    store.grantOnDemandRead('current', 'v2');
    store.grantOnDemandRead('stale', 'v1');
    store.grantOnDemandRead('excluded', 'v2');
    store.grantOnDemandRead('unversioned');
    store.grantOnDemandRead('held', 'v2');
    expect(store.contentServedNow('current')).toBe(true);
    expect(store.contentServedNow('held')).toBe(false);
    const filters = scope === 'path'
      ? { metadataOnlyLocatorPathScopes: ['/Names'], locatorPathExcludedScopes: ['/Names/Excluded'] }
      : { metadataOnlySourceScopeFolderKeys: ['names'], sourceScopeFolderNoneKeys: ['excluded'] };
    const assertSearch = async (expected: string[]) => {
      expect(store.searchItems('quartzneedle', 10, 'one', filters).map(row => row.sourceItem.localItemId).sort()).toEqual(expected);
      expect((await store.searchItemsDetailedOffThread('quartzneedle', 10, 'one', filters)).rows.map(row => row.sourceItem.localItemId).sort()).toEqual(expected);
      expect((await store.vectorSearchItems('quartzneedle', provider, 10, 'one', filters)).map(row => row.sourceItem.localItemId).sort()).toEqual(expected);
    };
    await assertSearch(['current', 'unversioned']);
    // Also exercise the exact scan used when the digest is unavailable.
    const db = new Database(dbPath);
    db.exec('UPDATE chunk_vector_digest_meta SET completed = 0');
    await assertSearch(['current', 'unversioned']);
    // Older read-only stores have no grant table: both lanes fail closed
    // for body matches while names remain searchable.
    store.close();
    db.exec('DROP TABLE on_demand_item_reads');
    db.close();
    store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal', readOnly: true });
    await assertSearch([]);
    expect(store.searchItems('unread', 10, 'one', filters).map(row => row.sourceItem.localItemId)).toEqual(['unread']);
  });
});

describe('on-demand read scopes reach the Dropbox extraction lane', () => {
  test('a Dropbox roster with only names-only folders keeps its read scopes', () => {
    const roster = fileExtractionCorporaRoster({
      configured: [],
      dropbox: {
        extractionScopes: [],
        resolveExtractionScopes: () => [],
        resolveReadScopes: () => ['/archive'],
        resolveCredentialHandle: () => 'dropbox.personal',
      },
    });
    expect(roster).toHaveLength(1);
    expect(roster[0]!.resolveReadScopes?.()).toEqual(['/archive']);
  });
});
