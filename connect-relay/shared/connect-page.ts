/**
 * Connect pages: the key-entry page for a keyed source (Readwise, X
 * bookmarks), rendered by the relay from this fixed template
 * (docs/design/connect-pages.md).
 *
 * A keyed source is connected from ChatGPT by opening a one-time `/go/` link
 * in a browser tab. The engine answers that link with a small descriptor
 * (CONNECT_PAGE_DESCRIPTOR_TYPE): which source, plus a one-use P-256 public
 * key it generated for this view. The relay checks the descriptor against a
 * closed shape and renders the page itself, from this template, with its own
 * labels, its own fixed fields and its own script. Any install can register,
 * so an install's own HTML on `/go/` is never given script or a form (it
 * keeps the relay's no-script sandbox). The most a rogue install can show
 * through `/go/` is this genuine page, keyed to itself: the same
 * consent-phishing class the OAuth hand-offs already carry.
 *
 * The script encrypts the typed key in the page to the engine's key
 * (ECDH P-256 → HKDF-SHA-256 → AES-256-GCM, WebCrypto only) and posts only
 * `epk`, `iv` and `ct`. The relay forwards a POST only in exactly that
 * shape. It never holds a key that opens the ciphertext.
 *
 * Shared by the relay (which renders and pins the script by its SHA-256) and
 * the engine (which decrypts, using the same context and field lists).
 */
// A distinct local name keeps the bundler from renumbering other `node:crypto` bindings in dist/.
import { createHash as connectPageScriptDigest } from 'node:crypto';

/** The protocol label, bound into the HKDF info and the AES-GCM associated data. */
export const CONNECT_PAGE_PROTOCOL = 'olympus-connect-page-v1';

/**
 * The capability the relay advertises in its session `ready` message when it
 * renders connect pages. An engine offers a key page only to a relay that
 * advertised it; otherwise the source keeps its help link.
 */
export const CONNECT_PAGE_CAPABILITY = 'connect_page_v1';

/** The media type of the engine's answer to a key-page link; the relay renders it, never passes it on. */
export const CONNECT_PAGE_DESCRIPTOR_TYPE = 'application/vnd.olympus.connect-page+json';

/** Largest descriptor the relay reads. */
export const CONNECT_PAGE_DESCRIPTOR_MAX_BYTES = 1024;

/** The largest form a connect page posts (three base64url fields; a key is short). */
export const CONNECT_PAGE_MAX_REQUEST_BYTES = 8 * 1024;

/** Sources connected by typing a key on a connect page. */
export const CONNECT_PAGE_SOURCES = ['readwise', 'x'] as const;
export type ConnectPageSource = (typeof CONNECT_PAGE_SOURCES)[number];

/** The fixed fields each source's page has, and so the exact set the engine accepts. */
export const CONNECT_PAGE_FIELDS: Readonly<Record<ConnectPageSource, ReadonlyArray<{ name: string; label: string }>>> = {
  readwise: [{ name: 'token', label: 'Readwise access token' }],
  x: [{ name: 'client_id', label: 'OAuth 2.0 Client ID' }, { name: 'client_secret', label: 'Client secret' }],
};

const LABELS: Readonly<Record<ConnectPageSource, string>> = { readwise: 'Readwise', x: 'X bookmarks' };

/** The context both sides bind: protocol, link id and source. */
export function connectPageContext(linkId: string, source: string): string {
  return `${CONNECT_PAGE_PROTOCOL}|${linkId}|${source}`;
}

export function isConnectPageSource(value: unknown): value is ConnectPageSource {
  return typeof value === 'string' && (CONNECT_PAGE_SOURCES as readonly string[]).includes(value);
}

/** What the engine answers a key-page link with. */
export interface ConnectPageDescriptor {
  v: 1;
  source: ConnectPageSource;
  /** The engine's one-view public key: raw uncompressed P-256, base64url (87 characters). */
  key: string;
  /** X only: the callback address the owner's X app must list (the computer's own loopback dashboard). */
  callback?: string;
}

const PUBLIC_KEY = /^B[A-Za-z0-9_-]{86}$/;
const X_CALLBACK = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/oauth\/callback\/x$/;

/** A descriptor in exactly the closed shape, or undefined. Nothing else from the install is shown. */
export function parseConnectPageDescriptor(text: string): ConnectPageDescriptor | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const source = record.source;
  if (record.v !== 1 || !isConnectPageSource(source)) return undefined;
  if (typeof record.key !== 'string' || !PUBLIC_KEY.test(record.key)) return undefined;
  const expected = source === 'x' && record.callback !== undefined ? ['callback', 'key', 'source', 'v'] : ['key', 'source', 'v'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return undefined;
  if (record.callback !== undefined && (typeof record.callback !== 'string' || !X_CALLBACK.test(record.callback))) return undefined;
  return { v: 1, source, key: record.key, ...(typeof record.callback === 'string' ? { callback: record.callback } : {}) };
}

/** Whether a POST body is exactly a sealed submission: `epk`, `iv`, `ct`, once each, nothing else. */
export function isConnectPageSubmission(body: string): boolean {
  if (body.length > CONNECT_PAGE_MAX_REQUEST_BYTES || !/^[A-Za-z0-9_=&-]*$/.test(body)) return false;
  const params = new URLSearchParams(body);
  const names = [...params.keys()];
  if (names.length !== 3 || [...names].sort().join(',') !== 'ct,epk,iv') return false;
  return PUBLIC_KEY.test(params.get('epk')!)
    && /^[A-Za-z0-9_-]{16}$/.test(params.get('iv')!)
    && /^[A-Za-z0-9_-]{24,5600}$/.test(params.get('ct')!);
}

export const CONNECT_PAGE_SCRIPT = `(function () {
  'use strict';
  var form = document.getElementById('olympus-connect');
  if (!form) return;
  var errorBox = document.getElementById('olympus-connect-error');
  var button = document.getElementById('olympus-connect-submit');
  var allowed = { token: 1, client_id: 1, client_secret: 1 };
  var busy = false;
  if (errorBox) errorBox.hidden = true;
  if (button) button.disabled = false;
  function b64u(bytes) {
    var text = '';
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function unb64u(text) {
    var raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function join(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }
  function seal(enginePublic, context, plaintext) {
    var subtle = crypto.subtle;
    var curve = { name: 'ECDH', namedCurve: 'P-256' };
    return subtle.generateKey(curve, true, ['deriveBits']).then(function (pair) {
      return Promise.all([
        subtle.exportKey('raw', pair.publicKey),
        subtle.importKey('raw', enginePublic, curve, false, []).then(function (peer) {
          return subtle.deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256);
        })
      ]);
    }).then(function (parts) {
      var pagePublic = new Uint8Array(parts[0]);
      return subtle.importKey('raw', parts[1], 'HKDF', false, ['deriveKey']).then(function (secret) {
        return subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: join(pagePublic, enginePublic), info: context },
          secret,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt']
        );
      }).then(function (key) {
        var iv = crypto.getRandomValues(new Uint8Array(12));
        return subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: context }, key, plaintext).then(function (sealed) {
          return { epk: b64u(pagePublic), iv: b64u(iv), ct: b64u(new Uint8Array(sealed)) };
        });
      });
    });
  }
  function failed() {
    busy = false;
    if (button) button.disabled = false;
    if (errorBox) errorBox.hidden = false;
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    var inputs = form.querySelectorAll('input[data-field]');
    var fields = {};
    for (var i = 0; i < inputs.length; i++) {
      var name = inputs[i].getAttribute('data-field');
      if (!allowed[name]) { failed(); return; }
      var value = String(inputs[i].value || '').trim();
      if (!value) { inputs[i].focus(); return; }
      fields[name] = value;
    }
    busy = true;
    if (button) button.disabled = true;
    var encoder = new TextEncoder();
    var sealing;
    try {
      sealing = seal(
        unb64u(form.getAttribute('data-key') || ''),
        encoder.encode(form.getAttribute('data-context') || ''),
        encoder.encode(JSON.stringify(fields))
      );
    } catch (error) {
      failed();
      return;
    }
    sealing.then(function (out) {
      for (var j = 0; j < inputs.length; j++) inputs[j].value = '';
      document.getElementById('olympus-connect-epk').value = out.epk;
      document.getElementById('olympus-connect-iv').value = out.iv;
      document.getElementById('olympus-connect-ct').value = out.ct;
      form.submit();
    }, failed);
  });
})();`;

/** The CSP source expression that allows exactly CONNECT_PAGE_SCRIPT. */
export const CONNECT_PAGE_SCRIPT_HASH = `'sha256-${connectPageScriptDigest('sha256').update(CONNECT_PAGE_SCRIPT, 'utf8').digest('base64')}'`;

/** The rendered page's policy: an opaque-origin sandbox, the one pinned script, a form back to `/go/` only. */
export function connectPageCsp(relayOrigin: string): string {
  return [
    'sandbox allow-scripts allow-forms',
    "default-src 'none'",
    `script-src ${CONNECT_PAGE_SCRIPT_HASH}`,
    "style-src 'unsafe-inline'",
    `form-action ${new URL(relayOrigin).origin}/go/`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The key-entry page for one view of a link. Every word, label and field is
 * this template's; from the engine come only the source (a closed list), its
 * public key (checked shape) and, for X, a loopback callback (checked shape).
 */
export function renderConnectPage(input: { descriptor: ConnectPageDescriptor; linkId: string; relayOrigin: string }): string {
  const { descriptor, linkId } = input;
  const label = LABELS[descriptor.source];
  const intro = descriptor.source === 'readwise'
    ? ['Paste your Readwise access token. To find it, open readwise.io/access_token in another tab and copy the token shown there.']
    : [
      'X bookmarks need your own X developer app, with paid X API access. In the app\'s settings, App permissions must be Read and Type of App must be Web App, Automated App or Bot.',
      ...(descriptor.callback ? [`Its Callback URI / Redirect URL must include exactly: ${descriptor.callback}`] : []),
      'Paste the app\'s OAuth 2.0 Client ID and Client secret from Keys & Tokens. After this page, X asks you to allow Olympus. X returns to Olympus on your computer, so finish that step on the computer Olympus runs on.',
    ];
  const fields = CONNECT_PAGE_FIELDS[descriptor.source].map((field) => (
    // No `name`: the plain value is never part of the submitted form.
    `<label>${escapeHtml(field.label)}<input type="password" data-field="${field.name}" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>`
  ));
  const action = `${new URL(input.relayOrigin).origin}/go/${linkId}`;
  const body = [
    `<h1>Connect ${escapeHtml(label)} to Olympus</h1>`,
    ...intro.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<form id="olympus-connect" method="post" action="${escapeHtml(action)}" data-key="${escapeHtml(descriptor.key)}" data-context="${escapeHtml(connectPageContext(linkId, descriptor.source))}" autocomplete="off">`,
    ...fields,
    '<input type="hidden" id="olympus-connect-epk" name="epk" value="">',
    '<input type="hidden" id="olympus-connect-iv" name="iv" value="">',
    '<input type="hidden" id="olympus-connect-ct" name="ct" value="">',
    // Disabled until the script runs, and the error shows until it does: a
    // browser that blocks the script says so instead of doing nothing.
    '<button type="submit" id="olympus-connect-submit" disabled>Connect</button>',
    '</form>',
    '<p id="olympus-connect-error">This page needs its script to lock the key before sending, and this browser did not run it. Nothing was sent. Try a current version of Safari, Chrome, Edge or Firefox, then go back to ChatGPT and press Connect again.</p>',
    '<p class="note">What you type is locked in this page so that only Olympus on your computer can read it. It never goes through ChatGPT, and this page works once. If you reload it, go back to ChatGPT and press Connect again.</p>',
    `<script>${CONNECT_PAGE_SCRIPT}</script>`,
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Connect ${escapeHtml(label)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

const STYLE = 'body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}'
  + 'h1{font-size:1.4rem}label{display:block;margin:1rem 0;font-weight:600}'
  + 'input{display:block;width:100%;box-sizing:border-box;margin-top:.35rem;padding:.6rem;font:inherit;border:1px solid #8e8e93;border-radius:8px}'
  + 'button{font:inherit;font-weight:600;padding:.6rem 1.4rem;border:0;border-radius:8px;background:#1d1d1f;color:#fff}'
  + '.note{color:#555;font-size:.9rem;margin-top:1.5rem}#olympus-connect-error{color:#b3261e}'
  + '@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#f2f2f7}input{background:#2c2c2e;color:#f2f2f7}button{background:#f2f2f7;color:#1c1c1e}.note{color:#aeaeb2}}';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
