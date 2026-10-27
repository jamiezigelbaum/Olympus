// A Telegram Desktop JSON export as an input of the Telegram connector
// (docs/design/archive-live-one-dataset.md, sections 1, 4, 5 and 7).
//
// The export is read by the archive reader's own streaming walk
// (archive-import/telegram/connector.ts: bounded per message and per pass,
// damage counted, a resume point bound to its files), and every entry becomes
// a record of the Telegram connector in the live spool's shape
// (export-records.ts). A message's photo or file in the export's folder is a
// child of the message, listed by name and read later.

import { dirname } from 'node:path';
import { ARCHIVE_COMMON_FINDINGS, type ArchiveConnectorInput } from '../../core/archive-formats.ts';
import type { RawItem, SourceConnectorInput, SourceRecordPage } from '../../core/contracts.ts';
import { telegramMediaChild } from './media-child.ts';
import { TELEGRAM_FINDINGS, telegramExportChat, telegramExportPages } from '../archive-import/telegram/connector.ts';
import {
  telegramAccountEntryRecord,
  telegramExportMessageRecord,
  type TelegramExportMedia,
  type TelegramExportRecordContext,
} from './export-records.ts';
import type { TelegramRecordItems } from './record-builder.ts';
import { telegramExportFacts } from './export-facts.ts';

/** The locator of a media file an archive input bound, in the shared shape (archive-import/input-media.ts, WhatsApp lane). */
export function telegramExportMediaLocator(archiveId: string, bindingId: string): string {
  return `archive-input-media:v1:${archiveId}:b:${bindingId}`;
}

function child(
  parent: RawItem,
  media: TelegramExportMedia,
  deferredBytes: RawItem['deferredBytes'],
): RawItem {
  return telegramMediaChild(parent, { name: media.name, kind: media.field, ...(media.mimeType ? { mimeType: media.mimeType } : {}) }, deferredBytes);
}

export interface TelegramExportInputOptions {
  /** The live account scope the export's records join (`telegram.personal`). */
  account: string;
  /** The exporting account's user id, when its profile is in the export. */
  ownUserId?: string;
}

/**
 * The export as an input of the Telegram connector: its records in the live
 * spool's shape, with exact chat and message ids, and each message's media in
 * the export's folder as children.
 */
export function telegramExportInput(
  archive: ArchiveConnectorInput,
  options: TelegramExportInputOptions,
): SourceConnectorInput<TelegramRecordItems> {
  const file = archive.files[0];
  if (!file || archive.files.length !== 1) throw new Error('A Telegram export is one result.json.');
  const base = dirname(file.relPath) === '.' ? '' : dirname(file.relPath);
  const fetchedAt = new Date().toISOString();
  const context: TelegramExportRecordContext = {
    account: options.account,
    fetchedAt,
    ...(options.ownUserId ? { ownUserId: options.ownUserId } : {}),
  };
  // The media files each message names, bound under the chosen folder when the
  // export was chosen as a folder (a lone result.json approves nothing beside it).
  const children = (parent: RawItem, media: readonly TelegramExportMedia[], at: number): RawItem[] => media.map((entry) => {
    if (entry.leftOut || !entry.path) {
      return child(parent, entry, { locator: '', available: false });
    }
    if (!archive.media) {
      archive.report({ kind: ARCHIVE_COMMON_FINDINGS.mediaNotImported, class: 'gap', fileIndex: 0, offset: at });
      return child(parent, entry, { locator: '', available: false });
    }
    const bound = archive.media.bind(base === '' ? entry.path : `${base}/${entry.path}`);
    if (!bound.ok) {
      archive.report({ kind: ARCHIVE_COMMON_FINDINGS.mediaNotImported, class: 'gap', fileIndex: 0, offset: at });
      return child(parent, entry, { locator: '', available: false });
    }
    return child(parent, entry, {
      locator: telegramExportMediaLocator(archive.archiveId, bound.bindingId),
      available: true,
      sizeBytes: bound.sizeBytes,
    });
  });
  return {
    inputId: archive.connectorId,
    kind: 'archive',
    records(listOptions = {}): AsyncIterable<SourceRecordPage<TelegramRecordItems>> {
      const pages = telegramExportPages<TelegramRecordItems>(archive, listOptions, {
        message(event) {
          const at = event.start;
          const outcome = telegramExportMessageRecord(context, telegramExportChat(event), event.value);
          if (outcome.kind === 'skipped') return { kind: 'skipped', reason: outcome.reason };
          if (outcome.kind === 'gap') {
            return { kind: 'gap', reason: outcome.reason === 'chat_unknown' ? TELEGRAM_FINDINGS.unreadable : outcome.reason };
          }
          const findings: Array<{ kind: string; count?: number; class?: 'gap' | 'skipped' }> = [];
          if (outcome.unsupported) findings.push({ kind: TELEGRAM_FINDINGS.unsupported });
          if (outcome.withoutText && !outcome.unsupported) findings.push({ kind: TELEGRAM_FINDINGS.withoutText, class: 'skipped' });
          const left = outcome.media.filter((entry) => entry.leftOut).length;
          if (left > 0) findings.push({ kind: ARCHIVE_COMMON_FINDINGS.mediaNotImported, count: left });
          return {
            kind: 'unit',
            unit: { record: outcome.record, children: children(outcome.record.capturedItem.item, outcome.media, at) },
            findings,
            assumedZone: outcome.assumedZone,
          };
        },
        account(section, ordinal, value) {
          const facts = telegramExportFacts(archive.root, file);
          const occurrence = facts.contactOccurrences.get(`${section.name}:${ordinal}`);
          const built = telegramAccountEntryRecord(context, section, ordinal, value, {
            ...(facts.contentTime ? { contentTime: facts.contentTime } : {}),
            ...(occurrence ? { occurrence } : {}),
          });
          return { unit: { record: built.record }, mediaFiles: built.mediaFiles };
        },
      });
      return (async function* (): AsyncGenerator<SourceRecordPage<TelegramRecordItems>> {
        for await (const page of pages) {
          // Where each record is, so the import counts each once however a replay cuts the pages.
          archive.reportItemPositions?.(page.positions.map((offset) => ({ fileIndex: 0, offset })));
          yield { records: page.records, nextCursor: page.nextCursor, done: page.done };
        }
      })();
    },
  };
}
