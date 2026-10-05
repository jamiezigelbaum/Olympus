// Consult gate vocabulary packs: shipped-pack integrity, the sorted-buffer
// lookup, and the optional user-installed pack mechanism (German, Italian),
// proven with a tiny synthetic pack so no GPL data is needed.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { EvidencePack } from '../src/core/contracts.ts';
import {
  CONSULT_VOCABULARY_PACKS,
  consultVocabularyFileStatus,
  consultVocabularyRoot,
  consultVocabularyStatus,
  consultWriterContextFromPack,
  evaluateConsultQuestion,
  loadConsultVocabulary,
  reloadConsultVocabulary,
  type ConsultGateOptions,
} from '../src/core/consult-gate.ts';
import { V0_4_PUBLIC_PACKAGE_FILES } from '../src/core/public-surface.ts';
import { writePack } from '../scripts/build-consult-vocabulary.ts';
import { readBounded, readManifest, writeManifest } from '../scripts/install-consult-language-pack.ts';

const PACK: EvidencePack = {
  question: 'q',
  builtAt: 'x',
  candidates: [],
  coverage: { searchedCorpora: [], skippedCorpora: [], extractionGaps: [] },
};
const CONTEXT = consultWriterContextFromPack(PACK);
const DE = { languages: ['en', 'de'] } as const satisfies ConsultGateOptions;
const GERMAN = 'Was ist der Unterschied zwischen einem Mietvertrag und einem Untermietvertrag?';
const dirs: string[] = [];
const originalDir = process.env.OLYMPUS_CONSULT_VOCABULARY_DIR;

function userPackDir(words: string[], tamper = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-consult-vocab-'));
  dirs.push(dir);
  const result = writePack(dir, { id: 'de-hunspell', source: 'synthetic test pack', licence: 'test' }, new Set(words));
  const manifest = readManifest(dir);
  manifest.packs['de-hunspell'] = { sha256: result.sha256, source: 'synthetic', licence: 'test', builtAt: 'now', words: result.words };
  writeManifest(dir, manifest);
  if (tamper) writeFileSync(join(dir, 'de-hunspell.txt.gz'), Buffer.from('not the pack'));
  return dir;
}

afterEach(() => {
  if (originalDir === undefined) delete process.env.OLYMPUS_CONSULT_VOCABULARY_DIR;
  else process.env.OLYMPUS_CONSULT_VOCABULARY_DIR = originalDir;
  reloadConsultVocabulary();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('shipped vocabulary packs', () => {
  test('every shipped pack loads and matches its pinned hash', () => {
    const loaded = loadConsultVocabulary(CONSULT_VOCABULARY_PACKS, null);
    expect(loaded.vocabulary).not.toBeNull();
    expect(loaded.status.map((entry) => [entry.id, entry.state])).toEqual(
      Object.keys(CONSULT_VOCABULARY_PACKS).map((id) => [id, 'loaded']),
    );
  });

  test('a shipped pack that does not match its pin makes the whole vocabulary unavailable', () => {
    const loaded = loadConsultVocabulary({ ...CONSULT_VOCABULARY_PACKS, 'en-esdb': '0'.repeat(64) }, null);
    expect(loaded.vocabulary).toBeNull();
    expect(loaded.status.find((entry) => entry.id === 'en-esdb')?.state).toBe('hash_mismatch');
  });

  test('the sorted-buffer lookup finds every word of a pack and nothing else', () => {
    const loaded = loadConsultVocabulary({ 'cldr-units': CONSULT_VOCABULARY_PACKS['cldr-units']! }, null).vocabulary!;
    const words = gunzipSync(readFileSync(join(import.meta.dir, '..', 'assets', 'consult', 'vocabulary', 'cldr-units.txt.gz')))
      .toString('utf8').split('\n').filter((line) => line && !line.startsWith('#'));
    expect(words.length).toBeGreaterThan(1_000);
    expect(words.filter((word) => !loaded.has(word))).toEqual([]);
    for (const absent of ['zzzzqx', 'aaaaaaaaaaaa', `${words[0]}x`, words.at(-1)!.slice(0, -1) + 'zzzz']) {
      if (!words.includes(absent)) expect({ absent, has: loaded.has(absent) }).toEqual({ absent, has: false });
    }
  });
});

describe('user-installed language packs', () => {
  test('without the pack, German is refused', () => {
    process.env.OLYMPUS_CONSULT_VOCABULARY_DIR = mkdtempSync(join(tmpdir(), 'olympus-consult-empty-'));
    dirs.push(process.env.OLYMPUS_CONSULT_VOCABULARY_DIR);
    reloadConsultVocabulary();
    expect(evaluateConsultQuestion(GERMAN, CONTEXT, {}, {}, DE).reasons).toContain('unknown_word');
    expect(consultVocabularyStatus(DE).filter((entry) => entry.origin === 'user')).toEqual([{ id: 'de-hunspell', origin: 'user', state: 'missing', words: 0 }]);
  });

  test('an installed pack is verified against the local manifest, loaded, and its words pass', () => {
    process.env.OLYMPUS_CONSULT_VOCABULARY_DIR = userPackDir(['was', 'ist', 'der', 'unterschied', 'zwischen', 'einem', 'mietvertrag', 'und', 'untermietvertrag']);
    reloadConsultVocabulary();
    expect(consultVocabularyStatus(DE).filter((entry) => entry.origin === 'user')).toEqual([
      { id: 'de-hunspell', origin: 'user', state: 'loaded', words: 9 },
    ]);
    expect(evaluateConsultQuestion(GERMAN, CONTEXT, {}, {}, DE)).toEqual({ decision: 'pass', reasons: [] });
    // Installed but not configured: not admitted.
    expect(evaluateConsultQuestion(GERMAN, CONTEXT).reasons).toContain('unknown_word');
  });

  test('a pack that does not match its manifest hash is skipped, and its words stay refused', () => {
    process.env.OLYMPUS_CONSULT_VOCABULARY_DIR = userPackDir(['ist', 'unterschied', 'zwischen', 'einem', 'mietvertrag', 'untermietvertrag'], true);
    reloadConsultVocabulary();
    expect(consultVocabularyStatus(DE).find((entry) => entry.origin === 'user')?.state).toBe('hash_mismatch');
    expect(evaluateConsultQuestion(GERMAN, CONTEXT, {}, {}, DE).reasons).toContain('unknown_word');
  });

  test('a user pack cannot replace a shipped pack', () => {
    const dir = userPackDir(['zzzzqx']);
    const manifest = readManifest(dir);
    manifest.packs['en-esdb'] = { ...manifest.packs['de-hunspell']!, sha256: createHash('sha256').update(readFileSync(join(dir, 'de-hunspell.txt.gz'))).digest('hex') };
    writeManifest(dir, manifest);
    const loaded = loadConsultVocabulary(CONSULT_VOCABULARY_PACKS, dir);
    expect(loaded.status.filter((entry) => entry.id === 'en-esdb').map((entry) => entry.origin)).toEqual(['shipped']);
  });
});

describe('packaged layout', () => {
  const REPO = join(import.meta.dir, '..');
  const VOCABULARY = 'assets/consult/vocabulary';
  const ALL = { languages: ['en', 'nl', 'fr', 'es', 'pt-PT', 'pt-BR'], domains: { units: true, countries: true, medicines: true, medicineBrands: true } } as const satisfies ConsultGateOptions;
  const PACKAGE_FILES: readonly string[] = V0_4_PUBLIC_PACKAGE_FILES;

  test('every shipped pack and its licence is a public package file, one by one, with the notices document', () => {
    const shipped = readdirSync(join(REPO, VOCABULARY)).map((name) => `${VOCABULARY}/${name}`).sort();
    expect(shipped).toEqual(Object.keys(CONSULT_VOCABULARY_PACKS).flatMap((id) => [`${VOCABULARY}/${id}.LICENSE.txt`, `${VOCABULARY}/${id}.txt.gz`]).sort());
    expect(PACKAGE_FILES.filter((path) => path.startsWith(`${VOCABULARY}/`)).sort()).toEqual(shipped);
    expect(PACKAGE_FILES).toContain('docs/THIRD_PARTY_DATA.md');
  });

  // The gate bundled into dist/ of a package holding only the public package
  // files finds its packs; without them it refuses every request.
  function runBundled(withPacks: boolean): { root: string | null; files: Array<{ id: string; state: string }>; verdict: { decision: string; reasons: string[] } } {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-consult-package-'));
    dirs.push(dir);
    const packageRoot = join(dir, 'package');
    if (withPacks) {
      for (const path of PACKAGE_FILES.filter((entry) => entry.startsWith('assets/consult/'))) {
        mkdirSync(dirname(join(packageRoot, path)), { recursive: true });
        copyFileSync(join(REPO, path), join(packageRoot, path));
      }
    }
    const bundle = join(packageRoot, 'dist', 'index.js');
    const built = spawnSync(process.execPath, ['build', join(REPO, 'src/core/consult-gate.ts'), '--target=node', '--format=esm', `--outfile=${bundle}`], { encoding: 'utf8' });
    expect(built.status).toBe(0);
    const probe = join(dir, 'probe.mjs');
    writeFileSync(probe, [
      `import * as gate from ${JSON.stringify(bundle)};`,
      `const context = gate.consultWriterContextFromPack({ question: 'q', builtAt: 'x', candidates: [], coverage: { searchedCorpora: [], skippedCorpora: [], extractionGaps: [] } });`,
      `console.log(JSON.stringify({ root: gate.consultVocabularyRoot() ?? null, files: gate.consultVocabularyFileStatus(${JSON.stringify(ALL)}, { HOME: ${JSON.stringify(dir)} }), verdict: gate.evaluateConsultQuestion('What is the usual notice period for ending a tenancy?', context) }));`,
    ].join('\n'));
    const run = spawnSync(process.execPath, [probe], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir } });
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout) as ReturnType<typeof runBundled>;
  }

  test('a dist bundle in a package of the public files finds and verifies every pack', () => {
    const result = runBundled(true);
    expect(result.root?.endsWith(join('package'))).toBe(true);
    expect(result.files.map((entry) => [entry.id, entry.state])).toEqual(
      Object.keys(CONSULT_VOCABULARY_PACKS).sort().map((id) => [id, 'verified']),
    );
    expect(result.verdict).toEqual({ decision: 'pass', reasons: [] });
  }, 60_000);

  test('the same bundle without the packs refuses with vocabulary_unavailable', () => {
    const result = runBundled(false);
    expect(result.root).toBeNull();
    expect(result.files.every((entry) => entry.state === 'missing')).toBe(true);
    expect(result.verdict).toEqual({ decision: 'refuse', reasons: ['vocabulary_unavailable'] });
  }, 60_000);

  test('the doctor status hashes files only and matches the loader', () => {
    expect(consultVocabularyFileStatus(ALL).map((entry) => entry.state)).toEqual(Object.keys(CONSULT_VOCABULARY_PACKS).map(() => 'verified'));
    expect(consultVocabularyFileStatus({}).map((entry) => entry.id)).toEqual(['cldr-units', 'en-esdb', 'rx-ingredients']);
  });
});

describe('pack root by supported layout only', () => {
  function tree(paths: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-consult-root-'));
    dirs.push(dir);
    for (const path of paths) mkdirSync(join(dir, path), { recursive: true });
    return dir;
  }
  const at = (dir: string, ...parts: string[]) => consultVocabularyRoot(pathToFileURL(join(dir, ...parts)).href);
  const VOCAB = 'assets/consult/vocabulary';

  test('this module in a checkout resolves to the repository root', () => {
    expect(consultVocabularyRoot()).toBe(join(import.meta.dir, '..'));
  });

  test('src/core resolves to the repository root, and a decoy in src/assets does not shadow it', () => {
    const dir = tree([`repo/${VOCAB}`, `repo/src/${VOCAB}`, 'repo/src/core']);
    expect(at(dir, 'repo', 'src', 'core', 'consult-gate.ts')).toBe(join(dir, 'repo'));
    const onlyDecoy = tree([`repo/src/${VOCAB}`, 'repo/src/core']);
    expect(at(onlyDecoy, 'repo', 'src', 'core', 'consult-gate.ts')).toBeUndefined();
  });

  test('dist resolves to the package root, never to a parent of the package', () => {
    const dir = tree([`${VOCAB}`, `package/${VOCAB}`, 'package/dist']);
    expect(at(dir, 'package', 'dist', 'index.js')).toBe(join(dir, 'package'));
    const decoyAbove = tree([`${VOCAB}`, `package/dist/${VOCAB}`, 'package/dist']);
    expect(at(decoyAbove, 'package', 'dist', 'index.js')).toBeUndefined();
  });

  test('an unsupported layout has no root even when a pack directory is nearby', () => {
    const dir = tree([`package/${VOCAB}`, 'package/lib', `${VOCAB}`, 'core', `x/${VOCAB}`, 'x/core']);
    expect(at(dir, 'package', 'lib', 'index.js')).toBeUndefined();
    expect(at(dir, 'x', 'core', 'consult-gate.ts')).toBeUndefined();
  });
});

describe('language-pack download', () => {
  test('a body past the byte limit is cancelled mid-stream, not buffered whole', async () => {
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    await expect(readBounded(new Response(endless), 10 * 1024, 'test tarball')).rejects.toThrow('test tarball is larger than 10240 bytes');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20);
  });

  test('a body within the limit is returned whole', async () => {
    const body = Buffer.from('a'.repeat(5000));
    expect((await readBounded(new Response(body), 5000, 'test tarball')).equals(body)).toBe(true);
  });
});
