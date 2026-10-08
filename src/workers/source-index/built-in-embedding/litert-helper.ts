// The LiteRT-LM helper: a small Bun process that loads Google's LiteRT-LM
// library through bun:ffi and embeds for the built-in provider over stdio.
// It runs apart from Olympus so a native fault cannot take the engine or the
// gateway down with it, and so a Node parent can use it too.
//
// Protocol, one JSON object per line. The parent passes the settings as the
// first argument; the helper answers
// `{"ready":true,"device":"gpu"|"cpu","vision":true|false}` or
// `{"fatal":"..."}` and exits. Then each request `{"id":N,"texts":[...]}` or
// `{"id":N,"items":[{"text":"...","image":"/abs/path.jpg"?},...]}` gets
// `{"id":N,"vectors":"<base64 float32 little-endian>","dimension":D}` (one
// vector per text or item; an item with an image is embedded as text and
// picture together, and one with an image and empty text as the picture
// alone; `"failed":[i,...]` names items whose picture could not be
// read and `"unsupported":[i,...]` items sent a picture to an engine started
// without its encoder, their vectors left as zeros) or
// `{"id":N,"error":"..."}`, with `"native":true` when LiteRT-LM itself failed
// (including pictures failing while a known-good picture fails too).

import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { EngineFaultError, KNOWN_GOOD_JPEG_BASE64, embedIsolatingPictures } from './litert-isolation.ts';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

export interface LiteRtHelperSettings {
  library: string;
  model: string;
  cacheDir: string;
  threads: number;
  /** `auto` tries the GPU first; `cpu` never asks for it. */
  device: 'auto' | 'cpu';
  maxInputTokens: number;
  /** Turns the vision encoder on (70 or 140 tokens per picture); absent keeps it off. */
  visionTokensPerImage?: number;
}

const INPUT_TEXT = 0;
/** kLiteRtLmInputDataTypeImage: the encoded file bytes (JPEG or PNG). */
const INPUT_IMAGE = 1;
/** A prepared picture is a few hundred kilobytes; a file past this is not one. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** kLiteRtLmInputOverflowStrategyChunkAndAverage: a longer input is read in pieces and averaged. */
const OVERFLOW_CHUNK_AND_AVERAGE = 0;
const ACTIVATION_FLOAT32 = 0;
const LOG_ERRORS_ONLY = 4;

function openLibrary(path: string) {
  return dlopen(path, {
    litert_lm_set_min_log_level: { args: [FFIType.i32], returns: FFIType.void },
    litert_lm_embedding_engine_settings_create: { args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring], returns: FFIType.ptr },
    litert_lm_embedding_engine_settings_set_num_threads: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
    litert_lm_embedding_engine_settings_set_cache_dir: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.void },
    litert_lm_embedding_engine_settings_set_max_input_length: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
    litert_lm_embedding_engine_settings_set_min_input_length: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
    litert_lm_embedding_engine_settings_set_activation_data_type: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
    litert_lm_embedding_engine_settings_set_vision_tokens_per_image: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
    litert_lm_embedding_engine_settings_delete: { args: [FFIType.ptr], returns: FFIType.void },
    litert_lm_embedding_engine_create: { args: [FFIType.ptr], returns: FFIType.ptr },
    litert_lm_embedding_options_create: { args: [], returns: FFIType.ptr },
    litert_lm_embedding_options_set_normalize: { args: [FFIType.ptr, FFIType.bool], returns: FFIType.void },
    litert_lm_embedding_options_set_input_overflow_strategy: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
    litert_lm_input_data_create: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
    litert_lm_input_data_delete: { args: [FFIType.ptr], returns: FFIType.void },
    litert_lm_embedding_engine_compute_embedding_batch: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.ptr },
    litert_lm_embedding_responses_get_size: { args: [FFIType.ptr], returns: FFIType.u64 },
    litert_lm_embedding_responses_get_at: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
    litert_lm_embedding_response_get_size: { args: [FFIType.ptr], returns: FFIType.u64 },
    litert_lm_embedding_response_get_values: { args: [FFIType.ptr], returns: FFIType.ptr },
    litert_lm_embedding_responses_delete: { args: [FFIType.ptr], returns: FFIType.void },
  }).symbols;
}

type LiteRt = ReturnType<typeof openLibrary>;

const cString = (value: string) => Buffer.from(`${value}\0`, 'utf8');

function createEngine(lib: LiteRt, settings: LiteRtHelperSettings, backend: 'gpu' | 'cpu', vision: boolean): Pointer | null {
  // The vision encoder runs on the same backend as the text model. Turning it
  // on leaves text vectors unchanged (cosine 1.000000 CPU, 0.999998 GPU, M3).
  const options = lib.litert_lm_embedding_engine_settings_create(cString(settings.model), cString(backend), vision ? cString(backend) : null, null);
  if (!options) return null;
  if (vision) lib.litert_lm_embedding_engine_settings_set_vision_tokens_per_image(options, settings.visionTokensPerImage!);
  lib.litert_lm_embedding_engine_settings_set_num_threads(options, settings.threads);
  lib.litert_lm_embedding_engine_settings_set_cache_dir(options, cString(settings.cacheDir));
  lib.litert_lm_embedding_engine_settings_set_max_input_length(options, settings.maxInputTokens);
  // Shorter signatures too, so a question is not padded to the longest input.
  lib.litert_lm_embedding_engine_settings_set_min_input_length(options, 128);
  // Float32 on every device: half precision is faster on the GPU but drifts
  // from the CPU's vectors (cosine 0.998, M3), and Google warns it can break.
  lib.litert_lm_embedding_engine_settings_set_activation_data_type(options, ACTIVATION_FLOAT32);
  const engine = lib.litert_lm_embedding_engine_create(options);
  lib.litert_lm_embedding_engine_settings_delete(options);
  return engine;
}

interface EmbedItem {
  text: string;
  image?: string;
  /** The engine was started without its image encoder. */
  unsupported?: boolean;
}

/** The request's items, checked before any native input exists, so a bad one leaks nothing. */
function requestItems(request: { texts?: unknown; items?: unknown }, vision: boolean): EmbedItem[] {
  const raw: unknown[] = Array.isArray(request.items)
    ? request.items
    : Array.isArray(request.texts) ? request.texts.map((text) => ({ text })) : [];
  if (!Array.isArray(request.items) && !Array.isArray(request.texts)) throw new Error('A request needs texts or items.');
  if (raw.length === 0) throw new Error('An empty batch has nothing to embed.');
  return raw.map((entry) => {
    const item = entry as { text?: unknown; image?: unknown };
    // bun:ffi cannot take a pointer to an empty buffer: an item with no text
    // is a picture alone (its image-only vector, for the photo judge).
    if (typeof item?.text !== 'string' || (item.text.length === 0 && item.image === undefined)) {
      throw new Error('Every input must be non-empty text, or a picture.');
    }
    if (item.image === undefined) return { text: item.text };
    if (typeof item.image !== 'string' || !isAbsolute(item.image)) throw new Error('An image must be an absolute file path.');
    // Without the image encoder a picture fails its own item, never the batch.
    return { text: item.text, image: item.image, ...(vision ? {} : { unsupported: true }) };
  });
}

/** The picture's encoded bytes, bounded: a regular file of at most MAX_IMAGE_BYTES. */
function readImage(path: string): Buffer {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) throw new Error('An image file is missing, empty or too large.');
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const got = readSync(fd, buffer, read, buffer.length - read, read);
      if (got === 0) break;
      read += got;
    }
    if (read !== buffer.length) throw new Error('An image file changed while it was read.');
    return buffer;
  } finally {
    closeSync(fd);
  }
}

/**
 * Embeds a batch, isolating pictures the image encoder cannot read: such an
 * item is reported in `failed` (its vector left as zeros) and every other
 * item is still embedded. A failure with no picture involved is the engine's
 * own (NativeError), and the parent replaces the helper for it.
 */
function embedBatch(
  lib: LiteRt,
  engine: Pointer,
  options: Pointer,
  items: readonly EmbedItem[],
): { vectors: Float32Array; dimension: number; failed: number[]; unsupported: number[] } {
  const failed = new Set<number>();
  const unsupported = items.flatMap((item, index) => (item.image && item.unsupported ? [index] : []));
  // Read every picture before any native input exists; an unreadable file
  // fails its own item only.
  const images = items.map((item, index) => {
    if (!item.image || item.unsupported) return undefined;
    try {
      return readImage(item.image);
    } catch {
      failed.add(index);
      return undefined;
    }
  });
  const results = new Map<number, Float32Array>();
  let dimension = 0;
  const run = (indexes: readonly number[]) => {
    const out = embedRaw(lib, engine, options, indexes.map((index) => items[index]!), indexes.map((index) => images[index]));
    dimension = out.dimension;
    indexes.forEach((index, row) => results.set(index, out.vectors.subarray(row * out.dimension, (row + 1) * out.dimension)));
  };
  const live = items.map((_, index) => index).filter((index) => !failed.has(index) && !unsupported.includes(index));
  const pictureFailures = embedIsolatingPictures(live, (index) => images[index] !== undefined, run, () => {
    const probe = Buffer.from(KNOWN_GOOD_JPEG_BASE64, 'base64');
    embedRaw(lib, engine, options, [{ text: 'probe', image: 'known-good' }], [probe]);
  });
  for (const index of pictureFailures) failed.add(index);
  const vectors = new Float32Array(dimension * items.length);
  for (const [index, vector] of results) vectors.set(vector, index * dimension);
  return { vectors, dimension, failed: [...failed].sort((left, right) => left - right), unsupported };
}

function embedRaw(
  lib: LiteRt,
  engine: Pointer,
  options: Pointer,
  items: readonly EmbedItem[],
  images: ReadonlyArray<Buffer | undefined>,
): { vectors: Float32Array; dimension: number } {
  const inputs: Array<Pointer | null> = [];
  try {
    // One item is its text, then its picture: LiteRT embeds them together.
    const perItem: Array<Array<Pointer | null>> = items.map((item, index) => {
      const parts: Array<Pointer | null> = [];
      const image = images[index];
      if (item.text.length > 0 || !image) {
        const text = Buffer.from(item.text, 'utf8');
        // input_data_create copies the bytes.
        parts.push(lib.litert_lm_input_data_create(INPUT_TEXT, ptr(text), text.length));
      }
      if (image) parts.push(lib.litert_lm_input_data_create(INPUT_IMAGE, ptr(image), image.length));
      inputs.push(...parts);
      return parts;
    });
    if (inputs.some((input) => !input)) throw new NativeError('LiteRT-LM refused an input.');
    // Each item is an array of its input pointers. These arrays are only
    // reachable through their addresses during the call, so they stay
    // referenced until it returns.
    const itemArrays = perItem.map((parts) => new BigUint64Array(parts.map((input) => BigInt(input as number))));
    const batch = new BigUint64Array(itemArrays.map((item) => BigInt(ptr(item))));
    const counts = new BigUint64Array(perItem.map((parts) => BigInt(parts.length)));
    const responses = lib.litert_lm_embedding_engine_compute_embedding_batch(engine, ptr(batch), ptr(counts), items.length, options);
    keepAlive(itemArrays, batch, counts, images);
    if (!responses) throw new NativeError('LiteRT-LM could not embed this batch.');
    try {
      const count = Number(lib.litert_lm_embedding_responses_get_size(responses));
      if (count !== items.length) throw new NativeError(`LiteRT-LM returned ${count} vectors for ${items.length} inputs.`);
      let dimension = 0;
      let vectors = new Float32Array(0);
      for (let index = 0; index < count; index += 1) {
        const response = lib.litert_lm_embedding_responses_get_at(responses, index);
        if (!response) throw new NativeError('LiteRT-LM returned a missing vector.');
        const size = Number(lib.litert_lm_embedding_response_get_size(response));
        const values = lib.litert_lm_embedding_response_get_values(response);
        if (!values || size === 0) throw new NativeError('LiteRT-LM returned an empty vector.');
        if (index === 0) {
          dimension = size;
          vectors = new Float32Array(size * count);
        } else if (size !== dimension) {
          throw new NativeError('LiteRT-LM returned vectors of different sizes.');
        }
        vectors.set(new Float32Array(toArrayBuffer(values, 0, size * 4)), index * size);
      }
      return { vectors, dimension };
    } finally {
      lib.litert_lm_embedding_responses_delete(responses);
    }
  } finally {
    for (const input of inputs) if (input) lib.litert_lm_input_data_delete(input);
  }
}

const held: { values?: unknown[] } = {};
/** Holds the given values until after a native call that reads them through raw addresses. */
function keepAlive(...values: unknown[]): void {
  held.values = values;
}

/** A failure inside LiteRT-LM itself, as opposed to a bad request: the parent replaces this helper. */
class NativeError extends EngineFaultError {}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function main(): void {
  const settings = JSON.parse(process.argv[2] ?? '{}') as LiteRtHelperSettings;
  let lib: LiteRt;
  try {
    lib = openLibrary(settings.library);
  } catch (error) {
    send({ fatal: `LiteRT-LM could not be loaded: ${error instanceof Error ? error.message : String(error)}` });
    process.exit(1);
  }
  lib.litert_lm_set_min_log_level(LOG_ERRORS_ONLY);
  mkdirSync(settings.cacheDir, { recursive: true });
  let device: 'gpu' | 'cpu' = 'cpu';
  let engine: Pointer | null = null;
  const wantsVision = settings.visionTokensPerImage !== undefined;
  let vision = false;
  // With the image encoder first, on each allowed device; without it only if
  // no device can run it (text vectors are the same either way).
  const attempts: Array<['gpu' | 'cpu', boolean]> = [
    ...(settings.device === 'auto' && wantsVision ? [['gpu', true] as ['gpu', boolean]] : []),
    ...(wantsVision ? [['cpu', true] as ['cpu', boolean]] : []),
    ...(settings.device === 'auto' ? [['gpu', false] as ['gpu', boolean]] : []),
    ['cpu', false],
  ];
  for (const [backend, withVision] of attempts) {
    engine = createEngine(lib, settings, backend, withVision);
    if (engine) {
      device = backend;
      vision = withVision;
      break;
    }
  }
  if (!engine) {
    send({ fatal: 'LiteRT-LM could not open the built-in search model.' });
    process.exit(1);
  }
  const options = lib.litert_lm_embedding_options_create()!;
  lib.litert_lm_embedding_options_set_normalize(options, true);
  // Set, not assumed: an input over the longest signature is read in pieces
  // and averaged, never cut short or refused.
  lib.litert_lm_embedding_options_set_input_overflow_strategy(options, OVERFLOW_CHUNK_AND_AVERAGE);
  send({ ready: true, device, vision });

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let id: unknown;
    try {
      const request = JSON.parse(line) as { id: number; texts?: unknown; items?: unknown };
      id = request.id;
      const { vectors, dimension, failed, unsupported } = embedBatch(lib, engine, options, requestItems(request, vision));
      send({
        id,
        dimension,
        vectors: Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength).toString('base64'),
        ...(failed.length > 0 ? { failed } : {}),
        ...(unsupported.length > 0 ? { unsupported } : {}),
      });
    } catch (error) {
      send({ id, error: error instanceof Error ? error.message : String(error), ...(error instanceof NativeError ? { native: true } : {}) });
    }
  });
  // The parent closed our input: it is gone or done with us.
  lines.on('close', () => process.exit(0));
}

if (import.meta.main) main();
