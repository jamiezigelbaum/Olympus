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

export interface GoogleUpstreamResult {
  ok: true;
  response: Response;
}

export type GoogleUpstreamFailure =
  | { ok: false; kind: 'timeout' }
  | { ok: false; kind: 'network_error' };

export type GoogleUpstreamOutcome = GoogleUpstreamResult | GoogleUpstreamFailure;

async function postToGoogle(
  body: URLSearchParams,
  fetchImpl: GoogleFetch,
  timeoutMs: number,
): Promise<GoogleUpstreamOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });
    return { ok: true, response };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { ok: false, kind: 'timeout' };
    return { ok: false, kind: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
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
