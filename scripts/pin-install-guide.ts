/**
 * Points the install guides at a published release, with the SHA-256 and byte
 * count taken from that release's own asset, never typed by hand.
 *
 *   bun scripts/pin-install-guide.ts 1.4.1
 *   bun scripts/pin-install-guide.ts 1.4.1 --artifact release-artifacts/olympus-1.4.1.tgz
 *
 * Reads the public GitHub release metadata for v<version> (no authentication),
 * takes the `olympus-<version>.tgz` asset's `digest` and `size`, and, with
 * `--artifact`, refuses unless a local copy has the same SHA-256 and size.
 * Then it rewrites every pinned place (INSTALL_FOR_AGENTS.md, README.md,
 * docs/QUICKSTART.md, the owner-identifier allowlist and the tests that quote
 * the release URLs) from the previous pin to the new one and records the pin in
 * config/install-guide-pin.json. test/install-guide-consistency.test.ts holds
 * the guide to that file, so a version bump without its hash and size fails.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const REPO = 'jamiezigelbaum/Olympus';
export const PIN_PATH = 'config/install-guide-pin.json';
const PINNED_FILES = [
  'INSTALL_FOR_AGENTS.md',
  'README.md',
  'docs/QUICKSTART.md',
  'scripts/owner-identifier-patterns.ts',
  'test/public-flip-scan.test.ts',
];

export interface InstallGuidePin { version: string; sha256: string; bytes: number }

export function readPin(root = ROOT): InstallGuidePin {
  return JSON.parse(readFileSync(join(root, PIN_PATH), 'utf8')) as InstallGuidePin;
}

/** Replaces the previous pin's version, digest and size in one document. */
export function repin(text: string, from: InstallGuidePin, to: InstallGuidePin): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`releases/tags/v${esc(from.version)}\\b`, 'g'), `releases/tags/v${to.version}`)
    .replace(new RegExp(`releases/tag/v${esc(from.version)}\\b`, 'g'), `releases/tag/v${to.version}`)
    .replace(new RegExp(`releases/download/v${esc(from.version)}/`, 'g'), `releases/download/v${to.version}/`)
    .replace(new RegExp(`olympus-${esc(from.version)}\\.tgz`, 'g'), `olympus-${to.version}.tgz`)
    .replace(new RegExp(`\`v${esc(from.version)}\``, 'g'), `\`v${to.version}\``)
    .replaceAll(from.sha256, to.sha256)
    .replace(new RegExp(`Byte count: \`${from.bytes}\``, 'g'), `Byte count: \`${to.bytes}\``);
}

async function releasePin(version: string): Promise<InstallGuidePin> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'olympus-pin-install-guide' },
  });
  if (!response.ok) throw new Error(`release v${version}: HTTP ${response.status}`);
  const release = await response.json() as {
    tag_name: string; draft: boolean; prerelease: boolean;
    assets: { name: string; state: string; size: number; digest?: string | null }[];
  };
  if (release.tag_name !== `v${version}` || release.draft || release.prerelease) {
    throw new Error(`release v${version} is not a published, final release`);
  }
  const assets = release.assets.filter((asset) => asset.name === `olympus-${version}.tgz`);
  const asset = assets.length === 1 ? assets[0] : undefined;
  if (!asset || asset.state !== 'uploaded') throw new Error(`release v${version}: no single uploaded olympus-${version}.tgz`);
  const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1];
  if (!digest || !(asset.size > 0)) throw new Error(`release v${version}: asset has no sha256 digest or size`);
  return { version, sha256: digest, bytes: asset.size };
}

if (import.meta.main) {
  const [version, flag, artifact] = process.argv.slice(2);
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || (flag && flag !== '--artifact') || (flag && !artifact)) {
    console.error('Usage: bun scripts/pin-install-guide.ts <version> [--artifact <olympus-version.tgz>]');
    process.exit(2);
  }
  const next = await releasePin(version);
  if (artifact) {
    const bytes = readFileSync(artifact);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== next.sha256 || bytes.length !== next.bytes) {
      throw new Error(`${artifact} (${sha256}, ${bytes.length} bytes) does not match the release asset (${next.sha256}, ${next.bytes} bytes)`);
    }
  }
  const previous = readPin();
  for (const path of PINNED_FILES) {
    const file = join(ROOT, path);
    writeFileSync(file, repin(readFileSync(file, 'utf8'), previous, next));
  }
  writeFileSync(join(ROOT, PIN_PATH), `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Pinned v${next.version}: SHA-256 ${next.sha256}, ${next.bytes} bytes (from the release asset).`);
}
