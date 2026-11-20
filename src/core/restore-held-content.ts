import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isArchiveCorpusId } from './archive-formats.ts';
import { accountFoldersRoot, accountStorePath, type LayoutEnv } from './olympus-layout.ts';
import { OperationError } from './operation-error.ts';
import { defaultSourceCorpusRegistryConfig } from './source-corpus-registry.ts';
import { declaredConnectorStoreMountPaths, hasFolderLayout, placedRosterStores } from './source-placement.ts';
import { DEFAULT_ACCOUNT_SLOT, readSourceRegistry } from './source-registry.ts';
import { openConnectorStore, openTierLedger, openTierSniffer, restoredConnectorStoreHasBody, storeFileSchemaVersion, type StorageAccount } from './source-storage.ts';
import {
  HELD_UNTIL_JUDGED_REASON, maxTier, personalContentAuthorized,
  TIER_CLASSIFIER_VERSION, TIER_MAP_REVISION, type TierDecision, type TierKey,
} from '../workers/classification/tier-classifier.ts';
import { TIER_LEDGER_SQLITE_STORE_ID } from '../workers/classification/tier-ledger.ts';
import { tierSnifferPathForLedger } from '../workers/classification/tier-ledger-path.ts';
import type { TierSnifferStore } from '../workers/classification/sniffer-store.ts';
import { tierLedgerIsWithin, tierStoreDataRoot } from '../workers/classification/tier-set-binding.ts';
import { installedTierMigrationLaneSpecs, type TierMigrationLaneSpec, type TierMigrationLegSpec } from '../workers/classification/tier-migration-lanes.ts';
import { CONNECTOR_STORE_SQLITE_STORE_ID, type LocalConnectorStore } from '../workers/connector-store/local-index.ts';
import { settleSecretsCopies } from '../workers/connector-store/secrets-disposition.ts';
import { moveRestoredItemToHold, TIER_MOVE_CONNECTOR_ID } from '../workers/connector-store/tier-move.ts';
import { TieredStoreSet, tieredStoreSetLedgerPath, type TieredStoreLegSpec } from '../workers/connector-store/tiered-store-set.ts';
import type { SourceTrustDomain } from './source-index/types.ts';

// Rollback can create a ledger for a Personal store from before it was
// tiered. Start at the schema understood by the original put-back release.
const INITIAL_RESTORED_LEDGER_SCHEMA = 12;

/** Place restored Personal bodies while the previous engine is still stopped. */
export function holdRestoredPersonalContent(env: LayoutEnv): void {
  const specs = installedTierMigrationLaneSpecs(env);
  const roster = placedRosterStores(env);
  const corpusById = new Map(defaultSourceCorpusRegistryConfig().corpora.map(corpus => [corpus.corpusId, corpus]));
  const known = new Set(specs.map(spec => spec.sourceId));
  for (const personal of roster) {
    if (personal.trustDomain !== 'internal') continue;
    const sourceId = corpusById.get(personal.corpusId)!.sourceId;
    if (known.has(sourceId)) continue;
    const secure = roster.find(corpus => corpus.trustDomain === 'secure_local' && corpusById.get(corpus.corpusId)?.sourceId === sourceId);
    if (!secure) continue;
    specs.push({ sourceId, setId: sourceId, legs: { internal: personal, secure_local: secure } });
    known.add(sourceId);
  }

  const mounts = declaredConnectorStoreMountPaths(env).filter(mount => !hasFolderLayout(mount.sourceId));
  const personalMounts = mounts.filter(mount => mount.trustDomain === 'internal' && existsSync(mount.dbPath));
  if (!existsSync(accountFoldersRoot(env)) && personalMounts.length === 0
    && !specs.some(spec => spec.legs.internal && existsSync(spec.legs.internal.dbPath))) return;
  const registry = readSourceRegistry(env);
  const checked = new Set<string>();
  for (const spec of specs) {
    const accounts = registry.accounts.filter(account => account.source_id === spec.sourceId);
    if (!accounts.some(account => account.slot === DEFAULT_ACCOUNT_SLOT && account.state !== 'active')) {
      holdLane({ sourceId: spec.sourceId }, spec);
    }
    for (const account of accounts) {
      if (account.slot === DEFAULT_ACCOUNT_SLOT || account.state !== 'active' || account.layout !== 'folder') continue;
      const legs = Object.fromEntries(legEntries(spec).map(([domain, leg]) => {
        const name = isArchiveCorpusId(leg.corpusId, domain) ? `${leg.family}.${domain}` : domain;
        return [domain, { ...leg, dbPath: accountStorePath(account, name, env) }];
      })) as TierMigrationLaneSpec['legs'];
      holdLane({ sourceId: spec.sourceId, slot: account.slot }, { ...spec, legs });
    }
  }
  for (const personal of personalMounts) {
    if (checked.has(realpathSync(personal.dbPath)) || !restoredConnectorStoreHasBody(personal.dbPath)) continue;
    const destinations = mounts.filter(mount => mount.sourceId === personal.sourceId && mount.trustDomain === 'secure_local');
    if (destinations.length !== 1 || destinations[0]!.dbPath === personal.dbPath) throw missingPrivateStore(personal.corpusId);
    const secure = destinations[0]!;
    const family = corpusById.get(personal.corpusId)?.family ?? 'x-restored';
    holdLane({ sourceId: personal.sourceId }, {
      sourceId: personal.sourceId,
      setId: personal.sourceId,
      legs: { internal: { ...personal, family }, secure_local: { ...secure, family } },
    });
  }
  for (const account of registry.accounts) {
    if (known.has(account.source_id) || account.state !== 'active' || account.layout !== 'folder') continue;
    const path = accountStorePath(account, 'internal', env);
    if (existsSync(path) && !checked.has(realpathSync(path)) && restoredConnectorStoreHasBody(path)) {
      throw missingPrivateStore(account.source_id);
    }
  }

  function holdLane(account: StorageAccount, spec: TierMigrationLaneSpec): void {
    const personal = spec.legs.internal;
    if (!personal || !existsSync(personal.dbPath)) return;
    const path = realpathSync(personal.dbPath);
    if (checked.has(path)) return;
    if (restoredConnectorStoreHasBody(personal.dbPath)) {
      const securePath = spec.legs.secure_local.dbPath;
      if (path === (existsSync(securePath) ? realpathSync(securePath) : resolve(securePath))) throw missingPrivateStore(personal.corpusId);
      if (!tierLedgerIsWithin(tierStoreDataRoot(personal.dbPath), tieredStoreSetLedgerPath(securePath))) throw missingPrivateStore(personal.corpusId);
      holdLaneContent(env, account, spec);
    }
    checked.add(path);
  }
}

function missingPrivateStore(corpusId: string): OperationError {
  return new OperationError('config_error', `No Private store is configured for restored Personal store ${corpusId}.`);
}

function legEntries(spec: TierMigrationLaneSpec): Array<[SourceTrustDomain, TierMigrationLegSpec]> {
  return Object.entries(spec.legs) as Array<[SourceTrustDomain, TierMigrationLegSpec]>;
}

function holdLaneContent(env: LayoutEnv, account: StorageAccount, spec: TierMigrationLaneSpec): void {
  const internal = spec.legs.internal!;
  const ledgerPath = tieredStoreSetLedgerPath(spec.legs.secure_local.dbPath);
  const restoredStoreSchema = storeFileSchemaVersion(internal.dbPath, CONNECTOR_STORE_SQLITE_STORE_ID);
  const ledger = openTierLedger(account, {
    dbPath: ledgerPath,
    restoreSchemaVersion: existsSync(ledgerPath)
      ? storeFileSchemaVersion(ledgerPath, TIER_LEDGER_SQLITE_STORE_ID) : INITIAL_RESTORED_LEDGER_SCHEMA,
  }, env);
  const stores: LocalConnectorStore[] = [];
  let queue: TierSnifferStore | undefined;
  try {
    const snifferPath = tierSnifferPathForLedger(ledgerPath);
    if (existsSync(snifferPath)) queue = openTierSniffer(account, { dbPath: snifferPath, restoreQueue: true }, env);
    const legs = legEntries(spec).map(([trustDomain, leg]): TieredStoreLegSpec => {
      return {
        trustDomain, corpusId: leg.corpusId, exists: () => existsSync(leg.dbPath),
        ...(leg.restingTier ? { restingTier: leg.restingTier } : {}),
        open() {
          const store = openConnectorStore(account, {
            dbPath: leg.dbPath,
            corpusId: leg.corpusId,
            family: leg.family,
            trustDomain,
            tierLedger: ledger,
            restoreSchemaVersion: existsSync(leg.dbPath)
              ? storeFileSchemaVersion(leg.dbPath, CONNECTOR_STORE_SQLITE_STORE_ID) : restoredStoreSchema,
          }, env);
          stores.push(store);
          return store;
        },
      };
    });
    const set = new TieredStoreSet({ setId: spec.setId, ledger, legs, registerWithLedger: false, skipOpeningMaintenance: true,
      ...(spec.splitLayers === false ? { splitLayers: false } : {}),
    });
    const personal = set.store('internal')!;
    const binding = personal.tierSetBinding();
    if (binding && binding.ledgerId !== ledger.ledgerId()) throw new Error('The restored Personal store is bound to a different privacy ledger.');
    placeRestoredBodies(set, personal, queue);
  } finally {
    for (const store of stores.reverse()) store.close();
    queue?.close();
    ledger.close();
  }
}

function placeRestoredBodies(set: TieredStoreSet, personal: LocalConnectorStore, queue: TierSnifferStore | undefined): void {
  const { ledger } = set;
  let afterItemPk: number | undefined;
  do {
    const page = personal.migrationItemsPage(afterItemPk === undefined ? {} : { afterItemPk });
    for (const item of page.items) {
      const { identity } = item;
      const text = item.chunks.map(chunk => chunk.text).join('');
      if (!text.trim()) continue;
      const current = ledger.getCurrent(identity);
      const override = ledger.getOverride(identity);
      const copies = ledger.copies(identity);
      const copy = copies.find(copy => copy.corpusId === personal.corpusId && copy.layers !== 'metadata');
      if (override?.kind !== 'not_secret' && (override?.tier === 'secrets'
        || current?.metadataTier === 'secrets' || current?.contentTier === 'secrets'
        || current?.targetMetadataTier === 'secrets' || current?.targetContentTier === 'secrets')) {
        const record = set.adoptLegacyItem(identity)!;
        const { copies: hidden } = ledger.flipToSecrets(identity, { expectedGeneration: record.generation });
        if (!hidden.some(copy => copy.corpusId === personal.corpusId)) {
          personal.tombstoneCopy(identity, { trustTier: 'S5', connectorId: TIER_MOVE_CONNECTOR_ID });
          personal.durabilityBarrier();
        }
        settleSecretsCopies({
          ledger, identity, copies: hidden, connectorId: TIER_MOVE_CONNECTOR_ID, restoreQueue: true,
          storeFor: corpusId => {
            const domain = set.domainForCorpus(corpusId);
            return domain && set.store(domain);
          },
        });
        continue;
      }
      const resuming = current?.state === 'moving' && copy?.state === 'superseded'
        && copy.supersededByGeneration === current.generation + 1
        && current.reasons.includes(HELD_UNTIL_JUDGED_REASON) && current.contentPending;
      if (current?.routed && !resuming && copy?.state !== 'current') continue;
      const ownerTier = override?.kind === 'tier' ? override.tier : undefined;
      if (current?.state === 'current' && !current.metadataPending
        && (current.contentTier === 'private' || current.contentTier === 'public')
        && (current.metadataTier === 'private' || current.metadataTier === 'public')
        && ownerTier !== 'secure' && (current.decidedBy !== 'override' || ownerTier !== undefined)
        && personalContentAuthorized(current, text, override?.kind === 'not_secret')) continue;
      const record = set.adoptLegacyItem(identity)!;
      const privateCopy = ledger.copies(identity).find(copy => copy.trustDomain === 'secure_local' && copy.state === 'current' && copy.layers !== 'metadata');
      const privateText = privateCopy && set.store('secure_local')?.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('');
      if (privateText && privateText !== text) {
        throw new OperationError('config_error', 'The restored tier stores contain different active bodies for the same item.');
      }
      // The next pass builds a question and a receipt from the held body.
      queue?.deleteItemQuestions(identity);
      const floor = ownerTier === 'secure' ? 'secure' : 'public';
      const decision: TierDecision = {
        metadataTier: heldTier(floor, record.metadataTier, record.targetMetadataTier),
        contentTier: heldTier(floor, record.contentTier, record.targetContentTier),
        decidedBy: 'default',
        reasons: [
          ...record.reasons.filter(reason => !reason.startsWith('content:') && !reason.startsWith('override:')),
          HELD_UNTIL_JUDGED_REASON,
          'content:sniffer:undecided:undecided',
        ],
        state: 'pending',
        contentRead: true,
        metadataPending: record.metadataPending,
        contentPending: true,
        metadataForced: record.metadataForced && record.decidedBy !== 'override',
        metadataFlagged: record.metadataFlagged,
        engineVersion: TIER_CLASSIFIER_VERSION,
        mapRevision: TIER_MAP_REVISION,
        snifferId: 'undecided',
      };
      const pending = resuming ? record : ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision)).record;
      moveRestoredItemToHold({ set, identity, decision, expectedGeneration: pending.generation });
    }
    afterItemPk = page.nextAfterItemPk;
  } while (afterItemPk !== undefined);
}

function heldTier(floor: TierKey, current: TierKey, target: TierKey | null): TierKey {
  const tier = maxTier(floor, maxTier(current, target ?? current));
  return tier === 'secrets' ? 'secure' : tier;
}
