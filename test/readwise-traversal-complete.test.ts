// `traversal_complete` on the Readwise pull lane.
//
// A completed sweep does NOT clear the checkpoint here: the connector's done
// page publishes the next sweep's watermark cursor, precisely so a high-water
// -mark lane has a starting point. Reading completeness off checkpoint absence
// therefore reported 0 for every finished sweep on any account whose documents
// carry `updated_at` — which is all of them. The existing scheduler fixture
// missed it only because its documents carry no timestamps at all, so no
// watermark was ever published.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  ReadwiseDailyRequestBudget,
  createReadwiseConnectorStore,
  createReadwiseConnectorStoreSyncHandler,
  readwiseCursorIsSweepBoundary,
  type ReadwiseFetch,
} from '../src/workers/readwise/index.ts';
import { DeterministicSourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';
const NOW = new Date('2026-08-01T00:00:00.000Z');

function timestampedFetch(calls: string[]): ReadwiseFetch {
  return async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v3/list/') {
      return jsonResponse({
        count: 1,
        results: [{
          id: 'reader-1',
          title: 'Reader one',
          summary: 'reader body one',
          updated_at: '2026-07-30T10:00:00.000Z',
        }],
      });
    }
    if (parsed.pathname === '/api/v2/export/') {
      return jsonResponse({
        results: [{
          user_book_id: 'book-1',
          title: 'Book one',
          highlights: [{
            id: 'highlight-1',
            text: 'highlight body one',
            updated_at: '2026-07-31T10:00:00.000Z',
          }],
        }],
      });
    }
    return jsonResponse({ error: 'unexpected URL' }, 404);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-readwise-traversal-'));
  const store = createReadwiseConnectorStore(join(root, 'readwise-connector.sqlite'));
  const calls: string[] = [];
  const handler = createReadwiseConnectorStoreSyncHandler({
    store,
    embeddingProvider: new DeterministicSourceEmbeddingProvider({
      modelId: 'readwise-traversal-test',
      epochId: 'cloud:test:readwise-traversal-test:v1',
    }),
    account: ACCOUNT,
    credentialBroker: new StaticCredentialBroker([{
      handle: 'readwise.personal',
      provider: 'readwise',
      allowedCapabilities: ['readwise.sync'],
      token: 'broker-token',
    }]),
    fetch: timestampedFetch(calls),
    requestBudget: new ReadwiseDailyRequestBudget({ dailyRequestBudget: 50, now: () => NOW }),
    now: () => NOW,
  });
  return {
    handler,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('readwise pull traversal completeness', () => {
  test('a sweep that reached the done page reports complete despite its watermark checkpoint', async () => {
    const fixture = harness();
    try {
      const pull = await fixture.handler.pull({ max_items: 50 });

      // The done page published a watermark, so a checkpoint IS carried.
      expect(typeof pull.checkpoint).toBe('string');
      expect(readwiseCursorIsSweepBoundary(pull.checkpoint ?? undefined)).toBe(true);
      expect(pull.receipt.counts.traversal_complete).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test('a bounded sweep stopped inside the traversal still reports incomplete', async () => {
    const fixture = harness();
    try {
      const pull = await fixture.handler.pull({ max_items: 1 });

      expect(typeof pull.checkpoint).toBe('string');
      expect(readwiseCursorIsSweepBoundary(pull.checkpoint ?? undefined)).toBe(false);
      expect(pull.receipt.counts.traversal_complete).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test('a cursor that cannot be decoded never certifies a complete traversal', () => {
    expect(readwiseCursorIsSweepBoundary('rw1:not-a-real-cursor')).toBe(false);
    expect(readwiseCursorIsSweepBoundary(undefined)).toBe(false);
  });
});
