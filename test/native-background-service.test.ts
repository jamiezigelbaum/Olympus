import { expect, test } from 'bun:test';
import { backgroundNativeProcessService, createNativeProcessService, NativeProcessConfigurationError } from '../src/core/native-process-service.ts';

test('native registration returns promptly while readiness and stop remain owned', async () => {
  const health: string[] = [];
  let allowReady = false;
  const supervisor = createNativeProcessService({
    id: 'fixture', label: 'fixture', initialConfig: {}, reload: { configPrefixes: [] },
    readinessPollMs: 10, stopGraceMs: 50,
    async prepareStart() { return {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
      env: {}, startupTimeoutMs: 2000, endpointOccupied: false,
      async readinessProbe() { return allowReady; },
    }; },
  });
  const service = backgroundNativeProcessService(supervisor);
  try {
    await Promise.race([
      service.start({ serviceHealth: { reportFailure(e) { health.push(e.message); }, clearFailure() { health.push('ready'); } } }),
      Bun.sleep(250).then(() => { throw new Error('host start waited for child readiness'); }),
    ]);
    await Bun.sleep(30);
    expect(health).toEqual(['Olympus fixture is starting.']);
    allowReady = true;
    const deadline = Date.now() + 2000;
    while (!health.includes('ready') && Date.now() < deadline) await Bun.sleep(10);
    expect(health.at(-1)).toBe('ready');
  } finally { await service.stop(); }
});

test('background startup failures remain visible without leaking raw errors', async () => {
  const failures: string[] = [];
  const service = backgroundNativeProcessService({
    id: 'fixture', reload: { configPrefixes: [] },
    async start() { throw new Error('private-spawn-sentinel'); },
    async stop() {},
  });
  await service.start({ serviceHealth: { reportFailure(e) { failures.push(e.message); }, clearFailure() {} } });
  await Bun.sleep(10);
  expect(failures).toEqual(['Olympus service fixture failed to start.']);
});


test('retirement from the initializing health callback prevents a stale child spawn', async () => {
  let spawned = false;
  let stop: Promise<void> | undefined;
  const service = createNativeProcessService({
    id: 'fixture', label: 'fixture', initialConfig: {}, reload: { configPrefixes: [] },
    spawn: (() => { spawned = true; throw new Error('must not spawn'); }) as never,
    async prepareStart() { return {
      command: process.execPath, args: [], env: {}, startupTimeoutMs: 100,
      endpointOccupied: false, async readinessProbe() { return true; },
    }; },
  });
  await service.start({ serviceHealth: { reportFailure() { stop = service.stop(); }, clearFailure() {} } });
  await stop;
  expect(spawned).toBe(false);
});


test('retains an actionable configuration failure instead of replacing it with a generic error', async () => {
  const failures: string[] = [];
  const service = backgroundNativeProcessService(createNativeProcessService({
    id: 'fixture', label: 'fixture', initialConfig: {}, reload: { configPrefixes: [] },
    async prepareStart() { throw new NativeProcessConfigurationError('Configure the required resolved fixture credential.'); },
  }));
  await service.start({ serviceHealth: { reportFailure(e) { failures.push(e.message); }, clearFailure() {} } });
  await Bun.sleep(10);
  expect(failures).toEqual(['Configure the required resolved fixture credential.']);
});
