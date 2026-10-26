// The keys a WhatsApp message is matched by across inputs
// (docs/design/archive-live-one-dataset.md, section 4, WhatsApp): its chat,
// its time slot (the minute, or the second when an export shows seconds), its
// sender and its text (a caption included, media markers left out). Keys are
// digests: no name or text is kept in them.

import { createHash } from 'node:crypto';
import { normalizeWhatsAppJid } from './reaction-index.ts';

/** The sender key of the owner's own messages. */
export const OWNER_SENDER = '\u0000me';

export type TimePrecision = 'minute' | 'second';

/** A name as both sides spell it: Unicode-normalized, spaces folded, case folded. */
export function nameKey(name: string): string {
  return name.normalize('NFKC').replace(/[‎‏‪-‮⁦-⁩]/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** A text as both sides spell it: line ends and spaces folded, invisible marks dropped. */
export function textKey(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/gu, '\n').replace(/[‎‏‪-‮⁦-⁩]/gu, '').replace(/[ \t]+/gu, ' ').replace(/ ?\n ?/gu, '\n').trim();
}

export function keyDigest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

export function timeSlot(ms: number, precision: TimePrecision): string {
  return precision === 'second' ? `s${Math.floor(ms / 1_000)}` : `m${Math.floor(ms / 60_000)}`;
}

/** The exact key: chat, slot, sender, text. */
export function exactKey(chatJid: string, ms: number, precision: TimePrecision, sender: string, text: string): string {
  return keyDigest(normalizeWhatsAppJid(chatJid), timeSlot(ms, precision), sender, text);
}

/** The key with no chat, for choosing a time zone across chats. */
export function looseKey(ms: number, precision: TimePrecision, sender: string, text: string): string {
  return keyDigest(timeSlot(ms, precision), sender, text);
}

/** The key with no sender, for learning who the owner is in an export. */
export function unsentKey(chatJid: string, ms: number, precision: TimePrecision, text: string): string {
  return keyDigest(normalizeWhatsAppJid(chatJid), timeSlot(ms, precision), text);
}

/** A live message's keys at both precisions, as the spool index keeps them. */
export interface LiveMatchKeys {
  timeMs: number;
  exactMinute: string;
  exactSecond: string;
  looseMinute: string;
  looseSecond: string;
  unsentMinute: string;
  unsentSecond: string;
}

export function liveMatchKeys(input: { chatJid: string; timestamp: string; sender: string; text: string }): LiveMatchKeys | undefined {
  const ms = Date.parse(input.timestamp);
  if (!Number.isFinite(ms)) return undefined;
  const text = textKey(input.text);
  return {
    timeMs: ms,
    exactMinute: exactKey(input.chatJid, ms, 'minute', input.sender, text),
    exactSecond: exactKey(input.chatJid, ms, 'second', input.sender, text),
    looseMinute: looseKey(ms, 'minute', input.sender, text),
    looseSecond: looseKey(ms, 'second', input.sender, text),
    unsentMinute: unsentKey(input.chatJid, ms, 'minute', text),
    unsentSecond: unsentKey(input.chatJid, ms, 'second', text),
  };
}

/**
 * A stable id of an export message live does not hold, from what it is, never
 * from where it is: its chat, its time slot (zone applied), its sender, its
 * whole text with the names of the files it carries (WhatsApp names each file
 * apart, so a picture with no words has an id of its own), and its number
 * among exactly identical messages (the export reader's own count). The same
 * in a second export of the chat, however much more or less that one holds.
 */
export function exportMessageId(chatJid: string, ms: number, precision: TimePrecision, sender: string, text: string, occurrence: string): string {
  return `wx${keyDigest('id', normalizeWhatsAppJid(chatJid), timeSlot(ms, precision), sender, text, occurrence).slice(0, 30)}`;
}
