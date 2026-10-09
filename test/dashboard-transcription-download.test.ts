// Download now for the built-in transcription model: the engine's
// owner-requested install (the panel's Models row runs it through
// olympus_model_retry {model: 'transcription'}).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DASHBOARD_PREVIEW_NOW, buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';
import { createBuiltInTranscriber } from '../src/workers/file-extraction/extractors/built-in-transcriber.ts';
import { BuiltInReasoningInstallError } from '../src/workers/source-index/built-in-reasoning/install.ts';
import {
  readBuiltInTranscriptionStatus,
  reportBuiltInTranscriptionState,
  type BuiltInTranscriptionDashboardState,
} from '../src/workers/source-index/built-in-reasoning/transcription-model.ts';
import { QWEN3_ASR_06B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';

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
