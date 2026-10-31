import { expect, test } from 'bun:test';
import { checkDropboxConnection } from '../src/core/connect.ts';

test('Dropbox refuses a missing permission before storing the grant', async () => {
  let calls = 0;
  await expect(checkDropboxConnection('fixture', async (_url, init) => {
    calls++;
    expect(init?.redirect).toBe('error');
    return new Response('', { status: 403 });
  }, 1000)).rejects.toThrow('Enable permissions');
  expect(calls).toBe(1);
});
