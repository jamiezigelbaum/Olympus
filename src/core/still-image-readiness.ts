/**
 * Which still-image formats this machine can prepare for media search, asked
 * of the machine itself.
 *
 * One answer per format, not one yes or no. A host with libvips but without
 * HEIC support reads JPEG, PNG, WebP, GIF, TIFF and BMP and leaves HEIC
 * names-only; the ingestion policy, the extractor, the extraction candidates
 * and the status all read the same answer from here, so none of them admits
 * what another would refuse.
 *
 * The answer comes from a probe, never from the operating system's name or a
 * tool's presence: a tiny real picture of each format is prepared by the
 * tool this machine has (`sips`, else `vipsthumbnail`), and the format is
 * ready only if a JPEG of the right shape comes back. Nothing here reaches
 * the network or reads the owner's files.
 *
 * Whether the built-in model's image encoder started is the other half of
 * "photos are searchable by content": a text-only start would read pictures
 * and then hold them forever, so a recorded failure of the encoder makes
 * every format not ready, and says why.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IMAGE_PREPARE_MAX_PIXEL_EDGE,
  createStillImagePreparer,
  selectStillImageTool,
  type SelectedStillImageTool,
  type StillImageToolKind,
} from '../workers/file-extraction/extractors/image-preparers.ts';
import { STILL_IMAGE_PROBE_FIXTURES, STILL_IMAGE_PROBE_SIZES } from './still-image-probe-fixtures.ts';
import {
  STILL_IMAGE_FORMATS,
  jpegPixelSize,
  stillImageFileExtension,
  type StillImageFormat,
} from './still-image-formats.ts';
import { readBuiltInEmbeddingVision } from '../workers/source-index/built-in-embedding/assets.ts';

/**
 * Why a format is not ready: no tool at all, a tool that cannot decode it, or
 * a model whose image encoder did not start (so a decoded picture would never
 * be read).
 */
export type StillImageMissingReason = 'no_tool' | 'cannot_decode' | 'vision_unavailable';

export interface StillImageFormatReadiness {
  ready: boolean;
  reason?: StillImageMissingReason;
}

export type StillImageVisionState = 'ready' | 'unavailable' | 'unknown';

export interface StillImageReadiness {
  tool: StillImageToolKind | 'none';
  toolPath?: string;
  formats: Readonly<Record<StillImageFormat, StillImageFormatReadiness>>;
  vision: StillImageVisionState;
  probedAt: string;
}

export interface SyncRunResult {
  ok: boolean;
}

export type SyncRun = (command: string, args: string[], timeoutMs: number) => SyncRunResult;

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

function spawnRun(command: string, args: string[], timeoutMs: number): SyncRunResult {
  const result = spawnSync(command, args, { stdio: 'ignore', timeout: timeoutMs, killSignal: 'SIGKILL' });
  return { ok: !result.error && result.status === 0 };
}

export interface StillImageProbeOptions {
  /** The tool to probe; `undefined` finds one, `null` means there is none. */
  tool?: SelectedStillImageTool | null;
  /** Fixtures by format (base64); defaults to the shipped ones. */
  fixtures?: Readonly<Record<StillImageFormat, string>>;
  run?: SyncRun;
  vision?: StillImageVisionState;
  timeoutMs?: number;
  now?: () => Date;
}

function isJpegBytes(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * A decoded fixture is a JPEG of the fixture's own shape. The tool may shrink
 * or enlarge it, so the shape is its aspect ratio, which a tool that failed
 * to decode (or decoded something else) will not reproduce.
 */
function looksLikeDecodedFixture(bytes: Uint8Array, format: StillImageFormat): boolean {
  if (!isJpegBytes(bytes)) return false;
  const size = jpegPixelSize(bytes);
  if (!size || size.width < 1 || size.height < 1) return false;
  if (Math.max(size.width, size.height) > IMAGE_PREPARE_MAX_PIXEL_EDGE) return false;
  const probe = STILL_IMAGE_PROBE_SIZES[format];
  const expected = probe.width / probe.height;
  return Math.abs(size.width / size.height - expected) < 0.05;
}

function readVision(): StillImageVisionState {
  try {
    return readBuiltInEmbeddingVision();
  } catch {
    return 'unknown';
  }
}

/**
 * Prepares one fixture per admitted format with the machine's own tool and
 * reports which ones came back. Synchronous on purpose: the ingestion policy
 * and the readiness ladder that read it are synchronous. Takes well under a
 * second where a tool is present, and no time where none is.
 */
export function probeStillImageReadiness(options: StillImageProbeOptions = {}): StillImageReadiness {
  const tool = options.tool === undefined ? selectStillImageTool() : options.tool ?? undefined;
  const vision = options.vision ?? readVision();
  const probedAt = (options.now?.() ?? new Date()).toISOString();
  const missing = (reason: StillImageMissingReason): Record<StillImageFormat, StillImageFormatReadiness> => Object.fromEntries(
    STILL_IMAGE_FORMATS.map((format) => [format, { ready: false, reason }]),
  ) as Record<StillImageFormat, StillImageFormatReadiness>;
  if (!tool) return { tool: 'none', formats: missing('no_tool'), vision, probedAt };

  const preparer = createStillImagePreparer(tool);
  const run = options.run ?? spawnRun;
  const fixtures = options.fixtures ?? STILL_IMAGE_PROBE_FIXTURES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const decoded = {} as Record<StillImageFormat, boolean>;
  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), 'olympus-image-probe-'));
    for (const format of STILL_IMAGE_FORMATS) {
      const inputPath = join(directory, `probe-${format}${stillImageFileExtension(format)}`);
      const outputPath = join(directory, `probe-${format}.jpg`);
      try {
        writeFileSync(inputPath, Buffer.from(fixtures[format], 'base64'), { mode: 0o600 });
        const result = run(preparer.command, preparer.decodeArgs(inputPath, outputPath), timeoutMs);
        decoded[format] = result.ok && looksLikeDecodedFixture(new Uint8Array(readFileSync(outputPath)), format);
      } catch {
        decoded[format] = false;
      }
    }
  } catch {
    for (const format of STILL_IMAGE_FORMATS) decoded[format] = false;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
  const blocked = vision === 'unavailable';
  const formats = Object.fromEntries(STILL_IMAGE_FORMATS.map((format) => [
    format,
    !decoded[format]
      ? { ready: false, reason: 'cannot_decode' as const }
      : blocked ? { ready: false, reason: 'vision_unavailable' as const } : { ready: true },
  ])) as Record<StillImageFormat, StillImageFormatReadiness>;
  return { tool: tool.kind, toolPath: tool.path, formats, vision, probedAt };
}

/** The formats a readiness answer admits. */
export function readyStillImageFormats(readiness: StillImageReadiness = stillImageReadiness()): ReadonlySet<StillImageFormat> {
  return new Set(STILL_IMAGE_FORMATS.filter((format) => readiness.formats[format].ready));
}

/**
 * A readiness answer in which exactly `ready` are admitted. For callers that
 * hold a plain yes or no (`true`: every format; `false`: none) and for tests.
 */
export function stillImageReadinessOf(
  ready: boolean | Iterable<StillImageFormat>,
  overrides: Partial<StillImageReadiness> = {},
): StillImageReadiness {
  const admitted = ready === true ? new Set<StillImageFormat>(STILL_IMAGE_FORMATS)
    : ready === false ? new Set<StillImageFormat>()
      : new Set<StillImageFormat>(ready);
  return {
    tool: admitted.size > 0 ? 'vips' : 'none',
    formats: Object.fromEntries(STILL_IMAGE_FORMATS.map((format) => [
      format,
      admitted.has(format) ? { ready: true } : { ready: false, reason: 'cannot_decode' as const },
    ])) as Record<StillImageFormat, StillImageFormatReadiness>,
    vision: 'unknown',
    probedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

/**
 * What the process has probed. The tool and what it decodes are asked once
 * (they only change when something is installed, which needs a restart); the
 * model's image-encoder state is not: the provider records it after its model
 * loads, which can be after the first question, and another process may be the
 * one that loaded it. So it is read again, cheaply, and only the part of the
 * answer that depends on it is rebuilt.
 */
interface Cached {
  readiness: StillImageReadiness;
  /** Injected by a caller or a test: never re-read. */
  pinned: boolean;
  checkedAt: number;
}

let current: Cached | undefined;
/** How long a read of the vision record is reused. */
export const STILL_IMAGE_VISION_RECHECK_MS = 2_000;
let visionReader: () => StillImageVisionState = readVision;
let clock: () => number = Date.now;

/** Replace how the encoder record is read and what time it is. For tests. */
export function setStillImageVisionSource(source: { read?: () => StillImageVisionState; now?: () => number } | undefined): void {
  visionReader = source?.read ?? readVision;
  clock = source?.now ?? Date.now;
}

/**
 * The same answer under a different encoder state: a format the tool decoded
 * becomes ready (or not ready, for `vision_unavailable`) with the state; a
 * format it could not decode stays as it was.
 */
function withVision(readiness: StillImageReadiness, vision: StillImageVisionState): StillImageReadiness {
  const blocked = vision === 'unavailable';
  const formats = Object.fromEntries(STILL_IMAGE_FORMATS.map((format) => {
    const entry = readiness.formats[format];
    const decoded = entry.ready || entry.reason === 'vision_unavailable';
    return [format, !decoded ? entry : blocked ? { ready: false, reason: 'vision_unavailable' as const } : { ready: true }];
  })) as Record<StillImageFormat, StillImageFormatReadiness>;
  return { ...readiness, formats, vision };
}

/**
 * This process's answer, probed on first use. The encoder state in it is
 * never older than `STILL_IMAGE_VISION_RECHECK_MS`, so everything that asks
 * (admission, the extractor, the store) follows it without a restart.
 */
export function stillImageReadiness(): StillImageReadiness {
  if (!current) current = { readiness: probeStillImageReadiness({ vision: visionReader() }), pinned: false, checkedAt: clock() };
  if (!current.pinned && clock() - current.checkedAt >= STILL_IMAGE_VISION_RECHECK_MS) {
    current.checkedAt = clock();
    const vision = visionReader();
    if (vision !== current.readiness.vision) current.readiness = withVision(current.readiness, vision);
  }
  return current.readiness;
}

/** Probe again now (a tool was installed, or the model's encoder state changed). */
export function refreshStillImageReadiness(options: StillImageProbeOptions = {}): StillImageReadiness {
  const readiness = probeStillImageReadiness({ ...options, vision: options.vision ?? visionReader() });
  // A caller that supplied the encoder state fixed it; otherwise it stays live.
  current = { readiness, pinned: options.vision !== undefined, checkedAt: clock() };
  return readiness;
}

/** Replace (or, with undefined, forget) this process's answer. For tests. */
export function setStillImageReadiness(readiness: StillImageReadiness | undefined): void {
  current = readiness ? { readiness, pinned: true, checkedAt: clock() } : undefined;
}
