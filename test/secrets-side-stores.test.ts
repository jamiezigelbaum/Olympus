// An item that becomes Secret keeps its location only in the side stores too
// (docs/TRUST_MODEL.md, the Secret tier; Codex review of PR #343). Two files
// outside the item's store copies hold its names or a short excerpt:
//
// - the sniffer's question queue, beside the set ledger, holds the material a
//   pending item waits to be judged on until the resolver's next pass;
// - the extraction job ledger keeps the name each job captured at enqueue,
//   settled jobs included.
//
// Becoming Secret, by the owner's word (with or without the engine running)
// or by a later reading, deletes the first and clears the second, at once.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  clearInstalledTierClassification,
  configureInstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import type { AnalystModel } from '../src/core/analyst.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { runTierSet } from '../src/workers/classification/tier-cli.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { TIER_LEDGER_SQLITE_STORE_ID, tierSnifferPathForLedger } from '../src/workers/classification/tier-ledger-path.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { applyOwnerOverrides } from '../src/workers/connector-store/tier-override-settle.ts';
import { secretFencedSniffer } from '../src/workers/connector-store/tier-placement.ts';
import { retireSecretRedactions, settleUntrackedSecretsCopy } from '../src/workers/connector-store/secrets-disposition.ts';
import { FILE_EXTRACTION_JOBS_DB_PATH_ENV, LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { registerExtractionJobsDbPath, SECRET_ITEM_REDACTIONS_TABLE } from '../src/workers/file-extraction/job-names.ts';
import type { ExtractionItemRef } from '../src/workers/file-extraction/types.ts';
import type { RawItem } from '../src/core/contracts.ts';
import {
  ACCOUNT,
  CORPORA,
  FIXTURE_PLACEMENT,
  PROVIDER,
  fixtureConnector,
  fixtureLocalId,
  identityOf,
  openTierFixture,
  tempDir,
  type FixtureSpec,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

// Runtime-built so no credential-shaped literal sits in the source.
const FAKE_AWS_KEY = ['AKIA', 'SIDESTORESFIXTR2'].join('');
const LANE = { kind: 'local' as const, modelId: 'fixture-local-sniffer' };

const cleanups: Array<() => void> = [];
afterEach(() => {
  clearInstalledTierClassification();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function workspace(prefix: string): string {
  const { dir, cleanup } = tempDir(prefix);
  cleanups.push(cleanup);
  return dir;
}

function fixture(dir: string): TierFixture {
  const opened = openTierFixture(dir, { embed: false });
  cleanups.push(() => opened.close());
  return opened;
}

/** The owner's sniffer installed (it queues questions for pending items), as the worker installs it. */
function installSniffer(dir: string) {
  return configureInstalledTierClassification({ env: { OLYMPUS_TIER_RULES_PATH: join(dir, 'none.json') }, lane: LANE });
}

/** Point the default job ledger path at `path` for this test. */
function pointJobsEnvAt(path: string): void {
  const previous = process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV];
  process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV] = path;
  cleanups.push(() => {
    if (previous === undefined) delete process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV];
    else process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV] = previous;
  });
}

/** One job's name, read without opening the store (which would upgrade an older ledger). */
function rawJobName(path: string, jobId: string): string | null {
  const raw = new Database(path, { readonly: true });
  try {
    return (raw.query('SELECT name FROM extraction_jobs WHERE job_id = ?').get(jobId) as { name: string | null }).name;
  } finally {
    raw.close();
  }
}

function storePaths(fx: TierFixture): string[] {
  return [fx.paths.internal, fx.paths.secure_local];
}

describe('the sniffer question queue keeps nothing of an item that becomes Secret', () => {
  test('marked Secret while the engine is not running: its queued questions are gone at once, without a resolver pass', async () => {
    const dir = workspace('olympus-secret-side-sniffer-');
    const installed = installSniffer(dir);
    const fx = fixture(dir);
    const specs: FixtureSpec[] = [
      { id: 'mortgage-letter', name: 'mortgage letter', text: 'Lunch with the neighbours on Friday.' },
      { id: 'therapy-notes', name: 'therapy notes', text: 'Notes from the Tuesday meeting.' },
    ];
    await fx.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(fx.ledger.getCurrent(identityOf('mortgage-letter'))?.state).toBe('pending');
    const sniffer = installed.snifferStoreForLedger(fx.ledger.dbPath);
    expect(sniffer.dbPath).toBe(tierSnifferPathForLedger(fx.ledger.dbPath));
    const queued = (id: string) => (['metadata', 'content'] as const)
      .filter((pass) => sniffer.questionFor(identityOf(id), pass) !== undefined);
    expect(queued('mortgage-letter').length).toBeGreaterThan(0);
    expect(JSON.stringify(sniffer.listQuestions())).toContain('mortgage letter');
    const othersBefore = queued('therapy-notes');
    expect(othersBefore.length).toBeGreaterThan(0);

    // The owner's command, from another process: no worker tick, no resolver.
    expect(runTierSet(['mortgage-letter', 'secrets'], { storePaths: storePaths(fx) }))
      .toMatchObject({ results: [{ override: 'Secrets', outcome: 'hidden_now' }] });

    expect(queued('mortgage-letter')).toEqual([]);
    expect(JSON.stringify(sniffer.listQuestions())).not.toContain('mortgage letter');
    // Another item's questions wait as before.
    expect(queued('therapy-notes')).toEqual(othersBefore);
  });

  test('a later reading finds the secret: the listing that settles it deletes the question', async () => {
    const dir = workspace('olympus-secret-side-sniffer-');
    const installed = installSniffer(dir);
    const fx = fixture(dir);
    let specs: FixtureSpec[] = [{ id: 'ops-note', name: 'ops note', text: 'Lunch with the neighbours on Friday.' }];
    await fx.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const sniffer = installed.snifferStoreForLedger(fx.ledger.dbPath);
    expect(sniffer.counts().items).toBe(1);

    specs = [{ id: 'ops-note', name: 'ops note', version: 'v2', text: `The deploy key is ${FAKE_AWS_KEY} until Friday.` }];
    await fx.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(fx.ledger.getCurrent(identityOf('ops-note'))?.contentTier).toBe('secrets');
    expect(sniffer.counts()).toMatchObject({ questions: 0, items: 0 });
  });
});

describe('a sniffer pass that read an item before it became Secret', () => {
  test('queues nothing for it after the Secrets disposition cleared its questions; other items are asked as before', async () => {
    const dir = workspace('olympus-secret-side-sniffer-');
    const installed = installSniffer(dir);
    const fx = fixture(dir);
    const specs: FixtureSpec[] = [
      { id: 'mortgage-letter', name: 'mortgage letter', text: 'Lunch with the neighbours on Friday.' },
      { id: 'therapy-notes', name: 'therapy notes', text: 'Notes from the Tuesday meeting.' },
    ];
    await fx.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const store = installed.snifferStoreForLedger(fx.ledger.dbPath);
    const queued = (id: string) => (['metadata', 'content'] as const)
      .filter((pass) => store.questionFor(identityOf(id), pass) !== undefined);
    const lane = installed.forLedger(fx.ledger.dbPath).sniffer!;
    // A pass in flight: it read both items (neither Secret) and is about to ask.
    const staleRead = fx.ledger.classificationRead(identityOf('mortgage-letter'));
    expect(staleRead).toMatchObject({ override: undefined, secret: false });
    const stale = secretFencedSniffer(lane, fx.ledger, identityOf('mortgage-letter'), staleRead);
    const other = secretFencedSniffer(lane, fx.ledger, identityOf('therapy-notes'), fx.ledger.classificationRead(identityOf('therapy-notes')));

    expect(runTierSet(['mortgage-letter', 'secrets'], { storePaths: storePaths(fx) }))
      .toMatchObject({ results: [{ override: 'Secrets', outcome: 'hidden_now' }] });
    expect(queued('mortgage-letter')).toEqual([]);

    expect(stale.judge({ pass: 'metadata', flags: ['names:finance'], material: 'mortgage letter', subject: identityOf('mortgage-letter') }))
      .toEqual({ verdict: 'undecided' });
    expect(queued('mortgage-letter')).toEqual([]);
    expect(JSON.stringify(store.listQuestions())).not.toContain('mortgage letter');

    store.deleteItemQuestions(identityOf('therapy-notes'));
    other.judge({ pass: 'metadata', flags: ['names:health'], material: 'therapy notes', subject: identityOf('therapy-notes') });
    expect(queued('therapy-notes')).toEqual(['metadata']);
  });

  test('read as Secret under "not a secret", then marked Secret again: queues nothing; unchanged, it may still ask', async () => {
    const dir = workspace('olympus-secret-side-sniffer-');
    const installed = installSniffer(dir);
    const fx = fixture(dir);
    await fx.set.sync(fixtureConnector(() => [{ id: 'mortgage-letter', name: 'mortgage letter', text: 'Lunch with the neighbours on Friday.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(runTierSet(['mortgage-letter', 'secrets'], { storePaths: storePaths(fx) }))
      .toMatchObject({ results: [{ override: 'Secrets' }] });
    // The owner takes it back; the record is still Secrets until it is listed again.
    fx.ledger.setOverride(identityOf('mortgage-letter'), { kind: 'not_secret' });
    const store = installed.snifferStoreForLedger(fx.ledger.dbPath);
    const lane = installed.forLedger(fx.ledger.dbPath).sniffer!;
    const read = fx.ledger.classificationRead(identityOf('mortgage-letter'));
    expect(read).toMatchObject({ secret: true, override: { kind: 'not_secret' } });
    const listing = secretFencedSniffer(lane, fx.ledger, identityOf('mortgage-letter'), read);
    const ask = () => listing.judge({ pass: 'metadata', flags: ['names:finance'], material: 'mortgage letter', subject: identityOf('mortgage-letter') });

    // Nothing changed since the read: the listing is the fresh truth and asks.
    ask();
    expect(store.questionFor(identityOf('mortgage-letter'), 'metadata')).toBeDefined();
    // The owner marks it Secret again mid-pass: cleared, and not queued again.
    expect(runTierSet(['mortgage-letter', 'secrets'], { storePaths: storePaths(fx) }))
      .toMatchObject({ results: [{ override: 'Secrets' }] });
    expect(store.questionFor(identityOf('mortgage-letter'), 'metadata')).toBeUndefined();
    ask();
    expect(JSON.stringify(store.listQuestions())).not.toContain('mortgage letter');
  });

  test('read as Secret, then cleared again by a detector with the override unchanged: queues nothing', async () => {
    const dir = workspace('olympus-secret-side-sniffer-');
    const installed = installSniffer(dir);
    const fx = fixture(dir);
    await fx.set.sync(fixtureConnector(() => [{ id: 'ops-note', name: 'ops note', version: 'v1', text: `The deploy key is ${FAKE_AWS_KEY} until Friday.` }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(fx.ledger.getCurrent(identityOf('ops-note'))?.contentTier).toBe('secrets');
    const store = installed.snifferStoreForLedger(fx.ledger.dbPath);
    const lane = installed.forLedger(fx.ledger.dbPath).sniffer!;
    // A listing reads it (Secrets, no override) and finds it changed: it would ask.
    const read = fx.ledger.classificationRead(identityOf('ops-note'));
    expect(read).toMatchObject({ secret: true, override: undefined });
    const listing = secretFencedSniffer(lane, fx.ledger, identityOf('ops-note'), read);
    // Meanwhile another pass detects the secret again and clears the side stores.
    await fx.set.sync(fixtureConnector(() => [{ id: 'ops-note', name: 'ops note', version: 'v2', text: `Rotated: ${FAKE_AWS_KEY} is retired.` }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(fx.ledger.classificationRead(identityOf('ops-note')).scrubRevision).toBeGreaterThan(read.scrubRevision);

    listing.judge({ pass: 'metadata', flags: ['names:finance'], material: 'ops note', subject: identityOf('ops-note') });
    expect(store.questionFor(identityOf('ops-note'), 'metadata')).toBeUndefined();
  });
});

describe('the extraction job ledger keeps no name of an item that becomes Secret', () => {
  const KEYS: FixtureSpec = { id: 'keys', name: `deploy ${FAKE_AWS_KEY}.txt`, text: 'Weekly notes about the deploy runbook.' };
  const GARDEN: FixtureSpec = { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden.' };
  const LANE_KEY = { corpusId: CORPORA.secure_local, provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: 'fixture:/Files' };
  const ref = (spec: FixtureSpec): ExtractionItemRef => ({
    ...LANE_KEY,
    providerItemId: spec.id,
    localItemId: fixtureLocalId(spec),
    sourceVersion: 'v1',
    name: spec.name,
    mimeType: 'text/plain',
  });

  /** The ledger at the default path (env), or, `opened`, at a path only the runtime that opened it knows. */
  function jobStore(dir: string, how: 'default' | 'opened' = 'default'): LocalFileExtractionJobStore {
    const path = join(dir, 'file-extraction-jobs.sqlite');
    if (how === 'default') pointJobsEnvAt(path);
    const store = new LocalFileExtractionJobStore(path);
    cleanups.push(() => store.close());
    return store;
  }

  test('a file extracted before it became Secret: its settled job keeps its status and loses the name; other jobs are untouched', async () => {
    const dir = workspace('olympus-secret-side-jobs-');
    const fx = fixture(dir);
    const jobs = jobStore(dir);
    // The owner said "not a secret" first, so the file was stored and extracted.
    fx.ledger.setOverride(identityOf('keys'), { kind: 'not_secret' });
    await fx.set.sync(fixtureConnector(() => [KEYS, GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const queued = jobs.enqueue({ refs: [ref(KEYS), ref(GARDEN)], extractorKind: 'text', extractorVersion: 'v1' });
    const [keysJob, gardenJob] = queued.jobRefs.map((entry) => entry.jobId) as [string, string];
    const leased = jobs.lease({ ...LANE_KEY, workerId: 'worker-1' });
    expect(leased.leasedJobs.map((job) => job.jobId).sort()).toEqual([keysJob, gardenJob].sort());
    // A sheet named for what it holds: the structural ref carries the name.
    jobs.record({
      jobId: keysJob,
      status: 'indexed',
      derivations: [{ artifactKind: 'sheet', structuralRef: { kind: 'sheet', sheet: `keys ${FAKE_AWS_KEY}` }, chars: 40 }],
    });
    expect(jobs.get(keysJob)?.ref.name).toBe(KEYS.name);
    expect(jobs.artifacts(LANE_KEY.corpusId, fixtureLocalId(KEYS))).toHaveLength(1);
    const keysBefore = jobs.get(keysJob)!;
    const gardenBefore = jobs.get(gardenJob)!;

    // Now the owner marks it Secret, through the pass the worker runs.
    fx.ledger.setOverride(identityOf('keys'), { kind: 'tier', tier: 'secrets' });
    expect(applyOwnerOverrides({ set: fx.set })).toMatchObject({ secrets: 1 });

    const keysAfter = jobs.get(keysJob)!;
    expect(keysAfter.ref.name).toBeUndefined();
    expect(jobs.artifacts(LANE_KEY.corpusId, fixtureLocalId(KEYS))).toEqual([]);
    expect(JSON.stringify(keysAfter)).not.toContain(FAKE_AWS_KEY);
    // Only the name: the job's status, attempts and retry state are as recorded.
    const { ref: _keysRef, ...keysRest } = keysAfter;
    const { ref: _keysRefBefore, ...keysRestBefore } = keysBefore;
    expect(keysRest).toEqual(keysRestBefore);
    // Another item's job, still leased, is exactly as it was and records normally.
    expect(jobs.get(gardenJob)).toEqual(gardenBefore);
    expect(jobs.record({
      jobId: gardenJob,
      status: 'indexed',
      derivations: [{ artifactKind: 'page', structuralRef: { kind: 'page', page: 1 }, chars: 40 }],
    }).artifactsRecorded).toBe(1);
    expect(jobs.get(gardenJob)?.ref.name).toBe(GARDEN.name);
    expect(jobs.artifacts(LANE_KEY.corpusId, fixtureLocalId(GARDEN))).toHaveLength(1);

    // A planning pass that listed the file before it became Secret enqueues
    // its stale ref afterwards: the refreshed job and a new one stay nameless.
    const stale = jobs.enqueue({
      refs: [ref(KEYS), { ...ref(KEYS), sourceVersion: 'v2' }, ref(GARDEN)],
      extractorKind: 'text',
      extractorVersion: 'v1',
      force: true,
    });
    const [refreshed, fresh, garden] = stale.jobRefs.map((entry) => jobs.get(entry.jobId)!);
    expect(refreshed!.jobId).toBe(keysJob);
    expect(refreshed!.ref.name).toBeUndefined();
    expect(fresh!.jobId).not.toBe(keysJob);
    expect(fresh!.ref.name).toBeUndefined();
    expect(garden!.ref.name).toBe(GARDEN.name);
  });

  test('marked Secret from the command: a job leased in flight loses the name and still records, in a ledger at a non-default path', async () => {
    const dir = workspace('olympus-secret-side-jobs-');
    const fx = fixture(dir);
    pointJobsEnvAt(join(dir, 'not-this-one.sqlite'));
    const jobs = jobStore(dir, 'opened');
    await fx.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const [gardenJob] = jobs.enqueue({ refs: [ref(GARDEN)], extractorKind: 'text', extractorVersion: 'v1' }).jobRefs.map((entry) => entry.jobId);
    const [lease] = jobs.lease({ ...LANE_KEY, workerId: 'worker-1' }).leasedJobs;

    expect(runTierSet(['garden', 'secrets'], { storePaths: storePaths(fx) }))
      .toMatchObject({ results: [{ override: 'Secrets', outcome: 'hidden_now' }] });

    expect(jobs.get(gardenJob!)).toMatchObject({ status: 'leased' });
    expect(jobs.get(gardenJob!)?.ref.name).toBeUndefined();
    const recorded = jobs.record({
      jobId: gardenJob!,
      status: 'indexed',
      leaseToken: lease!.leaseToken,
      derivations: [{ artifactKind: 'sheet', structuralRef: { kind: 'sheet', sheet: 'garden beds' }, chars: 40 }],
    });
    expect(recorded).toMatchObject({ status: 'indexed', artifactsRecorded: 0 });
    expect(jobs.artifacts(LANE_KEY.corpusId, fixtureLocalId(GARDEN))).toEqual([]);
  });

  test('marked Secret from the command in another process: owed until the worker, which knows its own ledger path, clears it', async () => {
    const dir = workspace('olympus-secret-side-jobs-');
    const fx = fixture(dir);
    pointJobsEnvAt(join(dir, 'not-this-one.sqlite'));
    const runtimePath = join(dir, 'runtime-jobs.sqlite');
    await fx.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const before = new LocalFileExtractionJobStore(runtimePath);
    const [gardenJob] = before.enqueue({ refs: [ref(GARDEN)], extractorKind: 'text', extractorVersion: 'v1' }).jobRefs.map((entry) => entry.jobId);
    // The command's process never opened the runtime's ledger.
    before.close();

    expect(runTierSet(['garden', 'secrets'], { storePaths: storePaths(fx) }))
      .toMatchObject({ results: [{ override: 'Secrets', outcome: 'hidden_now' }] });
    expect(rawJobName(runtimePath, gardenJob!)).toBe(GARDEN.name);
    expect(fx.ledger.secretSideStoreDebts()).toEqual([expect.objectContaining({ providerItemId: 'garden' })]);

    // The worker's tick, its runtime holding the ledger open.
    const worker = new LocalFileExtractionJobStore(runtimePath);
    cleanups.push(() => worker.close());
    applyOwnerOverrides({ set: fx.set });
    expect(worker.get(gardenJob!)?.ref.name).toBeUndefined();
    expect(fx.ledger.secretSideStoreDebts()).toEqual([]);
  });

  test('a ledger only a runtime knew, unreachable when the item became Secret, is still cleared after that runtime is gone', async () => {
    const dir = workspace('olympus-secret-side-jobs-');
    const fx = fixture(dir);
    pointJobsEnvAt(join(dir, 'not-this-one.sqlite'));
    const runtimePath = join(dir, 'runtime-jobs.sqlite');
    await fx.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    writeFileSync(runtimePath, 'not a database');
    const unregister = registerExtractionJobsDbPath(runtimePath);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fx.ledger.setOverride(identityOf('garden'), { kind: 'tier', tier: 'secrets' });
      expect(applyOwnerOverrides({ set: fx.set })).toMatchObject({ secrets: 1 });
    } finally {
      warn.mockRestore();
    }
    expect(fx.ledger.secretSideStoreDebts()).toEqual([expect.objectContaining({ providerItemId: 'garden', jobLedgerPaths: [runtimePath] })]);
    // The runtime stops (its path forgotten in this process), its ledger still
    // unreachable; the Secret is listed again meanwhile: still owed there.
    unregister();
    const warnAgain = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fx.set.sync(fixtureConnector(() => [{ ...GARDEN, version: 'v2' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      expect(warnAgain).toHaveBeenCalled();
    } finally {
      warnAgain.mockRestore();
    }
    expect(fx.ledger.secretSideStoreDebts()).toEqual([expect.objectContaining({ providerItemId: 'garden', jobLedgerPaths: [runtimePath] })]);
    // Its ledger comes back holding the name.
    rmSync(runtimePath);
    const restored = new LocalFileExtractionJobStore(runtimePath);
    const [gardenJob] = restored.enqueue({ refs: [ref(GARDEN)], extractorKind: 'text', extractorVersion: 'v1' }).jobRefs.map((entry) => entry.jobId);
    restored.close();

    applyOwnerOverrides({ set: fx.set });
    expect(rawJobName(runtimePath, gardenJob!)).toBeNull();
    expect(fx.ledger.secretSideStoreDebts()).toEqual([]);
  });

  test('a job ledger on the schema before redactions stays owed until it can keep the name out', async () => {
    const dir = workspace('olympus-secret-side-jobs-');
    const fx = fixture(dir);
    const jobsPath = join(dir, 'file-extraction-jobs.sqlite');
    pointJobsEnvAt(jobsPath);
    await fx.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const older = new LocalFileExtractionJobStore(jobsPath);
    const [gardenJob] = older.enqueue({ refs: [ref(GARDEN)], extractorKind: 'text', extractorVersion: 'v1' }).jobRefs.map((entry) => entry.jobId);
    older.close();
    // As an older build left it: schema 3, no redactions table.
    const raw = new Database(jobsPath);
    raw.exec(`DROP TABLE ${SECRET_ITEM_REDACTIONS_TABLE}; UPDATE schema_version SET version = 3 WHERE store_id = 'file-extraction-jobs';`);
    raw.close();

    fx.ledger.setOverride(identityOf('garden'), { kind: 'tier', tier: 'secrets' });
    expect(applyOwnerOverrides({ set: fx.set })).toMatchObject({ secrets: 1 });
    expect(rawJobName(jobsPath, gardenJob!)).toBeNull();
    expect(fx.ledger.secretSideStoreDebts()).toEqual([expect.objectContaining({ providerItemId: 'garden' })]);

    // The worker upgrades its ledger; the next tick makes the clearing durable.
    const jobs = new LocalFileExtractionJobStore(jobsPath);
    cleanups.push(() => jobs.close());
    applyOwnerOverrides({ set: fx.set });
    expect(fx.ledger.secretSideStoreDebts()).toEqual([]);
    // A planning pass that listed the file before it became Secret.
    jobs.enqueue({ refs: [ref(GARDEN)], extractorKind: 'text', extractorVersion: 'v1', force: true });
    expect(jobs.get(gardenJob!)?.ref.name).toBeUndefined();
  });

  test('a false-positive Secret the owner restores gets its job names and artifacts back; marked Secret again, it loses them again', async () => {
    const dir = workspace('olympus-secret-side-jobs-');
    const fx = fixture(dir);
    const jobs = jobStore(dir);
    const owedElsewhere = join(dir, 'gone-runtime-jobs.sqlite');
    // Judged Secret by its name at listing: its jobs keep no name.
    await fx.set.sync(fixtureConnector(() => [KEYS]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(fx.ledger.itemIsSecret(identityOf('keys'))).toBe(true);
    const [secretJob] = jobs.enqueue({ refs: [ref(KEYS)], extractorKind: 'text', extractorVersion: 'v1' }).jobRefs.map((entry) => entry.jobId);
    expect(jobs.get(secretJob!)?.ref.name).toBeUndefined();
    // A clearing still owed in a ledger a runtime once knew.
    fx.ledger.recordSecretSideStoreDebt({ ...identityOf('keys'), localItemId: fixtureLocalId(KEYS) }, [owedElsewhere]);

    // The owner says "not a secret"; the item's next listing decides it again.
    fx.ledger.setOverride(identityOf('keys'), { kind: 'not_secret' });
    await fx.set.sync(fixtureConnector(() => [{ ...KEYS, version: 'v2' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(fx.ledger.itemIsSecret(identityOf('keys'))).toBe(false);
    // Placed afresh: its copies were tombstoned, so there is nothing to move.
    expect(fx.ledger.getCurrent(identityOf('keys'))).toMatchObject({ state: 'current', contentTier: 'private' });
    expect(fx.stores.internal!.itemPresence(identityOf('keys')).active).toBe(true);
    expect(fx.ledger.secretSideStoreDebts()).toEqual([]);
    expect(fx.ledger.secretRedactionRetirements()).toEqual([]);
    const restored = jobs.enqueue({ refs: [{ ...ref(KEYS), sourceVersion: 'v2' }], extractorKind: 'text', extractorVersion: 'v1' });
    const [restoredJob] = restored.jobRefs.map((entry) => entry.jobId);
    expect(jobs.get(restoredJob!)?.ref.name).toBe(KEYS.name);
    const [lease] = jobs.lease({ ...LANE_KEY, workerId: 'worker-1' }).leasedJobs.filter((job) => job.jobId === restoredJob);
    expect(jobs.record({
      jobId: restoredJob!,
      status: 'indexed',
      leaseToken: lease!.leaseToken,
      derivations: [{ artifactKind: 'sheet', structuralRef: { kind: 'sheet', sheet: 'deploy keys' }, chars: 40 }],
    }).artifactsRecorded).toBe(1);
    expect(jobs.artifacts(LANE_KEY.corpusId, fixtureLocalId(KEYS))).toHaveLength(1);
    // The worker's tick neither re-clears it nor brings an owed clearing back.
    applyOwnerOverrides({ set: fx.set });
    expect(jobs.get(restoredJob!)?.ref.name).toBe(KEYS.name);
    expect(fx.ledger.secretSideStoreDebts()).toEqual([]);

    // Marked Secret again: the names and artifacts go, and stay gone.
    fx.ledger.setOverride(identityOf('keys'), { kind: 'tier', tier: 'secrets' });
    expect(applyOwnerOverrides({ set: fx.set })).toMatchObject({ secrets: 1 });
    expect(jobs.get(restoredJob!)?.ref.name).toBeUndefined();
    expect(jobs.artifacts(LANE_KEY.corpusId, fixtureLocalId(KEYS))).toEqual([]);
    applyOwnerOverrides({ set: fx.set });
    const [again] = jobs.enqueue({ refs: [{ ...ref(KEYS), sourceVersion: 'v3' }], extractorKind: 'text', extractorVersion: 'v1' }).jobRefs.map((entry) => entry.jobId);
    expect(jobs.get(again!)?.ref.name).toBeUndefined();
  });

  test('a retirement is never carried out while the item is Secrets', async () => {
    const dir = workspace('olympus-secret-side-jobs-');
    const fx = fixture(dir);
    const jobs = jobStore(dir);
    await fx.set.sync(fixtureConnector(() => [KEYS]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    // Restored, then the owner marks it Secret before any retirement runs:
    // the Secrets decision cancels the retirement in the same write.
    fx.ledger.setOverride(identityOf('keys'), { kind: 'not_secret' });
    const raw = new Database(fx.ledger.dbPath);
    try {
      raw.exec(`UPDATE tier_items SET metadata_tier = 'private', content_tier = 'private' WHERE provider_item_id = 'keys'`);
    } finally {
      raw.close();
    }
    expect(fx.ledger.secretRedactionRetirements()).toEqual([expect.objectContaining({ providerItemId: 'keys' })]);
    fx.ledger.setOverride(identityOf('keys'), { kind: 'tier', tier: 'secrets' });
    // Not yet decided Secrets again (the override alone): the retirement is
    // dropped, the marker stays.
    expect(retireSecretRedactions(fx.ledger)).toBe(0);
    expect(fx.ledger.secretRedactionRetirements()).toEqual([]);
    const [job] = jobs.enqueue({ refs: [ref(KEYS)], extractorKind: 'text', extractorVersion: 'v1' }).jobRefs.map((entry) => entry.jobId);
    expect(jobs.get(job!)?.ref.name).toBeUndefined();
  });
});

describe('a side store that cannot be reached when the item becomes Secret', () => {
  test('is left as a ledger debt and cleared at the next tier tick, without the item being listed again', async () => {
    const dir = workspace('olympus-secret-side-debt-');
    const fx = fixture(dir);
    const jobsPath = join(dir, 'file-extraction-jobs.sqlite');
    pointJobsEnvAt(jobsPath);
    const spec: FixtureSpec = { id: 'keys', name: `deploy ${FAKE_AWS_KEY}.txt`, text: 'Weekly notes about the deploy runbook.' };
    fx.ledger.setOverride(identityOf('keys'), { kind: 'not_secret' });
    await fx.set.sync(fixtureConnector(() => [spec]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    // The job ledger cannot be read when the item becomes Secret (here: a
    // damaged file; in life, a lock held past the busy timeout).
    writeFileSync(jobsPath, 'not a database');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fx.ledger.setOverride(identityOf('keys'), { kind: 'tier', tier: 'secrets' });
      expect(applyOwnerOverrides({ set: fx.set })).toMatchObject({ secrets: 1 });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    // The ledger comes back holding the name (written before it became Secret).
    rmSync(jobsPath);
    const jobs = new LocalFileExtractionJobStore(jobsPath);
    const lane = { corpusId: CORPORA.secure_local, provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: 'fixture:/Files' };
    const [jobId] = jobs.enqueue({
      refs: [{ ...lane, providerItemId: 'keys', localItemId: fixtureLocalId(spec), sourceVersion: 'v1', name: spec.name }],
      extractorKind: 'text',
      extractorVersion: 'v1',
    }).jobRefs.map((entry) => entry.jobId);
    jobs.close();
    // The copies are settled; the name is still there, owed.
    expect(fx.ledger.copies(identityOf('keys'))).toEqual([]);
    expect(fx.ledger.secretSideStoreDebts()).toEqual([expect.objectContaining({ providerItemId: 'keys' })]);
    const reader = () => {
      const store = new LocalFileExtractionJobStore(jobsPath);
      try {
        return store.get(jobId!);
      } finally {
        store.close();
      }
    };
    expect(reader()?.ref.name).toBe(spec.name);

    // The next tick: no listing, no override change.
    applyOwnerOverrides({ set: fx.set });
    expect(reader()?.ref.name).toBeUndefined();
    expect(fx.ledger.secretSideStoreDebts()).toEqual([]);
  });
});

describe('a Secret owed in a store\'s own ledger (no tier set)', () => {
  test('is retried by the worker\'s tier tick', async () => {
    const dir = workspace('olympus-secret-side-debt-');
    const jobsPath = join(dir, 'runtime-jobs.sqlite');
    pointJobsEnvAt(join(dir, 'not-this-one.sqlite'));
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'plain.sqlite'),
      corpusId: 'internal.plain.files',
      family: 'file',
      trustDomain: 'internal',
    });
    const ledger = store.tierLedger()!;
    const jobs = new LocalFileExtractionJobStore(jobsPath);
    const [jobId] = jobs.enqueue({
      refs: [{
        corpusId: 'internal.plain.files', provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: 'fixture:/Files',
        providerItemId: 'ops', localItemId: fixtureLocalId({ id: 'ops' }), sourceVersion: 'v1', name: 'ops note',
      }],
      extractorKind: 'text',
      extractorVersion: 'v1',
    }).jobRefs.map((entry) => entry.jobId);
    jobs.close();
    // Owed when the job ledger could not be reached (its runtime since stopped).
    ledger.recordSecretSideStoreDebt(identityOf('ops'), [jobsPath]);
    const service = new TierSnifferService({
      installed: installSniffer(dir),
      lane: LANE as unknown as SnifferLane,
      model: {} as AnalystModel,
      stores: () => [store],
      classificationLedgerPath: join(dir, 'classification-ledger.jsonl'),
      modelAvailable: () => false,
    });
    cleanups.push(() => {
      service.stop();
      store.close();
    });

    await service.runOnce();
    expect(rawJobName(jobsPath, jobId!)).toBeNull();
    expect(ledger.secretSideStoreDebts()).toEqual([]);
  });
});

describe('a tier ledger written by an earlier build of this change (schema 6)', () => {
  test('gains the scrub revisions on open', () => {
    const dir = workspace('olympus-secret-side-ledger-');
    const path = join(dir, 'set.tier-ledger.sqlite');
    new TierLedger({ dbPath: path }).close();
    const raw = new Database(path);
    raw.exec(`DROP TABLE secret_side_store_scrubs; UPDATE schema_version SET version = 6 WHERE store_id = '${TIER_LEDGER_SQLITE_STORE_ID}';`);
    raw.close();

    const ledger = new TierLedger({ dbPath: path });
    cleanups.push(() => ledger.close());
    ledger.noteSecretScrub(identityOf('ops'));
    expect(ledger.classificationRead(identityOf('ops'))).toEqual({ override: undefined, secret: false, scrubRevision: 1 });
  });
});

describe('a legacy item (never routed by a set) judged Secret', () => {
  test('keeps no queued question or job name either', async () => {
    const dir = workspace('olympus-secret-side-legacy-');
    const jobsPath = join(dir, 'file-extraction-jobs.sqlite');
    pointJobsEnvAt(jobsPath);
    const ledger = new TierLedger({ dbPath: join(dir, 'legacy.tier-ledger.sqlite') });
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'legacy.sqlite'),
      corpusId: 'internal.legacy.files',
      family: 'file',
      trustDomain: 'internal',
      tierLedger: ledger,
    });
    const sniffer = new TierSnifferStore({ dbPath: tierSnifferPathForLedger(ledger.dbPath) });
    const jobs = new LocalFileExtractionJobStore(jobsPath);
    cleanups.push(() => {
      jobs.close();
      sniffer.close();
      store.close();
      ledger.close();
    });
    const subject = identityOf('ops');
    sniffer.enqueue({ subject, pass: 'metadata', material: 'ops note', mapRevision: 'none', flags: [] });
    const [jobId] = jobs.enqueue({
      refs: [{
        corpusId: 'internal.legacy.files', provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: 'fixture:/Files',
        providerItemId: 'ops', localItemId: fixtureLocalId({ id: 'ops' }), sourceVersion: 'v1', name: 'ops note',
      }],
      extractorKind: 'text',
      extractorVersion: 'v1',
    }).jobRefs.map((entry) => entry.jobId);

    const spec: FixtureSpec = { id: 'ops', name: 'ops note', text: `The deploy key is ${FAKE_AWS_KEY} until Friday.` };
    await store.syncFromConnector(fixtureConnector(() => [spec]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(ledger.getCurrent(subject)).toMatchObject({ contentTier: 'secrets', routed: false });
    expect(sniffer.questionFor(subject, 'metadata')).toBeUndefined();
    expect(jobs.get(jobId!)?.ref.name).toBeUndefined();
  });

  test('whose extracted text turns out Secret keeps no queued question or job name either', async () => {
    const dir = workspace('olympus-secret-side-legacy-');
    const jobsPath = join(dir, 'file-extraction-jobs.sqlite');
    pointJobsEnvAt(jobsPath);
    const ledger = new TierLedger({ dbPath: join(dir, 'legacy.tier-ledger.sqlite') });
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'legacy.sqlite'),
      corpusId: 'internal.legacy.files',
      family: 'file',
      trustDomain: 'internal',
      tierLedger: ledger,
    });
    const sniffer = new TierSnifferStore({ dbPath: tierSnifferPathForLedger(ledger.dbPath) });
    const jobs = new LocalFileExtractionJobStore(jobsPath);
    cleanups.push(() => {
      jobs.close();
      sniffer.close();
      store.close();
      ledger.close();
    });
    const subject = identityOf('ops');
    await store.syncFromConnector(fixtureConnector(() => [{ id: 'ops', name: 'ops note', text: 'Weekly notes.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(ledger.getCurrent(subject)?.contentTier).not.toBe('secrets');
    sniffer.enqueue({ subject, pass: 'content', material: 'ops note', mapRevision: 'none', flags: [] });
    const [jobId] = jobs.enqueue({
      refs: [{
        corpusId: 'internal.legacy.files', provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: 'fixture:/Files',
        providerItemId: 'ops', localItemId: fixtureLocalId({ id: 'ops' }), sourceVersion: 'v1', name: 'ops note',
      }],
      extractorKind: 'text',
      extractorVersion: 'v1',
    }).jobRefs.map((entry) => entry.jobId);

    // The extraction sink's Secrets floor records what the extracted text decided.
    const item = { identity: subject, metadata: { title: 'ops note' }, mimeType: 'text/plain' } as unknown as RawItem;
    expect(store.recordExtractedContentTier(item, `The deploy key is ${FAKE_AWS_KEY} until Friday.`)).toBe(true);
    expect(ledger.getCurrent(subject)?.contentTier).toBe('secrets');
    expect(sniffer.questionFor(subject, 'content')).toBeUndefined();
    expect(jobs.get(jobId!)?.ref.name).toBeUndefined();
  });

  test('settled Secret by the extraction sink keeps no queued question or job name, even with no tier decision recorded', async () => {
    const dir = workspace('olympus-secret-side-legacy-');
    const jobsPath = join(dir, 'file-extraction-jobs.sqlite');
    pointJobsEnvAt(jobsPath);
    const ledger = new TierLedger({ dbPath: join(dir, 'legacy.tier-ledger.sqlite') });
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'legacy.sqlite'),
      corpusId: 'internal.legacy.files',
      family: 'file',
      trustDomain: 'internal',
      tierLedger: ledger,
    });
    const sniffer = new TierSnifferStore({ dbPath: tierSnifferPathForLedger(ledger.dbPath) });
    const jobs = new LocalFileExtractionJobStore(jobsPath);
    cleanups.push(() => {
      jobs.close();
      sniffer.close();
      store.close();
      ledger.close();
    });
    const subject = identityOf('ops');
    await store.syncFromConnector(fixtureConnector(() => [{ id: 'ops', name: 'ops note', text: 'Weekly notes.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    sniffer.enqueue({ subject, pass: 'content', material: 'ops note', mapRevision: 'none', flags: [] });
    const [jobId] = jobs.enqueue({
      refs: [{
        corpusId: 'internal.legacy.files', provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: 'fixture:/Files',
        providerItemId: 'ops', localItemId: fixtureLocalId({ id: 'ops' }), sourceVersion: 'v1', name: 'ops note',
      }],
      extractorKind: 'text',
      extractorVersion: 'v1',
    }).jobRefs.map((entry) => entry.jobId);

    // The sink's Secrets floor tombstones the copy; recording the decision is a separate best-effort write, not made here.
    expect(settleUntrackedSecretsCopy({ store, identity: subject, connectorId: 'fixture_lane', metadata: { title: 'ops note' } })).toBe('tombstoned');
    expect(ledger.getCurrent(subject)?.contentTier).not.toBe('secrets');
    expect(sniffer.questionFor(subject, 'content')).toBeUndefined();
    expect(jobs.get(jobId!)?.ref.name).toBeUndefined();
  });
});

describe('side stores that do not exist', () => {
  test('are not created by an item becoming Secret', async () => {
    const dir = workspace('olympus-secret-side-none-');
    const fx = fixture(dir);
    const jobsPath = join(dir, 'never-created-jobs.sqlite');
    pointJobsEnvAt(jobsPath);
    await fx.set.sync(fixtureConnector(() => [{ id: 'garden', name: 'garden-plan.txt', text: 'Garden notes.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    fx.ledger.setOverride(identityOf('garden'), { kind: 'tier', tier: 'secrets' });
    expect(applyOwnerOverrides({ set: fx.set })).toMatchObject({ secrets: 1 });
    expect(await Bun.file(jobsPath).exists()).toBe(false);
    expect(await Bun.file(tierSnifferPathForLedger(fx.ledger.dbPath)).exists()).toBe(false);
  });
});
