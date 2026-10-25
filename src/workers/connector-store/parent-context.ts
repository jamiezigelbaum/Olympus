// A child item's parent's names, as context for the privacy-safe model that
// judges the child (docs/design/child-items.md, "Tiers", "Context for the
// judge"). Three rules, each kept here:
//
// - Authorized on its own. Only the parent's NAMES (its subject or chat and
//   its sender) are ever read, never its content. The privacy-safe model's
//   lane is local or Venice Private by construction (sniffer-lane.ts), so the
//   names of a Personal or Private parent may reach it; the names of a Secret
//   are not kept anywhere, and a parent that is hidden, gone or Secrets gives
//   no context.
// - Screened on its own. Names that carry a secret finding or read like an
//   instruction to the model are left out, and the child is judged on itself.
//   What the screen finds in the context is never applied to the child: the
//   context travels as its own line of the question, which every later screen
//   takes apart (tier-classifier.ts, `splitParentContext`).
// - Part of the judgment's identity. The classifier hashes the permitted
//   context into the question, so a different context is a different judgment
//   and an unchanged one reuses its verdict.
//
// This module reads the item's parent link and the parent's stored names. It
// names no source and no format.

import type { TierLedgerIdentity } from '../classification/tier-ledger.ts';
import { snifferParentContextAllowed } from '../classification/sniffer.ts';
import { PARENT_CONTEXT_MAX_CHARS } from '../classification/tier-classifier.ts';
import { storedCopyOf, storedSignals } from './stored-names.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

/**
 * The permitted context for judging one child: its parent's subject or chat
 * and sender, bounded and screened. Undefined when the item is not a child,
 * the parent is not there to read, or its names do not pass the screen.
 */
export function parentNamesContext(
  set: TieredStoreSet,
  child: TierLedgerIdentity,
  /** The parent link, when the caller already has it (a child being listed has no row yet). */
  parentLink?: string,
): string | undefined {
  const stores = set.openStores();
  let parentLocalItemId = parentLink;
  for (const store of stores) {
    if (parentLocalItemId) break;
    parentLocalItemId = store.parentLocalItemIdOf(child);
  }
  if (!parentLocalItemId) return undefined;

  let parent: TierLedgerIdentity | undefined;
  for (const store of stores) {
    const row = store.activeLocalItemRow(parentLocalItemId);
    if (row) {
      parent = row.identity;
      break;
    }
  }
  if (!parent) return undefined;

  const ledger = set.ledger;
  const record = ledger.getCurrent(parent);
  if (!record || record.metadataTier === 'secrets' || record.contentTier === 'secrets' || ledger.itemIsSecret(parent)) return undefined;
  const exported = storedCopyOf(set, parent, ledger.copies(parent));
  if (!exported) return undefined;
  const signals = storedSignals(exported);
  const text = [signals.title, signals.sender]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .join(' | ')
    .slice(0, PARENT_CONTEXT_MAX_CHARS);
  if (!text) return undefined;
  return snifferParentContextAllowed(text) ? text : undefined;
}
