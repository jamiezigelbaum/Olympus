// The Telegram connector's one record builder (core/source-inputs.ts): every
// input of the connector (the live capture spool, each imported export)
// yields records in the spool's shape, and this turns each into its items the
// same way. The live lanes and an export input differ only in where their
// records come from.

import { compactClassificationSignals, signalText, trustDomainPrior } from '../../core/classification-signals.ts';
import type { RawItem, SourceClassificationSignals, SourceConnectorFetchOptions } from '../../core/contracts.ts';
import type { SourceRecordBuilder } from '../../core/source-inputs.ts';
import {
  TELEGRAM_SECRET_REDACTED_FLOOR_BASIS,
  telegramConversationKind,
  type TelegramCaptureSpoolRecord,
} from './capture-spool-connector.ts';
import type { TelegramMessagesCorpusTrustDomain } from './corpus-adapter.ts';

// The time a Telegram version ends with: the edit time, else the sent time,
// then (optionally) a digest of the reactions it saw.
const VERSION_TIME = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?::r[0-9a-f]{1,64})?$/;

/**
 * The source's own order of two versions of one message: by the edit (else
 * sent) time a version carries. Versions of the same time are the same
 * version, whatever reactions each saw: no input can tell which reaction count
 * is the newer, so on a tie live's word is kept (core/source-inputs.ts). A
 * version with no time (an entry of the account export, an old record) orders
 * as a tie too.
 */
export function compareTelegramVersions(a: string, b: string): number {
  if (a === b) return 0;
  const left = VERSION_TIME.exec(a);
  const right = VERSION_TIME.exec(b);
  if (!left || !right) return 0;
  const difference = Date.parse(left[1]!) - Date.parse(right[1]!);
  return Number.isFinite(difference) ? Math.sign(difference) : 0;
}

/**
 * The classification signals of a Telegram item, whichever input built it:
 * the chat's trust domain as a prior messages rest at, a Secret Chat floored
 * Private, a record whose text was cleared as a Secret floored Secrets, and
 * the chat id as the folder key owner chat rules match.
 */
export function telegramClassificationSignals(
  item: RawItem,
  fallbackTrust: TelegramMessagesCorpusTrustDomain = 'internal',
): SourceClassificationSignals {
  const trust = item.metadata['trustDomain'] === 'secure_local' ? 'secure_local' : item.metadata['trustDomain'] === 'internal' ? 'internal' : fallbackTrust;
  const conversationKind = telegramConversationKind(signalText(item.metadata, 'chatType'));
  const redacted = item.metadata['secretRedacted'] === true;
  return compactClassificationSignals({
    prior: trustDomainPrior(trust, 'source_config'),
    ...(redacted
      ? { floor: { tier: 'secrets' as const, basis: TELEGRAM_SECRET_REDACTED_FLOOR_BASIS } }
      : conversationKind === 'secret_chat'
        ? { floor: { tier: 'secure' as const, basis: 'provider:secret_chat' } }
        : {}),
    conversationKind,
    title: signalText(item.metadata, 'title'),
    sender: signalText(item.metadata, 'senderDisplayName', 'senderId'),
    folderKeys: item.identity.providerConversationId ? [item.identity.providerConversationId] : [],
  });
}

/** A record and the items it yields: the message, then its children. */
export interface TelegramRecordItems {
  record: TelegramCaptureSpoolRecord;
  /** Children (media files) after the message, in the record's order. */
  children?: readonly RawItem[];
}

export function telegramRecordBuilder(options: {
  trustDomain?: TelegramMessagesCorpusTrustDomain;
  fetchItem(localItemId: string, options?: SourceConnectorFetchOptions): Promise<RawItem>;
  authenticate?(): Promise<void>;
}): SourceRecordBuilder<TelegramRecordItems> {
  const itemsOf = (entry: TelegramRecordItems): RawItem[] => [entry.record.capturedItem.item, ...(entry.children ?? [])];
  return {
    family: 'chat',
    entriesOf: (entry) => itemsOf(entry).map((item, index) => {
      const authoredAt = index === 0 ? item.metadata['sentAt'] : undefined;
      return {
        identity: item.identity,
        bringsContent: item.content.kind !== 'metadata_only',
        ...(typeof authoredAt === 'string' ? { authoredAt } : {}),
      };
    }),
    compareVersions: compareTelegramVersions,
    build: (entry, wanted) => itemsOf(entry).filter((item) => wanted.has(item.identity.localItemId)),
    fetchItem: options.fetchItem,
    classificationSignals: (item) => telegramClassificationSignals(item, options.trustDomain),
    ...(options.authenticate ? { authenticate: options.authenticate } : {}),
  };
}
