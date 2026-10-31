/**
 * Browser-safe shapes shared by the Olympus tab in OpenClaw's Control UI, its
 * Gateway bridge, the computer's own local pages and the worker.
 *
 * Nothing in these shapes carries worker authentication, cookies, CSRF state,
 * executable script, or arbitrary worker routes. The Gateway owns the worker
 * bearer and checks the operator's scopes per call.
 */

/**
 * The Olympus tab's one Gateway method (unified dashboard phase 4,
 * 2026-10-09): `{name, arguments}` for one of the panel's tools, answered
 * with the tool's MCP result. operator.read reaches the dashboard read;
 * every other tool needs operator.write.
 */
export const OLYMPUS_DASHBOARD_TOOL_METHOD = 'olympus.dashboard.tool' as const;

/** Where the Gateway serves the panel page the tab frames. */
export const OLYMPUS_DASHBOARD_PANEL_PATH = '/olympus/dashboard/panel' as const;

/** A registered folder-scoped file source (`core/file-scope-sources.ts`); the registry validates it. */
export type OlympusFolderScopeSourceId = string;
/** The mail source whose scope is a time window, categories, labels and sender rules. */
export type OlympusMailScopeSourceId = 'gmail.email';

export type OlympusMailScopeWindow = '6m' | '1y' | '2y' | '5y' | 'all';
export type OlympusMailScopeCategory = 'primary' | 'social' | 'promotions' | 'updates' | 'forums';

/** The owner's mail scope choices, as the picker edits and submits them. */
export interface OlympusMailScopeDraft {
  window: OlympusMailScopeWindow;
  skipped_categories: OlympusMailScopeCategory[];
  skipped_labels: Array<{ id: string; name: string }>;
  always_private_senders: string[];
  skip_senders: string[];
}

/**
 * Where the computer's own privacy rules stand for a folder (macOS asks the
 * person before an app reads Desktop, Documents, Downloads, iCloud Drive or a
 * disk that can be unplugged). Never silent: every state carries the words
 * the picker shows, and a folder that cannot be listed says why.
 */
export type OlympusFolderAccessState =
  /** On a folder row: opening it makes the computer ask. On a level: the same, before the ask. */
  | 'needs_permission'
  /** The computer is showing its question and has no answer yet. */
  | 'waiting'
  /** The person said no (or turned it off later). */
  | 'denied'
  /** The helper app that makes the question say "Olympus" is not installed. */
  | 'needs_helper'
  /** Searching the whole computer needs Full Disk Access, which the person switches on. */
  | 'needs_full_disk_access';

export interface OlympusFolderAccess {
  state: OlympusFolderAccessState;
  /** Plain words, in the picker's voice. */
  message: string;
  /** A link that opens the computer's privacy page for this, where one exists. */
  settings_url?: string;
}

/** Opaque provider folder identity. Names are returned only by an explicit browser request. */
export interface OlympusFolderScopeNode {
  key: string;
  parent_key?: string;
  name: string;
  /** `file` is for a listing that offers files; every listing today offers folders (the archive picker that listed files is gone, 2026-10-26). */
  kind: 'folder' | 'file';
  has_children: boolean;
  selectable: boolean;
  /** A file's size, where the listing reports it. */
  size_bytes?: number;
  /**
   * Set when the folder is off unless the person turns it on (system data,
   * caches, version control, build output, another source's folder): the
   * picker shows it, marked, and never pre-selects it.
   */
  excluded_by_default?: boolean;
  /** Plain words for why, when `excluded_by_default` is set. */
  default_exclusion_reason?: string;
  /** Set on a folder the computer asks the person about; see OlympusFolderAccess. */
  access?: OlympusFolderAccess;
  /** A mounted disk, listed beside the home folders: the picker tags it so it does not read as a folder. */
  is_disk?: true;
}

export type OlympusSourceScopeStatus = 'scope_pending' | 'approved';

export interface OlympusSourceScopeSelection {
  key: string;
  state: OlympusSourceDispositionState;
  /** Root-to-parent opaque folder keys for nearest-choice evaluation. */
  ancestor_keys?: string[];
}

export interface OlympusFolderScopeBrowseResult {
  source_id: OlympusFolderScopeSourceId;
  /** Opaque digest bound to the current connected credential/account grant. */
  account_generation: string;
  /** Opaque compare-and-swap token. */
  scope_revision: string;
  status: OlympusSourceScopeStatus;
  nodes: OlympusFolderScopeNode[];
  next_cursor?: string;
  /**
   * Why this level has no folders (or, at the top level, what searching the
   * whole computer needs). Absent when the level listed normally.
   */
  access?: OlympusFolderAccess;
  selections: OlympusSourceScopeSelection[];
  whole_account_selected: boolean;
}

export type OlympusDashboardOAuthSource = 'gmail' | 'google-drive' | 'dropbox' | 'x';
export type OlympusDashboardApiKeySource = 'gemini' | 'venice' | 'readwise';
export type OlympusSourceDispositionState = 'ingest' | 'metadata_only' | 'exclude';

/** What a form on the computer's local pages submits (browser-controller.ts). */
export type OlympusDashboardControlParams =
  | { action: 'check_model_setup' }
  | { action: 'discover_local_models'; base_url: string }
  | { action: 'test_local_models'; base_url: string; answer_model: string }
  | { action: 'save_local_answer_model'; base_url: string; answer_model: string }
  | { action: 'save_first_run_privacy'; choice: string }
  | {
      action: 'start_oauth';
      source: OlympusDashboardOAuthSource;
      client_id?: string;
      client_secret?: string;
      google_desktop?: boolean;
      google_client_json?: string;
    }
  | {
      action: 'connect_api_key';
      source: OlympusDashboardApiKeySource;
      api_key: string;
    }
  | {
      /** Connect a source on this computer (no sign-in); the owner then picks folders. */
      action: 'connect_this_computer';
      source: 'local.files';
    }
  | {
      /** One-time code for approving Claude, ChatGPT or Grok. Shown once. */
      action: 'mint_agent_pairing_code';
    }
  | {
      /** A bearer connection for the Grok API or another agent. Its token is shown once. */
      action: 'create_agent_key';
      name: string;
      /** The Connect an agent choice it is for (its `data-agent` id), which sets who hosts it. */
      agent?: string;
    }
  | {
      action: 'revoke_agent_connection';
      connection_id: string;
    }
  | {
      /**
       * Turn remote access on or off. Turning it on the first time answers
       * 409 `terms_required` with the CA's agreement; the owner's explicit
       * acceptance is sent back naming that agreement's URL (null when the CA
       * names none).
       */
      action: 'set_remote_access';
      enabled: boolean;
      accept_terms?: { url: string | null };
    };

export interface OlympusDashboardControlResult {
  status: number;
  body: Record<string, unknown>;
}
