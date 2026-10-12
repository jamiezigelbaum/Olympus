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
 * The spec is served without a token. It is static and data-free: every
 * install serves the same document (neutral identity, default corpus
 * registry, the full remote list whatever this install has enabled, a fixed
 * API version rather than the package version), so it names no owner,
 * assistant, configured source, or build. Muse builds its connector by reading
 * the spec from a URL before the owner pastes the token into its credential
 * store, so a spec behind the token would stop the connector being built.
 * No CORS headers: Muse fetches server-side from its VM, and no browser page
 * needs to read this.
 */
import { createHash } from 'node:crypto';
import { defaultConfig, type OlympusConfig } from '../core/config.ts';
import { OperationError, type OperationErrorCode } from '../core/operation-error.ts';
import { createReleaseManifestSink, runWithReleaseManifestSink } from '../core/release-manifest.ts';
import {
  REMOTE_ERROR_SCHEMA,
  remoteDeclaredParams,
  remoteErrorOutput,
  remoteOperationOutput,
  withRemotePrivateNote,
  remoteOutputSchema,
  remoteSurfaceErrorOutput,
  remoteToolDescription,
  remoteToolSchema,
  remoteWithheldParam,
  remoteWithheldParamOutput,
  type RemoteErrorBody,
  type RemoteTransportErrorCode,
} from '../core/remote-result.ts';
import { exposedOperations, shouldExposeOperation } from '../core/operation-exposure.ts';
import {
  findOperationByName,
  operationDescription,
  operations,
  operationToolSchema,
  type Operation,
} from '../core/operations.ts';
import { authenticateRemoteRequest, jsonResponse, remoteOperationCaller, type RemoteMcpHandlerOptions } from './remote-mcp.ts';
import { isJsonContentType, readBoundedRequestText, REMOTE_REQUEST_MAX_BODY_BYTES } from './remote-request-body.ts';

export const REMOTE_OPENAPI_SPEC_PATH = '/openapi.json';
export const REMOTE_OPENAPI_TOOLS_PREFIX = '/api/v1/tools/';
export const REMOTE_OPENAPI_MAX_BODY_BYTES = REMOTE_REQUEST_MAX_BODY_BYTES;
/**
 * The REST API's own version, not the package's: bump it when a path, a
 * parameter, or a response shape changes. A fixed value keeps the
 * unauthenticated spec from naming the installed build.
 */
// 2.0.0 (2026-10-12): every 200 is an allowlisted per-operation output
// (core/remote-result.ts) and every failure, credential and transport ones
// included, the Error schema with a fixed sentence per code.
export const REMOTE_OPENAPI_API_VERSION = '2.0.0';

const TOOL_PATH_PATTERN = /^\/api\/v1\/tools\/([a-z][a-z0-9_]{0,63})$/;

export interface RemoteOpenApiHandlerOptions extends RemoteMcpHandlerOptions {
  /**
   * The public origin agents reach this install at (the relay address, once
   * it exists). Never derived from the request's Host header. Without one the
   * spec names a relative server, which resolves against the URL the agent
   * fetched the spec from. A function is asked per request (the worker's live
   * source, which follows the relay).
   */
  publicBaseUrl?: string | (() => string | undefined);
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
  const configured = options.publicBaseUrl;
  // A fixed value is validated up front, as before; a live one per request.
  if (typeof configured !== 'function') publicServerUrl(configured);
  // Built once per server URL; the ETag lets a re-fetch skip the body.
  let spec: { serverUrl: string; text: string; etag: string } | undefined;
  const currentSpec = () => {
    const serverUrl = typeof configured === 'function' ? livePublicServerUrl(configured()) : publicServerUrl(configured);
    if (spec?.serverUrl !== serverUrl) {
      const text = JSON.stringify(buildRemoteOpenApiSpec({ serverUrl }));
      spec = { serverUrl, text, etag: `"${createHash('sha256').update(text).digest('base64url').slice(0, 27)}"` };
    }
    return spec;
  };
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    let response: Response;
    if (pathname === REMOTE_OPENAPI_SPEC_PATH) {
      const { text, etag } = currentSpec();
      response = serveSpec(request, text, etag);
    } else {
      const name = TOOL_PATH_PATTERN.exec(pathname)?.[1];
      try {
        response = name === undefined
          ? failure(404, remoteSurfaceErrorOutput('not_found'))
          : await callTool(request, name, options);
      } catch (error) {
        // Anything that escapes (a credential store that throws, a context
        // that cannot be built) is still the published Error shape.
        response = failure(500, remoteErrorOutput(error));
      }
    }
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  };
}

function serveSpec(request: Request, specText: string, etag: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return failure(405, remoteSurfaceErrorOutput('method_not_allowed'), { Allow: 'GET, HEAD' });
  }
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ETag: etag };
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim() === etag || tag.trim() === '*')) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(specText, { status: 200, headers });
}

async function callTool(request: Request, name: string, options: RemoteOpenApiHandlerOptions): Promise<Response> {
  // Authentication first, exactly as `/mcp` does it, so an unauthenticated
  // probe learns nothing about which tool names exist.
  const verification = authenticateRemoteRequest(request, options);
  if (!verification.ok) return credentialFailure(verification.response);
  if (request.method !== 'POST') {
    return failure(405, remoteSurfaceErrorOutput('method_not_allowed'), { Allow: 'POST' });
  }
  // As the MCP transport does: a tool call is JSON or it is refused.
  if (!isJsonContentType(request.headers.get('Content-Type'))) {
    return failure(415, remoteSurfaceErrorOutput('unsupported_media_type'));
  }

  const ctx = options.makeOperationContext(remoteOperationCaller(verification.connection), request.signal);
  const operation = findOperationByName(name);
  if (!operation || !shouldExposeOperation(operation, { config: neutralSpecConfig(), surface: 'remote' })) {
    return failure(404, remoteSurfaceErrorOutput('unknown_operation'));
  }
  // On the published list, but this install has it switched off.
  if (!shouldExposeOperation(operation, { config: ctx.config, surface: 'remote' })) {
    return failure(503, remoteSurfaceErrorOutput('operation_unavailable'));
  }

  const params = await readParams(request);
  if (!params.ok) return params.response;
  // A parameter the remote surface does not serve is refused by name (it is
  // one the operation declares elsewhere).
  const withheld = remoteWithheldParam(operation.name, params.value);
  if (withheld) return failure(400, remoteWithheldParamOutput(withheld));
  // Declared parameters only, checked here for every operation rather than
  // left to each handler: `caller` in particular is set from the token. An
  // undeclared name is never repeated back.
  const declaredParams = remoteDeclaredParams(operation.name, Object.keys(operation.params));
  if (Object.keys(params.value).some((key) => !declaredParams.includes(key))) {
    return failure(400, remoteSurfaceErrorOutput('invalid_request'));
  }

  const manifests = createReleaseManifestSink();
  // Read before the handler runs: a revocation during the call refuses its record.
  const privatePart = ctx.remotePrivatePart?.start(operation.name, params.value, {
    ...(ctx.sourceAnswerJobs ? { jobs: ctx.sourceAnswerJobs } : {}),
    ...(ctx.releaseCheck ? { releaseCheck: ctx.releaseCheck } : {}),
  });
  try {
    const result = await runWithReleaseManifestSink(manifests, () => operation.handler(ctx, params.value));
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
    return jsonResponse(200, privateMayAnswer ? withRemotePrivateNote(output) : output);
  } catch (error) {
    return operationErrorResponse(error, declaredParams);
  }
}

async function readParams(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const body = await readBoundedRequestText(request);
  if (!body.ok) {
    return {
      ok: false,
      response: body.reason === 'too_large'
        ? failure(413, remoteSurfaceErrorOutput('payload_too_large'))
        : failure(400, remoteSurfaceErrorOutput('invalid_request')),
    };
  }
  const text = body.text;
  if (text.trim() === '') return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, response: failure(400, remoteSurfaceErrorOutput('invalid_request')) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: failure(400, remoteSurfaceErrorOutput('invalid_request')) };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function failure(status: number, body: RemoteErrorBody, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, body, headers);
}

/**
 * A refused credential in the published Error shape. The status and the
 * RFC 6750 challenge header (which carries the OAuth discovery pointer) are
 * kept; the body is the fixed sentence for its code.
 */
async function credentialFailure(refusal: Response): Promise<Response> {
  let code: RemoteTransportErrorCode = 'unauthorized';
  try {
    const body = await refusal.json() as { error?: unknown };
    if (body.error === 'invalid_token' || body.error === 'remote_connections_unavailable') code = body.error;
  } catch {
    // An unreadable refusal is still a refusal.
  }
  if (refusal.status === 503) code = 'remote_connections_unavailable';
  const challenge = refusal.headers.get('WWW-Authenticate');
  return failure(refusal.status === 503 ? 503 : 401, remoteSurfaceErrorOutput(code), challenge ? { 'WWW-Authenticate': challenge } : {});
}

// The HTTP status for each operation error code. The body is the remote
// surface's fixed sentence for the code (core/remote-result.ts), never the
// internal message or suggestion: those can name internal URLs or carry a
// worker response body.
const ERROR_STATUS: Partial<Record<OperationErrorCode, number>> = {
  invalid_params: 400,
  invalid_request: 400,
  unsupported_filter: 400,
  email_policy_violation: 403,
  source_index_policy_violation: 403,
  source_index_not_enabled: 503,
  source_answer_busy: 429,
  source_answer_job_not_found: 404,
  source_answer_deadline: 504,
  source_answer_too_large: 502,
};

function operationErrorResponse(error: unknown, declaredParams: readonly string[]): Response {
  const status = error instanceof OperationError ? ERROR_STATUS[error.code] ?? 502 : 500;
  return failure(status, remoteErrorOutput(error, { declaredParams }));
}

/** A live value that is not a plain https origin (a loopback dev URL) falls back to relative. */
function livePublicServerUrl(publicBaseUrl: string | undefined): string {
  try {
    return publicServerUrl(publicBaseUrl);
  } catch {
    return '/';
  }
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
export function buildRemoteOpenApiSpec(options: { serverUrl?: string } = {}): Record<string, unknown> {
  const rendering = neutralSpecConfig();
  const exposed = exposedOperations(operations, { config: rendering, surface: 'remote' });
  const paths = Object.fromEntries(exposed.map((operation) => [
    `${REMOTE_OPENAPI_TOOLS_PREFIX}${operation.name}`,
    { post: openApiOperation(operation, rendering) },
  ]));
  return {
    openapi: '3.1.0',
    info: {
      title: 'Olympus',
      version: REMOTE_OPENAPI_API_VERSION,
      description: [
        'Ask the owner\'s Olympus source index questions, under the same privacy rules as their own assistant.',
        'Authenticate every call with the connection token from `olympus connections add <name>` as a bearer token.',
        'Call source_answer one at a time; an answer can take several minutes.',
        'When one takes longer than about 200 seconds, source_answer returns {"status": "working", "job_id": ...} instead and keeps working:',
        'call source_answer_result with that job_id, again while it says working, to get the answer.',
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
        Error: REMOTE_ERROR_SCHEMA,
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
  // The remote view: parameters the remote surface does not serve are left out.
  const description = remoteToolDescription(operation.name, operationDescription(operation, { config }));
  const schema: Record<string, unknown> = { ...remoteToolSchema(operation.name, operationToolSchema(operation, { config })), additionalProperties: false };
  const hasRequired = Array.isArray(schema.required) && schema.required.length > 0;
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
        description: 'The operation result: one of its output families, told apart by kind and status.',
        content: { 'application/json': { schema: remoteOutputSchema(operation.name) ?? { type: 'object' } } },
      },
      400: errorRef,
      401: errorRef,
      403: errorRef,
      404: errorRef,
      405: errorRef,
      413: errorRef,
      415: errorRef,
      429: errorRef,
      504: errorRef,
      500: errorRef,
      502: errorRef,
      503: errorRef,
    },
  };
}

/**
 * The spec is served without a token, so it describes no install: the
 * defaults (neutral identity, default corpus registry) with the source index
 * on, so the path list is the whole remote surface whatever this install has
 * enabled. A call to an operation this install has off fails at runtime.
 */
function neutralSpecConfig(): OlympusConfig {
  const neutral = defaultConfig();
  return { ...neutral, sourceIndex: { ...neutral.sourceIndex, enabled: true } };
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(\s|$)/.exec(text);
  return (match?.[1] ?? text).slice(0, 120);
}
