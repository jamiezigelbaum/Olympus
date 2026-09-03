import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { configFromPluginConfig } from './core/config.ts';
import { createDelphiTransport, DelphiClient } from './core/delphi.ts';
import { createEmailTransport, EmailClient } from './core/email.ts';
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
import { createFileDeliveryTransport, FileDeliveryClient } from './core/file-delivery.ts';
import { createCastorWorkspaceTransport, CastorWorkspaceClient } from './core/castor-workspace.ts';
import { createDomainExpertTransport, DomainExpertClient } from './core/domain-expert-client.ts';
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
import { shouldExposeOperation } from './core/operation-exposure.ts';
import { workerAuthTokenFromConfig } from './core/worker-auth.ts';
import {
  SOURCE_WATCH_DELIVERY_HEADLINE,
  SOURCE_WATCH_DELIVERY_ROUTE,
  sourceWatchDeliveryMessage,
  type SourceWatchEvidencePointerPayload,
} from './workers/source-watch-runtime.ts';
import { SOURCE_WATCH_MAX_QUERY_LENGTH, type SourceWatchMode } from './core/source-watch.ts';
import { hasValidWorkerBearerToken } from './workers/http.ts';
import {
  OperationError,
  operations,
  operationDescription,
  operationToolSchema,
  type Operation,
  type OperationContext,
} from './core/operations.ts';
import { PUBLIC_RUNTIME_BUILD } from './core/build-flavor.ts';
import { isV04PublicOperation } from './core/public-surface.ts';
import {
  loadPrivateExtensions,
  type OlympusPrivateOperationToolRegistrar,
} from './private-extension-contract.ts';

/**
 * The private overlay is resolved once, at module scope, SYNCHRONOUSLY.
 *
 * OpenClaw's plugin loader is synchronous end to end — it `require()`s this
 * entry and falls back to a jiti source transform — so a top-level `await`
 * anywhere in this graph makes the built bundle unloadable on both legs and
 * every install fails before `register` is reached. Nothing in this file may
 * introduce one.
 *
 * A refusal here (version mismatch, malformed module) fails the plugin load,
 * which is the intended fail-closed behaviour: a private deployment must not
 * come up public.
 */
const privateExtensions = loadPrivateExtensions();

interface OpenClawPluginApi {
  pluginConfig?: unknown;
  config?: unknown;
  activeModel?: unknown;
  context?: { activeModel?: unknown };
  toolContext?: { activeModel?: unknown };
  registerTool(tool: NativeTool): void;
  registerHttpRoute?(route: {
    path: string;
    auth: 'plugin';
    match: 'exact';
    handler(request: IncomingMessage, response: ServerResponse): Promise<void>;
  }): void;
}

interface OpenClawPluginToolContext {
  agentId?: string;
  sessionId?: string;
  messageChannel?: string;
  agentAccountId?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
}

interface NativeRegistrationContext {
  activeModel?: unknown;
}

interface NativeTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<NativeToolResult>;
}

interface NativeToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: unknown;
  isError?: boolean;
}

function operationResult(operation: Operation, payload: unknown): NativeToolResult {
  return {
    content: [
      {
        type: 'text',
        text: contentTextForOperation(operation, payload),
      },
    ],
    details: payload,
  };
}

function contentTextForOperation(operation: Operation, payload: unknown): string {
  if (operation.name === 'source_answer') {
    const summary = sourceAnswerContentText(payload);
    if (summary) return summary;
  }
  return JSON.stringify(payload, null, 2);
}

function sourceAnswerContentText(payload: unknown): string | undefined {
  const result = asRecord(payload);
  if (!result || typeof result.answer !== 'string') return undefined;

  const audit = asRecord(result.audit);
  const policy = asRecord(result.policy);
  const synthesis = asRecord(audit?.answer_synthesis);
  const timings = asRecord(audit?.phase_timings);
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];
  const skipped = Array.isArray(audit?.skipped_corpora) ? audit.skipped_corpora : [];
  const lines = [
    'Answer:',
    result.answer,
    '',
    `Evidence: ${evidence.length === 0 ? 'none returned' : ''}`,
  ];

  evidence.slice(0, 8).forEach((item, index) => {
    const record = asRecord(item);
    if (!record) return;
    const label = firstString(record.source_label, record.title, record.corpus_id, 'source');
    const corpus = typeof record.corpus_id === 'string' ? ` [${record.corpus_id}]` : '';
    const date = firstString(record.authored_at, record.updated_at);
    const uri = typeof record.uri === 'string' ? ` ${record.uri}` : '';
    lines.push(`${index + 1}. ${label}${corpus}${date ? ` (${date})` : ''}${uri}`);
  });
  if (evidence.length > 8) lines.push(`... ${evidence.length - 8} more evidence item(s) kept in tool details.`);

  const coverageNotes = skipped
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .slice(0, 6)
    .map((item) => {
      const corpus = typeof item.corpus_id === 'string' ? item.corpus_id : 'unknown corpus';
      const reason = typeof item.reason === 'string' ? item.reason : 'skipped';
      return `${corpus}: ${reason}`;
    });
  lines.push('', `Coverage: ${coverageNotes.length === 0 ? 'no skipped corpora reported' : coverageNotes.join('; ')}`);

  const latency = typeof audit?.latency_ms === 'number' ? `${audit.latency_ms}ms total` : undefined;
  const evidenceMs = typeof timings?.evidence_pack_ms === 'number' ? `${timings.evidence_pack_ms}ms retrieval` : undefined;
  const analystMs = typeof timings?.analyst_ms === 'number' ? `${timings.analyst_ms}ms analyst` : undefined;
  const backend = typeof synthesis?.analyst_backend === 'string' ? synthesis.analyst_backend : undefined;
  lines.push(
    `Timing: ${[latency, evidenceMs, analystMs].filter(Boolean).join(', ') || 'not reported'}`,
    `Analyst: ${backend ?? 'not reported'}`,
    `Policy: raw_source_exposed=${policy?.raw_source_exposed === false ? 'false' : 'unknown'}, source_packets_exposed=${policy?.source_packets_exposed === false ? 'false' : 'unknown'}, castor_safe_bridge=${policy?.castor_safe_bridge === true ? 'true' : 'unknown'}`,
    '',
    'Full diagnostic audit remains available in tool details.',
  );

  return lines.join('\n');
}

function errorResult(error: OperationError): NativeToolResult {
  const payload = error.toJSON();
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
    isError: true,
  };
}

function nativeToolFromOperation(operation: Operation, ctx: OperationContext): NativeTool {
  return {
    name: operation.name,
    label: labelForOperation(operation),
    description: operationDescription(operation, { config: ctx.config }),
    parameters: operationToolSchema(operation, { config: ctx.config }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted?.();
      try {
        const result = await operation.handler(ctx, asParams(params));
        return operationResult(operation, result);
      } catch (error) {
        if (error instanceof OperationError) return errorResult(error);
        throw error;
      }
    },
  };
}

function labelForOperation(operation: Operation): string {
  return operation.name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function asParams(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

const plugin = {
  id: 'olympus',
  name: 'Olympus',
  description: 'Sovereignty-aware local model access for OpenClaw. v0.1 exposes Argus through the configured local model lane.',
  register(api: OpenClawPluginApi, registrationContext?: NativeRegistrationContext) {
    const config = configFromPluginConfig(api.pluginConfig);
    const activeModel = activeModelFromNativeContext(api, registrationContext);
    const ctx: OperationContext = {
      config,
      delphi: new DelphiClient(config, createDelphiTransport(config)),
      email: new EmailClient(config, createEmailTransport(config)),
      // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
      ...(PUBLIC_RUNTIME_BUILD ? {} : {
        fileDelivery: new FileDeliveryClient(config, createFileDeliveryTransport(config)),
        castorWorkspace: new CastorWorkspaceClient(config, createCastorWorkspaceTransport(config)),
        domainExpert: new DomainExpertClient(config, createDomainExpertTransport(config)),
      }),
      // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
      ...(privateExtensions?.extendOperationContext?.({ pluginConfig: api.pluginConfig, config }) ?? {}),
    };

    registerSourceWatchDeliveryRoute(api, config);

    const registeredToolNames: string[] = [];
    for (const operation of operations) {
      if (!shouldExposeOperation(operation, {
        config,
        surface: 'native',
        activeModel,
      })) continue;
      registeredToolNames.push(operation.name);
      if (isSourceWatchOperation(operation)) {
        api.registerTool(((toolContext: OpenClawPluginToolContext) => {
          const sourceWatchRoute = sourceWatchRouteFromToolContext(toolContext);
          return nativeToolFromOperation(operation, {
            ...ctx,
            ...(sourceWatchRoute ? { sourceWatchRoute } : {}),
          });
        }) as unknown as NativeTool);
      } else {
        api.registerTool(nativeToolFromOperation(operation, ctx));
      }
    }

    if (!privateExtensions?.register) return;
    // The overlay decides its own exposure, so the public positive lists in
    // `shouldExposeOperation` stay exactly as the public artifact evaluates
    // them. What it may not do is shadow or re-register a public tool.
    const registerOperationTool: OlympusPrivateOperationToolRegistrar = (operation, options) => {
      if (!operations.includes(operation)) {
        throw new Error(`Private extension ${privateExtensions.id} registered an unknown operation.`);
      }
      if (isV04PublicOperation('native', operation.name) || registeredToolNames.includes(operation.name)) {
        throw new Error(
          `Private extension ${privateExtensions.id} may not register the already-registered or public `
          + `tool ${operation.name}.`,
        );
      }
      registeredToolNames.push(operation.name);
      const extendToolContext = options?.toolContextExtension;
      if (!extendToolContext) {
        api.registerTool(nativeToolFromOperation(operation, ctx));
        return;
      }
      api.registerTool(((toolContext: OpenClawPluginToolContext) => nativeToolFromOperation(operation, {
        ...ctx,
        ...extendToolContext(toolContext as Readonly<Record<string, unknown>>),
      })) as unknown as NativeTool);
    };
    privateExtensions.register({
      api,
      pluginConfig: api.pluginConfig,
      config,
      activeModel,
      operations,
      context: ctx,
      registeredToolNames,
      isPublicNativeOperation: (operationName) => isV04PublicOperation('native', operationName),
      registerOperationTool,
    });
  },
};

interface OpenClawDurableSendResult {
  status: 'sent' | 'suppressed' | 'partial_failed' | 'failed';
  receipt?: {
    platformMessageIds?: unknown;
    sentAt?: unknown;
  };
}

type OpenClawDurableSend = (params: Record<string, unknown>) => Promise<OpenClawDurableSendResult>;

// The durable-outbound SDK is host-provided, so its absence is a runtime
// outage rather than a bad request. Typed so the gateway can say which.
class OpenClawDurableSendUnavailableError extends Error {}

export async function sendOpenClawSourceWatchDelivery(input: {
  openClawConfig: unknown;
  route: {
    kind: 'openclaw_channel';
    targetId: string;
    accountId?: string;
  };
  downstreamIdempotencyKey: string;
  payload: SourceWatchEvidencePointerPayload;
  sendDurableMessageBatch?: OpenClawDurableSend;
}): Promise<Record<string, unknown>> {
  const [channel, target] = splitChannelTarget(input.route.targetId);
  const send = input.sendDurableMessageBatch ?? await loadOpenClawDurableSend();
  let result: OpenClawDurableSendResult;
  let errorKind: string | undefined;
  try {
    result = await send({
      cfg: input.openClawConfig,
      channel,
      to: target,
      ...(input.route.accountId ? { accountId: input.route.accountId } : {}),
      payloads: [{ text: sourceWatchDeliveryMessage(input.payload) }],
      durability: 'required',
      bestEffort: false,
    });
  } catch {
    // Categorical only: the thrown cause can carry channel/target detail.
    result = { status: 'failed' };
    errorKind = 'openclaw_send_failed';
  }
  const receipt = result.receipt;
  return {
    status: result.status,
    ...(errorKind ? { error_kind: errorKind } : {}),
    downstream_idempotency_key: input.downstreamIdempotencyKey,
    downstream_idempotency: 'unsupported_by_openclaw_sdk',
    ...(receipt
      ? {
          receipt: {
            platform_message_ids: Array.isArray(receipt.platformMessageIds)
              ? receipt.platformMessageIds.filter((value): value is string => typeof value === 'string')
              : [],
            ...(typeof receipt.sentAt === 'number' ? { sent_at_ms: receipt.sentAt } : {}),
          },
        }
      : {}),
  };
}

export async function handleSourceWatchDeliveryGatewayRequest(input: {
  method: string;
  authorization: string | null;
  body: string;
  authToken?: string;
  openClawConfig: unknown;
  sendDurableMessageBatch?: OpenClawDurableSend;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!input.authToken) {
    return { status: 503, body: { status: 'failed', error_kind: 'watch_delivery_auth_unconfigured' } };
  }
  if (!hasValidWorkerBearerToken(input.authorization, input.authToken)) {
    return { status: 401, body: { status: 'failed', error_kind: 'unauthorized' } };
  }
  if (input.method !== 'POST') {
    return { status: 405, body: { status: 'failed', error_kind: 'method_not_allowed' } };
  }
  try {
    const request = parseSourceWatchDeliveryRequest(JSON.parse(input.body));
    if (request.route.kind === 'openclaw_task') {
      return { status: 200, body: { status: 'failed', error_kind: 'openclaw_task_deferred' } };
    }
    return {
      status: 200,
      body: await sendOpenClawSourceWatchDelivery({
        openClawConfig: input.openClawConfig,
        route: request.route,
        downstreamIdempotencyKey: request.downstreamIdempotencyKey,
        payload: request.payload,
        ...(input.sendDurableMessageBatch ? { sendDurableMessageBatch: input.sendDurableMessageBatch } : {}),
      }),
    };
  } catch (error) {
    if (error instanceof OpenClawDurableSendUnavailableError) {
      return { status: 503, body: { status: 'failed', error_kind: 'openclaw_sdk_unavailable' } };
    }
    return { status: 400, body: { status: 'failed', error_kind: 'invalid_request' } };
  }
}

function registerSourceWatchDeliveryRoute(api: OpenClawPluginApi, config: OperationContext['config']): void {
  if (!api.registerHttpRoute || !api.config) return;
  const authToken = workerAuthTokenFromConfig(config);
  api.registerHttpRoute({
    path: SOURCE_WATCH_DELIVERY_ROUTE,
    auth: 'plugin',
    match: 'exact',
    handler: async (request, response) => {
      let body: string;
      try {
        body = await readBoundedBody(request, 32 * 1024);
      } catch (error) {
        response.statusCode = error instanceof RequestBodyTooLargeError ? 413 : 400;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ status: 'failed', error_kind: 'invalid_request_body' }));
        return;
      }
      const result = await handleSourceWatchDeliveryGatewayRequest({
        method: request.method ?? '',
        authorization: typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : null,
        body,
        ...(authToken ? { authToken } : {}),
        openClawConfig: api.config,
      });
      response.statusCode = result.status;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result.body));
    },
  });
}

async function loadOpenClawDurableSend(): Promise<OpenClawDurableSend> {
  const moduleName = 'openclaw/plugin-sdk/channel-outbound';
  let sdk: { sendDurableMessageBatch?: OpenClawDurableSend };
  try {
    sdk = await import(moduleName) as { sendDurableMessageBatch?: OpenClawDurableSend };
  } catch {
    throw new OpenClawDurableSendUnavailableError('OpenClaw durable outbound SDK is unavailable.');
  }
  if (typeof sdk.sendDurableMessageBatch !== 'function') {
    throw new OpenClawDurableSendUnavailableError('OpenClaw durable outbound SDK is unavailable.');
  }
  return sdk.sendDurableMessageBatch;
}

function parseSourceWatchDeliveryRequest(value: unknown): {
  route: ({
    kind: 'openclaw_channel';
    targetId: string;
    accountId?: string;
  } | {
    kind: 'openclaw_task';
    targetId: string;
    accountId?: string;
  });
  downstreamIdempotencyKey: string;
  payload: SourceWatchEvidencePointerPayload;
} {
  const record = exactRecord(value, ['route', 'downstream_idempotency_key', 'payload']);
  const route = exactRecord(record.route, ['ownerId', 'kind', 'targetId', 'accountId']);
  const kind = route.kind;
  if (kind !== 'openclaw_channel' && kind !== 'openclaw_task') throw new TypeError('Invalid route kind.');
  const targetId = boundedString(route.targetId, 256);
  if (kind === 'openclaw_channel') splitChannelTarget(targetId);
  const payload = parseEvidencePointerPayload(record.payload);
  const downstreamIdempotencyKey = boundedString(record.downstream_idempotency_key, 64);
  if (!/^[a-f0-9]{64}$/.test(downstreamIdempotencyKey)) throw new TypeError('Invalid idempotency key.');
  return {
    route: {
      kind,
      targetId,
      ...(route.accountId === undefined ? {} : { accountId: boundedString(route.accountId, 256) }),
    },
    downstreamIdempotencyKey,
    payload,
  };
}

function parseEvidencePointerPayload(value: unknown): SourceWatchEvidencePointerPayload {
  const record = exactRecord(value, [
    'headline',
    'watch_id',
    'corpus_id',
    'query_text',
    'watch_mode',
    'match_count',
    'items',
  ]);
  if (record.headline !== SOURCE_WATCH_DELIVERY_HEADLINE || record.match_count !== 1) {
    throw new TypeError('Invalid watch delivery headline or match count.');
  }
  const watchMode = record.watch_mode;
  if (watchMode !== 'one_shot' && watchMode !== 'continuous') {
    throw new TypeError('Invalid watch delivery mode.');
  }
  if (!Array.isArray(record.items) || record.items.length !== 1) throw new TypeError('Invalid watch delivery items.');
  const item = exactRecord(record.items[0], ['local_item_id', 'source_version', 'matched_at']);
  const sourceVersion = boundedString(item.source_version, 64);
  const matchedAt = boundedString(item.matched_at, 64);
  if (!Number.isFinite(Date.parse(sourceVersion)) || !Number.isFinite(Date.parse(matchedAt))) {
    throw new TypeError('Invalid watch delivery timestamp.');
  }
  return {
    headline: SOURCE_WATCH_DELIVERY_HEADLINE,
    watch_id: boundedString(record.watch_id, 256),
    corpus_id: boundedString(record.corpus_id, 256),
    query_text: boundedString(record.query_text, SOURCE_WATCH_MAX_QUERY_LENGTH),
    watch_mode: watchMode as SourceWatchMode,
    match_count: 1,
    items: [{
      local_item_id: boundedString(item.local_item_id, 4_096),
      source_version: sourceVersion,
      matched_at: matchedAt,
    }],
  };
}

function splitChannelTarget(value: string): [string, string] {
  const match = /^(telegram|whatsapp|signal|discord|slack):([A-Za-z0-9][A-Za-z0-9._@/-]{0,191})$/.exec(value);
  if (!match) throw new TypeError('Invalid OpenClaw channel target.');
  return [match[1]!, match[2]!];
}

function exactRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const record = asRecord(value);
  if (!record || Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new TypeError('Invalid watch delivery object.');
  }
  return record;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('Invalid watch delivery string.');
  }
  return value;
}

async function readBoundedBody(request: IncomingMessage, maximumBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumBytes) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class RequestBodyTooLargeError extends Error {}

function isSourceWatchOperation(operation: Operation): boolean {
  return operation.requiresOpenClawSessionRoute === true;
}

export function sourceWatchRouteFromToolContext(
  context: OpenClawPluginToolContext,
): OperationContext['sourceWatchRoute'] {
  if (context.senderIsOwner !== true) return undefined;
  const ownerSeed = context.requesterSenderId?.trim() || context.agentId?.trim();
  if (!ownerSeed) return undefined;
  const ownerId = `owner:${createHash('sha256').update(ownerSeed, 'utf8').digest('hex')}`;
  const channel = (context.deliveryContext?.channel || context.messageChannel)?.trim().toLowerCase();
  const target = context.deliveryContext?.to?.trim();
  if (channel && target && ['telegram', 'whatsapp', 'signal', 'discord', 'slack'].includes(channel)) {
    const unprefixed = target.startsWith(`${channel}:`) ? target.slice(channel.length + 1) : target;
    if (/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,191}$/.test(unprefixed)) {
      return {
        ownerId,
        routeKind: 'openclaw_channel',
        routeTargetId: `${channel}:${unprefixed}`,
        ...(context.deliveryContext?.accountId || context.agentAccountId
          ? { routeAccountId: (context.deliveryContext?.accountId || context.agentAccountId)! }
          : {}),
      };
    }
  }
  if (context.sessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(context.sessionId)) {
    return {
      ownerId,
      routeKind: 'openclaw_task',
      routeTargetId: context.sessionId,
      ...(context.agentAccountId ? { routeAccountId: context.agentAccountId } : {}),
    };
  }
  return undefined;
}

function activeModelFromNativeContext(
  api: OpenClawPluginApi,
  registrationContext?: NativeRegistrationContext,
): unknown {
  return (
    api.activeModel
    ?? api.context?.activeModel
    ?? api.toolContext?.activeModel
    ?? registrationContext?.activeModel
  );
}

export default plugin;
