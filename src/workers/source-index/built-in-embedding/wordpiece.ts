// A BERT WordPiece tokenizer (uncased), matching Hugging Face `tokenizers`'
// BertNormalizer + BertPreTokenizer + WordPiece for the built-in embedding
// model's vocabulary. Written here rather than taken as a dependency: the
// plugin ships as a bundled file with no node_modules, and the algorithm is
// small, frozen, and pinned by a parity test against the reference output.

export interface WordPieceEncoding {
  ids: number[];
  /** True when the text had more tokens than fit and was cut. */
  truncated: boolean;
}

const MAX_INPUT_CHARS_PER_WORD = 100;
const CONTINUING_SUBWORD_PREFIX = '##';

export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  readonly clsId: number;
  readonly sepId: number;
  readonly unkId: number;
  readonly padId: number;

  constructor(vocabText: string) {
    const vocab = new Map<string, number>();
    const lines = vocabText.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const token = lines[index]!.replace(/\r$/, '');
      if (token.length === 0 && index === lines.length - 1) continue;
      if (!vocab.has(token)) vocab.set(token, index);
    }
    this.vocab = vocab;
    this.clsId = requireToken(vocab, '[CLS]');
    this.sepId = requireToken(vocab, '[SEP]');
    this.unkId = requireToken(vocab, '[UNK]');
    this.padId = requireToken(vocab, '[PAD]');
  }

  /** Content token ids, without special tokens. */
  tokenize(text: string): number[] {
    const ids: number[] = [];
    for (const word of preTokenize(normalize(text))) {
      this.wordPiece(word, ids);
    }
    return ids;
  }

  /** `[CLS] tokens [SEP]`, truncated on the right to `maxLength` total ids. */
  encode(text: string, maxLength: number): WordPieceEncoding {
    const content = this.tokenize(text);
    const room = Math.max(0, maxLength - 2);
    const truncated = content.length > room;
    return {
      ids: [this.clsId, ...(truncated ? content.slice(0, room) : content), this.sepId],
      truncated,
    };
  }

  private wordPiece(word: string, out: number[]): void {
    const chars = Array.from(word);
    if (chars.length > MAX_INPUT_CHARS_PER_WORD) {
      out.push(this.unkId);
      return;
    }
    const pieces: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const piece = (start > 0 ? CONTINUING_SUBWORD_PREFIX : '') + chars.slice(start, end).join('');
        const id = this.vocab.get(piece);
        if (id !== undefined) {
          found = id;
          break;
        }
        end -= 1;
      }
      if (found === undefined) {
        out.push(this.unkId);
        return;
      }
      pieces.push(found);
      start = end;
    }
    out.push(...pieces);
  }
}

function requireToken(vocab: Map<string, number>, token: string): number {
  const id = vocab.get(token);
  if (id === undefined) throw new Error(`WordPiece vocabulary is missing ${token}.`);
  return id;
}

const CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u;
const WHITESPACE = /[\s\p{Zs}]/u;
const COMBINING_MARK = /\p{Mn}/gu;
const PUNCTUATION = /\p{P}/u;

/** BertNormalizer: clean text, space out CJK ideographs, lowercase, strip accents. */
function normalize(text: string): string {
  let cleaned = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0 || code === 0xfffd) continue;
    if (char === '\t' || char === '\n' || char === '\r') {
      cleaned += ' ';
      continue;
    }
    if (CONTROL.test(char)) continue;
    if (WHITESPACE.test(char)) {
      cleaned += ' ';
      continue;
    }
    cleaned += isChineseChar(code) ? ` ${char} ` : char;
  }
  return cleaned.toLowerCase().normalize('NFD').replace(COMBINING_MARK, '');
}

/** BertPreTokenizer: split on whitespace, and isolate every punctuation character. */
function preTokenize(text: string): string[] {
  const words: string[] = [];
  let current = '';
  for (const char of text) {
    if (char === ' ' || WHITESPACE.test(char)) {
      if (current) words.push(current);
      current = '';
    } else if (isPunctuation(char)) {
      if (current) words.push(current);
      words.push(char);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words;
}

function isPunctuation(char: string): boolean {
  const code = char.codePointAt(0)!;
  if ((code >= 33 && code <= 47) || (code >= 58 && code <= 64)
    || (code >= 91 && code <= 96) || (code >= 123 && code <= 126)) {
    return true;
  }
  return PUNCTUATION.test(char);
}

function isChineseChar(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x20000 && code <= 0x2a6df)
    || (code >= 0x2a700 && code <= 0x2b73f)
    || (code >= 0x2b740 && code <= 0x2b81f)
    || (code >= 0x2b820 && code <= 0x2ceaf)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x2f800 && code <= 0x2fa1f);
}
