/**
 * Image preparation for media search (docs/design/photo-embeddings.md).
 *
 * Shared by MIME type, never by source: any still image the text lane reads
 * is reduced to a JPEG of at most 1,024 pixels on its long side with the
 * macOS `sips` tool (which also reads HEIC), and the result is stored
 * content-addressed in the owner-only media cache. The store attaches that
 * copy to the item's chunk, and the embedding lane hands it to a model that
 * reads images. Nothing here reaches the network.
 *
 * Off macOS there is no `sips`, and the registry does not build this at all,
 * so images keep exactly the behaviour they had before.
 *
 * Doc comments in this directory are always multi-line blocks, and this
 * module contains no regular expressions.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SIPS_PATH, writeMediaCacheFile } from '../../../core/media-cache.ts';
import type { ExtractedMedia, ExtractorOutput } from '../types.ts';
import {
  ExtractionCommandError,
  ExtractionCommandTimeoutError,
  runExtractionCommand,
  type ExtractionCommandRunner,
} from './command-runner.ts';
import { imageExtensionForMimeType } from './ocr.ts';

export const DEFAULT_IMAGE_PREPARE_TIMEOUT_MS = 60_000;
/**
 * Larger originals are skipped (`skipped_too_large`): a phone photo is a few
 * megabytes, and a scan or panorama past this is not worth a decode.
 */
export const DEFAULT_IMAGE_PREPARE_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const IMAGE_PREPARE_MAX_PIXEL_EDGE = 1_024;
/**
 * A 1,024-pixel JPEG is a few hundred kilobytes; anything past this is not
 * what `sips` was asked for.
 */
const MAX_PREPARED_BYTES = 16 * 1024 * 1024;
const TEMP_DIR_PREFIX = 'olympus-image-prepare-';
/**
 * Pictures smaller than this on either side (a logo, a tracking pixel, an
 * icon) are not worth a picture vector; they keep the text-lane
 * behaviour they had before.
 */
export const IMAGE_PREPARE_MIN_PIXEL_EDGE = 64;
const MIN_INPUT_BYTES = 1_024;

export const IMAGE_PREPARE_ERROR_FAILED = 'image_prepare_failed';
export const IMAGE_PREPARE_ERROR_TIMEOUT = 'image_prepare_timeout';
export const IMAGE_PREPARE_ERROR_CACHE_WRITE = 'media_cache_write_failed';

export interface ImagePreparationOptions {
  cacheDir: string;
  commandRunner?: ExtractionCommandRunner;
  sipsPath?: string;
  timeoutMs?: number;
  maxInputBytes?: number;
}

export interface ImagePreparationInput {
  bytes: Uint8Array;
  mimeType: string;
  sizeBytes: number;
}

/**
 * `media` on success; otherwise a settled extractor output (a failure, or
 * `skipped_too_large`). `unavailable` means the tool is missing on this
 * machine, and the caller keeps its behaviour from before.
 */
export type ImagePreparationResult =
  | { kind: 'media'; media: ExtractedMedia }
  | { kind: 'settled'; output: ExtractorOutput }
  | { kind: 'unavailable' }
  | { kind: 'too_small' };

export type ImagePreparation = (input: ImagePreparationInput) => Promise<ImagePreparationResult>;

export function createImagePreparation(options: ImagePreparationOptions): ImagePreparation {
  const commandRunner = options.commandRunner ?? runExtractionCommand;
  const sipsPath = options.sipsPath ?? SIPS_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_PREPARE_TIMEOUT_MS;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_IMAGE_PREPARE_MAX_INPUT_BYTES;
  return async (input) => {
    if (Math.max(input.sizeBytes, input.bytes.byteLength) > maxInputBytes) {
      return { kind: 'settled', output: { status: 'skipped_too_large' } };
    }
    if (input.bytes.byteLength < MIN_INPUT_BYTES) return { kind: 'too_small' };
    const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const inputPath = join(tempDir, `input${imageExtensionForMimeType(input.mimeType)}`);
      const outputPath = join(tempDir, 'prepared.jpg');
      await writeFile(inputPath, input.bytes, { mode: 0o600 });
      try {
        await commandRunner({
          command: sipsPath,
          args: [
            '-s', 'format', 'jpeg',
            '-Z', String(IMAGE_PREPARE_MAX_PIXEL_EDGE),
            inputPath,
            '--out', outputPath,
          ],
          timeoutMs,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { kind: 'unavailable' };
        if (error instanceof ExtractionCommandTimeoutError) {
          return { kind: 'settled', output: { status: 'failed_retryable', errorKind: IMAGE_PREPARE_ERROR_TIMEOUT } };
        }
        if (error instanceof ExtractionCommandError) {
          // The same bytes fail the same way every time: a damaged or
          // unsupported picture settles at once rather than retrying.
          return { kind: 'settled', output: { status: 'failed_terminal', errorKind: IMAGE_PREPARE_ERROR_FAILED } };
        }
        return { kind: 'settled', output: { status: 'failed_retryable', errorKind: IMAGE_PREPARE_ERROR_FAILED } };
      }
      let prepared: Uint8Array;
      try {
        const info = await stat(outputPath);
        if (!info.isFile() || info.size === 0 || info.size > MAX_PREPARED_BYTES) throw new Error('unusable output');
        prepared = new Uint8Array(await readFile(outputPath));
      } catch {
        return { kind: 'settled', output: { status: 'failed_terminal', errorKind: IMAGE_PREPARE_ERROR_FAILED } };
      }
      if (!isJpeg(prepared)) {
        return { kind: 'settled', output: { status: 'failed_terminal', errorKind: IMAGE_PREPARE_ERROR_FAILED } };
      }
      const size = jpegPixelSize(prepared);
      if (size && Math.min(size.width, size.height) < IMAGE_PREPARE_MIN_PIXEL_EDGE) return { kind: 'too_small' };
      try {
        const stored = writeMediaCacheFile(options.cacheDir, prepared, 'image/jpeg');
        return {
          kind: 'media',
          media: { path: stored.path, sha256: stored.sha256, mimeType: 'image/jpeg', stagingHolder: stored.stagingHolder },
        };
      } catch {
        return { kind: 'settled', output: { status: 'failed_retryable', errorKind: IMAGE_PREPARE_ERROR_CACHE_WRITE } };
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

/**
 * Width and height from a JPEG's start-of-frame segment, or undefined when
 * the header cannot be walked.
 */
export function jpegPixelSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

/**
 * The JPEG start-of-image marker.
 */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
