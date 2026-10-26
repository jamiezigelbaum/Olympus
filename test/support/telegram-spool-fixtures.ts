// Synthetic Telegram capture spool records, written the way the Telethon
// helper writes them (scripts/telegram-telethon-reader.py, append_gateway_page):
// never real data. Reusable: the release check's live seed imports this too.

import { createHash } from 'node:crypto';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_PERSONAL_ACCOUNT_SCOPE,
} from '../../src/workers/telegram-messages/index.ts';

const ACCOUNT = TELEGRAM_PERSONAL_ACCOUNT_SCOPE;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** One live message, as the helper writes it into the spool. */
export interface LiveMessage {
  chat: string;
  id: string;
  text?: string;
  sentAt: string;
  editedAt?: string;
  sender?: { id: string; name?: string };
  chatTitle?: string;
  chatType?: string;
  trust?: 'internal' | 'secure_local';
  extra?: Record<string, unknown>;
}

export function liveSpoolLine(message: LiveMessage, capturedAt = '2026-10-20T10:00:00Z'): string {
  const time = (message.editedAt ?? message.sentAt).replace(/\.000Z$/, 'Z');
  const sourceVersion = `${ACCOUNT}:${message.chat}:${message.id}:${time}`;
  const trust = message.trust ?? 'internal';
  return JSON.stringify({
    schema_version: 1,
    capture_id: sha256([ACCOUNT, message.chat, message.id, sourceVersion].join('\x1f')),
    captured_at: capturedAt,
    provider: 'telegram',
    account: ACCOUNT,
    chat_scope: `${ACCOUNT}:chat:${message.chat}`,
    conversation_id: message.chat,
    corpus_id: trust === 'secure_local' ? PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID : INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    trust_domain: trust,
    classification: { trust_domain: trust, reason: 'approved_ordinary_chat' },
    sync_direction: 'forward',
    message: {
      id: message.id,
      chatId: message.chat,
      conversationId: message.chat,
      sentAt: message.sentAt.replace(/\.000Z$/, 'Z'),
      ...(message.editedAt ? { editedAt: message.editedAt.replace(/\.000Z$/, 'Z') } : {}),
      ...(message.chatTitle ? { chatTitle: message.chatTitle } : {}),
      chatType: message.chatType ?? 'group',
      ...(message.sender ? { senderId: message.sender.id, ...(message.sender.name ? { senderDisplayName: message.sender.name } : {}) } : {}),
      ...(message.text ? { boundedText: message.text } : {}),
      sourceVersion,
      ...(message.extra ?? {}),
    },
  }) + '\n';
}

