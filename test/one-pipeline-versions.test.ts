// Every version of an item an input brings is accepted, classified and routed on
// its own, and the version boundary the store keeps (what is stored, at which
// version) is never lost: not by a partly written item, a tombstone, a Secret,
// or a repair (contract 2.2.0, docs/design/archive-live-one-dataset.md,
// section 2). Run through the real archive import and a real tiered store set;
// synthetic data only.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { onePipelineHarness, FIXTURE_ACCOUNT_SCOPE, type FxRecord, type OnePipelineHarness } from './support/one-pipeline-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const rec = (id: string, version: number, body: string | undefined, extra: Partial<FxRecord> = {}): FxRecord => ({
  id, version, subject: `Subject ${id}`, ...(body !== undefined ? { body } : {}), ...extra,
});

/** A synthetic key header: the content policy treats the text holding one as a Secret. */
const KEY_MARKER = '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';

/** The privacy-safe model has judged every item ordinary. */
const judgedOrdinary: TierSniffer = { id: 'scripted', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) };

/** Every body any leg holds for the item, active or not, joined: a Secret's text must be in none. */
function everyStoredText(h: OnePipelineHarness): string {
  const found: string[] = [];
  for (const domain of ['internal', 'secure_local'] as const) {
    const db = new Database(h.storePaths[domain], { readonly: true });
    try {
      const rows = db.query(`
        SELECT c.text AS text FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.account_scope = ?
      `).all(FIXTURE_ACCOUNT_SCOPE) as Array<{ text: string }>;
      found.push(...rows.map((row) => row.text));
    } catch {
      // A store that holds no chunk table yet holds no text.
    } finally {
      db.close();
    }
  }
  return found.join('\n');
}

describe('every accepted version is classified and routed on its own', () => {
  test('a later version of an item in the same listing is judged afresh: a Secret in v2 is never stored readable', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    // The export holds the item twice: the ordinary version, then a later one that carries a key.
    const id = await h.startImport('versions.mbox', [rec('a', 1, 'lunch plan for friday'), rec('a', 2, `lunch plan edited\n${KEY_MARKER}`)]);
    await h.importAll(id);
    expect(everyStoredText(h)).not.toContain('PRIVATE KEY');
    expect(h.textOf('a')).not.toContain('PRIVATE KEY');
    expect(h.set.ledger.itemIsSecret({ provider: 'fixture-source', accountScope: FIXTURE_ACCOUNT_SCOPE, providerItemId: 'a' })).toBe(true);
  });

  test('the two versions of an item that are both ordinary end as the later one, routed by its own verdict', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    const id = await h.startImport('ordinary.mbox', [rec('a', 1, 'first words'), rec('a', 2, 'second words')]);
    await h.importAll(id);
    expect(h.textOf('a')).toBe('second words');
    expect(h.duplicates()).toEqual([]);
  });
});

describe('the version boundary does not depend on how completely an item was written or whether its row is visible', () => {
  const stateOf = (h: OnePipelineHarness, id: string) =>
    h.set.storedItem({ provider: 'fixture-source', accountScope: FIXTURE_ACCOUNT_SCOPE, providerItemId: id }, (a, b) => Number(a) - Number(b));

  test('a Private body whose metadata leg is missing is not overwritten by an older archive record, and a record of its own version completes it', async () => {
    // Held until judged: the item's names rest in the Personal store and its body in the Private one.
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    await h.importAll(await h.startImport('newest.mbox', [rec('a', 9, 'the newest words')]));
    expect(h.textOf('a')).toBe('the newest words');
    expect(h.contentDomain('a')).toBe('secure_local');
    // The names leg is lost, as when a run stops after one leg.
    const identity = { provider: 'fixture-source', accountScope: FIXTURE_ACCOUNT_SCOPE, providerItemId: 'a', family: 'email' as const, localItemId: `${FIXTURE_ACCOUNT_SCOPE}:a` };
    expect(h.stores.internal.tombstoneCopy(identity, { connectorId: 'test' })).toBe(true);
    expect(stateOf(h, 'a')).toMatchObject({ version: '9', hasContent: true, incomplete: true });

    const id = await h.startImport('older.mbox', [rec('a', 2, 'an old draft')]);
    await h.importAll(id);
    expect(everyStoredText(h)).not.toContain('an old draft');
    expect(h.textOf('a')).toBe('the newest words');

    // The same version arriving again repairs the item: both legs hold it again.
    const again = await h.startImport('same.mbox', [rec('a', 9, 'the newest words')]);
    await h.importAll(again);
    expect(h.textOf('a')).toBe('the newest words');
    expect(stateOf(h, 'a')?.incomplete).toBeUndefined();
    expect(h.rows().filter((row) => row.providerItemId === 'a' && row.tombstoned === 0).map((row) => row.version)).toEqual(['9', '9']);
  });

  test('an older ordinary archive record never restores an item that became a Secret in a later version', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    h.live.records = [rec('a', 9, `now with a key\n${KEY_MARKER}`)];
    await h.pullLive();
    const itemKey = { provider: 'fixture-source', accountScope: FIXTURE_ACCOUNT_SCOPE, providerItemId: 'a' };
    expect(h.set.ledger.itemIsSecret(itemKey)).toBe(true);
    // The store keeps the Secret as a location only, at the version that made it one.
    expect(stateOf(h, 'a')).toMatchObject({ version: '9', hasContent: false, tombstoned: true });

    const id = await h.startImport('harmless.mbox', [rec('a', 2, 'harmless old words')]);
    await h.importAll(id);
    expect(h.ids()).not.toContain('a');
    expect(everyStoredText(h)).not.toContain('harmless old words');
    expect(h.set.ledger.itemIsSecret(itemKey)).toBe(true);
    expect(stateOf(h, 'a')).toMatchObject({ version: '9', tombstoned: true });
  });

  test('a newer archive record is judged on its own over a Secret kept as a location', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    h.live.records = [rec('a', 2, `with a key\n${KEY_MARKER}`)];
    await h.pullLive();
    const id = await h.startImport('newer.mbox', [rec('a', 9, 'the key is gone')]);
    await h.importAll(id);
    expect(h.textOf('a')).toBe('the key is gone');
    expect(stateOf(h, 'a')).toMatchObject({ version: '9', hasContent: true });
  });
});
