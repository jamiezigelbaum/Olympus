// How a store bound to a tiered store set finds the set's ledger.
//
// A store's binding (`LocalConnectorStore.tierSetBinding`) holds the ledger's
// IDENTITY and the absolute path the ledger had when the store was bound. The
// identity is what binds: a ledger is the right one only when its id is the
// recorded one, so a store never takes another set's tiers. The path is only a
// hint to where to look, because a store and its ledger move together
// (the migration into account folders renames them, and the data folder itself
// can be moved or restored elsewhere) and the row, which is never rewritten for
// that, keeps naming the old place.
//
// Prefer co-located ledgers. A recorded path is usable only inside this
// store's data root: a copy must never borrow its original install's ledger.

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { accountSiblingStorePath, pathResolvesWithin } from '../../core/olympus-layout.ts';
import { readStoreBindingCursor, TierLedger } from './tier-ledger.ts';
import { tierLedgerPathForStore } from './tier-ledger-path.ts';

/** Account layout identifies the data root; legacy/standalone stores use their directory. */
export function tierStoreDataRoot(storeDbPath: string): string {
  const folder = dirname(resolve(storeDbPath));
  return accountSiblingStorePath(storeDbPath, 'secure_local')
    ? dirname(dirname(dirname(dirname(folder)))) : folder;
}

/** A recorded ledger path is usable only inside this directory (symlinks resolved). */
export const tierLedgerIsWithin = pathResolvesWithin;

/** Read the binding without opening a store writable or running migrations. */
export function readTierSetBinding(storeDbPath: string): TierSetBindingRecord | undefined {
  const cursor = readStoreBindingCursor(storeDbPath, 'tiered-store-set-binding', 'tiered_store_set_binding');
  if (!cursor) return undefined;
  const binding = JSON.parse(cursor) as TierSetBindingRecord;
  if (typeof binding.ledgerId !== 'string' || typeof binding.ledgerPath !== 'string') throw new Error('Invalid privacy ledger binding.');
  return binding;
}

/** Preflight the governing ledger before a writer opens the connector database. */
export function assertStoreTierLedgerCanOpen(storeDbPath: string, readOnly = false): void {
  const binding = readTierSetBinding(storeDbPath);
  const path = binding ? findTierSetLedger(storeDbPath, binding) : tierLedgerPathForStore(storeDbPath);
  if (binding && !path) throw new Error(`The privacy ledger governing ${storeDbPath} is missing or outside this install. Restore the set ledger before opening the store.`);
  if (path) TierLedger.assertSchemaCanOpen(path, readOnly);
}

/** Offline eval/probe boundary, checked before opening any store or ledger. */
export function assertTierLedgerInDirectory(storeDbPath: string, directory = dirname(storeDbPath)): void {
  const binding = readTierSetBinding(storeDbPath);
  if (!binding) return;
  const found = findTierSetLedger(storeDbPath, binding);
  if (found && tierLedgerIsWithin(directory, found)) return;
  // Resolution itself refuses external ledgers. Diagnose the rejected hint too,
  // so a copy missing its ledger cannot silently start an empty eval.
  throw new Error(`Refusing store ${storeDbPath}: its privacy ledger is missing or outside the requested directory ${directory}. Copy the tier set and its ledger together.`);
}

export interface TierSetBindingRecord {
  ledgerId: string;
  /** Where the ledger was when the store was bound: a hint, never the identity. */
  ledgerPath: string;
}

/** Where a store's set ledger may be, co-located first; resolve links before accepting a path. */
export function tierSetLedgerCandidates(storeDbPath: string, recordedLedgerPath: string): string[] {
  if (storeDbPath === ':memory:' || recordedLedgerPath === ':memory:') return [recordedLedgerPath];
  const candidates: string[] = [];
  const secure = accountSiblingStorePath(storeDbPath, 'secure_local');
  if (secure) candidates.push(tierLedgerPathForStore(secure));
  candidates.push(join(dirname(storeDbPath), basename(recordedLedgerPath)));
  candidates.push(recordedLedgerPath);
  return [...new Set(candidates)].filter((path) => tierLedgerIsWithin(tierStoreDataRoot(storeDbPath), path));
}

/**
 * The path of the ledger a store is bound to, or undefined when none of the
 * candidates holds a ledger with the bound identity. It reads only each
 * candidate's identity (`TierLedger.readLedgerId`): no ledger is created,
 * migrated or changed, though SQLite may leave an empty -wal or an -shm beside
 * one. The answer is about the moment of the read, so whoever opens the path
 * must check the id of the handle it keeps.
 */
export function findTierSetLedger(storeDbPath: string, binding: TierSetBindingRecord): string | undefined {
  for (const candidate of tierSetLedgerCandidates(storeDbPath, binding.ledgerPath)) {
    if (candidate === ':memory:' || !existsSync(candidate)) continue;
    if (TierLedger.readLedgerId(candidate) === binding.ledgerId) return candidate;
  }
  return undefined;
}
