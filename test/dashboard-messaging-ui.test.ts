import { expect, test } from 'bun:test';
import { renderMessagingCard } from '../src/workers/dashboard/messaging.ts';

test('only a local control session gets pairing and chat-scope controls', () => {
  expect(renderMessagingCard('telegram', false)).not.toContain('data-messaging-kind');
  const html = renderMessagingCard('telegram', true);
  expect(html).toContain('data-messaging-kind="start"');
  expect(html).toContain('data-messaging-kind="chats"');
  expect(html).toContain('Each message is classified on its own');
});

test('WhatsApp has a local QR slot and pairing never uses native form navigation', () => {
  const html = renderMessagingCard('whatsapp', true);
  expect(html).toContain('data-messaging-qr');
  expect(html).toContain('hidden');
  expect(html).toContain('method="dialog"');
});

test('main Connect landing can focus the matching local messaging card', () => {
  expect(renderMessagingCard('telegram', true)).toContain('data-source="telegram.messages"');
  expect(renderMessagingCard('whatsapp', true)).toContain('data-source="whatsapp.personal.messages"');
});

test('paired sources keep the chat picker when their connection action is none', async () => {
  const { renderDashboardKeysPage } = await import('../src/workers/dashboard/pages/local.ts');
  const view = {
    generated_at: new Date().toISOString(),
    sources: ['telegram.messages', 'whatsapp.personal.messages'].map(source_id => ({ source_id, connection: { action: { kind: 'none' } } })),
  } as unknown as Parameters<typeof renderDashboardKeysPage>[0];
  const page = renderDashboardKeysPage(view, { controlSessionCsrfToken: 'csrf-test', messagingLocalSession: true });
  expect(page.match(/data-messaging-kind="chats"/g)).toHaveLength(2);
});

test('a bearer dashboard offers a local controls entry without any credential fields', () => {
  const html = renderMessagingCard('telegram', false);
  expect(html).toContain('data-messaging-open-controls');
  expect(html).toContain('Open controls on this computer');
  expect(html).not.toContain('<input');
});

test('messaging card keeps pair, choose chats and cancel in one action row', () => {
  const html = renderMessagingCard('telegram', true);
  expect(html).toMatch(/class="actionrow">[\s\S]*data-messaging-kind="start"[\s\S]*data-messaging-kind="chats"[\s\S]*data-messaging-kind="cancel"[\s\S]*?<\/div><div data-messaging-view>/);
});
