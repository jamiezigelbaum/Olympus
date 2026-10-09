/**
 * Olympus connect-relay wire protocol, version 2.
 *
 * Each install keeps one WebSocket session to the relay (`wss://<relay>/v2/connect`).
 * The relay opens with a `challenge`; the install answers `hello` (or
 * `register` the first time), signed with its Ed25519 install key over the
 * relay's fresh nonce and the relay host the install meant to reach, so a
 * captured signature cannot be replayed on another session or relayed to
 * another relay. A `register` also carries a small proof of work over the
 * same nonce (the challenge's `pow` bits), so registrations cost the caller
 * real time. The relay answers `ready`, or `error` and closes.
 *
 * Signature schemes (`auth`), negotiated without changing `v`, so an install
 * and a relay of different releases always connect, whichever deploys first:
 *
 *   3 (AUTH_BOUND)   the signature covers the relay host; the challenge
 *                    advertises `auth: 3` and the answer carries `auth: 3`.
 *   2 (AUTH_LEGACY)  the signature before host binding (no `auth` field).
 *                    A relay that advertises nothing speaks only this.
 *
 * A current install answers every challenge with scheme 3. If a relay that
 * advertised no scheme rejects that signature, the install retries at once
 * with scheme 2 (a relay from before the binding). A current relay accepts
 * scheme 3 always, and scheme 2 from installs it already knows only while
 * its legacy window is open (`acceptLegacyAuth`; docs/design/chatgpt-plugin.md,
 * "Relay protocol compatibility"). A registration proof of work is required
 * only for an install id the relay has never registered.
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
/** The signature before host binding: what relays and installs from before 2026-10-02 speak. */
export const AUTH_LEGACY = 2;
/** The signature bound to the relay host. */
export const AUTH_BOUND = 3;
export type AuthScheme = typeof AUTH_LEGACY | typeof AUTH_BOUND;
const POW_DOMAIN = 'olympus-connect-relay/v2/register-pow';
/**
 * Most proof-of-work bits an install will spend on one registration. A relay
 * asking for more is refused, so a hostile relay cannot make an install spin.
 */
export const MAX_REGISTRATION_POW_BITS = 22;

/** Install ids are 32 lowercase base32 characters: the first 160 bits of SHA-256 over the install's SPKI. */
export const INSTALL_ID_PATTERN = /^[a-z2-7]{32}$/;

/**
 * `pow`: leading zero bits a `register` of a new install id must show
 * (registration proof of work, below). `auth`: the highest signature scheme
 * the relay accepts; absent from relays that predate negotiation.
 */
export type ChallengeMessage = { type: 'challenge'; v: number; nonce: string; pow: number; auth?: number };
/** `auth` is present for scheme 3 and absent for scheme 2 (the legacy wire form, byte for byte). */
export type HelloMessage = { type: 'hello'; v: number; installId: string; sig: string; auth?: number };
export type RegisterMessage = { type: 'register'; v: number; installId: string; publicKey: string; sig: string; pow?: string; auth?: number };
/**
 * `capabilities`: what this relay offers beyond the base protocol (for
 * example CONNECT_PAGE_CAPABILITY, shared/connect-page.ts); absent from
 * relays that predate it. Advisory: an install uses it only to decide what to
 * offer, never as authorization.
 */
export type ReadyMessage = { type: 'ready'; installId: string; capabilities?: string[] };
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

/**
 * What an install signs: the domain, the message kind, the relay's nonce, the
 * install id, and (scheme 3) the relay host the install dialed (its
 * configured `relayHost`, lowercased), so a relay cannot pass a challenge from
 * another relay through and use the answer there. Scheme 2 is the same
 * payload without the host, exactly as installs and relays from before the
 * binding produce it.
 */
function signedPayload(kind: 'hello' | 'register', nonce: string, installId: string, relayHost: string, scheme: AuthScheme): Buffer {
  const fields = scheme === AUTH_LEGACY
    ? [SIGNATURE_DOMAIN, kind, nonce, installId]
    : [SIGNATURE_DOMAIN, kind, nonce, installId, relayHost.toLowerCase()];
  return Buffer.from(fields.join('\n'), 'utf8');
}

export function signInstallMessage(
  privateKey: KeyObject,
  kind: 'hello' | 'register',
  nonce: string,
  installId: string,
  relayHost: string,
  scheme: AuthScheme = AUTH_BOUND,
): string {
  return base64url(sign(null, signedPayload(kind, nonce, installId, relayHost, scheme), privateKey));
}

export function verifyInstallMessage(
  publicKey: KeyObject,
  kind: 'hello' | 'register',
  nonce: string,
  installId: string,
  relayHost: string,
  sig: string,
  scheme: AuthScheme = AUTH_BOUND,
): boolean {
  if (typeof sig !== 'string' || sig.length > 128) return false;
  try {
    return verify(null, signedPayload(kind, nonce, installId, relayHost, scheme), publicKey, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * Registration proof of work: a decimal counter whose SHA-256, over the
 * domain, nonce, install id, relay host and the counter, starts with `bits`
 * zero bits. The relay checks it with one hash; the install spends about
 * 2^bits hashes (16 bits: roughly 0.1-0.3 s on a Mac). It is bound to the
 * session's nonce, so it cannot be computed ahead or reused.
 */
function powDigest(nonce: string, installId: string, relayHost: string, counter: string): Buffer {
  return createHash('sha256').update(`${POW_DOMAIN}\n${nonce}\n${installId}\n${relayHost.toLowerCase()}\n${counter}`).digest();
}

function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export function verifyRegistrationPow(bits: number, nonce: string, installId: string, relayHost: string, pow: unknown): boolean {
  if (bits <= 0) return true;
  if (typeof pow !== 'string' || !/^[0-9]{1,16}$/.test(pow)) return false;
  return leadingZeroBits(powDigest(nonce, installId, relayHost, pow)) >= bits;
}

/**
 * Finds a registration proof of work, yielding to the event loop between
 * batches. `signal` stops it (the handshake timed out, the socket closed, or
 * the client stopped): the promise then rejects and no more hashing is done.
 */
export async function solveRegistrationPow(
  bits: number,
  nonce: string,
  installId: string,
  relayHost: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!Number.isInteger(bits) || bits < 0 || bits > MAX_REGISTRATION_POW_BITS) throw new Error('the relay asked for an unreasonable registration proof of work');
  for (let counter = 0; ; counter += 1) {
    if (counter % 4096 === 0) {
      if (counter > 0) await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) throw new PowCancelledError();
    }
    const candidate = String(counter);
    if (bits === 0 || leadingZeroBits(powDigest(nonce, installId, relayHost, candidate)) >= bits) return candidate;
  }
}

export class PowCancelledError extends Error {
  constructor() {
    super('registration proof of work cancelled');
    this.name = 'PowCancelledError';
  }
}

/**
 * The install's answer to a challenge: `hello`, or `register` with its key
 * and proof of work, signed with `scheme` (default 3, bound to the relay
 * host). Scheme 2 produces the legacy wire form, for a relay that rejected 3.
 */
export async function installAuthMessage(input: {
  kind: 'hello' | 'register';
  identity: { readonly installId: string; readonly publicKeySpki: string; readonly privateKey: KeyObject };
  nonce: string;
  powBits: number;
  relayHost: string;
  scheme?: AuthScheme;
  signal?: AbortSignal;
}): Promise<ClientAuthMessage> {
  const { kind, identity, nonce, relayHost } = input;
  const scheme = input.scheme ?? AUTH_BOUND;
  const sig = signInstallMessage(identity.privateKey, kind, nonce, identity.installId, relayHost, scheme);
  const auth = scheme === AUTH_BOUND ? { auth: AUTH_BOUND } : {};
  if (kind === 'hello') return { type: 'hello', v: PROTOCOL_VERSION, installId: identity.installId, sig, ...auth };
  // A relay that speaks only scheme 2 predates the proof of work.
  if (scheme === AUTH_LEGACY) return { type: 'register', v: PROTOCOL_VERSION, installId: identity.installId, publicKey: identity.publicKeySpki, sig };
  const pow = await solveRegistrationPow(input.powBits, nonce, identity.installId, relayHost, input.signal);
  return { type: 'register', v: PROTOCOL_VERSION, installId: identity.installId, publicKey: identity.publicKeySpki, sig, pow, ...auth };
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
