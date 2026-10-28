// A file settled fail-safe Private before its text was read, then judged
// Personal from that text, lands in its Personal store (#592).
//
// The recovery of lost privacy questions can settle an unread file's content
// at Private: a hold, not a verdict on text nobody has read. When extraction
// then reads the text and it is judged Personal, the text belongs beside the
// names already in the Personal store. That store widens its names copy only
// at the content tier the ledger records, and the ledger still said Private,
// so it refused: the job settled names-only and the file never had its text.

import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import type { SourceTrustDomain } from '../src/core/source-index/types.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import type { TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createTieredLaneSet, onDemandTierStore, tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { createFileExtractionRuntime } from '../src/workers/email-source/file-extraction-runtime.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { SECRET_RESTORED_REREADS_TABLE } from '../src/workers/file-extraction/job-names.ts';
import { EXTRACTION_SINK_SKIPPED_METADATA_ONLY } from '../src/workers/file-extraction/store-sink.ts';
import type { SourceConnector } from '../src/core/contracts.ts';
import { settleNamesOnlyItems } from '../src/workers/connector-store/tier-names-only-settle.ts';
import { ACCOUNT, CORPORA, PROVIDER, fixtureConnector, fixtureItem, identityOf, localId, storePaths, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const TEXT = 'Budget 2026: rent 1200, groceries 400, school fees 300.';
const FAIL_SAFE = /^content:sniffer:.*:fail_safe:missing_question$/;
const LANE = { corpusId: CORPORA.secure_local!, provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: `${PROVIDER}:/Files` };
const REF = { ...LANE, providerItemId: 'budget', localItemId: localId('budget'), sourceVersion: 'r1', mimeType: 'text/plain', name: 'Budget 2026.txt' };

// The judge reads the text and finds it ordinary.
const PERSONAL: TierSniffer = { id: 'fixture-sniffer', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary' }) };

async function failSafeUnreadLane(options: { folder?: boolean } = {}) {
  const { dir, cleanup } = tempDir('olympus-fail-safe-landing-');
  const paths = storePaths(dir);
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
  const secrets = new SecretLocationsIndex({ dbPath: join(dir, 'secret-locations.sqlite') });
  const stores: Partial<Record<SourceTrustDomain, LocalConnectorStore>> = {
    secure_local: new LocalConnectorStore({ dbPath: paths.secure_local, corpusId: CORPORA.secure_local, family: 'file', trustDomain: 'secure_local' }),
  };
  const onDemand = (domain: SourceTrustDomain) => onDemandTierStore({
    corpusId: CORPORA[domain]!,
    dbPath: paths[domain]!,
    create: () => (stores[domain] = new LocalConnectorStore({
      dbPath: paths[domain]!, corpusId: CORPORA[domain]!, family: 'file', trustDomain: domain, tierLedger: ledger,
    })),
  });
  const set = createTieredLaneSet({
    setId: 'fixture.files.personal',
    ledger,
    secretLocations: secrets,
    contentArrivesLater: true,
    tierClassification: { sniffer: PERSONAL },
    legs: {
      public_safe: { onDemand: onDemand('public_safe') },
      internal: { onDemand: onDemand('internal') },
      secure_local: { store: stores.secure_local!, legacy: true },
    },
  });
  // Listed by name: names Personal, content unread and pending.
  await set.sync(fixtureConnector(() => [{ id: 'budget', name: 'Budget 2026.txt', version: 'r1' }]), {
    fetchContent: false,
    placement: { trustTier: 'S4', trustDomain: 'secure_local' },
  });
  if (options.folder) await set.sync(folderConnector(), { fetchContent: false, placement: { trustTier: 'S4', trustDomain: 'secure_local' } });
  // The recovery found no content question (there can be none yet) and
  // settled the content fail-safe Private, as test-mac recorded.
  const listed = ledger.getCurrent(identityOf('budget'))!;
  expect(ledger.settleMissingQuestions(listed, {
    missingMetadata: false,
    missingContent: true,
    snifferId: 'local:fixture',
    stillMissing: () => true,
    placementFor: (decision) => set.placementFor(decision),
  })).toBe(true);
  expect(ledger.getCurrent(identityOf('budget'))).toMatchObject({ state: 'current', metadataTier: 'private', contentTier: 'secure', contentRead: false });

  const jobsDbPath = join(dir, 'jobs.sqlite');
  const runtime = createFileExtractionRuntime({
    enabled: true,
    connectorStores: [stores.secure_local!],
    corpora: [{ corpusId: LANE.corpusId, provider: PROVIDER, scopes: [LANE.approvedScopeKey] }],
    tierSets: new Map([[LANE.corpusId, set]]),
    jobsDbPath,
    scopeGuard: { assertAuthorized() {}, allowsRef: () => true },
    sourceFactories: new Map([[PROVIDER, () => ({
      id: 'fixture',
      corpusId: LANE.corpusId,
      provider: PROVIDER,
      listCandidates: async () => ({ candidates: [], done: true }),
      fetch: async () => ({ bytes: new TextEncoder().encode(TEXT), mimeType: 'text/plain' }),
    })]]),
  })!;
  cleanups.push(() => {
    runtime.close();
    for (const store of Object.values(stores)) store?.close();
    secrets.close();
    ledger.close();
    cleanup();
  });
  return { set, ledger, stores, runtime, jobsDbPath };
}

/** A folder, listed as Dropbox lists one: a container with no text of its own. */
function folderConnector(): SourceConnector {
  const base = fixtureConnector(() => []);
  const folder = { ...fixtureItem({ id: 'money', name: 'Money', version: 'r1' }), mimeType: 'inode/directory' };
  return {
    ...base,
    async fetchItem() { return folder; },
    listItems() {
      return (async function* () {
        yield { items: [folder], done: true };
      })();
    },
  };
}

test('its text, judged Personal, lands in the Personal store beside its names', async () => {
  const lane = await failSafeUnreadLane();
  const jobId = lane.runtime.jobs.enqueue({ refs: [REF], extractorKind: 'local_text', extractorVersion: 'v1', policyDecision: 'index_allowed' }).jobRefs[0]!.jobId;
  await lane.runtime.runner.run(LANE);

  expect(lane.runtime.jobs.get(jobId)).toMatchObject({ status: 'indexed' });
  const landed = lane.ledger.getCurrent(identityOf('budget'))!;
  expect(landed).toMatchObject({ state: 'current', metadataTier: 'private', contentTier: 'private', contentRead: true });
  expect(landed.reasons.some((reason) => FAIL_SAFE.test(reason))).toBe(false);
  expect(lane.ledger.copies(identityOf('budget')).map((copy) => [copy.corpusId, copy.layers, copy.state]))
    .toEqual([[CORPORA.internal, 'both', 'current']]);
  expect(lane.stores.internal!.searchItems('groceries', 5).map((row) => row.sourceItem.providerItemId)).toEqual(['budget']);
  // Nothing was written to the Private store.
  expect(lane.stores.secure_local!.activeLocalItemRow(localId('budget'))).toBeUndefined();
});

test('a job an earlier build settled names-only this way is read again once, after the upgrade', async () => {
  const lane = await failSafeUnreadLane();
  const jobs = lane.runtime.jobs;
  const jobId = jobs.enqueue({ refs: [REF], extractorKind: 'local_text', extractorVersion: 'v1', policyDecision: 'index_allowed' }).jobRefs[0]!.jobId;
  const leased = jobs.lease({ ...LANE, workerId: 'old-build' }).leasedJobs[0]!;
  jobs.record({ jobId, workerId: 'old-build', leaseToken: leased.leaseToken, status: 'metadata_only', errorKind: EXTRACTION_SINK_SKIPPED_METADATA_ONLY });
  // As the earlier build left the ledger: schema 6, no re-read owed.
  const raw = new Database(lane.jobsDbPath);
  raw.exec(`DELETE FROM ${SECRET_RESTORED_REREADS_TABLE}; UPDATE schema_version SET version = 6 WHERE store_id = 'file-extraction-jobs';`);
  raw.close();

  // The upgraded worker opens the ledger: the migration owes the re-read.
  const upgraded = new LocalFileExtractionJobStore(lane.jobsDbPath);
  cleanups.unshift(() => upgraded.close());
  // Listed again, still without text: the job is queued again, once.
  expect(upgraded.enqueue({ refs: [REF], extractorKind: 'local_text', extractorVersion: 'v1' })).toMatchObject({ jobsForced: 1 });
  expect(upgraded.enqueue({ refs: [REF], extractorKind: 'local_text', extractorVersion: 'v1' })).toMatchObject({ jobsForced: 0, jobsExisting: 1 });

  await lane.runtime.runner.run(LANE);
  expect(jobs.get(jobId)).toMatchObject({ status: 'indexed' });
  expect(lane.stores.internal!.searchItems('groceries', 5).map((row) => row.sourceItem.providerItemId)).toEqual(['budget']);
});

test('a folder is decided on its names when listed: no text will ever come, so nothing waits for it', async () => {
  const lane = await failSafeUnreadLane({ folder: true });
  const folder = lane.ledger.getCurrent(identityOf('money'))!;
  expect(folder).toMatchObject({ state: 'current', metadataTier: 'private', contentTier: 'private', contentPending: false, contentRead: false });
  expect(folder.reasons).toContain('content:names_only');
  expect(folder.reasons).not.toContain('content:unread');
});

test('a folder an earlier build settled fail-safe Private is settled on its names', async () => {
  const lane = await failSafeUnreadLane({ folder: true });
  // As an earlier build listed it: unread content, then the fail-safe.
  const db = new Database(lane.ledger.dbPath);
  db.query(`UPDATE tier_items SET state = 'current', content_tier = 'secure', content_pending = 0, decided_by = 'sniffer', reasons_json = ?
    WHERE provider_item_id = 'money'`).run(JSON.stringify(['metadata:default:personal', 'content:unread', 'content:sniffer:old:fail_safe:missing_question']));
  db.close();

  expect(settleNamesOnlyItems({ set: lane.set })).toMatchObject({ settled: 1 });
  const folder = lane.ledger.getCurrent(identityOf('money'))!;
  expect(folder).toMatchObject({ state: 'current', contentTier: 'private', contentPending: false });
  expect(folder.reasons.some((reason) => FAIL_SAFE.test(reason))).toBe(false);
  // The file beside it is still waiting for its text, not settled names-only.
  expect(lane.ledger.getCurrent(identityOf('budget'))).toMatchObject({ contentTier: 'secure', contentRead: false });
});
