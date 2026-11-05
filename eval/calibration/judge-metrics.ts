// Scoring for the judge runner: the owner's labels against the judge's answers.
// Pure functions, no item text.

export type Tier = 'personal' | 'private';

export interface ScoredRow {
  id: string;
  owner: Tier;
  judge: Tier;
  /** The file or message source. */
  source: string;
  /** Round 2's sampling stratum, when it has one. */
  stratum?: string;
  split: 'dev' | 'test';
  /** What a row counts for: 1 unweighted, its stratum's share when reweighted. */
  weight?: number;
}

export interface Confusion {
  items: number;
  privateKeptPrivate: number;
  /** The harmful miss: the owner's Private that the judge let through as Personal. */
  privateToPersonal: number;
  personalKeptPersonal: number;
  /** The outage: the owner's Personal that the judge hid as Private. */
  personalToPrivate: number;
  privateRecall: number | null;
  personalRecall: number | null;
  balancedAccuracy: number | null;
}

export function confusion(rows: readonly ScoredRow[]): Confusion {
  const sum = (owner: Tier, judge: Tier) => rows
    .filter((row) => row.owner === owner && row.judge === judge)
    .reduce((total, row) => total + (row.weight ?? 1), 0);
  const privateKeptPrivate = sum('private', 'private');
  const privateToPersonal = sum('private', 'personal');
  const personalKeptPersonal = sum('personal', 'personal');
  const personalToPrivate = sum('personal', 'private');
  const share = (hit: number, miss: number) => (hit + miss === 0 ? null : hit / (hit + miss));
  const privateRecall = share(privateKeptPrivate, privateToPersonal);
  const personalRecall = share(personalKeptPersonal, personalToPrivate);
  return {
    items: rows.length,
    privateKeptPrivate,
    privateToPersonal,
    personalKeptPersonal,
    personalToPrivate,
    privateRecall,
    personalRecall,
    balancedAccuracy: privateRecall === null || personalRecall === null ? null : (privateRecall + personalRecall) / 2,
  };
}

export function groupedConfusion(rows: readonly ScoredRow[], key: (row: ScoredRow) => string): Record<string, Confusion> {
  const groups = new Map<string, ScoredRow[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return Object.fromEntries([...groups.entries()].sort().map(([name, members]) => [name, confusion(members)]));
}

/** A source's stratum sizes at sampling: stratum name to the items it held. */
export type StratumSizes = Readonly<Record<string, Readonly<Record<string, number>>>>;

/**
 * Rows weighted back to the natural mix: each row stands for its stratum's
 * population divided by the rows labeled from that stratum. A row with no
 * recorded stratum size is dropped, so a gap never passes as a measurement.
 */
export function reweighted(rows: readonly ScoredRow[], sizes: StratumSizes): ScoredRow[] {
  const cell = (row: ScoredRow) => `${row.source}\u0000${row.stratum ?? ''}`;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(cell(row), (counts.get(cell(row)) ?? 0) + 1);
  return rows.flatMap((row) => {
    const size = row.stratum ? sizes[row.source]?.[row.stratum] : undefined;
    return size === undefined ? [] : [{ ...row, weight: size / counts.get(cell(row))! }];
  });
}

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

export function medianAndRange(values: readonly number[]): { median: number; min: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}
