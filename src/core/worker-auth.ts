import { createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OlympusConfig } from './config.ts';

export interface WorkerAuthTokenLookupOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  workerEnvPath?: string;
}

export interface WorkerSetupEnvLoadResult {
  loaded: boolean;
  path: string;
  keys: string[];
}

export function workerAuthTokenFromConfig(
  config: OlympusConfig,
  options: WorkerAuthTokenLookupOptions = {},
): string | undefined {
  if (config.worker.authTokenSecretRefUnresolved) return undefined;
  return (
    optionalToken(config.worker.authToken)
    ?? optionalToken((options.env ?? process.env).OLYMPUS_WORKER_AUTH_TOKEN)
    ?? workerAuthTokenFromSetupEnv(options)
  );
}

/**
 * The worker bearer token, resolved at each call instead of captured once.
 *
 * A token that comes only from worker.env can change while the Gateway runs:
 * the plugin registers when OpenClaw loads it — on a first install that is
 * before `olympus setup` has minted any token — and a token captured then made
 * every tool call fail 401 against the worker setup started, until a manual
 * Gateway restart (first install on a clean Linux user, 2026-09-23). Resolving
 * per call keeps the precedence and the unresolved-SecretRef refusal of
 * `workerAuthTokenFromConfig`; only the worker.env layer can move, and its read
 * is cached on the file's stat.
 */
export function workerAuthTokenProvider(
  config: OlympusConfig,
  options: WorkerAuthTokenLookupOptions = {},
): () => string | undefined {
  return () => workerAuthTokenFromConfig(config, options);
}

export function withWorkerAuthHeader(init: RequestInit, authToken: string | undefined): RequestInit {
  const token = optionalToken(authToken);
  if (!token) return init;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return {
    ...init,
    headers,
  };
}

export function dashboardQueryTokenFromWorkerAuthToken(authToken: string | undefined): string | undefined {
  const token = optionalToken(authToken);
  if (!token) return undefined;
  return `dash_${createHmac('sha256', token)
    .update('olympus-dashboard-query-token-v1')
    .digest('base64url')}`;
}

export function workerAuthTokenFromSetupEnv(options: WorkerAuthTokenLookupOptions = {}): string | undefined {
  return optionalToken(readWorkerSetupEnv(options)?.OLYMPUS_WORKER_AUTH_TOKEN);
}

export function applyWorkerSetupEnv(options: WorkerAuthTokenLookupOptions = {}): WorkerSetupEnvLoadResult {
  const targetEnv = options.env ?? process.env;
  const path = workerSetupEnvPath(options);
  const setupEnv = readWorkerSetupEnv({ ...options, workerEnvPath: path });
  if (!setupEnv) return { loaded: false, path, keys: [] };
  const keys: string[] = [];
  for (const [key, value] of Object.entries(setupEnv)) {
    if (targetEnv[key]?.trim()) continue;
    targetEnv[key] = value;
    keys.push(key);
  }
  return { loaded: true, path, keys };
}

export function readWorkerSetupEnv(options: WorkerAuthTokenLookupOptions = {}): Record<string, string> | undefined {
  const path = workerSetupEnvPath(options);
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile() || (stat.mode & 0o077n) !== 0n) return undefined;
    // Long-lived Gateway callers read this per request; the key changes on any
    // rewrite, in place (mtime/ctime/size) or by atomic rename (inode).
    const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
    const cached = setupEnvCache.get(path);
    if (cached?.key === key) return { ...cached.env };
    const env = parseWorkerSetupEnv(readFileSync(path, 'utf8'));
    setupEnvCache.set(path, { key, env });
    return { ...env };
  } catch {
    return undefined;
  }
}

const setupEnvCache = new Map<string, { key: string; env: Record<string, string> }>();

/**
 * The environment a managed Olympus install actually runs with: the process
 * environment layered over the values in worker.env.
 *
 * The supervised worker's environment comes from that file, and commands like
 * `olympus connect gemini` write credentials into it — so a check that reads
 * only `process.env` reports a key as missing immediately after the operator
 * stored it, and names the command they just ran as the fix. The file is the
 * lower layer: an environment variable set explicitly for this process still
 * wins, and an empty one does not mask an installed value.
 *
 * Located only from a path, a home, or a HOME in the environment handed in.
 * Falling back to the process owner's home would make a caller that passed a
 * scoped environment silently read an install it never asked about.
 */
export function environmentWithWorkerSetupEnv(
  options: WorkerAuthTokenLookupOptions = {},
): Record<string, string | undefined> {
  const env = options.env ?? process.env;
  if (!options.workerEnvPath && !options.homeDir && !env.HOME?.trim()) return env;
  const setupEnv = readWorkerSetupEnv(options);
  if (!setupEnv) return env;
  const merged: Record<string, string | undefined> = { ...setupEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') merged[key] = value;
    else if (!(key in setupEnv)) merged[key] = value;
  }
  return merged;
}

export function workerSetupEnvPath(options: WorkerAuthTokenLookupOptions = {}): string {
  const env = options.env ?? process.env;
  return options.workerEnvPath ?? join(
    options.homeDir ?? optionalToken(env.HOME) ?? homedir(),
    '.config',
    'olympus',
    'worker.env',
  );
}

export function isWorkerAuthTokenPlaceholder(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'replace-with-generated-token'
    || normalized === 'change-me'
    || normalized === 'changeme'
    || normalized === 'placeholder';
}

export function normalizeWorkerAuthToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (isWorkerAuthTokenPlaceholder(trimmed)) return undefined;
  return trimmed ? trimmed : undefined;
}

function optionalToken(value: string | undefined): string | undefined {
  return normalizeWorkerAuthToken(value);
}

function parseWorkerSetupEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    env[match[1]!] = unquoteEnvValue(match[2] ?? '');
  }
  return env;
}

/**
 * Strip the surrounding quotes a worker.env value may carry.
 *
 * A PLAINLY single- or double-quoted value is the one shape both managed
 * sourcing paths agree on — systemd's `EnvironmentFile=` parser and the launchd
 * unit's `set -a; . <env>` shell sourcing — so every reader of that file
 * unquotes the same way the running worker sees it, and this stays a strip.
 *
 * There is deliberately no close-escape-reopen handling here. That form
 * (`'a'\''b'`) is shell concatenation, and systemd's parser does not implement
 * it: the same bytes would reach a Linux worker as `a''b'` while /bin/sh and
 * this reader saw `a'b`, so the value the worker holds would depend on the
 * platform. Rather than pick a side, `writeManagedWorkerEnvSecret` refuses a
 * single quote in a managed value outright, so the form never gets written.
 */
export function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
