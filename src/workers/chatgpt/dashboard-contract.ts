/**
 * The ChatGPT dashboard view-model, version 1: `structuredContent` of the
 * `olympus_dashboard` tool, rendered by `ui://olympus/dashboard`. The engine
 * produces every state except `mac_offline` and `not_installed` (the relay
 * answers those) and `relay_unavailable` (the UI derives it when a tool call
 * fails). See docs/design/chatgpt-plugin.md. Strings come from
 * src/workers/dashboard/vocabulary.ts; nothing tiered Private or Secret is
 * ever included, folder names included.
 */
export type ConnectionState = 'not_installed' | 'installing' | 'ready' | 'mac_offline' | 'relay_unavailable';

export interface DashboardFix {
  label: string;
  /** Run through tools/call from the UI. */
  tool?: string;
  args?: Record<string, unknown>;
  href?: string;
}

export interface DashboardItem {
  id: string;
  sentence: string;
  fix: DashboardFix;
}

export interface DashboardViewModelV1 {
  v: 1;
  connection: {
    state: ConnectionState;
    /** ISO time; `mac_offline` only. */
    lastSeenAt?: string;
    action?: { id: 'install' | 'open_olympus' | 'wake_mac' | 'retry'; label: string; href?: string };
  };
  /** At most one banner. */
  blocker?: DashboardItem;
  needsYou: DashboardItem[];
  sources: Array<{ id: string; label: string; status: 'ready' | 'working' | 'needs_you' | 'off'; detail?: string }>;
  progress?: {
    percent: number;
    itemsLeft: number;
    etaSeconds?: number;
    stalled: boolean;
    details: Array<{ stage: string; done: number; total: number }>;
  };
  models: { embedding: { kind: 'built_in' | 'custom'; ready: boolean }; answers?: { label: string; ready: boolean } };
  generatedAt: string;
}

export const DASHBOARD_TOOL_NAME = 'olympus_dashboard';
export const DASHBOARD_RESOURCE_URI = 'ui://olympus/dashboard';
