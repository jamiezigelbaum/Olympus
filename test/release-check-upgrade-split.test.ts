// The update to a split engine (scripts/release-check/upgrade-split.ts): the copy whose front cannot start must be one the
// candidate's installer accepts, and the store-file count must catch what rc.4's failed update lost (ops#151).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BROKEN_FRONT_LINE, breakFront, brokenBundle, compareStoreFiles, forcedFailureChecks, rehash, repinInstaller, retiredStoreFile, storeFiles, storesKeptCheck, STORES_PUT_BACK, leftoverFiles,
} from '../scripts/release-check/upgrade-split.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rc-upgrade-split-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('the copy whose front cannot start', () => {
  test('the guard goes after the shebang and stops only the front', () => {
    const broken = breakFront('#!/usr/bin/env bun\nmain();\n');
    expect(broken.split('\n')[0]).toBe('#!/usr/bin/env bun');
    expect(broken.split('\n')[1]).toContain("OLYMPUS_WORKER_ENGINE_ROLE === 'front'");
    expect(breakFront('main();\n').startsWith('if (process.env.OLYMPUS_WORKER_ENGINE_ROLE')).toBe(true);
  });

  test('the installer\'s pins and SHA256SUMS are made to match the new tarball, and an installer without pins is refused', () => {
    const text = `#!/bin/sh\nOLYMPUS_VERSION=1.5.0\nOLYMPUS_SHA256=${'0'.repeat(64)}\nOLYMPUS_BYTES=12\nrest\n`;
    expect(repinInstaller(text, 'a'.repeat(64), 99)).toBe(`#!/bin/sh\nOLYMPUS_VERSION=1.5.0\nOLYMPUS_SHA256=${'a'.repeat(64)}\nOLYMPUS_BYTES=99\nrest\n`);
    expect(() => repinInstaller('#!/bin/sh\n', 'a'.repeat(64), 1)).toThrow('no OLYMPUS_SHA256');
    expect(rehash(`${'0'.repeat(64)}  a.tgz\n${'1'.repeat(64)}  other\n`, { 'a.tgz': 'b'.repeat(64) })).toBe(`${'b'.repeat(64)}  a.tgz\n${'1'.repeat(64)}  other\n`);
  });

  test('a bundle copy: the front exits when it would start to serve, not before, the original is untouched, and every pin matches what was written', () => {
    const candidate = join(dir, 'candidate');
    const work = join(dir, 'work');
    mkdirSync(join(work, 'package', 'dist'), { recursive: true });
    mkdirSync(candidate);
    // Boot work first, then the server, as the worker does.
    writeFileSync(join(work, 'package', 'dist', 'cli.js'), '#!/usr/bin/env bun\nconsole.log("booted");\nBun.serve({ port: 0, fetch: () => new Response("") }).stop(true);\nconsole.log("served");\n');
    expect(Bun.spawnSync(['tar', '-czf', join(candidate, 'olympus-1.5.0.tgz'), '-C', work, 'package']).exitCode).toBe(0);
    writeFileSync(join(candidate, 'install-linux.sh'), `#!/bin/sh\nOLYMPUS_SHA256=${sha(join(candidate, 'olympus-1.5.0.tgz'))}\nOLYMPUS_BYTES=1\n`);
    writeFileSync(join(candidate, 'SHA256SUMS'), `${sha(join(candidate, 'olympus-1.5.0.tgz'))}  olympus-1.5.0.tgz\n${sha(join(candidate, 'install-linux.sh'))}  install-linux.sh\n`);
    const originalSums = readFileSync(join(candidate, 'SHA256SUMS'), 'utf8');

    const broken = brokenBundle(candidate, join(dir, 'out'));
    expect(readFileSync(join(candidate, 'SHA256SUMS'), 'utf8')).toBe(originalSums);
    const tgz = join(broken, 'olympus-1.5.0.tgz');
    const installer = readFileSync(join(broken, 'install-linux.sh'), 'utf8');
    expect(installer).toContain(`OLYMPUS_SHA256=${sha(tgz)}`);
    expect(installer).toContain(`OLYMPUS_BYTES=${readFileSync(tgz).length}`);
    expect(readFileSync(join(broken, 'SHA256SUMS'), 'utf8')).toBe(`${sha(tgz)}  olympus-1.5.0.tgz\n${sha(join(broken, 'install-linux.sh'))}  install-linux.sh\n`);
    const unpacked = join(dir, 'unpacked');
    mkdirSync(unpacked);
    expect(Bun.spawnSync(['tar', '-xzf', tgz, '-C', unpacked]).exitCode).toBe(0);
    const entry = join(unpacked, 'package', 'dist', 'cli.js');
    const front = Bun.spawnSync([process.execPath, entry], { env: { ...process.env, OLYMPUS_WORKER_ENGINE_ROLE: 'front' }, stdout: 'pipe', stderr: 'pipe' });
    expect(front.exitCode).toBe(70);
    expect(front.stdout.toString()).toBe('booted\n');
    expect(front.stderr.toString()).toContain(BROKEN_FRONT_LINE);
    const background = Bun.spawnSync([process.execPath, entry], { env: { ...process.env, OLYMPUS_WORKER_ENGINE_ROLE: 'background' }, stdout: 'pipe' });
    expect(background.exitCode).toBe(0);
    expect(background.stdout.toString()).toBe('booted\nserved\n');
  }, 30_000);
});

describe('store files', () => {
  test('stores and ledgers are counted, backups and side files are not; a lost ledger is one missing', () => {
    for (const path of ['stores/gmail.email/internal.sqlite', 'stores/gmail.email/internal.sqlite-wal', 'stores/.tier-ledger.sqlite', 'jobs.db', 'embedding-ledger.jsonl', 'backups/x.sqlite', 'notes.txt']) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), '');
    }
    const before = storeFiles(dir);
    expect(before).toEqual(['embedding-ledger.jsonl', 'jobs.db', 'stores/.tier-ledger.sqlite', 'stores/gmail.email/internal.sqlite']);
    rmSync(join(dir, 'stores/.tier-ledger.sqlite'));
    writeFileSync(join(dir, 'new.sqlite'), '');
    expect(compareStoreFiles(before, storeFiles(dir))).toEqual({ count: 4, missing: 1, retired: 0, extra: 1 });
    expect(storeFiles(join(dir, 'absent'))).toEqual([]);
  });

  test('the pre-filter ledger and weights the candidate retires (#1415) are counted apart: allowed after the update, not after a rollback', () => {
    const ledger = 'classification-ledger.sqlite.embedding-prefilter.tier-ledger.sqlite';
    const weights = 'stores/a.tier-ledger.sqlite.embedding-prefilter/weights.db';
    const before = ['jobs.db', ledger, weights, 'stores/a.tier-ledger.sqlite'];
    const after = { ...compareStoreFiles(before, ['jobs.db', 'stores/a.tier-ledger.sqlite']), leftovers: 0 };
    expect(after).toEqual({ count: 2, missing: 0, retired: 2, extra: 0, leftovers: 0 });
    expect(retiredStoreFile('stores/a.tier-ledger.sqlite')).toBe(false);
    expect(storesKeptCheck(4, after)).toMatchObject({ status: 'pass', detail: '4 before, 2 after: 0 missing, 2 retired on purpose, 0 new, 0 backup, partial or journal file(s) left' });
    expect(storesKeptCheck(4, { ...after, leftovers: 1 })).toMatchObject({ status: 'fail' });
    expect(storesKeptCheck(4, compareStoreFiles(before, ['jobs.db', ledger, weights]))).toMatchObject({ status: 'fail' });
    const rolledBack = forcedFailureChecks({ installer: { failed: true }, frontRan: 1, engine: { ready: true, version: '1.4.4' }, beforeVersion: '1.4.4', storeFiles: { before: 4, after: compareStoreFiles(before, ['jobs.db', ledger, 'stores/a.tier-ledger.sqlite', 'x.db']) } });
    expect(rolledBack[2]).toMatchObject({ status: 'fail', detail: '4 before, 4 after: 0 missing, 1 retired on purpose, 1 new, uncounted backup, partial or journal file(s) left' });
  });

  test('a rolled-back update with the same count but another file in place of a lost one still fails', () => {
    const checks = forcedFailureChecks({ installer: { failed: true, detail: `Fix: ${STORES_PUT_BACK}: gmail.email.` }, frontRan: 1, engine: { ready: true, version: '1.4.4' }, beforeVersion: '1.4.4', storeFiles: { before: 4, after: { count: 4, missing: 1, retired: 0, extra: 1, leftovers: 0 } } });
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['upgrade.forced-failure.installer', 'pass'], ['upgrade.forced-failure.rollback', 'pass'], ['upgrade.forced-failure.stores', 'fail'],
    ]);
    expect(forcedFailureChecks({ installer: { failed: true }, frontRan: 1, engine: { ready: false, detail: 'not ready' }, beforeVersion: '1.4.4' })[1]!.detail).toContain('not ready');
  });

  test('an installer that fails without saying it put the stores back, or leaves a journal behind, fails (L1)', () => {
    const obs = { frontRan: 1, engine: { ready: true, version: '1.4.4' }, beforeVersion: '1.4.4' };
    const silent = forcedFailureChecks({ ...obs, installer: { failed: true, detail: 'driver upgrade failed (exit 1)' }, storeFiles: { before: 4, after: { count: 4, missing: 0, retired: 0, extra: 0, leftovers: 0 } } });
    expect(silent.map((check) => check.status)).toEqual(['fail', 'pass', 'pass']);
    const journal = forcedFailureChecks({ ...obs, installer: { failed: true, detail: `Fix: ${STORES_PUT_BACK}: jobs.` }, storeFiles: { before: 4, after: { count: 4, missing: 0, retired: 0, extra: 0, leftovers: 1 } } });
    expect(journal.map((check) => check.status)).toEqual(['pass', 'pass', 'fail']);
  });

  test('backups, partial copies and journals are counted as leftovers, stores are not', () => {
    for (const path of ['stores/a.sqlite', 'stores/a.sqlite.pre-schema-12.bak', 'stores/b.sqlite.partial-1', 'jobs.db-journal', 'jobs.db']) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), '');
    }
    expect(leftoverFiles(dir)).toBe(3);
  });

  test('an update that failed before the broken front ever started proves no rollback: every forced-failure check fails', () => {
    const checks = forcedFailureChecks({ installer: { failed: true, detail: 'copy failed' }, frontRan: 0, engine: { ready: true, version: '1.4.4' }, beforeVersion: '1.4.4', storeFiles: { before: 4, after: { count: 4, missing: 0, retired: 0, extra: 0 } } });
    expect(checks.map((check) => check.status)).toEqual(['fail', 'fail', 'fail']);
    expect(checks[1]!.detail).toContain('before the broken front started');
  });
});
