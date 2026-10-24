/**
 * A chosen folder that is moved away and put back: the source must recover on
 * its own, and a person pressing Sync now must clear the missing-folder state.
 */
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { LocalFilesRootMissingError } from '../src/workers/local-files/connector.ts';
import { createLocalFilesSchedulerSource } from '../src/workers/local-files/scheduler-source.ts';
import { MacPermissions } from '../src/workers/local-files/mac-permissions.ts';
import { SourceScheduler } from '../src/workers/source-scheduler.ts';

function setup() {
  let present = false;
  let pulls = 0;
  let clock = Date.parse('2026-10-24T10:00:00.000Z');
  const source = createLocalFilesSchedulerSource({
    policy: { corpusId: 'c', roots: [{ path: '/home/u/notes', approved_scope_key: 'scope:notes', default_action: 'metadata_only' }], sync: { cadence: 'continuous' }, content: { plan_limit: 1, batch_size: 1 } } as never,
    config: defaultConfig(),
    providerSync: {
      pull: async () => {
        pulls += 1;
        if (!present) throw new LocalFilesRootMissingError('/home/u/notes');
        return { receipt: { status: 'ok', counts: { found: 1 } }, checkpoint: 'cp' };
      },
      connectorIdForScope: () => 'k',
    } as never,
    store: { lastCompletedSyncRun: () => undefined } as never,
    macPermissions: new MacPermissions({ platform: 'linux', home: '/home/u' }),
  })!;
  const scheduler = new SourceScheduler({ enabled: true, tickMs: 60_000, errorBackoffMs: 60_000, maxTransientRetries: 1, sources: [source], now: () => new Date(clock) } as never);
  const task = () => scheduler.status().sources[0]!.tasks.find((t) => t.kind === 'sync')!;
  return {
    scheduler, task,
    putFolderBack: () => { present = true; },
    advance: (ms: number) => { clock += ms; },
    pulls: () => pulls,
    sourceId: source.sourceId,
  };
}

describe('a chosen folder that goes away and comes back', () => {
  test('a missing folder is re-checked within ten minutes, not a day later', async () => {
    const s = setup();
    await s.scheduler.runSource(s.sourceId, undefined, 'operator');
    expect(s.task().last_error_kind).toBe('scope_root_missing');
    const waitMs = Date.parse(s.task().next_run_at!) - Date.parse(s.task().last_attempt_at!);
    expect(waitMs).toBeLessThanOrEqual(10 * 60_000);
  });

  test('once the folder is back, the next scheduled pass indexes and clears the missing state', async () => {
    const s = setup();
    await s.scheduler.runSource(s.sourceId, undefined, 'operator');
    s.putFolderBack();
    s.advance(10 * 60_000 + 1);
    await s.scheduler.runDueTasks();
    expect(s.task().last_error_kind).toBeUndefined();
    expect(s.task().missing_scope_path).toBeUndefined();
    expect(s.task().degraded_reason).toBeUndefined();
    expect(s.task().last_success_at).toBeDefined();
  });

  test('Sync now with the folder back clears the missing state at once', async () => {
    const s = setup();
    await s.scheduler.runSource(s.sourceId, undefined, 'operator');
    s.putFolderBack();
    await s.scheduler.runSource(s.sourceId, undefined, 'operator');
    expect(s.task().last_error_kind).toBeUndefined();
    expect(s.task().missing_scope_path).toBeUndefined();
    expect(s.task().degraded_reason).toBeUndefined();
  });
});
