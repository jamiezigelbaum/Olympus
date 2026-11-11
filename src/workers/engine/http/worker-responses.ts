import type { SourceIndexEmbeddingLaneState, SourceIndexStatusResult } from '../../source-index/status.ts';
import type { WorkerCredentialDegradation, WorkerCredentialReadiness } from '../../credential-degradation.ts';
import type { EmailSourceWorkerOptions } from './worker-options.ts';

export class EmailSourceWorkerError extends Error {
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

export function workerRouteNotFound(): Response {
  return json(
    {
      error: {
        code: 'not_found',
        message: 'Email source worker route not found.',
      },
      policy: { raw_email_exposed: false },
    },
    404,
  );
}

export function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function isDeepHealthRequest(url: URL): boolean {
  const value = (url.searchParams.get('deep') ?? url.searchParams.get('dependencies') ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function withCredentialDegradations<T extends { degraded_credentials?: WorkerCredentialDegradation[] }>(
  result: T,
  degradedCredentials: WorkerCredentialDegradation[],
): T {
  if (degradedCredentials.length === 0) return result;
  const withCredentials = {
    ...result,
    degraded_credentials: [
      ...(result.degraded_credentials ?? []),
      ...degradedCredentials,
    ],
  };
  const embeddingLane = embeddingLaneDisabledState(withCredentials.degraded_credentials);
  const withStatus = ('status' in result || 'reachable' in result) && embeddingLane
    ? { ...withCredentials, status: 'degraded' }
    : withCredentials;
  if (!embeddingLane || !isSourceIndexStatusResult(withStatus)) return withStatus as T;
  return {
    ...withStatus,
    embedding_lane: embeddingLane,
    corpora: withStatus.corpora.map((corpus) => ({
      ...corpus,
      ...(corpusEmbeddingCanUseDegradedCredentials(corpus.embedding_policy) ? { embedding_lane: embeddingLane } : {}),
    })),
  } as T;
}

export function withCredentialReadiness<T extends object>(
  result: T,
  readyProfiles: WorkerCredentialReadiness[] | undefined,
): T {
  if (readyProfiles === undefined) return result;
  return {
    ...result,
    credential_readiness: {
      kind: 'worker_credential_readiness',
      ready_profiles: readyProfiles,
      policy: {
        raw_runtime_secrets_exposed: false,
        secret_refs_exposed: false,
      },
    },
  } as T;
}

function embeddingLaneDisabledState(
  degradedCredentials: readonly WorkerCredentialDegradation[],
): SourceIndexEmbeddingLaneState | undefined {
  const embeddingCredentials = degradedCredentials.filter((credential) =>
    credential.affected_capabilities?.includes('embedding')
    && (
      credential.state === 'retrying'
      || credential.state === 'stopped'
      || credential.state === 'resolved_restart_required'
    )
  );
  if (embeddingCredentials.length === 0) return undefined;
  const affectedProfiles = uniqueStrings(embeddingCredentials.flatMap((credential) => credential.affected_profiles ?? []));
  const affectedCapabilities = uniqueStrings(embeddingCredentials.flatMap((credential) => credential.affected_capabilities ?? []));
  return {
    state: 'embedding_lane_disabled',
    reason: 'embedding_provider_unavailable',
    affected_credentials: uniqueStrings(embeddingCredentials.map((credential) => credential.display_name)),
    ...(affectedProfiles.length > 0 ? { affected_profiles: affectedProfiles } : {}),
    ...(affectedCapabilities.length > 0 ? { affected_capabilities: affectedCapabilities } : {}),
    hint: 'Fix the affected credential, POST /v1/source/credentials/recheck, then restart the worker if the route reports resolved_restart_required.',
  };
}

function corpusEmbeddingCanUseDegradedCredentials(embeddingPolicy: string): boolean {
  return embeddingPolicy.includes('cloud') || embeddingPolicy.includes('allowed') || embeddingPolicy.includes('embedding');
}

function isSourceIndexStatusResult(value: unknown): value is SourceIndexStatusResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'source_index_status' && Array.isArray(record.corpora);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** The privacy-backlog count, or undefined when it cannot be read: a status read never fails a search or an answer. */
export function readPendingPrivacyItems(options: Pick<EmailSourceWorkerOptions, 'pendingPrivacyItems'>): number | undefined {
  try {
    return options.pendingPrivacyItems?.();
  } catch {
    return undefined;
  }
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The one place this worker emits HTML: the computer's local dashboard pages
 * and both OAuth landing pages. (The host page around the panel sets its own,
 * stricter policy.)
 *
 * The framing refusal is stated LAST so no caller can drop it by passing its
 * own header map. `SameSite=Strict` on the control cookie stops a cross-SITE
 * page from framing an unlocked dashboard with the cookie attached, but
 * same-site is registrable-domain-wide: another port or subdomain of this host
 * is same-site, and since the control cookie alone now renders GET /dashboard
 * (see http.ts) such a page could frame the real, controlled dashboard. It
 * could not READ that frame — same-origin policy — but it could position and
 * overlay it, which is the whole of clickjacking. Both headers, because
 * `frame-ancestors` is the modern one and `X-Frame-Options` is what older
 * engines obey; the relay's own `_headers` sends the same pair for the same
 * reason. CSP is otherwise unset on these responses, so `frame-ancestors` can
 * be a policy of its own rather than an addition to an existing one.
 */
export function html(value: string, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(value, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    },
  });
}
