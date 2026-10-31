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
});
