import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  parseConnectorStoreLocatorIndexCliArgs,
  runConnectorStoreLocatorIndex,
} from '../scripts/connector-store-locator-index.ts';

const roots: string[] = [];
const STORE_FLAGS = [
  '--corpus-id', 'secure_local.fixture.files',
  '--family', 'file',
  '--trust-domain', 'secure_local',
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('connector-store locator-index operator', () => {
  test('requires an explicit bounded, complete store identity', () => {
    expect(() => parseConnectorStoreLocatorIndexCliArgs([])).toThrow(/Usage/);
    expect(() => parseConnectorStoreLocatorIndexCliArgs([
      '--db', '/tmp/example.sqlite', '--max-items', '10001',
    ])).toThrow(/between 1 and 10,000/);
    expect(() => parseConnectorStoreLocatorIndexCliArgs([
      '--db', '/tmp/example.sqlite', '--corpus-id', 'fixture',
    ])).toThrow(/must be supplied together/);
  });

  test('dry-runs without upgrading and advances one resumable window per execute', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-store-locator-operator-'));
    roots.push(root);
    const dbPath = join(root, 'store.sqlite');
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: 'secure_local.fixture.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
    await store.syncFromConnector(fixtureConnector([
      fixtureItem('one', '/Approved/One.txt'),
      fixtureItem('two', '/Approved/Two.txt'),
    ]));
    store.close();

    // Model the exact pre-change store shape: version 10 has all item data but
    // none of the additive locator projection objects.
    const rewind = new Database(dbPath);
    try {
      rewind.exec(`
        DROP TRIGGER connector_store_locator_identity_insert;
        DROP TRIGGER connector_store_locator_identity_update;
        DROP TABLE item_locator_identities;
        DROP TABLE locator_identity_index_state;
        UPDATE schema_version SET version = 10 WHERE store_id = 'connector-store';
      `);
    } finally {
      rewind.close();
    }

    const args = ['--db', dbPath, ...STORE_FLAGS, '--max-items', '1'];
    expect(runConnectorStoreLocatorIndex(args)).toMatchObject({
      execute: false,
      schemaVersionBefore: 10,
      schemaVersionAfter: 10,
      before: { state: 'schema_upgrade_required' },
      batch: null,
    });

    const first = runConnectorStoreLocatorIndex([...args, '--execute']);
    expect(first).toMatchObject({
      execute: true,
      schemaVersionBefore: 10,
      schemaVersionAfter: 11,
      before: { state: 'backfill_required', cursorItemPk: 0, indexedItems: 0 },
      after: { state: 'backfill_required', indexedItems: 1 },
      batch: { scannedItems: 1 },
      policy: { countsOnly: true, sourceIdentifiersExposed: false, sourceTextExposed: false },
    });
    const second = runConnectorStoreLocatorIndex([...args, '--execute']);
    expect(second).toMatchObject({
      execute: true,
      schemaVersionBefore: 11,
      schemaVersionAfter: 11,
      before: { state: 'backfill_required', indexedItems: 1 },
      after: { state: 'ready', indexedItems: 2 },
      batch: { scannedItems: 1 },
    });
    expect(JSON.stringify(second)).not.toContain(dbPath);
    expect(JSON.stringify(second)).not.toContain('/Approved');
  });
});

function fixtureItem(id: string, locatorUri: string): RawItem {
  return {
    identity: {
      family: 'file',
      provider: 'fixture',
      accountScope: 'personal',
      providerItemId: id,
      providerFileId: id,
      localItemId: `personal:${id}`,
      sourceVersion: 'v1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: `bounded fixture ${id}` },
    metadata: Object.freeze({ locatorUri }),
    fetchedAt: '2026-08-27T12:00:00.000Z',
  };
}

function fixtureConnector(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'fixture',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = items.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!item) throw new Error('missing fixture');
      return item;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}
