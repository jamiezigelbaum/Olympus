import { parseOptionalBooleanEnv } from '../../../core/config.ts';
import {
  sourceAccountUnavailableReason,
  type StorageAccount,
} from '../../../core/source-storage.ts';
import {
  type SourceScheduler,
} from '../../source-scheduler.ts';
import {
  handleRegistryPathFromEnv,
  readConnectedHandleRegistry,
  type ConnectedCredentialHandle,
} from '../../credential-broker/connected-handles.ts';
import { withoutUnpairedLaneHandles } from '../../credential-broker/unpaired-sources.ts';

export function sourceIndexLaneEnabled(
  env: Record<string, string | undefined>,
  envName: string,
  handlePresent: boolean,
): boolean {
  return sourceIndexLaneDecision(env, envName, handlePresent).enabled;
}

export function sourceIndexLaneStorageEnabled(
  env: Record<string, string | undefined>,
  envName: string,
  sourceIndexReadEnabled: boolean,
): boolean {
  return sourceIndexLaneStorageDecision(env, envName, sourceIndexReadEnabled).enabled;
}

/**
 * The X legacy bookmarks index is retired (2026-07-28): reads are served by the
 * connector store, its vectors were imported there, and the database is deleted
 * on the host. This lane alone must not inherit the source-index read-surface
 * fallback every other lane uses, because opening the index recreates the file
 * that was just deleted — an absent env would silently resurrect an empty
 * legacy database. The mount now requires an explicit opt-in.
 */

/**
 * Readwise now follows X onto the canonical connector store. The legacy index
 * remains available only for an explicit, one-time convergence operation; an
 * absent flag must not recreate or schedule it during normal product runtime.
 */


export interface SourceIndexLaneDecision {
  enabled: boolean;
  envName: string;
  decidedBy: string;
}

export function sourceIndexLaneDecision(
  env: Record<string, string | undefined>,
  envName: string,
  handlePresent: boolean,
): SourceIndexLaneDecision {
  if (env[envName]?.trim()) {
    return {
      enabled: parseOptionalBooleanEnv(env[envName], envName),
      envName,
      decidedBy: envName,
    };
  }
  return {
    enabled: handlePresent,
    envName,
    decidedBy: handlePresent ? 'connected handle fallback' : 'no connected handle',
  };
}

export function sourceIndexLaneStorageDecision(
  env: Record<string, string | undefined>,
  envName: string,
  sourceIndexReadEnabled: boolean,
): SourceIndexLaneDecision {
  if (env[envName]?.trim()) {
    return {
      enabled: parseOptionalBooleanEnv(env[envName], envName),
      envName,
      decidedBy: envName,
    };
  }
  return {
    enabled: sourceIndexReadEnabled,
    envName,
    decidedBy: 'source-index read surface fallback',
  };
}

/**
 * Whether an account's stores may be mounted at worker boot. One that may not
 * (its data being deleted or deleted, or an unreadable registry) is left
 * unmounted exactly like a lane that is switched off, with one line saying
 * so; every other source mounts as usual. The throw in `openConnectorStore`
 * is the backstop.
 */
export function sourceAccountMountable(
  account: StorageAccount,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.warn,
): boolean {
  const reason = sourceAccountUnavailableReason(account, env);
  if (reason === undefined) return true;
  log(`[storage] ${account.sourceId} is not mounted: ${reason.endsWith('.') ? reason.slice(0, -1) : reason}.`);
  return false;
}

/** A lane's storage decision, switched off when its account may not be mounted. */
export function sourceIndexLaneAccountDecision(
  decision: SourceIndexLaneDecision,
  account: StorageAccount,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.warn,
): SourceIndexLaneDecision {
  if (!decision.enabled || sourceAccountMountable(account, env, log)) return decision;
  return { ...decision, enabled: false, decidedBy: 'the source registry' };
}

export function sourceIndexLaneStartupLog(label: string, decision: SourceIndexLaneDecision): string {
  return `${label}: ${decision.enabled ? 'enabled' : 'disabled'} (decided by ${decision.decidedBy}).`;
}

export function activeCredentialHandle(
  handles: readonly ConnectedCredentialHandle[],
  match: {
    provider: ConnectedCredentialHandle['provider'];
    capability: string;
  },
): ConnectedCredentialHandle | undefined {
  return handles.find((handle) =>
    handle.provider === match.provider
    && handle.allowedCapabilities.includes(match.capability)
    && handle.backendState?.status !== 'reauth_required'
  );
}

export type CredentialHandleSelectionReason =
  | 'selected'
  | 'none'
  | 'ambiguous'
  | 'pinned_missing';

export interface CredentialHandleSelection {
  handle?: ConnectedCredentialHandle;
  reason: CredentialHandleSelectionReason;
  /** Eligible handle names, so an ambiguous refusal can name what it saw. */
  candidates: string[];
}

/**
 * Explicit, order-independent handle selection.
 *
 * `activeCredentialHandle` is a first-match `find`, and the registry is written
 * back sorted by handle name, so with two eligible handles the alphabetically
 * first one wins. That is how registering `gmail.business_ocu.delegated`
 * alongside `gmail.personal.delegated` silently rebound the Gmail lane from the
 * 73,212-message mailbox to the 25-message one: registration order, not
 * configuration, chose the mailbox.
 *
 * This selector never picks by order. Exactly one eligible handle is selected;
 * more than one is refused as ambiguous until an operator pins the one the lane
 * must read. A pin that names an unregistered handle is also refused rather
 * than falling back, because a silent fallback is the same defect wearing a
 * different hat.
 */
export function selectCredentialHandle(
  handles: readonly ConnectedCredentialHandle[],
  match: {
    provider: ConnectedCredentialHandle['provider'];
    capability: string;
    /** Operator pin naming the exact handle this lane must read. */
    pinnedHandle?: string;
  },
): CredentialHandleSelection {
  const eligible = handles.filter((handle) =>
    handle.provider === match.provider
    && handle.allowedCapabilities.includes(match.capability)
    && handle.backendState?.status !== 'reauth_required'
  );
  const candidates = eligible.map((handle) => handle.handle);
  const pinnedHandle = match.pinnedHandle?.trim();
  if (pinnedHandle) {
    const pinned = eligible.find((handle) => handle.handle === pinnedHandle);
    return pinned
      ? { handle: pinned, reason: 'selected', candidates }
      : { reason: 'pinned_missing', candidates };
  }
  if (eligible.length === 0) return { reason: 'none', candidates };
  if (eligible.length > 1) return { reason: 'ambiguous', candidates };
  return { handle: eligible[0]!, reason: 'selected', candidates };
}

/**
 * The single gate a connector-store lane passes before it may construct: the
 * lane enable must be on AND exactly one handle must be selected.
 *
 * Both halves matter. The lane enable alone is not enough, because the sync
 * handler is built from stores that exist at boot regardless of credentials —
 * so an enabled lane with no handle would construct a source that cannot run,
 * and the activation gate reads presence as readiness.
 */
export function connectorStoreLaneHandle(input: {
  env: Record<string, string | undefined>;
  laneEnvName: string;
  pinEnvName: string;
  provider: ConnectedCredentialHandle['provider'];
  capability: string;
  handles: readonly ConnectedCredentialHandle[];
  warn?: (message: string) => void;
}): ConnectedCredentialHandle | undefined {
  const handle = selectedSourceCredentialHandle(input);
  // Evaluated unconditionally so a malformed lane enable still fails the boot
  // even when no eligible credential handle exists.
  const laneEnabled = sourceIndexLaneEnabled(
    input.env,
    input.laneEnvName,
    handle !== undefined,
  );
  return handle && laneEnabled ? handle : undefined;
}

/** Select a source credential independently from any storage-lane enable. */
/**
 * Starts the first read after a scope approval without holding the approval's
 * response open for it. That read is a whole sync pass (minutes for a large
 * Dropbox), and awaiting it outlived the ChatGPT tool call: the picker saw the
 * save fail, saved again with the revision the first save had just replaced,
 * and got "The source scope changed" (owner live test, 2026-10-01). The
 * scheduler owns the run from here; its status and the dashboard report it.
 */
export function startApprovedSourceRun(scheduler: { runSource: SourceScheduler['runSource'] }, sourceId: string): void {
  void scheduler.runSource(sourceId, undefined, 'operator').catch(() => {
    console.warn(`[source-scheduler] source=${sourceId} first run after scope approval failed; the next scheduled pass retries.`);
  });
}

export function selectedSourceCredentialHandle(input: {
  env: Record<string, string | undefined>;
  pinEnvName: string;
  provider: ConnectedCredentialHandle['provider'];
  capability: string;
  handles: readonly ConnectedCredentialHandle[];
  warn?: (message: string) => void;
}): ConnectedCredentialHandle | undefined {
  const selection = selectCredentialHandle(input.handles, {
    provider: input.provider,
    capability: input.capability,
    ...(input.env[input.pinEnvName]?.trim()
      ? { pinnedHandle: input.env[input.pinEnvName]!.trim() }
      : {}),
  });
  const warn = input.warn ?? ((message: string) => console.warn(message));
  if (selection.reason === 'ambiguous') {
    warn(
      `${input.provider} lane refused to construct: ${selection.candidates.length} handles carry ${input.capability} `
      + `(${selection.candidates.join(', ')}). Set ${input.pinEnvName} to the handle this lane must read.`,
    );
  }
  if (selection.reason === 'pinned_missing') {
    warn(
      `${input.provider} lane refused to construct: ${input.pinEnvName} names a handle that is not registered with `
      + `${input.capability} (registered: ${selection.candidates.join(', ') || 'none'}).`,
    );
  }
  return selection.handle;
}

/**
 * The single gate every lane-building path passes through.
 *
 * Boot, the adoption tick and the dashboard's refresh callback all end up here,
 * including when a caller supplies its own handle list: one choke point is what
 * makes "a source the owner unpaired does not get a lane" true of every path
 * rather than of the one that happened to remember.
 */
export function activeLaneHandles(
  handles: readonly ConnectedCredentialHandle[],
  env: Record<string, string | undefined>,
): ConnectedCredentialHandle[] {
  const registryPath = handleRegistryPathFromEnv(env, true);
  if (!registryPath) return [...handles];
  try {
    return withoutUnpairedLaneHandles(handles, registryPath);
  } catch (error) {
    console.warn(`Could not read the Olympus unpaired-source record: ${error instanceof Error ? error.message : String(error)}`);
    return [...handles];
  }
}

export function readActiveConnectedHandles(env: Record<string, string | undefined>): ConnectedCredentialHandle[] {
  const registryPath = handleRegistryPathFromEnv(env, true);
  if (!registryPath) return [];
  try {
    // The registry alone is not the whole answer. A handle an Unpair could not
    // remove is still in this file, and building its lane at boot would quietly
    // undo the teardown; the unpaired record is what says so.
    return activeLaneHandles(
      readConnectedHandleRegistry(registryPath).handles
        .filter((handle) => handle.backendState?.status !== 'reauth_required'),
      env,
    );
  } catch (error) {
    console.warn(`Could not read Olympus handle registry for source activation: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
