import { describe, expect, test } from 'bun:test';
import { ReadwiseApiClient, type ReadwiseFetch } from '../src/workers/readwise/index.ts';

describe('Readwise API client', () => {
  test('lists Reader documents with token auth and safe pagination parameters', async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const client = new ReadwiseApiClient({
      token: 'test-token',
      fetch: fakeFetch(calls, {
        'https://readwise.io/api/v3/list/?limit=2&updatedAfter=2026-05-01T00%3A00%3A00Z&location=new': {
          count: 1,
          nextPageCursor: 'cursor-2',
          results: [{ id: 'reader-1', title: 'Local-first memory systems' }],
        },
        'https://readwise.io/api/v3/list/?limit=2&updatedAfter=2026-05-01T00%3A00%3A00Z&location=new&pageCursor=cursor-2': {
          count: 1,
          results: [{ id: 'reader-2', title: 'Source indexes' }],
        },
      }),
    });

    const result = await client.fetchReaderDocuments({
      updatedAfter: '2026-05-01T00:00:00Z',
      location: 'new',
      pageLimit: 2,
      maxDocuments: 3,
    });

    expect(result).toMatchObject({
      requestCount: 2,
      documents: [
        { id: 'reader-1', title: 'Local-first memory systems' },
        { id: 'reader-2', title: 'Source indexes' },
      ],
    });
    expect(calls.map((call) => call.authorization)).toEqual(['Token test-token', 'Token test-token']);
  });

  test('exports Readwise highlight books from the v2 endpoint', async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const client = new ReadwiseApiClient({
      token: 'test-token',
      fetch: fakeFetch(calls, {
        'https://readwise.io/api/v2/export/?updatedAfter=2026-05-01T00%3A00%3A00Z': [{
          user_book_id: 42,
          title: 'Notebook',
          highlights: [{ id: 7, text: 'Keep provenance with every claim.' }],
        }],
      }),
    });

    const result = await client.fetchExportBooks({
      updatedAfter: '2026-05-01T00:00:00Z',
      maxPages: 1,
    });

    expect(result.requestCount).toBe(1);
    expect(result.pageLimitReached).toBe(false);
    expect(result.books[0]).toMatchObject({
      user_book_id: 42,
      highlights: [{ id: 7 }],
    });
    expect(calls[0]).toMatchObject({
      url: 'https://readwise.io/api/v2/export/?updatedAfter=2026-05-01T00%3A00%3A00Z',
      authorization: 'Token test-token',
    });
  });

  test('reports when export pagination stops at the requested page budget', async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const client = new ReadwiseApiClient({
      token: 'test-token',
      fetch: fakeFetch(calls, {
        'https://readwise.io/api/v2/export/': {
          nextPageCursor: 'cursor-2',
          results: [{
            user_book_id: 42,
            title: 'Notebook',
            highlights: [{ id: 7, text: 'Keep provenance with every claim.' }],
          }],
        },
      }),
    });

    const result = await client.fetchExportBooks({ maxPages: 1 });

    expect(result).toMatchObject({
      requestCount: 1,
      pageLimitReached: true,
      nextPageCursor: 'cursor-2',
    });
  });
});

function fakeFetch(
  calls: Array<{ url: string; authorization?: string }>,
  responses: Record<string, unknown>,
): ReadwiseFetch {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get('authorization') ?? undefined;
    calls.push({
      url,
      ...(authorization ? { authorization } : {}),
    });
    if (!(url in responses)) {
      return new Response(JSON.stringify({ error: 'unexpected URL' }), { status: 404 });
    }
    return new Response(JSON.stringify(responses[url]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
