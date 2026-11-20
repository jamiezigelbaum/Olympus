// Schema 18 observations for items whose input may never be listed again.
// The old item table kept selected names, not RawItem.metadata. Its search text
// and even the bounded names in a queued question are lossy. They supply
// candidates only: the original classifier input digest must prove the entire list.
import type { SourceClassificationSignals } from '../../core/contracts.ts';
import { connectorLabelCapability, encodeLabelObservation, providerMetadataLabels } from '../../core/source-connector-labels.ts';
import { namesInputReason, NAMES_INPUT_REASON_PREFIX, snifferFolderKeyNames } from '../classification/tier-classifier.ts';
import { snifferSubjectKey, type TierSnifferStore } from '../classification/sniffer-store.ts';
import { tierLedgerIdentityKey, type TierLedgerIdentity } from '../classification/tier-ledger.ts';
import { offThreadReadsSupported, readInBackground } from './off-thread-reads.ts';
import { ledgerReadOffThread } from './child-visibility.ts';
import { servingMetadataCopy } from './stored-names.ts';
import type { StoredLabelRow } from './local-index.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

const PAGE_ROWS = 200;
const CURSOR = 'complete_label_observation_after';
const DONE = 'complete_label_observation_done';
const lastStoreRead = new WeakMap<TieredStoreSet, string>();

function retainedLabels(row: StoredLabelRow, receipt: string, materials: readonly string[]): string | undefined {
  const capability = connectorLabelCapability(row.provider)!;
  const keys = receipt.slice(NAMES_INPUT_REASON_PREFIX.length).split(':')[0]!.split(',');
  const folderKeys: unknown = JSON.parse(row.folderKeys ?? '[]');
  if (!Array.isArray(folderKeys) || !folderKeys.every(key => typeof key === 'string')) return undefined;
  const folders = [...folderKeys, ...(row.providerConversationId ? [row.providerConversationId] : [])];
  const names: SourceClassificationSignals = {
    ...(keys.includes('title') && row.title ? { title: row.title } : {}),
    ...(keys.includes('sender') && row.sender ? { sender: row.sender } : {}),
    ...(keys.includes('path') && row.locator ? { path: row.locator } : {}),
    ...(keys.includes('folderKeys') ? { folderKeys: folders } : {}),
  };
  const prove = (labels: readonly string[] | undefined) => labels && !(capability.legacyTagLimits
    && (labels.length >= 100 || labels.some(label => label.length >= 200))) && namesInputReason({ ...names, labels }) === receipt
    ? encodeLabelObservation(row.provider, labels) : undefined;
  if (!keys.includes('labels')) return prove([]);
  // The queued names have title/path/folders first and sender last. A literal
  // separator, truncation, or a question from a later rejudge fails the digest.
  for (const material of materials) {
    const parts = material.split(' | ');
    const prefix = [names.title, names.path, ...snifferFolderKeyNames(names.folderKeys)].filter(Boolean).length;
    const labels = parts.slice(prefix, names.sender ? -1 : undefined);
    const observed = prove(providerMetadataLabels(row.provider, capability.metadataKey
      ? { [capability.metadataKey]: labels } : { attachmentNames: labels }));
    if (observed) return observed;
  }
  if (capability.metadataKey && row.opening) {
    const tags = row.opening.split('\n').find(line => line.startsWith('Tags: '))?.slice('Tags: '.length).split(', ');
    const observed = prove(providerMetadataLabels(row.provider, { [capability.metadataKey]: tags }));
    if (observed) return observed;
  }
  // Telegram appends attachment names, then forward attribution, then sender
  // and chat to its searchable text. Readwise retains tags among its aliases.
  // Try suffixes only; no body line or alias can pass as a label without the receipt.
  const lines = row.searchTail?.split('\n') ?? [];
  if (!capability.metadataKey) {
    if (lines.at(-1)?.startsWith('Reactions: ')) lines.pop();
    if (lines.at(-1) === row.title) lines.pop();
    if (lines.at(-1) === row.sender) lines.pop();
  }
  const forward = !capability.metadataKey && lines.at(-1)?.startsWith('Forwarded from ')
    ? lines.pop()!.slice('Forwarded from '.length) : undefined;
  for (let start = lines.length; start >= 0; start--) {
    const values = lines.slice(start);
    const observed = prove(providerMetadataLabels(row.provider, capability.metadataKey
      ? { [capability.metadataKey]: values } : { forwardedFrom: forward, attachmentNames: values }));
    if (observed) return observed;
  }
  return undefined;
}

export async function recoverStoredLabelPage(set: TieredStoreSet, sniffer: TierSnifferStore,
  turn: () => Promise<void> | undefined, limit = PAGE_ROWS) {
  const ledger = set.ledger;
  const stores = set.openStores();
  const pending = stores.filter(leg => ledger.readMeta(`${DONE}:${leg.corpusId}`) !== '1');
  // A leg with an outstanding write or a failed read cannot keep the other legs waiting.
  const previous = pending.findIndex(leg => leg.corpusId === lastStoreRead.get(set));
  const store = pending[previous + 1] ?? pending[0];
  if (!store) return { retired: true, changed: false, complete: true };
  lastStoreRead.set(set, store.corpusId);
  const cursorKey = `${CURSOR}:${store.corpusId}`;
  const saved = ledger.readMeta(cursorKey) ?? '';
  const after = Number(saved.slice(2)) || 0;
  const marker = store.changeMarker();
  const page = await store.storedLabelPage(after, Math.min(PAGE_ROWS, Math.max(1, limit)), ledger.unavailableLabelCount() > 0);
  const original = page.rows.filter(row => row.originalListing && row.observed === null);
  const subjects = original.map(({ provider, accountScope, providerConversationId, providerItemId }) =>
    ({ provider, accountScope, providerConversationId, providerItemId }));
  const [receipts, materials] = await Promise.all([
    ledgerReadOffThread(ledger, ledger.firstListingNamesReceipts(subjects), { lane: 'background' }),
    sniffer.retainedQuestionNames(subjects, offThreadReadsSupported(sniffer.dbPath) ? query => readInBackground(sniffer.dbPath, query) : undefined),
  ]);
  const observations = new Map<StoredLabelRow, string>();
  for (const row of original) {
    await turn();
    const receipt = receipts.get(tierLedgerIdentityKey(row));
    const labels = receipt && retainedLabels(row, receipt, materials.get(snifferSubjectKey(row)) ?? []);
    if (labels) observations.set(row, labels);
  }
  await turn();
  let changed = false;
  let deferred = false;
  const gaps = ledger.unavailableLabelCount();
  const hasWork = page.rows.some(row => row.observed !== 'known') || (gaps > 0 && page.rows.length > 0);
  // The source and ledger commit before the cursor. A crash replays only this page.
  if (hasWork) ledger.withMoveBatch(() => store.withItemCopyBatch(() => {
    const storeChanged = marker !== store.changeMarker();
    for (const row of page.rows) {
      if ((storeChanged && !store.labelRowUnchanged(row)) || ledger.writeIntent(row)) { deferred = true; continue; }
      const record = ledger.getCurrent(row);
      if (record?.contentTier === 'secrets' || record?.metadataTier === 'secrets') {
        ledger.setLabelsUnavailable(row, false);
        continue;
      }
      const source = servingMetadataCopy(ledger.copies(row), record);
      let known = row.observed === 'known';
      if (row.observed === null) {
        const receipt = receipts.get(tierLedgerIdentityKey(row));
        const labels = receipt && record?.reasons.includes(receipt) ? observations.get(row) : undefined;
        store.recordRecoveredLabels(row, labels ?? 'null');
        known = labels !== undefined;
        changed = true;
      }
      // Count the item, even if older than its ledger; split copies share the same identity.
      if (!source || source.corpusId === store.corpusId) ledger.setLabelsUnavailable(row, !known);
    }
  }));
  const dirty = saved.startsWith('1:') || changed || deferred;
  ledger.writeSettleProgress(cursorKey, page.end ? '' : `${Number(dirty)}:${page.last}`);
  if (changed) ledger.writeMeta('label_observations_changed_after', `${store.corpusId}:${page.last}`);
  if (page.end && !dirty) ledger.writeSettleProgress(`${DONE}:${store.corpusId}`, '1');
  const retired = page.end && !dirty && stores.every(leg => ledger.readMeta(`${DONE}:${leg.corpusId}`) === '1');
  return { retired, complete: retired, changed };
}

/** Resolve a recorded gap only once the serving leg actually holds a listing's observation. */
export function refreshListedLabelGap(set: TieredStoreSet, identity: TierLedgerIdentity): void {
  const record = set.ledger.getCurrent(identity);
  if (record?.contentTier === 'secrets' || record?.targetContentTier === 'secrets') {
    set.ledger.setLabelsUnavailable(identity, false);
    return;
  }
  const source = servingMetadataCopy(set.ledger.copies(identity), record);
  if (source) {
    const known = set.store(source.trustDomain)?.hasListedLabels(identity);
    if (known !== undefined) set.ledger.setLabelsUnavailable(identity, !known);
  } else {
    set.ledger.setLabelsUnavailable(identity, set.openStores().some(store => store.hasListedLabels(identity) === false));
  }
}
