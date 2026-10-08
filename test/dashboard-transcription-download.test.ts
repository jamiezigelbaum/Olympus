// Download now for the built-in transcription model: the Models row's button,
// its control route (the same session checks as Try again on a model), and
// the engine's owner-requested install.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DASHBOARD_PREVIEW_NOW, buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';
import { parseDashboardControlParams } from '../src/core/control-ui-gateway.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { dashboardModelsSection, dashboardSourceStates } from '../src/workers/dashboard/source-rows.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createBuiltInTranscriber } from '../src/workers/file-extraction/extractors/built-in-transcriber.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { BuiltInReasoningInstallError } from '../src/workers/source-index/built-in-reasoning/install.ts';
import {
  readBuiltInTranscriptionStatus,
  reportBuiltInTranscriptionState,
  type BuiltInTranscriptionDashboardState,
} from '../src/workers/source-index/built-in-reasoning/transcription-model.ts';
import { QWEN3_ASR_06B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';

function models(transcription: BuiltInTranscriptionDashboardState, controls = true): string {
  const view = buildDashboardPreviewView('review');
  const options = {
    now: DASHBOARD_PREVIEW_NOW,
    ...(controls ? { controlSessionCsrfToken: 'csrf' } : {}),
    modelInstalls: { embedding: { kind: 'built_in' as const, state: 'ready' as const }, transcription },
  };
  return dashboardModelsSection(dashboardSourceStates(view, options), view, options);
}

describe('the Models row offers Download now', () => {
  test('while not needed, and after a failed download; never while downloading or ready', () => {
    const button = '<form class="rowform" data-model-retry="transcription"><button class="btn" type="submit">Download now</button>';
    expect(models({ state: 'not_needed' })).toContain(button);
    expect(models({ state: 'failed', failedReason: 'network' })).toContain(button);
    expect(models({ state: 'downloading', percent: 10 })).not.toContain('Download now');
    expect(models({ state: 'ready' })).not.toContain('Download now');
  });

  test('without an unlocked control session it links to the unlock, never posts', () => {
    const html = models({ state: 'not_needed' }, false);
    expect(html).toContain('Download now');
    expect(html).not.toContain('data-model-retry="transcription"');
  });

  test('the native control surface accepts the transcription model and nothing else new', () => {
    expect(parseDashboardControlParams({ action: 'retry_model', model: 'transcription' }))
      .toEqual({ action: 'retry_model', model: 'transcription' });
    expect(() => parseDashboardControlParams({ action: 'retry_model', model: 'whisper' })).toThrow();
  });
});

describe('the Download now route', () => {
  test('authorized: starts it, or answers a no-op when already downloaded; unauthorized: refused; not built in: 409', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-asr-download-route-'));
    const outcomes: Array<'started' | 'loading' | 'ready' | 'unavailable'> = ['started', 'ready', 'loading', 'unavailable'];
    let calls = 0;
    const worker = createEmailSourceWorker({ sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only')),
      registryPath: join(dir, 'handles.json'),
      downloadTranscriptionModel: () => outcomes[calls++] ?? 'unavailable',
    } });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'test-control' });
    const post = (authenticated = true) => fetch(new Request('http://worker.test/dashboard/models/retry', {
      method: 'POST',
      headers: { ...(authenticated ? { Authorization: 'Bearer test-control' } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'transcription' }),
    }));
    try {
      expect((await post(false)).status).toBe(401);
      expect(calls).toBe(0);
      const started = await post();
      expect(started.status).toBe(200);
      expect(await started.json()).toEqual({ ok: true, status_message: 'Downloading the transcription model. This row updates as it goes.' });
      const ready = await post();
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ ok: true, status_message: 'Already downloaded.' });
      const loading = await post();
      expect(loading.status).toBe(200);
      expect(await loading.json()).toEqual({ ok: true, status_message: 'Starting the transcription model again. This row updates as it goes.' });
      const unavailable = await post();
      expect(unavailable.status).toBe(409);
      expect(calls).toBe(4);
    } finally {
      worker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the engine\'s owner-requested download', () => {
  const env = () => ({
    OLYMPUS_BUILT_IN_TRANSCRIPTION_DIR: mkdtempSync(join(tmpdir(), 'olympus-asr-dl-')),
    OLYMPUS_BUILT_IN_REASONING_DIR: mkdtempSync(join(tmpdir(), 'olympus-asr-dl-')),
  });
  const installed = { modelPath: '/m', mmprojPath: '/p', serverPath: '/s', gpu: true };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('starts with no audio waiting, is a no-op once ready, and keeps the memory gate', async () => {
    let attempts = 0;
    const engine = createBuiltInTranscriber({
      env: env(), platform: 'darwin-arm64', totalMemoryBytes: 16 * 1024 ** 3,
      install: async () => { attempts += 1; return installed; },
    });
    expect(engine.downloadNow?.()).toBe('pending');
    await settle();
    expect(engine.downloadNow?.()).toBe('ready');
    expect(attempts).toBe(1);
    const small = createBuiltInTranscriber({ env: env(), totalMemoryBytes: 4 * 1024 ** 3, install: async () => installed });
    expect(small.downloadNow?.()).toBe('unavailable');
  });

  test('installing() is true only while this process downloads or checks', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const engine = createBuiltInTranscriber({
      env: env(), platform: 'darwin-arm64', totalMemoryBytes: 16 * 1024 ** 3,
      install: async () => { await gate; return installed; },
    });
    expect(engine.installing?.()).toBe(false);
    engine.downloadNow?.();
    expect(engine.installing?.()).toBe(true);
    finish();
    await gate;
    await settle();
    expect(engine.installing?.()).toBe(false);
  });

  test('a model whose server would not start is started again by the click, not reported as downloaded', async () => {
    const dirs = env();
    let starts = 0;
    const engine = createBuiltInTranscriber({
      env: dirs, platform: 'darwin-arm64', totalMemoryBytes: 16 * 1024 ** 3,
      install: async () => installed,
      createServer: () => ({
        pid: undefined,
        async ensureRunning() { starts += 1; return { baseUrl: 'http://127.0.0.1:1', token: 't' }; },
        touch() {},
        async stop() {},
      }),
    });
    engine.prepare();
    await settle();
    expect(engine.downloadNow?.()).toBe('ready');
    expect(starts).toBe(0);
    reportBuiltInTranscriptionState(dirs, QWEN3_ASR_06B, 'failed', { reason: 'runtime_load_failed', message: 'x' });
    expect(engine.downloadNow?.()).toBe('loading');
    await settle();
    expect(starts).toBe(1);
    expect(readBuiltInTranscriptionStatus(dirs).state).toBe('ready');
  });

  test('a click skips a failed install\'s backoff with one immediate attempt', async () => {
    let clock = 0;
    let attempts = 0;
    const engine = createBuiltInTranscriber({
      env: env(), platform: 'darwin-arm64', totalMemoryBytes: 16 * 1024 ** 3,
      install: async () => { attempts += 1; throw new BuiltInReasoningInstallError('checksum_mismatch', 'bad'); },
      installRetryMs: 60_000,
      now: () => clock,
    });
    engine.prepare();
    await settle();
    expect(attempts).toBe(1);
    // Inside the backoff: the scheduler's prepare waits, the owner's click does not.
    clock = 1_000;
    engine.prepare();
    await settle();
    expect(attempts).toBe(1);
    engine.downloadNow?.();
    await settle();
    expect(attempts).toBe(2);
    // Each failure's backoff is skipped by one click: one immediate attempt, never a loop.
    clock = 2_000;
    engine.downloadNow?.();
    await settle();
    expect(attempts).toBe(3);
    clock = 3_000;
    engine.downloadNow?.();
    await settle();
    expect(attempts).toBe(4);
  });
});
