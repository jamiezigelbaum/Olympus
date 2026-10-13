// An item that becomes Secret after it was stored keeps no more metadata than
// a Secret detected at ingest (docs/TRUST_MODEL.md, the Secret tier; Codex
// review of PR #338). At ingest a Secret is stored nowhere: its location
// (source, locator, a scanned title, finding kinds) goes to the
// secret-locations index. A stored item the owner marks Secret, or a later
// reading raises to S5, is tombstoned in every store; its row must not keep a
// title, search text or locator carrying the secret, and the tombstone must
// still stop a re-sync from bringing the item back.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { applyOwnerOverrides } from '../src/workers/connector-store/tier-override-settle.ts';
import {
  FIXTURE_PLACEMENT,
  fixtureConnector,
  identityOf,
  localId,
  openTierFixture,
  tempDir,
  type FixtureSpec,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

const FAKE_AWS_KEY = ['AKIA', 'QRSTUVWXYZ234567'].join('');
const KEYS: FixtureSpec = {
  id: 'keys',
  name: `deploy ${FAKE_AWS_KEY}.txt`,
  text: 'Weekly notes about the deploy runbook and the staging bins.',
};
const GARDEN: FixtureSpec = { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden and the compost bins.' };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(): TierFixture {
  const { dir, cleanup } = tempDir('olympus-secret-transition-');
  const opened = openTierFixture(dir);
  cleanups.push(() => {
    opened.close();
    cleanup();
  });
  return opened;
}

/** Every column of every row (items, FTS, chunks) one item has in one store file. */
function storedRows(dbPath: string, localItemId: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const items = db.query('SELECT * FROM items WHERE local_item_id = ?').all(localItemId) as Array<Record<string, unknown>>;
    const pks = items.map((row) => Number(row['item_pk']));
    const byPk = (table: string) => pks.flatMap((pk) =>
      db.query(`SELECT * FROM ${table} WHERE CAST(item_pk AS INTEGER) = ?`).all(pk) as Array<Record<string, unknown>>);
    return {
      items,
      fts: byPk('connector_store_fts'),
      chunks: byPk('chunks'),
      owners: byPk('item_owners'),
      locatorIdentities: byPk('item_locator_identities'),
    };
  } finally {
    db.close();
  }
}

function existingStorePaths(fx: TierFixture): string[] {
  return Object.values(fx.paths).filter((path) => existsSync(path));
}

describe('an item that becomes Secret keeps the location only', () => {
  test('owner-marked: a secret in the title is gone from every row, and a re-sync does not bring the item back', async () => {
    const fx = fixture();
    const specs = [KEYS];
    // The owner said "not a secret" first, so the item was stored with the
    // key-shaped string in its title, search text and locator.
    fx.ledger.setOverride(identityOf('keys'), { kind: 'not_secret' });
    await fx.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const before = existingStorePaths(fx).map((path) => storedRows(path, localId('keys')));
    expect(before.some((rows) => rows.items.some((row) => row['tombstoned'] === 0))).toBe(true);
    expect(JSON.stringify(before)).toContain(FAKE_AWS_KEY);

    // Now the owner marks it Secret, through the same pass the command uses.
    fx.ledger.setOverride(identityOf('keys'), { kind: 'tier', tier: 'secrets' });
    expect(applyOwnerOverrides({ set: fx.set })).toMatchObject({ secrets: 1 });

    const assertLocationOnly = () => {
      for (const path of existingStorePaths(fx)) {
        const rows = storedRows(path, localId('keys'));
        expect(JSON.stringify(rows)).not.toContain(FAKE_AWS_KEY);
        expect(rows.chunks).toEqual([]);
        expect(rows.fts).toEqual([]);
        expect(rows.locatorIdentities).toEqual([]);
        for (const row of rows.items) {
          expect(row).toMatchObject({
            tombstoned: 1,
            trust_tier: 'S5',
            title: null,
            search_text: null,
            locator_uri: null,
            sender_label: null,
            reactions_json: null,
          });
        }
      }
    };
    assertLocationOnly();
    // The location index holds no more than the store rows: no title and no
    // locator, since both carry the key.
    expect(fx.secrets.get(identityOf('keys'))).toMatchObject({ title: null, locator: null });
    const tombstones = existingStorePaths(fx).map((path) => storedRows(path, localId('keys')));
    const tombstoneRows = tombstones.flatMap((rows) => rows.items);
    expect(tombstoneRows.length).toBeGreaterThan(0);

    // A re-sync of the unchanged listing: the tombstone row and its ownership
    // history stay, the item stays tombstoned and unsearchable.
    await fx.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    assertLocationOnly();
    const after = existingStorePaths(fx).map((path) => storedRows(path, localId('keys')));
    expect(after.flatMap((rows) => rows.items.map((row) => row['item_pk'])))
      .toEqual(tombstoneRows.map((row) => row['item_pk']));
    for (const rows of after) {
      if (rows.items.length > 0) expect(rows.owners.length).toBeGreaterThan(0);
    }
    for (const store of fx.set.openStores()) {
      expect(store.searchItems('runbook', 10)).toEqual([]);
      expect(store.searchItems('deploy', 10)).toEqual([]);
      expect(store.localContent(localId('keys'))).toBeUndefined();
    }
  });

  test('owner-marked with a clean title: the row keeps no title and the locator the location index keeps', async () => {
    const fx = fixture();
    await fx.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    fx.ledger.setOverride(identityOf('garden'), { kind: 'tier', tier: 'secrets' });
    expect(applyOwnerOverrides({ set: fx.set })).toMatchObject({ secrets: 1 });

    // An owner-marked Secret's names are Secrets too: the index keeps no
    // title, and the store row keeps no more than the index.
    const location = fx.secrets.get(identityOf('garden'));
    expect(location).toMatchObject({ title: null, locator: '/Files/garden-plan.txt' });
    const rows = storedRows(fx.paths.internal, localId('garden'));
    expect(rows.items).toEqual([expect.objectContaining({
      tombstoned: 1,
      title: null,
      locator_uri: location!.locator,
      search_text: null,
    })]);
    expect(rows.fts).toEqual([]);
    expect(rows.chunks).toEqual([]);
  });
});

describe('a stored item a later reading raises to S5 (one store, declared placement)', () => {
  const ACCOUNT = 'personal';
  const item = (id: string, name: string): RawItem => ({
    identity: {
      family: 'file',
      provider: 'fake',
      accountScope: ACCOUNT,
      providerItemId: id,
      localItemId: `${ACCOUNT}:${id}`,
      sourceVersion: 'rev-1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: `notes for ${id} about the quarterly review` },
    metadata: Object.freeze({ name, title: name, pathDisplay: `/Files/${name}` }),
    fetchedAt: '2026-10-13T00:00:00.000Z',
  });
  const connector = (items: readonly RawItem[]): SourceConnector => ({
    id: 'fake',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* () {
        yield { items: [...items], done: true };
      })();
    },
    async fetchItem(localItemId) {
      const found = items.find((entry) => entry.identity.localItemId === localItemId);
      if (!found) throw new Error('unknown item');
      return found;
    },
    classificationSignals() {
      return {};
    },
  });

  test('the S5 tombstone keeps the location only; an ordinary deletion tombstone keeps its names as before', async () => {
    const { dir, cleanup } = tempDir('olympus-secret-reclassify-');
    const dbPath = join(dir, 'store.sqlite');
    const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fake.files', family: 'file', trustDomain: 'internal' });
    cleanups.push(() => {
      store.close();
      cleanup();
    });
    const items = [item('id:keys', `deploy ${FAKE_AWS_KEY}.txt`), item('id:plan', 'launch-plan.txt'), item('id:old', 'old-notes.txt')];
    const internal = () => buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' });
    await store.syncFromConnector(connector(items), { fetchContent: true, placement: internal });
    expect(JSON.stringify(storedRows(dbPath, `${ACCOUNT}:id:keys`).items)).toContain(FAKE_AWS_KEY);

    // A later reading puts two of them at S5; the third is deleted at the provider.
    const raised = new Set(['id:keys', 'id:plan']);
    const deleted = { ...items[2]!, metadata: Object.freeze({ ...items[2]!.metadata, deleted: true }) };
    await store.syncFromConnector(connector([items[0]!, items[1]!, deleted]), {
      fetchContent: true,
      placement: (entry) => raised.has(entry.identity.providerItemId)
        ? buildSourceSensitivity({ trustTier: 'S5', trustDomain: 'secure_local' })
        : internal(),
    });

    const keys = storedRows(dbPath, `${ACCOUNT}:id:keys`);
    expect(JSON.stringify(keys)).not.toContain(FAKE_AWS_KEY);
    expect(keys.items).toEqual([expect.objectContaining({ tombstoned: 1, trust_tier: 'S5', title: null, search_text: null, locator_uri: null })]);
    // A clean locator passes the same screen the location index uses; the title never stays.
    expect(storedRows(dbPath, `${ACCOUNT}:id:plan`).items).toEqual([expect.objectContaining({
      tombstoned: 1, trust_tier: 'S5', title: null, locator_uri: '/Files/launch-plan.txt', search_text: null,
    })]);
    // Not a Secret: a provider deletion's tombstone is unchanged by this.
    const old = storedRows(dbPath, `${ACCOUNT}:id:old`).items[0]!;
    expect(old).toMatchObject({ tombstoned: 1, title: 'old-notes.txt', locator_uri: '/Files/old-notes.txt' });
    expect(String(old['search_text'])).toContain('old-notes.txt');
    expect(store.searchItems('deploy', 10)).toEqual([]);
  });
});
