import { DISPOSITIONS_CSS } from './dashboard/static-styles.ts';
export { DISPOSITIONS_CSS };
// The ingestion-dispositions picker: the page the owner chooses folders on, and
// the only writer of their ingestion-dispositions file.
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
  SOURCE_DISPOSITION_STATE_LABELS,
  type SourceDispositionEdit,
  type SourceDispositionEditResult,
  type SourceDispositionItem,
  type SourceDispositionNode,
  type SourceDispositionNonFolderRule,
  type SourceDispositionState,
  type SourceDispositionTree,
} from '../core/source-disposition-tree.ts';
import { OperationError } from '../core/operation-error.ts';
import { DASHBOARD_THEME_CSS } from './dashboard/theme.ts';
import { dashboardPageSignature } from './dashboard/components.ts';
import type { OlympusDashboardReadResult, OlympusFolderScopeSourceId, OlympusSourceScopeStatus, OlympusSourceScopeSelection } from '../control-ui-contract.ts';
import { mountDispositionsController } from '../control-ui/browser-controller.ts';
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
  source_id: OlympusFolderScopeSourceId;
  disposition_source_id: string;
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
    mkdirSync(dirname(path), { recursive: true });
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATE_ORDER: readonly SourceDispositionState[] = ['ingest', 'metadata_only', 'exclude'];
/**
 * Said once, in both places it has to appear: the source-level warning above
 * the tree, and the inspector note on every row whose choices are dead because
 * of it. One string so the two can never drift apart.
 */
const NOT_EDITABLE_BY_PATH_REASON = 'This source names folders by identity rather than by path, '
  + 'so the folder tree cannot edit its rules.';
const PICKER_STATE_LABELS: Readonly<Record<SourceDispositionState, string>> = {
  ingest: 'Full ingestion',
  metadata_only: 'Metadata only',
  exclude: 'No ingestion',
};

/**
 * Which of the three states this folder can actually be moved to.
 *
 * Not cosmetic: the same rules the engine refuses a save on. A control the page
 * offers and the server then refuses is worse than no control, because the
 * owner reads the refusal as a bug rather than as the shape of their
 * configuration.
 *
 *   - Under an excluded ancestor, nothing is selectable. There is no include
 *     rule, and metadata-only loses to an exclusion however it is ordered.
 *   - Under a metadata-only ancestor, only the stricter state is selectable.
 *   - A folder decided by a rule that is not a folder path is not selectable at
 *     all; those rules are listed read-only beside the tree.
 */
export function selectableDispositionStates(
  node: SourceDispositionNode,
  ancestorState: SourceDispositionState,
): SourceDispositionState[] {
  if (node.origin !== 'explicit' && node.unevaluable) return [];
  if (ancestorState === 'exclude') return [];
  if (ancestorState === 'metadata_only') return ['exclude'];
  if (node.origin === 'inherited' || (node.origin === 'default' && node.state !== 'ingest')) return [];
  return [...STATE_ORDER];
}

export function renderSourceDispositionsHtml(
  view: SourceDispositionsView,
  options?: { csrfToken?: string | undefined },
): string {
  const body = renderSourceDispositionsFragment(view);
  const csrfToken = escapeScriptJson(JSON.stringify(options?.csrfToken ?? ''));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Olympus — Choose folders</title>
    <style>${DASHBOARD_THEME_CSS}\n${DISPOSITIONS_CSS}</style>
  </head>
  <body>
    <div data-olympus-dispositions-root>${body}</div>
    ${standaloneSourceDispositionsControllerScript(csrfToken)}
  </body>
</html>`;
}

export function renderSourceDispositionsFragment(view: SourceDispositionsView): string {
  const scopedSources = new Set((view.folder_scopes ?? []).map((source) => source.disposition_source_id));
  const sources = (view.folder_scopes ?? []).map(renderFolderScopeSource).join('')
    + view.sources.filter((source) => !scopedSources.has(source.source_id)).map(renderDispositionSource).join('');
  return `<main class="picker-page">
      <header class="picker-header">
        <p class="eyebrow">Olympus / Sources</p>
        <h1>Choose folders</h1>
        <p>Connecting an account does not start indexing. Browse folders, choose what Olympus may use,
        then press <strong>Save scope and start</strong>. Unselected folders stay out. Choose <strong>Metadata only</strong>
        for large photo or video folders — or anything you want searchable by name and date without
        processing its contents. Choose <strong>No ingestion</strong> to keep a folder out of Olympus
        entirely. New files inherit the nearest folder choice.</p>
      </header>
      ${sources}
      <p class="action-message" id="save-message" role="status" aria-live="polite"></p>
    </main>`;
}

function renderFolderScopeSource(source: SourceFolderScopeSummary): string {
  const unavailable = !source.connected || Boolean(source.error);
  return `<section class="source-dispositions">
    <form data-folder-scope-source="${escapeHtml(source.source_id)}"
      data-connected="${source.connected}" data-account-generation="${escapeHtml(source.account_generation ?? '')}"
      data-scope-revision="${escapeHtml(source.scope_revision ?? '')}"
      data-scope-selections="${escapeHtml(JSON.stringify(source.selections ?? []))}">
      <div class="finder-window">
        <aside class="finder-sidebar"><p class="sidebar-label">Locations</p><div class="location selected"><span class="folder-icon">◆</span><span>${escapeHtml(source.label)}</span></div>
          <p class="scope-connection">${source.connected ? source.status === 'approved' ? 'Scope approved' : 'Waiting for your selection' : 'Disconnected'}</p>
        </aside>
        <section class="finder-main">
          <div class="finder-toolbar"><input type="search" data-scope-search placeholder="Search listed folders" aria-label="Search listed folders"></div>
          <div class="scope-browser-toolbar"><button type="button" data-scope-browse-root${unavailable ? ' disabled' : ''}>Browse folders</button>
            <span data-scope-location>Folders</span></div>
          <p class="scope-browser-note">${source.error ? escapeHtml(source.error) : source.connected
            ? 'Browsing lists folder names only. No file contents are read or indexed until you confirm your scope.'
            : 'Connect this account first, then return here to choose folders. Connecting will not start ingestion.'}</p>
          ${source.connected ? '' : `<a href="/dashboard?source=${encodeURIComponent(source.source_id)}">Connect ${escapeHtml(source.label)} →</a>`}
          <div class="tree-viewport scope-browser-list" data-scope-nodes role="list" aria-label="Folders"></div>
          <button type="button" data-scope-more hidden>Show more folders</button>
          <label class="scope-whole-account"><input type="checkbox" data-scope-whole-account${source.whole_account_selected ? ' checked' : ''}${unavailable ? ' disabled' : ''}> Use the entire account, including future folders, except choices below</label>
          <label class="scope-whole-confirm"${source.whole_account_selected ? '' : ' hidden'}><input type="checkbox" data-scope-whole-confirm${unavailable ? ' disabled' : ''}> I explicitly approve using the entire account</label>
          <details class="scope-review"><summary>Review your folder choices</summary><ul data-scope-selections></ul></details>
        </section>
        <aside class="finder-inspector" aria-label="Folder choice">
          <div data-scope-inspector-empty><div class="inspector-folder">▱</div><p>Select a folder</p></div>
          <div data-scope-inspector-content hidden><div class="inspector-folder">▰</div>
          <h3 data-scope-selected-name></h3><p class="inspector-path" data-scope-selected-path></p>
          <div class="choice-stack" aria-label="Ingestion choice">
            <button type="button" data-scope-state="ingest" disabled>Full ingestion<span>Read and index contents</span></button>
            <button type="button" data-scope-state="metadata_only" disabled>Metadata only<span>Index names and dates; never contents</span></button>
            <button type="button" data-scope-state="exclude" disabled>No ingestion<span>Keep this folder out</span></button>
          </div><p class="inspector-note" data-scope-selected-note></p></div>
        </aside>
        <footer class="finder-footer"><span data-scope-summary>No folders selected.</span>
          <span class="footer-actions"><button type="button" class="secondary" data-scope-cancel>Cancel changes</button>
            <button type="submit" data-scope-start disabled>Save scope and start</button></span></footer>
      </div>
      <p class="action-message" data-scope-message role="status" aria-live="polite">Nothing starts until you confirm.</p>
    </form>
  </section>`;
}

export function renderSourceDispositionsControlUi(
  view: SourceDispositionsView,
  canWrite: boolean,
): OlympusDashboardReadResult {
  const body = renderSourceDispositionsFragment(view);
  return {
    status: 200,
    title: 'Olympus / Choose folders',
    body,
    controller: 'dispositions',
    can_write: canWrite,
    signature: dashboardPageSignature(body),
    poll_interval_ms: 15_000,
  };
}

function standaloneSourceDispositionsControllerScript(csrfTokenJson: string): string {
  const mountSource = mountDispositionsController.toString().replaceAll('</script', '<\\/script');
  return `<script>
    (function () {
      var csrfToken = ${csrfTokenJson};
      var root = document.querySelector('[data-olympus-dispositions-root]');
      if (!root) return;
      var abort = new AbortController();
      var mount = ${mountSource};
      async function json(response) {
        try { return await response.json(); } catch (error) { return {}; }
      }
      var controller = mount({
        root: root,
        transport: {
          async read(params) {
            var response = await fetch('/dashboard/dispositions', {
              method: 'POST', cache: 'no-store', credentials: 'same-origin',
              headers: { 'X-Olympus-CSRF': csrfToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'browse_folder_scope', source_id: params.source_id,
                parent_key: params.parent_key, cursor: params.cursor }),
            });
            var body = await json(response);
            return Object.assign({}, body, { status: response.status });
          },
          async control(params) {
            if (params.action !== 'save_dispositions' && params.action !== 'approve_source_scope_and_start') {
              return { status: 400, body: { error: { message: 'Unsupported picker action.' } } };
            }
            var response = await fetch('/dashboard/dispositions', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'X-Olympus-CSRF': csrfToken, 'Content-Type': 'application/json' },
              body: JSON.stringify(params.action === 'save_dispositions'
                ? { source: params.source, edits: params.edits }
                : params),
            });
            return { status: response.status, body: await json(response) };
          },
          async renew() {
            await fetch('/dashboard/control/session', {
              method: 'POST', cache: 'no-store', credentials: 'same-origin',
              headers: { 'X-Olympus-CSRF': csrfToken },
            });
          },
        },
        navigate: function (href) { window.location.assign(href); },
        refresh: async function () { window.location.reload(); return undefined; },
        returnUrl: window.location.href,
        canWrite: Boolean(csrfToken),
        authority: 'worker-session',
        signal: abort.signal,
        pollIntervalMs: 0,
      });
      window.addEventListener('pagehide', function () { controller.dispose(); abort.abort(); }, { once: true });
    })();
  </script>`;
}

function renderDispositionSource(source: SourceDispositionsSourceView): string {
  const counts = source.tree.counts;
  const fullItems = Math.max(0, counts.items - counts.excluded_items - counts.metadata_only_items);
  const summary = source.store_present
    ? `${fullItems} full ingestion · ${counts.metadata_only_items} metadata only · ${counts.excluded_items} no ingestion`
    : 'No folders discovered yet';
  const nodes = source.tree.roots.length > 0
    ? source.tree.roots.map((node) => renderDispositionNode(node, 'ingest', source.editable_by_path)).join('')
    : '<p class="subtle">No folders to show yet. They appear after the first sync.</p>';
  const failed = source.error !== undefined
    ? `<p class="warn-note"><strong>This source's rules could not be loaded.</strong>
        ${escapeHtml(source.error)}</p>`
    : '';
  // The three notes below are not decoration. Each names a reason a control on
  // this page cannot do what its shape promises: a source with no path
  // enforcement has three dead choice buttons and no Save, a blanket rule this
  // source cannot enforce is doing nothing at all, and a folder counted but not
  // listed is a row the owner cannot find. Rendering the tree without them is
  // what makes the page a silent dead end.
  const notEditable = source.editable_by_path || source.error !== undefined
    ? ''
    : `<p class="warn-note"><strong>${escapeHtml(NOT_EDITABLE_BY_PATH_REASON)}</strong>
        The folders below are shown read-only: the three choices stay disabled and there is nothing to save
        here. Edit this source's rules in the rules file instead.</p>`;
  const unenforceable = source.unenforceable_rule_ids.length > 0
    ? `<p class="warn-note"><strong>This source can enforce nothing of:</strong>
        ${source.unenforceable_rule_ids.map((id) => `<code>${escapeHtml(id)}</code>`).join(', ')}.
        Those rules are not silently ignored — they are named here.</p>`
    : '';
  const truncated = source.tree.truncated_nodes > 0
    ? `<p class="subtle">${source.tree.truncated_nodes} deeper
        ${source.tree.truncated_nodes === 1 ? 'folder is' : 'folders are'} counted into the rows above but
        not listed. Every folder a rule names is always listed, however deep.</p>`
    : '';
  const unplaced = source.tree.unplaced_items > 0
    ? `<p class="subtle">${source.tree.unplaced_items} stored ${
      source.tree.unplaced_items === 1
        ? 'item has no readable path, so it sits'
        : 'items have no readable path, so they sit'
    } in no folder here.</p>`
    : '';
  const treeNotes = truncated === '' && unplaced === ''
    ? ''
    : `<div class="tree-notes">${truncated}${unplaced}</div>`;
  return `
      <section class="source-dispositions" aria-labelledby="src-${escapeHtml(slugId(source.source_id))}">
        <form data-dispositions-source="${escapeHtml(source.source_id)}"${
    source.editable_by_path ? '' : ` data-locked="${escapeHtml(NOT_EDITABLE_BY_PATH_REASON)}"`
  }>
          <div class="finder-window">
            <aside class="finder-sidebar">
              <p class="sidebar-label">Locations</p>
              <div class="location selected"><span class="folder-icon">◆</span><span>${escapeHtml(source.label)}</span></div>
            </aside>
            <section class="finder-browser">
              <div class="finder-toolbar">
                <div><h2 id="src-${escapeHtml(slugId(source.source_id))}">${escapeHtml(source.label)}</h2><p>${escapeHtml(summary)}</p></div>
                <input type="search" data-folder-search placeholder="Search folders" aria-label="Search folders">
              </div>
              ${failed}
              ${notEditable}
              ${unenforceable}
              <div class="finder-columns" aria-hidden="true"><span>Name</span><span>Files</span><span>Olympus</span></div>
              <div class="tree">${nodes}</div>
              ${treeNotes}
            </section>
            <aside class="finder-inspector" aria-label="Folder choice">
              <div data-inspector-empty>
                <div class="inspector-folder">▱</div>
                <p>Select a folder</p>
              </div>
              <div data-inspector-content hidden>
                <div class="inspector-folder">▰</div>
                <h3 data-inspector-name></h3>
                <p class="inspector-path" data-inspector-path></p>
                <p class="inspector-count" data-inspector-count></p>
                <div class="choice-stack" aria-label="Ingestion choice">
                  <button type="button" data-picker-state="ingest">Full ingestion<span>Read and index contents</span></button>
                  <button type="button" data-picker-state="metadata_only">Metadata only<span>Index names and dates</span></button>
                  <button type="button" data-picker-state="exclude">No ingestion<span>Keep out of Olympus</span></button>
                </div>
                <p class="inspector-note" data-inspector-note></p>
              </div>
            </aside>
            <footer class="finder-footer">
              <span>${escapeHtml(summary)}</span>
              <span class="footer-actions"><button class="secondary" type="button" data-cancel-picker>Cancel</button>${
                source.editable_by_path && source.tree.roots.length > 0
                  ? '<button type="submit">Save</button>'
                  : ''
              }</span>
            </footer>
          </div>
        </form>
      </section>`;
}

function renderDispositionNode(
  node: SourceDispositionNode,
  ancestorState: SourceDispositionState,
  editable: boolean,
): string {
  const selectable = editable ? selectableDispositionStates(node, ancestorState) : [];
  // Why this row's three buttons will come back disabled, carried on the row so
  // the inspector can say it at the moment the owner clicks the folder. A
  // disabled control with no reason beside it reads as a broken page.
  //
  // Only the per-row reasons are written here. A source that cannot be edited
  // by path locks EVERY row for one reason, and a tree runs to four thousand
  // rows — so that one is written once on the form instead, and the script
  // falls back to it.
  const locked = selectable.length > 0 || !editable ? '' : lockedReason(node, ancestorState);
  const countLine = `${node.counts.items} ${node.counts.items === 1 ? 'item' : 'items'}`
    + (node.counts.excluded_items > 0 ? ` · ${node.counts.excluded_items} no ingestion` : '')
    + (node.counts.metadata_only_items > 0 ? ` · ${node.counts.metadata_only_items} metadata only` : '');
  const control = `<div class="stored-controls" aria-hidden="true">${
    STATE_ORDER.map((state) => renderStateRadio(node, state, selectable.includes(state))).join('')
  }</div>`;
  const children = node.children.length > 0
    ? `<div class="children">${node.children.map((child) => renderDispositionNode(child, node.state, editable)).join('')}</div>`
    : '';
  const status = node.mixed_below ? 'Mixed' : PICKER_STATE_LABELS[node.state];
  const row = `<span class="folder-icon" aria-hidden="true">▰</span><span class="node-name">${escapeHtml(node.name)}</span>`
    + `<span class="node-counts">${escapeHtml(`${node.counts.items}`)}</span>`
    + `<span class="node-state" data-folder-status>${escapeHtml(status)}</span>`;
  const data = `data-path="${escapeHtml(node.path)}" data-name="${escapeHtml(node.name)}"`
    + ` data-counts="${escapeHtml(countLine)}" data-search="${escapeHtml(`${node.display_path} ${node.name}`.toLowerCase())}"`
    + ` data-state="${node.state}" data-origin="${node.origin}" data-selectable="${escapeHtml(selectable.join(','))}"`
    + (locked === '' ? '' : ` data-locked="${escapeHtml(locked)}"`);
  if (node.children.length === 0) {
    return `
          <div class="node leaf">
            <div class="folder-row" tabindex="0" ${data}><span class="disclosure"></span>${row}</div>
            ${control}
          </div>`;
  }
  return `
          <details class="node"${
    node.depth === 1 ? ' open' : ''
  }>
            <summary class="folder-row" ${data}>${row}</summary>
            ${control}
            ${children}
          </details>`;
}

function renderStateChip(node: SourceDispositionNode): string {
  const label = SOURCE_DISPOSITION_STATE_LABELS[node.state];
  if (node.origin === 'explicit') {
    return `<span class="chip explicit ${node.state}">${escapeHtml(label)}<span class="chip-note">set here</span></span>`;
  }
  if (node.origin === 'inherited') {
    return `<span class="chip inherited ${node.state}">${escapeHtml(label)}<span class="chip-note">from ${
      escapeHtml(node.inherited_from ?? 'above')
    }</span></span>`;
  }
  if (node.unevaluable) {
    return `<span class="chip inherited ${node.state}">${escapeHtml(label)}<span class="chip-note">unevaluable</span></span>`;
  }
  return `<span class="chip default ${node.state}">${escapeHtml(label)}</span>`;
}

function renderStateRadio(
  node: SourceDispositionNode,
  state: SourceDispositionState,
  enabled: boolean,
): string {
  const checked = node.state === state ? ' checked' : '';
  const disabled = enabled ? '' : ' disabled';
  return `<label class="state ${state}${enabled ? '' : ' locked'}">
              <input type="radio" name="d:${escapeHtml(node.path)}" value="${state}"
                data-path="${escapeHtml(node.path)}" data-initial="${node.state}"${checked}${disabled}>
              <span>${escapeHtml(PICKER_STATE_LABELS[state])}</span>
            </label>`;
}

function lockedReason(node: SourceDispositionNode, ancestorState: SourceDispositionState): string {
  if (node.unevaluable) {
    return 'This folder cannot be evaluated from its path alone, so its choice is decided by a rule listed beside '
      + 'the tree rather than here.';
  }
  if (ancestorState === 'exclude') {
    return `Follows ${node.inherited_from ?? 'the folder above'}, which is excluded. Nothing under an excluded `
      + 'folder can be brought back on its own — change the choice on that folder instead.';
  }
  if (ancestorState === 'metadata_only') {
    return `Follows ${node.inherited_from ?? 'the folder above'}, which is metadata only. It can only be made `
      + 'stricter here.';
  }
  return 'Decided by a rule that does not name a folder path. It is listed read-only beside the tree.';
}

function renderNonFolderRules(rules: readonly SourceDispositionNonFolderRule[]): string {
  if (rules.length === 0) return '';
  const rows = rules.map((rule) => `
              <li>
                <code>${escapeHtml(rule.rule_id)}</code>
                <span class="chip default ${rule.state}">${escapeHtml(SOURCE_DISPOSITION_STATE_LABELS[rule.state])}</span>
                <span class="rule-criterion">${escapeHtml(rule.criterion)}</span>
                <span class="subtle">${escapeHtml(rule.reason)}</span>
              </li>`).join('');
  return `
        <aside class="media-rules" aria-label="Rules the folder tree does not own">
          <h3>Rules that are not about folders</h3>
          <p class="subtle">These name items by what they are rather than where they live, so no folder in the tree
          owns them. They are shown read-only; edit them in the rules file.</p>
          <ul>${rows}</ul>
        </aside>`;
}

function renderCleanupBlock(view: SourceDispositionsView): string {
  return `
      <section class="cleanup" aria-label="Settling what is already stored">
        <h2>Already-ingested content</h2>
        <p>Saving on this page changes what happens from now on. It never removes anything already in your
        local store — that stays a deliberate act at a terminal. As things stand today, a run would remove
        <strong>${view.cleanup.items_would_purge}</strong> excluded
        ${view.cleanup.items_would_purge === 1 ? 'item' : 'items'} and clear the content of
        <strong>${view.cleanup.items_would_strip}</strong> metadata-only
        ${view.cleanup.items_would_strip === 1 ? 'item' : 'items'}. A further
        ${view.cleanup.items_unevaluable} ${view.cleanup.items_unevaluable === 1 ? 'row' : 'rows'}
        cannot be judged from a stored locator, and both commands leave those alone.</p>
        <label>Preview everything, change nothing
          <span class="copy-row">
            <input id="cmd-dry-run" readonly value="${escapeHtml(view.cleanup.dry_run_command)}">
            <button class="secondary" type="button" data-copy-target="#cmd-dry-run">Copy</button>
          </span>
        </label>
        <label>Remove excluded items, with their chunks and vectors
          <span class="copy-row">
            <input id="cmd-purge" readonly value="${escapeHtml(view.cleanup.purge_command)}">
            <button class="secondary" type="button" data-copy-target="#cmd-purge">Copy</button>
          </span>
        </label>
        <label>Clear the content of metadata-only items, keeping their rows
          <span class="copy-row">
            <input id="cmd-strip" readonly value="${escapeHtml(view.cleanup.strip_command)}">
            <button class="secondary" type="button" data-copy-target="#cmd-strip">Copy</button>
          </span>
        </label>
        <p class="subtle">Read the dry run before either. This page cannot run them.</p>
      </section>`;
}

function slugId(value: string): string {
  const out: string[] = [];
  for (const character of value.toLowerCase()) {
    const safe = (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');
    out.push(safe ? character : '-');
  }
  return out.join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeScriptJson(value: string): string {
  return value.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

// The dashboard's own tokens, so the two pages read as one product. Kept as a
// literal rather than imported: source-dashboard.ts inlines its stylesheet in
// its own template, and exporting a shared string would couple two page
// templates that are free to diverge.
