// Writes and deletions that are not whole yet, or leave no row, still hold the version boundary:
// a pending Secret, a cascade that must not lower a version, a deletion of an item no store ever held,
// and an edit that empties a body (contract 2.2.0, docs/design/archive-live-one-dataset.md).
// Run through the real archive import and a real tiered store set; synthetic data only.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { fixtureChildId, onePipelineHarness, FIXTURE_ACCOUNT_SCOPE, type FxRecord, type OnePipelineHarness } from './support/one-pipeline-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const rec = (id: string, version: number, body: string | undefined, extra: Partial<FxRecord> = {}): FxRecord => ({
  id, version, subject: `Subject ${id}`, ...(body !== undefined ? { body } : {}), ...extra,
});
const KEY_MARKER = '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
const numeric = (a: string, b: string): number => Number(a) - Number(b);
const stateOf = (h: OnePipelineHarness, id: string) =>
  h.set.storedItem({ provider: 'fixture-source', accountScope: FIXTURE_ACCOUNT_SCOPE, providerItemId: id }, numeric);

function crashOnce(target: { syncFromConnector: (...args: never[]) => Promise<unknown> }): void {
  const orig = target.syncFromConnector.bind(target);
  let thrown = false;
  target.syncFromConnector = (async (...args: never[]) => {
    if (!thrown) { thrown = true; throw new Error('injected crash'); }
    return orig(...args);
  }) as typeof target.syncFromConnector;
}

describe('a pending write holds the version boundary before any row exists', () => {
  test('a Secret whose location row was never written is not replaced by an older ordinary record', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    // The Secret's location row is the Private store's to write: the run stops before it.
    crashOnce(h.stores.secure_local as never);
    const secret = await h.startImport('secret.mbox', [rec('a', 9, `now with a key\n${KEY_MARKER}`)]);
    await h.pull(secret).catch(() => undefined);
    expect(h.set.ledger.writeIntents().map((intent) => intent.kind)).toEqual(['secret']);
    expect(stateOf(h, 'a')).toMatchObject({ version: '9', tombstoned: true });

    await h.importAll(await h.startImport('older.mbox', [rec('a', 5, 'ordinary five')]));
    expect(h.textOf('a')).toBe('');
    expect(h.set.ledger.itemIsSecret({ provider: 'fixture-source', accountScope: FIXTURE_ACCOUNT_SCOPE, providerItemId: 'a' })).toBe(true);
  });
});

describe('a cascade never lowers a version', () => {
  test('a parent\'s deletion tombstones each leg\'s child at its own version, not the version of the other leg\'s row', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    const kid = { key: 'k1', name: 'k1.txt', text: 'child words' };
    // The child at v9 rests in the Personal store (its update landed there).
    await h.importAll(await h.startImport('nine.mbox', [rec('a', 9, 'parent words', { children: [kid] })]));
    const childId = fixtureChildId('a', 'k1');
    // ... and at v1 in the Private one (the update to it never landed).
    const privateDb = new Database(h.storePaths.secure_local);
    try {
      privateDb.query(`
        INSERT INTO items (provider, family, account_scope, provider_item_id, local_item_id, mime_type, fetched_at, indexed_at, trust_tier, tombstoned, sync_run_id, parent_local_item_id, source_version)
        VALUES ('fixture-source', 'email', ?, ?, ?, 'text/plain', '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z', 'S4', 0, 'seed', ?, '1')
      `).run(FIXTURE_ACCOUNT_SCOPE, childId, `${FIXTURE_ACCOUNT_SCOPE}:${childId}`, `${FIXTURE_ACCOUNT_SCOPE}:a`);
    } finally {
      privateDb.close();
    }
    const before = new Map(h.rows().filter((row) => row.providerItemId === childId).map((row) => [row.domain, Number(row.version)]));
    expect([...before]).toEqual([['internal', 9], ['secure_local', 1]]);
    await h.importAll(await h.startImport('gone.mbox', [rec('a', 10, undefined, { deleted: true })]));
    const rows = h.rows().filter((row) => row.providerItemId === childId);
    expect(rows.map((row) => [row.domain, row.tombstoned])).toEqual([['internal', 1], ['secure_local', 1]]);
    for (const row of rows) expect(Number(row.version), `${row.domain} version`).toBeGreaterThanOrEqual(before.get(row.domain) ?? 0);
  });
});

describe('a deletion is remembered whether or not the item was ever stored', () => {
  test('the deletion of an unseen item refuses an older version afterwards', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    await h.importAll(await h.startImport('gone.mbox', [rec('a', 9, undefined, { deleted: true })]));
    expect(stateOf(h, 'a')).toMatchObject({ version: '9', tombstoned: true });
    await h.importAll(await h.startImport('older.mbox', [rec('a', 5, 'ordinary five')]));
    expect(h.textOf('a')).toBe('');
    await h.importAll(await h.startImport('newer.mbox', [rec('a', 10, 'ordinary ten')]));
    expect(h.textOf('a')).toBe('ordinary ten');
  });
});

describe('an edit that empties the body replaces it', () => {
  test('an empty body at a newer version removes the old words; a names-only record keeps them', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    await h.importAll(await h.startImport('one.mbox', [rec('a', 1, 'the old words')]));
    expect(h.textOf('a')).toBe('the old words');
    await h.importAll(await h.startImport('names.mbox', [rec('a', 5, undefined)]));
    expect(h.textOf('a')).toBe('the old words');
    await h.importAll(await h.startImport('empty.mbox', [rec('a', 9, '')]));
    expect(h.textOf('a')).toBe('');
    expect(stateOf(h, 'a')).toMatchObject({ version: '9' });
  });
});
