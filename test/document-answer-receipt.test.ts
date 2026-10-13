import { expect, test } from 'bun:test';
import { createPrivateDocumentRequests } from '../src/core/private-document-requests.ts';
import { fetchModelEndpoint } from '../src/core/model-transport.ts';
import { reportDocumentDigestProgress, runWithDocumentDispatch } from '../src/core/document-dispatch.ts';
import { withDocumentAnswerReceipt } from '../src/core/document-answer-receipt.ts';

const VENICE = 'https://api.venice.ai/api/v1/chat/completions';

test('the caller receives its original value while the private page gets the exact Venice request and model', async () => {
  const jobs = createPrivateDocumentRequests();
  const body = '{"model":"venice/model-a","messages":[{"role":"user","content":"invented digest 71"}]}';
  const value = { reply: 'Invented answer', marker: Symbol('unchanged') };
  const returned = await withDocumentAnswerReceipt({
    jobs,
    question: 'Review invented records',
    authorized: () => true,
    async work() {
      reportDocumentDigestProgress({ state: 'summarizing', documentsRead: 3, documentsTotal: 9 });
      await fetchModelEndpoint(async () => new Response('{}'), VENICE, { method: 'POST', body, headers: { Authorization: 'Bearer never-record-this' } });
      return value;
    },
    describe: result => ({ reply: result.reply, answeredByVenice: true }),
  });
  expect(returned).toBe(value);
  await settle();
  const view = (await jobs.list())[0]!;
  expect(view.result).toMatchObject({ ok: true, reply: 'Invented answer', sent: body, model: 'venice/model-a' });
  expect(view.progress).toEqual({ state: 'answering', documentsRead: 3, documentsTotal: 9 });
  expect(JSON.stringify(view)).not.toContain('never-record-this');
  expect(JSON.stringify(view)).not.toContain(VENICE);
});

test('late source or connection revocation rejects the caller and hides attempted content', async () => {
  for (const revoked of ['source', 'connection'] as const) {
    const jobs = createPrivateDocumentRequests();
    let sourceCurrent = true;
    let connectionCurrent = true;
    const body = `{"model":"venice/revoked-${revoked}","messages":[{"content":"hidden-${revoked}"}]}`;
    await expect(withDocumentAnswerReceipt({
      jobs,
      question: 'Review',
      authorized: () => connectionCurrent,
      async work() {
        return runWithDocumentDispatch(() => sourceCurrent, async () => {
          await fetchModelEndpoint(async () => new Response('{}'), VENICE, { method: 'POST', body });
          if (revoked === 'source') sourceCurrent = false;
          else connectionCurrent = false;
          return { reply: 'must not publish' };
        });
      },
      describe: result => ({ reply: result.reply, answeredByVenice: true }),
    })).rejects.toThrow('authorization changed');
    await settle();
    const serialized = JSON.stringify(await jobs.list());
    expect(serialized).not.toContain(`hidden-${revoked}`);
    expect(serialized).not.toContain(`venice/revoked-${revoked}`);
  }
});

test('job capacity refusal prevents the document work from starting', async () => {
  const jobs = createPrivateDocumentRequests({ maxJobs: 1 });
  jobs.start('occupy', async () => new Promise(() => {}));
  let ran = false;
  await expect(withDocumentAnswerReceipt({
    jobs,
    question: 'second',
    authorized: () => true,
    async work() { ran = true; return { reply: 'no' }; },
    describe: result => ({ reply: result.reply, answeredByVenice: true }),
  })).rejects.toThrow('documents_busy');
  expect(ran).toBe(false);
});

test('a local fallback is not attributed to Venice but retains an attempted request privately', async () => {
  const jobs = createPrivateDocumentRequests();
  const body = '{"model":"venice/attempted","messages":[{"content":"invented fallback input"}]}';
  const value = { reply: 'Local fallback' };
  expect(await withDocumentAnswerReceipt({
    jobs,
    question: 'Review',
    authorized: () => true,
    async work() {
      await fetchModelEndpoint(async () => new Response('{}'), VENICE, { method: 'POST', body });
      return value;
    },
    describe: result => ({ reply: result.reply, answeredByVenice: false }),
  })).toBe(value);
  await settle();
  const result = (await jobs.list())[0]!.result!;
  expect(result).toMatchObject({ ok: false, code: 'documents_no_venice_answer', sent: body });
  expect(result).not.toHaveProperty('model');
});

test('failed work rejects with the original error and retains only an authorized attempted request', async () => {
  const jobs = createPrivateDocumentRequests();
  const original = new Error('fixture failure');
  const body = '{"model":"venice/failure","messages":[]}';
  await expect(withDocumentAnswerReceipt({
    jobs,
    question: 'Review',
    authorized: () => true,
    async work() {
      await fetchModelEndpoint(async () => new Response('{}'), VENICE, { method: 'POST', body });
      throw original;
    },
    describe: () => ({ reply: 'unreachable', answeredByVenice: true }),
  })).rejects.toBe(original);
  await settle();
  expect((await jobs.list())[0]!.result).toMatchObject({ ok: false, code: 'documents_answer_failed', sent: body });
});

test('four requests are retained in order and a fifth is refused before fetch', async () => {
  const jobs = createPrivateDocumentRequests();
  let fetches = 0;
  const bodies = Array.from({ length: 5 }, (_, index) => `{"model":"venice/m${index}","messages":[{"content":"body-${index}"}]}`);
  await expect(withDocumentAnswerReceipt({
    jobs,
    question: 'Review',
    authorized: () => true,
    async work() {
      for (const body of bodies) {
        await fetchModelEndpoint(async () => { fetches++; return new Response('{}'); }, VENICE, { method: 'POST', body });
      }
      return { reply: 'unreachable' };
    },
    describe: result => ({ reply: result.reply, answeredByVenice: true }),
  })).rejects.toThrow('four-request');
  expect(fetches).toBe(4);
  await settle();
  const sent = ((await jobs.list())[0]!.result as { sent?: string }).sent!;
  for (const [index, body] of bodies.slice(0, 4).entries()) {
    expect(sent).toContain(`[Request ${index + 1}]\n${body}`);
  }
  expect(sent).not.toContain('body-4');
});

test('the byte cap refuses an oversized request before fetch', async () => {
  const jobs = createPrivateDocumentRequests();
  let fetches = 0;
  const body = JSON.stringify({ model: 'venice/large', messages: [{ content: 'x'.repeat(256 * 1024) }] });
  await expect(withDocumentAnswerReceipt({
    jobs,
    question: 'Review',
    authorized: () => true,
    async work() {
      await fetchModelEndpoint(async () => { fetches++; return new Response('{}'); }, VENICE, { method: 'POST', body });
      return { reply: 'unreachable' };
    },
    describe: result => ({ reply: result.reply, answeredByVenice: true }),
  })).rejects.toThrow('byte limit');
  expect(fetches).toBe(0);
});

test('a throwing description settles the caller with that exact error', async () => {
  const jobs = createPrivateDocumentRequests();
  const original = new Error('description fixture failure');
  await expect(withDocumentAnswerReceipt({
    jobs,
    question: 'Review',
    authorized: () => true,
    async work() { return { reply: 'completed work' }; },
    describe() { throw original; },
  })).rejects.toBe(original);
});

test('caller abort after completion does not erase a receipt, while later source revocation does', async () => {
  const jobs = createPrivateDocumentRequests();
  const caller = new AbortController();
  let sourceCurrent = true;
  const body = '{"model":"venice/durable","messages":[{"content":"durable fixture"}]}';
  await withDocumentAnswerReceipt({
    jobs,
    question: 'Review',
    authorized: () => true,
    signal: caller.signal,
    async work() {
      return runWithDocumentDispatch(() => sourceCurrent, async () => {
        await fetchModelEndpoint(async () => new Response('{}'), VENICE, { method: 'POST', body });
        return { reply: 'Durable answer' };
      });
    },
    describe: result => ({ reply: result.reply, answeredByVenice: true }),
  });
  caller.abort();
  await settle();
  expect((await jobs.list())[0]!.result).toMatchObject({ ok: true, sent: body });
  sourceCurrent = false;
  const hidden = JSON.stringify(await jobs.list());
  expect(hidden).not.toContain('durable fixture');
  expect(hidden).not.toContain('venice/durable');
});

test('sequential sibling source guards remain accumulated through publication', async () => {
  const jobs = createPrivateDocumentRequests();
  let firstCurrent = true;
  let secondCurrent = true;
  const first = '{"model":"venice/first","messages":[]}';
  const second = '{"model":"venice/second","messages":[]}';
  await expect(withDocumentAnswerReceipt({
    jobs,
    question: 'Review',
    authorized: () => true,
    async work() {
      await runWithDocumentDispatch(
        () => firstCurrent,
        () => fetchModelEndpoint(async () => new Response('{}'), VENICE, { method: 'POST', body: first }),
      );
      await runWithDocumentDispatch(
        () => secondCurrent,
        () => fetchModelEndpoint(async () => new Response('{}'), VENICE, { method: 'POST', body: second }),
      );
      firstCurrent = false;
      return { reply: 'must be withdrawn' };
    },
    describe: result => ({ reply: result.reply, answeredByVenice: true }),
  })).rejects.toThrow('authorization changed');
  expect(secondCurrent).toBe(true);
  await settle();
  expect(JSON.stringify(await jobs.list())).not.toContain('venice/first');
});

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}
