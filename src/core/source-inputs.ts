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
 * - Newer than the stored version: it applies, whichever input it came from.
 * - Older: it never applies, so a queued live record cannot undo a later edit
 *   an archive holds.
 * - The same version: it applies only when it brings content the stored item
 *   lacks; and on a tie (both hold content) live's record is the one kept, so
 *   a live record applies and an archive record does not. A live record that
 *   is identical to the stored item is a no-op in the store.
 */
export function decideIntake(args: {
  input: SourceInputKind;
  version: string | undefined;
  bringsContent: boolean;
  stored: StoredItemState | undefined;
  compareVersions: (a: string, b: string) => number;
}): IntakeDecision {
  const { stored } = args;
  if (!stored) return 'apply';
  // A stored item with no version to compare (an old row, or one cut off between legs) is completed by the next record.
  if (stored.version === undefined) return 'apply';
  // A record that carries no version is taken as the stored one's.
  const order = args.version === undefined ? 0 : args.compareVersions(args.version, stored.version);
  if (order > 0) return 'apply';
  if (order < 0) return 'skip_older';
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
}

/**
 * An input that wants to see its pages' outcomes (an archive input counts what
 * it read, and how much of it was already there): told once per page of
 * records, in the page's order, before the page's items go out.
 */
export interface IntakeObservingInput<R = unknown> extends SourceConnectorInput<R> {
  observeIntake?(outcomes: readonly SourceIntakeOutcome[]): void;
  /** Applied to each item the input's records yield, last (an archive input marks its items held). */
  decorate?(item: RawItem): RawItem;
}

const hasContent = (item: RawItem): boolean => item.content.kind !== 'metadata_only';

/**
 * The connector of one input of a source: its id is the input's, its listing
 * reads the input's records, and it applies the intake rule and builds items
 * with the source's own builder. A source's `forInput` returns this.
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
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        // What this pass applied so far: it is stored only once the pass was listed, so the store
        // cannot say what an earlier record of the same pass did.
        const thisPass = new Map<string, StoredItemState>();
        const stateOf = (identity: SourceItemIdentity): StoredItemState | undefined =>
          thisPass.get(identity.localItemId) ?? lookup?.(identity);
        const pages: AsyncIterable<SourceRecordPage<R>> = input.records({
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
        for await (const page of pages) {
          const items: RawItem[] = [];
          const outcomes: SourceIntakeOutcome[] = [];
          for (const record of page.records) {
            const entries = builder.entriesOf(record);
            if (entries.length === 0) {
              outcomes.push({ localItemId: '', decision: 'skip_same', alreadyThere: false });
              continue;
            }
            const wanted = new Set<string>();
            entries.forEach((entry, index) => {
              const stored = stateOf(entry.identity);
              const decision = decideIntake({
                input: input.kind,
                version: entry.identity.sourceVersion,
                bringsContent: entry.bringsContent,
                stored,
                compareVersions: builder.compareVersions,
              });
              if (decision === 'apply') wanted.add(entry.identity.localItemId);
              if (index === 0) outcomes.push({ localItemId: entry.identity.localItemId, decision, alreadyThere: stored !== undefined });
            });
            if (wanted.size === 0) continue;
            for (const item of await builder.build(record, wanted)) {
              if (!wanted.has(item.identity.localItemId)) continue;
              thisPass.set(item.identity.localItemId, {
                ...(item.identity.sourceVersion !== undefined ? { version: item.identity.sourceVersion } : {}),
                hasContent: hasContent(item),
              });
              items.push(input.decorate ? input.decorate(item) : item);
            }
          }
          input.observeIntake?.(outcomes);
          yield page.truncated === true
            ? { items, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}), done: false, truncated: true }
            : { items, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}), done: page.done };
        }
      })();
    },
  };
  return connector;
}
