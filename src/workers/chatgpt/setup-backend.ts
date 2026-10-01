/**
 * The engine side of setup from ChatGPT (setup-tools.ts): each call goes to
 * the worker's own dashboard route in process, so the ChatGPT panel and the
 * Mac's dashboard share one blessed path for OAuth start, folder and mail
 * scope (compare-and-swap, model-readiness gate, grant lock) and disconnect.
 * Model switching writes the owner's sovereignty policy through the same
 * validator and writer `olympus sovereignty init` uses.
 */
import { mailScopeDraftView } from '../../core/mail-source-scope.ts';
import type { RemotePublicUrls } from '../../core/remote-public-url.ts';
import {
  writeSovereigntyConfigFile,
  type SovereigntyConfig,
  type SovereigntyModelProfile,
} from '../../core/sovereignty.ts';
import type {
  OlympusFolderScopeBrowseResult,
  OlympusMailScopeDraft,
  OlympusSourceScopeSelection,
} from '../../control-ui-contract.ts';
import { HANDOFF_PATH_PREFIX } from '../../../connect-relay/shared/tokens.ts';
import type { ChatGptDisconnectSourceId, ChatGptOAuthSource, PrivacyRuleView, PrivacySettings } from './dashboard-contract.ts';
import { readPrivacyProfile, writePrivacyProfile, type PrivacyRule } from '../classification/privacy-profile.ts';
import type { ChatGptHandoffs } from './handoff.ts';
import {
  ANSWER_PROFILE_IDS,
  ModelChoiceRefusal,
  answerProfile,
  applyModelChoice,
  currentAnswerChoice,
  embeddingIsBuiltIn,
} from './model-choice.ts';
import { loadSecretLocations } from './scope-privacy.ts';
import { SetupBackendError, type ChatGptSetupBackend } from './setup-tools.ts';

const WORKER_ORIGIN = 'http://olympus-worker.internal';

/** The sign-in a Disconnect cancels: the source ChatGPT's Connect starts for it. */
const DISCONNECT_OAUTH_SOURCES: Readonly<Partial<Record<ChatGptDisconnectSourceId, ChatGptOAuthSource>>> = {
  'gmail.email': 'gmail',
  'google_drive.docs': 'google-drive',
  'dropbox.files': 'dropbox',
};

export interface ChatGptSetupBackendOptions {
  /** The worker's own fetch (no bearer: in process). */
  workerFetch: (request: Request) => Promise<Response>;
  handoffs: ChatGptHandoffs;
  /** The relay's public URLs for this install; `installId` set in relay mode. */
  publicUrls: () => RemotePublicUrls | undefined;
  /** The scope summaries the Mac picker reads (saved selections and mail draft). */
  scopeSummaries?: () => ReadonlyArray<Record<string, unknown>>;
  sovereignty: { config: SovereigntyConfig; source: string; path?: string };
  /** Whether a profile's credential is on the Mac (never the value). */
  credentialPresent: (id: string, profile: SovereigntyModelProfile) => boolean;
  /** Restarts the worker to apply a policy change; false when it cannot restart itself. */
  requestReload: () => boolean;
  /** Items held for the privacy check across every tier ledger (counts only). */
  pendingClassificationCount?: () => number;
  env?: Record<string, string | undefined>;
}

/** A saved rule in the contract's shape (dashboard-contract.ts PrivacyRuleView). */
function privacyRuleView(rule: PrivacyRule): PrivacyRuleView[] {
  if (rule.kind === 'sender' && rule.value) return [{ kind: 'sender', source_id: 'gmail.email', value: rule.value }];
  if (rule.kind === 'label' && rule.key && rule.value) return [{ kind: 'label', source_id: 'gmail.email', key: rule.key, value: rule.value }];
  if (rule.kind === 'folder' && rule.key && rule.source_id !== 'gmail.email') {
    return [{ kind: 'folder', source_id: rule.source_id, key: rule.key, ...(rule.display ? { display: rule.display } : {}) }];
  }
  return [];
}

/** The owner's privacy settings and the privacy-check backlog. Throws when the profile cannot be read. */
export function readChatGptPrivacySettings(
  env: Record<string, string | undefined>,
  pendingCount: number,
): PrivacySettings {
  const profile = readPrivacyProfile({ env });
  return {
    configured: profile !== undefined,
    description: profile?.description ?? '',
    rules: (profile?.rules ?? []).flatMap(privacyRuleView),
    pendingCount,
  };
}

export function createChatGptSetupBackend(options: ChatGptSetupBackendOptions): ChatGptSetupBackend {
  let policy = options.sovereignty.config;

  const post = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await options.workerFetch(new Request(`${WORKER_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const parsed = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok || !parsed) {
      const code = (parsed?.error as { code?: unknown } | undefined)?.code;
      throw new SetupBackendError(typeof code === 'string' ? code : 'internal');
    }
    return parsed;
  };

  const summary = (sourceId: string): Record<string, unknown> | undefined =>
    options.scopeSummaries?.().find((entry) => entry.source_id === sourceId);
  const savedMailDraft = (): OlympusMailScopeDraft | undefined => {
    const draft = summary('gmail.email')?.mail_scope;
    return draft && typeof draft === 'object' ? draft as OlympusMailScopeDraft : undefined;
  };

  return {
    async startOAuth(source) {
      const result = await post('/dashboard/connect/oauth/start', { source, handback: 'relay' });
      if (typeof result.authorization_url !== 'string' || typeof result.expires_at !== 'string') throw new SetupBackendError('internal');
      return { authorizationUrl: result.authorization_url, expiresAt: result.expires_at };
    },

    handoffLink(target) {
      const urls = options.publicUrls();
      if (!urls?.installId) return undefined;
      const link = options.handoffs.mint(urls.installId, target);
      return { url: `${urls.origin}${HANDOFF_PATH_PREFIX}${link.id}`, expiresAt: link.expiresAt };
    },

    async browseFolders(input) {
      const result = await post('/dashboard/dispositions', {
        action: 'browse_folder_scope',
        source_id: input.sourceId,
        ...(input.parentKey ? { parent_key: input.parentKey } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      const browse = result.scope_browser as OlympusFolderScopeBrowseResult | undefined;
      if (!browse || !Array.isArray(browse.nodes)) throw new SetupBackendError('internal');
      return browse;
    },

    async approveFolders(input) {
      const result = await post('/dashboard/dispositions', {
        action: 'approve_source_scope_and_start',
        source_id: input.sourceId,
        account_generation: input.accountGeneration,
        expected_scope_revision: input.expectedRevision,
        selections: input.selections,
        whole_account: input.wholeAccount,
        explicit_whole_account_confirmation: input.wholeAccount,
      });
      return { scopeRevision: String(result.scope_revision ?? ''), started: result.ingestion_started === true };
    },

    savedFolderSelections(sourceId) {
      const selections = summary(sourceId)?.selections;
      return Array.isArray(selections) ? selections as OlympusSourceScopeSelection[] : [];
    },

    async browseMail(draft) {
      const result = await post('/dashboard/dispositions', {
        action: 'browse_mail_scope',
        source_id: 'gmail.email',
        draft: draft ?? savedMailDraft() ?? mailScopeDraftView(undefined),
      });
      const data = (result.summary ?? {}) as Record<string, unknown>;
      return {
        accountGeneration: String(result.account_generation ?? ''),
        scopeRevision: String(result.scope_revision ?? ''),
        status: result.status === 'approved' ? 'approved' : 'scope_pending',
        draft: result.draft as OlympusMailScopeDraft,
        labels: Array.isArray(data.labels) ? data.labels as Array<{ id: string; name: string; system: boolean }> : [],
        categories: Array.isArray(data.categories) ? data.categories as Array<{ category: string; messages_total?: number }> : [],
        senderSuggestions: Array.isArray(data.sender_suggestions)
          ? data.sender_suggestions as Array<{ sender: string; sample_messages: number }>
          : [],
        ...(data.estimate && typeof data.estimate === 'object'
          ? { estimate: data.estimate as { content_messages: number; metadata_messages: number; total_messages: number } }
          : {}),
      };
    },

    async approveMail(input) {
      const result = await post('/dashboard/dispositions', {
        action: 'approve_mail_scope_and_start',
        source_id: 'gmail.email',
        account_generation: input.accountGeneration,
        expected_scope_revision: input.expectedRevision,
        scope: input.draft,
      });
      return { scopeRevision: String(result.scope_revision ?? ''), started: result.ingestion_started === true };
    },

    savedMailDraft,

    async disconnect(sourceId) {
      // A sign-in still outstanding for this source is cancelled first, so
      // Disconnect on a source mid-sign-in ends that attempt (a late return
      // from the provider then finds nothing to complete) instead of failing
      // with "not connected".
      const oauth = DISCONNECT_OAUTH_SOURCES[sourceId];
      const cancelled = oauth
        ? (await post('/dashboard/connect/oauth/cancel', { source: oauth })).cancelled === true
        : false;
      try {
        await post('/dashboard/disconnect', { source_id: sourceId, acknowledge: true });
      } catch (error) {
        if (cancelled && error instanceof SetupBackendError && error.code === 'source_not_connected') return;
        throw error;
      }
    },

    async setModels(choice) {
      const configured = {
        venice: options.credentialPresent(ANSWER_PROFILE_IDS.venice, policy.modelProfiles[ANSWER_PROFILE_IDS.venice] ?? answerProfile('venice')),
        local: Object.values(policy.modelProfiles).some((profile) => profile.provider === 'local-openai-compatible' && profile.purpose !== 'embedding'),
      };
      const next = applyModelChoice(policy, choice, configured);
      let restarting = false;
      if (next.changed) {
        // Only a policy file the owner already has is rewritten; an inline or
        // environment policy is changed where it lives, on the Mac.
        if (options.sovereignty.source !== 'file' || !options.sovereignty.path) throw new ModelChoiceRefusal('model_not_configured');
        writeSovereigntyConfigFile({ config: next.config, path: options.sovereignty.path, force: true });
        policy = next.config;
        restarting = options.requestReload();
      }
      const answers = currentAnswerChoice(policy);
      return {
        changed: next.changed,
        embedding: embeddingIsBuiltIn(policy) ? 'built_in' : 'custom',
        ...(answers ? { answers } : {}),
        restarting,
      };
    },

    secretLocations() {
      return loadSecretLocations(options.env ?? process.env);
    },

    privacySettings() {
      return readChatGptPrivacySettings(options.env ?? process.env, safeCount(options.pendingClassificationCount));
    },

    savePrivacy(update) {
      writePrivacyProfile({
        ...(update.description !== undefined ? { description: update.description } : {}),
        ...(update.rules ? { rules: update.rules as PrivacyRule[] } : {}),
      }, { env: options.env ?? process.env });
      return readChatGptPrivacySettings(options.env ?? process.env, safeCount(options.pendingClassificationCount));
    },
  };
}

function safeCount(count: (() => number) | undefined): number {
  try {
    const value = count?.() ?? 0;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}
