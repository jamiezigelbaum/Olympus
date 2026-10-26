// Every version of an item an input brings is accepted, classified and routed on
// its own, and the version boundary the store keeps (what is stored, at which
// version) is never lost: not by a partly written item, a tombstone, a Secret,
// or a repair (contract 2.2.0, docs/design/archive-live-one-dataset.md,
// section 2). Run through the real archive import and a real tiered store set;
// synthetic data only.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { archiveConnectorId } from '../src/workers/archive-import/state.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
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

  // Versions of one item in a listing: only the newest accepted one of a batch is classified and placed, so two
  // versions never share a plan. The same listing is run whole (one batch) and one record at a time (a batch each,
  // with a crash in the cleanup between two of them).
  const kindsList: Array<Array<'ordinary' | 'secret'>> = [
    ['secret', 'ordinary'], ['ordinary', 'secret'], ['ordinary', 'secret', 'ordinary'], ['secret', 'ordinary', 'secret'],
  ];
  for (const kinds of kindsList) {
    for (const mode of ['one batch', 'a batch each, with a crash between'] as const) {
      test(`versions ${kinds.join(' -> ')} in one listing, ${mode}: the newest decides the stored body, the copy rows and what is readable`, async () => {
        const key = { provider: 'fixture-source', accountScope: FIXTURE_ACCOUNT_SCOPE, providerItemId: 'a' };
        const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary, ...(mode === 'one batch' ? {} : { pageSize: 1 }) });
        h.connectLive();
        const records = kinds.map((kind, at) => rec('a', at + 1, kind === 'secret' ? `key ${at}\n${KEY_MARKER}` : `ordinary words ${at + 1}`));
        const id = await h.startImport('versions.mbox', records);
        if (mode === 'one batch') {
          await h.importAll(id);
        } else {
          // One record per pass; the cleanup after the first Secret is cut off once.
          const original = h.set.ledger.removeCopies.bind(h.set.ledger);
          let crashed = false;
          h.set.ledger.removeCopies = ((...args: Parameters<typeof original>) => {
            if (!crashed) { crashed = true; throw new Error('injected crash'); }
            return original(...args);
          }) as typeof original;
          for (let pass = 0; pass < 12 && h.runtime.state.get(id)?.status !== 'imported'; pass += 1) {
            await h.pull(id, { maxItems: 1 }).catch(() => undefined);
          }
        }
        expect(h.runtime.state.get(id)?.status).toBe('imported');
        expect(everyStoredText(h)).not.toContain('PRIVATE KEY');
        const current = h.set.ledger.copies(key).filter((copy) => copy.state === 'current');
        if (kinds[kinds.length - 1] === 'ordinary') {
          expect(h.textOf('a')).toContain(`ordinary words ${kinds.length}`);
          expect(current.length).toBeGreaterThan(0);
        } else {
          expect(h.textOf('a')).not.toContain('ordinary words');
          expect(current).toEqual([]);
        }
      });
    }
  }

  test('every accepted Secret version advances the version the item is judged against, even once its copy rows are gone: Secret v2, Secret v9, then ordinary v5 is refused and ordinary v10 is accepted', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    const run = async (name: string, records: FxRecord[]) => h.importAll(await h.startImport(name, records));
    await run('s2.mbox', [rec('a', 2, `key two\n${KEY_MARKER}`)]);
    await run('s9.mbox', [rec('a', 9, `key nine\n${KEY_MARKER}`)]);
    expect(h.rows().filter((row) => row.providerItemId === 'a').map((row) => row.version)).not.toContain('2');
    await run('o5.mbox', [rec('a', 5, 'ordinary five')]);
    expect(h.textOf('a')).toBe('');
    expect(everyStoredText(h)).not.toContain('PRIVATE KEY');
    await run('o10.mbox', [rec('a', 10, 'ordinary ten')]);
    expect(h.textOf('a')).toContain('ordinary ten');
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

  test('a body one leg has not written is not overwritten by an older archive record, and a record of its own version completes it', async () => {
    // Held until judged: the item's names rest in the Personal store and its body in the Private one. The run
    // stops after the names leg, so the Private leg still owes the body.
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    const newest = await h.startImport('newest.mbox', [rec('a', 9, 'the newest words')]);
    const orig = h.stores.secure_local.syncFromConnector.bind(h.stores.secure_local);
    let thrown = false;
    h.stores.secure_local.syncFromConnector = (async (...args: Parameters<typeof orig>) => {
      if (!thrown) { thrown = true; throw new Error('injected crash'); }
      return orig(...args);
    }) as typeof orig;
    await h.pull(newest).catch(() => undefined);
    expect(h.textOf('a')).toBe('');
    expect(stateOf(h, 'a')).toMatchObject({ version: '9', incomplete: true });

    const id = await h.startImport('older.mbox', [rec('a', 2, 'an old draft')]);
    await h.importAll(id);
    expect(everyStoredText(h)).not.toContain('an old draft');
    expect(h.textOf('a')).toBe('');

    // The same version arriving again repairs the item: both legs hold it again.
    await h.importAll(newest);
    expect(h.textOf('a')).toBe('the newest words');
    expect(h.contentDomain('a')).toBe('secure_local');
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

describe('a newer archive record is stored before its cursor advances, whatever the item is doing', () => {
  const visibleIn = (h: OnePipelineHarness, id: string) => h.rows()
    .filter((row) => row.providerItemId === id && row.tombstoned === 0 && row.chunks > 0).map((row) => row.domain);

  test('live v3 stored Personal, then archive v9: the v9 body is stored Private, the v3 body is gone, nothing is queued to lose it', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    h.live.records = [rec('a', 3, 'the live words')];
    await h.pullLive();
    expect(visibleIn(h, 'a')).toEqual(['internal']);

    const id = await h.startImport('newer.mbox', [rec('a', 9, 'the archive words')]);
    await h.importAll(id);
    // The newer body is stored in the Private store, held until judged, and the lower copy no longer holds the old body.
    expect(h.textOf('a')).toBe('the archive words');
    expect(visibleIn(h, 'a')).toEqual(['secure_local']);
    expect(everyStoredText(h)).not.toContain('the live words');
    // One current copy set, no move waiting that would copy the old body over it.
    expect(h.set.ledger.copies({ provider: 'fixture-source', accountScope: FIXTURE_ACCOUNT_SCOPE, providerItemId: 'a' }).map((copy) => copy.state)).not.toContain('superseded');
    expect(h.ledgerRecord('a')?.state).not.toBe('moving');
    expect(h.ledgerRecord('a')?.reasons).toContain('content:held_until_judged');
    expect(h.rows().filter((row) => row.providerItemId === 'a' && row.tombstoned === 0).map((row) => row.version)).toEqual(['9', '9']);
  });

  // The replacement is written before the lower copy is withdrawn: a crash at any step leaves a body, and
  // the same record read again finishes the job. Old row versioned (live v3) or without a version.
  for (const oldRow of ['versioned', 'unversioned'] as const) {
    for (const step of ['before the new body is written', 'after the new body, before the withdrawal', 'after the withdrawal'] as const) {
      test(`a crash ${step}, old row ${oldRow}: a body is always there, and reading the record again ends with the new one alone`, async () => {
        const h = onePipelineHarness(cleanups);
        h.connectLive();
        h.live.records = [rec('a', 3, 'the live words')];
        await h.pullLive();
        if (oldRow === 'unversioned') {
          const db = new Database(h.storePaths.internal);
          try { db.query('UPDATE items SET source_version = NULL').run(); } finally { db.close(); }
        }
        const id = await h.startImport('crash.mbox', [rec('a', 9, 'the archive words')]);
        let crashed = false;
        const once = (): void => { if (!crashed) { crashed = true; throw new Error('injected crash'); } };
        if (step === 'before the new body is written') {
          const store = h.set.store('secure_local', { create: true })!;
          const original = store.syncFromConnector.bind(store);
          store.syncFromConnector = ((...args: Parameters<typeof original>) => { once(); return original(...args); }) as typeof original;
        } else {
          const original = h.set.withdrawCopies.bind(h.set);
          h.set.withdrawCopies = (...args: Parameters<typeof original>) => {
            if (step === 'after the new body, before the withdrawal') once();
            original(...args);
            if (step === 'after the withdrawal') once();
          };
        }
        await h.pull(id).catch(() => undefined);
        expect(crashed).toBe(true);
        // The import is not finished, and the record is still to be read: the lookup never says it is already there.
        expect(h.runtime.state.get(id)?.status).not.toBe('imported');
        // Where the replacement is written first (a lower store of its own, not the Private one), a body is there throughout.
        const during = h.textOf('a');
        if (step !== 'before the new body is written') {
          expect(during.includes('the live words') || during.includes('the archive words')).toBe(true);
        }
        const done = await h.importAll(id);
        expect(done.record?.status).toBe('imported');
        expect(h.textOf('a')).toBe('the archive words');
        expect(everyStoredText(h)).not.toContain('the live words');
      });
    }
  }
});

describe('an accepted record no store can take yet is not passed', () => {
  test('an item in the middle of a move holds the record: the import is not complete and its cursor stays; once the move is done the record is stored', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    h.live.records = [rec('a', 3, 'the live words')];
    await h.pullLive();
    const key = { provider: 'fixture-source', accountScope: FIXTURE_ACCOUNT_SCOPE, providerItemId: 'a' };
    // The private model judges the Personal-first live item Private: its raise is queued and the lower copy hidden.
    const queued = h.set.ledger.applySnifferVerdict(
      key,
      { pass: 'content', tier: 'secure', reason: 'content:sniffer:fixture-waiting:private', modelId: 'fixture' },
      { placementFor: (decision) => h.set.placementFor(decision) },
    );
    expect(queued?.outcome).toBe('queued_move');
    expect(h.ledgerRecord('a')?.state).toBe('moving');

    const id = await h.startImport('during-move.mbox', [rec('a', 9, 'the archive words')]);
    const first = await h.pull(id);
    expect(first.record?.status).toBe('importing');
    expect(first.continueSoon).toBe(false);
    expect(first.receipt.warnings?.join(' ')).toContain('archive_items_waiting');
    // The set did not commit a resume point past the record.
    expect(h.set.committedCursor(archiveConnectorId(id))?.cursor ?? null).toBeNull();

    // The move runs where moves run; the same record is then read again and stored.
    const target = h.ledgerRecord('a')!;
    await moveTieredItem({
      set: h.set,
      identity: { ...key, family: 'email', localItemId: `${FIXTURE_ACCOUNT_SCOPE}:a` },
      target: { metadataTier: target.targetMetadataTier!, contentTier: target.targetContentTier! },
    });
    const done = await h.importAll(id);
    expect(done.record?.status).toBe('imported');
    expect(h.textOf('a')).toBe('the archive words');
    expect(h.duplicates()).toEqual([]);
  });
});
