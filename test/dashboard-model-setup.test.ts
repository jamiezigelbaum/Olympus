import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';
import { createModelKeyReload, workerRestartsItself } from '../src/core/model-key-reload.ts';
import type { ModelSetupView } from '../src/core/model-setup.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
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

test('locked sources show private-model bytes and a failed download offers Try again', async () => {
  const { renderModelSetupBlocker, dashboardModelsBlockedReason } = await import('../src/workers/dashboard/model-setup.ts');
  const base = { ready: false, checked_at: new Date().toISOString(), cards: [] };
  const downloading = { ...base, private_model: { state: 'downloading' as const, bytesDone: 1.4e9, bytesTotal: 2.7e9 } };
  expect(dashboardModelsBlockedReason(downloading)).toContain('Downloading the private answer model: 1.4 of 2.7 GB');
  expect(renderModelSetupBlocker(downloading)).toContain('1.4 of 2.7 GB');
  const failed = renderModelSetupBlocker({ ...base, private_model: { state: 'failed', bytesDone: 0, bytesTotal: 2.7e9 } });
  expect(failed).toContain('download failed');
  expect(failed).toContain('Try again');
  expect(failed).toContain('data-model-retry');
});

test('model bytes keep refreshing while the first-run choice sheet stays in place', async () => {
  const { Window } = await import('happy-dom');
  const { mountDashboardController } = await import('../src/control-ui/browser-controller.ts');
  const { renderModelSetup, renderModelSetupBlocker } = await import('../src/workers/dashboard/model-setup.ts');
  const happy = new Window({ url: 'http://127.0.0.1:8010/dashboard?keys' });
  const names = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS'];
  const old = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const abort = new AbortController();
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? happy : (happy as any)[name] });
    const root = happy.document.createElement('div');
    const initial: ModelSetupView = { ready: false, privacy_choice_pending: true, checked_at: new Date().toISOString(), cards: [], private_model: { state: 'downloading', bytesDone: 1.4e9, bytesTotal: 2.7e9 } };
    root.innerHTML = renderModelSetup(initial);
    happy.document.body.append(root);
    const fresh = { ...initial, privacy_choice_pending: false, private_model: { ...initial.private_model!, bytesDone: 2e9 } };
    const controller = mountDashboardController({ root: root as any, transport: { control: async () => ({ status: 200, body: { ok: true } }) }, navigate: () => {},
      refresh: async () => ({ status: 200, title: 'Olympus', body: renderModelSetupBlocker(fresh) + renderModelSetup(fresh), controller: 'dashboard', can_write: true, signature: 'new', poll_interval_ms: 0 }),
      returnUrl: happy.location.href, canWrite: true, signal: abort.signal, pollIntervalMs: 0,
    });
    const sheet = root.querySelector('[data-first-run-sheet]');
    root.querySelector('form[data-first-run-privacy]')!.dispatchEvent(new happy.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    await controller.refresh();
    expect(root.querySelector('[data-first-run-sheet]')).toBe(sheet);
    expect(root.textContent).toContain('2.0 of 2.7 GB');
  } finally {
    abort.abort(); happy.close();
    for (const name of names) { const descriptor = old.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  }
});


test('a ready legacy embedding installation keeps its migration notice visible outside collapsed key forms', async () => {
  const { renderModelSetup } = await import('../src/workers/dashboard/model-setup.ts');
  const view = modelView(true);
  view.migration_notes = ['Legacy embeddings: preserve vectors until an explicitly approved migration.'];
  const html = renderModelSetup(view);
  const note = html.indexOf('data-embedding-migration');
  expect(note).toBeGreaterThan(-1);
  expect(note).toBeLessThan(html.indexOf('<div class="modelcards">'));
  expect(html).toContain('preserve vectors');
  expect(html).toContain('docs/SOVEREIGNTY_CONFIG.md');
  expect(html).not.toContain('aistudio.google.com');
  expect(html).toContain('Existing Gemini installations only');
});
