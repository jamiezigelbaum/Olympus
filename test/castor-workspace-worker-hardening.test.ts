import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  CastorWorkspaceWorkerError,
  LocalCastorWorkspaceService,
  createCastorWorkspaceWorker,
  type CastorWorkspaceAliasResolver,
  type CastorWorkspaceCommandRunner,
} from '../src/workers/castor-workspace/index.ts';

describe('Castor Workspace worker hardening', () => {
  test('refuses to traverse a symlinked directory out of the delegated root', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    const outside = mkdtempSync(join(tmpdir(), 'olympus-castor-outside-'));
    try {
      mkdirSync(join(outside, 'sub'));
      writeFileSync(join(outside, 'secret.txt'), 'outside secret');
      writeFileSync(join(outside, 'sub/keep.txt'), 'keep me');
      symlinkSync(outside, join(dir, 'notes'));
      const service = new LocalCastorWorkspaceService([rootPolicy(dir, auditPath)], undefined, noopAliasResolver());

      await expectWorkerError(service.handle({
        action: 'read',
        root_id: 'castor_workspace',
        relative_path: 'notes/secret.txt',
      }), 'symlink_escape_denied');
      await expectWorkerError(service.handle({
        action: 'list',
        root_id: 'castor_workspace',
        relative_path: 'notes',
      }), 'symlink_escape_denied');
      await expectWorkerError(service.handle({
        action: 'write',
        root_id: 'castor_workspace',
        relative_path: 'notes/planted.md',
        content: 'planted',
      }), 'symlink_escape_denied');
      await expectWorkerError(service.handle({
        action: 'delete',
        root_id: 'castor_workspace',
        relative_path: 'notes/sub',
        recursive: true,
      }), 'symlink_escape_denied');
      await expectWorkerError(service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'notes',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books',
      }), 'symlink_escape_denied');

      expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
      expect(existsSync(join(outside, 'sub/keep.txt'))).toBe(true);
      expect(existsSync(join(outside, 'planted.md'))).toBe(false);

      // The link itself stays deletable: removing it must not follow it.
      await expect(service.handle({
        action: 'delete',
        root_id: 'castor_workspace',
        relative_path: 'notes',
      })).resolves.toMatchObject({ kind: 'castor_workspace_delete' });
      expect(existsSync(join(dir, 'notes'))).toBe(false);
      expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
    } finally {
      cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('keeps host paths out of unexpected filesystem failures', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    try {
      const worker = createCastorWorkspaceWorker({
        roots: [rootPolicy(dir, auditPath)],
        aliasResolver: noopAliasResolver(),
      });

      const response = await worker.fetch(new Request('http://worker.test/v1/workspace', {
        method: 'POST',
        body: JSON.stringify({
          action: 'read',
          root_id: 'castor_workspace',
          relative_path: 'drafts/missing.md',
        }),
      }));
      const payload = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(500);
      expect(JSON.stringify(payload)).not.toContain(dir);
      expect(payload).toMatchObject({
        error: { code: 'castor_workspace_error' },
        policy: { absolute_path_exposed: false },
      });
    } finally {
      cleanup();
    }
  });

  test('refuses a GCS export whose sanitized object keys collide', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CastorWorkspaceCommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    };
    try {
      mkdirSync(join(dir, 'books'));
      writeFileSync(join(dir, 'books/Q1 Report.md'), 'spaced');
      writeFileSync(join(dir, 'books/Q1-Report.md'), 'dashed');
      const service = new LocalCastorWorkspaceService([rootPolicy(dir, auditPath)], runner, noopAliasResolver());

      await expectWorkerError(service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books',
      }), 'gcs_export_name_collision');
      expect(calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('reads a NUL-free but invalid UTF-8 file as base64 rather than lossy text', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    try {
      const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
      writeFileSync(join(dir, 'note.txt'), latin1);
      const service = new LocalCastorWorkspaceService([rootPolicy(dir, auditPath)], undefined, noopAliasResolver());

      const read = await service.handle({
        action: 'read',
        root_id: 'castor_workspace',
        relative_path: 'note.txt',
      });

      expect(read).toMatchObject({
        kind: 'castor_workspace_read',
        content_encoding: 'base64',
        content_sha256: createHash('sha256').update(latin1).digest('hex'),
      });
      expect(Uint8Array.from(Buffer.from(read.content as string, 'base64'))).toEqual(latin1);
    } finally {
      cleanup();
    }
  });
});

async function expectWorkerError(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CastorWorkspaceWorkerError);
  expect((caught as CastorWorkspaceWorkerError).code).toBe(code);
}

function workspaceFixture(): { dir: string; auditPath: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'olympus-castor-hardening-'));
  const dir = join(base, 'workspace');
  mkdirSync(dir);
  return {
    dir,
    auditPath: join(base, 'audit.jsonl'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function rootPolicy(path: string, auditPath: string) {
  return {
    rootId: 'castor_workspace',
    path,
    allowedGcsPrefixes: ['gs://fixture-trading-books-rag'],
    maxReadBytes: 10_485_760,
    maxWriteBytes: 10_485_760,
    maxExportBytes: 10_485_760,
    auditPath,
  };
}

function noopAliasResolver(): CastorWorkspaceAliasResolver {
  return {
    async resolveAlias() {
      return undefined;
    },
  };
}
