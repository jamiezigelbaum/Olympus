/**
 * Image preparation for media search (docs/design/photo-embeddings.md).
 *
 * Shared by MIME type, never by source: any still image the text lane reads
 * is reduced to a JPEG of at most 1,024 pixels on its long side by the
 * preparation tool this machine has (`sips` on a Mac, `vipsthumbnail` where
 * libvips is installed; `image-preparers.ts`), and the result is stored
 * content-addressed in the owner-only media cache. The store attaches that
 * copy to the item's chunk, and the embedding lane hands it to a model that
 * reads images. Nothing here reaches the network.
 *
 * The prepared copy is upright, in sRGB, flat (no transparency) and carries
 * no metadata, whichever tool made it. A format the machine's probe found
 * undecodable is answered `unavailable` without running any tool, so the
 * caller keeps the behaviour it had before pictures were read; and a picture
 * whose header declares more pixels than a decoder should hold is
 * `skipped_too_large` before any tool sees it.
 *
 * Doc comments in this directory are always multi-line blocks, and this
 * module contains no regular expressions.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMediaCacheFile } from '../../../core/media-cache.ts';
import {
  IMAGE_MAX_DECLARED_PIXELS,
  imageDeclaredDimensions,
  jpegPixelSize,
  stillImageFormatForMimeType,
  stillImageFormatFromBytes,
  type StillImageFormat,
} from '../../../core/still-image-formats.ts';
import type { ExtractedMedia, ExtractorOutput } from '../types.ts';
import {
  ExtractionCommandError,
  ExtractionCommandTimeoutError,
  runExtractionCommand,
  type ExtractionCommandRunner,
} from './command-runner.ts';
import {
  IMAGE_PREPARE_MAX_PIXEL_EDGE,
  PreparedOutputError,
  createSipsPreparer,
  type StillImagePreparer,
} from './image-preparers.ts';
import { imageExtensionForMimeType } from './ocr.ts';

export { IMAGE_PREPARE_MAX_PIXEL_EDGE, jpegPixelSize };

export const DEFAULT_IMAGE_PREPARE_TIMEOUT_MS = 60_000;
/**
 * Larger originals are skipped (`skipped_too_large`): a phone photo is a few
 * megabytes, and a scan or panorama past this is not worth a decode.
 */
export const DEFAULT_IMAGE_PREPARE_MAX_INPUT_BYTES = 64 * 1024 * 1024;
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
  /**
   * The `sips` to use when no `preparer` is given (the macOS default).
   */
  sipsPath?: string;
  /**
   * The tool that prepares pictures (or a function asked each time); defaults to `sips`.
   */
  preparer?: StillImagePreparer | (() => StillImagePreparer);
  /**
   * The formats this machine can prepare, or a function asked each time (the
   * machine's probe). Absent means every format is attempted. A format
   * outside it is `unavailable` and no tool runs.
   */
  formats?: ReadonlySet<StillImageFormat> | (() => ReadonlySet<StillImageFormat>);
  timeoutMs?: number;
  maxInputBytes?: number;
  /**
   * Most pixels a picture may declare before it is skipped.
   */
  maxPixels?: number;
}

export interface ImagePreparationInput {
  bytes: Uint8Array;
  mimeType: string;
  sizeBytes: number;
}

/**
 * `media` on success; otherwise a settled extractor output (a failure, or
 * `skipped_too_large`). `unavailable` means the tool is missing on this
 * machine, or cannot decode this format, and the caller keeps its behaviour
 * from before.
 */
export type ImagePreparationResult =
  | { kind: 'media'; media: ExtractedMedia }
  | { kind: 'settled'; output: ExtractorOutput }
  | { kind: 'unavailable' }
  | { kind: 'too_small' };

/**
 * A preparation, and the question the text lane asks of it before queueing a
 * picture: can this media type be prepared here. Absent, every type can.
 */
export type ImagePreparation = ((input: ImagePreparationInput) => Promise<ImagePreparationResult>) & {
  ready?: (mimeType: string | undefined) => boolean;
};

export function createImagePreparation(options: ImagePreparationOptions): ImagePreparation {
  const commandRunner = options.commandRunner ?? runExtractionCommand;
  const fixedPreparer = typeof options.preparer === 'function' ? undefined : options.preparer;
  const defaultPreparer = fixedPreparer ?? (options.preparer === undefined
    ? createSipsPreparer(options.sipsPath !== undefined ? { path: options.sipsPath } : {})
    : undefined);
  const currentPreparer = (): StillImagePreparer => defaultPreparer
    ?? (options.preparer as () => StillImagePreparer)();
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_PREPARE_TIMEOUT_MS;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_IMAGE_PREPARE_MAX_INPUT_BYTES;
  const maxPixels = options.maxPixels ?? IMAGE_MAX_DECLARED_PIXELS;
  const admitted = (format: StillImageFormat | undefined): boolean => {
    if (options.formats === undefined || format === undefined) return true;
    const formats = typeof options.formats === 'function' ? options.formats() : options.formats;
    return formats.has(format);
  };
  const prepare: ImagePreparation = async (input) => {
    // First of all, so a format this machine cannot decode behaves exactly as
    // it did before pictures were read: no size verdict, no tool. The bytes
    // are what a decoder will meet; the media type is only a label.
    if (!admitted(stillImageFormatFromBytes(input.bytes) ?? stillImageFormatForMimeType(input.mimeType))) {
      return { kind: 'unavailable' };
    }
    if (Math.max(input.sizeBytes, input.bytes.byteLength) > maxInputBytes) {
      return { kind: 'settled', output: { status: 'skipped_too_large' } };
    }
    // A decompression bomb is a few kilobytes that declare billions of
    // pixels: the header says so before any decoder is asked.
    const declared = imageDeclaredDimensions(input.bytes);
    if (declared && declared.width * declared.height > maxPixels) {
      return { kind: 'settled', output: { status: 'skipped_too_large' } };
    }
    if (input.bytes.byteLength < MIN_INPUT_BYTES) return { kind: 'too_small' };
    // Judged on the original: a tool that enlarges (`sips -Z` does) must not
    // turn an icon into a picture.
    if (declared && Math.min(declared.width, declared.height) < IMAGE_PREPARE_MIN_PIXEL_EDGE) {
      return { kind: 'too_small' };
    }
    const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const inputPath = join(tempDir, `input${imageExtensionForMimeType(input.mimeType)}`);
      await writeFile(inputPath, input.bytes, { mode: 0o600 });
      let prepared: Uint8Array;
      try {
        prepared = await currentPreparer().prepare({ inputPath, tempDir, timeoutMs, commandRunner });
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { kind: 'unavailable' };
        if (error instanceof ExtractionCommandTimeoutError) {
          return { kind: 'settled', output: { status: 'failed_retryable', errorKind: IMAGE_PREPARE_ERROR_TIMEOUT } };
        }
        if (error instanceof ExtractionCommandError || error instanceof PreparedOutputError) {
          // The same bytes fail the same way every time: a damaged or
          // unsupported picture settles at once rather than retrying.
          return { kind: 'settled', output: { status: 'failed_terminal', errorKind: IMAGE_PREPARE_ERROR_FAILED } };
        }
        return { kind: 'settled', output: { status: 'failed_retryable', errorKind: IMAGE_PREPARE_ERROR_FAILED } };
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
  prepare.ready = (mimeType) => admitted(stillImageFormatForMimeType(mimeType));
  return prepare;
}

/**
 * The JPEG start-of-image marker.
 */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
