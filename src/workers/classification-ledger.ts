/**
 * The classification decision ledger: an append-only record of every change
 * to the model or prompt that judges which tier an item belongs in, and who
 * agreed to it (design docs/design/per-item-four-tier-classification.md,
 * sections 2.2 and 4.5: "A classifier model change is an owner-approved,
 * ledgered event").
 *
 * It follows the embedding ledger's conventions exactly (embedding-ledger.ts):
 *
 * 1. NO ROTATION. A decision record that drops its oldest entries deletes
 *    exactly the history a review needs. Classifier decisions happen a few
 *    times a year.
 * 2. NEVER INFER AN APPROVAL. `approved_by` has no default and a closed
 *    vocabulary: only `owner` means approved, in advance.
 * 3. A corrupt line is skipped and COUNTED, never silently dropped.
 *
 * And one rule of its own: the sniffer does not dispatch until the ledger
 * holds an owner approval for the exact (model id, prompt version) it would
 * use (`isClassifierApproved`). A model or prompt change therefore stops the
 * sniffer — items stay pending, held Private — until the owner approves it.
 */
import { homedir } from 'node:os';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const CLASSIFICATION_LEDGER_PATH_ENV = 'OLYMPUS_CLASSIFICATION_LEDGER_PATH';

/**
 * The embedding ledger's closed approval vocabulary, with its one approving
 * value spelled `owner`: this module ships in the public CLI, which names no
 * installation's owner. `owner` is the ONLY value that means approved, in
 * advance; the other two mean nobody approved.
 */
export type ClassificationLedgerApprovedBy = 'owner' | 'system-automatic' | 'unattributed-historical';
export const CLASSIFICATION_LEDGER_OWNER_APPROVAL: ClassificationLedgerApprovedBy = 'owner';

export type ClassificationLedgerKind =
  /** A classifier model and prompt version were chosen (or asked for). */
  | 'classifier_model_decision'
  /** A previously approved model and prompt version may no longer be used. */
  | 'classifier_model_revoked'
  | 'note';

export type ClassificationLedgerStatus = 'pending' | 'complete' | 'n/a';

export interface ClassificationLedgerEntry {
  recorded_at: string;
  kind: ClassificationLedgerKind;
  /** One plain sentence a reader who was not there can understand. */
  what: string;
  model_id?: string;
  prompt_version?: string;
  /** `local` or `venice`: the lane the model runs on. */
  lane?: string;
  why?: string;
  approved_by: ClassificationLedgerApprovedBy;
  status: ClassificationLedgerStatus;
  entry_id?: string;
}

export interface ClassificationLedgerReadResult {
  /** Newest first. */
  entries: ClassificationLedgerEntry[];
  skipped: number;
  path: string;
}

/** Beside the embedding ledger: `<data home>/openclaw/olympus/classification-ledger.jsonl`. */
export function resolveClassificationLedgerPath(env: Record<string, string | undefined> = process.env): string {
  const configured = env[CLASSIFICATION_LEDGER_PATH_ENV]?.trim();
  if (configured) return configured;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'classification-ledger.jsonl');
}

export async function appendClassificationLedgerEntry(path: string, entry: ClassificationLedgerEntry): Promise<void> {
  if (!isClassificationLedgerEntry(entry)) throw new Error('Refusing to append a malformed classification ledger entry.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.appendFile(`${JSON.stringify(entry)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Append only if no entry with this `entry_id` exists yet. Returns whether it wrote. */
export async function appendClassificationLedgerEntryOnce(path: string, entry: ClassificationLedgerEntry): Promise<boolean> {
  const id = entry.entry_id?.trim();
  if (id) {
    const existing = await readClassificationLedger(path);
    if (existing.entries.some((recorded) => recorded.entry_id === id)) return false;
  }
  await appendClassificationLedgerEntry(path, entry);
  return true;
}

export async function readClassificationLedger(path: string): Promise<ClassificationLedgerReadResult> {
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown } | null | undefined)?.code !== 'ENOENT') throw error;
  }
  const { entries, skipped } = parseClassificationLedgerJsonl(raw);
  return { entries: newestFirst(entries), skipped, path };
}

export function parseClassificationLedgerJsonl(text: string): { entries: ClassificationLedgerEntry[]; skipped: number } {
  const entries: ClassificationLedgerEntry[] = [];
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
    if (isClassificationLedgerEntry(parsed)) entries.push(parsed);
    else skipped += 1;
  }
  return { entries, skipped };
}

/**
 * Whether the owner has approved, in advance, this exact model and prompt
 * version, and has not revoked it since. `entries` are newest first, as
 * `readClassificationLedger` returns them; the newest owner-signed decision
 * or revocation for the pair wins. Nothing but the owner's approval counts.
 */
export function isClassifierApproved(
  entries: readonly ClassificationLedgerEntry[],
  pair: { modelId: string; promptVersion: string },
): boolean {
  for (const entry of entries) {
    if (entry.model_id !== pair.modelId || entry.prompt_version !== pair.promptVersion) continue;
    if (entry.approved_by !== CLASSIFICATION_LEDGER_OWNER_APPROVAL) continue;
    if (entry.kind === 'classifier_model_revoked') return false;
    if (entry.kind === 'classifier_model_decision' && entry.status === 'complete') return true;
  }
  return false;
}

export function isClassificationLedgerEntry(value: unknown): value is ClassificationLedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.recorded_at !== 'string' || record.recorded_at.trim() === '') return false;
  if (typeof record.what !== 'string' || record.what.trim() === '') return false;
  if (!['classifier_model_decision', 'classifier_model_revoked', 'note'].includes(record.kind as string)) return false;
  if (!['owner', 'system-automatic', 'unattributed-historical'].includes(record.approved_by as string)) return false;
  if (!['pending', 'complete', 'n/a'].includes(record.status as string)) return false;
  for (const key of ['model_id', 'prompt_version', 'lane', 'why', 'entry_id'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') return false;
  }
  return true;
}

function newestFirst(entries: readonly ClassificationLedgerEntry[]): ClassificationLedgerEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, at: stampOrder(entry.recorded_at) }))
    .sort((left, right) => (right.at - left.at) || (right.index - left.index))
    .map((row) => row.entry);
}

function stampOrder(recordedAt: string): number {
  const at = Date.parse(recordedAt);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}
