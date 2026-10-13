import { expect, test } from 'bun:test';
import { createPrivateDocumentRequests } from '../src/core/private-document-requests.ts';

const answer = { ok: true as const, reply: 'Invented private lab assessment', sent: 'Marker Z 71 mg/dL', route: 'zkAPI via Tor', networkIdentity: 'hidden' as const, level: 'standard' as const, rewritten: true, remembered: false, model: 'fixture/model' };
test('an agent receives only a private notice; the owner page receives progress and the exact answer', async () => {
  const jobs = createPrivateDocumentRequests();
  const notice = jobs.start('Review invented labs', async control => {
    control.registerDocumentGuard(async () => true);
    control.onProgress({ state: 'summarizing', documentsRead: 2, documentsTotal: 12 });
    return answer;
  });
  expect(JSON.stringify(notice)).not.toContain('Marker Z');
  expect(JSON.stringify(notice)).not.toContain('lab assessment');
  await new Promise(resolve => setTimeout(resolve, 0));
  const views = await jobs.list();
  expect(views[0]?.result).toMatchObject(answer);
});
test('a changed source retracts stored results, including sent text and model details', async () => {
  let eligible = true;
  const jobs = createPrivateDocumentRequests();
  jobs.start('Review', async control => { control.registerDocumentGuard(async () => eligible); return answer; });
  await new Promise(resolve => setTimeout(resolve, 0));
  eligible = false;
  const views = await jobs.list();
  expect(JSON.stringify(views)).not.toContain('Marker Z');
  expect(views[0]?.result).toMatchObject({ ok: false, code: 'documents_changed' });
});
test('no guard and thrown content are never published', async () => {
  const jobs = createPrivateDocumentRequests();
  jobs.start('Review', async () => answer);
  jobs.start('Review again', async () => { throw new Error('Invented confidential result'); });
  await new Promise(resolve => setTimeout(resolve, 0));
  const text = JSON.stringify(await jobs.list());
  expect(text).not.toContain('Marker Z');
  expect(text).not.toContain('confidential result');
});
test('expired jobs abort and disappear, and capacity never evicts a running paid request', async () => {
  let now = 0;
  let signal: AbortSignal | undefined;
  const jobs = createPrivateDocumentRequests({ now: () => now, maxJobs: 1, ttlMs: 50 });
  jobs.start('Review', async control => { signal = control.signal; return new Promise(() => {}); });
  expect(jobs.start('Second', async () => answer)).toMatchObject({ ok: false, code: 'documents_busy' });
  now = 51;
  expect(await jobs.list()).toEqual([]);
  expect(signal?.aborted).toBe(true);
});
test('the job deadline cancels work even when the owner never opens or polls the page', async () => {
  let signal: AbortSignal | undefined;
  const jobs = createPrivateDocumentRequests({ ttlMs: 5 });
  jobs.start('Review', async control => { signal = control.signal; return new Promise(() => {}); });
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(signal?.aborted).toBe(true);
});
