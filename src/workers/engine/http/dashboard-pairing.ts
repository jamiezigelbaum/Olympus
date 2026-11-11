import { resolve } from 'node:path';
import type { SecretStore } from '../../../core/secret-store.ts';
import {
  type UnpairedSourcesRead,
  readReconciledUnpairedSources,
  type UnpairedSourceRecord,
} from '../../credential-broker/unpaired-sources.ts';
import {
  type OlympusPathContext,
  telegramPairingSessionPaths,
  whatsappPairingSessionPaths,
  pairingLayoutEnv,
  pairingSessionPathOverridden,
  telegramStagedLogins,
  pairingSessionPathsFromStoredValue,
  type PairingPathRefusal,
} from '../../../core/pairing-session-paths.ts';
import { movedSessionValue } from '../../../core/messaging-account-move.ts';
import type { V04PublicSourceId } from '../../../core/public-source-capabilities.ts';
import type { DashboardUnpairedSourceState } from '../../source-dashboard.ts';
import { asOptionalString } from './request-fields.ts';
import { EmailSourceWorkerError } from './worker-responses.ts';

/**
 * What a previous attempt left owing for these sources.
 *
 * An Unpair is not one act but several — delete each artifact, remove the
 * stored reference, drop the registry handle — and any of them can fail on its
 * own. The record is where the unfinished ones live between attempts, so a
 * retry starts from what is still owed rather than from what it happens to be
 * able to see.
 */
export function dashboardUnpairObligations(
  existing: UnpairedSourcesRead,
  sourceIds: ReadonlySet<V04PublicSourceId>,
): { paths: string[]; steps: string[] } {
  if (existing.status !== 'ok') return { paths: [], steps: [] };
  const relevant = existing.records.filter((record) =>
    sourceIds.has(record.source_id as V04PublicSourceId));
  return {
    paths: [...new Set(relevant.flatMap((record) => record.unremoved_paths ?? []))],
    steps: [...new Set(relevant.flatMap((record) => record.failed_steps ?? []))],
  };
}

/** The two v0.4 sources that are paired as a local session, not brokered. */
type DashboardUnpairSource = 'telegram.messages' | 'whatsapp.personal.messages';

export function parseDashboardUnpairSource(value: unknown): DashboardUnpairSource {
  const source = asOptionalString(value);
  if (source === 'telegram.messages' || source === 'whatsapp.personal.messages') return source;
  throw new EmailSourceWorkerError(
    400,
    'invalid_request',
    'source_id must be telegram.messages or whatsapp.personal.messages. Other sources use Disconnect.',
  );
}

interface DashboardPairingSession {
  /** The artifacts Unpair may delete for this source, and nothing else. */
  paths: string[];
  /** Every stored reference that pointed at this pairing, for removal. */
  credentialKeys: string[];
}

/**
 * Where this source's pairing session actually lives, and what points at it.
 *
 * The path the owner REGISTERED wins whenever there is one.
 * `olympus connect telegram|whatsapp --session-path <path>` stores an arbitrary
 * location, so deriving from env/defaults alone meant a custom-path pairing had
 * its handle and stored reference deleted while the login itself stayed on disk
 * and the card said unpaired — a false completion in the one direction that
 * matters.
 *
 * The stored value is found WITHOUT going through the handle registry. A paired
 * session commonly owns no handle at all, and the handle-derived key list is
 * then empty, which is exactly the case that fell back to the default path and
 * missed a custom one. The secret store is asked directly instead, so the
 * registered path is found whether or not a handle survives to name it.
 *
 * An explicit env override that names a DIFFERENT session refuses rather than
 * guessing which one the live reader opens, and so do two stored values that
 * disagree. Both derivations run through the shared module the export/delete
 * custody path uses, so the narrow Unpair list and the wider lifecycle list can
 * never drift onto two different resolutions of the same session.
 */
export async function dashboardPairingSession(
  sourceId: DashboardUnpairSource,
  handleCredentialKeys: readonly string[],
  secretStore: SecretStore,
  context: OlympusPathContext | undefined,
): Promise<DashboardPairingSession> {
  const resolved = context ?? { env: process.env };
  const source = sourceId === 'telegram.messages' ? 'telegram' as const : 'whatsapp' as const;
  const derived = source === 'telegram'
    ? telegramPairingSessionPaths(resolved)
    : whatsappPairingSessionPaths(resolved);
  const sessionKeys = await dashboardSessionPathSecretKeys(source, handleCredentialKeys, secretStore);
  const fromStored = await dashboardStoredSessionPaths(sourceId, source, sessionKeys, secretStore, pairingLayoutEnv(resolved));
  const credentialKeys = [...new Set([
    ...handleCredentialKeys,
    ...sessionKeys.filter((candidate) => candidate.stored).map((candidate) => candidate.key),
  ])].sort();
  if (fromStored === undefined) return { paths: withStagedLogins(source, derived), credentialKeys };
  if (pairingSessionPathOverridden(source, resolved) && !samePathList(fromStored, derived)) {
    throw new EmailSourceWorkerError(
      409,
      'unpair_session_path_conflict',
      'The registered session path and the configured environment override name different pairing sessions, so Unpair cannot tell which one this computer actually uses. Reconcile OLYMPUS_TELEGRAM_SESSION_PATH or OLYMPUS_WHATSAPP_STATE_DIR with the path this source was connected with, then retry.',
    );
  }
  return { paths: withStagedLogins(source, fromStored, derived), credentialKeys };
}

/**
 * A Telegram pairing that was killed can leave the login it made aside
 * (telegramStagedSessionBase) beside the account's: it is a login too, so
 * Unpair removes it with the rest. Pairing uses the path this computer derives,
 * so one is looked for there too when the source was registered elsewhere
 * (PR #530 review).
 */
function withStagedLogins(source: 'telegram' | 'whatsapp', paths: string[], alsoBeside: readonly string[] = []): string[] {
  if (source !== 'telegram') return paths;
  const bases = [...paths, ...alsoBeside].filter((path) => path.endsWith('.session')).map((path) => path.slice(0, -'.session'.length));
  return [...new Set([...paths, ...[...new Set(bases)].flatMap((base) => telegramStagedLogins(base).map((left) => left.path))])];
}

interface DashboardSessionPathKey {
  key: string;
  /** Whether the store actually holds a value under it. */
  stored: boolean;
}

/**
 * Every secret key that could hold this source's registered session path.
 *
 * The canonical key is always considered, and the store is listed so a pairing
 * registered under a non-default account role is still found. Listing is best
 * effort: a store that cannot enumerate falls back to the canonical key and the
 * handle-derived ones rather than failing the whole operation.
 */
async function dashboardSessionPathSecretKeys(
  source: 'telegram' | 'whatsapp',
  handleCredentialKeys: readonly string[],
  secretStore: SecretStore,
): Promise<DashboardSessionPathKey[]> {
  const prefix = `${source === 'telegram' ? 'telegram' : 'whatsapp'}.`;
  const canonical = source === 'telegram'
    ? 'telegram.personal.session_path'
    : 'whatsapp.personal_local.session_path';
  const candidates = new Set<string>([canonical]);
  for (const key of handleCredentialKeys) {
    if (key.startsWith(prefix) && key.endsWith('.session_path')) candidates.add(key);
  }
  try {
    for (const key of await secretStore.list()) {
      if (key.startsWith(prefix) && key.endsWith('.session_path')) candidates.add(key);
    }
  } catch {
    // Enumeration is an optimization over the canonical key, never a gate.
  }
  const keys: DashboardSessionPathKey[] = [];
  for (const key of [...candidates].sort()) {
    const value = (await secretStore.get(key))?.trim();
    keys.push({ key, stored: value !== undefined && value !== '' });
  }
  return keys;
}

/**
 * The artifact list this source was connected with, if the stored references
 * agree about which session that is.
 *
 * Every stored value is NORMALIZED to its artifact list first, and the dedupe
 * happens on those lists. Comparing the raw strings made `/data/tg` and
 * `/data/tg.session` — one session, two documented spellings, e.g. after a
 * re-connect that used the other form — look like two different pairings and
 * refuse. A conflict now means genuinely different sessions.
 */
async function dashboardStoredSessionPaths(
  sourceId: DashboardUnpairSource,
  source: 'telegram' | 'whatsapp',
  sessionKeys: readonly DashboardSessionPathKey[],
  secretStore: SecretStore,
  env: Record<string, string | undefined>,
): Promise<string[] | undefined> {
  const bySession = new Map<string, string[]>();
  for (const candidate of sessionKeys) {
    if (!candidate.stored) continue;
    const value = (await secretStore.get(candidate.key))?.trim();
    if (!value) continue;
    // An account the boot migration moved may still have a stored path that names its old place, until the boot rewrites it:
    // its login is in its folder now, and that is what Unpair removes.
    const paths = pairingSessionPathsFromStoredValue(source, movedSessionValue(source, value, env));
    if (paths.length === 0) continue;
    bySession.set(sessionPathListKey(paths), paths);
  }
  if (bySession.size === 0) return undefined;
  if (bySession.size > 1) {
    throw new EmailSourceWorkerError(
      409,
      'unpair_session_path_conflict',
      `Unpair found more than one registered pairing session for ${sourceId}. Resolve the duplicate handles with the CLI first.`,
    );
  }
  return [...bySession.values()][0];
}

/** One comparable identity for an artifact list, independent of spelling. */
function sessionPathListKey(paths: readonly string[]): string {
  return [...new Set(paths.map((path) => resolve(path)))].sort().join('\0');
}

function samePathList(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (paths: readonly string[]) => [...new Set(paths.map((path) => resolve(path)))].sort();
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * One refused pairing path, turned into the answer the dashboard shows.
 *
 * Every reason is a 409: none of them is a malformed request, and all of them
 * mean the same thing to a reader — Olympus will not delete this, do it
 * yourself. The offending component is named because a symlinked ancestor is
 * otherwise invisible from the path the card knows about.
 */
export function dashboardUnpairPathError(refusal: PairingPathRefusal): EmailSourceWorkerError {
  if (refusal.reason === 'outside_root') {
    return new EmailSourceWorkerError(
      409,
      'unpair_session_path_external',
      'The configured pairing-session directory is outside every Olympus-owned root, so Unpair will not delete it. Check OLYMPUS_TELEGRAM_SESSION_PATH or OLYMPUS_WHATSAPP_STATE_DIR, then remove the session by hand.',
    );
  }
  if (refusal.reason === 'symlink_component') {
    return new EmailSourceWorkerError(
      409,
      'unpair_session_path_external',
      `The pairing-session path reaches outside Olympus through a symbolic link at ${refusal.component}, so Unpair will not delete it. Remove the session by hand.`,
    );
  }
  if (refusal.reason === 'inspection_failed') {
    // An artifact that cannot be inspected is an unknown, and reporting an
    // unknown as an absent one is how a skipped session became a completed
    // removal. Refuse the whole operation instead.
    return new EmailSourceWorkerError(
      409,
      'unpair_session_path_unreadable',
      `Unpair could not inspect ${refusal.component}, so it cannot say what is there. Check the permissions on the pairing-session directory, then retry.`,
    );
  }
  return new EmailSourceWorkerError(
    409,
    'unpair_session_path_not_a_file',
    `Refusing to delete a pairing artifact that is not a regular file: ${refusal.component}`,
  );
}

/**
 * The unpaired sources the dashboard should still be told about.
 *
 * READ ONLY. This runs on every render of a page that polls every few seconds,
 * and it used to rewrite the record to drop re-paired sources. That write held
 * no grant-custody lease, so a render could land between an Unpair's read and
 * its commit and overwrite the fact Unpair had just recorded. Dropping a source
 * on re-pair happens in the connect path that registers the new pairing, under
 * the same lease that writes the handle.
 *
 * The durable record is authoritative when it can be read. There is
 * deliberately NO "but a usable handle exists" filter any more: a teardown that
 * deleted the session files and then failed to remove the handle left exactly
 * that handle behind, and the filter turned it into a card claiming a live
 * session over a session that was already gone.
 *
 * An unreadable record is its own answer, never an absent one. Reporting a
 * parse failure as "nothing has been unpaired" is the failure mode that let a
 * card go back to inferring connectedness from sync evidence after a restart,
 * so both paired-session cards say the state cannot be read — the record could
 * name either — and Unpair and connect refuse to mutate until it is repaired.
 */
export function dashboardUnpairedSourceStates(
  unpaired: Set<V04PublicSourceId>,
  registryPath: string,
): DashboardUnpairedSourceState[] {
  const read = readReconciledUnpairedSources(registryPath);
  if (read.status === 'unreadable') {
    return DASHBOARD_UNPAIR_SOURCE_IDS.map((source_id) => ({ source_id, state: 'unpair_state_unreadable' as const }));
  }
  const records = new Map<string, UnpairedSourceRecord>();
  // Only where the file is absent does this process's own memory stand in for
  // it: a record deleted out from under a running worker is still a fact this
  // worker performed, and forgetting it would hand the card back to inference.
  if (read.status === 'missing') {
    for (const sourceId of unpaired) records.set(sourceId, { source_id: sourceId, state: 'unpaired' });
  } else {
    for (const record of read.records) {
      if (!isDashboardUnpairSourceId(record.source_id)) continue;
      records.set(record.source_id, record);
    }
  }
  return [...records.values()]
    .sort((a, b) => a.source_id.localeCompare(b.source_id))
    // The view model is served to the read-only dash_ token, which is promised
    // no filesystem paths. Only whether cleanup is outstanding crosses this
    // line; the paths themselves stay in the CSRF-authorized POST response that
    // the person who pressed the button is already reading.
    .map((record) => ({
      source_id: record.source_id,
      state: record.state === 'unpaired' ? 'unpaired' as const : 'unpair_incomplete' as const,
    }));
}

const DASHBOARD_UNPAIR_SOURCE_IDS: DashboardUnpairSource[] = [
  'telegram.messages',
  'whatsapp.personal.messages',
];

function isDashboardUnpairSourceId(value: string): value is DashboardUnpairSource {
  return value === 'telegram.messages' || value === 'whatsapp.personal.messages';
}
