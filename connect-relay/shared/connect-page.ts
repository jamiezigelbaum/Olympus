/**
 * Connect pages: the one script a key-entry page served on a `/go/` hand-off
 * link may run (docs/design/connect-pages.md).
 *
 * A keyed source (Readwise, X bookmarks) is connected from ChatGPT by opening
 * a one-time link in a browser tab. The owner's own engine serves a small page
 * through the relay; the person types the key there, and this script encrypts
 * it in the page to a one-use public key the engine generated for that view
 * (ECDH P-256 → HKDF-SHA-256 → AES-256-GCM, WebCrypto only). The form then
 * posts only ciphertext back through the relay, which never holds a key that
 * opens it.
 *
 * Shared by the relay and the engine on purpose: the relay pins this exact
 * text by its SHA-256 in the Content-Security-Policy of every `/go/` answer,
 * so an install (any install can register) can run this script on the relay
 * origin and nothing else. Changing one byte here changes the pin: the relay
 * must be rebuilt and redeployed with the engine that serves it.
 *
 * The script reads everything it needs from the form's data attributes
 * (`data-key`: the engine's raw public key, base64url; `data-context`: the
 * bound context string) and the inputs marked `data-field`. Those inputs carry
 * no `name`, so the browser never submits their plain values, with or without
 * script. The page owns every word; the script only shows the element with id
 * `olympus-connect-error` when this browser cannot encrypt.
 */
// A distinct local name keeps the bundler from renumbering other `node:crypto` bindings in dist/.
import { createHash as connectPageScriptDigest } from 'node:crypto';

/** The protocol label, bound into the HKDF info and the AES-GCM associated data. */
export const CONNECT_PAGE_PROTOCOL = 'olympus-connect-page-v1';

/** The largest form a connect page posts (three base64url fields; a key is short). */
export const CONNECT_PAGE_MAX_REQUEST_BYTES = 8 * 1024;

/** The context both sides bind: protocol, link id and source. The engine builds its own copy. */
export function connectPageContext(linkId: string, source: string): string {
  return `${CONNECT_PAGE_PROTOCOL}|${linkId}|${source}`;
}

export const CONNECT_PAGE_SCRIPT = `(function () {
  'use strict';
  var form = document.getElementById('olympus-connect');
  if (!form) return;
  var errorBox = document.getElementById('olympus-connect-error');
  var button = document.getElementById('olympus-connect-submit');
  var busy = false;
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
      var value = String(inputs[i].value || '').trim();
      if (!value) { inputs[i].focus(); return; }
      fields[inputs[i].getAttribute('data-field')] = value;
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
