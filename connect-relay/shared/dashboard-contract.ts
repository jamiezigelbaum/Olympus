/**
 * The slice of the dashboard view-model (v1) the relay produces itself: for a
 * caller with no Olympus connected yet (`not_connected`) and for an install
 * whose Mac is offline (`mac_offline`). A caller without a token cannot be told
 * apart from an owner who installed Olympus but has not linked ChatGPT yet, so
 * the relay never claims `not_installed`: it offers Connect, and the install
 * link for when Olympus is not on the Mac. The relay builds separately from the
 * engine, so this is a copy of the minimal shape; the contract itself is
 * src/workers/chatgpt/dashboard-contract.ts, and
 * test/relay-dashboard-contract.test.ts holds this copy assignable to it with
 * the same tool name and resource URI.
 */
export const DASHBOARD_TOOL_NAME = 'olympus_dashboard';
export const DASHBOARD_RESOURCE_URI = 'ui://olympus/dashboard';
/** Where the not-connected dashboard sends an owner without Olympus on the Mac. */
export const INSTALL_URL = 'https://olympusplugin.ai/install/';
/** Where the offline dashboard's "wake your Mac" action explains what to do. */
export const MAC_OFFLINE_HELP_URL = 'https://olympusplugin.ai/help/mac-offline/';

export interface RelayDashboardViewModel {
  v: 1;
  connection:
    | { state: 'mac_offline'; lastSeenAt?: string; action: { id: 'wake_mac'; href: string } }
    | { state: 'not_connected'; action: { id: 'connect' }; installHref: string };
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

export function notConnectedDashboard(installUrl: string, now: number): RelayDashboardViewModel {
  return {
    v: 1,
    connection: { state: 'not_connected', action: { id: 'connect' }, installHref: installUrl },
    needsYou: [],
    sources: [],
    models: { embedding: { kind: 'built_in', state: 'downloading' } },
    generatedAt: new Date(now).toISOString(),
  };
}
