// PROTOTYPE: a fetch() that talks to the daemon over the bridge's Unix socket,
// built on node:http so it behaves the same under Bun and Node. It keeps the
// parts of fetch the transport relies on: url, method, headers, string body,
// abort signal, redirect refusal, a streaming Response.
'use strict';
const http = require('node:http');
const { Readable } = require('node:stream');

function unixFetch(socketPath) {
  return (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (init.redirect !== undefined && init.redirect !== 'error' && init.redirect !== 'manual') return reject(new TypeError('unsupported redirect mode'));
    const headers = {};
    for (const [k, v] of new Headers(init.headers || {})) headers[k] = v;
    const aborted = () => new DOMException('This operation was aborted', 'AbortError');
    if (init.signal && init.signal.aborted) return reject(aborted());
    let current;
    // Abort is handled here, not through http.request's signal option, which
    // does not settle on Bun for Unix-socket requests.
    const onAbort = () => { const err = aborted(); if (current) current.destroy(err); reject(err); };
    if (init.signal) init.signal.addEventListener('abort', onAbort, { once: true });
    const req = http.request({ socketPath, path: url.pathname + url.search, method: init.method || 'GET', headers }, (res) => {
      current = res;
      if (res.statusCode >= 300 && res.statusCode < 400 && init.redirect === 'error') { res.destroy(); return reject(new TypeError('redirect refused')); }
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const item of [].concat(v)) out.append(k, item);
      const bodyless = res.statusCode === 204 || res.statusCode === 304;
      resolve(new Response(bodyless ? null : Readable.toWeb(res), { status: res.statusCode, headers: out }));
    });
    current = req;
    req.on('error', reject);
    req.end(init.body === undefined ? undefined : init.body);
  });
}
module.exports = { unixFetch };
