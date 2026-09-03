// LocalConnectorStore.extractionCandidates(): the read-only enumeration the
// extraction factory's per-family sources page through to decide what to
// enqueue.
//
// Everything here comes off columns the sync already writes, so the tests are
// about selection and paging rather than storage: the zero-chunk filter, the
// media-type filter (exact and trailing wildcard), tombstone exclusion,
// account partitioning, and a cursor that survives a page boundary without
// dropping or repeating a row.

import { describe, expect, test } from 'bun:test';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

const CORPUS_ID = 'secure_local.fake.files';
const PROVIDER = 'fake';
const ACCOUNT = 'personal';

interface SeedSpec {
  id: string;
  mimeType?: string;
  text?: string;
  accountScope?: string;
  deleted?: boolean;
}

function seedItem(spec: SeedSpec): RawItem {
  return {
    identity: {
      family: 'file',
      provider: PROVIDER,
      accountScope: spec.accountScope ?? ACCOUNT,
      providerItemId: spec.id,
      localItemId: `local:${spec.id}`,
      sourceVersion: `${spec.id}-v1`,
    },
    mimeType: spec.mimeType ?? 'application/pdf',
    content: spec.text === undefined
      ? { kind: 'metadata_only' }
      : { kind: 'text', text: spec.text },
    metadata: {
      name: `${spec.id}.bin`,
      pathDisplay: `/Files/${spec.id}.bin`,
      ...(spec.deleted === true ? { deleted: true } : {}),
    },
    fetchedAt: '2026-07-28T00:00:00.000Z',
  };
}

function createConnector(specs: readonly SeedSpec[]): SourceConnector {
  const live = specs.map(seedItem);
  return {
    id: 'fake-sync',
    family: 'file',
    async authenticate() {},
    async *listItems(_options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      yield { items: live, done: true };
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const found = live.find((item) => item.identity.localItemId === localItemId);
      if (!found) throw new Error(`no such item: ${localItemId}`);
      return found;
    },
    classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
  };
}

// Seeds a store from the given specs. Items marked deleted are synced in live
// first and then re-emitted with the connector's deletion marker, so the row
// carries a genuine tombstone rather than simply never having existed.
async function seededStore(specs: readonly SeedSpec[]): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  await store.syncFromConnector(
    createConnector(specs.map((spec) => ({ ...spec, deleted: false }))),
    { fetchContent: true },
  );
  const removed = specs.filter((spec) => spec.deleted === true);
  if (removed.length > 0) {
    await store.syncFromConnector(createConnector(removed), { fetchContent: true });
    expect(store.status().counts.tombstonedItems).toBe(removed.length);
  }
  return store;
}

function ids(page: { candidates: readonly { identity: { providerItemId: string } }[] }): string[] {
  return page.candidates.map((candidate) => candidate.identity.providerItemId);
}

describe('connector store: extraction candidates', () => {
  test('returns non-tombstoned items with the row fields the factory can actually use', async () => {
    const store = await seededStore([{ id: 'a', mimeType: 'application/pdf', text: 'alpha body' }]);
    try {
      const page = store.extractionCandidates({ limit: 10 });
      expect(page.done).toBe(true);
      expect(page.nextCursor).toBeUndefined();
      expect(page.candidates).toHaveLength(1);

      const candidate = page.candidates[0]!;
      expect(candidate.identity.provider).toBe(PROVIDER);
      expect(candidate.identity.accountScope).toBe(ACCOUNT);
      expect(candidate.identity.providerItemId).toBe('a');
      expect(candidate.identity.localItemId).toBe('local:a');
      expect(candidate.identity.sourceVersion).toBe('a-v1');
      expect(candidate.mimeType).toBe('application/pdf');
      expect(candidate.name).toBe('a.bin');
      expect(candidate.locatorUri).toBe('/Files/a.bin');
      expect(candidate.trustTier).toBe('S2');
      expect(candidate.storedChunks).toBe(1);
    } finally {
      store.close();
    }
  });

  test('withoutChunksOnly selects exactly the items no text ever reached', async () => {
    const store = await seededStore([
      { id: 'has-text', text: 'indexed body' },
      { id: 'no-text' },
      { id: 'also-no-text' },
    ]);
    try {
      const withoutChunks = store.extractionCandidates({ limit: 10, withoutChunksOnly: true });
      expect(ids(withoutChunks).sort()).toEqual(['also-no-text', 'no-text']);
      for (const candidate of withoutChunks.candidates) expect(candidate.storedChunks).toBe(0);

      expect(ids(store.extractionCandidates({ limit: 10 })).sort())
        .toEqual(['also-no-text', 'has-text', 'no-text']);
    } finally {
      store.close();
    }
  });

  test('a tombstoned item is excluded', async () => {
    const store = await seededStore([
      { id: 'kept', text: 'kept body' },
      { id: 'removed', text: 'removed body', deleted: true },
    ]);
    try {
      expect(ids(store.extractionCandidates({ limit: 10 }))).toEqual(['kept']);
    } finally {
      store.close();
    }
  });

  test('exact media types filter, and parameters and case do not defeat the match', async () => {
    const store = await seededStore([
      { id: 'pdf', mimeType: 'application/pdf' },
      { id: 'png', mimeType: 'image/png' },
      { id: 'plain', mimeType: 'Text/Plain; charset=utf-8' },
    ]);
    try {
      expect(ids(store.extractionCandidates({ limit: 10, mimeTypes: ['application/pdf'] })))
        .toEqual(['pdf']);
      expect(ids(store.extractionCandidates({ limit: 10, mimeTypes: ['text/plain'] })))
        .toEqual(['plain']);
      expect(ids(store.extractionCandidates({
        limit: 10,
        mimeTypes: ['application/pdf', 'image/png'],
      })).sort()).toEqual(['pdf', 'png']);
      expect(ids(store.extractionCandidates({ limit: 10, mimeTypes: ['application/zip'] })))
        .toEqual([]);
    } finally {
      store.close();
    }
  });

  test('a trailing wildcard admits subtypes the caller could not have enumerated', async () => {
    const store = await seededStore([
      { id: 'png', mimeType: 'image/png' },
      { id: 'heic', mimeType: 'image/heic' },
      { id: 'pdf', mimeType: 'application/pdf' },
    ]);
    try {
      expect(ids(store.extractionCandidates({ limit: 10, mimeTypes: ['image/*'] })).sort())
        .toEqual(['heic', 'png']);
      expect(ids(store.extractionCandidates({
        limit: 10,
        mimeTypes: ['image/*', 'application/pdf'],
      })).sort()).toEqual(['heic', 'pdf', 'png']);
    } finally {
      store.close();
    }
  });

  test('a wildcard that is not a plain trailing "type/*" is refused, not silently ignored', async () => {
    const store = await seededStore([{ id: 'png', mimeType: 'image/png' }]);
    try {
      expect(() => store.extractionCandidates({ limit: 10, mimeTypes: ['*'] }))
        .toThrow('must be of the form');
      expect(() => store.extractionCandidates({ limit: 10, mimeTypes: ['image/*png'] }))
        .toThrow('must be of the form');
      expect(() => store.extractionCandidates({ limit: 10, mimeTypes: ['*/png'] }))
        .toThrow('must be of the form');
      expect(() => store.extractionCandidates({ limit: 10, mimeTypes: ['  '] }))
        .toThrow('must be non-empty');
      expect(() => store.extractionCandidates({ limit: 10, mimeTypes: [] }))
        .toThrow('must not be empty');
    } finally {
      store.close();
    }
  });

  test('accountScope partitions the enumeration', async () => {
    const store = await seededStore([
      { id: 'mine', accountScope: ACCOUNT },
      { id: 'theirs', accountScope: 'other' },
    ]);
    try {
      expect(ids(store.extractionCandidates({ limit: 10, accountScope: ACCOUNT })))
        .toEqual(['mine']);
      expect(ids(store.extractionCandidates({ limit: 10, accountScope: 'other' })))
        .toEqual(['theirs']);
      expect(ids(store.extractionCandidates({ limit: 10 })).sort())
        .toEqual(['mine', 'theirs']);
    } finally {
      store.close();
    }
  });

  test('the cursor pages across a boundary without dropping or repeating a row', async () => {
    const specs = Array.from({ length: 7 }, (_, index) => ({ id: `item-${index}` }));
    const store = await seededStore(specs);
    try {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const page: ReturnType<typeof store.extractionCandidates> = store.extractionCandidates({
          limit: 3,
          ...(cursor ? { cursor } : {}),
        });
        pages += 1;
        seen.push(...ids(page));
        if (page.done) {
          expect(page.nextCursor).toBeUndefined();
          break;
        }
        expect(page.nextCursor).toBeDefined();
        cursor = page.nextCursor;
        expect(pages).toBeLessThan(10);
      }
      expect(seen).toEqual(specs.map((spec) => spec.id));
      expect(new Set(seen).size).toBe(7);
    } finally {
      store.close();
    }
  });

  test('paging with a media-type filter skips past non-matching rows in one page', async () => {
    // Nine items, only three of which match, with the matches spread out. A
    // page of 3 must return all three in one call rather than returning one
    // match per scanned window.
    const specs = Array.from({ length: 9 }, (_, index) => ({
      id: `mixed-${index}`,
      mimeType: index % 3 === 0 ? 'application/pdf' : 'application/zip',
    }));
    const store = await seededStore(specs);
    try {
      const page = store.extractionCandidates({ limit: 3, mimeTypes: ['application/pdf'] });
      expect(ids(page)).toEqual(['mixed-0', 'mixed-3', 'mixed-6']);
      expect(page.done).toBe(false);
      expect(page.nextCursor).toBeDefined();

      const next = store.extractionCandidates({
        limit: 3,
        mimeTypes: ['application/pdf'],
        cursor: page.nextCursor!,
      });
      expect(ids(next)).toEqual([]);
      expect(next.done).toBe(true);
    } finally {
      store.close();
    }
  });

  test('the limit and cursor are validated rather than coerced', async () => {
    const store = await seededStore([{ id: 'a' }]);
    try {
      expect(() => store.extractionCandidates({ limit: 0 })).toThrow('between 1 and 5,000');
      expect(() => store.extractionCandidates({ limit: 1.5 })).toThrow('between 1 and 5,000');
      expect(() => store.extractionCandidates({ limit: 5_001 })).toThrow('between 1 and 5,000');
      expect(() => store.extractionCandidates({ limit: 10, cursor: 'not-a-number' }))
        .toThrow('non-negative integer');
      expect(() => store.extractionCandidates({ limit: 10, cursor: '-4' }))
        .toThrow('non-negative integer');
    } finally {
      store.close();
    }
  });
});
