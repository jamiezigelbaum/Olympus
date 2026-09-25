/**
 * Turning remote access on or off from the dashboard, inside the Gateway.
 *
 * The dashboard's Turn on / Turn off remote access changes exactly one
 * OpenClaw config value, `plugins.entries.olympus.config.remote.enabled`, and
 * only through OpenClaw's own config write path: the plugin runtime's
 * `api.runtime.config.mutateConfigFile`. That is the same locked, backed-up
 * write that `config.patch` and `openclaw config set` commit through
 * (`replaceConfigFile`, whose `writeConfigFile` validates the authored config
 * with `validateConfigObjectRawWithPlugins`), and its `afterWrite: { mode: 'auto' }`
 * lets the Gateway's reload planner apply it; the relay service reloads on
 * `plugins.entries.olympus.config.remote`. Olympus never writes openclaw.json.
 *
 * The worker cannot write config itself (it holds no Gateway credential), so
 * it asks the Gateway over this plugin route, presenting the worker bearer
 * the Gateway already trusts for watch delivery. The route is least
 * privilege by construction: its whole request is `{ "enabled": boolean }`,
 * and it can change nothing else. The owner's custody (control cookie, CSRF,
 * same origin, rate limit) is proven by the worker's dashboard guard before
 * the worker ever calls here.
 */
import { hasValidWorkerBearerToken } from '../workers/http.ts';

export const REMOTE_ACCESS_CONFIG_ROUTE = '/plugins/olympus/remote-access';
/** The one config value this route may change. */
export const REMOTE_ACCESS_ENABLED_CONFIG_PATH = 'plugins.entries.olympus.config.remote.enabled';

/** The part of OpenClaw's `api.runtime.config` this route uses. */
export interface OpenClawRuntimeConfigWriter {
  current?: () => unknown;
  mutateConfigFile?: (params: {
    afterWrite: { mode: 'auto' };
    mutate: (draft: Record<string, unknown>) => void;
  }) => Promise<{ followUp?: unknown } | unknown>;
}

export interface RemoteAccessConfigResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleRemoteAccessConfigRequest(input: {
  method: string;
  authorization: string | null;
  body: string;
  authToken?: string;
  runtimeConfig: OpenClawRuntimeConfigWriter | undefined;
}): Promise<RemoteAccessConfigResult> {
  if (!input.authToken) {
    return failed(503, 'remote_access_auth_unconfigured', 'The Olympus worker token is not configured.');
  }
  if (!hasValidWorkerBearerToken(input.authorization, input.authToken)) {
    return failed(401, 'unauthorized', 'Unauthorized.');
  }
  if (input.method !== 'POST') return failed(405, 'method_not_allowed', 'Use POST.');
  let enabled: boolean;
  try {
    const parsed = JSON.parse(input.body) as unknown;
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    if (!record || Object.keys(record).length !== 1 || typeof record.enabled !== 'boolean') throw new Error('shape');
    enabled = record.enabled;
  } catch {
    return failed(400, 'invalid_request', 'The request must be exactly {"enabled": true} or {"enabled": false}.');
  }
  const writer = input.runtimeConfig;
  if (typeof writer?.mutateConfigFile !== 'function') {
    return failed(
      501,
      'config_write_unsupported',
      'This OpenClaw version does not let plugins change their settings. Update OpenClaw, or run: '
        + `openclaw config set ${REMOTE_ACCESS_ENABLED_CONFIG_PATH} ${enabled}`,
    );
  }
  if (currentEnabled(writer) === enabled) {
    return { status: 200, body: { status: 'unchanged', enabled } };
  }
  try {
    const result = await writer.mutateConfigFile({
      afterWrite: { mode: 'auto' },
      mutate: (draft) => {
        const remote = objectAt(objectAt(objectAt(objectAt(objectAt(draft, 'plugins'), 'entries'), 'olympus'), 'config'), 'remote');
        remote.enabled = enabled;
      },
    });
    const followUp = asRecord(asRecord(result)?.followUp);
    return {
      status: 200,
      body: {
        status: 'written',
        enabled,
        ...(typeof followUp?.mode === 'string' ? { follow_up: followUp.mode } : {}),
      },
    };
  } catch {
    // Categorical only: a validation or conflict message can quote config.
    return failed(
      500,
      'config_write_failed',
      'OpenClaw did not accept the change. Try again, or run: '
        + `openclaw config set ${REMOTE_ACCESS_ENABLED_CONFIG_PATH} ${enabled}`,
    );
  }
}

function currentEnabled(writer: OpenClawRuntimeConfigWriter): boolean | undefined {
  try {
    const root = asRecord(writer.current?.());
    const remote = asRecord(asRecord(asRecord(asRecord(asRecord(root?.plugins)?.entries)?.olympus)?.config)?.remote);
    return typeof remote?.enabled === 'boolean' ? remote.enabled : undefined;
  } catch {
    return undefined;
  }
}

/** The object at `key`, created when absent; anything else there is not ours to replace. */
function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
  const record = asRecord(existing);
  if (!record) throw new TypeError(`config ${key} is not an object`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function failed(status: number, errorKind: string, message: string): RemoteAccessConfigResult {
  return { status, body: { status: 'failed', error_kind: errorKind, message } };
}
