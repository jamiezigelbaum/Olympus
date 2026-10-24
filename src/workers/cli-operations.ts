/**
 * What the worker runs for a CLI command while it owns the data
 * (core/cli-via-worker.ts is the CLI's side; docs/design/source-storage.md,
 * "Owner lock"). Each operation is the function the CLI runs itself when the
 * owner lock is free, so a command prints the same thing either way.
 *
 * The routes (`POST /v1/cli/<operation>`, mounted in email-source/index.ts)
 * sit behind the worker bearer. The relay forwards none of them
 * (connect-relay/client/forward.ts) and a dashboard cookie alone reaches none
 * (workers/http.ts); the handlers stay thin: parse, call, return.
 */
import { isAbsolute } from 'node:path';
import { loadConfig } from '../core/config.ts';
import { STOP_OLYMPUS_HINT } from '../core/data-owner-lock.ts';
import { OperationError } from '../core/operation-error.ts';
import { exportOlympusData, type DataExportResult } from '../data-lifecycle.ts';
import {
  runTierCommand,
  tierCommandOpensStores,
  tierCommandRewritesStores,
} from './classification/tier-cli.ts';
import { collectLocalSourceIngestionLedger } from './source-ingestion-ledger.ts';

const TIER_ARGS_MAX = 64;
const TIER_ARG_MAX_LENGTH = 4096;

/** `olympus ingestion status`: the ledger, collected in this process. */
export function ingestionStatusForCli() {
  return collectLocalSourceIngestionLedger({ config: loadConfig() });
}

/**
 * `olympus data export`: the export, written by this process as this user.
 * The CLI sends an absolute folder (this process's working directory is not
 * the caller's).
 */
export function exportForCli(body: Record<string, unknown>): DataExportResult {
  const output = typeof body.output === 'string' ? body.output : '';
  if (!isAbsolute(output)) throw new OperationError('invalid_params', 'The export folder must be an absolute path.');
  const sourceId = typeof body.source_id === 'string' && body.source_id.trim() ? body.source_id : undefined;
  try {
    return exportOlympusData({ destination: output, ...(sourceId ? { sourceId } : {}) });
  } catch (error) {
    throw explainExportFailure(error, output);
  }
}

/**
 * A write this worker's own user may not make fails here, not in the CLI that
 * asked, and macOS decides it by who the writer is (the Olympus Engine, not
 * the Terminal the owner typed in): say so, rather than fail obscurely.
 */
function explainExportFailure(error: unknown, output: string): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !/^E[A-Z0-9]+$/.test(code)) return error;
  const message = error instanceof Error ? error.message : code;
  if (code !== 'EPERM' && code !== 'EACCES') {
    return new OperationError('source_index_error', `The running Olympus could not write the export to ${output}: ${message}`);
  }
  return new OperationError(
    'source_index_error',
    `The running Olympus could not write the export to ${output} (${code === 'EPERM' ? 'not permitted' : 'permission denied'}).`,
    process.platform === 'darwin'
      ? 'The running Olympus writes the export itself, as Olympus Engine, and macOS limits what it may write: '
        + 'Desktop, Documents, Downloads, iCloud Drive and removable or network disks need its permission '
        + '(System Settings > Privacy & Security > Files & Folders). Choose another folder, '
        + `or stop Olympus first (${STOP_OLYMPUS_HINT}) to export as yourself.`
      : 'The running Olympus writes the export itself, as the user it runs as. '
        + `Choose a folder it may write to, or stop Olympus first (${STOP_OLYMPUS_HINT}).`,
  );
}

/**
 * `olympus tier set|explain|migrate ...`: only the commands that open stores
 * and leave them in place. A command that rewrites the stores the worker's
 * lanes write (`migrate run`, `rollback`, `purge --approve`) does not run
 * beside Olympus, whoever asks.
 */
export async function tierForCli(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const args = body.args;
  if (
    !Array.isArray(args)
    || args.length > TIER_ARGS_MAX
    || !args.every((arg): arg is string => typeof arg === 'string' && arg.length <= TIER_ARG_MAX_LENGTH)
  ) {
    throw new OperationError('invalid_params', 'args must be a short list of strings.');
  }
  if (!tierCommandOpensStores(args)) {
    throw new OperationError('invalid_params', 'This tier command does not need the running Olympus; run it from the command line.');
  }
  if (tierCommandRewritesStores(args)) {
    throw new OperationError(
      'invalid_params',
      'This tier command rewrites stores Olympus is writing, so it cannot run while Olympus runs.',
      `Stop Olympus first (${STOP_OLYMPUS_HINT}), then run it again.`,
    );
  }
  return runTierCommand(args);
}
