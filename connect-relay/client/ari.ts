/**
 * ACME Renewal Information (ARI, RFC 9773).
 *
 * The CA tells the install when to renew: `GET <renewalInfo>/<certID>` returns
 * a suggested window, and a replacement order names the certificate it
 * replaces (`replaces`). Let's Encrypt exempts such renewals from every rate
 * limit, which matters because first issuances share about 50 certificates a
 * week across the whole relay domain. It also lets the CA pull renewals
 * forward before a mass revocation.
 *
 * When the CA offers no ARI, or the certificate has no Authority Key
 * Identifier, the caller falls back to its proportional rule.
 */
import { X509Certificate } from 'node:crypto';
import { base64url } from '../shared/protocol.ts';

export interface RenewalWindow {
  /** Epoch milliseconds. */
  readonly start: number;
  readonly end: number;
}

export interface RenewalInfo {
  readonly certId: string;
  readonly window: RenewalWindow;
  /** How long this answer may be reused (the server's Retry-After, bounded). */
  readonly retryAfterMs: number;
  readonly explanationUrl?: string;
}

/** Retry-After bounds: RFC 9773 suggests clients poll a few times a day. */
const DEFAULT_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const MIN_RETRY_AFTER_MS = 60 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly end: number;
}

function readTlv(der: Buffer, offset: number): Tlv {
  const tag = der[offset];
  let length = der[offset + 1];
  if (tag === undefined || length === undefined) throw new Error('truncated DER');
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error('unsupported DER length');
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + der[start + i]!;
    start += count;
  }
  const end = start + length;
  if (end > der.length) throw new Error('truncated DER');
  return { tag, start, end };
}

function children(der: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let offset = parent.start; offset < parent.end; ) {
    const child = readTlv(der, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

const OID_AUTHORITY_KEY_IDENTIFIER = Buffer.from([0x55, 0x1d, 0x23]); // 2.5.29.35

/**
 * The RFC 9773 certificate identifier: base64url(AKI keyIdentifier) "."
 * base64url(serial number content octets, leading zero kept). Undefined when
 * the certificate cannot be parsed or has no keyIdentifier.
 */
export function ariCertId(pem: string): string | undefined {
  try {
    const der = new X509Certificate(pem).raw;
    const certificate = readTlv(der, 0);
    const tbs = children(der, certificate)[0];
    if (!tbs) return undefined;
    const fields = children(der, tbs);
    // An explicit version ([0]) comes first when present, then the serial.
    const serial = fields[fields[0]?.tag === 0xa0 ? 1 : 0];
    if (serial?.tag !== 0x02) return undefined;
    const extensions = fields.find((field) => field.tag === 0xa3);
    if (!extensions) return undefined;
    const list = children(der, extensions)[0];
    if (!list) return undefined;
    for (const extension of children(der, list)) {
      const [oid, ...rest] = children(der, extension);
      if (!oid || oid.tag !== 0x06 || !der.subarray(oid.start, oid.end).equals(OID_AUTHORITY_KEY_IDENTIFIER)) continue;
      const value = rest.find((part) => part.tag === 0x04);
      if (!value) return undefined;
      const aki = readTlv(der, value.start);
      const keyIdentifier = children(der, aki).find((part) => part.tag === 0x80);
      if (!keyIdentifier || keyIdentifier.end === keyIdentifier.start) return undefined;
      return `${base64url(der.subarray(keyIdentifier.start, keyIdentifier.end))}.${base64url(der.subarray(serial.start, serial.end))}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The directory's `renewalInfo` URL, or undefined when the CA offers no ARI. */
export async function fetchRenewalInfoUrl(directoryUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const response = await fetchImpl(directoryUrl);
  if (!response.ok) return undefined;
  const directory = (await response.json()) as { renewalInfo?: unknown };
  return typeof directory.renewalInfo === 'string' && /^https?:\/\//.test(directory.renewalInfo) ? directory.renewalInfo : undefined;
}

/**
 * Asks the CA when `pem` should be renewed. Undefined when the CA has no ARI,
 * the certificate has no ARI identifier, or the answer is malformed; network
 * errors throw, so the caller can keep an earlier answer.
 */
export async function fetchRenewalInfo(
  directoryUrl: string,
  pem: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RenewalInfo | undefined> {
  const certId = ariCertId(pem);
  if (!certId) return undefined;
  const base = await fetchRenewalInfoUrl(directoryUrl, fetchImpl);
  if (!base) return undefined;
  const response = await fetchImpl(`${base.replace(/\/+$/, '')}/${certId}`);
  if (!response.ok) {
    // 404: the CA does not know this certificate (another CA, or too old).
    if (response.status === 404) return undefined;
    throw new Error(`ARI answered HTTP ${response.status}`);
  }
  const body = (await response.json()) as { suggestedWindow?: { start?: unknown; end?: unknown }; explanationURL?: unknown };
  const start = Date.parse(String(body.suggestedWindow?.start));
  const end = Date.parse(String(body.suggestedWindow?.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return {
    certId,
    window: { start, end },
    retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
    ...(typeof body.explanationURL === 'string' ? { explanationUrl: body.explanationURL } : {}),
  };
}

function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));
}

/**
 * A uniformly random moment inside the window (RFC 9773 section 4.2), so
 * installs do not all renew at once. A window already over means now.
 */
export function selectRenewalTime(window: RenewalWindow, random: () => number = Math.random): number {
  return window.start + Math.floor(random() * Math.max(0, window.end - window.start));
}
