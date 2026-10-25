// Contract 2.2.0 (docs/design/archive-live-one-dataset.md, sections 1 to 3):
// one connector reads more than one input; each record is decided against the
// stored item before the item is built; and an item an archive input built
// carries its hold with it. Run through a real tiered store set, ledger and
// stores, with a source-neutral fixture builder. Synthetic data only.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorInput,
  SourceInputKind,
  SourceRecordPage,
  StoredItemState,
} from '../src/core/contracts.ts';
import {
  decideIntake,
  inputConnector,
  type IntakeObservingInput,
  type SourceIntakeOutcome,
  type SourceRecordBuilder,
} from '../src/core/source-inputs.ts';
import { holdingItems } from '../src/workers/archive-import/source-input.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { HELD_UNTIL_JUDGED_REASON, type TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import type { ConnectorStoreTierClassification } from '../src/workers/connector-store/tier-placement.ts';
import { TieredStoreSet, tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { ACCOUNT, CORPORA, FIXTURE_PLACEMENT, PROVIDER, openLegStore, storePaths, tempDir } from './helpers/tier-fixtures.ts';

interface Rec {
  id: string;
  version: number;
  name: string;
  text?: string;
}

const numeric = (a: string, b: string): number => Number(a) - Number(b);

const builder: SourceRecordBuilder<Rec> = {
  family: 'file',
  entriesOf: (record) => [{
    identity: {
      family: 'file', provider: PROVIDER, accountScope: ACCOUNT, providerItemId: record.id,
      localItemId: `${ACCOUNT}:${record.id}`, sourceVersion: String(record.version),
    },
    bringsContent: record.text !== undefined,
  }],
  compareVersions: numeric,
  build: (record): RawItem[] => [{
    identity: {
      family: 'file', provider: PROVIDER, accountScope: ACCOUNT, providerItemId: record.id,
      localItemId: `${ACCOUNT}:${record.id}`, sourceVersion: String(record.version),
    },
    mimeType: 'text/plain',
    content: record.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: record.text },
    metadata: Object.freeze({ name: record.name, title: record.name, pathDisplay: `/Files/${record.name}`, legacyDomain: 'secure_local' }),
    fetchedAt: '2026-10-25T00:00:00.000Z',
  }],
  fetchItem: () => Promise.reject(new Error('not used')),
  classificationSignals: (item) => ({ title: String(item.metadata['name'] ?? ''), path: String(item.metadata['pathDisplay'] ?? '') }),
};

function input(kind: SourceInputKind, id: string, records: readonly Rec[], extra: Partial<IntakeObservingInput<Rec>> = {}): IntakeObservingInput<Rec> {
  return {
    inputId: id,
    kind,
    async *records(): AsyncGenerator<SourceRecordPage<Rec>> {
      await Promise.resolve();
      yield { records, done: true };
    },
    ...extra,
  };
}

const waiting: TierSniffer = { id: 'fixture-waiting', judge: () => ({ verdict: 'undecided', queued: true }) };
const HOLD_OPTIONS: ConnectorStoreTierClassification = { sniffer: waiting };

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

/** A Personal store and a Private store under one set ledger, both created. */
function lane(classification: ConnectorStoreTierClassification = HOLD_OPTIONS) {
  const tmp = tempDir('olympus-source-inputs-');
  const paths = storePaths(tmp.dir);
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
  const secrets = new SecretLocationsIndex({ dbPath: join(tmp.dir, 'secret-locations.sqlite') });
  const stores = { internal: openLegStore(paths, 'internal', ledger), secure_local: openLegStore(paths, 'secure_local', ledger) };
  const set = new TieredStoreSet({
    setId: 'source-inputs', ledger, secretLocations: secrets, tierClassification: classification,
    legs: [
      { trustDomain: 'internal', corpusId: CORPORA.internal, store: stores.internal },
      { trustDomain: 'secure_local', corpusId: CORPORA.secure_local, store: stores.secure_local, legacy: true },
    ],
  });
  cleanups.push(() => { stores.internal.close(); stores.secure_local.close(); secrets.close(); ledger.close(); tmp.cleanup(); });
  const identity = (id: string) => ({ provider: PROVIDER, accountScope: ACCOUNT, providerItemId: id });
  /** The active item ids a store file holds. */
  const ids = (domain: 'internal' | 'secure_local'): string[] => {
    const db = new Database(paths[domain], { readonly: true });
    try {
      return (db.query('SELECT provider_item_id AS id FROM items WHERE tombstoned = 0 ORDER BY provider_item_id').all() as Array<{ id: string }>).map((row) => row.id);
    } finally {
      db.close();
    }
  };
  /** Every stored item id, across the legs. */
  const allIds = (): string[] => [...new Set([...ids('internal'), ...ids('secure_local')])].sort();
  /** The text stored for an item, from whichever leg holds it. */
  const textOf = (id: string): string => [stores.internal, stores.secure_local]
    .flatMap((store) => store.localContent(`${ACCOUNT}:${id}`)?.chunks ?? []).join(' ');
  return { set, ledger, stores, identity, ids, allIds, textOf };
}

const SYNC = { fetchContent: true, placement: FIXTURE_PLACEMENT };

async function sync(set: TieredStoreSet, connector: SourceConnector): Promise<void> {
  await set.sync(connector, SYNC);
}

describe('the intake rule', () => {
  const stored = (version: string | undefined, hasContent: boolean): StoredItemState => ({ ...(version !== undefined ? { version } : {}), hasContent });
  const decide = (kind: SourceInputKind, version: string | undefined, bringsContent: boolean, s: StoredItemState | undefined) =>
    decideIntake({ input: kind, version, bringsContent, stored: s, compareVersions: numeric });

  test('nothing stored, or a stored item with no version to compare, applies from either input', () => {
    for (const kind of ['live', 'archive'] as const) {
      expect(decide(kind, '1', false, undefined)).toBe('apply');
      expect(decide(kind, '1', true, stored(undefined, true))).toBe('apply');
    }
  });

  test('a newer record applies and an older one never does, whichever input it came from', () => {
    for (const kind of ['live', 'archive'] as const) {
      expect(decide(kind, '3', false, stored('2', true))).toBe('apply');
      expect(decide(kind, '1', true, stored('2', false))).toBe('skip_older');
      expect(decide(kind, '1', true, stored('2', true))).toBe('skip_older');
    }
  });

  test('at the same version a record applies only when it brings content the stored item lacks', () => {
    for (const kind of ['live', 'archive'] as const) {
      expect(decide(kind, '2', true, stored('2', false))).toBe('apply');
      expect(decide(kind, '2', false, stored('2', false))).toBe('skip_same');
      expect(decide(kind, '2', false, stored('2', true))).toBe('skip_same');
    }
  });

  test('on a tie, live is kept: a live record applies and an archive record does not', () => {
    expect(decide('live', '2', true, stored('2', true))).toBe('apply');
    expect(decide('archive', '2', true, stored('2', true))).toBe('skip_same');
    // A live record with nothing new does not undo content an archive brought.
    expect(decide('live', '2', false, stored('2', true))).toBe('skip_same');
  });

  test('an item cut off between legs is completed by a record of its own version and never by an older one', () => {
    for (const kind of ['live', 'archive'] as const) {
      const cutOff: StoredItemState = { version: '5', hasContent: true, incomplete: true };
      expect(decide(kind, '5', true, cutOff)).toBe('apply');
      expect(decide(kind, '6', false, cutOff)).toBe('apply');
      expect(decide(kind, '4', true, cutOff)).toBe('skip_older');
    }
  });

  test('an item whose every row is a tombstone comes back only with a newer record (live also at the same version)', () => {
    const gone: StoredItemState = { version: '5', hasContent: false, tombstoned: true };
    for (const kind of ['live', 'archive'] as const) {
      expect(decide(kind, '6', true, gone)).toBe('apply');
      expect(decide(kind, '4', true, gone)).toBe('skip_older');
    }
    expect(decide('archive', '5', true, gone)).toBe('skip_same');
    expect(decide('live', '5', true, gone)).toBe('apply');
    // A tombstone with no version to compare is not brought back by an archive record.
    expect(decide('archive', '5', true, { hasContent: false, tombstoned: true })).toBe('skip_same');
    expect(decide('live', '5', true, { hasContent: false, tombstoned: true })).toBe('apply');
  });

  test('a record with no version is taken as the stored one\'s', () => {
    expect(decide('archive', undefined, true, stored('2', false))).toBe('apply');
    expect(decide('archive', undefined, true, stored('2', true))).toBe('skip_same');
  });
});

describe('inputs through a real store set', () => {
  test('live then archive, and archive then live, give one dataset with no duplicates', async () => {
    const f = lane({});
    const live = (records: Rec[]) => inputConnector(builder, input('live', 'fixture_live', records));
    const archive = (records: Rec[]) => inputConnector(builder, input('archive', 'archive.one', records));
    await sync(f.set, live([{ id: 'a', version: 1, name: 'A', text: 'alpha live' }, { id: 'b', version: 1, name: 'B', text: 'beta live' }]));
    await sync(f.set, archive([{ id: 'b', version: 1, name: 'B', text: 'beta archive' }, { id: 'c', version: 1, name: 'C', text: 'gamma archive' }]));
    const ids = (): string[] => f.allIds();
    expect(ids()).toEqual(['a', 'b', 'c']);
    // The archive's copy of b, at the same version with content, did not replace live's.
    expect(f.textOf('b')).toContain('beta live');
    // And the other way round: an archive is imported first, live arrives later.
    await sync(f.set, live([{ id: 'c', version: 1, name: 'C', text: 'gamma live' }, { id: 'd', version: 1, name: 'D', text: 'delta live' }]));
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
    expect(f.textOf('c')).toContain('gamma live');
  });

  test('an older record never overwrites a newer one, from either input', async () => {
    const f = lane({});
    const live = (records: Rec[]) => inputConnector(builder, input('live', 'fixture_live', records));
    const archive = (records: Rec[]) => inputConnector(builder, input('archive', 'archive.one', records));
    await sync(f.set, archive([{ id: 'a', version: 3, name: 'A', text: 'edited three' }]));
    await sync(f.set, live([{ id: 'a', version: 2, name: 'A', text: 'queued two' }]));
    expect(f.textOf('a')).toContain('edited three');
    await sync(f.set, live([{ id: 'z', version: 5, name: 'Z', text: 'live five' }]));
    await sync(f.set, archive([{ id: 'z', version: 4, name: 'Z', text: 'archive four' }]));
    expect(f.textOf('z')).toContain('live five');
    // A newer record from either input does apply.
    await sync(f.set, archive([{ id: 'z', version: 6, name: 'Z', text: 'archive six' }]));
    expect(f.textOf('z')).toContain('archive six');
  });

  test('at the same version a record applies only if it brings content the stored item lacks', async () => {
    const f = lane({});
    const live = (records: Rec[]) => inputConnector(builder, input('live', 'fixture_live', records));
    const archive = (records: Rec[]) => inputConnector(builder, input('archive', 'archive.one', records));
    // Live knows the message by name only (a metadata-only record); the archive brings its text.
    await sync(f.set, live([{ id: 'm', version: 1, name: 'M' }]));
    expect(f.set.storedItem(f.identity('m'), numeric)).toEqual({ version: '1', hasContent: false });
    await sync(f.set, archive([{ id: 'm', version: 1, name: 'M', text: 'text from the archive' }]));
    expect(f.set.storedItem(f.identity('m'), numeric)).toEqual({ version: '1', hasContent: true });
    // Live's names-only record at the same version does not take it away.
    await sync(f.set, live([{ id: 'm', version: 1, name: 'M' }]));
    expect(f.set.storedItem(f.identity('m'), numeric)).toEqual({ version: '1', hasContent: true });
    // An archive record without the content, where live has none either, adds nothing.
    await sync(f.set, live([{ id: 'n', version: 1, name: 'N' }]));
    await sync(f.set, archive([{ id: 'n', version: 1, name: 'N' }]));
    expect(f.set.storedItem(f.identity('n'), numeric)).toEqual({ version: '1', hasContent: false });
  });

  test('the lookup is the set\'s: none for an unknown item, one answer across every leg', async () => {
    const f = lane({});
    expect(f.set.storedItem(f.identity('nothing'), numeric)).toBeUndefined();
    await sync(f.set, inputConnector(builder, input('live', 'fixture_live', [{ id: 'a', version: 7, name: 'A', text: 'seven' }])));
    expect(f.set.storedItem(f.identity('a'), numeric)).toEqual({ version: '7', hasContent: true });
  });

  test('a record cut off between legs keeps its version: its own version or a newer one completes it, an older one never applies', async () => {
    const f = lane(HOLD_OPTIONS);
    // A held item's names rest in the Personal store and its content in the Private one.
    const held = input('archive', 'archive.held', [{ id: 'a', version: 1, name: 'Orchard picnic list', text: 'We bring bananas.' }]);
    await sync(f.set, holdingItems(inputConnector(builder, held)));
    expect(f.set.storedItem(f.identity('a'), numeric)).toEqual({ version: '1', hasContent: true });
    // The Personal copy of the item's names is lost, as when a run stops after one leg.
    expect(f.stores.internal.tombstoneCopy({ ...f.identity('a'), family: 'file', localItemId: `${ACCOUNT}:a` }, { connectorId: 'test' })).toBe(true);
    expect(f.set.storedItem(f.identity('a'), numeric)).toEqual({ version: '1', hasContent: true, incomplete: true });
    // An older record does not apply to it: the version boundary holds although a leg is missing.
    await sync(f.set, holdingItems(inputConnector(builder, input('archive', 'archive.older', [{ id: 'a', version: 0, name: 'Old list', text: 'Nothing yet.' }]))));
    expect(f.set.storedItem(f.identity('a'), numeric)).toEqual({ version: '1', hasContent: true, incomplete: true });
    // A record of its own version completes it, and the item is whole again.
    await sync(f.set, holdingItems(inputConnector(builder, input('archive', 'archive.held2', [{ id: 'a', version: 1, name: 'Orchard picnic list', text: 'We bring bananas.' }]))));
    expect(f.set.storedItem(f.identity('a'), numeric)).toEqual({ version: '1', hasContent: true });
  });

  test('each input keeps its own cursor and the lookup reaches the connector', async () => {
    const f = lane({});
    let seenLookup = false;
    const watching: IntakeObservingInput<Rec> = {
      inputId: 'archive.cursors',
      kind: 'archive',
      async *records(options): AsyncGenerator<SourceRecordPage<Rec>> {
        await Promise.resolve();
        yield { records: [{ id: String(options?.cursor ?? 'start'), version: 1, name: 'X', text: 'x' }], nextCursor: 'after-1', done: true };
      },
    };
    const connector = inputConnector(builder, watching);
    const original = connector.listItems.bind(connector);
    connector.listItems = (options) => { seenLookup = typeof options?.storedItem === 'function'; return original(options); };
    await sync(f.set, connector);
    expect(seenLookup).toBe(true);
    expect(f.set.committedCursor('archive.cursors')?.cursor).toBe('after-1');
    expect(f.set.committedCursor('fixture_live')).toBeUndefined();
  });

  test('records of one pass are decided against each other: the newer of two versions in one listing applies', async () => {
    const f = lane({});
    const outcomes: SourceIntakeOutcome[] = [];
    const both = input('archive', 'archive.two', [
      { id: 'a', version: 2, name: 'A', text: 'second' },
      { id: 'a', version: 1, name: 'A', text: 'first' },
    ], { observeIntake: (page) => { outcomes.push(...page); } });
    await sync(f.set, inputConnector(builder, both));
    expect(f.textOf('a')).toContain('second');
    expect(outcomes.map((outcome) => outcome.decision)).toEqual(['apply', 'skip_older']);
    // The second record found the first already there (it was applied earlier in the same pass).
    expect(outcomes.map((outcome) => outcome.alreadyThere)).toEqual([false, true]);
  });
  test('two versions of one item in a batch never go to the store together: only the newest does, and its older version is told as older', async () => {
    const outcomes: SourceIntakeOutcome[] = [];
    const rising = input('archive', 'archive.rising', [
      { id: 'a', version: 1, name: 'A', text: 'first' },
      { id: 'b', version: 1, name: 'B', text: 'other' },
      { id: 'a', version: 2, name: 'A', text: 'second' },
      { id: 'a', version: 3, name: 'A', text: 'third' },
    ], { observeIntake: (page) => { outcomes.push(...page); } });
    const pages: string[][] = [];
    for await (const page of inputConnector(builder, rising).listItems({})) pages.push(page.items.map((item) => `${item.identity.providerItemId}@${item.identity.sourceVersion}`));
    expect(pages).toEqual([['b@1', 'a@3']]);
    expect(outcomes.map((outcome) => outcome.decision)).toEqual(['skip_older', 'apply', 'skip_older', 'apply']);
  });
});

describe('the hold travels with the item', () => {
  const archiveHeld = (records: Rec[]) => holdingItems(inputConnector(builder, input('archive', 'archive.held', records)));
  const live = (records: Rec[]) => inputConnector(builder, input('live', 'fixture_live', records));
  const BODY = 'Quietorchardmarker with ordinary words about bananas and oranges for the picnic on Saturday.';

  test('an item an archive input built is held Private until judged; a live-only item is not', async () => {
    const f = lane(HOLD_OPTIONS);
    await sync(f.set, archiveHeld([{ id: 'held', version: 1, name: 'Orchard picnic list', text: BODY }]));
    await sync(f.set, live([{ id: 'free', version: 1, name: 'Orchard picnic list', text: BODY }]));
    const held = f.ledger.getCurrent({ ...f.identity('held') })!;
    const free = f.ledger.getCurrent({ ...f.identity('free') })!;
    expect(held.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
    expect(held).toMatchObject({ state: 'pending', contentPending: true, contentTier: 'private' });
    expect(free.reasons).not.toContain(HELD_UNTIL_JUDGED_REASON);
    // Held content rests Private and its embedding is held.
    expect(f.ledger.copies(f.identity('held'))).toContainEqual(expect.objectContaining({ trustDomain: 'secure_local', layers: 'content', embedHold: true }));
    expect(f.stores.internal.localContent(`${ACCOUNT}:held`)?.chunks ?? []).toEqual([]);
  });

  test('the persisted hold keeps applying to a later version, whichever input brings it', async () => {
    const f = lane(HOLD_OPTIONS);
    await sync(f.set, archiveHeld([{ id: 'held', version: 1, name: 'Orchard picnic list', text: BODY }]));
    // A live replacement of a held item is held too: it errs Private.
    await sync(f.set, live([{ id: 'held', version: 2, name: 'Orchard picnic list', text: `${BODY} Edited.` }]));
    const record = f.ledger.getCurrent(f.identity('held'))!;
    expect(record.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
    expect(record).toMatchObject({ contentPending: true });
    expect(f.set.storedItem(f.identity('held'), numeric)?.version).toBe('2');
    expect(f.stores.internal.localContent(`${ACCOUNT}:held`)?.chunks ?? []).toEqual([]);
  });
});

// The contract types are reachable from the connector alone.
test('a SourceConnectorInput is plain data the archive layer can supply', () => {
  const sample: SourceConnectorInput<Rec> = input('archive', 'archive.x', []);
  expect(sample.kind).toBe('archive');
});
