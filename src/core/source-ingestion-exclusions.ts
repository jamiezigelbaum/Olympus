// Ingestion dispositions: a source-neutral, fail-closed ingestion primitive.
//
// Owner directive 2026-07-28. Some folders in a user's file storage are the
// curated corpus of a DIFFERENT system. Admitting them here is not waste, it is
// a correctness fault: another system's private material lands in this user's
// general personal search. So exclusion is configuration a user writes during
// setup, not a patch, and it is checked before anything else.
//
// THREE DISPOSITIONS, not two (owner ruling, 2026-07-28 evening). Admit-or-
// refuse turned out to be a poorer vocabulary than the owner's own:
//
//   - `exclude` (the default, and what every rule written before tonight
//     means): never ingested, purged if already present.
//   - `metadata_only`: the item IS admitted — title, path, timestamps, the
//     search text its metadata yields — and its CONTENT is never read. No
//     extraction, no chunks, no vectors. The omission is real, so it is
//     reported as a coverage gap rather than left to be inferred from a
//     coverage percentage that looks like a stalled lane.
//   - admit (no rule matched): unchanged.
//
// A rule also gains a second way to name items: by what they ARE rather than
// where they live. A 4 GB video is not refused because of its folder, it is
// refused because reading it costs more than it can return, and that decision
// has to be expressible without enumerating every folder a video might sit in.
// See `SourceIngestionExclusionMedia`.
//
// Three properties this module exists to guarantee:
//
//   1. EXCLUSION BEATS INCLUSION. There is no code path in this module that can
//      turn an excluded decision back into an admitted one. Callers apply the
//      decision before any allowlist, scope, or policy is consulted, and the
//      decision type carries no "override" channel to consult later.
//   2. FAIL CLOSED. When a matcher is active and an item yields no path this
//      module can evaluate, the answer is EXCLUDED, with a distinct outcome so
//      the caller can report it rather than swallow it. The cost of wrongly
//      excluding is one missing file; the cost of wrongly including is another
//      system's corpus in personal search. Those are not symmetric.
//   3. CASE CANNOT LEAK. File-storage paths are routinely case-insensitive, and
//      providers publish a casefolded path for exactly that reason. Both sides
//      of every comparison are normalized here, so an exclusion cannot miss
//      because the user typed a folder differently from the provider.
//
// Deliberately source-neutral: this file is enrolled in the architecture
// guard's source-agnostic list, so it cannot name a provider. The wiring layer
// decides which rules apply to which source and hands the caller a matcher.
//
// Deliberately regex-free: normalization here is segment arithmetic, not
// pattern matching. A regex is a silent-miss risk in a gate whose miss is a
// leak, and the shared-spine guard treats new regex routing as reviewable.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OperationError } from './operation-error.ts';

export const SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION = 1;

export const SOURCE_INGESTION_EXCLUSIONS_PATH_ENV = 'OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH';

/**
 * What the gate decided to DO with an item, as opposed to why.
 *
 * Ordered from most permissive to least in `SOURCE_INGESTION_DISPOSITION_RANK`
 * below, because the one rule that must never depend on configuration order is
 * which disposition wins when two rules cover the same item.
 */
export type SourceIngestionDisposition = 'admit' | 'exclude' | 'metadata_only';

/**
 * Strictness order. The gate answers with the STRICTEST disposition any rule
 * gives an item, never the first one it happens to find.
 *
 * Order-dependence here would be a silent downgrade: an owner who wrote
 * "index the titles under /Archive" before "never ingest /Archive/Backups"
 * would get titles for the backups, and nothing anywhere would say the second
 * rule had been overruled by the first one's position in a file.
 */
const SOURCE_INGESTION_DISPOSITION_RANK: Record<SourceIngestionDisposition, number> = {
  admit: 0,
  metadata_only: 1,
  exclude: 2,
};

/**
 * The dispositions a rule may ask for. `admit` is the absence of a rule.
 */
export type SourceIngestionRuleMode = 'exclude' | 'metadata_only';

const SOURCE_INGESTION_RULE_MODES: readonly SourceIngestionRuleMode[] = ['exclude', 'metadata_only'];

/**
 * The order the gate consults modes in: strictest first, DERIVED from the rank
 * above rather than written out again, so the two cannot drift apart.
 */
const SOURCE_INGESTION_DISPOSITION_ORDER: readonly SourceIngestionRuleMode[] = [...SOURCE_INGESTION_RULE_MODES]
  .sort((left, right) => SOURCE_INGESTION_DISPOSITION_RANK[right] - SOURCE_INGESTION_DISPOSITION_RANK[left]);

/**
 * Why an item was admitted, refused, or admitted-without-content. Categorical
 * and content-free: safe to put in a receipt, a ledger row, or a log line.
 */
export type SourceExclusionOutcome =
  | 'admitted'
  | 'excluded_path_prefix'
  | 'excluded_path_unevaluable'
  | 'excluded_folder_id'
  | 'excluded_ancestry_unevaluable'
  | 'excluded_media'
  | 'excluded_media_unevaluable'
  | 'metadata_only_path_prefix'
  | 'metadata_only_folder_id'
  | 'metadata_only_media'
  | 'metadata_only_unevaluable';

/**
 * Whether an outcome means "this gate could not answer" rather than "this gate
 * matched".
 *
 * ONE predicate, because the two kinds of decision are acted on differently
 * and every caller must agree on which is which. A matched item is deleted by a
 * purge (or stripped of its content by the metadata-only strip); an
 * unanswerable one is kept and reported. A caller that tested for a single
 * unevaluable outcome by name would, the moment a second one existed, silently
 * reclassify it as a match and delete rows on evidence the gate never had. That
 * is exactly the mistake this function exists to make impossible: adding an
 * outcome to the union without adding it here is a type error, not a data-loss
 * incident.
 */
export function sourceExclusionOutcomeIsUnevaluable(outcome: SourceExclusionOutcome): boolean {
  switch (outcome) {
    case 'excluded_path_unevaluable':
    case 'excluded_ancestry_unevaluable':
    case 'excluded_media_unevaluable':
    case 'metadata_only_unevaluable':
      return true;
    case 'admitted':
    case 'excluded_path_prefix':
    case 'excluded_folder_id':
    case 'excluded_media':
    case 'metadata_only_path_prefix':
    case 'metadata_only_folder_id':
    case 'metadata_only_media':
      return false;
  }
}

/**
 * How a rule names a folder.
 *
 * ONE concept, two spellings, because file storage has two kinds of provider.
 * Some publish a stable human path and nothing else; some build paths out of
 * opaque folder ids and let a folder be renamed or moved without its identity
 * changing. A rule says "keep these folders out"; these are the two ways a
 * folder can be pointed at, not two separate systems.
 *
 * Identity is the stronger of the two where a provider offers it: a path
 * prefix stops matching the moment the owner renames the folder, and stopping
 * matching is silent admission — the failure this whole module exists to
 * prevent. A path prefix stays the readable default for providers whose paths
 * ARE their identity.
 */
export type SourceExclusionCriterionKind = 'path_prefix' | 'folder_id' | 'media';

/**
 * A rule that names items by WHAT THEY ARE instead of where they live.
 *
 * The concrete need is the owner's: video files over a size threshold, which no
 * folder list can express because they are scattered across every folder a
 * camera roll ever touched. Deliberately provider-neutral — a size in bytes and
 * a file type are facts every file source publishes, so this criterion works
 * identically for a path-shaped provider and an identity-shaped one.
 *
 * `extensions` and `mime_prefixes` are the TYPE half and at least one of them
 * is required. That requirement is load-bearing, not tidiness: a size-only rule
 * could not be answered for any item whose provider omits a size — folders,
 * tombstones, half the metadata in a paginated listing — and answering "I
 * cannot tell" for those means excluding them, so a size-only rule would fail
 * the whole corpus closed the moment it was written.
 *
 * `min_bytes` / `max_bytes` are the SIZE half and are optional. When neither is
 * present the type half decides alone and no size is ever read, which is why a
 * rule like "never ingest any .dmg" needs no size at all. `min_bytes` is
 * INCLUSIVE: `min_bytes: 104857600` means "100 MiB or larger".
 *
 * Within one criterion the halves are ANDed; within a half the entries are
 * ORed. So `{extensions: ['.mp4', '.mov'], min_bytes: N}` reads "an mp4 or a
 * mov, AND at least N bytes", which is the only reading of the owner's ruling.
 * A rule may not carry a media criterion together with folder criteria — see
 * `parseRule` — because that conjunction has two plausible readings and the one
 * nobody checked is the one that under-matches.
 */
export interface SourceIngestionExclusionMedia {
  extensions: readonly string[];
  mime_prefixes: readonly string[];
  min_bytes?: number;
  max_bytes?: number;
}

/**
 * A folder named by provider identity.
 *
 * `name` is never matched on and never has to be right. It is there because a
 * configuration file full of bare opaque ids is unreviewable a year later, and
 * an owner deciding whether a rule still means what they intended must be able
 * to read the file rather than query the provider. It is required for exactly
 * that reason: an id with no name is a line nobody can audit.
 */
export interface SourceIngestionExclusionFolder {
  id: string;
  name: string;
}

/**
 * One user-authored rule.
 *
 * `id` is the stable label every receipt is keyed by, so counts stay meaningful
 * when the user edits the folders under it. `sources` empty means "every
 * source" — the primitive is not per-provider, and a user who wants the same
 * folder name kept out of every connector should not have to repeat themselves.
 *
 * A rule carries path prefixes, folder ids, or a media criterion, and one rule
 * may name several sources — a folder that exists in two providers is still one
 * decision the owner made once, with one id and one reason in the receipts.
 *
 * Three shapes, as they appear in configuration:
 *
 *   // Never ingest this folder. `mode` omitted, so it is an exclusion.
 *   {
 *     "id": "archived-backups",
 *     "sources": ["<source id>"],
 *     "path_prefixes": ["/4 Archive/4 Archived Backups"],
 *     "reason": "backup images, not documents"
 *   }
 *
 *   // Index its titles, paths and dates; never read its contents.
 *   {
 *     "id": "spirituality",
 *     "mode": "metadata_only",
 *     "sources": ["<source id>"],
 *     "path_prefixes": ["/3 Resources/Spirituality"],
 *     "reason": "index titles and dates, never read the contents"
 *   }
 *
 *   // Never ingest video over 100 MiB, wherever it lives. No `sources`, so
 *   // every connector that can enforce a media criterion applies it, and the
 *   // ones that cannot say so instead of matching nothing.
 *   {
 *     "id": "oversized-video",
 *     "media": {
 *       "extensions": [".mp4", ".mov", ".avi", ".mkv", ".m4v", ".mts"],
 *       "min_bytes": 104857600
 *     },
 *     "reason": "video over 100 MiB is never worth extracting"
 *   }
 */
export interface SourceIngestionExclusionRule {
  id: string;
  /**
   * What this rule asks for. Absent means `exclude`, so every rule written
   * before this field existed keeps its exact meaning — the reason the default
   * is not, and can never be, the softer disposition.
   *
   * An unrecognized value is REFUSED at parse rather than defaulted. A
   * misspelled `metadata_only` that quietly became an exclusion would delete
   * the contents of a folder the owner asked to keep indexed, and would do it
   * without a word.
   */
  mode: SourceIngestionRuleMode;
  /**
   * Empty means every source. The picker may persist `*` plus `!source.id`
   * when one source is edited out of a blanket rule; this exact complement
   * keeps the rule applicable to future sources without enumerating them.
   */
  sources: readonly string[];
  path_prefixes: readonly string[];
  folder_ids: readonly SourceIngestionExclusionFolder[];
  media?: SourceIngestionExclusionMedia;
  reason: string;
}

export interface SourceIngestionExclusions {
  schemaVersion: typeof SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION;
  rules: readonly SourceIngestionExclusionRule[];
}

/**
 * One compiled criterion.
 *
 * `prefix` is the receipt key, and it is always the owner's own configuration
 * after normalization — a normalized path, or `folder:<name> (<id>)` for an
 * identity criterion. Configuration, not item content, so it is the one
 * path-shaped value that may appear in a preview or receipt. It keeps its
 * original field name because it is the key `by_prefix` receipts are already
 * written against, and a receipt shape is read by surfaces this module cannot
 * see.
 *
 * `folderId` is present exactly when `kind` is `folder_id`, and it is what
 * matching actually compares; `prefix` is only ever displayed.
 */
export interface SourceExclusionCriterion {
  ruleId: string;
  reason: string;
  /**
   * The disposition this criterion asks for when it matches.
   */
  mode: SourceIngestionRuleMode;
  kind: SourceExclusionCriterionKind;
  prefix: string;
  folderId?: string;
  folderName?: string;
  media?: SourceIngestionExclusionMedia;
}

export interface SourceExclusionDecision {
  /**
   * True only for `disposition === 'exclude'`.
   *
   * Kept as its own field, and kept meaning exactly what it meant before
   * tonight, because every existing caller reads it — the crawl's descent gate,
   * the store's write refusal, the purge. A metadata-only item is ADMITTED, so
   * `excluded` is false for it, and no caller that only knows about two
   * dispositions can accidentally delete one.
   */
  excluded: boolean;
  disposition: SourceIngestionDisposition;
  outcome: SourceExclusionOutcome;
  ruleId?: string;
  reason?: string;
  prefix?: string;
}

/**
 * The evaluated gate for one source. `active` is false when the user configured
 * no exclusions for this source: there is then nothing to fail closed about,
 * and every item is admitted. Fail-closed applies to ambiguity WITHIN a
 * configured exclusion, never to the absence of configuration.
 *
 * `pathActive` and `identityActive` are separate because the two criteria fail
 * closed on different evidence. A source that publishes ancestry but no path
 * must not have every item ruled unevaluable merely because some rule
 * elsewhere in the file mentions a prefix, and vice versa.
 */
/**
 * Everything the gate can be told about ONE item.
 *
 * Every field is `unknown` on purpose: these values arrive from a frozen
 * provider metadata bag and from stored database columns, and a gate that
 * trusted its caller's types would be a gate whose fail-closed guarantee
 * depended on code it cannot see. Each is validated here.
 *
 * `path` alone is what a folder rule needs. A media rule needs `sizeBytes` too,
 * and reads the type from `path`, `name` or `mimeType` — whichever the provider
 * published.
 */
export interface SourceExclusionItemFacts {
  path?: unknown;
  name?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
  folderAncestorIds?: readonly string[] | undefined;
}

export interface SourceExclusionMatcher {
  readonly active: boolean;
  readonly pathActive: boolean;
  readonly identityActive: boolean;
  readonly mediaActive: boolean;
  /**
   * Rules that apply to this source and that it can enforce NOTHING of.
   *
   * Only blanket rules — ones naming no source — can land here; a rule that
   * named this source and cannot be enforced by it is refused outright. This
   * list is what keeps the blanket case from being the silent one: the gate
   * genuinely does nothing for these rules, and the ledger says which.
   */
  readonly unenforceableRuleIds: readonly string[];
  readonly criteria: readonly SourceExclusionCriterion[];
  evaluatePath(path: unknown): SourceExclusionDecision;
  evaluateMetadata(metadata: Readonly<Record<string, unknown>> | undefined): SourceExclusionDecision;
  /**
   * The full gate, over everything known about one item.
   *
   * `evaluatePath` and `evaluateMetadata` are both views of this: the first
   * supplies a path and nothing else, the second reads the facts out of a
   * provider metadata bag. Callers that hold structured facts — a provider
   * listing entry with a size on it — should call this directly, because a
   * media rule handed only a path can answer "is this a video" and never "is
   * it a big one", and the honest answer to a half-answerable question is
   * unevaluable, not admitted.
   */
  evaluateItem(facts: SourceExclusionItemFacts): SourceExclusionDecision;
}

/**
 * Metadata keys searched, in order, for an item's path.
 *
 * Provider-casefolded forms come first because they are the provider's own
 * answer to "are these the same path"; display forms follow. This is a
 * convention over the frozen `RawItem.metadata` bag rather than a contract
 * change — the contracts are frozen and adding a field to them is a CTO
 * decision, not an in-thread one.
 */
export const SOURCE_EXCLUSION_PATH_METADATA_KEYS = [
  'pathLower',
  'path_lower',
  'pathDisplay',
  'path_display',
  'path',
  'locatorPath',
] as const;

/**
 * Metadata keys searched, in order, for an item's resolved folder ancestry.
 *
 * The value is an array of provider folder ids: every folder the item is
 * reachable through, at any depth, not merely its immediate parents. A
 * connector that publishes this key is promising it walked to a root; the
 * promise is what makes a missing key mean "could not resolve" rather than
 * "has no ancestors", which is the distinction fail-closed turns on.
 *
 * An EMPTY array is a resolved answer — an item genuinely under no folder.
 * An ABSENT key is unresolved, and is excluded.
 */
export const SOURCE_EXCLUSION_ANCESTRY_METADATA_KEYS = [
  'folderAncestorIds',
  'folder_ancestor_ids',
] as const;

/**
 * Metadata keys searched, in order, for an item's size in BYTES.
 *
 * Bytes only. A provider that publishes a human string ("4.2 GB") does not
 * publish a size as far as this gate is concerned, and the item comes out
 * unevaluable rather than parsed by guesswork.
 */
export const SOURCE_EXCLUSION_SIZE_METADATA_KEYS = [
  'sizeBytes',
  'size_bytes',
  'size',
  'bytes',
] as const;

/**
 * Metadata keys searched, in order, for an item's media type.
 */
export const SOURCE_EXCLUSION_MIME_METADATA_KEYS = [
  'mimeType',
  'mime_type',
  'mediaType',
  'media_type',
] as const;

/**
 * Metadata keys searched, in order, for an item's file name.
 *
 * Only used when no path is available: a path already ends in the name, and
 * reading a separate `name` when a path exists risks the two disagreeing.
 */
export const SOURCE_EXCLUSION_NAME_METADATA_KEYS = [
  'name',
  'fileName',
  'file_name',
] as const;

const ADMITTED: SourceExclusionDecision = Object.freeze({
  excluded: false,
  disposition: 'admit',
  outcome: 'admitted',
});
const UNEVALUABLE: SourceExclusionDecision = Object.freeze({
  excluded: true,
  disposition: 'exclude',
  outcome: 'excluded_path_unevaluable',
  reason: 'path_unevaluable',
});
/**
 * The identity twin of UNEVALUABLE: a configured folder-identity rule cannot be
 * answered for this item, because nothing resolved its ancestry. Distinct from
 * the path case so a receipt can tell the owner which half of their
 * configuration went unanswerable — one means a provider path was missing, the
 * other means an ancestry walk failed, and the remedies are different.
 */
const ANCESTRY_UNEVALUABLE: SourceExclusionDecision = Object.freeze({
  excluded: true,
  disposition: 'exclude',
  outcome: 'excluded_ancestry_unevaluable',
  reason: 'ancestry_unevaluable',
});

/**
 * Normalize a path for comparison, or return undefined when it cannot be
 * compared safely.
 *
 * Undefined is not "no match" — it is "unevaluable", and every caller in this
 * module turns it into an exclusion. Cases that yield undefined:
 *
 *   - nothing to compare (empty, or only separators);
 *   - a relative traversal segment (`.` / `..`), which could walk out from
 *     under an excluded prefix and admit the very material being excluded;
 *   - an embedded NUL, which truncates in some downstream consumers and would
 *     make two different paths compare equal.
 *
 * `toLowerCase()` is deliberate over `toLocaleLowerCase()`: the latter is
 * locale-dependent (Turkish dotless i) and would make the gate's behaviour
 * depend on the host's locale.
 *
 * NFC normalization is load-bearing, not tidiness. Desktop clients hand back
 * decomposed (NFD) accents while provider APIs publish composed (NFC) ones; the
 * two are different strings that name the same folder, and comparing them raw
 * is precisely the silent leak this gate exists to prevent.
 */
export function normalizeSourceExclusionPath(value: string): string | undefined {
  if (value.includes('\u0000')) return undefined;
  const unified = value.normalize('NFC').trim().split('\\').join('/');
  const segments = unified.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined;
  return `/${segments.join('/')}`.toLowerCase();
}

/**
 * Segment-boundary containment. `/3 resources/books` covers the folder itself
 * and everything under it, but NOT `/3 resources/bookshelf.pdf`. A bare
 * `startsWith` would swallow the sibling — over-exclusion is the cheaper error
 * but it is still wrong, and it would make the purge preview lie about what a
 * prefix accounts for.
 */
function pathIsUnderPrefix(path: string, prefix: string): boolean {
  if (prefix === '/') return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The file extension of a name or path, lowercased and including its dot, or
 * undefined when there is none.
 *
 * Deliberately the LAST dot of the LAST segment. `archive.tar.gz` is a `.gz`,
 * and `holiday.mp4.txt` is a `.txt` — a document somebody named after a video,
 * not a video. Deliberately not a regex: this module is enrolled in the
 * architecture guard's source-agnostic list, where new regex routing is a
 * reviewable event, and a silent miss in a gate is a leak.
 */
export function sourceExclusionFileExtension(value: string): string | undefined {
  const segments = value.split('\\').join('/').split('/');
  const last = segments[segments.length - 1]?.trim() ?? '';
  const dot = last.lastIndexOf('.');
  // `dot <= 0` covers both "no dot at all" and a leading-dot dotfile, which is
  // a name rather than an extension.
  if (dot <= 0 || dot === last.length - 1) return undefined;
  return last.slice(dot).toLowerCase();
}

/**
 * Normalize a configured extension: lowercased, with exactly one leading dot.
 * An owner who writes `mp4` and an owner who writes `.MP4` mean the same thing,
 * and a rule that worked for one spelling and silently not the other would be
 * indistinguishable from a folder that has no videos in it.
 */
function normalizeMediaExtension(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  return withDot.length > 1 ? withDot : undefined;
}

/**
 * Whether an item's extension or MIME is the kind a media criterion names,
 * ignoring size entirely.
 *
 * Split out from the size test because the two halves fail differently and the
 * difference is the whole safety property. A known size may independently
 * satisfy a configured byte threshold even when name and MIME are opaque. With
 * no size, an item that IS a named type cannot be admitted, because "I could
 * not measure it" is not evidence that it is small; an item with neither kind
 * nor size evidence remains admitted.
 */
function mediaTypeMatches(media: SourceIngestionExclusionMedia, facts: MediaFacts): boolean {
  if (media.extensions.length > 0 && facts.extension !== undefined) {
    if (media.extensions.includes(facts.extension)) return true;
  }
  if (media.mime_prefixes.length > 0 && facts.mimeType !== undefined) {
    if (media.mime_prefixes.some((prefix) => facts.mimeType!.startsWith(prefix))) return true;
  }
  return false;
}

/**
 * Whether the type half has nothing at all to read: no extension, and either no
 * MIME or one that names no type. Distinct from "the type does not match",
 * which is an answer.
 */
function mediaTypeUnevaluable(facts: MediaFacts): boolean {
  if (facts.extension !== undefined) return false;
  return facts.mimeType === undefined || facts.mimeType === 'application/octet-stream';
}

/**
 * Whether a media criterion needs a byte count at all to reach a verdict.
 */
function mediaNeedsSize(media: SourceIngestionExclusionMedia): boolean {
  return media.min_bytes !== undefined || media.max_bytes !== undefined;
}

function mediaSizeMatches(media: SourceIngestionExclusionMedia, sizeBytes: number): boolean {
  if (media.min_bytes !== undefined && sizeBytes < media.min_bytes) return false;
  if (media.max_bytes !== undefined && sizeBytes > media.max_bytes) return false;
  return true;
}

interface MediaFacts {
  extension?: string;
  mimeType?: string;
  sizeBytes?: number;
}

/**
 * A receipt key for a media criterion, built from the owner's own configuration
 * and nothing else.
 *
 * The same role `prefix` plays for a folder rule: without it a preview cannot
 * answer "which of my rules does this count belong to". Bounded, because a
 * pathological configuration must not be able to turn a receipt row into a
 * payload.
 */
function mediaCriterionLabel(media: SourceIngestionExclusionMedia): string {
  const parts: string[] = [];
  if (media.extensions.length > 0) parts.push(media.extensions.join(' '));
  if (media.mime_prefixes.length > 0) parts.push(media.mime_prefixes.join(' '));
  if (media.min_bytes !== undefined) parts.push(`>=${media.min_bytes}B`);
  if (media.max_bytes !== undefined) parts.push(`<=${media.max_bytes}B`);
  const label = `media:${parts.join(' ')}`;
  return label.length <= 200 ? label : `${label.slice(0, 197)}...`;
}

/**
 * Read the item's path out of the frozen metadata bag. Returns undefined when
 * no key holds a usable string, which the caller treats as unevaluable.
 */
export function sourceExclusionPathFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!metadata) return undefined;
  for (const key of SOURCE_EXCLUSION_PATH_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

/**
 * Read the item's resolved folder ancestry out of the frozen metadata bag.
 *
 * Returns undefined when no key holds an array of ids, which the caller treats
 * as unevaluable. A key holding a non-array, or an array with a non-string in
 * it, is undefined too rather than the strings it happens to contain: a
 * partially-typed ancestry is a partially-walked ancestry, and half an ancestry
 * that misses the excluded folder reads exactly like a clean one.
 */
export function sourceExclusionAncestryFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string[] | undefined {
  if (!metadata) return undefined;
  for (const key of SOURCE_EXCLUSION_ANCESTRY_METADATA_KEYS) {
    const value = metadata[key];
    if (!Array.isArray(value)) continue;
    if (value.some((entry) => typeof entry !== 'string')) return undefined;
    return (value as string[]).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return undefined;
}

/**
 * Read the item's size in bytes out of the frozen metadata bag.
 *
 * A non-finite, negative, or non-integer value is undefined rather than
 * coerced: a size the gate cannot trust is a size the gate does not have, and
 * the caller's fail-closed handling is the correct answer to that, not a
 * rounded guess.
 */
export function sourceExclusionSizeFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): number | undefined {
  if (!metadata) return undefined;
  for (const key of SOURCE_EXCLUSION_SIZE_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value !== 'number') continue;
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.floor(value);
  }
  return undefined;
}

function boundedStringFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * The facts view of a frozen provider metadata bag. Exported so a connector
 * holding structured entries can see exactly which keys the gate reads, rather
 * than discovering by absence that it published the size under a name nothing
 * looks at.
 */
export function sourceExclusionFactsFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): SourceExclusionItemFacts {
  const path = sourceExclusionPathFromMetadata(metadata);
  const name = boundedStringFromMetadata(metadata, SOURCE_EXCLUSION_NAME_METADATA_KEYS);
  const mimeType = boundedStringFromMetadata(metadata, SOURCE_EXCLUSION_MIME_METADATA_KEYS);
  const sizeBytes = sourceExclusionSizeFromMetadata(metadata);
  const ancestry = sourceExclusionAncestryFromMetadata(metadata);
  return {
    ...(path !== undefined ? { path } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    folderAncestorIds: ancestry,
  };
}

/**
 * Compile the rules that apply to one source into a gate.
 *
 * `source` undefined selects only rules that apply to every source. Rules are
 * kept in configuration order and the first matching prefix wins, so a preview
 * attributes each item to exactly one prefix and the per-prefix counts sum to
 * the total instead of double-counting overlapping folders.
 */
/**
 * What a source is able to enforce, declared by the wiring layer that knows
 * the provider.
 *
 * This exists because the alternative is silence. A rule written against a
 * criterion a source cannot evaluate does not fail — it matches nothing, and
 * matching nothing is indistinguishable from a folder that happens to be
 * empty. Making each source say what it can enforce turns that into a refusal
 * at construction, before a single item is read.
 *
 * Omitting it is allowed and means "unknown": the matcher compiles every rule
 * and checks nothing. Callers that know their provider should always pass it.
 */
export interface SourceExclusionMatcherOptions {
  enforceable?: readonly SourceExclusionCriterionKind[];
}

export function createSourceExclusionMatcher(
  exclusions: SourceIngestionExclusions | undefined,
  source?: string,
  options: SourceExclusionMatcherOptions = {},
): SourceExclusionMatcher {
  const enforceable = options.enforceable ? new Set(options.enforceable) : undefined;
  // A criterion this source cannot evaluate does not compile for it. That
  // matters most for the shape this primitive is FOR: one rule naming two
  // providers, a prefix for the one with paths and an id for the one with
  // identities. Compiling the prefix into the identity source's gate would make
  // every one of its items unevaluable — the whole corpus excluded by a line
  // written for a different provider.
  const usePath = !enforceable || enforceable.has('path_prefix');
  const useFolder = !enforceable || enforceable.has('folder_id');
  const useMedia = !enforceable || enforceable.has('media');
  const criteria: SourceExclusionCriterion[] = [];
  const unenforceableRuleIds: string[] = [];
  for (const rule of exclusions?.rules ?? []) {
    if (!sourceExclusionRuleAppliesToSource(rule, source)) continue;
    if (usePath) {
      for (const prefix of rule.path_prefixes) {
        criteria.push({ ruleId: rule.id, reason: rule.reason, mode: rule.mode, kind: 'path_prefix', prefix });
      }
    }
    if (useFolder) {
      for (const folder of rule.folder_ids) {
        criteria.push({
          ruleId: rule.id,
          reason: rule.reason,
          mode: rule.mode,
          kind: 'folder_id',
          prefix: `folder:${folder.name} (${folder.id})`,
          folderId: folder.id,
          folderName: folder.name,
        });
      }
    }
    if (useMedia && rule.media) {
      criteria.push({
        ruleId: rule.id,
        reason: rule.reason,
        mode: rule.mode,
        kind: 'media',
        prefix: mediaCriterionLabel(rule.media),
        media: rule.media,
      });
    }
    const enforced = (rule.path_prefixes.length > 0 && usePath)
      || (rule.folder_ids.length > 0 && useFolder)
      || (rule.media !== undefined && useMedia);
    if (enforced) continue;
    // Nothing this rule says can be enforced here. Two different situations,
    // and they get different answers because the owner asserted different
    // things.
    //
    // The rule NAMED this source: the owner said "apply this here", and here
    // cannot. That is a mistake in their file, it is fixed by editing one line,
    // and it is refused now — at construction, before any item is read — rather
    // than discovered later as a folder that was never actually excluded.
    if (rule.sources.length > 0 && !rule.sources.includes('*')) {
      throw new OperationError(
        'config_error',
        `Exclusion rule ${rule.id} names source ${source ?? '(none)'}, which cannot enforce `
        + `${rule.folder_ids.length > 0 ? 'folder ids' : 'path prefixes'}. `
        + `This source enforces: ${[...(enforceable ?? [])].join(', ') || '(nothing)'}. `
        + 'Give the rule a criterion this source supports, or drop the source from its list.',
      );
    }
    // The rule named NO source: it is the owner's blanket rule and they never
    // asserted it fits this provider. Refusing would take a whole lane down
    // over a line written for a different one. So it is recorded instead, and
    // the ledger prints it — the rule is unenforced here, and the owner is told
    // which one and where. Silence is the only outcome ruled out.
    unenforceableRuleIds.push(rule.id);
  }
  return createSourceExclusionMatcherFromPrefixes(criteria, unenforceableRuleIds);
}

/**
 * The gate over an already-selected prefix set. Split out so the purge can
 * build a matcher from the same prefixes the ingestion gate uses without
 * re-deriving them, and so tests can exercise the gate directly.
 */
export function createSourceExclusionMatcherFromPrefixes(
  prefixes: readonly SourceExclusionCriterion[],
  unenforceableRuleIds: readonly string[] = [],
): SourceExclusionMatcher {
  const compiled = prefixes.map((entry) => {
    // Only a path criterion normalizes as a path. A folder criterion's `prefix`
    // and a media criterion's label are display strings built from
    // configuration, and running either through path arithmetic would either
    // mangle it or reject it.
    if (entry.kind === 'folder_id' || entry.kind === 'media') {
      return { ...entry };
    }
    const normalized = normalizeSourceExclusionPath(entry.prefix);
    if (normalized === undefined) {
      throw new OperationError(
        'config_error',
        `Exclusion rule ${entry.ruleId} carries a path prefix that cannot be normalized.`,
      );
    }
    return { ...entry, prefix: normalized };
  });
  const pathCriteria = compiled.filter((entry) => entry.kind === 'path_prefix');
  const folderCriteria = compiled.filter((entry) => entry.kind === 'folder_id');
  const mediaCriteria = compiled.filter((entry) => entry.kind === 'media');
  const pathActive = pathCriteria.length > 0;
  const identityActive = folderCriteria.length > 0;
  const mediaActive = mediaCriteria.length > 0;
  const active = pathActive || identityActive || mediaActive;

  const matched = (
    entry: SourceExclusionCriterion,
    outcome: SourceExclusionOutcome,
  ): SourceExclusionDecision => ({
    excluded: entry.mode === 'exclude',
    disposition: entry.mode,
    outcome,
    ruleId: entry.ruleId,
    reason: entry.reason,
    prefix: entry.prefix,
  });

  /**
   * The unevaluable answer for one mode.
   *
   * An exclusion that cannot be answered is an exclusion, for the reason at the
   * top of this file. A METADATA-ONLY rule that cannot be answered is
   * metadata-only, by the same argument one step softer: the gate cannot prove
   * the item is outside the rule, so it applies the rule. Neither ever returns
   * "admitted" on evidence it does not have.
   */
  const unevaluableFor = (
    mode: SourceIngestionRuleMode,
    excludeOutcome: SourceExclusionOutcome,
    reason: string,
  ): SourceExclusionDecision => mode === 'exclude'
    ? { excluded: true, disposition: 'exclude', outcome: excludeOutcome, reason }
    : { excluded: false, disposition: 'metadata_only', outcome: 'metadata_only_unevaluable', reason };

  const evaluateModeCriteria = (
    mode: SourceIngestionRuleMode,
    normalizedPath: string | undefined,
    mediaFacts: MediaFacts,
    ancestry: readonly string[] | undefined,
  ): SourceExclusionDecision | undefined => {
    if (normalizedPath !== undefined) {
      for (const entry of pathCriteria) {
        if (entry.mode !== mode) continue;
        if (!pathIsUnderPrefix(normalizedPath, entry.prefix)) continue;
        return matched(entry, mode === 'exclude' ? 'excluded_path_prefix' : 'metadata_only_path_prefix');
      }
    }
    const folderForMode = folderCriteria.filter((entry) => entry.mode === mode);
    if (folderForMode.length > 0) {
      if (ancestry === undefined) {
        return unevaluableFor(mode, 'excluded_ancestry_unevaluable', 'ancestry_unevaluable');
      }
      const reachable = new Set(ancestry);
      for (const entry of folderForMode) {
        if (!entry.folderId || !reachable.has(entry.folderId)) continue;
        return matched(entry, mode === 'exclude' ? 'excluded_folder_id' : 'metadata_only_folder_id');
      }
    }
    for (const entry of mediaCriteria) {
      if (entry.mode !== mode || !entry.media) continue;
      // The halves are ANDed, as the interface contract above and the plugin
      // config schema both promise: `{extensions: ['.mp4'], min_bytes: N}` is
      // "an mp4, AND at least N bytes", so a 150 MB scanned PDF is not the
      // owner's video rule's business. The size half decides alone only where
      // the type half has NOTHING to read — an opaque provider id with
      // application/octet-stream — because there a measured size crossing the
      // owner's bound is the only evidence in existence. A type that is known
      // and simply does not match is a decided no, not an absent answer.
      const typeMatches = mediaTypeMatches(entry.media, mediaFacts);
      const sizeMatches = mediaNeedsSize(entry.media)
        && mediaFacts.sizeBytes !== undefined
        && mediaSizeMatches(entry.media, mediaFacts.sizeBytes);
      if (!typeMatches && !(sizeMatches && mediaTypeUnevaluable(mediaFacts))) continue;
      if (!mediaNeedsSize(entry.media)) {
        return matched(entry, mode === 'exclude' ? 'excluded_media' : 'metadata_only_media');
      }
      if (mediaFacts.sizeBytes === undefined) {
        return unevaluableFor(mode, 'excluded_media_unevaluable', 'media_size_unevaluable');
      }
      if (!sizeMatches) continue;
      return matched(entry, mode === 'exclude' ? 'excluded_media' : 'metadata_only_media');
    }
    return undefined;
  };

  /**
   * The whole gate, over everything known about one item.
   *
   * Modes are consulted STRICTEST FIRST, so an exclusion always beats a
   * metadata-only rule covering the same item no matter which order the owner
   * wrote them in.
   */
  const evaluateItem = (facts: SourceExclusionItemFacts): SourceExclusionDecision => {
    if (!active) return ADMITTED;
    const normalizedPath = typeof facts.path === 'string'
      ? normalizeSourceExclusionPath(facts.path)
      : undefined;
    // Path unevaluability is decided ONCE, for every mode at the same time,
    // before any criterion is consulted. It has to be: an unreadable path
    // leaves every path rule in the file unanswered, including the strictest
    // one, so the strictest answer is the only honest one. Deciding it per-mode
    // would let an item whose path could not be read come back "metadata_only"
    // merely because the exclusions were listed after the softer rules.
    if (pathActive && normalizedPath === undefined) return UNEVALUABLE;
    const mediaFacts: MediaFacts = {};
    if (mediaActive) {
      // The path already ends in the file name, so it is the better source for
      // an extension; `name` is the fallback for providers that publish one and
      // no path at all.
      const nameish = typeof facts.path === 'string' && facts.path.trim()
        ? facts.path
        : (typeof facts.name === 'string' ? facts.name : undefined);
      const extension = nameish === undefined ? undefined : sourceExclusionFileExtension(nameish);
      if (extension !== undefined) mediaFacts.extension = extension;
      if (typeof facts.mimeType === 'string' && facts.mimeType.trim()) {
        mediaFacts.mimeType = facts.mimeType.trim().toLowerCase();
      }
      if (typeof facts.sizeBytes === 'number' && Number.isFinite(facts.sizeBytes) && facts.sizeBytes >= 0) {
        mediaFacts.sizeBytes = Math.floor(facts.sizeBytes);
      }
    }
    for (const mode of SOURCE_INGESTION_DISPOSITION_ORDER) {
      const decision = evaluateModeCriteria(mode, normalizedPath, mediaFacts, facts.folderAncestorIds);
      if (decision) return decision;
    }
    return ADMITTED;
  };

  /**
   * The path-only view of the gate, for callers holding a path and nothing
   * else — a provider walk entry, or a stored row's locator.
   *
   * When identity criteria are configured, a bare path CANNOT answer them, and
   * saying "admitted" would be asserting something this input cannot support.
   * So the answer is unevaluable, and each caller applies its own direction:
   * excluded at ingestion, kept and reported at purge. A media criterion whose
   * TYPE half a path can answer and whose size half it cannot lands in the same
   * place, for the same reason — a stored row keeps a locator, not a byte
   * count, so "this is a video, of unknown size" is exactly as far as a path
   * can get.
   */
  const evaluatePath = (path: unknown): SourceExclusionDecision => evaluateItem({ path });

  const evaluateMetadata = (
    metadata: Readonly<Record<string, unknown>> | undefined,
  ): SourceExclusionDecision => evaluateItem(sourceExclusionFactsFromMetadata(metadata));

  return {
    active,
    pathActive,
    identityActive,
    mediaActive,
    unenforceableRuleIds: Object.freeze([...new Set(unenforceableRuleIds)]),
    criteria: Object.freeze(compiled.map((entry) => Object.freeze({ ...entry }))),
    evaluatePath,
    evaluateMetadata,
    evaluateItem,
  };
}


/**
 * The excluded prefixes rewritten so that a plain string-prefix test gives the
 * same answer this module's segment-boundary test does.
 *
 * Some older lanes fence themselves with `LIKE 'prefix%'` rather than calling a
 * matcher. Handed `/3 resources/books` those lanes would also swallow
 * `/3 resources/bookshelf.pdf`; handed `/3 resources/books/` they match exactly
 * the folder's descendants and nothing else. Over-exclusion is the cheaper
 * error, but a fence that means something different from the gate is a fence
 * nobody can reason about.
 *
 * Descendants only: the folder's own row is not a content-lane candidate, and
 * these consumers process files.
 *
 * BOTH dispositions appear here, and that is deliberate rather than an
 * oversight. These consumers fence CONTENT LANES — extraction, transcription —
 * not indexing, and keeping a folder's contents out of the content lanes is
 * precisely what `metadata_only` asks for. An excluded folder and a
 * metadata-only folder want the identical answer from a content lane; they
 * differ only in whether the item row exists at all, which these consumers do
 * not decide.
 *
 * Media criteria are not representable as a string prefix and are omitted, so
 * a lane fenced this way does not enforce them. That omission is REPORTED
 * rather than silent: the matcher publishes `mediaActive`, and a caller that
 * fences by prefix alone while media rules are configured is enforcing part of
 * the owner's configuration, which the ledger says out loud.
 *
 * Identity criteria are not representable as a string prefix and are omitted.
 * That is safe only because a lane fenced this way is fenced BY PATH — a
 * provider whose exclusions are expressed by folder identity cannot be fenced
 * with `LIKE`, and handing such a lane a fabricated prefix would be worse than
 * handing it none.
 */
export function sourceExclusionDescendantPrefixes(matcher: SourceExclusionMatcher): string[] {
  return [...new Set(
    matcher.criteria
      .filter((entry) => entry.kind === 'path_prefix')
      .map((entry) => `${entry.prefix}/`),
  )];
}

export function sourceExclusionRuleAppliesToSource(
  rule: SourceIngestionExclusionRule,
  source: string | undefined,
): boolean {
  if (rule.sources.length === 0) return true;
  if (source === undefined) return false;
  const wanted = source.trim().toLowerCase();
  if (rule.sources.includes(`!${wanted}`)) return false;
  return rule.sources.includes('*') || rule.sources.includes(wanted);
}

export function parseSourceIngestionExclusions(
  rawExclusions: unknown,
  label = 'source ingestion exclusions',
): SourceIngestionExclusions {
  const root = asRecord(rawExclusions);
  if (!root) throw new OperationError('config_error', `${label} must be an object.`);
  if (root.schemaVersion !== SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION) {
    throw new OperationError('config_error', `${label}.schemaVersion must be 1.`);
  }
  if (root.rules !== undefined && !Array.isArray(root.rules)) {
    throw new OperationError('config_error', `${label}.rules must be an array.`);
  }
  const rawRules = root.rules ?? [];
  const seenIds = new Set<string>();
  const rules = rawRules.map((value, index) => {
    const rule = parseRule(value, `${label}.rules[${index}]`);
    if (seenIds.has(rule.id)) {
      throw new OperationError('config_error', `${label}.rules ids must be unique; ${rule.id} repeats.`);
    }
    seenIds.add(rule.id);
    return rule;
  });
  return { schemaVersion: SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION, rules };
}

function parseRule(value: unknown, label: string): SourceIngestionExclusionRule {
  const record = asRecord(value);
  if (!record) throw new OperationError('config_error', `${label} must be an object.`);
  const id = requiredToken(record.id, `${label}.id`);
  const sources = parseSources(record.sources, `${label}.sources`);
  const path_prefixes = [...new Set(stringList(record.path_prefixes).map((prefix) => {
    const normalized = normalizeSourceExclusionPath(prefix);
    if (normalized === undefined) {
      // A prefix that cannot be normalized is refused at parse time rather than
      // silently dropped. Dropping it would leave the user believing a folder
      // is excluded while ingestion happily admits it.
      throw new OperationError('config_error', `${label}.path_prefixes contains a path that cannot be normalized.`);
    }
    return normalized;
  }))];
  const folder_ids = parseFolderIds(record.folder_ids, `${label}.folder_ids`);
  const media = parseMedia(record.media, `${label}.media`);
  const mode = parseRuleMode(record.mode, `${label}.mode`);
  if (path_prefixes.length === 0 && folder_ids.length === 0 && media === undefined) {
    throw new OperationError(
      'config_error',
      `${label} must name at least one folder, by path_prefixes or by folder_ids, or carry a media criterion.`,
    );
  }
  if (media !== undefined && (path_prefixes.length > 0 || folder_ids.length > 0)) {
    // "Videos over 100 MB" and "everything under /X" in one rule reads as AND
    // to one person and OR to the next. Both readings are defensible; the one
    // nobody checked is the one that under-matches, and an exclusion that
    // under-matches is the exact failure this module exists to prevent. Two
    // rules say it unambiguously and cost the owner one extra line.
    throw new OperationError(
      'config_error',
      `${label} may not combine a media criterion with path_prefixes or folder_ids. `
      + 'Write the media rule and the folder rule as two rules, so which items each covers is unambiguous.',
    );
  }
  if (folder_ids.length > 0 && !sources.some((entry) => entry !== '*' && !entry.startsWith('!'))) {
    // A folder id is minted by one provider and means nothing to another, so an
    // unscoped identity rule is not a broad rule — it is a rule that cannot be
    // true anywhere but one place, with the place left off. Refusing it here
    // costs the owner one line and removes a whole class of "why did this never
    // match" from the system.
    throw new OperationError(
      'config_error',
      `${label}.folder_ids requires ${label}.sources: a folder id belongs to one provider and cannot apply to every source.`,
    );
  }
  return {
    id,
    mode,
    sources,
    path_prefixes,
    folder_ids,
    ...(media !== undefined ? { media } : {}),
    reason: typeof record.reason === 'string' && record.reason.trim()
      ? record.reason.trim()
      : (mode === 'metadata_only' ? 'metadata_only_by_configuration' : 'excluded_by_configuration'),
  };
}

/**
 * The rule's disposition, defaulting to the one every rule written before this
 * field existed already meant.
 *
 * An unrecognized value is REFUSED rather than defaulted, and that is the
 * point. Defaulting a misspelled `metadata_only` to `exclude` would delete the
 * contents of a folder the owner asked to keep indexed, and would do it
 * silently; defaulting it to `metadata_only` would admit a folder the owner
 * asked to keep out. There is no safe default for a typo, so there is no
 * default for a typo.
 */
function parseRuleMode(value: unknown, label: string): SourceIngestionRuleMode {
  if (value === undefined || value === null) return 'exclude';
  if (typeof value !== 'string') {
    throw new OperationError('config_error', `${label} must be a string.`);
  }
  const mode = value.trim().toLowerCase();
  const known = SOURCE_INGESTION_RULE_MODES.find((candidate) => candidate === mode);
  if (!known) {
    throw new OperationError(
      'config_error',
      `${label} must be one of ${SOURCE_INGESTION_RULE_MODES.join(', ')}; got ${JSON.stringify(value)}.`,
    );
  }
  return known;
}

/**
 * A media criterion: what an item IS, rather than where it lives.
 *
 * The type half is REQUIRED. See `SourceIngestionExclusionMedia` for why a
 * size-only rule would fail a whole corpus closed rather than match a video.
 */
function parseMedia(value: unknown, label: string): SourceIngestionExclusionMedia | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  if (!record) throw new OperationError('config_error', `${label} must be an object.`);
  const extensions = [...new Set(stringList(record.extensions)
    .map((entry) => normalizeMediaExtension(entry))
    .filter((entry): entry is string => entry !== undefined))];
  const mime_prefixes = [...new Set(stringList(record.mime_prefixes).map((entry) => entry.toLowerCase()))];
  if (extensions.length === 0 && mime_prefixes.length === 0) {
    throw new OperationError(
      'config_error',
      `${label} must name at least one extension or mime prefix. A size-only media rule cannot be `
      + 'answered for items whose provider publishes no size, so it would exclude them all.',
    );
  }
  const min_bytes = parseByteCount(record.min_bytes, `${label}.min_bytes`);
  const max_bytes = parseByteCount(record.max_bytes, `${label}.max_bytes`);
  if (min_bytes !== undefined && max_bytes !== undefined && min_bytes > max_bytes) {
    throw new OperationError('config_error', `${label}.min_bytes must not exceed ${label}.max_bytes.`);
  }
  return {
    extensions,
    mime_prefixes,
    ...(min_bytes !== undefined ? { min_bytes } : {}),
    ...(max_bytes !== undefined ? { max_bytes } : {}),
  };
}

function parseByteCount(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new OperationError('config_error', `${label} must be a non-negative whole number of bytes.`);
  }
  return value;
}

/**
 * Folder identities, each an opaque provider id plus the name it had when the
 * owner wrote it down.
 *
 * The id is NOT normalized beyond trimming: it is the provider's own token,
 * case-sensitive, and lowercasing it the way a path is lowercased would break
 * every comparison. That asymmetry with `path_prefixes` is deliberate — paths
 * are compared case-insensitively because file storage is, and ids are compared
 * exactly because identifiers are.
 */
function parseFolderIds(value: unknown, label: string): SourceIngestionExclusionFolder[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new OperationError('config_error', `${label} must be an array.`);
  const folders: SourceIngestionExclusionFolder[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const record = asRecord(entry);
    if (!record) throw new OperationError('config_error', `${label}[${index}] must be an object with id and name.`);
    const id = requiredBoundedString(record.id, `${label}[${index}].id`, 256);
    const name = requiredBoundedString(record.name, `${label}[${index}].name`, 512);
    if (seen.has(id)) return;
    seen.add(id);
    folders.push({ id, name });
  });
  return folders;
}

/**
 * Where a user's exclusion list lives when it is not inline in plugin config.
 * Same directory as the per-source ingestion policies, because setup writes
 * both and an operator looking for one should find the other beside it.
 */
export function defaultSourceIngestionExclusionsPath(): string {
  return join(homedir(), '.olympus', 'sources', 'ingestion-exclusions.json');
}

export interface SourceIngestionExclusionsLoadOptions {
  inlineExclusions?: unknown | undefined;
  exclusionsPath?: string | undefined;
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the user's exclusion list: inline configuration first, then an
 * explicit path, then the environment override, then the default file.
 *
 * A MISSING file yields an empty list, which is correct — a user who has
 * configured nothing has excluded nothing. A file that EXISTS but cannot be
 * parsed throws, and callers must not swallow it: silently treating a broken
 * exclusion list as "no exclusions" is the exact failure this primitive exists
 * to prevent, and it would leak on every subsequent pass.
 */
export function loadSourceIngestionExclusions(
  options: SourceIngestionExclusionsLoadOptions = {},
): SourceIngestionExclusions {
  if (options.inlineExclusions !== undefined) {
    return parseSourceIngestionExclusions(options.inlineExclusions, 'inline source ingestion exclusions');
  }
  const env = options.env ?? process.env;
  const path = options.exclusionsPath?.trim()
    || env[SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]?.trim()
    || defaultSourceIngestionExclusionsPath();
  if (!existsSync(path)) return { schemaVersion: SOURCE_INGESTION_EXCLUSIONS_SCHEMA_VERSION, rules: [] };
  return parseSourceIngestionExclusions(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Rule ids are receipt keys, so they are restricted to a safe token shape.
 * Checked by character class rather than a pattern to keep this module free of
 * regex literals.
 */
function requiredToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OperationError('config_error', `${label} must be a non-empty string.`);
  }
  const token = value.trim();
  if (token.length > 64) {
    throw new OperationError('config_error', `${label} must be at most 64 characters.`);
  }
  for (const character of token) {
    const safe = (character >= 'a' && character <= 'z')
      || (character >= 'A' && character <= 'Z')
      || (character >= '0' && character <= '9')
      || character === '-' || character === '_' || character === '.';
    if (!safe) {
      throw new OperationError('config_error', `${label} may only use letters, digits, dot, dash, and underscore.`);
    }
  }
  return token;
}

/**
 * A required string with a length ceiling. Unlike `requiredToken` this does not
 * restrict the character class: a provider id is the provider's to shape, and a
 * folder name is the owner's prose. The ceiling is all that is enforced, so a
 * pathological configuration cannot turn a receipt row into a payload.
 */
function requiredBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OperationError('config_error', `${label} must be a non-empty string.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new OperationError('config_error', `${label} must be at most ${maxLength} characters.`);
  }
  // Same reason NUL disqualifies a path: it truncates in some consumers, so
  // two different ids could compare equal downstream.
  if (text.includes('\u0000')) {
    throw new OperationError('config_error', `${label} must not contain a NUL.`);
  }
  return text;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    )]
    : [];
}

function parseSources(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new OperationError('config_error', `${label} must be an array.`);
  }
  const sources: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new OperationError('config_error', `${label}[${index}] must be a non-empty string.`);
    }
    const source = entry.trim().toLowerCase();
    if (source.length > 256 || source.includes('\u0000')) {
      throw new OperationError('config_error', `${label}[${index}] is not a valid source token.`);
    }
    if (!sources.includes(source)) sources.push(source);
  }
  return sources;
}
