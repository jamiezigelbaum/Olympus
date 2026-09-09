import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import {
  createTrustedSourceWatchOwnerContext,
  SOURCE_WATCH_MAX_QUERY_LENGTH,
  SOURCE_WATCH_MIN_LEASE_MS,
  SOURCE_WATCH_MIN_RETRY_MS,
  SOURCE_WATCH_OWNER_HEADER,
  SOURCE_WATCH_ROUTE_ACCOUNT_HEADER,
  SOURCE_WATCH_ROUTE_KIND_HEADER,
  SOURCE_WATCH_ROUTE_TARGET_HEADER,
  type CreateSourceWatchInput,
  type LocalSourceWatchStore,
  type PersistedSourceWatch,
  type SourceWatchCanonicalRef,
  type SourceWatchDeliveryLease,
  type SourceWatchDeliverySummary,
  type SourceWatchExecutorCapability,
  type SourceWatchMode,
  type SourceWatchRouteKind,
  type TrustedSourceWatchOwnerContext,
} from '../core/source-watch.ts';
import { fetchWithTimeout, type TimeoutFetch } from '../core/http-timeout.ts';
import { normalizeWorkerAuthToken, withWorkerAuthHeader } from '../core/worker-auth.ts';
import { canonicalSourceCorpusId } from '../core/source-corpus-registry.ts';
import { routeSourceIndexSearch } from '../core/source-index/router.ts';
import type { AnalystAnswerLanes } from './source-index/analyst-answer.ts';
import type { SourceIndexAnswerRequest } from './source-index/answer-types.ts';

export interface SourceWatchSearchHit {
  ref: SourceWatchCanonicalRef;
  sourceObservedAt: string;
}

export interface SourceWatchSearch {
  search(input: { corpusId: string; query: string; maxResults: number }): Promise<readonly SourceWatchSearchHit[]>;
}

export interface SourceWatchPublicView {
  watch_id: string;
  corpus_id: string;
  query_sha256: string;
  mode: SourceWatchMode;
  status: PersistedSourceWatch['status'];
  created_at: string;
  updated_at: string;
  expires_at?: string;
  cancelled_at?: string;
  cancel_reason?: string;
  completed_at?: string;
  delivery: {
    pending_count: number;
    in_flight_count: number;
    retry_count: number;
    delivered_count: number;
    dead_letter_count: number;
    cancelled_count: number;
    attempts: number;
    last_error_kind?: string;
  };
}

export const SOURCE_WATCH_DELIVERY_ROUTE = '/plugins/olympus/watch-delivery';
export const SOURCE_WATCH_DELIVERY_HEADLINE = 'Olympus watch matched newly indexed evidence.';
export const SOURCE_WATCH_DELIVERY_LEASE_MS = Math.max(SOURCE_WATCH_MIN_LEASE_MS, 60_000);
export const SOURCE_WATCH_DELIVERY_RETRY_MS = Math.max(SOURCE_WATCH_MIN_RETRY_MS, 60_000);

export interface SourceWatchEvidencePointerPayload {
  headline: typeof SOURCE_WATCH_DELIVERY_HEADLINE;
  watch_id: string;
  corpus_id: string;
  query_text: string;
  watch_mode: SourceWatchMode;
  match_count: 1;
  items: Array<{
    local_item_id: string;
    source_version: string;
    matched_at: string;
  }>;
}

export interface SourceWatchDeliveryReceipt {
  transport: 'openclaw_sdk_durable';
  outcome: 'sent';
  platform_message_ids: string[];
  downstream_idempotency: 'unsupported_by_openclaw_sdk';
}

export type SourceWatchTransportResult = {
  status: 'delivered';
  receipt: SourceWatchDeliveryReceipt;
} | {
  status: 'failed';
  errorKind: string;
};

export interface SourceWatchDeliveryTransport {
  send(lease: SourceWatchDeliveryLease): Promise<SourceWatchTransportResult>;
}

/** The supported OpenClaw gateway fields used by the worker bridge. */
export interface SourceWatchGatewayConfig {
  gateway?: {
    port?: unknown;
    tls?: {
      enabled?: unknown;
      certPath?: unknown;
    };
  };
}

export interface SourceWatchGatewayConnection {
  baseUrl: string;
  /** Public trust material only; never the gateway private key. */
  certificatePath?: string;
}

export const SOURCE_WATCH_POLICY = Object.freeze({
  raw_source_exposed: false as const,
  source_text_returned: false as const,
  message_bodies_returned: false as const,
  evidence_pointers_only: true as const,
});

export function trustedSourceWatchOwnerFromRequest(request: Request): TrustedSourceWatchOwnerContext {
  const ownerId = request.headers.get(SOURCE_WATCH_OWNER_HEADER);
  const routeKind = request.headers.get(SOURCE_WATCH_ROUTE_KIND_HEADER);
  const routeTargetId = request.headers.get(SOURCE_WATCH_ROUTE_TARGET_HEADER);
  const routeAccountId = request.headers.get(SOURCE_WATCH_ROUTE_ACCOUNT_HEADER);
  if (!ownerId || !routeKind || !routeTargetId) throw new Error('Missing authenticated watch route.');
  return createTrustedSourceWatchOwnerContext({
    ownerId,
    routeKind: routeKind as SourceWatchRouteKind,
    routeTargetId,
    ...(routeAccountId ? { routeAccountId } : {}),
  });
}

export function createSourceWatchSearchFromAnalystLanes(
  lanes: (request: SourceIndexAnswerRequest) => AnalystAnswerLanes,
): SourceWatchSearch {
  return {
    async search(input) {
      // A watch persists its corpus id, so this reads ids written by earlier
      // builds. Rows created before the create route resolved aliases still
      // carry one, and the source-index registry does not hold alias entries -
      // registry.require would throw on it, and because the evaluation pass does
      // not isolate a single watch's failure, one such row would take down the
      // pass for every other watch. Resolving here keeps that contained.
      const corpusId = canonicalSourceCorpusId(input.corpusId);
      const configured = lanes({
        question: input.query,
        corpus_id: corpusId,
        retrieval_mode: 'keyword',
        include_internal: true,
        include_secure_local: true,
        max_results: input.maxResults,
      });
      const corpus = configured.registry.require(corpusId);
      const routed = await routeSourceIndexSearch({
        registry: configured.registry,
        adapters: configured.adapters,
        request: {
          query: input.query,
          maxResults: input.maxResults,
          corpusIds: [corpusId],
          context: {
            allowedTrustDomains: [corpus.trustDomain],
            allowedCorpusIds: [corpusId],
            allowCloudQueries: true,
          },
        },
      });
      return routed.hits.map((hit) => ({
        ref: {
          corpusId: hit.corpusId,
          localItemId: hit.sourceItem.localItemId,
          sourceVersion: hit.sourceItem.sourceVersion
            ?? hit.provenance?.chunk?.contentHash
            ?? sha256(JSON.stringify(hit.sourceItem)),
        },
        sourceObservedAt: observedAt(hit),
      }));
    },
  };
}

export function sourceWatchPublicView(
  watch: PersistedSourceWatch,
  delivery: SourceWatchDeliverySummary,
): SourceWatchPublicView {
  return {
    watch_id: watch.watchId,
    corpus_id: watch.corpusId,
    query_sha256: sha256(watch.queryText),
    mode: watch.mode,
    status: watch.status,
    created_at: watch.createdAt,
    updated_at: watch.updatedAt,
    ...(watch.expiresAt ? { expires_at: watch.expiresAt } : {}),
    ...(watch.cancelledAt ? { cancelled_at: watch.cancelledAt } : {}),
    ...(watch.cancelReason ? { cancel_reason: watch.cancelReason } : {}),
    ...(watch.completedAt ? { completed_at: watch.completedAt } : {}),
    delivery: {
      pending_count: delivery.pendingCount,
      in_flight_count: delivery.inFlightCount,
      retry_count: delivery.retryCount,
      delivered_count: delivery.deliveredCount,
      dead_letter_count: delivery.deadLetterCount,
      cancelled_count: delivery.cancelledCount,
      attempts: delivery.attempts,
      ...(delivery.lastErrorKind ? { last_error_kind: delivery.lastErrorKind } : {}),
    },
  };
}

export function createSourceWatchPublicView(input: {
  store: LocalSourceWatchStore;
  create: CreateSourceWatchInput;
  owner: TrustedSourceWatchOwnerContext;
}): SourceWatchPublicView {
  const watch = input.store.createWatch(input.create, input.owner);
  return sourceWatchPublicView(watch, input.store.deliverySummary(input.owner, watch.watchId));
}

export function listSourceWatchPublicViews(input: {
  store: LocalSourceWatchStore;
  owner: TrustedSourceWatchOwnerContext;
  limit?: number;
  cursor?: string;
}) {
  const page = input.store.listWatches(input.owner, {
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  return {
    kind: 'source_watches' as const,
    watches: page.items.map((watch) => sourceWatchPublicView(
      watch,
      input.store.deliverySummary(input.owner, watch.watchId),
    )),
    ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
    policy: SOURCE_WATCH_POLICY,
  };
}

export function sourceWatchEvidencePointerPayload(
  lease: SourceWatchDeliveryLease,
): SourceWatchEvidencePointerPayload {
  return {
    headline: SOURCE_WATCH_DELIVERY_HEADLINE,
    watch_id: deliveryString(lease.watchId, 256),
    corpus_id: deliveryString(lease.corpusId, 256),
    query_text: deliveryQueryText(lease.queryText),
    watch_mode: deliveryWatchMode(lease.watchMode),
    match_count: 1,
    items: [{
      local_item_id: deliveryString(lease.ref.localItemId, 4_096),
      source_version: deliveryTimestamp(lease.ref.sourceVersion),
      matched_at: deliveryTimestamp(lease.matchedAt),
    }],
  };
}

export function sourceWatchDeliveryMessage(payload: SourceWatchEvidencePointerPayload): string {
  const item = payload.items[0];
  if (!item) throw new TypeError('Source watch delivery requires one evidence pointer.');
  return [
    `Olympus: your watch for ${JSON.stringify(payload.query_text)} matched 1 newly indexed item in ${payload.corpus_id}.`,
    `Item authored ${humanUtcMinute(item.source_version)}; indexed and matched ${humanUtcMinute(item.matched_at)}.`,
    payload.watch_mode === 'one_shot'
      ? 'This was a one-shot watch — it is now complete.'
      : 'The watch stays active.',
    `ref: watch ${payload.watch_id.slice(0, 8)} · item ${item.local_item_id}`,
  ].join('\n');
}

function deliveryString(value: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('Invalid watch delivery string.');
  }
  return value;
}

function deliveryQueryText(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > SOURCE_WATCH_MAX_QUERY_LENGTH) {
    throw new TypeError('Invalid watch delivery query.');
  }
  const sanitized = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!sanitized) throw new TypeError('Invalid watch delivery query.');
  return sanitized;
}

function deliveryWatchMode(value: SourceWatchMode): SourceWatchMode {
  if (value !== 'one_shot' && value !== 'continuous') throw new TypeError('Invalid watch delivery mode.');
  return value;
}

function deliveryTimestamp(value: string): string {
  const bounded = deliveryString(value, 64);
  if (!Number.isFinite(Date.parse(bounded))) throw new TypeError('Invalid watch delivery timestamp.');
  return bounded;
}

function humanUtcMinute(value: string): string {
  const iso = new Date(deliveryTimestamp(value)).toISOString();
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

export class OpenClawSourceWatchDeliveryTransport implements SourceWatchDeliveryTransport {
  private readonly fetchImpl: TimeoutFetch;
  private readonly authToken: string | undefined;
  private readonly baseUrl: string;
  private readonly caPem: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: {
    fetchImpl?: TimeoutFetch;
    authToken?: string;
    baseUrl?: string;
    gatewayConfig?: unknown;
    gatewayPort?: number;
    env?: Record<string, string | undefined>;
    /** Explicit public certificate path for a test or a resolved config. */
    publicCertificatePath?: string;
    timeoutMs?: number;
  } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authToken = normalizeWorkerAuthToken(options.authToken);
    const env = options.env ?? process.env;
    const configured = options.gatewayConfig === undefined
      ? undefined
      : resolveSourceWatchGatewayConnection(options.gatewayConfig, {
          env,
          ...(options.gatewayPort !== undefined ? { gatewayPort: options.gatewayPort } : {}),
        });
    const configuredUrl = configured?.baseUrl;
    const baseUrl = normalizeGatewayBaseUrl(options.baseUrl ?? configuredUrl ?? defaultOpenClawGatewayBaseUrl(env));
    if (configuredUrl && options.baseUrl && new URL(options.baseUrl).protocol !== new URL(configuredUrl).protocol) {
      throw new TypeError('Source watch delivery gateway URL does not match gateway.tls.enabled.');
    }
    this.baseUrl = baseUrl;
    const trustPath = options.publicCertificatePath ?? configured?.certificatePath;
    if (new URL(baseUrl).protocol === 'https:') {
      if (!trustPath) {
        throw new TypeError('Source watch HTTPS gateway requires gateway.tls.certPath.');
      }
      try {
        this.caPem = readFileSync(trustPath, 'utf8');
      } catch {
        throw new TypeError('Source watch HTTPS gateway public certificate could not be read.');
      }
      if (!this.caPem.trim()) {
        throw new TypeError('Source watch HTTPS gateway public certificate is empty.');
      }
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async send(lease: SourceWatchDeliveryLease): Promise<SourceWatchTransportResult> {
    if (lease.route.kind === 'openclaw_task') {
      return { status: 'failed', errorKind: 'openclaw_task_deferred' };
    }
    if (!this.authToken) {
      return { status: 'failed', errorKind: 'watch_delivery_auth_unconfigured' };
    }
    let response: Response;
    try {
      const requestInit = withWorkerAuthHeader({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          route: lease.route,
          downstream_idempotency_key: lease.downstreamIdempotencyKey,
          payload: sourceWatchEvidencePointerPayload(lease),
        }),
        redirect: 'error',
      }, this.authToken);
      const url = `${this.baseUrl}${SOURCE_WATCH_DELIVERY_ROUTE}`;
      response = this.caPem
        ? await requestVerifiedHttps(url, requestInit, this.timeoutMs, this.caPem)
        : await fetchWithTimeout(this.fetchImpl, url, requestInit, this.timeoutMs);
    } catch {
      return { status: 'failed', errorKind: 'openclaw_gateway_unreachable' };
    }
    if (!response.ok) {
      return { status: 'failed', errorKind: `openclaw_gateway_http_${response.status}` };
    }
    const result = await response.json().catch(() => undefined) as unknown;
    const record = asRecord(result);
    if (record?.status !== 'sent') {
      const outcome = typeof record?.status === 'string' ? record.status : 'invalid_response';
      return { status: 'failed', errorKind: safeErrorKind(`openclaw_${outcome}`) };
    }
    const receipt = asRecord(record.receipt);
    return {
      status: 'delivered',
      receipt: {
        transport: 'openclaw_sdk_durable',
        outcome: 'sent',
        platform_message_ids: Array.isArray(receipt?.platform_message_ids)
          ? receipt.platform_message_ids.filter((value): value is string => typeof value === 'string')
          : [],
        downstream_idempotency: 'unsupported_by_openclaw_sdk',
      },
    };
  }
}

export function defaultOpenClawGatewayBaseUrl(
  env: Record<string, string | undefined> = process.env,
  gatewayConfig?: unknown,
): string {
  return resolveSourceWatchGatewayConnection(gatewayConfig, { env }).baseUrl;
}

export async function runSourceWatchDeliveryPass(input: {
  store: LocalSourceWatchStore;
  transport: SourceWatchDeliveryTransport;
  executor: SourceWatchExecutorCapability;
  leaseDurationMs?: number;
  retryAfterMs?: number;
  limit?: number;
}) {
  const leases = input.store.leaseDeliveries(input.executor, {
    leaseDurationMs: input.leaseDurationMs ?? SOURCE_WATCH_DELIVERY_LEASE_MS,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  const counts = {
    deliveries_leased: leases.length,
    deliveries_delivered: 0,
    deliveries_retried: 0,
    deliveries_dead_lettered: 0,
    delivery_fences_rejected: 0,
  };
  for (const lease of leases) {
    let result: SourceWatchTransportResult;
    try {
      result = await input.transport.send(lease);
    } catch {
      result = { status: 'failed', errorKind: 'transport_exception' };
    }
    try {
      if (result.status === 'delivered') {
        input.store.recordDelivered(input.executor, leaseFence(lease));
        counts.deliveries_delivered += 1;
        continue;
      }
      const failure = input.store.recordDeliveryFailure(input.executor, {
        ...leaseFence(lease),
        retryAfterMs: input.retryAfterMs ?? SOURCE_WATCH_DELIVERY_RETRY_MS,
        errorKind: safeErrorKind(result.errorKind),
        errorHash: sha256(result.errorKind),
      });
      if (failure.status === 'dead_letter') counts.deliveries_dead_lettered += 1;
      else counts.deliveries_retried += 1;
    } catch (error) {
      if (!isDeliveryFenceRejection(error)) throw error;
      counts.delivery_fences_rejected += 1;
    }
  }
  return {
    status: leases.length > 0 ? 'progress' as const : 'idle' as const,
    counts,
    ...(leases.some((lease) => lease.route.kind === 'openclaw_task')
      ? { warnings: ['openclaw_task watch delivery is deferred; the attempt was recorded for bounded retry/dead-letter handling.'] }
      : {}),
  };
}

/** Runs both scheduler responsibilities without allowing one lane to starve the other. */
export async function runSourceWatchSchedulerPass(input: {
  store: LocalSourceWatchStore;
  search: SourceWatchSearch;
  transport: SourceWatchDeliveryTransport;
  executor: SourceWatchExecutorCapability;
}) {
  let evaluation: Awaited<ReturnType<typeof runSourceWatchEvaluationPass>> | undefined;
  let delivery: Awaited<ReturnType<typeof runSourceWatchDeliveryPass>> | undefined;
  const failures: unknown[] = [];
  try {
    evaluation = await runSourceWatchEvaluationPass(input);
  } catch (error) {
    failures.push(error);
  }
  try {
    delivery = await runSourceWatchDeliveryPass(input);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Source watch evaluation and delivery both failed.');
  if (!evaluation || !delivery) throw new Error('Source watch scheduler pass did not produce a result.');
  return {
    status: evaluation.status === 'progress' || delivery.status === 'progress'
      ? 'progress' as const
      : 'idle' as const,
    counts: { ...evaluation.counts, ...delivery.counts },
    ...(delivery.warnings ? { warnings: delivery.warnings } : {}),
  };
}

export async function runSourceWatchEvaluationPass(input: {
  store: LocalSourceWatchStore;
  search: SourceWatchSearch;
  executor: SourceWatchExecutorCapability;
  maxWatches?: number;
  maxResultsPerWatch?: number;
}) {
  const maxWatches = input.maxWatches ?? 100;
  const counts = {
    watches_evaluated: 0,
    hits_observed: 0,
    matches_recorded: 0,
    watermarks_advanced: 0,
    watches_skipped_inactive: 0,
  };
  input.store.expireDueWatches(input.executor, { limit: maxWatches });
  const watches = input.store.listExecutableWatches(input.executor, { limit: maxWatches }).items;
  for (const watch of watches) {
    counts.watches_evaluated += 1;
    try {
      const hits = [...await input.search.search({
        corpusId: watch.corpusId,
        query: watch.queryText,
        maxResults: input.maxResultsPerWatch ?? 100,
      })].sort(compareHits);
      counts.hits_observed += hits.length;
      let watermark = input.store.getWatermark(input.executor, watch.watchId, watch.corpusId);
      for (const hit of hits) {
        if (hit.ref.corpusId !== watch.corpusId) continue;
        if (hit.sourceObservedAt <= watch.createdAt || (watermark && compareToWatermark(hit, watermark) <= 0)) continue;
        input.store.recordMatch(input.executor, { watchId: watch.watchId, ref: hit.ref });
        counts.matches_recorded += 1;
        if (watch.mode === 'one_shot') break;
        input.store.recordWatermark(input.executor, {
          watchId: watch.watchId,
          ref: hit.ref,
          sourceObservedAt: hit.sourceObservedAt,
        });
        counts.watermarks_advanced += 1;
        watermark = input.store.getWatermark(input.executor, watch.watchId, watch.corpusId);
      }
    } catch (error) {
      // The watch list is read once and each search is awaited, so a watch can
      // be cancelled or reach its expiry inside its own awaited window; the
      // store then rejects the match by design. The delivery pass isolates the
      // same class of mid-flight lifecycle change per lease, and without the
      // same isolation here one such watch skips every other watch on the tick
      // and fails the shared scheduler task.
      if (!isWatchLifecycleRejection(error)) throw error;
      counts.watches_skipped_inactive += 1;
    }
  }
  return {
    status: counts.matches_recorded > 0 || counts.watermarks_advanced > 0 ? 'progress' as const : 'idle' as const,
    counts,
  };
}

/**
 * Resolve the worker's loopback target from OpenClaw's already-resolved
 * Gateway settings. The worker only consumes the public certificate path;
 * `gateway.tls.keyPath` is deliberately outside this shape.
 */
export function resolveSourceWatchGatewayConnection(
  config: unknown,
  options: {
    env?: Record<string, string | undefined>;
    gatewayPort?: number;
  } = {},
): SourceWatchGatewayConnection {
  const env = options.env ?? process.env;
  const gateway = asRecord(asRecord(config)?.gateway);
  const tls = asRecord(gateway?.tls);
  if (tls?.enabled !== undefined && typeof tls.enabled !== 'boolean') {
    throw new TypeError('OpenClaw gateway.tls.enabled must be a boolean.');
  }
  const tlsEnabled = tls?.enabled === true;
  const port = resolveGatewayPortValue(options.gatewayPort ?? gateway?.port, env);
  let certificatePath: string | undefined;
  if (tlsEnabled) {
    // `caPath` is OpenClaw's server-side client-verification CA, not the
    // certificate the worker is connecting to. Trust the configured public
    // server certificate, which is the right root for Air's self-signed leaf.
    certificatePath = resolvePublicCertificatePath(tls?.certPath, env, 'gateway.tls.certPath');
    if (!certificatePath) {
      // OpenClaw's auto-generated certificate historically used a CN-only
      // certificate. Requiring an authored public trust path makes the
      // localhost SAN requirement explicit instead of silently trusting it.
      throw new TypeError('OpenClaw HTTPS gateway requires gateway.tls.certPath.');
    }
  }
  return {
    baseUrl: normalizeGatewayBaseUrl(`${tlsEnabled ? 'https' : 'http'}://127.0.0.1:${port}`),
    ...(certificatePath ? { certificatePath } : {}),
  };
}

/**
 * Read the active Gateway config through OpenClaw's supported read-only CLI.
 * This keeps the source worker aligned with config includes, profiles, and
 * environment resolution without copying those rules into Olympus.
 */
export async function loadOpenClawGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<unknown | undefined> {
  const command = resolveOpenClawCommand(env);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([command, 'config', 'get', 'gateway', '--json'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    });
  } catch {
    return undefined;
  }
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    const [stdout, code] = await Promise.all([
      new Response(child.stdout as unknown as BodyInit).text(),
      child.exited,
    ]);
    if (code !== 0) {
      throw new Error('OpenClaw gateway configuration could not be resolved.');
    }
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw new Error('OpenClaw gateway configuration returned no JSON.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.slice(start, end + 1)) as unknown;
    } catch {
      throw new Error('OpenClaw gateway configuration returned invalid JSON.');
    }
    const record = asRecord(parsed);
    if (!record || record.ok === false) {
      throw new Error('OpenClaw gateway configuration was refused.');
    }
    return record;
  } finally {
    clearTimeout(timer);
  }
}

function observedAt(hit: Awaited<ReturnType<typeof routeSourceIndexSearch>>['hits'][number]): string {
  for (const value of [
    hit.provenance?.citation?.updatedAt,
    hit.internalContent?.savedAt,
    hit.internalContent?.authoredAt,
    hit.provenance?.citation?.authoredAt,
  ]) {
    if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return '1970-01-01T00:00:00.000Z';
}

function compareHits(left: SourceWatchSearchHit, right: SourceWatchSearchHit): number {
  return left.sourceObservedAt.localeCompare(right.sourceObservedAt)
    || left.ref.localItemId.localeCompare(right.ref.localItemId)
    || left.ref.sourceVersion.localeCompare(right.ref.sourceVersion);
}

function compareToWatermark(
  hit: SourceWatchSearchHit,
  watermark: { ref: SourceWatchCanonicalRef; sourceObservedAt: string },
): number {
  return hit.sourceObservedAt.localeCompare(watermark.sourceObservedAt)
    || hit.ref.localItemId.localeCompare(watermark.ref.localItemId)
    || hit.ref.sourceVersion.localeCompare(watermark.ref.sourceVersion);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function leaseFence(lease: SourceWatchDeliveryLease) {
  return {
    deliveryKey: lease.deliveryKey,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
  };
}

function resolveGatewayPortValue(
  configuredPort: unknown,
  env: Record<string, string | undefined>,
): number {
  const envPort = parseGatewayPort(env.OPENCLAW_GATEWAY_PORT);
  if (envPort !== undefined) return envPort;
  if (configuredPort !== undefined && configuredPort !== null) {
    if (typeof configuredPort !== 'number' || !Number.isFinite(configuredPort) || !Number.isSafeInteger(configuredPort)) {
      throw new TypeError('OpenClaw gateway.port must be an integer port.');
    }
    if (configuredPort > 0 && configuredPort <= 65_535) return configuredPort;
  }
  return 18_789;
}

function parseGatewayPort(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const numeric = /^\d+$/.test(trimmed)
    ? trimmed
    : /^(?:[^:[\]]+|\[[^\]]+\]):(\d+)$/.exec(trimmed)?.[1];
  if (!numeric) throw new TypeError('OPENCLAW_GATEWAY_PORT must be an integer port.');
  const port = Number(numeric);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('OPENCLAW_GATEWAY_PORT must be an integer port from 1 through 65535.');
  }
  return port;
}

function resolvePublicCertificatePath(
  value: unknown,
  env: Record<string, string | undefined>,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`OpenClaw ${field} must be a non-empty path.`);
  }
  const trimmed = value.trim();
  const home = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || homedir();
  const expanded = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
    ? `${home}${trimmed.slice(1)}`
    : trimmed;
  return resolvePath(expanded);
}

function resolveOpenClawCommand(env: Record<string, string | undefined>): string {
  const pathEntries = env.PATH?.split(':').map((entry) => entry.trim()).filter(Boolean) ?? [];
  for (const entry of pathEntries) {
    const candidate = resolvePath(entry, 'openclaw');
    if (existsSync(candidate)) return candidate;
  }
  const found = Bun.which('openclaw');
  if (found) return found;
  const home = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || homedir();
  for (const candidate of [
    '/opt/homebrew/bin/openclaw',
    '/usr/local/bin/openclaw',
    resolvePath(home, '.openclaw', 'bin', 'openclaw'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'openclaw';
}

function normalizeGatewayBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new TypeError('Source watch delivery gateway must use loopback HTTP(S).');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new TypeError('Source watch delivery gateway base URL must not contain credentials, path, query, or fragment.');
  }
  return url.origin;
}

function requestVerifiedHttps(
  urlValue: string,
  init: RequestInit,
  timeoutMs: number,
  ca: string,
): Promise<Response> {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:') throw new TypeError('Verified HTTPS request requires an HTTPS URL.');
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const servername = hostname.includes(':') ? undefined : hostname;
  const body = init.body;
  if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
    throw new TypeError('Source watch HTTPS request body must be text or bytes.');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    let request: ReturnType<typeof httpsRequest> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      removeAbortListener?.();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      request?.destroy();
      reject(error);
    };
    const succeed = (response: Response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const abort = () => {
      const error = new Error('Source watch HTTPS request aborted.');
      error.name = 'AbortError';
      fail(error);
    };
    try {
      request = httpsRequest({
        protocol: 'https:',
        hostname,
        ...(url.port ? { port: Number(url.port) } : {}),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers,
        ca,
        rejectUnauthorized: true,
        ...(servername ? { servername } : {}),
        checkServerIdentity,
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item));
            else if (value !== undefined) responseHeaders.set(key, value);
          }
          succeed(new Response(Buffer.concat(chunks), {
            status: incoming.statusCode ?? 0,
            statusText: incoming.statusMessage ?? '',
            headers: responseHeaders,
          }));
        });
        incoming.on('error', fail);
      });
      request.on('error', fail);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => abort(), timeoutMs);
        request.setTimeout(timeoutMs, abort);
      }
      if (init.signal) {
        if (init.signal.aborted) abort();
        else {
          const abortFromUpstream = () => abort();
          init.signal.addEventListener('abort', abortFromUpstream, { once: true });
          removeAbortListener = () => init.signal?.removeEventListener('abort', abortFromUpstream);
        }
      }
      if (settled) return;
      if (body === undefined) request.end();
      else request.end(typeof body === 'string' ? body : Buffer.from(body));
    } catch (error) {
      fail(error);
    }
  });
}

function safeErrorKind(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._:-]+/g, '_').slice(0, 128);
  return normalized || 'watch_delivery_failed';
}

function isWatchLifecycleRejection(error: unknown): boolean {
  return error instanceof Error
    && /cannot accept a new match|cannot advance its watermark|source watch target does not exist/i.test(error.message);
}

function isDeliveryFenceRejection(error: unknown): boolean {
  return error instanceof Error
    && /lease fence|not actively leased|another executor|lease has expired/i.test(error.message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
