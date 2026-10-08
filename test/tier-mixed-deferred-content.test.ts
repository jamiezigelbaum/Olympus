// A lane whose listing reads documents itself but never a picture (Google
// Drive): only its still images' text arrives later, through the shared
// extraction factory (TieredStoreSetOptions.contentArrivesLaterFor).
//
// A NEW photo's names are routed by their metadata tier at listing, and its
// content lands in the Private store when extraction reads it, exactly as in
// a lane whose every item's text arrives later (Dropbox). Every other item
// keeps the lane's own rules. Each of the lane's stores is served by its own
// extraction corpus, and every item is listed by exactly one of them.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import type { SourceTrustDomain } from '../src/core/source-index/types.ts';
import { isImageMediaType } from '../src/workers/classification/tier-classifier.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { tieredExtractionView } from '../src/workers/connector-store/tiered-extraction.ts';
import {
  TieredStoreSet,
  tieredStoreSetLedgerPath,
} from '../src/workers/connector-store/tiered-store-set.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import type { ExtractionSinkRequest } from '../src/workers/file-extraction/types.ts';
import {
  ACCOUNT,
  CORPORA,
  FIXTURE_PLACEMENT,
  PROVIDER,
  fixtureConnector,
  fixtureItem,
  identityOf,
  localId,
  openLegStore,
  snapshotStore,
  storePaths,
  tempDir,
  type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const MIME: Record<string, string> = {
  'doc-read': 'text/plain',
  'photo-new': 'image/jpeg',
  'scan-unread': 'application/pdf',
  'photo-public': 'image/png',
};

const SPECS: FixtureSpec[] = [
  { id: 'doc-read', name: 'garden-diary.txt', text: 'A garden diary entry about the tomato beds.' },
  { id: 'photo-new', name: 'IMG_0412.jpg' },
  { id: 'scan-unread', name: 'scan-0413.pdf' },
  { id: 'photo-public', name: 'conference-poster.png', sharing: 'public_link' },
];

/** The fixture lane, with each item's own media type. */
function lane(specs: readonly FixtureSpec[]): SourceConnector {
  const base = fixtureConnector(() => specs);
  const withMime = (item: RawItem): RawItem => ({ ...item, mimeType: MIME[item.identity.providerItemId] ?? item.mimeType });
  return {
    ...base,
    listItems() {
      const pages = base.listItems();
      return (async function* () {
        for await (const page of pages) yield { ...page, items: page.items.map(withMime) };
      })();
    },
    async fetchItem(localItemId) {
      return withMime(await base.fetchItem(localItemId));
    },
  };
}

function openSet(registerWithLedger = true) {
  const { dir, cleanup } = tempDir('olympus-tier-mixed-');
  const paths = storePaths(dir);
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
  const secrets = new SecretLocationsIndex({ dbPath: join(dir, 'secret-locations.sqlite') });
  const stores: Partial<Record<SourceTrustDomain, LocalConnectorStore>> = {
    internal: openLegStore(paths, 'internal', ledger),
    secure_local: openLegStore(paths, 'secure_local', ledger),
  };
  const set = new TieredStoreSet({
    setId: 'fixture.mixed',
    ledger,
    secretLocations: secrets,
    contentArrivesLaterFor: (item) => isImageMediaType(item.mimeType),
    registerWithLedger,
    legs: [
      {
        trustDomain: 'public_safe',
        corpusId: CORPORA.public_safe,
        open: () => (stores.public_safe ??= openLegStore(paths, 'public_safe', ledger)),
        exists: () => existsSync(paths.public_safe),
      },
      { trustDomain: 'internal', corpusId: CORPORA.internal, store: stores.internal!, legacy: true },
      { trustDomain: 'secure_local', corpusId: CORPORA.secure_local, store: stores.secure_local!, legacy: true },
    ],
  });
  cleanups.push(() => {
    for (const store of Object.values(stores)) store?.close();
    secrets.close();
    ledger.close();
    cleanup();
  });
  return { set, ledger, stores };
}

function request(corpusId: string, id: string, text: string): ExtractionSinkRequest {
  return {
    ref: {
      corpusId,
      provider: PROVIDER,
      accountScope: ACCOUNT,
      approvedScopeKey: `${PROVIDER}.${ACCOUNT}:/`,
      providerItemId: id,
      localItemId: localId(id),
      sourceVersion: 'v1',
      mimeType: MIME[id]!,
    },
    text,
    extractorKind: 'local_text',
    extractorVersion: 'test',
    fetchedAt: '2026-10-08T00:00:00.000Z',
  };
}

/** Every chunk byte a store file holds for the item, read raw. */
const chunkText = (store: LocalConnectorStore | undefined, id: string): string => store
  ? snapshotStore(store.dbPath, [localId(id)]).chunks.map((chunk) => String(chunk['bounded_text'])).join('\n')
  : '';

describe('a lane where only pictures arrive later', () => {
  test('a new photo is routed by its names; read items and other unread items keep the lane\'s rules', async () => {
    const { set, ledger } = openSet();
    await set.sync(lane(SPECS), { fetchContent: true, placement: FIXTURE_PLACEMENT });

    // The photo: its names copy only, in the Personal store, its text unread.
    const photo = ledger.getCurrent(identityOf('photo-new'));
    expect(photo?.contentRead).toBe(false);
    expect(ledger.copies(identityOf('photo-new')).map((copy) => [copy.corpusId, copy.layers]))
      .toEqual([[CORPORA.internal, 'metadata']]);
    // A document read at listing is routed from its text, as before.
    expect(ledger.isRouted(identityOf('doc-read'))).toBe(true);
    expect(ledger.getCurrent(identityOf('doc-read'))?.contentRead).toBe(true);
    // An unread file that is not a picture keeps the lane's own placement.
    expect(ledger.isRouted(identityOf('scan-unread'))).toBe(false);
    expect(set.store('internal')!.activeLocalItemRow(localId('scan-unread'))).toBeDefined();
  });

  test('the photo\'s text lands in the Private store and never in the Personal one', async () => {
    const { set, ledger, stores } = openSet();
    await set.sync(lane(SPECS), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const sink = createTieredStoreExtractionSink({
      set,
      syncConnectorId: 'extraction',
      ownerConnectorId: 'fixture-connector',
      ownershipKind: 'observed',
    });
    const result = await sink.accept(request(CORPORA.internal, 'photo-new', 'Photo\nKITCHEN RENOVATION PLAN'));
    expect(result.accepted).toBe(true);
    expect(chunkText(stores.secure_local, 'photo-new')).toContain('KITCHEN RENOVATION PLAN');
    expect(chunkText(stores.internal, 'photo-new')).not.toContain('KITCHEN RENOVATION PLAN');
    const copies = ledger.copies(identityOf('photo-new')).filter((copy) => copy.state === 'current');
    expect(copies.map((copy) => [copy.corpusId, copy.layers]).sort()).toEqual([
      [CORPORA.internal, 'metadata'],
      [CORPORA.secure_local, 'content'],
    ]);
    // A second landing of the same text is not a move.
    expect((await sink.accept(request(CORPORA.internal, 'photo-new', 'Photo\nKITCHEN RENOVATION PLAN'))).accepted).toBe(true);
    expect(ledger.getCurrent(identityOf('photo-new'))?.state).not.toBe('moving');
  });

  test('each store\'s corpus lists its own items, and the Private one also the Public store', async () => {
    const { set } = openSet();
    await set.sync(lane(SPECS), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const listed = (home: SourceTrustDomain) => tieredExtractionView(set, { home })
      .extractionCandidates({ limit: 50 }).candidates.map((candidate) => candidate.identity.providerItemId).sort();
    const personal = listed('internal');
    const privateStores = listed('secure_local');
    expect(personal).toContain('photo-new');
    expect(personal).toContain('scan-unread');
    // A public-names photo's names copy sits in the Public store: the Private corpus lists it.
    expect(set.store('public_safe')?.activeLocalItemRow(localId('photo-public'))).toBeDefined();
    expect(privateStores).toContain('photo-public');
    expect(personal.filter((id) => privateStores.includes(id))).toEqual([]);
    expect(() => tieredExtractionView(set, { home: 'public_safe' }).extractionCandidates({ limit: 1 })).toThrow();
  });

  test('a picture is refused before reading only where it could land outside Private', async () => {
    const { set } = openSet();
    await set.sync(lane(SPECS), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const view = tieredExtractionView(set, { home: 'internal' });
    // Routed: its content goes where its content tier decides (Private).
    expect(view.refusesImageContent(localId('photo-new'))).toBe(false);
    // Never routed, held by the Personal store: its content would land there.
    const legacyPhoto: FixtureSpec = { id: 'photo-legacy', name: 'IMG_0001.jpg' };
    MIME['photo-legacy'] = 'image/jpeg';
    await set.store('internal')!.syncFromConnector(lane([legacyPhoto]), { fetchContent: false, placement: FIXTURE_PLACEMENT });
    expect(view.refusesImageContent(localId('photo-legacy'))).toBe(true);
    // Never routed, held by the Private store: it lands there.
    const securePhoto: FixtureSpec = { id: 'photo-secure', name: 'IMG_0002.jpg', legacyDomain: 'secure_local' };
    MIME['photo-secure'] = 'image/jpeg';
    await set.store('secure_local')!.syncFromConnector(lane([securePhoto]), { fetchContent: false, placement: FIXTURE_PLACEMENT });
    expect(view.refusesImageContent(localId('photo-secure'))).toBe(false);
  });

  test('without an item, a decision whose text has not landed is placed as one arriving later', () => {
    const { set } = openSet(false);
    const base = { metadataTier: 'private', contentTier: 'private', state: 'current', metadataPending: false, contentPending: false } as const;
    expect(set.placementFor({ ...base, contentRead: false }).copies.map((copy) => copy.layers)).toEqual(['metadata']);
    expect(set.placementFor({ ...base, contentRead: true }).copies.map((copy) => copy.layers)).toEqual(['both']);
    // Pending content: held in Private when the text arrived later, the whole item otherwise.
    const pending = { ...base, state: 'pending', contentPending: true, contentRead: true } as const;
    expect(set.placementFor(pending, { contentArrivesLater: true }).copies.map((copy) => copy.trustDomain).sort())
      .toEqual(['internal', 'secure_local']);
    expect(set.placementFor(pending).copies.map((copy) => [copy.trustDomain, copy.layers])).toEqual([['secure_local', 'both']]);
    // A plain item outside the lane's pictures is never read later.
    expect(set.readsContentLater(fixtureItem({ id: 'x', name: 'x.txt' }))).toBe(false);
    expect(set.readsContentLater()).toBe(true);
  });
});
