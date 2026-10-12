// PROTOTYPE stand-in for the daemon: listens on the session's API port, answers
// health and probe requests, and runs the self-test probe in itself, in an
// exec'd child of itself (same runtime) and in an exec'd Go child.
'use strict';
const http = require('node:http');
const net = require('node:net');
const probe = require('./probe.cjs');

const t = JSON.parse(process.argv[2]);
const startupDecoys = probe.decoyFds(t);

const server = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/healthz') return send(200, { standin: 'ns', pid: process.pid, ppid: process.ppid });
  if (req.url === '/probe') {
    try {
      const parent = await probe.run(t, { startupDecoys });
      const child = probe.childProbe(t);
      return send(200, { parent, child, go: probe.goProbe(t) });
    } catch (e) { return send(500, { error: String(e) }); }
  }
  if (req.url === '/hang') return;
  if (req.url === '/echo') { res.writeHead(200); return req.pipe(res); }
  if (req.url === '/tor-connect') return send(200, { result: await probe.tcp({ host: '127.0.0.1', port: t.tor }, { echo: 'probe' }) });
  send(404, {});
});
server.listen(t.api, '127.0.0.1', () => {});
