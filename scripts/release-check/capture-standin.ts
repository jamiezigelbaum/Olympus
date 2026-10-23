/**
 * Stand-ins for the two capture daemons that feed the chat sources, Telegram and WhatsApp.
 *
 * Neither chat source is read over a provider API by the engine. A separate daemon owns the provider session (a Telethon helper for
 * Telegram, the whatsmeow bridge for WhatsApp) and appends one JSON line per message to a spool directory of YYYY-MM-DD.jsonl files;
 * the engine's connector only reads that spool. The spool is therefore the connector's provider boundary, and the stand-in is a
 * writer of the same lines the daemons write. No product code path is added or bypassed, and no real account, phone or session is
 * involved: the messages are synthetic and carry no fixture marker.
 *
 * The line shapes are the daemons' contract (src/workers/telegram-messages/capture-spool-connector.ts and
 * src/workers/whatsapp/live-connector.ts). The constants below are copied so this file stays light for the in-machine agent's
 * bundle; test/release-check-capture-standin.test.ts holds them equal to the product's and reads what is written with the
 * product's own connectors.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TELEGRAM_ACCOUNT = 'telegram.personal';
export const TELEGRAM_INTERNAL_CORPUS = 'internal.telegram.messages';

export interface StandInMessage { id: string; text: string; at: string }

/** A short conversation of ordinary, harmless text. */
export function syntheticMessages(count: number, prefix: string): StandInMessage[] {
  const lines = ['are we still on for lunch', 'the train is ten minutes late', 'sending the photos tonight', 'can you pick up bread', 'see you at the station', 'thanks for the ride'];
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    text: `${lines[index % lines.length]!} (release check ${index + 1})`,
    at: new Date(Date.UTC(2026, 9, 1, 9, index * 7)).toISOString(),
  }));
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The lines the Telegram capture helper appends for a conversation. */
export function telegramSpoolLines(conversationId: string, messages: readonly StandInMessage[]): string[] {
  return messages.map((message) => {
    const sourceVersion = `${message.id}:v1`;
    return JSON.stringify({
      schema_version: 1,
      capture_id: sha256([TELEGRAM_ACCOUNT, conversationId, message.id, sourceVersion].join('\x1f')),
      captured_at: message.at,
      provider: 'telegram',
      account: TELEGRAM_ACCOUNT,
      chat_scope: `${TELEGRAM_ACCOUNT}:chat:${conversationId}`,
      conversation_id: conversationId,
      corpus_id: TELEGRAM_INTERNAL_CORPUS,
      trust_domain: 'internal',
      classification: { trust_domain: 'internal', reason: 'release-check stand-in' },
      sync_direction: 'forward',
      message: { id: message.id, conversationId, chatTitle: 'Release check chat', chatType: 'group', boundedText: message.text, sentAt: message.at, sourceVersion },
    });
  });
}

/** The lines the WhatsApp bridge appends for a chat. */
export function whatsappSpoolLines(chatJid: string, messages: readonly StandInMessage[]): string[] {
  return messages.map((message, index) => JSON.stringify({
    id: message.id,
    chat_jid: chatJid,
    chat_name: 'Release check chat',
    sender_jid: index % 2 === 0 ? '15550100001@s.whatsapp.net' : '15550100002@s.whatsapp.net',
    sender_name: index % 2 === 0 ? 'Casey' : 'Robin',
    from_me: false,
    timestamp: message.at,
    text: message.text,
  }));
}

const dataHome = (env: Record<string, string | undefined>): string => env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'share');

/** Where the engine reads each spool, from the same environment rules as the product's (defaultTelegramCaptureSpoolDir, defaultWhatsAppSpoolDir). */
export function telegramSpoolDir(env: Record<string, string | undefined> = process.env): string {
  return env.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR?.trim() || env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR?.trim() || join(dataHome(env), 'olympus', 'telegram-capture', 'spool');
}
export function whatsappSpoolDir(env: Record<string, string | undefined> = process.env): string {
  return env.OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR?.trim() || join(env.OLYMPUS_WHATSAPP_STATE_DIR?.trim() || join(dataHome(env), 'olympus', 'whatsapp-live'), 'spool');
}

/**
 * Writes the lines as the day's file (each line ends with a newline, as the daemons write them). The same messages written again give the
 * same file, so putting the source in its populated state twice leaves one copy of each message.
 */
export function writeSpool(dir: string, lines: readonly string[], day = '2026-10-01'): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${day}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

/** Removes the spool files this stand-in wrote (a day-named .jsonl), leaving the directory. */
export function clearSpool(dir: string): void {
  try { for (const name of readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) rmSync(join(dir, name), { force: true }); } catch { /* no spool yet */ }
}
