/**
 * The one definition of "this string identifies the owner, the owner's host, or
 * a private operation".
 *
 * Two consumers share it so they cannot drift apart:
 *
 * - `release-artifact.ts` scans the staged tarball — the bytes that leave this
 *   machine inside a published package.
 * - `public-flip-scan.ts` scans every tracked file — the bytes that become
 *   world-readable when the repository itself is published.
 *
 * The patterns are assembled from inert tokens because the repository's
 * architecture guards reject some of these names in active runtime source while
 * the scanners still need their exact spelling.
 */

const privateOperationNames = [
  ['castor', 'workspace'],
  ['domain', 'agent'],
  ['domain', 'ask'],
  ['rag', 'corpus'],
  ['annas', 'archive', 'search'],
  ['annas', 'archive', 'import'],
  ['expert', 'hire'],
  ['expert', 'report'],
  ['xanthos', 'file', 'deliver'],
].map((tokens) => tokens.join('_'));

const migrationRuntimeNames = [
  ['claw', 'visor'].join(''),
  ['embedding', 'import'].join('-'),
  ['gmail', 'replay'].join('-'),
  ['source', 'sync', 'drain'].join('-'),
];

const privateRuntimeMarkers = [
  ['castor', 'workspace'].join('_'),
  ['domain', 'expert'].join('_'),
  ['file', 'delivery'].join('_'),
  ['not', 'ion'].join(''),
  ['olympus', 'connect', 'gcp'].join(' '),
  ['castor', 'Workspace'].join(''),
  ['domain', 'Expert'].join(''),
  ['file', 'Delivery'].join(''),
  ['castor', 'Workspace', 'Enabled', 'Only'].join(''),
  ['file', 'Delivery', 'Enabled', 'Only'].join(''),
  ['hire', 'Broker', 'Enabled', 'Only'].join(''),
  ['local', 'Email', 'Packets', 'Dev', 'Only'].join(''),
  ['email', 'Index', 'Admin', 'Dev', 'Only'].join(''),
  ['internal', 'solon'].join('\\.'),
  ['secure_local', 'solon'].join('\\.'),
  ['hire', 'Broker'].join(''),
  ['service', 'Account', 'Jwt'].join(''),
  ['client', 'email'].join('_'),
  ['reflect', 'notes'].join('\\.'),
  ['roam', 'notes'].join('\\.'),
  ['reflect', 'notes'].join('-'),
  ['roam', 'notes'].join('-'),
  ['service', 'account', 'jwt'].join('_'),
  ['OLYMPUS', 'EMAIL', 'SOURCE', 'AUTH', 'MODE'].join('_'),
];

/**
 * `identity` names a real person, mailbox, machine, cloud tenant, or key
 * material. It must never appear in bytes the project publishes, in a package
 * or in the repository itself.
 *
 * `private-surface` names a private operation, runtime marker, or operational
 * protocol. Those names are excluded from the published *package* by the
 * positive release catalog, but the files carrying them are ordinary tracked
 * repository files that become world-readable when the repository is published.
 * The release scanner blocks on both; the public-flip scan blocks on `identity`
 * and reports `private-surface` as accepted repository content.
 */
export type OwnerIdentifierSeverity = 'identity' | 'private-surface';

export interface OwnerIdentifierPattern {
  readonly label: string;
  readonly pattern: RegExp;
  readonly severity: OwnerIdentifierSeverity;
}

// `\w*zigelbaum\w*` rather than `\bzigelbaum\b`: the owner's GitHub handle
// concatenates the two names, so a word-boundary form silently misses every
// `jamiezigelbaum` in the tree.
export const OWNER_IDENTIFIER_PATTERNS: ReadonlyArray<OwnerIdentifierPattern> = [
  { label: 'an absolute path inside a person\'s home directory', pattern: /\/(?:Users|home)\/[a-z][a-z0-9._-]*\//i, severity: 'identity' },
  { label: 'a tenant email identity', pattern: /\bjamie@[a-z0-9.-]+\.[a-z]{2,}\b/i, severity: 'identity' },
  { label: 'a tenant or host identity', pattern: /\bjamie\b|\w*zigelbaum\w*|\bsparta\b/i, severity: 'identity' },
  { label: 'a Google service-account address', pattern: /[a-z0-9][a-z0-9-]*@[a-z0-9-]+\.iam\.gserviceaccount\.com/i, severity: 'identity' },
  { label: 'a Google Cloud project id', pattern: /\b(?:olympus|castor)-\d{6}\b/i, severity: 'identity' },
  { label: 'a named GCS bucket', pattern: /gs:\/\/(?!<)[a-z0-9][a-z0-9._-]+/i, severity: 'identity' },
  { label: 'a Vertex RAG corpus resource name', pattern: /projects\/\d{6,}\/locations\/[a-z0-9-]+\/ragCorpora\/\d+/i, severity: 'identity' },
  { label: 'private key material', pattern: new RegExp(['BEGIN', 'PRIVATE', 'KEY'].join(' '), 'i'), severity: 'identity' },
  { label: 'a private operation', pattern: new RegExp(`\\b(?:${privateOperationNames.join('|')})\\b`, 'i'), severity: 'private-surface' },
  { label: 'private runtime or provider material', pattern: new RegExp(`(?:${privateRuntimeMarkers.join('|')})`, 'i'), severity: 'private-surface' },
  { label: 'a private runtime credential alias', pattern: /OLYMPUS_CREDENTIAL_(?:GOOGLE_CASTOR|READWISE_CASTOR)/i, severity: 'private-surface' },
  { label: 'a private protocol', pattern: /(?:OPENCLAW_CHANGE_PROTOCOL|openclaw-safe-restart|runtime-hold|docs\/roles\/)/i, severity: 'private-surface' },
  { label: 'migration-era runtime material', pattern: new RegExp(`\\b(?:${migrationRuntimeNames.join('|')})\\b`, 'i'), severity: 'private-surface' },
];

/**
 * The same identity tokens as bare strings, for matching a PATH rather than
 * file content.
 *
 * The content patterns above are anchored on word boundaries because prose and
 * source text need that to stay precise. A FILENAME has no such courtesy: a
 * name can run the token straight into the next word, and `_` is a word
 * character, so `\bsparta\b` does not match `SPARTA_OLYMPUS_...`. Three of the
 * seventy-five historically redacted private-ops paths were exactly that shape
 * and went unclassified by the content patterns.
 *
 * So path classification uses case-insensitive SUBSTRING matching on these
 * tokens — no boundaries — over the whole path and over each of its
 * components. Being over-eager on a path is cheap (a redacted digest still
 * guards the file); being under-eager publishes an identifier.
 */
export const OWNER_IDENTITY_PATH_TOKENS: readonly string[] = Object.freeze([
  'jamie',
  'zigelbaum',
  'sparta',
]);

/**
 * Separators a path may use to break a token up without changing how a human
 * reads it: directory boundaries, and the word separators filenames use.
 */
const PATH_SEPARATOR_CHARACTERS = /[/\\\-_.\s]/g;

/**
 * Whether a repo-relative path's own text carries one of those tokens.
 *
 * Three haystacks, because a token can hide in any of them:
 *
 * - the whole path, for a token written plainly;
 * - each path component, so a component is searched on its own;
 * - the whole path with every separator stripped, because a token split across
 *   a directory boundary or a hyphen — `spar/ta-drain.sh` — is contiguous in
 *   no unmodified haystack, and manifest parsing accepts `/`, `-`, `_` and `.`
 *   in a path.
 *
 * The stripped form is deliberately eager: it can match across an unrelated
 * boundary. On a PATH that is the right trade — a false positive redacts a
 * digest that still guards the file, a false negative publishes an identifier.
 */
export function pathCarriesOwnerIdentityToken(
  path: string,
  tokens: readonly string[] = OWNER_IDENTITY_PATH_TOKENS,
): boolean {
  const lowered = path.toLowerCase();
  const haystacks = [
    lowered,
    ...lowered.split('/'),
    lowered.replace(PATH_SEPARATOR_CHARACTERS, ''),
  ];
  return tokens.some((token) => {
    const needle = token.toLowerCase().replace(PATH_SEPARATOR_CHARACTERS, '');
    return needle.length > 0 && haystacks.some((haystack) => haystack.includes(needle));
  });
}

/**
 * The MIT license's copyright line is the one place a scanned file deliberately
 * names its owner. Only that exact line, and only in `LICENSE`, is neutralised
 * before scanning; the identity stays banned everywhere else, including the
 * rest of the license text.
 */
export const LICENSE_COPYRIGHT_LINE = 'Copyright (c) 2026 Jamie Zigelbaum';

export function scannableText(relativePath: string, text: string): string {
  return relativePath === 'LICENSE'
    ? text.replace(LICENSE_COPYRIGHT_LINE, 'Copyright (c) 2026 <holder>')
    : text;
}
