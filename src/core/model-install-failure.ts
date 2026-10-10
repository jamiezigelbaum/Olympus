/**
 * The fixed failure codes a dashboard may show for a built-in model install
 * (chatgpt/dashboard-contract.ts ModelInstallFailedReason). Never the
 * installer's own message, which can carry paths.
 */
export type ModelInstallFailedReason = 'disk_full' | 'network' | 'checksum' | 'unknown';

export function modelInstallFailedReason(failure: { reason?: string; message?: string } | undefined): ModelInstallFailedReason {
  if (!failure) return 'unknown';
  if (failure.reason === 'download_failed') return 'network';
  if (failure.reason === 'checksum_mismatch') return 'checksum';
  if (failure.reason === 'insufficient_space') return 'disk_full';
  if (failure.reason === 'disk_write_failed' && /ENOSPC|no space left/i.test(failure.message ?? '')) return 'disk_full';
  return 'unknown';
}

/**
 * Bytes the owner has to free before a disk-full install can go on: the
 * installer's own shortfall (what it needs less what the disk has) when it
 * recorded one, else what is left to download. Undefined when neither is known.
 */
export function modelInstallSpaceToFree(status: {
  bytesDone?: number;
  bytesTotal?: number;
  failure?: { bytesNeeded?: number; bytesFree?: number };
}): number | undefined {
  const needed = status.failure?.bytesNeeded;
  const free = status.failure?.bytesFree;
  if (typeof needed === 'number' && typeof free === 'number' && Number.isFinite(needed) && Number.isFinite(free) && needed > free) {
    return Math.ceil(needed - free);
  }
  const total = status.bytesTotal;
  const done = status.bytesDone ?? 0;
  if (typeof total === 'number' && Number.isFinite(total) && total > done) return Math.ceil(total - done);
  return undefined;
}

/** "3 GB", "400 MB": rounded up, so freeing exactly this much is enough. */
export function formatSpaceToFree(bytes: number): string {
  if (bytes >= 1e9) return `${Math.ceil(bytes / 1e9)} GB`;
  return `${Math.max(100, Math.ceil(bytes / 1e8) * 100)} MB`;
}
