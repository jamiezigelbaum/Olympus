// A time window that keeps older material as names only (the Gmail mail
// window) must take those rows out of the owed-reading population: they were
// never going to be read, so the status must not count them as work.
//
// Expected numbers below come from the fixture's own dates and text, never
// from running the store: a row is outside the window when it is dated before
// the cutoff AND holds no text.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { ConnectorStoreStatusScope } from '../src/workers/connector-store/local-index.ts';

const ACCOUNT = 'personal';
const CUTOFF = '2026-04-13T00:00:00Z';

interface MailFixture {
  id: string;
  authoredAt?: string;
  /** Absent means a names-only row: subject, sender and date, no body. */
  text?: string;
  deleted?: boolean;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mailConnector(mail: readonly MailFixture[]): SourceConnector {
  const items = mail.map((entry): RawItem => ({
    identity: {
      family: 'email',
      provider: 'gmail',
      accountScope: ACCOUNT,
      providerItemId: entry.id,
      localItemId: `${ACCOUNT}:${entry.id}`,
      sourceVersion: '1',
    },
    mimeType: 'message/rfc822',
    content: entry.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: entry.text },
    metadata: Object.freeze({
      title: `Subject ${entry.id}`,
      subject: `Subject ${entry.id}`,
      from: 'sender@example.com',
      ...(entry.authoredAt ? { authoredAt: entry.authoredAt } : {}),
      locatorUri: `https://mail.google.com/mail/u/0/#all/${entry.id}`,
      ...(entry.deleted ? { deleted: true } : {}),
    }),
    fetchedAt: '2026-10-16T10:00:00.000Z',
  }));
  const byId = new Map(items.map((item) => [item.identity.localItemId, item]));
  return {
    id: 'mail-window-status-fixture',
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

async function openStore(...syncs: ReadonlyArray<readonly MailFixture[]>): Promise<LocalConnectorStore> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-content-window-status-'));
  roots.push(dir);
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'mail.sqlite'),
    corpusId: 'internal.email',
    family: 'email',
    trustDomain: 'internal',
  });
  for (const mail of syncs) await store.syncFromConnector(mailConnector(mail), { fetchContent: true });
  return store;
}

const IN_WINDOW_WITH_TEXT: MailFixture = { id: 'in-window', authoredAt: '2026-06-01T09:00:00Z', text: 'Lunch on Friday works for me.' };
const OLD_NAMES_ONLY: MailFixture = { id: 'old-names-only', authoredAt: '2026-04-06T14:40:48Z' };
const OLD_WITH_TEXT: MailFixture = { id: 'old-with-text', authoredAt: '2026-03-01T08:00:00Z', text: 'An older note whose body was stored in full.' };
const OLD_THEN_DELETED: MailFixture = { id: 'old-deleted', authoredAt: '2026-02-01T08:00:00Z' };

describe('connector store status: material outside a content window', () => {
  test('counts only live, text-less rows dated before the window', async () => {
    const store = await openStore([IN_WINDOW_WITH_TEXT, OLD_NAMES_ONLY, OLD_WITH_TEXT, OLD_THEN_DELETED], [{ ...OLD_THEN_DELETED, deleted: true }]);
    try {
      const counts = store.status({ contentNotBefore: CUTOFF }).counts;
      // The in-window item and the old item that holds text are owed or done as
      // usual; the deleted one is gone; only the old names-only row is outside.
      expect(counts.outsideContentWindowItems).toBe(1);
      expect(counts.items).toBe(3);
      expect(counts.itemsWithText).toBe(2);
    } finally {
      store.close();
    }
  });

  test('with no scope the count is absent, and so is it when nothing is that old', async () => {
    const store = await openStore([IN_WINDOW_WITH_TEXT, OLD_NAMES_ONLY, OLD_WITH_TEXT]);
    try {
      expect('outsideContentWindowItems' in store.status().counts).toBe(false);
      expect('outsideContentWindowItems' in store.status({}).counts).toBe(false);
      expect('outsideContentWindowItems' in store.status({ contentNotBefore: '2026-01-01T00:00:00Z' }).counts).toBe(false);
    } finally {
      store.close();
    }
  });

  test('a window-only scope narrows nothing: no file-scope counts appear', async () => {
    const store = await openStore([IN_WINDOW_WITH_TEXT, OLD_NAMES_ONLY, OLD_WITH_TEXT]);
    try {
      const plain = store.status().counts;
      const windowed = store.status({ contentNotBefore: CUTOFF }).counts;
      const { outsideContentWindowItems, ...rest } = windowed;
      expect(outsideContentWindowItems).toBe(1);
      expect(rest).toEqual(plain);
      for (const key of ['files', 'folders', 'fullIngestionFiles', 'scopeMetadataOnlyFiles', 'contentEligibleItems', 'policyDeferredItems']) {
        expect(key in windowed).toBe(false);
      }
    } finally {
      store.close();
    }
  });

  test('dates are compared as instants, whatever their written form', async () => {
    const store = await openStore([
      // Before the cutoff by half a second, written with fractional seconds.
      { id: 'just-before', authoredAt: '2026-04-12T23:59:59.500Z' },
      // Exactly the cutoff, written another way: not before it.
      { id: 'exactly-at', authoredAt: '2026-04-13T00:00:00.000Z' },
      // 23:00 at -02:00 is 01:00Z on the 13th: after the cutoff.
      { id: 'offset-after', authoredAt: '2026-04-12T23:00:00-02:00' },
      // 01:00 at +02:00 on the 13th is 23:00Z on the 12th: before it.
      { id: 'offset-before', authoredAt: '2026-04-13T01:00:00+02:00' },
      // No usable date: never assumed old.
      { id: 'undated' },
      { id: 'garbled', authoredAt: 'sometime last spring' },
    ]);
    try {
      expect(store.status({ contentNotBefore: CUTOFF }).counts.outsideContentWindowItems).toBe(2);
    } finally {
      store.close();
    }
  });

  test('a scope that also picks files subtracts the same rows from the eligible count', async () => {
    const store = await openStore([IN_WINDOW_WITH_TEXT, OLD_NAMES_ONLY, OLD_WITH_TEXT]);
    try {
      const scope: ConnectorStoreStatusScope = {
        accountScope: ACCOUNT,
        itemFilters: { provider: 'gmail' },
        contentAllowed: true,
        contentFilters: { provider: 'gmail' },
        contentNotBefore: CUTOFF,
      };
      const counts = store.status(scope).counts;
      // Three live rows are in the content scope; the one the window keeps as
      // names only is not owed, so two are left to be read (and both are).
      expect(counts.files).toBe(3);
      expect(counts.fullIngestionFiles).toBe(3);
      expect(counts.outsideContentWindowItems).toBe(1);
      expect(counts.contentEligibleItems).toBe(2);
      expect(counts.itemsWithText).toBe(2);
      // Without the window the same scope owes all three.
      const { contentNotBefore: _window, ...withoutWindow } = scope;
      const unwindowed = store.status(withoutWindow).counts;
      expect(unwindowed.contentEligibleItems).toBe(3);
      expect('outsideContentWindowItems' in unwindowed).toBe(false);
    } finally {
      store.close();
    }
  });
});
