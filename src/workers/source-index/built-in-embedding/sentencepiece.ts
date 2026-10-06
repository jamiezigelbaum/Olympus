// A SentencePiece BPE tokenizer, matching the `sentencepiece` library's
// encoder for the Gemma tokenizer model (`tokenizer.model`). Written here
// rather than taken as a dependency for the same reason as wordpiece.ts: the
// plugin ships as a bundled file with no node_modules, and the algorithm is
// small, frozen, and pinned by a parity test against the reference output.
//
// Only what Gemma's model uses is supported, and the constructor refuses
// anything else rather than encoding it differently: a BPE model, the identity
// normalizer with no dummy prefix and no whitespace folding, whitespace
// escaped to U+2581, and byte fallback for characters outside the vocabulary.

const SPACE_SYMBOL = '▁';

// SentencePiece piece types (sentencepiece_model.proto).
const NORMAL = 1;
const UNKNOWN = 2;
const CONTROL = 3;
const USER_DEFINED = 4;
const UNUSED = 5;
const BYTE = 6;
const MODEL_TYPE_BPE = 2;

interface ModelProto {
  pieces: Array<{ piece: string; score: number; type: number }>;
  modelType: number;
  byteFallback: boolean;
  treatWhitespaceAsSuffix: boolean;
  normalizer: {
    name: string;
    hasCharsmap: boolean;
    addDummyPrefix: boolean;
    removeExtraWhitespaces: boolean;
    escapeWhitespaces: boolean;
  };
}

interface Symbol {
  piece: string;
  prev: number;
  next: number;
  /** A user-defined piece: kept whole, never merged with a neighbour. */
  frozen: boolean;
}

interface Pair {
  left: number;
  right: number;
  score: number;
  /** Length of the merged piece; a pair whose sides changed since is stale. */
  length: number;
}

export class SentencePieceTokenizer {
  /** Normal and user-defined pieces: what merges may produce. */
  private readonly pieces: Map<string, number>;
  private readonly scores: Float32Array;
  /** Byte pieces `<0x00>`..`<0xFF>` by byte value. */
  private readonly byteIds: Int32Array;
  /** User-defined pieces by first character, longest first. */
  private readonly userDefined: Map<string, string[]>;
  readonly bosId: number;
  readonly eosId: number;
  readonly padId: number;
  readonly unkId: number;

  constructor(modelBytes: Uint8Array) {
    const model = parseModelProto(modelBytes);
    const { normalizer } = model;
    if (model.modelType !== MODEL_TYPE_BPE) throw new Error('SentencePiece model is not a BPE model.');
    if (!model.byteFallback) throw new Error('SentencePiece model does not use byte fallback.');
    if (model.treatWhitespaceAsSuffix) throw new Error('SentencePiece model treats whitespace as a suffix.');
    if (normalizer.name !== 'identity' || normalizer.hasCharsmap || normalizer.addDummyPrefix
      || normalizer.removeExtraWhitespaces || !normalizer.escapeWhitespaces) {
      throw new Error('SentencePiece model uses a normalizer other than identity with escaped whitespace.');
    }

    this.pieces = new Map();
    this.scores = new Float32Array(model.pieces.length);
    this.byteIds = new Int32Array(256).fill(-1);
    this.userDefined = new Map();
    const reserved = new Map<string, number>();
    model.pieces.forEach(({ piece, score, type }, id) => {
      this.scores[id] = score;
      if (type === NORMAL || type === USER_DEFINED || type === UNUSED) {
        if (type === UNUSED) throw new Error('SentencePiece model has unused pieces, which this encoder does not resegment.');
        if (!this.pieces.has(piece)) this.pieces.set(piece, id);
        if (type === USER_DEFINED && piece.length > 0) {
          const first = String.fromCodePoint(piece.codePointAt(0)!);
          const list = this.userDefined.get(first) ?? [];
          list.push(piece);
          this.userDefined.set(first, list);
        }
      } else {
        reserved.set(piece, id);
        if (type === BYTE) {
          const match = /^<0x([0-9A-F]{2})>$/.exec(piece);
          if (!match) throw new Error(`SentencePiece byte piece ${piece} is malformed.`);
          this.byteIds[Number.parseInt(match[1]!, 16)] = id;
        }
      }
    });
    for (const list of this.userDefined.values()) list.sort((left, right) => right.length - left.length);
    if (this.byteIds.includes(-1)) throw new Error('SentencePiece model is missing byte pieces.');
    this.bosId = requirePiece(model, '<bos>', CONTROL);
    this.eosId = requirePiece(model, '<eos>', CONTROL);
    this.padId = requirePiece(model, '<pad>', CONTROL);
    this.unkId = requirePiece(model, '<unk>', UNKNOWN);
  }

  /** Content token ids, without `<bos>`/`<eos>`. */
  tokenize(text: string): number[] {
    const symbols = this.initialSymbols(text.replaceAll(' ', SPACE_SYMBOL));
    if (symbols.length === 0) return [];

    const agenda = new PairHeap();
    const consider = (left: number, right: number) => {
      if (left < 0 || right < 0) return;
      const a = symbols[left]!;
      const b = symbols[right]!;
      if (a.frozen || b.frozen) return;
      const merged = a.piece + b.piece;
      const id = this.pieces.get(merged);
      if (id === undefined) return;
      agenda.push({ left, right, score: this.scores[id]!, length: merged.length });
    };
    for (let index = 1; index < symbols.length; index += 1) consider(index - 1, index);

    for (let top = agenda.pop(); top; top = agenda.pop()) {
      const left = symbols[top.left]!;
      const right = symbols[top.right]!;
      if (left.piece.length === 0 || right.piece.length === 0
        || left.piece.length + right.piece.length !== top.length) {
        continue;
      }
      left.piece += right.piece;
      left.next = right.next;
      if (right.next >= 0) symbols[right.next]!.prev = top.left;
      right.piece = '';
      consider(left.prev, top.left);
      consider(top.left, left.next);
    }

    const ids: number[] = [];
    for (let index = 0; index !== -1; index = symbols[index]!.next) {
      const piece = symbols[index]!.piece;
      const id = this.pieces.get(piece);
      if (id !== undefined) {
        ids.push(id);
      } else {
        for (const byte of new TextEncoder().encode(piece)) ids.push(this.byteIds[byte]!);
      }
    }
    return ids;
  }

  /** One symbol per character, except that a user-defined piece is one frozen symbol (longest match). */
  private initialSymbols(normalized: string): Symbol[] {
    const symbols: Symbol[] = [];
    let offset = 0;
    while (offset < normalized.length) {
      const char = String.fromCodePoint(normalized.codePointAt(offset)!);
      const candidates = this.userDefined.get(char);
      const match = candidates?.find((piece) => normalized.startsWith(piece, offset));
      const piece = match ?? char;
      symbols.push({ piece, prev: symbols.length - 1, next: symbols.length + 1, frozen: match !== undefined });
      offset += piece.length;
    }
    if (symbols.length > 0) symbols[symbols.length - 1]!.next = -1;
    return symbols;
  }
}

/** Highest score first; on a tie, the leftmost pair (sentencepiece's agenda order). */
class PairHeap {
  private readonly items: Pair[] = [];

  push(pair: Pair): void {
    const items = this.items;
    items.push(pair);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(items[index]!, items[parent]!)) break;
      [items[index], items[parent]] = [items[parent]!, items[index]!];
      index = parent;
    }
  }

  pop(): Pair | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let best = index;
        if (left < items.length && before(items[left]!, items[best]!)) best = left;
        if (right < items.length && before(items[right]!, items[best]!)) best = right;
        if (best === index) break;
        [items[index], items[best]] = [items[best]!, items[index]!];
        index = best;
      }
    }
    return top;
  }
}

function before(a: Pair, b: Pair): boolean {
  return a.score > b.score || (a.score === b.score && a.left < b.left);
}

function requirePiece(model: ModelProto, piece: string, type: number): number {
  const id = model.pieces.findIndex((entry) => entry.piece === piece && entry.type === type);
  if (id < 0) throw new Error(`SentencePiece model is missing ${piece}.`);
  return id;
}

// --- The few fields of sentencepiece_model.proto this encoder reads. -------

class ProtoReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array, private readonly end = bytes.length, start = 0) {
    this.offset = start;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  done(): boolean {
    return this.offset >= this.end;
  }

  tag(): { field: number; wire: number } {
    const tag = this.varint();
    return { field: Math.floor(tag / 8), wire: tag % 8 };
  }

  varint(): number {
    let result = 0;
    let scale = 1;
    for (let shift = 0; shift < 70; shift += 7) {
      if (this.offset >= this.end) throw new Error('SentencePiece model is truncated.');
      const byte = this.bytes[this.offset++]!;
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new Error('SentencePiece model has a malformed varint.');
  }

  float(): number {
    if (this.offset + 4 > this.end) throw new Error('SentencePiece model is truncated.');
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** A length-delimited field as a reader over its bytes. */
  message(): ProtoReader {
    const length = this.varint();
    const start = this.offset;
    if (start + length > this.end) throw new Error('SentencePiece model is truncated.');
    this.offset += length;
    return new ProtoReader(this.bytes, start + length, start);
  }

  string(): string {
    const inner = this.message();
    // ignoreBOM keeps a leading U+FEFF: pieces such as "﻿#" are real vocabulary.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.bytes.subarray(inner.offset, inner.end));
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.offset += 8;
    else if (wire === 2) this.message();
    else if (wire === 5) this.offset += 4;
    else throw new Error(`SentencePiece model has unsupported wire type ${wire}.`);
  }
}

function parseModelProto(bytes: Uint8Array): ModelProto {
  const model: ModelProto = {
    pieces: [],
    modelType: 1,
    byteFallback: false,
    treatWhitespaceAsSuffix: false,
    // proto2 defaults for an absent NormalizerSpec field.
    normalizer: { name: '', hasCharsmap: false, addDummyPrefix: true, removeExtraWhitespaces: true, escapeWhitespaces: true },
  };
  const reader = new ProtoReader(bytes);
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      const entry = { piece: '', score: 0, type: NORMAL };
      const inner = reader.message();
      while (!inner.done()) {
        const tag = inner.tag();
        if (tag.field === 1 && tag.wire === 2) entry.piece = inner.string();
        else if (tag.field === 2 && tag.wire === 5) entry.score = inner.float();
        else if (tag.field === 3 && tag.wire === 0) entry.type = inner.varint();
        else inner.skip(tag.wire);
      }
      model.pieces.push(entry);
    } else if (field === 2 && wire === 2) {
      const inner = reader.message();
      while (!inner.done()) {
        const tag = inner.tag();
        if (tag.field === 3 && tag.wire === 0) model.modelType = inner.varint();
        else if (tag.field === 24 && tag.wire === 0) model.treatWhitespaceAsSuffix = inner.varint() !== 0;
        else if (tag.field === 35 && tag.wire === 0) model.byteFallback = inner.varint() !== 0;
        else inner.skip(tag.wire);
      }
    } else if (field === 3 && wire === 2) {
      const inner = reader.message();
      while (!inner.done()) {
        const tag = inner.tag();
        if (tag.field === 1 && tag.wire === 2) model.normalizer.name = inner.string();
        else if (tag.field === 2 && tag.wire === 2) model.normalizer.hasCharsmap = inner.message().done() === false;
        else if (tag.field === 3 && tag.wire === 0) model.normalizer.addDummyPrefix = inner.varint() !== 0;
        else if (tag.field === 4 && tag.wire === 0) model.normalizer.removeExtraWhitespaces = inner.varint() !== 0;
        else if (tag.field === 5 && tag.wire === 0) model.normalizer.escapeWhitespaces = inner.varint() !== 0;
        else inner.skip(tag.wire);
      }
    } else {
      reader.skip(wire);
    }
  }
  if (model.pieces.length === 0) throw new Error('SentencePiece model has no pieces.');
  return model;
}
