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
  USER_FACING_TIER_MAPPING,
  parseSensitivityMap,
  type SensitivityMap,
} from '../src/core/sensitivity-map.ts';
import {
  classifyItemTiers,
  type OwnerTierRule,
  type TierClassificationOptions,
  type TierSniffer,
} from '../src/workers/classification/tier-classifier.ts';

const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';
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

function mapV2(categories: Array<{ id: string; tier: 'public' | 'private' | 'secure' | 'secrets'; keywords?: string[]; pathPatterns?: string[] }>): SensitivityMap {
  return parseSensitivityMap({
    schemaVersion: 2,
    userFacingTiers: USER_FACING_TIER_MAPPING,
    categories: categories.map((category) => ({
      id: category.id,
      label: category.id,
      targetTierName: category.tier,
      targetTrustTier: USER_FACING_TIER_MAPPING[category.tier].targetTrustTier,
      targetTrustDomain: USER_FACING_TIER_MAPPING[category.tier].targetTrustDomain,
      examples: ['example'],
      match: {
        keywords: category.keywords ?? [],
        senderPatterns: [],
        pathPatterns: category.pathPatterns ?? [],
      },
    })),
  });
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

  test('an owner rule or a map category can make an item Public', () => {
    expect(classify({ path: '/work/published/talk.pdf' }, BENIGN, {
      rules: [rule({ tier: 'public', strength: 'prior' })],
    }).metadataTier).toBe('public');
    expect(classify({ path: '/blog/drafts/post.md' }, BENIGN, {
      sensitivityMap: mapV2([{ id: 'blog', tier: 'public', pathPatterns: ['/blog/'] }]),
    }).metadataTier).toBe('public');
  });
});

describe('raises beat lowers', () => {
  test('a raising map category beats public evidence', () => {
    const decision = classify({ title: 'Therapy notes', sharing: 'public_link' }, BENIGN, {
      sensitivityMap: mapV2([{ id: 'therapy', tier: 'secure', keywords: ['therapy'] }]),
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

  test('when a raising and a lowering map category both match, the raise wins', () => {
    const decision = classify({ path: '/blog/medical/scan.txt' }, BENIGN, {
      sensitivityMap: mapV2([
        { id: 'blog', tier: 'public', pathPatterns: ['/blog/'] },
        { id: 'medical', tier: 'secure', pathPatterns: ['/medical/'] },
      ]),
    });
    expect(decision.metadataTier).toBe('secure');
  });

  test('among lowering signals the most sensitive target wins', () => {
    const decision = classify({ path: '/family/post.md', sharing: 'public_link' }, BENIGN, {
      sensitivityMap: mapV2([{ id: 'family', tier: 'private', pathPatterns: ['/family/'] }]),
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

  test('a secrets-target map category raises to Secrets', () => {
    const decision = classify({ title: 'vault export' }, BENIGN, {
      sensitivityMap: mapV2([{ id: 'vault', tier: 'secrets', keywords: ['vault export'] }]),
    });
    expect(decision.contentTier).toBe('secrets');
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

  test('a lowering map category on the text is ignored', () => {
    const decision = classify({ title: 'Account' }, 'our public roadmap blog', {
      sensitivityMap: mapV2([{ id: 'roadmap', tier: 'public', keywords: ['public roadmap'] }]),
    });
    expect(decision.metadataTier).toBe('private');
    expect(decision.contentTier).toBe('private');
  });

  test('a raising map category on the text raises the content only', () => {
    const decision = classify({ title: 'Weekly' }, 'about my therapy session', {
      sensitivityMap: mapV2([{ id: 'therapy', tier: 'secure', keywords: ['therapy session'] }]),
    });
    expect(decision.metadataTier).toBe('private');
    expect(decision.contentTier).toBe('secure');
    expect(decision.reasons).toContain('content:sensitivity_map:therapy');
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

  test('a decided sniffer verdict raises; an owner map match means the sniffer is not asked', () => {
    const sniffer: TierSniffer = { id: 'fake', judge: () => ({ verdict: 'decided', tier: 'secure', code: 'health:0.9' }) };
    const decided = classify({ title: 'therapy invoices' }, BENIGN, { sniffer });
    expect(decided.metadataTier).toBe('secure');
    expect(decided.state).toBe('current');

    let asked = 0;
    const spy: TierSniffer = { id: 'spy', judge: () => { asked += 1; return { verdict: 'undecided' }; } };
    const mapped = classify({ title: 'therapy invoices', path: '/household/therapy invoices.pdf' }, BENIGN, {
      sniffer: spy,
      sensitivityMap: mapV2([{ id: 'household', tier: 'private', pathPatterns: ['/household/'] }]),
    });
    expect(mapped.metadataPending).toBe(false);
    expect(mapped.state).toBe('current');
    expect(asked).toBe(0);
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

describe('sensitivity map versions', () => {
  test('a v1 map still loads and still raises', () => {
    const v1 = parseSensitivityMap({
      schemaVersion: 1,
      userFacingTiers: USER_FACING_TIER_MAPPING,
      categories: [{
        id: 'therapy',
        label: 'Therapy',
        targetTierName: 'secure',
        targetTrustTier: 'S4',
        targetTrustDomain: 'secure_local',
        examples: ['therapy'],
        match: { keywords: ['therapy'], senderPatterns: [], pathPatterns: [] },
      }],
    });
    expect(v1.schemaVersion).toBe(1);
    expect(classify({ title: 'therapy' }, BENIGN, { sensitivityMap: v1 }).metadataTier).toBe('secure');
  });

  test('the map revision is recorded with every decision', () => {
    const map = mapV2([{ id: 'therapy', tier: 'secure', keywords: ['therapy'] }]);
    expect(classify({ title: 'x' }, BENIGN).mapRevision).toBe('none');
    expect(classify({ title: 'x' }, BENIGN, { sensitivityMap: map }).mapRevision).toMatch(/^v2:[a-f0-9]{16}$/);
  });
});
