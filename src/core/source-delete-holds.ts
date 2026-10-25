/**
 * What keeps a per-source Delete waiting for a source that has neither a
 * credential nor a pairing to end first (docs/design/source-storage.md,
 * "Delete"): something the owner approved in the dashboard that still holds,
 * and counts as connected. Like the forget registry, a hold's logic lives in
 * the module that owns its state; this list names them, and the data
 * lifecycle (which knows no source by name) asks it.
 */
import { archiveImportDeleteHold } from '../workers/archive-import/requests.ts';
import type { LayoutEnv } from './olympus-layout.ts';

export interface SourceDeleteHold {
  id: string;
  sourceId: string;
  /** Whether the hold is there now. A record that cannot be read counts as there. */
  present(env: LayoutEnv): boolean;
  /** How the owner ends it, for the refusal. */
  nextAction: string;
  /**
   * Runs the custody check and the Delete under the one exclusion the hold's
   * own writers take, so nothing is approved between the check and the Delete.
   */
  exclusive<T>(env: LayoutEnv, run: () => T): T;
}

export const SOURCE_DELETE_HOLDS: readonly SourceDeleteHold[] = [archiveImportDeleteHold];

export function sourceDeleteHolds(sourceId: string): SourceDeleteHold[] {
  return SOURCE_DELETE_HOLDS.filter((hold) => hold.sourceId === sourceId);
}
