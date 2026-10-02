/**
 * The one matcher for owner rules that name a location: a path prefix, a
 * folder key or a label. The tier classifier (tier-classifier.ts
 * `ownerRuleMatches`) and the ChatGPT picker's Secrets filter
 * (chatgpt/scope-privacy.ts) both use it, so a folder the classifier treats
 * as Secrets is never listed by the picker (review P-5, 2026-10-02).
 *
 * - Case-insensitive and trimmed throughout.
 * - A path prefix names a folder: it matches that folder and everything
 *   under it, on a folder boundary (`/taxes` matches `/Taxes/2020.pdf`, not
 *   `/taxes2020/x`). A trailing slash changes nothing; `/` matches every path.
 * - A folder key or label matches by equality against any of the keys given,
 *   so passing a folder's ancestors' keys makes the match parent-aware.
 * Senders have their own matcher (core/sender-rules.ts).
 */

/** Lowercased, trimmed, without trailing slashes. */
export function normalizeLocationPath(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

/** Whether `path` is the folder `prefix` names, or sits under it. An empty rule matches nothing. */
export function pathPrefixMatches(path: string | undefined, prefix: string): boolean {
  if (!prefix.trim() || path === undefined || !path.trim()) return false;
  const folder = normalizeLocationPath(prefix);
  if (folder === '') return true;
  const value = normalizeLocationPath(path);
  return value === folder || value.startsWith(`${folder}/`);
}

/** Whether any of `keys` (a folder's own key and its ancestors', or an item's labels) equals the rule value. */
export function locationKeyMatches(keys: readonly string[], value: string): boolean {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return false;
  return keys.some((key) => key.trim().toLowerCase() === wanted);
}
