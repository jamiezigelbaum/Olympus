// The LiteRT-LM helper: a small Bun process that loads Google's LiteRT-LM
// library through bun:ffi and embeds for the built-in provider over stdio.
// It runs apart from Olympus so a native fault cannot take the engine or the
// gateway down with it, and so a Node parent can use it too.
//
// Protocol, one JSON object per line. The parent passes the settings as the
// first argument; the helper answers `{"ready":true,"device":"gpu"|"cpu"}` or
// `{"fatal":"..."}` and exits. Then each request `{"id":N,"texts":[...]}`
// gets `{"id":N,"vectors":"<base64 float32 little-endian>","dimension":D}`
// or `{"id":N,"error":"..."}`.

import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

export interface LiteRtHelperSettings {
  library: string;
  model: string;
  cacheDir: string;
  threads: number;
  /** `auto` tries the GPU first; `cpu` never asks for it. */
  device: 'auto' | 'cpu';
  maxInputTokens: number;
}

const INPUT_TEXT = 0;
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
    litert_lm_embedding_engine_settings_delete: { args: [FFIType.ptr], returns: FFIType.void },
    litert_lm_embedding_engine_create: { args: [FFIType.ptr], returns: FFIType.ptr },
    litert_lm_embedding_options_create: { args: [], returns: FFIType.ptr },
    litert_lm_embedding_options_set_normalize: { args: [FFIType.ptr, FFIType.bool], returns: FFIType.void },
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

function createEngine(lib: LiteRt, settings: LiteRtHelperSettings, backend: 'gpu' | 'cpu'): Pointer | null {
  const options = lib.litert_lm_embedding_engine_settings_create(cString(settings.model), cString(backend), null, null);
  if (!options) return null;
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

function embedBatch(lib: LiteRt, engine: Pointer, options: Pointer, texts: readonly string[]): { vectors: Float32Array; dimension: number } {
  const buffers = texts.map((text) => Buffer.from(text, 'utf8'));
  const inputs = buffers.map((buffer) => lib.litert_lm_input_data_create(INPUT_TEXT, ptr(buffer), buffer.length));
  try {
    if (inputs.some((input) => !input)) throw new Error('LiteRT-LM refused an input.');
    // A batch of single-input items: each item is a one-pointer array.
    const items = inputs.map((input) => new BigUint64Array([BigInt(input as number)]));
    const batch = new BigUint64Array(items.map((item) => BigInt(ptr(item))));
    const counts = new BigUint64Array(texts.length).fill(1n);
    const responses = lib.litert_lm_embedding_engine_compute_embedding_batch(engine, ptr(batch), ptr(counts), texts.length, options);
    if (!responses) throw new Error('LiteRT-LM could not embed this batch.');
    try {
      const count = Number(lib.litert_lm_embedding_responses_get_size(responses));
      if (count !== texts.length) throw new Error(`LiteRT-LM returned ${count} vectors for ${texts.length} inputs.`);
      let dimension = 0;
      let vectors = new Float32Array(0);
      for (let index = 0; index < count; index += 1) {
        const response = lib.litert_lm_embedding_responses_get_at(responses, index);
        const size = Number(lib.litert_lm_embedding_response_get_size(response));
        const values = lib.litert_lm_embedding_response_get_values(response);
        if (!values || size === 0) throw new Error('LiteRT-LM returned an empty vector.');
        if (index === 0) {
          dimension = size;
          vectors = new Float32Array(size * count);
        } else if (size !== dimension) {
          throw new Error('LiteRT-LM returned vectors of different sizes.');
        }
        vectors.set(new Float32Array(toArrayBuffer(values, 0, size * 4)), index * size);
      }
      return { vectors, dimension };
    } finally {
      lib.litert_lm_embedding_responses_delete(responses);
    }
  } finally {
    for (const input of inputs) if (input) lib.litert_lm_input_data_delete(input);
    void buffers;
  }
}

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
  if (settings.device === 'auto') {
    engine = createEngine(lib, settings, 'gpu');
    if (engine) device = 'gpu';
  }
  engine ??= createEngine(lib, settings, 'cpu');
  if (!engine) {
    send({ fatal: 'LiteRT-LM could not open the built-in search model.' });
    process.exit(1);
  }
  const options = lib.litert_lm_embedding_options_create()!;
  lib.litert_lm_embedding_options_set_normalize(options, true);
  send({ ready: true, device });

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let id: unknown;
    try {
      const request = JSON.parse(line) as { id: number; texts: string[] };
      id = request.id;
      const { vectors, dimension } = embedBatch(lib, engine, options, request.texts);
      send({ id, dimension, vectors: Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength).toString('base64') });
    } catch (error) {
      send({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
  // The parent closed our input: it is gone or done with us.
  lines.on('close', () => process.exit(0));
}

if (import.meta.main) main();
