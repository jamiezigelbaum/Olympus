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
  if (failure.reason === 'disk_write_failed' && /ENOSPC|no space left/i.test(failure.message ?? '')) return 'disk_full';
  return 'unknown';
}
