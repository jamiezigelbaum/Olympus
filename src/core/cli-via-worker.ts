/**
 * A CLI command that opens stores never opens them from the CLI process while
 * Olympus runs (docs/design/source-storage.md, principle 4 and "Owner lock").
 *
 * - The owner lock is free: the command takes it and runs here, as always.
 * - It is busy and the running worker answers: the worker does the work, over
 *   its authenticated local API, and the CLI prints what it returns.
 * - It is busy and no worker answers (an operator script holds it): the
 *   command refuses with `DataOwnerBusyError`'s message.
 *
 * This is the one place the CLI decides that. The worker's side is
 * `workers/cli-operations.ts`; the routes sit under `/v1/cli/`, behind the
 * worker bearer like every other route the relay does not forward.
 *
 * Deliberately light (config, auth and transport only): the CLI imports it.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, normalizeSourceWorkerBaseUrl } from './config.ts';
import { DataOwnerBusyError, STOP_OLYMPUS_HINT, tryDataOwnerLock } from './data-owner-lock.ts';
import { olympusDataRoot, type LayoutEnv } from './olympus-layout.ts';
import { OperationError, type OperationErrorCode } from './operation-error.ts';
import { resolveWorkerAuthToken, withWorkerAuthHeader } from './worker-auth.ts';
import { createWorkerFetch } from './worker-transport.ts';

/** The route family, under the worker's API base (`/v1`). */
export const WORKER_CLI_ROUTE_PREFIX = '/cli/';

/** What the worker runs for a CLI command while it owns the data. */
export const WORKER_CLI_OPERATIONS = ['ingestion-status', 'data-export', 'data-delete', 'tier', 'pairing-placement'] as const;
export type WorkerCliOperation = (typeof WORKER_CLI_OPERATIONS)[number];

/** How long a worker gets to answer a health probe before it counts as not answering. */
const WORKER_CONNECT_TIMEOUT_MS = 5_000;

/** No worker answered: nothing is listening, the socket is gone, or it did not answer in time. */
export class WorkerUnreachableError extends Error {
  constructor(detail: string) {
    super(`No Olympus worker answered (${detail}).`);
    this.name = 'WorkerUnreachableError';
  }
}

/**
 * Run `local` under the owner lock when it is free. When the running worker
 * owns the data, run `viaWorker` instead; a worker that does not answer makes
 * the command refuse, as `DataOwnerBusyError`. A command with no `viaWorker`
 * (one that must not run beside Olympus) refuses the same way.
 */
export async function runLocallyOrThroughWorker<T>(
  local: () => T | Promise<T>,
  viaWorker: (() => Promise<T>) | undefined,
  env: LayoutEnv = process.env,
): Promise<T> {
  const lock = tryDataOwnerLock(env);
  if (lock) {
    try {
      return await local();
    } finally {
      lock.release();
    }
  }
  if (!viaWorker) throw new DataOwnerBusyError(olympusDataRoot(env));
  try {
    return await viaWorker();
  } catch (error) {
    if (error instanceof WorkerUnreachableError) throw new DataOwnerBusyError(olympusDataRoot(env));
    throw error;
  }
}

/**
 * A data root as the CLI and the worker compare it: through symlinks when it
 * exists (a busy owner lock means it does), as given otherwise.
 */
export function canonicalDataRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

export interface WorkerCliCallOptions {
  env?: LayoutEnv;
  /** Test seam: replaces the worker transport (the owner socket on Linux, plain fetch elsewhere). */
  fetchImpl?: typeof fetch;
  connectTimeoutMs?: number;
}

/**
 * Ask the running worker to run one CLI operation and return its result.
 *
 * The worker is reached as the embedding drain reaches it: the worker
 * transport, the configured worker URL and the worker bearer. A short health
 * probe tells a worker that is not answering from one that is busy working;
 * the operation itself has no timeout (an export can run for minutes).
 */
export async function callWorkerCli<T = unknown>(
  operation: WorkerCliOperation,
  body: Record<string, unknown>,
  options: WorkerCliCallOptions = {},
): Promise<T> {
  const env = options.env ?? process.env;
  const config = loadConfig(env);
  // The token the worker authenticates with (its environment, then worker.env), not a stale config's.
  const authToken = resolveWorkerAuthToken(env, config);
  if (!authToken) throw new WorkerUnreachableError('this command has no worker token to present');
  const baseUrl = normalizeSourceWorkerBaseUrl(config.email.baseUrl);
  const fetchImpl = options.fetchImpl ?? createWorkerFetch({ env });

  try {
    const probe = await fetchImpl(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(options.connectTimeoutMs ?? WORKER_CONNECT_TIMEOUT_MS),
    });
    await probe.body?.cancel().catch(() => {});
  } catch (error) {
    throw new WorkerUnreachableError(error instanceof Error ? error.message : String(error));
  }

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${WORKER_CLI_ROUTE_PREFIX}${operation}`, withWorkerAuthHeader({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A busy lock says only that someone holds this command's data root; the
      // worker that answers checks it is the root it owns before acting.
      body: JSON.stringify({ ...body, data_root: canonicalDataRoot(olympusDataRoot(env)) }),
    }, authToken));
  } catch (error) {
    // The worker answered a moment ago and is gone now (it restarted, or died
    // mid-request): its work may or may not have happened, so say so.
    throw new OperationError(
      'source_index_error',
      `The running Olympus stopped answering while it ran this command (${error instanceof Error ? error.message : String(error)}).`,
      'Check olympus engine status, then look at the result before running the command again.',
    );
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (response.ok) {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
    throw new OperationError('source_index_error', 'The running Olympus answered this command with something unreadable.');
  }

  const failure = (parsed as { error?: { code?: unknown; message?: unknown; suggestion?: unknown } } | undefined)?.error;
  if (response.status === 401) {
    throw new OperationError(
      'config_error',
      'The running Olympus did not accept this command\'s worker token.',
      `Run it with the configuration the running Olympus uses, or stop Olympus first (${STOP_OLYMPUS_HINT}).`,
    );
  }
  if (response.status === 404) {
    throw new OperationError(
      'config_error',
      'The running Olympus is older than this command and cannot run it.',
      `Update and restart Olympus, or stop it first (${STOP_OLYMPUS_HINT}).`,
    );
  }
  if (typeof failure?.code === 'string' && typeof failure.message === 'string') {
    // The worker's own code and words, printed as the local command would.
    throw new OperationError(
      failure.code as OperationErrorCode,
      failure.message,
      typeof failure.suggestion === 'string' ? failure.suggestion : undefined,
    );
  }
  throw new OperationError('source_index_error', `The running Olympus could not run this command (HTTP ${response.status}).`);
}
