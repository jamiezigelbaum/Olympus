// A folder on this computer, from Connect to an answer and back out again:
// connect (no sign-in), approve a folder, the scheduler's sync task lists it,
// the shared extraction runner reads the text through the connector's own
// scope-safe reader, an edit is read again, a deletion removes the file, and
// disconnecting stops the lane while keeping what is indexed.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteMarkedAccounts, deleteOlympusDataWithCustody } from '../src/data-lifecycle.ts';
import { writeConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import { TIER_DOMAIN_ORDER } from '../src/workers/connector-store/tiered-store-set.ts';
import { tieredExtractionView } from '../src/workers/connector-store/tiered-extraction.ts';
import { WatchHub } from '../src/workers/local-files/watch-hub.ts';
import { enableSourceRegistryAdoption } from '../src/core/source-storage.ts';
import { defaultConfig } from '../src/core/config.ts';
import { defaultLocalFilesIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { connectThisComputerSource, disconnectThisComputerSource } from '../src/core/this-computer.ts';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { connectorStoreExtractionCandidateReader } from '../src/workers/connector-store/extraction-candidate-reader.ts';
import { createConnectorFileExtractionSource } from '../src/workers/file-extraction/connector-source.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { buildExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import { createFileExtractionRunner } from '../src/workers/file-extraction/runner.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import type { Extractor } from '../src/workers/file-extraction/types.ts';
import { createLocalFilesSourceConnector } from '../src/workers/local-files/connector.ts';
import { defaultExclusionContext, type DefaultExclusionContext } from '../src/workers/local-files/paths.ts';
import { createLocalFilesProviderStoreSyncHandler } from '../src/workers/local-files/provider-store-sync.ts';
import { createLocalFilesSchedulerSource } from '../src/workers/local-files/scheduler-source.ts';
import {
  LOCAL_FILES_ACCOUNT_SCOPE,
  LOCAL_FILES_PROVIDER,
  LOCAL_FILES_SOURCE_ID,
  createScopeBoundLocalFilesContentScope,
  fileSourceScopeLocalFilesPolicy,
} from '../src/workers/local-files/scope.ts';
import {
  LOCAL_FILES_CORPUS_ID,
  createLocalFilesConnectorStore,
  createLocalFilesTierLane,
  localFilesWatchDir,
} from '../src/workers/local-files/store.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { fileSourceScopeContentFilters, fileSourceScopeMetadataFilters, FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';
import { localFilesTestTierSet } from './helpers/lane-tier-sets.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe('local files from Connect to an answer', () => {
  test('connect, approve a folder, sync, read, edit, delete, disconnect', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'local-files-e2e-')));
    const home = join(base, 'home');
    const proj = join(home, 'notes');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'harbour.txt'), 'the harbour master keeps a ledger of tides');
    writeFileSync(join(proj, 'garden.txt'), 'tomatoes ripen on the south wall');
    const registryPath = join(base, 'handles.json');
    const authority = new FileSourceScopeAuthority({ registryPath, readRegistry: () => ({ version: 1, handles: [] }) });
    const env = {
      // The store goes where its layout puts it, under a home of its own.
      HOME: join(base, 'olympus-home'),
      [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(base, 'no-exclusions.json'),
    };
    const policy = defaultLocalFilesIngestionPolicy({ stillImagesRead: false });
    const store = createLocalFilesConnectorStore(env, { policy });
    const jobs = new LocalFileExtractionJobStore(':memory:');
    cleanups.push(() => { jobs.close(); store.close(); rmSync(base, { recursive: true, force: true }); });

    // Nothing is connected: there is nothing to read.
    expect(authority.policyRef(LOCAL_FILES_SOURCE_ID)).toBeUndefined();

    // Connect needs no sign-in; the owner then chooses folders. Until then, still nothing.
    connectThisComputerSource(registryPath, LOCAL_FILES_SOURCE_ID);
    const pending = authority.snapshot(LOCAL_FILES_SOURCE_ID);
    expect(pending).toMatchObject({ status: 'scope_pending' });
    expect(pending.selections).toEqual([]);
    authority.approve({
      sourceId: LOCAL_FILES_SOURCE_ID,
      accountGeneration: pending.accountGeneration!,
      expectedRevision: pending.revision,
      selections: [{ key: proj, state: 'ingest' }],
      wholeAccount: false,
      explicitWholeAccountConfirmation: false,
    });
    const ref = authority.policyRef(LOCAL_FILES_SOURCE_ID)!;
    expect(ref).toBeDefined();

    const context: DefaultExclusionContext = { ...defaultExclusionContext({}), home, syncedRoots: [] };
    const scope = createScopeBoundLocalFilesContentScope({ authority, ref, context });
    const volumes = new VolumeResolver();
    const providerSync = createLocalFilesProviderStoreSyncHandler({
      store, tierSet: localFilesTestTierSet(store), scope, volumes, snapshotDir: join(base, 'watch'),
    });
    const approvedPolicy = fileSourceScopeLocalFilesPolicy(policy, authority.assertCurrent(ref));
    expect(approvedPolicy.roots.map((root) => root.path)).toEqual([proj]);
    const source = createLocalFilesSchedulerSource({
      policy: approvedPolicy, config: defaultConfig(), providerSync, store,
    })!;
    const syncTask = source.tasks.find((task) => task.kind === 'sync')!;

    // The extraction lane: the connector's own reader, the shared runner and sink.
    const lane = {
      corpusId: LOCAL_FILES_CORPUS_ID,
      provider: LOCAL_FILES_PROVIDER,
      accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
      approvedScopeKey: approvedPolicy.roots[0]!.approved_scope_key,
    };
    const connector = createLocalFilesSourceConnector({
      connectorId: 'local.files.extraction', root: '/', scope, volumes,
      locate: (localItemId) => store.localContent(localItemId)?.locatorUri,
    });
    const extractor: Extractor = {
      kind: 'plain_text_fixture', version: 'test', input: { kind: 'bytes', maxInputBytes: Number.MAX_SAFE_INTEGER }, egress: 'local', accepts: () => true,
      async extract(input) {
        const text = new TextDecoder().decode(input.bytes);
        return { status: 'indexed', text, derivations: [{ artifactKind: 'document', chars: text.length }] };
      },
    };
    const runner = createFileExtractionRunner({
      jobs,
      registry: buildExtractorRegistry([extractor], ['plain_text_fixture']),
      corpora: [{
        corpusId: LOCAL_FILES_CORPUS_ID,
        trustDomain: 'secure_local',
        source: createConnectorFileExtractionSource({
          id: `${LOCAL_FILES_CORPUS_ID}:extraction`,
          corpusId: LOCAL_FILES_CORPUS_ID,
          provider: LOCAL_FILES_PROVIDER,
          connector,
          candidates: connectorStoreExtractionCandidateReader(store),
          lanes: [{ approvedScopeKey: lane.approvedScopeKey }],
        }),
        sink: createTieredStoreExtractionSink({
          set: localFilesTestTierSet(store),
          syncConnectorId: 'file-extraction-factory',
          ownerConnectorId: LOCAL_FILES_PROVIDER,
          ownershipKind: 'observed',
          claims: jobs,
        }),
      }],
    });
    const found = (query: string): string[] =>
      store.searchItems(query, 20, LOCAL_FILES_ACCOUNT_SCOPE).map((row) => String(row.title ?? '')).sort();

    // Sync: the files are listed by name, then read through the scope-safe reader.
    await syncTask.run();
    expect(found('harbour')).toEqual(['harbour.txt']);
    expect((await runner.plan({ ...lane, limit: 20 })).jobsQueued).toBe(2);
    expect((await runner.run({ ...lane })).counts.indexed).toBe(2);
    expect(found('tides')).toEqual(['harbour.txt']);
    expect(found('tomatoes')).toEqual(['garden.txt']);

    // An edit is found by the next pass and read again; the old words go.
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(proj, 'harbour.txt'), 'the lighthouse keeper writes a diary of storms');
    await syncTask.run();
    expect((await runner.plan({ ...lane, limit: 20 })).jobsQueued).toBe(1);
    await runner.run({ ...lane });
    expect(found('storms')).toEqual(['harbour.txt']);
    expect(found('tides')).toEqual([]);

    // A deletion removes the file from the index.
    unlinkSync(join(proj, 'garden.txt'));
    await syncTask.run();
    expect(found('tomatoes')).toEqual([]);
    expect(found('storms')).toEqual(['harbour.txt']);

    // A file outside the chosen folder is never listed or read.
    writeFileSync(join(home, 'outside.txt'), 'private ledger elsewhere');
    await syncTask.run();
    expect(found('elsewhere')).toEqual([]);

    // Disconnect stops the lane and keeps the index; reconnecting starts at "choose folders" again.
    expect(disconnectThisComputerSource(registryPath, LOCAL_FILES_SOURCE_ID)).toBe(true);
    expect(authority.policyRef(LOCAL_FILES_SOURCE_ID)).toBeUndefined();
    expect(() => scope.assertCurrent()).toThrow();
    expect(found('storms')).toEqual(['harbour.txt']);
    await expect(syncTask.run()).rejects.toThrow();
  }, 30_000);

  for (const deleteAtRestart of [true, false]) test(`reconnect after ${deleteAtRestart ? 'deleting at restart' : 'keeping data'} indexes files under the new approval`, async () => {
    enableSourceRegistryAdoption();
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'local-files-reconnect-')));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const home = join(base, 'home');
    const folder = join(home, 'notes');
    mkdirSync(folder, { recursive: true });
    const files = ['harbour', 'garden', 'lighthouse'];
    const writeFiles = (modifiedAt: string) => {
      for (const name of files) {
        const path = join(folder, `${name}.txt`);
        writeFileSync(path, `${name} records the seasonal weather`);
        utimesSync(path, new Date(modifiedAt), new Date(modifiedAt));
      }
    };
    writeFiles('2026-11-01');
    const registryPath = join(base, 'handles.json');
    writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
    const env = {
      HOME: join(base, 'olympus-home'),
      [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(base, 'no-exclusions.json'),
    };
    const context = { env, homeDir: env.HOME, handleRegistryPath: registryPath };
    const authority = new FileSourceScopeAuthority({ registryPath, readRegistry: () => ({ version: 1, handles: [] }) });
    const policy = defaultLocalFilesIngestionPolicy({ stillImagesRead: false });
    const approve = (now: string) => {
      connectThisComputerSource(registryPath, LOCAL_FILES_SOURCE_ID, new Date(now));
      const pending = authority.snapshot(LOCAL_FILES_SOURCE_ID);
      expect(pending.status).toBe('scope_pending');
      authority.approve({
        sourceId: LOCAL_FILES_SOURCE_ID, accountGeneration: pending.accountGeneration!,
        expectedRevision: pending.revision, selections: [{ key: folder, state: 'ingest' }],
        wholeAccount: false, explicitWholeAccountConfirmation: false,
      });
      return authority.policyRef(LOCAL_FILES_SOURCE_ID)!;
    };
    type Storage = {
      store: ReturnType<typeof createLocalFilesConnectorStore>;
      tierLane: ReturnType<typeof createLocalFilesTierLane>;
      jobs: LocalFileExtractionJobStore;
    };
    const open = (ref: NonNullable<ReturnType<typeof authority.policyRef>>, existing?: Storage) => {
      const store = existing?.store ?? createLocalFilesConnectorStore(env, { policy });
      const tierLane = existing?.tierLane ?? createLocalFilesTierLane({
        secureStore: store, env, policy,
        tierClassification: {
          sniffer: { id: 'test.personal', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary' }) },
        },
      });
      const tiers = tierLane.set;
      const view = tieredExtractionView(tiers);
      const jobs = existing?.jobs ?? new LocalFileExtractionJobStore(join(base, 'extraction.sqlite'));
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        jobs.close();
        for (const domain of TIER_DOMAIN_ORDER) tiers.store(domain)?.close();
        tierLane.ledger.close();
      };
      if (!existing) cleanups.push(close);
      const scope = createScopeBoundLocalFilesContentScope({
        authority, ref, context: { ...defaultExclusionContext({}), home, syncedRoots: [] },
      });
      const volumes = new VolumeResolver();
      // An unchanged replay returns no events: a new approval must walk again.
      const hub = new WatchHub({
        load: async () => ({
          subscribe: async () => ({ unsubscribe: async () => {} }),
          writeSnapshot: async (_root, path) => { writeFileSync(path, 'snapshot'); return path; },
          getEventsSince: async () => [],
        }),
      });
      cleanups.push(() => hub.close());
      const snapshotDir = localFilesWatchDir(env);
      mkdirSync(snapshotDir, { recursive: true });
      const providerSync = createLocalFilesProviderStoreSyncHandler({
        store, tierSet: tiers, scope, volumes, hub, snapshotDir,
      });
      const approvedPolicy = fileSourceScopeLocalFilesPolicy(policy, authority.assertCurrent(ref));
      const source = createLocalFilesSchedulerSource({ policy: approvedPolicy, config: defaultConfig(), providerSync, store })!;
      const lane = {
        corpusId: LOCAL_FILES_CORPUS_ID, provider: LOCAL_FILES_PROVIDER,
        accountScope: LOCAL_FILES_ACCOUNT_SCOPE, approvedScopeKey: approvedPolicy.roots[0]!.approved_scope_key,
      };
      const metadata = fileSourceScopeMetadataFilters(authority.snapshot(LOCAL_FILES_SOURCE_ID));
      const content = fileSourceScopeContentFilters(authority.snapshot(LOCAL_FILES_SOURCE_ID));
      if (!metadata.allowed || !content.allowed) throw new Error('Expected an approved folder');
      const connector = createLocalFilesSourceConnector({
        connectorId: 'local.files.extraction', root: '/', scope, volumes,
        locate: (id) => view.localContent(id)?.locatorUri,
      });
      const extractor: Extractor = {
        kind: 'plain_text_fixture', version: 'test',
        input: { kind: 'bytes', maxInputBytes: Number.MAX_SAFE_INTEGER }, egress: 'local', accepts: () => true,
        async extract(input) {
          const text = new TextDecoder().decode(input.bytes);
          return { status: 'indexed', text, derivations: [{ artifactKind: 'document', chars: text.length }] };
        },
      };
      const runner = createFileExtractionRunner({
        jobs, registry: buildExtractorRegistry([extractor], ['plain_text_fixture']),
        corpora: [{
          corpusId: lane.corpusId, trustDomain: 'secure_local',
          source: createConnectorFileExtractionSource({
            id: `${lane.corpusId}:extraction`, corpusId: lane.corpusId, provider: lane.provider, connector,
            candidates: connectorStoreExtractionCandidateReader(view, content.filters),
            lanes: [{ approvedScopeKey: lane.approvedScopeKey }],
          }),
          sink: createTieredStoreExtractionSink({
            set: tiers, syncConnectorId: 'file-extraction-factory',
            ownerConnectorId: LOCAL_FILES_PROVIDER, ownershipKind: 'observed', claims: jobs,
          }),
        }],
      });
      return {
        storage: { store, tierLane, jobs }, close, scope, runner, lane,
        metadataFilters: metadata.filters,
        candidates: (filters = metadata.filters) => view.extractionCandidates({ limit: 20, filters }).candidates,
        found: () => TIER_DOMAIN_ORDER.flatMap((domain) => tiers.store(domain)?.searchItems(
          'seasonal', 20, lane.accountScope, content.filters,
        ) ?? []),
        sync: () => source.tasks.find((task) => task.kind === 'sync')!.run(),
        status: () => ({ counts: { items: TIER_DOMAIN_ORDER.reduce((sum, domain) =>
          sum + (tiers.store(domain)?.status({
            accountScope: lane.accountScope, itemFilters: metadata.filters,
            ...(content.filters ? { contentFilters: content.filters } : {}),
          }).counts.items ?? 0), 0) } }),
      };
    };

    const firstRef = approve('2026-11-01T00:00:00.000Z');
    const first = open(firstRef);
    await first.sync();
    expect(first.status().counts.items).toBe(files.length);
    expect((await first.runner.plan({ ...first.lane, limit: 20 })).jobsQueued).toBe(files.length);
    expect((await first.runner.run(first.lane)).counts.indexed).toBe(files.length);
    expect(first.found()).toHaveLength(files.length);
    expect(await first.sync()).toMatchObject({ counts: { full_listing: 0, items_seen: 0 } });

    // The release check loses the folder before Disconnect and Delete.
    renameSync(folder, `${folder}-away`);
    await expect(first.sync()).rejects.toMatchObject({ errorKind: 'scope_root_missing' });
    expect(disconnectThisComputerSource(registryPath, LOCAL_FILES_SOURCE_ID)).toBe(true);
    expect(() => first.scope.assertCurrent()).toThrow();
    if (deleteAtRestart) {
      expect(deleteOlympusDataWithCustody({
        ...context, sourceId: LOCAL_FILES_SOURCE_ID, applyAtRestart: true,
        connectedRegistry: { version: 1, handles: [] }, thisComputerSources: [],
      })).toMatchObject({ ok: true, pending: true });
      first.close();
      expect(deleteMarkedAccounts(context)).toMatchObject({ deleted: [{ sourceId: LOCAL_FILES_SOURCE_ID }], failed: [] });
    }

    renameSync(`${folder}-away`, folder);
    // Delete must also clear settled jobs for byte-identical file versions.
    // Kept data gets a new version, as the release check's rewrite would.
    writeFiles(deleteAtRestart ? '2026-11-01' : '2026-11-03');
    const secondRef = approve('2026-11-02T00:00:00.000Z');
    expect(secondRef.accountGeneration).not.toBe(firstRef.accountGeneration);
    expect(secondRef.revision).not.toBe(firstRef.revision);
    const second = open(secondRef, deleteAtRestart ? undefined : first.storage);
    expect(second.status().counts.items).toBe(0);
    expect(await second.sync()).toMatchObject({ counts: { full_listing: 1, items_seen: files.length } });
    expect(second.status().counts.items).toBe(files.length);
    expect(second.candidates(first.metadataFilters)).toHaveLength(0);
    expect((await second.runner.plan({ ...second.lane, limit: 20 })).jobsQueued).toBe(files.length);
    expect((await second.runner.run(second.lane)).counts.indexed).toBe(files.length);
    expect(second.status().counts.items).toBe(files.length);
    expect(second.found()).toHaveLength(files.length);
  }, 30_000);
});
