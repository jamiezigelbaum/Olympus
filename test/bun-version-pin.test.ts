import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');
// 1.3.14 corrupts its heap when worker threads open and close SQLite
// connections concurrently (#1523); 1.4.4 passes that repro.
const EXPECTED_BUN_VERSION = '1.4.4';
const read = (...path: string[]): string => readFileSync(join(ROOT, ...path), 'utf8');

describe('Bun version pin', () => {
  test('keeps local development and CI on the dist-producing Bun version', () => {
    expect(read('.bun-version').trim()).toBe(EXPECTED_BUN_VERSION);
    for (const workflow of ['verify.yml', 'whatsapp-bridge-build.yml']) {
      const text = read('.github', 'workflows', workflow);
      const pins = [...text.matchAll(/bun-version: (\S+)/g)].map((match) => match[1]);
      expect(pins.length).toBeGreaterThan(0);
      expect(new Set(pins)).toEqual(new Set([EXPECTED_BUN_VERSION]));
    }
  });

  test('installs the same Bun on Mac and Linux that CI tests', () => {
    expect(/^BUN_VERSION=(\S+)$/m.exec(read('scripts', 'install-macos.sh'))?.[1]).toBe(EXPECTED_BUN_VERSION);
    const linux = JSON.parse(read('config', 'linux-runtime-pins.json')) as { bun: { version: string; url: string } };
    expect(linux.bun.version).toBe(EXPECTED_BUN_VERSION);
    expect(linux.bun.url).toContain(`/bun-v${EXPECTED_BUN_VERSION}/`);
  });
});
