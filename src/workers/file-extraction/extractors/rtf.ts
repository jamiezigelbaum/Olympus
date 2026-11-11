// Plain text from a Rich Text Format file, for the text lane.
//
// RTF is 7-bit text with control words, so a reader needs no library: keep
// the body's characters, turn paragraph and line marks into newlines, decode
// \'hh (the document's code page, Windows-1252 unless it says otherwise) and
// \uN escapes, and skip the groups that hold no body text (font and colour
// tables, styles, document info, pictures, embedded objects and every
// \* destination). Output stops at `maxChars`, so a large file costs no more
// than the bound it is read into.

export const RTF_MIME_TYPES: ReadonlySet<string> = new Set(['application/rtf', 'text/rtf']);

// Destinations whose text is never body text.
const SKIPPED_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'listtable', 'listoverridetable',
  'rsidtbl', 'generator', 'themedata', 'colorschememapping', 'datastore', 'latentstyles',
  'xmlnstbl', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'filetbl', 'revtbl', 'mmathPr', 'pgdsctbl', 'fldinst',
]);

const BREAKS: Readonly<Record<string, string>> = {
  par: '\n', line: '\n', sect: '\n', page: '\n', row: '\n', tab: '\t', cell: '\t',
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’',
  ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ',
};

// Whether the bytes start like an RTF document.
export function hasRtfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5
    && bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66;
}

interface GroupState {
  skip: boolean;
  // Characters to drop after a \uN escape (\ucN; 1 by default).
  unicodeSkip: number;
}

export function rtfToText(source: string, maxChars: number): string {
  const out: string[] = [];
  let length = 0;
  const emit = (text: string): void => {
    if (length >= maxChars) return;
    const room = maxChars - length;
    const piece = text.length > room ? text.slice(0, room) : text;
    out.push(piece);
    length += piece.length;
  };
  let codePage = 1252;
  const stack: GroupState[] = [];
  let state: GroupState = { skip: false, unicodeSkip: 1 };
  // Fallback characters still owed after a \uN escape.
  let pendingSkip = 0;
  // Set by `{\*` or a skipped destination word at the start of a group.
  let groupStart = false;
  const hexBytes: number[] = [];
  const flushHex = (): void => {
    if (hexBytes.length === 0) return;
    if (!state.skip) emit(decodeCodePage(Uint8Array.from(hexBytes), codePage));
    hexBytes.length = 0;
  };

  let index = 0;
  while (index < source.length && length < maxChars) {
    const char = source[index]!;
    if (char === '{') {
      flushHex();
      stack.push(state);
      state = { ...state };
      groupStart = true;
      pendingSkip = 0;
      index += 1;
      continue;
    }
    if (char === '}') {
      flushHex();
      state = stack.pop() ?? { skip: false, unicodeSkip: 1 };
      groupStart = false;
      pendingSkip = 0;
      index += 1;
      continue;
    }
    if (char === '\\') {
      const next = source[index + 1];
      if (next === undefined) break;
      if (next === "'") {
        const hex = source.slice(index + 2, index + 4);
        index += 4;
        if (pendingSkip > 0) {
          pendingSkip -= 1;
          continue;
        }
        const value = Number.parseInt(hex, 16);
        if (Number.isFinite(value)) hexBytes.push(value);
        groupStart = false;
        continue;
      }
      flushHex();
      if (next === '*') {
        if (groupStart) state.skip = true;
        index += 2;
        continue;
      }
      if (!isLetter(next)) {
        // A control symbol: an escaped brace or backslash, a non-breaking
        // space or hyphen, or a mark with no text.
        index += 2;
        groupStart = false;
        if (state.skip) continue;
        if (next === '\\' || next === '{' || next === '}') emit(next);
        else if (next === '~') emit(' ');
        else if (next === '_') emit('-');
        else if (next === '\n' || next === '\r') emit('\n');
        continue;
      }
      let end = index + 1;
      while (end < source.length && end - index <= 32 && isLetter(source[end]!)) end += 1;
      const word = source.slice(index + 1, end);
      index = end;
      let digitsEnd = source[index] === '-' ? index + 1 : index;
      while (digitsEnd < source.length && digitsEnd - index < 11 && isDigit(source[digitsEnd]!)) digitsEnd += 1;
      const parameter = digitsEnd > index && isDigit(source[digitsEnd - 1]!) ? source.slice(index, digitsEnd) : undefined;
      if (parameter !== undefined) index = digitsEnd;
      if (source[index] === ' ') index += 1;
      const value = parameter === undefined ? undefined : Number(parameter);
      const atStart = groupStart;
      groupStart = false;
      if (atStart && SKIPPED_DESTINATIONS.has(word)) {
        state.skip = true;
        continue;
      }
      if (word === 'ansicpg' && value !== undefined) {
        codePage = value;
        continue;
      }
      if (word === 'uc' && value !== undefined) {
        state.unicodeSkip = Math.max(0, value);
        continue;
      }
      if (word === 'u' && value !== undefined) {
        if (!state.skip) emit(String.fromCharCode(value < 0 ? value + 65_536 : value));
        pendingSkip = state.unicodeSkip;
        continue;
      }
      if (word === 'bin' && value !== undefined) {
        index += Math.max(0, value);
        continue;
      }
      if (!state.skip && BREAKS[word] !== undefined) emit(BREAKS[word]!);
      continue;
    }
    if (char === '\r' || char === '\n') {
      index += 1;
      continue;
    }
    flushHex();
    groupStart = false;
    index += 1;
    if (pendingSkip > 0) {
      pendingSkip -= 1;
      continue;
    }
    if (!state.skip) emit(char);
  }
  flushHex();
  return out.join('');
}

function isLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function decodeCodePage(bytes: Uint8Array, codePage: number): string {
  try {
    return new TextDecoder(`windows-${codePage}`).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
