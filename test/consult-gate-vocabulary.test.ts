// Consult gate vocabulary packs: shipped-pack integrity, the sorted-buffer
// lookup, and the optional user-installed pack mechanism (German, Italian),
// proven with a tiny synthetic pack so no GPL data is needed.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { EvidencePack } from '../src/core/contracts.ts';
import {
  CONSULT_VOCABULARY_PACKS,
  consultVocabularyStatus,
  consultWriterContextFromPack,
  evaluateConsultQuestion,
  loadConsultVocabulary,
  reloadConsultVocabulary,
} from '../src/core/consult-gate.ts';
import { writePack } from '../scripts/build-consult-vocabulary.ts';
import { readManifest, writeManifest } from '../scripts/install-consult-language-pack.ts';

const PACK: EvidencePack = {
  question: 'q',
  builtAt: 'x',
  candidates: [],
  coverage: { searchedCorpora: [], skippedCorpora: [], extractionGaps: [] },
};
const CONTEXT = consultWriterContextFromPack(PACK);
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
    const loaded = loadConsultVocabulary({ 'cldr-names': CONSULT_VOCABULARY_PACKS['cldr-names']! }, null).vocabulary!;
    const words = gunzipSync(readFileSync(join(import.meta.dir, '..', 'assets', 'consult', 'vocabulary', 'cldr-names.txt.gz')))
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
    expect(evaluateConsultQuestion(GERMAN, CONTEXT).reasons).toContain('unknown_word');
    expect(consultVocabularyStatus().filter((entry) => entry.origin === 'user')).toEqual([]);
  });

  test('an installed pack is verified against the local manifest, loaded, and its words pass', () => {
    process.env.OLYMPUS_CONSULT_VOCABULARY_DIR = userPackDir(['ist', 'unterschied', 'zwischen', 'einem', 'mietvertrag', 'untermietvertrag']);
    reloadConsultVocabulary();
    expect(consultVocabularyStatus().filter((entry) => entry.origin === 'user')).toEqual([
      { id: 'de-hunspell', origin: 'user', state: 'loaded', words: 6 },
    ]);
    expect(evaluateConsultQuestion(GERMAN, CONTEXT)).toEqual({ decision: 'pass', reasons: [] });
  });

  test('a pack that does not match its manifest hash is skipped, and its words stay refused', () => {
    process.env.OLYMPUS_CONSULT_VOCABULARY_DIR = userPackDir(['ist', 'unterschied', 'zwischen', 'einem', 'mietvertrag', 'untermietvertrag'], true);
    reloadConsultVocabulary();
    expect(consultVocabularyStatus().find((entry) => entry.origin === 'user')?.state).toBe('hash_mismatch');
    expect(evaluateConsultQuestion(GERMAN, CONTEXT).reasons).toContain('unknown_word');
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
