/**
 * Between scope paths (what is selected and stored) and real paths (what the
 * file system has). The only difference is the volume prefix of a disk that is
 * not the computer's own.
 */
import { scopePathFor, splitScopePath } from './paths.ts';
import type { VolumeResolver } from './volume-identity.ts';

/** The real path a scope path names now; undefined when its volume is not mounted. */
export function realPathOfScopePath(volumes: VolumeResolver, scopePath: string): string | undefined {
  const { volumeId, path } = splitScopePath(scopePath);
  if (!volumeId) return path;
  const volume = volumes.mountedVolume(volumeId);
  if (!volume) return undefined;
  return path === '/' ? volume.mountPoint : `${volume.mountPoint === '/' ? '' : volume.mountPoint}${path}`;
}

/** The scope path of a real path: prefixed with its volume's identity unless the volume is primary. */
export function scopePathOfRealPath(volumes: VolumeResolver, realPath: string): string {
  const volume = volumes.volumeOf(realPath);
  if (volume.primary) return scopePathFor(realPath);
  const inside = realPath === volume.mountPoint ? '/' : realPath.slice(volume.mountPoint.length) || '/';
  return scopePathFor(inside, volume.id);
}
