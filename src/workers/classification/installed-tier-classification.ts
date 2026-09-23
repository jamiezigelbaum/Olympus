// The owner's installed classification inputs, for every lane at once
// (design section 2.2): the sensitivity map, the owner tier rules
// (tier-rules.ts) and the privacy-safe sniffer.
//
// Before this, only the lanes that passed a map explicitly recorded decisions
// with it. The worker process configures this once at boot; the connector
// store then uses it for any sync that does not bring its own classification
// inputs, so every lane records with the same map, the same rules and the
// same sniffer. Nothing here is per source.
//
// Unconfigured (tests, one-off scripts), it is absent and stores behave
// exactly as before.
//
// Fail-safe: an INVALID rules file or map (unparseable, half-written, changed
// mid-read, or writable by anyone but its owner) never falls back to "no
// rules" or "no map" — that would record the owner's Private folders and
// categories as Personal. The inputs come back with `unavailableReason` and
// the LAST GOOD rules and map: a tiered store set holds every new decision
// pending (Private, embedding held) and a plain store records none, until the
// file is fixed.

import { ownerConfigStamp } from '../../core/owner-config-read.ts';
import {
  readOwnerSensitivityMap,
  resolveSensitivityMapPath,
  type SensitivityMap,
} from '../../core/sensitivity-map.ts';
import { CachedTierSniffer, type SnifferLaneIdentity } from './sniffer.ts';
import { TierSnifferStore } from './sniffer-store.ts';
import { tierSnifferPathForLedger } from './tier-ledger-path.ts';
import {
  registerInstalledTierClassification,
  type InstalledStoreTierClassification,
  type InstalledTierClassificationProvider,
} from './installed-tier-classification-registry.ts';

export type { InstalledStoreTierClassification };
import type { OwnerTierRule, TierSniffer } from './tier-classifier.ts';
import { loadOwnerTierRules, tierRulesFileStamp } from './tier-rules.ts';


export interface InstalledTierClassificationOptions {
  env?: Record<string, string | undefined>;
  /** The resolved privacy-safe lane. Absent: no sniffer; flagged items stay pending. */
  lane?: SnifferLaneIdentity;
  now?: () => Date;
}

export class InstalledTierClassification implements InstalledTierClassificationProvider {
  readonly lane: SnifferLaneIdentity | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly now: (() => Date) | undefined;
  private readonly snifferStores = new Map<string, TierSnifferStore>();
  private mapStamp: string | undefined;
  /** The last map that read cleanly. */
  private map: SensitivityMap | undefined;
  private mapInvalid = false;
  private rulesStamp: string | undefined;
  /** The last rules that read cleanly. */
  private rules: OwnerTierRule[] = [];
  private rulesInvalid = false;

  constructor(options: InstalledTierClassificationOptions = {}) {
    this.env = options.env ?? process.env;
    this.lane = options.lane;
    this.now = options.now;
  }

  /**
   * Classification inputs for decisions recorded in one tier ledger (a
   * store's own, or a tiered store set's). The sniffer's cache and queue sit
   * beside that ledger. Never throws.
   */
  forLedger(ledgerPath: string): InstalledStoreTierClassification {
    const rules = this.currentRules();
    const sensitivityMap = this.currentMap();
    const unavailableReason = this.rulesInvalid
      ? 'tier_rules_invalid'
      : this.mapInvalid ? 'sensitivity_map_invalid' : undefined;
    let sniffer: TierSniffer | undefined;
    if (this.lane && ledgerPath !== ':memory:') {
      try {
        sniffer = new CachedTierSniffer(this.snifferStoreForLedger(ledgerPath), this.lane);
      } catch {
        // No sniffer store: flagged items stay pending (held Private).
      }
    }
    return {
      ...(sensitivityMap ? { sensitivityMap } : {}),
      ...(rules.length > 0 ? { rules } : {}),
      ...(sniffer ? { sniffer } : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  }

  /** The sniffer cache and queue beside a tier ledger (opened once per process). */
  snifferStoreForLedger(ledgerPath: string): TierSnifferStore {
    const path = tierSnifferPathForLedger(ledgerPath);
    let store = this.snifferStores.get(path);
    if (!store) {
      store = new TierSnifferStore({ dbPath: path, ...(this.now ? { now: this.now } : {}) });
      this.snifferStores.set(path, store);
    }
    return store;
  }

  close(): void {
    for (const store of this.snifferStores.values()) {
      try {
        store.close();
      } catch {
        // Closing is best effort at shutdown.
      }
    }
    this.snifferStores.clear();
  }

  /**
   * The last good map, re-read (through the one owner-map loader) only when
   * the file's stamp changes, so every lane sees an edit at its next pass.
   * An unusable file keeps the last good map and marks the inputs invalid; a
   * torn read is retried at the next call because its stamp is not kept.
   */
  private currentMap(): SensitivityMap | undefined {
    const stamp = ownerConfigStamp(resolveSensitivityMapPath({ env: this.env }));
    if (stamp !== this.mapStamp) {
      const read = readOwnerSensitivityMap(this.env);
      if (read.status === 'ok') {
        this.map = read.map;
        this.mapInvalid = false;
        this.mapStamp = read.stamp;
      } else if (read.status === 'missing') {
        this.map = undefined;
        this.mapInvalid = false;
        this.mapStamp = stamp;
      } else {
        this.mapInvalid = true;
        this.mapStamp = read.reason === 'torn_read' ? undefined : stamp;
      }
    }
    return this.map;
  }

  /** The last good rules, reloaded when the file changes; an unusable file marks the inputs invalid. */
  private currentRules(): OwnerTierRule[] {
    const stamp = tierRulesFileStamp({ env: this.env });
    if (stamp !== this.rulesStamp) {
      try {
        this.rules = loadOwnerTierRules({ env: this.env, allowMissing: true });
        this.rulesInvalid = false;
        this.rulesStamp = stamp;
      } catch {
        this.rulesInvalid = true;
        // Not kept: a torn or mid-edit read is retried at the next call.
        this.rulesStamp = undefined;
      }
    }
    return this.rules;
  }
}

let installed: InstalledTierClassification | undefined;

/** Configure the process-wide inputs (worker boot). Replaces and closes any previous one. */
export function configureInstalledTierClassification(options: InstalledTierClassificationOptions = {}): InstalledTierClassification {
  installed?.close();
  installed = new InstalledTierClassification(options);
  registerInstalledTierClassification(installed);
  return installed;
}

export function installedTierClassification(): InstalledTierClassification | undefined {
  return installed;
}

export function clearInstalledTierClassification(): void {
  registerInstalledTierClassification(undefined);
  installed?.close();
  installed = undefined;
}

