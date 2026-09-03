import { createHash } from 'node:crypto';

const DROPBOX_CONTENT_HASH_BLOCK_SIZE = 4 * 1024 * 1024;

export function computeDropboxContentHash(bytes: Uint8Array): string {
  const blockDigests: Buffer[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += DROPBOX_CONTENT_HASH_BLOCK_SIZE) {
    const block = bytes.subarray(offset, Math.min(offset + DROPBOX_CONTENT_HASH_BLOCK_SIZE, bytes.byteLength));
    blockDigests.push(createHash('sha256').update(block).digest());
  }
  return createHash('sha256').update(Buffer.concat(blockDigests)).digest('hex');
}
