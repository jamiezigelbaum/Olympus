// What a store keeps of an item's names, read back for a pass over a stored
// item (an owner-rule sweep, a child's judgment with its parent's names as
// context): the copy that serves them, and the classifier's input from it.

import type { SourceClassificationSignals } from '../../core/contracts.ts';
import { copyServingLayer, type TierCopy, type TierLedgerIdentity } from '../classification/tier-ledger.ts';
import type { ConnectorStoreItemCopy } from './local-index.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

/**
 * The item's stored copy for its names: the copy serving them, else any other
 * (a raise in flight hides its sources but leaves them in their stores).
 */
export function storedCopyOf(
  set: TieredStoreSet,
  identity: TierLedgerIdentity,
  copies: readonly TierCopy[],
): ConnectorStoreItemCopy | undefined {
  const names = copyServingLayer(copies.filter((copy) => copy.state === 'current'), 'metadata');
  const ordered = [
    ...(names ? [names] : []),
    ...copies.filter((copy) => copy !== names).sort((left, right) => Number(right.state === 'current') - Number(left.state === 'current')),
  ];
  for (const copy of ordered) {
    const domain = set.domainForCorpus(copy.corpusId);
    const exported = domain ? set.store(domain)?.exportItemCopy(identity) : undefined;
    if (exported) return exported;
  }
  return undefined;
}

/** The classifier's input from a stored copy: what the store keeps of the item's names. */
export function storedSignals(copy: ConnectorStoreItemCopy): SourceClassificationSignals {
  const text = (value: string | number | null | undefined) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const title = text(copy.columns['title']);
  const locator = text(copy.columns['locator_uri']);
  const path = locator?.startsWith('/') ? locator : undefined;
  const sender = text(copy.columns['sender_label']) ?? text(copy.columns['sender_id']);
  let folderKeys: string[] = [];
  const keysJson = text(copy.columns['source_scope_folder_keys_json']);
  if (keysJson) {
    try {
      const parsed = JSON.parse(keysJson) as unknown;
      if (Array.isArray(parsed)) folderKeys = parsed.filter((key): key is string => typeof key === 'string');
    } catch {
      folderKeys = [];
    }
  }
  if (copy.identity.providerConversationId) folderKeys.push(copy.identity.providerConversationId);
  return {
    ...(title ? { title } : {}),
    ...(path ? { path } : {}),
    ...(folderKeys.length > 0 ? { folderKeys } : {}),
    ...(sender ? { sender } : {}),
  };
}
