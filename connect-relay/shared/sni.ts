/**
 * Reads the server name from a TLS ClientHello without terminating TLS.
 *
 * The ClientHello is the only part of an install's connection the relay
 * parses, and it is sent in the clear by design (RFC 8446 section 4.1.2). The
 * handshake message may span several TLS records (large post-quantum key
 * shares), so fragments are reassembled up to `maxBytes`.
 */

export type ClientHelloResult =
  | { status: 'incomplete' }
  | { status: 'invalid'; reason: string }
  | { status: 'ok'; serverName: string | undefined };

const RECORD_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXTENSION_SERVER_NAME = 0x0000;
const NAME_TYPE_HOST = 0x00;

export function parseClientHello(buffer: Buffer): ClientHelloResult {
  const handshake: Buffer[] = [];
  let handshakeBytes = 0;
  let needed: number | undefined;
  let offset = 0;
  while (needed === undefined || handshakeBytes < needed) {
    if (buffer.length < offset + 5) return { status: 'incomplete' };
    if (buffer[offset] !== RECORD_HANDSHAKE) return { status: 'invalid', reason: 'not a TLS handshake record' };
    if (buffer[offset + 1] !== 0x03) return { status: 'invalid', reason: 'unsupported record version' };
    const recordLength = buffer.readUInt16BE(offset + 3);
    if (recordLength === 0 || recordLength > 16384) return { status: 'invalid', reason: 'bad record length' };
    if (buffer.length < offset + 5 + recordLength) return { status: 'incomplete' };
    const fragment = buffer.subarray(offset + 5, offset + 5 + recordLength);
    handshake.push(fragment);
    handshakeBytes += fragment.length;
    offset += 5 + recordLength;
    if (needed === undefined) {
      const head = Buffer.concat(handshake);
      if (head.length < 4) continue;
      if (head[0] !== HANDSHAKE_CLIENT_HELLO) return { status: 'invalid', reason: 'first handshake message is not ClientHello' };
      needed = 4 + head.readUIntBE(1, 3);
    }
  }
  return parseHelloBody(Buffer.concat(handshake).subarray(4, needed));
}

function parseHelloBody(body: Buffer): ClientHelloResult {
  const invalid = (reason: string): ClientHelloResult => ({ status: 'invalid', reason });
  let at = 2 + 32; // legacy_version + random
  if (body.length < at + 1) return invalid('truncated ClientHello');
  at += 1 + body[at]!; // session id
  if (body.length < at + 2) return invalid('truncated cipher suites');
  at += 2 + body.readUInt16BE(at);
  if (body.length < at + 1) return invalid('truncated compression methods');
  at += 1 + body[at]!;
  if (at === body.length) return { status: 'ok', serverName: undefined };
  if (body.length < at + 2) return invalid('truncated extensions');
  const extensionsEnd = at + 2 + body.readUInt16BE(at);
  if (extensionsEnd > body.length) return invalid('truncated extensions');
  at += 2;
  while (at + 4 <= extensionsEnd) {
    const type = body.readUInt16BE(at);
    const length = body.readUInt16BE(at + 2);
    const start = at + 4;
    const end = start + length;
    if (end > extensionsEnd) return invalid('truncated extension');
    if (type === EXTENSION_SERVER_NAME) {
      if (length < 2) return invalid('bad server_name extension');
      const listEnd = start + 2 + body.readUInt16BE(start);
      if (listEnd > end) return invalid('bad server_name list');
      let entry = start + 2;
      while (entry + 3 <= listEnd) {
        const nameType = body[entry]!;
        const nameLength = body.readUInt16BE(entry + 1);
        const nameEnd = entry + 3 + nameLength;
        if (nameEnd > listEnd) return invalid('bad server_name entry');
        if (nameType === NAME_TYPE_HOST) {
          const name = body.subarray(entry + 3, nameEnd).toString('latin1');
          if (!/^[A-Za-z0-9.-]{1,253}$/.test(name)) return invalid('server name is not a hostname');
          return { status: 'ok', serverName: name.toLowerCase() };
        }
        entry = nameEnd;
      }
      return { status: 'ok', serverName: undefined };
    }
    at = end;
  }
  return { status: 'ok', serverName: undefined };
}

/** TLS alert descriptions the relay may send before any handshake, in the clear (RFC 8446 section 6). */
export const TLS_ALERT = {
  /** No such install: RFC 6066 section 3 allows a fatal unrecognized_name for an unknown SNI. */
  unrecognizedName: 112,
  /** The install exists but is offline, over its limits, or did not attach in time. */
  internalError: 80,
} as const;

/** A single fatal alert record. Clients report it as e.g. "tlsv1 alert internal error". */
export function tlsAlertRecord(description: number): Buffer {
  return Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, description]);
}
