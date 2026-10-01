/**
 * The slice of the dashboard view-model (v1) the relay produces for an
 * offline Mac. The relay builds separately from the engine, so this is a copy
 * of the minimal shape; the contract itself is
 * src/workers/chatgpt/dashboard-contract.ts, and
 * test/relay-dashboard-contract.test.ts holds this copy assignable to it with
 * the same tool name and resource URI.
 */
export const DASHBOARD_TOOL_NAME = 'olympus_dashboard';
export const DASHBOARD_RESOURCE_URI = 'ui://olympus/dashboard';

export interface OfflineDashboardViewModel {
  v: 1;
  connection: { state: 'mac_offline'; lastSeenAt?: string };
  needsYou: [];
  sources: [];
  models: { embedding: { kind: 'built_in'; ready: false } };
  generatedAt: string;
}

export function offlineDashboard(lastSeenAt: number | undefined, now: number): OfflineDashboardViewModel {
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
