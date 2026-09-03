// Classification policy from the environment (frontier-max doctrine).
//
// Tuneability is a hard requirement: The owner tunes the scorer's aggressiveness,
// the always-sensitive sender list, and whether the model scorer lane is
// enabled at all WITHOUT code changes. Env vars:
//
//   OLYMPUS_CLASSIFY_SCORER_MODE      conservative | balanced | aggressive
//                                     (maps to the internal-verdict confidence
//                                     threshold 0.9 / 0.7 / 0.5)
//   OLYMPUS_EMAIL_SENSITIVE_SENDERS   comma-separated sender substrings that
//                                     are ALWAYS sensitive (detector-ranked,
//                                     never overridable by clean rules or the
//                                     scorer)
//   OLYMPUS_CLASSIFY_SCORER_ENABLED   1/true/yes/on enables the model scorer
//                                     review lane; anything else keeps it off
//                                     (deterministic classification still runs)

import type { ScorerAggressiveness } from './delphi-scorer.ts';

export interface ClassificationPolicy {
  scorerEnabled: boolean;
  scorerMode?: ScorerAggressiveness;
  sensitiveSenders: string[];
}

export function parseClassificationPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): ClassificationPolicy {
  const modeRaw = env.OLYMPUS_CLASSIFY_SCORER_MODE?.trim().toLowerCase();
  const scorerMode = modeRaw === 'conservative' || modeRaw === 'balanced' || modeRaw === 'aggressive'
    ? modeRaw
    : undefined;

  const sensitiveSenders = (env.OLYMPUS_EMAIL_SENSITIVE_SENDERS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const enabledRaw = env.OLYMPUS_CLASSIFY_SCORER_ENABLED?.trim().toLowerCase();
  const scorerEnabled = enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'yes' || enabledRaw === 'on';

  return {
    scorerEnabled,
    ...(scorerMode ? { scorerMode } : {}),
    sensitiveSenders,
  };
}
