// OLYMPUS_TEST_LANE: deploy

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateLinuxConfinementSelfTestObservation,
  LINUX_CONFINEMENT_SELF_TEST_PROBE_SOURCE,
  runLinuxConfinementSelfTest,
  runLinuxConfinementSelfTestWithRunner,
  type LinuxConfinementSelfTestObservation,
  type LinuxConfinementSelfTestRunner,
} from '../src/core/zkapi-confine-selftest.ts';

const inside = {
  inherited_decoy_fds: '0', caps: 'zero', no_new_privs: '1', seccomp_mode: '2',
  net_ns_differs: 'yes', user_ns_differs: 'yes', interfaces: 'lo',
  tor_bridge_echo: 'TOR-HOST:probe', tor_bridge_bulk: 'intact',
  companion_bind_connect: 'bound_connected_ns', wallet_bind_connect: 'bound_connected_ns',
  connect_other_port: 'failed_fast', connect_loopback_alias: 'failed_fast', connect_lan: 'failed_fast',
  connect_remote_testnet: 'failed_fast', ipv6_loopback: 'failed_fast', ipv4_mapped: 'failed_fast',
  udp_remote: 'failed', udp_loopback: 'failed', udp_bind: 'failed',
  dns_stub_tcp: 'failed_fast', dns_lookup: 'failed_fast',
  unix_host_path: 'failed_fast', unix_host_abstract: 'failed_fast',
  bind_other_port: 'denied:EACCES', bind_tor_port: 'denied:EACCES', bind_ephemeral: 'denied:EACCES',
  bind_wildcard_forbidden_port: 'denied:EACCES', bind_wildcard_permitted_port: 'bound',
};

const outside = {
  inherited_decoy_fds: '2', caps: 'zero', no_new_privs: '0', seccomp_mode: '0',
  net_ns_differs: 'no', user_ns_differs: 'no', interfaces: 'lo,eth0',
  tor_bridge_echo: 'TOR-HOST:probe', tor_bridge_bulk: 'intact',
  companion_bind_connect: 'denied:EADDRINUSE', wallet_bind_connect: 'denied:EADDRINUSE',
  connect_other_port: 'connected', connect_loopback_alias: 'connected', connect_lan: 'connected',
  connect_remote_testnet: 'timeout', ipv6_loopback: 'connected', ipv4_mapped: 'connected',
  udp_remote: 'sent', udp_loopback: 'sent', udp_bind: 'bound',
  dns_stub_tcp: 'connected', dns_lookup: 'resolved',
  unix_host_path: 'connected', unix_host_abstract: 'connected',
  bind_other_port: 'bound', bind_tor_port: 'denied:EADDRINUSE', bind_ephemeral: 'bound',
  bind_wildcard_forbidden_port: 'bound', bind_wildcard_permitted_port: 'denied:EADDRINUSE',
};

const goInside = {
  socket_inet_stream: 'ok', socket_inet6: 'EPERM', socket_inet_dgram: 'EPERM', socket_inet_raw: 'EPERM',
  socket_unix: 'EPERM', socket_unix_dgram: 'EPERM', socket_netlink_route: 'ok', socket_netlink_generic: 'EPERM',
  socket_packet: 'EPERM', socket_vsock: 'EPERM', socketpair_unix_stream: 'ok',
  socketpair_unix_dgram: 'EPERM', socketpair_unix_seqpacket: 'EPERM',
  pair_stream_connect_host_path: 'EISCONN', pair_stream_sendto_host_path: 'EISCONN',
  pair_stream_connect_after_shutdown: 'EACCES', pair_dgram_connect_host_path: 'no_socket',
  pair_dgram_sendto_host_path: 'no_socket', inet_connect_unix_addr: 'EAFNOSUPPORT',
  listen_unbound: 'listening:45678', ptrace_attach_launcher: 'EPERM', ptrace_attach_stage0: 'EPERM',
  ptrace_attach_ns_init: 'EPERM', process_vm_readv_launcher: 'EPERM', io_uring_setup: 'EPERM',
  unshare_newuser: 'EPERM', unshare_newnet: 'EPERM', unshare_newpid: 'EPERM', clone3: 'ENOSYS',
  clone_newuser_exec: 'operation not permitted', clone_newpid_exec: 'operation not permitted', setns_net: 'EPERM',
  mount_tmpfs: 'EPERM', open_launcher_mem_rw: 'EACCES', open_stage0_mem_rw: 'EACCES',
  signal_launcher: 'ESRCH', signal_stage0: 'ESRCH', signal_ns_init_sigkill: 'EPERM', ns_init_alive_after: 'yes',
};

const goOutside = Object.fromEntries(Object.keys(goInside).map((key) => [key, 'ok']));
Object.assign(goOutside, {
  listen_unbound: 'listening:45679',
  pair_stream_connect_host_path: 'EISCONN',
  pair_stream_sendto_host_path: 'EISCONN',
  pair_stream_connect_after_shutdown: 'EISCONN',
  inet_connect_unix_addr: 'EAFNOSUPPORT',
  ns_init_alive_after: 'yes',
});

function completeObservation(): LinuxConfinementSelfTestObservation {
  return {
    control: {
      daemonApiListener: 'listening',
      parent: structuredClone(outside),
      child: { ...structuredClone(outside), inherited_decoy_fds: '0' },
      go: structuredClone(goOutside),
      unixStreamConnections: 3,
      unixDatagrams: 1,
    },
    confined: {
      daemonApiListener: 'listening',
      parent: { ...structuredClone(inside), tor_bridge_removed: 'closed_fast' },
      child: structuredClone(inside),
      go: structuredClone(goInside),
      unixStreamConnections: 0,
      unixDatagrams: 0,
      apiBridgeBulk: 'intact',
      instanceBound: true,
      listenerSetBound: true,
      status: {
        event: 'ready',
        landlockAbi: 9,
        layers: ['netns', 'pidns', 'ipv6-off', 'caps', 'nnp', 'launcher-undumpable', 'launcher-seccomp', 'launcher-landlock', 'landlock-net', 'landlock-scope', 'landlock-unix', 'seccomp'],
        stage0Layers: ['nnp', 'launcher-undumpable', 'launcher-seccomp', 'launcher-landlock'],
        bridgesExpose: ['api'],
        bridgesReach: ['39001'],
      },
    },
  };
}

describe('Linux zkAPI per-session confinement self-test', () => {
  test('the generated probe is valid CommonJS', () => {
    expect(() => new Function(LINUX_CONFINEMENT_SELF_TEST_PROBE_SOURCE)).not.toThrow();
  });

  test('accepts the complete opposite control and confined matrix', () => {
    expect(evaluateLinuxConfinementSelfTestObservation(completeObservation())).toBe(true);
  });

  test('fails closed when any reported probe row is missing', () => {
    const paths: Array<['control' | 'confined', 'parent' | 'child' | 'go', string]> = [];
    for (const side of ['control', 'confined'] as const) {
      for (const role of ['parent', 'child'] as const) {
        for (const key of Object.keys(side === 'control' ? outside : inside)) paths.push([side, role, key]);
      }
      for (const key of Object.keys(goInside)) paths.push([side, 'go', key]);
    }
    for (const [side, role, key] of paths) {
      const observation = completeObservation();
      delete observation[side]![role]![key];
      expect(evaluateLinuxConfinementSelfTestObservation(observation), `${side}.${role}.${key}`).toBe(false);
    }
  });

  test('refuses mismatches, launcher refusal, decoy escape, and missing bridge evidence', () => {
    const cases: LinuxConfinementSelfTestObservation[] = [];
    for (const role of ['parent', 'child'] as const) {
      const unreachable = completeObservation(); unreachable.control![role].unix_host_abstract = 'failed_fast'; cases.push(unreachable);
      const reachable = completeObservation(); reachable.confined![role].unix_host_abstract = 'connected'; cases.push(reachable);
    }
    const mismatch = completeObservation(); mismatch.confined!.child.connect_other_port = 'connected'; cases.push(mismatch);
    const refused = completeObservation(); refused.confined!.status = { event: 'refused', code: 'restriction_failed' }; cases.push(refused);
    const noReady = completeObservation(); delete noReady.confined!.status; cases.push(noReady);
    const dgramEscape = completeObservation(); dgramEscape.confined!.unixDatagrams = 1; cases.push(dgramEscape);
    const controlBlind = completeObservation(); controlBlind.control!.unixDatagrams = 0; cases.push(controlBlind);
    const noBulk = completeObservation(); delete noBulk.confined!.parent.tor_bridge_bulk; cases.push(noBulk);
    const noRemoval = completeObservation(); delete noRemoval.confined!.parent.tor_bridge_removed; cases.push(noRemoval);
    const noLayer = completeObservation(); noLayer.confined!.status!.layers = noLayer.confined!.status!.layers!.filter((v) => v !== 'seccomp'); cases.push(noLayer);
    const noAbi = completeObservation(); delete noAbi.confined!.status!.landlockAbi; cases.push(noAbi);
    const noApiBulk = completeObservation(); delete noApiBulk.confined!.apiBridgeBulk; cases.push(noApiBulk);
    const noInstance = completeObservation(); noInstance.confined!.instanceBound = false; cases.push(noInstance);
    const noListeners = completeObservation(); noListeners.confined!.listenerSetBound = false; cases.push(noListeners);
    const noExpose = completeObservation(); delete noExpose.confined!.status!.bridgesExpose; cases.push(noExpose);
    const wrongReach = completeObservation(); wrongReach.confined!.status!.bridgesReach = []; cases.push(wrongReach);
    const noApiListener = completeObservation(); delete noApiListener.confined!.daemonApiListener; cases.push(noApiListener);
    const streamEscape = completeObservation(); streamEscape.confined!.unixStreamConnections = 1; cases.push(streamEscape);
    for (const observation of cases) expect(evaluateLinuxConfinementSelfTestObservation(observation)).toBe(false);
  });

  test('uses the injected runner and converts every runner failure to false', async () => {
    const calls: unknown[][] = [];
    const runner: LinuxConfinementSelfTestRunner = {
      async run(...args) { calls.push(args); return completeObservation(); },
    };
    const ports = { tor: 39001, daemon: 39002, companionProxy: 39003, walletApi: 39004 };
    await expect(runLinuxConfinementSelfTestWithRunner('/launcher', '/work', { HOME: '/home/test' }, ports, runner)).resolves.toBe(true);
    expect(calls).toEqual([['/launcher', '/work', { HOME: '/home/test' }, ports]]);

    const throwing: LinuxConfinementSelfTestRunner = { async run() { throw new Error('no namespace'); } };
    await expect(runLinuxConfinementSelfTestWithRunner('/launcher', '/work', {}, ports, throwing)).resolves.toBe(false);
    await expect(runLinuxConfinementSelfTestWithRunner('/launcher', '/work', {}, {
      tor: ports.tor, daemon: ports.daemon, companionProxy: ports.companionProxy,
    }, runner)).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });
});

const realLauncher = process.env.OLYMPUS_ZKAPI_CONFINE_BIN;
let realLauncherAvailable = false;
if (process.platform === 'linux' && process.getuid?.() !== 0 && realLauncher && existsSync(realLauncher)) {
  try {
    const result = JSON.parse(execFileSync(realLauncher, ['check'], { encoding: 'utf8' })) as { ok?: boolean };
    realLauncherAvailable = result.ok === true;
  } catch {}
}

const realDirs: string[] = [];
afterEach(() => {
  for (const dir of realDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freePorts(count: number): Promise<number[]> {
  const servers = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return servers.map((server) => (server.address() as { port: number }).port);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

function liveProcessesMatching(fragment: string): number[] {
  if (process.platform !== 'linux') return [];
  const found: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const command = readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' ');
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0];
      if (command.includes(fragment) && state !== 'Z' && state !== 'X') found.push(Number(name));
    } catch {}
  }
  return found;
}

async function waitForProcessCount(fragment: string, predicate: (count: number) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(liveProcessesMatching(fragment).length)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate(liveProcessesMatching(fragment).length);
}

test.skipIf(process.platform !== 'linux')('all self-test helpers die when their external supervisor is killed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-zkapi-selftest-parent-death-'));
  const launcher = join(dir, 'fake-launcher');
  const supervisorScript = join(dir, 'supervisor.ts');
  const marker = dir;
  const targetUid = process.getuid?.() === 0 ? 65_534 : process.getuid?.();
  const targetGid = process.getgid?.() === 0 ? 65_534 : process.getgid?.();
  const [tor, daemon, companionProxy, walletApi] = await freePorts(4);
  if (tor === undefined || daemon === undefined || companionProxy === undefined || walletApi === undefined) throw new Error('ports unavailable');
  writeFileSync(launcher, '#!/bin/sh\nwhile :; do /bin/sleep 60; done\n', { mode: 0o755 });
  writeFileSync(supervisorScript, [
    `import { runLinuxConfinementSelfTest } from ${JSON.stringify(join(import.meta.dir, '../src/core/zkapi-confine-selftest.ts'))};`,
    `await runLinuxConfinementSelfTest(${JSON.stringify(launcher)}, ${JSON.stringify(dir)}, process.env, ${JSON.stringify({ tor, daemon, companionProxy, walletApi })});`,
    'setInterval(() => {}, 1000);',
  ].join('\n'), { mode: 0o644 });
  chmodSync(dir, 0o700);
  if (targetUid !== undefined && targetGid !== undefined && (targetUid !== process.getuid?.() || targetGid !== process.getgid?.())) chownSync(dir, targetUid, targetGid);
  const supervisor = spawn(process.execPath, [supervisorScript], {
    stdio: 'ignore',
    ...(targetUid !== undefined ? { uid: targetUid } : {}),
    ...(targetGid !== undefined ? { gid: targetGid } : {}),
  });
  try {
    expect(await waitForProcessCount(marker, (count) => count >= 4, 10_000)).toBe(true);
    supervisor.kill('SIGKILL');
    expect(await waitForProcessCount(marker, (count) => count === 0, 6_000), liveProcessesMatching(marker).join(',')).toBe(true);
  } finally {
    try { supervisor.kill('SIGKILL'); } catch {}
    for (const pid of liveProcessesMatching(marker)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test.skipIf(!realLauncherAvailable)('real production launcher passes the per-session matrix when namespaces are available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-zkapi-selftest-'));
  realDirs.push(dir);
  const [tor, daemon, companionProxy, walletApi] = await freePorts(4);
  if (tor === undefined || daemon === undefined || companionProxy === undefined || walletApi === undefined) throw new Error('ports unavailable');
  await expect(runLinuxConfinementSelfTest(realLauncher!, dir, process.env, { tor, daemon, companionProxy, walletApi })).resolves.toBe(true);
}, 45_000);
