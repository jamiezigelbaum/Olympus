/**
 * The tools that turn a still picture into the one JPEG media search reads.
 *
 * Shared by capability, never by operating system: `sips` where this machine
 * has it (macOS), `vipsthumbnail` (libvips, with libheif for HEIC) where it
 * has that, and both answer to one contract. The prepared copy is
 *
 *   - a JPEG whose long side is at most `IMAGE_PREPARE_MAX_PIXEL_EDGE`;
 *   - upright: the EXIF orientation (or the HEIC rotation and mirror) is
 *     applied to the pixels, all eight cases;
 *   - in sRGB: a wide-gamut original is converted, not just relabelled;
 *   - flat: transparency is composited onto white;
 *   - clean: no EXIF (so no location), XMP, IPTC, ICC profile, comment or
 *     thumbnail travels with it.
 *
 * Each preparer runs its tool through the injected command runner, so a test
 * drives either one without the tool, and a preparer owns nothing but how to
 * ask its tool for that contract. Settle states (too small, too large,
 * timeout, failure) belong to `createImagePreparation`, one level up.
 *
 * Doc comments in this directory are always multi-line blocks, and this
 * module contains no regular expressions.
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ExtractionCommandRunner } from './command-runner.ts';
import {
  iccProfileColorSpace,
  iccProfileIsSrgb,
  jpegExifOrientation,
  jpegIccProfile,
  stripJpegMetadata,
} from './jpeg-metadata.ts';

/**
 * The tool still images are prepared with on a Mac; it ships with macOS only.
 */
export const SIPS_PATH = '/usr/bin/sips';
export const VIPSTHUMBNAIL_COMMAND = 'vipsthumbnail';
export const IMAGE_PREPARE_MAX_PIXEL_EDGE = 1_024;
/**
 * A 1,024-pixel JPEG is a few hundred kilobytes; anything past this is not
 * what the tool was asked for.
 */
export const MAX_PREPARED_BYTES = 16 * 1024 * 1024;
const SRGB_PROFILE_PATH = '/System/Library/ColorSync/Profiles/sRGB Profile.icc';
const VIPS_JPEG_QUALITY = 85;

export type StillImageToolKind = 'sips' | 'vips';

export interface StillImagePreparerContext {
  /**
   * The original picture, in a directory the caller owns and removes.
   */
  inputPath: string;
  tempDir: string;
  timeoutMs: number;
  commandRunner: ExtractionCommandRunner;
}

export interface StillImagePreparer {
  readonly kind: StillImageToolKind;
  readonly command: string;
  /**
   * The command line that decodes `inputPath` to a JPEG at `outputPath`,
   * at most `IMAGE_PREPARE_MAX_PIXEL_EDGE` on its long side. It is the first
   * step of `prepare` and, on its own, the capability probe's question:
   * can this machine decode this format at all.
   */
  decodeArgs(inputPath: string, outputPath: string): string[];
  /**
   * Runs the tool to the contract above and returns the finished JPEG bytes
   * (which the caller still validates). Throws the command runner's errors
   * unchanged, and `PreparedOutputError` when the tool left no usable file.
   */
  prepare(context: StillImagePreparerContext): Promise<Uint8Array>;
}

/**
 * The tool exited cleanly but left nothing usable: no file, an empty file, or
 * one larger than a prepared picture can be.
 */
export class PreparedOutputError extends Error {
  constructor() {
    super('The image tool left no usable output.');
    this.name = 'PreparedOutputError';
  }
}

export function readPreparedOutput(path: string): Uint8Array {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_PREPARED_BYTES) throw new PreparedOutputError();
    return new Uint8Array(readFileSync(path));
  } catch {
    throw new PreparedOutputError();
  }
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * What `sips` is asked to do to a JPEG so its pixels end up upright, by EXIF
 * orientation. `sips` reads the orientation (a JPEG's, or a HEIC's rotation
 * and mirror, which it reports as the same tag) but leaves the pixels as
 * stored, so the turn is applied here. Flips and rotations run in the order
 * given; 5 and 7 are the two transposes. Checked against a reference turn of
 * a four-colour picture for each of the eight values.
 */
export const SIPS_ORIENTATION_ARGS: Readonly<Record<number, readonly string[]>> = {
  1: [],
  2: ['-f', 'horizontal'],
  3: ['-r', '180'],
  4: ['-f', 'vertical'],
  5: ['-r', '270', '-f', 'horizontal'],
  6: ['-r', '90'],
  7: ['-r', '90', '-f', 'horizontal'],
  8: ['-r', '270'],
};

export interface SipsPreparerOptions {
  path?: string;
  /**
   * The sRGB profile to convert wide-gamut pictures to; absent means no conversion.
   */
  srgbProfilePath?: string | undefined;
  profileExists?: (path: string) => boolean;
}

/**
 * macOS. The first command is the one this tool has always been given (a
 * JPEG of at most 1,024 pixels); what the contract adds is done afterwards:
 * a second `sips` pass turns the pixels upright and converts a wide-gamut
 * picture to sRGB (only when either is needed, so an ordinary upright sRGB
 * photo is not recompressed), then every metadata segment is cut from the
 * JPEG without touching its image data. `sips` has no switch for deleting
 * EXIF and GPS from a file, which is why the removal is done on the bytes.
 */
export function createSipsPreparer(options: SipsPreparerOptions = {}): StillImagePreparer {
  const command = options.path ?? SIPS_PATH;
  const profileExists = options.profileExists ?? existsSync;
  const srgbProfile = options.srgbProfilePath !== undefined
    ? options.srgbProfilePath
    : (profileExists(SRGB_PROFILE_PATH) ? SRGB_PROFILE_PATH : undefined);
  const decodeArgs = (inputPath: string, outputPath: string): string[] => [
    '-s', 'format', 'jpeg',
    '-Z', String(IMAGE_PREPARE_MAX_PIXEL_EDGE),
    inputPath,
    '--out', outputPath,
  ];
  return {
    kind: 'sips',
    command,
    decodeArgs,
    async prepare(context) {
      const first = join(context.tempDir, 'prepared.jpg');
      await context.commandRunner({
        command,
        args: decodeArgs(context.inputPath, first),
        timeoutMs: context.timeoutMs,
      });
      let bytes = readPreparedOutput(first);
      if (!isJpeg(bytes)) return bytes;
      const orientation = jpegExifOrientation(bytes);
      const profile = jpegIccProfile(bytes);
      // Only a profile for RGB pixels can be matched to sRGB; a grey or other
      // profile is left alone (its metadata is removed below either way).
      const needsMatch = srgbProfile !== undefined
        && profile !== undefined
        && iccProfileColorSpace(profile) === 'RGB '
        && !iccProfileIsSrgb(profile);
      const turn = SIPS_ORIENTATION_ARGS[orientation] ?? [];
      if (needsMatch || turn.length > 0) {
        const second = join(context.tempDir, 'upright.jpg');
        await context.commandRunner({
          command,
          args: [...(needsMatch ? ['-m', srgbProfile] : []), ...turn, first, '--out', second],
          timeoutMs: context.timeoutMs,
        });
        bytes = readPreparedOutput(second);
      }
      return stripJpegMetadata(bytes);
    },
  };
}

export interface VipsPreparerOptions {
  path?: string;
}

/**
 * libvips. One command does the whole contract: shrink only (never enlarge)
 * to the long-side limit, apply the orientation (libheif has already applied
 * a HEIC's own rotation and mirror), convert to sRGB, composite transparency
 * onto white, and write a JPEG with every metadata block stripped. The
 * metadata is also cut from the output bytes, so a libvips build that kept a
 * block would not leak it.
 *
 * Neither the input nor the output path may contain a square bracket: libvips
 * reads `name[options]`. Callers build both inside a fresh temp directory.
 */
export function createVipsPreparer(options: VipsPreparerOptions = {}): StillImagePreparer {
  const command = options.path ?? VIPSTHUMBNAIL_COMMAND;
  const edge = String(IMAGE_PREPARE_MAX_PIXEL_EDGE);
  const decodeArgs = (inputPath: string, outputPath: string): string[] => [
    inputPath,
    '--size', `${edge}x${edge}>`,
    '--rotate',
    '--export-profile', 'srgb',
    '-o', `${outputPath}[Q=${VIPS_JPEG_QUALITY},strip,background=255]`,
  ];
  return {
    kind: 'vips',
    command,
    decodeArgs,
    async prepare(context) {
      const output = join(context.tempDir, 'prepared.jpg');
      await context.commandRunner({
        command,
        args: decodeArgs(context.inputPath, output),
        timeoutMs: context.timeoutMs,
      });
      const bytes = readPreparedOutput(output);
      return isJpeg(bytes) ? stripJpegMetadata(bytes) : bytes;
    },
  };
}

/**
 * The executable `name` resolves to on `PATH`, or undefined. A directory
 * search rather than a spawn, so asking is free.
 */
export function findExecutable(
  name: string,
  searchPath: string | undefined = process.env.PATH,
): string | undefined {
  if (!searchPath) return undefined;
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

export interface SelectedStillImageTool {
  kind: StillImageToolKind;
  path: string;
}

/**
 * The tool this machine prepares pictures with: `sips` when it is there (a
 * Mac, unchanged), otherwise `vipsthumbnail` on the search path, otherwise
 * none. A capability, not an operating-system name.
 */
export function selectStillImageTool(options: {
  sipsPath?: string;
  searchPath?: string | undefined;
  exists?: (path: string) => boolean;
} = {}): SelectedStillImageTool | undefined {
  const sipsPath = options.sipsPath ?? SIPS_PATH;
  if ((options.exists ?? existsSync)(sipsPath)) return { kind: 'sips', path: sipsPath };
  const vips = findExecutable(VIPSTHUMBNAIL_COMMAND, options.searchPath ?? process.env.PATH);
  return vips ? { kind: 'vips', path: vips } : undefined;
}

export function createStillImagePreparer(tool: SelectedStillImageTool): StillImagePreparer {
  return tool.kind === 'sips' ? createSipsPreparer({ path: tool.path }) : createVipsPreparer({ path: tool.path });
}
