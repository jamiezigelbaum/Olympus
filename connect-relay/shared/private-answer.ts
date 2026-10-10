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
 *   POST https://<relay>/private/oly2p.<installId>.<secret>/open
 *   {"v":1,"open":"<token from the decrypted answer>"}   → 204
 *
 *   POST https://<relay>/private/oly2p.<installId>.<secret>/ask
 *   {"v":1,"publicKey":"<panel key>","iv":"…","ciphertext":"…"}   → 202
 *   (a private question sealed to the engine's job key; the relay forwards
 *   ciphertext it holds no key for; src/workers/chatgpt/private-question-contract.ts)
 *
 * The panel (a ChatGPT widget) calls it with `fetch`, so the browser sends an
 * Origin and preflights the JSON POST. Only the ChatGPT widget sandbox
 * origins below pass.
 */
import { credentialInstallId } from './tokens.ts';

export const PRIVATE_ANSWER_PATH_PREFIX = '/private/';
/**
 * The exact path shapes, nothing else under the prefix, no query:
 * `/private/<job id>` (collect the answer) and `/private/<job id>/open`
 * (open one of its sources on the Mac, by a token from inside the sealed
 * answer: `{"v":1,"open":"<token>"}`).
 */
export const PRIVATE_ANSWER_PATH_PATTERN = /^\/private\/oly2p\.[a-z2-7]{32}\.[A-Za-z0-9_-]{43}(?:\/open|\/ask|\/another)?$/;
/** The open request's path suffix. */
export const PRIVATE_ANSWER_OPEN_SUFFIX = '/open';
/** The ask request's path suffix (a private question sealed to the engine). */
export const PRIVATE_ANSWER_ASK_SUFFIX = '/ask';
/** The private question panel's Ask another: a new job for the same panel, in place (owner request 2026-10-10). */
export const PRIVATE_ANSWER_ANOTHER_SUFFIX = '/another';
/** `{"v":1,"publicKey":"<87 chars>"}` is about 110 bytes; anything far larger is not a panel. */
export const PRIVATE_ANSWER_MAX_REQUEST_BYTES = 512;
/** A sealed question: up to 8 KiB of text as base64url ciphertext with its key, iv and JSON around it. */
export const PRIVATE_QUESTION_MAX_REQUEST_BYTES = 16_384;
export type PrivateAnswerAction = 'collect' | 'open' | 'ask' | 'another';
/** The body cap for one private-answer action: only a sealed question is larger than a key. */
export function privateAnswerMaxRequestBytes(action: PrivateAnswerAction): number {
  return action === 'ask' ? PRIVATE_QUESTION_MAX_REQUEST_BYTES : PRIVATE_ANSWER_MAX_REQUEST_BYTES;
}

/**
 * ChatGPT serves MCP Apps widgets from its sandbox domain,
 * `web-sandbox.oaiusercontent.com`, or a per-app subdomain of it
 * (developers.openai.com/apps-sdk/reference, `_meta.ui.domain`: "Defaults to
 * https://web-sandbox.oaiusercontent.com"). The exact per-app origin when a
 * dedicated `_meta.ui.domain` is set is not documented, so one DNS label under
 * the sandbox domain is accepted, plus the dedicated domain itself. CORS keeps
 * other web pages out; it is not a barrier to a non-browser caller, which the
 * design does not rely on it for.
 *
 * The ChatGPT desktop app (Work mode) serves the same sandbox under its own
 * scheme: observed 2026-10-01 as
 * `codex-sandbox://mcp-app-<hex>.web-sandbox.oaiusercontent.com`.
 */
const SANDBOX_HOST = 'web-sandbox.oaiusercontent.com';
const SANDBOX_SUBDOMAIN = /^(?:https|codex-sandbox):\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.web-sandbox\.oaiusercontent\.com$/;

export function isPanelOrigin(origin: string | null | undefined, extraOrigins: readonly string[] = []): origin is string {
  if (typeof origin !== 'string' || origin.length > 255) return false;
  if (origin === `https://${SANDBOX_HOST}` || origin === `codex-sandbox://${SANDBOX_HOST}` || SANDBOX_SUBDOMAIN.test(origin)) return true;
  return extraOrigins.includes(origin);
}

/** The job id in a private-answer path (collect or open), or undefined for any other path. */
export function privateAnswerJobId(path: string): string | undefined {
  return privateAnswerRoute(path)?.jobId;
}

/** A private-answer path's job id and action, or undefined for any other path. */
export function privateAnswerRoute(path: string): { jobId: string; action: PrivateAnswerAction } | undefined {
  if (!PRIVATE_ANSWER_PATH_PATTERN.test(path)) return undefined;
  const suffix = path.endsWith(PRIVATE_ANSWER_OPEN_SUFFIX) ? PRIVATE_ANSWER_OPEN_SUFFIX : path.endsWith(PRIVATE_ANSWER_ASK_SUFFIX) ? PRIVATE_ANSWER_ASK_SUFFIX : path.endsWith(PRIVATE_ANSWER_ANOTHER_SUFFIX) ? PRIVATE_ANSWER_ANOTHER_SUFFIX : '';
  const action: PrivateAnswerAction = suffix === PRIVATE_ANSWER_OPEN_SUFFIX ? 'open' : suffix === PRIVATE_ANSWER_ASK_SUFFIX ? 'ask' : suffix === PRIVATE_ANSWER_ANOTHER_SUFFIX ? 'another' : 'collect';
  return { jobId: path.slice(PRIVATE_ANSWER_PATH_PREFIX.length, path.length - suffix.length), action };
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
  | 'busy' // 503 + Retry-After
  | 'opened'; // 204, no body (`/open`): the source was opened on the Mac
