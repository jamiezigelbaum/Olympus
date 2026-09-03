/**
 * Path redaction for the deletion and disposition ledgers.
 *
 * Some retired and disposed paths carry the private host alias in the filename
 * itself. Three options existed and two of them are wrong:
 *
 * - publishing the literal path publishes the alias;
 * - dropping the entry retires the guard, so the file could come back unnoticed;
 * - rewriting it to an invented name is worse than dropping it, because the
 *   guard then watches a name that never existed while the real one is
 *   unguarded (the public-flip scanner reads file *contents*, not pathnames, so
 *   nothing else would catch it either).
 *
 * So the ledger stores the SHA-256 of the exact repo-relative path string. The
 * guard hashes every candidate path it finds and compares digests: it still
 * fires on the real name, and the real name is never written down.
 *
 * The digest is over the path string, not file contents — the file is gone, so
 * there are no contents to hash.
 */

import { createHash } from 'node:crypto';
import { dirname, join, normalize } from 'node:path';

export function pathDigest(repoRelativePath: string): string {
  return createHash('sha256').update(repoRelativePath, 'utf8').digest('hex');
}

export function isPathDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Candidate paths whose digest is on the redacted list. */
export function redactedPathOffenders(
  candidatePaths: Iterable<string>,
  redactedDigests: ReadonlySet<string>,
): string[] {
  const offenders: string[] = [];
  for (const candidate of candidatePaths) {
    if (redactedDigests.has(pathDigest(candidate))) offenders.push(candidate);
  }
  return offenders;
}

/**
 * Every simply-quoted string literal in a source file. The literal-path guard
 * asks "does the content contain `'<path>'`"; with a digest there is no path to
 * search for, so the check runs the other way — pull the literals out, then
 * hash them.
 *
 * Deliberately the same shape the literal check accepts: single, double, or
 * backtick delimiters with no embedded quote or newline. A path spliced
 * together through interpolation is out of scope for both checks.
 */
export function quotedLiterals(content: string): string[] {
  return [...content.matchAll(/(['"`])([^'"`\n]*)\1/g)].map((match) => match[2]!);
}

/**
 * A quoted literal resolved back to the repo-relative paths it could name: the
 * literal itself, and — when it is a relative module specifier — the path it
 * resolves to from the importing file, with the `.ts` extension TypeScript
 * lets callers omit. This is the inverse of expanding a deleted path into the
 * specifiers that would import it.
 */
export function referenceCandidates(activePath: string, literal: string): string[] {
  if (!literal || literal.includes('\u0000')) return [];
  const candidates = new Set<string>([literal]);
  if (literal.startsWith('./') || literal.startsWith('../')) {
    const resolved = normalize(join(dirname(activePath), literal)).split('\\').join('/');
    if (!resolved.startsWith('..')) {
      candidates.add(resolved);
      if (!resolved.endsWith('.ts')) candidates.add(`${resolved}.ts`);
    }
  }
  return [...candidates];
}

/**
 * The trailing filename of a quoted literal, for catching a path that is
 * assembled rather than written whole — `join(OPS_DIR, 'name.sh')`, or a
 * template whose only literal fragment is the filename.
 *
 * A template whose interpolation is only a prefix — `${dir}/name.sh` — is
 * caught too, because the literal still ends in the filename.
 *
 * RESIDUAL, deliberately not claimed as covered: a name with no literal
 * fragment at all — `join(dir, `install-${what}-systemd.sh`)`, a variable
 * holding the filename, a name computed at runtime — is invisible to any
 * source-text check, digest-based or not. The literal-path guard has the same
 * blind spot and always did; matching basenames narrows it to the case where
 * the filename never appears literally anywhere.
 */
export function literalBasename(literal: string): string | undefined {
  if (!literal || literal.includes('\u0000')) return undefined;
  const trimmed = literal.split('\\').join('/').replace(/\/+$/, '');
  const basename = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return basename || undefined;
}
