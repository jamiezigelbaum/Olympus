// PROTOTYPE test driver for the Linux confinement self-test matrix.
//
//   bun matrix.mjs --launcher <path> --gostandin <path> [--mode quick|full] [--abi N] [--out file]
//
// It plays the supervisor: owns the session directory, the host stand-in for
// Tor, the host decoy listeners and the launcher process. FAIL-CLOSED: every
// control, probe row, identity check, lifecycle result, refusal and ablation
// contributes to the exit status. A missing probe row is a failure. The exit
// status is zero only when the failure list is empty.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { unixFetch, request: bridgeRequest, jsonRequest } = createRequire(import.meta.url)('./unix-fetch.cjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; };
const launcher = arg('launcher');
const gostandin = arg('gostandin');
const mode = arg('mode', 'full'); // full | quick
const abiCap = arg('abi', ''); // emulate an older Landlock ABI (prototype launcher only)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runtimeName = typeof Bun !== 'undefined' ? 'bun ' + Bun.version : 'node ' + process.version;

const failures = [];
const lines = [];
const log = (s = '') => { lines.push(s); console.log(s); };
let quietFailures = false; // only while an ablation deliberately breaks a layer and collects the rows that notice
const fail = (m) => { failures.push(m); if (!quietFailures) log('  FAIL ' + m); };
const matches = (want, got) => got !== undefined && (want instanceof RegExp ? want.test(String(got)) : String(got) === String(want));
const expect = (label, got, want) => { if (!matches(want, got)) fail(`${label}: want ${want} got ${got === undefined ? '(missing)' : got}`); };
const ok = (label, cond, detail = '') => { if (!cond) fail(`${label}${detail ? ': ' + detail : ''}`); };
async function section(name, fn) {
  log(`\n== ${name}`);
  try { return await fn(); } catch (e) { fail(`${name}: section threw ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
}

if (!launcher) { console.error('--launcher is required'); process.exit(2); }
if (!gostandin) { console.error('--gostandin is required (Go stand-in and datagram decoy)'); process.exit(2); }

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  const cb = () => resolve(server.address());
  if (typeof port === 'string') server.listen({ path: port }, cb); else server.listen({ port, host, exclusive: true }, cb);
});
const freePort = async () => { const s = net.createServer(); const a = await listen(s, 0, '127.0.0.1'); await new Promise((r) => s.close(r)); return a.port; };

// ------------------------------------------------------------------ host side
const netnsCount = () => {
  const set = new Set();
  for (const n of fs.readdirSync('/proc')) { if (!/^\d+$/.test(n)) continue; try { set.add(fs.readlinkSync(`/proc/${n}/ns/net`)); } catch {} }
  return set.size;
};

async function hostFixture(workDir, { torAtNsPort = false } = {}) {
  const servers = [];
  const track = (s) => { servers.push(s); return s; };
  const t = {};
  t.tor = await freePort(); // the Tor port INSIDE the namespace
  t.torHost = await freePort(); // the real Tor port on the host
  t.companion = await freePort();
  t.wallet = await freePort();
  t.api = await freePort();
  t.bindOther = await freePort();
  const marker = 'zkc-mark-' + crypto.randomBytes(6).toString('hex');
  t.markA = marker.slice(0, 10); t.markB = marker.slice(10); // not contiguous in any command line
  t.apiSock = path.join(workDir, 'api.sock');
  const fx = { servers, marker, decoy: { streamConns: 0, streamBytes: Buffer.alloc(0) } };
  const torAnswer = (c) => { c.on('data', (d) => c.write('TOR-HOST:' + d)); c.on('error', () => {}); };
  // Host stand-in for Tor, at the real host port. (The unconfined control has
  // no bridge, so there the stand-in sits at the number the daemon dials.)
  fx.torHost = track(net.createServer(torAnswer));
  await listen(fx.torHost, torAtNsPort ? t.tor : t.torHost, '127.0.0.1');
  // Squatters: host listeners on the session's own port numbers. Inside the
  // namespace these must never be reached.
  const hostServer = () => net.createServer((c) => { c.on('error', () => {}); c.end('HOST'); });
  for (const p of torAtNsPort ? [t.companion, t.wallet] : [t.companion, t.wallet, t.tor]) await listen(track(hostServer()), p, '127.0.0.1');
  try { await listen(track(hostServer()), t.tor, '::1'); } catch {}
  t.other = (await listen(track(hostServer()), 0, '127.0.0.1')).port;
  t.alias = (await listen(track(hostServer()), 0, '127.0.0.2')).port;
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (lan) t.lan = { address: lan.address, port: (await listen(track(hostServer()), 0, lan.address)).port };
  // Host Unix stream decoy: counts connections and keeps every byte received.
  t.hostUnix = path.join(workDir, 'decoy.sock');
  await listen(track(net.createServer((c) => {
    fx.decoy.streamConns += 1;
    c.on('data', (d) => { fx.decoy.streamBytes = Buffer.concat([fx.decoy.streamBytes, d]); });
    c.on('error', () => {}); c.end('HOST');
  })), t.hostUnix);
  // Host Unix datagram decoy (a /dev/log stand-in): a Go helper logging to a file.
  t.hostDgram = path.join(workDir, 'decoy-dgram.sock');
  fx.dgram = spawn(gostandin, ['dgram-decoy', t.hostDgram], { stdio: ['ignore', 'pipe', 'ignore'] });
  ownHelpers.add(fx.dgram.pid);
  await new Promise((resolve, reject) => { fx.dgram.stdout.once('data', resolve); fx.dgram.once('error', reject); setTimeout(() => reject(new Error('dgram decoy did not start')), 5000); });
  fx.dgramLog = () => { try { return fs.readFileSync(t.hostDgram + '.log', 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  t.hostAbstract = 'zkc-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
  try { await listen(track(hostServer()), '\0' + t.hostAbstract); } catch { t.abstractUnsupported = true; }
  t.hostNetNs = fs.readlinkSync('/proc/self/ns/net');
  t.hostUserNs = fs.readlinkSync('/proc/self/ns/user');
  t.launcher = launcher;
  fx.t = t;
  fx.close = () => { for (const s of servers) { try { s.close(); } catch {} } try { fx.dgram.kill('SIGKILL'); } catch {} };
  return fx;
}

// Authenticated request to the bridge, as the supervisor makes it.
const apiGet = (sock, token, urlPath, { timeout = 20000, method = 'GET', body } = {}) => jsonRequest(sock, token, 'api', urlPath, { method, body, timeout });

// ----------------------------------------------------------------- /proc views
function statOf(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = st.slice(st.lastIndexOf(')') + 1).trim().split(/\s+/);
    return { state: f[0], ppid: Number(f[1]), pgrp: Number(f[2]), sid: Number(f[3]), start: f[19], comm: st.slice(st.indexOf('(') + 1, st.lastIndexOf(')')) };
  } catch { return undefined; }
}
function statusOf(pid) { try { return fs.readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { return undefined; } }
function processGroup(pgid) {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    const s = statOf(n);
    if (s && s.pgrp === pgid && s.state !== 'Z') out.push({ pid: Number(n), comm: s.comm });
  }
  return out;
}
const ownHelpers = new Set(); // the test's own decoy helpers; they are not the daemon's descendants
// Live (non-zombie) processes whose command line contains any of the needles.
function procsMatching(needles) {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid || ownHelpers.has(Number(n))) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (!needles.some((x) => cmd.includes(x))) continue;
      const s = statOf(n);
      if (s && s.state !== 'Z') out.push({ pid: Number(n), comm: s.comm, pgrp: s.pgrp, sid: s.sid });
    } catch {}
  }
  return out;
}
async function waitGone(needles, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (procsMatching(needles).length === 0) return true; await sleep(50); }
  return false;
}
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } return undefined; }
const killAll = (needles) => { for (const p of procsMatching(needles)) { try { process.kill(p.pid, 'SIGKILL'); } catch {} } };

// The supervisor's binding of a ready event to process instances: pid AND start
// time, parentage, and PID-namespace identity. Returns a list of problems.
// The chain is watchdog -> stage0 -> stage1 -> daemon, every link bound by pid
// and start time (the watchdog's from the supervisor's own record of what it
// spawned), by parentage, and by PID-namespace depth: stage0 is in the host
// namespace, stage1 is init of a nested one, the daemon is inside it.
function verifyInstance(ev, { watchdogPid, watchdogStart } = {}) {
  const errs = [];
  const need = (c, m) => { if (!c) errs.push(m); };
  const nsLevels = (pid) => { const m = /NSpid:\s*(.*)/.exec(statusOf(pid) || ''); return m ? m[1].trim().split(/\s+/) : []; };
  const wd = statOf(watchdogPid); const s0 = statOf(ev.stage0Pid); const s1 = statOf(ev.stage1Pid); const daemon = statOf(ev.daemonPid);
  need(wd && wd.start === watchdogStart, 'watchdog start time does not match the instance we spawned');
  need(s0 && s0.start === ev.stage0Start, 'stage0 start time does not match its pid');
  need(s1 && s1.start === ev.stage1Start, 'stage1 start time does not match its pid');
  need(daemon && daemon.start === ev.daemonStart, 'daemon start time does not match its pid');
  if (wd && s0 && s1 && daemon) {
    need(s0.ppid === watchdogPid, 'stage0 is not a child of the watchdog we started');
    need(s1.ppid === ev.stage0Pid, 'stage1 is not a child of stage0');
    need(daemon.ppid === ev.stage1Pid, 'daemon is not a child of stage1');
    need(ev.stage0Pid !== ev.stage1Pid && ev.stage1Pid !== ev.daemonPid && ev.stage0Pid !== watchdogPid, 'chain links are not distinct processes');
    need(nsLevels(ev.stage0Pid).length === 1, 'stage0 is not in the host PID namespace');
    const l1 = nsLevels(ev.stage1Pid);
    need(l1.length === 2 && l1[1] === '1', 'stage1 is not PID 1 of a nested PID namespace');
    need(nsLevels(ev.daemonPid).length >= 2, 'daemon is not in a nested PID namespace');
    let dns; try { dns = fs.readlinkSync(`/proc/${ev.daemonPid}/ns/pid`); } catch { dns = undefined; }
    need(dns !== undefined && dns !== fs.readlinkSync('/proc/self/ns/pid'), 'daemon shares our PID namespace');
    let dnet; try { dnet = fs.readlinkSync(`/proc/${ev.daemonPid}/ns/net`); } catch { dnet = undefined; }
    need(dnet !== undefined && dnet !== fs.readlinkSync('/proc/self/ns/net'), 'daemon shares our network namespace');
  }
  return errs;
}

function listenersOf(pid) {
  let nsTcp = '';
  try { nsTcp = fs.readFileSync(`/proc/${pid}/net/tcp`, 'utf8'); } catch (e) { return { error: e.code }; }
  return { ports: nsTcp.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f[3] === '0A').map((f) => parseInt(f[1].split(':')[1], 16)).sort((a, b) => a - b) };
}

// --------------------------------------------------------------------- launch
function launchArgs(t, workDir, program, programArgs, { status = true } = {}) {
  return ['run', '--dir', workDir, '--expose', `api=${t.api}`, '--reach', `${t.tor}=${t.torHost}`,
    ...[t.tor, t.companion, t.wallet, t.api].flatMap((p) => ['--connect-port', String(p)]),
    ...[t.companion, t.wallet, t.api].flatMap((p) => ['--bind-port', String(p)]),
    ...(status ? ['--status-fd', '3'] : []), '--', program, ...programArgs];
}
function launch({ t, workDir, extraEnv = {}, inherit = [], program, programArgs, status = true }) {
  const args = launchArgs(t, workDir, program, programArgs, { status });
  // The launcher is started the way the supervisor's watchdog starts it: by a
  // watchdog stand-in that leads a new process group and passes the private
  // status pipe (its fd 3) and the decoy descriptors through.
  const spec = { argv: [launcher, ...args], extraFds: inherit.map((_, i) => 4 + i) };
  const child = spawn(process.execPath, [path.join(here, 'shim.cjs'), JSON.stringify(spec)], { detached: true, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe', 'pipe', ...inherit] });
  const watchdogStart = (statOf(child.pid) || {}).start;
  const events = []; const out = []; const err = [];
  let buf = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { out.push(d); });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err.push(d); });
  // Launcher events arrive on the private status pipe (fd 3), never on the
  // stdout/stderr the daemon shares.
  child.stdio[3].setEncoding('utf8');
  child.stdio[3].on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.startsWith('zkapi-confine: ')) { try { events.push(JSON.parse(line.slice(15))); } catch {} }
    }
  });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  return { child, events, out, err, exited, pgid: child.pid, watchdogPid: child.pid, watchdogStart };
}
const eventOf = (run, ms) => waitFor(() => run.events.find((e) => e.event === 'ready' || e.event === 'refused'), ms);

const daemonEnv = (extra = {}) => ({ ...(abiCap ? { ZKAPI_CONFINE_PROTOTYPE_ABI: abiCap } : {}), ...extra });

async function session({ ablation = '', label, extraEnv = {}, withDecoyFds = true, allowSurvivors = false } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-'));
  fs.chmodSync(workDir, 0o700);
  const fx = await hostFixture(workDir);
  let dUnix; let dTcp; let inherit = [];
  if (withDecoyFds) {
    // Inherited-descriptor decoys: a connected host Unix socket and a connected
    // host TCP socket left open for the launcher to inherit.
    dUnix = net.connect({ path: fx.t.hostUnix }); dTcp = net.connect({ host: '127.0.0.1', port: fx.t.other }); dUnix.on('error', () => {}); dTcp.on('error', () => {});
    await Promise.all([new Promise((r) => dUnix.once('connect', r)), new Promise((r) => dTcp.once('connect', r))]);
    inherit = [dUnix, dTcp].map((s) => s._handle.fd);
    fx.t.decoyInodes = inherit.map((fd) => fs.readlinkSync('/proc/self/fd/' + fd));
    fx.decoy.streamConns -= 1; // our own deliberate decoy connection is not an escape
  }
  const run = launch({ t: fx.t, workDir, extraEnv: daemonEnv({ ...(ablation ? { ZKAPI_CONFINE_PROTOTYPE_ABLATE: ablation } : {}), ...extraEnv }), inherit,
    program: process.execPath, programArgs: [path.join(here, 'standin-daemon.cjs'), JSON.stringify(fx.t)] });
  const s = { t: fx.t, workDir, fx, run, label, marker: fx.marker };
  s.needles = [workDir, fx.marker];
  // Cleanup first does what the supervisor does (kill the recorded group) and
  // ASSERTS nothing is left; only then does it sweep up after a failure.
  s.cleanup = async () => {
    try { process.kill(-run.pgid, 'SIGKILL'); } catch {}
    fx.close(); if (dUnix) dUnix.destroy(); if (dTcp) dTcp.destroy(); // the test's own helpers go first
    const gone = await waitGone(s.needles, 3000);
    if (!gone && !allowSurvivors) fail(`${label}: processes survived the group kill: ${JSON.stringify(procsMatching(s.needles))}`);
    killAll(s.needles);
    await sleep(100); fs.rmSync(workDir, { recursive: true, force: true });
    return gone;
  };
  return s;
}

// ---------------------------------------------------------------- expectations
const inside = {
  inherited_decoy_fds: '0', caps: 'zero', no_new_privs: '1', seccomp_mode: '2',
  net_ns_differs: 'yes', user_ns_differs: 'yes', interfaces: 'lo',
  tor_bridge_echo: 'TOR-HOST:probe',
  companion_bind_connect: 'bound_connected_ns', wallet_bind_connect: 'bound_connected_ns',
  connect_other_port: 'failed_fast', connect_loopback_alias: 'failed_fast', connect_lan: 'failed_fast',
  connect_remote_testnet: 'failed_fast', ipv6_loopback: 'failed_fast', ipv4_mapped: 'failed_fast',
  udp_remote: 'failed', udp_loopback: 'failed', udp_bind: 'failed',
  dns_stub_tcp: 'failed_fast', dns_lookup: 'failed_fast',
  unix_host_path: 'failed_fast', unix_host_abstract: 'failed_fast',
  bind_other_port: /^denied:/, bind_tor_port: /^denied:/, bind_ephemeral: /^denied:/, bind_wildcard_forbidden_port: /^denied:/,
  // Documented gap: no address rule exists, so a wildcard bind of a permitted
  // port succeeds; in a loopback-only namespace it is the loopback listener.
  bind_wildcard_permitted_port: 'bound',
};
const outside = {
  net_ns_differs: 'no', user_ns_differs: 'no', no_new_privs: '0', seccomp_mode: '0',
  tor_bridge_echo: 'TOR-HOST:probe',
  companion_bind_connect: 'denied:EADDRINUSE', wallet_bind_connect: 'denied:EADDRINUSE',
  connect_other_port: 'connected', connect_loopback_alias: 'connected', connect_lan: 'connected',
  ipv6_loopback: 'connected', ipv4_mapped: 'connected', udp_remote: 'sent', udp_loopback: 'sent', udp_bind: 'bound',
  unix_host_path: 'connected', unix_host_abstract: 'connected',
  bind_other_port: 'bound', bind_tor_port: 'denied:EADDRINUSE', bind_ephemeral: 'bound',
  bind_wildcard_forbidden_port: 'bound', bind_wildcard_permitted_port: 'denied:EADDRINUSE',
};
const goInside = {
  socket_inet_stream: 'ok', socket_inet6: 'EPERM', socket_inet_dgram: 'EPERM', socket_inet_raw: 'EPERM', socket_unix: 'EPERM',
  socket_unix_dgram: 'EPERM', socket_netlink_route: 'ok', socket_netlink_generic: 'EPERM', socket_packet: 'EPERM', socket_vsock: 'EPERM',
  // finding: socketpair() must not give a daemon a datagram socket it can re-point
  socketpair_unix_stream: 'ok', socketpair_unix_dgram: 'EPERM', socketpair_unix_seqpacket: 'EPERM',
  pair_stream_connect_host_path: /^(EISCONN|EACCES)$/, pair_stream_sendto_host_path: /^(EISCONN|EACCES)$/, pair_stream_connect_after_shutdown: /^(?!ok$)/,
  pair_dgram_connect_host_path: 'no_socket', pair_dgram_sendto_host_path: 'no_socket',
  inet_connect_unix_addr: /^(EAFNOSUPPORT|EINVAL)$/,
  // finding: listen() without bind() gets an ephemeral port Landlock never sees
  listen_unbound: /^listening:\d+$/,
  ptrace_attach_launcher: 'EPERM', ptrace_attach_stage0: 'EPERM', ptrace_attach_ns_init: 'EPERM', process_vm_readv_launcher: 'EPERM', io_uring_setup: 'EPERM',
  unshare_newuser: 'EPERM', unshare_newnet: 'EPERM', unshare_newpid: 'EPERM', clone3: 'ENOSYS', clone_newuser_exec: /^(?!ok$)/, clone_newpid_exec: /^(?!ok$)/, setns_net: 'EPERM',
  mount_tmpfs: 'EPERM', open_launcher_mem_rw: /^(EACCES|EPERM)$/, open_stage0_mem_rw: /^(EACCES|EPERM)$/,
  // the launcher and watchdog are not even addressable from inside the PID namespace
  signal_launcher: /^(ESRCH|EPERM)$/, signal_stage0: /^(ESRCH|EPERM)$/,
  signal_ns_init_sigkill: /^(ok|EPERM)$/, ns_init_alive_after: 'yes',
};
const goOutside = {
  socket_inet6: 'ok', socket_inet_dgram: 'ok', socket_unix: 'ok', socket_netlink_generic: 'ok', clone_newuser_exec: 'ok',
  socketpair_unix_dgram: 'ok', socketpair_unix_seqpacket: 'ok', pair_dgram_connect_host_path: 'ok', pair_dgram_sendto_host_path: 'ok',
  pair_stream_connect_host_path: 'EISCONN', listen_unbound: /^listening:\d+$/, signal_launcher: 'ok',
};

function evaluate(res, wantRows, wantGo, label) {
  const before = failures.length;
  if (!res) { fail(`${label}: no rows`); return 1; }
  for (const [k, w] of Object.entries(wantRows)) expect(`${label}.${k}`, res[k], w);
  if (wantGo) {
    if (!res.__go || res.__go.error) fail(`${label}.go: Go probe did not run (${res.__go && res.__go.error})`);
    else for (const [k, w] of Object.entries(wantGo)) expect(`${label}.go.${k}`, res.__go[k], w);
  }
  return failures.length - before;
}

async function bulkEcho(sock, token) {
  const data = crypto.randomBytes(4 * 1024 * 1024);
  try {
    const res = await bridgeRequest(sock, token, 'api', { method: 'POST', path: '/echo', body: data });
    const h = crypto.createHash('sha256'); let n = 0;
    for await (const d of res.body) { h.update(d); n += d.length; }
    return h.digest('hex') === crypto.createHash('sha256').update(data).digest('hex') && n === data.length ? 'intact' : 'corrupt';
  } catch { return 'error'; }
}

async function adapterChecks(sock, token) {
  const f = unixFetch(sock, token, 'api');
  const out = {};
  const health = await f('http://127.0.0.1:1/healthz', { method: 'GET', redirect: 'error' });
  out.healthz = { status: health.status, body: (await health.json()).standin };
  const echo = await f('http://127.0.0.1:1/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'x'.repeat(1000) }) });
  out.postEcho = (await echo.text()).length;
  const nf = await f('http://127.0.0.1:1/nope', { method: 'POST' });
  out.notFound = nf.status;
  const ac = new AbortController(); const slow = f('http://127.0.0.1:1/hang', { method: 'GET', signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  out.abort = await slow.then(() => 'completed', (e) => (e.name === 'AbortError' || e.code === 'ABORT_ERR' ? 'aborted' : 'error:' + e.name));
  return out;
}

const flatten = (role, r) => (role === 'child' ? { ...r.child, __go: r.go } : { ...r.parent, __go: r.go });
const healthOf = (s, ev) => waitFor(async () => { try { return await apiGet(s.t.apiSock, ev.apiToken, '/healthz', { timeout: 2000 }); } catch { return undefined; } }, 8000);

// ================================================================== the run
const report = { host: {}, scenarios: {} };
const nsBefore = netnsCount();

await section('host facts', async () => {
  const env = { ...process.env, ...(abiCap ? { ZKAPI_CONFINE_PROTOTYPE_ABI: abiCap } : {}) };
  let chk; try { chk = JSON.parse(execFileSync(launcher, ['check'], { encoding: 'utf8', env })); } catch (e) { chk = { ok: false, error: String(e) }; }
  report.host = { kernel: execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim(), runtime: runtimeName, check: chk };
  log('host: ' + JSON.stringify(report.host));
  ok('launcher check', chk.ok === true, JSON.stringify(chk));
  if (chk.ok) {
    ok('check reports pidns', chk.layers.includes('pidns'));
    ok('check acknowledges stage0 hardening', ['nnp', 'launcher-undumpable', 'launcher-seccomp'].every((l) => (chk.stage0Layers || []).includes(l)), JSON.stringify(chk.stage0Layers));
  }
  if (!chk.ok) { log('cannot continue without a working launcher'); finish(); }
});

// ---- 1. control: the same probe, no confinement
await section('control (no confinement)', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-')); fs.chmodSync(workDir, 0o700);
  const fx = await hostFixture(workDir, { torAtNsPort: true });
  const t = fx.t;
  const dUnix = net.connect({ path: t.hostUnix }); const dTcp = net.connect({ host: '127.0.0.1', port: t.other }); dUnix.on('error', () => {}); dTcp.on('error', () => {});
  await Promise.all([new Promise((r) => dUnix.once('connect', r)), new Promise((r) => dTcp.once('connect', r))]);
  const inherit = [dUnix, dTcp].map((s) => s._handle.fd);
  t.decoyInodes = inherit.map((fd) => fs.readlinkSync('/proc/self/fd/' + fd));
  const child = spawn(process.execPath, [path.join(here, 'standin-daemon.cjs'), JSON.stringify(t)], { stdio: ['ignore', 'pipe', 'pipe', ...inherit], detached: true });
  const r = await waitFor(async () => { try { const hs = `http://127.0.0.1:${t.api}`; const h = await fetch(hs + '/healthz'); if (h.ok) return await (await fetch(hs + '/probe')).json(); } catch {} }, 20000);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  killAll([workDir, fx.marker]);
  dUnix.destroy(); dTcp.destroy(); fx.close();
  const dgramHits = fx.dgramLog();
  fs.rmSync(workDir, { recursive: true, force: true });
  if (!r || r.error) { fail('control probe did not run: ' + JSON.stringify(r)); return; }
  const parent = { ...r.parent, __go: r.go }; const kid = { ...r.child, __go: r.go };
  const n = evaluate(parent, outside, goOutside, 'control.parent') + evaluate(kid, outside, undefined, 'control.child');
  ok('control: the probe can reach the host datagram decoy (so it can detect an escape)', dgramHits > 0, `datagrams seen ${dgramHits}`);
  ok('control: inherited decoy descriptors present', Number(parent.inherited_decoy_fds) > 0, parent.inherited_decoy_fds);
  report.scenarios.control = { parent: r.parent, child: r.child, go: r.go, failures: n, dgramHits };
  log(`[control] unexpected rows: ${n}; datagrams the probe landed on the host decoy: ${dgramHits}`);
});

// ---- 2. confined: the matrix
const timing = {};
const startedAt = Date.now();
const base = await session({ label: 'confined' });
let baseReady; let baseProbe;
await section('confined session: matrix', async () => {
  const ev = await eventOf(base.run, 10000);
  if (!ev || ev.event !== 'ready') { fail('confined session did not start: ' + JSON.stringify(ev || { code: 'no_ready_event' })); return; }
  baseReady = ev;
  const health = await healthOf(base, ev);
  if (!health) { fail('confined daemon never answered /healthz over the authenticated bridge'); return; }
  baseProbe = await apiGet(base.t.apiSock, ev.apiToken, '/probe');
  if (baseProbe.error) { fail('probe endpoint failed: ' + baseProbe.error); baseProbe = undefined; return; }
  baseProbe.bulk = await bulkEcho(base.t.apiSock, ev.apiToken);
  baseProbe.adapter = await adapterChecks(base.t.apiSock, ev.apiToken);
  timing.sessionUpToProbeMs = Date.now() - startedAt;
  const parent = flatten('parent', baseProbe); const kid = flatten('child', baseProbe);
  const n = evaluate(parent, inside, goInside, 'confined.parent') + evaluate(kid, inside, undefined, 'confined.child');
  expect('confined.api_bridge_bulk', baseProbe.bulk, 'intact');
  expect('confined.adapter.healthz', JSON.stringify(baseProbe.adapter.healthz), JSON.stringify({ status: 200, body: 'ns' }));
  expect('confined.adapter.postEcho', baseProbe.adapter.postEcho, 1008);
  expect('confined.adapter.notFound', baseProbe.adapter.notFound, 404);
  expect('confined.adapter.abort', baseProbe.adapter.abort, 'aborted');
  for (const l of ['netns', 'pidns', 'ipv6-off', 'caps', 'nnp', 'launcher-undumpable', 'launcher-seccomp', 'landlock-net', 'seccomp']) ok(`ready.layers has ${l}`, ev.layers.includes(l), JSON.stringify(ev.layers));
  for (const l of ['nnp', 'launcher-undumpable', 'launcher-seccomp']) ok(`ready.stage0Layers acknowledges ${l}`, (ev.stage0Layers || []).includes(l), JSON.stringify(ev.stage0Layers));
  if (!abiCap || Number(abiCap) >= 8) ok('ready.stage0Layers acknowledges launcher-landlock', (ev.stage0Layers || []).includes('launcher-landlock'), JSON.stringify(ev.stage0Layers));
  report.scenarios.confined = { ready: { ...ev, apiToken: '(redacted)' }, health, parent: baseProbe.parent, child: baseProbe.child, go: baseProbe.go, failures: n };
  log(`[confined] ready event: ${JSON.stringify({ ...ev, apiToken: '(redacted)' })}`);
  log(`[confined] rows (parent | exec'd child) with the unconfined control:`);
  const ctrl = report.scenarios.control || { parent: {}, go: {} };
  for (const k of Object.keys(inside)) log(`  ${k.padEnd(30)} outside=${String(ctrl.parent[k]).padEnd(20)} parent=${String(parent[k]).padEnd(20)} child=${String(kid[k])}`);
  log('  -- exec\'d Go child (raw syscalls), launcher protection --');
  for (const k of Object.keys(goInside)) log(`  ${k.padEnd(36)} outside=${String(ctrl.go && ctrl.go[k]).padEnd(18)} confined=${String(baseProbe.go[k])}`);
  log(`  fetch adapter over the authenticated bridge: ${JSON.stringify(baseProbe.adapter)}`);
  log(`  api bridge, 4 MiB POST echoed host->namespace->host: ${baseProbe.bulk}`);
  log(`[confined] unexpected rows: ${n}`);
});

// ---- 3. identity, inspection, private channel
await section('instance binding, inspection, private status channel', async () => {
  if (!baseReady) { fail('no confined session to inspect'); return; }
  const ev = baseReady;
  const sock = base.t.apiSock;
  const facts = {};
  const wd = { watchdogPid: base.run.watchdogPid, watchdogStart: base.run.watchdogStart };
  const errs = verifyInstance(ev, wd);
  ok('ready event binds the whole chain watchdog -> stage0 -> stage1 -> daemon', errs.length === 0, errs.join('; '));
  facts.instanceProblems = errs;
  facts.chain = { watchdog: wd.watchdogPid, stage0: ev.stage0Pid, stage1: ev.stage1Pid, daemon: ev.daemonPid };
  // Negative cases the supervisor must refuse, one per link of the chain.
  const own = statOf(process.pid);
  const helper = spawn('sleep', ['30'], { stdio: 'ignore' }); // a process of ours, unrelated to the launcher
  await sleep(50);
  const helperSt = statOf(helper.pid);
  const neg = {
    pidReuse: verifyInstance({ ...ev, daemonStart: '1' }, wd),
    unrelatedPid: verifyInstance({ ...ev, daemonPid: process.pid, daemonStart: own.start }, wd),
    stage0Reuse: verifyInstance({ ...ev, stage0Start: '1' }, wd),
    stage1Reuse: verifyInstance({ ...ev, stage1Start: '1' }, wd),
    wrongWatchdog: verifyInstance(ev, { watchdogPid: process.pid, watchdogStart: own.start }),
    watchdogReuse: verifyInstance(ev, { ...wd, watchdogStart: '1' }),
    // the shape revision 2 of the design wrongly required: stage0 skipped
    stage0IsTheWatchdog: verifyInstance({ ...ev, stage0Pid: wd.watchdogPid, stage0Start: wd.watchdogStart }, wd),
    // stage1 replaced by a process whose parent is not stage0: another real
    // launcher process (the daemon), and an unrelated process of ours
    stage1Reparented: verifyInstance({ ...ev, stage1Pid: ev.daemonPid, stage1Start: statOf(ev.daemonPid).start }, wd),
    stage1Unrelated: verifyInstance({ ...ev, stage1Pid: helper.pid, stage1Start: helperSt.start }, wd),
  };
  try { helper.kill('SIGKILL'); } catch {}
  for (const [k, v] of Object.entries(neg)) ok(`supervisor refuses ${k}`, v.length > 0, 'accepted a forged binding');
  ok('stage1Reparented is refused for its parentage, not only its depth', neg.stage1Reparented.some((m) => m.includes('stage1 is not a child of stage0')), JSON.stringify(neg.stage1Reparented));
  facts.negativeBindings = Object.fromEntries(Object.entries(neg).map(([k, v]) => [k, v]));
  facts.processGroup = processGroup(base.run.pgid).map((p) => p.comm);
  // listeners: read in the namespace, expect exactly the API port and the Tor bridge
  const l = listenersOf(ev.daemonPid);
  facts.nsListeners = l.ports;
  const expected = [base.t.api, base.t.tor].sort((a, b) => a - b);
  ok('namespace listeners are exactly the expected set', JSON.stringify(l.ports) === JSON.stringify(expected), `got ${JSON.stringify(l.ports)} want ${JSON.stringify(expected)}`);
  const hostTcp = fs.readFileSync('/proc/net/tcp', 'utf8');
  const hexApi = base.t.api.toString(16).toUpperCase().padStart(4, '0');
  facts.hostProcNetTcpListsApiPort = hostTcp.split('\n').some((x) => x.includes(`:${hexApi} `) && x.includes(' 0A '));
  ok('host /proc/net/tcp does not list the API port', facts.hostProcNetTcpListsApiPort === false);
  facts.apiSockOwnerUidIsOurs = fs.lstatSync(sock).uid === process.getuid();
  ok('api socket is a socket owned by us', facts.apiSockOwnerUidIsOurs && fs.lstatSync(sock).isSocket());
  facts.apiSockMode = (fs.lstatSync(sock).mode & 0o777).toString(8);
  expect('api socket mode', facts.apiSockMode, '600');
  facts.procOwnerUid = { launcher: fs.statSync(`/proc/${ev.stage1Pid}`).uid, daemon: fs.statSync(`/proc/${ev.daemonPid}`).uid, us: process.getuid() };
  for (const [name, pid] of [['launcher', ev.stage1Pid], ['daemon', ev.daemonPid]]) {
    const st = statusOf(pid);
    facts[name] = { pid, NoNewPrivs: /NoNewPrivs:\s*(\d)/.exec(st)[1], Seccomp: /Seccomp:\s*(\d)/.exec(st)[1], CapEff: /CapEff:\s*(\w+)/.exec(st)[1] };
    expect(`${name} NoNewPrivs`, facts[name].NoNewPrivs, '1'); expect(`${name} Seccomp`, facts[name].Seccomp, '2'); expect(`${name} CapEff`, facts[name].CapEff, '0000000000000000');
  }
  // The stage0 (our child) is hardened too, and acknowledged in the ready event.
  const s0 = statusOf(ev.stage0Pid);
  facts.stage0 = { NoNewPrivs: /NoNewPrivs:\s*(\d)/.exec(s0)[1], Seccomp: /Seccomp:\s*(\d)/.exec(s0)[1] };
  expect('stage0 NoNewPrivs', facts.stage0.NoNewPrivs, '1'); expect('stage0 Seccomp', facts.stage0.Seccomp, '2');
  // A daemon cannot reach the private status descriptor, and what it prints is not an event.
  const forged = await apiGet(sock, ev.apiToken, '/forge');
  await sleep(200);
  const outText = base.run.out.join('') + base.run.err.join('');
  facts.forgedLineSeenOnDaemonOutput = outText.includes('"forged":true');
  ok('the daemon can print a forged event line (control for the next row)', facts.forgedLineSeenOnDaemonOutput);
  ok('the forged line never became a launcher event', !base.run.events.some((e) => e.forged), 'forged event accepted');
  expect('daemon write to the status descriptor', forged.fd3, /^(EBADF|EINVAL)$/); // EINVAL: Node reuses fd 3 for its own event loop, still not the status pipe
  facts.eventsAfterForge = base.run.events.map((e) => e.event);
  report.scenarios.inspection = facts;
  log(JSON.stringify(facts, null, 2));
});

// ---- 3a. unbound listen: private listener, detected, unreachable from outside
await section('unbound listen() (finding: listener policy)', async () => {
  if (!baseReady) { fail('no confined session'); return; }
  const r = await apiGet(base.t.apiSock, baseReady.apiToken, '/hold-listener');
  ok('holder process reported a listener port', typeof r.port === 'number', JSON.stringify(r));
  if (typeof r.port !== 'number') return;
  const res = await new Promise((resolve) => { const s = net.connect({ host: '127.0.0.1', port: r.port }); s.on('connect', () => { s.destroy(); resolve('connected'); }); s.on('error', (e) => resolve(e.code)); });
  expect('host connect to the unbound-listen port', res, 'ECONNREFUSED');
  const l = listenersOf(baseReady.daemonPid);
  const unexpected = (l.ports || []).filter((p) => ![base.t.api, base.t.tor].includes(p));
  ok('inspection detects the extra listener', unexpected.includes(r.port), `listeners ${JSON.stringify(l.ports)}`);
  report.scenarios.unboundListen = { port: r.port, hostConnect: res, unexpectedListeners: unexpected };
  log(`  extra namespace listener ${r.port} (unbound listen) detected by the strict set check; unreachable from the host: ${res}`);
});

// ---- 3b. timing
await section('cost of the bridge and the launcher', async () => {
  if (!baseReady) { fail('no confined session'); return; }
  const t0 = Date.now(); const n = 50;
  for (let i = 0; i < n; i++) await apiGet(base.t.apiSock, baseReady.apiToken, '/healthz');
  timing.apiBridgeRoundTripMs = Number(((Date.now() - t0) / n).toFixed(2));
  const direct = [];
  for (let i = 0; i < 5; i++) {
    const s = Date.now();
    await new Promise((resolve) => { const c = spawn(launcher, ['check'], { stdio: ['ignore', 'ignore', 'ignore'] }); c.on('exit', resolve); });
    direct.push(Date.now() - s);
  }
  timing.checkWallMs = direct; // includes the 500 ms no-op program the check runs
  report.scenarios.timing = timing;
  log(JSON.stringify(timing));
});

// ---- 3c. a Go stand-in (the real daemon is a Go program)
await section('Go stand-in daemon', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-')); fs.chmodSync(workDir, 0o700);
  const fx = await hostFixture(workDir);
  const run = launch({ t: fx.t, workDir, extraEnv: daemonEnv(), program: gostandin, programArgs: [String(fx.t.api), String(fx.t.tor), String(fx.t.other)] });
  try {
    const ev = await eventOf(run, 10000);
    if (!ev || ev.event !== 'ready') { fail('go stand-in session did not start: ' + JSON.stringify(ev)); return; }
    const health = await waitFor(async () => { try { return await apiGet(fx.t.apiSock, ev.apiToken, '/healthz', { timeout: 2000 }); } catch { return undefined; } }, 8000);
    const rows = health ? await apiGet(fx.t.apiSock, ev.apiToken, '/go-probe') : { error: 'no health' };
    const want = { tor_bridge_echo: 'TOR-HOST:probe', connect_other_port: 'failed_fast', connect_remote_testnet: 'failed_fast', ipv6_loopback: 'failed_fast', udp_dial: 'failed_fast', bind_other_port: 'denied', bind_ipv6: 'denied', dns_lookup: 'failed' };
    for (const [k, w] of Object.entries(want)) expect(`go-standin.${k}`, rows[k], w);
    report.scenarios.goStandin = { rows };
    log(JSON.stringify(rows));
  } finally {
    try { process.kill(-run.pgid, 'SIGKILL'); } catch {}
    fx.close();
    const gone = await waitGone([workDir], 3000);
    ok('go stand-in: nothing survives the group kill', gone);
    killAll([workDir]); fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// ---- 4. the compromised-daemon scenarios on the live session
await section('Tor bridge: host side down, then API path swapped (finding: bridge redirect)', async () => {
  if (!baseReady) { fail('no confined session'); return; }
  const ev = baseReady; const sock = base.t.apiSock;
  const faults = {};
  // 4a. Tor side: the host stand-in is gone => a connection through the bridge closes fast.
  base.fx.torHost.close();
  await sleep(150);
  faults.torHostDown = (await apiGet(sock, ev.apiToken, '/tor-connect')).result;
  expect('bridge to a dead Tor port', faults.torHostDown, /^(closed|failed)_fast$/);
  // 4b. the daemon swaps the API socket path for a symlink to a host socket. The
  // supervisor's authenticated connect must refuse; the host socket sees only
  // the 16-byte nonce, never a request. The Tor bridge has no path to swap.
  const before = base.fx.decoy.streamConns;
  const swap = await apiGet(sock, ev.apiToken, '/swap-api');
  expect('daemon could rewrite the session directory (control for the next rows)', swap.swapped, true);
  let verdict;
  try { await apiGet(sock, ev.apiToken, '/healthz', { timeout: 3000 }); verdict = 'REQUEST SENT'; } catch (e) { verdict = e.code === 'EAUTH' || /api_peer_unauthenticated/.test(String(e.message)) ? 'refused' : 'refused:' + (e.code || e.message); }
  await sleep(200);
  faults.apiPathSwapped = { verdict, decoyConnections: base.fx.decoy.streamConns - before, decoyBytes: base.fx.decoy.streamBytes.length, decoySawHttp: base.fx.decoy.streamBytes.includes('GET ') };
  ok('swapped API path: authenticated connect refused', verdict === 'refused', verdict);
  ok('swapped API path: the host socket received no HTTP request', faults.apiPathSwapped.decoySawHttp === false && faults.apiPathSwapped.decoyBytes <= 16, JSON.stringify(faults.apiPathSwapped));
  ok('no launcher stage ever connected to the host stream decoy', base.fx.decoy.streamConns - before <= 1, `decoy connections ${base.fx.decoy.streamConns - before}`);
  ok('the host datagram decoy received nothing during the confined run', base.fx.dgramLog() === 0, `datagrams ${base.fx.dgramLog()}`);
  report.scenarios.bridgeFaults = faults;
  log(JSON.stringify(faults, null, 2));
});

await section('lifecycle: the session ends with every descendant', async () => {
  const results = {};
  async function withEscapers(label, fn) {
    const s = await session({ label, withDecoyFds: false });
    const ev = await eventOf(s.run, 10000);
    if (!ev || ev.event !== 'ready') { fail(`${label}: no ready event: ${JSON.stringify(ev)}`); await s.cleanup(); return; }
    if (!(await healthOf(s, ev))) { fail(`${label}: daemon not answering`); await s.cleanup(); return; }
    const sp = await apiGet(s.t.apiSock, ev.apiToken, '/spawn-escapers');
    await sleep(500);
    const escapers = procsMatching([s.marker]);
    const escaped = escapers.filter((p) => p.pgrp !== s.run.pgid);
    ok(`${label}: escapers are alive and outside the recorded process group`, escapers.length >= 4 && escaped.length >= 4, `alive ${escapers.length}, outside group ${escaped.length}, spawn ${JSON.stringify(sp)}`);
    const r = await fn(s, ev);
    results[label] = { escapersAlive: escapers.length, outsideGroup: escaped.length, ...r };
    await s.cleanup();
  }
  await withEscapers('daemon-exits', async (s, ev) => {
    await apiGet(s.t.apiSock, ev.apiToken, '/exit').catch(() => {});
    const exit = await Promise.race([s.run.exited, sleep(5000).then(() => 'hung')]);
    const gone = await waitGone(s.needles, 4000);
    ok('daemon-exits: launcher exited', exit !== 'hung', JSON.stringify(exit));
    ok('daemon-exits: no descendant survives', gone, JSON.stringify(procsMatching(s.needles)));
    return { launcherExit: exit, allGone: gone };
  });
  await withEscapers('supervisor-group-kill', async (s) => {
    process.kill(-s.run.pgid, 'SIGKILL');
    const gone = await waitGone(s.needles, 4000);
    ok('supervisor-group-kill: no descendant survives a plain group kill', gone, JSON.stringify(procsMatching(s.needles)));
    return { allGone: gone };
  });
  await withEscapers('stage0-sigkill', async (s, ev) => {
    process.kill(ev.stage0Pid, 'SIGKILL');
    const gone = await waitGone(s.needles, 4000);
    ok('stage0-sigkill: no descendant survives', gone, JSON.stringify(procsMatching(s.needles)));
    return { allGone: gone };
  });
  await withEscapers('stage1-sigkill', async (s, ev) => {
    process.kill(ev.stage1Pid, 'SIGKILL');
    const exit = await Promise.race([s.run.exited, sleep(5000).then(() => 'hung')]);
    const gone = await waitGone(s.needles, 4000);
    ok('stage1-sigkill: stage0 exited', exit !== 'hung', JSON.stringify(exit));
    ok('stage1-sigkill: no descendant survives', gone, JSON.stringify(procsMatching(s.needles)));
    return { stage0Exit: exit, allGone: gone };
  });
  await withEscapers('daemon-sigkill', async (s, ev) => {
    process.kill(ev.daemonPid, 'SIGKILL');
    const exit = await Promise.race([s.run.exited, sleep(5000).then(() => 'hung')]);
    const gone = await waitGone(s.needles, 4000);
    let apiAfter = 'connected';
    await new Promise((resolve) => { const c = net.connect({ path: s.t.apiSock }); c.on('connect', () => { c.destroy(); resolve(); }); c.on('error', (e) => { apiAfter = e.code; resolve(); }); });
    ok('daemon-sigkill: launcher exits with the daemon status', exit !== 'hung' && exit.code === 137, JSON.stringify(exit));
    ok('daemon-sigkill: no descendant survives', gone, JSON.stringify(procsMatching(s.needles)));
    ok('daemon-sigkill: the API socket is gone', apiAfter === 'ENOENT' || apiAfter === 'ECONNREFUSED', apiAfter);
    return { launcherExit: exit, allGone: gone, apiSocketAfter: apiAfter };
  });
  // The watchdog's SIGKILL: a parent that spawns the launcher the way the
  // watchdog does is killed, with escapers already running.
  {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-')); fs.chmodSync(workDir, 0o700);
    const fx = await hostFixture(workDir); fx.t.escapeOnStart = true;
    const needles = [fx.marker, workDir];
    const argv = [launcher, ...launchArgs(fx.t, workDir, process.execPath, [path.join(here, 'standin-daemon.cjs'), JSON.stringify(fx.t)])];
    const shim = spawn(process.execPath, [path.join(here, 'shim.cjs'), JSON.stringify(argv)], { detached: true, stdio: 'ignore', env: { ...process.env, ...daemonEnv() } });
    const up = await waitFor(() => procsMatching([fx.marker]).length >= 4, 10000);
    const alive = procsMatching(needles).length;
    ok('shim-sigkill: session and escapers started', !!up, `alive ${alive}`);
    process.kill(shim.pid, 'SIGKILL');
    const gone = await waitGone(needles, 5000);
    ok('shim-sigkill: nothing survives the parent being killed', gone, JSON.stringify(procsMatching(needles)));
    results['shim-sigkill'] = { aliveBefore: alive, allGone: gone };
    killAll(needles); fx.close(); fs.rmSync(workDir, { recursive: true, force: true });
  }
  // An adversarial init (a compromised stage1): it tries to keep a parent-death
  // signal that is not SIGKILL, clear it, and leave the recorded group. Then
  // stage0 alone is killed; nothing may survive. Without the seccomp layer the
  // same init does survive, so the row can see the failure it guards.
  for (const [label, ablation] of [['init-escape', ''], ['init-escape-without-seccomp', 'seccomp']]) {
    const s = await session({ ablation, label, extraEnv: { ZKAPI_CONFINE_PROTOTYPE_FAULT: 'init-escape' }, withDecoyFds: false, allowSurvivors: ablation !== '' });
    const ev = await eventOf(s.run, 10000);
    const esc = await waitFor(() => s.run.events.find((e) => e.event === 'init_escape'), 5000);
    if (!ev || ev.event !== 'ready' || !esc) { fail(`${label}: no ready/init_escape event: ${JSON.stringify(s.run.events)}`); await s.cleanup(); continue; }
    ok(`${label}: the init stand-in left the recorded process group`, (statOf(ev.stage1Pid) || {}).pgrp !== s.run.pgid, JSON.stringify(statOf(ev.stage1Pid)));
    expect(`${label}: setting SIGKILL`, esc.keepPdeathsig, 'ok');
    if (!ablation) {
      expect(`${label}: softening the parent-death signal`, esc.softenPdeathsig, 'EPERM');
      expect(`${label}: clearing the parent-death signal`, esc.clearPdeathsig, 'EPERM');
    } else {
      expect(`${label}: softening (no filter)`, esc.softenPdeathsig, 'ok');
      expect(`${label}: clearing (no filter)`, esc.clearPdeathsig, 'ok');
    }
    process.kill(ev.stage0Pid, 'SIGKILL');
    const gone = await waitGone(s.needles, 4000);
    if (!ablation) ok(`${label}: stage0 killed, nothing survives`, gone, JSON.stringify(procsMatching(s.needles)));
    else ok(`${label}: without the filter the init survives (the row detects the failure)`, !gone);
    results[label] = { esc: { keep: esc.keepPdeathsig, soften: esc.softenPdeathsig, clear: esc.clearPdeathsig, setsid: esc.setsid }, allGone: gone };
    killAll(s.needles);
    await s.cleanup();
  }
  report.scenarios.lifecycle = results;
  log(JSON.stringify(results, null, 2));
});

// ---- 5. refusal and fail-closed behaviour
await section('refusals and fail-closed behaviour', async () => {
  const refusals = {};
  const runTo = (args, env = {}, opts = {}) => new Promise((resolve) => {
    const c = spawn(launcher, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', ...(opts.status ? ['pipe'] : [])] });
    let out = ''; let err = ''; let st = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    if (opts.status) c.stdio[3].on('data', (d) => { st += d; });
    const timer = setTimeout(() => c.kill('SIGKILL'), 8000);
    c.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: out.trim(), stderr: err.trim(), status: st.split('\n').filter((l) => l.startsWith('zkapi-confine: ')).map((l) => JSON.parse(l.slice(15))) }); });
  });
  // a session directory with the wrong mode is refused before anything starts
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-bad-')); fs.chmodSync(bad, 0o755);
  refusals.badDirMode = await runTo(['run', '--dir', bad, '--expose', 'api=1', '--status-fd', '3', '--', process.execPath, '-e', '0'], {}, { status: true });
  fs.rmSync(bad, { recursive: true, force: true });
  expect('bad session dir mode: exit', refusals.badDirMode.code, 64);
  // finding: the private status channel is mandatory
  const marker = 'zkc-nostatus-' + crypto.randomBytes(4).toString('hex');
  refusals.noStatusFd = await runTo(['run', '--connect-port', '1', '--', process.execPath, '-e', 'setInterval(()=>{},1000)', marker]);
  expect('missing --status-fd: exit', refusals.noStatusFd.code, 64);
  ok('missing --status-fd: no daemon was started', procsMatching([marker]).length === 0);
  // nested namespace creation is refused inside a confinement: the refusal path
  refusals.checkInsideConfinement = await new Promise((resolve) => {
    const c = spawn(launcher, ['run', '--status-fd', '3', '--connect-port', '1', '--', launcher, 'check'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stdio[3].resume(); c.on('exit', (code) => resolve({ code, out: o.split('\n').filter((l) => l && !l.startsWith('zkapi-confine:')) }));
  });
  ok('check inside a confinement refuses (exit 78, ok:false)', refusals.checkInsideConfinement.code === 78 && refusals.checkInsideConfinement.out.some((l) => l.includes('"ok":false')), JSON.stringify(refusals.checkInsideConfinement));
  // forced failures (prototype fault switches): every one must refuse, with no daemon
  const faultCases = [
    ['stage0Hardening', { ZKAPI_CONFINE_PROTOTYPE_FAULT: 'harden-stage0' }, 'launcher_hardening_failed'],
    ['stage0Cloexec', { ZKAPI_CONFINE_PROTOTYPE_FAULT: 'cloexec' }, 'descriptor_sanitize_failed'],
    ['stage1Cloexec', { ZKAPI_CONFINE_PROTOTYPE_FAULT: 'cloexec1' }, 'descriptor_sanitize_failed'],
    ['cloexecFallbackFails', { ZKAPI_CONFINE_PROTOTYPE_FAULT: 'cloexec-fb-fail' }, 'descriptor_sanitize_failed'],
  ];
  for (const [name, env, code] of faultCases) {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-f-')); fs.chmodSync(wd, 0o700);
    const mk = 'zkc-f-' + crypto.randomBytes(4).toString('hex');
    const started = path.join(wd, 'started');
    const r = await runTo(['run', '--dir', wd, '--status-fd', '3', '--connect-port', '1', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(started)},'x');setInterval(()=>{},1000)`, mk], daemonEnv(env), { status: true });
    refusals[name] = { code: r.code, events: r.status.map((e) => e.event + ':' + (e.code || '')) };
    expect(`${name}: exit`, r.code, 78);
    ok(`${name}: refused with ${code}`, r.status.some((e) => e.event === 'refused' && e.code === code), JSON.stringify(r.status));
    ok(`${name}: no ready event`, !r.status.some((e) => e.event === 'ready'));
    ok(`${name}: the daemon never started`, !fs.existsSync(started) && procsMatching([mk]).length === 0);
    fs.rmSync(wd, { recursive: true, force: true });
  }
  // the /proc/self/fd fallback, forced, works when nothing fails
  {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-f-')); fs.chmodSync(wd, 0o700);
    const r = await runTo(['run', '--dir', wd, '--status-fd', '3', '--connect-port', '1', '--', process.execPath, '-e', '0'], daemonEnv({ ZKAPI_CONFINE_PROTOTYPE_FAULT: 'cloexec-fb' }), { status: true });
    refusals.cloexecFallbackWorks = { code: r.code, events: r.status.map((e) => e.event) };
    ok('cloexec fallback (forced) lets a healthy session reach ready', r.status.some((e) => e.event === 'ready') && r.code === 0, JSON.stringify(refusals.cloexecFallbackWorks));
    fs.rmSync(wd, { recursive: true, force: true });
  }
  // missing events: the supervisor's rule is "no ready event in time => kill the session and refuse"
  {
    const s = await session({ label: 'silent', extraEnv: { ZKAPI_CONFINE_PROTOTYPE_FAULT: 'silent' }, withDecoyFds: false });
    const ev = await eventOf(s.run, 1500);
    ok('silent launcher: no ready event arrived (the supervisor must refuse)', ev === undefined, JSON.stringify(ev));
    const gone = await s.cleanup(); // kills the group and asserts nothing is left
    refusals.silentLauncher = { readyEvent: !!ev, allGone: gone };
  }
  report.scenarios.refusals = refusals;
  log(JSON.stringify(refusals, null, 2));
});

// ---- 5b. a hostile daemon's malformed HTTP framing must be refused, in bounded time
await section('malformed daemon responses (supervisor client)', async () => {
  const oneCase = (name, impl) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(here, 'framing.cjs'), name], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...(impl ? { FETCH_IMPL: impl } : {}) } });
    let o = '';
    c.stdout.on('data', (d) => { o += d; });
    // timed from OUTSIDE: a parser that spins cannot be stopped by its own timers
    const timer = setTimeout(() => { c.kill('SIGKILL'); resolve({ outcome: 'hung_killed_externally' }); }, 8000);
    c.on('exit', () => { clearTimeout(timer); try { resolve(JSON.parse(o.trim().split('\n').pop())); } catch { resolve({ outcome: 'no_result' }); } });
  });
  const list = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(here, 'framing.cjs'), '--list'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('exit', () => resolve(JSON.parse(o)));
  });
  const wantOk = { 'ok-content-length': 'ok:OK', 'ok-chunked': 'ok:OK', 'ok-close-delimited': 'ok:hi' };
  const results = {};
  for (const name of list) {
    const r = await oneCase(name);
    results[name] = r.outcome;
    expect(`framing ${name}`, r.outcome, wantOk[name] || 'rejected');
  }
  report.scenarios.framing = results;
  log(JSON.stringify(results, null, 2));
  const old = arg('old-fetch', '');
  if (old) { // optional self-check: the previous parser must NOT pass the same cases
    const r = await oneCase('cl-nope', old);
    report.scenarios.framingOldParser = r.outcome;
    ok('the previous parser fails the malformed-length case (the test can see the defect)', r.outcome !== 'rejected', r.outcome);
    log('  previous parser, cl-nope: ' + r.outcome);
  }
});

// ---- 6. ablations: what each layer is for, and proof the probes can detect it
if (mode === 'full') {
  await section('ablations', async () => {
    const ablations = {};
    const mustFail = {
      'landlock-net': ['bind_other_port', 'bind_ephemeral', 'bind_wildcard_forbidden_port'],
      seccomp: ['seccomp_mode', 'udp_loopback', 'go.socket_inet6', 'go.socket_unix', 'go.socketpair_unix_dgram', 'go.io_uring_setup', 'go.unshare_newuser'],
      caps: ['caps'],
    };
    const mustPass = ['landlock-unix', 'landlock-scope', 'dumpable'];
    for (const layer of ['netns', 'landlock-net', 'landlock-unix', 'landlock-scope', 'seccomp', 'caps', 'dumpable', 'pidns']) {
      const s = await session({ ablation: layer, label: 'ablate-' + layer, allowSurvivors: layer === 'pidns' });
      const ev = await eventOf(s.run, 10000);
      if (!ev || ev.event !== 'ready') {
        ablations[layer] = { refused: ev || 'no event' };
        if (layer === 'netns') log(`  ablate ${layer}: refused (${JSON.stringify(ev)})`); else fail(`ablate ${layer}: did not start: ${JSON.stringify(ev)}`);
        await s.cleanup(); continue;
      }
      if (!(await healthOf(s, ev))) { fail(`ablate ${layer}: daemon not answering`); await s.cleanup(); continue; }
      const probeRes = await apiGet(s.t.apiSock, ev.apiToken, '/probe');
      const saved = failures.length;
      quietFailures = true;
      try { evaluate(flatten('parent', probeRes), inside, goInside, 'a'); evaluate(flatten('child', probeRes), inside, undefined, 'a.child'); } finally { quietFailures = false; }
      const rowsFailing = failures.splice(saved).map((f) => f.replace(/^a\.child\./, 'child.').replace(/^a\./, '').split(':')[0]);
      ablations[layer] = { failingRows: rowsFailing };
      if (mustFail[layer]) for (const row of mustFail[layer]) ok(`ablate ${layer}: probe row ${row} detects it`, rowsFailing.includes(row), JSON.stringify(rowsFailing));
      if (mustPass.includes(layer)) ok(`ablate ${layer}: other layers still cover every row on this host`, rowsFailing.length === 0, JSON.stringify(rowsFailing));
      if (layer === 'netns') ok('ablate netns: rows fail', rowsFailing.length > 0);
      if (layer === 'pidns') {
        // without the PID namespace the lifecycle guarantee is gone: an escaper survives a group kill
        const sp = await apiGet(s.t.apiSock, ev.apiToken, '/spawn-escapers');
        await sleep(400);
        process.kill(-s.run.pgid, 'SIGKILL');
        await sleep(800);
        const survivors = procsMatching([s.marker]);
        ablations[layer].escapersSurvivingGroupKill = survivors.length;
        ok('ablate pidns: escapers survive a group kill (the layer is what prevents it)', survivors.length > 0, JSON.stringify(sp));
      }
      await s.cleanup();
    }
    report.scenarios.ablations = ablations;
    log(JSON.stringify(ablations, null, 2));
  });
}

// ---- 7. teardown of the main session, then global post-conditions
await section('teardown and leaks', async () => {
  const gone = await base.cleanup(); // kills the recorded group like the supervisor, asserts nothing is left
  ok('no process of the main session remains after the group kill', gone);
  await sleep(300);
  const nsAfter = netnsCount();
  ok('network namespaces on the host unchanged', nsAfter === nsBefore, `before ${nsBefore} after ${nsAfter}`);
  const strayLaunchers = procsMatching(['zkapi-confine run', ' __stage1', ' __stage2']);
  ok('no launcher stage remains', strayLaunchers.length === 0, JSON.stringify(strayLaunchers));
  report.scenarios.leaks = { nsBefore, nsAfter, strayLaunchers: strayLaunchers.length };
  log(JSON.stringify(report.scenarios.leaks));
});

function finish() {
  log(`\nRESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${failures.length} failure${failures.length === 1 ? '' : 's'}) on ${runtimeName}${abiCap ? `, emulated Landlock ABI ${abiCap}` : ''}, mode ${mode}`);
  for (const f of failures) log('  - ' + f);
  report.failures = failures;
  try { fs.writeFileSync(arg('out', 'matrix-result.json'), JSON.stringify(report, null, 2)); } catch {}
  process.exit(failures.length === 0 ? 0 : 1);
}
finish();
