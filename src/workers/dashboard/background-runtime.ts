/**
 * The background lanes, read off the files the lanes themselves write.
 *
 * This is the reading half of the Background page; lane-state.ts is the
 * deciding half and pages/background.ts is the writing half. Everything here
 * opens a file or resolves a path — nothing here composes a sentence for the
 * reader, and nothing here decides whether a lane is stuck.
 *
 * WHERE THE FILES COME FROM. Every retained drain and supervisor writes a
 * `*-current.json` into one directory (the installers' shared REPORT_DIR,
 * /tmp/olympus-source-processing-supervisor by default) and rewrites it on every
 * heartbeat. They share four keys by construction — `updated_at`, `run_state`,
 * `active_phase` and `heartbeat_seq` — because they share the emitProgress
 * pattern. Those four are what this module reads from every lane; the counter
 * key differs per lane and is named in the roster below, verified against the
 * writer rather than assumed from its siblings.
 *
 * WHY A STALE REPORT IS READ RATHER THAN DROPPED. embedding-runtime.ts discards
 * a report older than its freshness window, and is right to: it answers "is the
 * guard running this lane", and a dead guard's last decision says nothing about
 * now. This module answers a different question — "is this lane moving" — and
 * for that, a report claiming `run_state: running` whose `updated_at` stopped
 * twenty minutes ago is not noise to be discarded. It is THE evidence: it is
 * precisely the shape of "78% embedded and I have no idea if it's stuck". So the
 * report is read whatever its age, the age travels with it, and lane-state.ts
 * decides what the pair means.
 *
 * WHY SAMPLES ARE KEPT IN MEMORY. A rate needs two readings and one render sees
 * one file. The counters in these reports are cumulative-per-process with no
 * denominator and no start stamp, so there is nothing in a single read to divide
 * by. The store below therefore keeps a small trailing ring per lane, appended
 * as the page is rendered (the dashboard re-polls every 15s, so a window fills
 * in about a minute). It is deliberately NOT persisted: a worker restart losing
 * its samples costs the reader one line reading "rate not measured yet", which
 * is true, where a persisted counter from a previous process would be a slope
 * across a gap nobody observed. Duplicate heartbeats are collapsed on the way
 * in, so re-reading a frozen report can never manufacture a window.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMBEDDING_DRAIN_REPORT_DIR_ENV,
  EMBEDDING_DRAIN_REPORT_PATH_ENV,
  resolveGuardReportPath,
} from './embedding-runtime.ts';
import {
  LANE_RATE_WINDOW_MS,
  type DashboardLaneCounterSample,
  type DashboardLaneGoverningCondition,
} from './lane-state.ts';

/** The drain installers' shared REPORT_DIR default. */
const REPORT_DIR_DEFAULT = '/tmp/olympus-source-processing-supervisor';

/** Who to name when quoting the guard's own words. */
const GUARD_NAME = 'the overnight guard';

/** How many samples a lane keeps. At a 15s poll this is about 20 minutes. */
const SAMPLE_RING_LIMIT = 80;

/**
 * One lane's report file and how to read it.
 *
 * `counterKey` is the cumulative counter a rate is measured from, and every one
 * below was read off the writer's own report type rather than inferred from a
 * sibling lane: chunks_embedded (scripts/source-embedding-drain.ts) and
 * summary.terminal_progress_jobs (source-processing-supervisor.ts).
 *
 * `livePhases` likewise: each drain publishes its OWN phase vocabulary, and the
 * embedding lane's tuple famously does not contain `syncing`. Copying one
 * lane's phases onto another reports a busy lane as idle, so each roster entry
 * carries the phases its own writer can emit, minus `complete` (a finished pass
 * is not a running lane) and minus `paused`.
 */
interface LaneReportSpec {
  id: string;
  name: string;
  /** The lane's own plural unit, used verbatim in the rate line. */
  unit: string;
  file: string;
  /** Dotted path to the cumulative counter; absent means no rate is claimed. */
  counterKey?: string;
  /** Dotted path to the work still outstanding, where the report carries one. */
  remainingKey?: string;
  livePhases: readonly string[];
  /**
   * The systemd unit the guard names when it parks this lane, so the guard's
   * own park line can be matched to it. Absent means the guard does not
   * arbitrate this lane and no park line will ever be attributed to it.
   */
  guardUnit?: string;
}

const LANE_REPORTS: readonly LaneReportSpec[] = [
  {
    id: 'embedding-drain',
    name: 'Embedding drain',
    unit: 'chunks',
    file: 'source-embedding-drain-current.json',
    counterKey: 'chunks_embedded',
    livePhases: ['starting', 'embedding', 'sleeping', 'backoff'],
    guardUnit: 'olympus-source-embedding-drain.service',
  },
  {
    id: 'processing-supervisor',
    name: 'Source processing',
    unit: 'jobs',
    file: 'current.json',
    counterKey: 'summary.terminal_progress_jobs',
    remainingKey: 'summary.queued_after',
    // `paused` and `complete` are both absent: the first is the provider-pause
    // state, which is a WAITING reason and not work, and the second is a pass
    // that ended.
    livePhases: ['starting', 'status_before', 'planning', 'extracting', 'embedding', 'status_after'],
  },
  {
    id: 'whatsapp-transcribe-drain',
    name: 'Transcription',
    unit: 'items',
    file: 'whatsapp-transcribe-drain-current.json',
    // No counter and no rate, deliberately. This lane's report path is declared
    // by its installer, but NO writer in this repository publishes its shape, so
    // the four family keys are read (they are the family's construction, not a
    // guess about this file) and no counter name is invented for it. A lane that
    // renders its state and admits it cannot measure a rate is honest; one that
    // reads a key nobody writes would render a confident zero.
    livePhases: ['starting', 'syncing', 'sleeping', 'backoff', 'transcribing'],
  },
];

/* ----------------------------------------------------------------- paths -- */

/** The directory every lane report lands in, resolved the installers' way. */
export function resolveLaneReportDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = env[EMBEDDING_DRAIN_REPORT_DIR_ENV]?.trim();
  if (explicit) return explicit;
  // The embedding lane alone may be pointed at a full path; when it is, its
  // directory is where the sibling reports live too.
  const explicitFile = env[EMBEDDING_DRAIN_REPORT_PATH_ENV]?.trim();
  if (explicitFile) {
    const cut = explicitFile.lastIndexOf('/');
    if (cut > 0) return explicitFile.slice(0, cut);
  }
  return REPORT_DIR_DEFAULT;
}

/* --------------------------------------------------------------- reading -- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // Absent, unreadable, or not JSON. All three mean the same to the reader —
    // this lane is not reporting — and none is worth a throw on a render path.
    return undefined;
  }
}

/** A dotted path into a report, e.g. `summary.terminal_progress_jobs`. */
function readNumber(record: Record<string, unknown>, path: string): number | undefined {
  let cursor: unknown = record;
  for (const segment of path.split('.')) {
    const step = asRecord(cursor);
    if (step === undefined) return undefined;
    cursor = step[segment];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
}

function readStamp(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at) : undefined;
}

/* ---------------------------------------------------------- sample store -- */

/**
 * The trailing counter samples for every lane, kept for as long as a rate
 * window needs them and no longer.
 *
 * Injectable rather than a module global reached directly, so a test can seed a
 * window in one call and two tests can never contaminate each other.
 */
export class LaneSampleStore {
  private readonly rings = new Map<string, DashboardLaneCounterSample[]>();

  /**
   * Record one reading and return the trailing window for this lane.
   *
   * A sample whose heartbeat sequence matches the last one held is the same
   * report read a second time; its stamp replaces nothing and it is dropped, so
   * a page polling a frozen report cannot invent observations from it.
   */
  record(id: string, sample: DashboardLaneCounterSample, now: Date): readonly DashboardLaneCounterSample[] {
    const ring = this.rings.get(id) ?? [];
    const last = ring[ring.length - 1];
    const duplicate = last !== undefined
      && ((sample.heartbeatSeq !== undefined && last.heartbeatSeq === sample.heartbeatSeq)
        || last.at.getTime() === sample.at.getTime());
    if (!duplicate) ring.push(sample);
    const cutoff = now.getTime() - LANE_RATE_WINDOW_MS;
    // One sample older than the window is kept when it is the only history
    // there is, so a lane whose counter froze still has a pair to measure zero
    // across rather than falling back to "not measured".
    const kept = ring.filter((held, index) => held.at.getTime() >= cutoff || index === ring.length - 1);
    const trimmed = kept.length > SAMPLE_RING_LIMIT ? kept.slice(kept.length - SAMPLE_RING_LIMIT) : kept;
    this.rings.set(id, trimmed);
    return trimmed;
  }

  /** The window held for a lane, without recording anything. */
  samples(id: string): readonly DashboardLaneCounterSample[] {
    return this.rings.get(id) ?? [];
  }
}

/** The process-wide store the worker's render path appends to. */
export const backgroundLaneSampleStore = new LaneSampleStore();

/* ------------------------------------------------------------- arbiters -- */

/**
 * What the guard decided this tick, per unit it named.
 *
 * The guard's park lines are `paused <unit>: <reason>` — the reason lives ONLY
 * in the actions list, as embedding-runtime.ts already documents; no report key
 * carries it. So the reason is quoted from the line rather than re-derived, and
 * a line whose shape does not match is left alone rather than half-parsed.
 */
export interface GuardArbitration {
  at?: Date;
  /** unit name → the guard's own reason for parking it. */
  parked: ReadonlyMap<string, string>;
  /** metadata_window_reason, when the window is open. */
  metadataWindowReason?: string;
  /** writer_drains_parked_without_window. */
  writerDrainsParked: boolean;
  /** The guard's action lines, verbatim, for the diagnostics line. */
  actions: readonly string[];
}

const PARK_LINE = /^paused\s+([^\s:]+):\s*(.+)$/;

export function readGuardArbitration(path: string): GuardArbitration | undefined {
  const record = readJsonFile(path);
  if (record === undefined) return undefined;
  const actions = Array.isArray(record.actions)
    ? record.actions.filter((line): line is string => typeof line === 'string')
    : [];
  const parked = new Map<string, string>();
  for (const line of actions) {
    const match = PARK_LINE.exec(line);
    if (match === null) continue;
    parked.set(match[1]!, match[2]!.trim());
  }
  const at = readStamp(record.finished_at) ?? readStamp(record.started_at);
  const windowActive = record.metadata_window_active === true;
  const windowReason = typeof record.metadata_window_reason === 'string'
    ? record.metadata_window_reason
    : undefined;
  return {
    ...(at === undefined ? {} : { at }),
    parked,
    ...(windowActive && windowReason !== undefined ? { metadataWindowReason: windowReason } : {}),
    writerDrainsParked: record.writer_drains_parked_without_window === true,
    actions,
  };
}

/**
 * The governing condition for one lane, if any arbiter published one.
 *
 * Order is specificity, not preference: a park line naming this unit says
 * exactly why THIS lane stopped, the metadata window says why the writer lanes
 * as a group stopped, and the parked-without-window flag is the guard's own
 * "something else owns the machine". The first that applies is the one quoted.
 */
function guardGoverning(
  spec: LaneReportSpec,
  guard: GuardArbitration | undefined,
): DashboardLaneGoverningCondition | undefined {
  if (guard === undefined || spec.guardUnit === undefined) return undefined;
  const at = guard.at === undefined ? {} : { at: guard.at };
  const parked = guard.parked.get(spec.guardUnit);
  if (parked !== undefined) return { text: parked, decidedBy: GUARD_NAME, ...at };
  if (guard.metadataWindowReason !== undefined) {
    return {
      text: `Dropbox metadata sync has priority (${guard.metadataWindowReason})`,
      decidedBy: GUARD_NAME,
      ...at,
    };
  }
  if (guard.writerDrainsParked) {
    return {
      text: 'writer drains parked: the source-processing supervisors own the machine',
      decidedBy: GUARD_NAME,
      ...at,
    };
  }
  return undefined;
}

/**
 * A provider pause the supervisor recorded, which is that lane's own arbiter.
 *
 * `message` is the supervisor's already-written sentence; `reason` is its
 * token. The message is preferred and the token is the fallback, so the reader
 * gets prose where prose exists and a real word where it does not.
 */
function providerPauseGoverning(
  record: Record<string, unknown>,
): DashboardLaneGoverningCondition | undefined {
  const pause = asRecord(record.provider_pause);
  if (pause === undefined || pause.active !== true) return undefined;
  const message = typeof pause.message === 'string' && pause.message.trim() !== ''
    ? pause.message.trim()
    : undefined;
  const reason = typeof pause.reason === 'string' && pause.reason.trim() !== ''
    ? pause.reason.trim()
    : undefined;
  const text = message ?? reason;
  if (text === undefined) return undefined;
  return {
    text,
    decidedBy: 'the source-processing supervisor',
    ...(readStamp(pause.created_at) === undefined ? {} : { at: readStamp(pause.created_at)! }),
  };
}

/* ------------------------------------------------------------ assembly -- */

/** One lane, as read. Nothing here is a sentence and nothing is a verdict. */
export interface BackgroundLaneRuntime {
  id: string;
  name: string;
  unit: string;
  /** The lane's own report says it is up and in a working phase. */
  reportsLive: boolean;
  /** The report's `updated_at` — the lane's heartbeat, not our clock. */
  lastActivityAt?: Date;
  /** The trailing counter window for this lane. */
  samples: readonly DashboardLaneCounterSample[];
  /** Outstanding work, only where the report publishes a real remainder. */
  remaining?: number;
  /** Why this lane is not moving, in its arbiter's words. */
  governing?: DashboardLaneGoverningCondition;
  /** The phase word the report published, e.g. "embedding". */
  phase?: string;
}

export interface BackgroundRuntimeFacts {
  lanes: readonly BackgroundLaneRuntime[];
  /** The guard's own action lines this tick, for the diagnostics line. */
  guardActions: readonly string[];
  guardAt?: Date;
}

export interface BackgroundRuntimeOptions {
  env?: Record<string, string | undefined>;
  now?: Date;
  /** Injected by tests; defaults to the process-wide store. */
  sampleStore?: LaneSampleStore;
}

/**
 * Every lane that is reporting, with its evidence attached.
 *
 * A lane whose report file is absent or unreadable is NOT in the returned list:
 * absent means "this host does not run that lane", and a row reading zero for a
 * lane that was never installed is the same lie as a percentage with no verb.
 */
export function readBackgroundRuntime(options: BackgroundRuntimeOptions = {}): BackgroundRuntimeFacts {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const store = options.sampleStore ?? backgroundLaneSampleStore;
  const dir = resolveLaneReportDir(env);
  const guard = readGuardArbitration(resolveGuardReportPath(env));
  const lanes: BackgroundLaneRuntime[] = [];
  for (const spec of LANE_REPORTS) {
    const record = readJsonFile(join(dir, spec.file));
    if (record === undefined) continue;
    const updatedAt = readStamp(record.updated_at) ?? readStamp(record.generated_at);
    const phase = typeof record.active_phase === 'string' ? record.active_phase : undefined;
    const heartbeatSeq = typeof record.heartbeat_seq === 'number' && Number.isFinite(record.heartbeat_seq)
      ? record.heartbeat_seq
      : undefined;
    const counter = spec.counterKey === undefined ? undefined : readNumber(record, spec.counterKey);
    const samples = counter === undefined || updatedAt === undefined
      ? store.samples(spec.id)
      : store.record(spec.id, {
        at: updatedAt,
        count: counter,
        ...(heartbeatSeq === undefined ? {} : { heartbeatSeq }),
      }, now);
    const remaining = spec.remainingKey === undefined ? undefined : readNumber(record, spec.remainingKey);
    const governing = providerPauseGoverning(record) ?? guardGoverning(spec, guard);
    lanes.push({
      id: spec.id,
      name: spec.name,
      unit: spec.unit,
      reportsLive: record.run_state === 'running'
        && phase !== undefined
        && spec.livePhases.includes(phase),
      ...(updatedAt === undefined ? {} : { lastActivityAt: updatedAt }),
      samples,
      ...(remaining === undefined ? {} : { remaining }),
      ...(governing === undefined ? {} : { governing }),
      ...(phase === undefined ? {} : { phase }),
    });
  }
  return {
    lanes,
    guardActions: guard?.actions ?? [],
    ...(guard?.at === undefined ? {} : { guardAt: guard.at }),
  };
}
