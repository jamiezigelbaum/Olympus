/**
 * The Mac's own permission rules for the folders Olympus is asked to read.
 *
 * macOS asks the person before an app reads Desktop, Documents, Downloads,
 * iCloud Drive or a removable or network disk, and it asks in the name of the
 * app responsible for the read. The signed Olympus helper app is that app
 * (native/macos-engine-host); without it the question would name Bun.
 *
 * The state cannot be queried without asking, so this module:
 *  - names the folders that are guarded (by path, no read);
 *  - asks by reading one (the read blocks while the question is on screen, so
 *    it runs off the main thread of work and a slow answer reports "waiting");
 *  - remembers what the Mac answered, so a folder already allowed is not
 *    labelled "Needs permission" again after a restart. A remembered "allowed"
 *    is only a hint: the next read still says what the Mac thinks now.
 *
 * Linux and unguarded folders never reach this module's checks.
 */
import { existsSync, mkdirSync, opendirSync, readFileSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import type { OlympusFolderAccess } from '../../control-ui-contract.ts';
import { isWithinScopePath } from './paths.ts';
import type { MountedVolume } from './volume-identity.ts';

/** The helper sets this in the engine's environment (native/macos-engine-host/main.c). */
export const ENGINE_HELPER_ENV = 'OLYMPUS_ENGINE_HELPER';
export const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
export const FILES_AND_FOLDERS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';

export type GuardedFolderKind = 'desktop' | 'documents' | 'downloads' | 'icloud' | 'removable' | 'network';

/** A guarded place: its kind, and the folder the Mac's answer covers. */
export interface GuardedFolder {
  kind: GuardedFolderKind;
  /** Real path of the guarded top: the answer for it holds for everything below. */
  root: string;
}

/** What Files & Folders calls each place in System Settings. */
const SETTINGS_NAMES: Record<GuardedFolderKind, string> = {
  desktop: 'Desktop Folder',
  documents: 'Documents Folder',
  downloads: 'Downloads Folder',
  icloud: 'iCloud Drive',
  removable: 'Removable Volumes',
  network: 'Network Volumes',
};

const PLACE_WORDS: Record<GuardedFolderKind, string> = {
  desktop: 'your Desktop',
  documents: 'your Documents',
  downloads: 'your Downloads',
  icloud: 'iCloud Drive',
  removable: 'a USB drive or memory card',
  network: 'a network drive',
};

export type AccessAnswer = 'granted' | 'denied' | 'waiting' | 'unreadable';

export interface MacPermissionsOptions {
  platform?: NodeJS.Platform;
  home: string;
  /** True when the engine runs through the signed helper. Default: the helper's environment flag. */
  helperPresent?: () => boolean;
  /** Who the Mac blames for this process's reads. Default: from the environment, or from `helperPresent` when that is given. */
  hostKind?: () => PermissionHostKind;
  /** Where the Mac's answers are remembered. Absent: remembered for this run only. */
  memoryPath?: string;
  /** How long one ask waits for the person before it answers "waiting". Default 8 seconds. */
  askTimeoutMs?: number;
  /** Test seam: list a directory (the read that makes the Mac ask). */
  list?: (path: string) => Promise<unknown>;
  /** Test seam: the read that tells Full Disk Access apart. */
  listProtected?: (path: string) => void;
  /** Test seam: the clock. */
  now?: () => number;
}

/**
 * Who the Mac blames when this process reads a guarded folder.
 *  - `engine_helper`: the standalone engine, started through the signed helper:
 *    the Mac names "Olympus Engine".
 *  - `engine_without_helper`: the standalone engine with no helper installed
 *    (the signed helper app fixes it).
 *  - `managed_worker`: the worker OpenClaw's Gateway supervises as its own
 *    LaunchAgent. It is never started through the helper, so installing the
 *    helper for the standalone engine does not change what the Mac names.
 *  - `other`: Olympus runs inside another app (the OpenClaw Gateway, a terminal
 *    during development). That app is what the Mac names.
 */
export type PermissionHostKind = 'engine_helper' | 'engine_without_helper' | 'managed_worker' | 'other';

/** What the Mac calls the app that runs Olympus, in the words a person will see in System Settings. */
const ENGINE_APP = 'Olympus Engine';
const OTHER_APP = 'the app that runs Olympus (the one your Mac named when it asked)';

/** Copy, in one place so the picker and the tests read the same words. */
export const MAC_ACCESS_COPY = {
  needsPermission: 'Your Mac will ask before Olympus opens this folder.',
  waiting: 'Your Mac is asking whether Olympus may open this folder. Answer on your Mac, then choose Try again.',
  needsHelper: 'Desktop, Documents, Downloads, iCloud Drive and other disks need the Olympus helper app. Run the installer again: curl -fsSL https://olympusplugin.ai/install.sh | sh, or run olympus engine install-helper --from <signed app> if you have the app.',
  needsHelperWholeComputer: 'Reading the whole computer needs the Olympus helper app. Run the installer again: curl -fsSL https://olympusplugin.ai/install.sh | sh, or run olympus engine install-helper --from <signed app> if you have the app.',
  /** Olympus runs as OpenClaw's own worker: the helper is not part of that setup, so say what does work. */
  needsHelperManagedWorker: 'Olympus is running as an OpenClaw background worker here, and your Mac cannot ask you about this folder for it. Choose a folder outside Desktop, Documents, Downloads, iCloud Drive and other disks, or drag files onto the dashboard.',
  needsHelperManagedWorkerWholeComputer: 'Olympus is running as an OpenClaw background worker here, and your Mac cannot ask you about the whole computer for it. Choose folders outside Desktop, Documents, Downloads, iCloud Drive and other disks, or drag files onto the dashboard.',
  denied: (kind: GuardedFolderKind, app: string = ENGINE_APP) =>
    `Your Mac said no to ${PLACE_WORDS[kind]}. To turn it back on, open System Settings, choose Privacy & Security, then Files & Folders, and switch on ${SETTINGS_NAMES[kind]} under ${app}. Then choose Try again.`,
  fullDiskAccess: (app: string = ENGINE_APP) =>
    app === ENGINE_APP
      ? 'To search your whole computer, Olympus Engine needs Full Disk Access. Open System Settings, choose Privacy & Security, then Full Disk Access, and switch on Olympus Engine. If Olympus Engine is not in the list, drag it in from the Finder window that opens when you save.'
      : `To search your whole computer, ${app} needs Full Disk Access. Open System Settings, choose Privacy & Security, then Full Disk Access, and switch it on. If it is not in the list, add it with the plus button.`,
  /** Ordinary file permissions (not the Mac's privacy rules): the person's own account cannot read it. */
  unreadable: 'Your user account is not allowed to open this folder. In Finder, choose Get Info on it and check who may open it under Sharing & Permissions, then choose Try again.',
  unreadableLinux: 'Your user account is not allowed to open this folder. Check who may open it (for example with "ls -ld" on it) and change its permissions or choose another folder, then choose Try again.',
} as const;

/**
 * Who macOS blames for a read made by a process with this environment.
 * The standalone engine and the managed worker run bun under launchd, so only
 * the helper app gives them a signed app to be blamed; any other host
 * (OpenClaw's Gateway, a terminal during development) is itself the app macOS
 * names.
 */
export function permissionHostKind(env: Record<string, string | undefined>): PermissionHostKind {
  if (env[ENGINE_HELPER_ENV]) return 'engine_helper';
  if (env.OLYMPUS_ENGINE_HOST === '1' || env.OLYMPUS_STANDALONE === '1') return 'engine_without_helper';
  // The managed worker LaunchAgent also runs bun directly.
  if (env.OLYMPUS_MANAGED_WORKER === '1') return 'managed_worker';
  return 'other';
}

/** Whether a signed app (or the hosting app itself) stands behind the Mac's question. */
export function permissionHostPresent(env: Record<string, string | undefined>): boolean {
  const kind = permissionHostKind(env);
  return kind === 'engine_helper' || kind === 'other';
}

export class MacPermissions {
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly helperPresent: () => boolean;
  private readonly hostKind: () => PermissionHostKind;
  private readonly memoryPath: string | undefined;
  private readonly askTimeoutMs: number;
  private readonly list: (path: string) => Promise<unknown>;
  private readonly listProtected: (path: string) => void;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<AccessAnswer>>();
  private memory: Record<string, { answer: 'granted' | 'denied'; at: string }> | undefined;

  constructor(options: MacPermissionsOptions) {
    this.platform = options.platform ?? process.platform;
    this.home = options.home;
    this.helperPresent = options.helperPresent ?? (() => permissionHostPresent(process.env));
    this.hostKind = options.hostKind
      ?? (options.helperPresent
        ? () => (options.helperPresent!() ? 'engine_helper' : 'engine_without_helper')
        : () => permissionHostKind(process.env));
    this.memoryPath = options.memoryPath;
    this.askTimeoutMs = options.askTimeoutMs ?? 8_000;
    this.list = options.list ?? (async (path) => {
      // Opening the folder is the ask; one entry is enough to prove the read.
      const dir = await opendir(path);
      try { await dir.read(); } finally { await dir.close().catch(() => undefined); }
    });
    this.listProtected = options.listProtected ?? ((path) => {
      const dir = opendirSync(path);
      try { dir.readSync(); } finally { dir.closeSync(); }
    });
    this.now = options.now ?? Date.now;
  }

  /** False on every platform but macOS: nothing here applies. */
  get active(): boolean {
    return this.platform === 'darwin';
  }

  hasHelper(): boolean {
    return this.helperPresent();
  }

  /** The app the Mac names in its questions, for the words shown to the person. */
  private appName(): string {
    return this.hostKind() === 'engine_helper' ? ENGINE_APP : OTHER_APP;
  }

  /**
   * What to tell the person when this process cannot be asked about a guarded
   * folder (or the whole computer). Installing the helper is only the fix for
   * the standalone engine; OpenClaw's own worker gets the words that fit it.
   */
  helperNeededCopy(wholeComputer = false): string {
    if (this.hostKind() === 'managed_worker') {
      return wholeComputer ? MAC_ACCESS_COPY.needsHelperManagedWorkerWholeComputer : MAC_ACCESS_COPY.needsHelperManagedWorker;
    }
    return wholeComputer ? MAC_ACCESS_COPY.needsHelperWholeComputer : MAC_ACCESS_COPY.needsHelper;
  }

  /**
   * Whether a refusal to read a folder is the Mac's privacy rule rather than
   * ordinary file permissions. macOS answers a privacy refusal with EPERM and a
   * plain mode or ownership refusal with EACCES, and a guarded place is one the
   * privacy rules cover by definition. On any other platform privacy rules do
   * not exist.
   */
  isPrivacyRefusal(realPath: string, errno: string | undefined, volume?: Pick<MountedVolume, 'kind' | 'mountPoint' | 'primary'>): boolean {
    if (!this.active) return false;
    // An explicit EACCES is the account's own file permissions, even inside a
    // guarded place; EPERM, or a guarded place with no errno, is the Mac's rule.
    if (errno === 'EACCES') return false;
    return errno === 'EPERM' || this.guardOf(realPath, volume) !== undefined;
  }

  /** The words for a folder the person's own account cannot open (no privacy rule involved). */
  unreadableCopy(): string {
    return this.active ? MAC_ACCESS_COPY.unreadable : MAC_ACCESS_COPY.unreadableLinux;
  }

  /** The guarded place a real path is in (or is), or undefined for an ordinary folder. */
  guardOf(realPath: string, volume?: Pick<MountedVolume, 'kind' | 'mountPoint' | 'primary'>): GuardedFolder | undefined {
    if (!this.active) return undefined;
    const tops: Array<[GuardedFolderKind, string]> = [
      ['desktop', join(this.home, 'Desktop')],
      ['documents', join(this.home, 'Documents')],
      ['downloads', join(this.home, 'Downloads')],
      ['icloud', join(this.home, 'Library', 'Mobile Documents')],
    ];
    for (const [kind, root] of tops) {
      if (isWithinScopePath(realPath, root)) return { kind, root };
    }
    if (volume && !volume.primary && (volume.kind === 'removable' || volume.kind === 'network')) {
      return { kind: volume.kind, root: volume.mountPoint };
    }
    return undefined;
  }

  /**
   * True when reading this real path would make the Mac ask (or already
   * guards it) and the engine is not running under the helper app: the read
   * would be attributed to Bun, not to "Olympus Engine". Covers a guarded
   * folder, anything that contains one (the home folder, the whole computer),
   * and so is checked before a choice is saved and before any read.
   */
  blocksReadWithoutHelper(realPath: string, volume?: Pick<MountedVolume, 'kind' | 'mountPoint' | 'primary'>): boolean {
    if (!this.active || this.hasHelper()) return false;
    if (this.guardOf(realPath, volume)) return true;
    if (realPath === '/' || realPath === '/Volumes') return true;
    return [join(this.home, 'Desktop'), join(this.home, 'Documents'), join(this.home, 'Downloads'), join(this.home, 'Library', 'Mobile Documents')]
      .some((top) => isWithinScopePath(top, realPath));
  }

  /** What a folder row says before anything is asked: "Needs permission" unless the Mac already allowed it. */
  nodeAccess(guard: GuardedFolder): OlympusFolderAccess | undefined {
    if (this.recall(guard) === 'granted') return undefined;
    return {
      state: this.hasHelper() ? 'needs_permission' : 'needs_helper',
      message: this.hasHelper() ? MAC_ACCESS_COPY.needsPermission : this.helperNeededCopy(),
    };
  }

  /**
   * Opening a guarded folder: ask the Mac (through the helper) and say what
   * came of it. Undefined means the folder can be listed. Without the helper
   * nothing is read, so the question never names the wrong app.
   */
  async open(guard: GuardedFolder): Promise<OlympusFolderAccess | undefined> {
    if (!this.hasHelper()) {
      return { state: 'needs_helper', message: this.helperNeededCopy() };
    }
    const answer = await this.ask(guard);
    if (answer === 'granted') return undefined;
    if (answer === 'waiting') return { state: 'waiting', message: MAC_ACCESS_COPY.waiting };
    // The folder's own permissions refused (not the Mac's privacy rule): nothing in System Settings changes that.
    if (answer === 'unreadable') return { state: 'denied', message: this.unreadableCopy() };
    return { state: 'denied', message: MAC_ACCESS_COPY.denied(guard.kind, this.appName()), settings_url: FILES_AND_FOLDERS_URL };
  }

  /** What an unreadable folder, found while reading, means: a denial, or a plain failure. */
  noteDenied(guard: GuardedFolder): OlympusFolderAccess {
    this.remember(guard, 'denied');
    return { state: 'denied', message: MAC_ACCESS_COPY.denied(guard.kind, this.appName()), settings_url: FILES_AND_FOLDERS_URL };
  }

  /** The top level's note about searching the whole computer, when Full Disk Access is not on. */
  fullDiskAccessNote(): OlympusFolderAccess | undefined {
    if (!this.active || this.hasFullDiskAccess()) return undefined;
    if (!this.hasHelper()) return { state: 'needs_helper', message: this.helperNeededCopy(true) };
    return { state: 'needs_full_disk_access', message: MAC_ACCESS_COPY.fullDiskAccess(this.appName()), settings_url: FULL_DISK_ACCESS_URL };
  }

  /**
   * Full Disk Access cannot be asked for, only checked: a folder every app is
   * kept out of unless it holds it (Safari's data) either lists or does not.
   */
  hasFullDiskAccess(): boolean {
    // Safari's folder, or the TCC database folder: both exist on every Mac and
    // only open with Full Disk Access. If neither can be listed (refused, or
    // not there), Full Disk Access is not known to be on, so it counts as off.
    for (const path of [join(this.home, 'Library', 'Safari'), join(this.home, 'Library', 'Application Support', 'com.apple.TCC')]) {
      try {
        this.listProtected(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return false;
      }
    }
    return false;
  }

  private ask(guard: GuardedFolder): Promise<AccessAnswer> {
    let pending = this.inFlight.get(guard.root);
    if (!pending) {
      pending = this.list(guard.root).then(
        () => { this.remember(guard, 'granted'); return 'granted' as const; },
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'EACCES') return 'unreadable' as const;
          if (error.code === 'EPERM') { this.remember(guard, 'denied'); return 'denied' as const; }
          // Anything else (a disk that went away) is not an answer to the question.
          throw error;
        },
      ).finally(() => { this.inFlight.delete(guard.root); });
      this.inFlight.set(guard.root, pending);
    }
    const waiting = new Promise<AccessAnswer>((resolve) => {
      const timer = setTimeout(() => resolve('waiting'), this.askTimeoutMs);
      timer.unref?.();
      void pending!.finally(() => clearTimeout(timer)).catch(() => undefined);
    });
    return Promise.race([pending, waiting]);
  }

  private key(guard: GuardedFolder): string {
    return guard.root;
  }

  private recall(guard: GuardedFolder): 'granted' | 'denied' | undefined {
    return this.load()[this.key(guard)]?.answer;
  }

  private remember(guard: GuardedFolder, answer: 'granted' | 'denied'): void {
    const memory = this.load();
    if (memory[this.key(guard)]?.answer === answer) return;
    memory[this.key(guard)] = { answer, at: new Date(this.now()).toISOString() };
    if (!this.memoryPath) return;
    try {
      mkdirSync(dirname(this.memoryPath), { recursive: true, mode: 0o700 });
      writePrivateFileAtomicSync(this.memoryPath, `${JSON.stringify(memory, null, 2)}\n`);
    } catch {
      // A hint that could not be saved only costs a repeated label.
    }
  }

  private load(): Record<string, { answer: 'granted' | 'denied'; at: string }> {
    if (this.memory) return this.memory;
    let loaded: Record<string, { answer: 'granted' | 'denied'; at: string }> = {};
    if (this.memoryPath && existsSync(this.memoryPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.memoryPath, 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object') loaded = parsed as typeof loaded;
      } catch {
        loaded = {};
      }
    }
    this.memory = loaded;
    return loaded;
  }
}
