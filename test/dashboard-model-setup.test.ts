import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';
import { createModelKeyReload, workerRestartsItself } from '../src/core/model-key-reload.ts';
import type { ModelSetupView } from '../src/core/model-setup.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';

function modelView(ready = false): ModelSetupView {
  return { ready, checked_at: '2026-09-14T12:00:00.000Z', cards: [
    { id: 'gemini', label: 'Gemini', required: true, state: ready ? 'ready' : 'not_configured', detail: 'Public and Personal embeddings.' },
    { id: 'venice', label: 'Venice', required: true, state: ready ? 'ready' : 'not_configured', detail: 'Private model processing.' },
  ] };
}

function segment(html: string, from: string, to: string): string {
  const start = html.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(to, start + from.length) + to.length);
}

test('model gate is enforced before source credential writes while model keys remain available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-model-gate-'));
  let modelWrites = 0;
  let sourceWrites = 0;
  const worker = createEmailSourceWorker({ sourceDashboard: {
    sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only')),
    registryPath: join(dir, 'handles.json'),
    modelSetup: () => modelView(),
    connectModelKey: async (source, key) => { expect(source).toBe('gemini'); expect(key).toBe('synthetic-key'); modelWrites++; },
    connectApiKey: async (options) => { sourceWrites++; return { ok: true, source: options.source, handles: [], secretRefs: [] }; },
  } });
  const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'test-control' });
  const post = (source: string, authenticated = true) => fetch(new Request('http://worker.test/dashboard/connect/api-key', {
    method: 'POST', headers: { ...(authenticated ? { Authorization: 'Bearer test-control' } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, api_key: 'synthetic-key' }),
  }));
  try {
    expect((await post('gemini', false)).status).toBe(401);
    expect((await post('readwise')).status).toBe(409);
    expect(sourceWrites).toBe(0);
    const saved = await post('gemini');
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain('synthetic-key');
    expect(modelWrites).toBe(1);
  } finally { worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('credential activation schedules one supervised reload after the response, never a foreground exit', async () => {
  const events: string[] = [];
  let scheduled: (() => void) | undefined;
  const request = createModelKeyReload({ managed: true,
    schedule: (run, delay) => { expect(delay).toBeGreaterThan(0); scheduled = run; events.push('scheduled'); },
    shutdown: async () => { events.push('shutdown'); }, exit: (code) => { expect(code).toBe(75); events.push('exit'); },
  });
  expect(request()).toBe(true); expect(request()).toBe(true);
  expect(events).toEqual(['scheduled']);
  scheduled!(); await new Promise((resolve) => setTimeout(resolve, 0));
  expect(events).toEqual(['scheduled', 'shutdown', 'exit']);
  expect(createModelKeyReload({ managed: false, shutdown: () => { throw new Error('must not stop'); }, exit: () => { throw new Error('must not exit'); } })()).toBe(false);
});

test('a worker restarts itself only after a validated native-service launch or under the generated unit, never on an ambient marker', () => {
  expect(workerRestartsItself({ nativeServiceSupervised: true }, {})).toBe(true);
  expect(workerRestartsItself({}, { OLYMPUS_MANAGED_WORKER: '1' })).toBe(true);
  // A foreground worker that inherited (or loaded from worker.env) a stale
  // native-service marker is not supervised: it must not exit 75 and stay down.
  expect(workerRestartsItself({}, { OLYMPUS_ENGINE_HOST: '1', OLYMPUS_NATIVE_SERVICE_INSTANCE_ID: '0f8fad5b-d9cb-469f-a165-70867728950e' })).toBe(false);
  expect(workerRestartsItself({ nativeServiceSupervised: false }, { OLYMPUS_NATIVE_SERVICE_INSTANCE_ID: '0f8fad5b-d9cb-469f-a165-70867728950e' })).toBe(false);
  expect(workerRestartsItself({}, {})).toBe(false);
});
