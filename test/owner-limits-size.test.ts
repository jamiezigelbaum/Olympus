import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore, createConnectorStoreContentProvider } from '../src/workers/connector-store/index.ts';
import { createFileExtractionRuntime } from '../src/workers/engine/runtime/file-extraction-runtime.ts';
import { FileExtractionSourceError } from '../src/core/file-extraction-source.ts';
import { ownerLimits } from '../src/core/owner-limits.ts';
import { ownerLimitSettingsPath, saveOwnerLimitOverride } from '../src/core/owner-limit-settings.ts';
import { clearOwnerLimitStop, withOwnerLimitStore } from '../src/core/owner-limit-state.ts';
import { SOURCE_SIZE_LIMITS, sourceSizeBytes, sizeHeldItemKey, type SourceSizeLimit } from '../src/core/source-size-limits.ts';
import { buildEvidencePack } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import type { SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { copyDashboardViewModel } from '../src/workers/chatgpt/response-builder.ts';
import { forgetExtractionJobs } from '../src/workers/file-extraction/job-names.ts';
import { LocalFileExtractionJobStore, defaultFileExtractionJobsDbPath } from '../src/workers/file-extraction/job-store.ts';
import { createFileExtractionRunner } from '../src/workers/file-extraction/runner.ts';
import { buildExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import { refreshSourceSizeStop, resumeGrantedSizeHeld } from '../src/workers/file-extraction/size-limit-stops.ts';
import { unreadableFileReason } from '../src/workers/file-extraction/unreadable-files.ts';
import { DOCUMENT_READER_MAX_INPUT_BYTES, IMAGE_READER_MAX_INPUT_BYTES } from '../src/workers/file-extraction/extractors/input-limits.ts';
import type { ExtractionItemRef, FileExtractionSource } from '../src/workers/file-extraction/types.ts';
import { createTestClock } from './helpers/test-clock.ts';

const time = createTestClock(Date.now());
const stops = () => withOwnerLimitStore(store => store.openLimitStops(time.date()));
const corpora = ['internal.dropbox.files', 'internal.local.files', 'internal.telegram.messages'];
let jobs = new LocalFileExtractionJobStore(defaultFileExtractionJobsDbPath());
withOwnerLimitStore(() => {});
beforeEach(() => {
  jobs.setSizeHoldCurrentItems(refs => refs.map(() => true));
  forgetExtractionJobs(defaultFileExtractionJobsDbPath(), { corpusIds: corpora });
  rmSync(ownerLimitSettingsPath(), { force: true });
  for (const stop of stops()) clearOwnerLimitStop(stop.id, stop.subject);
});
afterAll(() => { jobs.close(); });
function emptyView(): SourceDashboardViewModel {
  return { kind: 'source_dashboard', sources: [], generated_at: time.date().toISOString(), summary: {},
    onboarding: { steps: [], ask_first_question: { enabled: false, label: '', suggestion: '' } }, answer_lanes: [],
    where_your_data_lives: [], unassigned_corpora: { corpus_count: 0, entries: [] },
    excluded_by_configuration: { entries: [] }, folder_picker: { available: false }, history: {}, policy: {} } as unknown as SourceDashboardViewModel;
}
function fixture(policy: SourceSizeLimit, unknownSize = false) {
  const corpusId = corpora[SOURCE_SIZE_LIMITS.indexOf(policy)]!;
  const lane = { corpusId, provider: policy.providers[0]!, accountScope: 'personal', approvedScopeKey: 'approved' };
  let refs: ExtractionItemRef[] = [1, 2].map(n => ({ ...lane, localItemId: `private-folder/secret-${n}.txt`,
    providerItemId: `private-item-${n}`, sourceVersion: 'v1', mimeType: 'text/plain',
    name: `secret-${n}.txt`, ...(unknownSize ? {} : { sizeBytes: policy.defaultBytes + n }) }));
  let fetched = 0, extracted = 0;
  const source: FileExtractionSource = { id: 'fixture', ...lane,
    async listCandidates() { return { candidates: refs, done: true }; },
    async fetch(ref, options) {
      if (unknownSize && (options.maxBytes ?? 0) < policy.defaultBytes + 2) throw new FileExtractionSourceError('source_too_large', { sizeBytes: policy.defaultBytes + 2 });
      expect(options.maxBytes).toBeGreaterThanOrEqual(ref.sizeBytes ?? policy.defaultBytes + 2);
      fetched++; return { bytes: new TextEncoder().encode('A readable file.'), mimeType: 'text/plain' };
    },
  };
  const runner = createFileExtractionRunner({ jobs, now: time.date,
    registry: buildExtractorRegistry([{ kind: 'local_text', version: '1', egress: 'local',
      input: { kind: 'bytes', maxInputBytes: DOCUMENT_READER_MAX_INPUT_BYTES }, accepts: () => true,
      async extract() { return { status: 'indexed', text: 'A readable file.' }; } }]),
    corpora: [{ corpusId, trustDomain: 'internal', sizeLimit: policy, sizeStops: { resume: now => resumeGrantedSizeHeld(jobs, policy, now), refresh: now => refreshSourceSizeStop(jobs, policy, now) }, source,
      sink: { async accept() { extracted++; return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 0 }; } } }],
  });
  const coverage = async (withHit = false) => (await buildEvidencePack({ question: 'records', maxResults: 5,
    searchContext: { allowedTrustDomains: ['internal'] }, corpusIds: [corpusId],
    registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'internal' })]),
    adapters: { [corpusId]: () => ({ hits: withHit ? [{
      sourceItem: { family: 'file', provider: lane.provider, accountScope: lane.accountScope, providerItemId: refs[0]!.providerItemId, localItemId: refs[0]!.localItemId },
      provenance: { sourceItem: { family: 'file', provider: lane.provider, accountScope: lane.accountScope, providerItemId: refs[0]!.providerItemId, localItemId: refs[0]!.localItemId }, citation: { title: refs[0]!.name! } },
      score: 1, rawExposed: false,
    }] : [], latencyMs: 0, rawExposed: false }) }, contentProviders: { [corpusId]: {
      async fetchLocalContent() { return { chunks: [], sizeHeld: jobs.itemExtractionOutcome(refs[0]!)?.sizeHeldItemKey === sizeHeldItemKey(refs[0]!),
        sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }) }; },
    } }, limitStops: stops(),
  })).coverage;
  return { lane, runner, coverage, refs: () => refs, fetched: () => fetched, extracted: () => extracted,
    addItem() { refs = [...refs, { ...refs[0]!, providerItemId: 'future', localItemId: 'future', sourceVersion: 'v2' }]; } };
}

for (const policy of SOURCE_SIZE_LIMITS) {
  test(`${policy.id}: one counts-only stop and Home Raise resume the same runner without restart`, async () => {
    const f = fixture(policy);
    const plan = await f.runner.plan({ ...f.lane, limit: 10 });
    expect(plan.jobsSkippedTooLarge).toBe(2);
    await f.runner.plan({ ...f.lane, limit: 10 });
    expect(stops()).toMatchObject([{ id: policy.id, subject: policy.subject, limit: policy.defaultBytes,
      used: policy.defaultBytes + 2, waiting: { items: 2 }, reason: 'source_too_large' }]);
    expect(stops()).toHaveLength(1);
    expect(f.fetched()).toBe(0);
    const read = jobs.scopedReadiness([f.lane], { now: time.date(), onUnreadable(items) {
      expect(items.map(item => unreadableFileReason(item.errorKind))).toEqual(['too_large', 'too_large']);
    } });
    expect(read).toMatchObject({ unreadableItems: 2, failedActionableJobs: 0, failedTerminalJobs: 0, metadataOnlyExpectedItems: 0 });
    expect(jobs.corpusReadiness(f.lane.corpusId)).toMatchObject({ unreadableItems: 2, failedTerminalJobs: 0, failedActionableJobs: 0 });
    const home = copyDashboardViewModel(buildChatGptDashboardViewModel(emptyView(), { now: time.date(), limitStops: stops() }));
    const wait = home.waits!.find(wait => wait.fix?.args?.id === policy.id)!;
    expect(wait).toMatchObject({ waiting: { items: 2 }, limit: policy.defaultBytes, used: policy.defaultBytes + 2, unit: 'bytes' });
    expect(wait.fix?.label).toStartWith('Raise');
    for (const leaked of ['secret-1.txt', 'private-folder', 'private-item']) {
      expect(JSON.stringify(stops())).not.toContain(leaked);
      expect(JSON.stringify(await f.coverage(true))).not.toContain(leaked);
      expect(JSON.stringify(home)).not.toContain(leaked);
    }
    expect((await f.coverage()).extractionGaps.join(' ')).toContain('2 files held because they are too large');
    for (const to of [policy.defaultBytes - 1, policy.defaultBytes]) {
      await expect(ownerLimits({ action: 'continue', id: policy.id, to }, { now: time.date, extractionJobs: () => jobs })).rejects.toThrow('greater than');
    }
    await expect(ownerLimits({ action: 'continue', id: policy.id, to: policy.ceilingBytes + 1 }, { now: time.date, extractionJobs: () => jobs })).rejects.toThrow(`${policy.ceilingBytes} bytes`);
    let woke = false;
    await ownerLimits(wait.fix!.args!, { now: time.date, extractionJobs: () => jobs, wake: () => { woke = true; } });
    expect(woke).toBe(true);
    expect(jobs.sizeHeldJobs(policy.providers)).toEqual([]);
    await f.runner.run({ ...f.lane, limit: 10, reclassify: false });
    expect(f.extracted()).toBe(2);
    expect(stops()).toEqual([]);
    expect((await f.coverage()).extractionGaps).toEqual([]);
    // Temporary is per held VERSION, even on another day; future items keep the old limit.
    expect(sourceSizeBytes(policy, f.refs()[0], new Date('2026-11-15'))).toBe(wait.fix!.args!.to as number);
    f.addItem();
    await f.runner.plan({ ...f.lane, limit: 10 });
    expect(stops()[0]?.waiting).toEqual({ items: 1 });
    expect(stops()[0]?.limit).toBe(policy.defaultBytes);
    await ownerLimits({ action: 'continue', id: policy.id, to: policy.defaultBytes + 10, keep: true }, { now: time.date, extractionJobs: () => jobs });
    expect(sourceSizeBytes(policy, undefined, new Date('2026-11-15'))).toBe(policy.defaultBytes + 10);
    await f.runner.run({ ...f.lane, limit: 10, reclassify: false });
    expect(f.extracted()).toBe(3);
    expect(stops()).toEqual([]);
    expect(readFileSync(ownerLimitSettingsPath(), 'utf8')).not.toContain('private-folder');
  });

  test(`${policy.id}: size learned at fetch is reported with its amount and is retryable by Raise`, async () => {
    const f = fixture(policy, true);
    // An older/direct enqueue can carry a higher job cap than the live source.
    jobs.enqueue({ refs: f.refs(), extractorKind: 'local_text', extractorVersion: '1', maxBytesPerFile: policy.ceilingBytes });
    await f.runner.run({ ...f.lane, limit: 10, reclassify: false });
    expect(stops()).toMatchObject([{ id: policy.id, limit: policy.defaultBytes, used: policy.defaultBytes + 2, waiting: { items: 2 } }]);
    await ownerLimits({ action: 'continue', id: policy.id, to: policy.defaultBytes + 2 }, { now: time.date, extractionJobs: () => jobs });
    await f.runner.run({ ...f.lane, limit: 10, reclassify: false });
    expect(f.extracted()).toBe(2);
    expect(stops()).toEqual([]);
  });

  test(`${policy.id}: a size learned at fetch stays held after a partial Raise and a replan`, async () => {
    const f = fixture(policy, true);
    await f.runner.plan({ ...f.lane, limit: 10 });
    await f.runner.run({ ...f.lane, limit: 10, reclassify: false });
    expect(stops()).toMatchObject([{ id: policy.id, used: policy.defaultBytes + 2, waiting: { items: 2 } }]);
    // Below the discovered size: both files stay held, and a replan from a
    // listing without sizes must not drop them from the stop.
    await ownerLimits({ action: 'continue', id: policy.id, to: policy.defaultBytes + 1 }, { now: time.date, extractionJobs: () => jobs });
    await f.runner.plan({ ...f.lane, limit: 10 });
    await f.runner.run({ ...f.lane, limit: 10, reclassify: false });
    expect(f.extracted()).toBe(0);
    expect(jobs.sizeHeldJobs(policy.providers)).toHaveLength(2);
    expect(stops()).toMatchObject([{ id: policy.id, waiting: { items: 2 } }]);
    await ownerLimits({ action: 'continue', id: policy.id, to: policy.defaultBytes + 2 }, { now: time.date, extractionJobs: () => jobs });
    await f.runner.run({ ...f.lane, limit: 10, reclassify: false });
    expect(f.extracted()).toBe(2);
    expect(stops()).toEqual([]);
  });

  test(`${policy.id}: partial raises retain the remaining stop; images cannot exceed 64 MiB`, async () => {
    const f = fixture(policy);
    await f.runner.plan({ ...f.lane, limit: 10 });
    await ownerLimits({ action: 'continue', id: policy.id, to: policy.defaultBytes + 1 }, { now: time.date, extractionJobs: () => jobs });
    expect(stops()).toMatchObject([{ waiting: { items: 1 }, limit: policy.defaultBytes + 1, used: policy.defaultBytes + 2 }]);
    expect((await f.coverage()).extractionGaps.join(' ')).toContain('1 file held because they are too large');
    await f.runner.run({ ...f.lane, limit: 10, reclassify: false });
    expect(f.extracted()).toBe(1);
    await ownerLimits({ action: 'continue', id: policy.id, to: policy.defaultBytes + 2 }, { now: time.date, extractionJobs: () => jobs });
    await f.runner.run({ ...f.lane, limit: 10, reclassify: false });
    expect(f.extracted()).toBe(2);
    const image = { ...f.refs()[0]!, localItemId: 'image', providerItemId: 'image', mimeType: 'image/png', sizeBytes: IMAGE_READER_MAX_INPUT_BYTES + 1 };
    jobs.enqueue({ refs: [image], extractorKind: 'local_text', extractorVersion: '1', maxBytesPerFile: policy.defaultBytes });
    refreshSourceSizeStop(jobs, policy, time.date());
    await expect(ownerLimits({ action: 'continue', id: policy.id, to: IMAGE_READER_MAX_INPUT_BYTES + 1 }, { now: time.date, extractionJobs: () => jobs }))
      .rejects.toThrow(`${IMAGE_READER_MAX_INPUT_BYTES} bytes`);
  });

  test(`${policy.id}: durable grant recovers a crash before requeue; a later version is held separately`, async () => {
    const f = fixture(policy);
    // Pre-adoption queues stored the reader's larger bound after a source refusal.
    jobs.enqueue({ refs: f.refs(), extractorKind: 'local_text', extractorVersion: '1', maxBytesPerFile: policy.ceilingBytes });
    for (const job of jobs.lease({ ...f.lane, workerId: 'legacy', limit: 10 }).leasedJobs) {
      jobs.record({ jobId: job.jobId, status: 'skipped_too_large', errorKind: 'source_too_large' });
    }
    refreshSourceSizeStop(jobs, policy, time.date());
    const to = policy.ceilingBytes;
    saveOwnerLimitOverride(policy.id, to, false, time.date(), undefined, f.refs().map(sizeHeldItemKey));
    jobs.close(); jobs = new LocalFileExtractionJobStore(defaultFileExtractionJobsDbPath());
    resumeGrantedSizeHeld(jobs, policy, time.date()); refreshSourceSizeStop(jobs, policy, time.date());
    expect(jobs.sizeHeldJobs(policy.providers)).toEqual([]);
    expect(sourceSizeBytes(policy, { ...f.refs()[0]!, sourceVersion: 'later' }, time.date())).toBe(policy.defaultBytes);
    expect(stops()).toEqual([]);
  });
}

test('registered ceilings match the bytes readers and images retain their smaller hard ceiling', () => {
  for (const policy of SOURCE_SIZE_LIMITS) {
    expect(policy.ceilingBytes).toBe(DOCUMENT_READER_MAX_INPUT_BYTES);
    expect(sourceSizeBytes(policy, { provider: policy.providers[0]!, accountScope: 'personal', providerItemId: 'image', mimeType: 'image/png' }, time.date(), policy.ceilingBytes)).toBe(IMAGE_READER_MAX_INPUT_BYTES);
  }
});

test('Telegram streaming media keeps no whole-file memory cap', async () => {
  const policy = SOURCE_SIZE_LIMITS.find(policy => policy.id === 'telegram.media_quota')!;
  const streamJobs = new LocalFileExtractionJobStore(':memory:');
  const lane = { corpusId: 'internal.telegram.messages', provider: 'telegram', accountScope: 'personal', approvedScopeKey: 'approved' };
  try {
    const runner = createFileExtractionRunner({ jobs: streamJobs,
      registry: buildExtractorRegistry([{ kind: 'stream', version: '1', input: { kind: 'file' }, egress: 'local', accepts: () => true,
        async extract() { return { status: 'indexed', text: 'Transcript.' }; } }], ['stream']),
      corpora: [{ corpusId: lane.corpusId, trustDomain: 'internal', sizeLimit: policy,
        source: { id: 'stream', ...lane,
          async listCandidates() { return { candidates: [{ ...lane, providerItemId: 'audio', localItemId: 'audio', mimeType: 'audio/mpeg', sizeBytes: policy.ceilingBytes + 1 }], done: true }; },
          async fetch() { throw new Error('Planning must not read bytes.'); } },
        sink: { async accept() { return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 0 }; } },
      }],
    });
    expect(await runner.plan({ ...lane, limit: 1 })).toMatchObject({ jobsQueued: 1, jobsSkippedTooLarge: 0 });
  } finally { streamJobs.close(); }
});


test('a held-version grant distinguishes media with the same provider id in different chats', () => {
  const policy = SOURCE_SIZE_LIMITS.find(policy => policy.id === 'telegram.media_quota')!;
  const first = { provider: 'telegram', accountScope: 'personal', providerItemId: '42#child:media', localItemId: 'chat-one:42#child:media', sourceVersion: 'same-edit-time' };
  const other = { ...first, localItemId: 'chat-two:42#child:media' };
  const to = policy.defaultBytes + 1;
  saveOwnerLimitOverride(policy.id, to, false, time.date(), undefined, [sizeHeldItemKey(first)]);
  expect(sourceSizeBytes(policy, first, time.date())).toBe(to);
  expect(sourceSizeBytes(policy, other, time.date())).toBe(policy.defaultBytes);
});


test('a source byte-size stop does not relabel an extractor dimension ceiling as a file-byte cap', () => {
  const policy = SOURCE_SIZE_LIMITS[0]!;
  const ref = { corpusId: corpora[0]!, provider: policy.providers[0]!, accountScope: 'personal', approvedScopeKey: 'approved', localItemId: 'small-picture', providerItemId: 'small-picture', mimeType: 'image/png', sizeBytes: 1 };
  jobs.enqueue({ refs: [ref], extractorKind: 'local_text', extractorVersion: '1', maxBytesPerFile: policy.defaultBytes });
  for (const job of jobs.lease({ ...ref, workerId: 'fixture', limit: 1 }).leasedJobs) {
    jobs.record({ jobId: job.jobId, status: 'skipped_too_large', errorKind: 'image_dimensions_too_large' });
  }
  refreshSourceSizeStop(jobs, policy, time.date());
  expect(stops()).toEqual([]);
  expect(jobs.corpusReadiness(ref.corpusId)).toMatchObject({ unreadableItems: 1, failedTerminalJobs: 0 });
});

test('Raise from a read-only queue (the split front) saves the grant; the runner requeues on its next run', async () => {
  const policy = SOURCE_SIZE_LIMITS[0]!;
  const f = fixture(policy);
  await f.runner.plan({ ...f.lane, limit: 10 });
  expect(jobs.sizeHeldJobs(policy.providers)).toHaveLength(2);
  await expect(ownerLimits({ action: 'continue', id: policy.id, to: policy.defaultBytes + 2 }, { now: time.date }))
    .rejects.toThrow('held-file queue is unavailable');
  const front = new LocalFileExtractionJobStore(defaultFileExtractionJobsDbPath(), { readonly: true });
  try {
    await ownerLimits({ action: 'continue', id: policy.id, to: policy.defaultBytes + 2 }, { now: time.date, extractionJobs: () => front });
  } finally { front.close(); }
  // Nothing was written through the read-only queue.
  expect(jobs.sizeHeldJobs(policy.providers)).toHaveLength(2);
  await f.runner.run({ ...f.lane, limit: 10, reclassify: false });
  expect(f.extracted()).toBe(2);
  expect(stops()).toEqual([]);
});

for (const readOnly of [false, true]) {
  for (const change of ['deleted', 'scope revoked', 'version changed'] as const) {
    test(`${change} (${readOnly ? 'front' : 'background'}): live fence reports one hold and Raise grants only that version`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'size-hold-store-'));
      const policy = SOURCE_SIZE_LIMITS[0]!;
      const corpusId = corpora[0]!;
      const store = new LocalConnectorStore({ dbPath: join(dir, 'store.sqlite'), corpusId, family: 'file', trustDomain: 'internal' });
      let runtime: ReturnType<typeof createFileExtractionRuntime>;
      let front: ReturnType<typeof createFileExtractionRuntime>;
      const items: RawItem[] = [1, 2].map(n => ({
        identity: { family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: `file-${n}`, localItemId: `file-${n}`, sourceVersion: 'v1' },
        mimeType: 'text/plain', content: { kind: 'metadata_only' }, metadata: { title: `held-title-${n}`, sizeBytes: policy.defaultBytes + n }, fetchedAt: time.date().toISOString(),
      }));
      const connector: SourceConnector = { id: 'size-fixture', family: 'file', async authenticate() {},
        async *listItems() { yield { items, done: true }; }, async fetchItem() { throw new Error('No inline fetch'); }, classificationSignals() { return {}; } };
      const sync = () => store.syncFromConnector(connector, { fetchContent: false, placement: { trustTier: 'S2', trustDomain: 'internal' } });
      try {
        await sync();
        let revoked = false;
        const buildRuntime = (readOnly = false) => createFileExtractionRuntime({ enabled: true, readOnly, connectorStores: [store],
          jobsDbPath: join(dir, 'jobs.sqlite'), env: { OLYMPUS_DATA_DIR: dir },
          corpora: [{ corpusId, provider: 'dropbox', scopes: ['approved'] }],
          scopeGuard: { assertAuthorized() {}, allowsRef: ({ ref }) => !(revoked && ref.localItemId === items[0]!.identity.localItemId) },
          sourceFactories: new Map([['dropbox', () => ({ id: 'size-fixture', corpusId, provider: 'dropbox',
            async listCandidates() { return { candidates: [], done: true }; }, async fetch() { throw new Error('No fetch'); } })]]),
        });
        runtime = buildRuntime();
        const queue = runtime!.jobs;
        const refs = items.map(item => ({ ...item.identity, ...store.itemMetadataSnapshot(item.identity), corpusId, approvedScopeKey: 'approved' }));
        queue.enqueue({ refs, extractorKind: 'local_text', extractorVersion: '1', maxBytesPerFile: policy.defaultBytes });
        store.setExtractionOutcomeProbe((identity, localItemId) => queue.itemExtractionOutcome({ ...identity, localItemId }));
        const provider = createConnectorStoreContentProvider({ store });
        const block = () => provider.fetchLocalContent({ provenance: { sourceItem: items[0]!.identity }, trustDomain: 'internal' });
        expect((await block())?.sizeHeld).toBe(true);
        if (change === 'version changed') {
          items[0] = { ...items[0]!, identity: { ...items[0]!.identity, sourceVersion: 'v2' } };
          await sync();
          expect((await block())?.sizeHeld).toBeUndefined();
        } else if (change === 'deleted') {
          store.tombstoneCopy(items[0]!.identity, { connectorId: connector.id });
        } else revoked = true;
        refreshSourceSizeStop(queue, policy, time.date());
        expect(stops()).toMatchObject([{ waiting: { items: 1 } }]);
        if (readOnly) front = buildRuntime(true);
        await ownerLimits({ action: 'continue', id: policy.id, to: policy.defaultBytes + 2 }, { now: time.date, extractionJobs: () => front?.jobs ?? queue });
        resumeGrantedSizeHeld(queue, policy, time.date());
        refreshSourceSizeStop(queue, policy, time.date());
        expect(sourceSizeBytes(policy, refs[0], time.date())).toBe(policy.defaultBytes);
        expect(sourceSizeBytes(policy, refs[1], time.date())).toBe(policy.defaultBytes + 2);
        expect(stops()).toEqual([]);
        // Restart continuation also leaves the obsolete job's terminal history alone.
        saveOwnerLimitOverride(policy.id, policy.defaultBytes + 2, false, time.date(), undefined, [sizeHeldItemKey(refs[0]!)]);
        resumeGrantedSizeHeld(queue, policy, time.date());
        queue.setSizeHoldCurrentItems(refs => refs.map(() => true));
        expect(queue.sizeHeldJobs(policy.providers).map(job => job.ref.localItemId)).toEqual([refs[0]!.localItemId]);
      } finally { front?.close(); runtime?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
