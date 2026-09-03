import type { EvidenceCandidate, EvidencePack } from './contracts.ts';
import { OperationError } from './operation-error.ts';
import type { SourceTrustTier } from './source-index/types.ts';

export type SourceModelPolicyDenialReason =
  | 's5'
  | 'blocked_sensitive'
  | 'blocked_review'
  | 'current_source_policy';

/**
 * Content rejected before model dispatch. The message is deliberately generic:
 * source identity, policy signals, and raw text must not cross the denial path.
 */
export class SourceModelPolicyDeniedError extends OperationError {
  readonly reason: SourceModelPolicyDenialReason;

  constructor(reason: SourceModelPolicyDenialReason = 'current_source_policy') {
    super(
      'config_error',
      reason === 's5'
        ? 'S5 source material is hard-denied and cannot enter model, embedding, or release paths.'
        : 'Source content is excluded from model use under the current source policy.',
      'Keep the item out of model context; only counts-only policy handling is allowed until its current classification permits use.',
    );
    this.name = 'SourceModelPolicyDeniedError';
    this.reason = reason;
  }
}

export function assertModelTrustTierAllowed(trustTier: SourceTrustTier): void {
  if (trustTier === 'S5') {
    throw new SourceModelPolicyDeniedError('s5');
  }
}

export function assertEvidenceCandidateModelEligible(candidate: EvidenceCandidate): void {
  assertModelTrustTierAllowed(candidate.trustTier);
  for (const fact of candidate.facts ?? []) {
    assertModelTrustTierAllowed(fact.sensitivity.trustTier);
  }
}

export function assertEvidencePackModelEligible(pack: EvidencePack): void {
  for (const candidate of pack.candidates) {
    assertEvidenceCandidateModelEligible(candidate);
  }
}
