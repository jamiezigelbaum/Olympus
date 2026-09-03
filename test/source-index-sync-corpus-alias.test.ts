// The sync route must honour the corpus-id input aliases the registry
// documents. Before 2026-07-28 the route compared the raw request string
// against family constants, so a documented alias was rejected with 400 even
// though the registry resolved it happily one layer down. Live effect: the
// daily cloud freshness unit failed for three days.
//
// These tests take the alias from the registry rather than spelling it out, so
// they follow the alias table instead of freezing today's copy of it.

import { describe, expect, test } from 'bun:test';
import {
  LEGACY_READWISE_LIBRARY_CORPUS_ID,
  READWISE_LIBRARY_CORPUS_ID,
  canonicalSourceCorpusId,
} from '../src/core/source-corpus-registry.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import type {
  ReadwiseConnectorStoreSyncHandler,
  ReadwiseConnectorStoreSyncResult,
} from '../src/workers/readwise/index.ts';

const SYNC_URL = 'http://worker.test/v1/source/index/sync';

function syncRequest(body: Record<string, unknown>): Request {
  return new Request(SYNC_URL, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('source-index sync corpus alias resolution', () => {
  test('accepts a documented input alias and dispatches it as the canonical corpus', async () => {
    // Guards the premise: if the registry ever stops aliasing this id the test
    // would otherwise pass vacuously by sending the canonical id to itself.
    expect(canonicalSourceCorpusId(LEGACY_READWISE_LIBRARY_CORPUS_ID)).toBe(READWISE_LIBRARY_CORPUS_ID);
    expect(LEGACY_READWISE_LIBRARY_CORPUS_ID).not.toBe(READWISE_LIBRARY_CORPUS_ID);

    let syncCalls = 0;
    const worker = createEmailSourceWorker({
      readwiseConnectorStoreSync: {
        async sync(): Promise<ReadwiseConnectorStoreSyncResult> {
          syncCalls += 1;
          return {
            status: 'idle',
            counts: {
              api_requests: 0,
              daily_api_request_budget: 100,
              items_seen: 0,
              items_indexed: 0,
              items_tombstoned: 0,
              chunks_indexed: 0,
              chunks_embedded: 0,
            },
            api_usage: { utc_day: '2026-08-29' },
            policy: {
              counts_only: true,
              raw_source_exposed: false,
              source_text_returned: false,
              provider_cursor_exposed: false,
            },
          };
        },
      } as unknown as ReadwiseConnectorStoreSyncHandler,
    });

    const response = await worker.fetch(syncRequest({
      corpus_id: LEGACY_READWISE_LIBRARY_CORPUS_ID,
      account: 'person@example.com',
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'idle', counts: { items_indexed: 0 } });
    // The canonical Readwise connector-store handler is selected only after
    // the route resolves this documented alias.
    expect(syncCalls).toBe(1);
  });

  test('still fails closed when no canonical scheduler lane is mounted for a corpus', async () => {
    const worker = createEmailSourceWorker({});
    const response = await worker.fetch(syncRequest({ corpus_id: 'internal.not_a_corpus.nope' }));
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body).toMatchObject({ error: { code: 'source_index_sync_not_supported' } });
  });

  test('the rejection message identifies the missing canonical scheduler lane', async () => {
    const worker = createEmailSourceWorker({});
    const response = await worker.fetch(syncRequest({ corpus_id: 'internal.not_a_corpus.nope' }));
    const body = await response.json() as { error?: { message?: string } };

    expect(response.status).toBe(501);
    expect(body.error?.message ?? '').toContain('canonical scheduler lane');
    expect(body.error?.message ?? '').toContain('not configured');
  });
});
