import { mkdir, open, readFile, lstat, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { isUnsupportedDirectorySyncError } from '../../core/atomic-file.ts';

export type FileDeliveryWriteMode = 'dry_run' | 'create_new' | 'overwrite_with_approval';
export type FileDeliveryContentEncoding = 'utf8' | 'base64';
export type FileDeliveryTrustDomain = 'public_safe' | 'internal' | 'secure_local';
export type FileDeliveryApprovalStatus = 'dry_run' | 'not_required' | 'approved';

export interface FileDeliveryRootPolicy {
  rootId: string;
  path: string;
  allowedTrustDomains: FileDeliveryTrustDomain[];
  allowedExtensions?: string[];
  maxBytes: number;
  allowParentCreate: boolean;
  allowDotfiles: boolean;
  allowOverwrite: boolean;
  auditPath?: string;
}

export interface FileDeliveryRequest {
  root_id: string;
  relative_path: string;
  content: string;
  content_encoding?: FileDeliveryContentEncoding;
  write_mode: FileDeliveryWriteMode;
  trust_domain: FileDeliveryTrustDomain;
  source_provenance?: string;
  idempotency_key: string;
  approval_id?: string;
  actor_id?: string;
  session_id?: string;
  model_provider?: string;
  model_id?: string;
}

export interface FileDeliveryResult {
  kind: 'file_delivery_result';
  delivery_id: string;
  root_id: string;
  relative_path: string;
  bytes_written: number;
  content_sha256: string;
  write_mode: FileDeliveryWriteMode;
  created_at: string;
  approval_status: FileDeliveryApprovalStatus;
  audit_ref: string;
  idempotent_replay?: boolean;
  policy: {
    bounded_file_delivery: true;
    shell_used: false;
    absolute_path_exposed: false;
  };
}

interface PreparedDelivery {
  root: FileDeliveryRootPolicy;
  rootRealPath: string;
  normalizedRelativePath: string;
  targetPath: string;
  parentPath: string;
  content: Uint8Array;
  contentSha256: string;
}

interface FileDeliveryAuditRecord {
  kind: 'file_delivery_audit';
  phase: 'dry_run' | 'completed';
  delivery_id: string;
  root_id: string;
  relative_path: string;
  content_sha256: string;
  write_mode: FileDeliveryWriteMode;
  trust_domain: FileDeliveryTrustDomain;
  bytes_written: number;
  approval_status: FileDeliveryApprovalStatus;
  idempotency_key: string;
  created_at: string;
  actor_id?: string;
  session_id?: string;
  model_provider?: string;
  model_id?: string;
  source_provenance?: string;
}

export class FileDeliveryWorkerError extends Error {
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

export class LocalFileDeliveryService {
  private roots: Map<string, FileDeliveryRootPolicy>;

  constructor(roots: FileDeliveryRootPolicy[]) {
    this.roots = new Map(roots.map((root) => [root.rootId, normalizeRootPolicy(root)]));
  }

  health(): {
    reachable: true;
    configured: boolean;
    roots: Array<Record<string, unknown>>;
    policy: FileDeliveryResult['policy'];
    detail?: string;
  } {
    return {
      reachable: true,
      configured: this.roots.size > 0,
      roots: [...this.roots.values()].map((root) => ({
        root_id: root.rootId,
        allowed_trust_domains: root.allowedTrustDomains,
        allowed_extensions: root.allowedExtensions ?? null,
        max_bytes: root.maxBytes,
        allow_parent_create: root.allowParentCreate,
        allow_dotfiles: root.allowDotfiles,
        allow_overwrite: root.allowOverwrite,
      })),
      policy: boundedPolicy(),
      ...(this.roots.size === 0 ? { detail: 'No file-delivery roots are configured.' } : {}),
    };
  }

  async deliver(request: FileDeliveryRequest): Promise<FileDeliveryResult> {
    const prepared = await this.prepare(request);
    const previous = await findCompletedAuditRecord(prepared.root, request.idempotency_key);
    if (previous) {
      assertIdempotencyMatch(previous, request, prepared);
      return resultFromAudit(previous, true);
    }
    await ensureAuditSink(prepared.root);

    if (request.write_mode === 'dry_run') {
      const audit = makeAuditRecord(request, prepared, {
        phase: 'dry_run',
        bytesWritten: 0,
        approvalStatus: 'dry_run',
      });
      await appendAuditRecord(prepared.root, audit);
      return resultFromAudit(audit, false);
    }

    await ensureWritableParent(prepared.rootRealPath, prepared.parentPath, prepared.root.allowParentCreate);

    if (request.write_mode === 'create_new') {
      await writeDeliveredPayload(prepared, { mode: 'create_new' });
      const audit = makeAuditRecord(request, prepared, {
        phase: 'completed',
        bytesWritten: prepared.content.byteLength,
        approvalStatus: 'not_required',
      });
      await appendAuditRecord(prepared.root, audit);
      return resultFromAudit(audit, false);
    }

    const destinationMode = await assertOverwriteApproved(request, prepared);
    await writeDeliveredPayload(prepared, { mode: 'overwrite', fileMode: destinationMode });
    const audit = makeAuditRecord(request, prepared, {
      phase: 'completed',
      bytesWritten: prepared.content.byteLength,
      approvalStatus: 'approved',
    });
    await appendAuditRecord(prepared.root, audit);
    return resultFromAudit(audit, false);
  }

  private async prepare(request: FileDeliveryRequest): Promise<PreparedDelivery> {
    const root = this.roots.get(request.root_id);
    if (!root) {
      throw new FileDeliveryWorkerError(400, 'unknown_root', 'root_id is not an approved file-delivery root.');
    }
    assertRequestShape(request);
    assertTrustDomainAllowed(root, request.trust_domain);
    const normalizedRelativePath = normalizeRelativePath(request.relative_path, root);
    assertExtensionAllowed(normalizedRelativePath, root);
    const content = decodeContent(request.content, request.content_encoding ?? 'utf8');
    if (content.byteLength > root.maxBytes) {
      throw new FileDeliveryWorkerError(
        413,
        'content_too_large',
        `content exceeds the configured ${root.maxBytes} byte limit for this root.`,
      );
    }

    const rootRealPath = resolve(root.path);
    await assertRootDirectory(rootRealPath);
    const targetPath = resolve(rootRealPath, normalizedRelativePath);
    if (!isSubpath(rootRealPath, targetPath) || targetPath === rootRealPath) {
      throw new FileDeliveryWorkerError(400, 'path_escape_denied', 'relative_path escapes the approved root.');
    }

    return {
      root,
      rootRealPath,
      normalizedRelativePath,
      targetPath,
      parentPath: dirname(targetPath),
      content,
      contentSha256: sha256(content),
    };
  }
}

export function createFileDeliveryWorker(options: {
  roots?: FileDeliveryRootPolicy[];
  basePath?: string;
} = {}): {
  fetch(request: Request): Promise<Response>;
} {
  const service = new LocalFileDeliveryService(options.roots ?? []);
  const basePath = normalizeBasePath(options.basePath ?? '/v1');
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === `${basePath}/health`) {
          return json(service.health());
        }
        if (request.method === 'POST' && url.pathname === `${basePath}/file/deliver`) {
          const deliveryRequest = await parseFileDeliveryRequest(request);
          const result = await service.deliver(deliveryRequest);
          return json(result);
        }
        return json({
          error: {
            code: 'not_found',
            message: 'File delivery route not found.',
          },
          policy: boundedPolicy(),
        }, 404);
      } catch (error) {
        if (error instanceof FileDeliveryWorkerError) {
          return json({
            error: {
              code: error.code,
              message: error.message,
              ...(error.suggestion ? { suggestion: error.suggestion } : {}),
            },
            policy: boundedPolicy(),
          }, error.status);
        }
        // Raw fs rejections embed the absolute destination path in `message`,
        // which is exactly what absolute_path_exposed: false promises to
        // withhold. Only the errno survives.
        const errno = errnoCode(error);
        return json({
          error: {
            code: 'file_delivery_error',
            message: 'File delivery failed on the host filesystem.',
            ...(errno ? { detail: `errno ${errno}` } : {}),
          },
          policy: boundedPolicy(),
        }, 500);
      }
    },
  };
}

export async function parseFileDeliveryRequest(request: Request): Promise<FileDeliveryRequest> {
  const record = await parseObjectBody(request);
  const rootId = asRequiredString(record.root_id, 'root_id');
  const relativePath = asRequiredString(record.relative_path, 'relative_path');
  const content = asRequiredString(record.content, 'content');
  const contentEncoding = asOptionalContentEncoding(record.content_encoding);
  const writeMode = asRequiredWriteMode(record.write_mode);
  const trustDomain = asRequiredTrustDomain(record.trust_domain);
  const sourceProvenance = asOptionalString(record.source_provenance);
  const idempotencyKey = asRequiredString(record.idempotency_key, 'idempotency_key');
  const approvalId = asOptionalString(record.approval_id);
  const actorId = asOptionalString(record.actor_id);
  const sessionId = asOptionalString(record.session_id);
  const modelProvider = asOptionalString(record.model_provider);
  const modelId = asOptionalString(record.model_id);
  return {
    root_id: rootId,
    relative_path: relativePath,
    content,
    ...(contentEncoding !== undefined ? { content_encoding: contentEncoding } : {}),
    write_mode: writeMode,
    trust_domain: trustDomain,
    ...(sourceProvenance !== undefined ? { source_provenance: sourceProvenance } : {}),
    idempotency_key: idempotencyKey,
    ...(approvalId !== undefined ? { approval_id: approvalId } : {}),
    ...(actorId !== undefined ? { actor_id: actorId } : {}),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(modelProvider !== undefined ? { model_provider: modelProvider } : {}),
    ...(modelId !== undefined ? { model_id: modelId } : {}),
  };
}

export function fileDeliveryRootsFromEnv(env: Record<string, string | undefined> = process.env): FileDeliveryRootPolicy[] {
  const raw = env.OLYMPUS_FILE_DELIVERY_ROOTS_JSON?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed.map((value) => asRecord(value, 'root'))
    : Object.entries(asRecord(parsed, 'OLYMPUS_FILE_DELIVERY_ROOTS_JSON')).map(([rootId, value]) => ({
      root_id: rootId,
      ...asRecord(value, `root ${rootId}`),
    }));
  return entries.map((entry) => rootPolicyFromRecord(entry));
}

function rootPolicyFromRecord(record: Record<string, unknown>): FileDeliveryRootPolicy {
  const rootId = asRequiredString(record.root_id ?? record.rootId, 'root_id');
  const path = asRequiredString(record.path ?? record.root_path ?? record.rootPath, 'path');
  const allowedTrustDomains = asTrustDomainArray(
    record.allowed_trust_domains ?? record.allowedTrustDomains,
    'allowed_trust_domains',
  );
  const allowedExtensions = asOptionalStringArray(
    record.allowed_extensions ?? record.allowedExtensions,
    'allowed_extensions',
  )?.map(normalizeExtension);
  const maxBytes = asOptionalPositiveInteger(record.max_bytes ?? record.maxBytes, 'max_bytes') ?? 1_048_576;
  const allowParentCreate = asOptionalBoolean(record.allow_parent_create ?? record.allowParentCreate)
    ?? true;
  const allowDotfiles = asOptionalBoolean(record.allow_dotfiles ?? record.allowDotfiles)
    ?? false;
  const allowOverwrite = asOptionalBoolean(record.allow_overwrite ?? record.allowOverwrite)
    ?? false;
  const auditPath = asOptionalString(record.audit_path ?? record.auditPath);
  return {
    rootId,
    path,
    allowedTrustDomains,
    ...(allowedExtensions !== undefined ? { allowedExtensions } : {}),
    maxBytes,
    allowParentCreate,
    allowDotfiles,
    allowOverwrite,
    ...(auditPath !== undefined ? { auditPath } : {}),
  };
}

function normalizeRootPolicy(root: FileDeliveryRootPolicy): FileDeliveryRootPolicy {
  if (!root.rootId.trim()) {
    throw new FileDeliveryWorkerError(500, 'invalid_root_config', 'Root policy has an empty rootId.');
  }
  if (!isAbsolute(root.path)) {
    throw new FileDeliveryWorkerError(500, 'invalid_root_config', `Root ${root.rootId} path must be absolute.`);
  }
  if (!Array.isArray(root.allowedTrustDomains) || root.allowedTrustDomains.length === 0) {
    throw new FileDeliveryWorkerError(500, 'invalid_root_config', `Root ${root.rootId} must allow at least one trust domain.`);
  }
  if (!Number.isInteger(root.maxBytes) || root.maxBytes <= 0) {
    throw new FileDeliveryWorkerError(500, 'invalid_root_config', `Root ${root.rootId} maxBytes must be positive.`);
  }
  return {
    ...root,
    rootId: root.rootId.trim(),
    path: root.path,
    allowedTrustDomains: root.allowedTrustDomains,
    ...(root.allowedExtensions ? { allowedExtensions: root.allowedExtensions.map(normalizeExtension) } : {}),
  };
}

function assertRequestShape(request: FileDeliveryRequest): void {
  if (!request.idempotency_key.trim()) {
    throw new FileDeliveryWorkerError(400, 'invalid_request', 'idempotency_key must be non-empty.');
  }
  if (request.write_mode === 'overwrite_with_approval' && !request.approval_id?.trim()) {
    throw new FileDeliveryWorkerError(
      403,
      'approval_required',
      'overwrite_with_approval requires an explicit approval_id.',
    );
  }
}

function assertTrustDomainAllowed(root: FileDeliveryRootPolicy, trustDomain: FileDeliveryTrustDomain): void {
  if (!root.allowedTrustDomains.includes(trustDomain)) {
    throw new FileDeliveryWorkerError(
      403,
      'trust_domain_denied',
      'trust_domain is not allowed for this file-delivery root.',
    );
  }
}

function normalizeRelativePath(input: string, root: FileDeliveryRootPolicy): string {
  if (input.includes('\0')) {
    throw new FileDeliveryWorkerError(400, 'invalid_path', 'relative_path must not contain null bytes.');
  }
  if (input.includes('\\')) {
    throw new FileDeliveryWorkerError(400, 'invalid_path', 'relative_path must use forward slashes.');
  }
  if (isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input) || input.startsWith('\\\\')) {
    throw new FileDeliveryWorkerError(400, 'absolute_path_denied', 'relative_path must not be absolute.');
  }
  const normalized = normalize(input).replace(/^\.\//, '');
  if (
    normalized === ''
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith(`..${sep}`)
    || normalized.endsWith(sep)
  ) {
    throw new FileDeliveryWorkerError(400, 'invalid_path', 'relative_path must point to a file below the approved root.');
  }
  const segments = normalized.split(sep);
  if (!root.allowDotfiles && segments.some((segment) => segment.startsWith('.'))) {
    throw new FileDeliveryWorkerError(403, 'dotfile_denied', 'Dotfile paths are not allowed for this root.');
  }
  return normalized;
}

function assertExtensionAllowed(relativePath: string, root: FileDeliveryRootPolicy): void {
  const extension = normalizeExtension(extname(relativePath));
  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    throw new FileDeliveryWorkerError(403, 'executable_extension_denied', 'Executable file extensions are denied by default.');
  }
  if (root.allowedExtensions && !root.allowedExtensions.includes(extension)) {
    throw new FileDeliveryWorkerError(403, 'extension_denied', 'File extension is not allowed for this root.');
  }
}

function decodeContent(content: string, encoding: FileDeliveryContentEncoding): Uint8Array {
  if (encoding === 'utf8') return new TextEncoder().encode(content);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) {
    throw new FileDeliveryWorkerError(400, 'invalid_base64', 'base64 content is not valid.');
  }
  return Buffer.from(content, 'base64');
}

async function assertRootDirectory(rootRealPath: string): Promise<void> {
  const rootInfo = await lstat(rootRealPath).catch((error) => {
    if (isNotFound(error)) {
      throw new FileDeliveryWorkerError(500, 'root_not_available', 'Configured root is not available on this host.');
    }
    throw error;
  });
  if (rootInfo.isSymbolicLink()) {
    throw new FileDeliveryWorkerError(403, 'symlink_escape_denied', 'Configured root must not be a symlink.');
  }
  if (!rootInfo.isDirectory()) {
    throw new FileDeliveryWorkerError(500, 'root_not_available', 'Configured root is not a directory on this host.');
  }
}

async function ensureWritableParent(rootRealPath: string, parentPath: string, allowParentCreate: boolean): Promise<void> {
  const parentReady = await inspectExistingParent(rootRealPath, parentPath);
  if (parentReady) return;
  if (!allowParentCreate) {
    throw new FileDeliveryWorkerError(400, 'parent_missing', 'Parent directory does not exist and this root does not allow creating parents.');
  }
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const createdParentReady = await inspectExistingParent(rootRealPath, parentPath);
  if (!createdParentReady) {
    throw new FileDeliveryWorkerError(500, 'parent_create_failed', 'Parent directory could not be created below the approved root.');
  }
  // A directory entry is durable only once the directory holding it is flushed,
  // so every level this call may have created is flushed from the root down.
  // Otherwise the fsynced audit record can outlive the path it names.
  let ancestor = rootRealPath;
  await syncDirectory(ancestor);
  for (const segment of relativePathSegments(rootRealPath, parentPath).slice(0, -1)) {
    ancestor = join(ancestor, segment);
    await syncDirectory(ancestor);
  }
}

async function inspectExistingParent(rootRealPath: string, parentPath: string): Promise<boolean> {
  const segments = relativePathSegments(rootRealPath, parentPath);
  let current = rootRealPath;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const parentInfo = await lstat(current);
      if (parentInfo.isSymbolicLink()) {
        throw new FileDeliveryWorkerError(403, 'symlink_escape_denied', 'Symlink parent directories are not allowed.');
      }
      if (!parentInfo.isDirectory()) {
        throw new FileDeliveryWorkerError(400, 'parent_not_directory', 'Parent path is not a directory.');
      }
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
  return true;
}

function relativePathSegments(rootRealPath: string, candidatePath: string): string[] {
  const rel = relative(rootRealPath, candidatePath);
  if (rel === '') return [];
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new FileDeliveryWorkerError(403, 'path_escape_denied', 'Parent directory escapes the approved root.');
  }
  return rel.split(sep).filter(Boolean);
}

/** Returns the destination's current permission bits, which the replacement keeps. */
async function assertOverwriteApproved(request: FileDeliveryRequest, prepared: PreparedDelivery): Promise<number> {
  if (!prepared.root.allowOverwrite) {
    throw new FileDeliveryWorkerError(403, 'overwrite_denied', 'This root does not allow overwrites.');
  }
  if (!request.approval_id?.trim()) {
    throw new FileDeliveryWorkerError(403, 'approval_required', 'overwrite_with_approval requires an explicit approval_id.');
  }
  const targetInfo = await lstat(prepared.targetPath).catch((error) => {
    if (isNotFound(error)) {
      throw new FileDeliveryWorkerError(404, 'file_missing', 'overwrite_with_approval requires an existing destination file.');
    }
    throw error;
  });
  if (targetInfo.isSymbolicLink()) {
    throw new FileDeliveryWorkerError(403, 'symlink_escape_denied', 'Destination symlink overwrites are not allowed.');
  }
  if (!targetInfo.isFile()) {
    throw new FileDeliveryWorkerError(400, 'destination_not_file', 'Destination is not a regular file.');
  }
  return targetInfo.mode & 0o777;
}

/**
 * Publish the payload durably enough for the audit record that follows it.
 *
 * That record is the only idempotency evidence a retry ever consults -- a retry
 * that finds one returns success without looking at the target -- and it is
 * itself fsynced. So a crash between the two must not be able to leave the
 * destination short of what the audit claims: the bytes are flushed before the
 * name is published, and the directory holding the name is flushed after.
 */
async function writeDeliveredPayload(
  prepared: PreparedDelivery,
  options: { mode: 'create_new' } | { mode: 'overwrite'; fileMode: number },
): Promise<void> {
  if (options.mode === 'create_new') {
    const file = await open(prepared.targetPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') {
        throw new FileDeliveryWorkerError(
          409,
          'file_exists',
          'Destination file already exists. Use overwrite_with_approval only with an explicit approval path.',
        );
      }
      throw error;
    });
    try {
      await file.writeFile(prepared.content);
      await file.sync();
    } finally {
      await file.close();
    }
  } else {
    // An overwrite stages the replacement beside the destination and renames it
    // over the top, so a crash leaves either the old file or the new one and
    // never a truncated blend -- and never an empty destination the completed
    // audit record has already claimed. The staging file is born private and
    // takes the destination's own permissions before it becomes the destination.
    const staging = `${prepared.targetPath}.${randomUUID()}.tmp`;
    try {
      const file = await open(staging, 'wx', 0o600);
      try {
        await file.writeFile(prepared.content);
        await file.chmod(options.fileMode);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(staging, prepared.targetPath);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  await syncDirectory(prepared.parentPath);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    try {
      await directory.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySyncError(error)) throw error;
    }
  } finally {
    await directory.close();
  }
}

function makeAuditRecord(
  request: FileDeliveryRequest,
  prepared: PreparedDelivery,
  options: { phase: FileDeliveryAuditRecord['phase']; bytesWritten: number; approvalStatus: FileDeliveryApprovalStatus },
): FileDeliveryAuditRecord {
  return {
    kind: 'file_delivery_audit',
    phase: options.phase,
    delivery_id: `delivery_${randomUUID()}`,
    root_id: prepared.root.rootId,
    relative_path: prepared.normalizedRelativePath,
    content_sha256: prepared.contentSha256,
    write_mode: request.write_mode,
    trust_domain: request.trust_domain,
    bytes_written: options.bytesWritten,
    approval_status: options.approvalStatus,
    idempotency_key: request.idempotency_key,
    created_at: new Date().toISOString(),
    ...(request.actor_id ? { actor_id: request.actor_id } : {}),
    ...(request.session_id ? { session_id: request.session_id } : {}),
    ...(request.model_provider ? { model_provider: request.model_provider } : {}),
    ...(request.model_id ? { model_id: request.model_id } : {}),
    ...(request.source_provenance ? { source_provenance: request.source_provenance } : {}),
  };
}

async function appendAuditRecord(root: FileDeliveryRootPolicy, record: FileDeliveryAuditRecord): Promise<void> {
  const auditPath = root.auditPath ?? join(root.path, '.olympus-file-delivery-audit.jsonl');
  await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
  const file = await open(auditPath, 'a', 0o600);
  try {
    await file.write(`${JSON.stringify(record)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function ensureAuditSink(root: FileDeliveryRootPolicy): Promise<void> {
  const auditPath = root.auditPath ?? join(root.path, '.olympus-file-delivery-audit.jsonl');
  await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
  // Exclusive create, so the flush below happens once -- when this call is the
  // one publishing the ledger's name -- rather than on every delivery.
  const created = await open(auditPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return undefined;
    throw error;
  });
  if (!created) return;
  await created.close();
  // Same rule the payload write and ensureWritableParent follow: a name is
  // durable only once the directory holding it is flushed. The ledger IS the
  // delivery commit record, so an fsynced record inside a file whose directory
  // entry never landed loses every delivery this root has ever audited.
  await syncDirectory(dirname(auditPath));
}

async function findCompletedAuditRecord(
  root: FileDeliveryRootPolicy,
  idempotencyKey: string,
): Promise<FileDeliveryAuditRecord | undefined> {
  const auditPath = root.auditPath ?? join(root.path, '.olympus-file-delivery-audit.jsonl');
  const raw = await readFile(auditPath, 'utf8').catch((error) => {
    if (isNotFound(error)) return '';
    throw error;
  });
  let match: FileDeliveryAuditRecord | undefined;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // A torn line (killed mid-append) must not wedge every future delivery to
    // this root: the ledger is append-only and nothing else can repair it.
    let record: FileDeliveryAuditRecord;
    try {
      record = JSON.parse(line) as FileDeliveryAuditRecord;
    } catch {
      continue;
    }
    if (record.kind === 'file_delivery_audit' && record.phase === 'completed' && record.idempotency_key === idempotencyKey) {
      match = record;
    }
  }
  return match;
}

function assertIdempotencyMatch(
  previous: FileDeliveryAuditRecord,
  request: FileDeliveryRequest,
  prepared: PreparedDelivery,
): void {
  if (
    previous.root_id !== prepared.root.rootId
    || previous.relative_path !== prepared.normalizedRelativePath
    || previous.content_sha256 !== prepared.contentSha256
    || previous.write_mode !== request.write_mode
    || previous.trust_domain !== request.trust_domain
  ) {
    throw new FileDeliveryWorkerError(
      409,
      'idempotency_conflict',
      'idempotency_key was already used for a different file-delivery request.',
    );
  }
}

function resultFromAudit(record: FileDeliveryAuditRecord, idempotentReplay: boolean): FileDeliveryResult {
  return {
    kind: 'file_delivery_result',
    delivery_id: record.delivery_id,
    root_id: record.root_id,
    relative_path: record.relative_path,
    bytes_written: record.bytes_written,
    content_sha256: record.content_sha256,
    write_mode: record.write_mode,
    created_at: record.created_at,
    approval_status: record.approval_status,
    audit_ref: `file_delivery:${record.delivery_id}`,
    ...(idempotentReplay ? { idempotent_replay: true } : {}),
    policy: boundedPolicy(),
  };
}

function isSubpath(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeExtension(extension: string): string {
  return extension.trim().toLowerCase();
}

function boundedPolicy(): FileDeliveryResult['policy'] {
  return {
    bounded_file_delivery: true,
    shell_used: false,
    absolute_path_exposed: false,
  };
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new FileDeliveryWorkerError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
  return asRecord(body, 'request body');
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed.replace(/\/+$/, '') : `/${trimmed.replace(/\/+$/, '')}`;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FileDeliveryWorkerError(400, 'invalid_request', `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asRequiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FileDeliveryWorkerError(400, 'invalid_request', `${name} must be a non-empty string.`);
  }
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asRequiredWriteMode(value: unknown): FileDeliveryWriteMode {
  if (value === 'dry_run' || value === 'create_new' || value === 'overwrite_with_approval') return value;
  throw new FileDeliveryWorkerError(400, 'invalid_request', 'write_mode must be dry_run, create_new, or overwrite_with_approval.');
}

function asRequiredTrustDomain(value: unknown): FileDeliveryTrustDomain {
  if (value === 'public_safe' || value === 'internal' || value === 'secure_local') return value;
  throw new FileDeliveryWorkerError(400, 'invalid_request', 'trust_domain must be public_safe, internal, or secure_local.');
}

function asOptionalContentEncoding(value: unknown): FileDeliveryContentEncoding | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'utf8' || value === 'base64') return value;
  throw new FileDeliveryWorkerError(400, 'invalid_request', 'content_encoding must be utf8 or base64.');
}

function asTrustDomainArray(value: unknown, name: string): FileDeliveryTrustDomain[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FileDeliveryWorkerError(400, 'invalid_request', `${name} must be a non-empty array.`);
  }
  return value.map((item) => asRequiredTrustDomain(item));
}

function asOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new FileDeliveryWorkerError(400, 'invalid_request', `${name} must be an array of non-empty strings.`);
  }
  return value;
}

function asOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new FileDeliveryWorkerError(400, 'invalid_request', `${name} must be a positive integer.`);
  }
  return number;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new FileDeliveryWorkerError(400, 'invalid_request', 'boolean value must be true or false.');
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : undefined;
}

const EXECUTABLE_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.bin',
  '.bash',
  '.cmd',
  '.com',
  '.command',
  '.cjs',
  '.exe',
  '.fish',
  '.jar',
  '.js',
  '.jsx',
  '.mjs',
  '.php',
  '.pl',
  '.ps1',
  '.py',
  '.rb',
  '.run',
  '.scr',
  '.sh',
  '.ts',
  '.tsx',
  '.zsh',
]);
