import { describe, expect, test } from 'bun:test';
import { createModelKeyReload } from '../src/core/model-key-reload.ts';

/** A reload whose timer the test fires, recording what happened in order. */
function reload(options: { managed?: boolean; shutdown?: () => Promise<void> } = {}) {
  const events: string[] = [];
  let fire: (() => void) | undefined;
  const request = createModelKeyReload({
    managed: options.managed ?? true,
    schedule: (run) => { fire = run; events.push('scheduled'); },
    shutdown: options.shutdown ?? (async () => { events.push('shutdown'); }),
    exit: (code) => { events.push(`exit ${code}`); },
  });
  const settle = async () => { fire!(); await new Promise((resolve) => setTimeout(resolve, 10)); };
  return { events, request, settle };
}

describe('a reload\'s before-exit hooks', () => {
  test('run after the shutdown has finished and before the exit, in the order asked', async () => {
    const r = reload();
    expect(r.request({ beforeExit: () => { r.events.push('first'); } })).toBe(true);
    expect(r.request({ beforeExit: async () => { r.events.push('second'); } })).toBe(true);

    await r.settle();

    expect(r.events).toEqual(['scheduled', 'shutdown', 'first', 'second', 'exit 75']);
  });

  test('a request that finds the reload already scheduled still adds its hook', async () => {
    const r = reload();
    r.request();
    r.request({ beforeExit: () => { r.events.push('late'); } });

    await r.settle();

    expect(r.events).toEqual(['scheduled', 'shutdown', 'late', 'exit 75']);
  });

  test('a hook that fails does not stop the others or the exit', async () => {
    const r = reload();
    r.request({ beforeExit: () => { throw new Error('hook failed'); } });
    r.request({ beforeExit: async () => { throw new Error('async hook failed'); } });
    r.request({ beforeExit: () => { r.events.push('survivor'); } });

    await r.settle();

    expect(r.events).toEqual(['scheduled', 'shutdown', 'survivor', 'exit 75']);
  });

  test('the hooks still run, and the worker still exits, when the shutdown fails', async () => {
    const r = reload({ shutdown: async () => { throw new Error('shutdown failed'); } });
    r.request({ beforeExit: () => { r.events.push('hook'); } });

    await r.settle();

    expect(r.events).toEqual(['scheduled', 'hook', 'exit 75']);
  });

  test('a worker that cannot restart itself runs no hook and does not schedule', () => {
    const r = reload({ managed: false });
    expect(r.request({ beforeExit: () => { throw new Error('must not run'); } })).toBe(false);
    expect(r.events).toEqual([]);
  });
});
