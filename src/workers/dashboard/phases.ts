/**
 * The three phases of ingestion, as progress a reader can actually read.
 *
 * Owner ruling, 2026-08-24 design session, revised 2026-09-01. The pipeline
 * has exactly three phases and they carry their technical names, because a
 * made-up friendly word for each was what let the old page describe work it
 * had not measured:
 *
 *   1. METADATA SYNC — provider items discovered: the files and messages
 *      Olympus knows exist, by name, path and version.
 *   2. EXTRACTION — in-scope items whose content has been READ. Text pulled out
 *      of the bytes, including the OCR and vision passes over scans.
 *   3. EMBEDDING — in-scope items whose every chunk is embedded on the CURRENT
 *      model. A chunk embedded on a retired model is not embedded for this
 *      purpose.
 *
 * "Ingestion" is the whole pipeline and is never one of these phases.
 *
 * The 2026-09-01 revision, from live use:
 *
 * - EVERY source page shows ALL THREE rows, always, in pipeline order. A row
 *   that has nothing to do yet says so; a row is never omitted.
 * - The bars form a WATERFALL. Extraction and embedding count in the same unit
 *   — items of the in-scope population — so embedding can never run ahead of
 *   extraction. (Embedding used to count chunks of already-extracted files,
 *   which is how Drive read 95% embedded at 50% extracted.) Metadata sync
 *   keeps its own unit, and extraction may legitimately read ahead of it only
 *   because metadata-only items sit in the sync count and not in extraction's.
 * - A source whose text arrives with the item (chat, bookmarks, highlights)
 *   has no separate extraction lane: its extraction row TRACKS the sync row and
 *   says so, rather than disappearing.
 * - Each row carries ONE state word — Done, Working, Stalled, Waiting — because
 *   what the reader needs from a bar that is not full is whether it is moving.
 *
 * Three rules hold the whole module up:
 *
 * - A denominator that is not known yet is an INDETERMINATE bar carrying the
 *   count so far, never a percentage computed from a guess.
 * - Every population excludes policy-exits — out-of-scope, excluded,
 *   media/books deferred, privacy-fenced — through the one denominator
 *   `answer-ready-coverage.ts` already owns. This module reuses it via
 *   `dashboardWorkingSummary` rather than re-deriving it.
 * - New material re-opens a settled corpus's bars scoped to the DELTA. Three
 *   new files in 27,000 must never render as 99.99%, and where no honest delta
 *   denominator exists the phase states what is left and says so, flagged.
 *
 * The 2026-09-02 revision, from the same live use: the delta now has a real
 * denominator. The movement ledger records what each phase was worth at the
 * last moment it was complete, and the batch in flight is what stands above
 * that baseline — "7 of 12 new files", not "7 files remaining". The page pairs
 * it with a standing totals line, so scoping the bars to the pass no longer
 * costs the reader the corpus-wide view. The flagged remainder survives as the
 * fallback for a corpus that has never been observed settling.
 */
import type { DashboardSourceCard } from '../source-dashboard.ts';
import type { EmbeddingRuntimeFacts } from './embedding-runtime.ts';
import {
  dashboardDuration,
  dashboardRelativeFromMs,
  dashboardWorkingSummary,
  type DashboardWorkingSummary,
} from './vocabulary.ts';

export type DashboardPhaseId = 'metadata_sync' | 'extraction' | 'embedding';

/** The reader-facing name of each phase. Technical, by ruling, and final. */
export const DASHBOARD_PHASE_LABELS: Readonly<Record<DashboardPhaseId, string>> = {
  metadata_sync: 'Metadata sync',
  extraction: 'Extraction',
  embedding: 'Embedding',
};

/** Phase order on the page: the order work actually moves through them. */
export const DASHBOARD_PHASE_ORDER: readonly DashboardPhaseId[] = [
  'metadata_sync',
  'extraction',
  'embedding',
];

/**
 * What a bar is able to say.
 *
 * `ratio` is the only shape that draws a percentage, and it can only be built
 * where both halves were counted in the same unit and the same population.
 * `indeterminate` is the honest bar for a denominator nobody knows yet — a
 * first crawl still walking the tree. `remaining` is the flagged fallback: work
 * whose size is known and whose share is not.
 */
export type DashboardPhaseMeasure =
  | { kind: 'ratio'; done: number; total: number; percent: number }
  | { kind: 'indeterminate'; done: number }
  | { kind: 'remaining'; remaining: number };

/**
 * The one word a row carries about motion (owner ruling, 2026-09-01).
 *
 *   done     — the bar is full.
 *   working  — the counter rose recently, or the lane behind it reports live.
 *   stalled  — open work and no rise past the stall window; the word the page
 *              exists to say.
 *   waiting  — nothing for this phase to do YET because the phase before it
 *              has produced nothing, or a sync is scheduled and not yet due.
 */
export type DashboardPhaseState = 'done' | 'working' | 'stalled' | 'waiting';

export interface DashboardPhase {
  id: DashboardPhaseId;
  label: string;
  /** Plural noun this phase counts in: 'folders', 'files', 'messages', ... */
  unit: string;
  measure: DashboardPhaseMeasure;
  /**
   * 'corpus' when the bar spans everything this source holds; 'delta' when it
   * spans only material that arrived after the corpus had settled.
   */
  scope: 'corpus' | 'delta';
  /**
   * True when this phase HAD to fall back because no honest denominator exists
   * for what it is describing. The page prints the count and says the share is
   * not measured; nothing anywhere may render a percentage for a flagged phase.
   */
  denominator_unavailable: boolean;
  state: DashboardPhaseState;
  /** The state, in the words the row prints: "Working · moved 40s ago". */
  state_words: string;
  /**
   * True on the extraction row of a source whose text arrives with the item:
   * the row tracks the sync row and the page says so instead of hiding it.
   */
  tracks_sync?: boolean;
  /**
   * True on an embedding row whose store publishes no per-item parity count:
   * the denominator is known, the numerator is not, and the row says so
   * rather than deriving a file count from a chunk ratio (a derived number
   * would print as a measured one).
   */
  unmeasured?: boolean;
  /**
   * True on the embedding row of a keyword-only source: the stage does not
   * apply, the row says so, and it counts as complete for settling.
   */
  not_applicable?: boolean;
}

export interface DashboardProgress {
  /** All three phases, always, in pipeline order. */
  phases: DashboardPhase[];
  /**
   * True when every phase is complete, so the bars come down and the settled
   * line replaces them. An indeterminate phase can never satisfy this: an
   * unknown denominator is not a finished one.
   */
  settled: boolean;
  /** True when at least one phase is scoped to new material, not the corpus. */
  delta: boolean;
}

export interface DashboardProgressOptions {
  now?: Date;
  /** What the embedding lane reports about itself, when the worker read it. */
  embeddingRuntime?: EmbeddingRuntimeFacts;
}

/**
 * Below this share left, a corpus-wide percentage rounds to a number that
 * denies the work exists.
 *
 * The fallback, since 2026-09-02, for a corpus with no recorded settled
 * baseline: where one exists the batch is measured outright and no threshold
 * is consulted at all.
 *
 * Half a percent is not a taste threshold: it is the resolution of the printed
 * figure. Percentages on this page carry one decimal, so anything under it
 * renders as "100%" or "99.9%" — the exact lie the owner named ("3 new files in
 * 27k must not render as 99.99%"). At or above it, the corpus-wide percentage
 * is still a true description of the corpus and stays.
 */
const DELTA_OVERSTATE_SHARE = 0.005;

/**
 * How long a counter may sit still, with open work, before its row says
 * Stalled.
 *
 * One hour, not the source's freshness window: freshness measures how late a
 * whole sync may run before the card is called stale (a day or more), while
 * this asks whether a lane that has work in front of it is doing any. The
 * sample history behind it is polled every few seconds and kept for a day, so
 * an hour is well inside what it can actually see.
 */
export const DASHBOARD_PHASE_STALL_HOURS = 1;

/** The three bars for one source, their states, and whether anything is left. */
export function dashboardSourceProgress(
  source: DashboardSourceCard,
  options: DashboardProgressOptions = {},
): DashboardProgress {
  const now = options.now ?? new Date();
  const settledPass = dashboardHasSettledPass(source);
  const metadata = metadataSyncPhase(source, settledPass);
  const extraction = extractionPhase(source, settledPass, metadata);
  const embedding = embeddingPhase(source, settledPass, extraction, dashboardWorkingSummary(source));
  const bare = [metadata, extraction, embedding];
  const phases = bare.map((phase, index) => withState(phase, index, bare, source, now, options.embeddingRuntime));
  return {
    phases,
    settled: phases.every((phase) => phase.state === 'done'),
    delta: phases.some((phase) => phase.scope === 'delta'),
  };
}

type BarePhase = Omit<DashboardPhase, 'state' | 'state_words'>;

/**
 * True when this source has finished at least one full pass over its provider.
 *
 * It is what separates "the first crawl is 97% done" from "a settled corpus has
 * 3 new files": the same two numbers mean different things either side of it,
 * and only the second may be delta-scoped. A card still waiting for its first
 * sync is never settled however many items it has already recorded.
 */
export function dashboardHasSettledPass(source: DashboardSourceCard): boolean {
  if (source.connection.state === 'waiting_for_first_sync') return false;
  if (source.freshness.label === 'Waiting for first check') return false;
  // `synced` is the connection state the view model writes once this source has
  // been through a sync — the same evidence the header's own word is built on.
  // Without it a card reading "synced 41 minutes ago" would have drawn an
  // indeterminate metadata-sync bar claiming its total was not known yet.
  if (source.connection.state === 'synced') return true;
  if (source.last_run?.status === 'completed') return true;
  return Number.isFinite(Date.parse(source.last_sync_at ?? ''));
}

/** A phase with nothing left to do. An indeterminate phase never qualifies. */
export function dashboardPhaseComplete(phase: Pick<DashboardPhase, 'measure'>): boolean {
  const measure = phase.measure;
  if (measure.kind === 'ratio') return measure.done >= measure.total;
  if (measure.kind === 'remaining') return measure.remaining <= 0;
  return false;
}

/** What a measure has counted so far, whatever its shape. */
function measureDone(measure: DashboardPhaseMeasure): number {
  return measure.kind === 'remaining' ? 0 : measure.done;
}

/**
 * The noun a source's items go by (owner note, 2026-09-01: "the units need to
 * be correct for each bar" — Gmail was counting "files"). Off the card's
 * family, which is the one field that says what kind of thing an item is.
 */
export function dashboardItemNoun(source: Pick<DashboardSourceCard, 'family'>): string {
  switch (source.family) {
    case 'email':
    case 'chat':
      return 'messages';
    case 'readwise':
      return 'highlights';
    case 'x':
      return 'posts';
    case 'file':
      return 'files';
    default:
      return 'items';
  }
}

/**
 * How much of the provider Olympus has actually looked at.
 *
 * A source whose provider is walked as a tree measures this in FOLDERS, off the
 * walk's own total and visited counts — and because a re-walk restates both,
 * that ratio is already scoped to the pass in flight and never needs the delta
 * fallback. A walk that has not sized the tree yet is the textbook
 * indeterminate bar: it knows how far it has got and not how far there is to go.
 *
 * A source with no walk measures in its own items. There its honest answer is
 * binary: during a first crawl the denominator is unknown, and after a
 * completed pass everything the provider offered has been recorded.
 */
function metadataSyncPhase(source: DashboardSourceCard, settledPass: boolean): BarePhase {
  const walk = source.metadata_sync;
  const noun = dashboardItemNoun(source);
  if (walk) {
    if (walk.folders_total > 0) {
      return ratioPhase('metadata_sync', 'folders', walk.folders_visited, walk.folders_total, false);
    }
    // A walk that reports no tree size yet, whether or not it has started.
    return indeterminatePhase('metadata_sync', 'folders', walk.folders_visited);
  }
  const discovered = source.coverage.indexed_items;
  if (!settledPass) return indeterminatePhase('metadata_sync', noun, discovered);
  return ratioPhase('metadata_sync', noun, discovered, discovered, false);
}

/**
 * How much in-scope content has been read.
 *
 * The population is `dashboardWorkingSummary`'s, which is the one denominator
 * the whole dashboard divides by — policy-exits already removed, a corpus's own
 * published eligible count preferred over the subtraction.
 *
 * A source that declares its content arrives already extracted has no lane
 * here, so its row TRACKS the sync row and says so — unless its own counts
 * disagree, in which case the counts win and the real ratio appears. A wrong
 * declaration must be able to look silly; it must never hide work.
 */
function extractionPhase(
  source: DashboardSourceCard,
  settledPass: boolean,
  metadata: BarePhase,
): BarePhase {
  const summary = dashboardWorkingSummary(source);
  const noun = dashboardItemNoun(source);
  if (!summary) {
    // Nothing in scope — including a source whose every item is a policy
    // exit. Checked before the inline-text branch so that branch can never
    // borrow the metadata total and count excluded items as extracted.
    // Nothing in scope yet. While the sync is still sizing the corpus this is
    // simply not started; once the sync has finished and found nothing to
    // read, there is nothing to extract and the row is complete at zero.
    return dashboardPhaseComplete(metadata) && metadata.measure.kind === 'ratio'
      ? ratioPhase('extraction', noun, 0, 0, false)
      : indeterminatePhase('extraction', noun, 0);
  }
  const behind = summary.read_items < summary.in_scope_items;
  if (source.content_arrives_extracted === true && !behind) {
    // The row tracks sync, but over the SAME in-scope population every other
    // row divides by — never the metadata total, which counts policy-exits
    // too and would put extraction at 100/100 above an embedding row at 80/100.
    return { ...ratioPhase('extraction', noun, summary.in_scope_items, summary.in_scope_items, false), tracks_sync: true };
  }
  return ratioPhase(
    'extraction',
    noun,
    summary.read_items,
    summary.in_scope_items,
    settledPass,
    source.movement?.extraction_settled_value,
  );
}

/**
 * How many in-scope items are embedded on the model answers are served from.
 *
 * Counted in the SAME unit and over the SAME population as extraction, so the
 * waterfall holds by construction: the numerator is clamped to what extraction
 * has read. The store's per-item parity count is the only measured figure.
 * Where a store publishes none, the row says the share is not measured; it
 * never derives an item count from chunk totals, which would print a made-up
 * number as a measured one.
 */
function embeddingPhase(
  source: DashboardSourceCard,
  settledPass: boolean,
  extraction: BarePhase,
  summary: DashboardWorkingSummary | undefined,
): BarePhase {
  const noun = dashboardItemNoun(source);
  if (source.embedding_required === false) {
    return { ...ratioPhase('embedding', noun, 0, 0, false), not_applicable: true };
  }
  // The population comes from the working summary directly, not from the
  // extraction phase's measure: that measure may have been delta-converted to
  // a bare remainder, and the denominator it dropped is still known here.
  const read = summary !== undefined
    ? Math.min(summary.read_items, summary.in_scope_items)
    : extraction.measure.kind === 'ratio' ? extraction.measure.done : undefined;
  const total = summary !== undefined
    ? summary.in_scope_items
    : extraction.measure.kind === 'ratio' ? extraction.measure.total : undefined;
  if (read === undefined || total === undefined) {
    // Extraction has no denominator yet, so embedding has none either. It
    // counts what it can: measured files, or nothing.
    return indeterminatePhase('embedding', noun, source.coverage.embedded_files ?? 0);
  }
  const measured = source.coverage.embedded_files;
  if (measured !== undefined) {
    return ratioPhase(
      'embedding',
      noun,
      Math.min(measured, read),
      total,
      settledPass,
      source.movement?.embedding_settled_value,
    );
  }
  if (total === 0) return ratioPhase('embedding', noun, 0, 0, false);
  // No per-item parity published: the numerator is unknown, not zero, and
  // never derived from chunk ratios (one 9,901-chunk file plus 99 one-chunk
  // files would read as 99 embedded files).
  return { ...indeterminatePhase('embedding', noun, 0), unmeasured: true };
}

/**
 * The state word for one row.
 *
 * Precedence, and the reason for it:
 *   1. Done — a full bar has nothing to be working on or stalled at.
 *   2. Waiting — the phase before this one has produced nothing yet, so a zero
 *      here is not stillness; or a sync is scheduled and simply not due.
 *   3. Working / Stalled — decided by the counter's own last rise where the
 *      history records one, else by the lane reporting itself live, else
 *      Stalled: open work that nothing can show moving is the case this word
 *      exists for.
 */
function withState(
  phase: BarePhase,
  index: number,
  phases: readonly BarePhase[],
  source: DashboardSourceCard,
  now: Date,
  embeddingRuntime: EmbeddingRuntimeFacts | undefined,
): DashboardPhase {
  if (phase.not_applicable === true) {
    return { ...phase, state: 'done', state_words: 'Not needed · keyword search only' };
  }
  if (phase.unmeasured === true) {
    return { ...phase, state: 'waiting', state_words: 'Not measured by this store' };
  }
  if (dashboardPhaseComplete(phase)) {
    return { ...phase, state: 'done', state_words: 'Done' };
  }
  const previous = index > 0 ? phases[index - 1] : undefined;
  if (previous !== undefined && measureDone(previous.measure) === 0 && measureDone(phase.measure) === 0) {
    return { ...phase, state: 'waiting', state_words: `Waiting for ${previous.label.toLowerCase()}` };
  }
  const live = laneReportsLive(source, phase.id, embeddingRuntime);
  const movedAt = Date.parse(movementFor(source, phase.id) ?? '');
  if (Number.isFinite(movedAt)) {
    const sinceMs = Math.max(0, now.getTime() - movedAt);
    if (sinceMs <= DASHBOARD_PHASE_STALL_HOURS * 3_600_000) {
      return { ...phase, state: 'working', state_words: `Working · moved ${dashboardRelativeFromMs(sinceMs)}` };
    }
    // Measured stillness outranks a lane's own "running" flag: a counter that
    // has not risen in 30 hours is stalled whatever the lane says about
    // itself, and the flag is reported as the contradiction it is.
    const still = `Stalled · nothing moved for ${dashboardDuration(sinceMs / 1000)}`;
    return { ...phase, state: 'stalled', state_words: live ? `${still} · lane reports running` : still };
  }
  if (live) {
    return { ...phase, state: 'working', state_words: 'Working' };
  }
  const due = nextSyncDue(source, phase.id, now);
  if (due !== undefined) {
    return { ...phase, state: 'waiting', state_words: `Waiting · next sync in ${due}` };
  }
  return { ...phase, state: 'stalled', state_words: `Stalled · ${stillnessWords(source, phase.id)}` };
}

function movementFor(source: DashboardSourceCard, id: DashboardPhaseId): string | undefined {
  const movement = source.movement;
  if (!movement) return undefined;
  if (id === 'metadata_sync') return movement.metadata_sync_at;
  if (id === 'extraction') return movement.extraction_at;
  return movement.embedding_at;
}

/**
 * Whether the lane behind a phase says it is running right now. Evidence the
 * worker publishes, never an inference from a percentage.
 */
function laneReportsLive(
  source: DashboardSourceCard,
  id: DashboardPhaseId,
  embeddingRuntime: EmbeddingRuntimeFacts | undefined,
): boolean {
  if (source.active_ingestion_phase === id) return true;
  if (id === 'metadata_sync') {
    return source.connection.state === 'syncing'
      || source.schedule?.running === true
      || (source.progress?.indexed_items_per_hour ?? 0) > 0;
  }
  if (id === 'extraction') {
    // A source whose text arrives with the item extracts as it syncs.
    if (source.content_arrives_extracted === true) {
      return source.connection.state === 'syncing' || source.schedule?.running === true;
    }
    const drainActive = source.ingestion_health.last_drain_activity_hours;
    return source.queue_health.active > 0
      || (drainActive !== undefined && drainActive * 60 <= 5);
  }
  const state = embeddingRuntime?.state;
  return state === 'running' || state === 'operator_priority';
}

/** "12m", when a sync is scheduled inside the stall window and not failing. */
function nextSyncDue(source: DashboardSourceCard, id: DashboardPhaseId, now: Date): string | undefined {
  if (id !== 'metadata_sync') return undefined;
  const schedule = source.schedule;
  if (!schedule || schedule.consecutive_failures > 0) return undefined;
  const nextAt = Date.parse(schedule.next_run_at ?? '');
  if (!Number.isFinite(nextAt) || nextAt <= now.getTime()) return undefined;
  if (nextAt - now.getTime() > DASHBOARD_PHASE_STALL_HOURS * 3_600_000) return undefined;
  return dashboardDuration((nextAt - now.getTime()) / 1000);
}

/** Why a row with open work is not moving, in the words the card can back. */
function stillnessWords(source: DashboardSourceCard, id: DashboardPhaseId): string {
  // A connection the owner has to repair stops every phase, and is the one
  // reason the reader can act on, so it outranks the lane-level ones.
  if (source.connection.state === 'reauth_required') return 'reauthentication required';
  if (source.connection.state === 'awaiting_consent') return 'waiting for your approval in the provider tab';
  if (id === 'embedding' && source.embedding_lane_state === 'embedding_lane_disabled') {
    return 'embedding lane is switched off';
  }
  if (id === 'extraction') {
    const drain = source.ingestion_health.drain_state;
    if (drain === 'held' || drain === 'disabled') return 'extraction lane is switched off';
  }
  const schedule = source.schedule;
  if (id === 'metadata_sync' && schedule && schedule.consecutive_failures > 0) {
    return `last ${schedule.consecutive_failures === 1 ? 'sync' : `${schedule.consecutive_failures} syncs`} failed`;
  }
  return 'no movement seen';
}

/**
 * A counted phase, delta-scoped to the batch in flight when one is measurable.
 *
 * The movement ledger records what each phase was worth at the last moment it
 * was COMPLETE on a settled pass. Subtracting that baseline from both halves
 * leaves the current pass and nothing else: 30,007 read of 30,012 in scope over
 * a corpus that settled at 30,000 is 7 of 12 new files. That is the bar the
 * owner asked for (2026-09-02), and it replaces the share heuristic below — a
 * batch is the current pass whatever fraction of the corpus it happens to be,
 * so there is no threshold for it to cross.
 *
 * Two fallbacks stay, in order. Without a usable baseline, a shortfall too
 * small to survive one decimal states what is left and raises the flag, because
 * a corpus-wide "99.99%" would deny the work outright. Everything else is a
 * corpus-wide percentage that is simply true.
 */
function ratioPhase(
  id: DashboardPhaseId,
  unit: string,
  rawDone: number,
  rawTotal: number,
  settledPass: boolean,
  settledBaseline?: number,
): BarePhase {
  const total = Math.max(0, Math.round(rawTotal));
  const done = Math.max(0, Math.min(total, Math.round(rawDone)));
  const remaining = total - done;
  if (settledPass && remaining > 0) {
    const batch = deltaMeasure(done, total, settledBaseline);
    if (batch) {
      return {
        id,
        label: DASHBOARD_PHASE_LABELS[id],
        unit,
        measure: batch,
        scope: 'delta',
        denominator_unavailable: false,
      };
    }
    if (total > 0 && remaining / total < DELTA_OVERSTATE_SHARE) {
      return {
        id,
        label: DASHBOARD_PHASE_LABELS[id],
        unit,
        measure: { kind: 'remaining', remaining },
        scope: 'delta',
        denominator_unavailable: true,
      };
    }
  }
  return {
    id,
    label: DASHBOARD_PHASE_LABELS[id],
    unit,
    measure: { kind: 'ratio', done, total, percent: percentOf(done, total) },
    scope: 'corpus',
    denominator_unavailable: false,
  };
}

/**
 * The batch above a settled baseline, or nothing when the baseline describes no
 * batch this phase can honestly divide by.
 *
 * Three refusals, and each is a sentence the page must never print:
 *   - no baseline recorded — nothing to subtract, so the corpus is all there is;
 *   - a baseline at or above the current total — no new material behind it, so
 *     the denominator would be zero or negative;
 *   - a numerator below the baseline — the counter is being rebuilt, not
 *     extended, and calling a re-index's remainder a batch would report a whole
 *     corpus as a handful of new files.
 */
function deltaMeasure(
  done: number,
  total: number,
  settledBaseline: number | undefined,
): DashboardPhaseMeasure | undefined {
  if (settledBaseline === undefined || !Number.isFinite(settledBaseline)) return undefined;
  const baseline = Math.round(settledBaseline);
  if (baseline < 0) return undefined;
  const batchTotal = total - baseline;
  const batchDone = done - baseline;
  if (batchTotal <= 0 || batchDone < 0) return undefined;
  return { kind: 'ratio', done: batchDone, total: batchTotal, percent: percentOf(batchDone, batchTotal) };
}

function indeterminatePhase(id: DashboardPhaseId, unit: string, done: number): BarePhase {
  return {
    id,
    label: DASHBOARD_PHASE_LABELS[id],
    unit,
    measure: { kind: 'indeterminate', done: Math.max(0, Math.round(done)) },
    scope: 'corpus',
    denominator_unavailable: true,
  };
}

/**
 * 0..100 to one decimal.
 *
 * An empty population answers 100 only because `done >= total` is vacuously
 * true there: a phase with nothing to do is complete, not unmeasured.
 */
function percentOf(done: number, total: number): number {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((done / total) * 1000) / 10));
}
