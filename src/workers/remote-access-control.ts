/**
 * The worker's side of the dashboard's remote-access toggle: ask the Gateway
 * to change `remote.enabled` through OpenClaw's config write path
 * (core/remote-access-config.ts), over the loopback plugin route watch
 * delivery already uses, with the worker bearer. The worker never writes
 * OpenClaw config itself. (The standalone engine supplies its own
 * `setEnabled` to `createDashboardRemoteAccessControl`.)
 */
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

/** The dashboard's remote-access control: the config change handed to `setEnabled`. */
export function createDashboardRemoteAccessControl(options: {
  setEnabled: (enabled: boolean) => Promise<RemoteAccessConfigWrite>;
}): DashboardRemoteAccessControl {
  return { setEnabled: options.setEnabled };
}

/** Standalone hosts use their config writer and the full engine restart path. */
export function createStandaloneRemoteAccessConfigWriter(options: {
  write(enabled: boolean): void;
  canRestart(): boolean;
  unsupportedReason?: string;
  requestRestart(): boolean;
}): (enabled: boolean) => Promise<RemoteAccessConfigWrite> {
  return async enabled => {
    if (options.unsupportedReason) return { ok: false, status: 501, code: 'restart_unsupported', message: options.unsupportedReason };
    if (!options.canRestart()) return { ok: false, status: 503, code: 'restart_unavailable', message: 'Olympus cannot apply this setting right now. Try again in a moment.' };
    try { options.write(enabled); }
    catch { return { ok: false, status: 500, code: 'config_write_failed', message: 'Olympus could not save the setting. Try again. If it keeps failing, copy the system report from Help and send it to support.' }; }
    if (!options.requestRestart()) return { ok: false, status: 503, code: 'restart_unavailable', message: 'The setting was saved, but Olympus could not apply it yet. Try again in a moment.' };
    return { ok: true };
  };
}

/**
 * The standalone engine's control. A host that cannot change remote access
 * from the dashboard (Linux, for now) offers no switch: the row says why
 * instead of a button the route would only refuse with 501 (#1034).
 */
export function createStandaloneRemoteAccessControl(options: Parameters<typeof createStandaloneRemoteAccessConfigWriter>[0]): DashboardRemoteAccessControl {
  const reason = options.unsupportedReason;
  if (reason) return { manual: () => reason };
  return createDashboardRemoteAccessControl({ setEnabled: createStandaloneRemoteAccessConfigWriter(options) });
}

/** Let the HTTP response finish before the host's full restart stops this worker. */
export function createDashboardEngineRestart(options: {
  restart(): void;
  failed(): void;
  schedule?: (run: () => void, delayMs: number) => unknown;
}): () => boolean {
  let pending = false;
  return () => {
    if (pending) return true;
    pending = true;
    (options.schedule ?? setTimeout)(() => {
      try { options.restart(); }
      catch { options.failed(); }
      finally { pending = false; }
    }, 750);
    return true;
  };
}
