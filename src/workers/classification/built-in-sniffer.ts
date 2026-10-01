// Which model the privacy sniffer runs on (owner ruling 2026-10-01): a model
// the owner configured for private data (sniffer-lane.ts) when there is one,
// otherwise the built-in private model (`built_in`, the local model that
// ships with Olympus) when it is present on this machine. With neither,
// flagged items stay pending (held Private, keyword-searchable, not embedded)
// and every unflagged item is Personal at once.
//
// The built-in model is reached only through the AnalystModel interface: the
// worker registers it here when it builds one, so nothing in classification
// depends on how it is installed or served. It runs on this computer, so it
// is a local lane; its identity is fixed, and the owner approves it in the
// classification ledger like any classifier model.

import type { AnalystModel } from '../../core/analyst.ts';
import type { SovereigntyEngine } from '../../core/sovereignty.ts';
import { resolveSnifferLane, SnifferLaneRefusedError, type SnifferLane, type SnifferLaneRefusalReason } from './sniffer-lane.ts';

/** The analyst name and sniffer profile id of the built-in private model. */
export const BUILT_IN_SNIFFER_PROFILE_ID = 'built_in';

/** The built-in private model as the sniffer sees it: a local lane with a fixed identity. */
export const BUILT_IN_SNIFFER_LANE: SnifferLane = Object.freeze({
  kind: 'local',
  modelId: BUILT_IN_SNIFFER_PROFILE_ID,
  profileId: BUILT_IN_SNIFFER_PROFILE_ID,
  profile: Object.freeze({ provider: 'built-in', trust: 'local', model: BUILT_IN_SNIFFER_PROFILE_ID, purpose: 'classification' }),
}) as SnifferLane;

export interface BuiltInPrivateModel {
  /** The local model, called through the one AnalystModel interface. */
  model: AnalystModel;
  /**
   * Whether it can answer now (downloaded and verified). While false the
   * sniffer asks nothing, so a first-time download never counts as a failure
   * against any item.
   */
  available(): boolean;
}

let registered: BuiltInPrivateModel | undefined;

/** The worker registers the built-in private model when this machine has one (undefined clears it). */
export function registerBuiltInPrivateModel(model: BuiltInPrivateModel | undefined): void {
  registered = model;
}

export function registeredBuiltInPrivateModel(): BuiltInPrivateModel | undefined {
  return registered;
}

export type TierSnifferRuntime =
  | { source: 'configured'; lane: SnifferLane }
  | { source: 'built_in'; lane: SnifferLane; builtIn: BuiltInPrivateModel }
  | { source: 'off'; reason: SnifferLaneRefusalReason };

/**
 * The sniffer's lane. A configured private lane wins. A REFUSED configured
 * lane (a cloud model named for this job, a model outside the private
 * policy) is a misconfiguration the owner should see, so it is never papered
 * over with the built-in model; only "no private lane at all" falls back.
 */
export function resolveTierSnifferRuntime(input: {
  engine: Pick<SovereigntyEngine, 'config' | 'resolveAnalystPool'>;
  builtIn?: BuiltInPrivateModel;
}): TierSnifferRuntime {
  try {
    return { source: 'configured', lane: resolveSnifferLane(input.engine) };
  } catch (error) {
    if (!(error instanceof SnifferLaneRefusedError)) throw error;
    if (error.reason === 'no_private_lane' && input.builtIn) {
      return { source: 'built_in', lane: BUILT_IN_SNIFFER_LANE, builtIn: input.builtIn };
    }
    return { source: 'off', reason: error.reason };
  }
}
