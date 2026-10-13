import { expect, test } from 'bun:test';
import { fetchModelEndpoint } from '../src/core/model-transport.ts';
import { runWithDocumentDispatch } from '../src/core/document-dispatch.ts';

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
