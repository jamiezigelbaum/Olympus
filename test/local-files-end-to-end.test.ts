// A folder on this computer, from Connect to an answer and back out again:
// connect (no sign-in), approve a folder, the scheduler's sync task lists it,
// the shared extraction runner reads the text through the connector's own
// scope-safe reader, an edit is read again, a deletion removes the file, and
// disconnecting stops the lane while keeping what is indexed.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import { defaultLocalFilesIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { connectThisComputerSource, disconnectThisComputerSource } from '../src/core/this-computer.ts';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { connectorStoreExtractionCandidateReader } from '../src/workers/email-source/file-extraction-runtime.ts';
import { createConnectorFileExtractionSource } from '../src/workers/file-extraction/connector-source.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { buildExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import { createFileExtractionRunner } from '../src/workers/file-extraction/runner.ts';
import { createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
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
} from '../src/workers/local-files/store.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';

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
      store, scope, volumes, snapshotDir: join(base, 'watch'),
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
        sink: createConnectorStoreExtractionSink({
          store,
          classify: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
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
});
