import { describe, expect, test } from 'bun:test';
import { createDashboardMessagingPairing } from '../src/workers/email-source/dashboard-messaging.ts';

describe('dashboard messaging pairing', () => {
  test('keeps prompt values out of status and prevents duplicate or stale replies', async () => {
    let answer: ((value: string) => void) | undefined;
    let published = false;
    const manager = createDashboardMessagingPairing({
      pair: async (_source, hooks) => {
        const code = await new Promise<string>((resolve) => { answer = resolve; hooks.prompt('code', resolve); });
        expect(code).toBe('test-code');
        return { chats: [] };
      },
      publish: async () => { published = true; },
    });
    expect(manager.start('telegram').state).toBe('starting');
    await Promise.resolve();
    expect(manager.status('telegram')).toMatchObject({ field: 'code' });
    expect(() => manager.respond('telegram', 'password', 'bad')).toThrow();
    manager.respond('telegram', 'code', 'test-code');
    expect(answer).toBeDefined();
    expect(JSON.stringify(manager.status('telegram'))).not.toContain('test-code');
    expect(() => manager.respond('telegram', 'code', 'test-code')).toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.status('telegram').state).toBe('paired');
    expect(published).toBe(true);
  });

  test('cancelling before registration keeps selection busy until pairing has stopped', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const publishing = new Promise<void>((resolve) => { entered = resolve; });
    let saved = false;
    const manager = createDashboardMessagingPairing({
      pair: async () => { entered(); await held; return { chats: [] }; },
      publish: async () => { saved = true; },
    });
    manager.start('telegram');
    await publishing;
    manager.cancel('telegram');
    expect(manager.busy('telegram')).toBe(true);
    release();
    await manager.cancelAndWait('telegram');
    expect(saved).toBe(false);
    expect(manager.busy('telegram')).toBe(false);
  });
});

test('cancellation after registration begins waits for the grant to publish', async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const committed = new Promise<void>((resolve) => { entered = resolve; });
  let saved = false;
  const manager = createDashboardMessagingPairing({
    pair: async (_source, hooks) => { hooks.commit(); entered(); await held; return { chats: [] }; },
    publish: async () => { saved = true; },
  });
  manager.start('telegram');
  await Promise.race([committed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Registration did not begin')), 1000))]);
  manager.cancel('telegram');
  release();
  await manager.cancelAndWait('telegram');
  expect(saved).toBe(true);
  expect(manager.status('telegram').state).toBe('paired');
});

test('cancelling the post-pair choice releases the waiting task without publishing', async () => {
  let published = false;
  const manager = createDashboardMessagingPairing({
    pair: async (_source, hooks) => { await hooks.choose([{ chatScope: 'telegram.personal:chat:1', title: 'One', kind: 'dm' }]); return { chats: [] }; },
    publish: async () => { published = true; },
  });
  manager.start('telegram');
  await Promise.resolve();
  expect(manager.status('telegram').state).toBe('scope_selection_required');
  await manager.cancelAndWait('telegram');
  expect(manager.status('telegram').state).toBe('cancelled');
  expect(manager.busy('telegram')).toBe(false);
  expect(published).toBe(false);
  expect(() => manager.select('telegram', { wholeAccount: true, chatScopes: [] })).toThrow();
});
