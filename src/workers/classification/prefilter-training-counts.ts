import { PREFILTER_TRAINING_REJECTIONS, prefilterTrainingExample, type PrefilterTrainingRejection } from './embedding-prefilter.ts';
import type { TierLedger } from './tier-ledger.ts';
import type { TierSnifferSubject } from './tier-classifier.ts';

export interface PrefilterTrainingCounts {
  rows_read: number;
  examples: { personal: number; private: number };
  provenance: { judge_receipt: number; legacy_sniffer: number };
  rejections: Record<PrefilterTrainingRejection, number>;
}

/** Count every eligible row (no training sample caps or fitting, no retained examples). */
export function countPrefilterTraining(options: Parameters<typeof prefilterTrainingExample>[2] & {
  ledger: Pick<TierLedger, 'getOverride' | 'rejudgeQuestion' | 'listItemWindow'>;
  judge: string;
  rowLimit?: number;
}): PrefilterTrainingCounts {
  const counts: PrefilterTrainingCounts = {
    rows_read: 0, examples: { personal: 0, private: 0 },
    provenance: { judge_receipt: 0, legacy_sniffer: 0 },
    rejections: Object.fromEntries(PREFILTER_TRAINING_REJECTIONS.map(reason => [reason, 0])) as Record<PrefilterTrainingRejection, number>,
  };
  let after: TierSnifferSubject | undefined;
  const limit = options.rowLimit ?? Infinity;
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('Invalid row limit');
  while (counts.rows_read < limit) {
    const rows = options.ledger.listItemWindow({ ...(after ? { after } : {}), limit: Math.min(32, limit - counts.rows_read) });
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
        counts.examples[example.private ? 'private' : 'personal']++;
        counts.provenance[example.provenance]++;
      }
    }
  }
  return counts;
}
