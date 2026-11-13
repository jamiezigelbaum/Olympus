// The engine split's front never builds a writable extraction runtime (#1563).
// rc.4's live install failed because four runtimes the front builds (the
// archive lanes' and the child readers of Gmail attachments, Telegram media
// and Evernote) opened the extraction job queue for writing: only the main
// runtime passed `readOnly`, so the front crashed with front_store_write on
// every start. The process role now decides inside the one constructor every
// runtime goes through, so no caller can get it wrong. Synthetic data only.

import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { archiveCorpusId, getArchiveFormat } from '../src/core/archive-formats.ts';
import { forbidWritableStoreOpens, resetStoreWriteGuardForTests } from '../src/core/store-write-guard.ts';
import { createArchiveExtractionRuntime } from '../src/workers/archive-import/extraction-runtime.ts';
import { createChildExtractionRuntime } from '../src/workers/engine/runtime/child-extraction-runtime.ts';
import type { FixtureParentSpec } from './helpers/child-items-fixture.ts';
import { childItemsArchiveHarness, FIXTURE_ARCHIVE_FORMAT } from './support/child-items-archive-harness.ts';

const REPO = join(import.meta.dir, '..');
const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;
const cleanups: Array<() => void> = [];
afterEach(() => {
  resetStoreWriteGuardForTests();
  while (cleanups.length) cleanups.pop()!();
});

function mailbox(): FixtureParentSpec[] {
  return [{
    id: 'm1', subject: 'Flat', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z', body: 'Please find the lease attached.',
    children: [{ key: 'p1', name: 'lease.txt', mimeType: 'text/plain', text: 'The lease term is thirty-seven months.' }],
  }];
}

/** An imported archive whose job queue the background has already created, as on a live install. */
async function backgroundMadeQueue() {
  const h = childItemsArchiveHarness(cleanups);
  const archiveId = h.start();
  await h.importAll(archiveId, mailbox());
  const jobsDbPath = join(h.base, 'file-extraction-jobs.sqlite');
  const background = createArchiveExtractionRuntime({ runtime: h.runtime, env: h.env, jobsDbPath, warn: () => {} });
  expect(background.runner()).toBeDefined();
  background.close();
  return { h, jobsDbPath };
}

describe('the front role builds read-only extraction runtimes', () => {
  test('the archive lanes\' runtime, built with no read-only flag, opens the queue read-only in the front', async () => {
    const { h, jobsDbPath } = await backgroundMadeQueue();
    forbidWritableStoreOpens();
    const front = createArchiveExtractionRuntime({ runtime: h.runtime, env: h.env, jobsDbPath, warn: () => {} });
    cleanups.push(() => front.close());
    // On rc.4 this threw: "The engine front opened a extraction job store for writing".
    expect(front.runner()).toBeDefined();
    expect(front.corpusIds()).toEqual([archiveCorpusId('secure_local', format.family)]);
  });

  test('a source\'s child runtime (Gmail attachments, Telegram media, Evernote) opens the queue read-only in the front', async () => {
    const { h, jobsDbPath } = await backgroundMadeQueue();
    const lane = h.runtime.lane(format.family);
    const stores = lane.set.openStores();
    forbidWritableStoreOpens();
    const runtime = createChildExtractionRuntime({
      provider: 'fixture-children',
      scopeKey: 'fixture-scope',
      corpusIds: stores.map((store) => store.corpusId),
      stores,
      set: lane.set,
      accountScope: () => 'personal',
      connector: () => undefined,
      env: h.env,
      jobsDbPath,
      warn: () => {},
    });
    cleanups.push(() => runtime?.close());
    expect(runtime).toBeDefined();
  });

  test('no front starts before the background made the queue: there is nothing to read, and nothing is created', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    await h.importAll(archiveId, mailbox());
    forbidWritableStoreOpens();
    const front = createArchiveExtractionRuntime({ runtime: h.runtime, env: h.env, jobsDbPath: join(h.base, 'absent.sqlite'), warn: () => {} });
    cleanups.push(() => front.close());
    expect(front.runner()).toBeUndefined();
  });
});

describe('one constructor decides', () => {
  // Every writable open of the queue goes through createFileExtractionRuntime,
  // which takes read-only from the process role. A second construction site
  // would need its own role check, the mistake rc.4 shipped four times.
  test('the extraction job queue is constructed in exactly one place', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    walk(join(REPO, 'src'));
    const sites = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/new LocalFileExtractionJobStore\(/g)].map(() => relative(REPO, file));
    });
    expect(sites).toEqual(['src/workers/engine/runtime/file-extraction-runtime.ts']);
    const runtime = readFileSync(join(REPO, 'src/workers/engine/runtime/file-extraction-runtime.ts'), 'utf8');
    expect(runtime).toContain('const readOnly = options.readOnly === true || writableStoreOpensForbidden();');
  });
});
