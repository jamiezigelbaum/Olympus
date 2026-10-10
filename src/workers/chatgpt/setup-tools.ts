/**
 * Setup from ChatGPT: the tools the Olympus panel calls to connect sources,
 * choose folders and mail, disconnect, and choose models, so a ChatGPT user
 * never needs another dashboard (docs/design/chatgpt-plugin.md, "Setup from
 * ChatGPT"; shapes in dashboard-contract.ts).
 *
 * Each tool runs the engine's own blessed path through `ChatGptSetupBackend`
 * (the worker's dashboard routes, in process), so the compare-and-swap, the
 * model-readiness gate and the grant lock are the ones the Mac's dashboard
 * uses. Every response is built by response-builder.ts.
 *
 * Privacy:
 * - No API key is ever entered through ChatGPT (owner decision 2026-10-01):
 *   sign-ins are OAuth through one-time links (handoff.ts), and
 *   `olympus_model_set` only switches between models already set up on the
 *   Mac.
 * - Folder, label and sender names reach ChatGPT only in the picker tools'
 *   result `_meta` (owner decision 2026-10-01), never in text or
 *   structuredContent, and never Secrets-tier locations (scope-privacy.ts),
 *   whose saved choices are kept when the picker saves.
 */
import { parseMailScopeDraft } from '../../core/mail-source-scope.ts';
// A distinct local name keeps the bundler from renumbering other `node:crypto` bindings in dist/.
import { randomBytes as setupRandomBytes } from 'node:crypto';
import { parsePrivacyProfileInput, privacyRuleId } from '../classification/privacy-profile.ts';
import { OperationError } from '../../core/operation-error.ts';
import type {
  OlympusFolderScopeBrowseResult,
  OlympusMailScopeDraft,
  OlympusSourceScopeSelection,
} from '../../control-ui-contract.ts';
import {
  CONNECT_SOURCE_TOOL_NAME,
  DISCONNECT_SOURCE_TOOL_NAME,
  MODEL_RETRY_TOOL_NAME,
  MODEL_SET_TOOL_NAME,
  PRIVACY_GET_TOOL_NAME,
  PRIVACY_SET_TOOL_NAME,
  SCOPE_LIST_TOOL_NAME,
  SCOPE_SET_TOOL_NAME,
  SYNC_SOURCE_TOOL_NAME,
  type ChatGptDisconnectSourceId,
  type ChatGptFolderSourceId,
  type ChatGptOAuthSource,
  type FolderScopeList,
  type MailScopeList,
  type PrivacyRuleView,
  type PrivacySettings,
  type ScopeList,
  type ChatGptSyncSourceId,
  type SyncSourceResult,
} from './dashboard-contract.ts';
import type { HandoffTarget } from './handoff.ts';
import { ModelChoiceRefusal, type ChatGptModelChoice } from './model-choice.ts';
import {
  ChatGptSurfaceError,
  connectSourceToolResult,
  disconnectToolResult,
  modelRetryToolResult,
  modelSetToolResult,
  privacyToolResult,
  scopeConflictToolResult,
  scopeListToolResult,
  scopeSavedToolResult,
  syncSourceToolResult,
  type ChatGptErrorCode,
  type ChatGptToolResult,
} from './response-builder.ts';
import { isSecretFolder, isSecretLabel, isSecretSender, type SecretLocations } from './scope-privacy.ts';
// The privacy rules both editors share (moved, unchanged, 2026-10-02).
import { isSecretPrivacyRule, lowersPrivacy, visiblePrivacy } from '../dashboard/shared-privacy.ts';
export { isSecretPrivacyRule, lowersPrivacy, visiblePrivacy };

/** An error the backend reports with the worker's own code; mapped to a fixed sentence here. */
export class SetupBackendError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SetupBackendError';
  }
}

export interface ChatGptSetupBackend {
  /** Starts a publisher-app sign-in that returns through the relay; the provider's authorize URL. */
  startOAuth(source: ChatGptOAuthSource): Promise<{ authorizationUrl: string; expiresAt: string }>;
  /** A one-time `https://<relay>/go/<id>` link; undefined when this engine is not linked to the relay. */
  handoffLink(target: HandoffTarget): { url: string; expiresAt: string } | undefined;
  /**
   * The person is at the computer (an Olympus host's panel, never ChatGPT):
   * sign-in starts and returns here, so Connect answers with the provider's
   * own sign-in page instead of a relay link.
   */
  directSignIn?: boolean;
  browseFolders(input: { sourceId: ChatGptFolderSourceId; parentKey?: string; cursor?: string }): Promise<OlympusFolderScopeBrowseResult>;
  approveFolders(input: {
    sourceId: ChatGptFolderSourceId;
    accountGeneration: string;
    expectedRevision: string;
    selections: OlympusSourceScopeSelection[];
    wholeAccount: boolean;
  }): Promise<{ scopeRevision: string; started: boolean }>;
  /** The saved folder choices (for keeping Secrets choices on save). */
  savedFolderSelections(sourceId: ChatGptFolderSourceId): OlympusSourceScopeSelection[];
  /** The mailbox's picker data for `draft` (the saved draft when absent). */
  browseMail(draft?: OlympusMailScopeDraft): Promise<{
    accountGeneration: string;
    scopeRevision: string;
    status: 'scope_pending' | 'approved';
    draft: OlympusMailScopeDraft;
    labels: Array<{ id: string; name: string; system: boolean }>;
    categories: Array<{ category: string; messages_total?: number }>;
    senderSuggestions: Array<{ sender: string; sample_messages: number }>;
    estimate?: { content_messages: number; metadata_messages: number; total_messages: number };
  }>;
  approveMail(input: { accountGeneration: string; expectedRevision: string; draft: OlympusMailScopeDraft }): Promise<{ scopeRevision: string; started: boolean }>;
  savedMailDraft(): OlympusMailScopeDraft | undefined;
  disconnect(sourceId: ChatGptDisconnectSourceId): Promise<void>;
  /**
   * Sync now: starts one source's sync through the dashboard's own route and
   * answers without waiting for it (`busy` when one is running, `too_soon`
   * within a minute of the last press). The result is the dashboard's.
   */
  syncSource(sourceId: ChatGptSyncSourceId): Promise<SyncSourceResult['status']>;
  /** Switches between configured models; throws ModelChoiceRefusal for one that is not set up. */
  setModels(choice: ChatGptModelChoice): Promise<{ changed: boolean; embedding: 'built_in' | 'custom'; answers?: 'local' | 'venice'; restarting: boolean }>;
  /**
   * Starts a built-in model's install again (resuming a partial download);
   * answers at once. False when that model is not the built-in one here.
   */
  retryModel(model: 'embedding' | 'answers' | 'transcription'): boolean;
  /** The owner's Secrets locations; throws when the rules cannot be read. */
  secretLocations(): SecretLocations;
  /** The saved privacy settings and the privacy-check backlog; throws when the profile cannot be read. */
  privacySettings(): PrivacySettings;
  /** Saves a validated update (each field given replaces the saved one); returns the settings now. */
  savePrivacy(update: { description?: string; rules?: PrivacyRuleView[] }): PrivacySettings;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: false };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  securitySchemes: ReadonlyArray<{ type: 'oauth2'; scopes: readonly string[] }>;
  _meta: Record<string, unknown>;
}

const OAUTH2_REQUIRED = [{ type: 'oauth2', scopes: [] }] as const;
const OAUTH_SOURCES = ['gmail', 'google-drive', 'dropbox'] as const;
const FOLDER_SOURCE_IDS = ['google_drive.docs', 'dropbox.files'] as const;
const SCOPE_SOURCE_IDS = ['gmail.email', ...FOLDER_SOURCE_IDS] as const;
const DISCONNECT_SOURCE_IDS = ['gmail.email', 'google_drive.docs', 'dropbox.files', 'x.bookmarks', 'readwise.library'] as const;
const SYNC_SOURCE_IDS = DISCONNECT_SOURCE_IDS;

/** The widget may call these; the model may too. */
const WIDGET_AND_MODEL = { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true } as const;
/** Only the widget calls these (the owner acts in the panel); hidden from the model. */
const WIDGET_ONLY = { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true, 'openai/visibility': 'private' } as const;

const SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string', maxLength: 4096 },
    state: { type: 'string', enum: ['ingest', 'metadata_only', 'exclude'] },
    ancestor_keys: { type: 'array', items: { type: 'string', maxLength: 4096 }, maxItems: 64 },
  },
  required: ['key', 'state'],
  additionalProperties: false,
};

const MAIL_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    window: { type: 'string', enum: ['6m', '1y', '2y', '5y', 'all'] },
    skipped_categories: { type: 'array', items: { type: 'string', enum: ['primary', 'social', 'promotions', 'updates', 'forums'] } },
    skipped_labels: {
      type: 'array',
      maxItems: 500,
      items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] },
    },
    always_private_senders: { type: 'array', items: { type: 'string' }, maxItems: 500 },
    skip_senders: { type: 'array', items: { type: 'string' }, maxItems: 500 },
  },
  required: ['window', 'skipped_categories', 'skipped_labels', 'always_private_senders', 'skip_senders'],
  additionalProperties: false,
};

export const CONNECT_SOURCE_TOOL: ToolDefinition = {
  name: CONNECT_SOURCE_TOOL_NAME,
  title: 'Connect a source to Olympus',
  description: [
    'Start connecting Gmail, Google Drive or Dropbox to Olympus on the user\'s Mac.',
    'Returns {openUrl}: a one-time sign-in link (10 minutes) the user opens to sign in with the provider and allow Olympus.',
    'Afterwards the user chooses which folders or mail Olympus may read in the Olympus panel.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: { source: { type: 'string', enum: [...OAUTH_SOURCES], description: 'The source to connect.' } },
    required: ['source'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  securitySchemes: OAUTH2_REQUIRED,
  _meta: WIDGET_AND_MODEL,
};

export const SCOPE_LIST_TOOL: ToolDefinition = {
  name: SCOPE_LIST_TOOL_NAME,
  title: 'List folders or mail choices',
  description: 'For the Olympus panel: one level of a connected source\'s folders, or the mailbox\'s labels and categories, with the saved choices.',
  inputSchema: {
    type: 'object',
    properties: {
      source_id: { type: 'string', enum: [...SCOPE_SOURCE_IDS] },
      parent_key: { type: 'string', maxLength: 4096 },
      /** Root-to-parent keys above parent_key, so a folder inside a Secrets location is never listed. */
      ancestor_keys: { type: 'array', items: { type: 'string', maxLength: 4096 }, maxItems: 64 },
      cursor: { type: 'string', maxLength: 4096 },
      draft: MAIL_DRAFT_SCHEMA,
    },
    required: ['source_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  securitySchemes: OAUTH2_REQUIRED,
  _meta: WIDGET_ONLY,
};

export const SCOPE_SET_TOOL: ToolDefinition = {
  name: SCOPE_SET_TOOL_NAME,
  title: 'Save folder or mail choices',
  description: 'For the Olympus panel: save which folders or mail Olympus may read for a connected source, then start indexing.',
  inputSchema: {
    type: 'object',
    properties: {
      source_id: { type: 'string', enum: [...SCOPE_SOURCE_IDS] },
      account_generation: { type: 'string', maxLength: 256 },
      scope_revision: { type: 'string', maxLength: 256 },
      selections: { type: 'array', items: SELECTION_SCHEMA, maxItems: 100 },
      whole_account_selected: { type: 'boolean' },
      confirm_whole_account: { type: 'boolean' },
      mail: MAIL_DRAFT_SCHEMA,
    },
    required: ['source_id', 'account_generation', 'scope_revision'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  securitySchemes: OAUTH2_REQUIRED,
  _meta: WIDGET_ONLY,
};

export const DISCONNECT_SOURCE_TOOL: ToolDefinition = {
  name: DISCONNECT_SOURCE_TOOL_NAME,
  title: 'Disconnect a source',
  description: 'For the Olympus panel: stop Olympus reading a source. What it already indexed stays on the Mac.',
  inputSchema: {
    type: 'object',
    properties: { source_id: { type: 'string', enum: [...DISCONNECT_SOURCE_IDS] } },
    required: ['source_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  securitySchemes: OAUTH2_REQUIRED,
  _meta: WIDGET_ONLY,
};

export const MODEL_SET_TOOL: ToolDefinition = {
  name: MODEL_SET_TOOL_NAME,
  title: 'Choose Olympus models',
  description: 'For the Olympus panel: keep the built-in search model, and switch the answer model between options already set up on the Mac (local or Venice). Never takes a key.',
  inputSchema: {
    type: 'object',
    properties: {
      embedding: { type: 'string', enum: ['built_in'] },
      answers: { type: 'string', enum: ['local', 'venice'] },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  securitySchemes: OAUTH2_REQUIRED,
  _meta: WIDGET_ONLY,
};

export const MODEL_RETRY_TOOL: ToolDefinition = {
  name: MODEL_RETRY_TOOL_NAME,
  title: 'Retry an Olympus model install',
  description: 'For the Olympus panel: start the built-in search, answer or transcription model\'s install again on the computer after it failed, or download the transcription model ahead of any audio.',
  inputSchema: {
    type: 'object',
    properties: { model: { type: 'string', enum: ['embedding', 'answers', 'transcription'] } },
    required: ['model'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  securitySchemes: OAUTH2_REQUIRED,
  _meta: WIDGET_ONLY,
};

export const SYNC_SOURCE_TOOL: ToolDefinition = {
  name: SYNC_SOURCE_TOOL_NAME,
  title: 'Sync a source now',
  description: 'For the Olympus panel: check a connected source for anything new now. Answers at once; the panel shows what the check found.',
  inputSchema: {
    type: 'object',
    properties: { source_id: { type: 'string', enum: [...SYNC_SOURCE_IDS] } },
    required: ['source_id'],
    additionalProperties: false,
  },
  // App-only, like the other panel controls: the owner presses Sync now; the
  // model never starts a budget-exempt read (owner ruling, 2026-10-09).
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  securitySchemes: OAUTH2_REQUIRED,
  _meta: WIDGET_ONLY,
};

/** folder {key, display?}; label {key: id, value: name}; sender {value: address or @domain}. */
const PRIVACY_RULE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['folder', 'label', 'sender'] },
    source_id: { type: 'string', enum: [...SCOPE_SOURCE_IDS] },
    key: { type: 'string', maxLength: 1024 },
    value: { type: 'string', maxLength: 240 },
    display: { type: 'string', maxLength: 200 },
  },
  required: ['kind', 'source_id'],
  additionalProperties: false,
};

export const PRIVACY_GET_TOOL: ToolDefinition = {
  name: PRIVACY_GET_TOOL_NAME,
  title: 'Olympus privacy settings',
  description: [
    'Read what the user told Olympus is private for them: their own description, and how many folders, labels or',
    'senders they marked as always Private (the panel shows which). Use it during setup, or when the user asks',
    'about their privacy settings. Only the owner changes these settings, in the Olympus panel: if nothing is set yet,',
    'suggest they open the Olympus panel and choose Set up privacy. Takes no arguments. Read-only.',
  ].join(' '),
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  securitySchemes: OAUTH2_REQUIRED,
  _meta: WIDGET_AND_MODEL,
};

export const PRIVACY_SET_TOOL: ToolDefinition = {
  name: PRIVACY_SET_TOOL_NAME,
  title: 'Save Olympus privacy settings',
  description: [
    'Save what is private for the user. `description` is the user\'s answer, in their own words, to',
    '"What\'s private for you?" (for example health, money, family matters); Olympus\'s private classifier on the Mac',
    'reads it to keep matching items Private, so they never reach ChatGPT. `rules` is the full list of folders,',
    'labels and senders that are always Private; the Olympus panel builds it. Each field given replaces the saved one.',
    'Only the Olympus panel calls this: removing a rule or changing the description needs the panel\'s confirmation.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', maxLength: 2000, description: 'The user\'s own words about what is private for them.' },
      rules: { type: 'array', items: PRIVACY_RULE_SCHEMA, maxItems: 100 },
      confirmation: { type: 'string', maxLength: 128, description: 'The panel\'s confirmation from olympus_privacy_get.' },
      revision: { type: 'string', maxLength: 64, description: 'The revision from olympus_privacy_get; a save against changed settings is refused.' },
    },
    required: ['revision'],
    additionalProperties: false,
  },
  // Hidden from the model (review P-1, 2026-10-02): a privacy change is the
  // owner's, made in the panel. The engine also refuses a change that lowers
  // protection without the panel's confirmation (lowersPrivacy below).
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  securitySchemes: OAUTH2_REQUIRED,
  _meta: WIDGET_ONLY,
};

export const SETUP_TOOLS: readonly ToolDefinition[] = [
  CONNECT_SOURCE_TOOL,
  SCOPE_LIST_TOOL,
  SCOPE_SET_TOOL,
  DISCONNECT_SOURCE_TOOL,
  MODEL_SET_TOOL,
  MODEL_RETRY_TOOL,
  PRIVACY_GET_TOOL,
  PRIVACY_SET_TOOL,
  SYNC_SOURCE_TOOL,
];

const SETUP_TOOL_NAMES = new Set(SETUP_TOOLS.map((tool) => tool.name));

export function isSetupTool(name: string): boolean {
  return SETUP_TOOL_NAMES.has(name);
}

/** Runs one setup tool. Throws ChatGptSurfaceError; the caller builds the error result. */
export async function callSetupTool(
  name: string,
  args: Record<string, unknown>,
  backend: ChatGptSetupBackend | undefined,
): Promise<ChatGptToolResult> {
  if (!backend) throw new ChatGptSurfaceError('unavailable');
  // Only the declared arguments: nothing else (a key, say) rides along.
  const declared = SETUP_TOOLS.find((tool) => tool.name === name)?.inputSchema.properties ?? {};
  if (Object.keys(args).some((key) => !Object.prototype.hasOwnProperty.call(declared, key))) {
    throw new ChatGptSurfaceError('invalid_params');
  }
  try {
    switch (name) {
      case CONNECT_SOURCE_TOOL_NAME: {
        const source = oneOf(args.source, OAUTH_SOURCES);
        const started = await backend.startOAuth(source);
        if (backend.directSignIn) {
          return connectSourceToolResult({ status: 'open_link', source, openUrl: started.authorizationUrl, expiresAt: started.expiresAt }, { direct: true });
        }
        const link = backend.handoffLink({ kind: 'redirect', location: started.authorizationUrl });
        if (!link) throw new ChatGptSurfaceError('not_linked');
        return connectSourceToolResult({ status: 'open_link', source, openUrl: link.url, expiresAt: link.expiresAt });
      }
      case SCOPE_LIST_TOOL_NAME:
        return scopeListToolResult(await scopeList(backend, args));
      case SCOPE_SET_TOOL_NAME:
        return await scopeSet(backend, args);
      case DISCONNECT_SOURCE_TOOL_NAME: {
        const sourceId = oneOf(args.source_id, DISCONNECT_SOURCE_IDS);
        await backend.disconnect(sourceId);
        return disconnectToolResult({ status: 'disconnected', source_id: sourceId });
      }
      case MODEL_SET_TOOL_NAME: {
        const choice: ChatGptModelChoice = {};
        if (args.embedding !== undefined) choice.embedding = oneOf(args.embedding, ['built_in'] as const);
        if (args.answers !== undefined) choice.answers = oneOf(args.answers, ['local', 'venice'] as const);
        const result = await backend.setModels(choice);
        return modelSetToolResult({
          status: result.changed ? 'applied' : 'unchanged',
          embedding: result.embedding,
          ...(result.answers ? { answers: result.answers } : {}),
          restarting: result.restarting,
        });
      }
      case MODEL_RETRY_TOOL_NAME: {
        const model = oneOf(args.model, ['embedding', 'answers', 'transcription'] as const);
        if (!backend.retryModel(model)) throw new ChatGptSurfaceError('model_not_configured');
        return modelRetryToolResult({ status: 'retrying', model });
      }
      case SYNC_SOURCE_TOOL_NAME: {
        const sourceId = oneOf(args.source_id, SYNC_SOURCE_IDS);
        let status: SyncSourceResult['status'];
        try {
          status = await backend.syncSource(sourceId);
        } catch (error) {
          // Not connected, no lane here, the worker restarting: one fixed
          // sentence, shown beside the button. Never the route's own words.
          if (error instanceof SetupBackendError && error.code !== 'invalid_request') throw new ChatGptSurfaceError('sync_unavailable');
          throw error;
        }
        return syncSourceToolResult({ status, source_id: sourceId });
      }
      case PRIVACY_GET_TOOL_NAME: {
        const visible = visiblePrivacy(backend.privacySettings(), secretLocations(backend));
        // The confirmation rides `_meta`, which reaches the widget only, never the model.
        return privacyToolResult(visible, 'current', issuePrivacyConfirmation(backend));
      }
      case PRIVACY_SET_TOOL_NAME: {
        const { confirmation, revision, ...fields } = args;
        if (confirmation !== undefined && typeof confirmation !== 'string') throw new ChatGptSurfaceError('invalid_params');
        // Every save is a compare-and-swap: a caller that omits the revision
        // could overwrite settings it never saw (review, 2026-10-03).
        if (typeof revision !== 'string' || !revision || revision.length > 64) {
          throw new ChatGptSurfaceError('invalid_params');
        }
        let update: ReturnType<typeof parsePrivacyProfileInput>;
        try {
          update = parsePrivacyProfileInput(fields);
        } catch {
          throw new ChatGptSurfaceError('invalid_params');
        }
        const secrets = secretLocations(backend);
        // Compare-and-swap: read and write run with no await between them.
        const current = backend.privacySettings();
        if (current.revision !== revision) return privacyToolResult(visiblePrivacy(current, secrets), 'conflict');
        // Lowering protection is the owner's alone: only with the panel's confirmation.
        const confirmed = confirmation !== undefined && privacyConfirmationValid(backend, confirmation);
        if (!confirmed && lowersPrivacy(update, visiblePrivacy(backend.privacySettings(), secrets))) {
          throw new ChatGptSurfaceError('privacy_owner_only');
        }
        // Rules on Secrets locations are never shown, so a save keeps them as saved.
        const rules = update.rules
          ? [
              ...update.rules.filter((rule) => !isSecretPrivacyRule(secrets, rule)),
              ...backend.privacySettings().rules.filter((rule) => isSecretPrivacyRule(secrets, rule)),
            ]
          : undefined;
        const saved = backend.savePrivacy({
          ...(update.description !== undefined ? { description: update.description } : {}),
          ...(rules ? { rules: rules as PrivacyRuleView[] } : {}),
        });
        if (confirmed) spendPrivacyConfirmation(backend, confirmation);
        return privacyToolResult(visiblePrivacy(saved, secrets), 'saved');
      }
      default:
        throw new ChatGptSurfaceError('unknown_tool');
    }
  } catch (error) {
    throw surfaceError(error);
  }
}

/**
 * Panel confirmations for privacy changes that lower protection. One is
 * issued with every olympus_privacy_get, in its result `_meta` (which reaches
 * the widget only, never the model), lives PRIVACY_CONFIRMATION_TTL_MS and is
 * spent by the save it confirms. Per backend, so each engine has its own.
 */
export const PRIVACY_CONFIRMATION_TTL_MS = 30 * 60_000;
const PRIVACY_CONFIRMATIONS_MAX = 32;
const privacyConfirmations = new WeakMap<ChatGptSetupBackend, Map<string, number>>();

function confirmationsFor(backend: ChatGptSetupBackend): Map<string, number> {
  let issued = privacyConfirmations.get(backend);
  if (!issued) {
    issued = new Map();
    privacyConfirmations.set(backend, issued);
  }
  const now = Date.now();
  for (const [token, expiresAt] of issued) if (expiresAt <= now) issued.delete(token);
  return issued;
}

function issuePrivacyConfirmation(backend: ChatGptSetupBackend): string {
  const issued = confirmationsFor(backend);
  while (issued.size >= PRIVACY_CONFIRMATIONS_MAX) {
    const oldest = issued.keys().next().value;
    if (oldest === undefined) break;
    issued.delete(oldest);
  }
  const token = `opc_${setupRandomBytes(24).toString('base64url')}`;
  issued.set(token, Date.now() + PRIVACY_CONFIRMATION_TTL_MS);
  return token;
}

function privacyConfirmationValid(backend: ChatGptSetupBackend, token: string): boolean {
  return confirmationsFor(backend).has(token);
}

function spendPrivacyConfirmation(backend: ChatGptSetupBackend, token: string): void {
  confirmationsFor(backend).delete(token);
}

async function scopeList(backend: ChatGptSetupBackend, args: Record<string, unknown>): Promise<ScopeList> {
  const sourceId = oneOf(args.source_id, SCOPE_SOURCE_IDS);
  const secrets = secretLocations(backend);
  if (sourceId === 'gmail.email') {
    const draft = args.draft === undefined ? undefined : parseDraft(args.draft);
    return mailList(await backend.browseMail(draft), secrets);
  }
  const parentKey = optionalString(args.parent_key);
  const ancestorKeys = optionalKeys(args.ancestor_keys);
  const after = args.cursor === undefined ? undefined : decodeSortedCursor(requiredString(args.cursor), parentKey);
  // Never list inside a Secrets location, even by its key or under one of its folders.
  if (parentKey && isSecretFolder(secrets, parentKey, ancestorKeys)) throw new ChatGptSurfaceError('invalid_params');
  return sortedFolderPage(await browseWholeLevel(backend, sourceId, parentKey), secrets, parentKey, after, ancestorKeys);
}

/** Folders per page of `olympus_scope_list`, after sorting. */
export const SCOPE_LIST_PAGE_SIZE = 100;
/**
 * Provider pages read for one level before sorting. A level larger than this
 * lists what was read and says so (`truncated`), never silently.
 */
export const MAX_PROVIDER_PAGES = 50;
const FOLDER_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const SORTED_CURSOR_PREFIX = 'olysort1.';

/**
 * Every provider page of one folder level, so the level can be sorted before
 * it is paged (providers page in their own order). All pages must come from
 * one account and scope revision, or the listing is retried by the person.
 */
async function browseWholeLevel(
  backend: ChatGptSetupBackend,
  sourceId: ChatGptFolderSourceId,
  parentKey: string | undefined,
): Promise<WholeLevel> {
  const first = await backend.browseFolders({ sourceId, ...(parentKey ? { parentKey } : {}) });
  const nodes = [...first.nodes];
  const seen = new Set<string>();
  let cursor = first.next_cursor;
  for (let page = 1; cursor && !seen.has(cursor) && page < MAX_PROVIDER_PAGES; page++) {
    seen.add(cursor);
    const next = await backend.browseFolders({ sourceId, ...(parentKey ? { parentKey } : {}), cursor });
    if (next.account_generation !== first.account_generation || next.scope_revision !== first.scope_revision) {
      throw new ChatGptSurfaceError('picker_unavailable');
    }
    nodes.push(...next.nodes);
    cursor = next.next_cursor;
  }
  const unique = new Map(nodes.map((node) => [node.key, node]));
  const { next_cursor: _providerCursor, ...rest } = first;
  // A cursor left unread after the page cap means folders were never listed;
  // a repeated cursor is the provider's end, not a truncation.
  const truncated = Boolean(cursor) && !seen.has(cursor!);
  return { browse: { ...rest, nodes: [...unique.values()] }, truncated };
}

interface WholeLevel {
  browse: OlympusFolderScopeBrowseResult;
  /** The level had more provider pages than MAX_PROVIDER_PAGES. */
  truncated: boolean;
}

interface SortPosition {
  name: string;
  key: string;
}

/** Alphabetical with numbers in numeric order ("1 Projects", "2 Areas", …, "10 x", "Apps"); key breaks ties. */
function compareFolders(a: SortPosition, b: SortPosition): number {
  return FOLDER_COLLATOR.compare(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * One sorted page. The cursor names the last folder shown (its name and key),
 * not an offset, so a folder added or removed between pages neither repeats
 * nor skips the rest: the next page is every folder sorted after it.
 */
function sortedFolderPage(
  level: WholeLevel,
  secrets: SecretLocations,
  parentKey: string | undefined,
  after: SortPosition | undefined,
  ancestorKeys: readonly string[] = [],
): FolderScopeList {
  const list = folderList(level.browse, secrets, ancestorKeys);
  const sorted = [...list.nodes].sort(compareFolders);
  const rest = after ? sorted.filter((node) => compareFolders(node, after) > 0) : sorted;
  const page = rest.slice(0, SCOPE_LIST_PAGE_SIZE);
  const last = page.at(-1);
  const { next_cursor: _unused, ...withoutCursor } = list;
  return {
    ...withoutCursor,
    nodes: page,
    ...(rest.length > page.length && last
      ? { next_cursor: encodeSortedCursor(parentKey, last), remaining: rest.length - page.length }
      : {}),
    ...(level.truncated ? { truncated: true as const } : {}),
  };
}

function encodeSortedCursor(parentKey: string | undefined, last: SortPosition): string {
  const body = Buffer.from(JSON.stringify({ p: parentKey ?? '', n: last.name, k: last.key }), 'utf8').toString('base64url');
  return `${SORTED_CURSOR_PREFIX}${body}`;
}

function decodeSortedCursor(value: string, parentKey: string | undefined): SortPosition {
  if (!value.startsWith(SORTED_CURSOR_PREFIX)) throw new ChatGptSurfaceError('invalid_params');
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(SORTED_CURSOR_PREFIX.length), 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.p !== (parentKey ?? '') || typeof parsed.n !== 'string' || typeof parsed.k !== 'string' || !parsed.k) {
      throw new Error('cursor');
    }
    return { name: parsed.n, key: parsed.k };
  } catch {
    throw new ChatGptSurfaceError('invalid_params');
  }
}

async function scopeSet(backend: ChatGptSetupBackend, args: Record<string, unknown>): Promise<ChatGptToolResult> {
  const sourceId = oneOf(args.source_id, SCOPE_SOURCE_IDS);
  const accountGeneration = requiredString(args.account_generation);
  const expectedRevision = requiredString(args.scope_revision);
  const secrets = secretLocations(backend);
  try {
    if (sourceId === 'gmail.email') {
      const submitted = parseDraft(args.mail);
      const saved = await backend.approveMail({
        accountGeneration,
        expectedRevision,
        draft: keepSecretMailChoices(submitted, backend.savedMailDraft(), secrets),
      });
      return scopeSavedToolResult({ source_id: sourceId, scope_revision: saved.scopeRevision, indexing_started: saved.started });
    }
    const wholeAccount = args.whole_account_selected === true;
    if (wholeAccount && args.confirm_whole_account !== true) throw new ChatGptSurfaceError('confirm_whole_account');
    const submitted = parseSelections(args.selections ?? []);
    const kept = backend.savedFolderSelections(sourceId)
      .filter((selection) => isSecretFolder(secrets, selection.key, selection.ancestor_keys));
    const selections = [
      ...submitted.filter((selection) => !isSecretFolder(secrets, selection.key, selection.ancestor_keys)),
      ...kept,
    ];
    const saved = await backend.approveFolders({ sourceId, accountGeneration, expectedRevision, selections, wholeAccount });
    return scopeSavedToolResult({ source_id: sourceId, scope_revision: saved.scopeRevision, indexing_started: saved.started });
  } catch (error) {
    // A changed scope or account: answer with the current list, not an error.
    if (!(error instanceof SetupBackendError) || error.code !== 'source_index_policy_violation') throw error;
    const current = sourceId === 'gmail.email'
      ? mailList(await backend.browseMail(), secrets)
      : sortedFolderPage(await browseWholeLevel(backend, sourceId, undefined), secrets, undefined, undefined);
    if (current.account_generation === accountGeneration && current.scope_revision === expectedRevision) throw error;
    return scopeConflictToolResult(current);
  }
}

function folderList(browse: OlympusFolderScopeBrowseResult, secrets: SecretLocations, ancestorKeys: readonly string[] = []): FolderScopeList {
  return {
    kind: 'folders',
    source_id: browse.source_id,
    account_generation: browse.account_generation,
    scope_revision: browse.scope_revision,
    status: browse.status,
    nodes: browse.nodes
      .filter((node) => !isSecretFolder(secrets, node.key, node.parent_key ? [...ancestorKeys, node.parent_key] : ancestorKeys))
      .map((node) => {
        // Optional provider measurements; the Mac picker's node type does not carry them.
        const measured = node as { size_bytes?: unknown; file_count?: unknown };
        const sizeBytes = measurement(measured.size_bytes);
        const fileCount = measurement(measured.file_count);
        return {
          key: node.key,
          ...(node.parent_key ? { parent_key: node.parent_key } : {}),
          name: node.name,
          kind: 'folder' as const,
          has_children: node.has_children,
          selectable: node.selectable,
          ...(sizeBytes !== undefined ? { size_bytes: sizeBytes } : {}),
          ...(fileCount !== undefined ? { file_count: fileCount } : {}),
        };
      }),
    ...(browse.next_cursor ? { next_cursor: browse.next_cursor } : {}),
    selections: browse.selections
      .filter((selection) => !isSecretFolder(secrets, selection.key, selection.ancestor_keys))
      .map((selection) => ({ ...selection })),
    whole_account_selected: browse.whole_account_selected,
  };
}

/** A folder's size or file count, forwarded only as a finite non-negative whole number. */
function measurement(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function mailList(browse: Awaited<ReturnType<ChatGptSetupBackend['browseMail']>>, secrets: SecretLocations): MailScopeList {
  return {
    kind: 'mail',
    source_id: 'gmail.email',
    account_generation: browse.accountGeneration,
    scope_revision: browse.scopeRevision,
    status: browse.status,
    draft: withoutSecretMailChoices(browse.draft, secrets),
    labels: browse.labels.filter((label) => !isSecretLabel(secrets, label.id)),
    categories: browse.categories as MailScopeList['categories'],
    sender_suggestions: browse.senderSuggestions.filter((entry) => !isSecretSender(secrets, entry.sender)),
    ...(browse.estimate ? { estimate: browse.estimate } : {}),
  };
}

function withoutSecretMailChoices(draft: OlympusMailScopeDraft, secrets: SecretLocations): OlympusMailScopeDraft {
  return {
    window: draft.window,
    skipped_categories: [...draft.skipped_categories],
    skipped_labels: draft.skipped_labels.filter((label) => !isSecretLabel(secrets, label.id)),
    always_private_senders: draft.always_private_senders.filter((sender) => !isSecretSender(secrets, sender)),
    skip_senders: draft.skip_senders.filter((sender) => !isSecretSender(secrets, sender)),
  };
}

/** The submitted draft with every saved Secrets choice put back (the widget never saw them). */
function keepSecretMailChoices(
  submitted: OlympusMailScopeDraft,
  saved: OlympusMailScopeDraft | undefined,
  secrets: SecretLocations,
): OlympusMailScopeDraft {
  const visible = withoutSecretMailChoices(submitted, secrets);
  if (!saved) return visible;
  return {
    ...visible,
    skipped_labels: [...visible.skipped_labels, ...saved.skipped_labels.filter((label) => isSecretLabel(secrets, label.id))],
    always_private_senders: [...visible.always_private_senders, ...saved.always_private_senders.filter((sender) => isSecretSender(secrets, sender))],
    skip_senders: [...visible.skip_senders, ...saved.skip_senders.filter((sender) => isSecretSender(secrets, sender))],
  };
}

function secretLocations(backend: ChatGptSetupBackend): SecretLocations {
  try {
    return backend.secretLocations();
  } catch {
    // Unreadable owner rules: fail closed rather than risk naming a Secrets location.
    throw new ChatGptSurfaceError('picker_unavailable');
  }
}

function parseDraft(value: unknown): OlympusMailScopeDraft {
  try {
    return parseMailScopeDraft(value);
  } catch {
    throw new ChatGptSurfaceError('invalid_params');
  }
}

function parseSelections(value: unknown): OlympusSourceScopeSelection[] {
  if (!Array.isArray(value) || value.length > 100) throw new ChatGptSurfaceError('invalid_params');
  return value.map((entry) => {
    const record = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const key = requiredString(record.key);
    const state = oneOf(record.state, ['ingest', 'metadata_only', 'exclude'] as const);
    const ancestors = Array.isArray(record.ancestor_keys)
      ? record.ancestor_keys.filter((ancestor): ancestor is string => typeof ancestor === 'string' && ancestor.length > 0 && ancestor.length <= 4096).slice(0, 64)
      : [];
    return { key, state, ...(ancestors.length > 0 ? { ancestor_keys: ancestors } : {}) };
  });
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T[number];
  throw new ChatGptSurfaceError('invalid_params');
}

function requiredString(value: unknown): string {
  if (typeof value === 'string' && value.length > 0 && value.length <= 4096) return value;
  throw new ChatGptSurfaceError('invalid_params');
}

function optionalKeys(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new ChatGptSurfaceError('invalid_params');
  return value.map(requiredString);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value);
}

/**
 * Backend and worker failures as the surface's fixed codes; nothing internal
 * passes. Each code has its own honest sentence in response-builder.ts
 * (ERROR_TEXT), so a failure never reads as a different one.
 */
const BACKEND_CODES: Record<string, ChatGptErrorCode> = {
  model_setup_required: 'models_not_ready',
  oauth_handback_unavailable: 'connect_unavailable',
  oauth_client_id_missing: 'connect_unavailable',
  oauth_client_secret_missing: 'connect_unavailable',
  oauth_start_invalid: 'sign_in_failed',
  dashboard_account_cardinality_violation: 'already_connected',
  source_index_policy_violation: 'not_connected',
  source_index_not_enabled: 'picker_unavailable',
  source_dashboard_not_supported: 'unavailable',
  source_not_connected: 'source_not_connected',
  disconnect_source_busy: 'source_busy',
  disconnect_credential_delete_failed: 'disconnect_incomplete',
  capture_stop_unconfirmed: 'disconnect_incomplete',
  disconnect_scheduler_refresh_not_supported: 'disconnect_incomplete',
  invalid_request: 'invalid_params',
  disconnect_confirmation_required: 'invalid_params',
};

function surfaceError(error: unknown): ChatGptSurfaceError {
  if (error instanceof ChatGptSurfaceError) return error;
  if (error instanceof ModelChoiceRefusal) return new ChatGptSurfaceError(error.code);
  if (error instanceof SetupBackendError) return new ChatGptSurfaceError(BACKEND_CODES[error.code] ?? 'internal');
  if (error instanceof OperationError && error.code === 'config_error') return new ChatGptSurfaceError('internal');
  return new ChatGptSurfaceError('internal');
}
