/**
 * Signs a release's manifest for the dashboard's Update now (#1063).
 *
 *   OLYMPUS_RELEASE_SIGNING_KEY_FILE=<path> bun scripts/sign-release-manifest.ts site/install.sh
 *   bun scripts/sign-release-manifest.ts --key-file <path> site/install.sh site/install-linux.sh
 *   bun scripts/sign-release-manifest.ts --public-key --key-file <path>
 *   bun scripts/sign-release-manifest.ts --check
 *
 * Run after scripts/publish-release-to-site.ts has written a rendered
 * installer. For each installer it writes `<installer>.release.json` beside
 * it (site/install.sh.release.json, served at
 * https://olympusplugin.ai/install.sh.release.json): the release version, the
 * installer's SHA-256 and size, and those of every file it downloads, signed
 * with the release key (Ed25519). The engine checks it against the public key
 * in src/core/release-signing.ts before it runs an installer.
 *
 * The private key comes only from the operator: a PKCS#8 PEM file named by
 * --key-file or OLYMPUS_RELEASE_SIGNING_KEY_FILE, or the PEM itself in
 * OLYMPUS_RELEASE_SIGNING_KEY. This script never creates, prints or stores a
 * private key. It refuses a key whose public half is not the one the engine
 * ships, since the engine would refuse what it signed.
 *
 * `--public-key` prints the public half (SPKI PEM) of the operator's key, to
 * put in RELEASE_SIGNING_PUBLIC_KEY. `--check` (site/deploy/deploy.sh) checks
 * every rendered installer in site/ has a manifest that verifies; while the
 * engine ships no key it only says so.
 */
import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkInstallerAgainstManifest, RELEASE_SIGNATURE_CONTEXT, RELEASE_SIGNING_PUBLIC_KEY, releaseManifestFor, releasePublicKey,
  SIGNED_RELEASE_SCHEMA, verifySignedReleaseManifest, type ReleasePlatform,
} from '../src/core/release-signing.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SIGNED_INSTALLERS: Record<string, ReleasePlatform> = { 'install.sh': 'darwin-arm64', 'install-linux.sh': 'linux-x64' };

export function manifestPath(installerPath: string): string {
  return `${installerPath}.release.json`;
}

function platformOf(installerPath: string): ReleasePlatform {
  const platform = SIGNED_INSTALLERS[basename(installerPath)];
  if (!platform) throw new Error(`${installerPath}: sign install.sh or install-linux.sh.`);
  return platform;
}

/** The operator's private key, never echoed. */
export function loadSigningKey(input: { keyFile?: string | undefined; env: Record<string, string | undefined> }): KeyObject {
  const file = input.keyFile ?? input.env.OLYMPUS_RELEASE_SIGNING_KEY_FILE;
  const pem = file ? readFileSync(file, 'utf8') : input.env.OLYMPUS_RELEASE_SIGNING_KEY;
  if (!pem?.trim()) throw new Error('No release signing key: pass --key-file <path>, or set OLYMPUS_RELEASE_SIGNING_KEY_FILE or OLYMPUS_RELEASE_SIGNING_KEY.');
  let key: KeyObject;
  try { key = createPrivateKey(pem); } catch { throw new Error('The release signing key is not a readable private key (PKCS#8 PEM).'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The release signing key must be Ed25519.');
  return key;
}

export function publicKeyPem(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
}

/** The signed envelope for one rendered installer. */
export function signInstaller(installerPath: string, privateKey: KeyObject, ...given: [shippedPublicKey?: string | undefined]): string {
  // An explicit undefined means no key (tests, a caller with none); only an omitted argument means the shipped key.
  const shippedPublicKey = given.length ? given[0] : RELEASE_SIGNING_PUBLIC_KEY;
  const shipped = releasePublicKey(shippedPublicKey);
  if (!shipped) throw new Error('The engine ships no release public key yet (src/core/release-signing.ts RELEASE_SIGNING_PUBLIC_KEY). Put the output of --public-key there first, in a release the users already run.');
  if (publicKeyPem(privateKey) !== shipped.export({ type: 'spki', format: 'pem' }).toString()) {
    throw new Error('This private key is not the release key the engine ships; the engine would refuse what it signs.');
  }
  const script = readFileSync(installerPath, 'utf8');
  if (/@[A-Z][A-Z0-9_]*@/.test(script)) throw new Error(`${installerPath} is the template, not a rendered installer.`);
  const manifest = releaseManifestFor(basename(installerPath), script, platformOf(installerPath));
  if (!manifest) throw new Error(`${installerPath} has no complete release pins.`);
  const body = Buffer.from(JSON.stringify(manifest));
  const signature = sign(null, Buffer.concat([Buffer.from(RELEASE_SIGNATURE_CONTEXT), body]), privateKey);
  const envelope = `${JSON.stringify({ schema: SIGNED_RELEASE_SCHEMA, manifest: body.toString('base64'), signature: signature.toString('base64') })}\n`;
  const check = checkSigned(installerPath, envelope, shippedPublicKey);
  if (check) throw new Error(check);
  return envelope;
}

/** A problem with a signed manifest for this installer, or undefined when it verifies. */
export function checkSigned(installerPath: string, envelope: string, ...given: [shippedPublicKey?: string | undefined]): string | undefined {
  // An explicit undefined means no key (tests, a caller with none); only an omitted argument means the shipped key.
  const shippedPublicKey = given.length ? given[0] : RELEASE_SIGNING_PUBLIC_KEY;
  const signed = verifySignedReleaseManifest(envelope, shippedPublicKey);
  if (!signed.ok) return `${manifestPath(installerPath)}: ${signed.reason === 'bad_signature' ? 'the signature does not verify' : signed.reason === 'no_key' ? 'no release key' : 'malformed'}.`;
  const checked = checkInstallerAgainstManifest(signed.manifest, readFileSync(installerPath), platformOf(installerPath));
  return checked.ok ? undefined : `${manifestPath(installerPath)} does not match ${installerPath} (${checked.reason}).`;
}

export function checkSite(root: string, ...given: [shippedPublicKey?: string | undefined]): string[] {
  // An explicit undefined means no key (tests, a caller with none); only an omitted argument means the shipped key.
  const shippedPublicKey = given.length ? given[0] : RELEASE_SIGNING_PUBLIC_KEY;
  if (!releasePublicKey(shippedPublicKey)) return [];
  const problems: string[] = [];
  for (const name of Object.keys(SIGNED_INSTALLERS)) {
    const installer = join(root, 'site', name);
    if (!existsSync(installer)) continue;
    const manifest = manifestPath(installer);
    if (!existsSync(manifest)) { problems.push(`${manifest} is missing: run bun scripts/sign-release-manifest.ts ${join('site', name)}.`); continue; }
    const problem = checkSigned(installer, readFileSync(manifest, 'utf8'), shippedPublicKey);
    if (problem) problems.push(problem);
  }
  return problems;
}

function main(args: string[]): void {
  let keyFile: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key-file') { keyFile = args[++i]; if (!keyFile) throw new Error('--key-file needs a path.'); }
    else if (args[i]!.startsWith('--key-file=')) keyFile = args[i]!.slice('--key-file='.length);
    else rest.push(args[i]!);
  }
  if (rest[0] === '--check') {
    if (!releasePublicKey()) { console.log('The engine ships no release public key yet; no manifest is required.'); return; }
    const problems = checkSite(ROOT);
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exit(1);
    console.log('Every rendered installer in site/ has a release manifest that verifies.');
    return;
  }
  const key = loadSigningKey({ keyFile, env: process.env });
  if (rest[0] === '--public-key') { process.stdout.write(publicKeyPem(key)); return; }
  if (rest.length === 0) throw new Error('Name the rendered installer(s) to sign, e.g. site/install.sh.');
  for (const installer of rest) {
    writeFileSync(manifestPath(installer), signInstaller(installer, key), { mode: 0o644 });
    console.log(`Signed ${manifestPath(installer)}.`);
  }
}

if (import.meta.main) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
