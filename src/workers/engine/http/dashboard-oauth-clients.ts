import { readGoogleOwnAppRegistration } from '../../../core/google-own-app.ts';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_RUNTIME_BUILD } from '../../../core/build-flavor.ts';
import { isRetiredGooglePilotClientId, packagedGooglePilotClientId } from '../../../core/google-pilot-client.ts';
import {
  googlePublisherWebClientId,
  googleDesktopClient,
  dropboxPublisherAppKey,
} from '../../../core/publisher-oauth-client.ts';
import { oauthRelayUrl } from '../../../core/oauth-relay.ts';
import { type SecretStore, normalizeSecretRef } from '../../../core/secret-store.ts';
import type { DashboardOAuthSource, DashboardApiKeySource } from '../../source-dashboard.ts';
import type { ConnectedHandleRegistry } from '../../credential-broker/connected-handles.ts';

export function dashboardGoogleCloudProjectId(): string | undefined {
  try {
    const raw = readFileSync(join(homedir(), '.olympus', 'google-bootstrap.json'), 'utf8');
    const parsed = JSON.parse(raw) as { projectId?: unknown };
    if (typeof parsed.projectId !== 'string') return undefined;
    const projectId = parsed.projectId.trim();
    return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ? projectId : undefined;
  } catch {
    return undefined;
  }
}

async function dashboardOAuthClientIds(
  registry: ConnectedHandleRegistry,
  secretStore: SecretStore,
): Promise<Partial<Record<DashboardOAuthSource | 'google', string>>> {
  return (await dashboardOAuthClientIdSets(registry, secretStore)).all;
}

/**
 * The two client-id maps this worker reasons over, from ONE pass across the
 * store and the registry.
 *
 * `own` is what this install registered for itself: pasted into the dashboard,
 * or already bound to a connected handle. `all` is `own` plus the packaged
 * Google pilot client, which is a publisher identity rather than the owner's.
 *
 * Keeping them apart is what lets publisher mode exist: "does this source have
 * a client id at all" and "did the OWNER register one" are different questions,
 * and answering the second with the first would hide every publisher-owned
 * source behind a bring-your-own walkthrough it does not need.
 */
export async function dashboardOAuthClientIdSets(
  registry: ConnectedHandleRegistry,
  secretStore: SecretStore,
): Promise<{
  own: Partial<Record<DashboardOAuthSource | 'google', string>>;
  all: Partial<Record<DashboardOAuthSource | 'google', string>>;
}> {
  const own: Partial<Record<DashboardOAuthSource | 'google', string>> = {};
  await readConfiguredDashboardOAuthClientIds(own, secretStore);
  for (const handle of registry.handles) {
    const ref = handle.oauth2Refresh?.clientIdSecretRef;
    if (!ref) continue;
    const parsed = normalizeSecretRef(ref);
    if (parsed?.kind !== 'store') continue;
    const clientId = await secretStore.get(parsed.key);
    if (!clientId) continue;
    const family = handle.provider === 'gmail' ? 'gmail'
      : handle.provider === 'google_drive' ? 'google-drive'
      : handle.provider === 'dropbox' ? 'dropbox'
      : handle.provider === 'x' ? 'x'
      : undefined;
    // The provenance companion key rides on the SAME ref the handle already
    // carries, not on a hardcoded account role: `clientIdSecretRef` already
    // encodes whichever role this handle's flow actually used.
    if (family && await dashboardStoredClientIdIsPublisherOwned(family, clientId, parsed.key, secretStore)) continue;
    if (family === 'gmail') own.gmail = clientId;
    if (family === 'google-drive') own['google-drive'] = clientId;
    if (family === 'dropbox') own.dropbox = clientId;
    if (family === 'x') own.x = clientId;
    if (ref.startsWith('store:google.')
      && !(await dashboardStoredClientIdIsPublisherOwned('google', clientId, parsed.key, secretStore))) {
      own.google = clientId;
    }
  }
  const all = { ...own };
  const pilotClientId = dashboardGooglePilotClientId();
  if (!all.google && pilotClientId) all.google = pilotClientId;
  return { own, all };
}

async function readConfiguredDashboardOAuthClientIds(
  output: Partial<Record<DashboardOAuthSource | 'google', string>>,
  secretStore: SecretStore,
): Promise<void> {
  const sharedOwnAppId = (await readGoogleOwnAppRegistration(secretStore))?.clientId;
  if (sharedOwnAppId) output.google = sharedOwnAppId;
  const sources: Array<DashboardOAuthSource | 'google'> = ['google', 'gmail', 'google-drive', 'dropbox', 'x'];
  for (const source of sources) {
    const clientId = await secretStore.get(dashboardOAuthClientIdConfigKey(source));
    if (!clientId) continue;
    if (await dashboardStoredClientIdIsPublisherOwned(source, clientId, dashboardOAuthClientIdConfigKey(source), secretStore)) continue;
    if (source !== 'google' || !sharedOwnAppId) output[source] = clientId;
  }
}

/**
 * Whether a client id this install has on file belongs to Olympus's own
 * publisher app rather than something the owner registered.
 *
 * Checked in two ways, either sufficient on its own (MAJOR, Codex round 3 on
 * e75598f7):
 *
 * 1. **The provenance field.** `<client-id-key>_source` records `'publisher'`
 *    or `'byo'` at the moment a connection completes or a registration is
 *    submitted — the authoritative answer, because it is a fact about how
 *    THIS id reached the store, not a guess from its current value. It
 *    survives a publisher default rotation: an install marked `'publisher'`
 *    stays publisher-owned even once its stored id no longer matches
 *    whatever `DEFAULT_*_PUBLISHER_APP_KEY` says today.
 * 2. **The value-match fallback**, only when the field is absent (data
 *    written before this fix existed): a stored id identical to a CURRENT
 *    publisher identity is treated as publisher-owned even without the
 *    field, so an already-broken install self-heals without a migration
 *    step. This fallback stops working across a rotation, which is exactly
 *    why the field — not the value — is the real fix.
 */
async function dashboardStoredClientIdIsPublisherOwned(
  source: DashboardOAuthSource | 'google',
  clientId: string,
  clientIdKey: string,
  secretStore: SecretStore,
): Promise<boolean> {
  // The beta.11 Desktop pilot client is Olympus's, never the owner's, however
  // the id was stored. Its Google project is deleted (#765), so treating it as
  // the owner's app would offer a reconnect through a client that no longer
  // exists; as a publisher id, the card reconnects through the current one.
  if (dashboardGoogleOAuthSource(source) && isRetiredGooglePilotClientId(clientId)) return true;
  const provenance = await secretStore.get(dashboardOAuthClientIdSourceKeyFromClientIdKey(clientIdKey));
  if (provenance === 'publisher') return true;
  if (provenance === 'byo') return false;
  return dashboardCurrentPublisherClientIds(source).includes(clientId);
}

/** Every client id Olympus's own publisher apps currently use for a source. */
function dashboardCurrentPublisherClientIds(source: DashboardOAuthSource | 'google'): string[] {
  if (source === 'x') return [];
  if (dashboardGoogleOAuthSource(source)) {
    return [dashboardGooglePilotClientId(), googlePublisherWebClientId(), googleDesktopClient()?.clientId]
      .filter((id): id is string => Boolean(id));
  }
  const appKey = dropboxPublisherAppKey();
  return appKey ? [appKey] : [];
}

/** `<source>.<role>.oauth.client_id` → its provenance companion key. */
function dashboardOAuthClientIdSourceKeyFromClientIdKey(clientIdKey: string): string {
  return clientIdKey.replace(/\.oauth\.client_id$/, '.oauth.client_id_source');
}

/**
 * The publisher-owned app this source connects through, or `undefined` when the
 * owner has to bring their own.
 *
 * Owner direction (2026-09-03): one-click connect for Google and Dropbox through
 * publisher-owned OAuth apps and the static relay, for ANY dashboard origin,
 * with bring-your-own as the fallback and X unchanged. The rules, in order:
 *
 * - **X is never publisher-owned.** Its app is a confidential client whose
 *   secret cannot ship, and the relay is not involved (OAUTH_RELAY.md).
 * - **A registration the owner made wins.** Publisher mode is the default for an
 *   install that has registered nothing; it never overrides a client id the
 *   owner pasted or a connected handle already carries. "Registered" is read
 *   off `ownClientId`, which `dashboardOAuthClientIdSets` builds from
 *   PROVENANCE, not presence: a publisher-mode connect persists its client id
 *   under the identical store key a bring-your-own registration uses, so
 *   `own` excludes an id its `client_id_source` companion marks
 *   `'publisher'` (or, for data written before that field existed, an id
 *   that matches a CURRENT publisher key). Reading "is a client_id present"
 *   instead stuck a completed publisher connection in bring-your-own the
 *   moment it needed reauthentication (Codex round 3 on e75598f7).
 * - **Publisher Google signs in on this computer** (owner, 2026-10-13): the
 *   Desktop client, a loopback redirect to this engine, PKCE, and a direct
 *   token exchange with Google, so no Olympus server is in the token path.
 *   Until a Desktop client is configured it keeps the Web client, relay and
 *   publisher exchange it used before.
 * - **Publisher Dropbox also goes through the relay** with `redirect_uri` =
 *   the one registered relay URL and a signed state naming this dashboard's
 *   origin.
 *
 * The Dropbox default ships filled in (the owner's "Olympus-Plugin" app,
 * created 2026-09-03), as does the Google Web client default (the owner's
 * "Olympus Publisher" app in `core/publisher-oauth-client.ts`). If a future
 * publisher rotation leaves the Web identity unavailable, the dashboard shows
 * the bring-your-own path it shows today.
 */
interface DashboardPublisherOAuthFlow {
  clientId: string;
  /** The publisher relay, for a relay flow; a loopback flow builds its own from the dashboard origin. */
  redirectUri?: string;
  /** True when the redirect is the publisher relay and the state must be signed. */
  relay: boolean;
  /** True for Google's Desktop client: the provider returns to this engine on loopback. */
  loopback?: boolean;
}

export function dashboardPublisherOAuthFlow(
  source: DashboardOAuthSource,
  ownClientId: string | undefined,
): DashboardPublisherOAuthFlow | undefined {
  if (source === 'x') return undefined;
  if (ownClientId) return undefined;
  if (dashboardGoogleOAuthSource(source)) {
    const desktop = googleDesktopClient();
    if (desktop) return { clientId: desktop.clientId, relay: false, loopback: true };
    const webClientId = googlePublisherWebClientId();
    return webClientId ? { clientId: webClientId, redirectUri: oauthRelayUrl(), relay: true } : undefined;
  }
  const appKey = dropboxPublisherAppKey();
  return appKey ? { clientId: appKey, redirectUri: oauthRelayUrl(), relay: true } : undefined;
}

/** The sources whose card offers one-click Connect through a publisher app. */
export function dashboardPublisherOAuthSources(
  ownClientIds: Partial<Record<DashboardOAuthSource | 'google', string>>,
): DashboardOAuthSource[] {
  const sources: DashboardOAuthSource[] = ['gmail', 'google-drive', 'dropbox', 'x'];
  return sources.filter((source) => dashboardPublisherOAuthFlow(
    source,
    dashboardOAuthClientIdForSource(source, ownClientIds),
  ) !== undefined);
}

/**
 * Whether each card has a client secret on file for the client it would start
 * with.
 *
 * For Google the answer is per card and already paired: a secret counts only
 * when the exchange would actually send it, i.e. when
 * `dashboardGoogleOAuthClientSecret` finds it stored beside the very client id
 * this card starts with. Gmail and Drive can carry different bring-your-own
 * Web clients; reporting Gmail's secret on Drive's card made the field
 * optional, the saved-value stand-in was submitted, and the exchange then ran
 * without Drive's secret and failed after consent (Codex on #315).
 */
export async function dashboardOAuthClientSecretAvailability(
  secretStore: SecretStore,
  clientIds: Partial<Record<DashboardOAuthSource | 'google', string>>,
): Promise<Partial<Record<DashboardOAuthSource | 'google', boolean>>> {
  const output: Partial<Record<DashboardOAuthSource | 'google', boolean>> = {};
  const googleSources: Array<DashboardOAuthSource> = ['google', 'gmail', 'google-drive'];
  for (const source of googleSources) {
    const clientId = dashboardOAuthClientIdForSource(source, clientIds);
    output[source] = clientId !== undefined
      && Boolean(await dashboardGoogleOAuthClientSecret(source, secretStore, undefined, clientId));
  }
  output.x = Boolean(await secretStore.get(dashboardOAuthClientSecretConfigKey('x')));
  return output;
}

export async function dashboardOAuthClientSecret(
  source: DashboardOAuthSource,
  secretStore: SecretStore,
  fallback: string | undefined,
  clientId: string,
): Promise<string | undefined> {
  // Google's packaged pilot client is a public client and needs no secret, so
  // starting a Google flow no longer REQUIRES one. That is not the same as
  // having none: an install that connected under the earlier bring-your-own-
  // client instructions registered its own confidential client and has that
  // client's secret in the store, and Google's token endpoint expects the pair
  // it issued. Discarding the stored secret failed the exchange after the
  // owner had already burned a consent round — and the dashboard no longer
  // collects a secret, so there was no way back.
  if (dashboardGoogleOAuthSource(source)) {
    return await dashboardGoogleOAuthClientSecret(source, secretStore, fallback, clientId);
  }
  if (!dashboardOAuthClientSecretRequired(source)) return undefined;
  // X's secret is its own credential — the Google chain above must never
  // answer for it. The old Google-only gate returned undefined here for X
  // before even reading the fallback, silently discarding the very secret the
  // owner supplied; the exchange then went out without an Authorization header
  // and X refused it with 401 unauthorized_client (live, 2026-08-19).
  return fallback ?? await secretStore.get(dashboardOAuthClientSecretConfigKey(source));
}

/**
 * The Google client secret that belongs to the client id this flow is going
 * out with — and only that one.
 *
 * A secret is half of a pair, so an unpaired one is worse than none: sending a
 * leftover secret alongside the packaged pilot client, or alongside a client
 * the owner re-registered since, earns a flat `invalid_client` from Google.
 * Every store namespace keeps a registration's id and secret under matching
 * keys, so requiring the stored id to equal the id in use is what proves the
 * two halves came from the same registration.
 */
async function dashboardGoogleOAuthClientSecret(
  source: DashboardOAuthSource,
  secretStore: SecretStore,
  fallback: string | undefined,
  clientId: string,
): Promise<string | undefined> {
  if (fallback) return fallback;
  const ownApp = await readGoogleOwnAppRegistration(secretStore);
  if (ownApp?.clientId === clientId) return ownApp.clientSecret;
  if (clientId === dashboardGooglePilotClientId()) {
    // The pilot client's own secret, for an operator who packaged a
    // confidential client. Absent is the ordinary case and is not an error:
    // an installed-app client exchanges on client id plus PKCE.
    return process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET?.trim();
  }
  const namespaces = new Set<DashboardOAuthSource | 'google'>([source, 'google', 'gmail', 'google-drive']);
  for (const namespace of namespaces) {
    const storedClientId = await secretStore.get(dashboardOAuthClientIdConfigKey(namespace));
    if (storedClientId !== clientId) continue;
    const secret = await secretStore.get(dashboardOAuthClientSecretConfigKey(namespace));
    if (secret) return secret;
  }
  return undefined;
}

/**
 * Where Google's Desktop client returns: this engine on the loopback address.
 *
 * Google accepts any port on `http://127.0.0.1` for a Desktop client and
 * nothing else, so the host is always that literal. The port is the one the
 * browser already reached this dashboard on when the dashboard itself is on
 * loopback (`localhost`, `127.0.0.1`, `[::1]`, or a `*.localhost` desktop
 * origin): that is right on the Mac, on a Linux desktop, and through an SSH
 * tunnel whose local port differs from the engine's. Any other dashboard
 * origin (a tunnel name, a gateway) cannot be reached that way, so the
 * redirect names the engine's own port, and a browser on another machine
 * shows an unreachable page whose address `olympus connect finish` takes
 * (docs/ops/OAUTH_RELAY.md, "Google sign-in on the computer").
 */
export function dashboardGoogleLoopbackOrigin(dashboardOrigin: string, enginePort: number | undefined): string {
  try {
    const origin = new URL(dashboardOrigin);
    const host = origin.hostname.toLowerCase();
    const loopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host.endsWith('.localhost');
    if (origin.protocol === 'http:' && loopbackHost) return `http://127.0.0.1:${origin.port || '80'}`;
  } catch {
    // Fall through to the engine's own port.
  }
  return `http://127.0.0.1:${enginePort ?? DASHBOARD_DEFAULT_ENGINE_PORT}`;
}

/** The engine's port when the server did not say (OLYMPUS_EMAIL_SOURCE_PORT's default). */
const DASHBOARD_DEFAULT_ENGINE_PORT = 8010;

function dashboardGooglePilotClientId(): string | undefined {
  return process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID?.trim() || packagedGooglePilotClientId();
}

export function dashboardGooglePilotClientConfigured(): boolean {
  return dashboardGooglePilotClientId() !== undefined;
}

export function dashboardOAuthClientIdConfigKey(source: DashboardOAuthSource | 'google'): string {
  return `${source}.personal.oauth.client_id`;
}

/** The provenance companion to `dashboardOAuthClientIdConfigKey`: `'publisher' | 'byo'`. */
export function dashboardOAuthClientIdSourceKey(source: DashboardOAuthSource | 'google'): string {
  return `${source}.personal.oauth.client_id_source`;
}

export function dashboardOAuthClientSecretConfigKey(source: DashboardOAuthSource | 'google'): string {
  return `${source}.personal.oauth.client_secret`;
}

export function dashboardGoogleOAuthSource(source: DashboardOAuthSource | 'google'): boolean {
  return source === 'google' || source === 'gmail' || source === 'google-drive';
}

// X is here because its app is a confidential client: the token exchange must
// authenticate with HTTP Basic (proven against the live endpoint 2026-08-19 —
// client_id in the body alone earns 401 "Missing valid authorization header").
// Starting an X flow without the secret would mint an authorize URL whose
// exchange is doomed, burning the owner's consent round; refusing at start is
// the honest failure.
export function dashboardOAuthClientSecretRequired(source: DashboardOAuthSource | 'google'): boolean {
  return source === 'x';
}

export function dashboardOAuthClientIdForSource(
  source: DashboardOAuthSource,
  clientIds: Partial<Record<DashboardOAuthSource | 'google', string>>,
): string | undefined {
  // The shared-app fallback chain is a Google-family affair; X requires a
  // secret too but its client id never comes from a Google registration.
  if (!dashboardGoogleOAuthSource(source)) return clientIds[source];
  return clientIds[source]
    ?? clientIds.google
    ?? clientIds.gmail
    ?? clientIds['google-drive'];
}

export async function dashboardApiKeyAvailability(secretStore: SecretStore): Promise<Partial<Record<DashboardApiKeySource, boolean>>> {
  const readwiseToken = await secretStore.get('readwise.personal.token')
    ?? (PUBLIC_RUNTIME_BUILD ? undefined : await secretStore.get('readwise.castor_runtime.token'));
  return {
    venice: Boolean(await secretStore.get('venice.api_key')),
    readwise: Boolean(readwiseToken),
  };
}
