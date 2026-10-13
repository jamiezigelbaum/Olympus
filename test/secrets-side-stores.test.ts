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

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  clearInstalledTierClassification,
  configureInstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import { runTierSet } from '../src/workers/classification/tier-cli.ts';
import { tierSnifferPathForLedger } from '../src/workers/classification/tier-ledger-path.ts';
import { applyOwnerOverrides } from '../src/workers/connector-store/tier-override-settle.ts';
import { FILE_EXTRACTION_JOBS_DB_PATH_ENV, LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import type { ExtractionItemRef } from '../src/workers/file-extraction/types.ts';
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

  function jobStore(dir: string): LocalFileExtractionJobStore {
    const path = join(dir, 'file-extraction-jobs.sqlite');
    const previous = process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV];
    process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV] = path;
    const store = new LocalFileExtractionJobStore(path);
    cleanups.push(() => {
      store.close();
      if (previous === undefined) delete process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV];
      else process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV] = previous;
    });
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
    jobs.record({ jobId: keysJob, status: 'indexed' });
    expect(jobs.get(keysJob)?.ref.name).toBe(KEYS.name);
    const keysBefore = jobs.get(keysJob)!;
    const gardenBefore = jobs.get(gardenJob)!;

    // Now the owner marks it Secret, through the pass the worker runs.
    fx.ledger.setOverride(identityOf('keys'), { kind: 'tier', tier: 'secrets' });
    expect(applyOwnerOverrides({ set: fx.set })).toMatchObject({ secrets: 1 });

    const keysAfter = jobs.get(keysJob)!;
    expect(keysAfter.ref.name).toBeUndefined();
    expect(JSON.stringify(keysAfter)).not.toContain(FAKE_AWS_KEY);
    // Only the name: the job's status, attempts and retry state are as recorded.
    const { ref: _keysRef, ...keysRest } = keysAfter;
    const { ref: _keysRefBefore, ...keysRestBefore } = keysBefore;
    expect(keysRest).toEqual(keysRestBefore);
    // Another item's job, still leased, is exactly as it was and records normally.
    expect(jobs.get(gardenJob)).toEqual(gardenBefore);
    expect(jobs.record({ jobId: gardenJob, status: 'indexed' }).status).toBe('indexed');
    expect(jobs.get(gardenJob)?.ref.name).toBe(GARDEN.name);
  });

  test('marked Secret from the command: a job leased in flight loses the name and still records', async () => {
    const dir = workspace('olympus-secret-side-jobs-');
    const fx = fixture(dir);
    const jobs = jobStore(dir);
    await fx.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const [gardenJob] = jobs.enqueue({ refs: [ref(GARDEN)], extractorKind: 'text', extractorVersion: 'v1' }).jobRefs.map((entry) => entry.jobId);
    const [lease] = jobs.lease({ ...LANE_KEY, workerId: 'worker-1' }).leasedJobs;

    expect(runTierSet(['garden', 'secrets'], { storePaths: storePaths(fx) }))
      .toMatchObject({ results: [{ override: 'Secrets', outcome: 'hidden_now' }] });

    expect(jobs.get(gardenJob!)).toMatchObject({ status: 'leased' });
    expect(jobs.get(gardenJob!)?.ref.name).toBeUndefined();
    expect(jobs.record({ jobId: gardenJob!, status: 'indexed', leaseToken: lease!.leaseToken }).status).toBe('indexed');
  });
});

describe('side stores that do not exist', () => {
  test('are not created by an item becoming Secret', async () => {
    const dir = workspace('olympus-secret-side-none-');
    const fx = fixture(dir);
    const previous = process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV];
    const jobsPath = join(dir, 'never-created-jobs.sqlite');
    process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV] = jobsPath;
    cleanups.push(() => {
      if (previous === undefined) delete process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV];
      else process.env[FILE_EXTRACTION_JOBS_DB_PATH_ENV] = previous;
    });
    await fx.set.sync(fixtureConnector(() => [{ id: 'garden', name: 'garden-plan.txt', text: 'Garden notes.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    fx.ledger.setOverride(identityOf('garden'), { kind: 'tier', tier: 'secrets' });
    expect(applyOwnerOverrides({ set: fx.set })).toMatchObject({ secrets: 1 });
    expect(await Bun.file(jobsPath).exists()).toBe(false);
    expect(await Bun.file(tierSnifferPathForLedger(fx.ledger.dbPath)).exists()).toBe(false);
  });
});
