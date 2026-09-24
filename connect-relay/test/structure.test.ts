/**
 * Structural guarantee behind "the relay never sees plaintext": the relay's
 * public path handles raw sockets only, and the relay holds exactly one TLS
 * identity, its own control-plane certificate. Installs' certificate keys have
 * no way in. The runtime half of this proof is the ciphertext tap assertion in
 * relay-e2e.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const imports = (source: string) => [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);

describe('relay plaintext boundary', () => {
  test('the public data path and SNI parser never import TLS or HTTP', () => {
    for (const file of ['server/public-path.ts', 'shared/sni.ts', 'shared/rate-limit.ts', 'shared/bridge.ts']) {
      for (const specifier of imports(read(file))) {
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/^(node:)?(tls|https?|http2)$/);
      }
    }
  });

  test('the relay terminates TLS only for its own control host', () => {
    const serverFiles = readdirSync(join(root, 'server')).filter((name) => name.endsWith('.ts'));
    const sources = serverFiles.map((name) => [name, read(`server/${name}`)] as const);
    const tlsServers = sources.flatMap(([name, source]) => [...source.matchAll(/tls\.createServer\(/g)].map(() => name));
    expect(tlsServers).toEqual(['relay.ts']);
    expect(read('server/relay.ts')).toContain('tls.createServer({ key: config.controlTls.key, cert: config.controlTls.cert');
    for (const [name, source] of sources) {
      expect(source, `${name} must not select certificates per server name`).not.toMatch(/SNICallback|createSecureContext|setSecureContext|addContext/);
      expect(source, `${name} must not parse HTTP`).not.toMatch(/from\s+['"](node:)?https?['"]/);
    }
  });

  test('install private keys never enter the wire protocol', () => {
    const protocol = read('shared/protocol.ts');
    const client = read('client/relay-client.ts');
    const messageTypes = [...protocol.matchAll(/export type \w+Message = \{[^}]*\}/g)].map((match) => match[0]);
    expect(messageTypes.length).toBeGreaterThan(8);
    for (const message of messageTypes) expect(/privateKey|pkcs8|secret|cert/i.test(message), message).toBe(false);
    // The only key material the client sends is the SPKI public key in `register`.
    expect(client).not.toMatch(/export\(\s*\{[^}]*pkcs8/);
    expect(client).toContain('publicKey: identity.publicKeySpki');
  });
});
