/**
 * What a background lane is doing, and — when it is doing nothing — who decided
 * that and why.
 *
 * THE LAW THIS MODULE ENFORCES (owner ruling, 2026-08-24): no lane may be
 * non-moving without a printed reason. The owner's complaint was "78% embedded
 * — I have no idea if it's stuck or moving. Way too often things are just stuck
 * for unknown reasons." A percentage answers neither question: it is a
 * denominator, not a verb. So every lane resolves to exactly one state, and the
 * two states that mean "not moving" are each required to carry something the
 * reader can act on — a governing condition quoted from the arbiter that made
 * it, or the admission that nothing readable says why.
 *
 * WHAT IS NEVER INVENTED HERE. This module composes sentences out of numbers it
 * is handed; it opens no file, keeps no clock of its own, and has no default
 * reason. A lane that is not moving and whose arbiter said nothing renders
 * `unknown` with the words "state unknown" — the same discipline the embedding
 * runtime panel already applies (embedding-runtime.ts), and for the same reason:
 * the owner lost trust once by not being told embedding was off, and a confident
 * wrong answer is how that happens twice.
 *
 * WHY THE RATE IS TRAILING AND NOT AN AVERAGE. A cumulative counter divided by
 * the age of the run answers "how fast was this pass overall", which stays
 * comfortably positive for hours after a lane dies. The owner is asking about
 * NOW, so the rate here is the slope between the oldest and newest samples
 * inside a trailing window, and a lane that stopped moving reports 0 rather than
 * its historical average. Zero is a real, printable rate — it is the number that
 * arms the stuck detector, so it must never be swallowed as "no data".
 */

/** The four states a lane can be in. Every lane renders exactly one. */
export type DashboardLaneStateKind =
  /** Moving: a rate, an ETA where derivable, and a heartbeat. */
  | 'active'
  /** Not moving, and the arbiter's reason is quoted. */
  | 'waiting'
  /** Nothing outstanding. One quiet line. */
  | 'done'
  /** Not moving and nothing readable says why. Renders "state unknown". */
  | 'unknown';

/**
 * One reading of a lane's own cumulative counter.
 *
 * `at` is the REPORT's stamp, never the moment this process read the file: a
 * report that stops being rewritten must produce samples that stop advancing,
 * which is exactly how a dead lane becomes a zero rate instead of a fresh one.
 */
export interface DashboardLaneCounterSample {
  at: Date;
  /** The lane's own cumulative counter, in the lane's units. */
  count: number;
  /**
   * The report's heartbeat sequence, where it publishes one.
   *
   * Two samples with the same sequence are the same report read twice, not two
   * observations, so they are collapsed before any slope is taken.
   */
  heartbeatSeq?: number;
}

export interface DashboardLaneRate {
  /** Units per minute across the window below. Zero is a real answer. */
  perMinute: number;
  /** How much time the two end samples actually span. */
  windowMs: number;
  /** The reader's line, already written: "1,240 chunks/min". */
  text: string;
}

/**
 * Why a lane is not moving, in the words of whatever decided it.
 *
 * `text` is quoted from the arbiter's own report or log line and is never
 * composed here. `decidedBy` names that arbiter, because "parked" with no author
 * is the kind of sentence that sent the owner looking through journals.
 */
export interface DashboardLaneGoverningCondition {
  text: string;
  /** e.g. "the overnight guard", "the scheduler". */
  decidedBy: string;
  /** When the arbiter said it, from the arbiter's own stamp. */
  at?: Date;
}

/**
 * How long a lane may be still, or its heartbeat quiet, before that is news.
 *
 * Both defaults are deliberately longer than the cadence of the thing they
 * watch: the guard ticks about once a minute and the drains rewrite their
 * reports as they work, so a lane crossing these thresholds has missed several
 * of its own beats rather than one.
 */
export const LANE_HEARTBEAT_STALE_AFTER_MS = 5 * 60 * 1000;
export const LANE_STUCK_GRACE_MS = 10 * 60 * 1000;

/**
 * The trailing window a rate is measured over.
 *
 * Wider than the stuck grace on purpose: the rate-zero rule requires a measured
 * span of at least the grace, so a window equal to the grace would make that
 * rule fire only on a knife edge where the oldest sample is exactly at the
 * cutoff. Fifteen minutes leaves the ten-minute span comfortably inside it.
 */
export const LANE_RATE_WINDOW_MS = 15 * 60 * 1000;

/**
 * The shortest span two samples may straddle and still yield a rate.
 *
 * Under this, one report's rounding is a large fraction of the measurement and
 * the "rate" is mostly noise — and a noisy rate printed to the owner is a
 * number they will (rightly) stop believing.
 */
export const LANE_RATE_MIN_WINDOW_MS = 45 * 1000;

/** Everything known about one lane, before any sentence is written about it. */
export interface DashboardLaneEvidence {
  name: string;
  /** The lane's own plural unit: "chunks", "jobs", "items". */
  unit: string;
  /** The lane's own counter over time, oldest first. */
  samples?: readonly DashboardLaneCounterSample[];
  /** When the lane last reported doing anything, from its own heartbeat. */
  lastActivityAt?: Date;
  /** Work outstanding. Absent means unknown, never zero. */
  remaining?: number;
  /** Done over total, only where both halves are real. */
  progress?: { done: number; total: number };
  /** The arbiter's reason this lane is not moving, when there is one. */
  governing?: DashboardLaneGoverningCondition;
  /**
   * True when the lane's OWN report says it is up and working.
   *
   * Distinct from "we saw the counter move": a lane can be up and legitimately
   * between batches. It is also what makes a stale heartbeat a fault — a lane
   * that never claimed to be running is not stuck, it is off.
   */
  reportsLive?: boolean;
  heartbeatStaleAfterMs?: number;
  stuckGraceMs?: number;
}

/** Which mechanical rule found a lane stuck. Never a judgement call. */
export type DashboardLaneStuckKind = 'heartbeat_stale' | 'rate_zero_with_work';

export interface DashboardLaneStuck {
  kind: DashboardLaneStuckKind;
  /** Plain words for the banner: what the reader would say happened. */
  words: string;
  /** The last governing condition, when anything ever said one. */
  lastGoverning?: string;
}

export interface DashboardLaneStatus {
  kind: DashboardLaneStateKind;
  /** The state line, already written for the reader. */
  headline: string;
  rate?: DashboardLaneRate;
  /** Milliseconds of work left, only where a rate and a remainder are real. */
  etaMs?: number;
  /** How long since the lane's own heartbeat moved. */
  sinceActivityMs?: number;
  /**
   * WAITING only: the arbiter's words, verbatim, and who said them — kept apart
   * so a caller can build its own sentence around them without having to unpick
   * one this module already glued together.
   */
  reason?: string;
  reasonBy?: string;
  /** UNKNOWN only: what was looked at and found silent. */
  unknownWhy?: string;
  stuck?: DashboardLaneStuck;
}

/* ------------------------------------------------------------------ rate -- */

/** "1,240" — thousands separated, never scientific, never a bare float. */
function formatRateNumber(perMinute: number): string {
  if (perMinute >= 100) return Math.round(perMinute).toLocaleString('en-US');
  if (perMinute >= 10) return (Math.round(perMinute * 10) / 10).toString();
  return (Math.round(perMinute * 100) / 100).toString();
}

/**
 * Samples reduced to the ones a slope may honestly be taken across.
 *
 * Two things are dropped. A repeated heartbeat sequence is the same report seen
 * twice — counting it as an observation would let a poll loop manufacture a
 * window out of one reading. And a counter that went DOWN is a counter that
 * reset when a new pass started, so everything before the reset is discarded
 * rather than differenced against; the alternative is a negative rate, which
 * would be reported as a lane running backwards.
 */
function usableSamples(
  samples: readonly DashboardLaneCounterSample[],
  now: Date,
  windowMs: number,
): DashboardLaneCounterSample[] {
  const cutoff = now.getTime() - windowMs;
  const inWindow = samples
    .filter((sample) => Number.isFinite(sample.at.getTime()) && Number.isFinite(sample.count))
    // A sample stamped after now is clock skew on the reporting host; it is kept
    // (its own ordering is still meaningful) but never allowed to widen the
    // window backwards past the cutoff.
    .filter((sample) => sample.at.getTime() >= cutoff)
    .slice()
    .sort((left, right) => left.at.getTime() - right.at.getTime());
  const deduped: DashboardLaneCounterSample[] = [];
  for (const sample of inWindow) {
    const previous = deduped[deduped.length - 1];
    if (previous !== undefined
      && sample.heartbeatSeq !== undefined
      && previous.heartbeatSeq === sample.heartbeatSeq) continue;
    if (previous !== undefined && sample.count < previous.count) {
      // Counter reset: this sample starts a new run. Everything before it
      // belongs to a pass that is over.
      deduped.length = 0;
    }
    deduped.push(sample);
  }
  return deduped;
}

/**
 * The trailing rate, or undefined when no honest slope exists yet.
 *
 * Undefined means "not measured", which is a different sentence from zero and
 * is printed as one. Zero means measured and not moving, and that is the number
 * the stuck detector reads.
 */
export function computeLaneRate(
  samples: readonly DashboardLaneCounterSample[] | undefined,
  input: { unit: string; now: Date; windowMs?: number; minWindowMs?: number },
): DashboardLaneRate | undefined {
  if (samples === undefined || samples.length < 2) return undefined;
  const windowMs = input.windowMs ?? LANE_RATE_WINDOW_MS;
  const minWindowMs = input.minWindowMs ?? LANE_RATE_MIN_WINDOW_MS;
  const usable = usableSamples(samples, input.now, windowMs);
  if (usable.length < 2) return undefined;
  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  const spanMs = last.at.getTime() - first.at.getTime();
  if (spanMs < minWindowMs) return undefined;
  const moved = last.count - first.count;
  const perMinute = Math.max(0, moved) / (spanMs / 60_000);
  return {
    perMinute,
    windowMs: spanMs,
    text: `${formatRateNumber(perMinute)} ${input.unit}/min`,
  };
}

/* ----------------------------------------------------------------- state -- */

/** The reason line: the arbiter's own words, with the arbiter named after them. */
export function laneReasonLine(governing: DashboardLaneGoverningCondition): string {
  return `${governing.text} — ${governing.decidedBy}`;
}

/**
 * True when the evidence shows movement.
 *
 * A measured positive rate is movement outright. A lane whose own report says it
 * is live counts as moving only while its heartbeat is fresh — that is what
 * separates "up and between batches" from "up in the sense that a process still
 * exists", which is the exact shape of the owner's stuck lanes.
 */
function isMoving(
  evidence: DashboardLaneEvidence,
  rate: DashboardLaneRate | undefined,
  sinceActivityMs: number | undefined,
  staleAfterMs: number,
): boolean {
  if (rate !== undefined && rate.perMinute > 0) return true;
  if (evidence.reportsLive !== true) return false;
  return sinceActivityMs === undefined || sinceActivityMs <= staleAfterMs;
}

/**
 * Stuck, decided mechanically and never by feel.
 *
 * Two rules, both of which require the lane to be claiming it is working: a
 * heartbeat that stopped while the lane says it is live, and a measured rate of
 * zero while work is outstanding for longer than the grace window. A lane
 * WAITING on a printed condition is excluded from both — a parked lane not
 * moving is the system working as designed, and banner-ing it would train the
 * owner to ignore the banner.
 */
function detectStuck(input: {
  evidence: DashboardLaneEvidence;
  rate: DashboardLaneRate | undefined;
  sinceActivityMs: number | undefined;
  staleAfterMs: number;
  graceMs: number;
  waiting: boolean;
}): DashboardLaneStuck | undefined {
  const { evidence, rate, sinceActivityMs, waiting } = input;
  if (waiting) return undefined;
  const lastGoverning = evidence.governing ? { lastGoverning: laneReasonLine(evidence.governing) } : {};
  if (evidence.reportsLive === true
    && sinceActivityMs !== undefined
    && sinceActivityMs > input.staleAfterMs) {
    return {
      kind: 'heartbeat_stale',
      words: `${evidence.name} says it is running, but it has not reported any activity for `
        + `${Math.round(sinceActivityMs / 60_000)} minutes.`,
      ...lastGoverning,
    };
  }
  const remaining = evidence.remaining;
  if (rate !== undefined
    && rate.perMinute === 0
    && remaining !== undefined
    && remaining > 0
    && rate.windowMs >= input.graceMs) {
    return {
      kind: 'rate_zero_with_work',
      words: `${evidence.name} has ${remaining.toLocaleString('en-US')} ${evidence.unit} left and has `
        + `moved none of them in the last ${Math.round(rate.windowMs / 60_000)} minutes.`,
      ...lastGoverning,
    };
  }
  return undefined;
}

/**
 * The lane's one state, and everything printed alongside it.
 *
 * Resolution order matters and is evidence-shaped rather than stylistic:
 * movement is checked BEFORE the arbiter's condition, because a lane the guard
 * parked a minute ago may still be finishing a batch, and telling the owner it
 * is parked while its counter climbs is the same class of lie as telling them it
 * is running when it is dead.
 */
export function deriveLaneState(evidence: DashboardLaneEvidence, now: Date): DashboardLaneStatus {
  const staleAfterMs = evidence.heartbeatStaleAfterMs ?? LANE_HEARTBEAT_STALE_AFTER_MS;
  const graceMs = evidence.stuckGraceMs ?? LANE_STUCK_GRACE_MS;
  const rate = computeLaneRate(evidence.samples, { unit: evidence.unit, now });
  const sinceActivityMs = evidence.lastActivityAt === undefined
    ? undefined
    : Math.max(0, now.getTime() - evidence.lastActivityAt.getTime());
  const moving = isMoving(evidence, rate, sinceActivityMs, staleAfterMs);
  const remaining = evidence.remaining;

  const common = {
    ...(rate === undefined ? {} : { rate }),
    ...(sinceActivityMs === undefined ? {} : { sinceActivityMs }),
  };

  if (moving) {
    const etaMs = rate !== undefined && rate.perMinute > 0 && remaining !== undefined && remaining > 0
      ? (remaining / rate.perMinute) * 60_000
      : undefined;
    return {
      kind: 'active',
      headline: `${evidence.name}: working now`,
      ...common,
      ...(etaMs === undefined ? {} : { etaMs }),
      ...(stuckOrNothing({ evidence, rate, sinceActivityMs, staleAfterMs, graceMs, waiting: false })),
    };
  }

  // Not moving. From here the law applies: something has to say why.
  if (evidence.governing !== undefined) {
    return {
      kind: 'waiting',
      headline: `${evidence.name}: waiting`,
      reason: evidence.governing.text,
      reasonBy: evidence.governing.decidedBy,
      ...common,
    };
  }

  // Nothing outstanding is its own answer, and a quiet one. It is checked after
  // the arbiter so a lane parked at zero still says who parked it.
  if (remaining === 0) {
    return {
      kind: 'done',
      headline: `${evidence.name}: nothing waiting`,
      ...common,
    };
  }

  const status: DashboardLaneStatus = {
    kind: 'unknown',
    headline: `${evidence.name}: state unknown`,
    unknownWhy: unknownWhy(evidence, rate),
    ...common,
    ...(stuckOrNothing({ evidence, rate, sinceActivityMs, staleAfterMs, graceMs, waiting: false })),
  };
  return status;
}

function stuckOrNothing(input: {
  evidence: DashboardLaneEvidence;
  rate: DashboardLaneRate | undefined;
  sinceActivityMs: number | undefined;
  staleAfterMs: number;
  graceMs: number;
  waiting: boolean;
}): { stuck?: DashboardLaneStuck } {
  const stuck = detectStuck(input);
  return stuck === undefined ? {} : { stuck };
}

/**
 * What was consulted and found silent.
 *
 * Never a guess at the cause — it names the absent evidence, which is the one
 * thing that IS known and the only lead a reader can follow.
 */
function unknownWhy(
  evidence: DashboardLaneEvidence,
  rate: DashboardLaneRate | undefined,
): string {
  if (evidence.reportsLive === true) {
    return 'the lane reports itself live, but nothing it publishes has moved and no arbiter has said why';
  }
  if (rate === undefined && evidence.samples !== undefined && evidence.samples.length > 0) {
    return 'the lane has reported only once, so there is nothing yet to measure a rate against';
  }
  // Deliberately free of the words "parked", "running" and "scheduled": this is
  // the sentence that renders when nothing established any of them, and a
  // reader scanning the page must not catch a state word out of the corner of
  // their eye on the one line that exists to say there is no state word.
  return 'nothing readable says whether this lane is working, and no arbiter has said to stop it';
}

/* --------------------------------------------------------------- banners -- */

/**
 * What the top-of-page banner says.
 *
 * There is no failures lane and no list of everything that ever went wrong: the
 * source pages settled this shape already (owner ruling), and it holds here.
 * Self-healing conditions render NOTHING — a system that is already fixing
 * itself does not need the owner — so only two things can arm a banner: a lane
 * the stuck detector caught, and a condition that genuinely needs a person.
 */
export interface DashboardLaneBanner {
  /** Which lane this is about. */
  lane: string;
  /** Plain words. No enum names, no unit names, no percentages. */
  words: string;
  /** The last thing any arbiter said about this lane, when anything did. */
  lastGoverning?: string;
  /** Where the reader can act, when a page exists that can act on it. */
  href?: string;
  hrefLabel?: string;
}

/** A condition that needs a person, already worded by whoever found it. */
export interface DashboardLaneActionable {
  lane: string;
  words: string;
  href?: string;
  hrefLabel?: string;
}

/**
 * The banners to draw, in reading order: stuck lanes first, then the conditions
 * that need a person. An empty array is the ordinary state and renders nothing
 * at all — not an "all clear" panel, which is just a banner that cried wolf.
 */
export function armLaneBanners(input: {
  lanes: readonly { name: string; status: DashboardLaneStatus }[];
  actionable?: readonly DashboardLaneActionable[];
}): DashboardLaneBanner[] {
  const banners: DashboardLaneBanner[] = [];
  for (const lane of input.lanes) {
    const stuck = lane.status.stuck;
    if (stuck === undefined) continue;
    banners.push({
      lane: lane.name,
      words: stuck.words,
      ...(stuck.lastGoverning === undefined ? {} : { lastGoverning: stuck.lastGoverning }),
    });
  }
  for (const item of input.actionable ?? []) {
    banners.push({
      lane: item.lane,
      words: item.words,
      ...(item.href === undefined ? {} : { href: item.href }),
      ...(item.hrefLabel === undefined ? {} : { hrefLabel: item.hrefLabel }),
    });
  }
  return banners;
}

/* ----------------------------------------------------------------- lines -- */

/**
 * One queued item: what it is, and what it is waiting on.
 *
 * Both halves are required by the type because a queue line with only the first
 * half is the page the owner already had — a number with no explanation.
 */
export interface DashboardLaneQueuedItem {
  what: string;
  waitingOn: string;
}
