// Every read item is judged by the privacy-safe model before it may be
// Personal (owner ruling 2026-10-01, classifier 2026-10-01.p3).
//
// - A person's own lab report with none of the detector vocabulary (reference
//   ranges, mg/dL, Spanish) is held pending, never Personal at once, and the
//   model's Private verdict makes it Private.
// - General reading about a sensitive topic (program rules, a diet guide) is
//   Personal when the model says it is reference material.
// - The item's names (title, folder path) travel with the excerpt.
// - With no private model, behaviour is unchanged: unflagged read items are
//   Personal at once.
// - The prompt asks one generic question: is this a person's OWN private
//   information, or general/reference material on the topic?

import { describe, expect, test } from 'bun:test';
import {
  SNIFFER_CATEGORIES,
  SNIFFER_PROMPT_VERSION,
  SNIFFER_SYSTEM_PROMPT,
  buildSnifferBatchPrompt,
  snifferTierKey,
} from '../src/workers/classification/sniffer.ts';
import {
  CONTENT_READ_SNIFFER_FLAG,
  classifyContentTier,
  classifyItemTiers,
  TIER_CLASSIFIER_VERSION,
  type TierSniffer,
  type TierSnifferRequest,
  type TierSnifferVerdict,
} from '../src/workers/classification/tier-classifier.ts';

// A lab report as extracted: values, units and reference ranges, no detector
// vocabulary ("lab result", "blood test", "diagnosis", "patient" ...).
const LAB_REPORT = [
  'Laboratorio Central. Fecha de toma: 2026-06-29.',
  'Glucosa en ayunas 92 mg/dL (70 - 100). Colesterol total 212 mg/dL (< 200).',
  'HDL 48 mg/dL (> 40). Triglicéridos 160 mg/dL (< 150). TSH 2.1 uUI/mL (0.4 - 4.0).',
  'Specimen: serum. Result reviewed.',
].join('\n');
const LAB_NAMES = { title: '2026-06-29 blood work 1.pdf', path: '/2 Areas/Health/Labs/2026-06-29 blood work 1.pdf' };

const PROGRAM_RULES = [
  'The official program rules. For 30 days, eat real food: meat, seafood, eggs, vegetables and fruit.',
  'Do not consume added sugar, alcohol, grains or legumes. Do not step on the scale.',
  'Read labels carefully and plan your meals for the week ahead.',
].join('\n');
const PROGRAM_NAMES = { title: 'official-program-rules.pdf', path: '/3 Resources/Diet/official-program-rules.pdf' };

function answering(answer: TierSnifferVerdict, asked: TierSnifferRequest[] = []): TierSniffer {
  return { id: 'local:test', judge: (request) => { asked.push(request); return answer; } };
}

describe('every read item is judged by the private model before it may be Personal', () => {
  test('a lab report with no detector vocabulary is held pending, not Personal at once', () => {
    const asked: TierSnifferRequest[] = [];
    const decision = classifyItemTiers(
      { signals: LAB_NAMES, provider: 'fixture', text: LAB_REPORT },
      { sniffer: answering({ verdict: 'undecided' }, asked) },
    );
    expect(TIER_CLASSIFIER_VERSION).toBe('2026-10-01.p3');
    expect(decision).toMatchObject({ contentRead: true, contentPending: true, state: 'pending', engineVersion: TIER_CLASSIFIER_VERSION });
    expect(decision.reasons).not.toContain('content:no_raise');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.pass).toBe('content');
    expect(asked[0]!.flags).toEqual([CONTENT_READ_SNIFFER_FLAG]);
    // The folder path and title travel with the excerpt.
    expect(asked[0]!.material).toStartWith('Names: 2026-06-29 blood work 1.pdf | /2 Areas/Health/Labs/');
    expect(asked[0]!.material).toContain('Excerpt: Laboratorio Central.');
  });

  test('the model\'s Private verdict makes the lab report Private', () => {
    const decision = classifyItemTiers(
      { signals: LAB_NAMES, provider: 'fixture', text: LAB_REPORT },
      { sniffer: answering({ verdict: 'decided', tier: 'secure', code: 'health:0.95' }) },
    );
    expect(decision).toMatchObject({ contentTier: 'secure', decidedBy: 'sniffer', state: 'current', contentPending: false });
    expect(decision.reasons).toContain('content:sniffer:local:test:health:0.95');
  });

  test('general reading on a sensitive topic is Personal when the model calls it reference material', () => {
    // The model's own answer for program rules: personal, "reference".
    expect(snifferTierKey({ tier: 'personal', category: 'reference', confidence: 0.95 })).toBe('private');
    // A hard category still never resolves Personal, whatever tier the model pairs it with.
    expect(snifferTierKey({ tier: 'personal', category: 'health', confidence: 0.99 })).toBe('secure');
    const decision = classifyItemTiers(
      { signals: PROGRAM_NAMES, provider: 'fixture', text: PROGRAM_RULES },
      { sniffer: answering({ verdict: 'decided', tier: 'private', code: 'reference:0.95' }) },
    );
    expect(decision).toMatchObject({ contentTier: 'private', state: 'current', contentPending: false });
    expect(decision.reasons).toContain('content:sniffer:local:test:reference:0.95');
  });

  test('late text (the extraction factory) is judged with the item\'s path and title too', () => {
    const asked: TierSnifferRequest[] = [];
    const content = classifyContentTier(
      { text: LAB_REPORT, metadataTier: 'private', metadataForced: false, metadataFlagged: false, ...LAB_NAMES },
      { sniffer: answering({ verdict: 'undecided' }, asked) },
    );
    expect(content).toMatchObject({ contentTier: 'private', contentPending: true });
    expect(asked[0]!.material).toContain('/2 Areas/Health/Labs/');
    // An owner rule on the names settles them: the text is not asked about only because it was read.
    const owner: TierSnifferRequest[] = [];
    const ruled = classifyContentTier(
      { text: PROGRAM_RULES, metadataTier: 'private', metadataForced: false, metadataFlagged: false, metadataOwnerDecided: true },
      { sniffer: answering({ verdict: 'undecided' }, owner) },
    );
    expect(ruled).toMatchObject({ contentTier: 'private', contentPending: false });
    expect(owner).toHaveLength(0);
  });

  test('structured detections still decide at once, without asking', () => {
    const asked: TierSnifferRequest[] = [];
    const decision = classifyItemTiers(
      { signals: { title: 'notes.txt' }, provider: 'fixture', text: 'Please use account number: 12345678 for the transfer.' },
      { sniffer: answering({ verdict: 'undecided' }, asked) },
    );
    expect(decision).toMatchObject({ contentTier: 'secure', decidedBy: 'sensitive_detector', state: 'current' });
    expect(asked).toHaveLength(0);
  });

  test('with no private model, an unflagged read item is Personal at once (unchanged)', () => {
    const decision = classifyItemTiers({ signals: LAB_NAMES, provider: 'fixture', text: LAB_REPORT });
    expect(decision).toMatchObject({ contentTier: 'private', state: 'current', contentPending: false });
    expect(decision.reasons).toContain('content:no_raise');
  });
});

describe('the sniffer prompt asks one generic question', () => {
  test('a person\'s own information versus general or reference material, with names as signals', () => {
    expect(SNIFFER_SYSTEM_PROMPT).toContain('OWN private information');
    expect(SNIFFER_SYSTEM_PROMPT).toContain('general, reference or published material');
    expect(SNIFFER_SYSTEM_PROMPT).toContain('the names (title and folder path) count');
    expect(SNIFFER_CATEGORIES).toContain('reference');
    const prompt = buildSnifferBatchPrompt('content', [{ i: 1, material: 'Names: a.pdf\nExcerpt: text' }]);
    expect(prompt).toContain('its NAMES (title, folder path, sender) when known, then a short EXCERPT');
    expect(prompt).toContain(JSON.stringify({ i: 1, document: 'Names: a.pdf\nExcerpt: text' }));
    // Derived from the text: the change is a new version, approved before use.
    expect(SNIFFER_PROMPT_VERSION).toMatch(/^p-[0-9a-f]{12}$/);
  });
});
