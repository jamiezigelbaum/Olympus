/**
 * An mbox export of a Gmail account (Google Takeout) as an input of the Gmail
 * connector (docs/design/archive-live-one-dataset.md, sections 1, 4 and 7).
 *
 * It reads the export as the Archives reader does (connector.ts: the same
 * splitter, bounds, findings, change checks and resume point) and yields each
 * message as the Gmail connector's own record, a parsed mail
 * (google-connectors/gmail-mail-record.ts). The Gmail connector builds the
 * items, as it builds live mail's.
 *
 * - **Identity.** Takeout writes the Gmail message id in each message's `From `
 *   line, in decimal (`From 1234567890123456789@xxx …`); the API's id is the
 *   same number in hex, so such a message names the live item exactly.
 *   `X-GM-THRID` is the thread id in decimal, likewise. A message without the
 *   id is matched by its headers (`match`, section 4); one that matches no
 *   Gmail message, or several, keeps an id of its own (`mbox-…`).
 * - **Labels.** `X-Gmail-Labels` names labels; Gmail's own ones are given by
 *   the ids live Gmail uses (`Inbox` is `INBOX`), user labels by their names.
 *   `Opened` and `Archived` are the absence of `UNREAD` and `INBOX`, so they
 *   are dropped. Spam and Trash are skipped, as live Gmail lists neither.
 * - **Attachments.** Each MIME part with a file name, by its part path, with a
 *   locator into this archive (`mbox-part1:<file>:<offset>:<part>`). Whether
 *   they become child items is the Gmail lane's choice, the same for both
 *   inputs; when they do not, they are counted as not read, as before.
 */
import type { SourceConnectorInput, SourceInputKind, SourceRecordPage } from '../../../core/contracts.ts';
import type { ArchiveConnectorInput } from '../../../core/archive-formats.ts';
import type { ScopeFileReader } from '../../../core/scope-safe-fs.ts';
import { GMAIL_OWN_ID_PREFIX, type GmailMailBuild, type GmailMailRecord } from '../../google-connectors/gmail-mail-record.ts';
import { archiveConnectorId } from '../state.ts';
import {
  MBOX_DEFAULT_MAX_BYTES_PER_LISTING,
  MBOX_DEFAULT_PAGE_SIZE,
  MBOX_FINDINGS,
  cursorAt,
  doneCursor,
  parseCursor,
  stoppedFrom,
} from './connector.ts';
import { mimeAttachments } from './mime-parts.ts';
import { parseMboxMessage, sha256, type ParsedMboxMessage } from './parse.ts';
import { MBOX_DEFAULT_MAX_MESSAGE_BYTES, MboxSplitter, type MboxMessageSpan } from './split.ts';

/** What a message without Takeout's id offers for matching. */
export interface MboxMessageHeaders {
  messageId?: string;
  date?: string;
  from: string;
  subject?: string;
}

/**
 * The Gmail message a message is, by its headers (section 4): its id, or
 * `none` (no Gmail message agrees, or several do). One that cannot be asked
 * now throws, and the pass fails before anything of its page is stored, so a
 * later pass reads the message again.
 */
export type MboxGmailMatch = (headers: MboxMessageHeaders) => Promise<{ id: string } | 'none'>;

export interface MboxGmailInputOptions {
  build?: GmailMailBuild;
  match?: MboxGmailMatch;
}

const TAKEOUT_ID = /^From (\d{1,20})@xxx(?:\s|$)/;
const MAX_GMAIL_ID = (1n << 64n) - 1n;
export const MBOX_PART_LOCATOR_PREFIX = 'mbox-part1:';

/** Gmail's id, in the API's hex form, from Takeout's decimal; undefined when it is not one. */
export function gmailIdFromDecimal(decimal: string | undefined): string | undefined {
  if (!decimal || !/^\d{1,20}$/.test(decimal)) return undefined;
  const value = BigInt(decimal);
  return value > 0n && value <= MAX_GMAIL_ID ? value.toString(16) : undefined;
}

/** The Gmail message id Takeout wrote in a message's `From ` line. */
export function takeoutMessageId(separator: string | undefined): string | undefined {
  return gmailIdFromDecimal(separator ? TAKEOUT_ID.exec(separator)?.[1] : undefined);
}

/** Gmail's own labels by the names Takeout writes; anything else is a user label, kept by name. */
const SYSTEM_LABELS = new Map<string, string | null>([
  ['inbox', 'INBOX'],
  ['sent', 'SENT'],
  ['important', 'IMPORTANT'],
  ['starred', 'STARRED'],
  ['unread', 'UNREAD'],
  ['draft', 'DRAFT'],
  ['drafts', 'DRAFT'],
  ['chat', 'CHAT'],
  ['spam', 'SPAM'],
  ['trash', 'TRASH'],
  ['category personal', 'CATEGORY_PERSONAL'],
  ['category social', 'CATEGORY_SOCIAL'],
  ['category promotions', 'CATEGORY_PROMOTIONS'],
  ['category updates', 'CATEGORY_UPDATES'],
  ['category forums', 'CATEGORY_FORUMS'],
  // The absence of UNREAD and of INBOX, which live Gmail says by leaving them out.
  ['opened', null],
  ['archived', null],
]);

export function gmailLabelIds(names: readonly string[]): string[] {
  const ids: string[] = [];
  for (const name of names) {
    const system = SYSTEM_LABELS.get(name.trim().toLowerCase());
    const id = system === undefined ? name.trim() : system;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The locator of one MIME part of one message of the archive. */
export function mboxPartLocator(fileIndex: number, offset: number, partId: string): string {
  return `${MBOX_PART_LOCATOR_PREFIX}${fileIndex}:${offset}:${partId}`;
}

function recordOf(
  parsed: ParsedMboxMessage,
  span: MboxMessageSpan,
  fileIndex: number,
  id: string,
): GmailMailRecord {
  const threadId = parsed.gmailThread
    ? gmailIdFromDecimal(parsed.gmailThread)
    : parsed.threadRoot ? `mid:${sha256(parsed.threadRoot).slice(0, 24)}` : undefined;
  return {
    id,
    ...(threadId ? { threadId } : {}),
    labelIds: gmailLabelIds(parsed.labels),
    headers: {
      ...(parsed.subject ? { subject: parsed.subject } : {}),
      ...(parsed.from ? { from: parsed.from } : {}),
      ...(parsed.to ? { to: parsed.to } : {}),
      ...(parsed.dateHeader ? { date: parsed.dateHeader } : {}),
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
    },
    body: parsed.body,
    metadataOnly: false,
    attachments: mimeAttachments(span.raw!).map((part) => ({
      partId: part.partId,
      filename: part.filename,
      ...(part.mimeType ? { mimeType: part.mimeType } : {}),
      size: part.size,
      locator: mboxPartLocator(fileIndex, span.offset, part.partId),
      ...(part.nested ? { nested: true } : {}),
    })),
    sourceVersion: parsed.messageHash.slice(0, 32),
  };
}

/** The id of a message no Gmail id is known for: its Message-ID and its bytes, as the Archives reader names it. */
function ownId(parsed: ParsedMboxMessage): string {
  return `${GMAIL_OWN_ID_PREFIX}${sha256(`${parsed.messageId ?? ''}\u0000${parsed.messageHash}`).slice(0, 32)}`;
}

export function mboxGmailInput(archive: ArchiveConnectorInput, options: MboxGmailInputOptions = {}): SourceConnectorInput<GmailMailRecord> {
  const pageSizeDefault = Math.max(1, archive.pageSize ?? MBOX_DEFAULT_PAGE_SIZE);
  const byteBudget = Math.max(1, archive.maxBytesPerListing ?? MBOX_DEFAULT_MAX_BYTES_PER_LISTING);
  const children = options.build?.children === true;
  return {
    inputId: archiveConnectorId(archive.archiveId),
    kind: 'archive' as SourceInputKind,
    records(listOptions): AsyncIterable<SourceRecordPage<GmailMailRecord>> {
      return (async function* (): AsyncGenerator<SourceRecordPage<GmailMailRecord>> {
        const start = parseCursor(archive, listOptions?.cursor);
        if (start.done || archive.files.length === 0) {
          yield { records: [], nextCursor: doneCursor(archive), done: true };
          return;
        }
        const limit = listOptions?.limit !== undefined && listOptions.limit > 0 ? listOptions.limit : Number.POSITIVE_INFINITY;
        const pageSize = Math.max(1, Math.min(pageSizeDefault, limit));
        let bytesRead = 0;
        for (let fileIndex = start.fileIndex; fileIndex < archive.files.length; fileIndex += 1) {
          const file = archive.files[fileIndex]!;
          let reader: ScopeFileReader;
          try {
            reader = archive.root.openFile(file.relPath, { expected: file.version });
          } catch (error) {
            throw stoppedFrom(error, file.relPath);
          }
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
            let page: GmailMailRecord[] = [];
            let positions: Array<{ fileIndex: number; offset: number }> = [];
            let pending = false;
            const out = (nextOffset: number, last: boolean): SourceRecordPage<GmailMailRecord> => {
              current();
              archive.reportItemPositions?.(positions);
              if (last) return { records: page, nextCursor: doneCursor(archive), done: true };
              archive.reportPosition?.({ fileIndex, offset: nextOffset });
              return { records: page, nextCursor: cursorAt(archive, fileIndex, nextOffset), done: false };
            };
            for (;;) {
              if (!archive.shouldContinue()) {
                if (pending) yield out(splitter.position, false);
                return;
              }
              let span: MboxMessageSpan | undefined;
              try {
                span = splitter.next();
              } catch (error) {
                throw stoppedFrom(error, file.relPath);
              }
              if (!span) break;
              bytesRead += span.length;
              const report = (kind: string, findingClass: 'gap' | 'skipped', count?: number): void => {
                archive.report({ kind, class: findingClass, fileIndex, offset: span!.offset, ...(count !== undefined ? { count } : {}) });
              };
              if (span.tooLarge) {
                report(MBOX_FINDINGS.tooLarge, 'gap');
              } else {
                const parsed = await parseMboxMessage(span.raw!);
                if (!parsed) report(MBOX_FINDINGS.unreadable, 'gap');
                else if (parsed.spamOrTrash) report(MBOX_FINDINGS.spamOrTrash, 'skipped');
                else {
                  let id = takeoutMessageId(span.separator);
                  if (id === undefined && options.match) {
                    const matched = await options.match({
                      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
                      ...(parsed.dateHeader ? { date: parsed.dateHeader } : {}),
                      from: parsed.from,
                      ...(parsed.subject ? { subject: parsed.subject } : {}),
                    });
                    if (matched !== 'none') id = matched.id;
                  }
                  const record = recordOf(parsed, span, fileIndex, id ?? ownId(parsed));
                  page.push(record);
                  positions.push({ fileIndex, offset: span.offset });
                  pending = true;
                  const named = record.attachments.filter((attachment) => attachment.nested !== true).length;
                  if (named > 0 && !children) report(MBOX_FINDINGS.attachments, 'gap', named);
                  if (parsed.charsetNotDecoded) report(MBOX_FINDINGS.charset, 'gap');
                }
              }
              if (page.length >= pageSize || bytesRead >= byteBudget) {
                const last = fileIndex === archive.files.length - 1 && splitter.done;
                yield out(splitter.position, last);
                if (last) return;
                page = [];
                positions = [];
                pending = false;
                if (bytesRead >= byteBudget) return;
              }
            }
            if (fileIndex === archive.files.length - 1) {
              yield out(splitter.position, true);
              return;
            }
            if (pending) {
              current();
              archive.reportItemPositions?.(positions);
              archive.reportPosition?.({ fileIndex: fileIndex + 1, offset: 0 });
              yield { records: page, nextCursor: cursorAt(archive, fileIndex + 1, 0), done: false };
            }
          } finally {
            reader.close();
          }
        }
      })();
    },
  };
}
