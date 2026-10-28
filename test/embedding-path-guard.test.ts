// Every store that per-item routing fills must have something that embeds it. Such a store has no
// sync of its own, so its items are never queued by a sync of that store: without a named path its
// chunks stay keyword-only for good (Evernote's Personal store, test-mac 2026-10-28).

import { describe, expect, test } from 'bun:test';
import { defaultSourceCorpusRegistryConfig } from '../src/core/source-corpus-registry.ts';
import { wholeStoreEmbeddingSweepAllowed } from '../src/workers/source-scheduler.ts';

/**
 * The routed stores embedded some other way than the store-wide sweep:
 * - Dropbox and local files run their own embed task per tier store;
 * - the Gmail and Drive tier sets give each leg its provider, so a sync queues
 *   what it routes there (under the lane's scope binding).
 */
const OTHER_EMBEDDING_PATHS: Readonly<Record<string, string>> = {
  'internal.dropbox.files': 'own embed task',
  'public_safe.dropbox.files': 'own embed task',
  'internal.local.files': 'own embed task',
  'public_safe.local.files': 'own embed task',
  'public_safe.email': 'leg provider queues routed items',
  'public_safe.drive.docs': 'leg provider queues routed items',
};

describe('embedding paths', () => {
  test('every routed store served by meaning has a named way to get its vectors', () => {
    const routed = defaultSourceCorpusRegistryConfig().corpora.filter((corpus) =>
      corpus.trustDomain !== 'secure_local'
      && corpus.activationMode !== 'lexical_only'
      && !(corpus.capabilities ?? []).includes('sync'));
    expect(routed.length).toBeGreaterThan(0);
    const missing = routed
      .filter((corpus) => !wholeStoreEmbeddingSweepAllowed(corpus.sourceId, corpus.corpusId) && !OTHER_EMBEDDING_PATHS[corpus.corpusId])
      .map((corpus) => corpus.corpusId);
    expect(missing).toEqual([]);
  });
});
