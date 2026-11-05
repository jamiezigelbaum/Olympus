// Shared one-token decision maths. No item text.

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
  const starts = (token: string, word: string) => token.length > 0 && (left(word).startsWith(token) || token.startsWith(left(word)));
  const mass: TierMass = { private: 0, personal: 0, ambiguous: 0 };
  for (const { token, logprob } of tokens) {
    const isPrivate = starts(token, 'private');
    const isPersonal = starts(token, 'personal');
    const chance = Math.exp(logprob);
    if (isPrivate && isPersonal) mass.ambiguous += chance;
    else if (isPrivate) mass.private += chance;
    else if (isPersonal) mass.personal += chance;
  }
  return mass;
}

/** P(Private), or undefined when the model put no mass on either word. */
export function privateChance(mass: TierMass): number | undefined {
  const total = mass.private + mass.personal;
  return total > 0 ? mass.private / total : undefined;
}

