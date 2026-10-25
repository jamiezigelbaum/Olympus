/**
 * Imported archives as one scheduler source, `archive.imports`: one task per
 * archive that is importing or being removed, all sharing one concurrency
 * key, so two archives never write their family's stores at once and a
 * removal never runs beside its own archive's import (they are the same
 * task). An archive that finished importing, or stopped, has no task.
 *
 * Because they are the same task, a removal asked for after the import ended
 * would inherit the import's schedule (its last pass plus the sync interval,
 * 30 minutes by default), and so would a removal resumed after a restart. So
 * the source offers the scheduler a push wake (`subscribeChanges`): the
 * dashboard wakes it when a removal is asked for, and it wakes when subscribed
 * with a removal waiting. The scheduler then runs the removal within seconds;
 * the import cadence is untouched.
 *
 * An import that is one input of a source (`record.target`) writes the
 * source's own stores through the source's connector, so its task shares the
 * source's concurrency key instead: it never runs beside the source's own
 * pulls, and the source's lane of the family is not built for it. It has no
 * Remove, so no removal task, and the source's own extraction reads its
 * children.
 *
 * Reading later: an archive that is importing or finished has one more task,
 * which reads the child items the import listed by name (an attachment, a
 * photo) through the shared extraction factory, in the same serialization as
 * the import and the removal, so a child never lands beside a removal.
 *
 * Embedding: one task per tier store that exists, each with the identity its
 * trust domain allows (the Private store only with a local or approved
 * private embedder).
 */
import type { OlympusConfig } from '../../core/config.ts';
import type { WaitingQuestionStore } from '../../core/waiting-private-questions.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import { isApprovedSecureSourceEmbeddingProvider, type SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import {
  DROPBOX_EMBED_MAX_CHUNKS_PER_PASS,
  SCHEDULER_SOURCE_IDS,
  embedPassResult,
  fileExtractionSchedulerTask,
  progressFromCounts,
  schedulerScopeHash,
  type SourceSchedulerSource,
  type SourceSchedulerTask,
} from '../source-scheduler.ts';
import type { ArchiveExtractionRuntime } from './extraction-runtime.ts';
import { ARCHIVE_EXTRACTION_SCOPE_KEY } from './extraction-source.ts';
import { runArchiveRemoval } from './removal.ts';
import type { ArchiveImportRuntime } from './runtime.ts';
import { pullArchiveImport } from './sync.ts';
import { archiveCorpusId } from './store.ts';
import type { ArchiveSourceTargets } from './source-targets.ts';

export const ARCHIVE_IMPORTS_CONCURRENCY_KEY = 'archive.imports';

/**
 * The task id of one archive's import and removal.
 */
export function archiveImportTaskId(archiveId: string): string {
  return `${SCHEDULER_SOURCE_IDS.archiveImports}_pull.${schedulerScopeHash(archiveId)}`;
}

/**
 * The task id of one archive's reading of its child items.
 */
export function archiveExtractionTaskId(archiveId: string): string {
  return `${SCHEDULER_SOURCE_IDS.archiveImports}_extract.${schedulerScopeHash(archiveId)}`;
}

/**
 * How many candidates a reading pass plans, and how many it reads: a backlog
 * of attachments drains pass after pass, each asking to continue within seconds.
 */
export const ARCHIVE_EXTRACTION_PLAN_LIMIT = 200;
export const ARCHIVE_EXTRACTION_BATCH_SIZE = 10;

/**
 * How often a running pass re-reads the record to learn the archive is being removed.
 */
export const ARCHIVE_IMPORT_STATUS_CHECK_MS = 1_000;

/**
 * False from the moment the record says the archive is no longer importing
 * (a removal was asked for), read at most once per ARCHIVE_IMPORT_STATUS_CHECK_MS.
 */
function stillImporting(runtime: ArchiveImportRuntime, archiveId: string, now: () => number = Date.now): () => boolean {
  let checkedAt = now();
  let importing = true;
  return () => {
    if (!importing) return false;
    if (now() - checkedAt < ARCHIVE_IMPORT_STATUS_CHECK_MS) return true;
    checkedAt = now();
    try {
      importing = runtime.state.get(archiveId)?.status === 'importing';
    } catch {
      importing = false;
    }
    return importing;
  };
}

export interface ArchiveImportsSchedulerSourceInput {
  runtime: ArchiveImportRuntime;
  config: OlympusConfig;
  /**
   * Opens the private inbox for a removal (default: the runtime's).
   */
  openWaitingQuestions?: () => WaitingQuestionStore | undefined;
  /**
   * The archive lanes' extraction runtime, for reading child items. Without
   * it nothing reads them (a test seam; the product always supplies it).
   */
  extraction?: Pick<ArchiveExtractionRuntime, 'runner'>;
  /**
   * One embed task per tier store, with the identity its domain allows.
   */
  tierEmbeddings?: ReadonlyArray<{
    corpusId: string;
    store: () => LocalConnectorStore | undefined;
    provider: SourceEmbeddingProvider;
  }>;
  /**
   * The sources an import can be an input of (default: the runtime's).
   */
  targets?: ArchiveSourceTargets;
  /**
   * Test seams.
   */
  maxItems?: number;
}

export function createArchiveImportsSchedulerSource(
  input: ArchiveImportsSchedulerSourceInput,
): SourceSchedulerSource | undefined {
  let records;
  try {
    records = input.runtime.state.list();
  } catch (error) {
    console.warn(`[archive-import] the archive record could not be read: ${error instanceof Error ? error.name : 'error'}`);
    return undefined;
  }
  const tasks: SourceSchedulerTask[] = [];
  for (const record of records) {
    if (record.status !== 'importing' && record.status !== 'removing') continue;
    const archiveId = record.archive_id;
    const family = record.family;
    const targets = input.targets ?? input.runtime.targets;
    const sourceKey = record.target ? targets.forSource(record.target.source_id)?.concurrencyKey : undefined;
    tasks.push({
      id: archiveImportTaskId(archiveId),
      kind: 'sync',
      writer: true,
      concurrencyKey: sourceKey ?? ARCHIVE_IMPORTS_CONCURRENCY_KEY,
      run: async () => {
        const current = input.runtime.state.get(archiveId);
        if (current?.target) {
          // An input of a source: no removal, no family lane; the pass resolves the account and writes under the source's runner.
          const outcome = await pullArchiveImport({
            state: input.runtime.state,
            archiveId,
            targets,
            shouldContinue: stillImporting(input.runtime, archiveId),
            media: input.runtime.media,
            ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
          });
          return {
            status: outcome.receipt.status,
            counts: outcome.receipt.counts,
            ...(outcome.receipt.warnings ? { warnings: outcome.receipt.warnings } : {}),
            ...(outcome.continueSoon ? { continueSoon: true } : {}),
          };
        }
        const lane = input.runtime.lane(family);
        if (current?.status === 'removing') {
          const outcome = await runArchiveRemoval({
            state: input.runtime.state,
            lane,
            archiveId,
            openWaitingQuestions: input.openWaitingQuestions ?? (() => input.runtime.openWaitingQuestions()),
            media: input.runtime.media,
          });
          const counts = 'counts' in outcome ? { ...outcome.counts } : {};
          return {
            status: outcome.kind === 'removed' || outcome.kind === 'progress' ? 'progress' : 'idle',
            counts: { ...counts, removal_complete: Number(outcome.kind === 'removed') },
            ...(outcome.kind === 'progress' ? { continueSoon: true } : {}),
          };
        }
        const outcome = await pullArchiveImport({
          state: input.runtime.state,
          lane,
          archiveId,
          shouldContinue: stillImporting(input.runtime, archiveId),
          media: input.runtime.media,
          ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
        });
        return {
          status: outcome.receipt.status,
          counts: outcome.receipt.counts,
          ...(outcome.receipt.warnings ? { warnings: outcome.receipt.warnings } : {}),
          ...(outcome.continueSoon ? { continueSoon: true } : {}),
        };
      },
    });
  }

  if (input.extraction) {
    const extraction = input.extraction;
    const known = input.runtime.families();
    for (const record of records) {
      if (record.status !== 'importing' && record.status !== 'imported') continue;
      // An input of a source: the source's own extraction reads its children.
      if (record.target) continue;
      // A record naming a family no format imports into has nothing to read with.
      const family = known.find((candidate) => candidate === record.family);
      if (!family) continue;
      const archiveId = record.archive_id;
      const lane = {
        corpusId: archiveCorpusId('secure_local', family),
        // The jobs carry the items' own provider (their format's), the archive's id as the account.
        provider: record.provider,
        accountScope: archiveId,
        approvedScopeKey: ARCHIVE_EXTRACTION_SCOPE_KEY,
      };
      // The runner is asked for at each use: the runtime is rebuilt when a lane's stores change.
      const taskFor = (runner: NonNullable<ReturnType<typeof extraction.runner>>) => fileExtractionSchedulerTask({
        id: archiveExtractionTaskId(archiveId),
        runner,
        lane,
        planLimit: ARCHIVE_EXTRACTION_PLAN_LIMIT,
        batchSize: ARCHIVE_EXTRACTION_BATCH_SIZE,
      });
      tasks.push({
        id: archiveExtractionTaskId(archiveId),
        kind: 'extract',
        writer: true,
        concurrencyKey: ARCHIVE_IMPORTS_CONCURRENCY_KEY,
        atStart: () => { extraction.runner()?.prepareReadersWithWaitingWork?.([lane]); },
        run: async (context) => {
          const runner = extraction.runner();
          // Nothing to read from yet (the family's first store is not there): the next pass asks again.
          if (!runner) return progressFromCounts({ candidates_seen: 0, jobs_queued: 0, jobs_run: 0 });
          return taskFor(runner).run(context);
        },
      });
    }
  }

  for (const tier of input.tierEmbeddings ?? []) {
    tasks.push({
      id: `${SCHEDULER_SOURCE_IDS.archiveImports}_embeddings.${schedulerScopeHash(tier.corpusId)}`,
      kind: 'embed',
      writer: true,
      run: async () => {
        const store = tier.store();
        if (!store) return progressFromCounts({ chunks_seen: 0, chunks_embedded: 0, chunks_skipped: 0 });
        if (store.trustDomain === 'secure_local' && !isApprovedSecureSourceEmbeddingProvider(tier.provider)) {
          throw new Error('A secure_local archive store requires a local/private or approved Venice embedding provider.');
        }
        const result = await store.embedChunks({ provider: tier.provider, limit: DROPBOX_EMBED_MAX_CHUNKS_PER_PASS });
        return embedPassResult(result, DROPBOX_EMBED_MAX_CHUNKS_PER_PASS);
      },
    });
  }

  if (tasks.length === 0) return undefined;
  const families = input.runtime.families();
  return {
    sourceId: SCHEDULER_SOURCE_IDS.archiveImports,
    corpusId: archiveCorpusId('secure_local', families[0]!),
    cadence: 'continuous',
    intervalMs: input.config.worker.scheduler.syncIntervalSeconds * 1_000,
    freshnessThresholdHours: input.config.worker.scheduler.freshnessThresholdHours,
    tasks,
    // The runtime's own function, so the scheduler keeps one subscription
    // across the source being rebuilt on every roster change.
    subscribeChanges: input.runtime.subscribeWork,
  };
}
