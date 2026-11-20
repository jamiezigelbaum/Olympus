// The loop-stall test turns on OLYMPUS_SQLITE_BUSY_DIAGNOSTIC so that a sync
// whose sync_runs write fails with SQLITE_BUSY says how long it waited, whether
// the store's connection was inside a transaction, and its busy_timeout. That
// tells an open reader on the store's own connection (a failure in a few ms,
// in a transaction) from a long writer elsewhere (a failure after the timeout).

import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

const ACCOUNT = 'dropbox.personal';
const FLAG = 'OLYMPUS_SQLITE_BUSY_DIAGNOSTIC';
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function heldStore(): { store: LocalConnectorStore; holder: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'sync-busy-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'store.sqlite');
  const store = new LocalConnectorStore({ dbPath, corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local' });
  cleanups.push(() => store.close());
  // A short wait keeps the test quick; the shape of the failure is what counts.
  (store as unknown as { db: Database }).db.exec('PRAGMA busy_timeout = 100');
  const holder = new Database(dbPath);
  holder.exec('BEGIN IMMEDIATE');
  cleanups.push(() => { try { holder.exec('ROLLBACK'); } catch { /* already ended */ } holder.close(); });
  return { store, holder };
}

function withFlag(value: string | undefined): void {
  const before = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  cleanups.push(() => { if (before === undefined) delete process.env[FLAG]; else process.env[FLAG] = before; });
}

test('with the diagnostic on, a sync whose start is refused names the wait, the transaction state and the timeout', async () => {
  withFlag('1');
  const { store } = heldStore();
  const error = await store.syncFromConnector(connector([file('a.txt', 'alpha')]), { fetchContent: true }).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toMatch(/\(sync_runs start: SQLITE_BUSY\S* after (\d+) ms, in_transaction=false, busy_timeout=100\)$/);
  // It waited the timeout: the store's connection held no reader, another connection held the lock.
  expect(Number(/after (\d+) ms/.exec(message)![1])).toBeGreaterThanOrEqual(90);
});

test('with the diagnostic off, the refusal is reported as before', async () => {
  withFlag(undefined);
  const { store } = heldStore();
  const error = await store.syncFromConnector(connector([file('a.txt', 'alpha')]), { fetchContent: true }).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain('sync_runs start');
});

function file(name: string, text: string): RawItem {
  return {
    identity: { family: 'file', provider: 'dropbox', accountScope: ACCOUNT, providerItemId: name, localItemId: `${ACCOUNT}:${name}`, sourceVersion: 'rev-1' },
    mimeType: 'text/plain',
    content: { kind: 'text', text },
    metadata: { title: name },
    fetchedAt: '2026-08-31T12:00:00.000Z',
  };
}

function connector(items: RawItem[]): SourceConnector {
  return {
    id: 'dropbox-test',
    family: 'file',
    async authenticate() {},
    listItems() { return (async function* () { yield { items, done: true }; })(); },
    async fetchItem(localItemId: string) {
      const found = items.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!found) throw new Error(`missing item ${localItemId}`);
      return found;
    },
    classificationSignals() { return {}; },
  };
}
