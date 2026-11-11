/**
 * The opening link `olympus dashboard --no-open` printed, read the way a
 * program should: the `url` of its JSON answer, and only when the command
 * succeeded. A failed mint's error names the worker's own address, which is
 * not an opening link: navigating there shows a 401 page instead of the
 * reason (#1338).
 */
export function openingLinkOf(minted: { code: number | null; stdout: string; stderr: string }): { url: string } | { problem: string } {
  const why = () => (minted.stderr.trim() || minted.stdout.trim()).split('\n')[0]!.slice(0, 300);
  if (minted.code !== 0) return { problem: `exit ${minted.code ?? '?'}: ${why() || 'no output'}` };
  let url: unknown;
  try {
    // The answer is the JSON object the command prints last; a notice before it is not the answer.
    const start = minted.stdout.search(/^\{/m);
    url = (JSON.parse(start < 0 ? minted.stdout : minted.stdout.slice(start)) as { url?: unknown }).url;
  } catch {
    url = undefined;
  }
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return { problem: `no opening link in its answer: ${why() || 'no output'}` };
  return { url };
}

/** The opening link, or an error that says why the mint failed. */
export function openingLinkOrThrow(minted: { code: number | null; stdout: string; stderr: string }, command: string): string {
  const read = openingLinkOf(minted);
  if ('problem' in read) throw new Error(`${command} printed no opening link (${read.problem})`);
  return read.url;
}
