import { expect, test } from 'bun:test';
import { DASHBOARD_PREVIEW_STATES, previewMessagingFixture, renderMessagingPreviewPage } from '../scripts/dashboard-preview.ts';

const cases = [
  ['telegram-pair-phone', 'phone'], ['telegram-pair-code', 'code'], ['telegram-pair-2fa', 'password'],
  ['telegram-pair-error', 'failed'], ['telegram-chats', 'chats'], ['telegram-capturing', 'paired'],
  ['whatsapp-qr', 'qr'], ['whatsapp-chats', 'chats'], ['whatsapp-capturing', 'paired'],
] as const;

test.each(cases)('%s renders its requested fixture on the local Keys page', (state, expected) => {
  expect(DASHBOARD_PREVIEW_STATES).toContain(state);
  const fixture = previewMessagingFixture(state)!;
  expect(JSON.stringify(fixture)).toContain(expected);
  const page = renderMessagingPreviewPage(state);
  expect(page).toContain(`data-messaging-source="${state.split('-')[0]}"`);
  expect(page).toContain('data-messaging-kind="start"');
  expect(page).toContain('data-preview-messaging');
  expect(page).toContain(`[data-messaging-source="${state.split('-')[0]}"] [data-messaging-kind="${state.endsWith('-chats') ? 'chats' : 'start'}"]`);
  if (state === 'whatsapp-chats') expect(page).toContain('may omit unsaved chats');
  if (state.endsWith('-chats')) expect(fixture).toMatchObject({ wholeAccount: false, chatScopes: ['preview:1'] });
});
