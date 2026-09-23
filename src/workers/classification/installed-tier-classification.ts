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
// Fail-safe: an INVALID rules file does not fall back to "no rules" — that
// would record the owner's "always Private" folders as Personal. It returns
// `unavailableReason`, and the store records no decisions for that run
// (reported as a content-free gap) until the file is fixed.

import { statSync } from 'node:fs';
import {
  loadSensitivityMap,
  resolveSensitivityMapPath,
  type SensitivityMap,
} from '../../core/sensitivity-map.ts';
import { CachedTierSniffer, type SnifferLaneIdentity } from './sniffer.ts';
import { TierSnifferStore } from './sniffer-store.ts';
import { tierSnifferPathForStore } from './tier-ledger-path.ts';
import type { OwnerTierRule, TierSniffer } from './tier-classifier.ts';
import { loadOwnerTierRules, tierRulesFileStamp } from './tier-rules.ts';

export interface InstalledStoreTierClassification {
  sensitivityMap?: SensitivityMap;
  rules?: readonly OwnerTierRule[];
  sniffer?: TierSniffer;
  /** Set when the inputs cannot be trusted (an invalid rules file): record nothing. */
  unavailableReason?: string;
}

export interface InstalledTierClassificationOptions {
  env?: Record<string, string | undefined>;
  /** The resolved privacy-safe lane. Absent: no sniffer; flagged items stay pending. */
  lane?: SnifferLaneIdentity;
  now?: () => Date;
}

export class InstalledTierClassification {
  readonly lane: SnifferLaneIdentity | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly now: (() => Date) | undefined;
  private readonly snifferStores = new Map<string, TierSnifferStore>();
  private mapStamp: string | undefined;
  private map: SensitivityMap | undefined;
  private rulesStamp: string | undefined;
  private rules: OwnerTierRule[] | undefined;
  private rulesError = false;

  constructor(options: InstalledTierClassificationOptions = {}) {
    this.env = options.env ?? process.env;
    this.lane = options.lane;
    this.now = options.now;
  }

  /** Classification inputs for one connector store. Never throws. */
  forStore(storeDbPath: string, laneMap?: SensitivityMap): InstalledStoreTierClassification {
    const rules = this.currentRules();
    if (rules === undefined) return { unavailableReason: 'tier_rules_invalid' };
    const sensitivityMap = laneMap ?? this.currentMap();
    let sniffer: TierSniffer | undefined;
    if (this.lane && storeDbPath !== ':memory:') {
      try {
        sniffer = new CachedTierSniffer(this.snifferStore(storeDbPath), this.lane);
      } catch {
        // No sniffer store: flagged items stay pending (held Private).
      }
    }
    return {
      ...(sensitivityMap ? { sensitivityMap } : {}),
      ...(rules.length > 0 ? { rules } : {}),
      ...(sniffer ? { sniffer } : {}),
    };
  }

  /** The store's sniffer cache and queue (opened once per process). */
  snifferStore(storeDbPath: string): TierSnifferStore {
    const path = tierSnifferPathForStore(storeDbPath);
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

  private currentMap(): SensitivityMap | undefined {
    const stamp = fileStamp(resolveSensitivityMapPath({ env: this.env }));
    if (stamp !== this.mapStamp) {
      this.map = loadSensitivityMap({ env: this.env, allowMissing: true, ignoreInvalid: true });
      this.mapStamp = stamp;
    }
    return this.map;
  }

  /** The current rules, reloaded when the file changes; undefined while the file is invalid. */
  private currentRules(): OwnerTierRule[] | undefined {
    const stamp = tierRulesFileStamp({ env: this.env });
    if (stamp !== this.rulesStamp) {
      this.rulesStamp = stamp;
      try {
        this.rules = loadOwnerTierRules({ env: this.env, allowMissing: true });
        this.rulesError = false;
      } catch {
        this.rules = undefined;
        this.rulesError = true;
      }
    }
    return this.rulesError ? undefined : this.rules;
  }
}

let installed: InstalledTierClassification | undefined;

/** Configure the process-wide inputs (worker boot). Replaces and closes any previous one. */
export function configureInstalledTierClassification(options: InstalledTierClassificationOptions = {}): InstalledTierClassification {
  installed?.close();
  installed = new InstalledTierClassification(options);
  return installed;
}

export function installedTierClassification(): InstalledTierClassification | undefined {
  return installed;
}

export function clearInstalledTierClassification(): void {
  installed?.close();
  installed = undefined;
}

function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}
