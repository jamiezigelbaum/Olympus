import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { macosHelperFileName } from '../scripts/macos-helper-name.ts';
import { fileDigest } from '../scripts/publish-release-to-site.ts';

const root = resolve(import.meta.dir, '..');
test('existing helper verification writes a receipt bound to its bytes and verified identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helper-receipt-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const fake = (name: string, body: string) => { const path = join(bin, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
    fake('uname', 'echo Darwin');
    fake('ditto', 'mkdir -p "$4/Olympus Engine.app/Contents"; touch "$4/Olympus Engine.app/Contents/Info.plist"');
    fake('plutil', 'echo ai.olympusplugin.engine-host');
    fake('codesign', 'if [ "$1" = -dvv ]; then printf "Identifier=ai.olympusplugin.engine-host\\nTeamIdentifier=ND2P3ZTQRD\\n"; fi');
    fake('spctl', 'echo source=Notarized Developer ID');
    fake('xcrun', 'exit 0');
    const zip = join(dir, macosHelperFileName(root)); writeFileSync(zip, 'fixture bytes');
    const id = 'e7dcc0a3-a872-4d7f-98ce-9d1785c2ae6a';
    const result = spawnSync('bash', [join(root, 'scripts/release-macos-helper.sh'), '--verify-existing', zip, '--notary-submission', id, dir], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    const receipt = JSON.parse(readFileSync(`${zip}.receipt.json`, 'utf8'));
    expect(receipt).toEqual({ name: macosHelperFileName(root), ...fileDigest(zip), team: 'ND2P3ZTQRD', bundleId: 'ai.olympusplugin.engine-host', notarySubmissionId: id, createdAt: expect.any(String) });
    expect(new Date(receipt.createdAt).toISOString()).toBe(receipt.createdAt);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
