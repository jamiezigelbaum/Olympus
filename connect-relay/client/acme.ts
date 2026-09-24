/**
 * Minimal ACME (RFC 8555) client for one DNS-01 certificate.
 *
 * Runs on the install. The ACME account key, the certificate key, and the CSR
 * are local; the only thing that leaves through the relay is the DNS-01 TXT
 * value (a digest of the key authorization), which the relay publishes.
 */
import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { base64url } from '../shared/protocol.ts';
import { createCsr } from './csr.ts';

export interface AcmeDnsPublisher {
  publish(value: string): Promise<void>;
  clear(value: string): Promise<void>;
}

export interface ObtainCertificateOptions {
  readonly directoryUrl: string;
  readonly accountKey: KeyObject;
  readonly certificateKey: KeyObject;
  readonly hostname: string;
  readonly dns: AcmeDnsPublisher;
  /** Must be true: the caller has shown the CA's subscriber agreement to the user. */
  readonly termsOfServiceAgreed: boolean;
  readonly fetch?: typeof fetch;
  /** Wait after publishing before asking the CA to validate. */
  readonly propagationDelayMs?: number;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
}

interface AcmeResponse {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
  text: string;
}

export class AcmeError extends Error {
  constructor(message: string, readonly problem?: unknown) {
    super(message);
  }
}

export function jwkThumbprint(jwk: { crv?: string; kty?: string; x?: string; y?: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return base64url(createHash('sha256').update(canonical).digest());
}

export function dns01Value(token: string, thumbprint: string): string {
  return base64url(createHash('sha256').update(`${token}.${thumbprint}`).digest());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function obtainCertificate(options: ObtainCertificateOptions): Promise<string> {
  if (!options.termsOfServiceAgreed) throw new AcmeError('the CA subscriber agreement has not been accepted');
  const fetchImpl = options.fetch ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  const jwk = createPublicKey(options.accountKey).export({ format: 'jwk' });
  const thumbprint = jwkThumbprint(jwk);
  const directory = (await (await fetchImpl(options.directoryUrl)).json()) as Directory;
  let nonce: string | undefined;
  let kid: string | undefined;

  const freshNonce = async () => {
    const response = await fetchImpl(directory.newNonce, { method: 'HEAD' });
    const value = response.headers.get('replay-nonce');
    if (!value) throw new AcmeError('ACME server returned no nonce');
    return value;
  };

  const post = async (url: string, payload: unknown, accept?: string, retried = false): Promise<AcmeResponse> => {
    nonce ??= await freshNonce();
    const header = { alg: 'ES256', nonce, url, ...(kid ? { kid } : { jwk }) };
    const protectedHeader = base64url(Buffer.from(JSON.stringify(header)));
    const encodedPayload = payload === undefined ? '' : base64url(Buffer.from(JSON.stringify(payload)));
    const signature = sign('sha256', Buffer.from(`${protectedHeader}.${encodedPayload}`), {
      key: options.accountKey,
      dsaEncoding: 'ieee-p1363',
    });
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/jose+json', ...(accept ? { accept } : {}) },
      body: JSON.stringify({ protected: protectedHeader, payload: encodedPayload, signature: base64url(signature) }),
    });
    nonce = response.headers.get('replay-nonce') ?? undefined;
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if ((response.headers.get('content-type') ?? '').includes('json') && text) body = JSON.parse(text) as Record<string, unknown>;
    if (response.status >= 400) {
      if (!retried && body.type === 'urn:ietf:params:acme:error:badNonce') {
        nonce = undefined;
        return post(url, payload, accept, true);
      }
      throw new AcmeError(`ACME request failed with HTTP ${response.status}: ${String(body.detail ?? '')}`, body);
    }
    return { status: response.status, headers: response.headers, body, text };
  };

  const pollUntil = async (url: string, done: (status: string) => boolean): Promise<Record<string, unknown>> => {
    for (;;) {
      const { body } = await post(url, undefined);
      const status = String(body.status);
      if (done(status)) return body;
      if (status === 'invalid') throw new AcmeError(`ACME object ${url} became invalid`, body);
      if (Date.now() > deadline) throw new AcmeError(`timed out waiting for ${url}`);
      await sleep(pollIntervalMs);
    }
  };

  const account = await post(directory.newAccount, { termsOfServiceAgreed: true });
  kid = account.headers.get('location') ?? undefined;
  if (!kid) throw new AcmeError('ACME account has no URL');

  const order = await post(directory.newOrder, { identifiers: [{ type: 'dns', value: options.hostname }] });
  const orderUrl = order.headers.get('location');
  if (!orderUrl) throw new AcmeError('ACME order has no URL');
  const authorizations = order.body.authorizations as string[];
  const published: string[] = [];
  try {
    for (const authorizationUrl of authorizations) {
      const { body: authorization } = await post(authorizationUrl, undefined);
      if (authorization.status === 'valid') continue;
      const challenge = (authorization.challenges as Array<{ type: string; url: string; token: string }>).find(
        (candidate) => candidate.type === 'dns-01',
      );
      if (!challenge) throw new AcmeError('ACME authorization offers no dns-01 challenge');
      const value = dns01Value(challenge.token, thumbprint);
      await options.dns.publish(value);
      published.push(value);
      if (options.propagationDelayMs) await sleep(options.propagationDelayMs);
      await post(challenge.url, {});
      await pollUntil(authorizationUrl, (status) => status === 'valid');
    }
    const csr = createCsr(options.hostname, options.certificateKey);
    await post(order.body.finalize as string, { csr: base64url(csr) });
    const finished = await pollUntil(orderUrl, (status) => status === 'valid');
    const certificate = await post(finished.certificate as string, undefined, 'application/pem-certificate-chain');
    if (!certificate.text.includes('BEGIN CERTIFICATE')) throw new AcmeError('ACME server returned no certificate');
    return certificate.text;
  } finally {
    for (const value of published) await options.dns.clear(value).catch(() => {});
  }
}
