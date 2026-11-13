import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelThread } from '../src/workers/source-index/built-in-reasoning/off-thread.ts';
import { installPinnedModel, readPinnedModelStatus, type BuiltInReasoningStatus, type PinnedModelLayout } from '../src/workers/source-index/built-in-reasoning/install.ts';
import { createLlamaServerHandle } from '../src/workers/source-index/built-in-reasoning/server.ts';
import { builtInTranscriptionDashboardState } from '../src/workers/source-index/built-in-reasoning/transcription-model.ts';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('health and dashboard requests answer throughout blocking install and first-start work', async () => {
  const worker = new ModelThread(join(import.meta.dir, 'fixtures/built-in-model-blocking-worker.ts'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request =>
    Response.json(new URL(request.url).pathname === '/health' ? { ok: true } : { models: { state: 'loading' } }) });
  try {
    for (const request of [{ kind: 'install' as const, options: { bundle: { modelId: 'fixture', displayName: 'Fixture', files: [] }, layout: { root: '/unused', modelDir: '/unused', runtimeDir: '/unused', statusPath: '/unused', lockPath: '/unused', runtimeLockPath: '/unused', noun: 'model' } } }, { kind: 'start' as const, handle: 1,
      launch: { serverPath: '', modelPath: '', contextTokens: 1, gpu: false, threads: 1, idleShutdownSeconds: 0, startupTimeoutMs: 1_000 } }]) {
      let entered!: () => void;
      const blocking = new Promise<void>(resolve => { entered = resolve; });
      let finished = false;
      const operation = worker.call(request, { timeoutMs: 2_000, log: () => entered() }).then(() => { finished = true; });
      await blocking;
      for (const path of ['/health', '/dashboard']) {
        const started = Date.now();
        const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { signal: AbortSignal.timeout(300) });
        expect(response.ok).toBe(true);
        await response.json();
        expect(Date.now() - started).toBeLessThan(300);
        expect(finished).toBe(false);
      }
      await operation;
    }
  } finally { await worker.call({ kind: 'shutdown' }); server.stop(true); }
}, 10_000);

test('the shipped lifecycle worker installs pinned bytes, reports speech progress and starts/stops an authenticated server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-model-thread-'));
  let releaseDownload!: () => void;
  const downloadGate = new Promise<void>(resolve => { releaseDownload = resolve; });
  const script = join(dir, 'llama-server');
  writeFileSync(script, `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst value = flag => args[args.indexOf(flag) + 1];\nconst token = (await Bun.file(value('--api-key-file')).text()).trim();\nconst ready = Date.now() + 500;\nBun.serve({ hostname: '127.0.0.1', port: Number(value('--port')), fetch(request) {\n if (new URL(request.url).pathname === '/health') return Date.now() < ready ? new Response(null, { status: 503 }) : Response.json({});\n if (request.headers.get('authorization') !== 'Bearer ' + token) return new Response(null, { status: 401 });\n return Response.json({ data: [{ id: process.env.LLAMA_ARG_ALIAS }] });\n} });\n`);
  chmodSync(script, 0o755);
  const archivePath = join(dir, 'runtime.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', dir, 'llama-server'], { timeout: 5_000 });
  const archive = readFileSync(archivePath);
  const model = new TextEncoder().encode('synthetic weights');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/runtime') { await downloadGate; return new Response(archive); }
    return new Response(model);
  } });
  const url = `http://127.0.0.1:${server.port}`;
  const layout: PinnedModelLayout = { root: dir, modelDir: join(dir, 'model'), runtimeDir: join(dir, 'runtime'),
    statusPath: join(dir, 'status.json'), lockPath: join(dir, 'model.lock'), runtimeLockPath: join(dir, 'runtime.lock'), noun: 'built-in transcription model' };
  const progress: BuiltInReasoningStatus[] = [];
  const installed = installPinnedModel({
    bundle: { modelId: 'fixture', displayName: 'Fixture', files: [{ name: 'm.gguf', url: `${url}/model`, bytes: model.length, sha256: digest(model) }] },
    layout, platform: 'linux-x64', spaceHeadroomBytes: 0,
    runtime: { release: 'fixture', license: 'MIT', archives: [{ platform: 'linux-x64', name: 'runtime.tar.gz', url: `${url}/runtime`, bytes: archive.length, sha256: digest(archive), gpu: false }] },
    onProgress: status => progress.push(status), log: () => {},
  });
  let handle: ReturnType<typeof createLlamaServerHandle> | undefined;
  try {
    const deadline = Date.now() + 3_000;
    while (!progress.some(status => status.state === 'downloading') && Date.now() < deadline) await Bun.sleep(5);
    const status = readPinnedModelStatus(layout.statusPath, 'fixture', layout.noun);
    expect(builtInTranscriptionDashboardState({ file: 'current', status }, { installing: true }).state).toBe('downloading');
    releaseDownload();
    const paths = await installed;
    expect(progress.map(status => status.state)).toContain('verifying');
    expect(readPinnedModelStatus(layout.statusPath, 'fixture', layout.noun).state).toBe('ready');
    handle = createLlamaServerHandle({ serverPath: paths.serverPath, modelPath: paths.filePaths[0]!,
      contextTokens: 1, gpu: false, threads: 1, idleShutdownSeconds: 0, startupTimeoutMs: 3_000 });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const cancelled = handle.ensureRunning(controller.signal).catch(error => error as Error);
    const starting = handle.ensureRunning();
    controller.abort(reason);
    expect(await cancelled).toMatchObject({ name: 'AbortError', cause: reason });
    const [first, second] = await Promise.all([starting, handle.ensureRunning()]);
    expect(first).toEqual(second);
    expect(handle.pid).toBeGreaterThan(0);
    expect((await fetch(`${first.baseUrl}/v1/models`, { signal: AbortSignal.timeout(1_000) })).status).toBe(401);
    await handle.stop();
    expect(handle.pid).toBeUndefined();
    const exitScript = join(dir, 'exit.ts');
    const pidPath = join(dir, 'server-pid');
    writeFileSync(exitScript, `
      import { createLlamaServerHandle } from ${JSON.stringify(join(import.meta.dir, '../src/workers/source-index/built-in-reasoning/server.ts'))};
      import { writeFileSync } from 'node:fs';
      const handle = createLlamaServerHandle(${JSON.stringify({ serverPath: paths.serverPath, modelPath: paths.filePaths[0], contextTokens: 1, gpu: false, threads: 1, idleShutdownSeconds: 0, startupTimeoutMs: 3_000 })});
      await handle.ensureRunning();
      writeFileSync(${JSON.stringify(pidPath)}, String(handle.pid));
      process.exit(0);
    `);
    execFileSync(process.execPath, [exitScript], { timeout: 8_000 });
    const pid = Number(readFileSync(pidPath, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    releaseDownload(); await installed.catch(() => {}); await handle?.stop(); server.stop(true); rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
