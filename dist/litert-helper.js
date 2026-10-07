// @bun
// src/workers/source-index/built-in-embedding/litert-helper.ts
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from "fs";
import { isAbsolute } from "path";
import { createInterface } from "readline";
var INPUT_TEXT = 0;
var INPUT_IMAGE = 1;
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;
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
    litert_lm_embedding_responses_delete: { args: [FFIType.ptr], returns: FFIType.void }
  }).symbols;
}
var cString = (value) => Buffer.from(`${value}\x00`, "utf8");
function createEngine(lib, settings, backend, vision) {
  const options = lib.litert_lm_embedding_engine_settings_create(cString(settings.model), cString(backend), vision ? cString(backend) : null, null);
  if (!options)
    return null;
  if (vision)
    lib.litert_lm_embedding_engine_settings_set_vision_tokens_per_image(options, settings.visionTokensPerImage);
  lib.litert_lm_embedding_engine_settings_set_num_threads(options, settings.threads);
  lib.litert_lm_embedding_engine_settings_set_cache_dir(options, cString(settings.cacheDir));
  lib.litert_lm_embedding_engine_settings_set_max_input_length(options, settings.maxInputTokens);
  lib.litert_lm_embedding_engine_settings_set_min_input_length(options, 128);
  lib.litert_lm_embedding_engine_settings_set_activation_data_type(options, ACTIVATION_FLOAT32);
  const engine = lib.litert_lm_embedding_engine_create(options);
  lib.litert_lm_embedding_engine_settings_delete(options);
  return engine;
}
function requestItems(request, vision) {
  const raw = Array.isArray(request.items) ? request.items : Array.isArray(request.texts) ? request.texts.map((text) => ({ text })) : [];
  if (!Array.isArray(request.items) && !Array.isArray(request.texts))
    throw new Error("A request needs texts or items.");
  if (raw.length === 0)
    throw new Error("An empty batch has nothing to embed.");
  return raw.map((entry) => {
    const item = entry;
    if (typeof item?.text !== "string" || item.text.length === 0)
      throw new Error("Every input must be non-empty text.");
    if (item.image === undefined)
      return { text: item.text };
    if (typeof item.image !== "string" || !isAbsolute(item.image))
      throw new Error("An image must be an absolute file path.");
    if (!vision)
      throw new Error("This model was started without its image encoder.");
    return { text: item.text, image: item.image };
  });
}
function readImage(path) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES)
      throw new Error("An image file is missing, empty or too large.");
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const got = readSync(fd, buffer, read, buffer.length - read, read);
      if (got === 0)
        break;
      read += got;
    }
    if (read !== buffer.length)
      throw new Error("An image file changed while it was read.");
    return buffer;
  } finally {
    closeSync(fd);
  }
}
function embedBatch(lib, engine, options, items) {
  const images = items.map((item) => item.image ? readImage(item.image) : undefined);
  const inputs = [];
  try {
    const perItem = items.map((item, index) => {
      const parts = [];
      const text = Buffer.from(item.text, "utf8");
      parts.push(lib.litert_lm_input_data_create(INPUT_TEXT, ptr(text), text.length));
      const image = images[index];
      if (image)
        parts.push(lib.litert_lm_input_data_create(INPUT_IMAGE, ptr(image), image.length));
      inputs.push(...parts);
      return parts;
    });
    if (inputs.some((input) => !input))
      throw new NativeError("LiteRT-LM refused an input.");
    const itemArrays = perItem.map((parts) => new BigUint64Array(parts.map((input) => BigInt(input))));
    const batch = new BigUint64Array(itemArrays.map((item) => BigInt(ptr(item))));
    const counts = new BigUint64Array(perItem.map((parts) => BigInt(parts.length)));
    const responses = lib.litert_lm_embedding_engine_compute_embedding_batch(engine, ptr(batch), ptr(counts), items.length, options);
    keepAlive(itemArrays, batch, counts, images);
    if (!responses)
      throw new NativeError("LiteRT-LM could not embed this batch.");
    try {
      const count = Number(lib.litert_lm_embedding_responses_get_size(responses));
      if (count !== items.length)
        throw new NativeError(`LiteRT-LM returned ${count} vectors for ${items.length} inputs.`);
      let dimension = 0;
      let vectors = new Float32Array(0);
      for (let index = 0;index < count; index += 1) {
        const response = lib.litert_lm_embedding_responses_get_at(responses, index);
        if (!response)
          throw new NativeError("LiteRT-LM returned a missing vector.");
        const size = Number(lib.litert_lm_embedding_response_get_size(response));
        const values = lib.litert_lm_embedding_response_get_values(response);
        if (!values || size === 0)
          throw new NativeError("LiteRT-LM returned an empty vector.");
        if (index === 0) {
          dimension = size;
          vectors = new Float32Array(size * count);
        } else if (size !== dimension) {
          throw new NativeError("LiteRT-LM returned vectors of different sizes.");
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

class NativeError extends Error {
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
  const wantsVision = settings.visionTokensPerImage !== undefined;
  let vision = false;
  const attempts = [
    ...settings.device === "auto" && wantsVision ? [["gpu", true]] : [],
    ...wantsVision ? [["cpu", true]] : [],
    ...settings.device === "auto" ? [["gpu", false]] : [],
    ["cpu", false]
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
    send({ fatal: "LiteRT-LM could not open the built-in search model." });
    process.exit(1);
  }
  const options = lib.litert_lm_embedding_options_create();
  lib.litert_lm_embedding_options_set_normalize(options, true);
  lib.litert_lm_embedding_options_set_input_overflow_strategy(options, OVERFLOW_CHUNK_AND_AVERAGE);
  send({ ready: true, device, vision });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let id;
    try {
      const request = JSON.parse(line);
      id = request.id;
      const { vectors, dimension } = embedBatch(lib, engine, options, requestItems(request, vision));
      send({ id, dimension, vectors: Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength).toString("base64") });
    } catch (error) {
      send({ id, error: error instanceof Error ? error.message : String(error), ...error instanceof NativeError ? { native: true } : {} });
    }
  });
  lines.on("close", () => process.exit(0));
}
if (import.meta.main)
  main();
