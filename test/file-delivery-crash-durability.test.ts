// The completed audit record is the sole idempotency commit record: a retry
// that finds one returns success without ever looking at the target. So the
// payload has to be durable before that record is appended, or a crash in
// between leaves Olympus permanently reporting a delivery whose bytes -- or
// whose directory entry -- never reached the disk.
//
// Crash ordering cannot be exercised in-process. What is pinned here is the
// commit protocol itself: a single durable-write path that both write modes go
// through, an overwrite that lands by atomic rename rather than by truncating
// the destination in place, and a parent-directory flush after each.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  LocalFileDeliveryService,
  type FileDeliveryRootPolicy,
} from '../src/workers/file-delivery/index.ts';

const DELIVERY_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'src', 'workers', 'file-delivery', 'index.ts'),
  'utf8',
);

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('file delivery commits the payload before the audit claims it', () => {
  test('an approved overwrite replaces the destination by rename, not in place', async () => {
    const root = makeRoot({ allowOverwrite: true });
    const service = new LocalFileDeliveryService([root]);
    const target = join(root.path, 'notes.md');
    writeFileSync(target, 'existing', { mode: 0o640 });
    const before = statSync(target);

    const result = await service.deliver({
      root_id: 'olympus_smoke',
      relative_path: 'notes.md',
      content: 'replacement',
      write_mode: 'overwrite_with_approval',
      trust_domain: 'internal',
      idempotency_key: 'overwrite-durable',
      approval_id: 'approval-1',
    });

    const after = statSync(target);
    expect(result).toMatchObject({ write_mode: 'overwrite_with_approval', bytes_written: 11 });
    expect(readFileSync(target, 'utf8')).toBe('replacement');
    // A truncate-in-place write keeps the inode; only a staged file published by
    // rename can be fsynced before it becomes the destination.
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o640);
    expect(readdirSync(root.path).filter((entry) => entry.includes('.tmp'))).toEqual([]);
    expect(readFileSync(root.auditPath!, 'utf8')).toContain('"phase":"completed"');
  });

  test('a failed overwrite leaves the destination and the audit untouched', async () => {
    const root = makeRoot({ allowOverwrite: true });
    const service = new LocalFileDeliveryService([root]);
    const target = join(root.path, 'notes.md');
    writeFileSync(target, 'existing', { mode: 0o600 });

    await expect(service.deliver({
      root_id: 'olympus_smoke',
      relative_path: 'notes.md',
      content: 'replacement',
      write_mode: 'overwrite_with_approval',
      trust_domain: 'internal',
      idempotency_key: 'overwrite-unapproved',
    })).rejects.toThrow('requires an explicit approval_id');

    expect(readFileSync(target, 'utf8')).toBe('existing');
    expect(readdirSync(root.path).filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  test('create_new still refuses an existing destination and leaves no staging file', async () => {
    const root = makeRoot({ allowOverwrite: false });
    const service = new LocalFileDeliveryService([root]);
    writeFileSync(join(root.path, 'notes.md'), 'existing');

    await expect(service.deliver({
      root_id: 'olympus_smoke',
      relative_path: 'notes.md',
      content: 'replacement',
      write_mode: 'create_new',
      trust_domain: 'internal',
      idempotency_key: 'create-existing',
    })).rejects.toThrow('Destination file already exists');

    expect(readFileSync(join(root.path, 'notes.md'), 'utf8')).toBe('existing');
    expect(readdirSync(root.path).filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  test('a delivery into a created subdirectory lands with its parents', async () => {
    const root = makeRoot({ allowOverwrite: false });
    const service = new LocalFileDeliveryService([root]);

    await service.deliver({
      root_id: 'olympus_smoke',
      relative_path: 'reports/2026/august.md',
      content: 'monthly',
      write_mode: 'create_new',
      trust_domain: 'internal',
      idempotency_key: 'nested-create',
    });

    expect(readFileSync(join(root.path, 'reports/2026/august.md'), 'utf8')).toBe('monthly');
    expect(readFileSync(root.auditPath!, 'utf8')).toContain('"phase":"completed"');
  });

  test('both write modes publish through the one flushing commit path', () => {
    // Both payload writes go through the durable-write function, that function
    // flushes the directory holding the published name, and nothing writes the
    // destination around it.
    expect(DELIVERY_SOURCE.match(/await writeDeliveredPayload\(/g)).toHaveLength(2);
    expect(DELIVERY_SOURCE).toContain('await syncDirectory(prepared.parentPath)');
    expect(DELIVERY_SOURCE).not.toContain('await writeFile(prepared.targetPath');
  });

  test('the ledger publishes its own name as durably as the payload does', async () => {
    // The ledger is the commit record the payload write was hardened for, so
    // its own directory entry has to be flushed too: fsyncing the record into a
    // file whose name never reached the disk loses every delivery made to that
    // root, and the next retry re-runs a create_new that now 409s. The creating
    // path is the only one that publishes a name, so it is the one that flushes.
    const sink = DELIVERY_SOURCE.match(/async function ensureAuditSink\([\s\S]*?\n}/)?.[0];
    expect(sink).toBeDefined();
    expect(sink).toContain('await syncDirectory(dirname(auditPath))');

    // ...and the first delivery to a fresh root still lands, ledger included.
    const root = makeRoot({ allowOverwrite: false });
    const service = new LocalFileDeliveryService([root]);
    await service.deliver({
      root_id: 'olympus_smoke',
      relative_path: 'notes.md',
      content: 'first',
      write_mode: 'create_new',
      trust_domain: 'internal',
      idempotency_key: 'ledger-durable',
    });

    expect(readFileSync(root.auditPath!, 'utf8')).toContain('"phase":"completed"');
  });
});

function makeRoot(options: { allowOverwrite: boolean }): FileDeliveryRootPolicy {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-file-durability-root-'));
  temporaryRoots.push(dir);
  return {
    rootId: 'olympus_smoke',
    path: dir,
    allowedTrustDomains: ['internal'],
    allowedExtensions: ['.md', '.txt'],
    maxBytes: 1000,
    allowParentCreate: true,
    allowDotfiles: false,
    allowOverwrite: options.allowOverwrite,
    auditPath: join(dir, 'audit.jsonl'),
  };
}
