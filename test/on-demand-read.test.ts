import { registeredLimits } from '../src/core/limit-stops.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { classifyContentTier } from '../src/workers/classification/tier-classifier.ts';
import { approveFileSourceScope, readFileSourceScopeApproval, connectedFileSourceAccountGeneration, fileSourceScopeAllowsMetadata, fileSourceScopeAllowsContent } from '../src/core/source-scope-approval.ts';
import { createFileExtractionRuntime, fileExtractionCorporaRoster } from '../src/workers/engine/runtime/file-extraction-runtime.ts';
import { createTestClock, waitFor } from './helpers/test-clock.ts';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { createFileExtractionRunner } from '../src/workers/file-extraction/runner.ts';
import { buildExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import type { Extractor } from '../src/workers/file-extraction/types.ts';
import { requestOnDemandRead, type OnDemandReadRequest } from '../src/workers/file-extraction/on-demand-read.ts';
import { defaultDropboxIngestionPolicy, parseSourceIngestionPolicy, dropboxPolicyApprovedScopeKeys, dropboxPolicyFullExtractionScopeKeys, dropboxPolicyExcludedPathPrefixes } from '../src/core/source-ingestion-policy.ts';
import { createSourceExclusionMatcher, parseSourceIngestionExclusions } from '../src/core/source-ingestion-exclusions.ts';
import { routeSourceIndexSearch } from '../src/core/source-index/router.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { assertSqliteSchemaCanOpen } from '../src/core/sqlite-migrations.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { LocalConnectorStore, createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { fixtureConnector, JUDGED_PERSONAL_SNIFFER } from './helpers/tier-fixtures.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createLaneTieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { Database } from 'bun:sqlite';
import { GoogleDriveExtractionSource, GOOGLE_DRIVE_EXTRACTION_SCOPE_KEY } from '../src/workers/google-connectors/drive-extraction-source.ts';
import { createRestGoogleDriveApiClient, GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID, GOOGLE_DRIVE_PROVIDER } from '../src/workers/google-connectors/drive.ts';

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

const ON_DEMAND_JUDGE: SnifferLane = {
  kind: 'local', modelId: 'on-demand-judge', profileId: 'test-local-judge',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'on-demand-judge' },
};

function onDemandTierSet(dir: string, store: LocalConnectorStore, exclusions?: ReturnType<typeof createSourceExclusionMatcher>) {
  const privateStore = new LocalConnectorStore({
    dbPath: join(dir, 'private.sqlite'),
    corpusId: store.corpusId.replace(/^internal\./, 'secure_local.'),
    family: store.family,
    trustDomain: 'secure_local',
    ...(exclusions ? { exclusions } : {}),
  });
  const sniffer = new TierSnifferStore({ dbPath: join(dir, 'sniffer.sqlite') });
  const set = createLaneTieredStoreSet({
    setId: store.corpusId, internalStore: store, secureStore: privateStore,
    tierClassification: { sniffer: new CachedTierSniffer(sniffer, ON_DEMAND_JUDGE) },
  });
  cleanup.push(() => { sniffer.close(); privateStore.close(); });

  async function settlePersonal(item: RawItem) {
    const report = await runSnifferPass({
      targets: [{ ledger: set.ledger, sniffer,
        placementFor: (decision) => set.placementFor(decision),
        onDemandRead: () => store.readOnDemand(item.identity.localItemId, item.identity.sourceVersion),
      }],
      lane: ON_DEMAND_JUDGE,
      model: { async complete() {
        return { modelId: ON_DEMAND_JUDGE.modelId, text: JSON.stringify({
          verdicts: [{ i: 1, tier: 'personal', category: 'ordinary', confidence: 0.99, ownRecord: false, privateKind: 'none' }],
        }) };
      } },
    });
    expect(report.resolvedPersonal).toBe(1);
    expect(set.ledger.getCurrent(item.identity)).toMatchObject({ state: 'moving', targetContentTier: 'private' });
    await moveTieredItem({ set, identity: item.identity, target: { metadataTier: 'private', contentTier: 'private' } });
  }

  return { set, privateStore, settlePersonal };
}

async function driveFixture(limits: { files: number; bytes: number }, ids = ['a'], download?: (signal: AbortSignal | null | undefined) => Promise<Response>) {
  const dir = mkdtempSync(join(tmpdir(), 'on-demand-drive-'));
  const corpusId = GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID;
  const text = 'Café 😀 private notes';
  const size = new TextEncoder().encode(text).byteLength;
  const exclusions = createSourceExclusionMatcher(parseSourceIngestionExclusions({ schemaVersion: 1,
    rules: [{ id: 'selected', mode: 'on_demand', sources: [], path_prefixes: ['/Selected'] }],
  }), 'fixture');
  const store = new LocalConnectorStore({ dbPath: join(dir, 'store.sqlite'), corpusId, family: 'file', trustDomain: 'internal', exclusions });
  let runtime: ReturnType<typeof createFileExtractionRuntime>;
  let db: Database | undefined;
  cleanup.push(() => { runtime?.close(); db?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const tiered = onDemandTierSet(dir, store, exclusions);
  const items: RawItem[] = ids.map(id => ({
    identity: { family: 'file', provider: GOOGLE_DRIVE_PROVIDER, accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}`, sourceVersion: 'v1' },
    mimeType: `application/vnd.google-apps.${id === 'sheet' ? 'spreadsheet' : id === 'slides' ? 'presentation' : 'document'}`,
    content: { kind: 'metadata_only' },
    // The provider's native-file size says nothing about its exported text.
    metadata: { name: id, pathDisplay: `/Selected/${id}`, sizeBytes: 1_000_000, scopeContentDenied: true },
    fetchedAt: '2026-11-12T00:00:00Z',
  }));
  await store.syncFromConnector({ id: 'drive-fixture', family: 'file', async authenticate() {}, async *listItems() { yield { items, done: true }; }, async fetchItem() { throw new Error('No inline read'); }, classificationSignals() { return {}; } },
    { fetchContent: false, placement: { trustTier: 'S2', trustDomain: 'internal' }, tierClassification: { holdContentUntilJudged: true } });
  expect(store.activeLocalItemRow(items[0]!.identity.localItemId)).toBeDefined();
  const urls: string[] = [];
  const client = createRestGoogleDriveApiClient({ token: 'test-token', baseUrl: 'https://drive.test/drive/v3', maxRetries: 0,
    fetch: async (input, init) => {
      urls.push(String(input));
      return download ? download(init?.signal) : new Response(text);
    },
  });
  runtime = createFileExtractionRuntime({ enabled: true, connectorStores: [store], jobsDbPath: join(dir, 'jobs.sqlite'),
    env: { OLYMPUS_DATA_DIR: dir, OLYMPUS_ON_DEMAND_FILES_PER_QUESTION: String(limits.files), OLYMPUS_ON_DEMAND_BYTES_PER_QUESTION: String(limits.bytes) },
    corpora: [{ corpusId, provider: GOOGLE_DRIVE_PROVIDER, scopes: [GOOGLE_DRIVE_EXTRACTION_SCOPE_KEY] }],
    // Exercise the guarded source wrapper as well as the source itself.
    scopeGuard: { assertAuthorized() {}, allowsRef: ({ ref }) => store.readOnDemand(ref.localItemId, ref.sourceVersion) },
    sourceFactories: new Map([[GOOGLE_DRIVE_PROVIDER, () => new GoogleDriveExtractionSource({
      id: 'drive-fixture', corpusId, provider: GOOGLE_DRIVE_PROVIDER, approvedScopeKey: GOOGLE_DRIVE_EXTRACTION_SCOPE_KEY,
      candidates: { extractionCandidates() { throw new Error('An individual read must not scan a folder'); } }, client,
    })]]),
  });
  db = new Database(join(dir, 'jobs.sqlite'), { readonly: true });
  const read = (id: string, requester: OnDemandReadRequest['requester'] = 'analyst') => runtime!.requestOnDemandRead({
    itemRef: { corpusId, providerItemId: id }, requester, questionId: 'drive-question',
  });
  const job = (id: string) => db!.query('SELECT status, mime_type FROM extraction_jobs WHERE provider_item_id = ?').get(id) as { status: string; mime_type: string } | null;
  const used = () => db!.query("SELECT COUNT(*) AS files, SUM(reserved_bytes) AS bytes FROM on_demand_reads WHERE requester != 'owner'").get() as { files: number; bytes: number };
  return { store, runtime: runtime!, items, text, size, urls, read, job, used, ...tiered };
}

describe('read on demand', () => {
  test('committed revocation publishes the store grant epoch to an already open reader', async () => {
    const f = await driveFixture({ files: 3, bytes: 256 });
    using db = new Database(f.store.dbPath, { readonly: true });
    expect(() => assertSqliteSchemaCanOpen(db, 'connector-store', 16)).not.toThrow();
    const reader = new LocalConnectorStore({ dbPath: f.store.dbPath, corpusId: f.store.corpusId, family: 'file',
      trustDomain: 'internal', readOnly: true });
    cleanup.push(() => reader.close());
    f.store.grantOnDemandRead('personal:a', 'v1');
    const epoch = reader.onDemandGrantEpoch();
    expect(epoch).toBe(f.store.onDemandGrantEpoch());
    expect(reader.readOnDemand('personal:a', 'v1')).toBe(true);
    f.store.revokeOnDemandRead('personal:a');
    expect(reader.onDemandGrantEpoch()).toBeGreaterThan(epoch!);
    expect(reader.readOnDemand('personal:a', 'v1')).toBe(false);
  });

  test('changing a granted item version invalidates the store epoch without changing the grant row', async () => {
    const { store } = await driveFixture({ files: 3, bytes: 256 });
    store.grantOnDemandRead('personal:a', 'v1');
    const epoch = store.onDemandGrantEpoch();
    using db = new Database(store.dbPath);
    db.query('UPDATE items SET source_version = ? WHERE local_item_id = ?').run('v2', 'personal:a');
    expect(store.onDemandGrantEpoch()).toBeGreaterThan(epoch!);
    expect(store.currentOnDemandRead('personal:a', 'v1')).toBe(false);
  });

  test('revoking an on-demand grant aborts the active provider download', async () => {
    const running = Promise.withResolvers<AbortSignal | null | undefined>();
    const release = Promise.withResolvers<Response>();
    const f = await driveFixture({ files: 3, bytes: 256 }, ['a'], signal => {
      running.resolve(signal);
      signal?.addEventListener('abort', () => release.reject(signal.reason), { once: true });
      return release.promise;
    });
    expect(await f.read('a')).toMatchObject({ state: 'queued' });
    const signal = await running.promise;
    f.store.revokeOnDemandRead('personal:a');
    release.resolve(new Response(f.text));
    expect(signal?.aborted).toBe(true);
    await waitFor(() => f.job('a')?.status === 'blocked_policy', { description: 'revoked read settles' });
    expect(f.store.localContent('personal:a')?.chunks).toEqual([]);
  });

  test('a grant deleted by a separate connection cancels active work', async () => {
    const { store } = await driveFixture({ files: 3, bytes: 256 });
    store.grantOnDemandRead('personal:a', 'v1');
    const controller = new AbortController();
    const grant = store.observeOnDemandRead('personal:a', 'v1', controller)!;
    try {
      expect(controller.signal.aborted).toBe(false);
      using writer = new Database(store.dbPath);
      writer.query('DELETE FROM on_demand_item_reads WHERE local_item_id = ?').run('personal:a');
      await waitFor(() => controller.signal.aborted, { description: 'revocation notification' });
    } finally {
      grant.release();
    }
  });

  test('closing a store aborts its grant-dependent work', async () => {
    const { store } = await driveFixture({ files: 3, bytes: 256 });
    store.grantOnDemandRead('personal:a', 'v1');
    const controller = new AbortController();
    const grant = store.observeOnDemandRead('personal:a', 'v1', controller)!;
    try {
      expect(grant.check()).toBe(true);
      store.close();
      expect(controller.signal.aborted).toBe(true);
      expect(grant.check()).toBe(false);
    } finally {
      grant.release();
    }
  });

  test('a same-version regrant does not preserve active work across revocation', async () => {
    const { store } = await driveFixture({ files: 3, bytes: 256 });
    store.grantOnDemandRead('personal:a', 'v1');
    const controller = new AbortController();
    const grant = store.observeOnDemandRead('personal:a', 'v1', controller)!;
    try {
      using writer = new Database(store.dbPath);
      writer.transaction(() => {
        writer.query('DELETE FROM on_demand_item_reads WHERE local_item_id = ?').run('personal:a');
        writer.query('INSERT INTO on_demand_item_reads(local_item_id, source_version) VALUES (?, ?)').run('personal:a', 'v1');
      })();
      expect(store.currentOnDemandRead('personal:a', 'v1')).toBe(true);
      expect(grant.check()).toBe(false);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      grant.release();
    }
  });

  test('a reader opened before the epoch migration withdraws work across a same-version regrant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-demand-legacy-reader-'));
    const options = { dbPath: join(dir, 'store.sqlite'), corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' } as const;
    const old = new LocalConnectorStore({ ...options, restoreSchemaVersion: 16 });
    try {
      await old.syncFromConnector(fixtureConnector(() => [{ id: 'report', name: 'orchard.txt', text: 'quartzneedle' }]),
        { fetchContent: true, tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER } });
      old.grantOnDemandRead('personal:report', 'v1');
    } finally { old.close(); }
    const reader = new LocalConnectorStore({ ...options, readOnly: true });
    const controller = new AbortController();
    const hold = reader.observeOnDemandRead('personal:report', 'v1', controller)!;
    try {
      expect(hold.check()).toBe(true);
      const writer = new LocalConnectorStore(options);
      try {
        using other = new Database(options.dbPath);
        other.run("DELETE FROM on_demand_item_reads WHERE local_item_id = 'personal:report'");
        other.run("INSERT INTO on_demand_item_reads(local_item_id, source_version) VALUES ('personal:report', 'v1')");
      } finally { writer.close(); }
      expect(hold.check()).toBe(false);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      hold.release();
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('revoking an item grant aborts in-flight extraction before it can write', async () => {
    const f = fixture();
    const { store } = await driveFixture({ files: 3, bytes: 256 });
    store.grantOnDemandRead('personal:a', 'v1');
    const lane = { corpusId: 'internal.fixture.files', provider: 'fixture', accountScope: 'one', approvedScopeKey: 'scope' };
    const running = Promise.withResolvers<AbortSignal | undefined>();
    const release = Promise.withResolvers<void>();
    let writes = 0;
    const extractor: Extractor = {
      kind: 'local_text', version: 'v1', input: { kind: 'none' }, egress: 'local', accepts: () => true,
      async extract(input) {
        running.resolve(input.signal);
        await release.promise;
        return { status: 'indexed', text: 'body text' };
      },
    };
    const runner = createFileExtractionRunner({ jobs: f.context.jobs, registry: buildExtractorRegistry([extractor]), corpora: [{
      corpusId: lane.corpusId, trustDomain: 'internal',
      source: { id: 'fixture', corpusId: lane.corpusId, provider: lane.provider,
        async listCandidates() { return { candidates: [], done: true }; },
        async fetch() { return { bytes: new Uint8Array([1]) }; } },
      sink: { async accept() { writes++; return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 0 }; } },
      holdOnDemandRead: (_ref, controller) => store.observeOnDemandRead('personal:a', 'v1', controller),
    }] });
    expect(await requestOnDemandRead(req(), f.context)).toMatchObject({ state: 'queued' });
    const run = runner.run({ ...lane, providerItemIds: ['item'], limit: 1, reclassify: false });
    const signal = await running.promise;
    store.revokeOnDemandRead('personal:a');
    release.resolve();
    const result = await run;
    expect(signal?.aborted).toBe(true);
    expect(result.counts.blocked_policy).toBe(1);
    expect(writes).toBe(0);
  });

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

  test('a newer version of a file still being read gets its own read', async () => {
    const f = fixture();
    let version = 'v1';
    const context = { ...f.context, resolve: (request: OnDemandReadRequest) => {
      const base = f.context.resolve(request);
      return { ...base, job: { ...base.job, refs: [{ ...base.job.refs[0]!, sourceVersion: version }] } };
    } };
    expect(await requestOnDemandRead(req(), context)).toMatchObject({ state: 'queued' });
    expect(await requestOnDemandRead(req(), context)).toMatchObject({ state: 'queued' });
    expect(f.grants()).toBe(1);
    version = 'v2';
    expect(await requestOnDemandRead(req(), context)).toMatchObject({ state: 'queued' });
    expect(f.grants()).toBe(2);
    expect(f.context.jobs.pendingOnDemandReads().map(ref => ref.sourceVersion)).toContain('v2');
    expect(await requestOnDemandRead(req(), context)).toMatchObject({ state: 'queued' });
    expect(f.grants()).toBe(2);
  });

  test('an on-demand read left unread for want of a reader is read again once the reader is ready', async () => {
    const lane = { corpusId: 'internal.fixture.files', provider: 'fixture', accountScope: 'one', approvedScopeKey: 'scope' };
    const jobs = new LocalFileExtractionJobStore(':memory:');
    cleanup.push(() => jobs.close());
    let ready: 'ready' | 'pending' = 'pending';
    let reads = 0;
    const extractor: Extractor = {
      kind: 'local_text', version: 'v1', input: { kind: 'none' }, egress: 'local', accepts: () => true,
      reread: { unreadWarnings: ['ocr_unavailable_pdf'], unreadTerminalErrorKinds: [], prepare: () => ready },
      async extract() {
        reads += 1;
        return reads === 1
          ? { status: 'metadata_only', warnings: ['ocr_unavailable_pdf'], derivations: [{ artifactKind: 'document', chars: 0, warnings: ['ocr_unavailable_pdf'] }] }
          : { status: 'indexed', text: 'scanned text' };
      },
    };
    const runner = createFileExtractionRunner({ jobs, registry: buildExtractorRegistry([extractor]), corpora: [{
      corpusId: lane.corpusId, trustDomain: 'internal',
      source: { id: 'fixture', corpusId: lane.corpusId, provider: lane.provider,
        async listCandidates() { return { candidates: [], done: true }; },
        async fetch() { return { bytes: new Uint8Array([1]) }; } },
      sink: { async accept() { return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 0 }; } },
    }] });
    const context = { jobs, limits: { files: 3, bytes: 25 }, resolve: (request: OnDemandReadRequest) => ({
      readableOnRequest: true,
      job: { refs: [{ ...request.itemRef, ...lane, localItemId: 'scan', sizeBytes: 8 }], extractorKind: 'local_text', extractorVersion: 'v1' },
      grant: () => {},
    }) };
    expect(await requestOnDemandRead(req('scan'), context)).toMatchObject({ state: 'queued' });
    expect((await runner.run({ ...lane, providerItemIds: ['scan'], limit: 1, reclassify: false })).counts.metadata_only).toBe(1);
    expect(jobs.pendingOnDemandReads()).toEqual([]);
    expect(jobs.onDemandSettledLanes()).toEqual([lane]);
    expect(runner.rereadUnread?.(lane)).toBe(0);
    ready = 'ready';
    expect(runner.rereadUnread?.(lane)).toBe(1);
    expect(jobs.pendingOnDemandReads().map(ref => ref.providerItemId)).toEqual(['scan']);
    expect((await runner.run({ ...lane, providerItemIds: ['scan'], limit: 1, reclassify: false })).counts.indexed).toBe(1);
    expect(jobs.onDemandSettledLanes()).toEqual([]);
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

  test('analyst reads only the top-three names hits and leads with a note and no evidence while they run', async () => {
    const calls: OnDemandReadRequest[] = [];
    const corpusId = 'internal.fixture.files';
    const identity = (id: string) => ({ family: 'file' as const, provider: 'fixture', accountScope: 'one', providerItemId: id, localItemId: id });
    const handler = createAnalystSourceIndexAnswerHandler({
      requestOnDemandRead: async request => { calls.push(request); return { state: 'queued', etaSeconds: 60 }; },
      onDemandReadWaitMs: 0,
      analyst: { async analyze(pack) {
        expect(pack.candidates.every(candidate => candidate.chunks.length === 0)).toBe(true);
        // Citing a file by name alone is still no answer while it is read.
        return { answer: 'The sources do not contain the contents.', citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'a is listed' }], unanswered: ['The requested contents are unread.'] };
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
    expect(answer.answer.startsWith('Reading 3 files for this question. Ask again in about a minute.')).toBe(true);
    expect(answer.answer).not.toContain('do not contain');
    expect(answer.answer).toContain(`Still reading evidence from ${corpusId}`);
    expect(answer.evidence).toEqual([]);
  });

  test('a question that starts a read waits for it and answers once from the content', async () => {
    const corpusId = 'internal.fixture.files';
    const identity = (id: string) => ({ family: 'file' as const, provider: 'fixture', accountScope: 'one', providerItemId: id, localItemId: id });
    let asks = 0;
    const packs: string[][] = [];
    const handler = createAnalystSourceIndexAnswerHandler({
      // The store reports a finished read as settled; until then it is queued.
      requestOnDemandRead: async () => (++asks >= 3 ? { state: 'reading', etaSeconds: 60, settled: true } : { state: 'queued', etaSeconds: 60 }),
      onDemandReadWaitMs: 10_000,
      analyst: { async analyze(pack) {
        packs.push(pack.candidates.flatMap(candidate => candidate.chunks));
        return { answer: 'The code is 4417.', citations: [], unanswered: [] };
      } },
      lanes: () => ({
        registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'internal' })]),
        adapters: { [corpusId]: () => ({ hits: [{ sourceItem: identity('a'), provenance: { sourceItem: identity('a'), citation: { title: 'a' } }, score: 1, rawExposed: false as const }], latencyMs: 0, rawExposed: false as const }) },
        contentProviders: { [corpusId]: { async fetchLocalContent() {
          const sensitivity = buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' });
          return asks >= 3 ? { sensitivity, chunks: ['The code is 4417.'] } : { sensitivity, chunks: [], namesOnly: true };
        } } },
      }),
    });
    const answer = await handler.answer({ question: 'What is the code?', include_internal: true });
    expect(packs).toEqual([['The code is 4417.']]);
    expect(answer.answer).not.toContain('Reading 1 file');
    expect(asks).toBe(3);
  });

  test('a file the owner just read, still held for its judge, is waited for the same way', async () => {
    const corpusId = 'internal.fixture.files';
    const identity = (id: string) => ({ family: 'file' as const, provider: 'fixture', accountScope: 'one', providerItemId: id, localItemId: id });
    let asks = 0;
    const packs: string[][] = [];
    const handler = createAnalystSourceIndexAnswerHandler({
      // The store reports a finished read as settled; until then it is queued.
      requestOnDemandRead: async () => (++asks >= 3 ? { state: 'reading', etaSeconds: 60, settled: true } : { state: 'queued', etaSeconds: 60 }),
      onDemandReadWaitMs: 10_000,
      analyst: { async analyze(pack) {
        packs.push(pack.candidates.flatMap(candidate => candidate.chunks));
        return { answer: 'The code is 4417.', citations: [], unanswered: [] };
      } },
      lanes: () => ({
        registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'internal' })]),
        adapters: { [corpusId]: () => ({ hits: [{ sourceItem: identity('a'), provenance: { sourceItem: identity('a'), citation: { title: 'a' } }, score: 1, rawExposed: false as const }], latencyMs: 0, rawExposed: false as const }) },
        contentProviders: { [corpusId]: { async fetchLocalContent() {
          const sensitivity = buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' });
          return asks >= 3 ? { sensitivity, chunks: ['The code is 4417.'] } : { sensitivity, chunks: [], contentPrivate: true };
        } } },
      }),
    });
    const answer = await handler.answer({ question: 'What is the code?', include_internal: true });
    expect(packs).toEqual([['The code is 4417.']]);
    expect(answer.answer).not.toContain('Reading 1 file');
    expect(asks).toBe(3);
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
    onDemandTierSet(dir, store, exclusions);
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

  test.each(['owner', 'analyst'] as const)('a native Drive Doc is exported for %s and held until judged under a version-bound grant', async requester => {
    const timing = spyOn(console, 'info').mockImplementation(() => {});
    cleanup.push(() => timing.mockRestore());
    const f = await driveFixture({ files: 3, bytes: requester === 'owner' ? 1 : 100 });
    expect(f.store.onDemandReadCandidate('a')).toMatchObject({ readableOnRequest: true });
    expect(await f.read('a', requester)).toMatchObject({ state: 'queued' });
    await waitFor(() => f.job('a')?.status === 'indexed');
    expect(f.urls).toEqual(['https://drive.test/drive/v3/files/a/export?mimeType=text%2Fplain']);
    expect(f.job('a')?.mime_type).toBe('application/vnd.google-apps.document');
    const item = f.items[0]!;
    expect(f.store.readOnDemand(item.identity.localItemId, 'v1')).toBe(true);
    expect(f.store.readOnDemand(item.identity.localItemId, 'v2')).toBe(false);
    expect(f.store.tierLedger()!.getCurrent(item.identity)?.contentPending).toBe(true);
    expect(f.store.contentServedNow(item.identity.localItemId)).toBe(false);
    expect(f.store.localContent(item.identity.localItemId)?.chunks ?? []).toEqual([]);
    expect(f.store.itemMetadataSnapshot(item.identity)?.read_on_demand).toBe(true);
    // Read but not judged: a question still waits for it.
    expect(await f.read('a', requester)).toEqual({ state: 'reading', etaSeconds: 60 });
    for (const step of ['fetch', 'extract']) {
      expect(timing.mock.calls.some(([line]) => String(line).includes(`[olympus:on-demand] step=${step} count=1 ms=`))).toBe(true);
    }
    expect(timing.mock.calls.some(([line]) => String(line).includes('step=judge'))).toBe(false);
    expect(f.privateStore.exportItemCopy(item.identity)?.chunks[0]?.boundedText).toBe(f.text);
    await f.settlePersonal(item);
    expect(timing.mock.calls.some(([line]) => String(line).includes('[olympus:on-demand] step=judge count=1 ms='))).toBe(true);
    expect(f.store.contentServedNow(item.identity.localItemId)).toBe(true);
    expect(f.store.localContent(item.identity.localItemId)?.chunks).toEqual([f.text]);
    expect(await f.read('a', requester)).toMatchObject({ state: 'reading', settled: true });
    if (requester === 'analyst') expect(f.used()).toEqual({ files: 1, bytes: f.size });
  });

  test('native Doc question caps use exported UTF-8 bytes and retain the file count limit', async () => {
    const f = await driveFixture({ files: 3, bytes: 48 }, ['a', 'b', 'c']);
    expect(f.size).toBe(24);
    for (const id of ['a', 'b']) {
      expect(await f.read(id)).toMatchObject({ state: 'queued' });
      await waitFor(() => f.job(id)?.status === 'indexed');
    }
    expect(f.used()).toEqual({ files: 2, bytes: 48 });
    expect(await f.read('c')).toMatchObject({ state: 'capped', reason: { used: { files: 2, bytes: 48 } } });
    expect(f.store.readOnDemand('personal:c')).toBe(false);
    expect(f.urls).toHaveLength(2);
  });

  test('native Doc reads retain the per-question file count limit', async () => {
    const count = await driveFixture({ files: 1, bytes: 100 }, ['a', 'b']);
    expect(await count.read('a')).toMatchObject({ state: 'queued' });
    await waitFor(() => count.job('a')?.status === 'indexed');
    expect(await count.read('b')).toMatchObject({ state: 'capped', reason: { used: { files: 1, bytes: count.size } } });
    expect(count.urls).toHaveLength(1);
  });

  test('an export larger than the question allowance is refused without storing partial text', async () => {
    const f = await driveFixture({ files: 3, bytes: 20 });
    expect(await f.read('a')).toMatchObject({ state: 'queued' });
    await waitFor(() => f.job('a')?.status === 'skipped_too_large');
    expect(f.store.copyContentState(f.items[0]!.identity)?.chunks).toBe(0);
    expect(f.store.localContent('personal:a')?.chunks ?? []).toEqual([]);
  });

  test.each(['owner', 'analyst'] as const)('native Sheets and Slides stay refused for %s with the existing reason', async requester => {
    const f = await driveFixture({ files: 3, bytes: 100 }, ['sheet', 'slides']);
    for (const id of ['sheet', 'slides']) {
      expect(await f.read(id, requester)).toEqual({ state: 'refused', reason: 'names_only' });
      expect(f.store.readOnDemand(`personal:${id}`)).toBe(false);
      expect(f.job(id)).toBeNull();
    }
    expect(f.urls).toEqual([]);
  });

  test('promoted text is held out of evidence until content is judged; the grant is version-bound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-demand-hold-'));
    const store = new LocalConnectorStore({ dbPath: join(dir, 'store.sqlite'), corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const { set, settlePersonal } = onDemandTierSet(dir, store);
    const item: RawItem = { identity: { family: 'file', provider: 'fixture', accountScope: 'one', providerItemId: 'a', localItemId: 'a', sourceVersion: 'v1' }, mimeType: 'text/plain', content: { kind: 'metadata_only' }, metadata: { name: 'a.txt', locatorUri: '/Names/a.txt', scopeContentDenied: true }, fetchedAt: '2026-11-12T00:00:00Z' };
    const connector: SourceConnector = { id: 'fixture', family: 'file', async authenticate() {}, async *listItems() { yield { items: [item], done: true }; }, async fetchItem() { return item; }, classificationSignals() { return {}; } };
    await store.syncFromConnector(connector, { fetchContent: false, placement: { trustTier: 'S2', trustDomain: 'internal' }, tierClassification: { holdContentUntilJudged: true } });
    store.grantOnDemandRead('a', 'v1');
    const sink = createTieredStoreExtractionSink({ set, home: 'internal', syncConnectorId: 'extraction', ownerConnectorId: 'fixture', ownershipKind: 'observed' });
    await sink.accept({ ref: { corpusId: store.corpusId, provider: 'fixture', accountScope: 'one', approvedScopeKey: 'scope', providerItemId: 'a', localItemId: 'a', sourceVersion: 'v1' }, text: 'Unjudged confidential contents', extractorKind: 'local_text', extractorVersion: 'v1', fetchedAt: '2026-11-12T00:01:00Z' });
    expect(store.tierLedger()!.getCurrent(item.identity)?.contentPending).toBe(true);
    expect(store.localContent('a')?.chunks ?? []).toEqual([]);
    expect(store.contentServedNow('a')).toBe(false);
    expect(store.itemMetadataSnapshot(item.identity)?.read_on_demand).toBe(true);
    await settlePersonal(item);
    expect(store.contentServedNow('a')).toBe(true);
    expect(store.localContent('a')?.chunks).toEqual(['Unjudged confidential contents']);
    const privateDecision = classifyContentTier({ text: 'Unjudged confidential contents', metadataTier: 'private', metadataForced: false, metadataFlagged: false, holdUntilJudged: true }, {
      sniffer: { id: 'test-judge', judge: () => ({ verdict: 'decided', tier: 'secure', code: 'sensitive:0.99' }) },
    });
    const privatePlacement = {
      ...privateDecision, metadataTier: 'private' as const, metadataPending: false,
      metadataForced: false, metadataFlagged: false, contentRead: true, state: 'current' as const,
    };
    expect(set.ledger.recordRoutedPlacement(item.identity, privatePlacement, set.placementFor(privatePlacement)).outcome).toBe('queued_move');
    await moveTieredItem({ set, identity: item.identity, target: { metadataTier: 'private', contentTier: 'secure' } });
    expect(store.contentServedNow('a')).toBe(false);
    expect(store.localContent('a')?.chunks ?? []).toEqual([]);
    expect(store.readOnDemand('a', 'v2')).toBe(false);
  });

  test('revoking a grant after the keyword read withholds the body match from partial and final hits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'on-demand-keyword-'));
    const dbPath = join(dir, 'store.sqlite');
    const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    const db = new Database(dbPath);
    cleanup.push(() => { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
    await store.syncFromConnector(fixtureConnector(() => [
      { id: 'body', name: 'report.txt', text: 'quartzneedle' },
      { id: 'name', name: 'quartzneedle.txt' },
      { id: 'outside', name: 'unrelated.txt' },
    ]), {
      fetchContent: true, tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER },
      sourceScopeObservation: item => ({
        accountGeneration: 'a'.repeat(64), scopeRevision: '00000000-0000-4000-8000-000000000001',
        folderKeys: [item.identity.providerItemId === 'outside' ? 'other' : 'names'],
      }),
    });
    // Another item outside the folder has the same local ID.
    db.query('UPDATE items SET local_item_id = ? WHERE provider_item_id = ?').run('personal:body', 'outside');
    store.grantOnDemandRead('personal:body', 'v1');
    const adapter = createConnectorStoreCorpusAdapter({ store, filters: { metadataOnlySourceScopeFolderKeys: ['names'] } });
    const request = { corpus: defineConnectorCorpus(store), context: { allowedTrustDomains: [store.trustDomain] }, query: 'quartzneedle', maxResults: 10 };
    expect((await adapter(request)).hits.map(hit => hit.sourceItem.providerItemId)).toContain('body');

    // The FTS page has returned its body candidate when the tier check sees it.
    const held = store.onDemandContentHeld.bind(store);
    const revoke = spyOn(store, 'onDemandContentHeld').mockImplementationOnce(identity => {
      const result = held(identity);
      expect(identity.providerItemId).toBe('body');
      db.query('DELETE FROM on_demand_item_reads WHERE local_item_id = ?').run('personal:body');
      return result;
    });
    const partialIds: string[] = [];
    const response = await adapter({ ...request, onPartialResponse: partial => {
      partialIds.push(...partial.hits.map(hit => hit.sourceItem.providerItemId));
    } });
    expect(revoke).toHaveBeenCalled();
    expect(partialIds).toContain('name');
    expect(partialIds).not.toContain('body');
    expect(response.hits.map(hit => hit.sourceItem.providerItemId)).toEqual(['name']);
    expect(response.matchCount).toMatchObject({ matchedItems: 1, contentMatchedItems: 0 });
  });

  async function searchableGrantFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'on-demand-emission-'));
    const dbPath = join(dir, 'store.sqlite');
    const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const sync = (version: string, body: string) => store.syncFromConnector(fixtureConnector(() => [
      { id: 'report', name: 'orchard.txt', text: body, version },
    ]), { fetchContent: true, tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER } });
    await sync('v1', 'quartzneedle');
    store.grantOnDemandRead('personal:report', 'v1');
    return { store, sync, revoke: () => store.revokeOnDemandRead('personal:report'),
      filters: { metadataOnlyLocatorPathScopes: ['/Files'] },
      request: { corpus: defineConnectorCorpus(store), context: { allowedTrustDomains: [store.trustDomain] },
        query: 'quartzneedle', maxResults: 10 },
    };
  }

  test.each(['hybrid', 'metadata probe'] as const)('%s drops a vector body match revoked after the vector read', async mode => {
    const { store, filters, request, revoke } = await searchableGrantFixture();
    const provider: SourceEmbeddingProvider = { provider: 'built-in', backend: 'local', modelId: 'test-emission', dimension: 2,
      configHash: '1', epochId: '1', async embed(inputs) { return inputs.map(() => [1, 0]); } };
    await store.embedChunks({ provider });
    const adapter = createConnectorStoreCorpusAdapter({ store, filters, embeddingProvider: provider, semanticRelevanceBar: 0.5 });
    const search = mode === 'hybrid' ? adapter : adapter.metadataMatches!;
    const query = { ...request, query: 'unrelatedquery' };
    expect((await search(query)).matchCount?.contentMatchedItems).toBe(1);
    const read = store.vectorSearchLane.bind(store);
    const vector = spyOn(store, 'vectorSearchLane').mockImplementationOnce(async (...args) => {
      const lane = await read(...args);
      expect(lane.rows).toHaveLength(1);
      revoke();
      return lane;
    });
    const response = await search(query);
    expect(vector).toHaveBeenCalled();
    expect(response.hits).toEqual([]);
    expect(response.semanticRows?.hits ?? []).toEqual([]);
    expect(response.matchCount).toMatchObject({ matchedItems: 0, contentMatchedItems: 0 });
  });

  test('a timeout rechecks a granted partial when the store publishes no further rows', async () => {
    const { store, filters, request, revoke } = await searchableGrantFixture();
    const read = store.searchItemsDetailedOffThread.bind(store);
    let stalled = false;
    spyOn(store, 'searchItemsDetailedOffThread').mockImplementationOnce(async (...args) => {
      const page = await read(...args);
      expect(page.rows).toHaveLength(1);
      revoke();
      stalled = true;
      return new Promise(() => {});
    });
    const clock = createTestClock();
    const routed = routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([request.corpus]),
      adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store, filters }) },
      laneClock: clock, request: { ...request, readWide: true },
    });
    await waitFor(() => stalled);
    await clock.advance(20_000);
    const response = await routed;
    expect(response.skippedCorpora[0]?.reason).toBe('lane_timeout');
    expect(response.hits).toEqual([]);
    expect(response.matchingCandidateIds).toEqual([]);
  });

  test('uncalibrated vector neighbours do not become timeout matches or readWide ids', async () => {
    const { store, filters, request } = await searchableGrantFixture();
    const provider: SourceEmbeddingProvider = { provider: 'built-in', backend: 'local', modelId: 'test-uncalibrated', dimension: 2,
      configHash: '1', epochId: '1', async embed(inputs) { return inputs.map(() => [1, 0]); } };
    await store.embedChunks({ provider });
    const adapter = createConnectorStoreCorpusAdapter({ store, filters, embeddingProvider: provider });
    spyOn(store, 'searchItemsDetailedOffThread').mockImplementationOnce(() => new Promise(() => {}));
    const clock = createTestClock();
    let published = false;
    const routed = routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([request.corpus]),
      adapters: {
        [store.corpusId]: corpusRequest => adapter({
          ...corpusRequest,
          onPartialResponse(response, lane) {
            published = true;
            corpusRequest.onPartialResponse?.(response, lane);
          },
        }),
      },
      laneClock: clock, request: { ...request, query: 'unrelatedquery', readWide: true },
    });
    await waitFor(() => published);
    await clock.advance(20_000);
    const response = await routed;
    expect(response.skippedCorpora[0]?.reason).toBe('lane_timeout');
    expect(response.hits).toEqual([]);
    expect(response.matchingCandidateIds).toEqual([]);
    expect(response.matchCounts?.[0]).toMatchObject({ matchedItems: 0, contentMatchedItems: 0, saturated: true });
  });

  test.each(['quartzneedle', 'orchard'] as const)('a grant revoked after one corpus completes revalidates routed hits, counts and readWide matches (%s)', async query => {
    const { store, filters, request, revoke } = await searchableGrantFixture();
    const adapter = createConnectorStoreCorpusAdapter({ store, filters,
      resultProjector: { project: ({ sourceItem }) => ({ locator: { id: sourceItem.localItemId } }) },
    });
    const other = { ...request.corpus, corpusId: 'internal.fixture.slow' };
    const { promise: completed, resolve: complete } = Promise.withResolvers<void>();
    const response = await routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([request.corpus, other]),
      adapters: {
        [store.corpusId]: async corpusRequest => {
          const result = await adapter(corpusRequest);
          expect(result.hits).toHaveLength(1);
          complete();
          return result;
        },
        [other.corpusId]: async () => {
          await completed;
          revoke();
          return { hits: [], latencyMs: 0, rawExposed: false };
        },
      },
      request: { ...request, query, readWide: true },
    });
    const titleMatches = query === 'orchard';
    expect(response.hits.map(hit => hit.sourceItem.providerItemId)).toEqual(titleMatches ? ['report'] : []);
    if (titleMatches) expect(response.hits[0]).toMatchObject({ locator: { id: 'personal:report' } });
    expect(response.hits[0]?.provenance?.chunk).toBeUndefined();
    expect(response.matchingCandidateIds).toHaveLength(titleMatches ? 1 : 0);
    expect(response.matchCounts?.[0]).toMatchObject({ matchedItems: titleMatches ? 1 : 0, contentMatchedItems: 0 });
  });

  test.each(['sibling search', 'visibility check'] as const)('direct search withdraws the primary hit and audit after revoke during %s', async phase => {
    const { store, filters, request, revoke } = await searchableGrantFixture();
    const sibling = new LocalConnectorStore({ dbPath: join(dirname(store.dbPath), 'sibling.sqlite'),
      corpusId: 'secure_local.fixture.files', family: 'file', trustDomain: 'secure_local' });
    cleanup.unshift(() => sibling.close());
    let withdraw = false;
    const worker = createEmailSourceWorker({
      connectorStores: [store, sibling],
      connectorStoreTierSiblings: () => [sibling.corpusId],
      sourceIndexVisibilityGate: hits => {
        if (withdraw && phase === 'visibility check') revoke();
        return [...hits];
      },
      connectorStoreReadScope: current => {
        if (current === sibling && withdraw && phase === 'sibling search') revoke();
        return { allowed: true, filters };
      },
    });
    async function direct() {
      const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
        method: 'POST', body: JSON.stringify({ corpus_id: store.corpusId, query: request.query }),
      }));
      expect(response.status).toBe(200);
      return response.json();
    }
    expect((await direct()).hits[0].selected_item).toBeDefined();
    withdraw = true;
    const result = await direct();
    expect(result.hits).toEqual([]);
    expect(result.audit.metadata_hits).toBe(0);
    expect(result.audit.lane_audits.some((audit: { candidateCount: number }) => audit.candidateCount > 0)).toBe(false);
    expect((await direct()).hits).toEqual([]);
  });

  test.each(['expansion', 'merged visibility check', 'expansion with a replacement grant'] as const)('the pack withdraws a literal body hit, counts, and audits revoked during %s', async phase => {
    const { store, filters, request, revoke } = await searchableGrantFixture();
    const adapter = createConnectorStoreCorpusAdapter({ store, filters });
    const contentProvider = createConnectorStoreContentProvider({ store, contentAllowed: false, metadataFilters: {} });
    const priorReadWide = process.env.OLYMPUS_READ_WIDE;
    process.env.OLYMPUS_READ_WIDE = '1';
    cleanup.push(() => {
      if (priorReadWide === undefined) delete process.env.OLYMPUS_READ_WIDE;
      else process.env.OLYMPUS_READ_WIDE = priorReadWide;
    });
    const queries: string[] = [];
    let visibilityChecks = 0;
    const detail = await buildEvidencePackDetailed({
      question: request.query,
      maxResults: 3,
      searchContext: request.context,
      registry: buildSourceIndexCorpusRegistry([request.corpus]),
      adapters: { [store.corpusId]: async input => {
        queries.push(input.query);
        if (phase !== 'merged visibility check' && input.query !== request.query) {
          revoke();
          if (phase === 'expansion with a replacement grant') store.grantOnDemandRead('personal:report', 'v1');
        }
        return adapter(input);
      } },
      contentProviders: { [store.corpusId]: contentProvider },
      queryPlanner: async () => ['unrelatedquery'],
      visibilityGate: hits => {
        if (++visibilityChecks === 3 && phase === 'merged visibility check') revoke();
        return hits;
      },
    });
    expect(queries).toEqual([request.query, 'unrelatedquery']);
    expect(detail.pack.candidates).toEqual([]);
    expect(detail.pack.coverage.matchCounts?.[0]).toMatchObject({ matchedItems: 0, contentMatchedItems: 0, inEvidence: 0 });
    expect(detail.laneAudits.some(audit => audit.candidateCount > 0 || audit.returnedCount > 0)).toBe(false);
  });

  test.each(['keyword', 'hybrid'] as const)('routed %s hits, readWide IDs and audit counts withdraw a revoked body match', async retrievalMode => {
    const { store, filters, request, revoke } = await searchableGrantFixture();
    const provider: SourceEmbeddingProvider = { provider: 'built-in', backend: 'local', modelId: 'audit-epoch',
      dimension: 2, configHash: '1', epochId: '1', async embed(inputs) { return inputs.map(() => [1, 0]); } };
    if (retrievalMode === 'hybrid') await store.embedChunks({ provider });
    const response = await routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([request.corpus]),
      adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store, filters, retrievalMode,
        embeddingProvider: provider, semanticRelevanceBar: 0.5 }) },
      visibilityGate: hits => { expect(hits.length).toBeGreaterThan(0); revoke(); return [...hits]; },
      request: { ...request, readWide: true },
    });
    expect(response.hits).toEqual([]);
    expect(response.matchingCandidateIds).toEqual([]);
    expect(response.matchCounts?.[0]).toMatchObject({ matchedItems: 0, contentMatchedItems: 0 });
    expect(response.laneAudits.some(audit => audit.candidateCount > 0 || audit.returnedCount > 0)).toBe(false);
  });

  test('moving a matched item into a names-only folder withdraws its ungranted body', async () => {
    const { store, request, revoke } = await searchableGrantFixture();
    revoke();
    const filters = { metadataOnlyLocatorPathScopes: ['/names'] };
    const db = new Database(store.dbPath);
    try {
      const response = await routeSourceIndexSearch({
        registry: buildSourceIndexCorpusRegistry([request.corpus]),
        adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store, filters }) },
        visibilityGate: hits => {
          expect(hits.length).toBeGreaterThan(0);
          db.run("UPDATE items SET locator_uri = '/names/orchard.txt' WHERE provider_item_id = 'report'");
          return [...hits];
        },
        request: { ...request, readWide: true },
      });
      expect(response.hits).toEqual([]);
      expect(response.matchingCandidateIds).toEqual([]);
      expect(response.matchCounts?.[0]?.matchedItems).toBe(0);
    } finally { db.close(); }
  });

  test.each(['revoked', 'replaced'] as const)('a passage read withdraws its body when the grant is %s during query embedding', async change => {
    const { store, filters, request, revoke } = await searchableGrantFixture();
    const embeddingProvider: SourceEmbeddingProvider = { provider: 'built-in', backend: 'local', modelId: 'read-epoch',
      dimension: 2, configHash: '1', epochId: '1', async embed(inputs) { return inputs.map(() => [1, 0]); } };
    await store.embedChunks({ provider: embeddingProvider });
    const { hits } = await createConnectorStoreCorpusAdapter({ store, filters })(request);
    const content = createConnectorStoreContentProvider({ store, contentAllowed: false, metadataFilters: {}, embeddingProvider });
    const read = () => content.fetchLocalContent({ provenance: hits[0]!.provenance!, trustDomain: store.trustDomain,
      query: request.query, maxChars: 1000 });
    expect((await read())?.chunks).toEqual(['quartzneedle']);
    spyOn(embeddingProvider, 'embed').mockImplementationOnce(async () => {
      revoke();
      if (change === 'replaced') store.grantOnDemandRead('personal:report', 'v1');
      return [[1, 0]];
    });
    expect((await read())?.chunks ?? []).toEqual([]);
  });

  test('moving a granted item outside approved folders withdraws its hits, counts and readWide IDs', async () => {
    const { store, request, filters } = await searchableGrantFixture();
    const db = new Database(store.dbPath);
    cleanup.push(() => db.close());
    const response = await routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([request.corpus]),
      adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({
        store, filters: { ...filters, locatorPathScopes: ['/Files'] },
      }) },
      visibilityGate: hits => {
        expect(hits).toHaveLength(1);
        db.run("UPDATE items SET locator_uri = '/unapproved/orchard.txt' WHERE provider_item_id = 'report'");
        expect(store.currentOnDemandRead('personal:report', 'v1')).toBe(true);
        return [...hits];
      },
      request: { ...request, readWide: true },
    });
    expect(response.hits).toEqual([]);
    expect(response.matchingCandidateIds).toEqual([]);
    expect(response.matchCounts?.[0]).toMatchObject({ matchedItems: 0, contentMatchedItems: 0 });
  });

  test('moving a granted item outside approved folders during query embedding withdraws its passage', async () => {
    const { store, request, filters } = await searchableGrantFixture();
    const db = new Database(store.dbPath);
    cleanup.push(() => db.close());
    const embeddingProvider: SourceEmbeddingProvider = { provider: 'built-in', backend: 'local', modelId: 'read-scope',
      dimension: 2, configHash: '1', epochId: '1', async embed(inputs) { return inputs.map(() => [1, 0]); } };
    await store.embedChunks({ provider: embeddingProvider });
    const metadataFilters = { locatorPathScopes: ['/Files'] };
    const { hits } = await createConnectorStoreCorpusAdapter({ store, filters: { ...filters, ...metadataFilters } })(request);
    const content = createConnectorStoreContentProvider({ store, contentAllowed: false, metadataFilters, embeddingProvider });
    const read = () => content.fetchLocalContent({ provenance: hits[0]!.provenance!, trustDomain: store.trustDomain,
      query: request.query, maxChars: 1000 });
    expect((await read())?.chunks).toEqual(['quartzneedle']);
    spyOn(embeddingProvider, 'embed').mockImplementationOnce(async () => {
      db.run("UPDATE items SET locator_uri = '/unapproved/orchard.txt' WHERE provider_item_id = 'report'");
      expect(store.currentOnDemandRead('personal:report', 'v1')).toBe(true);
      return [[1, 0]];
    });
    expect(await read()).toBeUndefined();
  });

  test('revocation uses its registered commit wait', async () => {
    const { store, revoke } = await searchableGrantFixture();
    const db = new Database(store.dbPath);
    try {
      db.exec(`CREATE TABLE observed_revoke_wait (ms INTEGER);
        CREATE TRIGGER capture_revoke_wait AFTER DELETE ON on_demand_item_reads BEGIN
          INSERT INTO observed_revoke_wait SELECT timeout FROM pragma_busy_timeout;
        END;`);
      const policy = registeredLimits().find(entry => entry.id === 'privacy.revocation_write');
      expect(policy).toMatchObject({ kind: 'time', unit: 'ms', milliseconds: 1_000 });
      revoke();
      expect(db.query('SELECT ms FROM observed_revoke_wait').get()).toEqual({ ms: 1_000 });
    } finally { db.close(); }
  });

  test('an unchanged grant epoch delivers without querying individual grants again', async () => {
    const { store, filters, request } = await searchableGrantFixture();
    const check = spyOn(store, 'searchGrantLayers');
    expect((await createConnectorStoreCorpusAdapter({ store, filters })(request)).hits).toHaveLength(1);
    expect(check).not.toHaveBeenCalled();
  });

  test.each(['same-version title', 'replacement version'] as const)('a timeout recovers a revoked body match only from an independent same-version title (%s)', async version => {
    const { store, filters, request, revoke, sync } = await searchableGrantFixture();
    const read = store.searchItemsDetailedOffThread.bind(store);
    let stalled = false;
    spyOn(store, 'searchItemsDetailedOffThread').mockImplementationOnce(async (...args) => {
      const page = await read(...args);
      expect(page.rows[0]?.chunk).toBeDefined();
      revoke();
      if (version === 'replacement version') {
        await sync('v2', 'different contents');
        store.grantOnDemandRead('personal:report', 'v2');
      }
      stalled = true;
      return new Promise(() => {});
    });
    const clock = createTestClock();
    const routed = routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([request.corpus]),
      adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store, filters }) },
      laneClock: clock, request: { ...request, query: 'orchard', readWide: true },
    });
    await waitFor(() => stalled);
    await clock.advance(20_000);
    const response = await routed;
    expect(response.skippedCorpora[0]?.reason).toBe('lane_timeout');
    const sameVersion = version === 'same-version title';
    expect(response.hits.map(hit => hit.sourceItem.providerItemId)).toEqual(sameVersion ? ['report'] : []);
    expect(response.hits[0]?.provenance?.chunk).toBeUndefined();
    expect(response.matchingCandidateIds).toHaveLength(sameVersion ? 1 : 0);
    expect(response.matchCounts?.[0]).toMatchObject({ matchedItems: sameVersion ? 1 : 0, contentMatchedItems: 0, saturated: true });
  });

  test('a replacement version grant cannot release an earlier body match', async () => {
    const { store, filters, request, sync } = await searchableGrantFixture();
    const adapter = createConnectorStoreCorpusAdapter({ store, filters });
    const read = store.searchItemsDetailedOffThread.bind(store);
    spyOn(store, 'searchItemsDetailedOffThread').mockImplementationOnce(async (...args) => {
      const found = await read(...args);
      expect(found.rows[0]?.sourceItem.sourceVersion).toBe('v1');
      await sync('v2', 'different contents');
      store.grantOnDemandRead('personal:report', 'v2');
      return found;
    });
    const response = await adapter(request);
    expect(response.hits).toEqual([]);
    expect(response.matchCount).toMatchObject({ matchedItems: 0, contentMatchedItems: 0 });
  });

  test('revocation keeps an independent title match as metadata only', async () => {
    const { store, filters, request, revoke } = await searchableGrantFixture();
    const adapter = createConnectorStoreCorpusAdapter({ store, filters });
    const read = store.searchItemsDetailedOffThread.bind(store);
    spyOn(store, 'searchItemsDetailedOffThread').mockImplementationOnce(async (...args) => {
      const found = await read(...args);
      expect(found.rows[0]?.chunk).toBeDefined();
      revoke();
      return found;
    });
    const response = await adapter({ ...request, query: 'orchard' });
    expect(response.hits.map(hit => hit.sourceItem.providerItemId)).toEqual(['report']);
    expect(response.hits[0]?.provenance?.chunk).toBeUndefined();
    expect(response.matchCount).toMatchObject({ matchedItems: 1, contentMatchedItems: 0 });
    expect((await adapter(request)).hits).toEqual([]);
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
      }, { sniffer: JUDGED_PERSONAL_SNIFFER }));
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
    // Every store connection waits on a lock; so does this one. A closed
    // store's pool threads release the file as they stop, after close().
    db.exec('PRAGMA busy_timeout = 10000');
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
