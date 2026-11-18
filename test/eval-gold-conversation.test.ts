import { describe, expect, test } from 'bun:test';
import { resolveGold } from '../eval/fill-gold-conversations.ts';
import { isGoldItem } from '../eval/types.ts';

// Telegram numbers messages per chat, so one provider id can name a message in
// many chats of one store. A gold pinned to its conversation must not count
// another chat's message with the same number as found (AUT2, 18 Nov).

describe('gold items pinned to a conversation', () => {
  test('the id alone decides when the gold names no conversation', () => {
    expect(isGoldItem({ corpusId: 'c', providerItemId: '42' }, 'c', { providerItemId: '42', providerConversationId: 'any' })).toBe(true);
  });

  test('a message with the same id in another chat is not the gold', () => {
    const gold = { corpusId: 'c', providerItemId: '42', providerConversationId: 'chat-a' };
    expect(isGoldItem(gold, 'c', { providerItemId: '42', providerConversationId: 'chat-a' })).toBe(true);
    expect(isGoldItem(gold, 'c', { providerItemId: '42', providerConversationId: 'chat-b' })).toBe(false);
    expect(isGoldItem(gold, 'other', { providerItemId: '42', providerConversationId: 'chat-a' })).toBe(false);
  });

  test('the fill picks the one candidate whose text holds the quote', () => {
    const quote = 'the appointment is on thursday at half past ten';
    const candidates = [
      { conversationId: 'chat-a', text: 'Unrelated message about lunch plans for the week ahead.' },
      { conversationId: 'chat-b', text: 'Confirmed: the appointment is on Thursday at half past ten.' },
    ];
    expect(resolveGold(candidates, quote)).toEqual({ resolution: 'resolved', conversationId: 'chat-b' });
    expect(resolveGold([candidates[0]!], quote)).toEqual({ resolution: 'unique' });
    expect(resolveGold([candidates[0]!, { ...candidates[0]!, conversationId: 'chat-c' }], quote)).toEqual({ resolution: 'no_quote_match' });
    expect(resolveGold([candidates[1]!, { ...candidates[1]!, conversationId: 'chat-c' }], quote)).toEqual({ resolution: 'ambiguous' });
    expect(resolveGold([], quote)).toEqual({ resolution: 'missing' });
  });
});
