/**
 * The released answer's Secret coverage note (design section 2.3): how many
 * Secrets matched by location only. The worker folds it into the answer's
 * "Coverage notes" block; a remote agent's answer has it taken out again
 * (owner decision 2026-10-12, docs/design/background-agents.md section C),
 * so both sides read the sentence from here.
 */
export function secretLocationCoverageNote(count: number): string {
  return `${count} Secret(s) matched by location only; their contents are never read into an answer.`;
}

/**
 * What an answer on this computer says when the question matched Secrets
 * (owner, 2026-10-29: never "the evidence does not contain it"): that each
 * is a Secret, that no AI is shown it, and where it is. `where` is the
 * screened locator or title the secret-locations index releases, else the
 * source alone. Never a byte of the item's content.
 */
export function secretLocationAnswer(locations: ReadonlyArray<{ where: string }>): string {
  if (locations.length === 0) return '';
  const lead = locations.length === 1
    ? 'A matching item is stored as a Secret, so Olympus never shows it to an AI, this one included. Open it on this Mac:'
    : `${locations.length} matching items are stored as Secrets, so Olympus never shows them to an AI, this one included. Open them on this Mac:`;
  return [lead, ...locations.map((location) => `- ${location.where}`)].join('\n');
}

const NOTE_LINE = /^- \d+ Secret\(s\) matched by location only; their contents are never read into an answer\.$/;
const NOTES_HEADING = 'Coverage notes:';

/**
 * The answer without its Secret coverage note line. A "Coverage notes" block
 * left with no notes loses its heading too; every other line is untouched.
 */
export function withoutSecretLocationCoverageNotes(answer: string): string {
  const lines = answer.split('\n');
  if (!lines.some((line) => NOTE_LINE.test(line))) return answer;
  const kept = lines.filter((line) => !NOTE_LINE.test(line));
  const heading = kept.lastIndexOf(NOTES_HEADING);
  if (heading !== -1 && kept.slice(heading + 1).every((line) => !line.startsWith('- '))) {
    // The heading and the blank line composeReleasedAnswer put before it.
    const start = heading > 0 && kept[heading - 1] === '' ? heading - 1 : heading;
    kept.splice(start, heading + 1 - start);
  }
  return kept.join('\n').replace(/\s+$/, '');
}
