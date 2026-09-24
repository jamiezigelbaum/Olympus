/**
 * OpenAPI view of the remote operation surface, for hosted agents that speak
 * REST rather than MCP (Meta's Muse: a custom connector is an OpenAPI spec plus
 * a static bearer token, and Muse writes its own client from the spec).
 *
 * It is the same surface as `/mcp`, reached a different way:
 * - `GET /openapi.json` describes exactly the operations the `remote` surface
 *   exposes, generated from the operations table.
 * - `POST /api/v1/tools/<name>` calls one of them. It authenticates the same
 *   connection token `/mcp` does, applies the same `remote` exposure filter,
 *   and runs through the same in-process operation context, so the answer is
 *   attributed to the connection and nothing else becomes reachable.
 *
 * The spec is served without a token. It is static and data-free: it is
 * rendered with the neutral identity and the default corpus registry, so it
 * names no owner, assistant, or configured source, and it carries no token.
 * Muse builds its connector by reading the spec from a URL before the owner
 * pastes the token into its credential store, so a spec behind the token
 * would stop the connector being built at all.
 */
import { defaultConfig, type OlympusConfig } from '../core/config.ts';
import { OperationError, type OperationErrorCode } from '../core/operation-error.ts';
import { exposedOperations, shouldExposeOperation } from '../core/operation-exposure.ts';
import {
  findOperationByName,
  operationDescription,
  operations,
  operationToolSchema,
  type Operation,
} from '../core/operations.ts';
import { isWellFormedRemoteConnectionToken, type RemoteConnectionStore } from '../core/remote-connections.ts';
import { VERSION } from '../version.ts';
import { bearerToken, jsonResponse, remoteOperationCaller, unauthorized, type RemoteMcpHandlerOptions } from './remote-mcp.ts';

export const REMOTE_OPENAPI_SPEC_PATH = '/openapi.json';
export const REMOTE_OPENAPI_TOOLS_PREFIX = '/api/v1/tools/';
/** A question plus filters is a few KiB; anything near this is not a tool call. */
export const REMOTE_OPENAPI_MAX_BODY_BYTES = 256 * 1024;

const TOOL_PATH_PATTERN = /^\/api\/v1\/tools\/([a-z][a-z0-9_]{0,63})$/;

export interface RemoteOpenApiHandlerOptions extends RemoteMcpHandlerOptions {
  /**
   * The public origin agents reach this install at (the relay address, once
   * it exists). Never derived from the request's Host header. Without one the
   * spec names a relative server, which resolves against the URL the agent
   * fetched the spec from.
   */
  publicBaseUrl?: string;
}

export function isRemoteOpenApiRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === REMOTE_OPENAPI_SPEC_PATH || TOOL_PATH_PATTERN.test(pathname);
}

/** Routes the spec and REST call paths to `openApi`, everything else to `rest`. */
export function withRemoteOpenApiRoutes(
  openApi: (request: Request) => Promise<Response>,
  rest: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) => (isRemoteOpenApiRequest(request) ? openApi(request) : rest(request));
}

export function createRemoteOpenApiHandler(options: RemoteOpenApiHandlerOptions): (request: Request) => Promise<Response> {
  const serverUrl = publicServerUrl(options.publicBaseUrl);
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === REMOTE_OPENAPI_SPEC_PATH) return serveSpec(request, options, serverUrl);
    const name = TOOL_PATH_PATTERN.exec(pathname)?.[1];
    if (name === undefined) return jsonResponse(404, { error: 'not_found' });
    return callTool(request, name, options);
  };
}

function serveSpec(request: Request, options: RemoteOpenApiHandlerOptions, serverUrl: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
  }
  // Exposure follows the context the calls run with, so the spec lists exactly
  // what a call can reach. The caller is a placeholder: nothing runs.
  const config = options.makeOperationContext({ surface: 'remote' }, new AbortController().signal).config;
  return new Response(JSON.stringify(buildRemoteOpenApiSpec(config, { serverUrl })), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  });
}

async function callTool(request: Request, name: string, options: RemoteOpenApiHandlerOptions): Promise<Response> {
  // Authentication first, exactly as `/mcp` does it, so an unauthenticated
  // probe learns nothing about which tool names exist.
  const token = bearerToken(request.headers.get('Authorization'));
  if (token === undefined) return unauthorized();
  if (!isWellFormedRemoteConnectionToken(token)) return unauthorized('invalid_token');
  let store: RemoteConnectionStore | undefined;
  try {
    store = options.connections();
  } catch {
    return jsonResponse(503, { error: 'remote_connections_unavailable' });
  }
  if (!store) return unauthorized('invalid_token');
  const verification = store.verifyToken(token);
  if (!verification.ok) return unauthorized('invalid_token');
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const ctx = options.makeOperationContext(remoteOperationCaller(verification.connection), request.signal);
  const operation = findOperationByName(name);
  if (!operation || !shouldExposeOperation(operation, { config: ctx.config, surface: 'remote' })) {
    return jsonResponse(404, { error: 'unknown_operation', message: `No Olympus operation named ${name} is available here.` });
  }

  const params = await readParams(request);
  if (!params.ok) return params.response;

  try {
    const result = await operation.handler(ctx, params.value);
    return jsonResponse(200, result ?? null);
  } catch (error) {
    return operationErrorResponse(error);
  }
}

async function readParams(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > REMOTE_OPENAPI_MAX_BODY_BYTES) {
    return { ok: false, response: jsonResponse(413, { error: 'payload_too_large' }) };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: invalidRequest('The request body could not be read.') };
  }
  if (Buffer.byteLength(text) > REMOTE_OPENAPI_MAX_BODY_BYTES) {
    return { ok: false, response: jsonResponse(413, { error: 'payload_too_large' }) };
  }
  if (text.trim() === '') return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, response: invalidRequest('The request body must be a JSON object.') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: invalidRequest('The request body must be a JSON object.') };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function invalidRequest(message: string): Response {
  return jsonResponse(400, { error: 'invalid_request', message });
}

// Codes whose message describes the caller's own request or a policy refusal,
// written for the calling agent. Every other failure is Olympus's own plumbing:
// its message and suggestion can name internal URLs or carry a worker response
// body, so the agent gets a fixed sentence instead.
const CALLER_FACING_ERRORS: Partial<Record<OperationErrorCode, number>> = {
  invalid_params: 400,
  invalid_request: 400,
  unsupported_filter: 400,
  email_policy_violation: 403,
  source_index_policy_violation: 403,
  source_index_not_enabled: 503,
};

const INTERNAL_ERROR_MESSAGES: Partial<Record<OperationErrorCode, string>> = {
  email_unreachable: 'Olympus could not reach its source worker in time. Retry later.',
  argus_unreachable: 'Olympus could not reach its private analyst. Retry later.',
};

function operationErrorResponse(error: unknown): Response {
  if (error instanceof OperationError) {
    const status = CALLER_FACING_ERRORS[error.code];
    if (status !== undefined) {
      return jsonResponse(status, {
        error: error.code,
        message: error.message,
        ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      });
    }
    return jsonResponse(502, {
      error: error.code,
      message: INTERNAL_ERROR_MESSAGES[error.code] ?? 'Olympus could not complete this request.',
    });
  }
  return jsonResponse(500, { error: 'internal_error', message: 'Olympus could not complete this request.' });
}

function publicServerUrl(publicBaseUrl: string | undefined): string {
  if (publicBaseUrl === undefined) return '/';
  const url = new URL(publicBaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('The public base URL must be a plain https origin.');
  }
  return url.origin;
}

/**
 * The OpenAPI 3.1 document for the remote surface. OpenAPI 3.1 schemas are
 * JSON Schema 2020-12, the dialect the MCP tool schemas already use, so each
 * operation's parameter schema carries over unchanged.
 */
export function buildRemoteOpenApiSpec(
  config: OlympusConfig,
  options: { serverUrl?: string } = {},
): Record<string, unknown> {
  const exposed = exposedOperations(operations, { config, surface: 'remote' });
  const rendering = neutralRenderingConfig(config);
  const paths = Object.fromEntries(exposed.map((operation) => [
    `${REMOTE_OPENAPI_TOOLS_PREFIX}${operation.name}`,
    { post: openApiOperation(operation, rendering) },
  ]));
  return {
    openapi: '3.1.0',
    info: {
      title: 'Olympus',
      version: VERSION,
      description: [
        'Ask the owner\'s Olympus source index questions, under the same privacy rules as their own assistant.',
        'Authenticate every call with the connection token from `olympus connections add <name>` as a bearer token.',
        'Call source_answer one at a time; an answer can take several minutes.',
      ].join(' '),
    },
    servers: [{ url: options.serverUrl ?? '/' }],
    security: [{ connectionToken: [] }],
    paths,
    components: {
      securitySchemes: {
        connectionToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'An Olympus connection token (olympus_conn_...). Revoke it with olympus connections revoke <id>.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string', description: 'A stable error code.' },
            message: { type: 'string' },
            suggestion: { type: 'string' },
          },
        },
      },
      responses: {
        Error: {
          description: 'The request failed.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
  };
}

function openApiOperation(operation: Operation, config: OlympusConfig): Record<string, unknown> {
  const description = operationDescription(operation, { config });
  const schema = { ...operationToolSchema(operation, { config }), additionalProperties: false };
  const hasRequired = Object.values(operation.params).some((param) => param.required);
  const errorRef = { $ref: '#/components/responses/Error' };
  return {
    operationId: operation.name,
    summary: firstSentence(description),
    description,
    requestBody: {
      required: hasRequired,
      content: { 'application/json': { schema } },
    },
    responses: {
      200: {
        description: 'The operation result.',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      400: errorRef,
      401: errorRef,
      403: errorRef,
      404: errorRef,
      413: errorRef,
      500: errorRef,
      502: errorRef,
      503: errorRef,
    },
  };
}

/**
 * The spec is served without a token, so it is rendered as any install would
 * render it: the neutral identity and the default corpus registry.
 */
function neutralRenderingConfig(config: OlympusConfig): OlympusConfig {
  const neutral = defaultConfig();
  return {
    ...config,
    identity: neutral.identity,
    sourceIndex: { ...config.sourceIndex, corpusRegistry: neutral.sourceIndex.corpusRegistry },
  };
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(\s|$)/.exec(text);
  return (match?.[1] ?? text).slice(0, 120);
}
