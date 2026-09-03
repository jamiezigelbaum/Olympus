import type { OlympusConfig } from './config.ts';
import { fetchWithTimeout, isAbortError } from './http-timeout.ts';
import { OperationError, type OperationErrorCode } from './operation-error.ts';
import {
  normalizeWorkerAuthToken,
  readWorkerSetupEnv,
  withWorkerAuthHeader,
  workerAuthTokenFromConfig,
  type WorkerAuthTokenLookupOptions,
} from './worker-auth.ts';

export type DomainExpertTool =
  | 'domain_agent'
  | 'domain_ask'
  | 'domain_source'
  | 'rag_corpus'
  | 'domain_doc'
  | 'annas_archive_search'
  | 'annas_archive_import';

export type DomainExpertFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DomainExpertTransport {
  requestJson(url: string, init: RequestInit): Promise<unknown>;
}

const MAX_WORKER_ERROR_BODY_BYTES = 8 * 1024;
const MAX_WORKER_ERROR_CODE_LENGTH = 64;
const MAX_WORKER_ERROR_MESSAGE_LENGTH = 512;
const MAX_WORKER_ERROR_SUGGESTION_LENGTH = 512;
const GENERIC_WORKER_ERROR_SUGGESTION = 'Check the Olympus domain expert worker logs.';

// This is the intersection of OperationErrorCode and the worker's own error
// producers: request validation emits invalid_params, the dispatch flag gate
// emits domain_expert_not_configured, and the Anna search/import/configuration
// paths emit annas_archive_not_configured. All other worker codes stay behind
// the generic client boundary until the client deliberately types them.
const PASSTHROUGH_WORKER_ERROR_CODES: Readonly<Record<string, OperationErrorCode>> = Object.freeze({
  invalid_params: 'invalid_params',
  domain_expert_not_configured: 'domain_expert_not_configured',
  annas_archive_not_configured: 'annas_archive_not_configured',
});

export class DomainExpertClient {
  private config: OlympusConfig;
  private transport: DomainExpertTransport;

  constructor(
    config: OlympusConfig,
    transport: DomainExpertTransport = createDomainExpertTransport(config),
  ) {
    this.config = config;
    this.transport = transport;
  }

  async run(tool: DomainExpertTool, params: Record<string, unknown>): Promise<unknown> {
    if (!this.config.domainExpert.enabled) {
      throw new OperationError(
        'domain_expert_not_configured',
        'Domain expert worker is disabled.',
        'Configure the bounded domain expert worker before live Google/Gemini/Docs/Anna actions.',
      );
    }
    // The legacy worker forgave an omitted domain_id by defaulting it to
    // governance on the serving path (normalizeDomainId). The Expert-Agents
    // worker is tenant-neutral: its own default domain is unrouted, so an
    // omission that used to be silently served becomes a 503 whose message
    // names the wrong remedy. The tenant default is this deployment's fact,
    // so this client injects it — never overriding an explicit id.
    const defaultDomainId = this.config.domainExpert.defaultDomainId;
    const requestParams = defaultDomainId && params.domain_id === undefined
      ? { ...params, domain_id: defaultDomainId }
      : params;
    const response = await this.transport.requestJson(`${this.config.domainExpert.baseUrl}/domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, params: requestParams }),
    });
    assertDomainExpertPolicy(response);
    return response;
  }
}

/**
 * The domain-expert worker may be operated by another system, so it gets a bearer
 * of its own. Resolution mirrors the fleet-wide token exactly — config, then
 * environment, then the worker setup file — so the value can be delivered the same
 * way without ever being written into live gateway config. Falls back to the fleet
 * token so a single-system deployment needs no extra wiring.
 */
export function domainExpertAuthTokenFromConfig(
  config: OlympusConfig,
  options: WorkerAuthTokenLookupOptions = {},
): string | undefined {
  return (
    normalizeWorkerAuthToken(config.domainExpert.authToken)
    ?? normalizeWorkerAuthToken((options.env ?? process.env).OLYMPUS_DOMAIN_EXPERT_AUTH_TOKEN)
    ?? normalizeWorkerAuthToken(readWorkerSetupEnv(options)?.OLYMPUS_DOMAIN_EXPERT_AUTH_TOKEN)
    ?? workerAuthTokenFromConfig(config, options)
  );
}

export function createDomainExpertTransport(config: OlympusConfig): DomainExpertTransport {
  return new DirectHttpDomainExpertTransport(
    fetch,
    domainExpertAuthTokenFromConfig(config),
    config.domainExpert.requestTimeoutSeconds * 1000,
  );
}

export class DirectHttpDomainExpertTransport implements DomainExpertTransport {
  private fetchImpl: DomainExpertFetch;
  private authToken: string | undefined;
  private timeoutMs: number;

  constructor(fetchImpl: DomainExpertFetch = fetch, authToken?: string, timeoutMs = 0) {
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
          'domain_expert_unreachable',
          `Domain expert worker timed out at ${url} after ${this.timeoutMs}ms.`,
          'The domain expert worker did not answer within the configured request budget; check worker health before retrying.',
        );
      }
      throw new OperationError(
        'domain_expert_unreachable',
        `Domain expert worker is unreachable at ${url}.`,
        error instanceof Error ? error.message : 'Check that the Olympus domain expert worker is running.',
      );
    }

    if (!response.ok) {
      const workerError = response.status === 403
        ? undefined
        : parseWorkerError(await safeText(response));
      throw new OperationError(
        response.status === 403
          ? 'domain_expert_policy_violation'
          : workerError?.code ?? 'domain_expert_error',
        workerError?.message ?? `Domain expert worker returned HTTP ${response.status}.`,
        workerError?.suggestion ?? GENERIC_WORKER_ERROR_SUGGESTION,
      );
    }

    return response.json();
  }
}

function assertDomainExpertPolicy(value: unknown): void {
  const record = asRecord(value);
  const policy = asRecord(record.policy);
  // Two accepted spellings of the same contract bit. The legacy worker brands
  // it olympus_control_plane_only; the Expert-Agents worker that serves the
  // lane after the 3A cutover is tenant-neutral and emits
  // expert_agents_control_plane_only. Discovered by the first real gateway
  // request after the flip — every direct-to-worker proof passed because this
  // assertion lives only in the client. The legacy key stays accepted while
  // the :8040 worker exists at all, so rollback remains real until its
  // retirement ceremony formally drops it.
  const controlPlaneOnly = policy.olympus_control_plane_only === true
    || policy.expert_agents_control_plane_only === true;
  if (!controlPlaneOnly || policy.raw_runtime_secrets_exposed !== false) {
    throw new OperationError('domain_expert_error', 'Domain expert response did not include the bounded policy contract.');
  }
}

async function safeText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_WORKER_ERROR_BODY_BYTES) {
        await reader.cancel();
        return '';
      }
      chunks.push(value);
    }
    const body = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  } catch {
    return '';
  } finally {
    reader.releaseLock();
  }
}

function parseWorkerError(body: string): {
  code: OperationErrorCode;
  message: string;
  suggestion?: string;
} | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    const error = optionalRecord(optionalRecord(parsed)?.error);
    const code = boundedWorkerErrorString(error?.code, MAX_WORKER_ERROR_CODE_LENGTH);
    const message = boundedWorkerErrorString(error?.message, MAX_WORKER_ERROR_MESSAGE_LENGTH);
    if (!code || !message) return undefined;
    const typedCode = PASSTHROUGH_WORKER_ERROR_CODES[code];
    if (!typedCode) return undefined;
    const suggestionValue = error?.suggestion;
    const suggestion = suggestionValue === undefined
      ? undefined
      : boundedWorkerErrorString(suggestionValue, MAX_WORKER_ERROR_SUGGESTION_LENGTH);
    if (suggestionValue !== undefined && !suggestion) return undefined;
    return {
      code: typedCode,
      message,
      ...(suggestion ? { suggestion } : {}),
    };
  } catch {
    return undefined;
  }
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedWorkerErrorString(value: unknown, maxLength: number): string | undefined {
  if (
    typeof value !== 'string'
    || value.length > maxLength
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('domain_expert_error', 'Domain expert response was not an object.');
  }
  return value as Record<string, unknown>;
}
