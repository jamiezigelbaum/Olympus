/**
 * The one sentence every answer surface uses for matches the owner keeps
 * unread on purpose: items in a folder set to Names only. Their names are
 * searchable; their contents are never read. That is a settled choice, not a
 * failed read, so it is never said as "could not read".
 *
 * Counts only. No folder names: the owner knows which folders they set to
 * Names only, and a folder name could itself be private.
 */
export function namesOnlyCoverageNote(count: number): string {
  return count === 1
    ? '1 match is in a folder set to Names only, so Olympus has its name but not its contents. '
      + 'Use Read this file for one file, or switch that folder to Full in the folder picker.'
    : `${count} matches are in folders set to Names only, so Olympus has their names but not their contents. `
      + 'Use Read this file for one file, or switch those folders to Full in the folder picker.';
}

export function onDemandReadingCoverageNote(count: number): string {
  return `Reading ${count} ${count === 1 ? 'file' : 'files'} for this question. Ask again in about a minute.`;
}

export function onDemandCappedCoverageNote(): string {
  return 'The read-on-demand limit for this question was reached. Other matches are still names only; use Read this file to read more.';
}

export function onDemandFailedCoverageNote(count: number): string {
  return `Could not start reading ${count} ${count === 1 ? 'file' : 'files'} for this question. Try Read this file in the dashboard.`;
}
