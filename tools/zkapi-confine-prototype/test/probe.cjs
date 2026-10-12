// PROTOTYPE self-test probe. Runs unchanged outside the confinement (control),
// inside it as the stand-in daemon, and as an exec'd child. Content-free: it
// sends only fixed probe bytes to listeners the test itself owns.
'use strict';
const net = require('node:net');
const dgram = require('node:dgram');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const FAST_MS = 1000;

function tcp(opts, { echo } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = net.createConnection(opts);
    let done = false;
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(3000, () => finish('timeout'));
    s.once('connect', () => {
      if (!echo) return finish('connected');
      s.write(echo);
    });
    s.once('data', (d) => finish(String(d)));
    s.once('close', () => finish(echo ? (Date.now() - started < FAST_MS ? 'closed_fast' : 'closed_slow') : 'closed'));
    s.once('error', () => finish(Date.now() - started < FAST_MS ? 'failed_fast' : 'failed_slow'));
  });
}
const udp = (host, port) => new Promise((resolve) => {
  let s;
  try { s = dgram.createSocket('udp4'); } catch { return resolve('failed'); }
  const done = (r) => { try { s.close(); } catch {} resolve(r); };
  s.once('error', () => done('failed'));
  s.send(Buffer.from([0]), port, host, (e) => done(e ? 'failed' : 'sent'));
});
const udpBind = () => new Promise((resolve) => {
  let s;
  try { s = dgram.createSocket('udp4'); } catch { return resolve('failed'); }
  s.once('error', () => { try { s.close(); } catch {} resolve('failed'); });
  s.bind(0, '127.0.0.1', () => { try { s.close(); } catch {} resolve('bound'); });
});
const listenTry = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const s = net.createServer((c) => c.end('NS'));
  s.once('error', (e) => resolve({ result: 'denied:' + (e.code || 'err') }));
  s.listen({ port, host, exclusive: true }, () => resolve({ result: 'bound', server: s }));
});
async function bindAndConnect(port) {
  const l = await listenTry(port);
  if (!l.server) return l.result;
  const seen = await tcp({ host: '127.0.0.1', port }, { echo: 'x' });
  l.server.close();
  return seen === 'NS' ? 'bound_connected_ns' : 'bound_other:' + seen;
}
async function dnsLookup() {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 4000);
    dns.lookup('example.com', (err) => {
      clearTimeout(timer);
      if (!err) return resolve('resolved');
      resolve(Date.now() - started < 2000 ? 'failed_fast' : 'failed_slow');
    });
  });
}
const status = (key) => {
  const m = new RegExp('^' + key + ':\\s*(.*)$', 'm').exec(fs.readFileSync('/proc/self/status', 'utf8'));
  return m ? m[1].trim() : '';
};
// Descriptors this process holds that are the supervisor's decoy sockets.
const decoyFds = (t) => {
  let n = 0;
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    try { if ((t.decoyInodes || []).includes(fs.readlinkSync('/proc/self/fd/' + fd))) n += 1; } catch {}
  }
  return n;
};

async function run(t, role) {
  const r = {};
  r.inherited_decoy_fds = String(role.startupDecoys);
  r.caps = ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((k) => /^0+$/.test(status(k))).every(Boolean) ? 'zero' : 'nonzero';
  r.no_new_privs = status('NoNewPrivs');
  r.seccomp_mode = status('Seccomp');
  r.net_ns_differs = fs.readlinkSync('/proc/self/ns/net') !== t.hostNetNs ? 'yes' : 'no';
  r.user_ns_differs = fs.readlinkSync('/proc/self/ns/user') !== t.hostUserNs ? 'yes' : 'no';
  r.interfaces = Object.keys(os.networkInterfaces()).join(',');
  // allowed: the Tor port is bridged to a host stand-in that answers
  r.tor_bridge_echo = await tcp({ host: '127.0.0.1', port: t.tor }, { echo: 'probe' });
  r.companion_bind_connect = await bindAndConnect(t.companion);
  r.wallet_bind_connect = await bindAndConnect(t.wallet);
  // denied
  r.connect_other_port = await tcp({ host: '127.0.0.1', port: t.other });
  r.connect_loopback_alias = await tcp({ host: '127.0.0.2', port: t.alias });
  r.connect_lan = t.lan ? await tcp({ host: t.lan.address, port: t.lan.port }) : 'no_interface';
  r.connect_remote_testnet = await tcp({ host: '192.0.2.1', port: 9 });
  r.ipv6_loopback = await tcp({ host: '::1', port: t.tor });
  r.ipv4_mapped = await tcp({ host: '::ffff:127.0.0.1', port: t.other });
  r.udp_remote = await udp('192.0.2.1', 53);
  r.udp_loopback = await udp('127.0.0.1', t.tor);
  r.udp_bind = await udpBind();
  r.dns_stub_tcp = await tcp({ host: '127.0.0.53', port: 53 });
  r.dns_lookup = await dnsLookup();
  r.unix_host_path = await tcp({ path: t.hostUnix });
  r.unix_host_abstract = await tcp({ path: '\0' + t.hostAbstract });
  const bindRow = async (port, host) => { const l = await listenTry(port, host); if (l.server) l.server.close(); return l.result; };
  r.bind_other_port = await bindRow(t.bindOther);
  r.bind_tor_port = await bindRow(t.tor);
  r.bind_ephemeral = await bindRow(0);
  // A wildcard bind on a port the daemon may bind is allowed (Landlock has no
  // address rule); inside a namespace whose only interface is loopback it is
  // the same listener as the loopback bind. A wildcard bind on any other port
  // is refused by the port rule.
  r.bind_wildcard_forbidden_port = await bindRow(t.bindOther, '0.0.0.0');
  r.bind_wildcard_permitted_port = await bindRow(t.wallet, '0.0.0.0');
  return r;
}

function childProbe(t) {
  const argv = [__filename, JSON.stringify(t), 'child'];
  return JSON.parse(execFileSync(process.execPath, argv, { timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
}
// Inside a PID namespace getppid() is 1, but /proc is the host's procfs, which
// reports pids as the host sees them: /proc/self/status gives the host pid of
// the launcher (stage1), and its stat gives stage0.
function hostPpid(pid) {
  try { const m = /^PPid:\s*(\d+)/m.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8')); return m ? Number(m[1]) : 1; } catch { return 1; }
}
function goProbe(t) {
  if (!t.launcher) return undefined;
  try {
    const stage1 = hostPpid('self'); const stage0 = hostPpid(stage1);
    return JSON.parse(execFileSync(t.launcher, ['probe', String(stage1), String(stage0), t.hostUnix, t.hostDgram], { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return { error: 'probe_failed' }; }
}

module.exports = { run, childProbe, goProbe, decoyFds, tcp, hostPpid };

if (require.main === module) {
  const t = JSON.parse(process.argv[2]);
  const startupDecoys = decoyFds(t);
  run(t, { startupDecoys }).then((r) => { process.stdout.write(JSON.stringify(r)); process.exit(0); }).catch(() => process.exit(1));
}
