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
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
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

export type AccessAnswer = 'granted' | 'denied' | 'waiting';

export interface MacPermissionsOptions {
  platform?: NodeJS.Platform;
  home: string;
  /** True when the engine runs through the signed helper. Default: the helper's environment flag. */
  helperPresent?: () => boolean;
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

/** Copy, in one place so the picker and the tests read the same words. */
export const MAC_ACCESS_COPY = {
  needsPermission: 'Your Mac will ask before Olympus opens this folder.',
  waiting: 'Your Mac is asking whether Olympus may open this folder. Answer on your Mac, then choose Try again.',
  needsHelper: 'To open this folder, Olympus Engine needs its helper app so your Mac can ask you. The helper app is not installed on this computer yet. Install it with "olympus engine install-helper", then choose Try again.',
  denied: (kind: GuardedFolderKind) =>
    `Your Mac said no to ${PLACE_WORDS[kind]}. To turn it back on, open System Settings, choose Privacy & Security, then Files & Folders, and switch on ${SETTINGS_NAMES[kind]} under Olympus Engine. Then choose Try again.`,
  fullDiskAccess: 'To search your whole computer, Olympus Engine needs Full Disk Access. Open System Settings, choose Privacy & Security, then Full Disk Access, and switch on Olympus Engine. If Olympus Engine is not in the list, drag it in from the Finder window that opens when you save.',
} as const;

export class MacPermissions {
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly helperPresent: () => boolean;
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
    this.helperPresent = options.helperPresent ?? (() => Boolean(process.env[ENGINE_HELPER_ENV]));
    this.memoryPath = options.memoryPath;
    this.askTimeoutMs = options.askTimeoutMs ?? 8_000;
    this.list = options.list ?? ((path) => readdir(path));
    this.listProtected = options.listProtected ?? ((path) => { readdirSync(path); });
    this.now = options.now ?? Date.now;
  }

  /** False on every platform but macOS: nothing here applies. */
  get active(): boolean {
    return this.platform === 'darwin';
  }

  hasHelper(): boolean {
    return this.helperPresent();
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

  /** What a folder row says before anything is asked: "Needs permission" unless the Mac already allowed it. */
  nodeAccess(guard: GuardedFolder): OlympusFolderAccess | undefined {
    if (this.recall(guard) === 'granted') return undefined;
    return {
      state: this.hasHelper() ? 'needs_permission' : 'needs_helper',
      message: this.hasHelper() ? MAC_ACCESS_COPY.needsPermission : MAC_ACCESS_COPY.needsHelper,
    };
  }

  /**
   * Opening a guarded folder: ask the Mac (through the helper) and say what
   * came of it. Undefined means the folder can be listed. Without the helper
   * nothing is read, so the question never names the wrong app.
   */
  async open(guard: GuardedFolder): Promise<OlympusFolderAccess | undefined> {
    if (!this.hasHelper()) {
      return { state: 'needs_helper', message: MAC_ACCESS_COPY.needsHelper };
    }
    const answer = await this.ask(guard);
    if (answer === 'granted') return undefined;
    if (answer === 'waiting') return { state: 'waiting', message: MAC_ACCESS_COPY.waiting };
    return { state: 'denied', message: MAC_ACCESS_COPY.denied(guard.kind), settings_url: FILES_AND_FOLDERS_URL };
  }

  /** What an unreadable folder, found while reading, means: a denial, or a plain failure. */
  noteDenied(guard: GuardedFolder): OlympusFolderAccess {
    this.remember(guard, 'denied');
    return { state: 'denied', message: MAC_ACCESS_COPY.denied(guard.kind), settings_url: FILES_AND_FOLDERS_URL };
  }

  /** The top level's note about searching the whole computer, when Full Disk Access is not on. */
  fullDiskAccessNote(): OlympusFolderAccess | undefined {
    if (!this.active || this.hasFullDiskAccess()) return undefined;
    if (!this.hasHelper()) return { state: 'needs_helper', message: MAC_ACCESS_COPY.needsHelper };
    return { state: 'needs_full_disk_access', message: MAC_ACCESS_COPY.fullDiskAccess, settings_url: FULL_DISK_ACCESS_URL };
  }

  /**
   * Full Disk Access cannot be asked for, only checked: a folder every app is
   * kept out of unless it holds it (Safari's data) either lists or does not.
   */
  hasFullDiskAccess(): boolean {
    try {
      this.listProtected(join(this.home, 'Library', 'Safari'));
      return true;
    } catch (error) {
      // A missing folder says nothing about the permission; only a refusal does.
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  private ask(guard: GuardedFolder): Promise<AccessAnswer> {
    let pending = this.inFlight.get(guard.root);
    if (!pending) {
      pending = this.list(guard.root).then(
        () => { this.remember(guard, 'granted'); return 'granted' as const; },
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'EPERM' || error.code === 'EACCES') { this.remember(guard, 'denied'); return 'denied' as const; }
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
