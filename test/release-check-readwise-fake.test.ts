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

  test('a later sweep gets only what changed after its watermark, like Readwise', async () => {
    const documents = [{ id: 'old', updated_at: '2025-01-01T12:00:00Z' }, { id: 'new', updated_at: '2025-02-01T12:00:00Z' }];
    const books = [{ user_book_id: 1, highlights: [{ id: 1, updated_at: '2025-01-01T12:00:00Z' }, { id: 2, updated_at: '2025-03-01T12:00:00Z' }] },
      { user_book_id: 2, highlights: [{ id: 3, updated_at: '2025-01-01T12:00:00Z' }] }];
    fake = startFakeReadwise({ port: 0, token: 'tok', documents: documents as never, books: books as never });
    const get = async (path: string) => (await (await fetch(`http://127.0.0.1:${fake!.port}${path}`, { headers: { authorization: 'Token tok' } })).json()) as { results: Array<Record<string, unknown>> };
    expect((await get('/api/v3/list/')).results).toHaveLength(2);
    expect((await get('/api/v3/list/?updatedAfter=2025-01-01T12:00:00Z')).results.map(d => d.id)).toEqual(['new']);
    expect((await get('/api/v2/export/?updatedAfter=2025-01-01T12:00:00Z')).results).toEqual([{ user_book_id: 1, highlights: [{ id: 2, updated_at: '2025-03-01T12:00:00Z' }] }]);
    expect((await get('/api/v3/list/?updatedAfter=2025-03-01T12:00:00Z')).results).toEqual([]);
  });
});
