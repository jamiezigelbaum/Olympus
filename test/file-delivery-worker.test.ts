import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  LocalFileDeliveryService,
  createFileDeliveryWorker,
  fileDeliveryRootsFromEnv,
  type FileDeliveryRootPolicy,
} from '../src/workers/file-delivery/index.ts';

describe('LocalFileDeliveryService', () => {
  test('dry-runs a bounded delivery without writing the destination file', async () => {
    const { root, cleanup } = makeRoot();
    try {
      const service = new LocalFileDeliveryService([root]);

      const result = await service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'notes/smoke.md',
        content: 'hello smoke',
        write_mode: 'dry_run',
        trust_domain: 'internal',
        idempotency_key: 'dry-run-1',
        actor_id: 'castor',
      });

      expect(result).toMatchObject({
        root_id: 'olympus_smoke',
        relative_path: 'notes/smoke.md',
        bytes_written: 0,
        write_mode: 'dry_run',
        approval_status: 'dry_run',
        policy: {
          bounded_file_delivery: true,
          shell_used: false,
          absolute_path_exposed: false,
        },
      });
      expect(existsSync(join(root.path, 'notes/smoke.md'))).toBe(false);
      expect(readAudit(root)).toContain('dry-run-1');
    } finally {
      cleanup();
    }
  });

  test('creates a new file, writes an audit record, and replays idempotent retries', async () => {
    const { root, cleanup } = makeRoot();
    try {
      const service = new LocalFileDeliveryService([root]);

      const result = await service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'notes/smoke.md',
        content: 'hello smoke',
        write_mode: 'create_new',
        trust_domain: 'internal',
        idempotency_key: 'create-1',
        session_id: 'session-1',
        model_provider: 'olympus-local',
        model_id: 'qwen-local',
      });
      const replay = await service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'notes/smoke.md',
        content: 'hello smoke',
        write_mode: 'create_new',
        trust_domain: 'internal',
        idempotency_key: 'create-1',
      });

      expect(readFileSync(join(root.path, 'notes/smoke.md'), 'utf8')).toBe('hello smoke');
      expect(result.bytes_written).toBe(11);
      expect(result.audit_ref).toBe(`file_delivery:${result.delivery_id}`);
      expect(replay).toMatchObject({
        delivery_id: result.delivery_id,
        idempotent_replay: true,
      });
      const audit = readAudit(root);
      expect(audit).toContain('"phase":"completed"');
      expect(audit).toContain('"session_id":"session-1"');
      expect(audit).toContain('"model_provider":"olympus-local"');
    } finally {
      cleanup();
    }
  });

  test('denies absolute paths, traversal, dotfiles, executable extensions, and trust-domain mismatch', async () => {
    const { root, cleanup } = makeRoot();
    try {
      const service = new LocalFileDeliveryService([root]);

      await expect(service.deliver({
        root_id: 'olympus_smoke',
        relative_path: '/tmp/nope.md',
        content: 'nope',
        write_mode: 'dry_run',
        trust_domain: 'internal',
        idempotency_key: 'absolute',
      })).rejects.toThrow('relative_path must not be absolute');

      await expect(service.deliver({
        root_id: 'olympus_smoke',
        relative_path: '../nope.md',
        content: 'nope',
        write_mode: 'dry_run',
        trust_domain: 'internal',
        idempotency_key: 'traversal',
      })).rejects.toThrow('relative_path must point to a file below the approved root');

      await expect(service.deliver({
        root_id: 'olympus_smoke',
        relative_path: '.secret.md',
        content: 'nope',
        write_mode: 'dry_run',
        trust_domain: 'internal',
        idempotency_key: 'dotfile',
      })).rejects.toThrow('Dotfile paths are not allowed');

      await expect(service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'script.sh',
        content: 'echo nope',
        write_mode: 'dry_run',
        trust_domain: 'internal',
        idempotency_key: 'script',
      })).rejects.toThrow('Executable file extensions are denied');

      await expect(service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'secret.md',
        content: 'nope',
        write_mode: 'dry_run',
        trust_domain: 'secure_local',
        idempotency_key: 'trust',
      })).rejects.toThrow('trust_domain is not allowed');
    } finally {
      cleanup();
    }
  });

  test('refuses overwrite without an explicit approved overwrite policy', async () => {
    const { root, cleanup } = makeRoot();
    try {
      const service = new LocalFileDeliveryService([root]);
      writeFileSync(join(root.path, 'notes.md'), 'existing');

      await expect(service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'notes.md',
        content: 'new',
        write_mode: 'create_new',
        trust_domain: 'internal',
        idempotency_key: 'existing-create',
      })).rejects.toThrow('Destination file already exists');

      await expect(service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'notes.md',
        content: 'new',
        write_mode: 'overwrite_with_approval',
        trust_domain: 'internal',
        idempotency_key: 'existing-overwrite',
      })).rejects.toThrow('requires an explicit approval_id');
    } finally {
      cleanup();
    }
  });

  test('denies symlink parent escapes', async () => {
    const { root, cleanup } = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), 'olympus-file-outside-'));
    try {
      const service = new LocalFileDeliveryService([root]);
      symlinkSync(outside, join(root.path, 'escape'));

      await expect(service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'escape/nope.md',
        content: 'nope',
        write_mode: 'create_new',
        trust_domain: 'internal',
        idempotency_key: 'symlink',
      })).rejects.toThrow('Symlink parent directories are not allowed');
    } finally {
      cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('denies symlink root policies', async () => {
    const { root, cleanup } = makeRoot();
    const symlinkRoot = `${root.path}-link`;
    try {
      symlinkSync(root.path, symlinkRoot);
      const service = new LocalFileDeliveryService([{
        ...root,
        path: symlinkRoot,
        auditPath: join(root.path, 'symlink-root-audit.jsonl'),
      }]);

      await expect(service.deliver({
        root_id: 'olympus_smoke',
        relative_path: 'notes/nope.md',
        content: 'nope',
        write_mode: 'dry_run',
        trust_domain: 'internal',
        idempotency_key: 'symlink-root',
      })).rejects.toThrow('Configured root must not be a symlink');
    } finally {
      rmSync(symlinkRoot, { force: true });
      cleanup();
    }
  });
});

describe('file delivery worker HTTP surface', () => {
  test('serves health and delivery without exposing root paths', async () => {
    const { root, cleanup } = makeRoot();
    try {
      const worker = createFileDeliveryWorker({ roots: [root] });

      const health = await worker.fetch(new Request('http://worker.test/v1/health'));
      expect(await health.json()).toMatchObject({
        configured: true,
        roots: [{
          root_id: 'olympus_smoke',
          allowed_trust_domains: ['internal'],
        }],
        policy: {
          bounded_file_delivery: true,
          shell_used: false,
          absolute_path_exposed: false,
        },
      });

      const delivery = await worker.fetch(new Request('http://worker.test/v1/file/deliver', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          root_id: 'olympus_smoke',
          relative_path: 'notes/smoke.md',
          content: 'hello smoke',
          write_mode: 'create_new',
          trust_domain: 'internal',
          idempotency_key: 'http-create',
        }),
      }));
      const payload = await delivery.json() as Record<string, unknown>;

      expect(delivery.status).toBe(200);
      expect(JSON.stringify(payload)).not.toContain(root.path);
      expect(payload).toMatchObject({
        kind: 'file_delivery_result',
        root_id: 'olympus_smoke',
        relative_path: 'notes/smoke.md',
      });
    } finally {
      cleanup();
    }
  });

  test('parses root policies from env JSON without baking private paths into repo config', () => {
    const roots = fileDeliveryRootsFromEnv({
      OLYMPUS_FILE_DELIVERY_ROOTS_JSON: JSON.stringify({
        olympus_smoke: {
          path: '/tmp/olympus-smoke',
          allowed_trust_domains: ['internal'],
          allowed_extensions: ['.md', '.txt'],
          max_bytes: 1000,
          allow_parent_create: true,
        },
      }),
    });

    expect(roots).toEqual([{
      rootId: 'olympus_smoke',
      path: '/tmp/olympus-smoke',
      allowedTrustDomains: ['internal'],
      allowedExtensions: ['.md', '.txt'],
      maxBytes: 1000,
      allowParentCreate: true,
      allowDotfiles: false,
      allowOverwrite: false,
    }]);
  });
});

function makeRoot(): { root: FileDeliveryRootPolicy; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-file-root-'));
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

function readAudit(root: FileDeliveryRootPolicy): string {
  return readFileSync(root.auditPath!, 'utf8');
}
