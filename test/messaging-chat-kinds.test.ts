import { expect, test } from 'bun:test';
import { formatAllowedChatList, parseAllowedChatList } from '../src/core/messaging-chat-kinds.ts';

const telegramChat = (value: string) => /^telegram\.personal:chat:[A-Za-z0-9_-]+$/.test(value);
const whatsappChat = (value: string) => /^[A-Za-z0-9._:-]{1,192}@[A-Za-z0-9.-]{1,63}$/.test(value);

test('an allowed list reads back as whole account, kinds and exact chats', () => {
  expect(parseAllowedChatList('telegram', '*', telegramChat)).toEqual({ wholeAccount: true, chatKinds: [], chats: [] });
  expect(parseAllowedChatList('telegram', 'kind:dm, kind:group,telegram.personal:chat:7', telegramChat))
    .toEqual({ wholeAccount: false, chatKinds: ['dm', 'group'], chats: ['telegram.personal:chat:7'] });
  expect(parseAllowedChatList('whatsapp', 'kind:community,1@s.whatsapp.net', whatsappChat))
    .toEqual({ wholeAccount: false, chatKinds: ['community'], chats: ['1@s.whatsapp.net'] });
});

test('kind tokens are validated strictly', () => {
  for (const raw of ['kind:', 'kind:DM', 'kind:dm ,', 'kind:*', 'kind:dms', 'kinds:dm', 'kind:dm:x', '*,kind:dm', 'kind:community']) {
    expect(() => parseAllowedChatList('telegram', raw, telegramChat)).toThrow();
  }
  for (const raw of ['kind:channel', 'kind:bot', '', ' , ']) expect(() => parseAllowedChatList('whatsapp', raw, whatsappChat)).toThrow();
});

test('a choice formats to one list: the whole account alone, or a non-empty mix', () => {
  expect(formatAllowedChatList('telegram', { wholeAccount: true, chats: [] })).toBe('*');
  expect(formatAllowedChatList('telegram', { wholeAccount: false, chatKinds: ['bot', 'bot'], chats: [] })).toBe('kind:bot');
  expect(formatAllowedChatList('whatsapp', { wholeAccount: false, chatKinds: ['group'], chats: ['1@s.whatsapp.net'] })).toBe('kind:group,1@s.whatsapp.net');
  expect(() => formatAllowedChatList('telegram', { wholeAccount: true, chatKinds: ['dm'], chats: [] })).toThrow();
  expect(() => formatAllowedChatList('telegram', { wholeAccount: false, chatKinds: [], chats: [] })).toThrow();
  expect(() => formatAllowedChatList('whatsapp', { wholeAccount: false, chatKinds: ['channel'], chats: [] })).toThrow();
  expect(() => formatAllowedChatList('telegram', { wholeAccount: false, chats: ['kind:dm'] })).toThrow();
});
