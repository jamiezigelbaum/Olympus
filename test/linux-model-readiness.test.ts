import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineStatusReport } from '../src/core/engine-cli.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { linuxModelReadiness } from '../src/core/linux-model-readiness.ts';
import { renderComputerHostPage } from '../src/workers/dashboard/host-page.ts';

test('fresh Linux models report actual downloads, lazy transcription and missing decoder remedy without downloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-model-status-'));
  try {
    const env = { HOME: root, XDG_DATA_HOME: root, OLYMPUS_BUILT_IN_EMBEDDING_DIR: join(root, 'embedding'), OLYMPUS_BUILT_IN_REASONING_DIR: join(root, 'reasoning'), OLYMPUS_BUILT_IN_TRANSCRIPTION_DIR: join(root, 'transcription') };
    const ready = linuxModelReadiness(env, { totalMemoryBytes: 16 * 1024 ** 3, decoderPresent: () => true });
    expect(ready.map(row => row.downloadBytes)).toEqual([484622336, 2740937888, 1019141728]);
    expect(ready[1]!.state).toBe('not_started'); expect(ready[2]!.state).toBe('not_needed');
    const missing = linuxModelReadiness(env, { totalMemoryBytes: 4 * 1024 ** 3, decoderPresent: () => false });
    expect(missing[1]!.state).toBe('unavailable'); expect(missing[1]!.detail).toContain('memory');
    expect(missing[2]!.detail).toContain('Install ffmpeg');
    const mac = renderComputerHostPage({ panelHtml: '<p>Frozen panel</p>', origin: 'http://127.0.0.1:8010' });
    expect(mac).not.toContain('Built-in models on this computer');
    const linux = renderComputerHostPage({ panelHtml: '<p>Frozen panel</p>', origin: 'http://127.0.0.1:8010', modelReadiness: missing });
    expect(linux).toContain('Install ffmpeg'); expect(linux).toContain('not have enough memory');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Linux engine status and local dashboard carry the worker model readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-model-surfaces-'));
  const rows = [{ name: 'Transcription', state: 'unavailable', detail: 'Install ffmpeg.', downloadBytes: 1019141728 }];
  const worker = createEmailSourceWorker({ localModelReadiness: () => rows });
  try {
    const html = await (await worker.fetch(new Request('http://127.0.0.1:8010/dashboard'))).text();
    expect(html).toContain('Install ffmpeg.');
    const report = await engineStatusReport({ homeDir: root, env: { HOME: root, XDG_RUNTIME_DIR: root }, platform: 'linux',
      exec: () => ({ status: 0, stdout: 'LoadState=not-found\nActiveState=inactive\n', stderr: '' }), openclawPath: () => undefined,
      fetchImpl: (async () => Response.json({ status: 'ok', built_in_models: rows, desktop_bridge: { state: 'port_in_use', remedy: 'Free the port or use the owner SSH socket forward.' } })) as unknown as typeof fetch });
    expect(report.worker).toMatchObject({ reachable: true, built_in_models: rows, desktop_bridge: { state: 'port_in_use', remedy: 'Free the port or use the owner SSH socket forward.' } });
  } finally { worker.close(); rmSync(root, { recursive: true, force: true }); }
});
