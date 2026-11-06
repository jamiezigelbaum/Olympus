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

describe('Linux app launcher icon', () => {
  test('ships a 512px RGBA PNG with a transparent corner', () => {
    expect(V0_4_PUBLIC_PACKAGE_FILES).toContain('assets/app-icon.png');
    const icon = readFileSync(join(import.meta.dir, '..', 'assets', 'app-icon.png'));
    expect(icon.readUInt32BE(16)).toBe(512);
    expect(icon.readUInt32BE(20)).toBe(512);
    expect(icon.readUInt8(24)).toBe(8);
    expect(icon.readUInt8(25)).toBe(6);
  });
});

// OpenClaw and ClawHub show assets/icon.png as the plugin's icon and render the
// packaged README.md as its plugin page.
describe('OpenClaw plugin page', () => {
  const root = join(import.meta.dir, '..');

  test('the plugin icon is the crowned app icon, within ClawHub\'s 512 KiB limit', () => {
    const icon = readFileSync(ICON_PATH);
    expect(icon.equals(readFileSync(join(root, 'assets', 'app-icon.png')))).toBe(true);
    expect(icon.length).toBeLessThanOrEqual(512 * 1024);
  });

  test('the README renders without raw HTML, relative images or a stale version badge', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const prose = readme.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    expect(prose).not.toMatch(/<\/?(div|img|p|br|picture|source|a)\b/i);
    for (const [, target] of prose.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      expect(target).toMatch(/^https:\/\//);
    }
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    expect(readme).toContain(`https://img.shields.io/badge/version-${version.replaceAll('-', '--')}-`);
    expect(readme.split('\n').filter((line) => line.includes('img.shields.io/badge/'))).toHaveLength(1);
  });
});
