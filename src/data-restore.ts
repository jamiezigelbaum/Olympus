/**
 * `olympus data restore --input <dir>`: put an export back onto a fresh
 * install (#1065).
 *
 * An export (src/data-lifecycle.ts) holds each account's connector stores
 * with their tier sidecars (the privacy judgments), and the owner's own
 * settings and rules. A restore checks the export first, refuses to write
 * over anything this computer already holds, puts each file where this
 * install keeps it, and names the sources to sign in to again: sign-ins and
 * session secrets are never in an export, so they never come back.
 *
 * Embeddings travel inside the stores, with the model identity that made
 * them, and judgments travel in the tier ledgers beside them, so an install
 * running the same models neither embeds nor judges again.
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  lifecycleAccountFiles,
  lifecycleEnv,
  lifecycleStoreLayouts,
  verifyOlympusDataExport,
  type DataExportArtifact,
  type LifecyclePathContext,
} from './data-lifecycle.ts';
import { OperationError } from './core/operation-error.ts';
import { syncDirectorySync } from './core/atomic-file.ts';
import { defaultSovereigntyConfigPath } from './core/sovereignty.ts';
import {
  secretLocationsPathForStore,
  tierLedgerPathForStore,
  tierSnifferPathForStore,
} from './workers/classification/tier-ledger-path.ts';
import { resolveTierRulesPath } from './workers/classification/tier-rules.ts';
import { resolveSourceIngestionExclusionsPath } from './workers/source-dispositions.ts';
import { Database } from 'bun:sqlite';
import { TIER_SET_BINDING_CONNECTOR_ID, TIER_SET_BINDING_RUN_ID } from './workers/connector-store/local-index.ts';
import { TierLedger } from './workers/classification/tier-ledger.ts';
import { TIER_LEDGER_FILE_SUFFIX } from './workers/classification/tier-ledger-path.ts';

export interface DataRestorePlanEntry {
  /** The file in the export, relative to it. */
  from: string;
  /** Where this install keeps it. */
  to: string;
  sourceId: string;
  kind: 'store' | 'judgments' | 'owner_settings';
  /** An owner settings file this computer already has: kept beside the restored one. */
  keptAs?: string;
}

export interface DataRestoreResult {
  ok: true;
  input: string;
  dryRun: boolean;
  exportVersion: number;
  sourceIds: string[];
  restored: DataRestorePlanEntry[];
  /** Every restored source needs its sign-in again: an export never holds one. */
  signInAgain: string[];
  notes: string[];
}

interface ManifestShape {
  version: number;
  source_ids?: unknown;
  artifacts: DataExportArtifact[];
}

export function restoreOlympusData(options: { input: string; dryRun?: boolean } & LifecyclePathContext): DataRestoreResult {
  const input = resolve(options.input);
  // Every byte is checked against the manifest before anything is written.
  verifyOlympusDataExport({ destination: input });
  const manifest = JSON.parse(readFileSync(join(input, 'manifest.json'), 'utf8')) as ManifestShape;
  const context: LifecyclePathContext = {
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
  const env = lifecycleEnv(context);
  const notes: string[] = [];
  const plan: DataRestorePlanEntry[] = [];
  const storesBySource = new Map<string, string[]>();
  const storesOf = (sourceId: string): string[] => {
    let stores = storesBySource.get(sourceId);
    if (!stores) {
      stores = lifecycleAccountFiles(sourceId, context).stores;
      storesBySource.set(sourceId, stores);
    }
    return stores;
  };
  const storeTarget = (artifact: DataExportArtifact): string => {
    const stores = storesOf(artifact.sourceId);
    if (artifact.storeIndex !== undefined) {
      const target = stores[artifact.storeIndex];
      if (target) return target;
    } else {
      // A version 2 export names a store only by its file name, as the
      // install that made it kept it (legacy or folder layout).
      const name = artifact.relativePath.split('/').pop();
      for (const layout of lifecycleStoreLayouts(artifact.sourceId, context)) {
        const index = layout.findIndex((path) => path.split('/').pop() === name);
        if (index >= 0 && stores[index]) return stores[index]!;
      }
    }
    throw new OperationError(
      'invalid_params',
      `This backup holds a ${artifact.sourceId} store this version of Olympus does not keep (${artifact.relativePath}).`,
      'Restore with the Olympus version that made the backup, then update.',
    );
  };

  let sawJudgments = false;
  for (const artifact of manifest.artifacts) {
    const from = artifact.relativePath;
    switch (artifact.role) {
      case 'connector_store':
        plan.push({ from, to: storeTarget(artifact), sourceId: artifact.sourceId, kind: 'store' });
        break;
      case 'tier_sidecar': {
        const store = storeTarget(artifact);
        const to = artifact.sidecar === 'tier_ledger' ? tierLedgerPathForStore(store)
          : artifact.sidecar === 'tier_sniffer' ? tierSnifferPathForStore(store)
            : artifact.sidecar === 'secret_locations' ? secretLocationsPathForStore(store)
              : undefined;
        if (!to) throw new OperationError('invalid_params', `The backup names an unknown file beside a store: ${from}.`);
        if (artifact.sidecar === 'tier_ledger') sawJudgments = true;
        plan.push({ from, to, sourceId: artifact.sourceId, kind: 'judgments' });
        break;
      }
      case 'legacy_store':
        // A pre-1.0 per-family index: the stores beside it hold the same items
        // in today's layout, which is what an install opens.
        notes.push(`Left out ${from}: an index from before Olympus 1.0, which this install doesn't open.`);
        break;
      case 'owner_rules': {
        const to = artifact.ownerFile === 'tier_rules' ? resolveTierRulesPath({ env })
          : artifact.ownerFile === 'ingestion_exclusions' ? resolveSourceIngestionExclusionsPath(env)
            : undefined;
        if (!to) throw new OperationError('invalid_params', `The backup names an unknown settings file: ${from}.`);
        plan.push({ from, to, sourceId: 'olympus.config', kind: 'owner_settings' });
        break;
      }
      case 'sanitized_config':
        if (from.endsWith('config/sovereignty.json')) {
          plan.push({ from, to: sovereigntyPath(options.homeDir, env), sourceId: 'olympus.config', kind: 'owner_settings' });
        } else if (from.endsWith('config/config.json')) {
          // This install's own config holds its worker token and paths; the
          // backup's copy has neither, so it is never written over it.
          notes.push('Kept this computer\'s config.json: it holds this install\'s own connection settings.');
        } else {
          // A source's own settings (for example Dropbox's ingestion policy).
          plan.push({ from, to: sourceSettingsTarget(artifact, context), sourceId: artifact.sourceId, kind: 'owner_settings' });
        }
        break;
      default:
        throw new OperationError('invalid_params', `The backup holds a file this version of Olympus does not know: ${from}.`);
    }
  }
  // A store that already holds tier-routed copies is bound to the ledger that
  // judged them, and opens only beside that ledger. A backup that has such a
  // store without its ledger (version 2 exported none) cannot be judged again
  // into a new one, so it is refused before anything is written.
  const ledgerSources = new Set(plan.filter((entry) => entry.kind === 'judgments' && entry.to.endsWith(TIER_LEDGER_FILE_SUFFIX)).map((entry) => entry.sourceId));
  const unbound = plan.filter((entry) => entry.kind === 'store' && !ledgerSources.has(entry.sourceId) && storeIsTierBound(join(input, entry.from)));
  if (unbound.length > 0) {
    throw new OperationError(
      'invalid_params',
      `This backup holds ${[...new Set(unbound.map((entry) => entry.sourceId))].join(', ')} items that were judged into Private or Secret stores, but not the judgments themselves, so they could not be opened after a restore. Nothing was restored.`,
      'Make a new backup with this version of Olympus (olympus data export), then restore that one.',
    );
  }
  if (manifest.version < 3 || !sawJudgments) {
    notes.push('This backup has no privacy judgments, so Olympus judges the restored items again.');
  }

  // A restore never writes over data: an install that already holds a store
  // is not a fresh one, and merging two histories is not what was asked.
  // Every store and sidecar a restored source owns counts, not only the ones
  // in the backup: a backup with one tier's store must not land beside
  // another tier's store and ledger already here.
  const holds = (path: string): boolean => existsSync(path) && statSync(path).size > 0;
  const restoredSources = [...new Set(plan.filter((entry) => entry.kind !== 'owner_settings').map((entry) => entry.sourceId))];
  const occupiedSources = restoredSources.filter((sourceId) => storesOf(sourceId).some((store) => [
    store,
    tierLedgerPathForStore(store),
    tierSnifferPathForStore(store),
    secretLocationsPathForStore(store),
  ].some(holds)));
  if (occupiedSources.length > 0) {
    const sources = occupiedSources;
    throw new OperationError(
      'invalid_params',
      `This computer already holds Olympus data for ${sources.join(', ')}, so nothing was restored.`,
      'Restore onto a fresh install, or delete that data first with olympus data delete --source <id>.',
    );
  }
  for (const entry of plan) {
    if (entry.kind === 'owner_settings' && existsSync(entry.to)) entry.keptAs = `${entry.to}.before-restore`;
  }

  const sourceIds = [...new Set(plan.filter((entry) => entry.kind === 'store').map((entry) => entry.sourceId))];
  if (!options.dryRun) {
    // A bound store records where its ledger was on the computer that made
    // the backup. That path is only a hint (the ledger's identity binds), but
    // on this computer the ledger may sit under another name, so the hint is
    // pointed at where the restore puts it.
    const ledgers = plan
      .filter((entry) => entry.kind === 'judgments' && entry.to.endsWith(TIER_LEDGER_FILE_SUFFIX))
      .map((entry) => ({ sourceId: entry.sourceId, to: entry.to, id: TierLedger.readLedgerId(join(input, entry.from)) }));
    for (const entry of plan) {
      if (entry.keptAs) copyPrivate(entry.to, entry.keptAs);
      const prepare = entry.kind === 'store'
        ? (staged: string) => repointLedgerHint(staged, (id) => ledgers.find((ledger) => ledger.sourceId === entry.sourceId && ledger.id === id)?.to)
        : undefined;
      copyPrivate(join(input, entry.from), entry.to, prepare);
    }
  }
  return {
    ok: true,
    input,
    dryRun: options.dryRun === true,
    exportVersion: manifest.version,
    sourceIds,
    restored: plan,
    signInAgain: sourceIds,
    notes,
  };
}

/** Copy owner-only and durably: a temporary file beside the target, then rename. */
function copyPrivate(from: string, to: string, prepare?: (staged: string) => void): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const staging = `${to}.${randomUUID()}.restoring`;
  try {
    copyFileSync(from, staging);
    chmodSync(staging, 0o600);
    prepare?.(staging);
    // The contents reach the disk before the name does.
    const descriptor = openSync(staging, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(staging, to);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
  syncDirectorySync(dirname(to));
}

function sovereigntyPath(homeDir: string | undefined, env: Record<string, string | undefined>): string {
  if (homeDir && process.platform !== 'linux') return join(homeDir, '.olympus', 'sovereignty.json');
  return defaultSovereigntyConfigPath(env);
}

function sourceSettingsTarget(artifact: DataExportArtifact, context: LifecyclePathContext): string {
  const name = artifact.relativePath.split('/').pop();
  const target = lifecycleAccountFiles(artifact.sourceId, context).settings.find((path) => path.split('/').pop() === name);
  if (!target) {
    throw new OperationError('invalid_params', `The backup holds a ${artifact.sourceId} settings file this version of Olympus does not keep: ${artifact.relativePath}.`);
  }
  return target;
}

/** Whether a store in the backup is bound to a tier ledger (it holds routed copies). */
function storeIsTierBound(path: string): boolean {
  const db = new Database(path, { readonly: true });
  try {
    const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_runs'").get();
    if (!table) return false;
    const row = db.query('SELECT cursor FROM sync_runs WHERE sync_run_id = ? AND connector_id = ?').get(TIER_SET_BINDING_RUN_ID, TIER_SET_BINDING_CONNECTOR_ID) as { cursor: string | null } | null;
    return Boolean(row?.cursor);
  } finally {
    db.close();
  }
}

/** Point a bound store's ledger hint at where this computer keeps that ledger; the identity is unchanged. */
function repointLedgerHint(storePath: string, ledgerFor: (ledgerId: string) => string | undefined): void {
  if (!storeIsTierBound(storePath)) return;
  const db = new Database(storePath, { readwrite: true, create: false });
  try {
    const row = db.query('SELECT cursor FROM sync_runs WHERE sync_run_id = ? AND connector_id = ?').get(TIER_SET_BINDING_RUN_ID, TIER_SET_BINDING_CONNECTOR_ID) as { cursor: string };
    const binding = JSON.parse(row.cursor) as { ledgerId?: unknown; ledgerPath?: unknown };
    if (typeof binding.ledgerId !== 'string') return;
    const ledgerPath = ledgerFor(binding.ledgerId);
    if (!ledgerPath || ledgerPath === binding.ledgerPath) return;
    db.query('UPDATE sync_runs SET cursor = ? WHERE sync_run_id = ? AND connector_id = ?')
      .run(JSON.stringify({ ...binding, ledgerPath }), TIER_SET_BINDING_RUN_ID, TIER_SET_BINDING_CONNECTOR_ID);
  } finally {
    db.close();
  }
}
