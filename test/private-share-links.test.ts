import { expect, test } from 'bun:test';
import {
  classifyContentTier, classifyItemTiers, contentDigestReason, contentNamesReason, isBareShareLink, TIER_CLASSIFIER_VERSION,
  type TierSniffer, type TierSnifferRequest,
} from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { decideItemTiers } from '../src/workers/connector-store/tier-placement.ts';
import type { RawItem } from '../src/core/contracts.ts';

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

test('relisting preserves an eligible final p8 content verdict for an unchanged bare link', () => {
  const item: RawItem = {
    identity: { provider: 'fixture', accountScope: 'test', providerItemId: 'link', localItemId: 'link', family: 'file' },
    mimeType: 'text/plain', content: { kind: 'text', text: share }, metadata: { textComplete: true },
    fetchedAt: '2026-11-06T00:00:00Z',
  };
  for (const contentTier of ['private', 'secure'] as const) {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    try {
      // A final pre-rule p8 judgment, with receipts for these exact bytes and names.
      ledger.recordDecision(item.identity, {
        ...classifyItemTiers({ signals: {}, text: share }), contentTier, decidedBy: 'sniffer',
        reasons: ['metadata:default:personal', contentDigestReason(share), contentNamesReason({}),
          `content:sniffer:fixture:${contentTier === 'private' ? 'ordinary' : 'medical'}:0.99`],
      });
      const { sniffer, requests } = spy();
      const replay = decideItemTiers({ classificationSignals: () => ({}) }, item, share, { sniffer }, ledger);
      expect(replay).toMatchObject({ contentTier, contentPending: false, state: 'current' });
      expect(replay.reasons).not.toContain('content:rule:private_share_link');
      expect(replay.reasons).toContain(`content:sniffer:fixture:${contentTier === 'private' ? 'ordinary' : 'medical'}:0.99`);
      expect(requests).toHaveLength(0);
      // Changed bytes have no eligible verdict, so the link rule now applies.
      expect(decideItemTiers({ classificationSignals: () => ({}) }, item, `${share}&v=2`, { sniffer }, ledger))
        .toMatchObject({ contentTier: 'secure', decidedBy: 'content_rule' });
      expect(requests).toHaveLength(0);
    } finally { ledger.close(); }
  }
});

test('identifiable Google publishing URLs and Notion sites remain eligible for content judgment', () => {
  for (const text of [
    'https://docs.google.com/document/d/e/2PACX-example/pub',
    'https://docs.google.com/spreadsheets/d/e/2PACX-example/pubhtml',
    'https://docs.google.com/presentation/d/e/2PACX-example/pub',
    'https://workspace.notion.site/Public-guide-0123456789abcdef0123456789abcdef',
    'https://workspace.notion.site/0123456789abcdef0123456789abcdef',
  ]) {
    expect(isBareShareLink(text)).toBe(false);
    const { sniffer, requests } = spy();
    expect(classifyItemTiers({ signals: {}, text }, { sniffer }).contentTier).toBe('private');
    expect(requests.map(r => r.pass)).toEqual(['content']);
  }
});

test('current Notion app page links settle Private with bounded page paths', () => {
  for (const path of ['/p/Document-0123456789abcdef0123456789abcdef',
    '/0123456789abcdef0123456789abcdef', '/p/01234567-89ab-cdef-0123-456789abcdef/']) {
    const text = `https://app.notion.com${path}`;
    expect(isBareShareLink(text)).toBe(true);
    const { sniffer, requests } = spy();
    expect(classifyItemTiers({ signals: {}, text }, { sniffer }))
      .toMatchObject({ contentTier: 'secure', decidedBy: 'content_rule', contentPending: false });
    expect(requests).toHaveLength(0);
  }
  for (const text of ['https://app.notion.com/product',
    'https://app.notion.com/help/0123456789abcdef0123456789abcdef',
    'https://app.notion.com/p/Document-0123456789abcdef0123456789abcdef/extra',
    'https://app.notion.com/p/Document-0123456789abcdef0123456789abcdef-extra',
    'https://app.notion.com.evil.example/p/Document-0123456789abcdef0123456789abcdef']) {
    expect(isBareShareLink(text)).toBe(false);
  }
});

test('link boundaries preserve adjacent meaningful text and public URLs for the judge', () => {
  for (const text of [`[Document](${share})Approved`, `[Document](${share})Rejected`,
    `${share},https://www.bbc.com/news/articles/example`, `${share},Approved`]) {
    expect(isBareShareLink(text)).toBe(false);
    const { sniffer, requests } = spy();
    expect(classifyItemTiers({ signals: {}, text }, { sniffer }).contentTier).toBe('private');
    expect(requests.map(r => r.pass)).toEqual(['content']);
    expect(requests[0]!.material).toContain(text);
  }
  expect(isBareShareLink(`${share},${shareLinks[6]}`)).toBe(true);
});
