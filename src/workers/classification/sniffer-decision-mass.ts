// Shared one-token decision maths. No item text.

/**
 * The P(Private) bar of a decision judge with no measured bar of its own
 * (snifferDecisionBar in sniffer.ts picks each lane's). Every judge leans
 * Private (owner, 2026-11-10, #1184): a bar is never above this even chance.
 * A bar change re-tiers stored verdicts on read; bump SNIFFER_DECISION_VERSION
 * only when the floor or decoder changes.
 */
export const SNIFFER_DECISION_PRIVATE_BAR = 0.5;
export const SNIFFER_DECISION_MIN_COVERAGE = 0.9;

export interface TokenChance {
  token: string;
  logprob: number;
}

export interface TierMass {
  private: number;
  personal: number;
  /** Mass on a token that could start either word: it decides nothing. */
  ambiguous: number;
}

/** The probability mass on each word, from the top tokens at the point where the two diverge. */
export function tierMass(tokens: readonly TokenChance[], alreadyWritten = ''): TierMass {
  const left = (word: string) => word.slice(alreadyWritten.length);
  const starts = (token: string, word: string) => {
    const rest = left(word);
    return word.startsWith(alreadyWritten) && rest.length > 0 && token.length > 0
      && (rest.startsWith(token) || token.startsWith(rest + '"'));
  };
  const mass: TierMass = { private: 0, personal: 0, ambiguous: 0 };
  for (const { token, logprob } of tokens) {
    if (!Number.isFinite(logprob) || logprob > 0) continue;
    const isPrivate = starts(token, 'private');
    const isPersonal = starts(token, 'personal');
    const chance = Math.exp(logprob);
    if (isPrivate && isPersonal) mass.ambiguous += chance;
    else if (isPrivate) mass.private += chance;
    else if (isPersonal) mass.personal += chance;
  }
  return mass;
}

/** Relative Private token mass, only with adequate coverage and a non-ambiguous vote. */
export function privateChance(mass: TierMass): number | undefined {
  const coverage = mass.private + mass.personal + mass.ambiguous;
  if (![mass.private, mass.personal, mass.ambiguous].every(value => Number.isFinite(value) && value >= 0)
    || coverage + Number.EPSILON < SNIFFER_DECISION_MIN_COVERAGE) return undefined;
  const total = mass.private + mass.personal;
  return total > 0 ? mass.private / total : undefined;
}

