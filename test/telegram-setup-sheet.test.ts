import { expect, test } from 'bun:test';
import { renderMessagingCard } from '../src/workers/dashboard/messaging.ts';
import { createDashboardMessagingPairing, type PairingField } from '../src/workers/email-source/dashboard-messaging.ts';

test('local Telegram setup uses the shared three-step sheet before starting pairing', () => {
  const html = renderMessagingCard('telegram', true);
  expect(html).toContain('data-sheet-toggle="#telegram-setup"');
  expect(html).toContain('class="sheet" id="telegram-setup"');
  expect(html.match(/data-setup-panel/g)).toHaveLength(3);
  expect(html).toContain('Step 1 of 3');
  expect(html).toContain('data-setup-open="https://my.telegram.org/auth"');
  expect(html).toContain('data-setup-open="https://my.telegram.org/apps"');
  expect(html).toContain('API development tools');
  expect(html).toContain('api_id');
  expect(html).toContain('api_hash');
  expect(html).toContain('id="telegram-setup-form"');
  expect(html).toContain('form="telegram-setup-form"');
  expect(html).toContain('Check keys and continue');
  expect(html).toContain('data-messaging-setup-intro');
  expect(html).toContain('data-messaging-kind="cancel" hidden');
  expect(html).toContain('data-messaging-kind="start"');
  expect(html).toContain('data-messaging-input');
  expect(html).toContain('data-messaging-kind="chats"');
});

test('Telegram setup guidance and pairing inputs remain local and WhatsApp keeps its QR flow', () => {
  const remote = renderMessagingCard('telegram', false);
  expect(remote).not.toContain('data-setup-steps');
  expect(remote).not.toContain('data-messaging-input');
  const whatsapp = renderMessagingCard('whatsapp', true);
  expect(whatsapp).toContain('data-messaging-qr');
  expect(whatsapp).not.toContain('telegram-setup');
  expect(whatsapp).not.toContain('data-setup-steps');
});

test('Telegram startup prompts credentials then login, and requires an explicit chat choice', async () => {
  const fields: PairingField[] = ['api_id', 'api_hash', 'phone', 'code', 'password'];
  const values = ['12345', 'fixture-api-hash', '+15550123456', 'fixture-login-code', 'fixture-2fa'];
  let published = false;
  const manager = createDashboardMessagingPairing({
    pair: async (_source, hooks) => {
      for (const [index, field] of fields.entries()) {
        const answer = await new Promise<string>(resolve => hooks.prompt(field, resolve));
        expect(answer).toBe(values[index]!);
      }
      await hooks.choose([{ chatScope: 'telegram.personal:chat:42', title: 'Example chat', kind: 'dm' }]);
      return { chats: [] };
    },
    publish: async () => { published = true; },
  });
  expect(manager.start('telegram').state).toBe('starting');
  for (const [index, field] of fields.entries()) {
    await Promise.resolve();
    expect(manager.status('telegram')).toMatchObject({ state: 'waiting', field });
    manager.respond('telegram', field, values[index]!);
    for (const value of values) expect(JSON.stringify(manager.status('telegram'))).not.toContain(value);
  }
  await Promise.resolve();
  expect(manager.status('telegram').state).toBe('scope_selection_required');
  expect(published).toBe(false);
  manager.select('telegram', { wholeAccount: false, chatScopes: ['telegram.personal:chat:42'] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(manager.status('telegram').state).toBe('paired');
  expect(published).toBe(true);
});

test('Telegram startup failure reports failure without returning helper errors or credentials', async () => {
  const manager = createDashboardMessagingPairing({
    pair: async () => { throw new Error('provider rejected fixture-api-hash'); },
    publish: async () => { throw new Error('must not publish'); },
  });
  manager.start('telegram');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(manager.status('telegram')).toEqual({ ok: true, state: 'failed' });
});

test('cancelling Telegram credential entry clears prompts without publishing a connection', async () => {
  let published = false;
  const manager = createDashboardMessagingPairing({
    pair: async (_source, hooks) => {
      await new Promise<string>((resolve, reject) => {
        hooks.prompt('api_hash', resolve);
        hooks.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
      return { chats: [] };
    },
    publish: async () => { published = true; },
  });
  manager.start('telegram');
  await Promise.resolve();
  expect(manager.status('telegram')).toMatchObject({ state: 'waiting', field: 'api_hash' });
  await manager.cancelAndWait('telegram');
  expect(manager.status('telegram')).toEqual({ ok: true, state: 'cancelled' });
  expect(published).toBe(false);
  expect(() => manager.respond('telegram', 'api_hash', 'fixture-api-hash')).toThrow('No matching pairing prompt.');
});

test('Telegram status belongs above the walkthrough action row', () => {
  const html = renderMessagingCard('telegram', true);
  expect(html.indexOf('data-messaging-status')).toBeLessThan(html.indexOf('data-messaging-setup-intro'));
  expect(html.indexOf('data-messaging-status')).toBeLessThan(html.indexOf('data-setup-actions'));
});
