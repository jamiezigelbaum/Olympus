// A copied install never writes the original's extraction job ledger (#1414,
// the job-ledger twin of #1398). A tier ledger records the job ledgers a
// worker had open (`known_job_ledgers`), and a Secret's debt records the ones
// it still owes, as absolute paths. A copy keeps the original's paths, so
// every write that visits recorded job ledgers (clearing a Secret, retiring
// its redaction, a re-read owed after a tier move or a revive) visits only
// this install's own: the default, the ones this process holds open, and
// recorded ones inside this install's data root.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MEDIA_CACHE_DIR_ENV, mediaCacheDir, retainMediaCacheFile, writeMediaCacheFile } from '../src/core/media-cache.ts';
import { olympusDataRoot } from '../src/core/olympus-layout.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { clearInstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { applyOwnerOverrides } from '../src/workers/connector-store/tier-override-settle.ts';
import { retireSecretRedactions } from '../src/workers/connector-store/secrets-disposition.ts';
import { LocalFileExtractionJobStore, defaultFileExtractionJobsDbPath } from '../src/workers/file-extraction/job-store.ts';
import { extractionJobsDbPaths, jobLedgerPathsToVisit } from '../src/workers/file-extraction/job-names.ts';
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
} from './helpers/tier-fixtures.ts';

const GARDEN: FixtureSpec = { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden.' };
const LANE_KEY = { corpusId: CORPORA.secure_local, provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: 'fixture:/Files' };

const cleanups: Array<() => void> = [];
afterEach(() => {
  clearInstalledTierClassification();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** This process's data folder (and so its default job ledger) under `dir`. */
function useDataRoot(dir: string): string {
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(dir, 'data');
  cleanups.push(() => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  });
  const path = defaultFileExtractionJobsDbPath(process.env);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function jobName(path: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query('SELECT name FROM extraction_jobs LIMIT 1').get() as { name: string | null }).name;
  } finally {
    db.close();
  }
}

/** An original install whose tier ledger has noted its job ledger, copied whole to B. */
async function copiedInstall() {
  const tmp = tempDir('olympus-job-ledger-copy-');
  cleanups.push(tmp.cleanup);
  const a = join(tmp.dir, 'A');
  const b = join(tmp.dir, 'B');
  const jobsA = useDataRoot(a);
  const original = openTierFixture(a, { embed: false });
  try {
    await original.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const jobs = new LocalFileExtractionJobStore(jobsA);
    jobs.enqueue({
      refs: [{ ...LANE_KEY, providerItemId: GARDEN.id, localItemId: fixtureLocalId(GARDEN), sourceVersion: 'v1', name: GARDEN.name }],
      extractorKind: 'text',
      extractorVersion: 'v1',
    });
    jobs.close();
    // The worker's tick notes the job ledgers it has, as an absolute path.
    applyOwnerOverrides({ set: original.set });
    expect(original.ledger.knownJobLedgerPaths()).toContain(jobsA);
  } finally {
    original.close();
  }
  cpSync(a, b, { recursive: true });
  const jobsB = useDataRoot(b);
  return { a, b, jobsA, jobsB };
}

describe('a copied install never writes the original job ledger (#1414)', () => {
  test('recorded paths outside the data root are not visited; the default is the copy\'s own', async () => {
    const { jobsA, jobsB } = await copiedInstall();
    expect(extractionJobsDbPaths()).toEqual([jobsB]);
    expect(jobLedgerPathsToVisit([jobsA, jobsB])).toEqual({ visit: [jobsB], outside: [jobsA] });
    // Another job ledger of this install, recorded but not open, is still visited.
    const other = join(olympusDataRoot(process.env), 'other-jobs.sqlite');
    expect(jobLedgerPathsToVisit([other]).visit).toEqual([jobsB, other]);
  });

  test('a Secret, and its later restore, clear and retire in the copy only; the original is byte for byte unchanged', async () => {
    const { b, jobsA, jobsB } = await copiedInstall();
    const before = hash(jobsA);
    const copy = openTierFixture(b, { embed: false });
    cleanups.push(() => copy.close());
    expect(copy.ledger.knownJobLedgerPaths()).toContain(jobsA);

    copy.ledger.setOverride(identityOf('garden'), { kind: 'tier', tier: 'secrets' });
    expect(applyOwnerOverrides({ set: copy.set })).toMatchObject({ secrets: 1 });
    expect(jobName(jobsB)).toBeNull();
    // Not owed there either: the original's ledger is not this install's debt.
    expect(copy.ledger.secretSideStoreDebts()).toEqual([]);

    copy.ledger.setOverride(identityOf('garden'), { kind: 'not_secret' });
    applyOwnerOverrides({ set: copy.set });
    retireSecretRedactions(copy.ledger);

    expect(hash(jobsA)).toBe(before);
    expect(jobName(jobsA)).toBe(GARDEN.name);
  });
});

describe('a copied store never gives up the original install\'s pictures (#1414)', () => {
  test('a media release queued with the original\'s path leaves the original file and its hold alone', () => {
    const tmp = tempDir('olympus-media-copy-');
    cleanups.push(tmp.cleanup);
    const root = realpathSync(tmp.dir);
    const previous = process.env[MEDIA_CACHE_DIR_ENV];
    cleanups.push(() => {
      if (previous === undefined) delete process.env[MEDIA_CACHE_DIR_ENV];
      else process.env[MEDIA_CACHE_DIR_ENV] = previous;
    });
    // The original install's cache, holding a picture for its store.
    useDataRoot(join(root, 'A'));
    process.env[MEDIA_CACHE_DIR_ENV] = join(root, 'A', 'cache');
    const original = writeMediaCacheFile(mediaCacheDir(), new Uint8Array([1, 2, 3, 4]), 'image/jpeg');
    const holder = join(root, 'A', 'store.sqlite');
    expect(retainMediaCacheFile(original.path, original.sha256, holder)).toBe(true);
    const holds = readdirSync(`${original.path}.refs`).sort();
    // A copy, run from its own data root and cache, whose store queued that path.
    useDataRoot(join(root, 'B'));
    process.env[MEDIA_CACHE_DIR_ENV] = join(root, 'B', 'cache');
    const store = new LocalConnectorStore({ dbPath: join(root, 'B', 'store.sqlite'), corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal',
      // The original's holder: a copied store carries the same identity.
      mediaHolder: holder as never });
    cleanups.push(() => store.close());
    const db = (store as unknown as { db: Database }).db;
    db.query('INSERT INTO chunk_media_releases (media_sha256, media_path) VALUES (?, ?)').run(original.sha256, original.path);
    (store as unknown as { releaseUnreferencedChunkMedia(): void }).releaseUnreferencedChunkMedia();
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_media_releases').get()).toEqual({ n: 0 });
    expect(existsSync(original.path)).toBe(true);
    expect(readdirSync(`${original.path}.refs`).sort()).toEqual(holds);
  });
});
