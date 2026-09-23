// Where the worker registers the owner's installed classification inputs
// (installed-tier-classification.ts), kept dependency-free: the connector
// store's placement layer is reachable from the plugin entry, which the host
// may load under Node, so it must not pull SQLite in through this lookup.

import type { SensitivityMap } from '../../core/sensitivity-map.ts';
import type { OwnerTierRule, TierDecision, TierSniffer } from './tier-classifier.ts';
import type { TierPlacementPlan } from './tier-ledger.ts';

export interface InstalledStoreTierClassification {
  sensitivityMap?: SensitivityMap;
  rules?: readonly OwnerTierRule[];
  sniffer?: TierSniffer;
  /** Set when the inputs cannot be trusted (an invalid rules file): record nothing. */
  unavailableReason?: string;
}

export interface InstalledTierClassificationProvider {
  /** Inputs for decisions recorded in the ledger at `ledgerPath`. Never throws. */
  forLedger(ledgerPath: string, laneMap?: SensitivityMap): InstalledStoreTierClassification;
}

let registered: InstalledTierClassificationProvider | undefined;

export function registerInstalledTierClassification(provider: InstalledTierClassificationProvider | undefined): void {
  registered = provider;
}

export function registeredInstalledTierClassification(): InstalledTierClassificationProvider | undefined {
  return registered;
}

/**
 * Tiered store sets register their placement planner by set-ledger path, so
 * the sniffer's background pass can settle a routed item through P1b's
 * placement (queueing a move) rather than rewriting where it is stored.
 */
type TierSetPlanner = (decision: TierDecision) => TierPlacementPlan;
let tierSetPlanners: Map<string, TierSetPlanner> | undefined;

export function registerTierSetPlanner(ledgerPath: string, planner: TierSetPlanner): void {
  (tierSetPlanners ??= new Map()).set(ledgerPath, planner);
}

export function tierSetPlannerForLedger(ledgerPath: string): TierSetPlanner | undefined {
  return tierSetPlanners?.get(ledgerPath);
}
