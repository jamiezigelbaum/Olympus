import { expect, test } from 'bun:test';
import {
  classifyItemTiers, classifyContentTier, itemHasNonTextContent, normalizedContentHash,
  tierSnifferInputHash, type TierSniffer, type TierSnifferRequest,
} from '../src/workers/classification/tier-classifier.ts';
import { CachedTierSniffer, SNIFFER_PROMPT_VERSION, snifferCacheModelId } from '../src/workers/classification/sniffer.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import type { RawItem } from '../src/core/contracts.ts';

const lane: SnifferLane = { kind: 'local', modelId: 'content-rule-fixture', profileId: 'content-rule-fixture',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'content-rule-fixture' } };
const subject = (id: string) => ({ provider: 'fixture', accountScope: 'test', providerItemId: id });
function spy() {
  const requests: TierSnifferRequest[] = [];
  const sniffer: TierSniffer = { id: 'fixture', judge(request) { requests.push(request); return { verdict: 'undecided', queued: true }; } };
  return { requests, sniffer };
}

for (const [text, rule] of [['', 'empty_text'], [' \n\t ', 'empty_text'], ['😀🙌🏽!!!', 'emoji_or_punctuation'],
  ['！？。、', 'emoji_or_punctuation'], ['🇵🇹', 'emoji_or_punctuation'], ['1️⃣😀2️⃣!!!', 'emoji_or_punctuation'], ['yes', 'short_text'], ['ok', 'short_text']] as const) {
  test(`settles own text ${JSON.stringify(text)} with ${rule}`, () => {
    const { requests, sniffer } = spy();
    const decision = classifyItemTiers({ signals: {}, text, holdUntilJudged: true }, { sniffer });
    expect(decision).toMatchObject({ contentTier: 'private', contentRead: true, contentPending: false, decidedBy: 'content_rule', state: 'current' });
    expect(decision.reasons).toContain(`content:rule:${rule}`);
    expect(requests).toHaveLength(0);
    const content = classifyContentTier({ text: text!, metadataTier: 'private', metadataForced: false, metadataFlagged: false }, { sniffer });
    expect(content.contentPending).toBe(false);
  });
}

for (const text of ['癌症', '糖尿病', '암', 'がん', 'ガン', 'ー', 'abcd', 'my diagnosis', '12345678901234567890']) {
  test(`still judges ${text}`, () => {
    const { requests, sniffer } = spy();
    expect(classifyItemTiers({ signals: {}, text }, { sniffer }).contentPending).toBe(true);
    expect(requests.filter(r => r.pass === 'content')).toHaveLength(1);
  });
}

test('names pass runs and its Private result floors a trivial content decision', () => {
  const requests: TierSnifferRequest[] = [];
  const decision = classifyItemTiers({ signals: { title: 'SSN 123-45-6789' }, text: 'ok' }, {
    sniffer: { id: 'fixture', judge(request) { requests.push(request); return { verdict: 'decided', tier: 'secure', code: 'identity:0.99' }; } },
  });
  expect(requests.map(r => r.pass)).toEqual(['metadata']);
  expect(decision.contentTier).toBe('secure');
});

test('owner rules, item floors and Secrets win first', () => {
  for (const strength of ['prior', 'force'] as const) {
    const decision = classifyItemTiers({ signals: { sender: 'person' }, text: 'ok' }, {
      rules: [{ id: 'owner', match: { kind: 'sender', value: 'person' }, tier: 'secure', strength }],
    });
    expect(decision.contentTier).toBe('secure');
  }
  expect(classifyItemTiers({ signals: { floor: { tier: 'secure', basis: 'provider:secret_chat' } }, text: '' }).contentTier).toBe('secure');
  expect(classifyItemTiers({ signals: { floor: { tier: 'secrets', basis: 'redacted' } }, text: '' }).contentTier).toBe('secrets');
  expect(classifyContentTier({ text: 'ok', metadataTier: 'secrets', metadataForced: false, metadataFlagged: false }).contentTier).toBe('secrets');
  const { requests, sniffer } = spy();
  const decision = classifyItemTiers({ signals: {}, text: `password=${'a'.repeat(24)}` }, { sniffer });
  expect(decision.contentTier).toBe('secrets');
  expect(requests).toHaveLength(0);
});

for (const extra of [{ mimeType: 'image/png' }, { mimeType: 'application/pdf' }, { hasNonTextContent: true }]) {
  test(`unread media is not empty text: ${JSON.stringify(extra)}`, () => {
    const decision = classifyItemTiers({ signals: {}, text: '', ...extra });
    expect(decision.contentPending).toBe(true);
    expect(decision.reasons.some(r => r.startsWith('content:rule:'))).toBe(false);
    const { sniffer, requests } = spy();
    classifyItemTiers({ signals: {}, text: 'ok', ...extra }, { sniffer });
    expect(requests.some(r => r.pass === 'content' && r.contentHash)).toBe(false);
  });
}

test('absent text means extraction is still owed; parent context prevents trivial settling', () => {
  expect(classifyItemTiers({ signals: {} }).contentPending).toBe(true);
  for (const text of ['', 'yes', '😀']) {
    const { sniffer, requests } = spy();
    expect(classifyItemTiers({ signals: {}, text, parentContext: 'sensitive question' }, { sniffer }).contentPending).toBe(true);
    expect(requests[0]?.contentHash).toBeUndefined();
  }
});

test('shared raw-item capability check excludes attachments, media, files, bytes and deferred extraction', () => {
  const raw: RawItem = { identity: { ...subject('raw'), family: 'chat', localItemId: 'raw' },
    mimeType: 'text/plain', content: { kind: 'text', text: 'ok' }, metadata: {}, fetchedAt: '2026-11-06T00:00:00Z' };
  expect(itemHasNonTextContent(raw)).toBe(false);
  for (const metadata of [{ attachments: ['photo'] }, { mediaType: 'photo' }, { attachmentCount: 1 }, { resources: [{}] }]) {
    expect(itemHasNonTextContent({ ...raw, metadata })).toBe(true);
  }
  expect(itemHasNonTextContent({ ...raw, identity: { ...raw.identity, family: 'file', providerFileId: 'file-id' } })).toBe(true);
  expect(itemHasNonTextContent({ ...raw, content: { kind: 'metadata_only' } })).toBe(true);
  expect(itemHasNonTextContent({ ...raw, deferredBytes: { available: true, locator: 'fixture' } })).toBe(true);
});

test('duplicate reuse requires a final model verdict, same judge/prompt/map; provenance names the rule', async () => {
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const text = 'Ordinary logistics for the weekend.';
  const hash = normalizedContentHash(text);
  const sniffer = new CachedTierSniffer(store, lane);
  const input = (id: string) => ({ signals: { title: id }, text, subject: subject(id) });
  try {
    const first = classifyItemTiers(input('first'), { sniffer });
    ledger.recordDecision(subject('first'), first);
    expect(classifyItemTiers(input('unjudged'), { sniffer }).contentPending).toBe(true);
    // A cached answer not yet final cannot settle a different item, even with identical names.
    const key = { materialHash: tierSnifferInputHash('content', { title: 'first' }, text),
      modelId: snifferCacheModelId(lane), promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' };
    store.putVerdict(key, { tier: 'personal', category: 'ordinary', confidence: 0.99, failSafe: false }, subject('first'));
    expect(classifyItemTiers({ ...input('same-names'), signals: { title: 'first' } }, { sniffer }).contentPending).toBe(true);
    const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane, model: { async complete() { throw new Error('cache should answer original'); } } });
    expect(report.calls).toBe(0);
    expect(ledger.getCurrent(subject('first'))?.contentPending).toBe(false);
    expect(store.getFinalModelContentVerdict({ ...key, contentHash: hash })).toBeDefined();
    const duplicate = classifyItemTiers({ ...input('duplicate'), text: `  ${text}\r\n` }, { sniffer });
    expect(duplicate.contentPending).toBe(false);
    expect(duplicate.reasons.some(r => r.includes('rule:duplicate_model'))).toBe(true);
    expect(classifyItemTiers(input('changed-judge'), { sniffer: new CachedTierSniffer(store, { ...lane, modelId: 'other' }) }).contentPending).toBe(true);
    expect(store.getFinalModelContentVerdict({ ...key, contentHash: hash, mapRevision: 'other' })).toBeUndefined();
    expect(store.getFinalModelContentVerdict({ ...key, contentHash: hash, promptVersion: 'other' })).toBeUndefined();
  } finally { ledger.close(); store.close(); }
});

test('fail-safe and rule-settled items never seed the model duplicate cache', () => {
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  try {
    const text = 'A plain duplicate body';
    const key = { materialHash: tierSnifferInputHash('content', {}, text), modelId: snifferCacheModelId(lane), promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' };
    store.putVerdict(key, { tier: 'private', category: 'other', confidence: 0, failSafe: true }, subject('failed'));
    store.markFinalModelContent(key, normalizedContentHash(text));
    const sniffer = new CachedTierSniffer(store, lane);
    expect(classifyItemTiers({ signals: {}, text, subject: subject('duplicate') }, { sniffer }).contentPending).toBe(true);
    classifyItemTiers({ signals: {}, text: 'ok' }, { sniffer });
    expect(store.getFinalModelContentVerdict({ ...key, contentHash: normalizedContentHash('ok') })).toBeUndefined();
  } finally { store.close(); }
});


test('production resolver publishes only settled model donors and reuses queued duplicates', async () => {
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const sniffer = new CachedTierSniffer(store, lane);
  let calls = 0;
  try {
    for (const id of ['one', 'two']) {
      const identity = subject(id);
      ledger.recordDecision(identity, classifyItemTiers({ signals: { title: id }, text: 'A confidential discussion without a keyword.', subject: identity }, { sniffer }));
    }
    const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane, concurrentCalls: 1,
      model: { async complete() { calls++; return { modelId: lane.modelId,
        text: JSON.stringify({ verdicts: [{ i: 1, tier: 'private', category: 'other', ownRecord: false, privateKind: 'none', confidence: 0.99 }] }) }; } } });
    expect(ledger.getCurrent(subject('two'))?.reasons.some(r => /content:sniffer:.*:other:0.99$/.test(r) && !r.includes('rule:'))).toBe(true);
    expect(calls).toBe(1);
    expect(report.cacheHits).toBe(1);
    for (const id of ['one', 'two']) expect(ledger.getCurrent(subject(id))).toMatchObject({ state: 'current', contentTier: 'secure', contentPending: false });
    expect(ledger.getCurrent(subject('one'))?.reasons.some(r => r.includes('rule:duplicate_model'))).toBe(true);
  } finally { ledger.close(); store.close(); }
});


test('held Secrets are checked before content shortcuts, including empty text', () => {
  const { sniffer, requests } = spy();
  for (const text of ['', 'ok', 'A duplicate eligible body']) {
    const decision = classifyItemTiers({ signals: {}, text, heldSecret: true }, { sniffer });
    expect(decision).toMatchObject({ contentTier: 'secrets', contentPending: false, state: 'current' });
    expect(decision.reasons).toContain('content:held_secret');
  }
  expect(requests).toHaveLength(0);
  expect(classifyContentTier({ text: '', metadataTier: 'private', metadataForced: false, metadataFlagged: false, heldSecret: true, mimeType: 'image/png' }).contentPending).toBe(false);
});

test('media arriving during a model call invalidates the old text-only question', async () => {
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const sniffer = new CachedTierSniffer(store, lane);
  const identity = subject('late-media');
  const input = { signals: {}, text: 'An ordinary caption for a picture', subject: identity };
  try {
    ledger.recordDecision(identity, classifyItemTiers(input, { sniffer }));
    const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane,
      model: { async complete() {
        ledger.recordDecision(identity, classifyItemTiers({ ...input, hasNonTextContent: true }, { sniffer }));
        return { modelId: lane.modelId, text: JSON.stringify({ verdicts: [{ i: 1, tier: 'personal', category: 'ordinary', ownRecord: false, privateKind: 'none', confidence: 0.99 }] }) };
      } } });
    expect(report.staleDropped).toBe(1);
    expect(ledger.getCurrent(identity)?.contentPending).toBe(true);
    expect(store.getFinalModelContentVerdict({ contentHash: normalizedContentHash(input.text), modelId: snifferCacheModelId(lane), promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' })).toBeUndefined();
  } finally { ledger.close(); store.close(); }
});

test('a model donor becomes reusable only after its routed move finishes', async () => {
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const sniffer = new CachedTierSniffer(store, lane);
  const identity = subject('moving-donor');
  const text = 'A confidential conversation about an ordinary subject.';
  const key = { contentHash: normalizedContentHash(text), modelId: snifferCacheModelId(lane), promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none' };
  const destination = [{ corpusId: 'fixture.names', trustDomain: 'internal' as const, layers: 'metadata' as const },
    { corpusId: 'fixture.content', trustDomain: 'secure_local' as const, layers: 'content' as const }];
  const model = { async complete() { return { modelId: lane.modelId, text: JSON.stringify({ verdicts: [
    { i: 1, tier: 'private', category: 'other', ownRecord: false, privateKind: 'none', confidence: 0.99 },
  ] }) }; } };
  try {
    ledger.recordRoutedPlacement(identity, classifyItemTiers({ signals: {}, text, subject: identity }, { sniffer }), {
      copies: [{ corpusId: 'fixture.initial', trustDomain: 'internal', layers: 'both' }], embedHold: false,
    });
    const target = { ledger, sniffer: store, placementFor: () => ({ copies: destination, embedHold: false }) };
    await runSnifferPass({ targets: [target], lane, model });
    expect(ledger.getCurrent(identity)?.state).toBe('moving');
    expect(store.getFinalModelContentVerdict(key)).toBeUndefined();
    await runSnifferPass({ targets: [target], lane, model });
    expect(store.questionFor(identity, 'content')).toBeDefined();
    ledger.stageMove(identity, { expectedGeneration: ledger.getCurrent(identity)!.generation,
      target: { metadataTier: 'private', contentTier: 'secure' }, destination, hideSource: true });
    ledger.completeMove(identity, { expectedGeneration: ledger.getCurrent(identity)!.generation, destination });
    await runSnifferPass({ targets: [target], lane, model });
    expect(store.getFinalModelContentVerdict(key)).toBeDefined();
    expect(store.questionFor(identity, 'content')).toBeUndefined();
  } finally { ledger.close(); store.close(); }
});
