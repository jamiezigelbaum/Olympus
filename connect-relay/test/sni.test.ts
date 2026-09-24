import { describe, expect, test } from 'bun:test';
import { parseClientHello, tlsAlertRecord } from '../shared/sni.ts';
import { randomBytes } from 'node:crypto';
import { captureClientHello, syntheticClientHello } from './helpers/net.ts';

/** Re-frames one handshake message across records of at most `size` bytes. */
function refragment(record: Buffer, size: number): Buffer {
  const body = record.subarray(5, 5 + record.readUInt16BE(3));
  const records: Buffer[] = [];
  for (let at = 0; at < body.length; at += size) {
    const fragment = body.subarray(at, at + size);
    const header = Buffer.from([0x16, 0x03, 0x01, 0, 0]);
    header.writeUInt16BE(fragment.length, 3);
    records.push(header, fragment);
  }
  return Buffer.concat(records);
}

describe('ClientHello SNI parser', () => {
  test('reads the server name from a real TLS client hello', async () => {
    const hello = await captureClientHello('abcdefghijklmnopqrstuvwxyz234567.connect.olympus.test');
    expect(parseClientHello(hello)).toEqual({ status: 'ok', serverName: 'abcdefghijklmnopqrstuvwxyz234567.connect.olympus.test' });
  });

  test('reassembles a ClientHello split across records and waits for missing bytes', async () => {
    const hello = await captureClientHello('relay.connect.olympus.test');
    const fragmented = refragment(hello, 100);
    expect(parseClientHello(fragmented)).toEqual({ status: 'ok', serverName: 'relay.connect.olympus.test' });
    for (const cut of [1, 4, 5, 50, 105, fragmented.length - 1]) {
      expect(parseClientHello(fragmented.subarray(0, cut)).status).toBe('incomplete');
    }
  });

  test('rejects non-TLS and malformed input', () => {
    expect(parseClientHello(Buffer.from('GET / HTTP/1.1\r\n\r\n')).status).toBe('invalid');
    expect(parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x02, 0, 0, 0])).status).toBe('invalid');
    const truncatedBody = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x06, 0x01, 0x00, 0x00, 0x02, 0x03, 0x03]);
    expect(parseClientHello(truncatedBody).status).toBe('invalid');
  });

  test('alerts are well-formed fatal TLS alert records', () => {
    expect([...tlsAlertRecord(112)]).toEqual([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 112]);
  });

  test('rejects a server_name list with two host names (RFC 6066 section 3)', () => {
    expect(parseClientHello(syntheticClientHello(['a.example'])).status).toBe('ok');
    expect(parseClientHello(syntheticClientHello(['a.example', 'b.example']))).toMatchObject({ status: 'invalid' });
  });

  test('never throws on mutated or random input', async () => {
    const hello = await captureClientHello('abcdefghijklmnopqrstuvwxyz234567.connect.olympus.test');
    for (let i = 0; i < 5_000; i += 1) {
      const input = i % 3 === 0 ? randomBytes(Math.floor(Math.random() * 400)) : Buffer.from(hello);
      if (i % 3 !== 0) for (let j = 0; j < 1 + (i % 7); j += 1) input[Math.floor(Math.random() * input.length)] = Math.floor(Math.random() * 256);
      const cut = i % 5 === 0 ? input.subarray(0, Math.floor(Math.random() * input.length)) : input;
      expect(['ok', 'invalid', 'incomplete']).toContain(parseClientHello(cut).status);
    }
  });
});
