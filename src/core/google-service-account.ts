import { createSign } from 'node:crypto';

// One RS256 service-account signer for the whole repo. Independent copies of
// this drift, and the drift shows up as an auth failure nobody can localise,
// so every caller that mints an assertion — the Vertex lane
// (core/connect-gcp.ts), the credential broker's JWT-bearer lane, and the
// retrieval worker — calls in here.

export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

const DEFAULT_ASSERTION_LIFETIME_SECONDS = 3600;
const MAX_ASSERTION_LIFETIME_SECONDS = 3600;

export interface GoogleServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
}

export interface SignGoogleServiceAccountJwtOptions {
  credential: GoogleServiceAccountKey;
  scopes: readonly string[];
  /**
   * Domain-wide delegation: the address whose data the assertion acts for.
   * Omit for a plain service-account identity (the Vertex lane).
   */
  subject?: string;
  now?: Date;
  lifetimeSeconds?: number;
}

/**
 * Parse and validate a Google service-account key JSON.
 *
 * Every failure message here is deliberately generic: the input is secret
 * material, so no branch may echo the credential, any field of it, or its
 * length back to a caller that might log the error.
 */
export function parseGoogleServiceAccountKey(
  rawCredential: string | undefined,
  options: { expectedClientEmail?: string } = {},
): GoogleServiceAccountKey {
  if (!rawCredential?.trim()) throw new Error('Google service-account credential is empty.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCredential) as unknown;
  } catch {
    throw new Error('Google service-account credential is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Google service-account credential must be a JSON object.');
  }
  const credential = parsed as Partial<GoogleServiceAccountKey>;
  if (credential.type !== 'service_account') {
    throw new Error('Google credential JSON must be a service_account key.');
  }
  if (typeof credential.client_email !== 'string' || !credential.client_email.trim()) {
    throw new Error('Google service-account credential JSON is missing client_email.');
  }
  if (options.expectedClientEmail && credential.client_email !== options.expectedClientEmail) {
    throw new Error(`GCP credential client_email does not match ${options.expectedClientEmail}.`);
  }
  if (typeof credential.private_key !== 'string' || !credential.private_key.includes('PRIVATE KEY')) {
    throw new Error('Google service-account credential JSON is missing private_key.');
  }
  if (typeof credential.project_id !== 'string' || !credential.project_id.trim()) {
    throw new Error('Google service-account credential JSON is missing project_id.');
  }
  if (credential.token_uri !== undefined
    && (typeof credential.token_uri !== 'string' || !/^https:\/\//.test(credential.token_uri))) {
    throw new Error('Google service-account credential token_uri must be an https URL.');
  }
  return {
    type: 'service_account',
    project_id: credential.project_id,
    private_key: credential.private_key,
    client_email: credential.client_email,
    ...(typeof credential.private_key_id === 'string' ? { private_key_id: credential.private_key_id } : {}),
    ...(credential.token_uri ? { token_uri: credential.token_uri } : {}),
  };
}

export function googleServiceAccountTokenUrl(credential: GoogleServiceAccountKey): string {
  return credential.token_uri || GOOGLE_OAUTH_TOKEN_URL;
}

/**
 * Build the signed RS256 assertion Google exchanges for an access token.
 *
 * `sub` is what makes one delegated key serve several mailboxes, so it is an
 * explicit per-call argument rather than a module constant.
 */
export function signGoogleServiceAccountJwt(options: SignGoogleServiceAccountJwtOptions): string {
  const scope = normalizedScopeClaim(options.scopes);
  const subject = options.subject?.trim();
  if (options.subject !== undefined && !subject) {
    throw new Error('Google service-account impersonated subject must be non-empty.');
  }
  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const lifetimeSeconds = normalizedLifetimeSeconds(options.lifetimeSeconds);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: options.credential.client_email,
    scope,
    aud: googleServiceAccountTokenUrl(options.credential),
    iat: nowSeconds,
    exp: nowSeconds + lifetimeSeconds,
    ...(subject ? { sub: subject } : {}),
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(options.credential.private_key);
  return `${unsigned}.${base64Url(signature)}`;
}

/** Google reads `scope` as a single space-joined string, not a list. */
function normalizedScopeClaim(scopes: readonly string[]): string {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  // An assertion with no scope mints a token that authorises nothing and fails
  // later, at the API call, far from the cause.
  if (normalized.length === 0) throw new Error('Google service-account assertion requires at least one scope.');
  return normalized.join(' ');
}

function normalizedLifetimeSeconds(lifetimeSeconds: number | undefined): number {
  if (lifetimeSeconds === undefined) return DEFAULT_ASSERTION_LIFETIME_SECONDS;
  if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw new Error('Google service-account assertion lifetime must be positive.');
  }
  // Google rejects an assertion claiming more than an hour.
  return Math.min(Math.floor(lifetimeSeconds), MAX_ASSERTION_LIFETIME_SECONDS);
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value), 'utf8'));
}

function base64Url(value: Buffer): string {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
