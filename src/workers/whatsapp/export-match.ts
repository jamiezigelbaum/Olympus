// Matching a WhatsApp chat export against what live capture holds
// (docs/design/archive-live-one-dataset.md, section 4, WhatsApp).
//
// An export has no message ids, so nothing can make a match certain; this is
// the closest the data allows. A message's key is its chat, its time (the
// minute the export shows, or the second when it shows seconds), its sender
// and its text (a caption included). The sender is "me" for the owner's own
// messages and otherwise the name the phone saved for the contact, which is
// what the export shows (the bridge's `sender_contact_name`), falling back to
// the push name.
//
// Messages with equal keys are counted on each side, and the dataset keeps as
// many as the side with more: the export's k-th message with a key is the
// k-th live message with it while there is one, and its own item after. Each
// side's count is at most the truth, so identical messages are neither lost
// nor doubled.
//
// The index is read from the live spool, which is the live input's own record
// of what it captured; only lines the stores could hold count (no reaction,
// no Secret line, whose text is gone). Nothing here is kept beyond one pass.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { normalizeWhatsAppJid } from './reaction-index.ts';
import { isWhatsAppReactionRecord, parseWhatsAppSpoolRecord, type WhatsAppRecord } from './live-connector.ts';
import { spoolFileLines } from './spool-reader.ts';
import { readdirSync } from 'node:fs';

/** The sender key of the owner's own messages. */
export const OWNER_SENDER = '\u0000me';

/** A name as both sides spell it: Unicode-normalized, spaces folded, case folded. */
export function nameKey(name: string): string {
  return name.normalize('NFKC').replace(/[‎‏‪-‮⁦-⁩]/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** A text as both sides spell it: line ends and spaces folded, invisible marks dropped. */
export function textKey(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/gu, '\n').replace(/[‎‏‪-‮⁦-⁩]/gu, '').replace(/[ \t]+/gu, ' ').replace(/ ?\n ?/gu, '\n').trim();
}

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

/** One live message, as much as matching needs of it. */
export interface LiveMessageRef {
  id: string;
  chatJid: string;
  timestamp: string;
  fromMe: boolean;
  mediaType?: string;
  /** The bridge saved its media (a voice note): the live item already holds that media's content. */
  mediaSaved: boolean;
}

export interface LiveIndex {
  /** The live messages with this exact key, in the order the spool holds them. */
  byKey: Map<string, LiveMessageRef[]>;
  /** Keys without the chat (minute or second, sender, text): the time zone is chosen across chats. */
  unchatted: Map<string, number>;
  /** Keys without the sender: who "me" is in the export is learned from these. */
  unsent: Map<string, LiveMessageRef[]>;
  /** Live chats by name (direct chats; the bridge leaves group names unresolved). */
  chatsByName: Map<string, Set<string>>;
  /** Live messages per chat and minute, for near-misses. */
  perMinute: Map<string, number>;
  /** The days (UTC) live capture holds messages on. */
  days: Set<string>;
  messages: number;
}

export type TimePrecision = 'minute' | 'second';

function timeSlot(ms: number, precision: TimePrecision): number {
  return precision === 'second' ? Math.floor(ms / 1_000) : Math.floor(ms / 60_000);
}

export function matchKey(chatJid: string, slot: string, sender: string, text: string): string {
  return digest(normalizeWhatsAppJid(chatJid), slot, sender, text);
}

function slotKey(ms: number, precision: TimePrecision): string {
  return `${precision[0]}${timeSlot(ms, precision)}`;
}

/** The sender key of a live record. */
export function liveSenderKey(record: WhatsAppRecord): string {
  if (record.fromMe) return OWNER_SENDER;
  return nameKey(record.senderContactName || record.senderName || '');
}

/**
 * The live index of a spool, from the files that can hold messages written
 * since `fromDay` (YYYY-MM-DD): the spool names its files by the day the
 * bridge received a message, which is never before the day it was sent.
 */
export function buildLiveIndex(spoolDir: string, options: { fromDay?: string } = {}): LiveIndex {
  const index: LiveIndex = {
    byKey: new Map(),
    unchatted: new Map(),
    unsent: new Map(),
    chatsByName: new Map(),
    perMinute: new Map(),
    days: new Set(),
    messages: 0,
  };
  let files: string[] = [];
  try {
    files = readdirSync(spoolDir).filter((name) => name.toLowerCase().endsWith('.jsonl')).sort();
  } catch {
    return index;
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (options.fromDay && file.slice(0, 10) < options.fromDay && /^\d{4}-\d{2}-\d{2}/u.test(file)) continue;
    for (const line of spoolFileLines(join(spoolDir, file))) {
      const record = parseWhatsAppSpoolRecord(line);
      if (!record || isWhatsAppReactionRecord(record) || record.secretRedacted === true) continue;
      const time = Date.parse(record.timestamp);
      if (!Number.isFinite(time)) continue;
      const chat = normalizeWhatsAppJid(record.chatJid);
      // A redelivered message is spooled again under its id: it is one message.
      const own = `${chat}\u0000${record.id}`;
      if (seen.has(own)) continue;
      seen.add(own);
      index.messages += 1;
      index.days.add(new Date(time).toISOString().slice(0, 10));
      if (record.chatName) {
        const names = index.chatsByName.get(nameKey(record.chatName)) ?? new Set<string>();
        names.add(chat);
        index.chatsByName.set(nameKey(record.chatName), names);
      }
      const ref: LiveMessageRef = {
        id: record.id,
        chatJid: record.chatJid,
        timestamp: record.timestamp,
        fromMe: record.fromMe,
        ...(record.mediaType !== undefined ? { mediaType: record.mediaType } : {}),
        mediaSaved: record.mediaPath !== undefined,
      };
      const sender = liveSenderKey(record);
      const text = textKey(record.text);
      for (const precision of ['minute', 'second'] as const) {
        const slot = slotKey(time, precision);
        const key = matchKey(chat, slot, sender, text);
        const list = index.byKey.get(key) ?? [];
        list.push(ref);
        index.byKey.set(key, list);
        const loose = digest(slot, sender, text);
        index.unchatted.set(loose, (index.unchatted.get(loose) ?? 0) + 1);
        const unsent = digest(chat, slot, text);
        const others = index.unsent.get(unsent) ?? [];
        others.push(ref);
        index.unsent.set(unsent, others);
      }
      const minute = `${chat}\u0000${timeSlot(time, 'minute')}`;
      index.perMinute.set(minute, (index.perMinute.get(minute) ?? 0) + 1);
    }
  }
  return index;
}

/** The key with no chat, for choosing a time zone across chats. */
export function unchattedKey(ms: number, precision: TimePrecision, sender: string, text: string): string {
  return digest(slotKey(ms, precision), sender, text);
}

/** The key with no sender, for learning who the owner is in an export. */
export function unsentKey(chatJid: string, ms: number, precision: TimePrecision, text: string): string {
  return digest(normalizeWhatsAppJid(chatJid), slotKey(ms, precision), text);
}

export function exactKey(chatJid: string, ms: number, precision: TimePrecision, sender: string, text: string): string {
  return matchKey(chatJid, slotKey(ms, precision), sender, text);
}

/** Whether live holds any message of this chat within a minute of this time: an unmatched export message is then a near-miss. */
export function liveNearby(index: LiveIndex, chatJid: string, ms: number): boolean {
  const chat = normalizeWhatsAppJid(chatJid);
  const minute = timeSlot(ms, 'minute');
  for (const at of [minute - 1, minute, minute + 1]) {
    if ((index.perMinute.get(`${chat}\u0000${at}`) ?? 0) > 0) return true;
  }
  return false;
}

/** A stable id of an export message live does not hold: the same in a second export of the same chat. */
export function exportMessageId(chatJid: string, ms: number, precision: TimePrecision, sender: string, text: string, occurrence: string): string {
  return `wx${digest(normalizeWhatsAppJid(chatJid), slotKey(ms, precision), sender, text, occurrence).slice(0, 30)}`;
}
