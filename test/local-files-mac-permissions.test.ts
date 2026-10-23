import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FILES_AND_FOLDERS_URL,
  FULL_DISK_ACCESS_URL,
  MAC_ACCESS_COPY,
  ENGINE_HELPER_ENV,
  MacPermissions,
  permissionHostKind,
  permissionHostPresent,
} from '../src/workers/local-files/mac-permissions.ts';
import { revealHelperAndOpenFullDiskAccess } from '../src/workers/local-files/mac-settings.ts';
import { LocalFilesRootPermissionError } from '../src/workers/local-files/connector.ts';
import { createLocalFilesSchedulerSource } from '../src/workers/local-files/scheduler-source.ts';
import { defaultConfig } from '../src/core/config.ts';
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

  test('an unreadable ordinary folder without Full Disk Access points to Full Disk Access', async () => {
    const f = fixture({ fullDiskAccess: false });
    const browser = createLocalFilesFolderScopeBrowser({
      volumes: new VolumeResolver({ platform: 'darwin', home: f.home, readMounts: () => '/dev/disk3s1s1 on / (apfs, local)' }),
      context: { home: f.home, syncedRoots: [], platform: 'darwin' },
      home: f.home,
      permissions: f.permissions,
      readDirectory: () => { throw refusal('EPERM'); },
    });
    const page = await browser.browse({ parentKey: join(f.home, 'Code') });
    expect(page.access?.state).toBe('needs_full_disk_access');
  });

  test('without the helper app, saving the whole computer opens nothing', async () => {
    const f = fixture({ fullDiskAccess: false, helper: false });
    await f.browser.afterApproval!({ wholeAccount: true });
    expect(f.opened()).toBe(0);
  });

  test('without the engine running under the helper, a guarded folder, the home folder and the whole computer cannot be saved', () => {
    const f = fixture({ helper: false });
    const save = (keys: string[], wholeAccount = false) =>
      f.browser.checkApproval!({ selections: keys.map((key) => ({ key, state: 'ingest' as const })), wholeAccount });
    expect(() => save([join(f.home, 'Documents')])).toThrow(MAC_ACCESS_COPY.needsHelper);
    expect(() => save([join(f.home, 'Documents', 'Taxes')])).toThrow(MAC_ACCESS_COPY.needsHelper);
    expect(() => save([join(f.home, 'Desktop')])).toThrow('helper app');
    expect(() => save([f.home])).toThrow('helper app');
    expect(() => save([], true)).toThrow('helper app');
    expect(() => save(['/'])).toThrow('helper app');
    expect(() => save([join(f.home, 'Code')])).not.toThrow();
    expect(() => f.browser.checkApproval!({ selections: [{ key: join(f.home, 'Documents'), state: 'exclude' }], wholeAccount: false })).not.toThrow();
    const withHelper = fixture({ helper: true });
    expect(() => withHelper.browser.checkApproval!({ selections: [{ key: join(withHelper.home, 'Documents'), state: 'ingest' }], wholeAccount: true })).not.toThrow();
  });

  test('the scheduler never pulls, extracts or watches a guarded folder without the helper, whatever was saved', async () => {
    const f = fixture({ helper: false });
    const pulled: string[] = [];
    const root = (path: string) => ({ path, approved_scope_key: `scope:${path}`, default_action: 'full_extract' });
    const source = createLocalFilesSchedulerSource({
      policy: { corpusId: 'c', roots: [root(join(f.home, 'Documents')), root(join(f.home, 'Code'))], sync: { cadence: 'daily' }, content: { plan_limit: 1, batch_size: 1 } } as never,
      config: defaultConfig(),
      providerSync: { pull: async ({ approved_scope_key }: { approved_scope_key: string }) => { pulled.push(approved_scope_key); return { receipt: { status: 'ok', counts: {} }, checkpoint: 'x' }; }, connectorIdForScope: () => 'k' } as never,
      store: { lastCompletedSyncRun: () => undefined } as never,
      fileExtraction: {} as never,
      macPermissions: f.permissions,
      volumes: new VolumeResolver({ platform: 'darwin', home: f.home, readMounts: () => '/dev/disk3s1s1 on / (apfs, local)' }),
    })!;
    const syncs = source.tasks.filter((task) => task.kind === 'sync');
    expect(syncs).toHaveLength(2);
    await expect(syncs[0]!.run()).rejects.toThrow(MAC_ACCESS_COPY.needsHelper);
    await syncs[1]!.run();
    expect(pulled).toEqual([`scope:${join(f.home, 'Code')}`]);
    expect(source.tasks.filter((task) => task.id.startsWith('local.files_extract.'))).toHaveLength(1);
  });

  test('Full Disk Access is only "on" when a protected folder lists; a missing one proves nothing', () => {
    const probe = (behaviour: (path: string) => void) =>
      new MacPermissions({ platform: 'darwin', home: '/h', helperPresent: () => true, listProtected: behaviour }).hasFullDiskAccess();
    expect(probe(() => undefined)).toBe(true);
    expect(probe(() => { throw refusal('EPERM'); })).toBe(false);
    expect(probe(() => { throw refusal('ENOENT'); })).toBe(false);
    expect(probe((path) => { if (path.endsWith('Safari')) throw refusal('ENOENT'); })).toBe(true);
    expect(probe((path) => { if (path.endsWith('Safari')) throw refusal('ENOENT'); throw refusal('EPERM'); })).toBe(false);
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
    expect((await off.browser.browse({})).access).toEqual({ state: 'needs_full_disk_access', message: MAC_ACCESS_COPY.fullDiskAccess(), settings_url: FULL_DISK_ACCESS_URL });
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

test('only the standalone engine without the helper lacks an app for macOS to name', () => {
  expect(permissionHostPresent({ OLYMPUS_ENGINE_HOST: '1' })).toBe(false);
  expect(permissionHostPresent({ OLYMPUS_STANDALONE: '1' })).toBe(false);
  expect(permissionHostPresent({ OLYMPUS_MANAGED_WORKER: '1' })).toBe(false);
  expect(permissionHostPresent({ OLYMPUS_ENGINE_HOST: '1', [ENGINE_HELPER_ENV]: '1' })).toBe(true);
  expect(permissionHostPresent({})).toBe(true);
});

test('who the Mac blames follows the environment', () => {
  expect(permissionHostKind({ [ENGINE_HELPER_ENV]: '1', OLYMPUS_ENGINE_HOST: '1' })).toBe('engine_helper');
  expect(permissionHostKind({ OLYMPUS_ENGINE_HOST: '1' })).toBe('engine_without_helper');
  expect(permissionHostKind({ OLYMPUS_MANAGED_WORKER: '1' })).toBe('managed_worker');
  expect(permissionHostKind({})).toBe('other');
});

describe('each cause gets its own action', () => {
  const root = (path: string) => ({ path, approved_scope_key: `scope:${path}`, default_action: 'metadata_only' });
  function schedulerFor(f: ReturnType<typeof fixture>, folders: string[], pull: () => Promise<unknown>, permissions = f.permissions) {
    return createLocalFilesSchedulerSource({
      policy: { corpusId: 'c', roots: folders.map(root), sync: { cadence: 'daily' }, content: { plan_limit: 1, batch_size: 1 } } as never,
      config: defaultConfig(),
      providerSync: { pull, connectorIdForScope: () => 'k' } as never,
      store: { lastCompletedSyncRun: () => undefined } as never,
      macPermissions: permissions,
      volumes: new VolumeResolver({ platform: 'darwin', home: f.home, readMounts: () => '/dev/disk3s1s1 on / (apfs, local)' }),
    })!;
  }
  async function failureOf(run: () => Promise<unknown>): Promise<{ errorKind: string; reason: string | undefined; message: string }> {
    try { await run(); } catch (error) {
      const failure = error as { errorKind: string; retryAt?: { degradedReason?: string }; message: string };
      return { errorKind: failure.errorKind, reason: failure.retryAt?.degradedReason, message: failure.message };
    }
    throw new Error('expected a failure');
  }

  test('a missing helper stalls as "helper needed" (no privacy-settings button), and the reason matches the kind', async () => {
    const f = fixture({ helper: false });
    const source = schedulerFor(f, [join(f.home, 'Documents')], async () => { throw new Error('not read'); });
    const failure = await failureOf(() => source.tasks.find((task) => task.kind === 'sync')!.run());
    expect(failure.errorKind).toBe('scope_root_helper_needed');
    expect(failure.reason).toBe('scope_root_helper_needed');
    expect(failure.message).toContain('olympus engine install-helper');
  });

  test('the Mac\'s privacy refusal keeps the Files & Folders reason; an ordinary refusal is its own reason', async () => {
    const f = fixture({ helper: true });
    const refuse = (errno: 'EACCES' | 'EPERM') => async () => { throw new LocalFilesRootPermissionError('x', errno); };
    const kindFor = async (folder: string, errno: 'EACCES' | 'EPERM') =>
      (await failureOf(() => schedulerFor(f, [folder], refuse(errno)).tasks.find((task) => task.kind === 'sync')!.run())).errorKind;
    // macOS answers a privacy refusal with EPERM, a mode refusal with EACCES.
    expect(await kindFor(join(f.home, 'Code'), 'EPERM')).toBe('scope_root_permission_needed');
    expect(await kindFor(join(f.home, 'Code'), 'EACCES')).toBe('scope_root_unreadable');
    // A guarded folder is the Mac's rule whichever errno came back.
    expect(await kindFor(join(f.home, 'Documents'), 'EACCES')).toBe('scope_root_permission_needed');
    const linux = fixture({ platform: 'linux', helper: true });
    const linuxSource = schedulerFor(linux, [join(linux.home, 'Code')], refuse('EPERM'));
    expect((await failureOf(() => linuxSource.tasks.find((task) => task.kind === 'sync')!.run())).errorKind).toBe('scope_root_unreadable');
  });

  test('an ordinary refusal in the picker is not Full Disk Access; a privacy refusal outside the guarded folders is', async () => {
    const f = fixture({ fullDiskAccess: false });
    const browse = (platform: NodeJS.Platform, code: string, fda = false) => {
      const permissions = new MacPermissions({ platform, home: f.home, helperPresent: () => true, listProtected: () => { if (!fda) throw refusal('EPERM'); } });
      return createLocalFilesFolderScopeBrowser({ volumes: new VolumeResolver({ platform: 'darwin', home: f.home, readMounts: () => '/dev/disk3s1s1 on / (apfs, local)' }), context: { home: f.home, platform }, home: f.home, permissions, readDirectory: () => { throw refusal(code); } })
        .browse({ parentKey: join(f.home, 'Code') });
    };
    expect((await browse('darwin', 'EPERM')).access?.state).toBe('needs_full_disk_access');
    await expect(browse('darwin', 'EACCES')).rejects.toThrow(MAC_ACCESS_COPY.unreadable);
    await expect(browse('linux', 'EACCES')).rejects.toThrow(MAC_ACCESS_COPY.unreadableLinux);
    await expect(browse('linux', 'EPERM')).rejects.toThrow(MAC_ACCESS_COPY.unreadableLinux);
    expect(MAC_ACCESS_COPY.unreadable).not.toContain('Full Disk Access');
    expect(MAC_ACCESS_COPY.unreadableLinux).not.toContain('System Settings');
  });
});

describe('the words fit the app the Mac actually names', () => {
  const guard = { kind: 'documents' as const, root: '/h/Documents' };
  const make = (hostKind: 'engine_helper' | 'engine_without_helper' | 'managed_worker' | 'other') => new MacPermissions({
    platform: 'darwin', home: '/h', hostKind: () => hostKind,
    helperPresent: () => hostKind === 'engine_helper' || hostKind === 'other',
    list: async () => { throw refusal('EPERM'); }, listProtected: () => { throw refusal('EPERM'); },
  });

  test('Olympus Engine only when the helper stands behind it; another host is named as the app your Mac asked about', async () => {
    const helper = make('engine_helper');
    expect(helper.noteDenied(guard).message).toContain('under Olympus Engine');
    expect(helper.fullDiskAccessNote()?.message).toContain('Olympus Engine needs Full Disk Access');
    const other = make('other');
    for (const message of [other.noteDenied(guard).message, other.fullDiskAccessNote()!.message]) {
      expect(message).not.toContain('Olympus Engine');
      expect(message).toContain('the app that runs Olympus');
    }
    expect((await other.open(guard))?.state).toBe('denied');
  });

  test('OpenClaw\'s own worker is never told to install a helper it would not be launched through', () => {
    const worker = make('managed_worker');
    expect(worker.nodeAccess(guard)).toEqual({ state: 'needs_helper', message: MAC_ACCESS_COPY.needsHelperManagedWorker });
    expect(worker.fullDiskAccessNote()).toEqual({ state: 'needs_helper', message: MAC_ACCESS_COPY.needsHelperManagedWorkerWholeComputer });
    expect(MAC_ACCESS_COPY.needsHelperManagedWorker).toContain('OpenClaw');
    expect(MAC_ACCESS_COPY.needsHelperManagedWorker).not.toContain('Then choose Try again');
    // The standalone engine without the helper still gets the install instruction.
    expect(make('engine_without_helper').helperNeededCopy()).toBe(MAC_ACCESS_COPY.needsHelper);
  });
});
