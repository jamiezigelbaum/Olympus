/** Content-free size policy; stores and requeueing stay in the worker. */
import { createHash } from 'node:crypto';
import { registerLimit } from './limit-stops.ts';
import { readOwnerLimitOverride, type OwnerLimitKey } from './owner-limit-settings.ts';

export interface SourceSizeLimit {
  id: OwnerLimitKey;
  subject: string;
  providers: readonly string[];
  defaultBytes: number;
  ceilingBytes: number;
  /** A streaming file reader uses no whole-file memory budget. */
  bytesOnly?: true;
}

// Hard memory ceiling: bytes readers hold a whole file, and the document extraction
// child accepts at most 256 MiB (DOCUMENT_READER_MAX_INPUT_BYTES). Owner raises
// cannot exceed this. Image readers retain their smaller, independent 64 MiB bound.
export const SOURCE_FILE_SIZE_CEILING = 256 * 1024 * 1024;
export const SOURCE_SIZE_LIMITS: readonly SourceSizeLimit[] = [
  { id: 'dropbox.max_file_bytes', subject: 'dropbox.files', providers: ['dropbox'], defaultBytes: 8_000_000, ceilingBytes: SOURCE_FILE_SIZE_CEILING },
  { id: 'local_files.max_file_bytes', subject: 'local.files', providers: ['local_files'], defaultBytes: 64_000_000, ceilingBytes: SOURCE_FILE_SIZE_CEILING },
  // Capture has no storage quota (owner, 26 Oct). This limit covers in-memory
  // reads of kept media only; the disk-space safety floor is independent.
  { id: 'telegram.media_quota', subject: 'telegram.messages', providers: ['telegram', 'telegram.media'], bytesOnly: true, defaultBytes: 64 * 1024 * 1024, ceilingBytes: SOURCE_FILE_SIZE_CEILING },
];
registerLimit({ id: 'dropbox.max_file_bytes', kind: 'size', scope: 'extraction', label: 'Dropbox file size', unit: 'bytes', continue: 'raise' });
registerLimit({ id: 'local_files.max_file_bytes', kind: 'size', scope: 'extraction', label: 'Local file size', unit: 'bytes', continue: 'raise' });
registerLimit({ id: 'telegram.media_quota', kind: 'size', scope: 'extraction', label: 'Telegram media read size', unit: 'bytes', continue: 'raise' });

export function sourceSizeLimitForProvider(provider: string): SourceSizeLimit | undefined {
  return SOURCE_SIZE_LIMITS.find(limit => limit.providers.includes(provider));
}

/** One grant per item VERSION, shared by tier copies. Never persist a file name or path. */
export function sizeHeldItemKey(ref: { provider: string; accountScope: string; providerItemId: string; localItemId?: string; sourceVersion?: string; contentHash?: string }): string {
  return createHash('sha256').update(JSON.stringify([ref.provider, ref.accountScope, ref.providerItemId, ref.localItemId ?? '', ref.sourceVersion ?? '', ref.contentHash ?? ''])).digest('hex');
}
export function sourceSizeBytes(policy: SourceSizeLimit, ref?: Parameters<typeof sizeHeldItemKey>[0] & { mimeType?: string }, now = new Date(), fallback = policy.defaultBytes): number {
  return Math.min(sourceSizeCeiling(policy, ref?.mimeType), readOwnerLimitOverride(policy.id, now, undefined, ref ? sizeHeldItemKey(ref) : undefined) ?? fallback);
}

/** The image decoder's independent hard ceiling; documents keep the 256 MiB ceiling. */
export function sourceSizeCeiling(policy: SourceSizeLimit, mimeType?: string): number {
  return mimeType?.startsWith('image/') ? Math.min(policy.ceilingBytes, 64 * 1024 * 1024) : policy.ceilingBytes;
}
