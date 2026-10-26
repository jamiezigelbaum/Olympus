import type { ConnectedCredentialHandle } from '../workers/credential-broker/connected-handles.ts';
import { V0_4_PUBLIC_SOURCE_IDS } from './public-surface.ts';
import { createSourceCorpusRegistry } from './source-corpus-registry.ts';

export type V04PublicSourceId = (typeof V0_4_PUBLIC_SOURCE_IDS)[number];

export interface PublicSourceDependency {
  id: string;
  label: string;
  required_for: string;
}

export interface PublicSourceCapability {
  source_id: V04PublicSourceId;
  label: string;
  authentication: {
    type: 'oauth2' | 'paired_session' | 'api_key' | 'none';
    ownership: string;
  };
  contextual_scopes: readonly string[];
  dependencies: readonly PublicSourceDependency[];
  provider_ceiling: string;
  supported_formats: readonly string[];
  /** Absent for a source with no credential (nothing to check for a connected handle). */
  doctor_lane?: {
    provider: ConnectedCredentialHandle['provider'];
    capability: string;
    env_flag?: string;
    default_off_when_absent?: boolean;
  };
}

export type PublicSourceDashboardCapability = Omit<PublicSourceCapability, 'doctor_lane'>;

/**
 * Connector-owned product metadata for the exact seven-source v0.4 roster.
 *
 * This catalog describes authentication and provider boundaries only. It does
 * not select extraction, retrieval, reasoning, or answer paths; those remain
 * shared and source-neutral behind the frozen contracts.
 */
export const V0_4_PUBLIC_SOURCE_CAPABILITIES: readonly PublicSourceCapability[] = [
  {
    source_id: 'gmail.email',
    label: 'Gmail',
    authentication: { type: 'oauth2', ownership: 'Olympus publisher Google app with advanced BYO fallback' },
    contextual_scopes: ['mail query', 'exclude Spam and Trash'],
    dependencies: [{ id: 'google_oauth_client', label: 'Google OAuth client', required_for: 'authorization and refresh' }],
    provider_ceiling: 'Provider history traversal and incremental refresh remain bounded by Gmail quota and pagination.',
    supported_formats: ['headers', 'snippet', 'text/plain', 'text/html (stripped)', 'attachment metadata'],
    doctor_lane: {
      provider: 'gmail',
      capability: 'gmail.email.sync',
      env_flag: 'OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_ENABLED',
      default_off_when_absent: true,
    },
  },
  {
    source_id: 'google_drive.docs',
    label: 'Google Drive',
    authentication: { type: 'oauth2', ownership: 'Olympus publisher Google app with advanced BYO fallback' },
    contextual_scopes: ['inclusion roots', 'shared drives', 'exclude trashed items', 'fail-closed ancestry exclusions'],
    dependencies: [{ id: 'google_oauth_client', label: 'Google OAuth client', required_for: 'authorization and refresh' }],
    provider_ceiling: 'Provider history and change traversal remain bounded by Drive quota, pagination, and export limits.',
    supported_formats: ['Google Docs text export', 'text', 'PDF', 'common images'],
    doctor_lane: {
      provider: 'google_drive',
      capability: 'google_drive.docs.sync',
      env_flag: 'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CONNECTOR_STORE_ENABLED',
      default_off_when_absent: true,
    },
  },
  {
    source_id: 'dropbox.files',
    label: 'Dropbox',
    authentication: { type: 'oauth2', ownership: 'one user-owned Dropbox account' },
    contextual_scopes: ['approved path roots', 'metadata-only or full-extract policy per root'],
    dependencies: [
      { id: 'local_document_extractors', label: 'Local document extractors', required_for: 'Office, table, PDF, image, and audio content' },
      { id: 'local_embedding_lane', label: 'Approved local embedding lane', required_for: 'optional semantic retrieval' },
    ],
    provider_ceiling: 'Folder-ID scope is unsupported; traversal is bounded by provider pagination and configured work budgets.',
    supported_formats: ['text', 'Office documents', 'tables', 'PDF', 'common images', 'audio transcription'],
    doctor_lane: {
      provider: 'dropbox',
      capability: 'dropbox.files.sync',
      env_flag: 'OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_ENABLED',
    },
  },
  {
    source_id: 'local.files',
    label: 'Files on this computer',
    authentication: { type: 'none', ownership: 'no account: the folders you choose on this computer' },
    contextual_scopes: ['approved folders and disks (nothing is chosen by default)', 'metadata-only or full-extract policy per folder', 'system, cache, build and version-control folders off by default'],
    dependencies: [
      { id: 'local_document_extractors', label: 'Local document extractors', required_for: 'Office, table, PDF, image, and audio content' },
      { id: 'file_watcher', label: 'Native file watcher (@parcel/watcher)', required_for: 'instant updates; without it folders are re-listed on a timer' },
    ],
    provider_ceiling: 'Changes are seen as the operating system reports them; a folder the system will not let Olympus read (a permission prompt, an unmounted disk) is skipped and reported.',
    supported_formats: ['text', 'Office documents', 'tables', 'PDF', 'common images', 'audio transcription'],
  },
  {
    source_id: 'archive.imports',
    label: 'Archives',
    authentication: { type: 'none', ownership: 'no account: the export files you choose on this computer' },
    contextual_scopes: ['one export file or folder per import, chosen in the dashboard', 'read where it is, never copied, moved or changed', 'content stays Private until the private model judges each item', 'Spam and Trash left out', 'WhatsApp notices left out', 'a chat export is a snapshot: it is not updated after the export'],
    dependencies: [
      { id: 'private_model', label: 'Private model (on this computer, or Venice Private)', required_for: 'judging each imported item before its content may leave Private' },
    ],
    provider_ceiling: 'An import reads the export as it was when chosen: if a file changes or goes missing the import stops and says so; messages too large or unreadable, and attachments, are counted and listed rather than read.',
    supported_formats: ['mail exports in mbox form (Google Takeout, Apple Mail, Thunderbird)', 'headers', 'text/plain', 'text/html (stripped)', 'attachment names', 'WhatsApp chat exports (a chat .txt or .zip, or a folder of them)', 'message text', 'media file names', 'Reflect exports (JSON, or a zip of Markdown files)', 'Roam exports (JSON from Export All)', 'note titles, text, tags and dates', 'Telegram Desktop exports (result.json, Machine-readable JSON)', 'chat messages with their links', 'Telegram service messages (joins, calls, pins) and the account\'s profile, contacts, sessions and other data', 'picture and file names'],
  },
  {
    source_id: 'x.bookmarks',
    label: 'X bookmarks',
    authentication: { type: 'oauth2', ownership: 'user-owned X developer application and API plan' },
    contextual_scopes: ['bookmark folders retained as provenance'],
    dependencies: [{ id: 'x_developer_app', label: 'X developer application', required_for: 'OAuth and bookmark API access' }],
    provider_ceiling: 'Plan availability, cost, rate limits, pagination, and provider windows can prevent complete history.',
    supported_formats: ['post text', 'author', 'URL', 'folder memberships', 'media URLs'],
    doctor_lane: {
      provider: 'x',
      capability: 'x.bookmarks.sync',
      env_flag: 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_ENABLED',
    },
  },
  {
    source_id: 'telegram.messages',
    label: 'Telegram',
    authentication: { type: 'paired_session', ownership: 'one user-owned MTProto session' },
    contextual_scopes: ['explicit approved chats'],
    dependencies: [{ id: 'python_telethon', label: 'Python with Telethon', required_for: 'pairing and capture' }],
    provider_ceiling: 'Only captured approved-chat history is available; attachment bytes are not extracted in v0.4.',
    supported_formats: ['message text', 'replies', 'forwards', 'reactions', 'attachment metadata'],
    doctor_lane: {
      provider: 'telegram',
      capability: 'telegram.messages.sync',
      env_flag: 'OLYMPUS_SOURCE_INDEX_TELEGRAM_MESSAGES_INDEX_ENABLED',
    },
  },
  {
    source_id: 'whatsapp.personal.messages',
    label: 'WhatsApp',
    authentication: { type: 'paired_session', ownership: 'one linked user device' },
    contextual_scopes: ['live linked-device traffic', 'chat exports join the same history (messages live capture holds are kept once; WhatsApp notices left out)', 'Status posts as their own kind'],
    dependencies: [{ id: 'whatsmeow_bridge', label: 'Packaged Whatsmeow bridge (Go and a C compiler for its first build)', required_for: 'QR pairing and live capture' }],
    provider_ceiling: 'Bridge downtime creates an unrecoverable capture gap; general media-byte extraction is unsupported.',
    supported_formats: ['message text', 'captions', 'link previews', 'reactions', 'media metadata', 'voice-note transcript sidecars', 'WhatsApp chat exports (a chat .txt or .zip) with their media listed by name'],
    doctor_lane: {
      provider: 'whatsapp_personal',
      capability: 'whatsapp.personal.messages.sync',
    },
  },
  {
    source_id: 'readwise.library',
    label: 'Readwise',
    authentication: { type: 'api_key', ownership: 'one user-owned Readwise API key' },
    contextual_scopes: ['category', 'location'],
    dependencies: [{ id: 'readwise_api_key', label: 'Readwise API key', required_for: 'Reader and Export API access' }],
    provider_ceiling: 'Reader v3 and Export v2 traversal are bounded by provider pagination and the daily request guard.',
    supported_formats: ['document text', 'highlight text', 'HTML', 'user annotations', 'author', 'tags', 'URL', 'category', 'location'],
    doctor_lane: {
      provider: 'readwise',
      capability: 'readwise.sync',
      env_flag: 'OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_ENABLED',
    },
  },
] as const;

const CAPABILITIES_BY_SOURCE = new Map<V04PublicSourceId, PublicSourceCapability>(
  V0_4_PUBLIC_SOURCE_CAPABILITIES.map((capability) => [capability.source_id, capability]),
);

export function publicSourceCapability(sourceId: V04PublicSourceId): PublicSourceCapability {
  const capability = CAPABILITIES_BY_SOURCE.get(sourceId);
  if (!capability) throw new Error(`Missing v0.4 public source capability metadata for ${sourceId}.`);
  return capability;
}

export function renderPublicSourceCapabilityForDashboard(
  sourceId: V04PublicSourceId,
): PublicSourceDashboardCapability {
  const { doctor_lane: _doctorLane, ...capability } = publicSourceCapability(sourceId);
  return capability;
}

export function publicSourceDoctorLanes(): Array<{
  provider: ConnectedCredentialHandle['provider'];
  capability: string;
  sourceId: V04PublicSourceId;
  corpusId: string;
  envFlag?: string;
  defaultOffWhenAbsent?: boolean;
}> {
  const registry = createSourceCorpusRegistry();
  return V0_4_PUBLIC_SOURCE_CAPABILITIES.flatMap((source) => {
    const lane = source.doctor_lane;
    if (!lane) return [];
    return registry.list('sync')
      .filter((corpus) => corpus.sourceId === source.source_id)
      .map((corpus) => ({
        provider: lane.provider,
        capability: lane.capability,
        sourceId: source.source_id,
        corpusId: corpus.corpusId,
        ...(lane.env_flag ? { envFlag: lane.env_flag } : {}),
        ...(lane.default_off_when_absent === true ? { defaultOffWhenAbsent: true } : {}),
      }));
  });
}

function markdownCell(values: readonly string[]): string {
  return values.join('; ').replaceAll('|', '\\|');
}

export function renderPublicSourceCapabilitiesMarkdown(): string {
  const lines = [
    '| Source | Authentication | Contextual scope | Source-conditioned dependencies | Provider ceiling | Supported formats |',
    '|---|---|---|---|---|---|',
  ];
  for (const source of V0_4_PUBLIC_SOURCE_CAPABILITIES) {
    lines.push([
      `| ${source.label}`,
      `${source.authentication.type}: ${source.authentication.ownership}`,
      markdownCell(source.contextual_scopes),
      markdownCell(source.dependencies.map((dependency) => `${dependency.label} (${dependency.required_for})`)),
      source.provider_ceiling.replaceAll('|', '\\|'),
      `${markdownCell(source.supported_formats)} |`,
    ].join(' | '));
  }
  return lines.join('\n');
}
