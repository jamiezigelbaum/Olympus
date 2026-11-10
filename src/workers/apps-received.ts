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
  setAppReleaseRecorder,
  setPrivateAnswerCompletionHook,
} from '../core/app-release-capture.ts';
import {
  isAppReleaseRetentionDays,
  openAppReleaseLog,
  type AppReleaseLogStore,
} from '../core/app-release-log.ts';

export interface AppsReceivedOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface AppsReceived {
  handle(body: Record<string, unknown>): Promise<AppsReceivedOutcome>;
  close(): void;
}

/**
 * Raises exactly the recorded item to Private through the per-item override.
 * It must refuse (throw) when the locator no longer resolves to that same
 * item, and write nothing then.
 */
export type SetItemPrivate = (item: { locator: string; provider: string; providerItemId: string; providerConversationId?: string }) => Promise<unknown>;

/** The plain refusal when the recorded item cannot be found as it was recorded. */
export const APPS_RECEIVED_ITEM_GONE = 'Olympus can\'t find this item on this computer any more, so nothing was changed.';

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
  // Opened now, not on the first receipt: an item that becomes Secret before
  // anything is recorded must leave its marker here (forgetSecretAppReleaseItem
  // skips a log that does not exist), or a receipt built before the change and
  // written after it would record its title and locator. A failed open is
  // retried on first use.
  try {
    open();
  } catch (error) {
    console.error(`[olympus:apps-received] open_failed ${error instanceof Error ? error.name : 'error'}`);
  }
  setAppReleaseRecorder((record) => {
    try {
      open().record(record);
    } catch (error) {
      console.error(`[olympus:apps-received] record_failed ${error instanceof Error ? error.name : 'error'}`);
    }
  });
  setPrivateAnswerCompletionHook((privateQuestionKey) => {
    try {
      open().markAnsweredPrivately(privateQuestionKey);
    } catch (error) {
      console.error(`[olympus:apps-received] mark_failed ${error instanceof Error ? error.name : 'error'}`);
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
            // Bound to the recorded item: its full locator, checked against its provider, item and
            // conversation. A bare item id could name another chat's message, so there is no fallback.
            if (!item.locator || !item.provider || !item.providerItemId) return refuse(409, 'item_gone', APPS_RECEIVED_ITEM_GONE);
            try {
              await options.setItemPrivate({
                locator: item.locator,
                provider: item.provider,
                providerItemId: item.providerItemId,
                ...(item.providerConversationId ? { providerConversationId: item.providerConversationId } : {}),
              });
            } catch {
              return refuse(409, 'item_gone', APPS_RECEIVED_ITEM_GONE);
            }
            open().markMadePrivate(id, position);
            return ok({ madePrivate: true });
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
      setPrivateAnswerCompletionHook(undefined);
      store?.close();
      store = undefined;
    },
  };
}
