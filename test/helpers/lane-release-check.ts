import type { ReleaseCheck } from '../../src/core/release-manifest.ts';
import type { TierLedger } from '../../src/workers/classification/tier-ledger.ts';
import { createReleaseTierCheck } from '../../src/workers/connector-store/tier-visibility.ts';

/**
 * The release check a remote search runs, over one lane's ledger and stores.
 * Short items its judge read whole are proved without a call; nothing judges
 * on demand here, so a long item's unread windows stay held.
 */
export function laneReleaseCheck(ledger: TierLedger, stores: () => readonly { corpusId: string }[]): ReleaseCheck {
  return createReleaseTierCheck(() => [{ ledger, corpusIds: new Set(stores().map((store) => store.corpusId)) }], () => 'allow');
}
