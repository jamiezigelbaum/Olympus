import { expect, test } from 'bun:test';
import { checkDropboxConnection } from '../src/core/connect.ts';

test('Dropbox refuses a missing permission before storing the grant', async () => {
  let calls = 0;
  await expect(checkDropboxConnection('fixture', async (_url, init) => {
    calls++;
    expect(String(_url)).toBe('https://api.dropboxapi.com/2/files/list_folder');
    expect(init?.redirect).toBe('error');
    return Response.json({ error: { '.tag': 'missing_scope', required_scope: 'files.metadata.read' }, error_summary: 'missing_scope/' }, { status: 401 });
  }, 1000)).rejects.toThrow('Permissions tab');
  expect(calls).toBe(1);
});

for (const response of [
  () => Response.json({ error: { '.tag': 'expired_access_token' } }, { status: 401 }),
  () => new Response('not json', { status: 401 }),
  () => new Response('', { status: 403 }),
]) {
  test('other Dropbox refusals stay generic', async () => {
    await expect(checkDropboxConnection('fixture', async () => response(), 1000)).rejects.toThrow('could not complete the list check');
  });
}

// #675: the CLI has no setup steps, so the check's own refusal names the
// Dropbox setting to change rather than a dashboard step.
test('the missing-permission refusal does not assume the dashboard', async () => {
  const refusal = checkDropboxConnection('fixture', async () => Response.json({ error: { '.tag': 'missing_scope' } }, { status: 401 }), 1000);
  await expect(refusal).rejects.toThrow('Permissions tab');
  await expect(refusal).rejects.not.toThrow('step');
});

test('an oversized Dropbox check body is reported as unusable, not unreachable', async () => {
  const big = 'x'.repeat(65 * 1024);
  await expect(checkDropboxConnection('fixture', async () => new Response(big, { status: 200 }), 1000))
    .rejects.toThrow('Dropbox returned an answer to the final check that Olympus could not use. No credentials were stored; try again.');
});

test('a stalled Dropbox check body is reported as no answer in time', async () => {
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
  try {
    await expect(checkDropboxConnection('fixture', async () => new Response(body), 20))
      .rejects.toThrow('Dropbox did not answer the final check in time. No credentials were stored; try again.');
  } finally {
    try { bodyController.error(new Error('test cleanup')); } catch { /* already cancelled */ }
  }
});

test('an unreachable Dropbox still says so', async () => {
  await expect(checkDropboxConnection('fixture', async () => { throw new TypeError('fetch failed'); }, 1000))
    .rejects.toThrow('Dropbox could not be reached for the final check. No credentials were stored; try again.');
});
