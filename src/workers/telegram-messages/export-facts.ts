// What an export says about itself that no single entry does (#553 review):
//
// - its content time, the newest `*_unixtime` anywhere in `result.json` (a
//   message's date or edit, a contact's or session's time). The export was
//   made no earlier, so it orders two snapshots of the account's entries by
//   what they hold, never by a file's modification time, which copying or
//   restoring changes;
// - which contacts share a key (no user id, no number, the same name and the
//   same date): each is told apart by its place among them, so two people are
//   never merged by name.
//
// Read once per export file version and remembered in this process: the time
// by a bounded scan of the bytes, the contacts by the streaming JSON reader
// over the contact lists only.

import { createHash } from 'node:crypto';
import type { ArchiveFileEntry } from '../../core/archive-formats.ts';
import type { ScopeRoot } from '../../core/scope-safe-fs.ts';
import { fileByteSource } from '../archive-import/byte-source.ts';
import { JsonStreamReader } from '../archive-import/json-stream.ts';
import { telegramJsonSource } from '../archive-import/telegram/json-repair.ts';
import { isRecord, telegramScalar } from '../archive-import/telegram/message.ts';

const SCAN_CHUNK_BYTES = 1 << 20;
const UNIXTIME = /_unixtime"\s*:\s*"?(\d{9,11})"?/g;
const LATEST_PLAUSIBLE_SECONDS = 4_102_444_800; // 2100-01-01
const CONTACT_SECTIONS = ['contacts', 'frequent_contacts'] as const;

export interface TelegramExportFacts {
  /** The newest time the export holds (ISO, whole seconds), or undefined when it holds none. */
  contentTime?: string;
  /** `<section>:<ordinal>` -> its place among the contacts of its section that share its key (only for 1 and up). */
  contactOccurrences: ReadonlyMap<string, number>;
}

const remembered = new Map<string, TelegramExportFacts>();

/** The base key of a contact: its user id, else its number (digits only), else its names and the date it was added. */
export function telegramContactBaseKey(value: unknown): string {
  if (!isRecord(value)) return 'unreadable';
  const userId = telegramScalar(value.user_id);
  if (userId) return `user${userId}`;
  const phone = telegramScalar(value.phone_number)?.replace(/\D+/g, '');
  if (phone) return `phone${createHash('sha256').update(phone).digest('hex').slice(0, 24)}`;
  const names = [value.first_name, value.last_name, value.name, value.category, value.date_unixtime ?? value.date]
    .map((part) => telegramScalar(part) ?? '');
  return `name${createHash('sha256').update(names.join('\x1f')).digest('hex').slice(0, 24)}`;
}

export function telegramExportFacts(root: ScopeRoot, file: ArchiveFileEntry): TelegramExportFacts {
  const key = `${file.relPath}\x1f${file.version.dev}:${file.version.ino}:${file.version.size}:${file.version.mtimeMs}`;
  const known = remembered.get(key);
  if (known) return known;
  const facts: TelegramExportFacts = { ...contentTimeOf(root, file), contactOccurrences: contactOccurrencesOf(root, file) };
  remembered.set(key, facts);
  return facts;
}

function contentTimeOf(root: ScopeRoot, file: ArchiveFileEntry): { contentTime?: string } {
  const reader = root.openFile(file.relPath, { expected: file.version });
  try {
    let newest = 0;
    let carry = '';
    for (let offset = 0; offset < reader.size; offset += SCAN_CHUNK_BYTES) {
      const text = carry + Buffer.from(reader.readAt(offset, Math.min(SCAN_CHUNK_BYTES, reader.size - offset))).toString('latin1');
      for (const found of text.matchAll(UNIXTIME)) {
        const seconds = Number(found[1]);
        if (seconds > newest && seconds < LATEST_PLAUSIBLE_SECONDS) newest = seconds;
      }
      // A match cut by the chunk's end is found again in the next chunk's start.
      carry = text.slice(-48);
    }
    return newest > 0 ? { contentTime: new Date(newest * 1000).toISOString().replace(/\.000Z$/, 'Z') } : {};
  } finally {
    reader.close();
  }
}

function contactOccurrencesOf(root: ScopeRoot, file: ArchiveFileEntry): Map<string, number> {
  const occurrences = new Map<string, number>();
  const seen = new Map<string, number>();
  const reader = root.openFile(file.relPath, { expected: file.version });
  try {
    const json = new JsonStreamReader(telegramJsonSource(fileByteSource(reader)), {
      itemPaths: [
        // A path names the container: each contact is a child of its list, claimed whole.
        ...CONTACT_SECTIONS.map((section) => [section, 'list']),
        // Past the contact lists: the first child of any of these ends the scan.
        ['sessions'], ['web_sessions'], ['other_data'], ['chats'], ['left_chats'], ['messages'],
      ],
      maxItemBytes: 1024 * 1024,
    });
    for (;;) {
      let event;
      try {
        event = json.next();
      } catch {
        break;
      }
      if (!event || event.pathIndex >= CONTACT_SECTIONS.length) break;
      const section = CONTACT_SECTIONS[event.pathIndex]!;
      const base = `${section}:${telegramContactBaseKey(event.value)}`;
      const place = seen.get(base) ?? 0;
      seen.set(base, place + 1);
      if (place > 0) occurrences.set(`${section}:${String(event.path[2])}`, place);
    }
  } finally {
    reader.close();
  }
  return occurrences;
}
