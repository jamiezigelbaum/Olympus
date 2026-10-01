/**
 * The private-answer fetch path, shared by the relay (which routes it and
 * answers CORS) and the engine (which serves it). No key material and no
 * crypto live here: the relay never needs either. See
 * docs/design/chatgpt-plugin.md, "Private answer panel".
 *
 *   POST https://<relay>/private/oly2p.<installId>.<secret>
 *   Content-Type: application/json
 *   {"v":1,"publicKey":"<base64url raw P-256 point, 65 bytes>"}
 *
 * The panel (a ChatGPT widget) calls it with `fetch`, so the browser sends an
 * Origin and preflights the JSON POST. Only the ChatGPT widget sandbox
 * origins below pass.
 */
import { credentialInstallId } from './tokens.ts';

export const PRIVATE_ANSWER_PATH_PREFIX = '/private/';
/** The exact path shape, nothing under it: `/private/<job id>`, no query. */
export const PRIVATE_ANSWER_PATH_PATTERN = /^\/private\/oly2p\.[a-z2-7]{32}\.[A-Za-z0-9_-]{43}$/;
/** `{"v":1,"publicKey":"<87 chars>"}` is about 110 bytes; anything far larger is not a panel. */
export const PRIVATE_ANSWER_MAX_REQUEST_BYTES = 512;

/**
 * ChatGPT serves MCP Apps widgets from its sandbox domain,
 * `web-sandbox.oaiusercontent.com`, or a per-app subdomain of it
 * (developers.openai.com/apps-sdk/reference, `_meta.ui.domain`: "Defaults to
 * https://web-sandbox.oaiusercontent.com"). The exact per-app origin when a
 * dedicated `_meta.ui.domain` is set is not documented, so one DNS label under
 * the sandbox domain is accepted, plus the dedicated domain itself. CORS keeps
 * other web pages out; it is not a barrier to a non-browser caller, which the
 * design does not rely on it for.
 */
const SANDBOX_HOST = 'web-sandbox.oaiusercontent.com';
const SANDBOX_SUBDOMAIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.web-sandbox\.oaiusercontent\.com$/;

export function isPanelOrigin(origin: string | null | undefined, extraOrigins: readonly string[] = []): origin is string {
  if (typeof origin !== 'string' || origin.length > 255) return false;
  if (origin === `https://${SANDBOX_HOST}` || SANDBOX_SUBDOMAIN.test(origin)) return true;
  return extraOrigins.includes(origin);
}

/** The job id in a private-answer path, or undefined for any other path. */
export function privateAnswerJobId(path: string): string | undefined {
  if (!PRIVATE_ANSWER_PATH_PATTERN.test(path)) return undefined;
  return path.slice(PRIVATE_ANSWER_PATH_PREFIX.length);
}

/** The install a private-answer job id names. */
export function privateAnswerInstallId(jobId: string | undefined): string | undefined {
  return credentialInstallId('private', jobId);
}

/** CORS response headers for an allowed panel origin. */
export function privateAnswerCorsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Expose-Headers': 'retry-after',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/** The `status` of every private-answer response body; the panel switches on it. */
export type PrivateAnswerWireStatus =
  | 'ready' // 200: { macPublicKey, iv, ciphertext }
  | 'failed' // 200: the private model could not answer; the job is gone
  | 'pending' // 202 + Retry-After: poll again with the same key
  | 'claimed' // 409: another key already claimed this job
  | 'gone' // 410: unknown, expired, or already collected
  | 'invalid' // 400
  | 'forbidden' // 403: not a ChatGPT widget origin
  | 'rate_limited' // 429 + Retry-After
  | 'mac_offline' // 503 (relay): the install has no live session
  | 'busy'; // 503 + Retry-After
