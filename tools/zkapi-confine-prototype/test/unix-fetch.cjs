// PROTOTYPE: the supervisor's side of the API bridge. Runtime-neutral (Bun and
// Node): it uses only node:net and node:crypto.
//
// Every connection to the bridge's Unix socket is authenticated before a byte
// of HTTP is sent: a mutual challenge-response keyed by a token that reached
// the supervisor only on the launcher's private status descriptor. A socket
// path that was renamed, replaced or redirected by the (same-uid) daemon leads
// to a peer that cannot answer, and the request is refused instead of sent.
//
// Because Bun's node:http ignores a caller-supplied connection, the HTTP/1.1
// request and response are written and parsed here, over the authenticated
// socket: one request per connection, Connection: close, a fixed body length,
// chunked or length-delimited or close-delimited responses, a streaming body.
'use strict';
const net = require('node:net');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const mac = (token, role, name, ...parts) => {
  const h = crypto.createHmac('sha256', token);
  h.update('zkapi-confine/' + role + '/' + name + '\0');
  for (const p of parts) h.update(p);
  return h.digest();
};

// Resolves with the socket only after the peer proved it holds the token. Any
// bytes the peer sent beyond the proof are returned as `rest`.
function connectAuthed(sockPath, tokenHex, name, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(tokenHex, 'hex');
    const cn = crypto.randomBytes(16);
    const s = net.connect({ path: sockPath });
    let got = Buffer.alloc(0); let settled = false;
    const timer = setTimeout(() => fail('timeout'), timeoutMs);
    function fail(why) { if (settled) return; settled = true; clearTimeout(timer); s.destroy(); reject(Object.assign(new Error('api_peer_unauthenticated: ' + why), { code: 'EAUTH' })); }
    s.once('error', (e) => fail(e.code || e.message));
    s.once('close', () => fail('closed'));
    s.once('connect', () => s.write(cn));
    const onData = (d) => {
      got = Buffer.concat([got, d]);
      if (got.length < 48) return;
      s.off('data', onData);
      s.pause();
      const sn = got.subarray(0, 16); const proof = got.subarray(16, 48);
      if (!crypto.timingSafeEqual(proof, mac(token, 'srv', name, cn, sn))) return fail('bad server proof');
      s.write(mac(token, 'cli', name, cn, sn));
      settled = true; clearTimeout(timer);
      s.removeAllListeners('error'); s.removeAllListeners('close');
      resolve(s);
    };
    s.on('data', onData);
  });
}

// Framing numbers come from a peer that may be hostile (the daemon). Both are
// strict: digits only, no sign, no exponent, no hex prefix, bounded. Anything
// else is an error before a body byte is read, so a malformed length can never
// become NaN and stall the parser.
const MAX_BODY = 2 ** 30; // bytes announced by Content-Length
const MAX_CHUNK = 2 ** 28; // bytes in one chunk
const MAX_LINE = 256; // chunk-size line
function parseLength(text) {
  if (typeof text !== 'string' || !/^[0-9]{1,10}$/.test(text)) return undefined;
  const n = Number(text);
  return n <= MAX_BODY ? n : undefined;
}
function parseChunkSize(text) {
  if (typeof text !== 'string' || !/^[0-9a-fA-F]{1,8}$/.test(text)) return undefined;
  const n = parseInt(text, 16);
  return n <= MAX_CHUNK ? n : undefined;
}

const FORBIDDEN = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'keep-alive']);

// One request over a fresh authenticated connection.
// Resolves { status, headers: [[k, v]...], body: Readable, destroy() }.
async function request(sockPath, tokenHex, name, { method = 'GET', path = '/', headers = {}, body, signal } = {}) {
  if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  const s = await connectAuthed(sockPath, tokenHex, name);
  const payload = body === undefined || body === null ? null : (typeof body === 'string' ? Buffer.from(body) : Buffer.from(body));
  let head = `${method} ${path} HTTP/1.1\r\nHost: daemon\r\nConnection: close\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    if (FORBIDDEN.has(k.toLowerCase()) || /[\r\n]/.test(k + v)) continue;
    head += `${k}: ${v}\r\n`;
  }
  if (payload) head += `Content-Length: ${payload.length}\r\n`;
  head += '\r\n';
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0); let state = 'head'; let remaining = 0; let chunked = false; let chunkState = 'size'; let toClose = false;
    let out; let resolved = false;
    const onAbort = () => { const e = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); s.destroy(); if (out) out.destroy(e); if (!resolved) reject(e); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const finish = () => { if (out && !out.readableEnded) out.push(null); s.destroy(); };
    const feedBody = (data) => {
      while (data.length && state === 'body') {
        if (chunked) {
          if (chunkState === 'size') {
            const i = data.indexOf('\r\n');
            if (i < 0) { if (data.length > MAX_LINE) return fail(new Error('chunk size line too long')); buf = data; return; }
            if (i > MAX_LINE) return fail(new Error('chunk size line too long'));
            remaining = parseChunkSize(data.subarray(0, i).toString('latin1').split(';')[0]);
            data = data.subarray(i + 2);
            if (remaining === undefined) return fail(new Error('bad chunk size'));
            if (remaining === 0) { state = 'done'; return finish(); }
            chunkState = 'data';
          } else if (chunkState === 'data') {
            const take = Math.min(remaining, data.length);
            out.push(data.subarray(0, take)); remaining -= take; data = data.subarray(take);
            if (remaining === 0) chunkState = 'crlf';
          } else {
            if (data.length < 2) { buf = data; return; }
            if (data[0] !== 13 || data[1] !== 10) return fail(new Error('chunk not terminated by CRLF'));
            data = data.subarray(2); chunkState = 'size';
          }
          buf = Buffer.alloc(0);
        } else if (toClose) {
          out.push(data); return;
        } else {
          const take = Math.min(remaining, data.length);
          out.push(data.subarray(0, take)); remaining -= take; data = data.subarray(take);
          if (remaining === 0) { state = 'done'; return finish(); }
        }
      }
      if (state === 'body' && !chunked) buf = Buffer.alloc(0);
    };
    const fail = (e) => { state = 'failed'; s.destroy(); if (out) out.destroy(e); if (!resolved) reject(e); };
    s.on('error', fail);
    s.on('close', () => {
      if (state === 'failed' || state === 'done') return;
      if (state === 'head') return fail(new Error('connection closed before a response'));
      if (state === 'body' && toClose) { state = 'done'; return finish(); }
      if (state === 'body') return fail(new Error('connection closed mid-body'));
    });
    s.on('data', (d) => {
      if (state === 'failed' || state === 'done') return;
      if (state === 'head') {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) { if (buf.length > 65536) fail(new Error('response head too large')); return; }
        const lines = buf.subarray(0, i).toString('latin1').split('\r\n');
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0]);
        if (!m) return fail(new Error('bad status line'));
        const status = Number(m[1]);
        const hs = [];
        for (const l of lines.slice(1)) {
          const j = l.indexOf(':');
          if (j <= 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(l.slice(0, j))) return fail(new Error('bad header line'));
          hs.push([l.slice(0, j).toLowerCase(), l.slice(j + 1).trim()]);
        }
        const all = (k) => hs.filter((h) => h[0] === k).map((h) => h[1]);
        const tes = all('transfer-encoding'); const cls = all('content-length');
        if (tes.length > 1 || (tes.length === 1 && tes[0].toLowerCase() !== 'chunked')) return fail(new Error('unsupported transfer-encoding'));
        chunked = tes.length === 1;
        if (cls.length > 1 && new Set(cls).size > 1) return fail(new Error('conflicting content-length'));
        if (chunked && cls.length > 0) return fail(new Error('content-length with chunked'));
        const cl = cls[0];
        let clNum;
        if (cl !== undefined) { clNum = parseLength(cl); if (clNum === undefined) return fail(new Error('bad content-length')); }
        out = new Readable({ read() {} });
        // A framing error can arrive before the consumer has attached; the error
        // must surface through the stream, never as an unhandled 'error' event.
        out.on('error', () => {});
        const rest = buf.subarray(i + 4); buf = Buffer.alloc(0);
        resolved = true;
        resolve({ status, headers: hs, body: out, destroy: () => { s.destroy(); out.destroy(); } });
        if (status === 204 || status === 304 || status < 200 || method === 'HEAD') { state = 'done'; return finish(); }
        if (chunked) state = 'body';
        else if (clNum !== undefined) { remaining = clNum; state = 'body'; if (remaining === 0) { state = 'done'; return finish(); } } else { toClose = true; state = 'body'; }
        feedBody(rest);
      } else if (state === 'body') {
        feedBody(buf.length ? Buffer.concat([buf, d]) : d);
      }
    });
    s.resume();
    s.write(head);
    if (payload) s.write(payload);
  });
}

function unixFetch(sockPath, tokenHex, name = 'api') {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (init.redirect !== undefined && init.redirect !== 'error' && init.redirect !== 'manual') throw new TypeError('unsupported redirect mode');
    const headers = {};
    for (const [k, v] of new Headers(init.headers || {})) headers[k] = v;
    if (init.signal && init.signal.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    let res;
    try {
      res = await request(sockPath, tokenHex, name, { method: init.method || 'GET', path: url.pathname + url.search, headers, body: init.body, signal: init.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new DOMException('This operation was aborted', 'AbortError');
      throw e;
    }
    if (res.status >= 300 && res.status < 400 && init.redirect === 'error') { res.destroy(); throw new TypeError('redirect refused'); }
    const out = new Headers();
    for (const [k, v] of res.headers) out.append(k, v);
    const bodyless = res.status === 204 || res.status === 304;
    return new Response(bodyless ? null : Readable.toWeb(res.body), { status: res.status, headers: out });
  };
}

// Convenience for the harness: JSON GET/POST through the authenticated bridge.
async function jsonRequest(sockPath, tokenHex, name, urlPath, { method = 'GET', body, timeout = 20000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await request(sockPath, tokenHex, name, { method, path: urlPath, body, signal: ac.signal });
    const chunks = [];
    for await (const c of res.body) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); }
}

module.exports = { unixFetch, connectAuthed, request, jsonRequest, mac, parseLength, parseChunkSize };
