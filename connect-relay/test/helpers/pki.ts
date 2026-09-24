/** Throwaway test PKI built with the `openssl` CLI (present on macOS and the Ubuntu CI runners). */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestCa {
  readonly dir: string;
  readonly cert: string;
  issue(hostname: string): { key: string; cert: string };
  signCsr(der: Buffer): string;
  cleanup(): void;
}

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

const serial = () => `0x${randomBytes(8).toString('hex')}`;

export function createTestCa(): TestCa {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-pki-'));
  openssl(
    [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=Olympus Relay Test CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ],
    dir,
  );
  let counter = 0;
  const signPem = (csrFile: string): string => {
    const out = `leaf-${++counter}.crt`;
    openssl(
      ['x509', '-req', '-in', csrFile, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', serial(), '-days', '90', '-copy_extensions', 'copy', '-out', out],
      dir,
    );
    return readFileSync(join(dir, out), 'utf8');
  };
  return {
    dir,
    cert: readFileSync(join(dir, 'ca.crt'), 'utf8'),
    issue(hostname) {
      const base = `issued-${++counter}`;
      openssl(
        [
          'req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${base}.key`,
          '-out', `${base}.csr`, '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname}`,
        ],
        dir,
      );
      return { key: readFileSync(join(dir, `${base}.key`), 'utf8'), cert: signPem(`${base}.csr`) };
    },
    signCsr(der) {
      const base = `acme-${++counter}`;
      writeFileSync(join(dir, `${base}.der`), der);
      // Converting also verifies the CSR's self-signature.
      openssl(['req', '-inform', 'DER', '-in', `${base}.der`, '-verify', '-out', `${base}.csr`], dir);
      return signPem(`${base}.csr`);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
