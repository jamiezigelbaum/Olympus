import { isFileSourceScopeId } from '../../../core/source-scope-approval.ts';
import { LOCAL_FILES_CORPUS_ID } from '../../local-files/store.ts';
import type { V04PublicSourceId } from '../../../core/public-source-capabilities.ts';
import { READWISE_LIBRARY_CORPUS_ID } from '../../readwise/index.ts';
import { X_BOOKMARKS_CORPUS_ID } from '../../x-bookmarks/index.ts';
import { DROPBOX_FILES_CORPUS_ID } from '../../dropbox-files/index.ts';
import { isTelegramMessagesCorpusId } from '../../telegram-messages/index.ts';
import {
  INTERNAL_EMAIL_CORPUS_ID,
  GMAIL_SECURE_LOCAL_CORPUS_ID,
  GOOGLE_DRIVE_DOCS_CORPUS_ID,
} from '../../google-connectors/corpora.ts';
import type { OlympusFolderScopeSourceId, OlympusSourceScopeSelection } from '../../../control-ui-contract.ts';
import {
  type DashboardSyncSource,
  DASHBOARD_SUPPORTED_SOURCES,
  type DashboardOAuthSource,
  type DashboardApiKeySource,
} from '../../source-dashboard.ts';
import { EmailSourceWorkerError } from './worker-responses.ts';
import { asOptionalString } from './request-fields.ts';
import { isDashboardSyncSource } from './dashboard-connections.ts';

export interface DashboardSourceSyncRequest {
  source: DashboardSyncSource;
  reason: 'post_connect' | 'manual';
}

/**
 * Why Sync now cannot run, when it cannot.
 *
 * `scheduler_disabled` is the one the owner hit: the worker was started with
 * OLYMPUS_WORKER_SCHEDULER_ENABLED=false, so there is no scheduler to run a
 * source on and every source answers the same way. It is a setting, not a
 * property of the source, and the message has to say so.
 *
 * `no_lane` is the source-specific case: the scheduler is running but has built
 * no lane for this source, because nothing here can sync it.
 */
export type DashboardSourceSyncUnsupportedReason = 'scheduler_disabled' | 'no_lane';

/**
 * The one honest answer for "Sync now reached the end of the dispatch chain".
 * A host `triggerSourceSync` hook that does not serve the requested source
 * raises this too, so a missing lane is a typed 501 the dashboard can read
 * rather than an anonymous 500 that reads as a worker crash.
 *
 * The message is read verbatim under the Sync now button, so it names the
 * source the way the card does ("Google Drive", not "google-drive"), says why,
 * and says what would change it. "Private source worker does not support Sync
 * now for google-drive" said none of the three and read as a missing feature
 * over a worker whose scheduler somebody had switched off.
 */
export function dashboardSourceSyncNotSupportedError(
  source: string,
  reason: DashboardSourceSyncUnsupportedReason = 'no_lane',
): EmailSourceWorkerError {
  const label = dashboardConnectSourceLabel(source);
  return reason === 'scheduler_disabled'
    ? new EmailSourceWorkerError(
      501,
      'source_sync_not_supported',
      `Sync now cannot run for ${label}: the background scheduler is switched off on this worker, so no source can be synced.`,
      'Re-run olympus setup, or restore OLYMPUS_WORKER_SCHEDULER_ENABLED=true, then run olympus worker restart.',
    )
    : new EmailSourceWorkerError(
      501,
      'source_sync_not_supported',
      `Sync now cannot run for ${label}: this worker has no sync lane for it, so ${label} only updates on its own schedule.`,
      'Check olympus doctor and the worker log for why this lane was not built.',
    );
}

/** The card's own name for a connect source; the id itself when nothing claims it. */
function dashboardConnectSourceLabel(source: string): string {
  return DASHBOARD_SUPPORTED_SOURCES.find((definition) =>
    (definition.connect_action.kind === 'oauth' || definition.connect_action.kind === 'api_key'
      || definition.connect_action.kind === 'this_computer')
    && definition.connect_action.source === source)?.label
    ?? source;
}

export function sourceSchedulerSourceIdForCorpus(corpusId: string): string | undefined {
  if (corpusId === INTERNAL_EMAIL_CORPUS_ID || corpusId === GMAIL_SECURE_LOCAL_CORPUS_ID) {
    return 'gmail.email';
  }
  if (corpusId === GOOGLE_DRIVE_DOCS_CORPUS_ID || corpusId === 'secure_local.drive.docs') {
    return 'google_drive.docs';
  }
  if (corpusId === DROPBOX_FILES_CORPUS_ID) return 'dropbox.files';
  if (corpusId === LOCAL_FILES_CORPUS_ID) return 'local.files';
  if (corpusId === READWISE_LIBRARY_CORPUS_ID) return 'readwise.library';
  if (corpusId === X_BOOKMARKS_CORPUS_ID) return 'x.bookmarks';
  if (isTelegramMessagesCorpusId(corpusId)) return 'telegram.messages';
  if (corpusId === 'secure_local.whatsapp.messages') return 'whatsapp.personal.messages';
  if (corpusId === 'secure_local.evernote.notes' || corpusId === 'internal.evernote.notes') return 'evernote.notes';
  return undefined;
}

export function parseDashboardOAuthSource(value: unknown): DashboardOAuthSource {
  const source = asOptionalString(value);
  if (source === 'google' || source === 'gmail' || source === 'google-drive' || source === 'dropbox' || source === 'x' || source === 'evernote') {
    return source;
  }
  throw new EmailSourceWorkerError(400, 'invalid_request', 'source must be google, gmail, google-drive, dropbox, x, or evernote.');
}

export function parseDashboardApiKeySource(value: unknown): DashboardApiKeySource | 'gemini' {
  const source = asOptionalString(value);
  if (source === 'gemini' || source === 'venice' || source === 'readwise') return source;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'source must be gemini, venice, or readwise.');
}

export function parseDashboardSyncSource(value: unknown): DashboardSyncSource {
  const source = asOptionalString(value);
  if (source && isDashboardSyncSource(source)) return source;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'source must be gmail, google-drive, dropbox, x, readwise, or a source on this computer.');
}

export function parseFolderScopeSourceId(value: unknown): OlympusFolderScopeSourceId {
  if (typeof value === 'string' && isFileSourceScopeId(value)) return value;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'source_id must name a folder-capable source.');
}

export function parseSourceScopeSelections(value: unknown): OlympusSourceScopeSelection[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'selections must be an array of at most 100 folders.');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new EmailSourceWorkerError(400, 'invalid_request', 'Every scope selection must be an object.');
    }
    const record = entry as Record<string, unknown>;
    const key = asOptionalString(record.key);
    if (!key || !['ingest', 'metadata_only', 'on_demand', 'exclude'].includes(String(record.state))) {
      throw new EmailSourceWorkerError(400, 'invalid_request', 'Every scope selection requires a folder key and disposition.');
    }
    const ancestorKeys = record.ancestor_keys === undefined
      ? undefined
      : Array.isArray(record.ancestor_keys)
        ? record.ancestor_keys.map((ancestor) => asOptionalString(ancestor)).filter((ancestor): ancestor is string => Boolean(ancestor))
        : undefined;
    return {
      key,
      state: record.state as OlympusSourceScopeSelection['state'],
      ...(ancestorKeys?.length ? { ancestor_keys: ancestorKeys } : {}),
    };
  });
}

export function parseDashboardDisconnectSource(value: unknown): V04PublicSourceId {
  const source = asOptionalString(value);
  if (
    source === 'gmail.email'
    || source === 'google_drive.docs'
    || source === 'dropbox.files'
    || source === 'x.bookmarks'
    || source === 'telegram.messages'
    || source === 'whatsapp.personal.messages'
    || source === 'readwise.library'
    || source === 'evernote.notes'
  ) return source;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'source_id must name one declared v0.4 source.');
}
