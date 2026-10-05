// No-redirect transport for model endpoints.
//
// Every request that carries source content (evidence, extracted text, images,
// embedding input) or a model credential goes out with `redirect: 'error'`.
// A model endpoint has no legitimate reason to answer with a redirect, and
// following one would re-send the body, and with it Private evidence or a
// bearer key, to whatever host the Location header names. The secure pool's
// locality check is on the configured address only, so a loopback endpoint
// that redirected would otherwise defeat it.
//
// A redirect surfaces as ModelEndpointRedirectError: typed and content-free.
// Its message never echoes the request URL, its query, the Location target, or
// any part of the request or response body. Callers map it onto the same
// failure class they use for any other transport failure.

export type ModelTransportFetch = (url: string, init: RequestInit) => Promise<Response>;

export const MODEL_ENDPOINT_REDIRECT_MESSAGE =
  'The model endpoint answered with a redirect. Olympus does not follow redirects on model transports, so the request was not re-sent anywhere.';

export class ModelEndpointRedirectError extends Error {
  readonly code = 'model_endpoint_redirect' as const;
  /** The 3xx status when the response itself was seen; undefined when fetch refused it. */
  readonly status: number | undefined;

  constructor(status?: number) {
    super(MODEL_ENDPOINT_REDIRECT_MESSAGE);
    this.name = 'ModelEndpointRedirectError';
    this.status = status;
  }
}

export function isModelEndpointRedirectError(error: unknown): error is ModelEndpointRedirectError {
  return error instanceof ModelEndpointRedirectError;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * POST/GET to a model endpoint with redirects refused.
 *
 * `redirect: 'error'` makes the platform fetch refuse before re-sending
 * anything. The status check after it covers an injected transport that does
 * not implement the redirect mode (a proxy library, a test double): the 3xx
 * is still never followed, and still surfaces as the same typed failure
 * rather than as an ordinary HTTP error carrying the response body.
 */
export async function fetchModelEndpoint(
  fetchImpl: ModelTransportFetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error' });
  } catch (error) {
    if (isFetchRedirectRefusal(error)) throw new ModelEndpointRedirectError();
    throw error;
  }
  if (response.redirected || REDIRECT_STATUSES.has(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelEndpointRedirectError(response.status);
  }
  return response;
}

/**
 * The platform's refusal of a redirect under `redirect: 'error'`. Bun throws
 * an error whose `code` is `UnexpectedRedirect` (and whose message echoes the
 * full request URL, which is why it is replaced); Node's undici throws
 * `TypeError('fetch failed')` with a cause reading "unexpected redirect".
 */
function isFetchRedirectRefusal(error: unknown): boolean {
  if (error instanceof ModelEndpointRedirectError) return true;
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === 'UnexpectedRedirect') return true;
  const cause = (error as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  return /unexpected redirect/i.test(causeMessage) || /unexpected ?redirect/i.test(error.message);
}
