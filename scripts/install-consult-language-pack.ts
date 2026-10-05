/**
 * Install an optional consult-gate language pack for German or Italian.
 *
 * The only word lists for these languages are GPL-licensed, so Olympus does
 * not ship them. This script, run by the user on their own machine, fetches
 * the upstream hunspell dictionary from the npm registry, builds the pack
 * locally with scripts/build-consult-vocabulary.ts, and writes it to the
 * user's vocabulary directory (OLYMPUS_CONSULT_VOCABULARY_DIR, or
 * ~/.olympus/consult/vocabulary). Nothing is written to the repository or to
 * dist/. The pack's SHA-256 is recorded in manifest.json there; the gate
 * verifies it at load and skips a pack that does not match.
 *
 * Usage:
 *   bun scripts/install-consult-language-pack.ts de|it          install
 *   bun scripts/install-consult-language-pack.ts --status       list installed packs
 *   bun scripts/install-consult-language-pack.ts --remove de|it remove
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { consultUserVocabularyDir } from '../src/core/consult-gate.ts';
import { buildPack } from './build-consult-vocabulary.ts';

export const OPTIONAL_LANGUAGE_PACKS: Readonly<Record<string, { id: string; npm: string; version: string; licence: string }>> = {
  de: { id: 'de-hunspell', npm: 'dictionary-de', version: '3.0.0', licence: 'GPL-2.0 OR GPL-3.0' },
  it: { id: 'it-hunspell', npm: 'dictionary-it', version: '2.0.0', licence: 'GPL-3.0' },
};

interface Manifest {
  schema: 1;
  packs: Record<string, { sha256: string; source: string; licence: string; builtAt: string; words: number }>;
}

export function readManifest(dir: string): Manifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return { schema: 1, packs: {} };
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

export function writeManifest(dir: string, manifest: Manifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Minimal tar reader for an npm tarball: returns the files under package/. */
function untar(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const name = tar.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/su, '');
    if (!name) break;
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString('utf8').replace(/\0.*$/su, '').trim() || '0', 8);
    const type = tar[offset + 156];
    if (type === 0x30 || type === 0) files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export async function installLanguagePack(language: string, dir = consultUserVocabularyDir()): Promise<{ id: string; words: number; sha256: string }> {
  const spec = OPTIONAL_LANGUAGE_PACKS[language];
  if (!spec) throw new Error(`unknown optional language: ${language} (choose de or it)`);
  const meta = await (await fetch(`https://registry.npmjs.org/${spec.npm}/${spec.version}`)).json() as {
    dist: { tarball: string; integrity: string };
  };
  const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const [algorithm, expected] = meta.dist.integrity.split('-') as [string, string];
  if (createHash(algorithm).update(tgz).digest('base64') !== expected) throw new Error(`${spec.npm} tarball failed its registry integrity check`);
  const work = mkdtempSync(join(tmpdir(), 'olympus-consult-pack-'));
  try {
    const files = untar(tgz);
    mkdirSync(join(work, 'package'), { recursive: true });
    for (const name of ['package.json', 'index.aff', 'index.dic']) {
      const file = files.get(`package/${name}`);
      if (!file) throw new Error(`${spec.npm} tarball has no ${name}`);
      writeFileSync(join(work, 'package', name), file);
    }
    mkdirSync(dir, { recursive: true });
    const result = buildPack(spec.id, dir, [join(work, 'package')]);
    const manifest = readManifest(dir);
    manifest.packs[spec.id] = {
      sha256: result.sha256,
      source: `npm ${spec.npm} ${spec.version} (${meta.dist.integrity})`,
      licence: spec.licence,
      builtAt: new Date().toISOString(),
      words: result.words,
    };
    writeManifest(dir, manifest);
    return { id: spec.id, words: result.words, sha256: result.sha256 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  const dir = consultUserVocabularyDir();
  if (first === '--status') {
    console.log(JSON.stringify({ dir, packs: readManifest(dir).packs }, null, 2));
  } else if (first === '--remove' && second && OPTIONAL_LANGUAGE_PACKS[second]) {
    const id = OPTIONAL_LANGUAGE_PACKS[second]!.id;
    const manifest = readManifest(dir);
    delete manifest.packs[id];
    writeManifest(dir, manifest);
    rmSync(join(dir, `${id}.txt.gz`), { force: true });
    console.log(`removed ${id}`);
  } else if (first && OPTIONAL_LANGUAGE_PACKS[first]) {
    const result = await installLanguagePack(first, dir);
    console.log(`installed ${result.id}: ${result.words} words in ${dir}`);
  } else {
    throw new Error('usage: bun scripts/install-consult-language-pack.ts de|it | --status | --remove de|it');
  }
}
