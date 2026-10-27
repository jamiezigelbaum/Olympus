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
// The capture order of a live record: when the helper captured it, its
// capture sequence, then its place in the spool, each written to sort.
const CAPTURE_MARK = '~at:';

/**
 * A live capture's version: the helper's version and the capture's order,
 * by the time the helper captured it, then the helper's capture sequence
 * (which only grows, kept beside the spool), then its place in the spool as
 * the last tie-break. Two captures of one message at the same edit time (a
 * reaction changed) are then ordered, also across a day file that was
 * removed and written again, and a capture read again after its cursor was
 * reset is never newer than the one the store took after it. A record written
 * before the helper kept a sequence orders as sequence 0.
 */
export function telegramCaptureVersion(version: string, order: { capturedAt: string; seq: number; file: string; line: number }): string {
  return `${version}${CAPTURE_MARK}${order.capturedAt}:${String(order.seq).padStart(16, '0')}:${order.file}:${String(order.line).padStart(10, '0')}`;
}

/**
 * The source's own order of two versions of one message: by the edit (else
 * sent) time a version carries, then, at the same time, by each capture's
 * order (`telegramCaptureVersion`). A version with no capture mark (an export's, a row
 * stored before captures were marked) is older than a marked one at the same
 * time, so a tie between an export and live keeps live's copy. A version with
 * no time (an entry of the account export, an old record) orders as a tie.
 */
export function compareTelegramVersions(a: string, b: string): number {
  if (a === b) return 0;
  const [leftVersion = '', leftMark] = a.split(CAPTURE_MARK);
  const [rightVersion = '', rightMark] = b.split(CAPTURE_MARK);
  const left = VERSION_TIME.exec(leftVersion);
  const right = VERSION_TIME.exec(rightVersion);
  if (!left || !right) return 0;
  const difference = Date.parse(left[1]!) - Date.parse(right[1]!);
  if (!Number.isFinite(difference)) return 0;
  if (difference !== 0) return Math.sign(difference);
  if (leftMark === rightMark) return 0;
  if (leftMark === undefined) return -1;
  if (rightMark === undefined) return 1;
  return leftMark < rightMark ? -1 : 1;
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
    // Every name the item adds to its search context beside the chat and the sender is judged with them.
    labels: telegramContextNames(item),
  });
}

/**
 * The names in an item's search context that are neither its chat nor its
 * sender: who a forward came from, and the names of its attachments. They
 * reach search and embedding input, so they are judged as the item's names.
 */
export function telegramContextNames(item: RawItem): string[] {
  const names: string[] = [];
  const forwardedFrom = signalText(item.metadata, 'forwardedFrom');
  if (forwardedFrom) names.push(`Forwarded from ${forwardedFrom}`);
  const attachmentNames = item.metadata['attachmentNames'];
  if (Array.isArray(attachmentNames)) {
    for (const name of attachmentNames) {
      if (typeof name === 'string' && name.trim() && !names.includes(name.trim())) names.push(name.trim());
    }
  }
  return names;
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
