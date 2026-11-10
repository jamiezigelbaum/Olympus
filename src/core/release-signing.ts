/**
 * Release signing, the engine's half: the public key shipped in this package
 * and the check of a signed release manifest published beside each installer
 * (`https://olympusplugin.ai/install.sh.release.json`).
 *
 * A manifest names one release for one platform: its version, the SHA-256 and
 * size of the installer script, and of every file that installer downloads.
 * The release tooling signs it with the release key
 * (scripts/sign-release-manifest.ts); the private key never enters this repo.
 * The dashboard's Update now runs an installer only when this check passes,
 * so a changed installer, or a compromised site, is refused.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * The release key's public half (Ed25519, SPKI PEM), as
 * `bun scripts/sign-release-manifest.ts --public-key` prints it for the key on
 * the release runner (created 2026-11-10; where it lives:
 * olympus-ops docs/ops/release-runner.md). Changing it is a key rotation: the
 * new key must ship in a release users already run before anything is signed
 * with it, or Update now refuses every update.
 */
export const RELEASE_SIGNING_PUBLIC_KEY: string | undefined = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmdoxHVa13VJXq8lzxpbPs0E4RhMPNdlmMsbU8zi0dyA=
-----END PUBLIC KEY-----
`;

export const RELEASE_MANIFEST_SCHEMA = 'olympus.release-manifest.v1';
export const SIGNED_RELEASE_SCHEMA = 'olympus.signed-release.v1';
/** Signed bytes are this context line, then the manifest: a signature means nothing elsewhere. */
export const RELEASE_SIGNATURE_CONTEXT = 'olympus-release-manifest-v1\n';
export const RELEASE_MANIFEST_MAX_BYTES = 64 * 1024;
export type ReleasePlatform = 'darwin-arm64' | 'linux-x64';

export interface ReleaseFile { name: string; sha256: string; bytes: number }
export interface ReleaseManifest {
  schema: typeof RELEASE_MANIFEST_SCHEMA;
  version: string;
  platform: ReleasePlatform;
  installer: ReleaseFile;
  artifacts: ReleaseFile[];
}

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function releaseManifestUrl(installerUrl: string): string {
  return `${installerUrl}.release.json`;
}

export function releasePlatformFor(platform: string): ReleasePlatform | undefined {
  return platform === 'darwin' ? 'darwin-arm64' : platform === 'linux' ? 'linux-x64' : undefined;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The shipped key, or undefined while the placeholder is in place or it does not parse as Ed25519. */
export function releasePublicKey(...given: [pem?: string | undefined]): KeyObject | undefined {
  // An explicit undefined means no key (tests, a caller with none); only an omitted argument means the shipped key.
  const pem = given.length ? given[0] : RELEASE_SIGNING_PUBLIC_KEY;
  if (!pem?.trim()) return undefined;
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch { return undefined; }
}

function file(value: unknown): ReleaseFile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'bytes,name,sha256') return undefined;
  const { name, sha256, bytes } = record;
  if (typeof name !== 'string' || !FILE_NAME.test(name) || typeof sha256 !== 'string' || !SHA256.test(sha256)
    || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) return undefined;
  return { name, sha256, bytes };
}

export function parseReleaseManifest(value: unknown): ReleaseManifest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'artifacts,installer,platform,schema,version') return undefined;
  if (record.schema !== RELEASE_MANIFEST_SCHEMA) return undefined;
  if (typeof record.version !== 'string' || record.version.length > 64 || !VERSION_PATTERN.test(record.version)) return undefined;
  if (record.platform !== 'darwin-arm64' && record.platform !== 'linux-x64') return undefined;
  const installer = file(record.installer);
  if (!installer || !Array.isArray(record.artifacts) || record.artifacts.length === 0 || record.artifacts.length > 16) return undefined;
  const artifacts = record.artifacts.map(file);
  if (artifacts.some(item => !item)) return undefined;
  return { schema: RELEASE_MANIFEST_SCHEMA, version: record.version, platform: record.platform, installer, artifacts: artifacts as ReleaseFile[] };
}

export type ManifestCheck =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; reason: 'no_key' | 'malformed' | 'bad_signature' };

/** Check a signed release envelope against the shipped key (or a given one, for tests and tooling). */
export function verifySignedReleaseManifest(envelope: string | Uint8Array, ...given: [publicKeyPem?: string | undefined]): ManifestCheck {
  // An explicit undefined means no key (tests, a caller with none); only an omitted argument means the shipped key.
  const publicKeyPem = given.length ? given[0] : RELEASE_SIGNING_PUBLIC_KEY;
  const key = releasePublicKey(publicKeyPem);
  if (!key) return { ok: false, reason: 'no_key' };
  const text = typeof envelope === 'string' ? envelope : new TextDecoder().decode(envelope);
  if (new TextEncoder().encode(text).byteLength > RELEASE_MANIFEST_MAX_BYTES) return { ok: false, reason: 'malformed' };
  let outer: unknown;
  try { outer = JSON.parse(text); } catch { return { ok: false, reason: 'malformed' }; }
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return { ok: false, reason: 'malformed' };
  const { schema, manifest, signature } = outer as Record<string, unknown>;
  if (schema !== SIGNED_RELEASE_SCHEMA || typeof manifest !== 'string' || typeof signature !== 'string') return { ok: false, reason: 'malformed' };
  const body = Buffer.from(manifest, 'base64');
  const sig = Buffer.from(signature, 'base64');
  if (body.toString('base64') !== manifest || sig.length !== 64 || sig.toString('base64') !== signature) return { ok: false, reason: 'malformed' };
  let good = false;
  try { good = verify(null, Buffer.concat([Buffer.from(RELEASE_SIGNATURE_CONTEXT), body]), key, sig); } catch { good = false; }
  if (!good) return { ok: false, reason: 'bad_signature' };
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  const checked = parseReleaseManifest(parsed);
  return checked ? { ok: true, manifest: checked } : { ok: false, reason: 'malformed' };
}

/** The pins an installer script carries on its own `KEY=value` lines (the first of each). */
export function installerPin(script: string, key: string): string | undefined {
  return new RegExp(`^${key}=(\\S+)\\r?$`, 'm').exec(script)?.[1];
}

/**
 * Every file a rendered installer downloads from olympusplugin.ai, by its
 * pins: the release tarball, and the WhatsApp bridge and Mac helper when the
 * release has them. Bun is pinned inside the installer and comes from Bun.
 */
export function installerArtifacts(script: string, platform: ReleasePlatform): ReleaseFile[] | undefined {
  const version = installerPin(script, 'OLYMPUS_VERSION');
  const sha256 = installerPin(script, 'OLYMPUS_SHA256');
  const bytes = installerPin(script, 'OLYMPUS_BYTES');
  if (!version || !sha256 || !bytes || !/^[0-9]+$/.test(bytes)) return undefined;
  const out: ReleaseFile[] = [{ name: `olympus-${version}.tgz`, sha256, bytes: Number(bytes) }];
  const bridge = installerPin(script, 'WHATSAPP_BRIDGE_NAME');
  if (bridge && bridge !== 'none') {
    const bridgeSha = installerPin(script, 'WHATSAPP_BRIDGE_SHA256');
    const bridgeBytes = installerPin(script, 'WHATSAPP_BRIDGE_BYTES');
    if (!bridgeSha || !bridgeBytes || !/^[0-9]+$/.test(bridgeBytes)) return undefined;
    out.push({ name: `${bridge}-${platform === 'darwin-arm64' ? 'darwin-arm64' : 'linux-x64'}`, sha256: bridgeSha, bytes: Number(bridgeBytes) });
  }
  const helper = installerPin(script, 'MACOS_HELPER_NAME');
  if (platform === 'darwin-arm64' && helper && helper !== 'none') {
    const helperSha = installerPin(script, 'MACOS_HELPER_SHA256');
    const helperBytes = installerPin(script, 'MACOS_HELPER_BYTES');
    if (!helperSha || !helperBytes || !/^[0-9]+$/.test(helperBytes)) return undefined;
    out.push({ name: helper, sha256: helperSha, bytes: Number(helperBytes) });
  }
  return out.every(item => file(item)) ? out : undefined;
}

/** The manifest the release tooling signs for one rendered installer. */
export function releaseManifestFor(installerName: string, script: string, platform: ReleasePlatform): ReleaseManifest | undefined {
  const version = installerPin(script, 'OLYMPUS_VERSION');
  const artifacts = installerArtifacts(script, platform);
  if (!version || !VERSION_PATTERN.test(version) || !artifacts) return undefined;
  const bytes = new TextEncoder().encode(script);
  return { schema: RELEASE_MANIFEST_SCHEMA, version, platform, installer: { name: installerName, sha256: sha256Hex(bytes), bytes: bytes.byteLength }, artifacts };
}

export type InstallerCheck = { ok: true } | { ok: false; reason: 'installer_mismatch' | 'platform_mismatch' };

/**
 * The downloaded installer is exactly the one the signed manifest names, and
 * the files it will download are exactly the manifest's. Either way a changed
 * installer is refused before anything runs.
 */
export function checkInstallerAgainstManifest(manifest: ReleaseManifest, installer: Uint8Array, platform: ReleasePlatform): InstallerCheck {
  if (manifest.platform !== platform) return { ok: false, reason: 'platform_mismatch' };
  if (installer.byteLength !== manifest.installer.bytes || sha256Hex(installer) !== manifest.installer.sha256) return { ok: false, reason: 'installer_mismatch' };
  const script = new TextDecoder().decode(installer);
  if (installerPin(script, 'OLYMPUS_VERSION') !== manifest.version) return { ok: false, reason: 'installer_mismatch' };
  const pinned = installerArtifacts(script, platform);
  if (!pinned || JSON.stringify(pinned) !== JSON.stringify(manifest.artifacts)) return { ok: false, reason: 'installer_mismatch' };
  return { ok: true };
}
