import type { ConnectorStoreFolderFilterCodec } from '../connector-store/filter-capabilities.ts';

const X_FOLDER_NAME_FACET_PREFIX = 'x-folder-name:v1:';
const X_FOLDER_NAME_LITERAL_ESCAPE_PREFIX = 'x-literal:v1:';
export const X_BOOKMARKS_FOLDER_FACET_AUTHORITY_VERSION = 2;
const X_FOLDER_SEARCH_TEXT_LITERAL_ESCAPES = Object.freeze([Object.freeze({
  reservedPrefix: X_FOLDER_NAME_FACET_PREFIX,
  literalEscapePrefix: X_FOLDER_NAME_LITERAL_ESCAPE_PREFIX,
  encodedValue: 'base64url-utf8',
  decodedValueLineRequired: true,
})]);

/**
 * Folder-name facets are opaque, case-preserving UTF-8 values. Ordinary
 * search-context lines that begin with the reserved facet prefix are escaped
 * before storage, so only this module can emit a line in the facet namespace.
 */
export function xBookmarkFolderNameFacet(folderName: string): string {
  const normalized = requireExactSearchTextLine(folderName, 'X bookmark folder name');
  return `${X_FOLDER_NAME_FACET_PREFIX}${Buffer.from(normalized, 'utf8').toString('base64url')}`;
}

/**
 * Stored provider values have an explicit normalization rule: each unpaired
 * surrogate becomes U+FFFD, then the existing boundary trim applies.
 * Well-formed code points are otherwise preserved exactly (no NFC folding).
 */
export function xBookmarkProviderFolderNameFacet(folderName: string): string {
  return xBookmarkFolderNameFacet(normalizeXBookmarkProviderFolderName(folderName));
}

export function normalizeXBookmarkProviderFolderName(folderName: string): string {
  return toWellFormedUtf16(folderName).trim();
}

export function xBookmarkFolderNameFacetPrefix(): string {
  return X_FOLDER_NAME_FACET_PREFIX;
}

export function xBookmarkFolderNameLiteralEscapePrefix(): string {
  return X_FOLDER_NAME_LITERAL_ESCAPE_PREFIX;
}

export function xBookmarkSearchTextLiteralEscapes(): readonly {
  reservedPrefix: string;
  literalEscapePrefix: string;
  encodedValue: 'base64url-utf8';
  decodedValueLineRequired: true;
}[] {
  return X_FOLDER_SEARCH_TEXT_LITERAL_ESCAPES;
}

export const X_BOOKMARKS_FOLDER_FILTER_CODEC: ConnectorStoreFolderFilterCodec =
  Object.freeze({
    folderIdExactLine(value: string): string {
      return requireExactSearchTextLine(`x-folder:${value}`, 'X bookmark folder id facet');
    },
    folderNameExactLine(value: string): string {
      return xBookmarkFolderNameFacet(value);
    },
  });

export function xBookmarkSearchText(input: {
  title: string;
  aliases: readonly string[];
  identityAliases: readonly string[];
  folderNames: readonly string[];
}): string {
  const ordinaryLines = [
    input.title,
    ...input.identityAliases,
    ...input.aliases,
  ].map(escapeReservedFolderFacetLine);
  const facetLines = [...new Set(input.folderNames.map(xBookmarkFolderNameFacet))];
  return [...uniqueOrdinarySearchTextLines(ordinaryLines), ...facetLines].join('\n');
}

function escapeReservedFolderFacetLine(value: string): string {
  const normalized = requireSearchTextLine(value, 'X bookmark search-context line');
  return normalized.startsWith(X_FOLDER_NAME_FACET_PREFIX)
    ? `${X_FOLDER_NAME_LITERAL_ESCAPE_PREFIX}${normalized}`
    : normalized;
}

function uniqueOrdinarySearchTextLines(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function requireSearchTextLine(value: string, label: string): string {
  const normalized = value.trim();
  return requireExactSearchTextLine(normalized, label);
}

function requireExactSearchTextLine(value: string, label: string): string {
  if (typeof value !== 'string'
    || !value.trim()
    || value.length > 1_000
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be a non-empty safe string of at most 1,000 characters.`);
  }
  assertWellFormedUtf16(value, label);
  return value;
}

function assertWellFormedUtf16(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} must contain well-formed UTF-16.`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} must contain well-formed UTF-16.`);
    }
  }
}

function toWellFormedUtf16(value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError('X bookmark folder name must be a string.');
  }
  let normalized = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        normalized += value[index]! + value[index + 1]!;
        index += 1;
      } else {
        normalized += '\ufffd';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      normalized += '\ufffd';
    } else {
      normalized += value[index]!;
    }
  }
  return normalized;
}
