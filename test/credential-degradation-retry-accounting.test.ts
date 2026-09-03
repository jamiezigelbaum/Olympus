import { describe, expect, test } from 'bun:test';
import { WorkerBootSecretResolver } from '../src/workers/credential-degradation.ts';

const SECRET_REF = 'store:shared.venice.api-key';
const ENV: Record<string, string | undefined> = {};

describe('worker boot credential degradation accounting', () => {
  test('extra call sites on one secretRef do not spend the retry ladder', () => {
    const delays: number[] = [];
    const scheduled: Array<() => void> = [];
    let resolveCalls = 0;
    const resolver = new WorkerBootSecretResolver({
      maxAttempts: 3,
      retryDelaysMs: [30_000, 60_000],
      now: () => new Date('2026-08-18T12:00:00.000Z'),
      schedule: (run, delayMs) => {
        delays.push(delayMs);
        scheduled.push(run);
        return delays.length;
      },
      resolveSecretRefValueSync: () => {
        resolveCalls += 1;
        return undefined;
      },
      warn: () => {},
    });

    resolver.resolveSync(SECRET_REF, ENV, {
      displayName: 'Sovereignty embedding profile "venice-internal"',
      affectedProfiles: ['venice-internal'],
      affectedCapabilities: ['embedding'],
    });
    resolver.resolveSync(SECRET_REF, ENV, {
      displayName: 'Sovereignty Venice analyst profile',
      affectedProfiles: ['venice-analyst'],
      affectedCapabilities: ['analyst'],
    });

    expect(resolveCalls).toBe(2);
    expect(resolver.status()).toMatchObject([{
      state: 'retrying',
      attempts: 1,
      max_attempts: 3,
      affected_profiles: ['venice-internal', 'venice-analyst'],
      affected_capabilities: ['embedding', 'analyst'],
    }]);

    while (scheduled.length > 0) scheduled.shift()?.();

    expect(delays).toEqual([30_000, 60_000]);
    expect(resolver.status()).toMatchObject([{ state: 'stopped', attempts: 3 }]);
  });

  test('a stopped credential leaves no armed retry behind', () => {
    const cancelled: unknown[] = [];
    const armed: Array<{ handle: number; run: () => void }> = [];
    const resolver = new WorkerBootSecretResolver({
      maxAttempts: 3,
      retryDelaysMs: [30_000, 60_000],
      now: () => new Date('2026-08-18T12:00:00.000Z'),
      schedule: (run) => {
        const handle = armed.length + 1;
        armed.push({ handle, run });
        return handle;
      },
      cancel: (handle) => { cancelled.push(handle); },
      resolveSecretRefValueSync: () => undefined,
      warn: () => {},
    });

    resolver.resolveSync(SECRET_REF, ENV, { displayName: 'Sovereignty Venice analyst profile' });
    expect(armed).toHaveLength(1);

    // The operator re-check route ignores the armed timer, so two re-checks
    // inside the first delay reach the stop threshold while it is still live.
    resolver.recheckNow();
    resolver.recheckNow();

    const status = resolver.status();
    expect(status).toMatchObject([{ state: 'stopped', attempts: 3 }]);
    expect(status[0]?.next_retry_at).toBeUndefined();
    expect(cancelled).toEqual([1]);
  });

  test('lanes configured without a secretRef stay separately named', () => {
    const resolver = new WorkerBootSecretResolver({
      schedule: () => undefined,
      warn: () => {},
    });

    resolver.resolveSync(undefined, ENV, {
      displayName: 'Sovereignty embedding profile "gemini-internal"',
      affectedProfiles: ['gemini-internal'],
      affectedCapabilities: ['embedding'],
    });
    resolver.resolveSync(undefined, ENV, {
      displayName: 'Sovereignty Venice analyst profile',
      affectedProfiles: ['venice-analyst'],
      affectedCapabilities: ['analyst'],
    });

    const status = resolver.status();
    expect(status.map((item) => item.display_name)).toEqual([
      'Sovereignty embedding profile "gemini-internal"',
      'Sovereignty Venice analyst profile',
    ]);
    expect(status.map((item) => item.affected_capabilities)).toEqual([['embedding'], ['analyst']]);
  });
});
