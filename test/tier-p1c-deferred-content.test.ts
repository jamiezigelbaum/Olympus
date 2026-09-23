// P1c: a lane whose text arrives after listing (the shared extraction factory
// reads it later), on per-tier stores (design
// per-item-four-tier-classification.md, sections 2, 3.2 and 3.3).
//
// A NEW item's names are routed by its metadata tier (Personal by default) at
// listing; its content lands in the content tier's store, decided from the
// text the extraction factory actually read. Existing items never move.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import type { SourceTrustDomain } from '../src/core/source-index/types.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { tieredExtractionView } from '../src/workers/connector-store/tiered-extraction.ts';
import {
  createTieredLaneSet,
  onDemandTierStore,
  tieredStoreSetLedgerPath,
  type TieredStoreSet,
} from '../src/workers/connector-store/tiered-store-set.ts';
import { createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import type { ExtractionSink, ExtractionSinkRequest } from '../src/workers/file-extraction/types.ts';
import {
  ACCOUNT,
  PROVIDER,
  CORPORA,
  cloudProvider,
  fixtureConnector,
  identityOf,
  localId,
  localProvider,
  snapshotStore,
  storePaths,
  tempDir,
  type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const SECURE_PLACEMENT = { trustTier: 'S4' as const, trustDomain: 'secure_local' as const };

// Built at runtime: the repository refuses literal credential patterns.
const FAKE_AWS_KEY = ['AKIA', 'LMNOPQRSTUVWXYZ2'].join('');

const LEGACY: Array<FixtureSpec & { body: string }> = [
  { id: 'legacy-notes', name: 'legacy-notes.pdf', body: 'Seminar notes on developmental stages kept since last year.' },
  { id: 'legacy-plain', name: 'legacy-plain.pdf', body: 'A garden diary entry about the tomato beds.' },
];
const NEW: Array<FixtureSpec & { body: string }> = [
  { id: 'new-integral', name: 'integral-theory-chapter.pdf', body: 'Integral theory maps quadrants, levels and lines of development.' },
  { id: 'new-scan', name: 'scan-0413.pdf', body: 'The lab results confirm the diagnosis; the patient starts treatment next week.' },
  { id: 'new-secret', name: 'deploy-notes.pdf', body: `deploy with aws key ${FAKE_AWS_KEY} tonight` },
];

// The listing carries names only: the text arrives later, through extraction.
const listing = (specs: ReadonlyArray<FixtureSpec>): FixtureSpec[] =>
  specs.map(({ id, name, deleted }) => ({ id, name, ...(deleted ? { deleted } : {}) }));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function workspace(): string {
  const { dir, cleanup } = tempDir('olympus-tier-p1c-');
  cleanups.push(cleanup);
  return dir;
}

function request(id: string, text: string): ExtractionSinkRequest {
  return {
    ref: {
      corpusId: CORPORA.secure_local,
      provider: PROVIDER,
      accountScope: ACCOUNT,
      approvedScopeKey: `${PROVIDER}.${ACCOUNT}:/`,
      providerItemId: id,
      localItemId: localId(id),
      sourceVersion: 'v1',
    },
    text,
    extractorKind: 'local_text',
    extractorVersion: 'test',
    fetchedAt: '2026-09-23T00:00:00.000Z',
  };
}

/** The lane before per-tier routing: one secure store, listed then extracted, then embedded. */
async function populateLegacy(dir: string): Promise<void> {
  const secure = new LocalConnectorStore({
    dbPath: storePaths(dir).secure_local,
    corpusId: CORPORA.secure_local,
    family: 'file',
    trustDomain: 'secure_local',
  });
  try {
    await secure.syncFromConnector(fixtureConnector(() => listing(LEGACY)), { fetchContent: false, placement: SECURE_PLACEMENT });
    const sink = createConnectorStoreExtractionSink({
      store: secure,
      classify: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
      syncConnectorId: 'extraction',
      ownerConnectorId: 'fixture-connector',
      ownershipKind: 'observed',
    });
    for (const spec of LEGACY) expect((await sink.accept(request(spec.id, spec.body))).accepted).toBe(true);
    await secure.embedChunks({ provider: localProvider() });
    // Steady state: the lane re-lists its items on every pass.
    await secure.syncFromConnector(fixtureConnector(() => listing(LEGACY)), { fetchContent: false, placement: SECURE_PLACEMENT });
  } finally {
    secure.close();
  }
}

interface Lane {
  set: TieredStoreSet;
  ledger: TierLedger;
  secrets: SecretLocationsIndex;
  stores: Partial<Record<SourceTrustDomain, LocalConnectorStore>>;
  sink: ExtractionSink;
  close(): void;
}

function openLane(dir: string): Lane {
  const paths = storePaths(dir);
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
  const secrets = new SecretLocationsIndex({ dbPath: join(dir, 'secret-locations.sqlite') });
  const stores: Partial<Record<SourceTrustDomain, LocalConnectorStore>> = {
    secure_local: new LocalConnectorStore({
      dbPath: paths.secure_local,
      corpusId: CORPORA.secure_local,
      family: 'file',
      trustDomain: 'secure_local',
      tierLedger: ledger,
    }),
  };
  const onDemand = (domain: SourceTrustDomain) => onDemandTierStore({
    corpusId: CORPORA[domain]!,
    dbPath: paths[domain]!,
    create: () => {
      const store = new LocalConnectorStore({
        dbPath: paths[domain]!,
        corpusId: CORPORA[domain]!,
        family: 'file',
        trustDomain: domain,
        tierLedger: ledger,
      });
      stores[domain] = store;
      return store;
    },
  });
  const set = createTieredLaneSet({
    setId: 'fixture.files.personal',
    ledger,
    secretLocations: secrets,
    contentArrivesLater: true,
    legs: {
      public_safe: { onDemand: onDemand('public_safe') },
      internal: { onDemand: onDemand('internal') },
      secure_local: { store: stores.secure_local!, legacy: true },
    },
  });
  const sink = createTieredStoreExtractionSink({
    set,
    syncConnectorId: 'extraction',
    ownerConnectorId: 'fixture-connector',
    ownershipKind: 'observed',
  });
  return {
    set,
    ledger,
    secrets,
    stores,
    sink,
    close() {
      for (const store of Object.values(stores)) store?.close();
      secrets.close();
      ledger.close();
    },
  };
}

async function listAll(lane: Lane, specs: ReadonlyArray<FixtureSpec>): Promise<void> {
  await lane.set.sync(fixtureConnector(() => listing(specs)), { fetchContent: false, placement: SECURE_PLACEMENT });
}

function searchIds(store: LocalConnectorStore | undefined, term: string): string[] {
  return (store?.searchItems(term, 20) ?? []).map((row) => row.sourceItem.providerItemId).sort();
}

describe('P1c: content that lands after listing', () => {
  test('existing items stay byte-identical, keep the legacy path, and are never routed', async () => {
    const dir = workspace();
    await populateLegacy(dir);
    const legacyIds = LEGACY.map((spec) => localId(spec.id));
    const before = snapshotStore(storePaths(dir).secure_local, legacyIds);
    expect(before.vectors.length).toBeGreaterThan(0);
    const invalidate = spyOn(
      LocalConnectorStore.prototype as unknown as { invalidateEmbeddingModelCurrency(modelId: string): void },
      'invalidateEmbeddingModelCurrency',
    );
    const cloud = cloudProvider();
    const lane = openLane(dir);
    try {
      await listAll(lane, [...LEGACY, ...NEW]);
      for (const spec of NEW) await lane.sink.accept(request(spec.id, spec.body));
      await listAll(lane, [...LEGACY, ...NEW]);
      await lane.stores.internal?.embedChunks({ provider: cloud });
      for (const spec of LEGACY) {
        expect(lane.ledger.isRouted(identityOf(spec.id))).toBe(false);
        expect(lane.ledger.copies(identityOf(spec.id))).toEqual([]);
      }
      expect(invalidate).not.toHaveBeenCalled();
      for (const input of cloud.inputs) {
        expect(LEGACY.some((spec) => input.includes(spec.body))).toBe(false);
      }
    } finally {
      invalidate.mockRestore();
      lane.close();
    }
    expect(snapshotStore(storePaths(dir).secure_local, legacyIds)).toEqual(before);
  });

  test('reference material lands Personal; private content lands Private with Personal names; Secrets are stored nowhere', async () => {
    const dir = workspace();
    await populateLegacy(dir);
    const lane = openLane(dir);
    cleanups.unshift(() => lane.close());
    await listAll(lane, [...LEGACY, ...NEW]);

    // At listing: names only, in the Personal store; nothing yet in Private.
    expect(existsSync(storePaths(dir).internal)).toBe(true);
    expect(existsSync(storePaths(dir).public_safe)).toBe(false);
    for (const spec of NEW) {
      expect(lane.ledger.copies(identityOf(spec.id))).toEqual([
        expect.objectContaining({ corpusId: CORPORA.internal, layers: 'metadata', state: 'current' }),
      ]);
    }
    expect(searchIds(lane.stores.internal, 'integral')).toEqual(['new-integral']);
    expect(searchIds(lane.stores.secure_local, 'integral')).toEqual([]);

    for (const spec of NEW) await lane.sink.accept(request(spec.id, spec.body));

    // Reference material: one Personal copy serving names and content.
    expect(lane.ledger.copies(identityOf('new-integral'))).toEqual([
      expect.objectContaining({ corpusId: CORPORA.internal, layers: 'both', state: 'current' }),
    ]);
    expect(lane.ledger.getCurrent(identityOf('new-integral'))).toMatchObject({ contentTier: 'private', contentRead: true });
    expect(searchIds(lane.stores.internal, 'quadrants')).toEqual(['new-integral']);

    // Private content: names stay Personal, the text lives only in Private.
    expect(lane.ledger.copies(identityOf('new-scan'))).toEqual([
      expect.objectContaining({ corpusId: CORPORA.internal, layers: 'metadata', state: 'current' }),
      expect.objectContaining({ corpusId: CORPORA.secure_local, layers: 'content', state: 'current' }),
    ]);
    expect(lane.ledger.getCurrent(identityOf('new-scan'))).toMatchObject({ metadataTier: 'private', contentTier: 'secure' });
    expect(searchIds(lane.stores.internal, 'diagnosis')).toEqual([]);
    expect(searchIds(lane.stores.secure_local, 'diagnosis')).toEqual(['new-scan']);
    // Names are searchable in exactly one tier.
    expect(searchIds(lane.stores.internal, 'scan')).toEqual(['new-scan']);

    // Secrets: no copy anywhere, location only.
    expect(lane.ledger.copies(identityOf('new-secret'))).toEqual([]);
    expect(lane.ledger.getCurrent(identityOf('new-secret'))).toMatchObject({ contentTier: 'secrets' });
    expect(searchIds(lane.stores.internal, 'deploy')).toEqual([]);
    expect(searchIds(lane.stores.secure_local, 'deploy')).toEqual([]);
    expect(lane.secrets.search('deploy', {}, { limit: 5 }).length).toBe(1);
  });

  test('candidates: legacy candidates first, exactly as before; routed items until their content lands; egress never below Private', async () => {
    const dir = workspace();
    const paths = storePaths(dir);
    {
      const secure = new LocalConnectorStore({ dbPath: paths.secure_local, corpusId: CORPORA.secure_local, family: 'file', trustDomain: 'secure_local' });
      await secure.syncFromConnector(fixtureConnector(() => listing(LEGACY)), { fetchContent: false, placement: SECURE_PLACEMENT });
      secure.close();
    }
    const lane = openLane(dir);
    cleanups.unshift(() => lane.close());
    await listAll(lane, [...LEGACY, ...NEW]);
    const view = tieredExtractionView(lane.set);

    const plain = lane.stores.secure_local!.extractionCandidates({ limit: 1, withoutChunksOnly: true });
    const first = view.extractionCandidates({ limit: 1, withoutChunksOnly: true });
    // The legacy store's cursor is unchanged: an old checkpoint resumes it.
    expect(first.candidates.map((row) => row.identity.providerItemId)).toEqual(plain.candidates.map((row) => row.identity.providerItemId));
    expect(first.nextCursor).toBe(plain.nextCursor);

    const seen: string[] = [...first.candidates.map((row) => row.identity.providerItemId)];
    let cursor = first.nextCursor;
    for (let guard = 0; cursor !== undefined && guard < 20; guard += 1) {
      const page = view.extractionCandidates({ limit: 1, withoutChunksOnly: true, cursor });
      seen.push(...page.candidates.map((row) => row.identity.providerItemId));
      cursor = page.done ? undefined : page.nextCursor;
    }
    expect(seen.sort()).toEqual([...LEGACY, ...NEW].map((spec) => spec.id).sort());

    expect(view.itemTrustTier(localId('new-integral'))).toBe('S4');
    expect(view.localContent(localId('new-integral'))?.locatorUri).toBe('/Files/integral-theory-chapter.pdf');

    for (const spec of NEW) await lane.sink.accept(request(spec.id, spec.body));
    const after: string[] = [];
    let next: string | undefined;
    do {
      const page = view.extractionCandidates({ limit: 10, withoutChunksOnly: true, ...(next ? { cursor: next } : {}) });
      after.push(...page.candidates.map((row) => row.identity.providerItemId));
      next = page.done ? undefined : page.nextCursor;
    } while (next !== undefined);
    expect(after.sort()).toEqual(LEGACY.map((spec) => spec.id).sort());
  });

  test('re-listing after the text landed never forgets the content tier, never queues a move', async () => {
    const dir = workspace();
    const lane = openLane(dir);
    cleanups.unshift(() => lane.close());
    await listAll(lane, NEW);
    for (const spec of NEW) await lane.sink.accept(request(spec.id, spec.body));
    const before = lane.ledger.copies(identityOf('new-scan'));
    await listAll(lane, NEW);
    await listAll(lane, NEW);
    expect(lane.ledger.getCurrent(identityOf('new-scan'))).toMatchObject({ state: 'current', contentTier: 'secure', contentRead: true });
    expect(lane.ledger.copies(identityOf('new-scan')).map((copy) => [copy.corpusId, copy.layers, copy.state]))
      .toEqual(before.map((copy) => [copy.corpusId, copy.layers, copy.state]));
    expect(searchIds(lane.stores.secure_local, 'diagnosis')).toEqual(['new-scan']);
  });

  test('names that look private keep the whole item Private and held from embedding; no cloud model sees Private text', async () => {
    const dir = workspace();
    const lane = openLane(dir);
    cleanups.unshift(() => lane.close());
    const pending = { id: 'new-bank', name: 'bank statement march.pdf', body: 'Opening balance and the transfers for March.' };
    await listAll(lane, [...NEW, pending]);
    expect(lane.ledger.copies(identityOf('new-bank'))).toEqual([
      expect.objectContaining({ corpusId: CORPORA.secure_local, layers: 'both', state: 'current', embedHold: true }),
    ]);
    // The names are not in the Personal store at all.
    expect(searchIds(lane.stores.internal, 'statement')).toEqual([]);
    for (const spec of [...NEW, pending]) await lane.sink.accept(request(spec.id, spec.body));
    expect(lane.ledger.copies(identityOf('new-bank'))).toEqual([
      expect.objectContaining({ corpusId: CORPORA.secure_local, layers: 'both', state: 'current', embedHold: true }),
    ]);

    const cloud = cloudProvider();
    const local = localProvider();
    await lane.stores.internal!.embedChunks({ provider: cloud });
    await lane.stores.secure_local!.embedChunks({ provider: local });
    expect(cloud.inputs.some((input) => input.includes('quadrants'))).toBe(true);
    expect(cloud.inputs.some((input) => input.includes('diagnosis') || input.includes('balance'))).toBe(false);
    expect(local.inputs.some((input) => input.includes('diagnosis'))).toBe(true);
    // Pending: held back from every embedding until its tier is final.
    expect(local.inputs.some((input) => input.includes('balance'))).toBe(false);
  });

  test('a provider deletion tombstones the names copy and the content copy', async () => {
    const dir = workspace();
    const lane = openLane(dir);
    cleanups.unshift(() => lane.close());
    await listAll(lane, NEW);
    for (const spec of NEW) await lane.sink.accept(request(spec.id, spec.body));
    await listAll(lane, [{ id: 'new-scan', name: 'scan-0413.pdf', deleted: true }]);
    expect(lane.ledger.copies(identityOf('new-scan'))).toEqual([]);
    expect(lane.stores.internal!.itemPresence(identityOf('new-scan')).active).toBe(false);
    expect(lane.stores.secure_local!.itemPresence(identityOf('new-scan')).active).toBe(false);
    expect(searchIds(lane.stores.internal, 'scan')).toEqual([]);
    expect(searchIds(lane.stores.secure_local, 'diagnosis')).toEqual([]);
  });
});
