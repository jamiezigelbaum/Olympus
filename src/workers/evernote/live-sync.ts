/**
 * The live Evernote lane: its tier stores, its sign-in, and the hourly pass
 * (connector.ts) run through them. Everything that leaves this module is
 * counts-only.
 *
 * - Stores: `secure_local.evernote.notes` (Private, the lane's own placement)
 *   and `internal.evernote.notes` (Personal), both created on first need,
 *   one tier set over them. A note's tiers are its own, and so are each of
 *   its attachments'.
 * - Sign-in: the provider's MCP OAuth (core/mcp-source/oauth.ts) between
 *   this computer and Evernote. The registered client and the tokens are one
 *   credential in the encrypted secret store under the handle's key; the
 *   handle registry names it, so Disconnect removes it.
 * - The pass record (raw `evernote-pass.json`): what the last complete pass
 *   held, written only once its items are stored, and the dashboard's facts
 *   about the last pass (when it completed, what it counted, what stopped it).
 *   An unfinished pass leaves the notes it read beside it (`unfinished`), so
 *   the next pass can still delete them.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import type { RawItem } from '../../core/contracts.ts';
import { MCP_SOURCE_DASHBOARD_STATE, isMcpSourceError, type McpSourceDashboardState, type McpSourceErrorKind } from '../../core/mcp-source/errors.ts';
import {
  McpTokenSource,
  mcpAuthorizedFetch,
  secretStoreMcpCredentials,
  startMcpSignIn,
  type McpPendingSignIn,
} from '../../core/mcp-source/oauth.ts';
import type { McpCallPacer } from '../../core/mcp-source/pacer.ts';
import { McpSourceSession } from '../../core/mcp-source/session.ts';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { SecretStore } from '../../core/secret-store.ts';
import { resolvedRawPath, resolvedStorePath } from '../../core/source-placement.ts';
import { openConnectorStore, openTierLedger } from '../../core/source-storage.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import type { TierLedger } from '../classification/tier-ledger.ts';
import type { ConnectorStoreSyncOptions, LocalConnectorStore } from '../connector-store/index.ts';
import type { ConnectorStorePlacementRule } from '../connector-store/tier-placement.ts';
import {
  createTieredLaneSet,
  onDemandTierStore,
  tieredLaneReceiptCounts,
  tieredStoreSetLedgerPath,
  type OnDemandTierStore,
  type TieredLaneReceiptCounts,
  type TieredStoreSet,
  type TieredStoreSetRun,
} from '../connector-store/tiered-store-set.ts';
import {
  markConnectedHandleReauthRequired,
  upsertConnectedHandle,
  type ConnectedCredentialHandle,
} from '../credential-broker/connected-handles.ts';
import {
  EVERNOTE_AUTHORIZATION_HOSTS,
  EVERNOTE_MCP_SCOPE,
  EVERNOTE_MCP_SERVER_URL,
  EVERNOTE_PASS_CALL_BUDGET,
  EVERNOTE_PROVIDER,
  EVERNOTE_READ_TOOLS,
  EVERNOTE_SOURCE_ID,
  createEvernoteSourceConnector,
  evernotePassWithUnfinished,
  evernoteUnfinishedWith,
  type EvernotePassCounts,
  type EvernotePassRecord,
  type EvernoteSourceConnector,
} from './connector.ts';

export const EVERNOTE_SECURE_CORPUS_ID = 'secure_local.evernote.notes';
export const EVERNOTE_INTERNAL_CORPUS_ID = 'internal.evernote.notes';
export const EVERNOTE_TIER_CORPUS_IDS: Readonly<Record<'secure_local' | 'internal', string>> = Object.freeze({
  secure_local: EVERNOTE_SECURE_CORPUS_ID,
  internal: EVERNOTE_INTERNAL_CORPUS_ID,
});
export const EVERNOTE_HANDLE = 'evernote.personal';
export const EVERNOTE_ACCOUNT_ROLE = 'personal';
export const EVERNOTE_SYNC_CAPABILITY = 'evernote.notes.sync';
export const EVERNOTE_PASS_RECEIPT_KIND = 'evernote_connector_store_pass_receipt';
/** Where one sign-in's credential lives in the secret store. */
export const evernoteCredentialKey = (accountRole: string = EVERNOTE_ACCOUNT_ROLE): string => `evernote.${accountRole}.mcp_credential`;
/** Calls one attachment read may make (the tool listing and `get_attachment`). */
const ATTACHMENT_CALL_BUDGET = 4;

/** Where an item rests when the router leaves it to the lane: Private. */
export const EVERNOTE_STORE_PLACEMENT: ConnectorStorePlacementRule = Object.freeze({
  trustTier: 'S4',
  trustDomain: 'secure_local',
  secretsInContent: true,
});

export function createEvernoteConnectorStore(
  trustDomain: 'secure_local' | 'internal',
  env: Record<string, string | undefined> = process.env,
  options: { readOnly?: boolean; tierLedger?: TierLedger } = {},
): LocalConnectorStore {
  return openConnectorStore({ sourceId: EVERNOTE_SOURCE_ID }, {
    dbPath: resolvedStorePath(EVERNOTE_SOURCE_ID, trustDomain, env),
    corpusId: EVERNOTE_TIER_CORPUS_IDS[trustDomain],
    family: 'note',
    trustDomain,
    ...(options.readOnly === true ? { readOnly: true } : {}),
    ...(options.tierLedger ? { tierLedger: options.tierLedger } : {}),
  }, env);
}

export interface EvernoteTierLane {
  set: TieredStoreSet;
  ledger: TierLedger;
  secure: OnDemandTierStore;
  internal: OnDemandTierStore;
}

export function createEvernoteTierLane(options: {
  env?: Record<string, string | undefined>;
  openSecretLocations?: (secureDbPath: string) => SecretLocationsIndex | undefined;
  onStoreOpened?: (store: LocalConnectorStore) => void;
} = {}): EvernoteTierLane {
  const env = options.env ?? process.env;
  const secureDbPath = resolvedStorePath(EVERNOTE_SOURCE_ID, 'secure_local', env);
  const ledger = openTierLedger({ sourceId: EVERNOTE_SOURCE_ID }, { dbPath: tieredStoreSetLedgerPath(secureDbPath) }, env);
  const leg = (domain: 'secure_local' | 'internal'): OnDemandTierStore => onDemandTierStore({
    corpusId: EVERNOTE_TIER_CORPUS_IDS[domain],
    dbPath: resolvedStorePath(EVERNOTE_SOURCE_ID, domain, env),
    create: () => createEvernoteConnectorStore(domain, env, { tierLedger: ledger }),
    ...(options.onStoreOpened ? { onOpened: options.onStoreOpened } : {}),
  });
  const secure = leg('secure_local');
  const internal = leg('internal');
  const secretLocations = options.openSecretLocations?.(secureDbPath);
  const set = createTieredLaneSet({
    setId: EVERNOTE_SOURCE_ID,
    ledger,
    // An attachment's names are stored at listing; its content lands when the extraction factory reads it.
    contentArrivesLaterFor: (item: RawItem) => item.deferredBytes !== undefined,
    ...(secretLocations ? { secretLocations } : {}),
    legs: {
      internal: { onDemand: internal },
      secure_local: { onDemand: secure, legacy: true },
    },
  });
  return { set, ledger, secure, internal };
}

/** The dashboard's facts about the last pass: counts and a closed state, nothing from a note. */
export interface EvernotePassStatus {
  last_completed_at?: string;
  counts?: EvernotePassCounts;
  last_error?: { kind: McpSourceErrorKind | 'listing_incomplete' | 'account_changed' | 'pass_failed'; state: McpSourceDashboardState | 'provider_error'; at: string };
}

interface PassFile {
  version: 1;
  record?: EvernotePassRecord;
  unfinished?: EvernotePassRecord['notes'];
  status: EvernotePassStatus;
}

function readPassFile(path: string): PassFile {
  if (!existsSync(path)) return { version: 1, status: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PassFile>;
    if (parsed.version !== 1 || typeof parsed.status !== 'object' || parsed.status === null) return { version: 1, status: {} };
    const record = parsed.record?.version === 1 && parsed.record.notes && typeof parsed.record.notes === 'object' ? parsed.record : undefined;
    const unfinished = parsed.unfinished && typeof parsed.unfinished === 'object' ? parsed.unfinished : undefined;
    return { version: 1, ...(record ? { record } : {}), ...(unfinished ? { unfinished } : {}), status: parsed.status };
  } catch {
    // An unreadable record is a first pass again: it deletes nothing.
    return { version: 1, status: {} };
  }
}

function writePassFile(path: string, file: PassFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, JSON.stringify(file));
}

export function evernotePassStatus(env: Record<string, string | undefined> = process.env): EvernotePassStatus | undefined {
  const path = resolvedRawPath(EVERNOTE_SOURCE_ID, 'evernote-pass.json', env);
  if (!existsSync(path)) return undefined;
  return readPassFile(path).status;
}

/**
 * Starts a sign-in for the dashboard's Connect: the registered client asks
 * for `read` alone, and `complete` keeps the credential and the handle.
 */
export async function startEvernoteSignIn(input: {
  redirectUri: string;
  state: string;
  secretStore: SecretStore;
  registryPath: string;
  serverUrl?: string;
  authorizationHosts?: readonly string[];
  fetch?: FetchLike;
  now?: () => Date;
}): Promise<{ authorizationUrl: string; complete(code: string): Promise<ConnectedCredentialHandle> }> {
  const serverUrl = input.serverUrl ?? EVERNOTE_MCP_SERVER_URL;
  const pending: McpPendingSignIn = await startMcpSignIn({
    serverUrl,
    scope: EVERNOTE_MCP_SCOPE,
    clientName: 'Olympus',
    redirectUrl: input.redirectUri,
    state: input.state,
    authorizationHosts: input.authorizationHosts ?? EVERNOTE_AUTHORIZATION_HOSTS,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  return {
    authorizationUrl: pending.authorizationUrl,
    async complete(code) {
      const credential = await pending.complete(code);
      const key = evernoteCredentialKey();
      await secretStoreMcpCredentials(input.secretStore, key).write(credential);
      const handle: ConnectedCredentialHandle = {
        handle: EVERNOTE_HANDLE,
        provider: EVERNOTE_PROVIDER,
        accountRole: EVERNOTE_ACCOUNT_ROLE,
        trustDomain: 'secure_local',
        allowedCapabilities: [EVERNOTE_SYNC_CAPABILITY],
        scopes: [EVERNOTE_MCP_SCOPE],
        tokenSecretRefs: [`store:${key}`],
        connectedAt: (input.now ?? (() => new Date()))().toISOString(),
      };
      upsertConnectedHandle(handle, input.registryPath);
      return handle;
    },
  };
}

export interface EvernoteLiveSyncOptions {
  lane: EvernoteTierLane;
  secretStore: SecretStore;
  handle: ConnectedCredentialHandle;
  registryPath: string;
  env?: Record<string, string | undefined>;
  serverUrl?: string;
  fetch?: FetchLike;
  downloadHosts?: readonly string[];
  downloadFetch?: typeof fetch;
  pacer?: McpCallPacer;
  callBudget?: number;
  clientVersion?: string;
  now?: () => Date;
}

export interface EvernotePassReceipt {
  kind: typeof EVERNOTE_PASS_RECEIPT_KIND;
  status: 'progress' | 'idle';
  counts: EvernotePassCounts & {
    items_indexed: number;
    items_changed: number;
    items_tombstoned: number;
    chunks_indexed: number;
    pass_complete: number;
  } & TieredLaneReceiptCounts;
  policy: { counts_only: true; raw_source_exposed: false; source_text_returned: false; provider_cursor_exposed: false };
}

export interface EvernoteLiveSync {
  /** One full pass. Throws when it changed nothing (a listing that could not finish, a sign-in to renew). */
  pass(request?: { shouldContinue?: () => boolean }): Promise<EvernotePassReceipt>;
  /** The connector the extraction factory reads attachments with. */
  attachmentConnector(): EvernoteSourceConnector;
  status(): EvernotePassStatus | undefined;
  lastStoreRunCompletedAt(): string | undefined;
}

const AUTH_KINDS: ReadonlySet<McpSourceErrorKind> = new Set(['auth_missing', 'auth_expired', 'auth_revoked']);

export function createEvernoteLiveSync(options: EvernoteLiveSyncOptions): EvernoteLiveSync {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const serverUrl = options.serverUrl ?? EVERNOTE_MCP_SERVER_URL;
  const passPath = resolvedRawPath(EVERNOTE_SOURCE_ID, 'evernote-pass.json', env);
  const credentialRef = options.handle.tokenSecretRefs?.find((ref) => ref.startsWith('store:'))?.slice('store:'.length) ?? evernoteCredentialKey(options.handle.accountRole);
  const tokens = new McpTokenSource({
    store: secretStoreMcpCredentials(options.secretStore, credentialRef),
    serverUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
  });
  const authorizedFetch = mcpAuthorizedFetch(tokens, serverUrl, options.fetch);
  const accountScope = options.handle.accountRole ?? EVERNOTE_ACCOUNT_ROLE;
  let shouldContinue: () => boolean = () => true;
  const connector = (
    previous?: () => EvernotePassRecord | undefined,
    readSoFar?: (notes: EvernotePassRecord['notes']) => void,
  ): EvernoteSourceConnector => createEvernoteSourceConnector({
    accountScope,
    session: (purpose) => new McpSourceSession({
      serverUrl,
      clientName: 'Olympus',
      clientVersion: options.clientVersion ?? '1',
      readTools: EVERNOTE_READ_TOOLS,
      callBudget: purpose === 'pass' ? options.callBudget ?? EVERNOTE_PASS_CALL_BUDGET : ATTACHMENT_CALL_BUDGET,
      fetch: authorizedFetch,
      ...(options.pacer ? { pacer: options.pacer } : {}),
      ...(purpose === 'pass' ? { shouldContinue: () => shouldContinue() } : {}),
    }),
    ...(previous ? { previous } : {}),
    ...(readSoFar ? { readSoFar } : {}),
    ...(options.downloadHosts ? { downloadHosts: options.downloadHosts } : {}),
    ...(options.downloadFetch ? { downloadFetch: options.downloadFetch } : {}),
    now,
  });
  const attachments = connector();
  let lastCompletedAt: string | undefined = readPassFile(passPath).status.last_completed_at;
  // One pass at a time: a manual sync beside the scheduled one waits for it.
  let running: Promise<EvernotePassReceipt> | undefined;

  const failed = (file: PassFile, error: unknown): never => {
    const name = (error as { name?: string } | undefined)?.name;
    const kind = isMcpSourceError(error) ? error.kind
      : name === 'EvernoteListingIncomplete' ? 'listing_incomplete'
        : name === 'EvernoteAccountChanged' ? 'account_changed'
          : 'pass_failed';
    const state = isMcpSourceError(error) ? MCP_SOURCE_DASHBOARD_STATE[error.kind] : 'provider_error';
    writePassFile(passPath, { ...file, status: { ...file.status, last_error: { kind, state, at: now().toISOString() } } });
    // A refused or lost sign-in: the card says Reconnect.
    if (isMcpSourceError(error) && AUTH_KINDS.has(error.kind)) markConnectedHandleReauthRequired(options.handle.handle, options.registryPath, now());
    throw error;
  };

  const runPass = async (): Promise<EvernotePassReceipt> => {
    const file = readPassFile(passPath);
    const previous = evernotePassWithUnfinished(file.record, file.unfinished);
    // Kept before each page is stored: a pass that stops after storing some notes still leaves them to delete.
    const live = connector(() => previous, (notes) => {
      file.unfinished = evernoteUnfinishedWith(file.unfinished, notes);
      writePassFile(passPath, file);
    });
    const sync: ConnectorStoreSyncOptions = {
      placement: EVERNOTE_STORE_PLACEMENT,
      fetchContent: true,
      deferMetadataOnlyContent: true,
    };
    let run: TieredStoreSetRun;
    try {
      // The Private store is where a note rests until it is judged: the pass lists through it.
      options.lane.secure.open();
      run = await options.lane.set.sync(live, sync, { commitCursor: false, embed: false });
    } catch (error) {
      return failed(file, error);
    }
    const outcome = live.lastOutcome();
    if (!outcome) return failed(file, new Error('The Evernote pass ended without its outcome.'));
    // An item the source accepted that no store took (it is mid-move between tiers): the pass is not
    // stored, so the record and the unfinished notes stay, and the next pass reads them again.
    const stored = run.routing.itemsUnstored === 0;
    if (stored) {
      // Stored, so the record moves: deletions are judged against it next time.
      const completedAt = now().toISOString();
      writePassFile(passPath, {
        version: 1,
        record: outcome.record,
        status: {
          last_completed_at: completedAt,
          counts: outcome.counts,
          ...(outcome.stoppedBy ? { last_error: { kind: outcome.stoppedBy, state: MCP_SOURCE_DASHBOARD_STATE[outcome.stoppedBy], at: completedAt } } : {}),
        },
      });
      lastCompletedAt = completedAt;
    }
    const sum = (pick: (leg: TieredStoreSetRun['legs'][number]) => number): number => run.legs.reduce((total, leg) => total + pick(leg), 0);
    const indexed = sum((leg) => leg.sync.itemsIndexed);
    const tombstoned = sum((leg) => leg.sync.itemsTombstoned);
    return {
      kind: EVERNOTE_PASS_RECEIPT_KIND,
      status: indexed > 0 || tombstoned > 0 ? 'progress' : 'idle',
      counts: {
        ...outcome.counts,
        items_indexed: indexed,
        items_changed: sum((leg) => leg.sync.itemsChanged),
        items_tombstoned: tombstoned,
        chunks_indexed: sum((leg) => leg.sync.chunksIndexed),
        pass_complete: outcome.stoppedBy || !stored ? 0 : 1,
        ...tieredLaneReceiptCounts({ routing: run.routing }),
      },
      policy: { counts_only: true, raw_source_exposed: false, source_text_returned: false, provider_cursor_exposed: false },
    };
  };

  return {
    pass(request = {}) {
      running ??= (async () => {
        shouldContinue = request.shouldContinue ?? (() => true);
        try {
          return await runPass();
        } finally {
          running = undefined;
          shouldContinue = () => true;
        }
      })();
      return running;
    },
    attachmentConnector: () => attachments,
    status: () => (existsSync(passPath) ? readPassFile(passPath).status : undefined),
    lastStoreRunCompletedAt: () => lastCompletedAt,
  };
}

