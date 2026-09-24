/**
 * PKCS#10 certificate signing request for one DNS name, signed with a local
 * P-256 key (RFC 2986, RFC 5280 subjectAltName). Node has no CSR API, and a
 * dependency for ~60 lines of DER would be a larger surface than the code.
 */
import { createPublicKey, sign, type KeyObject } from 'node:crypto';

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...content: Buffer[]) => tlv(0x30, ...content);
const set = (...content: Buffer[]) => tlv(0x31, ...content);

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let v = part >>> 7; v > 0; v >>>= 7) chunk.unshift(0x80 | (v & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const OID_COMMON_NAME = '2.5.4.3';
const OID_EXTENSION_REQUEST = '1.2.840.113549.1.9.14';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';

export function createCsr(hostname: string, privateKey: KeyObject): Buffer {
  if (!/^[a-z0-9.-]{1,253}$/.test(hostname)) throw new Error('CSR hostname must be a lowercase DNS name');
  if (privateKey.asymmetricKeyType !== 'ec') throw new Error('CSR key must be an EC P-256 key');
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  const subject = sequence(set(sequence(oid(OID_COMMON_NAME), tlv(0x0c, Buffer.from(hostname, 'utf8')))));
  const subjectAltName = sequence(tlv(0x82, Buffer.from(hostname, 'ascii')));
  const extensions = sequence(sequence(oid(OID_SUBJECT_ALT_NAME), tlv(0x04, subjectAltName)));
  const attributes = tlv(0xa0, sequence(oid(OID_EXTENSION_REQUEST), set(extensions)));
  const info = sequence(tlv(0x02, Buffer.from([0])), subject, spki, attributes);
  const signature = sign('sha256', info, privateKey);
  return sequence(info, sequence(oid(OID_ECDSA_WITH_SHA256)), tlv(0x03, Buffer.from([0]), signature));
}
