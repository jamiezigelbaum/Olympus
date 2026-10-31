// The Telegram source as a target of imported archives
// (archive-import/source-targets.ts; docs/design/archive-live-one-dataset.md,
// sections 1 and 7): a Telegram Desktop JSON export of the paired account is
// one more input of the Telegram connector, read into the account's own
// stores beside live capture, with nothing stored twice.

import { createHash } from 'node:crypto';
import type { ArchiveConnectorInput } from '../../core/archive-formats.ts';
import type { SourceConnector, SourceConnectorInput } from '../../core/contracts.ts';
import { TELEGRAM_SOURCE_ID } from '../../core/olympus-layout.ts';
import type { ScopeFileVersion, ScopeRoot } from '../../core/scope-safe-fs.ts';
import type { SourceRecordBuilder } from '../../core/source-inputs.ts';
import { fileByteSource } from '../archive-import/byte-source.ts';
import { JsonStreamReader } from '../archive-import/json-stream.ts';
import { withInputs } from '../archive-import/source-input.ts';
import type { ArchiveAccountEvidence, ArchiveSourceLane, ArchiveSourceTarget } from '../archive-import/source-targets.ts';
import { telegramJsonSource } from '../archive-import/telegram/json-repair.ts';
import { telegramScalar } from '../archive-import/telegram/message.ts';
import type { ConnectorStoreSyncOptions } from '../connector-store/index.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import { INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID } from './corpus-adapter.ts';
import { telegramExportInput } from './export-input.ts';
import type { TelegramRecordItems } from './record-builder.ts';

/** How far into an export its profile is looked for: Telegram Desktop writes it before the chats. */
const PROFILE_SCAN_BYTES = 16 * 1024 * 1024;

/**
 * The exporting account's user id, from the export's `personal_information`,
 * or undefined when the export has none (a single chat, or an account export
 * made without the profile, as the owner's own was). Reads at most the first
 * 16 MB; an export that cannot be read there says nothing of its account.
 */
export function telegramExportUserId(root: ScopeRoot, relPath: string, expected?: ScopeFileVersion): string | undefined {
  const reader = root.openFile(relPath, expected ? { expected } : {});
  try {
    const json = new JsonStreamReader(telegramJsonSource(fileByteSource(reader, { end: PROFILE_SCAN_BYTES })), {
      itemPaths: [['personal_information']],
      maxItemBytes: 1024 * 1024,
    });
    for (;;) {
      let event;
      try {
        event = json.next();
      } catch {
        return undefined;
      }
      if (!event) return undefined;
      if (event.kind === 'item' && event.path[event.path.length - 1] === 'user_id') {
        const id = telegramScalar(event.value);
        return id && /^\d{1,20}$/.test(id) ? id : undefined;
      }
    }
  } finally {
    reader.close();
  }
}

/** The account a pairing proves, hashed as pairing hashes it (`scripts/telegram-pair.py`, `account_ref`). */
export function telegramProviderAccountId(userId: string): string {
  return `telegram:${createHash('sha256').update(userId).digest('hex').slice(0, 16)}`;
}

interface TelegramArchiveTargetMetadata {
  /** The live account scope (`telegram.personal`). */
  account: string;
  /** The day the live capture began, when it is known. Reading this never mounts a lane. */
  liveSince?(): string | undefined;
}

export type TelegramArchiveTargetOptions = TelegramArchiveTargetMetadata & ({
  /** Resolve the canonical lane only when an approved import uses it. */
  lane(): ArchiveSourceLane;
} | {
  /** The live lane's one tier store set over the account's stores. */
  set: TieredStoreSet;
  /** The live connector the export becomes an input of. */
  connector: SourceConnector;
  builder: SourceRecordBuilder<TelegramRecordItems>;
  /** The live lane's sync options, so both inputs place items alike. */
  sync: ConnectorStoreSyncOptions;
});

export function telegramArchiveTarget(options: TelegramArchiveTargetOptions): ArchiveSourceTarget {
  let connector: SourceConnector | undefined;
  return {
    sourceId: TELEGRAM_SOURCE_ID,
    label: 'Telegram',
    formats: ['telegram_json'],
    // The scheduler key Telegram's own pull runs under (its corpus): an import never writes beside it.
    concurrencyKey: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    identify(archive): ArchiveAccountEvidence {
      const file = archive.files[0];
      if (!file || archive.files.length !== 1) return { kind: 'archives' };
      const userId = telegramExportUserId(archive.root, file.rel_path);
      return userId ? { kind: 'account', importAccountId: telegramProviderAccountId(userId) } : { kind: 'none' };
    },
    input(archive: ArchiveConnectorInput): SourceConnectorInput {
      const file = archive.files[0];
      let ownUserId: string | undefined;
      try {
        ownUserId = file ? telegramExportUserId(archive.root, file.relPath, file.version) : undefined;
      } catch {
        // A file that changed is stopped by the listing itself, with its reason.
      }
      return telegramExportInput(archive, { account: options.account, ...(ownUserId ? { ownUserId } : {}) });
    },
    lane: () => {
      if ('lane' in options) return options.lane();
      connector ??= withInputs(options.connector, options.builder);
      return { set: options.set, sync: options.sync, connector };
    },
    ...(options.liveSince ? { liveSince: () => options.liveSince!() } : {}),
    // No `exclusive`: Telegram has no account guard that could bind other stores over its account.
  };
}
