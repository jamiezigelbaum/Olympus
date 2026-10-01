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

// Compile-time: the relay's shape is assignable to the contract. A contract
// change that the relay copy does not follow fails `bun run typecheck`.
const assignable = (value: RelayDashboardViewModel): DashboardViewModelV1 => value;

describe('the relay dashboard copy follows the contract', () => {
  test('same tool name and resource URI', () => {
    expect(RELAY_TOOL_NAME).toBe(DASHBOARD_TOOL_NAME);
    expect(RELAY_RESOURCE_URI).toBe(DASHBOARD_RESOURCE_URI);
    expect(DASHBOARD_TOOL.name).toBe(DASHBOARD_TOOL_NAME);
    expect(DASHBOARD_TOOL._meta['openai/outputTemplate']).toBe(DASHBOARD_RESOURCE_URI);
  });

  test('both relay states produce contract values with exactly the contract keys', () => {
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const offline = assignable(offlineDashboard(now - 90_000, now));
    expect(offline).toEqual({
      v: 1,
      connection: { state: 'mac_offline', lastSeenAt: '2026-10-01T11:58:00.000Z' },
      needsYou: [],
      sources: [],
      models: { embedding: { kind: 'built_in', state: 'downloading' } },
      generatedAt: '2026-10-01T12:00:00.000Z',
    });
    const notInstalled = assignable(notInstalledDashboard('https://olympusplugin.ai/', now));
    expect(notInstalled.connection).toEqual({ state: 'not_installed', action: { id: 'install', href: 'https://olympusplugin.ai/' } });
  });
});
