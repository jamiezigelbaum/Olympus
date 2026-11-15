/**
 * Folders of notes that a notes app keeps on this computer (an Obsidian
 * vault). Such a folder is ordinary Markdown with the app's settings folder
 * inside; Olympus reads it as files on this computer, like any other chosen
 * folder. This module only answers questions about such folders: which
 * settings folders are the apps' own (off by default), where the folders an
 * app knows about are (so the folder picker can offer them, including one kept
 * in iCloud deep inside the Mac's Library), and which vault a file is in (so a
 * cited note opens in its app). Nothing here reads a note.
 *
 * Each app is one entry in `NOTES_APPS`; a new app adds an entry.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';

/** The settings folder that makes a folder an Obsidian vault. */
export const OBSIDIAN_SETTINGS_FOLDER = '.obsidian';

export type NotesAppId = 'obsidian';

export interface NotesApp {
  id: NotesAppId;
  /** The folder inside a library of notes that holds the app's own settings and data. */
  settingsFolder: string;
  /** The libraries of notes this app knows about on this computer, as real folder paths. */
  knownFolders(lookup?: ObsidianLookup): string[];
}

export const NOTES_APPS: readonly NotesApp[] = Object.freeze([
  { id: 'obsidian', settingsFolder: OBSIDIAN_SETTINGS_FOLDER, knownFolders: (lookup) => obsidianVaultFolders(lookup) },
]);

/**
 * Settings and data folders notes apps keep beside the notes. They are off by
 * default: Obsidian's holds plugin settings (which can hold a plugin's API key)
 * and a layout file rewritten on every click; Reflect's holds a second copy of
 * every note, its search index and AI chats.
 */
export const NOTES_APP_SETTINGS_FOLDERS: readonly string[] = Object.freeze(['.obsidian', '.reflect']);

/** The notes app whose settings folder is directly inside `folder`, if any. */
export function notesAppOfFolder(folder: string, isFolder: (path: string) => boolean = realFolder): NotesAppId | undefined {
  return NOTES_APPS.find((app) => isFolder(join(folder, app.settingsFolder)))?.id;
}

/** Every library of notes the installed apps know about, each once, with its app. */
export function knownNotesAppFolders(lookup: ObsidianLookup = {}): Array<{ path: string; app: NotesAppId }> {
  const out: Array<{ path: string; app: NotesAppId }> = [];
  for (const app of NOTES_APPS) {
    for (const path of app.knownFolders(lookup)) if (!out.some((entry) => entry.path === path)) out.push({ path, app: app.id });
  }
  return out;
}

export interface ObsidianLookup {
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Test seam: read a text file, undefined when it is not there. */
  readText?: (path: string) => string | undefined;
  /** Test seam: whether a real (not linked) folder is at this path. */
  isFolder?: (path: string) => boolean;
}

function realFolder(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Where Obsidian keeps its list of vaults (`obsidian.json`) on this platform. */
export function obsidianConfigFiles(lookup: ObsidianLookup = {}): string[] {
  const home = lookup.home ?? homedir();
  const platform = lookup.platform ?? process.platform;
  const env = lookup.env ?? process.env;
  if (platform === 'darwin') return [join(home, 'Library/Application Support/obsidian/obsidian.json')];
  if (platform === 'win32') {
    return env.APPDATA ? [join(env.APPDATA, 'obsidian', 'obsidian.json')] : [];
  }
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return [
    join(config, 'obsidian/obsidian.json'),
    // Flatpak and Snap keep the app's settings in their own sandboxes.
    join(home, '.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json'),
    join(home, 'snap/obsidian/current/.config/obsidian/obsidian.json'),
  ];
}

/**
 * The vaults Obsidian lists that are on disk now, as real folder paths, each
 * once. A vault Obsidian remembers but that was moved or deleted is left out.
 */
export function obsidianVaultFolders(lookup: ObsidianLookup = {}): string[] {
  const readText = lookup.readText ?? readTextFile;
  const isFolder = lookup.isFolder ?? realFolder;
  const found: string[] = [];
  for (const file of obsidianConfigFiles(lookup)) {
    const text = readText(file);
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const vaults = (parsed as { vaults?: unknown })?.vaults;
    if (!vaults || typeof vaults !== 'object') continue;
    for (const entry of Object.values(vaults as Record<string, unknown>)) {
      const path = (entry as { path?: unknown })?.path;
      if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) continue;
      const folder = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
      if (found.includes(folder)) continue;
      if (isFolder(folder) && isFolder(join(folder, OBSIDIAN_SETTINGS_FOLDER))) found.push(folder);
    }
  }
  return found;
}

/**
 * The vault folder a file is in: the nearest folder above it, no higher than
 * `root`, that holds a real `.obsidian` folder. Undefined when there is none.
 */
export function obsidianVaultOf(
  filePath: string,
  root: string,
  isFolder: (path: string) => boolean = realFolder,
): string | undefined {
  const top = root.endsWith(sep) && root.length > 1 ? root.slice(0, -1) : root;
  let folder = dirname(filePath);
  while (folder === top || folder.startsWith(top === sep ? sep : `${top}${sep}`)) {
    if (isFolder(join(folder, OBSIDIAN_SETTINGS_FOLDER))) return folder;
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return undefined;
}

/** Whether the Obsidian app is installed on this Mac (in /Applications or ~/Applications). */
export function obsidianAppInstalled(home: string = homedir()): boolean {
  return existsSync('/Applications/Obsidian.app') || existsSync(join(home, 'Applications/Obsidian.app'));
}

/** The link that opens one note in Obsidian, by its full path. */
export function obsidianOpenUrl(filePath: string): string {
  return `obsidian://open?path=${encodeURIComponent(filePath)}`;
}
