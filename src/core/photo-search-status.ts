/**
 * What `olympus doctor` and the status surfaces say about photo search: ready,
 * partly ready (naming the formats that are not), or missing, with the one
 * command that fixes it on this machine's Linux family.
 *
 * Pure: it turns a readiness answer (`still-image-readiness.ts`) and the
 * contents of `/etc/os-release` into words. Nothing here runs a tool or reads
 * the machine, so every message is testable on any host.
 */

import {
  STILL_IMAGE_FORMATS,
  type StillImageFormat,
} from './still-image-formats.ts';
import type {
  StillImageMissingReason,
  StillImageReadiness,
} from './still-image-readiness.ts';

export type PhotoSearchState = 'ready' | 'partial' | 'missing';
export type LinuxFamily = 'arch' | 'debian' | 'fedora' | 'other';

export interface PhotoSearchStatus {
  state: PhotoSearchState;
  /** Formats photos are read in on this machine. */
  readyFormats: StillImageFormat[];
  /** Formats that stay names-only, and why. */
  missingFormats: Array<{ format: StillImageFormat; reason: StillImageMissingReason }>;
  /** The whole picture in one or two plain sentences. */
  summary: string;
  /** The one thing to do, when there is something to do. */
  remedy?: string;
}

const ARCH_IDS = new Set(['arch', 'archarm', 'endeavouros', 'manjaro', 'cachyos', 'garuda', 'omarchy']);
const DEBIAN_IDS = new Set(['debian', 'ubuntu', 'linuxmint', 'pop', 'raspbian', 'elementary', 'zorin']);
const FEDORA_IDS = new Set(['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'nobara', 'ol']);

function osReleaseValue(osRelease: string, key: string): string[] {
  for (const line of osRelease.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key}=`)) continue;
    let value = trimmed.slice(key.length + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) value = value.slice(1, -1);
    return value.toLowerCase().split(' ').filter(Boolean);
  }
  return [];
}

/**
 * The package-manager family a Linux machine belongs to, from the text of
 * `/etc/os-release` (its `ID` and `ID_LIKE`).
 */
export function linuxFamilyFromOsRelease(osRelease: string | undefined): LinuxFamily {
  if (!osRelease) return 'other';
  const ids = [...osReleaseValue(osRelease, 'ID'), ...osReleaseValue(osRelease, 'ID_LIKE')];
  if (ids.some((id) => ARCH_IDS.has(id))) return 'arch';
  if (ids.some((id) => DEBIAN_IDS.has(id))) return 'debian';
  if (ids.some((id) => FEDORA_IDS.has(id))) return 'fedora';
  return 'other';
}

/** The one command that installs what photo search reads pictures with. */
export function photoSearchInstallCommand(family: LinuxFamily): string | undefined {
  switch (family) {
    case 'arch':
      return 'sudo pacman -S --needed libvips libheif';
    case 'debian':
      return 'sudo apt install libvips-tools libheif-plugin-libde265';
    case 'fedora':
      return 'sudo dnf install vips-tools libheif';
    default:
      return undefined;
  }
}

const REASON_WORDS: Readonly<Record<StillImageMissingReason, string>> = {
  no_tool: 'no image tool is installed',
  cannot_decode: 'the installed tool cannot read it',
  vision_unavailable: 'the built-in search model cannot read pictures here',
};

function listFormats(formats: readonly string[]): string {
  return formats.map((format) => format.toUpperCase()).join(', ');
}

export interface PhotoSearchStatusOptions {
  /** `darwin` reads pictures with macOS itself; anything else with libvips. */
  platform?: NodeJS.Platform;
  /** The text of `/etc/os-release`, for the family-specific command. */
  osRelease?: string | undefined;
}

export function photoSearchStatus(
  readiness: StillImageReadiness,
  options: PhotoSearchStatusOptions = {},
): PhotoSearchStatus {
  const platform = options.platform ?? process.platform;
  const readyFormats = STILL_IMAGE_FORMATS.filter((format) => readiness.formats[format].ready);
  const missingFormats = STILL_IMAGE_FORMATS
    .filter((format) => !readiness.formats[format].ready)
    .map((format) => ({ format, reason: readiness.formats[format].reason ?? 'cannot_decode' as const }));
  if (missingFormats.length === 0) {
    return {
      state: 'ready',
      readyFormats,
      missingFormats,
      summary: `Photo search is ready: photos are read in every supported format (${listFormats(readyFormats)}).`,
    };
  }

  const visionBlocked = readiness.vision === 'unavailable' && missingFormats.every((entry) => entry.reason === 'vision_unavailable');
  if (visionBlocked || (readiness.vision === 'unavailable' && readyFormats.length === 0)) {
    return {
      state: 'missing',
      readyFormats,
      missingFormats,
      summary: 'Photo search is off: the built-in search model could not start its image encoder on this machine, so photos are not searched by what is in them. Their names are still searched.',
      remedy: 'Restart Olympus to check again (olympus worker restart); if it persists, this machine cannot run the model\'s image encoder.',
    };
  }

  const state: PhotoSearchState = readyFormats.length === 0 ? 'missing' : 'partial';
  const cannotRead = missingFormats.filter((entry) => entry.reason !== 'vision_unavailable');
  const why = readiness.tool === 'none'
    ? REASON_WORDS.no_tool
    : REASON_WORDS.cannot_decode;
  const summary = state === 'missing'
    ? `Photo search is not available: ${why}, so photos are searched by name only.`
    : `Photo search is partly ready: photos are read in ${listFormats(readyFormats)}, but ${listFormats(cannotRead.map((entry) => entry.format))} cannot be read (${why}) and stay searched by name only.`;

  let remedy: string | undefined;
  if (platform === 'darwin') {
    remedy = 'These formats are read by macOS itself; update macOS to read them.';
  } else {
    const command = photoSearchInstallCommand(linuxFamilyFromOsRelease(options.osRelease));
    remedy = command
      ? `Run "${command}", then restart Olympus (olympus worker restart). Those photos are read once it is back.`
      : 'Install libvips (the vipsthumbnail command) with HEIF support using your package manager, then restart Olympus (olympus worker restart). Those photos are read once it is back.';
  }
  return { state, readyFormats, missingFormats, summary, remedy };
}
