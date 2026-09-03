import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  pinWorkerReadinessPort,
  startSimulatedReadinessServer,
  waitForSimulatedReadiness,
} from '../scripts/qualification/readiness-stub.ts';
import { runWorkerLifecycle } from '../src/core/lifecycle.ts';
import {
  installWorkerService,
  workerServicePaths,
  type WorkerServiceExec,
} from '../src/core/worker-service.ts';

// The live managed worker's default port. A simulated clean-home run that binds
// or probes it is answered by the operator's real worker instead of the stub.
const LIVE_WORKER_PORT = 8010;

describe('simulated clean-home readiness stub', () => {
  test('each stub owns a private loopback port instead of the live worker port', async () => {
    const first = await startSimulatedReadinessServer();
    const second = await startSimulatedReadinessServer();
    try {
      expect(first.port).not.toBe(LIVE_WORKER_PORT);
      expect(second.port).not.toBe(LIVE_WORKER_PORT);
      expect(second.port).not.toBe(first.port);
      for (const stub of [first, second]) {
        await waitForSimulatedReadiness(stub.port);
        expect(await (await fetch(stub.url)).json()).toMatchObject({ reachable: true });
      }
    } finally {
      await first.stop();
      await second.stop();
    }
  }, 30_000);

  test('the pinned managed environment points the upgrade readiness probe at the stub', async () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-qualification-readiness-'));
    const stub = await startSimulatedReadinessServer();
    try {
      installWorkerService({
        platform: 'linux',
        homeDir: home,
        workingDirectory: '/opt/olympus-old',
        bunBin: process.execPath,
        authToken: 'old-token',
      });
      const envPath = workerServicePaths('linux', home).envPath;
      expect(readFileSync(envPath, 'utf8')).toContain(`OLYMPUS_EMAIL_SOURCE_PORT=${LIVE_WORKER_PORT}`);

      expect(stub.port).not.toBe(LIVE_WORKER_PORT);
      pinWorkerReadinessPort(envPath, stub.port);
      expect(readFileSync(envPath, 'utf8')).not.toContain(`OLYMPUS_EMAIL_SOURCE_PORT=${LIVE_WORKER_PORT}`);
      await waitForSimulatedReadiness(stub.port);

      const result = runWorkerLifecycle('upgrade', {
        platform: 'linux',
        homeDir: home,
        artifactPath: createUpgradeArtifact(home, '0.4.4'),
        bunBin: process.execPath,
        exec: activeLinuxExec(),
        activationSettleMs: 0,
      }) as { ok?: boolean; readiness?: { status?: string; url?: string } };

      expect(result.ok).toBe(true);
      expect(result.readiness).toEqual({ status: 'ready', url: `http://127.0.0.1:${stub.port}/v1/health` });
      // The upgrade reconciles the managed environment, so the pin has to survive it.
      expect(readFileSync(envPath, 'utf8')).toContain(`OLYMPUS_EMAIL_SOURCE_PORT=${stub.port}`);
    } finally {
      await stub.stop();
      makeTreeWritable(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

function activeLinuxExec(): WorkerServiceExec {
  let state: 'active' | 'inactive' = 'active';
  return (command, args) => {
    const call = [command, ...args].join(' ');
    if (call === 'systemctl --user is-active olympus-worker.service') {
      return state === 'active'
        ? { status: 0, stdout: 'active\n', stderr: '' }
        : { status: 3, stdout: `${state}\n`, stderr: '' };
    }
    if (call === 'systemctl --user daemon-reload') return { status: 0, stdout: 'reloaded\n', stderr: '' };
    if (call === 'systemctl --user stop olympus-worker.service') {
      state = 'inactive';
      return { status: 0, stdout: 'inactive\n', stderr: '' };
    }
    state = 'active';
    return { status: 0, stdout: 'active\n', stderr: '' };
  };
}

function createUpgradeArtifact(home: string, version: string): string {
  const fixture = mkdtempSync(join(tmpdir(), 'olympus-qualification-upgrade-package-'));
  const packageRoot = join(fixture, 'package');
  const artifactPath = join(home, `olympus-${version}.tgz`);
  try {
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: 'olympus', version, type: 'module' })}\n`);
    writeFileSync(join(packageRoot, 'openclaw.plugin.json'), `${JSON.stringify({ id: 'olympus', version })}\n`);
    writeFileSync(join(packageRoot, 'dist', 'cli.js'), `console.log('olympus ${version}');\n`);
    const packed = Bun.spawnSync(['tar', '-czf', artifactPath, '-C', fixture, 'package']);
    if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
    return artifactPath;
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function makeTreeWritable(path: string): void {
  if (!existsSync(path)) return;
  let stats: ReturnType<typeof lstatSync> | undefined;
  try {
    stats = lstatSync(path);
  } catch {
    return;
  }
  if (!stats.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) makeTreeWritable(join(path, entry));
}
