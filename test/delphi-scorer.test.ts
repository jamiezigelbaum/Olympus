// DelphiItemTierScorer: decisive JSON verdict parsing, threshold modes,
// fail-safe behaviour on transport/parse failures, detector precedence, and
// the env policy knobs. All through a fake Delphi transport — no model.

import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DelphiClient, type DelphiTransport } from '../src/core/delphi.ts';
import {
  DelphiItemTierScorer,
  SCORER_CONFIDENCE_THRESHOLDS,
  classifyItemTierWithScorer,
  parseClassificationPolicyFromEnv,
  parseDelphiScorerVerdict,
  type ClassifyItemTierInput,
} from '../src/workers/classification/index.ts';

interface CapturedRequest {
  url: string;
  body: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    messages: Array<{ role: string; content: string }>;
  };
}

function fakeDelphi(respond: (request: CapturedRequest) => string | Error): {
  client: DelphiClient;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const transport: DelphiTransport = {
    async requestJson(url, init) {
      const captured: CapturedRequest = { url, body: JSON.parse(String(init.body)) };
      requests.push(captured);
      const result = respond(captured);
      if (result instanceof Error) throw result;
      return {
        model: 'mlx-community/fake-35b',
        choices: [{ message: { content: result } }],
      };
    },
  };
  return { client: new DelphiClient(defaultConfig(), transport), requests };
}

const AMBIGUOUS_INPUT: ClassifyItemTierInput = {
  subject: 'Quick note',
  sender: 'Pat <pat@orbit.example>',
  text: 'Circling back on the thing we discussed; tell me when you have a moment.',
};

const INTERNAL_VERDICT = '{"tier":"internal","category":"work","confidence":0.85}';

describe('verdict parsing (strict)', () => {
  test('accepts a strict single-object JSON verdict', () => {
    expect(parseDelphiScorerVerdict(INTERNAL_VERDICT)).toEqual({
      tier: 'internal',
      category: 'work',
      confidence: 0.85,
    });
  });

  test('accepts a code-fenced verdict (common local-model wrapper)', () => {
    expect(parseDelphiScorerVerdict('```json\n{"tier":"secure","category":"health","confidence":0.9}\n```')).toEqual({
      tier: 'secure',
      category: 'health',
      confidence: 0.9,
    });
  });

  test.each([
    ['prose', 'I believe this email is internal.'],
    ['prose around JSON', `The verdict is: ${INTERNAL_VERDICT}`],
    ['wrong tier enum', '{"tier":"public","category":"work","confidence":0.9}'],
    ['wrong category enum', '{"tier":"internal","category":"gossip","confidence":0.9}'],
    ['confidence above 1', '{"tier":"internal","category":"work","confidence":1.2}'],
    ['negative confidence', '{"tier":"internal","category":"work","confidence":-0.1}'],
    ['confidence as string', '{"tier":"internal","category":"work","confidence":"high"}'],
    ['array', '[{"tier":"internal","category":"work","confidence":0.9}]'],
    ['truncated JSON', '{"tier":"internal","category":"work","confi'],
    ['empty', ''],
  ])('rejects %s as no verdict at all', (_label, text) => {
    expect(parseDelphiScorerVerdict(text)).toBeUndefined();
  });
});

describe('threshold modes (tuneability)', () => {
  test('aggressiveness maps to the documented thresholds', () => {
    expect(SCORER_CONFIDENCE_THRESHOLDS).toEqual({ conservative: 0.9, balanced: 0.7, aggressive: 0.5 });
  });

  test.each([
    ['conservative', false],
    ['balanced', true],
    ['aggressive', true],
  ] as const)('a 0.85-confidence internal verdict under %s mode -> confidentClean %p', async (mode, expected) => {
    const { client } = fakeDelphi(() => INTERNAL_VERDICT);
    const scorer = new DelphiItemTierScorer(client, { aggressiveness: mode });
    const verdict = await scorer.scoreClean(AMBIGUOUS_INPUT);
    expect(verdict.confidentClean).toBe(expected);
    expect(verdict.signals).toContain('scorer_category:work');
    expect(verdict.signals).toContain(`scorer_mode:${mode}`);
  });

  test('an explicit confidenceThreshold override wins over the mode map', async () => {
    const { client } = fakeDelphi(() => INTERNAL_VERDICT);
    const scorer = new DelphiItemTierScorer(client, { aggressiveness: 'aggressive', confidenceThreshold: 0.95 });
    expect(scorer.confidenceThreshold).toBe(0.95);
    expect((await scorer.scoreClean(AMBIGUOUS_INPUT)).confidentClean).toBe(false);
  });

  test('a decisive SECURE verdict is never confidentClean but carries its signals', async () => {
    const { client } = fakeDelphi(() => '{"tier":"secure","category":"personal","confidence":0.95}');
    const scorer = new DelphiItemTierScorer(client, { aggressiveness: 'aggressive' });
    const verdict = await scorer.scoreClean(AMBIGUOUS_INPUT);
    expect(verdict.confidentClean).toBe(false);
    expect(verdict.signals).toContain('scorer_verdict:secure');
  });
});

describe('fail-safe behaviour', () => {
  test('transport failure -> no verdict -> the item stays default_secure', async () => {
    const { client } = fakeDelphi(() => new Error('lane unreachable'));
    const scorer = new DelphiItemTierScorer(client);
    expect(await scorer.score(AMBIGUOUS_INPUT)).toBeUndefined();
    expect((await scorer.scoreClean(AMBIGUOUS_INPUT)).confidentClean).toBe(false);

    const classification = await classifyItemTierWithScorer(AMBIGUOUS_INPUT, scorer);
    expect(classification.decidedBy).toBe('default_secure');
    expect(classification.trustDomain).toBe('secure_local');
  });

  test('parse failure -> no verdict -> the item stays default_secure', async () => {
    const { client } = fakeDelphi(() => 'this mail seems fine to me');
    const scorer = new DelphiItemTierScorer(client);
    const classification = await classifyItemTierWithScorer(AMBIGUOUS_INPUT, scorer);
    expect(classification.decidedBy).toBe('default_secure');
  });

  test('a confident internal verdict downgrades a default_secure item to S3/internal', async () => {
    const { client } = fakeDelphi(() => INTERNAL_VERDICT);
    const scorer = new DelphiItemTierScorer(client);
    const classification = await classifyItemTierWithScorer(AMBIGUOUS_INPUT, scorer);
    expect(classification).toMatchObject({ tier: 'S3', trustDomain: 'internal', decidedBy: 'clean_rules' });
    expect(classification.signals).toContain('scorer:delphi_item_tier_scorer');
    expect(classification.signals).toContain('scorer_verdict:internal');
  });

  test('sensitive detectors win BEFORE the scorer is ever consulted', async () => {
    const { client, requests } = fakeDelphi(() => INTERNAL_VERDICT);
    const scorer = new DelphiItemTierScorer(client, { aggressiveness: 'aggressive' });
    const classification = await classifyItemTierWithScorer({
      subject: 'forms',
      sender: 'someone@example.com',
      text: 'My SSN is 123-45-6789, please keep it on file.',
    }, scorer);
    expect(classification.decidedBy).toBe('sensitive_detector');
    expect(classification.trustDomain).toBe('secure_local');
    expect(requests).toHaveLength(0); // no model call at all
  });

  test('sensitive sender options on the async seam also win over the scorer', async () => {
    const { client, requests } = fakeDelphi(() => INTERNAL_VERDICT);
    const scorer = new DelphiItemTierScorer(client);
    const classification = await classifyItemTierWithScorer(AMBIGUOUS_INPUT, scorer, {
      sensitiveSenderPatterns: ['pat@orbit.example'],
    });
    expect(classification.decidedBy).toBe('sensitive_detector');
    expect(requests).toHaveLength(0);
  });
});

describe('prompt construction', () => {
  test('bounded subject/sender/excerpt, decisive instruction, fast-lane defaults', async () => {
    const { client, requests } = fakeDelphi(() => INTERNAL_VERDICT);
    const scorer = new DelphiItemTierScorer(client);
    await scorer.score({
      subject: 's'.repeat(2_000),
      sender: 'someone-with-a-long-name@example.com',
      text: 'x'.repeat(50_000),
    });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toContain('/chat/completions');
    expect(request.body.temperature).toBe(0);
    expect(request.body.max_tokens).toBe(120);

    const system = request.body.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('BE DECISIVE');
    expect(system.content).toContain('"tier":"internal"|"secure"');

    const user = request.body.messages[1]!;
    expect(user.content).toContain('Subject: ');
    expect(user.content).toContain('Sender: someone-with-a-long-name@example.com');
    // Bounded: 300-char subject + 2000-char excerpt + framing, never the
    // full 52K input.
    expect(user.content.length).toBeLessThan(2_500);
  });
});

describe('classification policy from env', () => {
  test('parses mode, sensitive senders, and the enable flag', () => {
    expect(parseClassificationPolicyFromEnv({
      OLYMPUS_CLASSIFY_SCORER_MODE: 'aggressive',
      OLYMPUS_EMAIL_SENSITIVE_SENDERS: ' anne swart , billing@bank.example ,,',
      OLYMPUS_CLASSIFY_SCORER_ENABLED: '1',
    })).toEqual({
      scorerEnabled: true,
      scorerMode: 'aggressive',
      sensitiveSenders: ['anne swart', 'billing@bank.example'],
    });
  });

  test('defaults: scorer disabled, no mode, no sensitive senders', () => {
    expect(parseClassificationPolicyFromEnv({})).toEqual({
      scorerEnabled: false,
      sensitiveSenders: [],
    });
  });

  test('unknown mode values are dropped rather than guessed', () => {
    const policy = parseClassificationPolicyFromEnv({
      OLYMPUS_CLASSIFY_SCORER_MODE: 'yolo',
      OLYMPUS_CLASSIFY_SCORER_ENABLED: 'false',
    });
    expect(policy.scorerMode).toBeUndefined();
    expect(policy.scorerEnabled).toBe(false);
  });
});
