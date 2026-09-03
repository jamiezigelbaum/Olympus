import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writePrivateFileAtomic } from '../../core/atomic-file.ts';
import { PUBLIC_RUNTIME_BUILD } from '../../core/build-flavor.ts';
import {
  FileLeaseBusyError,
  FileLeaseLostError,
  withFileLease,
  type FileLease,
  type FileLeaseOptions,
} from '../../core/file-lease.ts';
import {
  GOOGLE_OAUTH_TOKEN_URL,
} from '../../core/google-service-account.ts';
import {
  fetchBoundedText,
  isAbortError,
  isBoundedResponseTooLargeError,
} from '../../core/http-timeout.ts';
import { googlePublisherExchangeRefreshUrl } from '../../core/oauth-relay.ts';
import { isGooglePublisherWebClientId } from '../../core/publisher-oauth-client.ts';
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
import {
  googleServiceAccountTokenUrl,
  parseGoogleServiceAccountKey,
  signGoogleServiceAccountJwt,
  GOOGLE_JWT_BEARER_GRANT_TYPE,
  type GoogleServiceAccountKey,
} from '../../core/google-service-account.ts';
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
import {
  createDefaultSecretStore,
  normalizeSecretRef,
  resolveSecretRefValue,
  type SecretStore,
} from '../../core/secret-store.ts';
import type { SourceTrustDomain } from '../../core/source-index/types.ts';
import {
  deriveEnvCredentialHandlesFromRegistry,
  handleRegistryPathFromEnv,
  markConnectedHandleExchangeVia,
  markConnectedHandleReauthRequired,
  readConnectedHandleRegistry,
} from './connected-handles.ts';

/**
 * The provider set is a runtime value, not only a type. Registry text is
 * owner-editable and reaches the mint path, so a label the broker does not know
 * must be refused at parse rather than cast into this union and trusted by
 * every downstream policy that keys off it.
 */
const PUBLIC_CREDENTIAL_PROVIDERS = [
  'readwise',
  'gmail',
  'google_drive',
  'dropbox',
  'telegram',
  'whatsapp_personal',
  'x',
] as const;

const PRIVATE_CREDENTIAL_PROVIDERS = [
  'notion',
  'google_calendar',
  'gcp',
  'whatsapp_business',
  'apple_messages',
  'reflect',
  'roam',
] as const;

export const CREDENTIAL_PROVIDERS = [
  ...PUBLIC_CREDENTIAL_PROVIDERS,
  ...(PUBLIC_RUNTIME_BUILD ? [] : PRIVATE_CREDENTIAL_PROVIDERS),
] as const;

export type CredentialProvider = typeof CREDENTIAL_PROVIDERS[number];

export function isCredentialProvider(value: unknown): value is CredentialProvider {
  return typeof value === 'string' && (CREDENTIAL_PROVIDERS as readonly string[]).includes(value);
}
export type CredentialSessionKind =
  | 'bearer_token'
  | 'runtime_connector'
  | 'mtproto_session'
  | 'tdlib_session'
  | 'local_app_database'
  | 'archive_path'
  | 'webhook_token';
export type CredentialBrokerOutcome = 'issued' | 'missing' | 'reauth_required' | 'denied';
export type CredentialBrokerFetch = (input: URL | string | Request, init?: RequestInit) => Promise<Response>;
export type CredentialBrokerErrorCode =
  | 'credential_handle_not_registered'
  | 'credential_capability_not_allowed'
  | 'credential_missing'
  | 'credential_reauth_required'
  | 'credential_refresh_busy'
  | 'credential_refresh_failed'
  | 'credential_session_kind_unsupported'
  | 'credential_backend_malformed';

export const CREDENTIAL_REFRESH_BUSY_RETRY_MS = 30_000;
export const CREDENTIAL_BROKER_ERROR_SUBSYSTEM = 'credential_broker';

export interface CredentialRefreshBusyError {
  readonly subsystem: typeof CREDENTIAL_BROKER_ERROR_SUBSYSTEM;
  readonly code: 'credential_refresh_busy';
  readonly retryable: true;
  readonly retryAfterMs?: number;
}

/**
 * Recognize refresh contention across process/module boundaries. `instanceof`
 * is intentionally insufficient because the Unix-socket client reconstructs
 * the same typed error under a different class identity.
 */
export function isCredentialRefreshBusyError(
  error: unknown,
): error is CredentialRefreshBusyError {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const candidate = error as Record<string, unknown>;
  return candidate.subsystem === CREDENTIAL_BROKER_ERROR_SUBSYSTEM
    && candidate.code === 'credential_refresh_busy'
    && candidate.retryable === true
    && (
      candidate.retryAfterMs === undefined
      || (
        typeof candidate.retryAfterMs === 'number'
        && Number.isSafeInteger(candidate.retryAfterMs)
        && candidate.retryAfterMs > 0
      )
    );
}

export interface CredentialSessionRequest {
  handle: string;
  provider?: CredentialProvider;
  capability: string;
  trustDomain?: SourceTrustDomain;
  purpose?: string;
}

export interface CredentialSessionAudit {
  handle: string;
  provider: CredentialProvider;
  capability: string;
  accountRole?: string;
  trustDomain?: SourceTrustDomain;
  scopes: string[];
  outcome: CredentialBrokerOutcome;
  issuedAt: string;
  expiresAt?: string;
  backendLabel?: string;
  rawCredentialExposed: false;
}

export interface BearerTokenCredentialSession {
  kind: 'bearer_token';
  handle: string;
  provider: CredentialProvider;
  capability: string;
  token: string;
  expiresAt?: string;
  audit: CredentialSessionAudit;
}

interface BaseDescriptorCredentialSession {
  handle: string;
  provider: CredentialProvider;
  capability: string;
  accountRole?: string;
  trustDomain?: SourceTrustDomain;
  expiresAt?: string;
  backendLabel?: string;
  audit: CredentialSessionAudit;
}

export interface RuntimeConnectorCredentialSession extends BaseDescriptorCredentialSession {
  kind: 'runtime_connector';
  connectorBackendId: string;
  connectorRoute?: string;
  leaseId?: string;
}

export interface TdlibCredentialSession extends BaseDescriptorCredentialSession {
  kind: 'tdlib_session';
  tdlibProfileId: string;
  runtimeEndpointId: string;
  leaseId?: string;
}

export interface MtprotoCredentialSession extends BaseDescriptorCredentialSession {
  kind: 'mtproto_session';
  mtprotoProfileId: string;
  runtimeEndpointId: string;
  library?: string;
  leaseId?: string;
}

export interface LocalAppDatabaseCredentialSession extends BaseDescriptorCredentialSession {
  kind: 'local_app_database';
  databaseSourceId: string;
  readerWorker: string;
  databaseRole: string;
  scopeLabel?: string;
}

export interface ArchivePathCredentialSession extends BaseDescriptorCredentialSession {
  kind: 'archive_path';
  archiveRootAlias: string;
  readerWorker: string;
  contentBounds?: string;
  importRunId?: string;
}

export interface WebhookTokenCredentialSession extends BaseDescriptorCredentialSession {
  kind: 'webhook_token';
  webhookIntegrationId: string;
  validationMode: string;
  verifierReference: string;
  leaseId?: string;
}

export type DescriptorCredentialSession =
  | RuntimeConnectorCredentialSession
  | MtprotoCredentialSession
  | TdlibCredentialSession
  | LocalAppDatabaseCredentialSession
  | ArchivePathCredentialSession
  | WebhookTokenCredentialSession;

export type CredentialSession = BearerTokenCredentialSession | DescriptorCredentialSession;

export interface CredentialHandleStatus {
  handle: string;
  provider: CredentialProvider;
  sessionKind: CredentialSessionKind;
  accountRole?: string;
  trustDomain?: SourceTrustDomain;
  capabilities: string[];
  scopes: string[];
  status: 'available' | 'missing' | 'reauth_required';
  rawCredentialExposed: false;
}

export interface CredentialBroker {
  issueSession(request: CredentialSessionRequest): Promise<CredentialSession>;
  status?(handle: string): Promise<CredentialHandleStatus>;
}

export interface CredentialOAuth2HandleState {
  refreshToken?: string;
  providerAccountId?: string;
  scopes?: string[];
  status?: 'available' | 'reauth_required';
  updatedAt?: string;
  /**
   * Set while a refresh is in flight and cleared once its outcome is durably
   * recorded. A provider that rotates refresh tokens invalidates the one being
   * spent the moment it answers, so a marker that survives into the next mint
   * means the answer may have been lost and the stored token may already be
   * dead. Passing `undefined` through `save` clears it.
   */
  pendingRefreshStartedAt?: string | undefined;
}

export interface CredentialOAuth2StateStore {
  load(handle: string): Promise<CredentialOAuth2HandleState | undefined>;
  save(handle: string, state: CredentialOAuth2HandleState): Promise<void>;
  /** Remove one locally custodied rotating grant without touching provider state. */
  delete?(handle: string): Promise<void>;
  leaseTargetPath?(handle: string): string;
}

export interface CredentialSessionBackendStateStore {
  load(handle: string): Promise<unknown | undefined>;
}

type DescriptorSessionKind = Exclude<CredentialSessionKind, 'bearer_token'>;
type CredentialSessionBackendStatus = 'available' | 'reauth_required';

interface BaseCredentialSessionBackendStateInput {
  kind: DescriptorSessionKind;
  status?: CredentialSessionBackendStatus;
  expiresAt?: string;
  expiresInSeconds?: number;
  backendLabel?: string;
}

export interface RuntimeConnectorBackendStateInput extends BaseCredentialSessionBackendStateInput {
  kind: 'runtime_connector';
  connectorBackendId: string;
  connectorRoute?: string;
  leaseId?: string;
}

export interface TdlibSessionBackendStateInput extends BaseCredentialSessionBackendStateInput {
  kind: 'tdlib_session';
  tdlibProfileId: string;
  runtimeEndpointId: string;
  leaseId?: string;
}

export interface MtprotoSessionBackendStateInput extends BaseCredentialSessionBackendStateInput {
  kind: 'mtproto_session';
  mtprotoProfileId: string;
  runtimeEndpointId: string;
  library?: string;
  leaseId?: string;
}

export interface LocalAppDatabaseBackendStateInput extends BaseCredentialSessionBackendStateInput {
  kind: 'local_app_database';
  databaseSourceId: string;
  readerWorker: string;
  databaseRole: string;
  scopeLabel?: string;
}

export interface ArchivePathBackendStateInput extends BaseCredentialSessionBackendStateInput {
  kind: 'archive_path';
  archiveRootAlias: string;
  readerWorker: string;
  contentBounds?: string;
  importRunId?: string;
}

export interface WebhookTokenBackendStateInput extends BaseCredentialSessionBackendStateInput {
  kind: 'webhook_token';
  webhookIntegrationId: string;
  validationMode: string;
  verifierReference: string;
  leaseId?: string;
}

export type CredentialSessionBackendStateInput =
  | RuntimeConnectorBackendStateInput
  | MtprotoSessionBackendStateInput
  | TdlibSessionBackendStateInput
  | LocalAppDatabaseBackendStateInput
  | ArchivePathBackendStateInput
  | WebhookTokenBackendStateInput;

type NormalizedCredentialSessionBackendState = CredentialSessionBackendStateInput & {
  status: CredentialSessionBackendStatus;
};

interface NormalizedBackendStateBase {
  status: CredentialSessionBackendStatus;
  expiresAt?: string;
  expiresInSeconds?: number;
  backendLabel?: string;
}

export interface EnvOAuth2RefreshDefinition {
  tokenUrl: string;
  clientIdEnvNames: string[];
  clientSecretEnvNames?: string[];
  refreshTokenEnvNames?: string[];
  clientIdSecretRef?: string;
  clientSecretSecretRef?: string;
  refreshTokenSecretRef?: string;
  scopes?: string[];
  /**
   * `'publisher_endpoint'` routes the refresh through
   * `googlePublisherExchangeUrl()` instead of `tokenUrl` — see
   * `refreshOAuth2AccessToken` and `docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md`.
   * Written at connect time (`src/core/connect.ts`) onto a Google
   * publisher-Web-client credential and carried here unchanged by
   * `deriveEnvCredentialHandlesFromRegistry`.
   */
  exchangeVia?: 'publisher_endpoint';
}

/**
 * A Google service-account key used under domain-wide delegation.
 *
 * The impersonated subject is declared per handle rather than once per
 * process: delegation is granted across the whole organisation and the JWT's
 * `sub` claim is what selects the mailbox, so one key serves the personal and
 * the business account through two handles that differ only in this field.
 * The subject's env NAMES live in the repo-owned default, never in the
 * on-disk handle registry, so editing that registry cannot silently redirect
 * impersonation at a mailbox the owner did not intend; the mailbox VALUE
 * comes from the same wrapper-exported environment that already supplies the
 * service-account key, which is strictly more powerful than the subject.
 */
export interface EnvServiceAccountJwtDefinition {
  tokenUrl?: string;
  credentialJsonEnvNames: string[];
  credentialJsonSecretRef?: string;
  impersonatedSubjectEnvNames: string[];
  scopes?: string[];
}

export interface EnvCredentialHandleDefinition {
  handle: string;
  provider: CredentialProvider;
  sessionKind?: CredentialSessionKind;
  allowedCapabilities: string[];
  tokenEnvNames: string[];
  tokenSecretRefs?: string[];
  statusEnvNames?: string[];
  oauth2Refresh?: EnvOAuth2RefreshDefinition;
  serviceAccountJwt?: EnvServiceAccountJwtDefinition;
  scopes?: string[];
  accountRole?: string;
  trustDomain?: SourceTrustDomain;
  expiresInSeconds?: number;
  backendState?: CredentialSessionBackendStateInput;
}

export interface EnvCredentialBrokerOptions {
  env?: Record<string, string | undefined>;
  handles?: EnvCredentialHandleDefinition[];
  now?: () => Date;
  fetch?: CredentialBrokerFetch;
  oauth2StateStore?: CredentialOAuth2StateStore;
  oauth2RefreshFailureBackoffMs?: number;
  oauth2CacheNamespace?: string;
  oauth2LeaseOptions?: FileLeaseOptions;
  backendStates?: Record<string, unknown>;
  backendStateStore?: CredentialSessionBackendStateStore;
  secretStore?: SecretStore;
  handleRegistryPath?: string;
  loadDefaultHandleRegistry?: boolean;
}

export interface StaticCredentialHandleDefinition {
  handle: string;
  provider: CredentialProvider;
  sessionKind?: CredentialSessionKind;
  allowedCapabilities: string[];
  token?: string;
  scopes?: string[];
  accountRole?: string;
  trustDomain?: SourceTrustDomain;
  expiresAt?: string;
  backendState?: CredentialSessionBackendStateInput;
}

export class CredentialBrokerError extends Error {
  readonly subsystem = CREDENTIAL_BROKER_ERROR_SUBSYSTEM;
  readonly code: CredentialBrokerErrorCode;
  readonly handle: string;
  readonly capability?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: CredentialBrokerErrorCode,
    message: string,
    options: { handle: string; capability?: string },
  ) {
    super(message);
    this.code = code;
    this.handle = options.handle;
    if (options.capability) this.capability = options.capability;
    this.retryable = code === 'credential_refresh_busy' || code === 'credential_refresh_failed';
    if (code === 'credential_refresh_busy') {
      this.retryAfterMs = CREDENTIAL_REFRESH_BUSY_RETRY_MS;
    }
  }
}

const GOOGLE_GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GOOGLE_DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const GOOGLE_CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/**
 * The one env var the 1Password runtime wrapper has to export. Every delegated
 * handle also accepts a handle-specific name first, so a single mailbox can be
 * pointed at a different key later without disturbing the others.
 */
const GOOGLE_SHARED_SERVICE_ACCOUNT_JSON_ENV_NAME = 'OLYMPUS_CREDENTIAL_GOOGLE_OLYMPUS_SERVICE_ACCOUNT_JSON';

function delegatedGoogleHandle(options: {
  handle: string;
  provider: CredentialProvider;
  accountRole: string;
  trustDomain: SourceTrustDomain;
  capability: string;
  scopes: string[];
  impersonatedSubjectEnvNames: string[];
  credentialJsonEnvNames: string[];
}): EnvCredentialHandleDefinition {
  return {
    handle: options.handle,
    provider: options.provider,
    accountRole: options.accountRole,
    trustDomain: options.trustDomain,
    allowedCapabilities: [options.capability],
    scopes: [...options.scopes],
    tokenEnvNames: [],
    serviceAccountJwt: {
      tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
      credentialJsonEnvNames: [
        ...options.credentialJsonEnvNames,
        GOOGLE_SHARED_SERVICE_ACCOUNT_JSON_ENV_NAME,
      ],
      impersonatedSubjectEnvNames: [...options.impersonatedSubjectEnvNames],
      scopes: [...options.scopes],
    },
    expiresInSeconds: 3600,
  };
}

const DEFAULT_ENV_HANDLES: EnvCredentialHandleDefinition[] = [
  {
    handle: 'gmail.personal',
    provider: 'gmail',
    accountRole: 'personal',
    trustDomain: 'secure_local',
    allowedCapabilities: ['gmail.email.sync'],
    scopes: [GOOGLE_GMAIL_READONLY_SCOPE],
    tokenEnvNames: [],
    oauth2Refresh: {
      tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
      clientIdEnvNames: [
        'OLYMPUS_CREDENTIAL_GMAIL_PERSONAL_OAUTH2_CLIENT_ID',
        ...(PUBLIC_RUNTIME_BUILD ? [] : ['OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_CLIENT_ID']),
      ],
      clientSecretEnvNames: [
        'OLYMPUS_CREDENTIAL_GMAIL_PERSONAL_OAUTH2_CLIENT_SECRET',
        ...(PUBLIC_RUNTIME_BUILD ? [] : ['OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_CLIENT_SECRET']),
      ],
      refreshTokenEnvNames: [
        'OLYMPUS_CREDENTIAL_GMAIL_PERSONAL_OAUTH2_REFRESH_TOKEN',
        ...(PUBLIC_RUNTIME_BUILD ? [] : ['OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_REFRESH_TOKEN']),
      ],
      scopes: [GOOGLE_GMAIL_READONLY_SCOPE],
    },
    expiresInSeconds: 3600,
  },
  ...(PUBLIC_RUNTIME_BUILD ? [] : ([delegatedGoogleHandle({
    handle: 'gmail.business_ocu',
    provider: 'gmail',
    accountRole: 'business_ocu',
    trustDomain: 'secure_local',
    capability: 'gmail.email.sync',
    scopes: [GOOGLE_GMAIL_READONLY_SCOPE],
    impersonatedSubjectEnvNames: [
      'OLYMPUS_CREDENTIAL_GMAIL_BUSINESS_OCU_SUBJECT',
      'OLYMPUS_CREDENTIAL_GOOGLE_BUSINESS_SUBJECT',
    ],
    credentialJsonEnvNames: ['OLYMPUS_CREDENTIAL_GMAIL_BUSINESS_OCU_SERVICE_ACCOUNT_JSON'],
  }),
  {
    handle: 'gmail.personal.direct',
    provider: 'gmail',
    accountRole: 'personal',
    trustDomain: 'secure_local',
    allowedCapabilities: ['gmail.email.sync'],
    scopes: [GOOGLE_GMAIL_READONLY_SCOPE],
    tokenEnvNames: [],
    oauth2Refresh: {
      tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
      clientIdEnvNames: [
        'OLYMPUS_CREDENTIAL_GMAIL_PERSONAL_DIRECT_OAUTH2_CLIENT_ID',
        'OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_CLIENT_ID',
      ],
      clientSecretEnvNames: [
        'OLYMPUS_CREDENTIAL_GMAIL_PERSONAL_DIRECT_OAUTH2_CLIENT_SECRET',
        'OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_CLIENT_SECRET',
      ],
      refreshTokenEnvNames: [
        'OLYMPUS_CREDENTIAL_GMAIL_PERSONAL_DIRECT_OAUTH2_REFRESH_TOKEN',
        'OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_REFRESH_TOKEN',
      ],
      scopes: [GOOGLE_GMAIL_READONLY_SCOPE],
    },
    expiresInSeconds: 3600,
  }] satisfies EnvCredentialHandleDefinition[])),
  {
    handle: 'google_drive.personal',
    provider: 'google_drive',
    accountRole: 'personal',
    trustDomain: 'internal',
    allowedCapabilities: ['google_drive.docs.sync'],
    scopes: [GOOGLE_DRIVE_READONLY_SCOPE],
    tokenEnvNames: [],
    oauth2Refresh: {
      tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
      clientIdEnvNames: [
        'OLYMPUS_CREDENTIAL_GOOGLE_DRIVE_PERSONAL_OAUTH2_CLIENT_ID',
        ...(PUBLIC_RUNTIME_BUILD ? [] : ['OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_CLIENT_ID']),
      ],
      clientSecretEnvNames: [
        'OLYMPUS_CREDENTIAL_GOOGLE_DRIVE_PERSONAL_OAUTH2_CLIENT_SECRET',
        ...(PUBLIC_RUNTIME_BUILD ? [] : ['OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_CLIENT_SECRET']),
      ],
      refreshTokenEnvNames: [
        'OLYMPUS_CREDENTIAL_GOOGLE_DRIVE_PERSONAL_OAUTH2_REFRESH_TOKEN',
        ...(PUBLIC_RUNTIME_BUILD ? [] : ['OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_REFRESH_TOKEN']),
      ],
      scopes: [GOOGLE_DRIVE_READONLY_SCOPE],
    },
    expiresInSeconds: 3600,
  },
  // Domain-wide delegated service-account lane. Nothing here expires the way a
  // user refresh token does, and no consent screen is ever shown again. The
  // three handles share one key and differ only in the mailbox they act for.
  ...(PUBLIC_RUNTIME_BUILD ? [] : ([delegatedGoogleHandle({
    handle: 'gmail.personal.delegated',
    provider: 'gmail',
    accountRole: 'personal',
    trustDomain: 'secure_local',
    capability: 'gmail.email.sync',
    scopes: [GOOGLE_GMAIL_READONLY_SCOPE],
    impersonatedSubjectEnvNames: [
      'OLYMPUS_CREDENTIAL_GMAIL_PERSONAL_SUBJECT',
      'OLYMPUS_CREDENTIAL_GOOGLE_PERSONAL_SUBJECT',
    ],
    credentialJsonEnvNames: ['OLYMPUS_CREDENTIAL_GMAIL_PERSONAL_SERVICE_ACCOUNT_JSON'],
  }),
  delegatedGoogleHandle({
    handle: 'gmail.business_ocu.delegated',
    provider: 'gmail',
    accountRole: 'business_ocu',
    trustDomain: 'secure_local',
    capability: 'gmail.email.sync',
    scopes: [GOOGLE_GMAIL_READONLY_SCOPE],
    impersonatedSubjectEnvNames: [
      'OLYMPUS_CREDENTIAL_GMAIL_BUSINESS_OCU_SUBJECT',
      'OLYMPUS_CREDENTIAL_GOOGLE_BUSINESS_SUBJECT',
    ],
    credentialJsonEnvNames: ['OLYMPUS_CREDENTIAL_GMAIL_BUSINESS_OCU_SERVICE_ACCOUNT_JSON'],
  }),
  delegatedGoogleHandle({
    handle: 'google_drive.personal.delegated',
    provider: 'google_drive',
    accountRole: 'personal',
    trustDomain: 'internal',
    capability: 'google_drive.docs.sync',
    // drive.readonly only. The connectors read document text through the Drive
    // export endpoint (files/{id}/export), never the Docs API, and
    // documents.readonly is NOT delegated to this key — the token exchange
    // rejects it. Declaring it would be a claim we cannot honour.
    scopes: [GOOGLE_DRIVE_READONLY_SCOPE],
    impersonatedSubjectEnvNames: [
      'OLYMPUS_CREDENTIAL_GOOGLE_DRIVE_PERSONAL_SUBJECT',
      'OLYMPUS_CREDENTIAL_GOOGLE_PERSONAL_SUBJECT',
    ],
    credentialJsonEnvNames: ['OLYMPUS_CREDENTIAL_GOOGLE_DRIVE_PERSONAL_SERVICE_ACCOUNT_JSON'],
  }),
  delegatedGoogleHandle({
    handle: 'google_calendar.personal.delegated',
    provider: 'google_calendar',
    accountRole: 'personal',
    trustDomain: 'secure_local',
    capability: 'google_calendar.events.read',
    // calendar.readonly must ALSO be delegated to the shared client in the
    // Google Admin console before the token exchange will honour it — same
    // enforcement the documents.readonly note above records for Drive.
    scopes: [GOOGLE_CALENDAR_READONLY_SCOPE],
    impersonatedSubjectEnvNames: [
      'OLYMPUS_CREDENTIAL_GOOGLE_CALENDAR_PERSONAL_SUBJECT',
      'OLYMPUS_CREDENTIAL_GOOGLE_PERSONAL_SUBJECT',
    ],
    credentialJsonEnvNames: ['OLYMPUS_CREDENTIAL_GOOGLE_CALENDAR_PERSONAL_SERVICE_ACCOUNT_JSON'],
  })] satisfies EnvCredentialHandleDefinition[])),
  {
    handle: 'readwise.personal',
    provider: 'readwise',
    accountRole: 'personal',
    trustDomain: 'internal',
    allowedCapabilities: ['readwise.sync'],
    scopes: ['readwise.export:read', 'readwise.reader:read'],
    tokenEnvNames: [
      'OLYMPUS_CREDENTIAL_READWISE_PERSONAL_TOKEN',
      ...(PUBLIC_RUNTIME_BUILD ? [] : ['OLYMPUS_CREDENTIAL_READWISE_CASTOR_RUNTIME_TOKEN']),
      'OLYMPUS_SOURCE_INDEX_READWISE_TOKEN',
      'READWISE_TOKEN',
    ],
    expiresInSeconds: 3600,
  },
  {
    handle: 'dropbox.personal',
    provider: 'dropbox',
    accountRole: 'personal',
    trustDomain: 'secure_local',
    allowedCapabilities: ['dropbox.files.sync'],
    scopes: ['files.metadata.read', 'files.content.read', 'sharing.read'],
    tokenEnvNames: [
      'OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_ACCESS_TOKEN',
      'OLYMPUS_SOURCE_INDEX_DROPBOX_TOKEN',
      'DROPBOX_ACCESS_TOKEN',
    ],
    oauth2Refresh: {
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      clientIdEnvNames: [
        'OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_OAUTH2_CLIENT_ID',
        'OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_KEY',
      ],
      clientSecretEnvNames: [
        'OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_OAUTH2_CLIENT_SECRET',
        'OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_SECRET',
      ],
      refreshTokenEnvNames: [
        'OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_OAUTH2_REFRESH_TOKEN',
        'OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_REFRESH_TOKEN',
      ],
      scopes: ['files.metadata.read', 'files.content.read', 'sharing.read'],
    },
    expiresInSeconds: 3600,
  },
  {
    handle: 'telegram.personal',
    provider: 'telegram',
    sessionKind: 'mtproto_session',
    accountRole: 'personal',
    trustDomain: 'secure_local',
    allowedCapabilities: ['telegram.messages.sync'],
    scopes: [],
    tokenEnvNames: [],
    statusEnvNames: [
      'OLYMPUS_CREDENTIAL_TELEGRAM_PERSONAL_MTPROTO_SESSION_READY',
      'OLYMPUS_CREDENTIAL_TELEGRAM_PERSONAL_TDLIB_SESSION_READY',
    ],
    expiresInSeconds: 3600,
    backendState: {
      kind: 'mtproto_session',
      mtprotoProfileId: 'telegram_personal',
      runtimeEndpointId: 'telegram_local_telethon_reader',
      library: 'telethon',
      leaseId: 'telegram_personal_mtproto_readonly_lease',
      backendLabel: 'local_private:telegram_telethon_reader',
    },
  },
  ...(PUBLIC_RUNTIME_BUILD ? [] : ([{
    handle: 'whatsapp.business',
    provider: 'whatsapp_business',
    sessionKind: 'webhook_token',
    accountRole: 'business',
    trustDomain: 'secure_local',
    allowedCapabilities: ['whatsapp.business.messages.sync'],
    scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    tokenEnvNames: [],
    statusEnvNames: ['OLYMPUS_CREDENTIAL_WHATSAPP_BUSINESS_RUNTIME_READY'],
    expiresInSeconds: 900,
    backendState: {
      kind: 'webhook_token',
      webhookIntegrationId: 'twilio_whatsapp_business',
      validationMode: 'broker_verified_event',
      verifierReference: 'twilio_whatsapp_business_verifier',
      leaseId: 'twilio_whatsapp_business_webhook_lease',
      backendLabel: 'twilio:whatsapp_business_gateway',
    },
  }] satisfies EnvCredentialHandleDefinition[])),
  {
    handle: 'whatsapp.personal_local',
    provider: 'whatsapp_personal',
    sessionKind: 'local_app_database',
    accountRole: 'personal_local',
    trustDomain: 'secure_local',
    allowedCapabilities: ['whatsapp.personal.messages.sync'],
    scopes: [],
    tokenEnvNames: [],
    statusEnvNames: ['OLYMPUS_CREDENTIAL_WHATSAPP_PERSONAL_LOCAL_DB_READY'],
    expiresInSeconds: 3600,
    backendState: {
      kind: 'local_app_database',
      databaseSourceId: 'whatsapp_personal_local',
      readerWorker: 'whatsapp_local_reader',
      databaseRole: 'messages_readonly',
      scopeLabel: 'personal_messages',
      backendLabel: 'local_private:whatsapp_local_app_reader',
    },
  },
  ...(PUBLIC_RUNTIME_BUILD ? [] : ([{
    handle: 'apple_messages.local',
    provider: 'apple_messages',
    sessionKind: 'local_app_database',
    accountRole: 'local',
    trustDomain: 'secure_local',
    allowedCapabilities: ['apple_messages.messages.sync'],
    scopes: [],
    tokenEnvNames: [],
    statusEnvNames: ['OLYMPUS_CREDENTIAL_APPLE_MESSAGES_LOCAL_DB_READY'],
    expiresInSeconds: 3600,
    backendState: {
      kind: 'local_app_database',
      databaseSourceId: 'apple_messages_local',
      readerWorker: 'apple_messages_reader',
      databaseRole: 'messages_readonly',
      scopeLabel: 'local_messages',
      backendLabel: 'local_private:apple_messages_reader',
    },
  }] satisfies EnvCredentialHandleDefinition[])),
  {
    handle: 'x.bookmarks.personal',
    provider: 'x',
    accountRole: 'personal',
    trustDomain: 'internal',
    allowedCapabilities: ['x.bookmarks.sync'],
    scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
    tokenEnvNames: [
      'OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_ACCESS_TOKEN',
      'OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_TOKEN',
    ],
    oauth2Refresh: {
      tokenUrl: 'https://api.x.com/2/oauth2/token',
      clientIdEnvNames: [
        'OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_ID',
        'OLYMPUS_SOURCE_INDEX_X_OAUTH2_CLIENT_ID',
        'X_OAUTH2_CLIENT_ID',
      ],
      clientSecretEnvNames: [
        'OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_SECRET',
        'OLYMPUS_SOURCE_INDEX_X_OAUTH2_CLIENT_SECRET',
        'X_OAUTH2_CLIENT_SECRET',
      ],
      refreshTokenEnvNames: [
        'OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_REFRESH_TOKEN',
        'OLYMPUS_SOURCE_INDEX_X_OAUTH2_REFRESH_TOKEN',
        'X_OAUTH2_REFRESH_TOKEN',
      ],
      scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
    },
    expiresInSeconds: 3600,
  },
  ...(PUBLIC_RUNTIME_BUILD ? [] : ([{
    handle: 'reflect.archive',
    provider: 'reflect',
    sessionKind: 'archive_path',
    accountRole: 'archive',
    trustDomain: 'internal',
    allowedCapabilities: ['reflect.archive.import'],
    scopes: [],
    tokenEnvNames: [],
    statusEnvNames: ['OLYMPUS_CREDENTIAL_REFLECT_ARCHIVE_READY'],
    expiresInSeconds: 3600,
    backendState: {
      kind: 'archive_path',
      archiveRootAlias: 'reflect_archive',
      readerWorker: 'archive_import_reader',
      contentBounds: 'approved_archive_root',
      backendLabel: 'local_private:archive_import',
    },
  },
  {
    handle: 'roam.archive',
    provider: 'roam',
    sessionKind: 'archive_path',
    accountRole: 'archive',
    trustDomain: 'internal',
    allowedCapabilities: ['roam.archive.import'],
    scopes: [],
    tokenEnvNames: [],
    statusEnvNames: ['OLYMPUS_CREDENTIAL_ROAM_ARCHIVE_READY'],
    expiresInSeconds: 3600,
    backendState: {
      kind: 'archive_path',
      archiveRootAlias: 'roam_archive',
      readerWorker: 'archive_import_reader',
      contentBounds: 'approved_archive_root',
      backendLabel: 'local_private:archive_import',
    },
  }] satisfies EnvCredentialHandleDefinition[])),
];

/**
 * Handles this repository owns a service-account key for. A handle merely
 * *named* like a delegated one has no assertion to sign, so callers deciding
 * whether a credential can be reissued for free must require the positive
 * definition rather than trust the name.
 */
// OLYMPUS_PUBLIC_RUNTIME_CREDENTIAL_HANDLES_START
export const SERVICE_ACCOUNT_CREDENTIAL_HANDLES: ReadonlySet<string> = new Set(
  DEFAULT_ENV_HANDLES
    .filter((definition) => definition.serviceAccountJwt !== undefined)
    .map((definition) => definition.handle),
);
// OLYMPUS_PUBLIC_RUNTIME_CREDENTIAL_HANDLES_END

export class JsonCredentialOAuth2StateStore implements CredentialOAuth2StateStore {
  private readonly path: string;
  /**
   * One file carries every handle's state, so two handles refreshing at once
   * would each read a snapshot taken before the other's write and then write it
   * back whole -- dropping the rotation that landed in between. Saves therefore
   * run one at a time, making read-modify-write atomic within the process.
   */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    const trimmed = path.trim();
    if (!trimmed) throw new Error('Credential OAuth2 state store path must be non-empty.');
    this.path = trimmed;
  }

  async load(handle: string): Promise<CredentialOAuth2HandleState | undefined> {
    const store = await this.readStore();
    return store.handles[handle];
  }

  leaseTargetPath(handle: string): string {
    const digest = createHash('sha256').update(handle).digest('hex');
    return `${this.path}.refresh-${digest}`;
  }

  async save(handle: string, state: CredentialOAuth2HandleState): Promise<void> {
    const queued = this.writes.then(
      () => this.saveExclusively(handle, state),
      () => this.saveExclusively(handle, state),
    );
    this.writes = queued.catch(() => undefined);
    return queued;
  }

  async delete(handle: string): Promise<void> {
    const queued = this.writes.then(
      () => this.deleteExclusively(handle),
      () => this.deleteExclusively(handle),
    );
    this.writes = queued.catch(() => undefined);
    return queued;
  }

  private async saveExclusively(handle: string, state: CredentialOAuth2HandleState): Promise<void> {
    await withFileLease(this.path, async (lease) => {
      const store = await this.readStore();
      const previous = store.handles[handle];
      const merged = { ...previous, ...state };
      // The in-flight marker is about the token that was stored when it was
      // written, and it carries no identity for that token. A save that
      // installs a DIFFERENT refresh token — a reconnect the owner just ran —
      // settles it, so it must not be merged forward: it would refuse the
      // freshly authorized token on the next mint and silently undo the
      // reauthorization. A save that carries its own marker keeps it.
      if (
        state.refreshToken !== undefined
        && previous?.refreshToken !== undefined
        && state.refreshToken !== previous.refreshToken
        && state.pendingRefreshStartedAt === undefined
      ) {
        merged.pendingRefreshStartedAt = undefined;
      }
      store.handles[handle] = pruneUndefined(merged);
      await lease.commit(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writePrivateFileAtomic(this.path, JSON.stringify(store, null, 2));
      });
    });
  }

  private async deleteExclusively(handle: string): Promise<void> {
    await withFileLease(this.path, async (lease) => {
      const store = await this.readStore();
      if (!Object.prototype.hasOwnProperty.call(store.handles, handle)) return;
      delete store.handles[handle];
      await lease.commit(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writePrivateFileAtomic(this.path, JSON.stringify(store, null, 2));
      });
    });
  }

  private async readStore(): Promise<CredentialOAuth2JsonStore> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { version: 1, handles: {} };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Credential OAuth2 state store is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Credential OAuth2 state store must be a JSON object.');
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) {
      throw new Error('Credential OAuth2 state store has an unsupported version.');
    }
    const handles = record.handles;
    if (!handles || typeof handles !== 'object' || Array.isArray(handles)) {
      throw new Error('Credential OAuth2 state store must include a handles object.');
    }

    return {
      version: 1,
      handles: Object.fromEntries(
        Object.entries(handles as Record<string, unknown>)
          .map(([handle, value]) => [handle, normalizeOAuth2HandleState(value, handle)]),
      ),
    };
  }
}

interface CredentialOAuth2JsonStore {
  version: 1;
  handles: Record<string, CredentialOAuth2HandleState>;
}

function pruneUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export class JsonCredentialSessionBackendStateStore implements CredentialSessionBackendStateStore {
  private readonly path: string;

  constructor(path: string) {
    const trimmed = path.trim();
    if (!trimmed) throw new Error('Credential session backend state store path must be non-empty.');
    this.path = trimmed;
  }

  async load(handle: string): Promise<unknown | undefined> {
    const store = await this.readStore();
    return store.handles[handle];
  }

  private async readStore(): Promise<CredentialSessionBackendJsonStore> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { version: 1, handles: {} };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Credential session backend state store is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Credential session backend state store must be a JSON object.');
    }
    const handles = (parsed as Record<string, unknown>).handles;
    if (!handles || typeof handles !== 'object' || Array.isArray(handles)) {
      throw new Error('Credential session backend state store must include a handles object.');
    }

    return {
      version: 1,
      handles: handles as Record<string, unknown>,
    };
  }
}

class StaticCredentialSessionBackendStateStore implements CredentialSessionBackendStateStore {
  private readonly states: Record<string, unknown>;

  constructor(states: Record<string, unknown>) {
    this.states = states;
  }

  async load(handle: string): Promise<unknown | undefined> {
    return this.states[handle];
  }
}

interface CredentialSessionBackendJsonStore {
  version: 1;
  handles: Record<string, unknown>;
}

// Shared by both minting lanes (OAuth2 refresh and service-account JWT
// bearer): a handle only ever uses one of them, and the key is namespaced by
// handle and capability.
const PROCESS_MINTED_SESSION_CACHE = new Map<string, CredentialSession>();
const PROCESS_MINT_IN_FLIGHT = new Map<string, Promise<CredentialSession>>();
const PROCESS_MINT_FAILURE_BACKOFF = new Map<string, { untilMs: number; error: CredentialBrokerError }>();

export function createEnvCredentialBroker(
  options: EnvCredentialBrokerOptions = {},
): CredentialBroker {
  return new EnvCredentialBroker(options);
}

export class EnvCredentialBroker implements CredentialBroker {
  private readonly env: Record<string, string | undefined>;
  private readonly handleDefinitions: () => EnvCredentialHandleDefinition[];
  private readonly now: () => Date;
  private readonly fetchImpl: CredentialBrokerFetch;
  private readonly oauth2StateStore: CredentialOAuth2StateStore | undefined;
  private readonly oauth2RefreshFailureBackoffMs: number;
  private readonly oauth2CacheNamespace: string;
  private readonly oauth2LeaseOptions: FileLeaseOptions;
  private readonly backendStateStore: CredentialSessionBackendStateStore | undefined;
  private readonly secretStore: SecretStore | undefined;
  private readonly connectedHandleRegistryPath: string | undefined;

  constructor(options: EnvCredentialBrokerOptions = {}) {
    this.env = options.env ?? process.env;
    this.connectedHandleRegistryPath = options.handleRegistryPath
      ?? handleRegistryPathFromEnv(this.env, options.loadDefaultHandleRegistry !== false);
    this.secretStore = options.secretStore ?? secretStoreFromEnv(this.env, options);
    this.handleDefinitions = options.handles
      ? () => options.handles ?? []
      : () => handlesFromRegistryWithDefaults(this.env, options);
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetch ?? fetch;
    this.oauth2StateStore = options.oauth2StateStore ?? credentialOAuth2StateStoreFromEnv(this.env);
    this.oauth2RefreshFailureBackoffMs = Math.max(0, options.oauth2RefreshFailureBackoffMs ?? 30_000);
    this.oauth2CacheNamespace = options.oauth2CacheNamespace?.trim()
      || this.env.OLYMPUS_CREDENTIAL_BROKER_CACHE_NAMESPACE?.trim()
      || 'runtime';
    this.oauth2LeaseOptions = options.oauth2LeaseOptions ?? {};
    this.backendStateStore = options.backendStateStore
      ?? (options.backendStates ? new StaticCredentialSessionBackendStateStore(options.backendStates) : undefined)
      ?? backendStateStoreFromEnv(this.env);
  }

  async issueSession(request: CredentialSessionRequest): Promise<CredentialSession> {
    const definition = this.requireHandle(request);
    const sessionKind = sessionKindFromDefinition(definition);
    if (sessionKind !== 'bearer_token') {
      return this.issueDescriptorSession(definition, request.capability, sessionKind);
    }
    const token = await this.resolveFirstSecret(definition.tokenEnvNames, definition.tokenSecretRefs ?? []);
    if (token) {
      return bearerSessionFromDefinition(definition, request.capability, token, this.now());
    }
    if (definition.oauth2Refresh) {
      return this.issueOAuth2RefreshSession(definition, request.capability);
    }
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
    if (definition.serviceAccountJwt) {
      return this.issueServiceAccountJwtSession(definition, request.capability);
    }
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
    throw missingCredentialError(request.handle, request.capability);
  }

  async status(handle: string): Promise<CredentialHandleStatus> {
    const definition = this.findHandle(handle);
    const now = this.now();
    if (!definition) {
      throw new CredentialBrokerError(
        'credential_handle_not_registered',
        `Credential handle ${handle} is not registered.`,
        { handle },
      );
    }
    return this.statusFromEnvDefinition(definition, now);
  }

  private requireHandle(request: CredentialSessionRequest): EnvCredentialHandleDefinition {
    const definition = this.findHandle(request.handle);
    if (!definition) {
      throw new CredentialBrokerError(
        'credential_handle_not_registered',
        `Credential handle ${request.handle} is not registered.`,
        { handle: request.handle, capability: request.capability },
      );
    }
    assertHandleRequestAllowed(definition, request);
    return definition;
  }

  private findHandle(handle: string): EnvCredentialHandleDefinition | undefined {
    return this.handleDefinitions().find((definition) => definition.handle === handle);
  }

  private issueOAuth2RefreshSession(
    definition: EnvCredentialHandleDefinition,
    capability: string,
  ): Promise<CredentialSession> {
    return this.mintCachedBearerSession(definition, capability, (cacheKey) =>
      this.issueFreshOAuth2RefreshSession(definition, capability, cacheKey));
  }

  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  private issueServiceAccountJwtSession(
    definition: EnvCredentialHandleDefinition,
    capability: string,
  ): Promise<CredentialSession> {
    return this.mintCachedBearerSession(definition, capability, (cacheKey) =>
      this.issueFreshServiceAccountJwtSession(definition, capability, cacheKey));
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

  /**
   * Reuse a live token, collapse concurrent mints into one, and honour the
   * failure backoff. Identical for both minting lanes, so they share it — and
   * the OAuth2 lane is the only one the public runtime keeps, so this and the
   * OAuth2 mint below must stay OUTSIDE every exclusion block.
   */
  private async mintCachedBearerSession(
    definition: EnvCredentialHandleDefinition,
    capability: string,
    mint: (cacheKey: string) => Promise<CredentialSession>,
  ): Promise<CredentialSession> {
    const cacheKey = mintedSessionCacheKey(this.oauth2CacheNamespace, definition, capability);
    const now = this.now();
    const cached = PROCESS_MINTED_SESSION_CACHE.get(cacheKey);
    if (cached && isReusableMintedSession(cached, now)) return cached;

    const backoff = PROCESS_MINT_FAILURE_BACKOFF.get(cacheKey);
    if (backoff && now.getTime() < backoff.untilMs) throw backoff.error;
    if (backoff) PROCESS_MINT_FAILURE_BACKOFF.delete(cacheKey);

    const inFlight = PROCESS_MINT_IN_FLIGHT.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = mint(cacheKey);
    PROCESS_MINT_IN_FLIGHT.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      PROCESS_MINT_IN_FLIGHT.delete(cacheKey);
    }
  }

  private async issueFreshOAuth2RefreshSession(
    definition: EnvCredentialHandleDefinition,
    capability: string,
    cacheKey: string,
  ): Promise<CredentialSession> {
    const leaseTargetPath = this.oauth2StateStore?.leaseTargetPath?.(definition.handle);
    if (!leaseTargetPath) {
      return this.issueFreshOAuth2RefreshSessionWithLease(definition, capability, cacheKey);
    }
    try {
      return await withFileLease(
        leaseTargetPath,
        (lease) => this.issueFreshOAuth2RefreshSessionWithLease(definition, capability, cacheKey, lease),
        this.oauth2LeaseOptions,
      );
    } catch (error) {
      if (!(error instanceof FileLeaseBusyError) && !(error instanceof FileLeaseLostError)) throw error;
      throw new CredentialBrokerError(
        'credential_refresh_busy',
        `Credential handle ${definition.handle} is already being refreshed by another process.`,
        { handle: definition.handle, capability },
      );
    }
  }

  private async issueFreshOAuth2RefreshSessionWithLease(
    definition: EnvCredentialHandleDefinition,
    capability: string,
    cacheKey: string,
    lease?: FileLease,
  ): Promise<CredentialSession> {
    const oauth2 = definition.oauth2Refresh;
    if (!oauth2) throw missingCredentialError(definition.handle, capability);

    const now = this.now();
    const storedState = await this.oauth2StateStore?.load(definition.handle);
    if (storedState?.pendingRefreshStartedAt) {
      await commitFileLease(lease, async () => {
        await this.oauth2StateStore?.save(definition.handle, {
          ...storedState,
          status: 'reauth_required',
          updatedAt: now.toISOString(),
          pendingRefreshStartedAt: undefined,
        });
        this.markRegistryHandleReauthRequired(definition.handle, now);
      });
      throw new CredentialBrokerError(
        'credential_reauth_required',
        `Credential handle ${definition.handle} requires OAuth reauthorization; a refresh started at ${storedState.pendingRefreshStartedAt} did not record its outcome, so the stored refresh token may already be spent.`,
        { handle: definition.handle, capability },
      );
    }
    const clientId = await this.resolveFirstSecret(
      oauth2.clientIdEnvNames,
      oauth2.clientIdSecretRef ? [oauth2.clientIdSecretRef] : [],
    );
    const clientSecret = await this.resolveFirstSecret(
      oauth2.clientSecretEnvNames ?? [],
      oauth2.clientSecretSecretRef ? [oauth2.clientSecretSecretRef] : [],
    );
    const refreshToken = await this.resolveFirstSecret(
      oauth2.refreshTokenEnvNames ?? [],
      oauth2.refreshTokenSecretRef ? [oauth2.refreshTokenSecretRef] : [],
    ) ?? storedState?.refreshToken?.trim();
    // An env-supplied refresh token outranks stored state on every read, so a
    // rotation saved to the store could never take effect. Knowing this before
    // the exchange is what lets a rotation we cannot keep be reported instead of
    // written somewhere that will never be read again.
    const refreshTokenPinnedInEnv = !!firstNonEmptyEnv(this.env, oauth2.refreshTokenEnvNames ?? []);

    if (!clientId) throw missingCredentialError(definition.handle, capability);
    if (storedState?.status === 'reauth_required' || !refreshToken) {
      throw new CredentialBrokerError(
        'credential_reauth_required',
        `Credential handle ${definition.handle} requires OAuth reauthorization.`,
        { handle: definition.handle, capability },
      );
    }

    // Write-ahead: record that this token is about to be spent, before it is.
    // The provider decides whether to rotate and does so the instant it answers,
    // so from here until the outcome is stored there is a window in which a
    // crash leaves us unable to tell a healthy handle from a dead one. The
    // marker is what makes that window visible afterwards. A store that cannot
    // accept the marker also cannot accept the rotation, so refuse now rather
    // than spend a token whose replacement would have nowhere to live.
    await commitFileLease(
      lease,
      () => this.markOAuth2RefreshPending(definition, capability, cacheKey, storedState, now),
    );

    const exchangeVia = this.resolveExchangeVia(definition, oauth2, clientId);

    let tokenResponse: OAuth2RefreshTokenResponse;
    try {
      tokenResponse = await refreshOAuth2AccessToken({
        tokenUrl: oauth2.tokenUrl,
        clientId,
        clientSecret,
        refreshToken,
        fetchImpl: this.fetchImpl,
        ...(exchangeVia ? { exchangeVia } : {}),
      });
    } catch (error) {
      await lease?.assertOwned();
      if (isTerminalOAuthRefreshError(error)) {
        // The provider refused the token rather than rotating it, so the outcome
        // is known and the in-flight marker is retired with it. Every other
        // failure below leaves the marker standing: a timeout or a 5xx can land
        // after the rotation was already committed on the provider's side.
        await commitFileLease(lease, async () => {
          await this.oauth2StateStore?.save(definition.handle, {
            ...storedState,
            status: 'reauth_required',
            updatedAt: now.toISOString(),
            pendingRefreshStartedAt: undefined,
          });
          this.markRegistryHandleReauthRequired(definition.handle, now);
        });
        throw new CredentialBrokerError(
          'credential_reauth_required',
          storedState?.pendingRefreshStartedAt
            ? `Credential handle ${definition.handle} requires OAuth reauthorization; a refresh started at ${storedState.pendingRefreshStartedAt} did not record its outcome, so the stored refresh token was already spent.`
            : `Credential handle ${definition.handle} requires OAuth reauthorization.`,
          { handle: definition.handle, capability },
        );
      }
      if (error instanceof OAuth2TokenEndpointError) {
        if (TOKEN_UNISSUED_STATUSES.has(error.status)) {
          // The answer proves no token was issued, so the marker is retired
          // with it. Leaving it standing turned a rate limit into a permanent
          // reauth: the classifier above declines to latch on this attempt and
          // the marker guard latched on the next one anyway.
          await commitFileLease(lease, async () => {
            await this.oauth2StateStore?.save(definition.handle, {
              ...storedState,
              status: 'available',
              updatedAt: now.toISOString(),
              pendingRefreshStartedAt: undefined,
            });
          });
        }
        const brokerError = new CredentialBrokerError(
          'credential_refresh_failed',
          `Credential handle ${definition.handle} OAuth refresh failed (${error.status}): ${error.safeDetail}`,
          { handle: definition.handle, capability },
        );
        this.recordMintFailure(cacheKey, brokerError);
        throw brokerError;
      }
      throw error;
    }
    await lease?.assertOwned();

    const scopes = tokenResponse.scopes.length > 0
      ? tokenResponse.scopes
      : storedState?.scopes?.length
        ? storedState.scopes
        : oauth2.scopes ?? definition.scopes ?? [];
    await this.persistRefreshedOAuth2State({
      definition,
      capability,
      refreshTokenSecretRef: oauth2.refreshTokenSecretRef,
      refreshTokenPinnedInEnv,
      storedState,
      spentRefreshToken: refreshToken,
      returnedRefreshToken: tokenResponse.refreshToken,
      scopes,
      now,
      lease,
    });
    const session = bearerSessionFromMintedToken({
      definition,
      capability,
      accessToken: tokenResponse.accessToken,
      scopes,
      now,
      expiresInSeconds: tokenResponse.expiresInSeconds,
    });
    if (isReusableMintedSession(session, now)) PROCESS_MINTED_SESSION_CACHE.set(cacheKey, session);
    PROCESS_MINT_FAILURE_BACKOFF.delete(cacheKey);
    return session;
  }

  /**
   * Claim the refresh attempt in durable state before the refresh token is spent.
   */
  private async markOAuth2RefreshPending(
    definition: EnvCredentialHandleDefinition,
    capability: string,
    cacheKey: string,
    storedState: CredentialOAuth2HandleState | undefined,
    now: Date,
  ): Promise<void> {
    if (!this.oauth2StateStore) return;
    try {
      await this.oauth2StateStore.save(definition.handle, {
        ...storedState,
        pendingRefreshStartedAt: now.toISOString(),
      });
    } catch (error) {
      if (error instanceof FileLeaseBusyError || error instanceof FileLeaseLostError) {
        throw new CredentialBrokerError(
          'credential_refresh_busy',
          `Credential handle ${definition.handle} refresh state is being updated by another process.`,
          { handle: definition.handle, capability },
        );
      }
      const brokerError = new CredentialBrokerError(
        'credential_refresh_failed',
        `Credential handle ${definition.handle} OAuth refresh was not attempted: broker state is not writable (${errorMessage(error)}).`,
        { handle: definition.handle, capability },
      );
      this.recordMintFailure(cacheKey, brokerError);
      throw brokerError;
    }
  }

  /**
   * Record the outcome of a refresh before its access token can be handed out.
   *
   * Ordering is the whole point. A provider that rotates has already invalidated
   * the token we spent, so the replacement is the only one that will ever work
   * and it has to be durably stored before any caller can act on the session --
   * work done against a rotation we never recorded cannot be undone, and the next
   * mint would present a dead token. The secret ref is written before the state
   * store because reads prefer it, so a crash between the two leaves the fresher
   * value winning rather than a stale one shadowing a good rotation.
   */
  private async persistRefreshedOAuth2State(input: {
    definition: EnvCredentialHandleDefinition;
    capability: string;
    refreshTokenSecretRef: string | undefined;
    refreshTokenPinnedInEnv: boolean;
    storedState: CredentialOAuth2HandleState | undefined;
    spentRefreshToken: string;
    returnedRefreshToken: string | undefined;
    scopes: string[];
    now: Date;
    lease: FileLease | undefined;
  }): Promise<void> {
    const returned = input.returnedRefreshToken?.trim();
    const nextRefreshToken = returned || input.spentRefreshToken;
    const rotated = !!returned && returned !== input.spentRefreshToken;

    // A rotation that cannot be read back is already lost: the pinned value wins
    // every future read and the provider will refuse it. Say so now, while the
    // cause is still legible, instead of leaving a handle that fails hourly.
    if (rotated && input.refreshTokenPinnedInEnv) {
      await commitFileLease(
        input.lease,
        () => this.failOAuth2RotationUnrecordable(
          input.definition,
          input.capability,
          input.now,
          'the handle reads a pinned refresh token from its environment, so the rotation cannot take effect',
        ),
      );
    }

    try {
      await commitFileLease(input.lease, async () => {
        if (returned && input.refreshTokenSecretRef) {
          await this.setStoreSecret(input.refreshTokenSecretRef, returned);
        }
        await this.oauth2StateStore?.save(input.definition.handle, {
          ...input.storedState,
          refreshToken: nextRefreshToken,
          scopes: input.scopes,
          status: 'available',
          updatedAt: input.now.toISOString(),
          pendingRefreshStartedAt: undefined,
        });
      });
    } catch (error) {
      if (error instanceof FileLeaseLostError) throw error;
      // No rotation means the token we spent still works, so this is ordinary
      // bookkeeping that failed and a retry is honest. A rotation is different:
      // the credential is already gone and only a human can restore it.
      if (!rotated) throw error;
      await commitFileLease(
        input.lease,
        () => this.failOAuth2RotationUnrecordable(
          input.definition,
          input.capability,
          input.now,
          `the rotated refresh token could not be stored (${errorMessage(error)})`,
        ),
      );
    }
  }

  private async failOAuth2RotationUnrecordable(
    definition: EnvCredentialHandleDefinition,
    capability: string,
    now: Date,
    reason: string,
  ): Promise<never> {
    await this.oauth2StateStore?.save(definition.handle, {
      status: 'reauth_required',
      updatedAt: now.toISOString(),
      pendingRefreshStartedAt: undefined,
    }).catch(() => undefined);
    this.markRegistryHandleReauthRequired(definition.handle, now);
    throw new CredentialBrokerError(
      'credential_reauth_required',
      `Credential handle ${definition.handle} rotated its refresh token but ${reason}; the handle must be reauthorized.`,
      { handle: definition.handle, capability },
    );
  }

  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  /**
   * Mint a bearer token from the domain-wide delegated service-account key.
   *
   * Nothing here expires the way a user refresh token does and no consent
   * screen is ever involved; the JWT's `sub` claim selects whose mailbox or
   * drive the token reads.
   */
  private async issueFreshServiceAccountJwtSession(
    definition: EnvCredentialHandleDefinition,
    capability: string,
    cacheKey: string,
  ): Promise<CredentialSession> {
    const serviceAccount = definition.serviceAccountJwt;
    if (!serviceAccount) throw missingCredentialError(definition.handle, capability);

    const now = this.now();
    const rawCredential = await this.resolveFirstSecret(
      serviceAccount.credentialJsonEnvNames,
      serviceAccount.credentialJsonSecretRef ? [serviceAccount.credentialJsonSecretRef] : [],
    );
    if (!rawCredential) throw missingCredentialError(definition.handle, capability);

    // The subject is not a secret, but without it the JWT selects nobody's
    // mailbox — treat a missing subject exactly like a missing credential.
    const impersonatedSubject = firstNonEmptyEnv(this.env, serviceAccount.impersonatedSubjectEnvNames);
    if (!impersonatedSubject) throw missingCredentialError(definition.handle, capability);

    const storedState = await this.oauth2StateStore?.load(definition.handle);
    if (storedState?.status === 'reauth_required') {
      throw serviceAccountDelegationError(definition.handle, capability);
    }

    const requestedScopes = serviceAccount.scopes?.length ? serviceAccount.scopes : definition.scopes ?? [];
    // Parser messages are fixed literals that never interpolate the credential,
    // so they are safe to surface. A signing failure is not, so it stays
    // generic — the key must not reach an error message.
    let credential: GoogleServiceAccountKey;
    try {
      credential = parseGoogleServiceAccountKey(rawCredential);
    } catch (error) {
      throw new CredentialBrokerError(
        'credential_backend_malformed',
        `Credential handle ${definition.handle} service-account JSON is invalid: ${errorMessage(error)}`,
        { handle: definition.handle, capability },
      );
    }
    let assertion: string;
    try {
      assertion = signGoogleServiceAccountJwt({
        credential,
        scopes: requestedScopes,
        subject: impersonatedSubject,
        now,
      });
    } catch {
      throw new CredentialBrokerError(
        'credential_backend_malformed',
        `Credential handle ${definition.handle} service-account assertion could not be signed.`,
        { handle: definition.handle, capability },
      );
    }

    let tokenResponse: OAuth2RefreshTokenResponse;
    try {
      tokenResponse = await exchangeServiceAccountAssertion({
        tokenUrl: serviceAccount.tokenUrl?.trim() || googleServiceAccountTokenUrl(credential),
        assertion,
        fetchImpl: this.fetchImpl,
        secrets: [assertion, credential.private_key, credential.private_key_id],
      });
    } catch (error) {
      if (isTerminalServiceAccountAssertionError(error)) {
        await this.oauth2StateStore?.save(definition.handle, {
          ...storedState,
          status: 'reauth_required',
          updatedAt: now.toISOString(),
        });
        this.markRegistryHandleReauthRequired(definition.handle, now);
        throw serviceAccountDelegationError(definition.handle, capability);
      }
      if (error instanceof OAuth2TokenEndpointError) {
        const brokerError = new CredentialBrokerError(
          'credential_refresh_failed',
          `Credential handle ${definition.handle} service-account token mint failed (${error.status}): ${error.safeDetail}`,
          { handle: definition.handle, capability },
        );
        this.recordMintFailure(cacheKey, brokerError);
        throw brokerError;
      }
      throw error;
    }

    // No self-healing write here on success: a stamped reauth_required is
    // cleared by the owner once delegation is actually fixed, never by a
    // request that happened to succeed.
    const scopes = tokenResponse.scopes.length > 0 ? tokenResponse.scopes : requestedScopes;
    const session = bearerSessionFromMintedToken({
      definition,
      capability,
      accessToken: tokenResponse.accessToken,
      scopes,
      now,
      expiresInSeconds: tokenResponse.expiresInSeconds,
    });
    if (isReusableMintedSession(session, now)) PROCESS_MINTED_SESSION_CACHE.set(cacheKey, session);
    PROCESS_MINT_FAILURE_BACKOFF.delete(cacheKey);
    return session;
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

  private recordMintFailure(cacheKey: string, error: CredentialBrokerError): void {
    if (this.oauth2RefreshFailureBackoffMs <= 0) return;
    PROCESS_MINT_FAILURE_BACKOFF.set(cacheKey, {
      untilMs: this.now().getTime() + this.oauth2RefreshFailureBackoffMs,
      error,
    });
  }

  private markRegistryHandleReauthRequired(handle: string, now: Date): void {
    if (!this.connectedHandleRegistryPath) return;
    markConnectedHandleReauthRequired(handle, this.connectedHandleRegistryPath, now);
  }

  /**
   * How this credential's refresh must be exchanged — and, for a credential
   * that predates the field, the one-time write that makes the answer durable.
   *
   * A Google publisher web client's secret exists only inside the publisher
   * exchange endpoint, so a refresh that goes anywhere else is refused by
   * Google and latches the handle into `reauth_required`. Handles connected
   * before `exchangeVia` existed are recognised only by their stored client id
   * matching a published publisher id — a test that stops being true the day
   * the default rotates, silently killing ingestion for every such install
   * (Codex round 1 on 5cb644b9). Recognising them against the APPEND-ONLY
   * published set rather than the current default is what keeps the fallback
   * correct across a rotation; writing the field on first sight is what means
   * the fallback only has to be right once.
   *
   * The migration is best-effort on purpose: a registry that cannot be written
   * (read-only mount, a lease another process holds) must not fail a refresh
   * that this same answer already routed correctly in memory.
   */
  private resolveExchangeVia(
    definition: EnvCredentialHandleDefinition,
    oauth2: EnvOAuth2RefreshDefinition,
    clientId: string,
  ): EnvOAuth2RefreshDefinition['exchangeVia'] {
    if (oauth2.exchangeVia) return oauth2.exchangeVia;
    if (!isGooglePublisherWebClientId(clientId, this.env)) return undefined;
    if (this.connectedHandleRegistryPath) {
      try {
        markConnectedHandleExchangeVia(definition.handle, 'publisher_endpoint', this.connectedHandleRegistryPath);
      } catch {
        // Durability is an optimisation here; the routing below is not.
      }
    }
    return 'publisher_endpoint';
  }

  private async issueDescriptorSession(
    definition: EnvCredentialHandleDefinition,
    capability: string,
    sessionKind: DescriptorSessionKind,
  ): Promise<CredentialSession> {
    const now = this.now();
    const state = await this.resolveDescriptorBackendState(definition, sessionKind, now);
    if (!state) throw missingCredentialError(definition.handle, capability);
    if (state.status === 'reauth_required') {
      throw new CredentialBrokerError(
        'credential_reauth_required',
        `Credential handle ${definition.handle} requires backend session reauthorization or repair.`,
        { handle: definition.handle, capability },
      );
    }
    return descriptorSessionFromDefinition(definition, capability, state, now);
  }

  private async statusFromEnvDefinition(
    definition: EnvCredentialHandleDefinition,
    now: Date,
  ): Promise<CredentialHandleStatus> {
    const sessionKind = sessionKindFromDefinition(definition);
    if (sessionKind !== 'bearer_token') {
      const state = await this.resolveDescriptorBackendState(definition, sessionKind, now);
      const status = state?.status ?? 'missing';
      return statusFromDefinition(definition, status, now);
    }
    if (await this.resolveFirstSecret(definition.tokenEnvNames, definition.tokenSecretRefs ?? [])) {
      return statusFromDefinition(definition, 'available', now);
    }
    if (!definition.oauth2Refresh) {
      // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
      if (definition.serviceAccountJwt) return this.serviceAccountJwtStatus(definition, now);
      // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
      return statusFromDefinition(definition, 'missing', now);
    }

    const clientId = await this.resolveFirstSecret(
      definition.oauth2Refresh.clientIdEnvNames,
      definition.oauth2Refresh.clientIdSecretRef ? [definition.oauth2Refresh.clientIdSecretRef] : [],
    );
    const storedState = await this.oauth2StateStore?.load(definition.handle);
    const refreshToken = await this.resolveFirstSecret(
      definition.oauth2Refresh.refreshTokenEnvNames ?? [],
      definition.oauth2Refresh.refreshTokenSecretRef ? [definition.oauth2Refresh.refreshTokenSecretRef] : [],
    ) ?? storedState?.refreshToken?.trim();
    const status: CredentialHandleStatus['status'] = clientId && refreshToken
      ? storedState?.status === 'reauth_required'
        ? 'reauth_required'
        : 'available'
      : clientId
        ? 'reauth_required'
        : 'missing';
    return statusFromDefinition(definition, status, now);
  }

  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  private async serviceAccountJwtStatus(
    definition: EnvCredentialHandleDefinition,
    now: Date,
  ): Promise<CredentialHandleStatus> {
    const serviceAccount = definition.serviceAccountJwt;
    if (!serviceAccount) return statusFromDefinition(definition, 'missing', now);
    const rawCredential = await this.resolveFirstSecret(
      serviceAccount.credentialJsonEnvNames,
      serviceAccount.credentialJsonSecretRef ? [serviceAccount.credentialJsonSecretRef] : [],
    );
    if (!rawCredential) return statusFromDefinition(definition, 'missing', now);
    if (!firstNonEmptyEnv(this.env, serviceAccount.impersonatedSubjectEnvNames)) {
      return statusFromDefinition(definition, 'missing', now);
    }
    const storedState = await this.oauth2StateStore?.load(definition.handle);
    return statusFromDefinition(
      definition,
      storedState?.status === 'reauth_required' ? 'reauth_required' : 'available',
      now,
    );
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

  private async resolveDescriptorBackendState(
    definition: EnvCredentialHandleDefinition,
    sessionKind: DescriptorSessionKind,
    now: Date,
  ): Promise<NormalizedCredentialSessionBackendState | undefined> {
    const stored = await this.backendStateStore?.load(definition.handle);
    if (stored !== undefined) return normalizeBackendState(stored, definition.handle, sessionKind);
    if (!definition.backendState) return undefined;
    const statusEnvNames = definition.statusEnvNames ?? [];
    if (statusEnvNames.length > 0 && !firstNonEmptyEnv(this.env, statusEnvNames)) return undefined;
    const expiresAt = definition.backendState.expiresAt ?? expiresAtFromSeconds(now, definition.expiresInSeconds);
    return normalizeBackendState(
      {
        ...definition.backendState,
        ...(expiresAt ? { expiresAt } : {}),
      },
      definition.handle,
      sessionKind,
    );
  }

  private async resolveFirstSecret(envNames: readonly string[], secretRefs: readonly string[]): Promise<string | undefined> {
    const envValue = firstNonEmptyEnv(this.env, envNames);
    if (envValue) return envValue;
    for (const ref of secretRefs) {
      const value = await resolveSecretRefValue(ref, {
        env: this.env,
        ...(this.secretStore ? { secretStore: this.secretStore } : {}),
      });
      if (value?.trim()) return value.trim();
    }
    return undefined;
  }

  private async setStoreSecret(secretRef: string, value: string): Promise<void> {
    const parsed = normalizeSecretRef(secretRef);
    if (parsed?.kind !== 'store') return;
    const store = this.secretStore ?? createDefaultSecretStore({ env: this.env });
    await store.set(parsed.key, value);
  }
}

export class StaticCredentialBroker implements CredentialBroker {
  private readonly handles: StaticCredentialHandleDefinition[];
  private readonly now: () => Date;

  constructor(handles: StaticCredentialHandleDefinition[], options: { now?: () => Date } = {}) {
    this.handles = handles;
    this.now = options.now ?? (() => new Date());
  }

  async issueSession(request: CredentialSessionRequest): Promise<CredentialSession> {
    const definition = this.handles.find((candidate) => candidate.handle === request.handle);
    if (!definition) {
      throw new CredentialBrokerError(
        'credential_handle_not_registered',
        `Credential handle ${request.handle} is not registered.`,
        { handle: request.handle, capability: request.capability },
      );
    }
    assertHandleRequestAllowed(definition, request);
    const sessionKind = sessionKindFromDefinition(definition);
    if (sessionKind !== 'bearer_token') {
      const state = definition.backendState
        ? normalizeBackendState(definition.backendState, definition.handle, sessionKind)
        : undefined;
      if (!state) throw missingCredentialError(request.handle, request.capability);
      if (state.status === 'reauth_required') {
        throw new CredentialBrokerError(
          'credential_reauth_required',
          `Credential handle ${definition.handle} requires backend session reauthorization or repair.`,
          { handle: definition.handle, capability: request.capability },
        );
      }
      return descriptorSessionFromDefinition(definition, request.capability, state, this.now());
    }
    if (!definition.token?.trim()) {
      throw missingCredentialError(request.handle, request.capability);
    }
    return bearerSessionFromDefinition(definition, request.capability, definition.token, this.now());
  }

  async status(handle: string): Promise<CredentialHandleStatus> {
    const definition = this.handles.find((candidate) => candidate.handle === handle);
    if (!definition) {
      throw new CredentialBrokerError(
        'credential_handle_not_registered',
        `Credential handle ${handle} is not registered.`,
        { handle },
      );
    }
    const sessionKind = sessionKindFromDefinition(definition);
    if (sessionKind === 'bearer_token') {
      return statusFromDefinition(definition, definition.token?.trim() ? 'available' : 'missing', this.now());
    }
    const state = definition.backendState
      ? normalizeBackendState(definition.backendState, definition.handle, sessionKind)
      : undefined;
    return statusFromDefinition(definition, state?.status ?? 'missing', this.now());
  }
}

export function requireBearerTokenCredentialSession(
  session: CredentialSession,
  handle: string,
): BearerTokenCredentialSession {
  if (session.kind !== 'bearer_token') {
    throw new CredentialBrokerError(
      'credential_session_kind_unsupported',
      `Credential handle ${handle} did not issue a bearer token session.`,
      { handle },
    );
  }
  return session;
}

export function safeCredentialSessionAudit(session: CredentialSession): CredentialSessionAudit {
  return { ...session.audit };
}

function assertHandleRequestAllowed(
  definition: EnvCredentialHandleDefinition | StaticCredentialHandleDefinition,
  request: CredentialSessionRequest,
): void {
  if (request.provider && request.provider !== definition.provider) {
    throw new CredentialBrokerError(
      'credential_capability_not_allowed',
      `Credential handle ${request.handle} is not registered for provider ${request.provider}.`,
      { handle: request.handle, capability: request.capability },
    );
  }
  if (!definition.allowedCapabilities.includes(request.capability)) {
    throw new CredentialBrokerError(
      'credential_capability_not_allowed',
      `Credential handle ${request.handle} does not allow ${request.capability}.`,
      { handle: request.handle, capability: request.capability },
    );
  }
  if (request.trustDomain && definition.trustDomain && request.trustDomain !== definition.trustDomain) {
    throw new CredentialBrokerError(
      'credential_capability_not_allowed',
      `Credential handle ${request.handle} is not registered for ${request.trustDomain}.`,
      { handle: request.handle, capability: request.capability },
    );
  }
}

function bearerSessionFromDefinition(
  definition: EnvCredentialHandleDefinition | StaticCredentialHandleDefinition,
  capability: string,
  token: string,
  now: Date,
): BearerTokenCredentialSession {
  const expiresAt = 'expiresAt' in definition
    ? definition.expiresAt
    : 'expiresInSeconds' in definition
      ? expiresAtFromSeconds(now, definition.expiresInSeconds)
      : undefined;
  return {
    kind: 'bearer_token',
    handle: definition.handle,
    provider: definition.provider,
    capability,
    token,
    ...(expiresAt ? { expiresAt } : {}),
    audit: {
      handle: definition.handle,
      provider: definition.provider,
      capability,
      ...(definition.accountRole ? { accountRole: definition.accountRole } : {}),
      ...(definition.trustDomain ? { trustDomain: definition.trustDomain } : {}),
      scopes: [...(definition.scopes ?? [])],
      outcome: 'issued',
      issuedAt: now.toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
      rawCredentialExposed: false,
    },
  };
}

function bearerSessionFromMintedToken(options: {
  definition: EnvCredentialHandleDefinition;
  capability: string;
  accessToken: string;
  scopes: string[];
  now: Date;
  expiresInSeconds: number | undefined;
}): BearerTokenCredentialSession {
  const expiresAt = expiresAtFromSeconds(options.now, options.expiresInSeconds);
  return {
    kind: 'bearer_token',
    handle: options.definition.handle,
    provider: options.definition.provider,
    capability: options.capability,
    token: options.accessToken,
    ...(expiresAt ? { expiresAt } : {}),
    audit: {
      handle: options.definition.handle,
      provider: options.definition.provider,
      capability: options.capability,
      ...(options.definition.accountRole ? { accountRole: options.definition.accountRole } : {}),
      ...(options.definition.trustDomain ? { trustDomain: options.definition.trustDomain } : {}),
      scopes: [...options.scopes],
      outcome: 'issued',
      issuedAt: options.now.toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
      rawCredentialExposed: false,
    },
  };
}

function mintedSessionCacheKey(namespace: string, definition: EnvCredentialHandleDefinition, capability: string): string {
  return `${namespace}\n${definition.handle}\n${capability}`;
}

function isReusableMintedSession(session: CredentialSession, now: Date): boolean {
  if (!session.expiresAt) return false;
  const expiresAtMs = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs - now.getTime() > 60_000;
}

function descriptorSessionFromDefinition(
  definition: EnvCredentialHandleDefinition | StaticCredentialHandleDefinition,
  capability: string,
  state: NormalizedCredentialSessionBackendState,
  now: Date,
): DescriptorCredentialSession {
  const expiresAt = state.expiresAt
    ?? expiresAtFromSeconds(now, state.expiresInSeconds)
    ?? ('expiresAt' in definition
      ? definition.expiresAt
      : 'expiresInSeconds' in definition
        ? expiresAtFromSeconds(now, definition.expiresInSeconds)
        : undefined);
  const base = {
    handle: definition.handle,
    provider: definition.provider,
    capability,
    ...(definition.accountRole ? { accountRole: definition.accountRole } : {}),
    ...(definition.trustDomain ? { trustDomain: definition.trustDomain } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(state.backendLabel ? { backendLabel: state.backendLabel } : {}),
    audit: auditFromDefinition(definition, capability, now, {
      ...(expiresAt ? { expiresAt } : {}),
      ...(state.backendLabel ? { backendLabel: state.backendLabel } : {}),
    }),
  };

  switch (state.kind) {
    case 'runtime_connector':
      return {
        kind: 'runtime_connector',
        ...base,
        connectorBackendId: state.connectorBackendId,
        ...(state.connectorRoute ? { connectorRoute: state.connectorRoute } : {}),
        ...(state.leaseId ? { leaseId: state.leaseId } : {}),
      };
    case 'mtproto_session':
      return {
        kind: 'mtproto_session',
        ...base,
        mtprotoProfileId: state.mtprotoProfileId,
        runtimeEndpointId: state.runtimeEndpointId,
        ...(state.library ? { library: state.library } : {}),
        ...(state.leaseId ? { leaseId: state.leaseId } : {}),
      };
    case 'tdlib_session':
      return {
        kind: 'tdlib_session',
        ...base,
        tdlibProfileId: state.tdlibProfileId,
        runtimeEndpointId: state.runtimeEndpointId,
        ...(state.leaseId ? { leaseId: state.leaseId } : {}),
      };
    case 'local_app_database':
      return {
        kind: 'local_app_database',
        ...base,
        databaseSourceId: state.databaseSourceId,
        readerWorker: state.readerWorker,
        databaseRole: state.databaseRole,
        ...(state.scopeLabel ? { scopeLabel: state.scopeLabel } : {}),
      };
    case 'archive_path':
      return {
        kind: 'archive_path',
        ...base,
        archiveRootAlias: state.archiveRootAlias,
        readerWorker: state.readerWorker,
        ...(state.contentBounds ? { contentBounds: state.contentBounds } : {}),
        ...(state.importRunId ? { importRunId: state.importRunId } : {}),
      };
    case 'webhook_token':
      return {
        kind: 'webhook_token',
        ...base,
        webhookIntegrationId: state.webhookIntegrationId,
        validationMode: state.validationMode,
        verifierReference: state.verifierReference,
        ...(state.leaseId ? { leaseId: state.leaseId } : {}),
      };
  }
}

function auditFromDefinition(
  definition: EnvCredentialHandleDefinition | StaticCredentialHandleDefinition,
  capability: string,
  now: Date,
  options: { expiresAt?: string; backendLabel?: string } = {},
): CredentialSessionAudit {
  return {
    handle: definition.handle,
    provider: definition.provider,
    capability,
    ...(definition.accountRole ? { accountRole: definition.accountRole } : {}),
    ...(definition.trustDomain ? { trustDomain: definition.trustDomain } : {}),
    scopes: [...(definition.scopes ?? [])],
    outcome: 'issued',
    issuedAt: now.toISOString(),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    ...(options.backendLabel ? { backendLabel: options.backendLabel } : {}),
    rawCredentialExposed: false,
  };
}

function statusFromDefinition(
  definition: EnvCredentialHandleDefinition | StaticCredentialHandleDefinition,
  status: CredentialHandleStatus['status'],
  _now: Date,
): CredentialHandleStatus {
  return {
    handle: definition.handle,
    provider: definition.provider,
    sessionKind: sessionKindFromDefinition(definition),
    ...(definition.accountRole ? { accountRole: definition.accountRole } : {}),
    ...(definition.trustDomain ? { trustDomain: definition.trustDomain } : {}),
    capabilities: [...definition.allowedCapabilities],
    scopes: [...(definition.scopes ?? [])],
    status,
    rawCredentialExposed: false,
  };
}

function sessionKindFromDefinition(
  definition: EnvCredentialHandleDefinition | StaticCredentialHandleDefinition,
): CredentialSessionKind {
  return definition.sessionKind ?? 'bearer_token';
}

/** Bounded so a stalled publisher endpoint cannot hang a refresh indefinitely. */
const GOOGLE_PUBLISHER_EXCHANGE_REFRESH_TIMEOUT_MS = 20_000;

/** A token response is a small JSON object on every provider Olympus talks to. */
const OAUTH2_TOKEN_RESPONSE_LIMIT_BYTES = 64 * 1024;

/**
 * A transport failure reaching the publisher exchange endpoint, in the same
 * shape a provider refusal takes, so the broker's existing classification
 * (nothing terminal, marker left standing) applies unchanged. No cause text is
 * repeated: these are fixed strings.
 */
function publisherExchangeTransportError(error: unknown): OAuth2TokenEndpointError {
  if (isAbortError(error)) {
    return new OAuth2TokenEndpointError({
      status: 504,
      providerError: 'upstream_timeout',
      safeDetail: `publisher token-exchange endpoint timed out after ${GOOGLE_PUBLISHER_EXCHANGE_REFRESH_TIMEOUT_MS}ms`,
    });
  }
  if (isBoundedResponseTooLargeError(error)) {
    return new OAuth2TokenEndpointError({
      status: 502,
      providerError: 'upstream_response_too_large',
      safeDetail: 'publisher token-exchange endpoint response exceeded the response size cap',
    });
  }
  return new OAuth2TokenEndpointError({
    status: 502,
    providerError: 'upstream_unreachable',
    safeDetail: 'publisher token-exchange endpoint was unreachable',
  });
}

async function refreshOAuth2AccessToken(options: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string | undefined;
  refreshToken: string;
  fetchImpl: CredentialBrokerFetch;
  /**
   * Where this refresh goes, decided by the caller.
   *
   * The legacy client-id fallback lives in `EnvCredentialBroker.resolveExchangeVia`
   * and nowhere else: this function reading `process.env` on its own made the
   * broker's `env` and this check two different authorities, which disagreed
   * the moment a broker was constructed with an explicit `env` — the routing
   * said "publisher endpoint" while the migration said "not a publisher
   * credential", so the durable write never happened and the next rotation
   * would still have stranded the handle.
   */
  exchangeVia?: 'publisher_endpoint';
}): Promise<OAuth2RefreshTokenResponse> {
  const usesPublisherExchange = options.exchangeVia === 'publisher_endpoint';

  let response: Response;
  let text: string;
  if (usesPublisherExchange) {
    // The publisher exchange endpoint holds `GOOGLE_CLIENT_SECRET` itself and
    // never accepts one from a caller, so this call carries no client
    // credential at all — just the refresh token
    // (`docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md`, "POST /exchange/google/refresh").
    // Headers AND body under one deadline, with a byte cap: a deadline that
    // ends at the status line bounds the handshake, not the call (Codex round
    // 1 on 5cb644b9).
    try {
      ({ response, text } = await fetchBoundedText(options.fetchImpl, googlePublisherExchangeRefreshUrl(), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: options.refreshToken }),
      }, {
        timeoutMs: GOOGLE_PUBLISHER_EXCHANGE_REFRESH_TIMEOUT_MS,
        limitBytes: OAUTH2_TOKEN_RESPONSE_LIMIT_BYTES,
      }));
    } catch (error) {
      throw publisherExchangeTransportError(error);
    }
  } else {
    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', options.refreshToken);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (options.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`;
    } else {
      body.set('client_id', options.clientId);
    }
    // No deadline here: the direct-provider lane's timeout behaviour is
    // unchanged. The byte cap is not a deadline and applies to every lane —
    // no token endpoint has an honest answer measured in megabytes.
    try {
      ({ response, text } = await fetchBoundedText(options.fetchImpl, options.tokenUrl, {
        method: 'POST',
        headers,
        body,
      }, { limitBytes: OAUTH2_TOKEN_RESPONSE_LIMIT_BYTES }));
    } catch (error) {
      if (!isBoundedResponseTooLargeError(error)) throw error;
      throw new OAuth2TokenEndpointError({
        status: 502,
        providerError: 'upstream_response_too_large',
        safeDetail: 'token endpoint response exceeded the response size cap',
      });
    }
  }
  if (!response.ok) {
    const providerError = providerErrorFromText(text);
    throw new OAuth2TokenEndpointError({
      status: response.status,
      providerError,
      safeDetail: safeCredentialText(text, [options.clientId, options.clientSecret, options.refreshToken]),
    });
  }

  const payload = parseJsonObject(text, 'OAuth2 token endpoint');
  const accessToken = optionalString(payload.access_token);
  if (!accessToken) throw new OAuth2TokenEndpointError({
    status: response.status,
    providerError: undefined,
    safeDetail: 'token endpoint did not return access_token',
  });
  return {
    accessToken,
    refreshToken: optionalString(payload.refresh_token),
    expiresInSeconds: optionalNumber(payload.expires_in),
    scopes: scopesFromValue(payload.scope),
  };
}

// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
/**
 * Exchange a signed service-account assertion for an access token.
 *
 * The response body is redacted against the assertion and the key material
 * before it is ever attached to an error, because the assertion is itself a
 * usable credential for the next hour.
 */
async function exchangeServiceAccountAssertion(options: {
  tokenUrl: string;
  assertion: string;
  fetchImpl: CredentialBrokerFetch;
  secrets: Array<string | undefined>;
}): Promise<OAuth2RefreshTokenResponse> {
  const body = new URLSearchParams();
  body.set('grant_type', GOOGLE_JWT_BEARER_GRANT_TYPE);
  body.set('assertion', options.assertion);

  const response = await options.fetchImpl(options.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new OAuth2TokenEndpointError({
      status: response.status,
      providerError: providerErrorFromText(text),
      safeDetail: safeCredentialText(text, options.secrets),
    });
  }

  const payload = parseJsonObject(text, 'Google service-account token endpoint');
  const accessToken = optionalString(payload.access_token);
  if (!accessToken) {
    throw new OAuth2TokenEndpointError({
      status: response.status,
      providerError: undefined,
      safeDetail: 'token endpoint did not return access_token',
    });
  }
  // A JWT-bearer exchange never returns a refresh token, and that is the point:
  // there is no rotating secret to expire.
  return {
    accessToken,
    refreshToken: undefined,
    expiresInSeconds: optionalNumber(payload.expires_in),
    scopes: scopesFromValue(payload.scope),
  };
}

/**
 * Terminal for the delegated lane means a human has to change something in
 * Workspace admin — the subject is not a real user, or the client is not
 * authorised for the scopes requested. Retrying cannot fix any of these.
 *
 * `invalid_grant` needs its description read first, because Google also answers
 * it when the assertion's `iat`/`exp` fall outside its window — a host clock
 * that NTP has not stepped yet. That is transient, and nothing in the product
 * clears a stamped `.delegated` handle: there is no connect command for one, so
 * a skewed clock would kill Gmail and Drive ingestion until someone hand-edited
 * the broker state.
 */
function isTerminalServiceAccountAssertionError(error: unknown): error is OAuth2TokenEndpointError {
  if (!(error instanceof OAuth2TokenEndpointError)) return false;
  if (error.providerError === 'invalid_grant') {
    return !ASSERTION_TIMING_REJECTED_DETAIL.test(error.safeDetail);
  }
  return isPermanentOAuthClientError(error.providerError);
}
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

/**
 * Refusals of the client registration or of the authorization itself: a wrong
 * client secret, a client not authorised for this grant, an authorization the
 * user revoked. A human has to change something at the provider before any
 * exchange can succeed, so retrying is pure noise.
 *
 * These arrive as 401/403, which the refresh lane otherwise reads as "no token
 * was issued" and returns to `available` -- correct for a rate limit, and for
 * these it meant every later retry window re-spent the same dead grant while no
 * durable operator-visible state ever appeared.
 */
function isPermanentOAuthClientError(providerError: string | undefined): boolean {
  return providerError === 'invalid_client'
    || providerError === 'unauthorized_client'
    || providerError === 'access_denied';
}

// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
const ASSERTION_TIMING_REJECTED_DETAIL =
  /(?:short-lived token|reasonable timeframe|check your iat and exp|jwt is (?:not yet valid|expired)|assertion (?:is )?expired)/i;

function serviceAccountDelegationError(handle: string, capability: string): CredentialBrokerError {
  return new CredentialBrokerError(
    'credential_reauth_required',
    `Credential handle ${handle} service-account domain-wide delegation was refused; the impersonated account or one of its scopes is not delegated.`,
    { handle, capability },
  );
}
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

interface OAuth2RefreshTokenResponse {
  accessToken: string;
  refreshToken: string | undefined;
  expiresInSeconds: number | undefined;
  scopes: string[];
}

class OAuth2TokenEndpointError extends Error {
  readonly status: number;
  readonly providerError: string | undefined;
  readonly safeDetail: string;

  constructor(options: { status: number; providerError: string | undefined; safeDetail: string }) {
    super(options.safeDetail);
    this.status = options.status;
    this.providerError = options.providerError;
    this.safeDetail = options.safeDetail;
  }
}

/**
 * A refusal of the refresh token itself, which no amount of retrying can fix.
 *
 * `invalid_grant` and `invalid_token` are the standard codes. The description
 * test exists for X, which rejects a spent refresh token as a generic
 * `invalid_request` -- indistinguishable by code from a malformed call, so it was
 * retried as a transient fault for two days while the handle was simply dead
 * (x.bookmarks.personal, 2026-07-28). Only a description that names the refresh
 * token counts: a request that really is malformed names something else, and
 * mistaking one for the other would latch a healthy handle into reauth.
 *
 * The permanent client refusals join them for the same reason they are terminal
 * on the service-account lane: the grant cannot be exchanged until a human fixes
 * the client, and only a stored `reauth_required` says so.
 */
function isTerminalOAuthRefreshError(error: unknown): error is OAuth2TokenEndpointError {
  if (!(error instanceof OAuth2TokenEndpointError)) return false;
  if (error.providerError === 'invalid_grant' || error.providerError === 'invalid_token') return true;
  if (isPermanentOAuthClientError(error.providerError)) return true;
  return error.status === 400 && REFRESH_TOKEN_REJECTED_DETAIL.test(error.safeDetail);
}

/**
 * Statuses whose answer proves the token endpoint issued nothing.
 *
 * Each of these is decided before the grant is read -- rate limit, wrong route,
 * unauthenticated client -- so the stored refresh token is provably untouched.
 * 400 is deliberately absent: X answers a spent refresh token with a generic
 * `invalid_request` 400, so that status stays ambiguous. A 5xx, a 200 with no
 * access_token, and a transport failure are likewise absent, because the
 * provider may have rotated before the answer was lost.
 */
const TOKEN_UNISSUED_STATUSES = new Set([401, 403, 404, 405, 415, 429]);

const REFRESH_TOKEN_REJECTED_DETAIL =
  /(?:value passed for the refresh token was invalid|refresh[ _-]?token(?: was| is| has been)? (?:invalid|expired|revoked|not valid)|(?:invalid|expired|revoked|unknown) refresh[ _-]?token)/i;

function missingCredentialError(handle: string, capability?: string): CredentialBrokerError {
  return new CredentialBrokerError(
    'credential_missing',
    `Credential handle ${handle} is missing required runtime credential material.`,
    { handle, ...(capability ? { capability } : {}) },
  );
}

export function credentialOAuth2StateStoreFromEnv(
  env: Record<string, string | undefined>,
): CredentialOAuth2StateStore | undefined {
  const statePath = env.OLYMPUS_CREDENTIAL_BROKER_STATE_PATH?.trim();
  return statePath ? new JsonCredentialOAuth2StateStore(statePath) : undefined;
}

function secretStoreFromEnv(
  env: Record<string, string | undefined>,
  options: EnvCredentialBrokerOptions,
): SecretStore | undefined {
  if (options.secretStore) return options.secretStore;
  const hasStoreBackedRegistry = !!handleRegistryPathFromEnv(
    env,
    options.loadDefaultHandleRegistry !== false,
  );
  if (!hasStoreBackedRegistry && !env.OLYMPUS_SECRET_STORE_BACKEND?.trim()) return undefined;
  return createDefaultSecretStore({ env });
}

function handlesFromRegistryWithDefaults(
  env: Record<string, string | undefined>,
  options: EnvCredentialBrokerOptions,
): EnvCredentialHandleDefinition[] {
  const path = options.handleRegistryPath
    ?? handleRegistryPathFromEnv(env, options.loadDefaultHandleRegistry !== false);
  if (!path) return DEFAULT_ENV_HANDLES;
  const registryHandles = deriveEnvCredentialHandlesFromRegistry(
    readConnectedHandleRegistry(path),
  );
  const defaultsByHandle = new Map(
    DEFAULT_ENV_HANDLES.map((definition) => [definition.handle, definition]),
  );
  const registryIds = new Set(registryHandles.map((definition) => definition.handle));
  return [
    ...registryHandles.map((definition) => {
      const fallback = defaultsByHandle.get(definition.handle);
      return fallback ? mergeRegistryHandleWithDefault(definition, fallback) : definition;
    }),
    ...DEFAULT_ENV_HANDLES.filter((definition) => !registryIds.has(definition.handle)),
  ];
}

function mergeRegistryHandleWithDefault(
  registry: EnvCredentialHandleDefinition,
  fallback: EnvCredentialHandleDefinition,
): EnvCredentialHandleDefinition {
  if (registry.provider !== fallback.provider) {
    throw new Error(`Connected credential handle provider does not match its default: ${registry.handle}`);
  }
  if (registry.trustDomain && fallback.trustDomain
    && registry.trustDomain !== fallback.trustDomain) {
    throw new Error(`Connected credential handle trust domain does not match its default: ${registry.handle}`);
  }
  if (registry.accountRole && fallback.accountRole
    && registry.accountRole !== fallback.accountRole) {
    throw new Error(`Connected credential handle account role does not match its default: ${registry.handle}`);
  }
  const allowedByDefault = new Set(fallback.allowedCapabilities);
  if (registry.allowedCapabilities.some((capability) => !allowedByDefault.has(capability))) {
    throw new Error(`Connected credential handle capability exceeds its default: ${registry.handle}`);
  }

  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  // The service-account lane is repo-owned only: a registry entry has no way to
  // declare one, so editing handles.json cannot redirect impersonation at a
  // mailbox the owner did not intend. A bare entry inherits the default's.
  const serviceAccountJwt = fallback.serviceAccountJwt;
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
  const registryOwnsOAuth = registry.oauth2Refresh !== undefined;
  const oauth2Refresh = registry.oauth2Refresh
    ? {
        ...registry.oauth2Refresh,
        clientIdEnvNames: uniqueStrings([
          ...registry.oauth2Refresh.clientIdEnvNames,
          ...(fallback.oauth2Refresh?.clientIdEnvNames ?? []),
        ]),
        clientSecretEnvNames: uniqueStrings([
          ...(registry.oauth2Refresh.clientSecretEnvNames ?? []),
          ...(fallback.oauth2Refresh?.clientSecretEnvNames ?? []),
        ]),
        refreshTokenEnvNames: uniqueStrings([
          ...(registry.oauth2Refresh.refreshTokenEnvNames ?? []),
          ...(fallback.oauth2Refresh?.refreshTokenEnvNames ?? []),
        ]),
      }
    : fallback.oauth2Refresh;
  const sessionKind = registry.sessionKind
    ?? (registryOwnsOAuth ? undefined : fallback.sessionKind);
  const tokenSecretRefs = registry.tokenSecretRefs?.length
    ? registry.tokenSecretRefs
    : fallback.tokenSecretRefs;
  const registryOwnsBackend = registry.backendState !== undefined;
  const statusEnvNames = uniqueStrings([
    ...(registry.statusEnvNames ?? []),
    ...(registryOwnsBackend ? [] : fallback.statusEnvNames ?? []),
  ]);

  return {
    handle: registry.handle,
    provider: registry.provider,
    allowedCapabilities: [...registry.allowedCapabilities],
    tokenEnvNames: uniqueStrings([
      ...registry.tokenEnvNames,
      ...fallback.tokenEnvNames,
    ]),
    ...(tokenSecretRefs?.length ? { tokenSecretRefs: [...tokenSecretRefs] } : {}),
    ...(statusEnvNames.length ? { statusEnvNames } : {}),
    ...(oauth2Refresh ? { oauth2Refresh } : {}),
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
    ...(serviceAccountJwt ? { serviceAccountJwt } : {}),
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
    scopes: registry.scopes?.length ? [...registry.scopes] : [...(fallback.scopes ?? [])],
    ...(sessionKind ? { sessionKind } : {}),
    ...(registry.accountRole ?? fallback.accountRole
      ? { accountRole: registry.accountRole ?? fallback.accountRole }
      : {}),
    ...(registry.trustDomain ?? fallback.trustDomain
      ? { trustDomain: registry.trustDomain ?? fallback.trustDomain }
      : {}),
    ...(registry.expiresInSeconds ?? fallback.expiresInSeconds
      ? { expiresInSeconds: registry.expiresInSeconds ?? fallback.expiresInSeconds }
      : {}),
    ...(registry.backendState ?? fallback.backendState
      ? { backendState: registry.backendState ?? fallback.backendState }
      : {}),
  };
}

function backendStateStoreFromEnv(
  env: Record<string, string | undefined>,
): CredentialSessionBackendStateStore | undefined {
  const statePath = env.OLYMPUS_CREDENTIAL_SESSION_BACKEND_STATE_PATH?.trim();
  return statePath ? new JsonCredentialSessionBackendStateStore(statePath) : undefined;
}

function expiresAtFromSeconds(now: Date, seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(now.getTime() + Math.floor(seconds) * 1000).toISOString();
}

function firstNonEmptyEnv(env: Record<string, string | undefined>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeOAuth2HandleState(value: unknown, handle: string): CredentialOAuth2HandleState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Credential OAuth2 state for handle ${handle} is invalid.`);
  }
  const record = value as Record<string, unknown>;
  const refreshToken = optionalString(record.refreshToken);
  const providerAccountId = optionalString(record.providerAccountId);
  if (record.status !== undefined && record.status !== 'available' && record.status !== 'reauth_required') {
    throw new Error(`Credential OAuth2 state for handle ${handle} has an unsupported status.`);
  }
  const status = record.status as CredentialOAuth2HandleState['status'];
  const updatedAt = optionalString(record.updatedAt);
  const pendingRefreshStartedAt = optionalString(record.pendingRefreshStartedAt);
  const scopes = Array.isArray(record.scopes)
    ? record.scopes.map((item) => optionalString(item)).filter((item): item is string => !!item)
    : undefined;
  return {
    ...(refreshToken ? { refreshToken } : {}),
    ...(providerAccountId ? { providerAccountId } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
    ...(status ? { status } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(pendingRefreshStartedAt ? { pendingRefreshStartedAt } : {}),
  };
}

function normalizeBackendState(
  value: unknown,
  handle: string,
  expectedKind: DescriptorSessionKind,
): NormalizedCredentialSessionBackendState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw backendMalformedError(handle);
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== expectedKind) throw backendMalformedError(handle);
  const status = record.status === undefined || record.status === 'available'
    ? 'available'
    : record.status === 'reauth_required'
      ? 'reauth_required'
      : undefined;
  if (!status) throw backendMalformedError(handle);

  const expiresAt = safeOptionalDescriptorFieldValue(record, handle, 'expiresAt');
  const expiresInSeconds = safeOptionalDescriptorNumberValue(record, handle, 'expiresInSeconds');
  const backendLabel = safeOptionalDescriptorFieldValue(record, handle, 'backendLabel');
  const base: NormalizedBackendStateBase = {
    status,
    ...(expiresAt ? { expiresAt } : {}),
    ...(expiresInSeconds ? { expiresInSeconds } : {}),
    ...(backendLabel ? { backendLabel } : {}),
  };

  switch (expectedKind) {
    case 'runtime_connector':
      return {
        ...base,
        kind: 'runtime_connector',
        connectorBackendId: safeRequiredDescriptorField(record, handle, 'connectorBackendId'),
        ...safeOptionalDescriptorField(record, handle, 'connectorRoute'),
        ...safeOptionalDescriptorField(record, handle, 'leaseId'),
      };
    case 'mtproto_session':
      return {
        ...base,
        kind: 'mtproto_session',
        mtprotoProfileId: safeRequiredDescriptorField(record, handle, 'mtprotoProfileId'),
        runtimeEndpointId: safeRequiredDescriptorField(record, handle, 'runtimeEndpointId'),
        ...safeOptionalDescriptorField(record, handle, 'library'),
        ...safeOptionalDescriptorField(record, handle, 'leaseId'),
      };
    case 'tdlib_session':
      return {
        ...base,
        kind: 'tdlib_session',
        tdlibProfileId: safeRequiredDescriptorField(record, handle, 'tdlibProfileId'),
        runtimeEndpointId: safeRequiredDescriptorField(record, handle, 'runtimeEndpointId'),
        ...safeOptionalDescriptorField(record, handle, 'leaseId'),
      };
    case 'local_app_database':
      return {
        ...base,
        kind: 'local_app_database',
        databaseSourceId: safeRequiredDescriptorField(record, handle, 'databaseSourceId'),
        readerWorker: safeRequiredDescriptorField(record, handle, 'readerWorker'),
        databaseRole: safeRequiredDescriptorField(record, handle, 'databaseRole'),
        ...safeOptionalDescriptorField(record, handle, 'scopeLabel'),
      };
    case 'archive_path':
      return {
        ...base,
        kind: 'archive_path',
        archiveRootAlias: safeRequiredDescriptorField(record, handle, 'archiveRootAlias'),
        readerWorker: safeRequiredDescriptorField(record, handle, 'readerWorker'),
        ...safeOptionalDescriptorField(record, handle, 'contentBounds'),
        ...safeOptionalDescriptorField(record, handle, 'importRunId'),
      };
    case 'webhook_token':
      return {
        ...base,
        kind: 'webhook_token',
        webhookIntegrationId: safeRequiredDescriptorField(record, handle, 'webhookIntegrationId'),
        validationMode: safeRequiredDescriptorField(record, handle, 'validationMode'),
        verifierReference: safeRequiredDescriptorField(record, handle, 'verifierReference'),
        ...safeOptionalDescriptorField(record, handle, 'leaseId'),
      };
  }
}

function safeRequiredDescriptorField(
  record: Record<string, unknown>,
  handle: string,
  field: string,
): string {
  const value = safeDescriptorString(record[field]);
  if (!value) throw backendMalformedError(handle);
  return value;
}

function safeOptionalDescriptorField(
  record: Record<string, unknown>,
  handle: string,
  field: string,
): Record<string, string> {
  const value = safeOptionalDescriptorFieldValue(record, handle, field);
  return value ? { [field]: value } : {};
}

function safeOptionalDescriptorFieldValue(
  record: Record<string, unknown>,
  handle: string,
  field: string,
): string | undefined {
  if (record[field] === undefined) return undefined;
  const value = safeDescriptorString(record[field]);
  if (!value) throw backendMalformedError(handle);
  return value;
}

function safeOptionalDescriptorNumberValue(
  record: Record<string, unknown>,
  handle: string,
  field: string,
): number | undefined {
  if (record[field] === undefined) return undefined;
  const value = optionalNumber(record[field]);
  if (value === undefined || value <= 0) throw backendMalformedError(handle);
  return Math.floor(value);
}

function safeDescriptorString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160) return undefined;
  if (!/^[a-zA-Z0-9._:-]+$/.test(trimmed)) return undefined;
  const lowered = trimmed.toLowerCase();
  if (
    lowered.includes('token')
    || lowered.includes('secret')
    || lowered.includes('password')
    || lowered.includes('vault')
    || lowered.includes('1password')
    || lowered.includes('op://')
    || lowered.includes('sqlite')
    || lowered.endsWith('.db')
    || trimmed.includes('/')
    || trimmed.includes('\\')
    || trimmed.includes('~')
    || /^OLYMPUS_/.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function backendMalformedError(handle: string, capability?: string): CredentialBrokerError {
  return new CredentialBrokerError(
    'credential_backend_malformed',
    `Credential handle ${handle} backend state is malformed or unsafe.`,
    { handle, ...(capability ? { capability } : {}) },
  );
}

function parseJsonObject(text: string, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new OAuth2TokenEndpointError({
      status: 200,
      providerError: undefined,
      safeDetail: `${context} returned invalid JSON`,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OAuth2TokenEndpointError({
      status: 200,
      providerError: undefined,
      safeDetail: `${context} did not return a JSON object`,
    });
  }
  return parsed as Record<string, unknown>;
}

function providerErrorFromText(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return optionalString(parsed.error) ?? optionalString(parsed.title);
  } catch {
    return undefined;
  }
}

function scopesFromValue(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function commitFileLease<T>(
  lease: FileLease | undefined,
  write: () => Promise<T>,
): Promise<T> {
  return lease ? lease.commit(write) : write();
}

/**
 * Redaction runs over the whole body and the length cap is applied last. Cutting
 * first cuts secrets in half: the tail is discarded, so no substitution matches,
 * and the surviving head is emitted raw. A signed assertion or a PEM is longer
 * than the cap on its own, so for those it is not a boundary case -- nothing
 * would ever be redacted. The pre-slice is only a bound on regex work over a
 * pathological body, set far above the longest credential we submit.
 */
function safeCredentialText(text: string, secrets: Array<string | undefined>): string {
  let safe = text.slice(0, 64_000);
  const sensitive = secrets.map((secret) => secret?.trim()).filter((secret): secret is string => Boolean(secret));
  for (const secret of sensitive) {
    for (const variant of credentialTextVariants(secret)) {
      safe = safe.replaceAll(variant, '[redacted]');
    }
  }
  safe = redactBase64CredentialTokens(safe, sensitive);
  return safe.slice(0, 500);
}

function credentialTextVariants(secret: string): string[] {
  const base64 = Buffer.from(secret).toString('base64');
  const base64Url = Buffer.from(secret).toString('base64url');
  return uniqueStrings([
    secret,
    encodeURIComponent(secret),
    base64,
    base64.replace(/=+$/, ''),
    base64Url,
  ]);
}

function redactBase64CredentialTokens(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0) return text;
  return text.replace(/[A-Za-z0-9+/_-]{12,}={0,2}/g, (token) => {
    const decoded = decodeBase64CredentialCandidate(token);
    return decoded && secrets.some((secret) => decoded.includes(secret)) ? '[redacted]' : token;
  });
}

function decodeBase64CredentialCandidate(token: string): string | undefined {
  const normalized = token.replaceAll('-', '+').replaceAll('_', '/');
  if (normalized.length % 4 === 1) return undefined;
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error;
}
