/**
 * One status derivation for both dashboards (holistic review 2026-10-02, item
 * 9): the status word held to the progress bar. The panel's view model
 * (chatgpt/dashboard-view-model.ts) calls it for every host, so the same
 * engine state never reads Fresh on one surface and Working on another.
 *
 * Pure: a status word and a source's progress in, a status word out.
 */
import type { SourceProgress, SourceStalledReason } from '../chatgpt/dashboard-contract.ts';
import type { WorkerCredentialDegradation } from '../credential-degradation.ts';
import type { DashboardSourceCard } from '../source-dashboard.ts';
import { dashboardDegradationForSource, dashboardIsConnectedSource, type DashboardStatus } from './vocabulary.ts';

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

/**
 * The source's sign-in is the owner's to fix: the provider refused the last
 * consent attempt, a worker credential for it is degraded, the connection
 * needs reauthentication, or a source holding data has lost its connection.
 * Unfinished work resolves none of these, so on both dashboards the source
 * reads Needs you whatever its progress says, and its progress reads stalled
 * on waiting_for_credentials. Reads only a refusal's presence, never the
 * provider's words, so it works on ChatGPT's scrubbed card too.
 */
export function dashboardCredentialProblem(
  card: DashboardSourceCard,
  degraded: readonly WorkerCredentialDegradation[] | undefined,
): boolean {
  return card.connection.provider_refusal !== undefined
    || dashboardDegradationForSource(card, degraded) !== undefined
    || card.connection.state === 'reauth_required'
    || (card.coverage.indexed_items > 0 && !dashboardIsConnectedSource(card));
}

/** A refused connect on a source never connected: nothing behind it to measure, but it stays Needs you. */
export function dashboardRefusedFirstConnect(card: DashboardSourceCard): boolean {
  return card.connection.provider_refusal !== undefined
    && (card.connection.state === 'not_connected' || card.connection.state === 'needs_setup')
    && card.coverage.indexed_items === 0;
}
