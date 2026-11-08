import { prefilterTrainingWindow, PREFILTER_TRAINING_REJECTIONS, prefilterTrainingExample, type PrefilterTrainingRejection } from './embedding-prefilter.ts';
import type { TierLedger } from './tier-ledger.ts';
import type { TierSnifferSubject } from './tier-classifier.ts';

export interface PrefilterTrainingCounts {
  rows_read: number;
  examples: { personal: number; private: number };
  per_source: Record<string, { personal: number; private: number }>;
  provenance: { judge_receipt: number; legacy_sniffer: number };
  rejections: Record<PrefilterTrainingRejection, number>;
}

/** Count every eligible row (no training sample caps or fitting, no retained examples). */
export function* countPrefilterTrainingSteps(options: Parameters<typeof prefilterTrainingExample>[2] & {
  ledger: Pick<TierLedger, 'getOverride' | 'rejudgeQuestion' | 'listItemWindow'>;
  judge: string;
  rowLimit?: number;
  onExample?: (example: NonNullable<ReturnType<typeof prefilterTrainingExample>>) => void;
}): Generator<void, PrefilterTrainingCounts> {
  const counts: PrefilterTrainingCounts = {
    rows_read: 0, examples: { personal: 0, private: 0 }, per_source: {},
    provenance: { judge_receipt: 0, legacy_sniffer: 0 },
    rejections: Object.fromEntries(PREFILTER_TRAINING_REJECTIONS.map(reason => [reason, 0])) as Record<PrefilterTrainingRejection, number>,
  };
  let after: TierSnifferSubject | undefined;
  const limit = options.rowLimit ?? Infinity;
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('Invalid row limit');
  while (counts.rows_read < limit) {
    const rows = prefilterTrainingWindow(options.ledger, after, Math.min(32, limit - counts.rows_read));
    if (!rows.length) break;
    for (const row of rows) {
      counts.rows_read++;
      after = { provider: row.provider, accountScope: row.accountScope, providerItemId: row.providerItemId,
        ...(row.conversationKey ? { providerConversationId: row.conversationKey } : {}) };
      const example = prefilterTrainingExample(row, options.judge, options, reason => {
        counts.rejections[reason]++;
        return undefined;
      });
      if (example) {
        const label = example.private ? 'private' : 'personal';
        counts.examples[label]++;
        // Fixed public source names only; never echo an arbitrary provider id.
        const source = ['telegram', 'telegram_export', 'whatsapp', 'whatsapp_export', 'gmail', 'google_drive', 'reflect', 'local_files', 'evernote', 'readwise', 'dropbox', 'x'].includes(row.provider) ? row.provider : 'other';
        (counts.per_source[source] ??= { personal: 0, private: 0 })[label]++;
        options.onExample?.(example);
        counts.provenance[example.provenance]++;
      }
    }
    yield;
  }
  return counts;
}

export function countPrefilterTraining(options: Parameters<typeof countPrefilterTrainingSteps>[0]): PrefilterTrainingCounts {
  const scan = countPrefilterTrainingSteps(options);
  let step = scan.next();
  while (!step.done) step = scan.next();
  return step.value;
}
