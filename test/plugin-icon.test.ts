import { describe, expect, test } from 'bun:test';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { V0_4_PUBLIC_PACKAGE_FILES } from '../src/core/public-surface.ts';

const ICON_PATH = join(import.meta.dir, '..', 'assets', 'icon.png');

describe('OpenClaw plugin branding', () => {
  test('ships the portable 512px RGBA PNG at the host convention path', () => {
    expect(V0_4_PUBLIC_PACKAGE_FILES).toContain('assets/icon.png');
    expect(lstatSync(ICON_PATH).isFile()).toBe(true);

    const icon = readFileSync(ICON_PATH);
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
    expect(icon.readUInt32BE(16)).toBe(512);
    expect(icon.readUInt32BE(20)).toBe(512);
    expect(icon.readUInt8(24)).toBe(8);
    expect(icon.readUInt8(25)).toBe(6);
  });
});
