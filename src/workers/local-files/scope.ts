/**
 * The approved folders of the local files source, as the connector reads them.
 *
 * The approval itself (account generation, revision, selections) is the shared
 * one in `core/source-scope-approval.ts`. This module answers the one question
 * a connector asks: may this path be listed, and may its content be read.
 *
 * Rules, in order:
 *  1. A folder that is off by default (`paths.ts`) is denied unless the person
 *     selected that folder, or one below it, explicitly. A selection above it
 *     does not turn it on.
 *  2. An `exclude` selection anywhere on the path wins over everything.
 *  3. A `metadata_only` selection anywhere on the path keeps content unread.
 *  4. Otherwise the path needs an `ingest` selection above it (or "whole
 *     computer").
 *
 * Before all of them: the data owner lock is never listed or read, whatever
 * the person selected (see `decideLocalFilesPath`).
 */
import { isDataOwnerLockName } from '../../core/data-owner-lock.ts';
import type { SourceIngestionPolicy } from '../../core/source-ingestion-policy.ts';
import type { FileSourceScopeApprovalSnapshot } from '../../core/source-scope-approval.ts';
import type { FileSourceScopeAuthority, FileSourceScopePolicyRef } from '../source-scope-runtime.ts';
import {
  deepestDefaultExclusion,
  normalizeScopePath,
  scopePathDepth,
  scopePathIsWithin,
  scopePathsIgnoreCase,
  type DefaultExclusionContext,
} from './paths.ts';

export const LOCAL_FILES_SOURCE_ID = 'local.files';
export const LOCAL_FILES_PROVIDER = 'local_files';
export const LOCAL_FILES_ACCOUNT_SCOPE = 'this_computer';
/** What the ingestion policy and the approved-scope keys call this source. */
export const LOCAL_FILES_POLICY_SOURCE = `${LOCAL_FILES_PROVIDER}.${LOCAL_FILES_ACCOUNT_SCOPE}`;

export type LocalFilesDecision = 'content' | 'metadata' | 'denied';

export interface LocalFilesContentScope {
  generation: string;
  revision: string;
  /** Throws when the approval this scope was built for is no longer the current one. */
  assertCurrent(): void;
  /**
   * Whether the volume holding this scope path ignores case: the one decision
   * `decide`, watcher replay and the search for what is gone all share.
   * Absent on a scope that cannot say: case then matters.
   */
  ignoresCase?(scopePath: string): boolean;
  decide(scopePath: string): LocalFilesDecision;
  /**
   * Checks the approval is current once and returns a decider over exactly
   * that approval. A pass that decides thousands of paths asks for one of
   * these per page instead of re-reading the approval for every path.
   */
  snapshotDecider(): (scopePath: string) => LocalFilesDecision;
  /** The selected folders that are not excluded: the roots a pass lists. */
  roots(): Array<{ scopePath: string; state: 'ingest' | 'metadata_only' }>;
}

export function decideLocalFilesPath(
  approval: Pick<FileSourceScopeApprovalSnapshot, 'selections' | 'wholeAccount'>,
  scopePath: string,
  context: DefaultExclusionContext,
): LocalFilesDecision {
  const path = normalizeScopePath(scopePath);
  // The data owner lock (core/data-owner-lock.ts) sits in Olympus's own data
  // folder, which a whole-computer pass reaches on a standalone Linux install.
  // This process may hold that lock, and reading the file would close a
  // descriptor on it and drop the lock, so it is denied outright.
  if (isDataOwnerLockName(path.slice(path.lastIndexOf('/') + 1))) return 'denied';
  const selected = approval.selections
    .map((selection) => ({ key: safeKey(selection.key), state: selection.state }))
    .filter((selection): selection is { key: string; state: typeof approval.selections[number]['state'] } =>
      // Saved keys carry the spelling the folder had when it was chosen; a
      // later rename in Finder (`Private` -> `private`) must not undo them.
      selection.key !== undefined && scopePathIsWithin(path, selection.key, context));

  const defaultOff = deepestDefaultExclusion(path, context);
  if (defaultOff) {
    const governing = selected.reduce<number>((depth, selection) => Math.max(depth, scopePathDepth(selection.key)), -1);
    if (governing < scopePathDepth(defaultOff.path)) return 'denied';
  }
  if (selected.some((selection) => selection.state === 'exclude')) return 'denied';
  if (!approval.wholeAccount && !selected.some((selection) => selection.state !== 'exclude')) return 'denied';
  if (selected.some((selection) => selection.state === 'metadata_only')) return 'metadata';
  return approval.wholeAccount || selected.some((selection) => selection.state === 'ingest') ? 'content' : 'denied';
}

function safeKey(key: string): string | undefined {
  try { return normalizeScopePath(key); } catch { return undefined; }
}

export function localFilesRoots(
  approval: Pick<FileSourceScopeApprovalSnapshot, 'selections' | 'wholeAccount'>,
): Array<{ scopePath: string; state: 'ingest' | 'metadata_only' }> {
  // Whole computer: the one root is the top of the primary disk, read in
  // full except what is excluded or off by default. (Other disks are chosen
  // by name, since a disk mounted later is a different place.)
  if (approval.wholeAccount) return [{ scopePath: '/', state: 'ingest' }];
  const roots: Array<{ scopePath: string; state: 'ingest' | 'metadata_only' }> = [];
  for (const selection of approval.selections) {
    if (selection.state === 'exclude') continue;
    const scopePath = safeKey(selection.key);
    if (scopePath) roots.push({ scopePath, state: selection.state });
  }
  return roots;
}

export function createScopeBoundLocalFilesContentScope(input: {
  authority: FileSourceScopeAuthority;
  ref: FileSourceScopePolicyRef;
  context: DefaultExclusionContext;
}): LocalFilesContentScope {
  const current = (): FileSourceScopeApprovalSnapshot => input.authority.assertCurrent(input.ref);
  return {
    generation: input.ref.accountGeneration,
    revision: input.ref.revision,
    assertCurrent() { current(); },
    ignoresCase: (scopePath) => scopePathsIgnoreCase(input.context, scopePath),
    decide: (scopePath) => decideLocalFilesPath(current(), scopePath, input.context),
    snapshotDecider() {
      const approval = current();
      return (scopePath) => decideLocalFilesPath(approval, scopePath, input.context);
    },
    roots: () => localFilesRoots(current()),
  };
}

/** The local files source's ingestion policy: the file-type defaults, and one root per approved folder. */
export function fileSourceScopeLocalFilesPolicy(
  base: SourceIngestionPolicy,
  approval: FileSourceScopeApprovalSnapshot,
): SourceIngestionPolicy {
  if (approval.sourceId !== LOCAL_FILES_SOURCE_ID || approval.status !== 'approved') return { ...base, roots: [] };
  return {
    ...base,
    roots: localFilesRoots(approval).map(({ scopePath, state }) => ({
      path: scopePath,
      approved_scope_key: `${LOCAL_FILES_POLICY_SOURCE}:${scopePath}`,
      default_action: state === 'ingest' ? 'full_extract' as const : 'metadata_only' as const,
    })),
  };
}
