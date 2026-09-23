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

import { existsSync } from 'node:fs';
import type { RawItem, SourceConnector, SourceConnectorListOptions, SourceConnectorListPage } from '../../core/contracts.ts';
import {
  buildSourceSensitivity,
  type SourceItemIdentity,
  type SourceSensitivity,
  type SourceTrustDomain,
  type SourceTrustTier,
} from '../../core/source-index/types.ts';
import { detectSecretFindingKinds } from '../classification/engine.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import {
  maxTier,
  type OwnerTierRule,
  type TierDecidedBy,
  type TierDecision,
  type TierKey,
} from '../classification/tier-classifier.ts';
import {
  tierLedgerIdentityKey,
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
  TierLedgerUnavailableError,
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
  /**
   * The trust tier a routed copy in this leg is stored at. Default: the
   * domain's default tier (tier-placement.ts). A lane whose items have always
   * rested at another tier of the same domain declares it here, so a new item
   * routed into that domain rests exactly where the lane's items always did.
   */
  restingTier?: SourceTrustTier;
}

/**
 * A lane-level floor (design section 2.1, chats): the lane's items are never
 * placed below `trustDomain` unless the OWNER said so, either with a per-item
 * override or with an owner rule of one of `liftedByOwnerRule`'s kinds whose
 * tier is below the floor. Fail closed: a classifier default, a sensitivity
 * map category or public evidence never lowers an item below it.
 */
export interface TieredLaneFloor {
  trustDomain: SourceTrustDomain;
  liftedByOwnerRule: readonly OwnerTierRule['match']['kind'][];
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
  /** See TieredLaneFloor. */
  laneFloor?: TieredLaneFloor;
  /**
   * The lane lists items without their text and a later reader (the shared
   * extraction factory) supplies it. A NEW item is then routed from its
   * listing by its METADATA tier (names only, `layers: 'metadata'`), and its
   * content is placed by the content tier decided from the text actually
   * read, when that text lands (tiered-extraction.ts). Without this, an item
   * whose text was not read keeps the lane's own placement (phase P1b).
   */
  contentArrivesLater?: boolean;
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
  private readonly laneFloor: TieredLaneFloor | undefined;
  private readonly contentArrivesLater: boolean;

  constructor(options: TieredStoreSetOptions) {
    if (!options.setId.trim()) throw new Error('A tiered store set needs a stable id.');
    this.setId = options.setId;
    this.ledger = options.ledger;
    this.splitLayers = options.splitLayers !== false;
    this.tierClassification = options.tierClassification;
    this.secretLocations = options.secretLocations;
    this.onLegOpened = options.onLegOpened;
    this.laneFloor = options.laneFloor;
    this.contentArrivesLater = options.contentArrivesLater === true;
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
   * Where a decision puts an item. Never lower than the decision (nor than the
   * lane floor, unless the owner lifted it); a tier with no leg in this set
   * goes to the next more private leg.
   *
   * In a lane whose content arrives later (`contentArrivesLater`), an item
   * whose text has not been read yet gets only its metadata copy, in the
   * metadata tier's store; its content copy is placed when the text lands.
   * There, only an open NAME question (the sniffer) makes the whole item
   * pending (Private); an open CONTENT question holds just the content copy
   * in the Private store, held back from embedding.
   */
  placementFor(
    decision: Pick<TierDecision, 'metadataTier' | 'contentTier' | 'state' | 'metadataPending' | 'contentPending'>
      & Partial<Pick<TierDecision, 'contentRead' | 'decidedBy' | 'metadataOwnerRule'>>,
  ): TierPlacementPlan {
    if (decision.contentTier === 'secrets' || decision.metadataTier === 'secrets') {
      return { copies: [], embedHold: false };
    }
    const wholePending = this.contentArrivesLater
      ? decision.metadataPending
      : decision.state === 'pending' || decision.metadataPending || decision.contentPending;
    if (wholePending) {
      const domain = this.domainAtLeast('secure_local');
      return {
        copies: [{ corpusId: this.corpusFor(domain), trustDomain: domain, layers: 'both' }],
        embedHold: true,
        stored: { trustDomain: domain, trustTier: this.restingTierFor(domain) },
      };
    }
    const floor = this.floorFor(decision);
    const metadataDomain = this.domainAtLeast(atLeastDomain(TIER_KEY_TRUST_DOMAIN[decision.metadataTier], floor));
    if (this.contentArrivesLater && decision.contentRead !== true) {
      return {
        copies: [{ corpusId: this.corpusFor(metadataDomain), trustDomain: metadataDomain, layers: 'metadata' }],
        embedHold: false,
        stored: { trustDomain: metadataDomain, trustTier: this.restingTierFor(metadataDomain) },
      };
    }
    const contentHeld = this.contentArrivesLater && decision.contentPending;
    const contentDomain = contentHeld
      ? this.domainAtLeast('secure_local')
      : this.domainAtLeast(atLeastDomain(
          TIER_KEY_TRUST_DOMAIN[maxTier(decision.contentTier, decision.metadataTier) as Exclude<TierKey, 'secrets'>],
          floor,
        ));
    const copies: TierCopyPlan[] = !this.splitLayers || metadataDomain === contentDomain
      ? [{ corpusId: this.corpusFor(contentDomain), trustDomain: contentDomain, layers: 'both' }]
      : [
          { corpusId: this.corpusFor(metadataDomain), trustDomain: metadataDomain, layers: 'metadata' },
          { corpusId: this.corpusFor(contentDomain), trustDomain: contentDomain, layers: 'content' },
        ];
    return {
      copies,
      embedHold: contentHeld,
      stored: { trustDomain: contentDomain, trustTier: this.restingTierFor(contentDomain) },
    };
  }

  /** @internal Whether this lane's content arrives after listing (see the option). */
  readsContentLater(): boolean {
    return this.contentArrivesLater;
  }

  /** @internal The tier a routed copy in this domain's leg is stored at. */
  restingTierFor(domain: SourceTrustDomain): SourceTrustTier {
    return this.legs.get(domain)?.spec.restingTier ?? defaultStoreTrustTier(domain);
  }

  /**
   * The lane floor that applies to this decision: undefined when the lane has
   * none, or when the OWNER lifted it (a per-item override, or an owner rule of
   * a lifting kind that set a tier below the floor).
   */
  private floorFor(decision: Partial<Pick<TierDecision, 'decidedBy' | 'metadataOwnerRule'>>): SourceTrustDomain | undefined {
    const floor = this.laneFloor;
    if (!floor) return undefined;
    if (decision.decidedBy === 'override') return undefined;
    const rule = decision.metadataOwnerRule;
    if (rule
      && floor.liftedByOwnerRule.includes(rule.kind)
      && rule.tier !== 'secrets'
      && trustDomainRank(TIER_KEY_TRUST_DOMAIN[rule.tier]) < trustDomainRank(floor.trustDomain)) {
      return undefined;
    }
    return floor.trustDomain;
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
    this.assertLedgerGovernsLegs();
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
    this.assertLedgerGovernsLegs();
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

  /**
   * Refuse to sync when a leg holds routed copies governed by a DIFFERENT
   * ledger (the set ledger was lost or replaced): treating those copies as
   * legacy would make superseded copies visible again.
   */
  private assertLedgerGovernsLegs(): void {
    const ledgerId = this.ledger.ledgerId();
    for (const domain of TIER_DOMAIN_ORDER) {
      const store = this.store(domain);
      const binding = store?.tierSetBinding();
      if (store && binding && binding.ledgerId !== ledgerId) throw new TierLedgerUnavailableError(store.corpusId);
    }
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

  /**
   * @internal Whether a routed item's current copies have all vanished from
   * their stores (a lane evicted them on its own). Only then may a new
   * placement replace the ledger rows without a move.
   */
  routedCopiesGone(identity: SourceItemIdentity): boolean {
    const current = this.ledger.copies(identity).filter((copy) => copy.state === 'current');
    if (current.length === 0) return false;
    return current.every((copy) => {
      const domain = this.domainForCorpus(copy.corpusId);
      const store = domain ? this.store(domain) : undefined;
      return store !== undefined && !store.itemPresence(identity).active;
    });
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

/** One leg of `createTieredLaneSet`: an open store, or one created on first need. */
export interface TieredLaneLeg {
  store?: LocalConnectorStore;
  onDemand?: OnDemandTierStore;
  /** One of the lane's pre-P1b stores: only these take the lane's own (legacy) placement. */
  legacy?: boolean;
  embeddingProvider?: SourceEmbeddingProvider;
  restingTier?: SourceTrustTier;
}

export interface TieredLaneSetOptions {
  setId: string;
  legs: Partial<Record<SourceTrustDomain, TieredLaneLeg>> & { secure_local: TieredLaneLeg };
  splitLayers?: boolean;
  tierClassification?: ConnectorStoreTierClassification;
  secretLocations?: SecretLocationsIndex;
  /**
   * Default: the ledger co-located with the secure_local store's path (its own
   * ledger when it is open), even when that store is not created yet, so the
   * data lifecycle finds the set ledger wherever it finds the secure store.
   */
  ledger?: TierLedger;
  onLegOpened?: (store: LocalConnectorStore, leg: TieredStoreLegSpec) => void;
  laneFloor?: TieredLaneFloor;
  contentArrivesLater?: boolean;
}

/**
 * A lane's set where any leg, the secure one included, may be created on first
 * need: for a lane whose existing store is its only one (Readwise and X keep an
 * internal store, WhatsApp and Dropbox a secure one).
 */
export function createTieredLaneSet(options: TieredLaneSetOptions): TieredStoreSet {
  const secure = options.legs.secure_local;
  const secureDbPath = secure.store?.dbPath ?? secure.onDemand?.dbPath;
  if (!secureDbPath) throw new Error('A tiered lane needs a secure_local store or a way to create one.');
  const ledger = options.ledger
    ?? secure.store?.tierLedger()
    ?? new TierLedgerClass({ dbPath: tieredStoreSetLedgerPath(secureDbPath) });
  const legs: TieredStoreLegSpec[] = [];
  for (const domain of TIER_DOMAIN_ORDER) {
    const leg = options.legs[domain];
    if (!leg) continue;
    const corpusId = leg.store?.corpusId ?? leg.onDemand?.corpusId;
    if (!corpusId) throw new Error(`A tiered lane's ${domain} leg needs a store or a way to create one.`);
    legs.push({
      trustDomain: domain,
      corpusId,
      ...(leg.store ? { store: leg.store } : {}),
      ...(!leg.store && leg.onDemand
        ? { open: () => leg.onDemand!.open(), exists: () => leg.onDemand!.exists() }
        : {}),
      ...(leg.legacy === true ? { legacy: true } : {}),
      ...(leg.embeddingProvider ? { embeddingProvider: leg.embeddingProvider } : {}),
      ...(leg.restingTier ? { restingTier: leg.restingTier } : {}),
    });
  }
  return new TieredStoreSet({
    setId: options.setId,
    ledger,
    legs,
    ...(options.splitLayers === false ? { splitLayers: false } : {}),
    ...(options.tierClassification ? { tierClassification: options.tierClassification } : {}),
    ...(options.secretLocations ? { secretLocations: options.secretLocations } : {}),
    ...(options.onLegOpened ? { onLegOpened: options.onLegOpened } : {}),
    ...(options.laneFloor ? { laneFloor: options.laneFloor } : {}),
    ...(options.contentArrivesLater === true ? { contentArrivesLater: true } : {}),
  });
}

/**
 * Re-home a chat lane's per-item overrides that predate conversation-keyed
 * identities (TierLedger.rehomeConversationlessOverrides), resolving each
 * message's conversation from the lane's stores. Content-free counts only.
 */
export function rehomeChatLaneOverrides(
  ledger: TierLedger,
  provider: string,
  stores: readonly LocalConnectorStore[],
): { rehomed: number; orphaned: number } {
  const result = ledger.rehomeConversationlessOverrides({
    provider,
    conversationsFor: (identity) => stores.flatMap((store) => store.conversationIdsForProviderItem(identity)),
  });
  return { rehomed: result.rehomed, orphaned: result.orphaned.length };
}

/** A tier store a lane creates only when its first item is routed there. */
export interface NewTierLegSpec {
  corpusId: string;
  dbPath: string;
  /** Builds the store bound to the set ledger, so even a standalone open honours it. */
  create: (ledger: TierLedger) => LocalConnectorStore;
  embeddingProvider?: SourceEmbeddingProvider;
}

export interface ExistingStoreTierLane {
  set: TieredStoreSet;
  ledger: TierLedger;
  /** The lane's new stores, by domain: opened at boot when their file exists, else on first need. */
  newStores: Partial<Record<SourceTrustDomain, OnDemandTierStore>>;
}

/**
 * The per-tier stores of a lane that has had exactly ONE store: that store
 * stays the lane's legacy leg (everything stored before per-item routing keeps
 * its placement there, byte-for-byte), and every other tier store is created
 * when a new item is first routed to it. The set ledger sits beside the
 * secure_local store's path, existing or not.
 */
export function createExistingStoreTierLane(options: {
  setId: string;
  store: LocalConnectorStore;
  newLegs: Partial<Record<SourceTrustDomain, NewTierLegSpec>>;
  embeddingProvider?: SourceEmbeddingProvider;
  restingTier?: SourceTrustTier;
  splitLayers?: boolean;
  laneFloor?: TieredLaneFloor;
  contentArrivesLater?: boolean;
  tierClassification?: ConnectorStoreTierClassification;
  secretLocations?: SecretLocationsIndex;
  onStoreOpened?: (store: LocalConnectorStore) => void;
}): ExistingStoreTierLane {
  if (options.newLegs[options.store.trustDomain]) {
    throw new Error('A lane\'s existing store and a new tier store cannot share a trust domain.');
  }
  const secureDbPath = options.store.trustDomain === 'secure_local'
    ? options.store.dbPath
    : options.newLegs.secure_local?.dbPath;
  if (!secureDbPath) throw new Error('A tiered lane needs a secure_local store or a way to create one.');
  const ledger = (options.store.trustDomain === 'secure_local' ? options.store.tierLedger() : undefined)
    ?? new TierLedgerClass({ dbPath: tieredStoreSetLedgerPath(secureDbPath) });
  const newStores: Partial<Record<SourceTrustDomain, OnDemandTierStore>> = {};
  const legs: Partial<Record<SourceTrustDomain, TieredLaneLeg>> = {};
  for (const domain of TIER_DOMAIN_ORDER) {
    if (domain === options.store.trustDomain) {
      legs[domain] = {
        store: options.store,
        legacy: true,
        ...(options.embeddingProvider ? { embeddingProvider: options.embeddingProvider } : {}),
        ...(options.restingTier ? { restingTier: options.restingTier } : {}),
      };
      continue;
    }
    const spec = options.newLegs[domain];
    if (!spec) continue;
    const onDemand = onDemandTierStore({
      corpusId: spec.corpusId,
      dbPath: spec.dbPath,
      create: () => spec.create(ledger),
      ...(options.onStoreOpened ? { onOpened: options.onStoreOpened } : {}),
    });
    newStores[domain] = onDemand;
    legs[domain] = {
      onDemand,
      ...(spec.embeddingProvider ? { embeddingProvider: spec.embeddingProvider } : {}),
    };
  }
  const set = createTieredLaneSet({
    setId: options.setId,
    ledger,
    legs: legs as TieredLaneSetOptions['legs'],
    ...(options.splitLayers === false ? { splitLayers: false } : {}),
    ...(options.laneFloor ? { laneFloor: options.laneFloor } : {}),
    ...(options.contentArrivesLater === true ? { contentArrivesLater: true } : {}),
    ...(options.tierClassification ? { tierClassification: options.tierClassification } : {}),
    ...(options.secretLocations ? { secretLocations: options.secretLocations } : {}),
  });
  return { set, ledger, newStores };
}

/**
 * A per-tier store whose file is created only when its first item is routed
 * there: opened once, on demand or at boot when the file already exists.
 */
export interface OnDemandTierStore {
  readonly corpusId: string;
  readonly dbPath: string;
  open(): LocalConnectorStore;
  exists(): boolean;
  /** The open store, when it has been opened. Never creates one. */
  current(): LocalConnectorStore | undefined;
}

export function onDemandTierStore(options: {
  create: () => LocalConnectorStore;
  corpusId: string;
  dbPath: string;
  /** Told once, when the store opens (a runtime registers it for reads). */
  onOpened?: (store: LocalConnectorStore) => void;
}): OnDemandTierStore {
  let opened: LocalConnectorStore | undefined;
  return {
    corpusId: options.corpusId,
    dbPath: options.dbPath,
    open() {
      if (opened) return opened;
      const store = options.create();
      if (store.corpusId !== options.corpusId) {
        store.close();
        throw new Error('An on-demand tier store opened with the wrong corpus.');
      }
      opened = store;
      options.onOpened?.(store);
      return store;
    },
    exists: () => opened !== undefined || (options.dbPath !== ':memory:' && existsSync(options.dbPath)),
    current: () => opened,
  };
}

/**
 * One lane summary from a shared-traversal run: the listing-level facts
 * (items seen, cursor, completion, exclusions) from the lane's own store, and
 * what every tier store WROTE, summed. A run whose only leg is the lane's own
 * store yields exactly that store's summary. The embed summary is the lane
 * store's identity with every leg's chunk counts summed (zeros when no leg
 * embedded).
 */
export function mergedTieredLaneRun(
  run: TieredStoreSetRun,
  primary: SourceTrustDomain,
): { sync: ConnectorStoreSyncSummary; embed?: ConnectorStoreEmbedSummary } {
  const lane = run.byDomain[primary];
  if (!lane) throw new Error(`The lane's ${primary} store did not run.`);
  const legs = run.legs;
  const sum = (pick: (sync: ConnectorStoreSyncSummary) => number | undefined): number =>
    legs.reduce((total, leg) => total + (pick(leg.sync) ?? 0), 0);
  const optionalSum = (pick: (sync: ConnectorStoreSyncSummary) => number | undefined): number | undefined =>
    legs.some((leg) => pick(leg.sync) !== undefined) ? sum(pick) : undefined;
  const deferred = [...new Set(legs.flatMap((leg) => leg.sync.windowRemovalsDeferredLocalItemIds ?? []))];
  const absence = optionalSum((sync) => sync.absenceItemsTombstoned);
  const window = optionalSum((sync) => sync.windowRemovedItemsTombstoned);
  const deleted = optionalSum((sync) => sync.deletedEventItemsTombstoned);
  const secrets = optionalSum((sync) => sync.secretsTierItemsTombstoned);
  const demoted = optionalSum((sync) => sync.itemsDemoted);
  const sync: ConnectorStoreSyncSummary = {
    ...lane.sync,
    itemsIndexed: sum((leg) => leg.itemsIndexed),
    itemsChanged: sum((leg) => leg.itemsChanged),
    itemsTombstoned: sum((leg) => leg.itemsTombstoned),
    itemsRejected: sum((leg) => leg.itemsRejected),
    chunksIndexed: sum((leg) => leg.chunksIndexed),
    ...(absence !== undefined ? { absenceItemsTombstoned: absence } : {}),
    ...(window !== undefined ? { windowRemovedItemsTombstoned: window } : {}),
    ...(deleted !== undefined ? { deletedEventItemsTombstoned: deleted } : {}),
    ...(secrets !== undefined ? { secretsTierItemsTombstoned: secrets } : {}),
    ...(demoted !== undefined ? { itemsDemoted: demoted } : {}),
    ...(lane.sync.windowRemovalsDeferredLocalItemIds !== undefined || deferred.length > 0
      ? { windowRemovalsDeferredLocalItemIds: deferred }
      : {}),
    gaps: [...new Set(legs.flatMap((leg) => leg.sync.gaps))],
  };
  const embedded = legs.filter((leg) => leg.embed !== undefined);
  if (embedded.length === 0) return { sync };
  const base = lane.embed ?? embedded[0]!.embed!;
  return {
    sync,
    embed: {
      ...base,
      chunksSeen: embedded.reduce((total, leg) => total + leg.embed!.chunksSeen, 0),
      chunksEmbedded: embedded.reduce((total, leg) => total + leg.embed!.chunksEmbedded, 0),
      chunksSkipped: embedded.reduce((total, leg) => total + leg.embed!.chunksSkipped, 0),
    },
  };
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
    // Legacy first: an item any store already holds a row for, that this
    // set's ledger never routed, is the lane's — whatever else the ledger
    // says about other items.
    const hasRow = this.set.anyLegHasRow(identity);
    const routed = ledger.isRouted(identity);
    if (item.metadata['deleted'] === true) {
      this.set.secrets()?.remove(identity);
      if (!routed) {
        this.counts.itemsLegacy += 1;
        return { kind: 'legacy' };
      }
      this.counts.routedDeletions += 1;
      this.copyRemovals.set(identityKey(identity), identity);
      return { kind: 'delete', corpora: new Set(ledger.copies(identity).map((copy) => copy.corpusId)), reason: 'provider_deleted' };
    }

    // A lane whose text arrives later reads none at listing; an owner
    // metadata-only disposition means none ever arrives.
    const deferred = this.set.readsContentLater();
    const text = deferred && input.metadataOnly ? undefined : connectorStoreItemText(item);
    let decision = decideItemTiers(connector, item, text, this.set.classification(), ledger);
    this.recordSecretLocation(input, text, decision);
    const contentRead = decision.contentRead && !input.contentFetchFailed;
    if (!routed) {
      // Only a NEW item is routed. In P1b lanes it must also be judged from
      // text actually read; metadata-only dispositions and unread content keep
      // the lane's placement. A lane whose text arrives later routes a new
      // item by its names now and its content when the text lands.
      if (hasRow || (!deferred && (!contentRead || input.metadataOnly))) {
        this.counts.itemsLegacy += 1;
        return { kind: 'legacy' };
      }
    } else if (!contentRead) {
      if (!deferred) {
        // A routed item seen without its text: nothing proves its content
        // tier, so its copies are left exactly as they are.
        this.counts.contentUnreadHeld += 1;
        return { kind: 'hold', reason: 'content_unread' };
      }
      // Re-listed without text in a lane whose text arrives later: the names
      // are judged afresh, the content half stays what its text decided.
      decision = withRecordedContent(decision, ledger.getCurrent(identity));
    }

    const placement = this.set.placementFor(decision);
    const recorded = ledger.recordRoutedPlacement(identity, decision, placement, {
      staleCopiesGone: routed && this.set.routedCopiesGone(identity),
      ...(deferred ? { stagedLandingAllowed: true } : {}),
    });
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
          // Bind the store to this set's ledger before its first routed copy
          // lands: from then on no handle may read it without that ledger.
          this.set.store(copy.trustDomain, { create: true })!.bindTierSet(ledger);
          copies.set(copy.corpusId, copy.layers);
          sensitivity.set(copy.corpusId, buildSourceSensitivity({
            trustTier: this.set.restingTierFor(copy.trustDomain),
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

  private recordSecretLocation(input: ConnectorStoreTierRouteInput, text: string | undefined, decision: TierDecision): void {
    const index = this.set.secrets();
    if (!index) return;
    const item = input.item;
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
    let folderKeys: readonly string[] = input.sourceScope?.folderKeys ?? [];
    if (folderKeys.length === 0) {
      try {
        folderKeys = input.connector.classificationSignals(item).folderKeys ?? [];
      } catch {
        folderKeys = [];
      }
    }
    // Names are released only when the item's METADATA tier is below Private.
    // A Private-metadata item is located by an opaque reference instead.
    const namesReleasable = decision.metadataTier === 'public' || decision.metadataTier === 'private';
    index.record({
      identity: item.identity,
      ...(locator ? { locator } : {}),
      ...(title && namesReleasable ? { title } : {}),
      namesReleasable,
      folderKeys,
      ...(input.sourceScope
        ? { scopeGeneration: input.sourceScope.accountGeneration, scopeRevision: input.sourceScope.scopeRevision }
        : {}),
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

function atLeastDomain(domain: SourceTrustDomain, floor: SourceTrustDomain | undefined): SourceTrustDomain {
  return floor !== undefined && trustDomainRank(floor) > trustDomainRank(domain) ? floor : domain;
}

/**
 * A listing-time decision (names only) completed with the content half the
 * ledger already holds from text read earlier, so re-listing an item never
 * forgets or lowers a content tier that was decided from its text.
 */
export function withRecordedContent(
  decision: TierDecision,
  record: Pick<TierLedgerRecordLike, 'contentRead' | 'contentTier' | 'contentPending' | 'decidedBy' | 'reasons'> | undefined,
): TierDecision {
  if (decision.contentRead || !record?.contentRead) return decision;
  const contentPending = record.contentPending;
  return {
    ...decision,
    contentTier: maxTier(record.contentTier, decision.metadataTier),
    contentRead: true,
    contentPending,
    decidedBy: record.decidedBy as TierDecidedBy,
    reasons: [
      ...decision.reasons.filter((reason) => !reason.startsWith('content:')),
      ...record.reasons.filter((reason) => reason.startsWith('content:')),
    ],
    state: decision.metadataPending || contentPending ? 'pending' : 'current',
  };
}

interface TierLedgerRecordLike {
  contentRead: boolean;
  contentTier: TierKey;
  contentPending: boolean;
  decidedBy: string;
  reasons: string[];
}

function identityKey(identity: Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId' | 'providerConversationId'>): string {
  return tierLedgerIdentityKey(identity);
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
