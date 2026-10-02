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
  /**
   * Run through tools/call from the UI. Every Fix the engine sends names one
   * with its `args` (a Setup tool below, or `olympus_dashboard` to check
   * again); optional in the type only so the UI can render its own fixtures.
   */
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

/** Why a source's ingestion is not moving. Fixed codes; the UI owns the words. */
export type SourceStalledReason =
  /** The source's sign-in is missing or expired: fix is `olympus_connect_source`. */
  | 'waiting_for_credentials'
  /** No folders or mail chosen yet: fix is `olympus_scope_list`. */
  | 'scope_pending'
  /** The provider keeps failing or refusing reads; it retries on its own. */
  | 'provider_unavailable'
  /** Indexing waits for the built-in search model to finish downloading. */
  | 'model_downloading';

/**
 * One source's ingestion, at the first stage that is not finished:
 * `listing` (finding the provider's items), `reading` (text extracted),
 * `indexing` (searchable on the current model), or `done`. `done`/`total`
 * count `unit` at that stage; `total` is 0 while it is not known yet (a first
 * listing), and then `percent` is 0 too unless the listing's own walk is
 * sized (folders), when `percent` is that walk's share. Items kept as names
 * only (metadata-only folders) are finished once listed: they are never
 * counted as unread.
 */
export interface SourceProgress {
  stage: 'listing' | 'reading' | 'indexing' | 'done';
  unit: 'files' | 'messages' | 'items';
  done: number;
  total: number;
  percent: number;
  stalled: boolean;
  /** Only when `stalled`, and only when the reason is known. */
  stalledReason?: SourceStalledReason;
}

export interface DashboardSource {
  id: string;
  label: string;
  group: 'local' | 'cloud';
  status: DashboardStatus;
  detail?: string;
  lastSyncAt?: string;
  primary?: DashboardFix;
  /**
   * Present only while a sign-in started for this source is still outstanding
   * (a connect link or OAuth start the owner has not finished). `expiresAt` is
   * when that attempt lapses (ISO). While present, `status` is `Needs you`,
   * `primary` is `olympus_connect_source {source}` (a fresh link replaces the
   * outstanding one), and Disconnect in `menu` cancels the attempt.
   */
  connecting?: { expiresAt: string };
  /**
   * Connected sources only (absent for Off and while `connecting`). Honesty
   * rule: `status` is never `Fresh` while `progress.stage` is not `done`; it
   * is `Working` while listing, reading or indexing, and `Needs you` when
   * stalled on `waiting_for_credentials` or `scope_pending`, with `primary`
   * the matching fix.
   */
  progress?: SourceProgress;
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
  /** The sum of every connected source's `progress`; absent once all are `done`. */
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
      /** `verifying`: the downloaded files are being checked against their pinned checksums. */
      state: ModelInstallState;
      /** `downloading` and `verifying` only. */
      percent?: number;
      /** `downloading` and `verifying` (built-in) only, when known. */
      bytesDone?: number;
      bytesTotal?: number;
      /** `failed` (built-in) only; its fix is a `model:embedding` needsYou item (`olympus_model_retry`). */
      failedReason?: ModelInstallFailedReason;
    };
    answers?: {
      kind: 'built_in' | 'venice' | 'local';
      label: string;
      ready: boolean;
      /** Built-in only, while it is not ready. A failed install's fix is a `model:answers` needsYou item. */
      install?: ModelInstall;
    };
    /** Status only in ChatGPT: carries `disabledReason` (models change on the Mac). */
    change?: DashboardFix;
  };
  /**
   * The owner's privacy settings (olympus_privacy_get / olympus_privacy_set):
   * whether they have been set yet, and how many items wait for the privacy
   * check (held Private until judged). While `configured` is false,
   * `needsYou` carries `{id: 'privacy:setup'}` whose fix is
   * `olympus_privacy_get`. Counts only; never a description or a rule.
   */
  privacy?: { configured: boolean; pendingCount: number; ruleCount: number };
  generatedAt: string;
}

/** A built-in model's install (contract v1 addition, 2026-10-01). */
export type ModelInstallState = 'downloading' | 'verifying' | 'ready' | 'failed';
/** Fixed codes only, never the installer's message. */
export type ModelInstallFailedReason = 'disk_full' | 'network' | 'checksum' | 'unknown';
export interface ModelInstall {
  state: ModelInstallState;
  /** 0-100. */
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  /** `failed` only. */
  failedReason?: ModelInstallFailedReason;
}

export const DASHBOARD_TOOL_NAME = 'olympus_dashboard';
/** Retrieval only: the released evidence ChatGPT answers from (SearchResult). */
export const SEARCH_TOOL_NAME = 'olympus_search';
export const DASHBOARD_RESOURCE_URI = 'ui://olympus/dashboard';

/* ------------------------------------------------------------------ */
/* Setup from ChatGPT (contract v1 additions, 2026-10-01)              */
/* ------------------------------------------------------------------ */
/*
 * Every tool below needs the owner's Olympus connection (oauth2). Results
 * follow one rule: `structuredContent` and text carry no folder, label or
 * sender names and no secrets. Picker data (names, and the opaque keys and
 * cursors, which for Dropbox are paths) travels only in the picker tools'
 * result `_meta[SCOPE_UI_META_KEY]` (owner decision 2026-10-01: names may
 * reach ChatGPT only through olympus_scope_list / olympus_scope_set, shown in
 * the widget). ChatGPT hands `_meta` to the widget, not the model.
 * Secrets-tier locations (owner tier rules with tier Secrets) are left out
 * even there, and their saved choices are kept on save. No API key is ever
 * entered through ChatGPT (owner decision 2026-10-01): v1 runs keyless on the
 * built-in models, and keyed providers (Venice, Readwise) are set up only on
 * the Mac, in Olympus's own settings.
 *
 * Links: every `openUrl` is `https://mcp.olympusplugin.ai/go/<one-time id>`
 * (single use, 10 minutes). Open it with `openExternal`; the plugin's only
 * redirect domain is mcp.olympusplugin.ai.
 */

export const CONNECT_SOURCE_TOOL_NAME = 'olympus_connect_source';
export const SCOPE_LIST_TOOL_NAME = 'olympus_scope_list';
export const SCOPE_SET_TOOL_NAME = 'olympus_scope_set';
export const DISCONNECT_SOURCE_TOOL_NAME = 'olympus_disconnect_source';
export const MODEL_SET_TOOL_NAME = 'olympus_model_set';
/** App-only: restarts a built-in model's install (`{model: 'embedding' | 'answers'}`). */
export const MODEL_RETRY_TOOL_NAME = 'olympus_model_retry';

/** The `_meta` key carrying the picker's names to the widget only. */
export const SCOPE_UI_META_KEY = 'olympus/scope';

/** Sources a person can connect from ChatGPT with Olympus's own (publisher) apps. */
export type ChatGptOAuthSource = 'gmail' | 'google-drive' | 'dropbox';
export type ChatGptFolderSourceId = 'google_drive.docs' | 'dropbox.files';
export type ChatGptMailSourceId = 'gmail.email';
export type ChatGptScopeSourceId = ChatGptFolderSourceId | ChatGptMailSourceId;
export type ChatGptDisconnectSourceId =
  | 'gmail.email'
  | 'google_drive.docs'
  | 'dropbox.files'
  | 'x.bookmarks'
  | 'readwise.library';

/**
 * `olympus_connect_source {source}` → structuredContent. The provider's sign-in
 * completes on the engine whichever device opened the link (the provider
 * returns through auth.olympusplugin.ai and the relay to this Mac). The source
 * then shows `Needs you` until its folders or mail are chosen.
 */
export interface ConnectSourceResult {
  status: 'open_link';
  source: ChatGptOAuthSource;
  openUrl: string;
  expiresAt: string;
}

export type ScopeSelectionState = 'ingest' | 'metadata_only' | 'exclude';

export interface ScopeSelection {
  /** Opaque provider key from a node. */
  key: string;
  state: ScopeSelectionState;
  /** Root-to-parent keys, as the list returned them, for nearest-choice evaluation. */
  ancestor_keys?: string[];
}

/** One folder (only in `_meta`). */
export interface ScopeFolderNode {
  key: string;
  parent_key?: string;
  name: string;
  kind: 'folder';
  has_children: boolean;
  selectable: boolean;
  /** Not offered by the providers' folder listings today; reserved. */
  size_bytes?: number;
  file_count?: number;
}

/**
 * `olympus_scope_list {source_id: Drive|Dropbox, parent_key?, cursor?}`: one
 * level. Mixed is computed by the UI from `selections` and keys. Same
 * semantics as the Mac's folder picker (control-ui-contract.ts
 * OlympusFolderScopeBrowseResult).
 */
export interface FolderScopeList {
  kind: 'folders';
  source_id: ChatGptFolderSourceId;
  account_generation: string;
  scope_revision: string;
  status: 'scope_pending' | 'approved';
  nodes: ScopeFolderNode[];
  next_cursor?: string;
  selections: ScopeSelection[];
  whole_account_selected: boolean;
}

export type MailWindow = '6m' | '1y' | '2y' | '5y' | 'all';
export type MailCategory = 'primary' | 'social' | 'promotions' | 'updates' | 'forums';

/** The mail picker's choices (control-ui-contract.ts OlympusMailScopeDraft). */
export interface MailScopeDraft {
  window: MailWindow;
  skipped_categories: MailCategory[];
  skipped_labels: Array<{ id: string; name: string }>;
  always_private_senders: string[];
  skip_senders: string[];
}

/**
 * `olympus_scope_list {source_id: 'gmail.email', draft?}`: the saved choices
 * (or `draft`, to refresh the estimate) with the labels to choose from.
 */
export interface MailScopeList {
  kind: 'mail';
  source_id: ChatGptMailSourceId;
  account_generation: string;
  scope_revision: string;
  status: 'scope_pending' | 'approved';
  draft: MailScopeDraft;
  /** Labels the person may skip. */
  labels: Array<{ id: string; name: string; system: boolean }>;
  categories: Array<{ category: MailCategory; messages_total?: number }>;
  /** Frequent senders in a sample, to mark Private or skip. */
  sender_suggestions: Array<{ sender: string; sample_messages: number }>;
  /** Gmail's own estimate for this draft: full-content and metadata-only messages. */
  estimate?: { content_messages: number; metadata_messages: number; total_messages: number };
}

/** The full picker data: `_meta[SCOPE_UI_META_KEY]` of a scope tool result. */
export type ScopeList = FolderScopeList | MailScopeList;

/** A scope tool's `structuredContent`: counts and opaque revision ids only. */
export interface ScopeSummary {
  kind: 'folders' | 'mail';
  source_id: ChatGptScopeSourceId;
  status: 'scope_pending' | 'approved';
  account_generation: string;
  scope_revision: string;
  /** Folders: on this page. Mail: labels offered. */
  shown: number;
  has_more: boolean;
  /** Saved or drafted choices, counted. */
  choices: number;
  whole_account_selected: boolean;
  estimate?: MailScopeList['estimate'];
}

/**
 * `olympus_scope_set`: folders `{source_id, account_generation, scope_revision,
 * selections, whole_account_selected, confirm_whole_account?}` or mail
 * `{source_id: 'gmail.email', account_generation, scope_revision, mail}`.
 * Saves through the same compare-and-swap the Mac picker uses, then starts
 * indexing. Whole account needs `confirm_whole_account: true` (the UI's own
 * visible confirmation).
 */
export type ScopeSetResult =
  | { status: 'saved'; source_id: ChatGptScopeSourceId; scope_revision: string; indexing_started: boolean }
  /** Someone changed the scope first: `current` counts the fresh list, whose data is in `_meta`. */
  | { status: 'conflict'; source_id: ChatGptScopeSourceId; current: ScopeSummary };

/** `olympus_disconnect_source {source_id}` (destructive: the UI confirms). Indexed data stays. */
export interface DisconnectSourceResult {
  status: 'disconnected';
  source_id: ChatGptDisconnectSourceId;
}

/**
 * `olympus_model_set {embedding?: 'built_in', answers?: 'local' | 'venice'}`:
 * switches between options already configured on the Mac; it never takes a
 * key. Embeddings: the built-in model only; moving an index that embeds with
 * another model is a re-embed and is refused (`embedding_change_needs_approval`).
 * Answers: Venice only when its key is already on the Mac, local only when a
 * local answer model is configured (`model_not_configured` otherwise); the
 * engine's worker restarts to apply it. The panel's Models row is status
 * only: `models.change` carries `disabledReason` (change models on the Mac).
 */
export interface ModelSetResult {
  status: 'applied' | 'unchanged';
  embedding: 'built_in' | 'custom';
  answers?: 'local' | 'venice';
  /** The worker restarts to apply the change; the dashboard reads `installing` briefly. */
  restarting: boolean;
}

/**
 * `olympus_model_retry {model: 'embedding' | 'answers'}` (app-only): starts
 * the built-in model's install again after it failed (it resumes a partial
 * download). Answers at once; the dashboard shows the install's progress.
 * `model_not_configured` when that model is not the built-in one here.
 */
export interface ModelRetryResult {
  status: 'retrying';
  model: 'embedding' | 'answers';
}

/* ------------------------------------------------------------------ */
/* Privacy settings (contract v1 addition, 2026-10-01)                 */
/* ------------------------------------------------------------------ */
/*
 * Set once in setup, inside ChatGPT ("In your own words, what's private for
 * you?"), and editable later from the dashboard; not in the folder picker.
 * Tiers: Personal (reaches ChatGPT through olympus_search), Private (stays on
 * the Mac; the private answer panel only) and Secret (detected automatically,
 * never leaves). Rules name folders, labels or senders that are ALWAYS
 * Private; the description is the owner's own words, which the private
 * classifier on the Mac reads.
 *
 * Names: a rule's `key`, `value` and `display` travel only in
 * `_meta[PRIVACY_META_KEY]`, like the picker. `structuredContent` carries
 * the description (owner-approved: OpenAI may see category words) and counts.
 */

export const PRIVACY_GET_TOOL_NAME = 'olympus_privacy_get';
export const PRIVACY_SET_TOOL_NAME = 'olympus_privacy_set';
/** The `_meta` key carrying the privacy rules to the widget only. */
export const PRIVACY_META_KEY = 'olympus/privacy';

export type PrivacyRuleKind = 'folder' | 'label' | 'sender';

/** A folder that is always Private: the picker's opaque node key. */
export interface PrivacyFolderRule {
  kind: 'folder';
  source_id: ChatGptFolderSourceId;
  key: string;
  /** The folder's name when the UI sent it; only ever in `_meta`. */
  display?: string;
}

/** A Gmail label that is always Private: its id, and its name as `value`. */
export interface PrivacyLabelRule {
  kind: 'label';
  source_id: 'gmail.email';
  key: string;
  value: string;
}

/** A sender that is always Private: an address or a whole `@domain`. */
export interface PrivacySenderRule {
  kind: 'sender';
  source_id: 'gmail.email';
  value: string;
}

/**
 * One always-Private rule, as `olympus_privacy_set` takes it and
 * `olympus_privacy_get` returns it (only in `_meta[PRIVACY_META_KEY]`).
 * Caps: 100 rules; key 1024 characters; label name and display 200; sender
 * an address or `@domain` of at most 240.
 */
export type PrivacyRuleView = PrivacyFolderRule | PrivacyLabelRule | PrivacySenderRule;

/** `olympus_privacy_get {}` → `_meta[PRIVACY_META_KEY]`; also `olympus_privacy_set`'s. */
export interface PrivacySettings {
  /** False until the owner has saved privacy settings once. */
  configured: boolean;
  /** The owner's own words; empty until set. At most 2000 characters. */
  description: string;
  /** At most 100. */
  rules: PrivacyRuleView[];
  /** Items waiting for the privacy check (held Private, keyword-searchable, not embedded). */
  pendingCount: number;
}

/** A privacy tool's `structuredContent`: the description and counts, never a rule. */
export interface PrivacySummary {
  status: 'current' | 'saved';
  configured: boolean;
  description: string;
  ruleCount: number;
  pendingCount: number;
}

/**
 * `olympus_privacy_set {description?, rules?}`: each field given replaces
 * the saved one; the other stays. `rules` is the whole list (the UI sends
 * every rule it shows). Validated and size-capped (description 2000
 * characters, 100 rules, display 200); `invalid_params` otherwise. Saving
 * applies the rules to classification at the next sync.
 */
export interface PrivacySetInput {
  description?: string;
  rules?: PrivacyRuleView[];
}

/* ------------------------------------------------------------------ */
/* olympus_search                                                      */
/* ------------------------------------------------------------------ */

/** One released item: Public or Personal only; `url` only where the release gate let it through. */
export interface SearchEvidence {
  /** Citation id for ChatGPT's answer, `E1`, `E2`, ... */
  id: string;
  /** The product's name for the source (Gmail, Google Drive, Files, ...). */
  source: string;
  title?: string;
  url?: string;
  date?: string;
  excerpt?: string;
}

/** `olympus_search {question, limit?}` → structuredContent. */
export interface SearchResult {
  status: 'found' | 'none';
  evidence: SearchEvidence[];
  coverage: {
    searchedSources: number;
    unreadableItems: number;
    /** Matches in folders the owner set to Names only (contents not read on purpose). */
    namesOnlyItems: number;
    partiallyReadItems: number;
    /** Items in the searched sources whose privacy tier is still open (held from search until decided). */
    unclassifiedItems: number;
    /** Model-facing: when to bring these counts up (only if asked why something is missing, or the answer depends on it). */
    instruction: string;
  };
  /**
   * Fixed sentences the reply may need: a Private match, items held back,
   * instruction-like excerpts, and the Names-only hint only when Names-only
   * matches are why nothing could be answered. Coverage counts are not
   * recited here; they sit in `coverage`.
   */
  notes: string[];
}
