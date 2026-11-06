import { expect, test } from 'bun:test';
import {
  classifyContentTier, classifyItemTiers, isBareShareLink, TIER_CLASSIFIER_VERSION,
  type TierSniffer, type TierSnifferRequest,
} from '../src/workers/classification/tier-classifier.ts';

const share = 'https://drive.google.com/file/d/unknown-document/view?usp=sharing';
const shareLinks = [
  share,
  'https://drive.google.com/open?id=unknown-document',
  'https://drive.google.com/drive/u/0/folders/unknown-folder',
  'https://docs.google.com/document/d/unknown-document/edit',
  'https://docs.google.com/spreadsheets/d/unknown-sheet/edit',
  'https://docs.google.com/presentation/d/unknown-deck/edit',
  'https://www.dropbox.com/s/opaque/document.pdf?dl=0',
  'https://www.dropbox.com/scl/fi/opaque/document.pdf?rlkey=example&dl=0',
  'https://www.dropbox.com/scl/fo/opaque/folder?dl=0',
  'https://db.tt/example',
  'https://www.icloud.com/iclouddrive/example#Document',
  'https://www.icloud.com/pages/example#Document',
  'https://1drv.ms/w/s!example',
  'https://onedrive.live.com/?id=example&cid=example',
  'https://example.sharepoint.com/:w:/s/team/example',
  'https://example.sharepoint.com/sites/team/_layouts/15/Doc.aspx?sourcedoc=example',
  'https://www.notion.so/Document-0123456789abcdef0123456789abcdef',
  'https://workspace.notion.site/0123456789abcdef0123456789abcdef',
  'https://app.box.com/s/example',
  'https://example.box.com/file/123456',
];

function spy() {
  const requests: TierSnifferRequest[] = [];
  // A Personal answer must not clear a share link; other text should reach it.
  const sniffer: TierSniffer = { id: 'fixture', judge(request) {
    requests.push(request);
    return { verdict: 'decided', tier: 'private', code: 'ordinary:0.99' };
  } };
  return { requests, sniffer };
}

test('unknown document/storage share links settle Private without asking the judge', () => {
  for (const text of shareLinks) {
    expect(isBareShareLink(text)).toBe(true);
    for (const provider of ['message-fixture', 'other-fixture']) {
      const { requests, sniffer } = spy();
      const result = classifyItemTiers({ signals: {}, text, provider }, { sniffer });
      expect(result).toMatchObject({ metadataTier: 'private', contentTier: 'secure',
        contentPending: false, state: 'current', decidedBy: 'content_rule' });
      expect(result.reasons).toContain('content:rule:private_share_link');
      expect(requests).toHaveLength(0);
      expect(result.engineVersion).toBe('2026-10-29.p8');
    }
  }
  expect(TIER_CLASSIFIER_VERSION).toBe('2026-10-29.p8');
});

test('short neutral framing, Markdown and multiple share links are still bare', () => {
  for (const text of [`Here is the link: ${share}`, `FYI <${share}>`, `[Document](${share})`, `${share}\n${shareLinks[6]}`]) {
    expect(isBareShareLink(text)).toBe(true);
  }
});

test('meaningful text, public URLs and provider marketing pages still go to the judge', () => {
  for (const text of [
    `The proposal sets our launch date for April. ${share}`,
    `I have cancer ${share}`, // Short meaningful text is not a neutral wrapper.
    `Approved ${share}`, `No ${share}`,
    'https://www.bbc.com/news/articles/example',
    'https://www.youtube.com/watch?v=example',
    'https://x.com/example/status/123',
    'https://www.dropbox.com/features',
    'https://www.notion.so/product',
    'https://drive.google.com.evil.example/file/d/example/view',
    `https://www.bbc.com/news/articles/example ${share}`,
  ]) {
    expect(isBareShareLink(text)).toBe(false);
    const { requests, sniffer } = spy();
    const result = classifyItemTiers({ signals: {}, text }, { sniffer });
    expect(result.reasons).not.toContain('content:rule:private_share_link');
    expect(requests.map(r => r.pass)).toEqual(['content']);
  }
});

test('Secrets screening precedes the link rule and does not expose text to the judge', () => {
  const { requests, sniffer } = spy();
  for (const text of [`${share}\npassword=${'a'.repeat(24)}`, 'https://reader:synthetic-password@drive.google.com/file/d/example/view']) {
    const result = classifyItemTiers({ signals: {}, text }, { sniffer });
    expect(result.contentTier).toBe('secrets');
    expect(result.decidedBy).toBe('secret_detector');
    expect(result.reasons).not.toContain('content:rule:private_share_link');
  }
  expect(requests).toHaveLength(0);
});

test('owner overrides and force rules win; names and item floors remain independent', () => {
  expect(classifyItemTiers({ signals: {}, text: share }, { override: { kind: 'tier', tier: 'private' } }))
    .toMatchObject({ contentTier: 'private', decidedBy: 'override' });
  expect(classifyItemTiers({ signals: { sender: 'owner@example.test' }, text: share }, {
    rules: [{ id: 'force', match: { kind: 'sender', value: 'owner@example.test' }, tier: 'private', strength: 'force' }],
  })).toMatchObject({ contentTier: 'private', decidedBy: 'owner_rule' });
  expect(classifyItemTiers({ signals: { floor: { tier: 'secrets', basis: 'fixture' } }, text: share }).contentTier).toBe('secrets');
  const { sniffer, requests } = spy();
  const result = classifyItemTiers({ signals: { title: 'SSN 123-45-6789' }, text: share }, { sniffer });
  expect(result.contentTier).toBe('secure');
  expect(requests.map(r => r.pass)).toEqual(['metadata']);
});

test('delayed content uses the same rule, including archive holds and no model', () => {
  const result = classifyContentTier({ text: share, metadataTier: 'private', metadataForced: false,
    metadataFlagged: false, holdUntilJudged: true });
  expect(result).toMatchObject({ contentTier: 'secure', contentPending: false, decidedBy: 'content_rule' });
  expect(result.reasons).toContain('content:rule:private_share_link');
});
