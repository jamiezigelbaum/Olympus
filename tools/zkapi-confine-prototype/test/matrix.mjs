// PROTOTYPE test driver for the Linux confinement self-test matrix.
// Run on the target host:  bun matrix.mjs --launcher <path> [--ablate layer]
// It plays the supervisor: owns the session directory, the Tor relay, the host
// decoy listeners and the launcher process.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { unixFetch } = createRequire(import.meta.url)('./unix-fetch.cjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; };
const launcher = arg('launcher');
const ablate = arg('ablate', '');
const mode = arg('mode', 'full'); // full | quick
const abiCap = arg('abi', ''); // emulate an older Landlock ABI (prototype launcher only)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  const cb = () => resolve(server.address());
  if (typeof port === 'string') server.listen({ path: port }, cb); else server.listen({ port, host, exclusive: true }, cb);
});
const freePort = async () => { const s = net.createServer(); const a = await listen(s, 0, '127.0.0.1'); await new Promise((r) => s.close(r)); return a.port; };

// ------------------------------------------------------------------ host side
const hostServer = () => net.createServer((c) => { c.on('error', () => {}); c.end('HOST'); });
async function hostFixture(workDir, withSquatters) {
  const servers = [];
  const track = (s) => { servers.push(s); return s; };
  const t = {};
  t.tor = await freePort();
  t.companion = await freePort();
  t.wallet = await freePort();
  t.api = await freePort();
  t.bindOther = await freePort();
  // Host stand-in for Tor: answers a fixed prefix + what it was sent.
  const torHost = track(net.createServer((c) => { c.on('data', (d) => c.write('TOR-HOST:' + d)); c.on('error', () => {}); }));
  await listen(torHost, t.tor, '127.0.0.1');
  try { await listen(track(hostServer()), t.tor, '::1'); } catch {}
  // Squatters: host listeners on the session's own port numbers. Inside the
  // namespace these numbers must never reach them.
  if (withSquatters) {
    for (const p of [t.companion, t.wallet]) await listen(track(hostServer()), p, '127.0.0.1');
  }
  const other = track(hostServer());
  t.other = (await listen(other, 0, '127.0.0.1')).port;
  const alias = track(hostServer());
  t.alias = (await listen(alias, 0, '127.0.0.2')).port;
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (lan) {
    const s = track(hostServer());
    t.lan = { address: lan.address, port: (await listen(s, 0, lan.address)).port };
  }
  t.hostUnix = path.join(workDir, 'decoy.sock');
  await listen(track(hostServer()), t.hostUnix);
  t.hostAbstract = 'zkc-' + process.pid;
  try { await listen(track(hostServer()), '\0' + t.hostAbstract); } catch { t.abstractUnsupported = true; }
  t.hostNetNs = fs.readlinkSync('/proc/self/ns/net');
  t.hostUserNs = fs.readlinkSync('/proc/self/ns/user');
  t.launcher = launcher;
  return { t, servers };
}

// The supervisor-owned half of the Tor bridge: a Unix socket in the session
// directory relayed to the one real Tor port.
async function torRelay(workDir, torPort) {
  const sockets = new Set();
  const server = net.createServer((c) => {
    const up = net.connect({ host: '127.0.0.1', port: torPort });
    sockets.add(c); sockets.add(up);
    c.pipe(up); up.pipe(c);
    const end = () => { c.destroy(); up.destroy(); };
    c.on('error', end); up.on('error', end); c.on('close', end); up.on('close', end);
  });
  await listen(server, path.join(workDir, 'tor.sock'));
  return { close: () => { server.close(); for (const s of sockets) s.destroy(); } };
}

function apiGet(sock, urlPath, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, path: urlPath, method: 'GET', timeout }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// Descendants of a pid (pids are not namespaced; the whole tree is visible).
function processGroup(pgid) {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const st = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
      const f = st.slice(st.lastIndexOf(')') + 1).trim().split(/\s+/);
      if (Number(f[2]) === pgid && f[0] !== 'Z') out.push({ pid: Number(n), comm: st.slice(st.indexOf('(') + 1, st.lastIndexOf(')')) });
    } catch {}
  }
  return out;
}

async function launch({ t, workDir, extraEnv = {}, inherit = [], program, programArgs }) {
  const args = ['run', '--dir', workDir, '--expose', `api=${t.api}`, '--reach', `${t.tor}=tor`,
    ...[t.tor, t.companion, t.wallet, t.api].flatMap((p) => ['--connect-port', String(p)]),
    ...[t.companion, t.wallet, t.api].flatMap((p) => ['--bind-port', String(p)]),
    '--status-fd', '3', '--', program, ...programArgs];
  const child = spawn(launcher, args, { detached: true, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe', 'pipe', ...inherit] });
  const events = []; const out = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out.push(d); });
  // Launcher events arrive on the private status pipe (fd 3), never on the
  // stdout the daemon shares.
  child.stdio[3].setEncoding('utf8');
  child.stdio[3].on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.startsWith('zkapi-confine: ')) { try { events.push(JSON.parse(line.slice(15))); } catch {} }
    }
  });
  const stderr = []; child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => stderr.push(d));
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  return { child, events, stderr, exited, pgid: child.pid };
}

async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } return undefined; }

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
  bind_other_port: /^denied:/, bind_tor_port: /^denied:/, bind_ephemeral: /^denied:/, bind_all_interfaces: /^denied:/,
};
const outside = {
  net_ns_differs: 'no', user_ns_differs: 'no', no_new_privs: '0', seccomp_mode: '0',
  tor_bridge_echo: 'TOR-HOST:probe',
  companion_bind_connect: 'denied:EADDRINUSE', wallet_bind_connect: 'denied:EADDRINUSE',
  connect_other_port: 'connected', connect_loopback_alias: 'connected', connect_lan: 'connected',
  ipv6_loopback: 'connected', ipv4_mapped: 'connected', udp_remote: 'sent', udp_loopback: 'sent', udp_bind: 'bound',
  unix_host_path: 'connected', unix_host_abstract: 'connected',
  bind_other_port: 'bound', bind_tor_port: 'denied:EADDRINUSE', bind_ephemeral: 'bound', bind_all_interfaces: 'bound',
};
const goInside = {
  socket_inet_stream: 'ok', socket_inet6: 'EPERM', socket_inet_dgram: 'EPERM', socket_inet_raw: 'EPERM', socket_unix: 'EPERM',
  socket_unix_dgram: 'EPERM', socket_netlink_route: 'ok', socket_netlink_generic: 'EPERM', socket_packet: 'EPERM', socket_vsock: 'EPERM', socketpair_unix: 'ok',
  ptrace_attach_launcher: 'EPERM', ptrace_attach_stage0: 'EPERM', process_vm_readv_launcher: 'EPERM', io_uring_setup: 'EPERM',
  unshare_newuser: 'EPERM', unshare_newnet: 'EPERM', clone3: 'ENOSYS', clone_newuser_exec: /^(?!ok$)/, setns_net: 'EPERM',
  mount_tmpfs: 'EPERM', open_launcher_mem_rw: /^(EACCES|EPERM)$/, open_stage0_mem_rw: /^(EACCES|EPERM)$/, signal_launcher: 'EPERM', signal_stage0: 'EPERM',
};
const goOutside = { socket_inet6: 'ok', socket_inet_dgram: 'ok', socket_unix: 'ok', socket_netlink_generic: 'ok', clone_newuser_exec: 'ok' };
// Rows that exist only with a Landlock feature are required only where the kernel has it.
if (abiCap && Number(abiCap) < 6) { delete goInside.signal_launcher; delete goInside.signal_stage0; }
const matches = (want, got) => (want instanceof RegExp ? want.test(String(got)) : String(got) === String(want));

function evaluate(res, wantRows, wantGo, label, includeOutsideSockets) {
  const fails = [];
  for (const [k, w] of Object.entries(wantRows)) if (!matches(w, res[k])) fails.push(`${label}.${k}: want ${w} got ${res[k]}`);
  if (wantGo && res.__go) for (const [k, w] of Object.entries(wantGo)) if (!matches(w, res.__go[k])) fails.push(`${label}.go.${k}: want ${w} got ${res.__go[k]}`);
  if (includeOutsideSockets !== undefined && !(Number(res.inherited_decoy_fds) > 0)) fails.push(`${label}.inherited_decoy_fds: want >0 got ${res.inherited_decoy_fds}`);
  return fails;
}

async function bulkEcho(sock) {
  const crypto = await import('node:crypto');
  const data = crypto.randomBytes(4 * 1024 * 1024);
  return new Promise((resolve) => {
    const req = http.request({ socketPath: sock, path: '/echo', method: 'POST', timeout: 20000 }, (res) => {
      const h = crypto.createHash('sha256'); let n = 0;
      res.on('data', (d) => { h.update(d); n += d.length; });
      res.on('end', () => resolve(h.digest('hex') === crypto.createHash('sha256').update(data).digest('hex') && n === data.length ? 'intact' : 'corrupt'));
    });
    req.on('error', () => resolve('error')); req.end(data);
  });
}

async function adapterChecks(sock) {
  const f = unixFetch(sock);
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

// -------------------------------------------------------------------- scenarios
async function session({ ablation = '', withProbe = true, label }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-'));
  fs.chmodSync(workDir, 0o700);
  const { t, servers } = await hostFixture(workDir, true);
  const relay = await torRelay(workDir, t.tor);
  // Inherited-descriptor decoys: a connected host Unix socket and a connected
  // host TCP socket left open for the launcher to inherit.
  const dUnix = net.connect({ path: t.hostUnix }); const dTcp = net.connect({ host: '127.0.0.1', port: t.other }); dUnix.on('error', () => {}); dTcp.on('error', () => {});
  await Promise.all([new Promise((r) => dUnix.once('connect', r)), new Promise((r) => dTcp.once('connect', r))]);
  const inherit = [dUnix, dTcp].map((s) => s._handle.fd);
  t.decoyInodes = inherit.map((fd) => fs.readlinkSync('/proc/self/fd/' + fd));
  const run = await launch({ t, workDir, extraEnv: { ...(ablation ? { ZKAPI_CONFINE_PROTOTYPE_ABLATE: ablation } : {}), ...(abiCap ? { ZKAPI_CONFINE_PROTOTYPE_ABI: abiCap } : {}) }, inherit,
    program: process.execPath, programArgs: [path.join(here, 'standin-daemon.cjs'), JSON.stringify(t)] });
  const cleanup = async () => {
    try { process.kill(-run.pgid, 'SIGKILL'); } catch {}
    relay.close(); dUnix.destroy(); dTcp.destroy(); for (const s of servers) s.close();
    await sleep(100); fs.rmSync(workDir, { recursive: true, force: true });
  };
  return { t, workDir, run, relay, servers, cleanup, label };
}

async function insideRows(s) {
  const sock = path.join(s.workDir, 'api.sock');
  const ready = await waitFor(() => s.run.events.find((e) => e.event === 'ready' || e.event === 'refused'), 8000);
  if (!ready || ready.event === 'refused') return { refused: ready || { code: 'no_ready_event' } };
  const health = await waitFor(async () => { try { return await apiGet(sock, '/healthz', 2000); } catch { return undefined; } }, 8000);
  if (!health) return { ready, noHealth: true };
  const probe = await apiGet(sock, '/probe');
  probe.bulk = await bulkEcho(sock);
  probe.adapter = await adapterChecks(sock);
  if (probe.error) return { ready, health, probeError: probe.error };
  return { ready, health, probe };
}

function flatten(role, r) { const o = { ...r.parent }; o.__go = r.go; return role === 'child' ? { ...r.child, __go: r.go } : o; }

const report = { host: {}, scenarios: {} };
const lines = [];
const log = (s = '') => { lines.push(s); console.log(s); };

// ---- 0. host facts
report.host = {
  kernel: execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim(),
  runtime: typeof Bun !== 'undefined' ? 'bun ' + Bun.version : 'node ' + process.version,
  landlockAbi: execFileSync(launcher, ['check'], { encoding: 'utf8', env: { ...process.env, ...(abiCap ? { ZKAPI_CONFINE_PROTOTYPE_ABI: abiCap } : {}) } }).trim(),
};
log('host: ' + JSON.stringify(report.host));

// ---- 1. control: the same probe, no confinement
{
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-')); fs.chmodSync(workDir, 0o700);
  const { t, servers } = await hostFixture(workDir, true);
  const dUnix = net.connect({ path: t.hostUnix }); const dTcp = net.connect({ host: '127.0.0.1', port: t.other }); dUnix.on('error', () => {}); dTcp.on('error', () => {});
  await Promise.all([new Promise((r) => dUnix.once('connect', r)), new Promise((r) => dTcp.once('connect', r))]);
  const inherit = [dUnix, dTcp].map((s) => s._handle.fd);
  t.decoyInodes = inherit.map((fd) => fs.readlinkSync('/proc/self/fd/' + fd));
  const child = spawn(process.execPath, [path.join(here, 'standin-daemon.cjs'), JSON.stringify(t)], { stdio: ['ignore', 'pipe', 'pipe', ...inherit], detached: true });
  const r = await waitFor(async () => { try { const hs = `http://127.0.0.1:${t.api}`; const h = await fetch(hs + '/healthz'); if (h.ok) return await (await fetch(hs + '/probe')).json(); } catch {} }, 15000);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  dUnix.destroy(); dTcp.destroy(); for (const s of servers) s.close(); fs.rmSync(workDir, { recursive: true, force: true });
  if (!r || r.error) { log('control probe failed: ' + JSON.stringify(r)); process.exit(3); }
  const parent = { ...r.parent, __go: r.go }; const kid = { ...r.child, __go: r.go };
  const fails = [...evaluate(parent, outside, goOutside, 'control.parent', true), ...evaluate(kid, outside, goOutside, 'control.child')];
  report.scenarios.control = { parent: r.parent, child: r.child, go: r.go, failures: fails };
  log(`\n[control: no confinement] expectation violations: ${fails.length}`); for (const f of fails) log('  ' + f);
}

// ---- 2. confined: the matrix
const startedAt = Date.now();
const base = await session({ label: 'confined' });
const baseRows = await insideRows(base);
const timing = { sessionUpToProbeMs: Date.now() - startedAt };
if (baseRows.refused || baseRows.noHealth || baseRows.probeError) { log('CONFINED SESSION DID NOT START: ' + JSON.stringify(baseRows)); await base.cleanup(); process.exit(2); }
{
  const parent = flatten('parent', baseRows.probe); const kid = flatten('child', baseRows.probe);
  const fails = [...evaluate(parent, inside, goInside, 'confined.parent'), ...evaluate(kid, inside, null, 'confined.child')];
  if (baseRows.probe.bulk !== 'intact') fails.push('confined.api_bridge_bulk: want intact got ' + baseRows.probe.bulk);
  report.scenarios.confined = { ready: baseRows.ready, health: baseRows.health, parent: baseRows.probe.parent, child: baseRows.probe.child, go: baseRows.probe.go, failures: fails };
  log(`\n[confined] ready event: ${JSON.stringify(baseRows.ready)}`);
  log(`[confined] self-test rows (parent | exec'd child) and outside control:`);
  const ctrl = report.scenarios.control;
  const keys = Object.keys(inside);
  for (const k of keys) log(`  ${k.padEnd(24)} outside=${String(ctrl.parent[k]).padEnd(20)} parent=${String(parent[k]).padEnd(20)} child=${String(kid[k])}`);
  log('  -- exec\'d Go child (raw syscalls), launcher protection --');
  for (const k of Object.keys(goInside)) log(`  ${k.padEnd(28)} outside=${String(ctrl.go[k]).padEnd(8)} confined=${String(baseRows.probe.go[k])}`);
  log(`  fetch adapter over the bridge: ${JSON.stringify(baseRows.probe.adapter)}`);
  log(`  api bridge, 4 MiB POST echoed host->namespace->host: ${baseRows.probe.bulk}`);
  log(`[confined] expectation violations: ${fails.length}`); for (const f of fails) log('  ' + f);
}

// ---- 3. bridge, ownership and process-tree facts (design: inspection under a netns)
{
  const ready = baseRows.ready;
  const daemonPid = ready.daemonPid;
  const facts = {};
  facts.processGroup = processGroup(base.run.pgid).map((p) => `${p.comm}`);
  const hostTcp = fs.readFileSync('/proc/net/tcp', 'utf8');
  const hexApi = base.t.api.toString(16).toUpperCase().padStart(4, '0');
  facts.hostProcNetTcpListsApiPort = hostTcp.split('\n').some((l) => l.includes(`:${hexApi} `) && l.includes(' 0A '));
  let nsTcp = ''; try { nsTcp = fs.readFileSync(`/proc/${daemonPid}/net/tcp`, 'utf8'); } catch (e) { nsTcp = 'ERR ' + e.code; }
  const listeners = nsTcp.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f[3] === '0A').map((f) => ({ port: parseInt(f[1].split(':')[1], 16), inode: f[9] }));
  facts.nsListeners = listeners.map((l) => l.port);
  // Attribute each in-namespace listener to a process of the launched group, as
  // the existing listener inspection does, but reading the namespace's table.
  const owners = {};
  for (const l of listeners) {
    for (const p of processGroup(base.run.pgid)) {
      try { for (const fd of fs.readdirSync(`/proc/${p.pid}/fd`)) { if (fs.readlinkSync(`/proc/${p.pid}/fd/${fd}`) === `socket:[${l.inode}]`) owners[l.port] = `${p.comm}(pgid ${base.run.pgid})`; } } catch (e) { owners[l.port] = owners[l.port] || `unreadable:${e.code}`; }
    }
  }
  facts.listenerOwners = owners;
  facts.expected = { api: base.t.api, tor: base.t.tor };
  const apiPath = path.join(base.workDir, 'api.sock');
  facts.hostProcNetUnixListsApiSock = fs.readFileSync('/proc/net/unix', 'utf8').includes(apiPath);
  facts.launcherProcNetUnixListsApiSock = fs.readFileSync(`/proc/${ready.launcherPid}/net/unix`, 'utf8').split('\n').some((l) => l.endsWith(apiPath) && l.split(/\s+/)[5] === '01');
  facts.apiSockOwnerUidIsOurs = fs.statSync(apiPath).uid === process.getuid();
  facts.procOwnerUid = { launcher: fs.statSync(`/proc/${ready.launcherPid}`).uid, daemon: fs.statSync(`/proc/${ready.daemonPid}`).uid, us: process.getuid() };
  facts.apiSockMode = (fs.statSync(apiPath).mode & 0o777).toString(8);
  for (const [name, pid] of [['launcher', ready.launcherPid], ['daemon', ready.daemonPid]]) {
    const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    facts[name] = { pid, pgid: Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[2]), NoNewPrivs: /NoNewPrivs:\s*(\d)/.exec(st)[1], Seccomp: /Seccomp:\s*(\d)/.exec(st)[1], CapEff: /CapEff:\s*(\w+)/.exec(st)[1], procFdReadableBySupervisor: (() => { try { fs.readdirSync(`/proc/${pid}/fd`); return true; } catch (e) { return e.code; } })(), netTcpReadableBySupervisor: (() => { try { fs.readFileSync(`/proc/${pid}/net/tcp`); return true; } catch (e) { return e.code; } })() };
  }
  report.scenarios.inspection = facts;
  log('\n[inspection/ownership under the namespace]\n' + JSON.stringify(facts, null, 2));
}

// ---- 3a. cost of the bridge and of the launcher
{
  const sock = path.join(base.workDir, 'api.sock');
  const t0 = Date.now(); const n = 50;
  for (let i = 0; i < n; i++) await apiGet(sock, '/healthz');
  timing.apiBridgeRoundTripMs = Number(((Date.now() - t0) / n).toFixed(2));
  const direct = []; // launcher cost: stage0 -> ready event for a no-op program
  for (let i = 0; i < 5; i++) {
    const s = Date.now();
    await new Promise((resolve) => { const c = spawn(launcher, ['run', '--connect-port', '1', '--', launcher, 'noop'], { stdio: ['ignore', 'ignore', 'ignore'] }); c.on('exit', resolve); });
    direct.push(Date.now() - s);
  }
  timing.launcherStartToExitMs = direct;
  report.scenarios.timing = timing;
  log('\n[timing] ' + JSON.stringify(timing));
}

// ---- 3b. a Go stand-in (the real daemon is a Go program)
if (arg('gostandin')) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-')); fs.chmodSync(workDir, 0o700);
  const { t, servers } = await hostFixture(workDir, true);
  const relay = await torRelay(workDir, t.tor);
  const run = await launch({ t, workDir, program: arg('gostandin'), programArgs: [String(t.api), String(t.tor), String(t.other)] });
  const sock = path.join(workDir, 'api.sock');
  const health = await waitFor(async () => { try { return await apiGet(sock, '/healthz', 2000); } catch { return undefined; } }, 8000);
  const rows = health ? await apiGet(sock, '/go-probe') : { error: 'no health' };
  const want = { tor_bridge_echo: 'TOR-HOST:probe', connect_other_port: 'failed_fast', connect_remote_testnet: 'failed_fast', ipv6_loopback: 'failed_fast', udp_dial: 'failed_fast', bind_other_port: 'denied', bind_ipv6: 'denied', dns_lookup: 'failed' };
  const fails = Object.entries(want).filter(([k, w]) => rows[k] !== w).map(([k, w]) => `go-standin.${k}: want ${w} got ${rows[k]}`);
  report.scenarios.goStandin = { rows, failures: fails };
  log('\n[go stand-in daemon (net/http server, Go dialers) under the same confinement]\n' + JSON.stringify(rows) + `\n  violations: ${fails.length}`); for (const f of fails) log('  ' + f);
  try { process.kill(-run.pgid, 'SIGKILL'); } catch {}
  relay.close(); for (const s of servers) s.close(); fs.rmSync(workDir, { recursive: true, force: true });
}

// ---- 4. fault injection on the live session
{
  const faults = {};
  // 4a. Tor-side bridge failure: supervisor relay gone => connection through the bridge closes fast.
  base.relay.close();
  await sleep(100);
  faults.torRelayDown = (await apiGet(path.join(base.workDir, 'api.sock'), '/tor-connect')).result;
  // 4b. daemon dies => launcher exits with its status; bridges gone.
  const pgidMembersBefore = processGroup(base.run.pgid).length;
  process.kill(base.run.events.find((e) => e.event === 'ready').daemonPid, 'SIGKILL');
  const exit = await Promise.race([base.run.exited, sleep(5000).then(() => 'hung')]);
  await sleep(200);
  faults.daemonKilled = { launcherExit: exit, membersBefore: pgidMembersBefore, membersAfter: processGroup(base.run.pgid).length };
  let apiAfter = 'connected';
  await new Promise((resolve) => { const c = net.connect({ path: path.join(base.workDir, 'api.sock') }); c.on('connect', () => { c.destroy(); resolve(); }); c.on('error', (e) => { apiAfter = e.code; resolve(); }); });
  faults.apiSocketAfterDaemonKilled = apiAfter;
  report.scenarios.faults = faults;
  await base.cleanup();
  // 4c. kill -9 the host-side stage0: the namespaced tree must die with it.
  const s2 = await session({ label: 'kill-stage0' });
  const r2 = await insideRows(s2);
  const before = processGroup(s2.run.pgid).map((p) => p.comm);
  process.kill(s2.run.child.pid, 'SIGKILL');
  await sleep(500);
  faults.stage0Killed = { before, afterMembers: processGroup(s2.run.pgid).map((p) => p.comm), stragglerPids: [r2.ready.launcherPid, r2.ready.daemonPid].filter((pid) => fs.existsSync(`/proc/${pid}`)) };
  await s2.cleanup();
  // 4d. kill -9 the in-namespace launcher (stage1): daemon and host side die.
  const s3 = await session({ label: 'kill-stage1' });
  const r3 = await insideRows(s3);
  process.kill(r3.ready.launcherPid, 'SIGKILL');
  const exit3 = await Promise.race([s3.run.exited, sleep(5000).then(() => 'hung')]);
  await sleep(300);
  faults.stage1Killed = { stage0Exit: exit3, daemonAlive: fs.existsSync(`/proc/${r3.ready.daemonPid}`) && !/State:\s*Z/.test(fs.readFileSync(`/proc/${r3.ready.daemonPid}/status`, 'utf8')), groupAfter: processGroup(s3.run.pgid).map((p) => p.comm) };
  await s3.cleanup();
  report.scenarios.faults = faults;
  log('\n[fault injection]\n' + JSON.stringify(faults, null, 2));
}

// ---- 5. refusal cases
{
  const refusals = {};
  // a session directory with the wrong mode is refused before anything starts
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-bad-')); fs.chmodSync(bad, 0o755);
  const r = spawn(launcher, ['run', '--dir', bad, '--expose', 'api=1', '--', process.execPath, '-e', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; r.stdout.on('data', (d) => { out += d; }); let err = ''; r.stderr.on('data', (d) => { err += d; });
  refusals.badDirMode = { exit: (await new Promise((res) => r.on('exit', res))), stderr: err.trim(), stdout: out.trim() };
  fs.rmSync(bad, { recursive: true, force: true });
  // the check command itself, run from inside a confined process (nested
  // namespace creation is refused there), reproduces the refusal path.
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-nest-')); fs.chmodSync(wd, 0o700);
  const nested = await new Promise((resolve) => {
    const c = spawn(launcher, ['run', '--connect-port', '1', '--', launcher, 'check'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('exit', (code) => resolve({ code, out: o.split('\n').filter((l) => l && !l.startsWith('zkapi-confine:')) }));
  });
  refusals.checkInsideConfinement = nested; fs.rmSync(wd, { recursive: true, force: true });
  report.scenarios.refusals = refusals;
  log('\n[refusal]\n' + JSON.stringify(refusals, null, 2));
}

// ---- 6. ablations: what each layer is for
if (mode === 'full') {
  const ablations = {};
  for (const layer of ['netns', 'landlock-net', 'landlock-unix', 'landlock-scope', 'seccomp', 'caps', 'dumpable']) {
    const s = await session({ ablation: layer, label: 'ablate-' + layer });
    const rows = await insideRows(s);
    if (rows.refused || rows.noHealth) { ablations[layer] = { refused: rows.refused || 'no health' }; await s.cleanup(); continue; }
    const parent = flatten('parent', rows.probe);
    const fails = [...evaluate(parent, inside, goInside, 'a'), ...evaluate(flatten('child', rows.probe), inside, null, 'a.child')];
    ablations[layer] = { failingRows: fails.map((f) => f.replace(/^a(\.child)?\./, (m) => (m === 'a.' ? '' : 'child.')).split(':')[0]) };
    await s.cleanup();
  }
  report.scenarios.ablations = ablations;
  log('\n[ablations: rows that FAIL when one layer is switched off]\n' + JSON.stringify(ablations, null, 2));
}


log(`\nRESULT: confined matrix ${report.scenarios.confined.failures.length === 0 ? 'PASS' : 'FAIL'} (${report.scenarios.confined.failures.length} violations); control (unconfined) ${report.scenarios.control.failures.length === 0 ? 'behaves as expected' : 'UNEXPECTED: ' + report.scenarios.control.failures.length}`);
fs.writeFileSync(arg('out', 'matrix-result.json'), JSON.stringify(report, null, 2));
process.exit(report.scenarios.confined.failures.length === 0 && !(report.scenarios.goStandin?.failures.length) ? 0 : 1);
