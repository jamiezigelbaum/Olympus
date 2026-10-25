/**
 * The Gmail message an imported message is, by its headers, for a message
 * that does not carry Gmail's id (docs/design/archive-live-one-dataset.md,
 * section 4). A Takeout export carries the id on every message, so this is
 * the fallback for an mbox of a Gmail account written some other way.
 *
 * Gmail is asked, never a copy: `rfc822msgid:` finds the account's messages
 * with that Message-ID (Gmail indexes it for all of them, stored here or not),
 * and each candidate's Message-ID, Date, From and Subject are read and must
 * all agree. Exactly one that agrees is the message; none or several, and the
 * import keeps the message as its own item. Two mails that agree on all four
 * (a list resend) are taken as one: the residual the design accepts.
 *
 * Every request is the Gmail lane's, under its day budget: one search, and one
 * read per candidate, only for a message without the id. A spent budget fails
 * the pass (the scheduler backs off and the message is read again later);
 * Olympus not connected to Gmail means nothing can be matched (`none`).
 */
import { decodeWords } from 'postal-mime';
import type { MboxGmailMatch, MboxMessageHeaders } from '../archive-import/mbox/gmail-input.ts';
import { bareMessageId, type GmailApiClient } from './gmail.ts';

const MAX_CANDIDATES = 5;
// A Message-ID Gmail's search can take as one term.
const SEARCHABLE = /^[^\s"()<>{}]{1,500}$/;

function sameDate(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) ? left === right : a.trim() === b.trim();
}

/** Header text compared as read: encoded words (RFC 2047) decoded on both sides, whichever side kept them. */
function readable(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeWords(value).replace(/\s+/g, ' ').trim();
  } catch {
    return value.replace(/\s+/g, ' ').trim();
  }
}

const same = (a: string | undefined, b: string | undefined): boolean => readable(a) === readable(b);

export function gmailHeaderMatch(client: () => Promise<GmailApiClient | undefined>): MboxGmailMatch {
  return async (headers: MboxMessageHeaders) => {
    const wanted = bareMessageId(headers.messageId);
    if (!wanted || !SEARCHABLE.test(wanted)) return 'none';
    const api = await client();
    if (!api) return 'none';
    const listed = await api.listMessages({ maxResults: MAX_CANDIDATES + 1, query: `rfc822msgid:${wanted}` });
    const candidates = listed.messages.map((message) => message.id).filter(Boolean);
    // More than can be told apart: none is the message.
    if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) return 'none';
    const agreeing: string[] = [];
    for (const id of candidates) {
      const message = await api.getMessage(id, { format: 'metadata', metadataHeaders: ['Message-ID', 'Date', 'From', 'Subject'] });
      const found = new Map<string, string>();
      for (const header of message.payload?.headers ?? []) {
        const name = header.name?.trim().toLowerCase();
        if (name && header.value !== undefined && !found.has(name)) found.set(name, header.value);
      }
      if (bareMessageId(found.get('message-id')) === wanted
        && sameDate(found.get('date'), headers.date)
        && same(found.get('from'), headers.from)
        && same(found.get('subject'), headers.subject)) {
        agreeing.push(id);
      }
    }
    return agreeing.length === 1 ? { id: agreeing[0]! } : 'none';
  };
}
