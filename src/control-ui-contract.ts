/**
 * Browser-safe contract between the Olympus Gateway bridge, the worker's
 * inert renderer, and OpenClaw's native plugin page.
 *
 * Nothing in these shapes carries worker authentication, cookies, CSRF state,
 * executable script, or arbitrary worker routes. The Gateway owns the worker
 * bearer and derives `can_write` from the authenticated operator connection.
 */

export const OLYMPUS_DASHBOARD_READ_METHOD = 'olympus.dashboard.read' as const;
export const OLYMPUS_DASHBOARD_CONTROL_METHOD = 'olympus.dashboard.control' as const;

export const OLYMPUS_DASHBOARD_VIEWS = [
  'home',
  'setup',
  'background',
  'sensitivity',
  'source',
  'dispositions',
] as const;

export type OlympusDashboardView = typeof OLYMPUS_DASHBOARD_VIEWS[number];

export type OlympusFolderScopeSourceId = 'google_drive.docs' | 'dropbox.files';

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

export type OlympusDashboardReadParams =
  | {
      view: Exclude<OlympusDashboardView, 'dispositions'>;
      /** Required only for the source detail view. */
      source_id?: string;
    }
  | {
      view: 'dispositions';
      source_id?: string;
      action?: undefined;
    }
  | {
      view: 'dispositions';
      action: 'browse_folder_scope';
      source_id: OlympusFolderScopeSourceId;
      /** Omitted means the provider's virtual root. */
      parent_key?: string;
      /** Opaque provider continuation minted by the preceding response. */
      cursor?: string;
    };

export interface OlympusDashboardReadResult {
  status: number;
  title: string;
  /** Complete inert mount fragment. It must contain no style or script. */
  body: string;
  controller: 'dashboard' | 'dispositions';
  /** Derived from the live Gateway client. Never accepted from request params. */
  can_write: boolean;
  /** Stable digest of the rendered state, used to avoid needless DOM replacement. */
  signature: string;
  poll_interval_ms: number;
  /** Present only for an explicit browse_folder_scope request. */
  scope_browser?: OlympusFolderScopeBrowseResult;
}

export type OlympusDashboardOAuthSource = 'gmail' | 'google-drive' | 'dropbox' | 'x';
export type OlympusDashboardApiKeySource = 'venice' | 'readwise';
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

export interface OlympusSourceDispositionEdit {
  path: string;
  state: OlympusSourceDispositionState;
}

export type OlympusDashboardControlParams =
  | {
      /** Standalone browser transport for the same read-only native RPC action. */
      action: 'browse_folder_scope';
      source_id: OlympusFolderScopeSourceId;
      parent_key?: string;
      cursor?: string;
    }
  | {
      action: 'save_dispositions';
      source: string;
      edits: OlympusSourceDispositionEdit[];
    }
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
      /** The only action that turns a connected folder source into an ingestion lane. */
      action: 'approve_source_scope_and_start';
      source_id: OlympusFolderScopeSourceId;
      account_generation: string;
      expected_scope_revision: string;
      selections: OlympusSourceScopeSelection[];
      whole_account: boolean;
      /** Must be true when whole_account is true; ignored otherwise. */
      explicit_whole_account_confirmation: boolean;
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
    };

export interface OlympusDashboardControlResult {
  status: number;
  body: Record<string, unknown>;
}
