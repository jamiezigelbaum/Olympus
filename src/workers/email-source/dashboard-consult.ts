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
 *   - `status`: the card's facts: the settings file, the zkAPI route and its
 *     readiness (zkapiConsultReadiness: blockers as codes), the risk
 *     acknowledgements, the per-language vocabulary packs;
 *   - `setEnabled`: writes consult.json through the writer (compare-and-swap
 *     on the revision the page was built from), with the level the owner
 *     chose ("What may zkAPI send?": Standard or Strict); turning on requires
 *     a configured route with every statement accepted at the current
 *     version. Choosing a level is never refused for the statements: sending
 *     needs them anyway (the transport), so the card says it is paused;
 *   - `saveRoute`: records the six statements (version 5) when accepted, the
 *     owner-confirmed funding date and the optional daily caps in the zkapi
 *     profile of the owner's sovereignty policy file, as one transaction over
 *     the file as it is now (lease, re-read, patch only that block, validate,
 *     atomic commit; a file that no longer matches this adapter's view is a
 *     conflict and nothing is written), then asks the worker to restart,
 *     because the policy is read at boot;
 *   - `addRoute`: adds the one zkapi profile when none exists;
 *   - `recover` / `abandon`: the two fence buttons (§A.8), both explicit;
 *   - `saveWriter`: the owner's own writer model and the zkAPI model for
 *     ChatGPT questions (consult.json `writer`, `chatgptFrontierModel`;
 *     owner decision 2026-10-10), through the same writer, compare-and-swap;
 *   - `testWriter`: starts the writer capability check
 *     (core/consult-writer-check.ts) in the background, only on this click;
 *     it sends nothing to zkAPI, and `status` carries its progress and the
 *     last result;
 *   - `installTools`: starts the one-click install of the pinned Tor and
 *     zkapi-clientd builds (core/managed-tools.ts) in the background and
 *     returns at once; `status` carries where each program was found and the
 *     install's progress. It writes no setting and touches no wallet or key.
 */
import { CONSULT_LANGUAGE_PACKS, consultVocabularyFileStatus, DEFAULT_CONSULT_DOMAIN_PACKS, type ConsultDomainPacks, type ConsultLanguage } from '../../core/consult-gate.ts';
import {
  CONSULT_LEVEL_FOR_REPAIR,
  CONSULT_LEVELS,
  CONSULT_LIGHT_CLEANUP_INSTRUCTION,
  CONSULT_STANDARD_INSTRUCTION_MAX_CHARS,
  CONSULT_STANDARD_MODES,
  DEFAULT_CONSULT_SETTINGS,
  consultChatgptFrontierModel,
  consultStandardMode,
  parseConsultWriterChoice,
  readConsultSettings,
  type ConsultLevel,
  type ConsultSettings,
  type ConsultSettingsLocation,
  type ConsultStandardMode,
  type ConsultWriterChoice,
} from '../../core/consult-settings.ts';
import type { ConsultWriterCheckReport, ConsultWriterCheckResult } from '../../core/consult-writer-check.ts';
import { CONSULT_ASK_MAX_CHARS, type ConsultAskInput, type ConsultAskResult } from '../../core/consult-ask.ts';
import { writeConsultSettings, type ConsultSettingsWriteRefusal } from '../../core/consult-settings-writer.ts';
import {
  abandonZkapiFence,
  defaultZkapiStatePath,
  resolveExecutable,
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
import { createManagedToolsJob, managedToolsState, type ManagedToolsJob, type ManagedToolsJobState } from '../../core/managed-tools.ts';
import type { DashboardOutsideHelpInstall, DashboardOutsideHelpTools } from '../dashboard/outside-help-tools.ts';
import { resolveZkapiConsultTransport } from '../chatgpt/consult-orchestrator.ts';
import type {
  DashboardOutsideHelpLanguage,
  DashboardOutsideHelpRoute,
  DashboardOutsideHelpStatus,
  DashboardOutsideHelpWriter,
} from '../dashboard/outside-help.ts';

export type DashboardConsultOutcome =
  | { ok: true; status_message: string; restarting?: boolean; revision?: number }
  | { ok: false; httpStatus: number; code: string; message: string; revision?: number };

export interface DashboardConsultBackend {
  /** The card's facts, including the route readiness probe (a version call and two port probes). */
  status(): Promise<DashboardOutsideHelpStatus>;
  setEnabled(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  saveRoute(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  addRoute(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  recover(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  abandon(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  installTools(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  saveWriter(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  testWriter(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  /** How Standard prepares a question: `standard_mode`, and `standard_instruction` for custom. */
  saveStandard(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  /** "Ask anonymously": starts one typed question in the background; the card polls for the result. */
  ask(update: Record<string, unknown>): Promise<DashboardConsultOutcome>;
  /**
   * Stores the level (and Standard's cleanup) a user chose in conversation
   * (ask_anonymously `remember`), marking it chosen, through the same
   * compare-and-swap write as the card; everything else carries.
   */
}

/**
 * The adapter the composition root holds: the dashboard's backend plus the
 * one write the agent's Ask needs (not a dashboard action, so not on the
 * worker-facing interface).
 */
export interface DashboardConsultAdapter extends DashboardConsultBackend {
  /** Stores the agent's Strict/Standard choice as the default (`levelChosen`), through the only allowed writer. */
  rememberLevel(choice: { level: ConsultLevel; cleanup?: ConsultStandardMode }): Promise<{ ok: true } | { ok: false; message: string }>;
}

/**
 * Runs the writer capability check against the writer chosen now. The
 * composition root resolves the writer's key; the adapter never holds one.
 * Throws an Error with a plain message when it cannot run.
 */
export type DashboardWriterCheckRunner = (input: {
  onCase: (result: ConsultWriterCheckResult, index: number, total: number) => void;
}) => Promise<ConsultWriterCheckReport>;

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
  /** Seam for tests: the background install (default: the pinned downloads into the managed folder). */
  toolsJob?: ManagedToolsJob;
  /** Seam for tests: where each program is (default: the managed folder, then PATH). */
  toolsState?: () => DashboardOutsideHelpTools['tools'];
  /** The writer capability check (absent: the card offers no test). */
  writerCheck?: DashboardWriterCheckRunner;
  /** "Ask anonymously" (core/consult-ask.ts), bound by the composition root; absent: the card offers no box. */
  ask?: (input: ConsultAskInput) => Promise<ConsultAskResult>;
  /** The ChatGPT model missing from the live zkAPI listing, when it last was. */
  chatgptModelProblem?: () => { at: string; message: string } | undefined;
}

/** The id the adapter gives the one zkapi profile it adds. */
export const DASHBOARD_ZKAPI_PROFILE_ID = 'zkapi-consult';
/** The worker-environment variable the added profile's key reference names. */
export const DASHBOARD_ZKAPI_API_KEY_ENV = 'OLYMPUS_ZKAPI_API_KEY';
/** The model the added profile names: the one M1 measured (docs/design/consult-m1-measurement.md). */
export const DASHBOARD_ZKAPI_DEFAULT_MODEL = 'openai/gpt-5-mini';

const ALL_LANGUAGES = Object.keys(CONSULT_LANGUAGE_PACKS) as ConsultLanguage[];
const ACKNOWLEDGEMENT_IDS: readonly string[] = ZKAPI_RISK_ACKNOWLEDGEMENTS.map((entry) => entry.id);

/** Every statement accepted at the current version: the same rule the transport sends by. */
function acknowledgementsCurrent(acknowledgements: { version: number; accepted: readonly string[] } | undefined): boolean {
  return acknowledgements?.version === ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION
    && ACKNOWLEDGEMENT_IDS.every((id) => acknowledgements.accepted.includes(id));
}

const MESSAGES = {
  needsRevision: 'This change needs the settings revision the page was built from. Reload the page and try again.',
  conflict: 'Anonymous answers were changed somewhere else since this page loaded. Reload the page to see the current setting.',
  invalidCurrent: 'The outside-help settings file on this computer is damaged. Choose Replace the file to write a fresh one.',
  routeMissing: 'Add zkAPI before turning anonymous answers on.',
  acknowledgementsIncomplete: 'Accept the statements on this page before turning anonymous answers on.',
  levelUnknown: 'Choose what zkAPI may send: Standard or Strict.',
  levelSaved: 'Saved.',
  levelSavedPaused: 'Saved. Anonymous answers stay paused until you accept the statements on this page.',
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
  policyUncertain: 'Olympus could not confirm whether your privacy policy file changed. Reload the page to see the current state.',
  routeExists: 'A zkAPI route is already configured.',
  tickAll: 'Accept every statement to record your acknowledgement.',
  fundingDate: 'Enter the funding date as YYYY-MM-DD, the day the deposit was confirmed.',
  caps: 'A daily limit must be a whole number of requests, or a positive number of dollars.',
  confirm: 'This action needs your confirmation.',
  noFence: 'There is no held request to recover.',
  otherWallet: 'The held request belongs to another wallet folder. Recover it there, or abandon it.',
  scope: 'Name which held request to abandon.',
  turnedOn: 'Anonymous answers are on. When a private answer in ChatGPT is missing something, Olympus may ask one anonymous question for it.',
  turnedOff: 'Anonymous answers are off. No question is sent.',
  routeSavedRestart: 'Saved. Olympus is restarting its worker to apply the change; this page will refresh.',
  routeSavedNoRestart: 'Saved. Ask your agent to restart the managed Olympus worker to apply it; this worker cannot restart itself.',
  routeAdded: 'The zkAPI route is added. Put the daemon\'s API key in the worker environment file, then finish the steps below.',
  recovered: 'Recovered: the held request settled and consults can run again.',
  recoveryIncomplete: 'The recovery session ran, but settlement was not confirmed. The request is still held; try again later.',
  recoveryFailed: 'The recovery session did not complete. The request is still held.',
  abandoned: 'The held request is marked abandoned. It no longer blocks consults and stays in the ledger as a record.',
  installStarted: 'Installing Tor and zkAPI. This takes a minute or two.',
  installRunning: 'An install is already running.',
  writerSaved: 'Saved. Your model writes the outside questions from now on.',
  writerCleared: 'Saved. The model built into Olympus writes the outside questions again.',
  writerInvalid: 'Enter the address of an OpenAI-compatible server (http:// or https://, usually ending in /v1) and a model name. A key reference is env:NAME or store:name.',
  frontierModelInvalid: 'Enter a zkAPI model name such as provider/model, or leave it empty.',
  writerTestStarted: 'Testing your model on invented cases. Nothing is sent to zkAPI. This can take several minutes.',
  standardSaved: 'Saved how your questions are prepared.',
  standardInvalid: 'Choose one of the three ways, and write an instruction for your own.',
  askStarted: 'Asking anonymously. Starting a private route takes a minute or two.',
  askRunning: 'A question is already on its way. Wait for its answer first.',
  askUnavailable: 'Asking anonymously is not available here.',
  askEmpty: 'Type a question first.',
  writerTestRunning: 'A test is already running.',
  writerTestNoWriter: 'Choose your model and save it first. The test runs on your own model.',
  writerTestUnavailable: 'This Olympus cannot run the test.',
} as const;

/** The card's view of the background install. */
export function dashboardInstallView(state: ManagedToolsJobState): DashboardOutsideHelpInstall {
  switch (state.state) {
    case 'idle':
      return { state: 'idle' };
    case 'running': {
      const label = state.tool === 'tor' ? 'Tor' : 'zkAPI';
      const percent = state.receivedBytes !== undefined && state.totalBytes ? Math.min(100, Math.floor((state.receivedBytes / state.totalBytes) * 100)) : undefined;
      return { state: 'running', tool: label, phase: state.phase, ...(percent !== undefined ? { percent } : {}) };
    }
    case 'done':
      return { state: 'done' };
    case 'failed':
      return { state: 'failed', code: state.code, message: state.message };
  }
}

export function createDashboardConsultAdapter(options: DashboardConsultAdapterOptions): DashboardConsultAdapter {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const statePath = options.statePath ?? defaultZkapiStatePath(env.HOME?.trim() || undefined);
  const location: ConsultSettingsLocation = options.settingsLocation ?? { env };
  const readiness = options.readiness ?? zkapiConsultReadiness;
  const toolsJob = options.toolsJob ?? createManagedToolsJob({ env });
  // Olympus's own verified install first (what the transport runs), else the
  // transport's own fallback resolver: PATH, then the standard install
  // folders (~/.local/bin, Homebrew, /usr/local/bin) under its owner and
  // permission check, so "your system" means a program a consult would run.
  // The same order the transport resolves in (resolveZkapiExecutable): a path
  // set in the route wins and is only that path; then Olympus's install; then PATH and the fallback folders.
  const toolsState = options.toolsState ?? ((): DashboardOutsideHelpTools['tools'] => {
    const settings = transport()?.settings;
    return managedToolsState({ env }).map((entry) => {
      const explicit = entry.tool === 'tor' ? settings?.torExecutable : settings?.daemonExecutable;
      if (explicit) {
        return { tool: entry.tool, label: entry.label, source: resolveExecutable(entry.tool, explicit, env) ? 'configured' : 'configured_missing', path: explicit };
      }
      const system = entry.installed ? undefined : resolveExecutable(entry.tool, undefined, env);
      return {
        tool: entry.tool,
        label: entry.label,
        source: entry.installed ? 'olympus' : system ? 'system' : entry.offered ? 'missing' : 'not_offered',
      };
    });
  });
  let policy = options.sovereignty.config;
  let restartPending = false;
  // The writer check: started only by the owner's click; the last result is kept in memory for the card.
  let writerCheck: DashboardOutsideHelpWriter['check'] = { state: 'idle' };
  // "Ask anonymously": one question at a time; the last result is kept in memory for the card.
  let askState: NonNullable<DashboardOutsideHelpStatus['ask']>['state'] = { state: 'idle' };

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
      level: settings.level,
      ...(read.state === 'invalid' ? { invalidReason: read.reason } : {}),
    };
  };

  const writerView = (): DashboardOutsideHelpWriter => {
    const read = readConsultSettings(location);
    const settings = read.state === 'valid' ? read.settings : undefined;
    const route = zkapiProfile();
    const routeModel = route && 'model' in route.profile && typeof route.profile.model === 'string' ? route.profile.model : undefined;
    return {
      ...(settings?.writer
        ? {
            choice: {
              baseUrl: settings.writer.baseUrl,
              model: settings.writer.model,
              ...(settings.writer.secretRef ? { secretRef: settings.writer.secretRef, keyPresent: options.secretPresent(settings.writer.secretRef) } : {}),
            },
          }
        : {}),
      ...(settings?.chatgptFrontierModel ? { chatgptFrontierModel: settings.chatgptFrontierModel } : {}),
      effectiveChatgptModel: consultChatgptFrontierModel(settings ?? DEFAULT_CONSULT_SETTINGS),
      ...(routeModel ? { routeModel } : {}),
      ...(options.chatgptModelProblem?.() ? { modelProblem: options.chatgptModelProblem()! } : {}),
      testAvailable: options.writerCheck !== undefined,
      check: writerCheck,
    };
  };

  // Choices other forms own, carried through every write unchanged.
  const standardCarried = (base: ConsultSettings) => ({
    ...(base.standardMode ? { standardMode: base.standardMode } : {}),
    ...(base.standardInstruction !== undefined ? { standardInstruction: base.standardInstruction } : {}),
  });
  const writerCarried = (base: ConsultSettings) => ({
    ...(base.writer ? { writer: base.writer } : {}),
    ...(base.chatgptFrontierModel ? { chatgptFrontierModel: base.chatgptFrontierModel } : {}),
    // The model for Anthropic-hosted agents has no card field yet (file only); carried through.
    ...(base.claudeFrontierModel ? { claudeFrontierModel: base.claudeFrontierModel } : {}),
    // A level chosen in conversation (ask_anonymously) stays chosen through every card save.
    ...(base.levelChosen ? { levelChosen: true as const } : {}),
  });
  const carried = (base: ConsultSettings) => ({ ...writerCarried(base), ...standardCarried(base) });

  const standardView = (): NonNullable<DashboardOutsideHelpStatus['standard']> => {
    const read = readConsultSettings(location);
    const settings = read.state === 'valid' ? read.settings : DEFAULT_CONSULT_SETTINGS;
    return {
      mode: consultStandardMode(settings),
      preset: CONSULT_LIGHT_CLEANUP_INSTRUCTION,
      ...(settings.standardInstruction !== undefined ? { instruction: settings.standardInstruction } : {}),
      maxChars: CONSULT_STANDARD_INSTRUCTION_MAX_CHARS,
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
    const complete = acknowledgementsCurrent(acknowledgements);
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
      if (update.current) policy = update.current;
      if (update.reason === 'conflict') return { ok: false, httpStatus: 409, code: 'policy_changed', message: MESSAGES.policyChanged };
      // Something failed after the publish point and the file does not read
      // back as the new policy: the view follows whatever the file holds now.
      if (update.reason === 'uncertain') return { ok: false, httpStatus: 500, code: 'policy_uncertain', message: MESSAGES.policyUncertain };
      return { ok: false, httpStatus: 500, code: 'policy_unreadable', message: MESSAGES.policyUnreadable };
    }
    // Published (even when a step after the rename failed): the policy is live, so it is applied.
    policy = update.config;
    return undefined;
  };

  const invalid = (message: string, code = 'invalid_params'): DashboardConsultOutcome => ({ ok: false, httpStatus: 400, code, message });

  return {
    async installTools(update) {
      if (update.confirm !== true) return invalid(MESSAGES.confirm, 'confirmation_required');
      if (toolsJob.start() === 'running') return { ok: false, httpStatus: 409, code: 'install_running', message: MESSAGES.installRunning };
      return { ok: true, status_message: MESSAGES.installStarted };
    },


    async status() {
      return {
        settings: settingsView(),
        route: await routeView(),
        languages: languages(),
        restartPending,
        tools: { tools: toolsState(), install: dashboardInstallView(toolsJob.progress()) },
        writer: writerView(),
        standard: standardView(),
        ...(options.ask ? { ask: { state: askState, maxChars: CONSULT_ASK_MAX_CHARS } } : {}),
      };
    },

    async saveStandard(update) {
      const revision = update.revision;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return invalid(MESSAGES.needsRevision, 'needs_revision');
      const mode = update.standard_mode;
      if (typeof mode !== 'string' || !(CONSULT_STANDARD_MODES as readonly string[]).includes(mode)) return invalid(MESSAGES.standardInvalid, 'standard_invalid');
      let instruction: string | undefined;
      if (mode === 'custom') {
        const raw = update.standard_instruction;
        if (typeof raw !== 'string' || !raw.trim() || raw.length > CONSULT_STANDARD_INSTRUCTION_MAX_CHARS) return invalid(MESSAGES.standardInvalid, 'standard_invalid');
        instruction = raw.replace(/\r\n?/g, '\n');
      }
      const current = readConsultSettings(location);
      if (current.state === 'invalid') return writeRefusal('invalid_current', 0);
      const base = current.state === 'valid' ? current.settings : DEFAULT_CONSULT_SETTINGS;
      // The writer choices carry; the Standard pair is replaced whole (an
      // instruction stays only with "custom").
      const result = writeConsultSettings({
        ...writerCarried(base),
        enabled: base.enabled,
        languages: [...base.languages],
        domains: { ...base.domains },
        strict: base.strict,
        level: base.level,
        standardMode: mode as ConsultStandardMode,
        ...(instruction !== undefined ? { standardInstruction: instruction } : {}),
        expectedRevision: revision,
      }, location);
      if (!result.ok) return writeRefusal(result.reason, result.current?.state === 'valid' ? result.current.settings.revision : 0);
      return { ok: true, status_message: MESSAGES.standardSaved, revision: result.settings.revision };
    },

    async ask(update) {
      if (!options.ask) return { ok: false, httpStatus: 501, code: 'ask_unavailable', message: MESSAGES.askUnavailable };
      if (askState.state === 'running') return { ok: false, httpStatus: 409, code: 'ask_running', message: MESSAGES.askRunning };
      const question = typeof update.question === 'string' ? update.question.trim() : '';
      if (!question) return invalid(MESSAGES.askEmpty, 'question_empty');
      const runner = options.ask;
      askState = { state: 'running', question };
      void (async () => {
        let result: ConsultAskResult;
        try {
          // The card's own box: the level the card shows, the route's model.
          const read = readConsultSettings(location);
          const level = (read.state === 'valid' ? read.settings : DEFAULT_CONSULT_SETTINGS).level === 'general' ? 'strict' : 'standard';
          result = await runner({ question, level, origin: 'dashboard' });
        } catch {
          result = { ok: false, code: 'internal_error', message: MESSAGES.askUnavailable };
        }
        askState = result.ok
          ? { state: 'done', at: now().toISOString(), question, sent: result.sent, reply: result.reply, route: result.route }
          : { state: 'failed', at: now().toISOString(), question, message: result.message, ...('sent' in result && result.sent !== undefined ? { sent: result.sent } : {}) };
      })();
      return { ok: true, status_message: MESSAGES.askStarted };
    },

    async rememberLevel(choice) {
      const current = readConsultSettings(location);
      if (current.state === 'invalid') return { ok: false, message: 'The anonymous answers settings file could not be read.' };
      const base = current.state === 'valid' ? current.settings : DEFAULT_CONSULT_SETTINGS;
      // A cleanup other than custom replaces the Standard pair; custom (or none) keeps the file's.
      const standard = choice.cleanup !== undefined && choice.cleanup !== 'custom'
        ? { standardMode: choice.cleanup }
        : standardCarried(base);
      const result = writeConsultSettings({
        ...writerCarried(base),
        enabled: base.enabled,
        languages: [...base.languages],
        domains: { ...base.domains },
        strict: base.strict,
        level: choice.level,
        ...standard,
        levelChosen: true,
        expectedRevision: base.revision,
      }, location);
      if (!result.ok) {
        const refusal = writeRefusal(result.reason, result.current?.state === 'valid' ? result.current.settings.revision : 0);
        return { ok: false, message: refusal.ok ? 'The choice could not be saved.' : refusal.message };
      }
      return { ok: true };
    },

    async saveWriter(update) {
      const revision = update.revision;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return invalid(MESSAGES.needsRevision, 'needs_revision');
      const current = readConsultSettings(location);
      if (current.state === 'invalid') return writeRefusal('invalid_current', 0);
      const base = current.state === 'valid' ? current.settings : DEFAULT_CONSULT_SETTINGS;
      // `writer`: null clears it (the built-in model writes); an object sets it.
      let writer: ConsultWriterChoice | undefined = base.writer;
      if (update.writer === null) {
        writer = undefined;
      } else if (update.writer !== undefined) {
        const raw = update.writer;
        if (typeof raw !== 'object' || Array.isArray(raw)) return invalid(MESSAGES.writerInvalid, 'writer_invalid');
        const record = raw as Record<string, unknown>;
        const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
        const baseUrl = text(record.base_url);
        const model = text(record.model);
        const secretRef = text(record.secret_ref);
        const parsed = parseConsultWriterChoice({
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(secretRef !== undefined ? { secretRef } : {}),
          ...(base.writer?.timeoutMs !== undefined ? { timeoutMs: base.writer.timeoutMs } : {}),
        });
        if (!parsed) return invalid(MESSAGES.writerInvalid, 'writer_invalid');
        writer = parsed;
      }
      let chatgptFrontierModel = base.chatgptFrontierModel;
      if (update.chatgpt_frontier_model !== undefined) {
        const raw = update.chatgpt_frontier_model;
        if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
          chatgptFrontierModel = undefined;
        } else if (typeof raw === 'string' && /^\S{1,200}$/.test(raw.trim())) {
          chatgptFrontierModel = raw.trim();
        } else {
          return invalid(MESSAGES.frontierModelInvalid, 'frontier_model_invalid');
        }
      }
      const result = writeConsultSettings({
        enabled: base.enabled,
        languages: [...base.languages],
        domains: { ...base.domains },
        strict: base.strict,
        level: base.level,
        ...(writer ? { writer } : {}),
        ...(chatgptFrontierModel ? { chatgptFrontierModel } : {}),
        ...(base.claudeFrontierModel ? { claudeFrontierModel: base.claudeFrontierModel } : {}),
        ...standardCarried(base),
        ...(base.levelChosen ? { levelChosen: true as const } : {}),
        expectedRevision: revision,
      }, location);
      if (!result.ok) return writeRefusal(result.reason, result.current?.state === 'valid' ? result.current.settings.revision : 0);
      // A new choice makes the last test result stale.
      if (update.writer !== undefined) writerCheck = { state: 'idle' };
      return { ok: true, status_message: writer ? MESSAGES.writerSaved : MESSAGES.writerCleared, revision: result.settings.revision };
    },

    async testWriter(update) {
      if (update.confirm !== true) return invalid(MESSAGES.confirm, 'confirmation_required');
      if (!options.writerCheck) return { ok: false, httpStatus: 501, code: 'writer_test_unavailable', message: MESSAGES.writerTestUnavailable };
      if (writerCheck.state === 'running') return { ok: false, httpStatus: 409, code: 'writer_test_running', message: MESSAGES.writerTestRunning };
      const read = readConsultSettings(location);
      if (read.state !== 'valid' || !read.settings.writer) return { ok: false, httpStatus: 409, code: 'writer_not_chosen', message: MESSAGES.writerTestNoWriter };
      writerCheck = { state: 'running', done: 0, total: 0 };
      const runner = options.writerCheck;
      void (async () => {
        try {
          const report = await runner({ onCase: (_result, index, total) => { writerCheck = { state: 'running', done: index + 1, total }; } });
          writerCheck = { state: 'done', at: now().toISOString(), report };
        } catch (error) {
          writerCheck = { state: 'failed', message: error instanceof Error && error.message ? error.message : MESSAGES.writerTestUnavailable };
        }
      })();
      return { ok: true, status_message: MESSAGES.writerTestStarted };
    },

    async setEnabled(update) {
      const enabled = update.enabled;
      if (typeof enabled !== 'boolean') return invalid('Say whether anonymous answers should be on or off.');
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
      // The level: what the form chose, else the file's own. A file that is
      // being replaced because it is damaged keeps the narrower level unless
      // the owner chose otherwise, so a repair never widens the scope.
      let level: ConsultLevel = current.state === 'invalid' ? CONSULT_LEVEL_FOR_REPAIR : base.level;
      if (update.level !== undefined) {
        if (typeof update.level !== 'string' || !(CONSULT_LEVELS as readonly string[]).includes(update.level)) return invalid(MESSAGES.levelUnknown, 'level_unknown');
        level = update.level as ConsultLevel;
      }
      const acknowledgementsComplete = (): boolean => acknowledgementsCurrent(zkapiProfile()?.profile.zkapi?.acknowledgements);
      // Only turning outside help ON (from off, no file or a damaged file)
      // needs the route, the current statements and installed languages.
      // Keeping it on while choosing a level is never refused: the level is
      // saved, and if the statements are not accepted at the current version
      // the transport sends nothing (zkapiMoneyStatus) and the card says it
      // is paused until they are. The level itself needs no acknowledgement
      // here, for the same reason: no question leaves without them.
      const turningOn = enabled && !(current.state === 'valid' && current.settings.enabled);
      if (turningOn) {
        const route = zkapiProfile();
        if (!route) return { ok: false, httpStatus: 409, code: 'route_not_configured', message: MESSAGES.routeMissing };
        if (!acknowledgementsComplete()) return { ok: false, httpStatus: 409, code: 'acknowledgements_incomplete', message: MESSAGES.acknowledgementsIncomplete };
      }
      if (enabled && (turningOn || update.languages !== undefined)) {
        const installed = new Set(languages().filter((entry) => entry.installed).map((entry) => entry.language));
        if (!chosen.every((language) => installed.has(language))) return invalid(MESSAGES.languageMissing, 'language_pack_missing');
      }
      const result = writeConsultSettings({
        enabled,
        languages: chosen,
        domains: { ...base.domains },
        // Strict mode's approval step is stage C6; until then the flag is only kept as saved.
        strict: base.strict,
        level,
        // The owner's writer choices are not this form's: carried through as they are.
        ...carried(base),
        expectedRevision: revision,
        ...(replaceInvalid ? { replaceInvalid: true } : {}),
      }, location);
      if (result.ok) {
        const paused = enabled && Boolean(zkapiProfile()) && !acknowledgementsComplete();
        const message = update.level !== undefined
          ? paused ? MESSAGES.levelSavedPaused : MESSAGES.levelSaved
          : enabled ? MESSAGES.turnedOn : MESSAGES.turnedOff;
        return { ok: true, status_message: message, revision: result.settings.revision };
      }
      return writeRefusal(result.reason, result.current?.state === 'valid' ? result.current.settings.revision : 0);
    },

    async saveRoute(update) {
      const route = zkapiProfile();
      if (!route) return { ok: false, httpStatus: 409, code: 'route_not_configured', message: MESSAGES.routeMissing };
      // The statements: recorded only when this save accepts them (every one,
      // at the current version). A save without them (the funding date, the
      // limits) leaves the recorded acceptance exactly as it is.
      const acknowledged = update.acknowledged;
      const zkapi: Record<string, unknown> = {};
      const cleared: string[] = [];
      if (acknowledged !== undefined) {
        if (!Array.isArray(acknowledged) || !acknowledged.every((item) => typeof item === 'string')) return invalid(MESSAGES.tickAll, 'acknowledgements_incomplete');
        const accepted = new Set(acknowledged as string[]);
        if (!ACKNOWLEDGEMENT_IDS.every((id) => accepted.has(id))) return invalid(MESSAGES.tickAll, 'acknowledgements_incomplete');
        zkapi.acknowledgements = { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: [...ACKNOWLEDGEMENT_IDS] };
      }
      // The other owned fields of the zkapi block, applied over the block as
      // the file holds it now; `null` clears a cap.
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
