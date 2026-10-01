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
      + 'Switch that folder to Full in the folder picker to let Olympus read it.'
    : `${count} matches are in folders set to Names only, so Olympus has their names but not their contents. `
      + 'Switch those folders to Full in the folder picker to let Olympus read them.';
}
