/**
 * Which volume a path is on, and what that volume is called in a scope path.
 *
 * Folders on a removable or network volume are bound to the volume, not to
 * the place it happens to be mounted: the volume UUID on a Mac, the filesystem
 * UUID on Linux, or the server and share for a network mount. A different
 * disk mounted at the same name therefore has a different id and starts with
 * nothing selected.
 *
 * The computer's own volumes (the startup volume, the macOS Data volume and
 * the volume holding the home folder) are "primary": their paths carry no
 * prefix, so ordinary files read as ordinary paths.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isWithinScopePath } from './paths.ts';

export type VolumeKind = 'internal' | 'removable' | 'network';

export interface MountedVolume {
  /** The id used in scope paths (`mac-…`, `lin-…`, `net-…`, `dev-…`). */
  id: string;
  /** Where it is mounted now (a real path). */
  mountPoint: string;
  /** What the person calls it: the mount folder's name. */
  label: string;
  kind: VolumeKind;
  /** Primary volumes have no prefix in scope paths. */
  primary: boolean;
}

export interface VolumeIdentityDeps {
  platform?: NodeJS.Platform;
  home?: string;
  /** Output of `mount` (macOS) or the text of /proc/self/mountinfo (Linux). */
  readMounts?: () => string;
  /** Output of `diskutil info -plist <mountpoint>` (macOS). */
  diskutilPlist?: (mountPoint: string) => string | undefined;
  /** Filesystem UUIDs by device node: the /dev/disk/by-uuid links (Linux). */
  uuidsByDevice?: () => Map<string, string>;
  now?: () => number;
}

interface RawMount {
  source: string;
  mountPoint: string;
  fsType: string;
}

const NETWORK_FS_TYPES = new Set([
  'nfs', 'nfs4', 'cifs', 'smbfs', 'smb3', 'afpfs', 'webdav', 'fuse.sshfs', 'sshfs', 'ceph', 'glusterfs', '9p', 'davfs',
]);
const IGNORED_FS_TYPES = new Set([
  'autofs', 'devfs', 'devtmpfs', 'proc', 'sysfs', 'tmpfs', 'cgroup', 'cgroup2', 'overlay', 'squashfs', 'fdescfs',
  'securityfs', 'debugfs', 'tracefs', 'pstore', 'bpf', 'configfs', 'fusectl', 'mqueue', 'hugetlbfs', 'binfmt_misc',
  'ramfs', 'rpc_pipefs', 'nsfs', 'efivarfs', 'autofs', 'fuse.portal', 'fuse.gvfsd-fuse',
]);
const CACHE_TTL_MS = 15_000;

export class VolumeResolver {
  private readonly deps: Required<Pick<VolumeIdentityDeps, 'platform' | 'home' | 'now'>> & VolumeIdentityDeps;
  private cache: { at: number; volumes: MountedVolume[] } | undefined;

  constructor(deps: VolumeIdentityDeps = {}) {
    this.deps = {
      ...deps,
      platform: deps.platform ?? process.platform,
      home: deps.home ?? homedir(),
      now: deps.now ?? Date.now,
    };
  }

  /** Every volume currently mounted that can hold a folder, primary ones included. */
  volumes(): MountedVolume[] {
    const now = this.deps.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.volumes;
    const volumes = this.scan();
    this.cache = { at: now, volumes };
    return volumes;
  }

  refresh(): void {
    this.cache = undefined;
  }

  /** The volume holding `realPath`: the deepest mount point that contains it. */
  volumeOf(realPath: string): MountedVolume {
    let best: MountedVolume | undefined;
    for (const volume of this.volumes()) {
      if (!isWithinScopePath(realPath, volume.mountPoint)) continue;
      if (!best || volume.mountPoint.length > best.mountPoint.length) best = volume;
    }
    // A path no mount claims is on the startup volume.
    return best ?? this.primaryFallback();
  }

  /** The mounted volume called `id`, or undefined when it is not mounted now. */
  mountedVolume(id: string): MountedVolume | undefined {
    return this.volumes().find((volume) => volume.id === id);
  }

  /** Mounted volumes that are not primary: the picker's Locations. */
  locations(): MountedVolume[] {
    return this.volumes().filter((volume) => !volume.primary);
  }

  private primaryFallback(): MountedVolume {
    return { id: 'primary', mountPoint: '/', label: 'Macintosh HD', kind: 'internal', primary: true };
  }

  private scan(): MountedVolume[] {
    let raw: RawMount[] = [];
    try {
      const text = this.deps.readMounts ? this.deps.readMounts() : defaultReadMounts(this.deps.platform);
      raw = this.deps.platform === 'darwin' ? parseDarwinMounts(text) : parseLinuxMountinfo(text);
    } catch {
      raw = [];
    }
    const uuids = this.deps.platform === 'linux' ? (this.deps.uuidsByDevice ?? defaultUuidsByDevice)() : undefined;
    const homeMount = this.homeMountPoint(raw);
    const volumes: MountedVolume[] = [];
    for (const mount of raw) {
      if (IGNORED_FS_TYPES.has(mount.fsType) && mount.mountPoint !== '/') continue;
      if (mount.mountPoint !== '/' && /^\/(proc|sys|dev|run|snap|boot)(\/|$)/.test(mount.mountPoint)) continue;
      if (this.deps.platform === 'darwin' && /^\/System\/Volumes\/(?!Data$)/.test(mount.mountPoint)) continue;
      if (this.deps.platform === 'darwin' && mount.mountPoint.startsWith('/private/var/')) continue;
      const network = NETWORK_FS_TYPES.has(mount.fsType);
      const primary = mount.mountPoint === '/'
        || mount.mountPoint === '/System/Volumes/Data'
        || mount.mountPoint === homeMount;
      const id = primary ? 'primary' : this.idFor(mount, network, uuids);
      if (!id) continue;
      volumes.push({
        id,
        mountPoint: mount.mountPoint,
        label: labelFor(mount.mountPoint),
        kind: network ? 'network' : primary ? 'internal' : 'removable',
        primary,
      });
    }
    if (!volumes.some((volume) => volume.mountPoint === '/')) volumes.push(this.primaryFallback());
    return volumes;
  }

  private homeMountPoint(mounts: readonly RawMount[]): string | undefined {
    let best: RawMount | undefined;
    for (const mount of mounts) {
      if (!isWithinScopePath(this.deps.home, mount.mountPoint)) continue;
      if (!best || mount.mountPoint.length > best.mountPoint.length) best = mount;
    }
    return best?.mountPoint;
  }

  private idFor(mount: RawMount, network: boolean, uuids: Map<string, string> | undefined): string | undefined {
    if (network) return `net-${shortHash(normalizeNetworkSource(mount.source))}`;
    if (this.deps.platform === 'darwin') {
      const plist = (this.deps.diskutilPlist ?? defaultDiskutilPlist)(mount.mountPoint);
      const uuid = plist ? plistString(plist, 'VolumeUUID') : undefined;
      if (uuid) return `mac-${uuid.toLowerCase()}`;
      // A volume with no UUID (a disk image, a legacy filesystem): the best
      // stable name there is, and never shared with another disk.
      return `dev-${shortHash(`${mount.source}\u0000${mount.fsType}`)}`;
    }
    const uuid = uuids?.get(mount.source);
    if (uuid) return `lin-${uuid.toLowerCase()}`;
    return `dev-${shortHash(`${mount.source}\u0000${mount.fsType}`)}`;
  }
}

function labelFor(mountPoint: string): string {
  if (mountPoint === '/') return 'Macintosh HD';
  return mountPoint.slice(mountPoint.lastIndexOf('/') + 1) || mountPoint;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** `//user@server/share` and `server:/export` are the same share however they were typed. */
function normalizeNetworkSource(source: string): string {
  return source.trim().toLowerCase().replace(/^\/\/[^@/]*@/, '//').replace(/\/+$/, '');
}

function defaultReadMounts(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return execFileSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5_000 });
  return readFileSync('/proc/self/mountinfo', 'utf8');
}

function defaultDiskutilPlist(mountPoint: string): string | undefined {
  try {
    return execFileSync('/usr/sbin/diskutil', ['info', '-plist', mountPoint], {
      encoding: 'utf8',
      timeout: 8_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function defaultUuidsByDevice(): Map<string, string> {
  const result = new Map<string, string>();
  const dir = '/dev/disk/by-uuid';
  try {
    if (!existsSync(dir)) return result;
    for (const name of readdirSync(dir)) {
      try { result.set(realpathSync(`${dir}/${name}`), name); } catch { /* a dangling link */ }
    }
  } catch { /* unreadable */ }
  return result;
}

/** `/dev/disk3s1 on /Volumes/Backup (apfs, local, journaled)`; also `//u@srv/share on /Volumes/x (smbfs, ...)`. */
export function parseDarwinMounts(text: string): RawMount[] {
  const mounts: RawMount[] = [];
  for (const line of text.split('\n')) {
    const match = /^(.+?) on (\/.*?) \(([^,)]+)/.exec(line);
    if (!match) continue;
    mounts.push({ source: match[1]!, mountPoint: match[2]!, fsType: match[3]!.trim() });
  }
  return mounts;
}

/** Fields: id parent major:minor root mountpoint options [optional...] - fstype source superopts. */
export function parseLinuxMountinfo(text: string): RawMount[] {
  const mounts: RawMount[] = [];
  for (const line of text.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) return mounts.length ? mounts : [];
    const head = line.slice(0, separator).split(' ');
    const tail = line.slice(separator + 3).split(' ');
    if (head.length < 6 || tail.length < 2) continue;
    mounts.push({
      mountPoint: unescapeMountinfo(head[4]!),
      fsType: tail[0]!,
      source: unescapeMountinfo(tail[1]!),
    });
  }
  return mounts;
}

function unescapeMountinfo(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function plistString(plist: string, key: string): string | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist);
  return match?.[1]?.trim();
}
