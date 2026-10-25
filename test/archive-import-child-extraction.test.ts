// Reading child items later, through the real archive import, tier set,
// extraction runtime and runner, with the fixture connector standing in for
// every format (docs/design/child-items.md, "Reading later"): the locator is
// read fresh from the store on every fetch and never kept in a job, a child
// over a bytes reader's limit is listed and never read, a file reader gets a
// scratch file that is removed, each archive's items are read by that
// archive's own connector under the provider each row carries, and an archive
// being removed is no longer served: nothing is offered, read or landed.

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { archiveCorpusId, getArchiveFormat, type ArchiveConnectorFactory } from '../src/core/archive-formats.ts';
import { accountFolder, extractionSpoolRoot } from '../src/core/olympus-layout.ts';
import { extractionSpoolRootForCorpus } from '../src/core/source-placement.ts';
import type { SourceConnector } from '../src/core/contracts.ts';
import { ARCHIVE_EXTRACTION_PROVIDER, ARCHIVE_EXTRACTION_SCOPE_KEY, archiveFileExtractionCorpora, archiveFileExtractionSourceFactory } from '../src/workers/archive-import/extraction-source.ts';
import { requestArchiveRemoval, runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { archiveConnectorStoreDbPath } from '../src/workers/archive-import/store.ts';
import { tieredExtractionView } from '../src/workers/connector-store/tiered-extraction.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { buildExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import { createFileExtractionRunner } from '../src/workers/file-extraction/runner.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import type { Extractor } from '../src/workers/file-extraction/types.ts';
import { childProviderItemId, createFixtureChildConnector, fixtureLocalItemId, type FixtureParentSpec } from './helpers/child-items-fixture.ts';
import { childItemsArchiveHarness, FIXTURE_ARCHIVE_FORMAT } from './support/child-items-archive-harness.ts';
import { childItemsExtraction } from './support/child-items-extraction-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;

function lease(): FixtureParentSpec[] {
  return [{
    id: 'm1', subject: 'Flat', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z', body: 'Please find the lease attached.',
    children: [
      { key: 'p1', name: 'lease.txt', mimeType: 'text/plain', text: 'The lease term is thirty-seven months.' },
      { key: 'p2', name: 'notes.txt', mimeType: 'text/plain', text: 'Remember the deposit.' },
      { key: 'p3', name: 'gone.txt', mimeType: 'text/plain', text: 'never read', available: false },
    ],
  }];
}

function childRows(archiveId: string, h: ReturnType<typeof childItemsArchiveHarness>) {
  return h.rows(archiveId).filter((row) => row.providerItemId.includes('#child:'));
}

describe('reading child items later', () => {
  test('a child is read from the locator the store keeps now, and no job keeps it', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    await h.importAll(archiveId, lease());
    expect(h.log.fetches).toEqual([]);

    const ext = childItemsExtraction(h, cleanups, { parents: lease() });
    const planned = await ext.runtime.runner.plan({ ...ext.lane(archiveId), limit: 50 });
    // The unavailable child is never offered; the two readable ones are.
    expect(planned.jobsQueued).toBe(2);
    expect(ext.jobs(archiveId).map((job) => job.providerItemId)).not.toContain(childProviderItemId('m1', 'p3'));

    // A restart in between: nothing but the store and the job file remain.
    ext.close();
    const again = childItemsExtraction(h, cleanups, { parents: lease(), runtime: { jobsDbPath: ext.jobsDbPath } });
    const run = await again.runtime.runner.run(again.lane(archiveId));
    expect(run.counts.indexed).toBe(2);

    // The names row keeps the locator; the row the text landed in carries none.
    const stored = new Map(childRows(archiveId, h).filter((row) => row.locator !== null).map((row) => [row.providerItemId, row.locator]));
    expect(h.log.fetches).toHaveLength(2);
    for (const fetch of h.log.fetches) {
      const providerItemId = fetch.localItemId.slice(`${archiveId}:`.length);
      expect(fetch.locator).toBe(stored.get(providerItemId)!);
      expect(fetch.refused).toBeUndefined();
    }
    expect(h.log.fetches.some((fetch) => fetch.localItemId.endsWith('#child:p3'))).toBe(false);
    // The text landed in the child, and the locator is in no job row.
    const after = new Map<string, number>();
    for (const row of childRows(archiveId, h)) after.set(row.providerItemId, (after.get(row.providerItemId) ?? 0) + row.chunks);
    expect(after.get(childProviderItemId('m1', 'p1'))).toBeGreaterThan(0);
    expect(after.get(childProviderItemId('m1', 'p2'))).toBeGreaterThan(0);
    expect(after.get(childProviderItemId('m1', 'p3'))).toBe(0);
    expect(again.jobsFileText()).not.toContain('fixture-locator');
  });

  test('a child the source says is no longer readable is not read even if it was queued when it was', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    await h.importAll(archiveId, lease());
    const ext = childItemsExtraction(h, cleanups, { parents: lease() });
    expect((await ext.runtime.runner.plan({ ...ext.lane(archiveId), limit: 50 })).jobsQueued).toBe(2);

    // The store learns, after planning, that the bytes of one child are gone.
    for (const domain of ['public_safe', 'internal', 'secure_local'] as const) {
      const path = archiveConnectorStoreDbPath(domain, format.family, h.env);
      if (!existsSync(path)) continue;
      const edit = new Database(path);
      edit.query('UPDATE items SET bytes_available = 0 WHERE provider_item_id = ?').run(childProviderItemId('m1', 'p2'));
      edit.close();
    }

    const run = await ext.runtime.runner.run(ext.lane(archiveId));
    expect(run.counts.indexed).toBe(1);
    const fetched = h.log.fetches.map((fetch) => fetch.localItemId);
    expect(fetched).toEqual([fixtureLocalItemId(archiveId, childProviderItemId('m1', 'p1'))]);
    expect(ext.jobs(archiveId).find((job) => job.providerItemId.endsWith('#child:p2'))?.status).toBe('skipped_unsupported');
  });

  test('a child over a bytes reader\'s limit is listed and never read', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    const parents: FixtureParentSpec[] = [{
      id: 'm1', subject: 'Big', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z', body: 'A very large attachment.',
      children: [
        { key: 'huge', name: 'huge.txt', mimeType: 'text/plain', text: 'x', declaredSizeBytes: 300 * 1024 * 1024 },
        { key: 'small', name: 'small.txt', mimeType: 'text/plain', text: 'a small note about tides' },
      ],
    }];
    await h.importAll(archiveId, parents);
    const ext = childItemsExtraction(h, cleanups, { parents });
    const { queued, skippedTooLarge, run } = await ext.drive(archiveId);
    // The large one is recorded as too large when planned; only the small one is queued.
    expect(queued).toBe(1);
    expect(skippedTooLarge).toBe(1);
    expect(run.counts.indexed).toBe(1);
    const jobs = new Map(ext.jobs(archiveId).map((job) => [job.providerItemId, job.status]));
    expect(jobs.get(childProviderItemId('m1', 'huge'))).toBe('skipped_too_large');
    expect(jobs.get(childProviderItemId('m1', 'small'))).toBe('indexed');
    // The connector was asked for the small one only: the large one was never read.
    expect(h.log.fetches.map((fetch) => fetch.localItemId)).toEqual([fixtureLocalItemId(archiveId, childProviderItemId('m1', 'small'))]);
    // It is still listed by name, with its stated size.
    const huge = childRows(archiveId, h).find((row) => row.providerItemId.endsWith('#child:huge'))!;
    expect(huge.size).toBe(300 * 1024 * 1024);
  });

  test('items of different archives are read by their own connector under the provider each row carries', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const first = h.start('A.mbox');
    const second = h.start('B.mbox');
    const parentsOf = (text: string): FixtureParentSpec[] => [{
      id: 'm1', subject: 'Hello', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z', body: 'See attached.',
      children: [{ key: 'p1', name: 'note.txt', mimeType: 'text/plain', text }],
    }];
    const bySpec = (archiveId: string): FixtureParentSpec[] => parentsOf(archiveId === first ? 'alpha words' : 'bravo words');
    await h.importAll(first, bySpec(first));
    await h.importAll(second, bySpec(second));

    const ext = childItemsExtraction(h, cleanups, { parents: bySpec });
    expect((await ext.drive(first)).run.counts.indexed).toBe(1);
    expect((await ext.drive(second)).run.counts.indexed).toBe(1);
    // Each archive's job carries its row's provider, never the roster's.
    for (const job of ext.jobs()) {
      expect(job.provider).toBe(format.provider);
      expect(job.provider).not.toBe(ARCHIVE_EXTRACTION_PROVIDER);
    }
    expect(h.log.fetches.map((fetch) => fetch.localItemId).sort()).toEqual([
      fixtureLocalItemId(first, childProviderItemId('m1', 'p1')),
      fixtureLocalItemId(second, childProviderItemId('m1', 'p1')),
    ].sort());
    for (const archiveId of [first, second]) {
      expect(childRows(archiveId, h).reduce((total, row) => total + row.chunks, 0)).toBeGreaterThan(0);
    }
  });
});

// A runner with a reader of our own, over the same archive source and tier-set
// sink the runtime builds, to prove the bounds the registry's real readers set
// too large to exercise with real bytes.
/** Where the production runtime puts the scratch files of the archive family's Private corpus. */
function archiveSpoolRoot(h: ReturnType<typeof childItemsArchiveHarness>): string {
  return extractionSpoolRootForCorpus({
    corpusId: archiveCorpusId('secure_local', format.family),
    trustDomain: 'secure_local',
    storePath: archiveConnectorStoreDbPath('secure_local', format.family, h.env),
  }, h.env);
}

/** A process id that has ended: a child that ran and exited. */
function deadPid(): number {
  return Bun.spawnSync(['true']).pid;
}

function runnerWith(
  h: ReturnType<typeof childItemsArchiveHarness>,
  extractor: Extractor,
  parentsOf: (archiveId: string) => FixtureParentSpec[],
  options: { spoolDir?: string; onFetch?: (localItemId: string) => void | Promise<void>; bounded?: boolean } = {},
) {
  const lane = h.runtime.lane(format.family);
  const secure = lane.set.store('secure_local', { create: true })!;
  const corpusId = archiveCorpusId('secure_local', format.family);
  const view = tieredExtractionView(lane.set, { home: 'secure_local' });
  const jobs = new LocalFileExtractionJobStore(':memory:');
  const spoolDir = options.spoolDir ?? join(h.base, 'spool');
  const connectorFactory = (): ArchiveConnectorFactory => (input): SourceConnector => createFixtureChildConnector({
    accountScope: input.accountScope, provider: format.provider, family: format.family, id: input.connectorId,
    parents: parentsOf(input.archiveId), log: h.log,
    ...(options.onFetch ? { onFetch: options.onFetch } : {}),
    ...(options.bounded !== undefined ? { bounded: options.bounded } : {}),
  });
  const [config] = archiveFileExtractionCorpora({ state: h.runtime.state, families: [format.family] });
  const source = archiveFileExtractionSourceFactory({ state: h.runtime.state, connectorFactory })({ config: config!, store: secure, view });
  const runner = createFileExtractionRunner({
    jobs,
    registry: buildExtractorRegistry([extractor], [extractor.kind]),
    spoolDir,
    corpora: [{
      corpusId,
      trustDomain: 'secure_local',
      source,
      sink: createTieredStoreExtractionSink({
        set: lane.set, home: 'secure_local', syncConnectorId: 'file-extraction-factory', ownerConnectorId: 'archive.imports', ownershipKind: 'observed', claims: jobs,
      }),
      refusesImageContent: (ref) => view.refusesImageContent(ref.localItemId),
      trustTiers: { itemTrustTier: (ref) => view.itemTrustTier(ref.localItemId) },
    }],
  });
  cleanups.push(() => jobs.close());
  const key = (archiveId: string) => ({ corpusId, provider: format.provider, accountScope: archiveId, approvedScopeKey: ARCHIVE_EXTRACTION_SCOPE_KEY });
  return { runner, jobs, spoolDir, key };
}

describe('reading within a reader\'s declared input', () => {
  test('a size the source stated wrongly is caught by a bounded read, which takes one byte past the limit and no more', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    const parents: FixtureParentSpec[] = [{
      id: 'm1', subject: 'Liar', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z', body: 'x',
      children: [{ key: 'p1', name: 'liar.txt', mimeType: 'text/plain', text: 'y'.repeat(100), declaredSizeBytes: 5 }],
    }];
    await h.importAll(archiveId, parents);
    const extractor: Extractor = {
      kind: 'tiny_reader', version: 'test', input: { kind: 'bytes', maxInputBytes: 16 }, egress: 'local', accepts: () => true,
      async extract(input) {
        const text = new TextDecoder().decode(input.bytes);
        return { status: 'indexed', text, derivations: [{ artifactKind: 'document', chars: text.length }] };
      },
    };
    const { runner, jobs, key } = runnerWith(h, extractor, () => parents);
    expect((await runner.plan({ ...key(archiveId), limit: 10 })).jobsQueued).toBe(1);
    const run = await runner.run(key(archiveId));
    expect(run.counts.indexed).toBe(0);
    expect(h.log.fetches).toHaveLength(1);
    expect(h.log.fetches[0]).toMatchObject({ maxBytes: 16, bytesRead: 17 });
    expect(jobs.counts(key(archiveId)).find((count) => count.status === 'skipped_too_large')?.jobs).toBe(1);
  });

  test('a file reader is handed a scratch file inside the spool, and it is removed after the read', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    const parents = lease();
    await h.importAll(archiveId, parents);
    let seen: { path: string; text: string } | undefined;
    const extractor: Extractor = {
      kind: 'file_reader', version: 'test', input: { kind: 'file' }, egress: 'local', accepts: () => true,
      async extract(input) {
        const path = input.localPath!;
        const text = readFileSync(path, 'utf8');
        seen = { path, text };
        return { status: 'indexed', text, derivations: [{ artifactKind: 'document', chars: text.length }] };
      },
    };
    const { runner, spoolDir, key } = runnerWith(h, extractor, () => parents);
    await runner.plan({ ...key(archiveId), limit: 10 });
    const run = await runner.run(key(archiveId));
    expect(run.counts.indexed).toBe(2);
    expect(seen).toBeDefined();
    expect(seen!.path.startsWith(spoolDir)).toBe(true);
    expect(h.log.spooled.length).toBe(2);
    // Nothing is left in the spool, and none of the bytes were read into the connector's answer.
    for (const path of h.log.spooled) expect(existsSync(path)).toBe(false);
    expect(existsSync(spoolDir) ? readdirSync(spoolDir) : []).toEqual([]);
  });
});

/** Every file under a folder, as paths relative to it. */
function filesIn(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesIn(path, `${prefix}${name}/`) : [`${prefix}${name}`];
  });
}

describe('a scratch file has an owner', () => {
  test('a read that dies leaves its file under its archive, and removing the archive removes it and no other archive\'s', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const first = h.start('First.mbox');
    const second = h.start('Second.mbox');
    const parents = lease();
    await h.importAll(first, parents);
    await h.importAll(second, parents);

    // A reader that never returns: the process died mid-transcription, with the recording on disk.
    const started: string[] = [];
    const extractor: Extractor = {
      kind: 'dying_file_reader', version: 'test', input: { kind: 'file' }, egress: 'local', accepts: () => true,
      async extract(input) {
        started.push(input.localPath!);
        await new Promise<never>(() => {});
        throw new Error('unreachable');
      },
    };
    // Where the production runtime puts a corpus's scratch files: the archive account's own folder.
    const spoolRoot = archiveSpoolRoot(h);
    expect(spoolRoot).toBe(join(accountFolder({ source_id: 'archive.imports', slot: '1' }, h.env), 'raw', 'extraction-spool'));
    const { runner, key } = runnerWith(h, extractor, () => parents, { spoolDir: spoolRoot });
    for (const archiveId of [first, second]) await runner.plan({ ...key(archiveId), limit: 10 });
    void runner.run(key(first));
    void runner.run(key(second));
    while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(filesIn(spoolRoot)).toHaveLength(2);
    expect(readFileSync(started[0]!, 'utf8').length).toBeGreaterThan(0);

    // The first archive is removed: its raw scratch file goes with it; the second archive's stays.
    requestArchiveRemoval(h.runtime.state, first);
    const lane = h.runtime.lane(format.family);
    let outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId: first });
    while (outcome.kind === 'progress') outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId: first });
    expect(outcome.kind).toBe('removed');
    const left = started.filter((path) => existsSync(path));
    expect(left).toHaveLength(1);
    expect(filesIn(spoolRoot)).toHaveLength(1);
    // Nothing of an account in its folder is written to the folder legacy accounts share.
    expect(existsSync(extractionSpoolRoot(h.env))).toBe(false);
  }, 30_000);

  // The bytes are fetched in memory and written after (the format's connector writes no file), or the
  // format's connector writes the file itself before its fetch returns.
  for (const ownWrites of [false, true]) {
    test(`a removal that lands while the bytes are being fetched leaves no scratch file, even if the worker then dies (${ownWrites ? 'the connector writes the file' : 'the bytes are written after the fetch'})`, async () => {
      const h = childItemsArchiveHarness(cleanups);
      const archiveId = h.start();
      const parents = lease();
      await h.importAll(archiveId, parents);

      let reading!: () => void;
      const started = new Promise<void>((resolve) => { reading = resolve; });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let fetches = 0;
      // The reader never returns: nothing disposes the file it is handed (a crash).
      let handed = 0;
      const extractor: Extractor = {
        kind: 'never_returning_file_reader', version: 'test', input: { kind: 'file' }, egress: 'local', accepts: () => true,
        async extract() {
          handed += 1;
          await new Promise<never>(() => {});
          throw new Error('unreachable');
        },
      };
      const spoolRoot = archiveSpoolRoot(h);
      const { runner, key } = runnerWith(h, extractor, () => parents, {
        spoolDir: spoolRoot,
        bounded: ownWrites,
        onFetch: async () => {
          fetches += 1;
          if (fetches > 1) return;
          reading();
          await held;
        },
      });
      await runner.plan({ ...key(archiveId), limit: 10 });
      void runner.run(key(archiveId));
      await started;

      // The archive is removed while the first item's bytes are being fetched.
      if (!ownWrites) expect(filesIn(spoolRoot)).toEqual([]);
      requestArchiveRemoval(h.runtime.state, archiveId);
      const lane = h.runtime.lane(format.family);
      let outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId });
      while (outcome.kind === 'progress') outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId });
      expect(outcome.kind).toBe('removed');
      expect(h.runtime.state.get(archiveId)).toBeUndefined();

      release();
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The fetch finished after the removal: no reader was handed a file, and no raw file or owner folder is left.
      expect(handed).toBe(0);
      expect(filesIn(spoolRoot)).toEqual([]);
      expect(existsSync(spoolRoot) ? readdirSync(spoolRoot) : []).toEqual([]);
    }, 30_000);
  }

  test('the production runtime keeps the archive account\'s scratch files in its folder, and sweeps what a dead process left there at start', async () => {
    const h = childItemsArchiveHarness(cleanups);
    await h.importAll(h.start(), lease());
    const root = archiveSpoolRoot(h);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const orphan = join(root, `spool-${deadPid()}-${Date.now()}-abc`);
    const running = join(root, `spool-${process.pid}-${Date.now()}-def`);
    writeFileSync(orphan, 'raw bytes');
    writeFileSync(running, 'raw bytes');

    childItemsExtraction(h, cleanups, { parents: lease() });

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(running)).toBe(true);
    expect(existsSync(extractionSpoolRoot(h.env))).toBe(false);
  }, 30_000);
});

describe('an archive being removed is no longer served', () => {
  test('it offers no candidate and nothing is read for it', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    await h.importAll(archiveId, lease());
    const ext = childItemsExtraction(h, cleanups, { parents: lease() });
    expect((await ext.runtime.runner.plan({ ...ext.lane(archiveId), limit: 50 })).jobsQueued).toBe(2);
    requestArchiveRemoval(h.runtime.state, archiveId);
    // Nothing more is offered, and what was queued settles unread.
    const replan = await ext.runtime.runner.plan({ ...ext.lane(archiveId), limit: 50 });
    expect(replan.candidates).toBe(0);
    const run = await ext.runtime.runner.run(ext.lane(archiveId));
    expect(run.counts.indexed).toBe(0);
    expect(h.log.fetches).toEqual([]);
  });

  test('removal in the middle of a read lands nothing, and the extraction rows go with the archive', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    const parents = lease();
    await h.importAll(archiveId, parents);

    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ext = childItemsExtraction(h, cleanups, {
      parents,
      connector: {
        onFetch: async () => {
          reading();
          await held;
        },
      },
    });
    expect((await ext.runtime.runner.plan({ ...ext.lane(archiveId), limit: 50 })).jobsQueued).toBe(2);
    const running = ext.runtime.runner.run(ext.lane(archiveId));
    await started;

    // The archive is removed while the read waits at the connector.
    requestArchiveRemoval(h.runtime.state, archiveId);
    const lane = h.runtime.lane(format.family);
    let outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId });
    while (outcome.kind === 'progress') outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId });
    expect(outcome.kind).toBe('removed');
    expect(h.runtime.state.get(archiveId)).toBeUndefined();
    expect(ext.jobs(archiveId)).toEqual([]);

    release();
    await running;
    // Nothing landed: no item, no chunk, no job, no artifact of the archive anywhere.
    expect(h.rows(archiveId)).toEqual([]);
    expect(ext.jobs(archiveId)).toEqual([]);
    const db = new Database(ext.jobsDbPath, { readonly: true });
    try {
      expect((db.query('SELECT COUNT(*) AS n FROM extraction_artifacts').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  test('removing one archive leaves another archive\'s extraction rows alone', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const first = h.start('A.mbox');
    const second = h.start('B.mbox');
    const parents = lease();
    await h.importAll(first, parents);
    await h.importAll(second, parents);
    const ext = childItemsExtraction(h, cleanups, { parents });
    await ext.drive(first);
    await ext.drive(second);
    const before = ext.jobs(second).length;
    expect(before).toBeGreaterThan(0);

    requestArchiveRemoval(h.runtime.state, first);
    const lane = h.runtime.lane(format.family);
    let outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId: first });
    while (outcome.kind === 'progress') outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId: first });
    expect(outcome.kind).toBe('removed');
    expect(ext.jobs(first)).toEqual([]);
    expect(ext.jobs(second)).toHaveLength(before);
    expect(childRows(second, h).some((row) => row.chunks > 0)).toBe(true);
  });
});
