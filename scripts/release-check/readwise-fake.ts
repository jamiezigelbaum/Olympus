/**
 * A stand-in for the Readwise API that serves the synthetic test life.
 *
 * It answers the three calls the Readwise connector makes (token check, Reader
 * document list, highlight export) and nothing else, on the loopback of the
 * machine under test. A normal install reaches it through the connector's own
 * base-URL settings in its worker environment
 * (OLYMPUS_SOURCE_INDEX_READWISE_API_V2_BASE_URL and
 * OLYMPUS_SOURCE_INDEX_READWISE_READER_API_V3_BASE_URL); no product code path
 * is added or bypassed, and a user's install never has those set.
 *
 *   bun readwise-fake.ts [--port 18771] [--token <value>]
 */
import { FIXTURE_ITEMS, fixtureDocuments, type FixtureDocument } from './fixture.ts';
import type { ReadwiseExportBook, ReadwiseReaderDocument } from '../../src/workers/readwise/api.ts';

export const FAKE_READWISE_PORT = 18771;
export const FAKE_READWISE_TOKEN = 'release-check-synthetic-token';

export interface FakeReadwiseOptions {
  port?: number;
  token?: string;
  documents?: readonly (FixtureDocument | ReadwiseReaderDocument)[];
  books?: readonly ReadwiseExportBook[];
  /** Omitted for the ordinary, single-page test life. */
  pageSize?: number;
  /** One export request is throttled, then succeeds on retry. */
  retryOnce?: boolean;
}

/** The request log never holds the token or any document text, only route names. */
export interface FakeReadwise {
  port: number;
  requests: string[];
  stop(): void;
}

export function startFakeReadwise(options: FakeReadwiseOptions = {}): FakeReadwise {
  const token = options.token ?? FAKE_READWISE_TOKEN;
  const documents = options.documents ?? fixtureDocuments(FIXTURE_ITEMS);
  const requests: string[] = [];
  const books = options.books ?? [];
  let throttled = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? FAKE_READWISE_PORT,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.headers.get('authorization') !== `Token ${token}`) return new Response('unauthorized', { status: 401 });
      if (url.pathname === '/api/v2/auth/') return new Response(null, { status: 204 });
      if (url.pathname === '/api/v3/list/' || url.pathname === '/api/v2/export/') {
        if (options.retryOnce && !throttled && url.pathname === '/api/v2/export/') {
          throttled = true;
          return new Response('synthetic rate limit', { status: 429, headers: { 'retry-after': '1' } });
        }
        const rows = url.pathname === '/api/v3/list/' ? documents : books;
        const start = Number(url.searchParams.get('pageCursor') ?? 0);
        if (!Number.isSafeInteger(start) || start < 0 || start > rows.length) return new Response('bad cursor', { status: 400 });
        const size = Math.max(1, Math.min(options.pageSize ?? Math.max(1, rows.length), Number(url.searchParams.get('limit')) || Infinity));
        const end = Math.min(start + size, rows.length);
        return Response.json({ count: rows.length, results: rows.slice(start, end), ...(end < rows.length ? { nextPageCursor: String(end) } : {}) });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { port: server.port ?? options.port ?? FAKE_READWISE_PORT, requests, stop: () => { void server.stop(true); } };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const port = flag('--port');
  const token = flag('--token');
  const fake = startFakeReadwise({
    ...(port ? { port: Number(port) } : {}),
    ...(token ? { token } : {}),
  });
  console.log(`fake readwise listening on ${fake.port}`);
}
