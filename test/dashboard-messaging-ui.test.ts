import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderMessagingCard } from '../src/workers/dashboard/messaging.ts';

test('only a local control session gets pairing and chat-scope controls', () => {
  expect(renderMessagingCard('telegram', false)).not.toContain('data-messaging-kind');
  const html = renderMessagingCard('telegram', true);
  expect(html).toContain('data-messaging-kind="start"');
  expect(html).toContain('data-messaging-kind="chats"');
  expect(html).toContain('Nothing is read until you choose');
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
  const { renderDashboardConnectPage } = await import('../src/workers/dashboard/pages/local.ts');
  const view = {
    generated_at: new Date().toISOString(),
    sources: ['telegram.messages', 'whatsapp.personal.messages'].map(source_id => ({ source_id, label: source_id, connection: { state: 'synced', action: { kind: 'none' } } })),
  } as unknown as Parameters<typeof renderDashboardConnectPage>[0];
  const page = renderDashboardConnectPage(view, { controlSessionCsrfToken: 'csrf-test', messagingLocalSession: true });
  const window = new Window();
  window.document.body.innerHTML = page;
  expect(window.document.querySelectorAll('form[data-messaging-kind="chats"]')).toHaveLength(2);
  expect(window.document.querySelectorAll('.msgmenu form[data-messaging-kind="status"]')).toHaveLength(2);
  expect(Array.from(window.document.querySelectorAll('.messaging-card > .actionrow > form:not([hidden]) > .primary')).map(button => button.textContent)).toEqual(['Choose chats', 'Choose chats']);
});

test('a bearer dashboard offers a local controls entry without any credential fields', () => {
  const html = renderMessagingCard('telegram', false);
  expect(html).toContain('data-messaging-open-controls');
  expect(html).toContain('Open controls on this computer');
  expect(html).not.toContain('<input');
});

test('WhatsApp keeps pair, choose chats and cancel in one action row', () => {
  const html = renderMessagingCard('whatsapp', true);
  expect(html).toMatch(/class="actionrow msgactions">[\s\S]*data-messaging-kind="start"[\s\S]*data-messaging-kind="chats"[\s\S]*data-messaging-kind="cancel"[\s\S]*?<\/div><div data-messaging-view>/);
});


test('Telegram before pairing: the explanation, one primary Pair, and the sign-in sheet outside the action row', () => {
  const window = new Window();
  window.document.body.innerHTML = renderMessagingCard('telegram', true);
  const card = window.document.querySelector('.messaging-card')!;
  const shown = (element: { closest(selector: string): unknown }) => !element.closest('[hidden]') && !element.closest('.sheet');
  expect([...card.querySelectorAll('.btn.primary')].filter(shown).map(button => button.textContent)).toEqual(['Pair Telegram']);
  expect(card.querySelector('[data-messaging-account]')!.textContent).toBe('Not paired yet');
  expect(card.querySelector('.msgintro')!.hasAttribute('hidden')).toBe(false);
  expect(card.querySelector('details.msgmenu')!.hasAttribute('hidden')).toBe(true);
  const pair = card.querySelector('.actionrow [data-sheet-toggle="#telegram-setup"]')!;
  expect(pair.textContent).toBe('Pair Telegram');
  const sheet = window.document.querySelector('#telegram-setup')!;
  expect(sheet.closest('.actionrow')).toBeNull();
  expect(sheet.querySelector('[data-messaging-kind="cancel"]')!.hasAttribute('hidden')).toBe(true);
});

for (const source of ['whatsapp', 'telegram'] as const) {
  test(`${source}: a linked account leads with Choose chats; Check connection and Pair again are in the ⋯ menu (#1086)`, () => {
    const window = new Window();
    window.document.body.innerHTML = renderMessagingCard(source, true, { paired: true, account: 'My linked account' }, { closable: true });
    const card = window.document.querySelector('.messaging-card')!;
    expect(card.textContent).toContain('My linked account');
    const shown = (element: { closest(selector: string): unknown }) => !element.closest('[hidden]') && !element.closest('.sheet');
    // One primary action, and no row of three buttons.
    expect([...card.querySelectorAll('.btn.primary')].filter(shown).map(button => button.textContent)).toEqual(['Choose chats']);
    expect([...card.querySelectorAll('.actionrow .btn')].filter(shown).map(button => button.textContent)).toEqual(['Choose chats']);
    const menu = card.querySelector('.msghead details.msgmenu')!;
    expect(menu.hasAttribute('hidden')).toBe(false);
    expect([...menu.querySelectorAll('.menu .btn')].map(button => button.textContent)).toEqual(['Check connection', 'Pair again']);
    // An expired session still needs a way to pair again; it is never the primary action.
    expect(menu.querySelector('.primary')).toBeNull();
    // The pairing explanation shows only before pairing.
    expect(card.querySelector('.msgintro')!.hasAttribute('hidden')).toBe(true);
    expect(card.querySelector('.msghead [data-dialog-close]')).not.toBeNull();
  });
}
