import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  createCastorWorkspaceWorker,
  LocalCastorWorkspaceService,
  MacOsAliasResolver,
  type CastorWorkspaceAliasResolver,
  type CastorWorkspaceCommandRunner,
} from '../src/workers/castor-workspace/index.ts';

describe('Castor Workspace worker', () => {
  test('lists, reads, writes, and deletes inside a delegated root', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    try {
      writeFileSync(join(dir, 'hello.txt'), 'hello Castor');
      const service = new LocalCastorWorkspaceService([rootPolicy(dir, auditPath)], undefined, noopAliasResolver());

      const listed = await service.handle({
        action: 'list',
        root_id: 'castor_workspace',
        relative_path: '',
      });
      expect(listed).toMatchObject({
        kind: 'castor_workspace_list',
        root_id: 'castor_workspace',
        policy: { castor_workspace_delegated: true, shell_exposed_to_agent: false },
      });
      expect(JSON.stringify(listed)).toContain('hello.txt');
      expect(JSON.stringify(listed)).not.toContain(dir);

      const read = await service.handle({
        action: 'read',
        root_id: 'castor_workspace',
        relative_path: 'hello.txt',
      });
      expect(read).toMatchObject({
        kind: 'castor_workspace_read',
        content: 'hello Castor',
        content_encoding: 'utf8',
      });

      const written = await service.handle({
        action: 'write',
        root_id: 'castor_workspace',
        relative_path: 'notes/output.md',
        content: '# Done\n',
        idempotency_key: 'write-1',
      });
      expect(written).toMatchObject({ kind: 'castor_workspace_write', bytes_written: 7 });
      expect(await readFile(join(dir, 'notes/output.md'), 'utf8')).toBe('# Done\n');

      const deleted = await service.handle({
        action: 'delete',
        root_id: 'castor_workspace',
        relative_path: 'notes/output.md',
      });
      expect(deleted).toMatchObject({ kind: 'castor_workspace_delete' });
      expect(existsSync(join(dir, 'notes/output.md'))).toBe(false);
      expect(await readFile(auditPath, 'utf8')).toContain('castor_workspace_audit');
    } finally {
      cleanup();
    }
  });

  test('denies absolute and traversal paths', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    try {
      const service = new LocalCastorWorkspaceService([rootPolicy(dir, auditPath)], undefined, noopAliasResolver());
      await expect(service.handle({
        action: 'list',
        root_id: 'castor_workspace',
        relative_path: '/Users/owner',
      })).rejects.toThrow('Use relative paths');
      await expect(service.handle({
        action: 'list',
        root_id: 'castor_workspace',
        relative_path: '../outside',
      })).rejects.toThrow('traversal');
    } finally {
      cleanup();
    }
  });

  test('exports directories to allowlisted GCS prefixes after dry-run and rejects symlinks', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CastorWorkspaceCommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    };
    try {
      mkdirSync(join(dir, 'books', 'nested'), { recursive: true });
      writeFileSync(join(dir, 'books/a.TXT'), 'book');
      writeFileSync(join(dir, 'books/nested/page.html'), '<p>thread</p>');
      writeFileSync(join(dir, 'books/raw.json'), '{}');
      writeFileSync(join(dir, 'books/image.png'), 'png');
      writeFileSync(join(dir, 'books/.DS_Store'), 'junk');
      writeFileSync(join(dir, 'books/._a.txt'), 'junk');
      writeFileSync(join(dir, 'books/.hidden.md'), 'junk');
      const service = new LocalCastorWorkspaceService([rootPolicy(dir, auditPath)], runner, noopAliasResolver());

      const dryRun = await service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books',
      });
      expect(dryRun).toMatchObject({
        kind: 'castor_workspace_export_gcs',
        dry_run: true,
        include_media: false,
        allowed_extensions: ['md', 'txt', 'pdf', 'html'],
        files: 2,
        bytes: 17,
        uploaded_file_count: 2,
        skipped_file_count: 5,
      });
      expect(dryRun.results).toEqual(expect.arrayContaining([
        {
          status: 'uploaded',
          relative_path: 'books/a.TXT',
          upload_relative_path: 'a.txt',
          bytes: 4,
          gcs_uri: 'gs://fixture-trading-books-rag/trading-books/a.txt',
        },
        {
          status: 'uploaded',
          relative_path: 'books/nested/page.html',
          upload_relative_path: 'nested/page.html',
          bytes: 13,
          gcs_uri: 'gs://fixture-trading-books-rag/trading-books/nested/page.html',
        },
        { status: 'skipped', relative_path: 'books/.DS_Store', reason: 'junk_file', bytes: 4 },
        { status: 'skipped', relative_path: 'books/._a.txt', reason: 'junk_file', bytes: 4 },
        { status: 'skipped', relative_path: 'books/.hidden.md', reason: 'junk_file', bytes: 4 },
        { status: 'skipped', relative_path: 'books/image.png', reason: 'extension_not_allowed:.png', bytes: 3 },
        { status: 'skipped', relative_path: 'books/raw.json', reason: 'extension_not_allowed:.json', bytes: 2 },
      ]));
      expect(calls).toHaveLength(0);

      const exported = await service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books',
        dry_run: false,
      });
      expect(exported).toMatchObject({ dry_run: false });
      expect(calls[0]!.command).toBe('gcloud');
      expect(calls.map((call) => call.args.at(-1))).toEqual([
        'gs://fixture-trading-books-rag/trading-books/a.txt',
        'gs://fixture-trading-books-rag/trading-books/nested/page.html',
      ]);

      const mediaDryRun = await service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books',
        include_media: true,
      });
      expect(mediaDryRun).toMatchObject({
        include_media: true,
        files: 3,
        skipped_file_count: 4,
      });
      expect(mediaDryRun.results).toEqual(expect.arrayContaining([
        {
          status: 'uploaded',
          relative_path: 'books/image.png',
          upload_relative_path: 'image.png',
          bytes: 3,
          gcs_uri: 'gs://fixture-trading-books-rag/trading-books/image.png',
        },
      ]));

      await expect(service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://other-bucket/trading-books',
      })).rejects.toThrow('not in this workspace root allowlist');

      const broadService = new LocalCastorWorkspaceService([
        { ...rootPolicy(dir, auditPath), allowedGcsPrefixes: ['gs://'] },
      ], runner, noopAliasResolver());
      await expect(broadService.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://other-bucket/trading-books',
      })).resolves.toMatchObject({ dry_run: true, files: 2 });

      symlinkSync('/tmp', join(dir, 'books/tmp-link'));
      await expect(service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books',
      })).rejects.toThrow('Export contains symlinks');
    } finally {
      cleanup();
    }
  });

  test('applies the export type filter to single-file exports', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CastorWorkspaceCommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    };
    try {
      writeFileSync(join(dir, 'book.bin'), 'book');
      writeFileSync(join(dir, 'book.txt'), 'book');
      writeFileSync(join(dir, 'cover.png'), 'png');
      const service = new LocalCastorWorkspaceService([rootPolicy(dir, auditPath)], runner, noopAliasResolver());

      await expect(service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'book.bin',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books/book.bin',
        dry_run: false,
      })).rejects.toThrow('not eligible for export_gcs');

      await expect(service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'cover.png',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books/cover.png',
        dry_run: false,
      })).rejects.toThrow('not eligible for export_gcs');
      expect(calls).toHaveLength(0);

      const exported = await service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'book.txt',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books/book.txt',
        dry_run: false,
      });

      expect(exported).toMatchObject({
        kind: 'castor_workspace_export_gcs',
        dry_run: false,
        files: 1,
        bytes: 4,
      });
      expect(exported).not.toHaveProperty('results');
      expect(calls[0]!.command).toBe('gcloud');
      expect(calls[0]!.args.slice(0, 3)).toEqual(['storage', 'cp', '--recursive']);
      expect(calls[0]!.args[3]).toEndWith('/workspace/book.txt');
      expect(calls[0]!.args[4]).toBe('gs://fixture-trading-books-rag/trading-books/book.txt');

      const mediaExported = await service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'cover.png',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books/cover.png',
        include_media: true,
        dry_run: false,
      });
      expect(mediaExported).toMatchObject({ dry_run: false, files: 1, bytes: 3 });
      expect(calls[1]!.args[3]).toEndWith('/workspace/cover.png');
      expect(calls[1]!.args[4]).toBe('gs://fixture-trading-books-rag/trading-books/cover.png');
    } finally {
      cleanup();
    }
  });

  test('requires GCS destination containment on prefix boundaries', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    try {
      mkdirSync(join(dir, 'books'));
      writeFileSync(join(dir, 'books/a.txt'), 'book');
      const service = new LocalCastorWorkspaceService([
        { ...rootPolicy(dir, auditPath), allowedGcsPrefixes: ['gs://fixture-trading-books-rag/staged/governance'] },
      ], undefined, noopAliasResolver());

      await expect(service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://fixture-trading-books-rag/staged/governance-bad',
      })).rejects.toThrow('not in this workspace root allowlist');

      await expect(service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://fixture-trading-books-rag/staged/governance',
      })).resolves.toMatchObject({ dry_run: true, files: 1 });
      await expect(service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://fixture-trading-books-rag/staged/governance/batch-1',
      })).resolves.toMatchObject({ dry_run: true, files: 1 });
    } finally {
      cleanup();
    }
  });

  test('applies maxExportBytes to eligible directory export bytes', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    try {
      mkdirSync(join(dir, 'books'));
      writeFileSync(join(dir, 'books/a.md'), '1234');
      writeFileSync(join(dir, 'books/b.txt'), '5678');
      writeFileSync(join(dir, 'books/.DS_Store'), new Uint8Array(1024));
      const service = new LocalCastorWorkspaceService([
        { ...rootPolicy(dir, auditPath), maxExportBytes: 5 },
      ], undefined, noopAliasResolver());

      await expect(service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books',
      })).rejects.toThrow('export exceeds the configured 5 byte limit');

      const underCapService = new LocalCastorWorkspaceService([
        { ...rootPolicy(dir, auditPath), maxExportBytes: 8 },
      ], undefined, noopAliasResolver());
      await expect(underCapService.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books',
      })).resolves.toMatchObject({ bytes: 8, skipped_file_count: 1 });
    } finally {
      cleanup();
    }
  });

  test('exports to GCS through a configured SSH uploader', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CastorWorkspaceCommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    try {
      mkdirSync(join(dir, 'books'));
      writeFileSync(join(dir, 'books/a.txt'), 'book');
      const service = new LocalCastorWorkspaceService([
        {
          ...rootPolicy(dir, auditPath),
          gcsUploader: {
            mode: 'ssh',
            sshHost: 'private-host',
            remoteStagingPath: '/home/owner/tmp/castor-workspace-gcs',
            cleanupRemote: true,
          },
        },
      ], runner, noopAliasResolver());

      const exported = await service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'books',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books',
        dry_run: false,
      });

      expect(exported).toMatchObject({
        kind: 'castor_workspace_export_gcs',
        dry_run: false,
        gcs_uploader: 'ssh',
        files: 1,
      });
      expect(calls.map((call) => call.command)).toEqual(['ssh', 'ssh', 'rsync', 'ssh', 'ssh']);
      expect(calls[0]!.args[0]).toBe('private-host');
      expect(calls[0]!.args[1]).toContain('mkdir -p');
      expect(calls[1]!.args[1]).toContain('mkdir -p');
      expect(calls[1]!.args[1]).toContain('/source');
      expect(calls[2]!.args[0]).toBe('-a');
      expect(calls[2]!.args[1]).toEndWith('/workspace/books/a.txt');
      expect(calls[2]!.args[2]).toContain('private-host:/home/owner/tmp/castor-workspace-gcs/castor-workspace-');
      expect(calls[3]!.args[1]).toContain('gcloud');
      expect(calls[3]!.args[1]).toContain('storage cp --recursive');
      expect(calls[3]!.args[1]).toContain("'gs://fixture-trading-books-rag/trading-books'");
      expect(calls[4]!.args[1]).toContain('rm -rf');
    } finally {
      cleanup();
    }
  });

  test('serves bounded HTTP responses', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    try {
      const worker = createCastorWorkspaceWorker({ roots: [rootPolicy(dir, auditPath)], aliasResolver: noopAliasResolver() });
      const response = await worker.fetch(new Request('http://worker.test/v1/workspace', {
        method: 'POST',
        body: JSON.stringify({
          action: 'health',
        }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        kind: 'castor_workspace_health',
        policy: { castor_workspace_delegated: true, absolute_path_exposed: false },
      });
    } finally {
      cleanup();
    }
  });

  test('follows delegated aliases for read, list, and export but not write/delete', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    const target = mkdtempSync(join(tmpdir(), 'olympus-castor-alias-target-'));
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CastorWorkspaceCommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    };
    try {
      writeFileSync(join(dir, 'Trading alias'), 'macOS alias bytes');
      mkdirSync(join(target, 'books'));
      writeFileSync(join(target, 'books/a.txt'), 'alias book');
      const aliases = new Map([[realpathSync(join(dir, 'Trading alias')), target]]);
      const service = new LocalCastorWorkspaceService([rootPolicy(dir, auditPath)], runner, mapAliasResolver(aliases));

      const rootList = await service.handle({
        action: 'list',
        root_id: 'castor_workspace',
        relative_path: '',
      });
      expect(rootList).toMatchObject({
        kind: 'castor_workspace_list',
        entries: [
          {
            name: 'Trading alias',
            kind: 'alias',
            alias_access: 'read_only',
          },
        ],
      });
      expect(JSON.stringify(rootList)).not.toContain(target);

      const aliasList = await service.handle({
        action: 'list',
        root_id: 'castor_workspace',
        relative_path: 'Trading alias/books',
      });
      expect(aliasList).toMatchObject({
        kind: 'castor_workspace_list',
        resolved_via_alias: true,
        alias_relative_path: 'Trading alias',
      });
      expect(JSON.stringify(aliasList)).toContain('Trading alias/books/a.txt');
      expect(JSON.stringify(aliasList)).not.toContain(target);

      const aliasRead = await service.handle({
        action: 'read',
        root_id: 'castor_workspace',
        relative_path: 'Trading alias/books/a.txt',
      });
      expect(aliasRead).toMatchObject({
        kind: 'castor_workspace_read',
        resolved_via_alias: true,
        content: 'alias book',
      });

      const dryRun = await service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'Trading alias/books',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books',
      });
      expect(dryRun).toMatchObject({
        kind: 'castor_workspace_export_gcs',
        resolved_via_alias: true,
        dry_run: true,
        files: 1,
      });

      await service.handle({
        action: 'export_gcs',
        root_id: 'castor_workspace',
        relative_path: 'Trading alias/books',
        destination_uri: 'gs://fixture-trading-books-rag/trading-books',
        dry_run: false,
      });
      expect(calls[0]!.args.at(-1)).toBe('gs://fixture-trading-books-rag/trading-books/a.txt');

      await expect(service.handle({
        action: 'write',
        root_id: 'castor_workspace',
        relative_path: 'Trading alias/books/new.txt',
        content: 'no',
      })).rejects.toThrow();

      await expect(service.handle({
        action: 'delete',
        root_id: 'castor_workspace',
        relative_path: 'Trading alias/books/a.txt',
      })).rejects.toThrow();
      expect(existsSync(join(target, 'books/a.txt'))).toBe(true);
    } finally {
      cleanup();
      rmSync(target, { recursive: true, force: true });
    }
  });

  test('macOS alias resolver uses Swift Foundation without Finder scripting', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const resolver = new MacOsAliasResolver({
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: '/resolved/target\n', stderr: '' };
      },
    }, 'darwin', '/usr/bin/swift');

    await expect(resolver.resolveAlias('/workspace/alias')).resolves.toBe('/resolved/target');
    expect(calls[0]!.command).toBe('/usr/bin/swift');
    expect(calls[0]!.args[0]).toBe('-e');
    expect(calls[0]!.args[1]).toContain('URL(resolvingAliasFileAt:');
    expect(calls[0]!.args[2]).toBe('/workspace/alias');
  });

  test('macOS alias resolver is inert off Darwin', async () => {
    const resolver = new MacOsAliasResolver({
      async run() {
        throw new Error('should not run');
      },
    }, 'linux');

    await expect(resolver.resolveAlias('/workspace/alias')).resolves.toBeUndefined();
  });

  test('self-resolving files are not treated as aliases', async () => {
    const { dir, auditPath, cleanup } = workspaceFixture();
    try {
      writeFileSync(join(dir, 'ordinary.txt'), 'plain');
      const service = new LocalCastorWorkspaceService([rootPolicy(dir, auditPath)], undefined, {
        async resolveAlias(path) {
          return path;
        },
      });

      const read = await service.handle({
        action: 'read',
        root_id: 'castor_workspace',
        relative_path: 'ordinary.txt',
      });
      expect(read).toMatchObject({
        kind: 'castor_workspace_read',
        content: 'plain',
      });
      expect(JSON.stringify(read)).not.toContain('resolved_via_alias');

      const listed = await service.handle({
        action: 'list',
        root_id: 'castor_workspace',
        relative_path: '',
      });
      expect(listed).toMatchObject({
        entries: [
          {
            name: 'ordinary.txt',
            kind: 'file',
            bytes: 5,
          },
        ],
      });
    } finally {
      cleanup();
    }
  });
});

function workspaceFixture(): { dir: string; auditPath: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'olympus-castor-workspace-'));
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

function mapAliasResolver(aliases: Map<string, string>): CastorWorkspaceAliasResolver {
  return {
    async resolveAlias(path: string) {
      return aliases.get(path);
    },
  };
}
