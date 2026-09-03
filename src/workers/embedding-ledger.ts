/**
 * The embedding decision ledger: an append-only record of everything that has
 * ever changed the stored embeddings, and who agreed to it.
 *
 * WHY IT EXISTS. On 2026-08-20 a port retarget changed the embedding config
 * hash. The config hash drove a currency invalidation. Roughly a quarter of a
 * million stored vectors were deleted from five connector stores. Nobody had
 * approved it, and — the part that made it an incident rather than a mistake —
 * days later nobody could reconstruct what had been done, on what model, why,
 * or on whose authority, because no system anywhere wrote those four facts
 * down. The owner's ruling: every embedding-affecting event is logged
 * append-only, and any future embedding change or re-embed needs his advance
 * approval.
 *
 * THREE DESIGN RULES follow from that, and each is a refusal:
 *
 * 1. NO ROTATION, EVER. Every other JSONL log in this repo rotates at a size
 *    cap (see source-index/answer-latency-log.ts, which this module otherwise
 *    follows closely). This one must not: a decision record that discards its
 *    oldest entries deletes exactly the history an incident review needs, and
 *    the 2026-08-20 entries are the ones most worth keeping forever. The file
 *    stays small on its own — embedding-affecting events happen a handful of
 *    times a year, not a handful of times a second.
 *
 * 2. NEVER INFER AN APPROVAL. `approved_by` has no default. A change nobody
 *    signed off is recorded as `unattributed-historical` or
 *    `system-automatic`, and both read on the page as "not approved". The wipe
 *    would have been laundered into legitimacy by any friendlier default.
 *
 * 3. NOTHING IS REDACTED. The endpoints here are loopback URLs and the port
 *    inside one of them is the whole causal story of the incident. A masked
 *    endpoint would have hidden the change that mattered.
 *
 * A corrupt line is skipped and COUNTED, never silently dropped: a record that
 * quietly loses what it cannot parse reads as complete when it is not, and the
 * reader is entitled to know the difference.
 */
import { homedir } from 'node:os';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Override for the ledger file. Everything else derives from XDG_DATA_HOME. */
export const EMBEDDING_LEDGER_PATH_ENV = 'OLYMPUS_EMBEDDING_LEDGER_PATH';

/**
 * What kind of embedding-affecting event this is.
 *
 * The list is closed on purpose: an event that fits none of these is a `note`
 * with a sentence, not a new kind invented at a call site.
 */
export type EmbeddingLedgerKind =
  | 'model_decision'
  | 'epoch_change'
  | 'endpoint_change'
  | 'invalidation'
  | 're_embed_started'
  | 're_embed_completed'
  | 'note';

/**
 * Who agreed to this.
 *
 * `jamie` is the ONLY value that means approved, and it means approved IN
 * ADVANCE — that is the owner's rule, and a retrospective blessing is a `note`
 * entry of its own rather than a rewrite of the original. `system-automatic`
 * means a machine did it with no human in the loop. `unattributed-historical`
 * means it happened and the record of who decided it does not exist.
 */
export type EmbeddingLedgerApprovedBy = 'jamie' | 'system-automatic' | 'unattributed-historical';

/** Where this event has got to. `n/a` is for events that are not work. */
export type EmbeddingLedgerStatus = 'pending' | 'in_progress' | 'complete' | 'n/a';

export interface EmbeddingLedgerScope {
  /** Corpora affected, by the names the connector stores are known by. */
  corpora?: readonly string[];
  /**
   * Chunks affected per corpus, and ONLY where a real count was observed.
   * An estimate never goes here — it goes in the `what` sentence, where it can
   * be qualified in words. A number in this field is a claim of fact.
   */
  chunks?: Readonly<Record<string, number>>;
}

export interface EmbeddingLedgerEntry {
  /** ISO 8601, UTC. When the event was recorded. */
  recorded_at: string;
  kind: EmbeddingLedgerKind;
  /** One plain sentence a reader who was not there can understand. */
  what: string;
  model_id?: string;
  epoch?: string;
  /** Loopback URL, unredacted by design. See the header. */
  endpoint?: string;
  scope?: EmbeddingLedgerScope;
  why?: string;
  approved_by: EmbeddingLedgerApprovedBy;
  status: EmbeddingLedgerStatus;
  /**
   * Stable identity, for entries that must appear exactly once.
   *
   * The backfill entries below carry one so that merging them with the file
   * can never double them, and so that a hook which fires on every drain tick
   * can record its observation once rather than once a minute. An entry with
   * no id is always kept — two genuinely separate events may say the same
   * thing.
   */
  entry_id?: string;
}

export interface EmbeddingLedgerReadResult {
  /** Newest first. See `readEmbeddingLedger`. */
  entries: EmbeddingLedgerEntry[];
  /** Lines that were present and unreadable. Reported, never hidden. */
  skipped: number;
  /** The file this was read from, so a caller can say where the record lives. */
  path: string;
}

/**
 * Resolve the ledger file.
 *
 * Follows the worker family's path idiom exactly (source-scheduler-state.ts,
 * email-source/local-index.ts, source-index/answer-latency-log.ts): an
 * explicit env override, then XDG_DATA_HOME, then ~/.local/share, always under
 * `openclaw/olympus`. `env` is injected rather than read from the module body
 * so it is testable; callers pass `process.env` explicitly.
 *
 * This is durable data, so it belongs under `.local/share` and NOT under
 * `.local/state`, which this family reserves for regenerable reports.
 */
export function resolveEmbeddingLedgerPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[EMBEDDING_LEDGER_PATH_ENV]?.trim();
  if (configured) return configured;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'embedding-ledger.jsonl');
}

/**
 * Append one entry.
 *
 * Owner-only permissions, and no rotation for the reason in the header. The
 * chmod on an already-open handle repairs a ledger created earlier under a
 * broader umask without a window where the file is readable and unlocked.
 */
export async function appendEmbeddingLedgerEntry(
  path: string,
  entry: EmbeddingLedgerEntry,
): Promise<void> {
  const line = `${JSON.stringify(entry)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.appendFile(line, 'utf8');
    // fsync: this is a record of decisions, not telemetry. Losing the tail of
    // it to a crash would recreate the exact hole the ledger exists to close.
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Append only if no entry with this `entry_id` has been recorded yet.
 *
 * This is what makes a hook safe to call from a loop. The drain evaluates its
 * epoch on every tick; recording "dropbox went epoch-pending" once per tick
 * would bury the four entries that matter under thousands that do not. Returns
 * whether it wrote.
 *
 * Not atomic against a concurrent writer, and deliberately not: the alternative
 * is a lock file on the answer path, and the failure it would prevent — one
 * duplicated observational line — is visible, harmless, and deduplicated again
 * on read.
 */
export async function appendEmbeddingLedgerEntryOnce(
  path: string,
  entry: EmbeddingLedgerEntry,
): Promise<boolean> {
  const id = entry.entry_id?.trim();
  if (!id) {
    await appendEmbeddingLedgerEntry(path, entry);
    return true;
  }
  const existing = await readEmbeddingLedger(path);
  if (existing.entries.some((recorded) => recorded.entry_id === id)) return false;
  await appendEmbeddingLedgerEntry(path, entry);
  return true;
}

/**
 * Read the ledger: the committed backfill merged with the file, newest first.
 *
 * A MISSING file is an empty ledger, which is correct — nothing has been
 * recorded yet. A line that will not parse, or parses into something that is
 * not an entry, is skipped and counted; one bad line must not cost the reader
 * the other forty.
 *
 * Newest-first is the ledger's contract rather than the file's order, because
 * every reader of a record asks "what happened most recently" first. Ties keep
 * their file order, so two entries stamped the same second stay in the order
 * they were appended.
 */
export async function readEmbeddingLedger(path: string): Promise<EmbeddingLedgerReadResult> {
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown } | null | undefined)?.code !== 'ENOENT') throw error;
  }
  const parsed = parseEmbeddingLedgerJsonl(raw);
  return {
    entries: mergeEmbeddingLedgerEntries(EMBEDDING_LEDGER_BACKFILL, parsed.entries),
    skipped: parsed.skipped,
    path,
  };
}

/** The parse half, exposed so it can be tested without a filesystem. */
export function parseEmbeddingLedgerJsonl(text: string): {
  entries: EmbeddingLedgerEntry[];
  skipped: number;
} {
  const entries: EmbeddingLedgerEntry[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      skipped += 1;
      continue;
    }
    if (isEmbeddingLedgerEntry(parsed)) entries.push(parsed);
    else skipped += 1;
  }
  return { entries, skipped };
}

/**
 * Merge the backfill with what the file holds, deduplicating by `entry_id`,
 * then sort newest first.
 *
 * The backfill is a committed constant rather than something written on first
 * run. Writing it would need a "have I seeded yet" flag, and a flag is a thing
 * that can be lost — losing it re-seeds, and a duplicated incident record is
 * worse than an absent one. A constant merged on every read is exactly-once by
 * construction, and survives someone deleting the file.
 *
 * The FILE wins a collision, so a later correction appended under a backfill's
 * id supersedes the constant instead of being shadowed by it.
 */
export function mergeEmbeddingLedgerEntries(
  backfill: readonly EmbeddingLedgerEntry[],
  recorded: readonly EmbeddingLedgerEntry[],
): EmbeddingLedgerEntry[] {
  const byId = new Map<string, EmbeddingLedgerEntry>();
  const unidentified: EmbeddingLedgerEntry[] = [];
  for (const entry of [...backfill, ...recorded]) {
    const id = entry.entry_id?.trim();
    if (id) byId.set(id, entry);
    else unidentified.push(entry);
  }
  const merged = [...byId.values(), ...unidentified];
  // Equal stamps break by REVERSE insertion order, so the later-appended of two
  // entries recorded in the same second sorts as the newer one. Insertion order
  // is backfill then file, and the file is chronological, so this is the only
  // tie-break that keeps "newest first" true at one-second resolution. Sorting
  // ties the other way put a completion above the start that followed it.
  return merged
    .map((entry, index) => ({ entry, index, at: stampOrder(entry.recorded_at) }))
    .sort((left, right) => (right.at - left.at) || (right.index - left.index))
    .map((row) => row.entry);
}

/** An unparsable stamp sorts oldest rather than throwing the whole read away. */
function stampOrder(recordedAt: string): number {
  const at = Date.parse(recordedAt);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * Shape check.
 *
 * Strict about the closed vocabularies — an entry claiming an approval word
 * this module does not know is not an entry, because the page would have to
 * guess how to render it and guessing about approval is the one thing this
 * module refuses to do.
 */
export function isEmbeddingLedgerEntry(value: unknown): value is EmbeddingLedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.recorded_at !== 'string' || record.recorded_at.trim() === '') return false;
  if (typeof record.what !== 'string' || record.what.trim() === '') return false;
  if (!isKind(record.kind)) return false;
  if (!isApprovedBy(record.approved_by)) return false;
  if (!isStatus(record.status)) return false;
  for (const key of ['model_id', 'epoch', 'endpoint', 'why', 'entry_id'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') return false;
  }
  return record.scope === undefined || isScope(record.scope);
}

function isKind(value: unknown): value is EmbeddingLedgerKind {
  return typeof value === 'string' && value in EMBEDDING_LEDGER_KIND_TEXT;
}

function isApprovedBy(value: unknown): value is EmbeddingLedgerApprovedBy {
  return typeof value === 'string' && value in EMBEDDING_LEDGER_APPROVAL_TEXT;
}

function isStatus(value: unknown): value is EmbeddingLedgerStatus {
  return typeof value === 'string' && value in EMBEDDING_LEDGER_STATUS_TEXT;
}

function isScope(value: unknown): value is EmbeddingLedgerScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (scope.corpora !== undefined) {
    if (!Array.isArray(scope.corpora)) return false;
    if (scope.corpora.some((name) => typeof name !== 'string')) return false;
  }
  if (scope.chunks !== undefined) {
    if (!scope.chunks || typeof scope.chunks !== 'object' || Array.isArray(scope.chunks)) return false;
    if (Object.values(scope.chunks as Record<string, unknown>)
      .some((count) => typeof count !== 'number' || !Number.isFinite(count))) return false;
  }
  return true;
}

/** Plain words for each kind. The page renders these and never the enum. */
export const EMBEDDING_LEDGER_KIND_TEXT: Record<EmbeddingLedgerKind, string> = {
  model_decision: 'Model decision',
  epoch_change: 'Epoch changed',
  endpoint_change: 'Endpoint changed',
  invalidation: 'Stored vectors invalidated',
  re_embed_started: 'Re-embed started',
  re_embed_completed: 'Re-embed finished',
  note: 'Note',
};

/**
 * Plain words for each approval.
 *
 * Only the first says approved. The other two are written as sentences rather
 * than labels because "system-automatic" on its own reads like a category, and
 * the reader needs to understand it means nobody agreed to this.
 */
export const EMBEDDING_LEDGER_APPROVAL_TEXT: Record<EmbeddingLedgerApprovedBy, string> = {
  jamie: 'Approved in advance by the owner',
  'system-automatic': 'Not approved — the system did this on its own',
  'unattributed-historical': 'Not approved — no decision is on record',
};

/** Plain words for each status. `n/a` renders as nothing at all. */
export const EMBEDDING_LEDGER_STATUS_TEXT: Record<EmbeddingLedgerStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  complete: 'Complete',
  'n/a': '',
};

/** "dropbox (162,203), gmail-secure" — counts only where a count is known. */
export function embeddingLedgerScopeText(scope: EmbeddingLedgerScope | undefined): string {
  const corpora = scope?.corpora ?? [];
  if (corpora.length === 0) return '';
  return corpora.map((name) => {
    const count = scope?.chunks?.[name];
    return typeof count === 'number' && Number.isFinite(count)
      ? `${name} (${count.toLocaleString('en-US')} chunks)`
      : name;
  }).join(', ');
}

/** The five connector stores the 2026-08-20 invalidation emptied. */
const WIPED_CORPORA = [
  'dropbox',
  'gmail-secure',
  'drive-secure',
  'whatsapp-live',
  'telegram-protected',
] as const;

const QWEN3_MODEL_ID = 'secure-local-qwen3-embed';
const QWEN3_EPOCH = 'local:openai-compatible:secure-local-qwen3-embed:2560';
const DELPHI_ROUTER_ENDPOINT = 'http://127.0.0.1:28090/v1';
const PREVIOUS_ENDPOINT = 'http://127.0.0.1:28011/v1';
const GEMINI_MODEL_ID = 'gemini-embedding-2';

/** The three corpora that got an embedding drain lane on 2026-08-24. */
const LANE_ENABLEMENT_CORPORA = ['dropbox', 'readwise', 'x-bookmarks'] as const;

/**
 * What happened before there was a ledger to record it in.
 *
 * These four entries are the reconstruction the owner ruled had to exist, and
 * they are committed rather than written at runtime — see
 * `mergeEmbeddingLedgerEntries` for why. Their `entry_id`s are permanent: a
 * changed id would re-admit the entry alongside its old self.
 *
 * The 2026-08-20 chain is deliberately three entries and not one. A single
 * "vectors were wiped" line would lose the causal shape that is the whole
 * lesson: a change nobody thought of as an embedding change, a machine that
 * drew a conclusion from it unaided, and months of recomputation that followed.
 *
 * No per-corpus chunk count appears in `scope.chunks`, because none was ever
 * recorded. The approximate total lives in the sentence, in words, qualified —
 * where an estimate can be honest.
 */
export const EMBEDDING_LEDGER_BACKFILL: readonly EmbeddingLedgerEntry[] = [
  {
    entry_id: 'backfill-2026-08-20-endpoint-retarget',
    recorded_at: '2026-08-20T02:42:00.000Z',
    kind: 'endpoint_change',
    what: `The embedding endpoint was retargeted from ${PREVIOUS_ENDPOINT} to the Delphi router at `
      + `${DELPHI_ROUTER_ENDPOINT}, in commit 8ad61fa9. The model and the epoch did not change.`,
    model_id: QWEN3_MODEL_ID,
    epoch: QWEN3_EPOCH,
    endpoint: DELPHI_ROUTER_ENDPOINT,
    why: 'To move embedding traffic onto the Delphi router along with everything else. It was '
      + 'understood at the time as a routing change, and nobody expected it to touch stored vectors.',
    approved_by: 'unattributed-historical',
    status: 'complete',
  },
  {
    entry_id: 'backfill-2026-08-20-invalidation',
    recorded_at: '2026-08-20T12:03:00.000Z',
    kind: 'invalidation',
    what: 'Between roughly 02:42 and 12:03 UTC the endpoint change altered the embedding config '
      + 'hash, and the currency check treated the new hash as a different configuration. It emptied '
      + 'chunk_embeddings in five connector stores — on the order of 240,000 stored vectors, though '
      + 'no exact count was recorded before they were gone.',
    model_id: QWEN3_MODEL_ID,
    epoch: QWEN3_EPOCH,
    endpoint: DELPHI_ROUTER_ENDPOINT,
    scope: { corpora: WIPED_CORPORA },
    why: 'Nothing intended this. The config hash covered the endpoint, so a routing change was '
      + 'indistinguishable from a model change, and the invalidation followed automatically.',
    approved_by: 'system-automatic',
    status: 'complete',
  },
  {
    entry_id: 'backfill-2026-08-20-re-embed',
    // A minute after the invalidation, not the same instant as it: the drain
    // picked the work up because the vectors were already gone, and a record
    // whose stamps do not preserve that order invites the wrong causal read.
    recorded_at: '2026-08-20T12:04:00.000Z',
    kind: 're_embed_started',
    what: 'The embedding drain began recomputing every wiped vector on the same model it had used '
      + 'before. This has been running since and is not finished.',
    model_id: QWEN3_MODEL_ID,
    epoch: QWEN3_EPOCH,
    endpoint: DELPHI_ROUTER_ENDPOINT,
    scope: { corpora: WIPED_CORPORA },
    why: 'The vectors were gone and the corpora could not be searched properly without them. The '
      + 'drain picked the work up on its own; nobody scheduled it.',
    approved_by: 'system-automatic',
    status: 'in_progress',
  },
  {
    entry_id: 'backfill-2026-08-24-model-decision',
    recorded_at: '2026-08-24T00:00:00.000Z',
    kind: 'model_decision',
    what: `Stay on ${QWEN3_MODEL_ID}. From now on, any change to the embedding model, endpoint or `
      + 'epoch — and any re-embed — needs the owner\'s approval before it happens, and gets an entry '
      + 'here.',
    model_id: QWEN3_MODEL_ID,
    epoch: QWEN3_EPOCH,
    why: 'The owner researched the alternatives himself and concluded the current model is the right '
      + 'one to keep. The approval rule is the answer to 2026-08-20: the wipe was possible because an '
      + 'embedding change could happen without anyone deciding to make one.',
    approved_by: 'jamie',
    status: 'complete',
  },
  {
    entry_id: 'backfill-2026-08-24-drain-lane-enablement',
    // Later the same day than the model decision above, and it depends on it:
    // the standing model is what these lanes were approved to run on.
    recorded_at: '2026-08-24T23:30:00.000Z',
    kind: 'note',
    what: 'Three corpora that need embeddings had no drain lane driving them, so nothing was ever '
      + `going to finish them. The owner approved adding one each. Dropbox's connector store embeds `
      + `on ${QWEN3_MODEL_ID} (52,840 of its 69,512 chunks were waiting); the Readwise library and `
      + `the X bookmarks store embed on ${GEMINI_MODEL_ID} (roughly 7,700 of about 15,400 chunks `
      + 'waiting, and 15 of 2,992 respectively).',
    scope: {
      corpora: LANE_ENABLEMENT_CORPORA,
      // Dropbox and X were counted exactly. Readwise's chunk total was only
      // read to the nearest hundred, so its pending count is approximate and
      // stays in the sentence above, where it can say so.
      chunks: { dropbox: 52_840, 'x-bookmarks': 15 },
    },
    why: 'These are lanes being switched on, not a model or epoch change: each corpus embeds on the '
      + 'model it already stores vectors under, and no existing vector is invalidated — the lanes '
      + 'only fill in chunks that have none. The owner approved this in advance, which is the rule '
      + '2026-08-20 produced.',
    approved_by: 'jamie',
    status: 'complete',
  },
];
