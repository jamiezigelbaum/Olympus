/**
 * Removing one imported archive: everything derived from it, and nothing
 * else. Its items share their family's stores with every other archive of
 * that family, so removal goes row by row, keyed by the archive's id (the
 * account scope of every one of its items). The file or folder the person
 * chose is never touched.
 *
 * The order is what keeps it safe at every point, including a restart in the
 * middle (the record stays `removing`, and the next run starts over; every
 * step is idempotent):
 *
 * 1. The record is marked `removing`: no pass imports it any more (a pass
 *    already running sees it and stops at the next message). The removal
 *    runs as the archive's own scheduler task, so never beside its import.
 * 2. In the set ledger, every copy of its items is superseded, so no store
 *    serves them from that moment, and every decision, override, history and
 *    proposal row is deleted, so no move, re-judge or migration acts on them.
 *    Its questions to the private model go too.
 * 3. Answers waiting in the private inbox that read its items are deleted.
 *    Questions still waiting, and answers that read anything else, stay.
 * 4. Each store's rows, in bounded steps.
 * 5. The superseded copies (the mark that hid the rows), the resume point,
 *    the secret-locations entries, and the inbox once more.
 * 6. The record.
 */
import { existsSync } from 'node:fs';
import type { WaitingQuestionStore } from '../../core/waiting-private-questions.ts';
import { openTierSniffer } from '../../core/source-storage.ts';
import { tierSnifferPathForLedger } from '../classification/tier-ledger-path.ts';
import { archiveLaneLegs, archiveLaneStores, type ArchiveTierLane } from './lane.ts';
import { ARCHIVE_IMPORTS_SOURCE_ID, archiveConnectorId, type ArchiveImportRecord, type ArchiveImportStateStore } from './state.ts';
import { archiveTierSetId } from './store.ts';

/**
 * Items one removal step deletes from one store, in one transaction.
 */
export const ARCHIVE_REMOVAL_STEP_ITEMS = 2_000;
/**
 * Steps one removal run takes before it yields to the scheduler.
 */
export const ARCHIVE_REMOVAL_STEPS_PER_RUN = 50;

export type ArchiveRemovalOutcome =
  | { kind: 'removed'; counts: ArchiveRemovalCounts }
  | { kind: 'progress'; counts: ArchiveRemovalCounts }
  | { kind: 'not_removing'; status?: ArchiveImportRecord['status'] };

export interface ArchiveRemovalCounts {
  decisions_removed: number;
  copies_hidden: number;
  items_removed: number;
  chunks_removed: number;
  questions_removed: number;
  answers_removed: number;
  secret_locations_removed: number;
}

export interface ArchiveRemovalOptions {
  state: ArchiveImportStateStore;
  lane: ArchiveTierLane;
  archiveId: string;
  /**
   * Opens the private inbox for this removal; undefined when there is none.
   */
  openWaitingQuestions?: () => WaitingQuestionStore | undefined;
  stepItems?: number;
  stepsPerRun?: number;
  now?: () => Date;
}

/**
 * Marks the archive for removal. From this call on no pass imports it, and a
 * removal interrupted by a restart resumes from this status.
 */
export function requestArchiveRemoval(
  state: ArchiveImportStateStore,
  archiveId: string,
  now: () => Date = () => new Date(),
): ArchiveImportRecord | undefined {
  return state.update(archiveId, (record) => {
    if (record.status === 'removing') return;
    record.status = 'removing';
    record.removal_started_at = now().toISOString();
  });
}

function emptyCounts(): ArchiveRemovalCounts {
  return {
    decisions_removed: 0,
    copies_hidden: 0,
    items_removed: 0,
    chunks_removed: 0,
    questions_removed: 0,
    answers_removed: 0,
    secret_locations_removed: 0,
  };
}

function deleteWaitingAnswers(
  options: ArchiveRemovalOptions,
  input: { provider: string; accountScope: string; corpusIds: readonly string[] },
): number {
  const inbox = options.openWaitingQuestions?.();
  if (!inbox) return 0;
  try {
    return inbox.deleteForAccountScope(input);
  } finally {
    inbox.close();
  }
}

function deleteJudgeQuestions(lane: ArchiveTierLane, provider: string, accountScope: string): number {
  const path = tierSnifferPathForLedger(lane.ledger.dbPath);
  if (path !== ':memory:' && !existsSync(path)) return 0;
  const sniffer = openTierSniffer({ sourceId: ARCHIVE_IMPORTS_SOURCE_ID }, { dbPath: path });
  try {
    return sniffer.deleteAccountScopeQuestions(provider, accountScope);
  } finally {
    sniffer.close();
  }
}

export async function runArchiveRemoval(options: ArchiveRemovalOptions): Promise<ArchiveRemovalOutcome> {
  const record = options.state.get(options.archiveId);
  if (!record || record.status !== 'removing') {
    return record ? { kind: 'not_removing', status: record.status } : { kind: 'not_removing' };
  }
  if (record.family !== options.lane.family) throw new Error('This archive belongs to another family\'s stores.');

  const provider = record.provider;
  const accountScope = record.archive_id;
  const lane = options.lane;
  const corpusIds = archiveLaneLegs(lane).map((leg) => leg.corpusId);
  const counts = emptyCounts();

  // 2: hidden everywhere, and out of every later pass's reach.
  const withdrawn = lane.ledger.withdrawAccountScope(provider, accountScope);
  counts.decisions_removed += withdrawn.items;
  counts.copies_hidden += withdrawn.copies;
  counts.questions_removed += deleteJudgeQuestions(lane, provider, accountScope);
  // 3: answers that read these items.
  counts.answers_removed += deleteWaitingAnswers(options, { provider, accountScope, corpusIds });

  // 4: each store's rows, bounded.
  const connectorId = archiveConnectorId(record.archive_id);
  const stepItems = Math.max(1, options.stepItems ?? ARCHIVE_REMOVAL_STEP_ITEMS);
  let steps = Math.max(1, options.stepsPerRun ?? ARCHIVE_REMOVAL_STEPS_PER_RUN);
  for (const store of archiveLaneStores(lane)) {
    for (;;) {
      if (steps <= 0) return { kind: 'progress', counts };
      steps -= 1;
      const step = store.purgeAccountScope({ provider, accountScope, connectorId, limit: stepItems });
      counts.items_removed += step.itemsRemoved;
      counts.chunks_removed += step.chunksRemoved;
      if (step.remaining === 0) break;
    }
  }

  // 5: the marks, the resume point and the side stores.
  lane.ledger.deleteAccountScopeCopies(provider, accountScope);
  lane.ledger.deleteSetCursor(archiveTierSetId(lane.family), connectorId);
  counts.secret_locations_removed += lane.secretLocations?.removeAccountScope(provider, accountScope) ?? 0;
  counts.answers_removed += deleteWaitingAnswers(options, { provider, accountScope, corpusIds });

  // 6: nothing derived from the archive is left.
  options.state.delete(record.archive_id);
  return { kind: 'removed', counts };
}
