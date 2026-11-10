/**
 * Chat kinds in a messaging capture grant (#1075). A grant names the whole
 * account (`*`), or any non-empty mix of exact chats and kind tokens
 * (`kind:dm`). A kind token covers every chat of that kind, including chats
 * started later; an exact chat covers that chat only. The grant stays one
 * comma-separated list in the reader's existing allowed-list variable.
 *
 * Choosing chats never sets a privacy tier: every message is still judged on
 * its own content downstream.
 */
export const MESSAGING_CHAT_KINDS = ['dm', 'group', 'channel', 'bot', 'community'] as const;
export type MessagingChatKind = typeof MESSAGING_CHAT_KINDS[number];
export type MessagingKindSource = 'telegram' | 'whatsapp';

/** The kinds each reader can tell apart, in display order. */
export const SOURCE_CHAT_KINDS: Readonly<Record<MessagingKindSource, readonly MessagingChatKind[]>> = {
  telegram: ['dm', 'group', 'channel', 'bot'],
  whatsapp: ['dm', 'group', 'community'],
};

/** The suggested start at first pairing: one-to-one chats and groups on, the rest off. */
export const SUGGESTED_CHAT_KINDS: readonly MessagingChatKind[] = ['dm', 'group'];

const KIND_TOKEN = /^kind:([a-z]+)$/;

export function chatKindToken(kind: MessagingChatKind): string {
  return `kind:${kind}`;
}

/** A kind token's kind; undefined for a value that is not a kind token. Throws for a malformed or unknown one. */
export function parseChatKindToken(source: MessagingKindSource, value: string): MessagingChatKind | undefined {
  if (!value.startsWith('kind')) return undefined;
  const match = KIND_TOKEN.exec(value);
  const kind = match?.[1] as MessagingChatKind | undefined;
  if (!kind || !SOURCE_CHAT_KINDS[source].includes(kind)) throw new Error('Invalid chat kind in capture grant.');
  return kind;
}

export interface MessagingChatChoice {
  wholeAccount: boolean;
  chatKinds: MessagingChatKind[];
  /** Exact chat values as the reader's variable spells them (Telegram scopes, WhatsApp JIDs). */
  chats: string[];
}

/**
 * Splits one allowed-list value into whole account, kinds and exact chats.
 * `validChat` checks each exact value. Throws for an empty list, a wildcard
 * mixed with anything, or an invalid kind or chat.
 */
export function parseAllowedChatList(source: MessagingKindSource, raw: string, validChat: (value: string) => boolean): MessagingChatChoice {
  const trimmed = raw.trim();
  if (trimmed === '*') return { wholeAccount: true, chatKinds: [], chats: [] };
  const values = trimmed.split(',').map((value) => value.trim());
  if (!trimmed || values.some((value) => !value)) throw new Error('Invalid capture grant scope.');
  const chatKinds: MessagingChatKind[] = [];
  const chats: string[] = [];
  for (const value of values) {
    const kind = parseChatKindToken(source, value);
    if (kind) { if (!chatKinds.includes(kind)) chatKinds.push(kind); continue; }
    if (value.includes('*') || !validChat(value)) throw new Error('Invalid capture grant scope.');
    if (!chats.includes(value)) chats.push(value);
  }
  return { wholeAccount: false, chatKinds, chats };
}

/** One allowed-list value for a choice; throws unless it is the whole account alone or a non-empty mix of kinds and chats. */
export function formatAllowedChatList(source: MessagingKindSource, choice: { wholeAccount: boolean; chatKinds?: readonly string[]; chats: readonly string[] }): string {
  const kinds = [...new Set(choice.chatKinds ?? [])];
  const chats = [...new Set(choice.chats)];
  if (choice.wholeAccount) {
    if (kinds.length || chats.length) throw new Error('Choose all chats, or chats and kinds, but not both.');
    return '*';
  }
  if (!kinds.length && !chats.length) throw new Error('Choose all chats, a kind, or at least one chat.');
  for (const kind of kinds) if (!(SOURCE_CHAT_KINDS[source] as readonly string[]).includes(kind)) throw new Error('Invalid chat kind.');
  if (chats.some((chat) => chat.includes('*') || chat.startsWith('kind'))) throw new Error('Capture approval requires exact chat identifiers.');
  return [...kinds.map((kind) => chatKindToken(kind as MessagingChatKind)), ...chats].join(',');
}
