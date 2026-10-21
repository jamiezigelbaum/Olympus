import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFileScopeSource, requireFileScopeSource } from '../src/core/file-scope-sources.ts';
import { createFileScopeBrowser } from '../src/workers/source-scope-browser.ts';
import {
  defaultExclusionForFolder,
  deepestDefaultExclusion,
  normalizeScopePath,
  scopePathFor,
  splitScopePath,
  type DefaultExclusionContext,
} from '../src/workers/local-files/paths.ts';
import { createLocalFilesFolderScopeBrowser } from '../src/workers/local-files/scope-browser.ts';
import {
  VolumeResolver,
  parseDarwinMounts,
  parseLinuxMountinfo,
} from '../src/workers/local-files/volume-identity.ts';
import { realPathOfScopePath, scopePathOfRealPath } from '../src/workers/local-files/locations.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const darwin: DefaultExclusionContext = { home: '/Users/jo', syncedRoots: ['/Users/jo/Sync'], platform: 'darwin' };
const linux: DefaultExclusionContext = { home: '/home/jo', syncedRoots: [], platform: 'linux' };

describe('the source is registered once, for this computer', () => {
  test('file-scope definition has no account and keeps path case', () => {
    const definition = requireFileScopeSource('local.files');
    expect(definition.account).toBe('this_computer');
    expect(definition.provider).toBe('local_files');
    expect(definition.filterFamily).toBe('locator_path');
    expect(definition.credentialCapability).toBeUndefined();
    expect(definition.normalizeKey('  /Users/Jo/Docs/ ')).toBe('/Users/Jo/Docs');
    expect(definition.normalizeKey('/')).toBe('/');
    expect(getFileScopeSource('local.files')?.rootKeys).toEqual(['/']);
  });
});

describe('folders that are off by default', () => {
  test('macOS: Library, caches, trash, version control, dependencies, build output, apps, synced folders', () => {
    const reason = (path: string) => defaultExclusionForFolder(path, darwin);
    expect(reason('/Users/jo/Library')).toBe('system_library');
    expect(reason('/Users/jo/.Trash')).toBe('trash');
    expect(reason('/Users/jo/Code/app/.git')).toBe('version_control');
    expect(reason('/Users/jo/Code/app/node_modules')).toBe('dependencies');
    expect(reason('/Users/jo/Code/app/dist')).toBe('build_output');
    expect(reason('/Users/jo/Applications/Thing.app')).toBe('app_bundle');
    expect(reason('/Users/jo/Dropbox')).toBe('synced_by_another_source');
    expect(reason('/Users/jo/Library/CloudStorage/GoogleDrive-a')).toBe('synced_by_another_source');
    expect(reason('/Users/jo/Sync')).toBe('synced_by_another_source');
    expect(reason('/Users/jo/.cache')).toBe('cache');
    expect(reason('/Users/jo/.olympus')).toBe('olympus_data');
    expect(reason('/Users/jo/Documents')).toBeUndefined();
  });

  test('Linux: its own trash and cache locations, and no Library rule', () => {
    expect(defaultExclusionForFolder('/home/jo/.local/share/Trash', linux)).toBe('trash');
    expect(defaultExclusionForFolder('/home/jo/.cache', linux)).toBe('cache');
    expect(defaultExclusionForFolder('/home/jo/.local/share/openclaw', linux)).toBe('olympus_data');
    expect(defaultExclusionForFolder('/home/jo/Library', linux)).toBeUndefined();
  });

  test('the deepest default-off folder on a path is the one that governs', () => {
    expect(deepestDefaultExclusion('/Users/jo/Library/Mail/x', darwin)).toEqual({ path: '/Users/jo/Library', reason: 'system_library' });
    expect(deepestDefaultExclusion('/Users/jo/Code/a/node_modules/b/dist', darwin)?.path).toBe('/Users/jo/Code/a/node_modules/b/dist');
    expect(deepestDefaultExclusion('/Users/jo/Documents/a', darwin)).toBeUndefined();
  });
});

describe('scope paths', () => {
  test('a disk other than the computer\'s own carries its identity in the key', () => {
    expect(scopePathFor('/Docs/a', 'mac-aaaa')).toBe('/@mac-aaaa/Docs/a');
    expect(splitScopePath('/@mac-aaaa/Docs/a')).toEqual({ volumeId: 'mac-aaaa', path: '/Docs/a' });
    expect(splitScopePath('/Users/jo')).toEqual({ path: '/Users/jo' });
    expect(normalizeScopePath('/Users/jo//Docs/')).toBe('/Users/jo/Docs');
    expect(() => normalizeScopePath('relative/path')).toThrow();
    expect(() => normalizeScopePath('/a/../b')).toThrow();
  });
});

describe('volume identity', () => {
  const MAC_MOUNTS = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
    '/dev/disk5s1 on /Volumes/Backup (apfs, local, journaled)',
    '//jo@nas.local/media on /Volumes/media (smbfs, nodev, nosuid, mounted by jo)',
  ].join('\n');

  test('macOS: disks are known by volume UUID, shares by their server path, the startup disk has no prefix', () => {
    const plists: Record<string, string> = {
      '/Volumes/Backup': '<dict><key>VolumeUUID</key><string>AAAAAAAA-1111-2222-3333-444444444444</string></dict>',
    };
    const resolver = new VolumeResolver({
      platform: 'darwin',
      home: '/Users/jo',
      readMounts: () => MAC_MOUNTS,
      diskutilPlist: (mountPoint) => plists[mountPoint],
    });
    const locations = resolver.locations();
    expect(locations.map((volume) => volume.label).sort()).toEqual(['Backup', 'media']);
    const backup = locations.find((volume) => volume.label === 'Backup')!;
    expect(backup.id).toBe('mac-aaaaaaaa-1111-2222-3333-444444444444');
    expect(locations.find((volume) => volume.label === 'media')!.id.startsWith('net-')).toBe(true);
    expect(resolver.volumeOf('/Users/jo/Documents').primary).toBe(true);
    expect(scopePathOfRealPath(resolver, '/Users/jo/Documents')).toBe('/Users/jo/Documents');
    expect(scopePathOfRealPath(resolver, '/Volumes/Backup/Photos')).toBe(`/@${backup.id}/Photos`);
    expect(realPathOfScopePath(resolver, `/@${backup.id}/Photos`)).toBe('/Volumes/Backup/Photos');
  });

  test('a different disk mounted at the same place is a different volume and is not selected', () => {
    const mounts = ['/dev/disk3s1s1 on / (apfs, local)', '/dev/disk9s1 on /Volumes/Backup (apfs, local)'].join('\n');
    const uuid = { value: 'AAAAAAAA-1111-2222-3333-444444444444' };
    const resolver = new VolumeResolver({
      platform: 'darwin',
      home: '/Users/jo',
      readMounts: () => mounts,
      diskutilPlist: () => `<key>VolumeUUID</key><string>${uuid.value}</string>`,
      now: () => 0,
    });
    const first = resolver.locations()[0]!;
    const selected = `/@${first.id}/Photos`;
    uuid.value = 'BBBBBBBB-1111-2222-3333-444444444444';
    resolver.refresh();
    const second = resolver.locations()[0]!;
    expect(second.mountPoint).toBe(first.mountPoint);
    expect(second.id).not.toBe(first.id);
    // The saved key names the first disk: the second one does not resolve through it.
    expect(realPathOfScopePath(resolver, selected)).toBeUndefined();
  });

  test('Linux: filesystem UUID from the device links, escapes in mount points undone', () => {
    const mountinfo = [
      '25 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
      '40 25 8:17 / /media/jo/My\\040Disk rw,nosuid shared:50 - ext4 /dev/sdb1 rw',
      '41 25 0:50 / /proc rw - proc proc rw',
      '',
    ].join('\n');
    const parsed = parseLinuxMountinfo(mountinfo);
    expect(parsed.map((mount) => mount.mountPoint)).toEqual(['/', '/media/jo/My Disk', '/proc']);
    const resolver = new VolumeResolver({
      platform: 'linux',
      home: '/home/jo',
      readMounts: () => mountinfo,
      uuidsByDevice: () => new Map([['/dev/sdb1', 'AB12-CD34']]),
    });
    const [disk] = resolver.locations();
    expect(disk?.id).toBe('lin-ab12-cd34');
    expect(disk?.label).toBe('My Disk');
    expect(parseDarwinMounts('/dev/disk5s1 on /Volumes/Backup (apfs, local)')[0]?.fsType).toBe('apfs');
  });
});

describe('the folder picker', () => {
  function home() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'lf-picker-')));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const homeDir = join(base, 'home');
    for (const dir of ['Documents', 'Library', 'Code', 'Code/app', 'Code/app/node_modules', '.git', '.Trash']) {
      mkdirSync(join(homeDir, dir), { recursive: true });
    }
    writeFileSync(join(homeDir, 'loose-file.txt'), 'x');
    symlinkSync(join(homeDir, 'Documents'), join(homeDir, 'link-to-documents'));
    const resolver = new VolumeResolver({
      platform: 'darwin',
      home: homeDir,
      readMounts: () => `/dev/disk3s1s1 on / (apfs, local)\n/dev/disk5s1 on /Volumes/Backup (apfs, local)`,
      diskutilPlist: () => '<key>VolumeUUID</key><string>AAAAAAAA-1111-2222-3333-444444444444</string>',
    });
    const context: DefaultExclusionContext = { home: homeDir, syncedRoots: [], platform: 'darwin' };
    return { base, homeDir, browser: createLocalFilesFolderScopeBrowser({ volumes: resolver, context, home: homeDir }) };
  }

  test('lists only folders, from home, with disks as locations; off-by-default folders are shown and marked', async () => {
    const f = home();
    const page = await f.browser.browse({});
    const byName = new Map(page.nodes.map((node) => [node.name, node]));
    expect([...byName.keys()]).toEqual(['Code', 'Documents', 'Library', '.git', '.Trash', 'Backup']);
    expect(byName.get('Library')?.excluded_by_default).toBe(true);
    expect(byName.get('Library')?.default_exclusion_reason).toBe('Application data');
    expect(byName.get('.git')?.excluded_by_default).toBe(true);
    expect(byName.get('.Trash')?.default_exclusion_reason).toBe('Trash');
    expect(byName.get('Documents')?.excluded_by_default).toBeUndefined();
    expect(byName.get('Backup')?.key.startsWith('/@mac-')).toBe(true);
    // Not a file, not a link.
    expect(byName.has('loose-file.txt')).toBe(false);
    expect(byName.has('link-to-documents')).toBe(false);
    // Nothing is selected for the person: the browser has no notion of a default selection.
    expect(page.nodes.every((node) => node.selectable)).toBe(true);
  });

  test('descends by key, marks dependencies inside a project, and pages with a bound cursor', async () => {
    const f = home();
    const inner = await f.browser.browse({ parentKey: join(f.homeDir, 'Code', 'app') });
    expect(inner.nodes.map((node) => [node.name, node.excluded_by_default === true])).toEqual([['node_modules', true]]);
    expect(inner.nodes[0]?.parent_key).toBe(join(f.homeDir, 'Code', 'app'));

    const big = join(f.homeDir, 'many');
    for (let index = 0; index < 120; index += 1) mkdirSync(join(big, `d${String(index).padStart(3, '0')}`), { recursive: true });
    const first = await f.browser.browse({ parentKey: big });
    expect(first.nodes).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const second = await f.browser.browse({ parentKey: big, cursor: first.nextCursor! });
    expect(second.nodes).toHaveLength(20);
    expect(second.nextCursor).toBeUndefined();
    await expect(f.browser.browse({ parentKey: join(f.homeDir, 'Code'), cursor: first.nextCursor! })).rejects.toThrow();
  });

  test('selections are verified, whole-computer needs confirmation, ancestors decide the effective state', async () => {
    const f = home();
    const code = join(f.homeDir, 'Code');
    const app = join(code, 'app');
    const checked = await f.browser.validateSelections([
      { key: code, state: 'metadata_only' },
      { key: app, state: 'ingest' },
    ]);
    expect(checked.find((entry) => entry.key === app)).toEqual({
      key: app,
      state: 'metadata_only',
      ancestorKeys: expect.arrayContaining([code]),
    });
    await expect(f.browser.validateSelections([{ key: '/', state: 'ingest' }])).rejects.toThrow(/confirmation/);
    await expect(f.browser.validateSelections([{ key: join(f.homeDir, 'nowhere'), state: 'ingest' }])).rejects.toThrow();
    await expect(f.browser.validateSelections([{ key: join(f.homeDir, 'loose-file.txt'), state: 'ingest' }])).rejects.toThrow();
  });

  test('is the browser the shared registry hands out for local.files', async () => {
    const browser = createFileScopeBrowser('local.files', {});
    expect(browser.sourceId).toBe('local.files');
  });
});
