/**
 * One mbox message parsed under bounds: what both readers of an mbox use (the
 * archive connector for mail that stays under Archives, connector.ts, and the
 * Gmail input for an export of a Gmail account, gmail-input.ts).
 */
import { createHash } from 'node:crypto';
import PostalMime, { decodeWords, type Email } from 'postal-mime';

export const MBOX_SKIPPED_LABELS = new Set(['spam', 'trash']);

export interface ParsedMboxMessage {
  email: Email;
  /** `X-Gmail-Labels`, decoded, in order. */
  labels: string[];
  /** Spam or Trash: skipped, as live Gmail lists neither. */
  spamOrTrash: boolean;
  subject?: string;
  from: string;
  to?: string;
  dateHeader?: string;
  authoredAt?: string;
  /** The Message-ID without its angle brackets. */
  messageId?: string;
  /** The message's own text: plain, else the HTML's text. */
  body: string;
  /** SHA-256 of the raw message. */
  messageHash: string;
  /** `X-GM-THRID`, when it is Gmail's decimal thread id. */
  gmailThread?: string;
  /** The root of the thread by References / In-Reply-To, else the Message-ID. */
  threadRoot?: string;
  /** A declared charset nothing here decodes. */
  charsetNotDecoded: boolean;
}

export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function headerValue(email: Email, key: string): string | undefined {
  const value = email.headers.find((header) => header.key === key)?.value?.trim();
  return value ? value : undefined;
}

export function decoded(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeWords(value).trim() || undefined;
  } catch {
    return value;
  }
}

export function bareMessageId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const inner = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1).trim() : trimmed;
  return inner || undefined;
}

function firstMessageId(value: string | undefined): string | undefined {
  const match = value ? /<([^<>\s]+)>/.exec(value) : null;
  return match?.[1] ?? bareMessageId(value?.split(/\s+/)[0]);
}

function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const decodableCharsets = new Map<string, boolean>();

/** Whether a declared charset has a decoder here (otherwise postal-mime reads it with a fallback). */
export function charsetDecodable(charset: string): boolean {
  const label = charset.trim().toLowerCase();
  if (!label) return true;
  const cached = decodableCharsets.get(label);
  if (cached !== undefined) return cached;
  const stripped = label.replace(/^(?:x-ms-|x-|cs)/, '');
  let ok = false;
  for (const candidate of [label, stripped, stripped.replace(/[\s._-]+/g, '')]) {
    try {
      new TextDecoder(candidate);
      ok = true;
      break;
    } catch {
      // Not a label this runtime decodes.
    }
  }
  decodableCharsets.set(label, ok);
  return ok;
}

/** Charsets the message declares in its Content-Type lines and encoded words. */
function declaredCharsets(raw: Uint8Array): string[] {
  const text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('latin1');
  const found = new Set<string>();
  for (const match of text.matchAll(/^content-type:[^\n]*(?:\n[ \t][^\n]*)*/gim)) {
    const param = /charset\s*=\s*"?([^";\s]+)/i.exec(match[0]);
    if (param?.[1]) found.add(param[1].toLowerCase());
  }
  const headerEnd = text.search(/\r?\n\r?\n/);
  const headers = headerEnd < 0 ? text : text.slice(0, headerEnd);
  for (const match of headers.matchAll(/=\?([^?*\s]+)(?:\*[^?]*)?\?[bq]\?/gi)) {
    if (match[1]) found.add(match[1].toLowerCase());
  }
  return [...found];
}

/** Undefined when the message does not parse. */
export async function parseMboxMessage(raw: Uint8Array): Promise<ParsedMboxMessage | undefined> {
  let email: Email;
  try {
    email = await PostalMime.parse(raw, {
      maxHeadersSize: 1024 * 1024,
      maxPartCount: 2_000,
      maxNestingDepth: 64,
      maxRfc822NestingDepth: 4,
    });
  } catch {
    return undefined;
  }
  const labels = (headerValue(email, 'x-gmail-labels') ?? '')
    .split(',')
    .map((label) => decoded(label.trim()) ?? '')
    .filter((label) => label !== '');
  const dateHeader = headerValue(email, 'date');
  const authoredAt = isoDate(email.date) ?? isoDate(dateHeader);
  const to = decoded(headerValue(email, 'to'));
  const messageId = bareMessageId(email.messageId ?? headerValue(email, 'message-id'));
  const thread = headerValue(email, 'x-gm-thrid');
  const threadRoot = firstMessageId(email.references) ?? firstMessageId(email.inReplyTo) ?? messageId;
  return {
    email,
    labels,
    spamOrTrash: labels.some((label) => MBOX_SKIPPED_LABELS.has(label.toLowerCase())),
    ...(email.subject?.trim() ? { subject: email.subject.trim() } : {}),
    from: decoded(headerValue(email, 'from')) ?? '',
    ...(to ? { to } : {}),
    ...(dateHeader ? { dateHeader } : {}),
    ...(authoredAt ? { authoredAt } : {}),
    ...(messageId ? { messageId } : {}),
    body: email.text?.trim() || (email.html ? stripHtml(email.html) : ''),
    messageHash: sha256(raw),
    ...(thread && /^\d{1,20}$/.test(thread) ? { gmailThread: thread } : {}),
    ...(threadRoot ? { threadRoot } : {}),
    charsetNotDecoded: declaredCharsets(raw).some((charset) => !charsetDecodable(charset)),
  };
}
