import type { OlympusConfig } from './config.ts';
import { fetchWithTimeout, isAbortError } from './http-timeout.ts';
import { OperationError } from './operation-error.ts';
import { withWorkerAuthHeader, workerAuthTokenFromConfig } from './worker-auth.ts';

export type CastorWorkspaceFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CastorWorkspaceTransport {
  requestJson(url: string, init: RequestInit): Promise<unknown>;
}

export type CastorWorkspaceAction = 'health' | 'list' | 'read' | 'write' | 'delete' | 'export_gcs';
export type CastorWorkspaceContentEncoding = 'utf8' | 'base64';

export interface CastorWorkspaceOptions {
  action: CastorWorkspaceAction;
  rootId?: string;
  relativePath?: string;
  content?: string;
  contentEncoding?: CastorWorkspaceContentEncoding;
  destinationUri?: string;
  recursive?: boolean;
  dryRun?: boolean;
  includeMedia?: boolean;
  idempotencyKey?: string;
  actorId?: string;
  sessionId?: string;
}

export interface CastorWorkspaceResult {
  kind: string;
  policy: {
    castor_workspace_delegated: true;
    shell_exposed_to_agent: false;
    absolute_path_exposed: false;
  };
  [key: string]: unknown;
}

export class CastorWorkspaceClient {
  private config: OlympusConfig;
  private transport: CastorWorkspaceTransport;

  constructor(
    config: OlympusConfig,
    transport: CastorWorkspaceTransport = createCastorWorkspaceTransport(config),
  ) {
    this.config = config;
    this.transport = transport;
  }

  async run(options: CastorWorkspaceOptions): Promise<CastorWorkspaceResult> {
    if (!this.config.castorWorkspace.enabled) {
      throw new OperationError(
        'castor_workspace_not_configured',
        'Delegated workspace is disabled.',
        'Configure the bounded delegated workspace worker before exposing delegated filesystem access.',
      );
    }
    const response = await this.transport.requestJson(`${this.config.castorWorkspace.baseUrl}/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: options.action,
        ...(options.rootId ? { root_id: options.rootId } : {}),
        ...(options.relativePath !== undefined ? { relative_path: options.relativePath } : {}),
        ...(options.content !== undefined ? { content: options.content } : {}),
        ...(options.contentEncoding ? { content_encoding: options.contentEncoding } : {}),
        ...(options.destinationUri ? { destination_uri: options.destinationUri } : {}),
        ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
        ...(options.dryRun !== undefined ? { dry_run: options.dryRun } : {}),
        ...(options.includeMedia !== undefined ? { include_media: options.includeMedia } : {}),
        ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
        ...(options.actorId ? { actor_id: options.actorId } : {}),
        ...(options.sessionId ? { session_id: options.sessionId } : {}),
      }),
    });
    const data = asRecord(response);
    assertWorkspacePolicy(data);
    assertNoHostPathLeakFields(data);
    return data as CastorWorkspaceResult;
  }
}

export function createCastorWorkspaceTransport(config: OlympusConfig): CastorWorkspaceTransport {
  return new DirectHttpCastorWorkspaceTransport(
    fetch,
    workerAuthTokenFromConfig(config),
    config.castorWorkspace.requestTimeoutSeconds * 1000,
  );
}

export class DirectHttpCastorWorkspaceTransport implements CastorWorkspaceTransport {
  private fetchImpl: CastorWorkspaceFetch;
  private authToken: string | undefined;
  private timeoutMs: number;

  constructor(fetchImpl: CastorWorkspaceFetch = fetch, authToken?: string, timeoutMs = 0) {
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
          'castor_workspace_unreachable',
          `Delegated workspace worker timed out at ${url} after ${this.timeoutMs}ms.`,
          'The delegated workspace worker did not answer within the configured request budget; check worker health before retrying.',
        );
      }
      throw new OperationError(
        'castor_workspace_unreachable',
        `Delegated workspace worker is unreachable at ${url}.`,
        error instanceof Error ? error.message : 'Check that the Xanthos delegated workspace worker is running.',
      );
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new OperationError(
        'castor_workspace_error',
        `Delegated workspace worker returned HTTP ${response.status}.`,
        body || 'Check the Xanthos delegated workspace worker logs.',
      );
    }

    return response.json();
  }
}

function assertWorkspacePolicy(value: Record<string, unknown>): void {
  const policy = asRecord(value.policy);
  if (
    policy.castor_workspace_delegated !== true
    || policy.shell_exposed_to_agent !== false
    || policy.absolute_path_exposed !== false
  ) {
    throw new OperationError('castor_workspace_error', 'Delegated workspace response did not include bounded delegated policy.');
  }
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
      throw new OperationError('castor_workspace_error', `forbidden host path field "${[...path, key].join('.')}"`);
    }
    assertNoHostPathLeakFields(nested, [...path, key]);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('castor_workspace_error', 'Delegated workspace response was not an object.');
  }
  return value as Record<string, unknown>;
}
