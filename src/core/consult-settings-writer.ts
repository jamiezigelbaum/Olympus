// Outside-help (consult) settings: the writer (design
// docs/design/frontier-consult-lane.md, revision 10, §A.9, build stage C5).
//
// The reader (consult-settings.ts) is deliberately a separate module, imported
// by the readers of the setting. This module is imported by exactly one
// caller, the Mac dashboard's Outside help card (workers/email-source/
// dashboard-consult.ts), which is reachable only through an authenticated
// local dashboard control session. No MCP, setup-tool, ChatGPT, relay or
// remote path may reach it: a hosted agent must never switch on egress. The
// import-graph test in test/consult-settings-writer.test.ts holds that line.
//
// Rules, each held by a test:
//   - compare-and-swap on `revision`, under the same cross-process file lease
//     every other owner-state file uses (file-lease.ts);
//   - atomic owner-only replace: the new file is created at 0600 and renamed
//     over the old one, so a reader sees the old settings or the new ones;
//   - directory custody: `~/.olympus` must be this owner's directory, not a
//     symlink, with no group or other permission bits; a missing one is
//     created at 0700;
//   - no HOME, no write: there is no fallback to the operating system's home;
//   - an invalid current file is never overwritten unless the caller says
//     `replaceInvalid`, so a damaged file is a stated decision, not a silent
//     repair.

import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { FileLeaseBusyError, withFileLeaseSync } from './file-lease.ts';
import type { ConsultDomainPacks, ConsultLanguage } from './consult-gate.ts';
import {
  CONSULT_SETTINGS_VERSION,
  type ConsultLevel,
  consultSettingsPath,
  parseConsultSettings,
  readConsultSettings,
  type ConsultSettings,
  type ConsultSettingsInvalidReason,
  type ConsultSettingsLocation,
  type ConsultSettingsRead,
  type ConsultStandardMode,
  type ConsultWriterChoice,
} from './consult-settings.ts';

/** What the owner chooses; `v` and `revision` are the writer's. */
export interface ConsultSettingsUpdate {
  readonly enabled: boolean;
  readonly languages: readonly ConsultLanguage[];
  readonly domains: ConsultDomainPacks;
  readonly strict: boolean;
  /** What the consult writer may send; always written, so the file never relies on the reader's default. */
  readonly level: ConsultLevel;
  /**
   * The owner's own writer model and the zkAPI model for ChatGPT questions.
   * Written exactly as given: a caller that does not change them passes the
   * file's current values through, so a save of the switch or the level
   * never drops them.
   */
  readonly writer?: ConsultWriterChoice;
  readonly chatgptFrontierModel?: string;
  /** How Standard prepares a question; passed through like the writer. */
  readonly standardMode?: ConsultStandardMode;
  readonly standardInstruction?: string;
  /** Whether a level was chosen in conversation; passed through like the writer. */
  readonly levelChosen?: true;
}

export interface ConsultSettingsWriteInput extends ConsultSettingsUpdate {
  /**
   * The revision the caller's view was built from: 0 for no file. The write
   * happens only while the file still holds exactly this revision.
   */
  readonly expectedRevision: number;
  /**
   * Overwrite a file that does not parse as settings. Off by default: an
   * invalid file is reported, never silently replaced.
   */
  readonly replaceInvalid?: boolean;
}

export type ConsultSettingsWriteRefusal =
  /** No HOME in the environment (or not an absolute path); nothing is written anywhere. */
  | 'no_home'
  /** HOME names no directory, so `~/.olympus` cannot be created. */
  | 'home_missing'
  /** The update is not valid settings (empty languages, an unknown language, a duplicate). */
  | 'invalid_input'
  /** `~/.olympus` is a symbolic link; a redirected directory is never written through. */
  | 'directory_symlink'
  /** `~/.olympus` exists but is not a directory owned by this user with mode 0700. */
  | 'directory_custody'
  /** `~/.olympus` could not be examined or created. */
  | 'directory_unavailable'
  /** Another writer holds the settings lease right now. */
  | 'lease_busy'
  /** The current file is invalid and `replaceInvalid` was not given. */
  | 'invalid_current'
  /** The file is at another revision than the caller expected; nothing written. */
  | 'revision_conflict'
  /** The replace failed before anything was published; the old file, if any, is intact. */
  | 'write_failed'
  /** Something failed after the new file may have been published, and the file could not be read back to say which. */
  | 'write_uncertain';

export type ConsultSettingsWriteResult =
  | {
    readonly ok: true;
    readonly settings: ConsultSettings;
    /** The new file was published, but a step after the publish (directory flush, mode, lease release) failed; the state reported is what the file reads now. */
    readonly publishedDespiteError?: true;
  }
  | {
    readonly ok: false;
    readonly reason: ConsultSettingsWriteRefusal;
    /** The file as it reads now, for `revision_conflict` and `invalid_current`. */
    readonly current?: ConsultSettingsRead;
    /** The reader's reason, for `invalid_current`. */
    readonly invalidReason?: ConsultSettingsInvalidReason;
  };

/** Test seam: runs after the new file is published and before the mode is set. */
export const __consultSettingsWriterTestHooks: { afterPublish: ((path: string) => void) | undefined } = { afterPublish: undefined };

/** How long a write waits for the lease; a held lease is reported, never waited out. */
export const CONSULT_SETTINGS_LEASE_TIMEOUT_MS = 2_000;

/**
 * Write the settings, compare-and-swap on `revision`. Never throws. Returns
 * the settings as they read back from the file after the write.
 */
export function writeConsultSettings(input: ConsultSettingsWriteInput, location: ConsultSettingsLocation = {}): ConsultSettingsWriteResult {
  const path = location.path ?? consultSettingsPath(location.env ?? process.env);
  if (path === undefined || !isAbsolute(path)) return { ok: false, reason: 'no_home' };
  const nextRevision = input.expectedRevision + 1;
  const candidate = parseConsultSettings({
    v: CONSULT_SETTINGS_VERSION,
    revision: nextRevision,
    enabled: input.enabled,
    languages: [...input.languages],
    domains: { ...input.domains },
    strict: input.strict,
    level: input.level,
    ...(input.writer ? { writer: { ...input.writer } } : {}),
    ...(input.chatgptFrontierModel ? { chatgptFrontierModel: input.chatgptFrontierModel } : {}),
    ...(input.standardMode ? { standardMode: input.standardMode } : {}),
    ...(input.standardInstruction !== undefined ? { standardInstruction: input.standardInstruction } : {}),
    ...(input.levelChosen ? { levelChosen: true } : {}),
  });
  if (!candidate || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return { ok: false, reason: 'invalid_input' };
  const custody = ensureSettingsDirectory(dirname(path));
  if (custody !== 'ok') return { ok: false, reason: custody };
  // Tracked across the whole lease lifecycle, including the release that runs
  // after the callback: once the new file is published, any later error is
  // uncertainty about a live file, never "nothing changed".
  let published = false;
  const afterPublish = (): ConsultSettingsWriteResult => {
    const actual = readConsultSettings({ path });
    if (actual.state === 'valid' && actual.settings.revision === nextRevision) {
      return { ok: true, settings: actual.settings, publishedDespiteError: true };
    }
    return { ok: false, reason: 'write_uncertain', current: actual };
  };
  try {
    return withFileLeaseSync(path, (lease) => {
      const current = readConsultSettings({ path });
      if (current.state === 'invalid') {
        if (input.replaceInvalid !== true) return { ok: false as const, reason: 'invalid_current' as const, current, invalidReason: current.reason };
      } else {
        const currentRevision = current.state === 'absent' ? 0 : current.settings.revision;
        if (currentRevision !== input.expectedRevision) return { ok: false as const, reason: 'revision_conflict' as const, current };
      }
      // Failures are split at the publish point (the rename inside the atomic
      // helper). Before it, nothing changed. After it, the new file may be
      // live even though a later step (directory flush, chmod, lease release)
      // threw, so the file is read back and the actual state is reported.
      try {
        lease.commit(() => {
          writePrivateFileAtomicSync(path, `${JSON.stringify(candidate)}\n`, { onPublished: () => { published = true; } });
          __consultSettingsWriterTestHooks.afterPublish?.(path);
          // The temporary file is created at 0600 under the process umask;
          // the rename keeps that mode. Said again here so the file the reader
          // accepts is owner-only whatever the umask was.
          chmodSync(path, 0o600);
        });
      } catch {
        if (!published) return { ok: false as const, reason: 'write_failed' as const };
        return afterPublish();
      }
      const written = readConsultSettings({ path });
      if (written.state !== 'valid') return { ok: false as const, reason: 'write_uncertain' as const, current: written };
      return { ok: true as const, settings: written.settings };
    }, { acquireTimeoutMs: CONSULT_SETTINGS_LEASE_TIMEOUT_MS });
  } catch (error) {
    // A throw out of the lease itself: acquiring it (busy) or releasing it.
    // After a publish, a release failure is reported from the file.
    if (published) return afterPublish();
    if (error instanceof FileLeaseBusyError || (error as { code?: string })?.code === 'file_lease_busy') return { ok: false, reason: 'lease_busy' };
    return { ok: false, reason: 'write_failed' };
  }
}

/**
 * `~/.olympus` must be this owner's private directory: a real directory (not a
 * symlink), owned by this user, with no group or other permission bits. A
 * missing one is created at 0700 inside an existing HOME. Anything else
 * refuses: a settings file inside a redirected or shared directory could be
 * read or replaced by another local account.
 */
function ensureSettingsDirectory(directory: string): 'ok' | Extract<ConsultSettingsWriteRefusal, 'home_missing' | 'directory_symlink' | 'directory_custody' | 'directory_unavailable'> {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(directory);
  } catch (error) {
    if ((error as { code?: string })?.code !== 'ENOENT') return 'directory_unavailable';
    try {
      statSync(dirname(directory));
    } catch {
      return 'home_missing';
    }
    try {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
    } catch {
      return 'directory_unavailable';
    }
    try {
      stats = lstatSync(directory);
    } catch {
      return 'directory_unavailable';
    }
  }
  if (stats.isSymbolicLink()) return 'directory_symlink';
  if (!stats.isDirectory()) return 'directory_custody';
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) return 'directory_custody';
  if ((stats.mode & 0o077) !== 0) return 'directory_custody';
  return 'ok';
}
