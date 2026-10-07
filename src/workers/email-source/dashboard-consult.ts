/**
 * The local dashboard's Outside help adapter: the worker side of the Outside
 * help card (dashboard/pages/outside-help.ts), and the one caller of the
 * outside-help settings writer (core/consult-settings-writer.ts). Design
 * docs/design/frontier-consult-lane.md §A.9, §A.10, §A.14 (stage C5).
 *
 * Reachable only through an authenticated local dashboard control session:
 * the worker's routes require the control-session context header the HTTP
 * boundary injects for these paths alone (workers/http.ts), the Gateway
 * bearer is refused there, and no /dashboard path is ever forwarded by the
 * relay. The product server wires this adapter in as a backend object, so the
 * worker module itself never imports the writer (type-only import), and no
 * MCP, setup-tool, ChatGPT, relay or remote module reaches either
 * (test/consult-settings-writer.test.ts holds the import graph).
 *
 * What it does, content-free throughout (codes, counts, dates; never a
 * question, a reply, a key or the daemon's config):
 *   - `summary`: one word for Setup's row;
 *   - `status`: the card's facts: the settings file, the zkAPI route and its
 *     readiness (zkapiConsultReadiness: blockers as codes), the risk
 *     acknowledgements, the per-language vocabulary packs;
 *   - `setEnabled`: writes consult.json through the writer (compare-and-swap
 *     on the revision the page was built from); turning on requires a
 *     configured route with every acknowledgement accepted;
 *   - `saveRoute`: records the eight acknowledgements (version 3), the
 *     owner-confirmed funding date and the optional daily caps in the zkapi
 *     profile of the owner's sovereignty policy file, as one transaction over
 *     the file as it is now (lease, re-read, patch only that block, validate,
 *     atomic commit; a file that no longer matches this adapter's view is a
 *     conflict and nothing is written), then asks the worker to restart,
 *     because the policy is read at boot;
 *   - `addRoute`: adds the one zkapi profile when none exists;
 *   - `recover` / `abandon`: the two fence buttons (§A.8), both explicit.
 */
import { CONSULT_LANGUAGE_PACKS, consultVocabularyFileStatus, DEFAULT_CONSULT_DOMAIN_PACKS, type ConsultDomainPacks, type ConsultLanguage } from '../../core/consult-gate.ts';
import {
  DEFAULT_CONSULT_SETTINGS,
  readConsultSettings,
  type ConsultSettingsLocation,
} from '../../core/consult-settings.ts';
import { writeConsultSettings, type ConsultSettingsWriteRefusal } from '../../core/consult-settings-writer.ts';
import {
  abandonZkapiFence,
  defaultZkapiStatePath,
  zkapiConsultReadiness,
  zkapiFenceScope,
  zkapiOutstandingFences,
  type ZkapiConsultReadiness,
  type ZkapiConsultResult,
  type ZkapiConsultTransportOptions,
} from '../../core/consult-transport-zkapi.ts';
import {
  updateSovereigntyConfigFile,
  type SovereigntyConfig,
  type SovereigntyModelProfile,
} from '../../core/sovereignty.ts';
import {
  parseIsoDate,
  ZKAPI_DAEMON_DEFAULT_BASE_URL,
  ZKAPI_RISK_ACKNOWLEDGEMENTS,
  ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION,
  type ZkapiConsultSettings,
} from '../../core/zkapi-consult-settings.ts';
import { OperationError } from '../../core/operation-error.ts';
import { resolveZkapiConsultTransport } from '../chatgpt/consult-orchestrator.ts';
import type {
  DashboardOutsideHelpLanguage,
  DashboardOutsideHelpRoute,
  DashboardOutsideHelpStatus,
  DashboardOutsideHelpSummary,
} from '../dashboard/outside-help.ts';

export type DashboardConsultOutcome =
  | { ok: true; status_message: string; restarting?: boolean; revision?: number }
  | { ok: false; httpStatus: number; code: string; message: string; revision?: number };

export interface DashboardConsultBackend {
  /** One word for Setup's row; probes nothing. */
  summary(): DashboardOutsideHelpSummary;
  /** The card's facts, including the route readiness probe (a version call and two port probes). */
  status(): Promise<DashboardOutsideHelpStatus>;
  setEnabled(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  saveRoute(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  addRoute(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  recover(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  abandon(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
}

export interface DashboardConsultAdapterOptions {
  /** The policy as loaded at boot; replaced in memory after each write here. */
  sovereignty: { config: SovereigntyConfig; source: string; path?: string };
  /** Whether a profile's secret reference resolves on this Mac. Presence only: the adapter never holds a key. */
  secretPresent: (secretRef: string | undefined) => boolean;
  /**
   * Runs the recovery session for the route. The composition root resolves
   * the route's key from `secretRef` and hands it to the transport; the
   * adapter passes the route without a key and never sees one.
   */
  recoverSession: (route: ZkapiConsultTransportOptions, secretRef: string | undefined) => Promise<ZkapiConsultResult>;
  /** Restarts the worker to apply a policy change; false when it cannot restart itself. */
  requestReload: () => boolean;
  env?: Record<string, string | undefined>;
  /** Where consult.json lives; defaults to HOME in `env`. */
  settingsLocation?: ConsultSettingsLocation;
  statePath?: string;
  now?: () => Date;
  /** Seam for tests: the readiness probe. */
  readiness?: (options: Parameters<typeof zkapiConsultReadiness>[0]) => Promise<ZkapiConsultReadiness>;
}

/** The id the adapter gives the one zkapi profile it adds. */
export const DASHBOARD_ZKAPI_PROFILE_ID = 'zkapi-consult';
/** The worker-environment variable the added profile's key reference names. */
export const DASHBOARD_ZKAPI_API_KEY_ENV = 'OLYMPUS_ZKAPI_API_KEY';
/** The model the added profile names: the one M1 measured (docs/design/consult-m1-measurement.md). */
export const DASHBOARD_ZKAPI_DEFAULT_MODEL = 'openai/gpt-5-mini';

const ALL_LANGUAGES = Object.keys(CONSULT_LANGUAGE_PACKS) as ConsultLanguage[];
const ACKNOWLEDGEMENT_IDS: readonly string[] = ZKAPI_RISK_ACKNOWLEDGEMENTS.map((entry) => entry.id);

const MESSAGES = {
  needsRevision: 'This change needs the settings revision the page was built from. Reload the page and try again.',
  conflict: 'Outside help was changed somewhere else since this page loaded. Reload the page to see the current setting.',
  invalidCurrent: 'The outside-help settings file on this computer is damaged. Choose Replace the file to write a fresh one.',
  routeMissing: 'Add the zkAPI route before turning outside help on.',
  acknowledgementsIncomplete: 'Read and tick every statement about cost and risk before turning outside help on.',
  languageMissing: 'A chosen language has no vocabulary pack installed on this computer.',
  languagesEmpty: 'Choose at least one language.',
  noHome: 'Olympus cannot find your home folder, so it cannot write the settings file.',
  custody: 'The folder ~/.olympus must belong to you alone (owner-only, not a link). Fix its permissions, then try again.',
  busy: 'Another change is being written right now. Try again in a moment.',
  writeFailed: 'Olympus could not write the settings file. Nothing was changed.',
  writeUncertain: 'Olympus could not confirm whether the settings file changed. Reload the page to see the current setting.',
  policyNotFile: 'Your privacy policy is not kept in a file on this computer, so Olympus cannot record this here.',
  policyChanged: 'Your privacy policy file changed since this page loaded. Nothing was written; reload the page and try again.',
  policyUnreadable: 'Your privacy policy file could not be read. Nothing was written.',
  routeExists: 'A zkAPI route is already configured.',
  tickAll: 'Tick every statement to record your acknowledgement.',
  fundingDate: 'Enter the funding date as YYYY-MM-DD, the day the deposit was confirmed.',
  caps: 'A daily limit must be a whole number of requests, or a positive number of dollars.',
  confirm: 'This action needs your confirmation.',
  noFence: 'There is no held request to recover.',
  otherWallet: 'The held request belongs to another wallet folder. Recover it there, or abandon it.',
  scope: 'Name which held request to abandon.',
  turnedOn: 'Outside help is on. When a private answer in ChatGPT is incomplete, Olympus may send one outside question for it.',
  turnedOff: 'Outside help is off. No outside question is sent.',
  routeSavedRestart: 'Saved. Olympus is restarting its worker to apply the change; this page will refresh.',
  routeSavedNoRestart: 'Saved. Ask your agent to restart the managed Olympus worker to apply it; this worker cannot restart itself.',
  routeAdded: 'The zkAPI route is added. Put the daemon\'s API key in the worker environment file, then finish the steps below.',
  recovered: 'Recovered: the held request settled and consults can run again.',
  recoveryIncomplete: 'The recovery session ran, but settlement was not confirmed. The request is still held; try again later.',
  recoveryFailed: 'The recovery session did not complete. The request is still held.',
  abandoned: 'The held request is marked abandoned. It no longer blocks consults and stays in the ledger as a record.',
} as const;

export function createDashboardConsultAdapter(options: DashboardConsultAdapterOptions): DashboardConsultBackend {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const statePath = options.statePath ?? defaultZkapiStatePath(env.HOME?.trim() || undefined);
  const location: ConsultSettingsLocation = options.settingsLocation ?? { env };
  const readiness = options.readiness ?? zkapiConsultReadiness;
  let policy = options.sovereignty.config;
  let restartPending = false;

  const zkapiProfile = (): { id: string; profile: SovereigntyModelProfile } | undefined => {
    const entries = Object.entries(policy.modelProfiles).filter(([, profile]) => profile.provider === 'zkapi');
    if (entries.length !== 1) return undefined;
    const [id, profile] = entries[0]!;
    return { id, profile };
  };

  // The route without its key: the adapter never resolves a secret.
  const transport = (): ZkapiConsultTransportOptions | undefined => resolveZkapiConsultTransport(
    policy.modelProfiles,
    () => undefined,
    { env, statePath },
  );

  const fenceHeld = (): boolean => {
    try {
      return Object.keys(zkapiOutstandingFences(statePath)).length > 0;
    } catch {
      return false;
    }
  };

  const settingsView = (): DashboardOutsideHelpStatus['settings'] => {
    const read = readConsultSettings(location);
    const settings = read.state === 'valid' ? read.settings : DEFAULT_CONSULT_SETTINGS;
    return {
      state: read.state === 'invalid' ? 'invalid' : read.state === 'valid' && read.settings.enabled ? 'on' : 'off',
      revision: read.state === 'valid' ? read.settings.revision : 0,
      languages: [...settings.languages],
      domains: { ...settings.domains },
      strict: settings.strict,
      ...(read.state === 'invalid' ? { invalidReason: read.reason } : {}),
    };
  };

  const languages = (): DashboardOutsideHelpLanguage[] => {
    const status = consultVocabularyFileStatus(
      // Language packs only: every domain pack off, whatever the current set of domain keys.
      { languages: ALL_LANGUAGES, domains: Object.fromEntries(Object.keys(DEFAULT_CONSULT_DOMAIN_PACKS).map((key) => [key, false])) as unknown as Partial<ConsultDomainPacks> },
      env as NodeJS.ProcessEnv,
    );
    return ALL_LANGUAGES.map((language) => {
      const pack = CONSULT_LANGUAGE_PACKS[language];
      const entry = status.find((item) => item.id === pack);
      return { language, pack, state: entry?.state ?? 'missing', installed: entry?.state === 'verified' };
    });
  };

  const routeView = async (): Promise<DashboardOutsideHelpRoute> => {
    const route = zkapiProfile();
    if (!route) return { state: 'not_configured', policyWritable: policyWritable() };
    const settings = route.profile.zkapi;
    const acknowledgements = settings?.acknowledgements ?? { version: 0, accepted: [] };
    const complete = acknowledgements.version === ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION
      && ACKNOWLEDGEMENT_IDS.every((id) => acknowledgements.accepted.includes(id));
    const base: Extract<DashboardOutsideHelpRoute, { state: 'configured' }> = {
      state: 'configured',
      profileId: route.id,
      model: 'model' in route.profile && typeof route.profile.model === 'string' ? route.profile.model : '',
      policyWritable: policyWritable(),
      secretRef: route.profile.secretRef ?? '',
      acknowledgements: { version: acknowledgements.version, accepted: [...acknowledgements.accepted], complete },
      ...(settings?.fundingDate ? { fundingDate: settings.fundingDate } : {}),
      ...(settings?.depositUsd !== undefined ? { depositUsd: settings.depositUsd } : {}),
      ...(settings?.dailyRequestCap !== undefined ? { dailyRequestCap: settings.dailyRequestCap } : {}),
      ...(settings?.dailySpendCapUsd !== undefined ? { dailySpendCapUsd: settings.dailySpendCapUsd } : {}),
    };
    const transportOptions = transport();
    if (!transportOptions) return base;
    try {
      const ready = await readiness({ ...transportOptions, apiKeyPresent: options.secretPresent(route.profile.secretRef), now: () => now() });
      return {
        ...base,
        readiness: {
          ready: ready.blockers.length === 0,
          blockers: [...ready.blockers],
          daemonFound: ready.daemonExecutable !== undefined,
          ...(ready.daemonVersion ? { daemonVersion: ready.daemonVersion } : {}),
          torMode: ready.tor,
          torFound: ready.torExecutable !== undefined,
          apiKeyConfigured: ready.apiKeyConfigured,
          expiry: {
            state: ready.money.expiryEstimate.state,
            ...(ready.money.expiryEstimate.daysLeft !== undefined ? { daysLeft: ready.money.expiryEstimate.daysLeft } : {}),
            ...(ready.money.expiryEstimate.expiryDate ? { expiryDate: ready.money.expiryEstimate.expiryDate } : {}),
          },
          requestsToday: { ...ready.requestsToday },
          spendToday: { ...ready.spendToday },
          fences: fencesView(),
          routeLabel: ready.routeLabel,
          ...(ready.lastSession ? { lastSession: { at: ready.lastSession.at, result: ready.lastSession.result } } : {}),
        },
      };
    } catch {
      return { ...base, readinessUnavailable: true };
    }
  };

  // Held fences by wallet scope (the key Abandon needs), from the ledger.
  const fencesView = (): Array<{ scope: string; at: string; thisWallet: boolean }> => {
    try {
      const mine = zkapiFenceScope({ env });
      return Object.entries(zkapiOutstandingFences(statePath)).map(([scope, fence]) => ({ scope, at: fence.at, thisWallet: scope === mine }));
    } catch {
      return [];
    }
  };

  const policyWritable = (): boolean => options.sovereignty.source === 'file' && Boolean(options.sovereignty.path);

  /**
   * One transaction over the policy file as it is now: lease, re-read, the
   * patch over the current policy (only the fields this card owns), validate,
   * atomic commit. The file must still match the policy this adapter's view
   * was built on; otherwise nothing is written, the view follows the file,
   * and the owner is told to reload.
   */
  const writePolicy = (patch: (current: SovereigntyConfig) => SovereigntyConfig): DashboardConsultOutcome | undefined => {
    if (!policyWritable()) return { ok: false, httpStatus: 409, code: 'policy_not_file', message: MESSAGES.policyNotFile };
    const update = updateSovereigntyConfigFile({ path: options.sovereignty.path!, expect: policy, patch });
    if (!update.ok) {
      if (update.reason === 'conflict' && update.current) policy = update.current;
      return update.reason === 'conflict'
        ? { ok: false, httpStatus: 409, code: 'policy_changed', message: MESSAGES.policyChanged }
        : { ok: false, httpStatus: 500, code: 'policy_unreadable', message: MESSAGES.policyUnreadable };
    }
    policy = update.config;
    return undefined;
  };

  const invalid = (message: string, code = 'invalid_params'): DashboardConsultOutcome => ({ ok: false, httpStatus: 400, code, message });

  return {
    summary() {
      const settings = settingsView();
      if (settings.state === 'invalid') return { state: 'invalid' };
      if (!zkapiProfile()) return { state: 'route_not_configured' };
      if (fenceHeld()) return { state: 'fence_held' };
      return { state: settings.state };
    },

    async status() {
      return {
        settings: settingsView(),
        route: await routeView(),
        languages: languages(),
        restartPending,
      };
    },

    async setEnabled(update) {
      const enabled = update.enabled;
      if (typeof enabled !== 'boolean') return invalid('Say whether outside help should be on or off.');
      const revision = update.revision;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return invalid(MESSAGES.needsRevision, 'needs_revision');
      const replaceInvalid = update.replace_invalid === true;
      const current = readConsultSettings(location);
      const base = current.state === 'valid' ? current.settings : DEFAULT_CONSULT_SETTINGS;
      let chosen: ConsultLanguage[] = [...base.languages];
      // Turning off keeps the stored languages whatever the form sent (an
      // empty selection must never stop the off switch).
      if (enabled && update.languages !== undefined) {
        if (!Array.isArray(update.languages) || update.languages.length === 0) return invalid(MESSAGES.languagesEmpty, 'languages_empty');
        if (!update.languages.every((item): item is ConsultLanguage => typeof item === 'string' && (ALL_LANGUAGES as string[]).includes(item))) {
          return invalid('An unknown language was chosen.', 'language_unknown');
        }
        chosen = [...new Set(update.languages)];
      }
      if (enabled) {
        const route = zkapiProfile();
        if (!route) return { ok: false, httpStatus: 409, code: 'route_not_configured', message: MESSAGES.routeMissing };
        const acknowledgements = route.profile.zkapi?.acknowledgements;
        const complete = acknowledgements?.version === ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION
          && ACKNOWLEDGEMENT_IDS.every((id) => acknowledgements.accepted.includes(id));
        if (!complete) return { ok: false, httpStatus: 409, code: 'acknowledgements_incomplete', message: MESSAGES.acknowledgementsIncomplete };
        const installed = new Set(languages().filter((entry) => entry.installed).map((entry) => entry.language));
        if (!chosen.every((language) => installed.has(language))) return invalid(MESSAGES.languageMissing, 'language_pack_missing');
      }
      const result = writeConsultSettings({
        enabled,
        languages: chosen,
        domains: { ...base.domains },
        // Strict mode's approval step is stage C6; until then the flag is only kept as saved.
        strict: base.strict,
        expectedRevision: revision,
        ...(replaceInvalid ? { replaceInvalid: true } : {}),
      }, location);
      if (result.ok) {
        return { ok: true, status_message: enabled ? MESSAGES.turnedOn : MESSAGES.turnedOff, revision: result.settings.revision };
      }
      return writeRefusal(result.reason, result.current?.state === 'valid' ? result.current.settings.revision : 0);
    },

    async saveRoute(update) {
      const route = zkapiProfile();
      if (!route) return { ok: false, httpStatus: 409, code: 'route_not_configured', message: MESSAGES.routeMissing };
      const acknowledged = update.acknowledged;
      if (!Array.isArray(acknowledged) || !acknowledged.every((item) => typeof item === 'string')) return invalid(MESSAGES.tickAll, 'acknowledgements_incomplete');
      const accepted = new Set(acknowledged as string[]);
      if (!ACKNOWLEDGEMENT_IDS.every((id) => accepted.has(id))) return invalid(MESSAGES.tickAll, 'acknowledgements_incomplete');
      // The owned fields of the zkapi block, applied over the block as the
      // file holds it now; `null` clears a cap.
      const zkapi: Record<string, unknown> = {};
      const cleared: string[] = [];
      zkapi.acknowledgements = { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: [...ACKNOWLEDGEMENT_IDS] };
      if (update.funding_date !== undefined && update.funding_date !== null && update.funding_date !== '') {
        if (typeof update.funding_date !== 'string' || parseIsoDate(update.funding_date) === undefined) return invalid(MESSAGES.fundingDate, 'funding_date_invalid');
        zkapi.fundingDate = update.funding_date;
      }
      for (const [field, key] of [['daily_request_cap', 'dailyRequestCap'], ['daily_spend_cap_usd', 'dailySpendCapUsd'], ['deposit_usd', 'depositUsd']] as const) {
        const raw = update[field];
        if (raw === undefined) continue;
        if (raw === null || raw === '') {
          cleared.push(key);
          continue;
        }
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || (key === 'dailyRequestCap' && !Number.isInteger(raw))) return invalid(MESSAGES.caps, 'cap_invalid');
        zkapi[key] = raw;
      }
      try {
        const refused = writePolicy((current) => {
          const next = structuredClone(current);
          const profile = next.modelProfiles[route.id];
          if (!profile || profile.provider !== 'zkapi') throw new OperationError('config_error', 'The zkAPI route is no longer in the policy file.');
          // Only this block is owned here. The validator parses it (unknown keys refuse; bounds apply).
          const block: Record<string, unknown> = { ...(profile.zkapi ?? {}), ...zkapi };
          for (const key of cleared) delete block[key];
          (profile as { zkapi?: unknown }).zkapi = block as unknown as ZkapiConsultSettings;
          return next;
        });
        if (refused) return refused;
      } catch (error) {
        return { ok: false, httpStatus: 400, code: 'config_error', message: (error as Error).message };
      }
      const restarting = options.requestReload();
      restartPending = !restarting;
      return { ok: true, status_message: restarting ? MESSAGES.routeSavedRestart : MESSAGES.routeSavedNoRestart, restarting };
    },

    async addRoute(update) {
      if (update.confirm !== true) return invalid(MESSAGES.confirm, 'confirmation_required');
      if (zkapiProfile()) return { ok: false, httpStatus: 409, code: 'route_exists', message: MESSAGES.routeExists };
      try {
        const refused = writePolicy((current) => {
          if (Object.values(current.modelProfiles).some((profile) => profile.provider === 'zkapi')) {
            throw new OperationError('config_error', 'A zkAPI route is already in the policy file.');
          }
          const next = structuredClone(current);
          next.modelProfiles[DASHBOARD_ZKAPI_PROFILE_ID] = {
            provider: 'zkapi',
            trust: 'standard_cloud',
            purpose: 'consult',
            baseUrl: ZKAPI_DAEMON_DEFAULT_BASE_URL,
            model: DASHBOARD_ZKAPI_DEFAULT_MODEL,
            secretRef: `env:${DASHBOARD_ZKAPI_API_KEY_ENV}`,
            zkapi: {} as ZkapiConsultSettings,
          } as SovereigntyModelProfile;
          return next;
        });
        if (refused) return refused;
      } catch (error) {
        return { ok: false, httpStatus: 400, code: 'config_error', message: (error as Error).message };
      }
      const restarting = options.requestReload();
      restartPending = !restarting;
      return { ok: true, status_message: MESSAGES.routeAdded, restarting };
    },

    async recover(update) {
      if (update.confirm !== true) return invalid(MESSAGES.confirm, 'confirmation_required');
      const transportOptions = transport();
      if (!transportOptions) return { ok: false, httpStatus: 409, code: 'route_not_configured', message: MESSAGES.routeMissing };
      let fences: Record<string, { at: string }>;
      try {
        fences = zkapiOutstandingFences(statePath);
      } catch {
        return { ok: false, httpStatus: 500, code: 'state_unavailable', message: 'The consult ledger on this computer could not be read.' };
      }
      const scopes = Object.keys(fences);
      if (scopes.length === 0) return { ok: false, httpStatus: 409, code: 'no_unresolved_session', message: MESSAGES.noFence };
      if (!scopes.includes(zkapiFenceScope({ env }))) return { ok: false, httpStatus: 409, code: 'unresolved_session_other_wallet', message: MESSAGES.otherWallet };
      const result = await options.recoverSession(transportOptions, zkapiProfile()?.profile.secretRef);
      const receipt = result.ok ? result.receipt : result.error.receipt;
      if (!result.ok) return { ok: false, httpStatus: 502, code: result.error.code, message: MESSAGES.recoveryFailed };
      if (receipt?.fence !== 'clear' || receipt.settlement !== 'confirmed') {
        return { ok: false, httpStatus: 502, code: 'recovery_incomplete', message: MESSAGES.recoveryIncomplete };
      }
      return { ok: true, status_message: MESSAGES.recovered };
    },

    async abandon(update) {
      if (update.confirm !== true) return invalid(MESSAGES.confirm, 'confirmation_required');
      if (typeof update.scope !== 'string' || !/^[0-9a-f]{32}$/.test(update.scope)) return invalid(MESSAGES.scope, 'scope_invalid');
      let found: boolean;
      try {
        found = abandonZkapiFence(statePath, update.scope, now());
      } catch {
        return { ok: false, httpStatus: 500, code: 'state_unavailable', message: 'The consult ledger on this computer could not be written.' };
      }
      if (!found) return { ok: false, httpStatus: 409, code: 'no_unresolved_session', message: MESSAGES.noFence };
      return { ok: true, status_message: MESSAGES.abandoned };
    },
  };
}

function writeRefusal(reason: ConsultSettingsWriteRefusal, revision: number): DashboardConsultOutcome {
  switch (reason) {
    case 'revision_conflict':
      return { ok: false, httpStatus: 409, code: 'conflict', message: MESSAGES.conflict, revision };
    case 'invalid_current':
      return { ok: false, httpStatus: 409, code: 'settings_invalid', message: MESSAGES.invalidCurrent, revision: 0 };
    case 'no_home':
    case 'home_missing':
      return { ok: false, httpStatus: 500, code: 'no_home', message: MESSAGES.noHome };
    case 'directory_symlink':
    case 'directory_custody':
    case 'directory_unavailable':
      return { ok: false, httpStatus: 409, code: 'directory_custody', message: MESSAGES.custody };
    case 'lease_busy':
      return { ok: false, httpStatus: 503, code: 'busy', message: MESSAGES.busy };
    case 'invalid_input':
      return { ok: false, httpStatus: 400, code: 'invalid_params', message: MESSAGES.languagesEmpty };
    case 'write_failed':
      return { ok: false, httpStatus: 500, code: 'write_failed', message: MESSAGES.writeFailed };
    case 'write_uncertain':
      return { ok: false, httpStatus: 500, code: 'write_uncertain', message: MESSAGES.writeUncertain };
  }
}
