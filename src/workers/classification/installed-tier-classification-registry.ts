// Where the worker registers the owner's installed classification inputs
// (installed-tier-classification.ts), kept dependency-free: the connector
// store's placement layer is reachable from the plugin entry, which the host
// may load under Node, so it must not pull SQLite in through this lookup.

import type { OwnerTierRule, TierDecision, TierSniffer } from './tier-classifier.ts';
import type { TierPlacementPlan } from './tier-ledger.ts';
import type { ChunkWindowKey } from './sniffer-store.ts';
import type { TierSnifferRequest, TierSnifferVerdict } from './tier-classifier.ts';

export interface ReleaseWindowReader {
  modelId: string;
  promptVersion: string;
  read(key: ChunkWindowKey): 'private' | 'secure' | 'secrets' | undefined;
}

export interface ReleaseWindowJudge extends ReleaseWindowReader {
  record(key: ChunkWindowKey, tier: 'private' | 'secure' | 'secrets'): void;
  resolve(request: TierSnifferRequest, signal: AbortSignal): Promise<TierSnifferVerdict>;
}

export interface AutomaticTierMoveContext {
  /** The embedding ledger each automatic move is recorded in. */
  embeddingLedgerPath: string;
  /** Read the live configuration; automatic replacement requires built-in local embeddings only. */
  localEmbeddingsOnly: () => boolean;
}

export interface InstalledStoreTierClassification {
  rules?: readonly OwnerTierRule[];
  sniffer?: TierSniffer;
  releaseJudge?: ReleaseWindowJudge;
  /** Cache proofs remain readable while live judging is unavailable (including the split front). */
  releaseWindows?: ReleaseWindowReader;
  /** This install has no Public tier: Public verdicts are lifted to Personal. */
  retirePublic?: boolean;
  /** Set when the inputs cannot be trusted (an invalid rules file): record nothing. */
  unavailableReason?: string;
}

export interface InstalledTierClassificationProvider {
  /** Engine move context inherited by every set, including sets opened lazily. */
  readonly automaticMoveContext?: AutomaticTierMoveContext | undefined;
  /**
   * Inputs for decisions recorded in the ledger at `ledgerPath`: the owner's
   * rules file as they are NOW (re-read when edited) and the sniffer.
   * Never throws.
   */
  forLedger(ledgerPath: string): InstalledStoreTierClassification;
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
