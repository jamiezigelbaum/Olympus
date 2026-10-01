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
/** Where the not-installed dashboard sends the owner. */
export const INSTALL_URL = 'https://olympusplugin.ai/install/';
/** Where the offline dashboard's "wake your Mac" action explains what to do. */
export const MAC_OFFLINE_HELP_URL = 'https://olympusplugin.ai/help/mac-offline/';

export interface RelayDashboardViewModel {
  v: 1;
  connection:
    | { state: 'mac_offline'; lastSeenAt?: string; action: { id: 'wake_mac'; href: string } }
    | { state: 'not_installed'; action: { id: 'install'; href: string } };
  needsYou: [];
  sources: [];
  /**
   * The relay cannot see the Mac's model, and the contract has no "unknown"
   * state: `downloading` with no percent is the least wrong claim (never
   * `ready`, never `failed`). The UI leads with the connection state anyway.
   */
  models: { embedding: { kind: 'built_in'; state: 'downloading' } };
  generatedAt: string;
}

export function offlineDashboard(lastSeenAt: number | undefined, now: number): RelayDashboardViewModel {
  return {
    v: 1,
    connection: {
      state: 'mac_offline',
      // Minute resolution: enough for "last seen", no finer trace of the owner's activity.
      ...(lastSeenAt !== undefined ? { lastSeenAt: new Date(Math.floor(lastSeenAt / 60_000) * 60_000).toISOString() } : {}),
      action: { id: 'wake_mac', href: MAC_OFFLINE_HELP_URL },
    },
    needsYou: [],
    sources: [],
    models: { embedding: { kind: 'built_in', state: 'downloading' } },
    generatedAt: new Date(now).toISOString(),
  };
}

export function notInstalledDashboard(installUrl: string, now: number): RelayDashboardViewModel {
  return {
    v: 1,
    connection: { state: 'not_installed', action: { id: 'install', href: installUrl } },
    needsYou: [],
    sources: [],
    models: { embedding: { kind: 'built_in', state: 'downloading' } },
    generatedAt: new Date(now).toISOString(),
  };
}
