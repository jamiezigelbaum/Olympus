// PROTOTYPE stand-in for the daemon: listens on the session's API port, answers
// health and probe requests, runs the self-test probe in itself, in an exec'd
// child of itself (same runtime) and in an exec'd Go child, and carries the
// adversarial endpoints the matrix drives (a compromised daemon's moves).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
const probe = require('./probe.cjs');

const t = JSON.parse(process.argv[2]);
const startupDecoys = probe.decoyFds(t);

// Processes that try to outlive the session: setsid, setpgid, double fork,
// and a runtime child detached into its own session.
function spawnEscapers(marker) {
  const out = [];
  for (const mode of ['setsid', 'setpgid', 'double']) {
    try { out.push(JSON.parse(execFileSync(t.launcher, ['escape', mode, marker], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }))); } catch (e) { out.push({ mode, error: String(e) }); }
  }
  const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', marker], { detached: true, stdio: 'ignore' });
  c.unref();
  out.push({ mode: 'node-detached', pid: c.pid });
  return out;
}
const marker = t.markA + t.markB; // never contiguous in this process's own command line
if (t.escapeOnStart) spawnEscapers(marker);

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
  if (req.url.startsWith('/spawn-escapers')) return send(200, { escapers: spawnEscapers(marker) });
  if (req.url === '/hold-listener') {
    const c = spawn(t.launcher, ['holdlisten'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let b = ''; c.stdout.on('data', (d) => { b += d; if (b.includes('\n')) { c.stdout.destroy(); c.unref(); send(200, JSON.parse(b.split('\n')[0])); } });
    return;
  }
  // A compromised daemon replaces the API socket path with a symlink to a host
  // socket it cannot itself open (it cannot create or connect Unix sockets).
  if (req.url === '/swap-api') {
    try { fs.unlinkSync(t.apiSock); fs.symlinkSync(t.hostUnix, t.apiSock); return send(200, { swapped: true }); } catch (e) { return send(200, { swapped: false, error: e.code }); }
  }
  if (req.url === '/forge') {
    const line = 'zkapi-confine: ' + JSON.stringify({ event: 'ready', launcherPid: 1, daemonPid: 1, forged: true });
    console.log(line); console.error(line);
    let fd3 = 'ok'; try { fs.writeSync(3, line + '\n'); } catch (e) { fd3 = e.code; }
    return send(200, { fd3 });
  }
  if (req.url === '/exit') { send(200, { bye: true }); return setTimeout(() => process.exit(0), 50); }
  send(404, {});
});
server.listen(t.api, '127.0.0.1', () => {});
