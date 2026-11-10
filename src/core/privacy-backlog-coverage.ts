/** Global coverage gap, never a claim that a held item matches the question.
 * Only the sniffer's pending-item count enters this note; no item metadata or
 * queue summary, and no time estimate inferred from the computer's speed.
 *
 * `remote` (the default): an agent outside this computer reads no Private
 * store, so an item waiting for its judgment (held in Private) is not found
 * at all. `local`: an agent on this computer reads the Private store, so the
 * item is found by its words but not yet by meaning (its embedding is held
 * until the judgment).
 */
export function privacyBacklogCoverageNote(pendingItems: number | undefined, audience: 'remote' | 'local' = 'remote'): string | undefined {
  if (pendingItems === undefined || !Number.isSafeInteger(pendingItems) || pendingItems <= 0) return undefined;
  const one = pendingItems === 1;
  if (audience === 'local') {
    return `Olympus is still checking ${pendingItems} new item${one ? '' : 's'} for privacy. `
      + `Until then ${one ? 'it is' : 'they are'} found by exact words only, not by meaning. `
      + 'This can take a while on this computer.';
  }
  return `Olympus is still checking ${pendingItems} new item${one ? '' : 's'} for privacy before ${one ? 'it' : 'they'} can be searched. `
    + 'This can take a while on this computer.';
}

/**
 * An answer with `note` added to its "Coverage notes" block (the block
 * composeReleasedAnswer writes), or a new block when it has none.
 */
export function withCoverageNote(answer: string, note: string | undefined): string {
  if (!note) return answer;
  if (/\n\nCoverage notes:\n(- [^\n]*\n?)+$/.test(answer)) return `${answer.replace(/\s+$/, '')}\n- ${note}`;
  return `${answer.replace(/\s+$/, '')}\n\nCoverage notes:\n- ${note}`;
}
