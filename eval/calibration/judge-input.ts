// What the production classifier would ask the private judge about one item.
// Shared by the message sampler and the judge runner, so both read the same path.

import type { SourceClassificationSignals } from '../../src/core/contracts.ts';
import { classifyItemTiers, type TierSniffer } from '../../src/workers/classification/tier-classifier.ts';

export interface JudgeInput {
  /** The judge's input. Absent when production would not ask the judge. */
  material?: string;
  secret: boolean;
  /** The classifier's own answer without the judge: a structured identifier is Private at once. */
  privateWithoutJudge: boolean;
}

export function judgeInput(signals: SourceClassificationSignals, text: string, provider: string): JudgeInput {
  let material: string | undefined;
  const sniffer: TierSniffer = {
    id: 'calibration-recorder',
    judge(request) {
      if (request.pass === 'content') material = request.material;
      return { verdict: 'undecided' };
    },
  };
  const decision = classifyItemTiers({ signals, provider, text }, { sniffer, retirePublic: true });
  const secret = decision.metadataTier === 'secrets' || decision.contentTier === 'secrets';
  return {
    ...(secret || material === undefined ? {} : { material }),
    secret,
    privateWithoutJudge: decision.contentTier === 'secure',
  };
}
