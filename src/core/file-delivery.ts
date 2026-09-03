import type { OlympusConfig } from './config.ts';
import { fetchWithTimeout, isAbortError } from './http-timeout.ts';
import { OperationError } from './operation-error.ts';
import { withWorkerAuthHeader, workerAuthTokenFromConfig } from './worker-auth.ts';

export type FileDeliveryFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface FileDeliveryTransport {
  requestJson(url: string, init: RequestInit): Promise<unknown>;
}

export type FileDeliveryWriteMode = 'dry_run' | 'create_new' | 'overwrite_with_approval';
export type FileDeliveryContentEncoding = 'utf8' | 'base64';
export type FileDeliveryTrustDomain = 'public_safe' | 'internal' | 'secure_local';

export interface FileDeliveryOptions {
  rootId: string;
  relativePath: string;
  content: string;
  contentEncoding?: FileDeliveryContentEncoding;
  writeMode: FileDeliveryWriteMode;
  trustDomain: FileDeliveryTrustDomain;
  sourceProvenance?: string;
  idempotencyKey: string;
  approvalId?: string;
  actorId?: string;
  sessionId?: string;
  modelProvider?: string;
  modelId?: string;
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
  approval_status: 'dry_run' | 'not_required' | 'approved';
  audit_ref: string;
  idempotent_replay?: boolean;
  policy: {
    bounded_file_delivery: true;
    shell_used: false;
    absolute_path_exposed: false;
  };
}

export interface FileDeliveryHealthResult {
  reachable: boolean;
  configured: boolean;
  base_url: string;
  latency_ms?: number;
  roots?: unknown[];
  policy: {
    bounded_file_delivery: true;
    shell_used: false;
    absolute_path_exposed: false;
  };
  detail?: string;
}

export class FileDeliveryClient {
  private config: OlympusConfig;
  private transport: FileDeliveryTransport;

  constructor(
    config: OlympusConfig,
    transport: FileDeliveryTransport = createFileDeliveryTransport(config),
  ) {
    this.config = config;
    this.transport = transport;
  }

  async health(): Promise<FileDeliveryHealthResult> {
    if (!this.config.fileDelivery.enabled) {
      return {
        reachable: false,
        configured: false,
        base_url: this.config.fileDelivery.baseUrl,
        policy: {
          bounded_file_delivery: true,
          shell_used: false,
          absolute_path_exposed: false,
        },
        detail: 'File delivery is disabled. Configure a bounded Xanthos delivery worker before exposing the tool.',
      };
    }

    const startedAt = performance.now();
    const response = await this.transport.requestJson(`${this.config.fileDelivery.baseUrl}/health`, {
      method: 'GET',
    });
    const data = asRecord(response);
    assertNoHostPathLeakFields(data);
    const policy = asRecord(data.policy);
    if (
      policy.bounded_file_delivery !== true
      || policy.shell_used !== false
      || policy.absolute_path_exposed !== false
    ) {
      throw new OperationError('file_delivery_error', 'File delivery health policy was not bounded and path-safe.');
    }
    return {
      reachable: true,
      configured: typeof data.configured === 'boolean' ? data.configured : true,
      base_url: this.config.fileDelivery.baseUrl,
      latency_ms: Math.round(performance.now() - startedAt),
      ...(Array.isArray(data.roots) ? { roots: data.roots } : {}),
      policy: {
        bounded_file_delivery: true,
        shell_used: false,
        absolute_path_exposed: false,
      },
      ...(typeof data.detail === 'string' ? { detail: data.detail } : {}),
    };
  }

  async deliver(options: FileDeliveryOptions): Promise<FileDeliveryResult> {
    if (!this.config.fileDelivery.enabled) {
      throw new OperationError(
        'file_delivery_not_configured',
        'File delivery is disabled.',
        'Configure the bounded Xanthos file-delivery worker before using file writes.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.fileDelivery.baseUrl}/file/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root_id: options.rootId,
        relative_path: options.relativePath,
        content: options.content,
        ...(options.contentEncoding ? { content_encoding: options.contentEncoding } : {}),
        write_mode: options.writeMode,
        trust_domain: options.trustDomain,
        ...(options.sourceProvenance ? { source_provenance: options.sourceProvenance } : {}),
        idempotency_key: options.idempotencyKey,
        ...(options.approvalId ? { approval_id: options.approvalId } : {}),
        ...(options.actorId ? { actor_id: options.actorId } : {}),
        ...(options.sessionId ? { session_id: options.sessionId } : {}),
        ...(options.modelProvider ? { model_provider: options.modelProvider } : {}),
        ...(options.modelId ? { model_id: options.modelId } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoHostPathLeakFields(data);
    return parseFileDeliveryResult(data);
  }
}

export function createFileDeliveryTransport(config: OlympusConfig): FileDeliveryTransport {
  return new DirectHttpFileDeliveryTransport(
    fetch,
    workerAuthTokenFromConfig(config),
    config.fileDelivery.requestTimeoutSeconds * 1000,
  );
}

export class DirectHttpFileDeliveryTransport implements FileDeliveryTransport {
  private fetchImpl: FileDeliveryFetch;
  private authToken: string | undefined;
  private timeoutMs: number;

  constructor(fetchImpl: FileDeliveryFetch = fetch, authToken?: string, timeoutMs = 0) {
    this.fetchImpl = fetchImpl;
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
  }

  async requestJson(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchWithTimeout(this.fetchImpl, url, withWorkerAuthHeader(init, this.authToken), this.timeoutMs);
    } catch (error) {
      if (isAbortError(error)) {
        throw new OperationError(
          'file_delivery_unreachable',
          `Bounded file-delivery worker timed out at ${url} after ${this.timeoutMs}ms.`,
          'The file-delivery worker did not answer within the configured request budget; check worker health before retrying.',
        );
      }
      throw new OperationError(
        'file_delivery_unreachable',
        `Bounded file-delivery worker is unreachable at ${url}.`,
        error instanceof Error ? error.message : 'Check that the Xanthos file-delivery worker is running.',
      );
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new OperationError(
        'file_delivery_error',
        `Bounded file-delivery worker returned HTTP ${response.status}.`,
        body || 'Check the Xanthos file-delivery worker logs.',
      );
    }

    return response.json();
  }
}

function parseFileDeliveryResult(value: Record<string, unknown>): FileDeliveryResult {
  const policy = asRecord(value.policy);
  if (
    value.kind !== 'file_delivery_result'
    || policy.bounded_file_delivery !== true
    || policy.shell_used !== false
    || policy.absolute_path_exposed !== false
  ) {
    throw new OperationError('file_delivery_error', 'File delivery result did not include bounded path-safe policy.');
  }
  const writeMode = requiredWriteMode(value.write_mode, 'write_mode');
  const approvalStatus = requiredApprovalStatus(value.approval_status, 'approval_status');
  return {
    kind: 'file_delivery_result',
    delivery_id: requiredString(value.delivery_id, 'delivery_id'),
    root_id: requiredString(value.root_id, 'root_id'),
    relative_path: requiredString(value.relative_path, 'relative_path'),
    bytes_written: requiredNumber(value.bytes_written, 'bytes_written'),
    content_sha256: requiredString(value.content_sha256, 'content_sha256'),
    write_mode: writeMode,
    created_at: requiredString(value.created_at, 'created_at'),
    approval_status: approvalStatus,
    audit_ref: requiredString(value.audit_ref, 'audit_ref'),
    ...(typeof value.idempotent_replay === 'boolean' ? { idempotent_replay: value.idempotent_replay } : {}),
    policy: {
      bounded_file_delivery: true,
      shell_used: false,
      absolute_path_exposed: false,
    },
  };
}

function assertNoHostPathLeakFields(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoHostPathLeakFields(item, [...path, String(index)]));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === 'absolute_path'
      || key === 'target_path'
      || key === 'root_path'
      || key === 'host_path'
      || key === 'filesystem_path'
    ) {
      throw new OperationError('file_delivery_error', `forbidden host path field "${[...path, key].join('.')}"`);
    }
    assertNoHostPathLeakFields(nested, [...path, key]);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('file_delivery_error', 'File delivery response was not a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OperationError('file_delivery_error', `${name} must be a non-empty string.`);
  }
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OperationError('file_delivery_error', `${name} must be a finite number.`);
  }
  return value;
}

function requiredWriteMode(value: unknown, name: string): FileDeliveryWriteMode {
  if (value === 'dry_run' || value === 'create_new' || value === 'overwrite_with_approval') return value;
  throw new OperationError('file_delivery_error', `${name} must be a supported write mode.`);
}

function requiredApprovalStatus(value: unknown, name: string): FileDeliveryResult['approval_status'] {
  if (value === 'dry_run' || value === 'not_required' || value === 'approved') return value;
  throw new OperationError('file_delivery_error', `${name} must be a supported approval status.`);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
