import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localOpenArguments } from '../src/core/local-open.ts';
import { knownNotesAppFolders, obsidianConfigFiles, obsidianVaultFolders, obsidianVaultOf } from '../src/core/notes-app-folders.ts';
import { defaultExclusionForFolder, type DefaultExclusionContext } from '../src/workers/local-files/paths.ts';
import { createLocalFilesFolderScopeBrowser } from '../src/workers/local-files/scope-browser.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { watchIgnoreGlobs } from '../src/workers/local-files/watch-hub.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tempHome(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lf-notes-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function writeVaultList(home: string, paths: string[]): void {
  const dir = join(home, 'Library/Application Support/obsidian');
  mkdirSync(dir, { recursive: true });
  const vaults = Object.fromEntries(paths.map((path, index) => [`v${index}`, { path, ts: 1, open: index === 0 }]));
  writeFileSync(join(dir, 'obsidian.json'), JSON.stringify({ vaults }));
}

function vault(path: string): string {
  mkdirSync(join(path, '.obsidian'), { recursive: true });
  writeFileSync(join(path, 'Note.md'), '# Note');
  return path;
}

describe('notes app settings folders are off by default', () => {
  const darwin: DefaultExclusionContext = { home: '/Users/jo', syncedRoots: [], platform: 'darwin' };
  test('.obsidian and .reflect are app settings, Obsidian\'s .trash is trash', () => {
    expect(defaultExclusionForFolder('/Users/jo/Notes/.obsidian', darwin)).toBe('app_settings');
    expect(defaultExclusionForFolder('/Users/jo/Notes/.reflect', darwin)).toBe('app_settings');
    expect(defaultExclusionForFolder('/Users/jo/Notes/.trash', darwin)).toBe('trash');
    expect(defaultExclusionForFolder('/Users/jo/Notes', darwin)).toBeUndefined();
  });

  test('a live watch never reports changes inside them', () => {
    const globs = watchIgnoreGlobs(darwin);
    expect(globs).toContain('**/.obsidian');
    expect(globs).toContain('**/.reflect');
  });
});

describe('Obsidian vaults', () => {
  test('the vault list is read where each platform keeps it', () => {
    expect(obsidianConfigFiles({ home: '/Users/jo', platform: 'darwin' })).toEqual(['/Users/jo/Library/Application Support/obsidian/obsidian.json']);
    expect(obsidianConfigFiles({ home: '/home/jo', platform: 'linux', env: {} })[0]).toBe('/home/jo/.config/obsidian/obsidian.json');
  });

  test('only vaults still on disk with their settings folder are found, each once', () => {
    const home = tempHome();
    const kept = vault(join(home, 'Notes'));
    mkdirSync(join(home, 'NotAVault'), { recursive: true });
    writeVaultList(home, [kept, `${kept}/`, join(home, 'Gone'), join(home, 'NotAVault'), 'relative/path']);
    expect(obsidianVaultFolders({ home, platform: 'darwin' })).toEqual([kept]);
    expect(knownNotesAppFolders({ home, platform: 'darwin' })).toEqual([{ path: kept, app: 'obsidian' }]);
  });

  test('a broken vault list finds nothing and does not throw', () => {
    const home = tempHome();
    mkdirSync(join(home, 'Library/Application Support/obsidian'), { recursive: true });
    writeFileSync(join(home, 'Library/Application Support/obsidian/obsidian.json'), '{not json');
    expect(obsidianVaultFolders({ home, platform: 'darwin' })).toEqual([]);
  });

  test('the vault a file is in is looked for no higher than the chosen folder', () => {
    const home = tempHome();
    const notes = vault(join(home, 'Notes'));
    mkdirSync(join(notes, 'Daily'), { recursive: true });
    expect(obsidianVaultOf(join(notes, 'Daily/2026-11-15.md'), home)).toBe(notes);
    expect(obsidianVaultOf(join(notes, 'Daily/2026-11-15.md'), join(notes, 'Daily'))).toBeUndefined();
  });
});

describe('a cited note opens in Obsidian', () => {
  test('a Markdown note in a vault opens by obsidian:// when the app is installed; otherwise as before', () => {
    const home = tempHome();
    const notes = vault(join(home, 'My Notes'));
    const note = join(notes, 'Note.md');
    writeFileSync(join(home, 'plain.md'), '# plain');
    const installed = { obsidianInstalled: () => true };
    expect(localOpenArguments(note, [home], installed)).toEqual([`obsidian://open?path=${encodeURIComponent(note)}`]);
    expect(localOpenArguments(note, [home], { obsidianInstalled: () => false })).toEqual([note]);
    expect(localOpenArguments(join(home, 'plain.md'), [home], installed)).toEqual([join(home, 'plain.md')]);
    // Outside the chosen folders it is still refused.
    expect(localOpenArguments(note, [join(home, 'elsewhere')], installed)).toBeUndefined();
  });
});

describe('the folder picker offers vaults', () => {
  test('a vault in the home folder is tagged; one deep in Library is offered at the top', async () => {
    const home = tempHome();
    const inHome = vault(join(home, 'Notes'));
    const deep = vault(join(home, 'Library/Mobile Documents/iCloud~md~obsidian/Documents/Work'));
    mkdirSync(join(home, 'Documents'), { recursive: true });
    const volumes = new VolumeResolver({ platform: 'linux', home, readMounts: () => '' });
    const browser = createLocalFilesFolderScopeBrowser({
      volumes,
      context: { home, syncedRoots: [], platform: 'linux' },
      home,
      notesAppFolders: () => [{ path: inHome, app: 'obsidian' }, { path: deep, app: 'obsidian' }],
    });
    const page = await browser.browse({});
    const byName = new Map(page.nodes.map((node) => [node.name, node]));
    expect(byName.get('Notes')?.notes_app).toBe('obsidian');
    expect(byName.get('Documents')?.notes_app).toBeUndefined();
    expect(byName.get('Work')?.notes_app).toBe('obsidian');
    expect(byName.get('Work')?.key).toBe(deep);
    expect(page.nodes.filter((node) => node.key === inHome)).toHaveLength(1);
    const inside = await browser.browse({ parentKey: inHome });
    expect(inside.nodes.find((node) => node.name === '.obsidian')?.default_exclusion_reason).toBe('App settings');
  });
});
