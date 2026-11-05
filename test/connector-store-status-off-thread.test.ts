// A store's status counts read on the second thread (#870) must be the same
// counts status() reads on this one, and must not be read on this thread.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

const ACCOUNT = 'personal';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function connector(mail: ReadonlyArray<{ id: string; authoredAt: string; text?: string }>): SourceConnector {
  const items = mail.map((entry): RawItem => ({
    identity: {
      family: 'email', provider: 'gmail', accountScope: ACCOUNT,
      providerItemId: entry.id, localItemId: `${ACCOUNT}:${entry.id}`, sourceVersion: '1',
    },
    mimeType: 'message/rfc822',
    content: entry.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: entry.text },
    metadata: Object.freeze({
      title: `Subject ${entry.id}`, subject: `Subject ${entry.id}`, from: 'sender@example.com',
      authoredAt: entry.authoredAt, locatorUri: `https://mail.google.com/mail/u/0/#all/${entry.id}`,
    }),
    fetchedAt: '2026-10-16T10:00:00.000Z',
  }));
  const byId = new Map(items.map((item) => [item.identity.localItemId, item]));
  return {
    id: 'status-off-thread-fixture',
    family: 'email',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = byId.get(localItemId);
      if (!item) throw new Error(`missing fixture ${localItemId}`);
      return item;
    },
    classificationSignals() {
      return {};
    },
  };
}

const MAIL = [
  { id: 'a', authoredAt: '2026-06-01T09:00:00Z', text: 'Lunch on Friday works for me.' },
  { id: 'b', authoredAt: '2026-04-06T14:40:48Z' },
  { id: 'c', authoredAt: '2026-03-01T08:00:00Z', text: 'An older note whose body was stored in full.' },
];

function fileStore(): LocalConnectorStore {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-status-off-thread-'));
  roots.push(dir);
  return new LocalConnectorStore({ dbPath: join(dir, 'mail.sqlite'), corpusId: 'internal.email', family: 'email', trustDomain: 'internal' });
}

/** Counts this thread's queries whose SQL contains `marker`. */
function countMainThreadQueries(store: LocalConnectorStore, marker: string): () => number {
  const db = (store as unknown as { db: { query: (sql: string) => unknown } }).db;
  const original = db.query.bind(db);
  let seen = 0;
  db.query = (sql: string) => {
    if (sql.includes(marker)) seen += 1;
    return original(sql);
  };
  return () => seen;
}

describe('connector store status off the worker thread', () => {
  test('reads the same counts as status(), and none of them on this thread', async () => {
    const store = fileStore();
    try {
      await store.syncFromConnector(connector(MAIL), { fetchContent: true });
      for (const scope of [undefined, { contentNotBefore: '2026-04-13T00:00:00Z' }]) {
        const here = store.status(scope);
        const seen = countMainThreadQueries(store, 'WITH flags AS MATERIALIZED');
        const there = await store.statusOffThread(scope);
        expect(seen()).toBe(0);
        expect(there).toEqual(here);
      }
      // Written expectations, independent of either path: three live items, two with text.
      const counts = (await store.statusOffThread()).counts;
      expect(counts.items).toBe(3);
      expect(counts.itemsWithText).toBe(2);
    } finally {
      store.close();
    }
  });

  test('sees what this thread has written since', async () => {
    const store = fileStore();
    try {
      await store.syncFromConnector(connector(MAIL.slice(0, 1)), { fetchContent: true });
      expect((await store.statusOffThread()).counts.items).toBe(1);
      await store.syncFromConnector(connector(MAIL), { fetchContent: true });
      expect((await store.statusOffThread()).counts.items).toBe(3);
    } finally {
      store.close();
    }
  });

  test('an in-memory store is counted on this thread, as status() does', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'internal.email', family: 'email', trustDomain: 'internal' });
    try {
      await store.syncFromConnector(connector(MAIL), { fetchContent: true });
      expect(await store.statusOffThread()).toEqual(store.status());
    } finally {
      store.close();
    }
  });
});

describe('off-thread snapshot', () => {
  test('every read in one snapshot sees the same state, whatever is written meanwhile', async () => {
    const store = fileStore();
    try {
      await store.syncFromConnector(connector(MAIL.slice(0, 1)), { fetchContent: true });
      const { withOffThreadSnapshot } = await import('../src/workers/connector-store/off-thread-reads.ts');
      const count = { sql: 'SELECT COUNT(*) AS n FROM items WHERE tombstoned = 0', params: [], mode: 'get' as const };
      const [before, after] = await withOffThreadSnapshot(store.dbPath, async (read) => {
        const first = (await read(count)) as { n: number };
        await store.syncFromConnector(connector(MAIL), { fetchContent: true });
        const second = (await read(count)) as { n: number };
        return [first.n, second.n];
      });
      expect(before).toBe(1);
      expect(after).toBe(1);
      expect((await store.statusOffThread()).counts.items).toBe(3);
    } finally {
      store.close();
    }
  });
});

describe('status handler', () => {
  test('callers that find the counts expired together share one off-thread read', async () => {
    const { createSourceIndexStatusHandler } = await import('../src/workers/source-index/status.ts');
    const store = fileStore();
    try {
      await store.syncFromConnector(connector(MAIL), { fetchContent: true });
      let reads = 0;
      const read = store.statusOffThread.bind(store);
      store.statusOffThread = ((...args: Parameters<typeof store.statusOffThread>) => {
        reads += 1;
        return read(...args);
      }) as typeof store.statusOffThread;
      const handler = createSourceIndexStatusHandler({
        corpusDefinitions: [{ corpusId: 'internal.email', family: 'email', trustDomain: 'internal' } as never],
        connectorStores: [store],
      });
      const [a, b] = await Promise.all([
        handler.status({}, { countsMaxAgeMs: 60_000 }),
        handler.status({}, { countsMaxAgeMs: 60_000 }),
      ]);
      expect(reads).toBe(1);
      expect(b.corpora[0]).toEqual(a.corpora[0]);
    } finally {
      store.close();
    }
  });
});
