// What the production classifier would ask the private judge about one item.
// Shared by the message sampler and the judge runner, so both read the same path.

import type { SourceClassificationSignals } from '../../src/core/contracts.ts';
import { classifyItemTiers, type TierSniffer } from '../../src/workers/classification/tier-classifier.ts';

export interface JudgeInput {
  /** The judge's input. Absent when production would not ask the judge. */
  material?: string;
  /** The hash production files this input's verdict under. */
  materialHash?: string;
  secret: boolean;
  /** The classifier's own answer without the judge: a structured identifier is Private at once. */
  privateWithoutJudge: boolean;
  /** The question's flags, which production passes to `snifferVerdictTier` (own-record holds). */
  flags: readonly string[];
}

export function judgeInput(signals: SourceClassificationSignals, text: string, provider: string): JudgeInput {
  let material: string | undefined;
  let materialHash: string | undefined;
  let flags: readonly string[] = [];
  const sniffer: TierSniffer = {
    id: 'calibration-recorder',
    judge(request) {
      if (request.pass === 'content') { material = request.material; materialHash = request.materialHash; flags = request.flags ?? []; }
      return { verdict: 'undecided' };
    },
  };
  const decision = classifyItemTiers({ signals, provider, text }, { sniffer, retirePublic: true });
  const secret = decision.metadataTier === 'secrets' || decision.contentTier === 'secrets';
  return {
    ...(secret || material === undefined ? {} : { material, ...(materialHash ? { materialHash } : {}) }),
    secret,
    privateWithoutJudge: decision.contentTier === 'secure',
    flags,
  };
}
