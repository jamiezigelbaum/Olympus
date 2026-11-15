/**
 * Folders of notes that a notes app keeps on this computer (an Obsidian
 * vault, a Reflect Open graph). Such a folder is ordinary Markdown with the app's settings folder
 * inside; Olympus reads it as files on this computer, like any other chosen
 * folder. This module only answers questions about such folders: which
 * settings folders are the apps' own (off by default), where the folders an
 * app knows about are (so the folder picker can offer them, including one kept
 * in iCloud deep inside the Mac's Library), and which vault a file is in (so a
 * cited note opens in its app). Nothing here reads a note.
 *
 * Each app is one entry in `NOTES_APPS`; a new app adds an entry.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

/** The settings folder that makes a folder an Obsidian vault. */
export const OBSIDIAN_SETTINGS_FOLDER = '.obsidian';

/** The settings folder that makes a folder a Reflect Open graph. */
export const REFLECT_SETTINGS_FOLDER = '.reflect';

export type NotesAppId = 'obsidian' | 'reflect';

export interface NotesApp {
  id: NotesAppId;
  /** The folder inside a library of notes that holds the app's own settings and data. */
  settingsFolder: string;
  /** The libraries of notes this app knows about on this computer, as real folder paths. */
  knownFolders(lookup?: ObsidianLookup): string[];
}

export const NOTES_APPS: readonly NotesApp[] = Object.freeze([
  { id: 'obsidian', settingsFolder: OBSIDIAN_SETTINGS_FOLDER, knownFolders: (lookup) => obsidianVaultFolders(lookup) },
  { id: 'reflect', settingsFolder: REFLECT_SETTINGS_FOLDER, knownFolders: (lookup) => reflectGraphFolders(lookup) },
]);

/**
 * Settings and data folders notes apps keep beside the notes. They are off by
 * default: Obsidian's holds plugin settings (which can hold a plugin's API key)
 * and a layout file rewritten on every click; Reflect's holds a second copy of
 * every note, its search index and AI chats.
 */
export const NOTES_APP_SETTINGS_FOLDERS: readonly string[] = Object.freeze([OBSIDIAN_SETTINGS_FOLDER, REFLECT_SETTINGS_FOLDER]);

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
  /** Test seam: the names in a folder, empty when it cannot be read. */
  listFolder?: (path: string) => string[];
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
 * The library of notes a file is in, and its app: the nearest folder above
 * it, no higher than `root`, that holds a real settings folder of a notes app.
 * Undefined when there is none.
 */
export function notesAppFolderOf(
  filePath: string,
  root: string,
  isFolder: (path: string) => boolean = realFolder,
): { folder: string; app: NotesAppId } | undefined {
  const top = root.endsWith(sep) && root.length > 1 ? root.slice(0, -1) : root;
  let folder = dirname(filePath);
  while (folder === top || folder.startsWith(top === sep ? sep : `${top}${sep}`)) {
    const app = notesAppOfFolder(folder, isFolder);
    if (app) return { folder, app };
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return undefined;
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
  const found = notesAppFolderOf(filePath, root, (path) => path.endsWith(`${sep}${OBSIDIAN_SETTINGS_FOLDER}`) && isFolder(path));
  return found?.folder;
}

/** Whether the Obsidian app is installed on this Mac (in /Applications or ~/Applications). */
export function obsidianAppInstalled(home: string = homedir()): boolean {
  return existsSync('/Applications/Obsidian.app') || existsSync(join(home, 'Applications/Obsidian.app'));
}

/** The link that opens one note in Obsidian, by its full path. */
export function obsidianOpenUrl(filePath: string): string {
  return `obsidian://open?path=${encodeURIComponent(filePath)}`;
}

/**
 * The Reflect Open graphs on this Mac that are on disk now, each once: the
 * graphs the app lists as recently opened, and the graphs in its iCloud Drive
 * folder. Reflect Open is Mac-only today, so other systems list none (a graph
 * mirrored to a server is chosen by hand and still recognised by its
 * `.reflect` folder).
 */
export function reflectGraphFolders(lookup: ObsidianLookup = {}): string[] {
  const home = lookup.home ?? homedir();
  if ((lookup.platform ?? process.platform) !== 'darwin') return [];
  const readText = lookup.readText ?? readTextFile;
  const isFolder = lookup.isFolder ?? realFolder;
  const listFolder = lookup.listFolder ?? listChildren;
  const candidates: string[] = [];
  const recent = readText(join(home, 'Library/Application Support/reflect-open/recent-graphs.json'));
  if (recent) {
    try {
      const parsed: unknown = JSON.parse(recent);
      const entries = Array.isArray(parsed) ? parsed : (parsed as { graphs?: unknown })?.graphs;
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const root = (entry as { root?: unknown })?.root;
          if (typeof root === 'string' && root.startsWith('/') && !root.includes('\0')) candidates.push(root);
        }
      }
    } catch { /* an unreadable list adds nothing */ }
  }
  const icloud = join(home, 'Library/Mobile Documents/iCloud~app~reflect/Documents');
  for (const name of listFolder(icloud)) if (!name.startsWith('.')) candidates.push(join(icloud, name));
  const found: string[] = [];
  for (const candidate of candidates) {
    const folder = candidate.length > 1 && candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
    if (found.includes(folder)) continue;
    if (isFolder(folder) && isFolder(join(folder, REFLECT_SETTINGS_FOLDER))) found.push(folder);
  }
  return found;
}

function listChildren(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Whether Reflect Open (bundle id app.reflect.desktop, not the older Reflect app) is installed on this Mac. */
export function reflectAppInstalled(home: string = homedir()): boolean {
  for (const folder of ['/Applications', join(home, 'Applications')]) {
    for (const name of listChildren(folder)) {
      if (!/^Reflect.*\.app$/.test(name)) continue;
      if (readTextFile(join(folder, name, 'Contents/Info.plist'))?.includes('app.reflect.desktop')) return true;
    }
  }
  return false;
}

/**
 * The link that opens one note in Reflect Open: a daily note by its date,
 * any other by its path inside the graph. Reflect resolves it in the graph
 * that is open.
 */
export function reflectOpenUrl(graphFolder: string, filePath: string): string {
  const inGraph = relative(graphFolder, filePath).split(sep).join('/');
  const daily = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/.exec(inGraph);
  if (daily) return `reflect://daily/${daily[1]}`;
  return `reflect://note/${encodeURIComponent(inGraph)}`;
}
