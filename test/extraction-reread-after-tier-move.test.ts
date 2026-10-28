// A tier move re-opens the extraction jobs its old placement settled.
//
// A job is keyed by its lane's corpus, the item, the revision and the
// extractor, none of which a tier move changes. A job that settled because of
// where the item sat (its store kept names only, or its names had to move
// first) therefore stayed settled after the move: the moved item, still
// without text, was listed again, and enqueue found the settled job and left
// it alone. Its text was never read.

import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceTrustDomain } from '../src/core/source-index/types.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import {
  createTieredLaneSet,
  onDemandTierStore,
  tieredStoreSetLedgerPath,
  type TieredStoreSet,
} from '../src/workers/connector-store/tiered-store-set.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import {
  EXTRACTION_SINK_SKIPPED_EMPTY_TEXT,
  EXTRACTION_SINK_SKIPPED_IMAGE_PRIVATE_ONLY,
  EXTRACTION_SINK_SKIPPED_METADATA_ONLY,
  EXTRACTION_SINK_SKIPPED_TIER_MOVE_QUEUED,
} from '../src/workers/file-extraction/store-sink.ts';
import type { ExtractionItemRef, ExtractionTerminalStatus } from '../src/workers/file-extraction/types.ts';
import {
  ACCOUNT,
  CORPORA,
  PROVIDER,
  fixtureConnector,
  identityOf,
  localId,
  storePaths,
  tempDir,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const SCOPE = `${PROVIDER}.${ACCOUNT}:/`;
const LANE = { corpusId: CORPORA.secure_local!, provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: SCOPE };

interface Lane {
  set: TieredStoreSet;
  ledger: TierLedger;
  jobs: LocalFileExtractionJobStore;
}

function openLane(): Lane {
  const { dir, cleanup } = tempDir('olympus-reread-after-move-');
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
    create: () => (stores[domain] = new LocalConnectorStore({
      dbPath: paths[domain]!,
      corpusId: CORPORA[domain]!,
      family: 'file',
      trustDomain: domain,
      tierLedger: ledger,
    })),
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
  // Registered by its constructor, as the worker's job ledger is: the move
  // finds it without being told.
  const jobs = new LocalFileExtractionJobStore(join(dir, 'file-extraction-jobs.sqlite'));
  cleanups.push(() => {
    jobs.close();
    for (const store of Object.values(stores)) store?.close();
    secrets.close();
    ledger.close();
    cleanup();
  });
  return { set, ledger, jobs };
}

function ref(id: string): ExtractionItemRef {
  return { ...LANE, providerItemId: id, localItemId: localId(id), sourceVersion: 'r1', mimeType: 'application/pdf' };
}

function enqueue(lane: Lane, id: string) {
  return lane.jobs.enqueue({ refs: [ref(id)], extractorKind: 'local_text', extractorVersion: 'v1' });
}

/** Queue, lease and settle one job the way the runner settles a sink skip. */
function settle(lane: Lane, id: string, status: ExtractionTerminalStatus, errorKind: string): void {
  enqueue(lane, id);
  const leased = lane.jobs.lease({ ...LANE, workerId: 'worker' }).leasedJobs.find((job) => job.ref.providerItemId === id)!;
  lane.jobs.record({ jobId: leased.jobId, workerId: 'worker', leaseToken: leased.leaseToken, status, errorKind });
}

/** A new file listed by name, its text not read yet: names Personal, routed. */
async function list(lane: Lane, ids: readonly string[]): Promise<void> {
  await lane.set.sync(
    fixtureConnector(() => ids.map((id) => ({ id, name: `${id}.pdf`, version: 'r1' }))),
    { fetchContent: false, placement: { trustTier: 'S4', trustDomain: 'secure_local' } },
  );
}

/** The owner raises the item's names and content to Private: one move. */
async function raiseToPrivate(lane: Lane, id: string): Promise<void> {
  await moveTieredItem({
    set: lane.set,
    identity: { ...identityOf(id), family: 'file', localItemId: localId(id) },
    target: { metadataTier: 'secure', contentTier: 'secure' },
  });
  expect(lane.ledger.copies(identityOf(id)).filter((copy) => copy.state === 'current').map((copy) => copy.corpusId))
    .toEqual([CORPORA.secure_local]);
}

describe('a completed tier move', () => {
  test('re-queues a job settled on the old placement, once', async () => {
    const lane = openLane();
    await list(lane, ['budget']);
    settle(lane, 'budget', 'metadata_only', EXTRACTION_SINK_SKIPPED_METADATA_ONLY);
    // Listed again before any move: the settlement stands.
    expect(enqueue(lane, 'budget')).toMatchObject({ jobsQueued: 0, jobsExisting: 1, jobsForced: 0 });

    await raiseToPrivate(lane, 'budget');
    // The next listing reads the moved item again.
    const after = enqueue(lane, 'budget');
    expect(after).toMatchObject({ jobsForced: 1 });
    expect(after.jobRefs[0]!.status).toBe('queued');

    // Settled again on the new placement: no move since, so it stays settled.
    const leased = lane.jobs.lease({ ...LANE, workerId: 'worker' }).leasedJobs[0]!;
    lane.jobs.record({ jobId: leased.jobId, workerId: 'worker', leaseToken: leased.leaseToken, status: 'metadata_only', errorKind: EXTRACTION_SINK_SKIPPED_METADATA_ONLY });
    expect(enqueue(lane, 'budget')).toMatchObject({ jobsExisting: 1, jobsForced: 0 });
  });

  test('re-queues each settlement that depended on the placement, and nothing else', async () => {
    const lane = openLane();
    const placementBound = {
      'names-only-store': ['metadata_only', EXTRACTION_SINK_SKIPPED_METADATA_ONLY],
      'picture-private-only': ['metadata_only', EXTRACTION_SINK_SKIPPED_IMAGE_PRIVATE_ONLY],
      'names-had-to-move': ['blocked_policy', EXTRACTION_SINK_SKIPPED_TIER_MOVE_QUEUED],
    } as const;
    const ids = [...Object.keys(placementBound), 'empty-file'];
    await list(lane, ids);
    for (const [id, [status, kind]] of Object.entries(placementBound)) settle(lane, id, status, kind);
    // An empty file is empty wherever it rests.
    settle(lane, 'empty-file', 'metadata_only', EXTRACTION_SINK_SKIPPED_EMPTY_TEXT);

    for (const id of ids) await raiseToPrivate(lane, id);
    for (const id of Object.keys(placementBound)) expect(enqueue(lane, id)).toMatchObject({ jobsForced: 1 });
    expect(enqueue(lane, 'empty-file')).toMatchObject({ jobsExisting: 1, jobsForced: 0 });
  });

  test('leaves another item\'s settled job alone', async () => {
    const lane = openLane();
    await list(lane, ['moved', 'stays']);
    settle(lane, 'moved', 'metadata_only', EXTRACTION_SINK_SKIPPED_METADATA_ONLY);
    settle(lane, 'stays', 'metadata_only', EXTRACTION_SINK_SKIPPED_METADATA_ONLY);
    await raiseToPrivate(lane, 'moved');
    expect(enqueue(lane, 'stays')).toMatchObject({ jobsExisting: 1, jobsForced: 0 });
    expect(enqueue(lane, 'moved')).toMatchObject({ jobsForced: 1 });
  });
});
