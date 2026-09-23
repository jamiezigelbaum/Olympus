// The shared per-tier store capability (design
// docs/design/per-item-four-tier-classification.md, section 3.2).
//
// A source keeps one connector store per trust domain — public_safe.*,
// internal.* and secure_local.* — and ONE tier ledger (the set ledger) that is
// the single visibility authority for all of them. This module replaces the
// per-source twin fan-out: one provider traversal feeds every leg, each item
// is classified once, and the set routes it.
//
// Routing (phase P1b):
// - NEW items only. An item is new when no store of the set has ever held a
//   row for it and the ledger has never routed it. Everything else is
//   "legacy" and takes the lane's own placement, byte-for-byte the P1a path:
//   nothing stored before P1b moves, is re-embedded or is deleted.
// - A new item is routed only from a decision made on text the set actually
//   read. Unread content stays where the lane places it today.
// - Pending (a sniffer question is open) is treated as Private: the whole
//   item goes to the secure_local store and is held back from embedding.
// - Otherwise the metadata row goes to the metadata tier's store and the
//   content to the content tier's store (the two-tier invariant). A lane that
//   keeps an item whole (a chat message) declares `splitLayers: false`, and
//   the item goes to the more private of the two.
// - Secrets are stored nowhere; their location goes to the secret-locations
//   index.
// - A routed item whose new decision needs other stores is QUEUED as a move
//   (hidden first on a raise) and never moved by a sync; tier-move.ts is the
//   move primitive.
//
// Cursor safety: in shared-traversal mode the set's resume point is written to
// the set ledger only after every leg committed.
//
// Everything here is source-neutral: a lane declares its legs; nothing
// branches on which source an item came from.

import type { RawItem, SourceConnector, SourceConnectorListOptions, SourceConnectorListPage } from '../../core/contracts.ts';
import {
  buildSourceSensitivity,
  type SourceItemIdentity,
  type SourceSensitivity,
  type SourceTrustDomain,
} from '../../core/source-index/types.ts';
import { detectSecretFindingKinds } from '../classification/engine.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import { maxTier, type TierDecision, type TierKey } from '../classification/tier-classifier.ts';
import {
  tierLedgerPathForStore,
  trustDomainRank,
  type TierCopy,
  type TierCopyLayers,
  type TierCopyPlan,
  TierLedger as TierLedgerClass,
  type TierLedger,
  type TierPlacementPlan,
} from '../classification/tier-ledger.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import {
  connectorStoreItemText,
  syncAndEmbedFromConnector,
  type ConnectorStoreEmbedSummary,
  type ConnectorStoreSyncOptions,
  type ConnectorStoreSyncSummary,
  type ConnectorStoreTierRoute,
  type ConnectorStoreTierRouteInput,
  type ConnectorStoreTierRouting,
  type LocalConnectorStore,
} from './local-index.ts';
import { decideItemTiers, defaultStoreTrustTier, type ConnectorStoreTierClassification } from './tier-placement.ts';

/** Legs run in this order, least private first. */
export const TIER_DOMAIN_ORDER: readonly SourceTrustDomain[] = ['public_safe', 'internal', 'secure_local'];

/** The trust domain that stores each (non-Secrets) tier. */
export const TIER_KEY_TRUST_DOMAIN: Readonly<Record<Exclude<TierKey, 'secrets'>, SourceTrustDomain>> = {
  public: 'public_safe',
  private: 'internal',
  secure: 'secure_local',
};

/** Connector id recorded on writes the set makes into a leg outside that leg's own traversal. */
export const TIERED_STORE_SET_HANDOFF_CONNECTOR_ID = 'tiered_store_set_handoff';

/**
 * The set ledger lives beside the set's secure_local store, where that store's
 * own co-located ledger would be (tier-ledger-path.ts). Every lifecycle path
 * that finds the secure store therefore finds the set ledger: export, delete
 * --source and delete --all, including a relocated (*_DB_PATH) store.
 */
export function tieredStoreSetLedgerPath(secureLocalStoreDbPath: string): string {
  return tierLedgerPathForStore(secureLocalStoreDbPath);
}

export interface TieredStoreLegSpec {
  trustDomain: SourceTrustDomain;
  corpusId: string;
  /** An open store. */
  store?: LocalConnectorStore;
  /** Opens (creating on first need) the store. Required when `store` is absent. */
  open?: () => LocalConnectorStore;
  /** Whether a not-yet-opened store's file already exists. */
  exists?: () => boolean;
  /**
   * One of the lane's pre-P1b stores. Only these can receive the lane's own
   * (legacy) placement; a new leg never sees a legacy item.
   */
  legacy?: boolean;
  /** In-run embedding for this leg; the store's own canonical identity. */
  embeddingProvider?: SourceEmbeddingProvider;
}

export interface TieredStoreSetOptions {
  /** Stable id for this set's resume points (e.g. provider plus account). */
  setId: string;
  /** The set ledger: the one visibility authority for every leg. */
  ledger: TierLedger;
  legs: readonly TieredStoreLegSpec[];
  /** Whether an item's names and body may live in different stores. Default true. */
  splitLayers?: boolean;
  tierClassification?: ConnectorStoreTierClassification;
  secretLocations?: SecretLocationsIndex;
  /** Told once when a lazily created leg opens, so a runtime can serve it. */
  onLegOpened?: (store: LocalConnectorStore, leg: TieredStoreLegSpec) => void;
}

export interface TieredStoreLegRun {
  trustDomain: SourceTrustDomain;
  corpusId: string;
  sync: ConnectorStoreSyncSummary;
  embed?: ConnectorStoreEmbedSummary;
}

/** Content-free counts of what the router decided in one run. */
export interface TieredStoreRoutingCounts {
  itemsRouted: number;
  itemsLegacy: number;
  itemsSecrets: number;
  itemsPendingHeld: number;
  movesQueued: number;
  routedDeletions: number;
  contentUnreadHeld: number;
}

export interface TieredStoreSetRun {
  legs: TieredStoreLegRun[];
  byDomain: Partial<Record<SourceTrustDomain, TieredStoreLegRun>>;
  /** The resume point this run committed (shared mode), when the traversal left one. */
  cursor?: string;
  routing: TieredStoreRoutingCounts;
}

type Plan =
  | { kind: 'legacy' }
  | { kind: 'routed'; copies: ReadonlyMap<string, TierCopyLayers>; sensitivity: ReadonlyMap<string, SourceSensitivity> }
  | { kind: 'hold'; reason: 'move_queued' | 'content_unread' }
  | { kind: 'delete'; corpora: ReadonlySet<string>; reason: 'provider_deleted' | 'secrets' };

interface PlanEntry {
  plan: Plan;
  identity: SourceItemIdentity;
  handedOff: boolean;
}

export class TieredStoreSet {
  readonly setId: string;
  readonly ledger: TierLedger;
  private readonly legs: Map<SourceTrustDomain, { spec: TieredStoreLegSpec; store: LocalConnectorStore | undefined }>;
  private readonly splitLayers: boolean;
  private readonly tierClassification: ConnectorStoreTierClassification | undefined;
  private readonly secretLocations: SecretLocationsIndex | undefined;
  private readonly onLegOpened: TieredStoreSetOptions['onLegOpened'];

  constructor(options: TieredStoreSetOptions) {
    if (!options.setId.trim()) throw new Error('A tiered store set needs a stable id.');
    this.setId = options.setId;
    this.ledger = options.ledger;
    this.splitLayers = options.splitLayers !== false;
    this.tierClassification = options.tierClassification;
    this.secretLocations = options.secretLocations;
    this.onLegOpened = options.onLegOpened;
    this.legs = new Map();
    for (const spec of options.legs) {
      if (this.legs.has(spec.trustDomain)) throw new Error(`A tiered store set has one leg per trust domain (${spec.trustDomain}).`);
      if (!spec.store && !spec.open) throw new Error('A tiered store leg needs an open store or a way to open one.');
      if (spec.store && (spec.store.trustDomain !== spec.trustDomain || spec.store.corpusId !== spec.corpusId)) {
        throw new Error('A tiered store leg\'s store must match its declared trust domain and corpus.');
      }
      spec.store?.useTierLedger(this.ledger);
      this.legs.set(spec.trustDomain, { spec, store: spec.store });
    }
    // Private and pending items must always have somewhere to go.
    if (!this.legs.has('secure_local')) throw new Error('A tiered store set needs a secure_local leg.');
  }

  /** The leg's store, opening it when it is open, exists, or `create` is set. */
  store(trustDomain: SourceTrustDomain, options: { create?: boolean } = {}): LocalConnectorStore | undefined {
    const leg = this.legs.get(trustDomain);
    if (!leg) return undefined;
    if (leg.store) return leg.store;
    if (!options.create && leg.spec.exists?.() !== true) return undefined;
    const store = leg.spec.open!();
    if (store.trustDomain !== trustDomain || store.corpusId !== leg.spec.corpusId) {
      store.close();
      throw new Error('A lazily opened tiered store does not match its declared leg.');
    }
    store.useTierLedger(this.ledger);
    leg.store = store;
    this.onLegOpened?.(store, leg.spec);
    return store;
  }

  /** Every store that exists, for reads and status. Never creates one. */
  openStores(): LocalConnectorStore[] {
    return TIER_DOMAIN_ORDER.flatMap((domain) => {
      const store = this.store(domain);
      return store ? [store] : [];
    });
  }

  legSpec(trustDomain: SourceTrustDomain): TieredStoreLegSpec | undefined {
    return this.legs.get(trustDomain)?.spec;
  }

  /** The resume point the last fully committed shared run left for this connector. */
  committedCursor(connectorId: string): { cursor: string | null; committedAt: string } | undefined {
    return this.ledger.setCursor(this.setId, connectorId);
  }

  /**
   * Where a decision puts an item. Never lower than the decision; a tier with
   * no leg in this set goes to the next more private leg.
   */
  placementFor(decision: Pick<TierDecision, 'metadataTier' | 'contentTier' | 'state' | 'metadataPending' | 'contentPending'>): TierPlacementPlan {
    if (decision.contentTier === 'secrets' || decision.metadataTier === 'secrets') {
      return { copies: [], embedHold: false };
    }
    const pending = decision.state === 'pending' || decision.metadataPending || decision.contentPending;
    if (pending) {
      const domain = this.domainAtLeast('secure_local');
      return {
        copies: [{ corpusId: this.corpusFor(domain), trustDomain: domain, layers: 'both' }],
        embedHold: true,
        stored: { trustDomain: domain, trustTier: defaultStoreTrustTier(domain) },
      };
    }
    const metadataDomain = this.domainAtLeast(TIER_KEY_TRUST_DOMAIN[decision.metadataTier]);
    const contentDomain = this.domainAtLeast(
      TIER_KEY_TRUST_DOMAIN[maxTier(decision.contentTier, decision.metadataTier) as Exclude<TierKey, 'secrets'>],
    );
    const copies: TierCopyPlan[] = !this.splitLayers || metadataDomain === contentDomain
      ? [{ corpusId: this.corpusFor(contentDomain), trustDomain: contentDomain, layers: 'both' }]
      : [
          { corpusId: this.corpusFor(metadataDomain), trustDomain: metadataDomain, layers: 'metadata' },
          { corpusId: this.corpusFor(contentDomain), trustDomain: contentDomain, layers: 'content' },
        ];
    return {
      copies,
      embedHold: false,
      stored: { trustDomain: contentDomain, trustTier: defaultStoreTrustTier(contentDomain) },
    };
  }

  /**
   * One provider traversal through every leg (shared-traversal mode). Legs run
   * least private first; a leg that does not exist yet runs only when this
   * run routed an item to it. The set's resume point is committed only after
   * every leg committed.
   */
  async sync(
    connector: SourceConnector,
    sync: ConnectorStoreSyncOptions = {},
    options: { commitCursor?: boolean } = {},
  ): Promise<TieredStoreSetRun> {
    const run = new TieredRoutingRun(this, 'shared');
    const traversal = recordedTraversal(connector);
    const legRuns: TieredStoreLegRun[] = [];
    const ran = new Set<SourceTrustDomain>();
    for (const domain of TIER_DOMAIN_ORDER) {
      const store = this.store(domain);
      if (!store) continue;
      legRuns.push(await this.runLeg(domain, store, traversal, { ...sync, tierRouting: run }));
      ran.add(domain);
    }
    for (const domain of TIER_DOMAIN_ORDER) {
      if (ran.has(domain) || !run.routedDomains.has(domain)) continue;
      const store = this.store(domain, { create: true })!;
      legRuns.push(await this.runLeg(domain, store, traversal, { ...sync, tierRouting: run }));
    }
    run.finalize();
    const cursor = legRuns[0]?.sync.cursor;
    // A pass that is not a resume point (a reconcile from the start of the
    // listing) must not overwrite the incremental lane's committed position.
    if (options.commitCursor !== false) this.ledger.commitSetCursor(this.setId, connector.id, cursor ?? null);
    return tieredRun(legRuns, run.counts, cursor);
  }

  /**
   * Per-leg mode, for lanes whose legs keep their own connector and cursor
   * (each record is listed by exactly one leg). An item routed to another leg
   * is written there inline, before the listing leg's page commits, so no
   * leg's cursor ever passes an item that has not landed.
   */
  async syncLegs(
    entries: ReadonlyArray<{ trustDomain: SourceTrustDomain; connector: SourceConnector; sync?: ConnectorStoreSyncOptions }>,
  ): Promise<TieredStoreSetRun> {
    const run = new TieredRoutingRun(this, 'per_leg');
    const legRuns: TieredStoreLegRun[] = [];
    for (const entry of entries) {
      const store = this.store(entry.trustDomain, { create: true });
      if (!store) throw new Error(`No ${entry.trustDomain} leg in this tiered store set.`);
      run.legOptions.set(store.corpusId, entry.sync ?? {});
      legRuns.push(await this.runLeg(entry.trustDomain, store, entry.connector, { ...entry.sync, tierRouting: run }));
      run.finalize();
    }
    return tieredRun(legRuns, run.counts, undefined);
  }

  /** @internal */
  domainAtLeast(domain: SourceTrustDomain): SourceTrustDomain {
    for (const candidate of TIER_DOMAIN_ORDER) {
      if (trustDomainRank(candidate) >= trustDomainRank(domain) && this.legs.has(candidate)) return candidate;
    }
    return 'secure_local';
  }

  /** @internal */
  corpusFor(domain: SourceTrustDomain): string {
    const leg = this.legs.get(domain);
    if (!leg) throw new Error(`No ${domain} leg in this tiered store set.`);
    return leg.spec.corpusId;
  }

  /** @internal */
  domainForCorpus(corpusId: string): SourceTrustDomain | undefined {
    for (const [domain, leg] of this.legs) if (leg.spec.corpusId === corpusId) return domain;
    return undefined;
  }

  /** @internal Whether any store of the set has ever held a row for this item. */
  anyLegHasRow(identity: SourceItemIdentity): boolean {
    return TIER_DOMAIN_ORDER.some((domain) => this.store(domain)?.hasItemRow(identity) === true);
  }

  /** @internal */
  classification(): ConnectorStoreTierClassification | undefined {
    return this.tierClassification;
  }

  /** @internal */
  secrets(): SecretLocationsIndex | undefined {
    return this.secretLocations;
  }

  private async runLeg(
    domain: SourceTrustDomain,
    store: LocalConnectorStore,
    connector: SourceConnector,
    sync: ConnectorStoreSyncOptions,
  ): Promise<TieredStoreLegRun> {
    const provider = this.legs.get(domain)?.spec.embeddingProvider;
    if (!provider) {
      return { trustDomain: domain, corpusId: store.corpusId, sync: await store.syncFromConnector(connector, sync) };
    }
    const result = await syncAndEmbedFromConnector({ store, connector, embeddingProvider: provider, sync });
    return { trustDomain: domain, corpusId: store.corpusId, sync: result.sync, embed: result.embed };
  }
}

export interface LaneTieredStoreSetOptions {
  setId: string;
  internalStore: LocalConnectorStore;
  secureStore: LocalConnectorStore;
  /** The lane's Public store, opened (and created) only when an item is routed there. */
  publicLeg?: { corpusId: string; open: () => LocalConnectorStore; exists: () => boolean };
  /** Personal and Public share one canonical cloud identity; Private has its own. */
  internalEmbeddingProvider?: SourceEmbeddingProvider;
  secureEmbeddingProvider?: SourceEmbeddingProvider;
  splitLayers?: boolean;
  tierClassification?: ConnectorStoreTierClassification;
  secretLocations?: SecretLocationsIndex;
  /** Default: the secure store's own co-located ledger (tieredStoreSetLedgerPath). */
  ledger?: TierLedger;
  onLegOpened?: (store: LocalConnectorStore, leg: TieredStoreLegSpec) => void;
}

/**
 * A lane's set from the two stores it has always had (both legacy legs) plus
 * a lazily created Public leg. The set ledger defaults to the secure store's
 * co-located ledger, so the one visibility authority sits exactly where the
 * data lifecycle already finds it.
 */
export function createLaneTieredStoreSet(options: LaneTieredStoreSetOptions): TieredStoreSet {
  const ledger = options.ledger
    ?? options.secureStore.tierLedger()
    ?? new TierLedgerClass({ dbPath: tieredStoreSetLedgerPath(options.secureStore.dbPath) });
  return new TieredStoreSet({
    setId: options.setId,
    ledger,
    ...(options.splitLayers === false ? { splitLayers: false } : {}),
    ...(options.tierClassification ? { tierClassification: options.tierClassification } : {}),
    ...(options.secretLocations ? { secretLocations: options.secretLocations } : {}),
    ...(options.onLegOpened ? { onLegOpened: options.onLegOpened } : {}),
    legs: [
      ...(options.publicLeg
        ? [{
            trustDomain: 'public_safe' as const,
            corpusId: options.publicLeg.corpusId,
            open: options.publicLeg.open,
            exists: options.publicLeg.exists,
            ...(options.internalEmbeddingProvider ? { embeddingProvider: options.internalEmbeddingProvider } : {}),
          }]
        : []),
      {
        trustDomain: 'internal' as const,
        corpusId: options.internalStore.corpusId,
        store: options.internalStore,
        legacy: true,
        ...(options.internalEmbeddingProvider ? { embeddingProvider: options.internalEmbeddingProvider } : {}),
      },
      {
        trustDomain: 'secure_local' as const,
        corpusId: options.secureStore.corpusId,
        store: options.secureStore,
        legacy: true,
        ...(options.secureEmbeddingProvider ? { embeddingProvider: options.secureEmbeddingProvider } : {}),
      },
    ],
  });
}

/** The counts a lane receipt gains from its tier set. All optional. */
// A type alias, not an interface: receipt counts are consumed as
// Record<string, number>, which an interface cannot satisfy.
export type TieredLaneReceiptCounts = {
  public_items_indexed?: number;
  public_chunks_indexed?: number;
  public_chunks_embedded?: number;
  tier_routed_items?: number;
  tier_pending_items?: number;
  tier_secret_items?: number;
  tier_moves_queued?: number;
};

/**
 * The receipt counts a lane gains from per-tier stores, present only when
 * there is something to say, so a run that routed nothing and has no Public
 * store yields exactly its pre-P1b receipt.
 */
export function tieredLaneReceiptCounts(input: {
  public?: { sync: ConnectorStoreSyncSummary; embed?: ConnectorStoreEmbedSummary | undefined };
  routing: TieredStoreRoutingCounts;
}): TieredLaneReceiptCounts {
  const routing = input.routing;
  return {
    ...(input.public
      ? {
          public_items_indexed: input.public.sync.itemsIndexed,
          public_chunks_indexed: input.public.sync.chunksIndexed,
          public_chunks_embedded: input.public.embed?.chunksEmbedded ?? 0,
        }
      : {}),
    ...(routing.itemsRouted + routing.itemsSecrets + routing.movesQueued + routing.routedDeletions > 0
      ? {
          tier_routed_items: routing.itemsRouted,
          tier_pending_items: routing.itemsPendingHeld,
          tier_secret_items: routing.itemsSecrets,
          tier_moves_queued: routing.movesQueued,
        }
      : {}),
  };
}

/** The router one run hands every leg. Plans are made once per item per run. */
// Fields are assigned in the constructor, not as class-field initializers:
// initializers defeat the bundler's tree-shaking of this module and inflate
// the committed dist bundles (see the note on LocalConnectorStore's fields).
class TieredRoutingRun implements ConnectorStoreTierRouting {
  readonly routedDomains: Set<SourceTrustDomain>;
  readonly legOptions: Map<string, ConnectorStoreSyncOptions>;
  readonly counts: TieredStoreRoutingCounts;
  private readonly plans: Map<string, PlanEntry>;
  private readonly copyRemovals: Map<string, SourceItemIdentity>;
  private readonly set: TieredStoreSet;
  private readonly mode: 'shared' | 'per_leg';

  constructor(set: TieredStoreSet, mode: 'shared' | 'per_leg') {
    this.set = set;
    this.mode = mode;
    this.routedDomains = new Set();
    this.legOptions = new Map();
    this.plans = new Map();
    this.copyRemovals = new Map();
    this.counts = {
      itemsRouted: 0,
      itemsLegacy: 0,
      itemsSecrets: 0,
      itemsPendingHeld: 0,
      movesQueued: 0,
      routedDeletions: 0,
      contentUnreadHeld: 0,
    };
  }

  async route(input: ConnectorStoreTierRouteInput): Promise<ConnectorStoreTierRoute> {
    const domain = this.set.domainForCorpus(input.store.corpusId);
    if (!domain) throw new Error('A tier route was asked by a store outside its set.');
    const key = identityKey(input.item.identity);
    let entry = this.plans.get(key);
    if (!entry) {
      entry = { plan: this.planFor(input), identity: input.item.identity, handedOff: false };
      this.plans.set(key, entry);
    }
    if (this.mode === 'per_leg' && !entry.handedOff) {
      entry.handedOff = true;
      await this.handOff(entry, input, domain);
    }
    return this.routeFor(entry.plan, input.store.corpusId, domain);
  }

  /** Forget the copy rows of routed items this run deleted or found to be Secrets, now that every leg tombstoned them. */
  finalize(): void {
    for (const identity of this.copyRemovals.values()) this.set.ledger.removeCopies(identity);
    this.copyRemovals.clear();
  }

  private routeFor(plan: Plan, corpusId: string, domain: SourceTrustDomain): ConnectorStoreTierRoute {
    switch (plan.kind) {
      case 'legacy':
        return this.set.legSpec(domain)?.legacy === true
          ? { kind: 'legacy' }
          : { kind: 'elsewhere', reason: 'routed_to_other_tier' };
      case 'routed': {
        const layers = plan.copies.get(corpusId);
        const sensitivity = plan.sensitivity.get(corpusId);
        return layers && sensitivity
          ? { kind: 'store', sensitivity, layer: layers }
          : { kind: 'elsewhere', reason: 'routed_to_other_tier' };
      }
      case 'hold':
        return { kind: 'elsewhere', reason: plan.reason };
      case 'delete':
        return plan.corpora.has(corpusId)
          ? { kind: 'delete', reason: plan.reason }
          : { kind: 'elsewhere', reason: plan.reason === 'secrets' ? 'secrets' : 'routed_to_other_tier' };
    }
  }

  private planFor(input: ConnectorStoreTierRouteInput): Plan {
    const { item, connector } = input;
    const identity = item.identity;
    const ledger = this.set.ledger;
    if (item.metadata['deleted'] === true) {
      this.set.secrets()?.remove(identity);
      if (!ledger.isRouted(identity)) {
        this.counts.itemsLegacy += 1;
        return { kind: 'legacy' };
      }
      this.counts.routedDeletions += 1;
      this.copyRemovals.set(identityKey(identity), identity);
      return { kind: 'delete', corpora: new Set(ledger.copies(identity).map((copy) => copy.corpusId)), reason: 'provider_deleted' };
    }

    const text = connectorStoreItemText(item);
    const decision = decideItemTiers(connector, item, text, this.set.classification(), ledger);
    this.recordSecretLocation(item, text, decision);
    const routed = ledger.isRouted(identity);
    const contentRead = decision.contentRead && !input.contentFetchFailed;
    if (!routed) {
      // Only a NEW item, judged from text actually read, is routed. Metadata-
      // only dispositions and unread content keep the lane's placement.
      if (!contentRead || input.metadataOnly || this.set.anyLegHasRow(identity)) {
        this.counts.itemsLegacy += 1;
        return { kind: 'legacy' };
      }
    } else if (!contentRead) {
      // A routed item seen without its text: nothing proves its content tier,
      // so its copies are left exactly as they are.
      this.counts.contentUnreadHeld += 1;
      return { kind: 'hold', reason: 'content_unread' };
    }

    const placement = this.set.placementFor(decision);
    const recorded = ledger.recordRoutedPlacement(identity, decision, placement);
    switch (recorded.outcome) {
      case 'secrets':
        this.counts.itemsSecrets += 1;
        this.copyRemovals.set(identityKey(identity), identity);
        return { kind: 'delete', corpora: new Set(recorded.previousCopies.map((copy) => copy.corpusId)), reason: 'secrets' };
      case 'queued_move':
      case 'held_moving':
        this.counts.movesQueued += 1;
        return { kind: 'hold', reason: 'move_queued' };
      default: {
        this.counts.itemsRouted += 1;
        if (placement.embedHold) this.counts.itemsPendingHeld += 1;
        const copies = new Map<string, TierCopyLayers>();
        const sensitivity = new Map<string, SourceSensitivity>();
        for (const copy of placement.copies) {
          copies.set(copy.corpusId, copy.layers);
          sensitivity.set(copy.corpusId, buildSourceSensitivity({
            trustTier: defaultStoreTrustTier(copy.trustDomain),
            trustDomain: copy.trustDomain,
          }));
          this.routedDomains.add(copy.trustDomain);
        }
        return { kind: 'routed', copies, sensitivity };
      }
    }
  }

  /**
   * Per-leg mode: write the parts of a plan that belong to OTHER legs now,
   * inside the listing leg's page, so its cursor never passes them first.
   */
  private async handOff(entry: PlanEntry, input: ConnectorStoreTierRouteInput, listingDomain: SourceTrustDomain): Promise<void> {
    const plan = entry.plan;
    if (plan.kind === 'routed') {
      for (const corpusId of plan.copies.keys()) {
        const domain = this.set.domainForCorpus(corpusId)!;
        if (domain === listingDomain) continue;
        const store = this.set.store(domain, { create: true })!;
        const listing = this.legOptions.get(input.store.corpusId) ?? {};
        await store.syncFromConnector(handoffConnector(input.connector, input.item), {
          ...(listing.fetchContent !== undefined ? { fetchContent: listing.fetchContent } : {}),
          ...(listing.deferMetadataOnlyContent !== undefined
            ? { deferMetadataOnlyContent: listing.deferMetadataOnlyContent }
            : {}),
          tierRouting: this,
        });
      }
      return;
    }
    if (plan.kind === 'delete') {
      for (const corpusId of plan.corpora) {
        const domain = this.set.domainForCorpus(corpusId);
        if (!domain || domain === listingDomain) continue;
        this.set.store(domain)?.tombstoneCopy(entry.identity, {
          connectorId: TIERED_STORE_SET_HANDOFF_CONNECTOR_ID,
          ...(plan.reason === 'secrets' ? { trustTier: 'S5' as const } : {}),
        });
      }
    }
  }

  private recordSecretLocation(item: RawItem, text: string | undefined, decision: TierDecision): void {
    const index = this.set.secrets();
    if (!index) return;
    if (decision.contentTier !== 'secrets' && decision.metadataTier !== 'secrets') {
      // Only text that was read can prove a secret is gone.
      if (decision.contentRead) index.remove(item.identity);
      return;
    }
    const title = stringMetadata(item, ['title', 'name', 'subject']);
    const locator = stringMetadata(item, ['locatorUri', 'pathDisplay', 'url']);
    const kinds = [...new Set([
      ...(text ? detectSecretFindingKinds(text) : []),
      ...(title ? detectSecretFindingKinds(title) : []),
      ...(locator ? detectSecretFindingKinds(locator) : []),
    ])];
    index.record({
      identity: item.identity,
      ...(locator ? { locator } : {}),
      ...(title ? { title } : {}),
      // An owner Secrets override has no detector finding; say so by kind.
      findingKinds: kinds.length > 0 ? kinds : ['owner_marked_secret'],
      ...(text !== undefined ? { text } : {}),
    });
  }
}

function tieredRun(legs: TieredStoreLegRun[], routing: TieredStoreRoutingCounts, cursor: string | undefined): TieredStoreSetRun {
  const byDomain: Partial<Record<SourceTrustDomain, TieredStoreLegRun>> = {};
  for (const leg of legs) byDomain[leg.trustDomain] = leg;
  return { legs, byDomain, ...(cursor ? { cursor } : {}), routing: { ...routing } };
}

function identityKey(identity: Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId'>): string {
  return `${identity.provider}\u0000${identity.accountScope}\u0000${identity.providerItemId}`;
}

function stringMetadata(item: RawItem, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = item.metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * A traversal recorded on its first complete pass and replayed to every later
 * leg, so one run costs one provider traversal however many legs it feeds. A
 * traversal that threw is never replayed: its recording is partial and the
 * run is aborting anyway.
 */
export function recordedTraversal(connector: SourceConnector): SourceConnector {
  const pages: SourceConnectorListPage[] = [];
  let recorded = false;
  let failed = false;
  return {
    id: connector.id,
    family: connector.family,
    authenticate: () => connector.authenticate(),
    fetchItem: (localItemId: string): Promise<RawItem> => connector.fetchItem(localItemId),
    classificationSignals: (item: RawItem) => connector.classificationSignals(item),
    listItems(options: SourceConnectorListOptions = {}): AsyncIterable<SourceConnectorListPage> {
      if (recorded) {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          for (const page of pages) yield page;
        })();
      }
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        try {
          for await (const page of connector.listItems(options)) {
            pages.push(page);
            yield page;
          }
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          if (!failed) recorded = true;
        }
      })();
    },
  };
}

/** A one-item listing for writing a routed item into another leg (per-leg mode). */
function handoffConnector(source: SourceConnector, item: RawItem): SourceConnector {
  return {
    id: TIERED_STORE_SET_HANDOFF_CONNECTOR_ID,
    family: source.family,
    authenticate: async () => {},
    fetchItem: (localItemId: string) => source.fetchItem(localItemId),
    classificationSignals: (listed: RawItem) => source.classificationSignals(listed),
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: [item], done: true };
      })();
    },
  };
}

export type { TierCopy };
