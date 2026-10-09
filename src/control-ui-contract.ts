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

export type OlympusFolderScopeSourceId = 'google_drive.docs' | 'dropbox.files';
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

/** Opaque provider folder identity. Names are returned only by an explicit browser request. */
export interface OlympusFolderScopeNode {
  key: string;
  parent_key?: string;
  name: string;
  kind: 'folder';
  has_children: boolean;
  selectable: boolean;
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
  selections: OlympusSourceScopeSelection[];
  whole_account_selected: boolean;
}

export type OlympusDashboardOAuthSource = 'gmail' | 'google-drive' | 'dropbox' | 'x';
export type OlympusDashboardApiKeySource = 'gemini' | 'venice' | 'readwise';
export type OlympusDashboardSyncSource = 'gmail' | 'google-drive' | 'dropbox' | 'x' | 'readwise';
export type OlympusDashboardSourceId =
  | 'gmail.email'
  | 'google_drive.docs'
  | 'dropbox.files'
  | 'x.bookmarks'
  | 'telegram.messages'
  | 'whatsapp.personal.messages'
  | 'readwise.library';
export type OlympusDashboardUnpairSourceId = 'telegram.messages' | 'whatsapp.personal.messages';
export type OlympusSourceDispositionState = 'ingest' | 'metadata_only' | 'exclude';

/** What a form on the computer's local pages submits (browser-controller.ts). */
export type OlympusDashboardControlParams =
  | { action: 'check_model_setup' }
  | {
      action: 'start_oauth';
      source: OlympusDashboardOAuthSource;
      client_id?: string;
      client_secret?: string;
    }
  | {
      action: 'cancel_oauth';
      source: OlympusDashboardOAuthSource;
    }
  | {
      action: 'connect_api_key';
      source: OlympusDashboardApiKeySource;
      api_key: string;
    }
  | {
      action: 'sync_now';
      source: OlympusDashboardSyncSource;
    }
  | {
      action: 'set_embedding_priority';
      on: boolean;
    }
  | {
      action: 'disconnect';
      source_id: OlympusDashboardSourceId;
      acknowledge: true;
    }
  | {
      action: 'unpair';
      source_id: OlympusDashboardUnpairSourceId;
      acknowledge: true;
    }
  | {
      /** One-time code for approving Claude, ChatGPT or Grok. Shown once. */
      action: 'mint_agent_pairing_code';
    }
  | {
      /** A bearer connection for Muse, the Grok API or a script. Its token is shown once. */
      action: 'create_agent_key';
      name: string;
    }
  | {
      action: 'revoke_agent_connection';
      connection_id: string;
    }
  | {
      /** Start a built-in model's failed install again (ChatGPT's olympus_model_retry). */
      action: 'retry_model';
      /** `transcription`: the owner's Download now for the built-in transcription model. */
      model: 'embedding' | 'answers' | 'transcription';
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
