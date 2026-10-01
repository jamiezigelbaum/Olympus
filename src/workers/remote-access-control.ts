/**
 * The worker's side of the dashboard's remote-access toggle, per host:
 *
 * - under OpenClaw, ask the Gateway to change `remote.enabled` through
 *   OpenClaw's config write path (core/remote-access-config.ts), over the
 *   loopback plugin route watch delivery already uses, with the worker bearer.
 *   The worker never writes OpenClaw config itself;
 * - under the standalone engine, change `remote.enabled` in its own config
 *   file (~/.olympus/engine.json, the shape of the plugin config) and ask the
 *   engine to restart.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { REMOTE_ACCESS_CONFIG_ROUTE } from '../core/remote-access-config.ts';
import type { TimeoutFetch } from '../core/http-timeout.ts';
import type { DashboardRemoteAccessControl, RemoteAccessConfigWrite } from './agent-connections.ts';
import { postOpenClawGatewayPluginRoute } from './source-watch-runtime.ts';

export function createGatewayRemoteAccessConfigWriter(options: {
  authToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: TimeoutFetch;
  gatewayConfig?: unknown;
}): (enabled: boolean) => Promise<RemoteAccessConfigWrite> {
  return async (enabled) => {
    let response: Response;
    try {
      response = await postOpenClawGatewayPluginRoute({
        path: REMOTE_ACCESS_CONFIG_ROUTE,
        body: { enabled },
        authToken: options.authToken,
        ...(options.env ? { env: options.env } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.gatewayConfig !== undefined ? { gatewayConfig: options.gatewayConfig } : {}),
        timeoutMs: 20_000,
      });
    } catch {
      return {
        ok: false,
        status: 502,
        code: 'openclaw_unreachable',
        message: 'Olympus could not reach OpenClaw to change the setting. Check that OpenClaw is running, then try again.',
      };
    }
    const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (response.ok && (body?.status === 'written' || body?.status === 'unchanged')) {
      return body.status === 'unchanged' ? { ok: true, unchanged: true } : { ok: true };
    }
    if (response.status === 404) {
      // A Gateway still running an Olympus without this route.
      return {
        ok: false,
        status: 501,
        code: 'config_write_unsupported',
        message: 'Restart OpenClaw so it loads this version of Olympus, then try again.',
      };
    }
    const message = typeof body?.message === 'string' && body.message.length <= 400
      ? body.message
      : 'OpenClaw did not accept the change. Try again in a moment.';
    const code = typeof body?.error_kind === 'string' && /^[a-z0-9_]{1,64}$/.test(body.error_kind) ? body.error_kind : 'config_write_failed';
    return { ok: false, status: response.status === 501 ? 501 : 502, code, message };
  };
}

/**
 * The standalone engine's toggle: `remote.enabled` in its config file, written
 * atomically (0600), then `restart` (the engine host's own restart; wired at
 * integration). Other keys in the file are kept as they are.
 */
export function createEngineConfigRemoteAccessWriter(options: {
  configPath: string;
  restart: () => Promise<void>;
}): (enabled: boolean) => Promise<RemoteAccessConfigWrite> {
  return async (enabled) => {
    let config: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(options.configPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      config = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, status: 502, code: 'engine_config_unreadable', message: 'Olympus could not read its settings file (~/.olympus/engine.json). Fix or remove it, then try again.' };
      }
    }
    const remote = config.remote && typeof config.remote === 'object' && !Array.isArray(config.remote)
      ? config.remote as Record<string, unknown>
      : {};
    if ((remote.enabled === true) === enabled) return { ok: true, unchanged: true };
    const next = { ...config, remote: { ...remote, enabled } };
    try {
      const temporary = `${options.configPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(temporary, 0o600);
      renameSync(temporary, options.configPath);
    } catch {
      return { ok: false, status: 502, code: 'engine_config_write_failed', message: 'Olympus could not save its settings file. Try again in a moment.' };
    }
    try {
      await options.restart();
    } catch {
      return { ok: false, status: 502, code: 'engine_restart_failed', message: 'The setting was saved, but Olympus could not restart. Run olympus engine restart.' };
    }
    return { ok: true };
  };
}

/** The dashboard's remote-access control: the config change handed to `setEnabled`. */
export function createDashboardRemoteAccessControl(options: {
  setEnabled: (enabled: boolean) => Promise<RemoteAccessConfigWrite>;
}): DashboardRemoteAccessControl {
  return { setEnabled: options.setEnabled };
}
