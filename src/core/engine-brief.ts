/**
 * `olympus engine status --brief`: Olympus's state in a few plain words, for a
 * desktop bar widget (running/stopped, indexing progress, "needs you").
 *
 * The widget runs unsandboxed in the desktop shell and must never see or hold
 * a token. So this command (the owner's own process) may read the worker
 * bearer to ask the worker, but prints nothing except a fixed-shape JSON
 * object: the dashboard's own sentences and a handful of numbers. The words
 * come from the ChatGPT dashboard view model (workers/chatgpt/dashboard-
 * view-model.ts), so the bar and the dashboard never disagree.
 *
 * `engineBriefFromViewModel` (worker side) and `parseEngineBrief` (CLI side)
 * are both whitelists: the worker never sends, and the CLI never prints, a
 * field this file does not name.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { DashboardViewModelV1 } from '../workers/chatgpt/dashboard-contract.ts';
import { configFromPluginConfig, defaultConfig, type OlympusConfig } from './config.ts';
import { enginePaths, inspectEngine, readEngineConfig, type EngineExec } from './engine-service.ts';
import { withWorkerAuthHeader, workerAuthTokenFromConfig } from './worker-auth.ts';

export const ENGINE_BRIEF_SCHEMA = 'olympus.engine.brief.v1';
/** The worker route (under the /v1 API base), behind the worker bearer like every non-health route. */
export const ENGINE_BRIEF_PATH = '/engine/brief';
/** `sentences` carries at most this many; `count` is always the true total. */
export const ENGINE_BRIEF_MAX_SENTENCES = 5;

export interface EngineBriefProgress {
  unit: 'files' | 'messages' | 'items';
  phase: 'initial' | 'refresh';
  percent: number;
  itemsLeft: number;
  /** Only once a rate has been measured. */
  etaSeconds?: number;
  stalled: boolean;
}

export interface EngineBriefNeedsYou {
  count: number;
  sentences: string[];
}

/** What the worker's brief route returns. */
export interface EngineBrief {
  schema: typeof ENGINE_BRIEF_SCHEMA;
  progress: EngineBriefProgress | null;
  blocker: string | null;
  needsYou: EngineBriefNeedsYou;
}

/** The view model's three fields the brief reads; anything else on it is never touched. */
export type EngineBriefViewModel = Pick<DashboardViewModelV1, 'progress' | 'blocker' | 'needsYou'>;

/** Worker side: keep only each item's `sentence` and the progress numbers. */
export function engineBriefFromViewModel(view: EngineBriefViewModel): EngineBrief {
  const items = Array.isArray(view.needsYou) ? view.needsYou : [];
  const sentences = items.flatMap((item) => (typeof item?.sentence === 'string' && item.sentence !== '' ? [item.sentence] : []));
  const progress = view.progress;
  return {
    schema: ENGINE_BRIEF_SCHEMA,
    progress: progress
      ? {
          unit: progress.unit,
          phase: progress.phase,
          percent: progress.percent,
          itemsLeft: progress.itemsLeft,
          ...(typeof progress.etaSeconds === 'number' ? { etaSeconds: progress.etaSeconds } : {}),
          stalled: progress.stalled === true,
        }
      : null,
    blocker: typeof view.blocker?.sentence === 'string' && view.blocker.sentence !== '' ? view.blocker.sentence : null,
    needsYou: { count: sentences.length, sentences: sentences.slice(0, ENGINE_BRIEF_MAX_SENTENCES) },
  };
}

const UNITS: ReadonlySet<unknown> = new Set(['files', 'messages', 'items']);
const PHASES: ReadonlySet<unknown> = new Set(['initial', 'refresh']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** CLI side: re-read a worker answer through the same whitelist; undefined when it is not a brief. */
export function parseEngineBrief(value: unknown): EngineBrief | undefined {
  if (!isRecord(value) || value.schema !== ENGINE_BRIEF_SCHEMA) return undefined;
  let progress: EngineBriefProgress | null = null;
  if (value.progress !== null && value.progress !== undefined) {
    const raw = value.progress;
    if (!isRecord(raw) || !UNITS.has(raw.unit) || !PHASES.has(raw.phase)
      || !finiteNumber(raw.percent) || !finiteNumber(raw.itemsLeft) || typeof raw.stalled !== 'boolean') return undefined;
    progress = {
      unit: raw.unit as EngineBriefProgress['unit'],
      phase: raw.phase as EngineBriefProgress['phase'],
      percent: raw.percent,
      itemsLeft: raw.itemsLeft,
      ...(finiteNumber(raw.etaSeconds) ? { etaSeconds: raw.etaSeconds } : {}),
      stalled: raw.stalled,
    };
  }
  const needs = value.needsYou;
  if (!isRecord(needs) || !Array.isArray(needs.sentences) || !finiteNumber(needs.count)) return undefined;
  const sentences = needs.sentences.filter((item): item is string => typeof item === 'string').slice(0, ENGINE_BRIEF_MAX_SENTENCES);
  return {
    schema: ENGINE_BRIEF_SCHEMA,
    progress,
    blocker: typeof value.blocker === 'string' && value.blocker !== '' ? value.blocker : null,
    needsYou: { count: Math.max(sentences.length, Math.floor(needs.count)), sentences },
  };
}

export type EngineBriefState = 'running' | 'starting' | 'stopped' | 'not_installed' | 'unhealthy';

/** What `olympus engine status --brief` prints. `needsYou` is null when the state could not be read. */
export interface EngineBriefReport {
  schema: typeof ENGINE_BRIEF_SCHEMA;
  state: EngineBriefState;
  progress: EngineBriefProgress | null;
  blocker: string | null;
  needsYou: EngineBriefNeedsYou | null;
  /** A plain sentence, present whenever the state is anything but a fully read `running`. */
  detail?: string;
}

export interface EngineBriefDeps {
  homeDir?: string;
  exec?: EngineExec;
  uid?: number;
  platform?: string;
  env?: Record<string, string | undefined>;
  /** The worker transport; the Linux branch passes its Unix-socket fetch here. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  healthTimeoutMs?: number;
  briefTimeoutMs?: number;
}

/** A host that started this recently is "starting", not "unhealthy", while its worker has not answered. */
const STARTING_GRACE_MS = 180_000;
const DEFAULT_BASE_URL = 'http://127.0.0.1:8010/v1';

const DETAIL = {
  notInstalled: 'Olympus is not installed on this computer.',
  stopped: 'Olympus is stopped.',
  starting: 'Olympus is starting.',
  unhealthy: 'Olympus is running but is not answering. Run olympus engine logs to see why.',
  unknown: 'Olympus could not read its own state.',
  unreadable: 'Olympus is running, but its progress could not be read just now.',
  noAccess: 'Olympus is running, but this command cannot read its progress. Run olympus worker status.',
  tooOld: 'Olympus is running, but this version does not report progress here yet.',
} as const;

function none(state: EngineBriefState, detail: string): EngineBriefReport {
  return { schema: ENGINE_BRIEF_SCHEMA, state, progress: null, blocker: null, needsYou: null, detail };
}

type BriefFetch = { kind: 'ok'; brief: EngineBrief } | { kind: 'failed'; detail: string };

/** Cheap by design: one launchctl read, one health probe and one brief request, the last two at once. */
export async function engineBriefReport(deps: EngineBriefDeps = {}): Promise<EngineBriefReport> {
  try {
    return await readEngineBrief(deps);
  } catch {
    // The widget polls this; it gets an answer in the same shape, never a stack trace.
    return none('unhealthy', DETAIL.unknown);
  }
}

async function readEngineBrief(deps: EngineBriefDeps): Promise<EngineBriefReport> {
  const homeDir = deps.homeDir ?? homedir();
  const env = { ...(deps.env ?? process.env), HOME: homeDir };
  const paths = enginePaths(homeDir);
  const agent = inspectEngine({
    homeDir,
    ...(deps.exec ? { exec: deps.exec } : {}),
    ...(deps.uid !== undefined ? { uid: deps.uid } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
  });
  if (!agent.installed) return none('not_installed', DETAIL.notInstalled);
  if (agent.state === 'not_loaded' || agent.state === 'loaded') return none('stopped', DETAIL.stopped);

  // The agent is running (or its state could not be read): ask the worker.
  let config: OlympusConfig = defaultConfig();
  try {
    const pluginConfig = readEngineConfig(paths.configPath);
    if (pluginConfig) config = configFromPluginConfig(pluginConfig, { requireResolvedWorkerSecrets: false });
  } catch {
    // An unreadable config leaves the defaults; the worker still answers health.
  }
  const baseUrl = config.email.baseUrl || DEFAULT_BASE_URL;
  // The bearer is read here, inside the owner's own process, and only ever sent to the worker.
  const token = workerAuthTokenFromConfig(config, { env, homeDir });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const root = baseUrl.replace(/\/$/, '');
  const [reachable, brief] = await Promise.all([
    probeHealth(fetchImpl, `${root}/health`, deps.healthTimeoutMs ?? 1_000),
    token
      ? fetchBrief(fetchImpl, `${root}${ENGINE_BRIEF_PATH}`, token, deps.briefTimeoutMs ?? 2_500)
      : Promise.resolve<BriefFetch>({ kind: 'failed', detail: DETAIL.noAccess }),
  ]);

  if (!reachable) {
    if (agent.state === 'unknown') return none('unhealthy', DETAIL.unhealthy);
    return startingGraceOver(paths.statusPath, agent.pid, (deps.now ?? Date.now)())
      ? none('unhealthy', DETAIL.unhealthy)
      : none('starting', DETAIL.starting);
  }
  if (brief.kind === 'failed') {
    return { schema: ENGINE_BRIEF_SCHEMA, state: 'running', progress: null, blocker: null, needsYou: null, detail: brief.detail };
  }
  return { schema: ENGINE_BRIEF_SCHEMA, state: 'running', progress: brief.brief.progress, blocker: brief.brief.blocker, needsYou: brief.brief.needsYou };
}

/**
 * True only when the running host's own status file says it started long ago.
 * No file, or a file from an earlier process, means the host has only just
 * launched.
 */
function startingGraceOver(path: string, agentPid: number | null, now: number): boolean {
  try {
    if (!existsSync(path)) return false;
    const status = JSON.parse(readFileSync(path, 'utf8')) as { schema?: unknown; pid?: unknown; started_at?: unknown };
    if (status?.schema !== 'olympus.engine.status.v1' || typeof status.started_at !== 'string') return false;
    if (agentPid !== null && status.pid !== agentPid) return false;
    const started = Date.parse(status.started_at);
    return Number.isFinite(started) && now - started > STARTING_GRACE_MS;
  } catch {
    return false;
  }
}

async function probeHealth(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBrief(fetchImpl: typeof fetch, url: string, token: string, timeoutMs: number): Promise<BriefFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, withWorkerAuthHeader({ method: 'GET', signal: controller.signal }, token));
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'failed', detail: DETAIL.noAccess };
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'failed', detail: DETAIL.tooOld };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'failed', detail: DETAIL.unreadable };
    }
    const parsed = parseEngineBrief(await response.json());
    return parsed ? { kind: 'ok', brief: parsed } : { kind: 'failed', detail: DETAIL.unreadable };
  } catch {
    return { kind: 'failed', detail: DETAIL.unreadable };
  } finally {
    clearTimeout(timer);
  }
}
