// Which model the privacy-safe sniffer may use (design section 2.2 and owner
// decision 1 in section 8): a LOCAL model where the preset has one, otherwise
// Venice Private. Never an ordinary cloud model: possibly-private material
// cannot be sent to one to find out whether it is private.
//
// Selection, from the active sovereignty policy:
// 1. a model profile declared with `purpose: "classification"` (a small, fast
//    model the owner chose for this job), local before Venice;
// 2. otherwise the secure_local analyst pool (the private pool Argus answers
//    from), local members before Venice members.
// Anything else is refused with SnifferLaneRefusedError BEFORE any dispatch,
// and `assertSnifferProfileAllowed` re-checks the profile at every dispatch.

import { OperationError } from '../../core/operation-error.ts';
import type {
  SovereigntyEngine,
  SovereigntyModelProfile,
  SovereigntyResolvedProfile,
} from '../../core/sovereignty.ts';
import type { SnifferLaneIdentity, SnifferLaneKind } from './sniffer.ts';

export type SnifferLaneRefusalReason = 'standard_cloud' | 'unsupported_provider' | 'no_private_lane';

export class SnifferLaneRefusedError extends OperationError {
  readonly reason: SnifferLaneRefusalReason;
  readonly profileId: string | undefined;

  constructor(reason: SnifferLaneRefusalReason, profileId?: string) {
    super(
      'source_index_policy_violation',
      reason === 'standard_cloud'
        ? `The privacy sniffer refuses model profile "${profileId}": it is a standard cloud model.`
        : reason === 'unsupported_provider'
          ? `The privacy sniffer refuses model profile "${profileId}": only a local model or Venice Private may read possibly-private names.`
          : 'No private model lane is configured for the privacy sniffer.',
      'Configure a local model, or Venice Private, in the secure_local pool of sovereignty.json (or a profile with purpose "classification"). Until then, flagged items stay pending and held Private.',
    );
    this.name = 'SnifferLaneRefusedError';
    this.reason = reason;
    this.profileId = profileId;
  }
}

export interface SnifferLane extends SnifferLaneIdentity {
  profileId: string;
  profile: SovereigntyModelProfile;
}

/** Throws SnifferLaneRefusedError unless the profile is a local model or Venice Private. */
export function assertSnifferProfileAllowed(profileId: string, profile: SovereigntyModelProfile): SnifferLaneKind {
  if (profile.trust === 'standard_cloud') throw new SnifferLaneRefusedError('standard_cloud', profileId);
  if (profile.provider === 'local-openai-compatible' && profile.trust === 'local') return 'local';
  if (profile.provider === 'venice' && profile.trust === 'encrypted_cloud') return 'venice';
  throw new SnifferLaneRefusedError('unsupported_provider', profileId);
}

export function resolveSnifferLane(
  engine: Pick<SovereigntyEngine, 'config' | 'resolveAnalystPool'>,
): SnifferLane {
  const declared: SovereigntyResolvedProfile[] = Object.entries(engine.config.modelProfiles)
    .filter(([, profile]) => profile.purpose === 'classification')
    .map(([id, profile]) => ({ id, profile }));
  if (declared.length > 0) return pickLane(declared);

  let pool: SovereigntyResolvedProfile[];
  try {
    const resolved = engine.resolveAnalystPool({ trustDomain: 'secure_local' });
    pool = resolved.explicitOrder ?? resolved.members;
  } catch {
    throw new SnifferLaneRefusedError('no_private_lane');
  }
  if (pool.length === 0) throw new SnifferLaneRefusedError('no_private_lane');
  return pickLane(pool);
}

/**
 * Local first, then Venice. A standard-cloud candidate is refused outright,
 * even when an acceptable one is also listed: a policy that names a cloud
 * model for this job is a misconfiguration the owner should see.
 */
function pickLane(candidates: readonly SovereigntyResolvedProfile[]): SnifferLane {
  const allowed: SnifferLane[] = [];
  let firstRefusal: SnifferLaneRefusedError | undefined;
  for (const candidate of candidates) {
    try {
      const kind = assertSnifferProfileAllowed(candidate.id, candidate.profile);
      const modelId = 'model' in candidate.profile && candidate.profile.model ? candidate.profile.model : candidate.id;
      allowed.push({ kind, modelId, profileId: candidate.id, profile: candidate.profile });
    } catch (error) {
      if (!(error instanceof SnifferLaneRefusedError)) throw error;
      if (error.reason === 'standard_cloud') throw error;
      firstRefusal ??= error;
    }
  }
  const lane = allowed.find((candidate) => candidate.kind === 'local') ?? allowed[0];
  if (lane) return lane;
  throw firstRefusal ?? new SnifferLaneRefusedError('no_private_lane');
}
