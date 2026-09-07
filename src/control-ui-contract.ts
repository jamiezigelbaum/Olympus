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
  'embedding_ledger',
  'sensitivity',
  'source',
  'dispositions',
] as const;

export type OlympusDashboardView = typeof OLYMPUS_DASHBOARD_VIEWS[number];

export interface OlympusDashboardReadParams {
  view: OlympusDashboardView;
  /** Required only for the source detail view. */
  source_id?: string;
}

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
