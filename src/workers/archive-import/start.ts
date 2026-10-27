/**
 * Starting an import of a path the person approved.
 *
 * The caller (the dashboard's approval) hands over the canonical path the
 * picker returned. It is opened only through the scope-safe reader: a chosen
 * file through a descriptor on its folder, a chosen folder through one on
 * itself. Detection reads names and first bytes only; the manifest pins
 * every file the import will read. Nothing is written for a path that is not
 * a supported archive, two formats at once, or one already imported.
 *
 * Two steps, so a caller can answer before the slow part: `prepareArchiveImport`
 * reads metadata and first bytes only and says whether the files may be a
 * copy of an earlier import (same size, same first and last bytes); only then
 * must every file be read whole to know (`archiveFileDigestSteps`), and
 * `commitArchiveImport` records the import. `startArchiveImport` runs both
 * at once.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import {
  ARCHIVE_COMMON_FINDINGS,
  archiveFilesNotLookedAt,
  archiveProbeNames,
  archiveSignatureNames,
  detectArchiveFormat,
  type ArchiveFormatDefinition,
} from '../../core/archive-formats.ts';
import type { LayoutEnv } from '../../core/olympus-layout.ts';
import { ScopeRoot, ScopeSafeError, joinRelative } from '../../core/scope-safe-fs.ts';
import { importAccountIdentity, resolveImportAccount } from '../../core/source-storage.ts';
import {
  archiveFileSha256,
  archiveManifestSha256,
  buildArchiveManifest,
  findProbableCopies,
  findSameInProgressImport,
  findSameVersionImport,
  isCopyOf,
  probeArchivePath,
  verifyArchiveManifest,
} from './manifest.ts';
import type { ArchiveAccountEvidence, ArchiveSourceTargets } from './source-targets.ts';
import type { ArchiveImportRecord, ArchiveImportStateStore, ArchiveImportTarget, NewArchiveImportRecord } from './state.ts';

export type ArchiveImportStart =
  | { kind: 'started'; archive: ArchiveImportRecord }
  | { kind: 'already_imported'; archive: ArchiveImportRecord }
  | { kind: 'unsupported'; supported: readonly string[]; advice?: string }
  | { kind: 'ambiguous'; formats: readonly string[] }
  | { kind: 'unreadable'; code: string };

/**
 * A path ready to record. `root` stays open for the caller (it reads the
 * files whole through it when `copies` is not empty) and must be closed.
 */
export interface PreparedArchiveImport {
  kind: 'ready';
  record: NewArchiveImportRecord;
  root: ScopeRoot;
  /**
   * Completed imports these files may be a copy of; empty when they cannot be.
   */
  copies: ArchiveImportRecord[];
  /**
   * The source whose connector can read this format as one of its inputs, and
   * what the export says of its account. Present only when a source is
   * registered for the format (source-targets.ts); `resolveArchiveTarget`
   * then decides whether the import joins it.
   */
  source?: { sourceId: string; evidence: ArchiveAccountEvidence };
}

export type ArchiveImportPreparation =
  | PreparedArchiveImport
  | Exclude<ArchiveImportStart, { kind: 'started' }>;

export function prepareArchiveImport(input: {
  state: ArchiveImportStateStore;
  /**
   * The canonical absolute path of the chosen file or folder.
   */
  path: string;
  /**
   * Test seam: the formats to detect among.
   */
  formats?: readonly ArchiveFormatDefinition[];
  /**
   * The sources an archive can be an input of. Without them every import
   * stays under Archives.
   */
  targets?: ArchiveSourceTargets;
}): ArchiveImportPreparation {
  const path = input.path;
  if (!path.startsWith('/') || path.includes('\0')) return { kind: 'unreadable', code: 'escape' };
  let kind: 'file' | 'directory';
  try {
    if (realpathSync.native(path) !== path) return { kind: 'unreadable', code: 'escape' };
    const stat = lstatSync(path);
    if (stat.isFile()) kind = 'file';
    else if (stat.isDirectory()) kind = 'directory';
    else return { kind: 'unreadable', code: 'not_regular' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { kind: 'unreadable', code: code === 'EPERM' || code === 'EACCES' ? 'permission_denied' : 'not_found' };
  }
  const rootPath = kind === 'file' ? posix.dirname(path) : path;
  const chosenRelPath = kind === 'file' ? posix.basename(path) : '';
  let root: ScopeRoot;
  try {
    root = ScopeRoot.open(rootPath);
  } catch (error) {
    return { kind: 'unreadable', code: error instanceof ScopeSafeError ? error.code : 'io' };
  }
  let handedOver = false;
  try {
    const probe = probeArchivePath(root, chosenRelPath, {
      probeNames: archiveProbeNames(input.formats),
      signatureNames: archiveSignatureNames(input.formats),
    });
    const detection = detectArchiveFormat(probe, input.formats);
    // Files the first look did not reach, in the folder or in a zip: counted, never silent. A refusal says so in the
    // detection's own advice (one sentence for every way a look can be incomplete).
    const notLookedAt = archiveFilesNotLookedAt(probe);
    if (detection.kind === 'none') {
      return { kind: 'unsupported', supported: detection.supported, ...(detection.advice ? { advice: detection.advice } : {}) };
    }
    if (detection.kind === 'ambiguous') return { kind: 'ambiguous', formats: detection.formats };
    const relPaths = detection.files.map((file) => (file === '' ? chosenRelPath : joinRelative(chosenRelPath, file)));
    // A folder can hold more than the first look takes in, and files that look like exports
    // without saying so: neither is silent, both are counted on the record.
    const unconfirmed = detection.format.unconfirmed?.(probe) ?? 0;
    const skipped: Record<string, number> = {
      ...(notLookedAt > 0 ? { [ARCHIVE_COMMON_FINDINGS.filesNotLookedAt]: notLookedAt } : {}),
      ...(unconfirmed > 0 ? { [ARCHIVE_COMMON_FINDINGS.filesUnconfirmed]: unconfirmed } : {}),
    };
    const files = buildArchiveManifest(root, relPaths);
    const records = input.state.list();
    const same = findSameVersionImport(records, files) ?? findSameInProgressImport(records, files);
    if (same) return { kind: 'already_imported', archive: same };
    // The source that reads this format as one of its inputs, and what the export says of its account.
    const sourceTarget = input.targets?.forFormat(detection.format.id);
    let evidence: ArchiveAccountEvidence | undefined;
    if (sourceTarget) {
      try {
        evidence = sourceTarget.identify({ format: detection.format.id, root, chosenRelPath, files });
      } catch {
        // An export whose profile could not be read cannot be shown to belong to the account: it stays apart.
        evidence = { kind: 'archives' };
      }
    }
    handedOver = true;
    return {
      kind: 'ready',
      root,
      copies: findProbableCopies(records, files),
      ...(sourceTarget && evidence ? { source: { sourceId: sourceTarget.sourceId, evidence } } : {}),
      record: {
        format: detection.format.id,
        provider: detection.format.provider,
        family: detection.format.family,
        label: probe.chosen.name,
        root_path: root.path,
        root_identity: { dev: root.identity.dev, ino: root.identity.ino },
        chosen_rel_path: chosenRelPath,
        files,
        manifest_sha256: archiveManifestSha256(files),
        ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
      },
    };
  } catch (error) {
    if (error instanceof ScopeSafeError) return { kind: 'unreadable', code: error.code };
    throw error;
  } finally {
    if (!handedOver) root.close();
  }
}

/**
 * Where a prepared import goes (docs/design/archive-live-one-dataset.md,
 * section 7): `joined` (into the account of the source it is an input of,
 * recorded on `prepared.record.target`), `unproven` (the export cannot be
 * matched to the account: the import sheet asks the owner, then asks again
 * with `ownerConfirmed`), or `apart` (it stays under Archives: a different
 * account, an export the source cannot take, or the owner's choice).
 * A format no source reads is `apart` with no reason to say.
 */
export type ArchiveTargetResolution =
  | { kind: 'joined'; target: ArchiveImportTarget }
  | { kind: 'unproven'; sourceId: string }
  | { kind: 'apart'; reason: 'no_source' | 'not_this_source' | 'different_account' | 'owner_choice' };

/**
 * Resolves the account a prepared import joins, recording what that
 * establishes (a new account, the export's account on an entry that named
 * none, labels it did not have): inside the source's exclusive runner when it
 * has one, so an account guard cannot bind another account in between. Each
 * pass resolves the account again before it writes. Throws what the storage
 * service throws for an account that is being deleted or moved.
 */
export async function resolveArchiveTarget(
  prepared: PreparedArchiveImport,
  options: {
    targets: ArchiveSourceTargets;
    env: LayoutEnv;
    ownerConfirmed?: boolean;
    keepApart?: boolean;
  },
): Promise<ArchiveTargetResolution> {
  const source = prepared.source;
  if (!source) return { kind: 'apart', reason: 'no_source' };
  const target = options.targets.forSource(source.sourceId);
  if (!target) return { kind: 'apart', reason: 'no_source' };
  if (options.keepApart === true) return { kind: 'apart', reason: 'owner_choice' };
  if (source.evidence.kind === 'archives') return { kind: 'apart', reason: 'not_this_source' };
  const importAccountId = source.evidence.kind === 'account' ? source.evidence.importAccountId : undefined;
  // The account the owner's yes is about is read in the same step that resolved it, under the same lock.
  const resolve = () => {
    const resolution = resolveImportAccount(source.sourceId, importAccountId, {
      env: options.env,
      ...(options.ownerConfirmed === true ? { ownerConfirmed: true } : {}),
    });
    // An account this very step created (no entry before, none named by the export) is bound as the confirmed
    // one: nothing else could have been confirmed about it, and the first pass must see it as the same account.
    const created = resolution.match === 'new' && resolution.account !== undefined;
    const identity = (options.ownerConfirmed === true || created) && resolution.account ? importAccountIdentity(source.sourceId, options.env) : undefined;
    return { resolution, identity };
  };
  const { resolution: resolved, identity } = target.exclusive ? await target.exclusive(async () => resolve()) : resolve();
  if (resolved.match === 'different') return { kind: 'apart', reason: 'different_account' };
  if (resolved.match === 'unproven' || !resolved.account) return { kind: 'unproven', sourceId: source.sourceId };
  const joined: ArchiveImportTarget = {
    source_id: source.sourceId,
    slot: resolved.account.slot,
    ...(importAccountId !== undefined ? { import_account_id: importAccountId } : {}),
    ...(options.ownerConfirmed === true || (resolved.match === 'new' && identity !== undefined) ? { owner_confirmed: true as const } : {}),
    ...(identity !== undefined ? { confirmed_account: identity } : {}),
  };
  prepared.record.target = joined;
  return { kind: 'joined', target: joined };
}

/**
 * An import the owner confirmed stopped because the source holds another account
 * now (`account_changed`): the owner is asked again, and a yes about the account
 * the source holds today puts the import back to importing from where it stopped,
 * bound to that account. Resolved inside the source's exclusive runner like the
 * first answer. Returns the resumed record, or undefined when the export does not
 * join the account that is there (the import stays stopped).
 */
export async function reconfirmArchiveTarget(
  state: ArchiveImportStateStore,
  archive: ArchiveImportRecord,
  options: { targets: ArchiveSourceTargets },
): Promise<ArchiveImportRecord | undefined> {
  const joined = archive.target;
  if (!joined) return undefined;
  const target = options.targets.forSource(joined.source_id);
  if (!target) return undefined;
  const settle = (): string | undefined => {
    const resolved = resolveImportAccount(joined.source_id, joined.import_account_id, { env: state.env, ownerConfirmed: true });
    if ((resolved.match !== 'same' && resolved.match !== 'new') || !resolved.account) return undefined;
    return importAccountIdentity(joined.source_id, state.env);
  };
  const identity = target.exclusive ? await target.exclusive(async () => settle()) : settle();
  if (identity === undefined) return undefined;
  const record = state.update(archive.archive_id, (entry) => {
    if (entry.status !== 'stopped' || entry.stop?.code !== 'account_changed' || !entry.target) return false;
    entry.target.owner_confirmed = true;
    entry.target.confirmed_account = identity;
    entry.status = 'importing';
    delete entry.stop;
  });
  return record?.status === 'importing' ? record : undefined;
}

/**
 * Records a prepared import, once `digests` (every file's whole-file
 * SHA-256, when the preparation named possible copies) said it is not one.
 * The files must still be the versions the preparation pinned, and another
 * approval of the same files in the meantime wins. Does not close the root.
 *
 * The imports it may be a copy of are read again here, not taken from the
 * preparation: reading the files whole can take minutes, and an import
 * removed (or being removed) meanwhile no longer holds them, so this one
 * is recorded instead.
 */
export function commitArchiveImport(
  state: ArchiveImportStateStore,
  prepared: PreparedArchiveImport,
  digests?: readonly string[],
): ArchiveImportStart {
  if (prepared.copies.length > 0) {
    if (!digests) throw new Error('A possible copy is recorded only once its files were read whole.');
    const copy = findProbableCopies(state.list(), prepared.record.files).find((record) => isCopyOf(record, digests));
    if (copy) return { kind: 'already_imported', archive: copy };
  }
  try {
    const check = verifyArchiveManifest(prepared.root, prepared.record.files);
    if (!check.ok) return { kind: 'unreadable', code: 'changed' };
  } catch (error) {
    if (error instanceof ScopeSafeError) return { kind: 'unreadable', code: error.code };
    throw error;
  }
  const list = state.list();
  const same = findSameVersionImport(list, prepared.record.files) ?? findSameInProgressImport(list, prepared.record.files);
  if (same) return { kind: 'already_imported', archive: same };
  return { kind: 'started', archive: state.create(prepared.record) };
}

export function startArchiveImport(input: {
  state: ArchiveImportStateStore;
  /**
   * The canonical absolute path of the chosen file or folder.
   */
  path: string;
  /**
   * Test seam: the formats to detect among.
   */
  formats?: readonly ArchiveFormatDefinition[];
}): ArchiveImportStart {
  const prepared = prepareArchiveImport(input);
  if (prepared.kind !== 'ready') return prepared;
  try {
    const digests = prepared.copies.length > 0
      ? prepared.record.files.map((file) => archiveFileSha256(prepared.root, file))
      : undefined;
    return commitArchiveImport(input.state, prepared, digests);
  } catch (error) {
    if (error instanceof ScopeSafeError) return { kind: 'unreadable', code: error.code };
    throw error;
  } finally {
    prepared.root.close();
  }
}
