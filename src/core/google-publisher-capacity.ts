/**
 * Whether Olympus's own Google sign-in still has room.
 *
 * Google lets an unverified app that asks for restricted scopes (gmail.readonly,
 * drive.readonly) serve at most 100 distinct users over its whole lifetime, and
 * stops user 101 on Google's own page, so Olympus never hears about that person.
 * The only place that can see the wall coming is the publisher exchange Worker,
 * which counts distinct accounts from each finished sign-in and answers
 * `GET /exchange/capacity` with `{ "google": "open" | "full" }`
 * (`exchange/src/capacity.ts`, `docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md`).
 *
 * This module is the engine's side of that answer. It is asked before Olympus
 * opens Google's consent screen through its own (publisher) app, and by the
 * dashboard before it draws the Connect card. It fails OPEN on every doubt: a
 * network error, a timeout, a redirect, a non-200, or a body that is not
 * exactly the expected shape all read as "open", because a broken capacity
 * check must never be the reason a person cannot connect. Only an explicit,
 * well-formed `full` closes the door, and only for the publisher app: a
 * bring-your-own client, Dropbox, X and token refresh never ask.
 */

import { googlePublisherCapacityUrl } from './oauth-relay.ts';

export {
  GOOGLE_SIGNIN_FULL_CODE,
  GOOGLE_SIGNIN_FULL_ON_COMPUTER_SENTENCE,
  GOOGLE_SIGNIN_FULL_SENTENCE,
} from './google-signin-full-copy.ts';

const CAPACITY_TIMEOUT_MS = 1_500;
/** A fresh answer is reused this long; the Worker's own answer is cacheable for a minute. */
const OPEN_OR_FULL_TTL_MS = 60_000;
/** A failed check is remembered briefly so an unreachable Worker is not retried on every page poll. */
const FAILED_TTL_MS = 30_000;
const MAX_BODY_BYTES = 1_024;

export interface GoogleCapacityOptions {
  /** Injected by tests and by a dashboard that owns its own fetch seam. */
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
  timeoutMs?: number;
}

interface CacheEntry {
  full: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<boolean>>();

/** Forget every remembered answer (tests; a fresh process starts empty anyway). */
export function resetGooglePublisherCapacityCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * True only when the publisher exchange Worker has said, in so many words,
 * that Google sign-in through Olympus's own app is full.
 */
export async function googlePublisherSignInFull(options: GoogleCapacityOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  // Hermetic by default under `bun test`: nothing in the suite should wait on
  // the real network for a dashboard render. A test that exercises this module
  // passes its own `fetch`.
  if (!options.fetch && env.NODE_ENV === 'test') return false;

  const url = googlePublisherCapacityUrl(env);
  const now = options.now ?? Date.now;
  const cached = cache.get(url);
  if (cached && cached.expiresAt > now()) return cached.full;
  const pending = inFlight.get(url);
  if (pending) return pending;

  const request = askWorker(url, options, now)
    .finally(() => {
      inFlight.delete(url);
    });
  inFlight.set(url, request);
  return request;
}

async function askWorker(url: string, options: GoogleCapacityOptions, now: () => number): Promise<boolean> {
  const fetchImpl = options.fetch ?? fetch;
  let answer: boolean | undefined;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(options.timeoutMs ?? CAPACITY_TIMEOUT_MS),
    });
    if (response.status === 200) answer = parseCapacityBody(await readBounded(response));
  } catch {
    answer = undefined;
  }
  const full = answer === true;
  cache.set(url, { full, expiresAt: now() + (answer === undefined ? FAILED_TTL_MS : OPEN_OR_FULL_TTL_MS) });
  return full;
}

/** `true` for full, `false` for open, `undefined` for anything that is not exactly the contract. */
function parseCapacityBody(text: string): boolean | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1) return undefined;
  if (record.google === 'full') return true;
  if (record.google === 'open') return false;
  return undefined;
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, MAX_BODY_BYTES);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) return '';
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
