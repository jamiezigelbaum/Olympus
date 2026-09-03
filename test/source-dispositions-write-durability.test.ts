// The dispositions file is the one piece of configuration whose damage takes
// every ingestion lane down: the reader deliberately throws on bytes it cannot
// parse and the connector stores deliberately do not catch, which is correct for
// a hand-edited file and unacceptable as something a dashboard button did.
//
// A rename is atomic with respect to a concurrent reader and says nothing at all
// about a power loss: without the data flush before it and the directory flush
// after it, the rename can be reordered ahead of the bytes and the file comes
// back empty. Crash ordering cannot be exercised in-process, so what is pinned
// here is that the publish goes through the shared flushing writer rather than a
// hand-rolled temp-write and rename of its own.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, afterEach } from 'bun:test';
import { parseSourceIngestionExclusions } from '../src/core/source-ingestion-exclusions.ts';
import { writeSourceIngestionExclusionsFile } from '../src/workers/source-dispositions.ts';

const WRITER_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'src', 'workers', 'source-dispositions.ts'),
  'utf8',
);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ingestion dispositions publish durability', () => {
  test('publishes through the flushing private-file writer, not a bare rename', () => {
    expect(WRITER_SOURCE.includes('writePrivateFileAtomicSync'), 'flushing writer used').toBe(true);
    expect(WRITER_SOURCE.includes('renameSync'), 'no hand-rolled rename').toBe(false);
  });

  test('a publish replaces the file at 0600, backs the old one up, and leaves no temp behind', () => {
    const dir = tempDir();
    const path = join(dir, 'ingestion-dispositions.json');
    writeFileSync(path, `${JSON.stringify(existingDocument(), null, 2)}\n`, { mode: 0o600 });

    const result = writeSourceIngestionExclusionsFile({ path, document: replacementDocument() });

    expect(readdirSync(dir).filter((entry) => entry.includes('.tmp'))).toEqual([]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(parseSourceIngestionExclusions(JSON.parse(readFileSync(path, 'utf8')), path).rules)
      .toHaveLength(1);
    expect(result.backup_path).toBeDefined();
    expect(statSync(result.backup_path!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(result.backup_path!, 'utf8'))).toEqual(existingDocument());
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-dispositions-durability-'));
  dirs.push(dir);
  return dir;
}

function existingDocument() {
  return {
    schemaVersion: 1,
    rules: [
      { id: 'existing', mode: 'exclude', sources: ['dropbox'], path_prefixes: ['/Private'], reason: 'owner choice' },
    ],
  };
}

function replacementDocument() {
  return parseSourceIngestionExclusions({
    schemaVersion: 1,
    rules: [
      { id: 'replacement', mode: 'metadata_only', sources: ['dropbox'], path_prefixes: ['/Archive'], reason: 'owner choice' },
    ],
  }, 'replacement document');
}
