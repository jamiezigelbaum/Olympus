/**
 * Olympus connect-relay wire protocol, version 2.
 *
 * Each install keeps one WebSocket session to the relay (`wss://<relay>/v2/connect`).
 * The relay opens with a `challenge`; the install answers `hello` (or
 * `register` the first time), signed with its Ed25519 install key over the
 * relay's fresh nonce, so a captured signature cannot be replayed on another
 * session. The relay answers `ready`, or `error` and closes.
 *
 * After `ready`, the session multiplexes HTTP requests from the public
 * internet to the install's loopback worker:
 *
 *   relay -> install   request {id, method, path, headers}   (text)
 *                      body chunk for id                     (binary)
 *                      end {id}                              (text)
 *                      cancel {id}                           (text: the caller went away)
 *   install -> relay   response-head {id, status, headers}   (text)
 *                      body chunk for id                     (binary)
 *                      end {id}                              (text)
 *                      abort {id}                            (text: the worker failed mid-response)
 *
 * Binary frames are `[u32 big-endian stream id][payload]`. Streams interleave,
 * so a long Server-Sent Events response never blocks another request.
 * Text frames are single JSON objects. Both sides send `ping`/`pong`.
 */
import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

export const PROTOCOL_VERSION = 2;
export const CONNECT_PATH = '/v2/connect';
/** Text frames are small control messages; anything larger is refused. */
export const MAX_TEXT_FRAME_BYTES = 16 * 1024;
/** Body chunks are at most this large (the sender splits larger ones). */
export const MAX_BODY_CHUNK_BYTES = 64 * 1024;
const SIGNATURE_DOMAIN = 'olympus-connect-relay/v2';

/** Install ids are 32 lowercase base32 characters: the first 160 bits of SHA-256 over the install's SPKI. */
export const INSTALL_ID_PATTERN = /^[a-z2-7]{32}$/;

export type ChallengeMessage = { type: 'challenge'; v: number; nonce: string };
export type HelloMessage = { type: 'hello'; v: number; installId: string; sig: string };
export type RegisterMessage = { type: 'register'; v: number; installId: string; publicKey: string; sig: string };
export type ReadyMessage = { type: 'ready'; installId: string };
export type PingMessage = { type: 'ping' };
export type PongMessage = { type: 'pong' };
export type ErrorMessage = { type: 'error'; code: RelayErrorCode; message: string };
export type RequestMessage = {
  type: 'request';
  id: number;
  method: string;
  /** Path and query, as received by the relay. */
  path: string;
  headers: Array<[string, string]>;
};
export type ResponseHeadMessage = { type: 'response-head'; id: number; status: number; headers: Array<[string, string]> };
export type EndMessage = { type: 'end'; id: number };
export type CancelMessage = { type: 'cancel'; id: number };
export type AbortMessage = { type: 'abort'; id: number };

export type RelayErrorCode =
  | 'bad_request'
  | 'unsupported_version'
  | 'bad_signature'
  | 'id_mismatch'
  | 'unregistered'
  | 'rate_limited'
  | 'capacity'
  | 'replaced'
  | 'revoked';

export type ClientAuthMessage = HelloMessage | RegisterMessage;
export type RelayToClientMessage = ChallengeMessage | ReadyMessage | PongMessage | ErrorMessage | RequestMessage | EndMessage | CancelMessage;
export type ClientToRelayMessage = ClientAuthMessage | PingMessage | ResponseHeadMessage | EndMessage | AbortMessage;

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

function signedPayload(kind: 'hello' | 'register', nonce: string, installId: string): Buffer {
  return Buffer.from([SIGNATURE_DOMAIN, kind, nonce, installId].join('\n'), 'utf8');
}

export function signInstallMessage(privateKey: KeyObject, kind: 'hello' | 'register', nonce: string, installId: string): string {
  return base64url(sign(null, signedPayload(kind, nonce, installId), privateKey));
}

export function verifyInstallMessage(
  publicKey: KeyObject,
  kind: 'hello' | 'register',
  nonce: string,
  installId: string,
  sig: string,
): boolean {
  if (typeof sig !== 'string' || sig.length > 128) return false;
  try {
    return verify(null, signedPayload(kind, nonce, installId), publicKey, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

export function newNonce(): string {
  return base64url(randomBytes(24));
}

/** A text frame, parsed: a JSON object or undefined (oversized, not JSON, not an object). */
export function parseTextFrame(data: string): Record<string, unknown> | undefined {
  if (data.length > MAX_TEXT_FRAME_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function encodeBodyFrame(id: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, id >>> 0, false);
  frame.set(payload, 4);
  return frame;
}

/**
 * A binary frame, decoded, or undefined when it is malformed. A frame with an
 * empty payload is malformed: no sender produces one (`chunks` yields none for
 * an empty body), and accepting them would let a peer make the receiver hold
 * objects that its byte budget never counts.
 */
export function decodeBodyFrame(frame: Uint8Array): { id: number; payload: Uint8Array } | undefined {
  if (frame.byteLength <= 4 || frame.byteLength > 4 + MAX_BODY_CHUNK_BYTES) return undefined;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { id: view.getUint32(0, false), payload: frame.subarray(4) };
}

/** Splits `data` into protocol-sized chunks. */
export function* chunks(data: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < data.byteLength; offset += MAX_BODY_CHUNK_BYTES) {
    yield data.subarray(offset, Math.min(data.byteLength, offset + MAX_BODY_CHUNK_BYTES));
  }
}

/** A header list from the wire: pairs of short strings, bounded, names lowercased. */
export function parseHeaderList(value: unknown, maxEntries = 64): Array<[string, string]> | undefined {
  if (!Array.isArray(value) || value.length > maxEntries) return undefined;
  const out: Array<[string, string]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [name, headerValue] = entry as unknown[];
    if (typeof name !== 'string' || typeof headerValue !== 'string' || name.length > 128 || headerValue.length > 8192) return undefined;
    out.push([name.toLowerCase(), headerValue]);
  }
  return out;
}

/** A stream id from a text frame: a positive 32-bit integer. */
export function streamId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffffffff ? value : undefined;
}
