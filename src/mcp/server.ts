import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../core/config.ts';
import { createDelphiTransport, DelphiClient } from '../core/delphi.ts';
import { createEmailTransport, EmailClient } from '../core/email.ts';
import { callerProviderFromLabel, sanitizeCallerDisplayName, type OperationCaller } from '../core/operation-caller.ts';
import { shouldExposeOperation, type OperationSurface } from '../core/operation-exposure.ts';
import { findOperationByName, operations, OperationError } from '../core/operations.ts';
import { isV04PublicOperation } from '../core/public-surface.ts';
import { createReleaseManifestSink, runWithReleaseManifestSink } from '../core/release-manifest.ts';
import {
  remoteDeclaredParams,
  remoteErrorOutput,
  remoteOperationOutput,
  withRemotePrivateNote,
  remoteSurfaceErrorOutput,
  remoteWithheldParam,
  remoteWithheldParamOutput,
} from '../core/remote-result.ts';
import { SourceAnswerJobRegistry, sourceAnswerJobLimitsFromEnv, sourceAnswerJobOwner } from '../core/source-answer-jobs.ts';
import type { OperationContext } from '../core/operations.ts';
import { VERSION } from '../version.ts';
import { listMcpTools } from './tools.ts';

type McpSurface = Extract<OperationSurface, 'mcp' | 'remote'>;

export interface McpCallToolRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown> | undefined;
  };
}

export interface McpCallToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type McpListedTool = ReturnType<typeof listMcpTools>[number];

/**
 * Tools a host adds to a surface beside its operations, and calls it answers
 * itself: the remote endpoint's evidence search (workers/remote-search.ts).
 * `next` runs the surface's own handling for a call the host does not take.
 */
export interface McpServerExtension {
  tools: (listed: McpListedTool[]) => McpListedTool[];
  call: (request: McpCallToolRequest, next: () => Promise<McpCallToolResult>, signal?: AbortSignal) => Promise<McpCallToolResult>;
}

export async function handleMcpCallTool(
  request: McpCallToolRequest,
  makeOperationContext: () => OperationContext = makeContext,
  surface: McpSurface = 'mcp',
): Promise<McpCallToolResult> {
  if (surface === 'remote') return handleRemoteCallTool(request, makeOperationContext);
  const operation = findOperationByName(request.params.name);
  if (!operation) {
    throw new OperationError('invalid_params', `Unknown Olympus operation: ${request.params.name}`);
  }
  const ctx = makeOperationContext();
  if (!shouldExposeOperation(operation, { config: ctx.config, surface })) {
    throw new OperationError(
      'invalid_params',
      `Olympus operation is not available on this MCP surface: ${operation.name}`,
      'Enable the matching product or operator configuration for this Olympus surface.',
    );
  }
  const result = await operation.handler(ctx, request.params.arguments ?? {});
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/**
 * The remote surface (`/mcp` for every non-ChatGPT connection): each
 * operation's allowlisted output (core/remote-result.ts) rather than the
 * serialized operation result, and every failure a tool error with a fixed
 * sentence per code rather than the internal message.
 *
 * The call runs inside its own release-manifest sink, so a source answer's
 * manifest (or, for source_answer_result, its job's) is revalidated against
 * the current tiers before the answer leaves.
 */
async function handleRemoteCallTool(
  request: McpCallToolRequest,
  makeOperationContext: () => OperationContext,
): Promise<McpCallToolResult> {
  const text = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }];
  const operation = findOperationByName(request.params.name);
  if (!operation || !isV04PublicOperation('remote', operation.name)) {
    return { content: text(remoteSurfaceErrorOutput('unknown_operation')), isError: true };
  }
  const ctx = makeOperationContext();
  if (!shouldExposeOperation(operation, { config: ctx.config, surface: 'remote' })) {
    return { content: text(remoteSurfaceErrorOutput('operation_unavailable')), isError: true };
  }
  const args = request.params.arguments ?? {};
  const withheld = remoteWithheldParam(operation.name, args);
  if (withheld) return { content: text(remoteWithheldParamOutput(withheld)), isError: true };
  const declaredParams = remoteDeclaredParams(operation.name, Object.keys(operation.params));
  const manifests = createReleaseManifestSink();
  // Read before the handler runs: a revocation during the call refuses its record.
  const privatePart = ctx.remotePrivatePart?.start(operation.name, args, {
    ...(ctx.sourceAnswerJobs ? { jobs: ctx.sourceAnswerJobs } : {}),
    ...(ctx.releaseCheck ? { releaseCheck: ctx.releaseCheck } : {}),
  });
  try {
    const result = await runWithReleaseManifestSink(manifests, () => operation.handler(ctx, args));
    const release = () => remoteOperationOutput(operation.name, result, {
      ...(ctx.releaseCheck ? { releaseCheck: ctx.releaseCheck } : {}),
      releaseManifests: manifests.manifests,
    });
    const approved = release();
    // Settled against the release the agent would get (slice 2's recheck included).
    const privateMayAnswer = privatePart ? await privatePart.settle(result, approved) : false;
    // The settle can wait on the local probe: an item reclassified meanwhile
    // (to Secret, say) is caught by checking the release again right before
    // it leaves. The note follows the output that actually leaves.
    const output = privatePart ? release() : approved;
    return { content: text(privateMayAnswer ? withRemotePrivateNote(output, privatePart?.answerId, privatePart?.secretMatch) : output) };
  } catch (error) {
    return { content: text(remoteErrorOutput(error, { declaredParams })), isError: true };
  }
}

/**
 * JSON-RPC errors the SDK and its transport produce before (or instead of)
 * the tool handler: argument validation, unknown methods, parse failures, a
 * bad protocol-version header. Their text can quote the request, so on the
 * remote surface each becomes a fixed sentence for its code, with no data.
 */
const REMOTE_JSON_RPC_ERROR_TEXT: Readonly<Record<number, string>> = {
  [-32700]: 'Parse error: the request was not valid JSON-RPC.',
  [-32600]: 'Invalid request.',
  [-32601]: 'Method not found.',
  [-32602]: 'Invalid params.',
  [-32603]: 'Internal error.',
  [-32001]: 'Session not found.',
};
const REMOTE_JSON_RPC_ERROR_FALLBACK = 'The request could not be handled.';

/**
 * Wraps a remote server's transport so every JSON-RPC error response it
 * writes carries only its code and that code's fixed sentence. The remote
 * endpoint answers in JSON (never SSE); any other response passes unchanged.
 */
function normalizeRemoteTransportErrors(transport: Transport): void {
  const handle = (transport as unknown as { handleRequest?: unknown }).handleRequest;
  if (typeof handle !== 'function') return;
  (transport as unknown as { handleRequest: (...args: unknown[]) => Promise<Response> }).handleRequest = async (...args: unknown[]) =>
    normalizedJsonRpcErrorResponse(await (handle as (...inner: unknown[]) => Promise<Response>).apply(transport, args));
}

async function normalizedJsonRpcErrorResponse(response: Response): Promise<Response> {
  if (!(response.headers.get('Content-Type') ?? '').toLowerCase().includes('application/json')) return response;
  let body: unknown;
  try {
    body = JSON.parse(await response.clone().text());
  } catch {
    return response;
  }
  let changed = false;
  const normalize = (message: unknown): unknown => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return message;
    const record = message as Record<string, unknown>;
    if (typeof record.error !== 'object' || record.error === null) return message;
    changed = true;
    const code = typeof (record.error as { code?: unknown }).code === 'number' ? (record.error as { code: number }).code : -32603;
    return { ...record, error: { code, message: REMOTE_JSON_RPC_ERROR_TEXT[code] ?? REMOTE_JSON_RPC_ERROR_FALLBACK } };
  };
  const normalized = Array.isArray(body) ? body.map(normalize) : normalize(body);
  if (!changed) return response;
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(JSON.stringify(normalized), { status: response.status, statusText: response.statusText, headers });
}

/**
 * An MCP server for one surface over an already-built operation context. The
 * remote endpoint builds one per HTTP request, with the connection's caller
 * identity already on the context.
 */
export function createOlympusMcpServer(
  surface: McpSurface,
  makeOperationContext: () => OperationContext,
  extension?: McpServerExtension,
): Server {
  const server = new Server(
    { name: 'olympus', version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = listMcpTools(makeOperationContext().config, surface);
    return { tools: extension ? extension.tools(listed) : listed };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const next = () => handleMcpCallTool(request, makeOperationContext, surface);
    return extension ? extension.call(request, next, extra.signal) : next();
  });
  if (surface === 'remote') {
    const connect = server.connect.bind(server);
    server.connect = async (transport: Transport) => {
      normalizeRemoteTransportErrors(transport);
      return connect(transport);
    };
  }
  return server;
}

export async function serve(): Promise<void> {
  const server = new Server(
    {
      name: 'olympus',
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: listMcpTools(loadConfig()),
    };
  });

  // One stdio server serves one client, so this process-local registry is
  // already per client: a slow source_answer hands off to it rather than
  // outliving the client's tool-call limit.
  const sourceAnswerJobs = new SourceAnswerJobRegistry({ limits: sourceAnswerJobLimitsFromEnv(process.env, 'stdio') });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // The stdio client names itself during initialize (e.g. "claude-code").
    // Self-reported, so it is an audit label only, never an authorization.
    // The request's signal is the client's cancellation: it ends a call
    // before hand-off (an ask stops before dispatch, nothing paid).
    return handleMcpCallTool(request, () => ({
      ...makeContext(server.getClientVersion()?.name, sourceAnswerJobs),
      ...(extra.signal ? { signal: extra.signal } : {}),
    }));
  });

  await server.connect(new StdioServerTransport());
}

/**
 * The stdio MCP caller identity; the client's self-reported name is a label
 * only, and the hosting provider it suggests ("claude-code" → Anthropic)
 * only chooses an anonymous-answer model setting.
 */
export function mcpOperationCaller(clientName?: string): OperationCaller {
  const displayName = sanitizeCallerDisplayName(clientName);
  const provider = callerProviderFromLabel(displayName);
  return { surface: 'mcp', ...(displayName ? { displayName } : {}), ...(provider ? { provider } : {}) };
}

function makeContext(clientName?: string, sourceAnswerJobs?: SourceAnswerJobRegistry): OperationContext {
  const config = loadConfig();
  const caller = mcpOperationCaller(clientName);
  const owner = sourceAnswerJobOwner(caller);
  return {
    config,
    delphi: new DelphiClient(config, createDelphiTransport(config)),
    email: new EmailClient(config, createEmailTransport(config)),
    caller,
    ...(sourceAnswerJobs && owner ? { sourceAnswerJobs: { registry: sourceAnswerJobs, owner } } : {}),
  };
}
