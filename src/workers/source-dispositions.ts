// The ingestion-dispositions model: what the owner's folder choices are, and
// the only writer of their ingestion-dispositions file. (The page that used to
// render it is gone: the panel's picker chooses folders through the setup
// tools, unified dashboard phase 4, 2026-10-09.)
//
// Split out of source-dashboard.ts rather than added to it, for two reasons
// that are not tidiness:
//
//   1. THE DASHBOARD IS COUNTS-ONLY AND SAYS SO ON ITS OWN FACE. Its header
//      promises no file names and no paths, `/dashboard.json` carries
//      `file_paths_returned: false`, and the whole view model is serialized
//      into that page. A folder picker is made of folder names. Putting one in
//      that view model would have made the page's own promise false for every
//      reader of it, including anyone the owner shows a screenshot to. So this
//      is a separate page with its own honest policy block, and
//      `/dashboard.json` is untouched.
//   2. THIS PAGE WRITES. Everything else on the dashboard reads. Keeping the
//      one config writer in its own module is what makes "the web UI never
//      deletes store content" checkable by reading one file.
//
// What this page CANNOT do, deliberately: purge, strip, or delete anything at
// all. It writes configuration and then prints the exact commands, with the
// counts a dry run would print, so the destructive half stays a deliberate act
// at a terminal.
//
// Source-neutral by construction: it is handed sources, each with its own
// compiled gate and its own item locators. Nothing here knows a provider's
// name, and a source whose folders are named by identity rather than by path
// renders read-only instead of getting a tree that could never match.

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writePrivateFileAtomicSync } from '../core/atomic-file.ts';
import {
  applySourceDispositionEdits,
  buildSourceDispositionTree,
  sourceDispositionNonFolderRules,
  type SourceDispositionEdit,
  type SourceDispositionEditResult,
  type SourceDispositionItem,
  type SourceDispositionNonFolderRule,
  type SourceDispositionState,
  type SourceDispositionTree,
} from '../core/source-disposition-tree.ts';
import { OperationError } from '../core/operation-error.ts';
import type {
  OlympusFolderScopeSourceId,
  OlympusMailScopeDraft,
  OlympusMailScopeSourceId,
  OlympusSourceScopeStatus,
  OlympusSourceScopeSelection,
} from '../control-ui-contract.ts';
import {
  defaultSourceIngestionExclusionsPath,
  parseSourceIngestionExclusions,
  SOURCE_INGESTION_EXCLUSIONS_PATH_ENV,
  SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION,
  type SourceExclusionCriterionKind,
  type SourceExclusionMatcher,
  type SourceIngestionExclusions,
} from '../core/source-ingestion-exclusions.ts';

/**
 * One source the picker can show. Everything provider-shaped is on the caller's
 * side of this seam.
 */
export interface SourceDispositionsSource {
  /** The key this source's rules are written against, e.g. what `sources` holds. */
  source_id: string;
  label: string;
  /** Every corpus folded into this source's tree. One source may span trust bands. */
  corpus_ids: readonly string[];
  /** What this source can enforce, declared by the wiring that knows it. */
  enforceable: readonly SourceExclusionCriterionKind[];
  /** This source's own compiled gate. Never a shared one. */
  matcher: SourceExclusionMatcher;
  /** False when nothing is mounted to measure. Counts read 0, and the page says why. */
  store_present: boolean;
  /** The stored locators the tree is folded from. Called at most once. */
  items?: () => Iterable<SourceDispositionItem>;
  /**
   * Purge debt behind this source's gate: stored items an exclusion rule now
   * refuses, and stored content a metadata-only rule now refuses.
   *
   * Lazy, because the picker never needs either count and both are a full
   * locator scan — only the dashboard's ledger snapshot reads them, while the
   * stores this runtime opened are still open.
   */
  excludedItemsPresent?: () => { items: number; unevaluable: number };
  metadataOnlyContentPresent?: () => { items: number; unevaluable: number };
  /**
   * Why this source could not be prepared, when it could not.
   *
   * A gate refuses to compile when a rule names a source that cannot enforce
   * it, which is correct and is loud everywhere else. Here it must not be
   * fatal: this page is the tool an owner would reach for to FIX that rule, and
   * a picker that 500s on a bad rule is uneditable exactly when it is needed.
   * So the source renders with the refusal printed and no tree.
   */
  error?: string;
}

export interface SourceDispositionsSourceView {
  source_id: string;
  label: string;
  corpus_ids: string[];
  store_present: boolean;
  /** False when this source names folders by identity rather than by path. */
  editable_by_path: boolean;
  /** Blanket rules this source can enforce nothing of. Named, never silent. */
  unenforceable_rule_ids: string[];
  tree: SourceDispositionTree;
  /** Rules the three-state folder model cannot express. Read-only on the page. */
  non_folder_rules: SourceDispositionNonFolderRule[];
  error?: string;
}

export interface SourceFolderScopeSummary {
  /** Folder sources choose folders; the mail source chooses a window, categories, labels and senders. */
  kind?: 'folders' | 'mail';
  source_id: OlympusFolderScopeSourceId | OlympusMailScopeSourceId;
  disposition_source_id: string;
  /** Mail only: whether the approved scope starts ingestion. */
  ingestion_enabled?: boolean;
  /** Mail only: the saved choices, or the defaults while nothing is saved. */
  mail_scope?: OlympusMailScopeDraft;
  /** Mail only: the saved full-content cutoff (ISO timestamp). */
  content_after?: string;
  label: string;
  connected: boolean;
  status: OlympusSourceScopeStatus;
  account_generation?: string;
  scope_revision?: string;
  selections?: OlympusSourceScopeSelection[];
  whole_account_selected?: boolean;
  error?: string;
}

export interface SourceDispositionsView {
  kind: 'source_dispositions';
  generated_at: string;
  rules_path: string;
  rules_present: boolean;
  schema_version: typeof SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION;
  rule_count: number;
  sources: SourceDispositionsSourceView[];
  /** Private, status-only scope setup. Rendering never contacts a provider. */
  folder_scopes?: SourceFolderScopeSummary[];
  /**
   * What the owner has to run at a terminal to settle what is already stored.
   * Printed, never executed: this page changes configuration and nothing else.
   */
  cleanup: {
    dry_run_command: string;
    purge_command: string;
    strip_command: string;
    /** Summed over every source: what a purge run would remove today. */
    items_would_purge: number;
    /** Summed over every source: what a strip run would clear today. */
    items_would_strip: number;
    /** Summed over every source: rows both verbs keep because the gate cannot answer. */
    items_unevaluable: number;
  };
  policy: {
    folder_paths_returned: true;
    writes_config_only: boolean;
    deletes_store_content: false;
    runs_purge_or_strip: false;
  };
}

export const SOURCE_DISPOSITIONS_DRY_RUN_COMMAND = 'bun run source-exclusions:purge -- --dry-run';
export const SOURCE_DISPOSITIONS_PURGE_COMMAND = 'bun run source-exclusions:purge -- --purge';
export const SOURCE_DISPOSITIONS_STRIP_COMMAND = 'bun run source-exclusions:purge -- --strip-metadata-only';

export interface SourceDispositionsBuildOptions {
  sources: readonly SourceDispositionsSource[];
  folderScopes?: readonly SourceFolderScopeSummary[];
  document: SourceIngestionExclusions;
  rulesPath?: string;
  rulesPresent?: boolean;
  now?: Date;
  maxDepth?: number;
  maxNodes?: number;
}

export function buildSourceDispositionsView(
  options: SourceDispositionsBuildOptions,
): SourceDispositionsView {
  const now = options.now ?? new Date();
  const scopeSourceIds = new Set((options.folderScopes ?? []).map((source) => source.disposition_source_id));
  const sources = options.sources.filter((source) => !scopeSourceIds.has(source.source_id)).map((source): SourceDispositionsSourceView => {
    const tree = buildSourceDispositionTree({
      matcher: source.matcher,
      items: source.items?.() ?? [],
      ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
      ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
    });
    return {
      source_id: source.source_id,
      label: source.label,
      corpus_ids: [...source.corpus_ids],
      store_present: source.store_present,
      editable_by_path: source.error === undefined && source.enforceable.includes('path_prefix'),
      unenforceable_rule_ids: [...source.matcher.unenforceableRuleIds],
      tree,
      non_folder_rules: sourceDispositionNonFolderRules(options.document, source.source_id),
      ...(source.error !== undefined ? { error: source.error } : {}),
    };
  });
  const totals = sources.reduce(
    (sum, source) => ({
      purge: sum.purge + source.tree.counts.excluded_items_would_purge,
      strip: sum.strip + source.tree.counts.metadata_only_content_would_strip,
      unevaluable: sum.unevaluable + source.tree.counts.unevaluable_items,
    }),
    { purge: 0, strip: 0, unevaluable: 0 },
  );
  return {
    kind: 'source_dispositions',
    generated_at: now.toISOString(),
    rules_path: options.rulesPath ?? defaultSourceIngestionExclusionsPath(),
    rules_present: options.rulesPresent ?? true,
    schema_version: SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION,
    rule_count: options.document.rules.length,
    sources,
    ...(options.folderScopes ? { folder_scopes: [...options.folderScopes] } : {}),
    cleanup: {
      dry_run_command: SOURCE_DISPOSITIONS_DRY_RUN_COMMAND,
      purge_command: SOURCE_DISPOSITIONS_PURGE_COMMAND,
      strip_command: SOURCE_DISPOSITIONS_STRIP_COMMAND,
      items_would_purge: totals.purge,
      items_would_strip: totals.strip,
      items_unevaluable: totals.unevaluable,
    },
    policy: {
      folder_paths_returned: true,
      writes_config_only: !options.folderScopes?.length,
      deletes_store_content: false,
      runs_purge_or_strip: false,
    },
  };
}

/**
 * The owner's rules file as it sits on disk, plus the raw JSON of each rule.
 *
 * The raw half exists so a save can put every untouched rule back BYTE FOR
 * BYTE, including any field this build does not know about. Re-emitting a
 * parsed rule instead would quietly drop a key a newer build wrote and
 * normalize the owner's own formatting of the ones it kept — a picker that
 * rewrites lines nobody asked it to touch is a picker nobody can trust with a
 * file they hand-edited.
 */
export interface SourceIngestionExclusionsFile {
  path: string;
  present: boolean;
  document: SourceIngestionExclusions;
  rawRulesById: Map<string, unknown>;
}

export function resolveSourceIngestionExclusionsPath(
  env: Record<string, string | undefined> = process.env,
  explicitPath?: string,
): string {
  return explicitPath?.trim()
    || env[SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]?.trim()
    || defaultSourceIngestionExclusionsPath();
}

/**
 * Read the file, or report an empty document when there is none.
 *
 * A MISSING file is an empty configuration, which is correct. A file that
 * exists and cannot be parsed THROWS, and this function does not catch it:
 * treating a broken dispositions file as "nothing is excluded" is the exact
 * failure the gate exists to prevent, and doing it in the editor would then
 * offer to save the emptiness back over the owner's real rules.
 */
export function readSourceIngestionExclusionsFile(path: string): SourceIngestionExclusionsFile {
  if (!existsSync(path)) {
    return {
      path,
      present: false,
      document: { schemaVersion: SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION, rules: [] },
      rawRulesById: new Map(),
    };
  }
  const text = readFileSync(path, 'utf8');
  const raw = JSON.parse(text) as unknown;
  const document = parseSourceIngestionExclusions(raw, path);
  const rawRulesById = new Map<string, unknown>();
  const rawRules = (raw as { rules?: unknown }).rules;
  if (Array.isArray(rawRules)) {
    for (const entry of rawRules) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && id.trim()) rawRulesById.set(id.trim(), entry);
    }
  }
  return { path, present: true, document, rawRulesById };
}

/**
 * Serialize a document, putting untouched rules back exactly as they arrived.
 *
 * `preserveIds` is the set the edit reported as untouched. A rule outside it
 * is re-emitted from its parsed form, which is the honest thing to do for a
 * rule the edit actually changed.
 */
export function serializeSourceIngestionExclusions(
  document: SourceIngestionExclusions,
  rawRulesById: ReadonlyMap<string, unknown> = new Map(),
  preserveIds: ReadonlySet<string> = new Set(rawRulesById.keys()),
): string {
  const rules = document.rules.map((rule) => {
    const raw = preserveIds.has(rule.id) ? rawRulesById.get(rule.id) : undefined;
    if (raw !== undefined) return raw;
    return {
      id: rule.id,
      mode: rule.mode,
      ...(rule.sources.length > 0 ? { sources: [...rule.sources] } : {}),
      ...(rule.path_prefixes.length > 0 ? { path_prefixes: [...rule.path_prefixes] } : {}),
      ...(rule.folder_ids.length > 0 ? { folder_ids: rule.folder_ids.map((folder) => ({ ...folder })) } : {}),
      ...(rule.media ? { media: { ...rule.media } } : {}),
      reason: rule.reason,
    };
  });
  return `${JSON.stringify({ schemaVersion: document.schemaVersion, rules }, null, 2)}\n`;
}

export interface SourceIngestionExclusionsWriteResult {
  path: string;
  backup_path?: string;
  bytes: number;
  rule_count: number;
}

/**
 * Replace the owner's dispositions file, atomically, with a backup beside it.
 *
 * Four things happen here in this order, and the order is the point:
 *
 *   1. The bytes are PARSED BACK before anything touches disk. A file this
 *      process cannot read is a file that takes every ingestion lane down at
 *      the next boot, fail-closed and loud — which is correct behaviour for a
 *      hand-edited file and unacceptable as something a button did.
 *   2. The existing file is COPIED to a timestamped backup. Before, not after:
 *      a backup written after the replace is a copy of the new file.
 *   3. The new bytes go to a temp file in the same directory at mode 0600, are
 *      FLUSHED, and are RENAMED over the target, with the directory flushed
 *      after. A reader never sees a half-written dispositions file — which the
 *      gate would refuse to parse, taking the lane down over a partial write —
 *      and a power loss cannot reorder the rename ahead of the bytes and leave
 *      an empty one behind.
 *   4. A symlink at the target is REFUSED. Following one would write the
 *      owner's configuration somewhere they did not choose.
 */
export function writeSourceIngestionExclusionsFile(options: {
  path: string;
  document: SourceIngestionExclusions;
  rawRulesById?: ReadonlyMap<string, unknown>;
  preserveIds?: ReadonlySet<string>;
  now?: Date;
}): SourceIngestionExclusionsWriteResult {
  const { path } = options;
  const text = serializeSourceIngestionExclusions(
    options.document,
    options.rawRulesById ?? new Map(),
    options.preserveIds ?? new Set((options.rawRulesById ?? new Map()).keys()),
  );
  const reparsed = parseSourceIngestionExclusions(JSON.parse(text) as unknown, path);
  if (reparsed.schemaVersion !== SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION) {
    throw new OperationError('config_error', 'Ingestion dispositions schemaVersion must stay 1.');
  }
  const stamp = (options.now ?? new Date()).toISOString().split(':').join('').split('.').join('');
  let backupPath: string | undefined;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new OperationError(
        'config_error',
        'The ingestion dispositions path is not a regular file; refusing to write through it.',
      );
    }
    backupPath = `${path}.${stamp}.bak`;
    copyFileSync(path, backupPath);
    chmodSync(backupPath, 0o600);
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  writePrivateFileAtomicSync(path, text);
  return {
    path,
    ...(backupPath ? { backup_path: backupPath } : {}),
    bytes: Buffer.byteLength(text, 'utf8'),
    rule_count: reparsed.rules.length,
  };
}

export interface SourceDispositionsSaveRequest {
  /** The source the edits are scoped to, when they came from one source's tree. */
  source?: string;
  enforceable?: readonly SourceExclusionCriterionKind[];
  /** Tree edits. Applied by the engine against the file as it is on disk now. */
  edits?: readonly SourceDispositionEdit[];
  /**
   * A whole schemaVersion-1 document, for a caller that computed one itself.
   * Parsed before it is used; a document that does not parse never reaches
   * disk. When both are present the edits are applied ON TOP of this document.
   */
  document?: unknown;
}

export interface SourceDispositionsSaveResult extends SourceDispositionEditResult {
  write?: SourceIngestionExclusionsWriteResult;
  /** True when nothing changed, so nothing was written and no backup was made. */
  noop: boolean;
}

/**
 * Apply a save against the file as it is on disk RIGHT NOW.
 *
 * Re-read rather than trusting a document the page was rendered from: the page
 * may have been open for an hour, and a save built on a stale document would
 * silently revert whatever the CLI or a hand edit did in between.
 */
export function saveSourceDispositions(
  path: string,
  request: SourceDispositionsSaveRequest,
): SourceDispositionsSaveResult {
  const file = readSourceIngestionExclusionsFile(path);
  const base = request.document !== undefined
    ? parseSourceIngestionExclusions(request.document, 'submitted ingestion dispositions')
    : file.document;
  const edits = request.edits ?? [];
  const result = applySourceDispositionEdits(base, edits, {
    ...(request.source ? { source: request.source } : {}),
    ...(request.enforceable ? { enforceable: request.enforceable } : {}),
  });
  // A submitted document is itself a change, even with no edits on top of it.
  const documentChanged = request.document !== undefined
    && serializeSourceIngestionExclusions(base) !== serializeSourceIngestionExclusions(file.document);
  if (!result.changed && !documentChanged) {
    return { ...result, noop: true };
  }
  // Only rules the edit left alone keep their original bytes, and only when the
  // base document is the file itself. A submitted document replaces the file's
  // own text, so nothing from it may be resurrected from the old raw rules.
  const preserveIds = request.document !== undefined
    ? new Set<string>()
    : new Set(result.untouched_rule_ids);
  const write = writeSourceIngestionExclusionsFile({
    path,
    document: result.rules,
    rawRulesById: file.rawRulesById,
    preserveIds,
  });
  return { ...result, write, noop: false };
}
