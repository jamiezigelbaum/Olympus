/**
 * The slice of the dashboard view-model (v1) the relay produces itself: for a
 * caller with no Olympus connected yet (`not_installed`) and for an install
 * whose Mac is offline (`mac_offline`). The relay builds separately from the
 * engine, so this is a copy of the minimal shape; the contract itself is
 * src/workers/chatgpt/dashboard-contract.ts, and
 * test/relay-dashboard-contract.test.ts holds this copy assignable to it with
 * the same tool name and resource URI.
 */
export const DASHBOARD_TOOL_NAME = 'olympus_dashboard';
export const DASHBOARD_RESOURCE_URI = 'ui://olympus/dashboard';

export interface RelayDashboardViewModel {
  v: 1;
  connection:
    | { state: 'mac_offline'; lastSeenAt?: string }
    | { state: 'not_installed'; action: { id: 'install'; href: string } };
  needsYou: [];
  sources: [];
  models: { embedding: { kind: 'built_in'; ready: false } };
  generatedAt: string;
}

export function offlineDashboard(lastSeenAt: number | undefined, now: number): RelayDashboardViewModel {
  return {
    v: 1,
    connection: {
      state: 'mac_offline',
      // Minute resolution: enough for "last seen", no finer trace of the owner's activity.
      ...(lastSeenAt !== undefined ? { lastSeenAt: new Date(Math.floor(lastSeenAt / 60_000) * 60_000).toISOString() } : {}),
    },
    needsYou: [],
    sources: [],
    models: { embedding: { kind: 'built_in', ready: false } },
    generatedAt: new Date(now).toISOString(),
  };
}

export function notInstalledDashboard(installUrl: string, now: number): RelayDashboardViewModel {
  return {
    v: 1,
    connection: { state: 'not_installed', action: { id: 'install', href: installUrl } },
    needsYou: [],
    sources: [],
    models: { embedding: { kind: 'built_in', ready: false } },
    generatedAt: new Date(now).toISOString(),
  };
}
