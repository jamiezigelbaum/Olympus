/**
 * Connect pages, engine side (docs/design/connect-pages.md): the descriptor a
 * `/go/` hand-off link of kind `key_page` answers with, the decryption of what
 * the page posts back, and the one-sentence result pages.
 *
 * The page itself is rendered by the relay from its own fixed template
 * (connect-relay/shared/connect-page.ts); this engine supplies only the
 * source and a fresh P-256 public key for that one view. The private half
 * stays in this process's memory, beside the link id, until a submission
 * opens with it or it expires. The page encrypts the typed key to it
 * (ECDH → HKDF-SHA-256 → AES-256-GCM, with the context
 * `olympus-connect-page-v1|<link id>|<source>` as HKDF info and associated
 * data), so the relay that carries the page and the post sees ciphertext only.
 *
 * Nothing here logs, and no key, ciphertext or provider message is ever put
 * in a response: every outcome is one of the fixed sentences in handoff.ts.
 */
import {
  CONNECT_PAGE_DESCRIPTOR_TYPE,
  CONNECT_PAGE_FIELDS,
  CONNECT_PAGE_SOURCES,
  connectPageContext,
  isConnectPageSource,
  type ConnectPageDescriptor,
  type ConnectPageSource,
} from '../../../connect-relay/shared/connect-page.ts';

/** Sources connected by typing a key on a connect page. */
export const KEY_PAGE_SOURCES = CONNECT_PAGE_SOURCES;
export type KeyPageSource = ConnectPageSource;

/** Longest value accepted for any field (Readwise tokens and X client values are far shorter). */
const MAX_FIELD_LENGTH = 512;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

export interface ConnectPageKey {
  /** Raw uncompressed P-256 point (65 bytes), written into the page. */
  publicKey: Uint8Array<ArrayBuffer>;
  privateKey: CryptoKey;
}

export const isKeyPageSource = isConnectPageSource;

/** A fresh one-view key pair; the private key cannot be exported. */
export async function createConnectPageKey(): Promise<ConnectPageKey> {
  const pair = await crypto.subtle.generateKey(CURVE, false, ['deriveBits']) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey, privateKey: pair.privateKey };
}

/**
 * The fields a page sealed, or undefined for anything that does not open
 * exactly: a missing or malformed part, the wrong key or context, a tampered
 * ciphertext, or a field set other than the source's own.
 */
export async function openConnectPageSubmission(input: {
  key: ConnectPageKey;
  linkId: string;
  source: KeyPageSource;
  form: URLSearchParams;
}): Promise<Record<string, string> | undefined> {
  const pagePublic = fromBase64Url(input.form.get('epk'), 65);
  const iv = fromBase64Url(input.form.get('iv'), 12);
  const sealed = fromBase64Url(input.form.get('ct'));
  if (!pagePublic || !iv || !sealed || sealed.length < 17 || sealed.length > 4096) return undefined;
  const context = new TextEncoder().encode(connectPageContext(input.linkId, input.source));
  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    const peer = await crypto.subtle.importKey('raw', pagePublic, CURVE, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, input.key.privateKey, 256);
    const secret = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const aes = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: concat(pagePublic, input.key.publicKey), info: context },
      secret,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: context }, aes, sealed));
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    return undefined;
  } finally {
    plaintext.fill(0);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const expected = CONNECT_PAGE_FIELDS[input.source].map((field) => field.name);
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== expected.length || !expected.every((name) => keys.includes(name))) return undefined;
  const fields: Record<string, string> = {};
  for (const name of expected) {
    const value = record[name];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_FIELD_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
    fields[name] = trimmed;
  }
  return fields;
}

/** The answer to a key-page link: the source and this view's public key; the relay renders the page. */
export function connectPageDescriptorResponse(input: { source: KeyPageSource; key: ConnectPageKey; xCallbackUri?: string }): Response {
  const descriptor: ConnectPageDescriptor = {
    v: 1,
    source: input.source,
    key: toBase64Url(input.key.publicKey),
    ...(input.source === 'x' && input.xCallbackUri ? { callback: input.xCallbackUri } : {}),
  };
  return new Response(JSON.stringify(descriptor), {
    status: 200,
    headers: {
      'Content-Type': CONNECT_PAGE_DESCRIPTOR_TYPE,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/** A one-sentence result page (no script, no form). */
export function connectPageMessage(status: number, sentence: string, link?: { href: string; label: string }): Response {
  const action = link ? `<p><a href="${escapeHtml(link.href)}" rel="noreferrer">${escapeHtml(link.label)}</a></p>` : '';
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Olympus</title><style>${STYLE}</style></head><body><p>${escapeHtml(sentence)}</p>${action}</body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    },
  );
}

const STYLE = 'body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}'
  + '@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#f2f2f7}a{color:#8ab4f8}}';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function concat(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64Url(value: string | null, length?: number): Uint8Array<ArrayBuffer> | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,6000}$/.test(value)) return undefined;
  const bytes = new Uint8Array(Buffer.from(value, 'base64url'));
  if (length !== undefined && bytes.length !== length) return undefined;
  return bytes;
}
