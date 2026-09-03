import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  parseSourceSchedulerMonitorTasks,
  runSourceSchedulerDeliverySmoke,
  runSourceSchedulerHealthMonitor,
} from '../scripts/source-scheduler-health-monitor.ts';

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

describe('source scheduler task-health monitor', () => {
  test('parses a generic bounded task selection and rejects duplicates', () => {
    expect(parseSourceSchedulerMonitorTasks('source.one/task.fast/300,source.two/task.daily/93600'))
      .toEqual([
        { sourceId: 'source.one', taskId: 'task.fast', maxAgeSeconds: 300 },
        { sourceId: 'source.two', taskId: 'task.daily', maxAgeSeconds: 93_600 },
      ]);
    expect(() => parseSourceSchedulerMonitorTasks('source.one/task.fast/300,source.one/task.fast/300'))
      .toThrow('duplicate source scheduler monitor task selection');
    expect(() => parseSourceSchedulerMonitorTasks('source.one/not allowed/300'))
      .toThrow('invalid source scheduler monitor task selection');
  });

  test('keeps a healthy sample counts-only and sends no notification', async () => {
    const fixture = monitorFixture();
    const requests: CapturedRequest[] = [];
    const fetchImpl = mockFetch(requests, () => schedulerResponse({
      lastSuccessAt: '2026-07-18T12:00:00.000Z',
    }));
    const result = await runSourceSchedulerHealthMonitor({
      env: fixture.env,
      fetchImpl,
      now: () => new Date('2026-07-18T12:01:00.000Z'),
    });

    expect(result).toMatchObject({ exitCode: 0, report: {
      status: 'healthy',
      monitored_tasks: 2,
      affected_tasks: 0,
      notification: 'not_needed',
    } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.headers).toEqual({ Authorization: 'Bearer worker-token' });
    const serialized = JSON.stringify(result.report);
    expect(serialized).not.toContain('x.bookmarks');
    expect(serialized).not.toContain('x.bookmarks_head');
    expect(readFileSync(fixture.reportPath, 'utf8')).not.toContain('x.bookmarks');
  });

  test('alerts once for stale/failing tasks, then suppresses duplicate attention', async () => {
    const fixture = monitorFixture();
    let now = new Date('2026-07-18T12:10:00.000Z');
    const requests: CapturedRequest[] = [];
    const fetchImpl = mockFetch(requests, () => schedulerResponse({
      lastSuccessAt: '2026-07-18T12:00:00.000Z',
      failures: 1,
    }));

    const first = await runSourceSchedulerHealthMonitor({ env: fixture.env, fetchImpl, now: () => now });
    expect(first).toMatchObject({ exitCode: 2, report: {
      status: 'attention',
      affected_tasks: 1,
      stale_tasks: 1,
      failing_tasks: 1,
      notification: 'sent',
    } });
    const wake = requests.find((request) => request.url.includes('/hooks/wake'));
    expect(wake).toBeDefined();
    const wakeBody = JSON.parse(String(wake?.init?.body));
    expect(wakeBody).toEqual({
      text: 'Olympus source synchronization needs attention: 1 of 2 monitored task(s) are stale, failing, or unavailable. Affected source(s): x.bookmarks. Inspect the scheduler health report.',
      mode: 'now',
    });
    expect(JSON.stringify(wake)).toContain('x.bookmarks');
    expect(JSON.stringify(wake)).not.toContain('x.bookmarks_head');

    now = new Date('2026-07-18T12:11:00.000Z');
    const before = requests.length;
    const second = await runSourceSchedulerHealthMonitor({ env: fixture.env, fetchImpl, now: () => now });
    expect(second.report.notification).toBe('suppressed');
    expect(requests.length).toBe(before + 1);
  });

  test('sends one generic recovery and rereads the wake token at send time', async () => {
    const fixture = monitorFixture();
    let now = new Date('2026-07-18T12:10:00.000Z');
    let attention = true;
    const requests: CapturedRequest[] = [];
    const fetchImpl = mockFetch(requests, () => schedulerResponse(attention
      ? { lastSuccessAt: '2026-07-18T12:00:00.000Z', failures: 1 }
      : { lastSuccessAt: now.toISOString() }));

    await runSourceSchedulerHealthMonitor({ env: fixture.env, fetchImpl, now: () => now });
    writeFileSync(fixture.tokenFile, 'second-hook-token\n', { mode: 0o600 });
    attention = false;
    now = new Date('2026-07-18T12:12:00.000Z');
    const recovered = await runSourceSchedulerHealthMonitor({ env: fixture.env, fetchImpl, now: () => now });
    expect(recovered).toMatchObject({ exitCode: 0, report: { status: 'healthy', notification: 'sent' } });
    const wakeRequests = requests.filter((request) => request.url.includes('/hooks/wake'));
    expect(wakeRequests).toHaveLength(2);
    expect(wakeRequests[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer hook-token' });
    expect(wakeRequests[1]?.init?.headers).toMatchObject({ Authorization: 'Bearer second-hook-token' });
    expect(String(wakeRequests[1]?.init?.body)).toContain('source synchronization recovered');
    expect(String(wakeRequests[1]?.init?.body)).not.toContain('x.bookmarks');

    now = new Date('2026-07-18T12:13:00.000Z');
    const third = await runSourceSchedulerHealthMonitor({ env: fixture.env, fetchImpl, now: () => now });
    expect(third.report.notification).toBe('not_needed');
    expect(requests.filter((request) => request.url.includes('/hooks/wake'))).toHaveLength(2);
  });

  test('enforces a fixed five-minute bootstrap grace and ignores an immediate no-success stale flag', async () => {
    const fixture = monitorFixture('x.bookmarks/x.bookmarks_reconcile/93600');
    let now = new Date('2026-07-18T12:00:00.000Z');
    const requests: CapturedRequest[] = [];
    const fetchImpl = mockFetch(requests, () => schedulerResponse({
      omitChronology: true,
      staleAnomaly: true,
      lastAttemptAt: '2026-07-18T11:59:00.000Z',
    }));

    const first = await runSourceSchedulerHealthMonitor({ env: fixture.env, fetchImpl, now: () => now });
    expect(first.report).toMatchObject({ status: 'healthy', stale_tasks: 0, notification: 'not_needed' });

    now = new Date('2026-07-18T12:05:01.000Z');
    const stale = await runSourceSchedulerHealthMonitor({ env: fixture.env, fetchImpl, now: () => now });
    expect(stale.report).toMatchObject({ status: 'attention', stale_tasks: 1, notification: 'sent' });
  });

  test('notifies again when the content-free affected task set changes', async () => {
    const fixture = monitorFixture();
    let now = new Date('2026-07-18T12:10:00.000Z');
    let headStale = false;
    const requests: CapturedRequest[] = [];
    const fetchImpl = mockFetch(requests, () => Response.json({
      kind: 'source_scheduler_status',
      enabled: true,
      running: true,
      sources: [{
        source_id: 'x.bookmarks',
        tasks: [
          {
            id: 'x.bookmarks_head',
            consecutive_failures: 0,
            stale_anomaly: headStale,
            last_success_at: headStale
              ? '2026-07-18T12:00:00.000Z'
              : now.toISOString(),
          },
          {
            id: 'x.bookmarks_reconcile',
            consecutive_failures: 1,
            stale_anomaly: false,
            last_success_at: '2026-07-17T00:00:00.000Z',
          },
        ],
      }],
    }));

    const reconcileOnly = await runSourceSchedulerHealthMonitor({ env: fixture.env, fetchImpl, now: () => now });
    expect(reconcileOnly.report).toMatchObject({
      status: 'attention',
      affected_tasks: 1,
      notification: 'sent',
    });

    headStale = true;
    now = new Date('2026-07-18T12:11:00.000Z');
    const expanded = await runSourceSchedulerHealthMonitor({ env: fixture.env, fetchImpl, now: () => now });
    expect(expanded.report).toMatchObject({
      status: 'attention',
      affected_tasks: 2,
      notification: 'sent',
    });
    expect(requests.filter((request) => request.url.includes('/hooks/wake'))).toHaveLength(2);
    expect(JSON.stringify(expanded.report)).toContain('x.bookmarks');
    expect(JSON.stringify(expanded.report)).not.toContain('x.bookmarks_head');
  });

  // A budget refusal and a provider failure were indistinguishable in the
  // report during the 2026-07-26 hold incident. The scheduler now records the
  // refusal kind honestly, so the report separates them from the kind alone.
  test('counts budget refusals separately from real failures without changing attention', async () => {
    const fixture = monitorFixture();
    const requests: CapturedRequest[] = [];
    const fetchImpl = mockFetch(requests, () => failingTasksResponse([
      { errorKind: 'api_request_guard', degradedReason: 'daily_api_request_guard' },
      { errorKind: 'reconcile_incomplete', degradedReason: 'x_reconcile_incomplete' },
    ]));
    const result = await runSourceSchedulerHealthMonitor({
      env: fixture.env,
      fetchImpl,
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });

    expect(result).toMatchObject({ exitCode: 2, report: {
      status: 'attention',
      affected_tasks: 2,
      affected_source_ids: ['x.bookmarks'],
      failing_tasks: 2,
      refused_tasks: 1,
      notification: 'sent',
    } });
    const wake = requests.find((request) => request.url.includes('/hooks/wake'));
    expect(JSON.parse(String(wake?.init?.body))).toEqual({
      text: 'Olympus source synchronization needs attention: 2 of 2 monitored task(s) are stale, failing, or unavailable. Affected source(s): x.bookmarks. Inspect the scheduler health report.',
      mode: 'now',
    });
    expect(JSON.stringify(result.report)).toContain('x.bookmarks');
    expect(JSON.stringify(result.report)).not.toContain('x.bookmarks_head');
    expect(JSON.stringify(result.report)).not.toContain('daily_api_request_guard');
  });

  test('never launders a typed real failure into a refusal, and reads an explicit guard kind', async () => {
    const fixture = monitorFixture();
    const stale = await runSourceSchedulerHealthMonitor({
      env: fixture.env,
      // A guard marker left behind by an earlier refusal must not make any
      // later failure look refused — not a typed network failure, and (since
      // the degraded_reason fallback was dropped) not the untyped kind either.
      fetchImpl: mockFetch([], () => failingTasksResponse([
        { errorKind: 'network', degradedReason: 'daily_cost_guard' },
        { errorKind: 'task_failed', degradedReason: 'daily_api_request_guard' },
      ])),
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    expect(stale.report).toMatchObject({ failing_tasks: 2, refused_tasks: 0 });

    const nearMiss = await runSourceSchedulerHealthMonitor({
      env: monitorFixture().env,
      // Exact tokens only: a kind that merely looks like a guard is a failure.
      fetchImpl: mockFetch([], () => failingTasksResponse([
        { errorKind: 'guard' },
        { errorKind: 'daily_cost_guardian' },
      ])),
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    expect(nearMiss.report).toMatchObject({ failing_tasks: 2, refused_tasks: 0 });

    const typed = await runSourceSchedulerHealthMonitor({
      env: monitorFixture().env,
      fetchImpl: mockFetch([], () => failingTasksResponse([
        { errorKind: 'api_request_guard' },
        { errorKind: 'readwise_daily_api_request_guard' },
      ])),
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    expect(typed.report).toMatchObject({ failing_tasks: 2, refused_tasks: 2 });
  });

  test('alerts generically when scheduler status is unavailable without leaking the error', async () => {
    const fixture = monitorFixture();
    const requests: CapturedRequest[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const normalized = String(url);
      requests.push({ url: normalized, init });
      if (normalized.includes('/source/scheduler/status')) throw new Error('private endpoint detail');
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const result = await runSourceSchedulerHealthMonitor({
      env: fixture.env,
      fetchImpl,
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });

    expect(result.report).toMatchObject({
      status: 'attention',
      scheduler_status_unavailable: true,
      affected_tasks: 2,
      notification: 'sent',
    });
    expect(JSON.stringify(result.report)).not.toContain('private endpoint detail');
    expect(String(requests.at(-1)?.init?.body)).not.toContain('private endpoint detail');
  });

  test('rejects remote or credential-bearing status and wake URLs before sending auth', async () => {
    const fixture = monitorFixture();
    const fetchImpl = (async () => {
      throw new Error('fetch must not run for unsafe configuration');
    }) as unknown as typeof fetch;
    await expect(runSourceSchedulerHealthMonitor({
      env: {
        ...fixture.env,
        OLYMPUS_SOURCE_SCHEDULER_MONITOR_STATUS_URL: 'https://remote.example/status',
      },
      fetchImpl,
    })).rejects.toThrow('must be a credential-free loopback http(s) URL');
    await expect(runSourceSchedulerHealthMonitor({
      env: {
        ...fixture.env,
        OLYMPUS_SOURCE_SCHEDULER_MONITOR_WAKE_HOOK_URL: 'http://user:password@127.0.0.1:18789/hooks/wake',
      },
      fetchImpl,
    })).rejects.toThrow('must be a credential-free loopback http(s) URL');
  });

  test('rejects symlinked or group-readable auth material', async () => {
    const fixture = monitorFixture();
    const linkedHeader = join(fixture.root, 'linked-worker-header');
    symlinkSync(fixture.authHeaderFile, linkedHeader);
    await expect(runSourceSchedulerHealthMonitor({
      env: {
        ...fixture.env,
        OLYMPUS_SOURCE_SCHEDULER_MONITOR_WORKER_AUTH_HEADER_FILE: linkedHeader,
      },
      fetchImpl: mockFetch([], () => schedulerResponse({ lastSuccessAt: '2026-07-18T12:00:00.000Z' })),
    })).rejects.toThrow('worker authorization header file must be a private regular file');

    chmodSync(fixture.tokenFile, 0o640);
    await expect(runSourceSchedulerHealthMonitor({
      env: fixture.env,
      fetchImpl: mockFetch([], () => schedulerResponse({ lastSuccessAt: '2026-07-18T12:00:00.000Z' })),
    })).rejects.toThrow('wake hook token file must be a private regular file');
  });

  test('keeps delivery failure as a failing exit while attention itself is successful', async () => {
    const fixture = monitorFixture('x.bookmarks/x.bookmarks_head/300');
    const fetchImpl = (async (url: string | URL | Request) => String(url).includes('/hooks/wake')
      ? new Response('{}', { status: 500 })
      : schedulerResponse({ lastSuccessAt: '2026-07-18T11:00:00.000Z', failures: 1 })) as typeof fetch;
    const result = await runSourceSchedulerHealthMonitor({
      env: fixture.env,
      fetchImpl,
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    expect(result).toMatchObject({ exitCode: 3, report: { status: 'attention', notification: 'failed' } });
  });

  test('sends a bounded explicit non-incident delivery smoke with a private report', async () => {
    const fixture = monitorFixture();
    const smokeReportPath = join(fixture.root, 'smoke', 'current.json');
    const requests: CapturedRequest[] = [];
    const result = await runSourceSchedulerDeliverySmoke({
      env: {
        ...fixture.env,
        OLYMPUS_SOURCE_SCHEDULER_MONITOR_DELIVERY_SMOKE_REPORT_PATH: smokeReportPath,
      },
      fetchImpl: mockFetch(requests, () => {
        throw new Error('status endpoint must not be read by delivery smoke');
      }),
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    expect(result).toMatchObject({
      exitCode: 0,
      report: {
        kind: 'source_scheduler_delivery_smoke_report',
        status: 'sent',
        policy: { explicit_non_incident: true, secrets_exposed: false },
      },
    });
    expect(requests).toHaveLength(1);
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.text).toContain('explicit non-incident test');
    expect(body.text).not.toContain('needs attention');
    expect(JSON.stringify(result.report)).not.toContain('x.bookmarks');
    expect(readFileSync(smokeReportPath, 'utf8')).not.toContain('hook-token');
  });

  // The activation gate's degrade verdict has to be visible per deploy, so it
  // hands the already-installed delivery-smoke lane a bounded counts-and-
  // tokens request instead of the non-incident text.
  test('consumes one bounded degrade notice through the same wake lane and never replays it', async () => {
    const fixture = monitorFixture();
    const smokeReportPath = join(fixture.root, 'smoke', 'current.json');
    const noticePath = join(fixture.root, 'smoke', 'degrade-notice-request.json');
    mkdirSync(join(fixture.root, 'smoke'), { recursive: true });
    writeFileSync(noticePath, JSON.stringify({
      kind: 'source_scheduler_degrade_notice_request',
      requested_at: '2026-07-18T11:59:30.000Z',
      reasons: ['reconcile_stale', 'advisory_degraded_reason'],
      monitored_tasks: 2,
      degraded_tasks: 1,
    }), { mode: 0o600 });
    const requests: CapturedRequest[] = [];
    const env = {
      ...fixture.env,
      OLYMPUS_SOURCE_SCHEDULER_MONITOR_DELIVERY_SMOKE_REPORT_PATH: smokeReportPath,
    };

    const degraded = await runSourceSchedulerDeliverySmoke({
      env,
      fetchImpl: mockFetch(requests, () => {
        throw new Error('status endpoint must not be read by a degrade notice');
      }),
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    expect(degraded).toMatchObject({
      exitCode: 0,
      report: {
        mode: 'degrade_notice',
        status: 'sent',
        reasons: ['reconcile_stale', 'advisory_degraded_reason'],
        policy: { explicit_non_incident: false, counts_only: true },
      },
    });
    const text = JSON.parse(String(requests[0]?.init?.body)).text;
    expect(text).toContain('DEGRADED');
    expect(text).toContain('1 of 2 monitored task(s)');
    expect(text).toContain('reconcile_stale, advisory_degraded_reason');
    expect(text).not.toContain('non-incident');
    expect(existsSync(noticePath)).toBe(false);

    const replayed = await runSourceSchedulerDeliverySmoke({
      env,
      fetchImpl: mockFetch(requests, () => new Response('{}', { status: 200 })),
      now: () => new Date('2026-07-18T12:00:05.000Z'),
    });
    expect(replayed.report).toMatchObject({ mode: 'delivery_smoke', status: 'sent' });
    expect(replayed.report.reasons).toBeUndefined();
    expect(String(requests[1]?.init?.body)).toContain('explicit non-incident test');
  });

  test('ignores a stale, malformed, or content-bearing degrade notice', async () => {
    for (const request of [
      { kind: 'wrong_kind', requested_at: '2026-07-18T11:59:59.000Z', reasons: ['x'], monitored_tasks: 2, degraded_tasks: 1 },
      { kind: 'source_scheduler_degrade_notice_request', requested_at: '2026-07-18T11:00:00.000Z', reasons: ['reconcile_stale'], monitored_tasks: 2, degraded_tasks: 1 },
      { kind: 'source_scheduler_degrade_notice_request', requested_at: '2026-07-18T11:59:59.000Z', reasons: [], monitored_tasks: 2, degraded_tasks: 1 },
      { kind: 'source_scheduler_degrade_notice_request', requested_at: '2026-07-18T11:59:59.000Z', reasons: ['x.bookmarks_reconcile is stale at /private/path'], monitored_tasks: 2, degraded_tasks: 1 },
      { kind: 'source_scheduler_degrade_notice_request', requested_at: '2026-07-18T11:59:59.000Z', reasons: ['reconcile_stale'], monitored_tasks: -1, degraded_tasks: 1 },
    ]) {
      const fixture = monitorFixture();
      const smokeReportPath = join(fixture.root, 'smoke', 'current.json');
      const noticePath = join(fixture.root, 'smoke', 'degrade-notice-request.json');
      mkdirSync(join(fixture.root, 'smoke'), { recursive: true });
      writeFileSync(noticePath, JSON.stringify(request), { mode: 0o600 });
      const requests: CapturedRequest[] = [];
      const result = await runSourceSchedulerDeliverySmoke({
        env: {
          ...fixture.env,
          OLYMPUS_SOURCE_SCHEDULER_MONITOR_DELIVERY_SMOKE_REPORT_PATH: smokeReportPath,
        },
        fetchImpl: mockFetch(requests, () => new Response('{}', { status: 200 })),
        now: () => new Date('2026-07-18T12:00:00.000Z'),
      });
      expect(result.report.mode).toBe('delivery_smoke');
      expect(String(requests[0]?.init?.body)).toContain('explicit non-incident test');
      expect(String(requests[0]?.init?.body)).not.toContain('/private/path');
    }
  });

  test('fails the explicit delivery smoke with only hashed diagnostics', async () => {
    const fixture = monitorFixture();
    const result = await runSourceSchedulerDeliverySmoke({
      env: {
        ...fixture.env,
        OLYMPUS_SOURCE_SCHEDULER_MONITOR_DELIVERY_SMOKE_REPORT_PATH: join(fixture.root, 'smoke-failed.json'),
      },
      fetchImpl: (async () => {
        throw new Error('private delivery failure');
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({
      exitCode: 3,
      report: { status: 'failed' },
    });
    expect(result.report.last_error_hash).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(result.report)).not.toContain('private delivery failure');
  });
});

function monitorFixture(tasks = 'x.bookmarks/x.bookmarks_head/300,x.bookmarks/x.bookmarks_reconcile/93600') {
  const root = mkdtempSync(join(tmpdir(), 'olympus-scheduler-health-monitor-'));
  const tokenFile = join(root, 'wake-token');
  const authHeaderFile = join(root, 'worker-header');
  const statePath = join(root, 'state', 'state.json');
  const reportPath = join(root, 'report', 'current.json');
  mkdirSync(join(root, 'state'));
  chmodSync(join(root, 'state'), 0o700);
  writeFileSync(tokenFile, 'hook-token\n', { mode: 0o600 });
  writeFileSync(authHeaderFile, 'Authorization: Bearer worker-token\n', { mode: 0o600 });
  return {
    root,
    authHeaderFile,
    tokenFile,
    reportPath,
    env: {
      OLYMPUS_SOURCE_SCHEDULER_MONITOR_TASKS: tasks,
      OLYMPUS_SOURCE_SCHEDULER_MONITOR_STATE_PATH: statePath,
      OLYMPUS_SOURCE_SCHEDULER_MONITOR_REPORT_PATH: reportPath,
      OLYMPUS_SOURCE_SCHEDULER_MONITOR_WORKER_AUTH_HEADER_FILE: authHeaderFile,
      OLYMPUS_SOURCE_SCHEDULER_MONITOR_STATUS_URL: 'http://127.0.0.1:8010/v1/source/scheduler/status',
      OLYMPUS_SOURCE_SCHEDULER_MONITOR_WAKE_HOOK_URL: 'http://127.0.0.1:18789/hooks/wake',
      OLYMPUS_SOURCE_SCHEDULER_MONITOR_WAKE_HOOK_TOKEN_FILE: tokenFile,
    },
  };
}

function schedulerResponse(options: {
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  failures?: number;
  omitChronology?: boolean;
  staleAnomaly?: boolean;
}): Response {
  const head = {
    id: 'x.bookmarks_head',
    consecutive_failures: options.failures ?? 0,
    stale_anomaly: options.staleAnomaly ?? false,
    ...(options.lastAttemptAt ? { last_attempt_at: options.lastAttemptAt } : {}),
    ...(options.omitChronology ? {} : { last_success_at: options.lastSuccessAt }),
  };
  const reconcile = {
    id: 'x.bookmarks_reconcile',
    consecutive_failures: 0,
    stale_anomaly: options.staleAnomaly ?? false,
    ...(options.lastAttemptAt ? { last_attempt_at: options.lastAttemptAt } : {}),
    ...(options.omitChronology
      ? {}
      : { last_success_at: options.lastSuccessAt ?? '2026-07-18T12:00:00.000Z' }),
  };
  return Response.json({
    kind: 'source_scheduler_status',
    enabled: true,
    running: true,
    sources: [{ source_id: 'x.bookmarks', tasks: [head, reconcile] }],
  });
}

function failingTasksResponse(
  failures: readonly { errorKind?: string; degradedReason?: string }[],
): Response {
  return Response.json({
    kind: 'source_scheduler_status',
    enabled: true,
    running: true,
    sources: [{
      source_id: 'x.bookmarks',
      tasks: ['x.bookmarks_head', 'x.bookmarks_reconcile'].map((id, index) => ({
        id,
        consecutive_failures: 1,
        stale_anomaly: false,
        last_success_at: '2026-07-18T11:59:00.000Z',
        last_result: { status: 'failed' },
        ...(failures[index]?.errorKind ? { last_error_kind: failures[index]?.errorKind } : {}),
        ...(failures[index]?.degradedReason
          ? { degraded_reason: failures[index]?.degradedReason }
          : {}),
      })),
    }],
  });
}

function mockFetch(
  requests: CapturedRequest[],
  statusResponse: () => Response,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const normalized = String(url);
    requests.push({ url: normalized, init });
    return normalized.includes('/source/scheduler/status')
      ? statusResponse()
      : new Response('{}', { status: 200 });
  }) as typeof fetch;
}
