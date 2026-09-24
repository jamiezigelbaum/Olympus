/**
 * Olympus connect-relay wire protocol, version 1.
 *
 * Two kinds of connection reach the relay's control host (TLS terminated by the
 * relay with its own certificate):
 *
 * - a **session**: the install's long-lived outbound link. The relay sends a
 *   `challenge`; the install answers `hello` (or `register` the first time),
 *   signed with its install key. Afterwards the relay sends `open` for each
 *   public connection and answers `ping` and ACME DNS-01 publish requests.
 * - a **data connection**: opened by the install in answer to `open`. After the
 *   `challenge` the install sends one `attach` line; from then on the stream is
 *   raw bytes of the hosted agent's end-to-end TLS session, which the relay
 *   splices without reading.
 *
 * Messages are single-line JSON. Every signed message covers the relay's fresh
 * nonce, so a captured signature cannot be replayed on another connection.
 */
import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import type { Readable } from 'node:stream';

export const PROTOCOL_VERSION = 1;
export const MAX_CONTROL_LINE_BYTES = 4096;
const SIGNATURE_DOMAIN = 'olympus-connect-relay/v1';

/** Install ids are 32 lowercase base32 characters: the first 160 bits of SHA-256 over the install's SPKI. */
export const INSTALL_ID_PATTERN = /^[a-z2-7]{32}$/;
/** An ACME DNS-01 TXT value is base64url(SHA-256(key authorization)): exactly 43 characters. */
export const ACME_TXT_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const CONN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export type ChallengeMessage = { type: 'challenge'; v: number; nonce: string };
export type HelloMessage = { type: 'hello'; v: number; installId: string; sig: string };
export type RegisterMessage = { type: 'register'; v: number; installId: string; publicKey: string; sig: string };
export type AttachMessage = { type: 'attach'; v: number; installId: string; connId: string; sig: string };
export type ReadyMessage = { type: 'ready'; installId: string; hostname: string };
export type OpenMessage = { type: 'open'; connId: string; remoteAddress?: string };
export type PingMessage = { type: 'ping' };
export type PongMessage = { type: 'pong' };
export type AcmeDnsMessage = { type: 'acme-dns-set' | 'acme-dns-clear'; id: string; value: string };
export type AcmeDnsResultMessage = { type: 'acme-dns-result'; id: string; ok: boolean; error?: string };
export type ErrorMessage = { type: 'error'; code: RelayErrorCode; message: string };

export type RelayErrorCode =
  | 'bad_request'
  | 'unsupported_version'
  | 'bad_signature'
  | 'id_mismatch'
  | 'unregistered'
  | 'rate_limited'
  | 'capacity'
  | 'unknown_connection'
  | 'replaced';

export type ClientFirstMessage = HelloMessage | RegisterMessage | AttachMessage;
export type ClientSessionMessage = PingMessage | AcmeDnsMessage;
export type RelaySessionMessage = ReadyMessage | OpenMessage | PongMessage | AcmeDnsResultMessage | ErrorMessage;

export function base64url(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The install id is derived from the key, so an id can never be claimed with a different key. */
export function installIdForPublicKey(spkiDer: Uint8Array): string {
  return base32(createHash('sha256').update(spkiDer).digest().subarray(0, 20));
}

export function publicKeyFromSpki(spkiBase64url: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(spkiBase64url, 'base64url'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('install keys must be Ed25519');
  return key;
}

export function spkiOf(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }) as Buffer;
}

function signedPayload(kind: 'hello' | 'register' | 'attach', nonce: string, installId: string, extra = ''): Buffer {
  return Buffer.from([SIGNATURE_DOMAIN, kind, nonce, installId, extra].join('\n'), 'utf8');
}

export function signInstallMessage(
  privateKey: KeyObject,
  kind: 'hello' | 'register' | 'attach',
  nonce: string,
  installId: string,
  extra = '',
): string {
  return base64url(sign(null, signedPayload(kind, nonce, installId, extra), privateKey));
}

export function verifyInstallMessage(
  publicKey: KeyObject,
  kind: 'hello' | 'register' | 'attach',
  nonce: string,
  installId: string,
  sig: string,
  extra = '',
): boolean {
  if (typeof sig !== 'string' || sig.length > 128) return false;
  try {
    return verify(null, signedPayload(kind, nonce, installId, extra), publicKey, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

export function newNonce(): string {
  return base64url(randomBytes(24));
}

export function newConnId(): string {
  return base64url(randomBytes(16));
}

export function encodeLine(message: object): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Splits a byte stream into bounded JSON lines. `onLine` returning `'stop'`
 * detaches the reader and hands any bytes after that line to `onRest`, so a
 * data connection can switch from the line protocol to raw bytes.
 */
export function readLines(
  stream: Readable,
  onLine: (message: Record<string, unknown>) => 'continue' | 'stop',
  onError: (reason: string) => void,
  onRest?: (rest: Buffer) => void,
): void {
  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer | string) => {
    buffered = Buffer.concat([buffered, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    for (;;) {
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length > MAX_CONTROL_LINE_BYTES) {
          stream.removeListener('data', onData);
          onError('control line too long');
        }
        return;
      }
      const line = buffered.subarray(0, newline).toString('utf8');
      buffered = buffered.subarray(newline + 1);
      if (newline > MAX_CONTROL_LINE_BYTES) {
        stream.removeListener('data', onData);
        onError('control line too long');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        stream.removeListener('data', onData);
        onError('control line is not JSON');
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        stream.removeListener('data', onData);
        onError('control line is not an object');
        return;
      }
      if (onLine(parsed as Record<string, unknown>) === 'stop') {
        stream.removeListener('data', onData);
        onRest?.(buffered);
        return;
      }
    }
  };
  stream.on('data', onData);
}

export function hostnameFor(installId: string, zone: string): string {
  return `${installId}.${zone}`;
}

export function acmeChallengeName(installId: string, zone: string): string {
  return `_acme-challenge.${installId}.${zone}`;
}
