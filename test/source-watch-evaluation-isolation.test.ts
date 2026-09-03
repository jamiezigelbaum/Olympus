// The evaluation pass reads the executable watch list once and then awaits a
// search per watch. A watch that is cancelled or expires inside that awaited
// window is no longer active when recordMatch runs, and the store rejects the
// match by design. The delivery pass already isolates the same class of
// mid-flight lifecycle change per lease; these pin that the evaluation pass
// does too, so one owner's cancellation cannot skip every other watch on the
// tick and fail the scheduler task.

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  createSourceWatchExecutorCapability,
  createTrustedSourceWatchOwnerContext,
  LocalSourceWatchStore,
  type SourceWatchClock,
} from '../src/core/source-watch.ts';
import {
  listSourceWatchPublicViews,
  runSourceWatchEvaluationPass,
  type SourceWatchSearchHit,
} from '../src/workers/source-watch-runtime.ts';

const START = '2026-07-22T10:00:00.000Z';
const CORPUS = 'internal.telegram.messages';

describe('source watch evaluation isolation', () => {
  test('a watch cancelled during its own search does not abort the other watches', async () => {
    await withStore(async ({ store, clock, executor, owner }) => {
      store.createWatch({
        watchId: 'watch-cancelled-mid-search',
        corpusId: CORPUS,
        queryText: 'cancelled-query',
        mode: 'continuous',
      }, owner);
      store.createWatch({
        watchId: 'watch-healthy',
        corpusId: CORPUS,
        queryText: 'healthy-query',
        mode: 'continuous',
      }, owner);
      clock.advance(60_000);
      const observedAt = clock.now().toISOString();

      const result = await runSourceWatchEvaluationPass({
        store,
        executor,
        search: {
          async search(input) {
            if (input.query === 'cancelled-query') {
              store.cancelWatch(owner, { watchId: 'watch-cancelled-mid-search' });
              return [hit('message-cancelled', 'v1', observedAt)];
            }
            return [hit('message-healthy', 'v1', observedAt)];
          },
        },
      });

      expect(result.counts).toMatchObject({
        watches_evaluated: 2,
        matches_recorded: 1,
        watches_skipped_inactive: 1,
      });
      const views = listSourceWatchPublicViews({ store, owner }).watches;
      expect(views.find((view) => view.watch_id === 'watch-healthy')?.delivery.pending_count).toBe(1);
    });
  });

  test('a search outage still fails the pass', async () => {
    await withStore(async ({ store, executor, owner }) => {
      store.createWatch({
        watchId: 'watch-search-outage',
        corpusId: CORPUS,
        queryText: 'pineapple',
        mode: 'continuous',
      }, owner);

      await expect(runSourceWatchEvaluationPass({
        store,
        executor,
        search: { search: async () => { throw new Error('search unavailable'); } },
      })).rejects.toThrow('search unavailable');
    });
  });
});

function hit(localItemId: string, sourceVersion: string, sourceObservedAt: string): SourceWatchSearchHit {
  return { ref: { corpusId: CORPUS, localItemId, sourceVersion }, sourceObservedAt };
}

class MutableClock implements SourceWatchClock {
  constructor(private timestamp: string) {}
  now(): Date { return new Date(this.timestamp); }
  advance(milliseconds: number): void {
    this.timestamp = new Date(Date.parse(this.timestamp) + milliseconds).toISOString();
  }
}

async function withStore(run: (fixture: {
  store: LocalSourceWatchStore;
  clock: MutableClock;
  executor: ReturnType<typeof createSourceWatchExecutorCapability>;
  owner: ReturnType<typeof createTrustedSourceWatchOwnerContext>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-watch-isolation-'));
  const stateDir = join(dir, 'private-state');
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const clock = new MutableClock(START);
  const store = new LocalSourceWatchStore(join(stateDir, 'watches.sqlite'), { clock });
  try {
    await run({
      store,
      clock,
      executor: createSourceWatchExecutorCapability({ executorId: 'isolation-test' }),
      owner: createTrustedSourceWatchOwnerContext({
        ownerId: 'owner-isolation',
        routeKind: 'openclaw_channel',
        routeTargetId: 'telegram:12345',
        routeAccountId: 'castor',
      }),
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
