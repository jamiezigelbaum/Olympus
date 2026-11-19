import { expect, spyOn, test } from 'bun:test';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import {
  fitLocalAnalystRoutes, initializeLocalAnalystWindow, localAnalystPromptBudget, localAnalystPromptBytesForWindow,
  localAnalystWindow, localAnalystWindowNotice, localAnalystWindowReports, LOCAL_ANALYST_WINDOW_RETRY_INTERVAL_MS,
  reportLocalAnalystPromptOverride, resolveLocalAnalystWindow, setLocalAnalystWindow,
} from '../src/workers/source-index/local-analyst-window.ts';
import { withBuiltInFallback } from '../src/core/analyst-built-in.ts';
import { defaultConfig } from '../src/core/config.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { createSovereigntyAnalystMap } from '../src/workers/engine/runtime/private-analysts.ts';
import type { Analyst, EvidencePack } from '../src/core/contracts.ts';

for (const [server, body, path] of [
  ['llama.cpp', { default_generation_settings: { n_ctx: 32768 } }, '/props'],
  ['llama.cpp', { n_ctx: 32768 }, '/props'],
  ['vllm', { data: [{ id: 'answer', max_model_len: 32768 }] }, '/v1/models'],
  ['ollama', { models: [{ name: 'answer', context_length: 32768 }] }, '/api/ps'],
  ['lm-studio', { models: [{ max_context_length: 131072, loaded_instances: [{ id: 'answer', config: { context_length: 32768 } }] }] }, '/api/v1/models'],
] as const) {
  test(`${server} reads the served window`, async () => {
    const result = await resolveLocalAnalystWindow({ baseUrl: `http://${server}.test:8080/v1`, model: 'answer',
      fetchImpl: async (url, init) => {
        expect(init.method).toBe('GET');
        expect(init.body).toBeUndefined();
        expect(init.redirect).toBe('error');
        return new URL(url).pathname === path ? Response.json(body) : new Response('', { status: 404 });
      } });
    expect(result).toEqual({ windowTokens: 32768, source: 'server' });
  });
}
for (const body of [{ n_ctx_train: 131072 }, {}, { n_ctx: -1 }]) {
  test(`unknown served window ${JSON.stringify(body)} keeps fallback`, async () => {
    const window = await resolveLocalAnalystWindow({ baseUrl: 'http://localhost:8080/v1', model: 'answer', fetchImpl: async () => Response.json(body) });
    expect(window).toBeUndefined();
    expect(localAnalystPromptBudget(undefined, window, 1024)).toEqual({ bytes: 13500, source: 'fallback' });
  });
}
test('errors and unusable routes return undefined', async () => {
  expect(await resolveLocalAnalystWindow({ baseUrl: 'http://localhost:8080/v1', model: 'answer', fetchImpl: async () => { throw Error('offline'); } })).toBeUndefined();
  let calls = 0;
  for (const baseUrl of ['https://user:pw@example.com/v1', 'http://localhost:8080/v1?key=1', 'http://localhost:8080/router/v1', 'file:///tmp/v1']) {
    expect(await resolveLocalAnalystWindow({ baseUrl, model: 'answer', fetchImpl: async () => { calls++; return Response.json({ n_ctx: 32768 }); } })).toBeUndefined();
  }
  expect(calls).toBe(0);
  expect(await resolveLocalAnalystWindow({ baseUrl: 'http://localhost:8080/v1', model: 'answer', fetchImpl: async () => new Response('', { status: 500 }) })).toBeUndefined();
});
test('timeout covers fetch and body, without real time', async () => {
  const clock = createTestClock();
  const pending = resolveLocalAnalystWindow({ baseUrl: 'http://localhost:8080/v1', model: 'answer',
    fetchImpl: async () => new Promise<Response>(() => {}), scheduleTimeout: callback => {
      const timer = clock.setTimeout(callback, 2000);
      return () => clock.clearTimeout(timer);
    } });
  await clock.advance(2000);
  expect(await pending).toBeUndefined();
  expect(clock.pendingTimers()).toBe(0);
});
test('built-in manifest wins without probing', async () => {
  expect(await resolveLocalAnalystWindow({ model: QWEN35_4B.modelId, fetchImpl: async () => { throw Error('must not fetch'); } }))
    .toEqual({ windowTokens: QWEN35_4B.contextTokens, source: 'manifest' });
});
test('a configured window skips discovery and the byte override still wins', async () => {
  const fetchImpl = async () => { throw Error('must not fetch'); };
  const fetchSpy = spyOn({ fetchImpl }, 'fetchImpl');
  const window = await resolveLocalAnalystWindow({
    model: 'answer', baseUrl: 'http://localhost:8080/v1', contextTokens: 32768, fetchImpl: fetchSpy,
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(window).toEqual({ windowTokens: 32768, source: 'config' });
  expect(localAnalystPromptBytesForWindow(window!.windowTokens, 1024)).toBe(27000);
  expect(localAnalystPromptBudget(undefined, window, 1024)).toEqual({ bytes: 27000, source: 'config' });
  expect(localAnalystPromptBudget(22000, window, 1024)).toEqual({ bytes: 22000, source: 'env' });
});
test('formula, both clamps, and env priority', () => {
  expect(localAnalystPromptBytesForWindow(32768, 1024)).toBe(27000);
  expect(localAnalystPromptBytesForWindow(12288, 1024)).toBe(20480);
  expect(localAnalystPromptBytesForWindow(2048, 1024)).toBe(13500);
  expect(localAnalystPromptBudget(22000, { windowTokens: 32768, source: 'server' }, 1024)).toEqual({ bytes: 22000, source: 'env' });
});

test('a route shares its startup probe and caches its immediate result', async () => {
  for (const [body, asks] of [[{ n_ctx: 32768 }, 1], [{}, 4]] as const) {
    let calls = 0;
    const options = { baseUrl: 'http://localhost:8080/v1', model: 'answer', fetchImpl: async () => { calls++; return Response.json(body); } };
    await Promise.all([resolveLocalAnalystWindow(options), resolveLocalAnalystWindow(options)]);
    await resolveLocalAnalystWindow(options);
    expect(calls).toBe(asks);
  }
});
test('a keyed Sovereignty profile probes with its analyst credential and keeps it out of logs', async () => {
  const key = 'synthetic-private-probe-key';
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({ path, authorization: request.headers.get('authorization') });
      if (request.headers.get('authorization') !== `Bearer ${key}`) return new Response(null, { status: 401 });
      return Response.json({ default_generation_settings: { n_ctx: 32768 } });
    },
  });
  const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
    spyOn(console, method).mockImplementation(() => {}));
  try {
    const policy = loadSovereigntyPreset('local-only');
    Object.assign(policy.modelProfiles['local-source-answer']!, {
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      secretRef: 'env:TEST_LOCAL_PROBE_KEY',
    });
    const map = await createSovereigntyAnalystMap({
      engine: createSovereigntyEngine(policy),
      olympusConfig: defaultConfig(),
      env: { TEST_LOCAL_PROBE_KEY: key, OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES: '  ' },
      defaultLocal: fixedAnalyst(),
      veniceAnalystTimeoutMs: undefined,
      veniceReasoningHeadroomTokens: undefined,
    });
    expect(requests).toEqual([{ path: '/props', authorization: `Bearer ${key}` }]);
    expect(localAnalystWindow(map.get('local-source-answer')!.analyst)).toEqual({ windowTokens: 32768, source: 'server' });
    expect(JSON.stringify({ logs: logs.flatMap(log => log.mock.calls), reports: localAnalystWindowReports() })).not.toContain(key);
  } finally {
    for (const log of logs) log.mockRestore();
    server.stop(true);
  }
});

function fixedAnalyst(): Analyst {
  return { analyze: async () => ({ answer: 'ready', citations: [], unanswered: [] }) };
}

test('a failed probe retries in the background and refreshes the same routed analyst and report', async () => {
  const clock = createTestClock();
  const analyst = fixedAnalyst();
  const report = { analyst: 'retrying', model: 'answer' };
  let sweeps = 0;
  let finishProbe!: (reply: Response) => void;
  const pendingProbe = new Promise<Response>(resolve => { finishProbe = resolve; });
  const options = {
    baseUrl: 'http://retry.test:8080/v1',
    model: report.model,
    fetchImpl: async (url: string) => {
      if (new URL(url).pathname === '/props' && ++sweeps === 2) return pendingProbe;
      return new Response(null, { status: 404 });
    },
    scheduleRetry: clock.setTimeout,
  };
  await initializeLocalAnalystWindow(analyst, options, report);
  const routed = fitLocalAnalystRoutes(withBuiltInFallback(analyst, fixedAnalyst()), leaf => ({
    async analyze(pack, opts) {
      const { bytes } = localAnalystPromptBudget(undefined, localAnalystWindow(leaf), 1024);
      return { ...await leaf.analyze(pack, opts), answer: String(bytes) };
    },
  }));
  const pack: EvidencePack = {
    question: 'How many bytes?',
    candidates: [],
    coverage: { searchedCorpora: [], skippedCorpora: [], extractionGaps: [] },
    builtAt: clock.date().toISOString(),
  };
  const ask = () => routed.analyze(pack, { localOnly: true });
  const currentReport = () => localAnalystWindowReports().find(entry => entry.analyst === report.analyst);

  expect(currentReport()?.source).toBe('fallback');
  await clock.advance(LOCAL_ANALYST_WINDOW_RETRY_INTERVAL_MS - 1);
  expect(sweeps).toBe(1);
  await clock.advance(1);
  expect(sweeps).toBe(2);
  expect((await ask()).answer).toBe('13500');
  expect(currentReport()?.source).toBe('fallback');

  finishProbe(Response.json({ default_generation_settings: { n_ctx: 32768 } }));
  await flushMicrotasks();
  expect((await ask()).answer).toBe('27000');
  expect(currentReport()).toEqual({ ...report, source: 'server', windowTokens: 32768 });
  expect(await resolveLocalAnalystWindow(options)).toEqual({ source: 'server', windowTokens: 32768 });
  await clock.advance(LOCAL_ANALYST_WINDOW_RETRY_INTERVAL_MS);
  expect(sweeps).toBe(2);
});

test('different models on one endpoint share the retry interval', async () => {
  const clock = createTestClock();
  const attempts: number[] = [];
  const options = {
    baseUrl: 'http://pool.test:8080/v1',
    fetchImpl: async (url: string) => {
      if (new URL(url).pathname === '/props') attempts.push(clock.now());
      return new Response(null, { status: 404 });
    },
    scheduleRetry: clock.setTimeout,
  };
  const start = clock.now();
  await Promise.all([
    resolveLocalAnalystWindow({ ...options, model: 'first' }),
    resolveLocalAnalystWindow({ ...options, model: 'second' }),
  ]);
  await clock.advance(LOCAL_ANALYST_WINDOW_RETRY_INTERVAL_MS * 2);
  expect(attempts).toEqual([start, start, start + LOCAL_ANALYST_WINDOW_RETRY_INTERVAL_MS, start + LOCAL_ANALYST_WINDOW_RETRY_INTERVAL_MS * 2]);
});

test('only a fallback prompts the owner to set the served context size', () => {
  const report = { analyst: 'local-source-answer', model: 'answer' };
  expect(localAnalystWindowNotice({ ...report, source: 'fallback' }))
    .toBe('The private model\'s context size is unknown for profile "local-source-answer", so answers read fewer sources. Set contextTokens on the model profile.');
  for (const source of ['config', 'server', 'manifest', 'env'] as const) {
    expect(localAnalystWindowNotice({ ...report, source })).toBeUndefined();
  }
});
test('a different served model cannot supply the window', async () => {
  expect(await resolveLocalAnalystWindow({ model: 'answer', baseUrl: 'http://other-model.test:8080/v1',
    fetchImpl: async url => new URL(url).pathname === '/props' ? new Response('', { status: 404 })
      : Response.json({ data: [{ id: 'other', max_model_len: 99999 }], models: [{ name: 'other', context_length: 99999 }] }) })).toBeUndefined();
});

test('llama.cpp on port 8000 (Delphi) reads n_ctx, never a vLLM guess or the training length', async () => {
  const asked: string[] = [];
  expect(await resolveLocalAnalystWindow({ model: 'qwen36-35b-a3b-text', baseUrl: 'http://127.0.0.1:8000/v1', fetchImpl: async url => {
    asked.push(new URL(url).pathname);
    return Response.json({ default_generation_settings: { n_ctx: 32768 }, n_ctx_train: 262144 });
  } })).toEqual({ windowTokens: 32768, source: 'server' });
  expect(asked).toEqual(['/props']);
  expect(localAnalystPromptBudget(undefined, { windowTokens: 32768, source: 'server' }, 1024)).toEqual({ bytes: 27000, source: 'server' });
});

test('one bound covers every endpoint asked in turn', async () => {
  const clock = createTestClock();
  const asked: string[] = [];
  const pending = resolveLocalAnalystWindow({ baseUrl: 'http://slow.test:8080/v1', model: 'answer',
    fetchImpl: async url => {
      asked.push(new URL(url).pathname);
      if (new URL(url).pathname === '/props') return new Response('', { status: 404 });
      return new Promise<Response>(() => {});
    }, scheduleTimeout: callback => {
      const timer = clock.setTimeout(callback, 2000);
      return () => clock.clearTimeout(timer);
    } });
  await clock.advance(2000);
  expect(await pending).toBeUndefined();
  expect(asked).toEqual(['/props', '/v1/models']);
  expect(clock.pendingTimers()).toBe(0);
});

test('health reports each local analyst window, its fallback and the env override', () => {
  setLocalAnalystWindow({ analyze: async () => { throw Error('unused'); } }, { windowTokens: 32768, source: 'server' }, { analyst: 'delphi', model: 'qwen' });
  setLocalAnalystWindow({ analyze: async () => { throw Error('unused'); } }, undefined, { analyst: 'ollama', model: 'small' });
  reportLocalAnalystPromptOverride({ analyst: 'pinned', model: 'big' });
  expect(localAnalystWindowReports()).toEqual(expect.arrayContaining([
    { analyst: 'delphi', model: 'qwen', source: 'server', windowTokens: 32768 },
    { analyst: 'ollama', model: 'small', source: 'fallback' },
    { analyst: 'pinned', model: 'big', source: 'env' },
  ]));
});
