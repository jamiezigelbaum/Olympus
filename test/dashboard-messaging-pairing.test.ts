import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { listHelper, unlinkHelper } from '../src/workers/engine/dashboard/dashboard-messaging-service.ts';
import { codedError, createDashboardMessagingPairing } from '../src/workers/engine/dashboard/dashboard-messaging.ts';

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

describe('what a WhatsApp pairing shows after the scan', () => {
  test('a linked phone clears the spent QR and says Olympus is reading the chat list', async () => {
    let linked!: () => void;
    const listing = new Promise<void>((resolve) => { linked = resolve; });
    const manager = createDashboardMessagingPairing({
      pair: async (_source, hooks) => {
        hooks.qr('data:image/png;base64,AAAA');
        await listing;
        hooks.linked();
        return await new Promise<never>(() => {});
      },
      publish: async () => {},
    });
    manager.start('whatsapp');
    await Promise.resolve();
    expect(manager.status('whatsapp')).toMatchObject({ state: 'waiting', qr: 'data:image/png;base64,AAAA' });
    linked();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = manager.status('whatsapp');
    expect(status).toMatchObject({ state: 'starting', linked: true });
    expect(status).not.toHaveProperty('qr');
    manager.cancel('whatsapp');
  });

  test('a failure keeps its fixed code, shows it and logs only it', async () => {
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => { warned.push(line); };
    try {
      const manager = createDashboardMessagingPairing({
        pair: async () => { throw codedError('Chat listing failed at /Users/mark/secret path', 'chat_list_connect_failed'); },
        publish: async () => {},
      });
      manager.start('whatsapp');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(manager.status('whatsapp')).toMatchObject({ state: 'failed', reason: 'chat_list_connect_failed' });
      expect(warned).toEqual(['[messaging] whatsapp pairing failed: chat_list_connect_failed']);
      // A failure with no code says only that it was unexpected; its message never reaches the status.
      const other = createDashboardMessagingPairing({ pair: async () => { throw new Error('/Users/mark/x'); }, publish: async () => {} });
      other.start('whatsapp');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(other.status('whatsapp')).toMatchObject({ state: 'failed', reason: 'unexpected' });
      expect(JSON.stringify(other.status('whatsapp'))).not.toContain('mark');
    } finally {
      console.warn = warn;
    }
  });
});

describe('Copy details on a failed pairing', () => {
  test('lists version, OS, the failure and recent attempts, and nothing from the account', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      let attempt = 0;
      const manager = createDashboardMessagingPairing({
        identity: { version: '1.3.1', os: 'macOS (kernel 25.1.0, arm64)' },
        now: () => new Date(Date.UTC(2026, 10, 3, 9, attempt)),
        pair: async (_source, hooks) => {
          attempt += 1;
          hooks.qr('data:image/png;base64,AAAA');
          hooks.linked();
          const error = codedError('Listing failed for Mark +351 912 at /Users/mark/.local/share', attempt === 1 ? 'chat_list_timeout' : 'chat_list_exit_3') as Error & { unlinked?: string };
          error.unlinked = 'removed';
          throw error;
        },
        publish: async () => {},
      });
      expect(manager.status('whatsapp')).not.toHaveProperty('details');
      for (let i = 0; i < 2; i++) {
        manager.start('whatsapp');
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const status = manager.status('whatsapp') as { details?: string };
      expect(status.details).toBe([
        'Olympus 1.3.1',
        'OS: macOS (kernel 25.1.0, arm64)',
        'Source: whatsapp',
        'State: failed',
        'Failure: chat_list_exit_3',
        'Phone accepted the QR: yes',
        'Phone entry: removed',
        'Recent attempts:',
        '  2026-11-03T09:01:00.000Z chat_list_timeout',
        '  2026-11-03T09:02:00.000Z chat_list_exit_3',
      ].join('\n'));
      expect(status.details).not.toMatch(/mark|351|Users/i);
    } finally {
      console.warn = warn;
    }
  });

  test('keeps the last five attempts and shows details only after a failure', async () => {
    let fail = true;
    const manager = createDashboardMessagingPairing({
      pair: async (_source, hooks) => {
        if (fail) throw new Error('x');
        return await new Promise<never>((_resolve, reject) => hooks.signal.addEventListener('abort', () => reject(new Error('cancelled'))));
      },
      publish: async () => {},
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 7; i++) {
        manager.start('telegram');
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally { console.warn = warn; }
    const details = (manager.status('telegram') as { details: string }).details;
    expect(details.split('\n').filter(line => line.startsWith('  ')).length).toBe(5);
    expect(details).toContain('Olympus unknown');
    expect(details).not.toContain('Phone accepted');
    fail = false;
    manager.start('telegram');
    await Promise.resolve();
    expect(manager.status('telegram')).not.toHaveProperty('details');
    manager.cancel('telegram');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.status('telegram')).not.toHaveProperty('details');
    // The cancelled attempt still counts in the next failure's history.
    fail = true;
    manager.start('telegram');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((manager.status('telegram') as { details: string }).details).toMatch(/ cancelled\n.* unexpected$/);
  });
});

test('a cancel says cleanup is still running until the pairing task ends', async () => {
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => { finish = resolve; });
  // Unlinking happens inside pair's catch; model it as a task that ends later.
  const slow = createDashboardMessagingPairing({
    pair: async (_source, hooks) => {
      try { return await new Promise<never>((_resolve, reject) => hooks.signal.addEventListener('abort', () => reject(new Error('cancelled')))); }
      catch (error) { await cleanup; Object.assign(error as Error, { unlinked: 'offline' }); throw error; }
    },
    publish: async () => {},
  });
  slow.start('whatsapp');
  await Promise.resolve();
  expect(slow.cancel('whatsapp')).toMatchObject({ state: 'cancelled', cleaning: true });
  finish();
  await slow.cancelAndWait('whatsapp');
  const done = slow.status('whatsapp');
  expect(done).toMatchObject({ state: 'cancelled', unlinked: 'offline' });
  expect(done).not.toHaveProperty('cleaning');
});

describe('the WhatsApp chat listing', () => {
  const script = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-list-'));
    const path = join(dir, 'bridge');
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return path;
  };
  const code = (error: unknown) => (error as { code?: string }).code;

  test('a failed listing carries the bridge\'s fixed code, never its other text', async () => {
    const bridge = script("echo 'Database WARN /Users/mark/x' >&2; echo 'olympus-whatsapp-bridge: connect_failed' >&2; exit 1");
    const failure = await listHelper(bridge, [], {}).catch((error) => error);
    expect(code(failure)).toBe('chat_list_connect_failed');
    expect(String((failure as Error).message)).not.toContain('mark');
  });

  test('output that is not the listing says so', async () => {
    const bridge = script("echo 'Database WARN something'; echo '{\"dialogs\":[]}'");
    expect(code(await listHelper(bridge, [], {}).catch((error) => error))).toBe('chat_list_unreadable');
  });

  test('a listing that succeeds is returned', async () => {
    const bridge = script("echo '{\"event\":\"dialogs\",\"dialogs\":[]}'");
    expect(await listHelper(bridge, [], {})).toEqual({ event: 'dialogs', dialogs: [] });
  });
});

describe('unlinking a device a failed pairing linked', () => {
  test('a clean exit is removed; unlink_offline is offline; anything else failed', async () => {
    const run = (body: string) => listHelperScript(body);
    expect(await unlinkHelper(run('exit 0'), {})).toBe('removed');
    expect(await unlinkHelper(run("echo 'olympus-whatsapp-bridge: unlink_offline' >&2; exit 1"), {})).toBe('offline');
    expect(await unlinkHelper(run("echo 'olympus-whatsapp-bridge: session_busy' >&2; exit 1"), {})).toBe('failed');
  });

  test('the bridge is asked to unlink, against the state folder it is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-unlink-'));
    const seen = join(dir, 'seen');
    const bridge = listHelperScript(`printf '%s %s' "$1" "$OLYMPUS_WHATSAPP_STATE_DIR" > '${seen}'`);
    expect(await unlinkHelper(bridge, { OLYMPUS_WHATSAPP_STATE_DIR: '/state/here' })).toBe('removed');
    expect(readFileSync(seen, 'utf8')).toBe('--unlink /state/here');
  });
});

function listHelperScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wa-bridge-'));
  const path = join(dir, 'bridge');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return path;
}
