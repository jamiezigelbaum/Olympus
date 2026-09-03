import { describe, expect, test } from 'bun:test';
import {
  ITEM_CLASSIFICATION_ENGINE_VERSION,
  classifyItemTier,
  classifyItemTierWithScorer,
  deriveClassificationPatternKey,
  type ClassifyItemTierInput,
  type ItemTierScorer,
} from '../src/workers/classification/index.ts';
import {
  USER_FACING_TIER_MAPPING,
  type SensitivityMap,
} from '../src/core/sensitivity-map.ts';

function item(overrides: Partial<ClassifyItemTierInput> = {}): ClassifyItemTierInput {
  return { text: '', ...overrides };
}

function map(category: {
  id: string;
  targetTierName: 'secure' | 'secrets';
  targetTrustTier: 'S4' | 'S5';
  keywords?: string[];
  senderPatterns?: string[];
  pathPatterns?: string[];
}): SensitivityMap {
  return {
    schemaVersion: 1,
    userFacingTiers: USER_FACING_TIER_MAPPING,
    categories: [{
      id: category.id,
      label: category.id,
      targetTierName: category.targetTierName,
      targetTrustTier: category.targetTrustTier,
      targetTrustDomain: 'secure_local',
      examples: ['example'],
      notes: 'must not appear in signals',
      match: {
        keywords: category.keywords ?? [],
        senderPatterns: category.senderPatterns ?? [],
        pathPatterns: category.pathPatterns ?? [],
      },
    }],
  };
}

describe('per-item tier classification engine', () => {
  test('exposes a dated engine version for stored classifications', () => {
    expect(ITEM_CLASSIFICATION_ENGINE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  describe('financial detectors (S4 floor)', () => {
    test('valid IBAN with spaces is sensitive', () => {
      const result = classifyItemTier(item({
        subject: 'Transfer details',
        sender: 'alex@friends.example',
        text: 'Here you go: DE89 3704 0044 0532 0130 00 — send it tomorrow.',
      }));
      expect(result.decidedBy).toBe('sensitive_detector');
      expect(result.tier).toBe('S4');
      expect(result.trustDomain).toBe('secure_local');
      expect(result.signals).toContain('financial:iban');
    });

    test('IBAN-shaped string with wrong check digits does NOT fire the IBAN detector', () => {
      const result = classifyItemTier(item({
        sender: 'alex@friends.example',
        text: 'Reference code GB82WEST12345698765431 for the shipment.',
      }));
      expect(result.signals).not.toContain('financial:iban');
      expect(result.decidedBy).toBe('default_secure');
    });

    test('Luhn-valid card numbers are sensitive, with and without separators', () => {
      for (const card of ['4111 1111 1111 1111', '4111-1111-1111-1111', '378282246310005']) {
        const result = classifyItemTier(item({ sender: 'a@b.example', text: `Card: ${card}` }));
        expect(result.decidedBy).toBe('sensitive_detector');
        expect(result.signals).toContain('financial:card_luhn');
      }
    });

    test('16-digit numbers that fail Luhn do not fire the card detector', () => {
      const result = classifyItemTier(item({
        sender: 'shop@store.example',
        text: 'Your order number is 1234 5678 9012 3456 and ships Monday.',
      }));
      expect(result.signals).not.toContain('financial:card_luhn');
      expect(result.decidedBy).toBe('clean_rules');
    });

    test('a 20-digit run never yields a 13-19 digit "card" window', () => {
      const result = classifyItemTier(item({
        sender: 'a@b.example',
        text: 'Tracking 41111111111111111111 confirmed.',
      }));
      expect(result.signals).not.toContain('financial:card_luhn');
    });

    test('financial vocabulary cluster fires; a single weak term does not', () => {
      const cluster = classifyItemTier(item({
        subject: 'Invoice #2231',
        sender: 'maria@accounting.example',
        text: 'Attached invoice. Payment due by Friday via wire transfer to the usual account.',
      }));
      expect(cluster.decidedBy).toBe('sensitive_detector');
      expect(cluster.signals.some((signal) => signal.startsWith('financial:vocabulary:'))).toBe(true);

      const single = classifyItemTier(item({
        sender: 'alex@friends.example',
        text: 'That invoice joke from last night still cracks me up.',
      }));
      expect(single.decidedBy).toBe('default_secure');
    });

    test('routing number with context is sensitive', () => {
      const result = classifyItemTier(item({
        sender: 'me@self.example',
        text: 'Routing number: 021000021 for the new setup.',
      }));
      expect(result.signals).toContain('financial:routing_number');
      expect(result.decidedBy).toBe('sensitive_detector');
    });
  });

  describe('health detectors (S4 floor)', () => {
    test('clinical vocabulary cluster is sensitive', () => {
      const result = classifyItemTier(item({
        subject: 'Follow-up',
        sender: 'ana@friends.example',
        text: 'The diagnosis was confirmed and the prescription changes the medication dosage.',
      }));
      expect(result.decidedBy).toBe('sensitive_detector');
      expect(result.tier).toBe('S4');
      expect(result.signals.some((signal) => signal.startsWith('health:vocabulary:'))).toBe(true);
    });

    test('clinic sender hint plus one health term is sensitive', () => {
      const result = classifyItemTier(item({
        sender: 'noreply@cityclinic.example',
        text: 'Your prescription is ready for pickup.',
      }));
      expect(result.decidedBy).toBe('sensitive_detector');
      expect(result.signals).toContain('health:origin_hint');
    });

    test('one health-ish word in a tech context stays default secure', () => {
      const result = classifyItemTier(item({
        sender: 'dev@team.example',
        text: 'My diagnosis of the deploy failure: the cache never warmed.',
      }));
      expect(result.decidedBy).toBe('default_secure');
    });
  });

  describe('credential/secret detectors (S5 floor, via shared content policy scan)', () => {
    test('AWS access key id is S5', () => {
      const result = classifyItemTier(item({
        sender: 'me@self.example',
        text: 'Old key AKIAIOSFODNN7EXAMPLE should be rotated.',
      }));
      expect(result.tier).toBe('S5');
      expect(result.trustDomain).toBe('secure_local');
      expect(result.decidedBy).toBe('sensitive_detector');
      expect(result.signals).toContain('secret:aws_access_key_id');
    });

    test('credential assignment is S5', () => {
      const result = classifyItemTier(item({
        text: 'api_key: sk_live_abcdef1234567890abcdef',
      }));
      expect(result.tier).toBe('S5');
      expect(result.signals.some((signal) => signal.startsWith('secret:'))).toBe(true);
    });

    test('a password-reset mention without an assignment is not a secret', () => {
      const result = classifyItemTier(item({
        sender: 'alex@friends.example',
        text: 'You can reset your password from the settings page.',
      }));
      expect(result.tier).not.toBe('S5');
      expect(result.decidedBy).toBe('default_secure');
    });
  });

  describe('identity document detectors (S4 floor)', () => {
    test('SSN pattern is sensitive; phone numbers are not', () => {
      const ssn = classifyItemTier(item({ text: 'Her SSN is 123-45-6789 for the form.' }));
      expect(ssn.signals).toContain('identity:ssn');
      expect(ssn.decidedBy).toBe('sensitive_detector');

      const phone = classifyItemTier(item({ sender: 'a@b.example', text: 'Call me at 415-555-2671 tonight.' }));
      expect(phone.signals).not.toContain('identity:ssn');
      expect(phone.decidedBy).toBe('default_secure');
    });

    test('passport number with qualifier is sensitive; the bare word is not', () => {
      const positive = classifyItemTier(item({ text: 'Passport number: AB1234567 expires in May.' }));
      expect(positive.signals).toContain('identity:passport_number');

      const negative = classifyItemTier(item({ sender: 'a@b.example', text: 'Bring your passport tomorrow.' }));
      expect(negative.signals).not.toContain('identity:passport_number');
      expect(negative.decidedBy).toBe('default_secure');
    });

    test('NIF with a valid check letter fires; an invalid letter does not', () => {
      const valid = classifyItemTier(item({ text: 'NIF 12345678Z confirmed.' }));
      expect(valid.signals).toContain('identity:nif');

      const invalid = classifyItemTier(item({ sender: 'a@b.example', text: 'Code 12345678A on the sticker.' }));
      expect(invalid.signals).not.toContain('identity:nif');
    });
  });

  describe('clean rules (downgrade to internal only on a positive signal)', () => {
    test('Gmail CATEGORY_UPDATES downgrades to internal S3', () => {
      const result = classifyItemTier(item({
        subject: 'Your weekly digest',
        sender: 'updates@service.example',
        labels: ['INBOX', 'CATEGORY_UPDATES'],
        text: 'Here is what happened this week across your projects.',
      }));
      expect(result).toMatchObject({ tier: 'S3', trustDomain: 'internal', decidedBy: 'clean_rules' });
      expect(result.signals).toContain('clean:gmail_category:CATEGORY_UPDATES');
    });

    test('newsletter/list senders downgrade to internal', () => {
      for (const sender of ['newsletter@stratechery.example', 'The Browser <noreply@substack.com>']) {
        const result = classifyItemTier(item({
          sender,
          text: 'This week in technology: ten links worth your time. Unsubscribe anytime.',
        }));
        expect(result.trustDomain).toBe('internal');
        expect(result.decidedBy).toBe('clean_rules');
      }
    });

    test('public-ish work paths and presentations downgrade to internal', () => {
      const path = classifyItemTier(item({
        path: '/2 Areas/Work/roadmap-notes.md',
        text: 'Q3 roadmap discussion points for the team offsite.',
      }));
      expect(path.trustDomain).toBe('internal');
      expect(path.signals.some((signal) => signal.startsWith('clean:public_path:'))).toBe(true);

      const deck = classifyItemTier(item({
        path: '/archive/conference/keynote-2026.pptx',
        text: 'Slide deck for the keynote.',
      }));
      expect(deck.trustDomain).toBe('internal');
      expect(deck.signals).toContain('clean:presentation_document');
    });

    test('short pleasantries downgrade to internal S2', () => {
      const result = classifyItemTier(item({
        sender: 'ana@friends.example',
        text: 'Sounds good — see you tomorrow! Thanks!',
      }));
      expect(result).toMatchObject({ tier: 'S2', trustDomain: 'internal', decidedBy: 'clean_rules' });
      expect(result.signals).toContain('clean:short_pleasantry');
    });

    test('long or number-heavy notes are not pleasantries', () => {
      const result = classifyItemTier(item({
        sender: 'ana@friends.example',
        text: 'Thanks! The door code is 81732 and the meter reading was 0042319 yesterday.',
      }));
      expect(result.decidedBy).toBe('default_secure');
    });

    test('routine scheduling, commerce, and work coordination downgrade to internal', () => {
      const scheduling = classifyItemTier(item({
        sender: 'alex@friends.example',
        subject: 'Rescheduled',
        text: 'The meeting invite moved to Tuesday. Same Zoom link and agenda.',
      }));
      expect(scheduling).toMatchObject({ tier: 'S3', trustDomain: 'internal', decidedBy: 'clean_rules' });
      expect(scheduling.signals).toContain('clean:scheduling_coordination');

      const commerce = classifyItemTier(item({
        sender: 'shop@example.com',
        subject: 'Order confirmation',
        text: 'Your order confirmation is ready. The package shipped with tracking number 123456789.',
      }));
      expect(commerce).toMatchObject({ tier: 'S3', trustDomain: 'internal', decidedBy: 'clean_rules' });
      expect(commerce.signals).toContain('clean:commerce_notice');

      const work = classifyItemTier(item({
        sender: 'teammate@work.example',
        subject: 'Project update',
        text: 'Project update: the milestone moved to Friday. Next steps are in the meeting recap.',
      }));
      expect(work).toMatchObject({ tier: 'S3', trustDomain: 'internal', decidedBy: 'clean_rules' });
      expect(work.signals).toContain('clean:work_coordination');
    });

    test('new clean signals never override hard financial detectors', () => {
      const result = classifyItemTier(item({
        sender: 'shop@example.com',
        subject: 'Receipt',
        text: 'Receipt attached. Card: 4111 1111 1111 1111. Tracking number 123456789.',
      }));
      expect(result).toMatchObject({ tier: 'S4', trustDomain: 'secure_local', decidedBy: 'sensitive_detector' });
      expect(result.signals).toContain('financial:card_luhn');
      expect(result.signals).not.toContain('clean:commerce_notice');
    });
  });

  describe('operator sensitivity map guidance (raise-only)', () => {
    test('map keyword hit raises a would-be internal item to secure_local', () => {
      const result = classifyItemTier(item({
        subject: 'Weekly digest',
        sender: 'newsletter@service.example',
        labels: ['CATEGORY_UPDATES'],
        text: 'Reminder: bring the therapy forms tomorrow.',
      }), {
        sensitivityMap: map({
          id: 'therapy',
          targetTierName: 'secure',
          targetTrustTier: 'S4',
          keywords: ['therapy'],
        }),
      });

      expect(result).toMatchObject({
        tier: 'S4',
        trustDomain: 'secure_local',
        decidedBy: 'sensitivity_map',
      });
      expect(result.signals).toEqual(['sensitivity_map:therapy']);
    });

    test('secrets category yields S5 and exposes only the category id signal', () => {
      const result = classifyItemTier(item({
        sender: 'keeper@example.com',
        text: 'This is routine scheduling about vault access.',
      }), {
        sensitivityMap: map({
          id: 'home-vault',
          targetTierName: 'secrets',
          targetTrustTier: 'S5',
          senderPatterns: ['keeper@example.com'],
        }),
      });

      expect(result).toMatchObject({
        tier: 'S5',
        trustDomain: 'secure_local',
        decidedBy: 'sensitivity_map',
      });
      expect(result.signals).toEqual(['sensitivity_map:home-vault']);
      expect(JSON.stringify(result)).not.toContain('routine scheduling');
      expect(JSON.stringify(result)).not.toContain('must not appear');
    });

    test('clean rules can never downgrade a map hit', () => {
      const result = classifyItemTier(item({
        path: '/2 Areas/Work/public-roadmap.md',
        text: 'Project update: therapy budget topic for the offsite.',
      }), {
        sensitivityMap: map({
          id: 'therapy',
          targetTierName: 'secure',
          targetTrustTier: 'S4',
          keywords: ['therapy'],
        }),
      });

      expect(result.decidedBy).toBe('sensitivity_map');
      expect(result.trustDomain).toBe('secure_local');
      expect(result.signals).not.toContain('clean:work_coordination');
    });
  });

  describe('default: ambiguity stays secure with a pending pattern key', () => {
    test('an ordinary personal email stays secure_local with sender-domain pattern key', () => {
      const result = classifyItemTier(item({
        subject: 'last night',
        sender: 'Alex <alex@gmail.com>',
        text: 'Hey, can we talk about what happened last night? I want to explain.',
      }));
      expect(result).toMatchObject({
        tier: 'S4',
        trustDomain: 'secure_local',
        decidedBy: 'default_secure',
        patternKey: 'sender:gmail.com',
      });
    });

    test('files aggregate by second-level folder; messages fall back to chat', () => {
      expect(deriveClassificationPatternKey({ path: '/Projects/Alpha/notes/draft.txt', text: '' }))
        .toBe('folder:/projects/alpha');
      expect(deriveClassificationPatternKey({ text: 'hello' })).toBe('chat');
    });
  });

  describe('the asymmetry property: sensitive ALWAYS beats clean', () => {
    test('a CATEGORY_UPDATES newsletter containing a valid card number is sensitive', () => {
      const result = classifyItemTier(item({
        subject: 'Receipt for your purchase',
        sender: 'newsletter@shop.example',
        labels: ['CATEGORY_UPDATES'],
        text: 'Thanks for subscribing! Charged to card 4111 1111 1111 1111.',
      }));
      expect(result.decidedBy).toBe('sensitive_detector');
      expect(result.trustDomain).toBe('secure_local');
      expect(result.tier).toBe('S4');
    });

    test('a pleasantry carrying a secret is S5', () => {
      const result = classifyItemTier(item({
        sender: 'ana@friends.example',
        text: 'Thanks! api_key = sk-abcdefghijklmnopqrstuv',
      }));
      expect(result.tier).toBe('S5');
      expect(result.decidedBy).toBe('sensitive_detector');
    });
  });

  describe('scorer seam (future local-LLM plug-in)', () => {
    const confidentScorer: ItemTierScorer = {
      id: 'fake-local-llm',
      async scoreClean() {
        return { confidentClean: true, signals: ['llm:clean'] };
      },
    };

    test('scorer may downgrade an otherwise default_secure item', async () => {
      const result = await classifyItemTierWithScorer(item({
        sender: 'alex@gmail.com',
        text: 'Reminder that the book club moved to Thursday.',
      }), confidentScorer);
      expect(result).toMatchObject({ tier: 'S3', trustDomain: 'internal', decidedBy: 'clean_rules' });
      expect(result.signals).toContain('scorer:fake-local-llm');
    });

    test('scorer can NEVER override a sensitive detector hit', async () => {
      const result = await classifyItemTierWithScorer(item({
        text: 'IBAN DE89370400440532013000 attached.',
      }), confidentScorer);
      expect(result.decidedBy).toBe('sensitive_detector');
      expect(result.trustDomain).toBe('secure_local');
    });

    test('a non-confident or failing scorer keeps the item secure', async () => {
      const shy: ItemTierScorer = { id: 'shy', async scoreClean() { return { confidentClean: false }; } };
      const broken: ItemTierScorer = { id: 'broken', async scoreClean(): Promise<never> { throw new Error('down'); } };
      const ambiguous = item({ sender: 'alex@gmail.com', text: 'About that thing we discussed.' });
      expect((await classifyItemTierWithScorer(ambiguous, shy)).decidedBy).toBe('default_secure');
      expect((await classifyItemTierWithScorer(ambiguous, broken)).decidedBy).toBe('default_secure');
    });

    test('the sync engine ignores async scorer verdicts (fails safe)', () => {
      const result = classifyItemTier(item({
        sender: 'alex@gmail.com',
        text: 'About that thing we discussed.',
      }), { scorer: confidentScorer });
      expect(result.decidedBy).toBe('default_secure');
    });
  });
});
