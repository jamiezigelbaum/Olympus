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
 * Every request is the Gmail lane's, under its day budget, and passes the
 * imports' one allowance gate (gmail-import-allowance.ts): one search, and
 * one read per candidate, only for a message without the id. A message is
 * begun only when the allowance holds its worst case; otherwise the answer is
 * `later` with the gate's reason, and the import waits for its next scheduled
 * pass with what it read so far stored, having spent nothing more.
 * Olympus not connected to Gmail means nothing can be matched (`none`).
 */
import { decodeWords } from 'postal-mime';
import type { MboxGmailMatch, MboxMessageHeaders } from '../archive-import/mbox/gmail-input.ts';
import { bareMessageId, type GmailApiClient } from './gmail.ts';
import { GMAIL_IMPORT_MESSAGE_COST, type GmailImportAllowance, type GmailImportWait } from './gmail-import-allowance.ts';
import { GoogleRequestBudgetError } from './request-budget.ts';

class AllowanceRefused extends Error {
  constructor(readonly reason: GmailImportWait) {
    super(reason);
  }
}

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

export interface GmailHeaderMatchOptions {
  /**
   * Whether the mailbox the token reads (its address) may be the account the
   * import joined. Asked once per matcher, before the first search: a token of
   * another account (a reconnect that landed since) is never searched, so a
   * message delivered to both cannot take the other account's id.
   */
  sameAccount?: (address: string) => boolean;
  /** The imports' one gate on Gmail requests. */
  allowance?: GmailImportAllowance;
}

export function gmailHeaderMatch(client: () => Promise<GmailApiClient | undefined>, options: GmailHeaderMatchOptions = {}): MboxGmailMatch {
  let checked: boolean | undefined;
  return async (headers: MboxMessageHeaders) => {
    const wanted = bareMessageId(headers.messageId);
    if (!wanted || !SEARCHABLE.test(wanted)) return 'none';
    const api = await client();
    if (!api) return 'none';
    // A message is begun only when the allowance holds its worst case; a refusal spends nothing.
    const room = options.allowance?.check(GMAIL_IMPORT_MESSAGE_COST) ?? true;
    if (room !== true) return { later: room };
    const take = (): void => {
      const verdict = options.allowance?.take(1) ?? true;
      if (verdict !== true) throw new AllowanceRefused(verdict);
    };
    try {
      return await matchWith(api, wanted, headers, take);
    } catch (error) {
      if (error instanceof AllowanceRefused) return { later: error.reason };
      if (error instanceof GoogleRequestBudgetError) return { later: 'gmail_requests_spent' };
      throw error;
    }
  };

  async function matchWith(api: GmailApiClient, wanted: string, headers: MboxMessageHeaders, take: () => void): Promise<{ id: string } | 'none'> {
    if (options.sameAccount && checked === undefined) {
      if (api.getProfile) take();
      const address = api.getProfile ? (await api.getProfile()).emailAddress : '';
      checked = address !== '' && options.sameAccount(address);
    }
    if (checked === false) return 'none';
    take();
    const listed = await api.listMessages({ maxResults: MAX_CANDIDATES + 1, query: `rfc822msgid:${wanted}` });
    const candidates = listed.messages.map((message) => message.id).filter(Boolean);
    // More than can be told apart: none is the message.
    if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) return 'none';
    const agreeing: string[] = [];
    for (const id of candidates) {
      take();
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
