// Whether this computer reads scans and pictures of text, in the words setup
// and `olympus doctor` use. The probe itself lives with the extractors
// (workers/file-extraction/extractors/ocr-capability.ts); this module turns its
// answer into "ready (and which engine)" or "missing" with ONE exact command
// for the distribution the machine runs.

import { existsSync, readFileSync } from 'node:fs';
import {
  APPLE_VISION_OSASCRIPT,
  appleVisionOcrSelected,
  resolveAppleVisionOcrScript,
} from '../workers/file-extraction/extractors/apple-vision-ocr.ts';
import {
  probeOcrCapability,
  type OcrCapabilitySnapshot,
} from '../workers/file-extraction/extractors/ocr-capability.ts';

export type LinuxFamily = 'arch' | 'debian' | 'fedora' | 'other';

export interface OcrReadiness {
  /**
   * `ready`: scans and pictures are read. `partial`: pictures are, scanned
   * PDFs are not. `missing`: neither.
   */
  state: 'ready' | 'partial' | 'missing';
  /**
   * Which engine reads what, for the report: "Apple Vision",
   * "ocrmypdf", "pdftoppm + tesseract", "tesseract".
   */
  pdfEngine?: string;
  imageEngine?: string;
  detail: string;
  /**
   * The one command that fixes it, when it is not ready.
   */
  remedy?: string;
}

const ARCH_IDS = ['arch', 'archlinux', 'omarchy', 'manjaro', 'endeavouros', 'cachyos', 'arcolinux', 'garuda'];
const DEBIAN_IDS = ['debian', 'ubuntu', 'linuxmint', 'pop', 'raspbian', 'neon', 'elementary', 'zorin'];
const FEDORA_IDS = ['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'ol', 'nobara'];

function osReleaseValue(text: string, key: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key}=`)) continue;
    const raw = trimmed.slice(key.length + 1).trim();
    const quoted = raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'")) && raw.endsWith(raw[0]!);
    return (quoted ? raw.slice(1, -1) : raw).toLowerCase();
  }
  return '';
}

/**
 * The distribution family from /etc/os-release: its `ID`, then each word of
 * `ID_LIKE`. Omarchy reports `ID=omarchy` and `ID_LIKE=arch`; Ubuntu derivatives
 * report `ID_LIKE=ubuntu debian`.
 */
export function linuxFamilyFromOsRelease(text: string | undefined): LinuxFamily {
  if (!text) return 'other';
  const words = [
    osReleaseValue(text, 'ID'),
    ...osReleaseValue(text, 'ID_LIKE').split(' '),
  ].filter((word) => word.length > 0);
  for (const word of words) {
    if (ARCH_IDS.includes(word)) return 'arch';
    if (DEBIAN_IDS.includes(word)) return 'debian';
    if (FEDORA_IDS.includes(word)) return 'fedora';
  }
  return 'other';
}

function readOsRelease(): string | undefined {
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // try the next location
    }
  }
  return undefined;
}

/**
 * The one command that installs everything OCR needs. It is the same command
 * whichever piece is missing: each package manager skips what is installed.
 * `ocrmypdf` is never required: where it is absent, pages are rendered with
 * `pdftoppm` (poppler) and read with `tesseract`.
 */
export function ocrInstallRemedy(input: { platform: NodeJS.Platform; family: LinuxFamily }): string {
  if (input.platform === 'darwin') return 'brew install tesseract poppler';
  if (input.platform !== 'linux') {
    return 'Install tesseract (with its English language data) and poppler (pdftoppm) with your package manager.';
  }
  if (input.family === 'arch') return 'sudo pacman -S --needed tesseract tesseract-data-eng poppler';
  if (input.family === 'debian') return 'sudo apt install tesseract-ocr poppler-utils';
  if (input.family === 'fedora') return 'sudo dnf install tesseract poppler-utils';
  return 'Install the packages that provide tesseract (with its English language data) and pdftoppm (poppler-utils) with your package manager.';
}

function visionReady(platform: NodeJS.Platform): boolean {
  return appleVisionOcrSelected('auto', platform)
    && resolveAppleVisionOcrScript() !== undefined
    && existsSync(APPLE_VISION_OSASCRIPT);
}

/**
 * Turn a probe answer into the report. Pure: the caller supplies the probe
 * answer, the platform and the distribution.
 */
export function describeOcrReadiness(input: {
  platform: NodeJS.Platform;
  family: LinuxFamily;
  snapshot: OcrCapabilitySnapshot | undefined;
  vision?: boolean;
}): OcrReadiness {
  if (input.vision) {
    return {
      state: 'ready',
      pdfEngine: 'Apple Vision',
      imageEngine: 'Apple Vision',
      detail: 'Scans and pictures of text are read with the Mac\'s built-in Apple Vision; nothing needs installing.',
    };
  }
  const remedy = ocrInstallRemedy({ platform: input.platform, family: input.family });
  const snapshot = input.snapshot;
  if (snapshot?.imageEngine && snapshot.pdfEngine) {
    const pdfEngine = snapshot.pdfEngine === 'ocrmypdf' ? 'ocrmypdf' : 'pdftoppm + tesseract';
    return {
      state: 'ready',
      pdfEngine,
      imageEngine: 'tesseract',
      detail: `Scans and pictures of text are read: scanned PDFs with ${pdfEngine}, pictures with tesseract.`,
    };
  }
  if (snapshot?.imageEngine) {
    const why = snapshot.pdftoppm === 'missing'
      ? 'pdftoppm (poppler) is not installed'
      : 'pdftoppm (poppler) did not render a test page';
    return {
      state: 'partial',
      imageEngine: 'tesseract',
      detail: `Pictures of text are read with tesseract, but scanned PDFs are not: ${why}.`,
      remedy,
    };
  }
  const why = snapshot === undefined
    ? 'the check did not run'
    : snapshot.tesseract === 'missing'
      ? 'tesseract is not installed'
      : 'tesseract is installed but could not read a test picture (is its English language data installed?)';
  return {
    state: 'missing',
    detail: `Scans and pictures of text are not read yet: ${why}. Files waiting for it are read automatically once it works.`,
    remedy,
  };
}

export interface CheckOcrReadinessOptions {
  platform?: NodeJS.Platform;
  /**
   * The text of /etc/os-release; defaults to reading it.
   */
  osRelease?: string;
  probe?: () => Promise<OcrCapabilitySnapshot>;
  vision?: boolean;
}

/**
 * Probe this computer and report. A Mac that can run Apple Vision is ready
 * without probing any command.
 */
export async function checkOcrReadiness(options: CheckOcrReadinessOptions = {}): Promise<OcrReadiness> {
  const platform = options.platform ?? process.platform;
  const family = platform === 'linux' ? linuxFamilyFromOsRelease(options.osRelease ?? readOsRelease()) : 'other';
  const vision = options.vision ?? visionReady(platform);
  if (vision) return describeOcrReadiness({ platform, family, snapshot: undefined, vision: true });
  const snapshot = await (options.probe ?? (() => probeOcrCapability()))().catch(() => undefined);
  return describeOcrReadiness({ platform, family, snapshot });
}
