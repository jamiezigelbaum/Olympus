/**
 * The worker's side of the dashboard's remote-access toggle: ask the Gateway
 * to change `remote.enabled` through OpenClaw's config write path
 * (core/remote-access-config.ts), over the loopback plugin route watch
 * delivery already uses, with the worker bearer. The worker never writes
 * OpenClaw config itself.
 */
import { REMOTE_ACCESS_CONFIG_ROUTE } from '../core/remote-access-config.ts';
import type { TimeoutFetch } from '../core/http-timeout.ts';
import {
  readRemoteAccessStatus,
  recordTermsAcceptance,
  resolveCurrentTermsUrl,
  termsAccepted,
} from '../core/remote-access.ts';
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
 * The dashboard's remote-access control: the CA agreement resolved, checked
 * and recorded with exactly the functions `olympus connections terms` uses, in
 * the same state directory, and the config change handed to `setEnabled`.
 */
export function createDashboardRemoteAccessControl(options: {
  /** The connect-relay state directory (`remoteAccessDir`). */
  dir: () => string;
  fetchTerms: () => Promise<string | undefined>;
  setEnabled: (enabled: boolean) => Promise<RemoteAccessConfigWrite>;
  now?: () => Date;
}): DashboardRemoteAccessControl {
  return {
    currentTermsUrl: () => resolveCurrentTermsUrl(readRemoteAccessStatus(options.dir()), options.fetchTerms),
    termsAccepted: (url) => termsAccepted(options.dir(), url),
    recordTermsAcceptance: (url) => { recordTermsAcceptance(options.dir(), url, options.now?.() ?? new Date()); },
    setEnabled: options.setEnabled,
  };
}
