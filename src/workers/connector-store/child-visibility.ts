// Whether an item that came inside another (a child) may be seen at all
// (docs/design/child-items.md, "Removal").
//
// One rule, decided where it is read and never copied anywhere: a child is
// visible only while its parent is. The parent's visibility is the rule that
// already decides any item's visibility, applied to the parent: a current
// ledger copy in a store whose row for it is present and not tombstoned (an
// item the ledger never routed has no copy to look for, and is visible while
// a store holds its row). It is looked for only in the child's own tier set,
// its ledger and the stores that ledger governs.
//
// Nothing is remembered between reads, so there is no state to lose in a
// crash and none to get out of step with the stores: a parent tombstoned in
// its store hides its children on the very next read, whatever else did or
// did not happen. Anything this module cannot establish hides the child (a
// ledger or a store that cannot be read, a parent no store knows, a chain of
// parents too deep): a child is shown only on positive evidence.
//
// A Secret parent is not a deletion (the owner's rule: each child is judged on
// its own), and neither is it a standing presence. Every Secret has one
// representation here: its store row, kept as a location only (a tombstoned row
// at tier S5, no names, no text), written when the item is first judged Secrets
// even if no store held it before. That row counts as present while the
// provider lists it, and nothing of the item is read for anything but that.
// Once the provider deletes it the row is retired to an ordinary tombstone
// (the store does it with the deletion, a feed's or an absence reconcile's,
// `retireSecretLocation`), and from then on a Secret is judged as any other
// deleted parent: its children go. A listing of it again restores the row
// (`reobserveSecretLocation`). Secret classification alone never cascades. A
// Secret is present for itself, but it is still a child when it came inside
// another item, so its own parent decides whether its children may be seen:
// the chain check goes on above it. The ledger's knowledge that an item is a
// Secret, with no row for it anywhere (a crash between the decision and the
// row), hides its children and removes nothing: it is not presence. The
// parent's names and content are never shown through this module.
//
// The sweep that removes the children of a parent that is gone (the tiered
// store set, `sweepOrphanedChildren`) asks a narrower question than the read
// does: `gone` is true only when NO store holds an active row for the parent
// and it is not a Secret, so a parent that is merely mid-move (hidden for a
// moment, its row still active) never costs its children their rows.
//
// Source-neutral: nothing here names a source or a format.

import { tierLedgerIdentityKey, type TierLedger, type TierLedgerIdentity } from '../classification/tier-ledger.ts';

/** The item a child came inside, as the child's row names it. */
export interface ParentRef {
  provider: string;
  accountScope: string;
  /** The parent's local id: what the child's row stores. */
  parentLocalItemId: string;
  /**
   * The parent's identity as the contract derives it from a child's
   * (`parentIdentityOf`), when the caller had a child to derive it from. It
   * is used for one question only: whether the ledger knows the parent as a
   * Secret that no store holds a row for (hidden, never gone).
   */
  identity?: TierLedgerIdentity;
}

/**
 * The separator between a parent's `providerItemId` and its child's key in the
 * child's own `providerItemId` (docs/design/child-items.md, "Contract").
 */
export const CHILD_ITEM_ID_SEPARATOR = '#child:';

/**
 * The parent's identity, from a child's: the contract gives a child the
 * family, provider, account and conversation of its parent, and a
 * `providerItemId` of `<parent providerItemId>#child:<key>`. Undefined for an
 * id that does not follow it.
 */
export function parentIdentityOf(child: ChildProbe): TierLedgerIdentity | undefined {
  const cut = child.providerItemId.lastIndexOf(CHILD_ITEM_ID_SEPARATOR);
  if (cut <= 0) return undefined;
  return {
    provider: child.provider,
    accountScope: child.accountScope,
    providerItemId: child.providerItemId.slice(0, cut),
    ...(child.providerConversationId ? { providerConversationId: child.providerConversationId } : {}),
  };
}

/** `{ identity }` for a parent ref built from this child, or nothing when its id does not follow the rule. */
export function parentIdentityField(child: ChildProbe): { identity?: TierLedgerIdentity } {
  const identity = parentIdentityOf(child);
  return identity ? { identity } : {};
}

/** What one store says of a parent, from its row alone and never its text. */
export interface ParentStandingRow extends ParentRef {
  identity: TierLedgerIdentity;
  /** The row is there and not tombstoned. */
  active: boolean;
  /** The row is a Secret's: tombstoned and kept as a location only. */
  secret: boolean;
  /** The row's own parent, when the parent is a child too. */
  grandparentLocalItemId?: string;
}

/** An item to ask about: the identity a store and the ledger know it by. */
export type ChildProbe = Pick<TierLedgerIdentity, 'provider' | 'accountScope' | 'providerItemId' | 'providerConversationId'>;

/** The part of a store this module reads (see `LocalConnectorStore`). */
export interface ChildVisibilityStore {
  readonly corpusId: string;
  parentLinksOf(identities: readonly ChildProbe[]): Map<string, ParentRef>;
  parentStandings(parents: readonly ParentRef[]): ParentStandingRow[];
  /**
   * The same standing, found by an item's identity rather than by the id its
   * children name, keyed by the asked identity's `tierLedgerIdentityKey`. An
   * item this store has no row for is absent.
   */
  itemStandings(identities: readonly ChildProbe[]): Map<string, ParentStandingRow>;
}

/**
 * The tier set a child belongs to: the ledger that governs its stores and the
 * stores that exist now. Both are asked afresh at every use, and either may
 * throw (a ledger that cannot be read, a store that cannot be opened): the
 * children concerned are then hidden.
 */
export interface ChildVisibilityLane {
  ledger(): TierLedger | undefined;
  stores(): readonly ChildVisibilityStore[];
}

/** How far up the chain of parents a child is followed (a parent can be a child too). */
export const CHILD_PARENT_CHAIN_LIMIT = 8;

export interface ParentVerdict {
  /** The parent may be seen, so its children may be. */
  visible: boolean;
  /** No store holds an active row for it and it is not a Secret: it is gone, not merely hidden. */
  gone: boolean;
}

export function parentKey(parent: ParentRef): string {
  return [parent.provider, parent.accountScope, parent.parentLocalItemId].join('\u0000');
}

const HIDDEN: ParentVerdict = { visible: false, gone: false };

/**
 * The verdict on each parent, by `parentKey`. Never throws: whatever cannot be
 * established is hidden and not gone (so nothing is removed on a guess).
 */
export function parentVerdicts(lane: ChildVisibilityLane, parents: readonly ParentRef[]): Map<string, ParentVerdict> {
  const unique = new Map<string, ParentRef>();
  for (const parent of parents) unique.set(parentKey(parent), parent);
  try {
    return judge(lane, [...unique.values()], 0);
  } catch {
    return new Map([...unique.keys()].map((key) => [key, HIDDEN]));
  }
}

function judge(lane: ChildVisibilityLane, parents: readonly ParentRef[], depth: number): Map<string, ParentVerdict> {
  const verdicts = new Map<string, ParentVerdict>();
  if (parents.length === 0) return verdicts;
  if (depth >= CHILD_PARENT_CHAIN_LIMIT) {
    for (const parent of parents) verdicts.set(parentKey(parent), HIDDEN);
    return verdicts;
  }

  const rows = new Map<string, Array<ParentStandingRow & { corpusId: string }>>();
  for (const store of lane.stores()) {
    for (const row of store.parentStandings(parents)) {
      const key = parentKey(row);
      const list = rows.get(key) ?? [];
      list.push({ ...row, corpusId: store.corpusId });
      rows.set(key, list);
    }
  }

  const ledger = lane.ledger();
  // One read of the ledger for every parent a store knows, so they are judged against one snapshot.
  const identities = new Map<string, TierLedgerIdentity>();
  for (const list of rows.values()) {
    for (const row of list) identities.set(tierLedgerIdentityKey(row.identity), row.identity);
  }
  const states = ledger && identities.size > 0 ? ledger.itemStatesForMany([...identities.values()]) : undefined;

  const climbing = new Map<string, ParentRef>();
  for (const parent of parents) {
    const key = parentKey(parent);
    const list = rows.get(key) ?? [];
    const identity = list[0]?.identity;
    const active = list.filter((row) => row.active);
    // A Secret's row is a location only: present for itself, though nothing of it may be read.
    // Its classification is not a deletion and does not cascade, but where it came inside
    // another item that item's standing still decides it, so the chain goes on above it.
    const locations = list.filter((row) => row.secret);
    if (locations.length > 0) {
      const above = locations.find((row) => row.grandparentLocalItemId !== undefined);
      if (above) climbing.set(key, { provider: parent.provider, accountScope: parent.accountScope, parentLocalItemId: above.grandparentLocalItemId! });
      verdicts.set(key, { visible: true, gone: false });
      continue;
    }
    if (!identity) {
      // No store holds a row for it, so it is gone, unless the ledger knows it as a Secret: a
      // Secret's row is written with the decision, so that is a crash between the two, or a
      // Secret from before rows were kept. It is not present (nothing says it is listed), and
      // it is not gone either (a classification alone is no deletion): hidden, nothing removed,
      // until its next listing writes the row.
      if (ledger && parent.identity && ledger.itemIsSecret(parent.identity)) {
        verdicts.set(key, HIDDEN);
      } else {
        verdicts.set(key, { visible: false, gone: true });
      }
      continue;
    }
    let visible: boolean;
    if (!ledger) {
      visible = active.length > 0;
    } else {
      const state = states?.get(tierLedgerIdentityKey(identity));
      const copies = state?.copies ?? [];
      visible = copies.length === 0
        // Never routed: the store that holds its row serves it. Routed with no copy left: nothing does.
        ? state?.record.routed !== true && active.length > 0
        : copies.some((copy) => copy.state === 'current' && active.some((row) => row.corpusId === copy.corpusId));
      // A Secret whose copies were settled but whose location row is not written yet (the row is
      // still active) is present, and its own parent still decides its children like any other
      // item's. Once every row is a tombstone and none is a location, the provider deleted it:
      // the ledger's record of what it was says nothing about whether it is there.
      if (!visible && active.length > 0 && ledger.itemIsSecret(identity)) visible = true;
    }
    if (visible) {
      const above = active.find((row) => row.grandparentLocalItemId !== undefined);
      if (above) climbing.set(key, { provider: parent.provider, accountScope: parent.accountScope, parentLocalItemId: above.grandparentLocalItemId! });
      verdicts.set(key, { visible: true, gone: false });
    } else {
      verdicts.set(key, { visible: false, gone: active.length === 0 });
    }
  }

  // A parent that is itself a child is visible only while its own parent is.
  if (climbing.size > 0) {
    const above = judge(lane, [...climbing.values()], depth + 1);
    for (const [key, grandparent] of climbing) {
      if (above.get(parentKey(grandparent))?.visible !== true) verdicts.set(key, HIDDEN);
    }
  }
  return verdicts;
}

/**
 * The keys (`parentKey`) of those of `parents` that are gone: no store of the
 * lane holds an active row for them and they are not a Secret. A parent that
 * is merely hidden (mid-move, routed with no copy yet) is not gone. Cheap on
 * the usual case, where every parent is plainly there: one read of the rows,
 * and only a parent no store serves goes on to the full judgment. Never
 * throws: what cannot be established is not gone.
 */
export function goneParents(lane: ChildVisibilityLane, parents: readonly ParentRef[]): Set<string> {
  const gone = new Set<string>();
  try {
    const unique = new Map<string, ParentRef>();
    for (const parent of parents) unique.set(parentKey(parent), parent);
    const present = new Set<string>();
    for (const store of lane.stores()) {
      for (const row of store.parentStandings([...unique.values()])) {
        if (row.active || row.secret) present.add(parentKey(row));
      }
    }
    const candidates = [...unique].filter(([key]) => !present.has(key)).map(([, parent]) => parent);
    if (candidates.length === 0) return gone;
    const verdicts = parentVerdicts(lane, candidates);
    for (const parent of candidates) {
      const key = parentKey(parent);
      if (verdicts.get(key)?.gone === true) gone.add(key);
    }
  } catch {
    // Nothing is removed on a guess.
  }
  return gone;
}

/**
 * The verdict on each item by its own identity (`tierLedgerIdentityKey`), the
 * same one a child's parent gets: an item no store holds a row for is judged
 * on the ledger alone, so it is gone unless the ledger knows it as a Secret
 * (then hidden, not gone).
 * Never throws: whatever cannot be established is hidden and not gone.
 */
export function itemVerdicts(lane: ChildVisibilityLane, items: readonly ChildProbe[]): Map<string, ParentVerdict> {
  const asked = new Map<string, ChildProbe>();
  for (const item of items) asked.set(tierLedgerIdentityKey(item), item);
  const out = new Map<string, ParentVerdict>();
  if (asked.size === 0) return out;
  try {
    const refs = new Map<string, ParentRef>();
    const refKeyOf = new Map<string, string>();
    for (const store of lane.stores()) {
      for (const [key, row] of store.itemStandings([...asked.values()])) {
        const ref: ParentRef = {
          provider: row.provider,
          accountScope: row.accountScope,
          parentLocalItemId: row.parentLocalItemId,
          identity: row.identity,
        };
        refs.set(parentKey(ref), ref);
        refKeyOf.set(key, parentKey(ref));
      }
    }
    for (const [key, item] of asked) {
      if (refKeyOf.has(key)) continue;
      // No store holds a row: a stand-in id no store can match, so the ledger alone is asked.
      const ref: ParentRef = {
        provider: item.provider,
        accountScope: item.accountScope,
        parentLocalItemId: `identity:${key}`,
        identity: {
          provider: item.provider,
          accountScope: item.accountScope,
          providerItemId: item.providerItemId,
          ...(item.providerConversationId ? { providerConversationId: item.providerConversationId } : {}),
        },
      };
      refs.set(parentKey(ref), ref);
      refKeyOf.set(key, parentKey(ref));
    }
    const verdicts = parentVerdicts(lane, [...refs.values()]);
    for (const [key, refKey] of refKeyOf) out.set(key, verdicts.get(refKey) ?? HIDDEN);
  } catch {
    for (const key of asked.keys()) out.set(key, HIDDEN);
  }
  return out;
}

/**
 * The keys (`tierLedgerIdentityKey`) of those of `probes` that are named as a
 * child by their own id (`<parent id>#child:<key>`) and whose parent may not
 * be seen. This reads no link from any row, so it covers a child no store
 * holds a row for (a Secret child, known to the Secret location index and the
 * ledger alone) as well as one a store holds. An item whose id is not a
 * child's is never in the result.
 */
export function hiddenByParentIdentity(lane: ChildVisibilityLane, probes: readonly ChildProbe[]): Set<string> {
  const hidden = new Set<string>();
  const named: Array<{ key: string; parent: TierLedgerIdentity }> = [];
  for (const probe of probes) {
    const parent = parentIdentityOf(probe);
    if (parent) named.push({ key: tierLedgerIdentityKey(probe), parent });
  }
  if (named.length === 0) return hidden;
  const verdicts = itemVerdicts(lane, named.map((child) => child.parent));
  for (const child of named) {
    if (verdicts.get(tierLedgerIdentityKey(child.parent))?.visible !== true) hidden.add(child.key);
  }
  return hidden;
}

/**
 * `hiddenByParentIdentity`, answered as the probes themselves rather than
 * their keys, for a caller that holds objects (a Secret location search).
 */
export function hiddenProbesByParentIdentity<T extends ChildProbe>(lane: ChildVisibilityLane, probes: readonly T[]): Set<T> {
  const hidden = hiddenByParentIdentity(lane, probes);
  return new Set(probes.filter((probe) => hidden.has(tierLedgerIdentityKey(probe))));
}

/** A child to judge: how the caller names it, and the parent its row names. */
export interface ChildWithParent {
  key: string;
  parent: ParentRef;
}

/**
 * The keys of those children whose parent may not be seen. A child with no
 * verdict at all (a parent the judging could not reach) is hidden.
 */
export function childrenWithHiddenParents(lane: ChildVisibilityLane, children: readonly ChildWithParent[]): Set<string> {
  const hidden = new Set<string>();
  if (children.length === 0) return hidden;
  const verdicts = parentVerdicts(lane, children.map((child) => child.parent));
  for (const child of children) {
    if (verdicts.get(parentKey(child.parent))?.visible !== true) hidden.add(child.key);
  }
  return hidden;
}

/**
 * Which of `probes` are children, found in the stores of the lane: the key
 * (`tierLedgerIdentityKey`) and the parent each one's row names. An item no
 * store has a parent link for is not a child.
 */
export function childLinks(lane: ChildVisibilityLane, probes: readonly ChildProbe[]): ChildWithParent[] {
  const found = new Map<string, ParentRef>();
  let remaining = probes;
  for (const store of lane.stores()) {
    if (remaining.length === 0) break;
    for (const [key, parent] of store.parentLinksOf(remaining)) found.set(key, parent);
    // A child held by two stores (it moved) names the same parent in both.
    remaining = remaining.filter((probe) => !found.has(tierLedgerIdentityKey(probe)));
  }
  return [...found].map(([key, parent]) => ({ key, parent }));
}

/**
 * The keys (`tierLedgerIdentityKey`) of those of `probes` that are children of
 * a parent that may not be seen. A lane that cannot be read hides every probe
 * that could be a child, which is every probe it cannot rule out: the links
 * are read from the stores, so when the stores cannot be read, all of them.
 */
export function hiddenChildKeys(lane: ChildVisibilityLane, probes: readonly ChildProbe[]): Set<string> {
  if (probes.length === 0) return new Set();
  let links: ChildWithParent[];
  try {
    links = childLinks(lane, probes);
  } catch {
    return new Set(probes.map((probe) => tierLedgerIdentityKey(probe)));
  }
  return childrenWithHiddenParents(lane, links);
}
