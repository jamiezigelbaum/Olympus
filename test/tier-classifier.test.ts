// The shared four-tier classifier (design:
// docs/design/per-item-four-tier-classification.md, section 2.2).
//
// Pins the precedence the owner approved: raises beat lowers; Secrets beat
// every rule; a per-item override beats Secrets; prior versus force; Public
// only on positive evidence; metadata defaults to Personal; content only
// raises; reasons are content-free.

import { describe, expect, test } from 'bun:test';
import type { SourceClassificationSignals } from '../src/core/contracts.ts';
import {
  SNIFFER_EXCERPT_MAX_CHARS,
  TIER_MAP_REVISION,
  classifyItemTiers,
  type OwnerTierRule,
  type TierClassificationOptions,
  type TierSniffer,
  type TierSnifferRequest,
  type TierSnifferVerdict,
} from '../src/workers/classification/tier-classifier.ts';

const AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const BENIGN = 'Notes from the weekly planning conversation about the garden.';
const HEALTH = 'The lab results confirm the diagnosis; the patient starts treatment.';

function classify(
  signals: SourceClassificationSignals,
  text: string | undefined,
  options: TierClassificationOptions = {},
  provider = 'fixture',
) {
  return classifyItemTiers({ signals, provider, ...(text !== undefined ? { text } : {}) }, options);
}

function rule(overrides: Partial<OwnerTierRule> & Pick<OwnerTierRule, 'tier' | 'strength'>): OwnerTierRule {
  return {
    id: 'rule-1',
    match: { kind: 'pathPrefix', value: '/work/published' },
    ...overrides,
  };
}

describe('defaults and Public evidence', () => {
  test('metadata defaults to Personal, and benign content stays there', () => {
    const decision = classify({ title: 'Garden plan' }, BENIGN);
    expect(decision.metadataTier).toBe('private');
    expect(decision.contentTier).toBe('private');
    expect(decision.decidedBy).toBe('default');
    expect(decision.state).toBe('current');
    expect(decision.reasons).toContain('metadata:default:personal');
  });

  test('absence of sensitive signals is never Public', () => {
    for (const sharing of [undefined, 'unknown', 'shared', 'private'] as const) {
      const decision = classify({ title: 'Quarterly recap', ...(sharing ? { sharing } : {}) }, BENIGN);
      expect(decision.metadataTier).toBe('private');
      expect(decision.contentTier).toBe('private');
    }
  });

  test('a public link or a published item is positive evidence for Public', () => {
    for (const sharing of ['public_link', 'published'] as const) {
      const decision = classify({ title: 'Launch post', sharing }, BENIGN);
      expect(decision.metadataTier).toBe('public');
      expect(decision.contentTier).toBe('public');
      expect(decision.reasons).toContain(`metadata:evidence:${sharing}`);
    }
  });

  test('an owner rule can make an item Public', () => {
    expect(classify({ path: '/work/published/talk.pdf' }, BENIGN, {
      rules: [rule({ tier: 'public', strength: 'prior' })],
    }).metadataTier).toBe('public');
  });
});

describe('raises beat lowers', () => {
  test('an owner always-Private rule beats public evidence', () => {
    const decision = classify({ title: 'Therapy notes', path: '/therapy/notes.txt', sharing: 'public_link' }, BENIGN, {
      rules: [rule({ id: 'therapy', match: { kind: 'pathPrefix', value: '/therapy' }, tier: 'secure', strength: 'prior' })],
    });
    expect(decision.metadataTier).toBe('secure');
    expect(decision.reasons).not.toContain('metadata:evidence:public_link');
  });

  test('a provider floor beats public evidence', () => {
    const decision = classify({
      title: 'Chat',
      sharing: 'published',
      floor: { tier: 'secure', basis: 'provider:secret_chat' },
    }, BENIGN);
    expect(decision.metadataTier).toBe('secure');
    expect(decision.reasons).toContain('metadata:floor:provider:secret_chat');
  });

  test('when a raising and a lowering owner rule both match, the raise wins', () => {
    const decision = classify({ path: '/blog/medical/scan.txt' }, BENIGN, {
      rules: [
        rule({ id: 'blog', match: { kind: 'pathPrefix', value: '/blog' }, tier: 'public', strength: 'prior' }),
        rule({ id: 'medical', match: { kind: 'pathPrefix', value: '/blog/medical' }, tier: 'secure', strength: 'prior' }),
      ],
    });
    expect(decision.metadataTier).toBe('secure');
  });

  test('among lowering signals the most sensitive target wins', () => {
    const decision = classify({ path: '/family/post.md', sharing: 'public_link' }, BENIGN, {
      rules: [rule({ id: 'family', match: { kind: 'pathPrefix', value: '/family' }, tier: 'private', strength: 'prior' })],
    });
    expect(decision.metadataTier).toBe('private');
  });

  test('a sensitive detector on the text raises a Public item', () => {
    const decision = classify({ title: 'Update', sharing: 'public_link' }, HEALTH);
    expect(decision.metadataTier).toBe('public');
    expect(decision.contentTier).toBe('secure');
    expect(decision.decidedBy).toBe('sensitive_detector');
  });
});

describe('Secrets', () => {
  test('a secret in the title makes the whole item Secrets and outranks a force rule', () => {
    const decision = classify({ title: `key ${AWS_KEY}`, path: '/work/published/key.txt' }, BENIGN, {
      rules: [rule({ tier: 'public', strength: 'force' })],
    });
    expect(decision.metadataTier).toBe('secrets');
    expect(decision.contentTier).toBe('secrets');
    expect(decision.reasons).toEqual(['metadata:secret:aws_access_key_id']);
  });

  test('a secret in the text makes the content Secrets even under a force rule', () => {
    const decision = classify({ path: '/work/published/env.txt' }, `aws ${AWS_KEY}`, {
      rules: [rule({ tier: 'public', strength: 'force' })],
    });
    expect(decision.metadataTier).toBe('public');
    expect(decision.contentTier).toBe('secrets');
    expect(decision.decidedBy).toBe('secret_detector');
  });

  test('the sniffer is never asked about a secret-bearing item', () => {
    let asked = 0;
    const sniffer: TierSniffer = { id: 'spy', judge: () => { asked += 1; return { verdict: 'undecided' }; } };
    classify({ title: `medical ${AWS_KEY}` }, HEALTH, { sniffer });
    classify({ title: 'medical record' }, `token ${AWS_KEY}`, { sniffer });
    // The second item's names are flagged, so pass 1 asks once; pass 2 finds
    // the secret before any excerpt question.
    expect(asked).toBe(1);
  });

  test('a "do not distribute" or "highly confidential" stamp is not a secret', () => {
    // Calibration 2026-10-05: handouts and readings stamped this way were made
    // Secrets (hidden everywhere, vectors deleted). A stamp is not a credential.
    for (const text of ['Integration handout. Do not distribute.', 'HIGHLY CONFIDENTIAL reading notes', 'Tier S5 is the top tier in this design.']) {
      const decision = classify({ title: 'notes.pdf' }, text);
      expect(decision.contentTier).not.toBe('secrets');
      expect(decision.reasons.some((reason) => reason.includes('secret'))).toBe(false);
    }
  });
});

describe('per-item owner override', () => {
  test('a tier override is final, even over Secrets', () => {
    const decision = classify({ title: `key ${AWS_KEY}` }, `aws ${AWS_KEY}`, {
      override: { kind: 'tier', tier: 'private' },
    });
    expect(decision.metadataTier).toBe('private');
    expect(decision.contentTier).toBe('private');
    expect(decision.decidedBy).toBe('override');
  });

  test('"not a secret" sends the item back through normal classification', () => {
    const plain = classify({ title: 'Launch notes' }, `sample ${AWS_KEY} in docs`, {
      override: { kind: 'not_secret' },
    });
    expect(plain.contentTier).toBe('private');
    expect(plain.reasons).toContain('override:item:not_secret');

    const stillSensitive = classify({ title: 'Clinic' }, `${HEALTH} ${AWS_KEY}`, {
      override: { kind: 'not_secret' },
    });
    expect(stillSensitive.contentTier).toBe('secure');
  });
});

describe('prior versus force', () => {
  test('a prior sets the resting tier and item-level raises still apply', () => {
    const decision = classify({ path: '/work/published/notes.txt' }, HEALTH, {
      rules: [rule({ tier: 'public', strength: 'prior' })],
    });
    expect(decision.metadataTier).toBe('public');
    expect(decision.contentTier).toBe('secure');
  });

  test('a force rule fixes the tier against sensitive detectors', () => {
    const decision = classify({ path: '/work/published/notes.txt' }, HEALTH, {
      rules: [rule({ tier: 'public', strength: 'force' })],
    });
    expect(decision.metadataTier).toBe('public');
    expect(decision.contentTier).toBe('public');
  });

  test('no automatic signal lowers a configured prior', () => {
    const decision = classify({
      title: 'Chat',
      sharing: 'public_link',
      prior: { tier: 'secure', strength: 'prior', basis: 'source_config:trust_domain:secure_local' },
    }, BENIGN);
    expect(decision.metadataTier).toBe('secure');
    expect(decision.contentTier).toBe('secure');
  });

  test('an owner prior rule outranks a source prior; force outranks prior among rules', () => {
    const signals: SourceClassificationSignals = {
      path: '/work/published/a.txt',
      prior: { tier: 'secure', strength: 'prior', basis: 'source_config:trust_domain:secure_local' },
    };
    expect(classify(signals, BENIGN, { rules: [rule({ tier: 'private', strength: 'prior' })] }).metadataTier)
      .toBe('private');
    expect(classify(signals, BENIGN, {
      rules: [rule({ id: 'p', tier: 'secure', strength: 'prior' }), rule({ id: 'f', tier: 'public', strength: 'force' })],
    }).metadataTier).toBe('public');
  });

  test('owner rules match labels, senders, folder keys and chats, and honour a named source', () => {
    expect(classify({ labels: ['Finance'] }, BENIGN, {
      rules: [rule({ match: { kind: 'label', value: 'finance' }, tier: 'secure', strength: 'prior' })],
    }).metadataTier).toBe('secure');
    expect(classify({ sender: 'Dr Who <dr@clinic.example>' }, BENIGN, {
      rules: [rule({ match: { kind: 'sender', value: 'clinic.example' }, tier: 'secure', strength: 'prior' })],
    }).metadataTier).toBe('secure');
    expect(classify({ folderKeys: ['chat-42'] }, BENIGN, {
      rules: [rule({ match: { kind: 'chat', value: 'chat-42' }, tier: 'secure', strength: 'prior' })],
    }).metadataTier).toBe('secure');
    expect(classify({ labels: ['Finance'] }, BENIGN, {
      rules: [rule({ source: 'other', match: { kind: 'label', value: 'finance' }, tier: 'secure', strength: 'prior' })],
    }).metadataTier).toBe('private');
  });
});

describe('content only raises', () => {
  test('content starts at the metadata tier and benign text never lowers it', () => {
    const decision = classify({ title: 'x', floor: { tier: 'secure', basis: 'provider:fact' } }, BENIGN);
    expect(decision.contentTier).toBe('secure');
  });

  test('an unread item keeps its metadata tier and says so', () => {
    const decision = classify({ title: 'Report' }, undefined);
    expect(decision.contentTier).toBe(decision.metadataTier);
    expect(decision.contentRead).toBe(false);
    expect(decision.reasons).toContain('content:unread');
  });
});

describe('sniffer seam', () => {
  test('owner example: "biopsy results" names are Personal and pending; the content is judged on its own', () => {
    const decision = classify({ title: 'biopsy results' }, 'the results show cancer');
    expect(decision.metadataTier).toBe('private');
    expect(decision.state).toBe('pending');
    expect(decision.reasons).toContain('metadata:possibly_private:names:health');
    expect(decision.reasons).toContain('metadata:sniffer:undecided:undecided');

    const withRecord = classify({ title: 'biopsy results' }, HEALTH);
    expect(withRecord.metadataTier).toBe('private');
    expect(withRecord.contentTier).toBe('secure');
  });

  test('a decided sniffer verdict raises', () => {
    const sniffer: TierSniffer = { id: 'fake', judge: () => ({ verdict: 'decided', tier: 'secure', code: 'health:0.9' }) };
    const decided = classify({ title: 'therapy invoices' }, BENIGN, { sniffer });
    expect(decided.metadataTier).toBe('secure');
    expect(decided.state).toBe('current');
  });

  test('unflagged names are never pending', () => {
    expect(classify({ title: 'Garden plan' }, BENIGN).state).toBe('current');
  });
});

describe('reasons are content-free', () => {
  test('no title, path, sender or text fragment appears in any reason', () => {
    const decision = classify({
      title: 'zebracorn medical invoice',
      path: '/Private/zebracorn/tax return.pdf',
      sender: 'zebracorn@example.com',
    }, `${HEALTH} zebracorn IBAN GB82WEST12345698765432`);
    const joined = decision.reasons.join('\n');
    for (const fragment of ['zebracorn', 'GB82', 'diagnosis', 'tax return', 'example.com', 'Private']) {
      expect(joined).not.toContain(fragment);
    }
    expect(decision.reasons).toContain('content:detector:financial:iban');
    expect(decision.reasons).toContain('content:detector:health:vocabulary');
  });
});

describe('the retired sensitivity map', () => {
  test('every decision records the fixed map revision', () => {
    expect(TIER_MAP_REVISION).toBe('none');
    expect(classify({ title: 'x' }, BENIGN).mapRevision).toBe('none');
  });
});

describe('vocabulary-only detector hits are judged by the private model (owner ruling 2026-10-01)', () => {
  // A book chapter: ordinary prose that happens to say "treatment" and
  // "symptoms" well past the opening. Words alone are not a private item.
  const FILLER = 'The integral approach maps quadrants and levels of development across many fields of human inquiry, from art and ethics to ecology. '
    .repeat(12);
  const BOOK = `${FILLER}In medicine, a purely physical treatment of symptoms ignores the interior quadrants of meaning and culture. ${FILLER}`;
  const BOOK_NAMES = { title: 'Introduction to the Integral Approach.pdf', path: '/Books/Introduction to the Integral Approach.pdf' };

  function answering(answer: TierSnifferVerdict, asked: TierSnifferRequest[]): TierSniffer {
    return { id: 'local:test', judge: (request) => { asked.push(request); return answer; } };
  }

  test('a book that mentions treatment and symptoms is asked about, and is Personal when the model says so', () => {
    const asked: TierSnifferRequest[] = [];
    const decision = classify(BOOK_NAMES, BOOK, {
      sniffer: answering({ verdict: 'decided', tier: 'private', code: 'other:0.95' }, asked),
    });
    expect(decision).toMatchObject({ metadataTier: 'private', contentTier: 'private', state: 'current', contentPending: false });
    expect(decision.decidedBy).not.toBe('sensitive_detector');
    expect(decision.reasons.some((reason) => reason.startsWith('content:detector:'))).toBe(false);
    expect(decision.reasons).toContain('content:sniffer:local:test:other:0.95');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.pass).toBe('content');
    expect(asked[0]!.flags).toContain('content:borderline:health');
    // The model reads the passage the detector matched, not only the opening, and still only an excerpt.
    expect(asked[0]!.material).toContain('physical treatment of symptoms');
    // The names travel with the excerpt (p3); the excerpt itself stays bounded.
    expect(asked[0]!.material).toStartWith('Names: Introduction to the Integral Approach.pdf');
    expect(asked[0]!.material!.split('\nExcerpt: ')[1]!.length).toBeLessThanOrEqual(SNIFFER_EXCERPT_MAX_CHARS);
  });

  test('real health content the model calls health stays Private', () => {
    const decision = classify(BOOK_NAMES, BOOK, {
      sniffer: answering({ verdict: 'decided', tier: 'secure', code: 'health:0.97' }, []),
    });
    expect(decision).toMatchObject({ contentTier: 'secure', decidedBy: 'sniffer', state: 'current' });
  });

  test('until the model answers, the item is pending (held Private)', () => {
    const decision = classify(BOOK_NAMES, BOOK, { sniffer: answering({ verdict: 'undecided' }, []) });
    expect(decision).toMatchObject({ state: 'pending', contentPending: true });
    expect(decision.reasons).toContain('content:borderline:health');
    expect(decision.reasons).toContain('content:sniffer:local:test:undecided');
  });

  test('with no private model to ask, vocabulary still makes the item Private', () => {
    const decision = classify(BOOK_NAMES, BOOK);
    expect(decision).toMatchObject({ contentTier: 'secure', decidedBy: 'sensitive_detector' });
    expect(decision.reasons).toContain('content:detector:health:vocabulary');
  });

  test('financial vocabulary is judged the same way', () => {
    const essay = 'The essay compares salary norms and tax policy across several countries over a century.';
    const asked: TierSnifferRequest[] = [];
    const personal = classify({ title: 'essay.md' }, essay, {
      sniffer: answering({ verdict: 'decided', tier: 'private', code: 'work:0.93' }, asked),
    });
    expect(personal).toMatchObject({ contentTier: 'private', state: 'current' });
    expect(asked[0]!.flags).toContain('content:borderline:financial');
    expect(classify({ title: 'essay.md' }, essay)).toMatchObject({ contentTier: 'secure', decidedBy: 'sensitive_detector' });
  });

  test('structured identifiers stay Private at once, and the model is never asked', () => {
    for (const [text, reason] of [
      ['Applicant SSN 123-45-6789 on file.', 'content:detector:identity:ssn'],
      ['Card 4111 1111 1111 1111 expires soon.', 'content:detector:financial:card_luhn'],
      [`${BOOK} Routing number 021000021.`, 'content:detector:financial:routing_number'],
    ] as const) {
      const asked: TierSnifferRequest[] = [];
      const decision = classify({ title: 'note.txt' }, text, {
        sniffer: answering({ verdict: 'decided', tier: 'private', code: 'other:0.99' }, asked),
      });
      expect(decision).toMatchObject({ contentTier: 'secure', decidedBy: 'sensitive_detector', state: 'current' });
      expect(decision.reasons).toContain(reason);
      expect(asked).toHaveLength(0);
    }
  });

  test('an owner Private rule still decides without asking', () => {
    const asked: TierSnifferRequest[] = [];
    const decision = classify(BOOK_NAMES, BOOK, {
      rules: [rule({ match: { kind: 'pathPrefix', value: '/books' }, tier: 'secure', strength: 'prior' })],
      sniffer: answering({ verdict: 'decided', tier: 'private', code: 'other:0.95' }, asked),
    });
    expect(decision).toMatchObject({ metadataTier: 'secure', contentTier: 'secure', decidedBy: 'owner_rule' });
    expect(asked).toHaveLength(0);
  });
});
