/**
 * `olympus setup status` and the `olympus_setup_status` agent tool (#1077):
 * the running Olympus builds the checklist (workers/setup-status.ts, through
 * its `setup-status` CLI route, which only the worker bearer reaches and the
 * relay never forwards); when nothing answers, the same builder says so with
 * every unknown step left to do. Read-only.
 */
import { callWorkerCli, WorkerUnreachableError } from './cli-via-worker.ts';
import type { OlympusConfig } from './config.ts';
import { OperationError } from './operation-error.ts';
import { buildSetupChecklist, parseSetupChecklist, type SetupChecklist } from './setup-checklist.ts';
import { runningOlympusVersion } from './update-check.ts';

export interface SetupStatusOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  version?: string;
  /** A native tool's plugin configuration: its worker URL and token, not the command line's. */
  config?: OlympusConfig;
}

export async function readSetupStatus(options: SetupStatusOptions = {}): Promise<SetupChecklist> {
  const env = options.env ?? process.env;
  let answer: unknown;
  try {
    answer = await callWorkerCli('setup-status', {}, { env, ...(options.config ? { config: options.config } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  } catch (error) {
    if (!(error instanceof WorkerUnreachableError)) throw error;
    return buildSetupChecklist({ version: options.version ?? runningOlympusVersion(), running: false });
  }
  const checklist = parseSetupChecklist(answer);
  if (!checklist) {
    throw new OperationError('source_index_error', 'The running Olympus answered setup status in a form this command does not read.', 'Update Olympus so the command and the running engine match, then run olympus setup status again.');
  }
  return checklist;
}

export const SETUP_STATUS_USAGE = 'olympus setup status [--text]';

/** Parse `olympus setup status` arguments: `--text` for the readable form, JSON otherwise. */
export function parseSetupStatusArgs(args: readonly string[]): { text: boolean } {
  let text = false;
  for (const arg of args) {
    if (arg === '--text') text = true;
    else if (arg === '--json') text = false;
    else throw new OperationError('invalid_params', `Usage: ${SETUP_STATUS_USAGE}`);
  }
  return { text };
}
