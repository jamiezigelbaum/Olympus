/**
 * The mbox archive connector: one RawItem per message, shaped like a live
 * Gmail message (subject, from, to, date, labels, attachment names) so
 * answers treat imported and live mail alike.
 *
 * - Reading: the archive's files in manifest order through the scope-safe
 *   range reader, split by `split.ts`, each message parsed by postal-mime
 *   under bounds. A message over the size bound, or one that does not parse,
 *   is a gap; nothing of it is stored.
 * - Identity: the Message-ID plus a hash of the whole message, so two
 *   different messages sharing headers never merge, and an exact duplicate
 *   inside one export is one item.
 * - Labels: `X-Gmail-Labels` (Google Takeout) are kept as labels. Spam and
 *   Trash are skipped, as live Gmail lists neither.
 * - Attachments: named on the message, bytes never stored (the same posture
 *   as live Gmail); counted as a gap.
 * - Character sets: text whose declared charset nothing here decodes is read
 *   with postal-mime's fallback and counted as a gap.
 * - Changes: each page goes out only while its file is still the version
 *   opened, under the descriptor and at its name; a file changed, replaced
 *   or removed after the first page stops the import, whatever was buffered.
 * - Resume point: `mbox1:<manifest>:<file>:<offset>`, the byte offset of the
 *   next message in a file of exactly this manifest. Any other manifest, or an
 *   offset that is not a message start, stops the import.
 */
import { createHash } from 'node:crypto';
import PostalMime, { decodeWords, type Email } from 'postal-mime';
import type { RawItem, SourceClassificationSignals, SourceConnector, SourceConnectorListOptions, SourceConnectorListPage } from '../../../core/contracts.ts';
import {
  ArchiveImportStoppedError,
  registerArchiveFormatConnector,
  type ArchiveConnectorInput,
} from '../../../core/archive-formats.ts';
import type { ScopeFileReader } from '../../../core/scope-safe-fs.ts';
import { archiveStopFromScopeError } from '../stop-errors.ts';
import { MAX_FROM_HEADER_CHARS } from '../../../core/sender-rules.ts';
import { MBOX_DEFAULT_MAX_MESSAGE_BYTES, MboxFormatError, MboxSplitter, type MboxMessageSpan } from './split.ts';

export const MBOX_CURSOR_PREFIX = 'mbox1:';
export const MBOX_DEFAULT_PAGE_SIZE = 100;
export const MBOX_DEFAULT_MAX_BYTES_PER_LISTING = 256 * 1024 * 1024;
/** Text kept per message; longer bodies are cut and counted as a gap. */
export const MBOX_MAX_ITEM_TEXT_CHARS = 1_000_000;
const MAX_ATTACHMENT_NAME_CHARS = 256;

export const MBOX_FINDINGS = {
  tooLarge: 'message_too_large',
  unreadable: 'message_unreadable',
  charset: 'charset_not_decoded',
  attachments: 'attachments_not_read',
  textCut: 'text_cut',
  spamOrTrash: 'spam_or_trash',
} as const;

const SKIPPED_LABELS = new Set(['spam', 'trash']);

interface ParsedCursor {
  fileIndex: number;
  offset: number;
  done: boolean;
}

function manifestTag(input: ArchiveConnectorInput): string {
  return input.manifestSha256.slice(0, 16);
}

function cursorAt(input: ArchiveConnectorInput, fileIndex: number, offset: number): string {
  return `${MBOX_CURSOR_PREFIX}${manifestTag(input)}:${fileIndex}:${offset}`;
}

function doneCursor(input: ArchiveConnectorInput): string {
  return `${MBOX_CURSOR_PREFIX}${manifestTag(input)}:done`;
}

function parseCursor(input: ArchiveConnectorInput, cursor: string | undefined): ParsedCursor {
  if (!cursor) return { fileIndex: 0, offset: 0, done: false };
  const prefix = `${MBOX_CURSOR_PREFIX}${manifestTag(input)}:`;
  if (!cursor.startsWith(prefix)) {
    throw new ArchiveImportStoppedError('resume_point_invalid', 'The resume point belongs to other files than this archive\'s.');
  }
  const rest = cursor.slice(prefix.length);
  if (rest === 'done') return { fileIndex: input.files.length, offset: 0, done: true };
  const [fileText, offsetText, extra] = rest.split(':');
  const fileIndex = Number(fileText);
  const offset = Number(offsetText);
  if (extra !== undefined || !Number.isSafeInteger(fileIndex) || !Number.isSafeInteger(offset)
    || fileIndex < 0 || offset < 0 || fileIndex >= input.files.length || offset > input.files[fileIndex]!.version.size) {
    throw new ArchiveImportStoppedError('resume_point_invalid', 'The resume point is not a position in this archive.');
  }
  return { fileIndex, offset, done: false };
}

function stoppedFrom(error: unknown, relPath: string): unknown {
  if (error instanceof MboxFormatError) {
    return new ArchiveImportStoppedError('resume_point_invalid', 'No message starts where this import was to resume.', relPath);
  }
  return archiveStopFromScopeError(error, relPath);
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function headerValue(email: Email, key: string): string | undefined {
  const value = email.headers.find((header) => header.key === key)?.value?.trim();
  return value ? value : undefined;
}

function decoded(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeWords(value).trim() || undefined;
  } catch {
    return value;
  }
}

function bareMessageId(value: string | undefined): string | undefined {
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

function stripHtml(value: string): string {
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

interface AttachmentInventory {
  count: number;
  bytes: number;
  lines: string[];
}

function attachmentInventory(email: Email): AttachmentInventory {
  const inventory: AttachmentInventory = { count: 0, bytes: 0, lines: [] };
  for (const attachment of email.attachments) {
    const name = attachment.filename?.trim();
    if (!name && attachment.disposition !== 'attachment') continue;
    const content = attachment.content;
    const size = typeof content === 'string' ? undefined : content.byteLength;
    inventory.count += 1;
    inventory.bytes += size ?? 0;
    const details = [attachment.mimeType || undefined, size !== undefined ? `${size} bytes` : undefined]
      .filter((value): value is string => Boolean(value));
    const label = (name || 'unnamed attachment').slice(0, MAX_ATTACHMENT_NAME_CHARS);
    inventory.lines.push(`Attachment: ${label}${details.length > 0 ? ` (${details.join(', ')})` : ''}`);
  }
  return inventory;
}

type MessageOutcome =
  | { kind: 'item'; item: RawItem; findings: Array<{ kind: string; count?: number }> }
  | { kind: 'skipped'; reason: string }
  | { kind: 'unreadable' };

async function messageOutcome(input: ArchiveConnectorInput, span: MboxMessageSpan): Promise<MessageOutcome> {
  const raw = span.raw!;
  let email: Email;
  try {
    email = await PostalMime.parse(raw, {
      maxHeadersSize: 1024 * 1024,
      maxPartCount: 2_000,
      maxNestingDepth: 64,
      maxRfc822NestingDepth: 4,
    });
  } catch {
    return { kind: 'unreadable' };
  }
  const labels = (headerValue(email, 'x-gmail-labels') ?? '')
    .split(',')
    .map((label) => decoded(label.trim()) ?? '')
    .filter((label) => label !== '');
  if (labels.some((label) => SKIPPED_LABELS.has(label.toLowerCase()))) return { kind: 'skipped', reason: MBOX_FINDINGS.spamOrTrash };

  const findings: Array<{ kind: string; count?: number }> = [];
  const subject = email.subject?.trim() || '(no subject)';
  const rawFrom = decoded(headerValue(email, 'from')) ?? '';
  const from = rawFrom.length > MAX_FROM_HEADER_CHARS ? `${rawFrom.slice(0, MAX_FROM_HEADER_CHARS)}…` : rawFrom;
  const to = decoded(headerValue(email, 'to'));
  const dateHeader = headerValue(email, 'date');
  const authoredAt = isoDate(email.date) ?? isoDate(dateHeader);
  const attachments = attachmentInventory(email);
  if (attachments.count > 0) findings.push({ kind: MBOX_FINDINGS.attachments, count: attachments.count });
  if (declaredCharsets(raw).some((charset) => !charsetDecodable(charset))) findings.push({ kind: MBOX_FINDINGS.charset });

  const summary = [
    email.subject?.trim() ? `Subject: ${email.subject.trim()}` : undefined,
    from ? `From: ${from}` : undefined,
    to ? `To: ${to}` : undefined,
    dateHeader ? `Date: ${dateHeader}` : undefined,
  ].filter(Boolean).join('\n');
  const body = email.text?.trim() || (email.html ? stripHtml(email.html) : '');
  // Attachments are named (never read), so a question about one finds its message.
  let text = [summary, body, attachments.lines.join('\n')].filter((part) => part !== '').join('\n\n')
    || `Subject: ${subject}`;
  if (text.length > MBOX_MAX_ITEM_TEXT_CHARS) {
    text = text.slice(0, MBOX_MAX_ITEM_TEXT_CHARS);
    findings.push({ kind: MBOX_FINDINGS.textCut });
  }

  const messageId = bareMessageId(email.messageId ?? headerValue(email, 'message-id'));
  const messageHash = sha256(raw);
  const providerItemId = sha256(`${messageId ?? ''}\u0000${messageHash}`).slice(0, 32);
  const gmailThread = headerValue(email, 'x-gm-thrid');
  const threadRoot = firstMessageId(email.references) ?? firstMessageId(email.inReplyTo) ?? messageId;
  const providerThreadId = gmailThread && /^\d+$/.test(gmailThread)
    ? `gm:${gmailThread}`
    : threadRoot ? `mid:${sha256(threadRoot).slice(0, 24)}` : undefined;

  const item: RawItem = {
    identity: {
      family: input.format.family,
      provider: input.format.provider,
      accountScope: input.accountScope,
      providerItemId,
      ...(providerThreadId ? { providerThreadId } : {}),
      localItemId: `${input.accountScope}:${providerItemId}`,
      sourceVersion: messageHash.slice(0, 32),
    },
    mimeType: 'message/rfc822',
    content: { kind: 'text', text },
    metadata: Object.freeze({
      title: subject,
      subject,
      from,
      ...(to ? { to } : {}),
      ...(authoredAt ? { authoredAt } : {}),
      ...(messageId ? { messageId } : {}),
      labels,
      attachmentCount: attachments.count,
      attachmentBytesDeclared: attachments.bytes,
      ...(attachments.lines.length > 0 ? { attachments: attachments.lines } : {}),
      attachmentsNotIngested: attachments.count,
      contentHash: sha256(text),
    }),
    fetchedAt: new Date().toISOString(),
  };
  return { kind: 'item', item, findings };
}

export function createMboxArchiveConnector(input: ArchiveConnectorInput): SourceConnector {
  const pageSizeDefault = Math.max(1, input.pageSize ?? MBOX_DEFAULT_PAGE_SIZE);
  const byteBudget = Math.max(1, input.maxBytesPerListing ?? MBOX_DEFAULT_MAX_BYTES_PER_LISTING);
  return {
    id: input.connectorId,
    family: input.format.family,
    async authenticate(): Promise<void> {
      // No account: the approved files are the whole grant.
    },
    listItems(options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        const start = parseCursor(input, options?.cursor);
        if (start.done) {
          yield { items: [], nextCursor: doneCursor(input), done: true };
          return;
        }
        const limit = options?.limit !== undefined && options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY;
        let emitted = 0;
        let bytesRead = 0;
        for (let fileIndex = start.fileIndex; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex]!;
          let reader: ScopeFileReader;
          try {
            reader = input.root.openFile(file.relPath, { expected: file.version });
          } catch (error) {
            throw stoppedFrom(error, file.relPath);
          }
          // Before each page goes out, even one served from messages already
          // read: the file is still the version opened, at its name too.
          const current = (): void => {
            try {
              reader.assertCurrent();
            } catch (error) {
              throw stoppedFrom(error, file.relPath);
            }
          };
          try {
            const splitter = new MboxSplitter(reader, {
              start: fileIndex === start.fileIndex ? start.offset : 0,
              maxMessageBytes: MBOX_DEFAULT_MAX_MESSAGE_BYTES,
            });
            let page: RawItem[] = [];
            let pending = false;
            for (;;) {
              if (!input.shouldContinue()) {
                if (pending) {
                  current();
                  input.reportPosition?.({ fileIndex, offset: splitter.position });
                  yield { items: page, nextCursor: cursorAt(input, fileIndex, splitter.position), done: false };
                }
                return;
              }
              let span: MboxMessageSpan | undefined;
              try {
                span = splitter.next();
              } catch (error) {
                throw stoppedFrom(error, file.relPath);
              }
              if (!span) break;
              pending = true;
              bytesRead += span.length;
              const report = (kind: string, findingClass: 'gap' | 'skipped', count?: number): void => {
                input.report({ kind, class: findingClass, fileIndex, offset: span!.offset, ...(count !== undefined ? { count } : {}) });
              };
              if (span.tooLarge) {
                report(MBOX_FINDINGS.tooLarge, 'gap');
              } else {
                const outcome = await messageOutcome(input, span);
                if (outcome.kind === 'unreadable') report(MBOX_FINDINGS.unreadable, 'gap');
                else if (outcome.kind === 'skipped') report(outcome.reason, 'skipped');
                else {
                  page.push(outcome.item);
                  for (const finding of outcome.findings) report(finding.kind, 'gap', finding.count);
                }
              }
              const budgetLeft = limit - emitted;
              if (page.length >= Math.min(pageSizeDefault, budgetLeft) || bytesRead >= byteBudget) {
                current();
                const last = fileIndex === input.files.length - 1 && splitter.done;
                if (last) {
                  yield { items: page, nextCursor: doneCursor(input), done: true };
                  return;
                }
                input.reportPosition?.({ fileIndex, offset: splitter.position });
                yield { items: page, nextCursor: cursorAt(input, fileIndex, splitter.position), done: false };
                emitted += page.length;
                page = [];
                pending = false;
                if (emitted >= limit || bytesRead >= byteBudget) return;
              }
            }
            current();
            if (fileIndex === input.files.length - 1) {
              yield { items: page, nextCursor: doneCursor(input), done: true };
              return;
            }
            if (pending) {
              input.reportPosition?.({ fileIndex: fileIndex + 1, offset: 0 });
              yield { items: page, nextCursor: cursorAt(input, fileIndex + 1, 0), done: false };
              emitted += page.length;
              if (emitted >= limit) return;
            }
          } finally {
            reader.close();
          }
        }
      })();
    },
    async fetchItem(): Promise<RawItem> {
      throw new Error('An imported message is read only while its archive is listed.');
    },
    classificationSignals(item: RawItem): SourceClassificationSignals {
      const subject = typeof item.metadata.subject === 'string' ? item.metadata.subject : undefined;
      const sender = typeof item.metadata.from === 'string' && item.metadata.from ? item.metadata.from : undefined;
      const labels = Array.isArray(item.metadata.labels)
        ? item.metadata.labels.filter((label): label is string => typeof label === 'string')
        : [];
      return {
        ...(subject ? { title: subject } : {}),
        ...(sender ? { sender } : {}),
        ...(labels.length > 0 ? { labels } : {}),
      };
    },
  };
}

/** Registers the mbox connector with the format registry. Idempotent. */
export function registerMboxArchiveConnector(): void {
  registerArchiveFormatConnector('mbox', createMboxArchiveConnector);
}
