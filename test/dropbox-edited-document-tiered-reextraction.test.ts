// An edited file is read again on per-tier stores too.
//
// A routed item keeps its names and its text in the stores its tiers decide:
// one Personal copy serving both, or Personal names beside Private text. The
// text row is never listed on its own, so for the split item the row that must
// come back as a candidate after an edit is the NAMES row, whose own store
// holds no chunks. The text is then rewritten in place wherever it rests, and
// goes through the same content rules as any new text (the Secrets floor
// included).

import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
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
import { EXTRACTION_SINK_SKIPPED_SECRETS } from '../src/workers/file-extraction/store-sink.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import type { ExtractionSink, ExtractionSinkRequest } from '../src/workers/file-extraction/types.ts';
import {
  ACCOUNT,
  CORPORA,
  PROVIDER,
  fixtureConnector,
  identityOf,
  localId,
  storePaths,
  tempDir,
  type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const SECURE_PLACEMENT = { trustTier: 'S4' as const, trustDomain: 'secure_local' as const };

// Built at runtime: the repository refuses literal credential patterns.
const FAKE_AWS_KEY = ['AKIA', 'LMNOPQRSTUVWXYZ2'].join('');

interface Doc {
  id: string;
  name: string;
  body: string;
}

// Reference material lands in one Personal copy; the lab report's text is
// Private, so its names stay Personal and its text rests in the Private store.
const REFERENCE: Doc = {
  id: 'ref-integral',
  name: 'integral-theory-chapter.pdf',
  body: 'Integral theory maps quadrants, levels and lines of development.',
};
const REPORT: Doc = {
  id: 'lab-report',
  name: 'scan-0413.pdf',
  body: 'The lab results confirm the diagnosis; the patient starts treatment next week.',
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Lane {
  set: TieredStoreSet;
  ledger: TierLedger;
  stores: Partial<Record<SourceTrustDomain, LocalConnectorStore>>;
  sink: ExtractionSink;
}

function openLane(): Lane {
  const { dir, cleanup } = tempDir('olympus-dropbox-tiered-reextract-');
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
  cleanups.push(() => {
    for (const store of Object.values(stores)) store?.close();
    secrets.close();
    ledger.close();
    cleanup();
  });
  return { set, ledger, stores, sink };
}

/** The listing carries names and the file's revision, never text. */
async function list(lane: Lane, docs: readonly Doc[], version: string): Promise<void> {
  const specs: FixtureSpec[] = docs.map(({ id, name }) => ({ id, name, version }));
  await lane.set.sync(fixtureConnector(() => specs), { fetchContent: false, placement: SECURE_PLACEMENT });
}

function request(doc: Doc, text: string, version: string): ExtractionSinkRequest {
  return {
    ref: {
      corpusId: CORPORA.secure_local,
      provider: PROVIDER,
      accountScope: ACCOUNT,
      approvedScopeKey: `${PROVIDER}.${ACCOUNT}:/`,
      providerItemId: doc.id,
      localItemId: localId(doc.id),
      sourceVersion: version,
    },
    text,
    extractorKind: 'local_text',
    extractorVersion: 'test',
    fetchedAt: '2026-10-13T00:00:00.000Z',
  };
}

function candidateIds(lane: Lane, includeStaleChunks: boolean): string[] {
  const view = tieredExtractionView(lane.set);
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = view.extractionCandidates({
      limit: 10,
      withoutChunksOnly: true,
      ...(includeStaleChunks ? { includeStaleChunks } : {}),
      ...(cursor ? { cursor } : {}),
    });
    found.push(...page.candidates.map((candidate) => candidate.identity.providerItemId));
    cursor = page.done ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return found.sort();
}

function searchIds(store: LocalConnectorStore | undefined, term: string): string[] {
  return (store?.searchItems(term, 20) ?? []).map((row) => row.sourceItem.providerItemId).sort();
}

async function landFirstReading(lane: Lane): Promise<void> {
  await list(lane, [REFERENCE, REPORT], 'rev-1');
  expect((await lane.sink.accept(request(REFERENCE, REFERENCE.body, 'rev-1'))).accepted).toBe(true);
  expect((await lane.sink.accept(request(REPORT, REPORT.body, 'rev-1'))).accepted).toBe(true);
  // The shape under test: one Personal copy for the reference file, Personal
  // names beside Private text for the report.
  expect(lane.ledger.copies(identityOf(REFERENCE.id)).map((copy) => [copy.corpusId, copy.layers]))
    .toEqual([[CORPORA.internal, 'both']]);
  expect(lane.ledger.copies(identityOf(REPORT.id)).map((copy) => [copy.corpusId, copy.layers]))
    .toEqual([[CORPORA.internal, 'metadata'], [CORPORA.secure_local, 'content']]);
}

describe('an edited file on per-tier stores', () => {
  test('is listed again through the row that is listable, whichever store holds its text; an unchanged file is not', async () => {
    const lane = openLane();
    await landFirstReading(lane);
    expect(candidateIds(lane, true)).toEqual([]);

    // Listed again at the same revision: not an edit.
    await list(lane, [REFERENCE, REPORT], 'rev-1');
    expect(candidateIds(lane, true)).toEqual([]);

    // Both are edited. Nothing reads the new text yet.
    await list(lane, [REFERENCE, REPORT], 'rev-2');
    expect(candidateIds(lane, false)).toEqual([]);
    expect(candidateIds(lane, true)).toEqual([REPORT.id, REFERENCE.id].sort());
    expect(lane.stores.internal!.itemTextIsStale(localId(REFERENCE.id))).toBe(true);
    expect(lane.stores.secure_local!.itemTextIsStale(localId(REPORT.id))).toBe(true);
    // The old text is still what answers until it is replaced.
    expect(searchIds(lane.stores.secure_local, 'diagnosis')).toEqual([REPORT.id]);
  });

  test('its new text replaces the old in place and settles it', async () => {
    const lane = openLane();
    await landFirstReading(lane);
    await list(lane, [REFERENCE, REPORT], 'rev-2');

    const revisedReference = 'Integral theory revised: quadrants, levels, lines and states of development.';
    const revisedReport = 'The lab results were revised; the diagnosis stands and the patient continues treatment.';
    expect((await lane.sink.accept(request(REFERENCE, revisedReference, 'rev-2'))).accepted).toBe(true);
    expect((await lane.sink.accept(request(REPORT, revisedReport, 'rev-2'))).accepted).toBe(true);

    expect(searchIds(lane.stores.internal, 'states')).toEqual([REFERENCE.id]);
    expect(searchIds(lane.stores.internal, 'maps')).toEqual([]);
    expect(searchIds(lane.stores.secure_local, 'revised')).toEqual([REPORT.id]);
    expect(searchIds(lane.stores.secure_local, 'starts')).toEqual([]);
    // The tiers did not move: the text rests where it did.
    expect(lane.ledger.copies(identityOf(REPORT.id)).map((copy) => [copy.corpusId, copy.layers]))
      .toEqual([[CORPORA.internal, 'metadata'], [CORPORA.secure_local, 'content']]);
    expect(candidateIds(lane, true)).toEqual([]);
  });

  test('edited text that is a Secret is stored nowhere, as it would be for a new file', async () => {
    const lane = openLane();
    await landFirstReading(lane);
    await list(lane, [REFERENCE], 'rev-2');
    expect(candidateIds(lane, true)).toEqual([REFERENCE.id]);

    const result = await lane.sink.accept(request(REFERENCE, `deploy with aws key ${FAKE_AWS_KEY} tonight`, 'rev-2'));
    expect(result.accepted).toBe(false);
    expect(result.skippedReason).toBe(EXTRACTION_SINK_SKIPPED_SECRETS);
    expect(lane.ledger.copies(identityOf(REFERENCE.id))).toEqual([]);
    expect(searchIds(lane.stores.internal, 'quadrants')).toEqual([]);
    expect(searchIds(lane.stores.internal, 'deploy')).toEqual([]);
    expect(searchIds(lane.stores.secure_local, 'deploy')).toEqual([]);
  });
});
