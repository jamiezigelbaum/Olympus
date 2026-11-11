// Plain text from a Rich Text Format file, for the text lane.
//
// RTF is 7-bit text with control words, so a reader needs no library: keep
// the body's characters, turn paragraph and line marks into newlines, decode
// \'hh (the document's code page, Windows-1252 unless it says otherwise) and
// \uN escapes, and skip the groups that hold no body text (font and colour
// tables, styles, document info, pictures, embedded objects and every
// \* destination). Output stops at `maxChars`, and reading stops at the first
// body text past it, so a large file costs little more than its bound.

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

// One character per byte, every byte kept as itself. TextDecoder('latin1') is
// not this: the label means Windows-1252, which moves 0x80-0x9f.
export function rtfSourceFromBytes(bytes: Uint8Array): string {
  let source = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    source += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return source;
}

export interface RtfText {
  text: string;
  // True when body text past `maxChars` was left out. Whitespace past the
  // bound does not count, so a reader that trims the text can still tell.
  truncated: boolean;
}

export function rtfToText(source: string, maxChars: number): RtfText {
  const out: string[] = [];
  let length = 0;
  let truncated = false;
  const emit = (text: string): void => {
    const room = maxChars - length;
    const piece = text.length > room ? text.slice(0, room) : text;
    if (piece.length < text.length && text.slice(piece.length).trim() !== '') truncated = true;
    if (piece.length === 0) return;
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
  // Bytes above 0x7f wait for the end of their run, so a character written
  // as two bytes is decoded whole. A run can be as long as the file, so it is
  // decoded early once it holds more than the room left could take (no code
  // page needs more than four bytes a character): what follows is past the
  // bound either way.
  const hexBytes: number[] = [];
  const pushByte = (byte: number): void => {
    hexBytes.push(byte);
    if (hexBytes.length >= (maxChars - length) * 4 + 4) flushHex();
  };
  const flushHex = (): void => {
    if (hexBytes.length === 0) return;
    if (!state.skip) emit(decodeCodePage(Uint8Array.from(hexBytes), codePage));
    hexBytes.length = 0;
  };

  let index = 0;
  while (index < source.length && !truncated) {
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
        if (Number.isFinite(value)) pushByte(value);
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
        const symbol = next === '\\' || next === '{' || next === '}' ? next
          : next === '~' ? ' '
            : next === '_' ? '-'
              : next === '\n' || next === '\r' ? '\n'
                : undefined;
        if (symbol === undefined) continue;
        // A symbol can be the fallback a \uN escape said to drop.
        if (pendingSkip > 0) {
          pendingSkip -= 1;
          continue;
        }
        if (!state.skip) emit(symbol);
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
    groupStart = false;
    index += 1;
    if (pendingSkip > 0) {
      pendingSkip -= 1;
      continue;
    }
    // A byte above 0x7f written as itself is in the document's code page,
    // the same as one written as \'hh.
    if (char.charCodeAt(0) > 0x7f) {
      pushByte(char.charCodeAt(0));
      continue;
    }
    flushHex();
    if (!state.skip) emit(char);
  }
  flushHex();
  return { text: out.join(''), truncated };
}

function isLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

// RTF names code pages by number; the decoder wants a label.
const CODE_PAGE_LABELS: ReadonlyMap<number, string> = new Map([
  [866, 'ibm866'], [874, 'windows-874'],
  [932, 'shift_jis'], [936, 'gbk'], [949, 'euc-kr'], [950, 'big5'],
  [1250, 'windows-1250'], [1251, 'windows-1251'], [1252, 'windows-1252'], [1253, 'windows-1253'],
  [1254, 'windows-1254'], [1255, 'windows-1255'], [1256, 'windows-1256'], [1257, 'windows-1257'],
  [1258, 'windows-1258'], [10000, 'macintosh'], [10007, 'x-mac-cyrillic'], [20866, 'koi8-r'],
  [28591, 'iso-8859-1'], [28592, 'iso-8859-2'], [28595, 'iso-8859-5'], [54936, 'gb18030'], [65001, 'utf-8'],
]);

function decodeCodePage(bytes: Uint8Array, codePage: number): string {
  const label = CODE_PAGE_LABELS.get(codePage);
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Not in this runtime: fall through.
    }
  }
  // A code page this reader cannot decode: plain ASCII stays, every other
  // byte becomes the replacement character, so no wrong letter is indexed.
  let text = '';
  for (const byte of bytes) text += byte < 0x80 ? String.fromCharCode(byte) : '\ufffd';
  return text;
}
