/**
 * Install identity and certificate material, generated and kept on the user's
 * machine. Nothing here is ever sent to the relay except the Ed25519 public key.
 *
 * Layout under `stateDir` (directory 0700, files 0600):
 *   install-key.pem       Ed25519 install key (identity; signs relay messages)
 *   acme-account-key.pem  P-256 ACME account key
 *   tls-key.pem           P-256 key for the install's public TLS certificate
 *   tls-cert.pem          certificate chain issued by the ACME CA
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64url, installIdForPublicKey, spkiOf } from '../shared/protocol.ts';

export interface InstallIdentity {
  readonly installId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** base64url SPKI DER, as sent in `register`. */
  readonly publicKeySpki: string;
}

export function ensureStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
}

export function writePrivateFile(path: string, contents: string): void {
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function loadOrCreateKey(path: string, create: () => KeyObject): KeyObject {
  if (existsSync(path)) return createPrivateKey(readFileSync(path));
  const key = create();
  writePrivateFile(path, key.export({ format: 'pem', type: 'pkcs8' }) as string);
  return key;
}

export function loadOrCreateIdentity(stateDir: string): InstallIdentity {
  ensureStateDir(stateDir);
  const privateKey = loadOrCreateKey(join(stateDir, 'install-key.pem'), () => generateKeyPairSync('ed25519').privateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('install-key.pem is not an Ed25519 key');
  const publicKey = createPublicKey(privateKey);
  const spki = spkiOf(publicKey);
  return { installId: installIdForPublicKey(spki), privateKey, publicKey, publicKeySpki: base64url(spki) };
}

const p256 = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;

export function loadOrCreateAcmeAccountKey(stateDir: string): KeyObject {
  ensureStateDir(stateDir);
  return loadOrCreateKey(join(stateDir, 'acme-account-key.pem'), p256);
}

export function loadOrCreateTlsKey(stateDir: string): KeyObject {
  ensureStateDir(stateDir);
  return loadOrCreateKey(join(stateDir, 'tls-key.pem'), p256);
}
