/**
 * What the embedding lane is doing, when it is supposed to run, what model it
 * runs, and the one control that changes it.
 *
 * The owner's complaint this answers: "I didn't know the embeddings were off,
 * and I don't know when they're supposed to be running." Every line below is
 * read off a file the worker can actually open — never inferred from a clock
 * this process keeps on its own.
 *
 * WHO DECIDES WHETHER EMBEDDING RUNS. Not this worker, and not the embedding
 * unit itself. olympus-source-embedding-drain.service is a Restart=always
 * service with no timer of its own; the overnight source-drain guard
 * (scripts/ops/install-private-host-overnight-source-drain-guard-systemd.sh) starts and
 * stops it. So the honest answer to "is embedding running" is the guard's
 * answer plus the drain's own report, and this module reads both rather than
 * second-guessing either.
 *
 * THERE IS NO NIGHT WINDOW. "Overnight" is the guard unit's NAME and nothing
 * more: the script contains no time-of-day logic anywhere — no hour comparison,
 * no window-start/window-end variable, no OnCalendar. What it actually
 * arbitrates on is a DATA condition it calls the metadata window: while Dropbox
 * metadata sync is behind, the source-processing supervisors own the machine and
 * the writer drains (embedding among them) are parked; once the metadata
 * frontier is clear the guard starts them again (installer L980, the one
 * steady-state branch that starts this unit). A page promising "runs tonight"
 * would be inventing a schedule the system does not have, so this module states
 * the condition instead of a clock.
 *
 * WHY FILES AND NOT `systemctl is-active`. There is no precedent anywhere in
 * this worker's request path for shelling out to systemd — the only systemctl
 * strings in src/ are in core/worker-service.ts, which builds install commands
 * for a human to run and never executes one to answer a page. Adding a process
 * spawn to a route that re-renders on every dashboard poll would buy one line of
 * text at the price of a new timeout and a new failure mode. The guard's state
 * directory and the drain's report are same-user readable, cheap, and closer to
 * the truth: they are what the guard decided and what the drain is doing, not
 * what a unit happened to look like between ticks.
 *
 * WHAT IS NOT CLAIMED. When neither report is readable and recent, the state is
 * `unknown` and the page says exactly that. A fabricated "running" is worse than
 * an admitted blank: the owner already lost trust once by not being told
 * embedding was off, and a confident wrong answer is how that happens twice.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The tokens the guard honors, verbatim from its header: "embedding-priority
 * parks source-processing supervisors and keeps both writer drains running;
 * paused makes the guard take no arbitration actions."
 */
export const EMBEDDING_PRIORITY_TOKEN = 'embedding-priority';
export const GUARD_PAUSED_TOKEN = 'paused';

export const GUARD_STATE_DIR_ENV = 'OLYMPUS_OVERNIGHT_SOURCE_DRAIN_GUARD_STATE_DIR';
export const GUARD_OVERRIDE_PATH_ENV = 'OLYMPUS_OVERNIGHT_SOURCE_DRAIN_GUARD_OPERATOR_OVERRIDE_PATH';
export const EMBEDDING_DRAIN_REPORT_PATH_ENV = 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_REPORT_PATH';
export const EMBEDDING_DRAIN_REPORT_DIR_ENV = 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_REPORT_DIR';

/** The guard's STATE_DIR default, spelled the way the installer spells it. */
const GUARD_STATE_DIR_SEGMENTS = ['.local', 'state', 'olympus', 'overnight-source-drain-guard'] as const;

/** The drain installer's REPORT_DIR default. */
const EMBEDDING_DRAIN_REPORT_DIR_DEFAULT = '/tmp/olympus-source-processing-supervisor';

/**
 * How stale the guard's report may be and still describe "now".
 *
 * The timer is OnUnitInactiveSec=1min on a oneshot service, so the next tick
 * starts a minute after the last one FINISHED — the report's real cadence is a
 * minute plus however long a run takes, not a fixed one-minute grid. Five
 * minutes absorbs a slow run without ever letting a dead guard's last word
 * masquerade as current state.
 */
export const GUARD_REPORT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * How stale the drain's own report may be and still count as live.
 *
 * 300s, matching the freshness the guard applies to the sibling sync drain's
 * report. Deliberately a constant rather than a read of the guard's
 * ..._SYNC_DRAIN_REPORT_STALE_SECONDS: that variable is named for the sync lane,
 * and borrowing it would tie this lane's honesty to a knob meant for another.
 */
export const DRAIN_REPORT_MAX_AGE_MS = 300 * 1000;

/** A report stamped in the future by more than this is a clock fault, not news. */
const REPORT_MAX_FUTURE_SKEW_MS = 60 * 1000;

/**
 * The phases in which the embedding drain is up and working the lane.
 *
 * Not copied from the guard's sync-drain tuple, which lists `syncing` — a phase
 * the embedding drain never emits. Copying it verbatim would have reported a
 * busy embedding drain as idle. These are the drain's own live phases;
 * `complete` is absent because a finished pass is not a running lane.
 */
const LIVE_DRAIN_PHASES: readonly string[] = ['starting', 'embedding', 'sleeping', 'backoff'];

/** What the operator override file says, as a closed vocabulary. */
export type EmbeddingOperatorOverride =
  /** `embedding-priority`: supervisors parked, both writer drains kept running. */
  | 'embedding_priority'
  /** `paused`: the guard takes no arbitration action at all. */
  | 'guard_paused'
  /** Absent or empty: normal arbitration, which is the ordinary state. */
  | 'none'
  /**
   * A token the guard does not recognise. The guard logs it and falls back to
   * normal arbitration, so it is not an instruction — but it is not nothing
   * either, because someone meant it to be one.
   */
  | 'unknown_token'
  /** The file is there and could not be read. */
  | 'unreadable';

/**
 * The state the owner is asking about.
 *
 * `unknown` is a real member of this set rather than an error case: it is what
 * renders whenever nothing recent enough to quote is on disk.
 */
export type EmbeddingRunState =
  /** The override is forcing the lane to run. */
  | 'operator_priority'
  /** The drain's own report says it is up and working. */
  | 'running'
  /** The guard reports the writer lane parked. */
  | 'parked'
  /** The override told the guard to stop arbitrating entirely. */
  | 'guard_paused'
  /** Nothing readable and recent says either way. */
  | 'unknown';

export interface EmbeddingModelLine {
  /** The model name shown to the reader. */
  name: string;
  /**
   * True when the name came back from the router's /v1/models just now; false
   * when the router was unreachable and this is the configured name.
   */
  live: boolean;
  /** The router's backing model for this profile, when it reports one. */
  backendModel?: string;
  /** True when the configured provider runs on this machine. */
  local: boolean;
  /** The whole line, already written: "name · local (Delphi router)". */
  text: string;
}

export interface EmbeddingRuntimeFacts {
  state: EmbeddingRunState;
  /** The state sentence, already written for the reader. */
  stateLine: string;
  /** What actually governs when this lane runs. Never a clock. */
  scheduleLine: string;
  model?: EmbeddingModelLine;
  /** True when the operator-priority override is in force right now. */
  overrideOn: boolean;
  /** What the override file says, for the toggle and for an odd-token warning. */
  override: EmbeddingOperatorOverride;
  /** The path the toggle writes, so the owner can find it by hand. */
  overridePath: string;
}

/** The guard's report, reduced to what this page can honestly use. */
export interface GuardReportFacts {
  /** finished_at, falling back to started_at. */
  generatedAt: Date;
  /** metadata_window_active: Dropbox metadata sync currently owns the lane. */
  metadataWindowActive?: boolean;
  /** metadata_window_reason, e.g. dropbox_metadata_stale. */
  metadataWindowReason?: string;
  /** writer_drains_parked_without_window. */
  writerDrainsParked?: boolean;
  /** The guard's own action lines, which name the unit it parked and why. */
  actions: readonly string[];
}

/** The drain's own report, reduced the same way. */
export interface DrainReportFacts {
  /** updated_at, falling back to generated_at. */
  updatedAt: Date;
  runState?: string;
  activePhase?: string;
  chunksEmbedded?: number;
}

export interface EmbeddingRuntimeOptions {
  env?: Record<string, string | undefined>;
  now?: Date;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Bound so a hung router can never hold a page render open. */
  routerTimeoutMs?: number;
}

/* ---------------------------------------------------------------- paths -- */

function guardStateDir(env: Record<string, string | undefined>): string {
  const configured = env[GUARD_STATE_DIR_ENV]?.trim();
  if (configured) return configured;
  return join(env.HOME?.trim() || homedir(), ...GUARD_STATE_DIR_SEGMENTS);
}

/**
 * Where the override file lives, resolved exactly the way the guard resolves
 * it, so the two can never disagree about which file is the control.
 *
 * The guard's precedence (installer L11 and L22) is: the explicit path variable
 * wins; otherwise `operator-override` inside STATE_DIR; otherwise STATE_DIR's
 * own default under $HOME. This function is the single source of truth on this
 * side — the page and the write route both call it, and neither spells the path
 * out again.
 */
export function resolveEmbeddingOverridePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env[GUARD_OVERRIDE_PATH_ENV]?.trim();
  if (explicit) return explicit;
  return join(guardStateDir(env), 'operator-override');
}

/** The guard's report, on the same state dir the override resolves against. */
export function resolveGuardReportPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(guardStateDir(env), 'latest.json');
}

/** The embedding drain's own report, resolved the way its installer does. */
export function resolveEmbeddingDrainReportPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env[EMBEDDING_DRAIN_REPORT_PATH_ENV]?.trim();
  if (explicit) return explicit;
  const dir = env[EMBEDDING_DRAIN_REPORT_DIR_ENV]?.trim() || EMBEDDING_DRAIN_REPORT_DIR_DEFAULT;
  return join(dir, 'source-embedding-drain-current.json');
}

/* ------------------------------------------------------------- override -- */

/**
 * What the override file says right now.
 *
 * Trimmed the way the GUARD trims it and no more: the guard reads the file
 * through `tr -d '\r\n'`, so it strips line endings and nothing else, and
 * " embedding-priority" is a token it does NOT honor. Trimming spaces here
 * would make the page report an override the guard is ignoring — the page would
 * say the lane is prioritized while the machine carried on arbitrating
 * normally. The stricter read keeps the two in step.
 */
export function readEmbeddingOperatorOverride(path: string): EmbeddingOperatorOverride {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // Absent is the ordinary state — the guard treats a missing file as normal
    // arbitration — so it must never read as a fault.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'none';
    return 'unreadable';
  }
  const token = raw.replace(/[\r\n]/g, '');
  if (token === '') return 'none';
  if (token === EMBEDDING_PRIORITY_TOKEN) return 'embedding_priority';
  if (token === GUARD_PAUSED_TOKEN) return 'guard_paused';
  return 'unknown_token';
}

/**
 * Turn the override on or off.
 *
 * ON writes the one token the guard honors, with the trailing newline the guard
 * strips anyway. OFF removes the file rather than blanking it: "absent" is the
 * guard's documented word for normal arbitration, and an empty file would be a
 * second spelling of the same thing that every later reader has to know about.
 */
export function writeEmbeddingOperatorOverride(path: string, on: boolean): void {
  if (!on) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${EMBEDDING_PRIORITY_TOKEN}\n`, 'utf8');
}

/* -------------------------------------------------------------- reports -- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asStamp(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at) : undefined;
}

function fresh(at: Date, now: Date, maxAgeMs: number): boolean {
  const age = now.getTime() - at.getTime();
  return age <= maxAgeMs && age >= -REPORT_MAX_FUTURE_SKEW_MS;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * The guard's last report, when it is recent enough to describe the present.
 *
 * A stale report yields undefined rather than its contents: the guard rewrites
 * this file every tick, so an old one means the guard stopped and its final
 * decision says nothing about now. Note that an operator override makes the
 * guard exit BEFORE the report is written, so the file legitimately freezes
 * while the toggle is on — which is why the override file, not this report, is
 * what the state derivation consults first.
 */
export function readGuardReport(path: string, now: Date): GuardReportFacts | undefined {
  const record = readJsonFile(path);
  if (record === undefined) return undefined;
  const generatedAt = asStamp(record.finished_at) ?? asStamp(record.started_at);
  if (generatedAt === undefined || !fresh(generatedAt, now, GUARD_REPORT_MAX_AGE_MS)) return undefined;
  const actions = Array.isArray(record.actions)
    ? record.actions.filter((line): line is string => typeof line === 'string')
    : [];
  return {
    generatedAt,
    ...(typeof record.metadata_window_active === 'boolean'
      ? { metadataWindowActive: record.metadata_window_active }
      : {}),
    ...(typeof record.metadata_window_reason === 'string'
      ? { metadataWindowReason: record.metadata_window_reason }
      : {}),
    ...(typeof record.writer_drains_parked_without_window === 'boolean'
      ? { writerDrainsParked: record.writer_drains_parked_without_window }
      : {}),
    actions,
  };
}

/**
 * The embedding drain's own report, when it is recent enough to count.
 *
 * Freshness is applied here rather than at the call site so a stopped drain can
 * never be read as a running one: the drain writes this file as it works, and a
 * file that stopped moving is a lane that stopped working.
 */
export function readEmbeddingDrainReport(path: string, now: Date): DrainReportFacts | undefined {
  const record = readJsonFile(path);
  if (record === undefined) return undefined;
  const updatedAt = asStamp(record.updated_at) ?? asStamp(record.generated_at);
  if (updatedAt === undefined || !fresh(updatedAt, now, DRAIN_REPORT_MAX_AGE_MS)) return undefined;
  return {
    updatedAt,
    ...(typeof record.run_state === 'string' ? { runState: record.run_state } : {}),
    ...(typeof record.active_phase === 'string' ? { activePhase: record.active_phase } : {}),
    ...(typeof record.chunks_embedded === 'number' && Number.isFinite(record.chunks_embedded)
      ? { chunksEmbedded: record.chunks_embedded }
      : {}),
  };
}

/** True when a fresh drain report describes a lane that is up and working. */
export function drainReportIsLive(report: DrainReportFacts | undefined): boolean {
  if (report === undefined) return false;
  if (report.runState !== 'running') return false;
  return report.activePhase !== undefined && LIVE_DRAIN_PHASES.includes(report.activePhase);
}

/* ---------------------------------------------------------- derivation -- */

/**
 * The sentence describing what governs this lane. Stated once, the same way in
 * every state, because the owner's second question — "when are they supposed to
 * be running?" — has one answer and it is not a time.
 */
const SCHEDULE_LINE =
  'No fixed hours: the guard re-decides every minute. Embedding runs once Dropbox metadata sync is caught up, and is parked while metadata has priority.';

/**
 * The state, in the order the evidence actually settles it.
 *
 * The override file is consulted first and wins outright, for a mechanical
 * reason rather than a stylistic one: both override tokens make the guard exit
 * before it writes its report, so under an override the guard's report is stale
 * by design and reading it first would report `unknown` for the one state the
 * owner most needs to see.
 */
export function deriveEmbeddingRunState(input: {
  override: EmbeddingOperatorOverride;
  guard: GuardReportFacts | undefined;
  drain: DrainReportFacts | undefined;
}): { state: EmbeddingRunState; stateLine: string } {
  const live = drainReportIsLive(input.drain);
  if (input.override === 'embedding_priority') {
    return {
      state: 'operator_priority',
      stateLine: live
        ? 'Embeddings: running now (operator priority)'
        : 'Embeddings: operator priority is on — the guard keeps this lane running',
    };
  }
  if (input.override === 'guard_paused') {
    // `paused` stops the ARBITER, not the lane: whatever the drain was doing
    // when the guard stopped, it keeps doing. So the drain's own report is the
    // only thing that can say which, and where it says nothing the line refuses
    // to pick one.
    return {
      state: 'guard_paused',
      stateLine: live
        ? 'Embeddings: running now, but the guard is paused — nothing will park or restart this lane'
        : 'Embeddings: off (guard paused) — nothing will start this lane until the pause is lifted',
    };
  }
  if (input.override === 'unreadable') {
    return {
      state: 'unknown',
      stateLine: 'Embeddings: state unknown — the operator override file could not be read',
    };
  }
  // 'none' and 'unknown_token' both mean the guard is arbitrating normally; an
  // unknown token is called out separately in the override warning, not here.
  if (live) {
    const phase = input.drain?.activePhase;
    // "running now (sleeping)" read as a contradiction to the owner
    // (2026-08-24). The drain's idle-wait phases are part of running; say so
    // in words instead of leaking the internal phase name.
    const phaseText = phase === 'embedding'
      ? 'metadata caught up'
      : phase === 'sleeping' || phase === 'backoff'
        ? 'between passes'
        : phase === 'starting'
          ? 'starting up'
          : phase ?? 'up';
    return {
      state: 'running',
      stateLine: `Embeddings: running now (${phaseText})`,
    };
  }
  const guard = input.guard;
  if (guard === undefined) {
    // No fresh drain report AND no fresh guard report: the drain being quiet is
    // consistent with a parked lane and equally consistent with a host where
    // nothing is reporting at all. Refusing to choose is the whole point.
    return {
      state: 'unknown',
      stateLine: 'Embeddings: state unknown — neither the guard nor the drain has reported recently',
    };
  }
  if (guard.metadataWindowActive === true) {
    const reason = guard.metadataWindowReason;
    return {
      state: 'parked',
      stateLine: reason
        ? `Embeddings: parked — Dropbox metadata sync has priority (${reason})`
        : 'Embeddings: parked — Dropbox metadata sync has priority',
    };
  }
  const parkAction = guard.actions.find((line) =>
    line.includes('olympus-source-embedding-drain') && line.startsWith('paused'));
  if (parkAction !== undefined) {
    // The guard's own words for why it stopped this unit, e.g. "metadata
    // frontier pending". The reason lives only in this list — no report key
    // carries it — so it is quoted rather than re-derived.
    const reason = parkAction.split(':').slice(1).join(':').trim();
    return {
      state: 'parked',
      stateLine: reason
        ? `Embeddings: parked by the guard — ${reason}`
        : 'Embeddings: parked by the guard',
    };
  }
  if (guard.writerDrainsParked === true) {
    return {
      state: 'parked',
      stateLine: 'Embeddings: parked — the source-processing supervisors own the machine right now',
    };
  }
  // The guard reported and did not park this lane, but the drain is not
  // reporting either. Something is off, and neither file says what.
  return {
    state: 'unknown',
    stateLine: 'Embeddings: state unknown — the guard has not parked this lane, but the drain is not reporting',
  };
}

/* -------------------------------------------------------------- model -- */

/**
 * The model line, live from the router where possible.
 *
 * The router is the Delphi router on loopback, and its /v1/models carries
 * metadata.backendModel per profile — the live backing model, which is the one
 * fact a configured name cannot supply. When it does not answer, the line falls
 * back to the configured name and says "(configured)" so the reader knows they
 * are looking at intent rather than observation.
 */
export async function readEmbeddingModelLine(
  options: EmbeddingRuntimeOptions = {},
): Promise<EmbeddingModelLine | undefined> {
  const env = options.env ?? process.env;
  const configured = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL?.trim();
  const baseUrl = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL?.trim();
  if (!configured) return undefined;
  // The provider is what makes "local" true or false; the loopback base URL is
  // corroboration, not the claim. A Gemini lane must never be described as
  // running on this machine.
  const local = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER?.trim() === 'local-openai-compatible';
  const fallback: EmbeddingModelLine = {
    name: configured,
    live: false,
    local,
    text: `${configured} · ${where(local)} (configured)`,
  };
  if (!baseUrl) return fallback;
  const backendModel = await fetchBackendModel({
    baseUrl,
    model: configured,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    timeoutMs: options.routerTimeoutMs ?? 1500,
  });
  if (backendModel === undefined) return fallback;
  return {
    name: configured,
    live: true,
    local,
    ...(backendModel === '' ? {} : { backendModel }),
    text: backendModel === '' || backendModel === configured
      ? `${configured} · ${where(local)}`
      : `${configured} · ${where(local)} · backed by ${backendModel}`,
  };
}

function where(local: boolean): string {
  return local ? 'local (Delphi router)' : 'remote provider';
}

/**
 * The router's backing model for the configured id.
 *
 * Returns undefined when the router did not answer usefully (so the caller
 * falls back and says so), and '' when the router answered but named no backing
 * model — a real observation that the lane is live, without a claim about what
 * is behind it.
 */
async function fetchBackendModel(input: {
  baseUrl: string;
  model: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<string | undefined> {
  const url = `${input.baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const response = await input.fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (!response.ok) return undefined;
    const body = asRecord(await response.json());
    const data = body?.data;
    if (!Array.isArray(data)) return undefined;
    const entry = data
      .map((item) => asRecord(item))
      .find((item) => item !== undefined && item.id === input.model);
    if (entry === undefined) return undefined;
    const backendModel = asRecord(entry.metadata)?.backendModel;
    return typeof backendModel === 'string' && backendModel.trim() !== '' ? backendModel.trim() : '';
  } catch {
    // Unreachable, timed out, or not JSON. All three mean the same thing to the
    // reader, and none of them is worth a stack trace on a dashboard render.
    return undefined;
  }
}

/* ------------------------------------------------------------ assembly -- */

/**
 * Everything the Background page needs about this lane, in one read.
 *
 * Every file read here is tolerant and every failure lands on a stated state
 * rather than an exception: this runs inside the dashboard render path, and a
 * missing report must cost the reader a line of text, never the page.
 */
export async function readEmbeddingRuntime(
  options: EmbeddingRuntimeOptions = {},
): Promise<EmbeddingRuntimeFacts> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const overridePath = resolveEmbeddingOverridePath(env);
  const override = readEmbeddingOperatorOverride(overridePath);
  const guard = readGuardReport(resolveGuardReportPath(env), now);
  const drain = readEmbeddingDrainReport(resolveEmbeddingDrainReportPath(env), now);
  const { state, stateLine } = deriveEmbeddingRunState({ override, guard, drain });
  const model = await readEmbeddingModelLine(options);
  return {
    state,
    stateLine,
    scheduleLine: SCHEDULE_LINE,
    ...(model ? { model } : {}),
    overrideOn: override === 'embedding_priority',
    override,
    overridePath,
  };
}
