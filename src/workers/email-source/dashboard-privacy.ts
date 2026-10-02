/**
 * The local dashboard's privacy adapter: the worker side of the Privacy row
 * and editor, over the ChatGPT setup backend's own privacy operation
 * (chatgpt/setup-tools.ts olympus_privacy_get / olympus_privacy_set), so the
 * validation, caps, revision check, owner confirmation and Secrets-location
 * filter are that operation's own.
 *
 * - `summary` is what every page that names privacy reads: counts only, with
 *   the privacy-check backlog (a corpus-wide count) cached briefly.
 * - `read` is the editor's full settings; the worker supplies it only to a
 *   reader holding write authority.
 * - `save` requires the revision the editor was built from (the empty
 *   profile has one too), so a save can never skip the compare-and-swap,
 *   and asks the engine for the owner's confirmation only for a confirmed
 *   save that lowers protection. Reading never issues a confirmation.
 */
import { PRIVACY_GET_TOOL_NAME, PRIVACY_META_KEY, PRIVACY_SET_TOOL_NAME, type PrivacySettings } from '../chatgpt/dashboard-contract.ts';
import { ChatGptSurfaceError, errorMessage } from '../chatgpt/response-builder.ts';
import { callSetupTool, type ChatGptSetupBackend } from '../chatgpt/setup-tools.ts';
import { lowersPrivacy, visiblePrivacy } from '../dashboard/shared-privacy.ts';
import type { DashboardPrivacySummary } from '../dashboard/source-rows.ts';

export type DashboardPrivacyOutcome =
  | { ok: true; status: 'current' | 'saved' | 'conflict'; settings: PrivacySettings }
  | { ok: false; code: string; message: string };

export type DashboardPrivacySummaryOutcome =
  | { ok: true; summary: DashboardPrivacySummary }
  | { ok: false; code: string; message: string };

export interface DashboardPrivacyAdapter {
  summary(): Promise<DashboardPrivacySummaryOutcome>;
  read(): Promise<DashboardPrivacyOutcome>;
  save(update: Record<string, unknown>): Promise<DashboardPrivacyOutcome>;
}

export interface DashboardPrivacyAdapterOptions {
  backend: ChatGptSetupBackend;
  /** The saved settings with a given backlog count, without counting it (setup-backend.ts readChatGptPrivacySettings). */
  readSettings(pendingCount: number): PrivacySettings;
  /** Items waiting for the privacy check: a corpus-wide count, so it is cached. */
  pendingCount(): number;
  /** How long a backlog count is reused. */
  pendingTtlMs?: number;
  now?: () => number;
}

export const DASHBOARD_PRIVACY_PENDING_TTL_MS = 60_000;

const NEEDS_REVISION = 'A privacy save needs the revision the editor was built from. Reload the page and try again.';

export function createDashboardPrivacyAdapter(options: DashboardPrivacyAdapterOptions): DashboardPrivacyAdapter {
  const now = options.now ?? Date.now;
  const ttl = options.pendingTtlMs ?? DASHBOARD_PRIVACY_PENDING_TTL_MS;
  let cached: { at: number; count: number } | undefined;

  const pending = (): number => {
    const at = now();
    if (!cached || at - cached.at >= ttl) {
      let count = 0;
      try {
        count = Math.max(0, Math.floor(options.pendingCount()));
      } catch {
        count = 0;
      }
      cached = { at, count };
    }
    return cached.count;
  };

  const failure = (error: unknown) => ({
    ok: false as const,
    code: error instanceof ChatGptSurfaceError ? error.code : 'unavailable',
    message: errorMessage(error),
  });

  const visible = (): PrivacySettings => visiblePrivacy(options.readSettings(pending()), options.backend.secretLocations());

  return {
    async summary() {
      try {
        const settings = visible();
        return { ok: true, summary: { configured: settings.configured, pendingCount: settings.pendingCount, ruleCount: settings.rules.length } };
      } catch (error) {
        return failure(error);
      }
    },

    async read() {
      try {
        return { ok: true, status: 'current', settings: visible() };
      } catch (error) {
        return failure(error);
      }
    },

    async save(update) {
      try {
        const { confirm, ...fields } = update;
        // No revision, no save: an omitted one would skip the compare-and-swap.
        if (typeof fields.revision !== 'string' || fields.revision.trim() === '') {
          return { ok: false, code: 'invalid_params', message: NEEDS_REVISION };
        }
        const args: Record<string, unknown> = { ...fields };
        if (confirm === true) {
          const draft = {
            ...(typeof fields.description === 'string' ? { description: fields.description.trim() } : {}),
            ...(Array.isArray(fields.rules) ? { rules: fields.rules as Array<{ kind: string; source_id: string }> } : {}),
          };
          if (lowersPrivacy(draft, visible())) {
            const issued = await callSetupTool(PRIVACY_GET_TOOL_NAME, {}, options.backend);
            const token = (issued._meta as Record<string, { confirmation?: string }> | undefined)?.[PRIVACY_META_KEY]?.confirmation;
            if (token) args.confirmation = token;
          }
        }
        const result = await callSetupTool(PRIVACY_SET_TOOL_NAME, args, options.backend);
        const settings = (result._meta as Record<string, PrivacySettings> | undefined)?.[PRIVACY_META_KEY];
        if (!settings) return { ok: false, code: 'unavailable', message: 'Olympus could not read your privacy settings.' };
        const status = (result.structuredContent as { status?: string } | undefined)?.status === 'conflict' ? 'conflict' : 'saved';
        const { confirmation: _issued, ...shown } = settings;
        return { ok: true, status, settings: shown };
      } catch (error) {
        return failure(error);
      }
    },
  };
}
