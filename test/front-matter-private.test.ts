import { expect, test } from 'bun:test';
import {
  classifyItemTiers, FRONT_MATTER_PRIVATE_REASON, frontMatterMarksPrivate,
  type TierSniffer, type TierSnifferRequest,
} from '../src/workers/classification/tier-classifier.ts';

function spy() {
  const requests: TierSnifferRequest[] = [];
  const sniffer: TierSniffer = { id: 'fixture', judge(request) {
    requests.push(request);
    return { verdict: 'decided', tier: 'private', code: 'ordinary:0.99' };
  } };
  return { requests, sniffer };
}

const marked = [
  '---\nprivate: true\n---\nShopping list',
  '---\ntitle: Plans\naliases:\n  - plans\nprivate: true\nupdated: 2026-11-14\n---\n# Plans\nText',
  '﻿---\r\nPrivate: "yes"\r\n---\r\nText',
  "---\nprivate: 'true' # owner mark\n...\nText",
];

const unmarked = [
  'private: true\nno front matter here',
  '---\nprivate: false\n---\nText',
  '---\ntitle: Notes\n---\nprivate: true is in the body, not the front matter',
  '---\n\nprivate: true\n\nA rule opening the note, never closed as front matter',
  '---\n  private: true\n---\nnested, not a top-level key',
  'Text\n---\nprivate: true\n---',
];

test('a note whose own front matter says private: true settles Private by content rule, from any source', () => {
  for (const text of marked) {
    expect(frontMatterMarksPrivate(text)).toBe(true);
    for (const provider of ['local_files', 'dropbox']) {
      const { requests, sniffer } = spy();
      const result = classifyItemTiers({ signals: { title: 'Plans.md' }, text, provider, mimeType: 'text/plain' }, { sniffer });
      expect(result).toMatchObject({ contentTier: 'secure', contentPending: false, decidedBy: 'content_rule' });
      expect(result.reasons).toContain(FRONT_MATTER_PRIVATE_REASON);
      expect(requests.filter((request) => request.pass === 'content')).toHaveLength(0);
    }
  }
});

test('anything else is not the mark and goes to the judge as usual', () => {
  for (const text of unmarked) {
    expect(frontMatterMarksPrivate(text)).toBe(false);
    const { sniffer } = spy();
    const result = classifyItemTiers({ signals: { title: 'Plans.md' }, text: `${text}\nsome longer ordinary words`, provider: 'local_files', mimeType: 'text/plain' }, { sniffer });
    expect(result.reasons).not.toContain(FRONT_MATTER_PRIVATE_REASON);
  }
});

test('a secret in a marked note is still Secrets', () => {
  const text = '---\nprivate: true\n---\nAWS key AKIAIOSFODNN7EXAMPLE secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const result = classifyItemTiers({ signals: {}, text, provider: 'local_files', mimeType: 'text/plain' }, { sniffer: spy().sniffer });
  expect(result.contentTier).toBe('secrets');
});
