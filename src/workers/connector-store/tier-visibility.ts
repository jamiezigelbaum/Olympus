// The cross-store half of the tier-ledger visibility filter (design
// docs/design/per-item-four-tier-classification.md, section 3.3).
//
// Each store already drops hits whose copy is not current (the per-store
// filter in local-index.ts). That alone cannot promise "never searchable in
// two tiers at once": a fan-out reads each store at a different moment, so a
// move that flips between two reads could leave the source copy in one
// store's results and the destination copy in the other's. This gate judges
// every hit of one query against ONE read of each set ledger, after the
// fan-out. A flip is one ledger write, so one snapshot sees exactly one side.
//
// Legacy items (never routed, no copy rows) pass unchanged. A ROUTED item
// with no copy rows left (a Secret whose copies were settled while a search
// held one of its hits) is hidden, never mistaken for legacy. A set whose
// ledger cannot be read fails closed for its own stores only.
//
// A child item (docs/design/child-items.md, "Removal") is judged by its
// parent as well, by the same rule every store applies where it reads
// (child-visibility.ts): a scope that carries its stores hides a hit whose
// parent is not served and marks a release input `gone`, at the moment the
// ledger snapshot is taken, so a parent deleted while a search fanned out or
// an answer was written is not cited.

import type { ReleaseCheck, ReleaseInputVerdict } from '../../core/release-manifest.ts';
import { releaseChunks, type ChunkReleaseOptions } from '../classification/chunk-release.ts';
import type { LocalConnectorStore } from './local-index.ts';
import type { SourceIndexRoutedSearchHit, SourceIndexVisibilityGate, SourceIndexVisibilityGateReport } from '../../core/source-index/router.ts';
import { contentHeldForJudgment } from '../classification/tier-classifier.ts';
import { tierLedgerIdentityKey, type TierLedger, type TierLedgerIdentity, type TierVisibilityReads } from '../classification/tier-ledger.ts';
import {
  hiddenChildKeysSteps, itemVerdictsSteps, childVisibilityUnchanged,
  ledgerVisibilityHere, ledgerVisibilityOffThread, itemStatesOffThread, memoVisibilityItemsHere,
  visibilityRead, visibilityHere, visibilityOffThread, judgedAwaited, VisibilityChangedError,
  type VisibilityRead, type ChildVisibilityStore,
} from './child-visibility.ts';

export interface TierVisibilityScope {
  ledger: TierLedger;
  /** The corpora whose copies this ledger governs (one tiered store set). */
  corpusIds: ReadonlySet<string>;
  /**
   * The stores of this set that exist now, read per call, for judging a child
   * item by its parent. A scope without them cannot tell a child from any
   * other item and applies the copy rules alone; a composition root passes
   * them for every scope it builds.
   */
  stores?: () => readonly (ChildVisibilityStore & Partial<Pick<LocalConnectorStore, 'releaseItemChunks'>>)[];
}

function childLane(scope: TierVisibilityScope): { ledger: () => TierLedger; stores: () => readonly ChildVisibilityStore[] } | undefined {
  const stores = scope.stores;
  return stores ? { ledger: () => scope.ledger, stores } : undefined;
}

/**
 * `onHeldMatches` hears, best match first, the items among one query's hits
 * that are held waiting for their privacy judgment (a copy kept from
 * embedding), so the judge can ask about them next (judge-boost.ts, #1062).
 * Order only: the gate hides and keeps exactly the same hits either way.
 */
export function createTierVisibilityGate(
  scopes: () => readonly TierVisibilityScope[],
  onHeldMatches?: (identities: readonly TierLedgerIdentity[]) => void,
): SourceIndexVisibilityGate {
  const readOptions = { personalFirst: onHeldMatches !== undefined };
  const governedBy = (scope: TierVisibilityScope, hits: readonly SourceIndexRoutedSearchHit[]) =>
    hits.filter((hit) => scope.corpusIds.has(hit.corpusId));
  // The corpora of a set whose ledger could not be read: their hits fail
  // closed, and the caller is told which, once the judgment stands (#1460).
  const unreadCorpora = (governed: readonly SourceIndexRoutedSearchHit[], unread: Set<string>) => {
    for (const hit of governed) unread.add(hit.corpusId);
  };
  const reportUnread = (unread: ReadonlySet<string>, report: SourceIndexVisibilityGateReport | undefined) => {
    if (unread.size > 0) report?.onUnchecked?.([...unread].sort());
  };
  const gate: SourceIndexVisibilityGate = (hits, report) => {
    const current = scopes();
    if (current.length === 0 || hits.length === 0) return hits;
    const reads = new Map<TierVisibilityScope, TierVisibilityReads | undefined>();
    const unread = new Set<string>();
    for (const scope of current) {
      const governed = governedBy(scope, hits);
      if (governed.length === 0) continue;
      try {
        reads.set(scope, ledgerVisibilityHere(scope.ledger, governed.map((hit) => hit.sourceItem), readOptions));
      } catch {
        reads.set(scope, undefined);
        unreadCorpora(governed, unread);
      }
    }
    const visible = visibilityHere(judgeVisibility(current, hits, reads, onHeldMatches));
    reportUnread(unread, report);
    return visible;
  };
  // The same judgment with each ledger read in one snapshot on the read pool,
  // for the search's own fan-out, which can wait for it (#1305).
  gate.offThread = async (hits, report) => {
    if (scopes().length === 0 || hits.length === 0) return hits;
    // A write during the pooled judgment takes it again, then judges here once.
    return judgedAwaited(() => judgedOffThread(hits, report), () => gate(hits, report));
  };
  const judgedOffThread = async (
    hits: readonly SourceIndexRoutedSearchHit[],
    report: SourceIndexVisibilityGateReport | undefined,
  ): Promise<readonly SourceIndexRoutedSearchHit[]> => {
    const unread = new Set<string>();
    const current = scopes();
    const reads = new Map<TierVisibilityScope, TierVisibilityReads | undefined>();
    const unchanged = new Map<TierVisibilityScope, () => boolean>();
    let changedDuringRead = false;
    for (const scope of current) {
      if (governedBy(scope, hits).length === 0) continue;
      try { unchanged.set(scope, childVisibilityUnchanged({ ledger: () => scope.ledger, stores: scope.stores ?? (() => []) })); }
      catch { unchanged.set(scope, () => false); }
    }
    await Promise.all(current.map(async (scope) => {
      const governed = governedBy(scope, hits);
      if (governed.length === 0) return;
      try {
        reads.set(scope, await ledgerVisibilityReads(scope.ledger, governed.map((hit) => hit.sourceItem), readOptions));
      } catch (error) {
        if (error instanceof VisibilityChangedError) changedDuringRead = true;
        else unreadCorpora(governed, unread);
        reads.set(scope, undefined);
      }
    }));
    const visible = await visibilityOffThread(judgeVisibility(current, hits, reads, onHeldMatches));
    const changed = changedDuringRead || current.some(scope => {
      try { return unchanged.has(scope) && !unchanged.get(scope)!(); }
      catch { return true; }
    });
    if (changed) throw new VisibilityChangedError();
    reportUnread(unread, report);
    return visible;
  };
  return gate;
}

/**
 * The ledger's visibility reads in one snapshot on the read pool where it
 * can be: on a large install's copy one of these batches held the request
 * thread for 1.3 s (#1305). A busy pool withholds this scope's hits; reading
 * here instead would put that freeze back on the Ask thread.
 */
async function ledgerVisibilityReads(
  ledger: TierLedger,
  identities: readonly TierLedgerIdentity[],
  options: { personalFirst: boolean },
): Promise<TierVisibilityReads> {
  return ledgerVisibilityOffThread(ledger, identities, options);
}

function* judgeVisibility(
  current: readonly TierVisibilityScope[],
  hits: readonly SourceIndexRoutedSearchHit[],
  reads: ReadonlyMap<TierVisibilityScope, TierVisibilityReads | undefined>,
  onHeldMatches: ((identities: readonly TierLedgerIdentity[]) => void) | undefined,
): Generator<VisibilityRead, readonly SourceIndexRoutedSearchHit[], unknown> {
  const hidden = new Set<SourceIndexRoutedSearchHit>();
  const held = new Set<SourceIndexRoutedSearchHit>();
  for (const scope of current) {
    if (!reads.has(scope)) continue;
    const governed = hits.filter((hit) => scope.corpusIds.has(hit.corpusId));
    const read = reads.get(scope);
    if (!read) {
      // A set whose ledger cannot be read fails closed for its own stores only.
      for (const hit of governed) hidden.add(hit);
      continue;
    }
    const { copies, routedWithoutCopies } = read;
    for (const hit of governed) {
      if (!hit.sourceItem.accountScope || !hit.sourceItem.provider || !hit.sourceItem.providerItemId) {
        hidden.add(hit);
        continue;
      }
      const key = tierLedgerIdentityKey(hit.sourceItem);
      const itemCopies = copies.get(key);
      if (itemCopies?.some((copy) => copy.state === 'current' && copy.embedHold)) held.add(hit);
      if (!itemCopies || itemCopies.length === 0) {
        if (routedWithoutCopies.has(key)) hidden.add(hit);
        continue;
      }
      const currentHere = itemCopies.some((copy) => copy.corpusId === hit.corpusId && copy.state === 'current'
        && (!hit.servingLayer || copy.layers === 'both' || copy.layers === hit.servingLayer));
      if (!currentHere) hidden.add(hit);
    }
    // A row recorded Personal-first before #1316 waits for its verdict with its
    // text still in Personal (no held copy): it is withheld from answers all the
    // same (createReleaseTierCheck), so it is raised for the judge like any held match.
    for (const hit of governed) {
      if (!hidden.has(hit) && read.personalFirstWaiting.has(tierLedgerIdentityKey(hit.sourceItem))) held.add(hit);
    }
    // A child is served only while its parent is.
    const lane = childLane(scope);
    if (lane) {
      const orphaned = yield* hiddenChildKeysSteps(lane, governed.filter((hit) => !hidden.has(hit)).map((hit) => hit.sourceItem));
      if (orphaned.size > 0) {
        for (const hit of governed) if (orphaned.has(tierLedgerIdentityKey(hit.sourceItem))) hidden.add(hit);
      }
    }
  }
  if (onHeldMatches && held.size > 0) {
    try {
      onHeldMatches(interleaveByCorpus(hits.filter((hit) => held.has(hit))).map((hit) => hit.sourceItem));
    } catch {
      // Ordering the judge is best effort; the search is not affected.
    }
  }
  return hidden.size === 0 ? hits : hits.filter((hit) => !hidden.has(hit));
}

/**
 * Held matches taken in turn from each corpus, each corpus's own rank kept.
 * The router calls the gate with its hits grouped by corpus, before they are
 * fused across corpora, so in that order one corpus with many held matches
 * would fill the judge's per-question allowance and a repeat ask would
 * never reach the others.
 */
function interleaveByCorpus(hits: readonly SourceIndexRoutedSearchHit[]): SourceIndexRoutedSearchHit[] {
  const byCorpus = new Map<string, SourceIndexRoutedSearchHit[]>();
  for (const hit of hits) {
    const lane = byCorpus.get(hit.corpusId);
    if (lane) lane.push(hit);
    else byCorpus.set(hit.corpusId, [hit]);
  }
  const lanes = [...byCorpus.values()];
  const ordered: SourceIndexRoutedSearchHit[] = [];
  for (let rank = 0; ordered.length < hits.length; rank += 1) {
    for (const lane of lanes) if (rank < lane.length) ordered.push(lane[rank]!);
  }
  return ordered;
}

/**
 * The current tiers of the items an answer was written from (its release
 * manifest, core/release-manifest.ts), read when a remote agent collects the
 * answer: a delayed answer may have been written before an item it read was
 * reclassified.
 *
 * Each input is read by its exact identity, account included, from the ledger
 * that governs its corpus: one batched read per ledger, so every input is
 * judged against one snapshot. A row at Secrets (or moving there) is
 * `secret`; at Private (or moving there), or held Private while its model
 * question waits (`contentHeldForJudgment`), `private`; anything else classified
 * is `public_or_personal`; a routed item with no current copy left is also
 * `gone`. An item
 * no ledger governs, or one its ledger never classified (ledger rows are never
 * deleted, so no row means never classified), is `legacy`: its tier is still
 * its corpus's. An input in a governed corpus without an account cannot be
 * read and is `unknown`. A ledger that cannot be read throws; the caller
 * withholds.
 */
export function createReleaseTierCheck(
  scopes: () => readonly TierVisibilityScope[],
  secureDerivativeDefault: () => 'allow' | 'approval',
  chunkOptions: Pick<ChunkReleaseOptions, 'judgeNow' | 'boost'> = {},
): ReleaseCheck {
  function* inputsSteps(inputs: Parameters<ReleaseCheck['inputs']>[0]): Generator<VisibilityRead, ReleaseInputVerdict[], unknown> {
    const verdicts: ReleaseInputVerdict[] = inputs.map(() => ({ tier: 'legacy', gone: false }));
    if (inputs.length === 0) return verdicts;
    for (const scope of scopes()) {
      const governed: Array<{ index: number; identity: TierLedgerIdentity }> = [];
      inputs.forEach((input, index) => {
        if (!scope.corpusIds.has(input.corpusId)) return;
        if (!input.accountScope || !input.provider || !input.providerItemId) {
          verdicts[index] = { tier: 'unknown', gone: false };
          return;
        }
        governed.push({
          index,
          identity: {
            provider: input.provider,
            accountScope: input.accountScope,
            providerItemId: input.providerItemId,
            ...(input.providerConversationId ? { providerConversationId: input.providerConversationId } : {}),
          },
        });
      });
      if (governed.length === 0) continue;
      // The same ledger snapshot now runs on the pool for Ask release. Deduplicate
      // identities there so repeated citations do not reread the same rows.
      const identities = governed.map(({ identity }) => identity);
      const states = yield* visibilityRead(() => memoVisibilityItemsHere(scope.ledger, 'states', () => scope.ledger.changeMarker(), identities, tierLedgerIdentityKey, missing => scope.ledger.itemStatesForMany(missing)),
        () => itemStatesOffThread(scope.ledger, identities));
      for (const { index, identity } of governed) {
        const state = states.get(tierLedgerIdentityKey(identity));
        if (!state) continue;
        const { record, copies, override } = state;
        // An input of the names layer (a child citation's parent label) is
        // judged on the item's names alone: its content tier never limits an
        // answer that carries only its names.
        const namesOnly = inputs[index]!.layer === 'names';
        const tiers = namesOnly
          ? [record.metadataTier, record.targetMetadataTier]
          : [record.metadataTier, record.contentTier, record.targetMetadataTier, record.targetContentTier];
        // Owner edits take effect before their queued placement settles.
        if (override?.kind === 'tier') tiers.push(override.tier);
        // What waits for its model question is held Private, as placement
        // holds it, though its recorded tier is the Personal default: an
        // answer read from it is Private until the model says otherwise.
        const held = record.metadataPending || (!namesOnly && contentHeldForJudgment(record));
        verdicts[index] = {
          tier: tiers.includes('secrets') ? 'secret' : held || tiers.includes('secure') ? 'private' : 'public_or_personal',
          gone: record.routed && !copies.some((copy) => copy.state === 'current'
            && (!namesOnly || copy.layers === 'both' || copy.layers === 'metadata')),
        };
      }
      // A child whose parent is not served any more is gone, whatever its own
      // copies say, and the answer that drew on it is withheld whole.
      const lane = childLane(scope);
      if (lane) {
        const orphaned = yield* hiddenChildKeysSteps(lane, governed.filter(({ index }) => inputs[index]!.dependency !== 'parent_label').map(({ identity }) => identity));
        for (const { index, identity } of governed) {
          if (inputs[index]!.dependency !== 'parent_label' && orphaned.has(tierLedgerIdentityKey(identity))) {
            verdicts[index] = { ...verdicts[index]!, gone: true, hiddenByParent: true };
          }
        }
        // The parent label's names are the parent's own, so they are judged the way the parent's
        // children are, by what its rows say now and not by its ledger copies alone: a parent
        // tombstoned by an absence reconcile keeps its copy rows until the sync that did it ends.
        const named = governed.filter(({ index }) => inputs[index]!.dependency === 'parent_label');
        if (named.length > 0) {
          const standing = yield* itemVerdictsSteps(lane, named.map(({ identity }) => identity));
          for (const { index, identity } of named) {
            if (standing.get(tierLedgerIdentityKey(identity))?.visible !== true) verdicts[index] = { ...verdicts[index]!, gone: true };
          }
        }
      }
    }
    return verdicts;
  }
  const check: ReleaseCheck = {
    secureDerivativeDefault,
    chunks: (inputs, options) => releaseChunks(inputs, scopes, check, { ...chunkOptions, ...options }),
    inputs: (inputs) => visibilityHere(inputsSteps(inputs)),
    // A write during the pooled check takes it again, then checks here once.
    inputsOffThread: (inputs) => judgedAwaited(async () => {
      const unchanged = scopes().map(scope => childVisibilityUnchanged({ ledger: () => scope.ledger, stores: scope.stores ?? (() => []) }));
      const verdicts = await visibilityOffThread(inputsSteps(inputs));
      if (unchanged.some(check => !check())) throw new VisibilityChangedError();
      return verdicts;
    }, () => visibilityHere(inputsSteps(inputs))),
  };
  return check;
}

/**
 * Register a store that no lane governs yet (a configured mount such as
 * Reflect or Roam) with the ledger that governs it, so the gate and every
 * release check read its items' tiers instead of treating them as legacy. A
 * store with no ledger yet holds only legacy items and waits; a lane already
 * on that ledger takes the corpus; a bound ledger that cannot be opened is
 * left for the next call (the store's own reads fail closed meanwhile).
 */
export function registerGovernedStore<L extends { ledger: TierLedger; corpusIds: Set<string> }>(
  lanes: L[],
  store: { corpusId: string; governingTierLedger(): TierLedger | undefined },
  newLane: (ledger: TierLedger) => L,
  log: (line: string) => void = () => {},
): 'registered' | 'joined' | 'already' | 'no_ledger' | 'unavailable' {
  if (lanes.some((lane) => lane.corpusIds.has(store.corpusId))) return 'already';
  let ledger: TierLedger | undefined;
  try { ledger = store.governingTierLedger(); }
  catch (error) {
    log(`[tier] ${store.corpusId}: its tier ledger is unavailable; registered when it is readable (${error instanceof Error ? error.name : 'error'})`);
    return 'unavailable';
  }
  if (!ledger) return 'no_ledger';
  const sharing = lanes.find((lane) => lane.ledger.dbPath === ledger!.dbPath);
  if (sharing) { sharing.corpusIds.add(store.corpusId); return 'joined'; }
  lanes.push(newLane(ledger));
  return 'registered';
}

/**
 * Stores waiting for their governing ledger (registerGovernedStore answered
 * `no_ledger` or `unavailable`), kept apart from mount discovery: discovery
 * reports a store once, while its ledger can appear any time after. `retry`
 * tries each again and keeps only those still waiting; it is cheap (a file
 * check per store), so the scopes call it before every read.
 */
export function createPendingGovernance<L extends { ledger: TierLedger; corpusIds: Set<string> }>(
  lanes: L[],
  newLane: (store: { corpusId: string }, ledger: TierLedger) => L,
  log: (line: string) => void = () => {},
) {
  const waiting = new Map<string, { corpusId: string; governingTierLedger(): TierLedger | undefined }>();
  const attempt = (store: { corpusId: string; governingTierLedger(): TierLedger | undefined }): void => {
    const outcome = registerGovernedStore(lanes, store, (ledger) => newLane(store, ledger), log);
    if (outcome === 'no_ledger' || outcome === 'unavailable') waiting.set(store.corpusId, store);
    else waiting.delete(store.corpusId);
  };
  return {
    add: attempt,
    retry(): void {
      for (const store of [...waiting.values()]) attempt(store);
    },
    waiting: (): string[] => [...waiting.keys()],
  };
}
