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

export const FAKE_READWISE_PORT = 18771;
export const FAKE_READWISE_TOKEN = 'release-check-synthetic-token';

export interface FakeReadwiseOptions {
  port?: number;
  token?: string;
  documents?: readonly FixtureDocument[];
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
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? FAKE_READWISE_PORT,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.headers.get('authorization') !== `Token ${token}`) return new Response('unauthorized', { status: 401 });
      if (url.pathname === '/api/v2/auth/') return new Response(null, { status: 204 });
      if (url.pathname === '/api/v3/list/') return Response.json({ count: documents.length, results: documents });
      if (url.pathname === '/api/v2/export/') return Response.json({ count: 0, results: [] });
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
