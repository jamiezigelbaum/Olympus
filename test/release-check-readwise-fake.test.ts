// The stand-in Readwise API serves exactly the synthetic life and refuses everything else.

import { afterEach, describe, expect, test } from 'bun:test';
import { FIXTURE_ITEMS, PRIVATE_MARKER } from '../scripts/release-check/fixture.ts';
import { startFakeReadwise, type FakeReadwise } from '../scripts/release-check/readwise-fake.ts';

let fake: FakeReadwise | undefined;
afterEach(() => { fake?.stop(); fake = undefined; });

describe('Readwise stand-in', () => {
  test('answers the three connector calls for the right token and nothing else', async () => {
    fake = startFakeReadwise({ port: 0, token: 'tok' });
    const base = `http://127.0.0.1:${fake.port}`;
    const auth = { authorization: 'Token tok' };

    expect((await fetch(`${base}/api/v2/auth/`)).status).toBe(401);
    expect((await fetch(`${base}/api/v2/auth/`, { headers: { authorization: 'Token wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/api/v2/auth/`, { headers: auth })).status).toBe(204);

    const list = await (await fetch(`${base}/api/v3/list/`, { headers: auth })).json() as { count: number; results: Array<{ title: string }> };
    expect(list.count).toBe(FIXTURE_ITEMS.length);
    expect(list.results).toHaveLength(FIXTURE_ITEMS.length);

    expect(await (await fetch(`${base}/api/v2/export/`, { headers: auth })).json()).toEqual({ count: 0, results: [] });
    expect((await fetch(`${base}/api/v2/other/`, { headers: auth })).status).toBe(404);
  });

  test('its request log holds route names only, never the token or any document text', async () => {
    fake = startFakeReadwise({ port: 0, token: 'tok' });
    const base = `http://127.0.0.1:${fake.port}`;
    await fetch(`${base}/api/v3/list/`, { headers: { authorization: 'Token tok' } });
    expect(fake.requests).toEqual(['GET /api/v3/list/']);
    expect(JSON.stringify(fake.requests)).not.toContain('tok"');
    expect(JSON.stringify(fake.requests)).not.toContain(PRIVATE_MARKER);
  });
});
