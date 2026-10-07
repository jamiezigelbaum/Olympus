/**
 * 16-bit mono PCM WAV: read, write, and cut into chunks at quiet points.
 *
 * The built-in transcriber converts every audio file to this one shape
 * (16 kHz, mono, signed 16-bit) with the system decoder, then sends the model
 * one chunk of about thirty seconds at a time. Cutting at the quietest moment
 * near each boundary keeps words whole without overlapping chunks, so the
 * transcripts stitch by simple concatenation.
 *
 * Pure functions over bytes; no file system, no processes. Doc comments here
 * are always multi-line blocks, and this module contains no regular
 * expressions (architecture guard).
 */

export interface PcmAudio {
  sampleRate: number;
  samples: Int16Array;
}

export interface AudioChunk {
  /**
   * First sample (inclusive) and last sample (exclusive).
   */
  start: number;
  end: number;
}

export interface ChunkPlanOptions {
  /**
   * Longest chunk, in seconds.
   */
  maxSeconds?: number;
  /**
   * How far back from the longest cut to look for a quiet moment.
   */
  searchSeconds?: number;
  /**
   * Window the quietness is measured over, in milliseconds.
   */
  frameMs?: number;
}

export class WavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavFormatError';
  }
}

const PCM_FORMAT = 1;
const EXTENSIBLE_FORMAT = 0xfffe;

function chunkId(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Parses a RIFF/WAVE file of 16-bit mono PCM, walking every chunk (the
 * system encoder adds padding chunks such as FLLR before the data).
 */
export function parseWav16Mono(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || chunkId(view, 0) !== 'RIFF' || chunkId(view, 8) !== 'WAVE') {
    throw new WavFormatError('Not a RIFF/WAVE file.');
  }
  let offset = 12;
  let sampleRate: number | undefined;
  let data: { offset: number; length: number } | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = chunkId(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.byteLength) throw new WavFormatError('Truncated fmt chunk.');
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const bits = view.getUint16(body + 14, true);
      if ((format !== PCM_FORMAT && format !== EXTENSIBLE_FORMAT) || channels !== 1 || bits !== 16) {
        throw new WavFormatError(`Unsupported WAV layout (format ${format}, ${channels} channels, ${bits} bits).`);
      }
      sampleRate = view.getUint32(body + 4, true);
    } else if (id === 'data') {
      const length = Math.min(size, bytes.byteLength - body);
      data = { offset: body, length: length - (length % 2) };
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!sampleRate || !data) throw new WavFormatError('WAV file has no fmt or data chunk.');
  const samples = new Int16Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(data.offset + index * 2, true);
  }
  return { sampleRate, samples };
}

/**
 * A minimal 44-byte-header WAV of 16-bit mono PCM.
 */
export function encodeWav16Mono(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < 4; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(44 + index * 2, samples[index]!, true);
  return out;
}

/**
 * Mean absolute amplitude of `samples[start, end)`, 0 to 32768.
 */
export function meanAmplitude(samples: Int16Array, start: number, end: number): number {
  if (end <= start) return 0;
  let total = 0;
  for (let index = start; index < end; index += 1) total += Math.abs(samples[index]!);
  return total / (end - start);
}

/**
 * Splits audio into chunks of at most `maxSeconds`, each cut at the quietest
 * frame within the last `searchSeconds` before the limit. Deterministic.
 */
export function planAudioChunks(audio: PcmAudio, options: ChunkPlanOptions = {}): AudioChunk[] {
  const rate = audio.sampleRate;
  const total = audio.samples.length;
  const maxSamples = Math.max(1, Math.round((options.maxSeconds ?? 30) * rate));
  const searchSamples = Math.min(maxSamples - 1, Math.round((options.searchSeconds ?? 6) * rate));
  const frame = Math.max(1, Math.round(((options.frameMs ?? 50) / 1000) * rate));
  const chunks: AudioChunk[] = [];
  let start = 0;
  while (start < total) {
    if (total - start <= maxSamples) {
      chunks.push({ start, end: total });
      break;
    }
    const limit = start + maxSamples;
    let cut = limit;
    let quietest = Number.POSITIVE_INFINITY;
    for (let frameStart = limit - searchSamples; frameStart + frame <= limit; frameStart += frame) {
      const level = meanAmplitude(audio.samples, frameStart, frameStart + frame);
      if (level < quietest) {
        quietest = level;
        cut = frameStart + Math.floor(frame / 2);
      }
    }
    chunks.push({ start, end: cut });
    start = cut;
  }
  return chunks;
}
