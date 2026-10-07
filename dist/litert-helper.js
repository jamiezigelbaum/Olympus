// @bun
// src/workers/source-index/built-in-embedding/litert-helper.ts
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { mkdirSync } from "fs";
import { createInterface } from "readline";
var INPUT_TEXT = 0;
var OVERFLOW_CHUNK_AND_AVERAGE = 0;
var ACTIVATION_FLOAT32 = 0;
var LOG_ERRORS_ONLY = 4;
function openLibrary(path) {
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
    litert_lm_embedding_options_set_input_overflow_strategy: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
    litert_lm_input_data_create: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
    litert_lm_input_data_delete: { args: [FFIType.ptr], returns: FFIType.void },
    litert_lm_embedding_engine_compute_embedding_batch: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.ptr },
    litert_lm_embedding_responses_get_size: { args: [FFIType.ptr], returns: FFIType.u64 },
    litert_lm_embedding_responses_get_at: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
    litert_lm_embedding_response_get_size: { args: [FFIType.ptr], returns: FFIType.u64 },
    litert_lm_embedding_response_get_values: { args: [FFIType.ptr], returns: FFIType.ptr },
    litert_lm_embedding_responses_delete: { args: [FFIType.ptr], returns: FFIType.void }
  }).symbols;
}
var cString = (value) => Buffer.from(`${value}\x00`, "utf8");
function createEngine(lib, settings, backend) {
  const options = lib.litert_lm_embedding_engine_settings_create(cString(settings.model), cString(backend), null, null);
  if (!options)
    return null;
  lib.litert_lm_embedding_engine_settings_set_num_threads(options, settings.threads);
  lib.litert_lm_embedding_engine_settings_set_cache_dir(options, cString(settings.cacheDir));
  lib.litert_lm_embedding_engine_settings_set_max_input_length(options, settings.maxInputTokens);
  lib.litert_lm_embedding_engine_settings_set_min_input_length(options, 128);
  lib.litert_lm_embedding_engine_settings_set_activation_data_type(options, ACTIVATION_FLOAT32);
  const engine = lib.litert_lm_embedding_engine_create(options);
  lib.litert_lm_embedding_engine_settings_delete(options);
  return engine;
}
function embedBatch(lib, engine, options, texts) {
  if (texts.length === 0)
    throw new Error("An empty batch has nothing to embed.");
  if (texts.some((text) => typeof text !== "string" || text.length === 0))
    throw new Error("Every input must be non-empty text.");
  const inputs = [];
  try {
    for (const text of texts) {
      const buffer = Buffer.from(text, "utf8");
      inputs.push(lib.litert_lm_input_data_create(INPUT_TEXT, ptr(buffer), buffer.length));
    }
    if (inputs.some((input) => !input))
      throw new Error("LiteRT-LM refused an input.");
    const items = inputs.map((input) => new BigUint64Array([BigInt(input)]));
    const batch = new BigUint64Array(items.map((item) => BigInt(ptr(item))));
    const counts = new BigUint64Array(texts.length).fill(1n);
    const responses = lib.litert_lm_embedding_engine_compute_embedding_batch(engine, ptr(batch), ptr(counts), texts.length, options);
    keepAlive(items, batch, counts);
    if (!responses)
      throw new Error("LiteRT-LM could not embed this batch.");
    try {
      const count = Number(lib.litert_lm_embedding_responses_get_size(responses));
      if (count !== texts.length)
        throw new Error(`LiteRT-LM returned ${count} vectors for ${texts.length} inputs.`);
      let dimension = 0;
      let vectors = new Float32Array(0);
      for (let index = 0;index < count; index += 1) {
        const response = lib.litert_lm_embedding_responses_get_at(responses, index);
        if (!response)
          throw new Error("LiteRT-LM returned a missing vector.");
        const size = Number(lib.litert_lm_embedding_response_get_size(response));
        const values = lib.litert_lm_embedding_response_get_values(response);
        if (!values || size === 0)
          throw new Error("LiteRT-LM returned an empty vector.");
        if (index === 0) {
          dimension = size;
          vectors = new Float32Array(size * count);
        } else if (size !== dimension) {
          throw new Error("LiteRT-LM returned vectors of different sizes.");
        }
        vectors.set(new Float32Array(toArrayBuffer(values, 0, size * 4)), index * size);
      }
      return { vectors, dimension };
    } finally {
      lib.litert_lm_embedding_responses_delete(responses);
    }
  } finally {
    for (const input of inputs)
      if (input)
        lib.litert_lm_input_data_delete(input);
  }
}
var held = {};
function keepAlive(...values) {
  held.values = values;
}
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}
`);
}
function main() {
  const settings = JSON.parse(process.argv[2] ?? "{}");
  let lib;
  try {
    lib = openLibrary(settings.library);
  } catch (error) {
    send({ fatal: `LiteRT-LM could not be loaded: ${error instanceof Error ? error.message : String(error)}` });
    process.exit(1);
  }
  lib.litert_lm_set_min_log_level(LOG_ERRORS_ONLY);
  mkdirSync(settings.cacheDir, { recursive: true });
  let device = "cpu";
  let engine = null;
  if (settings.device === "auto") {
    engine = createEngine(lib, settings, "gpu");
    if (engine)
      device = "gpu";
  }
  engine ??= createEngine(lib, settings, "cpu");
  if (!engine) {
    send({ fatal: "LiteRT-LM could not open the built-in search model." });
    process.exit(1);
  }
  const options = lib.litert_lm_embedding_options_create();
  lib.litert_lm_embedding_options_set_normalize(options, true);
  lib.litert_lm_embedding_options_set_input_overflow_strategy(options, OVERFLOW_CHUNK_AND_AVERAGE);
  send({ ready: true, device });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let id;
    try {
      const request = JSON.parse(line);
      if (!Array.isArray(request.texts))
        throw new Error("A request needs texts.");
      id = request.id;
      const { vectors, dimension } = embedBatch(lib, engine, options, request.texts);
      send({ id, dimension, vectors: Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength).toString("base64") });
    } catch (error) {
      send({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
  lines.on("close", () => process.exit(0));
}
if (import.meta.main)
  main();
