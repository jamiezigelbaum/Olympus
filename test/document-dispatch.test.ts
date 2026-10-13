import { expect, test } from 'bun:test';
import { fetchModelEndpoint } from '../src/core/model-transport.ts';
import {
  reportDocumentDigestProgress,
  runWithDocumentDispatch,
} from '../src/core/document-dispatch.ts';

test('document authorization is checked at the actual model fetch after asynchronous endpoint resolution', async () => {
  let calls = 0;
  const fetched = async () => { calls++; return new Response('{}'); };
  await expect(runWithDocumentDispatch(() => false, () => fetchModelEndpoint(fetched, 'https://api.venice.ai/api/v1/chat/completions', { method: 'POST', body: 'invented private evidence' }))).rejects.toThrow('Document authorization changed');
  expect(calls).toBe(0);
});
test('concurrent model calls keep their own document authorization', async () => {
  let calls = 0;
  const fetched = async () => { calls++; return new Response('{}'); };
  const out = await Promise.allSettled([
    runWithDocumentDispatch(() => false, async () => { await Promise.resolve(); return fetchModelEndpoint(fetched, 'https://api.venice.ai/api/v1/chat/completions', { method: 'POST' }); }),
    runWithDocumentDispatch(() => true, async () => { await Promise.resolve(); return fetchModelEndpoint(fetched, 'https://api.venice.ai/api/v1/chat/completions', { method: 'POST' }); }),
  ]);
  expect(out.map(item => item.status)).toEqual(['rejected', 'fulfilled']);
  expect(calls).toBe(1);
});

test('a nested source guard composes with the outer guard and inherits its observer', async () => {
  let calls = 0;
  let observed = 0;
  let installed: (() => boolean) | undefined;
  const fetched = async () => { calls++; return new Response('{}'); };
  await expect(runWithDocumentDispatch(
    () => false,
    () => runWithDocumentDispatch(
      () => true,
      () => fetchModelEndpoint(fetched, 'https://api.venice.ai/api/v1/chat/completions', { method: 'POST', body: '{}' }),
    ),
    {
      onGuard(current) { installed = current; },
      onRequest() { observed++; },
    },
  )).rejects.toThrow('Document authorization changed');
  expect(installed?.()).toBe(false);
  expect(calls).toBe(0);
  expect(observed).toBe(0);
});

test('request and count-only progress observers survive a nested dispatch context', async () => {
  const requests: string[] = [];
  const progress: unknown[] = [];
  await runWithDocumentDispatch(
    () => true,
    () => runWithDocumentDispatch(asyncCurrent, async () => {
      reportDocumentDigestProgress({ state: 'summarizing', documentsRead: 2, documentsTotal: 7 });
      await fetchModelEndpoint(
        async () => new Response('{}'),
        'https://api.venice.ai/api/v1/chat/completions',
        { method: 'POST', body: '{"model":"venice-fixture"}' },
      );
    }),
    {
      onGuard() {},
      onRequest(url) { requests.push(url); },
      onProgress(value) { progress.push(value); },
    },
  );
  expect(requests).toEqual(['https://api.venice.ai/api/v1/chat/completions']);
  expect(progress).toEqual([{ state: 'summarizing', documentsRead: 2, documentsTotal: 7 }]);
});

function asyncCurrent(): boolean { return true; }
