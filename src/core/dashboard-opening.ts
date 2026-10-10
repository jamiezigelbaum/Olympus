/**
 * Minting the dashboard's one-time opening link (`/dashboard/launch#…`).
 *
 * Shared by `olympus dashboard` / `olympus open` (src/cli.ts) and the
 * `olympus_open_remote` agent tool (core/remote-open-tool.ts), so both ask
 * this install's OWN worker the same way: the bearer travels only to the
 * configured worker origin, a redirect is refused, and the returned link
 * carries a single-use 15-minute ticket bound to that origin (port included;
 * core/dashboard-launch.ts), never the worker token.
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY } from './dashboard-launch.ts';
import { DASHBOARD_LAUNCH_OPEN_KEY, openTargetToken, type OpenTarget } from './open-targets.ts';
import { OperationError } from './operation-error.ts';

export type DashboardFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface DashboardOpeningMintOptions {
  /** The bearer-mint round trip. Injected by tests; production uses fetch. */
  fetchImpl?: DashboardFetch;
  /** Where the opened dashboard lands; the plain dashboard when absent. */
  target?: OpenTarget;
}

/**
 * How a user-facing sentence names the Olympus CLI.
 *
 * `olympus` is not on PATH after a clean install — the install guide runs it as
 * `"$OLYMPUS_BIN"` for exactly that reason — so a bare command sends the reader
 * to "command not found" (clean-install rehearsal, 2026-09-05). Same phrasing
 * the dashboard's worker-token gate uses.
 */
export const OLYMPUS_PLUGIN_BIN_HINT = '<rootDir>/bin/olympus';

/**
 * The command to print: plain `olympus` when that is on PATH (the reader can
 * type it), else this install's own bin/olympus, else the placeholder.
 * Read per call, never at import (bundled dist stays lean). This file runs as
 * src/core/*.ts and bundled as dist/*.js, so the install root is one or two
 * levels up.
 */
export function olympusCommandHint(input: { env?: Record<string, string | undefined>; pluginBin?: string } = {}): string {
  const env = input.env ?? process.env;
  const isExecutable = (path: string): boolean => {
    try {
      accessSync(path, fsConstants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  const dirs = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  if (dirs.some((dir) => isExecutable(join(dir, 'olympus')))) return 'olympus';
  const candidates = input.pluginBin !== undefined
    ? [input.pluginBin]
    : [resolve(import.meta.dir, '..', 'bin', 'olympus'), resolve(import.meta.dir, '..', '..', 'bin', 'olympus')];
  const own = candidates.find(isExecutable);
  if (own && !/\s/.test(own)) return own;
  return OLYMPUS_PLUGIN_BIN_HINT;
}

const DASHBOARD_LAUNCH_REQUEST_TIMEOUT_MS = 10_000;

/** The worker ROOT: the configured base without its /v1 API suffix. */
export function workerRootBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new OperationError(
      'config_error',
      'The configured worker URL is not a valid URL.',
      'Set OLYMPUS_EMAIL_BASE_URL to the worker origin, for example http://127.0.0.1:8010/v1.',
    );
  }
  if (url.username || url.password) {
    throw new OperationError('config_error', 'The configured worker URL must not carry embedded credentials.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OperationError(
      'config_error',
      'The configured worker URL must use HTTP or HTTPS.',
      'Set OLYMPUS_EMAIL_BASE_URL to the worker origin, for example http://127.0.0.1:8010/v1.',
    );
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/' && path !== '/v1') {
    throw new OperationError(
      'config_error',
      'The configured worker URL path must be /v1 or the origin root.',
      'Set OLYMPUS_EMAIL_BASE_URL to the worker origin, for example http://127.0.0.1:8010/v1.',
    );
  }
  return url.origin;
}

/**
 * Mint the opening ticket from this install's own worker.
 *
 * `redirect: 'error'` is the load-bearing part: the bearer travels with this
 * request, so a worker (or anything answering as one) that tries to redirect
 * it is refused outright rather than followed to a host the reader never
 * configured. A refusal, an invalid body, or an unreachable worker is an
 * error naming that worker — never a silent downgrade to the old link.
 */
export async function mintDashboardOpeningUrl(
  base: string,
  token: string | undefined,
  dependencies: DashboardOpeningMintOptions = {},
): Promise<string> {
  if (!token) {
    throw new OperationError(
      'config_error',
      'No worker auth token is configured, so there is nothing to unlock.',
      `Run ${olympusCommandHint()} setup first; the token is written to worker.env as OLYMPUS_WORKER_AUTH_TOKEN.`,
    );
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${base}/dashboard/control/launch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Origin: base },
      redirect: 'error',
      signal: AbortSignal.timeout(DASHBOARD_LAUNCH_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new OperationError(
      'email_unreachable',
      'The configured Olympus worker did not answer the opening request.',
      `Start the worker (${olympusCommandHint()} worker status) and run this again.`,
    );
  }
  if (!response.ok) {
    throw new OperationError(
      'email_unreachable',
      `The configured Olympus worker refused the opening request with HTTP ${response.status}.`,
      `Check ${olympusCommandHint()} worker status, then run this again.`,
    );
  }
  let ticket: unknown;
  try {
    ticket = (await response.json() as { ticket?: unknown }).ticket;
  } catch {
    ticket = undefined;
  }
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
    throw new OperationError(
      'email_unreachable',
      'The configured Olympus worker answered the opening request without a ticket.',
      'This worker predates the standalone opening handoff; upgrade it, then run this again.',
    );
  }
  const openToken = dependencies.target ? openTargetToken(dependencies.target) : undefined;
  return `${base}/dashboard/launch#${DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY}=${encodeURIComponent(ticket)}`
    + (openToken ? `&${DASHBOARD_LAUNCH_OPEN_KEY}=${openToken}` : '');
}
