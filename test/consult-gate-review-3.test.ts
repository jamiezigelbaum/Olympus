// Consult outbound gate: the third adversarial review's cases (Codex, round 3
// on e8234b32). Each case is refused here or recorded as a tested, stated
// limit (`known gap:` tests expect a pass and say why).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { EvidenceCandidate, EvidencePack } from '../src/core/contracts.ts';
import {
  CONSULT_VOCABULARY_PACKS,
  consultWriterContextFromPack,
  evaluateConsultRequest,
  loadConsultVocabulary,
  type ConsultGateOptions,
  type ConsultWriterContext,
  type ConsultWriterContextOptions,
} from '../src/core/consult-gate.ts';

interface Spec {
  chunks?: string[];
  title?: string;
  uri?: string;
}

function packOf(specs: Spec[]): EvidencePack {
  return {
    question: 'what happened',
    builtAt: '2026-10-05T09:00:00.000Z',
    candidates: specs.map((spec, index): EvidenceCandidate => ({
      provenance: {
        sourceItem: { family: 'file', provider: 'synthetic', accountScope: 'personal', providerItemId: `item-${index}`, localItemId: `local-${index}` },
        citation: { ...(spec.title ? { title: spec.title } : {}), ...(spec.uri ? { uri: spec.uri } : {}) },
      },
      trustTier: 'S4',
      trustDomain: 'secure_local',
      chunks: spec.chunks ?? [],
    })),
    coverage: { searchedCorpora: ['secure_local.synthetic'], skippedCorpora: [], extractionGaps: [] },
  };
}

function ctx(specs: Spec[], options: ConsultWriterContextOptions = {}): ConsultWriterContext {
  return consultWriterContextFromPack(packOf(specs), options);
}

const EN: ConsultGateOptions = { languages: ['en'] };
const ROMANCE: ConsultGateOptions = { languages: ['en', 'fr', 'es', 'pt-PT', 'pt-BR', 'nl'] };

function verdict(question: string | string[], context: ConsultWriterContext, options: ConsultGateOptions = EN) {
  return evaluateConsultRequest(typeof question === 'string' ? [question] : question, context, {}, {}, options);
}

function refused(question: string | string[], context: ConsultWriterContext, options: ConsultGateOptions = EN): void {
  expect({ question, decision: verdict(question, context, options).decision }).toEqual({ question, decision: 'refuse' });
}

function passed(question: string, context: ConsultWriterContext, options: ConsultGateOptions = EN): void {
  expect({ question, verdict: verdict(question, context, options) }).toEqual({ question, verdict: { decision: 'pass', reasons: [] } });
}

const NEUTRAL = ctx([{ chunks: ['The inspection happened after the keys were returned.'] }]);

describe('review 3: configured languages', () => {
  test('only configured language packs are admitted', () => {
    const french = 'Quelle est la différence entre un bail et une sous-location?';
    refused(french, NEUTRAL, EN);
    passed(french, NEUTRAL, { languages: ['en', 'fr'] });
  });
  test('the default is English', () => {
    expect(evaluateConsultRequest(['Quelle est la différence entre un bail et une sous-location?'], NEUTRAL).decision).toBe('refuse');
    expect(evaluateConsultRequest(['What is the difference between a lease and a sublease?'], NEUTRAL).decision).toBe('pass');
  });
});

describe('review 3, fix 1: names in common positions', () => {
  // "Mason" is an English word and a name, so the vocabulary rule admits it
  // and the snapshot rules must decide.
  test('a sentence-initial name', () => {
    refused('Can Mason appeal?', ctx([{ chunks: ['Mason reported a breach.'] }]));
  });
  test('a label value in single quotes, and a lower-case label value', () => {
    refused('Can mason appeal?', ctx([{ chunks: ["Reporter: 'Mason'."] }]));
    refused('Can mason appeal?', ctx([{ chunks: ['reporter: mason.'] }]));
  });
  test('known gap: a dictionary-word name written only in lower-case prose', () => {
    passed('Can mason appeal?', ctx([{ chunks: ['mason reported a breach.'] }]));
  });
  test('a simple inflection of a recognised name', () => {
    refused('Can masons appeal?', ctx([{ chunks: ['The report from Mason arrived.'] }]));
  });
  test('lower-case repeats do not cancel a mid-sentence name', () => {
    refused('Can mason appeal?', ctx([{ chunks: ['The report from Mason arrived. mason mason.'] }]));
  });
  test('identifier and path components, any position', () => {
    refused('Can mason appeal?', ctx([{ title: 'Mason report' }]));
    refused('Can mason appeal?', ctx([{ uri: '/Mason/report' }]));
    refused('Can mason appeal?', ctx([{ title: 'Reporter: Mason' }]));
  });
  test('the original cases, with French configured', () => {
    const fr: ConsultGateOptions = { languages: ['en', 'fr'] };
    refused('Can Fenwick appeal?', ctx([{ chunks: ['Fenwick reported a breach.'] }]), fr);
    refused('Can fenwick appeal?', ctx([{ chunks: ["Reporter: 'Fenwick'."] }]), fr);
    refused('Can fenwicks appeal?', ctx([{ chunks: ['The report from Fenwick arrived.'] }]), fr);
  });
});

describe('review 3, fix 2: numbers and dates in every configured language', () => {
  const fee = ctx([{ chunks: ['The fee was 862 euros.'] }]);
  test('number words, both directions', () => {
    for (const question of [
      'Is huit cent soixante-deux euros a lot?',
      'Is ochocientos sesenta y dos euros a lot?',
      'Is oitocentos e sessenta e dois euros a lot?',
    ]) refused(question, fee, ROMANCE);
    for (const document of [
      'Le prix est huit cent soixante-deux euros.',
      'El precio es ochocientos sesenta y dos euros.',
      'O valor é oitocentos e sessenta e dois euros.',
    ]) refused('Is 862 euros a lot?', ctx([{ chunks: [document] }]), ROMANCE);
  });
  test('dates in words, both directions', () => {
    const signed = ctx([{ chunks: ['Signed 2024-03-14.'] }]);
    for (const question of [
      'Que se passe-t-il le quatorze mars deux mille vingt-quatre?',
      '¿Qué pasó el catorce de marzo de dos mil veinticuatro?',
      'O que aconteceu em catorze de março de dois mil e vinte e quatro?',
      'Wat gebeurde er op veertien maart?',
    ]) refused(question, signed, ROMANCE);
    for (const document of [
      'Signé le quatorze mars deux mille vingt-quatre.',
      'Firmado el catorce de marzo de dos mil veinticuatro.',
      'Assinado em catorze de março de dois mil e vinte e quatro.',
    ]) refused('What rules applied on 14-03-24?', ctx([{ chunks: [document] }]), ROMANCE);
  });
  test('Dutch number words and English article-led scales', () => {
    refused('Is honderd euro veel?', ctx([{ chunks: ['The fee was 100 euros.'] }]), ROMANCE);
    for (const [words, digits] of [['a hundred', '100'], ['a thousand', '1000'], ['a million', '1000000']] as const) {
      refused(`Is ${words} euros a lot?`, ctx([{ chunks: [`The fee was ${digits} euros.`] }]));
      refused(`Is ${digits === '1000000' ? '1,000,000' : digits} euros a lot?`, ctx([{ chunks: [`The fee was ${words} euros.`] }]));
    }
  });
  test('two-digit numbers next to a unit in another language', () => {
    refused('Is 37 anos old?', ctx([{ chunks: ['Ela tem 37 anos.'] }]), ROMANCE);
    refused('Is 37 ans old?', ctx([{ chunks: ['Il a 37 ans.'] }]), ROMANCE);
    refused('Is 37 años old?', ctx([{ chunks: ['Tiene 37 años.'] }]), ROMANCE);
  });
});

describe('review 3, fix 3: dictionary-valid encodings', () => {
  test('ROT13 of a known identifier that happens to be a word', () => {
    for (const [name, question] of [
      ['Anna', 'Can naan appeal?'], ['Noor', 'Is abbe eligible?'], ['Anil', 'Can navy appeal?'], ['Ivan', 'Is vina eligible?'],
      ['Chen', 'Is pura eligible?'], ['Bob', 'Is obo eligible?'],
    ] as const) {
      refused(question, ctx([{}], { connectedAccountIdentifiers: [name] }), ROMANCE);
    }
  });
  test('known gap: a name whose ROT13 or reversal is a function word', () => {
    // Function words are left out of the ROT13 and reversal comparisons, so an
    // owner with a contact named Jung can still ask questions with "what".
    passed('What is a deposit?', ctx([{}], { connectedAccountIdentifiers: ['Jung'] }), ROMANCE);
    passed('What is a deposit?', ctx([{ chunks: ['The report from Jung arrived.'] }]), ROMANCE);
    // A content word that is the ROT13 of a known name still refuses.
    refused('Can naan appeal?', ctx([{}], { connectedAccountIdentifiers: ['Anna'] }), ROMANCE);
  });
  test('a name spelled out letter by letter', () => {
    refused('Can n a d i a appeal?', ctx([{ chunks: ['Nadia reported a breach.'] }]));
  });
});

describe('review 3, fix 4: reordering beyond adjacent windows', () => {
  test('all distinctive words of one sentence in another order', () => {
    refused('Why do silver cedar cranes tunnels guard hidden?', ctx([{ chunks: ['silver cranes guard hidden cedar tunnels'] }]));
  });
});

describe('review 3: loader and builder robustness', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const dir = (): string => {
    const made = mkdtempSync(join(tmpdir(), 'olympus-consult-r3-'));
    dirs.push(made);
    return made;
  };
  const english = { 'en-esdb': CONSULT_VOCABULARY_PACKS['en-esdb']! };

  test('malformed manifests never throw', () => {
    for (const manifest of ['null', '{"packs":{"evil":null}}', '[]', '{"packs":7}', 'not json']) {
      const user = dir();
      writeFileSync(join(user, 'manifest.json'), manifest);
      const loaded = loadConsultVocabulary(english, user);
      expect(loaded.vocabulary).not.toBeNull();
    }
  });
  test('a user pack that is not gzip, or expands past the bound, is skipped with a content-free status', () => {
    const user = dir();
    const notGzip = Buffer.from('plain text, not gzip');
    const bomb = gzipSync(Buffer.alloc(16 * 1024 * 1024, 0x61));
    writeFileSync(join(user, 'bad.txt.gz'), notGzip);
    writeFileSync(join(user, 'bomb.txt.gz'), bomb);
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(user, 'manifest.json'), JSON.stringify({ packs: { bad: { sha256: sha(notGzip) }, bomb: { sha256: sha(bomb) } } }));
    const loaded = loadConsultVocabulary(english, user);
    expect(loaded.vocabulary).not.toBeNull();
    expect(loaded.status.filter((entry) => entry.origin === 'user').map((entry) => [entry.id, entry.state]).sort())
      .toEqual([['bad', 'unreadable'], ['bomb', 'too_large']]);
  });
  test('an empty or shapeless pack makes a malformed snapshot', () => {
    for (const pack of [null, {}, { question: 'q' }, { question: 'q', candidates: {}, coverage: {} }]) {
      expect(evaluateConsultRequest(['What is a deposit?'], consultWriterContextFromPack(pack as unknown as EvidencePack)).reasons)
        .toEqual(['writer_context_malformed']);
    }
  });
});
