import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxLibsecretSecretStore } from '../src/core/secret-store.ts';

// This is additional Linux protocol proof, not a real-desktop qualification.
// Linux CI prerequisites are errors, never skipped successes.
test.skipIf(process.platform !== 'linux')('private D-Bus service: bytes, Locked, permission, race, cleanup; never Unlock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'secrets-bus-'));
  const addressFile = join(root, 'state.json'), ready = join(root, 'ready');
  writeFileSync(addressFile, '{}');
  const config = join(root, 'bus.conf');
  // This private 0700 fixture tests Secret Service protocol behavior, not
  // host account authentication. Build containers can use a numeric UID
  // absent from /etc/passwd, which dbus-daemon's EXTERNAL mapping rejects.
  writeFileSync(config, `<busconfig><type>session</type><listen>unix:dir=${root}</listen><auth>ANONYMOUS</auth><allow_anonymous/><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`);
  const daemon = spawnSync('dbus-daemon', [`--config-file=${config}`,  '--fork', '--print-address=1', '--print-pid=1'], { encoding: 'utf8' });
  expect(daemon.status, daemon.stderr).toBe(0);
  const [address, pid] = daemon.stdout.trim().split('\n');
  expect(address).toMatch(/^unix:/);
  const prior = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.DBUS_SESSION_BUS_ADDRESS = address;
  const child = Bun.spawn(['/usr/bin/python3', 'test/fixtures/secrets/fake-service.py', root, addressFile, ready], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address! } });
  try {
    for (let i = 0; i < 100 && !existsSync(ready) && child.exitCode === null; i++) await Bun.sleep(30);
    if (!existsSync(ready)) { child.kill(); throw new Error(`Private Secret Service failed: ${await new Response(child.stderr).text()}`); }
    const store = new LinuxLibsecretSecretStore();
    expect(await store.get('absent')).toBeUndefined();
    await store.set('fixture', '  bytes\n');
    expect(await store.get('fixture')).toBe('  bytes\n');
    expect(await store.list()).toEqual(['fixture']);
    writeFileSync(addressFile, '{"locked":true}');
    await expect(store.get('fixture')).rejects.toMatchObject({ code: 'locked' });
    writeFileSync(addressFile, '{"failure":true}');
    await expect(store.get('fixture')).rejects.toMatchObject({ code: 'permission' });
    writeFileSync(addressFile, '{"race_locked":true}');
    await expect(store.set('fixture', 'value')).rejects.toMatchObject({ code: 'locked' });
    writeFileSync(addressFile, '{"cleanup_failure":true}');
    await expect(store.delete('fixture')).rejects.toMatchObject({ code: 'permission' });
    writeFileSync(addressFile, '{}');
    await store.delete('fixture');
    await store.probe();
    expect(await store.list()).toEqual([]);
    expect(readFileSync(join(root, 'calls'), 'utf8')).not.toContain('Unlock');
  } finally {
    child.kill(); await child.exited;
    if (prior === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = prior;
    process.kill(Number(pid), 'SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
