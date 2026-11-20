import { realpathSync, statSync } from 'node:fs';
import { declaredConnectorStoreMounts, resolvedStorePath } from '../../core/source-placement.ts';
import { DEFAULT_ACCOUNT_SLOT, findRegistryAccount, readSourceRegistry, sourceAccountMovePending } from '../../core/source-registry.ts';
import { openTierLedger, readStoreItemAccountScopes } from '../../core/source-storage.ts';
import { findTierSetLedger, readTierSetBinding } from '../classification/tier-set-binding.ts';
import { secretLocationsPathForStore, tierLedgerPathForStore } from '../classification/tier-ledger-path.ts';
import { handleRegistryPathFromEnv, readConnectedHandleRegistry } from '../credential-broker/connected-handles.ts';
import { withoutUnpairedLaneHandles } from '../credential-broker/unpaired-sources.ts';
import { FileSourceScopeAuthority } from '../source-scope-runtime.ts';
import { gmailReadAccount } from '../google-connectors/gmail-archive-target.ts';
import { fileReadAccount, readCredentialSelection } from './runtime/source-lanes.ts';
import type { HeldPass, HeldSample } from './held-item-status.ts';

function retainedGmailAccount(pass: HeldPass, handle: Parameters<typeof gmailReadAccount>[0]): string {
  return gmailReadAccount(handle, pass.inventory.gmailStores.map(path => ({
    itemAccountScopes: (provider, limit = 3) => readStoreItemAccountScopes({ sourceId: 'gmail.email' }, path, provider, limit),
  })));
}

/** Only the worker opens files, resolves account selection and reads visibility. */
export function countHeldItems(pass: HeldPass, scopeChanged: () => void): HeldSample | undefined {
  const { inventory, previous, observed_at } = pass;
  const registry = readSourceRegistry();
  const openable = (sourceId: string) => {
    const account = findRegistryAccount(registry, sourceId, DEFAULT_ACCOUNT_SLOT);
    return !account || (account.state === 'active' && !sourceAccountMovePending(account));
  };
  const handlePath = handleRegistryPathFromEnv(process.env, true);
  const handles = handlePath ? withoutUnpairedLaneHandles(readConnectedHandleRegistry(handlePath).handles, handlePath, true) : [];
  const choose = (credential: Parameters<typeof readCredentialSelection>[0]) =>
    readCredentialSelection(credential, process.env, handles);
  const declared = declaredConnectorStoreMounts();
  const mounted = new Set(inventory.stores.map(store => store.corpusId));
  const approvedLocalMount = (sourceId: string): boolean => {
    if (sourceId !== 'local.files' || !handlePath) return false;
    const scope = new FileSourceScopeAuthority({
      registryPath: handlePath, readRegistry: () => ({ version: 1, handles }),
    }).snapshot(sourceId);
    return scope.status === 'approved' || scope.reason === 'malformed';
  };
  if (declared === 'unreadable' || declared.some(row => openable(row.sourceId) && !mounted.has(row.corpusId))
    || inventory.mountProblems.some(openable)
    || inventory.pending.some(lane => openable(lane.id) && (lane.mountBlocked || approvedLocalMount(lane.id)
      || (lane.credential && choose(lane.credential).reason !== 'none')
      || lane.stores.some(name => {
        const path = resolvedStorePath(lane.id, name, process.env);
        return [path, tierLedgerPathForStore(path), secretLocationsPathForStore(path)].some(candidate => statSync(candidate, { throwIfNoEntry: false }));
      })))) return undefined;

  const groups = new Map<string, { path: string; sourceId: string; boundId?: string; corpora: HeldSample['groups'][number]['corpora'] }>();
  const selected = new Map<string, string | null>();
  for (const store of inventory.stores) {
    if (!openable(store.sourceId)) continue;
    const { corpusId, dbPath, read } = store;
    let accountScope: string | null;
    if ('credential' in read) {
      if (!selected.has(store.sourceId)) {
        const choice = choose(read.credential);
        if (choice.reason === 'ambiguous' || choice.reason === 'pinned_missing') return undefined;
        const account = read.gmail ? retainedGmailAccount(pass, choice.handle) : fileReadAccount(choice);
        if (account === undefined) return undefined;
        selected.set(store.sourceId, account);
      }
      const account = selected.get(store.sourceId);
      if (account === null || account === undefined) continue;
      accountScope = account;
    } else accountScope = read.accountScope;

    if (!statSync(dbPath, { throwIfNoEntry: false })?.isFile()) return undefined;
    const binding = readTierSetBinding(dbPath, true);
    const ledger = binding ? findTierSetLedger(dbPath, binding) : store.ledgerPath;
    if (binding && !ledger) return undefined;
    const path = ledger ?? tierLedgerPathForStore(dbPath);
    if (!ledger && !statSync(path, { throwIfNoEntry: false })) continue; // Unbound legacy store.
    const key = realpathSync(path);
    let group = groups.get(key);
    if (!group) {
      group = { path: key, sourceId: store.sourceId, corpora: [] };
      groups.set(key, group);
    }
    if (binding) {
      if (group.boundId && binding.ledgerId !== group.boundId) return undefined;
      group.boundId = binding.ledgerId;
    }
    group.corpora.push({ corpusId, accountScope });
  }

  const entries = [...groups.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const { corpora } of entries) corpora.sort((a, b) => a.corpusId.localeCompare(b.corpusId));
  const tuples = ({ path, corpora }: Pick<HeldSample['groups'][number], 'path' | 'corpora'>) => [path, corpora];
  const same = previous !== undefined && JSON.stringify(entries.map(tuples)) === JSON.stringify(previous.groups.map(tuples));
  if (previous && !same) scopeChanged();
  let unchanged = same;
  const samples = entries.map(({ path, sourceId, boundId, corpora }, index) => {
    const ledger = openTierLedger({ sourceId }, { dbPath: path, readOnly: true, allowWalLessRead: true });
    try {
      if (boundId !== undefined && ledger.ledgerId() !== boundId) throw new Error('Store ledger binding changed');
      const prior = same ? previous.groups[index] : undefined;
      const sample = ledger.sampleHeldItems(corpora, prior);
      if (sample !== prior) unchanged = false;
      return { path, corpora, cursor: sample.cursor, count: sample.count };
    } finally { ledger.close(); }
  });
  if (unchanged) return previous;
  const count = samples.reduce((total, group) => total + group.count, 0);
  if (!Number.isSafeInteger(count) || count < 0) return undefined;
  return {
    observation: { count, observed_at, counted_scope: entries.flatMap(group => group.corpora) },
    groups: samples,
  };
}
