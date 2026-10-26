// A source's one connector, fed by more than one input (contract 2.2.0,
// docs/design/archive-live-one-dataset.md, sections 1 and 2).
//
// The live reader is one input; each imported archive is another, emitting the
// live reader's own record shape. This module is the one place records become
// items: it decides, per record and before the item is built, whether the
// record applies against what the store holds, then builds every applied
// record with the source's own builder. Nothing here names a source or a
// format, and nothing downstream of the connector learns which input an item
// came from.
//
// The decision keeps no state of its own. The store is the record of what
// applied (the lookup the store lane gives a listing), so a crash replays a
// record and decides again, and only the pass's own earlier records are
// remembered (a pass is stored only after it was listed).

import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorInput,
  SourceConnectorListOptions,
  SourceConnectorListPage,
  SourceInputKind,
  SourceRecordPage,
  StoredItemState,
} from './contracts.ts';
import type { SourceFamily, SourceItemIdentity } from './source-index/types.ts';

/** One item a record yields: the record's own item first, then its children. */
export interface SourceRecordEntry {
  /** With the version the record carries (`sourceVersion`). Nothing is read or built to tell. */
  identity: SourceItemIdentity;
  /** Whether the record carries this item's content, not only its names. */
  bringsContent: boolean;
  /** The record is the provider's deletion of this item: at the version the store holds, a deletion beats its content. */
  deletes?: boolean;
  /** When the item was written (ISO), for the history an input covers. Only the record's own item is asked. */
  authoredAt?: string;
}

/**
 * The per-source part of turning a record into an item: the only code a source
 * writes for it, whichever input the record came from.
 */
export interface SourceRecordBuilder<R> {
  readonly family: SourceFamily;
  /**
   * The items a record yields, cheaply: the record's own first, then its
   * children (2.1.0). The version order is the source's, so this and
   * `compareVersions` are the only places a version is read.
   */
  entriesOf(record: R): readonly SourceRecordEntry[];
  /** The source's own order of two versions of one item: negative when `a` is older than `b`, zero when equal. */
  compareVersions(a: string, b: string): number;
  /** The one code path from a record to its items; `wanted` names the entries to build (the others are skipped). */
  build(record: R, wanted: ReadonlySet<string>): readonly RawItem[] | Promise<readonly RawItem[]>;
  fetchItem(localItemId: string, options?: SourceConnectorFetchOptions): Promise<RawItem>;
  classificationSignals(item: RawItem): SourceClassificationSignals;
  authenticate?(): Promise<void>;
}

export type IntakeDecision =
  /** The record applies: nothing is stored for the item, or the record is newer, or it adds what is missing, or it is live's on a tie. */
  | 'apply'
  /** The store holds a newer version of the item. */
  | 'skip_older'
  /** The store holds this version already, and the record brings nothing it lacks. */
  | 'skip_same';

/**
 * Whether a record applies (design section 2). The source's own order decides
 * which version is newer; nothing downstream compares versions.
 *
 * - Nothing stored, or a stored item with no version to compare: it applies.
 * - Newer than the newest version any row of the item holds (a tombstone and a
 *   lone leg included): it applies, whichever input it came from.
 * - Older: it never applies, so a queued live record cannot undo a later edit
 *   an archive holds, and an old export never restores what was deleted or
 *   made a Secret, nor overwrites an item that is only partly written.
 * - The same version: it applies when the item is incomplete (a record of its
 *   own version completes it) and when it brings content the stored item
 *   lacks; and on a tie (both hold content) live's record is the one kept, so
 *   a live record applies and an archive record does not. A live record that
 *   is identical to the stored item is a no-op in the store.
 * - Every row a tombstone: only a newer record brings the item back (live's
 *   word counts only where no version can be compared). A deletion or Secret cut
 *   off between legs is finished from its write intent before any record is
 *   decided, so a tombstone seen here is whole.
 */
export function decideIntake(args: {
  input: SourceInputKind;
  version: string | undefined;
  bringsContent: boolean;
  deletes?: boolean;
  stored: StoredItemState | undefined;
  compareVersions: (a: string, b: string) => number;
}): IntakeDecision {
  const { stored } = args;
  if (!stored) return 'apply';
  // The stored version is the newest any row holds: the boundary, whatever the rows' completeness or visibility.
  // A record that carries no version is taken as the stored one's.
  const order = stored.version === undefined ? undefined : args.version === undefined ? 0 : args.compareVersions(args.version, stored.version);
  if (stored.tombstoned === true) {
    // Deleted, or a Secret kept as a location only: an older or equal record never brings it back; a newer one does,
    // and live's own word wins a tie (or an unknown version), as it does for any item.
    if (order !== undefined && order > 0) return 'apply';
    // (A deletion cut off between legs is finished by the set before any record is decided: a tombstone here is whole.)
    if (args.input === 'live' && order === undefined) return 'apply';
    return order !== undefined && order < 0 ? 'skip_older' : 'skip_same';
  }
  // A stored item with no version to compare (an old row) is completed by the next record.
  if (order === undefined) return 'apply';
  // The provider's deletion of the version stored beats its content.
  if (args.deletes === true && order >= 0) return 'apply';
  if (order > 0) return 'apply';
  // The record whose body a cut-off write still owes is replayed whatever its place in the order.
  if (order < 0) return stored.incomplete === true && stored.owedBodyVersion !== undefined && args.bringsContent && args.version !== undefined
    && args.compareVersions(args.version, stored.owedBodyVersion) >= 0 ? 'apply' : 'skip_older';
  // An item cut off between legs (a write still owed) is completed by a record of its own version.
  if (stored.incomplete === true) return 'apply';
  if (!args.bringsContent) return 'skip_same';
  if (!stored.hasContent) return 'apply';
  return args.input === 'live' ? 'apply' : 'skip_same';
}

/** What happened to one record of a page, in the page's order. */
export interface SourceIntakeOutcome {
  /** The record's own item. */
  localItemId: string;
  decision: IntakeDecision;
  /** The store (or an earlier record of this pass) held the record's own item before it. */
  alreadyThere: boolean;
  /** When the record's own item was written (ISO), when the record says. */
  authoredAt?: string;
}

/**
 * An input that wants to see its pages' outcomes (an archive input counts what
 * it read, and how much of it was already there): told once per page of
 * records, in the page's order, before the page's items go out.
 */
export interface IntakeObservingInput<R = unknown> extends SourceConnectorInput<R> {
  observeIntake?(outcomes: readonly SourceIntakeOutcome[]): void;
}

const hasContent = (item: RawItem): boolean => item.content.kind !== 'metadata_only';

/**
 * Where a listing stopped inside a page of an input's records: the cursor the
 * input handed out for the page's start, how many of its records were
 * handled, and how many of the next record's entries (the record's own item,
 * then its children) were. A page that is stored whole keeps the input's own
 * cursor; only a page cut by the item budget carries this one.
 */
const RESUME_PREFIX = '~in1~';
const RESUME_PATTERN = /^~in1~(\d+)~(\d+)~([\s\S]*)$/u;

interface ResumePoint {
  /** The input's own cursor for the start of the page the listing stopped in; absent: the input's start. */
  inner: string | undefined;
  records: number;
  entries: number;
}

function encodeResume(point: ResumePoint): string {
  return `${RESUME_PREFIX}${point.records}~${point.entries}~${point.inner ?? ''}`;
}

function decodeResume(cursor: string | undefined): ResumePoint {
  if (cursor === undefined) return { inner: undefined, records: 0, entries: 0 };
  const found = RESUME_PATTERN.exec(cursor);
  // A cursor the input handed out (or one this module cannot read) is the input's own.
  if (!found) return { inner: cursor, records: 0, entries: 0 };
  return { inner: found[3] ? found[3] : undefined, records: Number(found[1]), entries: Number(found[2]) };
}

/** One item of a page, with where in the page it came from. */
interface PageUnit {
  /** Records of the input's stream since its last page cursor, up to and including this unit's record. */
  record: number;
  entry: number;
  /** The record's own item: the parent a child belongs to. */
  parent: string;
  item: RawItem;
}

/**
 * The connector of one input of a source: its id is the input's, its listing
 * reads the input's records, and it applies the intake rule and builds items
 * with the source's own builder. A source's `forInput` returns this.
 *
 * The listing's `limit` bounds the ITEMS it yields, not the records it reads:
 * a record is its own item and its children, so a page of records can hold
 * more items than the budget. A page that does not fit is cut there and
 * yielded `truncated`, with a cursor that resumes inside it (at a record and an
 * entry of it); the part not yielded is decided and built again on the next
 * pass. A page is `done` only when every item of it was yielded.
 */
export function inputConnector<R>(builder: SourceRecordBuilder<R>, input: IntakeObservingInput<R>): SourceConnector {
  const connector: SourceConnector = {
    id: input.inputId,
    family: builder.family,
    authenticate: () => builder.authenticate?.() ?? Promise.resolve(),
    fetchItem: (localItemId, options) => builder.fetchItem(localItemId, options),
    classificationSignals: (item) => builder.classificationSignals(item),
    listItems(options: SourceConnectorListOptions = {}): AsyncIterable<SourceConnectorListPage> {
      const lookup = options.storedItem;
      const budget = options.limit;
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        // What this pass applied so far: it is stored only once the pass was listed, so the store
        // cannot say what an earlier record of the same pass did.
        const thisPass = new Map<string, StoredItemState>();
        const stateOf = (identity: SourceItemIdentity): StoredItemState | undefined =>
          thisPass.get(identity.localItemId) ?? lookup?.(identity, builder.compareVersions);
        const resume = decodeResume(options.cursor);
        // The input's stream is read from `base`; `offset` records of it came before the page being read.
        let base = resume.inner;
        let offset = 0;
        let recordsToSkip = resume.records;
        let entriesToSkip = resume.entries;
        let yielded = 0;
        const pages: AsyncIterable<SourceRecordPage<R>> = input.records({
          ...(base !== undefined ? { cursor: base } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
        for await (const page of pages) {
          let units: PageUnit[] = [];
          const outcomes: SourceIntakeOutcome[] = [];
          /** Where in `outcomes` each record's own item is told, by record. */
          const outcomeOf = new Map<number, number>();
          for (const [position, record] of page.records.entries()) {
            const skipped = (): void => { outcomes.push({ localItemId: '', decision: 'skip_same', alreadyThere: false }); };
            // Records an earlier pass handled before it was cut: they were counted then.
            if (recordsToSkip > 0) {
              recordsToSkip -= 1;
              skipped();
              continue;
            }
            const entries = builder.entriesOf(record);
            // The record's own item and the first of its children an earlier pass handled are not decided again.
            const from = Math.min(entriesToSkip, entries.length);
            entriesToSkip = 0;
            if (entries.length === 0) {
              skipped();
              continue;
            }
            const wanted = new Set<string>();
            entries.forEach((entry, index) => {
              if (index < from) return;
              const stored = stateOf(entry.identity);
              const decision = decideIntake({
                input: input.kind,
                version: entry.identity.sourceVersion,
                bringsContent: entry.bringsContent,
                ...(entry.deletes === true ? { deletes: true } : {}),
                stored,
                compareVersions: builder.compareVersions,
              });
              if (decision === 'apply') wanted.add(entry.identity.localItemId);
              if (index === 0) {
                outcomeOf.set(offset + position, outcomes.length);
                outcomes.push({
                  localItemId: entry.identity.localItemId,
                  decision,
                  alreadyThere: stored !== undefined && stored.tombstoned !== true,
                  ...(entry.authoredAt !== undefined ? { authoredAt: entry.authoredAt } : {}),
                });
              }
            });
            if (from > 0) skipped();
            if (wanted.size === 0) continue;
            const built = new Map<string, RawItem>();
            for (const item of await builder.build(record, wanted)) {
              if (wanted.has(item.identity.localItemId)) built.set(item.identity.localItemId, item);
            }
            // In the record's own order: its item, then its children.
            entries.forEach((entry, index) => {
              const built1 = built.get(entry.identity.localItemId);
              if (!built1 || index < from) return;
              // A record that carries no version was accepted as the version the store holds: it keeps that
              // version, in the pass's own state and in the item it emits, so it can never erase the boundary.
              const known = stateOf(built1.identity)?.version;
              const owedBody = stateOf(built1.identity);
              // A record older than the item that carries the body still owed to it is that body at the item's version.
              const owedOlder = owedBody?.incomplete === true && owedBody.version !== undefined && built1.identity.sourceVersion !== undefined
                && builder.compareVersions(built1.identity.sourceVersion, owedBody.version) < 0 && hasContent(built1);
              const item = owedOlder
                ? { ...built1, identity: { ...built1.identity, sourceVersion: owedBody!.version! }, metadata: { ...built1.metadata, contentVersion: built1.identity.sourceVersion } }
                : built1.identity.sourceVersion === undefined && known !== undefined
                  ? { ...built1, identity: { ...built1.identity, sourceVersion: known } }
                  : built1;
              const deleted = item.metadata['deleted'] === true;
              // Names alone take no content away: what the item held before this record is still there.
              const before = stateOf(item.identity);
              thisPass.set(item.identity.localItemId, {
                ...(item.identity.sourceVersion !== undefined ? { version: item.identity.sourceVersion } : {}),
                // (A record whose body is empty replaces the body with nothing: it is content that holds none.)
                hasContent: hasContent(item) ? !(item.content.kind === 'text' && item.content.text.trim() === '') : !deleted && before?.hasContent === true && before.tombstoned !== true,
                // Names alone do not bring a deleted item or a Secret back: it stays one, at the newer version.
                ...(deleted || (before?.tombstoned === true && (!hasContent(item) || (item.content.kind === 'text' && item.content.text.trim() === ''))) ? { tombstoned: true as const } : {}),
                // A write still owed stays owed for the records after this one: at this very version, and through a
                // names-only record of any version (it neither brings the body nor resolves the debt), until a record
                // brings content or deletes the item.
                ...(before?.incomplete === true && (before.version === item.identity.sourceVersion || (!hasContent(item) && !deleted)) ? { incomplete: true as const } : {}),
                ...(before?.incomplete === true && before.owedBodyVersion !== undefined && !hasContent(item) && !deleted ? { owedBodyVersion: before.owedBodyVersion } : {}),
              });
              units.push({ record: offset + position, entry: index, parent: entries[0]!.identity.localItemId, item });
            });
          }
          // Each item of a page is reduced, on its own, to its newest accepted record: parents and children
          // alike, so two versions of one item never share a batch, a plan or a removal. Same version: a
          // deletion beats a content record, otherwise the later record wins. A child stays if it is the
          // newest record of its own identity, whichever record it first came with.
          const winner = new Map<string, number>();
          const isDeleted = (unit: PageUnit): boolean => unit.item.metadata['deleted'] === true;
          units.forEach((unit, at) => {
            const id = unit.item.identity.localItemId;
            const best = winner.get(id);
            if (best === undefined) { winner.set(id, at); return; }
            const held = units[best]!;
            const a = unit.item.identity.sourceVersion;
            const b = held.item.identity.sourceVersion;
            const order = a === undefined || b === undefined ? 0 : builder.compareVersions(a, b);
            if (order > 0 || (order === 0 && !(isDeleted(held) && !isDeleted(unit)))) winner.set(id, at);
          });
          if (winner.size !== units.length) {
            // A newer record that only has the names does not drop the content an older record of this page
            // brought: the item is the newer version with that content, as it would be one page after the other.
            for (const [id, at] of winner) {
              const won = units[at]!;
              if (isDeleted(won) || hasContent(won.item)) continue;
              // Only content from after the item's last deletion in this page: nothing of a deleted state comes back.
              let older: PageUnit | undefined;
              let deletion: PageUnit | undefined;
              units.forEach((unit, from) => {
                if (unit.item.identity.localItemId !== id || from >= at) return;
                if (isDeleted(unit)) { older = undefined; deletion = unit; }
                else if (hasContent(unit.item)) { older = unit; deletion = undefined; }
              });
              // The merged item resumes from the record that brought its content: a pass cut before it reads that
              // record again, so the content is never lost to the cut.
              if (older) units[at] = { record: older.record, entry: older.entry, parent: older.parent, item: { ...won.item, content: older.item.content, metadata: { ...won.item.metadata, ...(older.item.metadata['contentVersion'] !== undefined ? { contentVersion: older.item.metadata['contentVersion'] } : older.item.identity.sourceVersion !== undefined && older.item.identity.sourceVersion !== won.item.identity.sourceVersion ? { contentVersion: older.item.identity.sourceVersion } : {}) } } };
              // Names alone never revive a deleted item: after a deletion in this page it stays a deletion, at the newer version.
              else if (deletion) units[at] = { record: deletion.record, entry: deletion.entry, parent: deletion.parent, item: { ...deletion.item, identity: { ...deletion.item.identity, ...(won.item.identity.sourceVersion !== undefined ? { sourceVersion: won.item.identity.sourceVersion } : {}) } } };
            }
            const kept = new Set(winner.values());
            for (const [at, unit] of units.entries()) {
              if (unit.entry !== 0 || kept.has(at)) continue;
              const told = outcomeOf.get(unit.record);
              if (told !== undefined) outcomes[told] = { ...outcomes[told]!, decision: 'skip_older' };
            }
            units = units.filter((_, at) => kept.has(at));
          }
          // An item is emitted before its children, whatever records they came from: a pass cut between them
          // must never leave a child stored ahead of the parent that decides whether it stays.
          const ordered: PageUnit[] = [];
          const held = new Map<string, PageUnit[]>();
          units.forEach((unit, at) => {
            const parentLater = unit.entry !== 0 && units.some((other, later) => later > at && other.entry === 0 && other.item.identity.localItemId === unit.parent);
            if (parentLater) {
              held.set(unit.parent, [...(held.get(unit.parent) ?? []), unit]);
              return;
            }
            ordered.push(unit);
            if (unit.entry === 0) ordered.push(...(held.get(unit.item.identity.localItemId) ?? []));
          });
          units = ordered;
          input.observeIntake?.(outcomes);
          const room = budget === undefined ? Number.POSITIVE_INFINITY : budget - yielded;
          if (units.length > room) {
            // The page holds more than the pass may store: yield what fits, resume at the first unit that does not.
            if (room <= 0) return;
            // Resume at the earliest record and entry among the units not yielded: the emit order is not the stream's.
            const next = units.slice(room).reduce((first, unit) => (unit.record < first.record || (unit.record === first.record && unit.entry < first.entry) ? unit : first));
            yield {
              items: units.slice(0, room).map((unit) => unit.item),
              nextCursor: encodeResume({ inner: base, records: next.record, entries: next.entry }),
              done: false,
              truncated: true,
            };
            return;
          }
          const items = units.map((unit) => unit.item);
          yielded += items.length;
          if (page.nextCursor !== undefined) {
            base = page.nextCursor;
            offset = 0;
          } else {
            offset += page.records.length;
          }
          yield page.truncated === true
            ? { items, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}), done: false, truncated: true }
            : { items, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}), done: page.done };
        }
      })();
    },
  };
  return connector;
}
