/**
 * Turning what the embedding lane is doing into entries in the decision ledger.
 *
 * WHY THIS IS OBSERVATIONAL RATHER THAN A CALLBACK. The obvious design is to
 * call the ledger from the drain when a re-embed pass starts and finishes. The
 * drain has no such boundary. `runSourceEmbeddingDrain` round-robins one
 * *batch* per corpus per turn — a corpus's re-embed is thousands of those
 * batches spread over days and many process restarts. Hooking the batch would
 * write thousands of entries and still never record the event a reader cares
 * about, which is "this corpus started needing re-embedding" and "this corpus
 * finished".
 *
 * So the unit here is a TRANSITION, derived by comparing what is true now
 * against what the ledger already says. Two consequences worth stating:
 *
 *   - The ledger is its own state. There is no companion cursor file to drift
 *     out of sync with it, and no "have I seen this yet" flag to lose. Prior
 *     state is read back out of the entries themselves, which is the one thing
 *     an append-only record is unambiguously good at.
 *
 *   - Every entry this module writes is `system-automatic`, without exception.
 *     Nothing observed after the fact can establish that someone approved it.
 *     An approved change gets a `jamie` entry appended in advance, by hand, per
 *     the owner's rule — and it then sits in the record beside the automatic
 *     entry that observed it happening. Those two lines agreeing is what
 *     approval looks like; the automatic line alone is what 2026-08-20 looked
 *     like.
 *
 * WHAT IT CATCHES. A config change that nobody classified as an embedding
 * change is precisely the incident: the endpoint moved, the config hash moved
 * with it, and a machine concluded every stored vector was stale. This module
 * compares the live endpoint and epoch against the last ones on record and
 * writes an `endpoint_change` or `epoch_change` entry when they differ — so the
 * next time it happens there is a dated line naming it, and naming the fact
 * that no one approved it.
 *
 * CORPUS NAMES ARE THE CALLER'S. The names here must be the names the ledger
 * already uses (`dropbox`, `gmail-secure`, …), not the drain's corpus ids
 * (`secure_local.dropbox.files`, …). Two id spaces that look interchangeable
 * and are not is how an observer silently records nothing; the mapping belongs
 * at the wiring site, where both spaces are in view.
 */
import {
  appendEmbeddingLedgerEntryOnce,
  readEmbeddingLedger,
  type EmbeddingLedgerEntry,
} from './embedding-ledger.ts';

/** One corpus, as the embedding lane currently sees it. */
export interface EmbeddingCorpusObservation {
  /** The name the ledger knows this corpus by. See the header. */
  corpus: string;
  /** Chunks holding a usable embedding for the configured epoch. */
  embedded_chunks: number;
  /** Chunks with none — the re-embed backlog for this corpus. */
  missing_chunks: number;
}

/** The embedding configuration in force at the moment of the observation. */
export interface EmbeddingLedgerObservationContext {
  observed_at: Date;
  model_id?: string;
  epoch?: string;
  endpoint?: string;
}

/** Kinds that say something about a corpus's re-embed state. */
const CORPUS_STATE_KINDS = new Set(['re_embed_started', 're_embed_completed', 'invalidation']);

/**
 * The entries these observations imply, given what is already recorded.
 *
 * Pure: no clock of its own, no filesystem, no ordering assumptions beyond the
 * newest-first contract `readEmbeddingLedger` guarantees. Everything testable
 * about this module is testable through this function.
 */
export function embeddingLedgerObservationEntries(
  observations: readonly EmbeddingCorpusObservation[],
  recorded: readonly EmbeddingLedgerEntry[],
  context: EmbeddingLedgerObservationContext,
): EmbeddingLedgerEntry[] {
  const recordedAt = context.observed_at.toISOString();
  const entries: EmbeddingLedgerEntry[] = [];
  const config = configEntries(recorded, context, recordedAt);
  entries.push(...config);
  // A config change is the reason a corpus can go stale without its content
  // changing, so it is recorded before the corpus transitions it explains.
  const configChanged = config.length > 0;
  for (const observation of observations) {
    entries.push(...corpusEntries(observation, recorded, context, recordedAt, configChanged));
  }
  return entries;
}

/**
 * Endpoint and epoch drift, against the last value the ledger recorded.
 *
 * Only a CHANGE is recorded, never the steady state: a ledger that writes a
 * line every time the endpoint is still what it was is a ledger nobody reads.
 */
function configEntries(
  recorded: readonly EmbeddingLedgerEntry[],
  context: EmbeddingLedgerObservationContext,
  recordedAt: string,
): EmbeddingLedgerEntry[] {
  const entries: EmbeddingLedgerEntry[] = [];
  const endpoint = context.endpoint?.trim();
  const previousEndpoint = mostRecentValue(recorded, (entry) => entry.endpoint);
  if (endpoint && previousEndpoint && endpoint !== previousEndpoint) {
    entries.push({
      entry_id: `observed-endpoint-change:${previousEndpoint}->${endpoint}`,
      recorded_at: recordedAt,
      kind: 'endpoint_change',
      what: `The embedding endpoint is now ${endpoint}. The last one on record was `
        + `${previousEndpoint}.`,
      ...(context.model_id ? { model_id: context.model_id } : {}),
      ...(context.epoch ? { epoch: context.epoch } : {}),
      endpoint,
      why: 'Observed by comparing the live embedding configuration against the last one recorded '
        + 'here. The endpoint is part of the config hash, so moving it can invalidate every stored '
        + 'vector even when the model has not changed — this is what happened on 2026-08-20.',
      approved_by: 'system-automatic',
      status: 'complete',
    });
  }
  const epoch = context.epoch?.trim();
  const previousEpoch = mostRecentValue(recorded, (entry) => entry.epoch);
  if (epoch && previousEpoch && epoch !== previousEpoch) {
    entries.push({
      entry_id: `observed-epoch-change:${previousEpoch}->${epoch}`,
      recorded_at: recordedAt,
      kind: 'epoch_change',
      what: `The embedding epoch is now ${epoch}. The last one on record was ${previousEpoch}.`,
      ...(context.model_id ? { model_id: context.model_id } : {}),
      epoch,
      ...(endpoint ? { endpoint } : {}),
      why: 'Observed by comparing the live embedding configuration against the last one recorded '
        + 'here. A new epoch means every stored vector from the old one no longer counts.',
      approved_by: 'system-automatic',
      status: 'complete',
    });
  }
  return entries;
}

/**
 * One corpus's transition, if it made one.
 *
 * Backlog appearing where a corpus was previously finished is the interesting
 * case, and it has two very different causes. If the configuration also moved,
 * the old vectors were invalidated and that is recorded as an `invalidation`.
 * If it did not, the corpus simply ingested new material, and calling that an
 * invalidation would put a false alarm in the permanent record.
 */
function corpusEntries(
  observation: EmbeddingCorpusObservation,
  recorded: readonly EmbeddingLedgerEntry[],
  context: EmbeddingLedgerObservationContext,
  recordedAt: string,
  configChanged: boolean,
): EmbeddingLedgerEntry[] {
  const corpus = observation.corpus.trim();
  if (corpus === '') return [];
  const state = corpusState(recorded, corpus);
  const working = observation.missing_chunks > 0;
  if (working === (state === 'in_progress')) return [];
  const sequence = startedCount(recorded, corpus);
  const scope = {
    corpora: [corpus],
    chunks: {
      [corpus]: working ? observation.missing_chunks : observation.embedded_chunks,
    },
  };
  const common = {
    recorded_at: recordedAt,
    ...(context.model_id ? { model_id: context.model_id } : {}),
    ...(context.epoch ? { epoch: context.epoch } : {}),
    ...(context.endpoint ? { endpoint: context.endpoint } : {}),
    scope,
    approved_by: 'system-automatic',
  } as const;
  if (!working) {
    return [{
      ...common,
      entry_id: `observed-re-embed-completed:${corpus}:${sequence}`,
      kind: 're_embed_completed',
      what: `${corpus} finished re-embedding. All ${
        observation.embedded_chunks.toLocaleString('en-US')
      } of its chunks now hold a current embedding.`,
      why: 'Observed: this corpus had chunks waiting to be embedded, and now has none.',
      status: 'complete',
    }];
  }
  const entries: EmbeddingLedgerEntry[] = [];
  // Only a corpus that had previously finished can be *re*-invalidated; one
  // that has never been recorded as complete is simply starting for the first
  // time, and saying its vectors were thrown away would be an invention.
  if (configChanged && state === 'complete') {
    entries.push({
      ...common,
      entry_id: `observed-invalidation:${corpus}:${sequence}`,
      kind: 'invalidation',
      what: `${corpus} needs re-embedding again after an embedding configuration change. `
        + `${observation.missing_chunks.toLocaleString('en-US')} chunks no longer have a usable `
        + 'embedding.',
      why: 'Observed: the embedding configuration changed and this corpus, which had been fully '
        + 'embedded, now has chunks without a current embedding. Nobody approved this in advance.',
      status: 'complete',
    });
  }
  entries.push({
    ...common,
    entry_id: `observed-re-embed-started:${corpus}:${sequence}`,
    kind: 're_embed_started',
    what: `${corpus} started re-embedding. ${
      observation.missing_chunks.toLocaleString('en-US')
    } chunks are waiting for an embedding.`,
    why: 'Observed: this corpus has chunks with no current embedding, and the drain will work '
      + 'through them.',
    status: 'in_progress',
  });
  return entries;
}

/**
 * Where this corpus stood the last time anything was recorded about it.
 *
 * `unknown` and `complete` are deliberately distinct: a corpus nobody has ever
 * recorded is not the same as one recorded as finished, and only the latter can
 * be invalidated.
 */
function corpusState(
  recorded: readonly EmbeddingLedgerEntry[],
  corpus: string,
): 'in_progress' | 'complete' | 'unknown' {
  for (const entry of recorded) {
    if (!CORPUS_STATE_KINDS.has(entry.kind)) continue;
    if (!(entry.scope?.corpora ?? []).includes(corpus)) continue;
    if (entry.kind === 're_embed_completed') return 'complete';
    // An invalidation with no start after it still means there is work to do.
    return 'in_progress';
  }
  return 'unknown';
}

/** How many re-embeds this corpus has already been recorded as starting. */
function startedCount(recorded: readonly EmbeddingLedgerEntry[], corpus: string): number {
  return recorded.filter((entry) => entry.kind === 're_embed_started'
    && (entry.scope?.corpora ?? []).includes(corpus)).length;
}

/** The newest non-empty value of one field. Entries arrive newest-first. */
function mostRecentValue(
  recorded: readonly EmbeddingLedgerEntry[],
  read: (entry: EmbeddingLedgerEntry) => string | undefined,
): string | undefined {
  for (const entry of recorded) {
    const value = read(entry)?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Read the ledger, work out what these observations changed, and append it.
 *
 * Returns what it wrote, which is usually nothing: in the steady state every
 * corpus is where the ledger already says it is, and the correct number of new
 * entries is zero. Appends are exactly-once by `entry_id`, so calling this on
 * a timer is safe.
 */
export async function recordEmbeddingLedgerObservations(
  path: string,
  observations: readonly EmbeddingCorpusObservation[],
  context: EmbeddingLedgerObservationContext,
): Promise<EmbeddingLedgerEntry[]> {
  const ledger = await readEmbeddingLedger(path);
  const entries = embeddingLedgerObservationEntries(observations, ledger.entries, context);
  const written: EmbeddingLedgerEntry[] = [];
  for (const entry of entries) {
    if (await appendEmbeddingLedgerEntryOnce(path, entry)) written.push(entry);
  }
  return written;
}
