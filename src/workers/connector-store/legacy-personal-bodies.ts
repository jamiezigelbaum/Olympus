// A one-time walk of Personal bodies that may predate routed writes. A page
// can contain only already-cleared items. Checkpoint its position even then.
import { LEGACY_PERSONAL_BODIES_CURSOR, LEGACY_PERSONAL_BODIES_WAITING, type TierLedgerIdentity, type TierLedger } from '../classification/tier-ledger.ts';
import type { TierSnifferStore } from '../classification/sniffer-store.ts';
import { secretScanReusable } from '../classification/engine.ts';
import { scanSecretsAhead } from '../classification/secret-scan-off-thread.ts';
import { find, findInLedger, runPassOffThread, turn, type LoopPass } from './loop-pass.ts';
import { PERSONAL_BODY_CHUNKS_PER_PAGE, type LocalConnectorStore, type PersonalBodyCandidate, type PersonalBodyCursor } from './local-index.ts';
import { placePersonalBody } from './place-personal-body.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

// The first version could advance past changed bytes while cloud embeddings were configured.
const RECORDED_PROGRESS = 'legacy_personal_recorded_decisions_v2';
// Earlier passes could retire after skipping retained metadata-layer bodies.
const DONE = 'legacy_personal_bodies_done_v2';
// Match the default raise-drain page. Each candidate carries its complete text.
export const LEGACY_PERSONAL_BODY_PAGE_SIZE = 25;

interface WalkOptions {
  set: TieredStoreSet;
  queue: TierSnifferStore;
  limit?: number;
  chunkLimit?: number;
  movesAvailable?: () => boolean;
  turn?: () => Promise<void> | undefined;
}

interface WalkReport {
  checked: number;
  settled: number;
  held: number;
  secrets: number;
  failed: number;
  retired: boolean;
  waitingForMoves: boolean;
}

export function settleLegacyPersonalBodiesOffThread(options: WalkOptions): Promise<WalkReport> {
  return runPassOffThread(walk(options), { family: 'legacy-personal-bodies', ...(options.turn ? { turn: options.turn } : {}) });
}

export function settleRecordedPersonalBodiesOffThread(options: WalkOptions): Promise<WalkReport> {
  return runPassOffThread(walk(options, true), { family: 'legacy-recorded-decisions', ...(options.turn ? { turn: options.turn } : {}) });
}

function* walk({ set, queue, limit = LEGACY_PERSONAL_BODY_PAGE_SIZE, chunkLimit = PERSONAL_BODY_CHUNKS_PER_PAGE, movesAvailable = () => true }: WalkOptions, recordedOnly = false): LoopPass<WalkReport> {
  const { ledger } = set;
  const report = { checked: 0, settled: 0, held: 0, secrets: 0, failed: 0, retired: false, waitingForMoves: false };
  const personal = set.store('internal');
  const progress = ledger.readMeta(RECORDED_PROGRESS);
  if (personal && progress !== 'done') {
    if (set.foreignBoundLeg()) return { ...report, failed: 1 };
    const handled = yield* walkRecorded({ set, queue, limit, chunkLimit, movesAvailable }, personal, progress, report);
    if (handled) return report;
  }
  if (recordedOnly) return { ...report, retired: true };
  if (ledger.readMeta(DONE) === '1') return { ...report, retired: true };
  const saved = ledger.readMeta(LEGACY_PERSONAL_BODIES_CURSOR);
  const canMove = movesAvailable();
  const last = saved ? JSON.parse(saved) as { after?: PersonalBodyCursor; dirty: boolean; waiting?: number; canMove?: boolean } : undefined;
  const checkpoint = (last?.canMove ?? true) === canMove ? last : undefined;
  let waiting = checkpoint?.waiting ?? 0;
  let dirty = checkpoint?.dirty ?? false;
  if (personal) {
    if (set.foreignBoundLeg()) return { ...report, failed: 1 };
    const marker = personal.changeMarker();
    const page = yield* find(personal.personalBodyPageFinder(checkpoint?.after, Math.min(limit, LEGACY_PERSONAL_BODY_PAGE_SIZE), chunkLimit));
    if (!page) return report; // The ordered index is still being built.
    const previousLedger = page.items.length ? personal.preRoutingLedgerFor(ledger) : undefined;
    const placement = { movesAvailable: canMove, ...(previousLedger ? { previousLedger } : {}) };
    for (const item of page.items) {
      const outcome = yield* processBody(set, personal, item, queue, placement, marker, movesAvailable, report);
      if (outcome === 'interrupted') return report;
      if (outcome === 'changed') dirty = true;
      if (outcome === 'waiting') waiting++;
    }
    dirty ||= report.held + report.secrets + report.failed > 0;
    if (page.next || page.partial) {
      ledger.writeSettleProgress(LEGACY_PERSONAL_BODIES_CURSOR, JSON.stringify({ after: page.next, dirty, canMove, waiting }));
      return report;
    }
  }
  // Publish the completed lap. Retrying a page or restarting halfway cannot double-count it.
  ledger.writeSettleProgress(LEGACY_PERSONAL_BODIES_WAITING, String(waiting));
  ledger.writeSettleProgress(LEGACY_PERSONAL_BODIES_CURSOR, '');
  if (!dirty) {
    personal?.finishPersonalBodyWalk();
    if (waiting) report.waitingForMoves = true;
    else {
      ledger.writeSettleProgress(DONE, '1');
      report.retired = true;
    }
  }
  return report;
}

interface RecordedCursor {
  previous?: boolean;
  after?: TierLedgerIdentity;
  retry?: boolean;
}

// Read only protected identities, first from the set and then from its pre-routing
// ledger. The cursor also steps past missing bodies and sidecar rows already routed.
function* walkRecorded(options: Required<Omit<WalkOptions, 'turn'>>, personal: LocalConnectorStore,
  saved: string | undefined, report: WalkReport): LoopPass<boolean> {
  const { set, queue, movesAvailable } = options;
  const { ledger } = set;
  const previousLedger = personal.preRoutingLedgerFor(ledger);
  const cursor: RecordedCursor = saved ? JSON.parse(saved) : {};
  const limit = Math.max(1, Math.min(options.limit, LEGACY_PERSONAL_BODY_PAGE_SIZE));
  const canMove = movesAvailable();
  let remaining = Math.max(1, Math.min(options.chunkLimit, PERSONAL_BODY_CHUNKS_PER_PAGE));
  let checked = 0;
  for (const source of cursor.previous ? [previousLedger] : [ledger, previousLedger]) {
    if (!source) continue;
    const pageSize = limit - checked;
    const rows = yield* findInLedger(source, () => source.legacyProtectedRowsSteps(cursor.after, pageSize));
    for (const identity of rows) {
      checked++;
      const marker = personal.changeMarker();
      const page = yield* find(personal.personalBodyForIdentityFinder(identity, remaining));
      if (page.partial) {
        ledger.writeSettleProgress(RECORDED_PROGRESS, JSON.stringify(cursor));
        return true;
      }
      const item = page.items[0];
      if (!item?.chunkCount) yield* turn();
      if (item?.chunkCount) {
        const outcome = yield* processBody(set, personal, item, queue, {
          ...(previousLedger ? { previousLedger } : {}), movesAvailable: canMove, recordedOnly: true,
        }, marker, movesAvailable, report);
        if (outcome === 'interrupted') return true;
        if (outcome === 'changed' || outcome === 'retry' || outcome === 'waiting') cursor.retry = true;
        remaining -= item.chunkCount;
      }
      cursor.after = identity;
      if (remaining <= 0 || checked === limit) {
        ledger.writeSettleProgress(RECORDED_PROGRESS, JSON.stringify(cursor));
        return true;
      }
    }
    delete cursor.after;
    cursor.previous = true;
  }
  if (!cursor.retry && ledger.readMeta(DONE) === '1') personal.finishPersonalBodyWalk();
  ledger.writeSettleProgress(RECORDED_PROGRESS, cursor.retry ? '' : 'done');
  // With an empty index the usual walker can use this tick immediately.
  return checked > 0 || !!cursor.retry;
}

function* processBody(set: TieredStoreSet, personal: LocalConnectorStore, item: PersonalBodyCandidate,
  queue: TierSnifferStore, placement: { movesAvailable: boolean; previousLedger?: TierLedger; recordedOnly?: boolean },
  marker: string, movesAvailable: () => boolean, report: WalkReport): LoopPass<ReturnType<typeof placePersonalBody> | 'interrupted' | 'changed'> {
  const canMove = placement.movesAvailable;
  yield* turn();
  report.checked++;
  if ((canMove || placement.recordedOnly) && secretScanReusable(item.text)) {
    yield* find({ here: () => undefined, offThread: () => scanSecretsAhead(item.text) });
  }
  if (movesAvailable() !== canMove) return 'interrupted';
  // Never apply a decision to bytes changed since the read-worker snapshot.
  const current = item.watch ? personal.personalBodyWatchCurrent(item.watch) : personal.changeMarker() === marker
    || personal.itemMigrationFingerprint(item.identity, item.chunkCount + 1) === item.fingerprint;
  if (!current) return 'changed';
  try {
    if (item.chunkCount === 0) {
      if (!canMove) return 'waiting';
      personal.clearOrphanPersonalVectors(item.identity);
      return 'unchanged';
    }
    const disposition = placePersonalBody(set, personal, item, queue, 'walk', placement);
    if (disposition === 'held') report.held++;
    if (disposition === 'secrets') report.secrets++;
    if (disposition === 'settled') report.settled++;
    if (disposition === 'retry') report.failed++;
    return disposition;
  } catch {
    // Retry this lap after the rest of the candidates have had a turn.
    report.failed++;
    return 'retry';
  }
}
