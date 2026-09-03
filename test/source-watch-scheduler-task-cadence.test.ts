import { describe, expect, test } from 'bun:test';
import {
  SourceScheduler,
  attachSourceWatchSchedulerTask,
  type SourceSchedulerSource,
} from '../src/workers/source-scheduler.ts';

describe('source watch scheduler task cadence', () => {
  test('the global watch pass runs even when its host lane is manual cadence', async () => {
    let laneRuns = 0;
    let watchRuns = 0;
    const host: SourceSchedulerSource = {
      sourceId: 'dropbox.files',
      corpusId: 'secure_local.dropbox.files',
      cadence: 'manual',
      intervalMs: 30 * 60_000,
      freshnessThresholdHours: 26,
      tasks: [{
        id: 'dropbox.files_sync',
        kind: 'sync',
        writer: true,
        run: async () => {
          laneRuns += 1;
          return { status: 'idle' };
        },
      }],
    };
    const sources = attachSourceWatchSchedulerTask({
      sources: [host],
      selectedSourceIds: ['dropbox.files'],
      intervalMs: 60_000,
      pass: {
        run: async () => {
          watchRuns += 1;
          return { status: 'idle' };
        },
      },
    });

    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-08-18T10:00:00.000Z'),
      sources,
    });

    const status = await scheduler.runDueTasks();
    expect(watchRuns).toBe(1);
    expect(laneRuns).toBe(0);
    expect(status.sources[0]?.tasks.find((task) => task.id === 'source_watches_evaluate'))
      .toMatchObject({ last_result: { status: 'idle' } });
  });
});
