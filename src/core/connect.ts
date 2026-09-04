import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stdin as processStdin } from 'node:process';
import { createDefaultSecretStore, isSafeSecretKey, normalizeSecretRef, type SecretStore } from './secret-store.ts';
import { writeManagedWorkerEnvSecret, type WorkerServicePlatform } from './worker-service.ts';
import {
  fetchBoundedText,
  fetchWithTimeout,
  isAbortError,
  isBoundedResponseTooLargeError,
} from './http-timeout.ts';
import { googlePublisherExchangeUrl } from './oauth-relay.ts';
import { isGooglePublisherWebClientId } from './publisher-oauth-client.ts';
import {
  assertOneConnectedAccountPerProvider,
  defaultHandleRegistryPath,
  readConnectedHandleGrantEpoch,
  readConnectedHandleRegistry,
  removeConnectedHandles,
  upsertConnectedHandle,
  withConnectedHandleGrantCustody,
  type ConnectedCredentialHandle,
} from '../workers/credential-broker/connected-handles.ts';
import {
  assertUnpairedSourcesReadable,
  clearUnpairedSource,
  readUnpairedSources,
  recordUnpairedSources,
  unpairedSourcesPath,
  writeUnpairedSources,
  type UnpairedSourcesRead,
} from '../workers/credential-broker/unpaired-sources.ts';
import {
  credentialOAuth2StateStoreFromEnv,
  type CredentialOAuth2StateStore,
} from '../workers/credential-broker/index.ts';

const DEFAULT_OAUTH_AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS = 60 * 1000;
const DETACHED_PARENT_WAIT_MS = 5_000;

export type OAuthFetch = (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => Promise<Response>;

export type ConnectSource =
  | 'google'
  | 'gmail'
  | 'google-drive'
  | 'gcp'
  | 'dropbox'
  | 'x'
  | 'telegram'
  | 'whatsapp'
  | 'venice'
  | 'readwise'
  | 'gemini'
  | 'notion';

export interface ConnectOAuthOptions {
  source: 'google' | 'gmail' | 'google-drive' | 'dropbox' | 'x';
  clientId: string;
  clientSecret?: string;
  accountRole?: string;
  authUrl?: string;
  tokenUrl?: string;
  redirectPort?: number;
  openBrowser?: boolean;
  registryPath?: string;
  secretStore?: SecretStore;
  oauth2StateStore?: CredentialOAuth2StateStore;
  now?: () => Date;
  fetch?: OAuthFetch;
  onAuthorizationUrl?: (url: string) => void | Promise<void>;
  authorizationTimeoutMs?: number;
  tokenExchangeTimeoutMs?: number;
  /** Internal fence captured when a detached connection request is accepted. */
  grantEpoch?: string;
  /**
   * Whose OAuth app this flow's `clientId` belongs to, when the caller knows.
   * Persisted alongside the stored client id (`<source>.<role>.oauth.client_id_source`)
   * so a later render can tell "the owner registered this" from "this is
   * Olympus's own publisher app the owner never had to touch" — a distinction
   * "is a client_id present" cannot make once a publisher-owned id and an
   * owner-pasted id are stored under the identical key. Absent for the plain
   * CLI connect path, which has no publisher concept and writes nothing new.
   */
  clientIdSource?: 'publisher' | 'byo';
}

export interface ConnectResult {
  ok: true;
  source: string;
  handles: string[];
  registryPath?: string;
  oauth2StateWrite?: 'updated' | 'not_configured';
  secretRefs: string[];
  next?: string;
  messages?: string[];
}

export interface PendingOAuthConnection {
  ok: true;
  source: ConnectOAuthOptions['source'];
  authorizationUrl: string;
  redirectUri: string;
  completion: Promise<ConnectResult>;
  cancel(): void;
}

export interface ExternalPendingOAuthConnection {
  ok: true;
  source: ConnectOAuthOptions['source'];
  authorizationUrl: string;
  redirectUri: string;
  state: string;
  startedAt: string;
  expiresAt: string;
  completeCallback(callback: { state: string; code: string }): Promise<ConnectResult>;
  cancel(): void;
}

export type DetachedOAuthStatus = 'pending' | 'connected' | 'failed' | 'expired' | 'died';

export interface DetachedOAuthState {
  source: ConnectOAuthOptions['source'];
  accountRole: string;
  status: DetachedOAuthStatus;
  startedAt: string;
  expiresAt: string;
  authorizationUrl?: string;
  redirectUri?: string;
  port?: number;
  pid?: number;
  logPath?: string;
  handles?: string[];
  handleId?: string;
  registryPath?: string;
  reason?: string;
  errorCode?: string;
  retryable?: boolean;
  retryAt?: string;
}

export interface DetachedOAuthConnectResult {
  ok: true;
  source: ConnectOAuthOptions['source'];
  accountRole: string;
  status: DetachedOAuthStatus;
  authorizationUrl: string;
  port: number;
  pid: number;
  statePath: string;
  logPath: string;
  startedAt: string;
  expiresAt: string;
}

interface DetachedOAuthRequestFile {
  source: ConnectOAuthOptions['source'];
  clientId: string;
  clientSecret?: string;
  accountRole?: string;
  authUrl?: string;
  tokenUrl?: string;
  redirectPort?: number;
  openBrowser?: boolean;
  registryPath?: string;
  secretStoreBackend?: string;
  secretStorePath?: string;
  secretStoreKeyPath?: string;
  authorizationTimeoutMs?: number;
  tokenExchangeTimeoutMs?: number;
  grantEpoch?: string;
  statePath: string;
  logPath: string;
}

interface OAuthSourceDefinition {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  handles: Array<{
    handle: (role: string) => string;
    provider: ConnectedCredentialHandle['provider'];
    capability: string;
    trustDomain: ConnectedCredentialHandle['trustDomain'];
    scopes: string[];
  }>;
}

export async function connectOAuthSource(options: ConnectOAuthOptions): Promise<ConnectResult> {
  const pending = await startOAuthSourceConnection(options);
  return pending.completion;
}

export async function connectOAuthSourceDetached(options: ConnectOAuthOptions & {
  stateDir?: string;
  logDir?: string;
  childArgv?: string[];
  childCwd?: string;
  parentWaitMs?: number;
  secretStoreBackend?: string;
  secretStorePath?: string;
  secretStoreKeyPath?: string;
}): Promise<DetachedOAuthConnectResult> {
  const registryPath = options.registryPath ?? defaultHandleRegistryPath();
  const grantEpoch = options.grantEpoch ?? readConnectedHandleGrantEpoch(registryPath);
  const accountRole = safeAccountRole(options.accountRole ?? 'personal');
  const authorizationTimeoutMs = normalizeOAuthTimeoutMs(
    options.authorizationTimeoutMs,
    DEFAULT_OAUTH_AUTHORIZATION_TIMEOUT_MS,
    'OAuth authorization timeout',
  );
  const startedAtDate = options.now?.() ?? new Date();
  const startedAt = startedAtDate.toISOString();
  const expiresAt = new Date(startedAtDate.getTime() + authorizationTimeoutMs).toISOString();
  const stateDir = options.stateDir ?? defaultDetachedOAuthStateDir();
  const logDir = options.logDir ?? defaultDetachedOAuthLogDir();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const statePath = detachedOAuthStatePath({ stateDir, source: options.source, accountRole });
  cleanupTerminalDetachedOAuthState(statePath);
  const logPath = join(logDir, `${options.source}.${accountRole}.${startedAt.replaceAll(/[:.]/g, '-')}.log`);
  const requestPath = `${statePath}.request.${process.pid}.${Date.now()}.json`;
  writePrivateJson(requestPath, {
    source: options.source,
    clientId: options.clientId,
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
    ...(options.accountRole ? { accountRole: options.accountRole } : {}),
    ...(options.authUrl ? { authUrl: options.authUrl } : {}),
    ...(options.tokenUrl ? { tokenUrl: options.tokenUrl } : {}),
    ...(options.redirectPort !== undefined ? { redirectPort: options.redirectPort } : {}),
    ...(options.openBrowser !== undefined ? { openBrowser: options.openBrowser } : {}),
    registryPath,
    grantEpoch,
    ...(options.secretStoreBackend ? { secretStoreBackend: options.secretStoreBackend } : {}),
    ...(options.secretStorePath ? { secretStorePath: options.secretStorePath } : {}),
    ...(options.secretStoreKeyPath ? { secretStoreKeyPath: options.secretStoreKeyPath } : {}),
    authorizationTimeoutMs,
    ...(options.tokenExchangeTimeoutMs !== undefined ? { tokenExchangeTimeoutMs: options.tokenExchangeTimeoutMs } : {}),
    statePath,
    logPath,
  } satisfies DetachedOAuthRequestFile);

  const argv = options.childArgv ?? [process.execPath, process.argv[1] ?? 'src/cli.ts'];
  const child = Bun.spawn({
    cmd: [...argv, '__oauth-detached-child', requestPath],
    cwd: options.childCwd ?? process.cwd(),
    stdin: 'ignore',
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
    detached: true,
    env: { ...process.env, OLYMPUS_OAUTH_DETACHED_CHILD: '1' },
  });
  child.unref();

  const pending = await waitForDetachedPendingState({
    statePath,
    source: options.source,
    accountRole,
    pid: child.pid,
    logPath,
    timeoutMs: options.parentWaitMs ?? DETACHED_PARENT_WAIT_MS,
  });
  if (pending.status !== 'pending' || !pending.authorizationUrl || !pending.port || !pending.pid) {
    // The child deletes the request file on read; if it died before reading,
    // don't leave client credentials on disk.
    rmSync(requestPath, { force: true });
    throw new Error(`Detached OAuth child for ${pending.source}/${pending.accountRole} did not publish a pending authorization URL. See log: ${logPath}`);
  }
  return {
    ok: true,
    source: pending.source,
    accountRole: pending.accountRole,
    status: pending.status,
    authorizationUrl: pending.authorizationUrl,
    port: pending.port,
    pid: pending.pid,
    statePath,
    logPath,
    startedAt: pending.startedAt,
    expiresAt: pending.expiresAt,
  };
}

export async function runDetachedOAuthChildFromRequestFile(requestPath: string): Promise<void> {
  const request = readDetachedOAuthRequestFile(requestPath);
  rmSync(requestPath, { force: true });
  const secretStore = createDefaultSecretStore({
    env: {
      ...process.env,
      ...(request.secretStoreBackend ? { OLYMPUS_SECRET_STORE_BACKEND: request.secretStoreBackend } : {}),
    },
    paths: {
      ...(request.secretStorePath ? { encryptedFilePath: request.secretStorePath } : {}),
      ...(request.secretStoreKeyPath ? { keyFilePath: request.secretStoreKeyPath } : {}),
    },
  });
  await runDetachedOAuthLifecycle({
    source: request.source,
    clientId: request.clientId,
    ...(request.clientSecret ? { clientSecret: request.clientSecret } : {}),
    ...(request.accountRole ? { accountRole: request.accountRole } : {}),
    ...(request.authUrl ? { authUrl: request.authUrl } : {}),
    ...(request.tokenUrl ? { tokenUrl: request.tokenUrl } : {}),
    ...(request.redirectPort !== undefined ? { redirectPort: request.redirectPort } : {}),
    ...(request.openBrowser !== undefined ? { openBrowser: request.openBrowser } : {}),
    ...(request.registryPath ? { registryPath: request.registryPath } : {}),
    ...(request.grantEpoch ? { grantEpoch: request.grantEpoch } : {}),
    secretStore,
    ...(request.authorizationTimeoutMs !== undefined ? { authorizationTimeoutMs: request.authorizationTimeoutMs } : {}),
    ...(request.tokenExchangeTimeoutMs !== undefined ? { tokenExchangeTimeoutMs: request.tokenExchangeTimeoutMs } : {}),
    statePath: request.statePath,
    logPath: request.logPath,
  });
}

export async function runDetachedOAuthLifecycle(options: ConnectOAuthOptions & {
  statePath: string;
  logPath: string;
  pid?: number;
}): Promise<DetachedOAuthState> {
  const accountRole = safeAccountRole(options.accountRole ?? 'personal');
  const now = options.now ?? (() => new Date());
  const startedAtDate = now();
  const authorizationTimeoutMs = normalizeOAuthTimeoutMs(
    options.authorizationTimeoutMs,
    DEFAULT_OAUTH_AUTHORIZATION_TIMEOUT_MS,
    'OAuth authorization timeout',
  );
  const baseState = {
    source: options.source,
    accountRole,
    startedAt: startedAtDate.toISOString(),
    expiresAt: new Date(startedAtDate.getTime() + authorizationTimeoutMs).toISOString(),
    pid: options.pid ?? process.pid,
    logPath: options.logPath,
  };
  try {
    const pending = await startOAuthSourceConnection({
      ...options,
      accountRole,
      authorizationTimeoutMs,
      onAuthorizationUrl: async (authorizationUrl) => {
        const redirectUri = new URL(authorizationUrl).searchParams.get('redirect_uri') ?? '';
        const port = redirectUri ? Number(new URL(redirectUri).port) : undefined;
        writeDetachedOAuthState(options.statePath, {
          ...baseState,
          status: 'pending',
          authorizationUrl,
          ...(redirectUri ? { redirectUri } : {}),
          ...(typeof port === 'number' && Number.isFinite(port) ? { port } : {}),
        });
        await options.onAuthorizationUrl?.(authorizationUrl);
      },
    });
    const result = await pending.completion;
    const connected: DetachedOAuthState = {
      ...baseState,
      status: 'connected',
      handles: result.handles,
      ...(result.handles[0] ? { handleId: result.handles[0] } : {}),
      ...(result.registryPath ? { registryPath: result.registryPath } : {}),
    };
    writeDetachedOAuthState(options.statePath, connected);
    return connected;
  } catch (error) {
    const reason = errorDetail(error);
    const retry = retryableErrorDisposition(error, now());
    const failed: DetachedOAuthState = {
      ...baseState,
      status: isOAuthAuthorizationTimeout(reason) ? 'expired' : 'failed',
      reason,
      ...(retry ? {
        errorCode: retry.code,
        retryable: true,
        retryAt: retry.retryAt,
      } : {}),
    };
    writeDetachedOAuthState(options.statePath, failed);
    return failed;
  }
}

export async function startOAuthSourceConnection(options: ConnectOAuthOptions): Promise<PendingOAuthConnection> {
  const pkce = createOAuthPkceState();
  const callback = await createLoopbackCallbackServer({
    state: pkce.state,
    ...(options.redirectPort !== undefined ? { port: options.redirectPort } : {}),
  });
  const redirectUri = `http://127.0.0.1:${callback.port}/oauth/callback`;
  const prepared = prepareOAuthSourceConnection(options, redirectUri, pkce);

  try {
    await options.onAuthorizationUrl?.(prepared.authorizationUrl);
    if (options.openBrowser !== false) openBrowser(prepared.authorizationUrl);
  } catch (error) {
    callback.server.close();
    throw error;
  }
  const completion = finishOAuthSourceConnection({
    prepared,
    callback,
  });
  return {
    ok: true,
    source: options.source,
    authorizationUrl: prepared.authorizationUrl,
    redirectUri,
    completion,
    cancel: () => callback.server.close(),
  };
}

export async function startExternalOAuthSourceConnection(
  options: ConnectOAuthOptions & { redirectUri: string; state?: string },
): Promise<ExternalPendingOAuthConnection> {
  // The caller may own the `state` — the publisher-client relay flow signs one
  // that carries the dashboard origin the relay bounces back to (see
  // `core/oauth-relay.ts`). The PKCE verifier is still minted here and still
  // never leaves this process; only the opaque state is substituted, and it is
  // bounded to what a provider will echo and the relay will parse.
  const pkce = createOAuthPkceState();
  const prepared = prepareOAuthSourceConnection(
    options,
    options.redirectUri,
    options.state === undefined ? pkce : { ...pkce, state: assertExternalOAuthState(options.state) },
  );
  await options.onAuthorizationUrl?.(prepared.authorizationUrl);
  return {
    ok: true,
    source: options.source,
    authorizationUrl: prepared.authorizationUrl,
    redirectUri: prepared.redirectUri,
    state: prepared.state,
    startedAt: prepared.startedAt.toISOString(),
    expiresAt: new Date(prepared.startedAt.getTime() + prepared.authorizationTimeoutMs).toISOString(),
    completeCallback: async (callback) => {
      if (callback.state !== prepared.state) throw new Error('OAuth state mismatch.');
      return completeOAuthSourceConnection(prepared, callback.code);
    },
    cancel() {},
  };
}

/**
 * A caller-supplied `state` must survive a provider echo and the relay's own
 * parse: two base64url segments joined by one `.`, no longer than the relay's
 * 2048-character ceiling. Anything else is refused at start rather than turned
 * into a consent round that cannot come back.
 */
function assertExternalOAuthState(state: string): string {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(state) || state.length > 2048) {
    throw new Error('OAuth state must be two base64url segments of at most 2048 characters.');
  }
  return state;
}

async function finishOAuthSourceConnection(options: {
  prepared: PreparedOAuthSourceConnection;
  callback: Awaited<ReturnType<typeof createLoopbackCallbackServer>>;
}): Promise<ConnectResult> {
  try {
    const code = await waitForAuthorizationCode(options.callback.waitForCode, options.prepared.authorizationTimeoutMs);
    return completeOAuthSourceConnection(options.prepared, code);
  } finally {
    options.callback.server.close();
  }
}

interface OAuthPkceState {
  verifier: string;
  challenge: string;
  state: string;
}

interface PreparedOAuthSourceConnection {
  options: ConnectOAuthOptions;
  definition: OAuthSourceDefinition;
  accountRole: string;
  secretStore: SecretStore;
  oauth2StateStore?: CredentialOAuth2StateStore;
  now: () => Date;
  registryPath: string;
  grantEpoch: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  verifier: string;
  state: string;
  authorizationUrl: string;
  authorizationTimeoutMs: number;
  tokenExchangeTimeoutMs: number;
  startedAt: Date;
}

function createOAuthPkceState(): OAuthPkceState {
  const verifier = base64Url(randomBytes(32));
  return {
    verifier,
    challenge: base64Url(createHash('sha256').update(verifier).digest()),
    state: base64Url(randomBytes(24)),
  };
}

function prepareOAuthSourceConnection(
  options: ConnectOAuthOptions,
  redirectUri: string,
  pkce: OAuthPkceState = createOAuthPkceState(),
): PreparedOAuthSourceConnection {
  const definition = oauthSourceDefinition(options.source);
  const accountRole = safeAccountRole(options.accountRole ?? 'personal');
  const secretStore = options.secretStore ?? createDefaultSecretStore();
  const oauth2StateStore = options.oauth2StateStore
    ?? credentialOAuth2StateStoreFromEnv(process.env);
  const now = options.now ?? (() => new Date());
  const registryPath = options.registryPath ?? defaultHandleRegistryPath();
  const grantEpoch = options.grantEpoch ?? readConnectedHandleGrantEpoch(registryPath);
  const clientId = options.clientId.trim();
  const clientSecret = options.source === 'dropbox' ? undefined : options.clientSecret?.trim();
  const authorizationTimeoutMs = normalizeOAuthTimeoutMs(
    options.authorizationTimeoutMs,
    DEFAULT_OAUTH_AUTHORIZATION_TIMEOUT_MS,
    'OAuth authorization timeout',
  );
  const tokenExchangeTimeoutMs = normalizeOAuthTimeoutMs(
    options.tokenExchangeTimeoutMs,
    DEFAULT_OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS,
    'OAuth token exchange timeout',
  );
  if (!clientId) throw new Error('OAuth client ID is required.');
  const authorizationUrl = buildAuthorizationUrl({
    source: options.source,
    authUrl: options.authUrl ?? definition.authUrl,
    clientId,
    redirectUri,
    scopes: definition.scopes,
    state: pkce.state,
    challenge: pkce.challenge,
  });
  return {
    options,
    definition,
    accountRole,
    secretStore,
    ...(oauth2StateStore ? { oauth2StateStore } : {}),
    now,
    registryPath,
    grantEpoch,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    redirectUri,
    verifier: pkce.verifier,
    state: pkce.state,
    authorizationUrl,
    authorizationTimeoutMs,
    tokenExchangeTimeoutMs,
    startedAt: now(),
  };
}

async function completeOAuthSourceConnection(
  prepared: PreparedOAuthSourceConnection,
  code: string,
): Promise<ConnectResult> {
  // The route is decided FIRST, because it decides whether a client secret
  // may be touched at all (Codex round 1 on 5cb644b9). The publisher web
  // client's secret lives only in the publisher exchange endpoint, so this
  // flow has no secret of its own — and `resolveOAuthClientSecret` searches
  // the `google`/`gmail`/`google-drive` namespaces for ANY stored secret
  // without checking it belongs to the client in use. Resolving first meant a
  // secret left behind by an unrelated bring-your-own registration was copied
  // under this source's key and referenced from the handle registry, giving a
  // publisher credential a `clientSecretSecretRef` to a stranger's secret.
  const usesGooglePublisherExchange = isGooglePublisherExchangeClient(prepared.options.source, prepared.clientId);
  const clientSecret = usesGooglePublisherExchange ? undefined : await resolveOAuthClientSecret(prepared);
  const token = await exchangeAuthorizationCode({
    source: prepared.options.source,
    tokenUrl: prepared.options.tokenUrl ?? prepared.definition.tokenUrl,
    clientId: prepared.clientId,
    ...(clientSecret ? { clientSecret } : {}),
    code,
    redirectUri: prepared.redirectUri,
    verifier: prepared.verifier,
    fetchImpl: prepared.options.fetch ?? fetch,
    timeoutMs: prepared.tokenExchangeTimeoutMs,
    state: prepared.state,
  });
  if (!token.refreshToken) throw new Error('OAuth provider did not return a refresh token. Re-run connect and request offline access.');
  const refreshToken = token.refreshToken;

  let xUserId: string | undefined;
  if (prepared.options.source === 'x') {
    // Resolve identity before taking the cross-process grant lock. Provider
    // latency must never make a live local mutation lease look abandoned.
    xUserId = await fetchXUserId({
      tokenUrl: prepared.options.tokenUrl ?? prepared.definition.tokenUrl,
      accessToken: token.accessToken,
      fetchImpl: prepared.options.fetch ?? fetch,
      timeoutMs: prepared.tokenExchangeTimeoutMs,
    });
  }

  return withConnectedHandleGrantCustody(
    prepared.registryPath,
    { expectedEpoch: prepared.grantEpoch },
    async () => {
      const proposedHandles = prepared.definition.handles.map((definition) => ({
        handle: definition.handle(prepared.accountRole),
        provider: definition.provider,
      }));
      assertOneConnectedAccountForProposedProviders(prepared.registryPath, proposedHandles);

      const secretRefs: string[] = [];
      const clientIdKey = `${prepared.options.source}.${prepared.accountRole}.oauth.client_id`;
      const refreshKey = `${prepared.options.source}.${prepared.accountRole}.oauth.refresh_token`;
      await prepared.secretStore.set(clientIdKey, prepared.clientId);
      // The refresh token and every handle publish under one cross-process
      // custody fence, so Disconnect can occur wholly before or after Connect.
      await prepared.secretStore.set(refreshKey, refreshToken);
      secretRefs.push(`store:${clientIdKey}`, `store:${refreshKey}`);
      // Written only when the caller states it, which today means only the
      // dashboard's publisher-relay start route: the plain CLI connect path has
      // no publisher concept and leaves this key untouched, exactly as before
      // this field existed. Without it, `clientIdKey` alone cannot tell a
      // client id the OWNER pasted from Olympus's own publisher app key once
      // both are persisted under the identical key — the gap that let a
      // completed publisher connection get misclassified as bring-your-own on
      // its next reauthentication (Codex round 3 on e75598f7).
      if (prepared.options.clientIdSource !== undefined) {
        const clientIdSourceKey = `${prepared.options.source}.${prepared.accountRole}.oauth.client_id_source`;
        await prepared.secretStore.set(clientIdSourceKey, prepared.options.clientIdSource);
        secretRefs.push(`store:${clientIdSourceKey}`);
      }

      let clientSecretRef: string | undefined;
      // `clientSecret` is already `undefined` on the publisher path; the
      // condition restates it so the invariant is readable here rather than
      // sixty lines up, and so a future edit to the resolver cannot quietly
      // reintroduce a stored secret for a credential that has none.
      if (!usesGooglePublisherExchange && clientSecret && shouldStoreOAuthClientSecret(prepared.options.source)) {
        const clientSecretKey = `${prepared.options.source}.${prepared.accountRole}.oauth.client_secret`;
        await prepared.secretStore.set(clientSecretKey, clientSecret);
        clientSecretRef = `store:${clientSecretKey}`;
        secretRefs.push(clientSecretRef);
      }

      const handles: string[] = [];
      const connectedAt = prepared.now();
      // An activated X lane may keep its rotating token in the local OAuth
      // state store and leave handles.json metadata-only. Both writes remain
      // inside the same grant-custody fence.
      const registryOwnsOAuth = prepared.options.source !== 'x' || !prepared.oauth2StateStore;
      for (const handleDefinition of prepared.definition.handles) {
        const handle = handleDefinition.handle(prepared.accountRole);
        handles.push(handle);
        await prepared.oauth2StateStore?.save(handle, {
          refreshToken,
          scopes: handleDefinition.scopes,
          status: 'available',
          updatedAt: connectedAt.toISOString(),
          ...(xUserId ? { providerAccountId: xUserId } : {}),
        });
        upsertConnectedHandle({
          handle,
          provider: handleDefinition.provider,
          accountRole: prepared.accountRole,
          ...(handleDefinition.trustDomain ? { trustDomain: handleDefinition.trustDomain } : {}),
          allowedCapabilities: [handleDefinition.capability],
          scopes: handleDefinition.scopes,
          ...(registryOwnsOAuth ? {
            oauth2Refresh: {
              tokenUrl: prepared.options.tokenUrl ?? prepared.definition.tokenUrl,
              clientIdSecretRef: `store:${clientIdKey}`,
              ...(clientSecretRef ? { clientSecretSecretRef: clientSecretRef } : {}),
              refreshTokenSecretRef: `store:${refreshKey}`,
              scopes: handleDefinition.scopes,
              // Provenance, not presence (same reasoning as `clientIdSource`
              // above): a future rotation of `DEFAULT_GOOGLE_PUBLISHER_WEB_
              // CLIENT_ID` must not strand an already-connected publisher
              // credential on a client-id value-match that no longer holds.
              // Written once, at connect time, from a fact about how THIS
              // exchange actually happened.
              ...(usesGooglePublisherExchange ? { exchangeVia: 'publisher_endpoint' as const } : {}),
            },
          } : {}),
          connectedAt: connectedAt.toISOString(),
          ...(xUserId ? { providerAccountId: xUserId } : {}),
        }, prepared.registryPath);
      }

      return {
        ok: true,
        source: prepared.options.source,
        handles,
        registryPath: prepared.registryPath,
        oauth2StateWrite: prepared.oauth2StateStore ? 'updated' : 'not_configured',
        secretRefs: secretRefs.sort(),
      };
    },
  );
}

/**
 * The client secret this exchange authenticates with.
 *
 * Google's installed-app token endpoint refuses a Desktop-client exchange that
 * omits `client_secret` when that client has one — the documentation calls the
 * secret optional, and a live friend-test earned 400 `client_secret is missing`
 * anyway (2026-07-07). v0.4 stopped asking the owner to paste the secret on
 * every connect, so an install that already holds one must not silently drop
 * it: an exchange sent client-ID-only fails after the consent round is already
 * spent, and each retry burns another.
 *
 * Order: what this call was given (a BYO paste or `--client-secret-stdin`),
 * then the secret any earlier Google connect stored under this account role,
 * then the shared pilot client's operator-supplied secret. Finding nothing
 * still exchanges on client ID plus PKCE — the packaged public-client lane.
 */
async function resolveOAuthClientSecret(
  prepared: PreparedOAuthSourceConnection,
): Promise<string | undefined> {
  if (prepared.clientSecret) return prepared.clientSecret;
  if (!isGoogleOAuthSource(prepared.options.source)) return undefined;
  const keys = new Set([prepared.options.source, 'google', 'gmail', 'google-drive']);
  for (const key of keys) {
    const stored = (await prepared.secretStore.get(`${key}.${prepared.accountRole}.oauth.client_secret`))?.trim();
    if (stored) return stored;
  }
  return process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET?.trim() || undefined;
}

/**
 * One connected account per provider is a rule about the provider being
 * connected. Handing the whole registry to the assert made an unrelated
 * provider's duplicate — a `gcp` account-role pair, or a handle written before
 * this guard existed — refuse every other source's connect, after consent, with
 * a message naming an account the owner never touched. The dashboard already
 * narrows to the source's own providers before the same assert.
 */
function assertOneConnectedAccountForProposedProviders(
  registryPath: string,
  proposed: readonly Pick<ConnectedCredentialHandle, 'handle' | 'provider'>[],
): void {
  const providers = new Set(proposed.map((handle) => handle.provider));
  const handles = readConnectedHandleRegistry(registryPath).handles
    .filter((handle) => providers.has(handle.provider));
  assertOneConnectedAccountPerProvider({ version: 1, handles }, proposed);
}

function normalizeOAuthTimeoutMs(value: number | undefined, defaultValue: number, label: string): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number of milliseconds.`);
  }
  return Math.floor(value);
}

async function waitForAuthorizationCode(waitForCode: Promise<string>, timeoutMs: number): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      waitForCode,
      new Promise<string>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`OAuth authorization timed out after ${formatDurationMs(timeoutMs)}. Re-run connect when you are ready to finish browser authorization.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function formatDurationMs(value: number): string {
  if (value < 1000) return `${value} ms`;
  const seconds = Math.ceil(value / 1000);
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/** Public v0.4 API-key path. Kept separate from repository-only providers so
 * the release bundler cannot retain their validation or credential code. */
export async function connectPublicApiKeySource(options: {
  source: 'venice' | 'readwise';
  apiKey: string;
  accountRole?: string;
  registryPath?: string;
  secretStore?: SecretStore;
  now?: () => Date;
  fetch?: OAuthFetch;
  readwiseAuthUrl?: string;
  veniceModelsUrl?: string;
  validationTimeoutMs?: number;
}): Promise<ConnectResult> {
  const accountRole = safeAccountRole(options.accountRole ?? 'personal');
  const key = options.apiKey.trim();
  if (!key) throw new Error('API key is required.');
  const secretStore = options.secretStore ?? createDefaultSecretStore();
  const registryPath = options.registryPath ?? defaultHandleRegistryPath();
  const now = options.now ?? (() => new Date());
  if (options.source === 'venice') {
    await validatePublicApiKeySource({
      source: 'venice',
      apiKey: key,
      fetchImpl: options.fetch ?? fetch,
      ...(options.veniceModelsUrl ? { veniceModelsUrl: options.veniceModelsUrl } : {}),
      timeoutMs: options.validationTimeoutMs ?? DEFAULT_OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS,
    });
    await secretStore.set('venice.api_key', key);
    return {
      ok: true,
      source: 'venice',
      handles: [],
      registryPath,
      secretRefs: ['store:venice.api_key'],
      next: 'Use secretRef store:venice.api_key on an approved Venice member in routes.secure_local.pool. Secure answers use that configured pool; E2EE model ids remain gated pending local key handling.',
    };
  }

  await validatePublicApiKeySource({
    source: 'readwise',
    apiKey: key,
    fetchImpl: options.fetch ?? fetch,
    ...(options.readwiseAuthUrl ? { readwiseAuthUrl: options.readwiseAuthUrl } : {}),
    timeoutMs: options.validationTimeoutMs ?? DEFAULT_OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS,
  });
  const grantEpoch = readConnectedHandleGrantEpoch(registryPath);
  return withConnectedHandleGrantCustody(registryPath, { expectedEpoch: grantEpoch }, async () => {
    const handle = `readwise.${accountRole}`;
    assertOneConnectedAccountForProposedProviders(registryPath, [{ handle, provider: 'readwise' }]);
    const secretKey = `readwise.${accountRole}.token`;
    await secretStore.set(secretKey, key);
    upsertConnectedHandle({
      handle,
      provider: 'readwise',
      accountRole,
      trustDomain: 'internal',
      allowedCapabilities: ['readwise.sync'],
      scopes: ['readwise.export:read', 'readwise.reader:read'],
      tokenSecretRefs: [`store:${secretKey}`],
      connectedAt: now().toISOString(),
    }, registryPath);
    return { ok: true, source: 'readwise', handles: [handle], registryPath, secretRefs: [`store:${secretKey}`] };
  });
}

/**
 * Store the Gemini API key where the supervised worker will actually read it.
 *
 * Every preset needs this key for source-index embeddings, and before this
 * command there was no way to supply it: the worker reads it from ITS process
 * environment, which the service manager loads from worker.env, so an `export`
 * in the operator's shell reaches nothing, and the install guide forbids
 * editing worker.env by hand. The key is validated before it is stored so a
 * mistyped paste fails here rather than as a degraded embedding lane later.
 */
export async function connectGeminiApiKey(options: {
  apiKey: string;
  platform?: WorkerServicePlatform;
  homeDir?: string;
  envPath?: string;
  fetch?: OAuthFetch;
  geminiModelsUrl?: string;
  validationTimeoutMs?: number;
  validate?: boolean;
}): Promise<ConnectResult> {
  const key = options.apiKey.trim();
  if (!key) throw new Error('API key is required.');
  if (options.validate !== false) {
    await validateGeminiApiKey({
      apiKey: key,
      fetchImpl: options.fetch ?? fetch,
      ...(options.geminiModelsUrl ? { geminiModelsUrl: options.geminiModelsUrl } : {}),
      timeoutMs: options.validationTimeoutMs ?? DEFAULT_OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS,
    });
  }
  const stored = writeManagedWorkerEnvSecret({
    key: 'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY',
    value: key,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.envPath ? { envPath: options.envPath } : {}),
  });
  return {
    ok: true,
    source: 'gemini',
    handles: [],
    secretRefs: [`env:${stored.key}`],
    next: `Stored in ${stored.path}. Run olympus worker restart so the worker picks it up.`,
  };
}

async function validateGeminiApiKey(options: {
  apiKey: string;
  fetchImpl: OAuthFetch;
  geminiModelsUrl?: string;
  timeoutMs: number;
}): Promise<void> {
  const url = options.geminiModelsUrl
    ?? process.env.OLYMPUS_CONNECT_GEMINI_MODELS_URL
    ?? 'https://generativelanguage.googleapis.com/v1beta/models';
  let response: Response;
  try {
    // Header, never a query parameter: a key in the URL lands in every proxy
    // and access log between here and Google.
    response = await fetchWithTimeout(options.fetchImpl, url, {
      method: 'GET',
      headers: { 'x-goog-api-key': options.apiKey, Accept: 'application/json' },
    }, options.timeoutMs);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('Gemini API key validation timed out. No credentials were stored; try again when the Gemini API is reachable.');
    }
    throw new Error('Could not validate the Gemini API key. No credentials were stored; try again when the Gemini API is reachable.');
  }
  if (!response.ok) {
    throw new Error('Gemini rejected the API key. Paste a current Gemini API key from https://aistudio.google.com/apikey and try again.');
  }
}

async function validatePublicApiKeySource(options: {
  source: 'venice' | 'readwise';
  apiKey: string;
  fetchImpl: OAuthFetch;
  readwiseAuthUrl?: string;
  veniceModelsUrl?: string;
  timeoutMs: number;
}): Promise<void> {
  if (options.source === 'readwise') {
    const url = options.readwiseAuthUrl
      ?? process.env.OLYMPUS_CONNECT_READWISE_AUTH_URL
      ?? 'https://readwise.io/api/v2/auth/';
    let response: Response;
    try {
      response = await fetchWithTimeout(options.fetchImpl, url, {
        method: 'GET',
        headers: { Authorization: `Token ${options.apiKey}`, Accept: 'application/json' },
      }, options.timeoutMs);
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error('Readwise token validation timed out. No credentials were stored; try again when Readwise is reachable.');
      }
      throw new Error('Could not validate the Readwise token. No credentials were stored; try again when Readwise is reachable.');
    }
    if (response.status !== 204) {
      throw new Error('Readwise rejected the API token. Paste a current Readwise access token and try again.');
    }
    return;
  }

  const url = options.veniceModelsUrl
    ?? process.env.OLYMPUS_CONNECT_VENICE_MODELS_URL
    ?? 'https://api.venice.ai/api/v1/models';
  let response: Response;
  try {
    response = await fetchWithTimeout(options.fetchImpl, url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' },
    }, options.timeoutMs);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('Venice API key validation timed out. No credentials were stored; try again when Venice is reachable.');
    }
    throw new Error('Could not validate the Venice API key. No credentials were stored; try again when Venice is reachable.');
  }
  if (!response.ok) {
    throw new Error('Venice rejected the API key. Paste a current Venice API key and try again.');
  }
}

// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
export async function connectApiKeySource(options: {
  source: 'venice' | 'readwise' | 'notion';
  apiKey: string;
  accountRole?: string;
  registryPath?: string;
  secretStore?: SecretStore;
  now?: () => Date;
  fetch?: OAuthFetch;
  readwiseAuthUrl?: string;
  veniceModelsUrl?: string;
  notionBaseUrl?: string;
  notionVersion?: string;
  validationTimeoutMs?: number;
}): Promise<ConnectResult> {
  const accountRole = safeAccountRole(options.accountRole ?? 'personal');
  const key = options.apiKey.trim();
  if (!key) throw new Error('API key is required.');
  const secretStore = options.secretStore ?? createDefaultSecretStore();
  const registryPath = options.registryPath ?? defaultHandleRegistryPath();
  const grantEpoch = options.source === 'venice'
    ? undefined
    : readConnectedHandleGrantEpoch(registryPath);
  const now = options.now ?? (() => new Date());
  const secretKey = options.source === 'venice'
    ? 'venice.api_key'
    : options.source === 'readwise'
      ? `readwise.${accountRole}.token`
      : `notion.${accountRole}.integration_token`;
  await validateApiKeySource({
    source: options.source,
    apiKey: key,
    fetchImpl: options.fetch ?? fetch,
    ...(options.readwiseAuthUrl ? { readwiseAuthUrl: options.readwiseAuthUrl } : {}),
    ...(options.veniceModelsUrl ? { veniceModelsUrl: options.veniceModelsUrl } : {}),
    ...(options.notionBaseUrl ? { notionBaseUrl: options.notionBaseUrl } : {}),
    ...(options.notionVersion ? { notionVersion: options.notionVersion } : {}),
    timeoutMs: options.validationTimeoutMs ?? DEFAULT_OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS,
  });
  if (options.source === 'venice') {
    await secretStore.set(secretKey, key);
    return {
      ok: true,
      source: options.source,
      handles: [],
      registryPath,
      secretRefs: [`store:${secretKey}`],
      next: 'Use secretRef store:venice.api_key on an approved Venice member in routes.secure_local.pool. Secure answers use that configured pool; E2EE model ids remain gated pending local key handling.',
    };
  }

  const source: 'readwise' | 'notion' = options.source;
  return withConnectedHandleGrantCustody(registryPath, { expectedEpoch: grantEpoch! }, async () => {
    const handle = `${source}.${accountRole}`;
    const provider = source;
    assertOneConnectedAccountForProposedProviders(registryPath, [{ handle, provider }]);
    await secretStore.set(secretKey, key);
    if (source === 'readwise') {
      upsertConnectedHandle({
        handle,
        provider: 'readwise',
        accountRole,
        trustDomain: 'internal',
        allowedCapabilities: ['readwise.sync'],
        scopes: ['readwise.export:read', 'readwise.reader:read'],
        tokenSecretRefs: [`store:${secretKey}`],
        connectedAt: now().toISOString(),
      }, registryPath);
      return { ok: true, source, handles: [handle], registryPath, secretRefs: [`store:${secretKey}`] };
    }
    upsertConnectedHandle({
      handle,
      provider: 'notion',
      accountRole,
      trustDomain: 'internal',
      allowedCapabilities: ['domain_expert.notion_import'],
      scopes: ['notion.pages:read', 'notion.databases:read', 'notion.blocks:read'],
      tokenSecretRefs: [`store:${secretKey}`],
      connectedAt: now().toISOString(),
    }, registryPath);
    return {
      ok: true,
      source,
      handles: [handle],
      registryPath,
      secretRefs: [`store:${secretKey}`],
      next: 'Wire the domain-expert worker with OLYMPUS_DOMAIN_EXPERT_NOTION_TOKEN from store:notion.<account-role>.integration_token before running notion_import. Share each target page or database with the Notion integration first.',
    };
  });
}

async function validateApiKeySource(options: {
  source: 'venice' | 'readwise' | 'notion';
  apiKey: string;
  fetchImpl: OAuthFetch;
  readwiseAuthUrl?: string;
  veniceModelsUrl?: string;
  notionBaseUrl?: string;
  notionVersion?: string;
  timeoutMs: number;
}): Promise<void> {
  if (options.source === 'readwise') {
    const url = options.readwiseAuthUrl
      ?? process.env.OLYMPUS_CONNECT_READWISE_AUTH_URL
      ?? 'https://readwise.io/api/v2/auth/';
    let response: Response;
    try {
      response = await fetchWithTimeout(options.fetchImpl, url, {
        method: 'GET',
        headers: {
          Authorization: `Token ${options.apiKey}`,
          Accept: 'application/json',
        },
      }, options.timeoutMs);
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error('Readwise token validation timed out. No credentials were stored; try again when Readwise is reachable.');
      }
      throw new Error('Could not validate the Readwise token. No credentials were stored; try again when Readwise is reachable.');
    }
    if (response.status !== 204) {
      throw new Error('Readwise rejected the API token. Paste a current Readwise access token and try again.');
    }
    return;
  }

  if (options.source === 'notion') {
    const baseUrl = options.notionBaseUrl
      ?? process.env.OLYMPUS_CONNECT_NOTION_BASE_URL
      ?? 'https://api.notion.com/v1';
    const version = options.notionVersion
      ?? process.env.OLYMPUS_CONNECT_NOTION_VERSION
      ?? '2022-06-28';
    const url = new URL('/v1/users/me', normalizeNotionBaseUrl(baseUrl)).toString();
    let response: Response;
    try {
      response = await fetchWithTimeout(options.fetchImpl, url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Notion-Version': version,
          Accept: 'application/json',
        },
      }, options.timeoutMs);
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error('Notion integration token validation timed out. No credentials were stored; try again when Notion is reachable.');
      }
      throw new Error('Could not validate the Notion integration token. No credentials were stored; try again when Notion is reachable.');
    }
    if (!response.ok) {
      throw new Error('Notion rejected the integration token. Paste a current Notion internal integration token and try again.');
    }
    return;
  }

  const url = options.veniceModelsUrl
    ?? process.env.OLYMPUS_CONNECT_VENICE_MODELS_URL
    ?? 'https://api.venice.ai/api/v1/models';
  let response: Response;
  try {
    response = await fetchWithTimeout(options.fetchImpl, url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: 'application/json',
      },
    }, options.timeoutMs);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('Venice API key validation timed out. No credentials were stored; try again when Venice is reachable.');
    }
    throw new Error('Could not validate the Venice API key. No credentials were stored; try again when Venice is reachable.');
  }
  if (!response.ok) {
    throw new Error('Venice rejected the API key. Paste a current Venice API key and try again.');
  }
}

function normalizeNotionBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://api.notion.com';
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

async function fetchXUserId(options: {
  tokenUrl: string;
  accessToken: string;
  fetchImpl: OAuthFetch;
  timeoutMs: number;
}): Promise<string> {
  const userUrl = new URL('/2/users/me', options.tokenUrl).toString();
  let response: Response;
  try {
    response = await fetchWithTimeout(options.fetchImpl, userUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        Accept: 'application/json',
      },
    }, options.timeoutMs);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('X user lookup timed out. No credentials were stored; re-run connect when X is reachable.');
    }
    throw new Error('Could not read your X user id. No credentials were stored; re-run connect when X is reachable.');
  }
  if (!response.ok) {
    throw new Error('X did not confirm the connected user id. No credentials were stored; re-run connect and ensure users.read is approved.');
  }
  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    throw new Error('X user lookup returned invalid JSON. No credentials were stored; re-run connect when X is reachable.');
  }
  const data = payload.data;
  const id = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>).id
    : undefined;
  if (typeof id !== 'string' || !/^\d+$/.test(id.trim())) {
    throw new Error('X user lookup did not return a numeric user id. No credentials were stored; re-run connect when X is reachable.');
  }
  return id.trim();
}

export async function connectGuidedSession(options: {
  source: 'telegram' | 'whatsapp';
  sessionPath: string;
  accountRole?: string;
  registryPath?: string;
  secretStore?: SecretStore;
  now?: () => Date;
  sessionReady?: boolean;
  /**
   * The latch clear, injectable for fault injection.
   *
   * The atomic writer renames and then fsyncs the directory, so this call can
   * reject AFTER the record is already replaced — the one failure that leaves
   * the latch gone and the rollback obliged to put it back. That ordering
   * cannot be produced from outside: the clear and the handle publish share a
   * directory, so any filesystem fault that reaches one reaches the other and
   * the rollback with it. Production leaves this undefined.
   */
  clearUnpairedSource?: (sourceId: string, registryPath: string) => void;
}): Promise<ConnectResult> {
  const accountRole = safeAccountRole(options.accountRole ?? (options.source === 'telegram' ? 'personal' : 'personal_local'));
  const sessionPath = options.sessionPath.trim();
  if (!sessionPath) throw new Error('Session path is required.');
  const secretStore = options.secretStore ?? createDefaultSecretStore();
  const registryPath = options.registryPath ?? defaultHandleRegistryPath();
  const grantEpoch = readConnectedHandleGrantEpoch(registryPath);
  const now = options.now ?? (() => new Date());
  const key = `${options.source}.${accountRole}.session_path`;
  const handle = options.source === 'telegram' ? 'telegram.personal' : 'whatsapp.personal_local';
  const provider = options.source === 'telegram' ? 'telegram' as const : 'whatsapp_personal' as const;
  const clearLatch = options.clearUnpairedSource ?? clearUnpairedSource;
  const unpairedSourceId = options.source === 'telegram'
    ? 'telegram.messages'
    : 'whatsapp.personal.messages';
  // Checked before the custody lease is even taken. Whatever makes the record
  // unreadable — a permission on the file, or on the directory holding it — is
  // usually the same thing that would make the lease fail a moment later with a
  // bare EACCES on a lock file, which tells the owner nothing about what is
  // actually wrong. The authoritative check still runs inside the lease below.
  assertUnpairedSourcesReadable(registryPath);
  return withConnectedHandleGrantCustody(registryPath, { expectedEpoch: grantEpoch }, async () => {
    assertOneConnectedAccountForProposedProviders(registryPath, [{ handle, provider }]);
    // Checked BEFORE anything is written. This connect may have to clear the
    // dashboard's unpaired record, and a record that cannot be read cannot be
    // safely rewritten — merging into it would discard whatever it held. A
    // refusal here costs a retry; a refusal after the handle was registered
    // would leave a pairing whose durable state nobody could reconcile.
    assertUnpairedSourcesReadable(registryPath);
    // Captured BEFORE anything is published, so the publish can be undone.
    // Registering the pairing and dropping the unpaired latch are one operation
    // as far as the owner is concerned, but they are two writes, and the second
    // one can fail (ENOSPC, EIO, a permission change) after the first has
    // landed. That left connect reporting failure while a ready handle stood in
    // the registry: adoption could activate the lane off it, and the durable
    // latch went on rendering the card unpaired. Nothing here is allowed to end
    // in that state — either both writes stand, or neither does.
    const priorHandle = readConnectedHandleRegistry(registryPath).handles
      .find((candidate) => candidate.handle === handle);
    const priorSessionPath = await secretStore.get(key);
    // The exact record as it stands, so the latch clear is undoable too. The
    // atomic writer renames and then fsyncs the directory, so a failure can be
    // reported AFTER the new contents are already in place: every published
    // thing here has to be restorable from a snapshot rather than inferred from
    // whether its call threw.
    const priorUnpaired = readUnpairedSources(registryPath);
    // EVERY write lives inside this boundary, the secret included. Left
    // outside, a post-rename failure rejected after the new session path was
    // already on disk, and a re-pair's existing ready handle then resolved that
    // new path while the old latch still stood.
    try {
    await secretStore.set(key, sessionPath);
    const connectedAt = now().toISOString();
    const registryHandle: ConnectedCredentialHandle = options.source === 'telegram'
      ? {
        handle,
        provider: 'telegram',
        sessionKind: 'mtproto_session',
        accountRole,
        trustDomain: 'secure_local',
        allowedCapabilities: ['telegram.messages.sync'],
        scopes: [],
        tokenSecretRefs: [`store:${key}`],
        backendState: {
          kind: 'mtproto_session',
          status: options.sessionReady ? 'available' : 'reauth_required',
          mtprotoProfileId: 'telegram_personal',
          runtimeEndpointId: 'telegram_local_telethon_reader',
          library: 'telethon',
          backendLabel: 'local_private:telegram_telethon_reader',
        },
        connectedAt,
      }
      : {
        handle,
        provider: 'whatsapp_personal',
        sessionKind: 'local_app_database',
        accountRole,
        trustDomain: 'secure_local',
        allowedCapabilities: ['whatsapp.personal.messages.sync'],
        scopes: [],
        tokenSecretRefs: [`store:${key}`],
        backendState: {
          kind: 'local_app_database',
          status: options.sessionReady ? 'available' : 'reauth_required',
          databaseSourceId: 'whatsapp_personal_local',
          readerWorker: 'whatsapp_local_reader',
          databaseRole: 'messages_readonly',
          scopeLabel: 'personal_messages',
          backendLabel: 'local_private:whatsapp_local_app_reader',
        },
        connectedAt,
      };
    upsertConnectedHandle(registryHandle, registryPath);
    // The dashboard's Unpair latch is the memory that the owner tore the
    // previous pairing down. It is dropped HERE — inside the same grant-custody
    // lease that just wrote the handle — and never from a page render, which
    // could otherwise race an Unpair and erase the fact it had just committed.
    //
    // Only a READY session clears it. A connect without `--session-ready`
    // registers a handle that is still `reauth_required`: there is no usable
    // session behind it, and clearing on that would have the durable record
    // saying paired while the live worker — which drops the fact only once a
    // non-reauth handle exists — still said unpaired, so the card changed
    // meaning across a restart. This connect is now the ONLY thing that clears
    // the record: the dashboard no longer drops a record just because a usable
    // handle exists, because that let a failed teardown's leftover handle
    // suppress the fact that the session on disk was already gone.
    if (registryHandle.backendState?.status !== 'reauth_required') {
      clearLatch(unpairedSourceId, registryPath);
    }
    return {
      ok: true,
      source: options.source,
      handles: [handle],
      registryPath,
      secretRefs: [`store:${key}`],
      next: options.source === 'telegram'
        ? 'Run the Telethon login helper for this session path if status is reauth_required.'
        : 'Run the whatsmeow QR pairing helper for this session path if status is reauth_required.',
    };
    } catch (publishError) {
      await rollbackGuidedSessionPublish({
        registryPath,
        secretStore,
        key,
        handle,
        priorHandle,
        priorSessionPath,
        priorUnpaired,
        unpairedSourceId,
        cause: publishError,
      });
      throw publishError;
    }
  });
}

/**
 * Undo a guided-session publish whose latch clear failed.
 *
 * The publish is the reversible half: the handle and the stored session path
 * are both restorable to exactly what they were, and putting them back is what
 * stops a failed connect from leaving a live pairing behind. Restoring rather
 * than deleting matters — this connect may have overwritten an EXISTING handle,
 * and removing it would turn a failed re-pair into a silent disconnect.
 *
 * If the rollback itself cannot complete, the durable record is the last place
 * left to be honest: an explicit incomplete state with a named failed step, so
 * the card says work is outstanding instead of quietly claiming a session. That
 * write can fail too — it is usually the same file that just refused — and then
 * the thrown error is all that is left, which is why it names the repair.
 */
async function rollbackGuidedSessionPublish(input: {
  registryPath: string;
  secretStore: SecretStore;
  key: string;
  handle: string;
  priorHandle: ConnectedCredentialHandle | undefined;
  priorSessionPath: string | undefined;
  priorUnpaired: UnpairedSourcesRead;
  unpairedSourceId: string;
  cause: unknown;
}): Promise<void> {
  // Each restore is attempted on its own. Chained in one try, the first failure
  // skipped the rest — so a secret that would not restore also cost the latch
  // its restore, and the record was then overwritten with a bare generic step
  // that discarded the paths a previous Unpair was still owed.
  const failedSteps: string[] = [];
  const errors: string[] = [];
  const attempt = async (step: string, work: () => Promise<void> | void): Promise<void> => {
    try {
      await work();
    } catch (error) {
      failedSteps.push(step);
      errors.push(`${step}: ${(error as Error).message}`);
    }
  };
  await attempt('connect_rollback_handle', () => {
    if (input.priorHandle) upsertConnectedHandle(input.priorHandle, input.registryPath);
    else removeConnectedHandles([input.handle], input.registryPath);
  });
  await attempt('connect_rollback_secret', async () => {
    if (input.priorSessionPath === undefined) await input.secretStore.delete(input.key);
    else await input.secretStore.set(input.key, input.priorSessionPath);
  });
  // The latch too. Restoring the handle and the secret while leaving a cleared
  // latch behind is the worst of the three: the pairing is gone and nothing
  // says so, so the card goes back to reading its unchanged sync evidence as a
  // live session.
  await attempt('connect_rollback_latch', () => {
    restorePriorUnpairedRecord(input.priorUnpaired, input.registryPath);
  });
  if (failedSteps.length === 0) return;
  // What this connect could not undo, recorded ON TOP of what the source was
  // already owed. Writing only the generic step would have dropped the prior
  // entry's outstanding paths, and a later Unpair could then discharge the
  // generic step without ever seeing the artifact still sitting there.
  const prior = input.priorUnpaired.status === 'ok'
    ? input.priorUnpaired.records.find((record) => record.source_id === input.unpairedSourceId)
    : undefined;
  try {
    recordUnpairedSources(
      [{
        source_id: input.unpairedSourceId,
        state: 'unpair_incomplete',
        ...(prior?.unremoved_paths ? { unremoved_paths: prior.unremoved_paths } : {}),
        failed_steps: [...(prior?.failed_steps ?? []), ...failedSteps],
      }],
      input.registryPath,
    );
  } catch {
    // The record is one of the things that just refused; nothing left to write.
  }
  throw new Error(
    `Connect could not finish and could not undo itself: ${(input.cause as Error).message}. `
    + `Rollback also failed: ${errors.join('; ')}. `
    + `Remove the ${input.handle} handle with the CLI and retry.`,
  );
}

/**
 * Put the unpaired record back exactly as it was before this connect.
 *
 * `missing` is restored as missing, not as an empty record: a file that did not
 * exist is a different fact from one that says nothing is unpaired, and the
 * reader keeps them apart.
 */
function restorePriorUnpairedRecord(prior: UnpairedSourcesRead, registryPath: string): void {
  if (prior.status === 'ok') {
    writeUnpairedSources(prior.records, registryPath);
    return;
  }
  if (prior.status === 'missing') rmSync(unpairedSourcesPath(registryPath), { force: true });
}

export async function readApiKeyFromStdin(stdin: AsyncIterable<Buffer | string> = processStdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * The origin an authorization URL for this source must sit on. The start
 * boundary is injectable and its URL is one a browser will follow, so the
 * worker validates against this closed table before relaying (R61E).
 */
export function oauthAuthorizeOrigin(source: ConnectOAuthOptions['source']): string {
  return new URL(oauthSourceDefinition(source).authUrl).origin;
}

function oauthSourceDefinition(source: ConnectOAuthOptions['source']): OAuthSourceDefinition {
  if (source === 'dropbox') {
    return {
      authUrl: 'https://www.dropbox.com/oauth2/authorize',
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      scopes: ['files.metadata.read', 'files.content.read', 'sharing.read'],
      handles: [{
        handle: (role: string) => role === 'personal' ? 'dropbox.personal' : `dropbox.${role}`,
        provider: 'dropbox',
        capability: 'dropbox.files.sync',
        trustDomain: 'secure_local',
        scopes: ['files.metadata.read', 'files.content.read', 'sharing.read'],
      }],
    };
  }
  if (source === 'x') {
    return {
      authUrl: 'https://x.com/i/oauth2/authorize',
      tokenUrl: 'https://api.x.com/2/oauth2/token',
      scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
      handles: [{
        handle: (role: string) => role === 'personal' ? 'x.bookmarks.personal' : `x.bookmarks.${role}`,
        provider: 'x',
        capability: 'x.bookmarks.sync',
        trustDomain: 'internal',
        scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
      }],
    };
  }
  const gmail = {
    handle: (role: string) => role === 'personal' ? 'gmail.personal' : `gmail.${role}`,
    provider: 'gmail' as const,
    capability: 'gmail.email.sync',
    trustDomain: 'secure_local' as const,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  };
  const drive = {
    handle: (role: string) => role === 'personal' ? 'google_drive.personal' : `google_drive.${role}`,
    provider: 'google_drive' as const,
    capability: 'google_drive.docs.sync',
    trustDomain: 'internal' as const,
    // drive.readonly only: the Drive connectors read document text through the
    // Drive export endpoint (files/{id}/export), never the Docs API, so
    // documents.readonly was consented to and never exercised.
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  };
  return {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: source === 'gmail'
      ? gmail.scopes
      : source === 'google-drive'
        ? drive.scopes
        : [...gmail.scopes, ...drive.scopes],
    handles: source === 'gmail'
      ? [gmail]
      : source === 'google-drive'
        ? [drive]
        : [gmail, drive],
  };
}

function buildAuthorizationUrl(options: {
  source: ConnectOAuthOptions['source'];
  authUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
}): string {
  const url = new URL(options.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', options.scopes.join(' '));
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (isGoogleOAuthSource(options.source)) {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  }
  if (options.source === 'dropbox') {
    url.searchParams.set('token_access_type', 'offline');
  }
  return url.toString();
}

async function createLoopbackCallbackServer(options: { state: string; port?: number }): Promise<{
  port: number;
  server: Server;
  waitForCode: Promise<string>;
}> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (url.pathname !== '/oauth/callback') {
        response.writeHead(404).end('Not found');
        return;
      }
      if (url.searchParams.get('state') !== options.state) {
        response.writeHead(400).end('OAuth state mismatch.');
        rejectCode(new Error('OAuth state mismatch.'));
        return;
      }
      const code = url.searchParams.get('code')?.trim();
      if (!code) {
        response.writeHead(400).end('OAuth code missing.');
        rejectCode(new Error('OAuth code missing.'));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('Olympus connection complete. You can close this browser tab.');
      resolveCode(code);
    } catch {
      response.writeHead(400).end('OAuth callback failed.');
      rejectCode(new Error('OAuth callback failed.'));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('OAuth loopback server did not bind.');
  return { port: address.port, server, waitForCode };
}

async function exchangeAuthorizationCode(options: {
  source: ConnectOAuthOptions['source'];
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  verifier: string;
  fetchImpl: OAuthFetch;
  timeoutMs: number;
  /** The CSRF `state` this flow's authorization request carried, forwarded
   * as an opaque passthrough to the publisher exchange endpoint only —
   * `googlePublisherExchangeUrl()` accepts it purely for shape validation and
   * never verifies or acts on it (`docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md`,
   * "Why state verification is not possible here"). Unused on every other
   * path. */
  state?: string;
}): Promise<{ accessToken: string; refreshToken?: string; expiresInSeconds?: number; scopes: string[] }> {
  // Google's publisher **Web** client is a confidential client whose token
  // endpoint requires `client_secret`, which Olympus — public source — cannot
  // ship. That leg is delegated to a small publisher-run Cloudflare Worker
  // that holds the secret instead and is never sent one itself
  // (`docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md`). Every other path — the packaged
  // Google Desktop pilot client, a bring-your-own Google client, Dropbox, X —
  // is unaffected and still exchanges directly with the provider below.
  const usesGooglePublisherExchange = isGooglePublisherExchangeClient(options.source, options.clientId);
  const url = usesGooglePublisherExchange ? googlePublisherExchangeUrl() : options.tokenUrl;
  const init: RequestInit = usesGooglePublisherExchange
    ? {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      // No `client_secret` field: this endpoint holds the secret itself and
      // never accepts one from a caller (it would have nowhere honest to
      // put it — the Worker's own secret is the only one Google will
      // accept).
      body: JSON.stringify({
        code: options.code,
        code_verifier: options.verifier,
        redirect_uri: options.redirectUri,
        ...(options.state ? { state: options.state } : {}),
      }),
    }
    : directTokenExchangeRequest(options);
  let response: Response;
  let text: string;
  try {
    // Headers AND body under one deadline, with a byte cap: the timeout used
    // to end the moment the status line arrived, so a peer that answered and
    // then dribbled its body held connect open past the timeout it was given
    // (Codex round 1 on 5cb644b9). A token response is a few hundred bytes.
    ({ response, text } = await fetchBoundedText(options.fetchImpl, url, init, {
      timeoutMs: options.timeoutMs,
      limitBytes: OAUTH_TOKEN_RESPONSE_LIMIT_BYTES,
    }));
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`OAuth token exchange timed out after ${formatDurationMs(options.timeoutMs)}. No credentials were stored; re-run connect when the provider is reachable.`);
    }
    if (isBoundedResponseTooLargeError(error)) {
      // Nothing of the body is repeated: an oversized answer is exactly the
      // kind that might be an error page, a proxy interstitial, or an attempt
      // to make this process buffer something.
      throw new Error('OAuth token exchange returned an oversized response. No credentials were stored; re-run connect when the provider is reachable.');
    }
    throw error;
  }
  // The exchange endpoint forwards Google's own success and error shapes
  // unchanged (`docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md`, "API"), and its own
  // refusals (rate limit, bad request, timeout, upstream failure) are the same
  // `{error, error_description?}`-shaped JSON with a real HTTP status, so
  // nothing below needs to know which branch produced `response`.
  if (!response.ok) {
    // Provider error bodies are echo chambers: a provider may reflect request
    // material — credential values included — into error_description, and no
    // shape- or value-based redaction can enumerate every encoding it might
    // arrive in (R61/R61B, reproduced live against X). Only the structured
    // error code survives, and only when it is a code this module knows.
    const errorCode = safeOAuthErrorCode(oauthErrorCodeFromBody(text));
    throw new Error(`OAuth token exchange failed with status ${response.status}${errorCode ? ` (${errorCode})` : ''}.`);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('OAuth token exchange returned invalid JSON.');
  }
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
  if (!accessToken) throw new Error('OAuth token exchange did not return an access token.');
  return {
    accessToken,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
      ? { refreshToken: payload.refresh_token.trim() }
      : {}),
    ...(typeof payload.expires_in === 'number' ? { expiresInSeconds: payload.expires_in } : {}),
    scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [],
  };
}

/** A token response is a small JSON object on every provider Olympus talks to. */
const OAUTH_TOKEN_RESPONSE_LIMIT_BYTES = 64 * 1024;

/** Today's direct-to-provider exchange: form-encoded, unchanged. */
function directTokenExchangeRequest(options: {
  source: ConnectOAuthOptions['source'];
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): RequestInit {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', options.code);
  body.set('redirect_uri', options.redirectUri);
  body.set('code_verifier', options.verifier);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (options.source === 'x' && options.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', options.clientId);
    if (isGoogleOAuthSource(options.source) && options.clientSecret) body.set('client_secret', options.clientSecret);
  }
  return { method: 'POST', headers, body };
}

function isGoogleOAuthSource(source: ConnectOAuthOptions['source']): boolean {
  return source === 'google' || source === 'gmail' || source === 'google-drive';
}

/**
 * Whether this flow's client id is Olympus's own publisher **Web**
 * application client — the only Google client whose token exchange and
 * refresh go through the publisher exchange endpoint rather than straight to
 * Google. The packaged Desktop pilot client and a bring-your-own client both
 * exchange directly with Google and never match this.
 *
 * Matches any id in the append-only published set, not just the current
 * default (`isGooglePublisherWebClientId`): a web client Olympus published
 * under an earlier rotation still has its secret only in the exchange
 * endpoint, so it must still route there.
 */
function isGooglePublisherExchangeClient(source: ConnectOAuthOptions['source'], clientId: string): boolean {
  return isGoogleOAuthSource(source) && isGooglePublisherWebClientId(clientId);
}

function shouldStoreOAuthClientSecret(source: ConnectOAuthOptions['source']): boolean {
  return isGoogleOAuthSource(source) || source === 'x';
}

/** The RFC 6749/8628 error codes this module will repeat. Nothing else is. */
const KNOWN_OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
  'slow_down',
  'expired_token',
  // Not an RFC 6749 code, but the exact word every provider console uses for
  // the failure this dashboard now names on the card, and the one a provider
  // may hand back on the redirect. A fixed literal like every other member of
  // this set: still no provider text is ever repeated.
  'redirect_uri_mismatch',
]);

/**
 * A provider-supplied error code, repeated only if it is one of the known
 * OAuth codes. Provider text is never trusted into any message, page, or log:
 * the allowlist is the entire vocabulary this side will speak for a provider.
 */
export function safeOAuthErrorCode(value: string | undefined): string | undefined {
  const code = value?.trim().toLowerCase();
  return code && KNOWN_OAUTH_ERROR_CODES.has(code) ? code : undefined;
}

/** The `error` member of a JSON error body, or nothing at all. */
function oauthErrorCodeFromBody(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return typeof parsed.error === 'string' ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

export function defaultDetachedOAuthStateDir(): string {
  return join(homedir(), '.olympus', 'pending-oauth');
}

export function defaultDetachedOAuthLogDir(): string {
  return join(homedir(), '.olympus', 'logs');
}

export function detachedOAuthStatePath(options: {
  stateDir?: string;
  source: ConnectOAuthOptions['source'];
  accountRole?: string;
}): string {
  return join(
    options.stateDir ?? defaultDetachedOAuthStateDir(),
    `${safeStatePathSegment(options.source)}.${safeStatePathSegment(safeAccountRole(options.accountRole ?? 'personal'))}.json`,
  );
}

export function writeDetachedOAuthState(path: string, state: DetachedOAuthState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateJson(path, sanitizeDetachedOAuthState(state));
}

export function readDetachedOAuthState(path: string): DetachedOAuthState | undefined {
  try {
    return sanitizeDetachedOAuthState(JSON.parse(readFileSync(path, 'utf8')) as DetachedOAuthState);
  } catch {
    return undefined;
  }
}

export function listDetachedOAuthStates(options: {
  stateDir?: string;
  source?: ConnectOAuthOptions['source'];
  pidAlive?: (pid: number) => boolean;
} = {}): DetachedOAuthState[] {
  const stateDir = options.stateDir ?? defaultDetachedOAuthStateDir();
  const entries = (() => {
    try {
      return Array.from(new Bun.Glob('*.json').scanSync({ cwd: stateDir, absolute: true }));
    } catch {
      return [];
    }
  })();
  return entries
    .map((path) => readDetachedOAuthState(path))
    .filter((state): state is DetachedOAuthState => !!state)
    .filter((state) => !options.source || state.source === options.source)
    .map((state) => withDiedStatus(state, options.pidAlive ?? isPidAlive));
}

function withDiedStatus(state: DetachedOAuthState, pidAlive: (pid: number) => boolean): DetachedOAuthState {
  if (state.status !== 'pending' || !state.pid) return state;
  if (pidAlive(state.pid)) return state;
  return {
    ...state,
    status: 'died',
    reason: `Detached OAuth child process ${state.pid} is no longer running.`,
  };
}

function cleanupTerminalDetachedOAuthState(statePath: string): void {
  const state = readDetachedOAuthState(statePath);
  if (!state) return;
  if (state.status === 'connected' || state.status === 'failed' || state.status === 'expired' || state.status === 'died') {
    rmSync(statePath, { force: true });
  }
}

async function waitForDetachedPendingState(options: {
  statePath: string;
  source: ConnectOAuthOptions['source'];
  accountRole: string;
  pid: number;
  logPath: string;
  timeoutMs: number;
}): Promise<DetachedOAuthState> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const state = readDetachedOAuthState(options.statePath);
    if (state?.status === 'pending' && state.authorizationUrl) return state;
    if (state && state.status !== 'pending') return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return {
    source: options.source,
    accountRole: options.accountRole,
    status: 'failed',
    startedAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    pid: options.pid,
    logPath: options.logPath,
    reason: 'Detached OAuth child did not publish a pending state before the parent wait deadline.',
  };
}

function readDetachedOAuthRequestFile(path: string): DetachedOAuthRequestFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DetachedOAuthRequestFile>;
  if (!parsed.source || !isOAuthSource(parsed.source)) throw new Error('Detached OAuth request has an invalid source.');
  if (!parsed.clientId?.trim()) throw new Error('Detached OAuth request is missing clientId.');
  if (!parsed.statePath?.trim()) throw new Error('Detached OAuth request is missing statePath.');
  if (!parsed.logPath?.trim()) throw new Error('Detached OAuth request is missing logPath.');
  if (
    parsed.grantEpoch !== 'initial'
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.grantEpoch ?? '')
  ) {
    throw new Error('Detached OAuth request is missing a valid credential-grant generation.');
  }
  return {
    source: parsed.source,
    clientId: parsed.clientId,
    ...(parsed.clientSecret ? { clientSecret: parsed.clientSecret } : {}),
    ...(parsed.accountRole ? { accountRole: parsed.accountRole } : {}),
    ...(parsed.authUrl ? { authUrl: parsed.authUrl } : {}),
    ...(parsed.tokenUrl ? { tokenUrl: parsed.tokenUrl } : {}),
    ...(parsed.redirectPort !== undefined ? { redirectPort: parsed.redirectPort } : {}),
    ...(parsed.openBrowser !== undefined ? { openBrowser: parsed.openBrowser } : {}),
    ...(parsed.registryPath ? { registryPath: parsed.registryPath } : {}),
    ...(parsed.grantEpoch ? { grantEpoch: parsed.grantEpoch } : {}),
    ...(parsed.secretStoreBackend ? { secretStoreBackend: parsed.secretStoreBackend } : {}),
    ...(parsed.secretStorePath ? { secretStorePath: parsed.secretStorePath } : {}),
    ...(parsed.secretStoreKeyPath ? { secretStoreKeyPath: parsed.secretStoreKeyPath } : {}),
    ...(parsed.authorizationTimeoutMs !== undefined ? { authorizationTimeoutMs: parsed.authorizationTimeoutMs } : {}),
    ...(parsed.tokenExchangeTimeoutMs !== undefined ? { tokenExchangeTimeoutMs: parsed.tokenExchangeTimeoutMs } : {}),
    statePath: parsed.statePath,
    logPath: parsed.logPath,
  };
}

function sanitizeDetachedOAuthState(input: DetachedOAuthState): DetachedOAuthState {
  const state: DetachedOAuthState = {
    source: input.source,
    accountRole: input.accountRole,
    status: input.status,
    startedAt: input.startedAt,
    expiresAt: input.expiresAt,
    ...(input.authorizationUrl ? { authorizationUrl: input.authorizationUrl } : {}),
    ...(input.redirectUri ? { redirectUri: input.redirectUri } : {}),
    ...(typeof input.port === 'number' ? { port: input.port } : {}),
    ...(typeof input.pid === 'number' ? { pid: input.pid } : {}),
    ...(input.logPath ? { logPath: input.logPath } : {}),
    ...(input.handles ? { handles: [...input.handles] } : {}),
    ...(input.handleId ? { handleId: input.handleId } : {}),
    ...(input.registryPath ? { registryPath: input.registryPath } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.errorCode && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(input.errorCode)
      ? { errorCode: input.errorCode }
      : {}),
    ...(input.retryable === true ? { retryable: true } : {}),
    ...(input.retryAt && Number.isFinite(Date.parse(input.retryAt)) ? { retryAt: input.retryAt } : {}),
  };
  return state;
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function safeStatePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isOAuthAuthorizationTimeout(reason: string): boolean {
  return reason.includes('OAuth authorization timed out');
}

function isOAuthSource(source: unknown): source is ConnectOAuthOptions['source'] {
  return source === 'google' || source === 'gmail' || source === 'google-drive' || source === 'dropbox' || source === 'x';
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.once('error', (error) => {
    console.warn(`[olympus] WARNING: could not open the authorization URL automatically: ${error.message}`);
    console.warn(`[olympus] Open this authorization URL manually: ${url}`);
  });
  child.unref();
}

function safeAccountRole(value: string): string {
  const trimmed = value.trim();
  if (!isSafeSecretKey(trimmed)) throw new Error('Account role must be a safe label.');
  return trimmed;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function isStoreSecretRef(ref: string): boolean {
  const parsed = normalizeSecretRef(ref);
  return parsed?.kind === 'store';
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryableErrorDisposition(
  error: unknown,
  now: Date,
): { code: string; retryAt: string } | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; retryable?: unknown; retryAfterMs?: unknown };
  if (
    typeof candidate.code !== 'string'
    || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(candidate.code)
    || candidate.retryable !== true
    || typeof candidate.retryAfterMs !== 'number'
    || !Number.isSafeInteger(candidate.retryAfterMs)
    || candidate.retryAfterMs <= 0
  ) return undefined;
  return {
    code: candidate.code,
    retryAt: new Date(now.getTime() + candidate.retryAfterMs).toISOString(),
  };
}
