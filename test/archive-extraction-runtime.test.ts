// The archive lanes' extraction runtime and its scheduler tasks
// (docs/design/child-items.md, "Reading later"), as the product wires them:
// built over the archive runtime's lanes, rebuilt when a lane's stores
// change, serialized with the import and the removal, and reading a child the
// import listed by name through the same factory every source uses. The
// fixture connector stands in for every format. Synthetic data only.

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { archiveCorpusId, getArchiveFormat, type ArchiveConnectorFactory } from '../src/core/archive-formats.ts';
import type { SourceConnector } from '../src/core/contracts.ts';
import { defaultConfig } from '../src/core/config.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import { createArchiveExtractionRuntime } from '../src/workers/archive-import/extraction-runtime.ts';
import {
  archiveExtractionTaskId,
  ARCHIVE_IMPORTS_CONCURRENCY_KEY,
  createArchiveImportsSchedulerSource,
} from '../src/workers/archive-import/scheduler-source.ts';
import { childProviderItemId, createFixtureChildConnector, type FixtureParentSpec } from './helpers/child-items-fixture.ts';
import { childItemsArchiveHarness, FIXTURE_ARCHIVE_FORMAT } from './support/child-items-archive-harness.ts';

const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;
const cleanups: Array<() => void> = [];
afterEach(() => {
  registerInstalledTierClassification(undefined);
  while (cleanups.length) cleanups.pop()!();
});

function mailbox(): FixtureParentSpec[] {
  return [{
    id: 'm1', subject: 'Flat', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z', body: 'Please find the lease attached.',
    children: [{ key: 'p1', name: 'lease.txt', mimeType: 'text/plain', text: 'The lease term is thirty-seven months.' }],
  }];
}

describe('the archive lanes\' extraction runtime', () => {
  test('has nothing to read from before an archive exists, and serves the family once its Private store does', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const extraction = createArchiveExtractionRuntime({
      runtime: h.runtime,
      env: h.env,
      jobsDbPath: join(h.base, 'file-extraction-jobs.sqlite'),
      warn: () => {},
    });
    cleanups.push(() => extraction.close());
    expect(extraction.runner()).toBeUndefined();
    expect(extraction.corpusIds()).toEqual([]);

    const archiveId = h.start();
    await h.importAll(archiveId, mailbox());
    expect(extraction.runner()).toBeDefined();
    expect(extraction.corpusIds()).toEqual([archiveCorpusId('secure_local', format.family)]);
    // The same runtime serves the next ask: it is rebuilt only when the stores change.
    expect(extraction.runner()).toBe(extraction.runner());
  });

  test('serves a family whose parents were all judged Personal at once: the import still made the Private home', async () => {
    // A cached verdict or an owner rule puts the parents' names and text in Personal straight away.
    registerInstalledTierClassification({
      forLedger: () => ({ sniffer: { id: 'scripted', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) } }),
    });
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    await h.importAll(archiveId, mailbox());
    // Nothing of this archive is in the Private store, and the child is listed by name in Personal...
    expect(h.rows(archiveId).map((row) => row.domain)).toEqual(['internal', 'internal']);
    expect(h.rows(archiveId).some((row) => row.providerItemId.includes('#child:'))).toBe(true);
    // ...but every import pass makes the Private store first (it is the home children are read into), so it is there to serve.
    expect(h.runtime.lane(format.family).set.store('secure_local')).toBeDefined();

    const extraction = createArchiveExtractionRuntime({ runtime: h.runtime, env: h.env, jobsDbPath: join(h.base, 'jobs.sqlite'), warn: () => {} });
    cleanups.push(() => extraction.close());
    expect(extraction.runner()).toBeDefined();
    expect(extraction.corpusIds()).toEqual([archiveCorpusId('secure_local', format.family)]);
  });

  test('is closed for good by close(): nothing is served afterwards', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    await h.importAll(archiveId, mailbox());
    const extraction = createArchiveExtractionRuntime({ runtime: h.runtime, env: h.env, jobsDbPath: join(h.base, 'jobs.sqlite'), warn: () => {} });
    expect(extraction.runner()).toBeDefined();
    extraction.close();
    expect(extraction.runner()).toBeUndefined();
  });
});

describe('the scheduler source\'s reading task', () => {
  async function imported(parents: FixtureParentSpec[] = mailbox()) {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    await h.importAll(archiveId, parents);
    return { h, archiveId };
  }
  const runtimeFor = (h: ReturnType<typeof childItemsArchiveHarness>, connectorFactory?: (formatId: string) => ArchiveConnectorFactory | undefined) => {
    const extraction = createArchiveExtractionRuntime({
      runtime: h.runtime,
      env: h.env,
      jobsDbPath: join(h.base, 'file-extraction-jobs.sqlite'),
      warn: () => {},
      ...(connectorFactory ? { connectorFactory } : {}),
    });
    cleanups.push(() => extraction.close());
    return extraction;
  };

  test('an archive has a reading task in the import\'s serialization; without the runtime there is none', async () => {
    const { h, archiveId } = await imported();
    const source = createArchiveImportsSchedulerSource({ runtime: h.runtime, config: defaultConfig(), extraction: runtimeFor(h) });
    const task = source?.tasks.find((candidate) => candidate.id === archiveExtractionTaskId(archiveId));
    expect(task).toMatchObject({ kind: 'extract', writer: true, concurrencyKey: ARCHIVE_IMPORTS_CONCURRENCY_KEY });
    const without = createArchiveImportsSchedulerSource({ runtime: h.runtime, config: defaultConfig() });
    expect(without?.tasks.some((candidate) => candidate.id === archiveExtractionTaskId(archiveId)) ?? false).toBe(false);
  });

  test('a pass reads the child through the factory and lands its text, then has nothing left', async () => {
    registerInstalledTierClassification({ forLedger: () => ({ sniffer: { id: 's', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) } }) });
    const { h, archiveId } = await imported();
    // The product reads a child with the format's own connector; the fixture stands in for it here.
    const connectorFactory = (): ArchiveConnectorFactory => (input): SourceConnector => createFixtureChildConnector({
      accountScope: input.accountScope,
      provider: format.provider,
      family: format.family,
      id: input.connectorId,
      parents: mailbox(),
      log: h.log,
    });
    const source = createArchiveImportsSchedulerSource({ runtime: h.runtime, config: defaultConfig(), extraction: runtimeFor(h, connectorFactory) })!;
    const task = source.tasks.find((candidate) => candidate.id === archiveExtractionTaskId(archiveId))!;
    const child = childProviderItemId('m1', 'p1');
    const landed = () => h.rows(archiveId).filter((row) => row.providerItemId === child && row.chunks > 0).length;

    expect(landed()).toBe(0);
    const first = await task.run({} as never);
    expect(first.status).toBe('progress');
    expect(landed()).toBeGreaterThan(0);
    expect((await task.run({} as never)).status).toBe('idle');
  });

  test('a removing archive is not read: its task is gone, and nothing lands after the record says so', async () => {
    const { h, archiveId } = await imported();
    const extraction = runtimeFor(h);
    h.runtime.state.update(archiveId, (record) => { record.status = 'removing'; });
    const source = createArchiveImportsSchedulerSource({ runtime: h.runtime, config: defaultConfig(), extraction });
    expect(source?.tasks.some((candidate) => candidate.id === archiveExtractionTaskId(archiveId))).toBe(false);
    // The removal task is the archive's only one.
    expect(source?.tasks.map((candidate) => candidate.kind)).toEqual(['sync']);
  });
});
