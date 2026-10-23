/**
 * Imported archives as one scheduler source, `archive.imports`: one task per
 * archive that is importing or being removed, all sharing one concurrency
 * key, so two archives never write their family's stores at once and a
 * removal never runs beside its own archive's import (they are the same
 * task). An archive that finished importing, or stopped, has no task.
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
  progressFromCounts,
  schedulerScopeHash,
  type SourceSchedulerSource,
  type SourceSchedulerTask,
} from '../source-scheduler.ts';
import { runArchiveRemoval } from './removal.ts';
import type { ArchiveImportRuntime } from './runtime.ts';
import { pullArchiveImport } from './sync.ts';
import { archiveCorpusId } from './store.ts';

export const ARCHIVE_IMPORTS_CONCURRENCY_KEY = 'archive.imports';

/**
 * The task id of one archive's import and removal.
 */
export function archiveImportTaskId(archiveId: string): string {
  return `${SCHEDULER_SOURCE_IDS.archiveImports}_pull.${schedulerScopeHash(archiveId)}`;
}

export interface ArchiveImportsSchedulerSourceInput {
  runtime: ArchiveImportRuntime;
  config: OlympusConfig;
  /**
   * Opens the private inbox for a removal; undefined when there is none.
   */
  openWaitingQuestions?: () => WaitingQuestionStore | undefined;
  /**
   * One embed task per tier store, with the identity its domain allows.
   */
  tierEmbeddings?: ReadonlyArray<{
    corpusId: string;
    store: () => LocalConnectorStore | undefined;
    provider: SourceEmbeddingProvider;
  }>;
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
    tasks.push({
      id: archiveImportTaskId(archiveId),
      kind: 'sync',
      writer: true,
      concurrencyKey: ARCHIVE_IMPORTS_CONCURRENCY_KEY,
      run: async () => {
        const lane = input.runtime.lane(family);
        const current = input.runtime.state.get(archiveId);
        if (current?.status === 'removing') {
          const outcome = await runArchiveRemoval({
            state: input.runtime.state,
            lane,
            archiveId,
            ...(input.openWaitingQuestions ? { openWaitingQuestions: input.openWaitingQuestions } : {}),
          });
          const counts = 'counts' in outcome ? { ...outcome.counts } : {};
          return {
            status: outcome.kind === 'removed' || outcome.kind === 'progress' ? 'progress' : 'idle',
            counts: { ...counts, removal_complete: Number(outcome.kind === 'removed') },
            ...(outcome.kind === 'progress' || outcome.kind === 'waiting_for_import' ? { continueSoon: true } : {}),
          };
        }
        const outcome = await pullArchiveImport({
          state: input.runtime.state,
          lane,
          archiveId,
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
  };
}
