/**
 * One parsed mail, the record every input of the Gmail connector yields
 * (docs/design/archive-live-one-dataset.md, sections 1, 4 and 5), and the one
 * code path from it to items.
 *
 * The live reader turns a Gmail API message into this record; an imported mbox
 * of the same account turns each of its messages into it
 * (archive-import/mbox/gmail-input.ts). `gmailMailItems` then builds the
 * message and its attachments (child items, 2.1.0) the same way, whichever
 * input the record came from. Nothing here reads the provider or a file.
 *
 * - Identity: the Gmail message id when the input knows it (live always; a
 *   Takeout export carries it), so the two inputs name one item. A message
 *   that cannot be matched keeps an id of its own (`mbox-…`), never a Gmail
 *   one.
 * - Versions: mail does not change. Every version of one message is the same
 *   (`compareVersions` is always 0), so the intake rule keeps what is stored
 *   unless the record brings content the stored item lacks (names-only mail
 *   outside the window), and live is kept on a tie.
 * - Children: each MIME part with a file name, keyed by its part path, which
 *   both inputs compute the same way (Gmail's `partId`). Listed by name, with
 *   the means to read its bytes later (`deferredBytes`); none for mail kept by
 *   name only.
 */
import { createHash } from 'node:crypto';
import type { RawItem, SourceClassificationSignals } from '../../core/contracts.ts';
import { namesOnlyContentScopeMetadata } from '../../core/classification-signals.ts';
import { MAX_FROM_HEADER_CHARS } from '../../core/sender-rules.ts';
import type { SourceRecordEntry } from '../../core/source-inputs.ts';
import { childProviderItemId } from '../../core/child-item-id.ts';
import { metadataString, metadataStringArray } from './classification.ts';

export const GMAIL_MAIL_PROVIDER = 'gmail';
const MAX_ATTACHMENT_NAME_CHARS = 256;
/** The prefix of an id that is not Gmail's: a message an import could not match to a Gmail message. */
export const GMAIL_OWN_ID_PREFIX = 'mbox-';

export interface GmailMailAttachment {
  /** The MIME part path (Gmail's `partId`): `0`, `1.2`. Empty for a single-part message whose body is the file. */
  partId: string;
  filename: string;
  mimeType?: string;
  /** The decoded size the source states. */
  size?: number;
  /** How the input reads the part's bytes later; opaque outside the input. Absent: the bytes cannot be read. */
  locator?: string;
  /** Inside another part with a file name (a file in a forwarded message): named on the message, read with that part. */
  nested?: boolean;
}

export interface GmailMailRecord {
  /** Gmail's message id, or an id of the record's own (`GMAIL_OWN_ID_PREFIX`) when no Gmail id is known. */
  id: string;
  threadId?: string;
  historyId?: string;
  /** Gmail's receipt time (epoch milliseconds, as text), when the input has it. */
  internalDate?: string;
  labelIds: readonly string[];
  headers: {
    subject?: string;
    from?: string;
    to?: string;
    date?: string;
    /** The Message-ID header without its angle brackets. */
    messageId?: string;
  };
  /** Gmail's snippet (body text): absent for mail kept by name only. */
  snippet?: string;
  /** The message's own text (plain, else the HTML's text), never an attachment's. */
  body: string;
  /** Kept by name only: no body, no snippet, no children. */
  metadataOnly: boolean;
  attachments: readonly GmailMailAttachment[];
  /** The version the item carries: live, Gmail's history id; an import, its content digest. */
  sourceVersion?: string;
}

/**
 * An attachment's child id (core/child-item-id.ts): the message's id and the
 * part's MIME path, which live Gmail (`partId`) and an export's MIME tree give
 * alike for the same message, so both inputs name one child. The whole-message
 * part (a message whose body is the file) has the empty path, keyed `root`.
 * Never the file name: two parts may share one, and a name is the sender's.
 */
export const gmailChildProviderId = (messageId: string, partId: string): string => childProviderItemId(messageId, partId || 'root');

const gmailId = (record: GmailMailRecord): boolean => !record.id.startsWith(GMAIL_OWN_ID_PREFIX);

/**
 * How a lane builds mail. `children`: each attachment is an item of its own
 * (2.1.0). Off until the lane reads attachments' bytes: a child nothing reads
 * would stay owed reading on the source's card for ever. Every input of one
 * lane builds with the lane's own choice, so both name the same items.
 */
export interface GmailMailBuild {
  children?: boolean;
}

/** The children a record lists: parts with a file name (not inside another), of mail whose content is in scope. */
function childrenOf(record: GmailMailRecord, build: GmailMailBuild): readonly GmailMailAttachment[] {
  return record.metadataOnly || build.children !== true ? [] : record.attachments.filter((attachment) => attachment.nested !== true && attachment.filename.trim() !== '');
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parsedDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function internalDateIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Number.parseInt(value, 10);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function attachmentLine(attachment: GmailMailAttachment): string {
  const details = [
    attachment.mimeType?.trim() || undefined,
    attachment.size !== undefined ? `${attachment.size} bytes` : undefined,
    attachment.partId.trim() ? `part ${attachment.partId.trim()}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return `Attachment: ${attachment.filename.slice(0, MAX_ATTACHMENT_NAME_CHARS)}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

function headersSummary(headers: GmailMailRecord['headers']): string {
  return [
    headers.subject ? `Subject: ${headers.subject}` : undefined,
    headers.from ? `From: ${headers.from}` : undefined,
    headers.to ? `To: ${headers.to}` : undefined,
    headers.date ? `Date: ${headers.date}` : undefined,
  ].filter(Boolean).join('\n');
}

function messageText(record: GmailMailRecord): string {
  return [headersSummary(record.headers), record.snippet, record.body]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

function identityOf(record: GmailMailRecord, account: string) {
  return {
    family: 'email' as const,
    provider: GMAIL_MAIL_PROVIDER,
    accountScope: account,
    providerItemId: record.id,
    ...(record.threadId ? { providerThreadId: record.threadId } : {}),
    localItemId: `${account}:${record.id}`,
    ...(record.sourceVersion ? { sourceVersion: record.sourceVersion } : {}),
  };
}

function childIdentityOf(record: GmailMailRecord, account: string, attachment: GmailMailAttachment) {
  const providerItemId = gmailChildProviderId(record.id, attachment.partId);
  return {
    family: 'email' as const,
    provider: GMAIL_MAIL_PROVIDER,
    accountScope: account,
    providerItemId,
    ...(record.threadId ? { providerThreadId: record.threadId } : {}),
    localItemId: `${account}:${providerItemId}`,
    ...(record.sourceVersion ? { sourceVersion: record.sourceVersion } : {}),
    parent: { providerItemId: record.id, localItemId: `${account}:${record.id}` },
  };
}

/** The message's own item. */
export function gmailMessageItem(record: GmailMailRecord, account: string, fetchedAt = new Date().toISOString()): RawItem {
  const subject = record.headers.subject ?? '(no subject)';
  // Sender-controlled and uncapped from Gmail. A longer header is stored as
  // its first 4 KB plus a truncation mark, one character over the bound every
  // sender-rule parse applies, so a truncated From is always unparseable.
  const rawFrom = record.headers.from ?? '';
  const from = rawFrom.length > MAX_FROM_HEADER_CHARS ? `${rawFrom.slice(0, MAX_FROM_HEADER_CHARS)}…` : rawFrom;
  const date = parsedDate(record.headers.date) ?? internalDateIso(record.internalDate);
  // Mail older than the approved window: subject, sender, date and labels
  // only. No body and no snippet (the snippet is body text), so the item stays
  // findable by name and can be upgraded to full content later.
  const metadataOnly = record.metadataOnly;
  const attachments = record.attachments;
  const lines = attachments.map(attachmentLine);
  const bytes = attachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0);
  // Mail inside the window is read as its envelope (Subject/From/To/Date), its
  // snippet and its body, so an attachment-only message already has text. A
  // message with none of those would be stored with no chunks and stay owed
  // reading forever, though it has nothing more to read: it reads as its
  // attachment names, else as the subject line the title already shows.
  const text = metadataOnly ? '' : messageText(record) || (lines.length > 0 ? lines.join('\n') : `Subject: ${subject}`);
  return {
    identity: identityOf(record, account),
    mimeType: 'message/rfc822',
    content: !metadataOnly && text.trim() ? { kind: 'text', text } : { kind: 'metadata_only' },
    metadata: Object.freeze({
      title: subject,
      subject,
      from,
      ...(record.headers.to ? { to: record.headers.to } : {}),
      ...(date ? { authoredAt: date } : {}),
      // Carried verbatim: it is the traversal's incremental watermark, and
      // Gmail's `after:` operator speaks the same clock.
      ...(record.internalDate ? { internalDate: record.internalDate } : {}),
      ...(record.historyId ? { historyId: record.historyId } : {}),
      ...(record.headers.messageId ? { messageId: record.headers.messageId } : {}),
      ...(record.snippet && !metadataOnly ? { snippet: record.snippet } : {}),
      // Marks mail kept by name only under the approved window. The shared
      // tier path reads it: such an item has no content to judge, so its
      // content layer settles at ingest instead of waiting for text.
      ...(metadataOnly ? namesOnlyContentScopeMetadata() : {}),
      labels: [...record.labelIds],
      attachmentCount: attachments.length,
      attachmentBytesDeclared: bytes,
      // Name, type, size and MIME part of each attachment, searchable with the
      // message. The parts themselves are the message's children.
      ...(lines.length > 0 ? { attachments: lines } : {}),
      // Attachments whose bytes are not read with the message: every one. A
      // child's bytes are read later, on their own, by the extraction factory.
      attachmentsNotIngested: attachments.length,
      // Only a Gmail id opens in Gmail; a message no Gmail id was found for has no link.
      ...(gmailId(record) ? { locatorUri: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(record.id)}` } : {}),
      contentHash: hashString(`${record.historyId ?? ''}:${metadataOnly ? 'metadata_only' : text}`),
    }),
    fetchedAt,
  };
}

/** One attachment of the message as an item of its own, listed by name. */
function gmailChildItem(record: GmailMailRecord, account: string, attachment: GmailMailAttachment, fetchedAt: string): RawItem {
  const date = parsedDate(record.headers.date) ?? internalDateIso(record.internalDate);
  const name = attachment.filename.slice(0, MAX_ATTACHMENT_NAME_CHARS);
  const rawFrom = record.headers.from ?? '';
  const from = rawFrom.length > MAX_FROM_HEADER_CHARS ? `${rawFrom.slice(0, MAX_FROM_HEADER_CHARS)}…` : rawFrom;
  return {
    identity: childIdentityOf(record, account, attachment),
    mimeType: attachment.mimeType?.trim() || 'application/octet-stream',
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({
      title: name,
      name,
      // The parent's sender and time: a child is found by them as its message is.
      ...(from ? { from } : {}),
      ...(date ? { authoredAt: date } : {}),
      ...(attachment.size !== undefined ? { sizeBytes: attachment.size } : {}),
      ...(gmailId(record) ? { locatorUri: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(record.id)}` } : {}),
    }),
    fetchedAt,
    deferredBytes: {
      locator: attachment.locator ?? '',
      available: attachment.locator !== undefined,
      ...(attachment.size !== undefined ? { sizeBytes: attachment.size } : {}),
    },
  };
}

/** The message's item, then its children in part order: the one way a record becomes items. */
export function gmailMailItems(
  record: GmailMailRecord,
  account: string,
  build: GmailMailBuild = {},
  wanted?: ReadonlySet<string>,
): RawItem[] {
  const fetchedAt = new Date().toISOString();
  const items: RawItem[] = [];
  const parent = gmailMessageItem(record, account, fetchedAt);
  if (!wanted || wanted.has(parent.identity.localItemId)) items.push(parent);
  for (const attachment of childrenOf(record, build)) {
    const child = gmailChildItem(record, account, attachment, fetchedAt);
    if (!wanted || wanted.has(child.identity.localItemId)) items.push(child);
  }
  return items;
}

/** What the intake rule reads of a record: its items, cheaply, without building them. */
export function gmailMailEntries(record: GmailMailRecord, account: string, build: GmailMailBuild = {}): SourceRecordEntry[] {
  const authoredAt = parsedDate(record.headers.date) ?? internalDateIso(record.internalDate);
  return [
    { identity: identityOf(record, account), bringsContent: !record.metadataOnly, ...(authoredAt ? { authoredAt } : {}) },
    ...childrenOf(record, build).map((attachment) => ({ identity: childIdentityOf(record, account, attachment), bringsContent: false })),
  ];
}

/** Mail does not change: every version of a message is the same one. */
export const compareGmailMailVersions = (_a: string, _b: string): number => 0;

/**
 * Mail facts only: subject as the title (a child's file name), the sender, and
 * the provider's labels. Gmail publishes no folder path and no sharing state,
 * so neither is claimed.
 */
export function gmailClassificationSignals(item: RawItem): SourceClassificationSignals {
  const subject = metadataString(item.metadata, 'subject') ?? metadataString(item.metadata, 'title');
  const sender = metadataString(item.metadata, 'from');
  const labels = metadataStringArray(item.metadata, 'labels');
  return {
    ...(subject ? { title: subject } : {}),
    ...(sender ? { sender } : {}),
    ...(labels.length > 0 ? { labels } : {}),
  };
}
