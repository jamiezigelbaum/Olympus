import { expect, test } from 'bun:test';
import { createTestClock } from './helpers/test-clock.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import { resolveLocalAnalystWindow, localAnalystPromptBytesForWindow, localAnalystPromptBudget, setLocalAnalystWindow, reportLocalAnalystPromptOverride, localAnalystWindowReports } from '../src/workers/source-index/local-analyst-window.ts';

for (const [server, body, path] of [
  ['llama.cpp', { default_generation_settings: { n_ctx: 32768 } }, '/props'],
  ['llama.cpp', { n_ctx: 32768 }, '/props'],
  ['vllm', { data: [{ id: 'answer', max_model_len: 32768 }] }, '/v1/models'],
  ['ollama', { models: [{ name: 'answer', context_length: 32768 }] }, '/api/ps'],
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
test('formula, both clamps, and env priority', () => {
  expect(localAnalystPromptBytesForWindow(32768, 1024)).toBe(27000);
  expect(localAnalystPromptBytesForWindow(12288, 1024)).toBe(20480);
  expect(localAnalystPromptBytesForWindow(2048, 1024)).toBe(13500);
  expect(localAnalystPromptBudget(22000, { windowTokens: 32768, source: 'server' }, 1024)).toEqual({ bytes: 22000, source: 'env' });
});

test('one process probe caches both success and failure for a route', async () => {
  for (const [body, asks] of [[{ n_ctx: 32768 }, 1], [{}, 3]] as const) {
    let calls = 0;
    const options = { baseUrl: 'http://localhost:8080/v1', model: 'answer', fetchImpl: async () => { calls++; return Response.json(body); } };
    await Promise.all([resolveLocalAnalystWindow(options), resolveLocalAnalystWindow(options)]);
    await resolveLocalAnalystWindow(options);
    expect(calls).toBe(asks);
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
