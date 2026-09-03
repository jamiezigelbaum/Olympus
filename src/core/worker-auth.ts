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
  return (
    optionalToken(config.worker.authToken)
    ?? optionalToken((options.env ?? process.env).OLYMPUS_WORKER_AUTH_TOKEN)
    ?? workerAuthTokenFromSetupEnv(options)
  );
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
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return undefined;
    return parseWorkerSetupEnv(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
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
 * Both managed sourcing paths accept them — systemd's `EnvironmentFile=` parser
 * and the launchd unit's `set -a; . <env>` shell sourcing — so every reader of
 * that file must unquote the same way the running worker sees it.
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
