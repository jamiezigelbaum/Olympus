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
// its own). Its store row is kept as a location only (a tombstoned row at tier
// S5, no names, no text) and its ledger record says Secrets; either counts as
// present, and neither is read for anything but that. The parent's names and
// content are never shown through this module.
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
   * Secret that no store ever held a row for.
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
    // A Secret's row is a location only: present, though nothing of it may be read.
    if (list.some((row) => row.secret)) {
      verdicts.set(key, { visible: true, gone: false });
      continue;
    }
    if (!identity) {
      // No store holds a row for it. A Secret caught on its own words before any store wrote it
      // is known to the ledger alone, and is present all the same (nothing of it is read).
      if (ledger && parent.identity && ledger.itemIsSecret(parent.identity)) {
        verdicts.set(key, { visible: true, gone: false });
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
      if (!visible && ledger.itemIsSecret(identity)) {
        verdicts.set(key, { visible: true, gone: false });
        continue;
      }
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
