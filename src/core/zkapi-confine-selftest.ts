import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { ZkapiConfinementPorts } from './consult-transport-zkapi.ts';

type SelfTestSupervisor = typeof import('./consult-transport-zkapi.ts')['supervise'];
type SelfTestHelper = ReturnType<SelfTestSupervisor>;

type ProbeRows = Record<string, unknown>;
type StatusObservation = {
  event: string;
  code?: string;
  landlockAbi?: number;
  layers?: string[];
  stage0Layers?: string[];
  bridgesExpose?: string[];
  bridgesReach?: string[];
};

export interface LinuxConfinementSelfTestSide {
  daemonApiListener?: string;
  parent: ProbeRows;
  child: ProbeRows;
  go: ProbeRows;
  unixStreamConnections: number;
  unixDatagrams: number;
  apiBridgeBulk?: string;
  status?: StatusObservation;
  instanceBound?: boolean;
  listenerSetBound?: boolean;
}

export interface LinuxConfinementSelfTestObservation {
  control?: LinuxConfinementSelfTestSide;
  confined?: LinuxConfinementSelfTestSide;
}

export interface LinuxConfinementSelfTestRunner {
  run(
    launcher: string,
    workDir: string,
    env: NodeJS.ProcessEnv,
    ports: ZkapiConfinementPorts,
  ): Promise<LinuxConfinementSelfTestObservation>;
}

const JS_ROWS = [
  'inherited_decoy_fds', 'caps', 'no_new_privs', 'seccomp_mode', 'net_ns_differs', 'user_ns_differs', 'interfaces',
  'tor_bridge_echo', 'tor_bridge_bulk', 'companion_bind_connect', 'wallet_bind_connect', 'connect_other_port',
  'connect_loopback_alias', 'connect_lan', 'connect_remote_testnet', 'ipv6_loopback', 'ipv4_mapped', 'udp_remote',
  'udp_loopback', 'udp_bind', 'dns_stub_tcp', 'dns_lookup', 'unix_host_path', 'unix_host_abstract', 'bind_other_port',
  'bind_tor_port', 'bind_ephemeral', 'bind_wildcard_forbidden_port', 'bind_wildcard_permitted_port',
] as const;

const GO_ROWS = [
  'socket_inet_stream', 'socket_inet6', 'socket_inet_dgram', 'socket_inet_raw', 'socket_unix', 'socket_unix_dgram',
  'socket_netlink_route', 'socket_netlink_generic', 'socket_packet', 'socket_vsock', 'socketpair_unix_stream',
  'socketpair_unix_dgram', 'socketpair_unix_seqpacket', 'pair_stream_connect_host_path',
  'pair_stream_sendto_host_path', 'pair_stream_connect_after_shutdown', 'pair_dgram_connect_host_path',
  'pair_dgram_sendto_host_path', 'inet_connect_unix_addr', 'listen_unbound', 'ptrace_attach_launcher',
  'ptrace_attach_stage0', 'ptrace_attach_ns_init', 'process_vm_readv_launcher', 'io_uring_setup', 'unshare_newuser',
  'unshare_newnet', 'unshare_newpid', 'clone3', 'clone_newuser_exec', 'clone_newpid_exec', 'setns_net', 'mount_tmpfs',
  'open_launcher_mem_rw', 'open_stage0_mem_rw', 'signal_launcher', 'signal_stage0', 'signal_ns_init_sigkill',
  'ns_init_alive_after',
] as const;

const INSIDE: Readonly<Record<string, string | RegExp>> = {
  inherited_decoy_fds: '0', caps: 'zero', no_new_privs: '1', seccomp_mode: '2', net_ns_differs: 'yes',
  user_ns_differs: 'yes', interfaces: 'lo', tor_bridge_echo: 'TOR-HOST:probe', tor_bridge_bulk: 'intact',
  companion_bind_connect: 'bound_connected_ns', wallet_bind_connect: 'bound_connected_ns',
  connect_other_port: 'failed_fast', connect_loopback_alias: 'failed_fast', connect_remote_testnet: 'failed_fast',
  ipv6_loopback: 'failed_fast', ipv4_mapped: 'failed_fast', udp_remote: 'failed', udp_loopback: 'failed',
  udp_bind: 'failed', dns_stub_tcp: 'failed_fast', dns_lookup: 'failed_fast', unix_host_path: 'failed_fast',
  unix_host_abstract: 'failed_fast', bind_other_port: /^denied:/, bind_tor_port: /^denied:/,
  bind_ephemeral: /^denied:/, bind_wildcard_forbidden_port: /^denied:/, bind_wildcard_permitted_port: 'bound',
};

const OUTSIDE: Readonly<Record<string, string | RegExp>> = {
  no_new_privs: '0', seccomp_mode: '0', net_ns_differs: 'no', user_ns_differs: 'no',
  tor_bridge_echo: 'TOR-HOST:probe', tor_bridge_bulk: 'intact', companion_bind_connect: 'denied:EADDRINUSE',
  wallet_bind_connect: 'denied:EADDRINUSE', connect_other_port: 'connected', connect_loopback_alias: 'connected',
  connect_remote_testnet: /^(timeout|failed_slow)$/, ipv6_loopback: 'connected', ipv4_mapped: 'connected',
  udp_remote: 'sent', udp_loopback: 'sent', udp_bind: 'bound', dns_stub_tcp: 'connected', dns_lookup: 'resolved',
  unix_host_path: 'connected', unix_host_abstract: 'connected', bind_other_port: 'bound',
  bind_tor_port: 'denied:EADDRINUSE', bind_ephemeral: 'bound', bind_wildcard_forbidden_port: 'bound',
  bind_wildcard_permitted_port: 'denied:EADDRINUSE',
};

const GO_INSIDE: Readonly<Record<string, string | RegExp>> = {
  socket_inet_stream: 'ok', socket_inet6: 'EPERM', socket_inet_dgram: 'EPERM', socket_inet_raw: 'EPERM',
  socket_unix: 'EPERM', socket_unix_dgram: 'EPERM', socket_netlink_route: 'ok', socket_netlink_generic: 'EPERM',
  socket_packet: 'EPERM', socket_vsock: 'EPERM', socketpair_unix_stream: 'ok', socketpair_unix_dgram: 'EPERM',
  socketpair_unix_seqpacket: 'EPERM', pair_stream_connect_host_path: /^(EISCONN|EACCES)$/,
  pair_stream_sendto_host_path: /^(EISCONN|EACCES)$/, pair_stream_connect_after_shutdown: /^(?!ok$).+/,
  pair_dgram_connect_host_path: 'no_socket', pair_dgram_sendto_host_path: 'no_socket',
  inet_connect_unix_addr: /^(EAFNOSUPPORT|EINVAL)$/, listen_unbound: /^listening:\d+$/,
  ptrace_attach_launcher: 'EPERM', ptrace_attach_stage0: 'EPERM', ptrace_attach_ns_init: 'EPERM',
  process_vm_readv_launcher: 'EPERM', io_uring_setup: 'EPERM', unshare_newuser: 'EPERM', unshare_newnet: 'EPERM',
  unshare_newpid: 'EPERM', clone3: 'ENOSYS', clone_newuser_exec: /^(?!ok$).+/, clone_newpid_exec: /^(?!ok$).+/,
  setns_net: 'EPERM', mount_tmpfs: 'EPERM', open_launcher_mem_rw: /^(EACCES|EPERM)$/,
  open_stage0_mem_rw: /^(EACCES|EPERM)$/, signal_launcher: /^(ESRCH|EPERM)$/,
  signal_stage0: /^(ESRCH|EPERM)$/, signal_ns_init_sigkill: /^(ok|EPERM)$/, ns_init_alive_after: 'yes',
};

const GO_OUTSIDE: Readonly<Record<string, string | RegExp>> = {
  socket_inet6: 'ok', socket_inet_dgram: 'ok', socket_unix: 'ok', socket_unix_dgram: 'ok',
  socketpair_unix_stream: 'ok', socketpair_unix_dgram: 'ok', socketpair_unix_seqpacket: 'ok',
  pair_stream_connect_host_path: 'EISCONN', pair_dgram_connect_host_path: 'ok', pair_dgram_sendto_host_path: 'ok',
  listen_unbound: /^listening:\d+$/,
};

function hasEvery(row: ProbeRows | undefined, keys: readonly string[]): row is ProbeRows {
  return Boolean(row) && keys.every((key) => Object.hasOwn(row!, key));
}

function matches(got: unknown, wanted: string | RegExp): boolean {
  return got !== undefined && (wanted instanceof RegExp ? wanted.test(String(got)) : String(got) === wanted);
}

function matchesExpected(rows: ProbeRows, expected: Readonly<Record<string, string | RegExp>>): boolean {
  return Object.entries(expected).every(([key, wanted]) => matches(rows[key], wanted));
}

function validReady(status: StatusObservation | undefined): boolean {
  if (!status || status.event !== 'ready') return false;
  const abi = status.landlockAbi;
  if (typeof abi !== 'number' || !Number.isInteger(abi) || abi < 4) return false;
  const required = ['netns', 'pidns', 'ipv6-off', 'caps', 'nnp', 'launcher-undumpable', 'launcher-seccomp', 'landlock-net', 'seccomp'];
  if (abi >= 6) required.push('landlock-scope');
  if (abi >= 8) required.push('launcher-landlock');
  if (abi >= 9) required.push('landlock-unix');
  const stage0 = ['nnp', 'launcher-undumpable', 'launcher-seccomp', ...(abi >= 8 ? ['launcher-landlock'] : [])];
  return Array.isArray(status.layers) && required.every((layer) => status.layers!.includes(layer))
    && Array.isArray(status.stage0Layers) && stage0.every((layer) => status.stage0Layers!.includes(layer))
    && JSON.stringify(status.bridgesExpose) === '["api"]'
    && Array.isArray(status.bridgesReach) && status.bridgesReach.length === 1 && /^\d+$/.test(status.bridgesReach[0]!);
}

/** Pure, fail-closed matrix evaluation used by the injected and real runners. */
export function evaluateLinuxConfinementSelfTestObservation(observation: LinuxConfinementSelfTestObservation): boolean {
  const control = observation.control;
  const confined = observation.confined;
  if (!control || !confined || control.daemonApiListener !== 'listening' || confined.daemonApiListener !== 'listening') return false;
  if (!hasEvery(control.parent, JS_ROWS) || !hasEvery(control.child, JS_ROWS)
    || !hasEvery(confined.parent, JS_ROWS) || !hasEvery(confined.child, JS_ROWS)
    || !hasEvery(control.go, GO_ROWS) || !hasEvery(confined.go, GO_ROWS)) return false;
  if (!matchesExpected(control.parent, OUTSIDE) || !matchesExpected(control.child, OUTSIDE)
    || !matchesExpected(confined.parent, INSIDE) || !matchesExpected(confined.child, INSIDE)
    || !matchesExpected(control.go, GO_OUTSIDE) || !matchesExpected(confined.go, GO_INSIDE)) return false;
  if (Number(control.parent.inherited_decoy_fds) < 2 || control.child.inherited_decoy_fds !== '0') return false;
  if (control.parent.connect_lan === 'no_interface' || control.child.connect_lan === 'no_interface') {
    if (control.parent.connect_lan !== 'no_interface' || control.child.connect_lan !== 'no_interface'
      || confined.parent.connect_lan !== 'no_interface' || confined.child.connect_lan !== 'no_interface') return false;
  } else if (control.parent.connect_lan !== 'connected' || control.child.connect_lan !== 'connected'
    || confined.parent.connect_lan !== 'failed_fast' || confined.child.connect_lan !== 'failed_fast') return false;
  if (confined.parent.tor_bridge_removed !== 'closed_fast') return false;
  if (confined.apiBridgeBulk !== 'intact') return false;
  if (control.unixStreamConnections < 1 || control.unixDatagrams < 1
    || confined.unixStreamConnections !== 0 || confined.unixDatagrams !== 0) return false;
  return validReady(confined.status) && confined.instanceBound === true && confined.listenerSetBound === true;
}

export async function runLinuxConfinementSelfTestWithRunner(
  launcher: string,
  workDir: string,
  env: NodeJS.ProcessEnv,
  ports: ZkapiConfinementPorts,
  runner: LinuxConfinementSelfTestRunner,
): Promise<boolean> {
  try {
    const values = [ports.tor, ports.daemon, ports.companionProxy, ports.walletApi];
    if (!launcher || values.some((port) => !Number.isInteger(port) || port! < 1 || port! > 65535)
      || new Set(values).size !== 4) return false;
    return evaluateLinuxConfinementSelfTestObservation(await runner.run(launcher, workDir, env, ports));
  } catch {
    return false;
  }
}

export const LINUX_CONFINEMENT_SELF_TEST_PROBE_SOURCE = String.raw`
'use strict';
const net = require('node:net');
const dgram = require('node:dgram');
const dns = require('node:dns');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const FAST_MS = 1000;

if (process.argv[2] === '--dgram-decoy') {
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi');
    const libc = dlopen('libc.so.6', {
      socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    });
    const pathname = process.argv[3];
    if (Buffer.byteLength(pathname) > 107) process.exit(1);
    try { fs.unlinkSync(pathname); } catch {}
    const fd = libc.symbols.socket(1, 2, 0);
    const address = Buffer.alloc(110); address.writeUInt16LE(1, 0); address.write(pathname, 2, 107, 'utf8');
    const length = 2 + Buffer.byteLength(pathname) + 1;
    if (fd < 0 || libc.symbols.bind(fd, ptr(address), length) !== 0) process.exit(1);
    fs.writeSync(1, 'ready\n');
    const buffer = Buffer.alloc(2048);
    while (true) {
      const n = libc.symbols.recv(fd, ptr(buffer), buffer.length, 0);
      if (n <= 0) process.exit(1);
      fs.writeSync(1, 'datagram\n');
    }
  } catch { process.exit(1); }
  return;
}

const tcp = (opts, echo) => new Promise((resolve) => {
  const started = Date.now(); const socket = net.createConnection(opts); let done = false;
  const finish = (value) => { if (!done) { done = true; socket.destroy(); resolve(value); } };
  socket.setTimeout(3000, () => finish('timeout'));
  socket.once('connect', () => { if (echo === undefined) finish('connected'); else socket.write(echo); });
  socket.once('data', (data) => finish(String(data)));
  socket.once('close', () => finish(Date.now() - started < FAST_MS ? 'closed_fast' : 'closed_slow'));
  socket.once('error', () => finish(Date.now() - started < FAST_MS ? 'failed_fast' : 'failed_slow'));
});
const bulk = (host, port) => new Promise((resolve) => {
  const payload = Buffer.alloc(4 * 1024 * 1024, 90); let received = 0; let valid = true; const socket = net.createConnection({ host, port });
  const timer = setTimeout(() => { socket.destroy(); resolve('timeout'); }, 8000);
  socket.on('connect', () => socket.write(payload));
  socket.on('data', (chunk) => { for (const byte of chunk) if (byte !== 90) valid = false; received += chunk.length; if (received >= payload.length) { clearTimeout(timer); socket.destroy(); resolve(valid && received === payload.length ? 'intact' : 'corrupt'); } });
  socket.on('error', () => { clearTimeout(timer); resolve('error'); });
});
const udp = (host, port) => new Promise((resolve) => {
  let socket; try { socket = dgram.createSocket('udp4'); } catch { resolve('failed'); return; }
  const done = (value) => { try { socket.close(); } catch {} resolve(value); };
  socket.once('error', () => done('failed')); socket.send(Buffer.from([0]), port, host, (error) => done(error ? 'failed' : 'sent'));
});
const udpBind = () => new Promise((resolve) => {
  let socket; try { socket = dgram.createSocket('udp4'); } catch { resolve('failed'); return; }
  socket.once('error', () => { try { socket.close(); } catch {} resolve('failed'); });
  socket.bind(0, '127.0.0.1', () => { socket.close(); resolve('bound'); });
});
const listenTry = (port, host) => new Promise((resolve) => {
  const server = net.createServer((socket) => socket.end('NS'));
  server.once('error', (error) => resolve({ result: 'denied:' + (error.code || 'err') }));
  server.listen({ port, host: host || '127.0.0.1', exclusive: true }, () => resolve({ result: 'bound', server }));
});
const bindAndConnect = async (port) => { const item = await listenTry(port); if (!item.server) return item.result; const seen = await tcp({ host: '127.0.0.1', port }, 'x'); await new Promise((r) => item.server.close(r)); return seen === 'NS' ? 'bound_connected_ns' : 'bound_other:' + seen; };
const bindRow = async (port, host) => { const item = await listenTry(port, host); if (item.server) await new Promise((r) => item.server.close(r)); return item.result; };
const lookup = (target) => new Promise((resolve) => {
  const started = Date.now(); const resolver = new dns.Resolver(); resolver.setServers(['127.0.0.53:' + target.dnsPort]);
  const timer = setTimeout(() => resolve('timeout'), 4000);
  resolver.resolve4('selftest.invalid', (error) => { clearTimeout(timer); resolve(!error ? 'resolved' : (Date.now() - started < 2000 ? 'failed_fast' : 'failed_slow')); });
});
const status = (key) => { const match = new RegExp('^' + key + ':\\s*(.*)$', 'm').exec(fs.readFileSync('/proc/self/status', 'utf8')); return match ? match[1].trim() : ''; };
const decoyFds = (target) => { let count = 0; for (const fd of fs.readdirSync('/proc/self/fd')) { try { if ((target.decoyInodes || []).includes(fs.readlinkSync('/proc/self/fd/' + fd))) count += 1; } catch {} } return count; };
async function run(target) {
  const result = {};
  result.inherited_decoy_fds = String(decoyFds(target));
  result.caps = ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map((key) => /^0+$/.test(status(key))).every(Boolean) ? 'zero' : 'nonzero';
  result.no_new_privs = status('NoNewPrivs'); result.seccomp_mode = status('Seccomp');
  result.net_ns_differs = fs.readlinkSync('/proc/self/ns/net') !== target.hostNetNs ? 'yes' : 'no';
  result.user_ns_differs = fs.readlinkSync('/proc/self/ns/user') !== target.hostUserNs ? 'yes' : 'no';
  result.interfaces = Object.keys(os.networkInterfaces()).join(',');
  result.tor_bridge_echo = await tcp({ host: '127.0.0.1', port: target.tor }, 'probe');
  result.tor_bridge_bulk = await bulk('127.0.0.1', target.tor);
  result.companion_bind_connect = await bindAndConnect(target.companion);
  result.wallet_bind_connect = await bindAndConnect(target.wallet);
  result.connect_other_port = await tcp({ host: '127.0.0.1', port: target.other });
  result.connect_loopback_alias = await tcp({ host: '127.0.0.2', port: target.alias });
  result.connect_lan = target.lan ? await tcp({ host: target.lan.address, port: target.lan.port }) : 'no_interface';
  result.connect_remote_testnet = await tcp({ host: '192.0.2.1', port: 9 });
  result.ipv6_loopback = await tcp({ host: '::1', port: target.tor });
  result.ipv4_mapped = await tcp({ host: '::ffff:127.0.0.1', port: target.other });
  result.udp_remote = await udp('192.0.2.1', 53); result.udp_loopback = await udp('127.0.0.1', target.tor); result.udp_bind = await udpBind();
  result.dns_stub_tcp = await tcp({ host: '127.0.0.53', port: target.dnsPort }); result.dns_lookup = await lookup(target);
  result.unix_host_path = await tcp({ path: target.hostUnix }); result.unix_host_abstract = await tcp({ path: '\0' + target.hostAbstract });
  result.bind_other_port = await bindRow(target.bindOther); result.bind_tor_port = await bindRow(target.tor); result.bind_ephemeral = await bindRow(0);
  result.bind_wildcard_forbidden_port = await bindRow(target.bindOther, '0.0.0.0'); result.bind_wildcard_permitted_port = await bindRow(target.wallet, '0.0.0.0');
  return result;
}
const hostPpid = (pid) => { try { const match = /^PPid:\s*(\d+)/m.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8')); return match ? Number(match[1]) : 1; } catch { return 1; } };
const goProbe = (target) => { try { const stage1 = hostPpid('self'); const stage0 = hostPpid(stage1); return JSON.parse(execFileSync(target.launcher, ['probe', String(stage1), String(stage0), target.hostUnix, target.hostDgram], { encoding: 'utf8', timeout: 15000, stdio: ['ignore','pipe','ignore'] })); } catch { return { error: 'probe_failed' }; } };
async function main() {
  const target = JSON.parse(process.argv[2]); const role = process.argv[3] || 'parent';
  if (role === 'child') { process.stdout.write(JSON.stringify(await run(target))); return; }
  let api;
  try {
    api = http.createServer((request, response) => {
      if (request.url === '/echo' && request.method === 'POST') { response.writeHead(200); request.pipe(response); return; }
      response.writeHead(404); response.end();
    });
    await new Promise((resolve, reject) => { api.once('error', reject); api.listen({ port: target.daemon, host: '127.0.0.1', exclusive: true }, resolve); });
  } catch {}
  if (!api) { process.stdout.write(JSON.stringify({ kind: 'zkapi-selftest', error: 'api_listener' }) + '\n'); return; }
  const parent = await run(target);
  let child; try { child = JSON.parse(execFileSync(process.execPath, [__filename, process.argv[2], 'child'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore','pipe','ignore'] })); } catch { child = { error: 'child_failed' }; }
  const go = goProbe(target);
  if (target.bridgeRemoval) parent.tor_bridge_removed = await tcp({ host: '127.0.0.1', port: target.tor }, 'last');
  const held = [];
  if (target.confined) for (const port of [target.companion, target.wallet]) { const item = await listenTry(port); if (item.server) held.push(item.server); }
  process.stdout.write(JSON.stringify({ kind: 'zkapi-selftest', daemonApiListener: 'listening', parent, child, go }) + '\n');
  setTimeout(() => process.exit(0), 30000);
}
main().catch(() => process.exit(1));
`;

function listen(server: Server, port: number, host: string, ipv6Only = false): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, exclusive: true, ipv6Only }, () => {
      server.removeListener('error', reject);
      resolve((server.address() as { port: number }).port);
    });
  });
}

function listenPath(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path }, () => { server.removeListener('error', reject); resolve(); });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function socketFd(socket: Socket): number {
  return (socket as unknown as { _handle?: { fd?: number } })._handle?.fd ?? -1;
}

function connected(options: { path: string } | { host: string; port: number }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(options);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function processGone(pgid: number): boolean {
  if (process.platform === 'linux') {
    try {
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const raw = readFileSync(`/proc/${name}/stat`, 'utf8');
          const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
          if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') return false;
        } catch {}
      }
      return true;
    } catch {}
  }
  try { process.kill(-pgid, 0); return false; } catch (error) { return (error as { code?: string }).code !== 'EPERM'; }
}

async function stopGroup(pgid: number): Promise<void> {
  if (pgid <= 1 || processGone(pgid)) return;
  try { process.kill(-pgid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + 2500;
  while (!processGone(pgid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!processGone(pgid)) {
    try { process.kill(-pgid, 'SIGKILL'); } catch {}
    const killDeadline = Date.now() + 1500;
    while (!processGone(pgid) && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!processGone(pgid)) throw new Error(`self-test process group ${pgid} survived cleanup`);
}

interface DgramDecoy { handle: SelfTestHelper; count: () => number; ready: Promise<void> }
function startDgramDecoy(
  script: string,
  pathname: string,
  env: NodeJS.ProcessEnv,
  watchdogPath: string,
  supervise: SelfTestSupervisor,
): DgramDecoy {
  let count = 0;
  let started = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => rejectReady(new Error('Unix datagram decoy did not start')), 3000);
  const handle = supervise('daemon', watchdogPath, [process.execPath, script, '--dgram-decoy', pathname], env, (line) => {
    if (line === 'ready') { started = true; clearTimeout(timer); resolveReady(); }
    if (line === 'datagram') count += 1;
  }, () => {
    clearTimeout(timer);
    if (!started) rejectReady(new Error('Unix datagram decoy exited'));
  });
  handle.go();
  return { handle, count: () => count, ready };
}

interface Fixture {
  controlTarget: Record<string, unknown>;
  confinedTarget: Record<string, unknown>;
  inheritedSockets: Socket[];
  controlStreamCount: () => number;
  confinedStreamCount: () => number;
  controlDgram: DgramDecoy;
  confinedDgram: DgramDecoy;
  close(): Promise<void>;
}

async function releaseFixtureResources(
  servers: Server[],
  datagrams: DatagramSocket[],
  sockets: Socket[],
  acceptedSockets: Socket[],
  decoys: DgramDecoy[],
  paths: string[],
): Promise<void> {
  for (const socket of [...sockets, ...acceptedSockets]) socket.destroy();
  for (const socket of datagrams) { try { socket.close(); } catch {} }
  await Promise.all(servers.map(async (server) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closeServer(server),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); }),
      ]);
    } catch {} finally { if (timer) clearTimeout(timer); }
  }));
  const stopped = await Promise.allSettled(decoys.map(({ handle }) => stopGroup(handle.pgid)));
  for (const path of paths) rmSync(path, { force: true });
  const failure = stopped.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function createFixture(
  script: string,
  workDir: string,
  launcher: string,
  ports: Required<ZkapiConfinementPorts>,
  env: NodeJS.ProcessEnv,
  watchdogPath: string,
  supervise: SelfTestSupervisor,
): Promise<Fixture> {
  const servers: Server[] = [];
  const datagrams: DatagramSocket[] = [];
  const inheritedSockets: Socket[] = [];
  const acceptedSockets: Socket[] = [];
  const decoys: DgramDecoy[] = [];
  const cleanupPaths: string[] = [];
  const track = (server: Server): Server => { servers.push(server); return server; };
  try {
  let confinedTorConnections = 0;
  const confinedTor = track(createServer((socket) => {
    confinedTorConnections += 1;
    const prefix = confinedTorConnections % 2 === 1;
    let short = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (!prefix) { socket.write(chunk); return; }
      short = Buffer.concat([short, Buffer.from(chunk)]);
      if (short.length >= 5) socket.write(Buffer.from('TOR-HOST:' + String(short)));
    });
    socket.on('error', () => undefined);
    if (confinedTorConnections === 4) confinedTor.close();
  }));
  const torHost = await listen(confinedTor, 0, '127.0.0.1');
  let controlTorConnections = 0;
  const controlTor = track(createServer((socket) => {
    controlTorConnections += 1;
    const prefix = controlTorConnections % 2 === 1;
    let short = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (!prefix) { socket.write(chunk); return; }
      short = Buffer.concat([short, Buffer.from(chunk)]);
      if (short.length >= 5) socket.write(Buffer.from('TOR-HOST:' + String(short)));
    });
    socket.on('error', () => undefined);
  }));
  const controlTorPort = await listen(controlTor, 0, '127.0.0.1');
  await listen(track(createServer((socket) => socket.end('HOST'))), controlTorPort, '::1', true);
  for (const port of [ports.companionProxy, ports.walletApi]) await listen(track(createServer((socket) => socket.end('HOST'))), port, '127.0.0.1');
  const otherServer = track(createServer((socket) => socket.end('HOST')));
  const other = await listen(otherServer, 0, '127.0.0.1');
  const aliasServer = track(createServer((socket) => socket.end('HOST')));
  const alias = await listen(aliasServer, 0, '127.0.0.2');
  const reserve = track(createServer()); const bindOther = await listen(reserve, 0, '127.0.0.1'); await closeServer(reserve);
  const interfaces = Object.values(networkInterfaces()).flat().filter((item): item is NonNullable<typeof item> => Boolean(item));
  const local = interfaces.find((item) => item.family === 'IPv4' && !item.internal);
  let lan: { address: string; port: number } | undefined;
  if (local) {
    const server = track(createServer((socket) => socket.end('HOST')));
    lan = { address: local.address, port: await listen(server, 0, local.address) };
  }
  const dnsTcp = track(createServer((socket) => socket.end()));
  const dnsPort = await listen(dnsTcp, 0, '127.0.0.53');
  const dnsUdp = createSocket('udp4'); datagrams.push(dnsUdp);
  dnsUdp.on('message', (query, info) => {
    if (query.length < 12) return;
    const response = Buffer.from(query); response[2] = 0x81; response[3] = 0x80; response.writeUInt16BE(1, 6);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 127, 0, 0, 1]);
    dnsUdp.send(Buffer.concat([response, answer]), info.port, info.address);
  });
  await new Promise<void>((resolve, reject) => { dnsUdp.once('error', reject); dnsUdp.bind(dnsPort, '127.0.0.53', resolve); });
  let controlStreams = 0; let confinedStreams = 0;
  const controlUnix = join(workDir, 'selftest-control.sock');
  const confinedUnix = join(workDir, 'selftest-confined.sock');
  const inheritedUnix = join(workDir, 'selftest-inherited.sock');
  cleanupPaths.push(controlUnix, confinedUnix, inheritedUnix);
  // The probe destroys its socket after observing connect. Ending it here can
  // race Bun's connect notification: an accepted Unix connection is reported as
  // ECONNREFUSED. Keep each decoy alive until the peer closes or fixture cleanup.
  const keepUnixSocket = (socket: Socket): void => {
    acceptedSockets.push(socket);
    socket.on('error', () => undefined);
  };
  const controlUnixServer = (): Server => track(createServer((socket) => { controlStreams += 1; keepUnixSocket(socket); }));
  const confinedUnixServer = (): Server => track(createServer((socket) => { confinedStreams += 1; keepUnixSocket(socket); }));
  await listenPath(controlUnixServer(), controlUnix);
  await listenPath(confinedUnixServer(), confinedUnix);
  await listenPath(track(createServer(keepUnixSocket)), inheritedUnix);
  const suffix = `${process.pid}-${randomBytes(5).toString('hex')}`;
  const controlAbstract = `olympus-zkc-control-${suffix}`;
  const confinedAbstract = `olympus-zkc-confined-${suffix}`;
  await listenPath(controlUnixServer(), `\0${controlAbstract}`);
  await listenPath(confinedUnixServer(), `\0${confinedAbstract}`);
  const controlDgramPath = join(workDir, 'selftest-control-dgram.sock');
  const confinedDgramPath = join(workDir, 'selftest-confined-dgram.sock');
  cleanupPaths.push(controlDgramPath, confinedDgramPath);
  const controlDgram = startDgramDecoy(script, controlDgramPath, env, watchdogPath, supervise);
  decoys.push(controlDgram);
  const confinedDgram = startDgramDecoy(script, confinedDgramPath, env, watchdogPath, supervise);
  decoys.push(confinedDgram);
  await Promise.all([controlDgram.ready, confinedDgram.ready]);
  inheritedSockets.push(await connected({ path: inheritedUnix }));
  inheritedSockets.push(await connected({ host: '127.0.0.1', port: other }));
  const decoyInodes = inheritedSockets.map((socket) => readlinkSync(`/proc/self/fd/${socketFd(socket)}`));
  const common = { launcher, companion: ports.companionProxy, wallet: ports.walletApi, daemon: ports.daemon, other, alias, bindOther, dnsPort, lan, decoyInodes, hostNetNs: readlinkSync('/proc/self/ns/net'), hostUserNs: readlinkSync('/proc/self/ns/user') };
  return {
    controlTarget: { ...common, tor: controlTorPort, hostUnix: controlUnix, hostAbstract: controlAbstract, hostDgram: controlDgramPath, confined: false, bridgeRemoval: false },
    confinedTarget: { ...common, tor: ports.tor, hostUnix: confinedUnix, hostAbstract: confinedAbstract, hostDgram: confinedDgramPath, confined: true, bridgeRemoval: true, torHost },
    inheritedSockets,
    controlStreamCount: () => controlStreams,
    confinedStreamCount: () => confinedStreams,
    controlDgram,
    confinedDgram,
    async close() {
      await releaseFixtureResources(servers, datagrams, inheritedSockets, acceptedSockets, decoys, cleanupPaths);
    },
  };
  } catch (error) {
    await releaseFixtureResources(servers, datagrams, inheritedSockets, acceptedSockets, decoys, cleanupPaths);
    throw error;
  }
}

function parseProbeLine(line: string): Omit<LinuxConfinementSelfTestSide, 'unixStreamConnections' | 'unixDatagrams'> | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.kind !== 'zkapi-selftest' || value.error || typeof value.parent !== 'object' || typeof value.child !== 'object' || typeof value.go !== 'object') return undefined;
    return { daemonApiListener: value.daemonApiListener as string, parent: value.parent as ProbeRows, child: value.child as ProbeRows, go: value.go as ProbeRows };
  } catch { return undefined; }
}

const defaultRunner: LinuxConfinementSelfTestRunner = {
  async run(launcher, workDir, env, partialPorts) {
    if (process.getuid?.() === 0) throw new Error('the unconfined syscall control must not run as root');
    const ports = partialPorts as Required<ZkapiConfinementPorts>;
    const probePath = join(workDir, `zkapi-confine-selftest-${process.pid}-${randomBytes(4).toString('hex')}.cjs`);
    const watchdogPath = join(workDir, `zkapi-confine-selftest-watchdog-${process.pid}-${randomBytes(4).toString('hex')}.cjs`);
    try {
    writeFileSync(probePath, LINUX_CONFINEMENT_SELF_TEST_PROBE_SOURCE, { mode: 0o700 }); chmodSync(probePath, 0o700);
    const transport = await import('./consult-transport-zkapi.ts');
    const linux = await import('./zkapi-confinement-linux.ts');
    const bridge = await import('./zkapi-confine-fetch.ts');
    writeFileSync(watchdogPath, transport.WATCHDOG_SCRIPT, { mode: 0o700 }); chmodSync(watchdogPath, 0o700);
    let fixture: Fixture | undefined;
    let control: SelfTestHelper | undefined;
    let supervised: ReturnType<typeof transport.supervise> | undefined;
    try {
      fixture = await createFixture(probePath, workDir, launcher, ports, env, watchdogPath, transport.supervise);
      const inheritedFds = fixture.inheritedSockets.map(socketFd);
      if (inheritedFds.some((fd) => fd < 0)) throw new Error('descriptor unavailable');
      let controlResult: ReturnType<typeof parseProbeLine>;
      let confinedResult: ReturnType<typeof parseProbeLine>;
      let status: StatusObservation | undefined;
      let instanceBound = false;
      let listenerSetBound = false;
      const controlDone = new Promise<void>((resolve, reject) => {
        control = transport.supervise('daemon', watchdogPath, [process.execPath, probePath, JSON.stringify(fixture!.controlTarget)], env, (line) => {
          controlResult ??= parseProbeLine(line);
          if (controlResult) resolve();
        }, () => { if (!controlResult) reject(new Error('control exited')); }, () => undefined, () => undefined, inheritedFds);
        control.go();
      });
      let resolveConfined!: () => void; let rejectConfined!: (error: Error) => void;
      const confinedDone = new Promise<void>((resolve, reject) => { resolveConfined = resolve; rejectConfined = reject; });
      const args = [launcher, 'run', '--dir', workDir, '--status-fd', '3', '--expose', `api=${ports.daemon}`, '--reach', `${ports.tor}=${String(fixture.confinedTarget.torHost)}`,
        ...[ports.tor, ports.daemon, ports.companionProxy, ports.walletApi].flatMap((port) => ['--connect-port', String(port)]),
        ...[ports.daemon, ports.companionProxy, ports.walletApi].flatMap((port) => ['--bind-port', String(port)]),
        '--', process.execPath, probePath, JSON.stringify(fixture.confinedTarget)];
      supervised = transport.supervise('daemon', watchdogPath, args, env, (line) => {
        const parsed = parseProbeLine(line);
        if (!parsed) return;
        confinedResult = parsed;
        void (async () => {
          if (status?.event !== 'ready' || !supervised?.leader) throw new Error('ready event missing');
          const ready = status as Parameters<typeof linux.verifyLinuxInstance>[0];
          const watchdog = { pid: supervised.pgid, startTime: supervised.leader.startTime };
          instanceBound = linux.verifyLinuxInstance(ready, watchdog)
            && JSON.stringify(ready.bridgesExpose) === '["api"]'
            && JSON.stringify(ready.bridgesReach) === JSON.stringify([String(ports.tor)]);
          listenerSetBound = linux.inspectLinuxNamespace(ready, watchdog, ports);
          const payload = Buffer.alloc(4 * 1024 * 1024, 90);
          const response = await bridge.linuxConfinementFetch(join(workDir, 'api.sock'), ready.apiToken)(
            `http://127.0.0.1:${ports.daemon}/echo`, { method: 'POST', body: payload },
          );
          const echoed = Buffer.from(await response.arrayBuffer());
          parsed.apiBridgeBulk = response.status === 200 && echoed.equals(payload) ? 'intact' : 'corrupt';
          resolveConfined();
        })().catch(rejectConfined);
      }, () => { if (!confinedResult) rejectConfined(new Error('confined launcher exited')); }, (event) => {
        status = event;
        if (event.event !== 'ready') rejectConfined(new Error('launcher refused'));
      }, () => { if (!confinedResult) rejectConfined(new Error('status closed')); }, inheritedFds);
      supervised.go();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error('self-test timeout')), 35_000); });
      try { await Promise.race([Promise.all([controlDone, confinedDone]), timeout]); } finally { if (timeoutId) clearTimeout(timeoutId); }
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!controlResult || !confinedResult) throw new Error('probe missing');
      return {
        control: { ...controlResult, unixStreamConnections: fixture.controlStreamCount(), unixDatagrams: fixture.controlDgram.count() },
        confined: { ...confinedResult, unixStreamConnections: fixture.confinedStreamCount(), unixDatagrams: fixture.confinedDgram.count(), ...(status ? { status } : {}), instanceBound, listenerSetBound },
      };
    } finally {
      let cleanupError: unknown;
      const cleanup = async (operation: () => Promise<void>): Promise<void> => {
        try { await operation(); } catch (error) { cleanupError ??= error; }
      };
      if (control) await cleanup(() => stopGroup(control!.pgid));
      if (supervised) await cleanup(() => stopGroup(supervised!.pgid));
      if (fixture) await cleanup(() => fixture!.close());
      if (cleanupError) throw cleanupError;
    }
    } finally {
      rmSync(probePath, { force: true }); rmSync(watchdogPath, { force: true });
    }
  },
};

export async function runLinuxConfinementSelfTest(
  launcher: string,
  workDir: string,
  env: NodeJS.ProcessEnv,
  ports: ZkapiConfinementPorts,
): Promise<boolean> {
  return runLinuxConfinementSelfTestWithRunner(launcher, workDir, env, ports, defaultRunner);
}
