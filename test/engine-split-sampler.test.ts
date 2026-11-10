// The engine split's live sampler (scripts/engine-split-sampler.ts) against a
// fake worker: it reads only with GETs, reports the four done-when metrics
// per interval, and never prints the worker token.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findWorkerPids, runSampler } from '../scripts/engine-split-sampler.ts';
import { createTestClock, waitFor } from './helpers/test-clock.ts';

const TOKEN = 'sampler-test-token-0123456789';

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { server?.stop(true); server = undefined; });

describe('engine split sampler', () => {
  test('reports dashboard reads, the longest heartbeat, the judge backlog and RSS, read-only', async () => {
    const clock = createTestClock();
    const seen: Array<{ method: string; path: string; auth: string | null }> = [];
    let checking = 1_000;
    let beats = 0;
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const url = new URL(request.url);
        seen.push({ method: request.method, path: url.pathname, auth: request.headers.get('authorization') });
        if (url.pathname === '/dashboard.json') {
          clock.set(clock.now() + 400); // the dashboard read takes 400 ms
          return Response.json({ ok: true });
        }
        if (url.pathname === '/v1/source/index/status') {
          const body = { tier_classification: { checking_items: checking, remaining_questions: checking * 2 } };
          checking -= 150; // 150 fewer items still being checked each interval
          return Response.json(body);
        }
        if (url.pathname === '/v1/health') {
          beats += 1;
          if (beats === 3) clock.set(clock.now() + 2_500); // one frozen heartbeat
          return Response.json({ status: 'ok' });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const lines: Array<Record<string, any>> = [];
    let finished = false;
    const run = runSampler({
      apiBase: `http://127.0.0.1:${server.port}/v1`,
      authToken: TOKEN,
      clock,
      intervalMs: 60_000,
      heartbeatMs: 1_000,
      dashboardReads: 3,
      intervals: 2,
      pids: () => ({ worker: 101, background: 202 }),
      rssMb: (pid) => (pid === 101 ? 640 : 210),
      emit: (line) => lines.push(line),
    }).finally(() => { finished = true; });
    // The sampler is sequential: a pending timer means it is sleeping, never mid-request.
    while (!finished) {
      if (!(await clock.advanceToNext())) await waitFor(() => finished || clock.pendingTimers() > 0);
    }
    await run;

    expect(lines).toHaveLength(2);
    const [first, second] = lines;
    expect(first!.dashboard_read_ms).toMatchObject({ n: 3, p50: 400, max: 400, failures: 0 });
    expect(first!.heartbeat_ms.max).toBe(2_500);
    expect(first!.heartbeat_ms.failures).toBe(0);
    expect(first!.judge).toEqual({ checking_items: 1_000, remaining_questions: 2_000, net_verdicts_per_min: null });
    expect(second!.judge.checking_items).toBe(850);
    // 150 fewer over the 60 s interval between the two status reads.
    expect(second!.judge.net_verdicts_per_min).toBe(150);
    expect(first!.rss_mb).toEqual({ worker: 640, background: 210 });

    // Read-only: GETs only, the token only as the bearer on authenticated reads, never in a URL.
    expect(seen.every((request) => request.method === 'GET')).toBe(true);
    expect(seen.filter((request) => request.path === '/v1/health').every((request) => request.auth === null)).toBe(true);
    expect(seen.filter((request) => request.path !== '/v1/health').every((request) => request.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  test('counts a worker that refuses as failures and still emits a line', async () => {
    const clock = createTestClock();
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('no', { status: 503 }) });
    const lines: Array<Record<string, any>> = [];
    let finished = false;
    const run = runSampler({
      apiBase: `http://127.0.0.1:${server.port}/v1`,
      clock,
      intervalMs: 5_000,
      heartbeatMs: 1_000,
      dashboardReads: 2,
      intervals: 1,
      emit: (line) => lines.push(line),
    }).finally(() => { finished = true; });
    while (!finished) {
      if (!(await clock.advanceToNext())) await waitFor(() => finished || clock.pendingTimers() > 0);
    }
    await run;
    expect(lines[0]!.dashboard_read_ms).toEqual({ n: 0, failures: 2 });
    expect(lines[0]!.heartbeat_ms.failures).toBe(lines[0]!.heartbeat_ms.n);
    expect(lines[0]!.judge).toEqual({ error: 'HTTP 503' });
    expect(lines[0]!.rss_mb).toEqual({ worker: null, background: null });
  });

  test('finds the worker and background by command line and the one role entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-sampler-proc-'));
    try {
      const proc = (pid: number, argv: string[], environ: string[]) => {
        mkdirSync(join(root, String(pid)));
        writeFileSync(join(root, String(pid), 'cmdline'), `${argv.join('\0')}\0`);
        writeFileSync(join(root, String(pid), 'environ'), environ.length ? `${environ.join('\0')}\0` : '');
      };
      proc(10, ['bun', '--no-env-file', 'cli.js', '__worker-service-run', 'abc'], ['HOME=/h', 'OLYMPUS_WORKER_ENGINE_ROLE=front']);
      proc(11, ['bun', '--no-env-file', 'cli.js', '__worker-service-run', 'abc'], ['OLYMPUS_WORKER_ENGINE_ROLE=background']);
      proc(12, ['bun', 'something-else'], ['OLYMPUS_WORKER_ENGINE_ROLE=background']);
      expect(findWorkerPids(root)).toEqual({ worker: 10, background: 11 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
