/**
 * The ChatGPT dashboard view-model, version 1: `structuredContent` of the
 * `olympus_dashboard` tool, rendered by `ui://olympus/dashboard`. The engine
 * produces every state except `mac_offline` and `not_installed` (the relay
 * answers those) and `relay_unavailable` (the UI derives it when a tool call
 * fails). See docs/design/chatgpt-plugin.md.
 *
 * Copy: the UI owns the wording of the five connection states (the relay
 * renders two of them without vocabulary.ts). Every other sentence comes from
 * src/workers/dashboard/vocabulary.ts, which the dashboard lane owns. Nothing
 * tiered Private or Secret is ever included, folder names included: every
 * value passes the allowlisted response builder before it leaves the engine
 * (structuredContent, _meta, errors alike).
 *
 * Not states here, by design: OAuth revoked (ChatGPT itself shows reconnect on
 * 401); installed but not linked (shown on the Mac, where linking happens).
 * Stale status is derived by the UI from `generatedAt`. Multiple Macs per
 * ChatGPT account is v2.
 */
import type { DashboardStatus } from '../dashboard/vocabulary.ts';

export type ConnectionState = 'not_installed' | 'installing' | 'ready' | 'mac_offline' | 'relay_unavailable';

export interface DashboardFix {
  label: string;
  /** Run through tools/call from the UI. */
  tool?: string;
  args?: Record<string, unknown>;
  /** olympusplugin.ai only: openExternal needs the plugin's redirect domains. */
  href?: string;
  /** Shown on a disabled control. */
  disabledReason?: string;
  /** The UI confirms first; matches the tool's destructive annotation. */
  destructive?: boolean;
}

export interface DashboardItem {
  id: string;
  sentence: string;
  fix: DashboardFix;
}

export interface DashboardSource {
  id: string;
  label: string;
  group: 'local' | 'cloud';
  status: DashboardStatus;
  detail?: string;
  lastSyncAt?: string;
  primary?: DashboardFix;
  /** Secondary actions for the ⋯ menu. */
  menu?: DashboardFix[];
}

export interface DashboardViewModelV1 {
  v: 1;
  /** State and data only: the UI holds the copy for connection states. */
  connection: {
    state: ConnectionState;
    /** ISO time; `mac_offline` only. */
    lastSeenAt?: string;
    action?: { id: 'install' | 'open_olympus' | 'wake_mac' | 'retry'; href?: string };
    /** `installing` only: model download, first index. */
    progress?: { percent: number; label: string };
  };
  /** At most one banner. */
  blocker?: DashboardItem;
  /** Includes an unreachable local model; models never block on their own. */
  needsYou: DashboardItem[];
  /** Server-ordered, local group first. */
  sources: DashboardSource[];
  progress?: {
    /** What is being counted, and whether this is the first build or a refresh. */
    unit: 'files' | 'messages' | 'items';
    phase: 'initial' | 'refresh';
    percent: number;
    itemsLeft: number;
    /** Only once a rate has been measured. */
    etaSeconds?: number;
    stalled: boolean;
    details: Array<{ stage: string; unit: 'files' | 'messages' | 'items'; done: number; total: number }>;
  };
  models: {
    embedding: {
      kind: 'built_in' | 'custom';
      state: 'downloading' | 'ready' | 'failed';
      /** `downloading` only. */
      percent?: number;
    };
    answers?: { kind: 'built_in' | 'venice' | 'local'; label: string; ready: boolean };
    /** Opens the model chooser. */
    change?: DashboardFix;
  };
  generatedAt: string;
}

export const DASHBOARD_TOOL_NAME = 'olympus_dashboard';
export const DASHBOARD_RESOURCE_URI = 'ui://olympus/dashboard';
