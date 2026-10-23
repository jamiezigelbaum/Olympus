// A provider answering a pull with HTTP 401 has rejected the stored
// credential. The scheduler records that as one closed kind for every
// connector (never per source), which the dashboard turns into Needs you.

import { describe, expect, test } from 'bun:test';
import { SourceScheduler, type SourceSchedulerTask } from '../src/workers/source-scheduler.ts';
import { sourceFailureKind } from '../src/workers/dashboard/source-failure.ts';

const T0 = Date.parse('2026-10-23T10:00:00.000Z');

/** A stand-in connector API error: any connector's error class carries a numeric status. */
class StandInApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

async function lastErrorKind(run: () => Promise<never>): Promise<string | undefined> {
  const task: SourceSchedulerTask = { id: 'pull', kind: 'sync', writer: true, run };
  const scheduler = new SourceScheduler({
    enabled: true,
    tickMs: 60_000,
    errorBackoffMs: 60_000,
    maxTransientRetries: 1,
    now: () => new Date(T0),
    sources: [{
      sourceId: 'standin.source',
      corpusId: 'secure_local.standin',
      cadence: 'continuous',
      intervalMs: 30 * 60_000,
      freshnessThresholdHours: 26,
      tasks: [task],
    }],
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const status = await scheduler.runDueTasks(new Date(T0));
    return status.sources[0]?.tasks[0]?.last_error_kind;
  } finally {
    console.error = originalError;
  }
}

describe('provider credential rejection', () => {
  test('a 401 from any connector pull is recorded as a rejected credential', async () => {
    const kind = await lastErrorKind(async () => {
      throw new StandInApiError('Stand-in pull returned HTTP 401: Invalid token.', 401);
    });
    expect(kind).toBe('credential_reauth_required');
    expect(sourceFailureKind(kind)).toBe('sign_in');
  });

  test('a connector that only words the status is still recognised', async () => {
    expect(await lastErrorKind(async () => { throw new Error('Stand-in sync returned HTTP 401.'); }))
      .toBe('credential_reauth_required');
  });

  test('other failures keep their kind', async () => {
    expect(await lastErrorKind(async () => { throw new StandInApiError('Stand-in pull returned HTTP 500.', 500); }))
      .toBe('task_failed');
    expect(await lastErrorKind(async () => { throw new StandInApiError('Stand-in pull returned HTTP 4010.', 400); }))
      .toBe('task_failed');
  });
});
