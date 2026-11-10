/**
 * What AI apps received (#1061): the worker's side of the Privacy tab's third
 * page. It installs the recorder the release exits call
 * (core/app-release-capture.ts), keeps the log (core/app-release-log.ts), and
 * answers the local dashboard's one route, POST /dashboard/apps-received,
 * which the HTTP boundary serves only to a locally minted control session
 * (workers/http.ts isDashboardLocalGradeRoute): never the worker bearer, a
 * bearer-minted session, the relay or any agent tool.
 *
 * "This should be Private" sets the per-item owner override on that one item
 * through the existing override path (`olympus tier set <item> private`,
 * classification/tier-cli.ts): the owner's own decision on one item, kept in
 * the tier ledger, which re-judging and rule sweeps leave alone. It only
 * raises; nothing here lowers an item.
 */
import {
  forgetJobQuestions,
  recordAppRequest,
  releasedItemFromEvidence,
  setAppReleaseRecorder,
  type ReleaseCapture,
  type ReleasedItem,
} from '../core/app-release-capture.ts';
import {
  isAppReleaseRetentionDays,
  openAppReleaseLog,
  type AppReleaseLogStore,
} from '../core/app-release-log.ts';
import { OperationError } from '../core/operation-error.ts';
import type { OperationCaller, OperationCallerWire } from '../core/operation-caller.ts';
import { providerSourceLabel } from '../core/remote-result.ts';

export interface AppsReceivedOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface AppsReceived {
  handle(body: Record<string, unknown>): Promise<AppsReceivedOutcome>;
  close(): void;
}

/** Raises one item to Private through the per-item override; throws when it cannot. */
export type SetItemPrivate = (locator: string) => Promise<unknown>;

const FAMILY_SOURCE: Readonly<Record<string, string>> = { email: 'Mail', file: 'Files', chat: 'Messages', note: 'Notes' };

/**
 * A source answer an agent on this computer received from the worker's answer
 * route. Every evidence item in it left the worker, at its tier.
 */
export function recordAgentAnswer(question: string, callerWire: OperationCallerWire, result: unknown): void {
  try {
    const caller = toCaller(callerWire);
    const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    const items: ReleasedItem[] = (Array.isArray(record.evidence) ? record.evidence : [])
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
      .slice(0, 48)
      .map((entry) => releasedItemFromEvidence(
        entry,
        (typeof entry.provider === 'string' ? providerSourceLabel(entry.provider) : undefined)
          ?? (typeof entry.family === 'string' ? FAMILY_SOURCE[entry.family] : undefined)
          ?? 'Other source',
        typeof entry.title === 'string' ? entry.title : undefined,
      ));
    const capture: ReleaseCapture = { items, heldBack: 0 };
    recordAppRequest({ caller, question, capture });
  } catch {
    // Never changes the answer.
  }
}

function toCaller(wire: OperationCallerWire): OperationCaller {
  return {
    surface: wire.surface,
    ...(wire.connection_id ? { connectionId: wire.connection_id } : {}),
    ...(wire.display_name ? { displayName: wire.display_name } : {}),
    ...(wire.provider ? { provider: wire.provider } : {}),
  };
}

export function createAppsReceived(options: {
  dbPath: string;
  setItemPrivate: SetItemPrivate;
  now?: () => number;
}): AppsReceived {
  let store: AppReleaseLogStore | undefined;
  const open = (): AppReleaseLogStore => {
    store ??= openAppReleaseLog(options.dbPath, options.now ? { now: options.now } : {});
    return store;
  };
  setAppReleaseRecorder((record) => {
    try {
      open().record(record);
    } catch (error) {
      console.error(`[olympus:apps-received] record_failed ${error instanceof Error ? error.name : 'error'}`);
    }
  });

  const ok = (body: Record<string, unknown> = {}): AppsReceivedOutcome => ({ status: 200, body: { ok: true, ...body } });
  const refuse = (status: number, code: string, message: string): AppsReceivedOutcome => ({ status, body: { ok: false, error: { code, message } } });

  return {
    async handle(body) {
      const action = body.action;
      try {
        switch (action) {
          case 'list':
            return ok({ retentionDays: open().retentionDays(), requests: open().list() });
          case 'retention': {
            const days = body.days;
            if (!isAppReleaseRetentionDays(days)) return refuse(400, 'invalid_params', 'Choose 7, 30 or 90 days, or don\'t keep.');
            open().setRetentionDays(days);
            if (days === 0) forgetJobQuestions();
            return ok({ retentionDays: days });
          }
          case 'clear': {
            const removed = open().clear();
            forgetJobQuestions();
            return ok({ removed });
          }
          case 'make_private': {
            const id = typeof body.request === 'string' ? body.request : '';
            const position = typeof body.item === 'number' && Number.isInteger(body.item) ? body.item : -1;
            const item = id && position >= 0 ? open().item(id, position) : undefined;
            if (!item) return refuse(404, 'not_found', 'That item is no longer in the list.');
            if (item.madePrivate) return ok({ madePrivate: true });
            const locators = [item.locator, item.providerItemId].filter((value): value is string => typeof value === 'string' && value !== '');
            if (locators.length === 0) return refuse(409, 'item_unknown', 'Olympus cannot find this item on this computer any more.');
            let lastError: unknown;
            for (const locator of locators) {
              try {
                await options.setItemPrivate(locator);
                open().markMadePrivate(id, position);
                return ok({ madePrivate: true });
              } catch (error) {
                lastError = error;
              }
            }
            const message = lastError instanceof OperationError ? lastError.message : 'Olympus could not change this item.';
            return refuse(409, 'item_unchanged', message);
          }
          default:
            return refuse(400, 'invalid_params', 'Unknown action.');
        }
      } catch {
        return refuse(503, 'unavailable', 'The list of what AI apps received could not be read. Try again in a moment.');
      }
    },
    close() {
      setAppReleaseRecorder(undefined);
      store?.close();
      store = undefined;
    },
  };
}
