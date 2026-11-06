import { expect, test } from 'bun:test';
import { checkDropboxConnection } from '../src/core/connect.ts';

test('Dropbox refuses a missing permission before storing the grant', async () => {
  let calls = 0;
  await expect(checkDropboxConnection('fixture', async (_url, init) => {
    calls++;
    expect(String(_url)).toBe('https://api.dropboxapi.com/2/files/list_folder');
    expect(init?.redirect).toBe('error');
    return Response.json({ error: { '.tag': 'missing_scope', required_scope: 'files.metadata.read' }, error_summary: 'missing_scope/' }, { status: 401 });
  }, 1000)).rejects.toThrow('Enable permissions');
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
