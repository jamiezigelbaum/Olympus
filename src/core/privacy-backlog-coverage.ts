/** Global coverage gap, never a claim that a held item matches the question.
 * Only the sniffer's pending-item count enters this note; no item metadata or
 * queue summary, and no time estimate inferred from the computer's speed.
 */
export function privacyBacklogCoverageNote(pendingItems: number | undefined): string | undefined {
  if (pendingItems === undefined || !Number.isSafeInteger(pendingItems) || pendingItems <= 0) return undefined;
  return `Olympus is still checking ${pendingItems} new item${pendingItems === 1 ? '' : 's'} for privacy before ${pendingItems === 1 ? 'it' : 'they'} can be searched. `
    + 'This can take a while on this computer.';
}
