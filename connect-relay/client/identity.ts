/**
 * Install identity, generated and kept on the user's machine. Nothing here is
 * ever sent to the relay except the Ed25519 public key.
 *
 * Layout under `<stateDir>/connect-relay` (directory 0700, files 0600):
 *   install-key.pem       Ed25519 install key (identity; signs relay messages)
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64url, installIdForPublicKey, spkiOf } from '../shared/protocol.ts';

export interface InstallIdentity {
  readonly installId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** base64url SPKI DER, as sent in `register`. */
  readonly publicKeySpki: string;
}

/**
 * The directory holding install key material: a dedicated `connect-relay`
 * subdirectory of the caller's state directory. Only that subdirectory is
 * created 0700 and tightened; the caller's (possibly shared) directory is
 * never chmod-ed.
 */
export function ensureStateDir(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const dir = join(stateDir, 'connect-relay');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('the connect-relay state directory must be a directory owned by this user');
  }
  chmodSync(dir, 0o700);
  return dir;
}

function writePrivateFile(path: string, contents: string): void {
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function loadOrCreateIdentity(stateDir: string): InstallIdentity {
  const path = join(ensureStateDir(stateDir), 'install-key.pem');
  let privateKey: KeyObject;
  if (existsSync(path)) {
    privateKey = createPrivateKey(readFileSync(path));
  } else {
    privateKey = generateKeyPairSync('ed25519').privateKey;
    writePrivateFile(path, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('install-key.pem is not an Ed25519 key');
  const publicKey = createPublicKey(privateKey);
  const spki = spkiOf(publicKey);
  return { installId: installIdForPublicKey(spki), privateKey, publicKey, publicKeySpki: base64url(spki) };
}
