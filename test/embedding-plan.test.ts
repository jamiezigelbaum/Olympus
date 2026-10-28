// One rule decides how every store gets its vectors (planStoreEmbedding),
// whatever source or path filled it.

import { describe, expect, test } from 'bun:test';
import {
  QUEUE_ONLY_METERED_EMBEDDING,
  planStoreEmbedding,
  storeEmbeddingCatchesUp,
} from '../src/workers/connector-store/embedding-plan.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createSourceCorpusRegistry, defaultSourceCorpusRegistryConfig } from '../src/core/source-corpus-registry.ts';
import { archiveImportCorpora, withArchiveImportCorpora } from '../src/workers/archive-import/store.ts';
import { sourceStoresCouldEmbed } from '../src/workers/email-source/server.ts';
import { RecordingProvider } from './helpers/tier-fixtures.ts';

const store = (corpusId: string, trustDomain: string) => ({ corpusId, trustDomain }) as unknown as LocalConnectorStore;
const cloud = new RecordingProvider('google-gemini', 'gemini-embedding-2', 'cloud');
const builtIn = new RecordingProvider('built-in', 'embeddinggemma', 'local');

describe('planStoreEmbedding', () => {
  test('a store served by meaning catches up store-wide under its scope, with its provider bound to the approval', () => {
    const bound = new RecordingProvider('google-gemini', 'gemini-embedding-2', 'cloud');
    const target = planStoreEmbedding({
      store: store('internal.dropbox.files', 'internal'),
      provider: cloud,
      servedByMeaning: true,
      scope: { allowed: true, accountScope: 'personal', filters: { locatorPathScope: '/Work' }, bind: () => bound },
    });
    expect(target).toMatchObject({ wholeStore: true, accountScope: 'personal', filters: { locatorPathScope: '/Work' } });
    expect(target!.provider).toBe(bound);
  });

  test('without a current scope only the queue drains, each group under the binding it was queued with', () => {
    const target = planStoreEmbedding({ store: store('internal.drive.docs', 'internal'), provider: cloud, servedByMeaning: true, scope: { allowed: false } });
    expect(target).toEqual({ store: store('internal.drive.docs', 'internal'), provider: cloud });
  });

  test('a keyword-only store, a store with no identity, and a Private store offered a cloud model get no target', () => {
    expect(planStoreEmbedding({ store: store('internal.email', 'internal'), provider: cloud, servedByMeaning: false, scope: { allowed: true } })).toBeUndefined();
    expect(planStoreEmbedding({ store: store('internal.email', 'internal'), provider: undefined, servedByMeaning: true, scope: { allowed: true } })).toBeUndefined();
    expect(planStoreEmbedding({ store: store('secure_local.email.private', 'secure_local'), provider: cloud, servedByMeaning: true, scope: { allowed: true } })).toBeUndefined();
  });

  test('a store no sync fills (per-item routing, imports) still catches up: nothing depends on a queue', () => {
    const target = planStoreEmbedding({ store: store('internal.evernote.notes', 'internal'), provider: cloud, servedByMeaning: true, scope: { allowed: true } });
    expect(target?.wholeStore).toBe(true);
  });
});

describe('catch-up', () => {
  const corpora = [...defaultSourceCorpusRegistryConfig().corpora, ...archiveImportCorpora()];

  test('every registered store catches up on the built-in model: no cost decision applies to it', () => {
    for (const corpus of corpora) expect(storeEmbeddingCatchesUp(corpus.corpusId, builtIn)).toBe(true);
  });

  test('on a metered model, only a recorded owner decision keeps a store queue-only', () => {
    const queueOnly = corpora.filter((corpus) => !storeEmbeddingCatchesUp(corpus.corpusId, cloud)).map((corpus) => corpus.corpusId);
    expect(queueOnly.sort()).toEqual(Object.keys(QUEUE_ONLY_METERED_EMBEDDING).sort());
    for (const why of Object.values(QUEUE_ONLY_METERED_EMBEDDING)) expect(why).toMatch(/decision/);
  });
});

describe('a source whose stores open later', () => {
  test('gets its sweep before its first store exists (an archive family before its first import)', () => {
    const registry = createSourceCorpusRegistry(withArchiveImportCorpora(undefined));
    const corpusIds = new Set(registry.list().filter((corpus) => corpus.sourceId === 'archive.imports').map((corpus) => corpus.corpusId));
    expect(corpusIds.size).toBeGreaterThan(0);
    const engine = { config: { retrieval: { trustDomains: {} } } } as never;
    const input = { corpusIds, sovereigntyEngine: engine, sourceCorpusRegistry: registry, fullCorpusDefinitions: [] };
    expect(sourceStoresCouldEmbed({ ...input, providerFor: () => cloud })).toBe(true);
    // No identity for any tier: keyword-only, so no sweep.
    expect(sourceStoresCouldEmbed({ ...input, providerFor: () => undefined })).toBe(false);
  });
});
