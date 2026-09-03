// jobs.json holds each job's status, payment receipt and settledSpend latch —
// the only record that a settlement already happened, re-read on every poll of
// the same handle. A rename is atomic with respect to a concurrent reader and
// says nothing at all about a power loss: without the data flush before it and
// the directory flush after it, the rename can be reordered ahead of the bytes
// and the file comes back empty, which the loader treats as unrepairable
// corruption. Crash ordering cannot be exercised in-process, so what is pinned
// here is that the publish goes through the shared flushing writer rather than a
// hand-rolled temp-write and rename of its own.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { atomicWritePrivate, readPrivateFile } from '../src/workers/hire-broker/secure-files.ts';

const WRITER_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'src', 'workers', 'hire-broker', 'secure-files.ts'),
  'utf8',
);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('hire broker private state write durability', () => {
  test('publishes through the flushing private-file writer, not a bare rename', () => {
    expect(WRITER_SOURCE.includes('writePrivateFileAtomic'), 'flushing writer used').toBe(true);
    expect(WRITER_SOURCE.includes('rename('), 'no hand-rolled rename').toBe(false);
  });

  test('a write replaces the file at 0600 inside a 0700 directory and leaves no temp behind', async () => {
    const dir = tempDir();
    const stateDir = join(dir, 'hire-broker');
    const path = join(stateDir, 'jobs.json');

    await atomicWritePrivate(path, `${JSON.stringify({ version: 1, jobs: [] })}\n`);
    await atomicWritePrivate(path, `${JSON.stringify({ version: 1, jobs: ['settled'] })}\n`);

    expect(readdirSync(stateDir)).toEqual(['jobs.json']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse((await readPrivateFile(path))!)).toEqual({ version: 1, jobs: ['settled'] });
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-hire-broker-durability-'));
  dirs.push(dir);
  return dir;
}
