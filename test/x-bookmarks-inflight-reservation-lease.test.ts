// An ordinary X API reservation counts its request at reservation time and is
// released only by settleSuccess/settleFailure. A SIGKILL inside the awaited
// provider call runs neither, so before this lease the row survived forever:
// it held its resources against every later read and cost check for the rest of
// the UTC day, the conservative charge never reached the operator-visible spend
// counters, and the table grew a dead row per crash across days.

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocalXBookmarksApiUsageStore,
  defaultXBookmarksLiveSyncConfig,
} from '../src/workers/x-bookmarks/index.ts';

const ACCOUNT = 'personal';

test('an in-flight reservation abandoned by a crash converts to spend and releases its hold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-x-inflight-reservation-'));
  const usagePath = join(dir, 'x-usage.sqlite');
  const config = {
    ...defaultXBookmarksLiveSyncConfig(),
    dailyApiRequestBudget: 10,
    dailyResourceReadBudget: 12,
    dailyEstimatedSpendMicrousd: 1_000_000,
    headApiRequestReserve: 0,
    headResourceReadReserve: 0,
    headEstimatedSpendReserveMicrousd: 0,
  };
  const reservedAt = new Date('2026-08-18T12:00:00.000Z');
  let usage = new LocalXBookmarksApiUsageStore(usagePath);
  try {
    usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 6,
      config,
      now: reservedAt,
    });
    expect(usage.status({ account: ACCOUNT, config, now: reservedAt })).toMatchObject({
      api_requests: 1,
      reserved_resource_reads: 6,
      resource_reads: 0,
      estimated_spend_microusd: 0,
    });
    // The process dies mid-call: neither settle runs.
    usage.close();

    usage = new LocalXBookmarksApiUsageStore(usagePath);
    const withinLease = new Date('2026-08-18T12:10:00.000Z');
    expect(usage.status({ account: ACCOUNT, config, now: withinLease })).toMatchObject({
      reserved_resource_reads: 6,
      resource_reads: 0,
    });

    const afterLease = new Date('2026-08-18T12:20:00.000Z');
    expect(usage.status({ account: ACCOUNT, config, now: afterLease })).toMatchObject({
      api_requests: 1,
      reserved_resource_reads: 0,
      // The outcome was unknown, so the conservative charge stands — but it
      // stands in the spend counters an operator can see, not as a permanent
      // reservation nothing will ever release.
      resource_reads: 6,
      estimated_billable_resources: 6,
      estimated_spend_microusd: 6_000,
    });

    // The freed headroom is real: the day's remaining budget reserves again.
    const replacement = usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 6,
      config,
      now: afterLease,
    });
    expect(replacement.maxResources).toBe(6);
    usage.settleFailure({
      reservation: replacement,
      potentiallyBillable: false,
      config,
      now: afterLease,
    });
    expect(usage.status({ account: ACCOUNT, config, now: afterLease })).toMatchObject({
      reserved_resource_reads: 0,
      resource_reads: 6,
    });
  } finally {
    usage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a leaked reservation written before the lease existed is still reclaimed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-x-legacy-reservation-'));
  const usagePath = join(dir, 'x-usage.sqlite');
  const config = {
    ...defaultXBookmarksLiveSyncConfig(),
    dailyResourceReadBudget: 12,
    dailyEstimatedSpendMicrousd: 1_000_000,
    headApiRequestReserve: 0,
    headResourceReadReserve: 0,
    headEstimatedSpendReserveMicrousd: 0,
  };
  const reservedAt = new Date('2026-08-18T12:00:00.000Z');
  let usage = new LocalXBookmarksApiUsageStore(usagePath);
  try {
    usage.reserveRequest({ account: ACCOUNT, requestedMaxResources: 6, config, now: reservedAt });
    usage.close();

    // The shape the old code left behind: dispatched, counted, no lease.
    const legacy = new Database(usagePath);
    legacy.exec('PRAGMA busy_timeout = 10000;');
    legacy.query('UPDATE x_api_request_reservations SET dispatch_by = NULL').run();
    legacy.close();

    usage = new LocalXBookmarksApiUsageStore(usagePath);
    expect(usage.status({ account: ACCOUNT, config, now: new Date('2026-08-18T12:01:00.000Z') }))
      .toMatchObject({ reserved_resource_reads: 0, resource_reads: 6 });
  } finally {
    usage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a settled in-flight reservation is never double-charged by the lease', () => {
  const usage = new LocalXBookmarksApiUsageStore(':memory:');
  const config = {
    ...defaultXBookmarksLiveSyncConfig(),
    dailyResourceReadBudget: 100,
    dailyEstimatedSpendMicrousd: 1_000_000,
    headApiRequestReserve: 0,
    headResourceReadReserve: 0,
    headEstimatedSpendReserveMicrousd: 0,
  };
  const reservedAt = new Date('2026-08-18T12:00:00.000Z');
  try {
    const reservation = usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 4,
      config,
      now: reservedAt,
    });
    usage.settleSuccess({
      reservation,
      resourceIds: ['a', 'b'],
      config,
      now: reservedAt,
    });
    expect(usage.status({ account: ACCOUNT, config, now: new Date('2026-08-18T13:00:00.000Z') }))
      .toMatchObject({
        reserved_resource_reads: 0,
        resource_reads: 2,
        estimated_spend_microusd: 2_000,
      });
  } finally {
    usage.close();
  }
});
