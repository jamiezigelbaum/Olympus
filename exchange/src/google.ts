/**
 * The one thing this whole service exists to do: hold `GOOGLE_CLIENT_SECRET`
 * and use it to talk to Google's token endpoint on the caller's behalf.
 *
 * Neither function here inspects, logs, or transforms the caller's input
 * beyond assembling the exact form Google's token endpoint expects — the
 * validation and allowlisting happen one layer up, in `index.ts`, before
 * either of these is called.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleExchangeCredentials {
  clientId: string;
  clientSecret: string;
}

export interface GoogleFetch {
  (input: string, init: RequestInit): Promise<Response>;
}

/**
 * Google's token response is a small JSON object — a grant or an
 * `{error, error_description}` refusal. The cap is what stops a hostile or
 * broken upstream from making this Worker buffer an unbounded body inside its
 * CPU and memory limits, and it is enforced on the bytes actually read, not
 * on a `Content-Length` the peer chose.
 */
export const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024;

export interface GoogleUpstreamResult {
  ok: true;
  status: number;
  contentType: string | null;
  /** Already read, under the same deadline and cap as the request itself. */
  text: string;
}

export type GoogleUpstreamFailure =
  | { ok: false; kind: 'timeout' }
  | { ok: false; kind: 'network_error' }
  | { ok: false; kind: 'oversized_response' };

export type GoogleUpstreamOutcome = GoogleUpstreamResult | GoogleUpstreamFailure;

/**
 * The deadline covers the BODY, not just the status line.
 *
 * Clearing the timer once headers arrived left the body read unbounded: an
 * upstream that answered `200` and then dribbled held this Worker open past
 * its stated timeout, spending request duration it had already promised to
 * bound (Codex round 1 on 5cb644b9). The read is raced against the deadline
 * rather than left to the abort signal alone, because a signal only interrupts
 * a peer that honours it.
 */
async function postToGoogle(
  body: URLSearchParams,
  fetchImpl: GoogleFetch,
  timeoutMs: number,
): Promise<GoogleUpstreamOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('upstream deadline');
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: controller.signal,
      }),
      deadline,
    ]);
    const text = await Promise.race([
      readBoundedText(response, MAX_UPSTREAM_RESPONSE_BYTES, controller),
      deadline,
    ]);
    return { ok: true, status: response.status, contentType: response.headers.get('content-type'), text };
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return { ok: false, kind: 'oversized_response' };
    if (error instanceof Error && error.name === 'AbortError') return { ok: false, kind: 'timeout' };
    return { ok: false, kind: 'network_error' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class ResponseTooLargeError extends Error {}

/** Refuses rather than truncating: a half-read token response is not an answer. */
async function readBoundedText(
  response: Response,
  limitBytes: number,
  controller: AbortController,
): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limitBytes) throw new ResponseTooLargeError();
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        controller.abort();
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * `grant_type=authorization_code` — the PKCE exchange, plus the confidential
 * client's secret Google requires from a Web-application client even with
 * PKCE (docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md, "Why this exists").
 */
export async function exchangeGoogleAuthorizationCode(
  credentials: GoogleExchangeCredentials,
  input: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: GoogleFetch,
  timeoutMs: number,
): Promise<GoogleUpstreamOutcome> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', input.code);
  body.set('redirect_uri', input.redirectUri);
  body.set('code_verifier', input.codeVerifier);
  body.set('client_id', credentials.clientId);
  body.set('client_secret', credentials.clientSecret);
  return postToGoogle(body, fetchImpl, timeoutMs);
}

/** `grant_type=refresh_token` — refreshing an access token for an already-connected account. */
export async function refreshGoogleAccessToken(
  credentials: GoogleExchangeCredentials,
  input: { refreshToken: string },
  fetchImpl: GoogleFetch,
  timeoutMs: number,
): Promise<GoogleUpstreamOutcome> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', input.refreshToken);
  body.set('client_id', credentials.clientId);
  body.set('client_secret', credentials.clientSecret);
  return postToGoogle(body, fetchImpl, timeoutMs);
}
