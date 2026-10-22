import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FILES_AND_FOLDERS_URL,
  FULL_DISK_ACCESS_URL,
  MAC_ACCESS_COPY,
  MacPermissions,
} from '../src/workers/local-files/mac-permissions.ts';
import { revealHelperAndOpenFullDiskAccess } from '../src/workers/local-files/mac-settings.ts';
import { createLocalFilesFolderScopeBrowser } from '../src/workers/local-files/scope-browser.ts';
import type { DefaultExclusionContext } from '../src/workers/local-files/paths.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const refusal = (code: string) => Object.assign(new Error(code), { code });

function fixture(options: {
  platform?: NodeJS.Platform;
  helper?: boolean;
  list?: (path: string) => Promise<unknown>;
  fullDiskAccess?: boolean;
  timeout?: number;
  persist?: boolean;
} = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lf-mac-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  for (const dir of ['Desktop', 'Documents/Taxes', 'Downloads', 'Library/Mobile Documents', 'Code/app']) mkdirSync(join(home, dir), { recursive: true });
  const asked: string[] = [];
  const memoryPath = options.persist ? join(base, 'data', 'folder-access.json') : undefined;
  const permissions = new MacPermissions({
    platform: options.platform ?? 'darwin',
    home,
    helperPresent: () => options.helper ?? true,
    ...(memoryPath ? { memoryPath } : {}),
    askTimeoutMs: options.timeout ?? 50,
    list: async (path) => { asked.push(path); return options.list ? options.list(path) : []; },
    listProtected: () => { if (options.fullDiskAccess === false) throw refusal('EPERM'); },
  });
  const volumes = new VolumeResolver({
    platform: 'darwin',
    home,
    readMounts: () => '/dev/disk3s1s1 on / (apfs, local)\n/dev/disk5s1 on /Volumes/Backup (apfs, local)',
    diskutilPlist: () => '<key>VolumeUUID</key><string>AAAAAAAA-1111-2222-3333-444444444444</string>',
  });
  const context: DefaultExclusionContext = { home, syncedRoots: [], platform: 'darwin' };
  let opened = 0;
  const browser = createLocalFilesFolderScopeBrowser({ volumes, context, home, permissions, openFullDiskAccess: () => { opened += 1; } });
  return { base, home, permissions, browser, asked, memoryPath, opened: () => opened };
}

describe('which folders the Mac asks about', () => {
  test('Desktop, Documents, Downloads, iCloud Drive and unplugged disks are guarded; Code is not; Linux has none', () => {
    const f = fixture();
    const kind = (path: string) => f.permissions.guardOf(join(f.home, path))?.kind;
    expect(kind('Desktop')).toBe('desktop');
    expect(kind('Documents')).toBe('documents');
    expect(kind('Documents/Taxes')).toBe('documents');
    expect(kind('Downloads')).toBe('downloads');
    expect(kind('Library/Mobile Documents')).toBe('icloud');
    expect(kind('Code/app')).toBeUndefined();
    expect(kind('Documents2')).toBeUndefined();
    expect(f.permissions.guardOf('/Volumes/Backup', { kind: 'removable', mountPoint: '/Volumes/Backup', primary: false })).toEqual({ kind: 'removable', root: '/Volumes/Backup' });
    expect(f.permissions.guardOf('/mnt/share', { kind: 'network', mountPoint: '/mnt/share', primary: false })?.kind).toBe('network');
    expect(f.permissions.guardOf('/', { kind: 'internal', mountPoint: '/', primary: true })).toBeUndefined();
    const linux = fixture({ platform: 'linux' });
    expect(linux.permissions.guardOf(join(linux.home, 'Documents'))).toBeUndefined();
    expect(linux.permissions.active).toBe(false);
  });
});

describe('the picker\'s states for a guarded folder', () => {
  test('top level: guarded folders say Needs permission, Code does not, and nothing is read to find out', async () => {
    const f = fixture();
    const page = await f.browser.browse({});
    const byName = new Map(page.nodes.map((node) => [node.name, node]));
    for (const name of ['Desktop', 'Documents', 'Downloads']) {
      expect(byName.get(name)?.access).toEqual({ state: 'needs_permission', message: MAC_ACCESS_COPY.needsPermission });
    }
    expect(byName.get('Code')?.access).toBeUndefined();
    expect(byName.get('Backup')?.access?.state).toBe('needs_permission');
    // Showing the list never touches a guarded folder.
    expect(f.asked).toEqual([]);
    // Inside a guarded place the answer already holds: no label on its children.
    const granted = await f.browser.browse({ parentKey: join(f.home, 'Documents') });
    expect(granted.access).toBeUndefined();
    expect(granted.nodes.map((node) => node.name)).toEqual(['Taxes']);
    expect(granted.nodes[0]?.access).toBeUndefined();
    expect(f.asked).toEqual([join(f.home, 'Documents')]);
  });

  test('after the Mac allowed a folder, it is no longer labelled, even after a restart', async () => {
    const f = fixture({ persist: true });
    await f.browser.browse({ parentKey: join(f.home, 'Documents') });
    expect(JSON.parse(readFileSync(f.memoryPath!, 'utf8'))[join(f.home, 'Documents')].answer).toBe('granted');
    const again = await f.browser.browse({});
    expect(again.nodes.find((node) => node.name === 'Documents')?.access).toBeUndefined();
    expect(again.nodes.find((node) => node.name === 'Desktop')?.access?.state).toBe('needs_permission');
    // A new engine run reads the same memory.
    const restarted = new MacPermissions({ platform: 'darwin', home: f.home, helperPresent: () => true, memoryPath: f.memoryPath! });
    expect(restarted.nodeAccess({ kind: 'documents', root: join(f.home, 'Documents') })).toBeUndefined();
  });

  test('denied: the level is empty on purpose and says exactly how to turn it back on', async () => {
    const f = fixture({ list: async () => { throw refusal('EPERM'); } });
    const page = await f.browser.browse({ parentKey: join(f.home, 'Documents') });
    expect(page.nodes).toEqual([]);
    expect(page.access?.state).toBe('denied');
    expect(page.access?.message).toContain('Privacy & Security');
    expect(page.access?.message).toContain('Files & Folders');
    expect(page.access?.message).toContain('Documents Folder under Olympus Engine');
    expect(page.access?.settings_url).toBe(FILES_AND_FOLDERS_URL);
    const downloads = await f.browser.browse({ parentKey: join(f.home, 'Downloads') });
    expect(downloads.access?.message).toContain('Downloads Folder under Olympus Engine');
    const backupKey = (await f.browser.browse({})).nodes.find((node) => node.name === 'Backup')!.key;
    const backup = await f.browser.browse({ parentKey: backupKey });
    expect(backup.access?.message).toContain('Removable Volumes under Olympus Engine');
  });

  test('a read that fails after the ask was allowed (the Mac turned it off later) is a denial, not a thrown error', async () => {
    const f = fixture();
    // The ask succeeds, then the real read is refused.
    const browser = createLocalFilesFolderScopeBrowser({
      volumes: new VolumeResolver({ platform: 'darwin', home: f.home, readMounts: () => '/dev/disk3s1s1 on / (apfs, local)' }),
      context: { home: f.home, syncedRoots: [], platform: 'darwin' },
      home: f.home,
      permissions: f.permissions,
      readDirectory: () => { throw refusal('EACCES'); },
    });
    const page = await browser.browse({ parentKey: join(f.home, 'Documents') });
    expect(page.access?.state).toBe('denied');
  });

  test('an ordinary unreadable folder says what to check, not a Mac privacy switch', async () => {
    const f = fixture();
    const browser = createLocalFilesFolderScopeBrowser({
      volumes: new VolumeResolver({ platform: 'darwin', home: f.home, readMounts: () => '/dev/disk3s1s1 on / (apfs, local)' }),
      context: { home: f.home, syncedRoots: [], platform: 'darwin' },
      home: f.home,
      permissions: f.permissions,
      readDirectory: () => { throw refusal('EACCES'); },
    });
    await expect(browser.browse({ parentKey: join(f.home, 'Code') })).rejects.toThrow(/Sharing & Permissions/);
  });

  test('waiting: a question still on screen answers "waiting", and the answer is used when it arrives', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({ list: async () => { await gate; return []; }, timeout: 10, persist: true });
    const first = await f.browser.browse({ parentKey: join(f.home, 'Documents') });
    expect(first.nodes).toEqual([]);
    expect(first.access).toEqual({ state: 'waiting', message: MAC_ACCESS_COPY.waiting });
    // Asking again while it is still open does not ask the Mac a second time.
    await f.browser.browse({ parentKey: join(f.home, 'Documents') });
    expect(f.asked).toEqual([join(f.home, 'Documents')]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await f.browser.browse({ parentKey: join(f.home, 'Documents') });
    expect(after.access).toBeUndefined();
    expect(after.nodes.map((node) => node.name)).toEqual(['Taxes']);
  });

  test('without the helper nothing is read: the folder says what is needed, never the Bun workaround', async () => {
    const f = fixture({ helper: false });
    const top = await f.browser.browse({});
    expect(top.nodes.find((node) => node.name === 'Documents')?.access).toEqual({ state: 'needs_helper', message: MAC_ACCESS_COPY.needsHelper });
    const page = await f.browser.browse({ parentKey: join(f.home, 'Documents') });
    expect(page).toEqual({ nodes: [], access: { state: 'needs_helper', message: MAC_ACCESS_COPY.needsHelper } });
    expect(f.asked).toEqual([]);
    expect(MAC_ACCESS_COPY.needsHelper).toContain('helper app');
    expect(MAC_ACCESS_COPY.needsHelper.toLowerCase()).not.toContain('bun');
  });

  test('an ordinary disk error during the ask is an error, not a denial', async () => {
    const f = fixture({ list: async () => { throw refusal('EIO'); } });
    await expect(f.browser.browse({ parentKey: join(f.home, 'Documents') })).rejects.toThrow();
  });

  test('Linux: no labels, no asking, folders list as before', async () => {
    const f = fixture({ platform: 'linux', helper: false });
    const top = await f.browser.browse({});
    expect(top.nodes.every((node) => node.access === undefined)).toBe(true);
    expect(top.access).toBeUndefined();
    const page = await f.browser.browse({ parentKey: join(f.home, 'Documents') });
    expect(page.access).toBeUndefined();
    expect(f.asked).toEqual([]);
  });
});

describe('Full Disk Access for the whole computer', () => {
  test('the top level says what to switch on when it is off, and nothing when it is on', async () => {
    const off = fixture({ fullDiskAccess: false });
    expect((await off.browser.browse({})).access).toEqual({ state: 'needs_full_disk_access', message: MAC_ACCESS_COPY.fullDiskAccess, settings_url: FULL_DISK_ACCESS_URL });
    expect((await fixture({ fullDiskAccess: true }).browser.browse({})).access).toBeUndefined();
    expect((await fixture({ fullDiskAccess: false, helper: false }).browser.browse({})).access?.state).toBe('needs_helper');
  });

  test('saving the whole computer without it opens the privacy page and shows the helper; a folder choice or a granted switch does not', async () => {
    const off = fixture({ fullDiskAccess: false });
    await off.browser.afterApproval!({ wholeAccount: false });
    expect(off.opened()).toBe(0);
    await off.browser.afterApproval!({ wholeAccount: true });
    expect(off.opened()).toBe(1);
    const on = fixture({ fullDiskAccess: true });
    await on.browser.afterApproval!({ wholeAccount: true });
    expect(on.opened()).toBe(0);
  });

  test('the action is "show the helper app, then open the Full Disk Access page", and shows nothing that is not there', () => {
    const ran: string[][] = [];
    revealHelperAndOpenFullDiskAccess({ run: (command, args) => { ran.push([command, ...args]); }, exists: () => true, helperApp: '/h/Olympus Engine.app' });
    expect(ran).toEqual([['/usr/bin/open', '-R', '/h/Olympus Engine.app'], ['/usr/bin/open', FULL_DISK_ACCESS_URL]]);
    ran.length = 0;
    revealHelperAndOpenFullDiskAccess({ run: (command, args) => { ran.push([command, ...args]); }, exists: () => false, helperApp: '/h/x.app' });
    expect(ran).toEqual([['/usr/bin/open', FULL_DISK_ACCESS_URL]]);
  });
});
