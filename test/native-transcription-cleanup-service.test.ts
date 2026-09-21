import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeTranscriptionCleanupService } from '../src/core/native-transcription-cleanup-service.ts';
import type { NativeProcessServiceContext, NativeProcessServiceDefinition } from '../src/core/native-process-service.ts';

setDefaultTimeout(20_000);

const services: NativeProcessServiceDefinition[] = [];
const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

const CLEANUP_ENV_NAMES = [
  'HOME',
  'PATH',
  'TMPDIR',
  'LANG',
  'OLYMPUS_TRANSCRIBE_TMP_ROOT',
  'OLYMPUS_TRANSCRIBE_SWEEP_AGE_MINUTES',
] as const;

interface Fixture {
  root: string;
  tempRoot: string;
  counterPath: string;
  markerPath: string;
  envPath: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'olympus-transcription-cleanup-'));
  roots.push(root);
  const tempRoot = join(root, 'tmp-root');
  mkdirSync(tempRoot, { recursive: true });
  return {
    root,
    tempRoot,
    counterPath: join(root, 'sweeps'),
    markerPath: join(root, 'in-flight'),
    envPath: join(root, 'env'),
  };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const name of Object.keys(savedEnv)) delete savedEnv[name];
});

function rememberEnv(name: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
}

function track<T extends NativeProcessServiceDefinition>(service: T): T {
  services.push(service);
  return service;
}

function pluginConfig(fx: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worker: {
      transcriptionCleanup: {
        enabled: true,
        bashPath: '/bin/bash',
        tempRoot: fx.tempRoot,
        ...overrides,
      },
    },
  };
}

function serviceFor(
  fx: Fixture,
  config: unknown,
  options: { scriptPath?: string; spawn?: typeof childProcess.spawn } = {},
): NativeProcessServiceDefinition {
  return track(createNativeTranscriptionCleanupService({
    initialPluginConfig: config,
    intervalMs: 1_000,
    moduleUrl: import.meta.url,
    scriptPath: options.scriptPath ?? fixtureScript(fx, 'exit 0'),
    ...(options.spawn ? { spawn: options.spawn } : {}),
  }));
}

/** Records each sweep once, never overlapping, and dumps only the allowed env. */
function fixtureScript(fx: Fixture, body: string): string {
  const scriptPath = join(fx.root, 'sweep.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$$" >> ${shellQuote(fx.counterPath)}
touch ${shellQuote(fx.markerPath)}
for name in HOME PATH TMPDIR LANG OLYMPUS_TRANSCRIBE_TMP_ROOT OLYMPUS_TRANSCRIBE_SWEEP_AGE_MINUTES
do
  printf '%s=%s\\n' "$name" "\${!name-<unset>}" >> ${shellQuote(fx.envPath)}
done
${body}
rm -f ${shellQuote(fx.markerPath)}
`, { mode: 0o755 });
  return scriptPath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function countingSpawn(
  calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>,
  spawned: ChildProcess[] = [],
): typeof childProcess.spawn {
  return ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args: [...args], env: options.env ?? {} });
    const child = childProcess.spawn(command, args as string[], options as Parameters<typeof childProcess.spawn>[2]) as ChildProcess;
    spawned.push(child);
    return child;
  }) as unknown as typeof childProcess.spawn;
}

function context(): { context: NativeProcessServiceContext; events: string[] } {
  const events: string[] = [];
  return {
    events,
    context: {
      logger: { info: (message) => { events.push(`info:${message}`); } },
      serviceHealth: {
        reportFailure: (error) => { events.push(`failure:${error.message}`); },
        clearFailure: () => { events.push('clear'); },
      },
    },
  };
}

function sweepCount(fx: Fixture): number {
  try {
    return readFileSync(fx.counterPath, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function readEnvDump(fx: Fixture): Record<string, string> {
  const dump = readFileSync(fx.envPath, 'utf8').split('\n').filter(Boolean);
  const out: Record<string, string> = {};
  for (const line of dump) {
    const index = line.indexOf('=');
    out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Wait for `count` sweeps that have STARTED and for every spawned child to have
 * exited. The counter is written by the script itself, so the count can be
 * visible a few milliseconds before the process actually leaves.
 */
async function waitForSweeps(fx: Fixture, spawned: ChildProcess[], count: number): Promise<void> {
  await waitUntil(
    () => sweepCount(fx) >= count
      && spawned.length >= count
      && spawned.every((child) => child.exitCode !== null || child.signalCode !== null),
    `${count} completed sweeps`,
  );
}

async function waitForFailure(events: string[]): Promise<void> {
  await waitUntil(
    () => events.some((event) => event.startsWith('failure:') && event.includes('failed to become ready')),
    'the bounded sweep failure',
    10_000,
  );
}

describe('native transcription temp cleanup service', () => {
  test('declares the sweep identity and its single reload prefix', () => {
    const service = createNativeTranscriptionCleanupService({
      initialPluginConfig: {},
      scriptPath: '/bin/true',
    });
    expect(service.id).toBe('olympus-transcription-temp-cleanup');
    expect(service.reload.configPrefixes).toEqual([
      'plugins.entries.olympus.config.worker.transcriptionCleanup',
    ]);
  }, 15_000);

  test('defaults resolve the packaged sweep script and a 1800s interval', async () => {
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const service = createNativeTranscriptionCleanupService({
      initialPluginConfig: {},
      moduleUrl: import.meta.url,
      spawn: countingSpawn(calls),
    });
    // Disabled by default: nothing is spawned, so no default path escapes.
    await service.start({});
    expect(calls).toHaveLength(0);
    // The packaged script path is the repository's own sweep wrapper.
    const packaged = new URL('../config/systemd/user/olympus-whisper-transcribe.sh', import.meta.url).pathname;
    expect(existsSync(packaged)).toBe(true);
    expect(packaged.endsWith('/config/systemd/user/olympus-whisper-transcribe.sh')).toBe(true);
  }, 15_000);

  test('decodes spaces in the packaged script URL', async () => {
    const fx = fixture();
    const packageRoot = join(fx.root, 'plugin package');
    const script = fixtureScript(fx, 'exit 0');
    const targetDir = join(packageRoot, 'config/systemd/user');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'olympus-whisper-transcribe.sh'), readFileSync(script));
    const service = track(createNativeTranscriptionCleanupService({
      initialPluginConfig: pluginConfig(fx),
      moduleUrl: pathToFileURL(join(packageRoot, 'dist/index.js')).href,
    }));
    const run = context();
    await service.start(run.context);
    await waitUntil(() => run.events.includes('clear'), 'packaged script completion');
    await service.stop();
    expect(sweepCount(fx)).toBe(1);
  }, 15_000);

  test('runs the sweep immediately, completes on a clean exit, and waits a full interval', async () => {
    const fx = fixture();
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const spawned: ChildProcess[] = [];
    const service = serviceFor(fx, pluginConfig(fx, { intervalSeconds: 60, minAgeMinutes: 60 }), {
      spawn: countingSpawn(calls, spawned),
    });
    const run = context();

    await service.start(run.context);
    await waitUntil(() => run.events.includes('clear'), 'the first completed sweep');

    // The command is the configured absolute bash running the packaged script
    // with exactly `--sweep`; the service reimplements no delete logic.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/bin/bash');
    expect(calls[0]?.args).toEqual([join(fx.root, 'sweep.sh'), '--sweep']);
    expect(calls[0]?.args.at(-1)).toBe('--sweep');

    // A finite job's completion is readiness: no external service, no receipt.
    // The only intermediate health is the categorical "is starting" marker.
    expect(run.events).toContain('info:Olympus transcription temp cleanup is running.');
    expect(run.events).toEqual([
      'info:Olympus transcription temp cleanup is running.',
      'failure:Olympus transcription temp cleanup is starting.',
      'clear',
      'info:Olympus transcription temp cleanup completed a clean exit.',
    ]);

    // The next tick is not immediate: it waits the configured interval.
    await Bun.sleep(200);
    expect(sweepCount(fx)).toBe(1);
    await waitForSweeps(fx, spawned, 2);
    await service.stop();
    expect(calls).toHaveLength(2);
  }, 15_000);

  test('never overlaps a slow sweep with its successor', async () => {
    const fx = fixture();
    const service = serviceFor(fx, pluginConfig(fx, { intervalSeconds: 60 }), {
      scriptPath: fixtureScript(fx, 'sleep 0.6'),
    });
    const run = context();
    await service.start(run.context);
    await waitUntil(() => run.events.filter((event) => event === 'clear').length >= 2, 'two completed sequential sweeps');
    await service.stop();
    // Each sweep removed its own marker before the next one started: no tick
    // began while its predecessor was still running.
    expect(existsSync(fx.markerPath)).toBe(false);
    expect(sweepCount(fx)).toBeLessThanOrEqual(3);
  }, 15_000);

  test('stop cancels the start before its initial asynchronous boundary resumes', async () => {
    const fx = fixture();
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const service = serviceFor(fx, pluginConfig(fx, { intervalSeconds: 60 }), {
      scriptPath: fixtureScript(fx, 'sleep 5'),
      spawn: countingSpawn(calls),
    });

    const starting = service.start({});
    await service.stop();
    await starting;
    // The epoch fence won: no sweep child was ever spawned.
    expect(calls).toHaveLength(0);
    expect(sweepCount(fx)).toBe(0);
  }, 15_000);

  test('sends only home/path/temp/locale plus the sweep knobs to the child', async () => {
    const fx = fixture();
    rememberEnv('UNRELATED_VALUE');
    rememberEnv('OLYMPUS_WORKER_AUTH_TOKEN');
    rememberEnv('TMPDIR');
    process.env.UNRELATED_VALUE = 'unrelated-secret';
    process.env.OLYMPUS_WORKER_AUTH_TOKEN = 'worker-token';
    const env: NodeJS.ProcessEnv = {
      HOME: '/home/olympus-operator',
      PATH: '/usr/bin:/bin:/usr/local/bin',
      TMPDIR: fx.root,
      LANG: 'en_US.UTF-8',
    };
    const saved = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
    };
    Object.assign(process.env, env);
    try {
      const service = serviceFor(fx, pluginConfig(fx, { intervalSeconds: 60, minAgeMinutes: 120 }), {
        scriptPath: fixtureScript(fx, 'exit 0'),
      });
      const run = context();
      await service.start(run.context);
      await waitUntil(() => run.events.includes('clear'), 'completed environment dump');
      const dumped = readEnvDump(fx);
      expect(dumped.HOME).toBe('/home/olympus-operator');
      expect(dumped.PATH).toBe('/usr/bin:/bin:/usr/local/bin');
      expect(dumped.TMPDIR).toBe(fx.root);
      expect(dumped.LANG).toBe('en_US.UTF-8');
      expect(dumped.OLYMPUS_TRANSCRIBE_TMP_ROOT).toBe(fx.tempRoot);
      expect(dumped.OLYMPUS_TRANSCRIBE_SWEEP_AGE_MINUTES).toBe('120');
      // The child saw exactly these names: no worker.env, no credential, no
      // host service-wrapper knob, and no unrelated ambient value.
      expect(Object.keys(dumped).sort()).toEqual([...CLEANUP_ENV_NAMES].sort());
      expect(readFileSync(fx.envPath, 'utf8')).not.toContain('unrelated-secret');
      expect(readFileSync(fx.envPath, 'utf8')).not.toContain('worker-token');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 15_000);

  test('defaults the sweep age and temp root when the config omits them', async () => {
    const fx = fixture();
    const service = serviceFor(fx, {
      worker: { transcriptionCleanup: { enabled: true, tempRoot: fx.tempRoot } },
    }, { scriptPath: fixtureScript(fx, 'exit 0') });
    await service.start({});
    await waitUntil(() => existsSync(fx.envPath), 'the environment dump');
    expect(readEnvDump(fx).OLYMPUS_TRANSCRIBE_SWEEP_AGE_MINUTES).toBe('1440');
  }, 15_000);

  test('stays idle while the sweep is disabled', async () => {
    const fx = fixture();
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const service = serviceFor(fx, pluginConfig(fx, { enabled: false }), {
      spawn: countingSpawn(calls),
    });
    await service.start({});
    await Bun.sleep(100);
    expect(calls).toHaveLength(0);
    expect(sweepCount(fx)).toBe(0);
  }, 15_000);

  test('fresh runtime config wins and a removal disables the sweep', async () => {
    const fx = fixture();
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const stale = pluginConfig(fx, { intervalSeconds: 60 });
    const service = serviceFor(fx, stale, { scriptPath: fixtureScript(fx, 'exit 0'), spawn: countingSpawn(calls) });

    await service.start({ config: { plugins: { entries: { olympus: { config: stale } } } } });
    await waitUntil(() => sweepCount(fx) === 1, 'the registration-snapshot sweep');
    await service.stop();

    // A fresh context that no longer carries a plugin entry disables the sweep
    // instead of resurrecting the stale enabled registration snapshot.
    await service.start({ config: { plugins: { entries: { olympus: { config: { worker: { transcriptionCleanup: { enabled: false } } } } } } } });
    await Bun.sleep(150);
    expect(sweepCount(fx)).toBe(1);
    expect(calls).toHaveLength(1);
  }, 15_000);

  test('a nonzero sweep exit is a bounded failure and starts no fresh tick', async () => {
    const fx = fixture();
    const service = serviceFor(fx, pluginConfig(fx, { intervalSeconds: 60 }), {
      scriptPath: fixtureScript(fx, 'exit 3'),
    });
    const run = context();
    await service.start(run.context);
    await waitForFailure(run.events);
    await Bun.sleep(150);
    expect(sweepCount(fx)).toBe(1);
    expect(run.events).toContain('failure:Olympus transcription temp cleanup failed to become ready.');
  }, 15_000);

  test('a sweep that outlives maxRuntimeSeconds fails categorically and is stopped', async () => {
    const fx = fixture();
    const spawned: ChildProcess[] = [];
    const service = serviceFor(fx, pluginConfig(fx, { intervalSeconds: 60, maxRuntimeSeconds: 1 }), {
      scriptPath: fixtureScript(fx, 'sleep 30'),
      spawn: countingSpawn([], spawned),
    });
    const run = context();
    await service.start(run.context);
    await waitForFailure(run.events);
    expect(run.events).toContain('failure:Olympus transcription temp cleanup failed to become ready.');
    // Timeout stops the owned process; it does not promise to delete the child's files.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.exitCode !== null || spawned[0]!.signalCode !== null).toBe(true);
    await service.stop();
  }, 15_000);

  test('unknown keys and wrong types are rejected by the strict parser', async () => {
    const cases: Array<Record<string, unknown>> = [
      { unrelatedKnob: 'value' },
      { intervalSeconds: 0 },
      { intervalSeconds: 1.5 },
      { maxRuntimeSeconds: '120' },
      { minAgeMinutes: -1 },
      { employeeSecretPath: '/tmp/credentials' },
    ];
    for (const override of cases) {
      const fx = fixture();
      const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
      const service = serviceFor(fx, pluginConfig(fx, override), { spawn: countingSpawn(calls) });
      const run = context();
      await service.start(run.context);
      await Bun.sleep(20);
      expect(calls).toHaveLength(0);
      expect(run.events).toHaveLength(1);
      expect(run.events[0]).toMatch(/^failure:Olympus transcription temp cleanup configuration is invalid\.$/);
      await service.stop();
    }
  }, 15_000);

  test('relative script and temp-root paths fail closed with the path they violated', async () => {
    const cases: Array<{ override: Record<string, unknown>; message: string }> = [
      {
        override: { tempRoot: 'relative/tmp' },
        message: 'failure:Olympus transcription temp cleanup configuration is invalid.',
      },
      {
        override: { bashPath: 'bash' },
        message: 'failure:Olympus transcription temp cleanup configuration is invalid.',
      },
    ];
    for (const { override, message } of cases) {
      const fx = fixture();
      const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
      const service = serviceFor(fx, pluginConfig(fx, override), { spawn: countingSpawn(calls) });
      const run = context();
      await service.start(run.context);
      await Bun.sleep(20);
      expect(calls).toHaveLength(0);
      expect(run.events).toEqual([message]);
      await service.stop();
    }
  }, 15_000);

  test('the fresh context config with a relative temp root fails closed without a sweep', async () => {
    const fx = fixture();
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const service = serviceFor(fx, pluginConfig(fx), { spawn: countingSpawn(calls) });
    const run = context();
    await service.start({ ...run.context, config: { worker: { transcriptionCleanup: { enabled: true, tempRoot: 'not-absolute' } } } });
    expect(calls).toHaveLength(0);
    expect(run.events).toEqual([
      'failure:Olympus transcription temp cleanup configuration is invalid.',
    ]);
  }, 15_000);

  test('the spawn seam sees exactly one finite job per tick', async () => {
    const fx = fixture();
    const spawned: ChildProcess[] = [];
    const spawn = ((command: string, args: readonly string[], options: object) => {
      const child = childProcess.spawn(command, args as string[], options as Parameters<typeof childProcess.spawn>[2]);
      spawned.push(child);
      return child;
    }) as unknown as typeof childProcess.spawn;
    const service = serviceFor(fx, pluginConfig(fx, { intervalSeconds: 60 }), {
      scriptPath: fixtureScript(fx, 'exit 0'),
      spawn,
    });
    await service.start({});
    await waitForSweeps(fx, spawned, 1);
    const first = spawned[0];
    expect(first?.exitCode).toBe(0);
    expect(first?.signalCode).toBeNull();
    // Completion leaves no live child and no fresh launch behind between ticks:
    // the next tick is still a full interval away.
    await Bun.sleep(200);
    expect(spawned).toHaveLength(1);
    expect(sweepCount(fx)).toBe(1);
    await service.stop();
  }, 15_000);
});

interface SyntheticCleanupChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function syntheticCleanupHarness(options: { denied?: boolean; delayMs?: number } = {}) {
  const children: SyntheticCleanupChild[] = [];
  let live = 0;
  let maxLive = 0;
  let deny = options.denied ?? false;
  const realKill = process.kill;
  process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    const child = children.find((entry) => entry.pid === -pid);
    if (!child) return realKill(pid, signal);
    if (deny) throw Object.assign(new Error('synthetic denied'), { code: 'EPERM' });
    if (child.signalCode === null && child.exitCode === null && signal !== 0) {
      setTimeout(() => {
        if (child.signalCode !== null || child.exitCode !== null) return;
        child.signalCode = (signal ?? 'SIGTERM') as NodeJS.Signals;
        live -= 1;
        child.emit('exit', null, child.signalCode);
      }, options.delayMs ?? 0);
    }
    return true;
  }) as typeof process.kill;
  const spawn = (() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 970000 + children.length,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
    children.push(child);
    live += 1;
    maxLive = Math.max(maxLive, live);
    return child;
  }) as unknown as typeof childProcess.spawn;
  return {
    children, spawn,
    maxLive: () => maxLive,
    allowCleanup: () => { deny = false; },
    restore: () => { process.kill = realKill; },
  };
}

test('concurrent stop and start share retirement before another sweep can launch', async () => {
  const fixture = syntheticCleanupHarness({ delayMs: 120 });
  const service = createNativeTranscriptionCleanupService({
    initialPluginConfig: { worker: { transcriptionCleanup: { enabled: true, maxRuntimeSeconds: 5 } } },
    scriptPath: '/synthetic/unused.sh', spawn: fixture.spawn,
  });
  try {
    await service.start({});
    await waitUntil(() => fixture.children.length === 1, 'first synthetic sweep');
    const stopped = service.stop();
    const restarted = service.start({});
    await Promise.all([stopped, restarted]);
    await waitUntil(() => fixture.children.length === 2, 'replacement synthetic sweep');
    expect(fixture.maxLive()).toBe(1);
  } finally {
    fixture.allowCleanup();
    try { await service.stop(); } finally { fixture.restore(); }
  }
}, 15_000);

test('failed cleanup retains custody and blocks replacement until the old child is stopped', async () => {
  const fixture = syntheticCleanupHarness({ denied: true });
  const events: string[] = [];
  const service = createNativeTranscriptionCleanupService({
    initialPluginConfig: { worker: { transcriptionCleanup: { enabled: true, maxRuntimeSeconds: 1 } } },
    scriptPath: '/synthetic/unused.sh', spawn: fixture.spawn, intervalMs: 5,
  });
  try {
    await service.start({ serviceHealth: { reportFailure: error => { events.push(error.message); }, clearFailure() {} } });
    await waitUntil(() => events.some((message) => message.includes('could not stop its owned process group')), 'blocked cleanup');
    await Bun.sleep(30);
    expect(fixture.children).toHaveLength(1);
    expect(fixture.children[0]!.signalCode).toBeNull();
    await expect(service.start({})).rejects.toThrow('synthetic denied');
    expect(fixture.children).toHaveLength(1);
    fixture.allowCleanup();
    await service.start({});
    await waitUntil(() => fixture.children.length === 2, 'replacement after successful cleanup');
    expect(fixture.children[0]!.signalCode).not.toBeNull();
    expect(fixture.maxLive()).toBe(1);
  } finally {
    fixture.allowCleanup();
    try { await service.stop(); } finally { fixture.restore(); }
  }
}, 15_000);
