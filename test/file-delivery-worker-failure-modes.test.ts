import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  LocalFileDeliveryService,
  createFileDeliveryWorker,
  type FileDeliveryRootPolicy,
} from '../src/workers/file-delivery/index.ts';

describe('file delivery failure modes', () => {
  test('keeps host paths out of unexpected filesystem failures', async () => {
    const { root, cleanup } = makeRoot();
    try {
      const worker = createFileDeliveryWorker({ roots: [root] });

      const response = await worker.fetch(new Request('http://worker.test/v1/file/deliver', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          root_id: 'olympus_smoke',
          relative_path: `${'a'.repeat(300)}.md`,
          content: 'hello smoke',
          write_mode: 'create_new',
          trust_domain: 'internal',
          idempotency_key: 'name-too-long',
        }),
      }));
      const payload = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(500);
      expect(JSON.stringify(payload)).not.toContain(root.path);
      expect(payload).toMatchObject({
        error: { code: 'file_delivery_error' },
        policy: { absolute_path_exposed: false },
      });
    } finally {
      cleanup();
    }
  });

  test('survives a torn audit line instead of wedging the delivery lane', async () => {
    const { root, cleanup } = makeRoot();
    try {
      const service = new LocalFileDeliveryService([root]);
      await service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'notes/first.md',
        content: 'first',
        write_mode: 'create_new',
        trust_domain: 'internal',
        idempotency_key: 'torn-first',
      });
      appendFileSync(root.auditPath!, '{"kind":"file_delivery_audit","phase":"comp');

      await expect(service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'notes/second.md',
        content: 'second',
        write_mode: 'dry_run',
        trust_domain: 'internal',
        idempotency_key: 'torn-second',
      })).resolves.toMatchObject({ write_mode: 'dry_run' });

      await expect(service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'notes/first.md',
        content: 'first',
        write_mode: 'create_new',
        trust_domain: 'internal',
        idempotency_key: 'torn-first',
      })).resolves.toMatchObject({ idempotent_replay: true });
    } finally {
      cleanup();
    }
  });

  test('lets a dry run be committed under the same idempotency key', async () => {
    const { root, cleanup } = makeRoot();
    try {
      const service = new LocalFileDeliveryService([root]);
      await service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'notes/smoke.md',
        content: 'hello smoke',
        write_mode: 'dry_run',
        trust_domain: 'internal',
        idempotency_key: 'preview-then-commit',
      });

      const committed = await service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'notes/smoke.md',
        content: 'hello smoke',
        write_mode: 'create_new',
        trust_domain: 'internal',
        idempotency_key: 'preview-then-commit',
      });

      expect(committed).toMatchObject({ write_mode: 'create_new', bytes_written: 11 });
      expect(existsSync(join(root.path, 'notes/smoke.md'))).toBe(true);
      expect(readFileSync(join(root.path, 'notes/smoke.md'), 'utf8')).toBe('hello smoke');
    } finally {
      cleanup();
    }
  });
});

function makeRoot(): { root: FileDeliveryRootPolicy; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-file-failure-root-'));
  return {
    root: {
      rootId: 'olympus_smoke',
      path: dir,
      allowedTrustDomains: ['internal'],
      allowedExtensions: ['.md', '.txt'],
      maxBytes: 1000,
      allowParentCreate: true,
      allowDotfiles: false,
      allowOverwrite: false,
      auditPath: join(dir, 'audit.jsonl'),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
