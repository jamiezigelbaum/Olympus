import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { DASHBOARD_LOCAL_CONTROL_SESSION_PATH, DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER, DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER, withWorkerBearerAuth } from '../src/workers/http.ts';

const origin = 'http://127.0.0.1:28190';
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-messaging-route-'));
  const values = new Map<string, string>();
  const worker = createEmailSourceWorker({ sourceDashboard: {
    sovereigntyEngine: {} as never,
    registryPath: join(dir, 'handles.json'),
    secretStore: { label: 'memory', get: async key => values.get(key), getSync: key => values.get(key), set: async (key, value) => { values.set(key, value); }, delete: async key => { values.delete(key); }, list: async () => [...values.keys()] },
    withMessagingCapturePaused: async (_source, operation) => operation(),
  } });
  const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'test-worker-token' });
  closers.push(() => { worker.close(); rmSync(dir, { recursive: true, force: true }); });
  return fetch;
}

async function mint(fetch: ReturnType<typeof fixture>, local: boolean) {
  const request = new Request(origin + (local ? DASHBOARD_LOCAL_CONTROL_SESSION_PATH : '/dashboard/control/session'), { method: 'POST', headers: { Origin: origin, ...(local ? {} : { Authorization: 'Bearer test-worker-token' }) } });
  recordRequestPeer(request, '127.0.0.1');
  const response = await fetch(request);
  expect(response.status).toBe(200);
  return { Cookie: response.headers.get('Set-Cookie')!.split(';')[0]!, Origin: origin, 'X-Olympus-CSRF': (await response.json() as { csrf_token: string }).csrf_token };
}
function post(headers: Record<string, string>, body = '{"source":"telegram"}', operation = 'status') {
  const request = new Request(origin + '/dashboard/messaging/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  recordRequestPeer(request, '127.0.0.1');
  return request;
}

test('messaging refuses bearer authority and forged internal context at the real HTTP wrapper', async () => {
  const fetch = fixture();
  expect((await fetch(post({ Authorization: 'Bearer test-worker-token', Origin: origin, [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local', [DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER]: 'forged' }))).status).toBe(403);
  const bearer = await mint(fetch, false);
  expect((await fetch(post(bearer))).status).toBe(403);
});

test('only a local session with its CSRF token can read pairing state', async () => {
  const fetch = fixture();
  const headers = await mint(fetch, true);
  const response = await fetch(post(headers));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect((await fetch(post({ ...headers, 'X-Olympus-CSRF': 'wrong' }))).status).toBe(403);
});

test('oversized or malformed credential requests return generic errors without reflecting values', async () => {
  const fetch = fixture();
  const headers = await mint(fetch, true);
  for (const body of ['{"value":"credential-secret"', JSON.stringify({ source: 'telegram', field: 'password', value: 'credential-secret'.repeat(3000) })]) {
    const response = await fetch(post(headers, body, 'respond'));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('credential-secret');
  }
});
