/**
 * The relay builds separately from the engine and carries its own copy of the
 * dashboard view-model slice it produces (connect-relay/shared/dashboard-contract.ts).
 * This holds that copy to the contract (src/workers/chatgpt/dashboard-contract.ts):
 * every relay-produced value must be a valid DashboardViewModelV1, under the
 * same tool name and resource URI.
 */
import { describe, expect, test } from 'bun:test';
import {
  DASHBOARD_RESOURCE_URI as RELAY_RESOURCE_URI,
  DASHBOARD_TOOL_NAME as RELAY_TOOL_NAME,
  INSTALL_URL,
  notInstalledDashboard,
  offlineDashboard,
  type RelayDashboardViewModel,
} from '../connect-relay/shared/dashboard-contract.ts';
import { DASHBOARD_TOOL } from '../connect-relay/server/relay-mcp.ts';
import {
  DASHBOARD_RESOURCE_URI,
  DASHBOARD_TOOL_NAME,
  type DashboardViewModelV1,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import { DASHBOARD_RESOURCE_VERSIONED_URI } from '../src/workers/chatgpt/dashboard-resource.ts';
import { copyDashboardViewModel } from '../src/workers/chatgpt/response-builder.ts';

// Compile-time: the relay's shape is assignable to the contract. A contract
// change that the relay copy does not follow fails `bun run typecheck`.
const assignable = (value: RelayDashboardViewModel): DashboardViewModelV1 => value;

describe('the relay dashboard copy follows the contract', () => {
  test('same tool name and resource URI', () => {
    expect(RELAY_TOOL_NAME).toBe(DASHBOARD_TOOL_NAME);
    expect(RELAY_RESOURCE_URI).toBe(DASHBOARD_RESOURCE_URI);
    expect(DASHBOARD_TOOL.name).toBe(DASHBOARD_TOOL_NAME);
    // The relay advertises the engine's content-versioned URI (`<base>?v=<hash>`),
    // so ChatGPT fetches the same page version from either.
    expect(DASHBOARD_TOOL._meta?.['openai/outputTemplate']).toBe(DASHBOARD_RESOURCE_VERSIONED_URI);
  });

  test('both relay states produce contract values with exactly the contract keys', () => {
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const offline = assignable(offlineDashboard(now - 90_000, now));
    expect(offline).toEqual({
      v: 1,
      connection: {
        state: 'mac_offline',
        lastSeenAt: '2026-10-01T11:58:00.000Z',
        action: { id: 'wake_mac', href: 'https://olympusplugin.ai/help/mac-offline/' },
      },
      needsYou: [],
      sources: [],
      models: { embedding: { kind: 'built_in', state: 'downloading' } },
      generatedAt: '2026-10-01T12:00:00.000Z',
    });
    expect(assignable(offlineDashboard(undefined, now)).connection)
      .toEqual({ state: 'mac_offline', action: { id: 'wake_mac', href: 'https://olympusplugin.ai/help/mac-offline/' } });
    const notInstalled = assignable(notInstalledDashboard(INSTALL_URL, now));
    expect(notInstalled.connection).toEqual({ state: 'not_installed', action: { id: 'install', href: 'https://olympusplugin.ai/install/' } });
    // Both survive the engine's allowlisted response builder unchanged.
    expect(copyDashboardViewModel(offline)).toEqual(offline);
    expect(copyDashboardViewModel(notInstalled)).toEqual(notInstalled);
  });
});
