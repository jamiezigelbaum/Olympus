import { isRetiredGoogleHandle } from '../../../core/google-handle-compatibility.ts';
import {
  type SourceAccountBindings,
  readSourceAccountBindings,
  sourceAccountBindingsPath,
} from '../../../core/source-account-binding.ts';
import { type SourceStorageNoticeKind, sourceStorageNotices } from '../../../core/source-registry.ts';
import { statSync } from 'node:fs';
import { normalizeSecretRef } from '../../../core/secret-store.ts';
import type { ArchiveImportDashboard } from '../../archive-import/dashboard.ts';
import type { V04PublicSourceId } from '../../../core/public-source-capabilities.ts';
import type { SourceScheduler } from '../../source-scheduler.ts';
import {
  type DashboardLivePass,
  type DashboardImportedArchives,
  type DashboardOAuthSource,
  type DashboardApiKeySource,
  type DashboardSyncSource,
  type DashboardConnectSource,
  type DashboardThisComputerSource,
  DASHBOARD_SUPPORTED_SOURCES,
} from '../../source-dashboard.ts';
import {
  type ConnectedHandleRegistry,
  assertOneConnectedAccountPerProvider,
  type ConnectedCredentialHandle,
  defaultHandleRegistryPath,
  readConnectedHandleRegistry,
} from '../../credential-broker/connected-handles.ts';
import { readThisComputerHandles } from '../../../core/this-computer.ts';
import { EmailSourceWorkerError } from './worker-responses.ts';
import type { EmailSourceWorkerOptions } from './worker-options.ts';

/**
 * The Archives card's connection. A failure to read it is said as such,
 * never as no archives imported.
 */
export function dashboardLivePasses(read: (() => Readonly<Record<string, DashboardLivePass>>) | undefined): { livePasses?: Readonly<Record<string, DashboardLivePass>> } {
  if (!read) return {};
  try {
    return { livePasses: read() };
  } catch {
    return {};
  }
}

export function dashboardImportedArchives(archiveImports: ArchiveImportDashboard | undefined): {
  importedArchives?: DashboardImportedArchives;
  importedArchivesByCard?: Record<string, DashboardImportedArchives>;
} {
  if (!archiveImports) return {};
  let importedArchives: DashboardImportedArchives;
  try {
    importedArchives = archiveImports.present();
  } catch {
    importedArchives = { archives: 0, importing: false, attention: [{ kind: 'unreadable', reason: 'other' }] };
  }
  // Each import-only source's card (Reflect, Roam, ...): the imports of its formats.
  try {
    return { importedArchives, importedArchivesByCard: archiveImports.presentCards() };
  } catch {
    return { importedArchives };
  }
}

function dashboardProvidersForSource(source: DashboardOAuthSource | DashboardApiKeySource | V04PublicSourceId): string[] {
  if (source === 'google') return ['gmail', 'google_drive'];
  if (source === 'gmail' || source === 'gmail.email') return ['gmail'];
  if (source === 'google-drive' || source === 'google_drive.docs') return ['google_drive'];
  if (source === 'dropbox' || source === 'dropbox.files') return ['dropbox'];
  if (source === 'x' || source === 'x.bookmarks') return ['x'];
  if (source === 'telegram.messages') return ['telegram'];
  if (source === 'whatsapp.personal.messages') return ['whatsapp_personal'];
  if (source === 'readwise' || source === 'readwise.library') return ['readwise'];
  if (source === 'evernote' || source === 'evernote.notes') return ['evernote'];
  return [source];
}

export function assertDashboardAccountCardinality(
  registry: ConnectedHandleRegistry,
  source: DashboardOAuthSource | DashboardApiKeySource,
): void {
  const providers = new Set(dashboardProvidersForSource(source));
  const handles = registry.handles.filter((handle) => providers.has(handle.provider) && !isRetiredGoogleHandle(handle));
  try {
    assertOneConnectedAccountPerProvider({ version: 1, handles });
  } catch {
    throw new EmailSourceWorkerError(
      409,
      'dashboard_account_cardinality_violation',
      'The dashboard supports one connected account per provider. Disconnect the existing account before connecting another.',
    );
  }
}

interface DashboardDisconnectPlan {
  handles: ConnectedCredentialHandle[];
  credentialKeys: string[];
  sourceIds: Set<V04PublicSourceId>;
}

export function dashboardDisconnectHasRunningRead(
  scheduler: SourceScheduler,
  sourceIds: ReadonlySet<V04PublicSourceId>,
): boolean {
  const selected = new Set<string>(sourceIds);
  // A task a refresh dropped from the roster is still executing and can still
  // write; status() no longer lists it.
  if (scheduler.hasExecutingTask?.(selected)) return true;
  return scheduler.status().sources.some((source) =>
    (selected.has(source.source_id) || selected.has(source.corpus_id))
    && source.tasks.some((task) => task.running)
  );
}

export function dashboardDisconnectPlan(
  registry: ConnectedHandleRegistry,
  sourceId: V04PublicSourceId,
): DashboardDisconnectPlan {
  const providers = new Set(dashboardProvidersForSource(sourceId));
  const initial = registry.handles.filter((handle) => providers.has(handle.provider));
  const selected = new Map(initial.map((handle) => [handle.handle, handle]));
  const credentialRefs = new Set(initial.flatMap(dashboardCredentialRefs));
  // A combined Google consent writes one refresh token behind both handles.
  // Disconnecting that selected account grant therefore closes both readers;
  // leaving the sibling handle behind would falsely render it connected.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const handle of registry.handles) {
      if (selected.has(handle.handle)) continue;
      const refs = dashboardCredentialRefs(handle);
      if (!refs.some((ref) => credentialRefs.has(ref))) continue;
      selected.set(handle.handle, handle);
      for (const ref of refs) credentialRefs.add(ref);
      expanded = true;
    }
  }
  const handles = [...selected.values()];
  try {
    assertOneConnectedAccountPerProvider({ version: 1, handles });
  } catch {
    throw new EmailSourceWorkerError(
      409,
      'dashboard_account_cardinality_violation',
      'Disconnect refused ambiguous multi-account state. Use the CLI to resolve the exact account handles first.',
    );
  }
  const credentialKeys = [...credentialRefs]
    .map((ref) => normalizeSecretRef(ref))
    .filter((ref): ref is { kind: 'store'; key: string } => ref?.kind === 'store')
    .map((ref) => ref.key)
    .sort();
  return {
    handles,
    credentialKeys,
    sourceIds: new Set(handles.flatMap(dashboardSourceIdsForHandle)),
  };
}

function dashboardCredentialRefs(handle: ConnectedCredentialHandle): string[] {
  const legacySessionPathRef = handle.tokenSecretRefs?.length
    ? []
    : handle.provider === 'telegram'
      ? [`store:telegram.${handle.accountRole ?? 'personal'}.session_path`]
      : handle.provider === 'whatsapp_personal'
        ? [`store:whatsapp.${handle.accountRole ?? 'personal_local'}.session_path`]
        : [];
  return [
    ...(handle.tokenSecretRefs ?? []),
    ...(handle.oauth2Refresh ? [handle.oauth2Refresh.refreshTokenSecretRef] : []),
    ...legacySessionPathRef,
  ];
}

function dashboardSourceIdsForHandle(handle: ConnectedCredentialHandle): V04PublicSourceId[] {
  if (handle.provider === 'gmail') return ['gmail.email'];
  if (handle.provider === 'google_drive') return ['google_drive.docs'];
  if (handle.provider === 'dropbox') return ['dropbox.files'];
  if (handle.provider === 'x') return ['x.bookmarks'];
  if (handle.provider === 'telegram') return ['telegram.messages'];
  if (handle.provider === 'whatsapp_personal') return ['whatsapp.personal.messages'];
  if (handle.provider === 'readwise') return ['readwise.library'];
  if (handle.provider === 'evernote') return ['evernote.notes'];
  return [];
}

export function dashboardOAuthSourcesForDisconnected(sourceIds: Set<V04PublicSourceId>): DashboardOAuthSource[] {
  const output: DashboardOAuthSource[] = [];
  if (sourceIds.has('gmail.email')) output.push('gmail', 'google');
  if (sourceIds.has('google_drive.docs')) output.push('google-drive', 'google');
  if (sourceIds.has('dropbox.files')) output.push('dropbox');
  if (sourceIds.has('x.bookmarks')) output.push('x');
  if (sourceIds.has('evernote.notes')) output.push('evernote');
  return [...new Set(output)];
}

export function assertDashboardSourceMayRead(
  source: DashboardSyncSource,
  sourceDashboard: NonNullable<EmailSourceWorkerOptions['sourceDashboard']>,
  disconnected: Set<V04PublicSourceId>,
): void {
  // A source on this computer has no credential handle: it is connected when
  // the this-computer record says so.
  if (isDashboardThisComputerSource(source)) {
    const registryPath = sourceDashboard.registryPath ?? defaultHandleRegistryPath();
    if (!readThisComputerHandles(registryPath).some((handle) => handle.handle === `${source}.this_computer`)) {
      throw new EmailSourceWorkerError(409, 'source_disconnected', 'Reconnect this source before starting a manual read.');
    }
    return;
  }
  const sourceId = dashboardPublicSourceIdForConnectSource(source);
  if (!sourceId) return;
  const registryPath = sourceDashboard.registryPath ?? defaultHandleRegistryPath();
  if (disconnected.has(sourceId)) {
    // The latch is only this process's memory of a Disconnect, and the
    // documented headless reconnect — `olympus connect gmail` — runs in
    // another process with no channel into this one. The registry is the
    // state both surfaces actually write, so a latch it contradicts is stale,
    // not authoritative: the same page already renders the card connected off
    // that registry and the scheduler has already re-adopted the source, which
    // left Sync now as the one control still refusing until a restart —
    // contradicting Disconnect's own `restart_required: false`.
    if (!dashboardSourceHasConnectedHandle(sourceId, registryPath)) {
      throw new EmailSourceWorkerError(409, 'source_disconnected', 'Reconnect this source before starting a manual read.');
    }
    disconnected.delete(sourceId);
  }
  if (sourceDashboard.enforceConnectedSourceReads !== true) return;
  if (!dashboardSourceHasConnectedHandle(sourceId, registryPath)) {
    throw new EmailSourceWorkerError(409, 'source_disconnected', 'Reconnect this source before starting a manual read.');
  }
}

/**
 * Whether the durable registry still holds a usable grant for this source.
 *
 * Read tolerantly: a registry that cannot be parsed proves no reconnect, so
 * the honest answer is the same "reconnect this source" refusal the caller
 * already gives — never a 500 out of a manual read.
 */
/**
 * A cheap fingerprint of the handle registry: modification time and size.
 *
 * Enough to notice that another process rewrote it, which is all the scheduler
 * refresh needs. An absent registry is its own stamp, so removing the file is a
 * change like any other.
 */
export function dashboardRegistryStamp(registryPath: string): string {
  try {
    const stat = statSync(registryPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}

function dashboardSourceHasConnectedHandle(sourceId: V04PublicSourceId, registryPath: string): boolean {
  const providers = new Set(dashboardProvidersForSource(sourceId));
  return readDashboardRegistry(registryPath).handles.some((handle) =>
    providers.has(handle.provider) && handle.backendState?.status !== 'reauth_required');
}

function dashboardPublicSourceIdForConnectSource(source: DashboardConnectSource): V04PublicSourceId | undefined {
  if (source === 'gmail') return 'gmail.email';
  if (source === 'google-drive') return 'google_drive.docs';
  if (source === 'dropbox') return 'dropbox.files';
  if (source === 'x') return 'x.bookmarks';
  if (source === 'readwise') return 'readwise.library';
  if (source === 'evernote') return 'evernote.notes';
  return undefined;
}

export function markDashboardSourceConnected(
  source: DashboardOAuthSource | DashboardApiKeySource,
  disconnected: Set<V04PublicSourceId>,
): void {
  if (source === 'google' || source === 'gmail') disconnected.delete('gmail.email');
  if (source === 'google' || source === 'google-drive') disconnected.delete('google_drive.docs');
  if (source === 'dropbox') disconnected.delete('dropbox.files');
  if (source === 'x') disconnected.delete('x.bookmarks');
  if (source === 'readwise') disconnected.delete('readwise.library');
  if (source === 'evernote') disconnected.delete('evernote.notes');
}

export function isDashboardSyncSource(source: DashboardSyncSource | string): source is DashboardSyncSource {
  return source === 'gmail' || source === 'google-drive' || source === 'dropbox' || source === 'x' || source === 'readwise'
    || source === 'evernote' || isDashboardThisComputerSource(source);
}

/** A source with no account, by the id its Connect action names (read off the definitions). */
function isDashboardThisComputerSource(source: string): source is DashboardThisComputerSource {
  return DASHBOARD_SUPPORTED_SOURCES.some((definition) =>
    definition.connect_action.kind === 'this_computer' && definition.connect_action.source === source);
}

export function dashboardSchedulerSourceId(source: DashboardSyncSource): string | undefined {
  // A source on this computer is scheduled under its own id.
  if (isDashboardThisComputerSource(source)) return source;
  if (source === 'gmail') return 'gmail.email';
  if (source === 'google-drive') return 'google_drive.docs';
  if (source === 'dropbox') return 'dropbox.files';
  if (source === 'readwise') return 'readwise.library';
  if (source === 'x') return 'x.bookmarks';
  if (source === 'evernote') return 'evernote.notes';
  return undefined;
}

/**
 * The synthetic handle of every connected source on this computer, beside the
 * credential handles, so its card reads connected from the same registry the
 * others do. The credential registry itself never carries them.
 */
export function withThisComputerHandles(
  registry: ConnectedHandleRegistry,
  registryPath: string | undefined,
): ConnectedHandleRegistry {
  let synthetic: ConnectedCredentialHandle[];
  try {
    synthetic = readThisComputerHandles(registryPath ?? defaultHandleRegistryPath())
      .map((handle) => ({ ...handle, scopes: [] }) as unknown as ConnectedCredentialHandle);
  } catch {
    return registry;
  }
  return synthetic.length === 0 ? registry : { ...registry, handles: [...registry.handles, ...synthetic] };
}

export function readDashboardRegistry(registryPath: string | undefined): ConnectedHandleRegistry {
  return readDashboardRegistryOutcome(registryPath).registry;
}

/**
 * The handle registry as the read-only dashboard paths must take it: an answer
 * plus whether that answer is knowledge or a stand-in.
 *
 * The reader throws on the whole file — a truncated write, a hand-edit, an
 * unsupported `version` — and this page is the one surface that could tell the
 * owner a source needs reconnecting or that the registry needs repair. Letting
 * that throw out took the entire dashboard to a 500 over one bad file. The
 * empty stand-in keeps the page up; `unreadable` is what stops the page from
 * then reporting every source as plainly not connected, which would be a
 * different untruth.
 */
export function readDashboardRegistryOutcome(
  registryPath: string | undefined,
): { registry: ConnectedHandleRegistry; unreadable: boolean } {
  try {
    return {
      registry: readConnectedHandleRegistry(registryPath ?? defaultHandleRegistryPath()),
      unreadable: false,
    };
  } catch {
    return { registry: { version: 1, handles: [] }, unreadable: true };
  }
}

/** The account record beside the registry; unreadable reads as nothing to say (the worker fails closed on it). */
export function dashboardSourceAccountBindings(
  registryPath: string | undefined,
): { sourceAccountBindings?: SourceAccountBindings['sources'] } {
  try {
    const read = readSourceAccountBindings(sourceAccountBindingsPath(registryPath ?? defaultHandleRegistryPath()));
    return read.kind === 'ok' ? { sourceAccountBindings: read.bindings.sources } : {};
  } catch {
    return {};
  }
}

/** What the boot migration of files into account folders left for the owner; nothing when the registry says nothing. */
export function dashboardStorageNotices(): { storageNotices?: Record<string, SourceStorageNoticeKind> } {
  const notices = sourceStorageNotices(process.env);
  return notices.length > 0 ? { storageNotices: Object.fromEntries(notices.map((notice) => [notice.source_id, notice.kind])) } : {};
}
