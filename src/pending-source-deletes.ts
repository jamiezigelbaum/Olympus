/**
 * Delete indexed data, applied on restart before anything opens.
 *
 * A running engine holds a source's stores open in several places at once (the
 * worker, its scheduler, sniffer and watches, the embedding drain child), so
 * nothing running can safely unlink them. The route therefore only RECORDS an
 * intent, durably, and asks for the supervised restart. The next start applies
 * pending intents first, before any store, ledger, registry, scheduler or child
 * process exists to hold a file (engine-host.ts). The route only records an
 * intent where one restart also restarts the embedding drain (the engine host);
 * everywhere else it answers 409.
 *
 * Crash safety: an intent is removed only after the delete finished, and the
 * delete is idempotent, so a crash part-way resumes on the next start. An intent
 * the re-check refuses (settings changed, custody no longer met) deletes
 * nothing and stays as a visible `refused` record until the owner asks again.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './core/atomic-file.ts';
import { OperationError } from './core/operation-error.ts';
import { tryHoldStoreCustodyExclusive } from './core/store-custody.ts';
import { readThisComputerHandles, thisComputerStateUnreadable } from './core/this-computer.ts';
import {
  dataDeleteCustody,
  deleteOlympusDataWithCustody,
  changedBinding,
  planSourceDelete,
  type LifecyclePathContext,
  type TargetBinding,
} from './data-lifecycle.ts';
import {
  ConnectedHandleGrantMutationError,
  readConnectedHandleGrantEpoch,
  readConnectedHandleRegistry,
  withConnectedHandleGrantCustody,
} from './workers/credential-broker/connected-handles.ts';
import { readReconciledUnpairedSources } from './workers/credential-broker/unpaired-sources.ts';

export type SourceDeleteRefusal = 'settings_changed' | 'protected_path' | 'not_disconnected' | 'failed' | 'holders_running' | 'connection_changed';

export interface SourceDeleteIntent {
  id: string;
  source_id: string;
  corpora: string[];
  /** The exact resolved target paths, after protection, when the owner asked. */
  targets: string[];
  /**
   * External SQLite primaries proven to be Olympus stores when the intent was
   * recorded. The delete removes a primary first; a crash before its sidecars
   * are gone must still let the next start finish them.
   */
  verified_primaries?: string[];
  /**
   * Where the targets really were when the owner asked (symlinks resolved, plus
   * the identity of the directory above each). A changed binding refuses.
   */
  bindings?: TargetBinding[];
  /** The credential-grant generation the owner's disconnect was judged against. */
  grant_epoch?: string;
  created_at: string;
  /**
   * `applying`: the delete has begun (some store may already be gone). It is
   * retried until it completes; it is never turned into a refusal.
   */
  state: 'pending' | 'applying' | 'refused';
  /** Present when refused: a reason code only, never a path. */
  reason?: SourceDeleteRefusal;
  refused_at?: string;
}

interface IntentFile {
  version: 1;
  intents: SourceDeleteIntent[];
}

export function pendingSourceDeletesPath(registryPath: string): string {
  return join(dirname(registryPath), 'pending-source-deletes.json');
}

/** The intents on disk. An unreadable file is reported, not treated as empty. */
export function readSourceDeleteIntents(registryPath: string): { intents: SourceDeleteIntent[]; unreadable: boolean } {
  const path = pendingSourceDeletesPath(registryPath);
  if (!existsSync(path)) return { intents: [], unreadable: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<IntentFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.intents)) return { intents: [], unreadable: true };
    return { intents: parsed.intents.filter(isIntent), unreadable: false };
  } catch {
    return { intents: [], unreadable: true };
  }
}

function isIntent(value: unknown): value is SourceDeleteIntent {
  const intent = value as Partial<SourceDeleteIntent> | null;
  return !!intent && typeof intent.id === 'string' && typeof intent.source_id === 'string'
    && Array.isArray(intent.targets) && Array.isArray(intent.corpora)
    && (intent.state === 'pending' || intent.state === 'applying' || intent.state === 'refused');
}

function writeIntents(registryPath: string, intents: SourceDeleteIntent[]): void {
  const path = pendingSourceDeletesPath(registryPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Atomic and fsynced (temp file, fsync, rename, directory fsync).
  writePrivateFileAtomicSync(path, `${JSON.stringify({ version: 1, intents } satisfies IntentFile, null, 2)}\n`);
}

/** What custody reads: the same facts the dashboard route and the CLI check. */
export function sourceDeleteCustodyInput(sourceId: string, registryPath: string) {
  let thisComputerUnreadable = true;
  try { thisComputerUnreadable = thisComputerStateUnreadable(registryPath); } catch { /* unreadable stays true */ }
  return {
    sourceId,
    connectedRegistry: readConnectedHandleRegistry(registryPath),
    thisComputerSources: readThisComputerHandles(registryPath).map((handle) => handle.handle.replace(/\.this_computer$/, '')),
    thisComputerStateUnreadable: thisComputerUnreadable,
    unpairedSources: readReconciledUnpairedSources(registryPath),
  };
}

/**
 * Validate a delete now (protection, containment) and record it durably. Throws
 * when the delete would be refused; nothing is recorded then. Replaces any
 * earlier intent for the same source, which is how a refused one is retried.
 */
export function recordSourceDeleteIntent(input: {
  sourceId: string;
  registryPath: string;
  context: LifecyclePathContext;
}): SourceDeleteIntent {
  const plan = planSourceDelete({ sourceId: input.sourceId, ...input.context, registryPath: input.registryPath });
  const { intents } = readSourceDeleteIntents(input.registryPath);
  const intent: SourceDeleteIntent = {
    id: randomUUID(),
    source_id: plan.sourceId,
    corpora: plan.corpora,
    targets: plan.targets,
    verified_primaries: plan.verifiedPrimaries,
    bindings: plan.bindings,
    grant_epoch: readConnectedHandleGrantEpoch(input.registryPath),
    created_at: new Date().toISOString(),
    state: 'pending',
  };
  writeIntents(input.registryPath, [...intents.filter((entry) => entry.source_id !== plan.sourceId), intent]);
  return intent;
}

/** Drop an intent that was recorded but whose restart could not be requested. */
export function discardSourceDeleteIntent(registryPath: string, id: string): void {
  const { intents } = readSourceDeleteIntents(registryPath);
  writeIntents(registryPath, intents.filter((entry) => entry.id !== id));
}

export interface AppliedSourceDeletes {
  applied: string[];
  /**
   * Sources whose delete has begun and is not finished (an unlink failed, or
   * the stores could not be taken). Retried on the next start; the engine
   * host starts no service while any remains, because a service would reopen
   * the half-deleted stores.
   */
  incomplete: string[];
  refused: Array<{ sourceId: string; reason: SourceDeleteRefusal }>;
}

/**
 * Apply every pending intent. Runs before anything opens a store, and only
 * when `holders()` confirms every process that could hold one is verifiably
 * gone: otherwise every pending intent is refused (`holders_running`) and
 * nothing is deleted. The whole pass holds the credential-grant custody, so a
 * connection cannot be published between the re-check and the delete, and an
 * intent is bound to the grant generation it was judged against. Each intent
 * is re-validated against the settings as they are now; a refusal deletes
 * nothing and leaves the intent marked refused.
 */
export async function applyPendingSourceDeletes(input: {
  registryPath: string;
  context: LifecyclePathContext;
  log?: (line: string) => void;
  /** Test seam: how long to wait for exclusive custody of the stores. */
  custodyTimeoutMs?: number;
}): Promise<AppliedSourceDeletes> {
  const log = input.log ?? (() => undefined);
  const result: AppliedSourceDeletes = { applied: [], incomplete: [], refused: [] };
  const read = readSourceDeleteIntents(input.registryPath);
  if (read.unreadable) {
    log('pending source deletes: the intent record is unreadable; nothing was deleted.');
    return result;
  }
  if (read.intents.every((entry) => entry.state === 'refused')) return result;

  const refuseAll = (reason: SourceDeleteRefusal) => {
    const now = new Date().toISOString();
    const fresh = readSourceDeleteIntents(input.registryPath).intents;
    writeIntents(input.registryPath, fresh.map((entry) => entry.state === 'pending'
      ? { ...entry, state: 'refused' as const, reason, refused_at: now }
      : entry));
    for (const entry of fresh.filter((candidate) => candidate.state === 'pending')) {
      result.refused.push({ sourceId: entry.source_id, reason });
      log(`pending source deletes: ${entry.source_id} not deleted (${reason}).`);
    }
    for (const entry of fresh.filter((candidate) => candidate.state === 'applying')) result.incomplete.push(entry.source_id);
  };

  try {
    await withConnectedHandleGrantCustody(input.registryPath, {}, () => {
      let intents = readSourceDeleteIntents(input.registryPath).intents;
      for (const intent of intents.filter((entry) => entry.state !== 'refused')) {
        // `applying`: an earlier run began this delete and did not finish it.
        const resumed = intent.state === 'applying';
        let begun = resumed;
        let refusal: SourceDeleteRefusal | undefined;
        let hold: ReturnType<typeof tryHoldStoreCustodyExclusive>;
        try {
          if (!resumed && intent.grant_epoch !== undefined && intent.grant_epoch !== readConnectedHandleGrantEpoch(input.registryPath)) {
            refusal = 'connection_changed';
          } else {
            const plan = planSourceDelete({
              sourceId: intent.source_id,
              ...input.context,
              registryPath: input.registryPath,
              verifiedPrimaries: intent.verified_primaries ?? [],
            });
            if (JSON.stringify(plan.targets) !== JSON.stringify([...intent.targets].sort())) {
              refusal = 'settings_changed';
            } else if (intent.bindings && changedBinding(intent.bindings, plan.bindings)) {
              // A symlinked root retargeted, or a directory above a target
              // swapped, since the owner asked: the same names, another place.
              refusal = 'settings_changed';
            } else {
              // Exclusive store custody, kernel-held: every opener (the worker
              // in any mode, the embedding drain, repair scripts, CLI commands)
              // holds it shared for its whole life. Not obtainable: delete
              // nothing. Kept through the delete and the completion write, so
              // no opener can start between the check and the unlink.
              hold = tryHoldStoreCustodyExclusive({
                ...(input.context.homeDir ? { homeDir: input.context.homeDir } : {}),
                ...(input.custodyTimeoutMs !== undefined ? { timeoutMs: input.custodyTimeoutMs } : {}),
              });
              if (!hold) {
                refusal = 'holders_running';
              } else {
                const custody = dataDeleteCustody({ ...sourceDeleteCustodyInput(intent.source_id, input.registryPath), ...input.context });
                if (!custody.ready && !resumed) refusal = 'not_disconnected';
                else {
                  if (!resumed) {
                    // From here some store may be gone: the record says so, durably,
                    // before the first unlink, and is never downgraded to a refusal.
                    intents = intents.map((entry) => entry.id === intent.id ? { ...entry, state: 'applying' as const } : entry);
                    writeIntents(input.registryPath, intents);
                    begun = true;
                  }
                  deleteOlympusDataWithCustody({
                    ...sourceDeleteCustodyInput(intent.source_id, input.registryPath),
                    ...input.context,
                    registryPath: input.registryPath,
                    verifiedPrimaries: intent.verified_primaries ?? [],
                    ...(intent.bindings ? { expectedBindings: intent.bindings } : {}),
                  });
                }
              }
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          refusal = error instanceof OperationError && /overlaps|symbolic link|Refusing to delete/.test(message)
            ? 'protected_path'
            : 'failed';
          log(`pending source deletes: ${intent.source_id}: ${message}`);
        }
        try {
          // A delete that has begun is retried, not refused, unless a preflight
          // now says the recorded targets are no longer safe to touch.
          const unfinished = refusal !== undefined && begun
            && (refusal === 'failed' || refusal === 'holders_running');
          if (unfinished) {
            result.incomplete.push(intent.source_id);
            log(`pending source deletes: ${intent.source_id} is only partly deleted (${refusal}); it will be retried and the engine will not start meanwhile.`);
          } else if (refusal) {
            intents = intents.map((entry) => entry.id === intent.id
              ? { ...entry, state: 'refused' as const, reason: refusal, refused_at: new Date().toISOString() }
              : entry);
            result.refused.push({ sourceId: intent.source_id, reason: refusal });
            log(`pending source deletes: ${intent.source_id} not deleted (${refusal}).`);
            writeIntents(input.registryPath, intents);
          } else {
            intents = intents.filter((entry) => entry.id !== intent.id);
            result.applied.push(intent.source_id);
            log(`pending source deletes: ${intent.source_id} deleted.`);
            writeIntents(input.registryPath, intents);
          }
        } finally {
          hold?.release();
        }
      }
    });
  } catch (error) {
    if (!(error instanceof ConnectedHandleGrantMutationError)) throw error;
    // A connection change is in progress: do not race it. The owner asks again.
    log('pending source deletes: a connection change was in progress; nothing was deleted.');
    refuseAll('failed');
  }
  return result;
}

/** Per source, for the dashboard: deleting now, or the delete did not run. */
export function sourceDeleteStates(registryPath: string): Record<string, { state: 'pending' | 'refused'; reason?: SourceDeleteRefusal }> {
  const out: Record<string, { state: 'pending' | 'refused'; reason?: SourceDeleteRefusal }> = {};
  try {
    for (const intent of readSourceDeleteIntents(registryPath).intents) {
      out[intent.source_id] = { state: intent.state === 'applying' ? 'pending' : intent.state, ...(intent.reason ? { reason: intent.reason } : {}) };
    }
  } catch { /* the dashboard shows no delete state rather than fail to render */ }
  return out;
}
