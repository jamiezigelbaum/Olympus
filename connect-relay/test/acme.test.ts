import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AcmeError, obtainCertificate, type AcmeDnsPublisher } from '../client/acme.ts';
import { ariCertId, fetchRenewalInfo, selectRenewalTime } from '../client/ari.ts';
import { certificateIsFresh } from '../client/connect.ts';
import { createCsr } from '../client/csr.ts';
import { MemoryDnsProvider } from '../server/dns.ts';
import { startMockAcme, type MockAcme } from './helpers/mock-acme.ts';
import { createTestCa, type TestCa } from './helpers/pki.ts';

const HOST = 'abcdefghijklmnopqrstuvwxyz234567.connect.olympus.test';
let ca: TestCa;
let acme: MockAcme;
const dns = new MemoryDnsProvider();

/** What the relay does for an install: publish under `_acme-challenge.<host>` only. */
function relayPublisher(hostname: string, tamper?: (value: string) => string): AcmeDnsPublisher & { cleared: string[] } {
  const cleared: string[] = [];
  return {
    cleared,
    publish: (value) => dns.setTxt(`_acme-challenge.${hostname}`, tamper ? tamper(value) : value),
    clear: async (value) => {
      cleared.push(value);
      await dns.clearTxt(`_acme-challenge.${hostname}`, tamper ? tamper(value) : value);
    },
  };
}

const p256 = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;

beforeAll(async () => {
  ca = createTestCa();
  acme = await startMockAcme({ lookupTxt: (name) => dns.lookupTxt(name), signCsr: (der) => ca.signCsr(der) });
});

afterAll(async () => {
  await acme.close();
  ca.cleanup();
});

describe('CSR', () => {
  test('is a valid self-signed PKCS#10 request naming exactly the install host', () => {
    const der = createCsr(HOST, p256());
    const path = join(ca.dir, 'unit.der');
    writeFileSync(path, der);
    const text = execFileSync('openssl', ['req', '-inform', 'DER', '-in', path, '-noout', '-verify', '-text'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // OpenSSL 3.0 prints `CN = host`; 3.2+ prints `CN=host`.
    expect(text).toMatch(new RegExp(`CN ?= ?${HOST.replaceAll('.', '\\.')}`));
    expect(text).toContain(`DNS:${HOST}`);
    expect(text).toContain('ecdsa-with-SHA256');
  });

  test('refuses non-hostnames and non-EC keys', () => {
    expect(() => createCsr('Evil Host', p256())).toThrow();
    expect(() => createCsr(HOST, generateKeyPairSync('ed25519').privateKey)).toThrow();
  });
});

describe('ACME DNS-01 client', () => {
  test('obtains a certificate for the local key via a relay-published TXT value', async () => {
    const certificateKey = p256();
    const publisher = relayPublisher(HOST);
    const pem = await obtainCertificate({
      directoryUrl: acme.directoryUrl,
      accountKey: p256(),
      certificateKey,
      hostname: HOST,
      dns: publisher,
      termsOfServiceAgreed: true,
      pollIntervalMs: 10,
    });
    const certificate = new X509Certificate(pem);
    expect(certificate.checkHost(HOST)).toBe(HOST);
    expect(certificate.checkPrivateKey(certificateKey)).toBe(true);
    expect(certificateIsFresh(pem, HOST)).toBe(true);
    expect(certificateIsFresh(pem, `other.${HOST}`)).toBe(false);
    expect(publisher.cleared).toHaveLength(1);
    expect(dns.lookupTxt(`_acme-challenge.${HOST}`)).toEqual([]);
  });

  test('fails, and still withdraws the TXT value, when the published value is wrong', async () => {
    const publisher = relayPublisher(HOST, (value) => `${value.slice(0, 42)}x`);
    await expect(
      obtainCertificate({
        directoryUrl: acme.directoryUrl,
        accountKey: p256(),
        certificateKey: p256(),
        hostname: HOST,
        dns: publisher,
        termsOfServiceAgreed: true,
        pollIntervalMs: 10,
      }),
    ).rejects.toBeInstanceOf(AcmeError);
    expect(publisher.cleared).toHaveLength(1);
    expect(dns.lookupTxt(`_acme-challenge.${HOST}`)).toEqual([]);
  });

  test('will not create a CA account until the subscriber agreement is accepted', async () => {
    const before = acme.accounts;
    await expect(
      obtainCertificate({
        directoryUrl: acme.directoryUrl,
        accountKey: p256(),
        certificateKey: p256(),
        hostname: HOST,
        dns: relayPublisher(HOST),
        termsOfServiceAgreed: false,
      }),
    ).rejects.toThrow('subscriber agreement');
    expect(acme.accounts).toBe(before);
  });
});

describe('ACME Renewal Information (RFC 9773)', () => {
  const issue = (accountKey = p256(), replaces?: string) =>
    obtainCertificate({
      directoryUrl: acme.directoryUrl,
      accountKey,
      certificateKey: p256(),
      hostname: HOST,
      dns: relayPublisher(HOST),
      termsOfServiceAgreed: true,
      pollIntervalMs: 10,
      ...(replaces ? { replaces } : {}),
    });

  test('the certificate identifier is base64url(AKI keyIdentifier).base64url(serial), leading zero kept', () => {
    // Serials with the top bit set carry a 0x00 content octet (RFC 9773 section 4.1).
    for (let i = 0; i < 6; i += 1) {
      const { cert } = ca.issue(HOST);
      const path = join(ca.dir, `ari-${i}.pem`);
      writeFileSync(path, cert);
      const text = execFileSync('openssl', ['x509', '-in', path, '-noout', '-serial', '-ext', 'authorityKeyIdentifier'], { encoding: 'utf8' });
      const serialHex = /serial=([0-9A-F]+)/.exec(text)![1]!;
      const akiHex = /Authority Key Identifier:\s*\n\s*(?:keyid:)?([0-9A-F:]+)/.exec(text)![1]!.replaceAll(':', '');
      const serial = Buffer.from(serialHex.length % 2 ? `0${serialHex}` : serialHex, 'hex');
      const content = serial[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), serial]) : serial;
      expect(ariCertId(cert)).toBe(`${Buffer.from(akiHex, 'hex').toString('base64url')}.${content.toString('base64url')}`);
    }
    expect(ariCertId('not a certificate')).toBeUndefined();
  });

  test('the window is read from the CA, and a moment is picked inside it', async () => {
    const pem = await issue();
    acme.setRenewalWindow(undefined);
    expect(await fetchRenewalInfo(acme.directoryUrl, pem)).toBeUndefined();
    const window = { start: Date.parse('2026-10-01T00:00:00Z'), end: Date.parse('2026-10-03T00:00:00Z') };
    acme.setRenewalWindow(window);
    try {
      const info = await fetchRenewalInfo(acme.directoryUrl, pem);
      expect(info).toMatchObject({ certId: ariCertId(pem), window, retryAfterMs: 6 * 60 * 60 * 1000 });
      expect(selectRenewalTime(window, () => 0)).toBe(window.start);
      expect(selectRenewalTime(window, () => 0.5)).toBe(window.start + 24 * 60 * 60 * 1000);
      expect(selectRenewalTime(window, () => 0.999999)).toBeLessThan(window.end);
    } finally {
      acme.setRenewalWindow(undefined);
    }
  });

  test('a renewal order names the certificate it replaces; a refused replaces falls back to a plain order', async () => {
    const accountKey = p256();
    const first = await issue(accountKey);
    const id = ariCertId(first)!;
    const before = acme.replacements.length;
    await issue(accountKey, id);
    expect(acme.replacements.slice(before)).toEqual([id]);
    // Replacing it again is refused (alreadyReplaced); the order still goes through, plainly.
    const again = await issue(accountKey, id);
    expect(new X509Certificate(again).checkHost(HOST)).toBe(HOST);
    expect(acme.replacements.slice(before)).toEqual([id, id, undefined]);
  });
});
