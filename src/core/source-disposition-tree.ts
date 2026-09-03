// The folder-disposition picker's engine: one tree of folders, three states per
// folder, and the edit that turns a change on that tree back into the owner's
// own rules document.
//
// This module decides NOTHING about what an item's disposition is. Every
// effective state on every node is `SourceExclusionMatcher.evaluatePath`, and
// every path key is `normalizeSourceExclusionPath`. That is deliberate and it
// is the whole safety property: a picker that carried its own idea of "is this
// folder under that rule" would eventually disagree with the gate, and the
// disagreement would show up as a page telling the owner a folder is excluded
// while ingestion happily admits it. There is one matcher in this system and
// this file is a reader of it.
//
// Deliberately source-neutral, and enrolled in the architecture guard's
// source-agnostic list for the same reason the gate itself is: every
// file-storage family needs the identical picker, and a picker that learned one
// provider's idioms is a picker the next provider silently does not get.
//
// Deliberately regex-free, matching the gate: segment arithmetic, not pattern
// matching.

import {
  createSourceExclusionMatcher,
  normalizeSourceExclusionPath,
  sourceExclusionRuleAppliesToSource,
  sourceExclusionOutcomeIsUnevaluable,
  type SourceExclusionCriterionKind,
  type SourceExclusionMatcher,
  type SourceIngestionDisposition,
  type SourceIngestionExclusionRule,
  type SourceIngestionExclusions,
  type SourceIngestionRuleMode,
  SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION,
} from './source-ingestion-exclusions.ts';

/**
 * The three choices a folder carries in the picker.
 *
 * The owner's vocabulary, not the gate's. `ingest` is the gate's `admit` —
 * renamed because "admit" is what a gate does and "ingest" is what the owner
 * asked for, and a control the owner reads has to be labelled in their words.
 * The mapping is total and lives in one function below, so the two vocabularies
 * cannot drift.
 */
export type SourceDispositionState = 'ingest' | 'metadata_only' | 'exclude';

/**
 * Where a node's state came from.
 *
 * The distinction selective-sync pickers exist to draw. `explicit` means a rule
 * names THIS folder; `inherited` means an ancestor's rule reaches it;
 * `default` means no rule covers it at all. Rendering the three the same way is
 * the failure mode — an owner unchecking an inherited row expects to change one
 * folder and is in fact editing their ancestor's rule, or, in this schema,
 * cannot change it at all.
 */
export type SourceDispositionOrigin = 'explicit' | 'inherited' | 'default';

/**
 * What is actually under one folder, in the same terms the two cleanup verbs
 * use — so a number on this page and a number in a `--dry-run` preview can be
 * compared without translating between them.
 *
 * The `would_` pair is the load-bearing part. An excluded item the gate cannot
 * answer for from a stored locator is KEPT by the purge, and a metadata-only
 * item it cannot answer for is KEPT by the strip. A page that showed only
 * `excluded_items` next to a "run the purge" instruction would be promising a
 * cleanup that will not happen; the difference between the two numbers is
 * exactly the backlog that needs a decision rather than a run.
 */
export interface SourceDispositionCounts {
  /**
   * Items stored under this node, at any depth.
   */
  items: number;
  /**
   * Of `items`, those still holding content (chunks) in the store today.
   */
  items_with_content: number;
  /**
   * Of `items`, those the gate currently excludes.
   */
  excluded_items: number;
  /**
   * Of `excluded_items`, those a purge run would actually remove.
   */
  excluded_items_would_purge: number;
  /**
   * Of `items`, those the gate currently admits without content.
   */
  metadata_only_items: number;
  /**
   * Of `metadata_only_items`, those still holding content the rule forbids.
   */
  metadata_only_items_with_content: number;
  /**
   * Of those, the ones a strip run would actually clear.
   */
  metadata_only_content_would_strip: number;
  /**
   * Of `items`, those the gate cannot answer for from a stored locator alone.
   * Counted on their own because both cleanup verbs leave them alone.
   */
  unevaluable_items: number;
}

export interface SourceDispositionNode {
  /**
   * The normalized path, and the key every comparison in this module uses.
   */
  path: string;
  /**
   * The owner's own casing for the last segment, for display only.
   */
  name: string;
  /**
   * The owner's own casing for the whole path, for display only.
   */
  display_path: string;
  depth: number;
  state: SourceDispositionState;
  origin: SourceDispositionOrigin;
  /**
   * The rule that decided this node, when one did.
   */
  rule_id?: string;
  reason?: string;
  /**
   * The ancestor whose explicit rule reaches this node, when inherited.
   */
  inherited_from?: string;
  /**
   * True when the gate cannot answer for this folder path itself — a folder
   * name a media criterion's type half matches, with no size to check it
   * against. Surfaced rather than smoothed over: the gate's answer for such a
   * path is the strictest one, and a picker that showed the strict answer
   * without saying why would be reporting a rule the owner never wrote.
   */
  unevaluable: boolean;
  /**
   * True when some descendant carries a different state than this node.
   */
  mixed_below: boolean;
  /**
   * True when this node has descendants the tree bounds did not render.
   */
  truncated: boolean;
  counts: SourceDispositionCounts;
  children: SourceDispositionNode[];
}

export interface SourceDispositionTree {
  roots: SourceDispositionNode[];
  counts: SourceDispositionCounts;
  /**
   * Items whose stored locator cannot be normalized into a path at all. They
   * have no place in a folder tree, and dropping them silently would make the
   * tree's totals disagree with the store's.
   */
  unplaced_items: number;
  /**
   * Nodes the depth or node bounds kept out of `roots`.
   */
  truncated_nodes: number;
}

/**
 * One item as the store holds it.
 *
 * `locator` is passed to the matcher RAW, exactly as the purge and the strip
 * pass it, so the picker's counts and a `--dry-run` preview walk the same value
 * through the same gate.
 */
export interface SourceDispositionItem {
  locator: string | null | undefined;
  hasContent?: boolean;
}

export interface SourceDispositionTreeOptions {
  matcher: SourceExclusionMatcher;
  items: Iterable<SourceDispositionItem>;
  /**
   * How deep the rendered tree goes. Folders below this are counted into their
   * ancestors and reported in `truncated_nodes` rather than dropped from the
   * totals.
   */
  maxDepth?: number;
  /**
   * A ceiling on rendered nodes, so one pathological corpus cannot hang a page.
   */
  maxNodes?: number;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_NODES = 4000;

/**
 * The picker's word for what the gate decided.
 *
 * Exhaustive on purpose: adding a disposition to the gate without deciding what
 * the picker calls it is a type error here, not a folder that renders blank.
 */
export function sourceDispositionStateFor(disposition: SourceIngestionDisposition): SourceDispositionState {
  switch (disposition) {
    case 'admit':
      return 'ingest';
    case 'metadata_only':
      return 'metadata_only';
    case 'exclude':
      return 'exclude';
  }
}

/**
 * The gate's word for what the picker asked for, or undefined for `ingest` —
 * which is the ABSENCE of a rule and therefore has no mode to write.
 */
export function sourceDispositionRuleMode(
  state: SourceDispositionState,
): SourceIngestionRuleMode | undefined {
  return state === 'ingest' ? undefined : state;
}

export const SOURCE_DISPOSITION_STATE_LABELS: Record<SourceDispositionState, string> = {
  ingest: 'Ingest',
  metadata_only: 'Metadata only',
  exclude: 'Exclude',
};

interface MutableNode {
  path: string;
  segments: string[];
  displaySegments: string[];
  /**
   * False while the only spelling seen is the gate's normalized one.
   */
  displayFromItem: boolean;
  counts: SourceDispositionCounts;
  children: Map<string, MutableNode>;
}

function emptyCounts(): SourceDispositionCounts {
  return {
    items: 0,
    items_with_content: 0,
    excluded_items: 0,
    excluded_items_would_purge: 0,
    metadata_only_items: 0,
    metadata_only_items_with_content: 0,
    metadata_only_content_would_strip: 0,
    unevaluable_items: 0,
  };
}

function addCounts(target: SourceDispositionCounts, source: SourceDispositionCounts): void {
  target.items += source.items;
  target.items_with_content += source.items_with_content;
  target.excluded_items += source.excluded_items;
  target.excluded_items_would_purge += source.excluded_items_would_purge;
  target.metadata_only_items += source.metadata_only_items;
  target.metadata_only_items_with_content += source.metadata_only_items_with_content;
  target.metadata_only_content_would_strip += source.metadata_only_content_would_strip;
  target.unevaluable_items += source.unevaluable_items;
}

/**
 * The owner's own casing for a path whose normalized form is already known.
 *
 * Display only. The derivation repeats the gate's segment split WITHOUT its
 * lowercasing, then CHECKS itself against the normalized form the gate
 * produced: if the two disagree in length or in content once lowercased, the
 * normalized segments are used instead. So a future change to the gate's
 * normalization can make this fall back to plain lowercase text, and can never
 * make it produce a path that names a different folder.
 */
function displaySegmentsFor(raw: string, normalizedSegments: readonly string[]): string[] {
  const candidate = raw
    .normalize('NFC')
    .trim()
    .split('\\')
    .join('/')
    .split('/')
    .filter((segment) => segment.length > 0);
  if (candidate.length !== normalizedSegments.length) return [...normalizedSegments];
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index]!.toLowerCase() !== normalizedSegments[index]) return [...normalizedSegments];
  }
  return candidate;
}

function normalizedSegmentsFor(normalizedPath: string): string[] {
  return normalizedPath.split('/').filter((segment) => segment.length > 0);
}

/**
 * Every path prefix the matcher compiled, normalized, with the criteria that
 * named it. The picker's ONLY source of "is this folder named by a rule".
 */
function explicitPrefixes(matcher: SourceExclusionMatcher): Map<string, string[]> {
  const byPrefix = new Map<string, string[]>();
  for (const criterion of matcher.criteria) {
    if (criterion.kind !== 'path_prefix') continue;
    const existing = byPrefix.get(criterion.prefix);
    if (existing) existing.push(criterion.ruleId);
    else byPrefix.set(criterion.prefix, [criterion.ruleId]);
  }
  return byPrefix;
}

/**
 * Build the folder tree the picker renders.
 *
 * Two inputs, both already the system's own: the store's item locators and the
 * compiled gate. Nothing else is consulted, so the tree cannot describe a
 * configuration the gate is not enforcing.
 */
export function buildSourceDispositionTree(
  options: SourceDispositionTreeOptions,
): SourceDispositionTree {
  const { matcher } = options;
  const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxNodes = Math.max(1, options.maxNodes ?? DEFAULT_MAX_NODES);
  const roots = new Map<string, MutableNode>();
  const totals = emptyCounts();
  let unplacedItems = 0;

  /**
   * Walk (creating as needed) to the node for these segments, folding `leaf`
   * into every node on the way.
   *
   * `displayFromItem` is why the two callers share this: a node first created
   * from a RULE has only the owner's configured spelling, which the gate has
   * already lowercased. The first stored item that passes through it carries
   * the provider's own casing, and that is what a person recognizes as their
   * folder. Without the upgrade, exactly the folders the owner wrote rules for
   * would be the ones rendered in lowercase.
   */
  const walk = (
    normalizedSegments: readonly string[],
    displaySegments: readonly string[],
    displayFromItem: boolean,
    leaf?: SourceDispositionCounts,
  ): void => {
    let level = roots;
    for (let index = 0; index < normalizedSegments.length; index += 1) {
      const key = normalizedSegments[index]!;
      let child = level.get(key);
      if (!child) {
        child = {
          path: `/${normalizedSegments.slice(0, index + 1).join('/')}`,
          segments: normalizedSegments.slice(0, index + 1),
          displaySegments: displaySegments.slice(0, index + 1),
          displayFromItem,
          counts: emptyCounts(),
          children: new Map(),
        };
        level.set(key, child);
      } else if (displayFromItem && !child.displayFromItem) {
        child.displaySegments = displaySegments.slice(0, index + 1);
        child.displayFromItem = true;
      }
      if (leaf) addCounts(child.counts, leaf);
      level = child.children;
    }
  };

  // Every folder a rule names exists in the tree whether or not anything is
  // stored under it. A configured folder that renders nowhere is the one thing
  // this page must never do: it would read as "that rule is gone".
  for (const prefix of explicitPrefixes(matcher).keys()) {
    const segments = normalizedSegmentsFor(prefix);
    if (segments.length > 0) walk(segments, segments, false);
  }

  for (const item of options.items) {
    const raw = typeof item.locator === 'string' ? item.locator : undefined;
    const normalized = raw === undefined ? undefined : normalizeSourceExclusionPath(raw);
    // The gate reads the RAW locator, exactly as the purge does.
    const decision = matcher.evaluatePath(item.locator);
    const unevaluable = sourceExclusionOutcomeIsUnevaluable(decision.outcome);
    const hasContent = item.hasContent === true;
    const leaf = emptyCounts();
    leaf.items = 1;
    if (hasContent) leaf.items_with_content = 1;
    if (unevaluable) leaf.unevaluable_items = 1;
    if (decision.disposition === 'exclude') {
      leaf.excluded_items = 1;
      // Exactly the purge's own rule: matched and answerable is removed,
      // matched and unanswerable is kept and reported.
      if (!unevaluable) leaf.excluded_items_would_purge = 1;
    }
    if (decision.disposition === 'metadata_only') {
      leaf.metadata_only_items = 1;
      if (hasContent) {
        leaf.metadata_only_items_with_content = 1;
        // Exactly the strip's own rule, over exactly the rows it scans: items
        // that still carry chunks.
        if (!unevaluable) leaf.metadata_only_content_would_strip = 1;
      }
    }
    addCounts(totals, leaf);
    if (normalized === undefined) {
      unplacedItems += 1;
      continue;
    }
    const normalizedSegments = normalizedSegmentsFor(normalized);
    // The last segment is the item itself; its folders are its ancestors.
    const folderSegments = normalizedSegments.slice(0, -1);
    if (folderSegments.length === 0) continue;
    const displaySegments = displaySegmentsFor(raw!, normalizedSegments).slice(0, -1);
    walk(folderSegments, displaySegments, true, leaf);
  }

  let truncatedNodes = 0;
  let renderedNodes = 0;
  const explicit = explicitPrefixes(matcher);

  const render = (node: MutableNode, depth: number): SourceDispositionNode => {
    renderedNodes += 1;
    const decision = matcher.evaluatePath(node.path);
    const state = sourceDispositionStateFor(decision.disposition);
    const isExplicit = explicit.has(node.path);
    const ancestor = isExplicit ? undefined : nearestExplicitAncestor(node.segments, explicit);
    const origin: SourceDispositionOrigin = isExplicit
      ? 'explicit'
      : ancestor !== undefined
        ? 'inherited'
        : 'default';
    const childNodes: SourceDispositionNode[] = [];
    const sortedChildren = [...node.children.values()]
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const child of sortedChildren) {
      // A folder a rule names is rendered whatever the bounds say. The bounds
      // exist to keep a huge corpus from hanging the page, not to hide the
      // owner's own configuration from them.
      const mandatory = explicit.has(child.path) || childHoldsExplicitDescendant(child, explicit);
      if (!mandatory && (depth + 1 > maxDepth || renderedNodes >= maxNodes)) {
        truncatedNodes += 1 + countDescendants(child);
        continue;
      }
      childNodes.push(render(child, depth + 1));
    }
    const mixedBelow = childNodes.some((child) => child.state !== state || child.mixed_below);
    return {
      path: node.path,
      name: node.displaySegments[node.displaySegments.length - 1] ?? node.path,
      display_path: `/${node.displaySegments.join('/')}`,
      depth,
      state,
      origin,
      ...(decision.ruleId !== undefined ? { rule_id: decision.ruleId } : {}),
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      ...(ancestor !== undefined ? { inherited_from: ancestor } : {}),
      unevaluable: sourceExclusionOutcomeIsUnevaluable(decision.outcome),
      mixed_below: mixedBelow,
      truncated: childNodes.length < sortedChildren.length,
      counts: { ...node.counts },
      children: childNodes,
    };
  };

  const rendered = [...roots.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((node) => render(node, 1));

  return {
    roots: rendered,
    counts: totals,
    unplaced_items: unplacedItems,
    truncated_nodes: truncatedNodes,
  };
}

function countDescendants(node: MutableNode): number {
  let total = 0;
  for (const child of node.children.values()) total += 1 + countDescendants(child);
  return total;
}

function childHoldsExplicitDescendant(node: MutableNode, explicit: Map<string, string[]>): boolean {
  for (const prefix of explicit.keys()) {
    if (prefix === node.path || prefix.startsWith(`${node.path}/`)) return true;
  }
  return false;
}

/**
 * The closest ancestor folder a rule names, or undefined.
 *
 * Segment arithmetic over the node's own segments rather than a string scan, so
 * `/a/bookshelf` is never treated as living under `/a/books`.
 */
function nearestExplicitAncestor(
  segments: readonly string[],
  explicit: Map<string, string[]>,
): string | undefined {
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const candidate = `/${segments.slice(0, depth).join('/')}`;
    if (explicit.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * One change the owner made on the tree.
 *
 * `reason` is the owner's prose and goes into the rule they are creating. It is
 * optional and has a default, because a rule with no reason is a line nobody
 * can audit a year later, and making the field mandatory in a picker would just
 * produce the word "x".
 */
export interface SourceDispositionEdit {
  path: string;
  state: SourceDispositionState;
  reason?: string;
}

export type SourceDispositionEditAction = 'added' | 'removed' | 'changed' | 'unchanged';

export interface SourceDispositionEditApplied {
  path: string;
  state: SourceDispositionState;
  action: SourceDispositionEditAction;
  rule_id?: string;
}

export type SourceDispositionRefusalCode =
  | 'path_unevaluable'
  | 'inherited_state_not_editable'
  | 'criterion_not_editable_by_path';

export interface SourceDispositionEditRefusal {
  path: string;
  state: SourceDispositionState;
  code: SourceDispositionRefusalCode;
  message: string;
}

export interface SourceDispositionEditResult {
  rules: SourceIngestionExclusions;
  changed: boolean;
  applied: SourceDispositionEditApplied[];
  refused: SourceDispositionEditRefusal[];
  /**
   * Rule ids present before the edit and still present after it, unchanged.
   */
  untouched_rule_ids: string[];
}

export interface SourceDispositionEditOptions {
  /**
   * The source the new rules are scoped to. Empty means every source.
   */
  source?: string;
  /**
   * What the source can enforce, so the matcher this edit reasons over is its own.
   */
  enforceable?: readonly SourceExclusionCriterionKind[];
}

const DEFAULT_EDIT_REASONS: Record<SourceIngestionRuleMode, string> = {
  exclude: 'excluded from the folder picker',
  metadata_only: 'index titles and dates, never read the contents',
};

/**
 * Turn changes on the tree into the owner's next rules document.
 *
 * Three properties this function exists to hold:
 *
 *   1. AN UNTOUCHED RULE IS UNTOUCHED. Its id, its prefixes, its reason and its
 *      mode come out exactly as they went in. Rule ids are the key every
 *      receipt in this system is written against, so a picker that re-slugged
 *      them on save would silently reset every count the owner has been
 *      watching.
 *   2. AN INEXPRESSIBLE EDIT IS REFUSED, NOT APPROXIMATED. There is no
 *      "include" rule in this schema, so a folder cannot be re-admitted
 *      underneath an excluded ancestor. Writing the nearest thing — dropping
 *      the ancestor's rule — would silently re-admit every sibling folder too.
 *      So it comes back as a refusal that names the ancestor.
 *   3. THE RESULT IS A DOCUMENT, NOT A WRITE. Nothing here touches a file. The
 *      caller validates and writes, which is what keeps the parse in one place.
 */
export function applySourceDispositionEdits(
  document: SourceIngestionExclusions,
  edits: readonly SourceDispositionEdit[],
  options: SourceDispositionEditOptions = {},
): SourceDispositionEditResult {
  const source = options.source?.trim().toLowerCase() || undefined;
  const rules: SourceIngestionExclusionRule[] = document.rules.map((rule) => ({ ...rule }));
  const originalIds = new Set(document.rules.map((rule) => rule.id));
  const touchedIds = new Set<string>();
  const applied: SourceDispositionEditApplied[] = [];
  const refused: SourceDispositionEditRefusal[] = [];
  const enforcesPaths = !options.enforceable || options.enforceable.includes('path_prefix');

  const ruleAppliesHere = (rule: SourceIngestionExclusionRule): boolean =>
    sourceExclusionRuleAppliesToSource(rule, source);

  // Decided before any gate is built, and it has to be: compiling a gate for a
  // source that cannot enforce path prefixes is exactly what the engine REFUSES
  // when a rule names such a source, so building one here to find that out
  // would throw instead of answering.
  if (!enforcesPaths) {
    return {
      rules: { schemaVersion: SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION, rules: [...document.rules] },
      changed: false,
      applied: [],
      refused: edits.map((edit) => ({
        path: edit.path,
        state: edit.state,
        code: 'criterion_not_editable_by_path' as const,
        message: 'This source does not name folders by path, so a folder tree cannot edit its rules. '
          + 'Its rules are listed read-only beside the tree.',
      })),
      untouched_rule_ids: [...originalIds].sort(),
    };
  }

  for (const edit of edits) {
    // The gate is rebuilt from the CURRENT rules on every edit, never once at
    // the top. Two edits in one save can touch the same subtree — a folder
    // excluded and then its parent excluded — and a stale gate would report the
    // second one against the state before the first, which is how a batch save
    // ends up describing a document it did not produce.
    const matcher = createSourceExclusionMatcher(
      { schemaVersion: SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION, rules },
      source,
      options.enforceable ? { enforceable: options.enforceable } : {},
    );
    const explicit = explicitPrefixes(matcher);
    const path = normalizeSourceExclusionPath(edit.path);
    if (path === undefined) {
      refused.push({
        path: edit.path,
        state: edit.state,
        code: 'path_unevaluable',
        message: 'That folder path cannot be compared safely, so no rule was written for it.',
      });
      continue;
    }
    const before = matcher.evaluatePath(path);
    const beforeState = sourceDispositionStateFor(before.disposition);
    const isExplicit = explicit.has(path);
    // What this folder would inherit if it carried no rule of its own. The
    // whole refusal set below is decided against the ANCESTOR's state rather
    // than this folder's, because removing this folder's rule cannot change
    // what its ancestors say.
    const ancestorState = ancestorStateFor(path, matcher);
    const ancestorPath = nearestExplicitAncestor(normalizedSegmentsFor(path), explicit);

    if (edit.state === 'ingest') {
      if (ancestorState !== 'ingest') {
        refused.push({
          path,
          state: edit.state,
          code: 'inherited_state_not_editable',
          message: `${SOURCE_DISPOSITION_STATE_LABELS[ancestorState]} is inherited from `
            + `${ancestorPath ?? 'a folder above this one'}. This configuration has no "include" rule, so a folder `
            + 'cannot be re-admitted under one that is kept out. Change the rule on that folder instead — which '
            + 'changes every folder under it.',
        });
        continue;
      }
      if (!isExplicit) {
        if (beforeState === 'ingest') {
          applied.push({ path, state: edit.state, action: 'unchanged' });
          continue;
        }
        refused.push({
          path,
          state: edit.state,
          code: 'criterion_not_editable_by_path',
          message: 'This folder is covered by a rule that does not name a folder path, so the folder tree cannot '
            + 'change it. Those rules are listed read-only beside the tree.',
        });
        continue;
      }
      const removedFrom = removePrefix(rules, path, ruleAppliesHere, source);
      for (const ruleId of removedFrom) touchedIds.add(ruleId);
      applied.push({
        path,
        state: edit.state,
        action: 'removed',
        ...(removedFrom[0] !== undefined ? { rule_id: removedFrom[0] } : {}),
      });
      continue;
    }

    const mode = sourceDispositionRuleMode(edit.state)!;
    if (edit.state === 'metadata_only' && ancestorState === 'exclude') {
      // Exclusion beats metadata-only whatever order the two are written in, so
      // writing this rule would produce a file that says one thing and a gate
      // that does another. Refusing says so; writing it would be the picker
      // lying about a rule it just created.
      refused.push({
        path,
        state: edit.state,
        code: 'inherited_state_not_editable',
        message: `An exclusion inherited from ${ancestorPath ?? 'a folder above this one'} outranks metadata-only `
          + 'however the two are ordered, so this rule would have no effect. Change the rule on that folder instead.',
      });
      continue;
    }
    if (isExplicit && beforeState === edit.state) {
      applied.push({ path, state: edit.state, action: 'unchanged' });
      continue;
    }
    if (!isExplicit && beforeState === edit.state && ancestorState === edit.state) {
      // Already inherited from above. Selective-sync pickers store state only
      // where it differs from the parent, and a redundant rule here would be a
      // second receipt key counting the same items as its own ancestor.
      applied.push({ path, state: edit.state, action: 'unchanged' });
      continue;
    }
    // A folder already carrying an explicit rule in the other mode has that
    // rule's prefix removed first, so the two dispositions can never both name
    // the same folder — which the gate resolves strictest-first, meaning a
    // leftover exclusion would quietly outrank the metadata-only the owner just
    // asked for.
    const removedFrom = isExplicit ? removePrefix(rules, path, ruleAppliesHere, source) : [];
    for (const ruleId of removedFrom) touchedIds.add(ruleId);
    const id = uniqueRuleId(path, new Set(rules.map((rule) => rule.id)));
    rules.push({
      id,
      mode,
      sources: source === undefined ? [] : [source],
      path_prefixes: [path],
      folder_ids: [],
      reason: edit.reason?.trim() || DEFAULT_EDIT_REASONS[mode],
    });
    touchedIds.add(id);
    applied.push({
      path,
      state: edit.state,
      action: isExplicit ? 'changed' : 'added',
      rule_id: id,
    });
  }

  const next = rules.filter((rule) =>
    rule.path_prefixes.length > 0 || rule.folder_ids.length > 0 || rule.media !== undefined);
  const nextIds = new Set(next.map((rule) => rule.id));
  return {
    rules: { schemaVersion: SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION, rules: next },
    changed: applied.some((entry) => entry.action !== 'unchanged'),
    applied,
    refused,
    untouched_rule_ids: [...originalIds].filter((id) => nextIds.has(id) && !touchedIds.has(id)).sort(),
  };
}

/**
 * What a folder would inherit with no rule of its own: the gate's answer for
 * its parent.
 *
 * A top-level folder inherits nothing — there is no configurable rule above it,
 * and asking the gate about the bare root would come back unevaluable, which
 * would read as "everything at the top level is excluded".
 */
function ancestorStateFor(path: string, matcher: SourceExclusionMatcher): SourceDispositionState {
  const segments = normalizedSegmentsFor(path);
  if (segments.length < 2) return 'ingest';
  const parent = `/${segments.slice(0, -1).join('/')}`;
  return sourceDispositionStateFor(matcher.evaluatePath(parent).disposition);
}

/**
 * Drop one folder path from every rule that names it, returning their ids.
 *
 * The rule survives with its id intact when it still names other folders. That
 * is the id-stability property in one line: removing one folder from a rule
 * with four in it must not mint a new receipt key for the other three.
 */
function removePrefix(
  rules: SourceIngestionExclusionRule[],
  path: string,
  appliesHere: (rule: SourceIngestionExclusionRule) => boolean,
  source: string | undefined,
): string[] {
  const touched: string[] = [];
  const initialLength = rules.length;
  for (let index = 0; index < initialLength; index += 1) {
    const rule = rules[index]!;
    if (!appliesHere(rule)) continue;
    if (!rule.path_prefixes.includes(path)) continue;
    const remainingPrefixes = rule.path_prefixes.filter((prefix) => prefix !== path);
    if (source !== undefined && (
      rule.sources.length === 0
      || rule.sources.includes('*')
      || rule.sources.filter((candidate) => !candidate.startsWith('!')).length > 1
    )) {
      // Keep the original receipt id on every source the owner did not edit.
      // `*` plus a negated source is the exact complement, including future
      // sources the picker does not know yet; enumerating today's sources here
      // would quietly stop a blanket rule applying to tomorrow's connector.
      const remainingSources = rule.sources.length === 0 || rule.sources.includes('*')
        ? [...new Set(['*', ...rule.sources.filter((candidate) => candidate !== '*'), `!${source}`])]
        : rule.sources.filter((candidate) => candidate !== source);
      rules[index] = { ...rule, sources: remainingSources };
      if (remainingPrefixes.length > 0 || rule.folder_ids.length > 0 || rule.media !== undefined) {
        const splitId = uniqueRuleId(
          `/split/${rule.id}/${source}`,
          new Set(rules.map((candidate) => candidate.id)),
        );
        rules.push({
          ...rule,
          id: splitId,
          sources: [source],
          path_prefixes: remainingPrefixes,
        });
        touched.push(splitId);
      }
      touched.push(rule.id);
      continue;
    }
    rules[index] = {
      ...rule,
      path_prefixes: remainingPrefixes,
    };
    touched.push(rule.id);
  }
  return touched;
}

/**
 * A receipt key for a folder, derived from the folder itself.
 *
 * Restricted to the character class the parser accepts, because a rule id that
 * fails to parse turns the owner's next save into a refused write. Long paths
 * keep their TAIL rather than their head: the deepest segments are what
 * distinguishes two folders, and truncating from the other end would make every
 * folder under one long ancestor collide.
 */
export function sourceDispositionRuleId(path: string): string {
  const normalized = normalizeSourceExclusionPath(path) ?? path.toLowerCase();
  const out: string[] = [];
  let lastWasDash = true;
  for (const character of normalized) {
    const safe = (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');
    if (safe) {
      out.push(character);
      lastWasDash = false;
      continue;
    }
    if (!lastWasDash) {
      out.push('-');
      lastWasDash = true;
    }
  }
  let slug = out.join('');
  while (slug.startsWith('-')) slug = slug.slice(1);
  while (slug.endsWith('-')) slug = slug.slice(0, -1);
  if (slug.length > 60) {
    slug = slug.slice(slug.length - 60);
    const boundary = slug.indexOf('-');
    if (boundary > 0 && boundary < 20) slug = slug.slice(boundary + 1);
  }
  return slug.length > 0 ? slug : 'folder';
}

function uniqueRuleId(path: string, taken: ReadonlySet<string>): string {
  const base = sourceDispositionRuleId(path);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('Could not mint a unique rule id for this folder.');
}

/**
 * A rule the folder tree cannot express, in the shape a read-only list renders.
 *
 * Everything the tree owns is a folder path. A rule that names items by what
 * they ARE has no folder to sit on, and putting it on one would be the picker
 * inventing a claim the owner never made — so it is listed beside the tree,
 * read-only, with what it actually says.
 */
export interface SourceDispositionNonFolderRule {
  rule_id: string;
  state: SourceDispositionState;
  kind: SourceExclusionCriterionKind;
  /**
   * The owner's own configuration, rendered: extensions, mime prefixes, bounds.
   */
  criterion: string;
  reason: string;
  /**
   * Empty means every source.
   */
  sources: string[];
}

/**
 * The rules in this document the folder tree does not own.
 *
 * Media criteria always; folder-identity criteria too, because an opaque
 * provider id is not a path and a tree keyed by path cannot edit one. Both are
 * listed rather than hidden: a rule the owner wrote and the page does not
 * mention reads as a rule that stopped existing.
 */
export function sourceDispositionNonFolderRules(
  document: SourceIngestionExclusions,
  source?: string,
): SourceDispositionNonFolderRule[] {
  const wanted = source?.trim().toLowerCase();
  const out: SourceDispositionNonFolderRule[] = [];
  for (const rule of document.rules) {
    if (!sourceExclusionRuleAppliesToSource(rule, wanted)) continue;
    const state = sourceDispositionStateFor(rule.mode);
    if (rule.media) {
      out.push({
        rule_id: rule.id,
        state,
        kind: 'media',
        criterion: mediaCriterionText(rule.media),
        reason: rule.reason,
        sources: [...rule.sources],
      });
    }
    for (const folder of rule.folder_ids) {
      out.push({
        rule_id: rule.id,
        state,
        kind: 'folder_id',
        criterion: `folder identity: ${folder.name}`,
        reason: rule.reason,
        sources: [...rule.sources],
      });
    }
  }
  return out;
}

function mediaCriterionText(media: NonNullable<SourceIngestionExclusionRule['media']>): string {
  const parts: string[] = [];
  if (media.extensions.length > 0) parts.push(media.extensions.join(', '));
  if (media.mime_prefixes.length > 0) parts.push(media.mime_prefixes.join(', '));
  if (media.min_bytes !== undefined) parts.push(`at least ${formatBytes(media.min_bytes)}`);
  if (media.max_bytes !== undefined) parts.push(`at most ${formatBytes(media.max_bytes)}`);
  return parts.join(' · ');
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
