// PROTOTYPE: one malformed (or valid) HTTP response against the supervisor's
// API client. Runs ONE case per process so the matrix can time it from outside:
// a parser that spins synchronously cannot be stopped by an in-process timer.
//
//   node framing.cjs <case>   prints one JSON line {"case","outcome"}
//   outcome: "rejected" | "ok:<body>" | "timeout"
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
// FETCH_IMPL lets the matrix's self-check run the same cases against an older parser.
const { mac } = require('./unix-fetch.cjs'); // the server side always uses the current handshake
const { request } = require(process.env.FETCH_IMPL || './unix-fetch.cjs');

const CRLF = '\r\n';
const head = (...h) => 'HTTP/1.1 200 OK' + CRLF + h.join(CRLF) + (h.length ? CRLF : '') + CRLF;
// Valid controls: the harness must be able to read a good response.
// Malformed: every one must be refused, whatever the peer does next.
const CASES = {
  'ok-content-length': { want: 'ok', raw: head('Content-Length: 2') + 'OK' },
  'ok-chunked': { want: 'ok', raw: head('Transfer-Encoding: chunked') + '2' + CRLF + 'OK' + CRLF + '0' + CRLF + CRLF },
  'ok-close-delimited': { want: 'ok', raw: head() + 'hi', end: true },
  'cl-nope': { raw: head('Content-Length: nope') + 'X' },
  'cl-negative': { raw: head('Content-Length: -1') + 'X' },
  'cl-exponent': { raw: head('Content-Length: 1e3') + 'X' },
  'cl-hex-prefix': { raw: head('Content-Length: 0x10') + 'X' },
  'cl-space-inside': { raw: head('Content-Length: 1 2') + 'X' },
  'cl-huge': { raw: head('Content-Length: 99999999999999999999') + 'X' },
  'cl-over-bound': { raw: head('Content-Length: 4294967296') + 'X' },
  'cl-conflicting': { raw: head('Content-Length: 2', 'Content-Length: 3') + 'OK' },
  'cl-and-chunked': { raw: head('Content-Length: 2', 'Transfer-Encoding: chunked') + '2' + CRLF + 'OK' + CRLF + '0' + CRLF + CRLF },
  'te-unsupported': { raw: head('Transfer-Encoding: gzip, chunked') + 'X' },
  'chunk-nonhex': { raw: head('Transfer-Encoding: chunked') + 'zz' + CRLF + 'OK' + CRLF },
  'chunk-empty-size': { raw: head('Transfer-Encoding: chunked') + CRLF + 'OK' + CRLF },
  'chunk-trailing-junk': { raw: head('Transfer-Encoding: chunked') + '2zz' + CRLF + 'OK' + CRLF + '0' + CRLF + CRLF },
  'chunk-negative': { raw: head('Transfer-Encoding: chunked') + '-2' + CRLF + 'OK' + CRLF },
  'chunk-huge': { raw: head('Transfer-Encoding: chunked') + 'FFFFFFFFFFFF' + CRLF + 'OK' + CRLF },
  'chunk-over-bound': { raw: head('Transfer-Encoding: chunked') + '40000000' + CRLF + 'OK' + CRLF },
  'chunk-missing-crlf': { raw: head('Transfer-Encoding: chunked') + '2' + CRLF + 'OKxx0' + CRLF + CRLF },
  'chunk-line-unterminated': { raw: head('Transfer-Encoding: chunked') + 'A'.repeat(4096) },
  'header-no-colon': { raw: head('Content-Length 2') + 'OK' },
  'header-empty-name': { raw: head(': 2') + 'OK' },
  'status-garbage': { raw: 'HTTP/9.9 abc' + CRLF + CRLF },
};

async function main() {
  const name = process.argv[2];
  if (name === '--list') { console.log(JSON.stringify(Object.keys(CASES))); return; }
  const c = CASES[name];
  if (!c) { console.error('unknown case'); process.exit(2); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-fr-'));
  const sock = path.join(dir, 's.sock');
  const token = crypto.randomBytes(32);
  const server = net.createServer((s) => {
    let got = Buffer.alloc(0); let stage = 'hello';
    s.on('error', () => {});
    s.on('data', (d) => {
      got = Buffer.concat([got, d]);
      if (stage === 'hello' && got.length >= 16) {
        const cn = got.subarray(0, 16); const sn = crypto.randomBytes(16);
        got = got.subarray(16); stage = 'proof';
        s.write(Buffer.concat([sn, mac(token, 'srv', 'api', cn, sn)]));
        s.__cn = cn; s.__sn = sn;
      }
      if (stage === 'proof' && got.length >= 32) {
        got = got.subarray(32); stage = 'request';
      }
      if (stage === 'request' && got.includes('\r\n\r\n')) {
        stage = 'responded';
        s.write(Buffer.from(c.raw, 'latin1'));
        if (c.end) s.end();
      }
    });
  });
  await new Promise((r) => server.listen(sock, r));
  let outcome;
  const timer = setTimeout(() => { console.log(JSON.stringify({ case: name, outcome: 'timeout' })); process.exit(0); }, 4000);
  try {
    const res = await request(sock, token.toString('hex'), 'api', { path: '/' });
    const chunks = [];
    for await (const ch of res.body) chunks.push(ch);
    outcome = 'ok:' + Buffer.concat(chunks).toString('latin1');
  } catch {
    outcome = 'rejected';
  }
  clearTimeout(timer);
  console.log(JSON.stringify({ case: name, outcome }));
  try { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
main();
