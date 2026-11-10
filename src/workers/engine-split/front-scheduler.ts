/**
 * The scheduler as the engine split's front sees it. The real scheduler runs
 * in the background process; the front's request handlers keep calling the
 * same few methods (status, runSource, updateSources, wakeTasksOfKind,
 * hasExecutingTask) and this stand-in answers them from the background's
 * status snapshot and turns each wake into one command:
 *
 * - updateSources (after a connect, disconnect or registry change) → `reload sources`.
 *   The background re-reads the registry and rebuilds its own sources; the
 *   sources the front built are not sent (they hold functions and handles).
 * - runSource → `sync_now`; operator provenance (Sync now, a scope approval)
 *   stays operator. The front gets the receipt, not the finished pass,
 *   so no request waits on a sync.
 * - wakeTasksOfKind('extract') → `reload extraction`.
 */
import type { SourceScheduler, SourceSchedulerStatus } from '../source-scheduler.ts';
import type { EngineCommandClient } from './client.ts';
import type { EngineStatusRead } from './snapshot.ts';

export interface FrontSchedulerOptions {
  client: Pick<EngineCommandClient, 'post'>;
  snapshot: () => EngineStatusRead | undefined;
  now?: () => Date;
  log?: (line: string) => void;
}

export type FrontScheduler = Pick<SourceScheduler, 'status' | 'runSource' | 'updateSources' | 'wakeTasksOfKind' | 'hasExecutingTask' | 'start' | 'stop'>;

function emptyStatus(now: Date): SourceSchedulerStatus {
  return {
    kind: 'source_scheduler_status',
    enabled: true,
    running: false,
    generated_at: now.toISOString(),
    sources: [],
    policy: { raw_source_exposed: false, source_text_returned: false, source_scope_keys_exposed: false, counts_only: true },
  };
}

export function createFrontScheduler(options: FrontSchedulerOptions): FrontScheduler {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.warn(line));
  const status = (): SourceSchedulerStatus => {
    const scheduler = options.snapshot()?.snapshot.scheduler as SourceSchedulerStatus | undefined;
    return scheduler?.kind === 'source_scheduler_status' ? scheduler : emptyStatus(now());
  };
  const post = (command: Parameters<EngineCommandClient['post']>[0]) => options.client.post(command).catch((error: unknown) => {
    log(`[engine-split] ${command.kind} not delivered: ${error instanceof Error ? error.message : 'unknown error'}`);
    throw error;
  });
  return {
    status: () => status(),
    async runSource(sourceIdOrCorpusId, _now, provenance = 'scheduled') {
      await post({ kind: 'sync_now', source: sourceIdOrCorpusId, manual: provenance === 'operator' });
      return status();
    },
    updateSources() {
      void post({ kind: 'reload', target: 'sources' }).catch(() => undefined);
    },
    wakeTasksOfKind(kind) {
      if (kind === 'extract') void post({ kind: 'reload', target: 'extraction' }).catch(() => undefined);
      return 0;
    },
    hasExecutingTask(sourceIds) {
      return status().sources.some((source) => (sourceIds.has(source.source_id) || sourceIds.has(source.corpus_id))
        && source.tasks.some((task) => task.running));
    },
    start() {},
    stop() {},
  };
}
