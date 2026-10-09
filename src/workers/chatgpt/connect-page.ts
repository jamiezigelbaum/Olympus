/**
 * Connect pages, engine side: the key-entry page a `/go/` hand-off link of
 * kind `key_page` serves, and the decryption of what it posts back
 * (docs/design/connect-pages.md; the in-page script is
 * connect-relay/shared/connect-page.ts).
 *
 * Each view of a page gets a fresh P-256 key pair. Its public half is written
 * into the page; its private half stays in this process's memory, beside the
 * link id, until one submission takes it or it expires. The page encrypts the
 * typed key to it (ECDH → HKDF-SHA-256 → AES-256-GCM, with the context
 * `olympus-connect-page-v1|<link id>|<source>` as HKDF info and associated
 * data), so the relay that carries the page and the post sees ciphertext only.
 *
 * Nothing here logs, and no key, ciphertext or provider message is ever put
 * in a response: every outcome is one of the fixed sentences below.
 */
import {
  CONNECT_PAGE_SCRIPT,
  CONNECT_PAGE_SCRIPT_HASH,
  connectPageContext,
} from '../../../connect-relay/shared/connect-page.ts';

/** Sources connected by typing a key on a connect page. */
export const KEY_PAGE_SOURCES = ['readwise', 'x'] as const;
export type KeyPageSource = (typeof KEY_PAGE_SOURCES)[number];

/** The exact fields each source's page sends; anything else is refused. */
export const KEY_PAGE_FIELDS: Readonly<Record<KeyPageSource, readonly string[]>> = {
  readwise: ['token'],
  x: ['client_id', 'client_secret'],
};

/** Longest value accepted for any field (Readwise tokens and X client values are far shorter). */
const MAX_FIELD_LENGTH = 512;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

export interface ConnectPageKey {
  /** Raw uncompressed P-256 point (65 bytes), written into the page. */
  publicKey: Uint8Array<ArrayBuffer>;
  privateKey: CryptoKey;
}

export function isKeyPageSource(value: unknown): value is KeyPageSource {
  return typeof value === 'string' && (KEY_PAGE_SOURCES as readonly string[]).includes(value);
}

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
  const expected = KEY_PAGE_FIELDS[input.source];
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

const LABELS: Readonly<Record<KeyPageSource, string>> = { readwise: 'Readwise', x: 'X bookmarks' };

/** The key-entry page for one view of a link. */
export function connectPageResponse(input: {
  source: KeyPageSource;
  linkId: string;
  key: ConnectPageKey;
  /** The link's own public URL (`https://<relay>/go/<id>`): the form's only target. */
  actionUrl: string;
  /** X only: the callback address the owner's X app must list. */
  xCallbackUri?: string;
}): Response {
  const label = LABELS[input.source];
  const intro = input.source === 'readwise'
    ? [
      'Paste your Readwise access token. To find it, open readwise.io/access_token in another tab and copy the token shown there.',
    ]
    : [
      'X bookmarks need your own X developer app, with paid X API access. In the app\'s settings, App permissions must be Read and Type of App must be Web App, Automated App or Bot.',
      ...(input.xCallbackUri
        ? [`Its Callback URI / Redirect URL must include exactly: ${input.xCallbackUri}`]
        : []),
      'Paste the app\'s OAuth 2.0 Client ID and Client secret from Keys & Tokens. After this page, X asks you to allow Olympus. X returns to Olympus on your computer, so finish that step on the computer Olympus runs on.',
    ];
  const fields = input.source === 'readwise'
    ? [field('token', 'Readwise access token')]
    : [field('client_id', 'OAuth 2.0 Client ID'), field('client_secret', 'Client secret')];
  const body = [
    `<h1>Connect ${label} to Olympus</h1>`,
    ...intro.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<form id="olympus-connect" method="post" action="${escapeHtml(input.actionUrl)}" data-key="${toBase64Url(input.key.publicKey)}" data-context="${escapeHtml(connectPageContext(input.linkId, input.source))}" autocomplete="off">`,
    ...fields,
    '<input type="hidden" id="olympus-connect-epk" name="epk" value="">',
    '<input type="hidden" id="olympus-connect-iv" name="iv" value="">',
    '<input type="hidden" id="olympus-connect-ct" name="ct" value="">',
    '<button type="submit" id="olympus-connect-submit">Connect</button>',
    '</form>',
    '<p id="olympus-connect-error" hidden>This browser could not lock the key for sending. Nothing was sent. Try a current version of Safari, Chrome, Edge or Firefox.</p>',
    '<p class="note">What you type is locked in this page so that only Olympus on your computer can read it. It never goes through ChatGPT, and this page works once. If you reload it, go back to ChatGPT and press Connect again.</p>',
    `<script>${CONNECT_PAGE_SCRIPT}</script>`,
  ].join('');
  return htmlResponse(200, `Connect ${label}`, body, connectPageCsp(input.actionUrl));
}

/** A one-sentence result page (no script, no form). */
export function connectPageMessage(status: number, sentence: string, link?: { href: string; label: string }): Response {
  const action = link ? `<p><a href="${escapeHtml(link.href)}" rel="noreferrer">${escapeHtml(link.label)}</a></p>` : '';
  return htmlResponse(status, 'Olympus', `<p>${escapeHtml(sentence)}</p>${action}`, MESSAGE_CSP);
}

const MESSAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function connectPageCsp(actionUrl: string): string {
  return [
    'sandbox allow-scripts allow-forms',
    "default-src 'none'",
    `script-src ${CONNECT_PAGE_SCRIPT_HASH}`,
    "style-src 'unsafe-inline'",
    `form-action ${new URL(actionUrl).origin}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function field(name: string, label: string): string {
  // No `name`: the plain value is never part of the submitted form.
  return `<label>${escapeHtml(label)}<input type="password" data-field="${name}" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>`;
}

const STYLE = 'body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}'
  + 'h1{font-size:1.4rem}label{display:block;margin:1rem 0;font-weight:600}'
  + 'input{display:block;width:100%;box-sizing:border-box;margin-top:.35rem;padding:.6rem;font:inherit;border:1px solid #8e8e93;border-radius:8px}'
  + 'button{font:inherit;font-weight:600;padding:.6rem 1.4rem;border:0;border-radius:8px;background:#1d1d1f;color:#fff}'
  + '.note{color:#555;font-size:.9rem;margin-top:1.5rem}#olympus-connect-error{color:#b3261e}'
  + '@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#f2f2f7}input{background:#2c2c2e;color:#f2f2f7}button{background:#f2f2f7;color:#1c1c1e}.note{color:#aeaeb2}}';

function htmlResponse(status: number, title: string, body: string, csp: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': csp,
      },
    },
  );
}

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
