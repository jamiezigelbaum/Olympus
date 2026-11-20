// A one-time walk of Personal bodies that may predate routed writes. A page
// can contain only already-cleared items. Checkpoint its position even then.
import type { TierSnifferStore } from '../classification/sniffer-store.ts';
import { secretScanReusable } from '../classification/engine.ts';
import { scanSecretsAhead } from '../classification/secret-scan-off-thread.ts';
import { find, runPassOffThread, turn, type LoopPass } from './loop-pass.ts';
import { PERSONAL_BODY_CHUNKS_PER_PAGE, type PersonalBodyCursor } from './local-index.ts';
import { placePersonalBody } from './place-personal-body.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

// Earlier passes could retire after skipping retained metadata-layer bodies.
const CURSOR = 'legacy_personal_bodies_cursor_v2';
const DONE = 'legacy_personal_bodies_done_v2';
// Match the default raise-drain page. Each candidate carries its complete text.
export const LEGACY_PERSONAL_BODY_PAGE_SIZE = 25;

interface WalkOptions {
  set: TieredStoreSet;
  queue: TierSnifferStore;
  limit?: number;
  chunkLimit?: number;
  movesAvailable?: boolean;
  turn?: () => Promise<void> | undefined;
}

interface WalkReport {
  checked: number;
  held: number;
  secrets: number;
  failed: number;
  retired: boolean;
}

export function settleLegacyPersonalBodiesOffThread(options: WalkOptions): Promise<WalkReport> {
  return runPassOffThread(walk(options), { family: 'legacy-personal-bodies', ...(options.turn ? { turn: options.turn } : {}) });
}

function* walk({ set, queue, limit = LEGACY_PERSONAL_BODY_PAGE_SIZE, chunkLimit = PERSONAL_BODY_CHUNKS_PER_PAGE, movesAvailable = true }: WalkOptions): LoopPass<WalkReport> {
  const { ledger } = set;
  const report = { checked: 0, held: 0, secrets: 0, failed: 0, retired: false };
  if (ledger.readMeta(DONE) === '1') return { ...report, retired: true };
  const personal = set.store('internal');
  const saved = ledger.readMeta(CURSOR);
  const checkpoint = saved ? JSON.parse(saved) as { after?: PersonalBodyCursor; dirty: boolean } : undefined;
  let dirty = checkpoint?.dirty ?? false;
  if (personal) {
    const binding = personal.tierSetBinding();
    if (binding && binding.ledgerId !== ledger.ledgerId()) return { ...report, failed: 1 };
    const marker = personal.changeMarker();
    const page = yield* find(personal.personalBodyPageFinder(checkpoint?.after, Math.min(limit, LEGACY_PERSONAL_BODY_PAGE_SIZE), chunkLimit));
    if (!page) return report; // The ordered index is still being built.
    const previousLedger = page.items.length ? personal.preRoutingLedgerFor(ledger) : undefined;
    const placement = { movesAvailable, ...(previousLedger ? { previousLedger } : {}) };
    for (const item of page.items) {
      yield* turn();
      report.checked++;
      if (secretScanReusable(item.text)) {
        yield* find({ here: () => undefined, offThread: () => scanSecretsAhead(item.text) });
      }
      // The page was read on another connection, before the last turn.
      // Never screen, tombstone or authorize a different version of a body.
      const current = item.watch ? personal.personalBodyWatchCurrent(item.watch) : personal.changeMarker() === marker
        || personal.itemMigrationFingerprint(item.identity, item.chunkCount + 1) === item.fingerprint;
      if (!current) {
        dirty = true;
        continue;
      }
      try {
        if (item.chunkCount === 0) {
          personal.clearOrphanPersonalVectors(item.identity);
          continue;
        }
        const disposition = placePersonalBody(set, personal, item, queue, 'walk', placement);
        if (disposition === 'held') report.held++;
        if (disposition === 'secrets') report.secrets++;
        if (disposition === 'retry') report.failed++;
      } catch {
        // A failed item keeps this lap dirty. The rest of its page can proceed.
        report.failed++;
      }
    }
    dirty ||= report.held + report.secrets + report.failed > 0;
    if (page.next || page.partial) {
      ledger.writeSettleProgress(CURSOR, JSON.stringify({ after: page.next, dirty }));
      return report;
    }
  }
  ledger.writeSettleProgress(CURSOR, '');
  if (!dirty) {
    personal?.finishPersonalBodyWalk();
    ledger.writeSettleProgress(DONE, '1');
    report.retired = true;
  }
  return report;
}
