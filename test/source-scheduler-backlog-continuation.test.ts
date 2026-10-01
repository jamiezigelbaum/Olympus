// A backlog keeps draining: a pass that leaves work ready asks to continue
// within seconds, an upstream pass that made progress wakes its source's
// extraction and embedding, and one extraction pass reads past candidate
// pages that hold nothing in its lane's scope.

import { describe, expect, test } from 'bun:test';
import {
  SourceScheduler,
  fileExtractionSchedulerTask,
  type SourceSchedulerSource,
  type SourceSchedulerTask,
  type SourceSchedulerTaskRunResult,
} from '../src/workers/source-scheduler.ts';
import type {
  ExtractionPlanRequest,
  ExtractionRunRequest,
  FileExtractionRunner,
} from '../src/workers/file-extraction/runner.ts';

const T0 = Date.parse('2026-10-01T18:52:00.000Z');
const INTERVAL = 30 * 60_000;

function source(tasks: SourceSchedulerTask[]): SourceSchedulerSource {
  return {
    sourceId: 'files.fixture',
    corpusId: 'secure_local.files.fixture',
    cadence: 'continuous',
    intervalMs: INTERVAL,
    freshnessThresholdHours: 26,
    tasks,
  };
}

function task(
  id: string,
  kind: SourceSchedulerTask['kind'],
  run: () => Promise<SourceSchedulerTaskRunResult>,
): SourceSchedulerTask {
  return { id, kind, writer: true, run };
}

function scheduler(sources: SourceSchedulerSource[], clock: { now: number }): SourceScheduler {
  return new SourceScheduler({
    enabled: true,
    tickMs: 60_000,
    errorBackoffMs: 60_000,
    maxTransientRetries: 1,
    now: () => new Date(clock.now),
    sources,
    continueAfterMs: 5_000,
  });
}

function nextRunAt(status: Awaited<ReturnType<SourceScheduler['runDueTasks']>>, taskId: string): string | undefined {
  return status.sources.flatMap((entry) => entry.tasks).find((entry) => entry.id === taskId)?.next_run_at;
}

describe('backlog continuation', () => {
  test('a pass that asks to continue runs again within seconds; an idle one waits its interval', async () => {
    const clock = { now: T0 };
    const runs: string[] = [];
    let backlog = 2;
    const sched = scheduler([source([
      task('extract', 'extract', async () => {
        runs.push('extract');
        backlog -= 1;
        return { status: 'progress', continueSoon: backlog > 0 };
      }),
    ])], clock);

    let status = await sched.runDueTasks(new Date(clock.now));
    expect(nextRunAt(status, 'extract')).toBe(new Date(T0 + 5_000).toISOString());

    clock.now = T0 + 5_000;
    status = await sched.runDueTasks(new Date(clock.now));
    expect(runs).toEqual(['extract', 'extract']);
    // Backlog gone: back to the regular cadence, counted from the last pass.
    expect(Date.parse(nextRunAt(status, 'extract')!)).toBe(T0 + 5_000 + INTERVAL);
  });

  test('an upstream pass that made progress wakes the same source\'s extraction and embedding', async () => {
    const clock = { now: T0 };
    const runs: string[] = [];
    let syncRuns = 0;
    const sync = task('sync', 'sync', async () => {
      runs.push('sync');
      syncRuns += 1;
      // The second listing finds the owner's newly chosen folder.
      return { status: syncRuns === 2 ? 'progress' : 'idle' };
    });
    const sched = scheduler([source([
      { ...sync, intervalMs: 60_000 },
      task('extract', 'extract', async () => {
        runs.push('extract');
        return { status: 'idle' };
      }),
      task('embed', 'embed', async () => {
        runs.push('embed');
        return { status: 'idle' };
      }),
    ])], clock);

    let status = await sched.runDueTasks(new Date(clock.now));
    expect(runs).toEqual(['sync', 'extract', 'embed']);
    expect(Date.parse(nextRunAt(status, 'extract')!)).toBe(T0 + INTERVAL);

    clock.now = T0 + 60_000;
    status = await sched.runDueTasks(new Date(clock.now));
    expect(runs).toEqual(['sync', 'extract', 'embed', 'sync']);
    // Not half an hour: within seconds of the listing that found new items.
    expect(Date.parse(nextRunAt(status, 'extract')!)).toBe(T0 + 65_000);
    expect(Date.parse(nextRunAt(status, 'embed')!)).toBe(T0 + 65_000);

    clock.now = T0 + 65_000;
    await sched.runDueTasks(new Date(clock.now));
    expect(runs).toEqual(['sync', 'extract', 'embed', 'sync', 'extract', 'embed']);
  });
});

describe('extraction pass over a shared candidate store', () => {
  // Pages of one shared store: two pages of another lane's files, then this
  // lane's own files, then the end. The old pass stopped after the first page
  // (zero candidates, cursor mid-store) and went idle for its interval.
  function runner(pages: Array<{ candidates: number; next?: string; done: boolean }>) {
    const plans: Array<string | undefined> = [];
    const runs: ExtractionRunRequest[] = [];
    const byCursor = new Map<string | undefined, { candidates: number; next?: string; done: boolean }>();
    let cursor: string | undefined;
    for (const page of pages) {
      byCursor.set(cursor, page);
      cursor = page.next;
    }
    const fake = {
      async plan(request: ExtractionPlanRequest) {
        plans.push(request.cursor);
        const page = byCursor.get(request.cursor)!;
        return {
          kind: 'file_extraction_plan',
          corpusId: request.corpusId,
          candidates: page.candidates,
          jobsQueued: page.candidates,
          jobsExisting: 0,
          jobsForced: 0,
          jobsSkippedTooLarge: 0,
          jobsUnroutable: 0,
          extractorKinds: page.candidates > 0 ? ['local_text'] : [],
          ...(page.next !== undefined ? { nextCursor: page.next } : {}),
          done: page.done,
        };
      },
      async run(request: ExtractionRunRequest) {
        runs.push(request);
        const processed = Math.min(request.limit ?? 0, 2);
        return {
          processedJobs: processed,
          paused: false,
          counts: {
            indexed: processed, metadata_only: 0, skipped_unsupported: 0, skipped_too_large: 0,
            blocked_policy: 0, failed_retryable: 0, failed_terminal: 0,
          },
        };
      },
    } as unknown as FileExtractionRunner;
    return { fake, plans, runs };
  }

  const lane = { corpusId: 'c', provider: 'fixture', accountScope: 'personal', approvedScopeKey: 'fixture.personal:/labs' };

  test('reads past pages with nothing in scope, queues this lane\'s files, and asks to continue', async () => {
    const { fake, plans, runs } = runner([
      { candidates: 0, next: 'tier:internal:755', done: false },
      { candidates: 0, next: 'tier:internal:780', done: false },
      { candidates: 4, next: 'tier:internal:900', done: false },
      { candidates: 0, done: true },
    ]);
    const extract = fileExtractionSchedulerTask({ id: 'x', runner: fake, lane, planLimit: 3, batchSize: 2 });
    const result = await extract.run();
    expect(plans).toEqual([undefined, 'tier:internal:755', 'tier:internal:780']);
    expect(result.counts).toMatchObject({ candidates_seen: 4, jobs_queued: 4, jobs_processed: 2 });
    expect(runs[0]?.preflightExtractorKinds).toEqual(['local_text']);
    expect(result.status).toBe('progress');
    expect(result.checkpoint).toBe('tier:internal:900');
    expect(result.continueSoon).toBe(true);
  });

  test('a finished scan with a part batch clears its cursor and does not ask to continue', async () => {
    const { fake } = runner([{ candidates: 1, done: true }]);
    const extract = fileExtractionSchedulerTask({ id: 'x', runner: fake, lane, planLimit: 25, batchSize: 4 });
    const result = await extract.run();
    expect(result.checkpoint).toBeNull();
    expect(result.continueSoon).toBe(false);
  });

  test('the page bound holds: a long run of out-of-scope pages ends the pass and continues next time', async () => {
    const pages = Array.from({ length: 10 }, (_, index) => ({ candidates: 0, next: `p${index + 1}`, done: false }));
    const { fake, plans } = runner(pages);
    const extract = fileExtractionSchedulerTask({ id: 'x', runner: fake, lane, planLimit: 25, batchSize: 2, maxPlanPages: 3 });
    const result = await extract.run();
    expect(plans).toEqual([undefined, 'p1', 'p2']);
    expect(result.checkpoint).toBe('p3');
    expect(result.continueSoon).toBe(true);
  });
});
