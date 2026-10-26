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
 * read per candidate, only for a message without the id. An import may spend
 * at most half of the day's budget (`IMPORT_SHARE`), so live Gmail always has
 * the rest; past it, or with the budget spent, the answer is `later`, and the
 * import waits for its next scheduled pass with what it read so far stored.
 * Olympus not connected to Gmail means nothing can be matched (`none`).
 */
import { decodeWords } from 'postal-mime';
import type { MboxGmailMatch, MboxMessageHeaders } from '../archive-import/mbox/gmail-input.ts';
import { bareMessageId, type GmailApiClient } from './gmail.ts';
import { GoogleRequestBudgetError } from './request-budget.ts';

const MAX_CANDIDATES = 5;
/** The most of the day's Gmail requests an import's matching may leave used: live Gmail keeps the rest. */
export const IMPORT_SHARE = 0.5;
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

export interface GmailHeaderMatchOptions {
  /**
   * Whether the mailbox the token reads (its address) may be the account the
   * import joined. Asked once per matcher, before the first search: a token of
   * another account (a reconnect that landed since) is never searched, so a
   * message delivered to both cannot take the other account's id.
   */
  sameAccount?: (address: string) => boolean;
  /** The day's Gmail requests so far and the day's budget (the lane's one counter). */
  usage?: () => { requests: number; dailyRequestBudget: number } | undefined;
}

export function gmailHeaderMatch(client: () => Promise<GmailApiClient | undefined>, options: GmailHeaderMatchOptions = {}): MboxGmailMatch {
  let checked: boolean | undefined;
  return async (headers: MboxMessageHeaders) => {
    const wanted = bareMessageId(headers.messageId);
    if (!wanted || !SEARCHABLE.test(wanted)) return 'none';
    const api = await client();
    if (!api) return 'none';
    const usage = options.usage?.();
    // Two requests at least are asked for one message: past the share, none is.
    if (usage && usage.requests + 2 > Math.floor(usage.dailyRequestBudget * IMPORT_SHARE)) return 'later';
    try {
      return await matchWith(api, wanted, headers);
    } catch (error) {
      if (error instanceof GoogleRequestBudgetError) return 'later';
      throw error;
    }
  };

  async function matchWith(api: GmailApiClient, wanted: string, headers: MboxMessageHeaders): Promise<{ id: string } | 'none'> {
    if (options.sameAccount && checked === undefined) {
      const address = api.getProfile ? (await api.getProfile()).emailAddress : '';
      checked = address !== '' && options.sameAccount(address);
    }
    if (checked === false) return 'none';
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
  }
}
