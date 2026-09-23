// Tier migration for EXISTING installs (design
// docs/design/per-item-four-tier-classification.md, section 4.6, steps M0-M6).
//
// Everything stored before per-item routing sits where its lane always put it
// (Dropbox: every file Private). This module moves those items to the tiers
// the shared classifier gives them, under the owner's rules:
//
// - M0 plan: classify every stored item from the text the stores ALREADY hold
//   (no provider fetch; no model call unless the owner passes an approved
//   privacy-safe sniffer). Proposed tiers go into the tier ledger as
//   proposals, never as current tiers. A report says what would move, from
//   which tier to which, how many chunks each destination model would embed,
//   and what that costs (estimates). Stores and vectors are not touched.
// - M1: the owner edits rules or overrides and plans again. A re-plan over
//   unchanged data and inputs yields the same plan id and the same rows.
// - M2 approve: one owner-approval entry in the embedding ledger, bound to the
//   exact plan id and the hash of its counts and cost. A plan whose data or
//   inputs changed since planning is refused.
// - M3/M4 run: per batch, each item moves with the P1b move primitive:
//   destination copies are written (Public <-> Personal vectors copied when the
//   identity and input hash match; otherwise the destination's EXISTING model
//   embeds them later, a first mint or a match, never a rebind), then the
//   ledger flip, then the previous copies are superseded (kept, hidden). A
//   raise hides first. A move to Secrets hides every copy and records the
//   location; nothing is deleted. The run stops before the observed chunks or
//   cost exceed the approved plan, and resumes after a crash with exactly one
//   visible copy of every item.
// - M5 rollback: a ledger flip back per batch; nothing is re-embedded.
// - M6 purge: superseded copies are deleted ONLY with a separate owner
//   approval, and an invalidation entry records what was deleted, per corpus.
//
// Nothing here runs on its own: the `olympus tier migrate` CLI is the only
// caller. Source-neutral: a lane is data (a tiered store set plus a source id
// string); nothing branches on which source an item came from.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SourceClassificationSignals } from '../../core/contracts.ts';
import { trustDomainPrior } from '../../core/classification-signals.ts';
import { OperationError } from '../../core/operation-error.ts';
import type { SensitivityMap } from '../../core/sensitivity-map.ts';
import type { SourceItemIdentity, SourceTrustDomain } from '../../core/source-index/types.ts';
import type {
  ConnectorStoreEmbeddingAuthoritySnapshot,
  ConnectorStoreMigrationItem,
  LocalConnectorStore,
} from '../connector-store/local-index.ts';
import { moveTieredItem, type TierMoveEmbeddingIdentity } from '../connector-store/tier-move.ts';
import { TIER_KEY_TRUST_DOMAIN, type TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import {
  EMBEDDING_LEDGER_OWNER_APPROVAL,
  appendEmbeddingLedgerEntry,
  appendEmbeddingLedgerEntryOnce,
  isOwnerApprovedEmbeddingLedgerEntry,
  readEmbeddingLedger,
} from '../embedding-ledger.ts';
import { detectSecretFindingKinds } from './engine.ts';
import {
  TIER_CLASSIFIER_VERSION,
  classifyItemTiers,
  type OwnerTierRule,
  type TierDecision,
  type TierKey,
  type TierSniffer,
} from './tier-classifier.ts';
import {
  TierLedgerGenerationConflictError,
  copyServingLayer,
  tierLedgerIdentityKey,
  type TierCopy,
  type TierCopyPlan,
  type TierLedger,
  type TierLedgerIdentity,
  type TierLedgerRecord,
  type TierMigrationProposal,
  type TierMigrationProposalInput,
} from './tier-ledger.ts';

export const TIER_MIGRATION_STATE_SCHEMA_VERSION = 1;
export const TIER_MIGRATION_DIR_ENV = 'OLYMPUS_TIER_MIGRATION_DIR';

/** Display names (TRUST_MODEL.md "Product tier names"). */
const TIER_DISPLAY: Readonly<Record<TierKey, string>> = {
  public: 'Public',
  private: 'Personal',
  secure: 'Private',
  secrets: 'Secrets',
};

/** The tier a store's trust domain holds. An unknown domain reads as Private (fail closed). */
function domainTier(domain: SourceTrustDomain): Exclude<TierKey, 'secrets'> {
  return domain === 'public_safe' ? 'public' : domain === 'internal' ? 'private' : 'secure';
}

// ---- Inputs --------------------------------------------------------------------

/** One lane: its tiered store set, named by an opaque source id (data only). */
export interface TierMigrationLane {
  sourceId: string;
  set: TieredStoreSet;
  /**
   * The lane's stored placement is a configured chat-level rule (a prior its
   * items rest at and are never lowered below by automatic signals). The
   * connector publishes it as a prior at sync time; a stored row cannot, so
   * the lane declares it here.
   */
  storedPlacementIsPrior?: boolean;
}

/** The owner's classification inputs. `revision` covers everything but per-item overrides (read from the ledgers). */
export interface TierMigrationInputs {
  sensitivityMap?: SensitivityMap;
  rules?: readonly OwnerTierRule[];
  /** Only the owner-approved privacy-safe sniffer, and only when the owner asks for it. */
  sniffer?: TierSniffer;
  revision: string;
}

/** Per-model estimates. Every figure derived from these is an ESTIMATE, and the report says so. */
export interface TierMigrationModelEstimate {
  usdPerMillionTokens: number;
  chunksPerMinute: number;
}

export type TierMigrationPriceTable = Readonly<Record<string, Partial<TierMigrationModelEstimate>>>;

/**
 * Defaults used when the install's config names no estimate for a model.
 * UNVERIFIED list prices (design section 4.4); the owner reads the live price
 * before approving. Throughput is a planning figure, not a measurement.
 */
export const DEFAULT_TIER_MIGRATION_ESTIMATES: Readonly<Record<string, TierMigrationModelEstimate>> = {
  'gemini-embedding-2': { usdPerMillionTokens: 0.15, chunksPerMinute: 600 },
  'text-embedding-qwen3-8b': { usdPerMillionTokens: 0.0125, chunksPerMinute: 300 },
  'secure-local-qwen3-embed': { usdPerMillionTokens: 0, chunksPerMinute: 60 },
};

const FALLBACK_ESTIMATE: TierMigrationModelEstimate = { usdPerMillionTokens: 0.15, chunksPerMinute: 60 };

/** The embedding identity each trust domain embeds with on this install (sovereignty policy), if any. */
export type TierMigrationDomainIdentity = (domain: SourceTrustDomain) => TierMoveEmbeddingIdentity | undefined;

export interface TierMigrationPaths {
  /** The registry of plans, batches and approvals (content-free, 0600). */
  statePath: string;
  /** Where plan reports are written (owner-only; they name folders and senders). */
  reportDir: string;
  embeddingLedgerPath: string;
}

export function resolveTierMigrationPaths(
  env: Record<string, string | undefined>,
  embeddingLedgerPath: string,
): TierMigrationPaths {
  const configured = env[TIER_MIGRATION_DIR_ENV]?.trim();
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  const dir = configured || join(dataHome, 'openclaw', 'olympus', 'tier-migration');
  return { statePath: join(dir, 'state.json'), reportDir: join(dir, 'reports'), embeddingLedgerPath };
}

// ---- Registry ------------------------------------------------------------------

export type TierMigrationPlanState = 'planned' | 'approved' | 'running' | 'stopped' | 'done' | 'superseded';
export type TierMigrationBatchState = 'running' | 'stopped' | 'done' | 'rolled_back' | 'purged';

export interface TierMigrationMoveCount {
  source: string;
  from: string;
  toNames: string;
  toContent: string;
  items: number;
  chunks: number;
}

export interface TierMigrationDestinationEstimate {
  corpusId: string;
  trustDomain: SourceTrustDomain;
  /** The destination store's existing embedding model; null means keyword search only there. */
  modelId: string | null;
  chunksToEmbed: number;
  vectorsCopied: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  estimatedMinutes: number;
  /** Where the price came from: the install's config, or the built-in unverified default. */
  priceSource: 'config' | 'default_unverified' | 'none';
}

export interface TierMigrationTotals {
  itemsScanned: number;
  unchanged: number;
  /** Items with no stored text: nothing to judge the content from, so they stay where they are. */
  notRead: number;
  alreadyRouted: number;
  /** Items held in more than one store of a lane; left alone. */
  ambiguous: number;
  /** Items the store's exclusion gate no longer admits; left for the exclusion purge. */
  excluded: number;
  proposed: number;
  raises: number;
  lowers: number;
  secretsToHide: number;
  pendingHeld: number;
  moves: TierMigrationMoveCount[];
  destinations: TierMigrationDestinationEstimate[];
  chunksToEmbed: number;
  vectorsCopied: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  estimatedMinutes: number;
}

export interface TierMigrationBatchRecord {
  batchId: string;
  /** The owner's selector, verbatim (local registry only; never written to a ledger). */
  selector: string | null;
  state: TierMigrationBatchState;
  startedAt: string;
  completedAt?: string;
  startedEntryId: string;
  completedEntryId?: string;
  moved: number;
  secretsHidden: number;
  skipped: number;
  rolledBack: number;
  chunksPlaced: number;
  vectorsCopied: number;
  chunksToEmbed: Record<string, number>;
  estimatedCostUsd: number;
  stopReason?: string;
}

export interface TierMigrationPlanRecord {
  planId: string;
  createdAt: string;
  updatedAt: string;
  state: TierMigrationPlanState;
  inputsRevision: string;
  countsSha256: string;
  totals: TierMigrationTotals;
  lanes: Array<{ sourceId: string; ledgerPath: string; corpora: string[] }>;
  reportPath: string;
  noteEntryId: string;
  withSniffer: boolean;
  approval?: { entryId: string; approvedAt: string };
  batches: TierMigrationBatchRecord[];
  purge?: { approvalEntryId: string; invalidationEntryId: string; purgedAt: string; chunks: Record<string, number>; copies: number };
  lock?: { pid: number; startedAt: string };
}

interface TierMigrationStateFile {
  schemaVersion: typeof TIER_MIGRATION_STATE_SCHEMA_VERSION;
  plans: TierMigrationPlanRecord[];
}

export function readTierMigrationState(statePath: string): TierMigrationStateFile {
  if (!existsSync(statePath)) return { schemaVersion: TIER_MIGRATION_STATE_SCHEMA_VERSION, plans: [] };
  const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<TierMigrationStateFile>;
  if (parsed.schemaVersion !== TIER_MIGRATION_STATE_SCHEMA_VERSION || !Array.isArray(parsed.plans)) {
    throw new OperationError('config_error', `The tier migration state at ${statePath} is not readable.`);
  }
  return { schemaVersion: TIER_MIGRATION_STATE_SCHEMA_VERSION, plans: parsed.plans };
}

function writeTierMigrationState(statePath: string, state: TierMigrationStateFile): void {
  writeOwnerOnlyFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function writeOwnerOnlyFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function updatePlan(statePath: string, planId: string, update: (plan: TierMigrationPlanRecord) => void): TierMigrationPlanRecord {
  const state = readTierMigrationState(statePath);
  const plan = state.plans.find((candidate) => candidate.planId === planId);
  if (!plan) throw new OperationError('invalid_params', `No tier migration plan ${planId}.`, 'Run olympus tier migrate plan.');
  update(plan);
  plan.updatedAt = new Date().toISOString();
  writeTierMigrationState(statePath, state);
  return plan;
}

function findPlan(statePath: string, planId: string): TierMigrationPlanRecord {
  const plan = readTierMigrationState(statePath).plans.find((candidate) => candidate.planId === planId);
  if (!plan) throw new OperationError('invalid_params', `No tier migration plan ${planId}.`, 'Run olympus tier migrate plan.');
  return plan;
}

// ---- Shared helpers ------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A batch selector's content-free key (the ledger stores only these hashes). */
export function tierMigrationBatchKey(selector: string): string {
  return sha256(`tier-migration-batch\u0000${normalizeSelector(selector)}`).slice(0, 32);
}

const SELECTOR_KINDS = ['source', 'folder', 'label', 'sender', 'chat'] as const;

function normalizeSelector(selector: string): string {
  const trimmed = selector.trim();
  const colon = trimmed.indexOf(':');
  if (colon <= 0) {
    throw new OperationError(
      'invalid_params',
      `Unknown batch selector "${selector}".`,
      'Use source:<id>, folder:<path>, label:<key>, sender:<address> or chat:<key>.',
    );
  }
  const kind = trimmed.slice(0, colon).toLowerCase();
  let value = trimmed.slice(colon + 1).trim();
  if (!(SELECTOR_KINDS as readonly string[]).includes(kind) || !value) {
    throw new OperationError(
      'invalid_params',
      `Unknown batch selector "${selector}".`,
      'Use source:<id>, folder:<path>, label:<key>, sender:<address> or chat:<key>.',
    );
  }
  if (kind === 'folder') {
    value = value.toLowerCase().replace(/\/+$/u, '');
    if (!value.startsWith('/')) value = `/${value}`;
  } else if (kind === 'sender') {
    value = value.toLowerCase();
  }
  return `${kind}:${value}`;
}

/** Every selector an item answers to: its source, each ancestor folder of its path, its scope keys, its sender, its chat. */
function batchSelectorsFor(sourceId: string, item: ConnectorStoreMigrationItem): string[] {
  const selectors = [`source:${sourceId}`];
  const path = pathOf(item);
  if (path) {
    const parts = path.split('/').filter(Boolean);
    for (let depth = 1; depth < parts.length; depth += 1) selectors.push(`folder:/${parts.slice(0, depth).join('/')}`);
  }
  for (const key of item.folderKeys) selectors.push(`label:${key}`);
  const sender = item.senderLabel ?? item.senderId;
  if (sender) selectors.push(`sender:${sender}`);
  if (item.identity.providerConversationId) selectors.push(`chat:${item.identity.providerConversationId}`);
  return selectors;
}

/** A stored locator that is a path (it starts with "/"); a link is not a folder path. */
function pathOf(item: Pick<ConnectorStoreMigrationItem, 'locatorUri'>): string | undefined {
  return item.locatorUri?.startsWith('/') ? item.locatorUri : undefined;
}

/**
 * The classifier's input from a STORED row, source-neutrally: the title, a
 * path-shaped locator, the stored scope keys and chat key, and the sender.
 * Facts a stored row does not keep (labels, sharing state, provider floors)
 * are judged at the item's next sync, when its lane publishes them; the
 * migration never guesses them.
 */
function signalsFromStoredItem(
  item: ConnectorStoreMigrationItem,
  storeDomain: SourceTrustDomain,
  storedPlacementIsPrior: boolean,
): SourceClassificationSignals {
  const folderKeys = [
    ...item.folderKeys,
    ...(item.identity.providerConversationId ? [item.identity.providerConversationId] : []),
  ];
  const path = pathOf(item);
  const sender = item.senderLabel ?? item.senderId;
  return {
    ...(storedPlacementIsPrior ? { prior: trustDomainPrior(storeDomain, 'source_config') } : {}),
    ...(item.title ? { title: item.title } : {}),
    ...(path ? { path } : {}),
    ...(folderKeys.length > 0 ? { folderKeys } : {}),
    ...(sender ? { sender } : {}),
  };
}

function samePlacement(current: readonly TierCopyPlan[], planned: readonly TierCopyPlan[]): boolean {
  if (current.length !== planned.length) return false;
  return planned.every((plan) => current.some((copy) => copy.corpusId === plan.corpusId && copy.layers === plan.layers));
}

function placementIsLower(current: readonly TierCopyPlan[], planned: readonly TierCopyPlan[]): boolean {
  const rank = (domain: SourceTrustDomain) => ['public_safe', 'internal', 'secure_local'].indexOf(domain);
  for (const layer of ['metadata', 'content'] as const) {
    const from = copyServingLayer(current, layer);
    const to = copyServingLayer(planned, layer);
    if (from && to && rank(to.trustDomain) < rank(from.trustDomain)) return true;
  }
  return false;
}

function placementRaises(current: readonly TierCopyPlan[], planned: readonly TierCopyPlan[]): boolean {
  const rank = (domain: SourceTrustDomain) => ['public_safe', 'internal', 'secure_local'].indexOf(domain);
  for (const layer of ['metadata', 'content'] as const) {
    const from = copyServingLayer(current, layer);
    const to = copyServingLayer(planned, layer);
    if (from && to && rank(to.trustDomain) > rank(from.trustDomain)) return true;
  }
  return false;
}

/** What the item is served as today: for a routed item its current copies, else its one legacy store. */
function currentPlacement(copies: readonly TierCopy[]): TierCopyPlan[] {
  return copies.filter((copy) => copy.state === 'current')
    .map((copy) => ({ corpusId: copy.corpusId, trustDomain: copy.trustDomain, layers: copy.layers }));
}

/** A ledger row's queued-move decision, as the classifier would state it. */
function decisionFromQueuedMove(record: TierLedgerRecord): TierDecision {
  return {
    metadataTier: record.targetMetadataTier!,
    contentTier: record.targetContentTier!,
    decidedBy: record.decidedBy as TierDecision['decidedBy'],
    reasons: [...record.reasons],
    state: record.metadataPending || record.contentPending ? 'pending' : 'current',
    contentRead: record.contentRead,
    metadataPending: record.metadataPending,
    contentPending: record.contentPending,
    metadataForced: record.metadataForced,
    metadataFlagged: record.metadataFlagged,
    engineVersion: record.engineVersion,
    mapRevision: record.mapRevision,
    snifferId: 'ledger',
  };
}

function estimateFor(modelId: string, prices: TierMigrationPriceTable | undefined): {
  estimate: TierMigrationModelEstimate;
  source: 'config' | 'default_unverified';
} {
  const configured = prices?.[modelId];
  const fallback = DEFAULT_TIER_MIGRATION_ESTIMATES[modelId] ?? FALLBACK_ESTIMATE;
  if (configured && typeof configured.usdPerMillionTokens === 'number') {
    return {
      estimate: {
        usdPerMillionTokens: configured.usdPerMillionTokens,
        chunksPerMinute: configured.chunksPerMinute ?? fallback.chunksPerMinute,
      },
      source: 'config',
    };
  }
  return { estimate: fallback, source: 'default_unverified' };
}

function authorityMatches(
  authority: ConnectorStoreEmbeddingAuthoritySnapshot | undefined,
  identity: TierMoveEmbeddingIdentity,
): boolean {
  return authority !== undefined
    && authority.modelId === identity.modelId
    && authority.provider === identity.provider
    && authority.backend === identity.backend
    && authority.dimension === identity.dimension
    && authority.epochId === identity.epochId;
}

function identityFromAuthority(authority: ConnectorStoreEmbeddingAuthoritySnapshot): TierMoveEmbeddingIdentity {
  return {
    modelId: authority.modelId,
    provider: authority.provider,
    backend: authority.backend === 'local' ? 'local' : 'cloud',
    dimension: authority.dimension,
    epochId: authority.epochId,
    configHash: authority.configHash ?? '',
  };
}

/**
 * The identity a destination store embeds (and may receive copied vectors)
 * under: the destination's own existing authority for the domain's model;
 * else, when the destination has none yet, the SOURCE store's authority for
 * that same model (the vectors were minted under it on this install, so the
 * destination's first mint uses the identical identity); else the policy's
 * canonical identity. Undefined: the domain embeds nothing (keyword only).
 */
function destinationIdentity(
  domain: SourceTrustDomain,
  destination: LocalConnectorStore | undefined,
  source: LocalConnectorStore,
  domainIdentity: TierMigrationDomainIdentity,
  cache: Map<string, ConnectorStoreEmbeddingAuthoritySnapshot[]>,
): TierMoveEmbeddingIdentity | undefined {
  const configured = domainIdentity(domain);
  if (!configured) return undefined;
  const authorities = (store: LocalConnectorStore) => storeAuthorities(store, cache);
  const own = destination ? authorities(destination).find((authority) => authority.modelId === configured.modelId) : undefined;
  if (own) return identityFromAuthority(own);
  const fromSource = authorities(source).find((authority) => authority.modelId === configured.modelId);
  if (fromSource && (domain !== 'secure_local' || fromSource.backend === 'local' || fromSource.provider === 'venice')) {
    return identityFromAuthority(fromSource);
  }
  return configured;
}

function storeAuthorities(
  store: LocalConnectorStore,
  cache: Map<string, ConnectorStoreEmbeddingAuthoritySnapshot[]>,
): ConnectorStoreEmbeddingAuthoritySnapshot[] {
  const cached = cache.get(store.corpusId);
  if (cached) return cached;
  const read = store.embeddingAuthorities();
  cache.set(store.corpusId, read);
  return read;
}

interface ItemEstimate {
  chunksToEmbed: number;
  vectorsCopied: number;
  tokens: number;
  byCorpus: Map<string, { chunksToEmbed: number; vectorsCopied: number; tokens: number; modelId: string | null; domain: SourceTrustDomain }>;
}

/** What moving one item costs, by the same rule the move applies (tier-move.ts, importItemCopy). */
function estimateItem(
  lane: TierMigrationLane,
  sourceStore: LocalConnectorStore,
  item: Pick<ConnectorStoreMigrationItem, 'chunks' | 'vectorsByModel'>,
  from: readonly TierCopyPlan[],
  planned: readonly TierCopyPlan[],
  domainIdentity: TierMigrationDomainIdentity,
  cache: Map<string, ConnectorStoreEmbeddingAuthoritySnapshot[]>,
): ItemEstimate {
  const estimate: ItemEstimate = { chunksToEmbed: 0, vectorsCopied: 0, tokens: 0, byCorpus: new Map() };
  const chunkCount = item.chunks.length;
  if (chunkCount === 0) return estimate;
  const textTokens = Math.ceil(item.chunks.reduce((total, chunk) => total + chunk.text.length, 0) / 4);
  const sourceAuthorities = storeAuthorities(sourceStore, cache);
  for (const copy of planned) {
    if (copy.layers === 'metadata') continue;
    const kept = from.find((source) => source.corpusId === copy.corpusId
      && (source.layers === 'both' || source.layers === copy.layers));
    if (kept) continue;
    const destination = lane.set.store(copy.trustDomain);
    const identity = destinationIdentity(copy.trustDomain, destination, sourceStore, domainIdentity, cache);
    const entry = { chunksToEmbed: 0, vectorsCopied: 0, tokens: 0, modelId: identity?.modelId ?? null, domain: copy.trustDomain };
    if (identity) {
      const minted = sourceAuthorities.find((authority) => authority.modelId === identity.modelId);
      const copyable = authorityMatches(minted, identity) ? Math.min(item.vectorsByModel[identity.modelId] ?? 0, chunkCount) : 0;
      entry.vectorsCopied = copyable;
      entry.chunksToEmbed = chunkCount - copyable;
      entry.tokens = Math.ceil(textTokens * (entry.chunksToEmbed / chunkCount));
    }
    estimate.byCorpus.set(copy.corpusId, entry);
    estimate.chunksToEmbed += entry.chunksToEmbed;
    estimate.vectorsCopied += entry.vectorsCopied;
    estimate.tokens += entry.tokens;
  }
  return estimate;
}

function laneLedgerProposals(lane: TierMigrationLane, planId: string): TierMigrationProposal[] {
  return lane.set.ledger.migrationProposals(planId);
}

/** A content-free digest of the owner's inputs as they stand: rules, map, sniffer and every lane's overrides. */
export function tierMigrationInputsRevision(lanes: readonly TierMigrationLane[], inputs: TierMigrationInputs): string {
  const overrides = lanes.map((lane) => `${lane.sourceId}:${sha256(lane.set.ledger.overridesCanonical())}`).sort().join('|');
  return sha256([
    TIER_CLASSIFIER_VERSION,
    inputs.revision,
    inputs.sniffer ? `sniffer:${inputs.sniffer.id}` : 'sniffer:none',
    overrides,
  ].join('\u0000')).slice(0, 32);
}

// ---- M0 / M1: plan ------------------------------------------------------------------

export interface TierMigrationPlanOptions {
  lanes: readonly TierMigrationLane[];
  inputs: TierMigrationInputs;
  domainIdentity: TierMigrationDomainIdentity;
  paths: TierMigrationPaths;
  prices?: TierMigrationPriceTable;
  now?: () => Date;
  pageSize?: number;
  /** How many patterns per kind the report lists. */
  topPatterns?: number;
}

export interface TierMigrationPattern {
  source: string;
  kind: 'folder' | 'label' | 'sender' | 'chat';
  /** The owner's own folder path, label key, sender or chat key. Report only; never in a ledger. */
  value: string;
  from: string;
  toNames: string;
  toContent: string;
  items: number;
}

export interface TierMigrationPlanResult {
  planId: string;
  state: TierMigrationPlanState;
  /** True when this plan id already existed (same data, same inputs). */
  reused: boolean;
  totals: TierMigrationTotals;
  countsSha256: string;
  reportPath: string;
  noteEntryId: string;
  topPatterns: TierMigrationPattern[];
  supersededPlans: string[];
}

interface PlannedItem {
  lane: TierMigrationLane;
  proposal: TierMigrationProposalInput;
  selectors: string[];
  from: TierCopyPlan[];
  planned: TierCopyPlan[];
  estimate: ItemEstimate;
  itemPath?: string;
  item?: ConnectorStoreMigrationItem;
}

export async function planTierMigration(options: TierMigrationPlanOptions): Promise<TierMigrationPlanResult> {
  const now = options.now ?? (() => new Date());
  const state = readTierMigrationState(options.paths.statePath);
  const running = state.plans.find((plan) => plan.state === 'running' && plan.lock && processAlive(plan.lock.pid));
  if (running) {
    throw new OperationError('invalid_request', `Tier migration plan ${running.planId} is running.`, 'Wait for it to stop, then plan again.');
  }
  const inputsRevision = tierMigrationInputsRevision(options.lanes, options.inputs);
  const authorityCache = new Map<string, ConnectorStoreEmbeddingAuthoritySnapshot[]>();
  const totals: TierMigrationTotals = emptyTotals();
  const planned: PlannedItem[] = [];
  const patterns = new Map<string, TierMigrationPattern>();

  for (const lane of options.lanes) {
    const set = lane.set;
    const ledger = set.ledger;
    const seen = new Set<string>();
    const stores = set.openStores();
    for (const store of stores) {
      let after: number | undefined;
      for (;;) {
        const page = store.migrationItemsPage({ ...(after !== undefined ? { afterItemPk: after } : {}), limit: options.pageSize ?? 500 });
        for (const item of page.items) {
          const key = tierLedgerIdentityKey(item.identity);
          const copies = ledger.copies(item.identity);
          if (copies.length > 0) {
            // Routed: the ledger owns its placement. Only a move a sync queued
            // (and never performed) is the migration's to finish.
            if (seen.has(key)) continue;
            seen.add(key);
            totals.itemsScanned += 1;
            const record = ledger.getCurrent(item.identity);
            if (record?.state === 'moving' && record.targetMetadataTier && record.targetContentTier) {
              const from = currentPlacement(copies);
              const contentFrom = copyServingLayer(from, 'content') ?? from[0];
              if (!contentFrom || contentFrom.corpusId !== store.corpusId) {
                // Judged from the store that serves the content.
                seen.delete(key);
                totals.itemsScanned -= 1;
                continue;
              }
              const decision = decisionFromQueuedMove(record);
              const placement = set.placementFor(decision);
              addPlanned(planned, totals, patterns, lane, store, item, decision, from, placement.copies, {
                kind: 'queued_move',
                expectedGeneration: record.generation,
                domainIdentity: options.domainIdentity,
                authorityCache,
              });
            } else {
              totals.alreadyRouted += 1;
            }
            continue;
          }
          if (seen.has(key)) continue;
          seen.add(key);
          totals.itemsScanned += 1;
          // Legacy: the one store that holds it serves it whole.
          const elsewhere = stores.some((other) => other !== store && other.itemPresence(item.identity).active);
          if (elsewhere) {
            totals.ambiguous += 1;
            continue;
          }
          if (!item.admitted) {
            totals.excluded += 1;
            continue;
          }
          if (item.chunks.length === 0) {
            totals.notRead += 1;
            continue;
          }
          const override = ledger.getOverride(item.identity);
          const decision = classifyItemTiers(
            {
              signals: signalsFromStoredItem(item, store.trustDomain, lane.storedPlacementIsPrior === true),
              provider: item.identity.provider,
              text: item.chunks.map((chunk) => chunk.text).join(''),
            },
            {
              ...(options.inputs.sensitivityMap ? { sensitivityMap: options.inputs.sensitivityMap } : {}),
              ...(options.inputs.rules ? { rules: options.inputs.rules } : {}),
              ...(options.inputs.sniffer ? { sniffer: options.inputs.sniffer } : {}),
              ...(override ? { override } : {}),
            },
          );
          const from: TierCopyPlan[] = [{ corpusId: store.corpusId, trustDomain: store.trustDomain, layers: 'both' }];
          const placement = decision.contentTier === 'secrets' || decision.metadataTier === 'secrets'
            ? []
            : set.placementFor(decision).copies;
          if (placement.length > 0 && samePlacement(from, placement)) {
            totals.unchanged += 1;
            continue;
          }
          addPlanned(planned, totals, patterns, lane, store, item, decision, from, placement, {
            kind: 'legacy',
            domainIdentity: options.domainIdentity,
            authorityCache,
          });
        }
        if (page.nextAfterItemPk === undefined) break;
        after = page.nextAfterItemPk;
      }
    }
  }

  finishTotals(totals, planned, options.prices);
  const countsSha256 = tierMigrationCountsSha256(totals);
  const planId = `tm-${sha256([
    inputsRevision,
    ...planned.map((entry) => [
      entry.lane.sourceId,
      tierLedgerIdentityKey(entry.proposal.identity),
      entry.proposal.fromCorpusId,
      entry.proposal.metadataTier,
      entry.proposal.contentTier,
      entry.proposal.itemFingerprint,
    ].join('\u0001')).sort(),
  ].join('\u0000')).slice(0, 16)}`;

  const top = topPatterns(patterns, options.topPatterns ?? 20);
  const reportPath = join(options.paths.reportDir, `${planId}.json`);
  const noteEntryId = `tier-migration-plan:${planId}`;
  const existing = state.plans.find((plan) => plan.planId === planId);
  const reused = existing !== undefined;
  const superseded: string[] = [];

  if (!existing || existing.state === 'planned' || existing.state === 'superseded') {
    for (const lane of options.lanes) {
      lane.set.ledger.replaceMigrationProposals(
        planId,
        planned.filter((entry) => entry.lane === lane).map((entry) => entry.proposal),
      );
    }
    const createdAt = existing?.createdAt ?? now().toISOString();
    const record: TierMigrationPlanRecord = {
      planId,
      createdAt,
      updatedAt: now().toISOString(),
      state: 'planned',
      inputsRevision,
      countsSha256,
      totals,
      lanes: options.lanes.map((lane) => ({
        sourceId: lane.sourceId,
        ledgerPath: lane.set.ledger.dbPath,
        corpora: lane.set.openStores().map((store) => store.corpusId),
      })),
      reportPath,
      noteEntryId,
      withSniffer: options.inputs.sniffer !== undefined,
      batches: [],
    };
    const others = state.plans.filter((plan) => plan.planId !== planId);
    for (const plan of others) {
      if (plan.state === 'planned' || plan.state === 'approved' || plan.state === 'stopped') {
        plan.state = 'superseded';
        plan.updatedAt = now().toISOString();
        superseded.push(plan.planId);
      }
    }
    writeTierMigrationState(options.paths.statePath, { schemaVersion: TIER_MIGRATION_STATE_SCHEMA_VERSION, plans: [...others, record] });
    writeOwnerOnlyFile(reportPath, `${JSON.stringify({
      kind: 'olympus_tier_migration_plan',
      planId,
      generatedAt: now().toISOString(),
      note: 'Dry run. Nothing was moved, embedded or deleted. Costs and times are ESTIMATES; read live prices before approving.',
      inputsRevision,
      countsSha256,
      totals,
      topPatterns: top,
    }, null, 2)}\n`);
  }

  await appendEmbeddingLedgerEntryOnce(options.paths.embeddingLedgerPath, {
    entry_id: noteEntryId,
    recorded_at: now().toISOString(),
    kind: 'note',
    what: `Tier migration dry run ${planId}: ${totals.proposed} of ${totals.itemsScanned} stored item(s) would change tier `
      + `(${totals.raises} raise(s), ${totals.lowers} lowering(s), ${totals.secretsToHide} to hide as Secrets). `
      + `Estimated: ${totals.chunksToEmbed} chunk(s) to embed in their destination stores' existing models, `
      + `${totals.vectorsCopied} vector(s) copied with no provider call, about $${totals.estimatedCostUsd.toFixed(2)} and `
      + `${Math.ceil(totals.estimatedMinutes)} minute(s). Nothing was moved, embedded or deleted; running it needs the owner's approval.`,
    scope: { corpora: [...new Set(totals.destinations.map((destination) => destination.corpusId))] },
    approved_by: 'system-automatic',
    status: 'n/a',
  });

  const current = findPlan(options.paths.statePath, planId);
  return {
    planId,
    state: current.state,
    reused,
    totals: current.totals,
    countsSha256: current.countsSha256,
    reportPath: current.reportPath,
    noteEntryId,
    topPatterns: top,
    supersededPlans: superseded,
  };
}

function addPlanned(
  planned: PlannedItem[],
  totals: TierMigrationTotals,
  patterns: Map<string, TierMigrationPattern>,
  lane: TierMigrationLane,
  store: LocalConnectorStore,
  item: ConnectorStoreMigrationItem,
  decision: TierDecision,
  from: TierCopyPlan[],
  placement: readonly TierCopyPlan[],
  options: {
    kind: 'legacy' | 'queued_move';
    expectedGeneration?: number;
    domainIdentity: TierMigrationDomainIdentity;
    authorityCache: Map<string, ConnectorStoreEmbeddingAuthoritySnapshot[]>;
  },
): void {
  const secrets = placement.length === 0;
  const estimate = secrets
    ? { chunksToEmbed: 0, vectorsCopied: 0, tokens: 0, byCorpus: new Map() }
    : estimateItem(lane, store, item, from, placement, options.domainIdentity, options.authorityCache);
  const selectors = batchSelectorsFor(lane.sourceId, item);
  const proposal: TierMigrationProposalInput = {
    identity: {
      provider: item.identity.provider,
      accountScope: item.identity.accountScope,
      providerItemId: item.identity.providerItemId,
      family: item.identity.family,
      ...(item.identity.providerConversationId ? { providerConversationId: item.identity.providerConversationId } : {}),
    },
    family: item.identity.family,
    fromCorpusId: store.corpusId,
    fromTrustDomain: store.trustDomain,
    kind: options.kind,
    metadataTier: decision.metadataTier,
    contentTier: decision.contentTier,
    decision,
    chunks: item.chunks.length,
    estimatedChunksToEmbed: estimate.chunksToEmbed,
    estimatedTokens: estimate.tokens,
    itemFingerprint: item.fingerprint,
    ...(options.expectedGeneration !== undefined ? { expectedGeneration: options.expectedGeneration } : {}),
    batchKeys: selectors.map(tierMigrationBatchKey),
  };
  planned.push({ lane, proposal, selectors, from, planned: [...placement], estimate });
  totals.proposed += 1;
  if (secrets) totals.secretsToHide += 1;
  else if (placementRaises(from, placement)) totals.raises += 1;
  else if (placementIsLower(from, placement)) totals.lowers += 1;
  if (decision.state === 'pending') totals.pendingHeld += 1;

  const fromTier = TIER_DISPLAY[domainTier(copyServingLayer(from, 'content')?.trustDomain ?? store.trustDomain)];
  const toNames = secrets ? 'Secrets' : TIER_DISPLAY[domainTier(copyServingLayer(placement, 'metadata')!.trustDomain)];
  const toContent = secrets ? 'Secrets' : TIER_DISPLAY[domainTier(copyServingLayer(placement, 'content')!.trustDomain)];
  const moveKey = [lane.sourceId, fromTier, toNames, toContent].join('\u0000');
  const move = totals.moves.find((entry) => [entry.source, entry.from, entry.toNames, entry.toContent].join('\u0000') === moveKey);
  if (move) {
    move.items += 1;
    move.chunks += item.chunks.length;
  } else {
    totals.moves.push({ source: lane.sourceId, from: fromTier, toNames, toContent, items: 1, chunks: item.chunks.length });
  }
  const path = pathOf(item);
  const folder = path ? path.slice(0, Math.max(1, path.lastIndexOf('/'))) : undefined;
  const sender = item.senderLabel ?? item.senderId;
  const facets: Array<[TierMigrationPattern['kind'], string | undefined]> = [
    ['folder', folder],
    ['sender', sender],
    ['chat', item.identity.providerConversationId],
    ...item.folderKeys.map((key): [TierMigrationPattern['kind'], string] => ['label', key]),
  ];
  for (const [kind, value] of facets) {
    if (!value) continue;
    const patternKey = [lane.sourceId, kind, value, fromTier, toNames, toContent].join('\u0000');
    const existing = patterns.get(patternKey);
    if (existing) existing.items += 1;
    else patterns.set(patternKey, { source: lane.sourceId, kind, value, from: fromTier, toNames, toContent, items: 1 });
  }
}

function emptyTotals(): TierMigrationTotals {
  return {
    itemsScanned: 0,
    unchanged: 0,
    notRead: 0,
    alreadyRouted: 0,
    ambiguous: 0,
    excluded: 0,
    proposed: 0,
    raises: 0,
    lowers: 0,
    secretsToHide: 0,
    pendingHeld: 0,
    moves: [],
    destinations: [],
    chunksToEmbed: 0,
    vectorsCopied: 0,
    estimatedTokens: 0,
    estimatedCostUsd: 0,
    estimatedMinutes: 0,
  };
}

function finishTotals(totals: TierMigrationTotals, planned: readonly PlannedItem[], prices: TierMigrationPriceTable | undefined): void {
  const byCorpus = new Map<string, TierMigrationDestinationEstimate>();
  for (const entry of planned) {
    for (const [corpusId, estimate] of entry.estimate.byCorpus) {
      const existing = byCorpus.get(corpusId) ?? {
        corpusId,
        trustDomain: estimate.domain,
        modelId: estimate.modelId,
        chunksToEmbed: 0,
        vectorsCopied: 0,
        estimatedTokens: 0,
        estimatedCostUsd: 0,
        estimatedMinutes: 0,
        priceSource: 'none' as const,
      };
      existing.chunksToEmbed += estimate.chunksToEmbed;
      existing.vectorsCopied += estimate.vectorsCopied;
      existing.estimatedTokens += estimate.tokens;
      byCorpus.set(corpusId, existing);
    }
  }
  for (const destination of byCorpus.values()) {
    if (destination.modelId) {
      const { estimate, source } = estimateFor(destination.modelId, prices);
      destination.estimatedCostUsd = roundCents(destination.estimatedTokens / 1_000_000 * estimate.usdPerMillionTokens);
      destination.estimatedMinutes = estimate.chunksPerMinute > 0 ? destination.chunksToEmbed / estimate.chunksPerMinute : 0;
      destination.priceSource = source;
    }
  }
  totals.destinations = [...byCorpus.values()].sort((left, right) => left.corpusId.localeCompare(right.corpusId));
  totals.moves.sort((left, right) => right.items - left.items || left.source.localeCompare(right.source));
  totals.chunksToEmbed = totals.destinations.reduce((sum, destination) => sum + destination.chunksToEmbed, 0);
  totals.vectorsCopied = totals.destinations.reduce((sum, destination) => sum + destination.vectorsCopied, 0);
  totals.estimatedTokens = totals.destinations.reduce((sum, destination) => sum + destination.estimatedTokens, 0);
  totals.estimatedCostUsd = roundCents(totals.destinations.reduce((sum, destination) => sum + destination.estimatedCostUsd, 0));
  // Destinations embed in parallel lanes; the slowest one bounds the wall time.
  totals.estimatedMinutes = Math.max(0, ...totals.destinations.map((destination) => destination.estimatedMinutes));
}

function roundCents(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** The hash an approval binds to: every count and estimate in the plan, canonically. */
export function tierMigrationCountsSha256(totals: TierMigrationTotals): string {
  return sha256(JSON.stringify(canonical(totals)));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function topPatterns(patterns: Map<string, TierMigrationPattern>, limit: number): TierMigrationPattern[] {
  const byKind = new Map<string, TierMigrationPattern[]>();
  for (const pattern of patterns.values()) {
    const list = byKind.get(pattern.kind) ?? [];
    list.push(pattern);
    byKind.set(pattern.kind, list);
  }
  return [...byKind.values()].flatMap((list) => list
    .sort((left, right) => right.items - left.items || left.value.localeCompare(right.value))
    .slice(0, limit));
}

// ---- Staleness -------------------------------------------------------------------

export interface TierMigrationFreshness {
  fresh: boolean;
  inputsChanged: boolean;
  changedItems: number;
}

/**
 * Whether the data and inputs a plan was made from still hold: the owner's
 * inputs revision (rules, map, sniffer, overrides) and, for every proposal not
 * yet acted on, the stored text it was judged from and its ledger state.
 */
export function tierMigrationPlanFreshness(
  plan: TierMigrationPlanRecord,
  lanes: readonly TierMigrationLane[],
  inputs: TierMigrationInputs,
): TierMigrationFreshness {
  const inputsChanged = tierMigrationInputsRevision(lanes, inputs) !== plan.inputsRevision;
  let changedItems = 0;
  for (const lane of lanes) {
    for (const proposal of lane.set.ledger.migrationProposals(plan.planId, { status: 'proposed' })) {
      if (proposalChanged(lane, proposal)) changedItems += 1;
    }
  }
  return { fresh: !inputsChanged && changedItems === 0, inputsChanged, changedItems };
}

function proposalChanged(lane: TierMigrationLane, proposal: TierMigrationProposal): boolean {
  const domain = lane.set.domainForCorpus(proposal.fromCorpusId);
  const store = domain ? lane.set.store(domain) : undefined;
  if (!store) return true;
  if (store.itemMigrationFingerprint(proposal.identity) !== proposal.itemFingerprint) return true;
  const record = lane.set.ledger.getCurrent(proposal.identity);
  if (proposal.kind === 'queued_move') {
    return !record || record.generation !== proposal.expectedGeneration || record.state !== 'moving';
  }
  return record?.routed === true;
}

// ---- M2: approve ---------------------------------------------------------------------

export interface TierMigrationApproveOptions {
  planId: string;
  lanes: readonly TierMigrationLane[];
  inputs: TierMigrationInputs;
  paths: TierMigrationPaths;
  why?: string;
  now?: () => Date;
}

export function tierMigrationApprovalEntryId(plan: Pick<TierMigrationPlanRecord, 'planId' | 'countsSha256'>): string {
  return `tier-migration-approval:${plan.planId}:${plan.countsSha256}`;
}

export async function approveTierMigration(options: TierMigrationApproveOptions): Promise<TierMigrationPlanRecord> {
  const now = options.now ?? (() => new Date());
  const plan = findPlan(options.paths.statePath, options.planId);
  if (plan.approval && plan.state !== 'superseded') return plan;
  if (plan.state !== 'planned') {
    throw new OperationError('invalid_request', `Plan ${plan.planId} is ${plan.state} and cannot be approved.`, 'Run olympus tier migrate plan for a current plan.');
  }
  if (tierMigrationCountsSha256(plan.totals) !== plan.countsSha256) {
    throw new OperationError('invalid_request', `Plan ${plan.planId}'s counts do not match their recorded hash.`, 'Plan again.');
  }
  const freshness = tierMigrationPlanFreshness(plan, options.lanes, options.inputs);
  if (!freshness.fresh) {
    throw new OperationError(
      'invalid_request',
      `Plan ${plan.planId} is stale: ${freshness.inputsChanged ? 'rules, map, sniffer or overrides changed' : ''}`
        + `${freshness.inputsChanged && freshness.changedItems > 0 ? '; ' : ''}`
        + `${freshness.changedItems > 0 ? `${freshness.changedItems} planned item(s) changed since planning` : ''}.`,
      'Run olympus tier migrate plan again and approve the new plan.',
    );
  }
  const entryId = tierMigrationApprovalEntryId(plan);
  const totals = plan.totals;
  await appendEmbeddingLedgerEntryOnce(options.paths.embeddingLedgerPath, {
    entry_id: entryId,
    recorded_at: now().toISOString(),
    kind: 'model_decision',
    what: `The owner approved tier migration plan ${plan.planId} (counts sha256 ${plan.countsSha256}): move ${totals.proposed} `
      + `stored item(s) to their classified tiers. Estimated ${totals.chunksToEmbed} chunk(s) to embed in each destination `
      + `store's EXISTING model and ${totals.vectorsCopied} vector(s) copied, about $${totals.estimatedCostUsd.toFixed(2)} and `
      + `${Math.ceil(totals.estimatedMinutes)} minute(s) (estimates). No model, epoch or dimension changes and no rebind; `
      + 'superseded copies and their vectors are kept, hidden, until a separately approved purge.',
    scope: { corpora: [...new Set([...totals.destinations.map((destination) => destination.corpusId), ...plan.lanes.flatMap((lane) => lane.corpora)])] },
    ...(options.why?.trim() ? { why: options.why.trim() } : {}),
    approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
    status: 'complete',
  });
  return updatePlan(options.paths.statePath, plan.planId, (record) => {
    record.state = 'approved';
    record.approval = { entryId, approvedAt: now().toISOString() };
  });
}

// ---- M3 / M4: run ----------------------------------------------------------------------

export interface TierMigrationRunOptions {
  planId: string;
  lanes: readonly TierMigrationLane[];
  inputs: TierMigrationInputs;
  domainIdentity: TierMigrationDomainIdentity;
  paths: TierMigrationPaths;
  prices?: TierMigrationPriceTable;
  /** source:<id>, folder:<path>, label:<key>, sender:<address> or chat:<key>. Omitted: every remaining item. */
  selector?: string;
  /** Stop after this many items (the rest stays for the next run). */
  maxItems?: number;
  /**
   * Asked before every item: true while an answer or the embedding drain
   * needs the machine. The run waits (never races an answer) and resumes.
   */
  shouldYield?: () => boolean | Promise<boolean>;
  yieldWaitMs?: number;
  /** A pause between items, so the stores' write lock is held in short slices. */
  itemDelayMs?: number;
  now?: () => Date;
  /** Test seam: called after each item's move, before it is marked moved. */
  afterItemMove?: (proposal: TierMigrationProposal) => void | Promise<void>;
}

export interface TierMigrationRunResult {
  planId: string;
  batchId: string;
  state: TierMigrationBatchState;
  planState: TierMigrationPlanState;
  moved: number;
  secretsHidden: number;
  skipped: number;
  remaining: number;
  chunksPlaced: number;
  vectorsCopied: number;
  chunksToEmbed: Record<string, number>;
  estimatedCostUsd: number;
  stopReason?: string;
  startedEntryId: string;
  completedEntryId?: string;
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runTierMigration(options: TierMigrationRunOptions): Promise<TierMigrationRunResult> {
  const now = options.now ?? (() => new Date());
  const plan = findPlan(options.paths.statePath, options.planId);
  if (plan.state === 'superseded' || plan.state === 'planned') {
    throw new OperationError(
      'invalid_request',
      `Plan ${plan.planId} is ${plan.state === 'planned' ? 'not approved' : 'superseded'}.`,
      plan.state === 'planned' ? `Run olympus tier migrate approve --plan ${plan.planId}.` : 'Plan again and approve the new plan.',
    );
  }
  if (plan.state === 'done') {
    throw new OperationError('invalid_request', `Plan ${plan.planId} is done: nothing is left to move.`);
  }
  if (plan.state === 'running' && plan.lock && plan.lock.pid !== process.pid && processAlive(plan.lock.pid)) {
    throw new OperationError('invalid_request', `Plan ${plan.planId} is already running (process ${plan.lock.pid}).`);
  }
  // The approval is the embedding ledger's, not the registry's: an approval
  // entry by the owner, bound to this plan id and these exact counts.
  const approvalId = tierMigrationApprovalEntryId(plan);
  const ledger = await readEmbeddingLedger(options.paths.embeddingLedgerPath);
  const approval = ledger.entries.find((entry) => entry.entry_id === approvalId);
  if (!approval || !isOwnerApprovedEmbeddingLedgerEntry(approval) || tierMigrationCountsSha256(plan.totals) !== plan.countsSha256) {
    throw new OperationError('invalid_request', `Plan ${plan.planId} has no owner approval bound to its counts.`, `Run olympus tier migrate approve --plan ${plan.planId}.`);
  }
  if (tierMigrationInputsRevision(options.lanes, options.inputs) !== plan.inputsRevision) {
    throw new OperationError(
      'invalid_request',
      `Plan ${plan.planId} is stale: rules, map, sniffer or overrides changed since it was approved.`,
      'Run olympus tier migrate plan again and approve the new plan.',
    );
  }

  const selectorKey = options.selector ? tierMigrationBatchKey(options.selector) : undefined;
  const selectorText = options.selector ? normalizeSelector(options.selector) : null;
  // Resume an unfinished batch for the same selector (a crash or a stop).
  const resumable = plan.batches.find((batch) => (batch.state === 'running' || batch.state === 'stopped') && batch.selector === selectorText);
  const batchId = resumable?.batchId ?? `${plan.planId}-b${plan.batches.length + 1}`;
  const startedEntryId = `tier-migration-batch-started:${batchId}`;

  const work: Array<{ lane: TierMigrationLane; proposal: TierMigrationProposal }> = [];
  for (const lane of options.lanes) {
    for (const proposal of laneLedgerProposals(lane, plan.planId)) {
      if (proposal.status !== 'proposed') continue;
      if (selectorKey && !proposal.batchKeys.includes(selectorKey)) continue;
      work.push({ lane, proposal });
    }
  }
  const estimatedBatchChunks = work.reduce((sum, entry) => sum + entry.proposal.estimatedChunksToEmbed, 0);

  updatePlan(options.paths.statePath, plan.planId, (record) => {
    record.state = 'running';
    record.lock = { pid: process.pid, startedAt: now().toISOString() };
    if (!resumable) {
      record.batches.push({
        batchId,
        selector: selectorText,
        state: 'running',
        startedAt: now().toISOString(),
        startedEntryId,
        moved: 0,
        secretsHidden: 0,
        skipped: 0,
        rolledBack: 0,
        chunksPlaced: 0,
        vectorsCopied: 0,
        chunksToEmbed: {},
        estimatedCostUsd: 0,
      });
    } else {
      const batch = record.batches.find((candidate) => candidate.batchId === batchId)!;
      batch.state = 'running';
      delete batch.stopReason;
    }
  });
  await appendEmbeddingLedgerEntryOnce(options.paths.embeddingLedgerPath, {
    entry_id: startedEntryId,
    recorded_at: now().toISOString(),
    kind: 're_embed_started',
    what: `Tier migration batch ${batchId} of approved plan ${plan.planId} started: ${work.length} item(s) to move, `
      + `an estimated ${estimatedBatchChunks} chunk(s) for their destination stores' existing models. Superseded copies are kept.`,
    scope: { corpora: [...new Set(work.flatMap((entry) => [entry.proposal.fromCorpusId]))] },
    approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
    status: 'in_progress',
  });

  // What this plan has already consumed, across every batch, against its approval.
  const consumed = currentPlanConsumption(findPlan(options.paths.statePath, plan.planId));
  const batch = findPlan(options.paths.statePath, plan.planId).batches.find((candidate) => candidate.batchId === batchId)!;
  const tally = {
    moved: batch.moved,
    secretsHidden: batch.secretsHidden,
    skipped: batch.skipped,
    chunksPlaced: batch.chunksPlaced,
    vectorsCopied: batch.vectorsCopied,
    chunksToEmbed: { ...batch.chunksToEmbed },
    estimatedCostUsd: batch.estimatedCostUsd,
  };
  const approvedChunks = plan.totals.chunksToEmbed;
  const approvedCost = plan.totals.estimatedCostUsd;
  const costPerChunk = new Map(plan.totals.destinations.map((destination) => [
    destination.corpusId,
    destination.chunksToEmbed > 0 ? destination.estimatedCostUsd / destination.chunksToEmbed : 0,
  ]));
  let stopReason: string | undefined;
  let processed = 0;
  const authorityCache = new Map<string, ConnectorStoreEmbeddingAuthoritySnapshot[]>();

  let failure: unknown;
  try {
  for (const { lane, proposal } of work) {
    if (options.maxItems !== undefined && processed >= options.maxItems) {
      stopReason = 'max_items';
      break;
    }
    await yieldToAnswers(options);
    processed += 1;
    const outcome = await migrateOne(lane, proposal, {
      domainIdentity: options.domainIdentity,
      authorityCache,
      remainingChunks: approvedChunks - consumed.chunksToEmbed,
      remainingCost: approvedCost - consumed.costUsd,
      costPerChunk,
    });
    if (outcome.kind === 'cap') {
      stopReason = outcome.reason;
      break;
    }
    if (outcome.kind === 'skipped') {
      tally.skipped += 1;
      lane.set.ledger.markMigrationProposal(plan.planId, proposal.identity, {
        status: 'skipped',
        batchId,
        outcome: { reason: outcome.reason },
      });
      continue;
    }
    if (options.afterItemMove) await options.afterItemMove(proposal);
    if (outcome.kind === 'secrets') tally.secretsHidden += 1;
    else tally.moved += 1;
    tally.chunksPlaced += outcome.chunksPlaced;
    tally.vectorsCopied += outcome.vectorsCopied;
    for (const [corpusId, chunks] of Object.entries(outcome.chunksToEmbed)) {
      tally.chunksToEmbed[corpusId] = (tally.chunksToEmbed[corpusId] ?? 0) + chunks;
      const cost = chunks * (costPerChunk.get(corpusId) ?? 0);
      tally.estimatedCostUsd = roundCents(tally.estimatedCostUsd + cost);
      consumed.costUsd += cost;
      consumed.chunksToEmbed += chunks;
    }
    lane.set.ledger.markMigrationProposal(plan.planId, proposal.identity, {
      status: 'moved',
      batchId,
      movedGeneration: outcome.generation,
      outcome: {
        kind: outcome.kind,
        chunksPlaced: outcome.chunksPlaced,
        vectorsCopied: outcome.vectorsCopied,
        chunksToEmbed: outcome.chunksToEmbed,
      },
    });
    // Persist progress as we go, so a crash loses at most the item in flight
    // (which the next run reconciles from the tier ledger).
    persistBatch(options.paths.statePath, plan.planId, batchId, tally);
    if (options.itemDelayMs && options.itemDelayMs > 0) await sleep(options.itemDelayMs);
  }
  } catch (error) {
    // Stop cleanly: release the lock and record where the batch got to. The
    // item in flight is reconciled from the tier ledger on the next run.
    failure = error;
    stopReason = 'failed';
  }

  const remaining = options.lanes.reduce((sum, lane) => sum + lane.set.ledger.migrationProposalCounts(plan.planId).proposed, 0);
  const batchState: TierMigrationBatchState = stopReason ? 'stopped' : 'done';
  let completedEntryId: string | undefined;
  if (batchState === 'done') {
    completedEntryId = `tier-migration-batch-completed:${batchId}`;
    await appendEmbeddingLedgerEntryOnce(options.paths.embeddingLedgerPath, {
      entry_id: completedEntryId,
      recorded_at: now().toISOString(),
      kind: 're_embed_completed',
      what: `Tier migration batch ${batchId} of approved plan ${plan.planId} finished moving: ${tally.moved} item(s) moved, `
        + `${tally.secretsHidden} hidden as Secrets (kept, not deleted), ${tally.skipped} skipped because they changed since planning. `
        + `${tally.vectorsCopied} vector(s) were copied with no provider call; the chunks counted here were handed to each `
        + 'destination store\'s own existing model, which the embedding drain embeds on its usual budget. Every previous copy is kept, hidden.',
      scope: {
        corpora: Object.keys(tally.chunksToEmbed).sort(),
        chunks: tally.chunksToEmbed,
      },
      approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
      status: 'complete',
    });
  } else {
    await appendEmbeddingLedgerEntry(options.paths.embeddingLedgerPath, {
      recorded_at: now().toISOString(),
      kind: 'note',
      what: `Tier migration batch ${batchId} of plan ${plan.planId} stopped (${stopReason}): ${tally.moved} item(s) moved and `
        + `${tally.secretsHidden} hidden so far; observed chunks for destination models so far are in scope. Running it again resumes it.`,
      scope: { corpora: Object.keys(tally.chunksToEmbed).sort(), chunks: tally.chunksToEmbed },
      approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
      status: 'in_progress',
    });
  }
  const finalPlan = updatePlan(options.paths.statePath, plan.planId, (record) => {
    const entry = record.batches.find((candidate) => candidate.batchId === batchId)!;
    Object.assign(entry, tally, { state: batchState });
    if (completedEntryId) {
      entry.completedAt = now().toISOString();
      entry.completedEntryId = completedEntryId;
    }
    if (stopReason) entry.stopReason = stopReason;
    delete record.lock;
    record.state = remaining === 0 ? 'done' : stopReason ? 'stopped' : 'approved';
  });
  if (failure !== undefined) {
    throw new OperationError(
      'source_index_error',
      `Tier migration batch ${batchId} stopped on an error: ${failure instanceof Error ? failure.message : String(failure)}`,
      'Fix the cause and run the same command again: the batch resumes where it stopped.',
    );
  }
  return {
    planId: plan.planId,
    batchId,
    state: batchState,
    planState: finalPlan.state,
    moved: tally.moved,
    secretsHidden: tally.secretsHidden,
    skipped: tally.skipped,
    remaining,
    chunksPlaced: tally.chunksPlaced,
    vectorsCopied: tally.vectorsCopied,
    chunksToEmbed: tally.chunksToEmbed,
    estimatedCostUsd: tally.estimatedCostUsd,
    ...(stopReason ? { stopReason } : {}),
    startedEntryId,
    ...(completedEntryId ? { completedEntryId } : {}),
  };
}

function currentPlanConsumption(plan: TierMigrationPlanRecord): { chunksToEmbed: number; costUsd: number } {
  let chunksToEmbed = 0;
  let costUsd = 0;
  for (const batch of plan.batches) {
    chunksToEmbed += Object.values(batch.chunksToEmbed).reduce((sum, count) => sum + count, 0);
    costUsd += batch.estimatedCostUsd;
  }
  return { chunksToEmbed, costUsd };
}

function persistBatch(
  statePath: string,
  planId: string,
  batchId: string,
  tally: Pick<TierMigrationBatchRecord, 'moved' | 'secretsHidden' | 'skipped' | 'chunksPlaced' | 'vectorsCopied' | 'chunksToEmbed' | 'estimatedCostUsd'>,
): void {
  updatePlan(statePath, planId, (record) => {
    const batch = record.batches.find((candidate) => candidate.batchId === batchId);
    if (batch) Object.assign(batch, { ...tally, chunksToEmbed: { ...tally.chunksToEmbed } });
  });
}

async function yieldToAnswers(options: Pick<TierMigrationRunOptions, 'shouldYield' | 'yieldWaitMs'>): Promise<void> {
  if (!options.shouldYield) return;
  for (let waits = 0; waits < 10_000 && await options.shouldYield(); waits += 1) {
    await sleep(options.yieldWaitMs ?? 1_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ItemOutcome =
  | { kind: 'moved' | 'secrets'; generation: number; chunksPlaced: number; vectorsCopied: number; chunksToEmbed: Record<string, number> }
  | { kind: 'skipped'; reason: string }
  | { kind: 'cap'; reason: string };

function fullIdentity(proposal: TierMigrationProposal, localItemId: string): SourceItemIdentity {
  return {
    family: proposal.family as SourceItemIdentity['family'],
    provider: proposal.identity.provider,
    accountScope: proposal.identity.accountScope,
    providerItemId: proposal.identity.providerItemId,
    localItemId,
    ...(proposal.identity.providerConversationId ? { providerConversationId: proposal.identity.providerConversationId } : {}),
  };
}

/**
 * Move one planned item. Idempotent across crashes: the tier ledger is read
 * first, and an item whose ledger already shows the planned placement is
 * reconciled as moved instead of moved again.
 */
async function migrateOne(
  lane: TierMigrationLane,
  proposal: TierMigrationProposal,
  context: {
    domainIdentity: TierMigrationDomainIdentity;
    authorityCache: Map<string, ConnectorStoreEmbeddingAuthoritySnapshot[]>;
    remainingChunks: number;
    remainingCost: number;
    costPerChunk: ReadonlyMap<string, number>;
  },
): Promise<ItemOutcome> {
  const set = lane.set;
  const ledger = set.ledger;
  const sourceDomain = set.domainForCorpus(proposal.fromCorpusId);
  const sourceStore = sourceDomain ? set.store(sourceDomain) : undefined;
  if (!sourceStore) return { kind: 'skipped', reason: 'source_store_missing' };
  const decision = proposal.decision;
  const secrets = decision.contentTier === 'secrets' || decision.metadataTier === 'secrets';
  const placement = secrets ? [] : set.placementFor(decision).copies;
  let record = ledger.getCurrent(proposal.identity);

  // Crash reconciliation: the flip already happened.
  if (record?.routed && record.state !== 'moving') {
    const current = currentPlacement(ledger.copies(proposal.identity));
    const done = secrets
      ? record.contentTier === 'secrets' && current.length === 0
      : record.metadataTier === decision.metadataTier && record.contentTier === decision.contentTier
        && samePlacement(current, placement);
    if (done) {
      return { kind: 'moved', generation: record.generation, chunksPlaced: 0, vectorsCopied: 0, chunksToEmbed: {} };
    }
  }

  // The stored text must still be what the plan judged.
  if (sourceStore.itemMigrationFingerprint(proposal.identity) !== proposal.itemFingerprint) {
    return { kind: 'skipped', reason: 'changed_since_plan' };
  }
  const exported = sourceStore.exportItemCopy(proposal.identity);
  if (!exported) return { kind: 'skipped', reason: 'source_copy_missing' };
  const identity = fullIdentity(proposal, exported.identity.localItemId);

  if (proposal.kind === 'queued_move') {
    if (!record || record.generation !== proposal.expectedGeneration || record.state !== 'moving') {
      return { kind: 'skipped', reason: 'changed_since_plan' };
    }
  } else if (!record?.routed) {
    // The legacy store is about to hold a copy the set ledger governs. Bind it
    // first (as a sync binds a store before its first routed copy), so EVERY
    // handle on it, a read-only reader or the drain included, judges its rows
    // by the set ledger from now on and fails closed without it.
    sourceStore.bindTierSet(ledger);
    // Adopt the legacy placement: the ledger now names the one copy that
    // serves the item today. No item row is touched and nothing becomes
    // visible or hidden by this write.
    record = ledger.adoptLegacyPlacement(
      proposal.identity,
      [{ corpusId: proposal.fromCorpusId, trustDomain: proposal.fromTrustDomain, layers: 'both' }],
      {
        whenMissing: {
          family: proposal.family,
          metadataTier: domainTier(proposal.fromTrustDomain),
          contentTier: domainTier(proposal.fromTrustDomain),
        },
      },
    );
  } else if (record.state === 'moving'
    && (record.targetMetadataTier !== decision.metadataTier || record.targetContentTier !== decision.contentTier)) {
    return { kind: 'skipped', reason: 'changed_since_plan' };
  }

  if (secrets) {
    return hideAsSecrets(lane, proposal, identity, exported.chunks.map((chunk) => chunk.boundedText).join(''), sourceStore);
  }

  // The destination identities, and the exact chunks this move hands to a
  // destination model: checked against the approval BEFORE anything moves.
  const vectorIdentities: Partial<Record<SourceTrustDomain, TierMoveEmbeddingIdentity>> = {};
  const from = currentPlacement(ledger.copies(proposal.identity));
  const hideFirstSources = ledger.copies(proposal.identity)
    .filter((copy) => copy.state === 'superseded' && copy.supersededByGeneration === (record?.generation ?? 0) + 1)
    .map((copy) => ({ corpusId: copy.corpusId, trustDomain: copy.trustDomain, layers: copy.layers }));
  const sources = [...from, ...hideFirstSources];
  const projected: Record<string, number> = {};
  const minted = exported.vectorAuthorities;
  for (const copy of placement) {
    if (copy.layers === 'metadata') continue;
    if (sources.some((source) => source.corpusId === copy.corpusId && (source.layers === 'both' || source.layers === copy.layers))) continue;
    const destination = set.store(copy.trustDomain);
    const vectorIdentity = destinationIdentity(copy.trustDomain, destination, sourceStore, context.domainIdentity, context.authorityCache);
    if (!vectorIdentity) continue;
    vectorIdentities[copy.trustDomain] = vectorIdentity;
    const authority = minted.find((candidate) => candidate.modelId === vectorIdentity.modelId);
    const copyable = authorityMatches(authority, vectorIdentity)
      ? exported.vectors.filter((vector) => vector.modelId === vectorIdentity.modelId
        && exported.chunks.some((chunk) => chunk.chunkIndex === vector.chunkIndex && chunk.embeddingInputHash === vector.contentHash)).length
      : 0;
    projected[copy.corpusId] = Math.max(0, exported.chunks.length - copyable);
  }
  const projectedChunks = Object.values(projected).reduce((sum, count) => sum + count, 0);
  const projectedCost = Object.entries(projected).reduce((sum, [corpusId, count]) => sum + count * (context.costPerChunk.get(corpusId) ?? 0), 0);
  if (projectedChunks > context.remainingChunks) return { kind: 'cap', reason: 'chunk_cap' };
  if (projectedCost > context.remainingCost + 1e-6) return { kind: 'cap', reason: 'cost_cap' };

  try {
    const moved = await moveTieredItem({ set, identity, decision, vectorIdentities });
    const chunksToEmbed: Record<string, number> = {};
    for (const destination of moved.destinations) {
      if (destination.chunksToEmbed > 0 && vectorIdentities[destination.trustDomain]) {
        chunksToEmbed[destination.corpusId] = destination.chunksToEmbed;
      }
    }
    return {
      kind: 'moved',
      generation: moved.generation,
      chunksPlaced: moved.chunkCount,
      vectorsCopied: moved.destinations.reduce((sum, destination) => sum + destination.vectorsCopied, 0),
      chunksToEmbed,
    };
  } catch (error) {
    if (error instanceof TierLedgerGenerationConflictError) return { kind: 'skipped', reason: 'changed_since_plan' };
    throw error;
  }
}

/**
 * A move to Secrets during migration HIDES every copy (the flip supersedes
 * them all in one write) and records the location. Nothing is deleted here:
 * the copies and their vectors are kept until the owner approves a purge.
 */
function hideAsSecrets(
  lane: TierMigrationLane,
  proposal: TierMigrationProposal,
  identity: SourceItemIdentity,
  text: string,
  sourceStore: LocalConnectorStore,
): ItemOutcome {
  const ledger = lane.set.ledger;
  const record = ledger.getCurrent(proposal.identity);
  if (!record) return { kind: 'skipped', reason: 'changed_since_plan' };
  try {
    const flipped = ledger.flipToSecrets(proposal.identity, { expectedGeneration: record.generation, reasons: proposal.decision.reasons });
    const row = sourceStore.activeLocalItemRow(identity.localItemId);
    const kinds = detectSecretFindingKinds(text);
    lane.set.secrets()?.record({
      identity,
      ...(row?.locatorUri ? { locator: row.locatorUri } : {}),
      namesReleasable: proposal.decision.metadataTier === 'public' || proposal.decision.metadataTier === 'private',
      folderKeys: row?.sourceScope?.folderKeys ?? [],
      ...(row?.sourceScope
        ? { scopeGeneration: row.sourceScope.accountGeneration, scopeRevision: row.sourceScope.scopeRevision }
        : {}),
      findingKinds: kinds.length > 0 ? kinds : ['owner_marked_secret'],
      text,
    });
    return { kind: 'secrets', generation: flipped.record.generation, chunksPlaced: 0, vectorsCopied: 0, chunksToEmbed: {} };
  } catch (error) {
    if (error instanceof TierLedgerGenerationConflictError) return { kind: 'skipped', reason: 'changed_since_plan' };
    throw error;
  }
}

// ---- M5: rollback ------------------------------------------------------------------------

export interface TierMigrationRollbackResult {
  planId: string;
  batchId: string;
  rolledBack: number;
  skipped: number;
  entryId: string;
}

export async function rollbackTierMigrationBatch(options: {
  batchId: string;
  lanes: readonly TierMigrationLane[];
  paths: TierMigrationPaths;
  now?: () => Date;
}): Promise<TierMigrationRollbackResult> {
  const now = options.now ?? (() => new Date());
  const state = readTierMigrationState(options.paths.statePath);
  const plan = state.plans.find((candidate) => candidate.batches.some((batch) => batch.batchId === options.batchId));
  const batch = plan?.batches.find((candidate) => candidate.batchId === options.batchId);
  if (!plan || !batch) throw new OperationError('invalid_params', `No tier migration batch ${options.batchId}.`);
  if (batch.state === 'purged') {
    throw new OperationError('invalid_request', `Batch ${batch.batchId}'s superseded copies were purged; it can no longer be rolled back.`);
  }
  if (plan.state === 'running' && plan.lock && processAlive(plan.lock.pid) && plan.lock.pid !== process.pid) {
    throw new OperationError('invalid_request', `Plan ${plan.planId} is running; stop it before rolling back.`);
  }
  let rolledBack = 0;
  let skipped = 0;
  for (const lane of options.lanes) {
    for (const proposal of lane.set.ledger.migrationProposals(plan.planId, { status: 'moved', batchId: batch.batchId })) {
      const record = lane.set.ledger.getCurrent(proposal.identity);
      if (!record || record.generation !== proposal.movedGeneration) {
        // A sync re-judged the item after the move; its newer state wins.
        skipped += 1;
        continue;
      }
      try {
        const restored = lane.set.ledger.rollbackMove(proposal.identity, { expectedGeneration: record.generation });
        lane.set.ledger.markMigrationProposal(plan.planId, proposal.identity, {
          status: 'rolled_back',
          movedGeneration: restored.generation,
        });
        rolledBack += 1;
      } catch (error) {
        if (error instanceof TierLedgerGenerationConflictError) {
          skipped += 1;
          continue;
        }
        throw error;
      }
    }
  }
  const entryId = `tier-migration-rollback:${batch.batchId}`;
  await appendEmbeddingLedgerEntryOnce(options.paths.embeddingLedgerPath, {
    entry_id: entryId,
    recorded_at: now().toISOString(),
    kind: 'note',
    what: `Tier migration batch ${batch.batchId} of plan ${plan.planId} was rolled back by a ledger flip: ${rolledBack} item(s) `
      + `serve from their previous copies again${skipped > 0 ? ` (${skipped} left alone because a later sync changed them)` : ''}. `
      + 'Nothing was re-embedded or deleted; the copies the batch wrote are kept, hidden.',
    approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
    status: 'complete',
  });
  updatePlan(options.paths.statePath, plan.planId, (record) => {
    const entry = record.batches.find((candidate) => candidate.batchId === batch.batchId)!;
    entry.state = 'rolled_back';
    entry.rolledBack = rolledBack;
  });
  return { planId: plan.planId, batchId: batch.batchId, rolledBack, skipped, entryId };
}

// ---- M6: purge -----------------------------------------------------------------------------

export interface TierMigrationPurgeResult {
  planId: string;
  approved: boolean;
  /** Superseded copies eligible (dry run) or deleted (approved). */
  copies: number;
  chunks: Record<string, number>;
  approvalEntryId?: string;
  invalidationEntryId?: string;
}

/**
 * Delete the superseded copies a plan's moves left behind. Without `approve`
 * it only counts them. With it, an owner-approval entry is written FIRST, then
 * each superseded copy is tombstoned in its store (chunks, FTS rows and
 * vectors of that one copy), then an invalidation entry records what was
 * deleted, per corpus. Current copies are never touched.
 */
export async function purgeTierMigration(options: {
  planId?: string;
  approve: boolean;
  why?: string;
  lanes: readonly TierMigrationLane[];
  paths: TierMigrationPaths;
  now?: () => Date;
}): Promise<TierMigrationPurgeResult> {
  const now = options.now ?? (() => new Date());
  const state = readTierMigrationState(options.paths.statePath);
  const plan = options.planId
    ? state.plans.find((candidate) => candidate.planId === options.planId)
    : [...state.plans].reverse().find((candidate) => candidate.batches.some((batch) => batch.state === 'done' || batch.state === 'stopped'));
  if (!plan) throw new OperationError('invalid_params', 'No tier migration plan has moved anything to purge.');
  if (plan.state === 'running' && plan.lock && processAlive(plan.lock.pid) && plan.lock.pid !== process.pid) {
    throw new OperationError('invalid_request', `Plan ${plan.planId} is running; purge after it stops.`);
  }
  const eligible: Array<{ lane: TierMigrationLane; proposal: TierMigrationProposal; copies: TierCopy[] }> = [];
  const chunks: Record<string, number> = {};
  for (const lane of options.lanes) {
    // Moved items keep their previous copies superseded; rolled-back items keep
    // the copies the move wrote superseded. Both are purged; nothing current is.
    const settled = [
      ...lane.set.ledger.migrationProposals(plan.planId, { status: 'moved' }),
      ...lane.set.ledger.migrationProposals(plan.planId, { status: 'rolled_back' }),
    ];
    for (const proposal of settled) {
      const superseded = lane.set.ledger.copies(proposal.identity).filter((copy) => copy.state === 'superseded');
      if (superseded.length === 0) continue;
      eligible.push({ lane, proposal, copies: superseded });
      for (const copy of superseded) {
        const domain = lane.set.domainForCorpus(copy.corpusId);
        const count = domain ? lane.set.store(domain)?.itemStoredContent(identityForStore(proposal))?.chunkCount ?? 0 : 0;
        chunks[copy.corpusId] = (chunks[copy.corpusId] ?? 0) + count;
      }
    }
  }
  const copyCount = eligible.reduce((sum, entry) => sum + entry.copies.length, 0);
  if (!options.approve) return { planId: plan.planId, approved: false, copies: copyCount, chunks };
  if (copyCount === 0) return { planId: plan.planId, approved: true, copies: 0, chunks };

  const digest = sha256(JSON.stringify(canonical({ copyCount, chunks }))).slice(0, 16);
  const approvalEntryId = `tier-migration-purge-approval:${plan.planId}:${digest}`;
  const corpora = Object.keys(chunks).sort();
  await appendEmbeddingLedgerEntryOnce(options.paths.embeddingLedgerPath, {
    entry_id: approvalEntryId,
    recorded_at: now().toISOString(),
    kind: 'invalidation',
    what: `The owner approved purging the ${copyCount} superseded copy(ies) tier migration plan ${plan.planId} kept hidden, `
      + `with their chunks and vectors (${Object.values(chunks).reduce((sum, count) => sum + count, 0)} chunk(s)). Current copies are not touched.`,
    scope: { corpora },
    ...(options.why?.trim() ? { why: options.why.trim() } : {}),
    approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
    status: 'pending',
  });
  const deleted: Record<string, number> = {};
  let copiesDeleted = 0;
  for (const { lane, proposal, copies } of eligible) {
    for (const copy of copies) {
      const domain = lane.set.domainForCorpus(copy.corpusId);
      const store = domain ? lane.set.store(domain) : undefined;
      if (!store) continue;
      const storeIdentity = identityForStore(proposal);
      const count = store.itemStoredContent(storeIdentity)?.chunkCount ?? 0;
      // Re-read: only a copy that is STILL superseded is purged.
      const still = lane.set.ledger.copies(proposal.identity).find((candidate) => candidate.corpusId === copy.corpusId);
      if (still?.state !== 'superseded') continue;
      const localItemId = store.exportItemCopy(storeIdentity)?.identity.localItemId;
      if (localItemId) {
        const secrets = proposal.contentTier === 'secrets' || proposal.metadataTier === 'secrets';
        store.tombstoneCopy(fullIdentity(proposal, localItemId), {
          connectorId: 'olympus_tier_migration_purge',
          ...(secrets ? { trustTier: 'S5' as const } : {}),
        });
      }
      lane.set.ledger.removeSupersededCopy(proposal.identity, copy.corpusId);
      deleted[copy.corpusId] = (deleted[copy.corpusId] ?? 0) + count;
      copiesDeleted += 1;
    }
    if (lane.set.ledger.copies(proposal.identity).every((copy) => copy.state !== 'superseded')) {
      lane.set.ledger.markMigrationProposal(plan.planId, proposal.identity, { status: 'purged' });
    }
  }
  const invalidationEntryId = `tier-migration-purge:${plan.planId}:${digest}`;
  await appendEmbeddingLedgerEntryOnce(options.paths.embeddingLedgerPath, {
    entry_id: invalidationEntryId,
    recorded_at: now().toISOString(),
    kind: 'invalidation',
    what: `Purged ${copiesDeleted} superseded copy(ies) that tier migration plan ${plan.planId} had kept hidden: their chunks and `
      + 'vectors were deleted, per corpus as counted in scope. Only superseded copies were touched; every current copy is unchanged.',
    scope: { corpora: Object.keys(deleted).sort(), chunks: deleted },
    approved_by: EMBEDDING_LEDGER_OWNER_APPROVAL,
    status: 'complete',
  });
  updatePlan(options.paths.statePath, plan.planId, (record) => {
    record.purge = { approvalEntryId, invalidationEntryId, purgedAt: now().toISOString(), chunks: deleted, copies: copiesDeleted };
    for (const batch of record.batches) {
      if (batch.state === 'done' || batch.state === 'stopped') batch.state = 'purged';
    }
  });
  return { planId: plan.planId, approved: true, copies: copiesDeleted, chunks: deleted, approvalEntryId, invalidationEntryId };
}

/** The identity a store lookup needs (it keys on provider, account, conversation and item id only). */
function identityForStore(proposal: TierMigrationProposal): SourceItemIdentity {
  return fullIdentity(proposal, '');
}

// ---- Status --------------------------------------------------------------------------------

/** Content-free summary for status surfaces, the doctor and the dashboard. */
export interface TierMigrationStatusSummary {
  plan_id: string;
  state: TierMigrationPlanState;
  /** True while an approved plan has work left or is moving: parity lag is expected. */
  in_progress: boolean;
  approval_entry_id?: string;
  proposed: number;
  batches: Array<{ batch_id: string; state: TierMigrationBatchState; moved: number; secrets_hidden: number; skipped: number }>;
  /** Stores the plan reads from or writes to. */
  corpora: string[];
  chunks_to_embed: number;
  purged: boolean;
}

export function tierMigrationStatusSummary(statePath: string): TierMigrationStatusSummary | undefined {
  let state: TierMigrationStateFile;
  try {
    state = readTierMigrationState(statePath);
  } catch {
    return undefined;
  }
  const plan = [...state.plans].reverse().find((candidate) => candidate.state !== 'superseded') ?? state.plans[state.plans.length - 1];
  if (!plan) return undefined;
  const inProgress = plan.state === 'running' || plan.state === 'stopped'
    || (plan.state === 'approved' && plan.approval !== undefined);
  return {
    plan_id: plan.planId,
    state: plan.state,
    in_progress: inProgress,
    ...(plan.approval ? { approval_entry_id: plan.approval.entryId } : {}),
    proposed: plan.totals.proposed,
    batches: plan.batches.map((batch) => ({
      batch_id: batch.batchId,
      state: batch.state,
      moved: batch.moved,
      secrets_hidden: batch.secretsHidden,
      skipped: batch.skipped,
    })),
    corpora: [...new Set([...plan.lanes.flatMap((lane) => lane.corpora), ...plan.totals.destinations.map((destination) => destination.corpusId)])].sort(),
    chunks_to_embed: plan.totals.chunksToEmbed,
    purged: plan.purge !== undefined,
  };
}

/** Display name of a tier key (TRUST_MODEL.md). */
export function tierMigrationTierName(tier: TierKey): string {
  return TIER_DISPLAY[tier];
}

export { TIER_KEY_TRUST_DOMAIN };
