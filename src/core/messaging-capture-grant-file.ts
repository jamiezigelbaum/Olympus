/**
 * The capture grant file of a messaging source (Telegram, WhatsApp): reading it,
 * and what it says about where the account's session lives.
 *
 * File system only, so the placement decision (core/source-placement.ts), the
 * Delete fence and the capture supervisor can all ask the same question of the
 * same file without importing each other. A grant that names its session path
 * belongs to a `legacy` account: it was paired at that path, which no
 * environment variable can be trusted to still name.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MessagingCaptureGrant } from './messaging-capture.ts';

export type CaptureGrantSource = 'telegram' | 'whatsapp';

export type CaptureGrantFileRead =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; grant: MessagingCaptureGrant };

/** Where a source's grant sits, beside the handle registry it was granted from. */
export function captureGrantPathBeside(source: CaptureGrantSource, handleRegistryPath: string): string {
  return join(dirname(handleRegistryPath), `messaging-capture.${source}.json`);
}

/**
 * The same file as seen from an environment: the handle registry the worker
 * would use (`OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH`, else the one under the home).
 */
export function captureGrantPathFromEnv(
  source: CaptureGrantSource,
  env: Record<string, string | undefined>,
): string {
  const configured = env.OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH?.trim();
  return captureGrantPathBeside(source, configured || join(env.HOME?.trim() || homedir(), '.config', 'olympus', 'handles.json'));
}

/**
 * `missing` only when the file is confirmed not to be there (nothing at the
 * path, or a path through something that is not a folder). Anything that
 * stops us from telling, such as a folder that cannot be searched, is
 * `invalid`, as is a file we may not trust: not ours, not a plain file,
 * writable by others, unparsable or of the wrong shape.
 */
export function readCaptureGrantFile(path: string): CaptureGrantFileRead {
  try {
    lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'invalid' };
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!info.isFile() || (info.mode & 0o022) !== 0 || (currentUid !== undefined && info.uid !== currentUid)) {
      return { kind: 'invalid' };
    }
    const value = JSON.parse(readFileSync(descriptor, 'utf8')) as MessagingCaptureGrant;
    if (value.version !== 1 || !['telegram', 'whatsapp'].includes(value.source) || !value.handle) return { kind: 'invalid' };
    if (value.accountProof !== undefined && typeof value.accountProof !== 'string') return { kind: 'invalid' };
    if (value.pairingPending !== undefined && value.pairingPending !== true) return { kind: 'invalid' };
    if (value.sessionPath !== undefined && (typeof value.sessionPath !== 'string' || value.sessionPath === '')) return { kind: 'invalid' };
    if (!value.producer || value.producer.source !== value.source || !Array.isArray(value.producer.secretEnvironment)) return { kind: 'invalid' };
    return { kind: 'valid', grant: value };
  } catch {
    return { kind: 'invalid' };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * What the grant file says about the session's place:
 * - `none`: no grant (confirmed), or a grant that names no path (a folder account's);
 * - `path`: a grant that names the path its session was paired at;
 * - `unreadable`: a grant, or a place a grant may be, that cannot be read, so
 *   it cannot be shown that the account has no session outside its folder.
 */
export type CaptureGrantSessionEvidence =
  | { kind: 'none' }
  | { kind: 'path'; sessionPath: string }
  | { kind: 'unreadable' };

export function captureGrantSessionEvidence(source: CaptureGrantSource, grantPath: string): CaptureGrantSessionEvidence {
  const read = readCaptureGrantFile(grantPath);
  if (read.kind === 'missing') return { kind: 'none' };
  if (read.kind === 'invalid' || read.grant.source !== source) return { kind: 'unreadable' };
  return read.grant.sessionPath === undefined ? { kind: 'none' } : { kind: 'path', sessionPath: read.grant.sessionPath };
}
