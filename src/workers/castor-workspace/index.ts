import { appendFile, mkdir, open, readFile, readdir, realpath, rm, stat, lstat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type CastorWorkspaceAction = 'health' | 'list' | 'read' | 'write' | 'delete' | 'export_gcs';
export type CastorWorkspaceContentEncoding = 'utf8' | 'base64';

const EXPORT_GCS_ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.html']);
const EXPORT_GCS_MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.mp4', '.mov', '.webm']);

export interface CastorWorkspaceRootPolicy {
  rootId: string;
  path: string;
  allowedGcsPrefixes?: string[];
  gcsUploader?: CastorWorkspaceGcsUploaderPolicy;
  allowAliases?: boolean;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxExportBytes: number;
  auditPath?: string;
}

export interface CastorWorkspaceGcsUploaderPolicy {
  mode: 'local' | 'ssh';
  sshHost?: string;
  remoteStagingPath?: string;
  sshCommand?: string;
  rsyncCommand?: string;
  gcloudCommand?: string;
  cleanupRemote?: boolean;
}

export interface CastorWorkspaceRequest {
  action: CastorWorkspaceAction;
  root_id?: string;
  relative_path?: string;
  content?: string;
  content_encoding?: CastorWorkspaceContentEncoding;
  destination_uri?: string;
  recursive?: boolean;
  dry_run?: boolean;
  include_media?: boolean;
  idempotency_key?: string;
  actor_id?: string;
  session_id?: string;
}

export interface CastorWorkspaceCommandRunner {
  run(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface CastorWorkspaceAliasResolver {
  resolveAlias(path: string): Promise<string | undefined>;
}

interface PreparedPath {
  root: CastorWorkspaceRootPolicy;
  rootRealPath: string;
  relativePath: string;
  targetPath: string;
  access: 'workspace' | 'alias_target';
  aliasRelativePath?: string;
}

interface WorkspaceEntry {
  name: string;
  relative_path: string;
  kind: 'file' | 'directory' | 'alias' | 'symlink' | 'other';
  bytes?: number;
  alias_access?: 'read_only';
  modified_at?: string;
}

interface WorkspaceScan {
  files: number;
  directories: number;
  bytes: number;
  symlinks: string[];
}

interface ExportGcsUploadedFile {
  status: 'uploaded';
  relative_path: string;
  upload_relative_path: string;
  bytes: number;
  gcs_uri: string;
}

interface ExportGcsSkippedFile {
  status: 'skipped';
  relative_path: string;
  reason: string;
  bytes: number;
}

interface ExportGcsPlan {
  sourceIsDirectory: boolean;
  files: number;
  directories: number;
  bytes: number;
  symlinks: string[];
  uploaded: Array<ExportGcsUploadedFile & { absolutePath: string }>;
  skipped: ExportGcsSkippedFile[];
}

interface AuditRecord {
  kind: 'castor_workspace_audit';
  action: CastorWorkspaceAction;
  root_id?: string;
  relative_path?: string;
  destination_uri?: string;
  dry_run?: boolean;
  recursive?: boolean;
  bytes?: number;
  sha256?: string;
  resolved_via_alias?: boolean;
  alias_relative_path?: string;
  idempotency_key?: string;
  actor_id?: string;
  session_id?: string;
  created_at: string;
}

export class CastorWorkspaceWorkerError extends Error {
  status: number;
  code: string;
  suggestion?: string;

  constructor(status: number, code: string, message: string, suggestion?: string) {
    super(message);
    this.status = status;
    this.code = code;
    if (suggestion !== undefined) this.suggestion = suggestion;
  }
}

export class LocalCastorWorkspaceService {
  private roots: Map<string, CastorWorkspaceRootPolicy>;
  private runner: CastorWorkspaceCommandRunner;
  private aliasResolver: CastorWorkspaceAliasResolver;

  constructor(
    roots: CastorWorkspaceRootPolicy[],
    runner: CastorWorkspaceCommandRunner = new BunCommandRunner(),
    aliasResolver: CastorWorkspaceAliasResolver = new MacOsAliasResolver(runner),
  ) {
    this.roots = new Map(roots.map((root) => [root.rootId, normalizeRootPolicy(root)]));
    this.runner = runner;
    this.aliasResolver = aliasResolver;
  }

  async handle(request: CastorWorkspaceRequest): Promise<Record<string, unknown>> {
    if (request.action === 'health') return this.health();
    const prepared = await this.prepare(request.root_id, request.relative_path ?? '', request.action);
    if (request.action === 'list') return this.list(prepared);
    if (request.action === 'read') return this.read(prepared);
    if (request.action === 'write') return this.write(prepared, request);
    if (request.action === 'delete') return this.delete(prepared, request);
    if (request.action === 'export_gcs') return this.exportGcs(prepared, request);
    throw new CastorWorkspaceWorkerError(400, 'invalid_action', 'Unsupported delegated workspace action.');
  }

  health(): Record<string, unknown> {
    return {
      kind: 'castor_workspace_health',
      configured: this.roots.size > 0,
      roots: [...this.roots.values()].map((root) => ({
        root_id: root.rootId,
        allowed_gcs_prefixes: root.allowedGcsPrefixes ?? [],
        gcs_uploader: root.gcsUploader?.mode ?? 'local',
        aliases: root.allowAliases === true ? 'read_only' : 'disabled',
        max_read_bytes: root.maxReadBytes,
        max_write_bytes: root.maxWriteBytes,
        max_export_bytes: root.maxExportBytes,
      })),
      policy: workspacePolicy(),
      ...(this.roots.size === 0 ? { detail: 'No delegated workspace roots are configured.' } : {}),
    };
  }

  private async list(prepared: PreparedPath): Promise<Record<string, unknown>> {
    const entries = await readdir(prepared.targetPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOTDIR') {
        throw new CastorWorkspaceWorkerError(400, 'not_a_directory', 'relative_path is not a directory.');
      }
      throw error;
    });
    const rows: WorkspaceEntry[] = [];
    for (const entry of entries) {
      const childRelative = prepared.relativePath ? `${prepared.relativePath}/${entry.name}` : entry.name;
      const childPath = resolve(prepared.targetPath, entry.name);
      const childStat = await lstat(childPath);
      const resolvedAliasTarget = childStat.isFile() && prepared.root.allowAliases === true
        ? await this.aliasResolver.resolveAlias(childPath)
        : undefined;
      const aliasTarget = resolvedAliasTarget && await realpath(childPath) !== await realpath(resolvedAliasTarget)
        ? resolvedAliasTarget
        : undefined;
      rows.push({
        name: entry.name,
        relative_path: childRelative,
        kind: aliasTarget ? 'alias' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
        ...(entry.isFile() && !aliasTarget ? { bytes: childStat.size } : {}),
        ...(aliasTarget ? { alias_access: 'read_only' as const } : {}),
        modified_at: childStat.mtime.toISOString(),
      });
    }
    return {
      kind: 'castor_workspace_list',
      root_id: prepared.root.rootId,
      relative_path: prepared.relativePath,
      ...(prepared.access === 'alias_target' ? { resolved_via_alias: true, alias_relative_path: prepared.aliasRelativePath } : {}),
      entries: rows.sort((a, b) => a.relative_path.localeCompare(b.relative_path)),
      policy: workspacePolicy(),
    };
  }

  private async read(prepared: PreparedPath): Promise<Record<string, unknown>> {
    await assertNotSymlink(prepared.targetPath);
    const info = await stat(prepared.targetPath);
    if (!info.isFile()) {
      throw new CastorWorkspaceWorkerError(400, 'not_a_file', 'relative_path is not a file.');
    }
    if (info.size > prepared.root.maxReadBytes) {
      throw new CastorWorkspaceWorkerError(413, 'file_too_large', `file exceeds the configured ${prepared.root.maxReadBytes} byte read limit.`);
    }
    const bytes = await readFile(prepared.targetPath);
    const utf8 = isUtf8(bytes);
    const text = utf8 ? bytes.toString('utf8') : bytes.toString('base64');
    return {
      kind: 'castor_workspace_read',
      root_id: prepared.root.rootId,
      relative_path: prepared.relativePath,
      ...(prepared.access === 'alias_target' ? { resolved_via_alias: true, alias_relative_path: prepared.aliasRelativePath } : {}),
      bytes: bytes.byteLength,
      content_sha256: sha256(bytes),
      content_encoding: utf8 ? 'utf8' : 'base64',
      content: text,
      policy: workspacePolicy(),
    };
  }

  private async write(prepared: PreparedPath, request: CastorWorkspaceRequest): Promise<Record<string, unknown>> {
    assertWritableWorkspacePath(prepared);
    const content = decodeContent(requiredContent(request.content), request.content_encoding ?? 'utf8');
    if (content.byteLength > prepared.root.maxWriteBytes) {
      throw new CastorWorkspaceWorkerError(413, 'content_too_large', `content exceeds the configured ${prepared.root.maxWriteBytes} byte write limit.`);
    }
    await mkdir(dirname(prepared.targetPath), { recursive: true });
    await writeFile(prepared.targetPath, content, { mode: 0o600 });
    await appendAudit(prepared.root, {
      kind: 'castor_workspace_audit',
      action: 'write',
      root_id: prepared.root.rootId,
      relative_path: prepared.relativePath,
      bytes: content.byteLength,
      sha256: sha256(content),
      ...auditIdentity(request),
      created_at: new Date().toISOString(),
    });
    return {
      kind: 'castor_workspace_write',
      root_id: prepared.root.rootId,
      relative_path: prepared.relativePath,
      bytes_written: content.byteLength,
      content_sha256: sha256(content),
      policy: workspacePolicy(),
    };
  }

  private async delete(prepared: PreparedPath, request: CastorWorkspaceRequest): Promise<Record<string, unknown>> {
    assertWritableWorkspacePath(prepared);
    if (!prepared.relativePath) {
      throw new CastorWorkspaceWorkerError(400, 'root_delete_denied', 'Delete a child path inside the workspace, not the workspace root itself.');
    }
    const info = await lstat(prepared.targetPath);
    if (info.isDirectory() && request.recursive !== true) {
      throw new CastorWorkspaceWorkerError(400, 'recursive_required', 'Set recursive=true to delete a directory.');
    }
    await rm(prepared.targetPath, { recursive: info.isDirectory(), force: false });
    await appendAudit(prepared.root, {
      kind: 'castor_workspace_audit',
      action: 'delete',
      root_id: prepared.root.rootId,
      relative_path: prepared.relativePath,
      ...(request.recursive !== undefined ? { recursive: request.recursive } : {}),
      ...auditIdentity(request),
      created_at: new Date().toISOString(),
    });
    return {
      kind: 'castor_workspace_delete',
      root_id: prepared.root.rootId,
      relative_path: prepared.relativePath,
      recursive: request.recursive === true,
      policy: workspacePolicy(),
    };
  }

  private async exportGcs(prepared: PreparedPath, request: CastorWorkspaceRequest): Promise<Record<string, unknown>> {
    await assertNotSymlink(prepared.targetPath);
    const destinationUri = requiredString(request.destination_uri, 'destination_uri');
    assertGcsDestinationAllowed(prepared.root, destinationUri);
    const includeMedia = request.include_media === true;
    const plan = await planGcsExport(prepared, destinationUri, includeMedia);
    if (plan.symlinks.length > 0) {
      throw new CastorWorkspaceWorkerError(
        400,
        'symlink_export_denied',
        'Export contains symlinks. Remove symlinks from the delegated workspace before export.',
      );
    }
    if (plan.bytes > prepared.root.maxExportBytes) {
      throw new CastorWorkspaceWorkerError(413, 'export_too_large', `export exceeds the configured ${prepared.root.maxExportBytes} byte limit.`);
    }
    const dryRun = request.dry_run !== false;
    const gcsUploader = prepared.root.gcsUploader?.mode ?? 'local';
    if (!dryRun) {
      await this.runGcsExport(prepared, destinationUri, plan);
    }
    await appendAudit(prepared.root, {
      kind: 'castor_workspace_audit',
      action: 'export_gcs',
      root_id: prepared.root.rootId,
      relative_path: prepared.relativePath,
      destination_uri: destinationUri,
      ...(prepared.access === 'alias_target' ? { resolved_via_alias: true, alias_relative_path: prepared.aliasRelativePath } : {}),
      dry_run: dryRun,
      recursive: true,
      bytes: plan.bytes,
      ...auditIdentity(request),
      created_at: new Date().toISOString(),
    });
    const results = plan.sourceIsDirectory
      ? [...plan.uploaded.map(({ absolutePath: _absolutePath, ...file }) => file), ...plan.skipped]
        .sort((left, right) => left.relative_path.localeCompare(right.relative_path))
      : undefined;
    return {
      kind: 'castor_workspace_export_gcs',
      root_id: prepared.root.rootId,
      relative_path: prepared.relativePath,
      destination_uri: destinationUri,
      ...(prepared.access === 'alias_target' ? { resolved_via_alias: true, alias_relative_path: prepared.aliasRelativePath } : {}),
      dry_run: dryRun,
      gcs_uploader: gcsUploader,
      files: plan.files,
      directories: plan.directories,
      bytes: plan.bytes,
      ...(plan.sourceIsDirectory ? {
        include_media: includeMedia,
        allowed_extensions: [...allowedExportGcsExtensions(includeMedia)].map((extension) => extension.slice(1)),
        uploaded_file_count: plan.uploaded.length,
        skipped_file_count: plan.skipped.length,
        results,
      } : {}),
      policy: workspacePolicy(),
    };
  }

  private async runGcsExport(prepared: PreparedPath, destinationUri: string, plan: ExportGcsPlan): Promise<void> {
    const uploader = prepared.root.gcsUploader ?? { mode: 'local' as const };
    if (plan.sourceIsDirectory && plan.uploaded.length === 0) return;
    if (uploader.mode === 'local') {
      if (!plan.sourceIsDirectory) {
        const command = await this.runner.run(uploader.gcloudCommand ?? 'gcloud', ['storage', 'cp', '--recursive', prepared.targetPath, destinationUri]);
        if (command.exitCode !== 0) {
          throw new CastorWorkspaceWorkerError(502, 'gcs_export_failed', command.stderr || command.stdout || 'gcloud storage cp failed.');
        }
        return;
      }
      for (const file of plan.uploaded) {
        const command = await this.runner.run(uploader.gcloudCommand ?? 'gcloud', ['storage', 'cp', file.absolutePath, file.gcs_uri]);
        if (command.exitCode !== 0) {
          throw new CastorWorkspaceWorkerError(502, 'gcs_export_failed', command.stderr || command.stdout || 'gcloud storage cp failed.');
        }
      }
      return;
    }

    const sshHost = requiredRootConfigString(uploader.sshHost, 'gcs_uploader.ssh_host');
    const remoteStagingRoot = requiredRootConfigString(uploader.remoteStagingPath, 'gcs_uploader.remote_staging_path').replace(/\/+$/, '');
    const sshCommand = uploader.sshCommand ?? 'ssh';
    const rsyncCommand = uploader.rsyncCommand ?? 'rsync';
    const gcloudCommand = uploader.gcloudCommand ?? 'gcloud';
    const remoteRunId = `${Date.now()}-${randomUUID()}`;
    const remoteBase = `${remoteStagingRoot}/castor-workspace-${remoteRunId}`;
    const sourceInfo = await stat(prepared.targetPath);
    const remoteSource = sourceInfo.isDirectory()
      ? `${remoteBase}/source`
      : `${remoteBase}/${basename(prepared.targetPath)}`;

    await this.runRemoteOrThrow(sshCommand, sshHost, `mkdir -p ${shellQuote(sourceInfo.isDirectory() ? remoteSource : remoteBase)}`, 'gcs_remote_stage_failed');
    if (plan.sourceIsDirectory) {
      for (const file of plan.uploaded) {
        const remoteFile = `${remoteSource}/${file.upload_relative_path}`;
        await this.runRemoteOrThrow(sshCommand, sshHost, `mkdir -p ${shellQuote(dirname(remoteFile))}`, 'gcs_remote_stage_failed');
        const rsync = await this.runner.run(rsyncCommand, ['-a', file.absolutePath, `${sshHost}:${remoteFile}`]);
        if (rsync.exitCode !== 0) {
          throw new CastorWorkspaceWorkerError(502, 'gcs_remote_stage_failed', rsync.stderr || rsync.stdout || 'remote GCS staging failed.');
        }
      }
    } else {
      const rsync = await this.runner.run(rsyncCommand, ['-a', prepared.targetPath, `${sshHost}:${remoteBase}/`]);
      if (rsync.exitCode !== 0) {
        throw new CastorWorkspaceWorkerError(502, 'gcs_remote_stage_failed', rsync.stderr || rsync.stdout || 'remote GCS staging failed.');
      }
    }

    try {
      await this.runRemoteOrThrow(
        sshCommand,
        sshHost,
        `${shellQuote(gcloudCommand)} storage cp --recursive ${shellQuote(remoteSource)} ${shellQuote(destinationUri)}`,
        'gcs_export_failed',
      );
    } finally {
      if (uploader.cleanupRemote === true) {
        await this.runner.run(sshCommand, [sshHost, `rm -rf ${shellQuote(remoteBase)}`]);
      }
    }
  }

  private async runRemoteOrThrow(sshCommand: string, sshHost: string, command: string, code: string): Promise<void> {
    const result = await this.runner.run(sshCommand, [sshHost, command]);
    if (result.exitCode !== 0) {
      throw new CastorWorkspaceWorkerError(502, code, result.stderr || result.stdout || 'remote GCS command failed.');
    }
  }

  private async prepare(rootId: string | undefined, inputRelativePath: string, action: CastorWorkspaceAction): Promise<PreparedPath> {
    const root = this.roots.get(requiredString(rootId, 'root_id'));
    if (!root) {
      throw new CastorWorkspaceWorkerError(400, 'unknown_root', 'root_id is not an approved delegated workspace root.');
    }
    const rootRealPath = await realpath(root.path);
    const relativePath = normalizeRelativePath(inputRelativePath);
    // isSubpath below is string arithmetic and cannot see a symlinked
    // component, so the walk has to run before anything touches the path.
    // delete keeps its final segment: removing a stray link is unlinking it.
    await assertNoSymlinkedSegments(rootRealPath, relativePath, action === 'delete');
    if (shouldFollowAliases(action) && root.allowAliases === true) {
      const aliasPrepared = await this.resolveAliasPath(root, rootRealPath, relativePath);
      if (aliasPrepared) return aliasPrepared;
    }
    const targetPath = resolve(rootRealPath, relativePath);
    if (!isSubpath(rootRealPath, targetPath) || targetPath === dirname(rootRealPath)) {
      throw new CastorWorkspaceWorkerError(400, 'path_escape_denied', 'relative_path escapes the delegated workspace root.');
    }
    return { root, rootRealPath, relativePath, targetPath, access: 'workspace' };
  }

  private async resolveAliasPath(
    root: CastorWorkspaceRootPolicy,
    rootRealPath: string,
    relativePath: string,
  ): Promise<PreparedPath | undefined> {
    if (!relativePath) return undefined;
    const parts = relativePath.split('/').filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const prefix = parts.slice(0, index + 1).join('/');
      const candidate = resolve(rootRealPath, prefix);
      if (!isSubpath(rootRealPath, candidate)) {
        throw new CastorWorkspaceWorkerError(400, 'path_escape_denied', 'relative_path escapes the delegated workspace root.');
      }
      const aliasTarget = await this.aliasResolver.resolveAlias(candidate);
      if (!aliasTarget) continue;
      const candidateRealPath = await realpath(candidate);
      const aliasTargetRealPath = await realpath(aliasTarget);
      if (candidateRealPath === aliasTargetRealPath) continue;
      const remaining = parts.slice(index + 1);
      const targetPath = resolve(aliasTargetRealPath, ...remaining);
      if (!isSubpath(aliasTargetRealPath, targetPath)) {
        throw new CastorWorkspaceWorkerError(400, 'alias_path_escape_denied', 'alias-relative path escapes the resolved alias target.');
      }
      await assertNoSymlinkedSegments(aliasTargetRealPath, remaining.join('/'), false);
      return {
        root,
        rootRealPath,
        relativePath,
        targetPath,
        access: 'alias_target',
        aliasRelativePath: prefix,
      };
    }
    return undefined;
  }
}

export function createCastorWorkspaceWorker(options: {
  roots?: CastorWorkspaceRootPolicy[];
  runner?: CastorWorkspaceCommandRunner;
  aliasResolver?: CastorWorkspaceAliasResolver;
  basePath?: string;
} = {}): { fetch(request: Request): Promise<Response> } {
  const service = new LocalCastorWorkspaceService(options.roots ?? [], options.runner, options.aliasResolver);
  const basePath = normalizeBasePath(options.basePath ?? '/v1');
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === `${basePath}/health`) {
          return json(service.health());
        }
        if (request.method === 'POST' && url.pathname === `${basePath}/workspace`) {
          const body = await parseWorkspaceRequest(request);
          return json(await service.handle(body));
        }
        return json({ error: { code: 'not_found', message: 'Delegated workspace route not found.' }, policy: workspacePolicy() }, 404);
      } catch (error) {
        if (error instanceof CastorWorkspaceWorkerError) {
          return json({
            error: {
              code: error.code,
              message: error.message,
              ...(error.suggestion ? { suggestion: error.suggestion } : {}),
            },
            policy: workspacePolicy(),
          }, error.status);
        }
        // Raw fs rejections embed the absolute path in `message`, which is
        // exactly what absolute_path_exposed: false promises to withhold.
        // Only the errno survives.
        const errno = errnoCode(error);
        return json({
          error: {
            code: 'castor_workspace_error',
            message: 'Delegated workspace operation failed on the host filesystem.',
            ...(errno ? { detail: `errno ${errno}` } : {}),
          },
          policy: workspacePolicy(),
        }, 500);
      }
    },
  };
}

export function castorWorkspaceRootsFromEnv(env: Record<string, string | undefined> = process.env): CastorWorkspaceRootPolicy[] {
  const raw = env.OLYMPUS_CASTOR_WORKSPACE_ROOTS_JSON?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed.map((value) => asRecord(value, 'root'))
    : Object.entries(asRecord(parsed, 'OLYMPUS_CASTOR_WORKSPACE_ROOTS_JSON')).map(([rootId, value]) => ({
      root_id: rootId,
      ...asRecord(value, `root ${rootId}`),
    }));
  return entries.map(rootPolicyFromRecord);
}

async function parseWorkspaceRequest(request: Request): Promise<CastorWorkspaceRequest> {
  const record = asRecord(await request.json(), 'body');
  return {
    action: asAction(record.action),
    ...(typeof record.root_id === 'string' ? { root_id: record.root_id } : {}),
    ...(typeof record.relative_path === 'string' ? { relative_path: record.relative_path } : {}),
    ...(typeof record.content === 'string' ? { content: record.content } : {}),
    ...(record.content_encoding === 'base64' || record.content_encoding === 'utf8' ? { content_encoding: record.content_encoding } : {}),
    ...(typeof record.destination_uri === 'string' ? { destination_uri: record.destination_uri } : {}),
    ...(typeof record.recursive === 'boolean' ? { recursive: record.recursive } : {}),
    ...(typeof record.dry_run === 'boolean' ? { dry_run: record.dry_run } : {}),
    ...(typeof record.include_media === 'boolean' ? { include_media: record.include_media } : {}),
    ...(typeof record.idempotency_key === 'string' ? { idempotency_key: record.idempotency_key } : {}),
    ...(typeof record.actor_id === 'string' ? { actor_id: record.actor_id } : {}),
    ...(typeof record.session_id === 'string' ? { session_id: record.session_id } : {}),
  };
}

class BunCommandRunner implements CastorWorkspaceCommandRunner {
  async run(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  }
}

export class MacOsAliasResolver implements CastorWorkspaceAliasResolver {
  private runner: CastorWorkspaceCommandRunner;
  private platform: NodeJS.Platform;
  private swiftCommand: string;

  constructor(runner: CastorWorkspaceCommandRunner, platform: NodeJS.Platform = process.platform, swiftCommand = '/usr/bin/swift') {
    this.runner = runner;
    this.platform = platform;
    this.swiftCommand = swiftCommand;
  }

  async resolveAlias(path: string): Promise<string | undefined> {
    if (this.platform !== 'darwin') return undefined;
    const script = [
      'import Foundation',
      'let path = CommandLine.arguments[1]',
      'let url = URL(fileURLWithPath: path)',
      'do {',
      '  let resolved = try URL(resolvingAliasFileAt: url, options: [])',
      '  print(resolved.path)',
      '} catch {',
      '  print("")',
      '}',
    ].join('\n');
    const result = await this.runner.run(this.swiftCommand, ['-e', script, path]);
    if (result.exitCode !== 0) return undefined;
    const resolved = result.stdout.trim();
    return resolved ? resolved : undefined;
  }
}

async function scanPath(path: string): Promise<WorkspaceScan> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    return { files: 0, directories: 0, bytes: 0, symlinks: [basename(path)] };
  }
  if (info.isFile()) {
    return { files: 1, directories: 0, bytes: info.size, symlinks: [] };
  }
  if (!info.isDirectory()) {
    return { files: 0, directories: 0, bytes: 0, symlinks: [] };
  }
  const result: WorkspaceScan = { files: 0, directories: 1, bytes: 0, symlinks: [] };
  const entries = await readdir(path);
  for (const entry of entries) {
    const nested = await scanPath(join(path, entry));
    result.files += nested.files;
    result.directories += nested.directories;
    result.bytes += nested.bytes;
    result.symlinks.push(...nested.symlinks.map((value) => `${entry}/${value}`));
  }
  return result;
}

async function planGcsExport(prepared: PreparedPath, destinationUri: string, includeMedia: boolean): Promise<ExportGcsPlan> {
  const info = await lstat(prepared.targetPath);
  const normalizedDestination = normalizeGcsPrefix(destinationUri);
  const allowedExtensions = allowedExportGcsExtensions(includeMedia);
  if (!info.isDirectory()) {
    if (!info.isFile()) {
      throw new CastorWorkspaceWorkerError(400, 'not_exportable', 'relative_path must be a file or directory.');
    }
    const relativePath = prepared.relativePath || basename(prepared.targetPath);
    const skippedReason = exportGcsSkipReason(relativePath, allowedExtensions);
    if (skippedReason) {
      throw new CastorWorkspaceWorkerError(
        400,
        'gcs_export_file_type_denied',
        `relative_path is not eligible for export_gcs (${skippedReason}). Use md/txt/pdf/html, or set include_media=true for supported media files.`,
      );
    }
    return {
      sourceIsDirectory: false,
      files: 1,
      directories: 0,
      bytes: info.size,
      symlinks: [],
      uploaded: [{
        status: 'uploaded',
        relative_path: relativePath,
        upload_relative_path: basename(prepared.targetPath),
        absolutePath: prepared.targetPath,
        bytes: info.size,
        gcs_uri: normalizedDestination,
      }],
      skipped: [],
    };
  }

  const collected = await collectExportGcsFiles(prepared.targetPath, prepared.targetPath);
  const uploaded: Array<ExportGcsUploadedFile & { absolutePath: string }> = [];
  const skipped: ExportGcsSkippedFile[] = [];
  // Sanitized object keys are lossy, so distinct sources can land on one key
  // and the later upload would silently replace the earlier one.
  const uploadKeys = new Map<string, string>();
  let bytes = 0;
  for (const file of collected.files) {
    const relativePath = prepared.relativePath ? `${prepared.relativePath}/${file.uploadRelativePath}` : file.uploadRelativePath;
    const skippedReason = exportGcsSkipReason(file.uploadRelativePath, allowedExtensions);
    if (skippedReason) {
      skipped.push({
        status: 'skipped',
        relative_path: relativePath,
        reason: skippedReason,
        bytes: file.bytes,
      });
      continue;
    }
    const uploadRelativePath = safeGcsRelativePath(file.uploadRelativePath);
    const collision = uploadKeys.get(uploadRelativePath);
    if (collision !== undefined) {
      throw new CastorWorkspaceWorkerError(
        400,
        'gcs_export_name_collision',
        `"${relativePath}" and "${collision}" both export to object key "${uploadRelativePath}". Rename one before export.`,
      );
    }
    uploadKeys.set(uploadRelativePath, relativePath);
    bytes += file.bytes;
    uploaded.push({
      status: 'uploaded',
      relative_path: relativePath,
      upload_relative_path: uploadRelativePath,
      absolutePath: file.absolutePath,
      bytes: file.bytes,
      gcs_uri: `${normalizedDestination}/${uploadRelativePath}`,
    });
  }
  uploaded.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  skipped.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  return {
    sourceIsDirectory: true,
    files: uploaded.length,
    directories: collected.directories,
    bytes,
    symlinks: collected.symlinks,
    uploaded,
    skipped,
  };
}

async function collectExportGcsFiles(rootPath: string, directoryPath: string): Promise<{
  directories: number;
  files: Array<{ absolutePath: string; uploadRelativePath: string; bytes: number }>;
  symlinks: string[];
}> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const result: {
    directories: number;
    files: Array<{ absolutePath: string; uploadRelativePath: string; bytes: number }>;
    symlinks: string[];
  } = { directories: 1, files: [], symlinks: [] };
  for (const entry of entries) {
    const absolutePath = join(directoryPath, entry.name);
    const relativePath = toPortableRelativePath(rootPath, absolutePath);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      result.symlinks.push(relativePath);
    } else if (info.isDirectory()) {
      const nested = await collectExportGcsFiles(rootPath, absolutePath);
      result.directories += nested.directories;
      result.files.push(...nested.files);
      result.symlinks.push(...nested.symlinks);
    } else if (info.isFile()) {
      result.files.push({ absolutePath, uploadRelativePath: relativePath, bytes: info.size });
    }
  }
  result.files.sort((left, right) => left.uploadRelativePath.localeCompare(right.uploadRelativePath));
  result.symlinks.sort();
  return result;
}

function allowedExportGcsExtensions(includeMedia: boolean): Set<string> {
  return includeMedia
    ? new Set([...EXPORT_GCS_ALLOWED_EXTENSIONS, ...EXPORT_GCS_MEDIA_EXTENSIONS])
    : new Set(EXPORT_GCS_ALLOWED_EXTENSIONS);
}

function exportGcsSkipReason(relativePath: string, allowedExtensions: Set<string>): string | undefined {
  if (isJunkExportGcsPath(relativePath)) return 'junk_file';
  const extension = extname(relativePath).toLowerCase();
  if (!allowedExtensions.has(extension)) return `extension_not_allowed:${extension || '<none>'}`;
  return undefined;
}

function isJunkExportGcsPath(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => (
    segment === '.DS_Store'
    || segment.startsWith('._')
    || (segment.startsWith('.') && segment.length > 1)
  ));
}

function safeGcsRelativePath(relativePath: string): string {
  return relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => safeGcsObjectSegment(segment))
    .join('/');
}

function safeGcsObjectSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'object';
}

function toPortableRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split(sep).join('/');
}

function assertWritableWorkspacePath(prepared: PreparedPath): void {
  if (prepared.access === 'alias_target') {
    throw new CastorWorkspaceWorkerError(
      403,
      'alias_target_write_denied',
      'Alias targets are read/export-only. Write or delete the alias file itself, or move/copy the real folder into delegated workfiles.',
    );
  }
}

async function assertNotSymlink(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new CastorWorkspaceWorkerError(400, 'symlink_denied', 'Delegated workspace does not follow symlinks.');
  }
}

async function assertNoSymlinkedSegments(
  basePath: string,
  relativePath: string,
  allowFinalSegment: boolean,
): Promise<void> {
  const segments = relativePath.split('/').filter(Boolean);
  let current = basePath;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    if (allowFinalSegment && index === segments.length - 1) return;
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      // The remainder does not exist yet, so nothing further can be a link.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new CastorWorkspaceWorkerError(403, 'symlink_escape_denied', 'Delegated workspace does not follow symlinks.');
    }
  }
}

function rootPolicyFromRecord(record: Record<string, unknown>): CastorWorkspaceRootPolicy {
  const allowedGcsPrefixes = optionalStringArray(record.allowed_gcs_prefixes ?? record.allowedGcsPrefixes);
  const auditPath = typeof record.audit_path === 'string' ? record.audit_path : undefined;
  const allowAliases = optionalBoolean(record.allow_aliases ?? record.allowAliases) ?? true;
  const gcsUploader = gcsUploaderFromRecord(record.gcs_uploader ?? record.gcsUploader);
  return {
    rootId: requiredString(record.root_id ?? record.rootId, 'root_id'),
    path: requiredString(record.path, 'path'),
    ...(allowedGcsPrefixes !== undefined ? { allowedGcsPrefixes } : {}),
    ...(gcsUploader !== undefined ? { gcsUploader } : {}),
    allowAliases,
    maxReadBytes: optionalPositiveInteger(record.max_read_bytes ?? record.maxReadBytes) ?? 10_485_760,
    maxWriteBytes: optionalPositiveInteger(record.max_write_bytes ?? record.maxWriteBytes) ?? 104_857_600,
    maxExportBytes: optionalPositiveInteger(record.max_export_bytes ?? record.maxExportBytes) ?? 107_374_182_400,
    ...(auditPath !== undefined ? { auditPath } : {}),
  };
}

function normalizeRootPolicy(root: CastorWorkspaceRootPolicy): CastorWorkspaceRootPolicy {
  if (!root.rootId.trim()) {
    throw new CastorWorkspaceWorkerError(500, 'invalid_root_config', 'Root policy has an empty rootId.');
  }
  if (!isAbsolute(root.path)) {
    throw new CastorWorkspaceWorkerError(500, 'invalid_root_config', `Root ${root.rootId} path must be absolute.`);
  }
  const allowedGcsPrefixes = root.allowedGcsPrefixes?.map(normalizeGcsPrefix);
  const gcsUploader = normalizeGcsUploader(root.gcsUploader);
  return {
    ...root,
    allowAliases: root.allowAliases ?? true,
    ...(allowedGcsPrefixes !== undefined ? { allowedGcsPrefixes } : {}),
    ...(gcsUploader !== undefined ? { gcsUploader } : {}),
  };
}

function auditIdentity(request: CastorWorkspaceRequest): Partial<AuditRecord> {
  return {
    ...(request.idempotency_key !== undefined ? { idempotency_key: request.idempotency_key } : {}),
    ...(request.actor_id !== undefined ? { actor_id: request.actor_id } : {}),
    ...(request.session_id !== undefined ? { session_id: request.session_id } : {}),
  };
}

function normalizeRelativePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (isAbsolute(trimmed)) {
    throw new CastorWorkspaceWorkerError(400, 'absolute_path_denied', 'Use relative paths inside the delegated workspace root.');
  }
  const normalized = trimmed.replaceAll('\\', '/').split('/').filter(Boolean).join('/');
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
    throw new CastorWorkspaceWorkerError(400, 'path_traversal_denied', 'relative_path may not contain traversal.');
  }
  return normalized;
}

function shouldFollowAliases(action: CastorWorkspaceAction): boolean {
  return action === 'list' || action === 'read' || action === 'export_gcs';
}

function assertGcsDestinationAllowed(root: CastorWorkspaceRootPolicy, destinationUri: string): void {
  const normalized = normalizeGcsPrefix(destinationUri);
  if (!normalized.startsWith('gs://')) {
    throw new CastorWorkspaceWorkerError(400, 'invalid_gcs_destination', 'destination_uri must be a gs:// URI.');
  }
  const allowed = root.allowedGcsPrefixes ?? [];
  if (allowed.length === 0 || !allowed.some((prefix) => gcsUriIsInsidePrefix(normalized, prefix))) {
    throw new CastorWorkspaceWorkerError(403, 'gcs_destination_denied', 'destination_uri is not in this workspace root allowlist.');
  }
}

function gcsUriIsInsidePrefix(uri: string, prefix: string): boolean {
  return prefix === 'gs://' || uri === prefix || uri.startsWith(`${prefix}/`);
}

function normalizeGcsPrefix(value: string): string {
  const trimmed = value.trim();
  if (/^gs:\/{2,}$/.test(trimmed) || trimmed === 'gs:') return 'gs://';
  return trimmed.replace(/\/+$/, '');
}

function decodeContent(value: string, encoding: CastorWorkspaceContentEncoding): Uint8Array {
  if (encoding === 'utf8') return new TextEncoder().encode(value);
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

function isUtf8(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  // A NUL scan alone lets invalid byte sequences through, and toString('utf8')
  // would then map them to U+FFFD while still reporting the original digest.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

async function appendAudit(root: CastorWorkspaceRootPolicy, record: AuditRecord): Promise<void> {
  const auditPath = root.auditPath;
  if (!auditPath) return;
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function workspacePolicy(): {
  castor_workspace_delegated: true;
  shell_exposed_to_agent: false;
  absolute_path_exposed: false;
} {
  return {
    castor_workspace_delegated: true,
    shell_exposed_to_agent: false,
    absolute_path_exposed: false,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isSubpath(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function asAction(value: unknown): CastorWorkspaceAction {
  if (
    value === 'health'
    || value === 'list'
    || value === 'read'
    || value === 'write'
    || value === 'delete'
    || value === 'export_gcs'
  ) {
    return value;
  }
  throw new CastorWorkspaceWorkerError(400, 'invalid_action', 'action must be health, list, read, write, delete, or export_gcs.');
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new CastorWorkspaceWorkerError(400, 'invalid_request', `${name} must be a non-empty string.`);
}

function requiredContent(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new CastorWorkspaceWorkerError(400, 'invalid_request', 'content must be a string.');
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new CastorWorkspaceWorkerError(500, 'invalid_root_config', 'allowed_gcs_prefixes must be an array of strings.');
  }
  return value.map((item) => item.trim());
}

function gcsUploaderFromRecord(value: unknown): CastorWorkspaceGcsUploaderPolicy | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, 'gcs_uploader');
  const mode = requiredString(record.mode, 'gcs_uploader.mode');
  if (mode !== 'local' && mode !== 'ssh') {
    throw new CastorWorkspaceWorkerError(500, 'invalid_root_config', 'gcs_uploader.mode must be local or ssh.');
  }
  const sshHost = optionalString(record.ssh_host ?? record.sshHost);
  const remoteStagingPath = optionalString(record.remote_staging_path ?? record.remoteStagingPath);
  const sshCommand = optionalString(record.ssh_command ?? record.sshCommand);
  const rsyncCommand = optionalString(record.rsync_command ?? record.rsyncCommand);
  const gcloudCommand = optionalString(record.gcloud_command ?? record.gcloudCommand);
  const cleanupRemote = optionalBoolean(record.cleanup_remote ?? record.cleanupRemote);
  return {
    mode,
    ...(sshHost !== undefined ? { sshHost } : {}),
    ...(remoteStagingPath !== undefined ? { remoteStagingPath } : {}),
    ...(sshCommand !== undefined ? { sshCommand } : {}),
    ...(rsyncCommand !== undefined ? { rsyncCommand } : {}),
    ...(gcloudCommand !== undefined ? { gcloudCommand } : {}),
    ...(cleanupRemote !== undefined ? { cleanupRemote } : {}),
  };
}

function normalizeGcsUploader(value: CastorWorkspaceGcsUploaderPolicy | undefined): CastorWorkspaceGcsUploaderPolicy | undefined {
  if (value === undefined) return undefined;
  if (value.mode === 'local') return value;
  if (value.mode !== 'ssh') {
    throw new CastorWorkspaceWorkerError(500, 'invalid_root_config', 'gcs_uploader.mode must be local or ssh.');
  }
  if (!value.sshHost?.trim()) {
    throw new CastorWorkspaceWorkerError(500, 'invalid_root_config', 'gcs_uploader.sshHost is required for ssh mode.');
  }
  if (!value.remoteStagingPath?.trim() || !value.remoteStagingPath.startsWith('/')) {
    throw new CastorWorkspaceWorkerError(500, 'invalid_root_config', 'gcs_uploader.remoteStagingPath must be an absolute path for ssh mode.');
  }
  return {
    ...value,
    sshHost: value.sshHost.trim(),
    remoteStagingPath: value.remoteStagingPath.trim().replace(/\/+$/, ''),
  };
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new CastorWorkspaceWorkerError(500, 'invalid_root_config', 'optional string config values must be non-empty strings.');
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new CastorWorkspaceWorkerError(500, 'invalid_root_config', 'size limits must be positive integers.');
}

function requiredRootConfigString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new CastorWorkspaceWorkerError(500, 'invalid_root_config', `${name} must be configured.`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new CastorWorkspaceWorkerError(500, 'invalid_root_config', 'boolean root options must be booleans.');
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CastorWorkspaceWorkerError(400, 'invalid_request', `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : undefined;
}
