/**
 * Holds back a complete walk's deletions when a chosen folder suddenly looks
 * empty or much smaller than what is indexed under it: an unmounted disk, a
 * mirror half copied, a sync client starting over. Deleting would remove the
 * person's indexed files, judgments and all, for a fault that fixes itself.
 *
 * - Small deletions (at most `minHeld` items, or at most `share` of what the
 *   walk compared against) apply at once.
 * - A walk that met none of the indexed items deletes nothing.
 * - Otherwise the deletions wait. A later walk, at least `confirmAfterMs`
 *   after the first, that finds the same items still gone applies them; an
 *   item that came back in between is dropped from the wait.
 *
 * State is per folder (connector id) and in memory: a restart starts the wait
 * again, which only delays a real deletion by one more pass.
 */
import type { LocalFilesDeletionGuard } from './connector.ts';

export interface LocalFilesDeletionGuardOptions {
  share?: number;
  minHeld?: number;
  confirmAfterMs?: number;
  now?: () => number;
}

export const LOCAL_FILES_DELETION_SHARE = 0.2;
export const LOCAL_FILES_DELETION_MIN_HELD = 5;
export const LOCAL_FILES_DELETION_CONFIRM_MS = 60_000;

export interface LocalFilesDeletionGuards {
  forFolder(connectorId: string): LocalFilesDeletionGuard;
}

export function createLocalFilesDeletionGuards(options: LocalFilesDeletionGuardOptions = {}): LocalFilesDeletionGuards {
  const share = options.share ?? LOCAL_FILES_DELETION_SHARE;
  const minHeld = options.minHeld ?? LOCAL_FILES_DELETION_MIN_HELD;
  const confirmAfterMs = options.confirmAfterMs ?? LOCAL_FILES_DELETION_CONFIRM_MS;
  const now = options.now ?? Date.now;
  const waiting = new Map<string, { ids: Set<string>; since: number }>();

  return {
    forFolder(connectorId) {
      return ({ absent, indexed }) => {
        const small = absent.length <= minHeld || absent.length <= indexed * share;
        if (small) {
          waiting.delete(connectorId);
          return absent;
        }
        const everything = absent.length >= indexed;
        const prior = waiting.get(connectorId);
        const at = now();
        if (!everything && prior && at - prior.since >= confirmAfterMs) {
          const agreed = absent.filter((item) => prior.ids.has(item.identity.providerItemId));
          if (agreed.length === absent.length) {
            waiting.delete(connectorId);
            return absent;
          }
          // Some are newly gone: apply what both walks agree on, wait on the rest.
          waiting.set(connectorId, {
            ids: new Set(absent.filter((item) => !prior.ids.has(item.identity.providerItemId)).map((item) => item.identity.providerItemId)),
            since: at,
          });
          return agreed;
        }
        // Wait on what is gone now; an item that came back leaves the wait.
        waiting.set(connectorId, { ids: new Set(absent.map((item) => item.identity.providerItemId)), since: prior?.since ?? at });
        return [];
      };
    },
  };
}
