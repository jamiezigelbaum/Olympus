// The extraction spool holds raw content (a recording, a part of a message)
// for the length of one read. A read that ends removes its own file; a crash
// leaves it. These tests hold the sweep to what a crash leaves: a file whose
// writing process is gone goes at the next start without waiting a day, a
// folder whose owner has no job goes too, a running process's file and an
// owner that still has jobs stay, and one owner's files can be forgotten
// without touching another's.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { extractionSpoolRoot } from '../src/core/olympus-layout.ts';
import { FORGET_STEPS } from '../src/core/source-forget-registry.ts';
import {
  EXTRACTION_SPOOL_STALE_MS,
  extractionSpoolOwnerDir,
  extractionSpoolOwnerKey,
  forgetExtractionSpool,
  prepareExtractionSpool,
} from '../src/workers/file-extraction/spool.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'extraction-spool-'));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return join(base, 'extraction-spool');
}

/** A process id that has ended: a child that ran and exited. */
function deadPid(): number {
  const child = Bun.spawnSync(['true']);
  return child.pid;
}

function put(dir: string, name: string, ageMs = 0): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  writeFileSync(path, 'raw recording bytes', { mode: 0o600 });
  if (ageMs > 0) {
    const at = new Date(Date.now() - ageMs);
    utimesSync(path, at, at);
  }
  return path;
}

describe('the sweep at start', () => {
  test('a fresh file whose writing process is gone is removed at once, not after a day', () => {
    const spool = root();
    const orphan = put(spool, `spool-${deadPid()}-${Date.now()}-abc`);
    const mine = put(spool, `spool-${process.pid}-${Date.now()}-def`);
    expect(prepareExtractionSpool(spool)).toBe(spool);
    expect(existsSync(orphan)).toBe(false);
    // A running process's file is a read in flight.
    expect(existsSync(mine)).toBe(true);
  });

  test('a file of a dead process under its owner is removed, and a running process\'s is not', () => {
    const spool = root();
    const owner = { corpusId: 'secure_local.archive.mail', accountScope: 'archive-1' };
    const dir = extractionSpoolOwnerDir(spool, owner);
    const orphan = put(dir, `spool-${deadPid()}-${Date.now()}-abc`);
    const mine = put(dir, `spool-${process.pid}-${Date.now()}-def`);
    prepareExtractionSpool(spool, { ownersWithJobs: () => new Set([extractionSpoolOwnerKey(owner)]) });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });

  test('the folder of an owner with no job is removed, even a running process\'s file in it', () => {
    const spool = root();
    const gone = { corpusId: 'secure_local.archive.mail', accountScope: 'archive-removed' };
    const kept = { corpusId: 'secure_local.archive.mail', accountScope: 'archive-reading' };
    const goneFile = put(extractionSpoolOwnerDir(spool, gone), `spool-${process.pid}-${Date.now()}-abc`);
    const keptFile = put(extractionSpoolOwnerDir(spool, kept), `spool-${process.pid}-${Date.now()}-def`);
    prepareExtractionSpool(spool, { ownersWithJobs: () => new Set([extractionSpoolOwnerKey(kept)]) });
    expect(existsSync(goneFile)).toBe(false);
    expect(existsSync(keptFile)).toBe(true);
  });

  test('when the jobs cannot be read, an owner\'s folder stays', () => {
    const spool = root();
    const owner = { corpusId: 'secure_local.archive.mail', accountScope: 'archive-1' };
    const file = put(extractionSpoolOwnerDir(spool, owner), `spool-${process.pid}-${Date.now()}-abc`);
    prepareExtractionSpool(spool, { ownersWithJobs: () => { throw new Error('jobs file locked'); } });
    expect(existsSync(file)).toBe(true);
  });

  test('a file nothing says a writer for is still removed once a day has passed', () => {
    const spool = root();
    const old = put(spool, 'unknown-shape', EXTRACTION_SPOOL_STALE_MS + 60_000);
    const fresh = put(spool, 'unknown-fresh');
    prepareExtractionSpool(spool);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('forgetting an owner\'s files', () => {
  test('one account scope\'s files go and another\'s stay; a dry run counts without removing', () => {
    const spool = root();
    const corpusId = 'secure_local.archive.mail';
    const a = put(extractionSpoolOwnerDir(spool, { corpusId, accountScope: 'archive-a' }), 'spool-1-1-a');
    const b = put(extractionSpoolOwnerDir(spool, { corpusId, accountScope: 'archive-b' }), 'spool-1-1-b');

    expect(forgetExtractionSpool(spool, { corpusIds: [corpusId], accountScopes: ['archive-a'] }, { dryRun: true })).toBe(1);
    expect(existsSync(a)).toBe(true);
    expect(forgetExtractionSpool(spool, { corpusIds: [corpusId], accountScopes: ['archive-a'] })).toBe(1);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    // No account scope given means the whole corpus: a source being removed.
    expect(forgetExtractionSpool(spool, { corpusIds: [corpusId] })).toBe(1);
    expect(readdirSync(spool)).toEqual([]);
  });

  test('another corpus is not touched, and a folder that is not there is nothing to do', () => {
    const spool = root();
    const other = put(extractionSpoolOwnerDir(spool, { corpusId: 'internal.other', accountScope: 'x' }), 'spool-1-1-o');
    expect(forgetExtractionSpool(spool, { corpusIds: ['secure_local.archive.mail'] })).toBe(0);
    expect(existsSync(other)).toBe(true);
    expect(forgetExtractionSpool(join(spool, 'missing'), { corpusIds: ['a'] })).toBe(0);
  });
});

describe('deleting a source forgets its scratch files', () => {
  test('the forget step of the extraction jobs takes the source\'s corpora, and an account-scope forget takes only its scopes', () => {
    const base = mkdtempSync(join(tmpdir(), 'extraction-spool-forget-'));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const env = { HOME: base, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') };
    const spool = extractionSpoolRoot(env);
    const corpusId = 'secure_local.archive.mail';
    const a = put(extractionSpoolOwnerDir(spool, { corpusId, accountScope: 'archive-a' }), 'spool-1-1-a');
    const b = put(extractionSpoolOwnerDir(spool, { corpusId, accountScope: 'archive-b' }), 'spool-1-1-b');
    const other = put(extractionSpoolOwnerDir(spool, { corpusId: 'internal.other', accountScope: 'x' }), 'spool-1-1-o');
    const step = FORGET_STEPS.find((candidate) => candidate.id === 'file-extraction-jobs')!;
    const account = { source_id: 'archive.imports', slot: '1', corpus_ids: [corpusId] } as never;

    // A scoped forget (one archive removed from a family's shared corpus) takes that archive's files only.
    const scoped = step.forgetAccountScopes!(account, ['archive-a'], { env } as never, { dryRun: false });
    expect(scoped.join('\n')).toContain('scratch files: 1');
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);

    // A source delete takes every account scope of its corpora, and nothing of another source's.
    const whole = step.forget(account, { env } as never, { dryRun: false });
    expect(whole.join('\n')).toContain('scratch files: 1');
    expect(existsSync(b)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});
