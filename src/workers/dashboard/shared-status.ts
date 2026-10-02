/**
 * One status derivation for both dashboards (holistic review 2026-10-02, item
 * 9): the status word held to the progress bar. The ChatGPT view model
 * (chatgpt/dashboard-view-model.ts) and the local pages (source-rows.ts) both
 * call it, so the same engine state never reads Fresh on one surface and
 * Working on the other.
 *
 * Pure: a status word and a source's progress in, a status word out.
 */
import type { SourceProgress, SourceStalledReason } from '../chatgpt/dashboard-contract.ts';
import type { DashboardStatus } from './vocabulary.ts';

/** Stalled reasons the owner fixes from the dashboard; the source then reads Needs you. */
export const DASHBOARD_FIXABLE_STALLS: ReadonlySet<SourceStalledReason> = new Set<SourceStalledReason>([
  'waiting_for_credentials',
  'scope_pending',
]);

/**
 * The status word, held to the progress bar: never Fresh while a stage is
 * unfinished. A stall the owner fixes here reads Needs you; any other
 * unfinished stage reads Working unless the vocabulary already said something
 * more urgent (Needs you, Failing).
 */
export function dashboardHonestStatus(status: DashboardStatus, progress: SourceProgress | undefined): DashboardStatus {
  if (!progress || progress.stage === 'done') return status;
  if (progress.stalled && progress.stalledReason && DASHBOARD_FIXABLE_STALLS.has(progress.stalledReason)) return 'Needs you';
  if (status === 'Needs you' || status === 'Failing') return status;
  return 'Working';
}
