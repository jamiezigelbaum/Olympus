import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import {
  FileLeaseBusyError,
  FileLeaseLostError,
  withFileLease,
  withFileLeaseSync,
} from '../../core/file-lease.ts';
import { isSafeSecretKey } from '../../core/secret-store.ts';
import { isCredentialProvider } from './index.ts';
import type {
  CredentialProvider,
  CredentialOAuth2StateStore,
  CredentialSessionBackendStateInput,
  CredentialSessionKind,
  EnvCredentialHandleDefinition,
} from './index.ts';
import type { SourceTrustDomain } from '../../core/source-index/types.ts';

export interface ConnectedHandleRegistry {
  version: 1;
  handles: ConnectedCredentialHandle[];
  dropped?: ConnectedHandleRegistryDrop[];
}

export interface ConnectedHandleRegistryDrop {
  index: number;
  reason: string;
}

export interface ConnectedCredentialHandle {
  handle: string;
  provider: CredentialProvider;
  sessionKind?: CredentialSessionKind;
  accountRole?: string;
  trustDomain?: SourceTrustDomain;
  allowedCapabilities: string[];
  scopes: string[];
  tokenSecretRefs?: string[];
  oauth2Refresh?: {
    tokenUrl: string;
    clientIdSecretRef: string;
    clientSecretSecretRef?: string;
    refreshTokenSecretRef: string;
    scopes?: string[];
    /**
     * How this credential's token exchange happened, when it was not a
     * direct exchange with the provider. `'publisher_endpoint'` marks a
     * Google publisher-Web-client credential minted through
     * `googlePublisherExchangeUrl()` (`docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md`)
     * rather than directly against Google — refresh must go back through the
     * same endpoint, because that client's secret was never in this process
     * to send. Absent for every other credential, including the packaged
     * Google Desktop pilot client and any bring-your-own registration, all of
     * which refresh directly with the provider as before.
     */
    exchangeVia?: 'publisher_endpoint';
  };
  backendState?: {
    kind: Exclude<CredentialSessionKind, 'bearer_token'> | 'oauth2_refresh';
    [key: string]: unknown;
  };
  connectedAt: string;
  providerAccountId?: string;
}

const INITIAL_CONNECTED_HANDLE_GRANT_EPOCH = 'initial';

export class ConnectedHandleGrantMutationError extends Error {
  readonly code: 'credential_grant_busy' | 'credential_grant_superseded';
  readonly retryable = true;

  constructor(code: ConnectedHandleGrantMutationError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export class ConnectedHandleAccountCardinalityError extends Error {
  readonly code = 'credential_account_cardinality';

  constructor() {
    super('Olympus v0.4 supports one connected account per provider. Disconnect the existing account first.');
  }
}

export function defaultHandleRegistryPath(): string {
  return join(homedir(), '.config', 'olympus', 'handles.json');
}

export function readConnectedHandleGrantEpoch(
  registryPath: string = defaultHandleRegistryPath(),
): string {
  const path = connectedHandleGrantEpochPath(registryPath);
  if (!existsSync(path)) return INITIAL_CONNECTED_HANDLE_GRANT_EPOCH;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Olympus credential-grant generation is unreadable. Refusing connection changes.');
  }
  const record = parsed as Record<string, unknown>;
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || record.version !== 1
    || typeof record.epoch !== 'string'
    || !/^[a-f0-9-]{36}$/.test(record.epoch)
  ) {
    throw new Error('Olympus credential-grant generation has an unsupported format. Refusing connection changes.');
  }
  return record.epoch;
}

export async function withConnectedHandleGrantCustody<T>(
  registryPath: string,
  options: { expectedEpoch?: string; advanceEpoch?: boolean },
  mutation: () => Promise<T> | T,
): Promise<T> {
  try {
    return await withFileLease(
      `${registryPath}.grant-custody`,
      (lease) => lease.commit(async () => {
        const currentEpoch = readConnectedHandleGrantEpoch(registryPath);
        if (options.expectedEpoch !== undefined && options.expectedEpoch !== currentEpoch) {
          throw new ConnectedHandleGrantMutationError(
            'credential_grant_superseded',
            'A newer Disconnect superseded this connection attempt. Start Connect again.',
          );
        }
        if (options.advanceEpoch === true) {
          writePrivateFileAtomicSync(
            connectedHandleGrantEpochPath(registryPath),
            `${JSON.stringify({ version: 1, epoch: randomUUID() }, null, 2)}\n`,
          );
        }
        return await mutation();
      }),
    );
  } catch (error) {
    if (error instanceof FileLeaseBusyError || error instanceof FileLeaseLostError) {
      throw new ConnectedHandleGrantMutationError(
        'credential_grant_busy',
        'Another connection change is in progress. Retry shortly.',
      );
    }
    throw error;
  }
}

export function assertOneConnectedAccountPerProvider(
  registry: ConnectedHandleRegistry,
  proposed: readonly Pick<ConnectedCredentialHandle, 'handle' | 'provider'>[] = [],
): void {
  const handles = [...registry.handles, ...proposed];
  const byProvider = new Map<string, Set<string>>();
  for (const handle of handles) {
    const ids = byProvider.get(handle.provider) ?? new Set<string>();
    ids.add(handle.handle);
    byProvider.set(handle.provider, ids);
  }
  if ([...byProvider.values()].some((ids) => ids.size > 1)) {
    throw new ConnectedHandleAccountCardinalityError();
  }
}

function connectedHandleGrantEpochPath(registryPath: string): string {
  return `${registryPath}.grant-epoch.json`;
}

export function readConnectedHandleRegistry(path: string = defaultHandleRegistryPath()): ConnectedHandleRegistry {
  return readConnectedHandleRegistryForWrite(path).registry;
}

function readConnectedHandleRegistryForWrite(path: string = defaultHandleRegistryPath()): {
  registry: ConnectedHandleRegistry;
  preservedUnknownHandles: unknown[];
} {
  if (!existsSync(path)) {
    return { registry: { version: 1, handles: [] }, preservedUnknownHandles: [] };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Olympus handle registry must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.handles)) {
    throw new Error('Olympus handle registry has an unsupported format.');
  }
  const handles: ConnectedCredentialHandle[] = [];
  const dropped: ConnectedHandleRegistryDrop[] = [];
  const preservedUnknownHandles: unknown[] = [];
  for (const [index, value] of record.handles.entries()) {
    const normalized = normalizeConnectedHandle(value);
    if (normalized.ok) {
      handles.push(normalized.handle);
      continue;
    }
    const drop = { index, reason: normalized.reason };
    dropped.push(drop);
    preservedUnknownHandles.push(value);
  }
  warnConnectedHandleDrops(path, dropped);
  const registry: ConnectedHandleRegistry = { version: 1, handles };
  if (dropped.length > 0) registry.dropped = dropped;
  return { registry, preservedUnknownHandles };
}

export function writeConnectedHandleRegistry(
  registry: ConnectedHandleRegistry,
  path: string = defaultHandleRegistryPath(),
): void {
  withFileLeaseSync(path, (lease) => {
    lease.commit(() => writeConnectedHandleRegistryWithPreservedUnknowns(registry, path, []));
  });
}

function writeConnectedHandleRegistryWithPreservedUnknowns(
  registry: ConnectedHandleRegistry,
  path: string,
  preservedUnknownHandles: unknown[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  // This file is the only mapping from handle to its token URL, secret refs and
  // provider account. A torn write does not corrupt one entry -- readers reject
  // the whole file, so every registry-derived handle disappears from the broker
  // while its refresh token sits intact and unreachable in the secret store.
  writePrivateFileAtomicSync(path, JSON.stringify({
    version: 1,
    handles: [
      ...preservedUnknownHandles,
      ...registry.handles.map(redactConnectedHandleForDisk).sort((a, b) => a.handle.localeCompare(b.handle)),
    ],
  }, null, 2));
}

export function upsertConnectedHandle(
  handle: ConnectedCredentialHandle,
  path: string = defaultHandleRegistryPath(),
): ConnectedHandleRegistry {
  return withFileLeaseSync(path, (lease) => {
    const { registry, preservedUnknownHandles } = readConnectedHandleRegistryForWrite(path);
    const next = registry.handles.filter((candidate) => candidate.handle !== handle.handle);
    next.push(handle);
    const updated: ConnectedHandleRegistry = {
      version: 1,
      handles: next,
      ...(registry.dropped ? { dropped: registry.dropped } : {}),
    };
    lease.commit(() => writeConnectedHandleRegistryWithPreservedUnknowns(updated, path, preservedUnknownHandles));
    return updated;
  });
}

export interface RemoveConnectedHandlesResult {
  registry: ConnectedHandleRegistry;
  removed: ConnectedCredentialHandle[];
}

/**
 * Removes an exact, pre-resolved set of handles while preserving malformed
 * forward-version entries byte-for-byte. Credential bytes are deliberately
 * not touched here: callers own that custody boundary and can delete the
 * selected credential refs before making the registry mutation visible.
 */
export function removeConnectedHandles(
  handleIds: readonly string[],
  path: string = defaultHandleRegistryPath(),
): RemoveConnectedHandlesResult {
  const selected = new Set(handleIds);
  return withFileLeaseSync(path, (lease) => {
    const { registry, preservedUnknownHandles } = readConnectedHandleRegistryForWrite(path);
    const removed = registry.handles.filter((handle) => selected.has(handle.handle));
    if (removed.length === 0) return { registry, removed: [] };
    const updated: ConnectedHandleRegistry = {
      version: 1,
      handles: registry.handles.filter((handle) => !selected.has(handle.handle)),
      ...(registry.dropped ? { dropped: registry.dropped } : {}),
    };
    lease.commit(() => writeConnectedHandleRegistryWithPreservedUnknowns(updated, path, preservedUnknownHandles));
    return { registry: updated, removed };
  });
}

export type XLocalOAuthRegistryRepairResult = 'already_metadata_only' | 'repaired';

/**
 * Makes the activated X handle metadata-only when the local OAuth state is the
 * proven token owner. The verification is intentionally the same shape as the
 * live gate: one exact handle, one account identity, an available refresh
 * token, and no widening of provider/capability/trust metadata.
 */
export async function repairXLocalOAuthRegistryPosture(options: {
  registryPath?: string;
  oauth2StateStore: CredentialOAuth2StateStore;
}): Promise<XLocalOAuthRegistryRepairResult> {
  const registryPath = options.registryPath ?? defaultHandleRegistryPath();
  const registry = readConnectedHandleRegistry(registryPath);
  const matches = registry.handles.filter((handle) => handle.handle === 'x.bookmarks.personal');
  if (matches.length !== 1) {
    throw new Error('X local OAuth registry repair requires exactly one personal bookmarks handle.');
  }
  const handle = matches[0]!;
  if (
    handle.provider !== 'x'
    || handle.accountRole !== 'personal'
    || handle.trustDomain !== 'internal'
    || handle.allowedCapabilities.length !== 1
    || handle.allowedCapabilities[0] !== 'x.bookmarks.sync'
    || typeof handle.providerAccountId !== 'string'
    || !handle.providerAccountId.trim()
  ) {
    throw new Error('X local OAuth registry repair refused an invalid connected-handle posture.');
  }
  if ((!handle.tokenSecretRefs || handle.tokenSecretRefs.length === 0) && handle.oauth2Refresh === undefined) {
    // The registry already has the intended metadata-only shape. Do not read
    // the credential state just to re-prove a mutation that is not needed: a
    // temporarily incomplete or account-drifted local state belongs to the
    // ordinary X health surface, not to deployment-time registry repair.
    return 'already_metadata_only';
  }
  const state = await options.oauth2StateStore.load(handle.handle);
  if (
    state?.status !== 'available'
    || typeof state.refreshToken !== 'string'
    || !state.refreshToken.trim()
    || state.pendingRefreshStartedAt !== undefined
    || state.providerAccountId !== handle.providerAccountId
  ) {
    throw new Error('X local OAuth registry repair refused an incomplete or account-mismatched credential posture.');
  }
  const { tokenSecretRefs: _tokenSecretRefs, oauth2Refresh: _oauth2Refresh, ...metadataOnly } = handle;
  upsertConnectedHandle(metadataOnly, registryPath);
  return 'repaired';
}

export function markConnectedHandleReauthRequired(
  handleId: string,
  path: string = defaultHandleRegistryPath(),
  now: Date = new Date(),
): boolean {
  if (!existsSync(path)) return false;
  return withFileLeaseSync(path, (lease) => {
    const { registry, preservedUnknownHandles } = readConnectedHandleRegistryForWrite(path);
    let changed = false;
    const handles = registry.handles.map((handle) => {
      if (handle.handle !== handleId) return handle;
      changed = true;
      return {
        ...handle,
        backendState: {
          kind: handle.backendState?.kind ?? 'oauth2_refresh',
          ...handle.backendState,
          status: 'reauth_required',
          updatedAt: now.toISOString(),
        },
      };
    });
    if (!changed) return false;
    lease.commit(() => writeConnectedHandleRegistryWithPreservedUnknowns({
      version: 1,
      handles,
      ...(registry.dropped ? { dropped: registry.dropped } : {}),
    }, path, preservedUnknownHandles));
    return true;
  });
}

export function deriveEnvCredentialHandlesFromRegistry(
  registry: ConnectedHandleRegistry,
): EnvCredentialHandleDefinition[] {
  return registry.handles.map((handle) => {
    const definition: EnvCredentialHandleDefinition = {
      handle: handle.handle,
      provider: handle.provider,
      allowedCapabilities: [...handle.allowedCapabilities],
      scopes: [...handle.scopes],
      tokenEnvNames: [],
      expiresInSeconds: 3600,
    };
    if (handle.sessionKind) definition.sessionKind = handle.sessionKind;
    if (handle.accountRole) definition.accountRole = handle.accountRole;
    if (handle.trustDomain) definition.trustDomain = handle.trustDomain;
    if (handle.tokenSecretRefs) definition.tokenSecretRefs = [...handle.tokenSecretRefs];
    if (handle.oauth2Refresh) {
      definition.oauth2Refresh = {
        tokenUrl: handle.oauth2Refresh.tokenUrl,
        clientIdEnvNames: [],
        clientSecretEnvNames: [],
        refreshTokenEnvNames: [],
        clientIdSecretRef: handle.oauth2Refresh.clientIdSecretRef,
        ...(handle.oauth2Refresh.clientSecretSecretRef
          ? { clientSecretSecretRef: handle.oauth2Refresh.clientSecretSecretRef }
          : {}),
        refreshTokenSecretRef: handle.oauth2Refresh.refreshTokenSecretRef,
        scopes: [...(handle.oauth2Refresh.scopes ?? handle.scopes)],
        ...(handle.oauth2Refresh.exchangeVia ? { exchangeVia: handle.oauth2Refresh.exchangeVia } : {}),
      };
    }
    if (handle.backendState) {
      definition.backendState = handle.backendState as unknown as CredentialSessionBackendStateInput;
    }
    return definition;
  });
}

export function handleRegistryPathFromEnv(
  env: Record<string, string | undefined>,
  useDefault: boolean,
): string | undefined {
  const configured = env.OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH?.trim();
  if (configured) return configured;
  return useDefault ? defaultHandleRegistryPath() : undefined;
}

function normalizeConnectedHandle(value: unknown): { ok: true; handle: ConnectedCredentialHandle } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'entry_not_object' };
  const record = value as Record<string, unknown>;
  const handle = optionalSafeLabel(record.handle);
  const providerLabel = optionalSafeLabel(record.provider);
  const connectedAt = typeof record.connectedAt === 'string' ? record.connectedAt : undefined;
  if (!handle) return { ok: false, reason: 'invalid_handle' };
  if (!providerLabel) return { ok: false, reason: 'invalid_provider' };
  // A label the broker does not know cannot be given a credential policy, so it
  // is dropped rather than cast. Every rule that keys off the provider -- which
  // credentials may be exercised above all -- would otherwise silently fall
  // through to its default when a label drifts.
  if (!isCredentialProvider(providerLabel)) return { ok: false, reason: 'unknown_provider' };
  const provider: CredentialProvider = providerLabel;
  if (!connectedAt) return { ok: false, reason: 'invalid_connected_at' };
  const allowedCapabilities = stringArray(record.allowedCapabilities);
  const scopes = stringArray(record.scopes);
  if (allowedCapabilities.length === 0) return { ok: false, reason: 'missing_allowed_capabilities' };
  const tokenSecretRefsResult = normalizeTokenSecretRefs(record.tokenSecretRefs);
  if (!tokenSecretRefsResult.ok) return { ok: false, reason: tokenSecretRefsResult.reason };
  const oauth2Result = normalizeOAuth2(record.oauth2Refresh);
  if (!oauth2Result.ok) return { ok: false, reason: oauth2Result.reason };
  const normalized: ConnectedCredentialHandle = {
    handle,
    provider,
    allowedCapabilities,
    scopes,
    connectedAt,
    ...optionalLabelObject(record, 'sessionKind'),
    ...optionalLabelObject(record, 'accountRole'),
    ...optionalLabelObject(record, 'trustDomain'),
    ...optionalLabelObject(record, 'providerAccountId'),
  };
  const tokenSecretRefs = tokenSecretRefsResult.tokenSecretRefs;
  if (tokenSecretRefs.length > 0) normalized.tokenSecretRefs = tokenSecretRefs;
  const oauth2 = oauth2Result.oauth2Refresh;
  if (oauth2) normalized.oauth2Refresh = oauth2;
  if (record.backendState && typeof record.backendState === 'object' && !Array.isArray(record.backendState)) {
    normalized.backendState = record.backendState as NonNullable<ConnectedCredentialHandle['backendState']>;
  }
  return { ok: true, handle: normalized };
}

function normalizeTokenSecretRefs(value: unknown): { ok: true; tokenSecretRefs: string[] } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, tokenSecretRefs: [] };
  if (!Array.isArray(value)) return { ok: false, reason: 'invalid_token_secret_refs' };
  const tokenSecretRefs = stringArray(value);
  if (tokenSecretRefs.length !== value.length || tokenSecretRefs.some((ref) => !isStoreRef(ref))) {
    return { ok: false, reason: 'invalid_token_secret_refs' };
  }
  return { ok: true, tokenSecretRefs };
}

function normalizeOAuth2(value: unknown): { ok: true; oauth2Refresh?: ConnectedCredentialHandle['oauth2Refresh'] } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid_oauth2_refresh' };
  const record = value as Record<string, unknown>;
  const tokenUrl = typeof record.tokenUrl === 'string' && /^https?:\/\//.test(record.tokenUrl)
    ? record.tokenUrl
    : undefined;
  const clientIdSecretRef = typeof record.clientIdSecretRef === 'string' && isStoreRef(record.clientIdSecretRef)
    ? record.clientIdSecretRef
    : undefined;
  const refreshTokenSecretRef = typeof record.refreshTokenSecretRef === 'string' && isStoreRef(record.refreshTokenSecretRef)
    ? record.refreshTokenSecretRef
    : undefined;
  if (!tokenUrl || !clientIdSecretRef || !refreshTokenSecretRef) {
    return { ok: false, reason: 'invalid_oauth2_refresh' };
  }
  const clientSecretSecretRef = typeof record.clientSecretSecretRef === 'string' && isStoreRef(record.clientSecretSecretRef)
    ? record.clientSecretSecretRef
    : undefined;
  // A value the writer did not recognize is dropped rather than trusted: this
  // field decides whether a refresh sends a stored secret nowhere or reaches
  // out to the publisher endpoint, so a foreign or corrupted value must fall
  // back to "ordinary direct refresh" rather than be passed through blind.
  const exchangeVia = record.exchangeVia === 'publisher_endpoint' ? 'publisher_endpoint' as const : undefined;
  return {
    ok: true,
    oauth2Refresh: {
      tokenUrl,
      clientIdSecretRef,
      ...(clientSecretSecretRef ? { clientSecretSecretRef } : {}),
      refreshTokenSecretRef,
      scopes: stringArray(record.scopes),
      ...(exchangeVia ? { exchangeVia } : {}),
    },
  };
}

function warnConnectedHandleDrops(path: string, dropped: ConnectedHandleRegistryDrop[]): void {
  for (const drop of dropped) {
    console.warn(`Ignoring malformed Olympus connected handle registry entry at ${path}#handles[${drop.index}]: ${drop.reason}`);
  }
}

function redactConnectedHandleForDisk(handle: ConnectedCredentialHandle): ConnectedCredentialHandle {
  return {
    ...handle,
    scopes: [...handle.scopes],
    allowedCapabilities: [...handle.allowedCapabilities],
    ...(handle.tokenSecretRefs ? { tokenSecretRefs: [...handle.tokenSecretRefs] } : {}),
    ...(handle.oauth2Refresh ? {
      oauth2Refresh: {
        ...handle.oauth2Refresh,
        scopes: [...(handle.oauth2Refresh.scopes ?? [])],
      },
    } : {}),
  };
}

function optionalLabelObject(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = optionalSafeLabel(record[key]);
  return value ? { [key]: value } : {};
}

function optionalSafeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9._:-]{1,160}$/.test(trimmed) ? trimmed : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
}

function isStoreRef(value: string): boolean {
  if (!value.startsWith('store:')) return false;
  return isSafeSecretKey(value.slice('store:'.length));
}
