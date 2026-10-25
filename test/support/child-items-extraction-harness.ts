// The production extraction runtime over the archive harness's stores: the
// archive corpora, the archive source, the tier set's sink and the shared
// runner, reading children through the fixture connector. Nothing here is a
// format; it proves the spine the formats will use.

import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { archiveCorpusId, getArchiveFormat, type ArchiveConnectorFactory } from '../../src/core/archive-formats.ts';
import type { SourceConnector } from '../../src/core/contracts.ts';
import { archiveFileExtractionCorpora, archiveFileExtractionSourceFactory, ARCHIVE_EXTRACTION_PROVIDER, ARCHIVE_EXTRACTION_SCOPE_KEY } from '../../src/workers/archive-import/extraction-source.ts';
import { archiveLaneStores } from '../../src/workers/archive-import/lane.ts';
import {
  createFileExtractionRuntime,
  fileExtractionCorporaRoster,
  type FileExtractionRuntime,
  type FileExtractionRuntimeOptions,
} from '../../src/workers/email-source/file-extraction-runtime.ts';
import type { ExtractionRunResult } from '../../src/workers/file-extraction/runner.ts';
import { createFixtureChildConnector, type FixtureConnectorOptions, type FixtureParentSpec } from '../helpers/child-items-fixture.ts';
import { FIXTURE_ARCHIVE_FORMAT, type ChildItemsArchiveHarness } from './child-items-archive-harness.ts';

export interface ChildItemsExtraction {
  runtime: FileExtractionRuntime;
  jobsDbPath: string;
  corpusId: string;
  /** The lane key of one archive's jobs. */
  lane(archiveId: string): { corpusId: string; provider: string; accountScope: string; approvedScopeKey: string };
  /** Plans every candidate of the corpus, then runs one archive's jobs. */
  drive(archiveId: string): Promise<{ queued: number; skippedTooLarge: number; run: ExtractionRunResult }>;
  /** Job rows as they are stored: status per provider item id. */
  jobs(archiveId?: string): Array<{ providerItemId: string; provider: string; status: string; extractorKind: string }>;
  /** Every row of the jobs file, rendered as text: what a restart could read back. */
  jobsFileText(): string;
  close(): void;
}

export function childItemsExtraction(
  h: ChildItemsArchiveHarness,
  cleanups: Array<() => void>,
  options: {
    parents: readonly FixtureParentSpec[] | ((archiveId: string) => readonly FixtureParentSpec[]);
    connector?: Partial<FixtureConnectorOptions>;
    runtime?: Partial<FileExtractionRuntimeOptions>;
  },
): ChildItemsExtraction {
  const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;
  const lane = h.runtime.lane(format.family);
  const corpusId = archiveCorpusId('secure_local', format.family);
  const jobsDbPath = join(h.base, 'file-extraction-jobs.sqlite');
  const parentsFor = (archiveId: string): readonly FixtureParentSpec[] =>
    typeof options.parents === 'function' ? options.parents(archiveId) : options.parents;
  const connectorFactory = (): ArchiveConnectorFactory => (input): SourceConnector => createFixtureChildConnector({
    accountScope: input.accountScope,
    provider: format.provider,
    family: format.family,
    id: input.connectorId,
    parents: parentsFor(input.archiveId),
    log: h.log,
    ...(input.media ? { media: input.media } : {}),
    ...options.connector,
  });
  const runtime = createFileExtractionRuntime({
    enabled: true,
    env: h.env,
    connectorStores: archiveLaneStores(lane),
    corpora: fileExtractionCorporaRoster({
      configured: [],
      archive: archiveFileExtractionCorpora({ state: h.runtime.state, families: [format.family] }),
    }),
    extraSourceFactories: new Map([[
      ARCHIVE_EXTRACTION_PROVIDER,
      archiveFileExtractionSourceFactory({ state: h.runtime.state, bindings: h.runtime.media, connectorFactory }),
    ]]),
    tierSets: new Map([[corpusId, lane.set]]),
    jobsDbPath,
    warn: () => {},
    ...options.runtime,
  });
  if (!runtime) throw new Error('the extraction runtime was not built');
  const keyOf = (archiveId: string) => ({
    corpusId,
    provider: format.provider,
    accountScope: archiveId,
    approvedScopeKey: ARCHIVE_EXTRACTION_SCOPE_KEY,
  });
  const readJobs = <T>(read: (db: Database) => T): T => {
    const db = new Database(jobsDbPath, { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  const close = (): void => runtime.close();
  cleanups.push(close);
  return {
    runtime,
    jobsDbPath,
    corpusId,
    lane: keyOf,
    async drive(archiveId) {
      let queued = 0;
      let skippedTooLarge = 0;
      let cursor: string | undefined;
      for (;;) {
        const plan = await runtime.runner.plan({ ...keyOf(archiveId), limit: 50, ...(cursor !== undefined ? { cursor } : {}) });
        queued += plan.jobsQueued;
        skippedTooLarge += plan.jobsSkippedTooLarge;
        if (plan.done || plan.nextCursor === undefined) break;
        cursor = plan.nextCursor;
      }
      const run = await runtime.runner.run(keyOf(archiveId));
      return { queued, skippedTooLarge, run };
    },
    jobs(archiveId) {
      return readJobs((db) => {
        const rows = db.query(`
          SELECT provider_item_id AS providerItemId, provider, status, extractor_kind AS extractorKind
          FROM extraction_jobs ${archiveId ? 'WHERE account_scope = ?' : ''} ORDER BY provider_item_id
        `).all(...(archiveId ? [archiveId] : [])) as Array<{ providerItemId: string; provider: string; status: string; extractorKind: string }>;
        return rows;
      });
    },
    jobsFileText() {
      return readJobs((db) => {
        const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
        return tables.map((table) => `${table}: ${JSON.stringify(db.query(`SELECT * FROM ${table}`).all())}`).join('\n');
      });
    },
    close,
  };
}
