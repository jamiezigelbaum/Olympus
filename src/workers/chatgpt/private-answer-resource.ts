/**
 * The `ui://olympus/private-answer` MCP Apps resource: the private answer
 * panel. LANE HANDOFF POINT: this module is the single place the MCP surface
 * (and, through the generated relay assets, the relay) loads the panel HTML
 * from, like dashboard-resource.ts for the dashboard. The page below is a
 * minimal working placeholder so the flow is testable end to end; the
 * dashboard lane replaces `privateAnswerPageHtml` with its own bundle and
 * keeps the contract in private-answer-contract.ts:
 *
 * - read `_meta["olympus/privateAnswer"]` from the tool result
 *   (`ui/notifications/tool-result`, or `window.openai.toolResponseMetadata`);
 * - on "Show private answer": generate an ECDH P-256 pair (private key
 *   non-extractable), POST `{"v":1,"publicKey"}` to
 *   `<relay origin>/private/<jobId>`, poll on 202 with the same key, decrypt
 *   a `ready` body (private-answer-crypto.ts), render it as text only;
 * - never send the answer, the key or the job id back to the host
 *   (no tools/call, no widget state, no follow-up message).
 */
import { DASHBOARD_UI_DOMAIN, MCP_APP_MIME_TYPE } from './dashboard-resource.ts';
import { PRIVATE_ANSWER_META_KEY, PRIVATE_ANSWER_RESOURCE_URI } from './private-answer-contract.ts';

export const PRIVATE_ANSWER_RESOURCE = {
  uri: PRIVATE_ANSWER_RESOURCE_URI,
  name: 'Olympus private answer',
  mimeType: MCP_APP_MIME_TYPE,
} as const;

/** Where the panel collects answers: the relay's one public origin. */
export const PRIVATE_ANSWER_RELAY_ORIGIN = 'https://mcp.olympusplugin.ai';

/** `_meta` on the resource contents: the relay is the one origin the panel may contact. */
export function privateAnswerResourceMeta(relayOrigin = PRIVATE_ANSWER_RELAY_ORIGIN): Record<string, unknown> {
  return {
    ui: { csp: { connectDomains: [relayOrigin], resourceDomains: [] }, domain: DASHBOARD_UI_DOMAIN, prefersBorder: true },
    'openai/widgetDescription': 'Shows how many private items match and, when the user asks, a private answer that ChatGPT never receives.',
  };
}

export function privateAnswerResourceHtml(relayOrigin = PRIVATE_ANSWER_RELAY_ORIGIN): string {
  return privateAnswerPageHtml({ relayOrigin });
}

/** The placeholder page. Self-contained: no external scripts, styles or fonts. */
export function privateAnswerPageHtml(options: { relayOrigin: string }): string {
  const config = JSON.stringify({ relayOrigin: options.relayOrigin, metaKey: PRIVATE_ANSWER_META_KEY }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Olympus private answer</title>
<style>
:root { color-scheme: light dark; --text: #0d0d0d; --muted: #5d5d5d; --line: #d9d9d9; --accent: #5b45c2; --on-accent: #fff; }
@media (prefers-color-scheme: dark) { :root { --text: #ececec; --muted: #b4b4b4; --line: #4a4a4a; --accent: #a594f0; --on-accent: #14121f; } }
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: transparent; }
#root { padding: 12px 16px; }
#root:empty { padding: 0; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.badge { font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
button { font: inherit; border: 0; border-radius: 8px; padding: 6px 12px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
.answer { white-space: pre-wrap; margin: 8px 0 0; }
.muted { color: var(--muted); }
ol { margin: 8px 0 0; padding-left: 20px; color: var(--muted); }
</style>
</head>
<body>
<div id="root" aria-live="polite"></div>
<script>
(function () {
  "use strict";
  var CONFIG = ${config};
  var root = document.getElementById("root");
  var info = null;
  var phase = "idle";
  var message = "";
  var result = null;

  function post(msg) { if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*"); }
  var nextId = 1;
  function request(method, params) { post({ jsonrpc: "2.0", id: nextId++, method: method, params: params || {} }); }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }

  function accept(meta) {
    var value = meta && typeof meta === "object" ? meta[CONFIG.metaKey] : null;
    if (!value || value.v !== 1 || typeof value.count !== "number" || value.count <= 0) return;
    if (info && info.jobId === value.jobId) return;
    info = value; phase = "idle"; message = ""; result = null; render();
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.method === "ui/notifications/tool-result" && msg.params) accept(msg.params._meta);
  });
  function readGlobals() { var host = window.openai; if (host && host.toolResponseMetadata) accept(host.toolResponseMetadata); }
  window.addEventListener("openai:set_globals", readGlobals);

  function b64urlToBytes(text) {
    var s = text.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64url(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  var subtle = window.crypto && window.crypto.subtle;

  async function open(jobId, privateKey, sealed) {
    var enc = new TextEncoder();
    var macKey = await subtle.importKey("raw", b64urlToBytes(sealed.macPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
    var shared = await subtle.deriveBits({ name: "ECDH", public: macKey }, privateKey, 256);
    var ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    var key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(jobId) }, ikm, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    var plain = await subtle.decrypt({ name: "AES-GCM", iv: b64urlToBytes(sealed.iv), additionalData: enc.encode(jobId) }, key, b64urlToBytes(sealed.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  var FAIL = {
    claimed: "This private answer was already opened elsewhere. If that was not you, ask again for a new one.",
    gone: "This private answer is no longer available. Ask again to get a new one.",
    failed: "Olympus could not answer this privately on your Mac.",
    mac_offline: "Your Mac is offline. Ask again when your Mac is awake and online.",
    forbidden: "This panel cannot reach Olympus from here.",
    invalid: "Olympus could not read this request.",
    network: "Olympus could not be reached. Try again shortly."
  };

  async function show() {
    if (!info || !info.jobId || phase === "working") return;
    if (!subtle) { phase = "error"; message = FAIL.forbidden; render(); return; }
    phase = "working"; message = "Preparing the private answer on your Mac..."; render();
    var jobId = info.jobId;
    try {
      var pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      var publicKey = bytesToB64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
      var deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        var response = await fetch(CONFIG.relayOrigin + "/private/" + jobId, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ v: 1, publicKey: publicKey }), credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer"
        });
        var body = null;
        try { body = await response.json(); } catch (e) { body = null; }
        var status = body && typeof body.status === "string" ? body.status : "";
        if (response.status === 200 && status === "ready") {
          result = await open(jobId, pair.privateKey, body);
          phase = "done"; message = ""; render(); return;
        }
        if ((response.status === 202 && status === "pending") || response.status === 429 || (response.status === 503 && status !== "mac_offline")) {
          if (Date.now() > deadline) { phase = "error"; message = FAIL.gone; render(); return; }
          var wait = Number(response.headers.get("retry-after")) || 2;
          await new Promise(function (resolve) { setTimeout(resolve, Math.min(10, Math.max(1, wait)) * 1000); });
          continue;
        }
        phase = "error"; message = FAIL[status] || FAIL.network; render(); return;
      }
    } catch (error) {
      phase = "error"; message = FAIL.network; render();
    }
  }

  function el(tag, text, cls) { var node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; }
  function render() {
    root.textContent = "";
    if (info) {
      var n = info.count >= 50 ? "50+" : String(info.count);
      var row = el("div", null, "row");
      row.appendChild(el("strong", n + (info.count === 1 ? " private item matches" : " private items match")));
      row.appendChild(el("span", "Not sent to ChatGPT", "badge"));
      root.appendChild(row);
      if (info.state === "no_model") root.appendChild(el("p", "Set up a private answer model in Olympus on your Mac to see a private answer here.", "muted"));
      else if (info.state === "model_downloading") root.appendChild(el("p", "The private answer model is still downloading" + (typeof info.percent === "number" ? " (" + info.percent + "%)" : "") + ". Ask again when it is ready.", "muted"));
      else if (phase === "done" && result) {
        root.appendChild(el("p", String(result.answer || ""), "answer"));
        var cites = Array.isArray(result.citations) ? result.citations : [];
        if (cites.length) {
          var list = el("ol");
          cites.forEach(function (c) { list.appendChild(el("li", [c.source, c.title, c.date].filter(Boolean).join(" \\u00b7 "))); });
          root.appendChild(list);
        }
      } else {
        var button = el("button", "Show private answer");
        button.disabled = phase === "working" || phase === "error";
        button.addEventListener("click", show);
        root.appendChild(button);
        if (message) root.appendChild(el("p", message, "muted"));
      }
    }
    var height = Math.ceil(document.documentElement.scrollHeight || 0);
    if (window.openai && typeof window.openai.notifyIntrinsicHeight === "function") window.openai.notifyIntrinsicHeight(height);
    notify("ui/notifications/size-changed", { height: height });
  }

  readGlobals();
  render();
  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "olympus-private-answer", version: "1" }, appCapabilities: {} });
  notify("ui/notifications/initialized");
})();
</script>
</body>
</html>
`;
}
