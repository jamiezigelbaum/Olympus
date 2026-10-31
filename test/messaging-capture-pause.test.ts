import { expect, test } from 'bun:test';
import { createWorkerMessagingCaptureOwnership } from '../src/workers/email-source/server.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('pairing waits for in-flight reconcile, stops capture, excludes ticks and resumes without revoking grant', async () => {
  const readStarted = deferred();
  const finishRead = deferred();
  const pairingStarted = deferred();
  const finishPairing = deferred();
  const events: string[] = [];
  let first = true;
  const ownership = createWorkerMessagingCaptureOwnership({
    env: {}, registryPath: '/fixture/handles.json', packageRoot: '/fixture',
    revokeGrant: () => { events.push('revoke'); },
    createSupervisor: () => ({
      reconcile: async () => {
        events.push('reconcile');
        if (first) { first = false; readStarted.resolve(); await finishRead.promise; }
        return { state: 'running' };
      },
      stop: async () => { events.push('stop'); },
    }),
  });
  const reading = ownership.captures.telegram!.reconcile();
  await readStarted.promise;
  const pairing = ownership.withMessagingCapturePaused('telegram', async () => {
    events.push('pairing'); pairingStarted.resolve(); await finishPairing.promise; return 42;
  });
  await ownership.captures.telegram!.reconcile();
  expect(events).toEqual(['reconcile']);
  finishRead.resolve();
  await reading;
  await pairingStarted.promise;
  expect(events).toEqual(['reconcile', 'stop', 'pairing']);
  await ownership.captures.telegram!.reconcile();
  expect(events).toEqual(['reconcile', 'stop', 'pairing']);
  finishPairing.resolve();
  expect(await pairing).toBe(42);
  expect(events).toEqual(['reconcile', 'stop', 'pairing', 'reconcile']);
});

test('pairing resumes after a failed operation and refuses native capture owners', async () => {
  const events: string[] = [];
  const ownership = createWorkerMessagingCaptureOwnership({
    env: { OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER: 'true' }, registryPath: '/fixture/handles.json', packageRoot: '/fixture',
    createSupervisor: () => ({ reconcile: async () => { events.push('resume'); return { state: 'running' }; }, stop: async () => { events.push('stop'); } }),
  });
  await expect(ownership.withMessagingCapturePaused('telegram', async () => { events.push('forbidden'); })).rejects.toThrow();
  expect(events).toEqual([]);
  await expect(ownership.withMessagingCapturePaused('whatsapp', async () => { throw new Error('pairing failed'); })).rejects.toThrow('pairing failed');
  expect(events).toEqual(['stop', 'resume']);
});

test('failed stop keeps pairing out of the session and shutdown prevents resume', async () => {
  let runOperation = false;
  let resumes = 0;
  let failStop = true;
  const ownership = createWorkerMessagingCaptureOwnership({
    env: {}, registryPath: '/fixture/handles.json', packageRoot: '/fixture', shouldResumeCapture: () => false,
    createSupervisor: () => ({
      reconcile: async () => { resumes += 1; return { state: 'running' }; },
      stop: async () => { if (failStop) throw new Error('custody retained'); },
    }),
  });
  await expect(ownership.withMessagingCapturePaused('telegram', async () => { runOperation = true; })).rejects.toThrow('custody retained');
  expect(runOperation).toBe(false);
  failStop = false;
  await ownership.withMessagingCapturePaused('telegram', async () => { runOperation = true; });
  expect(runOperation).toBe(true);
  expect(resumes).toBe(0);
});

test('a resume failure is reported without hiding an operation that already succeeded', async () => {
  const failures: string[] = [];
  const ownership = createWorkerMessagingCaptureOwnership({
    env: {}, registryPath: '/fixture/handles.json', packageRoot: '/fixture',
    onResumeFailure: (source) => { failures.push(source); },
    createSupervisor: () => ({ reconcile: async () => { throw new Error('cannot start'); }, stop: async () => {} }),
  });
  expect(await ownership.withMessagingCapturePaused('telegram', async () => 'saved')).toBe('saved');
  expect(failures).toEqual(['telegram']);
});
